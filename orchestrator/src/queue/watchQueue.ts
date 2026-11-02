import { Queue, Worker, type Job } from "bullmq";
import { createRedisConnection } from "../lib/redis.js";
import { Sentry } from "../lib/sentry.js";
import { listActiveWatchRuns, listRunsWithPendingHits, processWatchRun, runDailyDigest } from "../lib/watch.js";
import { WATCH_PRIORITY, tickPlan, type WatchKind } from "../lib/watchCore.js";

/**
 * E7 상시 수색 큐 (22 문서 §6.5, 헌법 2조 — HTTP 는 설정만, 처리는 전부 여기).
 *   match-delta (우선): tick(활성 의뢰 건마다 delta·scan 잡 생성) · delta(정규화 결과가 바뀐 후보 + 수확) · digest(하루 1회 요약)
 *   match-scan  (후순위): scan(scan_cursor 부터 SCAN_BATCH 명)
 * 모든 잡 priority 10 (즉시 매칭 1~2 보다 뒤). 의뢰 건별 dedup id 로 같은 건이 큐에 겹치지 않는다.
 * 만료·마감 건은 tick 대상에서 빠지고, 이미 큐에 있던 잡도 실행 시 다시 확인해 건너뛴다 (watchCore.isWatchActive).
 */
export const WATCH_DELTA_QUEUE = "match-delta";
export const WATCH_SCAN_QUEUE = "match-scan";
const TICK_CRON = process.env.WATCH_TICK_CRON || "20 * * * *"; // 매시 20분
const DIGEST_CRON = process.env.WATCH_DIGEST_CRON || "0 8 * * *"; // 매일 08:00 (서버 시간)
const DRY_RUN = process.env.WATCH_DRY_RUN === "1";

export type WatchJobData = { kind: "tick" } | { kind: "digest" } | { kind: WatchKind; runId: string };

const connections: ReturnType<typeof createRedisConnection>[] = [];
function connection() {
  const c = createRedisConnection();
  connections.push(c);
  return c;
}
const closers: (() => Promise<void>)[] = [];
let deltaQueue: Queue<WatchJobData> | null = null;
let scanQueue: Queue<WatchJobData> | null = null;

const jobOpts = { attempts: 2, backoff: { type: "exponential" as const, delay: 60_000 }, removeOnComplete: { age: 86400, count: 500 }, removeOnFail: { age: 7 * 86400 } };

export function getWatchQueues() {
  deltaQueue ??= new Queue(WATCH_DELTA_QUEUE, { connection: connection(), defaultJobOptions: jobOpts });
  scanQueue ??= new Queue(WATCH_SCAN_QUEUE, { connection: connection(), defaultJobOptions: jobOpts });
  return { deltaQueue, scanQueue };
}

export async function closeWatchQueues(): Promise<void> {
  await deltaQueue?.close();
  await scanQueue?.close();
  deltaQueue = scanQueue = null;
  for (const close of closers.splice(0)) await close();
  for (const c of connections.splice(0)) c.disconnect();
}

export async function enqueueWatchRun(runId: string, kind: WatchKind): Promise<void> {
  const { deltaQueue: dq, scanQueue: sq } = getWatchQueues();
  const q = kind === "delta" ? dq : sq;
  await q.add(kind, { kind, runId }, { priority: WATCH_PRIORITY, deduplication: { id: `watch_${kind}_${runId}` } });
}

async function processWatchJob(job: Job<WatchJobData>) {
  const d = job.data;
  if (d.kind === "tick") {
    const { applied, runs } = await listActiveWatchRuns();
    if (!applied) return { kind: "tick", applied: false, runs: 0 };
    for (const t of tickPlan(runs, await listRunsWithPendingHits())) await enqueueWatchRun(t.runId, t.kind);
    return { kind: "tick", applied: true, runs: runs.length };
  }
  if (d.kind === "digest") {
    const { applied, digests } = await runDailyDigest();
    return { kind: "digest", applied, digests: digests.length };
  }
  return processWatchRun(d.runId, d.kind, { dryRun: DRY_RUN });
}

/** worker 역할: 큐 2개 워커 (각 concurrency 1 — 비용은 일일 상한이 막고, 처리량은 fit-analysis 워커가 결정) */
export function startWatchWorkers() {
  const workers = [WATCH_DELTA_QUEUE, WATCH_SCAN_QUEUE].map((name) => {
    const w = new Worker<WatchJobData>(name, processWatchJob, { connection: connection(), concurrency: 1 });
    w.on("completed", (job, result) => console.log(`[${name}] job ${job.id} completed ${JSON.stringify(result).slice(0, 200)}`));
    w.on("failed", (job, err) => {
      console.error(`[${name}] job ${job?.id} failed (${job?.data.kind}): ${err.message.slice(0, 160)}`);
      if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) Sentry.captureMessage(`${name} failed: ${job.data.kind}`, { level: "error", tags: { worker: name, jobId: job.id } });
    });
    closers.push(() => w.close());
    return w;
  });
  return workers;
}

/** api 역할에서 1회 (upsert 라 중복 안전) */
export async function startWatchSchedulers(): Promise<void> {
  const { deltaQueue: dq } = getWatchQueues();
  await dq.upsertJobScheduler("watch-tick", { pattern: TICK_CRON }, { name: "tick", data: { kind: "tick" }, opts: { priority: WATCH_PRIORITY } });
  await dq.upsertJobScheduler("watch-digest", { pattern: DIGEST_CRON }, { name: "digest", data: { kind: "digest" }, opts: { priority: WATCH_PRIORITY } });
}

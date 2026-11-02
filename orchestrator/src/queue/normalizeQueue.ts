import { Queue, Worker, type Job } from "bullmq";
import { callMcpTool } from "../mcp/client.js";
import { normalizeCandidateProfile, remapAllCandidates, type NormResult, type RemapSummary } from "../lib/candidateNorm.js";
import { createRedisConnection, redis } from "../lib/redis.js";
import { enqueueRecommend } from "./recommendQueue.js";
import { Sentry } from "../lib/sentry.js";

/**
 * 후보 정규화 큐 (22 문서 E2, 헌법 2조). 잡 2종:
 *   normalize  후보 1명 변경 감지 + 정규화. 디바운스: 같은 후보 잡이 지연 상태면 내용을 교체하고 지연을 연장 → 마지막 1번만 처리.
 *              하루 상한(NORMALIZE_DAILY_MAX)은 LLM 정규화 횟수에만 걸고, 넘으면 다음 날로 미룬다 (force 는 상한 무시).
 *   sweep      전체 후보를 normalize 로 넣는다 (매일 1회 + 관리자 수동). profiles 에 updated_at 이 없어 이벤트 대신 쓰는 안전망
 *              — 대부분 1단계(해시)에서 멈추므로 LLM 비용은 바뀐 사람에게만 든다.
 *   remap      사전이 바뀐 뒤 저장된 기술(+ SQL 027 사전 밖 기술 상세)을 코드로 다시 매핑 (LLM 0회). 바뀐 사람만 추천 재계산.
 */
export const NORMALIZE_QUEUE = "candidate-normalize";
const DEBOUNCE_MS = Number(process.env.NORMALIZE_DEBOUNCE_MS || 10 * 60 * 1000);
const DAILY_MAX = Number(process.env.NORMALIZE_DAILY_MAX || 1);
const SWEEP_CRON = process.env.NORMALIZE_SWEEP_CRON || "0 4 * * *"; // 매일 04:00 (서버 시간)

export type NormalizeJobData =
  | { kind: "normalize"; candidateId: string; force?: boolean }
  | { kind: "sweep"; force?: boolean }
  | { kind: "remap"; dryRun?: boolean };
export type NormalizeJobResult = NormResult | { kind: "sweep"; enqueued: number } | ({ kind: "remap" } & RemapSummary);

let queue: Queue<NormalizeJobData, NormalizeJobResult> | null = null;
const connections: ReturnType<typeof createRedisConnection>[] = [];
function connection() {
  const c = createRedisConnection();
  connections.push(c);
  return c;
}
const closers: (() => Promise<void>)[] = [];

export function getNormalizeQueue(): Queue<NormalizeJobData, NormalizeJobResult> {
  queue ??= new Queue(NORMALIZE_QUEUE, {
    connection: connection(),
    defaultJobOptions: { attempts: 3, backoff: { type: "exponential", delay: 20_000 }, removeOnComplete: { age: 86400, count: 1000 }, removeOnFail: { age: 7 * 86400 } },
  });
  return queue;
}

export async function closeNormalizeQueue(): Promise<void> {
  await queue?.close();
  queue = null;
  for (const close of closers.splice(0)) await close();
  for (const c of connections.splice(0)) c.disconnect();
}

/** 후보 1명 정규화 예약. delayMs=0 이면 바로 (sweep·수동), 기본은 디바운스. */
export async function enqueueNormalize(candidateId: string, opts: { delayMs?: number; force?: boolean; dedupSuffix?: string } = {}): Promise<void> {
  const delay = opts.delayMs ?? DEBOUNCE_MS;
  await getNormalizeQueue().add(
    "normalize",
    { kind: "normalize", candidateId, ...(opts.force && { force: true }) },
    {
      delay,
      // BullMQ 디바운스 모드: 지연 중인 같은 id 잡은 데이터 교체 + 지연 연장. 실행 중이면 이번 요청은 버려지므로 ttl 을 지연과 같게 둔다.
      deduplication: { id: `norm_${candidateId}${opts.dedupSuffix ?? ""}`, ttl: Math.max(delay, 1), extend: true, replace: true },
    }
  );
}

export async function enqueueSweep(force = false): Promise<string> {
  const job = await getNormalizeQueue().add("sweep", { kind: "sweep", ...(force && { force: true }) }, { deduplication: { id: "norm_sweep" } });
  return job.id!;
}

/** F1 사전 재매핑 예약 (동시에 하나만) */
export async function enqueueRemap(dryRun = false): Promise<string> {
  const job = await getNormalizeQueue().add("remap", { kind: "remap", ...(dryRun && { dryRun: true }) }, { deduplication: { id: "norm_remap" }, attempts: 1 });
  return job.id!;
}

function dayKey(candidateId: string): string {
  return `norm:daily:${new Date().toISOString().slice(0, 10)}:${candidateId}`;
}

function msUntilTomorrow(): number {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 5));
  return next.getTime() - now.getTime();
}

async function processNormalizeJob(job: Job<NormalizeJobData>): Promise<NormalizeJobResult> {
  const data = job.data;
  if (data.kind === "sweep") {
    const rows = await callMcpTool<{ id: string }[]>("search_candidates", {});
    for (const r of rows) await enqueueNormalize(r.id, { delayMs: 0, force: data.force });
    return { kind: "sweep", enqueued: rows.length };
  }
  if (data.kind === "remap") {
    const summary = await remapAllCandidates({ dryRun: data.dryRun });
    if (!data.dryRun) for (const id of summary.changedIds) await enqueueRecommend(id);
    return { kind: "remap", ...summary, changedIds: summary.changedIds.slice(0, 50) };
  }

  // 하루 상한은 LLM 단계에만 (재시도는 다시 세지 않는다). 해시·의미 확인은 상한 없이 매번 한다.
  const allowLlm = async () => {
    if (data.force) return true;
    const key = dayKey(data.candidateId);
    if (job.attemptsMade > 0) return Number(await redis.get(key)) <= DAILY_MAX;
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, 2 * 86400);
    return count <= DAILY_MAX;
  };
  const result = await normalizeCandidateProfile(data.candidateId, { force: data.force, allowLlm });
  if (result.outcome === "deferred") {
    // 실행 중인 이 잡이 기본 dedup id 를 쥐고 있으므로 별도 id 로 미룬다
    await enqueueNormalize(data.candidateId, { delayMs: msUntilTomorrow(), dedupSuffix: "_deferred" });
  }
  // 정규화 결과(기술·경력)가 바뀐 사람만 공고 추천을 다시 계산한다
  if (result.outcome === "created" || result.outcome === "changed") await enqueueRecommend(data.candidateId);
  return result;
}

export function startNormalizeWorker() {
  const worker = new Worker<NormalizeJobData, NormalizeJobResult>(NORMALIZE_QUEUE, processNormalizeJob, {
    connection: connection(),
    concurrency: Number(process.env.NORMALIZE_WORKER_CONCURRENCY || 1), // LLM RPM 은 mcp-server GEMINI_RPM 이 제한
  });
  worker.on("completed", (job, result) => {
    const detail = "outcome" in result ? result.outcome : "enqueued" in result ? `enqueued=${result.enqueued}` : `remap scanned=${result.scanned} changed=${result.changed}${result.applied ? "" : " (027 미적용)"}`;
    console.log(`[${worker.name}] job ${job.id} completed (${job.data.kind} ${detail})`);
  });
  worker.on("failed", (job, err) => {
    console.error(`[${worker.name}] job ${job?.id} failed (${job?.data.kind}): ${err.message.slice(0, 160)}`);
    if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
      Sentry.captureMessage(`candidate-normalize failed: ${job.data.kind}`, { level: "error", tags: { worker: worker.name, jobId: job.id } });
    }
  });
  closers.push(() => worker.close());
  return worker;
}

/** api 역할에서 1회 등록 (upsert 라 여러 번 불려도 하나). */
export async function startNormalizeSweepScheduler(): Promise<void> {
  await getNormalizeQueue().upsertJobScheduler("norm-sweep-daily", { pattern: SWEEP_CRON }, { name: "sweep", data: { kind: "sweep" } });
}

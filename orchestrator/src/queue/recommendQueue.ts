import { Queue, Worker, type Job } from "bullmq";
import { computeRecommendations } from "../lib/jobRecommend.js";
import { db } from "../lib/db.js";
import { createRedisConnection } from "../lib/redis.js";
import { Sentry } from "../lib/sentry.js";

/**
 * 구직자 공고 추천 큐 (SQL 022·023, 헌법 2조 — 계산은 요청 밖에서). LLM 0회라 가볍지만 공고 수천 건을 읽으므로 잡으로 돌린다.
 * 잡 2종:
 *   recommend  사용자 1명. 이벤트(희망 조건 저장·추천 제외·정규화 변경)나 첫 조회 때 넣는다. 입력이 그대로면 inputs_hash 로 건너뛴다.
 *   sweep      야간 1회. 최근 RECOMMEND_ACTIVE_DAYS 일 안에 추천을 본 사용자만 recommend 로 넣는다 (새 공고 반영).
 * 같은 사용자 잡은 RECOMMEND_DEDUP_MS 동안 1개로 합친다.
 */
export const RECOMMEND_QUEUE = "job-recommend";
const DEDUP_MS = Number(process.env.RECOMMEND_DEDUP_MS || 5 * 60 * 1000);
const SWEEP_CRON = process.env.RECOMMEND_SWEEP_CRON || "0 5 * * *"; // 매일 05:00 (정규화 sweep 04:00 뒤)
const ACTIVE_DAYS = Number(process.env.RECOMMEND_ACTIVE_DAYS || 14);

export type RecommendJobData = { kind?: "recommend"; userId: string; force?: boolean } | { kind: "sweep" };

let queue: Queue<RecommendJobData> | null = null;
const connections: ReturnType<typeof createRedisConnection>[] = [];
function connection() {
  const c = createRedisConnection();
  connections.push(c);
  return c;
}
let worker: Worker<RecommendJobData> | null = null;

export function getRecommendQueue(): Queue<RecommendJobData> {
  queue ??= new Queue(RECOMMEND_QUEUE, {
    connection: connection(),
    defaultJobOptions: { attempts: 2, backoff: { type: "exponential", delay: 10_000 }, removeOnComplete: { age: 3600, count: 500 }, removeOnFail: { age: 86400 } },
  });
  return queue;
}

/** force 는 디바운스를 새로 건다 (희망 조건 저장 직후 등) */
export async function enqueueRecommend(userId: string, force = false): Promise<string | undefined> {
  const job = await getRecommendQueue().add(
    "recommend",
    { kind: "recommend", userId, ...(force && { force: true }) },
    { deduplication: { id: `rec_${userId}${force ? "_f" : ""}`, ttl: force ? 30_000 : DEDUP_MS } }
  );
  return job.id;
}

async function sweepActive(): Promise<{ enqueued: number }> {
  const since = new Date(Date.now() - ACTIVE_DAYS * 86400000).toISOString();
  let { data, error } = await db.from("job_recommendation_runs").select("user_id").gte("viewed_at", since);
  if (error?.message.includes("viewed_at")) {
    // SQL 023 적용 전: 활동 기준 없이 계산 이력이 있는 사용자 전부 (inputs_hash 가 바뀐 사람만 실제 계산)
    console.warn("[recommend] viewed_at 없음 (SQL 023 미적용) — 계산 이력 있는 사용자 전부로 sweep");
    ({ data, error } = await db.from("job_recommendation_runs").select("user_id"));
  }
  if (error) throw new Error(`추천 sweep 대상 조회 실패: ${error.message}`);
  for (const r of (data ?? []) as { user_id: string }[]) await enqueueRecommend(r.user_id);
  return { enqueued: data?.length ?? 0 };
}

export function startRecommendWorker(): Worker<RecommendJobData> {
  worker = new Worker<RecommendJobData>(
    RECOMMEND_QUEUE,
    async (job: Job<RecommendJobData>) => (job.data.kind === "sweep" ? sweepActive() : computeRecommendations(job.data.userId, job.data.force)),
    { connection: connection(), concurrency: 2 }
  );
  worker.on("failed", (job, err) => {
    const who = job?.data.kind === "sweep" ? "sweep" : `user=${job?.data.userId?.slice(0, 8)}…`;
    console.error(`[recommend] 실패 ${who}: ${err.message}`);
    Sentry.captureException(err, { tags: { queue: RECOMMEND_QUEUE } });
  });
  return worker;
}

/** api 역할에서 1회 등록 (upsert 라 여러 번 불려도 하나). */
export async function startRecommendSweepScheduler(): Promise<void> {
  await getRecommendQueue().upsertJobScheduler("rec-sweep-daily", { pattern: SWEEP_CRON }, { name: "sweep", data: { kind: "sweep" } });
}

export async function closeRecommendQueue(): Promise<void> {
  await worker?.close();
  await queue?.close();
  worker = null;
  queue = null;
  for (const c of connections.splice(0)) c.disconnect();
}

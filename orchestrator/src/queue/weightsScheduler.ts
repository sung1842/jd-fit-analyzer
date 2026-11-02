import { Queue, Worker } from "bullmq";
import { createRedisConnection } from "../lib/redis.js";
import { recomputeRankingWeights } from "../lib/rankingWeights.js";
import { Sentry } from "../lib/sentry.js";

/**
 * 층별 가중치 주간 재계산 (22 문서 §7.2, E6b). 학습은 이 큐 워커에서만 돈다 (헌법 2조 — HTTP 안에서 안 함).
 * 등록(리드): api 역할 → startWeightsScheduler(), worker 역할 → startWeightsWorker().
 */
export const WEIGHTS_QUEUE = "ranking-weights";
const CRON = process.env.RANKING_WEIGHTS_CRON || "0 5 * * 1"; // 매주 월 05:00 (서버 시간)

let queue: Queue | null = null;
const connections: ReturnType<typeof createRedisConnection>[] = [];
function connection() {
  const c = createRedisConnection();
  connections.push(c);
  return c;
}
let worker: Worker | null = null;

export function getWeightsQueue(): Queue {
  queue ??= new Queue(WEIGHTS_QUEUE, {
    connection: connection(),
    defaultJobOptions: { attempts: 2, backoff: { type: "exponential", delay: 60_000 }, removeOnComplete: { count: 20 }, removeOnFail: { count: 20 } },
  });
  return queue;
}

/** api 역할에서 1회 (upsert 라 여러 번 불려도 하나) */
export async function startWeightsScheduler(): Promise<void> {
  await getWeightsQueue().upsertJobScheduler("ranking-weights-weekly", { pattern: CRON }, { name: "recompute", data: {} });
}

export function startWeightsWorker(): Worker {
  worker = new Worker(WEIGHTS_QUEUE, () => recomputeRankingWeights(), { connection: connection(), concurrency: 1 });
  worker.on("completed", (job, r) => console.log(`[${WEIGHTS_QUEUE}] job ${job.id} completed ${JSON.stringify(r)}`));
  worker.on("failed", (job, err) => {
    console.error(`[${WEIGHTS_QUEUE}] job ${job?.id} failed: ${err.message.slice(0, 160)}`);
    if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) Sentry.captureMessage("ranking-weights recompute failed", { level: "error", tags: { worker: WEIGHTS_QUEUE } });
  });
  return worker;
}

export async function closeWeightsQueue(): Promise<void> {
  await worker?.close();
  worker = null;
  await queue?.close();
  queue = null;
  for (const c of connections.splice(0)) c.disconnect();
}

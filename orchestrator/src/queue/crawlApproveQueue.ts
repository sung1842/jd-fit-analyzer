import { createHash } from "node:crypto";
import { Queue, Worker, type Job } from "bullmq";
import { ConflictError, NotFoundError, runBatchApproval } from "../lib/crawlReview.js";
import { createRedisConnection } from "../lib/redis.js";
import { Sentry } from "../lib/sentry.js";

/**
 * 크롤 검수 배치 승인 잡 (헌법 2조). 라우트는 사전 검사 후 202 + jobId 만 돌려주고,
 * 승인 update + job_postings 병합은 이 워커가 처리한다.
 */
export const CRAWL_APPROVE_QUEUE = "crawl-approve";

export interface CrawlApproveJobData {
  batchId: string;
}
export type CrawlApproveResult = { approved: number; merged: number; deleted: number };

// 크롤 검수 화면을 안 쓰는 프로세스(테스트 포함)가 Redis 에 붙지 않도록 처음 쓸 때 만든다
let queue: Queue<CrawlApproveJobData, CrawlApproveResult> | null = null;
// BullMQ 는 넘겨받은 ioredis 연결을 close() 때 닫지 않는다 → 직접 들고 있다가 닫는다 (테스트 종료용)
const connections: ReturnType<typeof createRedisConnection>[] = [];
export function connection() {
  const c = createRedisConnection();
  connections.push(c);
  return c;
}
/** 다른 크롤 큐(crawlRunQueue)도 여기 등록해 한 번에 닫는다 */
export const closers: (() => Promise<void>)[] = [];
export async function closeCrawlApprove(): Promise<void> {
  await queue?.close();
  queue = null;
  for (const close of closers) await close();
  for (const c of connections.splice(0)) c.disconnect();
}

export function getCrawlApproveQueue(): Queue<CrawlApproveJobData, CrawlApproveResult> {
  queue ??= new Queue(CRAWL_APPROVE_QUEUE, {
    connection: connection(),
    // DB 단계는 상태 조건 update 라 다시 돌려도 안전 → 일시 오류만 1회 재시도
    defaultJobOptions: { attempts: 2, backoff: { type: "fixed", delay: 5_000 }, removeOnComplete: { age: 24 * 3600 }, removeOnFail: { age: 7 * 24 * 3600 } },
  });
  return queue;
}

/** 배치 기준 고정 jobId — 같은 배치를 두 번 눌러도 잡은 하나. BullMQ jobId 는 ":" 불가라 해시로 만든다 */
export function buildCrawlApproveJobId(batchId: string): string {
  return `crawl-approve_${createHash("sha256").update(batchId).digest("hex").slice(0, 24)}`;
}

/** 대기·실행 중이면 그 잡을 그대로 쓰고, 끝난 잡(완료·실패)은 지우고 새로 넣는다 (나중에 다시 승인할 수 있게) */
export async function enqueueBatchApproval(batchId: string): Promise<{ jobId: string; deduped: boolean }> {
  const q = getCrawlApproveQueue();
  const jobId = buildCrawlApproveJobId(batchId);
  const existing = await q.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (state === "completed" || state === "failed") await existing.remove();
    else return { jobId, deduped: true };
  }
  await q.add("approve", { batchId }, { jobId });
  return { jobId, deduped: false };
}

export interface CrawlApproveStatus {
  jobId: string;
  batchId: string;
  state: string;
  result?: CrawlApproveResult;
  error?: string;
}

export async function getBatchApprovalStatus(jobId: string): Promise<CrawlApproveStatus | null> {
  if (!/^crawl-approve_[0-9a-f]{24}$/.test(jobId)) return null;
  const job = await getCrawlApproveQueue().getJob(jobId);
  if (!job) return null;
  const state = await job.getState();
  return {
    jobId,
    batchId: job.data.batchId,
    state,
    ...(state === "completed" ? { result: job.returnvalue } : {}),
    // 사전 검사(409) 문구는 그대로, DB 오류 원문은 서버 로그·Sentry 에만 남긴다
    ...(state === "failed" ? { error: job.failedReason?.startsWith("[conflict] ") ? job.failedReason.slice(11) : "병합 중 서버 오류가 발생했습니다. orchestrator 로그를 확인하세요." } : {}),
  };
}

export function startCrawlApproveWorker() {
  const worker = new Worker<CrawlApproveJobData, CrawlApproveResult>(
    CRAWL_APPROVE_QUEUE,
    async (job: Job<CrawlApproveJobData>) => {
      try {
        return await runBatchApproval(job.data.batchId);
      } catch (err) {
        if (err instanceof ConflictError || err instanceof NotFoundError) {
          // 큐에 들어간 뒤 샘플 판정이 바뀐 경우 — 재시도해도 같으므로 바로 실패로 끝낸다
          await job.discard();
          throw new Error(`[conflict] ${err.message}`);
        }
        throw err;
      }
    },
    { connection: connection(), concurrency: 1 } // 프로세스당 하나 (worker 다중 기동 시 다른 배치끼리는 동시에 돌 수 있으나 upsert onConflict 라 안전)
  );

  worker.on("completed", (job, result) => {
    console.log(`[${worker.name}] job ${job.id} completed (batch=${job.data.batchId}, approved=${result.approved}, merged=${result.merged}, deleted=${result.deleted})`);
  });
  worker.on("failed", (job, err) => {
    console.error(`[${worker.name}] job ${job?.id} failed:`, err.message);
    const conflict = err.message.startsWith("[conflict] ");
    if (job && !conflict && job.attemptsMade >= (job.opts.attempts ?? 1)) {
      Sentry.captureException(err, { tags: { worker: worker.name, jobId: job.id, batchId: job.data.batchId } });
    }
  });

  return worker;
}

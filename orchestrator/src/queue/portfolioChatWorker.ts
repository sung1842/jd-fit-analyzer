import { Worker, type Job } from "bullmq";
import type { PortfolioChatAnswer, PortfolioChatJobData, PortfolioChunk } from "../../../shared/types.js";
import { callMcpTool } from "../mcp/client.js";
import { notifyN8nError } from "../lib/n8n.js";
import { type PortfolioChatResult, setCachedAnswer } from "../lib/portfolioChatCache.js";
import { createRedisConnection } from "../lib/redis.js";
import { Sentry } from "../lib/sentry.js";
import { QUEUE_NAMES } from "./queues.js";

const TOP_K = 5;

async function processPortfolioChatJob(job: Job<PortfolioChatJobData>): Promise<PortfolioChatResult> {
  const { candidateId, question } = job.data;

  // 신규/변경된 청크만 재임베딩 (변경 없으면 content_hash 비교 후 즉시 반환 — 저비용)
  await job.updateProgress({ stage: "indexing" });
  await callMcpTool("embed_and_index_portfolio", { candidateId });

  await job.updateProgress({ stage: "searching" });
  const chunks = await callMcpTool<PortfolioChunk[]>("search_portfolio_chunks", { candidateId, query: question, topK: TOP_K });

  await job.updateProgress({ stage: "answering" });
  const answer = await callMcpTool<PortfolioChatAnswer>("answer_portfolio_question", { question, chunks });

  const citedChunks = chunks.filter((c) => answer.cited_chunk_ids.includes(c.id));
  const result: PortfolioChatResult = { ...answer, citedChunks };

  await setCachedAnswer(candidateId, question, result);

  await job.updateProgress({ stage: "done" });
  return result;
}

export function startPortfolioChatWorker() {
  const worker = new Worker<PortfolioChatJobData, PortfolioChatResult>(QUEUE_NAMES.portfolioChat, processPortfolioChatJob, {
    connection: createRedisConnection(),
    concurrency: Number(process.env.CHAT_WORKER_CONCURRENCY) || 2,
    limiter: { max: Number(process.env.CHAT_JOBS_PER_MIN) || 4, duration: 60_000 }, // job 투입 상한. Gemini RPM 은 mcp-server 리미터가 담당
  });

  worker.on("completed", (job) => {
    console.log(`[${worker.name}] job ${job.id} completed (candidate=${job.data.candidateId})`);
  });
  worker.on("failed", (job, err) => {
    console.error(`[${worker.name}] job ${job?.id} failed:`, err.message);

    // 재시도(attempts) 소진 후 영구 실패한 경우만 Sentry/n8n으로 전송 — 503/429 일시 오류 재시도 노이즈 제외
    const attemptsMade = job?.attemptsMade ?? 0;
    const maxAttempts = job?.opts.attempts ?? 1;
    if (job && attemptsMade >= maxAttempts) {
      Sentry.captureException(err, { tags: { worker: worker.name, jobId: job.id, candidateId: job.data.candidateId } });
      void notifyN8nError({
        worker: worker.name,
        jobId: job.id!,
        candidateId: job.data.candidateId,
        errorMessage: err.message,
        attemptsMade,
      });
    }
  });

  return worker;
}

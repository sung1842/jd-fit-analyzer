import { Worker, type Job } from "bullmq";
import type { FitAnalysisJobData, FitReport, FitReportStatus } from "../../../shared/types.js";
import { setCachedReport } from "../lib/cache.js";
import { getFitReportByJobId, updateFitReportByJobId } from "../lib/fitReports.js";
import { notifyN8nError } from "../lib/n8n.js";
import { createRedisConnection } from "../lib/redis.js";
import { Sentry } from "../lib/sentry.js";
import { runFitAnalysis } from "../runFitAnalysis.js";
import { scheduleHilTimeout } from "./hilTimeout.js";
import { QUEUE_NAMES } from "./queues.js";

function isLowConfidence(report: FitReport): boolean {
  return Boolean(report.techStack.flags?.includes("low_confidence") || report.experience.flags?.includes("low_confidence"));
}

async function processFitAnalysisJob(job: Job<FitAnalysisJobData>): Promise<FitReport> {
  const { jd, candidateId } = job.data;

  await updateFitReportByJobId(job.id!, { status: "processing" });

  const report = await runFitAnalysis(jd, candidateId, async (stage) => {
    await job.updateProgress({ stage });
  });

  const status: FitReportStatus = isLowConfidence(report) ? "pending_review" : "completed";
  await updateFitReportByJobId(job.id!, { status, candidateName: report.candidateName, report });

  if (status === "pending_review") {
    const record = await getFitReportByJobId(job.id!);
    if (record) await scheduleHilTimeout(record.id);
  } else {
    await setCachedReport(jd, candidateId, report);
  }

  return report;
}

// 동시 처리 job 수. LLM RPM 은 여기서 막지 않는다 — 실제 Gemini 호출 수 제한은 mcp-server/src/lib/rateLimiter.ts 가 담당.
// concurrency 를 올려도 Gemini 슬롯이 없으면 job 은 호출부에서 대기할 뿐 429 를 내지 않는다.
const WORKER_CONCURRENCY = Number(process.env.FIT_WORKER_CONCURRENCY) || 3;
// 분당 job 투입 상한(유료/무료). Gemini 리미터와 이중 안전장치 + 무료 큐 starvation 방지용 배분(대략 2:1).
const PAID_JOBS_PER_MIN = Number(process.env.FIT_PAID_JOBS_PER_MIN) || 4;
const FREE_JOBS_PER_MIN = Number(process.env.FIT_FREE_JOBS_PER_MIN) || 2;

export function startWorkers() {
  const paidWorker = new Worker<FitAnalysisJobData, FitReport>(QUEUE_NAMES.paid, processFitAnalysisJob, {
    connection: createRedisConnection(),
    concurrency: WORKER_CONCURRENCY,
    limiter: { max: PAID_JOBS_PER_MIN, duration: 60_000 },
  });

  const freeWorker = new Worker<FitAnalysisJobData, FitReport>(QUEUE_NAMES.free, processFitAnalysisJob, {
    connection: createRedisConnection(),
    concurrency: WORKER_CONCURRENCY,
    limiter: { max: FREE_JOBS_PER_MIN, duration: 60_000 },
  });

  for (const worker of [paidWorker, freeWorker]) {
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
  }

  return { paidWorker, freeWorker };
}

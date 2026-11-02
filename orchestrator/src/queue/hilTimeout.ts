import { Queue, Worker } from "bullmq";
import { getFitReportById, updateFitReportByJobId } from "../lib/fitReports.js";
import { notifyN8nError } from "../lib/n8n.js";
import { createRedisConnection } from "../lib/redis.js";
import { Sentry } from "../lib/sentry.js";

export const QUEUE_NAME_HIL_TIMEOUT = "hil-timeout";

const HIL_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24h

export const hilTimeoutQueue = new Queue<{ fitReportId: string }>(QUEUE_NAME_HIL_TIMEOUT, {
  connection: createRedisConnection(),
});

// pending_review 진입 시 24시간 뒤 만료 처리를 예약 (워커를 블로킹하지 않음)
export async function scheduleHilTimeout(fitReportId: string): Promise<void> {
  await hilTimeoutQueue.add(
    "expire-pending-review",
    { fitReportId },
    { delay: HIL_TIMEOUT_MS, jobId: `hil-timeout_${fitReportId}` }
  );
}

export function startHilTimeoutWorker() {
  const worker = new Worker<{ fitReportId: string }>(
    QUEUE_NAME_HIL_TIMEOUT,
    async (job) => {
      const record = await getFitReportById(job.data.fitReportId);
      // 사람이 이미 approved/rejected로 변경했다면 idempotent하게 아무 동작도 하지 않음
      if (record?.status === "pending_review") {
        await updateFitReportByJobId(record.jobId, { status: "expired" });
      }
    },
    { connection: createRedisConnection() }
  );

  worker.on("failed", (job, err) => {
    console.error(`[${worker.name}] job ${job?.id} failed:`, err.message);
    Sentry.captureException(err, { tags: { worker: worker.name, jobId: job?.id } });

    if (job) {
      void notifyN8nError({
        worker: worker.name,
        jobId: job.id!,
        errorMessage: err.message,
        attemptsMade: job.attemptsMade,
      });
    }
  });

  return worker;
}

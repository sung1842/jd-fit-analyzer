import { Queue, Worker } from "bullmq";
import { getFitReportById, updateFitReportByJobId } from "../lib/fitReports.js";
import { createRedisConnection } from "../lib/redis.js";
import { Sentry } from "../lib/sentry.js";

export const QUEUE_NAME_HIL_TIMEOUT = "hil-timeout";

const HIL_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24h

export const hilTimeoutQueue = new Queue<{ fitReportId: string }>(QUEUE_NAME_HIL_TIMEOUT, {
  connection: createRedisConnection(),
  // 끝난 예약은 남기지 않는다. 남아 있으면 같은 리포트가 다시 검토 대기가 됐을 때 새 예약이 무시된다.
  defaultJobOptions: { attempts: 3, backoff: { type: "exponential", delay: 30_000 }, removeOnComplete: true, removeOnFail: { age: 7 * 24 * 60 * 60 } },
});

// pending_review 진입 시 24시간 뒤 만료 처리를 예약 (워커를 블로킹하지 않음)
export async function scheduleHilTimeout(fitReportId: string): Promise<void> {
  // 다시 분석해 또 검토 대기가 된 경우: 예전 예약을 지우고 24시간을 새로 센다
  const prev = await hilTimeoutQueue.getJob(`hil-timeout_${fitReportId}`);
  if (prev) await prev.remove().catch(() => undefined);
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

  });

  return worker;
}

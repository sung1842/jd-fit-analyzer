import { FREE_QUEUE_PROMOTION_THRESHOLD_MS, JOB_PRIORITY, freeQueue } from "./queues.js";

const POLL_INTERVAL_MS = 60_000; // 1분마다 무료 큐의 대기 job을 점검

// 무료 큐에서 PROMOTION_THRESHOLD 이상 대기한 job을 paid와 동일한 priority로 승격한다.
// (큐 자체는 두 개로 분리된 원래 설계를 유지하고, 무료 큐 내부의 starvation만 완화)
async function promoteStaleFreeJobs(): Promise<void> {
  const waiting = await freeQueue.getJobs(["waiting"]);
  const now = Date.now();

  for (const job of waiting) {
    if (job.priority === JOB_PRIORITY.promoted) continue; // 이미 승격됨

    const waitedMs = now - job.timestamp;
    if (waitedMs >= FREE_QUEUE_PROMOTION_THRESHOLD_MS) {
      await job.changePriority({ priority: JOB_PRIORITY.promoted });
      console.log(`[promotionScheduler] job ${job.id} 승격 (대기 ${Math.round(waitedMs / 1000)}s)`);
    }
  }
}

export function startPromotionScheduler(): NodeJS.Timeout {
  return setInterval(() => {
    promoteStaleFreeJobs().catch((err) => console.error("[promotionScheduler] 오류:", err));
  }, POLL_INTERVAL_MS);
}

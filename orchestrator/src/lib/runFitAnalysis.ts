import type { FitReport } from "../../../shared/types.js";
import { getCachedReport, jdHash } from "./cache.js";
import { createFitReport } from "./fitReports.js";
import { buildJobId, getQueue, JOB_PRIORITY, removeStaleFailedJob } from "../queue/queues.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 단일 후보 JD 정밀 분석 — 캐시 hit 또는 BullMQ job 완료까지 대기 */
export async function runFitAnalysisWait(
  jd: string,
  candidateId: string,
  userId: string,
  options: { tier?: "free" | "paid"; timeoutMs?: number } = {}
): Promise<FitReport | null> {
  const tier = options.tier ?? "free";
  const timeoutMs = options.timeoutMs ?? 180_000;

  const cached = await getCachedReport(jd, candidateId);
  if (cached) return cached;

  const queue = getQueue(tier);
  const jobId = buildJobId(jd, candidateId);

  await removeStaleFailedJob(queue, jobId);

  let job = await queue.getJob(jobId);
  if (!job) {
    await createFitReport({ jobId, jd, jdHash: jdHash(jd), candidateId, userId });
    job = await queue.add(
      "analyze-fit",
      { jd, candidateId, userId, tier },
      { jobId, priority: JOB_PRIORITY[tier] }
    );
  } else {
    const state = await job.getState();
    if (state === "completed") return (job.returnvalue as FitReport) ?? null;
    if (state === "failed") {
      await removeStaleFailedJob(queue, jobId);
      await createFitReport({ jobId, jd, jdHash: jdHash(jd), candidateId, userId });
      job = await queue.add(
        "analyze-fit",
        { jd, candidateId, userId, tier },
        { jobId, priority: JOB_PRIORITY[tier] }
      );
    }
  }

  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const current = await queue.getJob(jobId);
    if (!current) return null;
    const state = await current.getState();
    if (state === "completed") return (current.returnvalue as FitReport) ?? null;
    if (state === "failed") return null;
    await sleep(2_000);
  }

  console.warn(`[fit-analysis] timeout candidateId=${candidateId} jobId=${jobId}`);
  return null;
}

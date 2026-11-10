import type { FitReport } from "../../../shared/types.js";
import { getCachedReport, jdHash } from "./cache.js";
import { buildJobId, getQueue } from "../queue/queues.js";
import { enqueueFitBatch } from "../queue/enqueue.js";

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

  // 단일 입구로 투입 (이미 대기·실행 중이면 그대로 두고 결과만 기다린다)
  const existing = await queue.getJob(jobId);
  if (existing && (await existing.getState()) === "completed") return (existing.returnvalue as FitReport) ?? null;
  await enqueueFitBatch({ userId, tier, items: [{ jd, jdHash: jdHash(jd), candidateId }] });

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

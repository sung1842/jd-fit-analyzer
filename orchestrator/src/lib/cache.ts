import { createHash } from "node:crypto";
import type { FitReport } from "../../../shared/types.js";
import { redis } from "./redis.js";

const CACHE_TTL_SECONDS = 60 * 60 * 24; // 24h

export function jdHash(jd: string): string {
  return createHash("sha256").update(jd).digest("hex").slice(0, 16);
}

// 캐싱 정책: fitreport:cache:<jdHash>:<candidateId> — BullMQ jobId와 동일한 키 형식
export function cacheKey(jd: string, candidateId: string): string {
  return `${jdHash(jd)}:${candidateId}`;
}

export async function getCachedReport(jd: string, candidateId: string): Promise<FitReport | null> {
  const raw = await redis.get(`fitreport:cache:${cacheKey(jd, candidateId)}`);
  return raw ? (JSON.parse(raw) as FitReport) : null;
}

export async function setCachedReport(jd: string, candidateId: string, report: FitReport): Promise<void> {
  await redis.set(`fitreport:cache:${cacheKey(jd, candidateId)}`, JSON.stringify(report), "EX", CACHE_TTL_SECONDS);
}

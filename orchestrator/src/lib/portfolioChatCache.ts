import type { PortfolioChatAnswer, PortfolioChunk } from "../../../shared/types.js";
import { questionHash } from "../queue/queues.js";
import { redis } from "./redis.js";

const CACHE_TTL_SECONDS = 60 * 60; // 1h — 포트폴리오 내용이 분석보다 자주 갱신될 수 있어 짧게 유지

export interface PortfolioChatResult extends PortfolioChatAnswer {
  citedChunks: PortfolioChunk[];
}

function cacheKey(candidateId: string, question: string): string {
  return `portfoliochat:cache:${candidateId}:${questionHash(question)}`;
}

export async function getCachedAnswer(candidateId: string, question: string): Promise<PortfolioChatResult | null> {
  const raw = await redis.get(cacheKey(candidateId, question));
  return raw ? (JSON.parse(raw) as PortfolioChatResult) : null;
}

export async function setCachedAnswer(candidateId: string, question: string, result: PortfolioChatResult): Promise<void> {
  await redis.set(cacheKey(candidateId, question), JSON.stringify(result), "EX", CACHE_TTL_SECONDS);
}

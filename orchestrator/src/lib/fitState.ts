/**
 * 핏 분석의 "진행 중" 상태와 오류 분류.
 *
 * 원칙
 *  - fit_reports 행은 결과가 나왔을 때만 만든다. 진행 중 상태는 DB 에 쓰지 않고 Redis 에만 둔다.
 *    (같은 상태를 DB 와 큐 두 곳에 두면 어긋나고, 어긋난 행은 지울 방법이 없어 계속 남았다.)
 *  - 표시는 사용자별 ZSET 두 개. 멤버 = `${jdHash}:${candidateId}`, score = 기록 시각(ms).
 *      fit:inflight:{userId}  분석 대기·진행 중
 *      fit:retry:{userId}     일시 오류로 끝난 분석 — 화면에는 "다시 시도" 안내만. 원인·분석 데이터는 남기지 않는다.
 *  - 오래된 멤버는 읽을 때마다 score 로 잘라낸다 → 큐가 유실돼도 표시가 영원히 남지 않는다 (별도 청소 불필요).
 *  - 프로세스 메모리에 상태를 두지 않는다 → api·worker 를 몇 대로 늘려도 같은 값을 본다.
 */
import { redis } from "./redis.js";

export const INFLIGHT_TTL_MS = Number(process.env.FIT_INFLIGHT_TTL_MS) || 2 * 60 * 60_000; // 대기 한도(30분)보다 넉넉히
export const RETRY_MARK_TTL_MS = Number(process.env.FIT_FAILED_TTL_MS) || 2 * 24 * 60 * 60_000; // 실패 표시·행 보존 2일
const KEY_EXPIRE_SEC = 3 * 24 * 60 * 60;

const inflightKey = (userId: string) => `fit:inflight:${userId}`;
const retryKey = (userId: string) => `fit:retry:${userId}`;
export const member = (jdHash: string, candidateId: string) => `${jdHash}:${candidateId}`;

function parse(members: string[]): { jdHash: string; candidateId: string }[] {
  return members.map((m) => {
    const i = m.indexOf(":");
    return { jdHash: m.slice(0, i), candidateId: m.slice(i + 1) };
  });
}

/** 사용자의 진행 중 분석 수 (오래된 표시는 먼저 잘라낸다) */
export async function inflightCount(userId: string): Promise<number> {
  const key = inflightKey(userId);
  const [, count] = (await redis.multi().zremrangebyscore(key, 0, Date.now() - INFLIGHT_TTL_MS).zcard(key).exec()) ?? [];
  return Number(count?.[1] ?? 0);
}

export async function markInflight(userId: string, members: string[]): Promise<void> {
  if (members.length === 0) return;
  const now = Date.now();
  const args = members.flatMap((m) => [now, m]);
  await redis
    .multi()
    .zadd(inflightKey(userId), ...args)
    .expire(inflightKey(userId), KEY_EXPIRE_SEC)
    .zrem(retryKey(userId), ...members)
    .exec();
}

export async function clearInflight(userId: string, members: string[]): Promise<void> {
  if (members.length) await redis.zrem(inflightKey(userId), ...members);
}

/** 분석이 끝났다: 결과 저장 뒤 표시를 지운다. retryable 이면 "다시 시도" 표시로 옮긴다 */
export async function settle(userId: string, m: string, outcome: "done" | "retryable"): Promise<void> {
  const tx = redis.multi().zrem(inflightKey(userId), m);
  if (outcome === "retryable") tx.zadd(retryKey(userId), Date.now(), m).expire(retryKey(userId), KEY_EXPIRE_SEC);
  else tx.zrem(retryKey(userId), m);
  await tx.exec();
}

export async function clearRetry(userId: string, members: string[]): Promise<void> {
  if (members.length) await redis.zrem(retryKey(userId), ...members);
}

export interface FitMarks {
  inflight: { jdHash: string; candidateId: string; at: number }[];
  retryable: { jdHash: string; candidateId: string; at: number }[];
}

/** 화면 집계용: 사용자의 진행 중·다시 시도 표시 전체 */
export async function loadMarks(userId: string): Promise<FitMarks> {
  const now = Date.now();
  const res = await redis
    .multi()
    .zremrangebyscore(inflightKey(userId), 0, now - INFLIGHT_TTL_MS)
    .zremrangebyscore(retryKey(userId), 0, now - RETRY_MARK_TTL_MS)
    .zrange(inflightKey(userId), 0, -1, "WITHSCORES")
    .zrange(retryKey(userId), 0, -1, "WITHSCORES")
    .exec();
  const pairs = (raw: unknown) => {
    const arr = (raw as string[]) ?? [];
    const out: { jdHash: string; candidateId: string; at: number }[] = [];
    for (let i = 0; i < arr.length; i += 2) out.push({ ...parse([arr[i]])[0], at: Number(arr[i + 1]) });
    return out;
  };
  return { inflight: pairs(res?.[2]?.[1]), retryable: pairs(res?.[3]?.[1]) };
}

/** Redis 가 응답하지 않을 때 화면 집계가 멈추지 않게 (표시 없이 DB 결과만 보여 준다) */
export async function loadMarksSafe(userId: string, timeoutMs = 1500): Promise<FitMarks> {
  const empty: FitMarks = { inflight: [], retryable: [] };
  try {
    return await Promise.race([loadMarks(userId), new Promise<FitMarks>((r) => setTimeout(() => r(empty), timeoutMs))]);
  } catch {
    return empty;
  }
}

// ── LLM 차단 표시 (mcp-server 가 한도 도달 시 세운다. 값 = 다시 열리는 시각 ms) ──────────────
export const LLM_BREAKER_KEY = "llm:breaker:analysis";

export async function breakerRemainingMs(): Promise<number> {
  const ttl = await redis.pttl(LLM_BREAKER_KEY);
  return ttl > 0 ? ttl : 0;
}

export async function openBreaker(ms: number): Promise<void> {
  await redis.set(LLM_BREAKER_KEY, String(Date.now() + ms), "PX", ms);
}

export { classifyFitError, type FitErrorClass, type FitErrorInfo } from "./fitErrors.js";

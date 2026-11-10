import { createHash } from "node:crypto";
import { Queue } from "bullmq";
import type { FitAnalysisJobData, PortfolioChatJobData } from "../../../shared/types.js";
import { jdHash } from "../lib/cache.js";
import { createRedisConnection } from "../lib/redis.js";

export const QUEUE_NAMES = {
  paid: "fit-analysis-paid",
  free: "fit-analysis-free",
  portfolioChat: "portfolio-chat",
} as const;

// 재시도는 여기 한 곳에서만 한다 (mcp-server 는 한 번만 시도하고 오류를 분류해 돌려준다).
//  - 일시 오류: 지수 백오프로 원본 포함 최대 3회 (20s → 40s)
//  - 다시 해도 같은 오류: 워커가 UnrecoverableError 로 즉시 끝낸다
//  - LLM 한도·슬롯 부족: 시도 횟수를 쓰지 않고 뒤로 미룬다 (workers.ts)
// 끝난 job 은 Redis 에 쌓아 두지 않는다. 완료 1시간(SSE 로 결과를 받아 갈 시간), 실패 2일 뒤 자동 삭제.
export const fitJobOptions = {
  attempts: 3,
  backoff: { type: "exponential" as const, delay: 20_000 },
  removeOnComplete: { age: 60 * 60, count: 10_000 },
  removeOnFail: { age: 2 * 24 * 60 * 60, count: 10_000 },
};
const defaultJobOptions = fitJobOptions;

export const paidQueue = new Queue<FitAnalysisJobData>(QUEUE_NAMES.paid, {
  connection: createRedisConnection(),
  defaultJobOptions,
});
export const freeQueue = new Queue<FitAnalysisJobData>(QUEUE_NAMES.free, {
  connection: createRedisConnection(),
  defaultJobOptions,
});

export function getQueue(tier: "paid" | "free"): Queue<FitAnalysisJobData> {
  return tier === "paid" ? paidQueue : freeQueue;
}

// BullMQ priority: 숫자가 작을수록 먼저 처리됨 (0 = 미설정/최우선, 범위 0~2,097,152)
// 무료 큐는 자체적으로 paid보다 후순위라는 의미는 없음(별도 큐이므로 서로 경쟁하지 않음) —
// 동일 큐 내에서 "일반 무료 요청"과 "오래 대기한 무료 요청(승격)"을 구분하기 위한 값.
export const JOB_PRIORITY = {
  paid: 1,
  free: 2,
  promoted: 1, // 무료 큐 내에서 승격된 job — 신규 무료 요청(2)보다 먼저 처리
} as const;

// 무료 큐에서 이 시간 이상 대기(waiting)한 job은 승격(promotion) 대상이 된다 (starvation 방지)
export const FREE_QUEUE_PROMOTION_THRESHOLD_MS = 5 * 60 * 1000; // 5분

// jdHash_candidateId — 캐싱 키(`fitreport:cache:<jdHash>:<candidateId>`)와 동일한 식별 정보를 사용하되,
// BullMQ의 커스텀 jobId는 ":"를 포함할 수 없으므로 "_"로 구분한다.
// 동일 (jd, candidateId) 조합은 항상 같은 jobId를 가지므로 BullMQ가 중복 등록을 자동 dedup한다.
export function buildJobId(jd: string, candidateId: string): string {
  return `${jdHash(jd)}_${candidateId}`;
}

// Phase 5 RAG: 포트폴리오 채팅 큐 — fit-analysis와 동일한 재시도 정책(503/429 대응)
export const portfolioChatQueue = new Queue<PortfolioChatJobData>(QUEUE_NAMES.portfolioChat, {
  connection: createRedisConnection(),
  defaultJobOptions,
});

export function questionHash(question: string): string {
  return createHash("sha256").update(question.trim()).digest("hex").slice(0, 16);
}

// candidateId_questionHash — 동일 (candidate, question)은 BullMQ가 자동 dedup
export function buildPortfolioChatJobId(candidateId: string, question: string): string {
  return `${candidateId}_${questionHash(question)}`;
}

// BullMQ 는 같은 jobId 로 add() 하면 기존 job(완료/실패 포함)을 그대로 두고 아무것도 하지 않는다.
// 끝난 job 이 남아 있으면 다시 넣어도 실행되지 않으므로, 넣기 전에 끝난 job 을 지운다.
// 반환: true = 지금 대기·실행 중이라 새로 넣을 필요가 없다.
export async function clearFinishedJob(queue: Queue, jobId: string): Promise<boolean> {
  const job = await queue.getJob(jobId);
  if (!job) return false;
  const state = await job.getState();
  if (state === "completed" || state === "failed" || state === "unknown") {
    await job.remove().catch(() => undefined);
    return false;
  }
  return true;
}

/** @deprecated clearFinishedJob 사용 */
export async function removeStaleFailedJob(queue: Queue, jobId: string): Promise<void> {
  await clearFinishedJob(queue, jobId);
}

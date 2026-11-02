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

// Gemini 503/429 등 일시적 오류 대응: 지수 백오프로 최대 3회(원본 시도 + 재시도 2회) 자동 재시도
// Gemini 무료 티어 429 응답의 retryDelay(약 56s)를 고려해 첫 백오프를 20s로 설정 (20s -> 40s -> 80s)
const defaultJobOptions = {
  attempts: 3,
  backoff: { type: "exponential" as const, delay: 20_000 },
};

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

// BullMQ는 동일 jobId로 add() 호출 시 기존 job(완료/실패 불문)을 그대로 두고 재실행하지 않는다.
// 재시도(attempts)를 모두 소진해 영구 실패한 job은 원인이 해결된 뒤에도 같은 jobId로는 재처리되지 않으므로,
// add() 전에 failed 상태인 동일 jobId job을 제거해 새로 enqueue될 수 있게 한다.
export async function removeStaleFailedJob(queue: Queue, jobId: string): Promise<void> {
  const job = await queue.getJob(jobId);
  if (!job) return;

  const state = await job.getState();
  if (state === "failed") {
    await job.remove();
  }
}

/**
 * 핏 분석 투입의 단일 입구. 모든 경로(/api/analyze, 스카우트 건, 상시 수색, 재분석)가 여기를 거친다.
 *
 * 대규모 동시 접속을 전제로 한 규칙
 *  1. 입구에서 막는다 (backpressure): 큐가 한계 깊이를 넘으면 받지 않고 즉시 503 을 돌려준다.
 *     큐는 무한히 쌓을 수 있지만 쌓인 만큼 LLM 을 부르게 되므로, 처리 못 할 양은 처음부터 받지 않는다.
 *  2. 사용자별 진행 중 상한: 한 사용자가 큐를 독점하지 못한다.
 *  3. 공정성: 이미 많이 넣은 사용자의 다음 job 일수록 우선순위를 낮춘다 → 뒤늦게 온 소량 요청이 먼저 처리된다.
 *  4. 멱등: 같은 (JD, 후보)를 몇 번 넣어도 실행은 한 번. 끝난 job 은 지우고 새로 넣는다.
 *  5. Redis 가 응답하지 않으면 기다리지 않고 실패한다 (요청이 매달려 서버가 멈추지 않게).
 *  6. DB 행은 만들지 않는다. 결과가 나오면 워커가 쓴다.
 */
import type { FitAnalysisJobData } from "../../../shared/types.js";
import { db } from "../lib/db.js";
import { clearInflight, inflightCount, markInflight, member } from "../lib/fitState.js";
import { buildJobId, clearFinishedJob, freeQueue, getQueue, JOB_PRIORITY, paidQueue } from "./queues.js";

const MAX_INFLIGHT_PER_USER = Number(process.env.FIT_MAX_INFLIGHT_PER_USER) || 300;
const MAX_QUEUE_DEPTH = Number(process.env.FIT_MAX_QUEUE_DEPTH) || 200_000;
const REDIS_TIMEOUT_MS = Number(process.env.FIT_ENQUEUE_TIMEOUT_MS) || 4_000;
// 진행 중 N건마다 우선순위를 한 칸 낮춘다 (BullMQ: 숫자가 클수록 나중)
const FAIR_STEP = 20;
const FAIR_MAX_PENALTY = 50;
const CHUNK = 50;

export class EnqueueRejected extends Error {
  constructor(
    public readonly reason: "busy" | "unavailable",
    public readonly retryAfterSec: number
  ) {
    super(reason === "busy" ? "지금은 요청이 많습니다. 잠시 후 다시 시도해 주세요." : "잠시 후 다시 시도해 주세요.");
    this.name = "EnqueueRejected";
  }
}

function withTimeout<T>(p: Promise<T>, ms = REDIS_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new EnqueueRejected("unavailable", 5)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

// 큐 깊이는 인스턴스마다 2초 캐시 (요청마다 세지 않는다). 값이 조금 늦어도 상한이 약간 넘칠 뿐이라 무방.
let depthCache = { at: 0, depth: 0 };
async function queueDepth(): Promise<number> {
  if (Date.now() - depthCache.at < 2_000) return depthCache.depth;
  const [p, f] = await Promise.all([
    paidQueue.getJobCounts("waiting", "prioritized", "delayed"),
    freeQueue.getJobCounts("waiting", "prioritized", "delayed"),
  ]);
  const depth = [p, f].reduce((a, c) => a + (c.waiting ?? 0) + (c.prioritized ?? 0) + (c.delayed ?? 0), 0);
  depthCache = { at: Date.now(), depth };
  return depth;
}

export interface EnqueueItem {
  jd: string;
  jdHash: string;
  candidateId: string;
}
export interface EnqueueResult {
  /** 새로 큐에 넣은 수 */
  queued: number;
  /** 이미 대기·실행 중이라 다시 넣지 않은 수 */
  alreadyRunning: number;
  /** 사용자 상한 때문에 이번에 넣지 못한 수 */
  overLimit: number;
  /** 넣기 전 이 사용자의 진행 중 수 */
  ahead: number;
  jobIds: string[];
}

export async function enqueueFitBatch(input: {
  userId: string;
  tier: "paid" | "free";
  items: EnqueueItem[];
  /** 기본 우선순위 (없으면 tier 기본값) */
  priority?: number;
}): Promise<EnqueueResult> {
  const { userId, tier } = input;
  const queue = getQueue(tier);
  const base = input.priority ?? JOB_PRIORITY[tier];

  const [ahead, depth] = await withTimeout(Promise.all([inflightCount(userId), queueDepth()]));
  if (depth >= MAX_QUEUE_DEPTH) throw new EnqueueRejected("busy", 30);

  const room = Math.max(0, MAX_INFLIGHT_PER_USER - ahead);
  const accepted = input.items.slice(0, room);
  const result: EnqueueResult = { queued: 0, alreadyRunning: 0, overLimit: input.items.length - accepted.length, ahead, jobIds: [] };

  for (let i = 0; i < accepted.length; i += CHUNK) {
    const chunk = accepted.slice(i, i + CHUNK).map((it) => ({ ...it, jobId: buildJobId(it.jd, it.candidateId) }));
    const running = await withTimeout(Promise.all(chunk.map((c) => clearFinishedJob(queue, c.jobId))));
    const fresh = chunk.filter((_, idx) => !running[idx]);
    result.alreadyRunning += chunk.length - fresh.length;
    result.jobIds.push(...chunk.map((c) => c.jobId));
    if (fresh.length === 0) continue;

    // 예전 실패 행은 다시 분석하는 순간 의미가 없다 → 지운다 (결과가 나오면 워커가 새로 쓴다)
    const { error } = await db.from("fit_reports").delete().in("job_id", fresh.map((c) => c.jobId)).eq("status", "failed");
    if (error) console.warn(`[enqueue] 이전 실패 행 정리 실패: ${error.message}`);

    const members = fresh.map((c) => member(c.jdHash, c.candidateId));
    await withTimeout(markInflight(userId, members));
    try {
      await withTimeout(
        queue.addBulk(
          fresh.map((c, idx) => {
            const position = ahead + result.queued + idx;
            const data: FitAnalysisJobData = { jd: c.jd, jdHash: c.jdHash, candidateId: c.candidateId, userId, tier };
            return { name: "analyze-fit", data, opts: { jobId: c.jobId, priority: base + Math.min(FAIR_MAX_PENALTY, Math.floor(position / FAIR_STEP)) } };
          })
        )
      );
    } catch (err) {
      // 큐에 못 넣었으면 "진행 중" 표시도 되돌린다 (job 없는 표시가 남지 않게)
      await clearInflight(userId, members).catch(() => undefined);
      throw err;
    }
    result.queued += fresh.length;
  }
  return result;
}

/** 요청 핸들러용: 입구에서 거절된 경우 503 + Retry-After 로 응답하고 true 를 돌려준다 */
export function respondIfRejected(
  err: unknown,
  res: { status(code: number): { json(body: unknown): unknown }; setHeader(name: string, value: string): unknown }
): boolean {
  if (!(err instanceof EnqueueRejected)) return false;
  res.setHeader("Retry-After", String(err.retryAfterSec));
  res.status(503).json({ error: err.message });
  return true;
}

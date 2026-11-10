import { DelayedError, UnrecoverableError, Worker, type Job } from "bullmq";
import type { FitAnalysisJobData, FitReport, FitReportStatus } from "../../../shared/types.js";
import { getCachedReport, jdHash as hashJd, setCachedReport } from "../lib/cache.js";
import { breakerRemainingMs, classifyFitError, member, openBreaker, settle } from "../lib/fitState.js";
import { saveFitResult } from "../lib/fitReports.js";
import { createRedisConnection, redis } from "../lib/redis.js";
import { Sentry } from "../lib/sentry.js";
import { runFitAnalysis, type StepMemo } from "../runFitAnalysis.js";
import { scheduleHilTimeout } from "./hilTimeout.js";
import { QUEUE_NAMES } from "./queues.js";

function isLowConfidence(report: FitReport): boolean {
  return Boolean(report.techStack.flags?.includes("low_confidence") || report.experience.flags?.includes("low_confidence"));
}

// 한도·슬롯 부족으로 미룰 수 있는 최대 시간. 넘으면 "다시 시도" 안내로 끝낸다 (끝없이 대기열에 남지 않게).
const MAX_WAIT_MS = Number(process.env.FIT_MAX_WAIT_MS) || 30 * 60_000;
const BUSY_DELAY_MS = 20_000;
const DEFER_EXPIRED = "E_DEFER_EXPIRED";

/**
 * 시도 횟수를 쓰지 않고 job 을 뒤로 미룬다. LLM 한도가 찼을 때 계속 두드리면 다른 사용자 요청까지 전부 실패하므로,
 * 호출하지 않고 기다렸다가 풀리면 이어서 처리한다.
 */
async function defer(job: Job<FitAnalysisJobData>, token: string | undefined, ms: number): Promise<never> {
  if (Date.now() - job.timestamp > MAX_WAIT_MS) throw new UnrecoverableError(DEFER_EXPIRED);
  // 차단이 풀리는 순간 모든 job 이 한꺼번에 깨어나지 않게 흩뜨린다
  await job.moveToDelayed(Date.now() + ms + Math.floor(Math.random() * 5_000), token);
  throw new DelayedError();
}

// 재시도 때 이미 끝난 단계(후보 조회·항목 분석)를 다시 부르지 않게 잠깐 기억해 둔다
const STEP_TTL_SEC = 20 * 60;
const STEPS = ["portfolio", "analyze_tech_stack", "analyze_experience", "analyze_culture_fit"];
function stepMemo(jobId: string): StepMemo & { clear(): Promise<void> } {
  return {
    async get<T>(step: string) {
      const raw = await redis.get(`fit:step:${jobId}:${step}`).catch(() => null);
      return raw ? (JSON.parse(raw) as T) : null;
    },
    async set(step: string, value: unknown) {
      await redis.set(`fit:step:${jobId}:${step}`, JSON.stringify(value), "EX", STEP_TTL_SEC).catch(() => undefined);
    },
    async clear() {
      await redis.del(...STEPS.map((s) => `fit:step:${jobId}:${s}`)).catch(() => undefined);
    },
  };
}

async function finish(job: Job<FitAnalysisJobData>, report: FitReport, fromCache: boolean): Promise<FitReport> {
  const { jd, candidateId, userId } = job.data;
  const jdHash = job.data.jdHash ?? hashJd(jd);
  const status: FitReportStatus = isLowConfidence(report) ? "pending_review" : "completed";
  const record = await saveFitResult({ jobId: job.id!, jd, jdHash, candidateId, userId, status, candidateName: report.candidateName, report });
  if (status === "pending_review") await scheduleHilTimeout(record.id);
  else if (!fromCache) await setCachedReport(jd, candidateId, report);
  await settle(userId, member(jdHash, candidateId), "done").catch(() => undefined);
  return report;
}

export async function processFitAnalysisJob(job: Job<FitAnalysisJobData>, token?: string): Promise<FitReport> {
  const { jd, candidateId } = job.data;

  // 같은 (JD, 후보) 결과가 캐시에 있으면 LLM 을 부르지 않는다
  const cached = await getCachedReport(jd, candidateId);
  if (cached) return finish(job, cached, true);

  // LLM 한도가 찬 동안에는 호출하지 않고 미룬다
  const blocked = await breakerRemainingMs();
  if (blocked > 0) await defer(job, token, blocked);

  const memo = stepMemo(job.id!);
  let report: FitReport;
  try {
    report = await runFitAnalysis(jd, candidateId, async (stage) => { await job.updateProgress({ stage }); }, memo);
  } catch (err) {
    const info = classifyFitError(err);
    if (info.cls === "permanent") {
      throw new UnrecoverableError(`[${info.code}] ${err instanceof Error ? err.message : String(err)}`.slice(0, 300));
    }
    if (info.cls === "capacity") {
      // mcp-server 가 세운 차단 표시가 있으면 그 시간만큼, 없으면(CEO 쪽 한도 등) 짧게 세우고 미룬다
      let wait = await breakerRemainingMs();
      if (wait === 0 && info.code === "E_QUOTA") {
        wait = 60_000;
        await openBreaker(wait);
      }
      await defer(job, token, wait || BUSY_DELAY_MS);
    }
    throw err;
  }
  const out = await finish(job, report, false);
  await memo.clear();
  return out;
}

/** 최종 실패 처리. 일시 오류는 "다시 시도" 표시만 남기고, 다시 해도 같은 오류만 행으로 기록한다 (2일 뒤 자동 삭제) */
export async function onFinalFailure(job: Job<FitAnalysisJobData>, err: Error, workerName: string): Promise<void> {
  const { jd, candidateId, userId } = job.data;
  const jdHash = job.data.jdHash ?? hashJd(jd);
  const info = classifyFitError(err);
  const expired = err.message.includes(DEFER_EXPIRED);
  const permanent = info.cls === "permanent" && !expired;

  if (permanent) {
    // 기록은 꼭 남아야 한다 (안 남으면 화면에서 영원히 진행 중으로 보였다) → 몇 번 더 시도
    for (let i = 0; i < 3; i++) {
      try {
        await saveFitResult({ jobId: job.id!, jd, jdHash, candidateId, userId, status: "failed" });
        break;
      } catch (e) {
        if (i === 2) console.error(`[${workerName}] 실패 기록 불가 job=${job.id}: ${e instanceof Error ? e.message : e}`);
        else await new Promise((r) => setTimeout(r, 500 * (i + 1)));
      }
    }
  }
  await settle(userId, member(jdHash, candidateId), permanent ? "done" : "retryable").catch(() => undefined);
  await stepMemo(job.id!).clear();

  // 한도·슬롯 부족은 차단 표시로 이미 드러난다 → 건별 알림은 보내지 않는다. 그 밖의 실패 원인은 Sentry 에만 남긴다.
  if (info.cls !== "capacity" && !expired) {
    Sentry.captureException(err, { tags: { worker: workerName, jobId: job.id, candidateId, failure: info.code } });
  }
}

// 동시 처리 job 수와 분당 투입 상한. BullMQ limiter 는 큐 단위 전역 값이라 워커를 몇 대 띄워도 합계가 유지된다.
// 실제 LLM 호출 수는 mcp-server 의 Redis 리미터(GEMINI_RPM)가 한 번 더 막는다. 계약 한도에 맞춰 함께 올린다.
const WORKER_CONCURRENCY = Number(process.env.FIT_WORKER_CONCURRENCY) || 3;
const PAID_JOBS_PER_MIN = Number(process.env.FIT_PAID_JOBS_PER_MIN) || 4;
const FREE_JOBS_PER_MIN = Number(process.env.FIT_FREE_JOBS_PER_MIN) || 2;

export function startWorkers() {
  const opts = (max: number) => ({
    connection: createRedisConnection(),
    concurrency: WORKER_CONCURRENCY,
    limiter: { max, duration: 60_000 },
    // 분석 한 건이 길어도 락이 끊기지 않게. 워커가 죽으면 한 번은 다른 워커가 이어받는다.
    lockDuration: 60_000,
    maxStalledCount: 1,
  });
  const paidWorker = new Worker<FitAnalysisJobData, FitReport>(QUEUE_NAMES.paid, processFitAnalysisJob, opts(PAID_JOBS_PER_MIN));
  const freeWorker = new Worker<FitAnalysisJobData, FitReport>(QUEUE_NAMES.free, processFitAnalysisJob, opts(FREE_JOBS_PER_MIN));

  for (const worker of [paidWorker, freeWorker]) {
    worker.on("failed", (job, err) => {
      if (!job) return;
      // 재시도가 예약된 실패는 건너뛴다. 큐에서 실제로 failed 로 끝난 경우(시도 소진·즉시 실패·stalled 한도 초과)만 처리.
      void job
        .getState()
        .catch(() => "failed" as const)
        .then((state) => (state === "failed" ? onFinalFailure(job, err, worker.name) : undefined))
        .catch((e) => console.error(`[${worker.name}] 실패 처리 오류 job=${job.id}:`, e));
    });
    worker.on("error", (err) => console.error(`[${worker.name}] worker error:`, err.message));
  }

  return { paidWorker, freeWorker };
}

/**
 * 주기 정리 작업 (fit-maintenance 큐).
 *
 * setInterval 대신 BullMQ job scheduler 를 쓴다 → api·worker 를 몇 대 띄워도 한 주기에 한 번만 실행된다.
 *  - sweep   : DB 에 남을 이유가 없는 행을 스스로 정리한다
 *      · 분석하지 못한 행(failed)                → 2일 뒤 삭제
 *      · 예전 방식이 남긴 진행 중 행(queued/processing) → 결과가 있으면 완료로 되돌리고, 없으면 삭제
 *      · 24시간 넘게 검토되지 않은 저신뢰 결과     → expired (지연 job 이 유실됐을 때의 이중 안전장치)
 *  - promote : 무료 큐에서 오래 기다린 job 의 우선순위를 올린다 (한 번에 정해진 수만 훑는다)
 */
import { Queue, Worker, type Job } from "bullmq";
import { db } from "../lib/db.js";
import { RETRY_MARK_TTL_MS } from "../lib/fitState.js";
import { createRedisConnection } from "../lib/redis.js";
import { Sentry } from "../lib/sentry.js";
import { FREE_QUEUE_PROMOTION_THRESHOLD_MS, JOB_PRIORITY, freeQueue } from "./queues.js";

const QUEUE_NAME = "fit-maintenance";
const SWEEP_EVERY_MS = Number(process.env.FIT_SWEEP_EVERY_MS) || 30 * 60_000;
const PROMOTE_EVERY_MS = 60_000;
const PROMOTE_SCAN = 500;
const STALE_RUNNING_MS = 2 * 60 * 60_000;
const HIL_TIMEOUT_MS = 24 * 60 * 60_000;

type MaintenanceData = { kind: "sweep" } | { kind: "promote" };

let queue: Queue<MaintenanceData> | null = null;
function getMaintenanceQueue(): Queue<MaintenanceData> {
  queue ??= new Queue<MaintenanceData>(QUEUE_NAME, {
    connection: createRedisConnection(),
    defaultJobOptions: { removeOnComplete: { count: 20 }, removeOnFail: { count: 50 } },
  });
  return queue;
}

export interface SweepResult {
  failedDeleted: number;
  staleRestored: number;
  staleDeleted: number;
  expired: number;
}

export async function sweepFitReports(now = Date.now()): Promise<SweepResult> {
  const iso = (ms: number) => new Date(now - ms).toISOString();
  const count = (r: { data: unknown[] | null; error: { message: string } | null }, what: string) => {
    if (r.error) throw new Error(`${what} 실패: ${r.error.message}`);
    return r.data?.length ?? 0;
  };

  const failedDeleted = count(
    await db.from("fit_reports").delete().eq("status", "failed").lt("updated_at", iso(RETRY_MARK_TTL_MS)).select("id"),
    "실패 행 삭제"
  );
  const staleRestored = count(
    await db.from("fit_reports").update({ status: "completed" }).in("status", ["queued", "processing"]).not("report", "is", null).lt("updated_at", iso(STALE_RUNNING_MS)).select("id"),
    "진행 중 행 복구"
  );
  const staleDeleted = count(
    await db.from("fit_reports").delete().in("status", ["queued", "processing"]).is("report", null).lt("updated_at", iso(STALE_RUNNING_MS)).select("id"),
    "진행 중 행 삭제"
  );
  const expired = count(
    await db.from("fit_reports").update({ status: "expired" }).eq("status", "pending_review").lt("updated_at", iso(HIL_TIMEOUT_MS)).select("id"),
    "검토 만료"
  );
  return { failedDeleted, staleRestored, staleDeleted, expired };
}

async function promoteStaleFreeJobs(): Promise<number> {
  // 오래된 순으로 앞쪽 일부만 본다 (대기열 전체를 메모리에 올리지 않는다)
  const waiting = await freeQueue.getJobs(["prioritized", "waiting"], 0, PROMOTE_SCAN - 1, true);
  const now = Date.now();
  let promoted = 0;
  for (const job of waiting) {
    if (!job || job.priority === JOB_PRIORITY.promoted) continue;
    if (now - job.timestamp >= FREE_QUEUE_PROMOTION_THRESHOLD_MS) {
      await job.changePriority({ priority: JOB_PRIORITY.promoted });
      promoted += 1;
    }
  }
  return promoted;
}

export function startMaintenanceWorker(): Worker<MaintenanceData> {
  const worker = new Worker<MaintenanceData>(
    QUEUE_NAME,
    async (job: Job<MaintenanceData>) => {
      if (job.data.kind === "promote") return { promoted: await promoteStaleFreeJobs() };
      const result = await sweepFitReports();
      if (Object.values(result).some((n) => n > 0)) console.log(`[maintenance] sweep ${JSON.stringify(result)}`);
      return result;
    },
    { connection: createRedisConnection(), concurrency: 1 }
  );
  worker.on("failed", (job, err) => {
    console.error(`[maintenance] ${job?.data.kind ?? "job"} 실패: ${err.message}`);
    Sentry.captureException(err, { tags: { worker: QUEUE_NAME, kind: job?.data.kind } });
  });
  return worker;
}

export async function startMaintenanceSchedulers(): Promise<void> {
  const q = getMaintenanceQueue();
  await q.upsertJobScheduler("fit-sweep", { every: SWEEP_EVERY_MS }, { name: "sweep", data: { kind: "sweep" } });
  await q.upsertJobScheduler("fit-promote", { every: PROMOTE_EVERY_MS }, { name: "promote", data: { kind: "promote" } });
}

import type { Request, Response } from "express";
import { QueueEvents, type Queue } from "bullmq";
import { createRedisConnection } from "./redis.js";

// 실패 사유 원문(외부 API 에러·스택)은 클라이언트에 내보내지 않는다. 사용자가 조치할 수 있는 코드만 그대로.
const PUBLIC_REASONS = new Set(["token_expired"]);
export function publicFailReason(reason: string | undefined): string {
  return reason && PUBLIC_REASONS.has(reason) ? reason : "오류가 발생했습니다. 다시 시도해 주세요.";
}

type Listener = {
  progress(data: unknown): void;
  completed(): void;
  failed(reason: string | undefined): void;
};

/**
 * 큐마다 QueueEvents(= Redis 연결) 하나를 모든 SSE 연결이 같이 쓴다.
 * 연결마다 QueueEvents 를 만들면 동시 접속 수만큼 Redis 연결이 생겨, 수천 명이 붙는 순간 Redis 연결 한도에 걸린다.
 * 이벤트는 jobId 로 찾아 해당 연결에만 전달한다 (jobId 당 O(1)).
 */
class JobEventHub {
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly events: QueueEvents;

  constructor(queueName: string) {
    this.events = new QueueEvents(queueName, { connection: createRedisConnection() });
    this.events.on("progress", ({ jobId, data }) => this.each(jobId, (l) => l.progress(data)));
    this.events.on("completed", ({ jobId }) => this.each(jobId, (l) => l.completed()));
    this.events.on("failed", ({ jobId, failedReason }) => this.each(jobId, (l) => l.failed(failedReason)));
    this.events.on("error", (err) => console.warn(`[sse] ${queueName} events: ${err.message}`));
  }

  private each(jobId: string, fn: (l: Listener) => void) {
    const set = this.listeners.get(jobId);
    if (!set) return;
    for (const l of [...set]) fn(l);
  }

  subscribe(jobId: string, listener: Listener): () => void {
    const set = this.listeners.get(jobId) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(jobId, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(jobId);
    };
  }
}

const hubs = new Map<string, JobEventHub>();
function hubFor(queueName: string): JobEventHub {
  let hub = hubs.get(queueName);
  if (!hub) {
    hub = new JobEventHub(queueName);
    hubs.set(queueName, hub);
  }
  return hub;
}

// 프록시·부하 분산기가 조용한 연결을 끊지 않게 주기적으로 주석 줄을 보낸다
const HEARTBEAT_MS = 25_000;

// jobId의 단계별 진행 상황을 SSE로 스트리밍 — fit-analysis/portfolio-chat 큐 공용
export async function streamJobEvents(req: Request, res: Response, queue: Queue, queueName: string, jobId: string): Promise<void> {
  const job = await queue.getJob(jobId);
  if (!job) {
    res.status(404).json({ error: "진행 중인 작업을 찾을 수 없습니다." });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  let closed = false;
  let unsubscribe: () => void = () => undefined;
  const heartbeat = setInterval(() => res.write(": keep-alive\n\n"), HEARTBEAT_MS);
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
    res.end();
  };

  unsubscribe = hubFor(queueName).subscribe(jobId, {
    progress: (data) => send("progress", data),
    completed: () => {
      void queue
        .getJob(jobId)
        .then((finished) => send("completed", finished?.returnvalue))
        .catch(() => send("completed", null))
        .finally(cleanup);
    },
    failed: (reason) => {
      // 재시도가 예약된 실패는 진행 중으로 알리고, 큐에서 실제로 끝난 실패만 최종 실패로 알린다
      void queue
        .getJob(jobId)
        .then(async (failedJob) => ((await failedJob?.getState()) ?? "failed") === "failed")
        .catch(() => true)
        .then((final) => {
          if (!final) return send("progress", { stage: "retrying" });
          send("failed", { reason: publicFailReason(reason) });
          cleanup();
        });
    },
  });

  req.on("close", cleanup);

  // 이미 끝난 job에 연결한 경우를 위한 초기 상태 전송
  const state = await job.getState();
  if (state === "completed") {
    send("completed", job.returnvalue);
    cleanup();
  } else if (state === "failed") {
    send("failed", { reason: publicFailReason(job.failedReason) });
    cleanup();
  } else {
    send("progress", job.progress ?? { stage: "queued" });
  }
}

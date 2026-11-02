import type { Request, Response } from "express";
import { QueueEvents, type Queue } from "bullmq";
import { createRedisConnection } from "./redis.js";

// 실패 사유 원문(외부 API 에러·스택)은 클라이언트에 내보내지 않는다. 사용자가 조치할 수 있는 코드만 그대로.
const PUBLIC_REASONS = new Set(["token_expired"]);
export function publicFailReason(reason: string | undefined): string {
  return reason && PUBLIC_REASONS.has(reason) ? reason : "처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.";
}

// jobId의 단계별 진행 상황을 SSE로 스트리밍 — fit-analysis/portfolio-chat 큐 공용
export async function streamJobEvents(req: Request, res: Response, queue: Queue, queueName: string, jobId: string): Promise<void> {
  const job = await queue.getJob(jobId);
  if (!job) {
    res.status(404).json({ error: `job을 찾을 수 없습니다: ${jobId}` });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const queueEvents = new QueueEvents(queueName, { connection: createRedisConnection() });

  queueEvents.on("progress", ({ jobId: id, data }) => {
    if (id === jobId) send("progress", data);
  });
  queueEvents.on("completed", async ({ jobId: id }) => {
    if (id !== jobId) return;
    const finished = await queue.getJob(jobId);
    send("completed", await finished?.returnvalue);
    cleanup();
  });
  queueEvents.on("failed", async ({ jobId: id, failedReason }) => {
    if (id !== jobId) return;

    // attempts(최대 3회) 내에서는 재시도가 예약되므로, 마지막 시도가 실패했을 때만 최종 실패로 처리한다.
    const failedJob = await queue.getJob(jobId);
    const attemptsMade = failedJob?.attemptsMade ?? 0;
    const maxAttempts = failedJob?.opts.attempts ?? 1;
    if (failedJob && attemptsMade < maxAttempts) {
      send("progress", { stage: "retrying", attempt: attemptsMade, maxAttempts, reason: publicFailReason(failedReason) });
      return;
    }

    send("failed", { reason: publicFailReason(failedReason) });
    cleanup();
  });

  const cleanup = () => {
    void queueEvents.close();
    res.end();
  };

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

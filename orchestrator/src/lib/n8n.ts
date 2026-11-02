import "./env.js";

interface N8nErrorPayload {
  worker: string;
  jobId: string;
  candidateId?: string;
  errorMessage: string;
  attemptsMade: number;
}

// 영구 실패(재시도 소진)한 job을 n8n Webhook(Error Trigger 역할)으로 전송 -> Slack 알림.
// N8N_ERROR_WEBHOOK_URL이 없으면 비활성화 — n8n 없이도 동작 (Sentry 패턴과 동일).
// 보류(2026-10-25): n8n 은 당분간 쓰지 않지만 코드는 남겨 둔다. docs/architecture/12_n8n_on_hold.md
export async function notifyN8nError(payload: N8nErrorPayload): Promise<void> {
  const url = process.env.N8N_ERROR_WEBHOOK_URL;
  if (!url) return;

  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.error("[n8n] 에러 알림 webhook 호출 실패:", err);
  }
}

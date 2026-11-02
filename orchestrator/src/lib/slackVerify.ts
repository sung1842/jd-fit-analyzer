import "./env.js";
import crypto from "node:crypto";

// Slack 서명 검증 (https://api.slack.com/authentication/verifying-requests-from-slack).
// 인터랙티비티 요청 본문 raw bytes에 대해 HMAC-SHA256으로 v0 서명을 재계산해 비교한다.
export interface SlackVerifyResult {
  ok: boolean;
  reason?: string;
}

export function verifySlackSignature(
  rawBody: string,
  signature: string | undefined,
  timestamp: string | undefined
): SlackVerifyResult {
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  if (!signingSecret) {
    return { ok: false, reason: "SLACK_SIGNING_SECRET이 .env.local에 설정되어 있지 않습니다." };
  }
  if (!signature || !timestamp) {
    return { ok: false, reason: "Slack 서명 헤더가 없습니다." };
  }

  // 재전송 공격 방지: 5분(300초)보다 오래된 요청은 거부
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) {
    return { ok: false, reason: "요청 타임스탬프가 유효 범위를 벗어났습니다." };
  }

  const basestring = `v0:${timestamp}:${rawBody}`;
  const expected = `v0=${crypto.createHmac("sha256", signingSecret).update(basestring).digest("hex")}`;

  const expectedBuf = Buffer.from(expected, "utf8");
  const actualBuf = Buffer.from(signature, "utf8");
  if (expectedBuf.length !== actualBuf.length || !crypto.timingSafeEqual(expectedBuf, actualBuf)) {
    return { ok: false, reason: "Slack 서명이 일치하지 않습니다." };
  }

  return { ok: true };
}

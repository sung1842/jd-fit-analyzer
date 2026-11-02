import "./env.js";
import * as Sentry from "@sentry/node";
import type { Breadcrumb, ErrorEvent } from "@sentry/node";

// orchestrator(API 서버 + BullMQ 워커)가 처리하지 않은 예외/거부를 Sentry로 전송.
// SENTRY_DSN이 없으면 비활성화 — 로컬 개발 시 Sentry 계정 없이도 동작.

/** 쿼리스트링에 실리는 비밀 파라미터 (SSE ?access_token= 등). 값만 [masked] 로 바꾼다. */
const SECRET_PARAM = /([?&;]|^)(access_token|token|apikey|api_key)=([^&#\s]*)/gi;
export const MASKED = "[masked]";
const SECRET_KEY = /^(access_token|token|apikey|api_key)$/i;

export function maskSecretParams(input: string): string {
  return input.replace(SECRET_PARAM, (_m, sep: string, key: string) => `${sep}${key}=${MASKED}`);
}

function maskValue(v: unknown): unknown {
  if (typeof v === "string") return maskSecretParams(v);
  if (Array.isArray(v)) {
    // query_string 의 [key, value] 쌍 형식
    if (v.length === 2 && typeof v[0] === "string" && SECRET_KEY.test(v[0])) return [v[0], MASKED];
    return v.map(maskValue);
  }
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      out[k] = SECRET_KEY.test(k) ? MASKED : maskValue(val);
    }
    return out;
  }
  return v;
}

export function scrubEvent<E extends ErrorEvent>(event: E): E {
  const req = event.request;
  if (req) {
    if (typeof req.url === "string") req.url = maskSecretParams(req.url);
    if (typeof req.query_string === "string") req.query_string = maskSecretParams(req.query_string);
    else if (req.query_string) req.query_string = maskValue(req.query_string) as typeof req.query_string;
  }
  if (event.breadcrumbs) event.breadcrumbs = event.breadcrumbs.map(scrubBreadcrumb);
  return event;
}

export function scrubBreadcrumb(b: Breadcrumb): Breadcrumb {
  if (b.data) b.data = maskValue(b.data) as Breadcrumb["data"];
  if (typeof b.message === "string") b.message = maskSecretParams(b.message);
  return b;
}

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV ?? "development",
    beforeSend: (event) => scrubEvent(event),
    beforeBreadcrumb: (b) => scrubBreadcrumb(b),
  });
}

export { Sentry };

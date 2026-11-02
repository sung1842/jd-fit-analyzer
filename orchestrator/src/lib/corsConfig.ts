import "./env.js";
import type { CorsOptions } from "cors";

/**
 * CORS 화이트리스트.
 *   CORS_ALLOWED_ORIGINS="https://talentfolio.example.com,https://fit.example.com"
 * 미설정 시: 개발 환경(NODE_ENV!=production)에서만 talentfolio(:3000)와 jd-fit web(:3010) 허용.
 * 프로덕션에서는 브라우저 cross-origin 요청을 전부 거부한다 (Origin 헤더 없는 서버 간 호출은 영향 없음).
 */
const DEV_DEFAULT_ORIGINS = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:3010",
  "http://127.0.0.1:3010",
];

export function resolveAllowedOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.CORS_ALLOWED_ORIGINS;
  if (raw && raw.trim()) {
    return raw
      .split(",")
      .map((s) => s.trim().replace(/\/$/, ""))
      .filter(Boolean);
  }
  return env.NODE_ENV === "production" ? [] : DEV_DEFAULT_ORIGINS;
}

export function buildCorsOptions(): CorsOptions {
  const allowed = new Set(resolveAllowedOrigins());
  if (allowed.size === 0) {
    console.warn("[cors] CORS_ALLOWED_ORIGINS 미설정 — 프로덕션에서 브라우저 cross-origin 요청이 모두 차단됩니다.");
  } else {
    console.log(`[cors] allowed origins: ${[...allowed].join(", ")}`);
  }

  return {
    origin(origin, callback) {
      // Origin 헤더가 없는 요청(서버 간 호출, curl, Slack webhook)은 CORS 대상이 아니다.
      if (!origin) return callback(null, true);
      if (allowed.has(origin)) return callback(null, true);
      return callback(null, false);
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Admin-Password"],
    credentials: false,
    maxAge: 600,
  };
}

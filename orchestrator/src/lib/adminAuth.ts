import "./env.js";
import { createHash, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";

/**
 * 크롤 검수(/crawling) 전용 비밀번호 게이트. 운영자 1인용이라 Supabase JWT 대신 .env.local 의 CRAWL_ADMIN_PASSWORD 와 비교한다.
 *   - 헤더: X-Admin-Password
 *   - 서버에 비밀번호가 없으면 503 (fail-closed) — 열린 채로 뜨지 않는다.
 *   - 실패가 IP 당 10분에 5회를 넘으면 429.
 */
export const ADMIN_PASSWORD_HEADER = "x-admin-password";

const MAX_FAILURES = 5;
const WINDOW_MS = 10 * 60 * 1000;
const failures = new Map<string, { count: number; since: number }>();

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export function passwordMatches(given: string, expected: string): boolean {
  // 길이가 달라도 같은 시간에 비교하려고 해시끼리 비교한다
  return timingSafeEqual(digest(given), digest(expected));
}

function isLocked(ip: string, now: number): boolean {
  const f = failures.get(ip);
  if (!f) return false;
  if (now - f.since > WINDOW_MS) {
    failures.delete(ip);
    return false;
  }
  return f.count >= MAX_FAILURES;
}

function recordFailure(ip: string, now: number): void {
  const f = failures.get(ip);
  if (!f || now - f.since > WINDOW_MS) failures.set(ip, { count: 1, since: now });
  else f.count += 1;
}

export function adminPasswordGate(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.method === "OPTIONS") return next();
    const expected = process.env.CRAWL_ADMIN_PASSWORD?.trim();
    if (!expected) {
      res.status(503).json({ error: "서버에 CRAWL_ADMIN_PASSWORD 가 없습니다. 레포 루트 .env.local 에 넣고 orchestrator 를 재시작하세요." });
      return;
    }
    const ip = req.ip ?? "unknown";
    const now = Date.now();
    if (isLocked(ip, now)) {
      res.status(429).json({ error: "비밀번호를 여러 번 틀렸습니다. 10분 뒤 다시 시도하세요." });
      return;
    }
    const given = req.header(ADMIN_PASSWORD_HEADER);
    if (!given || !passwordMatches(given, expected)) {
      recordFailure(ip, now);
      res.status(401).json({ error: "비밀번호가 틀렸습니다." });
      return;
    }
    failures.delete(ip);
    next();
  };
}

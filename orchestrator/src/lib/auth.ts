import "./env.js";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { createClient } from "@supabase/supabase-js";
import type { FitDbClient } from "../../../shared/lib/fitDb.js";
import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify, type JWTPayload } from "jose";

/**
 * Supabase Auth JWT 검증 미들웨어.
 *
 * - 발급자: talentfolio Supabase 프로젝트 (NEXT_PUBLIC_SUPABASE_URL)/auth/v1
 * - 비대칭 키(ES256/RS256): JWKS(/.well-known/jwks.json)로 로컬 검증 — Auth 서버 왕복 없음.
 * - 레거시 대칭 키(HS256): SUPABASE_JWT_SECRET 이 있을 때만 허용.
 * - 검증된 userId(sub)는 req.auth 에 실린다. 라우트는 body/query 의 userId 를 신뢰하지 않고 resolveUserId()를 쓴다.
 *
 * AUTH_MODE
 *   required (기본) : Bearer 토큰 없으면 401. 프로덕션 기준.
 *   legacy          : 토큰이 있으면 검증하고, 없으면 body/query userId 로 폴백 (talentfolio 가 토큰을 아직 안 보내는 전환기용).
 */
export type AccountType = "seeker" | "company";

export interface AuthUser {
  userId: string;
  email?: string;
  role?: string;
  /** app_metadata.account_type (talentfolio 가입 API 가 서비스 롤로 기록, 23 문서). 미분류면 undefined */
  accountType?: AccountType;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthUser;
      /** 검증된 원본 Bearer 토큰 — 사용자 RLS 클라이언트(createUserDbClient) 전용. 로그·응답에 쓰지 말 것 */
      authToken?: string;
    }
  }
}

export type AuthMode = "required" | "legacy";

export function getAuthMode(): AuthMode {
  return process.env.AUTH_MODE === "legacy" ? "legacy" : "required";
}

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, "");
if (!SUPABASE_URL) {
  throw new Error("NEXT_PUBLIC_SUPABASE_URL 이 없어 JWT 발급자(issuer)를 알 수 없습니다.");
}
const ISSUER = `${SUPABASE_URL}/auth/v1`;
const JWKS = createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks.json`));
const HS_SECRET = process.env.SUPABASE_JWT_SECRET ? new TextEncoder().encode(process.env.SUPABASE_JWT_SECRET) : null;

export class AuthError extends Error {
  constructor(
    message: string,
    public readonly status: 401 | 403 = 401
  ) {
    super(message);
  }
}

function toAuthUser(payload: JWTPayload): AuthUser {
  if (!payload.sub) throw new AuthError("토큰에 sub 가 없습니다.");
  return {
    userId: payload.sub,
    email: typeof payload.email === "string" ? payload.email : undefined,
    role: typeof payload.role === "string" ? payload.role : undefined,
    accountType: accountTypeOf(payload),
  };
}

function accountTypeOf(payload: JWTPayload): AccountType | undefined {
  const v = (payload.app_metadata as { account_type?: unknown } | undefined)?.account_type;
  return v === "seeker" || v === "company" ? v : undefined;
}

export async function verifySupabaseJwt(token: string): Promise<AuthUser> {
  let alg: string | undefined;
  try {
    alg = decodeProtectedHeader(token).alg;
  } catch {
    throw new AuthError("JWT 형식이 아닙니다.");
  }

  const options = { issuer: ISSUER, audience: "authenticated" } as const;

  try {
    if (alg === "HS256") {
      if (!HS_SECRET) {
        throw new AuthError("HS256 토큰이지만 SUPABASE_JWT_SECRET 이 설정되지 않았습니다. 프로젝트를 비대칭 키(ES256)로 전환하거나 secret 을 설정하세요.");
      }
      const { payload } = await jwtVerify(token, HS_SECRET, { ...options, algorithms: ["HS256"] });
      return toAuthUser(payload);
    }
    const { payload } = await jwtVerify(token, JWKS, { ...options, algorithms: ["ES256", "RS256"] });
    return toAuthUser(payload);
  } catch (err) {
    if (err instanceof AuthError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new AuthError(`토큰 검증 실패: ${message}`);
  }
}

function extractToken(req: Request, allowQuery: boolean): string | null {
  const header = req.header("authorization");
  if (header) {
    const [scheme, value] = header.split(" ");
    if (scheme?.toLowerCase() === "bearer" && value) return value.trim();
    return null;
  }
  if (allowQuery) {
    const q = req.query.access_token;
    if (typeof q === "string" && q) return q;
  }
  return null;
}

export interface AuthGateOptions {
  /** 인증을 전혀 요구하지 않는 경로 (Slack 서명 검증 라우트, OAuth 콜백, 공개 brief 등) */
  publicPaths: RegExp[];
  /** EventSource / 브라우저 네비게이션처럼 헤더를 못 싣는 경로 — ?access_token= 허용 */
  queryTokenPaths: RegExp[];
}

export function authGate(opts: AuthGateOptions): RequestHandler {
  const mode = getAuthMode();
  if (mode === "legacy") {
    console.warn("[auth] AUTH_MODE=legacy — Bearer 토큰이 없는 요청은 body/query userId 를 그대로 신뢰합니다. 프로덕션 금지.");
  }

  return async (req: Request, res: Response, next: NextFunction) => {
    if (req.method === "OPTIONS") return next();
    if (opts.publicPaths.some((re) => re.test(req.path))) return next();

    const allowQuery = opts.queryTokenPaths.some((re) => re.test(req.path));
    const token = extractToken(req, allowQuery);

    if (!token) {
      if (mode === "legacy") return next();
      res.status(401).json({ error: "인증이 필요합니다. Authorization: Bearer <Supabase access token>" });
      return;
    }

    try {
      req.auth = await verifySupabaseJwt(token);
      req.authToken = token;
      next();
    } catch (err) {
      const status = err instanceof AuthError ? err.status : 401;
      res.status(status).json({ error: err instanceof Error ? err.message : "인증 실패" });
    }
  };
}

/**
 * 라우트에서 사용할 userId. 검증된 토큰이 있으면 무조건 그것. 없으면(legacy 모드에서만 도달) 클라이언트 값 폴백.
 */
export function resolveUserId(req: Request, fallback?: string | null): string | undefined {
  if (req.auth) return req.auth.userId;
  if (getAuthMode() === "legacy" && fallback && fallback.trim()) return fallback.trim();
  return undefined;
}

/**
 * 소유권 검사 — 토큰 사용자가 있고 리소스 소유자와 다르면 false. legacy 모드에서 토큰이 없으면 true.
 * (Express 4 는 async 핸들러의 throw 를 에러 미들웨어로 넘기지 않으므로 boolean 으로 돌려 라우트에서 403 을 직접 응답한다.)
 */
export function isOwner(req: Request, ownerUserId: string | null | undefined): boolean {
  if (!req.auth) return true;
  // 소유자 없는 행(legacy 시절 생성)은 토큰 사용자 누구의 것도 아니다 — 통과시키지 않는다
  if (!ownerUserId) return false;
  return ownerUserId === req.auth.userId;
}

export const FORBIDDEN = { error: "이 리소스에 대한 권한이 없습니다." } as const;

/**
 * 라이프 로그(life_*·activities·evidence_cards·user_memory·consents) 전용: 사용자 토큰으로 RLS 가 적용되는 클라이언트.
 * service_role 로 이 테이블들을 조회하지 않는다 (18 문서 A절). anon key + Authorization 헤더 → auth.uid() = 토큰 sub.
 */
export function createUserDbClient(accessToken: string): FitDbClient {
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!anonKey) throw new Error("NEXT_PUBLIC_SUPABASE_ANON_KEY 가 없어 사용자 RLS 클라이언트를 만들 수 없습니다.");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client: any = createClient(SUPABASE_URL!, anonKey, {
    db: { schema: process.env.FIT_DB_SCHEMA || "fit" },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return client as FitDbClient;
}

/** 라이프 로그 라우트용: legacy 폴백 없이 검증된 토큰이 있어야 한다. 없으면 401 응답 후 null. */
export function requireUserToken(req: Request, res: Response): { userId: string; token: string } | null {
  if (!req.auth || !req.authToken) {
    res.status(401).json({ error: "인증이 필요합니다. Authorization: Bearer <Supabase access token>" });
    return null;
  }
  return { userId: req.auth.userId, token: req.authToken };
}

/**
 * 계정 유형 가드 (23 문서 G1). authGate 뒤에 둔다.
 * 경로가 한쪽 유형 전용이면 토큰의 account_type 이 맞아야 통과. 공개 경로(토큰 없음)는 authGate 가 이미 걸렀다.
 */
export function accountGate(rules: { company: RegExp[]; seeker: RegExp[]; publicPaths: RegExp[] }): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.method === "OPTIONS" || rules.publicPaths.some((re) => re.test(req.path))) return next();
    const need: AccountType | null = rules.company.some((re) => re.test(req.path))
      ? "company"
      : rules.seeker.some((re) => re.test(req.path)) ? "seeker" : null;
    if (!need) return next();
    if (!req.auth) {
      res.status(401).json({ error: "인증이 필요합니다." });
      return;
    }
    if (req.auth.accountType !== need) {
      res.status(403).json({ error: need === "company" ? "기업 계정만 쓸 수 있습니다." : "구직자 계정만 쓸 수 있습니다." });
      return;
    }
    next();
  };
}

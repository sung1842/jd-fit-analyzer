import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * jd-fit-analyzer 운영 데이터(fit_reports, sourcing_actions, job_postings ...) 접근 클라이언트.
 *
 * Single DB 전략(010_single_db_fit_schema.sql): talentfolio Supabase 프로젝트의 `fit` 스키마를 사용한다.
 *   - URL: NEXT_PUBLIC_SUPABASE_URL (talentfolio 와 동일 프로젝트)
 *   - KEY: SUPABASE_SERVICE_ROLE_KEY (서버 전용. RLS 우회 — HTTP 라우트는 JWT userId 로 소유권을 직접 검사한다)
 *   - SCHEMA: FIT_DB_SCHEMA (기본 "fit")
 *
 * 이전 완료 전까지는 구 분리 DB(FIT_ANALYZER_SUPABASE_URL + FIT_ANALYZER_SUPABASE_SERVICE_ROLE_KEY, public 스키마)로
 * 폴백한다. 두 설정이 모두 있으면 신규(single DB)가 우선한다.
 */
export interface FitDbConfig {
  url: string;
  serviceRoleKey: string;
  schema: string;
  mode: "single" | "legacy";
}

export function resolveFitDbConfig(env: NodeJS.ProcessEnv = process.env): FitDbConfig {
  const singleUrl = env.NEXT_PUBLIC_SUPABASE_URL;
  const singleKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (singleUrl && singleKey) {
    return { url: singleUrl, serviceRoleKey: singleKey, schema: env.FIT_DB_SCHEMA || "fit", mode: "single" };
  }

  const legacyUrl = env.FIT_ANALYZER_SUPABASE_URL;
  const legacyKey = env.FIT_ANALYZER_SUPABASE_SERVICE_ROLE_KEY;
  if (legacyUrl && legacyKey) {
    return { url: legacyUrl, serviceRoleKey: legacyKey, schema: "public", mode: "legacy" };
  }

  throw new Error(
    "fit DB 설정이 없습니다. NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (single DB, 권장) " +
      "또는 FIT_ANALYZER_SUPABASE_URL + FIT_ANALYZER_SUPABASE_SERVICE_ROLE_KEY (legacy) 를 .env.local 에 설정하세요."
  );
}

// 스키마 이름이 런타임 값이라 SupabaseClient 의 SchemaName 제네릭을 좁힐 수 없다 → any 스키마로 선언.
// 호출부는 테이블명 문자열로 접근하므로 타입 안전성 손실은 없다 (기존에도 Database 타입 미사용).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type FitDbClient = SupabaseClient<any, any, any, any, any>;

export function createFitDbClient(label: string): FitDbClient {
  const cfg = resolveFitDbConfig();
  if (cfg.mode === "legacy") {
    console.warn(
      `[${label}] fit DB: legacy 분리 DB 모드 (public 스키마). 010_single_db_fit_schema.sql 적용 후 ` +
        "SUPABASE_SERVICE_ROLE_KEY 로 전환하세요."
    );
  } else {
    console.log(`[${label}] fit DB: single DB 모드 (schema=${cfg.schema})`);
  }
  return createClient(cfg.url, cfg.serviceRoleKey, {
    db: { schema: cfg.schema },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

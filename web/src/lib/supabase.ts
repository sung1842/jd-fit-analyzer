"use client";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// talentfolio 와 같은 Supabase 프로젝트. 이 클라이언트는 **Auth 전용**이다.
// 데이터 접근은 전부 orchestrator API(JWT 검증) 를 거친다 — 브라우저에서 fit.* 테이블을 직접 읽지 않는다.
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export const supabaseConfigured = Boolean(url && anonKey);

let client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (!url || !anonKey) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY 가 web/.env.local 에 없습니다.");
  }
  if (!client) client = createClient(url, anonKey);
  return client;
}

/** 현재 세션의 access token. 만료 임박 시 supabase-js 가 자동 갱신한다. */
export async function getAccessToken(): Promise<string | null> {
  if (!supabaseConfigured) return null;
  const { data } = await getSupabase().auth.getSession();
  return data.session?.access_token ?? null;
}

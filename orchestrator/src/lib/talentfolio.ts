import "./env.js";
import { createClient } from "@supabase/supabase-js";
import { companyUserIds } from "../../../shared/lib/companyAccounts.js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  throw new Error("NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY가 .env.local에 설정되어 있지 않습니다.");
}

// talentfolio profiles 테이블 읽기 전용 연결 (RLS: 모든 유저 SELECT 허용)
export const talentfolio = createClient(url, anonKey);

export interface CandidateSummary {
  id: string;
  name: string;
  role: "developer" | "designer";
  title: string | null;
}

// 후보자 멀티선택 목록용 — 가벼운 요약 정보만 조회 (절대 규칙 3: prune & 정규화)
export async function listCandidates(): Promise<CandidateSummary[]> {
  // 공개 프로필만, 기업 계정 제외 (23 문서 G3)
  const [{ data, error }, companies] = await Promise.all([
    talentfolio.from("profiles").select("id, name, role, title").eq("is_public", true),
    companyUserIds(),
  ]);
  if (error) throw new Error(`후보자 목록 조회 실패: ${error.message}`);
  return ((data ?? []) as CandidateSummary[]).filter((c) => !companies.has(c.id));
}

import "./env.js";
import { createClient } from "@supabase/supabase-js";

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
  const { data, error } = await talentfolio.from("profiles").select("id, name, role, title");
  if (error) throw new Error(`후보자 목록 조회 실패: ${error.message}`);
  return (data ?? []) as CandidateSummary[];
}

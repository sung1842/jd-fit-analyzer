import type { CandidateSourcingSummary } from "../../../shared/types.js";
import { fetchExcludedUserIds } from "../lib/evidenceCards.js";
import { supabase } from "../lib/supabase.js";
import { db } from "../lib/db.js"; // fit 스키마(public_evidence_cards 뷰·match_exclusions)는 db 로

// Phase 5 B2B 소싱: 인재 DB(talentfolio profiles)에서 이름/직함/기술 스택으로 후보자를 검색한다 (LLM 호출 없음).
// 절대 규칙 3: raw row를 그대로 넘기지 않고 가벼운 요약(CandidateSourcingSummary)만 반환한다.
export async function searchCandidates(query?: string, role?: "developer" | "designer", jobPostingId?: string): Promise<CandidateSourcingSummary[]> {
  let select = supabase.from("profiles").select("id, name, role, title, skills");
  if (role) select = select.eq("role", role);

  const { data, error } = await select;
  if (error) throw new Error(`후보자 검색 실패: ${error.message}`);

  // match_exclusions(job_posting_id null = 전체) 후보 제외. 테이블 미적용이면 무시.
  const excluded = await fetchExcludedUserIds(db, jobPostingId);
  const rows = ((data ?? []) as CandidateSourcingSummary[]).filter((row) => !excluded.has(row.id));
  if (!query) return rows;

  const keyword = query.toLowerCase();
  return rows.filter((row) => {
    const haystack = [row.name, row.title ?? "", ...(row.skills ?? [])].join("\n").toLowerCase();
    return haystack.includes(keyword);
  });
}

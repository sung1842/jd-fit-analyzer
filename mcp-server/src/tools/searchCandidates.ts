import type { CandidateSourcingSummary } from "../../../shared/types.js";
import { fetchExcludedUserIds } from "../lib/evidenceCards.js";
import { supabase } from "../lib/supabase.js";
import { db } from "../lib/db.js";
import { companyUserIds } from "../../../shared/lib/companyAccounts.js"; // fit 스키마(public_evidence_cards 뷰·match_exclusions)는 db 로
import { buildSkillDictionary, cleanSkill, type SkillDictionary } from "../../../shared/lib/skillDictionary.js";
import type { SkillEntry } from "../../../shared/lib/skillSeed.js";

// 검색어 통일용 기술 사전 (orchestrator 매칭과 같은 사전, fit.skill_dictionary 병합). 10분 캐시, 실패하면 코드 시드만
const DICT_TTL_MS = 10 * 60 * 1000;
let dictCache: { dict: SkillDictionary; at: number } | null = null;
async function skillDictionary(): Promise<SkillDictionary> {
  if (dictCache && Date.now() - dictCache.at < DICT_TTL_MS) return dictCache.dict;
  let rows: SkillEntry[] = [];
  try {
    const { data, error } = await db.from("skill_dictionary").select("canonical, aliases, category, parent");
    if (!error && data) rows = data as SkillEntry[];
  } catch {
    // 시드로 계속
  }
  dictCache = { dict: buildSkillDictionary(rows), at: Date.now() };
  return dictCache.dict;
}

// Phase 5 B2B 소싱: 인재 DB(talentfolio profiles)에서 이름/직함/기술 스택으로 후보자를 검색한다 (LLM 호출 없음).
// 절대 규칙 3: raw row를 그대로 넘기지 않고 가벼운 요약(CandidateSourcingSummary)만 반환한다.
export async function searchCandidates(query?: string, role?: "developer" | "designer", jobPostingId?: string): Promise<CandidateSourcingSummary[]> {
  // 공개 프로필만, 기업 계정 제외 (23 문서 G3)
  let select = supabase.from("profiles").select("id, name, role, title, skills").eq("is_public", true);
  if (role) select = select.eq("role", role);

  const { data, error } = await select;
  if (error) throw new Error(`후보자 검색 실패: ${error.message}`);

  // match_exclusions(job_posting_id null = 전체) 후보 제외. 테이블 미적용이면 무시.
  const [excluded, companies] = await Promise.all([fetchExcludedUserIds(db, jobPostingId), companyUserIds()]);
  const rows = ((data ?? []) as CandidateSourcingSummary[]).filter((row) => !excluded.has(row.id) && !companies.has(row.id));
  if (!query) return rows;

  // 검색어를 사전의 표준 이름(영문)으로 통일: "쿠버네티스"·"k8s" → Kubernetes.
  // 기술은 표준 이름이 같거나 하위 기술(Next.js → React)이면 일치, 이름·직함은 원문·표준 이름 부분 일치.
  const dict = await skillDictionary();
  const keyword = cleanSkill(query);
  const canonical = dict.canonical(query);
  // 사전에 있는 기술이면 기술 칸은 표준 이름으로만 비교한다 (부분 문자열이면 Java 검색에 JavaScript 가 걸린다)
  if (canonical) {
    const key = cleanSkill(canonical);
    return rows.filter(
      (row) => dict.matchKeys(row.skills ?? []).includes(key) || cleanSkill(`${row.name}\n${row.title ?? ""}`).includes(keyword),
    );
  }
  return rows.filter((row) => cleanSkill([row.name, row.title ?? "", ...(row.skills ?? [])].join("\n")).includes(keyword));
}

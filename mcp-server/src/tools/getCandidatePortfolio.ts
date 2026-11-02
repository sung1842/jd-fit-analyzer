import { pruneJsonData } from "../../../shared/lib/pruneJsonData.js";
import type { CandidatePortfolio } from "../../../shared/types.js";
import { PORTFOLIO_KEY_DICTIONARY } from "../lib/keyDictionary.js";
import { fetchPublicEvidenceCards } from "../lib/evidenceCards.js";
import { fetchPublicResume } from "../lib/publicResume.js";
import { supabase } from "../lib/supabase.js";
import { db } from "../lib/db.js"; // fit 스키마(public_evidence_cards 뷰·match_exclusions)는 db 로

const PORTFOLIO_ALLOWED_KEYS: (keyof CandidatePortfolio)[] = [
  "id",
  "name",
  "role",
  "title",
  "short_bio",
  "long_bio",
  "skills",
  "github_url",
  "portfolio_url",
];

export async function getCandidatePortfolio(candidateId: string): Promise<CandidatePortfolio> {
  const { data, error } = await supabase.from("profiles").select("*").eq("id", candidateId).single();

  if (error || !data) {
    throw new Error(`후보자를 찾을 수 없습니다: ${candidateId} (${error?.message ?? "no data"})`);
  }

  const pruned = pruneJsonData<CandidatePortfolio>(data, PORTFOLIO_ALLOWED_KEYS, PORTFOLIO_KEY_DICTIONARY);

  for (const key of PORTFOLIO_ALLOWED_KEYS) {
    if (pruned[key] === undefined) {
      throw new Error(`portfolio 필드 누락: ${key}`);
    }
  }

  // 공개 카드 뷰만 조회 (뷰 미적용이면 빈 배열). profiles prune 경로는 그대로.
  // 공개 이력서·기본 자기소개서도 공개 뷰만 (매칭 동의 + 공개 항목). 없으면 필드 생략
  const [evidence_cards, resume] = await Promise.all([fetchPublicEvidenceCards(db, candidateId), fetchPublicResume(db, candidateId)]);
  return { ...(pruned as CandidatePortfolio), evidence_cards, ...(resume && { resume }) };
}

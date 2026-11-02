import type { AgentResult, CandidatePortfolio, PreCheckResult } from "../../shared/types.js";
import { AgentResultSchema } from "./lib/schemas.js";

function isObviousHallucination(result: AgentResult, portfolio: CandidatePortfolio): boolean {
  const haystack = [portfolio.title, portfolio.short_bio, portfolio.long_bio, ...portfolio.skills]
    .filter((v): v is string => !!v)
    .join("\n")
    .toLowerCase();

  return result.evidence.some((item) => !haystack.includes(item.toLowerCase()));
}

function isObviousScoreContradiction(result: AgentResult): boolean {
  return result.score >= 70 && result.missing_items.length > result.matched_items.length;
}

/**
 * 인용 카드 검증 (19 문서 6절): citedCardIds ⊆ 해당 후보에게 제공된 공개 카드 id.
 * 위반 id 는 즉시 제거(citedCards 도 재구성)하고 위반 목록을 돌려준다 → 호출측이 issue 로 올려 기존 재작업 1회 루프에 태운다.
 * 재작업 결과도 다시 이 함수를 거치므로, 재작업 후에도 위반이면 해당 id 는 최종 리포트에서 폐기된다.
 */
export function enforceCitedCards(result: AgentResult, portfolio: CandidatePortfolio): string[] {
  const cards = portfolio.evidence_cards ?? [];
  const trustById = new Map(cards.map((c) => [c.id, c.trust]));
  const cited = result.citedCardIds ?? [];
  const invalid = cited.filter((id) => !trustById.has(id));
  const valid = [...new Set(cited.filter((id) => trustById.has(id)))];
  if (result.citedCardIds !== undefined || invalid.length > 0) {
    result.citedCardIds = valid;
    result.citedCards = valid.map((id) => ({ id, trust: trustById.get(id)! }));
  }
  return invalid;
}

function validateOne(result: AgentResult | null, portfolio: CandidatePortfolio, issues: string[], label: string): boolean {
  if (!result) {
    issues.push(`${label}: 결과 없음`);
    return false;
  }

  const formatCheck = AgentResultSchema.safeParse(result);
  if (!formatCheck.success) {
    issues.push(`${label}: AgentResult 포맷 불일치 (${formatCheck.error.issues.map((i) => i.path.join(".")).join(", ")})`);
    return false;
  }

  const invalidCards = enforceCitedCards(result, portfolio);
  if (invalidCards.length > 0) {
    issues.push(`${label}: citedCardIds 중 제공되지 않은 카드 id 인용 (${invalidCards.join(", ")}) — 제공된 EvidenceCards id 만 인용할 것`);
    return false;
  }

  if (isObviousScoreContradiction(result)) {
    issues.push(`${label}: score(${result.score})가 높은데 missing_items(${result.missing_items.length})가 matched_items(${result.matched_items.length})보다 많음`);
    return false;
  }

  if (isObviousHallucination(result, portfolio)) {
    issues.push(`${label}: evidence 중 portfolio에 존재하지 않는 항목 발견`);
    return false;
  }

  return true;
}

export function runRuleBasedValidation(params: {
  techResult: AgentResult | null;
  expResult: AgentResult | null;
  cultureResult: AgentResult | null;
  portfolio: CandidatePortfolio;
}): PreCheckResult {
  const issues: string[] = [];
  const techValid = validateOne(params.techResult, params.portfolio, issues, "tech_stack");
  const expValid = validateOne(params.expResult, params.portfolio, issues, "experience");
  const cultureValid = validateOne(params.cultureResult, params.portfolio, issues, "culture_fit");

  return { techValid, expValid, cultureValid, issues };
}

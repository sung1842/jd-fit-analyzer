import { pruneJsonData } from "../../../shared/lib/pruneJsonData.js";
import type { AgentResult, CandidatePortfolio, ReworkContext } from "../../../shared/types.js";
import { generateStructured } from "../lib/gemini.js";
import { buildEvidenceCardPrompt, CITED_CARD_IDS_SCHEMA, toCitations } from "../lib/evidenceCards.js";
import { AGENT_RESULT_KEY_DICTIONARY } from "../lib/keyDictionary.js";

const cultureAgentSchema = {
  type: "OBJECT",
  properties: {
    culture_score: { type: "INTEGER", description: "0~100 사이의 컬처핏(조직문화/협업 방식) 적합도 점수" },
    matched_values: {
      type: "ARRAY",
      items: { type: "STRING" },
      description: "JD가 요구하는 조직문화/협업 방식 중 포트폴리오(short_bio, long_bio)에서 충족이 확인된 항목",
    },
    missing_values: {
      type: "ARRAY",
      items: { type: "STRING" },
      description: "JD에는 있으나 포트폴리오에서 확인되지 않는 조직문화/협업 방식 항목",
    },
    evidence: {
      type: "ARRAY",
      items: { type: "STRING" },
      description: "판단 근거가 된 포트폴리오 항목 (short_bio/long_bio/title에 실제 등장하는 문구)",
    },
    citedCardIds: CITED_CARD_IDS_SCHEMA,
    analysis_reason: { type: "STRING", description: "1-2문장 컬처핏 적합도 평가 요약" },
  },
  required: ["culture_score", "matched_values", "missing_values", "evidence", "analysis_reason", "citedCardIds"],
};

const AGENT_RESULT_ALLOWED_KEYS: (keyof AgentResult)[] = ["score", "summary", "matched_items", "missing_items"];

function filterEvidence(evidence: string[], portfolio: CandidatePortfolio): string[] {
  const haystack = [portfolio.title, portfolio.short_bio, portfolio.long_bio, ...portfolio.skills]
    .filter((v): v is string => !!v)
    .join("\n")
    .toLowerCase();

  return evidence.filter((item) => haystack.includes(item.toLowerCase()));
}

export async function analyzeCultureFit(
  jd: string,
  portfolio: CandidatePortfolio,
  rework?: ReworkContext
): Promise<AgentResult> {
  const reworkSection = rework
    ? `\n[이전 평가]: ${JSON.stringify(rework.previousResult)}\n[CEO 피드백]: ${rework.feedback}\n위 피드백을 반영해 재평가하라.`
    : "";

  const { evidence_cards: cards, ...profile } = portfolio;
  const prompt = `[JD]: ${jd}\n[Portfolio]: ${JSON.stringify(profile)}${buildEvidenceCardPrompt(cards)}${reworkSection}\nJD에 드러난 조직문화/협업 방식(예: 협업 스타일, 커뮤니케이션, 자기주도성, 성장 마인드셋 등) 요구사항과 포트폴리오의 short_bio/long_bio에 드러난 태도·경험을 비교해 컬처핏 적합도만 분석해. matched_values, missing_values, analysis_reason을 포함한 모든 출력 필드는 반드시 한국어로 작성해.`;

  const raw = await generateStructured<Record<string, unknown>>(prompt, cultureAgentSchema, "analyze-culture-fit");
  const pruned = pruneJsonData<AgentResult>(raw, AGENT_RESULT_ALLOWED_KEYS, AGENT_RESULT_KEY_DICTIONARY);

  for (const key of AGENT_RESULT_ALLOWED_KEYS) {
    if (pruned[key] === undefined) {
      throw new Error(`analyze_culture_fit 응답에 필드 누락: ${key}`);
    }
  }

  const rawEvidence = Array.isArray(raw.evidence) ? (raw.evidence as string[]) : [];

  return {
    agent: "culture_fit",
    score: pruned.score!,
    summary: pruned.summary!,
    matched_items: pruned.matched_items!,
    missing_items: pruned.missing_items!,
    evidence: filterEvidence(rawEvidence, portfolio),
    ...toCitations(raw.citedCardIds, cards),
  };
}

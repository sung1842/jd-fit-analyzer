import { pruneJsonData } from "../../../shared/lib/pruneJsonData.js";
import type { AgentResult, CandidatePortfolio, ReworkContext } from "../../../shared/types.js";
import { generateStructured } from "../lib/gemini.js";
import { buildEvidenceCardPrompt, CITED_CARD_IDS_SCHEMA, toCitations } from "../lib/evidenceCards.js";
import { AGENT_RESULT_KEY_DICTIONARY } from "../lib/keyDictionary.js";

const expAgentSchema = {
  type: "OBJECT",
  properties: {
    exp_score: { type: "INTEGER", description: "0~100 사이의 경험/트러블슈팅 적합도 점수" },
    matched_experiences: {
      type: "ARRAY",
      items: { type: "STRING" },
      description: "JD가 요구하는 직무 경험/트러블슈팅 중 포트폴리오(long_bio)에서 충족이 확인된 항목",
    },
    missing_experiences: {
      type: "ARRAY",
      items: { type: "STRING" },
      description: "JD에는 있으나 포트폴리오에서 확인되지 않는 경험/트러블슈팅 항목",
    },
    evidence: {
      type: "ARRAY",
      items: { type: "STRING" },
      description: "판단 근거가 된 포트폴리오 항목 (long_bio/short_bio/title에 실제 등장하는 문구)",
    },
    citedCardIds: CITED_CARD_IDS_SCHEMA,
    analysis_reason: { type: "STRING", description: "1-2문장 경험/트러블슈팅 적합도 평가 요약" },
  },
  required: ["exp_score", "matched_experiences", "missing_experiences", "evidence", "analysis_reason", "citedCardIds"],
};

const AGENT_RESULT_ALLOWED_KEYS: (keyof AgentResult)[] = ["score", "summary", "matched_items", "missing_items"];

function filterEvidence(evidence: string[], portfolio: CandidatePortfolio): string[] {
  const haystack = [portfolio.title, portfolio.short_bio, portfolio.long_bio, ...portfolio.skills]
    .filter((v): v is string => !!v)
    .join("\n")
    .toLowerCase();

  return evidence.filter((item) => haystack.includes(item.toLowerCase()));
}

export async function analyzeExperience(
  jd: string,
  portfolio: CandidatePortfolio,
  rework?: ReworkContext
): Promise<AgentResult> {
  const reworkSection = rework
    ? `\n[이전 평가]: ${JSON.stringify(rework.previousResult)}\n[CEO 피드백]: ${rework.feedback}\n위 피드백을 반영해 재평가하라.`
    : "";

  const { evidence_cards: cards, ...profile } = portfolio;
  const prompt = `[JD]: ${jd}\n[Portfolio]: ${JSON.stringify(profile)}${buildEvidenceCardPrompt(cards)}${reworkSection}\nJD의 직무 경험/트러블슈팅 요구사항과 포트폴리오의 long_bio/프로젝트 설명과 resume(공개 경력·학력·자격·기본 자기소개서, 있을 때만)를 비교해 경험 적합도만 분석해. matched_experiences, missing_experiences, analysis_reason을 포함한 모든 출력 필드는 반드시 한국어로 작성해.`;

  const raw = await generateStructured<Record<string, unknown>>(prompt, expAgentSchema, "analyze-experience");
  const pruned = pruneJsonData<AgentResult>(raw, AGENT_RESULT_ALLOWED_KEYS, AGENT_RESULT_KEY_DICTIONARY);

  for (const key of AGENT_RESULT_ALLOWED_KEYS) {
    if (pruned[key] === undefined) {
      throw new Error(`analyze_experience 응답에 필드 누락: ${key}`);
    }
  }

  const rawEvidence = Array.isArray(raw.evidence) ? (raw.evidence as string[]) : [];

  return {
    agent: "experience",
    score: pruned.score!,
    summary: pruned.summary!,
    matched_items: pruned.matched_items!,
    missing_items: pruned.missing_items!,
    evidence: filterEvidence(rawEvidence, portfolio),
    ...toCitations(raw.citedCardIds, cards),
  };
}

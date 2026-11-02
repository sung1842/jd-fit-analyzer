import { pruneJsonData } from "../../../shared/lib/pruneJsonData.js";
import type { AgentResult, CandidatePortfolio, ReworkContext } from "../../../shared/types.js";
import { generateStructured } from "../lib/gemini.js";
import { AGENT_RESULT_KEY_DICTIONARY } from "../lib/keyDictionary.js";

const techAgentSchema = {
  type: "OBJECT",
  properties: {
    tech_score: { type: "INTEGER", description: "0~100 사이의 기술 스택 일치도 점수" },
    matched_stacks: {
      type: "ARRAY",
      items: { type: "STRING" },
      description: "JD 요구사항 중 포트폴리오(skills, long_bio)에서 충족이 확인된 기술",
    },
    missing_stacks: {
      type: "ARRAY",
      items: { type: "STRING" },
      description: "JD에는 있으나 포트폴리오에서 확인되지 않는 기술",
    },
    evidence: {
      type: "ARRAY",
      items: { type: "STRING" },
      description: "판단 근거가 된 포트폴리오 항목 (skills/long_bio/short_bio/title에 실제 등장하는 문구)",
    },
    analysis_reason: { type: "STRING", description: "1-2문장 기술 스택 적합도 평가 요약" },
  },
  required: ["tech_score", "matched_stacks", "missing_stacks", "evidence", "analysis_reason"],
};

const AGENT_RESULT_ALLOWED_KEYS: (keyof AgentResult)[] = ["score", "summary", "matched_items", "missing_items"];

function filterEvidence(evidence: string[], portfolio: CandidatePortfolio): string[] {
  const haystack = [portfolio.title, portfolio.short_bio, portfolio.long_bio, ...portfolio.skills]
    .filter((v): v is string => !!v)
    .join("\n")
    .toLowerCase();

  return evidence.filter((item) => haystack.includes(item.toLowerCase()));
}

export async function analyzeTechStack(
  jd: string,
  portfolio: CandidatePortfolio,
  rework?: ReworkContext
): Promise<AgentResult> {
  const reworkSection = rework
    ? `\n[이전 평가]: ${JSON.stringify(rework.previousResult)}\n[CEO 피드백]: ${rework.feedback}\n위 피드백을 반영해 재평가하라.`
    : "";

  const prompt = `[JD]: ${jd}\n[Portfolio]: ${JSON.stringify(portfolio)}${reworkSection}\nJD에서 요구하는 기술 스택을 추출하고 포트폴리오의 skills/long_bio와 비교해 기술 스택 적합도만 분석해. matched_stacks, missing_stacks, analysis_reason을 포함한 모든 출력 필드는 반드시 한국어로 작성해.`;

  const raw = await generateStructured<Record<string, unknown>>(prompt, techAgentSchema, "analyze-tech-stack");
  const pruned = pruneJsonData<AgentResult>(raw, AGENT_RESULT_ALLOWED_KEYS, AGENT_RESULT_KEY_DICTIONARY);

  for (const key of AGENT_RESULT_ALLOWED_KEYS) {
    if (pruned[key] === undefined) {
      throw new Error(`analyze_tech_stack 응답에 필드 누락: ${key}`);
    }
  }

  const rawEvidence = Array.isArray(raw.evidence) ? (raw.evidence as string[]) : [];

  return {
    agent: "tech_stack",
    score: pruned.score!,
    summary: pruned.summary!,
    matched_items: pruned.matched_items!,
    missing_items: pruned.missing_items!,
    evidence: filterEvidence(rawEvidence, portfolio),
  };
}

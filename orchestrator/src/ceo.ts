import "./lib/env.js";
import Anthropic from "@anthropic-ai/sdk";
import { startObservation } from "@langfuse/tracing";
import type { AgentResult, CeoDecision, PreCheckResult } from "../../shared/types.js";

const anthropic = new Anthropic();

const CEO_MODEL = "claude-sonnet-4-6"; // CEO 종합 판단은 Claude Sonnet (모델 계층화 정책)

const ceoDecisionTool: Anthropic.Tool = {
  name: "submit_ceo_decision",
  description: "기술/경험 분석 결과를 교차 검증한 최종 판단을 제출한다.",
  input_schema: {
    type: "object",
    properties: {
      is_valid: { type: "boolean" },
      target_departments: {
        type: "array",
        items: { type: "string", enum: ["TECH", "EXP", "CULTURE"] },
        description: "재작업이 필요한 부서 목록 (복수 가능). is_valid=true면 빈 배열.",
      },
      rejection_reason: {
        type: "string",
        description: "is_valid=false일 때 재작업 사유. 아니면 빈 문자열.",
      },
      final_report: {
        type: "object",
        properties: {
          overallScore: { type: "integer" },
          verdict: { type: "string", enum: ["strong_fit", "possible_fit", "weak_fit"] },
          ceoSummary: { type: "string" },
        },
        required: ["overallScore", "verdict", "ceoSummary"],
      },
    },
    required: ["is_valid", "target_departments", "rejection_reason", "final_report"],
  },
};

// 무료 테스트용: CEO_MOCK=true면 Anthropic API를 호출하지 않고 가중 평균으로 결과를 합성한다.
function mockCeoDecision(params: {
  techResult: AgentResult;
  expResult: AgentResult;
  cultureResult: AgentResult;
  preCheck: PreCheckResult;
}): CeoDecision {
  const overallScore = Math.round(
    params.techResult.score * 0.5 + params.expResult.score * 0.3 + params.cultureResult.score * 0.2
  );
  const verdict = overallScore >= 75 ? "strong_fit" : overallScore >= 45 ? "possible_fit" : "weak_fit";

  return {
    is_valid: true,
    target_departments: [],
    rejection_reason: "",
    final_report: {
      overallScore,
      verdict,
      ceoSummary: "[CEO_MOCK] Anthropic API 미호출 — tech 0.5 / exp 0.3 / culture 0.2 가중 평균으로 산정한 임시 결과입니다.",
    },
  };
}

export async function evaluateAsCeo(params: {
  jd: string;
  techResult: AgentResult;
  expResult: AgentResult;
  cultureResult: AgentResult;
  preCheck: PreCheckResult;
}): Promise<CeoDecision> {
  if (process.env.CEO_MOCK === "true") {
    return mockCeoDecision(params);
  }

  const input = [
    "JD, 세 분석 결과(AgentResult: tech_stack, experience, culture_fit), 1차 검증 결과(PreCheckResult)를 교차 검토해 최종 판단을 제출하라.",
    "",
    "## 판단 기준",
    "- overallScore: 기본 가중치 tech_stack 0.5 / experience 0.3 / culture_fit 0.2를 참고하되, JD가 특정 영역을 명백히 강조하면 가중치를 조정할 수 있다 (조정 시 ceoSummary에 근거 명시).",
    "- verdict: overallScore >= 75 -> strong_fit, 45~74 -> possible_fit, <45 -> weak_fit (경계값 근처에서는 근거가 명확하면 조정 가능).",
    "- 1차 검증을 통과했더라도 결과 간 미묘한 모순, 근거 부족, 과장/축소 평가가 있다면 is_valid=false로 재작업을 지시하라 (target_departments에 해당 부서를 모두 채우고 rejection_reason 작성). 재작업은 항목당 최대 1회이므로, preCheck.forced=true인 경우에는 반드시 is_valid=true로 진행하라.",
    "- is_valid=true면 target_departments=[], rejection_reason=''.",
    "",
    JSON.stringify({
      jd: params.jd,
      techResult: params.techResult,
      expResult: params.expResult,
      cultureResult: params.cultureResult,
      preCheck: params.preCheck,
    }),
  ].join("\n");

  const generation = startObservation("ceo-evaluate", { model: CEO_MODEL, input }, { asType: "generation" });

  try {
    const response = await anthropic.messages.create({
      model: CEO_MODEL,
      max_tokens: 2048,
      tools: [ceoDecisionTool],
      tool_choice: { type: "tool", name: "submit_ceo_decision" },
      messages: [{ role: "user", content: input }],
    });

    const toolUse = response.content.find((block) => block.type === "tool_use");
    if (!toolUse || toolUse.type !== "tool_use") {
      throw new Error("CEO 응답에서 submit_ceo_decision tool_use를 찾을 수 없습니다.");
    }

    generation
      .update({
        output: toolUse.input,
        usageDetails: {
          input: response.usage.input_tokens,
          output: response.usage.output_tokens,
          total: response.usage.input_tokens + response.usage.output_tokens,
        },
      })
      .end();

    return toolUse.input as CeoDecision;
  } catch (err) {
    generation.update({ level: "ERROR", statusMessage: err instanceof Error ? err.message : String(err) }).end();
    throw err;
  }
}

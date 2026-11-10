import type { AgentResult, CandidatePortfolio, CeoDecision, FitReport, ReworkContext } from "../../shared/types.js";
import { evaluateAsCeo } from "./ceo.js";
import { callMcpTool } from "./mcp/client.js";
import { runRuleBasedValidation } from "./validation.js";

// 최초 분석 1회 + 재작업 1회 (운영 규칙: 재작업은 항목당 최대 1회)
const MAX_ATTEMPTS = 2;

/** 재시도 때 이미 끝난 단계를 다시 부르지 않기 위한 단계 결과 보관소 (워커가 Redis 로 구현) */
export interface StepMemo {
  get<T>(step: string): Promise<T | null>;
  set(step: string, value: unknown): Promise<void>;
}

export type ProgressCallback = (stage: string) => void | Promise<void>;

function buildFitReport(
  candidateId: string,
  candidateName: string,
  techResult: AgentResult,
  expResult: AgentResult,
  cultureResult: AgentResult,
  finalReport: CeoDecision["final_report"]
): FitReport {
  return {
    candidateId,
    candidateName,
    overallScore: finalReport.overallScore,
    verdict: finalReport.verdict,
    techStack: techResult,
    experience: expResult,
    cultureFit: cultureResult,
    ceoSummary: finalReport.ceoSummary,
    generatedAt: new Date().toISOString(),
  };
}

export async function runFitAnalysis(jd: string, candidateId: string, onProgress?: ProgressCallback, memo?: StepMemo): Promise<FitReport> {
  // 최초 분석 단계만 기억한다 (재작업은 피드백에 따라 결과가 달라져야 하므로 매번 호출)
  const once = async <T>(step: string, attempt: number, run: () => Promise<T>): Promise<T> => {
    if (!memo || attempt > 0) return run();
    const hit = await memo.get<T>(step);
    if (hit) return hit;
    const value = await run();
    await memo.set(step, value);
    return value;
  };

  await onProgress?.("portfolio_fetch");
  const portfolio = await once("portfolio", 0, () => callMcpTool<CandidatePortfolio>("get_candidate_portfolio", { candidateId }));

  let techResult: AgentResult | null = null;
  let expResult: AgentResult | null = null;
  let cultureResult: AgentResult | null = null;
  let techFeedback: string | null = null;
  let expFeedback: string | null = null;
  let cultureFeedback: string | null = null;
  let needTechRetry = true;
  let needExpRetry = true;
  let needCultureRetry = true;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    await onProgress?.(attempt === 0 ? "analyzing" : "reworking");

    const techPromise: Promise<AgentResult | null> = needTechRetry
      ? once("analyze_tech_stack", attempt, () => callMcpTool<AgentResult>("analyze_tech_stack", {
          jd,
          portfolio,
          ...(techResult && techFeedback ? { rework: { previousResult: techResult, feedback: techFeedback } satisfies ReworkContext } : {}),
        }))
      : Promise.resolve(null);

    const expPromise: Promise<AgentResult | null> = needExpRetry
      ? once("analyze_experience", attempt, () => callMcpTool<AgentResult>("analyze_experience", {
          jd,
          portfolio,
          ...(expResult && expFeedback ? { rework: { previousResult: expResult, feedback: expFeedback } satisfies ReworkContext } : {}),
        }))
      : Promise.resolve(null);

    const culturePromise: Promise<AgentResult | null> = needCultureRetry
      ? once("analyze_culture_fit", attempt, () => callMcpTool<AgentResult>("analyze_culture_fit", {
          jd,
          portfolio,
          ...(cultureResult && cultureFeedback
            ? { rework: { previousResult: cultureResult, feedback: cultureFeedback } satisfies ReworkContext }
            : {}),
        }))
      : Promise.resolve(null);

    const [tech, exp, culture] = await Promise.all([techPromise, expPromise, culturePromise]);

    if (tech) techResult = tech;
    if (exp) expResult = exp;
    if (culture) cultureResult = culture;

    await onProgress?.("ceo_review");
    const preCheck = runRuleBasedValidation({ techResult, expResult, cultureResult, portfolio });
    const ceoDecision = await evaluateAsCeo({
      jd,
      techResult: techResult!,
      expResult: expResult!,
      cultureResult: cultureResult!,
      preCheck,
    });

    if (ceoDecision.is_valid) {
      await onProgress?.("done");
      return buildFitReport(candidateId, portfolio.name, techResult!, expResult!, cultureResult!, ceoDecision.final_report);
    }

    needTechRetry = ceoDecision.target_departments.includes("TECH");
    needExpRetry = ceoDecision.target_departments.includes("EXP");
    needCultureRetry = ceoDecision.target_departments.includes("CULTURE");
    techFeedback = needTechRetry ? ceoDecision.rejection_reason : null;
    expFeedback = needExpRetry ? ceoDecision.rejection_reason : null;
    cultureFeedback = needCultureRetry ? ceoDecision.rejection_reason : null;
  }

  // 최대 재시도 초과 — 추가 LLM 재시도 없이 low_confidence 플래그로 진행
  await onProgress?.("low_confidence");
  techResult!.flags = [...(techResult!.flags ?? []), "low_confidence"];
  expResult!.flags = [...(expResult!.flags ?? []), "low_confidence"];
  cultureResult!.flags = [...(cultureResult!.flags ?? []), "low_confidence"];

  const forcedPreCheck = runRuleBasedValidation({ techResult, expResult, cultureResult, portfolio });
  forcedPreCheck.forced = true;
  const ceoDecision = await evaluateAsCeo({
    jd,
    techResult: techResult!,
    expResult: expResult!,
    cultureResult: cultureResult!,
    preCheck: forcedPreCheck,
  });
  if (!ceoDecision.final_report || !Number.isFinite(ceoDecision.final_report.overallScore)) {
    throw new Error("CEO 최종 판단에 결과가 없습니다 (일시 오류로 보고 재시도).");
  }

  await onProgress?.("done");
  return buildFitReport(candidateId, portfolio.name, techResult!, expResult!, cultureResult!, ceoDecision.final_report);
}

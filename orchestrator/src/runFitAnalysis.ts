import type { AgentResult, CandidatePortfolio, CeoDecision, FitReport, ReworkContext } from "../../shared/types.js";
import { evaluateAsCeo } from "./ceo.js";
import { callMcpTool } from "./mcp/client.js";
import { runRuleBasedValidation } from "./validation.js";

const MAX_ATTEMPTS = 3; // 재작업 1회 추가마다 토큰 비용이 2배가 되므로 2~3회로 제한

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

export async function runFitAnalysis(jd: string, candidateId: string, onProgress?: ProgressCallback): Promise<FitReport> {
  await onProgress?.("portfolio_fetch");
  const portfolio = await callMcpTool<CandidatePortfolio>("get_candidate_portfolio", { candidateId });

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
      ? callMcpTool<AgentResult>("analyze_tech_stack", {
          jd,
          portfolio,
          ...(techResult && techFeedback ? { rework: { previousResult: techResult, feedback: techFeedback } satisfies ReworkContext } : {}),
        })
      : Promise.resolve(null);

    const expPromise: Promise<AgentResult | null> = needExpRetry
      ? callMcpTool<AgentResult>("analyze_experience", {
          jd,
          portfolio,
          ...(expResult && expFeedback ? { rework: { previousResult: expResult, feedback: expFeedback } satisfies ReworkContext } : {}),
        })
      : Promise.resolve(null);

    const culturePromise: Promise<AgentResult | null> = needCultureRetry
      ? callMcpTool<AgentResult>("analyze_culture_fit", {
          jd,
          portfolio,
          ...(cultureResult && cultureFeedback
            ? { rework: { previousResult: cultureResult, feedback: cultureFeedback } satisfies ReworkContext }
            : {}),
        })
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

  await onProgress?.("done");
  return buildFitReport(candidateId, portfolio.name, techResult!, expResult!, cultureResult!, ceoDecision.final_report);
}

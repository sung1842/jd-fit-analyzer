import type { FitReport } from "../../../shared/types.js";
import { upsertAssessmentsForJdRun } from "./candidateAssessments.js";
import { upsertJdRun } from "./jdRuns.js";

/** JD 분석 쇼트리스트 → jd_runs + candidate_assessments 정규화 저장 (M4) */
export async function persistJdRunWithAssessments(input: {
  userId: string;
  jdHash: string;
  jdText: string;
  reports: FitReport[];
  planSnapshot?: Record<string, unknown> | null;
}) {
  const jdRun = await upsertJdRun({
    userId: input.userId,
    jdHash: input.jdHash,
    jdText: input.jdText,
    planSnapshot: input.planSnapshot ?? null,
    status: "shortlisted",
  });

  const assessments = await upsertAssessmentsForJdRun(jdRun.id, input.reports, input.jdHash);
  return { jdRun, assessments };
}

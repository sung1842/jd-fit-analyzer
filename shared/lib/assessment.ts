import type { FitReport } from "../types.js";

/** candidate_assessments 테이블용 정규화 스냅샷 (FitReport prune) */
export interface CandidateAssessmentSnapshot {
  candidateId: string;
  candidateName: string;
  overallScore: number;
  verdict: FitReport["verdict"];
  matchedSkills: string[];
  missingSkills: string[];
  ceoSummary: string;
  techSummary: string;
  experienceSummary: string;
}

export function fitReportToAssessmentSnapshot(report: FitReport): CandidateAssessmentSnapshot {
  return {
    candidateId: report.candidateId,
    candidateName: report.candidateName,
    overallScore: report.overallScore,
    verdict: report.verdict,
    matchedSkills: report.techStack.matched_items.slice(0, 12),
    missingSkills: report.techStack.missing_items.slice(0, 12),
    ceoSummary: report.ceoSummary,
    techSummary: report.techStack.summary,
    experienceSummary: report.experience.summary,
  };
}

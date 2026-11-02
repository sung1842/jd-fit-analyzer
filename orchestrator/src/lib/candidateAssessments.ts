import type { CandidateAssessmentRecord, FitReport } from "../../../shared/types.js";
import { fitReportToAssessmentSnapshot } from "../../../shared/lib/assessment.js";
import { db } from "./db.js";
import { getFitReportByCandidateAndJdHash } from "./fitReports.js";

interface CandidateAssessmentRow {
  id: string;
  jd_run_id: string;
  candidate_id: string;
  candidate_name: string | null;
  overall_score: number;
  verdict: string;
  matched_skills: string[];
  missing_skills: string[];
  ceo_summary: string | null;
  tech_summary: string | null;
  experience_summary: string | null;
  fit_report_id: string | null;
  created_at: string;
  updated_at: string;
}

function toRecord(row: CandidateAssessmentRow): CandidateAssessmentRecord {
  return {
    id: row.id,
    jdRunId: row.jd_run_id,
    candidateId: row.candidate_id,
    candidateName: row.candidate_name,
    overallScore: row.overall_score,
    verdict: row.verdict as FitReport["verdict"],
    matchedSkills: row.matched_skills ?? [],
    missingSkills: row.missing_skills ?? [],
    ceoSummary: row.ceo_summary,
    techSummary: row.tech_summary,
    experienceSummary: row.experience_summary,
    fitReportId: row.fit_report_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function upsertAssessmentsForJdRun(
  jdRunId: string,
  reports: FitReport[],
  jdHash: string
): Promise<CandidateAssessmentRecord[]> {
  const rows = await Promise.all(
    reports.map(async (report) => {
      const snap = fitReportToAssessmentSnapshot(report);
      const fitRecord = await getFitReportByCandidateAndJdHash(report.candidateId, jdHash);
      return {
        jd_run_id: jdRunId,
        candidate_id: snap.candidateId,
        candidate_name: snap.candidateName,
        overall_score: snap.overallScore,
        verdict: snap.verdict,
        matched_skills: snap.matchedSkills,
        missing_skills: snap.missingSkills,
        ceo_summary: snap.ceoSummary,
        tech_summary: snap.techSummary,
        experience_summary: snap.experienceSummary,
        fit_report_id: fitRecord?.id ?? null,
      };
    })
  );

  const { data, error } = await db
    .from("candidate_assessments")
    .upsert(rows, { onConflict: "jd_run_id,candidate_id" })
    .select();

  if (error) throw new Error(`candidate_assessments upsert 실패: ${error.message}`);
  return (data as CandidateAssessmentRow[]).map(toRecord);
}

export async function listAssessmentsByJdRun(
  jdRunId: string,
  candidateIds?: string[]
): Promise<CandidateAssessmentRecord[]> {
  let query = db.from("candidate_assessments").select().eq("jd_run_id", jdRunId);
  if (candidateIds && candidateIds.length > 0) {
    query = query.in("candidate_id", candidateIds);
  }
  const { data, error } = await query.order("overall_score", { ascending: false });
  if (error) throw new Error(`candidate_assessments 목록 조회 실패: ${error.message}`);
  return (data as CandidateAssessmentRow[]).map(toRecord);
}

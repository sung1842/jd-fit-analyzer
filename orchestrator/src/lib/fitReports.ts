import type { FitReport, FitReportRecord, FitReportStatus } from "../../../shared/types.js";
import { db } from "./db.js";

interface FitReportRow {
  id: string;
  job_id: string;
  jd: string;
  jd_hash: string;
  candidate_id: string;
  candidate_name: string | null;
  user_id: string;
  status: FitReportStatus;
  report: FitReport | null;
  created_at: string;
  updated_at: string;
}

function toRecord(row: FitReportRow): FitReportRecord {
  return {
    id: row.id,
    jobId: row.job_id,
    jd: row.jd,
    jdHash: row.jd_hash,
    candidateId: row.candidate_id,
    candidateName: row.candidate_name,
    userId: row.user_id,
    status: row.status,
    report: row.report,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function createFitReport(input: {
  jobId: string;
  jd: string;
  jdHash: string;
  candidateId: string;
  userId: string;
}): Promise<FitReportRecord> {
  const { data, error } = await db
    .from("fit_reports")
    .upsert(
      {
        job_id: input.jobId,
        jd: input.jd,
        jd_hash: input.jdHash,
        candidate_id: input.candidateId,
        user_id: input.userId,
        status: "queued",
      },
      { onConflict: "job_id" }
    )
    .select()
    .single();

  if (error) throw new Error(`fit_reports 생성 실패: ${error.message}`);
  return toRecord(data as FitReportRow);
}

export async function updateFitReportByJobId(
  jobId: string,
  patch: Partial<{ status: FitReportStatus; candidateName: string; report: FitReport }>
): Promise<FitReportRecord> {
  const update: Record<string, unknown> = {};
  if (patch.status !== undefined) update.status = patch.status;
  if (patch.candidateName !== undefined) update.candidate_name = patch.candidateName;
  if (patch.report !== undefined) update.report = patch.report;

  const { data, error } = await db.from("fit_reports").update(update).eq("job_id", jobId).select().single();
  if (error) throw new Error(`fit_reports 업데이트 실패 (jobId=${jobId}): ${error.message}`);
  return toRecord(data as FitReportRow);
}

export async function getFitReportById(id: string): Promise<FitReportRecord | null> {
  const { data, error } = await db.from("fit_reports").select().eq("id", id).maybeSingle();
  if (error) throw new Error(`fit_reports 조회 실패 (id=${id}): ${error.message}`);
  return data ? toRecord(data as FitReportRow) : null;
}

export async function getFitReportByJobId(jobId: string): Promise<FitReportRecord | null> {
  const { data, error } = await db.from("fit_reports").select().eq("job_id", jobId).maybeSingle();
  if (error) throw new Error(`fit_reports 조회 실패 (jobId=${jobId}): ${error.message}`);
  return data ? toRecord(data as FitReportRow) : null;
}

export async function getFitReportByCandidateAndJdHash(
  candidateId: string,
  jdHash: string
): Promise<FitReportRecord | null> {
  const { data, error } = await db
    .from("fit_reports")
    .select()
    .eq("candidate_id", candidateId)
    .eq("jd_hash", jdHash)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`fit_reports 조회 실패 (candidateId=${candidateId}, jdHash=${jdHash}): ${error.message}`);
  return data ? toRecord(data as FitReportRow) : null;
}

export async function listFitReports(filter: {
  status?: FitReportStatus;
  userId?: string;
}): Promise<FitReportRecord[]> {
  let query = db.from("fit_reports").select().order("created_at", { ascending: false });
  if (filter.status) query = query.eq("status", filter.status);
  if (filter.userId) query = query.eq("user_id", filter.userId);

  const { data, error } = await query;
  if (error) throw new Error(`fit_reports 목록 조회 실패: ${error.message}`);
  return (data as FitReportRow[]).map(toRecord);
}

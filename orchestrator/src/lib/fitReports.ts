import type { FitReport, FitReportRecord, FitReportStatus } from "../../../shared/types.js";
import { db } from "./db.js";
import { loadMarksSafe } from "./fitState.js";

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

/**
 * 분석 결과를 기록한다 (행을 만드는 유일한 지점). 진행 중 상태는 DB 에 쓰지 않는다 (lib/fitState.ts).
 * 같은 (JD, 후보)를 다시 분석했으면 기존 행을 덮어쓴다.
 */
export async function saveFitResult(input: {
  jobId: string;
  jd: string;
  jdHash: string;
  candidateId: string;
  userId: string;
  status: Extract<FitReportStatus, "completed" | "pending_review" | "failed">;
  candidateName?: string | null;
  report?: FitReport | null;
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
        status: input.status,
        candidate_name: input.candidateName ?? null,
        report: input.report ?? null,
      },
      { onConflict: "job_id" }
    )
    .select()
    .single();

  if (error) throw new Error(`fit_reports 기록 실패: ${error.message}`);
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
  /** 이 시각 이후 바뀐 행 + 아직 끝나지 않은 행(거절·만료 아님)만. 오래된 종결 행을 매번 읽지 않는다 */
  openOrSince?: string;
}): Promise<FitReportRecord[]> {
  let query = db.from("fit_reports").select().order("created_at", { ascending: false });
  if (filter.status) query = query.eq("status", filter.status);
  if (filter.userId) query = query.eq("user_id", filter.userId);
  if (filter.openOrSince) query = query.or(`updated_at.gte.${filter.openOrSince},status.not.in.(rejected,expired)`);

  const { data, error } = await query;
  if (error) throw new Error(`fit_reports 목록 조회 실패: ${error.message}`);
  return (data as FitReportRow[]).map(toRecord);
}

/**
 * 진행 중·다시 시도 대상은 DB 행이 없다 (Redis 표시, lib/fitState.ts).
 * 화면·집계가 같은 목록으로 볼 수 있게 자리 표시 레코드(report=null)를 붙인다: 진행 중 → queued, 다시 시도 → failed.
 */
export async function withFitMarks(reports: FitReportRecord[], userId: string): Promise<FitReportRecord[]> {
  const marks = await loadMarksSafe(userId);
  if (marks.inflight.length === 0 && marks.retryable.length === 0) return reports;
  const have = new Set(reports.map((r) => `${r.jdHash}:${r.candidateId}`));
  const out = [...reports];
  const add = (m: { jdHash: string; candidateId: string; at: number }, status: FitReportStatus) => {
    const key = `${m.jdHash}:${m.candidateId}`;
    if (have.has(key)) return;
    have.add(key);
    const at = new Date(m.at).toISOString();
    out.push({ id: `${status}:${key}`, jobId: `${m.jdHash}_${m.candidateId}`, jd: "", jdHash: m.jdHash, candidateId: m.candidateId, candidateName: null, userId, status, report: null, createdAt: at, updatedAt: at });
  };
  for (const m of marks.inflight) add(m, "queued");
  for (const m of marks.retryable) add(m, "failed");
  return out;
}

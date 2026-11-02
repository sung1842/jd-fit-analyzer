import type { JdRunRecord, JdRunStatus } from "../../../shared/types.js";
import { db } from "./db.js";

interface JdRunRow {
  id: string;
  user_id: string;
  jd_hash: string;
  jd_text: string;
  plan_snapshot: Record<string, unknown> | null;
  status: JdRunStatus;
  created_at: string;
  updated_at: string;
}

function toRecord(row: JdRunRow): JdRunRecord {
  return {
    id: row.id,
    userId: row.user_id,
    jdHash: row.jd_hash,
    jdText: row.jd_text,
    planSnapshot: row.plan_snapshot,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function upsertJdRun(input: {
  userId: string;
  jdHash: string;
  jdText: string;
  planSnapshot?: Record<string, unknown> | null;
  status?: JdRunStatus;
}): Promise<JdRunRecord> {
  const { data, error } = await db
    .from("jd_runs")
    .upsert(
      {
        user_id: input.userId,
        jd_hash: input.jdHash,
        jd_text: input.jdText,
        plan_snapshot: input.planSnapshot ?? null,
        status: input.status ?? "shortlisted",
      },
      { onConflict: "user_id,jd_hash" }
    )
    .select()
    .single();

  if (error) throw new Error(`jd_runs upsert 실패: ${error.message}`);
  return toRecord(data as JdRunRow);
}

export async function getJdRunById(id: string): Promise<JdRunRecord | null> {
  const { data, error } = await db.from("jd_runs").select().eq("id", id).maybeSingle();
  if (error) throw new Error(`jd_runs 조회 실패: ${error.message}`);
  return data ? toRecord(data as JdRunRow) : null;
}

export async function updateJdRunStatus(id: string, status: JdRunStatus): Promise<JdRunRecord> {
  const { data, error } = await db.from("jd_runs").update({ status }).eq("id", id).select().single();
  if (error) throw new Error(`jd_runs 상태 업데이트 실패: ${error.message}`);
  return toRecord(data as JdRunRow);
}

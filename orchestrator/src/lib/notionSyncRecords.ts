import type { NotionSyncRecord } from "../../../shared/types.js";
import { db } from "./db.js";

interface NotionSyncRow {
  id: string;
  user_id: string;
  candidate_id: string;
  jd_run_id: string;
  notion_page_id: string;
  last_synced_at: string;
  created_at: string;
  updated_at: string;
}

function toRecord(row: NotionSyncRow): NotionSyncRecord {
  return {
    id: row.id,
    userId: row.user_id,
    candidateId: row.candidate_id,
    jdRunId: row.jd_run_id,
    notionPageId: row.notion_page_id,
    lastSyncedAt: row.last_synced_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function upsertNotionSyncRecord(input: {
  userId: string;
  candidateId: string;
  jdRunId: string;
  notionPageId: string;
}): Promise<NotionSyncRecord> {
  const { data, error } = await db
    .from("notion_sync_records")
    .upsert(
      {
        user_id: input.userId,
        candidate_id: input.candidateId,
        jd_run_id: input.jdRunId,
        notion_page_id: input.notionPageId,
        last_synced_at: new Date().toISOString(),
      },
      { onConflict: "user_id,candidate_id,jd_run_id" }
    )
    .select()
    .single();

  if (error) throw new Error(`notion_sync_records upsert 실패: ${error.message}`);
  return toRecord(data as NotionSyncRow);
}

export async function getNotionSyncRecord(
  userId: string,
  candidateId: string,
  jdRunId: string
): Promise<NotionSyncRecord | null> {
  const { data, error } = await db
    .from("notion_sync_records")
    .select()
    .eq("user_id", userId)
    .eq("candidate_id", candidateId)
    .eq("jd_run_id", jdRunId)
    .maybeSingle();

  if (error) throw new Error(`notion_sync_records 조회 실패: ${error.message}`);
  return data ? toRecord(data as NotionSyncRow) : null;
}

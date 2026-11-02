import type { SlackNotifyPayload, SourcingActionRecord, SourcingActionStatus } from "../../../shared/types.js";
import { db } from "./db.js";

interface SourcingActionRow {
  id: string;
  type: "slack_notify";
  payload: SlackNotifyPayload;
  status: SourcingActionStatus;
  result: Record<string, unknown> | null;
  user_id: string;
  created_at: string;
  updated_at: string;
}

function toRecord(row: SourcingActionRow): SourcingActionRecord {
  return {
    id: row.id,
    type: row.type,
    payload: row.payload,
    status: row.status,
    result: row.result,
    userId: row.user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function createSourcingAction(input: {
  type: "slack_notify";
  payload: SlackNotifyPayload;
  userId: string;
}): Promise<SourcingActionRecord> {
  const { data, error } = await db
    .from("sourcing_actions")
    .insert({ type: input.type, payload: input.payload, user_id: input.userId, status: "pending" })
    .select()
    .single();

  if (error) throw new Error(`sourcing_actions 생성 실패: ${error.message}`);
  return toRecord(data as SourcingActionRow);
}

export async function listSourcingActions(filter: {
  status?: SourcingActionStatus;
  userId?: string;
}): Promise<SourcingActionRecord[]> {
  // candidate_offer(데스크 제안, 017)는 별도 API — Slack 승인 대기열에 섞지 않는다
  let query = db.from("sourcing_actions").select().eq("type", "slack_notify").order("created_at", { ascending: false });
  if (filter.status) query = query.eq("status", filter.status);
  if (filter.userId) query = query.eq("user_id", filter.userId);

  const { data, error } = await query;
  if (error) throw new Error(`sourcing_actions 목록 조회 실패: ${error.message}`);
  return (data as SourcingActionRow[]).map(toRecord);
}

export async function getSourcingActionById(id: string): Promise<SourcingActionRecord | null> {
  const { data, error } = await db.from("sourcing_actions").select().eq("id", id).eq("type", "slack_notify").maybeSingle();
  if (error) throw new Error(`sourcing_actions 조회 실패 (id=${id}): ${error.message}`);
  return data ? toRecord(data as SourcingActionRow) : null;
}

export async function updateSourcingAction(
  id: string,
  patch: Partial<{ status: SourcingActionStatus; result: Record<string, unknown> }>
): Promise<SourcingActionRecord> {
  const update: Record<string, unknown> = {};
  if (patch.status !== undefined) update.status = patch.status;
  if (patch.result !== undefined) update.result = patch.result;

  const { data, error } = await db.from("sourcing_actions").update(update).eq("id", id).select().single();
  if (error) throw new Error(`sourcing_actions 업데이트 실패 (id=${id}): ${error.message}`);
  return toRecord(data as SourcingActionRow);
}

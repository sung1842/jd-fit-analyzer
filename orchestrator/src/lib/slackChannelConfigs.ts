import { db } from "./db.js";

export interface SlackChannelConfigRecord {
  slackChannelId: string;
  userId: string;
  jdText: string;
  enabled: boolean;
  maxAnalyze: number;
  inviterSlackUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

function rowToRecord(row: Record<string, unknown>): SlackChannelConfigRecord {
  return {
    slackChannelId: String(row.slack_channel_id),
    userId: String(row.user_id),
    jdText: String(row.jd_text),
    enabled: Boolean(row.enabled),
    maxAnalyze: Number(row.max_analyze ?? 5),
    inviterSlackUserId: row.inviter_slack_user_id ? String(row.inviter_slack_user_id) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

/** 채널별 설정 조회 — 없으면 env 폴백 */
export async function resolveChannelConfig(
  slackChannelId: string
): Promise<{ userId: string; jdText: string; enabled: boolean; maxAnalyze: number } | null> {
  const { data, error } = await db
    .from("slack_channel_configs")
    .select("*")
    .eq("slack_channel_id", slackChannelId)
    .maybeSingle();

  if (!error && data) {
    const rec = rowToRecord(data as Record<string, unknown>);
    if (!rec.enabled) return null;
    return {
      userId: rec.userId,
      jdText: rec.jdText,
      enabled: rec.enabled,
      maxAnalyze: rec.maxAnalyze,
    };
  }

  const jdText = process.env.SLACK_CHANNEL_AUTO_JD?.trim();
  const userId = process.env.SLACK_CHANNEL_AUTO_USER_ID?.trim();
  if (!jdText || !userId) return null;

  const maxAnalyze = Math.min(
    10,
    Math.max(1, Number(process.env.SLACK_CHANNEL_AUTO_MAX_ANALYZE ?? "5") || 5)
  );

  return { userId, jdText, enabled: true, maxAnalyze };
}

export async function listChannelConfigs(userId: string): Promise<SlackChannelConfigRecord[]> {
  const { data, error } = await db
    .from("slack_channel_configs")
    .select("*")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false });

  if (error) {
    if (error.message.includes("does not exist") || error.code === "42P01") return [];
    throw new Error(`slack_channel_configs 조회 실패: ${error.message}`);
  }

  return (data ?? []).map((row) => rowToRecord(row as Record<string, unknown>));
}

export async function upsertChannelConfig(input: {
  slackChannelId: string;
  userId: string;
  jdText: string;
  enabled?: boolean;
  maxAnalyze?: number;
  inviterSlackUserId?: string;
}): Promise<SlackChannelConfigRecord> {
  const payload = {
    slack_channel_id: input.slackChannelId,
    user_id: input.userId,
    jd_text: input.jdText,
    enabled: input.enabled ?? true,
    max_analyze: Math.min(10, Math.max(1, input.maxAnalyze ?? 5)),
    inviter_slack_user_id: input.inviterSlackUserId ?? null,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await db
    .from("slack_channel_configs")
    .upsert(payload, { onConflict: "slack_channel_id" })
    .select("*")
    .single();

  if (error) throw new Error(`slack_channel_configs 저장 실패: ${error.message}`);
  return rowToRecord(data as Record<string, unknown>);
}

export async function deleteChannelConfig(slackChannelId: string, userId: string): Promise<boolean> {
  const { error, count } = await db
    .from("slack_channel_configs")
    .delete({ count: "exact" })
    .eq("slack_channel_id", slackChannelId)
    .eq("user_id", userId);

  if (error) throw new Error(`slack_channel_configs 삭제 실패: ${error.message}`);
  return (count ?? 0) > 0;
}

import type { NotionIntegrationRecord, NotionPropertyMapping } from "../../../shared/types.js";
import { DEFAULT_NOTION_PROPERTY_MAPPING } from "../../../shared/types.js";
import { db } from "./db.js";

interface NotionIntegrationRow {
  id: string;
  user_id: string;
  access_token: string;
  refresh_token: string | null;
  workspace_id: string | null;
  workspace_name: string | null;
  bot_id: string | null;
  data_source_id: string | null;
  property_mapping: NotionPropertyMapping;
  created_at: string;
  updated_at: string;
}

function toRecord(row: NotionIntegrationRow): NotionIntegrationRecord {
  return {
    id: row.id,
    userId: row.user_id,
    workspaceId: row.workspace_id,
    workspaceName: row.workspace_name,
    botId: row.bot_id,
    dataSourceId: row.data_source_id,
    propertyMapping: { ...DEFAULT_NOTION_PROPERTY_MAPPING, ...row.property_mapping },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getNotionIntegrationByUserId(userId: string): Promise<(NotionIntegrationRecord & { accessToken: string }) | null> {
  const { data, error } = await db.from("notion_integrations").select().eq("user_id", userId).maybeSingle();
  if (error) throw new Error(`notion_integrations 조회 실패: ${error.message}`);
  if (!data) return null;
  const row = data as NotionIntegrationRow;
  return { ...toRecord(row), accessToken: row.access_token };
}

export async function upsertNotionIntegration(input: {
  userId: string;
  accessToken: string;
  refreshToken?: string | null;
  workspaceId?: string | null;
  workspaceName?: string | null;
  botId?: string | null;
}): Promise<NotionIntegrationRecord> {
  const { data, error } = await db
    .from("notion_integrations")
    .upsert(
      {
        user_id: input.userId,
        access_token: input.accessToken,
        refresh_token: input.refreshToken ?? null,
        workspace_id: input.workspaceId ?? null,
        workspace_name: input.workspaceName ?? null,
        bot_id: input.botId ?? null,
        property_mapping: DEFAULT_NOTION_PROPERTY_MAPPING,
      },
      { onConflict: "user_id" }
    )
    .select()
    .single();

  if (error) throw new Error(`notion_integrations upsert 실패: ${error.message}`);
  return toRecord(data as NotionIntegrationRow);
}

export async function updateNotionIntegration(
  userId: string,
  patch: Partial<{ dataSourceId: string | null; propertyMapping: NotionPropertyMapping }>
): Promise<NotionIntegrationRecord> {
  const update: Record<string, unknown> = {};
  if (patch.dataSourceId !== undefined) update.data_source_id = patch.dataSourceId;
  if (patch.propertyMapping !== undefined) update.property_mapping = patch.propertyMapping;

  const { data, error } = await db
    .from("notion_integrations")
    .update(update)
    .eq("user_id", userId)
    .select()
    .single();

  if (error) throw new Error(`notion_integrations 업데이트 실패: ${error.message}`);
  return toRecord(data as NotionIntegrationRow);
}

export async function deleteNotionIntegration(userId: string): Promise<void> {
  const { error } = await db.from("notion_integrations").delete().eq("user_id", userId);
  if (error) throw new Error(`notion_integrations 삭제 실패: ${error.message}`);
}

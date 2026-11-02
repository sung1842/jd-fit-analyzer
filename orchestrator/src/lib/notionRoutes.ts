import type { Express } from "express";
import type { NotionIntegrationPublic, NotionPropertyMapping } from "../../../shared/types.js";
import { DEFAULT_NOTION_PROPERTY_MAPPING } from "../../../shared/types.js";
import { searchNotionDatabases } from "../../../shared/lib/notionApi.js";
import {
  buildNotionAuthorizeUrl,
  exchangeNotionOAuthCode,
  parseNotionOAuthState,
} from "../../../shared/lib/notionOAuth.js";
import {
  deleteNotionIntegration,
  getNotionIntegrationByUserId,
  updateNotionIntegration,
  upsertNotionIntegration,
} from "./notionIntegrations.js";
import { callMcpTool } from "../mcp/client.js";
import { resolveUserId } from "./auth.js";

// userId 는 JWT(sub) 에서 가져온다. legacy 모드에서만 query/body userId 폴백 (auth.ts 참고).
const USER_ID_REQUIRED = { error: "userId를 확인할 수 없습니다. (Bearer 토큰 필요)" } as const;

function toPublic(integration: Awaited<ReturnType<typeof getNotionIntegrationByUserId>>): NotionIntegrationPublic {
  if (!integration) {
    return {
      connected: false,
      workspaceName: null,
      dataSourceId: null,
      propertyMapping: DEFAULT_NOTION_PROPERTY_MAPPING,
    };
  }
  return {
    connected: true,
    workspaceName: integration.workspaceName,
    dataSourceId: integration.dataSourceId,
    propertyMapping: integration.propertyMapping,
  };
}

export function registerNotionRoutes(app: Express): void {
  const talentfolioUrl = () => (process.env.TALENTFOLIO_URL ?? "http://localhost:3000").replace(/\/$/, "");

  app.get("/api/notion/integrations", async (req, res) => {
    const userId = resolveUserId(req, req.query.userId as string | undefined);
    if (!userId) {
      res.status(400).json(USER_ID_REQUIRED);
      return;
    }
    try {
      const integration = await getNotionIntegrationByUserId(userId);
      res.json(toPublic(integration));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  app.patch("/api/notion/integrations", async (req, res) => {
    const { dataSourceId, propertyMapping } = req.body as {
      userId?: string;
      dataSourceId?: string | null;
      propertyMapping?: NotionPropertyMapping;
    };
    const userId = resolveUserId(req, (req.body as { userId?: string }).userId);
    if (!userId) {
      res.status(400).json(USER_ID_REQUIRED);
      return;
    }
    try {
      const updated = await updateNotionIntegration(userId, {
        ...(dataSourceId !== undefined ? { dataSourceId } : {}),
        ...(propertyMapping ? { propertyMapping } : {}),
      });
      res.json({
        connected: true,
        workspaceName: updated.workspaceName,
        dataSourceId: updated.dataSourceId,
        propertyMapping: updated.propertyMapping,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  app.delete("/api/notion/integrations", async (req, res) => {
    const userId = resolveUserId(req, req.query.userId as string | undefined);
    if (!userId) {
      res.status(400).json(USER_ID_REQUIRED);
      return;
    }
    try {
      await deleteNotionIntegration(userId);
      res.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  // 브라우저 네비게이션이라 Authorization 헤더를 못 싣는다 → ?access_token= (authGate queryTokenPaths) 로 인증.
  app.get("/api/notion/oauth/start", (req, res) => {
    const userId = resolveUserId(req, req.query.userId as string | undefined);
    if (!userId) {
      res.status(400).json(USER_ID_REQUIRED);
      return;
    }
    try {
      const url = buildNotionAuthorizeUrl(userId);
      res.redirect(url);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  app.get("/api/notion/oauth/callback", async (req, res) => {
    const code = req.query.code as string | undefined;
    const state = req.query.state as string | undefined;
    const error = req.query.error as string | undefined;

    if (error) {
      res.redirect(`${talentfolioUrl()}/settings/integrations?notion=error&reason=${encodeURIComponent(error)}`);
      return;
    }
    if (!code || !state) {
      res.status(400).json({ error: "code, state는 필수입니다." });
      return;
    }

    try {
      const { userId } = parseNotionOAuthState(state);
      const token = await exchangeNotionOAuthCode(code);
      await upsertNotionIntegration({
        userId,
        accessToken: token.access_token,
        refreshToken: token.refresh_token ?? null,
        workspaceId: token.workspace_id ?? null,
        workspaceName: token.workspace_name ?? null,
        botId: token.bot_id ?? null,
      });
      res.redirect(`${talentfolioUrl()}/settings/integrations?notion=connected`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.redirect(`${talentfolioUrl()}/settings/integrations?notion=error&reason=${encodeURIComponent(message)}`);
    }
  });

  app.get("/api/notion/databases", async (req, res) => {
    const userId = resolveUserId(req, req.query.userId as string | undefined);
    if (!userId) {
      res.status(400).json(USER_ID_REQUIRED);
      return;
    }
    try {
      const integration = await getNotionIntegrationByUserId(userId);
      if (!integration) {
        res.status(404).json({ error: "Notion 연동이 없습니다." });
        return;
      }
      const databases = await searchNotionDatabases(integration.accessToken);
      res.json({ databases });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  app.post("/api/notion/sync", async (req, res) => {
    const { jdRunId, candidateIds } = req.body as {
      userId?: string;
      jdRunId?: string;
      candidateIds?: string[];
    };
    const userId = resolveUserId(req, (req.body as { userId?: string }).userId);
    if (!userId || !jdRunId || !Array.isArray(candidateIds)) {
      res.status(400).json({ error: "jdRunId, candidateIds[]는 필수입니다. (userId는 토큰에서 추출)" });
      return;
    }
    try {
      const result = await callMcpTool<import("../../../shared/types.js").NotionSyncResult>(
        "sync_candidates_to_notion",
        { userId, jdRunId, candidateIds }
      );
      res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });
}

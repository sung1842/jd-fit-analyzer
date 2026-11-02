export function getNotionOAuthConfig() {
  const clientId = process.env.NOTION_CLIENT_ID?.trim();
  const clientSecret = process.env.NOTION_CLIENT_SECRET?.trim();
  const redirectUri = process.env.NOTION_REDIRECT_URI?.trim();
  return { clientId, clientSecret, redirectUri };
}

export function buildNotionAuthorizeUrl(userId: string): string {
  const { clientId, redirectUri } = getNotionOAuthConfig();
  if (!clientId || !redirectUri) {
    throw new Error("NOTION_CLIENT_ID / NOTION_REDIRECT_URI가 설정되어 있지 않습니다.");
  }
  const state = Buffer.from(JSON.stringify({ userId })).toString("base64url");
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    owner: "user",
    state,
  });
  return `https://api.notion.com/v1/oauth/authorize?${params.toString()}`;
}

export async function exchangeNotionOAuthCode(code: string): Promise<{
  access_token: string;
  refresh_token?: string;
  workspace_id?: string;
  workspace_name?: string;
  bot_id?: string;
}> {
  const { clientId, clientSecret, redirectUri } = getNotionOAuthConfig();
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error("Notion OAuth 환경변수가 설정되어 있지 않습니다.");
  }

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const res = await fetch("https://api.notion.com/v1/oauth/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    }),
  });

  const data = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    workspace_id?: string;
    workspace_name?: string;
    bot_id?: string;
    error?: string;
  };

  if (!res.ok || !data.access_token) {
    throw new Error(data.error ?? `Notion OAuth token exchange failed (${res.status})`);
  }

  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    workspace_id: data.workspace_id,
    workspace_name: data.workspace_name,
    bot_id: data.bot_id,
  };
}

export function parseNotionOAuthState(state: string): { userId: string } {
  try {
    const parsed = JSON.parse(Buffer.from(state, "base64url").toString("utf8")) as { userId?: string };
    if (!parsed.userId) throw new Error("invalid state");
    return { userId: parsed.userId };
  } catch {
    throw new Error("Notion OAuth state가 유효하지 않습니다.");
  }
}

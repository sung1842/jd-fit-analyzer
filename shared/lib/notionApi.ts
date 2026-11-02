import type { CandidateAssessmentRecord, NotionPropertyMapping } from "../types.js";

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

export interface NotionDatabaseSummary {
  id: string;
  title: string;
  url: string;
}

async function notionRequest<T>(
  accessToken: string,
  path: string,
  init?: RequestInit
): Promise<T> {
  const res = await fetch(`${NOTION_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  const body = (await res.json()) as T & { message?: string };
  if (!res.ok) {
    throw new Error(
      `Notion API ${path} 실패 (${res.status}): ${(body as { message?: string }).message ?? res.statusText}`
    );
  }
  return body;
}

export async function searchNotionDatabases(accessToken: string): Promise<NotionDatabaseSummary[]> {
  const data = await notionRequest<{
    results: { id: string; url: string; title?: { plain_text?: string }[] }[];
  }>(accessToken, "/search", {
    method: "POST",
    body: JSON.stringify({
      filter: { value: "database", property: "object" },
      page_size: 50,
    }),
  });

  return data.results.map((db) => ({
    id: db.id,
    title: db.title?.[0]?.plain_text ?? "Untitled",
    url: db.url,
  }));
}

export function buildNotionPageProperties(
  assessment: CandidateAssessmentRecord,
  mapping: NotionPropertyMapping,
  briefUrl: string
): Record<string, unknown> {
  const verdictLabel =
    assessment.verdict === "strong_fit"
      ? "Strong Fit"
      : assessment.verdict === "possible_fit"
        ? "Possible"
        : "Weak Fit";

  return {
    [mapping.name]: {
      title: [{ text: { content: assessment.candidateName ?? assessment.candidateId } }],
    },
    [mapping.overallScore]: { number: assessment.overallScore },
    [mapping.verdict]: {
      rich_text: [{ text: { content: verdictLabel } }],
    },
    [mapping.ceoSummary]: {
      rich_text: [{ text: { content: (assessment.ceoSummary ?? "").slice(0, 2000) } }],
    },
    [mapping.matchedSkills]: {
      rich_text: [{ text: { content: assessment.matchedSkills.join(", ").slice(0, 2000) } }],
    },
    [mapping.talentfolioLink]: { url: briefUrl },
    [mapping.externalId]: {
      rich_text: [{ text: { content: assessment.candidateId } }],
    },
  };
}

export async function findNotionPageByExternalId(
  accessToken: string,
  databaseId: string,
  externalIdProperty: string,
  candidateId: string
): Promise<string | null> {
  const data = await notionRequest<{ results: { id: string }[] }>(
    accessToken,
    `/databases/${databaseId}/query`,
    {
      method: "POST",
      body: JSON.stringify({
        filter: {
          property: externalIdProperty,
          rich_text: { equals: candidateId },
        },
        page_size: 1,
      }),
    }
  );
  return data.results[0]?.id ?? null;
}

export async function createNotionPage(
  accessToken: string,
  databaseId: string,
  properties: Record<string, unknown>
): Promise<string> {
  const data = await notionRequest<{ id: string }>(accessToken, "/pages", {
    method: "POST",
    body: JSON.stringify({
      parent: { database_id: databaseId },
      properties,
    }),
  });
  return data.id;
}

export async function updateNotionPage(
  accessToken: string,
  pageId: string,
  properties: Record<string, unknown>
): Promise<void> {
  await notionRequest(accessToken, `/pages/${pageId}`, {
    method: "PATCH",
    body: JSON.stringify({ properties }),
  });
}

export function buildBriefPageUrl(
  talentfolioUrl: string,
  candidateId: string,
  jdHash?: string
): string {
  const base = talentfolioUrl.replace(/\/$/, "");
  const q = jdHash ? `?jd=${encodeURIComponent(jdHash)}` : "";
  return `${base}/brief/${encodeURIComponent(candidateId)}${q}`;
}

import { buildBriefPageUrl } from "../../../shared/lib/notionApi.js";

export {
  searchNotionDatabases,
  buildNotionPageProperties,
  findNotionPageByExternalId,
  createNotionPage,
  updateNotionPage,
  buildBriefPageUrl,
} from "../../../shared/lib/notionApi.js";

export {
  buildNotionAuthorizeUrl,
  exchangeNotionOAuthCode,
  parseNotionOAuthState,
  getNotionOAuthConfig,
} from "../../../shared/lib/notionOAuth.js";

export function briefPageUrl(candidateId: string, jdHash?: string): string {
  const base = process.env.TALENTFOLIO_URL ?? "http://localhost:3000";
  return buildBriefPageUrl(base, candidateId, jdHash);
}

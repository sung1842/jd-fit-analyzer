import type { NotionSyncResult } from "../types.js";
import {
  buildBriefPageUrl,
  buildNotionPageProperties,
  createNotionPage,
  findNotionPageByExternalId,
  updateNotionPage,
} from "./notionApi.js";
import { DEFAULT_NOTION_PROPERTY_MAPPING } from "../types.js";
import type { CandidateAssessmentRecord, NotionPropertyMapping } from "../types.js";

export async function syncAssessmentsToNotion(input: {
  accessToken: string;
  databaseId: string;
  propertyMapping: NotionPropertyMapping;
  talentfolioUrl: string;
  userId: string;
  jdRunId: string;
  jdHash: string;
  assessments: CandidateAssessmentRecord[];
  upsertSyncRecord: (record: {
    userId: string;
    candidateId: string;
    jdRunId: string;
    notionPageId: string;
  }) => Promise<void>;
}): Promise<NotionSyncResult> {
  const mapping = { ...DEFAULT_NOTION_PROPERTY_MAPPING, ...input.propertyMapping };
  const pages: NotionSyncResult["pages"] = [];
  const errors: string[] = [];
  let synced = 0;
  let failed = 0;

  for (const assessment of input.assessments) {
    try {
      const briefUrl = buildBriefPageUrl(input.talentfolioUrl, assessment.candidateId, input.jdHash);
      const properties = buildNotionPageProperties(assessment, mapping, briefUrl);

      const existingPageId = await findNotionPageByExternalId(
        input.accessToken,
        input.databaseId,
        mapping.externalId,
        assessment.candidateId
      );

      let pageId: string;
      let created: boolean;

      if (existingPageId) {
        await updateNotionPage(input.accessToken, existingPageId, properties);
        pageId = existingPageId;
        created = false;
      } else {
        pageId = await createNotionPage(input.accessToken, input.databaseId, properties);
        created = true;
      }

      await input.upsertSyncRecord({
        userId: input.userId,
        candidateId: assessment.candidateId,
        jdRunId: input.jdRunId,
        notionPageId: pageId,
      });

      pages.push({ candidateId: assessment.candidateId, notionPageId: pageId, created });
      synced++;
    } catch (err) {
      failed++;
      errors.push(`${assessment.candidateId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { synced, failed, pages, ...(errors.length ? { errors } : {}) };
}

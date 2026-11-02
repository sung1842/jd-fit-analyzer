import type { NotionSyncResult } from "../../../shared/types.js";
import { DEFAULT_NOTION_PROPERTY_MAPPING } from "../../../shared/types.js";
import { syncAssessmentsToNotion } from "../../../shared/lib/notionSyncCore.js";
import { db } from "../lib/db.js";

interface AssessmentRow {
  id: string;
  jd_run_id: string;
  candidate_id: string;
  candidate_name: string | null;
  overall_score: number;
  verdict: string;
  matched_skills: string[];
  missing_skills: string[];
  ceo_summary: string | null;
  tech_summary: string | null;
  experience_summary: string | null;
  fit_report_id: string | null;
}

interface IntegrationRow {
  access_token: string;
  data_source_id: string | null;
  property_mapping: Record<string, string>;
}

interface JdRunRow {
  jd_hash: string;
}

function rowToAssessment(raw: AssessmentRow) {
  return {
    id: raw.id,
    jdRunId: raw.jd_run_id,
    candidateId: raw.candidate_id,
    candidateName: raw.candidate_name,
    overallScore: raw.overall_score,
    verdict: raw.verdict as "strong_fit" | "possible_fit" | "weak_fit",
    matchedSkills: raw.matched_skills ?? [],
    missingSkills: raw.missing_skills ?? [],
    ceoSummary: raw.ceo_summary,
    techSummary: raw.tech_summary,
    experienceSummary: raw.experience_summary,
    fitReportId: raw.fit_report_id,
    createdAt: "",
    updatedAt: "",
  };
}

/** Phase M4: candidate_assessments → Notion DB upsert (LLM 호출 없음) */
export async function syncCandidatesToNotion(input: {
  userId: string;
  jdRunId: string;
  candidateIds: string[];
}): Promise<NotionSyncResult> {
  const { userId, jdRunId, candidateIds } = input;

  const { data: integration, error: intErr } = await db
    .from("notion_integrations")
    .select("access_token, data_source_id, property_mapping")
    .eq("user_id", userId)
    .maybeSingle();

  if (intErr) throw new Error(`notion_integrations 조회 실패: ${intErr.message}`);
  if (!integration) throw new Error("Notion 연동이 없습니다. 설정에서 OAuth 연결을 완료해 주세요.");

  const row = integration as IntegrationRow;
  if (!row.data_source_id) {
    throw new Error("Notion 후보 DB(data_source_id)가 선택되지 않았습니다.");
  }

  const { data: jdRun, error: jdErr } = await db
    .from("jd_runs")
    .select("jd_hash")
    .eq("id", jdRunId)
    .maybeSingle();

  if (jdErr || !jdRun) throw new Error("jd_run을 찾을 수 없습니다.");
  const jdHash = (jdRun as JdRunRow).jd_hash;

  let query = db.from("candidate_assessments").select().eq("jd_run_id", jdRunId);
  if (candidateIds.length > 0) query = query.in("candidate_id", candidateIds);

  const { data: assessments, error: aErr } = await query;
  if (aErr) throw new Error(`candidate_assessments 조회 실패: ${aErr.message}`);
  if (!assessments?.length) throw new Error("동기화할 assessment가 없습니다.");

  const talentfolioUrl = process.env.TALENTFOLIO_URL ?? "http://localhost:3000";

  const result = await syncAssessmentsToNotion({
    accessToken: row.access_token,
    databaseId: row.data_source_id,
    propertyMapping: { ...DEFAULT_NOTION_PROPERTY_MAPPING, ...(row.property_mapping as Partial<import("../../../shared/types.js").NotionPropertyMapping>) },
    talentfolioUrl,
    userId,
    jdRunId,
    jdHash,
    assessments: (assessments as AssessmentRow[]).map(rowToAssessment),
    upsertSyncRecord: async (record) => {
      const { error } = await db.from("notion_sync_records").upsert(
        {
          user_id: record.userId,
          candidate_id: record.candidateId,
          jd_run_id: record.jdRunId,
          notion_page_id: record.notionPageId,
          last_synced_at: new Date().toISOString(),
        },
        { onConflict: "user_id,candidate_id,jd_run_id" }
      );
      if (error) throw new Error(error.message);
    },
  });

  if (result.synced > 0) {
    await db.from("jd_runs").update({ status: "synced" }).eq("id", jdRunId);
  }

  return result;
}

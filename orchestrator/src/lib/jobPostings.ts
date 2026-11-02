import { db } from "./db.js";

/** fit.job_postings 요약 — 목록/선택용. description 은 LLM 입력이므로 전문 포함 (prune 은 호출부에서). */
export interface JobPostingSummary {
  id: string;
  source: string;
  externalId: string;
  url: string | null;
  company: string | null;
  title: string;
  description: string | null;
  skills: string[];
  location: string | null;
  employmentType: string | null;
  experienceLevel: string | null;
  postedAt: string | null;
  expiresAt: string | null;
}

interface JobPostingRow {
  id: string;
  source: string;
  external_id: string;
  url: string | null;
  company: string | null;
  title: string;
  description: string | null;
  skills: string[] | null;
  location: string | null;
  employment_type: string | null;
  experience_level: string | null;
  posted_at: string | null;
  expires_at: string | null;
}

function toSummary(row: JobPostingRow): JobPostingSummary {
  return {
    id: row.id,
    source: row.source,
    externalId: row.external_id,
    url: row.url,
    company: row.company,
    title: row.title,
    description: row.description,
    skills: row.skills ?? [],
    location: row.location,
    employmentType: row.employment_type,
    experienceLevel: row.experience_level,
    postedAt: row.posted_at,
    expiresAt: row.expires_at,
  };
}

const COLUMNS =
  "id, source, external_id, url, company, title, description, skills, location, employment_type, experience_level, posted_at, expires_at";

export async function listJobPostings(params: { q?: string; source?: string; limit: number }): Promise<JobPostingSummary[]> {
  let query = db.from("job_postings").select(COLUMNS).order("posted_at", { ascending: false, nullsFirst: false }).limit(params.limit);
  if (params.source) query = query.eq("source", params.source);
  if (params.q && params.q.trim()) {
    const q = params.q.trim().replace(/[%,()]/g, " ");
    query = query.or(`title.ilike.%${q}%,company.ilike.%${q}%`);
  }
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return ((data ?? []) as JobPostingRow[]).map(toSummary);
}

export async function getJobPostingById(id: string): Promise<JobPostingSummary | null> {
  const { data, error } = await db.from("job_postings").select(COLUMNS).eq("id", id).maybeSingle();
  if (error) throw new Error(error.message);
  return data ? toSummary(data as JobPostingRow) : null;
}

/**
 * 공개 공고 목록 (talentfolio /studio 등). 크롤 검수에서 승인된 공고만 job_postings 에 병합되므로
 * (승인 취소 시 정본에서 삭제 — lib/crawlReview.ts) 여기서는 마감 안 지난 행만 고른다.
 * 비로그인 화면에서 쓰므로 원문(raw)·LLM 입력용 description 은 내보내지 않는다.
 */
export interface PublicJobPosting {
  id: string;
  source: string;
  url: string | null;
  company: string | null;
  title: string;
  skills: string[];
  location: string | null;
  employmentType: string | null;
  experienceLevel: string | null;
  salary: string | null;
  expiresAt: string | null;
  firstSeenAt: string;
}

export const PUBLIC_POSTING_SOURCES = ["board_a"];

export async function listPublicJobPostings(params: { q?: string; limit: number }): Promise<PublicJobPosting[]> {
  let query = db
    .from("job_postings")
    .select("id, source, url, company, title, skills, location, employment_type, experience_level, salary, expires_at, first_seen_at")
    .in("source", PUBLIC_POSTING_SOURCES)
    .or(`expires_at.is.null,expires_at.gte.${new Date().toISOString()}`)
    .order("first_seen_at", { ascending: false })
    .limit(params.limit);
  if (params.q && params.q.trim()) {
    const q = params.q.trim().replace(/[%,()]/g, " ");
    query = query.or(`title.ilike.%${q}%,company.ilike.%${q}%`);
  }
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return ((data ?? []) as (Omit<JobPostingRow, "external_id" | "description" | "posted_at"> & { salary: string | null; first_seen_at: string })[]).map(
    (r) => ({
      id: r.id,
      source: r.source,
      url: r.url,
      company: r.company,
      title: r.title,
      skills: r.skills ?? [],
      location: r.location,
      employmentType: r.employment_type,
      experienceLevel: r.experience_level,
      salary: r.salary,
      expiresAt: r.expires_at,
      firstSeenAt: r.first_seen_at,
    })
  );
}

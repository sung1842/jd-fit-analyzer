/**
 * 1회용: 이미 병합된 job_postings 에 필터 컬럼(SQL 016)을 채운다. 새 병합분은 crawlReview.toJobPosting 이 채운다.
 *   cd orchestrator && npx tsx src/scripts/backfillPostingFacets.ts
 * 학력·마감 문구는 정본에 없어서 연결된 크롤 원본(crawled_postings)에서 읽는다. 원본이 지워졌으면 정본 값만으로 계산.
 */
import { db } from "../lib/db.js";
import { computeFacets } from "../lib/postingFacets.js";

const { data: postings, error } = await db
  .from("job_postings")
  .select("id, title, skills, experience_level, employment_type, location, salary, expires_at");
if (error) throw new Error(error.message);

const { data: raws } = await db
  .from("crawled_postings")
  .select("job_posting_id, education_text, deadline_text, deadline_date")
  .not("job_posting_id", "is", null);
const rawBy = new Map((raws ?? []).map((r) => [r.job_posting_id as string, r]));

let n = 0;
for (const p of postings ?? []) {
  const raw = rawBy.get(p.id);
  const facets = computeFacets({
    title: p.title,
    skills: p.skills ?? [],
    career_text: p.experience_level,
    education_text: raw?.education_text ?? null,
    employment_type_text: p.employment_type,
    location_text: p.location,
    deadline_date: raw?.deadline_date ?? (p.expires_at ? String(p.expires_at).slice(0, 10) : null),
    deadline_text: raw?.deadline_text ?? null,
    salary_text: p.salary,
  });
  const { error: upErr } = await db.from("job_postings").update(facets).eq("id", p.id);
  if (upErr) throw new Error(upErr.message);
  n += 1;
}
console.log(`[backfill] job_postings ${n}건 필터 값 갱신`);

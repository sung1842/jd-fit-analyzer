import { createHash } from "node:crypto";
import { db } from "./db.js";
import { region } from "./jdPlan.js";
import { getSkillDictionary, type SkillDictionary } from "./skillDictionary.js";

/**
 * 구직자용 "나에게 맞는 공고" (SQL 022). LLM 0회 — 22 문서 매칭 엔진의 재료를 반대 방향(후보 → 공고)으로 쓴다.
 *   1) 필수 조건 (코드): 마감 전 · 추천 제외 아님 · 희망 직군/지역을 정했고 공고에도 값이 있으면 겹쳐야 통과
 *   2) 기술 일치 (사전): 공고 skills 와 내 기술을 표준 이름으로 바꿔 같은 키인지 본다 (하위 기술 0.7)
 *   3) 계산식 점수 → 상위 RECOMMEND_TOP_N 저장. 근거 문장도 코드가 만든다
 * 입력(정규화 결과·희망 조건·공고 목록)이 그대로면 다시 계산하지 않는다 (inputs_hash).
 */
export const RECOMMEND_TOP_N = Number(process.env.RECOMMEND_TOP_N || 20);
const POSTING_SCAN_MAX = Number(process.env.RECOMMEND_SCAN_MAX || 5000);
const SKILL_CHECK_MAX = 10; // 공고 기술은 앞 10개만 본다 (나열이 긴 공고가 불리하지 않게)

export const WEIGHTS = { skills: 0.45, career: 0.2, region: 0.15, employment: 0.1, category: 0.1 } as const;

export interface SeekerProfile {
  skills: string[];
  years: number | null;
  categories: string[]; // job_categories.code
  regions: string[]; // 시·도
  employment: string[];
}

export interface RecPosting {
  id: string;
  company: string | null;
  title: string;
  skills: string[];
  category_codes: string[];
  career_min: number | null;
  career_max: number | null;
  newcomer_ok: boolean | null;
  employment_types: string[];
  region_sido: string | null;
}

export interface Recommendation {
  postingId: string;
  score: number;
  reasons: string[];
  breakdown: Record<string, number>;
}

/** 경력 적합도: 범위 안 1, 모자라면 1년당 -0.25, 넘치면 1년당 -0.1 (과경력은 덜 깎는다), 정보 없음 0.6 */
export function careerFit(years: number | null, p: Pick<RecPosting, "career_min" | "career_max" | "newcomer_ok">): number {
  if (years == null || (p.career_min == null && p.career_max == null && p.newcomer_ok == null)) return 0.6;
  if (years < 1 && p.newcomer_ok) return 1;
  if (p.career_min != null && years < p.career_min) return Math.max(0, 1 - 0.25 * (p.career_min - years));
  if (p.career_max != null && p.career_max > 0 && years > p.career_max) return Math.max(0.3, 1 - 0.1 * (years - p.career_max));
  return 1;
}

export function scorePosting(dict: SkillDictionary, me: SeekerProfile, p: RecPosting): Recommendation | null {
  // 1) 필수 조건 — 정보가 없는 쪽에 불리하게 하지 않는다 (공고에 값이 없으면 통과)
  if (me.categories.length && p.category_codes.length && !p.category_codes.some((c) => me.categories.includes(c))) return null;
  const wantRegions = me.regions.map(region);
  if (wantRegions.length && p.region_sido && !wantRegions.includes(region(p.region_sido))) return null;

  // 2) 기술 일치
  const jobSkills = [...new Set(p.skills)].slice(0, SKILL_CHECK_MAX);
  const matched: string[] = [];
  let hit = 0;
  for (const s of jobSkills) {
    const m = dict.matchScore(s, me.skills);
    if (m > 0) {
      hit += m;
      matched.push(dict.canonical(s) ?? s);
    }
  }
  const skills = jobSkills.length ? hit / jobSkills.length : 0.5;

  // 3) 나머지 항목
  const career = careerFit(me.years, p);
  const regionScore = !wantRegions.length || !p.region_sido ? 0.7 : 1;
  const employment = !me.employment.length || !p.employment_types.length ? 0.7 : p.employment_types.some((e) => me.employment.includes(e)) ? 1 : 0.3;
  const category = !me.categories.length || !p.category_codes.length ? 0.7 : 1;

  const breakdown = { skills, career, region: regionScore, employment, category };
  const score = Math.round(100 * (Object.keys(WEIGHTS) as (keyof typeof WEIGHTS)[]).reduce((s, k) => s + WEIGHTS[k] * breakdown[k], 0));

  const reasons: string[] = [];
  if (jobSkills.length) reasons.push(matched.length ? `기술 ${matched.length}/${jobSkills.length} 일치 (${matched.slice(0, 4).join(", ")})` : `기술 0/${jobSkills.length} 일치`);
  if (career === 1 && me.years != null) reasons.push(p.newcomer_ok && me.years < 1 ? "신입 가능" : `경력 ${me.years}년 조건 충족`);
  else if (career < 1 && career !== 0.6 && p.career_min != null && me.years != null && me.years < p.career_min) reasons.push(`경력 ${p.career_min}년 이상 요구 (내 경력 ${me.years}년)`);
  if (regionScore === 1 && p.region_sido) reasons.push(`희망 지역 ${region(p.region_sido)}`);
  if (employment === 1) reasons.push(`희망 고용형태 ${p.employment_types.filter((e) => me.employment.includes(e)).join("·")}`);
  return { postingId: p.id, score, reasons, breakdown: Object.fromEntries(Object.entries(breakdown).map(([k, v]) => [k, Math.round(v * 100) / 100])) };
}

export function rankPostings(dict: SkillDictionary, me: SeekerProfile, postings: RecPosting[], topN = RECOMMEND_TOP_N): { recs: Recommendation[]; passed: number } {
  const scored = postings.map((p) => scorePosting(dict, me, p)).filter((r): r is Recommendation => r !== null);
  // 기술이 하나도 안 맞으면 다른 조건이 좋아도 뒤로 (점수는 그대로 보여 준다)
  scored.sort((a, b) => Number(b.breakdown.skills > 0) - Number(a.breakdown.skills > 0) || b.score - a.score || a.postingId.localeCompare(b.postingId));
  return { recs: scored.slice(0, topN), passed: scored.length };
}

// ---------------- DB ----------------

/** 정규화 결과(우선) + 스튜디오 희망 조건. 정규화 전이면 profiles.skills 로 대신한다 */
export async function loadSeeker(userId: string): Promise<{ me: SeekerProfile; versionKey: string }> {
  const [norm, basics, profile, exps] = await Promise.all([
    db.from("candidate_profiles_norm").select("skills, total_years, prefs, changed_at").eq("candidate_id", userId).maybeSingle(),
    db.from("resume_basics").select("desired_categories, desired_regions, desired_employment_types, updated_at").eq("user_id", userId).maybeSingle(),
    db.schema("public").from("profiles").select("skills").eq("id", userId).maybeSingle(),
    db.from("resume_experiences").select("start_on, end_on, is_current").eq("user_id", userId),
  ]);
  for (const r of [norm, basics, exps]) if (r.error) throw new Error(`추천 입력 조회 실패: ${r.error.message}`);
  const n = norm.data as { skills: { name: string }[]; total_years: number | null; prefs: { locations?: string[] } | null; changed_at: string } | null;
  const b = basics.data as { desired_categories: string[]; desired_regions: string[]; desired_employment_types: string[]; updated_at: string } | null;

  // 경력: 정규화 값 우선, 없으면 스튜디오 경력 기간 합
  let years = n?.total_years != null ? Number(n.total_years) : null;
  if (years == null && exps.data?.length) {
    const ms = (exps.data as { start_on: string; end_on: string | null; is_current: boolean }[])
      .reduce((s, e) => s + Math.max(0, (e.is_current || !e.end_on ? Date.now() : Date.parse(e.end_on)) - Date.parse(e.start_on)), 0);
    years = Math.round((ms / (365.25 * 86400000)) * 2) / 2;
  }
  const me: SeekerProfile = {
    skills: n?.skills?.map((s) => s.name) ?? ((profile.data as { skills: string[] | null } | null)?.skills ?? []),
    years,
    categories: b?.desired_categories ?? [],
    regions: b?.desired_regions?.length ? b.desired_regions : (n?.prefs?.locations ?? []),
    employment: b?.desired_employment_types ?? [],
  };
  return { me, versionKey: `${n?.changed_at ?? "-"}|${b?.updated_at ?? "-"}|${exps.data?.length ?? 0}` };
}

const POSTING_COLS = "id, company, title, skills, category_codes, career_min, career_max, newcomer_ok, employment_types, region_sido, updated_at";

export async function loadOpenPostings(): Promise<(RecPosting & { updated_at: string })[]> {
  const { data, error } = await db
    .from("job_postings")
    .select(POSTING_COLS)
    .or(`expires_at.is.null,expires_at.gte.${new Date().toISOString()}`)
    .order("first_seen_at", { ascending: false })
    .limit(POSTING_SCAN_MAX);
  if (error) throw new Error(`공고 조회 실패: ${error.message}`);
  return (data ?? []) as (RecPosting & { updated_at: string })[];
}

/** 사용자 1명 추천 재계산. inputs_hash 가 같으면 건너뛴다 (force 제외) */
export async function computeRecommendations(userId: string, force = false): Promise<{ skipped: boolean; saved: number; passed: number }> {
  const [{ me, versionKey }, postings, excl, prev] = await Promise.all([
    loadSeeker(userId),
    loadOpenPostings(),
    db.from("match_exclusions").select("job_posting_id").eq("user_id", userId),
    db.from("job_recommendation_runs").select("inputs_hash").eq("user_id", userId).maybeSingle(),
  ]);
  if (excl.error) throw new Error(`추천 제외 조회 실패: ${excl.error.message}`);
  const exclusions = (excl.data ?? []) as { job_posting_id: string | null }[];
  const excludedAll = exclusions.some((e) => e.job_posting_id === null);
  const excluded = new Set(exclusions.map((e) => e.job_posting_id).filter(Boolean));

  const latest = postings.reduce((m, p) => (p.updated_at > m ? p.updated_at : m), "");
  const hash = createHash("sha256")
    .update(JSON.stringify([versionKey, postings.length, latest, [...excluded].sort(), excludedAll, RECOMMEND_TOP_N, WEIGHTS]))
    .digest("hex")
    .slice(0, 32);
  if (!force && (prev.data as { inputs_hash: string } | null)?.inputs_hash === hash) return { skipped: true, saved: 0, passed: 0 };

  const dict = await getSkillDictionary();
  const pool = excludedAll ? [] : postings.filter((p) => !excluded.has(p.id));
  const { recs, passed } = rankPostings(dict, me, pool);

  // 통째로 바꾼다 (사용자당 수십 행)
  const del = await db.from("job_recommendations").delete().eq("user_id", userId);
  if (del.error) throw new Error(`추천 정리 실패: ${del.error.message}`);
  if (recs.length) {
    const ins = await db.from("job_recommendations").insert(
      recs.map((r, i) => ({ user_id: userId, job_posting_id: r.postingId, rank: i + 1, score: r.score, reasons: r.reasons, breakdown: r.breakdown }))
    );
    if (ins.error) throw new Error(`추천 저장 실패: ${ins.error.message}`);
  }
  const run = await db.from("job_recommendation_runs").upsert({ user_id: userId, inputs_hash: hash, candidates: passed, computed_at: new Date().toISOString() });
  if (run.error) throw new Error(`추천 상태 저장 실패: ${run.error.message}`);
  return { skipped: false, saved: recs.length, passed };
}

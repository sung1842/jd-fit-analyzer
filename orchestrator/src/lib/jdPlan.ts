import { callMcpTool } from "../mcp/client.js";
import { db } from "./db.js";
import { createHash } from "node:crypto";
import { Sentry } from "./sentry.js";
import type { EffectiveWeights, WeightScope } from "../../../shared/matchTypes.js";
import { jdHash } from "./cache.js";
import { getJobEmbedding, getJobRequirements, refineRequirements, type JobRequirements } from "./jobRequirements.js";
import { B_TOP_K, C_TOP_N, inputsHash, loadEffectiveWeights, mustCoverage, rankCandidates, type RankInput, type RankResult, type ScoreBreakdown } from "./matchEngine.js";
import { getRoleTaxonomy, ROLE_MATCH_MIN, type RoleTaxonomy } from "./roleTaxonomy.js";
import { getSkillDictionary, recordUnmapped, type SkillDictionary } from "./skillDictionary.js";

export interface JdPlanRankedCandidate {
  candidateId: string;
  name: string;
  title: string | null;
  matchCount: number;
  /** 일치 점수 합 (필수 1·우대 NICE_WEIGHT, 하위 기술 보유는 PARENT_CREDIT 배) — 정렬 기준 */
  matchScore: number;
  matchedKeywords: string[];
  /** 충족한 필수 비율 0~1 (필수가 없으면 1) */
  mustCoverage: number;
  missingMust: string[];
  /** 공고 직무와의 인접도 (정규화 전 후보는 null) */
  roleAffinity: number | null;
  normalized: boolean;
  /** 22 문서 E5 C 단계 점수 0~100 (필수 미충족 시 ≤50) */
  rankScore?: number;
  scoreBreakdown?: ScoreBreakdown;
  /** D 단계 정밀 분석 후보 (rankScore ≥ D_MIN_RANK) */
  analyzable?: boolean;
  /** B 단계 진입 경로 */
  via?: ("skill" | "vector")[];
}

/** 22 문서 E3 우대 기술 가중치 (E5 계산식 전 임시) */
export const NICE_WEIGHT = 0.5;

/** 표준 기술 사전으로 필수·우대 기술과 후보 skills 비교 (결정적·LLM 없음). 필수를 모두 갖춘 후보가 먼저. */
export function rankByRequirements(
  dict: SkillDictionary,
  req: { must_skills: string[]; must_any_of?: string[][]; nice_skills: string[] },
  candidates: { id: string; name: string; title: string | null; skills: string[] | null; roleAffinity?: number | null; normalized?: boolean }[]
): JdPlanRankedCandidate[] {
  return candidates
    .map((c) => {
      const skills = c.skills ?? [];
      const cov = mustCoverage(dict, req, skills);
      let matchScore = cov.hit;
      const matchedKeywords: string[] = [...cov.matched];
      const missingMust = cov.missing;
      for (const kw of req.nice_skills) {
        const s = dict.matchScore(kw, skills);
        if (s > 0) {
          matchScore += s * NICE_WEIGHT;
          matchedKeywords.push(kw);
        }
      }
      return {
        candidateId: c.id,
        name: c.name,
        title: c.title,
        matchCount: matchedKeywords.length,
        matchScore: Math.round(matchScore * 100) / 100,
        matchedKeywords,
        mustCoverage: cov.total ? Math.round((cov.hit / cov.total) * 100) / 100 : 1,
        missingMust,
        roleAffinity: c.roleAffinity ?? null,
        normalized: c.normalized ?? false,
      };
    })
    .sort(
      (a, b) =>
        a.missingMust.length - b.missingMust.length ||
        b.matchScore - a.matchScore ||
        (b.roleAffinity ?? 0) - (a.roleAffinity ?? 0) ||
        b.matchCount - a.matchCount ||
        a.candidateId.localeCompare(b.candidateId)
    );
}

/** E1 호환: 키워드를 전부 필수로 취급 */
export function rankBySkills(
  dict: SkillDictionary,
  keywords: string[],
  candidates: { id: string; name: string; title: string | null; skills: string[] | null }[]
): JdPlanRankedCandidate[] {
  return rankByRequirements(dict, { must_skills: keywords, nice_skills: [] }, candidates);
}

// ---------------- A 단계: 필수 조건 (22 문서 §6.4) ----------------

export interface CandidateNormLite {
  roles: string[];
  skills: { name: string }[];
  total_years: number | null;
  prefs: { locations?: string[]; remote?: boolean | null } | null;
  /** 정규화 결과가 바뀐 시각 — activity 근사 (E5) */
  changed_at?: string | null;
}

export type FilterReason = "role" | "years" | "location";

/** 경력은 1년 여유, 지역은 원격 가능·정보 없음이면 통과 (정보가 없는 쪽에 불리하게 하지 않는다). */
export function requiredFilter(req: JobRequirements, norm: CandidateNormLite | null, tax: RoleTaxonomy): { pass: true; roleAffinity: number | null } | { pass: false; reason: FilterReason } {
  if (!norm) return { pass: true, roleAffinity: null }; // 정규화 전 — 직군 2종 필터만 (search_candidates)
  let roleAffinity: number | null = null;
  if (req.role) {
    roleAffinity = tax.best(req.role, norm.roles);
    if (norm.roles.length > 0 && roleAffinity < ROLE_MATCH_MIN) return { pass: false, reason: "role" };
  }
  const years = norm.total_years == null ? null : Number(norm.total_years);
  if (req.years_min != null && years != null && years < req.years_min - 1) return { pass: false, reason: "years" };
  const want = req.locations.map(region);
  const have = (norm.prefs?.locations ?? []).map(region);
  if (want.length && req.remote_ok !== true && have.length && norm.prefs?.remote !== true && !have.some((h) => want.includes(h))) {
    return { pass: false, reason: "location" };
  }
  return { pass: true, roleAffinity };
}

/** "서울 강남구", "서울특별시" → "서울" */
export function region(s: string): string {
  return s.trim().replace(/\s.*$/, "").replace(/(특별시|광역시|특별자치시|특별자치도|도)$/, "");
}

export interface JdPlanResult {
  role: "developer" | "designer";
  roleConfidence: number;
  keywords: string[];
  totalInRole: number;
  matchedCount: number;
  ranked: JdPlanRankedCandidate[];
  /** 22 문서 E3 */
  requirements: JobRequirements;
  filteredOut: Record<FilterReason, number>;
  normalizedCount: number;
  /** 22 문서 E4·E5 */
  vectorStage: "applied" | "skipped";
  weightsVersion: string;
  analyzableCount: number;
  /** match_scores 저장은 응답 뒤 비동기 (헌법 2조) — 결과는 로그로만 */
  scoresSaved: "queued" | "skipped";
}

type SearchRow = { id: string; name: string; role: "developer" | "designer"; title: string | null; skills: string[] };

async function loadNorms(ids: string[]): Promise<Map<string, CandidateNormLite>> {
  const out = new Map<string, CandidateNormLite>();
  if (ids.length === 0) return out;
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await db
      .from("candidate_profiles_norm")
      .select("candidate_id, roles, skills, total_years, prefs, changed_at")
      .in("candidate_id", ids.slice(i, i + 200));
    if (error) return out; // 020 미적용 — 정규화 없이 진행
    for (const r of (data ?? []) as (CandidateNormLite & { candidate_id: string })[]) out.set(r.candidate_id, r);
  }
  return out;
}

/** JD → 공고 정규화(캐시) → A 단계 필수 조건 → 필수·우대 기술 순위 (server /api/jd/plan) */
export async function buildJdPlan(
  jd: string,
  clientRole?: "developer" | "designer",
  clientKeywords?: string[],
  /** 스카우트 건(20 문서 C2): 헤드헌터가 조정한 요건을 그대로 쓴다 (LLM 재호출 없음) */
  reqOverride?: JobRequirements,
  /** E6b 층별 가중치 범위 (없으면 공통) */
  scope?: WeightScope
): Promise<JdPlanResult> {
  let req: JobRequirements;
  if (reqOverride) {
    req = reqOverride;
  } else if (clientRole === "developer" || clientRole === "designer") {
    // 클라이언트가 직군·키워드를 직접 준 경우: LLM 없이 키워드 = 필수, 직무 인접도·경력·지역 필터 없음
    req = {
      role: null,
      legacy_role: clientRole,
      role_confidence: 100,
      must_skills: Array.isArray(clientKeywords) ? clientKeywords.filter((k) => typeof k === "string" && k.trim()) : [],
      nice_skills: [],
      years_min: null,
      years_max: null,
      locations: [],
      remote_ok: null,
    };
  } else {
    const { cached: _cached, ...rest } = await getJobRequirements(jd);
    req = rest;
  }

  const [candidates, dict, tax] = await Promise.all([
    callMcpTool<SearchRow[]>("search_candidates", { role: req.legacy_role }),
    getSkillDictionary(),
    getRoleTaxonomy(),
  ]);
  // A2: 사전 기준 재분류 (사전 밖 문장 → 경험, 경험 칸의 사전 이름 → 기술). 헤드헌터 조정본(reqOverride)·직접 키워드는 그대로
  if (!reqOverride && clientRole !== "developer" && clientRole !== "designer") req = refineRequirements(dict, req, jd);
  recordUnmapped(dict.unmapped([...req.must_skills, ...(req.must_any_of ?? []).flat(), ...req.nice_skills]));
  const norms = await loadNorms(candidates.map((c) => c.id));

  const filteredOut: Record<FilterReason, number> = { role: 0, years: 0, location: 0 };
  const passed: Parameters<typeof rankByRequirements>[2] = [];
  for (const c of candidates) {
    const norm = norms.get(c.id) ?? null;
    const f = requiredFilter(req, norm, tax);
    if (!f.pass) {
      filteredOut[f.reason]++;
      continue;
    }
    // 정규화된 후보는 표준 이름 기술 + 원본 기술을 함께 비교 (정규화가 놓친 이름 보완)
    const skills = norm ? [...new Set([...norm.skills.map((s) => s.name), ...(c.skills ?? [])])] : c.skills;
    passed.push({ id: c.id, name: c.name, title: c.title, skills, roleAffinity: f.roleAffinity, normalized: !!norm });
  }

  const legacy = rankByRequirements(dict, req, passed);
  const matched = legacy.filter((r) => r.matchCount > 0);

  // B 단계: (기술 1개 이상 일치) ∪ (벡터 상위 B_TOP_K). 022 미적용·임베딩 실패면 기술 일치만.
  const [vec, ew] = await Promise.all([vectorTopK(jd), loadEffectiveWeights(scope ?? {})]);
  const via = new Map<string, ("skill" | "vector")[]>();
  for (const r of matched) via.set(r.candidateId, ["skill"]);
  const passedIds = new Set(legacy.map((r) => r.candidateId));
  if (vec) for (const id of vec.keys()) if (passedIds.has(id)) via.set(id, [...(via.get(id) ?? []), "vector"]);
  // 둘 다 비면 기존처럼 A 통과자 전원
  // 근사: 기술 일치 후보가 벡터 상위 K 밖이면 vectorSim 없음 → vector=0 (matching_lanes.md A 칸)
  const pool = via.size > 0 ? legacy.filter((r) => via.has(r.candidateId)) : legacy;

  // C 단계 계산식 (결정적)
  const byId = new Map(passed.map((p) => [p.id, p]));
  const inputs: RankInput[] = pool.map((r) => {
    const p = byId.get(r.candidateId)!;
    const norm = norms.get(r.candidateId);
    return {
      id: r.candidateId,
      skills: p.skills ?? [],
      roleAffinity: r.roleAffinity,
      hasRoles: !!norm && norm.roles.length > 0,
      totalYears: norm?.total_years == null ? null : Number(norm.total_years),
      vectorSim: vec?.get(r.candidateId) ?? null,
      activityAt: norm?.changed_at ?? null,
    };
  });
  const scored = rankCandidates(dict, req, inputs, ew, { vectorAvailable: !!vec && vec.size > 0, now: Date.now() });
  const legacyById = new Map(pool.map((r) => [r.candidateId, r]));
  const ranked: JdPlanRankedCandidate[] = scored.map((s) => ({
    ...legacyById.get(s.id)!,
    rankScore: s.rankScore,
    scoreBreakdown: s.breakdown,
    analyzable: s.analyzable,
    via: via.get(s.id) ?? [],
  }));

  // 저장 키: 기본(LLM 정규화) 경로는 jdHash 그대로 (fit_reports 조인 키와 같음).
  // 헤드헌터 조정본·직접 키워드처럼 요건이 다르면 `${jdHash}:${reqHash 앞 8자}` 로 분리해 서로 덮지 않게 한다.
  const rHash = reqHash(req);
  const baseHash = jdHash(jd);
  const defaultPath = !reqOverride && clientRole !== "developer" && clientRole !== "designer";
  const storeKey = defaultPath ? baseHash : `${baseHash}:${rHash.slice(0, 8)}`;
  const top = scored.slice(0, C_TOP_N);
  // 헌법 2조: HTTP 응답을 DB 저장(select·upsert·delete)으로 붙잡지 않는다 — fire-and-forget, 실패는 로그·Sentry
  const scoresSaved: "queued" | "skipped" = top.length > 0 ? "queued" : "skipped";
  if (top.length > 0) {
    void saveMatchScores(storeKey, rHash, req, ew, top, inputs).catch((e) => {
      console.warn("[jdPlan] match_scores 저장 실패:", e instanceof Error ? e.message : e);
      Sentry.captureException(e);
    });
  }

  return {
    role: req.legacy_role,
    roleConfidence: req.role_confidence,
    keywords: [...req.must_skills, ...(req.must_any_of ?? []).flat(), ...req.nice_skills],
    totalInRole: candidates.length,
    matchedCount: matched.length,
    ranked,
    requirements: req,
    filteredOut,
    normalizedCount: norms.size,
    vectorStage: vec && vec.size > 0 ? "applied" : "skipped",
    weightsVersion: ew.version,
    analyzableCount: ranked.filter((r) => r.analyzable).length,
    scoresSaved,
  };
}

/** B 단계 벡터 검색 (SQL 022 fit.match_candidate_norms). 컬럼·함수가 없거나 실패하면 null → 벡터 단계 생략 */
async function vectorTopK(jd: string): Promise<Map<string, number> | null> {
  // 임베딩 생성은 job_requirements_norm 에 캐시 행이 없을 때만 1회 (HTTP 경로 안 유일한 외부 호출, 헌법 2조 예외로 허용)
  const emb = await getJobEmbedding(jd);
  if (!emb) return null;
  const { data, error } = await db.rpc("match_candidate_norms", { query_embedding: JSON.stringify(emb), match_count: B_TOP_K });
  if (error) {
    console.warn("[jdPlan] 벡터 단계 생략:", error.code ?? error.message);
    return null;
  }
  const out = new Map<string, number>();
  for (const r of (data ?? []) as { candidate_id: string; similarity: number }[]) out.set(r.candidate_id, Number(r.similarity));
  return out;
}

const SAFE_ID = /^[A-Za-z0-9_-]+$/;

/** 사용한 요건의 해시 (score_breakdown.reqHash). 같은 jd 라도 요건이 다르면 다른 계열 */
export function reqHash(req: JobRequirements): string {
  return createHash("sha256").update(JSON.stringify(req)).digest("hex");
}

/**
 * 상위 C_TOP_N 을 fit.match_scores(stage='ranked') 로 저장 (응답 뒤 비동기 호출). 024 미적용이면 skipped.
 * 같은 키·같은 reqHash 계열의 이전 ranked 행 중 이번에 빠진 것만 지운다.
 */
async function saveMatchScores(hash: string, rHash: string, req: JobRequirements, ew: EffectiveWeights, top: RankResult[], inputs: RankInput[]): Promise<number | "skipped"> {
  const inById = new Map(inputs.map((i) => [i.id, i]));
  const now = new Date().toISOString();
  type Prev = { candidate_id: string; inputs_hash: string; stage: string; score_breakdown: { reqHash?: string } | null };
  const { data: prev, error: prevErr } = await db.from("match_scores").select("candidate_id, inputs_hash, stage, score_breakdown").eq("jd_hash", hash);
  if (prevErr) {
    console.warn("[jdPlan] match_scores 저장 생략:", prevErr.code ?? prevErr.message);
    return "skipped";
  }
  const prevRows = (prev ?? []) as Prev[];
  // D 단계가 이미 진행한 행(stage≠ranked)은 입력이 같으면 건드리지 않는다
  const progressed = new Map(prevRows.filter((r) => r.stage !== "ranked").map((r) => [r.candidate_id, r.inputs_hash]));
  const rows = top.map((t) => ({
    jd_hash: hash,
    candidate_id: t.id,
    inputs_hash: inputsHash(req, ew.version, inById.get(t.id)!),
    rank_score: t.rankScore,
    score_breakdown: { ...t.breakdown, reqHash: rHash },
    stage: "ranked",
    fit_report_id: null, // 재순위로 ranked 로 되돌리면 이전 리포트 연결을 끊는다
    updated_at: now,
  })).filter((r) => progressed.get(r.candidate_id) !== r.inputs_hash);
  const { error } = await db.from("match_scores").upsert(rows, { onConflict: "jd_hash,candidate_id" });
  if (error) {
    console.warn("[jdPlan] match_scores 저장 생략:", error.code ?? error.message);
    return "skipped";
  }
  const keep = new Set(top.map((t) => t.id));
  const stale = prevRows
    .filter((r) => r.stage === "ranked" && !keep.has(r.candidate_id) && r.score_breakdown?.reqHash === rHash && SAFE_ID.test(r.candidate_id))
    .map((r) => r.candidate_id);
  for (let i = 0; i < stale.length; i += 200) {
    await db.from("match_scores").delete().eq("jd_hash", hash).eq("stage", "ranked").in("candidate_id", stale.slice(i, i + 200));
  }
  return top.length;
}

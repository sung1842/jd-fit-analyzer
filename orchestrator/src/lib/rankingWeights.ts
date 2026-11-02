/**
 * 층별 가중치 보정 (22 문서 §7.2, E6b).
 *   w_final[i] = w_global[i] × (1 + b_company[i]·α_c) × (1 + b_recruiter[i]·α_r),  α = min(1, max(0,(n-30)/70)),  b ∈ [-0.2, 0.2],  합 100 재정규화
 * 읽기(getEffectiveWeights)는 ranking_weights 를 10분 캐시로 읽는다. 테이블·행이 없으면 DEFAULT_RANK_WEIGHTS·boost {}·version "default".
 * 학습(recomputeRankingWeights)은 큐 워커에서만 돈다 (헌법 2조) — queue/weightsScheduler.ts.
 *
 * 학습 방식: 그룹 평균 차이 (로지스틱 회귀 대신). 결정 수가 적고(층별 수십 건) 항목이 서로 상관돼 회귀 계수가 불안정하므로,
 *   d_i = mean(x_i | 승인) - mean(x_i | 거절)  (x_i ∈ [0,1] 은 score_breakdown 항목값)
 *   b_i = clamp(d_i(층) - d_i(전체), ±0.2)
 * "이 층은 전체보다 항목 i 를 더 중시한다"를 그대로 읽을 수 있고, 한쪽 그룹이 비면 0 으로 떨어져 안전하다.
 * 편향 차단: 항목은 must/nice/years/role/vector/activity 만 (RANK_ITEMS 밖의 키는 읽지도 쓰지도 않는다).
 */
import { DEFAULT_RANK_WEIGHTS, type EffectiveWeights, type RankWeights, type WeightScope } from "../../../shared/matchTypes.js";

export const RANK_ITEMS = ["must", "nice", "years", "role", "vector", "activity"] as const satisfies readonly (keyof RankWeights)[];
export const BOOST_LIMIT = 0.2;
export const MIN_DECISIONS = 30;
const CACHE_MS = 10 * 60 * 1000;

export function alpha(n: number): number {
  return Math.min(1, Math.max(0, (n - MIN_DECISIONS) / 70));
}

const clamp = (x: number, lim = BOOST_LIMIT) => (Number.isFinite(x) ? Math.max(-lim, Math.min(lim, x)) : 0);

/** jsonb → 허용 항목만 남긴 비율 (클램프) */
export function sanitizeBoost(raw: unknown): Partial<RankWeights> {
  const out: Partial<RankWeights> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const k of RANK_ITEMS) {
    const v = Number((raw as Record<string, unknown>)[k]);
    if (Number.isFinite(v) && v !== 0) out[k] = clamp(v);
  }
  return out;
}

function sanitizeWeights(raw: unknown): RankWeights {
  const w = { ...DEFAULT_RANK_WEIGHTS };
  if (raw && typeof raw === "object") {
    for (const k of RANK_ITEMS) {
      const v = Number((raw as Record<string, unknown>)[k]);
      if (Number.isFinite(v) && v >= 0) w[k] = v;
    }
  }
  return RANK_ITEMS.some((k) => w[k] > 0) ? w : { ...DEFAULT_RANK_WEIGHTS };
}

/** 합 100 재정규화 (소수 둘째 자리, 반올림 오차는 가장 큰 항목에 흡수) */
export function normalize100(w: RankWeights): RankWeights {
  const sum = RANK_ITEMS.reduce((s, k) => s + w[k], 0);
  if (sum <= 0) return { ...DEFAULT_RANK_WEIGHTS };
  const out = {} as RankWeights;
  for (const k of RANK_ITEMS) out[k] = Math.round((w[k] / sum) * 10000) / 100;
  const diff = Math.round((100 - RANK_ITEMS.reduce((s, k) => s + out[k], 0)) * 100) / 100;
  const top = RANK_ITEMS.reduce((a, b) => (out[a] >= out[b] ? a : b));
  out[top] = Math.round((out[top] + diff) * 100) / 100;
  return out;
}

export interface WeightRow {
  scope: "global" | "company" | "recruiter";
  scope_id: string;
  weights: unknown;
  sample_n: number;
  version: number;
}

/** 순수 결합. 반환 boost 는 α 를 곱한 실제 반영 비율 (UI "이 기업 기준 반영" 설명용). */
export function combineWeights(rows: { global?: WeightRow | null; company?: WeightRow | null; recruiter?: WeightRow | null }): EffectiveWeights {
  if (!rows.global && !rows.company && !rows.recruiter) return { weights: { ...DEFAULT_RANK_WEIGHTS }, boost: {}, version: "default" };
  const base = rows.global ? sanitizeWeights(rows.global.weights) : { ...DEFAULT_RANK_WEIGHTS };
  const applied: EffectiveWeights["boost"] = {};
  const w = { ...base };
  for (const layer of ["company", "recruiter"] as const) {
    const row = rows[layer];
    if (!row) continue;
    const a = alpha(row.sample_n);
    if (a === 0) continue; // T7: 결정 30건 미만은 보정 0
    const b = sanitizeBoost(row.weights);
    const eff: Partial<RankWeights> = {};
    for (const k of RANK_ITEMS) {
      const e = (b[k] ?? 0) * a;
      if (e === 0) continue;
      eff[k] = Math.round(e * 10000) / 10000;
      w[k] *= 1 + e;
    }
    if (Object.keys(eff).length) applied[layer] = eff;
  }
  const version = [rows.global && `g${rows.global.version}`, rows.company && `c${rows.company.version}`, rows.recruiter && `r${rows.recruiter.version}`].filter(Boolean).join("-");
  return { weights: normalize100(w), boost: applied, version };
}

// ───────── 읽기 (10분 메모리 캐시) ─────────
const MISSING = new Set(["42P01", "42703", "PGRST204", "PGRST205"]);
const isMissing = (err: { code?: string } | null | undefined) => Boolean(err && err.code && MISSING.has(err.code));

type Fetcher = (keys: { scope: string; scope_id: string }[]) => Promise<WeightRow[] | null>;
let fetcher: Fetcher = async (keys) => {
  const { db } = await import("./db.js");
  // or() 문자열 조립 대신 in() 조회 후 코드에서 (scope, scope_id) 정확히 거른다
  const ids = [...new Set(keys.map((k) => k.scope_id))];
  const { data, error } = await db.from("ranking_weights").select("scope, scope_id, weights, sample_n, version").in("scope_id", ids);
  if (error) {
    if (!isMissing(error)) console.warn(`[rankingWeights] 조회 실패 — 기본값 사용: ${error.message}`);
    return null;
  }
  return ((data ?? []) as WeightRow[]).filter((r) => keys.some((k) => k.scope === r.scope && k.scope_id === r.scope_id));
};
const cache = new Map<string, { at: number; value: EffectiveWeights }>();

/** 테스트용 */
export function __setWeightFetcher(f: Fetcher): void {
  fetcher = f;
  cache.clear();
}
export function clearWeightsCache(): void {
  cache.clear();
}

export async function getEffectiveWeights(scope: WeightScope): Promise<EffectiveWeights> {
  const companyId = scope.companyId || null;
  const recruiterId = scope.recruiterId || null;
  const key = `${companyId ?? ""}|${recruiterId ?? ""}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;

  const keys = [{ scope: "global", scope_id: "-" }];
  if (companyId) keys.push({ scope: "company", scope_id: companyId });
  if (recruiterId) keys.push({ scope: "recruiter", scope_id: recruiterId });
  let value: EffectiveWeights;
  try {
    const rows = await fetcher(keys);
    const find = (s: string, id: string | null) => (id === null ? null : rows?.find((r) => r.scope === s && r.scope_id === id) ?? null);
    value = rows ? combineWeights({ global: find("global", "-"), company: find("company", companyId), recruiter: find("recruiter", recruiterId) }) : combineWeights({});
  } catch (err) {
    console.warn(`[rankingWeights] 조회 예외 — 기본값 사용: ${err instanceof Error ? err.message : err}`);
    value = combineWeights({});
  }
  cache.set(key, { at: Date.now(), value });
  return value;
}

// ───────── 학습 (큐 워커 전용) ─────────
export interface TrainingSample {
  decision: "approved" | "rejected";
  breakdown: Partial<Record<keyof RankWeights, number>>;
  companyId: string | null;
  recruiterId: string | null;
}

/** 항목별 승인-거절 평균 차이. 한쪽 그룹이 비면 0 */
export function meanGap(samples: TrainingSample[]): Record<keyof RankWeights, number> {
  const out = {} as Record<keyof RankWeights, number>;
  for (const k of RANK_ITEMS) {
    const vals = (d: "approved" | "rejected") => samples.filter((s) => s.decision === d).map((s) => Number(s.breakdown[k])).filter((v) => Number.isFinite(v));
    const a = vals("approved");
    const r = vals("rejected");
    out[k] = a.length && r.length ? a.reduce((x, y) => x + y, 0) / a.length - r.reduce((x, y) => x + y, 0) / r.length : 0;
  }
  return out;
}

export function learnBoosts(samples: TrainingSample[]): { company: Map<string, { boost: Partial<RankWeights>; n: number }>; recruiter: Map<string, { boost: Partial<RankWeights>; n: number }> } {
  const global = meanGap(samples);
  const layer = (pick: (s: TrainingSample) => string | null) => {
    const groups = new Map<string, TrainingSample[]>();
    for (const s of samples) {
      const id = pick(s);
      if (!id) continue;
      const g = groups.get(id) ?? [];
      g.push(s);
      groups.set(id, g);
    }
    const out = new Map<string, { boost: Partial<RankWeights>; n: number }>();
    for (const [id, g] of groups) {
      const gap = meanGap(g);
      const boost: Partial<RankWeights> = {};
      // 승인·거절 한쪽만 있는 층은 비교 근거가 없다 → 보정 없음 (전체 대비 음수로 깎이지 않게)
      const hasBoth = g.some((s) => s.decision === "approved") && g.some((s) => s.decision === "rejected");
      for (const k of hasBoth ? RANK_ITEMS : []) {
        const b = Math.round(clamp(gap[k] - global[k]) * 10000) / 10000;
        if (b !== 0) boost[k] = b;
      }
      out.set(id, { boost, n: g.length });
    }
    return out;
  };
  return { company: layer((s) => s.companyId), recruiter: layer((s) => s.recruiterId) };
}

// match_scores(레인 A, 024) 한 행. 키는 (jd_hash, candidate_id) — fit_reports 와 같다. fit_report_id 는 채워지지 않으므로 쓰지 않는다.
export interface MatchScoreRow {
  jd_hash: string;
  candidate_id: string;
  /** {items:{must,...}, weights, boost, weightsVersion, excluded:[...], mustUnmet, raw} */
  score_breakdown: { items?: Record<string, unknown>; excluded?: unknown } | null;
}

/** 순수: match_scores × 결정 → 학습 샘플. 같은 (공고, 후보)를 여러 사람이 결정했으면 결정마다 1샘플. excluded 항목(벡터 없음 등)은 빼서 평균에 안 넣는다. */
export function buildTrainingSamples(rows: MatchScoreRow[], decisions: { jdHash: string; candidateId: string; decision: "approved" | "rejected"; companyId: string | null; recruiterId: string }[]): TrainingSample[] {
  const byKey = new Map<string, MatchScoreRow>();
  for (const r of rows) byKey.set(`${r.jd_hash}|${r.candidate_id}`, r);
  const out: TrainingSample[] = [];
  for (const d of decisions) {
    const items = byKey.get(`${d.jdHash}|${d.candidateId}`)?.score_breakdown?.items;
    if (!items || typeof items !== "object") continue;
    const ex = byKey.get(`${d.jdHash}|${d.candidateId}`)!.score_breakdown!.excluded;
    const excluded = new Set(Array.isArray(ex) ? ex : []);
    const breakdown: TrainingSample["breakdown"] = {};
    for (const k of RANK_ITEMS) {
      if (excluded.has(k)) continue;
      const v = Number(items[k]);
      if (Number.isFinite(v)) breakdown[k] = Math.max(0, Math.min(1, v));
    }
    out.push({ decision: d.decision, breakdown, companyId: d.companyId, recruiterId: d.recruiterId });
  }
  return out;
}

/** match_scores 가 없으면 [] */
export async function loadTrainingSamples(): Promise<TrainingSample[]> {
  const { db } = await import("./db.js");
  const { extractDecisions, loadQualityInput } = await import("./matchQuality.js");
  const decisions = extractDecisions(await loadQualityInput());
  if (decisions.length === 0) return [];
  const rows: MatchScoreRow[] = [];
  const hashes = [...new Set(decisions.map((d) => d.jdHash))];
  for (let i = 0; i < hashes.length; i += 100) {
    const ms = await db.from("match_scores").select("jd_hash, candidate_id, score_breakdown").in("jd_hash", hashes.slice(i, i + 100));
    if (ms.error) {
      if (isMissing(ms.error)) return [];
      throw new Error(`match_scores 조회 실패: ${ms.error.message}`);
    }
    rows.push(...((ms.data ?? []) as MatchScoreRow[]));
  }
  return buildTrainingSamples(rows, decisions);
}

export interface WeightUpsert {
  scope: "company" | "recruiter";
  scope_id: string;
  weights: Partial<RankWeights>;
  sample_n: number;
  version: number;
  updated_at: string;
}

/** 순수: 학습 결과 + 기존 행 → upsert 목록. 버전은 +1, 이번 학습에 없는 기존 층 행은 boost {}·sample_n 0 으로 덮는다 (오래된 보정이 남지 않게). */
export function planWeightUpserts(learned: ReturnType<typeof learnBoosts>, existing: { scope: string; scope_id: string; version: number }[], now: string): WeightUpsert[] {
  const ver = new Map(existing.map((r) => [`${r.scope}|${r.scope_id}`, r.version]));
  const out: WeightUpsert[] = [];
  const seen = new Set<string>();
  for (const scope of ["company", "recruiter"] as const) {
    for (const [id, v] of learned[scope]) {
      seen.add(`${scope}|${id}`);
      out.push({ scope, scope_id: id, weights: v.boost, sample_n: v.n, version: (ver.get(`${scope}|${id}`) ?? 0) + 1, updated_at: now });
    }
  }
  for (const r of existing) {
    if ((r.scope !== "company" && r.scope !== "recruiter") || seen.has(`${r.scope}|${r.scope_id}`)) continue;
    out.push({ scope: r.scope, scope_id: r.scope_id, weights: {}, sample_n: 0, version: r.version + 1, updated_at: now });
  }
  return out;
}

export interface RecomputeDeps {
  loadSamples: () => Promise<TrainingSample[]>;
  /** null = 테이블 없음 */
  loadExisting: () => Promise<{ scope: string; scope_id: string; version: number }[] | null>;
  save: (rows: WeightUpsert[]) => Promise<void>;
}

const dbDeps: RecomputeDeps = {
  loadSamples: loadTrainingSamples,
  loadExisting: async () => {
    const { db } = await import("./db.js");
    const { data, error } = await db.from("ranking_weights").select("scope, scope_id, version").in("scope", ["company", "recruiter"]);
    if (error) {
      if (isMissing(error)) return null;
      throw new Error(`ranking_weights 조회 실패: ${error.message}`);
    }
    return (data ?? []) as { scope: string; scope_id: string; version: number }[];
  },
  save: async (rows) => {
    const { db } = await import("./db.js");
    const { error } = await db.from("ranking_weights").upsert(rows, { onConflict: "scope,scope_id" });
    if (error) throw new Error(`ranking_weights 저장 실패: ${error.message}`);
  },
};

/** 큐 워커 전용 (queue/weightsScheduler.ts). HTTP 에서 부르지 않는다. */
export async function recomputeRankingWeights(deps: RecomputeDeps = dbDeps): Promise<{ samples: number; company: number; recruiter: number; reset: number; skipped?: string }> {
  const existing = await deps.loadExisting();
  if (existing === null) return { samples: 0, company: 0, recruiter: 0, reset: 0, skipped: "table_missing" };
  const samples = await deps.loadSamples();
  const learned = learnBoosts(samples);
  const upserts = planWeightUpserts(learned, existing, new Date().toISOString());
  if (upserts.length) await deps.save(upserts);
  cache.clear();
  const reset = upserts.filter((u) => u.sample_n === 0).length;
  return { samples: samples.length, company: learned.company.size, recruiter: learned.recruiter.size, reset, ...(samples.length === 0 && { skipped: "no_samples" }) };
}

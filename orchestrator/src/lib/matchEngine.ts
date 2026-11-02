import { DEFAULT_RANK_WEIGHTS, type EffectiveWeights, type RankWeights, type WeightScope } from "../../../shared/matchTypes.js";
import { createHash } from "node:crypto";
import type { JobRequirements } from "./jobRequirements.js";
import type { SkillDictionary } from "./skillDictionary.js";

/**
 * 22 문서 §6.4 C 단계 계산식 (E5). 결정적 — LLM·DB·시계 없음 (now 는 인자로 받는다).
 * 가중치는 인자로 받는다 (레인 B getEffectiveWeights 결과 또는 기본값).
 */

export const C_TOP_N = Number(process.env.C_TOP_N || 30);
export const D_MIN_RANK = Number(process.env.D_MIN_RANK || 60);
export const B_TOP_K = Number(process.env.B_TOP_K || 300);
/** 계층 인정 등은 dict.matchScore 가 처리 (정확 1, 하위 기술 0.7) */
export const MUST_UNMET_CAP = 50;

export type RankItem = keyof RankWeights;
export const RANK_ITEMS: RankItem[] = ["must", "nice", "years", "role", "vector", "activity"];

export interface RankInput {
  id: string;
  skills: string[];
  /** 공고 직무와의 인접도. null = 공고에 직무 없음(1.0) 또는 후보 직무 모름(0.5) */
  roleAffinity: number | null;
  /** 후보 직무 정보 유무 (정규화 여부) */
  hasRoles: boolean;
  totalYears: number | null;
  /** B 단계 코사인 유사도. 벡터 단계에서 상위 K 밖이거나 의미 지문 없으면 null(0 처리) */
  vectorSim: number | null;
  /** 최근 활동 근사 시각 (candidate_profiles_norm.changed_at). 없으면 null */
  activityAt: string | null;
}

export interface ScoreBreakdown {
  items: Record<RankItem, number>;
  weights: RankWeights;
  boost: EffectiveWeights["boost"];
  weightsVersion: string;
  /** 벡터 단계가 없어 계산에서 뺀 항목 (남은 가중치로 100점 환산) */
  excluded: RankItem[];
  mustUnmet: boolean;
  /** 상한 적용 전 점수 */
  raw: number;
}

export interface RankResult {
  id: string;
  rankScore: number;
  breakdown: ScoreBreakdown;
  missingMust: string[];
  /** D 단계 정밀 분석 후보 (rank ≥ D_MIN_RANK) */
  analyzable: boolean;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const DAY = 86_400_000;

export function yearsItem(req: Pick<JobRequirements, "years_min" | "years_max">, years: number | null): number {
  if (req.years_min == null && req.years_max == null) return 1;
  if (years == null) return 0.5; // 경력 정보 없음 — 중립
  const lo = req.years_min ?? -Infinity;
  const hi = req.years_max ?? Infinity;
  const gap = years < lo ? lo - years : years > hi ? years - hi : 0;
  return Math.max(0, 1 - 0.25 * gap);
}

export function activityItem(at: string | null, now: number): number {
  if (!at) return 0.2;
  const t = Date.parse(at);
  if (!Number.isFinite(t)) return 0.2;
  const days = (now - t) / DAY;
  return days <= 30 ? 1 : days <= 90 ? 0.5 : 0.2;
}

/**
 * 필수 충족 계산 (A2). 필수 기술은 각각 1칸, 택일 그룹은 그룹당 1칸(그룹 안 최고 일치 점수). 경험 문장은 세지 않는다.
 * missing 에는 기술명 또는 "A 또는 B" 로 남긴다.
 */
export function mustCoverage(
  dict: SkillDictionary,
  req: Pick<JobRequirements, "must_skills" | "must_any_of">,
  skills: string[]
): { hit: number; total: number; matched: string[]; missing: string[] } {
  let hit = 0;
  const matched: string[] = [];
  const missing: string[] = [];
  for (const kw of req.must_skills) {
    const s = dict.matchScore(kw, skills);
    if (s > 0) {
      hit += s;
      matched.push(kw);
    } else missing.push(kw);
  }
  for (const g of req.must_any_of ?? []) {
    if (g.length === 0) continue;
    let best = 0;
    let bestKw = g[0];
    for (const kw of g) {
      const s = dict.matchScore(kw, skills);
      if (s > best) [best, bestKw] = [s, kw];
    }
    if (best > 0) {
      hit += best;
      matched.push(bestKw);
    } else missing.push(g.join(" 또는 "));
  }
  return { hit, total: req.must_skills.length + (req.must_any_of ?? []).filter((g) => g.length > 0).length, matched, missing };
}

export function scoreCandidate(
  dict: SkillDictionary,
  req: Pick<JobRequirements, "role" | "must_skills" | "must_any_of" | "nice_skills" | "years_min" | "years_max">,
  c: RankInput,
  ew: EffectiveWeights,
  opts: { vectorAvailable: boolean; now: number }
): RankResult {
  const cov = mustCoverage(dict, req, c.skills);
  const missingMust = cov.missing;
  let niceHit = 0;
  for (const kw of req.nice_skills) niceHit += dict.matchScore(kw, c.skills);

  const items: Record<RankItem, number> = {
    must: cov.total ? cov.hit / cov.total : 1,
    nice: req.nice_skills.length ? niceHit / req.nice_skills.length : 1,
    years: yearsItem(req, c.totalYears),
    role: !req.role ? 1 : c.roleAffinity != null && c.hasRoles ? c.roleAffinity : 0.5,
    vector: Math.min(1, Math.max(0, c.vectorSim ?? 0)),
    activity: activityItem(c.activityAt, opts.now),
  };
  for (const k of RANK_ITEMS) items[k] = r3(items[k]);

  const excluded: RankItem[] = opts.vectorAvailable ? [] : ["vector"];
  const w = ew.weights;
  let wSum = 0;
  let sum = 0;
  for (const k of RANK_ITEMS) {
    if (excluded.includes(k)) continue;
    wSum += w[k];
    sum += w[k] * items[k];
  }
  const raw = wSum > 0 ? r2((sum / wSum) * 100) : 0;
  const mustUnmet = missingMust.length > 0;
  const rankScore = mustUnmet ? Math.min(raw, MUST_UNMET_CAP) : raw;
  return {
    id: c.id,
    rankScore,
    breakdown: { items, weights: w, boost: ew.boost, weightsVersion: ew.version, excluded, mustUnmet, raw },
    missingMust,
    analyzable: rankScore >= D_MIN_RANK,
  };
}

/** 점수 내림차순 → 상한(50) 동점은 상한 전 점수 → id 순 (결정성 T5) */
export function rankCandidates(
  dict: SkillDictionary,
  req: Parameters<typeof scoreCandidate>[1],
  cands: RankInput[],
  ew: EffectiveWeights,
  opts: { vectorAvailable: boolean; now: number }
): RankResult[] {
  return cands.map((c) => scoreCandidate(dict, req, c, ew, opts)).sort((a, b) => b.rankScore - a.rankScore || b.breakdown.raw - a.breakdown.raw || a.id.localeCompare(b.id));
}

export const DEFAULT_EFFECTIVE_WEIGHTS: EffectiveWeights = { weights: DEFAULT_RANK_WEIGHTS, boost: {}, version: "default" };

/** 레인 B lib/rankingWeights.ts 가 있으면 쓰고, 없거나 실패하면 기본값 (파일 미존재 호환을 위해 동적 import) */
type WeightsModule = { getEffectiveWeights?: (s: WeightScope) => Promise<EffectiveWeights> };
const RANKING_WEIGHTS_SPEC = "./rankingWeights.js";
export async function loadEffectiveWeights(
  scope: WeightScope = {},
  importer: () => Promise<unknown> = () => import(RANKING_WEIGHTS_SPEC)
): Promise<EffectiveWeights> {
  try {
    const mod = (await importer()) as WeightsModule;
    if (typeof mod.getEffectiveWeights !== "function") return DEFAULT_EFFECTIVE_WEIGHTS;
    const ew = await mod.getEffectiveWeights(scope);
    return ew?.weights ? ew : DEFAULT_EFFECTIVE_WEIGHTS;
  } catch {
    return DEFAULT_EFFECTIVE_WEIGHTS;
  }
}

/** match_scores.inputs_hash: 공고 요건 + 가중치 버전 + 후보 입력 */
export function inputsHash(req: unknown, weightsVersion: string, c: RankInput): string {
  return createHash("sha256").update(JSON.stringify([req, weightsVersion, [...c.skills].sort(), c.roleAffinity, c.totalYears, c.vectorSim, c.activityAt])).digest("hex");
}

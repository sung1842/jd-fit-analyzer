import { createHash } from "node:crypto";
import type { CandidatePortfolio } from "../../../shared/types.js";
import { callMcpTool } from "../mcp/client.js";
import { db } from "./db.js";
import { cleanSkill, getSkillDictionary, recordUnmapped, type SkillDictionary } from "./skillDictionary.js";

/**
 * 후보 정규화 + 변경 감지 (22 문서 E2, SQL 020). 정규화 큐(queue/normalizeQueue.ts)에서만 호출한다 (헌법 2조).
 *
 * 변경 감지 4단계 — 앞 단계에서 멈출수록 싸다:
 *   1 same_hash     매칭 관련 필드 전체를 정리(cleanText)한 해시가 같음               → 비용 0
 *   2 (분기)        선택형 칸(직무·기술·경력 기간·희망) 해시가 같으면 자유 서술만 바뀐 것 → 3 으로, 다르면 4 로
 *   3 same_meaning  자유 서술 임베딩 코사인 ≥ NARRATIVE_SAME_THRESHOLD                  → 임베딩 1회
 *   4 same_result   LLM 정규화 결과(역할·기술·연수·태그)가 이전과 같음                   → LLM 1회, 재매칭 안 함
 *   changed/created 결과가 바뀜 → changed_at 갱신 (E7 상시 수색이 이 시각으로 재매칭 대상을 고른다)
 */
export const MATCH_NORM_VERSION = Number(process.env.MATCH_NORM_VERSION || 1);
export const NARRATIVE_SAME_THRESHOLD = Number(process.env.NARRATIVE_SAME_THRESHOLD || 0.95);
const NARRATIVE_MAX_CHARS = 6000;

export type NormOutcome = "created" | "changed" | "same_hash" | "same_meaning" | "same_result" | "not_found" | "deferred";

export interface NormalizedSkill {
  name: string;
  years: number | null;
  professional: boolean;
}

/** normalize_candidate MCP tool 출력 */
export interface RawNormalized {
  roles: string[];
  skills: NormalizedSkill[];
  total_years: number | null;
  tags: string[];
  prefs: { locations: string[]; remote: boolean | null };
}

export interface StoredNorm {
  candidate_id: string;
  source_hash: string;
  fields_hash: string;
  norm_version: number;
  roles: string[];
  skills: NormalizedSkill[];
  total_years: number | null;
  tags: string[];
  narrative_embedding: number[] | string | null;
}

/** 공백·대소문자·따옴표 차이를 지운다 (해시 입력용). */
export function cleanText(s: string | null | undefined): string {
  return (s ?? "")
    .normalize("NFKC")
    .replace(/[“”‘’"'`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** 선택형 칸 — 문장을 다시 써도 값이 그대로인 부분. 순서 차이는 무시한다. */
export function structuredFields(p: CandidatePortfolio): string {
  const r = p.resume;
  const sorted = (xs: string[]) => [...new Set(xs.map(cleanText).filter(Boolean))].sort();
  return JSON.stringify({
    role: p.role,
    title: cleanText(p.title),
    skills: sorted(p.skills ?? []),
    experiences: (r?.experiences ?? []).map((e) => [cleanText(e.company), cleanText(e.position), cleanText(e.period)]).sort(),
    desired: sorted(r?.desired_categories ?? []),
    region: cleanText(r?.region),
    certifications: sorted(r?.certifications ?? []),
  });
}

/** 자유 서술 — AI 로 다시 쓰기 쉬운 부분. 의미 지문(임베딩) 비교 대상. */
export function narrativeText(p: CandidatePortfolio): string {
  const r = p.resume;
  const parts = [
    p.short_bio,
    p.long_bio,
    r?.headline,
    ...(r?.experiences ?? []).flatMap((e) => [e.duties, e.achievements]),
    ...(p.evidence_cards ?? []).map((c) => c.claim),
  ];
  return parts
    .map((s) => (s ?? "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, NARRATIVE_MAX_CHARS);
}

export function hashes(p: CandidatePortfolio): { sourceHash: string; fieldsHash: string } {
  const fields = structuredFields(p);
  return { fieldsHash: sha256(fields), sourceHash: sha256(`${fields}\n${cleanText(narrativeText(p))}`) };
}

export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** pgvector 컬럼은 PostgREST 에서 "[0.1,0.2]" 문자열로 온다 */
export function parseVector(v: number[] | string | null | undefined): number[] | null {
  if (!v) return null;
  if (Array.isArray(v)) return v;
  try {
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** LLM 출력 기술명을 표준 사전으로 매핑. 같은 canonical 은 연수 큰 값·실무 여부 OR 로 합친다.
 *  사전 밖 기술은 이름(unmapped)과 함께 연수·실무 여부(unmappedDetails)도 돌려준다 → SQL 027 에 저장해 사전이 바뀌면 LLM 없이 재매핑. */
export function mapSkills(
  dict: SkillDictionary,
  skills: NormalizedSkill[]
): { skills: NormalizedSkill[]; unmapped: string[]; unmappedDetails: NormalizedSkill[] } {
  const merged = new Map<string, NormalizedSkill>();
  const details = new Map<string, NormalizedSkill>();
  const mergeInto = (m: Map<string, NormalizedSkill>, key: string, s: NormalizedSkill, name: string) => {
    const prev = m.get(key);
    m.set(key, {
      name: prev?.name ?? name,
      years: prev?.years == null ? (s.years ?? null) : s.years == null ? prev.years : Math.max(prev.years, s.years),
      professional: (prev?.professional ?? false) || !!s.professional,
    });
  };
  for (const s of skills) {
    if (!s || typeof s.name !== "string" || !s.name.trim()) continue;
    const canonical = dict.canonical(s.name);
    if (canonical) mergeInto(merged, canonical, s, canonical);
    else mergeInto(details, cleanSkill(s.name), s, s.name.trim());
  }
  const unmappedDetails = [...details.values()].sort((a, b) => a.name.localeCompare(b.name));
  return {
    skills: [...merged.values()].sort((a, b) => a.name.localeCompare(b.name)),
    unmapped: unmappedDetails.map((d) => d.name),
    unmappedDetails,
  };
}

/** F1 재매핑 (순수 함수): 저장된 매핑 기술 + 사전 밖 기술 상세를 현재 사전으로 다시 나눈다. LLM 호출 없음.
 *  사전에서 빠진 canonical 은 다시 사전 밖으로 내려간다. */
export function remapStored(
  dict: SkillDictionary,
  row: { skills: NormalizedSkill[] | null; unmapped_skill_details: NormalizedSkill[] | null }
): { skills: NormalizedSkill[]; unmapped: string[]; unmappedDetails: NormalizedSkill[] } {
  return mapSkills(dict, [...(row.skills ?? []), ...(row.unmapped_skill_details ?? [])]);
}

/** 4단계 비교 대상: 매칭에 쓰이는 핵심 값만 (연수는 0.5년 단위로 반올림해 사소한 흔들림 무시) */
export function coreKey(n: { roles: string[]; skills: NormalizedSkill[]; total_years: number | null; tags: string[] }): string {
  const half = (y: number | null) => (y == null ? null : Math.round(y * 2) / 2);
  return JSON.stringify({
    roles: [...n.roles].sort(),
    skills: [...n.skills].map((s) => [s.name, half(s.years), s.professional]).sort(),
    total_years: half(n.total_years),
    tags: [...n.tags].map(cleanText).sort(),
  });
}

export type Decision = { stop: "same_hash" } | { stop: "check_meaning" } | { stop: "normalize" };

/** 1·2단계 판정 (순수 함수) */
export function decideBeforeLlm(prev: Pick<StoredNorm, "source_hash" | "fields_hash" | "norm_version" | "narrative_embedding"> | null, h: { sourceHash: string; fieldsHash: string }): Decision {
  if (!prev || prev.norm_version !== MATCH_NORM_VERSION) return { stop: "normalize" };
  if (prev.source_hash === h.sourceHash) return { stop: "same_hash" };
  if (prev.fields_hash === h.fieldsHash && parseVector(prev.narrative_embedding)) return { stop: "check_meaning" };
  return { stop: "normalize" };
}

async function embed(text: string): Promise<number[] | null> {
  if (!text) return null;
  const [v] = await callMcpTool<number[][]>("embed_texts", { texts: [text] });
  return v ?? null;
}

export interface NormResult {
  candidateId: string;
  outcome: NormOutcome;
  similarity?: number;
}

/**
 * 후보 1명 정규화 (변경 감지 포함). force=true 면 1~3 단계를 건너뛴다 (버전 변경·수동 재처리).
 * allowLlm: 4단계(LLM) 직전에만 묻는다 → 하루 상한은 비싼 단계에만 걸리고 1~3 단계 확인은 몇 번이든 한다.
 */
export async function normalizeCandidateProfile(
  candidateId: string,
  opts: { force?: boolean; allowLlm?: () => Promise<boolean> } = {}
): Promise<NormResult> {
  let portfolio: CandidatePortfolio;
  try {
    portfolio = await callMcpTool<CandidatePortfolio>("get_candidate_portfolio", { candidateId });
  } catch (err) {
    if (err instanceof Error && /찾을 수 없습니다/.test(err.message)) return { candidateId, outcome: "not_found" };
    throw err;
  }

  const { data: prevRow, error: prevErr } = await db
    .from("candidate_profiles_norm")
    .select("candidate_id, source_hash, fields_hash, norm_version, roles, skills, total_years, tags, narrative_embedding")
    .eq("candidate_id", candidateId)
    .maybeSingle();
  if (prevErr) throw new Error(`candidate_profiles_norm 조회 실패: ${prevErr.code ?? prevErr.message}`);
  const prev = prevRow as StoredNorm | null;

  const h = hashes(portfolio);
  const narrative = narrativeText(portfolio);
  const now = new Date().toISOString();
  const decision = opts.force ? ({ stop: "normalize" } as Decision) : decideBeforeLlm(prev, h);

  if (decision.stop === "same_hash") {
    await touch(candidateId, { last_outcome: "same_hash", checked_at: now });
    return { candidateId, outcome: "same_hash" };
  }

  let embedding: number[] | null = null;
  if (decision.stop === "check_meaning") {
    embedding = await embed(narrative);
    const similarity = embedding ? cosine(embedding, parseVector(prev!.narrative_embedding)!) : 0;
    if (similarity >= NARRATIVE_SAME_THRESHOLD) {
      // 의미가 같다 → 해시만 갱신(다음엔 1단계에서 멈춤). 지문은 처음 값을 유지해 조금씩 바뀌는 누적 변화를 잡는다.
      await touch(candidateId, { source_hash: h.sourceHash, last_outcome: "same_meaning", checked_at: now });
      return { candidateId, outcome: "same_meaning", similarity: round3(similarity) };
    }
  }

  if (opts.allowLlm && !(await opts.allowLlm())) {
    await touch(candidateId, { checked_at: now });
    return { candidateId, outcome: "deferred" };
  }
  const raw = await callMcpTool<RawNormalized>("normalize_candidate", { portfolio });
  const dict = await getSkillDictionary();
  const mapped = mapSkills(dict, raw.skills);
  recordUnmapped(mapped.unmapped);
  embedding ??= await embed(narrative);

  const next = { roles: raw.roles, skills: mapped.skills, total_years: raw.total_years, tags: raw.tags };
  const same = !!prev && prev.norm_version === MATCH_NORM_VERSION && coreKey(prev) === coreKey(next);
  const outcome: NormOutcome = !prev ? "created" : same ? "same_result" : "changed";

  const row: Record<string, unknown> = {
      candidate_id: candidateId,
      source_hash: h.sourceHash,
      fields_hash: h.fieldsHash,
      norm_version: MATCH_NORM_VERSION,
      ...next,
      unmapped_skills: mapped.unmapped,
      prefs: raw.prefs,
      narrative_embedding: embedding ? JSON.stringify(embedding) : null,
      last_outcome: outcome,
      normalized_at: now,
      checked_at: now,
      ...(same ? {} : { changed_at: now }),
  };
  await upsertNorm(row, mapped.unmappedDetails);
  return { candidateId, outcome };
}

async function touch(candidateId: string, patch: Record<string, unknown>): Promise<void> {
  const { error } = await db.from("candidate_profiles_norm").update(patch).eq("candidate_id", candidateId);
  if (error) throw new Error(`candidate_profiles_norm 갱신 실패: ${error.code ?? error.message}`);
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

// ---------------------------------------------------------------------------
// F1 사전 밖 기술 상세 (SQL 027 unmapped_skill_details). 미적용 DB 에서도 기존대로 동작한다.
// ---------------------------------------------------------------------------

/** 027 적용 여부 캐시: null = 아직 모름 */
let detailsColumn: boolean | null = null;

/** PostgREST 의 "컬럼 없음" 오류 (schema cache 미스 PGRST204, PG 42703) */
export function isMissingColumnError(err: { code?: string | null; message?: string | null } | null | undefined): boolean {
  if (!err) return false;
  return err.code === "PGRST204" || err.code === "42703" || /unmapped_skill_details/.test(err.message ?? "");
}

async function upsertNorm(row: Record<string, unknown>, details: NormalizedSkill[]): Promise<void> {
  if (detailsColumn !== false) {
    const { error } = await db.from("candidate_profiles_norm").upsert({ ...row, unmapped_skill_details: details }, { onConflict: "candidate_id" });
    if (!error) {
      detailsColumn = true;
      return;
    }
    if (!isMissingColumnError(error)) throw new Error(`candidate_profiles_norm 저장 실패: ${error.code ?? error.message}`);
    detailsColumn = false; // 027 미적용 → 상세 없이 저장
  }
  const { error } = await db.from("candidate_profiles_norm").upsert(row, { onConflict: "candidate_id" });
  if (error) throw new Error(`candidate_profiles_norm 저장 실패: ${error.code ?? error.message}`);
}

export interface RemapSummary {
  applied: boolean; // false = SQL 027 미적용 (아무것도 안 함)
  scanned: number;
  changed: number;
  newlyMapped: Record<string, number>; // 이번에 사전으로 들어온 canonical → 후보 수
  changedIds: string[];
}

interface RemapRow {
  candidate_id: string;
  roles: string[];
  skills: NormalizedSkill[];
  total_years: number | null;
  tags: string[];
  unmapped_skill_details: NormalizedSkill[] | null;
}

const REMAP_PAGE = 500;

/**
 * 사전이 바뀐 뒤 전체 후보 기술을 코드로 다시 매핑한다 (LLM 0회). 관리자 API → 큐 잡에서 호출 (헌법 2조).
 * 결과가 바뀐 행만 갱신하고 changed_at 을 올린다 (상시 수색이 재매칭 대상으로 고름).
 * 사전은 getSkillDictionary 의 10분 캐시를 쓰므로 사전 수정 직후라면 최대 10분 뒤 반영된다.
 */
export async function remapAllCandidates(opts: { dict?: SkillDictionary; dryRun?: boolean } = {}): Promise<RemapSummary> {
  const dict = opts.dict ?? (await getSkillDictionary());
  const summary: RemapSummary = { applied: true, scanned: 0, changed: 0, newlyMapped: {}, changedIds: [] };
  for (let from = 0; ; from += REMAP_PAGE) {
    const { data, error } = await db
      .from("candidate_profiles_norm")
      .select("candidate_id, roles, skills, total_years, tags, unmapped_skill_details")
      .order("candidate_id")
      .range(from, from + REMAP_PAGE - 1);
    if (error) {
      if (isMissingColumnError(error)) return { ...summary, applied: false };
      throw new Error(`candidate_profiles_norm 조회 실패: ${error.code ?? error.message}`);
    }
    const rows = (data ?? []) as RemapRow[];
    for (const r of rows) {
      summary.scanned++;
      const next = remapStored(dict, r);
      const before = new Set((r.skills ?? []).map((s) => s.name));
      if (coreKey({ ...r, skills: next.skills }) === coreKey({ ...r, skills: r.skills ?? [] })) continue;
      summary.changed++;
      summary.changedIds.push(r.candidate_id);
      for (const s of next.skills) if (!before.has(s.name)) summary.newlyMapped[s.name] = (summary.newlyMapped[s.name] ?? 0) + 1;
      if (opts.dryRun) continue;
      const { error: upErr } = await db
        .from("candidate_profiles_norm")
        .update({ skills: next.skills, unmapped_skills: next.unmapped, unmapped_skill_details: next.unmappedDetails, changed_at: new Date().toISOString() })
        .eq("candidate_id", r.candidate_id);
      if (upErr) throw new Error(`candidate_profiles_norm 갱신 실패: ${upErr.code ?? upErr.message}`);
    }
    if (rows.length < REMAP_PAGE) break;
  }
  return summary;
}

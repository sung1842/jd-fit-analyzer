import { callMcpTool } from "../mcp/client.js";
import { cleanText, parseVector, sha256 } from "./candidateNorm.js";
import { db } from "./db.js";
import type { SkillDictionary } from "./skillDictionary.js";

/**
 * 공고 정규화 결과 (22 문서 E3, SQL 021 fit.job_requirements_norm). 같은 JD(정리 후 해시)는 LLM 을 다시 부르지 않는다.
 * 테이블이 없으면 매번 normalize_job 을 부르고 저장은 건너뛴다.
 */
export const JOB_NORM_VERSION = Number(process.env.JOB_NORM_VERSION || 2) // 2: 택일 그룹·경험 문장 분리 (A2);

export interface JobRequirements {
  role: string | null; // null = 클라이언트가 직군 2종만 넘긴 경우 (직무 인접도 필터 안 함)
  legacy_role: "developer" | "designer";
  role_confidence: number;
  must_skills: string[];
  /** 택일 필수 그룹 — 그룹당 하나 충족이면 1 (v2~). 없으면 [] 로 취급 */
  must_any_of?: string[][];
  /** 경험·역량 문장 — 기술 매칭에 쓰지 않는다 (v2~) */
  must_experiences?: string[];
  nice_skills: string[];
  years_min: number | null;
  years_max: number | null;
  locations: string[];
  remote_ok: boolean | null;
}

export function jdKey(jd: string): string {
  return sha256(`v${JOB_NORM_VERSION}\n${cleanText(jd)}`);
}

const BASE_COLS = "norm_version, role, legacy_role, role_confidence, must_skills, nice_skills, years_min, years_max, locations, remote_ok";

/**
 * 캐시 읽기. 새 필드(must_any_of·must_experiences)는 SQL 028 의 jsonb 컬럼 req_groups 에 둔다.
 * 028 미적용이면 기본 칸만 저장(택일 항목은 must_skills 에 펼침 → 읽을 때 JD 원문으로 재묶음, 경험 문장은 캐시 적중 시 빠짐).
 * norm_version 이 현재보다 낮은 행(옛 형식)은 쓰지 않는다.
 */
export async function getJobRequirements(jd: string): Promise<JobRequirements & { cached: boolean }> {
  const key = jdKey(jd);
  let hasGroupsCol = true;
  try {
    let res = await db.from("job_requirements_norm").select(`${BASE_COLS}, req_groups`).eq("jd_key", key).maybeSingle();
    if (res.error) {
      // 컬럼 없음(028 미적용)일 때만 기본 칸으로 다시 읽는다. 다른 오류는 그대로 LLM 경로로
      if (!isMissingColumn(res.error)) throw res.error;
      hasGroupsCol = false;
      res = await db.from("job_requirements_norm").select(BASE_COLS).eq("jd_key", key).maybeSingle();
    }
    const row = res.data as (JobRequirements & { norm_version?: number; req_groups?: unknown }) | null;
    if (row && isCurrentRow(row, hasGroupsCol)) {
      const { norm_version: _v, req_groups, ...rest } = row;
      const g = parseGroups(req_groups);
      return { ...rest, ...g, years_min: num(rest.years_min), years_max: num(rest.years_max), cached: true };
    }
  } catch {
    // 테이블 미적용 — LLM 으로 계속
  }

  const raw = await callMcpTool<JobRequirements>("normalize_job", { jd });
  const req: JobRequirements = { ...raw, ...parseGroups({ must_any_of: raw.must_any_of, must_experiences: raw.must_experiences }) };
  const { must_any_of, must_experiences, ...base } = req;
  const row: Record<string, unknown> = { jd_key: key, norm_version: JOB_NORM_VERSION, ...base };
  if (hasGroupsCol) row.req_groups = { must_any_of, must_experiences };
  // 028 미적용: 택일 항목을 필수 칸에 펼쳐 둔다 → 읽을 때 refineRequirements(splitAltGroups)가 JD 원문 "A 또는 B" 로 다시 묶는다
  else row.must_skills = [...base.must_skills, ...(must_any_of ?? []).flat()];
  const { error } = await db.from("job_requirements_norm").upsert(row, { onConflict: "jd_key" });
  if (error) console.warn("[jobRequirements] 저장 생략:", error.code ?? error.message);
  return { ...req, cached: false };
}

/** PostgreSQL 42703(undefined_column) / PostgREST PGRST204(스키마 캐시에 컬럼 없음) */
export function isMissingColumn(err: { code?: string } | null | undefined): boolean {
  return err?.code === "42703" || err?.code === "PGRST204";
}

/** 캐시 행을 그대로 써도 되는가: 버전이 현재 이상이고, v2 형식이면 그룹 컬럼이 읽혔어야 한다 */
export function isCurrentRow(row: { norm_version?: number | null; req_groups?: unknown }, hasGroupsCol: boolean): boolean {
  const v = Number(row.norm_version ?? 1);
  if (!(v >= JOB_NORM_VERSION)) return false;
  // 028 미적용(컬럼 없음): 기본 칸만 캐시로 쓴다 — 택일·경험은 빠지지만 그만큼 덜 엄격해질 뿐 필수 미충족을 만들지 않는다
  return !hasGroupsCol || row.req_groups != null;
}

/** jsonb/LLM 응답 → 정리된 그룹·경험 (빈 문자열·1개짜리 그룹 정리) */
export function parseGroups(v: unknown): { must_any_of: string[][]; must_experiences: string[] } {
  const o = (v && typeof v === "object" ? v : {}) as { must_any_of?: unknown; must_experiences?: unknown };
  const str = (xs: unknown) => (Array.isArray(xs) ? xs.filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.trim()) : []);
  const groups = (Array.isArray(o.must_any_of) ? o.must_any_of : []).map(str).filter((g) => g.length > 0);
  return { must_any_of: groups, must_experiences: str(o.must_experiences) };
}

const SENTENCE_RE = /(경험|능력|역량|이해|소통|협업|설계|구축|운영|우대|이상|학위|졸업|가능자)/;

/**
 * 표준 사전 기준 재분류 (결정적). 사전에 있는 이름은 기술, 사전 밖 문장(공백 포함·역량어)은 경험으로.
 * 경험 칸에 있어도 사전 이름 그대로면(예: "Design System") 기술로 올린다. 1개짜리 택일 그룹은 필수 기술로.
 */
export function refineRequirements<T extends JobRequirements>(dict: SkillDictionary, req: T, jd?: string): T {
  if (jd) req = { ...req, ...splitAltGroups(req, jd) };
  const must: string[] = [];
  const exp: string[] = [...(req.must_experiences ?? [])];
  const groups: string[][] = [];
  for (const g of req.must_any_of ?? []) {
    const opts = g.filter((x) => dict.canonical(x) || !looksLikeSentence(x));
    if (opts.length === 1) must.push(opts[0]);
    else if (opts.length > 1) groups.push(opts);
    for (const x of g) if (!opts.includes(x)) exp.push(x);
  }
  for (const s of req.must_skills) (dict.canonical(s) || !looksLikeSentence(s) ? must : exp).push(s);
  const experiences: string[] = [];
  for (const e of exp) (dict.canonical(e) ? must : experiences).push(e);
  const uniq = (xs: string[]) => [...new Map(xs.map((x) => [dict.canonical(x) ?? x.toLowerCase(), x])).values()];
  return { ...req, must_skills: uniq(must), must_any_of: groups, must_experiences: uniq(experiences) };
}

const ALT_RE = String.raw`\s*(?:또는|혹은|이나|or)\s*`;
const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

/**
 * LLM 이 택일을 필수 2개로 뽑은 경우의 결정적 보정: JD 원문에 "A 또는 B" 로 붙어 있는 필수 기술 쌍을 택일 그룹으로 옮긴다.
 */
export function splitAltGroups(req: Pick<JobRequirements, "must_skills" | "must_any_of">, jd: string): Pick<JobRequirements, "must_skills" | "must_any_of"> {
  const must = [...req.must_skills];
  const groups = (req.must_any_of ?? []).map((g) => [...g]);
  const linked = (a: string, b: string) => new RegExp(`${esc(a)}${ALT_RE}${esc(b)}`, "i").test(jd);
  for (let i = 0; i < must.length; i++) {
    const g = [must[i]];
    for (let j = i + 1; j < must.length; j++) if (g.some((x) => linked(x, must[j]) || linked(must[j], x))) g.push(must[j]);
    if (g.length > 1) {
      groups.push(g);
      for (const x of g) must.splice(must.indexOf(x), 1);
      i--;
    }
  }
  return { must_skills: must, must_any_of: groups };
}

function looksLikeSentence(s: string): boolean {
  return SENTENCE_RE.test(s) || s.trim().split(/\s+/).length >= 3;
}

/** numeric 컬럼은 문자열로 올 수 있다 */
function num(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 22 문서 E4: 공고 임베딩 (B 단계 벡터 검색용). SQL 022 의 job_requirements_norm.embedding 컬럼이 없으면 null (벡터 단계 생략, 임베딩 호출도 안 함).
 * 캐시 행에 임베딩이 없으면 1회 계산해 채운다. 캐시 행 자체가 없으면(직군·키워드 직접 입력 경로) 계산만 하고 저장은 못 한다.
 */
export async function getJobEmbedding(jd: string): Promise<number[] | null> {
  const key = jdKey(jd);
  const { data, error } = await db.from("job_requirements_norm").select("jd_key, embedding").eq("jd_key", key).maybeSingle();
  if (error) return null; // 021/022 미적용
  const row = data as { jd_key: string; embedding: number[] | string | null } | null;
  const stored = parseVector(row?.embedding);
  if (stored) return stored;
  try {
    const [v] = await callMcpTool<number[][]>("embed_texts", { texts: [cleanText(jd).slice(0, 8000)] });
    if (!Array.isArray(v) || v.length === 0) return null;
    if (row) {
      const { error: upErr } = await db.from("job_requirements_norm").update({ embedding: JSON.stringify(v) }).eq("jd_key", key);
      if (upErr) console.warn("[jobRequirements] 임베딩 저장 생략:", upErr.code ?? upErr.message);
    }
    return v;
  } catch (err) {
    console.warn("[jobRequirements] 임베딩 실패 — 벡터 단계 생략:", err instanceof Error ? err.message : err);
    return null;
  }
}

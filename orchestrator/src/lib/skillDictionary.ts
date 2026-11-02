import { db } from "./db.js";
import { SKILL_SEED, type SkillEntry } from "./skillSeed.js";

/**
 * 표준 기술 사전 매퍼 (22 문서 E1, SQL 019).
 *
 * 비교 규칙 (LLM 없음):
 *  - 양쪽 이름을 canonical 로 바꿔 **정확히 같을 때만** 일치 1.0. 문자열 포함 비교는 하지 않는다 (Java ⊄ JavaScript).
 *  - 후보 기술이 JD 기술의 하위(parent 체인)면 부분 일치 PARENT_CREDIT (Next.js 보유 → React 요구 0.7).
 *  - 사전에 없는 이름은 정리한 문자열끼리 같을 때만 일치, 그리고 fit.skill_unmapped 에 쌓아 사전 보강 신호로 쓴다.
 */
export const PARENT_CREDIT = 0.7;
const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_PARENT_DEPTH = 5;

export function cleanSkill(raw: string): string {
  return raw.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

export class SkillDictionary {
  private readonly byAlias = new Map<string, string>();
  private readonly entries = new Map<string, SkillEntry>();

  constructor(list: SkillEntry[]) {
    for (const entry of list) {
      this.entries.set(entry.canonical, entry);
      for (const alias of [entry.canonical, ...entry.aliases]) this.byAlias.set(cleanSkill(alias), entry.canonical);
    }
  }

  /** 사전에 있으면 canonical, 없으면 null */
  canonical(raw: string): string | null {
    return this.byAlias.get(cleanSkill(raw)) ?? null;
  }

  /** canonical 의 상위 체인 (자기 자신 제외) */
  ancestors(canonical: string): string[] {
    const out: string[] = [];
    let cur = this.entries.get(canonical)?.parent ?? null;
    while (cur && out.length < MAX_PARENT_DEPTH && !out.includes(cur)) {
      out.push(cur);
      cur = this.entries.get(cur)?.parent ?? null;
    }
    return out;
  }

  /** JD 기술 1개 대비 후보 기술 목록의 일치 점수 (0 / PARENT_CREDIT / 1) */
  matchScore(jdSkill: string, candidateSkills: string[]): number {
    const want = this.canonical(jdSkill);
    if (!want) {
      const key = cleanSkill(jdSkill);
      return candidateSkills.some((s) => cleanSkill(s) === key) ? 1 : 0;
    }
    let best = 0;
    for (const s of candidateSkills) {
      const have = this.canonical(s);
      if (!have) continue;
      if (have === want) return 1;
      if (this.ancestors(have).includes(want)) best = PARENT_CREDIT;
    }
    return best;
  }

  /** 사전에 없는 이름만 골라낸다 (정리된 소문자, 중복 제거) */
  unmapped(names: string[]): string[] {
    return [...new Set(names.map(cleanSkill).filter((n) => n && !this.byAlias.has(n)))];
  }
}

/** 시드 + DB 행 병합 (같은 canonical 이면 DB 우선) */
export function mergeEntries(seed: SkillEntry[], rows: SkillEntry[]): SkillEntry[] {
  const map = new Map(seed.map((s) => [s.canonical, s]));
  for (const r of rows) map.set(r.canonical, r);
  return [...map.values()];
}

let cached: { dict: SkillDictionary; at: number } | null = null;

/** DB 사전을 10분 캐시로 읽는다. 테이블이 없거나 실패하면 코드 시드만 쓴다 (SQL 019 적용 전에도 동작). */
export async function getSkillDictionary(): Promise<SkillDictionary> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.dict;
  let rows: SkillEntry[] = [];
  try {
    const { data, error } = await db.from("skill_dictionary").select("canonical, aliases, category, parent");
    if (!error && data) rows = data as SkillEntry[];
  } catch {
    // 시드로 계속
  }
  const dict = new SkillDictionary(mergeEntries(SKILL_SEED, rows));
  cached = { dict, at: Date.now() };
  return dict;
}

/** 미매핑 이름 적재 (실패해도 매칭은 계속, 응답을 기다리지 않는다) */
export function recordUnmapped(names: string[]): void {
  if (names.length === 0) return;
  void Promise.resolve(db.rpc("record_unmapped_skills", { names: names.slice(0, 50) })).catch(() => undefined);
}

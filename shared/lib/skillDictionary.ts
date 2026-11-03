import { SKILL_SEED, type SkillEntry } from "./skillSeed.js";

/**
 * 표준 기술 사전 매퍼 (22 문서 E1, SQL 019). orchestrator(매칭)·mcp-server(search_candidates 검색어 통일) 공용.
 *
 * 비교 규칙 (LLM 없음):
 *  - 양쪽 이름을 canonical 로 바꿔 **정확히 같을 때만** 일치 1.0. 문자열 포함 비교는 하지 않는다 (Java ⊄ JavaScript).
 *  - 후보 기술이 JD 기술의 하위(parent 체인)면 부분 일치 PARENT_CREDIT (Next.js 보유 → React 요구 0.7).
 *  - 사전에 없는 이름은 정리한 문자열끼리 같을 때만 일치.
 */
export const PARENT_CREDIT = 0.7;
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

  /**
   * 후보 기술이 matchScore > 0 을 줄 수 있는 공고 기술 표기 전부 (정리된 소문자). DB 후보 생성(SQL 029)용.
   * 내 기술 자신 + 사전 별칭 + 상위 기술(부분 일치)과 그 별칭. 사전에 없는 이름은 정리한 문자열 그대로.
   */
  matchKeys(candidateSkills: string[]): string[] {
    const keys = new Set<string>();
    for (const s of candidateSkills) {
      const c = cleanSkill(s);
      if (c) keys.add(c);
      const have = this.canonical(s);
      if (!have) continue;
      for (const canon of [have, ...this.ancestors(have)]) {
        const e = this.entries.get(canon);
        for (const a of [canon, ...(e?.aliases ?? [])]) keys.add(cleanSkill(a));
      }
    }
    return [...keys];
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

/** DB 행(fit.skill_dictionary)이 있으면 시드와 병합해 사전을 만든다. 행 읽기는 호출 쪽 db 클라이언트로 */
export function buildSkillDictionary(rows: SkillEntry[] = []): SkillDictionary {
  return new SkillDictionary(mergeEntries(SKILL_SEED, rows));
}

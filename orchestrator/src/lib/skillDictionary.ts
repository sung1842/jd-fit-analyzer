import { db } from "./db.js";
import { buildSkillDictionary, SkillDictionary } from "../../../shared/lib/skillDictionary.js";
import type { SkillEntry } from "./skillSeed.js";

// 사전 본체는 shared/lib/skillDictionary.ts (mcp-server search_candidates 와 공용). 여기는 DB 캐시·미매핑 적재만.
export { PARENT_CREDIT, SkillDictionary, cleanSkill, mergeEntries } from "../../../shared/lib/skillDictionary.js";
const CACHE_TTL_MS = 10 * 60 * 1000;

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
  const dict = buildSkillDictionary(rows);
  cached = { dict, at: Date.now() };
  return dict;
}

/** 미매핑 이름 적재 (실패해도 매칭은 계속, 응답을 기다리지 않는다) */
export function recordUnmapped(names: string[]): void {
  if (names.length === 0) return;
  void Promise.resolve(db.rpc("record_unmapped_skills", { names: names.slice(0, 50) })).catch(() => undefined);
}

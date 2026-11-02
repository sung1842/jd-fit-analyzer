import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { rankBySkills } from "../src/lib/jdPlan.js";
import { cleanSkill, mergeEntries, PARENT_CREDIT, SkillDictionary } from "../src/lib/skillDictionary.js";
import { SKILL_SEED } from "../src/lib/skillSeed.js";

const dict = new SkillDictionary(SKILL_SEED);

describe("표준 기술 사전 (22 문서 E1)", () => {
  test("T1 Java 요구에 JavaScript 만 있으면 일치 아님", () => {
    assert.equal(dict.matchScore("Java", ["JavaScript", "TypeScript"]), 0);
    assert.equal(dict.matchScore("JavaScript", ["Java"]), 0);
    assert.equal(dict.matchScore("Java", ["자바"]), 1);
  });

  test("T2 동의어는 같은 이름으로 묶인다", () => {
    assert.equal(dict.canonical("React.js"), "React");
    assert.equal(dict.canonical("리액트"), "React");
    assert.equal(dict.canonical("  REACTJS "), "React");
    assert.equal(dict.matchScore("react", ["리액트"]), 1);
    assert.equal(dict.matchScore("Spring Boot", ["스프링부트"]), 1);
    assert.equal(dict.matchScore("k8s", ["Kubernetes"]), 1);
  });

  test("matchKeys: 점수가 0 보다 큰 공고 기술 표기는 모두 키에 들어간다 (SQL 029 후보 생성)", () => {
    const mine = ["Next.js", "자바", "MyOwnTool"];
    const keys = new Set(dict.matchKeys(mine));
    for (const jd of ["React", "리액트", "NEXTJS", "Java", "MyOwnTool", "JavaScript", "Vue"]) {
      assert.equal(keys.has(cleanSkill(jd)), dict.matchScore(jd, mine) > 0, jd);
    }
  });

  test("하위 기술 보유는 부분 인정, 반대 방향은 인정 안 함", () => {
    assert.equal(dict.matchScore("React", ["Next.js"]), PARENT_CREDIT);
    assert.equal(dict.matchScore("JavaScript", ["Next.js"]), PARENT_CREDIT); // 체인 Next.js → React → JavaScript
    assert.equal(dict.matchScore("Next.js", ["React"]), 0);
  });

  test("사전에 없는 이름은 정확히 같을 때만 일치, 미매핑으로 분류", () => {
    assert.equal(dict.matchScore("Zustand", ["zustand"]), 1);
    assert.equal(dict.matchScore("Zust", ["zustand"]), 0);
    assert.deepEqual(dict.unmapped(["React", "Zustand", "zustand ", ""]), ["zustand"]);
  });

  test("DB 행이 같은 canonical 시드를 덮어쓴다", () => {
    const merged = new SkillDictionary(
      mergeEntries(SKILL_SEED, [{ canonical: "React", aliases: ["리엑트"], category: "frontend", parent: "JavaScript" }])
    );
    assert.equal(merged.canonical("리엑트"), "React");
    assert.equal(merged.canonical("리액트"), null);
  });

  test("순위: 점수 합으로 정렬, 결정적", () => {
    const candidates = [
      { id: "a", name: "A", title: null, skills: ["JavaScript"] },
      { id: "b", name: "B", title: null, skills: ["Java", "Spring Boot"] },
      { id: "c", name: "C", title: null, skills: ["자바", "Spring"] },
    ];
    const r1 = rankBySkills(dict, ["Java", "Spring Boot"], candidates);
    const r2 = rankBySkills(dict, ["Java", "Spring Boot"], candidates);
    assert.deepEqual(r1, r2);
    assert.deepEqual(
      r1.map((r) => [r.candidateId, r.matchScore]),
      [["b", 2], ["c", 1], ["a", 0]]
    );
  });
  test("시드 무결성: 별칭이 두 기술에 겹치지 않고, parent 는 사전에 있다", () => {
    const owner = new Map<string, string>();
    const canon = new Set(SKILL_SEED.map((e) => e.canonical));
    for (const e of SKILL_SEED) {
      assert.ok(!e.parent || canon.has(e.parent), `${e.canonical} 의 parent ${e.parent} 없음`);
      for (const a of [e.canonical, ...e.aliases]) {
        const k = cleanSkill(a);
        assert.ok(!owner.has(k) || owner.get(k) === e.canonical, `별칭 충돌: ${k} (${owner.get(k)} / ${e.canonical})`);
        owner.set(k, e.canonical);
      }
    }
  });

  test("보강 1차: 디자인 역량·모바일·AI 이름이 매핑된다", () => {
    assert.equal(dict.canonical("디자인 시스템"), "Design System");
    assert.equal(dict.canonical("coroutines"), "Kotlin Coroutines");
    assert.equal(dict.canonical("OpenAI"), "OpenAI API");
    assert.equal(dict.matchScore("Android", ["Jetpack Compose"]), PARENT_CREDIT);
    assert.equal(dict.matchScore("UX Design", ["Prototyping"]), PARENT_CREDIT);
  });
});

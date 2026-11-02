import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DEFAULT_EFFECTIVE_WEIGHTS, mustCoverage, scoreCandidate, type RankInput } from "../src/lib/matchEngine.js";
import { rankByRequirements } from "../src/lib/jdPlan.js";
import { isCurrentRow, JOB_NORM_VERSION, jdKey, parseGroups, refineRequirements, type JobRequirements } from "../src/lib/jobRequirements.js";
import { SkillDictionary } from "../src/lib/skillDictionary.js";
import { SKILL_SEED } from "../src/lib/skillSeed.js";

const dict = new SkillDictionary(SKILL_SEED);
const base: JobRequirements = {
  role: "backend", legacy_role: "developer", role_confidence: 90,
  must_skills: ["Java", "Spring Boot"], must_any_of: [["MySQL", "PostgreSQL"]], must_experiences: ["REST API 설계 경험"],
  nice_skills: ["Kafka"], years_min: 3, years_max: null, locations: ["서울"], remote_ok: null,
};
const c = (skills: string[]): RankInput => ({ id: "x", skills, roleAffinity: 1, hasRoles: true, totalYears: 5, vectorSim: 0.8, activityAt: "2026-10-20T00:00:00Z" });
const opts = { vectorAvailable: true, now: Date.parse("2026-10-30T00:00:00Z") };

describe("A2 택일 그룹", () => {
  test("그룹 중 하나만 있어도 필수 충족", () => {
    const cov = mustCoverage(dict, base, ["Java", "Spring Boot", "PostgreSQL"]);
    assert.deepEqual([cov.hit, cov.total, cov.missing], [3, 3, []]);
    const r = scoreCandidate(dict, base, c(["Java", "Spring Boot", "MySQL"]), DEFAULT_EFFECTIVE_WEIGHTS, opts);
    assert.equal(r.breakdown.mustUnmet, false);
    assert.equal(r.breakdown.items.must, 1);
  });
  test("그룹 전부 없으면 'A 또는 B' 누락", () => {
    const r = scoreCandidate(dict, base, c(["Java", "Spring Boot"]), DEFAULT_EFFECTIVE_WEIGHTS, opts);
    assert.deepEqual(r.missingMust, ["MySQL 또는 PostgreSQL"]);
    assert.ok(r.rankScore <= 50);
  });
  test("rankByRequirements 도 그룹을 1칸으로", () => {
    const [r] = rankByRequirements(dict, base, [{ id: "a", name: "a", title: null, skills: ["Java", "Spring Boot", "MySQL"] }]);
    assert.equal(r.mustCoverage, 1);
    assert.deepEqual(r.missingMust, []);
  });
});

describe("A2 경험 문장 분리", () => {
  test("경험 문장은 기술 매칭에서 빠지고, 사전 이름은 기술로", () => {
    const req = refineRequirements(dict, {
      ...base, role: "product_designer", legacy_role: "designer",
      must_skills: ["Figma", "디자인 시스템 구축 경험"], must_any_of: [["Sketch"]], must_experiences: ["Design System", "사용자 인터뷰 진행 경험"],
    });
    assert.deepEqual(req.must_skills.sort(), ["Design System", "Figma", "Sketch"].sort());
    assert.deepEqual(req.must_any_of, []);
    assert.deepEqual(req.must_experiences.sort(), ["디자인 시스템 구축 경험", "사용자 인터뷰 진행 경험"].sort());
    const cov = mustCoverage(dict, req, ["Figma", "Design System", "Sketch"]);
    assert.equal(cov.missing.length, 0);
  });
  test("옛 형식(must_any_of 없음)도 동작", () => {
    const { must_any_of: _a, must_experiences: _e, ...old } = base;
    assert.equal(mustCoverage(dict, old, ["Java", "Spring Boot"]).total, 2);
  });
});

describe("A2 캐시 버전", () => {
  test("옛 v1 행은 재정규화 대상, 현재 버전+그룹 칸이면 사용", () => {
    assert.ok(JOB_NORM_VERSION >= 2);
    assert.equal(isCurrentRow({ norm_version: 1, req_groups: {} }, true), false);
    assert.equal(isCurrentRow({ norm_version: null }, false), false);
    assert.equal(isCurrentRow({ norm_version: JOB_NORM_VERSION, req_groups: null }, true), false);
    assert.equal(isCurrentRow({ norm_version: JOB_NORM_VERSION, req_groups: { must_any_of: [] } }, true), true);
    assert.equal(isCurrentRow({ norm_version: JOB_NORM_VERSION }, false), true); // 028 미적용
  });
  test("jd_key 에 버전이 들어가 v1 키와 다르다", () => {
    assert.ok(jdKey("x").length === 64);
  });
  test("parseGroups 정리", () => {
    assert.deepEqual(parseGroups({ must_any_of: [["A", " "], [], "x"], must_experiences: ["e", 1] }), { must_any_of: [["A"]], must_experiences: ["e"] });
    assert.deepEqual(parseGroups(null), { must_any_of: [], must_experiences: [] });
  });
});

describe("A2 원문 택일 보정", () => {
  test("LLM 이 MySQL·PostgreSQL 을 둘 다 필수로 뽑아도 원문 '또는' 이면 그룹으로", () => {
    const jd = "자격요건: Java, Spring Boot 3년 이상, MySQL 또는 PostgreSQL, REST API 설계 경험.";
    const req = refineRequirements(dict, { ...base, must_skills: ["Java", "Spring Boot", "MySQL", "PostgreSQL", "REST API"], must_any_of: [], must_experiences: [] }, jd);
    assert.deepEqual(req.must_skills, ["Java", "Spring Boot", "REST API"]);
    assert.deepEqual(req.must_any_of, [["MySQL", "PostgreSQL"]]);
  });
});

describe("A2 리뷰 보정", () => {
  test("컬럼 없음 오류만 028 미적용으로 판단", async () => {
    const { isMissingColumn } = await import("../src/lib/jobRequirements.js");
    assert.equal(isMissingColumn({ code: "42703" }), true);
    assert.equal(isMissingColumn({ code: "PGRST204" }), true);
    assert.equal(isMissingColumn({ code: "57014" }), false);
    assert.equal(isMissingColumn(null), false);
  });
});

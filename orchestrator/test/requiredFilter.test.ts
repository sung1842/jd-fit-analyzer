import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { rankByRequirements, region, requiredFilter, type CandidateNormLite } from "../src/lib/jdPlan.js";
import type { JobRequirements } from "../src/lib/jobRequirements.js";
import { ROLE_SEED, RoleTaxonomy } from "../src/lib/roleTaxonomy.js";
import { SkillDictionary } from "../src/lib/skillDictionary.js";
import { SKILL_SEED } from "../src/lib/skillSeed.js";

const tax = new RoleTaxonomy(ROLE_SEED);
const dict = new SkillDictionary(SKILL_SEED);
const req: JobRequirements = {
  role: "backend",
  legacy_role: "developer",
  role_confidence: 90,
  must_skills: ["Java", "Spring Boot"],
  nice_skills: ["Kafka"],
  years_min: 3,
  years_max: 7,
  locations: ["서울"],
  remote_ok: false,
};
const norm = (o: Partial<CandidateNormLite>): CandidateNormLite => ({ roles: ["backend"], skills: [], total_years: 4, prefs: { locations: ["서울 강남구"], remote: null }, ...o });

describe("A 단계 필수 조건 (22 문서 E3)", () => {
  test("백엔드 공고에 풀스택 후보는 인접도 0.8 로 통과, 디자이너는 탈락", () => {
    assert.deepEqual(requiredFilter(req, norm({ roles: ["fullstack"] }), tax), { pass: true, roleAffinity: 0.8 });
    assert.deepEqual(requiredFilter(req, norm({ roles: ["ui_design"] }), tax), { pass: false, reason: "role" });
    assert.deepEqual(requiredFilter(req, norm({ roles: ["embedded"] }), tax), { pass: false, reason: "role" }); // 0.3 < 0.5
  });

  test("경력은 1년 여유, 정보 없으면 통과", () => {
    assert.equal(requiredFilter(req, norm({ total_years: 2 }), tax).pass, true);
    assert.deepEqual(requiredFilter(req, norm({ total_years: 1.5 }), tax), { pass: false, reason: "years" });
    assert.equal(requiredFilter(req, norm({ total_years: null }), tax).pass, true);
  });

  test("지역: 시·도 비교, 원격 가능·정보 없음은 통과", () => {
    assert.deepEqual(requiredFilter(req, norm({ prefs: { locations: ["부산"], remote: null } }), tax), { pass: false, reason: "location" });
    assert.equal(requiredFilter(req, norm({ prefs: { locations: ["부산"], remote: true } }), tax).pass, true);
    assert.equal(requiredFilter({ ...req, remote_ok: true }, norm({ prefs: { locations: ["부산"], remote: null } }), tax).pass, true);
    assert.equal(requiredFilter(req, norm({ prefs: null }), tax).pass, true);
    assert.equal(region("서울특별시 마포구"), "서울");
    assert.equal(region("경기도"), "경기");
  });

  test("정규화 전 후보·직무 미지정 요구는 직무 필터 없음", () => {
    assert.deepEqual(requiredFilter(req, null, tax), { pass: true, roleAffinity: null });
    assert.equal(requiredFilter({ ...req, role: null }, norm({ roles: ["ui_design"] }), tax).pass, true);
  });

  test("T6 필수를 모두 갖춘 후보가 우대만 많은 후보보다 먼저", () => {
    const ranked = rankByRequirements(dict, req, [
      { id: "nice-only", name: "A", title: null, skills: ["Java", "Kafka", "Redis"] },
      { id: "all-must", name: "B", title: null, skills: ["자바", "스프링부트"] },
      { id: "none", name: "C", title: null, skills: ["Python"] },
    ]);
    assert.deepEqual(ranked.map((r) => r.candidateId), ["all-must", "nice-only", "none"]);
    assert.deepEqual(ranked[1].missingMust, ["Spring Boot"]);
    assert.equal(ranked[1].mustCoverage, 0.5);
    assert.equal(ranked[1].matchScore, 1.5); // Java 1 + Kafka 0.5
  });
});

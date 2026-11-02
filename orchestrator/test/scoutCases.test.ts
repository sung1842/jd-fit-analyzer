/**
 * 스카우트 건 요건 변환·검증 (scoutCases.ts) 테스트. 순수 로직만.
 *   npm test --prefix orchestrator
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { sanitizeRequirements, toCaseRequirements, toJobRequirements } from "../src/lib/scoutCases.js";

const norm = {
  role: "backend",
  legacy_role: "developer" as const,
  role_confidence: 80,
  must_skills: ["Node.js", "PostgreSQL", "node.js", "4년제 대졸 이상"],
  nice_skills: ["Kafka", "Node.js"],
  years_min: 3,
  years_max: null,
  locations: ["서울"],
  remote_ok: null,
};

describe("toCaseRequirements", () => {
  test("필수 먼저, 중복 제거, 학력 조건 제외", () => {
    const c = toCaseRequirements(norm);
    assert.deepEqual(c.items, [
      { label: "Node.js", required: true },
      { label: "PostgreSQL", required: true },
      { label: "Kafka", required: false },
    ]);
    assert.equal(c.years_min, 3);
  });

  test("체크리스트 → 탐색 요건 왕복", () => {
    const j = toJobRequirements(toCaseRequirements(norm));
    assert.deepEqual(j.must_skills, ["Node.js", "PostgreSQL"]);
    assert.deepEqual(j.nice_skills, ["Kafka"]);
    assert.equal(j.role, "backend");
  });
});

describe("sanitizeRequirements", () => {
  test("나이·성별 조건은 거부 목록으로, 빈 항목·중복은 버림", () => {
    const { value, rejected } = sanitizeRequirements(
      { items: [{ label: " Redis ", required: false }, { label: "" }, { label: "redis" }, { label: "만 35세 이하" }, { label: "남성" }, { label: "React" }], legacy_role: "developer", years_min: 99 },
      null,
    );
    assert.deepEqual(rejected, ["만 35세 이하", "남성"]);
    assert.deepEqual(value?.items, [{ label: "Redis", required: false }, { label: "React", required: true }]);
    assert.equal(value?.years_min, null); // 범위 밖
  });

  test("입력이 없으면 기존 값 유지", () => {
    const prev = toCaseRequirements(norm);
    assert.equal(sanitizeRequirements(undefined, prev).value, prev);
  });
});

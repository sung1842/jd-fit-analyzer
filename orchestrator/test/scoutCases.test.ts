/**
 * 스카우트 건 요건 변환·검증 (scoutCases.ts) 테스트. 순수 로직만.
 *   npm test --prefix orchestrator
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { applyPostingFacets, composeCaseJd, sanitizePosting, sanitizeRequirements, toCaseRequirements, toJobRequirements } from "../src/lib/scoutCases.js";
import { computeFacets } from "../src/lib/postingFacets.js";

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

describe("공고 조건 (사람인 표기)", () => {
  const posting = sanitizePosting({ location_text: "서울 강남구", career_text: "경력 5~10년", education_text: "대졸(4년제) 이상", employment_type_text: "정규직", salary_text: "회사내규에 따름", junk: 1 });

  test("본문 뒤에 크롤 공고와 같은 [근무조건] 블록을 붙인다", () => {
    const jd = composeCaseJd("백엔드 개발자\n주문 API 개발", posting);
    assert.ok(jd.endsWith("[근무조건]\n- 경력: 경력 5~10년\n- 학력: 대졸(4년제) 이상\n- 근무형태: 정규직\n- 급여: 회사내규에 따름\n- 근무지: 서울 강남구"));
    assert.equal(composeCaseJd("본문만", sanitizePosting(null)), "본문만");
  });

  test("경력·지역은 입력 조건이 AI 추정보다 우선, 학력은 요건 항목에 들어가지 않는다", () => {
    const req = toCaseRequirements(norm);
    const f = computeFacets({ title: "백엔드", skills: [], ...posting, deadline_date: null });
    const out = applyPostingFacets(req, f);
    assert.equal(out.years_min, 5);
    assert.equal(out.years_max, 10);
    assert.deepEqual(out.locations, ["서울 강남구"]);
    assert.equal(f.education_level, "bachelor");
    assert.ok(!out.items.some((i) => /대졸/.test(i.label)));
  });
});

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { computeFacets, inferCategories, parseCareer, parseEducation, parseEmploymentTypes, parseRegion, parseSalaryDisclosed } from "../src/lib/postingFacets.js";

describe("공고 필터 값", () => {
  test("경력", () => {
    assert.deepEqual(parseCareer("신입·경력 3년 ↑"), { career_min: 3, career_max: null, newcomer_ok: true });
    assert.deepEqual(parseCareer("경력 3~15년"), { career_min: 3, career_max: 15, newcomer_ok: false });
    assert.deepEqual(parseCareer("경력무관(신입포함)"), { career_min: 0, career_max: null, newcomer_ok: true });
    assert.deepEqual(parseCareer("신입"), { career_min: 0, career_max: 0, newcomer_ok: true });
    assert.deepEqual(parseCareer(null), { career_min: null, career_max: null, newcomer_ok: null });
  });
  test("학력", () => {
    assert.equal(parseEducation("대졸(4년제) 이상(졸업예정자 가능)"), "bachelor");
    assert.equal(parseEducation("초대졸(2,3년제) 이상"), "associate");
    assert.equal(parseEducation("학력무관"), "any");
    assert.equal(parseEducation("대졸(4년제) 이상 석사우대"), "master");
  });
  test("고용형태", () => {
    assert.deepEqual(parseEmploymentTypes("정규직 수습기간 3개월"), ["정규직"]);
    assert.deepEqual(parseEmploymentTypes("정규직, 계약직"), ["정규직", "계약직"]);
    assert.deepEqual(parseEmploymentTypes("계약직 3개월, 정규직 전환 가능"), ["정규직", "계약직"]);
  });
  test("지역", () => {
    assert.deepEqual(parseRegion("서울 송파구"), { region_sido: "서울", region_sigungu: ["서울 송파구"] });
    assert.deepEqual(parseRegion("경남 창원시 의창구, 경기 성남시 분당구"), { region_sido: "경남", region_sigungu: ["경남 창원시", "경기 성남시"] });
    assert.deepEqual(parseRegion(null), { region_sido: null, region_sigungu: [] });
  });
  test("급여 공개", () => {
    assert.equal(parseSalaryDisclosed("면접 후 결정"), false);
    assert.equal(parseSalaryDisclosed("회사내규에 따름"), false);
    assert.equal(parseSalaryDisclosed("3,600~4,000만원"), true);
  });
  test("직군 추정", () => {
    assert.deepEqual(inferCategories("AI 서비스 백엔드(Java/Spring) 개발자", []), ["it_dev_data"]);
    assert.deepEqual(inferCategories("UI/UX 디자이너", []), ["design"]);
    assert.deepEqual(inferCategories("사업 담당", ["Java"]), ["it_dev_data"]);
    assert.deepEqual(inferCategories("매장 관리", []), []);
  });
  test("수집 단계 직군이 있으면 우선", () => {
    const f = computeFacets({
      title: "백엔드 개발자", skills: [], career_text: null, education_text: null, employment_type_text: null,
      location_text: null, deadline_date: null, deadline_text: "상시채용", salary_text: null, category_codes: ["research_rnd"],
    });
    assert.deepEqual(f.category_codes, ["research_rnd"]);
    assert.equal(f.deadline_type, "rolling");
  });
});

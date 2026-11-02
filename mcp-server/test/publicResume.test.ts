import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_EXPERIENCES, prunePublicResume } from "../src/lib/publicResume.js";

test("공개 이력서 prune: 상한·필드·글자 수", () => {
  const row = {
    user_id: "u", headline: "백엔드 개발자", region_sido: "서울", desired_categories: ["it_dev_data"],
    experiences: Array.from({ length: 9 }, (_, i) => ({ company: `회사${i}`, position: "사원", start: "2020-03-01", end: null, current: true, duties: "가".repeat(500), achievements: null })),
    educations: [{ school: "학교", major: "컴공", degree: "bachelor", status: "graduated", end: "2019-02-01" }],
    certifications: [{ name: "정보처리기사", score: null }, { name: "TOEIC", score: "900" }],
    misc: [], email: "secret@example.com",
  };
  const letter = { items: [{ question: "지원 동기", answer: "나".repeat(1000) }, { question: "빈 답", answer: "  " }] };
  const r = prunePublicResume(row, letter)!;
  assert.equal(r.experiences.length, MAX_EXPERIENCES);
  assert.equal(r.experiences[0].period, "2020-03~현재");
  assert.ok(r.experiences[0].duties!.length <= 200);
  assert.deepEqual(r.certifications, ["정보처리기사", "TOEIC 900"]);
  assert.equal(r.cover_letter.length, 1); // 빈 답은 뺀다
  assert.ok(r.cover_letter[0].answer.length <= 400);
  assert.ok(!JSON.stringify(r).includes("secret@example.com")); // 뷰에 없는 필드는 넣지 않는다
});

test("공개 데이터가 없으면 undefined", () => {
  assert.equal(prunePublicResume(null, null), undefined);
});

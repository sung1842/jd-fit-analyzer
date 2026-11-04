import { test } from "node:test";
import assert from "node:assert/strict";
import { composePostingText, splitPostingText } from "../../shared/lib/postingFormat.js";
import { composeCaseJd, sanitizePosting } from "../src/lib/scoutCases.js";

const COND = { career_text: "경력 3년 ↑", education_text: "학력무관", employment_type_text: "정규직", salary_text: "회사내규에 따름", location_text: "서울 강남구", work_hours_text: null };

test("표준 양식: 섹션 + 근무조건 순서", () => {
  const t = composePostingText({ summary: null, key_duties: ["API 구현"], must_have: ["Java 3년"], nice_to_have: ["Kafka"] }, COND);
  assert.equal(
    t,
    "[주요업무]\n- API 구현\n\n[자격요건]\n- Java 3년\n\n[우대사항]\n- Kafka\n\n[근무조건]\n- 경력: 경력 3년 ↑\n- 학력: 학력무관\n- 근무형태: 정규직\n- 급여: 회사내규에 따름\n- 근무지: 서울 강남구",
  );
});

test("붙여넣은 사람인 본문 → 섹션 (별칭 제목·불릿 기호)", () => {
  const s = splitPostingText("우리는 커머스 회사입니다.\n담당업무\n• 주문 API\n자격 요건 : Java\n· Spring\n[우대사항]\n- Kafka\n[근무조건]\n- 급여: 3천");
  assert.deepEqual(s, { summary: "우리는 커머스 회사입니다.", key_duties: ["주문 API"], must_have: ["Java", "Spring"], nice_to_have: ["Kafka"] });
});

test("스카우트 건 본문 = 크롤 공고와 같은 모양 (재조립해도 같다)", () => {
  const body = composePostingText({ summary: null, key_duties: ["API 구현"], must_have: ["Java 3년"], nice_to_have: [] });
  const jd = composeCaseJd(body, sanitizePosting(COND));
  assert.equal(composeCaseJd(jd, sanitizePosting(COND)), jd);
  assert.ok(jd.includes("[자격요건]\n- Java 3년") && jd.includes("- 학력: 학력무관"));
});

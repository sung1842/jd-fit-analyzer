/**
 * 인용 카드 검증 규칙(validation.ts) 테스트. 순수 로직만.
 *   npm test --prefix orchestrator
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AgentResult, CandidatePortfolio } from "../../shared/types.js";
import { enforceCitedCards, runRuleBasedValidation } from "../src/validation.js";

const portfolio: CandidatePortfolio = {
  id: "u1",
  name: "홍길동",
  role: "developer",
  title: "백엔드 개발자",
  short_bio: "Node.js 개발",
  long_bio: "Redis 캐시 장애 대응",
  skills: ["Node.js"],
  github_url: null,
  portfolio_url: null,
  evidence_cards: [
    { id: "c1", claim: "Redis 장애 대응", trust: "confirmed", recorded_at: "2026-10-01", source: "web" },
    { id: "c2", claim: "코드 리뷰 문화", trust: "self_reported", recorded_at: null, source: null },
  ],
};

function result(agent: AgentResult["agent"], citedCardIds?: string[]): AgentResult {
  return { agent, score: 60, summary: "요약", matched_items: ["a"], missing_items: [], evidence: ["Node.js"], citedCardIds };
}

describe("enforceCitedCards", () => {
  test("부분집합이면 위반 없음, trust 부착", () => {
    const r = result("experience", ["c1"]);
    assert.deepEqual(enforceCitedCards(r, portfolio), []);
    assert.deepEqual(r.citedCards, [{ id: "c1", trust: "confirmed" }]);
  });

  test("제공되지 않은 id 는 위반으로 반환되고 제거됨", () => {
    const r = result("experience", ["c1", "fake"]);
    assert.deepEqual(enforceCitedCards(r, portfolio), ["fake"]);
    assert.deepEqual(r.citedCardIds, ["c1"]);
    assert.deepEqual(r.citedCards, [{ id: "c1", trust: "confirmed" }]);
  });

  test("카드가 없는 후보는 모든 인용이 위반", () => {
    const r = result("culture_fit", ["c1"]);
    assert.deepEqual(enforceCitedCards(r, { ...portfolio, evidence_cards: undefined }), ["c1"]);
    assert.deepEqual(r.citedCardIds, []);
  });
});

describe("runRuleBasedValidation 인용 규칙", () => {
  test("위반 시 해당 tool invalid + 재작업 사유 issue", () => {
    const pre = runRuleBasedValidation({
      techResult: result("tech_stack"),
      expResult: result("experience", ["nope"]),
      cultureResult: result("culture_fit", ["c2"]),
      portfolio,
    });
    assert.equal(pre.techValid, true);
    assert.equal(pre.expValid, false);
    assert.equal(pre.cultureValid, true);
    assert.ok(pre.issues.some((i) => i.startsWith("experience: citedCardIds") && i.includes("nope")));
  });

  test("재작업 후에도 위반이면 위반 id 가 최종 결과에서 폐기됨", () => {
    const reworked = result("experience", ["c2", "still-fake"]);
    const pre = runRuleBasedValidation({ techResult: result("tech_stack"), expResult: reworked, cultureResult: result("culture_fit"), portfolio });
    assert.equal(pre.expValid, false);
    assert.deepEqual(reworked.citedCardIds, ["c2"]);
    assert.deepEqual(reworked.citedCards, [{ id: "c2", trust: "self_reported" }]);
  });
});

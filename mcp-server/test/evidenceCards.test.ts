/**
 * 공개 카드 prune·뷰 없음 처리·match_exclusions 테스트 (순수 로직 + 가짜 클라이언트).
 *   cd mcp-server && node --import tsx --test test/*.test.ts
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  MAX_CARDS_PER_CANDIDATE,
  MAX_CLAIM_LENGTH,
  PUBLIC_EVIDENCE_VIEW,
  fetchExcludedUserIds,
  fetchPublicEvidenceCards,
  prunePublicEvidenceCards,
  toCitations,
  type PublicEvidenceCardRow,
} from "../src/lib/evidenceCards.js";

function row(i: number, extra: Partial<PublicEvidenceCardRow> = {}): PublicEvidenceCardRow {
  return {
    id: `c${i}`,
    user_id: "u1",
    claim: `claim ${i}`,
    trust_level: "attached",
    recorded_at: `2026-10-${String(i + 1).padStart(2, "0")}`,
    source: "github",
    links: ["https://x"],
    ai_edited: true,
    ...extra,
  };
}

// supabase-js 체이닝 흉내: 마지막 await 에 { data, error } 반환
function fakeClient(result: { data: unknown; error: { code?: string; message: string } | null }, seen: string[] = []) {
  const chain: any = {
    select: () => chain,
    eq: () => chain,
    order: () => chain,
    limit: () => chain,
    then: (resolve: (v: unknown) => void) => resolve(result),
  };
  return { from: (t: string) => (seen.push(t), chain) };
}

describe("prunePublicEvidenceCards", () => {
  test("후보당 상위 8장 상한", () => {
    const out = prunePublicEvidenceCards(Array.from({ length: 20 }, (_, i) => row(i)));
    assert.equal(out.length, MAX_CARDS_PER_CANDIDATE);
  });

  test("claim 길이 상한 + 투입 필드 5개만", () => {
    const [card] = prunePublicEvidenceCards([row(1, { claim: "가".repeat(1000) })]);
    assert.ok(card.claim.length <= MAX_CLAIM_LENGTH);
    assert.deepEqual(Object.keys(card).sort(), ["claim", "id", "recorded_at", "source", "trust"]);
  });

  test("신뢰 등급과 무관하게 최신순, 빈 claim 제외", () => {
    const out = prunePublicEvidenceCards([row(1), row(2, { trust_level: "confirmed" }), row(3), row(4, { claim: "  " })]);
    assert.deepEqual(out.map((c) => c.id), ["c3", "c2", "c1"]);
  });

  test("모든 카드는 자기 신고로 통일 (검증 안 된 등급을 분석에 넘기지 않음)", () => {
    const out = prunePublicEvidenceCards([row(1, { trust_level: "confirmed" }), row(2, { trust_level: "attached" }), row(3, { trust_level: "self" })]);
    assert.ok(out.every((c) => c.trust === "self"));
  });
});

describe("fetchPublicEvidenceCards", () => {
  test("공개 뷰만 조회", async () => {
    const seen: string[] = [];
    const out = await fetchPublicEvidenceCards(fakeClient({ data: [row(1)], error: null }, seen), "u1");
    assert.deepEqual(seen, [PUBLIC_EVIDENCE_VIEW]);
    assert.equal(out.length, 1);
  });

  test("뷰 없음(PGRST205/42P01) → 에러 없이 빈 배열", async () => {
    for (const error of [
      { code: "PGRST205", message: "Could not find the table 'public.public_evidence_cards' in the schema cache" },
      { code: "42P01", message: 'relation "public_evidence_cards" does not exist' },
    ]) {
      assert.deepEqual(await fetchPublicEvidenceCards(fakeClient({ data: null, error }), "u1"), []);
    }
  });

  test("그 외 에러는 throw", async () => {
    await assert.rejects(fetchPublicEvidenceCards(fakeClient({ data: null, error: { code: "500", message: "boom" } }), "u1"));
  });
});

describe("fetchExcludedUserIds", () => {
  test("job_posting_id null = 전체 제외, 특정 공고는 해당 공고만", async () => {
    const data = [
      { user_id: "a", job_posting_id: null },
      { user_id: "b", job_posting_id: "jp1" },
    ];
    assert.deepEqual([...(await fetchExcludedUserIds(fakeClient({ data, error: null })))], ["a"]);
    assert.deepEqual([...(await fetchExcludedUserIds(fakeClient({ data, error: null }), "jp1"))].sort(), ["a", "b"]);
  });

  test("테이블 없으면 무시(빈 집합)", async () => {
    const out = await fetchExcludedUserIds(fakeClient({ data: null, error: { code: "42P01", message: "does not exist" } }));
    assert.equal(out.size, 0);
  });
});

describe("toCitations", () => {
  test("중복 제거 + trust 부착(제공 카드만)", () => {
    const out = toCitations(["c1", "c1", "x", 3], [{ id: "c1", claim: "a", trust: "confirmed", recorded_at: null, source: null }]);
    assert.deepEqual(out.citedCardIds, ["c1", "x"]);
    assert.deepEqual(out.citedCards, [{ id: "c1", trust: "confirmed" }]);
  });
});

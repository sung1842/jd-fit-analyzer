/**
 * 라이프 로그 단위 테스트 (DB·LLM 불필요). prune / 인용 검증 / polish 검증 / 스키마 거부 / 인증 401.
 *   npm test --prefix orchestrator
 */
import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import type { AddressInfo } from "node:net";
import express from "express";
import { findPolishViolations, pruneLifeMessages, validatePolish, validateStructure, type RawLifeMessage } from "../src/lib/lifePrune.js";
import { LifeCardPatchSchema, LifeCreateSessionSchema, LifeMatchExclusionSchema, LifeMessageSchema } from "../src/lib/schemas.js";
import { authGate } from "../src/lib/auth.js";
import { registerLifeRoutes } from "../src/lib/lifeRoutes.js";
import { closeLifeQueue } from "../src/queue/lifeQueue.js";
import { redis } from "../src/lib/redis.js";

after(async () => {
  await closeLifeQueue();
  redis.disconnect();
});

const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";
const A1 = "33333333-3333-4333-8333-333333333333";

describe("pruneLifeMessages", () => {
  test("system 제거·로그 태그 제거·중복 제거·id 유지·ref 부여", () => {
    const msgs: RawLifeMessage[] = [
      { id: "s", role: "system", content: "시스템" },
      { id: U1, role: "user", content: "[12:01] [INFO] 오늘 <b>배포</b>  했다" },
      { id: A1, role: "assistant", content: "어떤 문제가 있었나요?" },
      { id: U2, role: "user", content: "[12:03] 오늘 배포 했다" }, // 정규화 후 중복
      { id: "e", role: "user", content: "   " },
    ];
    const p = pruneLifeMessages(msgs);
    assert.deepEqual(p.map((m) => [m.ref, m.id, m.text]), [
      ["m1", U1, "오늘 배포 했다"],
      ["m2", A1, "어떤 문제가 있었나요?"],
    ]);
  });

  test("메시지별·총량 상한 (최근 우선)", () => {
    const msgs: RawLifeMessage[] = Array.from({ length: 5 }, (_, i) => ({ id: `id${i}`, role: "user", content: `${i}`.repeat(50) }));
    const p = pruneLifeMessages(msgs, { perMessage: 20, total: 45 });
    assert.equal(p.length, 2);
    assert.deepEqual(p.map((m) => m.id), ["id3", "id4"]);
    assert.ok(p.every((m) => m.text.length <= 21));
  });
});

describe("validateStructure (인용 검증)", () => {
  const pruned = pruneLifeMessages([
    { id: U1, role: "user", content: "결제 모듈 장애를 혼자 고쳤다" },
    { id: A1, role: "assistant", content: "어떻게 고쳤나요?" },
    { id: U2, role: "user", content: "로그를 보고 타임아웃을 늘렸다" },
  ]);
  const base = { title: "결제 장애 대응", summary: "s", tags: [] };

  test("유효 ref 는 uuid 로 매핑, 없는 id·AI 발화·빈 quotes 인용 문장은 폐기", () => {
    const r = validateStructure(
      {
        activities: [
          {
            ...base,
            occurredOn: "2026-10-01",
            drafts: [
              { slot: 3, text: "타임아웃을 늘렸다", quotes: ["m3", "m1"] },
              { slot: 5, text: "매출 20% 회복", quotes: ["m9"] }, // 세션에 없음
              { slot: 4, text: "질문", quotes: ["m2"] }, // AI 발화 인용
              { slot: 6, text: "배운 점", quotes: [] },
            ],
            cards: [{ claim: "결제 장애를 해결", quotes: ["m1"] }, { claim: "지어낸 주장", quotes: ["x"] }],
          },
          { ...base, title: "근거 없는 활동", drafts: [{ slot: 1, text: "t", quotes: ["m99"] }], cards: [] },
        ],
        memory: [{ key: "tone", value: "담백" }],
      },
      pruned
    );
    assert.equal(r.activities.length, 1);
    assert.deepEqual(r.activities[0].drafts, [{ slot: 3, text: "타임아웃을 늘렸다", quotes: [U2, U1] }]);
    assert.deepEqual(r.activities[0].cards, [{ claim: "결제 장애를 해결", quotes: [U1] }]);
    assert.equal(r.activities[0].occurredOn, "2026-10-01");
    assert.equal(r.dropped, 6);
  });

  test("스키마 위반이면 throw", () => {
    assert.throws(() => validateStructure({ activities: [{ title: "x" }], memory: [] }, pruned));
    assert.throws(() => validateStructure({ activities: [], memory: [{ key: "secret", value: "v" }] }, pruned));
  });
});

describe("validatePolish", () => {
  const original = "React로 결제 페이지를 만들었고 로딩을 3초 줄였다";
  test("맞춤법 교정은 통과", () => {
    const r = validatePolish(original, { polished: "React로 결제 페이지를 만들었고, 로딩 시간을 3초 줄였다.", changedSpans: [{ before: "로딩", after: "로딩 시간" }] });
    assert.equal(r.ok, true);
  });
  test("원문에 없는 숫자·고유명사가 생기면 폐기", () => {
    assert.deepEqual(findPolishViolations(original, "React와 Next.js로 로딩을 3초(40%) 줄였다"), ["40", "Next.js"]);
    const r = validatePolish(original, { polished: "React로 결제 페이지를 만들어 로딩을 40% 줄였다", changedSpans: [] });
    assert.equal(r.ok, false);
  });
  test("스키마 위반·과도한 길이 폐기", () => {
    assert.deepEqual(validatePolish(original, { text: "x" }), { ok: false, reason: "schema" });
    assert.equal(validatePolish(original, { polished: original + " 그리고".repeat(60), changedSpans: [] }).ok, false);
  });
});

describe("API 스키마 거부", () => {
  test("PATCH 카드: ai_edited·recorded_at·visibility=public 거부, 빈 body 거부", () => {
    assert.equal(LifeCardPatchSchema.safeParse({ ai_edited: false }).success, false);
    assert.equal(LifeCardPatchSchema.safeParse({ claim: "a", recorded_at: "2020-01-01" }).success, false);
    assert.equal(LifeCardPatchSchema.safeParse({ visibility: "public" }).success, false);
    assert.equal(LifeCardPatchSchema.safeParse({}).success, false);
    assert.equal(LifeCardPatchSchema.safeParse({ claim: "ok", links: [{ url: "https://a.b" }], visibility: "private" }).success, true);
  });
  test("세션·메시지·제외", () => {
    assert.equal(LifeCreateSessionSchema.safeParse({ source: "fax" }).success, false);
    assert.equal(LifeCreateSessionSchema.parse({}).source, "web");
    assert.equal(LifeMessageSchema.safeParse({ content: "  " }).success, false);
    assert.equal(LifeMessageSchema.safeParse({ content: "a".repeat(4001) }).success, false);
    assert.equal(LifeMessageSchema.parse({ content: "hi" }).reply, true);
    assert.equal(LifeMatchExclusionSchema.safeParse({ jobPostingId: "nope" }).success, false);
    assert.equal(LifeMatchExclusionSchema.parse({}).jobPostingId, null);
  });
});

describe("인증", () => {
  test("토큰 없음·위조 토큰 → 401", async () => {
    const app = express();
    app.use(express.json());
    app.use("/api", authGate({ publicPaths: [], queryTokenPaths: [] }));
    registerLifeRoutes(app);
    const srv = app.listen(0);
    try {
      const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/api/v1/life`;
      const calls: [string, string][] = [
        ["POST", "/sessions"],
        ["POST", `/sessions/${U1}/messages`],
        ["POST", `/sessions/${U1}/close`],
        ["GET", "/drafts"],
        ["PATCH", `/cards/${U1}`],
        ["POST", `/cards/${U1}/polish`],
        ["POST", `/cards/${U1}/publish`],
        ["POST", `/cards/${U1}/unpublish`],
        ["GET", "/matches"],
        ["POST", "/match-exclusions"],
        ["DELETE", "/match-exclusions"],
        ["POST", "/consents/matching/revoke"],
      ];
      for (const [method, path] of calls) {
        const r = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: method === "GET" ? undefined : "{}" });
        assert.equal(r.status, 401, `${method} ${path}`);
      }
      const forged = await fetch(`${base}/drafts`, { headers: { authorization: "Bearer not.a.jwt" } });
      assert.equal(forged.status, 401);
    } finally {
      srv.closeAllConnections();
      srv.close();
    }
  });
});

describe("life 큐 보조 규칙", async () => {
  const { lifeCardSource, isTokenExpiredError, userDbError, TOKEN_EXPIRED, isLifeJobId, buildLifeJobId } = await import("../src/queue/lifeQueue.js");
  test("카드 source = 세션 source (015 CHECK app|web|import)", () => {
    assert.equal(lifeCardSource("app"), "app");
    assert.equal(lifeCardSource("import"), "import");
    assert.equal(lifeCardSource("web"), "web");
    assert.equal(lifeCardSource("life_session"), "web");
    assert.equal(lifeCardSource(undefined), "web");
  });
  test("JWT 만료 → token_expired (재시도 없음)", () => {
    assert.equal(isTokenExpiredError({ code: "PGRST301", message: "JWT expired" }), true);
    assert.equal(isTokenExpiredError({ message: "jwt expired" }), true);
    assert.equal(isTokenExpiredError({ code: "23505", message: "duplicate" }), false);
    const e = userDbError("x", { code: "PGRST301" });
    assert.equal(e.message, TOKEN_EXPIRED);
    assert.equal(e.name, "UnrecoverableError");
    assert.equal(userDbError("x", { code: "23514" }).message, "x 실패: 23514");
  });
  test("life-publish 잡 id 형식", () => {
    assert.equal(isLifeJobId(buildLifeJobId("life-publish", "c1")), true);
  });
});

describe("동의 철회", async () => {
  const { revokeConsent } = await import("../src/lib/lifeRoutes.js");
  const { LifeConsentPurposeSchema } = await import("../src/lib/schemas.js");
  type Call = { table: string; op: string; args: unknown[] };

  /** 체이닝 supabase 가짜: consents update → revokedRows, evidence_cards select → cards */
  function fakeDb(revokedRows: { id: string }[], cards: { id: string }[]) {
    const calls: Call[] = [];
    const from = (table: string) => {
      const q: Record<string, unknown> = {};
      const result = { data: table === "consents" ? revokedRows : cards, error: null };
      for (const op of ["update", "select", "eq", "is"]) {
        q[op] = (...args: unknown[]) => {
          calls.push({ table, op, args });
          return q;
        };
      }
      q.then = (ok: (v: unknown) => unknown) => Promise.resolve(result).then(ok);
      return q;
    };
    return { udb: { from } as never, calls };
  }

  test("purpose 파라미터는 self_ai|matching 만", () => {
    assert.equal(LifeConsentPurposeSchema.safeParse("matching").success, true);
    assert.equal(LifeConsentPurposeSchema.safeParse("self_ai").success, true);
    assert.equal(LifeConsentPurposeSchema.safeParse("all").success, false);
  });

  test("matching 철회 → 본인 공개 카드마다 life-unpublish 큐잉", async () => {
    const { udb, calls } = fakeDb([{ id: "k1" }], [{ id: U1 }, { id: U2 }]);
    const queued: unknown[] = [];
    const r = await revokeConsent(udb, A1, "matching", async (data, target) => {
      queued.push(data);
      return `life-unpublish_${target.slice(0, 4)}`;
    });
    assert.deepEqual(r, { ok: true, revoked: 1, jobIds: ["life-unpublish_1111", "life-unpublish_2222"] });
    assert.deepEqual(queued, [
      { kind: "life-unpublish", userId: A1, cardId: U1 },
      { kind: "life-unpublish", userId: A1, cardId: U2 },
    ]);
    const upd = calls.find((c) => c.table === "consents" && c.op === "update");
    assert.ok(upd && typeof (upd.args[0] as { revoked_at?: unknown }).revoked_at === "string");
    assert.ok(calls.some((c) => c.table === "consents" && c.op === "is" && c.args[0] === "revoked_at" && c.args[1] === null));
    assert.ok(calls.some((c) => c.table === "evidence_cards" && c.op === "eq" && c.args[0] === "visibility" && c.args[1] === "public"));
  });

  test("self_ai 철회·이미 철회됨 → 잡 없음", async () => {
    const never = async () => {
      throw new Error("enqueue 되면 안 됨");
    };
    assert.deepEqual(await revokeConsent(fakeDb([{ id: "k1" }], [{ id: U1 }]).udb, A1, "self_ai", never), { ok: true, revoked: 1, jobIds: [] });
    assert.deepEqual(await revokeConsent(fakeDb([], [{ id: U1 }]).udb, A1, "matching", never), { ok: true, revoked: 0, jobIds: [] });
  });
});

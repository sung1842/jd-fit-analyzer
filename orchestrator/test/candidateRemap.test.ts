import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Request, Response } from "express";
import { isMissingColumnError, mapSkills, remapStored } from "../src/lib/candidateNorm.js";
import { selfNormalizeHandler } from "../src/lib/candidateNormRoutes.js";
import { SkillDictionary } from "../src/lib/skillDictionary.js";

const dictBefore = new SkillDictionary([
  { canonical: "Java", aliases: ["자바"], category: "language", parent: null },
  { canonical: "Spring Boot", aliases: ["스프링부트"], category: "framework", parent: "Java" },
] as never);
const dictAfter = new SkillDictionary([
  { canonical: "Java", aliases: ["자바"], category: "language", parent: null },
  { canonical: "Spring Boot", aliases: ["스프링부트"], category: "framework", parent: "Java" },
  { canonical: "Kotlin", aliases: ["코틀린"], category: "language", parent: null },
] as never);

describe("F1 사전 밖 기술 상세 + AI 없이 재매핑", () => {
  test("mapSkills 는 사전 밖 기술의 연수·실무 여부를 보존하고 같은 이름은 합친다", () => {
    const r = mapSkills(dictBefore, [
      { name: "자바", years: 3, professional: true },
      { name: "코틀린", years: 1, professional: false },
      { name: " 코틀린 ", years: 2, professional: true },
    ]);
    assert.deepEqual(r.skills, [{ name: "Java", years: 3, professional: true }]);
    assert.deepEqual(r.unmapped, ["코틀린"]);
    assert.deepEqual(r.unmappedDetails, [{ name: "코틀린", years: 2, professional: true }]);
  });

  test("사전에 Kotlin 이 추가되면 LLM 없이 매핑되고 연수·실무가 유지된다", () => {
    const stored = mapSkills(dictBefore, [
      { name: "Java", years: 4, professional: true },
      { name: "코틀린", years: 2, professional: true },
    ]);
    const next = remapStored(dictAfter, { skills: stored.skills, unmapped_skill_details: stored.unmappedDetails });
    assert.deepEqual(next.skills, [
      { name: "Java", years: 4, professional: true },
      { name: "Kotlin", years: 2, professional: true },
    ]);
    assert.deepEqual(next.unmappedDetails, []);
  });

  test("사전에서 빠진 canonical 은 다시 사전 밖으로 내려가고, 027 미적용 행(null)도 처리한다", () => {
    const next = remapStored(dictBefore, { skills: [{ name: "Kotlin", years: 2, professional: false }], unmapped_skill_details: null });
    assert.deepEqual(next.skills, []);
    assert.deepEqual(next.unmappedDetails, [{ name: "Kotlin", years: 2, professional: false }]);
  });

  test("컬럼 없음 오류 판별 (027 미적용 호환)", () => {
    assert.equal(isMissingColumnError({ code: "PGRST204", message: "Could not find the 'unmapped_skill_details' column" }), true);
    assert.equal(isMissingColumnError({ code: "42703", message: "column does not exist" }), true);
    assert.equal(isMissingColumnError({ code: "23505", message: "duplicate key" }), false);
    assert.equal(isMissingColumnError(null), false);
  });
});

function fakeRes() {
  const out: { status?: number; body?: unknown } = {};
  const res = {
    status(code: number) {
      out.status = code;
      return res;
    },
    json(body: unknown) {
      out.body = body;
      return res;
    },
  } as unknown as Response;
  return { res, out };
}

describe("F2 본인 정규화 예약 엔드포인트", () => {
  test("토큰(req.auth) 없으면 401, 큐에 넣지 않는다", async () => {
    const calls: string[] = [];
    const { res, out } = fakeRes();
    await selfNormalizeHandler(async (id) => void calls.push(id))({ body: { candidateId: "victim" } } as Request, res, () => undefined);
    assert.equal(out.status, 401);
    assert.deepEqual(calls, []);
  });

  test("본인 id(토큰 sub)만 예약하고 body 의 id 는 무시한다", async () => {
    const calls: string[] = [];
    const { res, out } = fakeRes();
    const req = { auth: { userId: "me-uuid" }, body: { candidateId: "victim" } } as unknown as Request;
    await selfNormalizeHandler(async (id) => void calls.push(id))(req, res, () => undefined);
    assert.equal(out.status, 202);
    assert.deepEqual(calls, ["me-uuid"]);
  });

  test("큐 실패는 503 으로 알리기만 하고 throw 하지 않는다 (저장은 이미 끝남, 비차단)", async () => {
    const { res, out } = fakeRes();
    const req = { auth: { userId: "me-uuid" }, body: {} } as unknown as Request;
    const orig = console.error;
    console.error = () => undefined;
    try {
      await selfNormalizeHandler(async () => {
        throw new Error("redis down");
      })(req, res, () => undefined);
    } finally {
      console.error = orig;
    }
    assert.equal(out.status, 503);
  });
});

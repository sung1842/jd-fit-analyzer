import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyFitError } from "../src/lib/fitErrors.js";

const mcp = (text: string) => new Error(`MCP tool analyze_tech_stack 호출 실패: ${text}`);

test("다시 해도 같은 오류는 permanent — 재시도하지 않는다", () => {
  assert.deepEqual(classifyFitError(mcp("[E_NOT_FOUND] 후보자를 찾을 수 없습니다: x")), { cls: "permanent", code: "E_NOT_FOUND" });
  assert.deepEqual(classifyFitError(mcp("[E_INVALID] portfolio 필드 누락: name")), { cls: "permanent", code: "E_INVALID" });
  assert.deepEqual(classifyFitError(mcp("[E_BLOCKED] no content (SAFETY)")), { cls: "permanent", code: "E_BLOCKED" });
  assert.equal(classifyFitError(new Error("MCP error -32602: Invalid arguments for tool")).cls, "permanent");
});

test("LLM 한도·슬롯 부족은 capacity — 시도 횟수를 쓰지 않고 미룬다", () => {
  assert.deepEqual(classifyFitError(mcp("[E_QUOTA] all models at capacity")), { cls: "capacity", code: "E_QUOTA" });
  assert.deepEqual(classifyFitError(mcp("[E_BUSY] no slot")), { cls: "capacity", code: "E_BUSY" });
  assert.equal(classifyFitError(Object.assign(new Error("rate limited"), { status: 429 })).cls, "capacity");
  assert.equal(classifyFitError(Object.assign(new Error("overloaded"), { status: 529 })).cls, "capacity");
});

test("그 밖은 transient — 백오프 후 재시도", () => {
  assert.equal(classifyFitError(new Error("MCP error -32001: Request timed out")).cls, "transient");
  assert.equal(classifyFitError(mcp("[E_UPSTREAM] 503 UNAVAILABLE")).cls, "transient");
  assert.equal(classifyFitError(new Error("fetch failed")).cls, "transient");
  assert.equal(classifyFitError(new Error("job stalled more than allowable limit")).cls, "transient");
  assert.equal(classifyFitError("E_DEFER_EXPIRED").cls, "transient");
});

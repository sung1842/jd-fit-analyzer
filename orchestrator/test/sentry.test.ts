/** Sentry 비밀 파라미터 마스킹 (DSN 불필요). */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ErrorEvent } from "@sentry/node";
import { MASKED, maskSecretParams, scrubBreadcrumb, scrubEvent } from "../src/lib/sentry.js";

describe("sentry 마스킹", () => {
  test("url·문자열 query_string 의 access_token/token/apikey 값", () => {
    assert.equal(
      maskSecretParams("http://h/api/v1/life/jobs/x/stream?access_token=eyJ.abc&x=1&token=t1&apikey=k"),
      `http://h/api/v1/life/jobs/x/stream?access_token=${MASKED}&x=1&token=${MASKED}&apikey=${MASKED}`
    );
    const e = scrubEvent({ type: undefined, request: { url: "http://h/s?access_token=SECRET", query_string: "access_token=SECRET&a=b" } } as ErrorEvent);
    assert.equal(e.request?.url, `http://h/s?access_token=${MASKED}`);
    assert.equal(e.request?.query_string, `access_token=${MASKED}&a=b`);
    assert.ok(!JSON.stringify(e).includes("SECRET"));
  });

  test("객체·쌍 배열 query_string", () => {
    const e1 = scrubEvent({ type: undefined, request: { query_string: { token: "SECRET", a: "b" } } } as ErrorEvent);
    assert.deepEqual(e1.request?.query_string, { token: MASKED, a: "b" });
    const e2 = scrubEvent({ type: undefined, request: { query_string: [["apikey", "SECRET"], ["a", "b"]] } } as ErrorEvent);
    assert.deepEqual(e2.request?.query_string, [["apikey", MASKED], ["a", "b"]]);
  });

  test("breadcrumb data(url·키)와 이벤트 내 breadcrumbs", () => {
    const b = scrubBreadcrumb({ category: "http", data: { url: "http://h/x?token=SECRET", method: "GET", access_token: "SECRET" } });
    assert.deepEqual(b.data, { url: `http://h/x?token=${MASKED}`, method: "GET", access_token: MASKED });
    const e = scrubEvent({ type: undefined, breadcrumbs: [{ data: { url: "/s?access_token=SECRET" } }] } as ErrorEvent);
    assert.ok(!JSON.stringify(e).includes("SECRET"));
  });

  test("비밀이 아닌 파라미터는 유지", () => {
    assert.equal(maskSecretParams("/x?mytoken=1&tokens=2"), "/x?mytoken=1&tokens=2");
  });
});

/**
 * 크롤 검수(lib/crawlReview.ts) 테스트.
 *   순수 로직: 항상 실행.
 *   DB 통합: CRAWL_REVIEW_DB_TEST=1 일 때만. 원격 fit 스키마에 test- 접두 배치를 만들고 끝나면 지운다.
 *
 *   npm test --prefix orchestrator
 */
import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import express from "express";
import {
  ConflictError,
  applyRowAction,
  assertBatchApprovable,
  buildDescription,
  computeFlags,
  findDuplicateKeys,
  pickSample,
  listBatches,
  listRows,
  prepareBatch,
  sanitizeEdits,
  toJobPosting,
  type CrawledRow,
} from "../src/lib/crawlReview.js";
import { CrawlInputError, buildCrawlRunJobId, sanitizeCrawlRun } from "../src/queue/crawlRunQueue.js";
import { registerCrawlReviewRoutes } from "../src/lib/crawlReviewRoutes.js";
import { db } from "../src/lib/db.js";
import { redis } from "../src/lib/redis.js";
import {
  buildCrawlApproveJobId,
  closeCrawlApprove,
  enqueueBatchApproval,
  getBatchApprovalStatus,
  getCrawlApproveQueue,
  startCrawlApproveWorker,
} from "../src/queue/crawlApproveQueue.js";

// 라우트가 큐 모듈을 import 하면서 공유 Redis 연결이 열린다 → 끝나면 닫아야 프로세스가 끝난다
after(async () => {
  redis.disconnect();
});

const TODAY = "2026-10-25";
const base: CrawledRow = {
  id: "a", platform: "board_a", external_id: "1", job_posting_id: null, url: "https://x", company: "회사", title: "백엔드",
  career_text: "경력 3년", employment_type_text: "정규직 (수습 3개월)", salary_text: "면접 후 결정", location_text: "서울",
  work_hours_text: null, deadline_date: "2099-01-01", deadline_text: null, body_text: "x".repeat(400), body_image_count: 0,
  body_text_missing: false, role_summary: null, key_duties: ["API 개발"], must_have: [], nice_to_have: [], skills: ["Java"],
  review_status: "ok", review_note: null, load_batch_id: "b", is_sample: false, review_flags: [], reject_reason: null,
  edits: {}, reviewed_at: null,
};

describe("규칙 판정", () => {
  test("정상 행은 사유 없음", () => assert.deepEqual(computeFlags(base, TODAY), []));
  test("문제 행은 사유를 모두 낸다", () => {
    const flags = computeFlags(
      { ...base, body_text: "짧음", skills: [], key_duties: [], company: null, deadline_date: "2026-01-01", title: "고수익 부업" },
      TODAY
    );
    assert.deepEqual(flags, ["body_short", "no_company", "no_skills", "no_duties", "ad_keyword", "deadline_passed"]);
  });
  test("이미지형 본문은 body_short 대신 image_body", () => {
    assert.deepEqual(computeFlags({ ...base, body_text_missing: true }, TODAY), ["image_body"]);
  });
  test("중복은 두 번째 행부터 (공백 무시)", () => {
    const dup = findDuplicateKeys([base, { ...base, id: "b", title: " 백엔드 " }]);
    assert.equal(dup.get("b"), "a");
    assert.equal(dup.has("a"), false);
  });
});

describe("샘플", () => {
  const ids = Array.from({ length: 300 }, (_, i) => `id${i}`);
  test("max(5%, 10건)", () => {
    assert.equal(pickSample(ids).length, 15);
    assert.equal(pickSample(ids.slice(0, 50)).length, 10);
    assert.equal(pickSample(ids.slice(0, 7)).length, 7);
  });
  test("입력 순서와 무관하게 같은 샘플", () => assert.deepEqual(pickSample(ids), pickSample([...ids].reverse())));
});

describe("수정·병합 변환", () => {
  test("허용되지 않은 필드·빈 제목 거부", () => {
    assert.throws(() => sanitizeEdits({ url: "x" }));
    assert.throws(() => sanitizeEdits({ title: "  " }));
    assert.throws(() => sanitizeEdits({ skills: "Go" }));
  });
  test("배열 정리", () => assert.deepEqual(sanitizeEdits({ skills: [" Go ", ""] }), { skills: ["Go"] }));
  test("description = 배열 + 근무조건 원본", () => {
    const d = buildDescription(base);
    assert.ok(d.includes("[주요업무]\n- API 개발"));
    assert.ok(d.includes("근무형태: 정규직 (수습 3개월)"));
  });
  test("edits 가 정본에 반영", () => {
    const jp = toJobPosting({ ...base, edits: { title: "수정됨" } });
    assert.equal(jp.title, "수정됨");
    assert.equal(jp.source, "board_a");
    assert.equal(jp.external_id, "1");
  });
});

describe("비밀번호 게이트", () => {
  test("맞음 200 / 없음 401 / 5회 실패 후 429 / 서버 미설정 503", async () => {
    const saved = process.env.CRAWL_ADMIN_PASSWORD;
    process.env.CRAWL_ADMIN_PASSWORD = "test-password";
    const app = express();
    app.use(express.json());
    registerCrawlReviewRoutes(app);
    const srv = app.listen(0);
    const port = (srv.address() as { port: number }).port;
    const bodies: string[] = [];
    const login = (pw?: string) =>
      fetch(`http://127.0.0.1:${port}/api/admin/crawl/login`, { method: "POST", headers: pw ? { "X-Admin-Password": pw } : {} }).then(
        async (r) => {
          bodies.push(await r.text());
          return r.status;
        }
      );
    try {
      assert.equal(await login("test-password"), 200);
      assert.equal(await login(), 401);
      // 승인 잡 상태 조회도 같은 게이트 안
      assert.equal((await fetch(`http://127.0.0.1:${port}/api/admin/crawl/jobs/crawl-approve_x`)).status, 401);
      for (let i = 0; i < 4; i++) await login("wrong");
      assert.equal(await login("test-password"), 429);
      delete process.env.CRAWL_ADMIN_PASSWORD;
      assert.equal(await login("x"), 503);
      // 응답 어디에도 비밀번호가 실리지 않는다
      for (const b of bodies) assert.ok(!b.includes("test-password") && !b.includes("wrong"), b);
    } finally {
      process.env.CRAWL_ADMIN_PASSWORD = saved;
      srv.close();
    }
  });
});

describe("수집 실행 입력", () => {
  const now = new Date("2026-10-26T06:30:00Z"); // KST 15:30
  test("기본값 · 배치 이름 자동", () => {
    assert.deepEqual(sanitizeCrawlRun({}, now), { batchId: "board_a-20261026-1530", max: 20 });
    assert.deepEqual(sanitizeCrawlRun({ max: "5", keyword: " 백엔드 ", batchId: "my.batch-1" }, now), { batchId: "my.batch-1", max: 5, keyword: "백엔드" });
  });
  test("공고 ID 는 숫자만, 쉼표·줄바꿈 분리, 건수는 ID 수 이상", () => {
    assert.deepEqual(sanitizeCrawlRun({ max: 1, ids: "54928451,\n55129596" }, now).ids, ["54928451", "55129596"]);
    assert.equal(sanitizeCrawlRun({ max: 1, ids: "54928451, 55129596" }, now).max, 2);
    assert.throws(() => sanitizeCrawlRun({ ids: "123abc" }, now), CrawlInputError);
  });
  test("잘못된 입력 거부", () => {
    for (const bad of [{ max: 0 }, { max: 101 }, { max: 1.5 }, { listUrl: "https://evil.com/zf_user/search" }, { listUrl: "http://jobs.example.com/zf_user/search" }, { batchId: "a b" }, { batchId: "../x" }]) {
      assert.throws(() => sanitizeCrawlRun(bad as Record<string, unknown>, now), CrawlInputError, JSON.stringify(bad));
    }
    assert.match(buildCrawlRunJobId("x"), /^crawl-run_[0-9a-f]{24}$/);
  });
});

describe("배치 승인 잡 id", () => {
  test("배치 기준 고정 · BullMQ 허용 문자만", () => {
    assert.equal(buildCrawlApproveJobId("b1"), buildCrawlApproveJobId("b1"));
    assert.notEqual(buildCrawlApproveJobId("b1"), buildCrawlApproveJobId("b2"));
    assert.match(buildCrawlApproveJobId("2026:10:25 배치"), /^crawl-approve_[0-9a-f]{24}$/);
  });
});

const DB_TEST = process.env.CRAWL_REVIEW_DB_TEST === "1";

// DB 통합: 실제 라우트(202 + jobId) → 워커 → 상태 조회까지 돈다 (Redis 로컬 필요)
let worker: ReturnType<typeof startCrawlApproveWorker> | null = null;
let srv: ReturnType<ReturnType<typeof express>["listen"]> | null = null;
const PW = "test-password";
async function api(path: string, init: RequestInit = {}) {
  if (!srv) {
    process.env.CRAWL_ADMIN_PASSWORD = PW;
    const app = express();
    app.set("trust proxy", true); // 게이트 테스트가 127.0.0.1 을 잠가 두므로 다른 IP 로 들어간다
    app.use(express.json());
    registerCrawlReviewRoutes(app);
    srv = app.listen(0);
    worker = startCrawlApproveWorker();
  }
  const port = (srv.address() as { port: number }).port;
  const res = await fetch(`http://127.0.0.1:${port}/api/admin/crawl${path}`, { ...init, headers: { "X-Admin-Password": PW, "X-Forwarded-For": "10.0.0.9" } });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}
async function waitJob(jobId: string) {
  for (let i = 0; i < 120; i++) {
    const { body } = await api(`/jobs/${jobId}`);
    if (body.state === "completed" || body.state === "failed") return body;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("잡이 60초 안에 끝나지 않음");
}
after(async () => {
  await worker?.close();
  srv?.closeAllConnections();
  srv?.close();
  await closeCrawlApprove();
});

describe("DB 통합 (배치 준비 → 샘플 → 배치 승인 → 병합 → 제외)", { skip: !DB_TEST && "CRAWL_REVIEW_DB_TEST=1 일 때만" }, () => {
  const tag = `test-${Date.now()}`;
  const batch = `${tag}-batch`;

  after(async () => {
    await db.from("job_postings").delete().eq("source", "board_a").like("external_id", `${tag}-%`);
    await db.from("crawled_postings").delete().eq("load_batch_id", batch);
  });

  test("전 과정", async () => {
    const rows = Array.from({ length: 14 }, (_, i) => ({
      platform: "board_a", external_id: `${tag}-${i}`,
      url: `https://example.com/${tag}/${i}`,
      company: `테스트회사${i}`,
      title: i === 0 ? "고수익 부업 모집" : `테스트 공고 ${i}`,
      body_text: "본문 ".repeat(100),
      key_duties: ["개발"],
      skills: ["TypeScript"],
      load_batch_id: batch,
    }));
    const { error } = await db.from("crawled_postings").insert(rows);
    assert.equal(error, null, error?.message);

    const prep = await prepareBatch(batch);
    assert.deepEqual(prep, { flagged: 1, sampled: 10, passed: 13 });

    // 다시 준비해도 샘플이 바뀌지 않는다
    assert.equal((await prepareBatch(batch)).sampled, 10);

    // 미판정 샘플은 배치 승인을 막지 않는다 (샘플을 훑어본 뒤 한 번 클릭)
    await assertBatchApprovable(batch);

    // 샘플이 아닌 행 3건: 개별 승인(즉시 병합) 후 제외·재수집·되돌리기 → 정본에서 내려간다
    const { data: others } = await db.from("crawled_postings").select("id").eq("load_batch_id", batch).eq("is_sample", false).eq("review_status", "ok");
    assert.equal(others?.length, 3);
    for (const o of others!) assert.ok((await applyRowAction(o.id, { action: "approve" })).job_posting_id);
    const rejected = await applyRowAction(others![0].id, { action: "reject", reason: "ad" });
    assert.equal(rejected.review_status, "rejected");
    assert.equal(rejected.job_posting_id, null);
    for (const [i, action] of [[1, "recrawl"], [2, "reopen"]] as const) {
      const r = await applyRowAction(others![i].id, { action });
      assert.equal(r.job_posting_id, null, action);
      assert.equal(r.review_status, action === "recrawl" ? "retry_later" : "ok");
    }

    // 제외 행은 예외 탭에 같이 보인다
    const ex = await listRows({ batchId: batch, tab: "exceptions", limit: 100 });
    assert.ok(ex.some((r) => r.id === others![0].id));

    // 광고 격리 행을 수정 후 승인 → 배치 승인 때 같이 병합 대상
    const { data: ad } = await db.from("crawled_postings").select("id").eq("external_id", `${tag}-0`).single();
    await applyRowAction(ad!.id, { action: "edit", edits: { title: "테스트 공고 0" } });
    await applyRowAction(ad!.id, { action: "approve" });

    const posted = await api(`/batches/${batch}/approve`, { method: "POST" });
    assert.equal(posted.status, 202);
    assert.equal(posted.body.jobId, buildCrawlApproveJobId(batch));
    const done = await waitJob(posted.body.jobId);
    assert.equal(done.state, "completed", done.error);
    // ok 11건(샘플 10 + 되돌린 1) 승인·병합, 끝나면 배치 14행 삭제
    assert.deepEqual(done.result, { approved: 11, merged: 11, deleted: 14 });

    const { count } = await db
      .from("job_postings")
      .select("id", { count: "exact", head: true })
      .eq("source", "board_a")
      .like("external_id", `${tag}-%`);
    assert.equal(count, 12); // 11 + 수정 후 개별 승인한 예외 1, 제외·재수집 행은 없음

    // 배치가 목록에서 사라진다
    assert.ok(!(await listBatches()).some((b) => b.batchId === batch));
    assert.equal((await api(`/batches/${batch}/approve`, { method: "POST" })).status, 404);
    assert.equal((await api("/jobs/crawl-approve_nope")).status, 404);
  });
});

describe("DB 통합 (샘플 오류 → 배치 승인 차단)", { skip: !DB_TEST && "CRAWL_REVIEW_DB_TEST=1 일 때만" }, () => {
  const tag = `test-${Date.now()}-bad`;
  const batch = `${tag}-batch`;

  after(async () => {
    await db.from("job_postings").delete().eq("source", "board_a").like("external_id", `${tag}-%`);
    await db.from("crawled_postings").delete().eq("load_batch_id", batch);
  });

  test("샘플 1건이 깨짐으로 제외되면 배치 승인 409 (개별 승인분만 병합)", async () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({
      platform: "board_a", external_id: `${tag}-${i}`, url: `https://example.com/${tag}/${i}`, company: `회사${i}`, title: `공고 ${i}`,
      body_text: "본문 ".repeat(100), key_duties: ["개발"], skills: ["Go"], load_batch_id: batch,
    }));
    const { error } = await db.from("crawled_postings").insert(rows);
    assert.equal(error, null, error?.message);
    await prepareBatch(batch);
    const { data: samples } = await db.from("crawled_postings").select("id").eq("load_batch_id", batch).eq("is_sample", true);
    assert.equal(samples?.length, 3);
    await applyRowAction(samples![0].id, { action: "reject", reason: "broken" });
    for (const s of samples!.slice(1)) await applyRowAction(s.id, { action: "approve" });
    // 개별 승인분은 병합됨 → 배치 승인은 막혀야 한다
    await assert.rejects(assertBatchApprovable(batch), (e: unknown) => e instanceof ConflictError && /오류/.test((e as Error).message));
    const posted = await api(`/batches/${batch}/approve`, { method: "POST" });
    assert.equal(posted.status, 409);
    assert.match(posted.body.error, /오류/);
    // 사전 검사를 지나 큐에 들어간 뒤 샘플이 깨진 경우도 워커가 다시 막는다 (재시도 없이 실패, 문구 유지)
    const { jobId } = await enqueueBatchApproval(batch);
    const failed = await waitJob(jobId);
    assert.equal(failed.state, "failed");
    assert.match(failed.error, /오류/);
    assert.equal((await getBatchApprovalStatus(jobId))?.batchId, batch);
    const { count } = await db.from("job_postings").select("id", { count: "exact", head: true }).eq("source", "board_a").like("external_id", `${tag}-%`);
    assert.equal(count, 2); // 깨진 1건은 정본에 없음
  });
});

describe("DB 통합 (배치 삭제 · 샘플 미판정 승인)", { skip: !DB_TEST && "CRAWL_REVIEW_DB_TEST=1 일 때만" }, () => {
  const tag = `test-${Date.now()}-one`;
  const batch = `${tag}-batch`;

  after(async () => {
    await db.from("job_postings").delete().eq("source", "board_a").like("external_id", `${tag}-%`);
    await db.from("crawled_postings").delete().eq("load_batch_id", batch);
  });

  test("배치 삭제는 원본만 지우고 병합된 정본은 남긴다", async () => {
    const b2 = `${tag}-del`;
    const { error } = await db.from("crawled_postings").insert([0, 1].map((i) => ({
      platform: "board_a", external_id: `${tag}-d${i}`, url: `https://example.com/${tag}/d${i}`, company: `회사${i}`, title: `삭제 ${i}`,
      body_text: "본문 ".repeat(100), key_duties: ["개발"], skills: ["Go"], load_batch_id: b2,
    })));
    assert.equal(error, null, error?.message);
    const { data: one } = await db.from("crawled_postings").select("id").eq("load_batch_id", b2).limit(1).single();
    await applyRowAction(one!.id, { action: "approve" });
    const del = await api(`/batches/${b2}`, { method: "DELETE" });
    assert.deepEqual(del.body, { deleted: 2 });
    const { count } = await db.from("job_postings").select("id", { count: "exact", head: true }).eq("source", "board_a").like("external_id", `${tag}-d%`);
    assert.equal(count, 1);
  });

  test("샘플 포함 규칙 통과분 전부 승인·병합 후 배치 삭제, 예외는 병합 안 됨", async () => {
    const rows = Array.from({ length: 4 }, (_, i) => ({
      platform: "board_a", external_id: `${tag}-${i}`, url: `https://example.com/${tag}/${i}`, company: `회사${i}`, title: i === 0 ? "고수익 부업" : `공고 ${i}`,
      body_text: "본문 ".repeat(100), key_duties: ["개발"], skills: ["Go"], load_batch_id: batch,
    }));
    const { error } = await db.from("crawled_postings").insert(rows);
    assert.equal(error, null, error?.message);
    await prepareBatch(batch);
    const posted = await api(`/batches/${batch}/approve`, { method: "POST" });
    assert.equal(posted.status, 202);
    const done = await waitJob(posted.body.jobId);
    assert.deepEqual(done.result, { approved: 3, merged: 3, deleted: 4 });
    const { count } = await db.from("job_postings").select("id", { count: "exact", head: true }).eq("source", "board_a").like("external_id", `${tag}-_`);
    assert.equal(count, 3); // 광고 격리 행은 병합되지 않음
  });
});

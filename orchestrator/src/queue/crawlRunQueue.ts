import { createHash } from "node:crypto";
import { Queue, Worker, type Job } from "bullmq";
import { prepareBatch } from "../lib/crawlReview.js";
import { callMcpTool } from "../mcp/client.js";
import { Sentry } from "../lib/sentry.js";
import { closers, connection } from "./crawlApproveQueue.js";

/**
 * 크롤 검수 화면의 "수집 실행" 잡 (헌법 2조: 수십 분 걸리므로 요청 밖에서).
 *   1) crawler POST /v1/platform        — 목록·상세 수집 (DB 없음)
 *   2) crawler GET  /v1/platform-records — prune 된 목록만 받아 (헌법 3조)
 *      MCP compress_jd 로 1건씩 구조화      — LLM 은 본문 있는 공고당 1~2회
 *   3) crawler POST /v1/platform-load   — crawled_postings 적재 (load_batch_id = batchId)
 *   4) prepareBatch                      — 규칙 판정 + 샘플
 * crawler 는 backend 네트워크와 분리돼 있어 호스트에 publish 된 포트로 부른다 (CRAWLER_URL).
 */
export const CRAWL_RUN_QUEUE = "crawl-run";
export const CRAWL_RUN_MAX = 100; // 수집기 HARD_CAP
/** 수집처 코드 (불투명). 실제 주소는 crawler/.env BOARD_A_BASE_URL */
export const CRAWL_PLATFORM = "board_a";

export interface CrawlRunJobData {
  batchId: string;
  max: number;
  keyword?: string;
  listUrl?: string;
  ids?: string[];
}
export interface CrawlRunResult {
  batchId: string;
  fetched: number;
  compressed: number;
  compressFailed: number;
  loaded: { inserted: number; updated: number; skipped_resolved: number; failed: unknown[] };
  prepared: { flagged: number; sampled: number; passed: number };
}
export type CrawlRunStage = "crawling" | "compressing" | "loading" | "preparing" | "done";

let queue: Queue<CrawlRunJobData, CrawlRunResult> | null = null;
export function getCrawlRunQueue(): Queue<CrawlRunJobData, CrawlRunResult> {
  if (!queue) {
    queue = new Queue(CRAWL_RUN_QUEUE, {
      connection: connection(),
      // 크롤은 사이트에 다시 요청하므로 자동 재시도하지 않는다
      defaultJobOptions: { attempts: 1, removeOnComplete: { age: 24 * 3600 }, removeOnFail: { age: 7 * 24 * 3600 } },
    });
    closers.push(async () => {
      await queue?.close();
      queue = null;
    });
  }
  return queue;
}

export function buildCrawlRunJobId(batchId: string): string {
  return `crawl-run_${createHash("sha256").update(batchId).digest("hex").slice(0, 24)}`;
}

export class CrawlInputError extends Error {}

/** 화면 입력 검증. 사이트 URL 검증은 crawler 도 한 번 더 한다 */
export function sanitizeCrawlRun(input: Record<string, unknown>, now = new Date()): CrawlRunJobData {
  const max = Number(input.max ?? 20);
  if (!Number.isInteger(max) || max < 1 || max > CRAWL_RUN_MAX) throw new CrawlInputError(`수집 건수는 1~${CRAWL_RUN_MAX}`);
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const keyword = str(input.keyword);
  if (keyword && keyword.length > 50) throw new CrawlInputError("검색어는 50자 이하");
  const listUrl = str(input.listUrl);
  if (listUrl) {
    let u: URL;
    try {
      u = new URL(listUrl);
    } catch {
      throw new CrawlInputError("검색 결과 URL 형식이 아닙니다.");
    }
    // 호스트 허용 목록은 .env.local BOARD_A_HOSTS(쉼표). 없으면 형식만 보고 호스트는 crawler 가 최종 검사한다
    const hosts = (process.env.BOARD_A_HOSTS ?? "").split(",").map((h) => h.trim()).filter(Boolean);
    if (u.protocol !== "https:" || (hosts.length > 0 && !hosts.includes(u.hostname)) || !u.pathname.startsWith("/zf_user/search")) {
      throw new CrawlInputError("검색 결과 URL 은 수집처 검색 결과 주소(https)만 됩니다.");
    }
  }
  const rawIds = Array.isArray(input.ids) ? input.ids : typeof input.ids === "string" ? input.ids.split(/[\s,]+/) : [];
  const ids = rawIds.map((i) => String(i).trim()).filter(Boolean);
  if (ids.some((i) => !/^\d{5,12}$/.test(i))) throw new CrawlInputError("공고 ID 는 숫자만");
  if (ids.length > CRAWL_RUN_MAX) throw new CrawlInputError(`공고 ID 는 ${CRAWL_RUN_MAX}개까지`);
  const kst = new Date(now.getTime() + 9 * 3600 * 1000).toISOString();
  const batchId = str(input.batchId) ?? `${CRAWL_PLATFORM}-${kst.slice(0, 10).replace(/-/g, "")}-${kst.slice(11, 16).replace(":", "")}`;
  if (!/^[\w.-]{1,60}$/.test(batchId)) throw new CrawlInputError("배치 이름은 영문·숫자·_.- 60자 이하");
  return { batchId, max: ids.length ? Math.max(max, ids.length) : max, ...(keyword && { keyword }), ...(listUrl && { listUrl }), ...(ids.length && { ids }) };
}

/** 같은 배치 이름으로 대기·실행 중이면 409, 끝난 잡은 지우고 새로 넣는다 */
export async function enqueueCrawlRun(data: CrawlRunJobData): Promise<{ jobId: string }> {
  const q = getCrawlRunQueue();
  const jobId = buildCrawlRunJobId(data.batchId);
  const existing = await q.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (state !== "completed" && state !== "failed") throw new CrawlInputError(`배치 ${data.batchId} 수집이 이미 진행 중입니다.`);
    await existing.remove();
  }
  await q.add("run", data, { jobId });
  return { jobId };
}

export async function getCrawlRunStatus(jobId: string) {
  if (!/^crawl-run_[0-9a-f]{24}$/.test(jobId)) return null;
  const job = await getCrawlRunQueue().getJob(jobId);
  if (!job) return null;
  const state = await job.getState();
  return {
    jobId,
    batchId: job.data.batchId,
    state,
    progress: job.progress,
    ...(state === "completed" ? { result: job.returnvalue } : {}),
    // crawler 가 redact 한 사유만 보여 준다 (키·DB 원문 없음)
    ...(state === "failed" ? { error: job.failedReason?.startsWith("[crawl] ") ? job.failedReason.slice(8) : "수집 중 서버 오류가 발생했습니다. orchestrator 로그를 확인하세요." } : {}),
  };
}

// ---------------------------------------------------------------------------
// 워커
// ---------------------------------------------------------------------------

const crawlerUrl = () => (process.env.CRAWLER_URL || "http://127.0.0.1:8010").replace(/\/$/, "");

async function crawler<T>(path: string, init: RequestInit = {}): Promise<T> {
  const key = process.env.CRAWLER_API_KEY;
  if (!key) throw new Error("[crawl] orchestrator 에 CRAWLER_API_KEY 가 없습니다.");
  let res: Response;
  try {
    res = await fetch(`${crawlerUrl()}${path}`, {
      ...init,
      headers: { "X-Internal-Key": key, ...(init.body ? { "Content-Type": "application/json" } : {}) },
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new Error(`[crawl] 크롤러(${crawlerUrl()})에 연결할 수 없습니다.`);
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(`[crawl] 크롤러 ${res.status}: ${String(body.detail ?? "").slice(0, 200)}`);
  return body as T;
}

/** crawler 내부 잡(스레드 큐)이 끝날 때까지 기다린다 */
async function waitCrawlerJob(jobId: string, timeoutMs: number): Promise<Record<string, unknown>> {
  const started = Date.now();
  for (;;) {
    const j = await crawler<{ status: string; result: Record<string, unknown> | null }>(`/v1/jobs/${jobId}`);
    if (j.status === "done") return j.result ?? {};
    if (j.status === "failed") {
      const r = j.result ?? {};
      throw new Error(`[crawl] ${String(r.error ?? "failed")}${r.reason ? ` (${String(r.reason)})` : ""}${r.detail ? `: ${String(r.detail).slice(0, 200)}` : ""}`);
    }
    if (Date.now() - started > timeoutMs) throw new Error("[crawl] 크롤러 작업 시간 초과");
    await new Promise((r) => setTimeout(r, 3000));
  }
}

interface PrunedRecord {
  external_id: string;
  title: string;
  company: string;
  has_body: boolean;
  key_duties: string[];
  must_have: string[];
  nice_to_have: string[];
  unclassified_items: string[];
}

async function processCrawlRun(job: Job<CrawlRunJobData>): Promise<CrawlRunResult> {
  const d = job.data;
  const stage = (s: CrawlRunStage, extra: Record<string, unknown> = {}) => job.updateProgress({ stage, ...extra });

  await stage("crawling");
  const started = await crawler<{ job_id: string }>("/v1/platform", {
    method: "POST",
    body: JSON.stringify({ platform: CRAWL_PLATFORM, max: d.max, keyword: d.keyword, list_url: d.listUrl, ids: d.ids }),
  });
  const crawled = await waitCrawlerJob(started.job_id, 2 * 3600_000);
  const jsonName = String(crawled.json_name);

  const { records } = await crawler<{ records: PrunedRecord[] }>(`/v1/platform-records/${encodeURIComponent(jsonName)}`);
  const compressed: Record<string, unknown>[] = [];
  let ok = 0;
  let failed = 0;
  for (const [i, r] of records.entries()) {
    await stage("compressing", { done: i, total: records.length });
    if (!r.has_body) {
      compressed.push({ external_id: r.external_id, skipped: "본문 텍스트 없음(이미지형 의심) — 사람이 링크로 확인" });
      continue;
    }
    try {
      const c = await callMcpTool<{ data: Record<string, unknown>; status: string }>("compress_jd", {
        title: r.title.slice(0, 300),
        company: r.company.slice(0, 200),
        key_duties: r.key_duties.slice(0, 80),
        must_have: r.must_have.slice(0, 80),
        nice_to_have: r.nice_to_have.slice(0, 80),
        unclassified: r.unclassified_items.slice(0, 120),
      });
      compressed.push({ external_id: r.external_id, ...c.data, compress_status: c.status });
      ok += 1;
    } catch (err) {
      // 한 건 실패는 그 행만 구조화 없이 적재 → 규칙이 격리해 사람이 본다
      compressed.push({ external_id: r.external_id, error: err instanceof Error ? err.message.slice(0, 200) : String(err) });
      failed += 1;
    }
  }

  await stage("loading");
  const load = await crawler<{ job_id: string }>("/v1/platform-load", {
    method: "POST",
    body: JSON.stringify({ platform: CRAWL_PLATFORM, json_name: jsonName, batch_id: d.batchId, compressed }),
  });
  const loaded = (await waitCrawlerJob(load.job_id, 30 * 60_000)) as unknown as CrawlRunResult["loaded"];

  await stage("preparing");
  const prepared = await prepareBatch(d.batchId);
  await stage("done");
  return {
    batchId: d.batchId,
    fetched: records.length,
    compressed: ok,
    compressFailed: failed,
    loaded: { inserted: loaded.inserted, updated: loaded.updated, skipped_resolved: loaded.skipped_resolved, failed: loaded.failed },
    prepared,
  };
}

export function startCrawlRunWorker() {
  // 크롤러가 한 번에 하나만 돌리므로 여기서도 하나씩
  const worker = new Worker<CrawlRunJobData, CrawlRunResult>(CRAWL_RUN_QUEUE, processCrawlRun, { connection: connection(), concurrency: 1, lockDuration: 120_000 });
  worker.on("completed", (job, r) => {
    console.log(`[${worker.name}] job ${job.id} completed (batch=${r.batchId}, fetched=${r.fetched}, compressed=${r.compressed})`);
  });
  worker.on("failed", (job, err) => {
    console.error(`[${worker.name}] job ${job?.id} failed:`, err.message);
    if (job) Sentry.captureException(err, { tags: { worker: worker.name, jobId: job.id, batchId: job.data.batchId } });
  });
  return worker;
}

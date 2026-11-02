import { createHash } from "node:crypto";
import { db } from "./db.js";
import { computeFacets } from "./postingFacets.js";

/**
 * 크롤 검수 (SQL 013, web /crawling).
 *
 * 흐름: 배치 준비(prepare) → 코드 규칙으로 격리(needs_review) + 통과분에서 샘플 표시 → 사람이 예외·샘플 판정
 *      → 배치 승인 → 승인된 행만 fit.job_postings 로 병합.
 * 판정은 LLM 없이 코드 규칙만 쓴다 (토큰 원칙). 샘플에서 오류가 나오면 배치 승인을 막고 규칙을 보강한다.
 */

export type ReviewStatus = "ok" | "retry_later" | "needs_review" | "resolved" | "approved" | "rejected";
export type RejectReason = "ad" | "irrelevant" | "broken" | "duplicate" | "other";
export type ReviewTab = "exceptions" | "sample" | "all";

export const REJECT_REASONS: RejectReason[] = ["ad", "irrelevant", "broken", "duplicate", "other"];

/** 사람이 고칠 수 있는 필드. 원본은 두고 edits(jsonb)에 덮어쓸 값만 저장한다. */
export const EDITABLE_FIELDS = ["title", "company", "role_summary", "key_duties", "must_have", "nice_to_have", "skills"] as const;
export type EditableField = (typeof EDITABLE_FIELDS)[number];
type Edits = Partial<Record<EditableField, string | string[]>>;
const ARRAY_FIELDS = new Set<EditableField>(["key_duties", "must_have", "nice_to_have", "skills"]);

export const SAMPLE_RATE = 0.05;
export const SAMPLE_MIN = 10;

export interface CrawledRow {
  id: string;
  platform: string;
  external_id: string;
  job_posting_id: string | null;
  url: string;
  company: string | null;
  title: string;
  career_text: string | null;
  education_text: string | null;
  employment_type_text: string | null;
  salary_text: string | null;
  location_text: string | null;
  work_hours_text: string | null;
  deadline_date: string | null;
  deadline_text: string | null;
  body_text: string | null;
  body_image_count: number;
  body_text_missing: boolean;
  role_summary: string | null;
  key_duties: string[];
  must_have: string[];
  nice_to_have: string[];
  skills: string[];
  review_status: ReviewStatus;
  review_note: string | null;
  load_batch_id: string | null;
  is_sample: boolean;
  review_flags: string[];
  reject_reason: RejectReason | null;
  edits: Edits;
  reviewed_at: string | null;
}

/** 크롤 원본 테이블 (플랫폼 공통, SQL 014) */
const RAW = "crawled_postings";

const COLUMNS =
  "id, platform, external_id, job_posting_id, url, company, title, career_text, education_text, employment_type_text, salary_text, location_text, work_hours_text, " +
  "deadline_date, deadline_text, body_text, body_image_count, body_text_missing, role_summary, key_duties, must_have, nice_to_have, skills, " +
  "review_status, review_note, load_batch_id, is_sample, review_flags, reject_reason, edits, reviewed_at";

// ---------------------------------------------------------------------------
// 규칙 (순수 함수 — 판정 근거가 화면에 그대로 보인다)
// ---------------------------------------------------------------------------

const BODY_MIN = 300;
const AD_KEYWORDS = ["고수익", "부업", "재택알바", "재택 알바", "다단계", "네트워크마케팅", "투자자 모집", "코인", "대출", "일당", "수당 지급", "무자본"];

/** 사람에게 보여 줄 격리 사유 코드 목록. 빈 배열이면 규칙 통과. */
export function computeFlags(row: CrawledRow, today: string, duplicateKeys: Set<string> = new Set()): string[] {
  const flags: string[] = [];
  const body = row.body_text ?? "";
  if (row.body_text_missing || (row.body_image_count > 0 && body.length < BODY_MIN)) flags.push("image_body");
  else if (body.length < BODY_MIN) flags.push("body_short");
  if (!row.company?.trim()) flags.push("no_company");
  if (row.skills.length === 0) flags.push("no_skills");
  if (row.key_duties.length === 0 && row.must_have.length === 0) flags.push("no_duties");
  const text = `${row.title} ${body}`.replace(/\s+/g, " ");
  if (AD_KEYWORDS.some((k) => text.includes(k))) flags.push("ad_keyword");
  if (row.deadline_date && row.deadline_date < today) flags.push("deadline_passed");
  if (duplicateKeys.has(dupKey(row))) flags.push("duplicate");
  return flags;
}

export function dupKey(row: Pick<CrawledRow, "company" | "title">): string {
  return `${(row.company ?? "").replace(/\s+/g, "")}|${row.title.replace(/\s+/g, "")}`.toLowerCase();
}

/** 배치 안에서 회사+제목이 같은 행들의 키 (두 번째 이후만 duplicate 로 표시하려면 호출부에서 첫 행 제외) */
export function findDuplicateKeys(rows: CrawledRow[]): Map<string, string> {
  const firstIdByKey = new Map<string, string>();
  const dupOf = new Map<string, string>(); // rowId → 첫 행 id
  for (const r of rows) {
    const k = dupKey(r);
    const first = firstIdByKey.get(k);
    if (first) dupOf.set(r.id, first);
    else firstIdByKey.set(k, r.id);
  }
  return dupOf;
}

/** 결정적 샘플: 같은 배치면 몇 번을 돌려도 같은 행이 뽑힌다 (id 해시 순). */
export function pickSample(ids: string[], rate = SAMPLE_RATE, min = SAMPLE_MIN): string[] {
  const n = Math.min(ids.length, Math.max(min, Math.ceil(ids.length * rate)));
  return [...ids]
    .sort((a, b) => createHash("sha256").update(a).digest("hex").localeCompare(createHash("sha256").update(b).digest("hex")))
    .slice(0, n);
}

/** 원본 + edits 를 합친 최종 값 */
export function effective(row: CrawledRow): CrawledRow {
  const out: Record<string, unknown> = { ...row };
  for (const f of EDITABLE_FIELDS) {
    const v = row.edits?.[f];
    if (v !== undefined) out[f] = v;
  }
  return out as unknown as CrawledRow;
}

/** 편집 입력 검증 — 허용 필드만, DB CHECK 와 같은 상한 */
export function sanitizeEdits(input: unknown): Edits {
  if (!input || typeof input !== "object") throw new Error("edits 는 객체여야 합니다.");
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (!(EDITABLE_FIELDS as readonly string[]).includes(k)) throw new Error(`수정할 수 없는 필드: ${k}`);
    const f = k as EditableField;
    if (ARRAY_FIELDS.has(f)) {
      if (!Array.isArray(v)) throw new Error(`${f} 는 배열이어야 합니다.`);
      const max = f === "skills" ? 60 : 200;
      out[f] = v.map((s) => String(s).trim()).filter(Boolean).slice(0, 50).map((s) => s.slice(0, max));
    } else {
      if (typeof v !== "string") throw new Error(`${f} 는 문자열이어야 합니다.`);
      const s = v.trim();
      if (f === "title" && !s) throw new Error("title 은 비울 수 없습니다.");
      out[f] = f === "role_summary" ? s.slice(0, 200) : s.slice(0, 300);
    }
  }
  return out as Edits;
}

/**
 * job_postings.description. 09 결정: 압축 산문(compressed_text) 대신 구조화 배열을 쓰고,
 * 근무조건은 크롤 원본 필드를 그대로 쓴다. 배열이 비면 본문 앞부분으로 대체.
 */
export function buildDescription(r: CrawledRow): string {
  const parts: string[] = [];
  if (r.role_summary) parts.push(r.role_summary);
  const section = (name: string, items: string[]) => {
    if (items.length) parts.push(`[${name}]\n${items.map((i) => `- ${i}`).join("\n")}`);
  };
  section("주요업무", r.key_duties);
  section("자격요건", r.must_have);
  section("우대사항", r.nice_to_have);
  if (parts.length === 0 && r.body_text) parts.push(r.body_text.slice(0, 4000));
  const cond = [
    ["경력", r.career_text],
    ["근무형태", r.employment_type_text],
    ["급여", r.salary_text],
    ["근무지", r.location_text],
    ["근무시간", r.work_hours_text],
  ].filter(([, v]) => v) as [string, string][];
  if (cond.length) parts.push(`[근무조건]\n${cond.map(([k, v]) => `- ${k}: ${v}`).join("\n")}`);
  return parts.join("\n\n");
}

export function toJobPosting(raw: CrawledRow) {
  const r = effective(raw);
  const description = buildDescription(r);
  return {
    source: r.platform,
    external_id: r.external_id,
    url: r.url,
    company: r.company,
    title: r.title,
    description,
    skills: r.skills,
    location: r.location_text,
    employment_type: r.employment_type_text,
    experience_level: r.career_text,
    salary: r.salary_text,
    expires_at: r.deadline_date ? `${r.deadline_date}T23:59:59+09:00` : null,
    raw: { crawled_posting_id: r.id, external_id: r.external_id, edited: Object.keys(r.edits ?? {}) },
    ...computeFacets({ ...r, deadline_date: r.deadline_date }),
    content_hash: createHash("sha256").update(`${r.title}|${r.company ?? ""}|${description}`).digest("hex").slice(0, 32),
  };
}

// ---------------------------------------------------------------------------
// DB
// ---------------------------------------------------------------------------

const today = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10); // KST

function fail(error: { message: string } | null): void {
  if (error) throw new Error(error.message);
}

const PAGE = 1000; // PostgREST 기본 응답 상한

/** 배치 전체 (페이지 단위로 끝까지 읽는다 — 앞 N행에서 잘리지 않게) */
async function batchRows(batchId: string): Promise<CrawledRow[]> {
  const out: CrawledRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from(RAW)
      .select(COLUMNS)
      .eq("load_batch_id", batchId)
      .order("id")
      .range(from, from + PAGE - 1);
    fail(error);
    out.push(...((data ?? []) as unknown as CrawledRow[]));
    if (!data || data.length < PAGE) return out;
  }
}

/** 같은 값으로 바꿀 id 들을 묶어 한 번에 update (행마다 왕복하지 않는다) */
async function updateIn(ids: string[], patch: Record<string, unknown>, onlyStatus?: ReviewStatus): Promise<string[]> {
  const done: string[] = [];
  for (let i = 0; i < ids.length; i += 200) {
    let q = db.from(RAW).update(patch).in("id", ids.slice(i, i + 200));
    if (onlyStatus) q = q.eq("review_status", onlyStatus);
    const { data, error } = await q.select("id");
    fail(error);
    done.push(...((data ?? []) as { id: string }[]).map((r) => r.id));
  }
  return done;
}

export interface BatchSummary {
  batchId: string;
  total: number;
  counts: Record<string, number>;
  sampleTotal: number;
  samplePending: number;
  prepared: boolean;
}

const LIST_BATCHES_MAX = 10000;

export async function listBatches(): Promise<BatchSummary[]> {
  const { data, error } = await db
    .from(RAW)
    .select("load_batch_id, review_status, is_sample, review_flags, created_at")
    .order("created_at", { ascending: false })
    .limit(LIST_BATCHES_MAX);
  fail(error);
  if ((data ?? []).length >= LIST_BATCHES_MAX) console.warn(`[crawlReview] listBatches: ${LIST_BATCHES_MAX}행 상한 도달 — 집계가 일부만 반영됩니다.`);
  const map = new Map<string, BatchSummary>();
  for (const r of (data ?? []) as { load_batch_id: string | null; review_status: string; is_sample: boolean }[]) {
    const id = r.load_batch_id ?? "(배치 없음)";
    const b = map.get(id) ?? { batchId: id, total: 0, counts: {}, sampleTotal: 0, samplePending: 0, prepared: false };
    b.total += 1;
    b.counts[r.review_status] = (b.counts[r.review_status] ?? 0) + 1;
    if (r.is_sample) {
      b.sampleTotal += 1;
      b.prepared = true;
      if (r.review_status === "ok") b.samplePending += 1;
    }
    map.set(id, b);
  }
  return [...map.values()];
}

/** 규칙 판정 + 샘플 표시. 다시 돌려도 안전 (사람이 판정한 행은 건드리지 않는다). */
export async function prepareBatch(batchId: string): Promise<{ flagged: number; sampled: number; passed: number }> {
  const rows = await batchRows(batchId);
  const dupOf = findDuplicateKeys(rows);
  const dupKeys = new Set(rows.filter((r) => dupOf.has(r.id)).map(dupKey));
  const t = today();
  const passedIds: string[] = [];
  const groups = new Map<string, { flags: string[]; status: ReviewStatus; from: ReviewStatus; ids: string[] }>();
  let flagged = 0;
  for (const r of rows) {
    if (r.review_status !== "ok" && r.review_status !== "needs_review") continue; // 사람이 판정했거나 재수집 대기
    // 중복은 두 번째 행부터만 표시
    const flags = computeFlags(r, t, dupOf.has(r.id) ? dupKeys : new Set());
    // 크롤러가 격리한 행(아직 규칙 판정 전 = flags 비어 있음)은 규칙이 통과시켜도 격리 유지
    const crawlerFlagged = r.review_status === "needs_review" && (r.review_flags.length === 0 || r.review_flags.includes("crawler_flag"));
    if (crawlerFlagged && !flags.includes("crawler_flag")) flags.push("crawler_flag");
    const status: ReviewStatus = flags.length ? "needs_review" : "ok";
    if (flags.length) flagged += 1;
    else passedIds.push(r.id);
    // 읽을 때의 상태도 키에 넣는다 → update 때 그 상태 그대로인 행만 바꾼다 (그 사이 사람이 판정한 행은 건드리지 않음)
    const key = `${r.review_status}|${status}|${flags.join(",")}`;
    const g = groups.get(key) ?? { flags, status, from: r.review_status, ids: [] };
    g.ids.push(r.id);
    groups.set(key, g);
  }
  for (const g of groups.values()) await updateIn(g.ids, { review_flags: g.flags, review_status: g.status }, g.from);
  // 샘플은 처음 한 번만 뽑는다 (이미 있으면 유지 → 화면이 매번 바뀌지 않는다)
  const already = rows.filter((r) => r.is_sample).length;
  let sampled = already;
  if (already === 0 && passedIds.length) {
    const ids = pickSample(passedIds);
    await updateIn(ids, { is_sample: true }, "ok");
    sampled = ids.length;
  }
  return { flagged, sampled, passed: passedIds.length };
}

export async function listRows(params: { batchId?: string; tab: ReviewTab; limit: number }): Promise<CrawledRow[]> {
  let q = db.from(RAW).select(COLUMNS).order("created_at", { ascending: false }).limit(params.limit);
  if (params.batchId) q = q.eq("load_batch_id", params.batchId);
  if (params.tab === "exceptions") q = q.in("review_status", ["needs_review", "retry_later", "rejected"]); // 제외(광고 등)도 같이 보여 준다
  if (params.tab === "sample") q = q.eq("is_sample", true);
  const { data, error } = await q;
  fail(error);
  return (data ?? []) as unknown as CrawledRow[];
}

async function getRow(id: string): Promise<CrawledRow> {
  const { data, error } = await db.from(RAW).select(COLUMNS).eq("id", id).maybeSingle();
  fail(error);
  if (!data) throw new NotFoundError("행을 찾을 수 없습니다.");
  return data as unknown as CrawledRow;
}

export class NotFoundError extends Error {}
export class ConflictError extends Error {}

/** 승인된 행 → job_postings upsert → crawled_postings.job_posting_id 연결 */
const LINK_CONCURRENCY = 20;

export async function mergeApproved(ids: string[]): Promise<{ merged: number }> {
  if (ids.length === 0) return { merged: 0 };
  // id 목록이 URL 쿼리스트링에 실리므로 200개씩 나눠 읽는다 (수천 개면 URL 길이 상한에 걸림)
  const rows: CrawledRow[] = [];
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await db.from(RAW).select(COLUMNS).in("id", ids.slice(i, i + 200)).eq("review_status", "approved");
    fail(error);
    rows.push(...((data ?? []) as unknown as CrawledRow[]));
  }
  let merged = 0;
  for (let i = 0; i < rows.length; i += 100) {
    const chunk = rows.slice(i, i + 100);
    const { data: up, error: upErr } = await db
      .from("job_postings")
      .upsert(chunk.map(toJobPosting), { onConflict: "source,external_id" })
      .select("id, source, external_id");
    fail(upErr);
    // 키는 (source, external_id): 여러 플랫폼이 섞인 배치에서 ID 가 겹칠 수 있다
    const byRec = new Map(((up ?? []) as { id: string; source: string; external_id: string }[]).map((p) => [`${p.source}|${p.external_id}`, p.id]));
    // 행마다 값이 달라 묶음 update 가 안 된다 → 동시 20개로 왕복 시간을 줄인다.
    // TODO(SQL 014): link 를 RPC 한 번으로 (배치 승인 자체는 BullMQ 잡에서 돈다)
    const links = chunk
      .map((r) => ({ id: r.id, jpId: byRec.get(`${r.platform}|${r.external_id}`), cur: r.job_posting_id }))
      .filter((l) => l.jpId && l.jpId !== l.cur);
    for (let j = 0; j < links.length; j += LINK_CONCURRENCY) {
      await Promise.all(
        links.slice(j, j + LINK_CONCURRENCY).map(async (l) => {
          // 읽은 뒤 다른 탭에서 제외·재수집됐으면 연결하지 않고, 방금 올린 정본을 내린다 (승인 안 된 공고가 남지 않게)
          const { data, error: linkErr } = await db
            .from(RAW)
            .update({ job_posting_id: l.jpId })
            .eq("id", l.id)
            .eq("review_status", "approved")
            .select("id");
          fail(linkErr);
          if (!data?.length) {
            const { error: delErr } = await db.from("job_postings").delete().eq("id", l.jpId!);
            fail(delErr);
          }
        })
      );
    }
    merged += chunk.length;
  }
  return { merged };
}

export type RowAction =
  | { action: "approve" }
  | { action: "reject"; reason: RejectReason; note?: string }
  | { action: "recrawl"; note?: string }
  | { action: "reopen" }
  | { action: "edit"; edits: unknown };

export async function applyRowAction(id: string, a: RowAction): Promise<CrawledRow> {
  const row = await getRow(id);
  const stamp = { reviewed_by: "admin", reviewed_at: new Date().toISOString() };
  let patch: Record<string, unknown>;
  switch (a.action) {
    case "approve":
      patch = { review_status: "approved", reject_reason: null, ...stamp };
      break;
    case "reject":
      if (!REJECT_REASONS.includes(a.reason)) throw new Error("reason 은 ad|irrelevant|broken|duplicate|other 중 하나");
      patch = { review_status: "rejected", reject_reason: a.reason, review_note: a.note?.slice(0, 500) ?? row.review_note, ...stamp };
      break;
    case "recrawl":
      patch = { review_status: "retry_later", review_note: a.note?.slice(0, 500) ?? row.review_note, ...stamp };
      break;
    case "reopen":
      patch = { review_status: row.review_flags.length ? "needs_review" : "ok", reject_reason: null, ...stamp };
      break;
    case "edit":
      patch = { edits: { ...row.edits, ...sanitizeEdits(a.edits) }, ...stamp };
      break;
    default:
      throw new Error("알 수 없는 action");
  }
  const nextStatus = (patch.review_status as ReviewStatus | undefined) ?? row.review_status;
  if (nextStatus !== "approved" && row.job_posting_id) {
    // 승인 취소(제외·재수집·되돌리기) → 정본을 먼저 내린다. 여기서 실패하면 상태도 그대로라 화면과 정본이 어긋나지 않는다.
    // FK 는 on delete set null
    const { error: delErr } = await db.from("job_postings").delete().eq("id", row.job_posting_id);
    fail(delErr);
  }
  const { error } = await db.from(RAW).update(patch).eq("id", id);
  fail(error);
  // 승인 상태면 정본을 다시 맞춘다 (수정 반영). 실패해도 approved + job_posting_id NULL 로 남아 배치 승인이 다시 병합한다
  if (nextStatus === "approved") await mergeApproved([id]);
  return getRow(id);
}

/**
 * 배치 승인 사전 검사 (HTTP 요청 안): 샘플에 오류(제외·재수집)가 없어야 한다. 아니면 ConflictError(409).
 * 미판정 샘플은 막지 않는다 — 사람이 샘플을 훑어본 뒤 배치 승인 한 번으로 샘플까지 같이 승인한다.
 * 실제 승인·병합은 수천 행이 될 수 있어 BullMQ 잡(queue/crawlApproveQueue.ts)이 runBatchApproval 로 처리한다 (헌법 2조).
 */
export async function assertBatchApprovable(batchId: string, rows?: CrawledRow[]): Promise<CrawledRow[]> {
  rows ??= await batchRows(batchId);
  if (rows.length === 0) throw new NotFoundError("배치에 행이 없습니다.");
  const sample = rows.filter((r) => r.is_sample);
  if (sample.length === 0) throw new ConflictError("배치 준비(prepare)를 먼저 실행하세요.");
  const bad = sample.filter((r) => r.review_status === "retry_later" || (r.review_status === "rejected" && r.reject_reason !== "duplicate"));
  if (bad.length) {
    throw new ConflictError(`샘플 ${bad.length}건에서 오류가 나왔습니다. 규칙이 놓친 유형이니 규칙을 보강하고 다시 준비하세요.`);
  }
  return rows;
}

/**
 * 배치 승인 본체 (워커): 규칙 통과(ok) 행 전체(미판정 샘플 포함) + 예외에서 개별 승인한 행을 병합한 뒤 배치를 지운다.
 * 격리·재수집·제외 행은 병합하지 않는다.
 * 큐에 들어간 뒤 샘플 판정이 바뀌었을 수 있으므로 같은 검사를 다시 한다.
 */
export async function runBatchApproval(batchId: string): Promise<{ approved: number; merged: number; deleted: number }> {
  const rows = await assertBatchApprovable(batchId);
  // 읽은 뒤 다른 탭에서 제외·재수집된 행을 덮지 않도록, 아직 ok 인 행만 바꾸고 실제로 바뀐 id 만 쓴다
  const candidates = rows.filter((r) => r.review_status === "ok").map((r) => r.id);
  const approved = await updateIn(candidates, { review_status: "approved", reviewed_by: "admin", reviewed_at: new Date().toISOString() }, "ok");
  // 병합 대상 = 이번에 승인된 행 + 승인됐지만 아직 정본에 없는 행 (이미 병합된 행은 다시 올리지 않는다)
  const unmerged = rows.filter((r) => r.review_status === "approved" && !r.job_posting_id).map((r) => r.id);
  const { merged } = await mergeApproved([...approved, ...unmerged]);
  // 병합이 끝난 배치는 목록에서 내린다 (정본 job_postings 는 남는다. 미처리 예외·제외 행도 같이 지워진다)
  const { deleted } = await deleteBatch(batchId);
  return { approved: approved.length, merged, deleted };
}

/**
 * 배치 삭제: 크롤 원본(crawled_postings, 카테고리 연결은 cascade)만 지운다.
 * 이미 병합된 job_postings 는 승인된 정본이라 남긴다 (FK on delete set null).
 * 주의: 제외한 행도 지워지므로, 같은 공고를 다시 크롤하면 새 행으로 들어와 다시 검수 대상이 된다.
 */
export async function deleteBatch(batchId: string): Promise<{ deleted: number }> {
  const { data, error } = await db.from(RAW).delete().eq("load_batch_id", batchId).select("id");
  fail(error);
  return { deleted: (data ?? []).length };
}

/**
 * 스카우트 건 (20 문서 C2) = jd_runs 확장(017). 별도 신규 시스템이 아니다 (CLAUDE.md 구현 순서).
 *  POST  /api/scout-cases/draft       본문 + 공고 조건(사람인 표기) → "확인할 역량" 초안 + 필터 값 (정규화 1회, jd 해시 캐시)
 *  POST  /api/scout-cases             건 만들기 (제목·고객사·담당·마감·공고 조건·필수/우대 요건)
 *  GET   /api/scout-cases             내 건 목록 + 단계별 인원
 *  GET   /api/scout-cases/:id         건 상세
 *  PATCH /api/scout-cases/:id         정보·요건 수정
 *  POST  /api/scout-cases/:id/start   후보 탐색(코드 사전필터) → 상위 N명 분석을 큐에 넣는다 (응답은 즉시)
 *  POST  /api/scout-cases/:id/close   건 종료
 *  POST  /api/scout-cases/:id/candidates  인재풀에서 고른 후보를 이 건 분석 큐에 넣는다 (담기)
 *  GET   /api/scout-cases/:id/scores      순위 점수 근거 (match_scores.score_breakdown, 항목별 0~1)
 * 학력·나이는 요건으로 받지 않는다 (20 문서 §1 스킬 중심).
 */
import type { Express, Request, Response } from "express";
import { db } from "./db.js";
import { FORBIDDEN, resolveUserId } from "./auth.js";
import { getCachedReport, jdHash } from "./cache.js";
import { loadMarksSafe, clearRetry, member } from "./fitState.js";
import { buildJdPlan } from "./jdPlan.js";
import { getJobRequirements, type JobRequirements } from "./jobRequirements.js";
import { recordStatusEvent } from "./deskRoutes.js";
import { enqueueFitBatch, respondIfRejected } from "../queue/enqueue.js";
import { extractJdHeadline } from "../../../shared/lib/shortlist.js";
import { computeFacets, type PostingFacets } from "./postingFacets.js";
import { callMcpTool } from "../mcp/client.js";
import { composePostingText, splitPostingText } from "../../../shared/lib/postingFormat.js";

export interface CaseRequirement {
  label: string;
  required: boolean;
}

export interface CaseRequirements {
  items: CaseRequirement[];
  role: string | null;
  legacy_role: "developer" | "designer";
  years_min: number | null;
  years_max: number | null;
  locations: string[];
  remote_ok: boolean | null;
}

const MAX_ITEMS = 20;
const MAX_LABEL = 60;
// 학력·나이·성별 같은 조건은 역량 요건이 아니다 — 받지 않는다
const BANNED = /학력|학위|대졸|졸업|나이|연령|세\s*이하|세\s*미만|성별|남성|여성|군필/;

/** 정규화 결과 → 화면 체크리스트 */
export function toCaseRequirements(req: JobRequirements): CaseRequirements {
  const seen = new Set<string>();
  const items: CaseRequirement[] = [];
  for (const [list, required] of [[req.must_skills, true], [req.nice_skills, false]] as const) {
    for (const raw of list) {
      const label = raw.trim();
      const key = label.toLowerCase();
      if (!label || seen.has(key) || BANNED.test(label)) continue;
      seen.add(key);
      items.push({ label, required });
    }
  }
  return {
    items: items.slice(0, MAX_ITEMS),
    role: req.role,
    legacy_role: req.legacy_role,
    years_min: req.years_min,
    years_max: req.years_max,
    locations: req.locations,
    remote_ok: req.remote_ok,
  };
}

/** 체크리스트 → 탐색용 요건 (헤드헌터가 고친 값이 그대로 들어간다) */
export function toJobRequirements(c: CaseRequirements): JobRequirements {
  return {
    role: c.role,
    legacy_role: c.legacy_role,
    role_confidence: 100,
    must_skills: c.items.filter((i) => i.required).map((i) => i.label),
    nice_skills: c.items.filter((i) => !i.required).map((i) => i.label),
    years_min: c.years_min,
    years_max: c.years_max,
    locations: c.locations,
    remote_ok: c.remote_ok,
  };
}

/** 클라이언트 입력 검증. 잘못된 항목은 버리고, 금지 조건이 있으면 이유를 돌려준다 */
export function sanitizeRequirements(input: unknown, fallback: CaseRequirements | null): { value: CaseRequirements | null; rejected: string[] } {
  if (!input || typeof input !== "object") return { value: fallback, rejected: [] };
  const o = input as Partial<CaseRequirements>;
  const rejected: string[] = [];
  const seen = new Set<string>();
  const items: CaseRequirement[] = [];
  for (const it of Array.isArray(o.items) ? o.items : []) {
    const label = typeof it?.label === "string" ? it.label.trim().slice(0, MAX_LABEL) : "";
    if (!label || seen.has(label.toLowerCase())) continue;
    if (BANNED.test(label)) {
      rejected.push(label);
      continue;
    }
    seen.add(label.toLowerCase());
    items.push({ label, required: it.required !== false });
  }
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 40 ? v : null);
  const legacy = o.legacy_role === "designer" ? "designer" : o.legacy_role === "developer" ? "developer" : fallback?.legacy_role ?? "developer";
  return {
    value: {
      items: items.slice(0, MAX_ITEMS),
      role: typeof o.role === "string" ? o.role : fallback?.role ?? null,
      legacy_role: legacy,
      years_min: num(o.years_min),
      years_max: num(o.years_max),
      locations: Array.isArray(o.locations) ? o.locations.filter((l): l is string => typeof l === "string").slice(0, 10) : [],
      remote_ok: typeof o.remote_ok === "boolean" ? o.remote_ok : null,
    },
    rejected,
  };
}

const text = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const date = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) ? v : null);

/**
 * 공고 조건 (사람인 상세 표기와 같은 문자열). 크롤 공고와 같은 규칙(postingFacets)으로 필터 값을 만든다.
 * 학력은 공고 조건으로만 보관한다 — 후보 탐색 요건(items)에는 넣지 않는다 (20 문서 §1).
 */
export interface CasePosting {
  location_text: string | null;
  career_text: string | null;
  education_text: string | null;
  employment_type_text: string | null;
  salary_text: string | null;
  deadline_text: string | null;
  work_hours_text: string | null;
}

export function sanitizePosting(input: unknown): CasePosting {
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  return {
    location_text: text(o.location_text, 120),
    career_text: text(o.career_text, 60),
    education_text: text(o.education_text, 60),
    employment_type_text: text(o.employment_type_text, 80),
    salary_text: text(o.salary_text, 80),
    deadline_text: text(o.deadline_text, 40),
    work_hours_text: text(o.work_hours_text, 80),
  };
}

/** 표준 양식(shared/lib/postingFormat)으로 본문 + [근무조건]. 크롤 공고 description 과 같은 모양이라 정규화 결과를 나란히 비교할 수 있다 */
export function composeCaseJd(body: string, p: CasePosting): string {
  return composePostingText(splitPostingText(body), p);
}

/** 경력·지역은 입력 조건이 AI 추정보다 우선 */
export function applyPostingFacets(req: CaseRequirements, f: PostingFacets): CaseRequirements {
  return {
    ...req,
    years_min: f.career_min ?? req.years_min,
    years_max: f.career_max ?? req.years_max,
    locations: f.region_sigungu.length ? f.region_sigungu : f.region_sido ? [f.region_sido] : req.locations,
  };
}

function caseFacets(title: string, req: CaseRequirements, p: CasePosting, deadline: string | null): PostingFacets {
  return computeFacets({ title, skills: req.items.map((i) => i.label), ...p, deadline_date: deadline });
}

const CASE_COLUMNS = "id, user_id, jd_hash, jd_text, status, title, client_name, owner_name, deadline, requirements, closed_at, plan_snapshot, created_at, updated_at";

interface CaseRow {
  id: string;
  user_id: string;
  jd_hash: string;
  jd_text: string;
  status: string;
  title: string | null;
  client_name: string | null;
  owner_name: string | null;
  deadline: string | null;
  requirements: CaseRequirements | null;
  closed_at: string | null;
  plan_snapshot: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

function toCase(row: CaseRow, counts?: CaseCounts) {
  return {
    id: row.id,
    jdHash: row.jd_hash,
    jdText: row.jd_text,
    status: row.closed_at ? "closed" : row.status,
    title: row.title || extractJdHeadline(row.jd_text) || "제목 없는 건",
    clientName: row.client_name,
    ownerName: row.owner_name,
    deadline: row.deadline,
    requirements: row.requirements,
    closedAt: row.closed_at,
    lastStart: (row.plan_snapshot?.scoutStart as Record<string, unknown> | undefined) ?? null,
    createdAt: row.created_at,
    counts: counts ?? emptyCounts(),
  };
}

function requireUser(req: Request, res: Response): string | null {
  const userId = req.auth ? resolveUserId(req) : undefined;
  if (!userId) {
    res.status(401).json({ error: "로그인이 필요합니다." });
    return null;
  }
  return userId;
}

async function loadOwnCase(req: Request, res: Response, userId: string): Promise<CaseRow | null> {
  const { data, error } = await db.from("jd_runs").select(CASE_COLUMNS).eq("id", req.params.id).maybeSingle();
  if (error || !data) {
    res.status(error ? 500 : 404).json({ error: error ? "건 조회 실패" : "스카우트 건이 없습니다." });
    return null;
  }
  if ((data as CaseRow).user_id !== userId) {
    res.status(403).json(FORBIDDEN);
    return null;
  }
  return data as CaseRow;
}

export interface CaseCounts { matched: number; analyzed: number; pending: number; approved: number; rejected: number; running: number; failed: number }
const emptyCounts = (): CaseCounts => ({ matched: 0, analyzed: 0, pending: 0, approved: 0, rejected: 0, running: 0, failed: 0 });

/** 거절해서 fit_reports 행을 지운 후보 (jd_runs.plan_snapshot.rejected). "더 찾기"가 다시 고르지 않게 한다 */
export function rejectedOf(row: { plan_snapshot?: Record<string, unknown> | null }): string[] {
  const list = row.plan_snapshot?.rejected;
  return Array.isArray(list) ? list.map((x) => (x as { candidateId?: unknown }).candidateId).filter((v): v is string => typeof v === "string") : [];
}

async function countsByHash(userId: string, hashes: string[]) {
  const out = new Map<string, CaseCounts>();
  if (hashes.length === 0) return out;
  const { data } = await db.from("fit_reports").select("jd_hash, candidate_id, status, report").eq("user_id", userId).in("jd_hash", hashes);
  for (const r of (data ?? []) as { jd_hash: string; status: string; report: unknown }[]) {
    const c = out.get(r.jd_hash) ?? emptyCounts();
    c.matched += 1;
    if (r.report) c.analyzed += 1;
    if ((r.status === "completed" || r.status === "pending_review") && r.report) c.pending += 1;
    if (r.status === "approved") c.approved += 1;
    if (r.status === "rejected") c.rejected += 1;
    if (r.status === "queued" || r.status === "processing") c.running += 1;
    if (r.status === "failed") c.failed += 1;
    out.set(r.jd_hash, c);
  }
  // 진행 중·다시 시도 대상은 DB 행이 없다 (Redis 표시) → 같은 집계에 더한다
  const marks = await loadMarksSafe(userId);
  const want = new Set(hashes);
  const seen = new Set(((data ?? []) as { jd_hash: string; candidate_id?: string }[]).map((r) => `${r.jd_hash}:${r.candidate_id}`));
  const bump = (list: { jdHash: string; candidateId: string }[], field: "running" | "failed") => {
    for (const m of list) {
      if (!want.has(m.jdHash) || seen.has(`${m.jdHash}:${m.candidateId}`)) continue;
      const c = out.get(m.jdHash) ?? emptyCounts();
      c.matched += 1;
      c[field] += 1;
      out.set(m.jdHash, c);
    }
  };
  bump(marks.inflight, "running");
  bump(marks.retryable, "failed");
  return out;
}

/**
 * 구직자 공고 목록 행(SQL 031 트리거가 만든 source='scout_case')에 조건·필터 값을 채운다.
 * 트리거는 기술·경력·마감만 옮기므로 나머지는 여기서. 실패해도 건 생성은 유지 (경고만).
 */
async function syncPostingConditions(caseId: string, p: CasePosting, snapshot: Record<string, unknown> | null): Promise<void> {
  const facets = (snapshot?.posting as { facets?: PostingFacets } | undefined)?.facets;
  if (!facets) return;
  const { deadline_type: _keep, ...rest } = facets; // 마감 유형은 트리거가 deadline 으로 정한다
  const { error } = await db
    .from("job_postings")
    .update({ ...rest, location: p.location_text, employment_type: p.employment_type_text, experience_level: p.career_text, salary: p.salary_text })
    .eq("source", "scout_case")
    .eq("external_id", caseId);
  if (error) console.warn("[scout] 공고 조건 동기화 실패", error.message);
}

export const START_DEFAULT = 10;
export const START_MAX = 20;

export function registerScoutCaseRoutes(app: Express): void {
  app.post("/api/scout-cases/draft", async (req, res) => {
    const userId = requireUser(req, res);
    if (!userId) return;
    const b = req.body as { jdText?: unknown; posting?: unknown; title?: unknown; deadline?: unknown };
    const body = text(b.jdText, 20000);
    if (!body || body.length < 20) {
      res.status(400).json({ error: "공고 내용을 20자 이상 붙여넣어 주세요." });
      return;
    }
    // 조건이 오면 크롤 공고와 같은 형식(본문 + [근무조건])으로 합쳐 같은 정규화(getJobRequirements)를 태운다
    const posting = b.posting ? sanitizePosting(b.posting) : null;
    const jdText = posting ? composeCaseJd(body, posting) : body;
    try {
      const { cached, ...norm } = await getJobRequirements(jdText);
      const title = text(b.title, 120) ?? extractJdHeadline(body) ?? null;
      let requirements = toCaseRequirements(norm);
      let facets: PostingFacets | null = null;
      if (posting) {
        facets = caseFacets(title ?? "", requirements, posting, date(b.deadline));
        requirements = applyPostingFacets(requirements, facets);
      }
      res.json({ title, requirements, facets, jdText, cached });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const quota = message.includes("RESOURCE_EXHAUSTED") || message.includes("429");
      res.status(quota ? 429 : 500).json({ error: quota ? "AI 사용 한도를 넘었습니다. 잠시 후 다시 시도하세요." : "요건 초안을 만들지 못했습니다." });
    }
  });

  app.post("/api/scout-cases", async (req, res) => {
    const userId = requireUser(req, res);
    if (!userId) return;
    const b = req.body as Record<string, unknown>;
    const posting = b.posting ? sanitizePosting(b.posting) : null;
    const body = text(b.jdText, 20000);
    const jdText = body && posting ? composeCaseJd(body, posting) : body;
    const { value: requirements, rejected } = sanitizeRequirements(b.requirements, null);
    if (!jdText || !requirements || requirements.items.length === 0) {
      res.status(400).json({ error: "공고 내용과 확인할 역량을 1개 이상 입력하세요." });
      return;
    }
    const hash = jdHash(jdText);
    const { data, error } = await db
      .from("jd_runs")
      .upsert(
        {
          user_id: userId,
          jd_hash: hash,
          jd_text: jdText,
          status: "draft",
          title: text(b.title, 120),
          client_name: text(b.clientName, 80),
          owner_name: text(b.ownerName, 40),
          deadline: date(b.deadline),
          requirements,
          closed_at: null,
          // original_text = 기업이 붙여넣은 원문 → 구직자 공고 화면 본문 (SQL 035). 매칭은 jd_text(표준 양식)
          ...(posting && { plan_snapshot: { posting: { ...posting, original_text: text(b.originalText, 20000), facets: caseFacets(text(b.title, 120) ?? "", requirements, posting, date(b.deadline)) } } }),
        },
        { onConflict: "user_id,jd_hash" },
      )
      .select(CASE_COLUMNS)
      .single();
    if (error) {
      console.error("[scout] 건 생성 실패", error.message);
      res.status(500).json({ error: "스카우트 건을 만들지 못했습니다." });
      return;
    }
    await recordStatusEvent({ entity: "jd_run", entityId: data.id, from: null, to: "draft", actor: userId });
    if (posting) await syncPostingConditions(data.id, posting, (data as CaseRow).plan_snapshot);
    res.status(201).json({ case: toCase(data as CaseRow), rejected });
  });

  app.get("/api/scout-cases", async (req, res) => {
    const userId = requireUser(req, res);
    if (!userId) return;
    const { data, error } = await db.from("jd_runs").select(CASE_COLUMNS).eq("user_id", userId).order("created_at", { ascending: false }).limit(100);
    if (error) {
      res.status(500).json({ error: "건 목록을 불러오지 못했습니다." });
      return;
    }
    const rows = (data ?? []) as CaseRow[];
    const counts = await countsByHash(userId, rows.map((r) => r.jd_hash));
    const cases = rows.map((r) => toCase(r, counts.get(r.jd_hash)));
    // 열린 건 먼저, 마감 가까운 순
    cases.sort((a, b) => Number(!!a.closedAt) - Number(!!b.closedAt) || (a.deadline ?? "9999").localeCompare(b.deadline ?? "9999"));
    res.json({ cases });
  });

  app.get("/api/scout-cases/:id", async (req, res) => {
    const userId = requireUser(req, res);
    if (!userId) return;
    const row = await loadOwnCase(req, res, userId);
    if (!row) return;
    const counts = await countsByHash(userId, [row.jd_hash]);
    res.json({ case: toCase(row, counts.get(row.jd_hash)) });
  });

  app.patch("/api/scout-cases/:id", async (req, res) => {
    const userId = requireUser(req, res);
    if (!userId) return;
    const row = await loadOwnCase(req, res, userId);
    if (!row) return;
    const b = req.body as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    if ("title" in b) patch.title = text(b.title, 120);
    if ("clientName" in b) patch.client_name = text(b.clientName, 80);
    if ("ownerName" in b) patch.owner_name = text(b.ownerName, 40);
    if ("deadline" in b) patch.deadline = date(b.deadline);
    let rejected: string[] = [];
    if ("requirements" in b) {
      const s = sanitizeRequirements(b.requirements, row.requirements);
      rejected = s.rejected;
      if (!s.value || s.value.items.length === 0) {
        res.status(400).json({ error: "확인할 역량을 1개 이상 남겨 두세요." });
        return;
      }
      patch.requirements = s.value;
    }
    const { data, error } = await db.from("jd_runs").update(patch).eq("id", row.id).select(CASE_COLUMNS).single();
    if (error) {
      res.status(500).json({ error: "건 수정 실패" });
      return;
    }
    res.json({ case: toCase(data as CaseRow), rejected });
  });

  // 후보 탐색 → 분석 큐 투입. 분석은 워커가 하고, 이 요청은 큐에 넣고 바로 끝난다 (헌법 2조)
  app.post("/api/scout-cases/:id/start", async (req, res) => {
    const userId = requireUser(req, res);
    if (!userId) return;
    const row = await loadOwnCase(req, res, userId);
    if (!row) return;
    if (row.closed_at) {
      res.status(400).json({ error: "종료된 건입니다." });
      return;
    }
    if (!row.requirements?.items?.length) {
      res.status(400).json({ error: "확인할 역량을 먼저 정하세요." });
      return;
    }
    const limitRaw = Number((req.body as { limit?: unknown }).limit);
    const limit = Number.isFinite(limitRaw) ? Math.min(START_MAX, Math.max(1, Math.floor(limitRaw))) : START_DEFAULT;
    try {
      const plan = await buildJdPlan(row.jd_text, undefined, undefined, toJobRequirements(row.requirements));
      const { data: existing } = await db.from("fit_reports").select("candidate_id, status").eq("user_id", userId).eq("jd_hash", row.jd_hash);
      const rows = (existing ?? []) as { candidate_id: string; status: string }[];
      const marks = await loadMarksSafe(userId);
      const running = new Set(marks.inflight.filter((m) => m.jdHash === row.jd_hash).map((m) => m.candidateId));
      // 일시 오류로 끝난 후보(다시 시도 표시)는 먼저 다시 분석한다. 결과 행이 있는 후보(다시 해도 같은 실패 포함)와 거절한 후보는 건너뛴다.
      const failed = new Set(marks.retryable.filter((m) => m.jdHash === row.jd_hash).map((m) => m.candidateId));
      const done = new Set([...rows.map((r) => r.candidate_id), ...running, ...rejectedOf(row)]);
      const fresh = plan.ranked.filter((c) => !done.has(c.candidateId));
      const picks = [...fresh.filter((c) => failed.has(c.candidateId)), ...fresh.filter((c) => !failed.has(c.candidateId))].slice(0, limit);

      // 큐 투입은 단일 입구를 거친다 (멱등 · 사용자 상한 · 과부하 시 즉시 거절). 캐시가 있으면 워커가 LLM 없이 결과를 채운다.
      const out = await enqueueFitBatch({ userId, tier: "paid", items: picks.map((c) => ({ jd: row.jd_text, jdHash: row.jd_hash, candidateId: c.candidateId })) });
      const queued = out.queued;
      const ahead = out.ahead;
      const cached = 0;
      const scoutStart = {
        at: new Date().toISOString(),
        searched: plan.totalInRole,
        filteredOut: plan.filteredOut,
        matched: plan.matchedCount,
        queued,
        alreadyAnalyzed: done.size,
        retried: picks.filter((c) => failed.has(c.candidateId)).length,
        ahead,
      };
      await db
        .from("jd_runs")
        .update({ status: "analyzed", plan_snapshot: { ...(row.plan_snapshot ?? {}), scoutStart } })
        .eq("id", row.id);
      await recordStatusEvent({ entity: "jd_run", entityId: row.id, from: row.status, to: "analyzed", actor: userId });
      res.status(202).json({ ...scoutStart, cached });
    } catch (err) {
      if (respondIfRejected(err, res)) return;
      console.error("[scout] 탐색 시작 실패", err);
      res.status(500).json({ error: "후보 탐색을 시작하지 못했습니다." });
    }
  });

  // 인재풀에서 직접 고른 후보를 건에 담는다 = 이 건 JD 로 분석 큐에 넣기. 분석이 끝나면 승인함 → 제안으로 이어진다
  app.post("/api/scout-cases/:id/candidates", async (req, res) => {
    const userId = requireUser(req, res);
    if (!userId) return;
    const row = await loadOwnCase(req, res, userId);
    if (!row) return;
    if (row.closed_at) {
      res.status(400).json({ error: "종료된 건입니다." });
      return;
    }
    const raw = (req.body as { candidateIds?: unknown }).candidateIds;
    const ids = [...new Set(Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v)) : [])];
    if (ids.length === 0 || ids.length > START_MAX) {
      res.status(400).json({ error: `후보를 1~${START_MAX}명 고르세요.` });
      return;
    }
    try {
      // 후보 풀(공개·구직자·제외 안 됨)에 있는 사람만
      const pool = new Set((await callMcpTool<{ id: string }[]>("search_candidates", {})).map((c) => c.id));
      const { data: existing } = await db.from("fit_reports").select("candidate_id, status").eq("user_id", userId).eq("jd_hash", row.jd_hash).in("candidate_id", ids);
      // 결과 행이 있는 후보는 다시 넣지 않는다. 진행 중인 후보는 입구에서 걸러진다.
      const done = new Set(((existing ?? []) as { candidate_id: string; status: string }[]).map((r) => r.candidate_id));
      const picked = ids.filter((id) => pool.has(id) && !done.has(id));
      const out = await enqueueFitBatch({ userId, tier: "paid", items: picked.map((candidateId) => ({ jd: row.jd_text, jdHash: row.jd_hash, candidateId })) });
      const queued = out.queued;
      if (queued > 0 && row.status === "draft") {
        await db.from("jd_runs").update({ status: "analyzed" }).eq("id", row.id);
        await recordStatusEvent({ entity: "jd_run", entityId: row.id, from: row.status, to: "analyzed", actor: userId });
      }
      res.status(202).json({ queued, alreadyInCase: done.size, notInPool: ids.filter((id) => !pool.has(id)).length });
    } catch (err) {
      if (respondIfRejected(err, res)) return;
      console.error("[scout] 후보 담기 실패", err);
      res.status(500).json({ error: "후보를 건에 담지 못했습니다." });
    }
  });

  // 분석하지 못한 후보를 이 건 목록에서 치운다 (결과 행·다시 시도 표시 모두). 다시 넣으려면 "더 찾기".
  app.post("/api/scout-cases/:id/clear-failed", async (req, res) => {
    const userId = requireUser(req, res);
    if (!userId) return;
    const row = await loadOwnCase(req, res, userId);
    if (!row) return;
    const marks = await loadMarksSafe(userId);
    const mine = marks.retryable.filter((m) => m.jdHash === row.jd_hash);
    await clearRetry(userId, mine.map((m) => member(m.jdHash, m.candidateId))).catch(() => undefined);
    const { data, error } = await db.from("fit_reports").delete().eq("user_id", userId).eq("jd_hash", row.jd_hash).eq("status", "failed").select("id");
    if (error) {
      res.status(500).json({ error: "목록을 정리하지 못했습니다." });
      return;
    }
    res.json({ cleared: mine.length + (data?.length ?? 0) });
  });

  // 순위 점수가 왜 나왔는지 (코드 사전필터 단계 결과, LLM 없음). 직접 담은 후보는 순위 계산 전이라 없을 수 있다
  app.get("/api/scout-cases/:id/scores", async (req, res) => {
    const userId = requireUser(req, res);
    if (!userId) return;
    const row = await loadOwnCase(req, res, userId);
    if (!row) return;
    const { data, error } = await db.from("match_scores").select("candidate_id, rank_score, score_breakdown, stage").eq("jd_hash", row.jd_hash).limit(500);
    if (error) {
      res.status(500).json({ error: "점수 근거를 불러오지 못했습니다." });
      return;
    }
    type Row = { candidate_id: string; rank_score: number; stage: string; score_breakdown: { items?: Record<string, number>; excluded?: string[]; mustUnmet?: boolean } | null };
    const scores = ((data ?? []) as Row[]).map((r) => ({
      candidateId: r.candidate_id,
      rankScore: Number(r.rank_score),
      stage: r.stage,
      items: r.score_breakdown?.items ?? {},
      excluded: r.score_breakdown?.excluded ?? [],
      mustUnmet: r.score_breakdown?.mustUnmet ?? false,
    }));
    res.json({ scores });
  });

  app.post("/api/scout-cases/:id/close", async (req, res) => {
    const userId = requireUser(req, res);
    if (!userId) return;
    const row = await loadOwnCase(req, res, userId);
    if (!row) return;
    const reopen = (req.body as { reopen?: unknown }).reopen === true;
    const { data, error } = await db.from("jd_runs").update({ closed_at: reopen ? null : new Date().toISOString() }).eq("id", row.id).select(CASE_COLUMNS).single();
    if (error) {
      res.status(500).json({ error: "건 상태 변경 실패" });
      return;
    }
    await recordStatusEvent({ entity: "jd_run", entityId: row.id, from: row.closed_at ? "closed" : row.status, to: reopen ? row.status : "closed", actor: userId });
    res.json({ case: toCase(data as CaseRow) });
  });
}

/**
 * 스카우트 건 (20 문서 C2) = jd_runs 확장(017). 별도 신규 시스템이 아니다 (CLAUDE.md 구현 순서).
 *  POST  /api/scout-cases/draft       JD → "확인할 역량" 초안 (정규화 1회, jd 해시 캐시)
 *  POST  /api/scout-cases             건 만들기 (제목·고객사·담당·마감·필수/우대 요건)
 *  GET   /api/scout-cases             내 건 목록 + 단계별 인원
 *  GET   /api/scout-cases/:id         건 상세
 *  PATCH /api/scout-cases/:id         정보·요건 수정
 *  POST  /api/scout-cases/:id/start   후보 탐색(코드 사전필터) → 상위 N명 분석을 큐에 넣는다 (응답은 즉시)
 *  POST  /api/scout-cases/:id/close   건 종료
 * 학력·나이는 요건으로 받지 않는다 (20 문서 §1 스킬 중심).
 */
import type { Express, Request, Response } from "express";
import { db } from "./db.js";
import { FORBIDDEN, resolveUserId } from "./auth.js";
import { getCachedReport, jdHash } from "./cache.js";
import { createFitReport } from "./fitReports.js";
import { buildJdPlan } from "./jdPlan.js";
import { getJobRequirements, type JobRequirements } from "./jobRequirements.js";
import { recordStatusEvent } from "./deskRoutes.js";
import { JOB_PRIORITY, buildJobId, getQueue, removeStaleFailedJob } from "../queue/queues.js";
import { extractJdHeadline } from "../../../shared/lib/shortlist.js";

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

function toCase(row: CaseRow, counts?: { matched: number; analyzed: number; pending: number; approved: number; rejected: number }) {
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
    counts: counts ?? { matched: 0, analyzed: 0, pending: 0, approved: 0, rejected: 0 },
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

async function countsByHash(userId: string, hashes: string[]) {
  const out = new Map<string, { matched: number; analyzed: number; pending: number; approved: number; rejected: number }>();
  if (hashes.length === 0) return out;
  const { data } = await db.from("fit_reports").select("jd_hash, status, report").eq("user_id", userId).in("jd_hash", hashes);
  for (const r of (data ?? []) as { jd_hash: string; status: string; report: unknown }[]) {
    const c = out.get(r.jd_hash) ?? { matched: 0, analyzed: 0, pending: 0, approved: 0, rejected: 0 };
    c.matched += 1;
    if (r.report) c.analyzed += 1;
    if ((r.status === "completed" || r.status === "pending_review") && r.report) c.pending += 1;
    if (r.status === "approved") c.approved += 1;
    if (r.status === "rejected") c.rejected += 1;
    out.set(r.jd_hash, c);
  }
  return out;
}

export const START_DEFAULT = 10;
export const START_MAX = 20;

export function registerScoutCaseRoutes(app: Express): void {
  app.post("/api/scout-cases/draft", async (req, res) => {
    const userId = requireUser(req, res);
    if (!userId) return;
    const jdText = text((req.body as { jdText?: unknown }).jdText, 20000);
    if (!jdText || jdText.length < 20) {
      res.status(400).json({ error: "공고 내용을 20자 이상 붙여넣어 주세요." });
      return;
    }
    try {
      const { cached, ...norm } = await getJobRequirements(jdText);
      res.json({ title: extractJdHeadline(jdText) ?? null, requirements: toCaseRequirements(norm), cached });
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
    const jdText = text(b.jdText, 20000);
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
      const { data: existing } = await db.from("fit_reports").select("candidate_id").eq("user_id", userId).eq("jd_hash", row.jd_hash);
      const done = new Set(((existing ?? []) as { candidate_id: string }[]).map((r) => r.candidate_id));
      const picks = plan.ranked.filter((c) => !done.has(c.candidateId)).slice(0, limit);

      const queue = getQueue("paid");
      let queued = 0;
      let cached = 0;
      for (const c of picks) {
        const jobId = buildJobId(row.jd_text, c.candidateId);
        await removeStaleFailedJob(queue, jobId);
        await createFitReport({ jobId, jd: row.jd_text, jdHash: row.jd_hash, candidateId: c.candidateId, userId });
        // 캐시가 있어도 큐를 거쳐 리포트를 채운다 (워커가 캐시를 먼저 확인)
        if (await getCachedReport(row.jd_text, c.candidateId)) cached += 1;
        await queue.add("analyze-fit", { jd: row.jd_text, candidateId: c.candidateId, userId, tier: "paid" }, { jobId, priority: JOB_PRIORITY.paid });
        queued += 1;
      }
      const scoutStart = {
        at: new Date().toISOString(),
        searched: plan.totalInRole,
        filteredOut: plan.filteredOut,
        matched: plan.matchedCount,
        queued,
        alreadyAnalyzed: done.size,
      };
      await db
        .from("jd_runs")
        .update({ status: "analyzed", plan_snapshot: { ...(row.plan_snapshot ?? {}), scoutStart } })
        .eq("id", row.id);
      await recordStatusEvent({ entity: "jd_run", entityId: row.id, from: row.status, to: "analyzed", actor: userId });
      res.status(202).json({ ...scoutStart, cached });
    } catch (err) {
      console.error("[scout] 탐색 시작 실패", err);
      res.status(500).json({ error: "후보 탐색을 시작하지 못했습니다." });
    }
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

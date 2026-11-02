/**
 * 데스크 홈 API (21 문서 D1~D4).
 *  GET  /api/desk/summary?range=7|30   지표 묶음 (코드 집계, LLM 없음)
 *  GET  /api/desk/feed                 소식
 *  POST /api/desk/views                브리프·근거 카드 열람 기록 (017 profile_views)
 *  POST /api/desk/offers               승인된 후보에게 보낼 제안 생성 → 승인 대기 (HIL)
 *  POST /api/desk/offers/:id/decision  제안 승인(발송 기록)/반려
 *  POST /api/desk/offers/:id/response  후보 응답·면접 기록
 * 017 컬럼·테이블이 없으면 읽기는 null(준비 중), 쓰기는 409 migration_required.
 */
import type { Express, Request, Response } from "express";
import { db } from "./db.js";
import { FORBIDDEN, resolveUserId } from "./auth.js";
import { chunk } from "./deskMetrics.js";
import { getFitReportById, listFitReports } from "./fitReports.js";
import { listCandidates } from "./talentfolio.js";
import {
  buildDeskFeed,
  classifyPosting,
  computeDeskSummary,
  computeSkillGap,
  reasonCode,
  type DeskInput,
  type DeskJdRunRow,
  type DeskOfferRow,
} from "./deskMetrics.js";
import type { FitReportRecord } from "../../../shared/types.js";

const MISSING = new Set(["42P01", "42703", "PGRST204", "PGRST205"]);
const isMissing = (err: { code?: string } | null) => Boolean(err && err.code && MISSING.has(err.code));
const MIGRATION_REQUIRED = { error: "SQL 017 적용 후 사용할 수 있습니다.", code: "migration_required" } as const;

/** 상태 이력 기록 — 017 전에는 조용히 건너뛴다 (본 동작을 막지 않음) */
export async function recordStatusEvent(ev: {
  entity: "fit_report" | "sourcing_action" | "jd_run";
  entityId: string;
  from: string | null;
  to: string;
  actor: string | null;
  reason?: string | null;
}): Promise<void> {
  const { error } = await db.from("status_events").insert({
    entity: ev.entity,
    entity_id: ev.entityId,
    from_status: ev.from,
    to_status: ev.to,
    actor: ev.actor,
    reason_code: ev.to === "rejected" ? reasonCode(ev.reason) : null,
  });
  if (error && !isMissing(error)) console.warn(`[desk] status_events 기록 실패: ${error.message}`);
}

async function loadJdRuns(userId: string): Promise<{ rows: DeskJdRunRow[]; extended: boolean }> {
  const ext = await db.from("jd_runs").select("id, jd_hash, jd_text, created_at, title, client_name, owner_name, deadline, closed_at").eq("user_id", userId);
  if (!ext.error) return { rows: (ext.data ?? []) as DeskJdRunRow[], extended: true };
  if (!isMissing(ext.error)) throw new Error(`jd_runs 조회 실패: ${ext.error.message}`);
  const base = await db.from("jd_runs").select("id, jd_hash, jd_text, created_at").eq("user_id", userId);
  if (base.error) throw new Error(`jd_runs 조회 실패: ${base.error.message}`);
  return { rows: (base.data ?? []) as DeskJdRunRow[], extended: false };
}

async function loadOffers(userId: string): Promise<DeskOfferRow[] | null> {
  const { data, error } = await db
    .from("sourcing_actions")
    .select("id, candidate_id, jd_run_id, status, sent_at, response, responded_at, interview_at, created_at, payload")
    .eq("type", "candidate_offer")
    .eq("user_id", userId);
  if (error) {
    if (isMissing(error)) return null;
    throw new Error(`제안 조회 실패: ${error.message}`);
  }
  return (data ?? []) as DeskOfferRow[];
}

// missing 이 아닌 에러는 "0건"으로 숨기지 않고 null(준비 중) + 경고
function softFail(what: string, error: { code?: string; message: string }): null {
  if (!isMissing(error)) console.warn(`[desk] ${what} 조회 실패: ${error.message}`);
  return null;
}

async function loadViews(reportIds: string[]): Promise<DeskInput["views"]> {
  const probe = await db.from("profile_views").select("id").limit(1);
  if (probe.error) return softFail("profile_views", probe.error);
  const rows: { fit_report_id: string; card_id: string | null; viewed_at: string }[] = [];
  for (const ids of chunk(reportIds, 200)) {
    const { data, error } = await db.from("profile_views").select("fit_report_id, card_id, viewed_at").in("fit_report_id", ids);
    if (error) return softFail("profile_views", error);
    rows.push(...((data ?? []) as typeof rows));
  }
  const map = new Map<string, { at: string; cardOpened: boolean }[]>();
  for (const v of rows) {
    const k = v.fit_report_id as string;
    map.set(k, [...(map.get(k) ?? []), { at: v.viewed_at as string, cardOpened: Boolean(v.card_id) }]);
  }
  return map;
}

async function loadExplanations(reportIds: string[]): Promise<string[] | null> {
  const probe = await db.from("explanation_requests").select("id").limit(1);
  if (probe.error) return softFail("explanation_requests", probe.error);
  const due: string[] = [];
  for (const ids of chunk(reportIds, 200)) {
    const { data, error } = await db.from("explanation_requests").select("requested_at").is("answered_at", null).in("fit_report_id", ids);
    if (error) return softFail("explanation_requests", error);
    // 법정 기한: 요청 + 30일 (개인정보보호법 37조의2)
    due.push(...(data ?? []).map((r) => new Date(Date.parse(r.requested_at as string) + 30 * 86_400_000).toISOString()));
  }
  return due;
}

function citedIds(r: FitReportRecord): string[] {
  const rep = r.report;
  if (!rep) return [];
  return [rep.techStack, rep.experience, rep.cultureFit].flatMap((a) => a?.citedCardIds ?? []);
}

// 시장 지표는 사용자와 무관 → 프로세스 메모리 10분 캐시 (요청마다 공고·카드 전체 조회 방지)
const MARKET_TTL = 10 * 60_000;
let marketCache: { at: number; value: Pick<DeskInput, "supply" | "demand" | "skillGap"> } | null = null;

async function loadMarket(): Promise<Pick<DeskInput, "supply" | "demand" | "skillGap">> {
  if (marketCache && Date.now() - marketCache.at < MARKET_TTL) return marketCache.value;
  const [cands, postings, claims] = await Promise.all([
    listCandidates().catch(() => []),
    db.from("job_postings").select("title, skills").limit(2000),
    db.from("public_evidence_cards").select("claim").limit(2000),
  ]);
  const supply = { developer: 0, designer: 0 };
  for (const c of cands) if (c.role === "developer" || c.role === "designer") supply[c.role] += 1;
  const demand = { developer: 0, designer: 0 };
  const postRows = (postings.data ?? []) as { title: string; skills: string[] | null }[];
  for (const p of postRows) demand[classifyPosting(p.title ?? "", p.skills ?? [])] += 1;
  const cardRows = (claims.data ?? []) as { claim: string }[];
  const skillGap = computeSkillGap(postRows.map((p) => ({ skills: p.skills ?? [] })), cardRows.map((c) => c.claim));
  const value = { supply, demand, skillGap };
  marketCache = { at: Date.now(), value };
  return value;
}

// 승인 후보가 인용한 카드 중 지금 공개 뷰에 없는 것 = 공개 철회 (인용 id 만 조회 — 목록 잘림 오판 방지)
async function loadWithdrawn(approved: FitReportRecord[]): Promise<DeskInput["withdrawn"]> {
  const all = [...new Set(approved.flatMap(citedIds))];
  if (all.length === 0) return [];
  const present = new Set<string>();
  for (const ids of chunk(all, 200)) {
    const { data, error } = await db.from("public_evidence_cards").select("id").in("id", ids);
    if (error) {
      console.warn(`[desk] 철회 판정 생략: ${error.message}`);
      return [];
    }
    for (const row of data ?? []) present.add(row.id as string);
  }
  return approved.flatMap((r) => {
    const gone = new Set(citedIds(r).filter((id) => !present.has(id)));
    return gone.size ? [{ candidateName: r.report?.candidateName ?? "후보", jdHash: r.jdHash, count: gone.size }] : [];
  });
}

async function buildInput(userId: string, rangeDays: number): Promise<DeskInput> {
  const reports = await listFitReports({ userId });
  const since = Date.now() - 2 * rangeDays * 86_400_000;
  const approved = reports.filter((r) => r.status === "approved");
  // 열람 로그는 기간(+직전 기간) 안에 결정된 리포트만
  const decidedIds = reports.filter((r) => r.report?.review && Date.parse(r.report.review.decidedAt) >= since).map((r) => r.id);
  const [jd, offers, views, explanationDue, market, withdrawn] = await Promise.all([
    loadJdRuns(userId),
    loadOffers(userId),
    loadViews(decidedIds),
    loadExplanations(reports.map((r) => r.id)),
    loadMarket(),
    loadWithdrawn(approved),
  ]);
  return { now: new Date(), rangeDays, reports, jdRuns: jd.rows, jdRunsExtended: jd.extended, offers, views, explanationDue, withdrawn, ...market };
}

// 데스크는 legacy(query userId) 폴백을 허용하지 않는다 — 타인 지표 조회·쓰기 행세 차단
function requireUser(req: Request, res: Response): string | null {
  const userId = req.auth ? resolveUserId(req) : undefined;
  if (!userId) {
    res.status(401).json({ error: "로그인이 필요합니다." });
    return null;
  }
  return userId;
}

export function registerDeskRoutes(app: Express): void {
  app.get("/api/desk/summary", async (req, res) => {
    const userId = requireUser(req, res);
    if (!userId) return;
    const rangeDays = req.query.range === "30" ? 30 : 7;
    try {
      // 홈 한 번에 한 번만 읽도록 소식도 함께 돌려준다
      const input = await buildInput(userId, rangeDays);
      res.json({ ...computeDeskSummary(input), feed: buildDeskFeed(input) });
    } catch (err) {
      console.error("[desk] summary 실패", err);
      res.status(500).json({ error: "데스크 지표를 불러오지 못했습니다." });
    }
  });

  app.get("/api/desk/feed", async (req, res) => {
    const userId = requireUser(req, res);
    if (!userId) return;
    try {
      res.json({ items: buildDeskFeed(await buildInput(userId, 7)) });
    } catch (err) {
      console.error("[desk] feed 실패", err);
      res.status(500).json({ error: "소식을 불러오지 못했습니다." });
    }
  });

  app.post("/api/desk/views", async (req, res) => {
    const userId = requireUser(req, res);
    if (!userId) return;
    const { fitReportId, cardId } = req.body as { fitReportId?: string; cardId?: string };
    if (!fitReportId) {
      res.status(400).json({ error: "fitReportId 는 필수입니다." });
      return;
    }
    const report = await getFitReportById(fitReportId);
    if (!report) {
      res.status(404).json({ error: "리포트가 없습니다." });
      return;
    }
    if (report.userId !== userId) {
      res.status(403).json(FORBIDDEN);
      return;
    }
    const { error } = await db.from("profile_views").insert({
      viewer_id: userId,
      candidate_id: report.candidateId,
      fit_report_id: fitReportId,
      card_id: cardId ?? null,
    });
    if (error && isMissing(error)) {
      res.status(202).json({ recorded: false, code: "migration_required" });
      return;
    }
    if (error) {
      res.status(500).json({ error: "열람 기록 실패" });
      return;
    }
    res.status(201).json({ recorded: true });
  });

  app.get("/api/desk/offers", async (req, res) => {
    const userId = requireUser(req, res);
    if (!userId) return;
    try {
      const offers = await loadOffers(userId);
      if (offers === null) {
        res.json({ offers: null, code: "migration_required" });
        return;
      }
      res.json({ offers: offers.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)).slice(0, 50) });
    } catch (err) {
      console.error("[desk] offers 실패", err);
      res.status(500).json({ error: "제안 목록을 불러오지 못했습니다." });
    }
  });

  // 제안 생성: 승인된 후보만. 발송은 별도 승인(HIL) 후에만.
  app.post("/api/desk/offers", async (req, res) => {
    const userId = requireUser(req, res);
    if (!userId) return;
    const { fitReportId, message } = req.body as { fitReportId?: string; message?: string };
    const report = fitReportId ? await getFitReportById(fitReportId) : null;
    if (!report) {
      res.status(404).json({ error: "리포트가 없습니다." });
      return;
    }
    if (report.userId !== userId) {
      res.status(403).json(FORBIDDEN);
      return;
    }
    if (report.status !== "approved") {
      res.status(400).json({ error: "승인한 후보에게만 제안할 수 있습니다." });
      return;
    }
    const run = await db.from("jd_runs").select("id").eq("user_id", userId).eq("jd_hash", report.jdHash).order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (run.error) console.warn(`[desk] 제안의 jd_run 연결 실패: ${run.error.message}`);
    const { data, error } = await db
      .from("sourcing_actions")
      .insert({
        type: "candidate_offer",
        status: "pending",
        user_id: userId,
        candidate_id: report.candidateId,
        jd_run_id: run.data?.id ?? null,
        payload: {
          candidateName: report.report?.candidateName ?? report.candidateName,
          jdHash: report.jdHash,
          fitReportId: report.id,
          message: typeof message === "string" ? message.slice(0, 2000) : "",
          // 후보에게는 인용된 공개 카드 id 만 공유 (20 문서 §1 설명 책임)
          sharedCardIds: [...new Set(citedIds(report))],
        },
      })
      .select("id")
      .single();
    if (error) {
      res.status(isMissing(error) ? 409 : 500).json(isMissing(error) ? MIGRATION_REQUIRED : { error: "제안 생성 실패" });
      return;
    }
    await recordStatusEvent({ entity: "sourcing_action", entityId: data.id, from: null, to: "pending", actor: userId });
    res.status(201).json({ id: data.id, status: "pending" });
  });

  const loadOffer = async (req: Request, res: Response, userId: string) => {
    const { data, error } = await db.from("sourcing_actions").select("id, user_id, status, type").eq("id", req.params.id).maybeSingle();
    if (error || !data || data.type !== "candidate_offer") {
      res.status(404).json({ error: "제안이 없습니다." });
      return null;
    }
    if (data.user_id !== userId) {
      res.status(403).json(FORBIDDEN);
      return null;
    }
    return data as { id: string; status: string };
  };

  app.post("/api/desk/offers/:id/decision", async (req, res) => {
    const userId = requireUser(req, res);
    if (!userId) return;
    const offer = await loadOffer(req, res, userId);
    if (!offer) return;
    const { action } = req.body as { action?: string };
    if (offer.status !== "pending" || (action !== "approve" && action !== "reject")) {
      res.status(400).json({ error: "대기 중인 제안에 approve/reject 만 가능합니다." });
      return;
    }
    // 실제 전달 채널(앱 알림·메일)은 C4. 지금은 승인 = 플랫폼 내 발송 기록.
    const patch = action === "approve" ? { status: "executed", sent_at: new Date().toISOString() } : { status: "rejected" };
    // 상태 조건부 갱신 — 동시 승인 시 한 번만 반영 (HIL 게이트 원자성)
    const { data: changed, error } = await db.from("sourcing_actions").update(patch).eq("id", offer.id).eq("status", "pending").select("id");
    if (error) {
      res.status(500).json({ error: "제안 처리 실패" });
      return;
    }
    if (!changed?.length) {
      res.status(409).json({ error: "이미 처리된 제안입니다." });
      return;
    }
    await recordStatusEvent({ entity: "sourcing_action", entityId: offer.id, from: "pending", to: patch.status, actor: userId });
    res.json({ status: patch.status });
  });

  app.post("/api/desk/offers/:id/response", async (req, res) => {
    const userId = requireUser(req, res);
    if (!userId) return;
    const offer = await loadOffer(req, res, userId);
    if (!offer) return;
    const { response, interview } = req.body as { response?: string; interview?: boolean };
    if (offer.status !== "executed" || !["interested", "declined", "no_response"].includes(response ?? "")) {
      res.status(400).json({ error: "발송된 제안에 interested/declined/no_response 만 기록할 수 있습니다." });
      return;
    }
    const now = new Date().toISOString();
    const { data: changed, error } = await db
      .from("sourcing_actions")
      .update({ response, responded_at: now, ...(interview && response === "interested" ? { interview_at: now } : {}) })
      .eq("id", offer.id)
      .eq("status", "executed")
      .is("response", null)
      .select("id");
    if (error) {
      res.status(500).json({ error: "응답 기록 실패" });
      return;
    }
    if (!changed?.length) {
      res.status(409).json({ error: "이미 응답이 기록된 제안입니다." });
      return;
    }
    await recordStatusEvent({ entity: "sourcing_action", entityId: offer.id, from: "executed", to: `response:${response}`, actor: userId });
    res.json({ response });
  });
}

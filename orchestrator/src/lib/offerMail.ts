/**
 * 제안 서신 (SQL 036). 제안(sourcing_actions type='candidate_offer') 한 건이 서신 한 묶음이다.
 *
 * 루프에서의 자리: 헤드헌터 승인(HIL) → 제안 발송 다음 단계. 기업과 후보가 격식 있는 메일 형식으로 주고받고,
 * 면접 일정 제안·수락까지 같은 서신 안에서 끝낸다. 실시간 채팅은 두지 않는다 (사용자 결정 2026-11-10).
 *
 * 기업  GET  /api/desk/offers/:id            서신 상세 (본문·주고받은 메일·진행 이력·공고)
 *       POST /api/desk/offers/:id/messages   후속 메일 (면접 일정 후보 포함 가능)
 *       POST /api/desk/offers/:id/withdraw   발송한 제안 철회
 * 후보  GET  /api/v1/life/offers             받은 제안함
 *       GET  /api/v1/life/offers/:id         제안 열람 (첫 열람 시각 기록)
 *       POST /api/v1/life/offers/:id/reply   회신 (관심/거절 · 면접 시각 선택)
 *
 * 첫 메일은 따로 저장하지 않는다. 발송 승인된 제안 본문(payload.message)이 곧 첫 메일이다.
 */
import type { Express, Request, Response } from "express";
import { db } from "./db.js";
import { FORBIDDEN, resolveUserId } from "./auth.js";
import { recordStatusEvent } from "./deskRoutes.js";

const MISSING = new Set(["42P01", "42703", "PGRST204", "PGRST205"]);
const isMissing = (err: { code?: string } | null) => Boolean(err && err.code && MISSING.has(err.code));
const UNAVAILABLE = { error: "지금은 메일을 보낼 수 없습니다. 잠시 후 다시 시도해 주세요." } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SUBJECT_MAX = 120;
const BODY_MAX = 4000;
const SLOTS_MAX = 3;

export interface OfferRow {
  id: string;
  user_id: string;
  candidate_id: string | null;
  jd_run_id: string | null;
  status: string;
  sent_at: string | null;
  response: string | null;
  responded_at: string | null;
  interview_at: string | null;
  created_at: string;
  viewed_at?: string | null;
  withdrawn_at?: string | null;
  payload: { candidateName?: string; jdHash?: string; fitReportId?: string; message?: string; sharedCardIds?: string[] } | null;
}

interface MessageRow {
  id: string;
  offer_id: string;
  sender_role: "company" | "candidate";
  subject: string;
  body: string;
  interview_slots: string[] | null;
  picked_slot: string | null;
  read_at: string | null;
  created_at: string;
}

export interface OfferMail {
  id: string;
  from: "company" | "candidate";
  subject: string;
  body: string;
  interviewSlots: string[];
  pickedSlot: string | null;
  readAt: string | null;
  sentAt: string;
}

const BASE_COLS = "id, user_id, candidate_id, jd_run_id, status, sent_at, response, responded_at, interview_at, created_at, payload";
const FULL_COLS = `${BASE_COLS}, viewed_at, withdrawn_at`;

/** 열람·철회 컬럼(036)이 아직 없으면 기본 컬럼만 읽는다 */
async function selectOffers(build: (cols: string) => PromiseLike<{ data: unknown; error: { code?: string; message: string } | null }>): Promise<OfferRow[]> {
  let r = await build(FULL_COLS);
  if (r.error && isMissing(r.error)) r = await build(BASE_COLS);
  if (r.error) throw new Error(`제안 조회 실패: ${r.error.message}`);
  return (Array.isArray(r.data) ? r.data : r.data ? [r.data] : []) as OfferRow[];
}

async function loadMessages(offerIds: string[]): Promise<MessageRow[]> {
  if (offerIds.length === 0) return [];
  const { data, error } = await db
    .from("offer_messages")
    .select("id, offer_id, sender_role, subject, body, interview_slots, picked_slot, read_at, created_at")
    .in("offer_id", offerIds)
    .order("created_at", { ascending: true });
  if (error) {
    if (isMissing(error)) return [];
    throw new Error(`서신 조회 실패: ${error.message}`);
  }
  return (data ?? []) as MessageRow[];
}

interface CaseInfo { id: string; title: string | null; client_name: string | null; jd_text: string | null }
async function loadCases(runIds: string[]): Promise<Map<string, CaseInfo>> {
  const out = new Map<string, CaseInfo>();
  const ids = [...new Set(runIds.filter(Boolean))];
  if (ids.length === 0) return out;
  const { data } = await db.from("jd_runs").select("id, title, client_name, jd_text").in("id", ids);
  for (const r of (data ?? []) as CaseInfo[]) out.set(r.id, r);
  return out;
}

/** 후보에게 보이는 공고 (스카우트 건이 만든 공개 공고 행). 없으면 건 제목만 */
async function loadPosting(run: CaseInfo | undefined): Promise<{ id: string | null; title: string; company: string; description: string | null; skills: string[] } | null> {
  if (!run) return null;
  const { data } = await db.from("job_postings").select("id, title, company, description, skills").eq("source", "scout_case").eq("external_id", run.id).maybeSingle();
  const p = data as { id: string; title: string; company: string; description: string | null; skills: string[] | null } | null;
  if (p) return { id: p.id, title: p.title, company: p.company, description: p.description, skills: p.skills ?? [] };
  // 공개 공고 행이 없으면 건의 공고 본문(공개 공고에 실리는 것과 같은 글)을 그대로 보여 준다
  return { id: null, title: run.title ?? "채용 제안", company: run.client_name ?? "비공개 기업", description: run.jd_text, skills: [] };
}

const caseTitle = (run: CaseInfo | undefined) => run?.title?.trim() || "채용 제안";
const firstSubject = (run: CaseInfo | undefined) => `[제안] ${caseTitle(run)}`;

function toMail(m: MessageRow): OfferMail {
  return { id: m.id, from: m.sender_role, subject: m.subject, body: m.body, interviewSlots: m.interview_slots ?? [], pickedSlot: m.picked_slot, readAt: m.read_at, sentAt: m.created_at };
}

/** 첫 메일(제안 본문) + 주고받은 후속 메일 */
function thread(offer: OfferRow, run: CaseInfo | undefined, rows: MessageRow[]): OfferMail[] {
  const first: OfferMail = {
    id: `${offer.id}:first`,
    from: "company",
    subject: firstSubject(run),
    body: offer.payload?.message?.trim() ?? "",
    interviewSlots: [],
    pickedSlot: null,
    readAt: offer.viewed_at ?? null,
    sentAt: offer.sent_at ?? offer.created_at,
  };
  return [first, ...rows.map(toMail)];
}

/** 화면용 진행 단계. 색·라벨은 화면이 정한다 */
export type OfferStage = "draft" | "sent" | "viewed" | "interested" | "interview" | "declined" | "no_response" | "withdrawn" | "discarded";
export function stageOf(o: OfferRow): OfferStage {
  if (o.status === "pending") return "draft";
  if (o.status !== "executed") return "discarded";
  if (o.withdrawn_at) return "withdrawn";
  if (o.interview_at) return "interview";
  if (o.response === "interested") return "interested";
  if (o.response === "declined") return "declined";
  if (o.response === "no_response") return "no_response";
  return o.viewed_at ? "viewed" : "sent";
}

function cleanText(v: unknown, max: number): string {
  return typeof v === "string" ? v.replace(/\r\n/g, "\n").trim().slice(0, max) : "";
}

/** 면접 후보 시각: 지금 이후의 ISO 시각 최대 3개 */
export function cleanSlots(v: unknown, now = Date.now()): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) {
    const t = typeof x === "string" ? Date.parse(x) : NaN;
    if (Number.isFinite(t) && t > now) out.push(new Date(t).toISOString());
  }
  return [...new Set(out)].sort().slice(0, SLOTS_MAX);
}

export function registerOfferMailRoutes(app: Express): void {
  const user = (req: Request, res: Response): string | null => {
    const id = resolveUserId(req);
    if (!id) res.status(401).json({ error: "로그인이 필요합니다." });
    return id ?? null;
  };
  const offerId = (req: Request, res: Response): string | null => {
    const id = String(req.params.id ?? "");
    if (UUID.test(id)) return id;
    res.status(404).json({ error: "제안을 찾을 수 없습니다." });
    return null;
  };
  const fail = (res: Response, where: string, err: unknown) => {
    console.error(`[offer-mail] ${where} 실패`, err);
    res.status(500).json({ error: "오류가 발생했습니다. 다시 시도해 주세요." });
  };

  // ── 기업 ────────────────────────────────────────────────────────────────
  const loadCompanyOffer = async (req: Request, res: Response, userId: string): Promise<OfferRow | null> => {
    const id = offerId(req, res);
    if (!id) return null;
    const [offer] = await selectOffers((cols) => db.from("sourcing_actions").select(cols).eq("id", id).eq("type", "candidate_offer").limit(1));
    if (!offer) {
      res.status(404).json({ error: "제안을 찾을 수 없습니다." });
      return null;
    }
    if (offer.user_id !== userId) {
      res.status(403).json(FORBIDDEN);
      return null;
    }
    return offer;
  };

  // 제안 목록 (관리 화면). 서신 요약(마지막 메일 시각·안 읽은 회신 수)과 건 제목을 같이 준다
  app.get("/api/desk/offers/overview", async (req, res) => {
    const userId = user(req, res);
    if (!userId) return;
    try {
      const offers = await selectOffers((cols) =>
        db.from("sourcing_actions").select(cols).eq("type", "candidate_offer").eq("user_id", userId).order("created_at", { ascending: false }).limit(300)
      );
      const [cases, messages] = await Promise.all([loadCases(offers.map((o) => o.jd_run_id ?? "")), loadMessages(offers.map((o) => o.id))]);
      const byOffer = new Map<string, MessageRow[]>();
      for (const m of messages) byOffer.set(m.offer_id, [...(byOffer.get(m.offer_id) ?? []), m]);
      res.json({
        offers: offers.map((o) => {
          const run = o.jd_run_id ? cases.get(o.jd_run_id) : undefined;
          const ms = byOffer.get(o.id) ?? [];
          const last = ms[ms.length - 1];
          return {
            id: o.id,
            stage: stageOf(o),
            candidateId: o.candidate_id,
            candidateName: o.payload?.candidateName ?? null,
            caseId: o.jd_run_id,
            caseTitle: caseTitle(run),
            client: run?.client_name ?? null,
            preview: (last?.body ?? o.payload?.message ?? "").slice(0, 140),
            createdAt: o.created_at,
            sentAt: o.sent_at,
            viewedAt: o.viewed_at ?? null,
            respondedAt: o.responded_at,
            interviewAt: o.interview_at,
            lastAt: last?.created_at ?? o.responded_at ?? o.sent_at ?? o.created_at,
            mails: ms.length + 1,
            unread: ms.filter((m) => m.sender_role === "candidate" && !m.read_at).length,
          };
        }),
      });
    } catch (err) {
      fail(res, "overview", err);
    }
  });

  app.get("/api/desk/offers/:id", async (req, res) => {
    const userId = user(req, res);
    if (!userId) return;
    try {
      const offer = await loadCompanyOffer(req, res, userId);
      if (!offer) return;
      const [cases, rows, events] = await Promise.all([
        loadCases([offer.jd_run_id ?? ""]),
        loadMessages([offer.id]),
        db.from("status_events").select("to_status, at").eq("entity", "sourcing_action").eq("entity_id", offer.id).order("at", { ascending: true }).limit(50),
      ]);
      const run = offer.jd_run_id ? cases.get(offer.jd_run_id) : undefined;
      // 후보 회신을 읽음으로 표시 (실패해도 열람은 계속)
      const unreadIds = rows.filter((m) => m.sender_role === "candidate" && !m.read_at).map((m) => m.id);
      if (unreadIds.length) await db.from("offer_messages").update({ read_at: new Date().toISOString() }).in("id", unreadIds);
      res.json({
        offer: {
          id: offer.id,
          stage: stageOf(offer),
          candidateId: offer.candidate_id,
          candidateName: offer.payload?.candidateName ?? null,
          fitReportId: offer.payload?.fitReportId ?? null,
          sharedCards: offer.payload?.sharedCardIds?.length ?? 0,
          caseId: offer.jd_run_id,
          caseTitle: caseTitle(run),
          client: run?.client_name ?? null,
          createdAt: offer.created_at,
          sentAt: offer.sent_at,
          viewedAt: offer.viewed_at ?? null,
          respondedAt: offer.responded_at,
          interviewAt: offer.interview_at,
        },
        mails: thread(offer, run, rows),
        events: ((events.data ?? []) as { to_status: string; at: string }[]).map((e) => ({ to: e.to_status, at: e.at })),
      });
    } catch (err) {
      fail(res, "detail", err);
    }
  });

  app.post("/api/desk/offers/:id/messages", async (req, res) => {
    const userId = user(req, res);
    if (!userId) return;
    try {
      const offer = await loadCompanyOffer(req, res, userId);
      if (!offer) return;
      const stage = stageOf(offer);
      if (offer.status !== "executed" || stage === "withdrawn" || stage === "declined") {
        res.status(400).json({ error: "이 제안에는 메일을 보낼 수 없습니다." });
        return;
      }
      const b = req.body as { subject?: unknown; body?: unknown; interviewSlots?: unknown };
      const subject = cleanText(b.subject, SUBJECT_MAX);
      const body = cleanText(b.body, BODY_MAX);
      if (!subject || !body) {
        res.status(400).json({ error: "제목과 본문을 입력하세요." });
        return;
      }
      const slots = cleanSlots(b.interviewSlots);
      const { data, error } = await db
        .from("offer_messages")
        .insert({ offer_id: offer.id, sender_role: "company", sender_id: userId, subject, body, interview_slots: slots.length ? slots : null })
        .select("id, offer_id, sender_role, subject, body, interview_slots, picked_slot, read_at, created_at")
        .single();
      if (error) {
        if (isMissing(error)) res.status(503).json(UNAVAILABLE);
        else fail(res, "send", error);
        return;
      }
      await recordStatusEvent({ entity: "sourcing_action", entityId: offer.id, from: null, to: slots.length ? "mail:interview_proposed" : "mail:company", actor: userId });
      res.status(201).json({ mail: toMail(data as MessageRow) });
    } catch (err) {
      fail(res, "send", err);
    }
  });

  app.post("/api/desk/offers/:id/withdraw", async (req, res) => {
    const userId = user(req, res);
    if (!userId) return;
    try {
      const offer = await loadCompanyOffer(req, res, userId);
      if (!offer) return;
      if (offer.status !== "executed" || offer.withdrawn_at) {
        res.status(400).json({ error: "발송한 제안만 철회할 수 있습니다." });
        return;
      }
      const { error } = await db.from("sourcing_actions").update({ withdrawn_at: new Date().toISOString() }).eq("id", offer.id).eq("status", "executed");
      if (error) {
        if (isMissing(error)) res.status(503).json({ error: "지금은 철회할 수 없습니다. 잠시 후 다시 시도해 주세요." });
        else fail(res, "withdraw", error);
        return;
      }
      await recordStatusEvent({ entity: "sourcing_action", entityId: offer.id, from: "executed", to: "withdrawn", actor: userId });
      res.json({ stage: "withdrawn" });
    } catch (err) {
      fail(res, "withdraw", err);
    }
  });

  // ── 후보 ────────────────────────────────────────────────────────────────
  // 후보에게는 발송된(executed) 제안만 보인다. 철회된 제안·초안·반려는 보이지 않는다.
  const visibleToCandidate = (o: OfferRow) => o.status === "executed" && !o.withdrawn_at;

  const loadCandidateOffer = async (req: Request, res: Response, userId: string): Promise<OfferRow | null> => {
    const id = offerId(req, res);
    if (!id) return null;
    const [offer] = await selectOffers((cols) => db.from("sourcing_actions").select(cols).eq("id", id).eq("type", "candidate_offer").eq("candidate_id", userId).limit(1));
    if (!offer || !visibleToCandidate(offer)) {
      res.status(404).json({ error: "제안을 찾을 수 없습니다." });
      return null;
    }
    return offer;
  };

  app.get("/api/v1/life/offers", async (req, res) => {
    const userId = user(req, res);
    if (!userId) return;
    try {
      const all = await selectOffers((cols) =>
        db.from("sourcing_actions").select(cols).eq("type", "candidate_offer").eq("candidate_id", userId).eq("status", "executed").order("sent_at", { ascending: false }).limit(100)
      );
      const offers = all.filter(visibleToCandidate);
      const [cases, messages] = await Promise.all([loadCases(offers.map((o) => o.jd_run_id ?? "")), loadMessages(offers.map((o) => o.id))]);
      res.json({
        offers: offers.map((o) => {
          const run = o.jd_run_id ? cases.get(o.jd_run_id) : undefined;
          const ms = messages.filter((m) => m.offer_id === o.id);
          const last = ms[ms.length - 1];
          return {
            id: o.id,
            stage: stageOf(o),
            company: run?.client_name?.trim() || "비공개 기업",
            title: caseTitle(run),
            preview: (last?.body ?? o.payload?.message ?? "").slice(0, 140),
            sentAt: o.sent_at,
            lastAt: last?.created_at ?? o.sent_at ?? o.created_at,
            interviewAt: o.interview_at,
            unread: (o.viewed_at ? 0 : 1) + ms.filter((m) => m.sender_role === "company" && !m.read_at).length,
          };
        }),
      });
    } catch (err) {
      fail(res, "inbox", err);
    }
  });

  app.get("/api/v1/life/offers/:id", async (req, res) => {
    const userId = user(req, res);
    if (!userId) return;
    try {
      const offer = await loadCandidateOffer(req, res, userId);
      if (!offer) return;
      const cases = await loadCases([offer.jd_run_id ?? ""]);
      const run = offer.jd_run_id ? cases.get(offer.jd_run_id) : undefined;
      const [rows, posting] = await Promise.all([loadMessages([offer.id]), loadPosting(run)]);
      const now = new Date().toISOString();
      if (!offer.viewed_at) {
        // 첫 열람 시각 (기업 화면의 "열람" 단계). 컬럼이 없으면 건너뛴다
        const { error } = await db.from("sourcing_actions").update({ viewed_at: now }).eq("id", offer.id).is("viewed_at", null);
        if (!error) await recordStatusEvent({ entity: "sourcing_action", entityId: offer.id, from: "executed", to: "viewed", actor: userId });
      }
      const unreadIds = rows.filter((m) => m.sender_role === "company" && !m.read_at).map((m) => m.id);
      if (unreadIds.length) await db.from("offer_messages").update({ read_at: now }).in("id", unreadIds);
      res.json({
        offer: {
          id: offer.id,
          stage: stageOf({ ...offer, viewed_at: offer.viewed_at ?? now }),
          company: run?.client_name?.trim() || "비공개 기업",
          title: caseTitle(run),
          sentAt: offer.sent_at,
          response: offer.response,
          interviewAt: offer.interview_at,
        },
        posting,
        mails: thread(offer, run, rows),
      });
    } catch (err) {
      fail(res, "open", err);
    }
  });

  app.post("/api/v1/life/offers/:id/reply", async (req, res) => {
    const userId = user(req, res);
    if (!userId) return;
    try {
      const offer = await loadCandidateOffer(req, res, userId);
      if (!offer) return;
      const b = req.body as { body?: unknown; response?: unknown; pickedSlot?: unknown };
      const body = cleanText(b.body, BODY_MAX);
      const response = b.response === "interested" || b.response === "declined" ? b.response : null;
      if (!body) {
        res.status(400).json({ error: "회신 내용을 입력하세요." });
        return;
      }
      if (offer.response === "declined") {
        res.status(400).json({ error: "이미 거절한 제안입니다." });
        return;
      }
      const rows = await loadMessages([offer.id]);
      // 면접 시각은 기업이 마지막으로 제안한 후보 시각 중에서만 고를 수 있다
      const proposed = [...rows].reverse().find((m) => m.sender_role === "company" && (m.interview_slots?.length ?? 0) > 0)?.interview_slots ?? [];
      const picked = typeof b.pickedSlot === "string" && proposed.includes(b.pickedSlot) ? b.pickedSlot : null;
      if (b.pickedSlot && !picked) {
        res.status(400).json({ error: "제안받은 면접 시각 중에서 골라 주세요." });
        return;
      }
      const run = (await loadCases([offer.jd_run_id ?? ""])).get(offer.jd_run_id ?? "");
      const { data, error } = await db
        .from("offer_messages")
        .insert({ offer_id: offer.id, sender_role: "candidate", sender_id: userId, subject: `Re: ${firstSubject(run)}`.slice(0, SUBJECT_MAX), body, picked_slot: picked })
        .select("id, offer_id, sender_role, subject, body, interview_slots, picked_slot, read_at, created_at")
        .single();
      if (error) {
        if (isMissing(error)) res.status(503).json(UNAVAILABLE);
        else fail(res, "reply", error);
        return;
      }
      const now = new Date().toISOString();
      const patch: Record<string, unknown> = {};
      const effective = response ?? (picked ? "interested" : null);
      if (effective && offer.response !== effective) Object.assign(patch, { response: effective, responded_at: now });
      if (picked) patch.interview_at = picked;
      if (Object.keys(patch).length) {
        await db.from("sourcing_actions").update(patch).eq("id", offer.id);
        await recordStatusEvent({ entity: "sourcing_action", entityId: offer.id, from: "executed", to: picked ? "interview_scheduled" : `response:${effective}`, actor: userId });
      } else {
        await recordStatusEvent({ entity: "sourcing_action", entityId: offer.id, from: null, to: "mail:candidate", actor: userId });
      }
      res.status(201).json({ mail: toMail(data as MessageRow), response: effective ?? offer.response, interviewAt: picked ?? offer.interview_at });
    } catch (err) {
      fail(res, "reply", err);
    }
  });
}

import type { Express, Request, Response } from "express";
import type { ZodTypeAny, z } from "zod";
import { FORBIDDEN, createUserDbClient, requireUserToken } from "./auth.js";
import type { FitDbClient } from "../../../shared/lib/fitDb.js";
import { LIFE_CHAT_SYSTEM, streamLifeReply } from "./lifeGemini.js";
import { maskText, pruneLifeMessages, type RawLifeMessage } from "./lifePrune.js";
import {
  LifeCardPatchSchema,
  LifeConsentPurposeSchema,
  LifeCreateSessionSchema,
  LifeIdParamSchema,
  LifeMatchExclusionSchema,
  LifeMessageSchema,
} from "./schemas.js";
import { Sentry } from "./sentry.js";
import { LIFE_QUEUE, enqueueLifeJob, getLifeQueue, isLifeJobId, type LifeJobData } from "../queue/lifeQueue.js";

/**
 * /api/v1/life/* — 라이프 로그 API (19 문서 4절). 계약은 lib/schemas.ts 의 Life* 스키마.
 * 모든 life_* 접근은 사용자 토큰 RLS 클라이언트로만 (service_role 금지). fit_reports/sourcing_actions 는 기존 db.
 */
type Ctx = { userId: string; token: string; udb: FitDbClient };

function ctx(req: Request, res: Response): Ctx | null {
  const u = requireUserToken(req, res);
  if (!u) return null;
  return { ...u, udb: createUserDbClient(u.token) };
}

function parse<S extends ZodTypeAny>(schema: S, value: unknown, res: Response): z.infer<S> | null {
  const r = schema.safeParse(value);
  if (!r.success) {
    res.status(400).json({ error: "요청 형식이 올바르지 않습니다.", issues: r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
    return null;
  }
  return r.data;
}

function idParam(req: Request, res: Response): string | null {
  return parse(LifeIdParamSchema, req.params.id, res);
}

function dbFail(res: Response, where: string, err: { code?: string; message?: string }) {
  console.error(`[life] ${where} 실패: ${err.code ?? ""}`);
  Sentry.captureMessage(`life route db error: ${where}`, { level: "error", extra: { code: err.code, detail: maskText(err.message) } });
  res.status(500).json({ error: "처리 중 오류가 발생했습니다." });
}

async function hasConsent(udb: FitDbClient, userId: string, purpose: "self_ai" | "matching"): Promise<boolean> {
  const { data } = await udb.from("consents").select("id").eq("user_id", userId).eq("purpose", purpose).is("revoked_at", null).limit(1);
  return (data?.length ?? 0) > 0;
}

const CONSENT_REQUIRED = { error: "AI 기록 정리 동의(self_ai)가 필요합니다.", code: "consent_required", purpose: "self_ai" } as const;

/**
 * 동의 철회 (라우트 본체, 테스트용 분리). 유효 동의 행에 revoked_at=now() (사용자 토큰 RLS).
 * matching 철회면 본인 공개 카드마다 life-unpublish 잡을 큐잉한다 (임베딩 삭제 + fit 캐시 무효화).
 * 카드 visibility 는 바꾸지 않는다 — 공개 뷰가 matching 동의를 조건으로 하므로 즉시 비노출되고, 재동의 시 다시 노출.
 */
export async function revokeConsent(
  udb: FitDbClient,
  userId: string,
  purpose: "self_ai" | "matching",
  enqueue: (data: LifeJobData, targetId: string) => Promise<string> = enqueueLifeJob
): Promise<{ ok: true; revoked: number; jobIds: string[] } | { ok: false; where: string; error: { code?: string; message?: string } }> {
  const { data: rows, error } = await udb
    .from("consents")
    .update({ revoked_at: new Date().toISOString() })
    .eq("user_id", userId)
    .eq("purpose", purpose)
    .is("revoked_at", null)
    .select("id");
  if (error) return { ok: false, where: "consent revoke", error };
  const revoked = rows?.length ?? 0;
  if (purpose !== "matching" || revoked === 0) return { ok: true, revoked, jobIds: [] };
  const { data: cards, error: cErr } = await udb.from("evidence_cards").select("id").eq("user_id", userId).eq("visibility", "public");
  if (cErr) return { ok: false, where: "consent revoke cards", error: cErr };
  const jobIds: string[] = [];
  for (const card of (cards ?? []) as { id: string }[]) {
    jobIds.push(await enqueue({ kind: "life-unpublish", userId, cardId: card.id }, card.id));
  }
  return { ok: true, revoked, jobIds };
}

/** 핸들러 예외를 500 으로 (Express 4 는 async throw 를 잡지 않는다) */
const wrap = (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response) => {
  fn(req, res).catch((err) => {
    console.error("[life] route error:", err instanceof Error ? err.name : err);
    Sentry.captureMessage("life route error", { level: "error", extra: { detail: maskText(err instanceof Error ? err.message : String(err)) } });
    if (!res.headersSent) res.status(500).json({ error: "처리 중 오류가 발생했습니다." });
    else res.end();
  });
};

export function registerLifeRoutes(app: Express) {
  const base = "/api/v1/life";

  app.post(`${base}/sessions`, wrap(async (req, res) => {
    const c = ctx(req, res);
    if (!c) return;
    const body = parse(LifeCreateSessionSchema, req.body ?? {}, res);
    if (!body) return;
    const { data, error } = await c.udb
      .from("life_sessions")
      .insert({ user_id: c.userId, source: body.source, title: body.title ?? null })
      .select("id, source, title, started_at, ended_at")
      .single();
    if (error) return dbFail(res, "sessions insert", error);
    res.status(201).json({ session: data });
  }));

  app.post(`${base}/sessions/:id/messages`, wrap(async (req, res) => {
    const c = ctx(req, res);
    if (!c) return;
    const id = idParam(req, res);
    if (!id) return;
    const body = parse(LifeMessageSchema, req.body, res);
    if (!body) return;

    const { data: session, error: sErr } = await c.udb.from("life_sessions").select("id, ended_at").eq("id", id).maybeSingle();
    if (sErr) return dbFail(res, "session select", sErr);
    if (!session) return void res.status(404).json({ error: "세션을 찾을 수 없습니다." });
    if (session.ended_at) return void res.status(409).json({ error: "이미 종료된 세션입니다." });
    if (body.reply && !(await hasConsent(c.udb, c.userId, "self_ai"))) return void res.status(403).json(CONSENT_REQUIRED);

    const { data: msg, error: mErr } = await c.udb
      .from("life_messages")
      .insert({ session_id: id, user_id: c.userId, role: "user", content: body.content })
      .select("id")
      .single();
    if (mErr) return dbFail(res, "message insert", mErr);
    if (!body.reply) return void res.status(201).json({ messageId: msg.id });

    // 컨텍스트 = user_memory 요약 + 이번 세션 최근 대화만 (전체 기록 X)
    const [{ data: memRows }, { data: history }] = await Promise.all([
      c.udb.from("user_memory").select("key, value").eq("user_id", c.userId),
      c.udb.from("life_messages").select("id, role, content, created_at").eq("session_id", id).order("created_at", { ascending: false }).limit(20),
    ]);
    const memory = (memRows ?? []).map((r: { key: string; value: string }) => `${r.key}: ${r.value.slice(0, 600)}`).join("\n");
    const pruned = pruneLifeMessages(((history ?? []) as RawLifeMessage[]).reverse(), { perMessage: 800, total: 6000 });
    const contents = pruned.map((m) => ({ role: (m.role === "user" ? "user" : "model") as "user" | "model", parts: [{ text: m.text }] }));
    const system = memory ? `${LIFE_CHAT_SYSTEM}\n\n사용자 메모리(요약):\n${memory}` : LIFE_CHAT_SYSTEM;

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    send("user", { messageId: msg.id });

    let aborted = false;
    req.on("close", () => (aborted = true));
    let reply = "";
    try {
      for await (const t of streamLifeReply(system, contents)) {
        if (aborted) break;
        reply += t;
        send("delta", { text: t });
      }
    } catch (err) {
      Sentry.captureMessage("life chat stream failed", { level: "error", extra: { detail: maskText(err instanceof Error ? err.message : String(err)) } });
      send("error", { error: "AI 응답 생성에 실패했습니다." });
      return void res.end();
    }
    if (reply.trim()) {
      const { data: aMsg, error: aErr } = await c.udb
        .from("life_messages")
        .insert({ session_id: id, user_id: c.userId, role: "assistant", content: reply.trim() })
        .select("id")
        .single();
      if (aErr) send("error", { error: "AI 응답 저장에 실패했습니다." });
      else send("done", { messageId: aMsg.id });
    } else send("done", { messageId: null });
    res.end();
  }));

  app.post(`${base}/sessions/:id/close`, wrap(async (req, res) => {
    const c = ctx(req, res);
    if (!c) return;
    const id = idParam(req, res);
    if (!id) return;
    if (!(await hasConsent(c.udb, c.userId, "self_ai"))) return void res.status(403).json(CONSENT_REQUIRED);
    const { data, error } = await c.udb
      .from("life_sessions")
      .update({ ended_at: new Date().toISOString() })
      .eq("id", id)
      .is("ended_at", null)
      .select("id")
      .maybeSingle();
    if (error) return dbFail(res, "session close", error);
    if (!data) return void res.status(409).json({ error: "세션이 없거나 이미 종료되었습니다." });
    const jobId = await enqueueLifeJob({ kind: "life-structure", userId: c.userId, accessToken: c.token, sessionId: id }, id);
    res.status(202).json({ jobId });
  }));

  app.get(`${base}/drafts`, wrap(async (req, res) => {
    const c = ctx(req, res);
    if (!c) return;
    const [acts, drafts, cards] = await Promise.all([
      c.udb.from("activities").select("id, session_id, title, summary, occurred_on, tags, created_at").order("created_at", { ascending: false }).limit(100),
      c.udb.from("activity_drafts").select("id, activity_id, session_id, draft, quotes, status, created_at").eq("status", "pending").order("created_at", { ascending: false }).limit(100),
      c.udb.from("evidence_cards").select("id, activity_id, claim, visibility, trust_level, recorded_at, ai_edited, source, links, published_at, updated_at, featured").order("recorded_at", { ascending: false }).limit(200),
    ]);
    const err = acts.error ?? drafts.error ?? cards.error;
    if (err) return dbFail(res, "drafts select", err);
    res.json({ activities: acts.data, drafts: drafts.data, cards: cards.data });
  }));

  app.patch(`${base}/cards/:id`, wrap(async (req, res) => {
    const c = ctx(req, res);
    if (!c) return;
    const id = idParam(req, res);
    if (!id) return;
    const body = parse(LifeCardPatchSchema, req.body, res);
    if (!body) return;
    const update: Record<string, unknown> = {};
    if (body.claim !== undefined) update.claim = body.claim;
    if (body.links !== undefined) {
      // 파일 경로는 본인 폴더만 (다른 사용자 파일을 근거로 걸지 못하게)
      if (body.links.some((l) => l.url.startsWith("storage://") && !l.url.startsWith(`storage://evidence/${c.userId}/`))) {
        return void res.status(400).json({ error: "본인이 올린 파일만 근거로 붙일 수 있습니다." });
      }
      update.links = body.links;
      // 근거가 생기면 본인 주장 → 첨부. 확인됨(동료 확인)은 그대로 둔다
      const { data: cur } = await c.udb.from("evidence_cards").select("trust_level").eq("id", id).maybeSingle();
      if (cur && cur.trust_level !== "confirmed") update.trust_level = body.links.length > 0 ? "attached" : "self";
    }
    if (body.visibility === "private") Object.assign(update, { visibility: "private", published_at: null });
    const { data, error } = await c.udb
      .from("evidence_cards")
      .update(update)
      .eq("id", id)
      .select("id, activity_id, claim, visibility, trust_level, recorded_at, ai_edited, source, links, published_at, updated_at, featured")
      .maybeSingle();
    if (error) return dbFail(res, "card patch", error);
    if (!data) return void res.status(404).json({ error: "카드를 찾을 수 없습니다." });
    res.json({ card: data });
  }));

  app.post(`${base}/cards/:id/polish`, wrap(async (req, res) => {
    const c = ctx(req, res);
    if (!c) return;
    const id = idParam(req, res);
    if (!id) return;
    if (!(await hasConsent(c.udb, c.userId, "self_ai"))) return void res.status(403).json(CONSENT_REQUIRED);
    const { data: card } = await c.udb.from("evidence_cards").select("id").eq("id", id).maybeSingle();
    if (!card) return void res.status(404).json({ error: "카드를 찾을 수 없습니다." });
    const jobId = await enqueueLifeJob({ kind: "life-polish", userId: c.userId, accessToken: c.token, cardId: id }, id);
    res.status(202).json({ jobId });
  }));

  app.post(`${base}/cards/:id/publish`, wrap(async (req, res) => {
    const c = ctx(req, res);
    if (!c) return;
    const id = idParam(req, res);
    if (!id) return;
    const { data, error } = await c.udb
      .from("evidence_cards")
      .update({ visibility: "public", published_at: new Date().toISOString() })
      .eq("id", id)
      .select("id, visibility, published_at, recorded_at, ai_edited, trust_level")
      .maybeSingle();
    if (error) return dbFail(res, "card publish", error);
    if (!data) return void res.status(404).json({ error: "카드를 찾을 수 없습니다." });
    // 공개 뷰는 matching 동의가 있어야 노출된다 — UI 안내용으로 같이 돌려준다.
    // 임베딩 + fit 캐시 무효화는 life-publish 잡 (2조). 기존 응답에 jobId 만 추가.
    const jobId = await enqueueLifeJob({ kind: "life-publish", userId: c.userId, cardId: id }, id);
    res.json({ card: data, matchingConsent: await hasConsent(c.udb, c.userId, "matching"), jobId });
  }));

  app.post(`${base}/cards/:id/unpublish`, wrap(async (req, res) => {
    const c = ctx(req, res);
    if (!c) return;
    const id = idParam(req, res);
    if (!id) return;
    const { data, error } = await c.udb
      .from("evidence_cards")
      .update({ visibility: "private", published_at: null })
      .eq("id", id)
      .select("id")
      .maybeSingle();
    if (error) return dbFail(res, "card unpublish", error);
    if (!data) return void res.status(404).json({ error: "카드를 찾을 수 없습니다." });
    const jobId = await enqueueLifeJob({ kind: "life-unpublish", userId: c.userId, cardId: id }, id);
    res.status(202).json({ jobId });
  }));

  app.get(`${base}/matches`, wrap(async (req, res) => {
    const c = ctx(req, res);
    if (!c) return;
    const { db } = await import("./db.js");
    const [reports, actions, cards] = await Promise.all([
      db.from("fit_reports").select("id, jd, status, report, created_at").eq("candidate_id", c.userId).order("created_at", { ascending: false }).limit(50),
      db.from("sourcing_actions").select("id, status, payload, created_at").contains("payload", { candidateIds: [c.userId] }).order("created_at", { ascending: false }).limit(50),
      c.udb.from("evidence_cards").select("id, claim, trust_level, recorded_at, ai_edited").eq("visibility", "public"),
    ]);
    const err = reports.error ?? actions.error ?? cards.error;
    if (err) return dbFail(res, "matches select", err);
    const { extractJdHeadline } = await import("../../../shared/lib/shortlist.js");
    const myCards = (cards.data ?? []) as { id: string }[];
    // 근거 카드: 리포트 본문에 인용된 본인 공개 카드 id (최대 3장). 헤드헌터 메모(ceoSummary 등)는 노출하지 않는다.
    const citedIn = (report: unknown) => {
      const s = JSON.stringify(report ?? "");
      return myCards.filter((k) => s.includes(k.id)).slice(0, 3);
    };
    res.json({
      reports: (reports.data ?? []).map((r: { id: string; jd: string; status: string; report: { overallScore?: number; verdict?: string } | null; created_at: string }) => ({
        id: r.id,
        jdHeadline: extractJdHeadline(r.jd) ?? null,
        status: r.status,
        overallScore: r.report?.overallScore ?? null,
        verdict: r.report?.verdict ?? null,
        createdAt: r.created_at,
        evidenceCards: citedIn(r.report),
      })),
      sourcingActions: (actions.data ?? []).map((a: { id: string; status: string; payload: { jdHeadline?: string }; created_at: string }) => ({
        id: a.id,
        status: a.status,
        jdHeadline: a.payload?.jdHeadline ?? null,
        createdAt: a.created_at,
      })),
    });
  }));

  app.post(`${base}/match-exclusions`, wrap(async (req, res) => {
    const c = ctx(req, res);
    if (!c) return;
    const body = parse(LifeMatchExclusionSchema, req.body ?? {}, res);
    if (!body) return;
    const { data, error } = await c.udb.from("match_exclusions").insert({ user_id: c.userId, job_posting_id: body.jobPostingId }).select("id, job_posting_id, created_at").single();
    if (error?.code === "23505") return void res.status(200).json({ duplicated: true });
    if (error) return dbFail(res, "exclusion insert", error);
    res.status(201).json({ exclusion: data });
  }));

  app.delete(`${base}/match-exclusions`, wrap(async (req, res) => {
    const c = ctx(req, res);
    if (!c) return;
    const body = parse(LifeMatchExclusionSchema, req.body ?? {}, res);
    if (!body) return;
    let q = c.udb.from("match_exclusions").delete().eq("user_id", c.userId);
    q = body.jobPostingId ? q.eq("job_posting_id", body.jobPostingId) : q.is("job_posting_id", null);
    const { data, error } = await q.select("id");
    if (error) return dbFail(res, "exclusion delete", error);
    res.json({ deleted: data?.length ?? 0 });
  }));

  app.post(`${base}/consents/:purpose/revoke`, wrap(async (req, res) => {
    const c = ctx(req, res);
    if (!c) return;
    const purpose = parse(LifeConsentPurposeSchema, req.params.purpose, res);
    if (!purpose) return;
    const r = await revokeConsent(c.udb, c.userId, purpose);
    if (!r.ok) return dbFail(res, r.where, r.error);
    res.status(purpose === "matching" && r.revoked > 0 ? 202 : 200).json({ revoked: r.revoked, jobIds: r.jobIds });
  }));

  // 잡 진행 SSE (기존 /api/jobs/:jobId/stream 은 fit 큐 전용이라 life 큐용을 둔다). ?access_token= 허용.
  app.get(`${base}/jobs/:jobId/stream`, wrap(async (req, res) => {
    const u = requireUserToken(req, res);
    if (!u) return;
    const { jobId } = req.params;
    if (!isLifeJobId(jobId)) return void res.status(404).json({ error: "job 을 찾을 수 없습니다." });
    const queue = getLifeQueue();
    const job = await queue.getJob(jobId);
    if (job && job.data.userId !== u.userId) return void res.status(403).json(FORBIDDEN);
    const { streamJobEvents } = await import("./sse.js");
    await streamJobEvents(req, res, queue, LIFE_QUEUE, jobId);
  }));
}

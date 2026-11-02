import cors from "cors";
import express from "express";
import { Sentry } from "./lib/sentry.js";
import type { FitAnalysisJobData, FitReport, FitReportStatus, PortfolioChatJobData, SlackNotifyPayload, SourcingActionStatus } from "../../shared/types.js";
import { autoSourcingFromJd } from "./lib/autoSourcing.js";
import { getCachedReport, jdHash, setCachedReport } from "./lib/cache.js";
import { createSourcingWithApproval } from "./lib/createSourcingWithApproval.js";
import { extractJdHeadline } from "../../shared/lib/shortlist.js";
import { createFitReport, getFitReportByCandidateAndJdHash, getFitReportById, listFitReports, updateFitReportByJobId } from "./lib/fitReports.js";
import { getCachedAnswer } from "./lib/portfolioChatCache.js";
import { callMcpTool } from "./mcp/client.js";
import { getSourcingActionById, listSourcingActions, updateSourcingAction } from "./lib/sourcingActions.js";
import { streamJobEvents } from "./lib/sse.js";
import { listCandidates } from "./lib/talentfolio.js";
import { verifySlackSignature } from "./lib/slackVerify.js";
import { registerNotionRoutes } from "./lib/notionRoutes.js";
import { registerCrawlReviewRoutes } from "./lib/crawlReviewRoutes.js";
import { registerLifeRoutes } from "./lib/lifeRoutes.js";
import { registerRecommendRoutes } from "./lib/recommendRoutes.js";
import { registerCandidateNormRoutes } from "./lib/candidateNormRoutes.js";
import { registerMatchQualityRoutes } from "./lib/matchQualityRoutes.js";
import { registerWatchRoutes } from "./lib/watchRoutes.js";
import { isWatchNoSend } from "./lib/watchCore.js";
import { recordStatusEvent, registerDeskRoutes } from "./lib/deskRoutes.js";
import { registerScoutCaseRoutes } from "./lib/scoutCases.js";
import { buildJdPlan } from "./lib/jdPlan.js";
import { handleSlackEvents, isUrlVerification, type SlackEventsBody } from "./lib/slackEvents.js";
import {
  deleteChannelConfig,
  listChannelConfigs,
  upsertChannelConfig,
} from "./lib/slackChannelConfigs.js";
import { JOB_PRIORITY, QUEUE_NAMES, buildJobId, buildPortfolioChatJobId, getQueue, portfolioChatQueue, removeStaleFailedJob } from "./queue/queues.js";
import { FORBIDDEN, authGate, isOwner, resolveUserId } from "./lib/auth.js";
import { buildCorsOptions } from "./lib/corsConfig.js";
import { listJobPostings, listPublicJobPostings } from "./lib/jobPostings.js";

const SOURCING_ACTION_STATUSES: readonly SourcingActionStatus[] = ["pending", "approved", "rejected", "executed", "failed"];

// GET /api/sourcing/actions 허용 조건 (순수 함수): 해석된 userId(토큰 sub 또는 legacy query)가 있거나 status 가 정확히 "pending".
// resolveUserId 가 토큰 유무를 이미 반영하므로 hasUserId 하나로 충분하다.
function isSourcingActionsQueryAllowed(hasUserId: boolean, status: string | undefined): boolean {
  return hasUserId || status === "pending";
}

// Phase M2: 발송된 Slack 승인 요청 메시지 참조 (결정 후 chat.update로 갱신하기 위해 result에 저장)
interface ApprovalRef {
  ts: string;
  channel: string;
}

// Slack 인터랙티비티 콜백 페이로드 중 우리가 신뢰하는 최소 필드만 추출
interface SlackInteractionPayload {
  actions?: { action_id?: string; value?: string }[];
  user?: { id?: string; username?: string; name?: string };
}

function getApprovalRef(result: Record<string, unknown> | null): ApprovalRef | undefined {
  const approval = (result as { approval?: ApprovalRef } | null)?.approval;
  if (approval && typeof approval.ts === "string" && typeof approval.channel === "string") return approval;
  return undefined;
}

// 발송된 승인 요청 메시지를 결정 결과로 갱신 (실패해도 본 처리에는 영향 없음)
async function updateSlackApprovalMessage(
  approval: ApprovalRef,
  text: string,
  status: "executed" | "rejected" | "failed",
  decidedBy?: string,
  cards?: SlackNotifyPayload["cards"],
  jdHash?: string
): Promise<void> {
  try {
    await callMcpTool("update_slack_decision", {
      channel: approval.channel,
      ts: approval.ts,
      text,
      status,
      decidedBy: decidedBy ?? undefined,
      cards,
      jdHash,
    });
  } catch (err) {
    console.error("[sourcing] Slack 승인 메시지 갱신 실패:", err);
  }
}

// Phase M2: HIL 승인/반려 공용 처리 — 웹 UI(/review)와 Slack 인터랙티비티 양쪽에서 재사용.
// 승인 시에만 notify_slack tool로 실제 전송하고, 발송된 승인 카드를 결과로 갱신한다.
type ReviewResult =
  | { ok: true; status: SourcingActionStatus; result?: unknown }
  | { ok: false; error: string };

async function reviewSourcingAction(
  id: string,
  action: "approve" | "reject",
  decidedBy?: string
): Promise<ReviewResult> {
  const sourcingAction = await getSourcingActionById(id);
  if (!sourcingAction || sourcingAction.status !== "pending") {
    return { ok: false, error: "검토 대상이 아닙니다." };
  }

  const approval = getApprovalRef(sourcingAction.result);
  const baseResult = (sourcingAction.result ?? {}) as Record<string, unknown>;
  const { text, cards, jdHeadline, jdHash } = sourcingAction.payload;

  if (action === "reject") {
    const updated = await updateSourcingAction(id, {
      status: "rejected",
      result: { ...baseResult, decidedBy: decidedBy ?? null },
    });
    if (approval) await updateSlackApprovalMessage(approval, text, "rejected", decidedBy, cards, jdHash);
    return { ok: true, status: updated.status };
  }

  // 상시 수색(E7) 승인 건은 화면·로그로만 처리 (WATCH_APPROVAL_SEND_SLACK=1 이면 기존처럼 발송)
  if (isWatchNoSend(sourcingAction.payload)) {
    const updated = await updateSourcingAction(id, {
      status: "approved",
      result: { ...baseResult, send: { skipped: "watch_no_slack" }, decidedBy: decidedBy ?? null },
    });
    return { ok: true, status: updated.status };
  }

  try {
    const result = await callMcpTool<{ ok: boolean; error?: string }>("notify_slack", {
      channel: sourcingAction.payload.channel,
      text,
      cards,
      jdHeadline,
      jdHash,
    });
    const status: SourcingActionStatus = result.ok ? "executed" : "failed";
    const updated = await updateSourcingAction(id, {
      status,
      result: { ...baseResult, send: result, decidedBy: decidedBy ?? null },
    });
    if (approval) await updateSlackApprovalMessage(approval, text, status, decidedBy, cards, jdHash);

    // Phase M4: Slack 승인 후 Notion sync (연동·DB 선택된 경우, 실패해도 본 처리는 유지)
    const jdRunId = sourcingAction.payload.jdRunId;
    const candidateIds = sourcingAction.payload.candidateIds;
    if (status === "executed" && jdRunId && candidateIds?.length) {
      try {
        await callMcpTool("sync_candidates_to_notion", {
          userId: sourcingAction.userId,
          jdRunId,
          candidateIds,
        });
      } catch (notionErr) {
        console.warn("[sourcing] Notion sync 실패 (Slack 전송은 완료):", notionErr);
      }
    }

    return { ok: true, status: updated.status, result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const updated = await updateSourcingAction(id, {
      status: "failed",
      result: { ...baseResult, error: message, decidedBy: decidedBy ?? null },
    });
    if (approval) await updateSlackApprovalMessage(approval, text, "failed", decidedBy, cards, jdHash);
    return { ok: true, status: updated.status, result: { error: message } };
  }
}

export function createApp() {
  const app = express();
  // CORS: CORS_ALLOWED_ORIGINS(콤마 구분) 화이트리스트. 미설정 시 개발 환경에서만 localhost 허용.
  app.use(cors(buildCorsOptions()));
  app.use(express.json());

  // Supabase JWT 게이트. 서명 검증 라우트(Slack)·OAuth 콜백·공개 brief 는 제외.
  // 크롤 검수(/admin/crawl)는 JWT 대신 비밀번호 게이트(lib/adminAuth.ts)를 탄다.
  // SSE(EventSource)와 OAuth 시작(브라우저 네비게이션)은 헤더를 못 실으므로 ?access_token= 허용.
  app.use(
    "/api",
    authGate({
      publicPaths: [/^\/admin\/crawl(\/|$)/, /^\/admin\/candidates\/normalize(\/stats)?$/, /^\/admin\/match\/(quality|weights)$/,/^\/public\/job-postings$/, /^\/slack\/interactivity$/, /^\/slack\/events$/, /^\/notion\/oauth\/callback$/, /^\/brief$/],
      queryTokenPaths: [/^\/jobs\/[^/]+\/stream$/, /^\/v1\/life\/jobs\/[^/]+\/stream$/, /^\/portfolio-chat\/[^/]+\/stream$/, /^\/notion\/oauth\/start$/],
    })
  );

  registerNotionRoutes(app);
  registerCrawlReviewRoutes(app);
  registerCandidateNormRoutes(app);
  registerMatchQualityRoutes(app);
  registerWatchRoutes(app);
  registerLifeRoutes(app);
  registerRecommendRoutes(app);
  registerDeskRoutes(app);
  registerScoutCaseRoutes(app);

  // 202 Accepted — 동기 await 없이 즉시 jobId 반환 (절대 규칙 2: Anti-Blocking)
  app.post("/api/analyze", async (req, res) => {
    const { jd, candidateId, tier } = req.body as Partial<FitAnalysisJobData>;
    const userId = resolveUserId(req, (req.body as { userId?: string }).userId);

    if (!jd || !candidateId || !userId || (tier !== "paid" && tier !== "free")) {
      res.status(400).json({ error: "jd, candidateId, tier(paid|free)는 필수입니다. (userId는 토큰에서 추출)" });
      return;
    }

    const cached = await getCachedReport(jd, candidateId);
    if (cached) {
      res.status(200).json({ cached: true, report: cached });
      return;
    }

    const queue = getQueue(tier);
    const jobId = buildJobId(jd, candidateId);

    // 영구 실패(재시도 소진)한 동일 jobId의 job이 남아있으면 제거 — 그대로면 재처리되지 않음
    await removeStaleFailedJob(queue, jobId);

    // 워커가 jobId로 fit_reports를 조회/업데이트하기 전에 행이 먼저 존재해야 하므로
    // (race condition 방지) createFitReport를 queue.add보다 먼저 수행한다.
    await createFitReport({ jobId, jd, jdHash: jdHash(jd), candidateId, userId });

    const job = await queue.add("analyze-fit", { jd, candidateId, userId, tier }, { jobId, priority: JOB_PRIORITY[tier] });

    res.status(202).json({ jobId: job.id, tier });
  });

  // 후보자 멀티선택용 목록 (talentfolio profiles 요약)
  app.get("/api/candidates", async (_req, res) => {
    const candidates = await listCandidates();
    res.json({ candidates });
  });

  // 크롤러가 적재한 채용공고(fit.job_postings) — JD 입력 소스. q=제목/회사 검색, source=소스 필터
  app.get("/api/job-postings", async (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q : undefined;
    const source = typeof req.query.source === "string" ? req.query.source : undefined;
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    try {
      const postings = await listJobPostings({ q, source, limit });
      res.json({ postings });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `채용공고 조회 실패: ${message}` });
    }
  });

  // 공개 공고 목록 (talentfolio /studio — 비로그인 가능). 검수 승인된 크롤 공고만, 원문·description 제외
  app.get("/api/public/job-postings", async (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q : undefined;
    const limit = Math.min(Number(req.query.limit) || 100, 200);
    try {
      const postings = await listPublicJobPostings({ q, limit });
      res.set("Cache-Control", "public, max-age=60");
      res.json({ postings });
    } catch (err) {
      console.error("[public/job-postings]", err instanceof Error ? err.message : err);
      res.status(500).json({ error: "공고 목록을 불러오지 못했습니다." });
    }
  });

  // Phase M1 — JD 분석 계획 수립: 직군/키워드 파싱(LLM 1회) + 코드 기반 사전 필터·랭킹(LLM 0원)
  // 비싼 정밀 분석(/api/analyze) 전에 "누구를 분석할지"를 좁혀서 토큰/시간을 절약한다.
  app.post("/api/jd/plan", async (req, res) => {
    const { jd, role: clientRole, keywords: clientKeywords } = req.body as {
      jd?: string;
      role?: "developer" | "designer";
      keywords?: string[];
    };
    if (!jd || !jd.trim()) {
      res.status(400).json({ error: "jd는 필수입니다." });
      return;
    }

    try {
      const plan = await buildJdPlan(jd, clientRole, clientKeywords);
      res.json(plan);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isQuota = message.includes("RESOURCE_EXHAUSTED") || message.includes("429");
      res.status(isQuota ? 429 : 500).json({
        error: isQuota
          ? "Gemini 일일 무료 한도를 초과했습니다. 잠시 후 다시 시도하거나 결제를 활성화하세요."
          : `JD 분석 계획 수립 실패: ${message}`,
      });
    }
  });

  // Phase M2.6 — Talentfolio Brief 페이지 / Slack unfurl용 FitReport 조회
  app.get("/api/brief", async (req, res) => {
    const candidateId = req.query.candidateId as string | undefined;
    const jdHashParam = req.query.jdHash as string | undefined;

    if (!candidateId) {
      res.status(400).json({ error: "candidateId는 필수입니다." });
      return;
    }

    try {
      let report: FitReport | null = null;
      let jdHeadline: string | null = null;

      if (jdHashParam) {
        const record = await getFitReportByCandidateAndJdHash(candidateId, jdHashParam);
        if (record) {
          jdHeadline = extractJdHeadline(record.jd) ?? null;
          report = record.report ?? (await getCachedReport(record.jd, candidateId));
        }
      }

      res.json({
        candidateId,
        jdHash: jdHashParam ?? null,
        jdHeadline,
        report,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Brief 조회 실패: ${message}` });
    }
  });

  // fit_reports 목록 — status/userId로 필터 (HIL 검토 대기열 등)
  app.get("/api/fit-reports", async (req, res) => {
    const status = req.query.status as FitReportStatus | undefined;
    // 토큰 사용자는 자기 리포트만. legacy 모드(토큰 없음)에서만 query userId 폴백.
    const userId = resolveUserId(req, req.query.userId as string | undefined);
    const reports = await listFitReports({ status, userId });
    res.json({ reports });
  });

  // HIL 검토 — 리크루터의 승인/반려 액션 (추가 LLM 호출 없음, 단순 상태 변경)
  app.post("/api/fit-reports/:id/review", async (req, res) => {
    const { id } = req.params;
    const { action, reason } = req.body as { action?: "approve" | "reject"; reason?: unknown };

    if (action !== "approve" && action !== "reject") {
      res.status(400).json({ error: "action은 approve 또는 reject여야 합니다." });
      return;
    }

    const report = await getFitReportById(id);
    // 저신뢰(pending_review)뿐 아니라 정상 완료(completed) 리포트도 헤드헌터가 승인/거절한다 (20 문서 C1)
    if (!report || (report.status !== "pending_review" && report.status !== "completed")) {
      res.status(400).json({ error: "검토 대상이 아닙니다." });
      return;
    }
    if (!isOwner(req, report.userId)) {
      res.status(403).json(FORBIDDEN);
      return;
    }

    const status: FitReportStatus = action === "approve" ? "approved" : "rejected";
    // 사유는 리포트 jsonb 에 남긴다 (스키마 변경 없음). 리포트 본문이 없으면 상태만 바꾼다.
    const review = {
      decision: status,
      reason: typeof reason === "string" && reason.trim() ? reason.trim().slice(0, 200) : null,
      decidedBy: req.auth?.email ?? req.auth?.userId ?? null,
      decidedAt: new Date().toISOString(),
    } as const;
    const updated = await updateFitReportByJobId(report.jobId, {
      status,
      ...(report.report ? { report: { ...report.report, review } } : {}),
    });

    await recordStatusEvent({ entity: "fit_report", entityId: report.id, from: report.status, to: status, actor: review.decidedBy, reason: review.reason });

    if (status === "approved" && updated.report) {
      await setCachedReport(updated.jd, updated.candidateId, updated.report);
    }

    res.json({ status: updated.status });
  });

  // SSE — jobId의 단계별 진행 상황(큐 대기 중 -> ... -> 완료)을 스트리밍
  app.get("/api/jobs/:jobId/stream", async (req, res) => {
    const { jobId } = req.params;
    const tier = req.query.tier === "free" ? "free" : "paid";
    const queueName = tier === "free" ? QUEUE_NAMES.free : QUEUE_NAMES.paid;
    const queue = getQueue(tier);

    // 다른 사용자의 job 진행 상황/결과를 구독할 수 없다.
    const job = await queue.getJob(jobId);
    if (job && !isOwner(req, job.data.userId)) {
      res.status(403).json(FORBIDDEN);
      return;
    }

    await streamJobEvents(req, res, queue, queueName, jobId);
  });

  // Phase 5 — 포트폴리오 챗(RAG): 질문 등록 (202 Accepted)
  app.post("/api/portfolio-chat", async (req, res) => {
    const { candidateId, question } = req.body as Partial<PortfolioChatJobData>;

    if (!candidateId || !question) {
      res.status(400).json({ error: "candidateId, question은 필수입니다." });
      return;
    }

    const cached = await getCachedAnswer(candidateId, question);
    if (cached) {
      res.status(200).json({ cached: true, result: cached });
      return;
    }

    const jobId = buildPortfolioChatJobId(candidateId, question);

    // 영구 실패(재시도 소진)한 동일 jobId의 job이 남아있으면 제거 — 그대로면 재처리되지 않음
    await removeStaleFailedJob(portfolioChatQueue, jobId);

    const job = await portfolioChatQueue.add("portfolio-chat", { candidateId, question }, { jobId });

    res.status(202).json({ jobId: job.id });
  });

  // Phase 5 — 포트폴리오 챗 진행 상황 스트리밍
  app.get("/api/portfolio-chat/:jobId/stream", async (req, res) => {
    const { jobId } = req.params;
    await streamJobEvents(req, res, portfolioChatQueue, QUEUE_NAMES.portfolioChat, jobId);
  });

  // Phase 5 — B2B 사내 소싱: 인재 DB 검색 (LLM 호출 없음, MCP tool 그대로 전달)
  app.get("/api/sourcing/candidates", async (req, res) => {
    const query = req.query.query as string | undefined;
    const role = req.query.role as "developer" | "designer" | undefined;
    try {
      const candidates = await callMcpTool("search_candidates", { query, role });
      res.json({ candidates });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[sourcing/candidates]", message);
      res.status(503).json({
        error: "인재 DB 검색에 실패했습니다. mcp-server(3002)가 실행 중인지 확인하세요.",
        detail: message,
      });
    }
  });

  // Phase M2.5 — JD 분석 완료 후 strong_fit 쇼트리스트를 자동으로 Slack HIL 승인 요청에 등록
  app.post("/api/sourcing/auto-from-jd", async (req, res) => {
    const { jd, channel, reports, manualSelection } = req.body as {
      jd?: string;
      userId?: string;
      channel?: string;
      reports?: FitReport[];
      manualSelection?: boolean;
    };
    const userId = resolveUserId(req, (req.body as { userId?: string }).userId);

    if (!jd?.trim() || !userId || !Array.isArray(reports) || reports.length === 0) {
      res.status(400).json({ error: "jd, reports(비어 있지 않은 배열)는 필수입니다. (userId는 토큰에서 추출)" });
      return;
    }

    try {
      const result = await autoSourcingFromJd({ jd, userId, channel, reports, manualSelection });
      res.status(result.created ? 201 : 200).json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `자동 소싱 요청 실패: ${message}` });
    }
  });

  // Phase 5/M2 — B2B 사내 소싱: Slack 알림 액션을 pending 상태로 생성한다 (즉시 전송하지 않음).
  // Phase M2: 생성 직후 동일 채널로 ✅승인/❌거절 버튼이 달린 인터랙티브 승인 요청을 발송하고,
  // 반환된 메시지 ts를 result.approval에 저장한다 (Slack/웹 UI 어느 쪽에서 승인해도 카드가 갱신됨).
  app.post("/api/sourcing/actions", async (req, res) => {
    const { channel, text, candidateIds, candidateNames, cards, jdHeadline, jdHash, autoSource } =
      req.body as Partial<SlackNotifyPayload> & { userId?: string };
    const userId = resolveUserId(req, (req.body as { userId?: string }).userId);

    if (!channel || !text || !userId) {
      res.status(400).json({ error: "channel, text는 필수입니다. (userId는 토큰에서 추출)" });
      return;
    }

    try {
      const { action, approvalWarning } = await createSourcingWithApproval({
        userId,
        payload: {
          channel,
          text,
          candidateIds,
          candidateNames,
          cards,
          jdHeadline,
          jdHash,
          autoSource: autoSource ?? "manual",
        },
      });

      res.status(201).json({
        action,
        ...(approvalWarning
          ? {
              approvalWarning: approvalWarning.includes("인터랙티브")
                ? `${approvalWarning} Slack 버튼 승인을 쓰려면 SLACK_SIGNING_SECRET + SLACK_INTERACTIVITY_URL을 설정하세요.`
                : approvalWarning,
            }
          : {}),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `소싱 액션 생성 실패: ${message}` });
    }
  });

  // Phase 5 — B2B 사내 소싱: 액션 목록 (HIL 검토 대기열 등)
  app.get("/api/sourcing/actions", async (req, res) => {
    const rawStatus = typeof req.query.status === "string" && req.query.status ? req.query.status : undefined;
    if (rawStatus !== undefined && !SOURCING_ACTION_STATUSES.includes(rawStatus as SourcingActionStatus)) {
      res.status(400).json({ error: "유효하지 않은 status 입니다." });
      return;
    }
    const status = rawStatus as SourcingActionStatus | undefined;
    const userId = resolveUserId(req, typeof req.query.userId === "string" ? req.query.userId : undefined);
    // 방어: legacy 에서 userId·토큰 없이 전 사용자 이력(approved/executed 등)을 덤프하는 호출만 차단한다.
    // 못 막는 것: status=pending 팀 공용 대기열은 legacy 에서 여전히 공개(talentfolio 호환용).
    // 완전한 해결은 AUTH_MODE=required + talentfolio Bearer 전송.
    if (!isSourcingActionsQueryAllowed(Boolean(userId), rawStatus)) {
      res.status(400).json({ error: "status 또는 userId 가 필요합니다." });
      return;
    }
    const actions = await listSourcingActions({ status, userId: userId || undefined });
    res.json({ actions });
  });

  // Phase 5/M2 — B2B 사내 소싱: 웹 UI(HIL) 승인/반려. 공용 reviewSourcingAction을 호출한다.
  // (Slack 인터랙티비티 경로와 동일 로직 — 승인 시에만 notify_slack으로 실제 전송)
  app.post("/api/sourcing/actions/:id/review", async (req, res) => {
    const { id } = req.params;
    const { action, decidedBy: bodyDecidedBy } = (req.body ?? {}) as { action?: "approve" | "reject"; decidedBy?: unknown };
    // 감사 기록: 토큰이 있으면 토큰 신원 우선(body 위조 방지). 토큰 없을 때(legacy)만 body 값 사용 — 문자열만, 앞 80자로 자름.
    const decidedBy: string | undefined =
      req.auth?.email ??
      req.auth?.userId ??
      (typeof bodyDecidedBy === "string" && bodyDecidedBy.trim() ? bodyDecidedBy.trim().slice(0, 80) : undefined);

    if (action !== "approve" && action !== "reject") {
      res.status(400).json({ error: "action은 approve 또는 reject여야 합니다." });
      return;
    }

    const existing = await getSourcingActionById(id);
    if (existing && !isOwner(req, existing.userId)) {
      res.status(403).json(FORBIDDEN);
      return;
    }

    const result = await reviewSourcingAction(id, action, decidedBy);
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    res.json({ status: result.status, result: result.result });
  });

  // Phase M2 — Slack 인터랙티비티 콜백. 리크루터가 Slack에서 ✅승인/❌거절 버튼을 누르면 여기로 들어온다.
  // 서명 검증(SLACK_SIGNING_SECRET) 후 3초 내 200 ack → 이후 비동기로 승인/반려 처리(Anti-Blocking).
  // raw body가 서명 검증에 필요하므로 이 라우트에만 raw 파서를 둔다 (전역 express.json은 urlencoded를 소비하지 않음).
  app.post("/api/slack/interactivity", express.raw({ type: () => true }), async (req, res) => {
    const rawBody = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
    const verified = verifySlackSignature(
      rawBody,
      req.header("x-slack-signature"),
      req.header("x-slack-request-timestamp")
    );
    if (!verified.ok) {
      res.status(401).json({ error: verified.reason });
      return;
    }

    // Slack은 application/x-www-form-urlencoded로 payload=<json> 형태를 보낸다.
    const payloadRaw = new URLSearchParams(rawBody).get("payload");
    if (!payloadRaw) {
      res.status(400).end();
      return;
    }

    let payload: SlackInteractionPayload;
    try {
      payload = JSON.parse(payloadRaw) as SlackInteractionPayload;
    } catch {
      res.status(400).end();
      return;
    }

    // 먼저 ack (Slack은 3초 내 응답 요구). 실제 처리는 이후 비동기로 진행.
    res.status(200).end();

    const interaction = payload.actions?.[0];
    const actionId = interaction?.action_id;
    const sourcingActionId = interaction?.value;
    const decidedBy = payload.user?.username || payload.user?.name || payload.user?.id;

    if (!sourcingActionId || (actionId !== "approve_sourcing" && actionId !== "reject_sourcing")) return;
    const decision = actionId === "approve_sourcing" ? "approve" : "reject";

    try {
      await reviewSourcingAction(sourcingActionId, decision, decidedBy);
    } catch (err) {
      console.error("[slack interactivity] 처리 실패:", err);
    }
  });

  // Phase M2.7 — Slack Events API (봇 채널 초대 → 자동 소싱)
  app.post("/api/slack/events", express.raw({ type: () => true }), async (req, res) => {
    const rawBody = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
    const verified = verifySlackSignature(
      rawBody,
      req.header("x-slack-signature"),
      req.header("x-slack-request-timestamp")
    );
    if (!verified.ok) {
      res.status(401).json({ error: verified.reason });
      return;
    }

    let body: SlackEventsBody;
    try {
      body = JSON.parse(rawBody) as SlackEventsBody;
    } catch {
      res.status(400).end();
      return;
    }

    if (isUrlVerification(body)) {
      res.json({ challenge: body.challenge });
      return;
    }

    res.status(200).end();

    void handleSlackEvents(body).catch((err) => {
      console.error("[slack events] 처리 실패:", err);
    });
  });

  // Slack 채널별 자동 소싱 설정 (봇 초대 시 JD 매핑)
  app.get("/api/slack/channel-configs", async (req, res) => {
    const userId = resolveUserId(req, typeof req.query.userId === "string" ? req.query.userId : undefined);
    if (!userId) {
      res.status(400).json({ error: "userId를 확인할 수 없습니다. (토큰 필요)" });
      return;
    }
    try {
      const configs = await listChannelConfigs(userId);
      res.json({ configs });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  app.put("/api/slack/channel-configs/:channelId", async (req, res) => {
    const { channelId } = req.params;
    const { jdText, enabled, maxAnalyze } = req.body as {
      userId?: string;
      jdText?: string;
      enabled?: boolean;
      maxAnalyze?: number;
    };
    const userId = resolveUserId(req, (req.body as { userId?: string }).userId);

    if (!channelId?.trim() || !userId || !jdText?.trim()) {
      res.status(400).json({ error: "channelId, jdText는 필수입니다. (userId는 토큰에서 추출)" });
      return;
    }

    try {
      const config = await upsertChannelConfig({
        slackChannelId: channelId.trim(),
        userId,
        jdText: jdText.trim(),
        enabled,
        maxAnalyze,
      });
      res.json({ config });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  app.delete("/api/slack/channel-configs/:channelId", async (req, res) => {
    const { channelId } = req.params;
    const userId = resolveUserId(req, typeof req.query.userId === "string" ? req.query.userId : undefined);
    if (!channelId || !userId) {
      res.status(400).json({ error: "channelId 필수, userId는 토큰에서 추출합니다." });
      return;
    }
    try {
      const deleted = await deleteChannelConfig(channelId, userId);
      res.json({ deleted });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  // 라우트 핸들러에서 던진(throw) 에러를 Sentry로 전송 — 다른 에러 핸들러보다 먼저 등록
  Sentry.setupExpressErrorHandler(app);

  return app;
}

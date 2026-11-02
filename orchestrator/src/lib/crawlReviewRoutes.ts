import express, { type Express, type Response } from "express";
import { adminPasswordGate } from "./adminAuth.js";
import {
  ConflictError,
  NotFoundError,
  applyRowAction,
  assertBatchApprovable,
  deleteBatch,
  effective,
  listBatches,
  listRows,
  prepareBatch,
  type ReviewTab,
  type RowAction,
} from "./crawlReview.js";
import { enqueueBatchApproval, getBatchApprovalStatus } from "../queue/crawlApproveQueue.js";
import { CrawlInputError, enqueueCrawlRun, getCrawlRunStatus, sanitizeCrawlRun } from "../queue/crawlRunQueue.js";

/**
 * 크롤 검수 API (web /crawling). Supabase JWT 게이트에서 빠지고, 대신 비밀번호 게이트를 탄다 (server.ts publicPaths).
 *   POST /api/admin/crawl/login                 비밀번호 확인만
 *   GET  /api/admin/crawl/batches               배치별 상태 집계
 *   POST /api/admin/crawl/batches/:id/prepare   규칙 판정 + 샘플 표시
 *   POST /api/admin/crawl/batches/:id/approve   사전 검사(409) 후 승인·병합 잡 등록 → 202 { jobId }
 *   DELETE /api/admin/crawl/batches/:id         배치 삭제 (크롤 원본만, 병합된 정본은 유지)
 *   POST /api/admin/crawl/runs                  수집 실행 { max, keyword?, listUrl?, ids?, batchId? } → 202 { jobId, batchId }
 *   GET  /api/admin/crawl/jobs/:jobId           승인·수집 잡 상태 (waiting|active|completed|failed …)
 *   GET  /api/admin/crawl/rows?batch=&tab=      exceptions | sample | all
 *   POST /api/admin/crawl/rows/:id/action       approve | reject | recrawl | reopen | edit
 */
export function registerCrawlReviewRoutes(app: Express): void {
  const router = express.Router();
  router.use(adminPasswordGate());

  const send = (res: Response, err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    const status = err instanceof NotFoundError ? 404 : err instanceof ConflictError ? 409 : 500;
    if (status === 500) {
      // DB 오류 원문(제약·컬럼 이름)은 서버 로그에만 남긴다
      console.error("[crawlReview]", message);
      res.status(500).json({ error: "서버 오류가 발생했습니다. orchestrator 로그를 확인하세요." });
      return;
    }
    res.status(status).json({ error: message });
  };

  router.post("/login", (_req, res) => {
    res.json({ ok: true });
  });

  router.get("/batches", async (_req, res) => {
    try {
      res.json({ batches: await listBatches() });
    } catch (err) {
      send(res, err);
    }
  });

  router.post("/batches/:id/prepare", async (req, res) => {
    try {
      res.json(await prepareBatch(req.params.id));
    } catch (err) {
      send(res, err);
    }
  });

  router.post("/batches/:id/approve", async (req, res) => {
    try {
      await assertBatchApprovable(req.params.id);
      const { jobId, deduped } = await enqueueBatchApproval(req.params.id);
      res.status(202).json({ jobId, deduped });
    } catch (err) {
      send(res, err);
    }
  });

  router.delete("/batches/:id", async (req, res) => {
    try {
      res.json(await deleteBatch(req.params.id));
    } catch (err) {
      send(res, err);
    }
  });

  router.post("/runs", async (req, res) => {
    try {
      const data = sanitizeCrawlRun((req.body ?? {}) as Record<string, unknown>);
      const { jobId } = await enqueueCrawlRun(data);
      res.status(202).json({ jobId, batchId: data.batchId });
    } catch (err) {
      if (err instanceof CrawlInputError) {
        res.status(400).json({ error: err.message });
        return;
      }
      send(res, err);
    }
  });

  router.get("/jobs/:jobId", async (req, res) => {
    try {
      const status = req.params.jobId.startsWith("crawl-run_")
        ? await getCrawlRunStatus(req.params.jobId)
        : await getBatchApprovalStatus(req.params.jobId);
      if (!status) {
        res.status(404).json({ error: "잡을 찾을 수 없습니다." });
        return;
      }
      res.json(status);
    } catch (err) {
      send(res, err);
    }
  });

  router.get("/rows", async (req, res) => {
    const tab = (["exceptions", "sample", "all"].includes(String(req.query.tab)) ? req.query.tab : "exceptions") as ReviewTab;
    const batchId = typeof req.query.batch === "string" && req.query.batch ? req.query.batch : undefined;
    const limit = Math.min(Number(req.query.limit) || 200, 1000);
    try {
      const rows = await listRows({ batchId, tab, limit });
      // 화면에는 원본과 수정 반영값을 같이 준다
      res.json({ rows: rows.map((r) => ({ ...r, effective: effective(r) })) });
    } catch (err) {
      send(res, err);
    }
  });

  router.post("/rows/:id/action", async (req, res) => {
    const body = req.body as RowAction | undefined;
    if (!body || typeof body.action !== "string") {
      res.status(400).json({ error: "action 필수" });
      return;
    }
    try {
      const row = await applyRowAction(req.params.id, body);
      res.json({ row: { ...row, effective: effective(row) } });
    } catch (err) {
      if (err instanceof Error && !(err instanceof NotFoundError) && !(err instanceof ConflictError) && /필드|배열|문자열|reason|비울/.test(err.message)) {
        res.status(400).json({ error: err.message });
        return;
      }
      send(res, err);
    }
  });

  app.use("/api/admin/crawl", router);
}

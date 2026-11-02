import express, { type Express, type Request, type RequestHandler, type Response } from "express";
import { adminPasswordGate } from "./adminAuth.js";
import { db } from "./db.js";
import { enqueueNormalize, enqueueRemap, enqueueSweep } from "../queue/normalizeQueue.js";

/**
 * 후보 정규화 관리 API (22 문서 E2). 크롤 검수와 같은 비밀번호 게이트 (server.ts publicPaths).
 *   POST /api/admin/candidates/normalize   { candidateIds?: string[], force?: boolean } → 202. ids 없으면 전체 sweep
 *   GET  /api/admin/candidates/normalize/stats   last_outcome 별 건수 + 미매핑 기술 상위
 *   POST /api/admin/candidates/normalize/remap   { dryRun?: boolean } → 202 { jobId }. 사전 변경 후 LLM 없이 재매핑 (F1, SQL 027)
 *        (server.ts publicPaths 정규식에 /remap 추가 필요 — 등록 요청)
 *
 * 본인 정규화 예약 (F2, 22 문서 Q2):
 *   POST /api/candidates/me/normalize   → 202. talentfolio 가 프로필·이력 저장 성공 뒤 fire-and-forget 으로 부른다.
 *        Supabase 사용자 JWT 필수 (authGate). 후보 id = 토큰 sub 만 쓰고 body 는 무시 → 남의 정규화를 예약할 수 없다.
 *        디바운스는 큐(enqueueNormalize 기본 지연 + dedup extend)가 맡는다.
 */
const MAX_IDS = 200;

export function registerCandidateNormRoutes(app: Express): void {
  const router = express.Router();
  router.use(adminPasswordGate());

  router.post("/normalize", async (req, res) => {
    try {
      const force = req.body?.force === true;
      const ids = Array.isArray(req.body?.candidateIds) ? (req.body.candidateIds as unknown[]).filter((x): x is string => typeof x === "string" && !!x) : null;
      if (ids && ids.length > MAX_IDS) {
        res.status(400).json({ error: `candidateIds 는 최대 ${MAX_IDS}개입니다.` });
        return;
      }
      if (!ids || ids.length === 0) {
        res.status(202).json({ sweepJobId: await enqueueSweep(force) });
        return;
      }
      for (const id of ids) await enqueueNormalize(id, { delayMs: 0, force });
      res.status(202).json({ enqueued: ids.length });
    } catch (err) {
      console.error("[candidateNorm]", err instanceof Error ? err.message : err);
      res.status(500).json({ error: "서버 오류가 발생했습니다. orchestrator 로그를 확인하세요." });
    }
  });

  router.get("/normalize/stats", async (_req, res) => {
    const { data, error } = await db.from("candidate_profiles_norm").select("last_outcome, unmapped_skills");
    if (error) {
      console.error("[candidateNorm] stats", error.code ?? error.message);
      res.status(500).json({ error: "서버 오류가 발생했습니다. orchestrator 로그를 확인하세요." });
      return;
    }
    const outcomes: Record<string, number> = {};
    const unmapped = new Map<string, number>();
    for (const row of (data ?? []) as { last_outcome: string; unmapped_skills: string[] }[]) {
      outcomes[row.last_outcome] = (outcomes[row.last_outcome] ?? 0) + 1;
      for (const s of row.unmapped_skills ?? []) unmapped.set(s, (unmapped.get(s) ?? 0) + 1);
    }
    res.json({
      total: data?.length ?? 0,
      outcomes,
      topUnmapped: [...unmapped.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([name, count]) => ({ name, count })),
    });
  });

  router.post("/normalize/remap", async (req, res) => {
    try {
      res.status(202).json({ jobId: await enqueueRemap(req.body?.dryRun === true) });
    } catch (err) {
      console.error("[candidateNorm] remap", err instanceof Error ? err.message : err);
      res.status(500).json({ error: "서버 오류가 발생했습니다. orchestrator 로그를 확인하세요." });
    }
  });

  app.use("/api/admin/candidates", router);
}

/** 테스트용으로 enqueue 를 주입할 수 있게 핸들러만 분리 */
export function selfNormalizeHandler(enqueue: (candidateId: string) => Promise<void> = (id) => enqueueNormalize(id)): RequestHandler {
  return async (req: Request, res: Response) => {
    // legacy 모드에서 토큰 없이 들어오면 req.auth 가 비어 있다 → 본인 확인 불가라 거절
    const userId = req.auth?.userId;
    if (!userId) {
      res.status(401).json({ error: "로그인이 필요합니다." });
      return;
    }
    try {
      await enqueue(userId);
      res.status(202).json({ queued: true });
    } catch (err) {
      // 저장은 이미 끝났다. 예약 실패는 매일 sweep 이 따라잡으므로 로그만 남긴다
      console.error("[candidateNorm] self enqueue", err instanceof Error ? err.message : err);
      res.status(503).json({ error: "정규화 예약에 실패했습니다. 나중에 자동으로 다시 처리됩니다." });
    }
  };
}

/** server.ts 에서 authGate 뒤에 등록 (publicPaths 에 넣지 말 것) */
export function registerCandidateSelfNormalizeRoutes(app: Express): void {
  app.post("/api/candidates/me/normalize", selfNormalizeHandler());
}

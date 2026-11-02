import express, { type Express } from "express";
import { adminPasswordGate } from "./adminAuth.js";
import { loadMatchQuality } from "./matchQuality.js";
import { getEffectiveWeights } from "./rankingWeights.js";

/**
 * 매칭 품질·가중치 관리자 조회 (22 문서 E6/E6b). 읽기 전용. 재계산은 주간 큐(weightsScheduler)만 — 여기서 학습하지 않는다 (헌법 2조).
 *   GET /api/admin/match/quality?from&to&company&recruiter
 *   GET /api/admin/match/weights?company&recruiter
 */
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 200) : null);

export function registerMatchQualityRoutes(app: Express): void {
  const router = express.Router();
  router.use(adminPasswordGate());

  router.get("/quality", async (req, res) => {
    const from = str(req.query.from);
    const to = str(req.query.to);
    if ((from && Number.isNaN(Date.parse(from))) || (to && Number.isNaN(Date.parse(to)))) {
      res.status(400).json({ error: "from/to 는 ISO 날짜여야 합니다." });
      return;
    }
    try {
      res.json(await loadMatchQuality({ from, to, companyId: str(req.query.company), recruiterId: str(req.query.recruiter) }));
    } catch (err) {
      console.error("[matchQuality]", err instanceof Error ? err.message : err);
      res.status(500).json({ error: "서버 오류가 발생했습니다. orchestrator 로그를 확인하세요." });
    }
  });

  router.get("/weights", async (req, res) => {
    res.json(await getEffectiveWeights({ companyId: str(req.query.company), recruiterId: str(req.query.recruiter) }));
  });

  app.use("/api/admin/match", router);
}

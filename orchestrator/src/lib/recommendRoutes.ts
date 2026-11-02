import type { Express } from "express";
import { requireUserToken } from "./auth.js";
import { db } from "./db.js";
import { Sentry } from "./sentry.js";
import { enqueueRecommend } from "../queue/recommendQueue.js";

/**
 * 구직자용 "나에게 맞는 공고" (SQL 022). JWT 필수 — 본인 추천만.
 *   GET  /api/v1/life/recommendations          저장된 추천 + 공고 요약. 재계산하지 않는다 (첫 조회만 잡 예약, SQL 023)
 *   POST /api/v1/life/recommendations/refresh  희망 조건 저장·추천 제외 직후 그 사용자만 다시 계산
 * 계산은 job-recommend 큐 워커가 한다 (헌법 2조). "내가 분석 대상이 된 공고"(/matches)와 별개.
 */
export function registerRecommendRoutes(app: Express): void {
  app.get("/api/v1/life/recommendations", async (req, res) => {
    const u = requireUserToken(req, res);
    if (!u) return;
    try {
      const [recs, run] = await Promise.all([
        db.from("job_recommendations")
          .select("job_posting_id, rank, score, reasons, computed_at, job_postings(id, company, title, location, experience_level, employment_type, salary, expires_at, deadline_type, skills, url)")
          .eq("user_id", u.userId)
          .order("rank"),
        db.from("job_recommendation_runs").select("computed_at, candidates").eq("user_id", u.userId).maybeSingle(),
      ]);
      if (recs.error || run.error) throw new Error((recs.error ?? run.error)!.message);
      // 조회는 저장본만 읽는다. 계산 이력이 없을 때만 첫 잡을 넣고, 있으면 야간 배치 대상이 되도록 viewed_at 만 남긴다
      let jobId: string | undefined;
      if (!run.data) jobId = await enqueueRecommend(u.userId);
      else {
        const seen = await db.from("job_recommendation_runs").update({ viewed_at: new Date().toISOString() }).eq("user_id", u.userId);
        if (seen.error) console.warn("[recommend] viewed_at 갱신 실패", seen.error.message);
      }
      res.json({
        recommendations: (recs.data ?? []).map((r) => ({
          rank: r.rank,
          score: r.score,
          reasons: r.reasons,
          posting: r.job_postings,
        })),
        computedAt: (run.data as { computed_at: string } | null)?.computed_at ?? null,
        candidates: (run.data as { candidates: number } | null)?.candidates ?? 0,
        jobId,
      });
    } catch (err) {
      console.error("[recommend] 조회 실패", err instanceof Error ? err.message : err);
      Sentry.captureException(err);
      res.status(500).json({ error: "추천을 불러오지 못했습니다." });
    }
  });

  app.post("/api/v1/life/recommendations/refresh", async (req, res) => {
    const u = requireUserToken(req, res);
    if (!u) return;
    try {
      res.status(202).json({ jobId: await enqueueRecommend(u.userId, true) });
    } catch (err) {
      Sentry.captureException(err);
      res.status(500).json({ error: "추천을 다시 계산하지 못했습니다." });
    }
  });
}

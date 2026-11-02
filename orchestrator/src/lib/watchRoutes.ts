import express, { type Express } from "express";
import { FORBIDDEN, isOwner } from "./auth.js";
import { db } from "./db.js";
import { getWatchRun, isMissingSchema } from "./watch.js";
import { finalizeWatchPatch, isWatchActive, parseWatchSettings, watchAccessAllowed } from "./watchCore.js";

/**
 * E7 상시 수색 설정·요약 조회 (22 문서 §8). HTTP 는 DB 읽기·설정 쓰기만 — 수색은 queue/watchQueue.ts (헌법 2조).
 *   PATCH /api/jd-runs/:id/watch   { enabled?, until?, dailyLlmCap? }
 *   GET   /api/jd-runs/:id/watch   설정 + 최근 요약(watch_digests) + 최근 hit
 * 인증: server.ts authGate 뒤에 등록. 소유자 확인은 기존 라우트와 같은 isOwner(토큰 사용자 = jd_runs.user_id).
 */
const NOT_APPLIED = { error: "상시 수색 테이블(SQL 026)이 아직 적용되지 않았습니다." } as const;
const isUuid = (s: string) => /^[0-9a-f-]{36}$/i.test(s);

export function registerWatchRoutes(app: Express): void {
  const router = express.Router();

  router.get("/:id/watch", async (req, res) => {
    const id = req.params.id;
    if (!isUuid(id)) return void res.status(400).json({ error: "잘못된 id" });
    try {
      const { applied, run } = await getWatchRun(id);
      if (!applied) return void res.status(501).json(NOT_APPLIED);
      if (!run) return void res.status(404).json({ error: "의뢰 건을 찾을 수 없습니다." });
      if (!watchAccessAllowed(run.user_id, isOwner(req, run.user_id))) return void res.status(403).json(FORBIDDEN);
      const [digests, hits] = await Promise.all([
        db.from("watch_digests").select("id, digest_date, summary, created_at").eq("jd_run_id", id).order("digest_date", { ascending: false }).limit(14),
        db.from("watch_hits").select("candidate_id, source, rank_score, stage, verdict, fit_report_id, sourcing_action_id, first_seen_at").eq("jd_run_id", id).order("first_seen_at", { ascending: false }).limit(100),
      ]);
      if (digests.error && !isMissingSchema(digests.error)) throw new Error(digests.error.message);
      if (hits.error && !isMissingSchema(hits.error)) throw new Error(hits.error.message);
      res.json({
        settings: {
          enabled: run.watch_enabled,
          until: run.watch_until,
          dailyLlmCap: run.daily_llm_cap,
          active: isWatchActive(run, Date.now()),
          scanCursor: run.scan_cursor,
          scanCompletedAt: run.scan_completed_at,
          lastDeltaCheckAt: run.watch_checked_at,
          closedAt: run.closed_at,
        },
        digests: digests.data ?? [],
        hits: hits.data ?? [],
      });
    } catch (err) {
      console.error("[watch] GET", err instanceof Error ? err.message : err);
      res.status(500).json({ error: "서버 오류가 발생했습니다. orchestrator 로그를 확인하세요." });
    }
  });

  router.patch("/:id/watch", express.json(), async (req, res) => {
    const id = req.params.id;
    if (!isUuid(id)) return void res.status(400).json({ error: "잘못된 id" });
    const now = Date.now();
    const parsed = parseWatchSettings(req.body, now);
    if (!parsed.ok) return void res.status(400).json({ error: parsed.error });
    try {
      const { applied, run } = await getWatchRun(id);
      if (!applied) return void res.status(501).json(NOT_APPLIED);
      if (!run) return void res.status(404).json({ error: "의뢰 건을 찾을 수 없습니다." });
      if (!watchAccessAllowed(run.user_id, isOwner(req, run.user_id))) return void res.status(403).json(FORBIDDEN);
      const fin = finalizeWatchPatch(parsed.patch, run, now);
      if (!fin.ok) return void res.status(409).json({ error: fin.error });
      // 처음 켤 때 delta 기준 시각을 지금으로 (과거 전체는 scan 이 훑는다)
      const patch = fin.patch.watch_enabled && !run.watch_checked_at ? { ...fin.patch, watch_checked_at: new Date(now).toISOString() } : fin.patch;
      const { data, error } = await db.from("jd_runs").update(patch).eq("id", id).select("id, watch_enabled, watch_until, daily_llm_cap").single();
      if (error) throw new Error(error.message);
      const row = data as { id: string; watch_enabled: boolean; watch_until: string | null; daily_llm_cap: number };
      console.log(`[watch] 설정 변경 run=${id} enabled=${row.watch_enabled} until=${row.watch_until} cap=${row.daily_llm_cap}`);
      res.json({ id: row.id, enabled: row.watch_enabled, until: row.watch_until, dailyLlmCap: row.daily_llm_cap });
    } catch (err) {
      console.error("[watch] PATCH", err instanceof Error ? err.message : err);
      res.status(500).json({ error: "서버 오류가 발생했습니다. orchestrator 로그를 확인하세요." });
    }
  });

  app.use("/api/jd-runs", router);
}

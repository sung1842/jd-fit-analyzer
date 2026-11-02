import { db } from "./db.js";
import { D_MIN_RANK } from "./matchEngine.js";
import {
  WATCH_DELTA_RATIO,
  WATCH_PRIORITY,
  buildDigest,
  formatDigestLog,
  harvestRun,
  runWatchCycle,
  type CycleDeps,
  type CycleResult,
  type DigestHit,
  type DigestSummary,
  type HarvestDeps,
  type WatchKind,
  type WatchRun,
  mergeDigest,
  reserveCalc,
  uncoveredCandidates,
} from "./watchCore.js";

/**
 * E7 상시 수색 — DB/Redis/큐 연결부. 로직은 watchCore.ts (순수).
 * SQL 026 미적용이면 대상 의뢰 건 조회가 실패 → 빈 목록 → 아무것도 하지 않는다 (호환).
 * Slack 은 절대 호출하지 않는다: 승인 대기는 sourcing_actions 행만 만들고(웹 /sourcing/review 에서 승인), 요약은 DB + 로그.
 */

const DELTA_PAGE = Number(process.env.WATCH_DELTA_PAGE || 2000);
const IN_CHUNK = 200;
/** 5: 사용자(헤드헌터) 단위 하루 D 잡 상한 — 의뢰 건 여러 개를 켜도 합계가 이 값을 넘지 않는다 */
export const WATCH_USER_DAILY_CAP = Number(process.env.WATCH_USER_DAILY_CAP || 100);
export function chunks<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

const RUN_COLS = "id, user_id, jd_hash, jd_text, client_name, watch_enabled, watch_until, daily_llm_cap, scan_cursor, scan_completed_at, watch_checked_at, closed_at";

export function isMissingSchema(err: { code?: string; message?: string } | null | undefined): boolean {
  if (!err) return false;
  return err.code === "42703" || err.code === "42P01" || err.code === "PGRST204" || err.code === "PGRST205" || /does not exist|could not find/i.test(err.message ?? "");
}

/** 활성 상시 수색 의뢰 건. 026 미적용이면 { applied:false, runs:[] } */
export async function listActiveWatchRuns(now = Date.now()): Promise<{ applied: boolean; runs: WatchRun[] }> {
  const { data, error } = await db
    .from("jd_runs")
    .select(RUN_COLS)
    .eq("watch_enabled", true)
    .is("closed_at", null)
    .gt("watch_until", new Date(now).toISOString());
  if (error) {
    if (isMissingSchema(error)) return { applied: false, runs: [] };
    throw new Error(`jd_runs(watch) 조회 실패: ${error.message}`);
  }
  return { applied: true, runs: (data ?? []) as WatchRun[] };
}

export async function getWatchRun(id: string): Promise<{ applied: boolean; run: WatchRun | null }> {
  const { data, error } = await db.from("jd_runs").select(RUN_COLS).eq("id", id).maybeSingle();
  if (error) {
    if (isMissingSchema(error)) return { applied: false, run: null };
    throw new Error(`jd_runs(watch) 조회 실패: ${error.message}`);
  }
  return { applied: true, run: (data as WatchRun | null) ?? null };
}

function userDayKey(userId: string, now = new Date()): string {
  return `watch:d:${now.toISOString().slice(0, 10)}:user:${userId}`;
}

function dayKey(runId: string, part: "total" | "scan", now = new Date()): string {
  return `watch:d:${now.toISOString().slice(0, 10)}:${runId}:${part}`;
}

/** total·scan 사용량을 한 번에 확인·증가 (delta·scan 워커 동시 실행에도 cap 초과 없음). watchCore.dayQuota 와 같은 규칙. */
const RESERVE_LUA = `
local t = tonumber(redis.call('get', KEYS[1]) or '0')
local s = tonumber(redis.call('get', KEYS[2]) or '0')
local u = tonumber(redis.call('get', KEYS[3]) or '0')
local cap = tonumber(ARGV[1]); local scanCap = tonumber(ARGV[2]); local want = tonumber(ARGV[3]); local isScan = ARGV[4] == '1'; local userCap = tonumber(ARGV[5])
local q = cap - t
if (userCap - u) < q then q = userCap - u end
if isScan and (scanCap - s) < q then q = scanCap - s end
if q < 0 then q = 0 end
local g = math.min(q, want)
if g > 0 then
  redis.call('incrby', KEYS[1], g); redis.call('expire', KEYS[1], 172800)
  redis.call('incrby', KEYS[3], g); redis.call('expire', KEYS[3], 172800)
  if isScan then redis.call('incrby', KEYS[2], g); redis.call('expire', KEYS[2], 172800) end
end
return g`;

export interface WatchDepsOptions {
  /** true 면 fit-analysis 잡 투입·DB 쓰기·Redis 예약을 하지 않고 로그만 (verify 스크립트용) */
  dryRun?: boolean;
  log?: (msg: string) => void;
}

export function createCycleDeps(opts: WatchDepsOptions = {}): CycleDeps & { dryRunUsed: Map<string, { total: number; scan: number }> } {
  const log = opts.log ?? ((m: string) => console.log(m));
  const dryRunUsed = new Map<string, { total: number; scan: number }>();
  return {
    dryRunUsed,
    async listAllCandidateIds() {
      const { callMcpTool } = await import("../mcp/client.js");
      const rows = await callMcpTool<{ id: string }[]>("search_candidates", {});
      return rows.map((r) => r.id);
    },
    async listChangedSince(since) {
      const { data, error } = await db.from("candidate_profiles_norm").select("candidate_id, changed_at").gt("changed_at", since).order("changed_at").limit(DELTA_PAGE);
      if (error) {
        if (isMissingSchema(error)) return { ids: [], cursor: null };
        throw new Error(`candidate_profiles_norm 조회 실패: ${error.message}`);
      }
      const rows = (data ?? []) as { candidate_id: string; changed_at: string }[];
      return { ids: rows.map((r) => r.candidate_id), cursor: rows.at(-1)?.changed_at ?? null };
    },
    async filterConsented(ids) {
      if (process.env.WATCH_REQUIRE_CONSENT !== "1") return ids;
      // 015 fit.consents(purpose='matching'). 후보 id = profiles.id = auth user id 라는 전제. 테이블이 없으면 안전하게 전원 제외.
      // 200 단위 분할. 실패하면 throw → 주기 전체 실패(진행 위치 저장 안 함, BullMQ 재시도)
      const ok = new Set<string>();
      for (const part of chunks(ids, IN_CHUNK)) {
        const { data, error } = await db.from("consents").select("user_id").eq("purpose", "matching").is("revoked_at", null).in("user_id", part);
        if (error) throw new Error(`consents 조회 실패: ${error.code ?? error.message}`);
        for (const r of (data ?? []) as { user_id: string }[]) ok.add(r.user_id);
      }
      return ids.filter((id) => ok.has(id));
    },
    async rank(run) {
      const { rankForWatch } = await import("./watchRank.js");
      return rankForWatch(run);
    },
    async loadSeen(runId) {
      const { data, error } = await db.from("watch_hits").select("candidate_id").eq("jd_run_id", runId);
      if (error) throw new Error(`watch_hits 조회 실패: ${error.message}`);
      return new Set(((data ?? []) as { candidate_id: string }[]).map((r) => r.candidate_id));
    },
    async hasReport(run, candidateId) {
      const { data, error } = await db.from("fit_reports").select("id, status").eq("candidate_id", candidateId).eq("jd_hash", run.jd_hash).neq("status", "failed").limit(1);
      if (error) throw new Error(`fit_reports 조회 실패: ${error.message}`);
      return (data ?? []).length > 0;
    },
    async reserve(run, kind, want) {
      const cap = Math.max(0, run.daily_llm_cap ?? 0);
      const scanCap = Math.floor(cap * (1 - WATCH_DELTA_RATIO));
      if (opts.dryRun) {
        const u = dryRunUsed.get(run.id) ?? { total: 0, scan: 0 };
        const userTotal = [...dryRunUsed.values()].reduce((a, v) => a + v.total, 0);
        const g = reserveCalc({ runTotal: u.total, runScan: u.scan, userTotal }, { cap, scanCap, userCap: WATCH_USER_DAILY_CAP, want, isScan: kind === "scan" });
        dryRunUsed.set(run.id, { total: u.total + g, scan: u.scan + (kind === "scan" ? g : 0) });
        return g;
      }
      const { redis } = await import("./redis.js");
      const g = Number(
        await redis.eval(RESERVE_LUA, 3, dayKey(run.id, "total"), dayKey(run.id, "scan"), userDayKey(run.user_id), cap, scanCap, want, kind === "scan" ? "1" : "0", WATCH_USER_DAILY_CAP)
      );
      if (g < want) log(`[watch] run=${run.id} ${kind} 일일 상한 도달: 요청 ${want} 중 ${g} 허용 (cap ${cap})`);
      return g;
    },
    async enqueueAnalysis(run, candidateId) {
      if (opts.dryRun) {
        log(`[watch][dry-run] fit-analysis 투입 생략 run=${run.id} candidate=${candidateId}`);
        return;
      }
      const [{ buildJobId, getQueue, removeStaleFailedJob }, { createFitReport }, { jdHash }] = await Promise.all([
        import("../queue/queues.js"),
        import("./fitReports.js"),
        import("./cache.js"),
      ]);
      const queue = getQueue("paid");
      const jobId = buildJobId(run.jd_text, candidateId);
      await removeStaleFailedJob(queue, jobId);
      await createFitReport({ jobId, jd: run.jd_text, jdHash: jdHash(run.jd_text), candidateId, userId: run.user_id });
      await queue.add("analyze-fit", { jd: run.jd_text, candidateId, userId: run.user_id, tier: "paid" }, { jobId, priority: WATCH_PRIORITY });
    },
    async recordHits(runId, hits) {
      if (opts.dryRun) {
        log(`[watch][dry-run] watch_hits 기록 생략 run=${runId} ${hits.length}명`);
        return;
      }
      const rows = hits.map((h) => ({ jd_run_id: runId, candidate_id: h.candidateId, source: h.source, rank_score: h.rankScore, stage: h.stage }));
      const { error } = await db.from("watch_hits").upsert(rows, { onConflict: "jd_run_id,candidate_id", ignoreDuplicates: true });
      if (error) throw new Error(`watch_hits 기록 실패: ${error.message}`);
    },
    async saveProgress(runId, patch) {
      if (opts.dryRun) return;
      const { error } = await db.from("jd_runs").update(patch).eq("id", runId);
      if (error) throw new Error(`jd_runs(watch) 진행 저장 실패: ${error.message}`);
    },
  };
}

export function createHarvestDeps(): HarvestDeps {
  return {
    async loadAnalyzingHits(runId) {
      const { data, error } = await db.from("watch_hits").select("candidate_id").eq("jd_run_id", runId).eq("stage", "analyzing");
      if (error) throw new Error(`watch_hits 조회 실패: ${error.message}`);
      return ((data ?? []) as { candidate_id: string }[]).map((r) => ({ candidateId: r.candidate_id }));
    },
    async getReport(run, candidateId) {
      const { getFitReportByCandidateAndJdHash } = await import("./fitReports.js");
      const r = await getFitReportByCandidateAndJdHash(candidateId, run.jd_hash);
      if (!r) return null;
      return { id: r.id, status: r.status, verdict: r.report?.verdict ?? null, candidateName: r.candidateName ?? r.report?.candidateName ?? null, overallScore: r.report?.overallScore ?? null };
    },
    async createApproval(run, strongIn) {
      let strong = strongIn;
      // 기존 HIL 흐름(sourcing_actions pending → /sourcing/review 승인)에 넣되 Slack 승인 요청은 보내지 않는다.
      // autoSourcingFromJd/createSourcingWithApproval 은 notify_slack_approval 을 항상 호출하므로 재사용하지 않고 행만 만든다.
      const { createSourcingAction } = await import("./sourcingActions.js");
      // 6: 재시도(markHits 실패 후) 중복 방지 — 이 의뢰 건의 기존 상시 수색 승인 건에 이미 실린 후보는 다시 만들지 않는다
      const { data: prev, error: prevErr } = await db.from("sourcing_actions").select("id, payload").eq("type", "slack_notify").eq("payload->>jdRunId", run.id).eq("payload->>autoSource", "watch");
      if (prevErr) throw new Error(`sourcing_actions 조회 실패: ${prevErr.message}`);
      const existing = ((prev ?? []) as { id: string; payload: { candidateIds?: string[] } }[]).map((a) => ({ id: a.id, candidateIds: a.payload?.candidateIds ?? [] }));
      const { covered, uncovered } = uncoveredCandidates(existing, strong.map((s) => s.candidateId));
      strong = strong.filter((s) => uncovered.includes(s.candidateId));
      if (strong.length === 0) return covered;
      const names = strong.map((s) => s.report.candidateName ?? s.candidateId);
      const head = (run.jd_text.split("\n").find((l) => l.trim()) ?? "").trim().slice(0, 80);
      const action = await createSourcingAction({
        type: "slack_notify",
        userId: run.user_id,
        payload: {
          channel: process.env.WATCH_SOURCING_CHANNEL || process.env.SLACK_DEFAULT_CHANNEL || "#recruiting",
          text: `[상시 수색] ${head} — strong_fit ${strong.length}명: ${names.join(", ")}`,
          candidateIds: strong.map((s) => s.candidateId),
          candidateNames: names,
          jdHash: run.jd_hash,
          jdHeadline: head,
          jdRunId: run.id,
          autoSource: "watch",
        },
      });
      console.log(`[watch] run=${run.id} strong_fit ${strong.length}명 → 승인 대기 sourcing_action ${action.id} (Slack 발송 없음)`);
      return { ...covered, ...Object.fromEntries(strong.map((s) => [s.candidateId, action.id])) };
    },
    async markHits(runId, updates) {
      for (const u of updates) {
        const { error } = await db
          .from("watch_hits")
          .update({ stage: u.stage, verdict: u.verdict, fit_report_id: u.fitReportId, sourcing_action_id: u.sourcingActionId, updated_at: new Date().toISOString() })
          .eq("jd_run_id", runId)
          .eq("candidate_id", u.candidateId)
          .eq("stage", "analyzing");
        if (error) throw new Error(`watch_hits 갱신 실패: ${error.message}`);
      }
    },
  };
}

/** 의뢰 건 1개 × 종류 1개 처리 (워커에서 호출). 실행 시점에 다시 읽어 만료·마감을 확인한다. */
export async function processWatchRun(runId: string, kind: WatchKind, opts: WatchDepsOptions = {}): Promise<CycleResult & { harvested?: number }> {
  const { run } = await getWatchRun(runId);
  if (!run) return { runId, kind, skipped: "inactive", targets: 0, qualified: 0, reused: 0, enqueued: 0, overCap: 0 };
  const result = await runWatchCycle(run, kind, createCycleDeps(opts), { now: Date.now(), minRank: D_MIN_RANK });
  // 수확은 delta 주기에서만 (중복 생성 방지 — 같은 hit 를 두 워커가 동시에 수확하지 않게)
  // 7: 만료·마감 후에도 분석 중이던 hit 는 수확한다
  if (kind === "delta" && !opts.dryRun) {
    const h = await harvestRun(run, createHarvestDeps());
    return { ...result, harvested: h.done };
  }
  return result;
}

/** 하루 1회 요약: 요약에 아직 안 실린 hit → watch_digests 저장 + 로그. 만료된 건도 마지막 hit 는 요약한다. */
export async function runDailyDigest(now = new Date()): Promise<{ applied: boolean; digests: DigestSummary[] }> {
  const { data, error } = await db.from("watch_hits").select("jd_run_id, candidate_id, source, rank_score, stage, verdict, sourcing_action_id").is("notified_digest_id", null);
  if (error) {
    if (isMissingSchema(error)) return { applied: false, digests: [] };
    throw new Error(`watch_hits 조회 실패: ${error.message}`);
  }
  const byRun = new Map<string, DigestHit[]>();
  for (const r of (data ?? []) as (DigestHit & { jd_run_id: string })[]) byRun.set(r.jd_run_id, [...(byRun.get(r.jd_run_id) ?? []), r]);
  const date = now.toISOString().slice(0, 10);
  const out: DigestSummary[] = [];
  for (const [runId, hits] of byRun) {
    const summary = buildDigest(runId, date, hits);
    if (!summary) continue;
    // 9: 같은 날 재실행은 기존 요약에 병합 (덮어쓰기 금지)
    const { data: old, error: oldErr } = await db.from("watch_digests").select("summary").eq("jd_run_id", runId).eq("digest_date", date).maybeSingle();
    if (oldErr) throw new Error(`watch_digests 조회 실패: ${oldErr.message}`);
    const merged = mergeDigest((old as { summary: DigestSummary } | null)?.summary ?? null, summary);
    const { data: row, error: insErr } = await db
      .from("watch_digests")
      .upsert({ jd_run_id: runId, digest_date: date, summary: merged }, { onConflict: "jd_run_id,digest_date" })
      .select("id")
      .single();
    if (insErr) throw new Error(`watch_digests 저장 실패: ${insErr.message}`);
    for (const part of chunks(hits.map((h) => h.candidate_id), IN_CHUNK)) {
      const { error: updErr } = await db.from("watch_hits").update({ notified_digest_id: (row as { id: string }).id }).eq("jd_run_id", runId).in("candidate_id", part).is("notified_digest_id", null);
      if (updErr) throw new Error(`watch_hits 요약 표시 실패: ${updErr.message}`);
    }
    console.log(formatDigestLog(merged));
    out.push(merged);
  }
  return { applied: true, digests: out };
}

/** 7: 분석 중 hit 가 남은 의뢰 건 (만료·마감 후 수확용) */
export async function listRunsWithPendingHits(): Promise<string[]> {
  const { data, error } = await db.from("watch_hits").select("jd_run_id").eq("stage", "analyzing").limit(5000);
  if (error) {
    if (isMissingSchema(error)) return [];
    throw new Error(`watch_hits 조회 실패: ${error.message}`);
  }
  return [...new Set(((data ?? []) as { jd_run_id: string }[]).map((r) => r.jd_run_id))];
}

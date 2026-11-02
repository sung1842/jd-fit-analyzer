/**
 * 22 문서 §6.5 E7 상시 수색 — 순수 로직 (DB·Redis·LLM 없음, 의존성은 인자로 주입).
 * DB 연결 구현은 lib/watch.ts, 큐는 queue/watchQueue.ts.
 *
 * 한 주기(cycle) = 의뢰 건 1개 × 종류 1개(delta|scan):
 *   대상 후보 고르기 → A~C 순위(buildJdPlan 재사용) → rank ≥ D_MIN_RANK & 미처리(watch_hits 없음)
 *   → 이미 같은 (jd, 후보) 리포트가 있으면 재사용(LLM 0) → 없으면 일일 상한 안에서만 fit-analysis 잡 투입 → watch_hits 기록.
 * 수확(harvest) = 분석이 끝난 hit 중 strong_fit 을 sourcing_actions 승인 대기로 (Slack 발송 없음). hit 행이 있어 (의뢰 건, 후보)당 1회.
 */

export const WATCH_DELTA_RATIO = clampRatio(Number(process.env.WATCH_DELTA_RATIO ?? 0.7));
export const SCAN_BATCH = Math.max(1, Number(process.env.SCAN_BATCH || 500));
/** 상시 수색 잡 priority (즉시 매칭 paid=1/free=2 보다 뒤) */
export const WATCH_PRIORITY = 10;
/** 설정 API 가 허용하는 일일 상한 최대값 / 최대 기간 */
export const WATCH_MAX_DAILY_CAP = Number(process.env.WATCH_MAX_DAILY_CAP || 100);
export const WATCH_MAX_DAYS = Number(process.env.WATCH_MAX_DAYS || 90);

function clampRatio(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.7;
}

export type WatchKind = "delta" | "scan";

export interface WatchRun {
  id: string;
  user_id: string;
  jd_hash: string;
  jd_text: string;
  client_name: string | null;
  watch_enabled: boolean;
  watch_until: string | null;
  daily_llm_cap: number;
  scan_cursor: string | null;
  scan_completed_at: string | null;
  watch_checked_at: string | null;
  closed_at: string | null;
}

/** 대상 = watch_enabled and now() < watch_until and closed_at is null */
export function isWatchActive(run: Pick<WatchRun, "watch_enabled" | "watch_until" | "closed_at">, now: number): boolean {
  if (!run.watch_enabled || run.closed_at) return false;
  if (!run.watch_until) return false;
  const until = Date.parse(run.watch_until);
  return Number.isFinite(until) && now < until;
}

/**
 * 오늘 남은 D 단계 할당. scan 은 cap×(1−ratio) 까지만, delta 는 scan 이 쓰지 않은 나머지 전부 (delta 우선).
 * 합계는 항상 cap 이하.
 */
export function dayQuota(cap: number, ratio: number, used: { delta: number; scan: number }, kind: WatchKind): number {
  const c = Math.max(0, Math.floor(cap));
  const left = Math.max(0, c - used.delta - used.scan);
  if (kind === "delta") return left;
  const scanCap = Math.floor(c * (1 - clampRatio(ratio)));
  return Math.max(0, Math.min(left, scanCap - used.scan));
}

/** scan 커서: 정렬된 id 에서 cursor 다음부터 n 명. 끝까지 가면 completed (한 바퀴 → 이후 delta 만) */
export function selectScanBatch(sortedIds: string[], cursor: string | null, n: number): { batch: string[]; nextCursor: string | null; completed: boolean } {
  const start = cursor == null ? 0 : sortedIds.findIndex((id) => id > cursor);
  if (start < 0 || start >= sortedIds.length) return { batch: [], nextCursor: cursor, completed: true };
  const batch = sortedIds.slice(start, start + n);
  const completed = start + n >= sortedIds.length;
  return { batch, nextCursor: batch[batch.length - 1] ?? cursor, completed };
}

export interface RankedLite {
  id: string;
  rankScore: number;
}

/** 대상 집합 ∩ 순위 결과 중 rank ≥ minRank, 이미 본(hit) 후보 제외, 점수 내림차순 */
export function pickCandidates(ranked: RankedLite[], targets: Set<string>, seen: Set<string>, minRank: number): RankedLite[] {
  return ranked
    .filter((r) => targets.has(r.id) && !seen.has(r.id) && r.rankScore >= minRank)
    .sort((a, b) => b.rankScore - a.rankScore || a.id.localeCompare(b.id));
}

export interface HitInput {
  candidateId: string;
  rankScore: number;
  source: WatchKind;
  /** analyzing = D 잡 투입 또는 기존 리포트 재사용 대기 */
  stage: "analyzing";
}

export interface CycleDeps {
  /** scan: 전체 후보 id (정렬은 여기서 한다) */
  listAllCandidateIds(): Promise<string[]>;
  /** delta: changed_at > since 인 후보 id */
  /** changed_at > since 인 후보 (changed_at 오름차순, 한 페이지). cursor = 마지막 행 changed_at (keyset), 없으면 null */
  listChangedSince(since: string): Promise<{ ids: string[]; cursor: string | null }>;
  /** 개인정보: 매칭 동의 필터 (설정에 따라 그대로 통과) */
  filterConsented(ids: string[]): Promise<string[]>;
  /** A~C 순위 (buildJdPlan 재사용) */
  rank(run: WatchRun): Promise<RankedLite[]>;
  /** 이 의뢰 건에서 이미 hit 로 기록된 후보 */
  loadSeen(runId: string): Promise<Set<string>>;
  /** 같은 (jd, 후보) 리포트가 이미 있으면 true → LLM 없이 재사용 */
  hasReport(run: WatchRun, candidateId: string): Promise<boolean>;
  /** 오늘 사용량 원자적 예약. want 중 실제 허용된 수를 돌려준다 */
  reserve(run: WatchRun, kind: WatchKind, want: number): Promise<number>;
  enqueueAnalysis(run: WatchRun, candidateId: string): Promise<void>;
  /** (jd_run_id, candidate_id) 충돌은 무시 (1회만) */
  recordHits(runId: string, hits: HitInput[]): Promise<void>;
  saveProgress(runId: string, patch: Partial<Pick<WatchRun, "scan_cursor" | "scan_completed_at" | "watch_checked_at">>): Promise<void>;
}

export interface CycleResult {
  runId: string;
  kind: WatchKind;
  skipped?: "inactive" | "scan_done" | "no_targets";
  targets: number;
  qualified: number;
  reused: number;
  enqueued: number;
  overCap: number;
}

export async function runWatchCycle(run: WatchRun, kind: WatchKind, deps: CycleDeps, opts: { now: number; minRank: number; scanBatch?: number }): Promise<CycleResult> {
  const base: CycleResult = { runId: run.id, kind, targets: 0, qualified: 0, reused: 0, enqueued: 0, overCap: 0 };
  if (!isWatchActive(run, opts.now)) return { ...base, skipped: "inactive" };
  const nowIso = new Date(opts.now).toISOString();

  let targetIds: string[];
  let progress: Parameters<CycleDeps["saveProgress"]>[1];
  if (kind === "scan") {
    if (run.scan_completed_at) return { ...base, skipped: "scan_done" };
    const all = [...new Set(await deps.listAllCandidateIds())].sort();
    const sel = selectScanBatch(all, run.scan_cursor, opts.scanBatch ?? SCAN_BATCH);
    targetIds = sel.batch;
    progress = { scan_cursor: sel.nextCursor, ...(sel.completed && { scan_completed_at: nowIso }) };
  } else {
    // 첫 주기는 지금부터의 변경만 (과거 전체는 scan 이 맡는다)
    if (!run.watch_checked_at) {
      // 첫 주기는 지금부터의 변경만 (과거 전체는 scan 이 맡는다)
      targetIds = [];
      progress = { watch_checked_at: nowIso };
    } else {
      const page = await deps.listChangedSince(run.watch_checked_at);
      targetIds = page.ids;
      // keyset: 읽은 마지막 행까지만 전진 (now 로 건너뛰면 limit 밖 변경이 유실된다)
      progress = page.cursor ? { watch_checked_at: page.cursor } : {};
    }
  }

  targetIds = targetIds.length ? await deps.filterConsented(targetIds) : [];
  if (targetIds.length === 0) {
    if (Object.keys(progress).length) await deps.saveProgress(run.id, progress);
    return { ...base, skipped: "no_targets" };
  }

  const [ranked, seen] = await Promise.all([deps.rank(run), deps.loadSeen(run.id)]);
  const picked = pickCandidates(ranked, new Set(targetIds), seen, opts.minRank);
  const hits: HitInput[] = [];
  const need: RankedLite[] = [];
  let reused = 0;
  for (const p of picked) {
    if (await deps.hasReport(run, p.id)) {
      hits.push({ candidateId: p.id, rankScore: p.rankScore, source: kind, stage: "analyzing" });
      reused++;
    } else need.push(p);
  }
  const granted = need.length ? await deps.reserve(run, kind, need.length) : 0;
  const go = need.slice(0, granted);
  for (const p of go) {
    await deps.enqueueAnalysis(run, p.id);
    hits.push({ candidateId: p.id, rankScore: p.rankScore, source: kind, stage: "analyzing" });
  }
  if (hits.length) await deps.recordHits(run.id, hits);
  const overCap = need.length - go.length;
  // 상한 때문에 못 넣은 후보가 있으면 커서·기준 시각을 전진하지 않는다 → 다음 날 같은 범위를 다시 보고, 이미 넣은 후보는 hit 로 제외
  if (overCap === 0) await deps.saveProgress(run.id, progress);
  return { ...base, targets: targetIds.length, qualified: picked.length, reused, enqueued: go.length, overCap };
}

// ── 수확: 분석 끝난 hit → strong_fit 은 승인 대기 1건으로 ──────────────────────

export interface PendingHit {
  candidateId: string;
}
export interface ReportLite {
  id: string;
  status: string;
  verdict: string | null;
  candidateName: string | null;
  overallScore: number | null;
}
export interface HarvestDeps {
  loadAnalyzingHits(runId: string): Promise<PendingHit[]>;
  getReport(run: WatchRun, candidateId: string): Promise<ReportLite | null>;
  /** 승인 대기 sourcing_actions 생성 (Slack 발송 없음). action id 반환 */
  /** 승인 대기 생성. 재시도 시 이미 승인 대기에 실린 후보는 새로 만들지 않는다 (uncoveredCandidates). 후보 → action id */
  createApproval(run: WatchRun, strong: { candidateId: string; report: ReportLite }[]): Promise<Record<string, string>>;
  markHits(runId: string, updates: { candidateId: string; stage: "analyzed" | "failed"; verdict: string | null; fitReportId: string | null; sourcingActionId: string | null }[]): Promise<void>;
}

const DONE = new Set(["completed", "pending_review", "approved", "rejected"]);
const DECIDED = new Set(["approved", "rejected"]);

export async function harvestRun(run: WatchRun, deps: HarvestDeps): Promise<{ done: number; strong: number; actionId: string | null }> {
  const hits = await deps.loadAnalyzingHits(run.id);
  const finished: { candidateId: string; report: ReportLite | null; failed: boolean }[] = [];
  for (const h of hits) {
    const r = await deps.getReport(run, h.candidateId);
    if (!r) continue;
    if (r.status === "failed") finished.push({ candidateId: h.candidateId, report: r, failed: true });
    else if (DONE.has(r.status)) finished.push({ candidateId: h.candidateId, report: r, failed: false });
  }
  if (finished.length === 0) return { done: 0, strong: 0, actionId: null };
  // 이미 사람이 승인/거절한 리포트(즉시 매칭에서 처리됨)는 다시 승인 요청하지 않는다
  const strong = finished.filter((f) => !f.failed && f.report?.verdict === "strong_fit" && !DECIDED.has(f.report.status)).map((f) => ({ candidateId: f.candidateId, report: f.report! }));
  const actionIds = strong.length ? await deps.createApproval(run, strong) : {};
  const actionId = Object.values(actionIds)[0] ?? null;
  const strongIds = new Set(strong.map((s) => s.candidateId));
  await deps.markHits(
    run.id,
    finished.map((f) => ({
      candidateId: f.candidateId,
      stage: f.failed ? "failed" : "analyzed",
      verdict: f.report?.verdict ?? null,
      fitReportId: f.report?.id ?? null,
      sourcingActionId: strongIds.has(f.candidateId) ? actionIds[f.candidateId] ?? null : null,
    }))
  );
  return { done: finished.length, strong: strong.length, actionId };
}

// ── 하루 1회 요약 ─────────────────────────────────────────────────────────

export interface DigestHit {
  candidate_id: string;
  source: WatchKind;
  rank_score: number;
  stage: string;
  verdict: string | null;
  sourcing_action_id: string | null;
}
export interface DigestSummary {
  jdRunId: string;
  date: string;
  newHits: number;
  bySource: Record<WatchKind, number>;
  analyzing: number;
  analyzed: number;
  failed: number;
  strongFit: number;
  pendingApprovals: string[];
  top: { candidateId: string; rankScore: number; verdict: string | null }[];
}

/** 아직 요약에 안 실린 hit 들로 요약 생성. 없으면 null (빈 요약 저장 안 함) */
export function buildDigest(runId: string, date: string, hits: DigestHit[]): DigestSummary | null {
  if (hits.length === 0) return null;
  const count = (f: (h: DigestHit) => boolean) => hits.filter(f).length;
  return {
    jdRunId: runId,
    date,
    newHits: hits.length,
    bySource: { delta: count((h) => h.source === "delta"), scan: count((h) => h.source === "scan") },
    analyzing: count((h) => h.stage === "analyzing"),
    analyzed: count((h) => h.stage === "analyzed"),
    failed: count((h) => h.stage === "failed"),
    strongFit: count((h) => h.verdict === "strong_fit"),
    pendingApprovals: [...new Set(hits.map((h) => h.sourcing_action_id).filter((x): x is string => !!x))],
    top: [...hits].sort((a, b) => Number(b.rank_score) - Number(a.rank_score)).slice(0, 5).map((h) => ({ candidateId: h.candidate_id, rankScore: Number(h.rank_score), verdict: h.verdict })),
  };
}

export function formatDigestLog(s: DigestSummary): string {
  return `[watch] 요약 ${s.date} run=${s.jdRunId} 신규 ${s.newHits}(delta ${s.bySource.delta}/scan ${s.bySource.scan}) 분석중 ${s.analyzing} 완료 ${s.analyzed} 실패 ${s.failed} strong_fit ${s.strongFit} 승인대기 ${s.pendingApprovals.length}건`;
}

// ── 설정 PATCH 검증 ────────────────────────────────────────────────────────

export type WatchSettingsPatch = { watch_enabled?: boolean; watch_until?: string | null; daily_llm_cap?: number };

export function parseWatchSettings(body: unknown, now: number): { ok: true; patch: WatchSettingsPatch } | { ok: false; error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const patch: WatchSettingsPatch = {};
  if (b.enabled !== undefined) {
    if (typeof b.enabled !== "boolean") return { ok: false, error: "enabled 는 boolean 이어야 합니다." };
    patch.watch_enabled = b.enabled;
  }
  if (b.until !== undefined) {
    if (b.until === null) patch.watch_until = null;
    else {
      const t = typeof b.until === "string" ? Date.parse(b.until) : NaN;
      if (!Number.isFinite(t)) return { ok: false, error: "until 은 ISO 날짜여야 합니다." };
      if (t <= now) return { ok: false, error: "until 은 미래여야 합니다." };
      if (t > now + WATCH_MAX_DAYS * 86_400_000) return { ok: false, error: `until 은 ${WATCH_MAX_DAYS}일 이내여야 합니다.` };
      patch.watch_until = new Date(t).toISOString();
    }
  }
  if (b.dailyLlmCap !== undefined) {
    const n = b.dailyLlmCap;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > WATCH_MAX_DAILY_CAP) return { ok: false, error: `dailyLlmCap 은 0~${WATCH_MAX_DAILY_CAP} 정수여야 합니다.` };
    patch.daily_llm_cap = n;
  }
  if (Object.keys(patch).length === 0) return { ok: false, error: "enabled·until·dailyLlmCap 중 하나 이상 필요합니다." };
  return { ok: true, patch };
}

/** 켜는데 기간이 없거나 지났으면 기본 30일 (무기한 금지). 마감된 건은 켤 수 없다. */
export function finalizeWatchPatch(patch: WatchSettingsPatch, current: Pick<WatchRun, "watch_until" | "closed_at">, now: number): { ok: true; patch: WatchSettingsPatch } | { ok: false; error: string } {
  if (patch.watch_enabled !== true) return { ok: true, patch };
  if (current.closed_at) return { ok: false, error: "마감된 의뢰 건은 상시 수색을 켤 수 없습니다." };
  const until = patch.watch_until !== undefined ? patch.watch_until : current.watch_until;
  if (!until || Date.parse(until) <= now) return { ok: true, patch: { ...patch, watch_until: new Date(now + 30 * 86_400_000).toISOString() } };
  return { ok: true, patch };
}

/** 6: 이미 이 의뢰 건의 상시 수색 승인 대기에 실린 후보 → action id. 나머지(uncovered)만 새로 만든다 */
export function uncoveredCandidates(existing: { id: string; candidateIds: string[] }[], ids: string[]): { covered: Record<string, string>; uncovered: string[] } {
  const covered: Record<string, string> = {};
  for (const a of existing) for (const c of a.candidateIds) if (ids.includes(c) && !covered[c]) covered[c] = a.id;
  return { covered, uncovered: ids.filter((c) => !covered[c]) };
}

/** 5: Redis Lua RESERVE 와 같은 규칙 (테스트용 기준 구현). run total·scan + 사용자 total */
export function reserveCalc(used: { runTotal: number; runScan: number; userTotal: number }, a: { cap: number; scanCap: number; userCap: number; want: number; isScan: boolean }): number {
  let q = Math.min(a.cap - used.runTotal, a.userCap - used.userTotal);
  if (a.isScan) q = Math.min(q, a.scanCap - used.runScan);
  return Math.max(0, Math.min(q, a.want));
}

/** 7: tick 대상 — 활성 건은 delta(+scan 미완료면 scan), 비활성인데 분석 중 hit 가 남은 건은 delta(수확만) */
export function tickPlan(active: Pick<WatchRun, "id" | "scan_completed_at">[], pendingRunIds: string[]): { runId: string; kind: WatchKind }[] {
  const out: { runId: string; kind: WatchKind }[] = [];
  const ids = new Set<string>();
  for (const r of active) {
    ids.add(r.id);
    out.push({ runId: r.id, kind: "delta" });
    if (!r.scan_completed_at) out.push({ runId: r.id, kind: "scan" });
  }
  for (const id of new Set(pendingRunIds)) if (!ids.has(id)) out.push({ runId: id, kind: "delta" });
  return out;
}

/** 8: 소유자 없는 의뢰 건은 접근 거부 */
export function watchAccessAllowed(runUserId: string | null | undefined, ownerOk: boolean): boolean {
  return !!runUserId && ownerOk;
}

/** 9: 같은 날 요약 재실행 시 병합 (덮어쓰기 금지) */
export function mergeDigest(prev: DigestSummary | null, next: DigestSummary): DigestSummary {
  if (!prev) return next;
  const top = [...prev.top, ...next.top.filter((t) => !prev.top.some((p) => p.candidateId === t.candidateId))].sort((a, b) => b.rankScore - a.rankScore).slice(0, 5);
  return {
    ...next,
    newHits: prev.newHits + next.newHits,
    bySource: { delta: prev.bySource.delta + next.bySource.delta, scan: prev.bySource.scan + next.bySource.scan },
    analyzing: prev.analyzing + next.analyzing,
    analyzed: prev.analyzed + next.analyzed,
    failed: prev.failed + next.failed,
    strongFit: prev.strongFit + next.strongFit,
    pendingApprovals: [...new Set([...prev.pendingApprovals, ...next.pendingApprovals])],
    top,
  };
}

/** 1: 상시 수색 승인 건은 Slack 발송 없이 상태만 바꾼다 (server.ts reviewSourcingAction 에서 호출 — 등록 요청) */
export function isWatchNoSend(payload: { autoSource?: string } | null | undefined): boolean {
  return payload?.autoSource === "watch" && process.env.WATCH_APPROVAL_SEND_SLACK !== "1";
}

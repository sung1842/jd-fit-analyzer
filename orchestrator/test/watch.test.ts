/** E7 상시 수색(watchCore) 테스트: 가짜 의존성, DB·Redis·LLM 없음 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  buildDigest,
  dayQuota,
  finalizeWatchPatch,
  isWatchNoSend,
  mergeDigest,
  reserveCalc,
  tickPlan,
  uncoveredCandidates,
  watchAccessAllowed,
  harvestRun,
  isWatchActive,
  parseWatchSettings,
  runWatchCycle,
  selectScanBatch,
  type CycleDeps,
  type HarvestDeps,
  type HitInput,
  type ReportLite,
  type WatchRun,
} from "../src/lib/watchCore.js";

const NOW = Date.parse("2026-10-30T00:00:00Z");
const run = (o: Partial<WatchRun> = {}): WatchRun => ({
  id: "r1",
  user_id: "u1",
  jd_hash: "h1",
  jd_text: "jd",
  client_name: null,
  watch_enabled: true,
  watch_until: "2026-11-30T00:00:00Z",
  daily_llm_cap: 10,
  scan_cursor: null,
  scan_completed_at: null,
  watch_checked_at: "2026-10-29T00:00:00Z",
  closed_at: null,
  ...o,
});

/** 메모리 가짜: 후보 c01..cNN 전원 rank 80, Redis 예약은 dayQuota 규칙 */
function fakeDeps(o: { all?: string[]; changed?: string[]; scores?: Record<string, number>; reports?: Set<string>; ratio?: number } = {}) {
  const all = o.all ?? Array.from({ length: 12 }, (_, i) => `c${String(i + 1).padStart(2, "0")}`);
  const hits = new Map<string, HitInput>();
  const enqueued: string[] = [];
  const used = { delta: 0, scan: 0 };
  const progress: Record<string, unknown>[] = [];
  const state = { run: null as WatchRun | null };
  const deps: CycleDeps = {
    listAllCandidateIds: async () => [...all].reverse(),
    listChangedSince: async () => ({ ids: o.changed ?? [], cursor: o.changed?.length ? "2026-10-29T12:00:00Z" : null }),
    filterConsented: async (ids) => ids,
    rank: async () => all.map((id) => ({ id, rankScore: o.scores?.[id] ?? 80 })),
    loadSeen: async () => new Set(hits.keys()),
    hasReport: async (_r, id) => o.reports?.has(id) ?? false,
    reserve: async (r, kind, want) => {
      const g = Math.min(want, dayQuota(r.daily_llm_cap, o.ratio ?? 0.7, used, kind));
      used[kind] += g;
      return g;
    },
    enqueueAnalysis: async (_r, id) => void enqueued.push(id),
    recordHits: async (_id, hs) => {
      for (const h of hs) if (!hits.has(h.candidateId)) hits.set(h.candidateId, h);
    },
    saveProgress: async (_id, p) => {
      progress.push(p);
      if (state.run) Object.assign(state.run, p);
    },
  };
  return { deps, hits, enqueued, used, progress, state };
}

const opts = { now: NOW, minRank: 60, scanBatch: 5 };

describe("watch 대상", () => {
  test("만료·마감·꺼짐·기간 없음은 제외", () => {
    assert.equal(isWatchActive(run(), NOW), true);
    assert.equal(isWatchActive(run({ watch_until: "2026-10-29T00:00:00Z" }), NOW), false);
    assert.equal(isWatchActive(run({ closed_at: "2026-10-29T00:00:00Z" }), NOW), false);
    assert.equal(isWatchActive(run({ watch_enabled: false }), NOW), false);
    assert.equal(isWatchActive(run({ watch_until: null }), NOW), false);
  });

  test("만료 건은 주기에서 아무것도 안 함 (잡·진행 저장 없음)", async () => {
    const f = fakeDeps({ changed: ["c01"] });
    const r = await runWatchCycle(run({ watch_until: "2026-10-01T00:00:00Z" }), "delta", f.deps, opts);
    assert.equal(r.skipped, "inactive");
    assert.equal(f.enqueued.length, 0);
    assert.equal(f.progress.length, 0);
  });
});

describe("일일 상한 (T9)", () => {
  test("dayQuota: delta 우선, scan 은 30% 까지, 합계 ≤ cap", () => {
    assert.equal(dayQuota(10, 0.7, { delta: 0, scan: 0 }, "scan"), 3);
    assert.equal(dayQuota(10, 0.7, { delta: 0, scan: 0 }, "delta"), 10);
    assert.equal(dayQuota(10, 0.7, { delta: 0, scan: 3 }, "delta"), 7);
    assert.equal(dayQuota(10, 0.7, { delta: 9, scan: 0 }, "scan"), 1);
    assert.equal(dayQuota(10, 0.7, { delta: 7, scan: 3 }, "delta"), 0);
    assert.equal(dayQuota(0, 0.7, { delta: 0, scan: 0 }, "delta"), 0);
  });

  test("T9: 상한 초과분은 D 잡이 생성되지 않는다", async () => {
    const f = fakeDeps({ changed: ["c01", "c02", "c03", "c04", "c05"] });
    const r1 = await runWatchCycle(run({ daily_llm_cap: 2 }), "delta", f.deps, opts);
    assert.equal(r1.enqueued, 2);
    assert.equal(r1.overCap, 3);
    assert.equal(f.enqueued.length, 2);
    // 같은 날 다시 — 상한 소진이라 0
    const f2changed = fakeDeps({ changed: ["c06", "c07"] });
    f2changed.used.delta = 2;
    const r2 = await runWatchCycle(run({ daily_llm_cap: 2 }), "delta", f2changed.deps, opts);
    assert.equal(r2.enqueued, 0);
    assert.equal(f2changed.enqueued.length, 0);
    assert.equal(f2changed.hits.size, 0);
  });

  test("이미 리포트가 있는 후보는 상한을 쓰지 않고 재사용", async () => {
    const f = fakeDeps({ changed: ["c01", "c02"], reports: new Set(["c01"]) });
    const r = await runWatchCycle(run({ daily_llm_cap: 1 }), "delta", f.deps, opts);
    assert.equal(r.reused, 1);
    assert.equal(r.enqueued, 1);
    assert.deepEqual(f.enqueued, ["c02"]);
    assert.equal(f.hits.size, 2);
  });

  test("rank < D_MIN_RANK 는 투입·기록 안 함", async () => {
    const f = fakeDeps({ changed: ["c01", "c02"], scores: { c01: 59.9 } });
    await runWatchCycle(run(), "delta", f.deps, opts);
    assert.deepEqual(f.enqueued, ["c02"]);
  });
});

describe("중복 방지", () => {
  test("같은 후보가 다시 바뀌어도 (의뢰 건, 후보) 1회만", async () => {
    const f = fakeDeps({ changed: ["c01"] });
    await runWatchCycle(run(), "delta", f.deps, opts);
    await runWatchCycle(run(), "delta", f.deps, opts);
    await runWatchCycle(run(), "scan", f.deps, opts);
    assert.equal(f.enqueued.filter((x) => x === "c01").length, 1);
  });

  test("수확: strong_fit 승인 대기 1건, 다시 수확해도 새로 안 만든다", async () => {
    const stage = new Map<string, string>([["c01", "analyzing"], ["c02", "analyzing"], ["c03", "analyzing"], ["c04", "analyzing"]]);
    const reports: Record<string, ReportLite | null> = {
      c01: { id: "f1", status: "completed", verdict: "strong_fit", candidateName: "가", overallScore: 90 },
      c02: { id: "f2", status: "completed", verdict: "weak_fit", candidateName: "나", overallScore: 40 },
      c03: { id: "f3", status: "processing", verdict: null, candidateName: null, overallScore: null },
      c04: { id: "f4", status: "rejected", verdict: "strong_fit", candidateName: "라", overallScore: 88 },
    };
    const approvals: string[][] = [];
    const deps: HarvestDeps = {
      loadAnalyzingHits: async () => [...stage].filter(([, s]) => s === "analyzing").map(([candidateId]) => ({ candidateId })),
      getReport: async (_r, id) => reports[id] ?? null,
      createApproval: async (_r, strong) => {
        approvals.push(strong.map((s) => s.candidateId));
        return Object.fromEntries(strong.map((s) => [s.candidateId, `a${approvals.length}`]));
      },
      markHits: async (_id, ups) => ups.forEach((u) => stage.set(u.candidateId, u.stage)),
    };
    const h1 = await harvestRun(run(), deps);
    assert.deepEqual(approvals, [["c01"]]);
    assert.equal(h1.done, 3); // c04 는 이미 거절된 리포트 → 승인 요청 없이 analyzed
    const h2 = await harvestRun(run(), deps);
    assert.equal(h2.done, 0);
    assert.equal(approvals.length, 1);
    assert.equal(stage.get("c03"), "analyzing");
  });
});

describe("scan 커서", () => {
  test("selectScanBatch: 전진·끝·빈 목록", () => {
    const ids = ["a", "b", "c", "d", "e"];
    assert.deepEqual(selectScanBatch(ids, null, 2), { batch: ["a", "b"], nextCursor: "b", completed: false });
    assert.deepEqual(selectScanBatch(ids, "b", 2), { batch: ["c", "d"], nextCursor: "d", completed: false });
    assert.deepEqual(selectScanBatch(ids, "d", 2), { batch: ["e"], nextCursor: "e", completed: true });
    assert.deepEqual(selectScanBatch(ids, "e", 2), { batch: [], nextCursor: "e", completed: true });
    // 커서 후보가 지워졌어도 다음 id 부터
    assert.deepEqual(selectScanBatch(["a", "c"], "b", 5).batch, ["c"]);
  });

  test("커서 전진 → 한 바퀴 후 scan 은 건너뛰고 delta 만", async () => {
    const f = fakeDeps();
    const r = run({ daily_llm_cap: 100 });
    f.state.run = r;
    const seenBatches: number[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await runWatchCycle(r, "scan", f.deps, opts);
      seenBatches.push(res.targets);
      if (res.skipped === "scan_done") break;
    }
    assert.deepEqual(seenBatches, [5, 5, 2, 0]);
    assert.ok(r.scan_completed_at);
    assert.equal(r.scan_cursor, "c12");
    assert.equal((await runWatchCycle(r, "scan", f.deps, opts)).skipped, "scan_done");
    const f2 = fakeDeps({ changed: ["c99"], all: ["c99"] });
    assert.equal((await runWatchCycle(r, "delta", f2.deps, opts)).enqueued, 1);
  });

  test("delta 우선 배분: 같은 날 scan 이 먼저 돌아도 30% 만, delta 가 나머지", async () => {
    const all = Array.from({ length: 20 }, (_, i) => `c${String(i + 1).padStart(2, "0")}`);
    const f = fakeDeps({ all, changed: all.slice(10) });
    const r = run({ daily_llm_cap: 10 });
    const s = await runWatchCycle(r, "scan", f.deps, { ...opts, scanBatch: 10 });
    const d = await runWatchCycle(r, "delta", f.deps, opts);
    assert.equal(s.enqueued, 3);
    assert.equal(d.enqueued, 7);
    assert.equal(f.enqueued.length, 10);
  });

  test("delta 첫 주기(확인 시각 없음)는 과거 변경을 안 본다", async () => {
    const f = fakeDeps({ changed: ["c01"] });
    const r = await runWatchCycle(run({ watch_checked_at: null }), "delta", f.deps, opts);
    assert.equal(r.skipped, "no_targets");
    assert.ok((f.progress[0] as { watch_checked_at?: string }).watch_checked_at);
  });
});

describe("요약·설정", () => {
  test("buildDigest: 빈 목록은 null, 집계", () => {
    assert.equal(buildDigest("r1", "2026-10-30", []), null);
    const s = buildDigest("r1", "2026-10-30", [
      { candidate_id: "c1", source: "delta", rank_score: 70, stage: "analyzed", verdict: "strong_fit", sourcing_action_id: "a1" },
      { candidate_id: "c2", source: "scan", rank_score: 90, stage: "analyzing", verdict: null, sourcing_action_id: null },
    ])!;
    assert.equal(s.newHits, 2);
    assert.deepEqual(s.bySource, { delta: 1, scan: 1 });
    assert.equal(s.strongFit, 1);
    assert.deepEqual(s.pendingApprovals, ["a1"]);
    assert.equal(s.top[0].candidateId, "c2");
  });

  test("parseWatchSettings/finalize: 검증·기본 기간·마감 건 거부", () => {
    assert.equal(parseWatchSettings({}, NOW).ok, false);
    assert.equal(parseWatchSettings({ dailyLlmCap: -1 }, NOW).ok, false);
    assert.equal(parseWatchSettings({ until: "2026-10-01T00:00:00Z" }, NOW).ok, false);
    assert.equal(parseWatchSettings({ until: "2028-01-01T00:00:00Z" }, NOW).ok, false);
    const p = parseWatchSettings({ enabled: true }, NOW);
    assert.ok(p.ok);
    const fin = finalizeWatchPatch(p.patch, { watch_until: null, closed_at: null }, NOW);
    assert.ok(fin.ok && fin.patch.watch_until);
    assert.equal(finalizeWatchPatch(p.patch, { watch_until: null, closed_at: "2026-10-01T00:00:00Z" }, NOW).ok, false);
    const keep = finalizeWatchPatch(p.patch, { watch_until: "2026-11-15T00:00:00Z", closed_at: null }, NOW);
    assert.ok(keep.ok && keep.patch.watch_until === undefined);
  });
});


describe("리뷰 반영", () => {
  test("1 상시 수색 승인 건은 Slack 발송 안 함", () => {
    assert.equal(isWatchNoSend({ autoSource: "watch" }), true);
    assert.equal(isWatchNoSend({ autoSource: "jd_analysis" }), false);
    assert.equal(isWatchNoSend(null), false);
  });

  test("2 상한 초과 시 scan 커서·delta 기준 시각을 전진하지 않고 다음 날 남은 후보 처리", async () => {
    const f = fakeDeps();
    const r = run({ daily_llm_cap: 10 });
    f.state.run = r;
    const s1 = await runWatchCycle(r, "scan", f.deps, opts); // scan 할당 3, 대상 5
    assert.equal(s1.overCap, 2);
    assert.equal(r.scan_cursor, null);
    f.used.delta = 0; f.used.scan = 0; // 다음 날
    const s2 = await runWatchCycle(r, "scan", f.deps, opts);
    assert.equal(s2.enqueued, 2);
    assert.equal(r.scan_cursor, "c05");
    assert.deepEqual(f.enqueued, ["c01", "c02", "c03", "c04", "c05"]);

    const d = fakeDeps({ changed: ["c01", "c02"] });
    const rd = run({ daily_llm_cap: 1 });
    d.state.run = rd;
    await runWatchCycle(rd, "delta", d.deps, opts);
    assert.equal(rd.watch_checked_at, "2026-10-29T00:00:00Z");
  });

  test("3 delta 기준 시각은 마지막 행 changed_at (now 아님), 빈 페이지면 유지", async () => {
    const d = fakeDeps({ changed: ["c01"] });
    const rd = run();
    d.state.run = rd;
    await runWatchCycle(rd, "delta", d.deps, opts);
    assert.equal(rd.watch_checked_at, "2026-10-29T12:00:00Z");
    const e = fakeDeps({ changed: [] });
    const re = run();
    e.state.run = re;
    await runWatchCycle(re, "delta", e.deps, opts);
    assert.equal(re.watch_checked_at, "2026-10-29T00:00:00Z");
  });

  test("4 동의 필터 실패 시 throw → 진행 위치 저장 안 함", async () => {
    const f = fakeDeps();
    const r = run();
    f.state.run = r;
    f.deps.filterConsented = async () => { throw new Error("consents 조회 실패"); };
    await assert.rejects(runWatchCycle(r, "scan", f.deps, opts));
    assert.equal(r.scan_cursor, null);
    assert.equal(f.progress.length, 0);
  });

  test("5 사용자 단위 상한: 의뢰 건 cap 이 남아도 사용자 합계에서 막힌다", () => {
    const a = { cap: 20, scanCap: 6, userCap: 100, want: 10, isScan: false };
    assert.equal(reserveCalc({ runTotal: 0, runScan: 0, userTotal: 95 }, a), 5);
    assert.equal(reserveCalc({ runTotal: 0, runScan: 0, userTotal: 100 }, a), 0);
    assert.equal(reserveCalc({ runTotal: 18, runScan: 0, userTotal: 0 }, a), 2);
    assert.equal(reserveCalc({ runTotal: 0, runScan: 5, userTotal: 0 }, { ...a, isScan: true }), 1);
  });

  test("6 승인 재시도: 이미 실린 후보는 새로 만들지 않음", () => {
    const u = uncoveredCandidates([{ id: "a1", candidateIds: ["c1", "c2"] }], ["c1", "c3"]);
    assert.deepEqual(u.covered, { c1: "a1" });
    assert.deepEqual(u.uncovered, ["c3"]);
  });

  test("7 tick: 비활성이어도 분석 중 hit 가 남은 건은 delta(수확)", () => {
    const plan = tickPlan([{ id: "r1", scan_completed_at: null }, { id: "r2", scan_completed_at: "x" }], ["r1", "r9", "r9"]);
    assert.deepEqual(plan, [
      { runId: "r1", kind: "delta" },
      { runId: "r1", kind: "scan" },
      { runId: "r2", kind: "delta" },
      { runId: "r9", kind: "delta" },
    ]);
  });

  test("8 소유자 없는 의뢰 건은 403", () => {
    assert.equal(watchAccessAllowed(null, true), false);
    assert.equal(watchAccessAllowed("u1", true), true);
    assert.equal(watchAccessAllowed("u1", false), false);
  });

  test("9 같은 날 요약 재실행은 병합", () => {
    const h = (id: string, score: number, src: "delta" | "scan") => ({ candidate_id: id, source: src, rank_score: score, stage: "analyzing", verdict: null, sourcing_action_id: null });
    const a = buildDigest("r1", "d", [h("c1", 70, "delta")])!;
    const b = buildDigest("r1", "d", [h("c2", 90, "scan")])!;
    const m = mergeDigest(a, b);
    assert.equal(m.newHits, 2);
    assert.deepEqual(m.bySource, { delta: 1, scan: 1 });
    assert.deepEqual(m.top.map((t) => t.candidateId), ["c2", "c1"]);
    assert.equal(mergeDigest(null, b), b);
  });
});

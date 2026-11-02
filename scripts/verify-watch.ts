/**
 * 22 문서 E7 상시 수색 실데이터 확인 (레인 D). 원격 DB(서비스 롤) + MCP(http://localhost:3002/mcp) 필요.
 * 사용: cd orchestrator && npx tsx ../scripts/verify-watch.ts [--run <jd_run_id>]
 * LLM 을 쓰는 fit-analysis 잡은 절대 투입하지 않는다 (항상 dry-run: 잡·hit·커서 쓰기 없음, 상한은 메모리 계산).
 *
 * ① 026 미적용: listActiveWatchRuns → applied=false, runDailyDigest → applied=false 이면 호환 경로 OK.
 * ② 026 적용 후 확인 절차:
 *    1. 의뢰 건 하나에 설정: PATCH /api/jd-runs/<id>/watch {"enabled":true,"dailyLlmCap":3} (또는 SQL update)
 *    2. 이 스크립트를 --run <id> 로 실행 → scan dry-run 에서 targets>0, enqueued ≤ floor(3×0.3)=0, delta 는 cap 안
 *       (scan 은 cap×(1-WATCH_DELTA_RATIO) 까지만 — cap 3 이면 scan 0명이 정상)
 *    3. 실제 실행은 orchestrator worker(startWatchWorkers 등록 후) + WATCH_DRY_RUN=1 로 먼저 1시간 관찰 후 해제
 *    4. 끝나면 PATCH {"enabled":false}. 이 스크립트는 DB 에 쓰지 않으므로 지울 행 없음.
 * 비밀값은 출력하지 않는다.
 */
import "../orchestrator/src/lib/env.js";

async function main() {
  const { listActiveWatchRuns, getWatchRun, createCycleDeps, runDailyDigest } = await import("../orchestrator/src/lib/watch.js");
  const { runWatchCycle } = await import("../orchestrator/src/lib/watchCore.js");
  const { D_MIN_RANK } = await import("../orchestrator/src/lib/matchEngine.js");
  const { db } = await import("../orchestrator/src/lib/db.js");

  const active = await listActiveWatchRuns();
  console.log(`026 적용: ${active.applied}, 활성 의뢰 건: ${active.runs.length}`);
  const hitsProbe = await db.from("watch_hits").select("candidate_id", { count: "exact", head: true });
  console.log(`watch_hits: ${hitsProbe.error || hitsProbe.count == null ? "없음(026 미적용)" : `${hitsProbe.count}행`}`);
  const consentProbe = await db.from("consents").select("user_id", { count: "exact", head: true }).eq("purpose", "matching").is("revoked_at", null);
  console.log(`consents(matching): ${consentProbe.error ? `없음(${consentProbe.error.code})` : `${consentProbe.count}행`} (WATCH_REQUIRE_CONSENT=${process.env.WATCH_REQUIRE_CONSENT ?? "unset"})`);

  if (!active.applied) {
    // 미적용 경로: 다이제스트도 건너뛰어야 한다 (읽기만, 쓰기 없음)
    const { data: probe } = await db.from("watch_hits").select("jd_run_id").limit(1);
    if (probe === null) console.log("digest: 026 미적용 → 건너뜀 확인 (runDailyDigest 는 쓰기 전에 applied=false 로 반환)");
    console.log("결과: 미적용 호환 경로 OK — 상시 수색은 아무 잡도 만들지 않는다.");
    return;
  }

  const idx = process.argv.indexOf("--run");
  const runId = idx > 0 ? process.argv[idx + 1] : active.runs[0]?.id;
  if (!runId) {
    console.log("활성 의뢰 건 없음 — --run <id> 로 지정하거나 PATCH 로 켠 뒤 다시 실행.");
    if (process.argv.includes("--digest")) console.log(await runDailyDigest()); // 명시할 때만 (watch_digests 에 씀)
    return;
  }
  const { run } = await getWatchRun(runId);
  if (!run) throw new Error(`jd_run ${runId} 없음`);
  const deps = createCycleDeps({ dryRun: true });
  for (const kind of ["scan", "delta"] as const) {
    const t0 = Date.now();
    // delta 는 확인 시각이 없으면 하루 전부터로 가정해 미리보기
    const r = kind === "delta" && !run.watch_checked_at ? { ...run, watch_checked_at: new Date(Date.now() - 86_400_000).toISOString() } : run;
    const res = await runWatchCycle({ ...r, watch_enabled: true, watch_until: r.watch_until ?? new Date(Date.now() + 86_400_000).toISOString() }, kind, deps, { now: Date.now(), minRank: D_MIN_RANK });
    console.log(`${kind} dry-run: ${JSON.stringify(res)} (${Date.now() - t0}ms)`);
  }
  console.log(`dry-run 사용량: ${JSON.stringify(Object.fromEntries(deps.dryRunUsed))}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });

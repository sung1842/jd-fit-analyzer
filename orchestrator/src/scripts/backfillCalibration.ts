/**
 * 이미 저장된 fit_reports 에 점수 보정(lib/calibrate.ts)을 소급 적용한다. LLM 호출 없음.
 * 후보 포트폴리오는 MCP get_candidate_portfolio 로 다시 읽는다 (분석 때와 같은 prune·공개 범위).
 *
 *   npx tsx src/scripts/backfillCalibration.ts          # 드라이런 (바뀔 점수만 출력)
 *   npx tsx src/scripts/backfillCalibration.ts --apply  # 저장
 * 이미 calibration 이 있는 리포트는 건너뛴다 (두 번 돌려도 안전). 상태(승인·대기 등)와 검토 기록은 그대로 둔다.
 */
import type { CandidatePortfolio, FitReport } from "../../../shared/types.js";
import { db } from "../lib/db.js";
import { calibrateReport } from "../lib/calibrate.js";
import { callMcpTool, closeMcpClient } from "../mcp/client.js";

const apply = process.argv.includes("--apply");

const { data, error } = await db.from("fit_reports").select("id, candidate_id, candidate_name, report").not("report", "is", null);
if (error) throw new Error(error.message);
const rows = (data ?? []) as { id: string; candidate_id: string; candidate_name: string | null; report: FitReport }[];

const portfolios = new Map<string, CandidatePortfolio | null>();
let changed = 0;
let skipped = 0;
let failed = 0;
for (const r of rows) {
  if (r.report.calibration) {
    skipped += 1;
    continue;
  }
  if (!portfolios.has(r.candidate_id)) {
    try {
      portfolios.set(r.candidate_id, await callMcpTool<CandidatePortfolio>("get_candidate_portfolio", { candidateId: r.candidate_id }));
    } catch (e) {
      console.warn(`포트폴리오 조회 실패 ${r.candidate_id}: ${e instanceof Error ? e.message : e}`);
      portfolios.set(r.candidate_id, null);
    }
  }
  const p = portfolios.get(r.candidate_id);
  if (!p) {
    failed += 1;
    continue;
  }
  const next = calibrateReport(r.report, p);
  const delta = next.overallScore - r.report.overallScore;
  console.log(`${(r.candidate_name ?? r.report.candidateName).padEnd(8)} ${String(r.report.overallScore).padStart(3)} → ${String(next.overallScore).padStart(3)} (${next.calibration!.tier}${delta ? `, ${delta}` : ""})`);
  if (delta !== 0) changed += 1;
  if (apply) {
    const { error: e } = await db.from("fit_reports").update({ report: next }).eq("id", r.id);
    if (e) {
      console.warn(`저장 실패 ${r.id}: ${e.message}`);
      failed += 1;
    }
  }
}
console.log(`\n대상 ${rows.length - skipped} · 점수 변경 ${changed} · 이미 보정됨 ${skipped} · 실패 ${failed}${apply ? " · 저장함" : " · 드라이런(--apply 로 저장)"}`);
await closeMcpClient();
process.exit(0);

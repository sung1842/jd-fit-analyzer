/**
 * 매칭 품질 지표(E6)·가중치(E6b) 실데이터 확인 — 읽기 전용 (쓰기 없음).
 * 사용: cd jd-fit-analyzer/orchestrator && npx tsx ../scripts/verify-match-quality.ts
 */
import { computeMatchQuality, extractDecisions, loadQualityInput } from "../orchestrator/src/lib/matchQuality.js";
import { getEffectiveWeights, loadTrainingSamples } from "../orchestrator/src/lib/rankingWeights.js";

const pct = (r: { n: number; d: number; rate: number | null } | null) => (r ? `${r.n}/${r.d}${r.rate === null ? "" : ` (${(r.rate * 100).toFixed(1)}%)`}` : "준비 중(017 미적용)");

async function main() {
const input = await loadQualityInput();
const decisions = extractDecisions(input);
console.log(`fit_reports ${input.reports.length}건, 결정 ${decisions.length}건 (review 있음 ${input.reports.filter((r) => r.report?.review).length}), jd_runs ${input.jdRuns.length}, offers ${input.offers?.length ?? "null"}, status_events 거절사유 ${input.statusReasons?.size ?? "null"}`);

const q = computeMatchQuality(input);
console.log(`전체: 승인율 ${pct(q.approval)} · 뒤집기율 ${pct(q.flip)} (strong 거절 ${q.flip.strongRejected}, weak 승인 ${q.flip.weakApproved}) · 수락율 ${pct(q.acceptance)}`);
console.log("거절 사유:", q.rejectReasons);
console.log("verdict별:", q.byVerdict);

const count = (key: "companyId" | "recruiterId") => {
  const m = new Map<string, number>();
  for (const d of decisions) m.set(d[key] ?? "(없음)", (m.get(d[key] ?? "(없음)") ?? 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1]).slice(0, 5);
};
for (const [id, n] of count("companyId")) if (id !== "(없음)") console.log(`  기업 ${id}: ${n}건 승인율 ${pct(computeMatchQuality(input, { companyId: id }).approval)}`);
for (const [id, n] of count("recruiterId")) console.log(`  헤드헌터 ${id.slice(0, 8)}…: ${n}건 승인율 ${pct(computeMatchQuality(input, { recruiterId: id }).approval)}`);
const since30 = new Date(Date.now() - 30 * 86400_000).toISOString();
console.log(`최근 30일: 결정 ${computeMatchQuality(input, { from: since30 }).decided}건`);

console.log(`학습 샘플(match_scores × 결정): ${(await loadTrainingSamples()).length}건`);
console.log("유효 가중치(공통):", JSON.stringify(await getEffectiveWeights({})));
}
main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });

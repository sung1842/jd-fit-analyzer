/**
 * seed-test-candidates.ts 로 만든 가상 후보 삭제.
 * 사용: cd orchestrator && npx tsx ../scripts/delete-test-candidates.ts          (기본 dry-run: 건수만 출력)
 *       cd orchestrator && npx tsx ../scripts/delete-test-candidates.ts --yes    (실제 삭제)
 *
 * 대상 = 이메일이 `@talentfolio.test` 이고 user_metadata.test === true 인 계정만.
 * (talentfolio 기존 시드 `seed.*@talentfolio.test` 는 test 플래그가 없어 건드리지 않는다.)
 * 순서: candidate_id(text) 로 연결된 fit 행 → auth 사용자 삭제(profiles·resume_*·consents 등 user_id FK 는 cascade).
 */
import "../orchestrator/src/lib/env.js";

const TEST_DOMAIN = "@talentfolio.test";
// candidate_id(text) 로 auth 사용자와 느슨하게 연결된 테이블 — FK 가 없어 cascade 되지 않는다
const CANDIDATE_TABLES = [
  "candidate_profiles_norm", "match_scores", "watch_hits", "fit_reports", "candidate_assessments",
  "portfolio_chunks", "profile_views", "explanation_requests", "sourcing_actions",
];
// user_id FK 가 cascade 지만 dry-run 건수 확인용
const USER_TABLES = ["resume_basics", "resume_experiences", "consents", "job_recommendations"];

async function main() {
  const { db } = await import("../orchestrator/src/lib/db.js");
  const run = process.argv.includes("--yes");

  const targets: { id: string; email: string }[] = [];
  for (let page = 1; ; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error(`listUsers 실패: ${error.message}`);
    for (const u of data.users) {
      if (u.email?.endsWith(TEST_DOMAIN) && u.user_metadata?.test === true) targets.push({ id: u.id, email: u.email });
    }
    if (data.users.length < 1000) break;
  }
  console.log(`${run ? "삭제" : "dry-run"}: 테스트 계정 ${targets.length}개`);
  if (!targets.length) return;
  const ids = targets.map((t) => t.id);
  const chunks = (xs: string[]) => Array.from({ length: Math.ceil(xs.length / 100) }, (_, i) => xs.slice(i * 100, i * 100 + 100));

  for (const [table, col] of [...CANDIDATE_TABLES.map((t) => [t, "candidate_id"]), ...USER_TABLES.map((t) => [t, "user_id"])]) {
    let n = 0;
    let skipped = "";
    for (const part of chunks(ids)) {
      const q = run && col === "candidate_id"
        ? db.from(table).delete({ count: "exact" }).in(col, part)
        : db.from(table).select(col, { count: "exact", head: true }).in(col, part);
      const { count, error } = await q;
      if (error) { skipped = `${error.code ?? ""} ${error.message}`.trim(); break; }
      n += count ?? 0;
    }
    console.log(`  ${table}: ${skipped ? `건너뜀 (${skipped})` : `${n}행${run && col === "user_id" ? " (계정 삭제 시 cascade)" : ""}`}`);
  }

  if (!run) { console.log("실제 삭제하려면 --yes"); return; }
  let deleted = 0;
  for (const t of targets) {
    const { error } = await db.auth.admin.deleteUser(t.id);
    if (error) console.error(`  ${t.email}: ${error.message}`);
    else deleted++;
  }
  console.log(`auth 사용자 삭제 ${deleted}/${targets.length}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

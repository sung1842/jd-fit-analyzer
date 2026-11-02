/**
 * 22 문서 E4·E5 매칭 엔진 실데이터 확인 (레인 A). 원격 DB(서비스 롤) + MCP(http://localhost:3002/mcp) 필요.
 * 사용: cd orchestrator && npx tsx ../scripts/verify-match-engine.ts
 * - SQL 022·024 미적용: vectorStage=skipped, scoresSaved=skipped 로 나와야 한다 (호환 경로).
 * - 적용 후: vectorStage=applied, scoresSaved=숫자, 두 번째 실행은 같은 순위·점수(T5) + 공고 임베딩 캐시.
 * 끝나면 이 스크립트가 만든 match_scores 행은 지운다 (--keep 이면 남김). 비밀값은 출력하지 않는다.
 */
import "../orchestrator/src/lib/env.js";

const JDS: Record<string, string> = {
  backend: `[백엔드 개발자] 핀테크 서비스 결제 API 개발.
자격요건: Java, Spring Boot 3년 이상, MySQL 또는 PostgreSQL, REST API 설계 경험.
우대사항: Kafka, Redis, AWS, Docker/Kubernetes 운영 경험. 근무지 서울.`,
  designer: `[프로덕트 디자이너] B2C 모바일 앱 UI/UX 디자인.
자격요건: Figma 능숙, 디자인 시스템 구축 경험, 경력 2년 이상.
우대사항: Prototyping, 사용자 리서치, Adobe Photoshop/Illustrator. 근무지 서울(원격 일부 가능).`,
};

async function main() {
  const { buildJdPlan } = await import("../orchestrator/src/lib/jdPlan.js");
  const { db } = await import("../orchestrator/src/lib/db.js");
  const { jdHash } = await import("../orchestrator/src/lib/cache.js");
  const keep = process.argv.includes("--keep");
  for (const [name, jd] of Object.entries(JDS)) {
    const t0 = Date.now();
    const p1 = await buildJdPlan(jd);
    const ms = Date.now() - t0;
    const p2 = await buildJdPlan(jd);
    const same = JSON.stringify(p1.ranked.map((r) => [r.candidateId, r.rankScore])) === JSON.stringify(p2.ranked.map((r) => [r.candidateId, r.rankScore]));
    console.log(`\n=== ${name} (${ms}ms, 2회차 동일=${same}) role=${p1.requirements.role} must=${p1.requirements.must_skills.join("|")} nice=${p1.requirements.nice_skills.join("|")} years=${p1.requirements.years_min}~${p1.requirements.years_max}`);
    console.log(`후보 ${p1.totalInRole} · 정규화 ${p1.normalizedCount} · 제외 ${JSON.stringify(p1.filteredOut)} · 기술일치 ${p1.matchedCount} · vector=${p1.vectorStage} · weights=${p1.weightsVersion} · D후보 ${p1.analyzableCount} · 저장=${p1.scoresSaved}`);
    for (const r of p1.ranked.slice(0, 10)) {
      const it = r.scoreBreakdown!.items;
      console.log(
        `${String(r.rankScore).padStart(6)} ${r.analyzable ? "D" : " "} ${r.name.padEnd(8)} via=${(r.via ?? []).join("+") || "-"} must=${it.must} nice=${it.nice} yrs=${it.years} role=${it.role} vec=${it.vector} act=${it.activity}${r.missingMust.length ? ` 누락:${r.missingMust.join(",")}` : ""}`
      );
    }
    if (p1.scoresSaved === "queued") {
      await new Promise((r) => setTimeout(r, 3000)); // 응답 뒤 비동기 저장 대기
      const { data } = await db.from("match_scores").select("candidate_id, score_breakdown").eq("jd_hash", jdHash(jd));
      const rows = (data ?? []) as { score_breakdown: { reqHash?: string } }[];
      console.log(`저장 확인: ${rows.length}행, reqHash 기록 ${rows.filter((r) => r.score_breakdown?.reqHash).length}행`);
      if (!keep) await db.from("match_scores").delete().eq("jd_hash", jdHash(jd));
    }
  }
  process.exit(0);
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

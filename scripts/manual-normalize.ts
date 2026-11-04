/**
 * 수동 후보 정규화 (API 한도 소진 시 테스트 데이터 보충용, 2026-11-03).
 * LLM(normalize_candidate) 대신 사람이 만든 정규화 결과를 서버와 같은 경로(normalizeCandidateProfile)로 저장한다.
 * 사전 매핑·해시·미매핑 적재는 그대로, 임베딩은 실패하면 비워 둔다.
 *
 *   cd orchestrator && npx tsx ../scripts/manual-normalize.ts dump <ids.json> <out.json>   정규화 안 된 후보 프로필 내보내기 (이름·링크 제외)
 *   cd orchestrator && npx tsx ../scripts/manual-normalize.ts apply <raw.json>             { [candidateId]: RawNormalized } 저장
 */
import "../orchestrator/src/lib/env.js";
import { readFileSync, writeFileSync } from "node:fs";
import { callMcpTool, closeMcpClient } from "../orchestrator/src/mcp/client.js";
import { normalizeCandidateProfile, type RawNormalized } from "../orchestrator/src/lib/candidateNorm.js";
import type { CandidatePortfolio } from "../shared/types.js";

async function main() {
  const [mode, a, b] = process.argv.slice(2);
  if (mode === "dump") {
    const { candidateIds } = JSON.parse(readFileSync(a, "utf8")) as { candidateIds: string[] };
    const out: Record<string, unknown> = {};
    for (const id of candidateIds) {
      try {
        const { name: _n, github_url: _g, portfolio_url: _p, ...rest } = await callMcpTool<CandidatePortfolio>("get_candidate_portfolio", { candidateId: id });
        out[id] = rest;
      } catch (err) {
        out[id] = { error: err instanceof Error ? err.message : String(err) };
      }
    }
    writeFileSync(b, JSON.stringify(out, null, 1));
    console.log(`dump ${Object.keys(out).length}명 → ${b}`);
  } else if (mode === "apply") {
    const raws = JSON.parse(readFileSync(a, "utf8")) as Record<string, RawNormalized>;
    for (const [id, raw] of Object.entries(raws)) {
      const r = await normalizeCandidateProfile(id, { force: true, raw });
      console.log(id, r.outcome);
    }
  } else {
    console.error("사용: dump <ids.json> <out.json> | apply <raw.json>");
    process.exitCode = 1;
  }
  await closeMcpClient();
}

main().then(() => process.exit(), (err) => {
  console.error(err);
  process.exit(1);
});

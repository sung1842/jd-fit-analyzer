import { buildJdPlan } from "./jdPlan.js";
import type { RankedLite, WatchRun } from "./watchCore.js";

/**
 * 상시 수색용 A~C 순위 래퍼 (레인 A buildJdPlan 재사용, 수정 없음).
 * buildJdPlan 은 후보 집합 인자가 없어 직군 전체를 코드로 순위 매긴 뒤 호출 측(watchCore.pickCandidates)이 대상 집합으로 거른다.
 * 비용: 공고 정규화는 jd 해시 캐시(이미 분석된 의뢰 건이면 LLM 0), 임베딩도 캐시. 순위 계산은 코드.
 * 부수효과: buildJdPlan 이 match_scores(024)를 갱신한다 — 즉시 매칭과 같은 키(jd_hash)라 일관됨.
 */
export async function rankForWatch(run: WatchRun): Promise<RankedLite[]> {
  const plan = await buildJdPlan(run.jd_text, undefined, undefined, undefined, { companyId: run.client_name ?? null });
  return plan.ranked.map((r) => ({ id: r.candidateId, rankScore: r.rankScore ?? 0 }));
}

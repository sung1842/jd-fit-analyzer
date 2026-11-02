/**
 * 매칭 엔진 레인 간 공유 규약 (22 문서 E5·E6b). 레인 A(순위식)와 레인 B(가중치 보정)가 이 파일만 보고 맞춘다.
 * 이 파일의 이름·필드를 바꾸려면 두 레인 모두 수정한다.
 */

/** C 단계 계산식 항목 (22 문서 §6.4). 각 항목 값은 0~1, 가중치 합은 100. */
export interface RankWeights {
  must: number;
  nice: number;
  years: number;
  role: number;
  vector: number;
  activity: number;
}

export const DEFAULT_RANK_WEIGHTS: RankWeights = { must: 40, nice: 15, years: 15, role: 10, vector: 15, activity: 5 };

/** 층별 보정 결과. 레인 B 의 getEffectiveWeights 가 돌려주고, 레인 A 가 score_breakdown.boost 에 그대로 기록한다. */
export interface EffectiveWeights {
  weights: RankWeights;
  /** 항목별 보정 비율 (-0.2 ~ +0.2). 보정 없으면 빈 객체 */
  boost: { company?: Partial<RankWeights>; recruiter?: Partial<RankWeights> };
  /** ranking_weights 버전 (match_scores.inputs_hash 에 포함) */
  version: string;
}

export interface WeightScope {
  /** 의뢰 기업 식별자 (jd_runs.client_name 등). 없으면 공통만 */
  companyId?: string | null;
  /** 결정한 헤드헌터 user id. 없으면 공통+기업만 */
  recruiterId?: string | null;
}

-- =====================================================================
-- 023: 추천 갱신 주기 (2026-10-30). 조회 때마다 재계산하지 않는다.
--   조회(GET)     저장된 결과만 읽는다. 처음 한 번(계산 이력 없음)만 잡을 넣는다
--   이벤트        희망 조건 저장·추천 제외·정규화 결과 변경 → 그 사용자만 재계산
--   야간 배치     최근 RECOMMEND_ACTIVE_DAYS 일 안에 추천을 본 사용자만 (휴면 사용자는 건너뜀)
-- viewed_at 은 야간 배치 대상 선정에만 쓴다.
-- =====================================================================
alter table fit.job_recommendation_runs add column if not exists viewed_at timestamptz not null default now();
create index if not exists job_recommendation_runs_viewed_idx on fit.job_recommendation_runs (viewed_at);

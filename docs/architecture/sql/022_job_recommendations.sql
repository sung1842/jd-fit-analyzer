-- =====================================================================
-- 022: 구직자용 "나에게 맞는 공고" 추천 결과 (2026-10-30). LLM 0회 — 코드·사전 매칭만.
--
-- 계산: orchestrator lib/jobRecommend.ts (BullMQ job-recommend 잡).
--   입력: 후보 정규화(fit.candidate_profiles_norm, 22 문서 E2) + 스튜디오 희망 조건(fit.resume_basics) + 공고 필터 컬럼(016)·skills
--   기술 비교는 표준 기술 사전(fit.skill_dictionary, E1)으로 같은 키인지만 본다 (문자열 포함 비교 아님)
-- 결과는 사용자당 상위 N건만 저장한다. 입력이 바뀌지 않으면 다시 계산하지 않는다 (inputs_hash).
-- "내가 분석 대상이 된 공고"(fit_reports) 와는 별개다.
-- =====================================================================
create table if not exists fit.job_recommendations (
  user_id        uuid not null references auth.users (id) on delete cascade,
  job_posting_id uuid not null references fit.job_postings (id) on delete cascade,
  rank           smallint not null,
  score          smallint not null check (score between 0 and 100),
  reasons        text[] not null default '{}',     -- 화면에 그대로 보여 줄 근거 문장 (코드가 만든 것)
  breakdown      jsonb not null default '{}'::jsonb, -- 항목별 점수 (보정·디버깅용)
  computed_at    timestamptz not null default now(),
  primary key (user_id, job_posting_id)
);
create index if not exists job_recommendations_user_rank_idx on fit.job_recommendations (user_id, rank);

-- 계산 상태 (사용자당 1행). inputs_hash 가 같으면 재계산하지 않는다
create table if not exists fit.job_recommendation_runs (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  inputs_hash  text not null,
  candidates   int not null default 0,   -- 필수 조건을 통과한 공고 수
  computed_at  timestamptz not null default now()
);

alter table fit.job_recommendations enable row level security;
alter table fit.job_recommendation_runs enable row level security;
drop policy if exists job_recommendations_owner_read on fit.job_recommendations;
create policy job_recommendations_owner_read on fit.job_recommendations for select to authenticated using (user_id = auth.uid());
drop policy if exists job_recommendation_runs_owner_read on fit.job_recommendation_runs;
create policy job_recommendation_runs_owner_read on fit.job_recommendation_runs for select to authenticated using (user_id = auth.uid());

-- 쓰기는 서버 잡(service_role)만
grant select on fit.job_recommendations, fit.job_recommendation_runs to authenticated;
grant all on fit.job_recommendations, fit.job_recommendation_runs to service_role;

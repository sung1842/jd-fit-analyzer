-- =====================================================================
-- 033: fit 스키마 성능 어드바이저 경고 정리 (2026-11-03, 08 문서 "성능 어드바이저 (fit 소유분)")
--
-- 1) auth_rls_initplan: 정책 안의 auth.uid() 를 (select auth.uid()) 로 감싸 행마다 재계산하지 않게 한다.
--    조건 의미는 그대로다 (같은 값 비교). 010·017·022 의 fit 정책만. public(talentfolio 소유)은 건드리지 않는다.
-- 2) unindexed_foreign_keys: 외래키 인덱스 2건.
-- Supabase SQL Editor 에서 한 번 실행. 여러 번 실행해도 안전.
-- =====================================================================

alter policy fit_reports_select_own on fit.fit_reports
  using (user_id = (select auth.uid())::text);
alter policy sourcing_actions_select_own on fit.sourcing_actions
  using (user_id = (select auth.uid())::text);
alter policy jd_runs_select_own on fit.jd_runs
  using (user_id = (select auth.uid())::text);
alter policy candidate_assessments_select_own on fit.candidate_assessments
  using (exists (select 1 from fit.jd_runs r where r.id = jd_run_id and r.user_id = (select auth.uid())::text));
alter policy slack_channel_configs_select_own on fit.slack_channel_configs
  using (user_id = (select auth.uid())::text);

alter policy profile_views_candidate_read on fit.profile_views
  using (candidate_id = (select auth.uid())::text);
alter policy explanation_requests_owner on fit.explanation_requests
  using (candidate_id = (select auth.uid())::text);
alter policy explanation_requests_owner_insert on fit.explanation_requests
  with check (candidate_id = (select auth.uid())::text);

alter policy job_recommendations_owner_read on fit.job_recommendations
  using (user_id = (select auth.uid()));
alter policy job_recommendation_runs_owner_read on fit.job_recommendation_runs
  using (user_id = (select auth.uid()));

create index if not exists candidate_assessments_fit_report_id_idx on fit.candidate_assessments (fit_report_id);
create index if not exists notion_sync_records_jd_run_id_idx on fit.notion_sync_records (jd_run_id);

-- 확인: select policyname, qual from pg_policies where schemaname = 'fit' and qual like '%auth.uid()%' and qual not like '%SELECT auth.uid()%';

-- =====================================================================
-- 032: 분석 영구 실패 상태 (2026-11-03).
--
-- 재시도(attempts)를 모두 소진한 분석 job 은 지금까지 fit_reports 가 queued/processing 으로 남아
-- 데스크 홈에서 "분석 진행 중"으로 영원히 보였다. 워커가 최종 실패 시 'failed' 로 기록한다.
-- 같은 (JD, 후보)를 다시 분석하면 createFitReport upsert 가 queued 로 되돌린다.
-- Supabase SQL Editor 에서 한 번 실행. 여러 번 실행해도 안전.
-- =====================================================================
alter type fit.fit_report_status add value if not exists 'failed';

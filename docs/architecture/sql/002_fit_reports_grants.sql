-- "Automatically expose new tables"를 끄고 프로젝트를 생성한 경우, service_role에도
-- 새 테이블에 대한 GRANT가 자동으로 부여되지 않아 "permission denied for table fit_reports"
-- 오류가 발생한다. orchestrator(service_role)가 fit_reports를 읽고 쓸 수 있도록 권한 부여.

grant usage on schema public to service_role;
grant all on table fit_reports to service_role;

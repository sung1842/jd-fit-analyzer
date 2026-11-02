-- 1) 권한 재부여 (모든 권한 + 시퀀스/타입 포함, 향후 생성될 테이블도 커버)
grant usage on schema public to service_role, anon, authenticated;
grant all privileges on all tables in schema public to service_role;
grant all privileges on all sequences in schema public to service_role;
alter default privileges in schema public grant all on tables to service_role;
alter default privileges in schema public grant all on sequences to service_role;

-- 2) 확인용: fit_reports에 대한 현재 권한 조회 (결과를 같이 공유해주세요)
select grantee, privilege_type
from information_schema.table_privileges
where table_name = 'fit_reports';

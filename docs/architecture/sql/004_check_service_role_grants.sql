select grantee, privilege_type
from information_schema.table_privileges
where table_name = 'fit_reports' and grantee = 'service_role';

-- fit_reports는 orchestrator(service_role)만 접근하고 anon/authenticated에는 노출되지 않으므로
-- RLS를 비활성화한다. (RLS enabled + 정책 없음 = 모든 SELECT/UPDATE가 0건 반환 → PGRST116 발생)
alter table fit_reports disable row level security;

-- jd-fit-analyzer 전용 Supabase — Phase M4 Notion per-user OAuth + JD run/assessment 레이어
-- Supabase Dashboard → SQL Editor에서 실행 (007_sourcing_actions.sql 이후)

create type jd_run_status as enum (
  'draft',
  'analyzed',
  'shortlisted',
  'synced'
);

create table notion_integrations (
  id uuid primary key default gen_random_uuid(),
  user_id text not null unique,
  access_token text not null,
  refresh_token text,
  workspace_id text,
  workspace_name text,
  bot_id text,
  data_source_id text,
  property_mapping jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index notion_integrations_user_id_idx on notion_integrations (user_id);

create table jd_runs (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  jd_hash text not null,
  jd_text text not null,
  plan_snapshot jsonb,
  status jd_run_status not null default 'analyzed',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index jd_runs_user_id_idx on jd_runs (user_id);
create index jd_runs_jd_hash_idx on jd_runs (jd_hash);
create unique index jd_runs_user_jd_hash_uidx on jd_runs (user_id, jd_hash);

create table candidate_assessments (
  id uuid primary key default gen_random_uuid(),
  jd_run_id uuid not null references jd_runs (id) on delete cascade,
  candidate_id text not null,
  candidate_name text,
  overall_score integer not null,
  verdict text not null,
  matched_skills text[] not null default '{}',
  missing_skills text[] not null default '{}',
  ceo_summary text,
  tech_summary text,
  experience_summary text,
  fit_report_id uuid references fit_reports (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (jd_run_id, candidate_id)
);

create index candidate_assessments_jd_run_id_idx on candidate_assessments (jd_run_id);
create index candidate_assessments_candidate_id_idx on candidate_assessments (candidate_id);

create table notion_sync_records (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  candidate_id text not null,
  jd_run_id uuid not null references jd_runs (id) on delete cascade,
  notion_page_id text not null,
  last_synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, candidate_id, jd_run_id)
);

create index notion_sync_records_user_id_idx on notion_sync_records (user_id);

create trigger notion_integrations_set_updated_at
  before update on notion_integrations
  for each row execute function set_updated_at();

create trigger jd_runs_set_updated_at
  before update on jd_runs
  for each row execute function set_updated_at();

create trigger candidate_assessments_set_updated_at
  before update on candidate_assessments
  for each row execute function set_updated_at();

create trigger notion_sync_records_set_updated_at
  before update on notion_sync_records
  for each row execute function set_updated_at();

alter table notion_integrations disable row level security;
alter table jd_runs disable row level security;
alter table candidate_assessments disable row level security;
alter table notion_sync_records disable row level security;

grant all on notion_integrations to service_role;
grant all on jd_runs to service_role;
grant all on candidate_assessments to service_role;
grant all on notion_sync_records to service_role;

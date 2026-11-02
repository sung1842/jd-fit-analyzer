-- jd-fit-analyzer 전용 Supabase 프로젝트에 실행 (talentfolio DB와 별개)
-- Supabase Dashboard → SQL Editor에서 실행

create type fit_report_status as enum (
  'queued',
  'processing',
  'completed',
  'pending_review',
  'approved',
  'rejected',
  'expired'
);

create table fit_reports (
  id uuid primary key default gen_random_uuid(),
  job_id text not null unique,
  jd text not null,
  jd_hash text not null,
  candidate_id text not null,
  candidate_name text,
  user_id text not null,
  status fit_report_status not null default 'queued',
  report jsonb,              -- FitReport (완료/검토 시 채워짐)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index fit_reports_status_idx on fit_reports (status);
create index fit_reports_user_id_idx on fit_reports (user_id);
create index fit_reports_jd_hash_candidate_idx on fit_reports (jd_hash, candidate_id);

-- updated_at 자동 갱신
create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger fit_reports_set_updated_at
  before update on fit_reports
  for each row
  execute function set_updated_at();

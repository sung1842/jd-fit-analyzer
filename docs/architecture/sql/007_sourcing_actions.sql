-- jd-fit-analyzer 전용 Supabase 프로젝트에 실행 (talentfolio DB와 별개)
-- Supabase Dashboard → SQL Editor에서 실행
-- Phase 5: B2B 사내 소싱 — Slack/Jira 등 외부 액션은 실행 전 HIL 승인 게이트를 거친다.

create type sourcing_action_status as enum (
  'pending',
  'approved',
  'rejected',
  'executed',
  'failed'
);

create table sourcing_actions (
  id uuid primary key default gen_random_uuid(),
  type text not null,              -- 예: 'slack_notify'
  payload jsonb not null,          -- 실행에 필요한 입력 (예: { channel, text, candidateIds, candidateNames })
  status sourcing_action_status not null default 'pending',
  result jsonb,                    -- 실행 결과 (Slack API 응답 등)
  user_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index sourcing_actions_status_idx on sourcing_actions (status);
create index sourcing_actions_user_id_idx on sourcing_actions (user_id);

-- updated_at 자동 갱신 (001_fit_reports.sql에서 정의한 set_updated_at() 재사용)
create trigger sourcing_actions_set_updated_at
  before update on sourcing_actions
  for each row
  execute function set_updated_at();

-- fit_reports와 동일한 이유로 RLS 비활성화 (orchestrator의 service_role만 접근)
alter table sourcing_actions disable row level security;

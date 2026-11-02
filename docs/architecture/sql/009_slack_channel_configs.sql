-- Slack 채널 초대 시 자동 소싱 설정 (007, 008 이후 실행)
-- Supabase Dashboard → SQL Editor

create table if not exists slack_channel_configs (
  slack_channel_id text primary key,
  user_id text not null,
  jd_text text not null,
  enabled boolean not null default true,
  max_analyze int not null default 5,
  inviter_slack_user_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_slack_channel_configs_user_id
  on slack_channel_configs (user_id);

comment on table slack_channel_configs is '봇이 채널에 초대될 때 사용할 JD·담당 userId 매핑';

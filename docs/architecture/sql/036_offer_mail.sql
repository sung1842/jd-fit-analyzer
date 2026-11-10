-- =====================================================================
-- 036: 제안 서신 (2026-11-10).
--
-- 제안(sourcing_actions type='candidate_offer') 한 건 = 서신 한 묶음.
-- 첫 메일은 제안 본문(payload.message)이고, 이후 주고받는 메일만 offer_messages 에 쌓는다.
-- 면접 일정은 기업이 후보 시각(interview_slots)을 제안하고 후보가 그중 하나(picked_slot)를 고른다.
--
-- Supabase SQL Editor 에서 한 번 실행. 여러 번 실행해도 안전.
-- 적용 전에도 제안 목록·열람·응답 기록은 동작한다 (후속 메일·열람 시각·철회만 적용 후 사용).
-- =====================================================================

alter table fit.sourcing_actions add column if not exists viewed_at timestamptz;    -- 후보가 처음 연 시각
alter table fit.sourcing_actions add column if not exists withdrawn_at timestamptz; -- 기업이 철회한 시각

-- 후보의 받은 제안함 조회 (candidate_id 로 찾는다)
create index if not exists sourcing_actions_candidate_offer_idx
  on fit.sourcing_actions (candidate_id, sent_at desc)
  where type = 'candidate_offer';

create table if not exists fit.offer_messages (
  id uuid primary key default gen_random_uuid(),
  offer_id uuid not null references fit.sourcing_actions(id) on delete cascade,
  sender_role text not null check (sender_role in ('company', 'candidate')),
  sender_id text not null,
  subject text not null check (char_length(subject) between 1 and 120),
  body text not null check (char_length(body) between 1 and 4000),
  interview_slots jsonb,       -- 기업이 제안한 면접 후보 시각 (ISO 문자열 배열, 최대 3개)
  picked_slot timestamptz,     -- 후보가 고른 면접 시각
  read_at timestamptz,         -- 받는 쪽이 읽은 시각
  created_at timestamptz not null default now()
);
create index if not exists offer_messages_offer_idx on fit.offer_messages (offer_id, created_at);

-- 서비스 롤(orchestrator)만 읽고 쓴다. 권한(기업 = 제안 작성자, 후보 = 제안 받은 본인)은 API 가 확인한다.
alter table fit.offer_messages enable row level security;

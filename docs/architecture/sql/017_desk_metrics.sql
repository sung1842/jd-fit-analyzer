-- 017 데스크 대시보드 지표 (21 문서 D3·D4). 초안 — 원격 적용은 사용자 승인 후.
-- 원칙: 새 시스템 X, 기존 jd_runs / sourcing_actions / fit_reports 확장 (CLAUDE.md 구현 순서).
-- orchestrator 는 아래 컬럼·테이블이 없으면 해당 지표를 null("준비 중")로 돌려준다 (적용 전에도 동작).

-- D3 · 스카우트 건 = jd_runs 확장 (20 문서 C2)
alter table fit.jd_runs add column if not exists title text;
alter table fit.jd_runs add column if not exists client_name text;
alter table fit.jd_runs add column if not exists owner_name text;
alter table fit.jd_runs add column if not exists deadline date;
alter table fit.jd_runs add column if not exists requirements jsonb; -- [{label, required:boolean}]
alter table fit.jd_runs add column if not exists closed_at timestamptz;
create index if not exists jd_runs_deadline_idx on fit.jd_runs (deadline) where closed_at is null;

-- D4 · 후보 대상 제안 (type='candidate_offer'). slack_notify 는 사내 알림이라 제안으로 세지 않는다.
alter table fit.sourcing_actions add column if not exists jd_run_id uuid references fit.jd_runs(id) on delete set null;
alter table fit.sourcing_actions add column if not exists candidate_id text;
alter table fit.sourcing_actions add column if not exists sent_at timestamptz;
alter table fit.sourcing_actions add column if not exists response text check (response in ('interested','declined','no_response'));
alter table fit.sourcing_actions add column if not exists responded_at timestamptz;
alter table fit.sourcing_actions add column if not exists interview_at timestamptz;
create index if not exists sourcing_actions_jd_run_idx on fit.sourcing_actions (jd_run_id);
create index if not exists sourcing_actions_type_idx on fit.sourcing_actions (type);

-- D4 · 상태 변경 이력 (퍼널 전환·대기 시간의 정확한 기준)
create table if not exists fit.status_events (
  id bigint generated always as identity primary key,
  entity text not null check (entity in ('fit_report','sourcing_action','jd_run')),
  entity_id text not null,
  from_status text,
  to_status text not null,
  actor text,           -- 결정자 user id 또는 'agent'
  reason_code text,     -- 거절 사유 칩 코드 (자유 입력은 'other')
  at timestamptz not null default now()
);
create index if not exists status_events_entity_idx on fit.status_events (entity, entity_id, at);
create index if not exists status_events_at_idx on fit.status_events (at);

-- D4 · 기업 쪽 열람 로그 (근거 열람 후 승인·검토 시간, 구직자 개요의 열람 횟수)
create table if not exists fit.profile_views (
  id bigint generated always as identity primary key,
  viewer_id text not null,
  candidate_id text not null,
  fit_report_id uuid,
  card_id uuid,          -- 근거 카드를 열었으면 카드 id, 브리프 열람만이면 null
  viewed_at timestamptz not null default now()
);
create index if not exists profile_views_report_idx on fit.profile_views (fit_report_id, viewed_at);
create index if not exists profile_views_candidate_idx on fit.profile_views (candidate_id, viewed_at);

-- D4 · 설명 요구 (개인정보보호법 37조의2, 30일 기한)
create table if not exists fit.explanation_requests (
  id uuid primary key default gen_random_uuid(),
  candidate_id text not null,
  fit_report_id uuid,
  kind text not null check (kind in ('explain','refuse')),
  requested_at timestamptz not null default now(),
  answered_at timestamptz
);
-- 기한(요청 + 30일)은 코드에서 계산 (timestamptz + interval 은 immutable 이 아니라 생성 컬럼 불가)
create index if not exists explanation_requests_open_idx on fit.explanation_requests (requested_at) where answered_at is null;

-- RLS: 서비스 롤(orchestrator)만 쓰기. 구직자 본인은 자기 열람 기록·설명 요구 조회.
alter table fit.status_events enable row level security;
alter table fit.profile_views enable row level security;
alter table fit.explanation_requests enable row level security;
drop policy if exists profile_views_candidate_read on fit.profile_views;
create policy profile_views_candidate_read on fit.profile_views for select using (candidate_id = auth.uid()::text);
drop policy if exists explanation_requests_owner on fit.explanation_requests;
create policy explanation_requests_owner on fit.explanation_requests for select using (candidate_id = auth.uid()::text);
drop policy if exists explanation_requests_owner_insert on fit.explanation_requests;
create policy explanation_requests_owner_insert on fit.explanation_requests for insert with check (candidate_id = auth.uid()::text);

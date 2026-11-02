-- 026 상시 수색 (22 문서 §6.5 E7, 레인 D). 초안 — 원격 적용은 사용자 승인 후.
-- 선행: 010(fit.jd_runs) · 017(jd_runs.closed_at) · 020(candidate_profiles_norm.changed_at). 024 와 독립.
-- 원칙: 새 시스템 X — 설정은 jd_runs(스카우트 건) 확장, 결과는 기존 fit_reports / sourcing_actions(HIL) 재사용.
-- 이 파일의 두 테이블은 "같은 (의뢰 건, 후보) 1회" 보장과 하루 1회 요약 저장용 최소 구조. 서비스 롤 전용.
-- orchestrator 는 이 컬럼·테이블이 없으면 상시 수색을 건너뛴다 (활성 의뢰 건 0건으로 취급).

-- 설정 = jd_runs 확장
alter table fit.jd_runs add column if not exists watch_enabled     boolean not null default false;
alter table fit.jd_runs add column if not exists watch_until       timestamptz;          -- 이 시각 이후 자동 제외 (무기한 금지, API 최대 90일)
alter table fit.jd_runs add column if not exists daily_llm_cap     int not null default 20 check (daily_llm_cap >= 0); -- 하루 D 단계(fit-analysis 잡) 상한
alter table fit.jd_runs add column if not exists scan_cursor       text;                 -- 전체 훑기 위치 (마지막 처리 candidate_id)
alter table fit.jd_runs add column if not exists scan_completed_at timestamptz;          -- 한 바퀴 끝난 시각 → 이후 delta 만
alter table fit.jd_runs add column if not exists watch_checked_at  timestamptz;          -- delta 마지막 확인 시각 (changed_at > 이 값)
create index if not exists jd_runs_watch_idx on fit.jd_runs (watch_until) where watch_enabled and closed_at is null;

-- 하루 1회 요약 (화면 조회 + 로그. Slack 발송 없음)
create table if not exists fit.watch_digests (
  id          uuid primary key default gen_random_uuid(),
  jd_run_id   uuid not null references fit.jd_runs(id) on delete cascade,
  digest_date date not null,
  summary     jsonb not null,   -- watchCore.DigestSummary
  created_at  timestamptz not null default now(),
  unique (jd_run_id, digest_date)
);

-- 상시 수색이 찾은 후보 (의뢰 건, 후보)당 1행 = 중복 D 투입·중복 승인 요청 방지
create table if not exists fit.watch_hits (
  jd_run_id          uuid not null references fit.jd_runs(id) on delete cascade,
  candidate_id       text not null,
  source             text not null check (source in ('delta','scan')),
  rank_score         numeric(5,2) not null,
  stage              text not null check (stage in ('analyzing','analyzed','failed')),
  verdict            text,
  fit_report_id      uuid,
  sourcing_action_id uuid references fit.sourcing_actions(id) on delete set null,
  notified_digest_id uuid references fit.watch_digests(id) on delete set null,
  first_seen_at      timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  primary key (jd_run_id, candidate_id)
);
create index if not exists watch_hits_stage_idx on fit.watch_hits (jd_run_id) where stage = 'analyzing';
create index if not exists watch_hits_undigested_idx on fit.watch_hits (jd_run_id) where notified_digest_id is null;

alter table fit.watch_digests enable row level security;
alter table fit.watch_hits enable row level security;
revoke all on fit.watch_digests, fit.watch_hits from public, anon, authenticated;
grant select, insert, update, delete on fit.watch_digests, fit.watch_hits to service_role;

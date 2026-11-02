-- =====================================================================
-- 015: 라이프 로그 (일기 대화 → 활동 → 근거 카드). 2026-10-28
--
-- 설계: 19_app_web_service_plan.md 3절, 18_life_log_design.md A절.
--   life_sessions      대화 세션 (source app|web|import)
--   life_messages      세션 메시지
--   activities         정리된 활동 단위
--   activity_drafts    AI 초안 (quotes = 근거가 된 life_messages.id 배열)
--   evidence_cards     근거 카드 (recorded_at 은 생성 시각 고정, UPDATE 로 변경 불가)
--   user_memory        사용자 장기 메모리
--   peer_confirmations 동료 확인 (trust_level confirmed 근거)
--   consents           동의 (self_ai | matching, revoked_at 으로 철회)
--   match_exclusions   매칭 제외 (job_posting_id null = 전체 제외)
--
-- RLS: 모든 테이블 user_id = auth.uid() 본인만. 서버(service_role)는 RLS 우회.
-- 공개 노출은 뷰 fit.public_evidence_cards 만 (public + 유효 matching 동의).
-- 적용 순서: 014 다음. 재실행 안전 (if not exists / drop ... if exists).
-- =====================================================================

-- 1) 세션·메시지
create table if not exists fit.life_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  source text not null default 'web' check (source in ('app','web','import')),
  title text,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists life_sessions_user_idx on fit.life_sessions (user_id, started_at desc);

create table if not exists fit.life_messages (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references fit.life_sessions (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('user','assistant','system')),
  content text not null,
  created_at timestamptz not null default now()
);
create index if not exists life_messages_session_idx on fit.life_messages (session_id, created_at);

-- 2) 활동·초안
create table if not exists fit.activities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  session_id uuid references fit.life_sessions (id) on delete set null,
  title text not null,
  summary text,
  occurred_on date,
  tags text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists activities_user_idx on fit.activities (user_id, occurred_on desc);

create table if not exists fit.activity_drafts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  activity_id uuid references fit.activities (id) on delete cascade,
  session_id uuid references fit.life_sessions (id) on delete set null,
  draft jsonb not null default '{}'::jsonb check (jsonb_typeof(draft) = 'object'),
  quotes uuid[] not null default '{}',
  status text not null default 'pending' check (status in ('pending','accepted','discarded')),
  created_at timestamptz not null default now()
);
create index if not exists activity_drafts_user_idx on fit.activity_drafts (user_id, status);

-- 3) 근거 카드
create table if not exists fit.evidence_cards (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  activity_id uuid references fit.activities (id) on delete set null,
  claim text not null,
  visibility text not null default 'private' check (visibility in ('private','public')),
  trust_level text not null default 'self' check (trust_level in ('self','attached','confirmed')),
  recorded_at timestamptz not null default now(),
  ai_edited boolean not null default false,
  source text check (source in ('app','web','import')),  -- = life_sessions.source (web = 회고 입력)
  links jsonb not null default '[]'::jsonb check (jsonb_typeof(links) = 'array'),
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists evidence_cards_user_idx on fit.evidence_cards (user_id, recorded_at desc);
create index if not exists evidence_cards_public_idx on fit.evidence_cards (user_id) where visibility = 'public';

-- recorded_at 은 기록 시점 증빙이므로 UPDATE 로 바꿀 수 없다.
-- ai_edited 는 한 번 true(서버 life-polish 잡이 세팅)면 false 로 되돌릴 수 없다 (false→true 만 허용).
-- 사용자 토큰(authenticated)이 RLS 상 UPDATE 권한을 가지므로 DB 에서 막는다. orchestrator PATCH 는 strict 스키마로 ai_edited 자체를 거부.
create or replace function fit.evidence_cards_lock_recorded_at()
returns trigger language plpgsql as $$
begin
  if new.recorded_at is distinct from old.recorded_at then
    raise exception 'evidence_cards.recorded_at is immutable';
  end if;
  if old.ai_edited and new.ai_edited is distinct from true then
    raise exception 'evidence_cards.ai_edited cannot be reset to false';
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists evidence_cards_lock_recorded_at on fit.evidence_cards;
create trigger evidence_cards_lock_recorded_at
  before update on fit.evidence_cards
  for each row execute function fit.evidence_cards_lock_recorded_at();

-- 4) 메모리·동료 확인
create table if not exists fit.user_memory (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  key text not null,
  value text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, key)
);

create table if not exists fit.peer_confirmations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,  -- 카드 소유자
  evidence_card_id uuid not null references fit.evidence_cards (id) on delete cascade,
  confirmer_name text,
  confirmer_contact text,
  status text not null default 'requested' check (status in ('requested','confirmed','declined')),
  comment text,
  confirmed_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists peer_confirmations_card_idx on fit.peer_confirmations (evidence_card_id);

-- 5) 동의·매칭 제외
create table if not exists fit.consents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  purpose text not null check (purpose in ('self_ai','matching')),
  granted_at timestamptz not null default now(),
  revoked_at timestamptz
);
create index if not exists consents_active_idx on fit.consents (user_id, purpose) where revoked_at is null;

create table if not exists fit.match_exclusions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  job_posting_id uuid references fit.job_postings (id) on delete cascade,  -- null = 전체 매칭 제외
  created_at timestamptz not null default now()
);
create unique index if not exists match_exclusions_unique_idx
  on fit.match_exclusions (user_id, coalesce(job_posting_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- 6) RLS: 본인만
do $$
declare t text;
begin
  foreach t in array array['life_sessions','life_messages','activities','activity_drafts','evidence_cards',
                           'user_memory','peer_confirmations','consents','match_exclusions']
  loop
    execute format('alter table fit.%I enable row level security', t);
    execute format('drop policy if exists %I on fit.%I', t || '_owner', t);
    execute format('create policy %I on fit.%I for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid())',
                   t || '_owner', t);
  end loop;
end $$;

-- 7) 공개 뷰: public 카드 + 유효한 matching 동의 사용자만
--    ※ 의도적 공개 읽기: talentfolio 공개 포트폴리오(/talent/[id], getCandidate.ts getPublicEvidenceCards)가
--      비로그인(anon 키) 방문자에게도 보여 준다. 뷰는 소유자 권한으로 evidence_cards RLS(본인만)를 우회하므로
--      컬럼은 공개 카드 필드만 둔다 (visibility·updated_at·created_at 등 내부 필드 금지). 본문·메시지·draft 는 절대 추가하지 말 것.
drop view if exists fit.public_evidence_cards;  -- 컬럼 축소(activity_id 제거) 재실행 대응: replace 로는 컬럼 삭제 불가
create view fit.public_evidence_cards as
select c.id, c.user_id, c.claim, c.trust_level, c.recorded_at,
       c.source, c.links, c.ai_edited, c.published_at
from fit.evidence_cards c
where c.visibility = 'public'
  and exists (
    select 1 from fit.consents k
    where k.user_id = c.user_id and k.purpose = 'matching' and k.revoked_at is null
  );

-- 8) 이미 테이블이 있던 환경(재실행)용: evidence_cards.source CHECK 보장
alter table fit.evidence_cards drop constraint if exists evidence_cards_source_check;
alter table fit.evidence_cards add constraint evidence_cards_source_check
  check (source is null or source in ('app','web','import'));

-- 9) GRANT (010/011 방식: schema usage + 테이블별 명시 grant. 행 범위는 6) RLS 가 본인으로 제한)
grant usage on schema fit to service_role, authenticated, anon;  -- anon: 아래 공개 뷰 select 만 (테이블 grant 없음)
grant select, insert, update, delete on
  fit.life_sessions, fit.life_messages, fit.activities, fit.activity_drafts, fit.evidence_cards,
  fit.user_memory, fit.peer_confirmations, fit.consents, fit.match_exclusions
  to authenticated;   -- consents: 본인 insert(동의)·update(revoked_at 철회) 포함
grant all on
  fit.life_sessions, fit.life_messages, fit.activities, fit.activity_drafts, fit.evidence_cards,
  fit.user_memory, fit.peer_confirmations, fit.consents, fit.match_exclusions
  to service_role;
grant select on fit.public_evidence_cards to service_role, authenticated, anon;  -- 공개 포트폴리오(anon 키) 의도적 공개
grant execute on function fit.evidence_cards_lock_recorded_at() to service_role, authenticated;

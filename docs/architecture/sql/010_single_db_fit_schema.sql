-- =====================================================================
-- 010. Single DB 통합: jd-fit-analyzer 테이블을 talentfolio Supabase 프로젝트의
--      전용 스키마 `fit` 으로 이전한다. (001~009는 구 fit-analyzer DB의 public 스키마용)
--
-- 실행 대상: **talentfolio** Supabase 프로젝트 (NEXT_PUBLIC_SUPABASE_URL)
-- 실행 순서:
--   1) 이 파일을 SQL Editor에서 실행 (멱등 — 여러 번 실행 가능)
--   2) Dashboard → Settings → API → "Exposed schemas"에 `fit` 추가 (PostgREST가 fit.* 를 노출해야 supabase-js로 접근 가능)
--   3) .env.local: SUPABASE_SERVICE_ROLE_KEY(talentfolio 프로젝트) 설정, FIT_ANALYZER_SUPABASE_* 제거
--   4) 기존 데이터 이전이 필요하면 파일 하단 "데이터 이전" 절차 참고
--
-- 설계 원칙:
--   - talentfolio의 public.profiles / auth.users 는 손대지 않는다. fit.* 는 파생·운영 데이터만 담는다.
--   - user_id 는 auth.users.id 를 text 로 저장한다 (기존 guest-* 레코드 호환). RLS는 auth.uid()::text 비교.
--   - RLS 활성화: authenticated 는 자기 user_id 행만 조회, 쓰기는 service_role(백엔드)만.
--     => 백엔드(orchestrator/mcp-server)는 service_role 로 접근하므로 RLS를 우회한다.
--        HTTP 라우트는 JWT 에서 추출한 userId 로 소유권을 검사한다 (orchestrator/src/lib/auth.ts).
-- =====================================================================

-- vector 는 public 이 아니라 extensions 스키마에 둔다 (확장 함수가 /rest/v1/rpc 로 노출되는 것과 이름 충돌 방지).
-- 이미 public 에 만든 프로젝트는 Supabase 마이그레이션 move_vector_extension_to_extensions_schema 로 옮겼다 (2026-10-20).
create extension if not exists vector with schema extensions;

create schema if not exists fit;

grant usage on schema fit to service_role, authenticated, anon;
alter default privileges in schema fit grant all on tables to service_role;
alter default privileges in schema fit grant all on functions to service_role;
alter default privileges in schema fit grant all on sequences to service_role;

-- 공용 updated_at 트리거 함수 (public.set_updated_at 와 충돌 없음)
create or replace function fit.set_updated_at()
returns trigger
language plpgsql
set search_path = ''   -- 어드바이저 function_search_path_mutable. now() 는 pg_catalog 라 영향 없음
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- enum 타입 (create type 은 if not exists 가 없으므로 DO 블록)
-- ---------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace where t.typname = 'fit_report_status' and n.nspname = 'fit') then
    create type fit.fit_report_status as enum ('queued','processing','completed','pending_review','approved','rejected','expired');
  end if;
  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace where t.typname = 'sourcing_action_status' and n.nspname = 'fit') then
    create type fit.sourcing_action_status as enum ('pending','approved','rejected','executed','failed');
  end if;
  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace where t.typname = 'jd_run_status' and n.nspname = 'fit') then
    create type fit.jd_run_status as enum ('draft','analyzed','shortlisted','synced');
  end if;
end $$;

-- ---------------------------------------------------------------------
-- fit_reports (001)
-- ---------------------------------------------------------------------
create table if not exists fit.fit_reports (
  id uuid primary key default gen_random_uuid(),
  job_id text not null unique,
  jd text not null,
  jd_hash text not null,
  candidate_id text not null,
  candidate_name text,
  user_id text not null,
  status fit.fit_report_status not null default 'queued',
  report jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists fit_reports_status_idx on fit.fit_reports (status);
create index if not exists fit_reports_user_id_idx on fit.fit_reports (user_id);
create index if not exists fit_reports_jd_hash_candidate_idx on fit.fit_reports (jd_hash, candidate_id);

-- ---------------------------------------------------------------------
-- portfolio_chunks (006) + match_portfolio_chunks RPC
-- ---------------------------------------------------------------------
create table if not exists fit.portfolio_chunks (
  id uuid primary key default gen_random_uuid(),
  candidate_id text not null,
  source_field text not null,
  chunk_index int not null,
  content text not null,
  embedding vector(768),
  content_hash text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists portfolio_chunks_candidate_field_index
  on fit.portfolio_chunks (candidate_id, source_field, chunk_index);
create index if not exists portfolio_chunks_embedding_idx
  on fit.portfolio_chunks using hnsw (embedding vector_cosine_ops);

create or replace function fit.match_portfolio_chunks(
  query_embedding vector(768),
  match_candidate_id text,
  match_count int
)
returns table (
  id uuid,
  candidate_id text,
  source_field text,
  chunk_index int,
  content text,
  content_hash text,
  similarity float
)
language sql stable
set search_path = fit, extensions
as $$
  select
    id, candidate_id, source_field, chunk_index, content, content_hash,
    1 - (embedding <=> query_embedding) as similarity
  from fit.portfolio_chunks
  where candidate_id = match_candidate_id
    and embedding is not null
  order by embedding <=> query_embedding
  limit match_count;
$$;
revoke execute on function fit.match_portfolio_chunks(vector(768), text, int) from public, anon, authenticated;
grant execute on function fit.match_portfolio_chunks(vector(768), text, int) to service_role;

-- ---------------------------------------------------------------------
-- sourcing_actions (007)
-- ---------------------------------------------------------------------
create table if not exists fit.sourcing_actions (
  id uuid primary key default gen_random_uuid(),
  type text not null,
  payload jsonb not null,
  status fit.sourcing_action_status not null default 'pending',
  result jsonb,
  user_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists sourcing_actions_status_idx on fit.sourcing_actions (status);
create index if not exists sourcing_actions_user_id_idx on fit.sourcing_actions (user_id);

-- ---------------------------------------------------------------------
-- notion_integrations / jd_runs / candidate_assessments / notion_sync_records (008)
-- ---------------------------------------------------------------------
create table if not exists fit.notion_integrations (
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
create index if not exists notion_integrations_user_id_idx on fit.notion_integrations (user_id);

create table if not exists fit.jd_runs (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  jd_hash text not null,
  jd_text text not null,
  plan_snapshot jsonb,
  status fit.jd_run_status not null default 'analyzed',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists jd_runs_user_id_idx on fit.jd_runs (user_id);
create index if not exists jd_runs_jd_hash_idx on fit.jd_runs (jd_hash);
create unique index if not exists jd_runs_user_jd_hash_uidx on fit.jd_runs (user_id, jd_hash);

create table if not exists fit.candidate_assessments (
  id uuid primary key default gen_random_uuid(),
  jd_run_id uuid not null references fit.jd_runs (id) on delete cascade,
  candidate_id text not null,
  candidate_name text,
  overall_score integer not null,
  verdict text not null,
  matched_skills text[] not null default '{}',
  missing_skills text[] not null default '{}',
  ceo_summary text,
  tech_summary text,
  experience_summary text,
  fit_report_id uuid references fit.fit_reports (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (jd_run_id, candidate_id)
);
create index if not exists candidate_assessments_jd_run_id_idx on fit.candidate_assessments (jd_run_id);
create index if not exists candidate_assessments_candidate_id_idx on fit.candidate_assessments (candidate_id);

create table if not exists fit.notion_sync_records (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  candidate_id text not null,
  jd_run_id uuid not null references fit.jd_runs (id) on delete cascade,
  notion_page_id text not null,
  last_synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, candidate_id, jd_run_id)
);
create index if not exists notion_sync_records_user_id_idx on fit.notion_sync_records (user_id);

-- ---------------------------------------------------------------------
-- slack_channel_configs (009)
-- ---------------------------------------------------------------------
create table if not exists fit.slack_channel_configs (
  slack_channel_id text primary key,
  user_id text not null,
  jd_text text not null,
  enabled boolean not null default true,
  max_analyze int not null default 5,
  inviter_slack_user_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_slack_channel_configs_user_id on fit.slack_channel_configs (user_id);

-- ---------------------------------------------------------------------
-- job_postings (신규): 크롤러가 적재하는 채용공고 원본. /api/analyze 의 jd 입력 소스.
-- job_postings_staging (신규): COPY 전용. 제약/인덱스 없음, UNLOGGED (WAL 생략 → 적재 속도).
-- ---------------------------------------------------------------------
create table if not exists fit.job_postings (
  id uuid primary key default gen_random_uuid(),
  source text not null,                 -- 'saramin_api' | 'crawl4ai:<site>' | 'greenhouse' ...
  external_id text not null,            -- 소스 내 고유 ID
  url text,
  company text,
  title text not null,
  description text,                     -- 정제된 plain/markdown JD 본문 (LLM 입력)
  skills text[] not null default '{}',
  location text,
  employment_type text,
  experience_level text,
  salary text,
  posted_at timestamptz,
  expires_at timestamptz,
  raw jsonb,                            -- 소스 원본(prune 전). LLM에 직접 주입 금지 (절대 규칙 3)
  content_hash text not null,           -- title+company+description 해시 — 변경 감지
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source, external_id)
);
create index if not exists job_postings_source_idx on fit.job_postings (source);
create index if not exists job_postings_posted_at_idx on fit.job_postings (posted_at desc nulls last);
create index if not exists job_postings_skills_gin on fit.job_postings using gin (skills);
create index if not exists job_postings_title_trgm on fit.job_postings using gin (to_tsvector('simple', coalesce(title,'') || ' ' || coalesce(company,'')));

-- 제약·인덱스·FK 없음. NOT NULL 도 두지 않는다. 걸러내는 일은 merge_job_postings() 가 한다.
create unlogged table if not exists fit.job_postings_staging (
  load_batch_id text,
  source text,
  external_id text,
  url text,
  company text,
  title text,
  description text,
  skills text[],
  location text,
  employment_type text,
  experience_level text,
  salary text,
  posted_at timestamptz,
  expires_at timestamptz,
  raw jsonb,
  content_hash text
);

-- staging → production upsert. 크롤러가 COPY 후 호출한다. 반환: (inserted, updated, skipped)
create or replace function fit.merge_job_postings(p_batch_id text)
returns table (inserted bigint, updated bigint, skipped bigint)
language plpgsql
set search_path = fit, public
as $$
declare
  v_inserted bigint := 0;
  v_updated bigint := 0;
  v_total bigint := 0;
begin
  create temp table _dedup on commit drop as
  select distinct on (source, external_id) *
  from fit.job_postings_staging
  where load_batch_id = p_batch_id
    and title is not null and title <> ''
    and content_hash is not null
  order by source, external_id, posted_at desc nulls last;

  select count(*) into v_total from _dedup;

  with upserted as (
    insert into fit.job_postings as p (
      source, external_id, url, company, title, description, skills, location,
      employment_type, experience_level, salary, posted_at, expires_at, raw, content_hash
    )
    select
      source, external_id, url, company, title, description, coalesce(skills, '{}'), location,
      employment_type, experience_level, salary, posted_at, expires_at, raw, content_hash
    from _dedup
    on conflict (source, external_id) do update set
      url = excluded.url,
      company = excluded.company,
      title = excluded.title,
      description = excluded.description,
      skills = excluded.skills,
      location = excluded.location,
      employment_type = excluded.employment_type,
      experience_level = excluded.experience_level,
      salary = excluded.salary,
      posted_at = coalesce(excluded.posted_at, p.posted_at),
      expires_at = excluded.expires_at,
      raw = excluded.raw,
      content_hash = excluded.content_hash,
      last_seen_at = now(),
      updated_at = case when p.content_hash is distinct from excluded.content_hash then now() else p.updated_at end
    returning (xmax = 0) as is_insert
  )
  select
    count(*) filter (where is_insert),
    count(*) filter (where not is_insert)
  into v_inserted, v_updated
  from upserted;

  delete from fit.job_postings_staging where load_batch_id = p_batch_id;

  return query select v_inserted, v_updated, (v_total - v_inserted - v_updated);
end;
$$;
revoke execute on function fit.merge_job_postings(text) from public, anon, authenticated;
grant execute on function fit.merge_job_postings(text) to service_role;

-- ---------------------------------------------------------------------
-- updated_at 트리거 (멱등)
-- ---------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array[
    'fit_reports','portfolio_chunks','sourcing_actions','notion_integrations',
    'jd_runs','candidate_assessments','notion_sync_records','slack_channel_configs','job_postings'
  ] loop
    execute format('drop trigger if exists %I_set_updated_at on fit.%I', t, t);
    execute format('create trigger %I_set_updated_at before update on fit.%I for each row execute function fit.set_updated_at()', t, t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- RLS: 005에서 껐던 것을 다시 켠다. service_role 은 RLS 우회. authenticated 는 본인 행 SELECT 만.
--      쓰기는 전부 백엔드(service_role)에서만 일어난다 → INSERT/UPDATE 정책을 만들지 않는다.
-- ---------------------------------------------------------------------
alter table fit.fit_reports enable row level security;
alter table fit.portfolio_chunks enable row level security;
alter table fit.sourcing_actions enable row level security;
alter table fit.notion_integrations enable row level security;
alter table fit.jd_runs enable row level security;
alter table fit.candidate_assessments enable row level security;
alter table fit.notion_sync_records enable row level security;
alter table fit.slack_channel_configs enable row level security;
alter table fit.job_postings enable row level security;
alter table fit.job_postings_staging enable row level security;

drop policy if exists fit_reports_select_own on fit.fit_reports;
create policy fit_reports_select_own on fit.fit_reports
  for select to authenticated using (user_id = auth.uid()::text);

drop policy if exists sourcing_actions_select_own on fit.sourcing_actions;
create policy sourcing_actions_select_own on fit.sourcing_actions
  for select to authenticated using (user_id = auth.uid()::text);

drop policy if exists jd_runs_select_own on fit.jd_runs;
create policy jd_runs_select_own on fit.jd_runs
  for select to authenticated using (user_id = auth.uid()::text);

drop policy if exists candidate_assessments_select_own on fit.candidate_assessments;
create policy candidate_assessments_select_own on fit.candidate_assessments
  for select to authenticated using (
    exists (select 1 from fit.jd_runs r where r.id = jd_run_id and r.user_id = auth.uid()::text)
  );

drop policy if exists slack_channel_configs_select_own on fit.slack_channel_configs;
create policy slack_channel_configs_select_own on fit.slack_channel_configs
  for select to authenticated using (user_id = auth.uid()::text);

-- notion_integrations 는 access_token 을 담으므로 authenticated 에게도 노출하지 않는다 (정책 없음 = 거부).
-- portfolio_chunks / notion_sync_records / staging 도 백엔드 전용 (정책 없음).

-- job_postings 는 로그인 사용자 전원이 읽을 수 있다 (공개 채용공고).
drop policy if exists job_postings_select_authenticated on fit.job_postings;
create policy job_postings_select_authenticated on fit.job_postings
  for select to authenticated using (true);

-- 테이블 권한: authenticated 는 SELECT 만 (RLS로 다시 제한), service_role 은 전부.
grant select on all tables in schema fit to authenticated;
grant all on all tables in schema fit to service_role;
grant all on all sequences in schema fit to service_role;
revoke all on fit.notion_integrations from authenticated;
revoke all on fit.portfolio_chunks from authenticated;
revoke all on fit.notion_sync_records from authenticated;
revoke all on fit.job_postings_staging from authenticated;

-- =====================================================================
-- 데이터 이전 (구 fit-analyzer DB → talentfolio DB fit 스키마) — 로컬 터미널에서 1회
--
--   pg_dump "<OLD_DB_URL>" --data-only --no-owner --no-privileges \
--     -t public.fit_reports -t public.portfolio_chunks -t public.sourcing_actions \
--     -t public.notion_integrations -t public.jd_runs -t public.candidate_assessments \
--     -t public.notion_sync_records -t public.slack_channel_configs \
--     | sed 's/^COPY public\./COPY fit./; s/^INSERT INTO public\./INSERT INTO fit./' \
--     | psql "<NEW_DB_URL>"
--
--   * enum 컬럼은 텍스트 리터럴로 덤프되므로 fit.* enum 에 그대로 캐스팅된다.
--   * jd_runs → candidate_assessments → notion_sync_records 순서는 pg_dump 가 FK 순으로 정렬한다.
--   * 이전 후 count(*) 를 양쪽에서 비교하고 나서 구 프로젝트를 pause 한다.
-- =====================================================================

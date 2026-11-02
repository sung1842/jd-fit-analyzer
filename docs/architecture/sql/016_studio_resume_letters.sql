-- =====================================================================
-- 016: 스튜디오(/studio) — 이력서 항목 · 자기소개서 · 공고 문항 · 공고 핀 · 공고 필터 컬럼. 2026-10-28
--
--   resume_basics            1:1 기본·희망 조건. public_fields = 기업에게 보일 필드 이름 목록 (그 외는 비공개)
--   resume_experiences 등    1:N 항목, 항목마다 visibility
--   cover_letters            kind base(사용자당 1개, 기업 탐색용) | posting(공고별 버전, 본인만)
--   cover_letter_items       문항 + 답 + 근거 카드 id
--   posting_essay_questions  공고별 자소서 문항 (사람이 기업 채용 홈페이지를 보고 입력. 자동 수집 안 함)
--   job_pins                 관심 / 지원할 곳 / 보류
--   job_postings 필터 컬럼    직군·경력·학력·고용형태·지역·마감·급여 공개 (병합 시 코드 규칙으로 채움)
--
-- 받지 않는 항목: 채용절차법 4조의3 (신체조건, 출신지역, 혼인, 재산, 가족 학력·직업·재산).
-- 민감정보(장애·보훈 등)는 별도 동의 설계 전까지 컬럼을 두지 않는다.
-- RLS: 본인만. 기업·매칭 경로는 public_* 뷰만 (공개 항목 + 유효한 matching 동의).
-- 적용 순서: 015 다음. 재실행 안전.
-- =====================================================================

-- 1) 이력서 기본·희망 조건
create table if not exists fit.resume_basics (
  user_id uuid primary key references auth.users (id) on delete cascade,
  headline text check (headline is null or char_length(headline) <= 120),
  email text check (email is null or char_length(email) <= 200),
  phone text check (phone is null or char_length(phone) <= 40),
  region_sido text check (region_sido is null or char_length(region_sido) <= 20),
  region_sigungu text check (region_sigungu is null or char_length(region_sigungu) <= 40),
  birth_year smallint check (birth_year is null or birth_year between 1940 and 2015),
  desired_categories text[] not null default '{}',      -- fit.job_categories.code
  desired_regions text[] not null default '{}',
  desired_employment_types text[] not null default '{}',
  desired_salary_text text check (desired_salary_text is null or char_length(desired_salary_text) <= 60),
  available_from date,
  job_search_status text not null default 'open' check (job_search_status in ('active','open','closed')),
  military_status text check (military_status is null or military_status in ('served','exempt','serving','not_applicable')),
  -- 기업에게 보일 필드. 연락처·생년·희망 연봉·병역은 기본 비공개(목록에 없음)
  public_fields text[] not null default '{headline,region_sido,desired_categories,desired_regions,desired_employment_types,job_search_status}',
  updated_at timestamptz not null default now()
);

-- 2) 1:N 이력서 항목
create table if not exists fit.resume_experiences (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  company text not null check (char_length(company) between 1 and 120),
  department text check (department is null or char_length(department) <= 120),
  position_title text check (position_title is null or char_length(position_title) <= 120),
  employment_type text check (employment_type is null or char_length(employment_type) <= 40),
  start_on date not null,
  end_on date,
  is_current boolean not null default false,
  duties text check (duties is null or char_length(duties) <= 2000),
  achievements text check (achievements is null or char_length(achievements) <= 2000),
  card_ids uuid[] not null default '{}',                -- 근거 카드 연결
  visibility text not null default 'public' check (visibility in ('private','public')),
  sort smallint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_on is null or end_on >= start_on)
);

create table if not exists fit.resume_educations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  school text not null check (char_length(school) between 1 and 120),
  major text check (major is null or char_length(major) <= 120),
  degree text not null default 'bachelor' check (degree in ('high','associate','bachelor','master','doctor','other')),
  status text not null default 'graduated' check (status in ('graduated','expected','enrolled','leave','dropped')),
  start_on date,
  end_on date,
  gpa text check (gpa is null or char_length(gpa) <= 20),
  visibility text not null default 'public' check (visibility in ('private','public')),
  sort smallint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists fit.resume_certifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null default 'license' check (kind in ('license','language')),  -- 자격증 | 어학
  name text not null check (char_length(name) between 1 and 120),       -- 자격명 / 시험명
  issuer text check (issuer is null or char_length(issuer) <= 120),
  score text check (score is null or char_length(score) <= 40),          -- 어학 점수·등급
  acquired_on date,
  evidence_url text check (evidence_url is null or evidence_url ~ '^https?://'),
  visibility text not null default 'public' check (visibility in ('private','public')),
  sort smallint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists fit.resume_misc (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('project','award','training','activity')),
  title text not null check (char_length(title) between 1 and 160),
  org text check (org is null or char_length(org) <= 120),
  start_on date,
  end_on date,
  description text check (description is null or char_length(description) <= 2000),
  url text check (url is null or url ~ '^https?://'),
  card_ids uuid[] not null default '{}',
  visibility text not null default 'public' check (visibility in ('private','public')),
  sort smallint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists resume_experiences_user_idx on fit.resume_experiences (user_id, sort);
create index if not exists resume_educations_user_idx on fit.resume_educations (user_id, sort);
create index if not exists resume_certifications_user_idx on fit.resume_certifications (user_id, sort);
create index if not exists resume_misc_user_idx on fit.resume_misc (user_id, kind, sort);

-- 3) 공고별 자소서 문항 (사람 입력)
create table if not exists fit.posting_essay_questions (
  id uuid primary key default gen_random_uuid(),
  job_posting_id uuid not null references fit.job_postings (id) on delete cascade,
  seq smallint not null check (seq between 1 and 20),
  question text not null check (char_length(question) between 1 and 1000),
  char_limit integer check (char_limit is null or char_limit between 1 and 10000),
  source text not null default 'company_page' check (source in ('company_page','manual')),
  source_url text check (source_url is null or source_url ~ '^https?://'),
  entered_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (job_posting_id, seq)
);

-- 4) 자기소개서
create table if not exists fit.cover_letters (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('base','posting')),
  job_posting_id uuid references fit.job_postings (id) on delete set null,
  title text not null check (char_length(title) between 1 and 160),
  visibility text not null default 'private' check (visibility in ('private','public')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (kind = 'base' or visibility = 'private'),            -- 공고별 버전은 본인만
  check (kind = 'posting' or job_posting_id is null)
);
create unique index if not exists cover_letters_one_base_idx on fit.cover_letters (user_id) where kind = 'base';
create index if not exists cover_letters_user_idx on fit.cover_letters (user_id, updated_at desc);

create table if not exists fit.cover_letter_items (
  id uuid primary key default gen_random_uuid(),
  letter_id uuid not null references fit.cover_letters (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  seq smallint not null check (seq between 1 and 20),
  question_id uuid references fit.posting_essay_questions (id) on delete set null,
  question_text text not null check (char_length(question_text) between 1 and 1000),
  char_limit integer check (char_limit is null or char_limit between 1 and 10000),
  answer text not null default '' check (char_length(answer) <= 10000),
  cited_card_ids uuid[] not null default '{}',
  updated_at timestamptz not null default now(),
  unique (letter_id, seq)
);

-- 5) 공고 핀
create table if not exists fit.job_pins (
  user_id uuid not null references auth.users (id) on delete cascade,
  job_posting_id uuid not null references fit.job_postings (id) on delete cascade,
  lane text not null check (lane in ('watch','apply','hold')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, job_posting_id)
);

-- 6) 공고 필터 컬럼 (orchestrator crawlReview 병합 시 lib/postingFacets.ts 규칙으로 채움)
alter table fit.job_postings
  add column if not exists category_codes text[] not null default '{}',
  add column if not exists career_min smallint,
  add column if not exists career_max smallint,
  add column if not exists newcomer_ok boolean,
  add column if not exists education_level text check (education_level is null or education_level in ('any','high','associate','bachelor','master','doctor')),
  add column if not exists employment_types text[] not null default '{}',
  add column if not exists region_sido text,
  add column if not exists region_sigungu text[] not null default '{}',
  add column if not exists deadline_type text check (deadline_type is null or deadline_type in ('date','rolling','until_filled','unknown')),
  add column if not exists salary_disclosed boolean;
create index if not exists job_postings_category_gin on fit.job_postings using gin (category_codes);
create index if not exists job_postings_region_idx on fit.job_postings (region_sido);
create index if not exists job_postings_employment_gin on fit.job_postings using gin (employment_types);

-- 7) updated_at
do $$
declare t text;
begin
  foreach t in array array['resume_basics','resume_experiences','resume_educations','resume_certifications','resume_misc',
                           'cover_letters','cover_letter_items','job_pins']
  loop
    execute format('drop trigger if exists %I on fit.%I', t || '_set_updated_at', t);
    execute format('create trigger %I before update on fit.%I for each row execute function fit.set_updated_at()', t || '_set_updated_at', t);
  end loop;
end $$;

-- 8) RLS: 본인만 (문항은 로그인 사용자 읽기 + 본인이 넣은 것만 수정)
do $$
declare t text;
begin
  foreach t in array array['resume_basics','resume_experiences','resume_educations','resume_certifications','resume_misc',
                           'cover_letters','cover_letter_items','job_pins']
  loop
    execute format('alter table fit.%I enable row level security', t);
    execute format('drop policy if exists %I on fit.%I', t || '_owner', t);
    execute format('create policy %I on fit.%I for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid())', t || '_owner', t);
  end loop;
end $$;
alter table fit.posting_essay_questions enable row level security;
drop policy if exists posting_essay_questions_read on fit.posting_essay_questions;
create policy posting_essay_questions_read on fit.posting_essay_questions for select to authenticated using (true);
drop policy if exists posting_essay_questions_write on fit.posting_essay_questions;
create policy posting_essay_questions_write on fit.posting_essay_questions for all to authenticated
  using (entered_by = auth.uid()) with check (entered_by = auth.uid());

-- 9) 기업·매칭 경로용 공개 뷰 (공개 항목 + 유효한 matching 동의). 연락처·생년·병역은 넣지 않는다
create or replace view fit.public_resumes as
select b.user_id,
       case when 'headline' = any (b.public_fields) then b.headline end as headline,
       case when 'region_sido' = any (b.public_fields) then b.region_sido end as region_sido,
       case when 'desired_categories' = any (b.public_fields) then b.desired_categories else '{}' end as desired_categories,
       case when 'desired_regions' = any (b.public_fields) then b.desired_regions else '{}' end as desired_regions,
       case when 'desired_employment_types' = any (b.public_fields) then b.desired_employment_types else '{}' end as desired_employment_types,
       case when 'job_search_status' = any (b.public_fields) then b.job_search_status end as job_search_status,
       coalesce((select jsonb_agg(jsonb_build_object('company', e.company, 'position', e.position_title, 'start', e.start_on,
                                                      'end', e.end_on, 'current', e.is_current, 'duties', e.duties,
                                                      'achievements', e.achievements) order by e.sort, e.start_on desc)
                 from fit.resume_experiences e where e.user_id = b.user_id and e.visibility = 'public'), '[]') as experiences,
       coalesce((select jsonb_agg(jsonb_build_object('school', d.school, 'major', d.major, 'degree', d.degree, 'status', d.status,
                                                      'end', d.end_on) order by d.sort)
                 from fit.resume_educations d where d.user_id = b.user_id and d.visibility = 'public'), '[]') as educations,
       coalesce((select jsonb_agg(jsonb_build_object('kind', c.kind, 'name', c.name, 'issuer', c.issuer, 'score', c.score,
                                                      'acquired', c.acquired_on) order by c.sort)
                 from fit.resume_certifications c where c.user_id = b.user_id and c.visibility = 'public'), '[]') as certifications,
       coalesce((select jsonb_agg(jsonb_build_object('kind', m.kind, 'title', m.title, 'org', m.org, 'description', m.description,
                                                      'url', m.url) order by m.kind, m.sort)
                 from fit.resume_misc m where m.user_id = b.user_id and m.visibility = 'public'), '[]') as misc
from fit.resume_basics b
where exists (select 1 from fit.consents k where k.user_id = b.user_id and k.purpose = 'matching' and k.revoked_at is null);

create or replace view fit.public_cover_letters as
select l.id, l.user_id, l.title, l.updated_at,
       coalesce((select jsonb_agg(jsonb_build_object('question', i.question_text, 'answer', i.answer) order by i.seq)
                 from fit.cover_letter_items i where i.letter_id = l.id), '[]') as items
from fit.cover_letters l
where l.kind = 'base' and l.visibility = 'public'
  and exists (select 1 from fit.consents k where k.user_id = l.user_id and k.purpose = 'matching' and k.revoked_at is null);

-- 10) GRANT
grant select, insert, update, delete on
  fit.resume_basics, fit.resume_experiences, fit.resume_educations, fit.resume_certifications, fit.resume_misc,
  fit.cover_letters, fit.cover_letter_items, fit.job_pins, fit.posting_essay_questions
  to authenticated;
grant all on
  fit.resume_basics, fit.resume_experiences, fit.resume_educations, fit.resume_certifications, fit.resume_misc,
  fit.cover_letters, fit.cover_letter_items, fit.job_pins, fit.posting_essay_questions
  to service_role;
grant select on fit.job_categories to authenticated;
-- 공개 뷰: 매칭 경로(service_role)와 로그인 사용자(기업 화면). anon(비로그인)에는 주지 않는다
grant select on fit.public_resumes, fit.public_cover_letters to service_role, authenticated;

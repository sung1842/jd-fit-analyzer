-- =====================================================================
-- 011. 플랫폼별 공고 테이블 + 플랫폼별 직군 분류 + 길이 제약 (CHECK)
--
-- 실행 대상: talentfolio Supabase 프로젝트의 `fit` 스키마 (010 적용 이후). 멱등.
--
-- 설계 (사용자 확정 2026-10-24):
--   - 플랫폼마다 공고 스타일이 달라 **플랫폼별 테이블**에 그 플랫폼의 값을 그대로(문자열) 저장한다.
--       fit.saramin_postings  (다음 플랫폼은 fit.<platform>_postings 로 같은 패턴 추가)
--   - 공통(정규화) 테이블 fit.job_postings 는 분석 쪽(/api/analyze 등)이 읽는 단일 소스로 유지한다.
--       플랫폼 테이블 → 공통 테이블 병합은 아직 구현하지 않았다 (job_posting_id 는 병합 전까지 NULL).
--   - 직군 분류는 플랫폼마다 다르므로 fit.job_categories 가 platform 을 가진다 (사이트 검색 필터 기준).
--       한 공고가 여러 직군에 걸칠 수 있어 연결 테이블(다대다)로 잇는다.
--   - 길이 제약은 3중 방어의 마지막 줄: (1) Gemini 스키마 maxItems  (2) 코드(zod) 검증 + 재시도 1회  (3) 이 CHECK.
--       Gemini 는 maxLength 를 무시하므로(공식 문서) 글자 수는 (2)(3) 이 책임진다.
--       상수는 mcp-server/src/lib/jdCompress.ts 의 JD_LIMITS 와 반드시 같게 유지할 것.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 공용: text[] 의 모든 원소 길이 검사 (CHECK 안에서는 서브쿼리를 못 쓰므로 함수로 감싼다)
-- ---------------------------------------------------------------------
create or replace function fit.text_array_max_len(arr text[], max_len int)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select coalesce(bool_and(char_length(x) <= max_len), true) from unnest(arr) as x
$$;

-- ---------------------------------------------------------------------
-- job_categories: 플랫폼별 직군(대분류/중분류). 부모는 같은 플랫폼 안에서만 가능(복합 FK).
-- ---------------------------------------------------------------------
create table if not exists fit.job_categories (
  id bigint generated always as identity primary key,
  platform text not null check (platform ~ '^[a-z0-9_]{2,30}$'),
  code text not null check (code ~ '^[a-z0-9_]{2,60}$'),   -- 우리가 정한 슬러그. 플랫폼 안에서 유일
  name text not null check (char_length(name) between 1 and 60), -- 플랫폼 화면에 보이는 이름 (예: IT개발·데이터)
  parent_id bigint,
  site_code text,                                           -- 플랫폼의 실제 코드값(검색 파라미터). 미확인이면 NULL
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  unique (platform, code),
  unique (id, platform),
  foreign key (parent_id, platform) references fit.job_categories (id, platform) on delete restrict
);
create unique index if not exists job_categories_top_name_uq
  on fit.job_categories (platform, name) where parent_id is null;

-- 사람인 대분류 21개 — 사용자가 제공한 사이트 필터 화면(2026-10-24) 기준. site_code 는 실제 값을 확인하지 못해 NULL.
insert into fit.job_categories (platform, code, name, sort_order) values
  ('saramin', 'planning_strategy',      '기획·전략',        1),
  ('saramin', 'marketing_pr_research',  '마케팅·홍보·조사', 2),
  ('saramin', 'accounting_tax_finance', '회계·세무·재무',   3),
  ('saramin', 'hr_labor_hrd',           '인사·노무·HRD',    4),
  ('saramin', 'admin_legal_office',     '총무·법무·사무',   5),
  ('saramin', 'it_dev_data',            'IT개발·데이터',    6),
  ('saramin', 'design',                 '디자인',           7),
  ('saramin', 'sales_trade',            '영업·판매·무역',   8),
  ('saramin', 'cs_tm',                  '고객상담·TM',      9),
  ('saramin', 'purchasing_logistics',   '구매·자재·물류',  10),
  ('saramin', 'product_planning_md',    '상품기획·MD',     11),
  ('saramin', 'driving_delivery',       '운전·운송·배송',  12),
  ('saramin', 'service',                '서비스',          13),
  ('saramin', 'production',             '생산',            14),
  ('saramin', 'construction',           '건설·건축',       15),
  ('saramin', 'medical',                '의료',            16),
  ('saramin', 'research_rnd',           '연구·R&D',        17),
  ('saramin', 'education',              '교육',            18),
  ('saramin', 'media_culture_sports',   '미디어·문화·스포츠', 19),
  ('saramin', 'finance_insurance',      '금융·보험',       20),
  ('saramin', 'public_welfare',         '공공·복지',       21)
on conflict (platform, code) do nothing;

-- ---------------------------------------------------------------------
-- saramin_postings: 사람인 공고. 사이트에 보이는 값은 문자열 그대로 보존한다(급여 "면접 후 결정" 등).
-- ---------------------------------------------------------------------
create table if not exists fit.saramin_postings (
  id uuid primary key default gen_random_uuid(),
  rec_idx text not null unique,                       -- 사람인 공고 ID (공고 URL 의 rec_idx)
  job_posting_id uuid unique references fit.job_postings (id) on delete set null,  -- 공통 테이블 연결. 병합 전 NULL

  url text not null check (url ~ '^https?://'),       -- 직접 열어 보기·예외 처리용
  company text,
  title text not null check (char_length(btrim(title)) > 0),

  -- 사이트에 표시된 값 그대로 (전부 문자열)
  career_text text,                                   -- 경력
  education_text text,                                -- 학력
  employment_type_text text,                          -- 근무형태
  salary_text text,                                   -- 급여 (숫자 아님)
  location_text text,                                 -- 근무지역
  position_text text,                                 -- 직급/직책
  work_hours_text text,                               -- 근무일시
  workplace_address text,
  deadline_date date,                                 -- 파싱된 마감일. 상시채용이면 NULL
  deadline_text text,                                 -- '~ 11/12(목)', '상시채용' 등 사이트 문구

  -- 본문: 이미지는 저장하지 않는다. 텍스트 본문과 그 압축본만.
  body_text text check (body_text is null or char_length(body_text) <= 20000),
  body_image_count smallint not null default 0 check (body_image_count >= 0),
  body_text_missing boolean not null default false,   -- 핵심 키워드(주요업무/자격요건 등)가 본문 텍스트에 없음 → 이미지형 의심

  role_summary text check (role_summary is null or char_length(role_summary) <= 200),
  key_duties text[] not null default '{}',
  must_have text[] not null default '{}',
  nice_to_have text[] not null default '{}',
  skills text[] not null default '{}',                -- 컴퓨터/IT 기술 이름만 (Spring, Java, Next.js ...)
  compressed_text text check (compressed_text is null or char_length(compressed_text) <= 350),
  compress_status text check (compress_status is null or compress_status in ('ok','retried_ok','truncated','skipped')),

  -- 빈 값 처리 (원인 3분류 + 출처 기록)
  missing_fields jsonb not null default '{}'::jsonb,  -- {"salary_text":"not_in_source", ...}  원인: by_design | fetch_failed | extract_failed | not_in_source
  field_sources jsonb not null default '{}'::jsonb,   -- 크롤 직접값이 아닌 보충값의 출처. {"salary_text":"body_regex"}
  review_status text not null default 'ok' check (review_status in ('ok','retry_later','needs_review','resolved')),
  review_note text check (review_note is null or char_length(review_note) <= 500),

  search_keyword text,
  content_hash text,
  raw jsonb,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- 배열: 항목 수 ≤ 50, 항목당 길이 제한 (JD_LIMITS 와 동일)
  constraint saramin_key_duties_limit  check (cardinality(key_duties)  <= 50 and fit.text_array_max_len(key_duties, 200)),
  constraint saramin_must_have_limit   check (cardinality(must_have)   <= 50 and fit.text_array_max_len(must_have, 200)),
  constraint saramin_nice_to_have_limit check (cardinality(nice_to_have) <= 50 and fit.text_array_max_len(nice_to_have, 200)),
  constraint saramin_skills_limit      check (cardinality(skills)      <= 50 and fit.text_array_max_len(skills, 60))
);
create index if not exists saramin_postings_review_idx on fit.saramin_postings (review_status) where review_status <> 'ok';
create index if not exists saramin_postings_skills_gin on fit.saramin_postings using gin (skills);
create index if not exists saramin_postings_deadline_idx on fit.saramin_postings (deadline_date);

-- ---------------------------------------------------------------------
-- saramin_posting_categories: 사람인 공고 ↔ 사람인 직군 (다대다). platform 고정 컬럼 + 복합 FK 로 타 플랫폼 직군 혼입을 막는다.
-- ---------------------------------------------------------------------
create table if not exists fit.saramin_posting_categories (
  posting_id uuid not null references fit.saramin_postings (id) on delete cascade,
  category_id bigint not null,
  platform text not null default 'saramin' check (platform = 'saramin'),
  assigned_by text not null check (assigned_by in ('site_filter','rule','llm','manual')),
  created_at timestamptz not null default now(),
  primary key (posting_id, category_id),
  foreign key (category_id, platform) references fit.job_categories (id, platform) on delete restrict
);
create index if not exists saramin_posting_categories_cat_idx on fit.saramin_posting_categories (category_id);

-- ---------------------------------------------------------------------
-- updated_at 트리거, RLS, 권한 (010 의 job_postings 와 같은 정책: 공개 공고는 로그인 사용자 SELECT, 쓰기는 service_role)
-- ---------------------------------------------------------------------
drop trigger if exists saramin_postings_set_updated_at on fit.saramin_postings;
create trigger saramin_postings_set_updated_at before update on fit.saramin_postings
  for each row execute function fit.set_updated_at();

alter table fit.job_categories enable row level security;
alter table fit.saramin_postings enable row level security;
alter table fit.saramin_posting_categories enable row level security;

drop policy if exists job_categories_select_authenticated on fit.job_categories;
create policy job_categories_select_authenticated on fit.job_categories for select to authenticated using (true);
drop policy if exists saramin_postings_select_authenticated on fit.saramin_postings;
create policy saramin_postings_select_authenticated on fit.saramin_postings for select to authenticated using (true);
drop policy if exists saramin_posting_categories_select_authenticated on fit.saramin_posting_categories;
create policy saramin_posting_categories_select_authenticated on fit.saramin_posting_categories for select to authenticated using (true);

grant select on fit.job_categories, fit.saramin_postings, fit.saramin_posting_categories to authenticated;
grant all on fit.job_categories, fit.saramin_postings, fit.saramin_posting_categories to service_role;
grant usage, select on all sequences in schema fit to service_role;
grant execute on function fit.text_array_max_len(text[], int) to service_role, authenticated;

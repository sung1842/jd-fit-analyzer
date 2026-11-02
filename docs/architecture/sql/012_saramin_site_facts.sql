-- =====================================================================
-- 012. 사람인 상세 팩트(복지·기업정보·근무스타일 Q&A)
--
-- 011 이 만든 fit.saramin_postings 에 컬럼만 추가한다. 멱등.
-- 값은 사이트 문자열 그대로(영어 키). 자격요건/우대사항 사이드바 원문은 넣지 않는다
-- (본문 불릿 → key_duties/must_have/nice_to_have).
-- 상한 500자는 카드/필터용. 본문 body_text(≤20000) 가 원본이다.
-- =====================================================================

alter table fit.saramin_postings
  add column if not exists welfare_insurance_text text check (welfare_insurance_text is null or char_length(welfare_insurance_text) <= 500),
  add column if not exists pay_system_text text check (pay_system_text is null or char_length(pay_system_text) <= 500),
  add column if not exists gifts_text text check (gifts_text is null or char_length(gifts_text) <= 500),
  add column if not exists education_life_text text check (education_life_text is null or char_length(education_life_text) <= 500),
  add column if not exists work_environment_text text check (work_environment_text is null or char_length(work_environment_text) <= 500),
  add column if not exists org_culture_text text check (org_culture_text is null or char_length(org_culture_text) <= 500),
  add column if not exists refresh_text text check (refresh_text is null or char_length(refresh_text) <= 500),
  add column if not exists apply_start_text text check (apply_start_text is null or char_length(apply_start_text) <= 200),
  add column if not exists apply_method_text text check (apply_method_text is null or char_length(apply_method_text) <= 200),
  add column if not exists ceo_name text check (ceo_name is null or char_length(ceo_name) <= 80),
  add column if not exists company_type_text text check (company_type_text is null or char_length(company_type_text) <= 200),
  add column if not exists industry_text text check (industry_text is null or char_length(industry_text) <= 200),
  add column if not exists employee_count_text text check (employee_count_text is null or char_length(employee_count_text) <= 80),
  add column if not exists founded_on_text text check (founded_on_text is null or char_length(founded_on_text) <= 80),
  add column if not exists revenue_text text check (revenue_text is null or char_length(revenue_text) <= 80),
  add column if not exists homepage text check (homepage is null or char_length(homepage) <= 300),
  add column if not exists company_address text check (company_address is null or char_length(company_address) <= 300),
  add column if not exists work_style_qna jsonb not null default '[]'::jsonb,
  add column if not exists extra_facts jsonb not null default '{}'::jsonb;

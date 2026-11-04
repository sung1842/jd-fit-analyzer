-- =====================================================================
-- 031: 기업 스카우트 건(fit.jd_runs)을 구직자 공고 목록(fit.job_postings)에 함께 올린다 (2026-11-03, 24 문서 C5).
--
-- 구직자 공고 목록·추천은 job_postings 하나만 읽는다 (talentfolio studioData.searchPostings, orchestrator jobRecommend).
-- 그래서 jd_runs 가 생기거나 바뀔 때 트리거로 job_postings 에 source='scout_case' 행을 맞춰 둔다.
--   - 어느 입구로 생긴 건이든 (JdMatchModal 자동 쇼트리스트, /api/scout-cases, Slack 채널) 한 곳에서 처리.
--   - 마감: 건 종료(closed_at) 또는 마감일(deadline) 다음 날 0시를 expires_at 으로 → 목록의 마감 필터가 숨긴다.
--   - 최신순: first_seen_at = 건 생성 시각 (목록 기본 정렬 기준).
-- Supabase SQL Editor 에서 한 번 실행. 여러 번 실행해도 안전 (마지막 update 가 기존 건을 채운다).
-- =====================================================================
create or replace function fit.sync_scout_case_posting()
returns trigger
language plpgsql security definer set search_path = fit, public as $$
declare
  t text;
  exp timestamptz;
begin
  if tg_op = 'DELETE' then
    delete from fit.job_postings where source = 'scout_case' and external_id = old.id::text;
    return old;
  end if;

  t := coalesce(nullif(trim(new.title), ''), nullif(trim(split_part(new.jd_text, E'\n', 1)), ''), '채용 공고');
  exp := case
    when new.closed_at is not null then new.closed_at
    when new.deadline is not null then (new.deadline + 1)::timestamptz
    else null
  end;

  insert into fit.job_postings (
    source, external_id, company, title, description, skills,
    career_min, career_max, posted_at, expires_at, deadline_type, content_hash, first_seen_at, last_seen_at
  ) values (
    'scout_case', new.id::text, coalesce(nullif(trim(new.client_name), ''), '비공개 기업'), left(t, 200), new.jd_text,
    coalesce(array(select i->>'label' from jsonb_array_elements(coalesce(new.requirements->'items', '[]'::jsonb)) i where i->>'label' is not null), '{}'),
    (new.requirements->>'years_min')::numeric::smallint, (new.requirements->>'years_max')::numeric::smallint,
    new.created_at, exp, case when new.deadline is not null then 'date' else 'until_filled' end,
    md5(coalesce(t, '') || new.jd_text), new.created_at, now()
  )
  on conflict (source, external_id) do update set
    company = excluded.company, title = excluded.title, description = excluded.description, skills = excluded.skills,
    career_min = excluded.career_min, career_max = excluded.career_max, expires_at = excluded.expires_at,
    deadline_type = excluded.deadline_type, content_hash = excluded.content_hash, last_seen_at = now(), updated_at = now();
  return new;
end $$;

drop trigger if exists sync_scout_case_posting on fit.jd_runs;
create trigger sync_scout_case_posting
  after insert or update of title, client_name, jd_text, requirements, deadline, closed_at or delete on fit.jd_runs
  for each row execute function fit.sync_scout_case_posting();

-- 기존 건 채우기 (트리거를 한 번씩 태운다)
update fit.jd_runs set closed_at = closed_at;

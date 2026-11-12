-- =====================================================================
-- 037: 스카우트 건 → 구직자 공고 노출을 "기업이 원할 때만"으로 바꾼다 (2026-11-11).
--
-- 031 은 모든 jd_runs 를 job_postings(source='scout_case')로 자동 복제했다.
-- 이제 jd_runs.posted_at 이 있는 건만 공고로 올리고, 없으면 공고 행을 지운다.
-- 기업은 건을 만들 때 또는 건 현황에서 "공고로 올리기"를 켠다 (POST /api/scout-cases/:id/post).
--
-- Supabase SQL Editor 에서 한 번 실행. 여러 번 실행해도 안전.
-- 실행 전에도 orchestrator 는 동작한다 (공고 토글만 실패하고 노출은 031 동작 그대로).
-- =====================================================================

alter table fit.jd_runs add column if not exists posted_at timestamptz; -- 공고로 올린 시각 (null = 비공개)

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

  -- 공고로 올리지 않은 건은 구직자 목록에서 뺀다
  if new.posted_at is null then
    delete from fit.job_postings where source = 'scout_case' and external_id = new.id::text;
    return new;
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
    new.posted_at, exp, case when new.deadline is not null then 'date' else 'until_filled' end,
    md5(coalesce(t, '') || new.jd_text), new.posted_at, now()
  )
  on conflict (source, external_id) do update set
    company = excluded.company, title = excluded.title, description = excluded.description, skills = excluded.skills,
    career_min = excluded.career_min, career_max = excluded.career_max, expires_at = excluded.expires_at,
    deadline_type = excluded.deadline_type, content_hash = excluded.content_hash, last_seen_at = now(), updated_at = now();
  return new;
end $$;

drop trigger if exists sync_scout_case_posting on fit.jd_runs;
create trigger sync_scout_case_posting
  after insert or update of title, client_name, jd_text, requirements, deadline, closed_at, posted_at or delete on fit.jd_runs
  for each row execute function fit.sync_scout_case_posting();

-- 기존 자동 복제분 정리: 올리겠다고 한 적 없는 건의 공고 행을 지운다
delete from fit.job_postings
where source = 'scout_case'
  and external_id not in (select id::text from fit.jd_runs where posted_at is not null);

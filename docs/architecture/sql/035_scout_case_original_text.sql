-- =====================================================================
-- 035: 구직자 공고 화면에는 기업이 입력한 원문 그대로 (2026-11-10).
--
-- jd_runs.jd_text 는 매칭용 표준 양식(주요업무·자격요건·우대사항 + [근무조건])이고 jd 해시의 원문이라 바꾸지 않는다.
-- 「JD 자동 분할 입력하기」로 붙여넣은 원문은 plan_snapshot.posting.original_text 에 따로 두고,
-- 031 트리거가 job_postings.description 을 채울 때 원문이 있으면 원문을 쓴다.
-- Supabase SQL Editor 에서 031 다음에 한 번 실행. 여러 번 실행해도 안전.
-- =====================================================================
create or replace function fit.sync_scout_case_posting()
returns trigger
language plpgsql security definer set search_path = fit, public as $$
declare
  t text;
  exp timestamptz;
  body text;
begin
  if tg_op = 'DELETE' then
    delete from fit.job_postings where source = 'scout_case' and external_id = old.id::text;
    return old;
  end if;

  t := coalesce(nullif(trim(new.title), ''), nullif(trim(split_part(new.jd_text, E'\n', 1)), ''), '채용 공고');
  body := coalesce(nullif(trim(new.plan_snapshot->'posting'->>'original_text'), ''), new.jd_text);
  exp := case
    when new.closed_at is not null then new.closed_at
    when new.deadline is not null then (new.deadline + 1)::timestamptz
    else null
  end;

  insert into fit.job_postings (
    source, external_id, company, title, description, skills,
    career_min, career_max, posted_at, expires_at, deadline_type, content_hash, first_seen_at, last_seen_at
  ) values (
    'scout_case', new.id::text, coalesce(nullif(trim(new.client_name), ''), '비공개 기업'), left(t, 200), body,
    coalesce(array(select i->>'label' from jsonb_array_elements(coalesce(new.requirements->'items', '[]'::jsonb)) i where i->>'label' is not null), '{}'),
    (new.requirements->>'years_min')::numeric::smallint, (new.requirements->>'years_max')::numeric::smallint,
    new.created_at, exp, case when new.deadline is not null then 'date' else 'until_filled' end,
    md5(coalesce(t, '') || body), new.created_at, now()
  )
  on conflict (source, external_id) do update set
    company = excluded.company, title = excluded.title, description = excluded.description, skills = excluded.skills,
    career_min = excluded.career_min, career_max = excluded.career_max, expires_at = excluded.expires_at,
    deadline_type = excluded.deadline_type, content_hash = excluded.content_hash, last_seen_at = now(), updated_at = now();
  return new;
end $$;

drop trigger if exists sync_scout_case_posting on fit.jd_runs;
create trigger sync_scout_case_posting
  after insert or update of title, client_name, jd_text, requirements, deadline, closed_at, plan_snapshot or delete on fit.jd_runs
  for each row execute function fit.sync_scout_case_posting();

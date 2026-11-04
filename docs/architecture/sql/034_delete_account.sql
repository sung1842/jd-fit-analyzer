-- =====================================================================
-- 034: 회원 탈퇴 시 본인 데이터 지우기 (2026-11-04, 앱스토어 계정 삭제 요구 + 개인정보 보호법 파기 의무).
--
-- talentfolio DELETE /api/account 가 본인 세션으로 fit.delete_my_account() 를 부른 뒤
-- 서비스 롤로 auth.users 를 지운다 (auth.users FK 가 on delete cascade 인 표는 거기서 한 번 더 지워진다).
-- 이 함수가 맡는 것: auth.users 에 FK 가 없는 표 — 후보로서 남은 기록(candidate_id)과 기업으로서 만든 기록(user_id).
--   fit·public 스키마에서 candidate_id / user_id 칼럼(uuid·text)을 가진 모든 표를 찾아 지운다
--   → 나중에 표가 늘어도 이 함수를 고칠 필요가 없다.
-- 남기는 것: status_events 같은 감사 기록은 actor 칼럼이라 대상 아님. 법정 보관 기록은 별도 보관소에 둔다.
-- Supabase SQL Editor 에서 한 번 실행. 여러 번 실행해도 안전.
-- =====================================================================
create or replace function fit.delete_my_account()
returns jsonb
language plpgsql security definer set search_path = fit, public as $$
declare
  uid uuid := auth.uid();
  r record;
  n bigint;
  total bigint := 0;
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;
  for r in
    select c.table_schema, c.table_name, c.column_name
    from information_schema.columns c
    join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
    where c.table_schema in ('fit', 'public')
      and c.column_name in ('candidate_id', 'user_id')
      and c.data_type in ('uuid', 'text')
      and c.table_name <> 'profiles'
  loop
    execute format('delete from %I.%I where %I::text = $1', r.table_schema, r.table_name, r.column_name) using uid::text;
    get diagnostics n = row_count;
    total := total + n;
  end loop;
  delete from public.profiles where id = uid;
  get diagnostics n = row_count;
  return jsonb_build_object('rows', total + n);
end $$;

revoke all on function fit.delete_my_account() from public, anon;
grant execute on function fit.delete_my_account() to authenticated;

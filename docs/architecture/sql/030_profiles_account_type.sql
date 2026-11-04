-- =====================================================================
-- 030: 계정 유형을 profiles 에도 둔다 (2026-11-03, 23 문서 G3·G4).
--
-- 계정 유형의 원본은 auth.users.raw_app_meta_data->>'account_type' (seeker|company, 서비스 롤만 쓰기).
-- 브라우저(anon/authenticated)는 auth.users 를 못 읽으므로, 인재풀 화면이 기업 계정을 거를 수 있게
-- profiles.account_type 으로 복사하고, 기업 계정은 is_public=false 로 고정한다.
--   - 이전: 기업 계정 숨김이 "기업이 로그인했을 때" 클라이언트가 is_public 을 끄는 데 의존 → 로그인 전엔 노출.
-- orchestrator·mcp-server 후보 풀은 이 SQL 없이도 shared/lib/companyAccounts.ts 로 거른다.
-- Supabase SQL Editor 에서 한 번 실행. 여러 번 실행해도 안전.
-- =====================================================================
alter table public.profiles add column if not exists account_type text
  check (account_type in ('seeker', 'company'));

-- 기존 계정 채우기
update public.profiles p
set account_type = u.raw_app_meta_data->>'account_type',
    is_public = case when u.raw_app_meta_data->>'account_type' = 'company' then false else p.is_public end
from auth.users u
where u.id = p.id
  and u.raw_app_meta_data->>'account_type' in ('seeker', 'company');

-- 이후: app_metadata 가 바뀌거나 profiles 행이 생길 때 따라 맞춘다
create or replace function public.sync_profile_account_type()
returns trigger
language plpgsql security definer set search_path = public as $$
declare t text;
begin
  if tg_table_schema = 'auth' then
    t := new.raw_app_meta_data->>'account_type';
    update public.profiles
    set account_type = t, is_public = case when t = 'company' then false else is_public end
    where id = new.id and account_type is distinct from t;
  else
    select u.raw_app_meta_data->>'account_type' into t from auth.users u where u.id = new.id;
    new.account_type := t;
    if t = 'company' then new.is_public := false; end if;
  end if;
  return new;
end $$;

drop trigger if exists sync_profile_account_type on auth.users;
create trigger sync_profile_account_type after insert or update of raw_app_meta_data on auth.users
  for each row execute function public.sync_profile_account_type();

-- 기업 계정이 프로필 편집으로 is_public 을 다시 켜는 것도 막는다
drop trigger if exists sync_profile_account_type on public.profiles;
create trigger sync_profile_account_type before insert or update of is_public, account_type on public.profiles
  for each row execute function public.sync_profile_account_type();

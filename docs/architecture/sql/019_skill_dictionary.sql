-- 019 표준 기술 사전 (22 문서 E1). 초안 — 원격 적용은 사용자 승인 후.
-- orchestrator 는 이 테이블이 없으면 코드 시드(orchestrator/src/lib/skillSeed.ts)만으로 동작한다.
-- 여기에 넣은 행은 같은 canonical 의 코드 시드를 덮어쓴다 (사전 보강·수정은 DB 에서).

create table if not exists fit.skill_dictionary (
  canonical  text primary key,
  aliases    text[] not null default '{}',  -- 비교용 소문자
  category   text not null,
  parent     text,                          -- 시드에만 있는 canonical 도 가리킬 수 있어 FK 는 두지 않는다
  updated_at timestamptz not null default now()
);
create index if not exists skill_dictionary_aliases_idx on fit.skill_dictionary using gin (aliases);

-- 사전에 없는 이름 (사람이 주기적으로 보고 사전에 편입)
create table if not exists fit.skill_unmapped (
  raw        text primary key,
  seen_count int not null default 1,
  last_seen  timestamptz not null default now()
);

create or replace function fit.record_unmapped_skills(names text[])
returns void language sql security definer set search_path = fit as $$
  insert into fit.skill_unmapped (raw)
  select distinct lower(btrim(n)) from unnest(names) as n where btrim(n) <> ''
  on conflict (raw) do update set seen_count = fit.skill_unmapped.seen_count + 1, last_seen = now();
$$;
revoke all on function fit.record_unmapped_skills(text[]) from public, anon, authenticated;
grant execute on function fit.record_unmapped_skills(text[]) to service_role;

alter table fit.skill_dictionary enable row level security;
alter table fit.skill_unmapped enable row level security;

grant select on fit.skill_dictionary to service_role;
grant select, insert, update on fit.skill_unmapped to service_role;

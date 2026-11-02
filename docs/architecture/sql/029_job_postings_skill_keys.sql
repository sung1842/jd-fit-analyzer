-- =====================================================================
-- 029: 공고 추천 후보 생성 (2026-11-02). 022 추천 계산이 공고 전체(최대 5000건)를 읽던 것을
--      "내 기술과 겹치는 공고 + 기술 미기재 공고"만 먼저 꺼내도록 GIN 인덱스로 거른다.
--
-- 비교 키: orchestrator skillDictionary.cleanSkill 과 같은 정리 (NFKC · 소문자 · 공백 1칸 · trim).
--   공고 skills 는 원문 표기 그대로라 대소문자·별칭이 섞여 있어 원본 배열 GIN 으로는 못 거른다 → 정리한 배열에 식 인덱스.
--   조회 키(별칭·상위 기술 포함)는 코드가 사전으로 만든다 (SkillDictionary.matchKeys).
-- orchestrator 는 이 함수가 없으면 예전처럼 전체를 읽는다.
-- =====================================================================
create or replace function fit.skill_keys(arr text[])
returns text[]
language sql immutable parallel safe as $$
  select coalesce(array_agg(distinct k), '{}')
  from (select trim(regexp_replace(lower(normalize(s, NFKC)), '\s+', ' ', 'g')) as k from unnest(arr) s) t
  where k <> '';
$$;

create index if not exists job_postings_skill_keys_gin on fit.job_postings using gin (fit.skill_keys(skills));

-- 마감 전 공고 중 키가 겹치거나 기술이 비어 있는 공고 id. 최신순, 상한 max_count
create or replace function fit.recommend_candidate_postings(keys text[], max_count int)
returns table (id uuid)
language sql stable set search_path = fit as $$
  select p.id
  from fit.job_postings p
  where (p.expires_at is null or p.expires_at >= now())
    and (fit.skill_keys(p.skills) && keys or cardinality(p.skills) = 0)
  order by p.first_seen_at desc
  limit least(greatest(max_count, 1), 20000);
$$;
revoke execute on function fit.recommend_candidate_postings(text[], int) from public, anon, authenticated;
grant execute on function fit.recommend_candidate_postings(text[], int) to service_role;

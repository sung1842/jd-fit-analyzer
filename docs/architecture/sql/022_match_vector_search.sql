-- 022 B 단계 벡터 검색 (22 문서 E4). 초안 — 원격 적용은 사용자 승인 후.
-- 적용 순서: 021 다음, 024 앞. 022_job_recommendations 와 번호만 같고 서로 독립.
-- 공고 임베딩을 공고 정규화 캐시에 저장하고, 후보 의미 지문(020 narrative_embedding)과 코사인 유사도로 가까운 순 top-K 를 뽑는다.
-- orchestrator 는 이 함수가 없으면 벡터 단계를 건너뛰고 기술 일치만으로 진행한다.

alter table fit.job_requirements_norm add column if not exists embedding extensions.vector(768);

create or replace function fit.match_candidate_norms(query_embedding extensions.vector(768), match_count int)
returns table (candidate_id text, similarity double precision)
language sql stable set search_path = fit, extensions as $$
  select n.candidate_id, 1 - (n.narrative_embedding <=> query_embedding) as similarity
  from fit.candidate_profiles_norm n
  where n.narrative_embedding is not null
  order by n.narrative_embedding <=> query_embedding
  limit least(greatest(match_count, 1), 1000);
$$;
revoke execute on function fit.match_candidate_norms(extensions.vector(768), int) from public, anon, authenticated;
grant execute on function fit.match_candidate_norms(extensions.vector(768), int) to service_role;

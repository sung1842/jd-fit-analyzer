-- 020 후보 정규화 결과 (22 문서 E2). 초안 — 원격 적용은 사용자 승인 후.
-- 원본 profiles 는 건드리지 않는다. 이 테이블은 언제든 지우고 다시 만들 수 있는 파생 데이터.
-- orchestrator 정규화 큐(candidate-normalize)만 쓴다 (service_role).

create table if not exists fit.candidate_profiles_norm (
  candidate_id     text primary key,
  source_hash      text not null,            -- 변경 감지 1: 매칭 관련 필드 전체(정리 후) sha256
  fields_hash      text not null,            -- 변경 감지 2: 선택형 칸(직무·기술·경력 기간·희망) sha256
  norm_version     int  not null,            -- 정규화 프롬프트·사전 버전 (MATCH_NORM_VERSION)
  roles            text[] not null default '{}',
  skills           jsonb not null default '[]',  -- [{name(canonical), years, professional}]
  unmapped_skills  text[] not null default '{}', -- 사전에 없어 매칭에서 빠진 이름
  total_years      numeric(4,1),
  tags             text[] not null default '{}',
  prefs            jsonb,                        -- {locations:[], remote}
  narrative_embedding extensions.vector(768),            -- 변경 감지 3 의미 지문 + 이후 B 단계 검색
  last_outcome     text not null,                -- created|changed|same_hash|same_meaning|same_result
  normalized_at    timestamptz not null default now(),  -- 마지막 LLM 정규화 시각
  checked_at       timestamptz not null default now(),  -- 마지막 변경 감지 시각
  changed_at       timestamptz not null default now()   -- 정규화 결과가 실제로 바뀐 시각 (재매칭 기준)
);
create index if not exists candidate_profiles_norm_roles_idx on fit.candidate_profiles_norm using gin (roles);
create index if not exists candidate_profiles_norm_skills_idx on fit.candidate_profiles_norm using gin (skills jsonb_path_ops);
create index if not exists candidate_profiles_norm_embedding_idx on fit.candidate_profiles_norm using hnsw (narrative_embedding extensions.vector_cosine_ops);
create index if not exists candidate_profiles_norm_changed_idx on fit.candidate_profiles_norm (changed_at);

alter table fit.candidate_profiles_norm enable row level security;
grant select, insert, update, delete on fit.candidate_profiles_norm to service_role;

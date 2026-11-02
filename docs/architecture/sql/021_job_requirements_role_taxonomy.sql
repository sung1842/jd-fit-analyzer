-- 021 공고 정규화 + 직무 분류 (22 문서 E3). 초안 — 원격 적용은 사용자 승인 후.
-- orchestrator 는 두 테이블이 없어도 동작한다 (공고는 매번 LLM 정규화, 직무 인접도는 코드 시드 lib/roleTaxonomy.ts).

-- 공고 정규화 결과. 같은 JD(정리 후 해시 + 버전)는 LLM 을 다시 부르지 않는다.
-- jd_runs 에 묶이지 않은 즉시 계획(/api/jd/plan)도 쓰므로 키는 jd_key, jd_run_id 는 선택.
create table if not exists fit.job_requirements_norm (
  jd_key          text primary key,           -- sha256('v{버전}\n' + 정리된 JD)
  jd_run_id       uuid references fit.jd_runs(id) on delete set null,
  norm_version    int  not null,
  role            text,                       -- CANDIDATE_ROLES 중 하나
  legacy_role     text not null check (legacy_role in ('developer','designer')),
  role_confidence int  not null default 0,
  must_skills     text[] not null default '{}',
  nice_skills     text[] not null default '{}',
  years_min       numeric(4,1),
  years_max       numeric(4,1),
  locations       text[] not null default '{}',
  remote_ok       boolean,
  created_at      timestamptz not null default now()
);
create index if not exists job_requirements_norm_run_idx on fit.job_requirements_norm (jd_run_id);

-- 직무 인접도 (대칭으로 취급). 여기 넣은 쌍은 같은 쌍의 코드 시드를 덮어쓴다.
create table if not exists fit.role_taxonomy (
  role     text not null,
  related  text not null,
  affinity numeric(3,2) not null check (affinity between 0 and 1),
  primary key (role, related)
);

alter table fit.job_requirements_norm enable row level security;
alter table fit.role_taxonomy enable row level security;
grant select, insert, update, delete on fit.job_requirements_norm to service_role;
grant select on fit.role_taxonomy to service_role;

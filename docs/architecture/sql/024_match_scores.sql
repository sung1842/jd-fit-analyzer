-- 024 C 단계 순위 저장 (22 문서 E5, 레인 A). 초안 — 원격 적용은 사용자 승인 후. 022_match_vector_search 다음에 적용.
-- 22 문서 §5 정의와의 차이: 키가 jd_run_id 가 아니라 jd_hash.
--   근거: 순위를 만드는 /api/jd/plan(talentfolio JdMatchModal)·스카우트 건·채널 초대 소싱은 jd_runs 행이 생기기 전에 실행되고,
--   jd_runs 는 (user_id, jd_hash) 단위라 같은 JD 에 여러 행이 생긴다. 순위는 사용자와 무관하게 JD 내용으로 결정되므로
--   fit_reports·Redis 캐시와 같은 jd_hash(cache.ts jdHash: sha256 앞 16자) 를 키로 쓰고, jd_run_id 는 나중에 묶을 때만 채운다.
-- orchestrator 는 이 테이블이 없으면 저장만 건너뛴다.

create table if not exists fit.match_scores (
  jd_hash         text not null,
  candidate_id    text not null,
  jd_run_id       uuid references fit.jd_runs(id) on delete set null,
  inputs_hash     text not null,            -- 공고 요건 + 가중치 버전 + 후보 입력
  rank_score      numeric(5,2) not null,
  score_breakdown jsonb not null,           -- {items:{must,nice,years,role,vector,activity}, weights, boost:{company,recruiter}, weightsVersion, excluded, mustUnmet, raw}
  stage           text not null check (stage in ('ranked','analyzing','analyzed','skipped')),
  fit_report_id   uuid,                     -- D 단계 결과 (기존 fit_reports)
  updated_at      timestamptz not null default now(),
  primary key (jd_hash, candidate_id)
);
create index if not exists match_scores_rank_idx on fit.match_scores (jd_hash, rank_score desc);
create index if not exists match_scores_run_idx on fit.match_scores (jd_run_id) where jd_run_id is not null;

alter table fit.match_scores enable row level security;
revoke all on fit.match_scores from public, anon, authenticated;
grant select, insert, update, delete on fit.match_scores to service_role;

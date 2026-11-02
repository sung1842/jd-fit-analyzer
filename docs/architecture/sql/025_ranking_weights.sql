-- 025 층별 가중치 (22 문서 §5·§7.2, E6b). 초안 — 원격 적용은 리드가 사용자 승인 후.
-- global 행: weights = 절대 가중치 {must:40,...} (없으면 코드 기본값 DEFAULT_RANK_WEIGHTS).
-- company/recruiter 행: weights = 보정 비율 b ∈ [-0.2, 0.2] (주간 배치 ranking-weights 가 갱신), sample_n = 결정 수.
-- 항목은 must/nice/years/role/vector/activity 만 (편향 차단 — 나이·성별·학교 없음).
create table if not exists fit.ranking_weights (
  scope      text not null check (scope in ('global','company','recruiter')),
  scope_id   text not null default '-',
  weights    jsonb not null,
  sample_n   int not null default 0,
  version    int not null default 1,
  updated_at timestamptz not null default now(),
  primary key (scope, scope_id)
);

-- 서비스 롤 전용: RLS 켜고 정책 없음 (service_role 은 RLS 우회)
alter table fit.ranking_weights enable row level security;
revoke all on fit.ranking_weights from anon, authenticated;
grant select, insert, update, delete on fit.ranking_weights to service_role;

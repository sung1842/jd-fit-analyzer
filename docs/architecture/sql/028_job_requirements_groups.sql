-- 028: 공고 정규화 v2 (A2) — 택일 필수 그룹·경험 문장 저장 칸.
-- req_groups = {"must_any_of": [["MySQL","PostgreSQL"]], "must_experiences": ["REST API 설계 경험"]}
-- 미적용이어도 orchestrator 는 동작한다 (기본 칸만 캐시, 택일·경험은 캐시 적중 시 빠짐).
-- 옛 v1 행은 jd_key 에 버전이 들어가 있어 자연히 쓰이지 않는다. 정리하려면 아래 delete 를 같이 실행.
alter table fit.job_requirements_norm add column if not exists req_groups jsonb;
-- delete from fit.job_requirements_norm where norm_version < 2;

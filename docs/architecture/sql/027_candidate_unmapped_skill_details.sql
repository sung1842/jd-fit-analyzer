-- 027 사전 밖 기술 상세 (매칭 레인 C, F1). 초안 — 원격 적용은 사용자 승인 후.
-- 020 의 unmapped_skills(이름만)에 더해 연수·실무 여부를 저장한다 → 사전이 바뀌면 LLM 없이 코드로 재매핑
--   (orchestrator remapAllCandidates, POST /api/admin/candidates/normalize/remap).
-- 미적용이어도 orchestrator 는 기존대로 동작한다 (컬럼 없음 오류 시 상세 없이 저장, remap 은 applied=false).
-- 기존 행은 빈 배열로 시작하며, 다음 LLM 정규화(force 또는 변경) 때 채워진다.

alter table fit.candidate_profiles_norm
  add column if not exists unmapped_skill_details jsonb not null default '[]'; -- [{name(원문), years, professional}]

-- PostgREST 스키마 캐시 갱신 (새 컬럼 인식)
notify pgrst, 'reload schema';

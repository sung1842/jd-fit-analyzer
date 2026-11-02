-- =====================================================================
-- 013: 크롤 검수 (web :3010 /crawling). 2026-10-25
--
-- saramin_postings = 원본 + 검수 상태. 승인된 행만 fit.job_postings 로 병합한다 (orchestrator lib/crawlReview.ts).
--   review_status
--     ok           규칙 통과, 사람 판정 전 (샘플이면 사람이 확인)
--     needs_review 규칙 위반으로 격리 (review_flags 에 사유)
--     retry_later  재수집 대상
--     approved     승인 → job_postings 병합 대상
--     rejected     제외 (reject_reason). 재수집이 되살리지 않는다
--     resolved     (011 기존값) 사람이 손본 행. 재수집이 덮어쓰지 않는다
--
-- 적용 순서: 011, 012 다음. 재실행 안전 (if not exists / drop constraint if exists).
-- =====================================================================

alter table fit.saramin_postings
  add column if not exists load_batch_id text,
  add column if not exists is_sample boolean not null default false,
  add column if not exists review_flags text[] not null default '{}',
  add column if not exists reject_reason text,
  add column if not exists edits jsonb not null default '{}'::jsonb,
  add column if not exists reviewed_by text,
  add column if not exists reviewed_at timestamptz;

alter table fit.saramin_postings drop constraint if exists saramin_postings_review_status_check;
alter table fit.saramin_postings add constraint saramin_postings_review_status_check
  check (review_status in ('ok','retry_later','needs_review','resolved','approved','rejected'));

alter table fit.saramin_postings drop constraint if exists saramin_reject_reason_check;
alter table fit.saramin_postings add constraint saramin_reject_reason_check
  check (reject_reason is null or reject_reason in ('ad','irrelevant','broken','duplicate','other'));

alter table fit.saramin_postings drop constraint if exists saramin_edits_is_object;
alter table fit.saramin_postings add constraint saramin_edits_is_object check (jsonb_typeof(edits) = 'object');

-- 기존 테스트 적재분(배치 정보 없음)은 한 배치로 묶는다
update fit.saramin_postings set load_batch_id = 'legacy-test-2026-10-24' where load_batch_id is null;

create index if not exists saramin_postings_batch_idx on fit.saramin_postings (load_batch_id, review_status);
create index if not exists saramin_postings_sample_idx on fit.saramin_postings (load_batch_id) where is_sample;

-- =====================================================================
-- 014. 크롤 원본 일반화 + 출처 이름 제거 (2026-10-27, 사용자 요청)
--
-- 특정 수집처 이름이 테이블·컬럼·제약·값에 남지 않게 하고, 다른 수집처가 추가돼도 같은 테이블을 쓰게 한다.
--   saramin_postings            → crawled_postings          (+ platform, 플랫폼 단위 unique)
--   saramin_posting_categories  → crawled_posting_categories (공고와 직군의 platform 을 복합 FK 로 강제)
--   rec_idx                     → external_id
--   platform / source 값        → 'board_a' (출처 코드는 불투명 코드. 실제 수집처 정보는 crawler/.env 에만)
--   본문·지원방법 텍스트 안의 수집처 이름 → '채용 사이트'
-- 한 트랜잭션. 적용 전 백업: crawler/out/backup_014/ (스크립트로 JSON 덤프).
-- 이 파일 적용 후 011~013 은 재실행 대상이 아니다 (테이블·제약 이름이 바뀜).
-- =====================================================================
begin;

-- 1) 테이블·컬럼 이름
alter table fit.saramin_postings rename to crawled_postings;
alter table fit.crawled_postings rename column rec_idx to external_id;
alter table fit.saramin_posting_categories rename to crawled_posting_categories;

-- 2) 출처 코드 (불투명). 새 행은 적재 코드가 반드시 넣는다
alter table fit.crawled_postings add column if not exists platform text;
update fit.crawled_postings set platform = 'board_a' where platform is null;
alter table fit.crawled_postings alter column platform set not null;
alter table fit.crawled_postings add constraint crawled_postings_platform_check check (platform ~ '^[a-z0-9_]{2,30}$');

alter table fit.crawled_postings drop constraint saramin_postings_rec_idx_key;
alter table fit.crawled_postings add constraint crawled_postings_platform_external_id_key unique (platform, external_id);
alter table fit.crawled_postings add constraint crawled_postings_id_platform_key unique (id, platform);

-- 3) 직군: 기준 데이터와 연결 행의 platform 값 교체 (연결 행 platform 고정 CHECK 제거 → 형식 CHECK)
alter table fit.crawled_posting_categories drop constraint saramin_posting_categories_platform_check;
alter table fit.crawled_posting_categories alter column platform drop default;
update fit.job_categories set platform = 'board_a' where platform = 'saramin';
update fit.crawled_posting_categories set platform = 'board_a' where platform = 'saramin';
alter table fit.crawled_posting_categories add constraint crawled_posting_categories_platform_check check (platform ~ '^[a-z0-9_]{2,30}$');
-- 공고와 직군의 platform 이 같아야 한다 (공고 쪽 복합 FK)
alter table fit.crawled_posting_categories
  add constraint crawled_posting_categories_posting_platform_fkey
  foreign key (posting_id, platform) references fit.crawled_postings (id, platform) on delete cascade;

-- 4) 제약·인덱스·트리거·정책 이름: saramin_* → crawled_*
do $$
declare r record;
begin
  for r in select conrelid::regclass as tbl, conname from pg_constraint
           where conrelid in ('fit.crawled_postings'::regclass, 'fit.crawled_posting_categories'::regclass)
             and conname like 'saramin%'
  loop
    execute format('alter table %s rename constraint %I to %I', r.tbl, r.conname, regexp_replace(r.conname, '^saramin', 'crawled'));
  end loop;
  for r in select indexname from pg_indexes where schemaname = 'fit' and indexname like 'saramin%'
  loop
    execute format('alter index fit.%I rename to %I', r.indexname, regexp_replace(r.indexname, '^saramin', 'crawled'));
  end loop;
  for r in select policyname, tablename from pg_policies where schemaname = 'fit' and policyname like 'saramin%'
  loop
    execute format('alter policy %I on fit.%I rename to %I', r.policyname, r.tablename, regexp_replace(r.policyname, '^saramin', 'crawled'));
  end loop;
end $$;
alter trigger saramin_postings_set_updated_at on fit.crawled_postings rename to crawled_postings_set_updated_at;
create index if not exists crawled_postings_platform_idx on fit.crawled_postings (platform, load_batch_id);

-- 5) 값 안의 수집처 이름
update fit.crawled_postings set load_batch_id = regexp_replace(load_batch_id, '^saramin', 'board_a') where load_batch_id ~ '^saramin';
update fit.crawled_postings set
  body_text         = replace(body_text, '사람인', '채용 사이트'),
  apply_method_text = replace(apply_method_text, '사람인', '채용 사이트'),
  review_note       = replace(review_note, '사람인', '채용 사이트')
where coalesce(body_text, '') || coalesce(apply_method_text, '') || coalesce(review_note, '') like '%사람인%';

update fit.job_postings set source = 'board_a' where source = 'saramin';
update fit.job_postings set
  raw = (raw - 'saramin_posting_id' - 'rec_idx')
        || jsonb_build_object('crawled_posting_id', raw->'saramin_posting_id', 'external_id', raw->'rec_idx')
where raw ? 'saramin_posting_id';
update fit.job_postings set description = replace(description, '사람인', '채용 사이트') where description like '%사람인%';

commit;

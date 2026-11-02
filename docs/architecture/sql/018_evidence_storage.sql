-- =====================================================================
-- 018: 근거 파일 (사진·문서) 저장소. 2026-10-29
-- 웹에 결과물이 남지 않는 직군(조리·현장·사무 등)도 근거를 붙일 수 있게 이미지·PDF 를 받는다.
-- 버킷 evidence: 비공개. 경로 = <user_id>/<card_id>/<파일>. 본인만 올리고·보고·지운다.
-- 기업에게는 파일을 열어 주지 않는다 — 카드에 "첨부 N개" 만 보이고, 원본은 연락 수락·면접 때 본인이 공유한다.
-- 카드에는 links jsonb 에 {url:"storage://evidence/<경로>", label, kind:"image"|"file"} 로 남는다.
-- =====================================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('evidence', 'evidence', false, 10485760,
        array['image/png','image/jpeg','image/webp','image/gif','application/pdf'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists evidence_owner_select on storage.objects;
create policy evidence_owner_select on storage.objects for select to authenticated
  using (bucket_id = 'evidence' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists evidence_owner_insert on storage.objects;
create policy evidence_owner_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'evidence' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists evidence_owner_delete on storage.objects;
create policy evidence_owner_delete on storage.objects for delete to authenticated
  using (bucket_id = 'evidence' and (storage.foldername(name))[1] = auth.uid()::text);

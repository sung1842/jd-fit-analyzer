-- =====================================================================
-- 017: 근거 카드 "★ 대표" (스튜디오 목업 디자인). 2026-10-28
-- 대표 카드는 기업 화면·카드 목록에서 맨 앞에 온다. 사용자당 최대 3장 (트리거).
-- 사용자 토큰으로 직접 update (RLS 본인). recorded_at·ai_edited 잠금 트리거(015)는 그대로 적용된다.
-- =====================================================================
alter table fit.evidence_cards add column if not exists featured boolean not null default false;

create or replace function fit.evidence_cards_featured_limit()
returns trigger language plpgsql as $$
begin
  if new.featured and (select count(*) from fit.evidence_cards
                       where user_id = new.user_id and featured and id <> new.id) >= 3 then
    raise exception '대표 카드는 3장까지예요';
  end if;
  return new;
end $$;
drop trigger if exists evidence_cards_featured_limit on fit.evidence_cards;
create trigger evidence_cards_featured_limit
  before insert or update of featured on fit.evidence_cards
  for each row execute function fit.evidence_cards_featured_limit();
grant execute on function fit.evidence_cards_featured_limit() to service_role, authenticated;

-- 공개 뷰에 featured 추가 (컬럼 추가는 replace 로 가능: 끝에 붙인다)
create or replace view fit.public_evidence_cards as
select c.id, c.user_id, c.claim, c.trust_level, c.recorded_at,
       c.source, c.links, c.ai_edited, c.published_at, c.featured
from fit.evidence_cards c
where c.visibility = 'public'
  and exists (
    select 1 from fit.consents k
    where k.user_id = c.user_id and k.purpose = 'matching' and k.revoked_at is null
  );

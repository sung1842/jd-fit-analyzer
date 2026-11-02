-- Phase 5 RAG: 포트폴리오 청크 + 임베딩 (jd-fit-analyzer 자체 Supabase, service_role 전용)
-- talentfolio profiles(읽기 전용)는 원본, 이 테이블은 검색 인덱스(파생 데이터)이다.

create extension if not exists vector;

create table if not exists portfolio_chunks (
  id uuid primary key default gen_random_uuid(),
  candidate_id text not null,
  source_field text not null,
  chunk_index int not null,
  content text not null,
  embedding vector(768),
  content_hash text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists portfolio_chunks_candidate_field_index
  on portfolio_chunks (candidate_id, source_field, chunk_index);

create index if not exists portfolio_chunks_embedding_idx
  on portfolio_chunks using hnsw (embedding vector_cosine_ops);

create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists portfolio_chunks_set_updated_at on portfolio_chunks;
create trigger portfolio_chunks_set_updated_at
  before update on portfolio_chunks
  for each row execute function set_updated_at();

-- fit_reports와 동일한 이유로 RLS 비활성화 (orchestrator/mcp-server의 service_role만 접근)
alter table portfolio_chunks disable row level security;

grant all on table portfolio_chunks to service_role;

-- cosine similarity 검색 RPC (supabase-js는 <=> 연산자를 쿼리 빌더로 표현할 수 없으므로 함수로 노출)
create or replace function match_portfolio_chunks(
  query_embedding vector(768),
  match_candidate_id text,
  match_count int
)
returns table (
  id uuid,
  candidate_id text,
  source_field text,
  chunk_index int,
  content text,
  content_hash text,
  similarity float
)
language sql stable
as $$
  select
    id, candidate_id, source_field, chunk_index, content, content_hash,
    1 - (embedding <=> query_embedding) as similarity
  from portfolio_chunks
  where candidate_id = match_candidate_id
    and embedding is not null
  order by embedding <=> query_embedding
  limit match_count;
$$;

grant execute on function match_portfolio_chunks(vector(768), text, int) to service_role;

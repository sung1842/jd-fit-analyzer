import type { PortfolioChunk } from "../../../shared/types.js";
import { db } from "../lib/db.js";
import { embedTexts } from "../lib/gemini.js";

interface MatchChunkRow {
  id: string;
  candidate_id: string;
  source_field: string;
  chunk_index: number;
  content: string;
  content_hash: string;
  similarity: number;
}

export async function searchPortfolioChunks(candidateId: string, query: string, topK: number): Promise<PortfolioChunk[]> {
  const [queryEmbedding] = await embedTexts([query]);

  const { data, error } = await db.rpc("match_portfolio_chunks", {
    query_embedding: queryEmbedding,
    match_candidate_id: candidateId,
    match_count: topK,
  });

  if (error) {
    throw new Error(`match_portfolio_chunks 호출 실패 (candidateId=${candidateId}): ${error.message}`);
  }

  return ((data ?? []) as MatchChunkRow[]).map((row) => ({
    id: row.id,
    candidateId: row.candidate_id,
    sourceField: row.source_field,
    chunkIndex: row.chunk_index,
    content: row.content,
    contentHash: row.content_hash,
    similarity: row.similarity,
  }));
}

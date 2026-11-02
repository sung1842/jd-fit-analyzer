import { chunkText } from "../../../shared/lib/chunkText.js";
import { db } from "../lib/db.js";
import { embedTexts } from "../lib/gemini.js";
import { getCandidatePortfolio } from "./getCandidatePortfolio.js";

// 임베딩 대상 필드 — 후보자 평가에 의미 있는 자유 서술 텍스트만 인덱싱
const SOURCE_FIELDS = ["short_bio", "long_bio"] as const;

interface ExistingChunkRow {
  chunk_index: number;
  content_hash: string;
}

export async function embedAndIndexPortfolio(candidateId: string): Promise<{ chunksUpdated: number }> {
  const portfolio = await getCandidatePortfolio(candidateId);

  let chunksUpdated = 0;

  for (const sourceField of SOURCE_FIELDS) {
    const text = portfolio[sourceField];
    const chunks = text ? chunkText(text) : [];

    const { data: existingRows, error: selectError } = await db
      .from("portfolio_chunks")
      .select("chunk_index, content_hash")
      .eq("candidate_id", candidateId)
      .eq("source_field", sourceField);

    if (selectError) {
      throw new Error(`portfolio_chunks 조회 실패 (candidateId=${candidateId}, field=${sourceField}): ${selectError.message}`);
    }

    const existingByIndex = new Map<number, ExistingChunkRow>(
      (existingRows ?? []).map((row) => [row.chunk_index, row as ExistingChunkRow])
    );

    // content_hash가 바뀐(또는 신규) 청크만 재임베딩 — 비용 절감
    const toEmbed = chunks.filter((c) => existingByIndex.get(c.chunkIndex)?.content_hash !== c.contentHash);

    if (toEmbed.length > 0) {
      const embeddings = await embedTexts(toEmbed.map((c) => c.content));

      const rows = toEmbed.map((c, i) => ({
        candidate_id: candidateId,
        source_field: sourceField,
        chunk_index: c.chunkIndex,
        content: c.content,
        content_hash: c.contentHash,
        embedding: embeddings[i],
      }));

      const { error: upsertError } = await db
        .from("portfolio_chunks")
        .upsert(rows, { onConflict: "candidate_id,source_field,chunk_index" });

      if (upsertError) {
        throw new Error(`portfolio_chunks upsert 실패 (candidateId=${candidateId}, field=${sourceField}): ${upsertError.message}`);
      }

      chunksUpdated += rows.length;
    }

    // 원본 텍스트가 줄어들어 더 이상 존재하지 않는 청크 인덱스는 삭제
    const staleIndexes = [...existingByIndex.keys()].filter((idx) => idx >= chunks.length);
    if (staleIndexes.length > 0) {
      const { error: deleteError } = await db
        .from("portfolio_chunks")
        .delete()
        .eq("candidate_id", candidateId)
        .eq("source_field", sourceField)
        .in("chunk_index", staleIndexes);

      if (deleteError) {
        throw new Error(`portfolio_chunks 정리 실패 (candidateId=${candidateId}, field=${sourceField}): ${deleteError.message}`);
      }
    }
  }

  return { chunksUpdated };
}

/**
 * 19 문서 4절: 공개 근거 카드 임베딩. 같은 portfolio_chunks 경로, source_field = `evidence_card:<id>`
 * (life-unpublish 삭제 규칙과 동일). 공개 뷰(public_evidence_cards)에서 읽으므로 공개 + matching 동의 카드 내용만 들어간다.
 * 뷰에 없으면(비공개 전환·동의 없음) 해당 source_field 청크를 지우고 0 을 돌려준다.
 */
export async function embedEvidenceCard(candidateId: string, cardId: string): Promise<{ chunksUpdated: number; indexed: boolean }> {
  const sourceField = `evidence_card:${cardId}`;
  const { data: card, error } = await db
    .from("public_evidence_cards")
    .select("id, claim")
    .eq("id", cardId)
    .eq("user_id", candidateId)
    .maybeSingle();
  if (error) throw new Error(`public_evidence_cards 조회 실패 (cardId=${cardId}): ${error.message}`);

  const text = typeof card?.claim === "string" ? card.claim.trim() : "";
  const chunks = text ? chunkText(text) : [];
  if (chunks.length === 0) {
    const { error: delErr } = await db.from("portfolio_chunks").delete().eq("candidate_id", candidateId).eq("source_field", sourceField);
    if (delErr) throw new Error(`portfolio_chunks 정리 실패 (cardId=${cardId}): ${delErr.message}`);
    return { chunksUpdated: 0, indexed: false };
  }

  const embeddings = await embedTexts(chunks.map((c) => c.content));
  const rows = chunks.map((c, i) => ({
    candidate_id: candidateId,
    source_field: sourceField,
    chunk_index: c.chunkIndex,
    content: c.content,
    content_hash: c.contentHash,
    embedding: embeddings[i],
  }));
  const { error: upErr } = await db.from("portfolio_chunks").upsert(rows, { onConflict: "candidate_id,source_field,chunk_index" });
  if (upErr) throw new Error(`portfolio_chunks upsert 실패 (cardId=${cardId}): ${upErr.message}`);
  const { error: staleErr } = await db
    .from("portfolio_chunks")
    .delete()
    .eq("candidate_id", candidateId)
    .eq("source_field", sourceField)
    .gte("chunk_index", chunks.length);
  if (staleErr) throw new Error(`portfolio_chunks 정리 실패 (cardId=${cardId}): ${staleErr.message}`);
  return { chunksUpdated: rows.length, indexed: true };
}

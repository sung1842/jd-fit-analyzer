import { createHash } from "node:crypto";

const CHUNK_MIN_LENGTH = 300;
const CHUNK_MAX_LENGTH = 500;

export interface TextChunk {
  chunkIndex: number;
  content: string;
  contentHash: string;
}

// 문장 경계(.!?\n)를 보존하며 300~500자 단위로 묶는다.
export function chunkText(text: string): TextChunk[] {
  const normalized = text.trim();
  if (!normalized) return [];

  const sentences = normalized.split(/(?<=[.!?\n])\s+/).filter((s) => s.length > 0);

  const chunks: string[] = [];
  let current = "";

  for (const sentence of sentences) {
    if (current.length > 0 && current.length + sentence.length + 1 > CHUNK_MAX_LENGTH) {
      chunks.push(current.trim());
      current = sentence;
    } else {
      current = current.length === 0 ? sentence : `${current} ${sentence}`;
    }

    if (current.length >= CHUNK_MIN_LENGTH) {
      chunks.push(current.trim());
      current = "";
    }
  }

  if (current.trim().length > 0) {
    chunks.push(current.trim());
  }

  return chunks.map((content, chunkIndex) => ({
    chunkIndex,
    content,
    contentHash: hashContent(content),
  }));
}

export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

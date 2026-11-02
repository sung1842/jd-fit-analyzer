import type { PortfolioChatAnswer, PortfolioChunk } from "../../../shared/types.js";
import { generateStructured } from "../lib/gemini.js";

const answerSchema = {
  type: "OBJECT",
  properties: {
    answer: { type: "STRING", description: "근거 자료에 기반한 답변. 근거가 없으면 모른다고 답할 것." },
    cited_chunk_ids: {
      type: "ARRAY",
      items: { type: "STRING" },
      description: "답변에 실제로 사용한 근거 자료의 id 목록",
    },
  },
  required: ["answer", "cited_chunk_ids"],
};

export async function answerPortfolioQuestion(question: string, chunks: PortfolioChunk[]): Promise<PortfolioChatAnswer> {
  const evidence = chunks.map((c) => ({ id: c.id, content: c.content }));

  const prompt = [
    "아래 [근거 자료]만 사용해 [질문]에 답하라.",
    "근거 자료에 없는 내용은 추측하지 말고 '포트폴리오에서 근거를 찾을 수 없습니다'라고 답하라.",
    "실제로 답변에 사용한 근거 자료의 id만 cited_chunk_ids에 담아라.",
    "",
    `[질문]: ${question}`,
    `[근거 자료]: ${JSON.stringify(evidence)}`,
  ].join("\n");

  return generateStructured<PortfolioChatAnswer>(prompt, answerSchema, "answer-portfolio-question");
}

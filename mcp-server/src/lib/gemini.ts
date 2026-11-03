import "./env.js";
import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";
import { startObservation } from "@langfuse/tracing";
import { geminiLimiter } from "./rateLimiter.js";

// GEMINI_API_KEY 자동 탐색 (.env.local)
export const ai = new GoogleGenAI({});

// 분석 에이전트 모델 (모델 계층화 정책). 무료 티어 일일 한도는 모델별로 분리 카운트되므로,
// flash-lite 한도/503 시 flash로 폴백하면 별도 한도·용량을 사용할 수 있다.
const ANALYSIS_MODELS = ["gemini-2.5-flash-lite", "gemini-3.8-flash"] as const;

function geminiErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function isRetryableGeminiError(err: unknown): boolean {
  const msg = geminiErrorMessage(err);
  return /503|429|UNAVAILABLE|RESOURCE_EXHAUSTED|high demand/i.test(msg);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function generateStructuredOnce<T>(
  model: string,
  prompt: string,
  responseJsonSchema: Record<string, unknown>,
  traceName: string
): Promise<T> {
  // 호출 직전 RPM 슬롯 확보 (워커 concurrency 와 무관하게 실제 API 호출 수를 제한)
  const { waitedMs } = await geminiLimiter.acquire(model);
  if (waitedMs > 1000) console.log(`[gemini] rate limit 대기 ${Math.round(waitedMs / 1000)}s (model=${model})`);

  const generation = startObservation(traceName, { model, input: prompt }, { asType: "generation" });

  try {
    const response = await ai.models.generateContent({
      model,
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseJsonSchema,
      },
    });

    const output = response.text!;
    generation
      .update({
        output,
        usageDetails: {
          input: response.usageMetadata?.promptTokenCount ?? 0,
          output: response.usageMetadata?.candidatesTokenCount ?? 0,
          total: response.usageMetadata?.totalTokenCount ?? 0,
        },
      })
      .end();

    return JSON.parse(output) as T;
  } catch (err) {
    generation.update({ level: "ERROR", statusMessage: geminiErrorMessage(err) }).end();
    throw err;
  }
}

// ── 임시 대체: ANALYSIS_LLM_PROVIDER=claude 면 분석 호출을 Claude 로 보낸다 (2026-11-03, Gemini 한도 소진 · 사용자 승인).
// 같은 JSON 스키마를 tool input_schema 로 강제해 구조화 출력을 유지한다 (헌법 1조의 "프롬프트로 JSON 요청 금지" 취지).
// 임베딩은 Claude 에 없어 계속 Gemini — 실패하면 호출 쪽이 벡터 단계를 건너뛴다. 한도가 풀리면 변수를 지워 원복.
const CLAUDE_ANALYSIS_MODEL = process.env.CLAUDE_ANALYSIS_MODEL || "claude-haiku-5-5";
let anthropic: Anthropic | null = null;

export function analysisProvider(): "gemini" | "claude" {
  return process.env.ANALYSIS_LLM_PROVIDER === "claude" ? "claude" : "gemini";
}

async function generateStructuredClaude<T>(prompt: string, responseJsonSchema: Record<string, unknown>, traceName: string): Promise<T> {
  anthropic ??= new Anthropic(); // ANTHROPIC_API_KEY 자동 탐색
  const generation = startObservation(traceName, { model: CLAUDE_ANALYSIS_MODEL, input: prompt }, { asType: "generation" });
  try {
    const response = await anthropic.messages.create({
      model: CLAUDE_ANALYSIS_MODEL,
      max_tokens: 4096,
      messages: [{ role: "user", content: prompt }],
      tools: [{ name: "submit_result", description: "분석 결과를 스키마대로 제출한다.", input_schema: responseJsonSchema as Anthropic.Tool.InputSchema }],
      tool_choice: { type: "tool", name: "submit_result" },
    });
    const block = response.content.find((b) => b.type === "tool_use");
    if (!block || block.type !== "tool_use") throw new Error(`Claude 구조화 출력 없음 (stop_reason=${response.stop_reason})`);
    generation
      .update({
        output: block.input,
        usageDetails: {
          input: response.usage.input_tokens,
          output: response.usage.output_tokens,
          total: response.usage.input_tokens + response.usage.output_tokens,
        },
      })
      .end();
    return block.input as T;
  } catch (err) {
    generation.update({ level: "ERROR", statusMessage: geminiErrorMessage(err) }).end();
    throw err;
  }
}

export async function generateStructured<T>(
  prompt: string,
  responseJsonSchema: Record<string, unknown>,
  traceName = "gemini-generate-structured"
): Promise<T> {
  if (analysisProvider() === "claude") return generateStructuredClaude<T>(prompt, responseJsonSchema, traceName);
  let lastErr: unknown;

  for (let modelIndex = 0; modelIndex < ANALYSIS_MODELS.length; modelIndex++) {
    const model = ANALYSIS_MODELS[modelIndex];
    const maxAttempts = modelIndex === 0 ? 4 : 2;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        return await generateStructuredOnce<T>(model, prompt, responseJsonSchema, traceName);
      } catch (err) {
        lastErr = err;
        const lastModelAttempt = attempt === maxAttempts - 1;
        const lastModel = modelIndex === ANALYSIS_MODELS.length - 1;

        if (!isRetryableGeminiError(err) || (lastModelAttempt && lastModel)) {
          throw err;
        }

        if (lastModelAttempt) break;

        const delayMs = 2_000 * 2 ** attempt + Math.floor(Math.random() * 500);
        console.warn(
          `[gemini] ${model} ${traceName} 일시 오류 — ${delayMs}ms 후 재시도 (${attempt + 1}/${maxAttempts}): ${geminiErrorMessage(err).slice(0, 160)}`
        );
        await sleep(delayMs);
      }
    }
  }

  throw lastErr;
}

// text-embedding-004는 v1beta에서 더 이상 제공되지 않으므로 gemini-embedding-001 사용
// outputDimensionality를 768로 고정해 portfolio_chunks.embedding(vector(768))과 일치시킴
const EMBEDDING_MODEL = "gemini-embedding-001";
const EMBEDDING_DIMENSIONS = 768;

// Phase 5 RAG: 텍스트 배열을 임베딩 벡터 배열로 변환 (포트폴리오 청크/질문 임베딩 공용)
export async function embedTexts(texts: string[]): Promise<number[][]> {
  await geminiLimiter.acquire(EMBEDDING_MODEL);

  const generation = startObservation(
    "gemini-embed",
    { model: EMBEDDING_MODEL, input: { texts: texts.length } },
    { asType: "generation" }
  );

  try {
    const response = await ai.models.embedContent({
      model: EMBEDDING_MODEL,
      contents: texts,
      config: { outputDimensionality: EMBEDDING_DIMENSIONS },
    });

    const embeddings = response.embeddings!.map((e) => e.values!);
    generation.update({ output: { vectors: embeddings.length, dimensions: EMBEDDING_DIMENSIONS } }).end();

    return embeddings;
  } catch (err) {
    generation.update({ level: "ERROR", statusMessage: err instanceof Error ? err.message : String(err) }).end();
    throw err;
  }
}

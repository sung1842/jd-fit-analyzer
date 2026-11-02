import "./env.js";
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

export async function generateStructured<T>(
  prompt: string,
  responseJsonSchema: Record<string, unknown>,
  traceName = "gemini-generate-structured"
): Promise<T> {
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

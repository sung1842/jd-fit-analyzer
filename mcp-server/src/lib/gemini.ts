import "./env.js";
import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";
import { startObservation } from "@langfuse/tracing";
import { geminiLimiter, sharedRedis } from "./rateLimiter.js";

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

// ── 오류 분류 ────────────────────────────────────────────────────────────────
// 재시도 여부는 이 서버가 정하지 않는다. 한 번 시도하고, 오류에 코드를 붙여 돌려준다.
// 재시도는 호출한 쪽(orchestrator 의 BullMQ) 한 곳에서만 판단한다 — 계층마다 따로 재시도하면 호출이 곱해진다.
//   [E_QUOTA]    모든 모델의 호출 한도가 찼다 (잠시 뒤 다시 가능)
//   [E_BUSY]     분당 슬롯이 없어 지금은 처리할 수 없다
//   [E_UPSTREAM] 모델 서버의 일시 오류 (5xx 등)
//   [E_BLOCKED]  모델이 응답을 거부했거나 빈 응답 — 같은 입력으로는 다시 해도 같다
export class LlmError extends Error {
  constructor(
    public readonly code: "E_QUOTA" | "E_BUSY" | "E_UPSTREAM" | "E_BLOCKED",
    detail: string
  ) {
    super(`[${code}] ${detail}`);
    this.name = "LlmError";
  }
}

function isQuotaError(msg: string): boolean {
  return /429|RESOURCE_EXHAUSTED|quota/i.test(msg);
}
function isUpstreamError(msg: string): boolean {
  return /50[0234]|UNAVAILABLE|INTERNAL|DEADLINE_EXCEEDED|high demand|overloaded|fetch failed|ECONNRESET|ETIMEDOUT/i.test(msg);
}

/** 429 응답이 알려 준 대기 시간. 하루 단위 한도면 길게, 분 단위면 응답의 retryDelay 만큼 */
export function quotaBlockMs(msg: string): number {
  if (/PerDay/i.test(msg)) return 15 * 60_000;
  const m = msg.match(/retryDelay"?\s*[:=]\s*"?(\d+(?:\.\d+)?)s/i) ?? msg.match(/retry in (\d+(?:\.\d+)?)\s*s/i);
  const sec = m ? Number(m[1]) : 60;
  return Math.min(15 * 60_000, Math.max(5_000, Math.ceil(sec * 1000)));
}

// 모델별 차단 표시(한도 소진)와 전체 차단 표시. Redis 에 두어 모든 인스턴스·orchestrator 가 같이 본다.
const memoryBlocks = new Map<string, number>();
export const LLM_BREAKER_KEY = "llm:breaker:analysis";

async function blockedForMs(model: string): Promise<number> {
  if (sharedRedis) {
    try {
      const ttl = await sharedRedis.pttl(`llm:block:${model}`);
      return ttl > 0 ? ttl : 0;
    } catch {
      /* Redis 장애 시 메모리 표시로 판단 */
    }
  }
  return Math.max(0, (memoryBlocks.get(model) ?? 0) - Date.now());
}

async function blockModel(model: string, ms: number): Promise<void> {
  memoryBlocks.set(model, Date.now() + ms);
  await sharedRedis?.set(`llm:block:${model}`, "1", "PX", ms).catch(() => undefined);
}

async function openBreaker(ms: number): Promise<void> {
  await sharedRedis?.set(LLM_BREAKER_KEY, String(Date.now() + ms), "PX", ms).catch(() => undefined);
}

async function generateStructuredOnce<T>(
  model: string,
  prompt: string,
  responseJsonSchema: Record<string, unknown>,
  traceName: string
): Promise<T> {
  // 호출 직전 RPM 슬롯 확보 (워커 concurrency 와 무관하게 실제 API 호출 수를 제한)
  const slot = await geminiLimiter.acquire(model);
  if (!slot.ok) throw new LlmError("E_BUSY", `no slot (model=${model})`);

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

    const output = response.text;
    if (!output) {
      const reason = response.candidates?.[0]?.finishReason ?? response.promptFeedback?.blockReason ?? "empty";
      throw new LlmError("E_BLOCKED", `no content (${reason})`);
    }
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

    try {
      return JSON.parse(output) as T;
    } catch {
      throw new LlmError("E_UPSTREAM", "malformed structured output");
    }
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

  // 모델마다 한 번만 시도한다. 다음 모델로 넘어가는 것은 재시도가 아니라 별도 한도·용량으로의 우회다.
  let sawQuota = false;
  let sawBusy = false;
  let minBlock = Infinity;
  let lastDetail = "unavailable";

  for (const model of ANALYSIS_MODELS) {
    const blocked = await blockedForMs(model);
    if (blocked > 0) {
      sawQuota = true;
      minBlock = Math.min(minBlock, blocked);
      continue; // 한도가 찬 모델은 호출하지 않는다
    }
    try {
      return await generateStructuredOnce<T>(model, prompt, responseJsonSchema, traceName);
    } catch (err) {
      if (err instanceof LlmError) {
        if (err.code === "E_BLOCKED") throw err;
        if (err.code === "E_BUSY") sawBusy = true;
        lastDetail = err.message;
        continue;
      }
      const msg = geminiErrorMessage(err);
      if (isQuotaError(msg)) {
        const ms = quotaBlockMs(msg);
        await blockModel(model, ms);
        sawQuota = true;
        minBlock = Math.min(minBlock, ms);
        console.warn(`[llm] ${model} 한도 도달 — ${Math.round(ms / 1000)}s 동안 이 모델을 건너뜀`);
        continue;
      }
      if (isUpstreamError(msg)) {
        lastDetail = msg.slice(0, 160);
        continue;
      }
      throw err; // 요청 자체의 문제 (인증·스키마 등) — 다른 모델로 넘겨도 같다
    }
  }

  if (sawBusy) throw new LlmError("E_BUSY", "no slot");
  if (sawQuota) {
    await openBreaker(Number.isFinite(minBlock) ? minBlock : 60_000);
    throw new LlmError("E_QUOTA", "all models at capacity");
  }
  throw new LlmError("E_UPSTREAM", lastDetail);
}

// text-embedding-004는 v1beta에서 더 이상 제공되지 않으므로 gemini-embedding-001 사용
// outputDimensionality를 768로 고정해 portfolio_chunks.embedding(vector(768))과 일치시킴
const EMBEDDING_MODEL = "gemini-embedding-001";
const EMBEDDING_DIMENSIONS = 768;

// Phase 5 RAG: 텍스트 배열을 임베딩 벡터 배열로 변환 (포트폴리오 청크/질문 임베딩 공용)
export async function embedTexts(texts: string[]): Promise<number[][]> {
  const slot = await geminiLimiter.acquire(EMBEDDING_MODEL);
  if (!slot.ok) throw new LlmError("E_BUSY", "no slot (embedding)");

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

import "./env.js";
import { GoogleGenAI } from "@google/genai";
import { startObservation } from "@langfuse/tracing";
import { maskText } from "./lifePrune.js";

/**
 * 라이프 로그 Gemini 호출 (헌법 1조: @google/genai, generateContent + responseJsonSchema, response.text 속성).
 * Langfuse 에는 원문 대신 길이만 기록한다 (비공개 기록 마스킹).
 */
export const LIFE_CHAT_MODEL = process.env.LIFE_CHAT_MODEL || "gemini-2.5-flash-lite";
export const LIFE_STRUCTURE_MODEL = process.env.LIFE_STRUCTURE_MODEL || "gemini-3.8-flash";

let client: GoogleGenAI | null = null;
function ai(): GoogleGenAI {
  client ??= new GoogleGenAI({});
  return client;
}

function usage(meta: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number } | undefined) {
  return { input: meta?.promptTokenCount ?? 0, output: meta?.candidatesTokenCount ?? 0, total: meta?.totalTokenCount ?? 0 };
}

export async function generateLifeJson(traceName: string, model: string, prompt: string, responseJsonSchema: Record<string, unknown>): Promise<unknown> {
  const generation = startObservation(traceName, { model, input: maskText(prompt) }, { asType: "generation" });
  try {
    const response = await ai().models.generateContent({
      model,
      contents: prompt,
      config: { responseMimeType: "application/json", responseJsonSchema },
    });
    const text = response.text ?? "";
    generation.update({ output: maskText(text), usageDetails: usage(response.usageMetadata) }).end();
    return JSON.parse(text);
  } catch (err) {
    generation.update({ level: "ERROR", statusMessage: err instanceof Error ? err.name : "error" }).end();
    throw err;
  }
}

/** 대화 턴 스트리밍 (2조의 예외: 도구 루프 없는 단일 짧은 호출). 텍스트 조각을 yield. */
export async function* streamLifeReply(systemInstruction: string, contents: { role: "user" | "model"; parts: { text: string }[] }[]): AsyncGenerator<string> {
  const generation = startObservation("life-chat-turn", { model: LIFE_CHAT_MODEL, input: maskText(JSON.stringify(contents)) }, { asType: "generation" });
  let out = "";
  try {
    const stream = await ai().models.generateContentStream({
      model: LIFE_CHAT_MODEL,
      contents,
      config: { systemInstruction, maxOutputTokens: 400 },
    });
    for await (const chunk of stream) {
      const t = chunk.text;
      if (t) {
        out += t;
        yield t;
      }
    }
    generation.update({ output: maskText(out) }).end();
  } catch (err) {
    generation.update({ level: "ERROR", statusMessage: err instanceof Error ? err.name : "error" }).end();
    throw err;
  }
}

export const LIFE_CHAT_SYSTEM = [
  "너는 사용자의 하루 활동을 함께 돌아보는 기록 도우미다.",
  "규칙: 한 번에 질문 하나, 짧게. 사실을 묻는 열린 질문만 한다(무엇을, 어떻게, 왜, 누구와, 결과는).",
  "답을 암시하거나 유도하는 질문 금지. 사용자가 하지 않은 말·수치를 지어내거나 대신 말하지 않는다.",
  "활동의 상황·역할·행동·어려움·결과·배운 점(6칸)을 자연스럽게 채우되, 이미 답한 칸은 다시 묻지 않는다.",
].join("\n");

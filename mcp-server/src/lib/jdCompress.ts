/**
 * 채용공고 압축 — 목록은 코드가 쪼개고, LLM 은 분류·기술명·카드 요약만 한다.
 *
 *   (1) Gemini schema maxItems 50
 *   (2) zod 검증 + 재시도 1회 + 코드 clamp
 *   (3) DB CHECK (011/012, JD_LIMITS 와 동일)
 *
 * 헌법 1조: @google/genai + responseJsonSchema. 헌법 3조: 이미 쪼갠 불릿만 넣는다(원문 본문 전체 주입 금지).
 */
import { z } from "zod/v4";
import { generateStructured } from "./gemini.js";

export const JD_LIMITS = {
  ARRAY_MAX: 50,
  ROLE_SUMMARY_MAX: 200,
  ITEM_MAX: 200,
  SKILL_MAX: 60,
  COMPRESSED_MAX: 350,
  COMPRESSED_TARGET: 300,
} as const;

const item = (max: number) => z.string().trim().min(1).max(max);

export const JdCompressSchema = z.object({
  role_summary: z.string().trim().max(JD_LIMITS.ROLE_SUMMARY_MAX),
  key_duties: z.array(item(JD_LIMITS.ITEM_MAX)).max(JD_LIMITS.ARRAY_MAX),
  must_have: z.array(item(JD_LIMITS.ITEM_MAX)).max(JD_LIMITS.ARRAY_MAX),
  nice_to_have: z.array(item(JD_LIMITS.ITEM_MAX)).max(JD_LIMITS.ARRAY_MAX),
  skills: z
    .array(item(JD_LIMITS.SKILL_MAX))
    .max(JD_LIMITS.ARRAY_MAX)
    .describe("컴퓨터/IT 기술 고유명사만"),
  compressed_text: z.string().trim().max(JD_LIMITS.COMPRESSED_MAX),
});

/** LLM 이 쓰는 스키마. 목록 텍스트는 출력하지 않는다(분류 인덱스 + 기술명 + 카드만). */
const ClassifySchema = z.object({
  assign: z
    .array(
      z.object({
        i: z.number().int().min(0).max(JD_LIMITS.ARRAY_MAX - 1),
        bucket: z.enum(["key_duties", "must_have", "nice_to_have", "drop"]),
      })
    )
    .max(JD_LIMITS.ARRAY_MAX),
  skills: z.array(item(JD_LIMITS.SKILL_MAX)).max(JD_LIMITS.ARRAY_MAX),
  role_summary: z.string().trim().max(JD_LIMITS.ROLE_SUMMARY_MAX),
  compressed_text: z.string().trim().max(JD_LIMITS.COMPRESSED_MAX),
});

export type JdCompressed = z.infer<typeof JdCompressSchema>;
export type CompressStatus = "ok" | "retried_ok" | "truncated";
export type BodyLists = {
  key_duties: string[];
  must_have: string[];
  nice_to_have: string[];
  unclassified: string[];
};

export interface CompressResult {
  data: JdCompressed;
  status: CompressStatus;
  attempts: number;
  violations: string[];
}

export function geminiSchema(): Record<string, unknown> {
  const js = z.toJSONSchema(ClassifySchema) as Record<string, unknown>;
  delete js.$schema;
  return js;
}

function getPath(obj: unknown, path: ReadonlyArray<PropertyKey>): unknown {
  let cur: unknown = obj;
  for (const k of path) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<PropertyKey, unknown>)[k];
  }
  return cur;
}

function describeIssues(raw: unknown, issues: z.core.$ZodIssue[]): string[] {
  return issues.map((i) => {
    const v = getPath(raw, i.path);
    const len = typeof v === "string" ? [...v].length : Array.isArray(v) ? v.length : undefined;
    const max = "maximum" in i ? ` (허용 ${String(i.maximum)})` : "";
    return `${i.path.map(String).join(".") || "(root)"}: ${i.code}${len !== undefined ? ` 현재 ${len}` : ""}${max}`;
  });
}

function numbered(items: string[]): string {
  if (!items.length) return "(없음)";
  return items.map((t, i) => `${i}. ${t}`).join("\n");
}

function buildPrompt(input: { title: string; company: string; lists: BodyLists }): string {
  return [
    "코드가 이미 채용공고 불릿을 섹션별로 나눠 두었다. 너는 불릿 문장을 고치거나 다시 쓰지 마라.",
    "할 일:",
    "- skills: 아래 모든 목록에 등장한 컴퓨터/IT 기술 고유명사만(언어·프레임워크·라이브러리·DB·클라우드/인프라·개발 도구). REST API·MVC 같은 개념, 오피스, 자격증, 일반 역량은 제외. 'Javasc ript' 는 JavaScript 로 복원.",
    "- assign: unclassified 항목만 분류. i 는 아래 번호. bucket 은 key_duties | must_have | nice_to_have | drop. 회사소개·복리후생·채용절차·유의사항은 drop.",
    "- 이미 분류된 목록의 항목은 assign 에 넣지 마라. 문장을 출력하지 마라.",
    `- role_summary 한 문장(≤${JD_LIMITS.ROLE_SUMMARY_MAX}자), compressed_text 카드용 한 줄(목표 ${JD_LIMITS.COMPRESSED_TARGET}자, 절대 ${JD_LIMITS.COMPRESSED_MAX}자 초과 금지). 글자 수 표기 넣지 말 것.`,
    "- 고용형태 표현을 바꿔 쓰지 마라. 본문에 없는 내용을 추정하지 마라.",
    "",
    `제목: ${input.title}`,
    `회사: ${input.company}`,
    "",
    "[이미 분류된 key_duties]",
    numbered(input.lists.key_duties),
    "",
    "[이미 분류된 must_have]",
    numbered(input.lists.must_have),
    "",
    "[이미 분류된 nice_to_have]",
    numbered(input.lists.nice_to_have),
    "",
    "[분류 대상 unclassified]",
    numbered(input.lists.unclassified),
  ].join("\n");
}

function clampText(s: string, max: number): string {
  const t = s.trim();
  const chars = [...t];
  if (chars.length <= max) return t;
  const head = chars.slice(0, max).join("");
  const cut = Math.max(head.lastIndexOf("다."), head.lastIndexOf(". "), head.lastIndexOf("요."));
  return cut >= Math.floor(max * 0.5) ? head.slice(0, cut + (head[cut] === "다" || head[cut] === "요" ? 2 : 1)) : head;
}

function clampList(v: unknown, itemMax: number, dropLong: boolean): string[] {
  const out: string[] = [];
  for (const x of Array.isArray(v) ? v : []) {
    let s = String(x ?? "").trim();
    if (!s) continue;
    if ([...s].length > itemMax) {
      if (dropLong) continue;
      s = [...s].slice(0, itemMax).join("");
    }
    out.push(s);
    if (out.length >= JD_LIMITS.ARRAY_MAX) break;
  }
  return out;
}

export function clampToLimits(raw: unknown): JdCompressed {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    role_summary: clampText(String(r.role_summary ?? ""), JD_LIMITS.ROLE_SUMMARY_MAX),
    key_duties: clampList(r.key_duties, JD_LIMITS.ITEM_MAX, false),
    must_have: clampList(r.must_have, JD_LIMITS.ITEM_MAX, false),
    nice_to_have: clampList(r.nice_to_have, JD_LIMITS.ITEM_MAX, false),
    skills: clampList(r.skills, JD_LIMITS.SKILL_MAX, true),
    compressed_text: clampText(String(r.compressed_text ?? ""), JD_LIMITS.COMPRESSED_MAX),
  };
}

export function stripLengthNote(s: string): string {
  return s.replace(/\s*[(（\[]\s*\d{1,4}\s*(?:자|글자|chars?)\s*[)）\]]\s*$/i, "").trim();
}

function mergeClassify(lists: BodyLists, raw: unknown): JdCompressed {
  const parsed = ClassifySchema.safeParse(raw);
  const cls = parsed.success
    ? parsed.data
    : {
        assign: [],
        skills: [] as string[],
        role_summary: "",
        compressed_text: "",
        ...(raw && typeof raw === "object" ? (raw as object) : {}),
      };
  const data: JdCompressed = {
    role_summary: String(cls.role_summary ?? ""),
    key_duties: [...lists.key_duties],
    must_have: [...lists.must_have],
    nice_to_have: [...lists.nice_to_have],
    skills: Array.isArray(cls.skills) ? cls.skills.map(String) : [],
    compressed_text: String(cls.compressed_text ?? ""),
  };
  const seen = new Set<number>();
  for (const a of Array.isArray(cls.assign) ? cls.assign : []) {
    const i = Number(a?.i);
    if (!Number.isInteger(i) || seen.has(i) || i < 0 || i >= lists.unclassified.length) continue;
    seen.add(i);
    const bucket = a.bucket;
    if (bucket === "drop") continue;
    if (data[bucket].length < JD_LIMITS.ARRAY_MAX) data[bucket].push(lists.unclassified[i]);
  }
  data.compressed_text = stripLengthNote(data.compressed_text);
  return clampToLimits(data);
}

export async function compressJd(input: {
  title: string;
  company: string;
  lists: BodyLists;
}): Promise<CompressResult> {
  const lists: BodyLists = {
    key_duties: clampList(input.lists.key_duties, JD_LIMITS.ITEM_MAX, false),
    must_have: clampList(input.lists.must_have, JD_LIMITS.ITEM_MAX, false),
    nice_to_have: clampList(input.lists.nice_to_have, JD_LIMITS.ITEM_MAX, false),
    unclassified: clampList(input.lists.unclassified, JD_LIMITS.ITEM_MAX, false),
  };
  const prompt = buildPrompt({ title: input.title, company: input.company, lists });
  const schema = geminiSchema();

  const first = await generateStructured<unknown>(prompt, schema, "jd-compress");
  const p1 = ClassifySchema.safeParse(first);
  if (p1.success) return { data: mergeClassify(lists, p1.data), status: "ok", attempts: 1, violations: [] };

  const violations = describeIssues(first, p1.error.issues);
  const retryPrompt = [
    prompt,
    "",
    "[이전 출력이 제약을 어겼다. 아래 위반을 모두 고쳐서 다시 출력하라. 불릿 문장은 출력하지 마라]",
    ...violations.map((v) => `- ${v}`),
    `compressed_text 는 ${JD_LIMITS.COMPRESSED_TARGET}자 이내로 더 줄여라.`,
  ].join("\n");
  const second = await generateStructured<unknown>(retryPrompt, schema, "jd-compress-retry");
  const p2 = ClassifySchema.safeParse(second);
  if (p2.success) return { data: mergeClassify(lists, p2.data), status: "retried_ok", attempts: 2, violations };

  return {
    data: mergeClassify(lists, second),
    status: "truncated",
    attempts: 2,
    violations: [...violations, ...describeIssues(second, p2.error.issues).map((v) => `retry: ${v}`)],
  };
}

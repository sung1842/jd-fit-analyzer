/**
 * 라이프 로그 순수 로직 (헌법 3조: LLM 주입 전 prune·정규화 / 코드 검증). DB·Redis·env 의존 없음 → 단위 테스트 대상.
 */
import { LifePolishOutputSchema, LifeStructureOutputSchema, type LifePolishOutput, type LifeStructureOutput } from "./schemas.js";

export interface RawLifeMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  created_at?: string;
}

export interface PrunedMessage {
  /** 프롬프트용 짧은 id (m1, m2 ...) */
  ref: string;
  id: string;
  role: "user" | "assistant";
  text: string;
}

export const LIFE_PRUNE_LIMITS = { perMessage: 800, total: 12_000 } as const;

const LOG_PREFIX = /^\s*(\[[^\]\n]{1,40}\]\s*)+/gm; // [12:01] [INFO] 같은 로그 태그
const HTML_TAG = /<\/?[a-zA-Z][^>]{0,200}>/g;

export function normalizeText(text: string): string {
  return text.replace(LOG_PREFIX, "").replace(HTML_TAG, " ").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * system 제거 → 로그 태그·HTML 제거 → 빈 메시지·중복 제거 → 메시지별 길이 상한 → 총량 상한(최근 우선).
 * 메시지 id 는 ref ↔ id 매핑으로 유지한다.
 */
export function pruneLifeMessages(messages: RawLifeMessage[], limits: { perMessage: number; total: number } = LIFE_PRUNE_LIMITS): PrunedMessage[] {
  const seen = new Set<string>();
  const kept: Omit<PrunedMessage, "ref">[] = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    let text = normalizeText(m.content ?? "");
    if (!text) continue;
    const dedupeKey = `${m.role}:${text}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    if (text.length > limits.perMessage) text = `${text.slice(0, limits.perMessage)}…`;
    kept.push({ id: m.id, role: m.role, text });
  }
  let total = 0;
  let start = kept.length;
  while (start > 0 && total + kept[start - 1].text.length <= limits.total) {
    total += kept[start - 1].text.length;
    start--;
  }
  return kept.slice(start).map((m, i) => ({ ...m, ref: `m${i + 1}` }));
}

export function renderTranscript(pruned: PrunedMessage[]): string {
  return pruned.map((m) => `[${m.ref}] ${m.role === "user" ? "사용자" : "AI"}: ${m.text}`).join("\n");
}

export interface ValidatedStructure {
  activities: {
    title: string;
    summary: string;
    occurredOn: string | null;
    tags: string[];
    drafts: { slot: number; text: string; quotes: string[] }[]; // quotes = life_messages.id
    cards: { claim: string; quotes: string[] }[];
  }[];
  memory: { key: string; value: string }[];
  dropped: number;
}

/**
 * 인용 검증: quotes 가 비었거나 세션(사용자 발화)에 없는 ref 를 하나라도 인용하면 그 문장/카드를 폐기.
 * 남은 초안·카드가 없는 활동도 폐기. 스키마 위반이면 throw.
 */
export function validateStructure(raw: unknown, pruned: PrunedMessage[]): ValidatedStructure {
  const parsed: LifeStructureOutput = LifeStructureOutputSchema.parse(raw);
  const refToId = new Map(pruned.filter((m) => m.role === "user").map((m) => [m.ref, m.id]));
  let dropped = 0;
  const mapQuotes = (quotes: string[]): string[] | null => {
    if (quotes.length === 0) return null;
    const ids: string[] = [];
    for (const q of quotes) {
      const id = refToId.get(q.trim());
      if (!id) return null;
      if (!ids.includes(id)) ids.push(id);
    }
    return ids;
  };
  const dateOk = (d: string | null | undefined) => (d && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d)) ? d : null);

  const activities: ValidatedStructure["activities"] = [];
  for (const a of parsed.activities) {
    const drafts = a.drafts.flatMap((d) => {
      const q = mapQuotes(d.quotes);
      if (!q) return dropped++, [];
      return [{ slot: d.slot, text: d.text.trim(), quotes: q }];
    });
    const cards = a.cards.flatMap((c) => {
      const q = mapQuotes(c.quotes);
      if (!q) return dropped++, [];
      return [{ claim: c.claim.trim(), quotes: q }];
    });
    if (drafts.length === 0 && cards.length === 0) {
      dropped++;
      continue;
    }
    activities.push({ title: a.title.trim(), summary: a.summary.trim(), occurredOn: dateOk(a.occurredOn), tags: a.tags, drafts, cards });
  }
  return { activities, memory: parsed.memory, dropped };
}

// ---------- polish 검증 ----------
const NUMBER = /\d+(?:[.,]\d+)*/g;
const LATIN = /[A-Za-z][A-Za-z0-9.+#_-]*/g;
const QUOTED = /["“'‘「『]([^"”'’」』]{1,60})["”'’」』]/g;

/** 원문에 없는 숫자·영문 고유명사·인용구가 교정본에 생겼으면 그 목록 (비면 통과) */
export function findPolishViolations(original: string, polished: string): string[] {
  const norm = (s: string) => s.toLowerCase().replace(/,/g, "");
  const orig = norm(original);
  const violations = new Set<string>();
  for (const re of [NUMBER, LATIN]) {
    for (const m of polished.match(re) ?? []) if (!orig.includes(norm(m))) violations.add(m);
  }
  for (const m of polished.matchAll(QUOTED)) if (!orig.includes(norm(m[1]))) violations.add(m[1]);
  return [...violations];
}

export type PolishVerdict = { ok: true; value: LifePolishOutput } | { ok: false; reason: string };

export function validatePolish(original: string, raw: unknown): PolishVerdict {
  const parsed = LifePolishOutputSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: "schema" };
  const polished = parsed.data.polished.trim();
  if (polished.length > Math.max(original.length * 1.5, original.length + 80)) return { ok: false, reason: "too_long" };
  const v = findPolishViolations(original, polished);
  if (v.length) return { ok: false, reason: `new_facts:${v.length}` };
  return { ok: true, value: { polished, changedSpans: parsed.data.changedSpans } };
}

/** Sentry/Langfuse 용: 원문 대신 길이만 남긴다 */
export function maskText(text: string | null | undefined): string {
  return `[masked ${text?.length ?? 0} chars]`;
}

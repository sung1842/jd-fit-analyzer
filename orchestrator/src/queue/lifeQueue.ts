import { createHash, randomUUID } from "node:crypto";
import { Queue, UnrecoverableError, Worker, type Job } from "bullmq";
import { createUserDbClient } from "../lib/auth.js";
import { LIFE_STRUCTURE_MODEL, generateLifeJson } from "../lib/lifeGemini.js";
import { maskText, pruneLifeMessages, renderTranscript, validatePolish, validateStructure, type RawLifeMessage } from "../lib/lifePrune.js";
import { createRedisConnection } from "../lib/redis.js";
import { LIFE_POLISH_JSON_SCHEMA, LIFE_STRUCTURE_JSON_SCHEMA } from "../lib/schemas.js";
import { Sentry } from "../lib/sentry.js";

/**
 * 라이프 로그 잡 (헌법 2조). 큐 하나, 잡 이름 3종:
 *   life-structure  세션 종료 → prune → LLM 1회(responseJsonSchema) → 인용 검증 → activities/activity_drafts/evidence_cards(draft)/user_memory
 *   life-polish     카드 교정 → LLM 1회 → 새 숫자·고유명사 생기면 폐기 → claim 갱신 + ai_edited=true (서버만 세팅)
 *   life-publish    공개 전환 → 공개 뷰의 카드 내용만 임베딩(MCP embed_evidence_card) + 해당 후보 fit 캐시 키 무효화
 *   life-unpublish  공개 철회 → 카드 임베딩 삭제 + 해당 후보 fit 캐시 키 무효화
 *
 * 토큰 만료: 사용자 토큰 DB 호출이 JWT 만료로 실패하면 재시도 없이(UnrecoverableError) 실패 사유 'token_expired' 로 남긴다.
 * Sentry 로 보내지 않는다 (인프라 에러가 아니라 사용자 세션 만료 — 클라이언트가 재로그인 후 다시 요청).
 *
 * life_* 테이블은 사용자 토큰(RLS) 클라이언트로만 접근한다 → structure/polish 잡 데이터에 access token 을 싣는다.
 * 토큰은 짧은 수명(Supabase 기본 1h). 성공 시 잡 데이터에서 즉시 지우고, 잡 자체도 1h 뒤 Redis 에서 삭제한다.
 */
export const LIFE_QUEUE = "life";

export type LifeJobData =
  | { kind: "life-structure"; userId: string; accessToken: string; sessionId: string }
  | { kind: "life-polish"; userId: string; accessToken: string; cardId: string }
  | { kind: "life-publish"; userId: string; cardId: string }
  | { kind: "life-unpublish"; userId: string; cardId: string };

export type LifeJobResult =
  | { kind: "life-structure"; activities: number; drafts: number; cards: number; dropped: number }
  | { kind: "life-polish"; applied: boolean; reason?: string; previous?: string; polished?: string; changedSpans?: { before: string; after: string }[] }
  | { kind: "life-publish"; chunksUpdated: number; indexed: boolean; cacheKeysDeleted: number }
  | { kind: "life-unpublish"; chunksDeleted: number; cacheKeysDeleted: number };

export const TOKEN_EXPIRED = "token_expired";

/** PostgREST/GoTrue 의 JWT 만료 에러인지 (PGRST301/PGRST303, 401, "jwt expired"). */
export function isTokenExpiredError(error: { code?: string; message?: string; status?: number } | null | undefined): boolean {
  if (!error) return false;
  if (error.code === "PGRST301" || error.code === "PGRST303" || error.status === 401) return true;
  return /jwt expired|token is expired|invalid jwt/i.test(error.message ?? "");
}

/** 사용자 토큰 DB 에러 → 만료면 재시도 없는 token_expired, 아니면 일반 에러(코드만, 원문 미포함). */
export function userDbError(label: string, error: { code?: string; message?: string; status?: number } | null | undefined): Error {
  if (isTokenExpiredError(error)) return new UnrecoverableError(TOKEN_EXPIRED);
  return new Error(`${label} 실패: ${error?.code}`);
}

let queue: Queue<LifeJobData, LifeJobResult> | null = null;
const connections: ReturnType<typeof createRedisConnection>[] = [];
function connection() {
  const c = createRedisConnection();
  connections.push(c);
  return c;
}
export const closers: (() => Promise<void>)[] = [];
export async function closeLifeQueue(): Promise<void> {
  await queue?.close();
  queue = null;
  for (const close of closers.splice(0)) await close();
  for (const c of connections.splice(0)) c.disconnect();
}

export function getLifeQueue(): Queue<LifeJobData, LifeJobResult> {
  queue ??= new Queue(LIFE_QUEUE, {
    connection: connection(),
    defaultJobOptions: { attempts: 2, backoff: { type: "fixed", delay: 5_000 }, removeOnComplete: { age: 3600 }, removeOnFail: { age: 3600 } },
  });
  return queue;
}

export function buildLifeJobId(kind: LifeJobData["kind"], targetId: string): string {
  return `${kind}_${createHash("sha256").update(`${targetId}:${randomUUID()}`).digest("hex").slice(0, 24)}`;
}

export function isLifeJobId(jobId: string): boolean {
  return /^life-(structure|polish|publish|unpublish)_[0-9a-f]{24}$/.test(jobId);
}

export async function enqueueLifeJob(data: LifeJobData, targetId: string): Promise<string> {
  const jobId = buildLifeJobId(data.kind, targetId);
  await getLifeQueue().add(data.kind, data, { jobId });
  return jobId;
}

/** 세션 source(app|web|import) → 카드 source. 015 CHECK 와 동일 값. 모르는 값은 web. */
export function lifeCardSource(sessionSource: unknown): "app" | "web" | "import" {
  return sessionSource === "app" || sessionSource === "import" ? sessionSource : "web";
}

// ---------------- processors ----------------
async function runStructure(job: Job<LifeJobData>, data: Extract<LifeJobData, { kind: "life-structure" }>): Promise<LifeJobResult> {
  const udb = createUserDbClient(data.accessToken);
  await job.updateProgress({ stage: "loading" });
  const { data: msgs, error } = await udb
    .from("life_messages")
    .select("id, role, content, created_at")
    .eq("session_id", data.sessionId)
    .order("created_at", { ascending: true });
  if (error) throw userDbError("life_messages 조회", error);
  const pruned = pruneLifeMessages((msgs ?? []) as RawLifeMessage[]);
  if (!pruned.some((m) => m.role === "user")) return { kind: "life-structure", activities: 0, drafts: 0, cards: 0, dropped: 0 };

  // 카드 source = 세션 source (app|web|import). 웹 배지: web → "회고 입력(입력일 기준)".
  const { data: session, error: sErr } = await udb.from("life_sessions").select("source").eq("id", data.sessionId).maybeSingle();
  if (sErr) throw userDbError("life_sessions 조회", sErr);
  const cardSource = lifeCardSource(session?.source);

  const { data: memRows } = await udb.from("user_memory").select("key, value").eq("user_id", data.userId);
  const memory = (memRows ?? []).map((r: { key: string; value: string }) => `${r.key}: ${r.value.slice(0, 600)}`).join("\n");

  const prompt = [
    "아래 대화 기록에서 사용자의 활동을 정리하라. 사용자 발화([mN] 사용자)에 있는 사실만 쓴다. 지어내지 않는다.",
    "drafts: 6칸(1 상황, 2 역할, 3 행동, 4 어려움, 5 결과, 6 배운 점) 중 근거가 있는 칸만 문장 단위로. 모든 문장은 quotes 에 근거 메시지 id(m1 형식)를 1개 이상.",
    "cards: 기업에 보여줄 수 있는 한 줄 주장(근거 quotes 필수). memory: profile_summary/open_threads/tone 을 기존 메모리와 합쳐 짧게 갱신.",
    memory ? `기존 메모리:\n${memory}` : "기존 메모리: 없음",
    `대화:\n${renderTranscript(pruned)}`,
  ].join("\n\n");

  await job.updateProgress({ stage: "structuring" });
  const raw = await generateLifeJson("life-structure", LIFE_STRUCTURE_MODEL, prompt, LIFE_STRUCTURE_JSON_SCHEMA as unknown as Record<string, unknown>);
  const result = validateStructure(raw, pruned);

  await job.updateProgress({ stage: "saving" });
  let drafts = 0;
  let cards = 0;
  for (const a of result.activities) {
    const { data: act, error: aErr } = await udb
      .from("activities")
      .insert({ user_id: data.userId, session_id: data.sessionId, title: a.title, summary: a.summary, occurred_on: a.occurredOn, tags: a.tags })
      .select("id")
      .single();
    if (aErr || !act) throw userDbError("activities insert", aErr);
    if (a.drafts.length) {
      const quotes = [...new Set(a.drafts.flatMap((d) => d.quotes))];
      const { error: dErr } = await udb.from("activity_drafts").insert({
        user_id: data.userId,
        activity_id: act.id,
        session_id: data.sessionId,
        draft: { sentences: a.drafts },
        quotes,
      });
      if (dErr) throw userDbError("activity_drafts insert", dErr);
      drafts += a.drafts.length;
    }
    if (a.cards.length) {
      const { error: cErr } = await udb.from("evidence_cards").insert(
        a.cards.map((c) => ({ user_id: data.userId, activity_id: act.id, claim: c.claim, visibility: "private", source: cardSource, links: [] }))
      );
      if (cErr) throw userDbError("evidence_cards insert", cErr);
      cards += a.cards.length;
    }
  }
  if (result.memory.length) {
    const now = new Date().toISOString();
    const { error: mErr } = await udb
      .from("user_memory")
      .upsert(result.memory.map((m) => ({ user_id: data.userId, key: m.key, value: m.value, updated_at: now })), { onConflict: "user_id,key" });
    if (mErr) throw userDbError("user_memory upsert", mErr);
  }
  return { kind: "life-structure", activities: result.activities.length, drafts, cards, dropped: result.dropped };
}

async function runPolish(data: Extract<LifeJobData, { kind: "life-polish" }>): Promise<LifeJobResult> {
  const udb = createUserDbClient(data.accessToken);
  const { data: card, error } = await udb.from("evidence_cards").select("id, claim").eq("id", data.cardId).maybeSingle();
  if (error) throw userDbError("evidence_cards 조회", error);
  if (!card) return { kind: "life-polish", applied: false, reason: "not_found" };
  const original: string = card.claim;
  const prompt = [
    "다음 문장을 맞춤법·문장 다듬기만 교정하라. 새 사실·숫자·이름·주장을 추가하지 말고 의미를 바꾸지 마라.",
    "changedSpans 에 바뀐 부분(before/after)을 적어라.",
    `문장: ${original}`,
  ].join("\n");
  const raw = await generateLifeJson("life-polish", LIFE_STRUCTURE_MODEL, prompt, LIFE_POLISH_JSON_SCHEMA as unknown as Record<string, unknown>);
  const verdict = validatePolish(original, raw);
  if (!verdict.ok) return { kind: "life-polish", applied: false, reason: verdict.reason };
  if (verdict.value.polished === original) return { kind: "life-polish", applied: false, reason: "unchanged" };
  const { error: uErr } = await udb.from("evidence_cards").update({ claim: verdict.value.polished, ai_edited: true }).eq("id", data.cardId);
  if (uErr) throw userDbError("evidence_cards update", uErr);
  return { kind: "life-polish", applied: true, previous: original, polished: verdict.value.polished, changedSpans: verdict.value.changedSpans };
}

/** 공개 카드 임베딩(portfolio_chunks, source_field=evidence_card:<id>) 삭제 + 해당 후보 fitreport 캐시 무효화. life_* 는 건드리지 않는다. */
async function runUnpublish(data: Extract<LifeJobData, { kind: "life-unpublish" }>): Promise<LifeJobResult> {
  const { db } = await import("../lib/db.js");
  const { data: deleted, error } = await db
    .from("portfolio_chunks")
    .delete()
    .eq("candidate_id", data.userId)
    .eq("source_field", `evidence_card:${data.cardId}`)
    .select("id");
  if (error) throw new Error(`portfolio_chunks delete 실패: ${error.code}`);

  const cacheKeysDeleted = await invalidateFitCache(data.userId);
  return { kind: "life-unpublish", chunksDeleted: deleted?.length ?? 0, cacheKeysDeleted };
}

/** 해당 후보의 fitreport 캐시 키(fitreport:cache:<jdHash>:<candidateId>) 전부 삭제. */
async function invalidateFitCache(userId: string): Promise<number> {
  const r = connection();
  let cacheKeysDeleted = 0;
  try {
    let cursor = "0";
    do {
      const [next, keys] = await r.scan(cursor, "MATCH", `fitreport:cache:*:${userId}`, "COUNT", 500);
      cursor = next;
      if (keys.length) cacheKeysDeleted += await r.del(...keys);
    } while (cursor !== "0");
  } finally {
    r.disconnect();
    connections.splice(connections.indexOf(r), 1);
  }
  return cacheKeysDeleted;
}

/** 공개 전환 → MCP embed_evidence_card(공개 뷰의 claim 만 읽음, source_field=evidence_card:<id>) + 캐시 무효화. 사용자 토큰 불필요. */
async function runPublish(data: Extract<LifeJobData, { kind: "life-publish" }>): Promise<LifeJobResult> {
  const { callMcpTool } = await import("../mcp/client.js");
  const r = await callMcpTool<{ chunksUpdated: number; indexed: boolean }>("embed_evidence_card", { candidateId: data.userId, cardId: data.cardId });
  const cacheKeysDeleted = await invalidateFitCache(data.userId);
  return { kind: "life-publish", chunksUpdated: r.chunksUpdated, indexed: r.indexed, cacheKeysDeleted };
}

export async function processLifeJob(job: Job<LifeJobData>): Promise<LifeJobResult> {
  const data = job.data;
  if (data.kind === "life-unpublish") return runUnpublish(data);
  if (data.kind === "life-publish") return runPublish(data);
  const result = data.kind === "life-structure" ? await runStructure(job, data) : await runPolish(data);
  await job.updateData({ ...data, accessToken: "" }); // 성공 후 토큰 제거
  return result;
}

export function startLifeWorker() {
  const worker = new Worker<LifeJobData, LifeJobResult>(LIFE_QUEUE, processLifeJob, {
    connection: connection(),
    concurrency: Number(process.env.LIFE_WORKER_CONCURRENCY || 2),
  });
  worker.on("completed", (job) => console.log(`[${worker.name}] job ${job.id} completed (${job.data.kind})`));
  worker.on("failed", (job, err) => {
    // 원문·토큰이 섞이지 않게 메시지 대신 에러 이름만, 잡 데이터는 id 만 태그로.
    console.error(`[${worker.name}] job ${job?.id} failed (${job?.data.kind}): ${err.name} ${err.message.slice(0, 120)}`);
    // 토큰 만료는 사용자 세션 문제 — failedReason='token_expired' 로만 남기고 Sentry 로 보내지 않는다.
    if (err.message === TOKEN_EXPIRED) return;
    if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
      Sentry.captureMessage(`life job failed: ${job.data.kind} ${err.name}`, {
        level: "error",
        tags: { worker: worker.name, jobId: job.id, kind: job.data.kind },
        extra: { detail: maskText(err.message) },
      });
    }
  });
  closers.push(() => worker.close());
  return worker;
}

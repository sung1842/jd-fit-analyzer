import { z } from "zod";

// MCP tool(analyze_tech_stack/analyze_experience/analyze_culture_fit) 응답이 AgentResult 포맷을 만족하는지
// 1차 검증(코드, 포맷 체크)에 사용
export const AgentResultSchema = z.object({
  agent: z.enum(["tech_stack", "experience", "culture_fit"]),
  score: z.number(),
  summary: z.string(),
  matched_items: z.array(z.string()),
  missing_items: z.array(z.string()),
  evidence: z.array(z.string()),
  flags: z.array(z.string()).optional(),
});

// =====================================================================
// 라이프 로그 API 계약 (/api/v1/life/*) — 19 문서 1·4절, SQL 015.
// 앱·웹이 같은 계약을 쓴다. 모든 엔드포인트는 Authorization: Bearer <Supabase access token> 필수.
// =====================================================================
const uuid = z.string().uuid();

/** POST /api/v1/life/sessions → 201 { session: LifeSession } */
export const LifeCreateSessionSchema = z
  .object({
    source: z.enum(["app", "web", "import"]).default("web"),
    title: z.string().trim().max(200).optional(),
  })
  .strict();

/**
 * POST /api/v1/life/sessions/:id/messages
 *  reply=true(기본): text/event-stream — event: user {messageId} → event: delta {text}* → event: done {messageId} | event: error {error}
 *  reply=false: 201 { messageId } (웹 간이 입력: AI 응답 없이 저장만)
 */
export const LifeMessageSchema = z
  .object({
    content: z.string().trim().min(1).max(4000),
    reply: z.boolean().default(true),
  })
  .strict();

/** PATCH /api/v1/life/cards/:id — claim/links/visibility 만. ai_edited·recorded_at·trust_level 등은 strict 로 거부(400). */
/** 근거: link(웹 주소) | image·file(Supabase Storage 비공개 버킷 evidence, url = storage://evidence/<uid>/...) — SQL 018 */
export const LifeCardLinkSchema = z
  .object({
    url: z.string().max(2000).refine((u) => /^https?:\/\//.test(u) || /^storage:\/\/evidence\/[\w-]{36}\/[^\s]+$/.test(u), "http(s) 주소 또는 storage://evidence/<사용자>/… 만 됩니다"),
    label: z.string().trim().max(200).optional(),
    kind: z.enum(["link", "image", "file"]).optional(),
  })
  .strict();
export const LifeCardPatchSchema = z
  .object({
    claim: z.string().trim().min(1).max(1000).optional(),
    links: z.array(LifeCardLinkSchema).max(20).optional(),
    visibility: z.literal("private").optional(), // 공개는 publish 엔드포인트로만
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: "변경할 필드가 없습니다." });

/** POST/DELETE /api/v1/life/match-exclusions — jobPostingId 없음(null) = 전체 매칭 제외 */
export const LifeMatchExclusionSchema = z
  .object({ jobPostingId: uuid.nullable().default(null) })
  .strict();

export const LifeIdParamSchema = uuid;

/**
 * POST /api/v1/life/consents/:purpose/revoke — 사용자 토큰 RLS 로 revoked_at=now().
 *  matching → 202 { revoked, jobIds }  (본인 공개 카드마다 life-unpublish 잡: 임베딩 삭제 + fit 캐시 무효화)
 *  self_ai  → 200 { revoked, jobIds: [] }
 *  이미 철회됨(유효 동의 없음) → 200 { revoked: 0, jobIds: [] }
 */
export const LifeConsentPurposeSchema = z.enum(["self_ai", "matching"]);

// ---------- LLM 출력 스키마 (responseJsonSchema 로 강제 + Zod 재검증) ----------
/** life-structure: 메시지 id 는 프롬프트에 넣은 짧은 id(m1, m2 ...) */
export const LifeStructureOutputSchema = z.object({
  activities: z
    .array(
      z.object({
        title: z.string().min(1).max(200),
        summary: z.string().max(1000),
        occurredOn: z.string().nullable().optional(),
        tags: z.array(z.string().max(40)).max(10),
        drafts: z
          .array(z.object({ slot: z.number().int().min(1).max(6), text: z.string().min(1).max(1000), quotes: z.array(z.string()) }))
          .max(30),
        cards: z.array(z.object({ claim: z.string().min(1).max(500), quotes: z.array(z.string()) })).max(10),
      })
    )
    .max(10),
  memory: z.array(z.object({ key: z.enum(["profile_summary", "open_threads", "tone"]), value: z.string().max(2000) })).max(3),
});
export type LifeStructureOutput = z.infer<typeof LifeStructureOutputSchema>;

export const LIFE_STRUCTURE_JSON_SCHEMA = {
  type: "object",
  properties: {
    activities: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          summary: { type: "string" },
          occurredOn: { type: ["string", "null"], description: "YYYY-MM-DD, 모르면 null" },
          tags: { type: "array", items: { type: "string" } },
          drafts: {
            type: "array",
            items: {
              type: "object",
              properties: {
                slot: { type: "integer", minimum: 1, maximum: 6 },
                text: { type: "string" },
                quotes: { type: "array", items: { type: "string" }, description: "근거 메시지 id (m1 형식)" },
              },
              required: ["slot", "text", "quotes"],
            },
          },
          cards: {
            type: "array",
            items: {
              type: "object",
              properties: { claim: { type: "string" }, quotes: { type: "array", items: { type: "string" } } },
              required: ["claim", "quotes"],
            },
          },
        },
        required: ["title", "summary", "tags", "drafts", "cards"],
      },
    },
    memory: {
      type: "array",
      items: {
        type: "object",
        properties: { key: { type: "string", enum: ["profile_summary", "open_threads", "tone"] }, value: { type: "string" } },
        required: ["key", "value"],
      },
    },
  },
  required: ["activities", "memory"],
} as const;

/** life-polish */
export const LifePolishOutputSchema = z.object({
  polished: z.string().min(1).max(1000),
  changedSpans: z.array(z.object({ before: z.string(), after: z.string() })).max(50),
});
export type LifePolishOutput = z.infer<typeof LifePolishOutputSchema>;

export const LIFE_POLISH_JSON_SCHEMA = {
  type: "object",
  properties: {
    polished: { type: "string" },
    changedSpans: {
      type: "array",
      items: { type: "object", properties: { before: { type: "string" }, after: { type: "string" } }, required: ["before", "after"] },
    },
  },
  required: ["polished", "changedSpans"],
} as const;

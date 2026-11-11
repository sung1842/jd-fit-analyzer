import type { EvidenceCardInput } from "../../../shared/types.js";

// 19 문서 6절: 매칭 경로는 공개 카드 뷰(public_evidence_cards)만 조회한다.
// evidence_cards·life_*·user_memory 직접 조회 금지. 헌법 3조: 투입 전 prune (상위 N장, claim 길이 상한, 필드 5개).
export const PUBLIC_EVIDENCE_VIEW = "public_evidence_cards";
export const MAX_CARDS_PER_CANDIDATE = 8;
export const MAX_CLAIM_LENGTH = 200;

// 2026-11-11 결정: 카드의 신뢰 등급(self/attached/confirmed)은 아무도 검증하지 않으므로 분석에 쓰지 않는다.
// 모든 카드를 "자기 신고"로 똑같이 넘기고, 진위는 면접에서 사람이 확인한다. 정렬은 최신순만.
export const UNIFIED_TRUST = "self";

export interface PublicEvidenceCardRow {
  id: string;
  user_id: string;
  claim: string | null;
  trust_level: string | null;
  recorded_at: string | null;
  source: string | null;
  links?: unknown;
  ai_edited?: boolean | null;
}

// 뷰/테이블 미적용(원격 마이그레이션 전)을 나타내는 PostgREST/Postgres 에러인지
export function isMissingRelationError(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  if (error.code === "42P01" || error.code === "PGRST205") return true;
  const msg = (error.message ?? "").toLowerCase();
  return msg.includes("does not exist") || msg.includes("could not find the table");
}

/** 정렬(최신순) 후 상위 N장, claim 길이 상한 적용, 투입 필드 5개만 남긴다. */
export function prunePublicEvidenceCards(
  rows: PublicEvidenceCardRow[],
  limit = MAX_CARDS_PER_CANDIDATE,
  maxClaim = MAX_CLAIM_LENGTH
): EvidenceCardInput[] {
  return rows
    .filter((r) => r && typeof r.id === "string" && typeof r.claim === "string" && r.claim.trim().length > 0)
    .sort((a, b) => (b.recorded_at ?? "").localeCompare(a.recorded_at ?? ""))
    .slice(0, limit)
    .map((r) => {
      const claim = r.claim!.trim();
      return {
        id: r.id,
        claim: claim.length > maxClaim ? `${claim.slice(0, maxClaim - 1)}…` : claim,
        trust: UNIFIED_TRUST,
        recorded_at: r.recorded_at,
        source: r.source,
      };
    });
}

// supabase-js 클라이언트의 최소 형태 (테스트에서 가짜 주입)
export interface EvidenceQueryClient {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from(table: string): any;
}

export async function fetchPublicEvidenceCards(client: EvidenceQueryClient, userId: string): Promise<EvidenceCardInput[]> {
  const { data, error } = await client
    .from(PUBLIC_EVIDENCE_VIEW)
    .select("id, user_id, claim, trust_level, recorded_at, source")
    .eq("user_id", userId)
    .order("recorded_at", { ascending: false })
    .limit(MAX_CARDS_PER_CANDIDATE * 4);
  if (error) {
    if (isMissingRelationError(error)) return [];
    throw new Error(`공개 카드 조회 실패: ${error.message}`);
  }
  return prunePublicEvidenceCards((data ?? []) as PublicEvidenceCardRow[]);
}

/** match_exclusions 에서 제외할 user_id 집합. job_posting_id null = 전체 제외. 테이블 없으면 빈 집합. */
export async function fetchExcludedUserIds(client: EvidenceQueryClient, jobPostingId?: string): Promise<Set<string>> {
  const { data, error } = await client.from("match_exclusions").select("user_id, job_posting_id");
  if (error) {
    if (isMissingRelationError(error)) return new Set();
    throw new Error(`match_exclusions 조회 실패: ${error.message}`);
  }
  const ids = new Set<string>();
  for (const row of (data ?? []) as { user_id: string; job_posting_id: string | null }[]) {
    if (row.job_posting_id === null || (jobPostingId !== undefined && row.job_posting_id === jobPostingId)) ids.add(row.user_id);
  }
  return ids;
}

/** 프롬프트용 카드 섹션 + 인용 지시 */
export function buildEvidenceCardPrompt(cards: EvidenceCardInput[] | undefined): string {
  if (!cards || cards.length === 0) return "\n[EvidenceCards]: 없음. citedCardIds 는 빈 배열로 둬라.";
  return `\n[EvidenceCards]: ${JSON.stringify(cards)}\n근거 카드를 인용할 때는 위 EvidenceCards 에 있는 id 만 citedCardIds 에 넣어라. 목록에 없는 id 를 만들거나 추측하지 마라.`;
}

export const CITED_CARD_IDS_SCHEMA = {
  type: "ARRAY",
  items: { type: "STRING" },
  description: "판단 근거로 인용한 EvidenceCards 의 id (제공된 카드 id 만 허용, 없으면 빈 배열)",
};

/** 응답 citedCardIds 를 문자열 배열로 정규화하고 trust 를 붙인다. 부분집합 검증은 orchestrator validation.ts 담당. */
export function toCitations(raw: unknown, cards: EvidenceCardInput[] | undefined) {
  const ids = Array.isArray(raw) ? [...new Set(raw.filter((v): v is string => typeof v === "string"))] : [];
  const trustById = new Map((cards ?? []).map((c) => [c.id, c.trust]));
  return {
    citedCardIds: ids,
    citedCards: ids.filter((id) => trustById.has(id)).map((id) => ({ id, trust: trustById.get(id)! })),
  };
}

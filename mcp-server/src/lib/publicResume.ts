import type { PublicResumeInput } from "../../../shared/types.js";
import { isMissingRelationError, type EvidenceQueryClient } from "./evidenceCards.js";

// SQL 016: 매칭 경로는 공개 뷰(public_resumes, public_cover_letters)만 조회한다. resume_*·cover_letters 직접 조회 금지.
// 헌법 3조: 투입 전 prune — 항목 수·글자 수 상한, 필요한 필드만.
export const MAX_EXPERIENCES = 5;
export const MAX_EDUCATIONS = 3;
export const MAX_CERTS = 8;
export const MAX_MISC = 5;
export const MAX_LETTER_ITEMS = 3;
const TEXT_MAX = 200;
const ANSWER_MAX = 400;

const cut = (v: unknown, max = TEXT_MAX): string | null => {
  if (typeof v !== "string" || !v.trim()) return null;
  const t = v.trim().replace(/\s+/g, " ");
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
const ym = (v: unknown) => (typeof v === "string" && v ? v.slice(0, 7) : null);
const arr = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []);

/** 뷰 한 행(+ 기본 자기소개서) → LLM 입력용 요약 */
export function prunePublicResume(row: Record<string, unknown> | null, letter: Record<string, unknown> | null): PublicResumeInput | undefined {
  if (!row && !letter) return undefined;
  const r = row ?? {};
  return {
    headline: cut(r.headline, 120),
    region: cut(r.region_sido, 20),
    desired_categories: (Array.isArray(r.desired_categories) ? (r.desired_categories as string[]) : []).slice(0, 5),
    experiences: arr(r.experiences).slice(0, MAX_EXPERIENCES).map((e) => ({
      company: cut(e.company, 80) ?? "",
      position: cut(e.position, 60),
      period: `${ym(e.start) ?? "?"}~${e.current ? "현재" : (ym(e.end) ?? "?")}`,
      duties: cut(e.duties),
      achievements: cut(e.achievements),
    })),
    educations: arr(r.educations).slice(0, MAX_EDUCATIONS).map((d) => ({
      school: cut(d.school, 80) ?? "", major: cut(d.major, 60), degree: cut(d.degree, 20), status: cut(d.status, 20),
    })),
    certifications: arr(r.certifications).slice(0, MAX_CERTS).map((c) => [c.name, c.score].filter(Boolean).join(" ").slice(0, 80)),
    misc: arr(r.misc).slice(0, MAX_MISC).map((m) => ({ kind: cut(m.kind, 20) ?? "", title: cut(m.title, 100) ?? "", description: cut(m.description) })),
    cover_letter: letter
      ? arr(letter.items).filter((i) => typeof i.answer === "string" && (i.answer as string).trim()).slice(0, MAX_LETTER_ITEMS)
          .map((i) => ({ question: cut(i.question, 120) ?? "", answer: cut(i.answer, ANSWER_MAX) ?? "" }))
      : [],
  };
}

export async function fetchPublicResume(client: EvidenceQueryClient, userId: string): Promise<PublicResumeInput | undefined> {
  const [resume, letter] = await Promise.all([
    client.from("public_resumes").select("*").eq("user_id", userId).maybeSingle(),
    client.from("public_cover_letters").select("items").eq("user_id", userId).maybeSingle(),
  ]);
  for (const r of [resume, letter]) {
    if (r.error && !isMissingRelationError(r.error)) throw new Error(`공개 이력서 조회 실패: ${r.error.message}`);
  }
  return prunePublicResume(resume.error ? null : resume.data, letter.error ? null : letter.data);
}

/**
 * 공고 표준 양식 (2026-11-03). 크롤 공고(crawlReview.buildDescription)·스카우트 건 등록(/sourcing)·JD 매칭 모달이
 * 모두 이 양식으로 공고 본문을 만든다 → 같은 정규화(getJobRequirements)·같은 필터(postingFacets)를 탄다.
 *
 *   (한 줄 요약)
 *   [주요업무] / [자격요건] / [우대사항]   ← 불릿 목록
 *   [근무조건] - 경력 / 학력 / 근무형태 / 급여 / 근무지 / 근무시간   ← 사람인 상세 표기 문자열
 *
 * talentfolio/src/lib/postingFormat.ts 는 이 파일의 사본이다 (레포가 달라 import 불가). 바꾸면 같이 바꿀 것.
 */

export interface PostingSections {
  summary: string | null;
  key_duties: string[];
  must_have: string[];
  nice_to_have: string[];
}

/** 사람인 상세 조건 칸 (fit.crawled_postings 컬럼명과 같다) */
export interface PostingConditions {
  career_text: string | null;
  education_text: string | null;
  employment_type_text: string | null;
  salary_text: string | null;
  location_text: string | null;
  work_hours_text: string | null;
}

export const SECTION_LABELS = [
  ["key_duties", "주요업무"],
  ["must_have", "자격요건"],
  ["nice_to_have", "우대사항"],
] as const;

export const CONDITION_LABELS = [
  ["career_text", "경력"],
  ["education_text", "학력"],
  ["employment_type_text", "근무형태"],
  ["salary_text", "급여"],
  ["location_text", "근무지"],
  ["work_hours_text", "근무시간"],
] as const;

export const EMPTY_CONDITIONS: PostingConditions = {
  career_text: null,
  education_text: null,
  employment_type_text: null,
  salary_text: null,
  location_text: null,
  work_hours_text: null,
};

const clean = (v: string) => v.replace(/^[\s•*ㆍ·\-–]+/, "").replace(/\s+/g, " ").trim();

/** 여러 줄 입력 → 불릿 항목 */
export function toItems(text: string | null | undefined): string[] {
  return (text ?? "").split("\n").map(clean).filter(Boolean);
}

const HEADER = /^\[?\s*(주요\s*업무|담당\s*업무|자격\s*요건|필수\s*(?:요건|기술|조건)|우대\s*(?:사항|조건)?|근무\s*조건)\s*\]?\s*:?\s*(.*)$/;
function sectionOf(head: string): keyof PostingSections | "conditions" {
  const h = head.replace(/\s/g, "");
  if (h === "주요업무" || h === "담당업무") return "key_duties";
  if (h.startsWith("자격") || h.startsWith("필수")) return "must_have";
  if (h.startsWith("우대")) return "nice_to_have";
  return "conditions";
}

/** 붙여넣은 자유 본문 → 섹션. 제목 없는 앞부분은 요약, 제목 없는 본문 전체면 주요업무로 둔다. [근무조건] 블록은 버린다(조건 칸이 따로 있음) */
export function splitPostingText(text: string): PostingSections {
  const out: PostingSections = { summary: null, key_duties: [], must_have: [], nice_to_have: [] };
  const intro: string[] = [];
  let cur: keyof PostingSections | "conditions" | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const m = HEADER.exec(line);
    if (m) {
      cur = sectionOf(m[1]);
      if (m[2] && cur !== "conditions" && cur !== "summary") out[cur].push(clean(m[2]));
      continue;
    }
    if (cur === null) intro.push(clean(line));
    else if (cur !== "conditions" && cur !== "summary") out[cur].push(clean(line));
  }
  const anySection = out.key_duties.length + out.must_have.length + out.nice_to_have.length > 0;
  if (!anySection) out.key_duties = intro;
  else if (intro.length) out.summary = intro.join(" ");
  return out;
}

/** 표준 본문 텍스트. 정규화 입력이자 jd 해시의 원문 */
export function composePostingText(s: PostingSections, c: Partial<PostingConditions> = {}): string {
  const parts: string[] = [];
  if (s.summary?.trim()) parts.push(s.summary.trim());
  for (const [key, label] of SECTION_LABELS) {
    const items = s[key].map(clean).filter(Boolean);
    if (items.length) parts.push(`[${label}]\n${items.map((i) => `- ${i}`).join("\n")}`);
  }
  const cond = CONDITION_LABELS.map(([key, label]) => [label, c[key]?.trim()] as const).filter(([, v]) => v);
  if (cond.length) parts.push(`[근무조건]\n${cond.map(([k, v]) => `- ${k}: ${v}`).join("\n")}`);
  return parts.join("\n\n");
}

/** 본문 첫 의미 있는 줄 = 건 제목 대용 (섹션 제목·불릿 기호는 건너뛴다). 제목 칸이 있으면 그걸 먼저 쓸 것 */
export function postingHeadline(text: string, max = 48): string {
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || /^\[[^\]]+\]$/.test(line)) continue;
    const t = clean(line.replace(/^\[[^\]]+\]\s*/, ""));
    if (t) return t.length > max ? `${t.slice(0, max)}…` : t;
  }
  return "제목 없는 공고";
}

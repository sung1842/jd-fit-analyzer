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

const clean = (v: string) => v.replace(/^[\s•*ㆍ·\-–▪◦○●■□✔✓►▶※]+/, "").replace(/\s+/g, " ").trim();

/** 여러 줄 입력 → 불릿 항목 */
export function toItems(text: string | null | undefined): string[] {
  return (text ?? "").split("\n").map(clean).filter(Boolean);
}

type Section = keyof Omit<PostingSections, "summary"> | "other";
// 섹션 제목 (공백 무시). "other" = 매칭에 안 쓰는 블록 (조건·복지·절차 등 — 조건은 칸이 따로 있다)
const SECTION_NAMES: [RegExp, Section][] = [
  [/^(?:주요\s*업무|담당\s*업무|업무\s*내용|직무\s*(?:내용|소개)|하는\s*일|이런\s*일을\s*(?:해요|합니다|하게\s*돼요|하게\s*됩니다))/u, "key_duties"],
  [/^(?:자격\s*(?:요건|조건|사항)|지원\s*자격|필수\s*(?:요건|기술|조건|역량|사항)|필요\s*(?:역량|기술|경험)|요구\s*사항|이런\s*분을\s*(?:찾아요|찾습니다|원해요))/u, "must_have"],
  [/^(?:우대\s*(?:사항|조건|요건)?|가산점|이런\s*분이면\s*더\s*좋아요|이런\s*경험이\s*있으면\s*좋아요)/u, "nice_to_have"],
  [/^(?:근무\s*(?:조건|환경|지|시간)|복지|복리\s*후생|혜택|채용\s*(?:절차|과정)|전형\s*절차|제출\s*서류|접수\s*(?:방법|기간)|유의\s*사항|기타\s*사항|회사\s*소개|기업\s*소개)/u, "other"],
];

/**
 * 섹션 제목 줄인지. 앞 장식(📋 ■ [ 【 1. 등)은 떼고 본다. 불릿(• -)으로 시작한 줄은 항목이라 제목이 아니다.
 * 제목 뒤에 글이 더 있으면 구분자(] 】 : )가 있을 때만 제목 + 첫 항목 ("자격요건: Java 3년")
 */
function headerOf(line: string): { sec: Section; rest: string } | null {
  if (/^[•*ㆍ·\-–▪◦○●]/.test(line)) return null;
  const core = line.replace(/^[^\p{L}]+/u, "");
  for (const [re, sec] of SECTION_NAMES) {
    const m = re.exec(core);
    if (!m) continue;
    const tail = core.slice(m[0].length);
    if (!tail.trim()) return { sec, rest: "" };
    const sep = /^\s*[\]】)>」』]?\s*[:：]?\s*/.exec(tail)![0];
    if (/[\]】)>」』:：]/.test(sep)) return { sec, rest: tail.slice(sep.length) };
    return null;
  }
  return null;
}

/**
 * 붙여넣은 자유 본문 → 섹션 (매칭 정규화용. 구직자 화면엔 원문을 따로 보여 준다).
 * 첫 제목 앞부분은 요약, 제목이 하나도 없으면 본문 전체를 주요업무로 둔다 (누락 없음).
 * 조건·복지·절차 블록("other")만 매칭 입력에서 뺀다.
 */
export function splitPostingText(text: string): PostingSections {
  const out: PostingSections = { summary: null, key_duties: [], must_have: [], nice_to_have: [] };
  const intro: string[] = [];
  let cur: Section | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const h = headerOf(line);
    if (h) {
      cur = h.sec;
      if (h.rest && cur !== "other") out[cur].push(clean(h.rest));
      continue;
    }
    const item = clean(line);
    if (!item) continue;
    if (cur === null) intro.push(item);
    else if (cur !== "other") out[cur].push(item);
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

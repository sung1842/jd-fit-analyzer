/**
 * 공고 필터 값 (SQL 016 job_postings 필터 컬럼). 크롤 원문 문자열 → 정규화 값. 코드 규칙만 (LLM 없음).
 * 분류 기준은 수집처 검색 필터의 직군 대분류(fit.job_categories 21개)와 경력·학력·고용형태·지역 표기.
 */

export interface PostingFacetInput {
  title: string;
  skills: string[];
  career_text: string | null;
  education_text: string | null;
  employment_type_text: string | null;
  location_text: string | null;
  deadline_date: string | null;
  deadline_text: string | null;
  salary_text: string | null;
  category_codes?: string[]; // 수집 단계에서 이미 붙은 직군 (있으면 우선)
}

export interface PostingFacets {
  category_codes: string[];
  career_min: number | null;
  career_max: number | null;
  newcomer_ok: boolean | null;
  education_level: "any" | "high" | "associate" | "bachelor" | "master" | "doctor" | null;
  employment_types: string[];
  region_sido: string | null;
  region_sigungu: string[];
  deadline_type: "date" | "rolling" | "until_filled" | "unknown";
  salary_disclosed: boolean | null;
}

/** 경력: "신입·경력 3년 ↑", "경력 3~15년", "경력무관(신입포함)", "신입" */
export function parseCareer(text: string | null): Pick<PostingFacets, "career_min" | "career_max" | "newcomer_ok"> {
  if (!text) return { career_min: null, career_max: null, newcomer_ok: null };
  const t = text.replace(/\s+/g, "");
  if (/경력무관/.test(t)) return { career_min: 0, career_max: null, newcomer_ok: true };
  const newcomer = /신입/.test(t);
  const range = t.match(/(\d+)~(\d+)년/);
  if (range) return { career_min: Number(range[1]), career_max: Number(range[2]), newcomer_ok: newcomer };
  const over = t.match(/(\d+)년/);
  if (over) return { career_min: Number(over[1]), career_max: null, newcomer_ok: newcomer };
  if (newcomer) return { career_min: 0, career_max: 0, newcomer_ok: true };
  return { career_min: null, career_max: null, newcomer_ok: null };
}

/** 학력: "대졸(4년제) 이상", "초대졸(2,3년제) 이상", "학력무관", "고졸 이상", "석사", "박사" */
export function parseEducation(text: string | null): PostingFacets["education_level"] {
  if (!text) return null;
  if (/학력무관/.test(text)) return "any";
  if (/박사/.test(text)) return "doctor";
  if (/석사/.test(text)) return "master";
  if (/초대졸|2,3년제|2·3년제|전문대/.test(text)) return "associate";
  if (/대졸|4년제|대학교/.test(text)) return "bachelor";
  if (/고졸|고등학교/.test(text)) return "high";
  return null;
}

const EMPLOYMENT_TYPES: [RegExp, string][] = [
  [/정규직/, "정규직"],
  [/계약직/, "계약직"],
  [/인턴/, "인턴"],
  [/파견/, "파견직"],
  [/아르바이트|알바/, "아르바이트"],
  [/프리랜서/, "프리랜서"],
  [/위촉/, "위촉직"],
];

/** 고용형태: "정규직 수습기간 3개월", "정규직, 계약직" */
export function parseEmploymentTypes(text: string | null): string[] {
  if (!text) return [];
  return EMPLOYMENT_TYPES.filter(([re]) => re.test(text)).map(([, v]) => v);
}

const SIDO = ["서울", "경기", "인천", "부산", "대구", "광주", "대전", "울산", "세종", "강원", "충북", "충남", "전북", "전남", "경북", "경남", "제주"];

/** 지역: "서울 송파구", "경기 성남시 분당구, 서울 강남구" → 첫 시·도 + 시·군·구 목록 */
export function parseRegion(text: string | null): Pick<PostingFacets, "region_sido" | "region_sigungu"> {
  if (!text) return { region_sido: null, region_sigungu: [] };
  const parts = text.split(/[,/]/).map((s) => s.trim()).filter(Boolean);
  let sido: string | null = null;
  const sigungu: string[] = [];
  for (const p of parts) {
    const [first, second] = p.split(/\s+/);
    const s = SIDO.find((x) => first?.startsWith(x));
    if (s && !sido) sido = s;
    if (s && second && !sigungu.includes(`${s} ${second}`)) sigungu.push(`${s} ${second}`);
  }
  return { region_sido: sido, region_sigungu: sigungu.slice(0, 10) };
}

export function parseDeadlineType(date: string | null, text: string | null): PostingFacets["deadline_type"] {
  if (date) return "date";
  if (!text) return "unknown";
  if (/상시/.test(text)) return "rolling";
  if (/채용\s*시/.test(text)) return "until_filled";
  return "unknown";
}

/** 급여: "면접 후 결정", "회사내규에 따름" → 비공개 */
export function parseSalaryDisclosed(text: string | null): boolean | null {
  if (!text) return null;
  if (/면접\s*후|회사\s*내규|협의/.test(text)) return false;
  return /\d/.test(text);
}

/**
 * 직군 대분류 (fit.job_categories.code). 수집 단계에서 직군을 못 받은 공고는 제목·기술 키워드로 추정한다.
 * 규칙에 안 걸리면 빈 배열 (필터에서 "미분류").
 */
// 영문 약어는 대문자 단어로만 (i 플래그면 "Spring" 의 pr, "build" 의 ui 처럼 단어 안에서 걸린다)
const CATEGORY_RULES: [RegExp, string][] = [
  [/개발|엔지니어|프로그래머|백엔드|프론트|풀스택|데이터|서버|앱|소프트웨어|보안|devops/i, "it_dev_data"],
  [/\b(?:AI|ML|SW|QA)\b/, "it_dev_data"],
  [/디자인|디자이너|그래픽|영상편집|\b(?:UI|UX|BX)\b/, "design"],
  [/기획|전략|\b(?:PM|PO)\b/, "planning_strategy"],
  [/마케팅|홍보|광고|그로스|\bPR\b/, "marketing_pr_research"],
  [/영업|세일즈|무역/, "sales_trade"],
  [/연구|R&D/, "research_rnd"],
  [/인사|노무|\bHR\b/, "hr_labor_hrd"], // "채용" 은 거의 모든 제목에 있어 쓰지 않는다
  [/회계|세무|재무|경리/, "accounting_tax_finance"],
  [/생산|제조|품질/, "production"],
];
const SKILL_HINT = /^(java|python|javascript|typescript|react|vue|spring|node|kotlin|swift|go|c\+\+|c#|sql|aws|docker|kubernetes)/i;

export function inferCategories(title: string, skills: string[]): string[] {
  const out = CATEGORY_RULES.filter(([re]) => re.test(title)).map(([, code]) => code);
  if (!out.includes("it_dev_data") && skills.some((s) => SKILL_HINT.test(s))) out.unshift("it_dev_data");
  return [...new Set(out)].slice(0, 3);
}

export function computeFacets(p: PostingFacetInput): PostingFacets {
  return {
    category_codes: p.category_codes?.length ? p.category_codes : inferCategories(p.title, p.skills),
    ...parseCareer(p.career_text),
    education_level: parseEducation(p.education_text),
    employment_types: parseEmploymentTypes(p.employment_type_text),
    ...parseRegion(p.location_text),
    deadline_type: parseDeadlineType(p.deadline_date, p.deadline_text),
    salary_disclosed: parseSalaryDisclosed(p.salary_text),
  };
}

import { generateStructured } from "../lib/gemini.js";
import { CANDIDATE_ROLES } from "./normalizeCandidate.js";

/**
 * 공고 구조 정규화 (22 문서 E3). parse_jd 를 대체한다: 직군 2종 + 키워드 대신 직무(후보와 같은 enum)·필수/우대 기술·경력 범위·지역.
 * orchestrator 가 jd 해시로 fit.job_requirements_norm 에 저장해, 같은 JD 는 다시 호출하지 않는다.
 */
export interface NormalizedJob {
  role: (typeof CANDIDATE_ROLES)[number];
  legacy_role: "developer" | "designer";
  role_confidence: number;
  must_skills: string[];
  /** 택일 필수: 그룹마다 하나만 있으면 충족 ("MySQL 또는 PostgreSQL" → [["MySQL","PostgreSQL"]]) */
  must_any_of: string[][];
  /** 경험·역량 문장 (기술 매칭에 쓰지 않음, 정밀 분석·표시용) */
  must_experiences: string[];
  nice_skills: string[];
  years_min: number | null;
  years_max: number | null;
  locations: string[];
  remote_ok: boolean | null;
}

const schema = {
  type: "object",
  properties: {
    role: { type: "string", enum: [...CANDIDATE_ROLES], description: "모집 직무 하나" },
    legacy_role: { type: "string", enum: ["developer", "designer"], description: "개발/엔지니어링이면 developer, 디자인이면 designer" },
    role_confidence: { type: "integer", description: "직무 판단 신뢰도 0~100" },
    must_skills: {
      type: "array",
      items: { type: "string" },
      description:
        "자격요건의 구체적 기술·도구·언어·프레임워크 이름만 (예: Java, Spring Boot, Figma). 최대 8개. '또는/or/중 하나'로 묶인 택일 항목은 넣지 말고 must_any_of 로. '~경험', '~능력' 같은 문장은 넣지 말고 must_experiences 로",
    },
    must_any_of: {
      type: "array",
      items: { type: "array", items: { type: "string" } },
      description: "택일 필수 그룹 (최대 4그룹). 'MySQL 또는 PostgreSQL' → [[\"MySQL\",\"PostgreSQL\"]]. 그룹 안은 기술·도구 이름만",
    },
    must_experiences: {
      type: "array",
      items: { type: "string" },
      description: "자격요건 중 기술 이름이 아닌 경험·역량·학력 문장 (예: 'REST API 설계 경험', '디자인 시스템 구축 경험'). 최대 6개",
    },
    nice_skills: {
      type: "array",
      items: { type: "string" },
      description: "우대사항·플러스로 적힌 기술·도구 (최대 10개). 필수와 겹치지 않게",
    },
    years_min: { type: ["number", "null"], description: "요구 최소 경력 연수. 신입 가능이면 0, 언급 없으면 null" },
    years_max: { type: ["number", "null"], description: "요구 최대 경력 연수. 없으면 null" },
    locations: { type: "array", items: { type: "string" }, description: "근무지 시·도 (예: 서울, 경기)" },
    remote_ok: { type: ["boolean", "null"], description: "원격·재택 가능이 명시되면 true, 불가 명시면 false, 없으면 null" },
  },
  required: ["role", "legacy_role", "role_confidence", "must_skills", "must_any_of", "must_experiences", "nice_skills", "years_min", "years_max", "locations", "remote_ok"],
};

const strings = (xs: unknown, max: number) =>
  [...new Set((Array.isArray(xs) ? xs : []).filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.trim()))].slice(0, max);
const years = (y: unknown) => (typeof y === "number" && y >= 0 && y < 60 ? y : null);

export async function normalizeJob(jd: string): Promise<NormalizedJob> {
  const prompt = [
    "다음 채용공고를 정해진 칸으로 정리하라. 공고에 적힌 사실만 쓰고, 없는 정보는 null 또는 빈 배열로 둔다.",
    "필수(자격요건)와 우대(우대사항)를 구분한다. 구분이 없으면 핵심 기술만 필수로 둔다.",
    "필수는 세 칸으로 나눈다: must_skills = 반드시 모두 필요한 기술·도구 이름, must_any_of = '또는/or/중 하나 이상'으로 적힌 택일 그룹, must_experiences = '~경험/~능력/~역량' 같은 문장.",
    "'디자인 시스템 구축 경험'처럼 기술명이 들어간 경험 문장도 must_experiences 에 원문대로 둔다.",
    `[JD]\n${jd}`,
  ].join("\n\n");

  const raw = await generateStructured<NormalizedJob>(prompt, schema, "normalize-job");
  const groups: string[][] = [];
  const promoted: string[] = []; // 1개짜리 그룹 → 필수 (상한 자른 뒤 붙여 잘리지 않게)
  for (const g of Array.isArray(raw.must_any_of) ? raw.must_any_of : []) {
    const opts = strings(g, 6);
    if (opts.length === 1) promoted.push(opts[0]);
    else if (opts.length > 1 && groups.length < 4) groups.push(opts);
  }
  const inGroup = new Set(groups.flat().map((x) => x.toLowerCase()));
  const must = strings([...strings(raw.must_skills, 8), ...promoted], 12).filter((m) => !inGroup.has(m.toLowerCase()));
  const mustLower = new Set([...must, ...inGroup].map((m) => m.toLowerCase()));
  let yMin = years(raw.years_min);
  let yMax = years(raw.years_max);
  if (yMin != null && yMax != null && yMax < yMin) [yMin, yMax] = [yMax, yMin];
  return {
    role: (CANDIDATE_ROLES as readonly string[]).includes(raw.role) ? raw.role : "fullstack",
    legacy_role: raw.legacy_role === "designer" ? "designer" : "developer",
    role_confidence: Math.max(0, Math.min(100, Math.round(Number(raw.role_confidence) || 0))),
    must_skills: must,
    must_any_of: groups,
    must_experiences: strings(raw.must_experiences, 6),
    nice_skills: strings(raw.nice_skills, 10).filter((n) => !mustLower.has(n.toLowerCase())),
    years_min: yMin,
    years_max: yMax,
    locations: strings(raw.locations, 5),
    remote_ok: typeof raw.remote_ok === "boolean" ? raw.remote_ok : null,
  };
}

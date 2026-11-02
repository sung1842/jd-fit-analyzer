import type { CandidatePortfolio } from "../../../shared/types.js";
import { generateStructured } from "../lib/gemini.js";

/**
 * 후보 구조 정규화 (22 문서 E2). 후보 등록·수정 시 1회만 호출하고, 결과는 orchestrator 가 fit.candidate_profiles_norm 에 저장해
 * 모든 공고 매칭이 재사용한다. 비교·순위는 코드가 하므로 여기서는 "정해진 칸 채우기"만 한다.
 * 입력은 get_candidate_portfolio 의 prune 결과(헌법 3조). 기술명은 orchestrator 가 표준 사전으로 다시 매핑한다.
 */
export const CANDIDATE_ROLES = [
  "frontend",
  "backend",
  "fullstack",
  "mobile",
  "data",
  "ai_ml",
  "devops",
  "qa",
  "game",
  "embedded",
  "ui_design",
  "ux_design",
  "product_design",
  "graphic_design",
] as const;

export interface NormalizedCandidate {
  roles: (typeof CANDIDATE_ROLES)[number][];
  skills: { name: string; years: number | null; professional: boolean }[];
  total_years: number | null;
  tags: string[];
  prefs: { locations: string[]; remote: boolean | null };
}

const schema = {
  type: "object",
  properties: {
    roles: {
      type: "array",
      items: { type: "string", enum: [...CANDIDATE_ROLES] },
      description: "이 사람이 수행할 수 있는 직무. 주 직무를 먼저, 최대 3개. 풀스택이면 fullstack 과 함께 backend/frontend 도 넣는다.",
    },
    skills: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "통용 표기의 기술·도구 이름 (예: React, Spring Boot, Figma)" },
          years: { type: ["number", "null"], description: "사용 연수. 근거가 없으면 null" },
          professional: { type: "boolean", description: "회사 실무에서 썼으면 true, 개인·학습 프로젝트만이면 false" },
        },
        required: ["name", "years", "professional"],
      },
      description: "기재된 기술만. 최대 25개. 추상 역량(협업 등)은 제외",
    },
    total_years: { type: ["number", "null"], description: "총 실무 경력 연수. 경력 기간으로 계산, 근거 없으면 null" },
    tags: {
      type: "array",
      items: { type: "string" },
      description: "강점 경험을 짧은 명사구로 최대 6개 (예: 대용량 트래픽, 결제 시스템, 장애 대응)",
    },
    prefs: {
      type: "object",
      properties: {
        locations: { type: "array", items: { type: "string" }, description: "희망·거주 지역 (시·도 단위)" },
        remote: { type: ["boolean", "null"], description: "원격 근무 선호가 명시되면 true/false, 없으면 null" },
      },
      required: ["locations", "remote"],
    },
  },
  required: ["roles", "skills", "total_years", "tags", "prefs"],
};

const MAX_SKILLS = 25;
const MAX_TAGS = 6;

export async function normalizeCandidate(portfolio: CandidatePortfolio): Promise<NormalizedCandidate> {
  const { name: _name, github_url: _g, portfolio_url: _p, ...rest } = portfolio; // 이름·링크는 정규화에 쓰지 않는다
  const prompt = [
    "아래 후보자 프로필을 정해진 칸으로 정리하라. 프로필에 적힌 사실만 쓰고, 없는 정보는 지어내지 말고 null 또는 빈 배열로 둔다.",
    `[프로필 JSON]\n${JSON.stringify(rest)}`,
  ].join("\n\n");

  const raw = await generateStructured<NormalizedCandidate>(prompt, schema, "normalize-candidate");
  const roles = [...new Set((raw.roles ?? []).filter((r) => (CANDIDATE_ROLES as readonly string[]).includes(r)))].slice(0, 3);
  return {
    roles,
    skills: (raw.skills ?? [])
      .filter((s) => typeof s?.name === "string" && s.name.trim())
      .slice(0, MAX_SKILLS)
      .map((s) => ({ name: s.name.trim(), years: typeof s.years === "number" && s.years >= 0 ? s.years : null, professional: !!s.professional })),
    total_years: typeof raw.total_years === "number" && raw.total_years >= 0 ? raw.total_years : null,
    tags: (raw.tags ?? []).filter((t) => typeof t === "string" && t.trim()).slice(0, MAX_TAGS),
    prefs: {
      locations: (raw.prefs?.locations ?? []).filter((l) => typeof l === "string" && l.trim()),
      remote: typeof raw.prefs?.remote === "boolean" ? raw.prefs.remote : null,
    },
  };
}

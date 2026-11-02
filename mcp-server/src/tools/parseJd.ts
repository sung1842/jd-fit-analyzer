import { generateStructured } from "../lib/gemini.js";

export interface ParsedJd {
  role: "developer" | "designer";
  keywords: string[]; // JD가 요구하는 핵심 기술/도구 키워드 (정규화된 짧은 토큰)
  role_confidence: number; // 0~100, 직군 판단 신뢰도
}

const parseJdSchema = {
  type: "OBJECT",
  properties: {
    role: {
      type: "STRING",
      enum: ["developer", "designer"],
      description: "이 채용공고가 모집하는 직군. 개발/엔지니어링이면 developer, 디자인이면 designer.",
    },
    keywords: {
      type: "ARRAY",
      items: { type: "STRING" },
      description:
        "JD가 요구하는 핵심 기술/도구를 짧은 키워드로 정규화한 목록 (예: 'React', 'TypeScript', 'Figma'). 최대 12개. 일반 단어(예: '협업', '소통')는 제외하고 구체적인 기술/툴 이름만.",
    },
    role_confidence: {
      type: "INTEGER",
      description: "직군(role) 판단의 신뢰도 0~100",
    },
  },
  required: ["role", "keywords", "role_confidence"],
};

// JD 텍스트에서 모집 직군과 핵심 기술 키워드를 추출한다 (Gemini Flash 1회 호출).
// 후속 단계(코드 기반 사전 필터링)의 입력이 되며, 비싼 정밀 분석 전에 후보를 좁히는 용도.
export async function parseJd(jd: string): Promise<ParsedJd> {
  const prompt = `다음 채용공고(JD)를 분석해 모집 직군과 핵심 기술 키워드를 추출해라.\n\n[JD]\n${jd}\n\n규칙:\n- role: 개발자/엔지니어 모집이면 "developer", 디자이너 모집이면 "designer".\n- keywords: 포트폴리오 매칭에 쓸 구체적인 기술/툴 이름만 정규화해서 추출 (예: React, TypeScript, Next.js, Figma, Blender). 추상적 역량(협업, 책임감 등)은 제외.\n- 키워드는 영문 기술명은 영문 그대로, 통용되는 표기로 정규화.`;

  return generateStructured<ParsedJd>(prompt, parseJdSchema, "parse-jd");
}

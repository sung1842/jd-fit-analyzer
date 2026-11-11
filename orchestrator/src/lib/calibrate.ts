/**
 * 핏 리포트 점수 보정 (코드, LLM 호출 없음 — 헌법 3조).
 *
 * 배경 (2026-11-10, 한도윤 건): 기술 태그 6개 + 소개 두 문장뿐인 후보가 72점을 받았다.
 *  - LLM 이 포트폴리오에 없는 항목(RESTful API·Linux·Git)을 "충족"으로 넣었고, 이를 거르는 검증이 없었다.
 *  - 근거의 양과 무관하게 0~100 전 범위로 점수를 매겼다.
 *  - 점수와 충족/부족 수가 모순이어도 CEO(LLM)가 통과시킬 수 있었다.
 *
 * 보정 순서
 *  1) 충족 항목 검증: 포트폴리오·이력서·인용 카드 본문에 실제로 받쳐지지 않는 "충족" 항목은 부족(면접 확인)으로 옮긴다.
 *  2) 영역 점수 상한: 검증 후 충족 비율로 상한을 걸고, 부족이 충족보다 많으면 60 을 넘지 않게 한다.
 *  3) 근거 등급 상한: 공개 카드·이력서·구체 서술이 얼마나 있는지로 전체 점수 상한을 정한다.
 *  4) 종합 점수 = min(CEO 점수, 보정된 영역 점수의 가중 평균, 근거 등급 상한). 판정은 종합 점수로 다시 정한다.
 * 점수를 올리는 보정은 없다 (낮추기만).
 */
import type { AgentResult, CandidatePortfolio, FitCalibration, FitReport } from "../../../shared/types.js";

export const WEIGHTS = { tech: 0.5, exp: 0.3, culture: 0.2 } as const;

/** 근거 등급별 종합 점수 상한 */
export const TIER_CAP = { thin: 50, basic: 70, solid: 85, rich: 100 } as const;
export type EvidenceTier = keyof typeof TIER_CAP;

export function verdictOf(score: number): FitReport["verdict"] {
  return score >= 75 ? "strong_fit" : score >= 45 ? "possible_fit" : "weak_fit";
}

/** 이력서에서 사실을 담은 칸 수 (경력·학력·자격·기타·자기소개서) */
function resumeFacts(p: CandidatePortfolio): number {
  const r = p.resume;
  if (!r) return 0;
  return r.experiences.length + r.certifications.length + r.misc.length + r.cover_letter.filter((c) => c.answer.trim().length >= 80).length;
}

/**
 * 근거 등급.
 *  thin  : 공개 카드 0, 이력서 사실 0, 긴 소개 200자 미만 — 기술 태그와 짧은 소개뿐 (자기 신고)
 *  basic : 카드 1~2장, 또는 이력서 사실 1개 이상, 또는 긴 소개 200자 이상
 *  solid : 카드 3장 이상, 또는 (카드 1장 이상 + 이력서 경력)
 *  rich  : 카드 5장 이상이면서 구체적인 카드(80자 이상 + 수치 포함) 3장 이상
 * 카드의 신뢰 등급(확인·첨부)은 검증되지 않으므로 쓰지 않는다 (2026-11-11). 모든 카드는 자기 신고, 진위는 면접에서.
 */
const isConcrete = (claim: string) => claim.trim().length >= 80 && /\d/.test(claim);

export function evidenceTier(p: CandidatePortfolio): EvidenceTier {
  const cards = p.evidence_cards ?? [];
  const concrete = cards.filter((c) => isConcrete(c.claim)).length;
  const bio = (p.long_bio ?? "").trim().length;
  const facts = resumeFacts(p);
  const hasCareer = (p.resume?.experiences.length ?? 0) > 0;
  if (cards.length >= 5 && concrete >= 3) return "rich";
  if (cards.length >= 3 || (cards.length >= 1 && hasCareer)) return "solid";
  if (cards.length >= 1 || facts >= 1 || bio >= 200) return "basic";
  return "thin";
}

/** 근거 대조용 본문 (소문자). 포트폴리오 + 이력서 + 공개 카드 claim */
export function evidenceHaystack(p: CandidatePortfolio): string {
  const r = p.resume;
  const parts: (string | null | undefined)[] = [p.title, p.short_bio, p.long_bio, ...p.skills, ...(p.evidence_cards ?? []).map((c) => c.claim)];
  if (r) {
    parts.push(r.headline);
    for (const e of r.experiences) parts.push(e.company, e.position, e.duties, e.achievements);
    for (const e of r.educations) parts.push(e.school, e.major);
    parts.push(...r.certifications);
    for (const m of r.misc) parts.push(m.title, m.description);
    for (const c of r.cover_letter) parts.push(c.answer);
  }
  return parts.filter((v): v is string => !!v).join("\n").toLowerCase();
}

// 요건 문장에 흔히 붙는 말 — 이것만 겹친다고 근거로 보지 않는다
const STOP = new Set([
  "경험", "경험이", "활용", "활용한", "사용", "사용한", "사용해", "개발", "개발한", "개발을", "설계", "구축", "운영", "기반", "기반의", "환경", "환경에서의", "환경에서",
  "이해", "능력", "역량", "업무", "관련", "및", "등", "또는", "이상", "보유", "보유자", "가능", "가능자", "우대", "협업", "통한", "위한", "대한", "있는", "있으신", "분",
  "프로젝트", "서비스", "시스템", "웹", "애플리케이션", "기술", "개선", "관리", "적용", "적용한", "수행", "참여", "능숙", "능숙한", "지식", "the", "and", "or", "with", "of",
]);

// 브랜드명·흔한 영문어 — 이것만 맞았다고 근거로 보지 않는다 (예: "Adobe" 만으로 Photoshop 근거 인정 금지)
const GENERIC_TECH = new Set(["adobe", "microsoft", "ms", "google", "api", "tool", "tools", "program", "ai"]);

/** 요건 문장 → 대조할 키워드. 영문 기술어(Linux, RESTful 등)가 있으면 그것만, 없으면 한글 명사형 키워드 */
export function itemKeywords(item: string): { tech: string[]; words: string[] } {
  const clean = item.toLowerCase().replace(/[()[\]{}·,/|:;"'`~!?]/g, " ");
  const tokens = clean.split(/\s+/).map((t) => t.replace(/^[.\-]+|[.\-]+$/g, "")).filter((t) => t.length >= 2 && !STOP.has(t));
  const tech = tokens.filter((t) => /[a-z]/.test(t) && /^[a-z0-9.+#\-]+$/.test(t) && !GENERIC_TECH.has(t));
  // 한글 키워드는 조사 끝 한 글자를 떼서 비교 (예: "데이터베이스를" → "데이터베이" 대신 원형 우선 비교, 실패 시 절단형)
  const words = tokens.filter((t) => !tech.includes(t) && /[가-힣]/.test(t));
  return { tech, words };
}

function hasWord(hay: string, w: string): boolean {
  if (hay.includes(w)) return true;
  return w.length >= 3 && hay.includes(w.slice(0, -1)); // 조사 한 글자 차이 허용
}

/**
 * 충족 항목이 근거로 받쳐지는지.
 *  - 영문 기술어가 있으면: 그중 하나라도 본문에 있어야 한다 (예: "RESTful API" → restful|api).
 *    단 "api" 처럼 짧고 흔한 말만 걸리는 경우를 막기 위해 3글자 이하 영문어는 다른 기술어가 없을 때만 인정.
 *  - 한글만이면: 키워드의 절반 이상이 본문에 있어야 한다 (흔한 말 한 개만 겹치는 것 방지).
 */
// 묶음 개념 → 구체 기술 (요건이 상위 개념으로 적혀 있을 때)
const FAMILIES: [RegExp, RegExp][] = [
  [/관계형|rdbms|데이터베이스|(^|[^a-z])db([^a-z]|$)|(^|[^a-z])sql([^a-z]|$)/, /mysql|postgres|oracle|mariadb|mssql|sql server|tibero|sqlite/],
  [/컨테이너/, /docker|kubernetes|k8s|podman/],
  [/ci\/cd|ci·cd|지속적 ?통합|배포 ?자동화/, /jenkins|github actions|gitlab ci|argo|circleci|travis/],
  [/형상 ?관리|버전 ?관리/, /(^|[^a-z])git([^a-z]|$)|github|gitlab|svn/],
  [/클라우드/, /aws|gcp|azure|ncp|naver cloud/],
];

export function isSupported(item: string, hay: string): boolean {
  const low = item.toLowerCase();
  for (const [concept, concrete] of FAMILIES) if (concept.test(low) && concrete.test(hay)) return true;
  const { tech, words } = itemKeywords(item);
  if (tech.length > 0) {
    const long = tech.filter((t) => t.length > 3);
    const pool = long.length > 0 ? long : tech;
    // 짧은 영문어(git, api 등)는 단어 경계로만 (digital 의 "git" 같은 우연 일치 방지)
    const hit = (t: string) => (t.length > 3 ? hay.includes(t) : new RegExp(`(^|[^a-z])${t.replace(/[.+#]/g, "\\$&")}([^a-z]|$)`).test(hay));
    return pool.some(hit);
  }
  if (words.length === 0) return false;
  const hit = words.filter((w) => hasWord(hay, w)).length;
  return hit >= Math.max(1, Math.ceil(words.length / 2));
}

/**
 * 나열형 요건을 도구 단위로 쪼갠다. "Adobe Photoshop, Illustrator, InDesign 활용 가능자" → [Adobe Photoshop, Illustrator, InDesign].
 * 괄호 안 나열(예: "관계형 DB(Oracle, MariaDB 등)")은 '그중 하나'라는 뜻이라 쪼개지 않는다. 영문 도구명이 2개 미만이면 그대로 둔다.
 */
export function splitCompound(item: string): string[] {
  const outer = item.replace(/\([^)]*\)/g, " ");
  const parts = outer.split(/\s*(?:,|\/|·|\s및\s|\s와\s|\s과\s)\s*/).map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return [item];
  const tools = parts.map((p) => p.match(/[A-Za-z][A-Za-z0-9.+#\- ]*[A-Za-z0-9+#]|[A-Za-z]/)?.[0].trim() ?? "");
  if (tools.some((t) => !t) || tools.filter((t) => itemKeywords(t).tech.length > 0).length < 2) return [item];
  return [...new Set(tools)];
}

/** 영역 하나 보정. 충족 검증 → 비율 상한 → 모순 상한 */
export function calibrateAgent(a: AgentResult, hay: string): { result: AgentResult; moved: string[]; from: number } {
  const kept: string[] = [];
  const moved: string[] = [];
  for (const m of a.matched_items) {
    const parts = splitCompound(m);
    if (parts.length === 1) {
      (isSupported(m, hay) ? kept : moved).push(m);
      continue;
    }
    // 나열형: 전부 받쳐지면 원문 그대로, 일부만이면 받쳐진 도구만 충족으로 남기고 나머지는 근거 없음으로
    const ok = parts.filter((t) => isSupported(t, hay));
    if (ok.length === parts.length) kept.push(m);
    else {
      kept.push(...ok);
      moved.push(...parts.filter((t) => !ok.includes(t)));
    }
  }
  const missing = [...a.missing_items, ...moved.filter((m) => !a.missing_items.includes(m))];
  const total = kept.length + missing.length;
  let score = a.score;
  if (total > 0) {
    // 충족 비율 기반 상한: 비율 100% → 100, 50% → 65, 0% → 30
    const ratioCap = Math.round(30 + 70 * (kept.length / total));
    score = Math.min(score, ratioCap);
  }
  if (missing.length > kept.length) score = Math.min(score, 60);
  const flags = moved.length > 0 || score < a.score ? [...new Set([...(a.flags ?? []), "calibrated"])] : a.flags;
  return { result: { ...a, score, matched_items: kept, missing_items: missing, ...(flags ? { flags } : {}) }, moved, from: a.score };
}

export function calibrateReport(report: FitReport, portfolio: CandidatePortfolio): FitReport {
  const hay = evidenceHaystack(portfolio);
  const tier = evidenceTier(portfolio);
  const tech = calibrateAgent(report.techStack, hay);
  const exp = calibrateAgent(report.experience, hay);
  const cul = report.cultureFit ? calibrateAgent(report.cultureFit, hay) : null;

  const weighted = cul
    ? tech.result.score * WEIGHTS.tech + exp.result.score * WEIGHTS.exp + cul.result.score * WEIGHTS.culture
    : (tech.result.score * WEIGHTS.tech + exp.result.score * WEIGHTS.exp) / (WEIGHTS.tech + WEIGHTS.exp);
  const cap = TIER_CAP[tier];
  const overall = Math.max(0, Math.min(report.overallScore, Math.round(weighted), cap));

  const reasons: string[] = [];
  const moved = [...new Set([...tech.moved, ...exp.moved, ...(cul?.moved ?? [])])];
  if (moved.length) reasons.push(`근거로 확인되지 않은 충족 항목 ${moved.length}개를 면접 확인으로 옮김`);
  if (overall === cap && cap < report.overallScore) reasons.push(`근거 부족 상한 ${cap}점 적용 (${TIER_LABEL[tier]})`);
  else if (overall < report.overallScore && !moved.length) reasons.push("점수와 충족·부족 항목 수의 모순을 바로잡음");

  const calibration: FitCalibration = {
    tier,
    cap,
    rawScore: report.overallScore,
    movedItems: moved,
    reasons,
  };
  return {
    ...report,
    overallScore: overall,
    verdict: verdictOf(overall),
    techStack: tech.result,
    experience: exp.result,
    ...(cul ? { cultureFit: cul.result } : {}),
    calibration,
  };
}

export const TIER_LABEL: Record<EvidenceTier, string> = {
  thin: "기술 태그·짧은 소개뿐",
  basic: "근거 일부",
  solid: "근거 충분",
  rich: "근거 풍부",
};

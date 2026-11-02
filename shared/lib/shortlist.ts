import type { CandidateBriefCard, FitReport } from "../types.js";

/** JD 분석 완료 후 자동 쇼트리스트 규칙 (고정 N명 ❌ — 임계값 + 상한) */
export const SHORTLIST_DEFAULTS = {
  minOverallScore: 75,
  requiredVerdict: "strong_fit" as const,
  maxCandidates: 5,
  /** LLM 정밀 분석 상한 (plan 단계 이후) */
  maxAnalyzeCandidates: 20,
} as const;

export function pickShortlist(
  reports: FitReport[],
  options: Partial<typeof SHORTLIST_DEFAULTS> = {}
): FitReport[] {
  const { minOverallScore, requiredVerdict, maxCandidates } = { ...SHORTLIST_DEFAULTS, ...options };

  return reports
    .filter((r) => r.verdict === requiredVerdict && r.overallScore >= minOverallScore)
    .sort((a, b) => b.overallScore - a.overallScore)
    .slice(0, maxCandidates);
}

/** JD 첫 줄 요약 (Slack Card 헤더·Brief OG용) */
export function extractJdHeadline(jd: string): string | undefined {
  const line = jd
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith("["));
  return line?.slice(0, 80);
}

/** FitReport → Slack/Brief용 가벼운 카드 (절대 규칙 3: prune) */
export function fitReportToBriefCard(report: FitReport): CandidateBriefCard {
  return {
    candidateId: report.candidateId,
    name: report.candidateName,
    overallScore: report.overallScore,
    verdict: report.verdict,
    techScore: report.techStack.score,
    experienceScore: report.experience.score,
    matchedSkills: report.techStack.matched_items.slice(0, 8),
    ceoSummary: report.ceoSummary,
  };
}

export function fitReportsToBriefCards(reports: FitReport[]): CandidateBriefCard[] {
  return reports.map(fitReportToBriefCard);
}

/** Slack HIL 승인 요청용 폴백 mrkdwn (리치 Card 미지원·레거시용) */
export function buildShortlistSlackText(jd: string, shortlist: FitReport[]): string {
  const jdHeadline = extractJdHeadline(jd);

  const lines = [
    `📋 *JD 핏 분석 쇼트리스트* — strong_fit ${shortlist.length}명`,
    jdHeadline ? `포지션: ${jdHeadline}` : undefined,
    "",
    ...shortlist.map((r, i) => {
      const matched = r.techStack.matched_items.slice(0, 4).join(", ");
      const summary = r.ceoSummary.length > 120 ? `${r.ceoSummary.slice(0, 117)}...` : r.ceoSummary;
      return [
        `${i + 1}. *${r.candidateName}* — ${r.overallScore}점 (기술 ${r.techStack.score} / 경험 ${r.experience.score})`,
        matched ? `   ✓ ${matched}` : undefined,
        `   _${summary}_`,
      ]
        .filter(Boolean)
        .join("\n");
    }),
    "",
    "위 쇼트리스트를 팀 채널에 공유할까요?",
  ].filter((l) => l !== undefined);

  return lines.join("\n");
}

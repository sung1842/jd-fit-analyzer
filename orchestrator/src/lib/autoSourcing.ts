import type { AutoSourcingResult, FitReport } from "../../../shared/types.js";
import {
  buildShortlistSlackText,
  extractJdHeadline,
  fitReportsToBriefCards,
  pickShortlist,
} from "../../../shared/lib/shortlist.js";
import { jdHash } from "./cache.js";
import { createSourcingWithApproval } from "./createSourcingWithApproval.js";
import { persistJdRunWithAssessments } from "./persistJdRun.js";
import { listSourcingActions } from "./sourcingActions.js";

const DEFAULT_CHANNEL = process.env.SLACK_DEFAULT_CHANNEL ?? "#recruiting";

/** JD 분석 완료 후 strong_fit 쇼트리스트 → sourcing_actions + Slack HIL 승인 요청 */
export async function autoSourcingFromJd(input: {
  jd: string;
  userId: string;
  channel?: string;
  reports: FitReport[];
  /** true면 pickShortlist 생략 — 클라이언트가 고른 FitReport만 사용 (JD 매칭 수동 쇼트리스트) */
  manualSelection?: boolean;
  /** channel_invite 등 소스 구분 */
  autoSource?: "jd_analysis" | "jd_manual" | "channel_invite";
}): Promise<AutoSourcingResult> {
  const { jd, userId, reports, manualSelection } = input;
  const autoSource =
    input.autoSource ?? (manualSelection ? "jd_manual" : "jd_analysis");
  const channel = input.channel?.trim() || DEFAULT_CHANNEL;
  const hash = jdHash(jd);

  const shortlist = manualSelection ? reports : pickShortlist(reports);
  if (shortlist.length === 0) {
    return { created: false, reason: manualSelection ? "no_selection" : "no_strong_fit" };
  }

  const pending = await listSourcingActions({ status: "pending" });

  if (autoSource === "channel_invite") {
    const duplicateChannel = pending.find(
      (a) => a.payload.channel === channel && a.payload.autoSource === "channel_invite"
    );
    if (duplicateChannel) {
      return {
        created: false,
        reason: "already_pending",
        action: duplicateChannel,
        shortlist: shortlist.map((r) => ({
          candidateId: r.candidateId,
          name: r.candidateName,
          overallScore: r.overallScore,
        })),
      };
    }
  } else {
    const duplicate = pending.find(
      (a) =>
        a.userId === userId &&
        a.payload.jdHash === hash &&
        (a.payload.autoSource === "jd_analysis" || a.payload.autoSource === "jd_manual")
    );
    if (duplicate) {
      return {
        created: false,
        reason: "already_pending",
        action: duplicate,
        shortlist: shortlist.map((r) => ({
          candidateId: r.candidateId,
          name: r.candidateName,
          overallScore: r.overallScore,
        })),
      };
    }
  }

  const text = buildShortlistSlackText(jd, shortlist);
  const cards = fitReportsToBriefCards(shortlist);
  const jdHeadline = extractJdHeadline(jd);

  const { jdRun } = await persistJdRunWithAssessments({
    userId,
    jdHash: hash,
    jdText: jd,
    reports: shortlist,
  });

  const { action, approvalWarning } = await createSourcingWithApproval({
    userId,
    payload: {
      channel,
      text,
      candidateIds: shortlist.map((r) => r.candidateId),
      candidateNames: shortlist.map((r) => r.candidateName),
      jdHash: hash,
      jdHeadline,
      cards,
      jdRunId: jdRun.id,
      autoSource,
    },
  });

  return {
    created: true,
    action,
    shortlist: shortlist.map((r) => ({
      candidateId: r.candidateId,
      name: r.candidateName,
      overallScore: r.overallScore,
    })),
    approvalWarning,
  };
}

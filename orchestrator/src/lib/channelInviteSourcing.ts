import type { AutoSourcingResult, FitReport } from "../../../shared/types.js";
import { extractJdHeadline } from "../../../shared/lib/shortlist.js";
import { autoSourcingFromJd } from "./autoSourcing.js";
import { createSourcingWithApproval } from "./createSourcingWithApproval.js";
import { buildJdPlan } from "./jdPlan.js";
import { runFitAnalysisWait } from "./runFitAnalysis.js";
import { resolveChannelConfig } from "./slackChannelConfigs.js";
import { listSourcingActions } from "./sourcingActions.js";
import { callMcpTool } from "../mcp/client.js";

export type ChannelInviteSourcingResult =
  | AutoSourcingResult
  | { created: false; reason: "no_config" | "disabled" | "no_candidates" | "already_pending" | "analyze_failed" };

/** 봇이 Slack 채널에 초대됐을 때 JD 기반 후보 분석 → HIL 승인 요청 */
export async function runChannelInviteSourcing(input: {
  channelId: string;
  inviterSlackUserId?: string;
}): Promise<ChannelInviteSourcingResult> {
  const { channelId, inviterSlackUserId } = input;

  const config = await resolveChannelConfig(channelId);
  if (!config) {
    console.info(`[channel-invite] 설정 없음 channel=${channelId} — SLACK_CHANNEL_AUTO_JD 또는 slack_channel_configs 필요`);
    return { created: false, reason: "no_config" };
  }

  const { userId, jdText, maxAnalyze } = config;

  const pending = await listSourcingActions({ status: "pending" });
  const duplicate = pending.find(
    (a) => a.payload.channel === channelId && a.payload.autoSource === "channel_invite"
  );
  if (duplicate) {
    console.info(`[channel-invite] 이미 대기 중 action=${duplicate.id} channel=${channelId}`);
    return { created: false, reason: "already_pending", action: duplicate };
  }

  try {
    await callMcpTool("notify_slack", {
      channel: channelId,
      text: "🤖 TalentFolio 봇이 채널에 참여했습니다. JD에 맞는 후보를 분석해 승인 요청을 보낼게요…",
    });
  } catch {
    /* welcome 메시지 실패는 무시 */
  }

  const plan = await buildJdPlan(jdText);
  // C 단계 rank ≥ D_MIN_RANK(analyzable) 우선, 부족하면 나머지 순위로 채운다
  const batch = [...plan.ranked.filter((c) => c.analyzable), ...plan.ranked.filter((c) => !c.analyzable)].slice(0, maxAnalyze);
  if (batch.length === 0) {
    return { created: false, reason: "no_candidates" };
  }

  console.info(
    `[channel-invite] 분석 시작 channel=${channelId} candidates=${batch.length} userId=${userId}`
  );

  const reports: FitReport[] = [];
  for (const c of batch) {
    const report = await runFitAnalysisWait(jdText, c.candidateId, userId, { tier: "free" });
    if (report) reports.push(report);
  }

  if (reports.length === 0) {
    const names = batch.map((c) => c.name);
    const text = [
      `📋 *채널 자동 소싱* — 키워드 매칭 ${batch.length}명 (정밀 분석 미완료)`,
      extractJdHeadline(jdText) ? `포지션: ${extractJdHeadline(jdText)}` : undefined,
      "",
      names.map((n, i) => `${i + 1}. ${n}`).join("\n"),
      "",
      "위 후보를 팀 채널에 공유할까요?",
    ]
      .filter(Boolean)
      .join("\n");

    const { action } = await createSourcingWithApproval({
      userId,
      payload: {
        channel: channelId,
        text,
        candidateIds: batch.map((c) => c.candidateId),
        candidateNames: names,
        jdHeadline: extractJdHeadline(jdText),
        autoSource: "channel_invite",
      },
    });

    return { created: true, action, shortlist: batch.map((c) => ({ candidateId: c.candidateId, name: c.name, overallScore: 0 })) };
  }

  return autoSourcingFromJd({
    jd: jdText,
    userId,
    channel: channelId,
    reports,
    manualSelection: true,
    autoSource: "channel_invite",
  });
}

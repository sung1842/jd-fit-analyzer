import type { SlackNotifyPayload, SourcingActionRecord } from "../../../shared/types.js";
import { callMcpTool } from "../mcp/client.js";
import { createSourcingAction, updateSourcingAction } from "./sourcingActions.js";

export interface CreateSourcingWithApprovalResult {
  action: SourcingActionRecord;
  approvalWarning?: string;
}

/** sourcing_actions 생성 + Slack 승인 요청 발송 (M2 공용) */
export async function createSourcingWithApproval(input: {
  payload: SlackNotifyPayload;
  userId: string;
}): Promise<CreateSourcingWithApprovalResult> {
  const { payload, userId } = input;
  const { channel, text, candidateNames, cards, jdHeadline, jdHash } = payload;

  const action = await createSourcingAction({
    type: "slack_notify",
    payload,
    userId,
  });

  try {
    const approvalRes = await callMcpTool<{ ok: boolean; ts?: string; channel?: string; error?: string; mode?: string }>(
      "notify_slack_approval",
      { actionId: action.id, channel, text, candidateNames, cards, jdHeadline, jdHash }
    );

    if (approvalRes.ok && approvalRes.ts) {
      const updated = await updateSourcingAction(action.id, {
        result: {
          approval: { ts: approvalRes.ts, channel: approvalRes.channel ?? channel },
          slackMode: approvalRes.mode ?? "interactive",
        },
      });
      const approvalWarning =
        approvalRes.mode === "web_link"
          ? "Slack 인터랙티브 승인 미설정 — 메시지에 웹 승인 링크가 포함됐습니다."
          : undefined;
      return { action: updated, approvalWarning };
    }

    const approvalWarning = approvalRes.error ?? "Slack 승인 요청 발송에 실패했습니다.";
    console.warn("[sourcing] 승인 요청 Slack 발송 실패 (웹 UI로 승인 가능):", approvalWarning);
    return { action, approvalWarning };
  } catch (err) {
    const approvalWarning = err instanceof Error ? err.message : String(err);
    console.warn("[sourcing] 승인 요청 Slack 발송 실패 (웹 UI로 승인 가능):", approvalWarning);
    return { action, approvalWarning };
  }
}

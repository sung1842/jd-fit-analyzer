import { runChannelInviteSourcing } from "./channelInviteSourcing.js";
import { getSlackBotUserId } from "./slackBot.js";

interface SlackUrlVerification {
  type: "url_verification";
  challenge: string;
}

interface SlackMemberJoinedChannelEvent {
  type: "event_callback";
  event: {
    type: "member_joined_channel";
    user: string;
    channel: string;
    inviter?: string;
  };
}

export type SlackEventsBody = SlackUrlVerification | SlackMemberJoinedChannelEvent | { type: string };

export function isUrlVerification(body: SlackEventsBody): body is SlackUrlVerification {
  return body.type === "url_verification" && typeof (body as SlackUrlVerification).challenge === "string";
}

/** Slack Events API payload 처리 (member_joined_channel — 봇 초대) */
export async function handleSlackEvents(body: SlackEventsBody): Promise<void> {
  if (body.type !== "event_callback") return;

  const event = (body as SlackMemberJoinedChannelEvent).event;
  if (event?.type !== "member_joined_channel") return;

  const botUserId = await getSlackBotUserId();
  if (!botUserId) {
    console.warn("[slack events] SLACK_BOT_USER_ID/auth.test 없음 — 봇 초대 이벤트 무시");
    return;
  }

  if (event.user !== botUserId) {
    return;
  }

  console.info(
    `[slack events] 봇 채널 참여 channel=${event.channel} inviter=${event.inviter ?? "unknown"}`
  );

  try {
    const result = await runChannelInviteSourcing({
      channelId: event.channel,
      inviterSlackUserId: event.inviter,
    });
    console.info("[slack events] channel-invite 결과:", result);
  } catch (err) {
    console.error("[slack events] channel-invite 실패:", err);
  }
}

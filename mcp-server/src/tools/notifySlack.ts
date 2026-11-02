import type { CandidateBriefCard } from "../../../shared/types.js";
import {
  buildApprovalBlocks,
  buildApprovalBlocksWebFallback,
  buildDecisionBlocks,
  buildShortlistApprovalBlocks,
  buildShortlistApprovalWebFallback,
  buildShortlistPublishedBlocks,
  isSlackInteractivityConfigured,
  postSlackBlocks,
  postSlackMessage,
  updateSlackMessage,
  type SlackPostMessageResult,
} from "../lib/slack.js";

// Phase 5 B2B 소싱: Slack 채널로 메시지를 전송한다 (LLM 호출 없음).
// cards가 있으면 Phase M2.6 Block Kit Card/Carousel로 전송한다.
export async function notifySlack(
  channel: string,
  text: string,
  cards?: CandidateBriefCard[],
  jdHeadline?: string,
  jdHash?: string
): Promise<SlackPostMessageResult> {
  if (cards && cards.length > 0) {
    const blocks = buildShortlistPublishedBlocks({ jdHeadline, cards, jdHash });
    const preview = jdHeadline
      ? `JD 쇼트리스트: ${jdHeadline} (${cards.length}명)`
      : `JD 쇼트리스트 (${cards.length}명)`;
    return postSlackBlocks(channel, preview, blocks);
  }
  return postSlackMessage(channel, text);
}

// Phase M2/M2.6: 승인 버튼 + (선택) 쇼트리스트 Carousel
export async function notifySlackApproval(
  actionId: string,
  channel: string,
  text: string,
  candidateNames?: string[],
  cards?: CandidateBriefCard[],
  jdHeadline?: string,
  jdHash?: string
): Promise<SlackPostMessageResult & { mode?: "interactive" | "web_link" }> {
  const useRich = Boolean(cards && cards.length > 0);
  const interactive = isSlackInteractivityConfigured();

  let blocks;
  if (useRich) {
    blocks = interactive
      ? buildShortlistApprovalBlocks({ actionId, channel, jdHeadline, cards: cards!, jdHash })
      : buildShortlistApprovalWebFallback({ channel, jdHeadline, cards: cards!, jdHash });
  } else {
    blocks = interactive
      ? buildApprovalBlocks({ actionId, channel, text, candidateNames })
      : buildApprovalBlocksWebFallback({ channel, text, candidateNames });
  }

  const preview = useRich
    ? `JD 쇼트리스트 승인 요청 (${cards!.length}명)`
    : "소싱 메시지 승인 요청";

  const result = await postSlackBlocks(channel, preview, blocks);
  return { ...result, mode: interactive ? "interactive" : "web_link" };
}

// Phase M2/M2.6: 결정 후 승인 요청 메시지 갱신
export async function updateSlackDecision(
  channel: string,
  ts: string,
  text: string,
  status: "executed" | "rejected" | "failed",
  decidedBy?: string,
  cards?: CandidateBriefCard[],
  jdHash?: string
): Promise<SlackPostMessageResult> {
  const blocks = buildDecisionBlocks({ text, status, decidedBy, cards, jdHash });
  return updateSlackMessage(channel, ts, "소싱 메시지 승인 결과", blocks);
}

import type { CandidateBriefCard } from "../../../shared/types.js";
import "./env.js";

const SLACK_API_BASE = "https://slack.com/api";

export interface SlackPostMessageResult {
  ok: boolean;
  channel?: string;
  ts?: string;
  error?: string;
}

// Slack Block Kit 블록은 형태가 다양하므로 느슨하게 둔다 (orchestrator에서 actionId만 신뢰).
type SlackBlock = Record<string, unknown>;

async function callSlack(method: string, body: Record<string, unknown>): Promise<SlackPostMessageResult> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) {
    throw new Error("SLACK_BOT_TOKEN이 .env.local에 설정되어 있지 않습니다.");
  }

  const response = await fetch(`${SLACK_API_BASE}/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  });

  return (await response.json()) as SlackPostMessageResult;
}

// Slack Bot Token(OAuth, xoxb-...) 기반 chat.postMessage 호출.
// HIL 승인 후 orchestrator -> notify_slack tool에서만 호출되는 "실행 액션"이다.
export async function postSlackMessage(channel: string, text: string): Promise<SlackPostMessageResult> {
  return callSlack("chat.postMessage", { channel, text });
}

// Phase M2: 승인 버튼이 달린 Block Kit 메시지 전송. 반환된 ts는 추후 chat.update로 메시지를
// "승인됨/반려됨"으로 갱신하기 위해 sourcing_actions.result에 저장한다.
export async function postSlackBlocks(
  channel: string,
  text: string,
  blocks: SlackBlock[]
): Promise<SlackPostMessageResult> {
  return callSlack("chat.postMessage", { channel, text, blocks });
}

// Phase M2: 이미 발송된 승인 요청 메시지를 결정 결과로 갱신 (버튼 제거 → 결과 텍스트).
export async function updateSlackMessage(
  channel: string,
  ts: string,
  text: string,
  blocks: SlackBlock[]
): Promise<SlackPostMessageResult> {
  return callSlack("chat.update", { channel, ts, text, blocks });
}

// Phase M2: Slack 인터랙티브 버튼(✅/❌)을 쓸 수 있는지 — Signing Secret + 공개 콜백 URL 필요.
// 미설정 시 버튼 대신 웹 승인 링크만 보낸다 (Slack "대화식 응답 미구성" 오류 방지).
export function isSlackInteractivityConfigured(): boolean {
  return Boolean(process.env.SLACK_SIGNING_SECRET?.trim() && process.env.SLACK_INTERACTIVITY_URL?.trim());
}

function reviewPageUrl(): string {
  const base = (process.env.TALENTFOLIO_URL ?? "http://localhost:3000").replace(/\/$/, "");
  return `${base}/sourcing/review`;
}

/** Talentfolio Brief 페이지 — Slack unfurl·Card 버튼 링크 (JD 적합도) */
export function briefPageUrl(candidateId: string, jdHash?: string): string {
  const base = (process.env.TALENTFOLIO_URL ?? "http://localhost:3000").replace(/\/$/, "");
  const q = jdHash ? `?jd=${encodeURIComponent(jdHash)}` : "";
  return `${base}/brief/${encodeURIComponent(candidateId)}${q}`;
}

/** Talentfolio 포트폴리오 페이지 — 후보 작업물·프로필 공간 */
export function talentPageUrl(candidateId: string): string {
  const base = (process.env.TALENTFOLIO_URL ?? "http://localhost:3000").replace(/\/$/, "");
  return `${base}/talent/${encodeURIComponent(candidateId)}`;
}

function verdictBadge(verdict: CandidateBriefCard["verdict"]): string {
  switch (verdict) {
    case "strong_fit":
      return "🟢 Strong Fit";
    case "possible_fit":
      return "🟡 Possible";
    default:
      return "🔴 Weak Fit";
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

/** 단일 후보 Card 섹션 (Carousel 1장) */
export function buildCandidateCardBlocks(card: CandidateBriefCard, jdHash?: string): SlackBlock[] {
  const matched = card.matchedSkills.slice(0, 5).join(" · ") || "—";
  const summary = truncate(card.ceoSummary, 160);
  const titleLine = card.title ? `\n_${card.title}_` : "";

  const blocks: SlackBlock[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: [
          `*${card.name}* · *${card.overallScore}*점  ${verdictBadge(card.verdict)}${titleLine}`,
          `기술 ${card.techScore} · 경험 ${card.experienceScore}`,
          `✓ ${matched}`,
          `_${summary}_`,
        ].join("\n"),
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "포트폴리오 보기", emoji: true },
          url: talentPageUrl(card.candidateId),
          action_id: `open_talent_${card.candidateId}`,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "JD Brief", emoji: true },
          url: briefPageUrl(card.candidateId, jdHash),
          action_id: `open_brief_${card.candidateId}`,
        },
      ],
    },
  ];

  return blocks;
}

/** 쇼트리스트 Carousel — 후보 Card를 세로로 나열 (Slack Block Kit) */
export function buildShortlistCarouselBlocks(input: {
  jdHeadline?: string;
  cards: CandidateBriefCard[];
  jdHash?: string;
  introText?: string;
}): SlackBlock[] {
  const { jdHeadline, cards, jdHash, introText } = input;
  const blocks: SlackBlock[] = [];

  if (introText) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: introText } });
  } else {
    blocks.push({
      type: "header",
      text: { type: "plain_text", text: `📋 JD 쇼트리스트 (${cards.length}명)`, emoji: true },
    });
  }

  if (jdHeadline) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: `포지션: *${jdHeadline}*` }],
    });
  }

  if (cards.length === 0) return blocks;

  blocks.push({ type: "divider" });

  for (let i = 0; i < cards.length; i++) {
    blocks.push(...buildCandidateCardBlocks(cards[i], jdHash));
    if (i < cards.length - 1) blocks.push({ type: "divider" });
  }

  return blocks;
}

/** 승인 요청용 Carousel + ✅/❌ 버튼 */
export function buildShortlistApprovalBlocks(input: {
  actionId: string;
  channel: string;
  jdHeadline?: string;
  cards: CandidateBriefCard[];
  jdHash?: string;
}): SlackBlock[] {
  const { actionId, channel, jdHeadline, cards, jdHash } = input;
  const carousel = buildShortlistCarouselBlocks({
    jdHeadline,
    cards,
    jdHash,
    introText: `*소싱 메시지 승인 요청*\n채널 \`${channel}\`에 아래 쇼트리스트를 공유할까요?`,
  });

  carousel.push({
    type: "actions",
    block_id: `sourcing_review:${actionId}`,
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "✅ 승인", emoji: true },
        style: "primary",
        action_id: "approve_sourcing",
        value: actionId,
      },
      {
        type: "button",
        text: { type: "plain_text", text: "❌ 거절", emoji: true },
        style: "danger",
        action_id: "reject_sourcing",
        value: actionId,
      },
    ],
  });

  return carousel;
}

/** Interactivity 미설정 + 리치 Card: Carousel + 웹 승인 링크 */
export function buildShortlistApprovalWebFallback(input: {
  channel: string;
  jdHeadline?: string;
  cards: CandidateBriefCard[];
  jdHash?: string;
}): SlackBlock[] {
  const { channel, jdHeadline, cards, jdHash } = input;
  const carousel = buildShortlistCarouselBlocks({
    jdHeadline,
    cards,
    jdHash,
    introText: `*소싱 메시지 승인 요청*\n채널 \`${channel}\`에 아래 쇼트리스트를 공유할까요?\n\n_※ Slack 앱 Interactivity 미설정 — 아래 링크에서 승인해 주세요._`,
  });

  carousel.push({
    type: "actions",
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "웹에서 승인하기", emoji: true },
        url: reviewPageUrl(),
        action_id: "open_web_review",
      },
    ],
  });

  return carousel;
}

/** 승인 후 팀 채널에 게시되는 공유 Card */
export function buildShortlistPublishedBlocks(input: {
  jdHeadline?: string;
  cards: CandidateBriefCard[];
  jdHash?: string;
}): SlackBlock[] {
  return buildShortlistCarouselBlocks({
    ...input,
    introText: "✅ *JD 핏 쇼트리스트* — 채용팀 공유",
  });
}

// 승인 요청 카드: 메시지 미리보기 + 대상 후보자 + ✅승인/❌거절 버튼.
// 버튼 value에 sourcing_actions.id를 넣어 Slack 인터랙티비티 콜백에서 식별한다.
export function buildApprovalBlocks(input: {
  actionId: string;
  channel: string;
  text: string;
  candidateNames?: string[];
}): SlackBlock[] {
  const { actionId, channel, text, candidateNames } = input;
  const blocks: SlackBlock[] = [
    {
      type: "section",
      text: { type: "mrkdwn", text: `*소싱 메시지 승인 요청*\n채널 \`${channel}\`로 아래 메시지를 보낼까요?` },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: `>>> ${text}` },
    },
  ];

  if (candidateNames && candidateNames.length > 0) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: `대상 후보자: ${candidateNames.join(", ")}` }],
    });
  }

  blocks.push({
    type: "actions",
    block_id: `sourcing_review:${actionId}`,
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "✅ 승인", emoji: true },
        style: "primary",
        action_id: "approve_sourcing",
        value: actionId,
      },
      {
        type: "button",
        text: { type: "plain_text", text: "❌ 거절", emoji: true },
        style: "danger",
        action_id: "reject_sourcing",
        value: actionId,
      },
    ],
  });

  return blocks;
}

// Interactivity 미설정 시: 클릭 가능한 URL 버튼(웹 승인 화면) — Request URL 없이도 동작.
export function buildApprovalBlocksWebFallback(input: {
  channel: string;
  text: string;
  candidateNames?: string[];
}): SlackBlock[] {
  const { channel, text, candidateNames } = input;
  const reviewUrl = reviewPageUrl();
  const blocks: SlackBlock[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*소싱 메시지 승인 요청*\n채널 \`${channel}\`로 아래 메시지를 보낼까요?\n\n_※ Slack 앱 Interactivity 미설정 — 아래 링크에서 승인해 주세요._`,
      },
    },
    { type: "section", text: { type: "mrkdwn", text: `>>> ${text}` } },
  ];
  if (candidateNames && candidateNames.length > 0) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: `대상 후보자: ${candidateNames.join(", ")}` }],
    });
  }
  blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "웹에서 승인하기", emoji: true },
        url: reviewUrl,
        action_id: "open_web_review",
      },
    ],
  });
  return blocks;
}

// ── Block Kit 빌더 (인터랙티브) ───────────────────────────────────────────────
export function buildDecisionBlocks(input: {
  text: string;
  status: "executed" | "rejected" | "failed";
  decidedBy?: string;
  cards?: CandidateBriefCard[];
  jdHash?: string;
}): SlackBlock[] {
  const { text, status, decidedBy, cards, jdHash } = input;
  const label =
    status === "executed"
      ? "✅ 승인됨 — Slack 전송 완료"
      : status === "rejected"
        ? "❌ 반려됨"
        : "⚠️ 승인됐으나 전송 실패";
  const by = decidedBy ? ` · 처리자: ${decidedBy}` : "";

  const blocks: SlackBlock[] = [
    { type: "section", text: { type: "mrkdwn", text: `*${label}*${by}` } },
  ];

  if (status === "executed" && cards && cards.length > 0) {
    blocks.push({ type: "divider" });
    for (const card of cards) {
      blocks.push(...buildCandidateCardBlocks(card, jdHash));
    }
  } else {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: `>>> ${text}` } });
  }

  return blocks;
}

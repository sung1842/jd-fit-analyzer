import "./env.js";

let cachedBotUserId: string | null = null;

/** Slack Bot user id (U...) — member_joined_channel 필터용 */
export async function getSlackBotUserId(): Promise<string | null> {
  const fromEnv = process.env.SLACK_BOT_USER_ID?.trim();
  if (fromEnv) return fromEnv;
  if (cachedBotUserId) return cachedBotUserId;

  const token = process.env.SLACK_BOT_TOKEN?.trim();
  if (!token) return null;

  try {
    const res = await fetch("https://slack.com/api/auth.test", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = (await res.json()) as { ok: boolean; user_id?: string };
    if (data.ok && data.user_id) {
      cachedBotUserId = data.user_id;
      return data.user_id;
    }
  } catch (err) {
    console.warn("[slack] auth.test 실패:", err);
  }
  return null;
}

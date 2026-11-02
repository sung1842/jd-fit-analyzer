/**
 * jd-fit-analyzer E2E 사전 점검 스크립트
 * 사용: cd jd-fit-analyzer && npx tsx scripts/verify-setup.ts
 */
import { config } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createConnection } from "node:net";
import { createClient } from "@supabase/supabase-js";
import { resolveFitDbConfig } from "../shared/lib/fitDb.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
config({ path: resolve(root, ".env.local") });

type Check = { name: string; ok: boolean; detail: string };

const checks: Check[] = [];

function pass(name: string, detail: string) {
  checks.push({ name, ok: true, detail });
  console.log(`✅ ${name}: ${detail}`);
}
function fail(name: string, detail: string) {
  checks.push({ name, ok: false, detail });
  console.log(`❌ ${name}: ${detail}`);
}
function warn(name: string, detail: string) {
  checks.push({ name, ok: true, detail: `[WARN] ${detail}` });
  console.log(`⚠️  ${name}: ${detail}`);
}

async function checkEnv() {
  const required = [
    "GEMINI_API_KEY",
    "ANTHROPIC_API_KEY",
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    "SLACK_BOT_TOKEN",
    "REDIS_URL",
  ];
  const optional = [
    "SLACK_SIGNING_SECRET",
    "SLACK_INTERACTIVITY_URL",
    "SLACK_EVENTS_URL",
    "SLACK_CHANNEL_AUTO_JD",
    "SLACK_CHANNEL_AUTO_USER_ID",
    "TALENTFOLIO_URL",
  ];

  for (const k of required) {
    if (process.env[k]?.trim()) pass(`env:${k}`, "설정됨");
    else fail(`env:${k}`, "미설정 — .env.local 확인");
  }
  for (const k of optional) {
    if (process.env[k]?.trim()) pass(`env:${k}`, "설정됨");
    else warn(`env:${k}`, "미설정 (Slack 인터랙티브 버튼 등 일부 기능 제한)");
  }

  const hasSingle = Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY?.trim());
  const hasLegacy = Boolean(
    process.env.FIT_ANALYZER_SUPABASE_URL?.trim() &&
      process.env.FIT_ANALYZER_SUPABASE_SERVICE_ROLE_KEY?.trim()
  );
  if (hasSingle) {
    pass("env:SUPABASE_SERVICE_ROLE_KEY", `single DB (schema=${process.env.FIT_DB_SCHEMA?.trim() || "fit"})`);
    if (hasLegacy) {
      warn("env:FIT_ANALYZER_SUPABASE_*", "legacy 키가 남아 있음. single 키가 우선이므로 이전 확인 후 제거");
    }
  } else if (hasLegacy) {
    warn(
      "env:SUPABASE_SERVICE_ROLE_KEY",
      "미설정 — legacy 분리 DB로 폴백 중. talentfolio service_role 키를 넣어야 fit 스키마를 본다"
    );
  } else {
    fail(
      "env:SUPABASE_SERVICE_ROLE_KEY",
      "미설정이고 legacy 키도 없음. talentfolio 프로젝트 service_role 을 .env.local 에 넣을 것"
    );
  }
}

async function checkRedis() {
  const url = process.env.REDIS_URL ?? "redis://localhost:6379";
  let host = "localhost";
  let port = 6379;
  try {
    const u = new URL(url);
    host = u.hostname;
    port = Number(u.port || 6379);
  } catch {
    /* defaults */
  }
  await new Promise<void>((resolve) => {
    const socket = createConnection({ host, port }, () => {
      pass("redis", `${host}:${port} 연결 OK`);
      socket.destroy();
      resolve();
    });
    socket.setTimeout(3000);
    socket.on("timeout", () => {
      socket.destroy();
      fail("redis", `${host}:${port} 연결 실패 — Docker Desktop 실행 후 redis 기동`);
      resolve();
    });
    socket.on("error", () => {
      fail("redis", `${host}:${port} 연결 실패 — Docker Desktop 실행 후 redis 기동`);
      resolve();
    });
  });
}

async function checkGemini() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return;
  try {
    const { GoogleGenAI } = await import("@google/genai");
    const ai = new GoogleGenAI({ apiKey: key });
    const res = await ai.models.generateContent({
      model: "gemini-2.5-flash-lite",
      contents: "Reply with exactly: OK",
    });
    const text = res.text?.trim() ?? "";
    if (text.includes("OK") || text.length > 0) {
      pass("gemini", `API 응답 OK (${text.slice(0, 40)})`);
    } else {
      fail("gemini", "빈 응답");
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("RESOURCE_EXHAUSTED") || msg.includes("429")) {
      fail("gemini", "크레딧/할당량 부족 — Google AI Studio에서 결제·할당량 확인 후 mcp-server 재시작");
    } else if (msg.includes("503") || msg.includes("UNAVAILABLE")) {
      warn("gemini", "일시적 과부하(503) — 키는 유효, 잠시 후 재시도");
    } else {
      fail("gemini", msg);
    }
  }
}

async function checkSlack() {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) return;
  try {
    const res = await fetch("https://slack.com/api/auth.test", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = (await res.json()) as { ok: boolean; team?: string; user?: string; user_id?: string; error?: string };
    if (data.ok) {
      pass("slack:auth.test", `team=${data.team}, bot=${data.user}, user_id=${data.user_id ?? "?"}`);
      if (!process.env.SLACK_BOT_USER_ID?.trim() && data.user_id) {
        warn("slack:bot_user_id", `SLACK_BOT_USER_ID 미설정 — auth.test user_id=${data.user_id} 를 .env.local에 추가 권장`);
      }
    } else fail("slack:auth.test", data.error ?? "unknown");
  } catch (e) {
    fail("slack:auth.test", e instanceof Error ? e.message : String(e));
  }

  const signing = process.env.SLACK_SIGNING_SECRET?.trim();
  const interUrl = process.env.SLACK_INTERACTIVITY_URL?.trim();
  if (signing && interUrl) {
    pass("slack:interactivity", "SIGNING_SECRET + INTERACTIVITY_URL 설정됨");
    try {
      const host = new URL(interUrl).origin;
      const res = await fetch(host, { method: "HEAD", signal: AbortSignal.timeout(5000) });
      warn("slack:ngrok", `터널 ${host} 응답 ${res.status} — ngrok 실행 중인지 확인`);
    } catch {
      warn("slack:ngrok", "터널 URL에 접근 불가 — ngrok 재시작 후 SLACK_INTERACTIVITY_URL·Slack App Request URL 동기화");
    }
  } else {
    warn("slack:interactivity", "미설정 → Slack ✅/❌ 버튼 대신 웹 /sourcing/review 승인만 가능");
  }

  const eventsUrl = process.env.SLACK_EVENTS_URL?.trim();
  if (signing && eventsUrl) {
    pass("slack:events", "SIGNING_SECRET + SLACK_EVENTS_URL 설정됨 (봇 채널 초대 자동 소싱)");
  } else {
    warn("slack:events", "미설정 → 봇 채널 초대 자동 소싱 비활성. Event Subscriptions + POST /api/slack/events 필요");
  }

  const autoJd = process.env.SLACK_CHANNEL_AUTO_JD?.trim();
  const autoUser = process.env.SLACK_CHANNEL_AUTO_USER_ID?.trim();
  if (autoJd && autoUser) {
    pass("slack:channel-auto", "SLACK_CHANNEL_AUTO_JD + USER_ID env 폴백 설정됨");
  } else {
    warn("slack:channel-auto", "미설정 — talentfolio 연동 설정 또는 slack_channel_configs 테이블로 채널별 JD 등록 필요");
  }
}

async function checkSupabase() {
  let cfg;
  try {
    cfg = resolveFitDbConfig();
  } catch (e) {
    fail("supabase:config", e instanceof Error ? e.message : String(e));
    return;
  }
  if (cfg.mode === "legacy") {
    warn("supabase:mode", "legacy public 스키마. 010 SQL 적용 + SUPABASE_SERVICE_ROLE_KEY 전까지 job_postings 는 검사하지 않음");
  } else {
    pass("supabase:mode", `single DB schema=${cfg.schema}`);
  }

  const db = createClient(cfg.url, cfg.serviceRoleKey, {
    db: { schema: cfg.schema },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const tables = [
    "fit_reports",
    "sourcing_actions",
    "notion_integrations",
    "slack_channel_configs",
    ...(cfg.mode === "single" ? (["job_postings"] as const) : []),
  ];
  for (const t of tables) {
    const { error } = await db.from(t).select("id").limit(1);
    const label = `supabase:${cfg.schema}.${t}`;
    if (error?.message.includes("does not exist") || error?.code === "42P01" || error?.code === "PGRST106") {
      fail(
        label,
        cfg.mode === "single"
          ? "테이블/스키마 없음 — 010 SQL 실행 + Dashboard Exposed schemas 에 fit 추가"
          : "테이블 없음 — docs/architecture/sql/ 의 구 DB용 001~009 실행 필요"
      );
    } else if (error?.message.includes("fetch failed")) {
      fail(label, "Supabase 연결 실패 — 프로젝트 일시중지 또는 URL/키가 다름");
    } else if (error) {
      warn(label, error.message);
    } else {
      pass(label, "접근 OK");
    }
  }
}

async function checkServices() {
  const ports: { name: string; port: number; path?: string }[] = [
    { name: "mcp-server", port: 3002, path: "/mcp" },
    { name: "orchestrator", port: 3001, path: "/api/candidates" },
    { name: "talentfolio", port: 3000 },
  ];
  for (const { name, port, path } of ports) {
    try {
      const url = `http://localhost:${port}${path ?? ""}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (res.ok || res.status === 400 || res.status === 405) {
        pass(`service:${name}`, `localhost:${port} 응답 ${res.status}`);
      } else {
        warn(`service:${name}`, `localhost:${port} 응답 ${res.status}`);
      }
    } catch {
      fail(`service:${name}`, `localhost:${port} 미기동 — npm run dev 필요`);
    }
  }
}

async function main() {
  console.log("\n=== jd-fit-analyzer + Talentfolio 설정 점검 ===\n");
  await checkEnv();
  await checkRedis();
  await checkGemini();
  await checkSlack();
  await checkSupabase();
  await checkServices();

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n--- 결과: ${checks.length - failed.length}/${checks.length} 통과, ${failed.length} 실패 ---\n`);
  process.exit(failed.length > 0 ? 1 : 0);
}

main();

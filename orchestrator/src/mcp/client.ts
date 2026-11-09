import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const MCP_SERVER_URL = process.env.MCP_SERVER_URL ?? "http://localhost:3002/mcp";
// 내부 서비스 간 인증: mcp-server 는 MCP_INTERNAL_KEY 가 설정되면 x-internal-key 가 일치하는 요청만 받는다.
const MCP_INTERNAL_KEY = process.env.MCP_INTERNAL_KEY;
if (!MCP_INTERNAL_KEY) {
  if (process.env.NODE_ENV === "production") {
    throw new Error("MCP_INTERNAL_KEY 가 없습니다. 프로덕션에서는 orchestrator↔mcp-server 내부 키가 필수입니다.");
  }
  console.warn("[mcp] MCP_INTERNAL_KEY 미설정 — 내부 키 없이 연결합니다 (개발 환경에서만 허용).");
}
const STARTUP_RETRY_MS = 2000;
// MCP SDK 기본 요청 타임아웃은 60초. mcp-server 는 Gemini 분당 한도(rateLimiter) 슬롯이 날 때까지 호출을 대기시키므로,
// 큐에 후보가 몰리면 대기만으로 60초를 넘겨 "Request timed out" 으로 job 이 실패했다 (2026-11-09 미래로시스템 건 19/20 실패).
// 대기는 정상 동작이므로 tool 호출 타임아웃을 넉넉히 둔다. BullMQ lock 은 자동 연장되어 job 이 stalled 되지 않는다.
const MCP_TOOL_TIMEOUT_MS = Number(process.env.MCP_TOOL_TIMEOUT_MS) || 300_000;
const STARTUP_MAX_ATTEMPTS = 15;

let client: Client | null = null;
let connecting: Promise<Client> | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isSessionError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("No valid session ID") || msg.includes("Invalid or missing session ID");
}

// mcp-server 재시작 등으로 세션이 무효화됐을 때 캐시된 클라이언트를 버린다.
export async function resetMcpClient(): Promise<void> {
  if (client) {
    try {
      await client.close();
    } catch {
      // stale session 정리 실패는 무시
    }
  }
  client = null;
  connecting = null;
}

// Phase 4: stdio(child process spawn) -> HTTP/SSE(Streamable HTTP) 전환.
// mcp-server는 독립 프로세스로 별도 기동되며, orchestrator는 HTTP 클라이언트로 연결한다.
export async function getMcpClient(): Promise<Client> {
  if (client) return client;
  if (connecting) return connecting;

  connecting = (async () => {
    // MCP 표준 Streamable HTTP 트랜스포트(POST JSON-RPC + GET SSE + mcp-session-id). 내부 키는 모든 요청 헤더에 실린다.
    const transport = new StreamableHTTPClientTransport(new URL(MCP_SERVER_URL), {
      requestInit: MCP_INTERNAL_KEY ? { headers: { "x-internal-key": MCP_INTERNAL_KEY } } : undefined,
    });

    const newClient = new Client({ name: "jd-fit-orchestrator", version: "0.1.0" });
    await newClient.connect(transport);
    client = newClient;
    connecting = null;
    return newClient;
  })().catch(async (err) => {
    connecting = null;
    throw err;
  });

  return connecting;
}

async function callMcpToolOnce<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const mcp = await getMcpClient();
  const result = await mcp.callTool({ name, arguments: args }, undefined, { timeout: MCP_TOOL_TIMEOUT_MS, maxTotalTimeout: MCP_TOOL_TIMEOUT_MS });

  if (result.isError) {
    const message = (result.content as Array<{ type: string; text?: string }>)
      .map((b) => b.text)
      .filter(Boolean)
      .join("\n");
    throw new Error(`MCP tool ${name} 호출 실패: ${message}`);
  }

  const textBlock = (result.content as Array<{ type: string; text?: string }>).find((b) => b.type === "text");
  if (!textBlock?.text) {
    throw new Error(`MCP tool ${name} 응답에 text content가 없습니다.`);
  }

  return JSON.parse(textBlock.text) as T;
}

export async function callMcpTool<T>(name: string, args: Record<string, unknown>): Promise<T> {
  try {
    return await callMcpToolOnce<T>(name, args);
  } catch (err) {
    // mcp-server 재시작 후 orchestrator가 예전 session ID를 들고 있으면 400이 난다 → 1회 재연결 후 재시도.
    if (!isSessionError(err)) throw err;
    console.warn("[mcp] stale session detected, reconnecting...");
    await resetMcpClient();
    return callMcpToolOnce<T>(name, args);
  }
}

export async function closeMcpClient(): Promise<void> {
  await resetMcpClient();
}

// orchestrator 부팅 시 mcp-server가 아직 안 떠 있으면 ECONNREFUSED로 즉시 종료되므로 재시도한다.
// 실행 순서: mcp-server(3002) → orchestrator(3001) — mcp-server를 먼저 기동할 것.
export async function waitForMcpClient(): Promise<Client> {
  for (let attempt = 1; attempt <= STARTUP_MAX_ATTEMPTS; attempt++) {
    try {
      return await getMcpClient();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const refused = message.includes("ECONNREFUSED") || message.includes("fetch failed");
      if (!refused || attempt === STARTUP_MAX_ATTEMPTS) throw err;
      console.warn(
        `[mcp] 연결 대기 중 (${attempt}/${STARTUP_MAX_ATTEMPTS}) — mcp-server(${MCP_SERVER_URL})가 실행 중인지 확인하세요.`
      );
      await resetMcpClient();
      await sleep(STARTUP_RETRY_MS);
    }
  }
  throw new Error("unreachable");
}

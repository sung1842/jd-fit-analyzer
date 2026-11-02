import { getAccessToken } from "./supabase";

// 백엔드 주소. NEXT_PUBLIC_API_URL 이 우선, 없으면 기존 NEXT_PUBLIC_ORCHESTRATOR_URL.
// 개발 환경에서만 localhost 기본값. 프로덕션에서 둘 다 없으면 빈 문자열 → 호출부가 에러.
function resolveOrchestratorUrl(): string {
  const raw = (process.env.NEXT_PUBLIC_API_URL ?? process.env.NEXT_PUBLIC_ORCHESTRATOR_URL)?.trim();
  if (raw) return raw.replace(/\/$/, "");
  if (process.env.NODE_ENV === "development") return "http://localhost:3001";
  return "";
}

export const ORCHESTRATOR_URL = resolveOrchestratorUrl();

/** Authorization: Bearer <Supabase JWT> 를 자동으로 붙이는 fetch. 토큰이 없으면 그대로 보내 서버가 401 을 돌려준다. */
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  if (!ORCHESTRATOR_URL) throw new Error("NEXT_PUBLIC_API_URL 이 설정되지 않았습니다.");
  const token = await getAccessToken();
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  return fetch(`${ORCHESTRATOR_URL}${path}`, { ...init, headers });
}

/** EventSource 는 헤더를 못 싣는다 → 서버가 허용한 SSE 경로에 한해 ?access_token= 으로 전달. */
export async function sseUrl(path: string, params: Record<string, string> = {}): Promise<string> {
  const token = await getAccessToken();
  const search = new URLSearchParams(params);
  if (token) search.set("access_token", token);
  const qs = search.toString();
  return `${ORCHESTRATOR_URL}${path}${qs ? `?${qs}` : ""}`;
}

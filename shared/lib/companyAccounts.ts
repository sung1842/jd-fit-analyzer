/**
 * 기업 계정 id 목록 (23 문서 G3). 후보 풀(profiles)에서 기업 계정을 빼는 데 쓴다.
 *
 * 계정 유형은 auth.users.app_metadata.account_type 에만 있어 profiles 조회만으로는 거를 수 없다.
 * Auth Admin API(서비스 롤)로 읽고 5분 캐시한다. 키가 없으면 빈 집합(필터 없음)으로 경고만 남긴다.
 */
const TTL_MS = 5 * 60 * 1000;
let cache: { at: number; ids: Set<string> } | null = null;

export async function companyUserIds(): Promise<Set<string>> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.ids;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.warn("[companyAccounts] SUPABASE_SERVICE_ROLE_KEY 가 없어 기업 계정을 후보에서 거르지 못합니다.");
    return new Set();
  }
  const ids = new Set<string>();
  for (let page = 1; page <= 50; page++) {
    const res = await fetch(`${url}/auth/v1/admin/users?page=${page}&per_page=1000`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    if (!res.ok) throw new Error(`기업 계정 조회 실패 (${res.status})`);
    const { users } = (await res.json()) as { users: { id: string; app_metadata?: { account_type?: string } }[] };
    for (const u of users) if (u.app_metadata?.account_type === "company") ids.add(u.id);
    if (users.length < 1000) break;
  }
  cache = { at: Date.now(), ids };
  return ids;
}

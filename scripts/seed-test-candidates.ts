/**
 * 매칭 엔진 테스트용 가상 후보 80명 투입 (레인 C D2, 사용자 승인 2026-11-02: "테스트 계정 생성" 방식).
 * 사용: cd orchestrator && npx tsx ../scripts/seed-test-candidates.ts [--only tc-001,edge-java-only]
 *
 * 1. auth.admin.createUser (이메일 `<test_id>@talentfolio.test`, email_confirm, user_metadata.test=true).
 *    이미 있으면 재사용(멱등). 비밀번호는 crypto 랜덤 — 메모리에서만 쓰고 저장·출력하지 않는다.
 * 2. public.profiles: service_role 에 권한이 없어(permission denied) 해당 사용자로 로그인(anon 키 + 랜덤 비번)해
 *    본인 행을 update 한다 (talentfolio seed-profiles.mjs 와 같은 경로). 행은 auth.users insert 트리거가 만든다.
 * 3. fit.resume_basics(지역·희망 직군) upsert, fit.resume_experiences 교체, fit.consents(matching) 1행 보장
 *    — 매칭 경로가 읽는 fit.public_resumes 뷰는 matching 동의자만 노출한다.
 * 4. test_id → user id 매핑을 scripts/data/test-candidates.ids.json 에 저장 (비밀 없음).
 * 삭제: scripts/delete-test-candidates.ts
 */
import "../orchestrator/src/lib/env.js";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(here, "data", "test-candidates.json");
const IDS = path.join(here, "data", "test-candidates.ids.json");
export const TEST_DOMAIN = "@talentfolio.test";

interface Exp { company: string; position: string; period: string; duties: string; achievements: string }
interface TestCandidate {
  test_id: string; name: string; role: string; title: string; region: string; remote_ok: boolean;
  skills: string[]; short_bio: string; long_bio: string; desired_categories: string[]; experiences: Exp[];
}

/** "2024.04 ~ 현재" → start_on/end_on/is_current */
function parsePeriod(p: string): { start_on: string; end_on: string | null; is_current: boolean } {
  const [a, b] = p.split("~").map((s) => s.trim());
  const ymd = (s: string) => { const [y, m] = s.split("."); return `${y}-${m.padStart(2, "0")}-01`; };
  const current = !b || b === "현재";
  return { start_on: ymd(a), end_on: current ? null : ymd(b), is_current: current };
}

async function main() {
  const { db } = await import("../orchestrator/src/lib/db.js");
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) throw new Error("NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY 필요");

  const onlyArg = process.argv.indexOf("--only");
  const only = onlyArg > 0 ? new Set(process.argv[onlyArg + 1].split(",")) : null;
  const all: TestCandidate[] = JSON.parse(readFileSync(DATA, "utf8")).candidates;
  const list = only ? all.filter((c) => only.has(c.test_id)) : all;

  // 기존 테스트 계정 (멱등)
  const existing = new Map<string, string>();
  for (let page = 1; ; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error(`listUsers 실패: ${error.message}`);
    for (const u of data.users) if (u.email?.endsWith(TEST_DOMAIN)) existing.set(u.email, u.id);
    if (data.users.length < 1000) break;
  }

  let ids: Record<string, string> = {};
  try { ids = JSON.parse(readFileSync(IDS, "utf8")).ids ?? {}; } catch { /* 첫 실행 */ }
  let created = 0, reused = 0, failed = 0;

  for (const c of list) {
    const email = `${c.test_id}${TEST_DOMAIN}`;
    const password = randomBytes(24).toString("base64url"); // 저장·출력 안 함
    try {
      let userId = existing.get(email);
      if (userId) {
        const { error } = await db.auth.admin.updateUserById(userId, { password, user_metadata: { test: true, test_id: c.test_id } });
        if (error) throw new Error(`updateUser: ${error.message}`);
        reused++;
      } else {
        const { data, error } = await db.auth.admin.createUser({
          email, password, email_confirm: true, user_metadata: { test: true, test_id: c.test_id, name: c.name },
        });
        if (error || !data.user) throw new Error(`createUser: ${error?.message}`);
        userId = data.user.id;
        created++;
      }

      // profiles — 본인 세션으로 update (RLS own row)
      const userClient = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false } });
      // Supabase Auth 로그인 rate limit — 걸리면 60초씩 기다렸다 재시도 (최대 10회)
      let signIn = await userClient.auth.signInWithPassword({ email, password });
      for (let i = 0; i < 10 && signIn.error && /rate limit/i.test(signIn.error.message); i++) {
        console.log(`[${c.test_id}] 로그인 rate limit — 60초 대기 (${i + 1}/10)`);
        await new Promise((r) => setTimeout(r, 60_000));
        signIn = await userClient.auth.signInWithPassword({ email, password });
      }
      if (signIn.error) throw new Error(`signIn: ${signIn.error.message}`);
      const prof = {
        name: c.name, role: c.role, title: c.title, short_bio: c.short_bio, long_bio: c.long_bio,
        skills: c.skills, github_url: null, portfolio_url: null, is_public: true,
      };
      const up = await userClient.from("profiles").update(prof).eq("id", userId).select("id");
      if (up.error) throw new Error(`profiles update: ${up.error.message}`);
      if (!up.data?.length) {
        const ins = await userClient.from("profiles").insert({ id: userId, ...prof });
        if (ins.error) throw new Error(`profiles insert(트리거 없음?): ${ins.error.message}`);
      }
      await userClient.auth.signOut();

      // fit 스키마 (service_role)
      const basics = await db.from("resume_basics").upsert({
        user_id: userId, headline: c.title, region_sido: c.region, desired_categories: c.desired_categories ?? [],
        desired_regions: c.remote_ok ? [c.region, "원격"] : [c.region], job_search_status: "open",
      });
      if (basics.error) throw new Error(`resume_basics: ${basics.error.message}`);
      const del = await db.from("resume_experiences").delete().eq("user_id", userId);
      if (del.error) throw new Error(`resume_experiences delete: ${del.error.message}`);
      if (c.experiences?.length) {
        const rows = c.experiences.map((e, i) => ({
          user_id: userId, company: e.company, position_title: e.position, duties: e.duties, achievements: e.achievements,
          visibility: "public", sort: i, ...parsePeriod(e.period),
        }));
        const ins = await db.from("resume_experiences").insert(rows);
        if (ins.error) throw new Error(`resume_experiences: ${ins.error.message}`);
      }
      const has = await db.from("consents").select("id").eq("user_id", userId).eq("purpose", "matching").is("revoked_at", null).limit(1);
      if (has.error) throw new Error(`consents: ${has.error.message}`);
      if (!has.data?.length) {
        const ins = await db.from("consents").insert({ user_id: userId, purpose: "matching" });
        if (ins.error) throw new Error(`consents insert: ${ins.error.message}`);
      }
      ids[c.test_id] = userId;
    } catch (e) {
      failed++;
      console.error(`[${c.test_id}] 실패: ${(e as Error).message}`);
    }
  }

  writeFileSync(IDS, JSON.stringify({ _meta: { purpose: "test_id → auth user id (비밀 없음)", updated: new Date().toISOString() }, ids }, null, 1) + "\n");
  console.log(`대상 ${list.length}: 생성 ${created}, 재사용 ${reused}, 실패 ${failed}. 매핑 ${Object.keys(ids).length}개 → ${path.relative(process.cwd(), IDS)}`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

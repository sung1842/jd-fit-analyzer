/**
 * 가입된 디자이너 구직 계정에 이력·근거 카드·작업물(프로젝트)을 넣는다 (fit 스키마, service_role).
 * 데이터: scripts/data/designer-accounts.json. 보정 비교용으로 계정마다 근거 양을 다르게 둔다.
 * 사용: cd orchestrator && npx tsx ../scripts/seed-designer-accounts.ts
 * 이미 이력·카드가 있는 계정은 건너뛴다 (사용자가 직접 넣은 데이터 보호). profiles 는 건드리지 않는다.
 */
import "../orchestrator/src/lib/env.js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ym = (s: string | null | undefined) => (s ? `${s}-01` : null);

async function main() {
  const { db } = await import("../orchestrator/src/lib/db.js");
  const { accounts } = JSON.parse(readFileSync(path.join(here, "data", "designer-accounts.json"), "utf8"));
  for (const a of accounts) {
    const uid = a.user_id;
    const [exp, cards] = await Promise.all([
      db.from("resume_experiences").select("id", { count: "exact", head: true }).eq("user_id", uid),
      db.from("evidence_cards").select("id", { count: "exact", head: true }).eq("user_id", uid),
    ]);
    if ((exp.count ?? 0) > 0 || (cards.count ?? 0) > 0) { console.log(`${a.name}: 기존 데이터 있음 — 건너뜀`); continue; }
    const must = (r: { error: { message: string } | null }, what: string) => { if (r.error) throw new Error(`${a.name} ${what}: ${r.error.message}`); };

    must(await db.from("resume_basics").upsert({ user_id: uid, ...a.basics }), "basics");
    // 카드 먼저 (경력·프로젝트에 연결). recorded_at 은 최근 1년 안에서 과거로 분산
    const cardIds: string[] = [];
    for (const [i, c] of (a.cards ?? []).entries()) {
      const at = new Date(Date.now() - (30 + i * 47) * 864e5).toISOString();
      const r = await db.from("evidence_cards").insert({
        user_id: uid, claim: c.claim, visibility: "public", trust_level: c.trust, recorded_at: at,
        source: "web", featured: !!c.featured, published_at: at,
      }).select("id").single();
      must(r, "card");
      cardIds.push(r.data!.id);
    }
    if (a.experiences?.length) must(await db.from("resume_experiences").insert(a.experiences.map((e: any, i: number) => ({
      user_id: uid, company: e.company, department: e.department, position_title: e.position, start_on: ym(e.start), end_on: ym(e.end),
      is_current: !e.end, duties: e.duties, achievements: e.achievements, sort: i, card_ids: i === 0 ? cardIds.slice(0, 3) : [],
    }))), "experiences");
    if (a.educations?.length) must(await db.from("resume_educations").insert(a.educations.map((e: any, i: number) => ({
      user_id: uid, school: e.school, major: e.major, degree: e.degree, start_on: ym(e.start), end_on: ym(e.end), sort: i,
    }))), "educations");
    if (a.certs?.length) must(await db.from("resume_certifications").insert(a.certs.map((c: any, i: number) => ({
      user_id: uid, kind: c.kind, name: c.name, issuer: c.issuer, score: c.score ?? null, acquired_on: ym(c.acquired), sort: i,
    }))), "certs");
    if (a.projects?.length) must(await db.from("resume_misc").insert(a.projects.map((p: any, i: number) => ({
      user_id: uid, kind: "project", title: p.title, org: p.org, start_on: ym(p.start), end_on: ym(p.end), description: p.description, sort: i,
      card_ids: cardIds.slice(i, i + 1),
    }))), "projects");
    const has = await db.from("consents").select("id").eq("user_id", uid).eq("purpose", "matching").is("revoked_at", null).limit(1);
    if (!has.data?.length) must(await db.from("consents").insert({ user_id: uid, purpose: "matching" }), "consent");
    console.log(`${a.name}: 경력 ${a.experiences.length} · 카드 ${cardIds.length} · 작업물 ${a.projects.length}`);
  }
  process.exit(0);
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

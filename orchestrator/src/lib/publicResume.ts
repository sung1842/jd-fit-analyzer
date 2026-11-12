/**
 * 기업 계정이 보는 후보 이력서 (구직자 스튜디오 "기업에게 보이는 화면"과 같은 범위).
 *
 * resume_* 테이블은 RLS 가 본인만 허용하므로, 서버(service role)에서 구직자가 공개로 둔 것만 골라 돌려준다.
 * - basics: public_fields 에 든 필드만
 * - 경력·학력·자격·기타: visibility = 'public' 행만
 * 요청자는 기업 계정이어야 한다 (구직자끼리 서로의 이력서를 보지 않게).
 */
import type { Express, Request, Response } from "express";
import { db } from "./db.js";
import { resolveUserId } from "./auth.js";
import { companyUserIds } from "../../../shared/lib/companyAccounts.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BASIC_KEYS = [
  "headline", "email", "phone", "region_sido", "region_sigungu", "birth_year", "desired_categories", "desired_regions",
  "desired_employment_types", "desired_salary_text", "available_from", "job_search_status", "military_status",
] as const;

type Row = Record<string, unknown>;

export function registerPublicResumeRoutes(app: Express): void {
  app.get("/api/candidates/:id/public-resume", async (req: Request, res: Response) => {
    const viewer = req.auth ? resolveUserId(req) : undefined;
    if (!viewer) return void res.status(401).json({ error: "로그인이 필요합니다." });
    const id = String(req.params.id);
    if (!UUID.test(id)) return void res.status(400).json({ error: "후보 id 형식이 아닙니다." });
    if (viewer !== id && !(await companyUserIds()).has(viewer)) return void res.status(403).json({ error: "기업 계정만 볼 수 있습니다." });

    try {
      const pick = (t: string, order: string) =>
        db.from(t).select("*").eq("user_id", id).eq("visibility", "public").order(order) as unknown as Promise<{ data: Row[] | null; error: { message: string } | null }>;
      const [basicsQ, exp, edu, cert, misc] = await Promise.all([
        db.from("resume_basics").select("*").eq("user_id", id).maybeSingle() as unknown as Promise<{ data: Row | null; error: { message: string } | null }>,
        pick("resume_experiences", "sort"),
        pick("resume_educations", "sort"),
        pick("resume_certifications", "sort"),
        pick("resume_misc", "sort"),
      ]);
      for (const q of [basicsQ, exp, edu, cert, misc]) if (q.error) throw new Error(q.error.message);

      const b = basicsQ.data;
      const pub = new Set((b?.public_fields as string[] | undefined) ?? []);
      const basics: Row = {};
      if (b) for (const k of BASIC_KEYS) if (pub.has(k) && b[k] != null && !(Array.isArray(b[k]) && (b[k] as unknown[]).length === 0)) basics[k] = b[k];

      // 희망 직군은 코드로 저장돼 있어 이름으로 바꿔 준다
      const codes = (basics.desired_categories as string[] | undefined) ?? [];
      if (codes.length) {
        const { data } = (await db.from("job_categories").select("code, name").in("code", codes)) as { data: { code: string; name: string }[] | null };
        const names = new Map((data ?? []).map((c) => [c.code, c.name]));
        basics.desired_categories = codes.map((c) => names.get(c) ?? c);
      }

      const strip = (rows: Row[] | null) => (rows ?? []).map(({ user_id: _u, visibility: _v, ...r }) => r);
      res.json({
        basics,
        experiences: strip(exp.data),
        educations: strip(edu.data),
        certifications: strip(cert.data),
        misc: strip(misc.data),
      });
    } catch (err) {
      console.error("[public-resume] 실패", err);
      res.status(500).json({ error: "이력서를 불러오지 못했습니다." });
    }
  });
}

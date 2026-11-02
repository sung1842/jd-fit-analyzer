/**
 * 실험용 1회성 스크립트: 플랫폼 수집 JSON(crawler `platform <name>` 출력)의 공고 본문 텍스트를 압축한다. DB 와 연결하지 않는다.
 * 길이 제약·재시도·잘라내기는 lib/jdCompress.ts(zod) 가 책임진다.
 *
 * - 헌법 3조: 크롤러가 이미 prune 한 본문 발췌(body_text, ≤4000자)와 제목·회사만 LLM 에 넣는다.
 * - 본문이 이미지형(body_text_missing)인 공고는 건너뛴다(이미지 CDN robots 때문에 수집하지 않음 → 사람이 링크로 확인).
 * - 출력: <input>_compressed.json  (crawler `platform-load --compressed` 가 external_id 로 합쳐서 DB 에 넣는다)
 *
 * 실행: cd mcp-server && npx tsx src/scripts/compress_jd_sample.ts ../crawler/out/board_a_postings_XXXX.json
 */
import fs from "node:fs";
import path from "node:path";
import { compressJd } from "../lib/jdCompress.js";

interface PlatformRecord {
  external_id: string;
  url: string;
  company?: string | null;
  title?: string | null;
  body_text?: string | null;
  body_text_missing?: boolean;
  skills?: string[];
  key_duties?: string[];
  must_have?: string[];
  nice_to_have?: string[];
  unclassified_items?: string[];
  site_facts?: Record<string, unknown>;
  career_text?: string | null;
  education_text?: string | null;
  employment_type_text?: string | null;
  salary_text?: string | null;
  location_text?: string | null;
  deadline_text?: string | null;
}

async function main() {
  const input = process.argv[2];
  if (!input) {
    console.error("usage: tsx src/scripts/compress_jd_sample.ts <platform_postings.json>");
    process.exit(1);
  }
  const abs = path.resolve(input);
  const data = JSON.parse(fs.readFileSync(abs, "utf-8")) as { records: PlatformRecord[] };

  const out: Array<Record<string, unknown>> = [];
  for (const r of data.records) {
    const text = r.body_text?.trim();
    if (!text || r.body_text_missing) {
      out.push({ external_id: r.external_id, skipped: "본문 텍스트 없음(이미지형 의심) — 사람이 링크로 확인" });
      console.log(`[skip] ${r.external_id} 본문 텍스트 없음`);
      continue;
    }
    try {
      const c = await compressJd({
        title: r.title ?? "",
        company: r.company ?? "",
        lists: {
          key_duties: r.key_duties ?? [],
          must_have: r.must_have ?? [],
          nice_to_have: r.nice_to_have ?? [],
          unclassified: r.unclassified_items ?? [],
        },
      });
      out.push({
        external_id: r.external_id,
        company: r.company,
        title: r.title,
        url: r.url,
        input_chars: text.length,
        ...c.data,
        compress_status: c.status,
        attempts: c.attempts,
        violations: c.violations,
        compressed_chars: [...c.data.compressed_text].length,
      });
      console.log(
        `[${c.status}] ${r.external_id} ${r.company} (${text.length}자 → ${[...c.data.compressed_text].length}자, 호출 ${c.attempts}회)` +
          (c.violations.length ? ` 위반: ${c.violations.slice(0, 3).join(" | ")}` : "")
      );
    } catch (e) {
      out.push({ external_id: r.external_id, error: e instanceof Error ? e.message.slice(0, 200) : String(e) });
      console.error(`[fail] ${r.external_id}`, e instanceof Error ? e.message.slice(0, 160) : e);
    }
  }

  const outPath = abs.replace(/\.json$/, "_compressed.json");
  fs.writeFileSync(outPath, JSON.stringify({ source: path.basename(abs), results: out }, null, 2), "utf-8");
  // 사람이 엑셀로 훑어보는 용도: 목록은 셀 안에서 줄바꿈(• 항목)으로 펼친다. UTF-8 BOM.
  const byIdx = new Map(data.records.map((r) => [r.external_id, r as unknown as Record<string, unknown>]));
  const list = (v: unknown) => (Array.isArray(v) ? v.map((x) => `• ${String(x)}`).join("\n") : "");
  const q = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const cols = ["external_id", "company", "title", "career_text", "education_text", "employment_type_text", "salary_text", "location_text", "deadline_text"] as const;
  const header = [...cols, "role_summary", "key_duties", "must_have", "nice_to_have", "skills", "body_text", "compressed_text", "compress_status", "url"];
  const lines = [header.join(",")];
  const md: string[] = ["# 공고 목록 (매칭용 배열 + 본문). compressed_text 는 카드용 한 줄이라 매칭에 쓰지 말 것.\n"];
  for (const o of out) {
    const src = byIdx.get(String(o.external_id)) ?? {};
    lines.push(
      [
        ...cols.map((c) => q(src[c] ?? o[c])),
        q(o.role_summary ?? o.skipped ?? o.error),
        q(list(o.key_duties)),
        q(list(o.must_have)),
        q(list(o.nice_to_have)),
        q(list(o.skills)),
        q(src.body_text),
        q(o.compressed_text),
        q(o.compress_status),
        q(src.url ?? o.url),
      ].join(",")
    );
    md.push(`## ${String(src.company ?? "")} — ${String(src.title ?? o.external_id)}\n`);
    md.push(`- external_id: ${String(o.external_id)}`);
    md.push(`- 링크: ${String(src.url ?? o.url ?? "")}\n`);
    const facts = (src.site_facts && typeof src.site_facts === "object" ? src.site_facts : {}) as Record<string, unknown>;
    if (Object.keys(facts).length) {
      md.push("### site_facts\n");
      md.push("```json");
      md.push(JSON.stringify(facts, null, 2));
      md.push("```\n");
    }
    const section = (title: string, v: unknown) => {
      md.push(`### ${title}`);
      if (Array.isArray(v) && v.length) v.forEach((x) => md.push(`- ${String(x)}`));
      else md.push(o.skipped || o.error ? `- ${String(o.skipped ?? o.error)}` : "- (없음)");
      md.push("");
    };
    section("주요업무", o.key_duties);
    section("자격요건", o.must_have);
    section("우대사항", o.nice_to_have);
    section("기술스택", o.skills);
    md.push("### 본문\n");
    md.push("```");
    md.push(String(src.body_text ?? "(본문 없음)"));
    md.push("```\n");
    md.push("---\n");
  }
  const viewPath = abs.replace(/\.json$/, "_VIEW.csv");
  const mdPath = abs.replace(/\.json$/, "_VIEW.md");
  fs.writeFileSync(viewPath, "\uFEFF" + lines.join("\r\n"), "utf-8");
  fs.writeFileSync(mdPath, md.join("\n"), "utf-8");
  console.log(JSON.stringify({ saved: outPath, view: viewPath, md: mdPath, count: out.length }));
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  }
);

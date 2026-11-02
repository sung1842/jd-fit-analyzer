/** 매칭 품질 지표(matchQuality.ts) 테스트: 가짜 결정 데이터, DB 없음 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { FitReport, FitReportRecord } from "../../shared/types.js";
import { computeMatchQuality, extractDecisions, type QualityInput } from "../src/lib/matchQuality.js";

type Opt = { by?: string; at?: string; reason?: string; hash?: string; legacy?: boolean };
function rec(id: string, verdict: FitReport["verdict"], decision: "approved" | "rejected" | null, o: Opt = {}): FitReportRecord {
  const review = decision && !o.legacy ? { decision, reason: o.reason ?? null, decidedBy: o.by ?? "r1", decidedAt: o.at ?? "2026-10-20T00:00:00Z" } : undefined;
  return {
    id,
    jobId: `j${id}`,
    jd: "jd",
    jdHash: o.hash ?? "h1",
    candidateId: `c${id}`,
    candidateName: null,
    userId: "u1",
    status: decision ?? "pending_review",
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-21T00:00:00Z",
    report: { candidateId: `c${id}`, candidateName: "", overallScore: 50, verdict, techStack: {} as never, experience: {} as never, ceoSummary: "", generatedAt: "", ...(review && { review }) },
  };
}

const base = (reports: FitReportRecord[], extra: Partial<QualityInput> = {}): QualityInput => ({
  reports,
  jdRuns: [
    { jd_hash: "h1", user_id: "u1", client_name: "acme" },
    { jd_hash: "h2", user_id: "u1", client_name: "beta" },
  ],
  offers: null,
  statusReasons: null,
  ...extra,
});

describe("matchQuality", () => {
  const reports = [
    rec("1", "strong_fit", "approved"),
    rec("2", "strong_fit", "rejected", { reason: "경력 범위 불일치" }),
    rec("3", "weak_fit", "approved", { by: "r2", hash: "h2" }),
    rec("4", "possible_fit", "rejected", { reason: "아무 메모" }),
    rec("5", "possible_fit", null),
    rec("6", "weak_fit", "rejected", { legacy: true }),
  ];

  test("승인율, 뒤집기율, 사유 분포", () => {
    const q = computeMatchQuality(base(reports));
    assert.equal(q.decided, 5);
    assert.equal(q.approval.n, 2);
    assert.equal(q.flip.n, 2);
    assert.equal(q.flip.strongRejected, 1);
    assert.equal(q.flip.weakApproved, 1);
    assert.deepEqual(q.rejectReasons, { career_mismatch: 1, other: 2 });
    assert.equal(q.acceptance, null);
    assert.equal(q.smallSample, true);
  });

  test("status_events reason_code 우선", () => {
    const q = computeMatchQuality(base(reports, { statusReasons: new Map([["4", "position_mismatch"]]) }));
    assert.equal(q.rejectReasons.position_mismatch, 1);
  });

  test("레거시(review 없음) 결정은 status, updatedAt, 소유자로 근사", () => {
    const d = extractDecisions(base([rec("6", "weak_fit", "rejected", { legacy: true })]))[0];
    assert.equal(d.decidedAt, "2026-10-21T00:00:00Z");
    assert.equal(d.recruiterId, "u1");
    assert.equal(d.companyId, "acme");
  });

  test("기간, 기업, 헤드헌터 필터", () => {
    assert.equal(computeMatchQuality(base(reports), { companyId: "beta" }).decided, 1);
    assert.equal(computeMatchQuality(base(reports), { recruiterId: "r2" }).decided, 1);
    assert.equal(computeMatchQuality(base(reports), { from: "2026-10-20T12:00:00Z" }).decided, 1);
    assert.equal(computeMatchQuality(base(reports), { to: "2026-10-20T12:00:00Z" }).decided, 4);
  });

  test("수락율: 결정에 연결된 발송 제안만", () => {
    const offer = (id: string, fr: string, response: string | null, sent = true) => ({
      id,
      candidate_id: null,
      jd_run_id: null,
      status: "executed",
      sent_at: sent ? "2026-10-22T00:00:00Z" : null,
      response,
      responded_at: null,
      interview_at: null,
      created_at: "",
      payload: { fitReportId: fr },
    });
    const q = computeMatchQuality(base(reports, { offers: [offer("o1", "1", "interested"), offer("o2", "3", "declined"), offer("o3", "3", null, false), offer("o4", "zz", "interested")] }));
    assert.deepEqual({ n: q.acceptance!.n, d: q.acceptance!.d }, { n: 1, d: 2 });
  });
});

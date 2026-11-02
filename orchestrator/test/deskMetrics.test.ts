/**
 * 데스크 지표 집계(deskMetrics.ts) 테스트. 순수 로직만.
 *   npm test --prefix orchestrator
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { FitReport, FitReportRecord } from "../../shared/types.js";
import { buildDeskFeed, classifyPosting, computeDeskSummary, computeSkillGap, reasonCode, type DeskInput } from "../src/lib/deskMetrics.js";

const NOW = new Date("2026-10-28T12:00:00Z");
const h = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * 3_600_000).toISOString();

function rec(id: string, status: FitReportRecord["status"], opts: Partial<{ verdict: FitReport["verdict"]; decision: "approved" | "rejected"; reason: string; decidedH: number; updatedH: number; createdH: number; hash: string; cited: string[] }> = {}): FitReportRecord {
  const hasReport = status !== "queued" && status !== "processing";
  const agent = (a: "tech_stack" | "experience") => ({ agent: a, score: 50, summary: "", matched_items: [], missing_items: [], evidence: [], citedCardIds: opts.cited ?? [] });
  return {
    id,
    jobId: `j${id}`,
    jd: "백엔드 개발자\n상세",
    jdHash: opts.hash ?? "h1",
    candidateId: `c${id}`,
    candidateName: `후보${id}`,
    userId: "u1",
    status,
    createdAt: h(opts.createdH ?? 24),
    updatedAt: h(opts.updatedH ?? 10),
    report: hasReport
      ? {
          candidateId: `c${id}`,
          candidateName: `후보${id}`,
          overallScore: 60,
          verdict: opts.verdict ?? "possible_fit",
          techStack: agent("tech_stack"),
          experience: agent("experience"),
          ceoSummary: "",
          generatedAt: h(10),
          ...(opts.decision ? { review: { decision: opts.decision, reason: opts.reason ?? null, decidedBy: "a@x.com", decidedAt: h(opts.decidedH ?? 2) } } : {}),
        }
      : null,
  };
}

function input(reports: FitReportRecord[], extra: Partial<DeskInput> = {}): DeskInput {
  return {
    now: NOW,
    rangeDays: 7,
    reports,
    jdRuns: [],
    jdRunsExtended: false,
    offers: null,
    views: null,
    explanationDue: null,
    supply: { developer: 3, designer: 1 },
    demand: { developer: 10, designer: 2 },
    skillGap: [],
    withdrawn: [],
    ...extra,
  };
}

describe("computeDeskSummary", () => {
  const reports = [
    rec("1", "completed", { updatedH: 31 }),
    rec("2", "pending_review", { updatedH: 5 }),
    rec("3", "approved", { decision: "approved", verdict: "weak_fit" }),
    rec("4", "rejected", { decision: "rejected", verdict: "strong_fit", reason: "경력 범위 불일치" }),
    rec("5", "rejected", { decision: "rejected", reason: "직접 쓴 사유" }),
    rec("6", "queued"),
    rec("7", "approved", { decision: "approved", decidedH: 24 * 10 }), // 기간 밖 결정
  ];
  const s = computeDeskSummary(input(reports));

  test("승인 대기와 최장 대기 시간", () => {
    assert.equal(s.pending.count, 2);
    assert.equal(s.pending.oldestWaitHours, 31);
  });

  test("결정·승인률·뒤집기는 기간 안의 review 만", () => {
    assert.deepEqual([s.approval.n, s.approval.d], [1, 3]);
    assert.equal(s.overrides.n, 2); // weak_fit 승인 + strong_fit 거절
    assert.equal(s.approval.small, true);
  });

  test("거절 사유: 칩 문자열 그대로, 직접 입력은 기타", () => {
    assert.deepEqual(s.rejectReasons.map((r) => r.label).sort(), ["경력 범위 불일치", "기타"]);
  });

  test("017 전에는 제안·응답·마감·열람 지표가 null", () => {
    assert.equal(s.funnel.offered, null);
    assert.equal(s.responses, null);
    assert.equal(s.deadlineSoon, null);
    assert.equal(s.firstOfferDays, null);
    assert.equal(s.quality.viewedBeforeApproval, null);
    assert.equal(s.quality.explanations, null);
    assert.equal(s.todo.responses, null);
  });

  test("퍼널 앞 3단계와 건 묶음", () => {
    assert.equal(s.funnel.matched, 7);
    assert.equal(s.funnel.analyzed, 6);
    assert.equal(s.cases.length, 1);
    assert.equal(s.cases[0].pending, 2);
    assert.equal(s.cases[0].title, "백엔드 개발자");
  });

  test("017 이후: 제안·응답·첫 제안까지·마감·열람", () => {
    const run = { id: "r1", jd_hash: "h1", jd_text: "x", created_at: h(72), title: "백엔드 시니어", deadline: h(-48), closed_at: null };
    const offer = (id: string, sentH: number, response: string | null, interview = false) => ({
      id, candidate_id: "c3", jd_run_id: "r1", status: "executed", sent_at: h(sentH), response,
      responded_at: response ? h(1) : null, interview_at: interview ? h(1) : null, created_at: h(sentH), payload: { jdHash: "h1", candidateName: "후보3", fitReportId: "3" },
    });
    const views = new Map([["3", [{ at: h(3), cardOpened: true }]]]);
    const t = computeDeskSummary(input(reports, { jdRuns: [run], jdRunsExtended: true, offers: [offer("o1", 24, "interested", true), offer("o2", 48, null)], views, explanationDue: [h(-24 * 5)] }));
    assert.deepEqual([t.funnel.offered, t.funnel.replied, t.funnel.interviewed], [2, 1, 1]);
    assert.equal(t.firstOfferDays, 1); // 72h 전 생성 → 48h 전 첫 발송
    assert.equal(t.deadlineSoon, 1);
    assert.equal(t.cases[0].title, "백엔드 시니어");
    assert.equal(t.cases[0].daysLeft, 2);
    assert.deepEqual([t.quality.viewedBeforeApproval?.n, t.quality.viewedBeforeApproval?.d], [1, 1]);
    assert.equal(t.quality.medianReviewSec, 3600);
    assert.deepEqual(t.quality.explanations, { open: 1, nearestDueDays: 5 });
    assert.equal(t.todo.responses, 1);
  });
});

describe("buildDeskFeed", () => {
  test("철회 주의가 맨 위, 나머지는 시간 역순", () => {
    const reports = [rec("1", "completed", { updatedH: 5 }), rec("2", "rejected", { decision: "rejected", reason: "경력 범위 불일치", decidedH: 1 })];
    const feed = buildDeskFeed({ now: NOW, reports, jdRuns: [], offers: null, jdRunsExtended: false, withdrawn: [{ candidateName: "후보9", jdHash: "h1", count: 1 }] });
    assert.equal(feed[0].kind, "alert");
    assert.equal(feed[1].kind, "team");
    assert.match(feed[1].text, /a님이 후보2 후보를 거절/);
    assert.equal(feed[2].kind, "agent");
  });
});

describe("보조 규칙", () => {
  test("reasonCode", () => {
    assert.equal(reasonCode("필수 역량 근거 부족"), "missing_evidence");
    assert.equal(reasonCode("아무 말"), "other");
    assert.equal(reasonCode(null), "other");
  });
  test("classifyPosting", () => {
    assert.equal(classifyPosting("프로덕트 디자이너", []), "designer");
    assert.equal(classifyPosting("백엔드 개발자", ["Node.js"]), "developer");
  });
  test("computeSkillGap: 카드 언급이 적은 역량 우선", () => {
    const gap = computeSkillGap([{ skills: ["Kafka", "Node.js"] }, { skills: ["Kafka", "Node.js"] }], ["Node.js 로 API 개발"], 2);
    assert.equal(gap[0].skill, "Kafka");
    assert.equal(gap[0].cards, 0);
  });
});

/**
 * 데스크 홈 지표 집계 (21 문서 §4). 순수 함수 — DB·LLM 없음 (헌법 3조: 코드 집계).
 * 입력에 없는 데이터(017 미적용 컬럼·테이블)는 null 로 돌려주고, 화면은 이를 "준비 중"으로 그린다.
 */
import { postingHeadline } from "../../../shared/lib/postingFormat.js";
import type { FitReportRecord } from "../../../shared/types.js";

export const REJECT_REASON_CODES: Record<string, string> = {
  "필수 역량 근거 부족": "missing_evidence",
  "경력 범위 불일치": "career_mismatch",
  "이미 접촉한 후보": "already_contacted",
  "포지션 조건 불일치": "position_mismatch",
  // 2026-11-10 승인함 개편 — AI 판단과 다르게 본 이유를 구체적으로 남긴다
  "경력 수준 불일치": "career_mismatch",
  "도메인·업종 경험 부족": "domain_mismatch",
  "관련 경험이 오래됨": "stale_experience",
  "근무 조건 불일치": "position_mismatch",
  "고객사 요청으로 제외": "client_exclusion",
};

export function reasonCode(reason: string | null | undefined): string {
  return (reason && REJECT_REASON_CODES[reason]) || "other";
}

export interface DeskOfferRow {
  id: string;
  candidate_id: string | null;
  jd_run_id: string | null;
  status: string;
  sent_at: string | null;
  response: string | null;
  responded_at: string | null;
  interview_at: string | null;
  created_at: string;
  payload: { candidateName?: string; jdHash?: string; fitReportId?: string } | null;
}

export interface DeskJdRunRow {
  id: string;
  jd_hash: string;
  jd_text: string;
  created_at: string;
  title?: string | null;
  client_name?: string | null;
  owner_name?: string | null;
  deadline?: string | null;
  closed_at?: string | null;
}

export interface DeskInput {
  now: Date;
  rangeDays: number;
  reports: FitReportRecord[];
  jdRuns: DeskJdRunRow[];
  /** jd_runs 확장 컬럼(017) 존재 여부 */
  jdRunsExtended: boolean;
  /** candidate_offer 행. null = 017 컬럼 없음 */
  offers: DeskOfferRow[] | null;
  /** fit_report_id → 열람 시각 목록. null = profile_views 없음 */
  views: Map<string, { at: string; cardOpened: boolean }[]> | null;
  /** 미처리 설명 요구 마감 시각. null = 테이블 없음 */
  explanationDue: string[] | null;
  /** 직무별 공개 후보 수 / 시장 공고 수 */
  supply: { developer: number; designer: number };
  demand: { developer: number; designer: number };
  /** 공고 요구 역량 빈도 상위 → 공개 카드 언급 수 */
  skillGap: { skill: string; demand: number; cards: number }[];
  /** 인용됐지만 지금 공개 뷰에 없는 카드 (공개 철회) — 승인 후보 기준 */
  withdrawn: { candidateName: string; jdHash: string; count: number }[];
}

const PENDING = new Set(["completed", "pending_review"]);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const ms = (iso: string | null | undefined) => (iso ? Date.parse(iso) : NaN);

export function chunk<T>(xs: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// 표준 양식은 첫 줄이 섹션 제목일 수 있다 — 섹션 제목·불릿을 건너뛴다
export const jdHeadline = (jd: string): string => postingHeadline(jd);

/** 분모가 작으면 %가 아닌 n/N 으로만 보여주도록 화면에 알린다 */
export const SMALL_SAMPLE = 30;
function ratio(n: number, d: number) {
  return { n, d, rate: d > 0 ? n / d : null, small: d < SMALL_SAMPLE };
}

export function computeDeskSummary(input: DeskInput) {
  const now = input.now.getTime();
  const from = now - input.rangeDays * DAY;
  const prevFrom = from - input.rangeDays * DAY;
  const inRange = (iso: string | null | undefined, a = from, b = now) => {
    const t = ms(iso);
    return t >= a && t < b;
  };

  // ── 승인 대기 (분석 완료 시각 근사 = updated_at; 정확한 값은 status_events)
  const pendingRows = input.reports.filter((r) => PENDING.has(r.status) && r.report);
  const waits = pendingRows.map((r) => now - ms(r.updatedAt)).filter((x) => Number.isFinite(x));
  const oldestWaitHours = waits.length ? Math.round(Math.max(...waits) / HOUR) : null;

  // ── 결정 (C1 이후 report.review 가 있는 개별 결정만)
  const decided = (a: number, b: number) =>
    input.reports.filter((r) => r.report?.review && inRange(r.report.review.decidedAt, a, b));
  const cur = decided(from, now);
  const prev = decided(prevFrom, from);
  const approvedN = (rows: FitReportRecord[]) => rows.filter((r) => r.report!.review!.decision === "approved").length;
  const overrides = cur.filter((r) => {
    const d = r.report!.review!.decision;
    const v = r.report!.verdict;
    return (d === "rejected" && v === "strong_fit") || (d === "approved" && v === "weak_fit");
  });
  const reasons = new Map<string, number>();
  for (const r of cur) {
    if (r.report!.review!.decision !== "rejected") continue;
    const reason = r.report!.review!.reason;
    const label = reason && REJECT_REASON_CODES[reason] ? reason : "기타";
    reasons.set(label, (reasons.get(label) ?? 0) + 1);
  }

  // ── 퍼널 (매칭·분석·승인 = 지금 데이터, 제안 이후 = 017)
  // 퍼널은 "기간 안에 매칭된 후보" 한 코호트를 끝까지 따라간다 (단계마다 기준 시각이 달라 비율이 깨지지 않게)
  const matched = input.reports.filter((r) => inRange(r.createdAt));
  const analyzed = matched.filter((r) => r.report);
  const cohortIds = new Set(matched.map((r) => r.id));
  const cohortDecided = matched.filter((r) => r.report?.review);
  // 후보(리포트)당 한 번만 센다 — 같은 후보에게 제안이 여러 건이어도 퍼널이 100% 를 넘지 않게
  const offersInRange = input.offers
    ? [...new Map(input.offers.filter((o) => o.sent_at && cohortIds.has(o.payload?.fitReportId ?? "")).sort((x, y) => ms(x.sent_at!) - ms(y.sent_at!)).map((o) => [o.payload!.fitReportId!, o])).values()]
    : null;
  const funnel = {
    matched: matched.length,
    analyzed: analyzed.length,
    approved: cohortDecided.filter((r) => r.report!.review!.decision === "approved").length,
    decided: cohortDecided.length,
    offered: offersInRange?.length ?? null,
    replied: offersInRange ? offersInRange.filter((o) => o.response === "interested" || o.response === "declined").length : null,
    interviewed: offersInRange ? offersInRange.filter((o) => o.interview_at).length : null,
  };

  // ── 스카우트 건 (jd_hash 묶음. 017 이후 jd_runs 확장 필드로 고객사·담당·마감)
  const runByHash = new Map(input.jdRuns.map((r) => [r.jd_hash, r]));
  const caseMap = new Map<string, { jdHash: string; title: string; client: string | null; owner: string | null; deadline: string | null; matched: number; analyzed: number; failed: number; approved: number; pending: number; replied: number | null; lastAt: number }>();
  for (const r of input.reports) {
    const run = runByHash.get(r.jdHash);
    if (run?.closed_at) continue;
    const c = caseMap.get(r.jdHash) ?? {
      jdHash: r.jdHash,
      title: run?.title || jdHeadline(r.jd),
      client: run?.client_name ?? null,
      owner: run?.owner_name ?? null,
      deadline: run?.deadline ?? null,
      matched: 0, analyzed: 0, failed: 0, approved: 0, pending: 0,
      replied: input.offers ? 0 : null,
      lastAt: 0,
    };
    c.matched += 1;
    if (r.report) c.analyzed += 1;
    if (r.status === "failed") c.failed += 1;
    if (r.status === "approved") c.approved += 1;
    if (PENDING.has(r.status) && r.report) c.pending += 1;
    c.lastAt = Math.max(c.lastAt, ms(r.updatedAt));
    caseMap.set(r.jdHash, c);
  }
  if (input.offers) {
    for (const o of input.offers) {
      const hash = o.payload?.jdHash ?? input.jdRuns.find((j) => j.id === o.jd_run_id)?.jd_hash;
      const c = hash ? caseMap.get(hash) : undefined;
      if (c && c.replied !== null && (o.response === "interested" || o.response === "declined")) c.replied += 1;
    }
  }
  const cases = [...caseMap.values()]
    .map((c) => ({ ...c, daysLeft: c.deadline ? Math.ceil((ms(c.deadline) - now) / DAY) : null }))
    .sort((a, b) => b.pending - a.pending || (a.daysLeft ?? 999) - (b.daysLeft ?? 999) || b.lastAt - a.lastAt)
    .slice(0, 8);

  const deadlineSoon = input.jdRunsExtended
    ? input.jdRuns.filter((r) => !r.closed_at && r.deadline && ms(r.deadline) - now <= 7 * DAY && ms(r.deadline) >= now - DAY).length
    : null;

  // ── 첫 제안까지 (건 생성 → 첫 후보 제안 발송, 중앙값 일)
  let firstOfferDays: number | null = null;
  if (input.offers) {
    const firsts = new Map<string, number>();
    for (const o of input.offers) {
      if (!o.jd_run_id || !o.sent_at) continue;
      const t = ms(o.sent_at);
      if (!firsts.has(o.jd_run_id) || t < firsts.get(o.jd_run_id)!) firsts.set(o.jd_run_id, t);
    }
    const spans = [...firsts].flatMap(([id, t]) => {
      const run = input.jdRuns.find((j) => j.id === id);
      return run && inRange(new Date(t).toISOString()) ? [(t - ms(run.created_at)) / DAY] : [];
    });
    const m = median(spans);
    firstOfferDays = m === null ? null : Math.round(m * 10) / 10;
  }

  // ── 검토 품질 (D4: 열람 로그)
  let viewedBeforeApproval: ReturnType<typeof ratio> | null = null;
  let medianReviewSec: number | null = null;
  let approvedWithoutEvidence = 0;
  if (input.views) {
    const approvals = cur.filter((r) => r.report!.review!.decision === "approved");
    let viewed = 0;
    const spans: number[] = [];
    for (const r of approvals) {
      const decidedAt = ms(r.report!.review!.decidedAt);
      const vs = (input.views.get(r.id) ?? []).filter((v) => ms(v.at) <= decidedAt);
      if (vs.some((v) => v.cardOpened)) viewed += 1;
      else approvedWithoutEvidence += 1;
      if (vs.length) spans.push((decidedAt - Math.min(...vs.map((v) => ms(v.at)))) / 1000);
    }
    viewedBeforeApproval = ratio(viewed, approvals.length);
    const m = median(spans);
    medianReviewSec = m === null ? null : Math.round(m);
  }
  const explanations = input.explanationDue
    ? {
        open: input.explanationDue.length,
        nearestDueDays: input.explanationDue.length ? Math.ceil((Math.min(...input.explanationDue.map(ms)) - now) / DAY) : null,
      }
    : null;

  return {
    rangeDays: input.rangeDays,
    generatedAt: input.now.toISOString(),
    pending: { count: pendingRows.length, oldestWaitHours },
    approval: { ...ratio(approvedN(cur), cur.length), prevRate: prev.length ? approvedN(prev) / prev.length : null },
    overrides: ratio(overrides.length, cur.length),
    rejectReasons: [...reasons].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count),
    funnel,
    cases,
    deadlineSoon,
    firstOfferDays,
    responses: funnel.offered === null ? null : ratio(funnel.replied ?? 0, funnel.offered),
    interviews: funnel.offered === null ? null : ratio(funnel.interviewed ?? 0, funnel.offered),
    quality: { viewedBeforeApproval, medianReviewSec, approvedWithoutEvidence: input.views ? approvedWithoutEvidence : null, explanations },
    supplyDemand: { supply: input.supply, demand: input.demand, skillGap: input.skillGap },
    todo: {
      approvals: pendingRows.length,
      responses: input.offers ? input.offers.filter((o) => o.response === "interested" && inRange(o.responded_at)).length : null,
    },
  };
}

export type DeskSummary = ReturnType<typeof computeDeskSummary>;

export type DeskFeedKind = "agent" | "response" | "team" | "alert";
export interface DeskFeedItem {
  kind: DeskFeedKind;
  at: string | null;
  text: string;
  href: string;
}

/** 소식 피드 (D2): 기존 테이블 시각을 합성. 응답·마감 항목은 017 데이터가 있을 때만. */
export function buildDeskFeed(input: Pick<DeskInput, "now" | "reports" | "jdRuns" | "offers" | "withdrawn" | "jdRunsExtended">, limit = 20): DeskFeedItem[] {
  const items: DeskFeedItem[] = [];
  const now = input.now.getTime();
  const review = (hash: string) => `/review?jd=${encodeURIComponent(hash)}`;

  // 에이전트: 건별로 묶은 분석 완료 / 대기열 투입
  const byHash = new Map<string, FitReportRecord[]>();
  for (const r of input.reports) byHash.set(r.jdHash, [...(byHash.get(r.jdHash) ?? []), r]);
  for (const [hash, rows] of byHash) {
    const run = input.jdRuns.find((j) => j.jd_hash === hash);
    if (run?.closed_at) continue; // 종료한 건은 소식에서 뺀다 (경보 포함)
    const title = run?.title || jdHeadline(rows[0].jd);
    const done = rows.filter((r) => r.report);
    if (done.length) {
      const strong = done.filter((r) => r.report!.verdict === "strong_fit").length;
      items.push({
        kind: "agent",
        at: new Date(Math.max(...done.map((r) => ms(r.updatedAt)))).toISOString(),
        text: `${title} 건 분석 ${done.length}명 완료 · 적합 ${strong} · 확인 필요 ${done.length - strong}`,
        href: review(hash),
      });
    }
    const queued = rows.filter((r) => r.status === "queued" || r.status === "processing");
    if (queued.length) {
      items.push({
        kind: "agent",
        at: new Date(Math.max(...queued.map((r) => ms(r.createdAt)))).toISOString(),
        text: `${title} 건 후보 ${queued.length}명 분석 대기열`,
        href: review(hash),
      });
    }
    const failed = rows.filter((r) => r.status === "failed");
    if (failed.length) {
      items.push({
        kind: "alert",
        at: new Date(Math.max(...failed.map((r) => ms(r.updatedAt)))).toISOString(),
        text: `${title} 건 후보 ${failed.length}명을 분석하지 못했습니다 · 다시 시도해 주세요.`,
        href: review(hash),
      });
    }
  }

  // 팀 결정
  for (const r of input.reports) {
    const rv = r.report?.review;
    if (!rv) continue;
    const who = rv.decidedBy ? `${rv.decidedBy.split("@")[0]}님이 ` : "";
    items.push({
      kind: "team",
      at: rv.decidedAt,
      text: `${who}${r.report!.candidateName} 후보를 ${rv.decision === "approved" ? "승인" : "거절"}했습니다${rv.reason ? ` · ${rv.reason}` : ""}`,
      href: `/brief/${encodeURIComponent(r.candidateId)}?jd=${encodeURIComponent(r.jdHash)}`,
    });
  }

  // 주의: 공개 철회 (시각 정보 없음 → 맨 위)
  for (const w of input.withdrawn) {
    items.push({
      kind: "alert",
      at: null,
      text: `승인 후보 ${w.candidateName}님이 인용된 근거 카드 ${w.count}장의 공개를 철회했습니다. 브리프를 다시 확인하세요.`,
      href: review(w.jdHash),
    });
  }

  // 주의: 마감 임박 (017)
  if (input.jdRunsExtended) {
    for (const j of input.jdRuns) {
      if (!j.deadline || j.closed_at) continue;
      const left = Math.ceil((ms(j.deadline) - now) / DAY);
      if (left >= 0 && left <= 7) {
        items.push({ kind: "alert", at: input.now.toISOString(), text: `${j.title || jdHeadline(j.jd_text)} 건 마감까지 ${left}일 남았습니다.`, href: review(j.jd_hash) });
      }
    }
  }

  // 후보 응답 (017)
  for (const o of input.offers ?? []) {
    if (!o.responded_at || !o.response || o.response === "no_response") continue;
    items.push({
      kind: "response",
      at: o.responded_at,
      text: o.response === "interested" && o.interview_at
        ? `${o.payload?.candidateName ?? "후보"}님과 면접을 잡았습니다.`
        : `${o.payload?.candidateName ?? "후보"}님이 제안에 ${o.response === "interested" ? "관심 있음" : "거절"}으로 답했습니다.`,
      href: `/desk?offer=${encodeURIComponent(o.id)}`,
    });
  }

  return items
    .sort((a, b) => (a.at === null ? -1 : b.at === null ? 1 : ms(b.at) - ms(a.at)))
    .slice(0, limit);
}

/** 공고 제목·역량으로 개발/디자인 분류 (스킬→세부 직무 매핑은 이후 단계) */
const DESIGN_RE = /디자인|디자이너|designer|design|UX|UI|figma|피그마|브랜딩|그래픽/i;
export function classifyPosting(title: string, skills: string[]): "developer" | "designer" {
  return DESIGN_RE.test(title) || skills.some((s) => /figma|피그마|sketch|photoshop|illustrator/i.test(s)) ? "designer" : "developer";
}

/** 공고 요구 역량 상위 중 공개 카드에서 언급이 적은 것 */
export function computeSkillGap(postings: { skills: string[] }[], claims: string[], top = 6) {
  const freq = new Map<string, number>();
  for (const p of postings) for (const s of new Set(p.skills.map((x) => x.trim()).filter(Boolean))) freq.set(s, (freq.get(s) ?? 0) + 1);
  const lower = claims.map((c) => c.toLowerCase());
  return [...freq]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)
    .map(([skill, demand]) => ({ skill, demand, cards: lower.filter((c) => c.includes(skill.toLowerCase())).length }))
    .sort((a, b) => a.cards / Math.max(1, a.demand) - b.cards / Math.max(1, b.demand) || b.demand - a.demand)
    .slice(0, top);
}

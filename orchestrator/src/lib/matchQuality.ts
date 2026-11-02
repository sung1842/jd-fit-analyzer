/**
 * 매칭 엔진 품질 지표 (22 문서 §7.1, E6). 엔진의 성적표 — 후보 등급이 아니다.
 *   승인율   = 승인 / 결정
 *   뒤집기율 = (AI strong_fit 거절 + weak_fit 승인) / 결정
 *   거절 사유 분포 = status_events.reason_code (017) 우선, 없으면 report.review.reason → reasonCode (deskMetrics 재사용)
 *   수락율   = 후보 interested / 발송된 candidate_offer
 * 집계는 순수 함수(computeMatchQuality), DB 읽기는 loadMatchQuality. 새 테이블 없음 — fit_reports·jd_runs·sourcing_actions·status_events 재사용.
 */
import type { FitReportRecord } from "../../../shared/types.js";
import { reasonCode, type DeskOfferRow } from "./deskMetrics.js";

export interface QualityFilter {
  /** ISO. 결정 시각(decidedAt) 기준 [from, to) */
  from?: string | null;
  to?: string | null;
  /** 의뢰 기업 = jd_runs.client_name (017) */
  companyId?: string | null;
  /** 결정한 헤드헌터 = review.decidedBy (없으면 리포트 소유자 user_id) */
  recruiterId?: string | null;
}

export interface QualityJdRun {
  jd_hash: string;
  user_id: string;
  client_name?: string | null;
}

export interface QualityDecision {
  fitReportId: string;
  jdHash: string;
  candidateId: string;
  verdict: "strong_fit" | "possible_fit" | "weak_fit" | null;
  decision: "approved" | "rejected";
  decidedAt: string;
  recruiterId: string;
  companyId: string | null;
  reasonCode: string | null;
}

export interface QualityInput {
  reports: FitReportRecord[];
  jdRuns: QualityJdRun[];
  /** candidate_offer 행. null = 017 미적용 */
  offers: DeskOfferRow[] | null;
  /** fit_report id → 최신 거절 reason_code. null = status_events 없음 */
  statusReasons: Map<string, string> | null;
}

const rate = (n: number, d: number) => ({ n, d, rate: d > 0 ? n / d : null });

/**
 * 결정 1건 = 승인/거절이 확정된 fit_report. C1 이후 report.review 가 있으면 그것, 이전 데이터는 status 로 근사
 * (decidedAt = updatedAt, decidedBy = 소유자).
 */
export function extractDecisions(input: Pick<QualityInput, "reports" | "jdRuns" | "statusReasons">): QualityDecision[] {
  // 같은 jd_hash 를 여러 사용자가 돌릴 수 있어 (user_id, jd_hash) 로 찾는다
  const clientOf = new Map<string, string | null>();
  for (const r of input.jdRuns) {
    const key = `${r.user_id}|${r.jd_hash}`;
    if (!clientOf.get(key)) clientOf.set(key, r.client_name ?? null);
  }
  const out: QualityDecision[] = [];
  for (const r of input.reports) {
    const review = r.report?.review;
    const decision = review?.decision ?? (r.status === "approved" || r.status === "rejected" ? r.status : null);
    if (!decision) continue;
    const fromEvents = input.statusReasons?.get(r.id) ?? null;
    out.push({
      fitReportId: r.id,
      jdHash: r.jdHash,
      candidateId: r.candidateId,
      verdict: r.report?.verdict ?? null,
      decision,
      decidedAt: review?.decidedAt ?? r.updatedAt,
      recruiterId: review?.decidedBy || r.userId,
      companyId: clientOf.get(`${r.userId}|${r.jdHash}`) ?? null,
      reasonCode: decision === "rejected" ? fromEvents ?? reasonCode(review?.reason) : null,
    });
  }
  return out;
}

export function filterDecisions(rows: QualityDecision[], f: QualityFilter): QualityDecision[] {
  const from = f.from ? Date.parse(f.from) : -Infinity;
  const to = f.to ? Date.parse(f.to) : Infinity;
  return rows.filter((d) => {
    const t = Date.parse(d.decidedAt);
    if (!(t >= from && t < to)) return false;
    if (f.companyId && d.companyId !== f.companyId) return false;
    if (f.recruiterId && d.recruiterId !== f.recruiterId) return false;
    return true;
  });
}

export function computeMatchQuality(input: QualityInput, filter: QualityFilter = {}) {
  const decisions = filterDecisions(extractDecisions(input), filter);
  const approved = decisions.filter((d) => d.decision === "approved");
  const flips = decisions.filter((d) => (d.decision === "rejected" && d.verdict === "strong_fit") || (d.decision === "approved" && d.verdict === "weak_fit"));

  const reasons: Record<string, number> = {};
  for (const d of decisions) if (d.decision === "rejected") reasons[d.reasonCode ?? "other"] = (reasons[d.reasonCode ?? "other"] ?? 0) + 1;

  const byVerdict: Record<string, { approved: number; rejected: number }> = {};
  for (const d of decisions) {
    const v = (byVerdict[d.verdict ?? "unknown"] ??= { approved: 0, rejected: 0 });
    v[d.decision] += 1;
  }

  // 수락율: 필터를 통과한 결정에 연결된 제안만 (payload.fitReportId). 기간 필터는 결정 기준으로 이미 걸렸다.
  let acceptance: ReturnType<typeof rate> | null = null;
  if (input.offers) {
    const ids = new Set(decisions.map((d) => d.fitReportId));
    const sent = input.offers.filter((o) => o.sent_at && ids.has(o.payload?.fitReportId ?? ""));
    acceptance = rate(sent.filter((o) => o.response === "interested").length, sent.length);
  }

  return {
    filter,
    decided: decisions.length,
    approval: rate(approved.length, decisions.length),
    flip: { ...rate(flips.length, decisions.length), strongRejected: flips.filter((d) => d.decision === "rejected").length, weakApproved: flips.filter((d) => d.decision === "approved").length },
    rejectReasons: reasons,
    byVerdict,
    acceptance,
    /** 분모 30 미만이면 화면은 % 대신 n/N (deskMetrics SMALL_SAMPLE 과 같은 기준) */
    smallSample: decisions.length < 30,
  };
}

export type MatchQuality = ReturnType<typeof computeMatchQuality>;

// ───────── DB 읽기 (읽기 전용) ─────────
const MISSING = new Set(["42P01", "42703", "PGRST204", "PGRST205"]);
export const isMissingError = (err: { code?: string } | null | undefined) => Boolean(err && err.code && MISSING.has(err.code));

export async function loadQualityInput(): Promise<QualityInput> {
  const { db } = await import("./db.js");
  const { listFitReports } = await import("./fitReports.js");
  const reports = await listFitReports({});

  let jdRuns: QualityJdRun[] = [];
  const ext = await db.from("jd_runs").select("jd_hash, user_id, client_name");
  if (!ext.error) jdRuns = (ext.data ?? []) as QualityJdRun[];
  else if (isMissingError(ext.error)) {
    const base = await db.from("jd_runs").select("jd_hash, user_id");
    if (base.error) throw new Error(`jd_runs 조회 실패: ${base.error.message}`);
    jdRuns = (base.data ?? []) as QualityJdRun[];
  } else throw new Error(`jd_runs 조회 실패: ${ext.error.message}`);

  let offers: DeskOfferRow[] | null = null;
  const o = await db.from("sourcing_actions").select("id, candidate_id, jd_run_id, status, sent_at, response, responded_at, interview_at, created_at, payload").eq("type", "candidate_offer");
  if (!o.error) offers = (o.data ?? []) as DeskOfferRow[];
  else if (!isMissingError(o.error)) throw new Error(`제안 조회 실패: ${o.error.message}`);

  let statusReasons: Map<string, string> | null = null;
  const ev = await db.from("status_events").select("entity_id, reason_code, at").eq("entity", "fit_report").eq("to_status", "rejected").order("at", { ascending: true });
  if (!ev.error) {
    statusReasons = new Map();
    for (const e of (ev.data ?? []) as { entity_id: string; reason_code: string | null }[]) if (e.reason_code) statusReasons.set(e.entity_id, e.reason_code);
  } else if (!isMissingError(ev.error)) throw new Error(`status_events 조회 실패: ${ev.error.message}`);

  return { reports, jdRuns, offers, statusReasons };
}

export async function loadMatchQuality(filter: QualityFilter = {}): Promise<MatchQuality> {
  return computeMatchQuality(await loadQualityInput(), filter);
}

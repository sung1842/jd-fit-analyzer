"use client";

import { useEffect, useState } from "react";
import { apiFetch, sseUrl } from "@/lib/api";
import type { CandidateSummary, FitReport, JobPostingSummary } from "@/lib/types";
import { FitReportCard } from "./FitReportCard";

const STAGE_LABEL: Record<string, string> = {
  queued: "대기 중",
  portfolio_fetch: "포트폴리오 조회 중",
  analyzing: "분석 중",
  reworking: "재작업 중",
  ceo_review: "CEO 검토 중",
  low_confidence: "신뢰도 낮음 - 검토 대기 전환",
  done: "완료",
  retrying: "일시적 오류로 재시도 중",
};

interface CandidateResult {
  status: string; // STAGE_LABEL의 키 또는 "submitting" | "completed" | "failed"
  report?: FitReport;
  error?: string;
}

/** job_postings.description 을 /api/analyze 의 jd 문자열로 변환 (LLM 입력이므로 핵심 필드만) */
function postingToJd(p: JobPostingSummary): string {
  const lines = [
    `[${p.company ?? "회사 미상"}] ${p.title}`,
    p.location ? `근무지: ${p.location}` : null,
    p.employmentType ? `고용형태: ${p.employmentType}` : null,
    p.experienceLevel ? `경력: ${p.experienceLevel}` : null,
    p.skills.length ? `기술 스택: ${p.skills.join(", ")}` : null,
    "",
    p.description ?? "",
  ];
  return lines.filter((l) => l !== null).join("\n").trim();
}

export function AnalyzeForm() {
  const [candidates, setCandidates] = useState<CandidateSummary[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [jd, setJd] = useState("");
  const [tier, setTier] = useState<"free" | "paid">("free");
  const [results, setResults] = useState<Record<string, CandidateResult>>({});
  const [loadingCandidates, setLoadingCandidates] = useState(true);
  const [postings, setPostings] = useState<JobPostingSummary[]>([]);
  const [postingQuery, setPostingQuery] = useState("");

  useEffect(() => {
    apiFetch("/api/candidates")
      .then((res) => res.json())
      .then((data) => setCandidates(data.candidates ?? []))
      .catch(() => setCandidates([]))
      .finally(() => setLoadingCandidates(false));
  }, []);

  async function searchPostings() {
    const params = new URLSearchParams({ limit: "30" });
    if (postingQuery.trim()) params.set("q", postingQuery.trim());
    const res = await apiFetch(`/api/job-postings?${params.toString()}`);
    const data = await res.json().catch(() => ({}));
    setPostings(res.ok ? (data.postings ?? []) : []);
  }

  function toggleCandidate(id: string) {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id]));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!jd.trim() || selectedIds.length === 0) return;

    for (const candidateId of selectedIds) {
      setResults((prev) => ({ ...prev, [candidateId]: { status: "submitting" } }));
      void analyzeCandidate(candidateId);
    }
  }

  async function analyzeCandidate(candidateId: string) {
    try {
      // userId 는 서버가 JWT 에서 추출한다 — 클라이언트는 보내지 않는다.
      const res = await apiFetch("/api/analyze", {
        method: "POST",
        body: JSON.stringify({ jd, candidateId, tier }),
      });
      const data = await res.json();

      if (!res.ok) {
        setResults((prev) => ({ ...prev, [candidateId]: { status: "failed", error: data.error ?? `HTTP ${res.status}` } }));
        return;
      }

      if (res.status === 200 && data.cached) {
        setResults((prev) => ({ ...prev, [candidateId]: { status: "completed", report: data.report } }));
        return;
      }

      const jobId = data.jobId as string;
      setResults((prev) => ({ ...prev, [candidateId]: { status: "queued" } }));

      const es = new EventSource(await sseUrl(`/api/jobs/${jobId}/stream`, { tier }));

      es.addEventListener("progress", (ev) => {
        const payload = JSON.parse((ev as MessageEvent).data);
        setResults((prev) => ({ ...prev, [candidateId]: { status: payload.stage } }));
      });

      es.addEventListener("completed", (ev) => {
        const report = JSON.parse((ev as MessageEvent).data) as FitReport;
        setResults((prev) => ({ ...prev, [candidateId]: { status: "completed", report } }));
        es.close();
      });

      es.addEventListener("failed", (ev) => {
        const payload = JSON.parse((ev as MessageEvent).data);
        setResults((prev) => ({ ...prev, [candidateId]: { status: "failed", error: payload.reason } }));
        es.close();
      });

      es.onerror = () => {
        es.close();
      };
    } catch (err) {
      setResults((prev) => ({
        ...prev,
        [candidateId]: { status: "failed", error: err instanceof Error ? err.message : String(err) },
      }));
    }
  }

  return (
    <div style={{ maxWidth: 720, margin: "0 auto", padding: 24, display: "flex", flexDirection: "column", gap: 16 }}>
      <h1>JD-Portfolio Fit Analyzer</h1>

      <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            value={postingQuery}
            onChange={(e) => setPostingQuery(e.target.value)}
            placeholder="수집된 채용공고 검색 (제목/회사)"
            style={{ flex: 1 }}
          />
          <button type="button" onClick={() => void searchPostings()}>
            공고 불러오기
          </button>
        </div>
        {postings.length > 0 && (
          <select
            defaultValue=""
            onChange={(e) => {
              const p = postings.find((x) => x.id === e.target.value);
              if (p) setJd(postingToJd(p));
            }}
          >
            <option value="">— 공고 선택 시 JD 에 채워짐 —</option>
            {postings.map((p) => (
              <option key={p.id} value={p.id}>
                [{p.source}] {p.company ?? "?"} — {p.title}
              </option>
            ))}
          </select>
        )}

        <label>
          채용공고(JD)
          <textarea
            value={jd}
            onChange={(e) => setJd(e.target.value)}
            rows={6}
            style={{ width: "100%", marginTop: 4 }}
            placeholder="JD 내용을 입력하거나 위에서 수집된 공고를 선택하세요"
          />
        </label>

        <label>
          Tier
          <select value={tier} onChange={(e) => setTier(e.target.value as "free" | "paid")} style={{ marginLeft: 4 }}>
            <option value="free">free</option>
            <option value="paid">paid</option>
          </select>
        </label>

        <div>
          <div style={{ marginBottom: 4, fontWeight: 600 }}>후보자 선택</div>
          {loadingCandidates && <p>후보자 목록 로딩 중...</p>}
          {!loadingCandidates && candidates.length === 0 && <p>후보자가 없습니다.</p>}
          {candidates.map((c) => (
            <label key={c.id} style={{ display: "block" }}>
              <input type="checkbox" checked={selectedIds.includes(c.id)} onChange={() => toggleCandidate(c.id)} />{" "}
              {c.name} {c.title ? `- ${c.title}` : ""} ({c.role})
            </label>
          ))}
        </div>

        <button type="submit" disabled={!jd.trim() || selectedIds.length === 0}>
          분석 시작
        </button>
      </form>

      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {Object.entries(results).map(([candidateId, result]) => {
          const candidate = candidates.find((c) => c.id === candidateId);
          if (result.status === "completed" && result.report) {
            return <FitReportCard key={candidateId} report={result.report} />;
          }
          return (
            <div key={candidateId} style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: 16 }}>
              <strong>{candidate?.name ?? candidateId}</strong>
              <p style={{ marginTop: 4 }}>
                {result.status === "failed"
                  ? `실패: ${result.error}`
                  : STAGE_LABEL[result.status] ?? result.status}
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );
}

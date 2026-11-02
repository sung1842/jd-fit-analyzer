"use client";

import { useEffect, useState } from "react";
import { apiFetch, sseUrl } from "@/lib/api";
import type { CandidateSummary, PortfolioChatResult } from "@/lib/types";

const STAGE_LABEL: Record<string, string> = {
  queued: "대기 중",
  indexing: "포트폴리오 인덱싱 중",
  searching: "관련 내용 검색 중",
  answering: "답변 생성 중",
  done: "완료",
  retrying: "일시적 오류로 재시도 중",
};

export function PortfolioChat() {
  const [candidates, setCandidates] = useState<CandidateSummary[]>([]);
  const [candidateId, setCandidateId] = useState("");
  const [question, setQuestion] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [result, setResult] = useState<PortfolioChatResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiFetch("/api/candidates")
      .then((res) => res.json())
      .then((data) => setCandidates(data.candidates ?? []))
      .catch(() => setCandidates([]));
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!candidateId || !question.trim()) return;

    setResult(null);
    setError(null);
    setStatus("submitting");

    try {
      const res = await apiFetch("/api/portfolio-chat", {
        method: "POST",
        body: JSON.stringify({ candidateId, question }),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error ?? `HTTP ${res.status}`);
        setStatus(null);
        return;
      }

      if (res.status === 200 && data.cached) {
        setResult(data.result as PortfolioChatResult);
        setStatus("done");
        return;
      }

      const jobId = data.jobId as string;
      setStatus("queued");

      const es = new EventSource(await sseUrl(`/api/portfolio-chat/${jobId}/stream`));

      es.addEventListener("progress", (ev) => {
        const payload = JSON.parse((ev as MessageEvent).data);
        setStatus(payload.stage);
      });

      es.addEventListener("completed", (ev) => {
        const payload = JSON.parse((ev as MessageEvent).data) as PortfolioChatResult;
        setResult(payload);
        setStatus("done");
        es.close();
      });

      es.addEventListener("failed", (ev) => {
        const payload = JSON.parse((ev as MessageEvent).data);
        setError(payload.reason);
        setStatus(null);
        es.close();
      });

      es.onerror = () => {
        es.close();
      };
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus(null);
    }
  }

  return (
    <div style={{ maxWidth: 720, margin: "0 auto", padding: 24, display: "flex", flexDirection: "column", gap: 16 }}>
      <h1>포트폴리오와 대화하기</h1>

      <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <label>
          후보자
          <select value={candidateId} onChange={(e) => setCandidateId(e.target.value)} style={{ marginLeft: 4 }}>
            <option value="">선택하세요</option>
            {candidates.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} {c.title ? `- ${c.title}` : ""} ({c.role})
              </option>
            ))}
          </select>
        </label>

        <label>
          질문
          <textarea
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            rows={3}
            style={{ width: "100%", marginTop: 4 }}
            placeholder="이 후보자의 포트폴리오에 대해 궁금한 점을 물어보세요"
          />
        </label>

        <button type="submit" disabled={!candidateId || !question.trim() || (status !== null && status !== "done")}>
          질문하기
        </button>
      </form>

      {status && status !== "done" && <p>{STAGE_LABEL[status] ?? status}</p>}
      {error && <p style={{ color: "crimson" }}>오류: {error}</p>}

      {result && (
        <div style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
          <p style={{ whiteSpace: "pre-wrap" }}>{result.answer}</p>

          {result.citedChunks.length > 0 && (
            <div>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>참고한 포트폴리오 내용</div>
              {result.citedChunks.map((chunk) => (
                <div key={chunk.id} style={{ fontSize: 14, color: "#555", borderLeft: "2px solid #e5e7eb", paddingLeft: 8, marginBottom: 4 }}>
                  <em>({chunk.sourceField})</em> {chunk.content}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

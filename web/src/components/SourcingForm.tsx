"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api";
import type { CandidateSourcingSummary } from "@/lib/types";

export function SourcingForm() {
  const [query, setQuery] = useState("");
  const [role, setRole] = useState<"" | "developer" | "designer">("");
  const [candidates, setCandidates] = useState<CandidateSourcingSummary[]>([]);
  const [searching, setSearching] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  const [channel, setChannel] = useState("#recruiting");
  const [text, setText] = useState("");
  const [submitMessage, setSubmitMessage] = useState<string | null>(null);

  async function search() {
    setSearching(true);
    setSubmitMessage(null);
    try {
      const params = new URLSearchParams();
      if (query.trim()) params.set("query", query.trim());
      if (role) params.set("role", role);

      const res = await apiFetch(`/api/sourcing/candidates?${params.toString()}`);
      const data = await res.json();
      setCandidates(data.candidates ?? []);
    } finally {
      setSearching(false);
    }
  }

  function toggleCandidate(id: string) {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id]));
  }

  async function submitAction(e: React.FormEvent) {
    e.preventDefault();
    if (!channel.trim() || !text.trim()) return;

    const selected = candidates.filter((c) => selectedIds.includes(c.id));

    // userId 는 서버가 JWT 에서 추출한다.
    const res = await apiFetch("/api/sourcing/actions", {
      method: "POST",
      body: JSON.stringify({
        channel: channel.trim(),
        text: text.trim(),
        candidateIds: selected.map((c) => c.id),
        candidateNames: selected.map((c) => c.name),
      }),
    });

    if (res.ok) {
      setSubmitMessage("Slack 알림 요청이 등록되었습니다. HIL 검토 화면에서 승인하면 실제로 전송됩니다.");
      setText("");
    } else {
      const data = await res.json().catch(() => ({}));
      setSubmitMessage(`등록 실패: ${data.error ?? res.statusText}`);
    }
  }

  return (
    <div style={{ maxWidth: 720, margin: "0 auto", padding: 24, display: "flex", flexDirection: "column", gap: 16 }}>
      <h1>B2B 인재 소싱</h1>

      <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <h2 style={{ margin: 0 }}>1. 인재 DB 검색</h2>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="이름/직함/기술 스택 키워드"
            style={{ flex: 1 }}
          />
          <select value={role} onChange={(e) => setRole(e.target.value as "" | "developer" | "designer")}>
            <option value="">전체</option>
            <option value="developer">developer</option>
            <option value="designer">designer</option>
          </select>
          <button type="button" onClick={search} disabled={searching}>
            {searching ? "검색 중..." : "검색"}
          </button>
        </div>

        {candidates.length === 0 && <p style={{ opacity: 0.6 }}>검색 결과가 없습니다.</p>}
        {candidates.map((c) => (
          <label key={c.id} style={{ display: "block" }}>
            <input type="checkbox" checked={selectedIds.includes(c.id)} onChange={() => toggleCandidate(c.id)} />{" "}
            {c.name} {c.title ? `- ${c.title}` : ""} ({c.role}) — {c.skills.join(", ")}
          </label>
        ))}
      </section>

      <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <h2 style={{ margin: 0 }}>2. Slack 알림 초안 작성</h2>
        <form onSubmit={submitAction} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <label>
            Slack 채널
            <input value={channel} onChange={(e) => setChannel(e.target.value)} style={{ marginLeft: 4 }} />
          </label>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={4}
            placeholder={`선택된 후보자: ${selectedIds.length}명\n메시지 내용을 입력하세요`}
          />
          <button type="submit" disabled={!channel.trim() || !text.trim()}>
            HIL 승인 요청 등록
          </button>
        </form>
        {submitMessage && <p>{submitMessage}</p>}
      </section>
    </div>
  );
}

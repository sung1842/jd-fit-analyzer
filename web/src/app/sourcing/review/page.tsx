"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import type { SourcingActionRecord } from "@/lib/types";

export default function SourcingReviewPage() {
  const [actions, setActions] = useState<SourcingActionRecord[]>([]);
  const [loading, setLoading] = useState(true);

  // 서버가 JWT 의 userId 로 본인이 만든 액션만 돌려준다.
  async function load() {
    const res = await apiFetch("/api/sourcing/actions?status=pending");
    const data = await res.json().catch(() => ({}));
    setActions(res.ok ? (data.actions ?? []) : []);
    setLoading(false);
  }

  useEffect(() => {
    void load();
  }, []);

  async function review(id: string, action: "approve" | "reject") {
    await apiFetch(`/api/sourcing/actions/${id}/review`, {
      method: "POST",
      body: JSON.stringify({ action }),
    });
    await load();
  }

  return (
    <div style={{ maxWidth: 720, margin: "0 auto", padding: 24, display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <Link href="/sourcing">← B2B 소싱 화면으로</Link>
      </div>
      <h1>소싱 액션 HIL 검토 대기열</h1>

      {loading && <p>로딩 중...</p>}
      {!loading && actions.length === 0 && <p>검토 대기 중인 액션이 없습니다.</p>}

      {actions.map((action) => (
        <div key={action.id} style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: 16, display: "flex", flexDirection: "column", gap: 8 }}>
          <div>
            <strong>Slack 알림</strong> → {action.payload.channel}
          </div>
          <pre style={{ whiteSpace: "pre-wrap", margin: 0, fontFamily: "inherit" }}>{action.payload.text}</pre>
          {action.payload.candidateNames && action.payload.candidateNames.length > 0 && (
            <div style={{ fontSize: 13, opacity: 0.7 }}>대상 후보자: {action.payload.candidateNames.join(", ")}</div>
          )}
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => review(action.id, "approve")}>승인 (Slack 전송)</button>
            <button onClick={() => review(action.id, "reject")}>반려</button>
          </div>
        </div>
      ))}
    </div>
  );
}

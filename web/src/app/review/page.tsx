"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import type { FitReportRecord } from "@/lib/types";
import { FitReportCard } from "@/components/FitReportCard";

export default function ReviewPage() {
  const [reports, setReports] = useState<FitReportRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 서버가 JWT 의 userId 로 본인 리포트만 돌려준다.
  const load = useCallback(async () => {
    try {
      const res = await apiFetch("/api/fit-reports?status=pending_review");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setReports(data.reports ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function review(id: string, action: "approve" | "reject") {
    await apiFetch(`/api/fit-reports/${id}/review`, {
      method: "POST",
      body: JSON.stringify({ action }),
    });
    await load();
  }

  return (
    <div style={{ maxWidth: 720, margin: "0 auto", padding: 24, display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <Link href="/">← 분석 화면으로</Link>
      </div>
      <h1>HIL 검토 대기열</h1>

      {loading && <p>로딩 중...</p>}
      {error && <p style={{ color: "crimson" }}>오류: {error}</p>}
      {!loading && !error && reports.length === 0 && <p>검토 대기 중인 리포트가 없습니다.</p>}

      {reports.map((record) => (
        <div key={record.id} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {record.report && <FitReportCard report={record.report} />}
          <div style={{ display: "flex", gap: 8, fontSize: 12, opacity: 0.7 }}>
            <span>JD: {record.jd.slice(0, 80)}{record.jd.length > 80 ? "..." : ""}</span>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => review(record.id, "approve")}>승인</button>
            <button onClick={() => review(record.id, "reject")}>반려</button>
          </div>
        </div>
      ))}
    </div>
  );
}

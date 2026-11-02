import type { AgentResult, FitReport } from "@/lib/types";

const VERDICT_LABEL: Record<FitReport["verdict"], string> = {
  strong_fit: "강력 추천",
  possible_fit: "검토 가능",
  weak_fit: "부적합",
};

const VERDICT_COLOR: Record<FitReport["verdict"], string> = {
  strong_fit: "#16a34a",
  possible_fit: "#d97706",
  weak_fit: "#dc2626",
};

function AgentResultSection({ title, result }: { title: string; result: AgentResult }) {
  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <strong>{title}</strong>
        <span>{result.score}점</span>
      </div>
      <p style={{ fontSize: 14, opacity: 0.85, margin: "4px 0" }}>{result.summary}</p>
      {result.flags && result.flags.length > 0 && (
        <p style={{ fontSize: 12, color: "#d97706" }}>flags: {result.flags.join(", ")}</p>
      )}
      <div style={{ display: "flex", gap: 16, fontSize: 13 }}>
        <div>
          <div style={{ opacity: 0.6 }}>충족</div>
          <ul>
            {result.matched_items.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
        <div>
          <div style={{ opacity: 0.6 }}>미충족</div>
          <ul>
            {result.missing_items.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

export function FitReportCard({ report }: { report: FitReport }) {
  return (
    <div style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h3 style={{ margin: 0 }}>{report.candidateName}</h3>
        <span
          style={{
            color: VERDICT_COLOR[report.verdict],
            fontWeight: 700,
          }}
        >
          {VERDICT_LABEL[report.verdict]} ({report.overallScore}점)
        </span>
      </div>
      <p style={{ marginTop: 8, fontSize: 14 }}>{report.ceoSummary}</p>
      <AgentResultSection title="기술 스택" result={report.techStack} />
      <AgentResultSection title="경험/트러블슈팅" result={report.experience} />
      {report.cultureFit && <AgentResultSection title="컬처핏" result={report.cultureFit} />}
      <p style={{ marginTop: 12, fontSize: 12, opacity: 0.5 }}>생성: {new Date(report.generatedAt).toLocaleString()}</p>
    </div>
  );
}

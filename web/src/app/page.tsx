import Link from "next/link";
import { AnalyzeForm } from "@/components/AnalyzeForm";

export default function Home() {
  return (
    <div>
      <div style={{ textAlign: "right", padding: "8px 24px", display: "flex", justifyContent: "flex-end", gap: 16 }}>
        <Link href="/portfolio-chat">포트폴리오와 대화하기 →</Link>
        <Link href="/sourcing">B2B 인재 소싱 →</Link>
        <Link href="/review">HIL 검토 화면 →</Link>
      </div>
      <AnalyzeForm />
    </div>
  );
}

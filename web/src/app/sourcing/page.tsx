import Link from "next/link";
import { SourcingForm } from "@/components/SourcingForm";

export default function SourcingPage() {
  return (
    <div>
      <div style={{ textAlign: "right", padding: "8px 24px", display: "flex", justifyContent: "flex-end", gap: 16 }}>
        <Link href="/">← 분석 화면으로</Link>
        <Link href="/sourcing/review">소싱 액션 검토 →</Link>
      </div>
      <SourcingForm />
    </div>
  );
}

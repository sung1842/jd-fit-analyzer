import Link from "next/link";
import { PortfolioChat } from "@/components/PortfolioChat";

export default function PortfolioChatPage() {
  return (
    <div>
      <div style={{ textAlign: "right", padding: "8px 24px" }}>
        <Link href="/">← 메인으로</Link>
      </div>
      <PortfolioChat />
    </div>
  );
}

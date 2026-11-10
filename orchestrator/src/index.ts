import "./lib/env.js";
import "./lib/langfuse.js"; // CEO(Claude) 호출 트레이싱 — 다른 모듈보다 먼저 초기화되어야 함
import "./lib/sentry.js"; // 다른 모듈의 부수효과(에러 발생)보다 먼저 초기화되어야 함
import { waitForMcpClient } from "./mcp/client.js";
import { createApp } from "./server.js";
import { startCrawlApproveWorker } from "./queue/crawlApproveQueue.js";
import { startCrawlRunWorker } from "./queue/crawlRunQueue.js";
import { startLifeWorker } from "./queue/lifeQueue.js";
import { startNormalizeSweepScheduler, startNormalizeWorker } from "./queue/normalizeQueue.js";
import { startRecommendSweepScheduler, startRecommendWorker } from "./queue/recommendQueue.js";
import { startWatchSchedulers, startWatchWorkers } from "./queue/watchQueue.js";
import { startWeightsScheduler, startWeightsWorker } from "./queue/weightsScheduler.js";
import { startHilTimeoutWorker } from "./queue/hilTimeout.js";
import { startPortfolioChatWorker } from "./queue/portfolioChatWorker.js";
import { startMaintenanceSchedulers, startMaintenanceWorker } from "./queue/maintenanceQueue.js";
import { startWorkers } from "./queue/workers.js";
import { utimesSync, writeFileSync } from "node:fs";

const PORT = process.env.PORT ? Number(process.env.PORT) : 3001;
// LAN 노출 차단용: 기본 loopback 바인드. ngrok 은 loopback(127.0.0.1)으로 접속하므로 영향 없음.
// 외부 바인드가 필요하면 ORCHESTRATOR_HOST=0.0.0.0 으로 override.
const HOST = process.env.ORCHESTRATOR_HOST || "127.0.0.1";
// 역할 분리 (수평 확장용): all = 기존 동작(전부 기동), api = HTTP + 싱글톤 스케줄러/HIL 타임아웃,
// worker = fit-analysis / portfolio-chat 워커만 (HTTP listen·스케줄러 없음 → 여러 개 띄워도 안전)
const ROLES = ["all", "api", "worker"] as const;
type Role = (typeof ROLES)[number];
const ROLE = (process.env.ORCHESTRATOR_ROLE || "all") as Role;
if (!ROLES.includes(ROLE)) {
  console.error(`ORCHESTRATOR_ROLE 값이 잘못됨: "${process.env.ORCHESTRATOR_ROLE}" (허용: ${ROLES.join(" | ")})`);
  process.exit(1);
}
const RUN_API = ROLE === "all" || ROLE === "api";
const RUN_WORKERS = ROLE === "all" || ROLE === "worker";

// 종료 신호를 받으면 새 job 을 받지 않고, 하던 분석을 끝낸 뒤 내려간다.
// (그냥 죽으면 하던 job 이 stalled 로 넘어가 다른 워커가 처음부터 다시 한다)
const shutdownTasks: (() => Promise<unknown>)[] = [];
let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} 수신 — 진행 중인 작업을 마치고 종료합니다.`);
  const timer = setTimeout(() => process.exit(1), Number(process.env.SHUTDOWN_TIMEOUT_MS) || 120_000);
  timer.unref();
  await Promise.allSettled(shutdownTasks.map((close) => close()));
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

async function main() {
  await waitForMcpClient();
  console.log(`MCP client 연결 완료 (Streamable HTTP, ${process.env.MCP_SERVER_URL ?? "http://localhost:3002/mcp"})`);

  console.log(`orchestrator role: ${ROLE}`);

  if (RUN_WORKERS) {
    const { paidWorker, freeWorker } = startWorkers();
    shutdownTasks.push(() => paidWorker.close(), () => freeWorker.close());
    console.log(
      `BullMQ 워커 시작: fit-analysis-paid / fit-analysis-free (concurrency ${process.env.FIT_WORKER_CONCURRENCY || 3}, LLM RPM 은 mcp-server GEMINI_RPM 이 제한)`
    );

    startPortfolioChatWorker();
    console.log("BullMQ 워커 시작: portfolio-chat (RAG, concurrency 1)");

    startCrawlApproveWorker();
    console.log("BullMQ 워커 시작: crawl-approve (크롤 검수 배치 승인·병합, concurrency 1)");

    startCrawlRunWorker();
    console.log("BullMQ 워커 시작: crawl-run (크롤 검수 수집 실행: 크롤 → 구조화 → 적재 → 배치 준비, concurrency 1)");

    startLifeWorker();
    console.log("BullMQ 워커 시작: life (life-structure / life-polish / life-publish / life-unpublish)");

    startNormalizeWorker();
    console.log("BullMQ 워커 시작: candidate-normalize (후보 정규화·변경 감지, 22 문서 E2)");

    startRecommendWorker();
    console.log("BullMQ 워커 시작: job-recommend (구직자 공고 추천, LLM 0회, SQL 022)");

    startWeightsWorker();
    console.log("BullMQ 워커 시작: ranking-weights (층별 가중치 보정, 22 문서 E6b)");

    startWatchWorkers();
    console.log("BullMQ 워커 시작: match-delta / match-scan (상시 수색, 22 문서 E7)");

    if (ROLE === "worker") {
      // 컨테이너 헬스체크용 heartbeat: 이벤트 루프가 멈추면 mtime 이 갱신되지 않는다
      const hbPath = process.env.WORKER_HEARTBEAT_FILE || "/tmp/worker-heartbeat";
      const beat = () => {
        try {
          const now = new Date();
          try { utimesSync(hbPath, now, now); } catch { writeFileSync(hbPath, ""); }
        } catch (err) {
          console.error("worker heartbeat 기록 실패:", err);
        }
      };
      beat();
      setInterval(beat, 15_000).unref();
    }
  }

  if (RUN_API) {
    // 싱글톤: 수평 확장 시 api 인스턴스에서만 기동 (worker 다중 기동 시 중복 실행 방지)
    startHilTimeoutWorker();
    console.log("HIL 타임아웃 워커 시작: hil-timeout (24h delayed expire)");

    const maintenance = startMaintenanceWorker();
    shutdownTasks.push(() => maintenance.close());
    await startMaintenanceSchedulers();
    console.log("정리 스케줄러 등록: fit-maintenance (분석 행 자동 정리 30분마다 · 무료 큐 승격 1분마다)");

    await startNormalizeSweepScheduler();
    console.log("후보 정규화 sweep 스케줄러 등록: candidate-normalize (매일 1회, NORMALIZE_SWEEP_CRON)");

    await startRecommendSweepScheduler();
    console.log("공고 추천 sweep 스케줄러 등록: job-recommend (매일 1회, 최근 활동 사용자만, RECOMMEND_SWEEP_CRON)");

    await startWeightsScheduler();
    console.log("가중치 보정 스케줄러 등록: ranking-weights (매주, RANKING_WEIGHTS_CRON)");

    await startWatchSchedulers();
    console.log("상시 수색 스케줄러 등록: match-delta (정기 점검·하루 요약)");

    const app = createApp();
    const server = app.listen(PORT, HOST, () => {
      console.log(`orchestrator API listening on http://${HOST}:${PORT}`);
    });
    // 동시 접속이 많을 때 부하 분산기보다 먼저 연결을 끊지 않게 keep-alive 를 넉넉히 둔다
    server.keepAliveTimeout = 65_000;
    server.headersTimeout = 66_000;
    shutdownTasks.push(() => new Promise((resolve) => server.close(() => resolve(undefined))));
  }
}

main().catch((err) => {
  console.error("orchestrator 부팅 실패:", err);
  process.exit(1);
});

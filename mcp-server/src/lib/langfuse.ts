import "./env.js";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";

// LANGFUSE_PUBLIC_KEY/SECRET_KEY 없으면 비활성화 — Sentry/n8n과 동일한 옵션형 연동 패턴.
// gemini.ts의 startObservation() 호출은 SDK 미기동 시 OTel no-op tracer로 흘러가 안전하다.
if (process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY) {
  const sdk = new NodeSDK({
    spanProcessors: [new LangfuseSpanProcessor()],
  });
  sdk.start();
}

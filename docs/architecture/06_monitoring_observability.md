# 06. 모니터링 & 에러 처리

> Phase 4 항목. 코드 레벨 try/catch만으로는 "어느 작업이 왜 실패했는지", "LLM이 어떤
> 프롬프트를 받고 어떤 환각 답변을 냈는지"를 추적하기 어렵다. LLM 트레이싱 +
> 백엔드 에러 트래킹으로 구성한다. n8n(영구 실패 알림)은 2026-10-25 보류 → [12_n8n_on_hold.md](12_n8n_on_hold.md).

---

## 1. Langfuse — LLM 전용 트레이싱 (구현 완료)

- Sentry는 "프로세스가 죽었다"는 사실만 잡고, "AI가 어떤 프롬프트를 먹고
  어떤 환각 답변을 뱉었는지"는 추적하지 못함
- Langfuse(오픈소스, EU 리전): 모델별 입력/출력/토큰 사용량을 타임라인으로 시각화

**연동 방식**: `@google/genai`(Gemini), `@anthropic-ai/sdk`(Claude CEO)는 Langfuse가
공식 프록시/오토 인스트루멘테이션을 제공하지 않으므로(Gemini 공식 연동 문서는
Python 전용), TS SDK v4(`@langfuse/tracing` + `@langfuse/otel` +
`@opentelemetry/sdk-node`)로 **수동 계측**한다.

- 초기화: [`mcp-server/src/lib/langfuse.ts`](../../mcp-server/src/lib/langfuse.ts),
  [`orchestrator/src/lib/langfuse.ts`](../../orchestrator/src/lib/langfuse.ts) — 각
  엔트리포인트(`index.ts`)에서 가장 먼저 import. `LangfuseSpanProcessor`를 등록한
  `NodeSDK`를 기동하며, `LANGFUSE_PUBLIC_KEY`/`LANGFUSE_SECRET_KEY`가 없으면 SDK를
  기동하지 않음(Sentry와 동일한 옵션형 연동 패턴) — 이 경우
  `startObservation()` 호출은 OTel no-op tracer로 흘러가 안전하다.
- 계측 지점: [`mcp-server/src/lib/gemini.ts`](../../mcp-server/src/lib/gemini.ts)의
  `generateStructured`/`embedTexts`(각 호출마다 `startObservation(name, { model, input },
  { asType: "generation" })`으로 generation span 생성 후 `usageDetails`/`output` 기록),
  그리고 [`orchestrator/src/ceo.ts`](../../orchestrator/src/ceo.ts)의 `evaluateAsCeo`
  (`anthropic.messages.create` 호출을 `ceo-evaluate` generation span으로 감쌈).
- mcp-server와 orchestrator는 별도 프로세스(Streamable HTTP)로 동작하므로, 현재는
  호출마다 독립된 trace로 기록된다 (CEO ↔ 하위 분석 에이전트 간 trace 연결은 추후
  HTTP 헤더 기반 OTel context propagation 도입 시 검토).

## 2. Sentry — 백엔드 인프라 에러

```typescript
import * as Sentry from "@sentry/node";
Sentry.init({ dsn: process.env.SENTRY_DSN });
// 이후 uncaughtException 등이 자동으로 Sentry 대시보드/알림으로 전송됨
```

- 오케스트레이터/워커 프로세스의 처리되지 않은 예외, BullMQ 워커 크래시 등을 추적.
- Phase 2(오케스트레이터 구현) 시점부터 적용 — Langfuse보다 우선순위 높음.

---

## 도입 우선순위

| 항목 | Phase | 비고 |
|---|---|---|
| Sentry | Phase 2 | 백엔드 크래시 추적, 도입 비용 낮음 — 적용 완료 |
| Langfuse | Phase 4 | LLM 호출별 generation 트레이싱 — 적용 완료 |

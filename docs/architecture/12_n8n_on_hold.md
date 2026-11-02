# 12. n8n — 보류 (2026-10-25)

> 상태: **보류.** 지금은 쓰지 않지만 나중에 다시 쓸 수 있어 jd-fit(orchestrator) 쪽 코드는 남겨 두었다.
> `N8N_ERROR_WEBHOOK_URL` 이 비어 있으면 아무것도 하지 않는다(no-op). n8n 을 띄우지 않아도 다른 기능에 영향 없다.
> 크롤러 쪽 n8n 연동(스케줄·완료 웹훅)은 2026-10-25 삭제했다 (§3).

## 1. jd-fit 분석에서 n8n 이 하던 일 — "실패 알림"만

기억과 다른 점: **완료 알림은 n8n 이 아니었다.** 코드 기준으로 n8n 은 재시도까지 다 실패한 job 만 받았다.

| 상황 | 실제로 알려주는 곳 | n8n? |
|---|---|---|
| 분석 진행·완료 (화면을 보고 있을 때) | SSE 스트림 (`orchestrator/src/lib/sse.ts`, `queueEvents.on("completed")`) | ✗ |
| 여러 명 분석이 끝나 strong_fit 후보가 나옴 | `POST /api/sourcing/auto-from-jd` → Slack 승인 카드 (Phase M2.5, Slack Bot Token 직접 호출) | ✗ |
| **job 이 재시도까지 다 실패** | Sentry + **n8n Webhook → Slack** | ✓ |
| HIL 24시간 만료 처리 job 이 실패 | Sentry + **n8n Webhook → Slack** | ✓ |

## 2. 구성 (코드 남아 있음)

```
BullMQ worker.on("failed")
  └─ attemptsMade >= opts.attempts 일 때만 (503/429 일시 오류 재시도 노이즈 제외)
       ├─ Sentry.captureException(...)
       └─ notifyN8nError(payload) ── POST N8N_ERROR_WEBHOOK_URL ──► n8n Webhook(/webhook/jd-fit-error) ──► Slack: Send a message
```

| 항목 | 내용 |
|---|---|
| 코드 | `orchestrator/src/lib/n8n.ts` 의 `notifyN8nError()` |
| 호출 위치 | `queue/workers.ts`(핏 분석), `queue/portfolioChatWorker.ts`(포트폴리오 대화), `queue/hilTimeout.ts`(HIL 만료) 의 `failed` 핸들러 |
| 환경변수 | 루트 `.env.local` 의 `N8N_ERROR_WEBHOOK_URL` (값 있음 — 비우면 비활성) |
| payload | `{ worker, jobId, candidateId?, errorMessage, attemptsMade }` |
| 인증 | 없음 (n8n Webhook 노드 URL 만) |
| 실패 처리 | 웹훅 호출 실패는 콘솔 로그만, 분석 흐름에 영향 없음 |
| n8n 워크플로 | `Webhook`(POST `/webhook/jd-fit-error`) → `Slack: Send a message`. 워크플로 JSON 은 레포에 없다 — 이 PC 의 기존 **Docker `n8n` 컨테이너(5678)** 데이터에 있을 수 있음 **[미확인]** |

"분석 파이프라인 자체를 n8n 워크플로로 옮기는" 방식(n8n Error Trigger·노드 Retry·Error Connector)은 검토만 했고 적용하지 않았다. BullMQ `attempts`/`backoff` 가 같은 역할을 한다.

## 3. 크롤러 쪽 계획 (삭제함)

| 용도 | 흐름 | 당시 상태 |
|---|---|---|
| 크롤 스케줄 | n8n Schedule(매일 10:00 KST) → 크롤러 FastAPI `POST /v1/trigger`(`x-internal-key`) | 워크플로 JSON 작성, Import 안 해 봄 |
| 크롤 완료/실패 알림 | 크롤러 → `N8N_CRAWL_WEBHOOK_URL`(`X-Webhook-Secret`) → n8n IF(status) → Slack | 코드 구현, 실제 수신 미검증 |

크롤은 필요할 때 사람이 CLI 로 돌리는 1회성 작업으로 정해져(2026-10-24) 스케줄이 필요 없어 지웠다. 크롤러 HTTP 서버(`/v1/trigger`)는 남아 있고 결과는 `GET /v1/jobs/{job_id}`.
`crawler/.env` 의 `N8N_CRAWL_*` 값은 이제 아무 코드도 읽지 않는다.

## 4. 다시 쓸 때 (설계 원칙)

- "완료 알림"이 필요하면 `worker.on("completed")` 에 같은 패턴으로 `notifyN8n...` 를 추가하면 된다 (지금은 없음). 사용자 식별·수신 채널을 payload 에 넣어야 한다.
- n8n 에 SSH/Execute Command 로 스크립트를 돌리게 하지 않는다 → HTTP 트리거 + 전용 키.
- 키는 경계마다 따로 (`CRAWLER_API_KEY` ≠ 웹훅 시크릿 ≠ `MCP_INTERNAL_KEY`).
- payload 에 예외 원문·DSN·키를 넣지 않는다.
- n8n 은 놓친 스케줄을 보충 실행하지 않는다. Docker n8n 이면 호스트 서비스 접근 때문에 비루프백 바인드가 필요해 LAN 노출 위험.

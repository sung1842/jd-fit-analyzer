# 15. 서비스 간 이벤트 연동 (설계안 — 구현 전 승인 필요)

> 상태: **설계만** (2026-10-26). 코드 변경 없음. 루프의 "제안/알림 실행" 단계 개선.
> 목적: 서비스들이 **한 가지 형식의 이벤트**를 주고받게 해, 나중에 만든 서비스를 붙이기 쉽게 한다.

## 1. 경계 — 코드에 남기는 것 vs 이벤트로 내보내는 것

| 구분 | 내용 | 위치 |
|---|---|---|
| 핵심 흐름 (코드 유지) | HIL 승인 상태 관리, Slack 승인 카드(M2), Notion 사용자별 OAuth 동기화(M4), 크롤 검수 | orchestrator / mcp-server |
| 이벤트 (밖으로 알림만) | 작업 완료·실패, 후보 승인/거절, HIL 타임아웃 | `emitEvent()` → 웹훅 수신자 |

규칙: 이벤트는 **알림·연동용 사본**이다. 수신자가 죽어도 핵심 흐름은 영향 없음(fire-and-forget, 실패는 로그+Sentry).

## 2. 이벤트 형식 (v1)

```jsonc
{
  "specVersion": 1,
  "id": "uuid",                 // 수신자 중복 제거용
  "event": "job.completed",
  "occurredAt": "2026-10-26T09:00:00Z",
  "source": "orchestrator-worker",
  "jobId": "…",                 // BullMQ jobId
  "userId": "…",                // 내부 UUID만
  "data": { }                   // 이벤트별 최소 필드
}
```

| event | data (최소) | 내보내는 곳 |
|---|---|---|
| `job.completed` | `queue`, `candidateId`, `verdict`, `overallScore` | `queue/workers.ts` `worker.on("completed")` |
| `job.failed` | `queue`, `attemptsMade`, `errorCode` | workers.ts / portfolioChatWorker.ts 영구 실패 지점 |
| `hil.timeout` | `actionId` | `queue/hilTimeout.ts` |
| `candidate.approved` / `candidate.rejected` | `actionId`, `candidateId` | sourcing_actions 승인 처리 라우트 |

**금지**: 이름·이메일·전화·포트폴리오 본문·JD 원문·에러 스택 전문·토큰/키. 식별자(UUID)와 점수만. 필요하면 수신자가 API로 조회.
버전 규칙: 필드 추가는 v1 유지, 의미 변경·삭제는 `specVersion` 올림.

## 3. 내보내는 방식

| 항목 | 설계 |
|---|---|
| 함수 | `orchestrator/src/lib/events.ts` 의 `emitEvent(evt)` 신설. 기존 `notifyN8nError()` 는 내부에서 `job.failed` 로 변환하는 얇은 래퍼로 남김 |
| 수신자 | `EVENT_WEBHOOK_URL` (콤마로 여러 개). 비면 no-op. 기존 `N8N_ERROR_WEBHOOK_URL` 은 호환용 별칭 |
| 인증 | `EVENT_WEBHOOK_SECRET` 으로 본문 HMAC-SHA256 → `X-Event-Signature` 헤더 |
| 타임아웃 | 3초, 재시도 없음(v1). 필요해지면 BullMQ 전용 `events` 큐로 재시도 — 헌법 2조 준수 |

## 4. 다중 워커(레플리카) 중복 검토

| 훅 | 실행 위치 | 중복? |
|---|---|---|
| `worker.on("completed"/"failed")` | 그 job을 처리한 워커 1곳 | **없음** → 여기서 발송 |
| `QueueEvents.on(...)` (`lib/sse.ts`) | 구독 중인 모든 프로세스 | 있음 → **발송 금지** (SSE 전용) |
| `hilTimeout` 반복 job | BullMQ 가 1개 워커에만 배정 | 없음 |

추가 안전장치: `id` 를 `${event}:${jobId}` 기반으로 만들어 수신자가 중복 제거 가능하게.

## 5. 받는 쪽 — 사용자 결정 필요

| 선택지 | 내용 |
|---|---|
| A. 추상화만 (추천) | `emitEvent` + 웹훅 URL 만 만들고 n8n 은 보류 유지([12](12_n8n_on_hold.md)). 나중에 만든 서비스가 같은 웹훅을 받으면 됨 |
| B. n8n 재가동 | compose 에 n8n 추가, 이벤트를 받아 Slack/메일로 퍼뜨림. 운영 대상 1개 증가 |

Notion 은 코드 경로(사용자별 OAuth) 유지 — n8n Notion 노드 경로는 쓰지 않는다.

## 6. 구현 범위 (승인 시)
`lib/events.ts` 신설, 워커 3곳·승인 라우트 호출 추가, env 2개(10 문서), compose env 전달, 12·11 문서 갱신.

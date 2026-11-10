# 03. 큐 시스템 (BullMQ + Redis)

> 절대 규칙 2 (비동기 큐 필수)의 상세 구현 스펙. JD 핏 분석 요청은 항상 큐에 작업을
> 등록하고, 워커 풀이 비동기로 처리한다. 오케스트레이터/웹 API는 분석 결과를 동기
> `await`로 기다리지 않는다(작업 등록 → 즉시 jobId 반환 → 폴링/구독으로 결과 확인).

---

## 요청 접수 — 202 Accepted

웹 API는 분석 요청을 받으면 동기로 결과를 기다리지 않고, 즉시 작업을 큐에 등록한 뒤
`202 Accepted` + `jobId`만 반환한다.

```typescript
app.post("/api/analyze", async (req, res) => {
  const { jd, candidateId, userTier } = req.body;
  const queue = userTier === "PREMIUM" ? premiumQueue : freeQueue;
  const job = await queue.add("analyze-fit", { jd, candidateId, userTier }, {
    jobId: `${hash(jd)}:${candidateId}`, // 캐싱 키와 동일 — 중복 작업 자동 dedup
  });
  return res.status(202).json({ jobId: job.id });
});
```

## 진행 상황 스트리밍 (SSE)

분석은 보통 수십 초가 걸리므로, 클라이언트는 `jobId`로 SSE 연결을 맺어 단계별 진행
상황을 실시간으로 받는다: `큐 대기 중 → 기술/경험 분석 중 → MCP 도구 조회 중 →
CEO 재검증 중 → 완료`. 워커가 각 단계 전환 시 Redis pub/sub(또는 BullMQ의
`job.updateProgress()`)으로 이벤트를 발행하고, API 서버가 이를 SSE로 클라이언트에
중계한다.

---

## 큐 구성

- **큐 이름**: `fit-analysis-paid`, `fit-analysis-free`
  - 요청자의 회원 등급(유료/무료)에 따라 다른 큐에 작업을 등록
  - 동일한 분석 로직을 사용하지만, 큐를 분리해 무료 사용자의 대량 요청이 유료
    사용자의 분석을 지연시키지 않도록 함
- **Redis 연결**: `REDIS_URL` 환경변수 (`.env.local`)
- **Job ID**: `${jdHash}:${candidateId}` — [캐싱 정책](01_agent_orchestration.md#토큰비용-관리-정책)과
  동일한 키를 사용해 중복 작업 등록 방지(BullMQ의 `jobId` 중복 시 자동 dedup)

---

## Worker Pool & Concurrency

- 전체 워커 concurrency를 **유료:무료 = 8:2** 비율로 배정
  - 예: 총 concurrency 10 → `fit-analysis-paid` 워커 concurrency 8, `fit-analysis-free` 워커 concurrency 2
- **기아 상태(starvation) 방지**: 무료 큐에 항상 최소 1~2 슬롯을 보장 — 유료 큐가
  아무리 밀려 있어도 무료 작업이 무한정 대기하지 않도록 별도 워커 프로세스/concurrency로
  분리(같은 워커가 큐 순서대로 처리하는 방식이 아니라, 큐별 워커를 독립적으로 기동).

```typescript
// orchestrator/src/queue/workers.ts (스펙 예시)

import { Worker } from "bullmq";

const connection = { connection: { url: process.env.REDIS_URL } };

new Worker("fit-analysis-paid", processFitAnalysisJob, {
  ...connection,
  concurrency: 8,
  limiter: { max: 40, duration: 60_000 }, // Gemini RPM 한도 보호 (429 차단)
});

new Worker("fit-analysis-free", processFitAnalysisJob, {
  ...connection,
  concurrency: 2,
  limiter: { max: 10, duration: 60_000 },
});
```

- `limiter`는 워커가 분당 처리할 수 있는 job 수를 강제해, Gemini API의 분당 요청 한도(RPM)를
  초과해 429가 발생하는 것을 원천 차단한다.

- `processFitAnalysisJob`은 [01. 에이전트 오케스트레이션](01_agent_orchestration.md)의
  `runFitAnalysis(jd, candidateId)`를 호출하고 결과를 DB에 저장 + 캐시에 기록.

---

## Job 데이터 / 상태

```typescript
interface FitAnalysisJobData {
  jd: string;
  candidateId: string;
  userId: string;
  tier: "paid" | "free";
}
```

- Job 상태는 BullMQ 기본 상태(`waiting`, `active`, `completed`, `failed`)를 따르되,
  완료 후 **분석 결과의 비즈니스 상태**(`pending_review`, `expired` 등)는
  [04. HIL & 타임아웃](04_hil_timeout.md)에서 별도 DB 컬럼으로 관리한다.

---

## 다중 후보자 분석

- 후보자를 N명 선택하면 N개의 개별 job을 동일 큐(tier에 따라)에 등록한다
  (하나의 거대한 job으로 묶지 않음 — 개별 캐싱/재시도/HIL 처리가 후보자 단위로 독립적이어야 함).
- 동시 분석 가능 후보자 수 상한(N, 기본 5명)은 큐 등록 자체를 제한하는 것이 아니라
  **웹 UI에서 한 번에 등록 가능한 job 수를 제한**하는 정책이다 — 큐/워커 동작과는 무관.

---

## (Phase 4 구현) 큐 내부 Job Priority & Promotion

`fit-analysis-paid`/`fit-analysis-free`의 물리적 큐 분리(원래 설계)는 그대로 유지한다 —
두 큐는 서로 경쟁하지 않으므로 "유료가 무료보다 먼저 처리된다"는 차별은 이미 큐
분리만으로 보장된다. 여기에 더해, **무료 큐 내부의 starvation 방지**를 위해
`priority` + 주기적 승격(promotion) 스케줄러를 추가했다.

- `JOB_PRIORITY` (`orchestrator/src/queue/queues.ts`): `paid: 1`, `free: 2`,
  `promoted: 1` (숫자가 작을수록 먼저 처리됨)
- `/api/analyze`에서 `queue.add(..., { jobId, priority: JOB_PRIORITY[tier] })`로
  요청 시 tier별 priority를 부여
- `promotionScheduler.ts`: 1분마다 `fit-analysis-free`의 `waiting` job을 스캔,
  5분(`FREE_QUEUE_PROMOTION_THRESHOLD_MS`) 이상 대기한 job은
  `job.changePriority({ priority: JOB_PRIORITY.promoted })`로 승격해 신규 무료
  요청보다 먼저 처리되도록 한다.
- `job.promote()`(delayed → waiting 전환용)는 사용하지 않음 — 이미 `waiting`
  상태인 job의 우선순위만 조정하면 되므로 `changePriority()`가 적합 (BullMQ v5.78
  기준 확인됨).

---

## 모니터링/로깅

- BullMQ 이벤트(`completed`, `failed`, `stalled`)를 구독해 [01. 토큰/비용 관리 정책](01_agent_orchestration.md#토큰비용-관리-정책)의
  로깅 요구사항(분석 1건당 LLM 호출 횟수/토큰 사용량)을 job 결과에 포함시켜 기록한다.

---

## 핏 분석 투입·재시도·정리 규칙 (2026-11-10 개편)

목표: 대규모 동시 접속(수천 명)에서 큐가 무너지지 않고, 재시도가 겹쳐 꼬이지 않고, DB 에 쓸모없는 행이 남지 않는다.

| 항목 | 규칙 | 코드 |
|---|---|---|
| 투입 | 모든 경로가 단일 입구를 거친다. 멱등(같은 JD·후보는 한 번만 실행), 사용자별 진행 중 상한, 큐 깊이 초과 시 즉시 503 + `Retry-After`, 많이 넣은 사용자일수록 우선순위 낮춤, Redis 무응답 시 4초 안에 실패 | `orchestrator/src/queue/enqueue.ts` |
| 진행 중 상태 | DB 에 쓰지 않는다. 사용자별 Redis ZSET(`fit:inflight:*`, `fit:retry:*`)에만 두고, 오래된 표시는 읽을 때 잘라낸다 | `orchestrator/src/lib/fitState.ts` |
| 결과 기록 | `fit_reports` 행은 결과가 나왔을 때만 만든다 (완료·검토 대기·다시 해도 같은 실패) | `saveFitResult` (`lib/fitReports.ts`) |
| 재시도 | BullMQ 한 곳에서만. mcp-server 는 모델당 1회만 시도하고 오류 코드(`[E_QUOTA]` `[E_BUSY]` `[E_UPSTREAM]` `[E_BLOCKED]` `[E_NOT_FOUND]` `[E_INVALID]`)를 붙여 돌려준다 | `mcp-server/src/lib/gemini.ts`, `lib/fitErrors.ts` |
| 오류별 처리 | permanent → 즉시 실패(재시도 없음) · capacity(LLM 한도·슬롯) → 시도 횟수를 쓰지 않고 뒤로 미룸, 최대 30분 · transient → 백오프 후 최대 3회 | `queue/workers.ts` |
| LLM 한도 | 분당 호출 수와 차단 표시(`llm:block:<model>`, `llm:breaker:analysis`)를 Redis 로 공유. 한도가 찬 모델은 호출하지 않는다 | `mcp-server/src/lib/rateLimiter.ts` |
| 화면 문구 | LLM 한도 등 일시 오류는 원인·분석 데이터를 저장하지 않는다. 화면에는 "오류가 발생했습니다. 다시 시도해 주세요."만 | `fit:retry:*` 표시 |
| 자동 정리 | 30분마다: 실패 행 2일 뒤 삭제, 예전 방식의 진행 중 행 정리, 24시간 넘은 검토 대기 만료. 끝난 job 은 완료 1시간·실패 2일 뒤 Redis 에서 삭제 | `queue/maintenanceQueue.ts`, `queue/queues.ts` |
| SSE | 큐마다 Redis 구독 연결 1개를 모든 접속이 공유 (접속 수만큼 연결을 만들지 않는다) | `lib/sse.ts` |
| 종료 | SIGTERM 시 하던 분석을 끝내고 내려간다 | `index.ts` |

수평 확장: api·worker·mcp-server 모두 프로세스 메모리에 상태를 두지 않는다. 단 mcp-server 는 MCP 세션이 인스턴스에 묶이므로 여러 대일 때 세션 고정이 필요하다.
처리량 상한은 LLM 계약 한도가 정한다. 환경변수(`GEMINI_RPM`, `FIT_WORKER_CONCURRENCY`, `FIT_PAID_JOBS_PER_MIN`, `FIT_FREE_JOBS_PER_MIN`, `FIT_MAX_INFLIGHT_PER_USER`, `FIT_MAX_QUEUE_DEPTH`, `FIT_MAX_WAIT_MS`)를 한도에 맞춰 함께 올린다.

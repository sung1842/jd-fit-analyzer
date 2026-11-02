# 04. Human-in-the-Loop (HIL) & 타임아웃

> CEO 에이전트가 결과를 신뢰할 수 없다고 판단했을 때(`flags: ["low_confidence"]`,
> 재작업 1회 후에도 검증 실패) 자동으로 최종 확정하지 않고, 사람(리크루터/운영자)의
> 검토를 거치도록 하는 단계. [01. 에이전트 오케스트레이션](01_agent_orchestration.md)의
> 재작업 루프 종료 후 진입 지점이다.

---

## 폴링 없는 일시정지/재개

분석 워커는 `pending_review` 상태를 DB에 기록하는 즉시 종료되어 자원을 반납한다 —
사람의 승인을 기다리며 워커를 블로킹(`await waitForHuman()`)하지 않는다. 후속 처리는
**리크루터의 승인 액션(웹 UI 클릭 → API 호출)이 들어온 시점에만** 트리거된다. DB가
"상태 중계소" 역할을 하므로, 워커/서버가 중간에 재시작되어도 상태만 보존되면 재개 가능.

```typescript
// 승인 API — 리크루터가 검토 화면에서 클릭했을 때만 호출됨 (폴링 없음)
app.post("/api/fit-reports/:id/review", async (req, res) => {
  const { action } = req.body as { action: "approve" | "reject" };
  const report = await db.fitReports.findById(req.params.id);

  if (!report || report.status !== "pending_review") {
    return res.status(400).json({ error: "검토 대상이 아닙니다." });
  }

  await db.fitReports.update(report.id, {
    status: action === "approve" ? "approved" : "rejected",
  });
  return res.json({ status: action === "approve" ? "approved" : "rejected" });
});
```

---

## DB 상태값 정의

`fit_reports` 테이블(가정)에 다음 상태 컬럼을 둔다:

```typescript
type FitReportStatus =
  | "queued"          // 큐에 등록됨, 아직 처리 전
  | "processing"       // 분석 진행 중
  | "completed"        // 정상 완료 (HIL 불필요)
  | "pending_review"   // low_confidence 플래그 → 사람 검토 대기
  | "approved"         // 사람이 검토 후 그대로 승인
  | "rejected"         // 사람이 검토 후 반려/재분석 요청
  | "expired";         // pending_review 상태로 24시간 경과 → 자동 만료
```

- `completed` → 바로 웹 UI에 노출
- `pending_review` → 웹 UI에 "검토 필요" 배지로 노출, 리크루터가 `FitReport` 내용을
  확인 후 `approved`/`rejected`로 변경
- `expired` → 리크루터가 24시간 내 검토하지 않은 경우. UI에는 `low_confidence`
  플래그를 명시한 채로 노출(분석 자체는 보여주되, "검토 시한 만료" 안내 표시)

---

## 24시간 타임아웃 워커 ("시한폭탄 워커")

- CEO가 최종적으로 `flags: ["low_confidence"]`가 포함된 `FitReport`를 반환하면,
  오케스트레이터는:
  1. DB에 `status: "pending_review"`로 저장
  2. BullMQ의 **delayed job**을 24시간 뒤로 예약 (큐: `hil-timeout`)

```typescript
// orchestrator/src/queue/hilTimeout.ts (스펙 예시)

await hilTimeoutQueue.add(
  "expire-pending-review",
  { fitReportId },
  { delay: 24 * 60 * 60 * 1000, jobId: `hil-timeout:${fitReportId}` }
);
```

3. 24시간 뒤 워커 실행 시, **DB의 현재 상태를 다시 조회**:
   - 여전히 `pending_review`이면 → `status: "expired"`로 변경
   - 이미 사람이 `approved`/`rejected`로 바꿔놨다면 → **아무 동작 없이 종료**
     (delayed job을 취소하지 않아도 안전하도록, 워커가 항상 최신 상태를 먼저 확인)

```typescript
new Worker("hil-timeout", async (job) => {
  const report = await db.fitReports.findById(job.data.fitReportId);
  if (report.status === "pending_review") {
    await db.fitReports.update(report.id, { status: "expired" });
  }
  // 그 외 상태면 사람이 이미 처리했으므로 아무 작업도 하지 않음
});
```

- 리크루터가 사람이 먼저 검토를 완료하면, delayed job을 명시적으로 취소(`job.remove()`)할
  수도 있지만 **필수는 아니다** — 위 idempotent 체크로 race condition을 방지하므로,
  취소 실패가 데이터 무결성에 영향을 주지 않는다.

---

## 웹 UI 연동 (Phase 3)

- `pending_review` 상태의 `FitReport`는 별도 "검토 대기" 목록에 노출
- 검토 화면에서 `techStack`/`experience`의 `AgentResult`(특히 `flags`, `evidence`)와
  CEO의 `ceoSummary`를 함께 보여줘 리크루터가 신뢰도를 판단할 근거를 제공
- `approved`/`rejected` 액션은 단순 상태 변경(추가 LLM 호출 없음) — 비용 정책과 무관

# 13. 남은 개발 진행서 (멀티 에이전트 루프) — 초안 2026-10-25

> 상태: **사용자 승인 대기**. 승인 전에는 어떤 웨이브도 시작하지 않는다.
> 판단 기준은 CLAUDE.md "프로젝트 취지"의 루프: 스카우트 건 → 후보 탐색 → 핏 분석 → 헤드헌터 승인(HIL) → 제안.
> 이 문서는 진행 순서와 에이전트 운용 규칙만 담는다. 항목별 상세는 08/09/11 원문을 따른다.

---

## 1. Cursor 정리본과 비교

Cursor 목록(A1~E6)은 대체로 사실과 맞는다. 다만 아래는 고치거나 보탤 것.

### 1-1. 틀렸거나 낡은 것

| Cursor 항목 | 실제 | 처리 |
|---|---|---|
| A7 n8n 워크플로 Import 미완 | 2026-10-25 **보류** 결정, 크롤러 연동 코드 삭제 ([12](12_n8n_on_hold.md), 11 v2-5) | 목록에서 제외 |
| B3 압축 왜곡 (미해결처럼 기술) | 09 에 대응이 이미 정해짐: `split_body_sections` 로 코드가 목록 분리, LLM 은 미분류 분류·skills·카드 요약만, 근무조건은 크롤 원본 필드 | B2(병합 스펙)에 흡수. 새 설계 불필요, **병합 때 지키기만** 하면 됨 |
| E2 "HIL SQL 번호가 없음" | 09 L161 "011=HIL" 이 낡은 문장. 실제 011/012 는 플랫폼 테이블/site_facts | 크롤 HIL SQL 은 **013 이후** 로 배정하고 09 문장 수정 |
| D3 GitHub MCP | CLAUDE.md 판단 규칙상 루프 단계를 한 줄로 못 대면 보류 | "보류"로 확정 (Cursor 는 판단 미정으로 둠) |

### 1-2. Cursor 가 빠뜨린 것

| # | 항목 | 근거 | 왜 중요 |
|---|---|---|---|
| N1 | **더미 후보자 데이터** | 루프의 "후보 탐색"은 `profiles` 가 있어야 돈다. Cursor 의 A 는 JD(공고) 쪽만 다룸 | 스카우트 건(C)을 테스트하려면 후보 더미가 JD 더미만큼 필요. 현재 행 수 미확인 |
| N2 | Session pooler `ConnectionTimeout` | 11 #6: 2026-10-24 이 PC 에서 직결 실패 | A3(platform-load 재적재)·A4 의 **선행 블로커**. Cursor 는 "재적재 안 함"만 적음 |
| N3 | 미결 결정 3건 | CLAUDE.md 재설계 미결: 더미 물량 · 본문 저장 범위 · `CRAWLER_CONTACT` | A4 본수집 전에 사람이 정해야 함 |
| N4 | v2-2 검색(pg_trgm·임베딩) | 08 "다음에 할 일" 4번, 11 v2-2 | 스카우트 건의 후보 탐색 품질. 사전필터(코드) 강화 = 토큰 원칙과 직결 |
| N5 | `MCP_INTERNAL_KEY` 값, `CORS_ALLOWED_ORIGINS` | 11 #4, #5 | 배포 전 필수. 개발 중엔 낮음 |

---

## 2. 통합 남은 항목 (루프 단계 매핑)

| ID | 항목 | 루프 단계 | 우선 |
|---|---|---|---|
| **D0** | 미결 결정: 더미 물량 / 본문 저장 범위 / `CRAWLER_CONTACT` / 후보 더미 확보 방식 | 전제(데이터) | 사용자 |
| W1-a | 문서 정리: 09 §1 옛 경로, 09 L161 번호, 08 "다음에 할 일", 08↔10 env 통합 (E1·E2·E3·E4) | 전제 | 높음 |
| W1-b | DB 직결 복구: pooler timeout 원인(N2) → `platform-load` 로컬 재적재로 10행 body 누락 보정 (A3) | 전제(데이터) | 높음 |
| W2-a | `saramin_postings → job_postings` 병합 스펙+구현 (A5·B2·B3). 필드 매핑, `job_posting_id` 채움, 이미지형 `needs_review` 제외 규칙 | 핏 분석 입력 | 🟡 2026-10-25 검수 화면(/crawling)과 함께 코드 완료, 013 적용·API 실데이터 확인 ✅ — 화면 로그인 후 확인·병합 남음 |
| W2-b | `/v1/trigger` → 웹 수집 모듈(`platforms/saramin.py`)+gate 연결 (A1·A6·A12). `saramin_api.py` 는 2026-10-25 삭제 완료 — 지금 트리거는 `site` 만 받는다 | 데이터 수집 | 높음 |
| W2-c | 후보 더미 준비 (N1). D0 결정에 따라 시드 스크립트 또는 기존 profiles 확인 | 후보 탐색 입력 | 높음 |
| W3 | 100건 본수집 실행 + 검수 리포트 (A4). 선택: 직군 `site_code` 검증 (A8) | 데이터 | 높음 (실행은 사용자 승인) |
| W4 | E2E: 크롤 JD 선택 → 분석 → Fit Report (B1). 품질 샘플 대조 | 핏 분석 | 최상 (게이트) |
| W5-a | 스카우트 건 엔티티: `jd_runs` 확장 SQL(013) + API (C1) | 스카우트 입력 | 높음 |
| W5-b | 수시 트리거: 새 후보 가입 → 열린 건 재매칭, BullMQ 잡 (C2) | 수시 트리거 | 중 |
| W5-c | 제안 실행: 승인된 `sourcing_actions` → 제안 발송 (C3). 실제 발송 채널은 사용자 결정 | 제안/알림 | 중 |
| W5-d | talentfolio Bearer 전송 → `AUTH_MODE=legacy` 제거 (C4) | 승인 게이트 보안 | 높음 |
| W6 | 검색 고도화 pg_trgm·임베딩 (N4) | 후보 탐색 | 중 |
| X | 외부 설정(사용자 작업): Slack Interactivity+터널 (D1), Notion App (D2), 키 값 (N5) | HIL/제안 | 사용자 |
| Z | 후순위: 어드바이저 성능(E5), 구 DB 이전 확인(E6), 추가 사이트(A9), 검수 UI(A11), 공공 API(A10, 필요 시), GitHub MCP(D3 보류) | — | 낮음 |

---

## 3. 개발 순서 (의존 그래프)

```
D0(사용자 결정) ─┬─────────────────────────┐
                 │                          │
W1-a 문서정리 ───┤   W1-b DB 직결 복구 ─────┤
                 ▼                          ▼
        W2-a 병합(job_postings)      W2-b 트리거↔웹수집     W2-c 후보 더미
                 │                          │                    │
                 │                          ▼                    │
                 │                  W3 100건 본수집(승인)         │
                 └──────────────┬───────────┘                    │
                                ▼                                │
                      W4 E2E 핏 분석 게이트 ◄────────────────────┘
                                ▼
                 W5-a 스카우트 건 엔티티 ──► W5-b 수시 트리거
                                │        └─► W5-c 제안 실행
                 W5-d Bearer (W4 와 무관, 언제든 병렬 가능)
                                ▼
                         W6 검색 고도화 → Z
```

- **W4 는 하드 게이트**: 크롤 JD 로 Fit Report 가 정상 생성되기 전에는 W5 를 시작하지 않는다 (구현 순서 원칙: 더미 → 스카우트).
- W5 는 신규 시스템 금지. `jd_runs`/`fit_reports`/`sourcing_actions` 확장으로만.

---

## 4. 루프 엔지니어링 운용

### 4-1. 역할 (에이전트)

| 역할 | 실행 형태 | 쓰기 권한 | 책임 |
|---|---|---|---|
| **Lead** | 메인 세션 (사용자와 대화) | 이 문서, 티켓 발행 | 웨이브 시작/종료, 게이트 판정, 사용자 에스컬레이션 |
| **Spec** | Plan 서브에이전트 | 없음 (읽기 전용) | 티켓별 스펙: 변경 파일, 수용 기준, 테스트 명령 |
| **Builder-PY** | 세션(worktree) | `crawler/` 만 | W1-b, W2-b, W3 |
| **Builder-TS** | 세션(worktree) | `orchestrator/`, `mcp-server/`, `shared/` | W2-a(코드), W4 수정, W5-b/c |
| **Builder-SQL** | 세션(worktree) | `docs/architecture/sql/` 신규 번호 파일만 | W2-a(SQL), W5-a, W6 |
| **Builder-TF** | 세션 (talentfolio 레포) | `test1-main/talentfolio` | W5-d, W2-c(시드 시) |
| **Verifier** | 서브에이전트 | 없음 | 테스트 실행(pytest / tsc / 기존 스크립트), 수용 기준 대조, 결과만 보고 |
| **Reviewer** | `/code-review` 또는 서브에이전트 | 없음 | 헌법 3조항(@google/genai·responseJsonSchema / 큐 논블로킹 / prune 선행) 위반 검사 |
| **Doc-keeper** | Lead 가 겸임 | **08·09·11 단독 쓰기** | 티켓 종료 시 상태표 갱신 |

**충돌 방지 규칙** (CLAUDE.md "같은 지침을 두 세션에 동시에 넣지 말 것" 준수)
1. 한 디렉터리 영역은 동시에 Builder 1명만. 08/09/11 은 Doc-keeper 만 쓴다.
2. 같은 재설계 항목은 한 티켓·한 세션에서만 진행한다.
3. SQL 번호는 Lead 가 발행 시점에 예약한다 (013, 014 …). Builder 가 임의 번호 금지.

### 4-2. 티켓 1개의 루프

```
[Spec] 스펙+수용기준 ─► [Builder] 구현 ─► [Verifier] 테스트·기준 대조
                              ▲                    │ 실패
                              └──── 피드백(실패 로그 요약) ◄┘
                                                   │ 통과
                                          [Reviewer] 헌법 검사
                                                   │ 위반 → Builder 로 1회 반환
                                                   ▼ 통과
                                   [Lead] 게이트 판정 → Doc-keeper 갱신 → 종료
```

- **반복 상한**: Builder↔Verifier 3회, Reviewer 반환 1회. 넘으면 중단하고 사용자에게 보고 (운영 규칙 "재작업 1회" 정신을 개발 루프에도 적용).
- **피드백은 요약만**: 실패 로그 원문 대신 "실패 테스트명 + 핵심 에러 3줄" 을 넘긴다 (토큰 원칙).
- **종료 조건은 측정 가능해야 함**: 예) W2-a "`select count(*) from fit.job_postings` ≥ 9, `saramin_postings.job_posting_id is null and review_status='ok'` = 0".

### 4-3. 사람 승인이 필요한 지점 (자동 진행 금지)

| 지점 | 이유 |
|---|---|
| D0 결정 전체 | 데이터 범위·법적 조건 |
| 원격 Supabase 에 SQL 적용 | 되돌리기 어려움 |
| 실제 사이트 크롤 실행 (W3, 10건 초과) | 09 법적 조건, 외부 트래픽 |
| Slack/메일 등 실제 발송 (W5-c) | 외부 송신 |
| 웨이브 게이트 W4 통과 판정 | 품질 판단은 사람 |

### 4-4. 병렬 가능한 묶음

| 웨이브 | 동시 실행 | 비고 |
|---|---|---|
| W1 | W1-a(Lead) ∥ W1-b(Builder-PY) | 파일 겹침 없음 |
| W2 | W2-a(Builder-SQL→TS) ∥ W2-b(Builder-PY) ∥ W2-c(Builder-TF) ∥ W5-d(Builder-TF 와 순차) | W2-c 와 W5-d 는 같은 레포라 순차 |
| W3~W4 | 단일 흐름 | 게이트 |
| W5 | W5-a 먼저 → W5-b ∥ W5-c | b/c 모두 a 의 스키마 필요 |

---

## 5. 웨이브별 수용 기준 (요약)

| 티켓 | 완료 기준 |
|---|---|
| W1-a | 09 §1 이 JSON→`saramin_postings` 경로 기준, 08 "다음에 할 일" 최신화, env 는 10 한 곳만 정본 |
| W1-b | 로컬에서 `platform-load` 성공, 10행 body 누락 0 |
| W2-a | 병합 함수 테스트 통과, `GET /api/job-postings` 에 크롤 JD 노출, 근무조건은 원본 필드·업무/자격은 배열 |
| W2-b | `/v1/trigger` 가 웹 모듈 호출, pytest 전체 통과 (`saramin_api` 참조 0 은 달성) |
| W2-c | 분석 대상 후보 ≥ D0 에서 정한 수 |
| W3 | 100건 적재, 리포트(ok/needs_review/retry 비율) |
| W4 | 크롤 JD 3건 × 후보 N명 Fit Report 생성, 호출 상한(후보당 ≤5) 준수, 샘플 원문 대조 왜곡 0 |
| W5-a | 스카우트 건 생성→후보 매칭→`sourcing_actions` 대기열까지 API 로 재현 |
| W5-b | 신규 후보 이벤트 → 열린 건 재매칭 잡 enqueue (HTTP 논블로킹) |
| W5-c | 승인된 액션만 발송, 미승인 발송 0 (테스트로 증명) |
| W5-d | talentfolio 요청에 Bearer, orchestrator `AUTH_MODE=required` 로 정상 동작 |

---

## 6. 승인 시 첫 액션

1. 사용자: D0 4개 결정 답변.
2. Lead: W1-a 시작 + Builder-PY 세션으로 W1-b 시작 (병렬).

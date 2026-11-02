# 18. 라이프 로그(일기 + 포트폴리오 + AI) 도입 설계 — 갭 분석 (2026-10-27)

> 제품 방향·근거: [docs/portfolio_insights.md](../portfolio_insights.md) 1·2번.
> 핵심 결정: **비공개 기록은 본인용 AI에만, 기업 매칭은 사용자가 직접 가공·공개한 것만.**
> 판단 규칙(CLAUDE.md): 루프 = 스카우트 건 → 후보 탐색 → 핏 분석 → HIL → 제안. 라이프 로그는 이 루프의 **후보 데이터 품질(입력)** 을 개선한다.

## 1. 지금 있는 것 → 재사용

| 이미 있는 것 | 위치 | 라이프 로그에서의 역할 |
|---|---|---|
| 핏 분석 에이전트 `analyze_tech_stack` / `analyze_experience` / `analyze_culture_fit` | mcp-server | 공개 증거 카드를 입력으로 받아 근거 인용 리포트 (캔버스 ①②⑤ → experience, ③ → culture_fit) |
| `parse_jd` + 코드 사전필터 + 배치 정밀 분석 (M1) | mcp-server / talentfolio | 공고 쪽 정형화 — 그대로 |
| RAG: `portfolio_chunks`(pgvector), `embed_and_index_portfolio`, `search_portfolio_chunks`, `answer_portfolio_question` | Phase 5 | 공개 카드 임베딩·검색. 비공개 기록용 **별도 인덱스**로 확장 |
| BullMQ 큐/워커, SSE, 캐싱, Sentry, Langfuse | orchestrator | 대화 종료 후 구조화 잡, 임베딩 잡 |
| prune/정규화 어댑터 (헌법 3조) | 02 문서 | 대화 원문 → 요약 기억·카드 후보로 줄여서 LLM 투입 |
| `search_candidates` + `sourcing_actions` HIL + Slack | Phase 5 / M2 | 공개 카드 기반 후보 탐색 → 헤드헌터 승인 — 그대로 |
| `candidate_assessments` → Notion | M4 | 근거 카드 링크 포함해 동기화 |
| talentfolio `profiles`, `/studio`, `/talent/[id]`, `/api/chat/gemini`, `conversations`/`messages`(사용자 간 DM) | talentfolio | 프로필·편집 화면 재사용. AI 대화는 신규 (기존 DM 테이블과 분리) |

## 2. 새로 필요한 것

### A. 데이터 (SQL — 원격 적용은 사용자 승인)
| 테이블 | 핵심 컬럼 | 공개 |
|---|---|---|
| `life_sessions` | user_id, started_at, ended_at, mode(text/voice), summary_status | 본인만 |
| `life_messages` | session_id, role(user/ai), content, audio_ref?, created_at | 본인만 (원문) |
| `activities` | user_id, kind(개인/단체 × 프로젝트/활동/실무/학습/기타), period, role, members_count, status(draft/ready) | 본인만 |
| `activity_drafts` | activity_id, canvas_slot(1~6), text, **quotes[](원문 메시지 id 인용)**, ai_edited bool | 본인만 |
| `evidence_cards` | user_id, activity_id, claim, evidence_links[], **trust_level**(확인됨/첨부/본인주장), **recorded_at**(활동 당시), published_at, visibility(private/public) | **public 만 기업 노출** |
| `user_memory` | user_id, profile_summary, open_threads, tone — 대화 일관성용 요약 기억 | 본인만 |
| `peer_confirmations` | card_id, confirmer_user_id, status | 카드 공개 시 함께 |
| `consents` | user_id, purpose(self_ai / matching), version, agreed_at | — |

- **RLS가 정책의 본체**: `life_*`·`activities`·`activity_drafts`·`user_memory` 는 `user_id = auth.uid()` 만. 기업/헤드헌터 역할·orchestrator 매칭 경로는 `evidence_cards where visibility='public'` 만 읽는 **전용 뷰**로 접근 (service_role 직접 조회 금지).
- 임베딩: 공개 카드 → 기존 `portfolio_chunks` 계열 / 비공개 기록 → 별도 인덱스(본인 코칭 검색 전용). 두 인덱스를 섞지 않는다.

### B. 대화형 기록 (talentfolio + orchestrator)
1. **대화 API** — 스트리밍 응답(텍스트), 음성은 STT → 같은 경로. 빠른 중간급 모델(지연 목표: 첫 토큰 ~1s).
2. **대화 설계(프롬프트)** — 6칸 캔버스를 상황에 맞게 꺼내는 질문 정책, **유도 질문 금지**, 사실을 묻는 열린 질문. `user_memory` 만 컨텍스트로 넣는다(전체 기록 X).
3. **세션 종료 잡(BullMQ, 헌법 2조)** — 대화 원문 → prune → `responseJsonSchema` 로 활동 후보·캔버스 칸별 초안(원문 인용 필수)·요약 기억 갱신 (헌법 1조). 사용자당 세션 1회 LLM.
4. **알림 트리거** — 활동 종료일·프로젝트 마감에 "어땠어요?" (매일 강요 X).

### C. 기록 → 포트폴리오 (사용자가 전적으로 결정)
1. **기록함 화면** — 대화·활동 목록, AI 초안. 사용자가 골라 가공.
2. **카드 편집기** — 초안 수정, 증거 첨부, AI 교정은 버튼으로만(교정 표시), 하지 않은 말은 AI가 추가 못 함.
3. **공개 버튼** — 이때만 `visibility=public`, `published_at` 기록. 카드에 `recorded_at` 배지("활동 당시 작성").
4. **동료 확인** — 단체 활동 카드에 함께한 사람 초대 → 확인 시 trust_level 상향.
5. **자동 이력서/프로필** — 공개 카드에서 생성 (talentfolio `/talent/[id]`).

### D. 기업 쪽 매칭 (기존 루프 개선)
1. `search_candidates` 입력을 `profiles` + **공개 카드 뷰**로 확장 (코드 사전필터 → 벡터 검색 → 상위 N만 LLM, 운영 규칙 1·3).
2. 핏 분석 에이전트 프롬프트: 카드 id 인용 의무 → FitReport 근거에 카드 링크. 검증 규칙(validation.ts)에 "인용 카드가 실제 공개 카드인지" 추가.
3. HIL 화면·Slack 카드에 trust_level·기록 시점 표시.
4. **구직자 쪽 설명**: "이 공고에 추천됨 — 근거 카드 3장" 본인 화면 + 추천 제외 옵션 (개인정보보호법 제37조의2 대비).

### E. 안전장치
- 민감정보(건강·가족·종교 등) 감지 시: 비공개 유지 권고, 공개 카드 편집기에서 경고. (매칭엔 애초에 비공개가 안 들어가므로 1차 방어는 구조)
- 동의 2종 분리(`self_ai`, `matching`), 탈퇴·삭제 시 대화 원문·임베딩 삭제.
- 음성 파일 보관 기간 정책 (STT 후 삭제 기본).
- Langfuse 트레이싱에 비공개 원문 마스킹 (06 문서 확인 필요).

## 3. 단계 제안
| 단계 | 내용 | 루프 개선 한 줄 |
|---|---|---|
| L0 | 스키마(A) + RLS + 동의 — 승인 후 SQL | 후보 데이터의 공개 경계를 DB가 강제 |
| L1 | 텍스트 대화 + 세션 종료 구조화 잡 + 기록함 (B1~3, C1) | 후보 원천 데이터 생성 |
| L2 | 카드 편집·공개·배지 (C2~3, C5) | 공개 신호 품질 ↑ |
| L3 | 매칭 연결 (D1~3) | 후보 탐색·핏 분석이 근거 카드 인용 |
| L4 | 음성, 알림, 동료 확인, 구직자 설명 화면 (B1 음성, B4, C4, D4) | 신뢰도·유입 ↑ |

## 4. 결정 필요 (사용자)
- 대화 모델 선택 (Gemini Flash 계열 vs Claude Haiku 계열 — 헌법 1조는 Gemini SDK 규칙만 정함, 지연·품질 실측 후 결정).
- 작업 위치: 대화·기록 UI는 talentfolio, 구조화·매칭 잡은 orchestrator (현 분담 유지) — 확인.
- 음성 도입 시점 (L1 포함 여부).

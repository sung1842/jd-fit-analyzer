# 19. 앱(일기) / 웹(이력·구직) 분리 — 서비스 기획·설계 (2026-10-27)

> 근거: [portfolio_insights.md](../portfolio_insights.md) 1·2번, 갭 분석: [18](18_life_log_design.md).
> 결정: **일기 = 모바일 앱(이번엔 분리·계약만, 구현 X)**, **이력·포트폴리오·구직·기업 매칭 = 웹(talentfolio)**. 목표는 빠른 마무리.
> 루프 개선 한 줄: 후보 데이터를 "꾸미기 어려운 증거 카드"로 바꿔 후보 탐색·핏 분석·HIL 판단의 입력 품질을 올린다.
> 작성 방식: 에이전트 팀(연구 근거 기획자 · 코드 매핑 설계자 → 리뷰어) 루프.

## 1. 앱 vs 웹 경계

| 앱 (나중) | 웹 (지금) |
|---|---|
| 대화형 AI 일기(6칸 캔버스 질문, 유도 질문 금지), 음성, 알림, 기록 열람 | 간이 기록 입력, 기록함, 카드 편집·공개, 공개 포트폴리오, 구직 관리, 추천 설명·제외, 헤드헌터 매칭/HIL |

**계약 원칙**: 앱은 Supabase 테이블 + orchestrator `/api/v1/life/*` 에만 붙는다. talentfolio 내부 코드에 의존하지 않으므로 앱이 붙어도 웹은 안 바뀐다.
- 인증: Supabase Auth 단일(`auth.uid()`), orchestrator 는 Supabase JWT 검증(`orchestrator/src/lib/auth.ts` 확장), 앱·웹 같은 Bearer.
- `life_sessions.source` = `app | web | import` 를 처음부터 둔다.
- 요청/응답 Zod 스키마를 `orchestrator/src/lib/schemas.ts` 에 모아 계약 문서로 쓴다.

## 2. 연구 → 기능 (MVP 범위)

| 기능 | 위치 | 근거 연구 | 지표 |
|---|---|---|---|
| 공개 경계 강제(RLS + `public_evidence_cards` 뷰) + 동의 2종(`self_ai`/`matching`) | DB | 개인정보보호법 제37조의2·민감정보 | 매칭 경로의 비공개 접근 0건 |
| 6칸 질문 정책 + 원문 인용 초안(문장마다 메시지 id) | 앱(웹 간이 입력 공용 잡) | Sackett 2022 구조화 면접 / Cui·Dias·Ye 2025 | 인용률 100%(검증), 칸 채움 수 |
| 카드 편집기: 직접 편집 + **AI 교정 버튼만** + "AI 교정" 라벨(숨김 불가) | 웹 | Wiles·Munyikwa·Horton(+8%) / Galdin & Silbert | 교정 사용률, 편집 시간 |
| 기록 시점 배지(`recorded_at`, 수정 불가) | 웹 | Spence 신호 | 배지 카드 비율·제안 전환 |
| 신뢰 등급(본인주장 → 첨부 → 확인됨) | 웹 | Spence / Marlow & Dabbish | 등급 분포·승인률 |
| 공개 카드 → 자동 공개 프로필 | 웹 | Pallais 2014 | 공개 카드 수 vs 제안 수 |
| FitReport 가 카드 id 인용(검증 규칙) + HIL 에 등급·배지 | 웹(기업) | Harvard/Burning Glass 2024 | 인용 카드 클릭률 |
| 추천 설명("근거 카드 3장") + 추천 제외 | 웹(구직자) | 제37조의2 | 제외 처리 시간 |

**후순위**: 음성·알림(앱), 동료 확인, 공고별 카드 선택·순서(새 문장 생성 X), "부족한 증거" 안내, 칸별 비교 뷰, 민감정보 자동 감지, 지표 대시보드.

**하지 말 것**: AI 대필·공고 맞춤 재작성 / 사용자가 안 한 말·수치 추가 / 유도 질문 / 기록 시점 수정·배지·라벨 숨김 / 비공개 일기로 점수·매칭 / 피드·좋아요 소셜 / 학위·스펙 필터만의 매칭 / HIL 생략 자동 접촉.

## 3. 데이터 (SQL — 원격 적용은 사용자 승인)
18 문서 A 의 8개 테이블 + `life_sessions.source` + 뷰 `public_evidence_cards`(visibility='public' **이고 유효한 `consents.purpose='matching'` 이 있는 사용자만**, 컬럼 id·user_id·claim·trust_level·recorded_at·source·links·ai_edited 만 노출). 기존 `conversations/messages`(사용자 간 DM)와 섞지 않는다. 마이그레이션 위치는 `docs/architecture/sql/015_life_log.sql`.

## 4. API·잡 (orchestrator)
| 엔드포인트 | 동작 | 헌법 |
|---|---|---|
| `POST /api/v1/life/sessions` | 세션 생성 | — |
| `POST /api/v1/life/sessions/:id/messages` | 대화 턴(스트리밍, `user_memory` 요약만 컨텍스트) — 앱 전용, 웹 MVP 미사용 | 1조 SDK 규칙 |
| `POST /api/v1/life/sessions/:id/close` | 202 + jobId → `life-structure` 큐 | 2조 |
| `GET /api/jobs/:jobId/stream` | 기존 SSE 재사용 | — |
| `GET /api/v1/life/drafts` · `PATCH /api/v1/life/cards/:id` · `POST /api/v1/life/cards/:id/publish` · `POST .../polish`(교정) | 기록함·카드 | 교정도 잡 또는 짧은 단일 호출 + 스키마 |

- `lifeSessionWorker.ts`: `lifePrune.ts`(롤 태그·중복 제거·메시지 id 유지·길이 상한, 3조) → `ai.models.generateContent({ config: { responseJsonSchema } })`(1조) → 활동 후보·칸별 초안(quotes 필수)·`user_memory` 갱신. 세션당 LLM 1회. 인용 id 가 세션에 없으면 해당 문장 폐기(코드 검증).
- 공개 시 임베딩 잡(`embedAndIndexPortfolio` 재사용), 비공개 인덱스와 분리.
- **교정(polish)도 202 + jobId 잡**(2조). 스키마 `{polished, changedSpans}`, 결과의 수치·고유명사·주장이 원문에 없으면 폐기(코드 검증). `ai_edited=true` 는 서버만 세팅(PATCH 로 변경 불가).
- **대화 턴 스트리밍**은 2조의 예외(도구 루프 없는 단일 짧은 호출)로 08/11 문서에 등재 후 사용.
- `recorded_at` = DB default `now()` + UPDATE 차단 트리거. `source=web` 카드 배지는 "회고 입력(입력일 기준)"으로 "활동 당시 작성"과 구분.
- **철회** `POST /api/v1/life/cards/:id/unpublish` 와 `matching` 동의 철회 → 같은 무효화 잡: 임베딩 삭제, 해당 후보 Redis 캐시 키 무효화, 기존 FitReport/브리프의 인용을 "비공개 전환됨"으로 마스킹.
- `lifeSessionWorker` 의 Langfuse 트레이스·Sentry 이벤트에서 원문 마스킹.
- **사용자 토큰 만료**: structure/polish 잡은 사용자 access token(RLS)을 잡 데이터에 싣는다(성공 시 즉시 삭제). 실행 시 JWT 가 만료돼 DB 호출이 실패하면 재시도 없이 잡 실패 사유 `token_expired` 로 남기고 Sentry 로 보내지 않는다 — 클라이언트는 재로그인 후 같은 요청을 다시 보낸다. 공개(`life-publish`: 공개 뷰 카드만 임베딩 `source_field=evidence_card:<id>` + fit 캐시 무효화)·철회 잡은 토큰을 쓰지 않는다.

## 5. 웹 화면 (talentfolio)
| 화면 | 구분 | 경로 |
|---|---|---|
| 간이 기록 입력(회고 붙여넣기 + 종류·기간·역할 → close 잡) | 신규 | `src/app/studio/log/page.tsx` |
| 기록함 + 카드 편집기 + 공개 | 신규 | `src/app/studio/cards/page.tsx` |
| 스튜디오 진입 링크·공개 카드 섹션 | 수정 | `src/app/studio/page.tsx` |
| 공개 포트폴리오 배지 | 수정 | `src/app/talent/[candidateId]/page.tsx`, `src/lib/getCandidate.ts` |
| 브리프 근거 카드 링크 | 수정 | `src/app/brief/[candidateId]/page.tsx`, `src/lib/briefReport.ts` |
| 추천 내역 + 제외 | 신규 | `src/app/studio/matches/page.tsx` |
| 구직(공고 탐색)·헤드헌터 HIL | 재사용 | `discover`, `sourcing`, `sourcing/review`, `desk` |

## 6. 매칭 연결 (mcp-server / orchestrator)
`searchCandidates.ts`·`getCandidatePortfolio.ts` 가 공개 카드 뷰를 claim·trust·id 만 map 해서 투입(3조) → `analyzeExperience`/`analyzeCultureFit` 프롬프트에 카드 id 인용 의무 → `orchestrator/src/validation.ts` 에 "인용 id ∈ 해당 후보 공개 카드" 규칙(위반 시 기존 재작업 1회 루프, 그래도 위반이면 해당 근거 폐기).
- 매칭 경로는 **뷰만** 조회. service_role 로 `evidence_cards`·`life_*`·`user_memory` 직접 조회 금지(`user_memory` 는 공개/비공개 혼합 요약이라 tool·brief 에 절대 넣지 않음).
- 카드 투입 상한: 후보당 상위 N장(기본 8), claim 길이 상한(3조). 기존 `profiles` 경로의 prune 은 그대로.

## 7. 구현 순서
| 단계 | 내용 | 규모 |
|---|---|---|
| S0 | SQL 015 + RLS + 뷰 (**승인 후 적용**) | SQL 1 |
| S1 | 헌법 1조 위반 해소: talentfolio `src/app/api/chat/gemini/route.ts` REST fetch → `@google/genai` | 수정 1~2 |
| S2 | life API 계약 + JWT | 신규 1, 수정 3 |
| S3 | `life-structure` 잡 + prune | 신규 2, 수정 2 |
| S4 | 웹 간이 기록 + 카드 편집·공개 | 신규 2, 수정 1 |
| S5 | 포트폴리오·브리프 배지 | 수정 4 |
| S6 | 매칭 카드 인용 + 검증 | 수정 4~5 |
| S7 | 추천 내역·제외 | 신규 1, 수정 1 |

완료 기준: 웹에서 회고 입력 → 초안(인용 포함) → 편집·공개 → 헤드헌터 소싱에서 그 카드가 FitReport 근거로 인용되고 HIL 화면에 배지가 보임. 추가 수용 테스트:
1. RLS: 헤드헌터 역할 JWT 로 `life_*`·private 카드·`user_memory` SELECT → 0행. mcp-server tool 응답에 private 카드 id 없음 단언.
2. `matching` 미동의 사용자 카드 → 매칭 0건.
3. 철회 후 매칭·브리프·캐시·임베딩 0건.
4. 인용 id 위반 → 재작업 1회 후 폐기.
5. `recorded_at`·`ai_edited` 변경 시도 거부.
6. 추천 제외가 다음 소싱에 반영.
7. LLM 상한 준수(세션 구조화 1회, 후보당 5회).

## 8. 주의
- 근거 연구 대부분은 미국·프리랜서 플랫폼, Cui 2025 는 동료심사 전 → 지표는 국내 1~7년차 IT 대상 **재검증용**.
- 남은 결정: 앱 대화 모델(실측 후), 앱 기술 스택(Expo/React Native 권장 — Supabase Auth 공유 쉬움).

## 9. 구현 상태 (2026-10-28)
- S0~S7 코드 완료 (에이전트 팀 4개 병렬 → 통합 1라운드 → 검증·리뷰 2라운드 → 수정 3라운드).
- 추가: 동의 UI·철회(`POST /api/v1/life/consents/:purpose/revoke` → 공개 카드 unpublish 잡), life-publish 임베딩 잡, Sentry access_token 마스킹, `ai_edited` true→false 차단 트리거.
- 검증: orchestrator tsc + 테스트 40/40, mcp-server tsc + 10/10, talentfolio tsc + 변경 범위 eslint 0. (talentfolio 전체 lint 는 기존 파일 23건으로 실패 — 범위 밖)
- **미완료**: SQL 015 원격 적용(사용자 승인 필요, Supabase Exposed schemas 에 `fit` 필요), 실 DB 수용 테스트 7절 1·3·6, 브라우저 E2E.
- 2026-10-28 SQL 015 원격 적용 완료. 실 DB 수용 테스트 7/7 통과(롤백), `fit` REST 노출 확인.
- 2026-10-28 브라우저 E2E 통과: 회고 입력 → 동의 → 구조화(6칸·인용) → AI 교정(`ai_edited`) → 공개(뷰·임베딩) → `/talent` 배지 → 핏 분석 카드 인용 → 추천 내역 → 공개 철회(뷰·임베딩·캐시 0). 테스트 데이터 삭제.
  - E2E 중 수정: ① `gemini-2.5-flash` 신규 키 404 → `gemini-3.8-flash`(life 구조화·mcp 폴백·talentfolio 채팅) ② SSE 실패 사유 원문 노출 → 일반 문구(`sse.ts publicFailReason`) ③ 교정 후 편집 버퍼 미갱신으로 공개 버튼 잠김 → CardEditor key 에 claim 포함 ④ mcp-server 가 공개 카드 뷰·`match_exclusions` 를 public 스키마 anon 클라이언트로 조회해 항상 빈 결과(제외 미적용) → fit `db` 클라이언트.
  - 미검증: 동의 철회 UI(사용자 본인 조작 필요), API 직접 분석 시 jdHeadline 미표시("제목 없는 공고").

## 스튜디오 실데이터 연결 (2026-10-28, SQL 016 원격 적용)

- `/studio` 정적 목업 → React (`talentfolio/src/components/studio/Studio*.tsx`, 데이터 `studioData.ts`). 탭: 개요·프로필·나를 보여주기(근거 카드)·자기소개서·공고. "기업에게 보이는 화면" = 공개 항목만 남긴 미리보기.
- 이력서·자기소개서·문항·핀은 Supabase `fit` 스키마를 사용자 토큰으로 직접 CRUD (RLS 본인). 카드 공개/철회만 orchestrator `/api/v1/life/*` (임베딩·캐시 잡).
- SQL 016: `resume_basics`(public_fields 로 필드별 공개) · `resume_experiences/educations/certifications(자격·어학)/misc` · `cover_letters`(base 사용자당 1개, 첫 방문 시 기본 문항 3개로 생성) · `cover_letter_items`(근거 카드 id) · `posting_essay_questions`(사람이 기업 채용 홈페이지를 보고 입력, 자동 수집 안 함 — 자소설닷컴 약관 금지행위 9호 확인) · `job_pins` · `job_postings` 필터 컬럼. 공개 뷰 `public_resumes`·`public_cover_letters` (공개 항목 + matching 동의, 연락처·생년·병역 제외).
- 공고 필터: 수집처 검색 필터 기준 직군 대분류 21개·경력·학력·고용형태·지역·급여 공개. 값은 orchestrator `lib/postingFacets.ts` 코드 규칙(병합 시 자동, 기존 행은 `scripts/backfillPostingFacets.ts`). 수집 단계 직군 연결이 0건이라 직군은 제목·기술 키워드로 추정.
- JD 분석: `get_candidate_portfolio` 가 공개 카드에 더해 공개 이력서·공개 기본 자기소개서를 prune 해서(`mcp-server/src/lib/publicResume.ts`, 경력 5·학력 3·자격 8·문항 3, 글자 상한) `resume` 필드로 넣는다. analyze_experience 프롬프트가 이를 비교 대상으로 쓴다.

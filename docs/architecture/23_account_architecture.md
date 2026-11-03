# 23. 계정 아키텍처 — 구직자(seeker) / 기업(company)

> 작성 2026-11-03. talentfolio `feat/account-auth` 브랜치(커밋 11b617a·5cb97f4·37d29a9) 기준.
> 목적: 여러 작업이 동시에 들어오며 생긴 **인증·권한·데이터 경계의 빈틈**을 한 장에 모은다.
> 루프 단계: "후보 탐색 → 핏 분석 → HIL 승인 → 제안" 전 단계의 **누가 무엇을 할 수 있나**를 정한다.

---

## 1. 공통 기반

| 층 | 무엇 | 위치 |
|---|---|---|
| 신원 | Supabase Auth (이메일+비밀번호). 토큰 = Supabase JWT | talentfolio Supabase 프로젝트 |
| 세션 저장 | **쿠키** (`@supabase/ssr` `createBrowserClient`) | `talentfolio/src/lib/supabase.ts` |
| 계정 유형 | `auth.users.app_metadata.account_type` = `seeker` \| `company` (서비스 롤만 쓰기 가능, JWT 에 실림) | `talentfolio/src/lib/accountType.ts` |
| 가입 | `POST /api/auth/signup` → 서비스 롤 `admin.createUser` (유형·직군 기록) | `talentfolio/src/app/api/auth/signup/route.ts` |
| 화면 가드 | Next 16 `proxy.ts` — 비로그인은 `/`·`/login`·`/signup` 만, 로그인 후 유형별 구역 | `talentfolio/src/proxy.ts` |
| API 인증 | orchestrator `authGate` — Bearer JWT 를 JWKS 로 검증. `AUTH_MODE=legacy` 면 토큰 없을 때 body/query `userId` 신뢰 | `orchestrator/src/lib/auth.ts` |
| 데이터 | `public.profiles`(talentfolio), `fit.*` 스키마(jd_runs·fit_reports·sourcing_actions·life_*·resume_*), Storage `evidence`(본인 폴더 RLS) | SQL `docs/architecture/sql/` |

```
브라우저 ──쿠키──▶ talentfolio :3000 (proxy.ts: 화면 가드)
   │                      └─ /api/auth/signup (서비스 롤)
   └─Bearer(일부만)──▶ orchestrator :3001 (authGate: 로그인 여부만, 유형 검사 없음)
                              ├─ BullMQ/Redis → mcp-server :3002 → Gemini / CEO(Claude)
                              └─ Supabase (서비스 롤 또는 사용자 RLS 클라이언트)
```

---

## 2. 구직자(seeker) 측

**화면 구역**: `/studio/**` (개요·프로필·나를 보여주기·자기소개서·공고, `/studio/log`·`/cards`·`/matches`)

| 기능 | 화면 → API | 데이터 | 인증 방식 |
|---|---|---|---|
| 프로필(기본정보·이력) | StudioProfile → Supabase 직접 | `fit.resume_*` | 사용자 RLS |
| 프로필 사진 | StudioProfile → `/api/profile/photo` | 공개 버킷 `avatars/<uid>/`, `profiles.avatar_url` | 쿠키 세션 + 서비스 롤 |
| 이력서 PDF | ResumePrint (인쇄 전용) | 위 데이터 | — |
| 기록·근거 카드 | `lifeFetch` → `/api/v1/life/*` | `fit.life_*`, `evidence_cards` | Bearer + 사용자 RLS (`requireUserToken`) |
| 동의(self_ai·matching)·추천 제외 | `/api/v1/life/consents`, `match-exclusions` | `fit.consents` 등 | Bearer |
| 공고 추천 | `/api/v1/life/recommendations`, `/matches` | `job_postings` + 카드 | Bearer |
| 정규화 훅 | `/api/candidates/me/normalize` | `candidate_profiles_norm` | Bearer |

**구직자가 기업 쪽에 노출되는 경로**: `profiles`(is_public) → 인재풀(`/desk/candidates`, `/discover`), orchestrator `listCandidates`·mcp `search_candidates` → 핏 분석·소싱.

---

## 3. 기업(company) 측

**화면 구역**: `/desk/**`, `/review`, `/sourcing/**`, `/settings/**`, `/discover`

| 기능 | 화면 → API | 데이터 | 인증 방식 |
|---|---|---|---|
| 데스크 지표·피드·제안 | `deskApi`(lifeFetch) → `/api/desk/*` | `fit_reports`, offers, views | Bearer 필수 (`requireUser`, legacy 폴백 없음) |
| 스카우트 건 | `/api/scout-cases/*` | `jd_runs` | Bearer 필수 |
| JD 분석 | JdMatchModal → `/api/jd/plan`, `/api/analyze` | `jd_runs`, `fit_reports`, BullMQ | **토큰 없이 호출** → legacy userId |
| HIL 승인함 | `/review` (lifeFetch) → `/api/fit-reports/:id/review` | `fit_reports` | Bearer, `isOwner` |
| 소싱·Slack 승인 | `/sourcing` (plain fetch) → `/api/sourcing/*` | `sourcing_actions` | **토큰 없이 호출**, `userId ?? "demo-user"` |
| 연동(Notion·Slack 채널) | `notionApi`·`slackChannelApi` (plain fetch, `?userId=`) | `notion_integrations`, `slack_channel_configs` | **토큰 없이 호출** → legacy userId |
| Brief(Slack unfurl) | `/brief/[id]` → `/api/brief` | fit_reports 요약 | orchestrator 는 public, talentfolio 화면은 이제 로그인 필요 |

---

## 4. 빈틈 (확인된 것만, 심각도 순)

**처리 상태 (2026-11-03)**: G6 을 뺀 전부 처리. G4 는 SQL 030 실행 전까지 talentfolio 인재풀 화면(브라우저 직접 조회)에만 남는다.

| # | 처리 | 확인 |
|---|---|---|
| G1 | orchestrator `accountGate` (auth.ts) — 토큰 `app_metadata.account_type` 으로 기업/구직자 전용 경로 분리 | 구직자→`/api/desk/summary` 403, 기업→`/api/v1/life/matches` 403, 각자 자기 경로 200 |
| G2 | talentfolio plain fetch → `authFetch`/`withAccessToken` (sourcing·JdMatchModal·notion·slack 채널), `.env.local` `AUTH_MODE=required` | 토큰 없이 `/api/candidates` 401. `/sourcing` 검색 200(Bearer) |
| G3 | `shared/lib/companyAccounts.ts`(Auth Admin, 5분 캐시) + `is_public=true` 필터 → `listCandidates`·`search_candidates` | 후보 101→99, 기업 계정 0 |
| G4 | SQL 030 `profiles.account_type` + 기업 `is_public=false` 고정 트리거 | ⬜ **SQL Editor 에서 실행 필요** |
| G5 | proxy 공개 접두사 `/brief/` | 비로그인 `/brief/abc` 200 |
| G6 | — | 보류 (사용자 결정) |
| G7 | `/sourcing` `demo-user` 폴백 제거, 비로그인이면 제출 안 함 | 코드 |
| G8 | `POST/DELETE /api/profile/photo` → 공개 버킷 `avatars` + `profiles.avatar_url` | 업로드 200·삭제 204·파일 제거 확인 |
| G9 | `/start`·`tf-role` 제거, 랜딩 버튼은 `/signup` | `/start` 없음 |
| G10 | `/login?unclassified=1` 안내 문구 | 코드 |
| G11 | "로그인 상태 유지" 체크박스 제거 (쿠키 세션은 항상 유지) | 코드 |


검증: 2026-11-03 로컬(:3000/:3001)에서 테스트 계정으로 직접 호출.

| # | 심각도 | 빈틈 | 근거 | 영향 |
|---|---|---|---|---|
| G1 | 높음 | **orchestrator 가 계정 유형을 전혀 보지 않음.** 구직자 토큰으로 기업 API 가 열린다 | 구직자 토큰으로 `GET /api/desk/summary` 200, `/api/fit-reports` 200, `/api/sourcing/candidates` 200 | 화면 가드(proxy)만 있고 API 는 무방비. 구직자가 후보 목록·데스크 데이터 조회 가능. 반대로 기업이 `/api/v1/life/*` 로 카드 생성 가능 |
| G2 | 높음 | **`AUTH_MODE=legacy` + 토큰 없는 호출이 그대로 통과** | 토큰 없이 `GET :3001/api/candidates` → 후보 101명 반환. `/sourcing`·연동 화면은 Bearer 를 안 싣고 `userId` 를 body/query 로 보냄 | :3001 에 직접 붙으면 로그인 없이 후보 목록·타인 userId 행세. `proxy.ts` 는 :3000 만 보호 |
| G3 | 높음 | **후보 목록에 기업 계정·비공개 프로필이 섞임** | `listCandidates`(orchestrator)·`search_candidates`(mcp)가 `profiles` 전체를 `is_public`·`account_type` 필터 없이 조회. 실제로 기업 계정 `검증담당(검증회사)`, `방구석` 이 목록에 있음 | 기업 계정이 핏 분석·소싱 대상이 됨. 구직자의 비공개 설정·matching 동의 철회가 소싱 경로에서 무시될 수 있음 |
| G4 | 중간 | **기업 계정 숨김이 클라이언트 효과에만 의존** | `AuthContext` 가 기업 로그인 시 `is_public=false` 로 바꿈. `test1234` 는 아직 로그인 전이라 공개 상태 | 로그인 전 기업 계정은 인재풀에 노출. 서버 판정이 아님 |
| G5 | 중간 | **Slack unfurl 이 막힘** | `/brief/abc` 비로그인 → 307 `/login` | Slack 봇은 쿠키가 없어 M2.6 카드 미리보기가 로그인 화면이 됨 |
| G6 | 중간 | **구직자가 기업 제안을 볼 곳이 없음** | 제안 응답(`/api/desk/offers/:id/response`)은 기업이 데스크에서 대리 입력. 스튜디오에는 받은 제안 화면이 없음 (`/studio/matches` 는 공고 추천) | 루프의 "제안" 단계가 구직자 쪽에서 끊김. 개요의 "받은 컨택"도 실제 데이터와 연결 안 됨 |
| G7 | 중간 | **`/sourcing` 의 `demo-user` 폴백** | `app/sourcing/page.tsx:79` `user?.id ?? "demo-user"` | legacy 에서 소싱 기록이 가짜 사용자에 쌓임 |
| G8 | 낮음 | **프로필 사진이 기업 화면에 안 보임** | 사진 경로는 `user_metadata.photo_path`(비공개 버킷). `profiles.avatar_url` 은 비어 있음 | 인재풀·Brief 에는 기본 아바타만 |
| G9 | 낮음 | **`/start` 가 죽은 화면** | proxy 가 비로그인을 막고, 로그인하면 홈으로 보냄. `tf-role` localStorage 도 이제 비로그인 헤더에만 쓰임 | 정리 대상 |
| G10 | 낮음 | **미분류 계정 안내 없음** | proxy 는 `/login?unclassified=1` 로 보내지만 로그인 화면이 이 값을 표시하지 않음 | 유형 없는 계정은 이유 모르고 튕김 |
| G11 | 낮음 | **"로그인 상태 유지" 체크박스가 동작 안 함** | `LoginDoors` 에서 값을 읽지 않음 | 장식 |

---

## 5. 고치는 순서 (제안)

1. **G1+G2 — orchestrator 에 유형 가드**: `verifySupabaseJwt` 가 `app_metadata.account_type` 을 `req.auth.accountType` 으로 싣고, `requireCompany` / `requireSeeker` 미들웨어를 라우트 묶음에 건다 (`/api/desk|scout-cases|sourcing|fit-reports|analyze|jd|candidates|notion|slack/channel-configs` = company, `/api/v1/life|candidates/me` = seeker). 동시에 talentfolio 의 plain fetch(`/sourcing`, `JdMatchModal`, `notionApi`, `slackChannelApi`)를 `lifeFetch` 로 바꿔 Bearer 를 싣고, `AUTH_MODE=required` 로 전환 (08 문서 미결 "talentfolio Bearer" 해소).
2. **G3+G4 — 후보 풀 필터**: `listCandidates`·`search_candidates` 에 `is_public = true` 와 기업 계정 제외를 넣는다. 기업 제외는 서버에서 판정해야 하므로 `profiles` 에 `account_type` 컬럼(또는 view)을 SQL 로 추가하고 가입 API·마이그레이션이 채운다. matching 동의 철회자 제외도 같은 자리에서.
3. **G5 — `/brief` 공개 범위 결정**: Slack unfurl 용으로 `/brief` 를 proxy 공개 경로에 넣되, 화면은 이미 공개 요약만 보이는지 확인. 아니면 서명 토큰 링크로.
4. **G6 — 구직자 받은 제안함**: `/studio` 에 offers 조회(`candidate_id = 나`) + 응답 API(구직자 본인 응답)를 추가해 루프를 닫는다.
5. G7~G11 정리.

---

## 6. 규칙 (앞으로의 작업)

- 새 화면을 만들면 `lib/accountType.ts` 의 `SEEKER_PREFIXES`/`COMPANY_PREFIXES` 에 넣는다. 안 넣으면 "로그인한 누구나" 화면이 된다.
- 새 orchestrator 라우트는 **토큰 + 유형** 둘 다 확인한다. `resolveUserId(req, fallback)` 의 legacy 폴백을 새로 쓰지 않는다.
- talentfolio → orchestrator 호출은 항상 `lifeFetch` (Bearer 자동). plain `fetch` + `userId` 파라미터 금지.
- 후보로 쓰는 쿼리는 `is_public` · 계정 유형 · matching 동의를 거친다.

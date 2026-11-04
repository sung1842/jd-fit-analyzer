# 24. 기능 간 호환·연결 끊김 분석 + 취지 적합성

> 작성 2026-11-03. 23 문서(계정·권한 경계)의 후속. 코드에서 확인한 사실만 적는다.
> 판단 기준은 CLAUDE.md 취지의 루프: **스카우트 건 → 후보 탐색 → 핏 분석 → 헤드헌터 승인(HIL) → 제안**,
> 그리고 데이터 원칙(운영 데이터는 플랫폼 내부, 크롤링 수집분은 더미·테스트 전용).

---

## 1. 기능 목록과 루프 위치

| 기능 | 화면/코드 | 루프 단계 | 적합성 |
|---|---|---|---|
| 데스크 대시보드 (D1~D4) | `/desk`, `/api/desk/*` | 전 단계 현황 | ✅ 핵심 |
| JD 분석·자동 쇼트리스트 | `JdMatchModal` → `/api/jd/plan`, `/api/analyze`, `/api/sourcing/auto-from-jd` | 스카우트 건 → 탐색 → 분석 | ✅ 핵심 |
| 스카우트 건 API | `/api/scout-cases/*` (orchestrator) | 스카우트 건 | 🟡 **화면 없음** (아래 C4) |
| 상시 수색(watch, E7) | `/api/jd-runs/:id/watch` | 탐색(수시 트리거) | 🟡 **화면 없음** (C4) |
| 핏 리포트 HIL 승인 | `/review`, `/api/fit-reports/:id/review` | HIL | ✅ 핵심 |
| 소싱·Slack 승인·제안 | `/sourcing`, `/sourcing/review`, `sourcing_actions`, Slack Block Kit | HIL → 제안 | ✅ 핵심 |
| 인재풀 | `/desk/candidates` | 탐색(수동) | ✅ |
| 인재 둘러보기 | `/discover` | 탐색(수동) | ⚠️ `/desk/candidates` 와 중복 + 구 SNS 기능 혼재 (C6) |
| 후보 포트폴리오 | `/talent/[id]` | 분석 근거 열람 | ✅ 지원 |
| Brief (Slack unfurl) | `/brief/[id]`, `/api/brief` | 제안·공유 | ✅ 지원 |
| Notion 동기화 | `/settings/integrations`, `/api/notion/*` | 승인 결과 기록 | 🟡 부가 (루프 밖 기록용) |
| Slack 채널 초대 자동 소싱 | `slack_channel_configs` | 스카우트 건 입구 | ✅ 지원 |
| 매칭 품질·가중치 관리 | `/api/admin/match/*` | 분석 품질 | ✅ 지원 |
| 크롤 검수 | jd-fit `web /crawling`, crawler | 더미 데이터 준비 | ✅ 데이터 원칙상 필수 |
| 스튜디오 프로필·이력 | `/studio` 프로필, `fit.resume_*` | 후보 데이터 품질 | ✅ 지원 (분석 입력) |
| 라이프 로그·근거 카드 | `/studio` 나를 보여주기, `/api/v1/life/*` | 후보 데이터 품질 | ✅ 지원 (분석 근거) |
| 동의(self_ai·matching)·추천 제외 | `fit.consents`, `match_exclusions` | 탐색 범위 | ✅ 필수 (C3 참고) |
| 이력서 PDF·프로필 사진 | `ResumePrint`, `/api/profile/photo` | 후보 표시 | 🟡 구직자 편의 (루프 밖, 사진은 탐색 화면에도 쓰임) |
| 자기소개서 | `/studio` 자기소개서 | — | 🟡 구직자 편의, 루프 밖 |
| 공고 추천·공고 정리(핀) | `/studio` 공고, `/api/v1/life/recommendations` | — | ⚠️ 루프 밖 + 데이터 원칙과 충돌 (C5) |
| 플로팅 채팅(사용자 간 DM)·Gemini 챗 | `FloatingChat`, `/api/chat/gemini` | — | ❌ 구 SNS 기능, 취지와 무관 (C6) |
| 데모 페이지 | `/demo/*` | — | ❌ 쇼케이스, 이제 로그인 필요 |
| jd-fit 웹 UI(:3010) | `web/` review·sourcing·portfolio-chat·crawling | — | ⚠️ 보류 UI. 포트폴리오 RAG 챗은 여기에만 있음 (C7) |

---

## 2. 연결이 끊기거나 서로 안 맞는 지점

### C1. 직군 분류가 네 벌 (높음)
| 어디 | 값 | 쓰는 곳 |
|---|---|---|
| `profiles.role` | developer / designer 2개 | 인재풀 배지, `search_candidates` 의 role 필터 |
| 가입 `user_metadata.job_category` | 크롤러 상위 21개 (`lib/jobCategories.ts`) | **아무 데서도 안 읽음** |
| `fit.job_categories` | 코드 체계 (스튜디오 "희망 직군") | `resume_basics.desired_categories` |
| `orchestrator roleTaxonomy` (SQL 021) | 공고 요구 직무 분류 | 매칭 엔진 |

- 가입 때 고른 직군이 스튜디오 희망 직군에 들어가지 않고, 매칭에도 쓰이지 않는다. 디자인 외 19개 직군은 `profiles.role=developer` 로 접혀 인재풀에 "개발자"로 보인다.
- **제안**: `fit.job_categories` 를 단일 기준으로 삼는다. 가입 직군 → `desired_categories` 초기값으로 넣고, `profiles.role` 은 표시용으로만 남기거나 직군 코드로 대체.

### C2. 후보 데이터 원천이 갈라져 있음 (높음)
- 원천: `profiles`(이름·직함·skills·bio) / `fit.resume_*`(스튜디오 이력) / 근거 카드(라이프 로그) / `candidate_profiles_norm`(정규화).
- `search_candidates`(소싱 키워드 검색)는 **`profiles` 의 name·title·skills 만** 본다. 스튜디오 이력·근거 카드만 채운 구직자는 키워드로 안 잡힌다.
- `profiles.skills`·`short_bio` 를 고치는 화면은 `ProfileEditModal` 인데, 이 모달은 `/discover`(이제 기업 구역)에만 있다 → **구직자는 skills 를 고칠 수 없다.** 스튜디오에는 skills 입력이 없다.
- 반면 핏 분석(`get_candidate_portfolio`)은 profiles + 공개 근거 카드 + 공개 이력을 함께 본다 → 검색과 분석이 다른 데이터를 본다.
- **제안**: 검색 입력을 `candidate_profiles_norm`(정규화 결과) 하나로 모으고, 스튜디오에 기술 스택 입력을 두거나 이력·카드에서 정규화가 채우게 한다.

### C3. "기업 매칭 노출" 동의 철회가 탐색 경로에 반영 안 됨 (높음)
- 스튜디오 문구: "철회하면 모두 빠져요". 실제로 `matching` 동의를 보는 곳은 공개 근거 카드 뷰(SQL 015)와 상시 수색(`watch.ts`)뿐.
- `listCandidates`·`search_candidates`·`get_candidate_portfolio` 는 동의를 확인하지 않는다 → 철회한 구직자도 후보 목록·핏 분석(기본 프로필·공개 이력)에 들어간다.
- **제안**: 23 문서 G3 필터 자리(`companyUserIds` 옆)에 `matching` 동의 보유자만 남기는 필터를 추가.

### C4. 스카우트 건·상시 수색이 화면과 연결 안 됨 (중간)
- orchestrator 에 `/api/scout-cases/*`(초안·시작·종료)와 `/api/jd-runs/:id/watch` 가 있지만 talentfolio·web 어디에서도 호출하지 않는다.
- 지금 `jd_runs`(스카우트 건) 행은 `JdMatchModal` 의 자동 쇼트리스트(`autoSourcing.persistJdRunWithAssessments`)로만 생긴다. 취지의 첫 단계 "스카우트 건 입력"에 해당하는 전용 화면이 없다.
- **제안**: `/sourcing` "스카우트 건 만들기"를 `/api/scout-cases` 로 옮기고, 건 상세에서 watch 를 켜게 한다. JD 입력 입구(JdMatchModal, Slack 채널 초대, 스카우트 건)를 하나의 `jd_runs` 생성 경로로 모은다.

### C5. 구직자 공고 추천이 더미 데이터 위에 있음 (중간)
- 스튜디오 "공고" 탭·추천은 `job_postings`(크롤링 수집분)를 쓴다. CLAUDE.md 데이터 원칙상 수집분은 더미·테스트 전용이다.
- 반대로 기업이 만든 스카우트 건 JD 는 구직자에게 어떤 형태로도 보이지 않는다 (G6 받은 제안함도 보류).
- **결과**: 구직자 쪽 "공고"와 기업 쪽 "스카우트 건"이 서로 다른 세계. 운영 전환 시 구직자 추천의 데이터 원천이 없다.
- **제안**: 운영에서는 스카우트 건(동의한 기업 JD)을 추천 원천으로 쓰고, 크롤링 공고는 테스트 환경 플래그 뒤로.

### C6. `/discover` 가 구 SNS 기능을 기업 구역에 끌고 옴 (중간)
- `/discover` 안에 `FloatingChat`(사용자 간 DM, Gemini 챗), `ProfileEditModal`(본인 프로필 편집), `AuthModal`(개발자/디자이너 가입) 이 있다.
- `/discover` 는 이제 기업만 들어오므로: 프로필 편집은 기업 계정이 자기 profiles 를 고치는 화면이 되고, AuthModal 가입은 **기업 화면에서 구직자 계정을 만든다**. DM 은 취지(헤드헌터 승인 후 접촉)와 충돌 — 승인 없이 후보에게 바로 말을 걸 수 있다.
- **제안**: `/discover` 를 `/desk/candidates` 로 합치고 FloatingChat·AuthModal·ProfileEditModal 을 제거 (`/settings/integrations` 의 AuthModal 도 이제 불필요 — proxy 가 로그인을 보장).

### C7. 두 개의 기업 UI (낮음)
- talentfolio(:3000) 와 jd-fit web(:3010, 보류)이 review·sourcing 을 각각 갖고 있다. 포트폴리오 RAG 챗(Phase 5)과 크롤 검수는 web 에만 있다.
- `AUTH_MODE=required` + 계정 유형 가드 이후 web 은 기업 계정 토큰이 있어야 동작한다 (확인 안 함).
- **제안**: 크롤 검수는 관리자 도구로 web 에 두고, 포트폴리오 챗은 `/talent/[id]` 로 옮기거나 보류로 명시.

### C8. 승인 개념이 두 개 (낮음)
- `fit_reports` 승인(`/review`) 과 `sourcing_actions` 승인(`/sourcing/review`, Slack 버튼, 데스크 offers) 이 따로 있다. 데스크 offers 는 `sourcing_actions` 를 재사용하므로 제안 쪽은 하나로 모였지만, "리포트 승인 → 제안 생성" 연결은 화면에서 사람이 이어야 한다.
- **제안**: 리포트 승인 시 제안 초안(`sourcing_actions` pending)을 자동 생성하는 한 흐름으로.

### C9. 공개 범위 설정이 네 겹 (낮음)
- `profiles.is_public`, `resume_basics.public_fields` + 항목별 `visibility`, `matching` 동의, `match_exclusions`. 화면마다 보는 스위치가 다르다 (C3 가 그 결과).
- **제안**: "기업에게 보이나?" 판정을 SQL 뷰 하나(`fit.candidate_visible`)로 모으고 모든 후보 쿼리가 그 뷰를 거치게.

---

## 2-1. 재확인 (2026-11-03, 사용자 질문 후)

- **C2 정정**: 스튜디오 프로필 탭 입력 칸 = 사진·한 줄 소개·연락처·지역·희망 직군/지역/고용형태/연봉·입사 가능일·병역·구직 상태 + 경력·학력·자격·어학·기타. **기술 스택 칸은 없다.** 소싱 키워드 검색(`search_candidates`)은 `profiles.name/title/skills` 만 본다 → 경력 '담당 업무'에 "React" 를 써도 키워드 검색엔 안 걸린다. 핏 분석·JD 매칭은 정규화(`candidate_profiles_norm`, LLM 이 이력 전체에서 skills 추출)를 쓰므로 거기선 잡힌다.
- **C1 정정**: 매칭이 쓰는 직군은 ① JD 쪽 `job_requirements.role` ↔ ② 후보 쪽 정규화 `roles`(14종 `CANDIDATE_ROLES`, LLM 이 이력·희망 직군에서 추출) 를 `roleTaxonomy` 로 비교(`jdPlan.requiredFilter`). 공고 추천은 `resume_basics.desired_categories` ↔ `job_postings.category_codes`(사람인 코드). 가입 때 고른 `user_metadata.job_category` 는 여전히 어디서도 안 읽고, 희망 직군 초기값으로도 안 들어간다. 직군 "종류"가 많아진 건 맞고, 문제는 **체계가 셋(사람인 코드 / 14종 role / developer·designer) 이고 가입값이 연결 안 됨**.
- **C4 정정**: 상시 수색은 JD 입력만으로 켜지지 않는다. `jd_runs.watch_enabled` 기본 false(SQL 026), 켜는 곳은 `PATCH /api/jd-runs/:id/watch` 뿐이고 talentfolio 에서 이를 부르는 화면이 없다. 켜진 건만 워커(watchQueue)가 주기 수색.
- **C5 처리**: 크롤링 공고 추천 유지(사용자 결정). 스카우트 건을 공고 목록에 노출 → SQL 031 트리거(`jd_runs` → `job_postings` source='scout_case'). 목록은 이미 최신순(`first_seen_at desc`) + 마감(`expires_at < now`) 제외였고, 스카우트 건은 종료·마감일이 expires_at 으로 들어간다.

- **C7~C9 처리**: jd-fit web(:3010, review·sourcing·portfolio-chat·crawling 화면) 폴더째 삭제 (2026-11-03). 크롤 검수·RAG 챗 orchestrator API 는 남음. C8(승인 두 곳)·C9(공개 범위 네 겹)는 talentfolio 에서 모두 쓰는 중이라 유지.

## 3. 우선순위 제안

1. **C3** (동의 위반 소지) → 2. **C2** (검색 누락) → 3. **C1** (분류 통일) → 4. **C6** (`/discover` 정리) → 5. **C4** (스카우트 건 화면) → 6. C5·C8·C9 (운영 전환 설계) → 7. C7.

C3·C2·C1 은 루프의 "후보 탐색" 정확도를 직접 좌우한다. C4 는 루프의 첫 단계 입구를 하나로 만드는 일이다.

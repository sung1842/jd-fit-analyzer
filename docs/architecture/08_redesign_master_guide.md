# 08. Master Architecture Redesign — 지침 원문 + 진행 상태

> 2026-10-19 기준. [11 체크리스트](11_redesign_checklist.md)가 요약본이고, 이 문서가 원문·판단·상태의 기준이다.
> 한 번에 한 항목씩 진행한다. 항목을 끝내면 이 문서와 11 체크리스트를 같이 갱신한다.
>
> **작업 규칙**: 같은 지침을 두 세션(창)에 동시에 넣지 말 것. 2026-10-19 밤에 두 세션이 `layout.tsx`, `notionRoutes.ts`, `AuthGate.tsx`, `crawler/` 를 동시에 고쳐 충돌이 났다. 레포가 git 이 아니라 복구 수단도 없다.

크롤러 파이프라인(트리거·gate·웹훅·법적 조사·사이트 추가 절차·HIL 2차 설계)은 [09_crawler_pipeline.md](09_crawler_pipeline.md) 가 기준이다. 이 문서의 §6·v2-5 는 그 요약.

상태 표기: ✅ 완료(코드 반영 + tsc 통과) · 🟡 부분(코드는 있으나 외부 설정/실행 필요) · ⬜ 미착수 · ⛔ 거부/보류(이유 명시)

---

## 지침 v1 — [Master Architecture Redesign & Refactoring Guide]

### 1. 데이터베이스 단일화 및 스키마 통합 (Single DB Strategy)

**원문**: talentfolio DB 와 fit-analyzer DB 를 분리하지 않고 하나의 Supabase 인스턴스(talentfolio DB)로 통합. AI 분석 테이블(fit_reports, portfolio_chunks, sourcing_actions, slack_channel_configs 등)을 개별 Schema 또는 접두사 테이블로 병합. 크롤링 적재는 Staging Table + COPY → Production Upsert.

| 항목 | 상태 | 근거 / 남은 일 |
|---|---|---|
| `fit` 스키마 마이그레이션 SQL (8개 기존 테이블 + `job_postings` + `job_postings_staging`(UNLOGGED) + `merge_job_postings()` upsert 함수 + RLS) | ✅ | `docs/architecture/sql/010_single_db_fit_schema.sql` |
| 백엔드 DB 클라이언트를 스키마 인식으로 전환 (single: `NEXT_PUBLIC_SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` + `FIT_DB_SCHEMA=fit`, legacy 폴백 유지) | ✅ | `shared/lib/fitDb.ts`, `orchestrator/src/lib/db.ts`, `mcp-server/src/lib/db.ts` |
| talentfolio 프로젝트에 010 SQL 실제 적용 | ✅ | 010은 2026-10-20 적용. 2026-10-24: 011(`job_categories` 21, `saramin_postings`, `saramin_posting_categories`) + 012(site facts 컬럼) 적용. 테스트 적재 `fit.saramin_postings` 10행. 구 DB 데이터 이전은 안 함 |
| Dashboard → API → Exposed schemas 에 `fit` 추가 | ✅ 2026-10-20 | 사용자 스크린샷: `fit`, `graphql_public`, `public` 3개 노출, Extra search path `public, extensions`. 노출 후 anon 키로 `fit.job_postings/fit_reports/portfolio_chunks/notion_integrations/job_postings_staging` 조회 → 전부 HTTP 401 `42501`(권한 없음). 노출돼도 anon 은 못 읽는다 |
| `.env.local` 의 `SUPABASE_SERVICE_ROLE_KEY` | 🟡 | 키는 talentfolio(`xbirvfebdwsjzohwoymm`) `service_role` JWT가 맞다. `public.profiles` SELECT는 42501 — public 권한은 건드리지 말 것. legacy `FIT_ANALYZER_*` 는 아직 남아 있음 |
| staging 테이블 | ✅ | 2026-10-20: 실제 DB에는 구 버전(인덱스 1·NOT NULL 3)이 적용돼 있어 마이그레이션 `fit_staging_no_index_no_constraints` 로 제거. 현재 UNLOGGED, 인덱스 0, 제약 0 (이 테이블만 변경, public 무영향) |
| `SUPABASE_DB_URL` | 🟡 2026-10-24 | 크롤러만 쓰므로 `crawler/.env` 에 있음. 2026-10-20 Session pooler(5432) 직결 성공 기록 있음. **2026-10-24 같은 URL `psycopg.connect` 가 ConnectionTimeout** → 적재는 MCP SQL로 우회. `saramin_store` 에 `connect_timeout=15` 추가. talentfolio 는 이 값을 쓰지 않음 |
| 보안 어드바이저 — `vector` 확장 이동 | ✅ 2026-10-20 | 마이그레이션 `move_vector_extension_to_extensions_schema`. `fit.match_portfolio_chunks` 의 search_path 를 `fit, extensions` 로 같은 트랜잭션에서 변경. 검증: 확장 스키마 `extensions`, public 잔여 객체 0, HNSW 인덱스 valid, SQL·REST rpc(service_role) 정상, anon 은 42501. 010 SQL 도 동기화 |
| 보안 어드바이저 — SECURITY DEFINER 트리거 함수 | ✅ 2026-10-20 | 마이그레이션 `revoke_public_execute_on_security_definer_triggers`: `public.handle_new_user`, `public.rls_auto_enable` 의 EXECUTE 를 public/anon/authenticated 에서 회수. `on_auth_user_created`·`ensure_rls` 트리거 유효. 롤백 검증: EXECUTE 없는 anon 이 발동시킨 SECURITY DEFINER 트리거가 정상 동작, 새 public 테이블 RLS 자동 활성 확인. 되돌리기: `grant execute on function public.<fn>() to public;` |
| 보안 어드바이저 — 유출 비밀번호 보호 | ⏭ 스킵 (유료 플랜 전용) | 사용자 결정 2026-10-20 |
| 보안 어드바이저 — 함수 search_path 고정 | ✅ 2026-10-20 | 마이그레이션 `pin_search_path_handle_new_user_and_set_updated_at`: `public.handle_new_user`, `fit.set_updated_at` 을 `search_path = ''` 로 고정. `profiles` 에는 사용자 트리거가 없고 기본값·CHECK 가 전부 내장 기능이라 안전. 롤백 검증: `auth.users` INSERT → `profiles` 행 생성(role=developer), `updated_at` 갱신, 잔여 행 0. 010 SQL 동기화 |
| 보안 어드바이저 — 남은 보안 항목 | ✅ 의도된 것만 | `rls_enabled_no_policy` INFO 4건(fit 백엔드 전용 테이블, service_role 만 접근). 유출 비밀번호 보호만 WARN 으로 남음(스킵) |
| 성능 어드바이저 (fit 소유분) | 🟡 SQL 033 작성, 실행 대기 | `auth_rls_initplan` WARN 5건(fit 정책의 `auth.uid()` → `(select auth.uid())`), 외래키 인덱스 없음 2건(`candidate_assessments.fit_report_id`, `notion_sync_records.jd_run_id`). public 소유분(conversations·messages·profiles 정책 10건, FK 3건)은 talentfolio 소유라 건드리지 않음 |
| `.cursorignore` | ✅ 2026-10-20 | 사용자가 직접 생성 (Write 도구는 권한 설정에 막힘). 내용: `crawler/.venv/`, `**/.next/`, `**/__pycache__/` |
| Supabase MCP 토큰 | ✅ | 2026-10-20: `--project-ref` 로 이 프로젝트에 한정되어 정상 동작. `list_projects` 는 이 모드에서 노출되지 않음 |
| 구 DB 데이터 이전 (pg_dump → sed → psql) | ⬜ | 절차는 010 SQL 하단 주석 |
| `scripts/verify-setup.ts` 가 `resolveFitDbConfig()` 로 single/legacy 를 구분하고, single 이면 `fit.job_postings` 까지 검사 | ✅ | legacy 키만 있으면 경고. 원격 010 적용 여부는 실행 결과로 확인 |

### 2. 보안 강화: Supabase Auth 및 JWT 검증 (Authentication & RLS)

**원문**: userId 문자열 신뢰 제거. Next.js 는 Supabase Auth SDK 로 로그인 후 JWT 확보. Orchestrator & MCP 서버는 `Authorization: Bearer <JWT>` 를 Supabase 서명 검증 미들웨어로 검증. Service Role Key 를 전역에서 무분별하게 쓰지 않고 JWT 유저 ID 기준으로 데이터 접근.

| 항목 | 상태 | 근거 / 남은 일 |
|---|---|---|
| Orchestrator JWT 미들웨어 — JWKS(ES256/RS256) 로컬 검증, HS256 은 `SUPABASE_JWT_SECRET` 있을 때만. `AUTH_MODE=required|legacy` | ✅ | `orchestrator/src/lib/auth.ts` (`jose`) |
| 모든 `/api/*` 라우트가 body/query `userId` 대신 토큰 `sub` 사용 (`resolveUserId`), 리포트·소싱 액션·SSE 스트림 소유권 검사 (`isOwner`) | ✅ | `orchestrator/src/server.ts`, `lib/notionRoutes.ts` |
| 공개 경로: Slack 인터랙티비티/이벤트(서명 검증), Notion OAuth 콜백, `/api/brief`(unfurl용 capability URL) | ✅ | 설계상 공개. `/api/brief` 는 추후 내부 키로 잠글 후보 |
| SSE·OAuth 시작은 `?access_token=` 허용 (EventSource 는 헤더 불가) | ✅ | `authGate.queryTokenPaths` |
| web: Supabase Auth 로그인 게이트 + 모든 fetch 에 Bearer (`apiFetch`) + SSE 토큰 (`sseUrl`), `userId` 입력창 제거 | ✅ | `web/src/components/AuthProvider.tsx`, `web/src/lib/{supabase,api}.ts`. 회원가입은 talentfolio 에서만 (profiles 행 생성이 거기 묶임) |
| `web/.env.local` 에 `NEXT_PUBLIC_SUPABASE_URL/ANON_KEY` 복사 | ✅ | 루트 `.env.local` 에서 공개값 2줄 복사 |
| RLS 정책 (authenticated 는 본인 행 SELECT 만, 쓰기는 service_role) | 🟡 | 010 SQL 에 포함. 적용은 §1 과 함께 |
| **MCP 서버의 JWT 검증** | ⛔ 의도적 미구현 | MCP 서버는 최종 사용자를 보지 않는다. 호출자는 orchestrator 뿐이므로 내부 키(§4)가 올바른 방어선. 사용자 JWT 를 워커까지 전달하면 1시간 만료 때문에 큐 대기 중 깨진다 |
| **Service Role 사용 범위 축소** | 🟡 한계 명시 | BullMQ 워커·Slack 웹훅·HIL 타임아웃은 요청 컨텍스트(JWT)가 없어 service_role 이 불가피. 대신 (a) HTTP 라우트는 JWT userId 로 소유권 검사, (b) RLS 로 브라우저 직접 접근 차단. 이게 현실적 상한 |
| **talentfolio 쪽 수정** (`JdMatchModal`, `briefReport`, `sourcing/*`, `notionApi` 가 Bearer 미전송) | ✅ 2026-11-03 (23 문서 G2, `AUTH_MODE=required`) | 전환 전까지 `.env.local` 에 `AUTH_MODE=legacy`. talentfolio 는 `supabase.auth.getSession()` 의 access_token 을 헤더로 보내면 됨 |
| `tier` 를 클라이언트가 보냄 | ⬜ | 유저 등급 테이블이 없음. 등급 컬럼 생기면 서버에서 결정 |
| orchestrator 바인드 `ORCHESTRATOR_HOST`(기본 127.0.0.1), `GET /api/sourcing/actions` 무필터 차단, 승인 라우트 `decidedBy` 는 토큰 신원 우선 | ✅ 코드 2026-10-20 / 🟡 legacy 한계 | `GET /api/sourcing/actions` 는 토큰·`userId`·`status=pending` 중 하나가 없으면 400. legacy 모드에서 무필터로 전체가 새던 것을 완화했을 뿐, **pending 대기열은 talentfolio 공용 대기열 설계라 legacy 에서 여전히 공개**. 완전 해결은 `AUTH_MODE=required` + talentfolio Bearer 전송. ngrok 으로 orchestrator 를 공개하면 대기열·승인 라우트가 외부에서 접근 가능 → ngrok 은 Slack 테스트 때만 켤 것 |

### 3. 큐(BullMQ) 병목 해결 및 API Rate Limit 대응

**원문**: concurrency 1 → 3~5 상향. BullMQ Limiter 로 분당 LLM 호출 수 제한. (예시: `new Queue(..., { limiter })`)

| 항목 | 상태 | 근거 / 남은 일 |
|---|---|---|
| 워커 concurrency 3 (`FIT_WORKER_CONCURRENCY`), 분당 job 상한 유료 4 / 무료 2 (env) | ✅ | `orchestrator/src/queue/workers.ts`, `portfolioChatWorker.ts` |
| **LLM 호출 직전** 슬라이딩 윈도우 리미터 (모델별 `GEMINI_RPM`, 기본 5) | ✅ | `mcp-server/src/lib/rateLimiter.ts` → `gemini.ts` 의 generateContent / embedContent 앞 |

**지침 오류 정정**
- "Limiter 옵션을 활성화" — 이미 켜져 있었다 (`limiter: {max:4, duration:60000}`). 꺼져 있던 적 없음.
- 예시 코드의 `new Queue(..., { limiter })` 는 BullMQ v5 에 없는 옵션이다. limiter 는 `Worker` 옵션이다.
- BullMQ limiter 는 **job 수**를 세지 LLM 호출 수를 세지 않는다. job 하나가 Gemini 3~6회, 거기에 portfolio-chat·parse_jd·임베딩이 같은 키를 쓴다. 429 를 실제로 막는 지점은 호출부(mcp-server)뿐이라 거기에 넣었다. concurrency 를 올려도 Gemini 슬롯이 없으면 호출부에서 대기할 뿐 에러가 안 난다.

### 4. MCP 서버 분리 구조 유지 및 통신 최적화

| 항목 | 상태 | 근거 |
|---|---|---|
| Streamable HTTP 표준 준수 | ✅ 기존 | `StreamableHTTPClientTransport` / `StreamableHTTPServerTransport` + `mcp-session-id`. Phase 4 에 이미 전환됨 |
| 내부 키 `MCP_INTERNAL_KEY` — orchestrator 가 `x-internal-key` 헤더 전송, mcp-server 가 timingSafeEqual 로 검증. 프로덕션에서 미설정이면 양쪽 기동 거부 | ✅ | `orchestrator/src/mcp/client.ts`, `mcp-server/src/index.ts` |
| `.env.local` 에 `MCP_INTERNAL_KEY` 값 설정 | ⬜ | 개발에서는 없어도 경고만. `openssl rand -hex 32` |

### 5. 배포 및 인프라 환경 변수 표준화 (Environment & CORS)

| 항목 | 상태 | 근거 |
|---|---|---|
| `NEXT_PUBLIC_API_URL` 우선, 없으면 `NEXT_PUBLIC_ORCHESTRATOR_URL`. 개발만 localhost 폴백, 프로덕션은 미설정 시 에러 | ✅ | `web/src/lib/api.ts` |
| CORS 화이트리스트 `CORS_ALLOWED_ORIGINS` (콤마). 미설정: 개발만 localhost:3000 허용, 프로덕션은 전부 거부 | ✅ | `orchestrator/src/lib/corsConfig.ts` |
| 남은 localhost: `TALENTFOLIO_URL`·`MCP_SERVER_URL` 기본값, 기동 로그 | ✅ 허용 | 전부 env 우선이고 개발 폴백만 남음 |
| 배포 시 `CORS_ALLOWED_ORIGINS` 에 talentfolio·web 도메인 등록 | ⬜ | 배포 때 |

### 6. 대규모 크롤링 파이프라인 연동 (Crawl4AI + Staging COPY)

| 항목 | 상태 | 근거 / 남은 일 |
|---|---|---|
| DB 측: `fit.job_postings`, `fit.job_postings_staging`(UNLOGGED, 인덱스 없음), `fit.merge_job_postings(batch_id)` | ✅ | 010 SQL. `GET /api/job-postings` + web 홈에서 공고 선택 → JD 채움 |
| `crawler/` Python 패키지 (models, csv_writer, loader, sources) | 🟡 | `python -m py_compile` 통과 (2026-10-19). `SUPABASE_DB_URL` 직결 접속은 2026-10-20 확인(아래 §1). 링크드인 어댑터는 없음. 2026-10-20 구조 확장: `runner.py`(자식 프로세스 실행)·`gate.py`·`redact.py`·`tests/` — 상세 [09](09_crawler_pipeline.md) |
| Crawl4AI 어댑터 (`JsonCssExtractionStrategy`, LLM 미사용) | 🟡 코드만, **미실행** | 2026-10-20 사이트 어댑터 규칙 추가(스키마에 `enabled:true`+`legal_basis` 필수, `allowed_hosts`, `delay:[3,7]`, 식별 UA(`CRAWLER_CONTACT`), robots 준수, 마스킹). 사이트 스키마 0개(`example_board.json` 은 템플릿), 이 PC 에 Playwright 브라우저 미설치 → **한 번도 실행된 적 없음**. 클래스명 바뀌면 깨지는 건 모든 크롤러가 같음 |
| 사람인 수집 | ✅ 직접 크롤로 전환 | Open API 미사용(2026-10-24), API 어댑터 코드 삭제(2026-10-25). 현재 경로는 [09](09_crawler_pipeline.md) §12 |
| **추가 사이트 크롤링** | ⬜ 대상 미정 · 사용자 위험 감수(2026-10-20) | 사용자가 위험을 감수하고 강행하기로 결정(법적 책임은 사용자). **로그인 없이 접근 가능하고 크롤링 허용 근거가 확인된 한국 채용사이트는 현재 없다**(잡코리아 판결·약관·robots 조사표는 [09 §4](09_crawler_pipeline.md)). 대상 사이트 선정과 `description` 본문 저장 정책이 미결 |
| **sanity gate** (`gate.py`) | ✅ 코드(2026-10-20, 구현 세션 산출물) / ⬜ 실데이터 미검증 | fetched==0(`empty`), 필수필드 유효율<0.9(`low_valid_ratio`), crawl4ai description 짧음>0.4(`low_desc_ratio`), 헤더 불일치(`bad_csv`) → 적재 중단·CSV 보존. 최근 7회 중앙값의 30% 미만은 경고만. HIL 검수 UI 대체(1차) |
| **HIL 검수 UI** (`/admin/crawling`) | ⬜ **2차로 연기**(사용자 결정 2026-10-20) | 현재 `merge_job_postings(batch)` 는 배치 전체를 승격하고 staging 행을 삭제하며, 적재 경로(`--load`·`/v1/trigger`)는 COPY 직후 자동 merge 한다 — **HIL 이 아니다**. 설계안은 [09 §10](09_crawler_pipeline.md): 마이그레이션 **011 = HIL**, 012 = pg_trgm/임베딩. admin 개념은 talentfolio 에 없음(확정) |
| **링크드인 수집** | ⛔ | 약관 위반 + authwall + 개인정보. Crawl4AI 로도 못 뚫고, 뚫어도 법적 리스크. 지침에서 제외 |
| 적재: 로컬 CSV → `COPY fit.job_postings_staging FROM STDIN (FORMAT csv)` (psycopg3, `SUPABASE_DB_URL` 직결) → `select * from fit.merge_job_postings(:batch)` | 🟡 | loader.py 가 다른 세션 산출물. 2026-10-20: gate 통과 후에만, **부모 프로세스**가 수행(크롤은 DB URL 없는 자식 프로세스). 실데이터 적재는 아직 안 함(`fit.job_postings` 0행) |
| **FastAPI 트리거** `POST /v1/trigger` (127.0.0.1:8010, `x-internal-key`=`CRAWLER_API_KEY`) | ✅ 코드 / ⬜ 실행 검증 | 키 없으면 기동 거부(fail-closed), `MCP_INTERNAL_KEY` 폴백 제거, loopback 외 바인드는 `CRAWLER_ALLOW_NON_LOOPBACK=1`. 202 `{job_id,status}`, 같은 작업 진행 중이면 409. 자식 프로세스는 환경변수 허용목록 + 타임아웃 시 프로세스 트리 kill. (트리거 경로는 `/api/crawler/trigger` 가 아니라 크롤러 FastAPI 의 `/v1/trigger` — orchestrator 에는 크롤러 트리거 라우트가 없다) |
| 크롤러 완료/실패 웹훅 | ✅ 코드 / ⬜ 실행 검증 | 어떤 종료 경로에서도 정확히 1회(이전엔 `--load` 경로에서만 나갔음). 상세 [06 §5](06_monitoring_observability.md) |

---

## 지침 v2 — "구인공고 수집 및 AI 분석 시스템 아키텍처 전면 개편"

### v2-1. 단일 DB & COPY 전략
v1 §1·§6 과 동일. 상태 동일.

### v2-2. 검색 엔진: Postgres 네이티브 (pg_trgm / 한국어 FTS + pgvector)

| 항목 | 상태 | 판단 |
|---|---|---|
| `job_postings` 제목·회사 GIN(tsvector simple) 인덱스, skills GIN | ✅ | 010 SQL. 주의: 인덱스 `job_postings_title_trgm` 은 이름과 달리 simple tsvector 인덱스다(trigram 아님, 오명) |
| `pg_trgm` 확장 + description/title trigram 인덱스 (한국어 부분일치) | ⬜ | Supabase 에서 `create extension pg_trgm` 가능. 다음 마이그레이션 **012**(011 은 HIL 용으로 예약, [09 §10](09_crawler_pipeline.md)) |
| **Postgres 한국어 형태소 분석기** | ⛔ 사실 정정 | Postgres 에 내장 한국어 형태소 분석기는 없다. mecab-ko 기반 `textsearch_ko` 는 Supabase 관리형에 설치 불가. 현실 선택지는 (a) pg_trgm 부분일치, (b) `to_tsvector('simple')` 공백 토큰, (c) 임베딩(pgvector). 이 셋 조합으로 간다 |
| `job_postings.embedding vector(768)` + HNSW, 크롤 후 배치 임베딩 (gemini-embedding-001, `GEMINI_RPM` 적용) | ⬜ | 012 마이그레이션 + mcp tool `embed_job_postings`. "수십만 건" 이면 임베딩 비용·RPM 먼저 계산할 것 |

### v2-3. 크롤러 역할 격리 (Python 배치 ↔ 웹 서버)
v1 §6 과 동일. 크롤러는 DB 에만 쓰고, 웹/오케스트레이터는 DB 에서만 읽는다 — 이미 그 구조로 설계됨 (`GET /api/job-postings`).

### v2-4. 백엔드 FastAPI 전면 전환

| 항목 | 상태 | 판단 |
|---|---|---|
| Express orchestrator → FastAPI 재작성 | ⛔ 같은 프롬프트 안에서 모순 | 2026-10-19 사용자는 이 프롬프트를 기존 문서보다 우선하라고 했다. 그래도 실행하지 않는다. Phase 2는 FastAPI로 Express를 대체하라 하고, Phase 5는 BullMQ limiter를 쓰라 한다. BullMQ는 Node 전용이라 한 프로세스에 못 넣는다. talentfolio는 `NEXT_PUBLIC_JD_ANALYZER_URL`(로컬 기본 `localhost:3001`)의 기존 Node 라우트를 호출한다. 검증 안 된 Python 포트로 그 포트를 바꾸면 공유 중인 talentfolio가 죽는다. JWT 검증은 이미 `orchestrator/src/lib/auth.ts`에 있다 |
| Supabase Auth + JWT 미들웨어 | ✅ | v1 §2 와 동일 |

### v2-5. n8n: 스케줄러 + 알림 + 가벼운 이벤트 연동

⏸ 2026-10-25 **보류**. 에러 웹훅 코드는 남김, 크롤러 스케줄·알림은 삭제. 상세 [12_n8n_on_hold.md](12_n8n_on_hold.md). 맞춤 공고 매칭 이메일은 미착수 상태로 함께 보류.

---

## 다음에 할 일 (순서대로, 한 번에 하나)

1. **§1 적용**: talentfolio Supabase SQL Editor 에서 010 실행 → Exposed schemas 에 `fit` → `.env.local` 에 `SUPABASE_SERVICE_ROLE_KEY` → orchestrator/mcp-server 기동 로그에 `fit DB: single DB 모드` 확인.
2. **§6 크롤러 마무리** (다른 세션 산출물 검토): `py_compile`, 직접 크롤링 어댑터(사람인 API 미사용, 2026-10-24 결정 → [09](09_crawler_pipeline.md)), 1회 적재 → `select count(*) from fit.job_postings`.
3. **§2 talentfolio 에 Bearer 추가** → `AUTH_MODE=legacy` 제거.
4. **v2-2 검색**: 012 마이그레이션 (pg_trgm, embedding 컬럼), `embed_job_postings` tool.

## 새로 생긴 환경 변수

```env
SUPABASE_SERVICE_ROLE_KEY=      # talentfolio 프로젝트 service_role (single DB). 서버 전용
FIT_DB_SCHEMA=fit               # 기본 fit
AUTH_MODE=required              # required(기본) | legacy(talentfolio 가 Bearer 보내기 전까지)
SUPABASE_JWT_SECRET=            # HS256 레거시 프로젝트일 때만. 비대칭 키면 불필요
MCP_INTERNAL_KEY=               # orchestrator↔mcp-server 내부 키. 프로덕션 필수
CORS_ALLOWED_ORIGINS=           # 콤마 구분. 미설정 시 개발만 localhost:3000
GEMINI_RPM=5                    # 모델별 분당 Gemini 호출 상한 (mcp-server)
FIT_WORKER_CONCURRENCY=3        # BullMQ 워커 동시 job 수
FIT_PAID_JOBS_PER_MIN=4 / FIT_FREE_JOBS_PER_MIN=2 / CHAT_WORKER_CONCURRENCY=2 / CHAT_JOBS_PER_MIN=4
SUPABASE_DB_URL=                # 크롤러 전용 Postgres 직결(COPY). Dashboard → Connect → Session pooler

# 크롤러 (crawler/.env 에만 둔다. 상세 crawler/.env.example, 09 문서)
CRAWLER_API_KEY=                # FastAPI x-internal-key. 없으면 서버 기동 거부(fail-closed)
CRAWLER_ALLOW_NON_LOOPBACK=     # 1 이어야 127.0.0.1/::1 외 바인드 허용
CRAWLER_CONTACT=                # Crawl4AI 식별 UA 용 연락처(필수) — 또는 CRAWLER_USER_AGENT
CRAWLER_USER_AGENT=
CRAWL_DELAY_MIN=3 / CRAWL_DELAY_MAX=7   # 사이트 어댑터 랜덤 지연(초)

# orchestrator (루트 .env.local)
ORCHESTRATOR_HOST=127.0.0.1     # 바인드 주소. 기본 loopback
```

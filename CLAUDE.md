# JD-Portfolio Fit Analyzer — 프로젝트 헌법

> 새 채팅에서 이 파일을 먼저 읽고 개발을 이어가세요.
> 이 파일은 **방향성과 절대 규칙만** 담는다. 매 대화에 자동 로드되므로 길어지면 docs/ 로 옮길 것 (현재 약 8.7k자).
> 구체적인 구현 스펙·코드 예시는 `docs/architecture/`의 개별 문서를 참고할 것.

---

## 🎯 프로젝트 취지 (모든 작업의 판단 기준 — 사용자 확정 2026-10-24)

- **문제의식**: AI 시대에 기업 자체 데이터는 자원이다. 채용 플랫폼의 자원은 공고·후보자 데이터이고, 수익 모델 중 하나는
  기업 의뢰 "인재 스카우트 건"을 따와 헤드헌터(사내/전문)에게 맡기는 것이다.
- **목표**: 이 헤드헌팅 업무를 **플랫폼이 보유한 내부 데이터**로 에이전트·자동화 시스템이 수행한다.
  루프 = 스카우트 건 입력(또는 수시 트리거) → 후보 탐색 → 핏 분석 → **헤드헌터 승인(HIL)** → 제안/알림 실행.
- **역할 분담**: 에이전트는 반복 탐색·분석을 맡고, 판단·후보 접촉은 사람이 승인한다. 헤드헌터 대체가 아니라 처리량 확대.
- **판단 규칙**: 새 작업은 "위 루프의 어느 단계를 어떻게 개선하는가"를 한 줄로 말할 수 있어야 한다. 못 하면 보류하고
  사용자에게 확인한다.
- **데이터 원칙**: 정확한 시스템은 정확한 데이터가 전제다. **크롤러(`crawler/`)는 더미·테스트 데이터 확보용 필수 기반**이라
  제외·축소하지 않는다 (법적 위험은 09 문서의 조건 안에서 진행). 운영 데이터의 원천은 플랫폼 내부 데이터.
  **수집은 직접 크롤링**(사람인 Open API 미사용, 2026-10-24 확정). API 는 공공데이터(워크넷/고용24) 보강에만. 수집분은 더미·테스트 전용.
- **구현 순서**: 더미 데이터 준비 → 그 위에 "스카우트 건"(의뢰 건→후보→승인→제안) 기능을 **기존 jd-fit 분석
  (jd_runs/fit_reports/sourcing_actions)을 개선하는 방식**으로 구현한다. 별도 신규 시스템으로 만들지 않는다.
- **토큰 원칙**: 취지는 이 섹션만 읽으면 된다. 상세는 문서 이정표로 필요한 것만 로딩하고, LLM 호출은 코드 사전필터 후 소량만.

---

## 🚨 아키텍처 헌법 (절대 위반 금지)

> 이 3개 조항은 Claude가 코딩할 때 **절대 넘어서는 안 되는 방어선**이다. 이를 어기면
> 레거시 SDK가 코드에 섞이거나, 동기식 블로킹으로 서버가 멈추거나, 토큰 폭탄/환각이
> 발생한다. 아래 어떤 작업을 하든 이 조항들을 먼저 확인할 것.

### 1. 최신 SDK 스펙 및 구조화된 출력 강제 (Anti-Legacy)
- **지침**: Google Gemini API 호출 시 반드시 최신 표준 패키지 **`@google/genai`**를
  사용한다 (`@google/generative-ai` 등 구버전 패키지 사용 금지). 모든 에이전트의 출력은
  프롬프트 지시("JSON으로 답해줘")가 아닌 **`config.responseJsonSchema`**를 통해
  JSON 포맷으로 강제한다.
- **API 표면 규칙**: `new GoogleGenAI({})`로 클라이언트 생성(인자 비우면 `GEMINI_API_KEY`
  자동 탐색) → `ai.models.generateContent({ model, contents, config })`로 중앙 호출
  (`getGenerativeModel` 패턴 금지) → 응답은 `response.text` **속성**(함수 아님)으로 파싱.
  상세 코드는 [docs/architecture/01_agent_orchestration.md](docs/architecture/01_agent_orchestration.md).
- **이유**: 명시하지 않으면 구버전 SDK 코드/구버전 API 패턴(`getGenerativeModel`,
  `response.text()`)이 섞여 들어오거나, 프롬프트만으로 JSON을 요청해 파싱 에러를 유발한다.

### 2. 비동기 큐 기반 논블로킹 아키텍처 (Anti-Blocking)
- **지침**: HTTP 요청-응답 주기 내에서 무거운 에이전트 루프를 동기식 `await`로
  대기시키는 것을 엄격히 금지한다. 모든 분석 작업은 **BullMQ + Redis** 기반 비동기
  작업 큐와 워커 풀로 처리하며, Human-in-the-Loop 단계는 워커를 블로킹하지 않고
  **DB 상태(State) 값**으로 관리한다 (→ [docs/architecture/03_queue_system.md](docs/architecture/03_queue_system.md),
  [docs/architecture/04_hil_timeout.md](docs/architecture/04_hil_timeout.md)).
- **이유**: 동시 사용자가 몰릴 때 요청-응답 타임아웃이나 API Rate Limit으로 전체
  시스템이 마비되는 상황을 원천 차단한다.

### 3. 선(先) 백엔드 정제, 후(後) 에이전트 주입 (Anti-LLM-Omnipotence)
- **지침**: 외부 API/MCP 서버에서 받은 대용량 raw JSON을 가공 없이 LLM에 그대로
  주입하는 것을 금지한다. Tool 실행 중 들어오는 데이터는 반드시 Node.js단에서
  filter/map을 통한 **prune & 정규화**를 거쳐 가벼운 상태로 에이전트 컨텍스트에
  주입한다 (→ [docs/architecture/02_data_pruning_adapter.md](docs/architecture/02_data_pruning_adapter.md)).
- **이유**: 무의미한 토큰 비용 폭탄을 막고, 방대한 데이터 속에서 AI가 핵심을 잃고
  환각을 뱉는 것을 방지한다.

---

## 프로젝트 개요

**JD-Portfolio Fit Analyzer** — 멀티 에이전트(MCP) 기반 채용공고-포트폴리오 핏 분석기

리크루터/기업이 JD(채용공고)를 입력하면, [talentfolio](../test1-main/talentfolio) 플랫폼의 후보자
포트폴리오와 비교해 기술 스택 적합도, 경험/트러블슈팅 적합도를 각각 평가하고, CEO 에이전트가 이를
취합해 최종 Fit Report를 생성한다.

- **레포 경로**: `C:\ClaudeWorkspace\jd-fit-analyzer\`
- **데이터 소스**: talentfolio Supabase `profiles` 테이블 (읽기 전용 연결)

## 핵심 기술 스택

- **언어/런타임**: Node.js + TypeScript
- **분석 에이전트**: `@google/genai` (Gemini Flash, structured output)
- **CEO 에이전트**: Anthropic SDK (Claude Sonnet, MCP client / tool use)
- **에이전트 통신**: MCP (stdio transport)
- **데이터**: Supabase (talentfolio `profiles`, 읽기 전용)
- **비동기 처리**: BullMQ + Redis (작업 큐 / 워커 풀, SSE 진행 상황 스트리밍)
- **모니터링**: Sentry (백엔드 인프라 에러), n8n (영구 실패 알림 — **보류**, 12 문서), Langfuse (Phase 4, LLM 트레이싱 — 검토 필요)

---

## 운영 규칙

1. **호출/재작업 상한**: 후보자 1명 분석당 LLM 호출 최대 5회, 재작업은 항목(tool)당
   최대 1회. → [docs/architecture/01_agent_orchestration.md](docs/architecture/01_agent_orchestration.md)
2. **모델 계층화**: 반복/좁은 분석 = Gemini Flash, 종합 판단(CEO, 1회) = Claude Sonnet.
3. **캐싱**: 동일 `(jd 해시, candidateId)`는 Redis에 캐싱해 재호출하지 않는다 (BullMQ jobId와 동일 키 형식).

---

## 문서 이정표

작업 종류에 따라 아래 문서만 선택적으로 읽을 것:

| 작업 | 참고 문서 |
|---|---|
| 에이전트 파이프라인/CEO/재작업 루프/공통 타입 | [docs/architecture/01_agent_orchestration.md](docs/architecture/01_agent_orchestration.md) |
| 외부 데이터 prune/정규화 어댑터 | [docs/architecture/02_data_pruning_adapter.md](docs/architecture/02_data_pruning_adapter.md) |
| BullMQ/Redis 큐, concurrency, 회원 등급별 처리 | [docs/architecture/03_queue_system.md](docs/architecture/03_queue_system.md) |
| Human-in-the-Loop / 타임아웃 처리 | [docs/architecture/04_hil_timeout.md](docs/architecture/04_hil_timeout.md) |
| MCP tool 호출(Function Calling) / 대용량 응답 압축 | [docs/architecture/05_mcp_tool_integration.md](docs/architecture/05_mcp_tool_integration.md) |
| 모니터링/에러 처리 (Langfuse, Sentry) | [docs/architecture/06_monitoring_observability.md](docs/architecture/06_monitoring_observability.md) |
| 크롤러 파이프라인 (트리거·gate·웹훅·법적 조사·사이트 추가 절차·HIL 2차) | [docs/architecture/09_crawler_pipeline.md](docs/architecture/09_crawler_pipeline.md) |
| 재설계 지침 원문·상태 (Single DB, JWT, 리미터, 내부 키, CORS, 크롤러, FastAPI 거부 근거) | [docs/architecture/08_redesign_master_guide.md](docs/architecture/08_redesign_master_guide.md) |
| 환경변수 전체 목록·키 설정 | [docs/architecture/10_env_reference.md](docs/architecture/10_env_reference.md) |
| 컨테이너 실행 (Docker Compose, 역할 분리·네트워크·헬스체크) | [docs/architecture/14_containers.md](docs/architecture/14_containers.md) |
| n8n (보류 — 다시 쓰려 할 때만) | [docs/architecture/12_n8n_on_hold.md](docs/architecture/12_n8n_on_hold.md) |
| 라이프 로그(일기+포트폴리오+AI) 도입 설계·갭 분석 / 제품 방향 근거 | [docs/architecture/18_life_log_design.md](docs/architecture/18_life_log_design.md), [docs/portfolio_insights.md](docs/portfolio_insights.md) |
| 앱(일기)/웹(이력·구직) 분리 서비스 기획·구현 순서 S0~S7 | [docs/architecture/19_app_web_service_plan.md](docs/architecture/19_app_web_service_plan.md) |
| 기업(헤드헌터) 쪽 기능·화면 구조 C1~C5 | [docs/architecture/20_company_side_plan.md](docs/architecture/20_company_side_plan.md) |
| 기업 데스크(/desk) 홈 대시보드 지표·화면 D1~D4 | [docs/architecture/21_desk_dashboard_plan.md](docs/architecture/21_desk_dashboard_plan.md) |
| 매칭 엔진 고도화(정규화·사전·벡터·순위식·품질지표·상시 수색) E1~E7 | [docs/architecture/22_matching_engine_plan.md](docs/architecture/22_matching_engine_plan.md) |
| 계정 아키텍처(구직자/기업 인증·권한 경계, 확인된 빈틈 G1~G11) | [docs/architecture/23_account_architecture.md](docs/architecture/23_account_architecture.md) |
| 기능 간 호환·연결 끊김 분석, 기능별 취지 적합성 | [docs/architecture/24_feature_fit_analysis.md](docs/architecture/24_feature_fit_analysis.md) |
| 재설계 항목별 상태표 | [docs/architecture/11_redesign_checklist.md](docs/architecture/11_redesign_checklist.md) |
| 핏 분석 실행 워크플로우 | [.claude/skills/fit-analysis/SKILL.md](.claude/skills/fit-analysis/SKILL.md) |
| 새 분석 에이전트(tool) 추가 | [.claude/skills/add-analysis-agent/SKILL.md](.claude/skills/add-analysis-agent/SKILL.md) |
| UI 애니메이션 (anime.js v4 고정) | [.claude/skills/anime-ui/SKILL.md](.claude/skills/anime-ui/SKILL.md) |

---

## 프로젝트 구조

```
jd-fit-analyzer/
├── CLAUDE.md
├── docs/architecture/            — 상세 스펙 (Laws)
├── .claude/skills/                — 워크플로우 가이드
├── shared/types.ts                — FitReport, AgentResult, Candidate 등 공통 타입
├── mcp-server/src/                — MCP 서버 (tools, lib)
└── orchestrator/src/              — CEO 에이전트, 큐 워커
(리크루터 UI 는 talentfolio. 구 web/ 는 2026-11-03 삭제)
```

---

## 환경변수

- 전체 목록·설명: [docs/architecture/10_env_reference.md](docs/architecture/10_env_reference.md) (키 추가·설정 작업 때만 읽을 것).
- 루트 `.env.local` = mcp-server/orchestrator. `crawler/.env` = **크롤러 전용** (Anthropic/Slack 키를 크롤러에 넘기지 않기 위함).
- 비밀값은 출력·로그·커밋 금지. `.env*` 는 키 이름 존재 여부만 확인한다.

---
## 🔧 재설계 체크리스트 (2026-10-19~)

- 상태표: [docs/architecture/11_redesign_checklist.md](docs/architecture/11_redesign_checklist.md), 원문·근거: [08](docs/architecture/08_redesign_master_guide.md).
- **한 번에 한 항목만** 진행하고, 끝나면 11 과 08 을 같이 갱신한다. **같은 지침을 두 세션에 동시에 넣지 말 것** (파일 충돌 발생 이력).
- 미결: 사람인 웹 어댑터→`job_postings` 병합 · 더미 물량 · 본문 저장 범위 · `CRAWLER_CONTACT` · 크롤 HIL 2차. 사람인 Open API 는 키·코드 모두 폐기(2026-10-24 결정, 2026-10-25 코드 삭제).

## 진행 단계 (Phase)

- [x] **Phase 0**: 레포 세팅 (package.json, tsconfig, shared/types.ts), Supabase 읽기 전용 연결 확인, Redis 로컬 실행 확인
- [x] **Phase 1**: MCP 서버 — `get_candidate_portfolio`, `analyze_tech_stack`, `analyze_experience` 구현 (Gemini Flash), prune/정규화 어댑터 적용
- [x] **Phase 2**: 오케스트레이터 — MCP client, BullMQ 큐/워커(202 Accepted + SSE), 규칙 기반 검증/재작업(피드백 루프 + 타겟 라우팅), overallScore/verdict 계산, ceoSummary 생성, 캐싱·로깅, Sentry 연동
- [x] **Phase 3**: 웹 UI — JD 입력 + 후보자 멀티선택 + Fit Report 카드(SSE 진행률 표시), HIL 검토 화면
- [x] **Phase 4 (확장)**: 컬처핏 등 추가 tool(`analyze_culture_fit`), stdio → HTTP/SSE transport 전환, Langfuse 트레이싱, 큐 우선순위/job promotion 고도화
- [x] **Phase 5**: ~~RAG 기반 "포트폴리오와 대화하기"(pgvector + 임베딩, 후보자 문서 청킹/검색)~~ (완료); B2B 사내 소싱(`search_candidates`/`notify_slack` MCP tool, `sourcing_actions` HIL 승인 게이트, `/sourcing` · `/sourcing/review` 화면, Slack Bot Token 연동) (완료) — Jira 연동은 추후 확장 가능
- [x] **Phase M1**: talentfolio 연동 — JD 핏 스코어(`parse_jd` + 코드 기반 사전 필터 + 배치 정밀 분석), 적합도순 정렬/강조/상세 리포트 (완료)
- [~] **Phase M2**: Slack HIL 인터랙티브 승인 게이트 — 코드 완료. 외부 설정(Slack App Interactivity, `SLACK_SIGNING_SECRET`, 공개 터널) 대기. 상세는 talentfolio/CLAUDE.md 참고
- [x] **Phase M2.5**: JD 분석 완료 시 `strong_fit` 쇼트리스트 자동 → `POST /api/sourcing/auto-from-jd` + Slack HIL (이벤트 기반, 임계값+상한). 상세는 talentfolio/CLAUDE.md
- [x] **Phase M2.6**: Slack Block Kit Card/Carousel + Talentfolio `/brief/[id]` unfurl + `GET /api/brief`
- [x] **Phase M4**: Notion per-user OAuth + `candidate_assessments` → 개인 DB sync (코드 완료 — SQL migration·Notion App 설정 필요)
- [ ] **Phase M3**: GitHub MCP 프로필 enrich

---

## 개발 서버 실행 (Phase 1+ 이후)

```bash
cd C:\ClaudeWorkspace\jd-fit-analyzer

# MCP 서버 (Streamable HTTP, :3002) — orchestrator보다 먼저 기동해야 함
cd mcp-server && npm run dev

# 오케스트레이터 (:3001, BullMQ 워커 포함)
cd orchestrator && npm run dev


# 크롤러 HTTP (:8010). 프론트 없음
cd crawler && .venv\Scripts\python -m jdcrawler.server

# talentfolio 프론트+API 라우트 (:3000). 별도 백엔드 프로세스 없음
cd C:\ClaudeWorkspace\test1-main\talentfolio && npm run dev
```

포트: talentfolio `3000`, orchestrator `3001`, mcp-server `3002`, crawler `8010`, Redis `6379`.

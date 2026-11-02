# 22. 매칭 엔진 고도화 — 개발자 설계 문서

| 항목 | 내용 |
|---|---|
| 문서 상태 | **설계 확정 전 (Draft)** — 코드·DB 변경 없음 |
| 작성 / 갱신 | 2026-10-30 |
| 대상 독자 | orchestrator · mcp-server 개발자 |
| 관련 문서 | [01 에이전트 오케스트레이션](01_agent_orchestration.md), [02 prune 어댑터](02_data_pruning_adapter.md), [03 큐](03_queue_system.md), [04 HIL](04_hil_timeout.md), [20 기업 쪽](20_company_side_plan.md), [21 데스크](21_desk_dashboard_plan.md) |
| SQL (예정) | `docs/architecture/sql/019_matching_engine.sql` (번호는 작성 시점에 재확인) |

---

## 1. 목적과 범위

### 1.1 목적
프로젝트 루프의 **"후보 탐색 → 핏 분석"** 단계를, 후보 수가 커져도 **빠르고(초 단위 1차 결과), 싸고(LLM 호출 최소), 일관되게(같은 입력 → 같은 순위)** 동작하게 한다.

### 1.2 범위
- 포함: 후보·공고 정규화, 표준 기술 사전, 변경 감지, 4단계 매칭 깔때기, 순위 계산식, 품질 지표·가중치 보정, 상시 수색.
- 제외: 후보 접촉 실행(기존 `sourcing_actions` HIL 그대로), UI 상세 디자인(별도 화면 문서), 결제·요금제 구현.

### 1.3 설계 원칙
1. **AI 는 두 곳에만**: 원문 → 구조화(정규화), 최종 정밀 판단(D 단계). 비교·순위는 코드.
2. **한 번 계산, 여러 번 사용**: 후보 정규화·임베딩은 등록·수정 시 1회 → 모든 공고가 재사용.
3. **원본 불변**: `profiles` 는 읽기 전용. 파생 데이터는 별도 테이블, 언제든 재생성 가능.
4. 헌법 준수: 1조(`@google/genai` + `responseJsonSchema`), 2조(모든 무거운 작업은 BullMQ), 3조(LLM 입력은 prune 후).

---

## 2. 용어

| 용어 | 정의 |
|---|---|
| 정규화(텍스트) | 공백·줄바꿈·대소문자·문장부호 정리. 코드만 사용 |
| 정규화(구조) | 원문을 정해진 칸(역할·기술·연수·태그)으로 채우는 LLM 1회 호출 |
| 표준 사전 | 동의어를 하나의 이름(canonical)으로 묶는 표. 예: react.js, 리액트 → `React` |
| 해시 | 정리된 텍스트의 sha256 지문. 같으면 내용 동일 |
| 의미 지문 | 텍스트 임베딩 벡터. 코사인 유사도로 "의미가 같은가" 판단 |
| 깔때기 A~D | 필수 조건 → 후보 검색 → 계산식 순위 → LLM 정밀 분석 |
| 보정 | 기업·헤드헌터별 가중치 조정값 |

---

## 3. 현재 구현 (AS-IS)

| 단계 | 구현 | 파일 |
|---|---|---|
| JD 파싱 | `parse_jd` → 직군(developer/designer) + 키워드 | `mcp-server/src/tools/parseJd.ts` |
| 사전 필터 | 같은 직군 후보의 `skills` 와 키워드 문자열 포함 비교, 일치 개수 정렬 | `orchestrator/src/lib/jdPlan.ts` `buildJdPlan` |
| 정밀 분석 | Gemini 3종 0~100 (기술·경험·컬처) | `mcp-server/src/tools/analyze*.ts` |
| 검증·재작업 | 근거 불일치·점수 모순 시 1회 재작업 | `orchestrator/src/validation.ts` |
| 종합 | tech 0.5 / exp 0.3 / culture 0.2, ≥75 strong, ≥45 possible | `orchestrator/src/ceo.ts` |
| 임베딩 | `gemini-embedding-001`, 768차원, pgvector HNSW | `mcp-server/src/lib/gemini.ts`, `sql/006_portfolio_chunks.sql` |

**알려진 문제**
- P1. 필수 조건(경력·지역·구직 상태) 필터 없음 → 부적합자가 LLM 단계까지 감.
- P2. 문자열 포함 비교 → 동의어 누락(React/React.js), 오탐(`Java` ⊂ `JavaScript`).
- P3. 필수/우대 기술 구분 없음.
- P4. 매칭마다 후보 원문을 다시 LLM 에 넣음 → 후보·공고 수에 비례해 비용 증가.
- P5. 직군 2종뿐 → 백엔드/풀스택 같은 인접 직무 표현 불가.

---

## 4. 아키텍처 (TO-BE)

```
┌──────────────── 등록·수정 시 (백그라운드, 큐: candidate-normalize) ────────────────┐
│ profiles 변경 → [변경 감지 1~3] → 구조 정규화(LLM) → [변경 감지 4] → 사전 매핑 → 임베딩 │
│                                                       └→ candidate_profiles_norm 저장   │
└─────────────────────────────────────────────────────────────────────────────────────┘

┌──────────────── 매칭 시 (큐: match-run, 즉시=높은 priority / 상시 수색=낮음) ─────────┐
│ 공고 정규화(1회, job_requirements_norm)                                                │
│  A. 필수 조건 필터      SQL WHERE + 인덱스              → 수만 → 수천                  │
│  B. 후보 검색           표준 기술 겹침 ∪ pgvector top-K → 200~500                      │
│  C. 계산식 순위         코드, 결정적, score_breakdown   → 20~50                        │
│  D. 정밀 분석           기존 analyze_* + CEO            → 상위 N (요금제 상한)          │
│ A~C 결과는 즉시 응답/SSE, D 는 완료되는 대로 SSE                                        │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

### 4.1 컴포넌트

| 컴포넌트 | 위치 (예정) | 역할 |
|---|---|---|
| `normalize_candidate` MCP tool | `mcp-server/src/tools/normalizeCandidate.ts` | 구조 정규화 LLM 호출 (prune 된 입력만) |
| `normalize_job` MCP tool | `mcp-server/src/tools/normalizeJob.ts` | 공고 → 필수/우대/경력/지역 |
| 사전 매퍼 | `orchestrator/src/lib/skillDictionary.ts` | alias → canonical, 계층·인접 조회 (메모리 캐시) |
| 변경 감지 | `orchestrator/src/lib/changeDetect.ts` | 해시·칸 비교·의미 지문·결과 비교 |
| 정규화 워커 | `orchestrator/src/queue/normalizeQueue.ts` | 쿨다운·디바운스 포함 |
| 매칭 엔진 | `orchestrator/src/lib/matchEngine.ts` | A~C 단계, D 단계 잡 생성 |
| 매칭 워커 | `orchestrator/src/queue/matchQueue.ts` | 즉시/상시 수색 잡 처리 |
| 가중치 배치 | `orchestrator/src/queue/weightsScheduler.ts` | 주 1회 `ranking_weights` 재계산 |

---

## 5. 데이터 모델

모든 테이블은 `fit` 스키마. 서비스 롤로만 쓰기.

```sql
-- 표준 기술 사전
create table fit.skill_dictionary (
  canonical text primary key,            -- 'React'
  aliases   text[] not null default '{}',-- {'react','react.js','리액트'} (소문자 저장)
  category  text not null,               -- frontend|backend|data|devops|mobile|design|etc
  parent    text references fit.skill_dictionary(canonical), -- 'Next.js' → 'React'
  updated_at timestamptz not null default now()
);
create index on fit.skill_dictionary using gin (aliases);

-- 사전에 없는 이름 (사람이 주기적으로 사전에 편입)
create table fit.skill_unmapped (
  raw text primary key, seen_count int not null default 1, last_seen timestamptz not null default now()
);

-- 직무 분류와 인접도
create table fit.role_taxonomy (
  role text not null, related text not null, affinity numeric(3,2) not null check (affinity between 0 and 1),
  primary key (role, related)
);  -- ('backend','fullstack',0.80), ('backend','devops',0.50) …

-- 후보 정규화 결과 (후보 1명 = 1행)
create table fit.candidate_profiles_norm (
  candidate_id   text primary key,
  source_hash    text not null,          -- 변경 감지 1단계
  fields_hash    text not null,          -- 변경 감지 2단계 (선택형 칸)
  norm_version   int  not null,          -- 프롬프트·사전 버전
  roles          text[] not null,        -- {'fullstack','backend','frontend'}
  skills         jsonb not null,         -- [{name:'React', years:2, professional:true}]
  total_years    numeric(4,1),
  tags           text[] not null default '{}',
  prefs          jsonb,                  -- {locations:[], salary_min, salary_max, remote}
  job_seeking    boolean not null default false, -- "제안 받기" 동의
  narrative_embedding vector(768),       -- 자유 서술 의미 지문 + B 단계 검색
  normalized_at  timestamptz not null default now()
);
create index on fit.candidate_profiles_norm using gin (roles);
create index on fit.candidate_profiles_norm using gin (skills jsonb_path_ops);
create index on fit.candidate_profiles_norm using hnsw (narrative_embedding vector_cosine_ops);

-- 공고 정규화 결과
create table fit.job_requirements_norm (
  jd_run_id     uuid primary key references fit.jd_runs(id) on delete cascade,
  source_hash   text not null,
  norm_version  int  not null,
  role          text not null,
  must_skills   text[] not null default '{}',
  nice_skills   text[] not null default '{}',
  years_min     numeric(4,1), years_max numeric(4,1),
  locations     text[], remote_ok boolean,
  embedding     vector(768),
  normalized_at timestamptz not null default now()
);

-- (공고, 후보) 점수 캐시
create table fit.match_scores (
  jd_run_id     uuid not null references fit.jd_runs(id) on delete cascade,
  candidate_id  text not null,
  inputs_hash   text not null,           -- 양쪽 norm 해시 + 가중치 버전
  rank_score    numeric(5,2) not null,
  score_breakdown jsonb not null,        -- {must:..,nice:..,years:..,role:..,vector:..,activity:.., boost:{company:..,recruiter:..}}
  stage         text not null check (stage in ('ranked','analyzing','analyzed','skipped')),
  fit_report_id uuid,                    -- D 단계 결과 (기존 fit_reports)
  updated_at    timestamptz not null default now(),
  primary key (jd_run_id, candidate_id)
);
create index on fit.match_scores (jd_run_id, rank_score desc);

-- 헤드헌터 결정 (품질 측정·보정 학습 데이터)
-- 기존 fit.status_events(017)의 reason_code 를 재사용하고, 집계 편의용 뷰만 만든다.

-- 층별 가중치
create table fit.ranking_weights (
  scope      text not null check (scope in ('global','company','recruiter')),
  scope_id   text not null default '-',  -- global 은 '-'
  weights    jsonb not null,             -- {must:40,nice:15,years:15,role:10,vector:15,activity:5} 또는 보정 비율
  sample_n   int not null default 0,
  version    int not null default 1,
  updated_at timestamptz not null default now(),
  primary key (scope, scope_id)
);

-- 상시 수색 설정 = jd_runs 확장 (새 시스템 X)
alter table fit.jd_runs add column if not exists watch_enabled boolean not null default false;
alter table fit.jd_runs add column if not exists watch_until timestamptz;
alter table fit.jd_runs add column if not exists daily_llm_cap int not null default 20;
alter table fit.jd_runs add column if not exists scan_cursor text;     -- 전체 훑기 위치
```

---

## 6. 처리 흐름 상세

### 6.1 텍스트 정리 (코드)
```ts
function cleanText(s: string): string {
  return s.normalize("NFKC")
    .replace(/\s+/g, " ")
    .replace(/[“”"'`]/g, "")
    .trim()
    .toLowerCase();
}
```
해시 입력은 **매칭 관련 필드만** 고정 순서로 직렬화: `role, title, skills, careers(기간·직무), prefs, narrative`. 사진·연락처·SNS 제외.

### 6.2 변경 감지 (후보 수정 이벤트)

| 단계 | 조건 → 동작 | 비용 |
|---|---|---|
| 1 해시 | `sha256(cleanText(관련필드)) == source_hash` → **중단** | 0 |
| 2 구조 칸 | 선택형 칸(skills 태그, 경력 기간, 직무) 해시 == `fields_hash` 이고 자유 서술만 변경 → 3단계로. 칸이 바뀌면 4단계로 직행 | 0 |
| 3 의미 지문 | 새 서술 임베딩과 `narrative_embedding` 코사인 ≥ `NARRATIVE_SAME_THRESHOLD`(0.95) → 해시만 갱신하고 **중단** | 임베딩 1회 |
| 4 결과 비교 | 구조 정규화 후 `{roles, skills, total_years, tags}` 가 이전과 같으면 저장만 하고 재매칭 큐에 **넣지 않음** | LLM 1회 |

**쿨다운·디바운스**: BullMQ jobId = `norm:{candidateId}`, `delay = NORMALIZE_DEBOUNCE_MS`(기본 10분). 같은 후보 이벤트가 또 오면 기존 지연 잡을 교체 → 마지막 내용 1번만 처리. 추가로 후보당 `NORMALIZE_DAILY_MAX`(기본 1)회 초과분은 다음 날 정기 갱신으로 미룸.

### 6.3 구조 정규화 (LLM)
- 모델: Gemini Flash, `temperature: 0`, `responseJsonSchema` 강제.
- 입력: prune 된 필드만 (헌법 3조). 최대 길이 제한.
- 스키마 요점:
  - `roles`: `enum` = `role_taxonomy` 의 role 목록 (빌드 시 주입), 최대 3개.
  - `skills[].name`: 자유 문자열이지만 프롬프트에 사전 canonical 상위 목록을 제공. 저장 전 사전 매퍼가 매핑, 실패 시 `skill_unmapped` 적재 후 제외.
  - `skills[].years`: number, `professional`: boolean.
- 결과는 `norm_version` 과 함께 저장. 버전이 오르면 낮은 버전 행만 배경 큐로 재정규화.

### 6.4 매칭 깔때기

**A. 필수 조건 (SQL)**
```sql
where job_seeking
  and roles && :role_with_related         -- role_taxonomy affinity ≥ 0.5 인 인접 역할 포함
  and (total_years is null or total_years >= :years_min - 1)
  and (:locations is null or prefs->'locations' ?| :locations or (prefs->>'remote')::bool)
```

**B. 후보 검색**: (A 결과) 중 `must_skills ∪ nice_skills` 와 skills 가 1개 이상 겹침 **합집합** pgvector `narrative_embedding <=> job.embedding` 상위 `B_TOP_K`(300). 키워드로 못 잡는 경험을 벡터가 보완.

**C. 계산식 순위 (결정적)**
```
must     = 충족 필수 수 / 필수 수              (계층 인정: 자식 기술 보유 시 0.7 인정)
nice     = 충족 우대 수 / 우대 수
years    = 범위 안 1.0, 범위 밖 1년당 -0.25 (최소 0)
role     = role_taxonomy.affinity (동일 역할 1.0)
vector   = 코사인 유사도 (0~1)
activity = 최근 30일 내 수정·로그인 1.0, 90일 0.5, 그 외 0.2

rank = Σ weight_i × item_i      (weights 는 7.2 의 층별 합성 결과)
필수 1개 이상 미충족 → rank = min(rank, 50)
```
상위 `C_TOP_N`(30) 을 `match_scores(stage='ranked')` 로 저장, `score_breakdown` 에 항목별 값·보정값 기록.

**D. 정밀 분석**: C 상위에서 `rank ≥ D_MIN_RANK`(60) 이고 일일 상한(`daily_llm_cap`) 이내만 기존 `runFitAnalysis` 잡으로 투입. 캐시 키는 기존 규칙 `(jd 해시, candidateId)` 유지.

### 6.5 상시 수색
- 대상: `watch_enabled and now() < watch_until`.
- 큐 2개:
  - `match-delta` (우선): 정규화 4단계에서 "결과 변경"으로 판정된 후보 × 활성 의뢰 건.
  - `match-scan` (후순위): `scan_cursor` 부터 `SCAN_BATCH`(500) 명씩 A~C 수행, 커서 전진. 한 바퀴 끝나면 delta 만.
- 하루 D 단계 할당: delta 70% / scan 30% (`WATCH_DELTA_RATIO`).
- 즉시 매칭은 `match-run` 에 priority 1, 상시 수색은 priority 10.
- 결과: `strong_fit` → `sourcing_actions` 승인 대기(기존 HIL), 하루 1회 요약 알림. 같은 (의뢰 건, 후보)는 1회만 알림.
- 만료·마감(`closed_at`) 시 반복 잡 제거.

---

## 7. 품질 측정과 가중치 보정

### 7.1 지표 (엔진의 성적표 — 후보 등급이 아님)
거절은 **해당 (공고, 후보) 조합에만** 기록된다. 후보의 다른 매칭에 영향 없음.

| 지표 | 계산 | 용도 |
|---|---|---|
| 승인율 | D 추천 중 승인 / 전체 | 낮으면 `D_MIN_RANK` 상향 → 비용 절감 |
| 뒤집기율 | strong 거절 + weak 승인 / 전체 결정 | 가중치·프롬프트 오류 신호 |
| 거절 사유 분포 | `status_events.reason_code` 집계 | 어떤 가중치를 조정할지 |
| 수락율 | 후보 수락 / 제안 | 최종 성과 |

### 7.2 층별 보정
```
w_final[i] = w_global[i] × (1 + b_company[i]·α_c) × (1 + b_recruiter[i]·α_r)
α = min(1, max(0, (n - 30) / 70))      -- 결정 30건 미만 0, 100건에서 1
b ∈ [-0.2, +0.2]                        -- 폭 제한
합이 100 이 되도록 재정규화
```
- 학습: 주 1회 배치. 승인/거절 결정과 `score_breakdown` 항목값으로 로지스틱 회귀 계수 → 공통 대비 비율을 `b` 로 클램프.
- **편향 차단**: 항목은 must/nice/years/role/vector/activity 만. 나이·성별·학교는 데이터 모델에 넣지 않는다.
- 설명: `score_breakdown.boost` 에 층별 기여를 저장해 UI 에서 "이 기업 기준 반영" 표시.

---

## 8. 인터페이스

### 8.1 HTTP (orchestrator, 모두 202 + SSE 패턴)
| 메서드·경로 | 설명 |
|---|---|
| `POST /api/match/runs` | `{ jdRunId }` → 즉시 매칭 잡. 응답 `{ jobId }` |
| `GET /api/match/runs/:jdRunId/stream` | SSE: `ranked`(A~C 결과 목록) → `analyzed`(D 결과 1건씩) → `done` |
| `GET /api/match/runs/:jdRunId` | `match_scores` 상위 목록 + breakdown |
| `PATCH /api/jd-runs/:id/watch` | `{ enabled, until, dailyLlmCap }` 상시 수색 설정 |
| `POST /api/admin/skills` | 사전 항목 추가·병합 (관리자 비밀번호 게이트 재사용) |
| `GET /api/admin/skills/unmapped` | 미매핑 기술 목록 |

### 8.2 MCP tools (mcp-server)
| tool | 입력 | 출력 |
|---|---|---|
| `normalize_candidate` | prune 된 후보 필드 | `{roles, skills[], total_years, tags, prefs}` |
| `normalize_job` | JD 텍스트 | `{role, must_skills, nice_skills, years_min, years_max, locations, remote_ok}` |

`parse_jd` 는 `normalize_job` 로 대체 후 제거(호환 기간 동안 유지).

### 8.3 이벤트 소스
후보 생성·수정 감지: talentfolio 저장 API 에서 orchestrator 내부 엔드포인트 호출(내부 키) 또는 `profiles.updated_at` 폴링(5분, 커서). 둘 중 구현 시 결정 — 미결 Q2.

---

## 9. 설정값

| 키 | 기본 | 설명 |
|---|---|---|
| `NORMALIZE_DEBOUNCE_MS` | 600000 | 후보 수정 디바운스 |
| `NORMALIZE_DAILY_MAX` | 1 | 후보당 하루 재정규화 횟수 |
| `NARRATIVE_SAME_THRESHOLD` | 0.95 | 의미 지문 동일 판정 |
| `B_TOP_K` | 300 | 벡터 검색 상위 수 |
| `C_TOP_N` | 30 | 순위 단계 출력 수 |
| `D_MIN_RANK` | 60 | LLM 분석 투입 최소 점수 |
| `SCAN_BATCH` | 500 | 전체 훑기 1회 인원 |
| `WATCH_DELTA_RATIO` | 0.7 | 상시 수색 delta 배분 |
| `MATCH_NORM_VERSION` | 1 | 정규화 버전 |

추가 시 [10 환경변수 문서](10_env_reference.md) 갱신.

---

## 10. 오류 처리·모니터링
- 정규화 LLM 실패: 3회 지수 백오프 후 실패 시 기존 norm 유지, Sentry 보고. 후보는 매칭에서 제외되지 않음(이전 결과 사용).
- 임베딩 실패: 3단계 건너뛰고 4단계로 진행(비용↑, 정확성 유지).
- 사전 매핑 실패율 > 10%: Sentry 경고 → 사전 보강 신호.
- 지표: 단계별 처리량·소요시간, 변경 감지 단계별 중단 비율, 일일 LLM 호출 수·비용(Langfuse).

## 11. 보안·개인정보
- 상시 수색·제안 대상은 `job_seeking = true` (구직자 동의)만.
- 기업 열람은 기존 `profile_views`(017) 기록 재사용, 구직자에게 열람 기록 노출.
- 매칭 결과에 연락처 미포함. 접촉은 HIL 승인 후에만.

---

## 12. 테스트·수용 기준

| ID | 기준 | 검증 |
|---|---|---|
| T1 | `Java` 공고에 `JavaScript` 만 가진 후보가 필수 충족으로 계산되지 않는다 | 단위 테스트 (skillDictionary) |
| T2 | `React.js`/`리액트` 가 `React` 로 매핑된다 | 단위 |
| T3 | 공백·대소문자만 바꾼 수정은 1단계에서 중단 | 단위 (changeDetect) |
| T4 | 같은 내용을 다른 문장으로 바꾼 수정은 3단계에서 중단 (고정 임베딩 픽스처) | 단위 |
| T5 | 같은 입력 2회 → C 단계 순위·점수 동일 | 단위 (결정성) |
| T6 | 필수 미충족 후보 rank ≤ 50 | 단위 |
| T7 | 결정 30건 미만 기업은 보정 0 | 단위 |
| T8 | 1만 명 더미에서 A~C 결과 SSE `ranked` 가 2초 이내 | 통합 (DB 게이트 `MATCH_DB_TEST=1`) |
| T9 | 일일 상한 초과 시 D 단계 잡이 생성되지 않는다 | 통합 |
| T10 | 10분 내 같은 후보 5회 수정 → 정규화 1회 | 통합 (큐) |

## 13. 구현 단계

| 단계 | 내용 | 완료 조건 | 해결 문제 |
|---|---|---|---|
| E1 | `skill_dictionary` + 매퍼, `jdPlan` 비교 교체 | T1·T2 | P2 |
| E2 | `candidate_profiles_norm` + `normalize_candidate` + 변경 감지 4단계 + 디바운스 | T3·T4·T10 | P4 |
| E3 | `job_requirements_norm` + `normalize_job` + A 단계 + `role_taxonomy` | T6 | P1·P3·P5 |
| E4 | 임베딩 저장 + B 단계 | T8 일부 | P2 보완 |
| E5 | C 계산식 + `match_scores` + SSE `ranked` | T5·T8 | — |
| E6 | 품질 지표 집계 (status_events 재사용) | 데스크 지표 연결 | — |
| E6b | `ranking_weights` 층별 보정 + 주간 배치 | T7 | — |
| E7 | 상시 수색 2큐 + 요약 알림 | T9 | — |

각 단계 종료 시 이 문서의 §14 상태와 [11 체크리스트](11_redesign_checklist.md) 를 갱신한다.

## 13-1. 구현 상태

| 단계 | 상태 | 내용 |
|---|---|---|
| E1 | 완료 (2026-10-30). SQL 019 원격 적용·서비스 롤 조회/RPC 확인, orchestrator 컨테이너 재빌드 | `orchestrator/src/lib/skillSeed.ts`(시드 약 100개), `skillDictionary.ts`(매퍼·10분 캐시·DB 우선 병합), `jdPlan.ts` `rankBySkills`(정확 일치 1, 하위 기술 0.7, 문자열 포함 비교 제거, `matchScore` 정렬). 미매핑 이름은 `fit.record_unmapped_skills` RPC 로 적재. 테스트 `test/skillDictionary.test.ts` (T1·T2 포함 6건) |

| E2 | 완료 (2026-10-30). SQL 020 원격 적용, 실후보 18명 정규화(created 18) → 재실행 시 same_hash 18 (LLM 0회) 확인 | mcp-server `normalize_candidate`(역할 enum 14종, JSON Schema 강제)·`embed_texts`. orchestrator `lib/candidateNorm.ts`(해시 2종·의미 지문·결과 비교·사전 매핑·저장), `queue/normalizeQueue.ts`(BullMQ 디바운스 `deduplication{extend,replace}`·하루 상한·매일 sweep `NORMALIZE_SWEEP_CRON`), `lib/candidateNormRoutes.ts`(`POST/GET /api/admin/candidates/normalize[/stats]`, 비밀번호 게이트). 테스트 `test/candidateNorm.test.ts` (T3·T4·T10 포함 9건, T10 은 `NORMALIZE_QUEUE_TEST=1` + 호스트 Redis) |

| E3 | 완료 (2026-10-30). SQL 021 원격 적용, 같은 JD 두 번째 호출은 캐시(LLM 0회)·직무 인접도 조회 확인 | mcp-server `normalize_job`(직무 enum·필수/우대·경력·근무지·원격, `parse_jd` 대체). orchestrator `lib/jobRequirements.ts`(jd 해시 캐시 `fit.job_requirements_norm`), `lib/roleTaxonomy.ts`(직무 인접도 시드 14쌍, DB 우선), `lib/jdPlan.ts` `requiredFilter`(A 단계: 직무 인접도 ≥0.5·경력 1년 여유·시·도 지역, 정보 없으면 통과) + `rankByRequirements`(필수 누락 적은 순 → 필수 1·우대 0.5). `/api/jd/plan` 응답에 `requirements`·`filteredOut`·`normalizedCount`·후보별 `mustCoverage`·`missingMust`·`roleAffinity` 추가(기존 필드 유지). 테스트 `test/requiredFilter.test.ts` (T6 포함 5건). 실데이터: 백엔드 JD → 개발자 9명 중 직무로 2명 제외 |

| 구직자 공고 추천 | 완료 (2026-10-30). SQL 022 적용, SQL 023 원격 적용 · viewed_at 기준 sweep 확인 (2명). 실후보 1명 계산 14건 저장 → 같은 입력 재실행 skipped 확인 | 이 엔진의 재료(정규화·사전)를 반대 방향(후보 → 공고)으로 쓴다. LLM 0회. `lib/jobRecommend.ts`(필수 조건 → 사전 기술 일치 → 가중합, 근거 문장 코드 생성, `inputs_hash` 로 재계산 생략), `queue/recommendQueue.ts`, `lib/recommendRoutes.ts`. talentfolio `/studio` 공고 탭 "추천 공고" 가 이것을 읽는다 (기존 fit_reports 기반 "추천받은 공고" 대체). **갱신 주기**: 조회는 저장본만 읽음(첫 조회만 계산) · 희망 조건 저장/추천 제외/정규화 결과 변경 시 그 사용자만 재계산 · 매일 `RECOMMEND_SWEEP_CRON`(05:00)에 최근 `RECOMMEND_ACTIVE_DAYS`(14)일 안에 본 사용자만 (023 전에는 계산 이력 있는 전원). 후속: 공고가 수만 건이 되면 `job_postings.skills` GIN 인덱스로 후보 생성 후 점수 계산 (지금은 최대 `RECOMMEND_SCAN_MAX` 5000건 스캔) |

E2 구현 메모:
- profiles 에 `updated_at` 이 없어 변경 이벤트 대신 **매일 sweep** 을 안전망으로 둔다 (대부분 1단계에서 멈춤). talentfolio 저장 시 즉시 호출하는 훅은 미결 Q2.
- 의미가 같다고 판정되면 해시만 갱신하고 지문은 이전 값을 유지 → 조금씩 바뀌는 누적 변화도 결국 문턱 아래로 내려가 재정규화된다.
- 정규화 잡이 실행 중일 때 들어온 같은 후보 수정은 디바운스 키에 막혀 버려진다 → 다음 sweep 이 잡는다.
- 하루 상한(`NORMALIZE_DAILY_MAX`)은 **LLM 정규화 횟수에만** 건다. 1~3 단계 확인은 몇 번이든 한다 (첫 실행 후 발견해 수정).
- 첫 실행 미매핑 상위: Design System, Prototyping, OpenAI API, Jetpack Compose, Solidity, Storybook, Prisma, Blender 등 → 사전 보강 후보. 디자이너는 기술 대부분이 사전 밖이라 디자인 쪽 사전 보강이 우선.
- `generateStructured` 는 temperature 를 따로 주지 않는다 (흔들림은 enum·사전 매핑·결과 비교의 0.5년 반올림으로 흡수).

## 14. 미결 사항
- Q1. 초기 `skill_dictionary` 시드 출처 → **수동 시드(코드)로 시작**. 크롤 공고 빈도 추출로 보강은 `skill_unmapped` 쌓인 뒤.
- Q2. 후보 변경 이벤트 방식 (talentfolio 호출 vs `updated_at` 폴링).
- Q3. 후보 프로필 입력을 선택형 칸으로 바꾸는 범위 (talentfolio `/studio` UI 변경 필요).
- Q4. 요금제별 `daily_llm_cap` 값.
- Q5. 역할 enum 최종 목록 (현재 developer/designer 2종에서 확장).

## 15. 변경 이력
| 날짜 | 내용 |
|---|---|
| 2026-10-30 | 초안: 깔때기·정규화·사전·벡터·순위식·품질 지표·상시 수색 |
| 2026-10-30 | 변경 감지 4단계(의미 지문)·쿨다운, 층별 가중치 보정 추가 |
| 2026-10-30 | 개발자 문서 양식으로 재작성 (데이터 모델·인터페이스·설정·테스트 기준) |
| 2026-10-30 | 구직자 공고 추천을 /studio 에 연결, 조회 시 재계산 제거 → 이벤트 + 야간 배치(SQL 023) |

# 07. Phase 5 설계 — RAG 대화형 검색 & B2B 소싱 MCP

> **상태**: 설계 착수 단계 (미구현). Phase 0~4가 끝난 뒤 본격 구현하며, 이 문서는
> 구현 전 아키텍처 헌법(루트 [CLAUDE.md](../../CLAUDE.md)) 위반 여부를 미리 점검하기
> 위한 스펙이다. 구현 착수 시 이 문서를 갱신하며 진행한다.

---

## A. RAG 기반 "포트폴리오와 대화하기"

### A.1 목표

리크루터가 특정 후보자(또는 후보자 풀 전체)의 포트폴리오에 대해 자연어로 질문하면,
관련 문서 조각(청크)을 검색해 근거 기반으로 답변한다.
예: "이 후보자가 React Query를 실제로 써본 프로젝트가 있어?"

### A.2 데이터 소스 & 저장 위치 (중요한 결정)

- talentfolio Supabase `profiles`는 **읽기 전용**이므로 거기에 `pgvector` 컬럼/테이블을
  추가할 수 없다 (anon key, RLS 읽기 전용 정책).
- 따라서 **임베딩/청크는 jd-fit-analyzer 자체 Supabase**(현재 `fit_reports`가 있는
  프로젝트, service_role 접근)에 별도 테이블로 둔다.
- talentfolio `profiles`는 "원본(source of truth)", jd-fit-analyzer 쪽 테이블은
  "검색 인덱스(read replica 성격의 파생 데이터)"로 취급한다.

```sql
-- jd-fit-analyzer 자체 Supabase, pgvector 확장 필요
create extension if not exists vector;

create table portfolio_chunks (
  id uuid primary key default gen_random_uuid(),
  candidate_id text not null,        -- talentfolio profiles.id 참조 (FK 아님, 다른 프로젝트)
  source_field text not null,        -- 'long_bio' | 'project_description' | ...
  chunk_index int not null,
  content text not null,
  embedding vector(768),             -- Gemini text-embedding-004 차원
  content_hash text not null,        -- 원본 변경 감지용 (재임베딩 스킵)
  created_at timestamptz not null default now()
);

create index on portfolio_chunks using hnsw (embedding vector_cosine_ops);
create unique index on portfolio_chunks (candidate_id, source_field, chunk_index);
```

### A.3 임베딩 생성 파이프라인 (Anti-Blocking 준수)

- **트리거**: 신규 후보자 분석 요청 시(`/api/analyze`) 또는 별도 배치(`POST /api/candidates/:id/reindex`).
- HTTP 요청 흐름에서 임베딩 생성을 동기로 돌리지 않는다 — **BullMQ `embedding` 큐**에
  작업을 등록하고 워커가 처리.
- 처리 절차:
  1. `get_candidate_portfolio`로 `CandidatePortfolio` 조회 (기존 MCP tool 재사용)
  2. `long_bio`/프로젝트 설명 등을 [02. prune 어댑터](02_data_pruning_adapter.md) 통과 후
     문단/문장 단위로 청크 분할 (예: 300~500자, 문장 경계 보존)
  3. 각 청크의 `content_hash`(sha256)를 계산해 기존 row와 비교 — 변경된 청크만 재임베딩
     (비용 절감)
  4. `@google/genai`로 임베딩 생성:

```typescript
import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({});

async function embedChunks(texts: string[]): Promise<number[][]> {
  const response = await ai.models.embedContent({
    model: "text-embedding-004",
    contents: texts,
  });
  return response.embeddings.map((e) => e.values); // 응답 속성 접근 — getGenerativeModel 패턴 금지 (절대 규칙 1)
}
```

  5. `portfolio_chunks`에 upsert (jd-fit-analyzer 자체 Supabase, service_role)

### A.4 검색(retrieval) & 답변 생성 흐름

```
리크루터 채팅 입력 (web UI)
  → POST /api/portfolio-chat  { candidateId, question }
  → 202 Accepted + jobId (Anti-Blocking, 기존 SSE 패턴 재사용)
  → 워커:
      1) question을 text-embedding-004로 임베딩
      2) portfolio_chunks에서 candidate_id 필터 + cosine similarity top-k(예: 5) 검색
      3) 검색된 청크를 prune (불필요 메타데이터 제거, 길이 합산 상한 적용 — 절대 규칙 3)
      4) Gemini Flash에 "다음 근거 자료만 사용해 답변하라" 프롬프트 + 청크 주입
         → responseJsonSchema로 { answer, cited_chunk_ids } 강제
      5) 결과를 SSE로 스트리밍 반환
```

- **모델 계층화**: 검색 결과 기반 답변 생성은 반복적이고 좁은 작업이므로 Gemini Flash
  사용 (CEO/Claude Sonnet 불필요).
- **환각 방지**: `cited_chunk_ids`를 강제해 UI에서 "어느 포트폴리오 문장을 근거로 했는지"
  하이라이트 표시 — 근거 없는 답변과 구분.
- **캐싱**: 동일 `(candidateId, question 정규화 해시)`는 짧은 TTL(예: 1시간) Redis 캐시.
  JD 분석 캐시와 동일한 패턴이나 별도 키 네임스페이스(`portfoliochat:cache:...`) 사용.

### A.5 신규 MCP tool

| tool | input | output | 비고 |
|---|---|---|---|
| `search_portfolio_chunks` | `{ candidateId, queryEmbedding, topK }` | `{ chunks: PortfolioChunk[] }` | jd-fit-analyzer 자체 Supabase(service_role) 조회, prune 적용 |
| `embed_and_index_portfolio` | `{ candidateId }` | `{ chunksUpdated: number }` | A.3 파이프라인 실행 (워커 전용, 사용자 직접 호출 X) |

기존 `mcp-server/src/tools/`에 추가 — [add-analysis-agent 스킬](../../.claude/skills/add-analysis-agent/SKILL.md)과
동일한 절차(tool 등록 → wire schema → prune 어댑터 매핑)를 따른다.

---

## B. MCP 기반 B2B 사내 소싱 툴

### B.1 목표

리크루터가 내부 인재 DB(talentfolio profiles + jd-fit-analyzer의 FitReport 이력)를
조건 검색하고, Slack 알림/Jira 티켓 생성 같은 **외부 시스템에 영향을 주는 액션**을
실행할 수 있게 한다. 단, 모든 쓰기 액션은 **실행 전 HIL(인간 승인) 게이트**를 통과해야 한다.

### B.2 별도 MCP 서버로 분리하는 이유

- 기존 `mcp-server/`(분석 전용, 읽기 전용 Gemini 호출)와 **권한 범위가 다르다**
  (Slack/Jira 쓰기 권한은 별도 자격증명·스코프 필요).
- 장애/보안 격리: 소싱 툴의 외부 연동 장애가 분석 파이프라인에 영향을 주지 않도록
  `sourcing-mcp-server/`로 프로세스를 분리.

```
jd-fit-analyzer/
├── mcp-server/             — 기존 (분석: get_candidate_portfolio, analyze_*)
├── sourcing-mcp-server/    — 신규 (소싱: search_talent_db, draft_slack_message, create_jira_ticket)
└── orchestrator/
```

### B.3 신규 MCP tool 명세

| tool | input | output | 부작용(side-effect) | HIL 필요 |
|---|---|---|---|---|
| `search_talent_db` | `{ filters: {...}, limit }` | `CandidatePortfolio[]` (prune 적용) | 없음 (읽기 전용) | ❌ |
| `get_fit_report_history` | `{ candidateId }` | `FitReportRecord[]` | 없음 (jd-fit-analyzer 자체 DB 조회) | ❌ |
| `draft_slack_message` | `{ channel, candidateId, template }` | `{ draftId, previewText }` | **없음** — 초안만 생성, DB에 `pending_review` 상태로 저장 | (초안 생성은 불필요, 실제 전송에서 필요) |
| `execute_pending_action` | `{ actionId }` | `{ status: "sent" \| "failed" }` | **Slack 전송 / Jira 티켓 생성 실제 발생** | ✅ 필수 |

### B.4 HIL 승인 게이트 — 기존 패턴 재사용

[04. HIL 타임아웃](04_hil_timeout.md)에서 사용한 `fit_reports.status` 상태 머신 패턴을
그대로 차용해 `sourcing_actions` 테이블을 둔다 (jd-fit-analyzer 자체 Supabase).

```sql
create type sourcing_action_status as enum (
  'draft', 'pending_review', 'approved', 'rejected', 'executed', 'failed', 'expired'
);

create table sourcing_actions (
  id uuid primary key default gen_random_uuid(),
  action_type text not null,        -- 'slack_message' | 'jira_ticket'
  candidate_id text,
  payload jsonb not null,           -- 실행에 필요한 데이터 (channel, message, ticket fields...)
  status sourcing_action_status not null default 'draft',
  user_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

흐름:

```
1. draft_slack_message tool 호출 → sourcing_actions row 생성 (status='pending_review')
   ※ 이 단계에서 Slack API는 호출하지 않음 (Anti-Blocking + 안전성)
2. 리크루터가 review 화면(기존 /review 페이지 확장)에서 미리보기 확인 후 승인/반려
   POST /api/sourcing-actions/:id/review  { action: "approve" | "reject" }
3. 승인 시 status='approved' → BullMQ 'sourcing-execute' 큐에 작업 등록
4. 워커가 execute_pending_action MCP tool 호출 → 실제 Slack/Jira API 호출
   → 성공 시 status='executed', 실패 시 'failed' (에러는 06. 모니터링 문서의
     Sentry로 추적)
5. (04와 동일) 24시간 내 미승인 시 status='expired' — 타임아웃 워커 재사용
```

- **절대 규칙 2 (Anti-Blocking) 준수**: draft 생성과 실제 실행을 분리하고, 실행은
  큐 워커가 담당. HTTP 요청-응답 주기에서 Slack/Jira API를 동기 호출하지 않는다.
- **승인 없이는 외부 시스템에 어떤 변경도 발생하지 않는다** — `execute_pending_action`은
  `status='approved'`인 row에 대해서만 워커가 호출.

---

## C. 공통 — 절대 규칙 적용 체크리스트 (구현 착수 시 재확인)

| 규칙 | A. RAG | B. 소싱 MCP |
|---|---|---|
| 1. `@google/genai` + `responseJsonSchema` | 임베딩(`embedContent`)·답변 생성(Flash) 모두 적용 | LLM 미사용 영역이 많음 (검색/Slack/Jira는 일반 API) — LLM 사용 시(예: 메시지 초안 생성)에만 적용 |
| 2. 비동기 큐 (BullMQ) | 임베딩 생성, 채팅 응답 생성 모두 큐+워커 | draft 생성은 동기 가능(LLM 호출 없으면 빠름), **실행은 반드시 큐** |
| 3. 선 정제 후 주입 | 검색된 청크 prune + 길이 상한 후 프롬프트 주입 | `search_talent_db` 결과 prune 후 LLM(있다면)에 주입 |

---

## D. 미해결 의사결정 (구현 전 확인 필요)

1. **임베딩 모델 차원/모델명**: `text-embedding-004`(768차원) vs 최신 `gemini-embedding-001`
   — 구현 시점의 `@google/genai` 최신 권장 모델 확인 필요.
2. **talentfolio 데이터 동기화 주기**: 후보자가 포트폴리오를 수정하면 jd-fit-analyzer
   쪽 `portfolio_chunks`가 stale해짐. 분석 요청 시점에 `content_hash` 비교로 즉시
   갱신하는 lazy 방식으로 충분한지, 별도 동기화 배치가 필요한지 결정.
3. **Slack/Jira 자격증명 관리**: 사내 워크스페이스 OAuth 토큰을 어디(Vault/env)에
   저장할지, 토큰 만료 시 재인증 흐름.
4. **다중 리크루터 권한**: `sourcing_actions.user_id`로 작성자만 승인 가능하게 할지,
   팀 단위 승인 권한을 둘지 — `userId`/`tier` 외 역할(role) 모델 필요 여부.

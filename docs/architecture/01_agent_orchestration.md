# 01. 에이전트 오케스트레이션

> 절대 규칙(Pillars)은 [루트 CLAUDE.md](../../CLAUDE.md)를 따른다. 이 문서는 실행 흐름과
> 타입/스키마의 상세 스펙을 다룬다. 실제 실행 절차(호출 순서, 검증 기준)는
> [.claude/skills/fit-analysis/SKILL.md](../../.claude/skills/fit-analysis/SKILL.md) 참고.

---

## 아키텍처

```
recruiter (web UI)
      │  JD 텍스트 입력 + 후보자 선택
      ▼
┌─────────────────────────────┐
│ Orchestrator (코드)            │  결정론적 로직 + MCP client + BullMQ 워커
│ - 정해진 순서로 tool 호출       │
│ - 1차 검증(규칙 기반, 무료)      │  ← 명백한 포맷/모순만 사전 필터링
└──────────┬────────────────────┘
           │ MCP (stdio transport, 로컬 child process)
           ▼
┌─────────────────────────────┐
│ MCP Server (mcp-server/)       │
│ ├─ get_candidate_portfolio     │ → Supabase profiles 조회 (LLM 호출 없음, prune 어댑터 통과)
│ ├─ analyze_tech_stack          │ → Gemini Flash structured output (JSON)
│ └─ analyze_experience          │ → Gemini Flash structured output (JSON)
└──────────┬──────────────────────┘
           │ AgentResult x2 (+ 1차 검증 플래그)
           ▼
┌─────────────────────────────┐
│ CEO Agent (Claude Sonnet)      │  최종 판단 — 1회 호출
│ - 두 결과의 신뢰성/모순 재검토   │
│ - overallScore/verdict 결정     │
│ - 필요시 특정 tool 재작업 지시   │ (최대 1회, rework 파라미터로 재호출)
│ - ceoSummary 작성 → FitReport   │
└─────────────────────────────┘
```

### 왜 이 구조인가
- **역할 분리**: 기술 스택 검증과 경험/트러블슈팅 평가를 별도 tool(에이전트)로 분리해 환각을 줄이고
  각 결과를 독립적으로 검증 가능하게 함.
- **구조화 출력 강제**: 모든 tool은 JSON 스키마(`shared/types.ts`의 `AgentResult`)를 반환해야
  CEO 에이전트가 파싱 실패 없이 취합 가능.
- **MCP client/server 분리**: 새 분석 에이전트(예: 컬처핏, 커뮤니케이션 스타일)를 추가할 때
  `mcp-server/src/tools/`에 tool 하나만 추가하면 됨 — CEO가 결과를 받아 종합 판단에 반영.
- **모델 계층화 (성능 vs 비용)**: 좁고 반복적인 분석(기술/경험 매칭)은 Flash로 충분하지만,
  여러 결과를 종합해 최종 점수·verdict·반려 여부를 판단하는 CEO는 추론 품질이 결과 신뢰도에
  직결되므로 고급 모델(Claude Sonnet)을 사용한다. CEO는 분석당 1회만 호출되므로 비용 영향은 작다.

---

## MCP Client 라이프사이클 (BullMQ 워커와의 결합)

[03. 큐 시스템](03_queue_system.md)의 BullMQ 워커(concurrency 8+2)는 매 job마다 MCP
서버를 stdio child process로 새로 spawn하지 않는다. **워커 프로세스 시작 시 MCP 서버
child process를 1회 spawn해 MCP client 연결을 맺고, 해당 워커가 살아있는 동안 재사용**한다.

```typescript
// orchestrator/src/queue/workers.ts (스펙 예시)
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

let mcpClient: Client;

async function initMcpClient() {
  const transport = new StdioClientTransport({ command: "node", args: ["mcp-server/dist/index.js"] });
  mcpClient = new Client({ name: "jd-fit-orchestrator", version: "1.0.0" });
  await mcpClient.connect(transport);
}

// 워커 부팅 시 1회
await initMcpClient();
// 이후 모든 job 처리(runFitAnalysis)에서 mcpClient 재사용
```

- job마다 child process를 새로 띄우면 concurrency 8~10에서 프로세스 생성 오버헤드가
  누적되어 레이턴시가 증가한다.
- MCP 서버 프로세스가 병목/단일 장애점이 되면, [Phase 4의 stdio → HTTP/SSE transport
  전환](../../CLAUDE.md#진행-단계-phase)으로 여러 워커가 하나의 MCP 서버(HTTP)를 공유하도록
  확장한다.

---

## 공통 스키마 (shared/types.ts)

```typescript
export interface AgentResult {
  agent: "tech_stack" | "experience";
  score: number;            // 0-100
  summary: string;          // 1-2문장 평가 요약
  matched_items: string[];  // JD 요구사항 중 충족 항목
  missing_items: string[];  // JD 요구사항 중 미충족 항목
  evidence: string[];       // 포트폴리오에서 근거가 된 항목
  flags?: string[];         // 예: "low_confidence" — 재작업 루프를 통과 못한 경우
}

// CEO가 재작업을 지시할 때 tool에 함께 전달하는 컨텍스트
export interface ReworkContext {
  previousResult: AgentResult;
  feedback: string;         // 무엇이 잘못됐는지, 무엇을 재검토해야 하는지
}

export interface FitReport {
  candidateId: string;
  candidateName: string;
  overallScore: number;     // 0-100, CEO 에이전트가 가중 평균/판단으로 산정
  verdict: "strong_fit" | "possible_fit" | "weak_fit";
  techStack: AgentResult;
  experience: AgentResult;
  ceoSummary: string;       // CEO 에이전트의 종합 코멘트
  generatedAt: string;      // ISO timestamp
}

export interface CandidatePortfolio {
  id: string;
  name: string;
  role: "developer" | "designer";
  title: string | null;
  short_bio: string | null;
  long_bio: string | null;
  skills: string[];
  github_url: string | null;
  portfolio_url: string | null;
}
```

---

## MCP 서버 — Tool 명세

### get_candidate_portfolio
- **input**: `{ candidateId: string }`
- **output**: `CandidatePortfolio` (talentfolio Supabase `profiles` 테이블 조회)
- Supabase raw row는 [prune/정규화 어댑터](02_data_pruning_adapter.md)를 거쳐 `CandidatePortfolio`로 변환

### analyze_tech_stack
- **input**: `{ jd: string, portfolio: CandidatePortfolio, rework?: ReworkContext }`
- **output**: `AgentResult` (agent="tech_stack")
- JD에서 요구하는 기술 스택을 추출하고 `portfolio.skills`/`long_bio`와 비교
- `rework`가 전달되면, 이전 결과(`previousResult`)와 CEO의 `feedback`을 반영해 재평가

### analyze_experience
- **input**: `{ jd: string, portfolio: CandidatePortfolio, rework?: ReworkContext }`
- **output**: `AgentResult` (agent="experience")
- JD의 직무 경험/트러블슈팅 요구사항과 `portfolio.long_bio`/프로젝트 설명 비교
- `rework`가 전달되면, 이전 결과(`previousResult`)와 CEO의 `feedback`을 반영해 재평가

> 두 분석 tool 모두 `@google/genai`의 `responseSchema`로 위 JSON 형태를 강제 (텍스트 응답 금지)

---

## Gemini 호출 — @google/genai 표준 패턴

`analyze_tech_stack`/`analyze_experience` tool은 아래 패턴을 따른다 (구버전
`@google/generative-ai`의 `getGenerativeModel`/`response.text()` 패턴 금지).

```typescript
import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({}); // GEMINI_API_KEY 자동 탐색

const techAgentSchema = {
  type: "OBJECT",
  properties: {
    tech_score: { type: "INTEGER", description: "1~100 사이의 기술 스택 일치도 점수" },
    missing_stacks: {
      type: "ARRAY",
      items: { type: "STRING" },
      description: "JD에는 있으나 포트폴리오에 없는 기술",
    },
    analysis_reason: { type: "STRING" },
  },
  required: ["tech_score", "missing_stacks", "analysis_reason"],
};

async function analyzeTech(jd: string, portfolio: CandidatePortfolio) {
  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash", // 분석 에이전트는 항상 Flash (모델 계층화 정책)
    contents: `[JD]: ${jd}\n[Portfolio]: ${JSON.stringify(portfolio)}\n기술 스택만 분석해.`,
    config: {
      responseMimeType: "application/json",
      responseJsonSchema: techAgentSchema,
    },
  });

  return JSON.parse(response.text); // response.text는 속성 (함수 아님)
}
```

## 내부 표준 계약 vs Wire Schema

- **내부 표준 계약 (Internal Contract)**: `shared/types.ts`의 `AgentResult` / `FitReport` /
  `ReworkContext`. 오케스트레이터, 웹 UI, 캐시, DB는 **항상 이 타입에만 의존**한다.
- **Wire Schema**: `techAgentSchema`처럼 각 LLM(Gemini Flash, Claude Sonnet)에 최적화된
  응답 스키마. 모델/프롬프트 튜닝에 따라 필드명·구조가 달라질 수 있다.
- 모든 tool은 LLM이 wire schema로 응답한 raw JSON을 [02. prune/정규화 어댑터](02_data_pruning_adapter.md)에
  통과시켜 **내부 표준 계약(`AgentResult`)으로 변환한 뒤 반환**한다. 예) `techAgentSchema`의
  `tech_score` → `AgentResult.score`, `missing_stacks` → `AgentResult.missing_items`,
  `analysis_reason` → `AgentResult.summary`. `agent`/`evidence`/`flags`는 tool 코드에서
  채운다 (`evidence`는 prune 단계에서 `portfolio` 필드와 대조해 채움).
- **장점**: Gemini든 Claude든, 또는 추후 다른 모델로 바꾸더라도 wire schema와 어댑터
  매핑만 수정하면 되고, 오케스트레이터/웹 UI 코드는 변경할 필요가 없다.

---

## CEO 에이전트 (orchestrator/src/ceo.ts)

- **모델**: Claude Sonnet (claude-sonnet-4-6), Anthropic API tool use 기반 MCP client
- 오케스트레이터 코드가 MCP tool 2개(`analyze_tech_stack`, `analyze_experience`)를
  먼저 호출하고, **결과를 규칙 기반으로 1차 검증**(포맷/점수-근거 모순/환각 — 명백한 것만)
- 1차 검증 결과(+ 두 `AgentResult`)를 CEO에게 전달. CEO가 하는 일:
  1. 두 결과를 종합적으로 재검토 (1차 검증을 통과했더라도 미묘한 모순/근거 부족이 있는지 판단)
  2. `overallScore`/`verdict` 결정 (단순 가중평균이 아니라 JD의 강조점에 따라 가중치 조정 가능,
     조정 시 `ceoSummary`에 근거 명시)
  3. 특정 tool 결과가 신뢰할 수 없다고 판단되면 **`feedback`과 함께 해당 tool을 1회 재호출
     지시** (항목당 최대 1회)
  4. `ceoSummary` 작성 후 `FitReport` JSON 반환

### CEO 출력 스키마 (Anthropic tool-use, rework 지시 포함)

CEO는 **Claude Sonnet**이므로 Gemini의 `responseJsonSchema`가 아니라, **Anthropic의
tool-use를 강제 호출**하는 방식으로 구조화 출력을 강제한다: `tools`에 아래 스키마를
등록하고 `tool_choice: { type: "tool", name: "submit_ceo_decision" }`로 반드시 이 tool을
호출하게 만든다. (Anthropic `input_schema`는 표준 JSON Schema — 소문자 타입, `enum` 등)

```typescript
const ceoDecisionTool = {
  name: "submit_ceo_decision",
  description: "기술/경험 분석 결과를 교차 검증한 최종 판단을 제출한다.",
  input_schema: {
    type: "object",
    properties: {
      is_valid: { type: "boolean" },
      target_department: {
        type: "string",
        enum: ["TECH", "EXP", "BOTH", "NONE"], // 재작업 필요 부서. enum 값은 대소문자까지 정확히 일치해야 함
      },
      rejection_reason: { type: "string" }, // is_valid=false일 때 재작업 사유, 아니면 빈 문자열
      final_report: {
        // is_valid=true일 때만 의미 있는 값으로 채움. shared/types.ts FitReport 서브셋
        type: "object",
        properties: {
          overallScore: { type: "integer" },
          verdict: { type: "string", enum: ["strong_fit", "possible_fit", "weak_fit"] },
          ceoSummary: { type: "string" },
        },
        required: ["overallScore", "verdict", "ceoSummary"],
      },
    },
    required: ["is_valid", "target_department", "rejection_reason", "final_report"],
  },
};

async function evaluateAsCeo(jd: string, techResult: AgentResult, expResult: AgentResult, preCheck: PreCheckResult) {
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 2048,
    tools: [ceoDecisionTool],
    tool_choice: { type: "tool", name: "submit_ceo_decision" },
    messages: [
      { role: "user", content: `JD, 두 분석 결과, 1차 검증 플래그를 교차 검토해 결정하라.\n${JSON.stringify({ jd, techResult, expResult, preCheck })}` },
    ],
  });

  const toolUse = response.content.find((b) => b.type === "tool_use");
  return toolUse!.input as CeoDecision; // { is_valid, target_department, rejection_reason, final_report }
}
```

> **모든 필드를 `required`에 포함시킬 것**: 옵셔널 필드는 모델이 자주 누락해 다운스트림
> 파싱이 깨지기 쉽다. 값이 없을 때는 빈 문자열(`""`)/빈 배열(`[]`)을 반환하도록 프롬프트로
> 강제하는 것이 안전하다. (Anthropic/Gemini 공통 실전 규칙)
>
> `tool_choice`로 특정 tool 호출을 강제하면 Claude는 텍스트 응답 없이 해당 tool의
> `input`만 반환하므로, `responseJsonSchema`와 동등한 효과를 낸다.

### 피드백 루프 (State Machine — 캐싱 + 타겟 라우팅)

`while` + `maxAttempts`(2~3회 권장 — 1회 추가마다 토큰 비용이 2배가 되므로)로 무한루프를
방지하고, CEO가 지정한 `target_department`에 따라 통과한 에이전트는 재실행하지 않고
이전 결과를 그대로 재사용(캐싱)한다.

```typescript
async function runFitAnalysis(jd: string, candidateId: string) {
  const portfolio = await mcp.call("get_candidate_portfolio", { candidateId });

  let techResult: AgentResult | null = null;
  let expResult: AgentResult | null = null;
  let techFeedback = "없음";
  let expFeedback = "없음";
  let needTechRetry = true;
  let needExpRetry = true;

  const maxAttempts = 3;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const [tech, exp] = await Promise.all([
      needTechRetry
        ? mcp.call("analyze_tech_stack", { jd, portfolio, rework: { previousResult: techResult, feedback: techFeedback } })
        : Promise.resolve(null),
      needExpRetry
        ? mcp.call("analyze_experience", { jd, portfolio, rework: { previousResult: expResult, feedback: expFeedback } })
        : Promise.resolve(null),
    ]);
    if (tech) techResult = tech;
    if (exp) expResult = exp;

    const preCheck = runRuleBasedValidation({ techResult, expResult, portfolio });
    const ceoDecision = await ceo.evaluate({ jd, techResult, expResult, preCheck });

    if (ceoDecision.is_valid) {
      return buildFitReport(candidateId, techResult, expResult, ceoDecision.final_report);
    }

    needTechRetry = ceoDecision.target_department === "TECH" || ceoDecision.target_department === "BOTH";
    needExpRetry = ceoDecision.target_department === "EXP" || ceoDecision.target_department === "BOTH";
    techFeedback = needTechRetry ? ceoDecision.rejection_reason : "없음";
    expFeedback = needExpRetry ? ceoDecision.rejection_reason : "없음";
  }

  // 최대 재시도 초과 — low_confidence 플래그로 진행 (추가 재시도 없음)
  techResult!.flags = [...(techResult!.flags ?? []), "low_confidence"];
  expResult!.flags = [...(expResult!.flags ?? []), "low_confidence"];
  const ceoDecision = await ceo.evaluate({ jd, techResult, expResult, preCheck: { forced: true } });
  return buildFitReport(candidateId, techResult, expResult, ceoDecision.final_report);
}
```

- 통과한 에이전트(`needXxxRetry === false`)는 `Promise.resolve(null)`로 비용 없이
  건너뛰고 이전 `techResult`/`expResult`를 그대로 사용한다.
- `maxAttempts` 초과 시 추가 LLM 재시도는 하지 않고 `flags: ["low_confidence"]`를 붙여
  [04. HIL](04_hil_timeout.md)의 `pending_review` 상태로 넘긴다.
- 최종 출력은 반드시 `FitReport` 스키마 JSON (`buildFitReport`가 `ceoDecision.final_report` +
  `techResult`/`expResult`를 합쳐 생성)

---

## 토큰/비용 관리 정책

| 정책 | 내용 |
|---|---|
| **모델 계층화** | 분석 에이전트(`analyze_tech_stack`, `analyze_experience`) = **Gemini Flash** (저비용, 반복 호출). CEO 최종 판단 = **Claude Sonnet** (1회 호출, 고품질 추론 필요) |
| **호출 수 상한** | 후보자 1명 분석당 LLM 호출 최대 5회 (재작업 없으면 3회: Flash×2 + Sonnet×1) |
| **재작업 제한** | 항목(tool)당 최대 1회, 그 이상은 `flags: ["low_confidence"]`로 표시 후 진행 (재시도 무한루프 방지) |
| **CEO 호출 전 사전 필터링** | 명백한 포맷 오류/수치 모순은 코드가 먼저 검출해 CEO 프롬프트에 플래그로 포함 |
| **캐싱** | **Redis**에 `fitreport:cache:<jdHash>:<candidateId>` 키(TTL 설정)로 `FitReport`를 캐싱 — [BullMQ jobId](03_queue_system.md)와 동일한 키 형식을 사용해 재요청 시 LLM 재호출 없이 캐시된 결과 반환. JD 텍스트가 1글자라도 바뀌면 새 분석으로 취급. 별도 파일/메모리 캐시는 두지 않음(워커가 여러 프로세스로 떠 있어 캐시가 분리되는 문제 방지) |
| **다중 후보자 분석** | 웹 UI에서 후보자를 한 번에 여러 명 선택해도, 각 후보자는 독립적으로 위 상한이 적용됨. UI에 "최대 N명까지 동시 분석 가능" 안내 표시 (N은 추후 결정, 기본 5명) |
| **로깅** | 오케스트레이터는 분석 1건당 실제 LLM 호출 횟수(모델별)/토큰 사용량을 로그로 남겨 추후 비용 모니터링 가능하게 한다 |

분석 1건당 호출 횟수표/검증 기준 상세는 [fit-analysis 스킬](../../.claude/skills/fit-analysis/SKILL.md) 참고.

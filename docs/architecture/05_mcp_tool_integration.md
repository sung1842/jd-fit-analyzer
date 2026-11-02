# 05. MCP / Function Calling — 실시간 데이터 연동 & 토큰 폭탄 방어

> 절대 규칙 3 (선 백엔드 정제, 후 에이전트 주입)의 연장. 이 문서는 **분석 에이전트가
> 분석 도중 스스로 외부 도구를 호출**하는 패턴과, 그 결과가 거대할 때 메인 에이전트에
> 주입되기 전 압축하는 방어 레이어를 다룬다.

---

## 잘못된 접근 vs 올바른 접근

- ❌ **잘못된 접근**: 에이전트가 분석을 마친 뒤에 외부 데이터를 추가로 붙여주는 것 —
  이미 과거 지식만으로 판단을 끝낸 상태이므로 의미 없음.
- ✅ **올바른 접근**: 에이전트가 분석 중 "이 정보는 최신 데이터가 필요하다"고 판단하면
  스스로 도구(Function Call)를 호출하고, 그 결과를 받아 최종 판단에 반영한다. **데이터
  결합의 주도권은 에이전트(LLM)가 가지며, 코드는 에이전트가 요청한 쿼리를 대리 수행할
  뿐**이다.

---

## 적용 예시: `fetch_2026_market_trend`

`analyze_tech_stack`(`gemini-2.5-flash`)에 `functionDeclarations`를 등록해, 모델이 필요
시 최신 기술 트렌드를 MCP 서버로 조회하게 한다.

```typescript
const techAgentTools = [
  {
    functionDeclarations: [
      {
        name: "fetch_2026_market_trend",
        description: "특정 기술 스택의 최신 시장 트렌드를 실시간 조회",
        parameters: {
          type: "OBJECT",
          properties: { keyword: { type: "STRING" } },
          required: ["keyword"],
        },
      },
    ],
  },
];

async function analyzeTechWithTools(jd: string, portfolio: CandidatePortfolio) {
  const prompt = `[JD]: ${jd}\n[Portfolio]: ${JSON.stringify(portfolio)}\n트렌드 확인이 필요하면 도구를 써라.`;

  let response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: prompt,
    config: { tools: techAgentTools, responseMimeType: "application/json", responseJsonSchema: techAgentSchema },
  });

  const calls = response.functionCalls;
  if (calls && calls.length > 0 && calls[0].name === "fetch_2026_market_trend") {
    const freshData = await callMcpServer(calls[0].args.keyword, /* originalContext */ jd);

    response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [
        { role: "user", parts: [{ text: prompt }] },
        { role: "model", parts: response.candidates[0].content.parts },
        { role: "function", parts: [{ functionResponse: { name: "fetch_2026_market_trend", response: { content: freshData } } }] },
      ],
      config: { responseMimeType: "application/json", responseJsonSchema: techAgentSchema },
    });
  }

  return JSON.parse(response.text);
}
```

---

## 구조화 데이터(JSON 배열) 다이어트 — Node.js Filter/Map (1차 방어선)

MCP tool이 **대량의 구조화 배열**(예: 라이브러리 1,000개의 버전/호환성 정보)을 반환하는
경우, 이를 LLM(Flash)에게 "요약해줘"라고 시키는 건 비효율적이다 — 구조가 명확한
JSON은 굳이 LLM 없이도 **`Array.filter()` + `Array.map()`만으로 0원, 0초에 90% 이상
축소**할 수 있고, 환각(값 왜곡) 위험도 전혀 없다.

```typescript
// 가로 축(행) 필터링 + 세로 축(필드) 프로젝션 — 예시
function pruneToolResult(rawArray: Record<string, unknown>[], keyword: string) {
  return rawArray
    .filter((item) => String(item.tech_name).toLowerCase().includes(keyword.toLowerCase()))
    .map((item) => ({
      version: item.version,
      release_date: item.release_date,
      has_breaking_changes: item.has_breaking_changes,
    }));
}
```

- **별도 공용 함수로 모듈화하지 않는다**: 02번의 `pruneJsonData`(키 정규화)와 달리, 이
  필터링은 tool마다 "어떤 필드가 필요한가"가 다르므로 각 MCP tool 핸들러 내부에서
  그때그때 `filter`/`map`을 작성하는 것으로 충분하다.
- **Flash 압축 레이어(아래)보다 먼저 적용**: 구조화 배열은 이 단계에서 먼저 축소하고,
  그래도 남은 텍스트(예: README 본문 등 비구조화 필드)가 `COMPRESSION_THRESHOLD`를
  넘을 때만 Flash 압축을 추가로 거친다. 즉 ①Node.js filter/map(배열) → ②Flash 압축
  (텍스트) 순서.
- **소스 쿼리 필터링과의 관계**: MCP tool이 우리가 통제하는 DB/API(예: Supabase)를
  호출한다면, 가능한 한 쿼리 파라미터(`WHERE` 절 등) 단계에서 먼저 좁히는 것이 가장
  저렴하다(1차). 이 Node.js filter/map은 그 결과를 받은 뒤 한 번 더 좁히는 **항상
  켜진 2차 안전망**이며, 우리가 통제할 수 없는 외부 API/서드파티 MCP 응답에 대해서는
  유일한 방어선이 된다.

---

## 토큰 폭탄 방어 — Flash 압축 레이어

MCP가 반환하는 데이터가 거대할 때(예: 트렌드 리포트 50페이지), 메인 에이전트(`gemini-2.5-flash`
분석 에이전트 또는 CEO Claude Sonnet)에 그대로 주입하면 토큰 비용이 폭증하고 컨텍스트
희석으로 환각이 늘어난다. **단순 `substring` 자르기는 정보 손실이 크고, 재시도 반복은
더 비싸다.**

해결책: 메인 에이전트 앞에 **저가·고속 모델(Flash)을 "압축 레이어"로 배치**. 응답
길이가 임계치(예: 10,000자)를 초과하면, Flash에게 [원래 요구 맥락 + 원본 데이터]를
주고 핵심만 2,000자 이내로 압축해 메인 에이전트에 전달한다.

```typescript
const COMPRESSION_THRESHOLD = 10_000;
const COMPRESSION_TARGET = 2_000;

async function callMcpServer(keyword: string, originalContext: string): Promise<string> {
  const rawHugeData = await externalMcpApi.fetchData(keyword);

  if (rawHugeData.length > COMPRESSION_THRESHOLD) {
    const compressionPrompt = `
      다음 방대한 데이터에서 [요구 맥락]에 맞는 핵심 정보만 ${COMPRESSION_TARGET}자 이내로 압축해라.
      [요구 맥락]: ${originalContext}
      [방대한 데이터]: ${rawHugeData}
    `;
    const summary = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: compressionPrompt,
    });
    return summary.text;
  }

  return rawHugeData;
}
```

> 참고: 분석 에이전트가 이미 `gemini-2.5-flash`이므로(모델 계층화 정책), 압축 레이어도
> 같은 Flash를 쓴다 — "더 싼 모델로 내리는 것"이 아니라 "메인 추론 컨텍스트와 분리된
> 별도 호출로 거대 데이터를 격리·요약하는 것"이 핵심이다. 더 저렴한 티어(예: Flash-Lite)가
> 필요하면 Phase 4에서 교체 검토.

- 임계치 미만이면 원본을 그대로 반환 (불필요한 추가 LLM 호출 방지).
- 임계치 초과 시 Flash 압축 1회 호출 → [01. 토큰/비용 관리 정책](01_agent_orchestration.md#토큰비용-관리-정책)의
  "분석 1건당 LLM 호출 최대 5회" 상한에는 포함되지 않는 **MCP tool 호출 부수 비용**으로
  별도 로깅한다.
- Flash 압축 결과는 [02. prune 어댑터](02_data_pruning_adapter.md)를 거치지 않아도 됨 —
  이미 텍스트 요약이므로 JSON 정규화 대상이 아니다 (JSON 구조화 데이터의 다이어트는
  02번 `pruneJsonData`가 담당, 비구조화 텍스트의 다이어트는 이 Flash 압축 레이어가 담당).

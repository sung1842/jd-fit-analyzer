# 02. 데이터 Prune & 정규화 어댑터

> 절대 규칙 3 (외부 데이터 정규화 필수)의 상세 구현 스펙. 외부 API(Supabase, Gemini)
> 응답을 LLM 프롬프트/MCP tool 입력에 주입하기 전, 이 레이어를 반드시 거친다.

---

## 목적

- **JSON 폭탄 방지**: Supabase `profiles` row나 Gemini raw 응답에는 분석에 불필요한
  필드(메타데이터, null 필드, 대용량 텍스트 등)가 섞여 있을 수 있다. 그대로 프롬프트에
  넣으면 토큰을 낭비하고 모델이 핵심 정보에서 멀어진다(컨텍스트 희석).
- **스키마 변화에 대한 자가 치유**: Supabase 테이블 컬럼명이 바뀌거나(`portfolio_url` →
  `portfolioUrl` 등) Gemini 응답 키 표기가 미세하게 달라져도, 정규화 레이어가 흡수해
  하위 코드(`shared/types.ts` 타입)는 영향받지 않게 한다.

> ℹ️ 이 문서의 `pruneJsonData`는 **단일 객체의 키 이름 불일치(별칭) 정규화**를 다룬다.
> MCP tool이 반환한 **대량 JSON 배열 자체의 행/열 축소**(filter/map을 통한 데이터
> 다이어트)는 별개 주제이며 → [05. MCP tool 호출 / 대용량 응답 압축](05_mcp_tool_integration.md)
> 참고.

---

## pruneJsonData 함수 스펙

```typescript
// shared/lib/pruneJsonData.ts

type KeyDictionary = Record<string, string[]>; // 표준 키 -> 가능한 원본 키 후보들

export function pruneJsonData<T extends Record<string, unknown>>(
  raw: Record<string, unknown>,
  allowedKeys: (keyof T)[],
  keyDictionary: KeyDictionary = {}
): Partial<T> {
  const result: Partial<T> = {};

  for (const key of allowedKeys) {
    const candidates = [key as string, ...(keyDictionary[key as string] ?? [])];
    const matchedKey = candidates.find((c) => c in raw);
    if (matchedKey !== undefined) {
      (result as Record<string, unknown>)[key as string] = raw[matchedKey];
    }
  }

  return result;
}
```

- `allowedKeys`: 결과 타입(`CandidatePortfolio`, `AgentResult` 등)에 정의된 필드만 허용.
  그 외 필드는 자동 drop.
- `keyDictionary`: 표준 키에 대응하는 원본 키 후보 목록. 첫 매칭을 사용.
- 매칭되는 키가 전혀 없으면 해당 필드는 결과에서 생략(필수 필드라면 호출부에서
  zod 등으로 검증해 에러를 표면화할 것 — 이 함수는 silent fallback을 만들지 않는다).

---

## KEY_DICTIONARY 예시

```typescript
// mcp-server/src/lib/keyDictionary.ts

export const PORTFOLIO_KEY_DICTIONARY: KeyDictionary = {
  portfolio_url: ["portfolioUrl", "portfolio_link", "website_url"],
  github_url: ["githubUrl", "github_link"],
  short_bio: ["shortBio", "bio_short", "tagline"],
  long_bio: ["longBio", "bio", "description"],
};
```

- 새로운 키 변형이 발견되면 이 딕셔너리에 항목을 추가하는 것으로 대응 — 코드 변경 최소화.

---

## 적용 지점

| 지점 | allowedKeys 기준 | keyDictionary |
|---|---|---|
| `get_candidate_portfolio` (Supabase row → `CandidatePortfolio`) | `CandidatePortfolio`의 필드 목록 | `PORTFOLIO_KEY_DICTIONARY` |
| `analyze_tech_stack` / `analyze_experience` (Gemini raw JSON → `AgentResult`) | `AgentResult`의 필드 목록 | 필요 시 `AGENT_RESULT_KEY_DICTIONARY` (현재는 `responseSchema`로 강제되므로 보통 불필요, 방어용) |

> Gemini는 `responseSchema`로 출력 형태를 강제하므로 1차 방어선이 이미 있다. prune
> 어댑터는 **그래도 예상치 못한 필드가 섞여 들어왔을 때의 2차 방어선**이자, Supabase처럼
> 스키마를 직접 제어할 수 없는 외부 소스에 대한 **1차 방어선**이다.

---

## 자가 치유 어댑터 (Self-Healing Adapter)

`KEY_DICTIONARY`가 예측 못한 키(예: 외부 API가 `release_date`를
`distribution_timestamp_millis`로 바꿔 보내는 경우)가 등장하면 표준 키 값이 `"unknown"`으로
빠지며 무력화된다. 매번 LLM으로 원본 데이터를 분석하는 것은 레이턴시/비용 낭비이므로,
**평소엔 0원짜리 JS 코드(`pruneJsonData`/`normalizeAndPrune`)로 처리하고, `"unknown"`이
감지되는 예외 상황에서만 1회 LLM(Flash)을 호출**해 매핑을 추론시키고 `KEY_DICTIONARY`에
영구 반영한다(지연 평가, Lazy Evaluation).

```typescript
// mcp-server/src/lib/selfHealingAdapter.ts (스펙 예시)

async function getNormalizedDataWithSelfHealing<T extends Record<string, unknown>>(
  rawJsonArray: Record<string, unknown>[],
  allowedKeys: (keyof T)[],
  keyDictionary: KeyDictionary
): Promise<Partial<T>[]> {
  let processed = rawJsonArray.map((item) => pruneJsonData<T>(item, allowedKeys, keyDictionary));
  const isBroken = processed.some((item) =>
    allowedKeys.some((key) => item[key] === undefined || item[key] === "unknown")
  );

  if (isBroken) {
    console.warn("스키마 변형 감지! 자가 치유 어댑터 가동");
    const sample = rawJsonArray[0];

    const healingPrompt = `
      우리 시스템의 표준 키값: ${JSON.stringify(allowedKeys)}
      샘플 데이터: ${JSON.stringify(sample)}
      위 샘플에서 표준 키값에 매칭되는 실제 키를 { "표준키": "실제키", ... } 형식으로만 답해라.
    `;
    const healingResult = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: healingPrompt,
      config: { responseMimeType: "application/json" },
    });
    const newMapping: Record<string, string> = JSON.parse(healingResult.text);

    for (const [stdKey, realKey] of Object.entries(newMapping)) {
      keyDictionary[stdKey] = [...(keyDictionary[stdKey] ?? []), realKey];
    }

    processed = rawJsonArray.map((item) => pruneJsonData<T>(item, allowedKeys, keyDictionary));
  }

  return processed;
}
```

### 영속화 (중요)

`KEY_DICTIONARY`를 메모리 변수로만 두면 **서버/워커 재시작 시 학습한 매핑이 사라져** 매
재시작마다 동일한 healing 호출이 반복된다. 이 프로젝트는 이미 [BullMQ용 Redis](03_queue_system.md)를
사용하므로, healing으로 갱신된 매핑은 Redis(예: `key_dictionary:<table>` 해시)에 저장해
워커 기동 시 로드한다. DB(Supabase)에 별도 테이블로 두는 것도 가능하나, 조회 빈도가
높으므로 Redis 캐시를 우선한다.

---

## 검증

- 단위 테스트: `pruneJsonData`에 (a) 표준 키 그대로, (b) 딕셔너리 변형 키, (c) 불필요한
  추가 필드가 섞인 입력을 각각 넣고 결과가 `allowedKeys`만 포함하는지 확인.
- 통합 테스트: Supabase에서 실제 row를 가져와 `get_candidate_portfolio` 결과가
  `CandidatePortfolio` 타입과 일치하는지 zod 등으로 검증.

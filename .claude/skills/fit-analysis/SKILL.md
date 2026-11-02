---
name: fit-analysis
description: JD와 후보자 포트폴리오를 받아 멀티 에이전트(MCP) 분석을 실행하고 FitReport를 생성한다. "핏 분석", "JD 분석", "후보자 매칭" 요청 시 사용.
---

# Fit Analysis 워크플로우

JD(채용공고 텍스트)와 후보자 ID(또는 후보자 목록)가 주어졌을 때, 오케스트레이터
(`orchestrator/src/ceo.ts`)가 따라야 할 절차.

> **설계 원칙**: tool 호출 순서와 "명백한" 검증은 **코드(결정론적 로직)**가 담당해
> CEO가 사소한 문제까지 처음부터 추론하지 않게 하고, **종합 판단(점수/verdict/재작업
> 필요 여부/요약)은 CEO(Claude Sonnet)가 1회 호출로 수행**한다. 분석 에이전트는
> Gemini Flash. 자세한 내용은 [01. 에이전트 오케스트레이션의 토큰/비용 관리 정책](../../../docs/architecture/01_agent_orchestration.md#토큰비용-관리-정책) 참고.

## 절차

1. **포트폴리오 조회**: `get_candidate_portfolio` tool로 후보자 데이터를 가져온다. (LLM 호출 없음)

2. **분석 tool 호출 (고정 순서, 병렬)**: "호출할지 말지"를 매번 LLM이 판단하지 않는다.
   `analyze_tech_stack`, `analyze_experience`, `analyze_culture_fit`(모두 Gemini Flash)를
   **항상 병렬로 1회씩** 호출한다 (코드에서 `Promise.all`).
   - `analyze_culture_fit`: JD에 드러난 조직문화/협업 방식 요구사항과 포트폴리오의
     short_bio/long_bio를 비교해 컬처핏 적합도를 평가한다.
   - tool이 더 늘어나도 호출 여부는 코드 라우팅 규칙으로 처리한다.

3. **1차 검증 (코드, 명백한 것만, LLM 호출 없음)**
   - **포맷**: `AgentResult` 스키마(zod 등)를 satisfies하는지 확인.
   - **명백한 수치 모순**: `score >= 70`인데 `missing_items.length > matched_items.length`.
   - **명백한 환각**: `evidence`의 각 항목이 `portfolio`의 필드(`skills`, `long_bio`,
     `short_bio` 등)에 문자열로 전혀 존재하지 않음.
   - 이 단계는 **CEO 호출량을 줄이기 위한 사전 필터**일 뿐, CEO의 종합 판단을 대체하지 않는다.
     검증 결과(통과/실패 + 사유)는 4단계에서 CEO에게 함께 전달.

4. **CEO 종합 판단 (Claude Sonnet, 1회 호출)**
   - 입력: JD, 세 `AgentResult`(tech_stack/experience/culture_fit), 3단계의 1차 검증 결과(플래그)
   - CEO가 수행하는 일:
     1. 세 결과를 교차 검토 — 1차 검증을 통과했더라도 미묘한 모순(예: tech_stack과
        experience의 평가가 서로 상충), 근거 부족, 과장/축소 평가가 있는지 판단
     2. `overallScore` 산정 — 기본 가중치(tech_stack 0.5 / experience 0.3 / culture_fit 0.2)를
        참고하되, JD가 특정 영역을 명백히 강조하면 CEO가 가중치를 조정 가능
        (조정 시 `ceoSummary`에 근거 명시)
     3. `verdict` 결정: `overallScore >= 75` → `strong_fit`,
        `45~74` → `possible_fit`, `<45` → `weak_fit` (CEO는 이 기준선을 참고하되
        근거가 명확하면 경계값 근처에서 조정 가능 — 조정 시 사유를 `ceoSummary`에 명시)
     4. **재작업 필요 여부 판단**: 1차 검증 실패 항목, 또는 CEO가 직접 발견한 문제가
        있는 tool에 대해 `feedback`과 함께 **재호출 지시** (항목당 최대 1회)
     5. `ceoSummary` 작성

5. **재작업 (CEO가 필요 판단 시에만, 항목당 최대 1회)**
   - 대상 tool을 `{ jd, portfolio, rework: { previousResult, feedback } }`로 1회 재호출 (Flash).
   - 재호출 결과를 받아 CEO가 다시 한 번 반영해 최종 `FitReport` 확정 (추가 LLM 호출 없이,
     동일 CEO 호출의 연장으로 처리하거나 — 구현상 CEO가 tool-use로 재호출 후 같은 턴에서
     최종 응답 생성).
   - 그래도 검증 실패 시: `flags: ["low_confidence"]` 추가 후 진행, **추가 재시도는 하지 않음**.

6. **최종 출력**: `FitReport` JSON 1개 (shared/types.ts 참고).

## 분석 1건당 LLM 호출 횟수 상한

| 단계 | 모델 | 호출 수 |
|---|---|---|
| analyze_tech_stack | Gemini Flash | 1 (+재작업 시 +1) |
| analyze_experience | Gemini Flash | 1 (+재작업 시 +1) |
| analyze_culture_fit | Gemini Flash | 1 (+재작업 시 +1) |
| CEO 종합 판단 (재작업 지시 포함) | Claude Sonnet | 1 |
| **최대 합계** | | **7회** (재작업 없으면 4회) |

## 주의사항

- 모든 tool 응답은 JSON이어야 함 — 파싱 실패는 1차 검증 실패로 처리.
- `missing_items`는 후보자 탈락 사유가 아니라 "보완이 필요한 부분"으로 중립적으로 서술.
- 후보자 데이터에 없는 정보를 추측해서 `evidence`에 넣지 말 것 (환각 방지).
- 재작업은 **항목당 최대 1회**. 그 이후 실패해도 파이프라인은 계속 진행한다.
- 동일 `(jd, candidateId)` 조합은 [캐싱 정책](../../../docs/architecture/01_agent_orchestration.md#토큰비용-관리-정책)에 따라
  결과를 재사용하고 재호출하지 않는다.

---
name: add-analysis-agent
description: MCP 서버에 새로운 분석 에이전트(tool)를 추가하는 절차. "컬처핏 에이전트 추가", "새 분석 항목 추가" 등의 요청 시 사용.
---

# 새 분석 에이전트(tool) 추가 가이드

CEO 에이전트의 코드를 수정하지 않고도, MCP 서버에 tool을 하나 추가하는 것만으로
새로운 분석 축(예: 컬처핏, 커뮤니케이션 스타일, 포트폴리오 완성도 등)을 파이프라인에 편입시킬 수 있다.

## 절차

1. **타입 확장**: `shared/types.ts`의 `AgentResult["agent"]` union에 새 값 추가
   (예: `"culture_fit"`).
2. **tool 파일 생성**: `mcp-server/src/tools/<name>.ts`
   - 입력: `{ jd: string, portfolio: CandidatePortfolio }` (기존 tool과 동일 시그니처 유지)
   - 출력: `AgentResult` (agent 필드는 1번에서 추가한 값)
   - `mcp-server/src/lib/llm.ts`의 구조화 출력 래퍼를 사용해 Gemini 호출 + JSON schema 강제
3. **tool 등록**: `mcp-server/src/index.ts`의 tool 목록에 등록
   (이름, description, input schema). description은 CEO가 "언제 이 tool을 호출해야
   하는지" 판단하는 근거이므로 구체적으로 작성.
4. **FitReport 확장**: `shared/types.ts`의 `FitReport`에 새 필드 추가
   (예: `cultureFit?: AgentResult`) — optional로 두어 기존 리포트와 호환 유지.
5. **CEO 프롬프트는 수정 불필요**: CEO는 등록된 tool 목록을 보고 스스로 호출 여부를
   판단하므로, [fit-analysis](../fit-analysis/SKILL.md)의 "분석 tool 호출 판단" 절차에
   새 tool의 호출 조건만 한 줄 추가하면 됨.

## 체크리스트

- [ ] `shared/types.ts` — agent union, FitReport 필드 추가
- [ ] `mcp-server/src/tools/<name>.ts` — JSON schema 출력 강제
- [ ] `mcp-server/src/index.ts` — tool 등록 (description 명확히)
- [ ] `.claude/skills/fit-analysis/SKILL.md` — 호출 조건 1줄 추가
- [ ] 단독 테스트: tool을 직접 호출해 `AgentResult` 스키마 검증 후 CEO 통합 테스트

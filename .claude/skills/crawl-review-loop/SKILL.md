---
name: crawl-review-loop
description: 크롤 검수 기능(/crawling)을 Verifier·Reviewer 에이전트 루프로 검증하고 자동 수정해 고도화한다. "검수 루프 돌려", "크롤 검수 고도화", "루프 엔지니어링" 요청 시 사용.
---

# 크롤 검수 개선 루프

목표: 사람이 매번 지적하지 않아도, 에이전트가 검증 → 리뷰 → 수정을 반복해 검수 기능을 안정화한다.
설계 배경은 docs/architecture/13_dev_loop_plan.md §4.

## 역할
| 역할 | 실행 | 쓰기 |
|---|---|---|
| Lead (메인 세션) | 루프 진행·판정·수정 | 코드 + 문서 |
| `crawl-verifier` | 서브에이전트 | 없음 |
| `crawl-reviewer` | 서브에이전트 | 없음 |

수정은 Lead 한 명만 한다 (같은 파일에 두 명이 쓰지 않는다 — CLAUDE.md 충돌 이력).

## 한 회차
1. **병렬 실행**: `crawl-verifier` 와 `crawl-reviewer` 를 한 메시지에서 동시에 띄운다.
2. **분류** (Lead):
   - Verifier FAIL → 반드시 수정.
   - Reviewer `CONFIRMED` high/medium → 수정. `PLAUSIBLE` → 코드로 직접 확인 후 결정. low → 기록만.
   - 테스트 공백 → 해당 테스트를 `orchestrator/test/crawlReview.test.ts`(또는 crawler/tests)에 추가.
3. **수정**: 지적 1건 = 수정 + 그 지적을 재현하는 테스트 1개 (회귀 방지).
4. **재검증**: `bash scripts/verify-crawl-review.sh --db` 를 Lead 가 직접 실행.

## 종료 조건
- 통과: Verifier PASS + Reviewer 의 CONFIRMED high/medium 0건 → 종료, 문서 갱신.
- 상한: **3회차**. 넘으면 남은 지적을 정리해 사용자에게 보고하고 멈춘다.
- 같은 지적이 2회차 연속 나오면 설계 문제로 보고 사용자에게 올린다.

## 사람 승인이 필요한 것 (자동 진행 금지)
- 원격 DB 스키마 변경(새 SQL 적용). 단, 테스트용 `test-` 배치 생성·삭제는 허용.
- 실제 사이트 크롤 실행, 외부 발송.
- 규칙이 승인/제외 기준 자체를 바꾸는 변경(예: 샘플 비율, 광고 키워드 대량 추가).

## 피드백 원칙
- 에이전트에게 넘길 땐 로그 원문 대신 "실패 이름 + 핵심 에러 3줄".
- 회차마다 결과를 한 줄로 기록: `N회차: verifier=PASS/FAIL, reviewer=high x / medium y, 수정 z건`.

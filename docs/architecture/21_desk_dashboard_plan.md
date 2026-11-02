# 21. 기업 데스크(/desk) 홈 대시보드 기획 (2026-10-28)

> 루프 개선 한 줄: **스카우트 건 → 탐색 → 분석 → 승인 → 제안** 전 단계의 막힌 곳을 첫 화면 숫자로 드러내, 헤드헌터가 다음 행동을 바로 고르게 한다.
> 상위 문서: [20](20_company_side_plan.md) (화면 0 "홈"을 대체·구체화). 시안: [S_desk](../design/talentfolio-main/drafts/S_desk/index.html).

## 1. 자료조사 요약 (출처는 §8)
| 출처 | 확인된 것 | 우리에게 |
|---|---|---|
| LinkedIn Recruiter | 실질 홈 = **프로젝트(채용 건) 목록**, 건을 열면 Project Overview(파이프라인 단계별 인원·InMail 오픈/응답률·활동). AI/직접 작성 InMail 응답률 분리 리포트 | 건 카드마다 미니 퍼널. AI 추천 제안 vs 직접 제안 응답률 분리 |
| LinkedIn Hiring Assistant | 에이전트가 소싱, **사람이 단계마다 승인** | 우리 HIL 구조와 동일 → "에이전트가 한 일 / 내가 승인할 일"을 첫 화면에 |
| LinkedIn Talent Insights | 조건별 인재 **공급(회원 수) vs 수요(공고·InMail)**, 채용 난이도 | 건 조건으로 내부 후보 수 vs 크롤 공고 수 → 난이도 |
| Greenhouse/Lever/Ashby | time-to-fill, 퍼널 전환, 소스 효과. Ashby 는 **중앙값·p90** 권장, 전환율엔 **단계 변경 이력** 필요 | 시간 지표는 중앙값. 상태 이력 테이블 필요 |
| Bullhorn (에이전시) | Submittal-to-hire 3~4:1, fill rate, **time to first submit** | "첫 제안까지 시간"을 헤드라인 지표로 |
| 국내(리멤버·블라인드 하이어·사람인·그리팅) | 제안 중심, 건당 과금, 팀 공유 의견, 공고별 상태 한눈에 (첫 화면 통계 상세는 공개 자료로 확인 불가) | 팀 메모·공유 피드, 공고별 현황 |
| 대시보드 UX | 첫 화면 지표 5~7개, 행동이 바뀌는 지표만, **지난주 대비** 비교 필수. 허영 지표(총 분석 수·평균 점수) 금지 | 헤드라인 5개 + 보조 |
| 개인정보보호법 37조의2, EU AI Act 14조 | 사람 개입이 **실질적**이어야 자동화 결정이 아님 | 검토 품질 지표(근거 열람률·검토 시간·AI 추천 뒤집기율)를 운영 지표로 |

## 2. 설계 원칙
1. **숫자 → 행동**: 모든 지표 타일은 클릭하면 그 숫자를 만든 목록으로 간다 (예: 승인 대기 7 → `/review?status=pending`).
2. **비교 없는 숫자 금지**: 타일마다 지난 7일 대비 증감, 시간 지표는 중앙값.
3. **점수는 통계에 쓰지 않는다**: 평균 핏 점수·총 분석 수는 넣지 않는다(허영 지표, 근거 우선 원칙 20 §1).
4. **에이전트 일 vs 내 일 분리**: "에이전트가 밤사이 한 일" 요약 + "내 판단이 필요한 일".
5. **실질적 인적 개입을 보이게**: 검토 품질 패널은 숨기지 않는다 (규제 대응이자 팀 품질 관리).
6. **학력·나이 미수집**: 편향 지표는 직무·경력 구간·지역 등 수집 항목으로만.

## 3. 첫 화면 구성 (위→아래)
| 영역 | 내용 | 클릭 시 |
|---|---|---|
| A. 인사 + 주 행동 | "오늘 판단할 일 N건" + **주 버튼 "승인 대기 N건 검토 시작 →"**(/review), 보조 "응답 확인", 범위(나/팀)·기간(7/30일) | /review |
| B. 헤드라인 지표 5 | ① 승인 대기(최장 대기) ② 마감 임박 건(D-7) ③ 첫 제안까지(중앙값) ④ 후보 응답률(인원 병기, 30명 미만은 "표본 부족") ⑤ AI 추천 뒤집기 | 각 목록 |
| C. 파이프라인 퍼널 | 매칭 → 분석 완료 → 승인 → 제안 → 응답 → 면접. **% = 전 단계 대비**, 승인 % = 승인 ÷ 결정. 가장 많이 빠지는 단계 강조 | 단계별 후보 |
| D. 스카우트 건 현황 | 건 카드: 제목·고객사·마감 D-day·미니 퍼널·승인 대기 배지. D1 은 jd_hash 묶음으로 대체 | 건 상세 |
| E. 소식 피드 | 항목마다 링크. 유형: 에이전트 / 후보 응답 / 팀 / **주의**(카드 공개 철회·마감 임박). 시간 역순 | 해당 항목 |
| F. 공고·저장 후보 | 공고별 매칭·승인 한 줄 + 최근 저장 후보 진입 | 공고 / 후보 관리 |
| G. 인재풀 공급·수요 | 직무별 공개 후보 수 vs 시장 공고 수, 부족 역량 | 후보 관리 |
| H. 검토 품질 | 승인률, AI 추천 뒤집기, 근거 열람 후 승인, 설명 요구 기한, 거절 사유(칩 기준) | 결정 기록 |

- 상단 탭: `홈 | 후보 검토(대기 배지) | 스카우트 건 | 후보 관리 | 공고 | 설정`. 모바일에서 후보 검토가 첫 화면에 보이도록 2번째에 두고, 탭 끝을 흐리게 해 스크롤 가능함을 표시.
- 기존 찾기/비교/회사 건 탭은 각각 후보 관리, 후보 비교(20 §4), 스카우트 건으로 흡수.
- 데이터가 없는 지표는 **숫자 대신 "준비 중"**(시안의 D1 보기). 더미 숫자를 실제처럼 보이지 않는다.
- 모바일(≤820px): B 는 가로 스크롤, C 는 세로 막대.

## 4. 지표 정의와 데이터 (리뷰 1회차 반영)
| 지표 | 정의 | 원천 | 상태 |
|---|---|---|---|
| 승인 대기 | fit_reports status ∈ {completed, pending_review}. 최장 대기 = now − **updated_at**(분석 완료 근사; created_at 은 큐 투입 시각이라 부풀려짐) | fit_reports | **지금 가능** |
| 승인률 | approved ÷ (approved+rejected) | fit_reports | **지금 가능** |
| AI 추천 뒤집기 | (strong_fit 거절 + weak_fit 승인) ÷ 결정. **fit_reports 개별 결정(C1 이후)만** — sourcing_actions 쇼트리스트 승인은 제외 | fit_reports.report.verdict·review | **지금 가능** |
| 거절 사유 분포 | 검토 화면 고정 사유 칩 문자열로 집계, 직접 입력은 "기타". 정확히 하려면 `review.reasonCode` enum 추가 | report.review.reason | 지금 가능(근사) |
| 공급·수요 | 직무별 공개 후보 수 / 공고 수 | profiles.role(developer/designer 2종), job_postings.title·skills | **부분 가능** — 2직무만. 세분화는 스킬→직무 매핑 규칙 또는 공고 카테고리 병합 필요 |
| 마감 임박·진행 중 건 | 스카우트 건 마감일 기준 | jd_runs 확장(고객사·담당·마감) | C2 |
| 첫 제안까지 | 건 생성 → 첫 **후보 대상 제안** 발송, 중앙값 | jd_runs + sourcing_actions | C2 + 신규: 현재 `sourcing_actions.type` 은 `slack_notify`(사내 알림)뿐이라 후보 제안이 아님 → `candidate_offer` type 신규, `jd_run_id` 컬럼(FK) 추가 |
| 응답률 (AI/직접) | 응답 ÷ 후보 제안. 분리: `jd_analysis`=AI, `jd_manual`=AI 쇼트리스트에서 사람이 고름(AI 보조), `manual`·`channel_invite`=직접 | candidate_offer + 응답 상태 | D4 (`replied/declined`, `responded_at`). 참고: autoSourcing.ts 로컬 타입에 `manual` 누락 — 정리 필요 |
| 제안→면접 | 면접 ÷ 후보 제안 | 면접 단계 상태 | D4 |
| 퍼널 | 단계별 인원·전 단계 대비 % | 위 합산 + `status_events` 이력 | 매칭·분석·승인은 지금, 제안 이후 D4 |
| 근거 열람 후 승인·검토 시간 | 승인 전 카드 열람 여부, 열람→결정 시간 | profile_views | D4 |
| 설명 요구 기한 | 요청일 + 30일 | 신규 요청 테이블 | D4 |

- 집계는 orchestrator `GET /api/desk/summary?range=7d` 하나로(코드 집계, LLM 없음 — 헌법 3조). 무거우면 BullMQ 반복 작업으로 미리 계산해 Redis 캐시(헌법 2조).
- 표본이 작을 때(분모 30 미만) %가 아닌 "n/N명"으로 표시.

## 5. 하지 말 것
평균 핏 점수·총 분석 수 타일, 후보 개인 순위표, 학력/나이 그룹 통계, 비공개 기록 기반 수치, 승인 없는 자동 발송 버튼.

## 6. 구현 순서
| 단계 | 내용 |
|---|---|
| D1 | `/api/desk/summary` (승인 대기·승인률·뒤집기·거절 사유·공급수요 2직무·퍼널 앞 3단계) + 홈 A/B①⑤/C 앞부분/H 일부 |
| D2 | 소식 피드(E) — 에이전트 분석 완료·팀 결정·카드 철회만 (기존 테이블 시각 합성). 응답·마감 항목은 C2/D4 |
| D3 | C2 스카우트 건과 함께 D 영역·진행 중 건·첫 제안까지 |
| D4 | `candidate_offer`·응답 상태·status_events·profile_views·설명 요구 → 응답률·퍼널·검토 품질 완성 |

## 7. 시안
[S_desk/index.html](../design/talentfolio-main/drafts/S_desk/index.html) — 더미 수치. 상단 토글로 **지금 데이터(D1)** / **완성형(D4)** 전환. v1 은 index_v1.html.

## 8. 출처
- LinkedIn Project Overview: https://training.talent.linkedin.com/meet-recruiter-project-overview , https://tcommunity.linkedin.com/product-tips-190/meet-recruiter-project-overview-419
- LinkedIn 리포팅(AI InMail 분리): https://business.linkedin.com/talent-solutions/product-update/new-reporting-for-data-driven-recruiting
- Hiring Assistant: https://business.linkedin.com/hire/hiring-assistant
- Talent Insights: https://business.linkedin.com/au/en/hire/talent-insights/product-tour
- Ashby 분석: https://improvado.io/blog/ashby-analytics · Greenhouse: https://support.greenhouse.io/hc/en-us/articles/8837686136987-Which-report-should-I-use
- Bullhorn KPI: https://www.bullhorn.com/blog/4-kpis-for-staffing-agencies/
- 국내: https://www.venturesquare.net/810335/ (리멤버), https://www.nextunicorn.kr/content/294adf52cedf7595 (블라인드 하이어), https://yozm.wishket.com/magazine/product-valley/products/greeting (그리팅)
- 대시보드 원칙: https://www.juiceanalytics.com/writing/5-rules-for-successful-success-metrics
- 37조의2: https://www.jipyong.com/newsletter_alert/240329_2/index.html · EU AI Act: https://artificialintelligenceact.eu/what-the-act-means-for-staffing-businesses/
- 한계: 국내 플랫폼 첫 화면 통계는 공개 자료로 확인 불가. EU AI Act 고위험 적용 시점은 자료마다 다름(원문 확인 필요).

## 9. 구현 상태 (2026-10-28)
| 단계 | 상태 | 내용 |
|---|---|---|
| D1 지표 | 완료 | orchestrator `GET /api/desk/summary` (lib/deskMetrics.ts 순수 집계 + deskRoutes.ts). talentfolio `/desk` 홈(새), 기존 작업대는 `/desk/candidates`(후보 관리). 공통 탭 `components/desk/DeskTabs.tsx` |
| D2 소식 | 완료 | summary 응답의 `feed` (분석 완료·팀 결정·공개 철회. 응답·마감은 017 후) |
| D3 스카우트 건 | 코드 완료 · 017 적용됨(2026-10-29) | jd_runs 확장 컬럼이 있으면 고객사·담당·마감·D-day·마감 임박 건 표시 |
| D4 제안·열람·이력 | 완료 · 017 적용됨(2026-10-29), 화면 E2E 확인 | `/review` 승인 후보 "제안 초안" → 홈 "제안"에서 발송 승인/응답 기록. 열람 기록(`POST /api/desk/views`), 결정 이력(status_events), 설명 요구 기한 |
- SQL: [017_desk_metrics.sql](sql/017_desk_metrics.sql) — 2026-10-29 원격 적용. 설명 요구 기한은 생성 컬럼 불가(immutable 아님)라 코드에서 요청+30일로 계산.
- E2E(10-29): 승인 후보 제안 초안 → 홈에서 발송 승인 → "면접 잡음" 기록 → 퍼널 제안1·응답1·면접1, 소식에 응답 항목 확인.
- 남은 갭: `/api/analyze` 경로는 jd_runs 를 만들지 않아 제안의 jd_run_id 가 비고 "첫 제안까지"가 계산되지 않음 → C2(스카우트 건 생성 시 jd_runs 행) 에서 해결. 마감일 입력 화면도 C2.
- 보안: 데스크 API 는 토큰 필수(legacy `?userId=` 폴백 차단). 제안 상태 전이는 조건부 갱신(중복 승인 409).
- 성능: 시장 지표(공급·수요·부족 역량)는 프로세스 메모리 10분 캐시. 홈은 summary 한 번 호출(소식 포함). 남은 과제: fit_reports 전체 조회 → 기간 제한 쿼리, 사용자 많아지면 BullMQ 반복 집계 + Redis.
- 한계: 제안의 실제 전달 채널(앱 알림·메일)은 C4. 지금 "발송 승인" = 플랫폼 내 발송 기록. 직무 세분화(백엔드·데이터)는 스킬→직무 규칙 이후.
- 검증: orchestrator 테스트 57/57(데스크 10건 포함), tsc 통과, 브라우저 실데이터(대기 1·결정 2·소식 3) + 375px 가로 넘침 없음. 코드 리뷰 1회(11건) 반영.

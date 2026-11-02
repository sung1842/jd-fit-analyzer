# 시안 C — 인터랙션·전환 중심 (UX)

**콘셉트**: "고르고, 만져보고, 바로 시작" — 첫 화면에서 역할을 고르면 히어로 미니 데모가 그 역할의 언어로 바뀌고, 4번의 클릭(JD 입력 → 후보 → 핏 점수 → 승인)으로 제품 루프를 체험한 뒤 같은 자리에서 역할별 CTA로 이어진다.

## 1. 전체 양식 레퍼런스 (awwwards)
| 사이트 | 수상 | 차용점 |
|---|---|---|
| [Radian](https://www.awwwards.com/sites/radian) | SOTD 2026-07-04 (시안 A 조사 인용, 스니펫 기준) | 제품을 단계별로 펼쳐 보이는 리듬 → 히어로 데모 4단계 스테퍼와 워크스루 챕터 구성(브리프 #1·#2). 스크롤 구동 대신 클릭 구동으로 바꿈. |
| [Kinetic V5](https://www.awwwards.com/sites/kinetic-v5) | SOTD (시안 B 조사 인용) | 무채색 + 포인트 1색, 숫자를 대형 타이포로 → 숫자 띠, copper 단일화(브리프 #5·#6). |
| [ON Recruitment](https://www.awwwards.com/sites/on-recruitment) | Honorable Mention 2024-11 | 채용 도메인에서 "조작하는 사이트". 히어로 상단 인터랙티브 내비 → 역할 토글 위치·크기. 스트리트 그래픽 톤은 차용 안 함. |

(v1 의 NEUROFIT 은 수상작이 아닌 Inspiration 항목이라 제외. 2026 SOTD 중 SaaS 인터랙티브 데모 사례는 찾지 못함 — Handhold 는 Nominee 라 미채택.)

## 2. 사용자 흐름
- **첫 5초**: 헤드라인 "AI가 찾고, 사람이 승인합니다" + 세그먼트 토글 [지원자 | 헤드헌터]. 기본값 헤드헌터(B2B 수익 루프가 프로젝트 취지). 데모 첫 단계에 JD 한 줄이 미리 채워져 있고 "분석 시작" 버튼이 맥박처럼 1회 강조 → "눌러보면 되는구나"를 이해.
- **30초 (헤드헌터)**: 분석 시작 → 후보 카드 3장 팬아웃 → 카드 선택 → 핏 점수 카운트업 + 근거 2줄 → [승인하고 제안 보내기] → 완료 토스트 "제안 대기열에 추가됨(예시)" → CTA "/desk 에서 내 의뢰 건 시작".
- **30초 (지원자)**: 같은 데모가 "내 포트폴리오 → 맞는 공고 → 핏 점수 → 지원 승인" 문구로 전환 → CTA "/studio 에서 포트폴리오 만들기". 처음 방문이면 보조 링크 "/start".
- 데모를 건너뛰고 싶은 사용자: 토글 바로 아래 "데모 건너뛰고 시작" 텍스트 링크 상시 노출(막힘 방지).

## 3. 섹션 구성
1. 헤더(로고, 역할 CTA 1개 — 선택 역할 따라 라벨 변경)
2. 히어로: 키네틱 헤드라인(회전 직무명 고정폭 슬롯) + 역할 토글 + 미니 데모(우측/모바일 하단) + 역할 CTA
3. 워크스루 4단계 (네이티브 스크롤, 각 단계 진입 시 1회 재생, Skip 링크)
4. 숫자 띠 (대형 타이포, 전부 "예시" 표기)
5. HIL 차별점 — 유일한 다크 반전 섹션 "AI는 제안, 결정은 사람"
6. 최종 CTA 듀얼 (역할 선택 상태 유지, 선택된 쪽이 primary)

## 4. 요소별 표
| 요소 | 21st.dev 레퍼런스 | 차용점 | 적용 이유 | 변형 |
|---|---|---|---|---|
| 역할 토글 | [Segmented Control Tabs (cnippet)](https://21st.dev/@cnippet-dev/components/segmented-control-tabs) | 하이라이트 pill이 선택 항목으로 미끄러짐, 아이콘+라벨 | 브리프 #3 세그먼트 토글 우선 | 2항목만, `role=radiogroup`, 화살표키 이동, 전환 시 데모·CTA·헤드라인 동시 clip-path wipe |
| 데모 단계 패널 | [Transition Panel with tabs (ibelick)](https://21st.dev/community/components/ibelick/transition-panel/with-tabs) | 탭 인덱스에 따라 패널 내용이 방향성 있게 교체 | 브리프 #1 DOM 미니 데모, #2 4단계 | framer-motion → anime.js v4, 탭 대신 스테퍼(진행만, 되돌리기 버튼 별도) |
| 핏 점수 | [Number Flow (Edu Calvo)](https://21st.dev/@educalvolpz/components/number-flow) | 자릿수 롤링 카운트 | 브리프 #2 점수 카운트업, #5 대형 숫자 | 증감 버튼 제거, 0→점수 1회, 링 게이지 동기화, 화면낭독기엔 최종값만 |
| 숫자 띠 | [Number Flow (Edu Calvo)](https://21st.dev/@educalvolpz/components/number-flow) 재사용 (별도 개별 컴포넌트 미확정) | 뷰 진입 시 카운트업 | 브리프 #5 | "예시" 배지 필수, reduced-motion 시 즉시 최종값 |
| 후보 카드 팬 | [Card Fan Carousel (aayush-duhan)](https://21st.dev/@aayush-duhan/components/card-fan-carousel) | 부채꼴 배치 + 탄성 진입 + 호버 스프레드 | 브리프 #6 카드 팬/틸트 한정 | 3장 스태거 펼침, 모바일은 세로 스택 |

## 5. 상태 설계
- **토글**: 초기 헤드헌터 / 전환 중 입력 잠금(≤400ms) / 선택 상태 URL `?role=` 반영. 키보드 ←→, Space.
- **데모**: `idle`(JD 프리필, 시작 버튼 강조) → `searching`(스켈레톤 600ms) → `candidates`(카드 선택 대기) → `scored`(점수+근거, 승인 버튼) → `approved`(완료+CTA, "다시 해보기"). 각 단계 `aria-live=polite` 한 줄 안내. 역할 전환 시 idle 로 리셋.
- **reduced-motion**: 모든 duration 0, 카운트업 생략, 배경 군중 정지 프레임, wipe → 즉시 교체.
- **키보드**: 모든 단계 버튼 Tab 도달, 카드는 radio, Enter 진행, 진행 후 포커스를 다음 단계 첫 컨트롤로 이동.

## 6. 모션 목록 (anime.js v4)
| 모션 | 구현 |
|---|---|
| 토글 pill 이동 | `animate(pill,{x,width,duration:320,ease:'outExpo'})` |
| 역할 wipe | `animate(panel,{clipPath:['inset(0 100% 0 0)','inset(0 0% 0 0)']})` |
| 카드 팬아웃 | `animate('.card',{y:[24,0],rotate:(_,i)=>(i-1)*4,opacity:[0,1],delay:stagger(70)})` → v2: `rotate:{from:(el,i)=>(i-1)*4,to:(el,i)=>[-1,0,1][i]}` (v4 함수형 값은 단일 값 반환, from/to 는 객체로)` |
| 점수 카운트업 | `animate(obj,{v:score,onUpdate})` + 링 `strokeDashoffset` |
| 승인 CTA 모핑 | scale 0.96→1 + 배경색 전환 |
| 회전 직무명 | `createTimeline({loop:true})`, 고정폭 슬롯, aria-label 원문 |
| 워크스루 진입 | `onScroll` 아닌 IntersectionObserver 1회 트리거 → 섹션마다 다른 모션(동일 fade-up 금지) |

## 7. 접근성·성능
- 포인트 색 1개: copper `#E07A5F` 로 통일(블루 CTA 폐기), 텍스트 대비용 진한 copper `#B5523A`.
- transform/opacity 위주, canvas 배경은 탭 비활성 시 정지, 모바일에서 군중 수 축소.
- 375px: 데모가 헤드라인 아래로, 카드 세로 스택, 토글 전폭.

## 8. 구현 리스크
- 데모가 "실제 분석"으로 오인될 수 있음 → "예시 데모" 라벨 필수.
- 역할 전환 시 데모 진행 상태 리셋이 불만일 수 있음 → 역할별 상태 보존은 2차 검토.
- clip-path 애니메이션은 저사양 모바일에서 끊김 가능 → opacity 폴백.
- 스프라이트 이미지는 localhost:3000 의존, 로드 실패 시 회색 점 플레이스홀더.

## v2 변경 내역 (2026-10-25, 리뷰 라운드)
- 헤드라인: `word-break: keep-all` + "AI가 [직무명을] 찾고, / 사람이 승인합니다." 의도된 2줄, 2행 `nowrap`, "승인"에 accent-soft 하이라이트.
- 데모 초기 상태: 후보 카드 실루엣 3장 + "핏 87점 · 이런 결과가 나와요(예시)" 콜아웃(B 인스펙터 차용). 분석 시작 시 실제 카드로 교체, 리셋 시 복귀.
- 시각 언어(B 차용): ink `#17140F`, accent-soft `#F2B8A6`, 카드 ±1° 회전, 데모 카드 테이프, 워크스루 대형 챕터 번호(A 차용).
- anime.js: 함수형 rotate 배열 반환 → `{from, to}` 객체로 수정.
- 레퍼런스: awwwards 를 SOTD 2건 + HM 1건으로 교체, 카테고리 인용을 Card Fan Carousel / Number Flow 개별 컴포넌트로 교체. 동료 리뷰는 `review_of_A_B.md`.

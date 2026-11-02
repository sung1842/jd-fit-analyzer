# 시안 A (기획자) — 스토리·메시지 중심

**콘셉트 한 줄**: "AI가 찾고, 사람이 정하고, 작업물이 증명한다" — 스카우트 건 하나가 승인·제안까지 가는 하루를 스크롤 서사로 따라간다.

## 1. 전체 양식 레퍼런스 (awwwards)
| 사례 | 차용점 |
|---|---|
| [Radian — SOTD 2026-07-04](https://www.awwwards.com/sites/radian) | 제품 스토리텔링 + 스크롤 인터랙션. "제품을 단계별로 펼쳐 보이는" 챕터 리듬을 4단계 워크스루에 차용 (브리프 #2) |
| [Neutomni — SOTD 2026-10-13](https://www.awwwards.com/sites/neutomni) | 에디토리얼 타이포 스케일. 섹션마다 큰 숫자 챕터 번호 + 대형 한 줄 헤드라인, 본문은 좁은 컬럼 (브리프 #4) |
| [Visual storytelling on scroll (Bromley & Co, Awwwards Inspiration)](https://www.awwwards.com/inspiration/visual-storytelling-on-scroll-bromley-co) | 좌측 고정 텍스트 + 우측 단계 시각물 교체(sticky 2열). 스크롤 하이재킹 없이 네이티브 스크롤 |

그리드: 12열, max 1120px, 좌 5열 고정 서사 / 우 7열 시각물. 모바일은 1열 스택.
(검색 스니펫 기준 확인. 실제 화면은 시각 검증 필요.)

## 2. 섹션 구성 (현재 대비)
| # | 섹션 | 메시지 | 현재 대비 |
|---|---|---|---|
| 0 | 히어로 + 역할 토글 | "좋은 사람은 이미 여기 있다. 찾는 일만 남았다." 회전 직무명. 오른쪽 미니 데모(JD 한 줄→후보 카드→핏 점수) | 현 "올리는 사람과 찾는 사람을 나눈다"는 역할 토글로 흡수. Skiper39 유지 |
| 1 | 문제 제기 (Prologue) | "헤드헌터 한 명이 하루에 볼 수 있는 포트폴리오는 한정돼 있다" — 대형 숫자(예시 표기) | 신규 |
| 2 | 하루 워크스루 (Ch.01~04) | 의뢰 입력 → 후보 탐색 → 핏 분석 → **헤드헌터 승인** → 제안 | "두 직업, 두 책상" 대체. 마지막 단계에 Fit Report 해부 흡수 |
| 3 | HIL 선언 (유일한 반전 섹션) | "AI가 제안하고, 사람이 승인합니다." | 신규, 흑백 반전 1개 |
| 4 | 지원자 쪽 이야기 | "이력서 대신 작업물을 쌓아두세요" + 포트폴리오 마퀴 1개 | 신규 |
| 5 | 닫는 CTA | 역할별 CTA 2개, 같은 accent | 정리 |

## 3. 요소별 표
| 요소 | 21st.dev 레퍼런스 | 차용점 | 적용 이유 | 변형 |
|---|---|---|---|---|
| 히어로 회전 직무명 | [Text Rotate — danielpetho (landing-hero)](https://21st.dev/@danielpetho/components/text-rotate/landing-hero) | 리스트 단어 교체 + 글자 stagger | #4 키네틱 한글 타이포 | Framer Motion → anime.js `createTimeline`. 최장 단어 폭 고정 슬롯, `aria-label`에 원문 |
| 보조 회전(지원자 톤) | [Word Rotate — dillionverma](https://21st.dev/@dillionverma/components/word-rotate) | 단순 페이드 교체 | 지원자 모드는 더 조용하게 | 세로 슬라이드 12px만 |
| 역할 세그먼트 토글 | [Segmented Control Tabs — cnippet](https://21st.dev/@cnippet-dev/components/segmented-control-tabs) (WebFetch 확인, MIT) | 선택 항목으로 미끄러지는 pill | #3 히어로 안 역할 분기 | 인디케이터 transform 이동 + 콘텐츠 clip-path wipe. `role=tablist` 키보드 대응 |
| 4단계 워크스루 | [Product Timeline — Hyperiux](https://21st.dev/@hyperiux/components/timeline) | 마일스톤 리빌, reduced-motion 지원 | #2 스크롤 시나리오 | 가로 → 세로 sticky, Lenis/GSAP 제거(스크롤 하이재킹 금지), anime `onScroll` |
| 단계 상태 표시 | [Process Timeline — youcefbnm](https://21st.dev/community/components/youcefbnm/process-timeline) (검색 확인) | 스크롤 위치에 따라 현재 단계 표시 | 승인 단계(사람)를 시각적으로 구분 | 승인 단계만 accent 실선 + 사람 아이콘, 나머지 회색 |
| 핏 점수 카운트업 | [Number Flow — Edu Calvo](https://21st.dev/@educalvolpz/components/number-flow) (WebFetch 확인, MIT) | 자릿수 롤링 카운트 | #5 구체적 숫자 | anime `animate(obj,{v})` + `onUpdate`. "예시" 라벨 고정 |
| 프롤로그 대형 수치 | **카테고리 수준** — [Stat 카테고리](https://21st.dev/community/components/s/stat), 개별 컴포넌트 미확정 | 숫자+짧은 설명 레이아웃 | #5, 금지(출처 없는 숫자) 회피 | 숫자 1개만, "예시 시나리오" 표기 |
| 포트폴리오 마퀴 | [Cards: marquee cards with hover effect — prebuiltui](https://21st.dev/@prebuiltui/components/cards/marquee-cards-with-hover-effect) (마퀴 목록 페이지에서 확인) | 카드 무한 흐름 + hover 정지 | #5 실물 재료, 마퀴 1개 한정 | CSS 썸네일, hover 시 정지, reduced-motion 시 정지 |

(cnippet·Number Flow는 페이지를 직접 열어 확인. 나머지는 검색·목록 페이지로 존재만 확인, 코드 미검토.)

## 4. 컬러/타이포 토큰
```
--bg: #F6F7F9; --ink: #14161A; --ink-2: #5B6170; --line: #E3E6EB;
--accent: #E07A5F (copper 하나로 통일, 블루 #3B6FFE 폐기);
--accent-weak: #F6D9CF  /* 지원자 모드 = 같은 색 저채도 */
--invert-bg: #14161A (HIL 섹션 1개만)
display: Pretendard 700, clamp(40px, 7.5vw, 88px), letter-spacing -0.045em
chapter no.: 700, clamp(64px,12vw,160px), color --line
body: 16/1.65, measure 34em
```

## 5. 모션 (anime.js v4)
| 대상 | API |
|---|---|
| 이징 토큰 | 진입 `'out(3)'`, 전환 `'inOut(3)'` 두 개로 고정 (B 시안 원칙 차용) |
| 히어로 헤드라인 진입 | `animate('.h-line', { y:['100%',0], opacity:[0,1], delay: stagger(90), ease:'out(4)' })` |
| 직무명 회전 | `createTimeline({loop:true})` 내 out→in 교체, 2.4s 간격 |
| 역할 토글 wipe | `animate(panel, { clipPath:['inset(0 100% 0 0)','inset(0 0% 0 0)'], duration:480 })` |
| 미니 데모 | `createTimeline()` JD 타이핑 → 카드 stagger → 점수 카운트 |
| 챕터 진입 | `animate(step, { ..., autoplay: onScroll({ target: step, enter: 'bottom top' }) })` — 섹션마다 다른 이징·방향(전부 fade-up 금지) |
| 승인 버튼 | 승인 단계에서 버튼 scale 펄스 1회 + 체크 path 그리기 |
| 마퀴 | CSS keyframe (anime 불필요) |
reduced-motion: 모든 timeline 생략, 최종 상태 즉시 표시.

## 6. 리스크
- 서사가 길어 첫 화면 이탈 → 히어로 미니 데모로 핵심을 첫 화면에 선공개, "건너뛰기" 링크.
- 수치 허위 오인 → 모든 숫자 "예시" 라벨.
- sticky 2열이 모바일에서 깨짐 → 768px 미만 1열, sticky 해제.
- Skiper39 스프라이트가 텍스트 가독성 저해 → 오버레이 유지, 히어로에만 배치.
- 21st.dev 레퍼런스는 React/Framer 기반 → anime.js 이식 비용.

## v2 변경 내역 (2026-10-25, 교차 리뷰 + 총괄 QA 반영)
- 히어로 헤드라인 줄바꿈 수정: `word-break: keep-all` + 의도한 3줄 구성, 폰트 `clamp(30px,3.6vw,46px)`, 그리드 7:5 (1280px에서 3줄 목표). 회전 단어는 짧은 것만(프론트엔드/백엔드/iOS/데이터) 쓰고 `nowrap` 슬롯 적용.
- 헤드라인을 "좋은 ○○ 개발자는 이미 여기 있습니다. AI가 찾고, 사람이 고릅니다."로 변경해 첫 화면에 HIL을 넣음 (C 리뷰 반영). 서브카피에 "공고 한 줄이면 됩니다" 추가 (B 리뷰 반영).
- 미니 데모에 실제로 누를 수 있는 승인/보류 버튼, `aria-live` 안내("제안 대기열에 추가됨(예시)"), "데모 건너뛰고 시작하기" 링크 추가 (C 리뷰 반영).
- 21st.dev 카테고리 URL 행을 개별 컴포넌트로 교체: cnippet Segmented Control Tabs, youcefbnm Process Timeline, Edu Calvo Number Flow, prebuiltui marquee cards. Stat은 "카테고리 수준"으로 명시.
- anime.js v4 대조: `onScroll` thresholds는 문서상 `'container target'` 문자열(예: `'bottom top'`)이 확인돼, 확인되지 않은 `'bottom-=15% top'` 오프셋 표기를 걷어냄. `animate`/`createTimeline`/`stagger`/`onScroll({target})` 호출 형태는 문서와 일치. 이징은 `'out(3)'`/`'inOut(3)'` 2종으로 고정. 다만 `'out(n)'` 형식과 `.add()`의 position 인자는 확인한 문서 페이지에 없어 미검증.
- 승인 펄스 애니메이션 선택자를 워크스루 쪽으로 한정(데모 버튼과 충돌 방지).

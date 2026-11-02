# 시안 F — 지평선 너머 (Blue → Green)

**콘셉트 한 줄**: 하늘(블루)과 들판(그린)이 만나는 지평선 위를 걷는 군중 속에서 한 사람이 발견되고, 공고와 실로 이어지고, 헤드헌터의 "승인" 도장과 함께 길을 떠난다.

## 폰트 페어링
| 용도 | 폰트 | 근거 |
|---|---|---|
| 한글 디스플레이(히어로·H2·도장) | Black Han Sans | 획이 굵고 자간이 좁은 임팩트형 한글. 포스터 톤을 내고, 글자 단위로 쪼개 흩어도 형태가 무너지지 않음. |
| 영문 디스플레이(배경 거대 단어, 단계 번호, 점수) | Anton | 컨덴스드 임팩트형이라 Black Han Sans와 무게·폭이 맞음. 외곽선 처리하면 배경 레이어로 쓸 수 있음. |
| 라벨·숫자 보조 | JetBrains Mono | 위상 태그·칩·"예시" 표기처럼 시스템 정보를 맡음. 감성 타이포와 역할을 나눔. |
| 본문 | Pretendard (jsdelivr) | 한글 본문 가독성이 높고 디스플레이 폰트의 소음을 받아줌. |
| 손글씨 포인트 | Nanum Pen Script | 손그림 openpeeps 군중과 어울림. "AI가 찾고, 사람이 승인해요" 한 줄에만 써서 사람 손길을 표시. |

## 컬러 토큰
`--bg #FFFFFF` · `--ink #08202B` · `--ink-2 #3C5560` · `--line #D7E6EA` · `--sky #1463E6` · `--sky-2 #3FA2F2` · `--teal #0BA5A0` · `--field #21A85A` · `--horizon` = sky → sky-2 → teal → field 90° 그라디언트(강조 텍스트, 진행선, 밴드에 사용). 승인은 `--field` 단색이라 "가도 된다"는 신호로 읽힘.

## 히어로 구성 (sticky 핀 420vh, 4단계, 스크럽)
레이어(뒤→앞): ① Skiper39 군중 canvas(fixed, gsap 없이 다시 구현) ② 지평선 밴드와 선 ③ 외곽선 영문 "BEYOND THE HORIZON" ④ 한글 타이틀과 서브 ⑤ JD 카드, 핏 카드, 연결 실(SVG), 도장 ⑥ CTA, 단계 태그, 진행 바.
1. **군중**: 첫 로드 때 타이틀 글자가 회전하며 떨어짐(anime stagger, outBack). 영문 레이어는 가로로 천천히 흐름.
2. **발견**: 타이틀 글자가 좌우로 갈라지며 위로 흩어짐. 서브는 clip-path로 닫힘. 군중이 어두워지고, canvas 안의 한 사람이 그라디언트 후광과 점선 링으로 하이라이트됨. 라벨 "FOUND"가 그 사람을 따라다님.
3. **매칭**: JD 카드가 왼쪽에서 회전하며 들어옴. 핏 카드는 우상단을 축으로 커짐. 점선 실이 JD에서 그 사람까지 그려지고, 점수 0→92(예시)와 막대가 채워짐.
4. **승인**: "승인" 도장이 scale 2→1로 찍힘. 지평선 밴드가 아래에서 올라오고 선도 위로 이동함. 역할 CTA(`/studio`, `/desk`)가 가로 wipe로 나타남. "SKIP INTRO"로 건너뛸 수 있음.

## 섹션별 등장/퇴장 모션
| 섹션 | 요소 | 등장 | 퇴장 |
|---|---|---|---|
| 히어로 | 한글 타이틀 | 글자 단위 낙하+회전(로드 시) | 글자가 좌우로 갈라져 상승, 페이드(스크럽) |
| 히어로 | 영문 거대 단어 | 페이드 | 가로 패럴랙스 -45% |
| 히어로 | 군중 | 상시 걷기 | 어두워짐 + 한 사람 스포트라이트 |
| 히어로 | JD 카드 / 핏 카드 | 왼쪽 슬라이드+회전 / 모서리 축 스케일 | 핀 해제와 함께 위로 빠짐 |
| 히어로 | 연결 실 | SVG 선 드로잉 | — |
| 히어로 | 점수·막대 | 숫자 카운트 / 너비 스크럽 | — |
| 히어로 | 도장 | scale 2→1 + 회전 | — |
| 히어로 | CTA | clip-path 가로 wipe | — |
| 02 역할 | H2 | 아래 경계 마스크 리빌 | — |
| 02 역할 | 지원자/헤드헌터 카드 | 서로 반대쪽에서 가로 슬라이드 | 서로를 향해 모이며 scaleY 압축(스크럽) |
| 03 루프 | H2 | 글자 스크램블 디코드 | — |
| 03 루프 | 4단계 트랙 | sticky 핀 + 가로 스크럽 이동 | 핀 해제 |
| 03 루프 | 단계 번호 | 외곽선이 지나가면 그라디언트로 채워짐 | — |
| 03 루프 | 진행선 | 너비 스크럽 | — |
| 04 데모 | H2 | 글자 rotateX 플립(가운데부터) | — |
| 04 데모 | JD 패널 / 후보 패널 | 스케일 outBack / 왼쪽 clip-path 열림 | 블러 + 위로 이동(스크럽) |
| 04 데모 | JD 입력 → 점수 | 타이핑 후 자릿수 롤링 | — |
| 04 데모 | 승인 버튼 | 클릭 시 상위 카드 elastic 펄스 | — |
| 05 작업물 | H2 | skewX와 함께 가로 진입 | — |
| 05 작업물 | 마퀴 | 상시 흐름, 스크롤 속도에 따라 빨라지고 기울어짐 | — |
| 06 숫자 | 박스 | 위에서 아래로 내려오는 stagger | — |
| 06 숫자 | 숫자 | 카운트업(outExpo) | — |
| 07 출발 | H2 | 글자가 랜덤 순서로 회전하며 낙하, 바운스 | — |
| 07 출발 | 지평선 밴드 | scaleX 스크럽 | — |

reduced-motion: 핀 해제, 정적 최종 상태, 숫자 즉시 표기, 군중 정지. 모바일: 카드 크기 축소, 2열 → 1열, 가로 스크롤 없음(`overflow-x:hidden`, 트랙은 핀 내부에서만 이동).

## 기술
anime.js 4.0.2 ESM의 `animate, stagger, utils, onScroll`을 씀. onScroll이 4.0.0부터 있고 `onEnterForward` 콜백을 지원하는 것은 animejs.com/documentation/events/onscroll 에서 확인함. 실패하면 IntersectionObserver로 넘어감. 핀 스크럽은 rAF 기반 진행률 계산으로 직접 구현함(sync 키를 문서에서 확정하지 못해서). splitText는 직접 구현하고, 원문은 aria-label에 둠.

## 레퍼런스 (검색으로 확인한 URL만)
**21st.dev 요소**
- Sticky Scroll Reveal — https://21st.dev/@manuarora700/components/sticky-scroll-reveal.md → 스크롤에 고정된 단계 전환 구조를 03 루프의 핀 트랙에 씀.
- Text Reveal (마스크 슬라이드) — https://21st.dev/@mohammadshehadeh/components/text-reveal.md → 02 H2 마스크 리빌과 reduced-motion 대응 방식.
- Scroll Reveal Text — https://21st.dev/@dev.yadhakim/components/scroll-reveal-text → 스크롤량에 따라 단어 상태가 바뀌는 방식을 히어로 타이틀 퇴장 스크럽으로 변형.
- Number Ticker (Magic UI) — https://21st.dev/@magicui/components/number-ticker → 핏 점수·숫자 카운트업.
- Marquee (kevingirelli) — https://21st.dev/@kevingirelli/components/marquee.md → 작업물 무한 마퀴. 여기에 스크롤 속도 연동을 더함.

**awwwards 전체 양식 (Inspiration 요소 페이지)**
- Kinetic Typography — https://www.awwwards.com/inspiration/kinetic-typography-nssc18 → 거대 타이포가 움직이는 포스터형 첫 화면 톤.
- Scroll with sticky elements — https://www.awwwards.com/inspiration/scroll-with-sticky-elements-eddie → 히어로와 루프의 sticky 핀 시퀀스 구조.
- Scroll animations, elements and outlined font — https://www.awwwards.com/inspiration/scroll-animations-elements-and-outlined-font → 외곽선 영문 배경 레이어와 채워지는 단계 번호.

한계: 위 페이지 내용은 검색 결과 요약으로만 확인했고, 시각 렌더링은 보지 않았음. 군중 스프라이트는 `localhost:3000`이 떠 있어야 보이고, 없으면 canvas를 숨김.

## v2 변경 내역 (QA·UX1·UX2 리뷰 반영)
| 구분 | 지적 | 반영 |
|---|---|---|
| P0 색 | 회색 군중이 화면 전체를 덮음 | 군중 canvas를 히어로 하단 40vh `.field` 띠 안으로 옮김(fixed 해제). 띠 배경은 처음부터 하늘색→민트→연두 그라디언트이고, 위쪽 경계에 `--horizon` 4px 선을 둠. 군중에는 sepia+hue-rotate 필터로 청록 톤을 입힘. dim은 회색 막 대신 다른 사람의 투명도를 낮추고, 선택된 한 사람에게만 흰색→블루→그린 후광을 줌. 4단계에서 `--horizon` 색이 띠 위로 multiply로 번짐. |
| P0 CTA | 4단계 끝에야 CTA가 보임 | `/studio`·`/desk` CTA를 로드 즉시 보이게 하고, 핀 내내 유지함. 승인 단계에서는 초록 펄스만 줌. |
| P0 핀 길이 | 420vh | 데스크톱 280vh, 760px 이하 190vh. 단계 구간을 다시 배분함(타이틀 퇴장 .08–.26, 발견 .14–.3, 매칭 .26–.55, 승인 .6–.85). |
| P0 빈 상단 | 타이틀 퇴장 뒤 상단 절반이 빔 | 타이틀이 빠지는 즉시 상단에 "발견 → 매칭 → 승인" 대형 캡션이 내려오고 현재 단계가 그라디언트로 켜짐. JD·핏 카드와 도장을 화면 중앙 1/3 높이로 올림. |
| P0 모바일 | 375px에서 히어로 핀과 가로 트랙이 그대로 | 히어로 190vh로 축소, 영문 외곽선 레이어 숨김, 카드 위치·크기 재배치, 루프 섹션은 핀을 풀고 세로 나열로 바꿈. |
| P1 성능 | 프레임당 고정 이동, 강제 레이아웃, 페이지 전체 그리기 | 군중 이동을 delta time(px/s) 기반으로 바꿈. heroUpdate는 읽기(rect, offset)를 먼저 하고 쓰기를 나중에 함. 히어로가 화면을 벗어나면 IntersectionObserver로 그리기를 멈춤. 동시에 그리는 군중을 28명에서 18명으로 줄임. |
| P1 접근성 | krTitle·finalH aria-label | 마크업에 원문 aria-label이 있고, split()이 라벨이 없을 때 원문을 자동으로 넣도록 보강함. |
| P1 카피 | 차별점이 손글씨 한 줄뿐 | 서브카피에 "AI가 찾고 헤드헌터가 승인한 제안만 닿는다"를 넣음. |
| P1 후반 퇴장 | works·nums·final에 퇴장 없음, 숫자는 fade, final 과함 | works: 제목 블록이 오른쪽으로 빠지고 마퀴가 축소됨. nums: 등장은 clip-path 가로 wipe, 퇴장은 rotateX로 뒤로 젖혀짐. final: 회전 ±90°·바운스를 ±20°·outBack 순차로 줄여 가독성을 빨리 확보함(마지막 섹션이라 퇴장 없음). |

내러티브 "군중 속 한 사람 발견 → 매칭 → 승인"은 유지했음. 미반영: 발견 시퀀스를 데모 섹션으로 옮기는 안(UX1 제안)은 히어로 총집합 요구 때문에 보류.

# 시안 D — "맑은 아침 하늘 (Blue)"

**콘셉트**: 하얀 아침 하늘 아래 손그림 군중이 각자의 길로 걸어 나가는 장면. 에디토리얼 잡지 표지처럼 우아하지만, 해가 떠오르는 희망찬 출발을 말한다.

## 1. 폰트 페어링

| 용도 | 폰트 | 출처 | 근거 |
|---|---|---|---|
| 한글 디스플레이 (히어로·섹션 제목·숫자 외 대형) | **Hahmlet** 900/700 | Google Fonts | 획 대비가 큰 현대 한글 세리프. 900 굵기에서 잡지 표지 같은 권위가 생기고, 마스크 안에 군중을 넣어도 획이 충분히 두껍다. |
| 영문 디스플레이 / 강조 이탤릭 | **Instrument Serif** Italic | Google Fonts | 가늘고 긴 이탤릭이 Hahmlet 900과 굵기·기울기에서 최대로 대비된다. 배경 외곽선 "good morning"과 `<em>` 강조에 사용. |
| 라벨·버튼·숫자 | **Outfit** 600/800 | Google Fonts | 원형 기반 기하학 산세리프. 세리프 두 종 사이에서 "제품·데이터" 층을 맡는다. 오도미터 숫자는 tabular. |
| 본문 | **Pretendard Variable** | jsdelivr | 긴 본문의 가독성 담당. 눈에 띄지 않도록 일부러 중립. |
| 손글씨 포인트 | **Nanum Pen Script** | Google Fonts | openpeeps 손그림과 같은 손맛. "이 시작돼요 ↗", 승인 도장, 역할 카드 낙서에만 사용. |

다섯 종이지만 "세리프(권위) + 기하학(제품) + 손글씨(사람)"의 세 층으로 역할이 겹치지 않게 나눴다.

## 2. 컬러 토큰

| 토큰 | 값 | 용도 |
|---|---|---|
| `--white` | #FFFFFF | 기본 배경 (사용자 요구) |
| `--paper` | #F5F9FF | 데모 섹션, 지원자 카드 |
| `--mist` | #E6F1FF | 히어로 하늘 그라데이션, JD 박스 |
| `--sky` | #BFDDFF | 배경 외곽선 글자, 카드 |
| `--cerulean` | #4AA3F2 | 점수 바, 마스크 글자 위쪽 |
| `--cobalt` | #1F4FD6 | 주 강조, CTA, 헤드헌터 카드 |
| `--ink` | #0B1C45 | 본문·제목 |
| `--ink-2` | #44527A | 보조 텍스트 |
| `--sun` | #FFE7A3 | 떠오르는 해, CTA 강조 (유일한 따뜻한 색) |
| `--line` | #D3E3F7 | 테두리 |

## 3. 히어로 구성 (레이어, 뒤에서 앞으로)

1. **하늘 그라데이션** (mist → white)
2. **해** — 방사형 노란 원. 스크롤하면 위로 떠오르며 커진다.
3. **배경 단어 "good morning"** — Instrument Serif 이탤릭 외곽선. 포인터 패럴랙스는 반대 방향, 스크롤하면 자간이 벌어진다.
4. **군중 캔버스** (Skiper39을 gsap 없이 rAF로 옮김, 스프라이트 15×7) — 배경 단어 **앞**, 제목 **뒤**를 지나간다.
5. **대형 타이포** "오늘 아침, 모두의 **[출발]**" — "출발"은 별도 캔버스. 하늘색 글자 안을 **확대한 군중의 흰 실루엣**이 실시간으로 걸어간다(마스크 안의 군중, `source-atop` 합성). 포인터를 움직이면 마스크 안의 시점이 이동한다.
6. 손글씨 주석, 부제, 역할 CTA(`/studio`, `/desk`), 하단 흰색 페이드, 세로 SCROLL 힌트.

히어로는 200vh sticky 핀이다. 스크롤하면 글자마다 무작위 방향·속도로 흩어지고, "출발"은 확대되며 사라지고, 해는 떠오르고, 군중은 아래로 가라앉는다.

## 4. 섹션별 등장/퇴장 모션 표

| 섹션 | 요소 | 등장 | 퇴장 | 트리거 |
|---|---|---|---|---|
| Hero | 첫 줄 글자 | 아래에서 회전(12°→0)하며 마스크 리빌, 글자 단위 stagger | 글자마다 다른 방향·회전으로 흩어지며 위로 | 로드 / 스크럽 |
| Hero | "모두의" 글자 | **위에서** 떨어지는 마스크 리빌 (첫 줄과 반대) | 위와 같음 | 로드 / 스크럽 |
| Hero | 마스크 단어 "출발" | 왼→오른쪽 clip-path 와이프 | 스케일 2.6배 확대 후 페이드 | 로드 / 스크럽 |
| Hero | 손글씨 주석 | 스케일 0.6 + 회전 -25°, outBack 튕김 | 회전하며 오른쪽으로 빠짐 | 로드 / 스크럽 |
| Hero | 라벨 | 자간 .6em→.18em 수축 | 핀 해제와 함께 이동 | 로드 |
| Hero | 부제 | 블러 8px→0 | 빠른 페이드 | 로드 / 스크럽 |
| Hero | CTA | 스케일 팝 stagger | 페이드 | 로드 / 스크럽 |
| Hero | 배경 단어 | 왼쪽에서 가로 슬라이드 + 포인터 역패럴랙스 | 자간 확장 | 로드 / 포인터 / 스크럽 |
| Hero | 해 | 스케일 0.6→1 | 위로 떠오르며 1.8배 | 로드 / 스크럽 |
| Hero | 군중 | 상시 걷기 | 아래로 25% 가라앉음 | 스크럽 |
| Roles | 섹션 제목 | 위에서 아래로 clip-path 커튼 | — | IO 25% |
| Roles | 지원자 / 헤드헌터 카드 | **반대 방향**에서 가로 슬라이드 + 기울기 ±3° 보정 | 서로 바깥쪽 끝으로 clip-path가 접힘 | IO 진입 / 위로 이탈 |
| Demo | 보드 | 3D rotateY -18°→0 | 마지막에 rotateX로 앞으로 숙임 | sticky 300vh 스크럽 |
| Demo | 단계 목록 | 색 채움 (회색→잉크) | 역스크롤 시 되돌림 | 스크럽 4단계 |
| Demo | JD 카드 | 스케일 0.94→1 튕김 | — | 1단계 |
| Demo | 후보 행 | 오른쪽에서 가로 슬라이드 stagger | 오른쪽으로 되돌아감 | 2단계 |
| Demo | 점수 / 바 | **숫자 카운트업** + 바 너비 증가 | 0으로 초기화 | 3단계 |
| Demo | 승인 도장 | 스케일 2.4→1 + 회전 -40°→-14°, "쾅" 찍힘 | 크게 사라짐 | 4단계 |
| Loop | 곡선 경로 | **선 드로잉** (dashoffset) | 역스크롤 시 되감김 | anime `onScroll` sync |
| Loop | 노드 점 | 0→1.4→1 팝 stagger | — | IO 40% |
| Loop | 단계 카드 | rotateX 70°→0, 위에서 아래로 접혔던 종이가 펴짐 | **마지막 것부터** 위로 빠짐 | IO |
| Statement | 문장 단어 | 단어별 색 채움 (연회색→잉크/코발트) | 역스크롤 시 꺼짐 | anime `onScroll` sync |
| Statement | 손글씨 부연 | 오른쪽에서 elastic 슬라이드 + 회전 | **왼쪽**으로 빠짐 | IO 80% |
| Works | 마퀴 두 줄 | 기울어진(-4°) 1.1배에서 바로 서며 stagger | 0.92배로 축소 페이드 | IO |
| Works | 마퀴 상시 | 반대 방향 흐름 + **스크롤 속도에 비례해 skewX** 와 가속 | — | rAF |
| Numbers | 오도미터 숫자 | 자릿수별로 길이가 다른 **숫자 롤링** | 0으로 빠르게 되감김 | IO 60% |
| CTA | 섹션 전체 | **원형 clip-path**가 8%→88%로 열림 (해가 떠오르듯 위로 이동) | 역스크롤 시 닫힘 | 스크럽 |
| CTA | 제목 | 자간 -.12em→-.03em으로 풀림 | — | IO |
| CTA | 반전 군중 | 코발트 위 흰 실루엣으로 상시 걷기 | — | rAF |
| Nav | 바 | 투명→흰색 블러 | — | scrollY>40 |

**fade-up은 한 곳도 쓰지 않았다.** 배치는 1~2단 그리드로 정돈했고, 움직임에서만 차이를 둔다.

## 5. 레퍼런스

### 21st.dev (요소별, WebSearch/WebFetch로 페이지 확인)
| 컴포넌트 | URL | 차용 |
|---|---|---|
| Text Reveal (Mask) — soralabs | https://21st.dev/@soralabs/components/text-reveal-mask | 줄·단어·글자 단위 마스크 리빌 → 히어로 글자 분해 리빌 (방향을 줄마다 반대로 바꿔 변형) |
| Reading Text Reveal — waleedkibhen | https://21st.dev/@waleedkibhen/components/reading-text-reveal | 스크롤에 따라 단어가 하이라이트됨 → Statement 단어 채움 |
| Scroll Text Rise — ruixen.ui | https://21st.dev/community/components/ruixen.ui/scroll-text-rise | 자체 스크롤 추적 방식 → 외부 라이브러리 없이 progress를 계산하는 `scrub()` 헬퍼 |
| Number Ticker — Magic UI | https://21st.dev/@magicui/components/number-ticker | 카운트업 → 데모 점수. 숫자 섹션은 오도미터 롤링으로 발전시킴 |
| Marquee — kevingirelli | https://21st.dev/@kevingirelli/components/marquee.md | 무한 루프 마퀴 → 작업물 띠 (스크롤 속도 skew 추가) |

### awwwards (전체 양식)
| 작품 | 근거 URL | 차용 |
|---|---|---|
| Editorial New — Locomotive for Pangram Pangram (Awwwards Site of the Day · Site of the Month · Developer · Mobile Excellence) | https://locomotive.ca/en/work/editorial-new | 세리프 서체 자체가 주인공인 에디토리얼 랜딩. 대형 세리프와 사용자가 직접 만지는 타이포 인터랙션 → 히어로의 Hahmlet 900 + 포인터로 움직이는 마스크 글자, 그리고 전체적인 잡지 같은 리듬 |

awwwards 수상작은 수상 이력이 확인된 1건만 적었다. 검색에 나온 FairView는 무료 폰트 소개 페이지였고 수상작이 아니어서 제외했다.

## 6. 기술 메모
- anime.js 4.0.2 ESM: `animate, createTimeline, stagger, onScroll, utils`를 사용. `onScroll`(Since 4.0.0, 문서 확인)은 선 드로잉과 Statement 스크럽의 `sync`에 썼다. `splitText`는 4.0.2에 포함됐는지 문서에서 확인되지 않아 글자 분해를 직접 구현했다.
- sticky 핀 스크럽(히어로, 데모, CTA)은 `getBoundingClientRect` 기반 자체 `scrub()`로 구현했다.
- 스프라이트는 `http://localhost:3000/images/peeps/all-peeps.png`. talentfolio 서버가 꺼져 있으면 군중만 보이지 않고 에러는 나지 않는다(`onerror` 무시). 픽셀은 읽지 않으므로 canvas가 tainted여도 문제없다.
- `prefers-reduced-motion`: 모든 모션을 끄고 최종 상태(점수, 도장, 채워진 문장, 열린 CTA)를 표시한다. 군중은 정지 상태로 그린다.
- 모바일 860px 이하는 1단으로 바꾸고 군중 수를 16명으로 줄인다. 가로 넘침은 `overflow-x:hidden`으로 막고, 마퀴는 섹션 안에서 잘린다.

## v2 변경 내역 (QA_round3_v1 · UX1 · UX2 반영)

| 우선 | 지적 | 반영 |
|---|---|---|
| P0 | 군중이 "출발"·서브카피·CTA를 가림 | `#crowd` 62vh/z3 → **38vh/z2 하단 띠**(모바일 28vh), 스프라이트 0.7배. 카피 블록을 top 12vh로 올리고 제목을 조금 줄임. 서브카피에 흰 85% 반투명 판 + 블러 8px, 보조 CTA 흰 배경 |
| P0 | CTA가 늦게 뜨고 핀이 시작되면 바로 사라짐 | CTA 등장을 300ms에 시작해 약 0.9초 안에 완료. 핀 스크럽에서 서브카피·CTA는 **진행 0.35까지 유지**, 글자 흩어짐은 0.1부터, "출발" 확대는 0.2부터 시작 |
| 유지 | "출발" 글자 안 군중 마스크 (UX2 최고 연출) | 그대로 유지. 군중을 흰색에서 **진한 ink 실루엣**으로 바꿔 대비를 높이고(UX1 P1), canvas 뒤에 cobalt 텍스트 폴백을 깔아 스프라이트 지연 시에도 빈 칸이 생기지 않게 함 |
| P1 | 매 프레임 canvas filter 비용 | `filter` 제거. offscreen canvas에 `source-in` ink 채움으로 실루엣 생성 |
| P1 | 화면 밖에서도 군중·마퀴 루프가 돎 | 군중 두 캔버스에 IntersectionObserver로 일시정지. 마퀴 `scrollWidth`는 resize 때만 측정. RM에서는 rAF 정지 |
| P1 | scroll 핸들러 rAF 중복 | `ticking` 플래그 |
| P1 | 모바일 핀 | 860px 이하에서 데모 300vh 핀 해제, 보드가 보이면 최종 상태로 표시. 포인터 패럴랙스는 `(hover:hover)`일 때만 |
| P1 | 희망찬 블루가 약함 | `--mist` #E6F1FF → #DCEBFF, 군중 아래 연한 cerulean 지면 띠 `.ground` |
| P1 | stmtSub가 역할 카드와 같은 가로 슬라이드 | 손글씨가 써지듯 왼→오른쪽 clip 리빌, 퇴장은 블러 |
| P2 | 키보드·스크린리더 | `:focus-visible` 3px cerulean 아웃라인. h1에 `aria-label`, 분해 글자 `.ch`는 `aria-hidden` |
| P2 | 카피·nav·핀 이탈 | 서브카피 첫 문장에 두 역할 명시, 보조 CTA "AI 추천 후보 승인하기 →", nav에 "헤드헌터"(`/desk`), 히어로 좌하단 SKIP INTRO 링크 |

미반영: F의 히어로 진행 표시, 루프 제목 스크램블(P2/빌려오기, 다음 라운드 후보).

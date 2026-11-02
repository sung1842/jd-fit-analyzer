# 시안 B — 비주얼 임팩트 중심 (UI 디자이너)

**콘셉트 한 줄**: "종이 위의 포트폴리오, 먹색 위의 한 점 코퍼" — 무채색 종이 질감 위에서 한글 대형 타이포가 움직이고, 코퍼 1색만이 '핏'을 가리킨다.

## 1. 전체 양식 레퍼런스 (awwwards)
| 레퍼런스 | 차용점 |
|---|---|
| Mike Wilcock 포트폴리오 (Nominee, 2026-10) https://www.awwwards.com/sites/mike-wilcock | 키네틱 타입이 히어로를 차지하고 콘텐츠가 그 밑에서 자연 스크롤로 이어지는 구성. 화면 전환 대신 타이포 자체가 리듬을 만든다 → 히어로 좌측 대형 한글 헤드라인 |
| Mat Voyce 케이스 스터디 https://www.awwwards.com/case-study-mat-voyce-designing-a-digital-home-for-a-kinetic-creative.html | 애니메이션 레터링을 화면 폭에 맞춰 스케일링하는 시스템 → `clamp()` 기반 디스플레이 스케일 + 회전 직무명 고정폭 슬롯 |
| Kinetic V5 (SOTD) https://www.awwwards.com/sites/kinetic-v5 | 무채색 바탕 + 강한 포인트 1색, 숫자를 대형 타이포로 쓰는 방식 → "숫자 밴드" 섹션 |

## 2. 섹션 구성
1. **내비** — 워드마크 + 3링크 + CTA 1개 (코퍼 채움, 모핑 화살표)
2. **히어로 (Top6 #1·#3·#4)** — 좌: "_개발자_의 포트폴리오를, 공고 한 줄로 찾아냅니다" (직무명 회전 + 호버 스크램블). 우: DOM 미니 데모(JD 입력 → 후보 카드 3장 팬 → 핏 점수 카운트업 + 인스펙터 콜아웃). 상단 세그먼트 토글 `헤드헌터 | 지원자` clip-path wipe 로 카피·데모 동시 전환. 배경 Skiper39.
3. **포트폴리오 마퀴 (#5)** — 실물 재료 느낌 카드(종이 질감, 테이프, 듀오톤 썸네일 — 지원자 톤 한정) 1줄.
4. **워크스루 4단계 (#2)** — 좌측 sticky 숫자(01~04), 우측 단계 카드: 의뢰 입력 → 후보 탐색/분석 → 헤드헌터 승인(HIL) → 제안 발송. 4단계에 Fit Report 해부(기술/경험/컬처 막대). Skip 링크 제공.
5. **숫자 밴드 (유일한 먹색 반전 섹션)** — 대형 숫자 3개, 모두 "예시" 표기.
6. **차별점 "AI가 제안, 사람이 승인"** — 승인 카드 1장 크게 + 승인/보류 버튼 마이크로인터랙션.
7. **최종 CTA + 푸터**.

## 3. 요소별 표
| 요소 | 21st.dev 레퍼런스 | 차용점 | 적용 이유 | 변형 |
|---|---|---|---|---|
| 회전 직무명 | Word Rotate (Magic UI) https://21st.dev/@magicui/components/word-rotate | 수직 슬라이드로 단어 교체 | Top6 #4 키네틱 한글 | framer-motion → anime.js v4, 고정폭 슬롯(가장 긴 단어 기준) + `aria-label` 원문 고정, 3초 간격 |
| 호버 스크램블 | Text Scramble (jatin-yadav05) https://21st.dev/@jatin-yadav05/components/text-scramble | 디코딩식 글자 치환 | #4 "호버 스크램블" | 라틴 기호 대신 한글 자모(ㄱㄴㄷ…)로 치환, 포커스 시에도 발동, reduced-motion 시 비활성 |
| 키네틱 텍스트 전반 | Text Animation 카테고리 https://21st.dev/community/components/s/text-animation · Fancy Components(Daniel Petho) https://docs.21st.dev/@danielpetho/library/fancy-components | 한 작가 계열의 일관된 타이밍 | 블로그 지적대로 여러 작가 혼용 시 이징 불일치 → 이징 토큰 2개로 통일 | 이징 `outExpo`(진입) / `inOutQuad`(전환)만 사용 |
| 포트폴리오 마퀴 | **직선 마퀴 개별 페이지 확인 실패.** 확인된 것은 Marquee Along SVG Path (danielpetho) https://21st.dev/@danielpetho/components/marquee-along-svg-path (경로형이라 패턴만 참고) + 블로그 https://21st.dev/blog/motion-primitives-alternatives | 복제 트랙 + keyframe, 런타임 불필요 | #5 실물 재료, 마퀴 1개 한정 | CSS keyframe, hover/focus 시 일시정지, 모바일 속도 0.6배 |
| 카드 틸트 | Tilt Card (tom_ui, Spell, MIT) https://21st.dev/@tom_ui/components/tilt-card | perspective 호버 틸트 + spotlight (최대 각도는 페이지 미기재) | #6 절제된 카드 팬/틸트 | 최대 6°, 터치 기기·reduced-motion 비활성 |
| 워크스루 진입 | 개별 컴포넌트 미확정 — 카테고리 https://21st.dev/community/components/s/scroll-animation (A안이 찾은 Product Timeline (Hyperiux) https://21st.dev/@hyperiux/components/timeline 을 대안으로 검토) | 스크롤 진입 시 단계 활성 | #2 네이티브 스크롤 | 하이재킹 없이 IntersectionObserver + 섹션별 다른 모션(fade-up 금지 준수) |

## 4. 토큰
### 컬러 — 포인트 1색 정리
- **결론: copper `#E07A5F` 단일화, CTA 블루 `#3B6FFE` 폐기.** 근거: 브랜드 DESIGN.md 의 primary 가 copper, 블루는 보라-파랑 AI 톤(금지 목록)과 인접.
- 역할 구분은 같은 hue 명도로: 헤드헌터 = `--accent-ink #B85A40`(진한), 지원자 = `--accent-soft #F2B8A6`(옅은).
```
--paper #F6F4F0  --paper-2 #EDEAE4  --ink #17140F  --ink-2 #4A453D  --mute #8C857A
--line rgba(23,20,15,.12)  --accent #E07A5F  --accent-ink #B85A40  --accent-soft #F2B8A6
```
대비: copper 텍스트는 18px bold 이상에서만, 본문 링크는 `--accent-ink`(대비 약 4.3:1 추정, AA 본문 기준 경계 — 본문용은 #A24E37 등으로 조정 검토).
### 타이포
Pretendard Variable. Display `clamp(44px, 8vw, 112px)/0.98, 800, -0.04em` · H2 `clamp(30px,4.4vw,56px)` · H3 22 · Body 17/1.65 · Caption 13 mono(숫자·라벨, JetBrains Mono).
### 간격·그림자·질감
4px 그리드, 섹션 간 `clamp(96px,14vw,180px)`. 그림자 2단: `--sh-1 0 1px 0 var(--line), 0 2px 6px rgba(23,20,15,.06)` / `--sh-2 0 18px 40px -16px rgba(23,20,15,.28)`. 질감: SVG feTurbulence 노이즈 3% (body), 카드 테이프 조각, 둥근 모서리 6px(카드)·999px(칩) — 과한 radius 지양.

## 5. 모션 (anime.js v4)
| 모션 | 구현 |
|---|---|
| 헤드라인 글자 진입 | 글자 span 분할 → `animate(chars,{y:['100%',0],opacity:[0,1],delay:stagger(28),ease:'outExpo'})` |
| 직무명 회전 | `animate(slot,{y:[0,'-100%'],opacity:[1,0]})` 후 텍스트 교체, 반대로 진입 |
| 스크램블 | `setInterval` 없이 `animate({p:0},{p:1,onUpdate})`로 진행률 기반 자모 치환 |
| 역할 토글 wipe | `animate(layer,{clipPath:['inset(0 100% 0 0)','inset(0 0% 0 0)'],duration:520})` |
| 후보 카드 팬 | `stagger(60,{from:'center'})` + rotate(-6/0/6) |
| 점수 카운트업 | `animate(obj,{v:[0,92],modifier:utils.round(0),onUpdate})` |
| 워크스루 | 단계별 다른 모션: 01 타이핑 커서, 02 바 스캔, 03 도장(scale 1.4→1), 04 막대 성장 |
| CTA 모핑 | 호버 시 화살표 x 이동 + 배경 inset 채움 |
| reduced-motion | 전부 즉시 최종 상태로 `utils.set`, 마퀴 정지 |

## 6. 구현 리스크
- 한글 글자 분할 스태거는 조합형 깨짐 없음(완성형 단위)이나 스크린리더 대응 위해 `aria-label` 필수.
- 종이 노이즈 + Skiper39 canvas 겹침 시 저사양 모바일 페인트 비용 → 노이즈는 정적 SVG 1장, canvas 는 모바일 30fps 제한.
- copper 단일화는 기존 블루 CTA 페이지(랜딩 외)까지 파급 → globals.css 토큰 치환 범위 확인 필요.
- 21st.dev 컴포넌트 대부분 framer-motion 기반 → 코드 복사 아님, 패턴만 차용하여 anime.js 로 재작성. 라이선스는 각 페이지 확인 필요(미확인).
- 수치는 전부 "예시" 라벨 — 실데이터 확보 전 허위 노출 금지.

## v2 변경 내역 (2026-10-25, 총괄 QA + 교차 리뷰 반영)
- 히어로 헤드라인: `word-break:keep-all` + 줄마다 `white-space:nowrap`. 줄 구성을 "디자이너의 / 포트폴리오를, / 공고 한 줄로."로 고정. 회전 단어를 짧은 단어(디자이너·개발자·마케터·PM)로 줄이고, 디스플레이 크기를 `clamp(40px,6.6vw,92px)`로 낮춰 단어 길이가 바뀌어도 줄이 깨지지 않게 함.
- 데모: 카드 폭 32%로 3장을 나란히 팬(±100%, ±5°), 점수 배지는 카드 우상단으로. 콜아웃은 팬 아래 별도 블록(위쪽 화살표)으로 옮겨 이름·점수를 가리지 않게 함.
- 레퍼런스: 틸트는 tom_ui Tilt Card 페이지로 교체. 직선 마퀴와 워크스루는 개별 페이지를 찾지 못해 그렇다고 명시함.
- anime.js v4 대조(animejs.com utilities/round): `modifier: utils.round(0)` 사용법이 문서와 일치함. 함수형 값 `(el, i)`, `stagger`, `utils.set`, ease 이름 `outExpo` 등 유지. 데모 틸트 해제는 CSS transition으로 처리(v1과 같음).
- 교차 리뷰 반영(review_of_A_C.md): A안의 Prologue 문제 제기 숫자는 채택하지 않음(숫자 밴드와 중복). C안의 "데모 건너뛰고 시작" 상시 링크는 v3 후보.

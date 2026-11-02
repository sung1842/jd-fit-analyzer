# B. 레이아웃·모션·인터랙션 트렌드 리서치 (기획자 B)

조사일: 2026-10-25. 방법은 WebFetch로 각 어워드 목록, 수상작 상세 페이지, 실제 사이트를 확인했다.
표기 규칙: **[확인]**은 어워드 상세 페이지의 태그나 featured element, 또는 실제 사이트 마크업에서 직접 확인한 내용이다. **[추정]**은 태그나 문구를 보고 추론한 내용이다. 영상을 직접 보지 않았으므로 모션의 세부 질감은 대부분 추정이다.

## 1. 사례 표

| # | 사이트명 | 출처 | URL | 관찰한 레이아웃/모션 특징 |
|---|---|---|---|---|
| 1 | Forge Automotive | Awwwards SOTD 2026-10-25 | https://forgeautomotive.co.uk/ | [확인] 인트로 스크롤 스크러빙, clip-path 메뉴 전환, 패럴랙스, 무한 스크롤, WebGL 404(배기 연기), 포인트라이트로 만든 가짜 3D 푸터. GSAP와 Next.js 사용 |
| 2 | Brandon Yasin | Awwwards SOTD 10-24 | https://brandonyasin.com | [확인] 시계를 드래그하면 시간대에 따라 배경 팔레트가 바뀜. 메뉴는 "잡지 표지를 나란히 펼치는" 에디토리얼 내비, 스크롤 연동 케이스 스터디, 프리로더. GSAP와 Nuxt 사용 |
| 3 | Emotion Agency | Awwwards SOTD 10-22 | https://emotion-agency.com/ | [확인] WebGL 씬 스크롤, 마우스 반응 파티클, WebGL 그리드 시프트 전환, 씬 간 전환, AI 인터랙션 기반 컨택트, 다크 테마. GSAP와 Three.js 사용 |
| 4 | Cartier – Le Chœur des Pierres | Awwwards SOTD 10-20 | https://www.cartier.com/en-fr/lechoeurdespierres | [확인] 애니메이션 스크롤 콘텐츠, 구아슈 리빌 효과, WebGL. 화이트와 블랙 2색 |
| 5 | FORMAT (Obys) | Awwwards SOTD 10-19 | https://format.obys.agency/ | [확인] 로딩·전환 모션, Matter.js 물리 엔진, 스크롤, 타이포 중심, 흑백. [추정] 도형이 물리적으로 떨어지고 부딪히는 인터랙션 |
| 6 | Signal-A Studio | Awwwards SOTD 10-18 | https://signal-a.studio | [확인] 커서 대체, 호버 시 텍스트 스크램블, 미니멀 그리드 아코디언, 아카이브 오버레이 슬라이더. Webflow 사용, 흑백 |
| 7 | Overworld Audio | Awwwards SOTD 10-15 | https://overworldaudio.com/ | [확인] 작업물을 "탐험 가능한 지도"로 보여 줌, 3D(Three.js), 사운드. 애니메이션 점수 8.6 |
| 8 | Huy Phan Vol.2 | Awwwards SOTD 10-14 | https://huyml.co/ | [확인] 로딩, 프로젝트 갤러리, 모달형 About/Contact, 필터·효과. GSAP와 Three.js 사용 |
| 9 | metic. | CSSDA WOTD 10-21 | https://metic.studio/en | [확인] 스크롤하면 "선에서 버튼까지" 8단계 빌드 시퀀스가 진행되고 000% 카운터가 함께 올라감. "Skip the build" 링크, 포인터 위치에 따라 펼쳐지는 서비스 카드 팬, 렌즈/X-ray 토글, 8장 서비스 카드 그리드 |
| 10 | Infia City | CSSDA WOTD 10-25 | https://infiastudios.com/ | [확인] 사이트 전체가 3D 도시 씬. 궤도 이동·비행·WASD 조작, Hierarchy와 Inspector 패널 같은 에디터형 UI, 날씨와 시간대 컨트롤, 가이드 투어, WebGL을 쓸 수 없을 때의 폴백 |
| 11 | Half the Sky | CSSDA WOTD 10-24 | https://halfthesky.app/ | [확인] "벽에 새겨진 32명의 여성과 대화" 콘셉트, CTA는 "Carve her name"과 "Ask her". [추정] 3D·대화형 인터랙션 |
| 12 | Grande Charte Inc. | CSSDA WOTD 10-18 | https://grandecharte.co | [확인] 퍼센트 프리로더, 풀뷰포트 히어로, 다국어 인사말 회전 텍스트, 로고 무한 마퀴, 01–04 넘버링 서비스. [추정] 떠다니는 장식 요소 |
| 13 | Arc Marumo | CSSDA WOTD 10-22 | https://www.arcmarumo.com/ | 세부 미확인(목록 확인만) |
| 14 | AUGE Experience | CSSDA WOTD 10-20 | https://auge-xp.com/ | 세부 미확인(목록 확인만) |
| 15 | Arg Software | CSSDA 노미니 10-24 | https://arg.software | [확인] 정통 B2B 구조(히어로, 서비스, 숫자 증명, 케이스 스터디). 모션은 확인하지 못함 |
| 16 | Liquid Button (Val Guerra) | recent.design | https://recent.design/i/pd1kyjp-liquid-button-hover-effect | [확인] 호버하면 다크 필 버튼이 핑크·보라 그라디언트 블롭으로 변형되고, 커서가 벗어나면 원래 모양으로 스냅 |
| 17 | macOS Lookaway Orb (kush) | recent.design | https://recent.design/i/sf6nnvx-macos-lookaway-orb-interaction | [확인] 글래스 오브가 캡슐로 늘어났다가 떠오르며 사라지는 모핑 전환 |
| 18 | Tash Partner Pack Opening | recent.design | https://recent.design/i/762nav7-tash-partner-pack-opening | [확인] 팩을 누르고 있으면 희귀도별 리빌, 빛, 컨페티, 개인화된 보상 카드가 나옴 |
| 19 | Earth Timeline | recent.design | https://recent.design/i/l9294qq-earth-timeline | [확인] 커서 스크러빙에 따라 138억 년 타임라인이 진행되고 3D 지구가 시대별로 변함 |
| 20 | AI Simulation Dot Visuals | recent.design | https://recent.design/i/r4nkk3e-ai-simulation-dot-visuals | [확인] 도트 매트릭스로 신경망, 지형, 소용돌이를 표현한 모션 |
| 21 | Bloom (Teknosis) | recent.design | https://recent.design/i/7bqklue-bloom | [확인] 3D 유기체가 루프하며 색과 형태를 바꾸는 모핑 |

참고: recent.design 항목은 대부분 X에 올라온 모션 스터디로, 실제 서비스 웹사이트가 아니다. CSSDA 상세 페이지는 404로 리다이렉트되어 실제 사이트를 직접 확인했다.

## 2. 트렌드

### T1. 스크롤 = 타임라인 스크러빙 (스크롤이 서사·진행도를 구동)
- 근거: metic.(빌드 8단계와 % 카운터), Forge(인트로 스크러빙), Earth Timeline, Cartier, Brandon Yasin
- 확산도: **강**
- anime.js 구현 난이도: **중**. v4의 `onScroll`과 `createTimeline`으로 스크롤 진행도를 타임라인에 연결하면 된다(sync 모드).
- Talentfolio 적용: 매우 높음. 예를 들어 "포트폴리오 업로드 → AI 핏 분석 → 헤드헌터 승인 → 제안" 루프를 4단계 스크롤 시퀀스로 보여 주고, 핏 점수가 0에서 92%로 카운트업되게 한다. metic의 "Skip" 링크도 함께 둔다.
- 주의: 스크롤 하이재킹은 금지하고 네이티브 스크롤을 유지한다. `prefers-reduced-motion`이면 최종 상태를 바로 보여 준다. 모바일에서는 단계를 줄인다.

### T2. 사용자가 조작하는 "작은 장난감" 인터랙션 (팔레트 시계, 렌즈, 팩 오프닝)
- 근거: Brandon Yasin(시계 드래그로 색 변경), metic(렌즈·X-ray), Tash Pack Opening(꾹 누르기 리빌), FORMAT(Matter.js 물리)
- 확산도: **강**
- 난이도: **중~상**. 드래그는 v4 `createDraggable`로 쉽다. 물리 연출은 anime.js 범위 밖이라 별도 라이브러리가 필요하다.
- 적용: 지원자/헤드헌터 토글을 드래그 스위치로 만들고, 이 스위치로 배경 팔레트와 카드 내용을 바꾼다. 또는 "기술 스택 칩을 끌어 놓으면 매칭 카드가 반응"하는 미니 데모를 둔다.
- 주의: 키보드 대체 수단을 반드시 제공한다(버튼이나 라디오). 핵심 정보를 인터랙션 뒤에 숨기지 않는다.

### T3. 키네틱 타이포 마이크로인터랙션 (스크램블, 회전 단어, 글자 단위 스태거)
- 근거: Signal-A(호버 스크램블), Grande Charte(다국어 회전 인사말, 마퀴), FORMAT, Huy Phan(타이포 태그)
- 확산도: **강**
- 난이도: **하**. v4 `splitText`(text 유틸)와 `stagger`로 구현한다. 스크램블은 짧은 커스텀 루프가 필요하다.
- 적용: 헤드라인의 직무명을 회전시킨다("프론트엔드 개발자 / 프로덕트 디자이너 / 백엔드…"). 카드 제목에 호버하면 스크램블을 건다.
- 주의: 한글은 글자 단위로 쪼개면 스크린리더가 망가지므로 `aria-label`로 원문을 유지한다. 회전 텍스트는 일시정지가 가능해야 한다(WCAG 2.2.2).

### T4. 리퀴드·모핑 마이크로인터랙션 (버튼, 오브, 블롭)
- 근거: Liquid Button, macOS Lookaway Orb, Bloom
- 확산도: **중** (recent.design·X에서 강하고 어워드 사이트에서는 아직 부분적)
- 난이도: **중**. CTA 정도면 SVG path 모핑(`svg.morphTo`)이나 border-radius와 scale 스프링(`spring` easing)으로 충분하다.
- 적용: 주요 CTA 2개("포트폴리오 올리기", "인재 찾기")에만 쓴다. Skiper39 배경과 색을 맞춘다.
- 주의: 많이 쓰면 장난스러워 보인다. CTA에만 한정하고, 터치 기기에서는 탭 피드백으로 대체한다.

### T5. 클립패스·그리드 시프트 페이지/메뉴 전환
- 근거: Forge(clip-path 메뉴), Emotion(그리드 시프트·씬 전환), FORMAT(전환 영상), Signal-A(오버레이 슬라이더)
- 확산도: **강**
- 난이도: **하~중**. clip-path 애니메이션은 anime.js로 바로 된다. 라우트 전환은 Next.js App Router와 View Transitions API를 조합해야 하므로 중간 난이도다.
- 적용: 역할 탭을 전환할 때 clip-path wipe로 섹션을 교체한다. 메뉴 오픈에도 같은 방식을 쓴다.
- 주의: 전환은 400ms 이하로 하고 입력을 막지 않는다.

### T6. 탐험형 공간 내비게이션 / 에디터형 UI 메타포
- 근거: Infia City(3D 도시와 Hierarchy/Inspector 패널), Overworld Audio(작업물 지도), Emotion(WebGL 오피스)
- 확산도: **중** (어워드 상위권에서는 강하지만 SaaS에서는 약함)
- 난이도: **상**. 3D 부분은 Three.js 영역이고, anime.js는 패널 UI 정도만 담당할 수 있다.
- 적용: 3D는 비권장이다. 대신 "인스펙터 패널" 메타포를 차용할 수 있다. 히어로에 실제 포트폴리오 카드가 있고, 호버하면 옆 패널에 핏 분석 항목이 채워지는 UI 목업을 둔다. 이렇게 하면 제품 자체가 히어로 비주얼이 된다.
- 주의: WebGL 폴백(Infia도 제공함), 번들 크기, 한국 모바일 트래픽.

### T7. 프리로더 + 퍼센트 카운터 + 숫자 넘버링 구조
- 근거: Grande Charte(%, 01–04), metic(000%, 01–08), Brandon Yasin·Huy Phan(프리로더)
- 확산도: **중** (포트폴리오·에이전시 사이트에서 흔함)
- 난이도: **하**
- 적용: 프리로더는 쓰지 않는다(채용 플랫폼에서는 이탈 요인). 숫자 카운터와 넘버링 섹션만 차용해 통계("등록 포트폴리오 N개")와 단계 표시에 쓴다.

### T8. 커서 반응 (커서 대체, 파티클, 포인터 위치에 따라 벌어지는 카드)
- 근거: Signal-A(커서 대체), Emotion(파티클), metic(포인터를 따라 벌어지는 카드 팬)
- 확산도: **중** (커스텀 커서 자체는 줄어드는 추세이고, "요소가 포인터에 반응"하는 방식이 주류)
- 난이도: **하~중**. pointermove와 `utils.lerp`, 또는 `createAnimatable`로 구현한다.
- 적용: 포트폴리오 카드 묶음이 포인터 쪽으로 부채꼴로 벌어지게 한다(metic 방식). 카드에는 3D 틸트를 약하게 준다.
- 주의: 기본 커서를 숨기지 않는다. 터치에서는 비활성화한다.

## 3. 한물간 / 피해야 할 패턴 (AI 생성 느낌 포함)
- 모든 섹션에 동일한 fade-up과 스태거를 반복하는 것. 가장 강한 "템플릿·AI" 신호다.
- 보라·파랑 그라디언트 블롭 배경 + 글래스 카드 3장 + "AI로 ○○하세요" 중앙 정렬 헤드라인. 현재 메인이 받는 "단순하다" 평가의 원인과 같다.
- 의미 없는 아이콘 3열 피처 그리드(이모지나 루시드 아이콘 + 짧은 문장).
- 기본 커서를 숨기는 커스텀 원형 커서, 스크롤 하이재킹(풀페이지 스냅), 긴 프리로더.
- 끝없는 로고 마퀴의 남용(Grande Charte처럼 여전히 쓰이지만 차별성이 없음).
- 모바일까지 그대로 적용한 무거운 패럴랙스. 2026 수상작에서도 Responsive 점수가 가장 낮은 항목이다(FORMAT 6.2).
- 실제 제품 화면 없이 추상 일러스트만 쓰는 것. 수상작들은 실제 작업물이나 제품 메타포를 전면에 둔다.

## 4. Talentfolio 메인 제안 (3줄)
1. **레이아웃**: Skiper39 배경 위에 비대칭 에디토리얼 그리드를 둔다. 큰 한글 헤드라인과 회전하는 직무명을 쓰고, 오른쪽에는 "실제 포트폴리오 카드 + 핏 인스펙터 패널" 목업을 놓는다. 지원자/헤드헌터 드래그 토글로 콘텐츠와 팔레트를 함께 전환한다(T2, T3, T6).
2. **스크롤**: 루프(업로드 → 분석 → 승인 → 제안)를 4단계 스크롤 스크러빙 시퀀스로 만들고, 핏 점수 카운트업과 Skip 링크를 둔다. 섹션마다 다른 진입 모션을 써서 일괄 fade-up을 피한다(T1, T7).
3. **마이크로인터랙션**: CTA 2개에만 리퀴드 모핑, 카드 묶음에는 포인터 팬과 틸트, 탭 전환에는 clip-path wipe를 쓴다. 모두 anime.js v4로 구현하고 `prefers-reduced-motion`과 키보드 대체 수단을 기본으로 갖춘다(T4, T5, T8).

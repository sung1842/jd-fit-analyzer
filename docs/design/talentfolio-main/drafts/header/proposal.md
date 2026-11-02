# 헤더 시안 H1–H3 (요구: "좀 더 부드럽고 깔끔하게")

공통 사항: 글자 로고만 씀(Lora italic, folio 그라디언트와 swash 유지, 배지 아이콘은 뺌). 토큰은 기존 `:root` 값을 그대로 쓰고, 모든 전환에 같은 이징 `cubic-bezier(.22,.8,.24,1)`을 적용. 860px 이하에서는 햄버거와 전체 화면 메뉴로 바뀜(Esc로 닫힘, 메뉴를 열면 첫 링크로 포커스 이동, `aria-expanded` 처리). `:focus-visible`에 cobalt 링, `prefers-reduced-motion`이면 전환을 끔, 앵커가 헤더에 가리지 않도록 `scroll-padding-top` 지정. 이번 시안은 순수 CSS 전환만으로 충분해서 anime.js는 쓰지 않음.

## 레퍼런스 조사 결과 (정직하게 표기)
- awwwards Creative Pass 요소 "Menu – Makepill" https://www.awwwards.com/inspiration/menu-makepill : 페이지에서 확인된 것은 태그(menu, navigation, pill, 3d, hover)뿐. 실제 동작은 확인하지 못했고 추정.
- awwwards "Header and navigation – Satalia" https://www.awwwards.com/inspiration/header-and-navigation-satalia : 데스크톱·모바일 헤더를 나눠 보여 주는 요소. 스크롤 동작은 페이지에 설명이 없어 확인 못 함.
- 플로팅 navbar 가이드 https://21st.dev/blog/react-floating-navbar-components (검색 요약 기준): 상단에서 몇 px 띄운 중앙 필, 목적지는 4개 안팎, 앵커가 바 밑으로 숨는 문제, blur의 스크롤 비용.
- CSSDA 최근 WOTD(10/17–10/26): 1minus1, Half the Sky(halfthesky.app), metic.studio 등. Half the Sky는 텍스트로만 확인했는데 제목, 언어 토글, 링크 2개로 된 아주 적은 항목의 헤더였음. 시각 스타일은 확인 못 함.
- recent.design: 피드 자체의 헤더가 미니멀한 텍스트 링크 그룹(Browse / Resources)으로 되어 있음. 웹사이트 항목은 목록에 없었음.

## H1: 떠 있는 필 캡슐 (스크롤하면 폭이 줄어듦)
- 콘셉트: 하늘 위에 뜬 반투명 유리 캡슐. 스크롤하면 폭을 1080에서 760으로 조여 화면 중심으로 모음.
- 근거: Makepill(필 형태, 추정)과 21st.dev 가이드(위에서 띄운 중앙 필, 4개 목적지). 메뉴가 4개인 우리 구성과 맞아서 차용.
- 스크롤 전: 흰색 38% + blur 12, 흰 테두리. 스크롤 후(40px 이상): 흰색 72%, 패딩 축소, 부드러운 그림자. 흰 섹션 위에서도 그림자 덕분에 구분됨.
- 링크 hover는 mist 배경 필, CTA는 cobalt 채움에 화살표가 살짝 이동.
- 모바일: 캡슐을 그대로 두고 오른쪽 햄버거 버튼과 전체 화면 메뉴.

## H2: 거의 투명한 미니멀 바 + 1px 진행 라인
- 콘셉트: 처음엔 배경 없이 글자만. 스크롤하면 흰색 82%와 1px 헤어라인이 생기고, 그 라인이 페이지 진행률을 cerulean에서 cobalt 그라디언트로 채움.
- 근거: Half the Sky와 recent.design의 적은 항목 텍스트 헤더(확인된 범위는 구조뿐, 시각은 추정). 장식을 빼고 선 하나로 상태를 보여 주는 방향.
- 레이아웃은 로고 / 가운데 정렬 메뉴 / 텍스트형 CTA "시작하기 →"의 3단 그리드. hover 시 밑줄이 왼쪽에서 그려짐.
- 스크롤 전 높이 72px, 후 60px.
- 모바일: 로고와 햄버거만 남기고, 진행 라인은 유지.

## H3: 스크롤 방향 반응(내릴 때 숨김, 올릴 때 등장) + 활성 섹션 인디케이터
- 콘셉트: 읽는 동안에는 비켜 있다가 위로 스크롤하면 돌아옴. 메뉴 안의 흰 "알약"이 현재 섹션으로 미끄러지듯 이동.
- 근거: Satalia(데스크톱과 모바일 헤더를 분리 설계, 동작은 추정)에 더해, 일반적인 hide-on-scroll 패턴을 쓴 것으로 조사에서 직접 확인한 사례는 없음.
- 160px를 넘겨 아래로 스크롤하면 `translateY(-110%)`로 숨고, 위로 올리면 다시 나타남. 헤더 안에 포커스가 있으면(`:focus-within`) 항상 보임. 활성 링크에는 `aria-current`를 붙임.
- 모바일: 메뉴 대신 가운데에 점 3개 인디케이터(활성 점은 길게 늘어남)를 두고 햄버거 사용.

## React 이식 포인트 (SkyLanding.tsx)
- `useScrollState()` 훅 하나로 `{y, dir, progress}`를 rAF와 passive 리스너로 받고, 클래스(`shrunk`/`solid`/`hide`)만 토글. 기존 `.sky-nav.solid` 로직을 바꿔 끼우면 됨.
- H3의 활성 섹션은 `IntersectionObserver`(rootMargin `-45% 0px -50% 0px`)로 #roles, #demo, #works를 관찰. pip 위치는 활성 링크의 `offsetLeft`/`offsetWidth`에서 계산하고 ref로 측정.
- H2의 진행 바는 `transform: scaleX()`만 쓰도록 해서 리렌더 없이 ref로 직접 style을 갱신.
- 모바일 메뉴는 `useState(open)`. 열려 있을 때 body 스크롤 잠금, Esc 처리, 포커스 복귀를 넣음. /desk, /start는 `next/link`로.
- 기존 `.logo-badge`는 제거하고 `.logo-type`과 swash만 유지. CSS는 `sky-landing.css`의 `.sky-landing` 스코프 안에 추가.
- 캔버스(openpeeps) 위에서 backdrop-filter 비용이 걱정되면 blur 값을 낮추거나 `.solid`일 때만 적용.

## v2 변경 내역 (QA_v1과 UX_review_v1 반영)

### 세 시안 공통
- 맨 아래에 코발트 `#cta` 섹션 추가. 헤더가 그 위에 오면 `.nav.on-dark` 클래스가 붙어 CTA가 흰 배경에 cobalt 글자로 바뀜. H2는 진행 바 색이 sun으로 바뀜.
- 메뉴 글자를 `--ink` 15px, 굵기 500으로 키움.
- 현재 섹션 표시: IntersectionObserver로 감지해 활성 링크에만 `aria-current="location"`을 붙이고, 나머지 링크에서는 속성을 지움. 860px 이하에서는 rootMargin을 `-40% 0px -55%`로 둠.
- 모바일 메뉴: 열려 있을 때만 `body.menu-open{overflow:hidden}`로 스크롤을 잠그고 `main.inert`를 켬. Tab 포커스는 버거와 메뉴 링크 안에서만 돌고, Esc로 닫으면 포커스가 버거로 돌아감.

### H1
- 상단 배경을 55%, 스크롤 후 85%로 올림.
- 폭(width) 전환을 빼고 `transform: translateY(-6px) scale(.97)` 하나로 바꿈. 전환하는 속성은 transform, background, box-shadow만 남김.
- 활성 링크에 mist 배경 필.

### H2
- P0 수정: swash 이탈. `.nav .logo{justify-self:start}`와 `.logo{width:max-content}`로 해결.
- CTA를 2단계 필로 바꿈. 상단에서는 cobalt 8% 배경에 cobalt 글자, `.solid` 상태에서는 cobalt 채움에 흰 글자.
- 상단에 50%에서 0으로 흐려지는 흰색 그라디언트를 깔고, 스크롤 후 배경은 85%.
- 높이는 64px로 고정하고 padding만 전환. 진행 바는 rAF로 묶고 `max`는 resize 때만 계산.
- 활성 링크는 밑줄을 고정해서 보여 줌.

### H3
- P0 수정: 숨김 판정에 누적 delta 임계값(아래로 12px이면 숨김, 위로 8px이면 등장)을 쓰고 rAF로 묶음.
- 앵커 클릭 후 900ms 동안은 숨기지 않음.
- 스크롤 후 배경을 85% 흰색으로 올리고, CTA를 cobalt 채움으로 바꿈(on-dark일 때 반전).
- 마크업 정리: pip을 `ul` 밖의 `.links-wrap` 안으로 옮김. pip이 처음 나타날 때는 transition 없이 위치부터 잡음.
- reduced-motion이면 숨김 동작 자체를 끔(CSS와 JS 둘 다).
- 모바일 점 인디케이터는 링크 수와 맞지 않아서 제거.

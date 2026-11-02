# 라운드 3 디자인 브리프 (사용자 피드백 반영, 2026-10-25)

> 리서치·기획(`TREND_BRIEF.md`, `research/`)은 **콘텐츠·구조 근거로만** 재사용. 다시 조사하지 않는다.
> 시각 규칙은 처음부터 새로 짠다.

## 버릴 것 (디자인을 망친 틀)
- talentfolio `DESIGN.md`(midnight/crimson/amber), `globals.css` 토큰(copper `#E07A5F`, 블루 `#3B6FFE`), `TREND_BRIEF.md`의 "고정 조건/포인트 1색/절제된 마이크로인터랙션" 같은 시각 제약 — **전부 무시**.
- 기존 시안 A·C의 레이아웃·토큰을 이어 쓰지 말 것. 시안 B는 **보류**(파일 유지, 수정·삭제 금지). 다만 B의 "요소마다 다르게 등장하는 스크롤 모션"은 사용자가 좋은 예로 지목함.

## 사용자 요구 (반드시)
1. **분위기**: 구인구직 사이트답게 **희망찬** 느낌. **하얀 배경** + 사용자가 넣은 배경 애니메이션(Skiper39: openpeeps 손그림 군중이 걸어가는 canvas, 스프라이트 `http://localhost:3000/images/peeps/all-peeps.png` 15열x7행) 유지. 색은 **푸른 계열 또는 초록 계열**, 손그림 군중과 어울리게.
2. **폰트가 AI 느낌의 주원인**: 한 가지 무난한 폰트 금지. 위치·용도별로 다양하게(디스플레이/헤드라인/본문/숫자·라벨/손글씨 포인트 등) 쓰되 하나의 분위기로 통일. 제목·메인 배너·시선을 끌어야 할 곳에 **특색 있는 폰트를 과감하게**. 한글 디스플레이 폰트 필수(예: Google Fonts의 Black Han Sans, Gasoek One, Bagel Fat One, Dongle, Gowun Batang, Hahmlet, Nanum Pen Script, Jua, Do Hyeon, Orbit 등 / jsdelivr의 Pretendard, Paperlogy 등 — 직접 골라 근거 제시). 영문 디스플레이도 어울리게 짝짓기.
3. **스크롤 애니메이션이 핵심**: AI는 전부 아래→위 fade-up, 예상되는 위치. 디자이너는 **배치는 정돈**(보는 사람이 복잡하지 않게)하되 **요소마다 등장·퇴장 방식을 다르게**(마스크 리빌, 가로 슬라이드, 스케일, 회전, 글자 분해, clip-path, 스크럽 진행, sticky 핀, 패럴랙스 깊이, 숫자 롤링, 선 드로잉, 퇴장 시 다른 방향 등). 섹션마다 섞어서 눈이 심심하지 않게. 퇴장 모션도 설계.
4. **메인 배너(히어로)는 사이트 디자인 기술의 총집합체**: 첫 화면에서 확 띄어야 함. 과감한 타이포, 군중 배경과의 상호작용, 레이어, 인터랙션 등을 집중 투입.

## 유지할 콘텐츠 근거 (리서치에서)
역할 분기(지원자/헤드헌터), 제품 미니 데모(JD→후보→핏 점수→헤드헌터 승인), 4단계 루프(의뢰→탐색·분석→승인→제안), "AI가 제안하고 사람이 승인", 실물 포트폴리오 마퀴, 숫자는 "예시" 표기. 역할 진입: `/start`, `/studio`(지원자), `/desk`(헤드헌터).

## 기술
- 모션은 anime.js v4 ESM `https://cdn.jsdelivr.net/npm/animejs@4.0.2/+esm` (`animate, createTimeline, stagger, onScroll, utils, splitText`가 4.0.2에 있는지 등 **https://animejs.com/documentation 에서 확인 후 사용**, 없으면 직접 구현). 스크롤 연동은 `onScroll` 우선.
- prefers-reduced-motion 대응, 375px 모바일 가로 스크롤 없음, 콘솔 에러 0.
- 단일 `index.html` 목업 + `proposal.md`(폰트 페어링 표와 근거, 컬러 토큰, 섹션별 **등장/퇴장 모션 표**, 21st.dev 요소 레퍼런스 + awwwards 전체 양식 레퍼런스와 적용 이유).

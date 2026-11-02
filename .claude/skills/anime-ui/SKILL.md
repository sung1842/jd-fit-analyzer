---
name: anime-ui
description: UI 작업 중 애니메이션(진입·전환·스태거·진행률·카운트업·호버/클릭 피드백·스크롤 연출)을 구현할 때 anime.js v4 로 작업하는 규칙. "애니메이션", "모션", "트랜지션", "움직이게", "페이드", "스태거" 요청 시 사용. web/ 및 talentfolio UI 공통.
---

# anime.js 애니메이션 작업 규칙

> 이 프로젝트의 UI 애니메이션은 **anime.js v4 (`animejs`)** 로 통일한다.
> 다른 모션 라이브러리(framer-motion, GSAP, react-spring 등)를 새로 추가하지 않는다.
> 단순 hover 색상 변화처럼 CSS `transition` 한 줄로 끝나는 것은 CSS 로 둔다 (JS 불필요).

## 1. 설치

대상 앱(`web/` 또는 `../test1-main/talentfolio`)에 아직 없으면:

```bash
npm install animejs@^4
```

v4 는 자체 타입을 포함하므로 `@types/animejs` 를 설치하지 않는다 (v3 용이라 충돌).

## 2. v4 API 표면 (v3 패턴 금지)

```ts
import { animate, createTimeline, stagger, utils } from 'animejs';

animate('.card', { opacity: [0, 1], y: [16, 0], duration: 500, ease: 'outQuad', delay: stagger(60) });

const tl = createTimeline({ defaults: { duration: 400, ease: 'outExpo' } });
tl.add('.a', { x: 100 }).add('.b', { opacity: 1 }, '-=200');
```

| v3 (금지) | v4 (사용) |
|---|---|
| `import anime from 'animejs'` / `anime({ targets, ... })` | `animate(targets, params)` |
| `anime.timeline()` | `createTimeline()` |
| `easing: 'easeOutQuad'` | `ease: 'outQuad'` |
| `translateX` 만 | `x` / `y` 단축 속성 사용 가능 |
| `complete:` / `update:` | `onComplete:` / `onUpdate:` |
| `anime.stagger` / `anime.set` | `stagger` / `utils.set` |

API가 확실하지 않으면 추측하지 말고 공식 문서(https://animejs.com/documentation)를 확인한다.

## 3. Next.js (App Router, React 19) 통합 규칙

- anime.js 를 쓰는 컴포넌트는 반드시 `'use client'`. 서버 컴포넌트에서 import 금지.
- 타깃은 전역 셀렉터보다 **ref 스코프**를 쓴다. 여러 요소는 `createScope({ root })` 사용.
- **언마운트 시 반드시 정리**: `revert()` 로 인라인 스타일·인스턴스를 되돌린다 (StrictMode 이중 실행 대비).

```tsx
'use client';
import { useEffect, useRef } from 'react';
import { createScope, animate, stagger } from 'animejs';

export function CandidateList({ items }: { items: Candidate[] }) {
  const root = useRef<HTMLUListElement>(null);
  useEffect(() => {
    const scope = createScope({ root }).add(() => {
      animate('li', { opacity: [0, 1], y: [12, 0], delay: stagger(50), duration: 400, ease: 'outQuad' });
    });
    return () => scope.revert();
  }, [items]);
  return <ul ref={root}>{items.map((c) => <li key={c.id}>{c.name}</li>)}</ul>;
}
```

- 재사용 패턴은 `web/lib/motion.ts`(또는 talentfolio 동일 위치)에 훅/프리셋으로 모은다
  (예: `useFadeInStagger`, `animateScore`). 컴포넌트마다 duration/ease 를 새로 정하지 말 것.

## 4. 이 프로젝트의 대표 적용처

- **Fit Report 카드 진입**: 스태거 페이드업.
- **overallScore 카운트업**: 숫자 객체를 `animate(obj, { value: score, onUpdate })` 로 보간해 텍스트 갱신.
- **SSE 진행률 바**: 이벤트마다 `animate(bar, { width: `${pct}%`, duration: 300 })` — 이전 애니메이션이 있으면 덮어써도 됨(v4 기본 composition).
- **HIL 승인/반려 피드백**: 짧은 scale/색상 펄스 후 목록에서 제거.

## 5. 품질·접근성 체크리스트

- `prefers-reduced-motion: reduce` 이면 duration 0 또는 애니메이션 생략 (`motion.ts` 프리셋에서 일괄 처리).
- `transform`/`opacity` 위주로 애니메이트한다. `width/height/top/left` 는 진행률 바처럼 불가피할 때만.
- 기본 duration 200~500ms. 데이터 확인을 방해하는 장식 루프(무한 반복) 금지.
- 애니메이션 종료 상태가 곧 최종 레이아웃이어야 한다 (JS 실패 시에도 콘텐츠가 보이도록 초기 `opacity:0` 은 JS 에서 설정).

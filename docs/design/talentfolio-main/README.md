# Talentfolio 메인 리디자인 — 기획 산출물 (2026-10-25)

보기: `.claude/launch.json` 의 `design-drafts` 서버 → http://localhost:8090/{A_planner|B_ui|C_ux}/index.html
(군중 배경은 talentfolio `:3000` 의 스프라이트를 쓰므로 talentfolio 서버가 떠 있어야 보임)

## 루프 이력
1. 트렌드 리서치: 기획자 3명(시각 A / 모션·레이아웃 B / 구조 C) 병렬 조사 → 교차 검토 → `TREND_BRIEF.md`
2. 시안: 기획자(A) / UI 디자이너(B) / UX 디자이너(C) v1 → 총괄 QA(실렌더) + 상호 리뷰(`drafts/*/review_of_*.md`) → v2

## 라운드 3 (2026-10-26, 현행) — 기준: `ROUND3_BRIEF.md`
UI 디자이너 3명 시안 → UX 2명 리뷰(`drafts/UX1_review_v1.md`, `UX2_review_v1.md`) + 총괄 실렌더 QA(`drafts/QA_round3_v1.md`) → v2 → 데스크톱/375px 재QA 후 핫픽스.

| | D 맑은 아침 하늘 | E 새싹이 자라는 | F 지평선 너머 |
|---|---|---|---|
| 색 | 하늘·코발트 + 해 노랑 | 새싹·민트·포레스트 그린 | 하늘→민트→연두 지평선 |
| 폰트 | Hahmlet(세리프) · Instrument Serif Italic · Outfit · Nanum Pen Script · Pretendard | Bagel Fat One · Bricolage Grotesque · Jua · Nanum Pen Script · Space Mono · Pretendard | Black Han Sans · Anton · JetBrains Mono · Nanum Pen Script · Pretendard |
| 히어로 | "모두의 출발" 글자 안을 군중이 걷는 마스크, 레이어 패럴랙스 | 거대 둥근 타이포 + 덩굴 드로잉 + 드래그 스티커 | 280vh 핀: 군중 속 한 사람 발견→JD 실 연결→점수→승인 도장 |
| UX1 / UX2 순위 | 2위 / 1위 | 1위 / 3위 | 3위 / 2위 |
| 남은 이슈 | — | 375px 스티커가 손글씨 eyebrow 끝을 살짝 덮음 | 모바일 제목 미등장 원인은 미확정(2.5초 폴백으로 해결) |

시안 A·C 는 라운드 2 산출물(참고용), 시안 B 는 **보류**(확정 후 삭제 예정).

## 라운드 2 시안 비교 (v2)
| | A 기획 | B UI | C UX |
|---|---|---|---|
| 콘셉트 | AI가 찾고, 사람이 정하고, 작업물이 증명한다 | 종이 위의 포트폴리오, 먹색 위의 한 점 코퍼 | 고르고, 만져보고, 바로 시작 |
| 강점 | 서사·HIL 메시지가 가장 명확, 첫 화면에 승인 버튼 | 시각 완성도 최고(키네틱 타이포·질감·카드 팬·마퀴) | 데모 상태·키보드·aria-live 설계 최고, 역할별 CTA 즉시 도달 |
| 약점 | 토큰 산재, 시각이 비교적 평범 | 토글 화살표키 없음, 히어로 CTA 1개(지원자 경로 약함) | 흰 카드+큰 라운드로 SaaS 인상 잔존, 히어로·워크스루 반복 |
| 실렌더 잔여 이슈 | 회전 단어 슬롯 고정폭 → 짧은 단어일 때 빈칸 | 동일(슬롯 빈칸), 모바일 OK | 없음 |

## 공통 미검증
- 21st.dev·awwwards 레퍼런스 일부는 검색 결과로 존재만 확인(각 proposal 에 표기).
- anime.js v4 일부 호출(ease 문자열 형식, timeline 위치 인자)은 문서 대조 미완.

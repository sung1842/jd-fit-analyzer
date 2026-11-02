"""데모 계정에 풀스택 개발자 가짜 데이터를 넣는다 (스튜디오 화면 확인용). 다시 실행하면 같은 상태로 덮어쓴다.

  crawler\\.venv\\Scripts\\python -I scripts/seed_demo_fullstack.py <user_id>

대상 계정의 fit 스키마 행만 지우고 다시 넣는다: 이력서(resume_*), 자기소개서, 공고 핀, 활동·근거 카드, 동의.
모든 회사·학교·성과는 가짜다. SUPABASE_DB_URL 은 crawler/.env.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import psycopg
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]
load_dotenv(ROOT / "crawler" / ".env")

USER = sys.argv[1] if len(sys.argv) > 1 else ""
if len(USER) != 36:
    sys.exit("사용법: seed_demo_fullstack.py <user_id(uuid)>")

BASICS = dict(
    headline="React·Node.js로 기획부터 배포까지 혼자 끝내는 3년차 풀스택 개발자",
    email="bangguseok.dev@example.com", phone="010-0000-0000",
    region_sido="서울", region_sigungu="마포구", birth_year=1997,
    desired_categories=["it_dev_data"], desired_regions=["서울", "경기"], desired_employment_types=["정규직"],
    desired_salary_text="5,000만원 이상 (협의)", available_from="2026-12-01", job_search_status="active",
    military_status="served",
    public_fields=["headline", "region_sido", "desired_categories", "desired_regions", "desired_employment_types", "job_search_status"],
)

EXPERIENCES = [
    dict(company="(가짜) 핀테크랩", department="플랫폼개발팀", position_title="풀스택 개발자 · 선임", employment_type="정규직",
         start_on="2024-03-01", end_on=None, is_current=True,
         duties="Next.js 관리자 콘솔과 Node.js(NestJS) 정산 API 개발·운영. PostgreSQL 스키마 설계, AWS ECS 배포 파이프라인 관리.",
         achievements="정산 배치 실행 시간 42분→9분 단축. 관리자 콘솔 첫 화면 LCP 3.8s→1.4s. 장애 대응 런북 작성.", sort=0),
    dict(company="(가짜) 스타트업 오늘장", department="개발팀", position_title="웹 개발자", employment_type="정규직",
         start_on="2022-07-01", end_on="2024-02-29", is_current=False,
         duties="React 커머스 프론트, Express 주문·결제 API, 관리자 백오피스 개발.",
         achievements="결제 실패율 2.1%→0.6% (재시도·멱등 키 도입). 디자인 시스템 컴포넌트 40개 정리.", sort=1),
    dict(company="(가짜) 코드캠프 교육센터", department=None, position_title="웹 개발 튜터 (파트타임)", employment_type="계약직",
         start_on="2021-09-01", end_on="2022-06-30", is_current=False,
         duties="부트캠프 수강생 React·Node 과제 리뷰, 주간 코드 리뷰 세션 진행.", achievements="수강생 32명 최종 프로젝트 배포 지원.", sort=2),
]
EDUCATIONS = [
    dict(school="(가짜) 한빛대학교", major="컴퓨터공학과", degree="bachelor", status="graduated",
         start_on="2016-03-01", end_on="2022-02-28", gpa="3.8/4.5", sort=0),
]
CERTS = [
    dict(kind="license", name="정보처리기사", issuer="한국산업인력공단", acquired_on="2021-08-20", sort=0),
    dict(kind="license", name="AWS Certified Solutions Architect – Associate", issuer="Amazon Web Services", acquired_on="2024-05-10", sort=1),
    dict(kind="language", name="TOEIC", score="875", acquired_on="2025-03-15", sort=2),
    dict(kind="language", name="OPIc", score="IM2", acquired_on="2024-11-02", sort=3, visibility="private"),
]
MISC = [
    dict(kind="project", title="사내 정산 대시보드 재구축", org="(가짜) 핀테크랩", start_on="2024-06-01", end_on="2024-10-31",
         description="Next.js App Router + React Query로 재작성, 서버 컴포넌트로 초기 로딩 개선. 테스트 커버리지 30%→71%.",
         url="https://github.com/example/settlement-dashboard", sort=0),
    dict(kind="project", title="오픈소스 기여: 폼 검증 라이브러리 버그 수정", org=None, start_on="2023-04-01", end_on="2023-04-30",
         description="중첩 배열 필드 검증 오류 수정 PR 머지.", url="https://github.com/example/form-lib/pull/1", sort=1),
    dict(kind="award", title="사내 해커톤 최우수상", org="(가짜) 스타트업 오늘장", start_on="2023-11-10", end_on=None,
         description="재고 알림 슬랙봇 1박 2일 구현.", url=None, sort=2),
    dict(kind="training", title="AWS 클라우드 아키텍처 과정 수료", org="(가짜) 클라우드아카데미", start_on="2024-02-01", end_on="2024-03-31",
         description=None, url=None, sort=3),
]

# 활동 → 근거 카드. claim 은 카드 본문, 제목은 활동 title. (visibility, trust, source, featured, 링크)
CARDS = [
    ("정산 배치 42분 → 9분",
     "상황: 매일 새벽 정산 배치가 42분 걸려 아침 업무가 밀렸어요. 행동: 쿼리 N+1을 묶음 조회로 바꾸고 파티션 인덱스를 추가했어요. 결과: 9분으로 줄었고 재실행도 쉬워졌어요.",
     "public", "attached", "web", True, [{"url": "https://github.com/example/settlement-batch/pull/42", "label": "개선 PR"}], "2024-09-12"),
    ("결제 실패율 2.1% → 0.6%",
     "어려움: 네트워크 타임아웃 뒤 재시도하면 중복 결제가 났어요. 행동: 멱등 키와 지수 백오프 재시도를 넣었어요. 배운 점: 실패를 기록해야 패턴이 보여요.",
     "public", "confirmed", "app", True, [{"url": "https://example.com/postmortem/payments", "label": "회고 문서"}], "2023-06-03"),
    ("관리자 콘솔 첫 화면 1.4초",
     "역할: 프론트 성능 개선 담당이었어요. 행동: 번들 분석 후 차트 라이브러리를 지연 로드하고 서버 컴포넌트로 옮겼어요. 결과: LCP 3.8초 → 1.4초.",
     "public", "attached", "web", True, [{"url": "https://github.com/example/settlement-dashboard", "label": "레포"}], "2024-08-21"),
    ("장애 대응 런북 만들기",
     "상황: 새벽 장애 때 사람마다 대응 순서가 달랐어요. 행동: 알람별 확인 순서와 롤백 명령을 한 문서로 정리했어요.",
     "private", "self", "web", False, [], "2025-02-14"),
    ("주니어 코드 리뷰 주간 세션",
     "행동: 매주 금요일 30분 동안 주니어 2명과 PR을 같이 읽었어요. 배운 점: 이유를 먼저 말하면 리뷰가 빨라져요.",
     "private", "self", "app", False, [], "2025-05-09"),
]

BASE_ANSWERS = [
    "정산 배치를 42분에서 9분으로 줄인 경험이 가장 자신 있습니다. 매일 새벽 배치가 늦어 운영팀 업무가 밀렸고, 실행 계획을 보니 N+1 조회가 원인이었습니다. "
    "묶음 조회와 파티션 인덱스로 바꾸고, 실패 시 구간만 다시 돌릴 수 있게 나눴습니다. 그 뒤로 아침 지연 문의가 없어졌습니다.",
    "결제 중복 문제를 해결했습니다. 타임아웃 뒤 재시도가 중복 결제를 만들고 있었고, 멱등 키와 백오프 재시도를 넣어 실패율을 2.1%에서 0.6%로 낮췄습니다. "
    "원인을 찾기 전까지 실패 로그를 매일 표로 정리한 것이 결정적이었습니다.",
    "기획 의도를 이해하고 화면과 API를 같이 설계하는 개발자로 일하고 싶습니다. 앞으로 2년 안에 데이터 파이프라인과 관측성까지 맡을 수 있게 공부하고 있습니다.",
]


def main() -> None:
    with psycopg.connect(os.environ["SUPABASE_DB_URL"], connect_timeout=20) as c:
        cur = c.cursor()
        u = USER
        for t in ("job_pins", "cover_letters", "resume_misc", "resume_certifications", "resume_educations", "resume_experiences",
                  "resume_basics", "evidence_cards", "activities"):
            cur.execute(f"delete from fit.{t} where user_id = %s", (u,))

        cur.execute(
            "insert into fit.resume_basics (user_id, " + ", ".join(BASICS) + ") values (%s, " + ", ".join(["%s"] * len(BASICS)) + ")",
            (u, *BASICS.values()),
        )
        for table, rows in (("resume_experiences", EXPERIENCES), ("resume_educations", EDUCATIONS),
                            ("resume_certifications", CERTS), ("resume_misc", MISC)):
            for r in rows:
                r = {"visibility": "public", **r}
                cur.execute(f"insert into fit.{table} (user_id, {', '.join(r)}) values (%s, {', '.join(['%s'] * len(r))})", (u, *r.values()))

        # 동의 (AI 정리 + 기업 매칭). 이미 유효한 동의가 있으면 그대로
        for purpose in ("self_ai", "matching"):
            cur.execute("select 1 from fit.consents where user_id=%s and purpose=%s and revoked_at is null", (u, purpose))
            if not cur.fetchone():
                cur.execute("insert into fit.consents (user_id, purpose) values (%s, %s)", (u, purpose))

        card_ids: list[str] = []
        for title, claim, vis, trust, source, featured, links, on in CARDS:
            cur.execute("insert into fit.activities (user_id, title, summary, occurred_on, tags) values (%s,%s,%s,%s,%s) returning id",
                        (u, title, claim[:200], on, ["개발"]))
            aid = cur.fetchone()[0]
            cur.execute(
                "insert into fit.evidence_cards (user_id, activity_id, claim, visibility, trust_level, source, links, featured, published_at, recorded_at)"
                " values (%s,%s,%s,%s,%s,%s,%s,%s, case when %s='public' then now() end, %s::date + time '21:00')"
                " returning id",
                (u, aid, claim, vis, trust, source, json.dumps(links, ensure_ascii=False), featured, vis, on),
            )
            card_ids.append(str(cur.fetchone()[0]))

        # 기본 자기소개서 (공개) + 공고별 버전 1개
        cur.execute("insert into fit.cover_letters (user_id, kind, title, visibility) values (%s,'base','기본 자기소개서','public') returning id", (u,))
        base_id = cur.fetchone()[0]
        qs = [("지원 분야와 관련해 가장 자신 있는 경험을 근거와 함께 소개해 주세요.", 1000),
              ("어려운 문제를 해결했던 과정과 그 결과를 알려 주세요.", 1000),
              ("앞으로 일하고 싶은 방식과 성장 목표를 적어 주세요.", 800)]
        cites = [[card_ids[0]], [card_ids[1]], []]
        for i, ((q, lim), ans) in enumerate(zip(qs, BASE_ANSWERS)):
            cur.execute("insert into fit.cover_letter_items (letter_id, user_id, seq, question_text, char_limit, answer, cited_card_ids)"
                        " values (%s,%s,%s,%s,%s,%s,%s)", (base_id, u, i + 1, q, lim, ans, cites[i]))

        cur.execute("select id, company, title from fit.job_postings where title ilike any(array['%%풀스택%%','%%fullstack%%','%%backend%%','%%백엔드%%']) order by first_seen_at desc limit 4")
        jobs = cur.fetchall()
        if jobs:
            jid, comp, jt = jobs[0]
            cur.execute("insert into fit.cover_letters (user_id, kind, job_posting_id, title) values (%s,'posting',%s,%s) returning id",
                        (u, jid, f"{comp} · {jt}"[:160]))
            lid = cur.fetchone()[0]
            cur.execute("insert into fit.cover_letter_items (letter_id, user_id, seq, question_text, char_limit, answer, cited_card_ids)"
                        " values (%s,%s,1,'지원 동기와 입사 후 하고 싶은 일을 적어 주세요.',700,%s,%s)",
                        (lid, u, "풀스택으로 화면과 API를 함께 설계해 온 경험을 귀사 서비스 고도화에 쓰고 싶습니다.", [card_ids[2]]))
        for (jid, _, _), lane in zip(jobs, ("watch", "apply", "watch", "hold")):
            cur.execute("insert into fit.job_pins (user_id, job_posting_id, lane) values (%s,%s,%s)", (u, jid, lane))
        c.commit()
        print(f"seed ok: cards {len(card_ids)}, pins {len(jobs)}")


if __name__ == "__main__":
    main()

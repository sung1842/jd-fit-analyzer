"""board_a 플랫폼 모듈의 순수 로직 테스트 (네트워크·DB 없음)."""
from __future__ import annotations

import unittest
from datetime import date

from jdcrawler.platforms import board_a as S
from jdcrawler.platforms import store as ST

# 실제 수집한 본문 발췌(55273455, 2026-10-24)에서 근무조건 부분만 — 보충 정규식이 실데이터에서 동작하는지 확인
REAL_BODY = (
    "📋 우대사항 • 전공: 전기/전자공학 기술 스택 🏠 근무 조건 • 고용형태 : 정규직 (수습 3개월) • 급여 : 면접 후 결정 "
    "• 근무지 : 서울 영등포구 국회대로70길 19, 대하빌딩 7층 (주)월급날 • 근무요일/시간 : 09:00~18:00 ( 오전 8~10시 30분 단위 유연출퇴근제 가능) "
    "🎁 복지 및 혜택 • 교육/생활 : 신규 입사자 교육(OJT)"
)


def full_rec(**over) -> dict:
    rec = {
        "external_id": "1", "url": "https://x/1", "company": "회사", "title": "제목",
        "career_text": "신입", "education_text": "학력무관", "employment_type_text": "정규직",
        "salary_text": "면접 후 결정", "location_text": "서울 강남구",
        "deadline_date": "2026-11-12", "deadline_text": "~ 11/12(목)",
        "body_text": "📋 주요업무 서버 개발 📋 자격요건 Java", "body_text_missing": False,
        "_section_found": True,
    }
    rec.update(over)
    return rec


# ── 파싱 ────────────────────────────────────────────────────────────────────

class BoardAPlatformTests(unittest.TestCase):
    def test_parse_list_basic_and_dedupe(self):
        html = """<div class="item_recruit" value="11"><h2 class="job_tit"><a title="백엔드">x</a></h2>
          <strong class="corp_name"><a>(주)가</a></strong><div class="job_date"><span class="date">상시채용</span></div></div>
          <div class="item_recruit" value="11"></div><div class="item_recruit" value="abc"></div>
          <div class="item_recruit" value="12"></div>"""
        items = S.parse_list(html, 10)
        assert [i["external_id"] for i in items] == ["11", "12"]
        assert items[0]["list_title"] == "백엔드" and items[0]["list_company"] == "(주)가" and items[0]["deadline_text"] == "상시채용"
        assert len(S.parse_list(html, 1)) == 1


    def test_parse_body_image_only_vs_text_and_categories(self):
        img = """<div class="user_content"><img src="//cdn/a.png"><img src="//cdn/b.png"><table><tr><td>회사
        업종 솔루션
        직종 선택 : IT개발·데이터 > 직무·직업 > 백엔드/서버개발
        선택 : IT개발·데이터 > 기술스택 > Java
        선택 : 연구·R&D > 전문분야 > AI(인공지능)
        선택 : 없는분류 > 전문분야 > X
        근무지 주소 서울 중구</td></tr></table></div>"""
        b = S.parse_body(img)
        assert b["body_image_count"] == 2 and b["body_text_missing"] is True
        assert b["skills"] == ["Java"]
        assert b["category_names"] == ["IT개발·데이터", "연구·R&D"]       # 알려진 대분류만
        assert "image_urls" not in b and not any("cdn" in str(v) for v in b.values())  # 이미지 URL 은 어디에도 없다

        txt = S.parse_body('<div class="user_content"><p>📋 주요업무<br>- 서버</p><p>📋 자격요건<br>- Java</p></div>')
        assert txt["body_image_count"] == 0 and txt["body_text_missing"] is False
        assert txt["body_text"] and "\n" in txt["body_text"]


    def test_format_body_keeps_newlines_and_unfolds_flat(self):
        keep = "📋 주요업무\n• 서버 개발\n• API 설계\n📋 자격요건\n• Java"
        assert S.format_body(keep) == keep
        flat = (
            "채용 포지션 개발자 📋 주요업무 • 웹 서비스 개발/운영 • 모바일 개발 "
            "📋 자격요건 • 신입/경력 무관 🏠 근무 조건 • 고용형태 : 정규직 (수습 3개월)"
        )
        out = S.format_body(flat)
        assert out is not None and out.count("\n") >= 5
        assert "\n📋 주요업무\n• 웹 서비스 개발/운영\n• 모바일 개발" in out
        assert "IT개발·데이터" not in out
        # 가운뎃점은 불릿이 아니다
        assert S.format_body("직군 IT개발·데이터 기획·전략") == "직군 IT개발·데이터 기획·전략"


    def test_strip_ui_noise(self):
        assert S.strip_ui_noise("서울 영등포구 지도보기") == "서울 영등포구"
        assert S.strip_ui_noise("정규직, 계약직 근무형태 상세보기 정규직 수습기간 3개월 닫기 근무형태 상세 설명") == "정규직, 계약직"
        assert S.strip_ui_noise("정규직 수습기간 3개월") == "정규직 수습기간 3개월"
        assert "상세보기" not in S.strip_ui_noise("6건 우대사항 상세보기 전공 Java 닫기 - 우대사항 상세")


    def test_parse_detail_english_keys_and_skips_preferred_blob(self):
        html = """<section class="jview-0-1">
          <a class="company" title="(주)가"></a><h1 class="tit_job">백엔드</h1>
          <dl><dt>경력</dt><dd>신입</dd></dl>
          <dl><dt>근무지역</dt><dd>서울 영등포구 지도보기</dd></dl>
          <dl><dt>조직문화</dt><dd>회식강요 안함, 자유복장</dd></dl>
          <dl><dt>대표자명*</dt><dd>홍길동</dd></dl>
          <dl><dt>Q1.근무 환경은 어떤가요?</dt><dd>내근 100%</dd></dl>
          <dl><dt>우대사항</dt><dd>6건 우대사항 상세보기 전공 Java 닫기 - 우대사항 상세</dd></dl>
        </section>
        <dl><dt>기업형태</dt><dd>중소기업, 주식회사</dd></dl>
        <meta property="og:description" content="마감일:2026-11-12">"""
        d = S.parse_detail(html, "1")
        assert d["career_text"] == "신입" and d["location_text"] == "서울 영등포구"
        assert d["org_culture_text"] == "회식강요 안함, 자유복장"
        assert d["ceo_name"] == "홍길동" and d["company_type_text"] == "중소기업, 주식회사"
        assert d["work_style_qna"] == [{"question": "근무 환경은 어떤가요?", "answer": "내근 100%"}]
        assert d["deadline_date"] == "2026-11-12"
        assert "nice_to_have" not in d and "우대사항" not in str(d.get("extra_facts"))


    def test_split_body_sections_respects_headers_and_moves_person_lines(self):
        payday = (
            "📋 주요업무\n• 웹 서비스 개발/운영\n• 모바일 개발\n"
            "📋 자격요건\n• 신입/경력 무관\n"
            "📋 우대사항\n• Spring 개발 경험\n• AWS 활용 경험"
        )
        p = S.split_body_sections(payday)
        assert p["key_duties"] == ["웹 서비스 개발/운영", "모바일 개발"]
        assert p["must_have"] == ["신입/경력 무관"]
        assert p["nice_to_have"] == ["Spring 개발 경험", "AWS 활용 경험"]

        comet = (
            "📋 주요업무 저희 회사는 개발팀 10여 명의 작은 회사입니다. 소기업입니다.\n"
            "• 항상 겸손한 자세로 배우고자 하는 의지가 있는 사람\n"
            "ㆍHTML, Javasc\nript, Java 문법을 이해하는 사람\n"
            "📋 자격요건\n• 신입\n• 학력무관\n"
            "🚀 채용절차 접수기간 : 2026-10-15\n선택 : IT개발·데이터 > 기술스택 > Java"
        )
        c = S.split_body_sections(comet)
        assert c["must_have"] == ["신입", "학력무관"]
        assert c["nice_to_have"] == []
        assert any("소기업" in x for x in c["unclassified"])
        assert any("의지가 있는 사람" in x for x in c["unclassified"])
        assert not any("사람" in x for x in c["key_duties"])


    # ── 보충(본문 정규식) / 마감일 ─────────────────────────────────────────────

    def test_body_regex_fallback_on_real_text(self):
        assert S.body_regex_fallback("employment_type_text", REAL_BODY) == "정규직 (수습 3개월)"
        assert S.body_regex_fallback("salary_text", REAL_BODY) == "면접 후 결정"
        assert S.body_regex_fallback("location_text", REAL_BODY) == "서울 영등포구 국회대로70길 19, 대하빌딩 7층 (주)월급날"
        assert S.body_regex_fallback("salary_text", "급여 언급 없음") is None
        assert S.body_regex_fallback("career_text", REAL_BODY) is None      # 대상 아닌 필드


    def test_parse_deadline_text_year_inference(self):
        today = date(2026, 10, 24)
        assert S.parse_deadline_text("~ 11/12(목)", today) == date(2026, 11, 12)
        assert S.parse_deadline_text("~ 01/05(화)", date(2026, 12, 20)) == date(2027, 1, 5)   # 해 넘김
        assert S.parse_deadline_text("상시채용", today) is None
        assert S.parse_deadline_text("~ 13/45", today) is None


    # ── 빈 값 원인별 처리 ───────────────────────────────────────────────────────

    def test_quality_all_present_is_ok(self):
        r = full_rec()
        q = S.evaluate_quality(r, detail_ok=True, body_ok=True)
        assert r["review_status"] == "ok" and r["missing_fields"] == {} and q["extract_failed_fields"] == []


    def test_quality_by_design_deadline_closes_without_review(self):
        r = full_rec(deadline_date=None, deadline_text="상시채용")
        S.evaluate_quality(r, detail_ok=True, body_ok=True)
        assert r["missing_fields"] == {"deadline_date": "by_design"} and r["review_status"] == "ok"


    def test_quality_fetch_failed_retries_later_without_fallback(self):
        r = full_rec(career_text=None, education_text=None, employment_type_text=None, salary_text=None, location_text=None,
                     body_text=REAL_BODY)
        S.evaluate_quality(r, detail_ok=False, body_ok=True)
        assert set(r["missing_fields"].values()) == {"fetch_failed"} and r["review_status"] == "retry_later"
        assert r["field_sources"] == {}                                   # 보충하지 않는다(일시 실패를 가리지 않으려고)


    def test_quality_extract_failed_when_section_missing_or_many_vanish(self):
        r = full_rec(career_text=None, education_text=None, salary_text=None, _section_found=True)   # 3개 동시 소실
        q = S.evaluate_quality(r, detail_ok=True, body_ok=True)
        assert all(r["missing_fields"][f] == "extract_failed" for f in ("career_text", "education_text", "salary_text"))
        assert r["review_status"] == "retry_later" and "salary_text" in q["extract_failed_fields"]

        r2 = full_rec(career_text=None, _section_found=False)
        S.evaluate_quality(r2, detail_ok=True, body_ok=True)
        assert r2["missing_fields"]["career_text"] == "extract_failed"


    def test_quality_not_in_source_filled_from_body(self):
        r = full_rec(salary_text=None, body_text=REAL_BODY)
        S.evaluate_quality(r, detail_ok=True, body_ok=True)
        assert r["salary_text"] == "면접 후 결정" and r["field_sources"] == {"salary_text": "body_regex"}
        assert "salary_text" not in r["missing_fields"] and r["review_status"] == "ok"


    def test_quality_not_in_source_text_body_without_value_just_records(self):
        r = full_rec(salary_text=None)             # 본문은 텍스트인데 급여 언급이 없다 → 원본에 없음. 사람이 볼 필요 없음
        S.evaluate_quality(r, detail_ok=True, body_ok=True)
        assert r["missing_fields"] == {"salary_text": "not_in_source"} and r["review_status"] == "ok"


    def test_quality_not_in_source_image_body_goes_to_human(self):
        r = full_rec(location_text=None, body_text="업종 솔루션", body_text_missing=True)
        S.evaluate_quality(r, detail_ok=True, body_ok=True)
        assert r["review_status"] == "needs_review" and "직접 확인" in r["review_note"]
        assert r["missing_fields"]["body_text"] == "not_in_source"


    def test_quality_deadline_filled_from_list_text(self):
        r = full_rec(deadline_date=None, deadline_text="~ 11/12(목)")
        S.evaluate_quality(r, detail_ok=True, body_ok=True)
        assert r["deadline_date"] and r["field_sources"]["deadline_date"] == "list_text"


    def test_fill_rates(self):
        recs = [full_rec(), full_rec(salary_text=None)]
        assert S.fill_rates(recs)["salary_text"] == 0.5 and S.fill_rates(recs)["title"] == 1.0


    # ── 저장 직전 길이 방어 (DB CHECK 와 같은 상한) ─────────────────────────────

    def test_build_row_enforces_db_limits(self):
        rec = full_rec(skills=["Spring"], category_names=[])
        comp = {
            "role_summary": "가" * 300, "key_duties": ["나" * 250, "나" * 250],
            "must_have": [f"m{i}" for i in range(80)], "nice_to_have": [],
            "skills": ["Java", "java", "x" * 61, "Next.js"] + [f"s{i}" for i in range(80)],
            "compressed_text": "다" * 400, "compress_status": "truncated",
        }
        row = ST.build_row(rec, comp)
        assert len(row["compressed_text"]) == 350 and len(row["role_summary"]) == 200
        assert all(len(x) <= 200 for x in row["key_duties"]) and len(row["must_have"]) == 50
        assert len(row["skills"]) == 50 and all(len(s) <= 60 for s in row["skills"])
        assert row["skills"][:3] == ["Spring", "Java", "Next.js"]          # 중복(java)·긴 항목 제거, 순서 유지
        assert row["compress_status"] == "truncated" and row["deadline_date"] == date(2026, 11, 12)


    def test_build_row_skipped_compression(self):
        row = ST.build_row(full_rec(), {"external_id": "1", "skipped": "이미지형"})
        assert row["compress_status"] == "skipped" and row["compressed_text"] is None and row["key_duties"] == []




class ReviewBatchTest(unittest.TestCase):
    """SQL 013: 검수 배치 ID 와 재수집 보호 상태."""

    def test_build_row_sets_batch_id(self):
        self.assertEqual(ST.build_row(full_rec(), None, "batch-1")["load_batch_id"], "batch-1")
        self.assertIsNone(ST.build_row(full_rec(), None)["load_batch_id"])

    def test_reviewed_rows_are_protected(self):
        self.assertEqual(set(ST._REVIEWED), {"resolved", "approved", "rejected"})

    def test_recrawl_resets_review_state(self):
        # 재수집 행이 옛 샘플 표시를 들고 새 배치로 넘어가면 새 배치의 샘플 추출이 건너뛰어진다 (1회차 리뷰 high)
        self.assertIn("is_sample = false", ST._REVIEW_RESET)
        self.assertIn("review_flags = '{}'", ST._REVIEW_RESET)
        self.assertIn("content_hash is distinct from excluded.content_hash", ST._REVIEW_RESET)


if __name__ == "__main__":
    unittest.main()

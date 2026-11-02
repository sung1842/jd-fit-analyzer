"""crawl4ai_site 안전장치 테스트 — 네트워크·브라우저 없이 순수 함수와 가짜 크롤러로만 검증한다."""
from __future__ import annotations

import asyncio
import json
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from jdcrawler.pii import mask_pii
from jdcrawler.sources import crawl4ai_site as site

SCHEMAS_DIR = Path(__file__).resolve().parent.parent / "schemas"

GOOD_CFG = {
    "enabled": True,
    "legal_basis": "robots.txt 2026-10-20 확인, /jobs 허용",
    "source": "crawl4ai:test-board",
    "base_url": "https://jobs.example.com",
}


class ValidateSiteConfigTest(unittest.TestCase):
    def test_enabled_missing(self):
        cfg = {k: v for k, v in GOOD_CFG.items() if k != "enabled"}
        with self.assertRaisesRegex(RuntimeError, "비활성화"):
            site.validate_site_config(cfg)

    def test_enabled_false(self):
        with self.assertRaisesRegex(RuntimeError, "비활성화"):
            site.validate_site_config({**GOOD_CFG, "enabled": False})

    def test_enabled_must_be_boolean_true(self):
        # "true"/1 같은 truthy 값은 통과시키지 않는다
        for bad in ("true", 1, "yes"):
            with self.assertRaisesRegex(RuntimeError, "비활성화"):
                site.validate_site_config({**GOOD_CFG, "enabled": bad})

    def test_legal_basis_blank(self):
        for bad in ("", "   ", "\n\t", None, 123):
            with self.assertRaisesRegex(RuntimeError, "legal_basis"):
                site.validate_site_config({**GOOD_CFG, "legal_basis": bad})

    def test_legal_basis_missing(self):
        cfg = {k: v for k, v in GOOD_CFG.items() if k != "legal_basis"}
        with self.assertRaisesRegex(RuntimeError, "legal_basis"):
            site.validate_site_config(cfg)

    def test_ok(self):
        self.assertIsNone(site.validate_site_config(dict(GOOD_CFG)))

    def test_source_prefix_required(self):
        with self.assertRaisesRegex(RuntimeError, "source"):
            site.validate_site_config({**GOOD_CFG, "source": "board_a"})


class SafeUrlTest(unittest.TestCase):
    BASE = "https://jobs.example.com"

    def call(self, href, allowed=()):
        return site.safe_url(self.BASE, href, allowed)

    def test_dangerous_schemes(self):
        for href in ("javascript:alert(1)", "JavaScript:alert(1)", "data:text/html,<script>1</script>",
                     "file:///etc/passwd", "ftp://jobs.example.com/x", "mailto:a@b.com"):
            self.assertIsNone(self.call(href), href)

    def test_protocol_relative_offsite(self):
        self.assertIsNone(self.call("//evil.com/x"))

    def test_protocol_relative_onsite(self):
        self.assertEqual(self.call("//jobs.example.com/x"), "https://jobs.example.com/x")

    def test_relative_path(self):
        self.assertEqual(self.call("/job/1"), "https://jobs.example.com/job/1")
        self.assertEqual(self.call("view?id=2"), "https://jobs.example.com/view?id=2")

    def test_subdomain_of_allowed(self):
        self.assertEqual(self.call("https://img.cdn.example.net/a", ["example.net"]), "https://img.cdn.example.net/a")
        # base_url 호스트의 하위 도메인도 허용
        self.assertEqual(self.call("https://m.jobs.example.com/a"), "https://m.jobs.example.com/a")

    def test_suffix_spoof_rejected(self):
        # 'evilexample.net' 은 'example.net' 의 하위 도메인이 아니다
        self.assertIsNone(self.call("https://evilexample.net/a", ["example.net"]))
        self.assertIsNone(self.call("https://jobs.example.com.evil.com/a"))

    def test_host_mismatch(self):
        self.assertIsNone(self.call("https://evil.com/a"))
        self.assertIsNone(self.call("https://example.com/a"))  # 상위 도메인은 허용 안 함
        self.assertIsNone(self.call("http://169.254.169.254/latest/meta-data"))
        self.assertIsNone(self.call("http://localhost:8010/"))

    def test_userinfo_rejected(self):
        self.assertIsNone(self.call("https://user:pw@jobs.example.com/a"))
        self.assertIsNone(self.call("https://jobs.example.com@evil.com/a"))
        self.assertIsNone(self.call("https://evil.com@jobs.example.com/a"))

    def test_backslash_bypass_rejected(self):
        self.assertIsNone(self.call("https://jobs.example.com\\@evil.com/a"))

    def test_case_insensitive_host(self):
        # urljoin 이 스킴을 소문자로 정규화한다. 호스트 대소문자는 허용 판정에만 무시한다.
        self.assertEqual(self.call("HTTPS://JOBS.Example.COM/Path"), "https://JOBS.Example.COM/Path")
        self.assertEqual(self.call("https://IMG.Example.NET/a", ["Example.Net"]), "https://IMG.Example.NET/a")

    def test_empty_or_non_string(self):
        for href in (None, "", "   ", 123):
            self.assertIsNone(self.call(href))

    def test_bad_port(self):
        self.assertIsNone(self.call("https://jobs.example.com:abc/x"))


class MaskPiiTest(unittest.TestCase):
    def test_none_and_empty(self):
        self.assertIsNone(mask_pii(None))
        self.assertEqual(mask_pii(""), "")

    def test_email(self):
        self.assertEqual(mask_pii("문의: hr.team+kr@Example-Corp.co.kr 로 보내주세요"), "문의: [email] 로 보내주세요")

    def test_phone_variants(self):
        for raw in ("010-1234-5678", "010.1234.5678", "010 1234 5678", "01012345678", "02-123-4567", "02-1234-5678",
                    "031-123-4567", "0212345678", "0312345678", "(02) 123-4567", "+82 10-1234-5678",
                    "+82-2-123-4567", "+82 (0)10 1234 5678", "0505-123-4567"):
            self.assertEqual(mask_pii(f"전화 {raw} 로 연락"), "전화 [phone] 로 연락", raw)

    def test_harmless_numbers_kept(self):
        for text in ("Java 17 경험", "Python 3.11, Node 20", "연봉 4,000~6,000만원", "연봉 3000-4000",
                     "마감 2024-10-20", "2026.10.20 ~ 2026.11.30", "사업자번호 123-45-67890",
                     "대표번호 1588-1234", "ID0212345678", "Spring Boot 3.2.1", "경력 3~5년"):
            self.assertEqual(mask_pii(text), text, text)

    def test_mixed(self):
        out = mask_pii("담당 a@b.com / 010-1111-2222, 연봉 5000, Java 17")
        self.assertEqual(out, "담당 [email] / [phone], 연봉 5000, Java 17")


class PickDelayTest(unittest.TestCase):
    def test_default(self):
        self.assertEqual(site._pick_delay({}, {}), (3.0, 7.0))

    def test_schema_wins_over_env(self):
        env = {"CRAWL_DELAY_MIN": "10", "CRAWL_DELAY_MAX": "20"}
        self.assertEqual(site._pick_delay({"delay": [4, 9]}, env), (4.0, 9.0))

    def test_env_fallback(self):
        self.assertEqual(site._pick_delay({}, {"CRAWL_DELAY_MIN": "5", "CRAWL_DELAY_MAX": "8"}), (5.0, 8.0))

    def test_env_partial(self):
        self.assertEqual(site._pick_delay({}, {"CRAWL_DELAY_MIN": "2"}), (2.0, 7.0))
        self.assertEqual(site._pick_delay({}, {"CRAWL_DELAY_MAX": "9"}), (3.0, 9.0))

    def test_min_gt_max(self):
        with self.assertRaises(ValueError):
            site._pick_delay({"delay": [8, 3]}, {})
        with self.assertRaises(ValueError):
            site._pick_delay({}, {"CRAWL_DELAY_MIN": "9"})  # max 기본 7 보다 큼

    def test_min_below_one(self):
        with self.assertRaises(ValueError):
            site._pick_delay({"delay": [0.5, 3]}, {})
        with self.assertRaises(ValueError):
            site._pick_delay({}, {"CRAWL_DELAY_MIN": "0", "CRAWL_DELAY_MAX": "3"})

    def test_malformed(self):
        for bad in ([3], [3, 7, 9], "3-7", ["a", "b"]):
            with self.assertRaises(ValueError):
                site._pick_delay({"delay": bad}, {})
        with self.assertRaises(ValueError):
            site._pick_delay({}, {"CRAWL_DELAY_MIN": "abc"})


class UserAgentTest(unittest.TestCase):
    def test_contact_required(self):
        with self.assertRaisesRegex(RuntimeError, "CRAWLER_CONTACT"):
            site.build_user_agent({})
        with self.assertRaisesRegex(RuntimeError, "CRAWLER_CONTACT"):
            site.build_user_agent({"CRAWLER_CONTACT": "   "})

    def test_contact_ua(self):
        self.assertEqual(site.build_user_agent({"CRAWLER_CONTACT": "ops@example.com"}),
                         "jdfit-crawler/1.0 (+contact:ops@example.com)")
        self.assertIn("https://example.com/bot", site.build_user_agent({"CRAWLER_CONTACT": "https://example.com/bot"}))

    def test_custom_ua_wins(self):
        env = {"CRAWLER_USER_AGENT": "my-bot/2 (+mailto:a@b.com)", "CRAWLER_CONTACT": "ops@example.com"}
        self.assertEqual(site.build_user_agent(env), "my-bot/2 (+mailto:a@b.com)")

    def test_custom_ua_without_contact_ok(self):
        self.assertEqual(site.build_user_agent({"CRAWLER_USER_AGENT": "x/1 (+a@b.com)"}), "x/1 (+a@b.com)")

    def test_bad_contact_format(self):
        for bad in ("not-a-contact", "a@b.com; evil", "a@b.com)\r\nX: y"):
            with self.assertRaisesRegex(RuntimeError, "CRAWLER_CONTACT"):
                site.build_user_agent({"CRAWLER_CONTACT": bad})


class RecordToPostingTest(unittest.TestCase):
    BASE = "https://jobs.example.com"

    def make(self, rec, allowed=()):
        return site._record_to_posting("crawl4ai:t", self.BASE, rec, {}, allowed)

    def test_dangerous_url_not_stored(self):
        for href in ("javascript:alert(1)", "data:text/html,x", "//evil.com/x", "https://evil.com/x",
                     "https://u:p@jobs.example.com/x"):
            p = self.make({"title": "백엔드", "url": href})
            self.assertIsNotNone(p, href)  # 공고 자체는 남기되
            self.assertIsNone(p.url, href)  # 위험 URL 은 저장하지 않는다

    def test_good_url_stored(self):
        p = self.make({"title": "백엔드", "url": "/job/1"})
        self.assertEqual(p.url, "https://jobs.example.com/job/1")

    def test_external_id_not_derived_from_rejected_url(self):
        p = self.make({"title": "백엔드", "url": "javascript:alert(1)"})
        self.assertEqual(len(p.external_id), 20)

    def test_pii_masked_in_description_and_raw(self):
        p = self.make({
            "title": "백엔드",
            "description": "지원: hr@corp.com / 02-123-4567, Java 17",
            "contact_note": "010-1234-5678",
            "nested": {"mail": "a@b.com"},
            "tags": ["x@y.com", "ok"],
        })
        self.assertEqual(p.description, "지원: [email] / [phone], Java 17")
        self.assertEqual(p.raw["contact_note"], "[phone]")
        self.assertEqual(p.raw["nested"], {"mail": "[email]"})
        self.assertEqual(p.raw["tags"], ["[email]", "ok"])


class FetchGateTest(unittest.TestCase):
    def test_example_board_is_disabled(self):
        path = SCHEMAS_DIR / "example_board.json"
        cfg = json.loads(path.read_text(encoding="utf-8"))  # JSON 유효성
        self.assertIs(cfg["enabled"], False)
        self.assertEqual(cfg["legal_basis"], "")
        self.assertEqual(cfg["allowed_hosts"], [])
        self.assertEqual(cfg["delay"], [3, 7])
        self.assertEqual(cfg["max_runtime_sec"], 3000)
        with mock.patch.object(site, "_load_crawl4ai", side_effect=AssertionError("게이트 전에 crawl4ai 로드됨")):
            with self.assertRaisesRegex(RuntimeError, "비활성화"):
                asyncio.run(site.fetch(path))

    def _write(self, cfg: dict) -> Path:
        tmp = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8")
        with tmp:
            json.dump(cfg, tmp)
        self.addCleanup(Path(tmp.name).unlink)
        return Path(tmp.name)

    def test_blank_legal_basis_rejected_before_crawl4ai(self):
        path = self._write({**GOOD_CFG, "legal_basis": " ", "list": {"url": "https://jobs.example.com/", "schema": {}}})
        with mock.patch.object(site, "_load_crawl4ai", side_effect=AssertionError("로드되면 안 됨")):
            with self.assertRaisesRegex(RuntimeError, "legal_basis"):
                asyncio.run(site.fetch(path))

    def test_missing_contact_rejected_before_crawl4ai(self):
        path = self._write({**GOOD_CFG, "list": {"url": "https://jobs.example.com/", "schema": {}}})
        with mock.patch.dict("os.environ", {}, clear=True), \
                mock.patch.object(site, "_load_crawl4ai", side_effect=AssertionError("로드되면 안 됨")):
            with self.assertRaisesRegex(RuntimeError, "CRAWLER_CONTACT"):
                asyncio.run(site.fetch(path))

    def test_bad_delay_rejected_before_crawl4ai(self):
        path = self._write({**GOOD_CFG, "delay": [0.2, 1], "list": {"url": "https://jobs.example.com/", "schema": {}}})
        with mock.patch.dict("os.environ", {"CRAWLER_CONTACT": "ops@example.com"}, clear=True), \
                mock.patch.object(site, "_load_crawl4ai", side_effect=AssertionError("로드되면 안 됨")):
            with self.assertRaises(ValueError):
                asyncio.run(site.fetch(path))


# ── 가짜 Crawl4AI 로 재시도·robots·첫 페이지 실패·예산 동작 검증 ─────────────────────────────

class FakeResult(SimpleNamespace):
    pass


def _ok(content=None, md="본문"):
    return FakeResult(success=True, error_message=None, extracted_content=content,
                      markdown=SimpleNamespace(fit_markdown=md, raw_markdown=md))


def _fail(msg="timeout"):
    return FakeResult(success=False, error_message=msg, extracted_content=None, markdown=None)


class FakeCrawler:
    """arun 호출 기록 + url 별 응답 시퀀스."""

    def __init__(self, responses, latency=0.0):
        self.responses = {k: list(v) for k, v in responses.items()}
        self.calls: list[str] = []
        self.latency = latency  # 실제 경과 시간을 만들어 예산 초과를 결정적으로 재현

    async def arun(self, url, config):
        self.calls.append(url)
        if self.latency:
            time.sleep(self.latency)
        seq = self.responses.get(url)
        if not seq:
            return _fail("no response")
        return seq.pop(0) if len(seq) > 1 else seq[0]


def _fake_loader(crawler: FakeCrawler, browser_kwargs: list):
    class FakeBrowserConfig:
        def __init__(self, **kw):
            browser_kwargs.append(kw)

    class FakeAsyncWebCrawler:
        def __init__(self, config=None):
            pass

        async def __aenter__(self):
            return crawler

        async def __aexit__(self, *a):
            return False

    class FakeRunConfig:
        def __init__(self, **kw):
            self.kw = kw

    class FakeStrategy:
        def __init__(self, schema):
            self.schema = schema

    cache = SimpleNamespace(BYPASS="bypass")
    return lambda: (FakeAsyncWebCrawler, FakeBrowserConfig, cache, FakeRunConfig, FakeStrategy)


class RetryTest(unittest.TestCase):
    def run_retry(self, results):
        crawler = FakeCrawler({"https://jobs.example.com/x": results})
        sleeps: list[float] = []

        async def fake_sleep(sec):
            sleeps.append(sec)

        with mock.patch.object(site.asyncio, "sleep", fake_sleep):
            out = asyncio.run(site._arun_with_retry(crawler, "https://jobs.example.com/x", object(), "t"))
        return out, crawler, sleeps

    def test_retries_twice_then_gives_up(self):
        out, crawler, sleeps = self.run_retry([_fail("timeout")])
        self.assertIsNone(out)
        self.assertEqual(len(crawler.calls), 3)
        self.assertEqual(sleeps, [2.0, 4.0])

    def test_succeeds_on_retry(self):
        out, crawler, sleeps = self.run_retry([_fail("boom"), _ok("[]")])
        self.assertIsNotNone(out)
        self.assertEqual(len(crawler.calls), 2)
        self.assertEqual(sleeps, [2.0])

    def test_robots_block_not_retried(self):
        for msg in ("Blocked by robots.txt", "ROBOTS disallow", "Robots"):
            out, crawler, sleeps = self.run_retry([_fail(msg)])
            self.assertIsNone(out)
            self.assertEqual(len(crawler.calls), 1, msg)
            self.assertEqual(sleeps, [])

    def test_exception_is_treated_as_failure(self):
        class Boom:
            calls = 0

            async def arun(self, url, config):
                Boom.calls += 1
                raise ConnectionError("net down access-key=SECRET123")

        async def fake_sleep(sec):
            pass

        with mock.patch.object(site.asyncio, "sleep", fake_sleep):
            out = asyncio.run(site._arun_with_retry(Boom(), "https://jobs.example.com/x", object(), "t"))
        self.assertIsNone(out)
        self.assertEqual(Boom.calls, 3)


class FetchFlowTest(unittest.TestCase):
    LIST_URL = "https://jobs.example.com/jobs?page={page}"

    def cfg(self, **over):
        base = {
            **GOOD_CFG,
            "list": {"url": self.LIST_URL, "pages": 2, "schema": {"name": "j", "baseSelector": "x", "fields": []}},
            "detail": {"css_selector": "section"},
            "delay": [1, 1],
        }
        base.update(over)
        return base

    def run_fetch(self, cfg, responses, latency=0.0, **fetch_kw):
        tmp = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8")
        with tmp:
            json.dump(cfg, tmp)
        self.addCleanup(Path(tmp.name).unlink)
        crawler = FakeCrawler(responses, latency)
        browser_kwargs: list = []
        sleeps: list[float] = []

        async def fake_sleep(sec):
            sleeps.append(sec)

        env = {"CRAWLER_CONTACT": "ops@example.com"}
        with mock.patch.dict("os.environ", env, clear=True), \
                mock.patch.object(site, "_load_crawl4ai", _fake_loader(crawler, browser_kwargs)), \
                mock.patch.object(site.asyncio, "sleep", fake_sleep):
            postings = asyncio.run(site.fetch(Path(tmp.name), **fetch_kw))
        return postings, crawler, browser_kwargs, sleeps

    def test_first_page_failure_raises(self):
        with self.assertRaisesRegex(RuntimeError, "list_failed_or_empty"):
            self.run_fetch(self.cfg(), {})

    def test_first_page_empty_raises(self):
        with self.assertRaisesRegex(RuntimeError, "list_failed_or_empty"):
            self.run_fetch(self.cfg(), {"https://jobs.example.com/jobs?page=1": [_ok("[]")]})

    def test_first_page_robots_raises_without_retry(self):
        url = "https://jobs.example.com/jobs?page=1"
        with self.assertRaisesRegex(RuntimeError, "list_failed_or_empty"):
            self.run_fetch(self.cfg(), {url: [_fail("robots.txt disallow")]})
        # 재시도 여부는 RetryTest.test_robots_block_not_retried 에서 검증

    def test_later_page_failure_keeps_earlier_results(self):
        recs = json.dumps([{"title": "A", "url": "/a"}])
        postings, crawler, bk, _ = self.run_fetch(
            self.cfg(detail=None),
            {"https://jobs.example.com/jobs?page=1": [_ok(recs)], "https://jobs.example.com/jobs?page=2": [_fail("x")]},
        )
        self.assertEqual([p.title for p in postings], ["A"])

    def test_browser_config_and_delay(self):
        recs = json.dumps([{"title": "A", "url": "/a"}, {"title": "B", "url": "https://evil.com/b"}])
        postings, crawler, bk, sleeps = self.run_fetch(
            self.cfg(list={"url": self.LIST_URL, "pages": 1, "schema": {}}),
            {"https://jobs.example.com/jobs?page=1": [_ok(recs)],
             "https://jobs.example.com/a": [_ok(None, "문의 hr@corp.com")]},
            delay_sec=None,
        )
        self.assertEqual(bk[0]["ignore_https_errors"], False)
        self.assertEqual(bk[0]["user_agent"], "jdfit-crawler/1.0 (+contact:ops@example.com)")
        # 오프사이트 상세는 방문하지 않는다
        self.assertEqual(crawler.calls, ["https://jobs.example.com/jobs?page=1", "https://jobs.example.com/a"])
        # 목록→상세 사이 지연이 적용됨(스키마 delay [1,1])
        self.assertEqual(sleeps, [1.0])
        by_title = {p.title: p for p in postings}
        self.assertEqual(by_title["A"].description, "문의 [email]")
        self.assertIsNone(by_title["B"].url)

    def test_fixed_delay_backward_compat(self):
        recs = json.dumps([{"title": "A", "url": "/a"}])
        _, _, _, sleeps = self.run_fetch(
            self.cfg(),
            {"https://jobs.example.com/jobs?page=1": [_ok(recs)], "https://jobs.example.com/jobs?page=2": [_ok("[]")],
             "https://jobs.example.com/a": [_ok(None)]},
            delay_sec=2.5,
        )
        self.assertTrue(sleeps and all(s == 2.5 for s in sleeps))

    def test_detail_robots_skipped_and_list_info_kept(self):
        recs = json.dumps([{"title": "A", "url": "/a"}, {"title": "B", "url": "/b"}])
        postings, crawler, _, _ = self.run_fetch(
            self.cfg(list={"url": self.LIST_URL, "pages": 1, "schema": {}}),
            {"https://jobs.example.com/jobs?page=1": [_ok(recs)],
             "https://jobs.example.com/a": [_fail("blocked by robots.txt")],
             "https://jobs.example.com/b": [_ok(None, "본문B")]},
            delay_sec=1,
        )
        self.assertEqual(crawler.calls.count("https://jobs.example.com/a"), 1)  # 재시도 없음
        self.assertEqual({p.title for p in postings}, {"A", "B"})

    def test_runtime_budget_stops_details(self):
        recs = json.dumps([{"title": "A", "url": "/a"}, {"title": "B", "url": "/b"}])
        postings, crawler, _, _ = self.run_fetch(
            self.cfg(list={"url": self.LIST_URL, "pages": 1, "schema": {}}, max_runtime_sec=0.01),
            {"https://jobs.example.com/jobs?page=1": [_ok(recs)]},
            latency=0.05,  # 목록 1회가 예산(0.01s)을 넘긴다
            delay_sec=1,
        )
        # 목록 1회만 수행, 상세는 예산 초과로 중단, 그래도 지금까지 결과는 반환
        self.assertEqual(crawler.calls, ["https://jobs.example.com/jobs?page=1"])
        self.assertEqual({p.title for p in postings}, {"A", "B"})


class StdoutCleanTest(unittest.TestCase):
    def test_log_goes_to_stderr_only(self):
        import contextlib
        import io

        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            site._log("hello access-key=SECRET123")
        self.assertEqual(out.getvalue(), "")
        self.assertIn("hello", err.getvalue())


if __name__ == "__main__":
    unittest.main()

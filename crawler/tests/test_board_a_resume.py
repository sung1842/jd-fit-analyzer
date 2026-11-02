"""이어하기·차단 중단·브라우저 재기동·내용 지문 테스트. 네트워크·브라우저·DB 없이 돈다."""
import asyncio
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from jdcrawler import checkpoint as cp
from jdcrawler.platforms import board_a
from jdcrawler.platforms.store import build_row

DETAIL_OK = '<section class="jview"><h1 class="tit_job">백엔드</h1><a class="company" title="A사"></a></section>'
BODY_OK = '<div class="user_content">주요업무\n- API 개발\n자격요건\n- Java</div>'


class FakeCrawler:
    """crawl4ai.AsyncWebCrawler 대역. 몇 번째 브라우저인지 센다."""
    opened = 0

    def __init__(self, config=None):
        FakeCrawler.opened += 1

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


def run_fetch(arun, items, **kw):
    """board_a.fetch 를 가짜 브라우저·가짜 arun 으로 돌린다. arun(url) → html 또는 None, 예외 가능."""
    FakeCrawler.opened = 0

    async def fake_retry(crawler, url, run, label):
        html = arun(url)
        return None if html is None else SimpleNamespace(html=html, success=True)

    saved: list[dict] = []
    with mock.patch("crawl4ai.AsyncWebCrawler", FakeCrawler), \
            mock.patch.object(board_a, "_arun_with_retry", fake_retry), \
            mock.patch.object(board_a, "DELAY", (0, 0)), \
            mock.patch.object(board_a, "build_user_agent", lambda env: "test-ua"):
        try:
            recs, summary = asyncio.run(board_a.fetch(items=items, on_record=saved.append, **kw))
        except Exception as e:  # 호출부가 예외 종류를 검사
            return saved, e
    return saved, summary


def items(*ids):
    return [{"external_id": i, "list_title": f"t{i}", "list_company": "c"} for i in ids]


class SortAndBlockTests(unittest.TestCase):
    def test_newest_first_by_external_id(self):
        got = board_a.sort_newest_first(items("100", "300", "200"))
        self.assertEqual([x["external_id"] for x in got], ["300", "200", "100"])

    def test_looks_blocked(self):
        self.assertTrue(board_a.looks_blocked("<p>비정상적인 접근이 감지되었습니다</p>"))
        self.assertTrue(board_a.looks_blocked("<div class='g-recaptcha'></div>"))
        self.assertFalse(board_a.looks_blocked(DETAIL_OK))
        self.assertFalse(board_a.looks_blocked(None))


class FetchTests(unittest.TestCase):
    def test_all_ok(self):
        saved, summary = run_fetch(lambda u: DETAIL_OK if "view?" in u else BODY_OK, items("1", "2", "3"))
        self.assertEqual([r["external_id"] for r in saved], ["1", "2", "3"])
        self.assertEqual(summary["browser_restarts"], 0)

    def test_block_marker_stops_and_keeps_earlier(self):
        def arun(u):
            if "rec_idx=3" in u:
                return "<p>접근이 차단되었습니다</p>"
            return DETAIL_OK if "view?" in u else BODY_OK
        saved, err = run_fetch(arun, items("1", "2", "3", "4"))
        self.assertIsInstance(err, board_a.CrawlBlocked)
        self.assertEqual([r["external_id"] for r in saved], ["1", "2"])   # 3·4 는 저장 안 됨 → 이어하기 대상

    def test_fail_streak_restarts_once_then_blocks(self):
        # 2번부터 상세가 계속 실패: 3건 연속 → 재기동 1회 → 새 브라우저에서도 실패 → 차단으로 멈춤
        saved, err = run_fetch(lambda u: (DETAIL_OK if "rec_idx=1" in u else None) if "view?" in u else BODY_OK,
                               items("1", "2", "3", "4", "5", "6"))
        self.assertIsInstance(err, board_a.CrawlBlocked)
        self.assertEqual(FakeCrawler.opened, 2)
        self.assertEqual(saved[0]["external_id"], "1")

    def test_browser_crash_resumes_remaining_in_new_browser(self):
        crashed = {"done": False}

        def arun(u):
            if "rec_idx=2" in u and "view?" in u and not crashed["done"]:
                crashed["done"] = True
                raise OSError("Target page, context or browser has been closed")
            return DETAIL_OK if "view?" in u else BODY_OK
        saved, summary = run_fetch(arun, items("1", "2", "3"))
        self.assertEqual([r["external_id"] for r in saved], ["1", "2", "3"])   # 중복·누락 없음
        self.assertEqual(summary["browser_restarts"], 1)

    def test_browser_crash_over_limit_raises(self):
        def arun(u):
            raise OSError("browser closed")
        saved, err = run_fetch(arun, items("1", "2"))
        self.assertIsInstance(err, RuntimeError)
        self.assertIn("browser_crashed", str(err))
        self.assertEqual(saved, [])


class CheckpointTests(unittest.TestCase):
    def test_paths_from_any_suffix(self):
        for name in ("x.json", "x.plan.json", "x.partial.jsonl", "x"):
            self.assertEqual(cp.CheckpointPaths.from_any(f"out/{name}").stem.name, "x")

    def test_resume_skips_done_and_retries_retry_later(self):
        with tempfile.TemporaryDirectory() as d:
            paths = cp.CheckpointPaths(Path(d) / "s")
            plan = items("5", "4", "3", "2")
            cp.write_plan(paths, plan, {"list_url": "u"})
            cp.append_record(paths, {"external_id": "5", "review_status": "ok"})
            cp.append_record(paths, {"external_id": "4", "review_status": "retry_later"})
            with paths.partial.open("a", encoding="utf-8") as f:
                f.write('{"external_id": "3", "rev')          # 죽는 순간 반쯤 쓰인 줄
            got_items, meta = cp.read_plan(paths)
            done = cp.read_partial(paths)
            self.assertEqual([x["external_id"] for x in cp.remaining_items(got_items, done)], ["4", "3", "2"])
            self.assertEqual(meta["list_url"], "u")

    def test_last_line_wins_and_finish_cleans_up(self):
        with tempfile.TemporaryDirectory() as d:
            paths = cp.CheckpointPaths(Path(d) / "s")
            plan = items("2", "1")
            cp.write_plan(paths, plan, {})
            cp.append_record(paths, {"external_id": "1", "review_status": "retry_later"})
            cp.append_record(paths, {"external_id": "2", "review_status": "ok"})
            cp.append_record(paths, {"external_id": "1", "review_status": "ok"})
            recs = cp.ordered_records(plan, cp.read_partial(paths))
            self.assertEqual([(r["external_id"], r["review_status"]) for r in recs], [("2", "ok"), ("1", "ok")])
            cp.finish(paths, recs, {})
            self.assertTrue(paths.final.exists())
            self.assertFalse(paths.plan.exists() or paths.partial.exists())


class ContentHashTests(unittest.TestCase):
    def base(self, **over):
        rec = {"external_id": "1", "url": "https://x", "title": "백엔드", "company": "A", "body_text": "본문"}
        rec.update(over)
        return rec

    def test_same_content_same_hash_meta_ignored(self):
        a = build_row(self.base(), None)
        b = build_row(self.base(review_status="needs_review", search_keyword="다른"), None)
        self.assertEqual(a["content_hash"], b["content_hash"])
        self.assertEqual(len(a["content_hash"]), 32)

    def test_changed_content_changes_hash(self):
        a = build_row(self.base(), None)
        b = build_row(self.base(body_text="본문 수정"), None)
        self.assertNotEqual(a["content_hash"], b["content_hash"])


if __name__ == "__main__":
    unittest.main()

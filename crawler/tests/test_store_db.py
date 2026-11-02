"""store.load_records 의 재수집 동작을 실제 DB 로 확인 (CRAWL_REVIEW_DB_TEST=1 일 때만).

원격 fit.crawled_postings 에 test- 행을 만들고 끝나면 지운다. SUPABASE_DB_URL 은 crawler/.env.
"""
from __future__ import annotations

import os
import time
import unittest
from pathlib import Path

DB_TEST = os.environ.get("CRAWL_REVIEW_DB_TEST") == "1"


@unittest.skipUnless(DB_TEST, "CRAWL_REVIEW_DB_TEST=1 일 때만")
class RecrawlReviewStateTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from dotenv import load_dotenv
        import psycopg

        load_dotenv(Path(__file__).resolve().parents[1] / ".env")
        cls.dsn = os.environ["SUPABASE_DB_URL"]
        cls.tag = f"test-{int(time.time() * 1000)}"
        cls.conn = psycopg.connect(cls.dsn, connect_timeout=20, autocommit=True)

    @classmethod
    def tearDownClass(cls):
        cls.conn.execute("delete from fit.crawled_postings where external_id like %s", (f"{cls.tag}-%",))
        cls.conn.close()

    def rec(self, i: int, title: str = "제목") -> dict:
        return {"external_id": f"{self.tag}-{i}", "url": f"https://example.com/{i}", "company": "회사", "title": title,
                "body_text": "본문 " * 100, "skills": ["Go"]}

    def state(self, i: int):
        return self.conn.execute(
            "select review_status, is_sample, review_flags, edits, load_batch_id from fit.crawled_postings where external_id = %s",
            (f"{self.tag}-{i}",),
        ).fetchone()

    def test_recrawl(self):
        from jdcrawler.platforms import store as ST

        ST.load_records(self.dsn, [self.rec(0), self.rec(1), self.rec(2), self.rec(3)], batch_id="b1")
        # 0: 미판정 샘플 + 수정값, 1: 제외, 2: 미판정 샘플 + 수정값 (내용이 바뀔 행)
        self.conn.execute(
            "update fit.crawled_postings set is_sample = true, review_flags = '{x}', edits = '{\"title\":\"수정\"}' "
            "where external_id in (%s, %s)", (f"{self.tag}-0", f"{self.tag}-2"))
        self.conn.execute("update fit.crawled_postings set review_status = 'rejected', reject_reason = 'ad' where external_id = %s",
                          (f"{self.tag}-1",))
        self.conn.execute("update fit.crawled_postings set review_status = 'approved' where external_id = %s", (f"{self.tag}-3",))

        stats = ST.load_records(self.dsn, [self.rec(0), self.rec(1), self.rec(2, title="바뀐 제목"), self.rec(3, title="바뀐 제목")],
                                batch_id="b2")
        self.assertEqual(stats["skipped_resolved"], 2)  # 제외·승인 행은 그대로

        status, sample, flags, edits, batch = self.state(0)
        self.assertEqual((status, sample, flags, batch), ("ok", False, [], "b2"))
        self.assertEqual(edits, {"title": "수정"})  # 내용 같음 → 수정 유지

        self.assertEqual(self.state(1)[0], "rejected")
        self.assertEqual(self.state(1)[4], "b1")

        self.assertEqual(self.state(2)[3], {})  # 내용 바뀜 → 옛 수정 비움
        self.assertEqual((self.state(3)[0], self.state(3)[4]), ("approved", "b1"))


if __name__ == "__main__":
    unittest.main()

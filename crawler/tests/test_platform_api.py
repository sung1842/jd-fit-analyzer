"""크롤 검수 "수집 실행" 용 /v1/platform 입력 검증 (크롤은 돌리지 않는다)."""
import os
import unittest
from unittest import mock

from fastapi import HTTPException

from jdcrawler import server
from jdcrawler.platforms.board_a import BASE_URL


class PlatformInputTest(unittest.TestCase):
    def url(self, **kw):
        return server._platform_list_url(server.PlatformRequest(**kw))

    def test_source_search_url_only(self):
        ok = BASE_URL + "/zf_user/search?searchword=x"
        self.assertEqual(self.url(list_url=ok), ok)
        for bad in (BASE_URL.replace("https://", "http://") + "/zf_user/search?a", "https://evil.com/zf_user/search", BASE_URL + "/zf_user/jobs/1"):
            with self.assertRaises(HTTPException):
                self.url(list_url=bad)

    def test_keyword_builds_url(self):
        u = self.url(keyword="백엔드")
        self.assertIn("searchword=%EB%B0%B1%EC%97%94%EB%93%9C", u)
        self.assertTrue(u.startswith(BASE_URL + "/zf_user/search"))
        self.assertIsNone(self.url())

    def test_ids_digits_only(self):
        with mock.patch.dict(os.environ, {"CRAWLER_API_KEY": "k"}):
            with self.assertRaises(HTTPException) as cm:
                server.platform(server.PlatformRequest(ids=["123456", "abc"]))
            self.assertEqual(cm.exception.status_code, 400)

    def test_json_name_stays_in_out(self):
        for bad in ("../x.json", "a/../../b.json", "x.csv"):
            with self.assertRaises(HTTPException):
                server._platform_json(bad)


if __name__ == "__main__":
    unittest.main()

"""runner.py / server.require_key 단위 테스트 (stdlib unittest).

실행(파일 직접):  crawler\\.venv\\Scripts\\python crawler\\tests\\test_runner.py
"""
from __future__ import annotations

import os
import sys
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

CRAWLER_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(CRAWLER_ROOT))
os.environ["JDCRAWLER_SKIP_DOTENV"] = "1"  # 테스트가 .env(비밀)를 읽지 않도록 import 전에 설정

from jdcrawler import runner  # noqa: E402

SECRET_ENV = {
    "SUPABASE_DB_URL": "postgresql://u:pw@host:5432/db",
    "CRAWLER_API_KEY": "crawler-key-123",
    "MCP_INTERNAL_KEY": "mcp-key-123",
    "ANTHROPIC_API_KEY": "sk-ant-123",
}


class BuildChildEnvTest(unittest.TestCase):
    def test_never_copies_forbidden_keys(self):
        with mock.patch.dict(os.environ, SECRET_ENV):
            env = runner.build_child_env()
        for name in SECRET_ENV:
            self.assertNotIn(name, env)
        joined = "\n".join(env.values())
        for value in SECRET_ENV.values():
            self.assertNotIn(value, joined)
        self.assertEqual(env["JDCRAWLER_SKIP_DOTENV"], "1")
        self.assertEqual(env["PYTHONUTF8"], "1")
        self.assertEqual(env["PYTHONIOENCODING"], "utf-8")
        self.assertIn("PATH", env)

    def test_only_allowlist_plus_fixed(self):
        with mock.patch.dict(os.environ, {"SOME_RANDOM_VAR": "x", **SECRET_ENV}):
            env = runner.build_child_env()
        allowed = {n.upper() for n in runner._ENV_ALLOW} | {"PYTHONIOENCODING", "PYTHONUTF8", "JDCRAWLER_SKIP_DOTENV"}
        self.assertTrue({k.upper() for k in env} <= allowed, sorted(env))

    def test_playwright_browsers_path_passed(self):
        # 회귀: 컨테이너 자식 프로세스가 chromium 위치를 알아야 함
        with mock.patch.dict(os.environ, {"PLAYWRIGHT_BROWSERS_PATH": "/ms-playwright"}):
            env = runner.build_child_env()
        self.assertEqual(env.get("PLAYWRIGHT_BROWSERS_PATH"), "/ms-playwright")

    def test_extra_merged(self):
        env = runner.build_child_env({"CRAWLER_CONTACT": "a@b.c"})
        self.assertEqual(env["CRAWLER_CONTACT"], "a@b.c")

    def test_extra_forbidden_rejected(self):
        for name in ("SUPABASE_DB_URL", "CRAWLER_API_KEY", "MCP_INTERNAL_KEY", "supabase_db_url"):
            with self.assertRaises(ValueError, msg=name):
                runner.build_child_env({name: "v"})


class RunChildTest(unittest.TestCase):
    def test_timeout_kills_and_returns_sentinel(self):
        started = time.time()
        rc, _out, err = runner.run_child(
            [sys.executable, "-c", "import time; time.sleep(60)"],
            runner.build_child_env(), 2, CRAWLER_ROOT,
        )
        elapsed = time.time() - started
        self.assertGreaterEqual(elapsed, 1.5)
        self.assertLess(elapsed, 6, f"{elapsed:.1f}s")
        self.assertEqual(rc, runner.TIMEOUT_RC)
        self.assertTrue(err.rstrip().endswith("TIMEOUT"))
        self.assertTrue(runner.is_timeout(rc, err))

    def test_normal_run_returns_output(self):
        rc, out, err = runner.run_child(
            [sys.executable, "-c", "import sys; print('한글'); print('e', file=sys.stderr)"],
            runner.build_child_env(), 30, CRAWLER_ROOT,
        )
        self.assertEqual(rc, 0)
        self.assertIn("한글", out)
        self.assertIn("e", err)
        self.assertFalse(runner.is_timeout(rc, err))

    def test_child_does_not_see_secrets(self):
        with mock.patch.dict(os.environ, SECRET_ENV):
            env = runner.build_child_env()
        code = "import os; print(sorted(k for k in os.environ if k.startswith(('SUPABASE','CRAWLER_API','MCP_'))))"
        rc, out, _ = runner.run_child([sys.executable, "-c", code], env, 30, CRAWLER_ROOT)
        self.assertEqual(rc, 0)
        self.assertEqual(out.strip(), "[]")


class LastJsonObjectTest(unittest.TestCase):
    def test_noise_then_json(self):
        out = 'INIT crawl4ai\n[FETCH] done\n{"batch_id": "b1", "fetched": 3}\n'
        self.assertEqual(runner.last_json_object(out), {"batch_id": "b1", "fetched": 3})

    def test_multiple_objects_returns_last_and_nested_stays_whole(self):
        out = '{"a": 1}\nlog\n{"b": {"c": 2}, "d": [1, 2]}\n'
        self.assertEqual(runner.last_json_object(out), {"b": {"c": 2}, "d": [1, 2]})

    def test_invalid_or_empty_returns_none(self):
        self.assertIsNone(runner.last_json_object(""))
        self.assertIsNone(runner.last_json_object("no json here\n[1,2,3]\n"))
        self.assertIsNone(runner.last_json_object('{"truncated": '))

    def test_trailing_garbage_keeps_previous_complete(self):
        out = '{"ok": true}\n{"broken": \n'
        self.assertEqual(runner.last_json_object(out), {"ok": True})


class RequireKeyTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        try:
            from fastapi.testclient import TestClient

            from jdcrawler import server
        except Exception as exc:  # httpx 미설치 등
            raise unittest.SkipTest(f"TestClient 사용 불가: {type(exc).__name__}")
        cls.server = server
        cls.client = TestClient(server.app)

    def _env(self, **kv):
        base = {k: "" for k in ("CRAWLER_API_KEY", "MCP_INTERNAL_KEY")}
        base.update(kv)
        return mock.patch.dict(os.environ, base)

    def test_health_is_open(self):
        with self._env():
            self.assertEqual(self.client.get("/health").status_code, 200)

    def test_unconfigured_key_is_503_even_with_mcp_key(self):
        with self._env(MCP_INTERNAL_KEY="mcp-key"):
            r = self.client.get("/v1/jobs/x", headers={"x-internal-key": "mcp-key"})
        self.assertEqual(r.status_code, 503)

    def test_wrong_or_missing_key_is_401(self):
        with self._env(CRAWLER_API_KEY="right"):
            self.assertEqual(self.client.get("/v1/jobs/x", headers={"x-internal-key": "wrong"}).status_code, 401)
            self.assertEqual(self.client.get("/v1/jobs/x").status_code, 401)
            # 비 ASCII 헤더는 TestClient 가 인코딩 못 하므로 함수 직접 호출 (compare_digest TypeError 방지 확인)
            from fastapi import HTTPException

            with self.assertRaises(HTTPException) as cm:
                self.server.require_key("한글")
            self.assertEqual(cm.exception.status_code, 401)

    def test_right_key_passes_auth(self):
        with self._env(CRAWLER_API_KEY="right"):
            r = self.client.get("/v1/jobs/nope", headers={"x-internal-key": "right"})
        self.assertEqual(r.status_code, 404)  # 인증 통과 → 존재하지 않는 job

    def test_trigger_requires_key_and_validates(self):
        with self._env(CRAWLER_API_KEY="right"):
            h = {"x-internal-key": "right"}
            self.assertEqual(self.client.post("/v1/trigger", json={"source": "site"}).status_code, 401)
            self.assertEqual(self.client.post("/v1/trigger", json={"source": "site"}, headers=h).status_code, 400)
            self.assertEqual(self.client.post("/v1/trigger", json={"source": "site", "max": 501}, headers=h).status_code, 422)
            self.assertEqual(self.client.post("/v1/trigger", json={"source": "site", "timeout_sec": 10}, headers=h).status_code, 422)
            self.assertEqual(self.client.post("/v1/trigger", json={"source": "board_a"}, headers=h).status_code, 422)

    def test_main_fail_closed(self):
        with mock.patch.dict(os.environ, {"CRAWLER_API_KEY": ""}):
            with self.assertRaises(SystemExit) as cm:
                self.server.main()
            self.assertEqual(str(cm.exception), "CRAWLER_API_KEY required")
        with mock.patch.dict(os.environ, {"CRAWLER_API_KEY": "k", "CRAWLER_API_HOST": "0.0.0.0", "CRAWLER_ALLOW_NON_LOOPBACK": ""}):
            with self.assertRaises(SystemExit):
                self.server.main()

    def test_duplicate_enqueue_409_and_error_redacted(self):
        from fastapi import HTTPException

        gate = threading.Event()
        started = threading.Event()

        def blocker():
            started.set()
            gate.wait(10)
            return {}

        first = self.server._enqueue(blocker, dedupe_key=("t", "dup"))
        self.assertTrue(started.wait(5))
        with self.assertRaises(HTTPException) as cm:
            self.server._enqueue(lambda: {}, dedupe_key=("t", "dup"))
        self.assertEqual(cm.exception.status_code, 409)
        gate.set()

        def boom():
            raise RuntimeError("fail postgresql://user:SECRETPW@h:5432/db access-key=ABCDEF")

        job = self.server._enqueue(boom)
        for _ in range(50):
            with self.server._jobs_lock:
                st = self.server._jobs[job["job_id"]]
            if st["status"] in ("failed", "done"):
                break
            time.sleep(0.1)
        res = st["result"]
        self.assertEqual(res["error"], "job failed")
        self.assertEqual(res["error_type"], "RuntimeError")
        self.assertNotIn("SECRETPW", str(res))
        self.assertNotIn("ABCDEF", str(res))
        self.assertIn(first["job_id"], self.server._jobs)


class TriggerJobTest(unittest.TestCase):
    """_trigger_job 의 실패 사유·비밀 가림 (자식·게이트·DB 는 mock)."""

    @classmethod
    def setUpClass(cls):
        try:
            from jdcrawler import server
        except Exception as exc:
            raise unittest.SkipTest(f"server import 불가: {type(exc).__name__}")
        cls.server = server

    def _run(self, rc, out, err, gate=None, load=True, db_url="postgresql://u:pw@h/d"):
        s = self.server
        body = s.TriggerRequest(source="site", load=load)
        patches = [
            mock.patch.object(s, "run_child", return_value=(rc, out, err)),
            mock.patch.object(s, "gate_record"),
            mock.patch.object(s, "gate_evaluate", return_value=gate or {"ok": True, "reason": None, "warnings": ["w"], "stats": {}}),
            mock.patch.dict(os.environ, {"SUPABASE_DB_URL": db_url}),
        ]
        for p in patches:
            p.start()
        try:
            return s._trigger_job("job-1", body, None, None)()
        finally:
            for p in patches:
                p.stop()

    def test_crawl_failed_redacted(self):
        result = self._run(1, "", "boom postgresql://u:TOPSECRET@h/d")
        self.assertEqual(result["reason"], "crawl_failed")
        self.assertNotIn("TOPSECRET", str(result))
        self.assertEqual(result["error"], "crawl_failed")

    def test_timeout_reason(self):
        self.assertEqual(self._run(runner.TIMEOUT_RC, "", "x\nTIMEOUT")["reason"], "timeout")

    def test_gate_failure_skips_load(self):
        with mock.patch("jdcrawler.loader.load_csv") as load:
            result = self._run(0, '{"fetched": 0}\n', "", gate={"ok": False, "reason": "empty", "warnings": [], "stats": {}})
            load.assert_not_called()
        self.assertEqual(result["reason"], "empty")

    def test_no_db_url(self):
        self.assertEqual(self._run(0, '{"fetched": 5}\n', "", db_url="")["reason"], "no_db_url")

    def test_success_without_load(self):
        result = self._run(0, 'noise\n{"fetched": 5}\n', "", load=False)
        self.assertEqual(result["fetched"], 5)
        self.assertNotIn("error", result)

    def test_exception_redacted(self):
        s = self.server
        with mock.patch.object(s, "run_child", side_effect=RuntimeError("x postgresql://u:PWD9@h/d")):
            result = s._trigger_job("job-2", s.TriggerRequest(source="site"), None, None)()
        self.assertEqual(result["reason"], "exception")
        self.assertEqual(result["error_type"], "RuntimeError")
        self.assertNotIn("PWD9", str(result))


if __name__ == "__main__":
    unittest.main(verbosity=2)

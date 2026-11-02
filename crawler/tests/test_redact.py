"""redact.py 단위 테스트 (stdlib unittest)."""
from __future__ import annotations

import os
import unittest
from unittest import mock

from jdcrawler.redact import redact, safe_error


class TestRedact(unittest.TestCase):
    def test_access_key_masked_other_params_kept(self):
        out = redact("GET https://api.example.com/job-search?access-key=ABC123&count=10")
        self.assertNotIn("ABC123", out)
        self.assertIn("access-key=***", out)
        self.assertIn("count=10", out)

    def test_access_key_case_insensitive(self):
        self.assertNotIn("ABC123", redact("Access-Key=ABC123"))

    def test_postgres_password_masked(self):
        uri = "postgresql://postgres.ref:p%40ss@host:5432/postgres"
        out = redact(f"connect failed: {uri}")
        self.assertNotIn("p%40ss", out)
        self.assertIn("postgresql://postgres.ref:***@host:5432/postgres", out)

    def test_postgres_short_scheme(self):
        out = redact("postgres://user:hunter2@db:5432/x")
        self.assertNotIn("hunter2", out)

    def test_bearer_masked(self):
        token = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig-nat_ure"
        out = redact(f"Authorization: Bearer {token}")
        self.assertNotIn("eyJhbGci", out)
        self.assertNotIn("sig-nat_ure", out)
        self.assertIn("Bearer ***", out)

    def test_internal_key_header_masked(self):
        out = redact("x-internal-key: secret")
        self.assertNotIn("secret", out)
        self.assertIn("x-internal-key: ***", out)

    def test_internal_key_json_form_masked(self):
        out = redact('{"x-internal-key": "topsecret", "a": 1}')
        self.assertNotIn("topsecret", out)

    def test_webhook_secret_masked(self):
        self.assertNotIn("whsec", redact("x-webhook-secret=whsec123"))

    def test_plain_text_unchanged(self):
        self.assertEqual(redact("연결 시간 초과 (timeout=30)"), "연결 시간 초과 (timeout=30)")

    def test_limit_truncates(self):
        self.assertEqual(len(redact("a" * 1000)), 300)
        self.assertEqual(len(redact("a" * 1000, limit=50)), 50)

    def test_non_str_input(self):
        self.assertEqual(redact(12345), "12345")
        self.assertEqual(redact(None), "None")

    def test_secret_not_leaked_by_truncation_boundary(self):
        # 마스킹은 자르기 전에 적용되므로 limit 경계에 걸린 비밀도 새지 않는다
        text = "x" * 40 + " access-key=SUPERSECRET&y=1"
        self.assertNotIn("SUPERSECRET", redact(text, limit=60))
        self.assertNotIn("SUPERSEC", redact(text, limit=60))


class TestRedactGaps(unittest.TestCase):
    """이전에 새던 케이스."""

    def test_unencoded_at_in_postgres_password(self):
        out = redact("connect failed: postgresql://postgres.ref:pa@ss!word@host:5432/postgres")
        self.assertNotIn("pa@ss", out)
        self.assertNotIn("ss!word", out)
        self.assertIn("@host:5432/postgres", out)

    def test_bearer_with_base64_chars(self):
        out = redact("Authorization: Bearer abc+def/ghi==tail")
        self.assertNotIn("abc+def", out)
        self.assertNotIn("tail", out)

    def test_password_equals_form(self):
        out = redact("password=hunter2xyz; user=a")
        self.assertNotIn("hunter2xyz", out)

    def test_json_token_form(self):
        out = redact('{"token": "abc123secretvalue", "n": 1}')
        self.assertNotIn("abc123secretvalue", out)

    def test_jwt_shape_without_prefix(self):
        out = redact("got eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sigpart in body")
        self.assertNotIn("eyJhbGci", out)

    def test_provider_key_shapes(self):
        for k in ("sbp_0123456789abcdef0123", "sk-ant-api03-abcdefghijklmnop", "AIzaSyA1234567890abcdefgh"):
            self.assertNotIn(k, redact(f"key was {k} ok"))

    def test_env_value_replaced_even_if_pattern_unknown(self):
        with mock.patch.dict(os.environ, {"CRAWLER_API_KEY": "plain-unpatterned-VALUE-123"}):
            out = redact("upstream said: plain-unpatterned-VALUE-123 rejected")
        self.assertNotIn("plain-unpatterned-VALUE-123", out)

    def test_env_dsn_password_all_forms(self):
        dsn = "postgresql://postgres.ref:p%40ss+w0rd!@host:5432/postgres"
        with mock.patch.dict(os.environ, {"SUPABASE_DB_URL": dsn}):
            for shown in ("p%40ss+w0rd!", "p@ss+w0rd!"):
                out = redact(f"FATAL password authentication failed ({shown})")
                self.assertNotIn(shown, out)

    def test_short_env_value_not_masked(self):
        with mock.patch.dict(os.environ, {"SOME_KEY": "1"}):
            self.assertEqual(redact("count 1 of 10"), "count 1 of 10")

    def test_public_anon_key_not_masked(self):
        with mock.patch.dict(os.environ, {"NEXT_PUBLIC_SUPABASE_ANON_KEY": "sb_publishable_abcdefgh"}):
            self.assertIn("sb_publishable_abcdefgh", redact("anon sb_publishable_abcdefgh"))


class TestSafeError(unittest.TestCase):
    def test_prefix_and_masking(self):
        out = safe_error(ValueError("bad url ...access-key=XYZ"))
        self.assertTrue(out.startswith("ValueError:"), out)
        self.assertNotIn("XYZ", out)

    def test_limit_applies_to_message(self):
        out = safe_error(RuntimeError("b" * 1000), limit=20)
        self.assertEqual(out, "RuntimeError: " + "b" * 20)

    def test_postgres_error_masked(self):
        out = safe_error(OSError("could not connect postgresql://u:pw123@h/db"))
        self.assertTrue(out.startswith("OSError:"))
        self.assertNotIn("pw123", out)


if __name__ == "__main__":
    unittest.main()

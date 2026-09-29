"""Flask smoke endpoint tests. No network and no database."""

import io
import json
import logging
import os
import unittest
import urllib.error
from unittest.mock import patch

import app as app_module
from gapgpt import DEFAULT_BASE_URL, DEFAULT_MODEL, SMOKE_PROMPT, GapGPTClient, GapGPTConfig

KEY = "unit-test-key"


def config():
    return GapGPTConfig(
        api_key=KEY,
        base_url="https://example.test/v1",
        model=DEFAULT_MODEL,
    )


class FakeResponse:
    def __init__(self, body, status=200):
        self._body = body if isinstance(body, bytes) else body.encode("utf-8")
        self.status = status

    def read(self, n=-1):
        data = self._body
        self._body = b""
        if n is None or n < 0:
            return data
        return data[:n]

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


class EndpointTests(unittest.TestCase):
    def setUp(self):
        self.client = app_module.app.test_client()

    def test_health_reports_gapgpt_without_calling_it(self):
        def boom(*args, **kwargs):
            raise AssertionError("health called GapGPT")

        with patch("app.database_ok", return_value=True):
            with patch("gapgpt._make_transport", side_effect=boom):
                with patch.dict(
                    os.environ,
                    {
                        "GAP_CODE_API_KEY": KEY,
                        "GAPGPT_BASE_URL": "https://example.test/v1/",
                        "GAPGPT_MODEL": "custom-model",
                    },
                ):
                    res = self.client.get("/health")
        self.assertEqual(res.status_code, 200)
        body = res.get_json()
        self.assertEqual(body["status"], "ok")
        self.assertEqual(body["database"], "ok")
        self.assertEqual(
            body["gapgpt"],
            {
                "configured": True,
                "base_url": "https://example.test/v1",
                "model": "custom-model",
            },
        )
        self.assertNotIn(KEY, res.get_data(as_text=True))

    def test_health_unconfigured_defaults(self):
        with patch("app.database_ok", return_value=False):
            with patch.dict(
                os.environ,
                {"GAP_CODE_API_KEY": "", "GAPGPT_BASE_URL": "", "GAPGPT_MODEL": ""},
            ):
                res = self.client.get("/health")
        self.assertEqual(res.status_code, 503)
        gapgpt_status = res.get_json()["gapgpt"]
        self.assertFalse(gapgpt_status["configured"])
        self.assertEqual(gapgpt_status["base_url"], DEFAULT_BASE_URL)
        self.assertEqual(gapgpt_status["model"], DEFAULT_MODEL)

    def test_smoke_missing_key(self):
        with patch("app.database_ok", side_effect=AssertionError("db")):
            with patch.dict(os.environ, {"GAP_CODE_API_KEY": ""}):
                res = self.client.post("/gapgpt/smoke", json={"prompt": KEY})
        self.assertEqual(res.status_code, 503)
        body = res.get_json()
        self.assertEqual(body["ok"], False)
        self.assertEqual(body["error"], "not_configured")
        text = res.get_data(as_text=True)
        self.assertTrue(text.startswith('{"ok":false,'))
        self.assertNotIn("Traceback", text)
        self.assertNotIn(KEY, text)

    def test_smoke_success_ignores_caller_body(self):
        seen = {}

        def transport(request, timeout):
            seen["payload"] = json.loads(request.data.decode("utf-8"))
            seen["auth"] = request.get_header("Authorization")
            return FakeResponse(
                json.dumps(
                    {"choices": [{"message": {"content": "pong"}}]}
                )
            )

        client = GapGPTClient(config(), transport=transport)
        with patch("app.build_gapgpt_client", return_value=client):
            res = self.client.post(
                "/gapgpt/smoke",
                json={"messages": [{"role": "user", "content": KEY}]},
            )
        self.assertEqual(res.status_code, 200)
        body = res.get_json()
        self.assertEqual(body["reply"], "pong")
        self.assertEqual(body["model"], DEFAULT_MODEL)
        self.assertEqual(
            seen["payload"]["messages"],
            [{"role": "user", "content": SMOKE_PROMPT}],
        )
        self.assertEqual(seen["auth"], f"Bearer {KEY}")
        self.assertNotIn(KEY, res.get_data(as_text=True))
        self.assertNotIn(KEY.encode(), json.dumps(seen["payload"]).encode())

    def test_smoke_invalid_key(self):
        def transport(request, timeout):
            raise urllib.error.HTTPError(
                "https://example.test/v1/chat/completions",
                401,
                "Unauthorized",
                hdrs=None,
                fp=io.BytesIO(json.dumps({"error": KEY}).encode("utf-8")),
            )

        client = GapGPTClient(config(), transport=transport)
        with patch("app.build_gapgpt_client", return_value=client):
            res = self.client.post("/gapgpt/smoke")
        self.assertEqual(res.status_code, 502)
        body = res.get_json()
        self.assertEqual(body["error"], "unauthorized")
        self.assertEqual(body["upstream_status"], 401)
        text = res.get_data(as_text=True)
        self.assertNotIn(KEY, text)
        self.assertNotIn("Traceback", text)

    def test_smoke_unexpected_error_hides_exception_text(self):
        class Boom(GapGPTClient):
            def smoke(self):
                raise RuntimeError(f"exploded {KEY}")

        records = []

        class ListHandler(logging.Handler):
            def emit(self, record):
                records.append(self.format(record))

        handler = ListHandler()
        app_module.app.logger.addHandler(handler)
        try:
            with patch("app.build_gapgpt_client", return_value=Boom(config(), transport=lambda *a: None)):
                res = self.client.post("/gapgpt/smoke")
        finally:
            app_module.app.logger.removeHandler(handler)
        self.assertEqual(res.status_code, 500)
        body = res.get_json()
        self.assertEqual(body["error"], "internal_error")
        text = res.get_data(as_text=True) + "\n".join(records)
        self.assertNotIn(KEY, text)
        self.assertNotIn("Traceback", res.get_data(as_text=True))
        self.assertTrue(any("RuntimeError" in line for line in records))

    def test_public_body_scrub_removes_key_and_traceback(self):
        leaked = json.dumps(
            {"ok": False, "message": f"rejected {KEY}", "note": "keep"}
        ).encode()
        with patch.dict(os.environ, {"GAP_CODE_API_KEY": KEY}):
            cleaned = app_module.scrub_public_body(leaked)
        self.assertNotIn(KEY.encode(), cleaned)
        self.assertIn(b"[redacted]", cleaned)
        self.assertIn(b"keep", cleaned)

        escaped_key = "quote\"key"
        raw = json.dumps({"message": escaped_key}).encode()
        with patch.dict(os.environ, {"GAP_CODE_API_KEY": escaped_key}):
            cleaned = app_module.scrub_public_body(raw)
        self.assertNotIn(b"quote", cleaned)
        self.assertIn(b"[redacted]", cleaned)

        blown = b'{"ok":false,"message":"Traceback (most recent call last)\\nFile \\"app.py\\""}'
        cleaned = app_module.scrub_public_body(blown)
        self.assertNotIn(b"Traceback", cleaned)
        self.assertNotIn(b"app.py", cleaned)
        self.assertEqual(
            json.loads(cleaned.decode()),
            {"ok": False, "error": "internal_error", "message": "Request failed"},
        )

        short = b'{"message":"invalid"}'
        with patch.dict(os.environ, {"GAP_CODE_API_KEY": "invalid"}):
            self.assertEqual(app_module.scrub_public_body(short), short)

    def test_get_is_not_allowed(self):
        res = self.client.get("/gapgpt/smoke")
        self.assertEqual(res.status_code, 405)
        self.assertEqual(res.get_json()["error"], "method_not_allowed")


if __name__ == "__main__":
    unittest.main()

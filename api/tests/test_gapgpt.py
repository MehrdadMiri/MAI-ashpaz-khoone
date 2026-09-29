"""Unit tests for the shared GapGPT client.

These tests mock HTTP or use a local socket. They do not call api.gapgpt.app.
See the README section "GapGPT checks (SE/QA)" for how to run them.
"""

import io
import json
import os
import subprocess
import sys
import threading
import traceback
import unittest
import urllib.error
from contextlib import redirect_stderr, redirect_stdout
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

import gapgpt
from gapgpt import (
    DEFAULT_BASE_URL,
    DEFAULT_MODEL,
    SMOKE_PROMPT,
    GapGPTClient,
    GapGPTConfig,
    GapGPTError,
)

KEY = "unit-test-key"
API_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = API_DIR.parent

CHAT_OK = {
    "id": "chatcmpl-test",
    "choices": [{"message": {"role": "assistant", "content": "pong"}}],
}


def make_config(**overrides):
    data = {
        "api_key": KEY,
        "base_url": "https://example.test/v1",
        "model": DEFAULT_MODEL,
    }
    data.update(overrides)
    return GapGPTConfig(**data)


class FakeResponse:
    def __init__(self, body, status=200):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self._body = bytes(body)
        self.status = status

    def read(self, n=-1):
        if n is None or n < 0 or n >= len(self._body):
            data = self._body
            self._body = b""
            return data
        data = self._body[:n]
        self._body = self._body[n:]
        return data

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


class Recorder:
    def __init__(self, body=None, status=200, error=None):
        self.body = CHAT_OK if body is None else body
        self.status = status
        self.error = error
        self.requests = []
        self.timeouts = []

    def __call__(self, request, timeout):
        self.requests.append(request)
        self.timeouts.append(timeout)
        if self.error is not None:
            raise self.error
        raw = self.body
        if isinstance(raw, (dict, list)):
            raw = json.dumps(raw)
        return FakeResponse(raw, self.status)


def http_error(status, body=b"", message="error"):
    if isinstance(body, str):
        body = body.encode("utf-8")
    return urllib.error.HTTPError(
        "https://example.test/v1/chat/completions",
        status,
        message,
        hdrs=None,
        fp=io.BytesIO(body),
    )


class ConfigTests(unittest.TestCase):
    def test_defaults_when_unset(self):
        env = {}
        config = GapGPTConfig.from_env(env)
        self.assertFalse(config.configured)
        self.assertEqual(config.base_url, DEFAULT_BASE_URL)
        self.assertEqual(config.model, DEFAULT_MODEL)
        self.assertEqual(
            config.public_status(),
            {
                "configured": False,
                "base_url": DEFAULT_BASE_URL,
                "model": DEFAULT_MODEL,
            },
        )

    def test_blank_values_use_defaults(self):
        config = GapGPTConfig.from_env(
            {
                "GAP_CODE_API_KEY": "   ",
                "GAPGPT_BASE_URL": "  ",
                "GAPGPT_MODEL": "",
            }
        )
        self.assertFalse(config.configured)
        self.assertEqual(config.base_url, DEFAULT_BASE_URL)
        self.assertEqual(config.model, DEFAULT_MODEL)

    def test_env_overrides_and_strips_trailing_slash(self):
        config = GapGPTConfig.from_env(
            {
                "GAP_CODE_API_KEY": "  unit-test-key  ",
                "GAPGPT_BASE_URL": "https://example.test/v1/",
                "GAPGPT_MODEL": " custom-model ",
            }
        )
        self.assertTrue(config.configured)
        self.assertEqual(config.api_key, KEY)
        self.assertEqual(config.base_url, "https://example.test/v1")
        self.assertEqual(config.model, "custom-model")

    def test_repr_and_status_hide_key(self):
        config = make_config()
        text = " ".join(
            [
                repr(config),
                str(config),
                repr(GapGPTClient(config, transport=Recorder())),
                json.dumps(config.public_status()),
            ]
        )
        self.assertNotIn(KEY, text)
        self.assertIn("configured=True", repr(config))

    def test_status_redacts_key_embedded_in_url_or_model(self):
        config = make_config(
            base_url="https://example.test/unit-test-key/v1",
            model="model-unit-test-key",
        )
        text = json.dumps(config.public_status()) + repr(config)
        self.assertNotIn(KEY, text)
        self.assertIn("[redacted]", text)

    def test_status_strips_userinfo(self):
        config = make_config(base_url="https://alice:s3cret@example.test/v1")
        status = config.public_status()
        text = json.dumps(status)
        self.assertNotIn("s3cret", text)
        self.assertNotIn("alice", text)
        self.assertEqual(status["base_url"], "https://example.test/v1")


class ClientTests(unittest.TestCase):
    def test_missing_key_does_not_call_transport(self):
        recorder = Recorder()
        client = GapGPTClient(
            make_config(api_key=""),
            transport=recorder,
        )
        with self.assertRaises(GapGPTError) as caught:
            client.chat([{"role": "user", "content": "hi"}])
        self.assertEqual(caught.exception.code, "not_configured")
        self.assertEqual(caught.exception.http_status, 503)
        self.assertEqual(recorder.requests, [])
        self.assertNotIn("Traceback", json.dumps(caught.exception.to_dict()))

    def test_successful_chat_completions(self):
        recorder = Recorder()
        client = GapGPTClient(make_config(), timeout=12, transport=recorder)
        body = client.chat(
            [{"role": "user", "content": "سلام"}],
            temperature=0,
        )
        self.assertEqual(client.chat_text(
            [{"role": "user", "content": "سلام"}],
        ), "pong")
        request = recorder.requests[0]
        self.assertEqual(recorder.timeouts[0], 12)
        self.assertEqual(
            request.full_url, "https://example.test/v1/chat/completions"
        )
        self.assertEqual(request.get_method(), "POST")
        self.assertEqual(request.get_header("Authorization"), f"Bearer {KEY}")
        payload = json.loads(request.data.decode("utf-8"))
        self.assertEqual(payload["model"], DEFAULT_MODEL)
        self.assertEqual(payload["messages"][0]["content"], "سلام")
        self.assertEqual(payload["temperature"], 0)
        self.assertNotIn(KEY.encode(), request.data)
        self.assertNotIn(KEY, json.dumps(body))

    def test_vision_parts_are_forwarded(self):
        recorder = Recorder()
        client = GapGPTClient(make_config(), transport=recorder)
        parts = [
            {"type": "text", "text": "what is in the fridge?"},
            {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,YQ=="}},
        ]
        client.chat([{"role": "user", "content": parts}])
        payload = json.loads(recorder.requests[0].data.decode("utf-8"))
        self.assertEqual(payload["messages"][0]["content"], parts)

    def test_chat_with_image_posts_data_url(self):
        recorder = Recorder()
        client = GapGPTClient(make_config(), transport=recorder)
        image = b"\xff\xd8\xff\xd9"
        text = client.chat_with_image(
            "مواد یخچال؟",
            image,
            "image/jpeg",
            system="list foods",
        )
        self.assertEqual(text, "pong")
        payload = json.loads(recorder.requests[0].data.decode("utf-8"))
        self.assertEqual(payload["model"], DEFAULT_MODEL)
        self.assertEqual(payload["messages"][0], {"role": "system", "content": "list foods"})
        parts = payload["messages"][1]["content"]
        self.assertEqual(parts[0], {"type": "text", "text": "مواد یخچال؟"})
        url = parts[1]["image_url"]["url"]
        self.assertTrue(url.startswith("data:image/jpeg;base64,"))
        self.assertNotIn(KEY, json.dumps(payload))
        self.assertEqual(recorder.requests[0].get_header("Authorization"), f"Bearer {KEY}")

    def test_chat_with_image_rejects_bad_type_and_size_without_calling(self):
        recorder = Recorder()
        client = GapGPTClient(make_config(), transport=recorder)
        with self.assertRaises(GapGPTError) as caught:
            client.chat_with_image("مواد؟", b"\xff\xd8\xff\xd9", "image/svg+xml")
        self.assertEqual(caught.exception.code, "invalid_request")
        self.assertEqual(caught.exception.http_status, 400)
        huge = b"\xff\xd8\xff" + b"x" * gapgpt.MAX_IMAGE_BYTES
        with self.assertRaises(GapGPTError) as caught:
            client.chat_with_image("مواد؟", huge, "image/jpeg")
        self.assertEqual(caught.exception.http_status, 413)
        self.assertNotIn(KEY, str(caught.exception))
        self.assertEqual(recorder.requests, [])

    def test_chat_with_images_keeps_order_and_rejects_too_many(self):
        recorder = Recorder()
        client = GapGPTClient(make_config(), transport=recorder)
        jpeg = b"\xff\xd8\xff\xd9"
        png = b"\x89PNG\r\n\x1a\n" + b"\x00" * 4
        text = client.chat_with_images(
            "مواد یخچال؟",
            [(jpeg, "image/jpeg"), (png, "image/png")],
            system="list foods",
        )
        self.assertEqual(text, "pong")
        payload = json.loads(recorder.requests[0].data.decode("utf-8"))
        parts = payload["messages"][1]["content"]
        self.assertEqual(parts[0]["text"], "مواد یخچال؟")
        self.assertTrue(parts[1]["image_url"]["url"].startswith("data:image/jpeg;base64,"))
        self.assertTrue(parts[2]["image_url"]["url"].startswith("data:image/png;base64,"))
        self.assertNotIn(KEY, json.dumps(payload))
        self.assertEqual(len(recorder.requests), 1)

        with self.assertRaises(GapGPTError) as caught:
            client.chat_with_images(
                "مواد؟",
                [(jpeg, "image/jpeg")] * (gapgpt.MAX_FRIDGE_IMAGES + 1),
            )
        self.assertEqual(caught.exception.code, "invalid_request")
        self.assertEqual(caught.exception.http_status, 400)
        self.assertNotIn(KEY, str(caught.exception))
        self.assertEqual(len(recorder.requests), 1)

    def test_list_content_response(self):
        recorder = Recorder(
            body={
                "choices": [
                    {
                        "message": {
                            "content": [
                                {"type": "text", "text": "hello"},
                                {"type": "text", "text": " world"},
                            ]
                        }
                    }
                ]
            }
        )
        client = GapGPTClient(make_config(), transport=recorder)
        self.assertEqual(
            client.chat_text([{"role": "user", "content": "hi"}]),
            "hello world",
        )

    def test_echoed_key_is_removed_from_result(self):
        recorder = Recorder(
            body={
                "choices": [
                    {"message": {"content": "leaked unit-test-key here"}}
                ]
            }
        )
        client = GapGPTClient(make_config(), transport=recorder)
        text = client.chat_text([{"role": "user", "content": "hi"}])
        self.assertNotIn(KEY, text)
        self.assertIn("[redacted]", text)

    def test_unauthorized_hides_body_and_traceback(self):
        secret_body = json.dumps({"error": {"message": f"bad {KEY}"}})
        recorder = Recorder(error=http_error(401, secret_body, f"nope {KEY}"))
        client = GapGPTClient(make_config(), transport=recorder)
        with self.assertRaises(GapGPTError) as caught:
            client.chat([{"role": "user", "content": "hi"}])
        err = caught.exception
        self.assertEqual(err.code, "unauthorized")
        self.assertEqual(err.http_status, 502)
        self.assertEqual(err.upstream_status, 401)
        self.assertIsNone(err.__cause__)
        self.assertTrue(err.__suppress_context__)
        rendered = json.dumps(err.to_dict()) + str(err)
        rendered += "".join(traceback.format_exception(err))
        self.assertNotIn(KEY, rendered)
        self.assertNotIn("Traceback", json.dumps(err.to_dict()))

    def test_forbidden_is_unauthorized(self):
        recorder = Recorder(error=http_error(403, b"{}"))
        client = GapGPTClient(make_config(), transport=recorder)
        with self.assertRaises(GapGPTError) as caught:
            client.chat([{"role": "user", "content": "hi"}])
        self.assertEqual(caught.exception.code, "unauthorized")
        self.assertEqual(caught.exception.upstream_status, 403)

    def test_other_http_error_is_upstream_error(self):
        recorder = Recorder(error=http_error(500, b'{"error":"boom"}'))
        client = GapGPTClient(make_config(), transport=recorder)
        with self.assertRaises(GapGPTError) as caught:
            client.chat([{"role": "user", "content": "hi"}])
        self.assertEqual(caught.exception.code, "upstream_error")
        self.assertEqual(caught.exception.upstream_status, 500)
        self.assertNotIn("boom", str(caught.exception))

    def test_non_json_response(self):
        recorder = Recorder(body=b"<html>nope</html>")
        client = GapGPTClient(make_config(), transport=recorder)
        with self.assertRaises(GapGPTError) as caught:
            client.chat([{"role": "user", "content": "hi"}])
        self.assertEqual(caught.exception.code, "bad_response")
        self.assertNotIn("html", str(caught.exception))

    def test_response_too_large(self):
        recorder = Recorder(body=b'{"choices":[]}' + b"x" * gapgpt.MAX_RESPONSE_BYTES)
        client = GapGPTClient(make_config(), transport=recorder)
        with self.assertRaises(GapGPTError) as caught:
            client.chat([{"role": "user", "content": "hi"}])
        self.assertEqual(caught.exception.code, "bad_response")
        self.assertIn("too large", caught.exception.message)

    def test_missing_message(self):
        recorder = Recorder(body={"choices": []})
        client = GapGPTClient(make_config(), transport=recorder)
        with self.assertRaises(GapGPTError) as caught:
            client.chat_text([{"role": "user", "content": "hi"}])
        self.assertEqual(caught.exception.code, "bad_response")

    def test_upstream_error_object(self):
        recorder = Recorder(body={"error": {"message": KEY}})
        client = GapGPTClient(make_config(), transport=recorder)
        with self.assertRaises(GapGPTError) as caught:
            client.chat([{"role": "user", "content": "hi"}])
        self.assertEqual(caught.exception.code, "upstream_error")
        self.assertNotIn(KEY, str(caught.exception))

    def test_stream_and_credentials_are_rejected(self):
        recorder = Recorder()
        client = GapGPTClient(make_config(), transport=recorder)
        with self.assertRaises(GapGPTError) as caught:
            client.chat([{"role": "user", "content": "hi"}], stream=True)
        self.assertEqual(caught.exception.code, "invalid_request")
        with self.assertRaises(GapGPTError) as caught:
            client.chat([{"role": "user", "content": "hi"}], api_key=KEY)
        self.assertIn("credentials", caught.exception.message)
        self.assertEqual(recorder.requests, [])

    def test_message_containing_key_is_not_sent(self):
        recorder = Recorder()
        client = GapGPTClient(make_config(), transport=recorder)
        with self.assertRaises(GapGPTError) as caught:
            client.chat([{"role": "user", "content": f"please use {KEY}"}])
        self.assertEqual(caught.exception.code, "invalid_request")
        self.assertNotIn(KEY, str(caught.exception))
        self.assertEqual(recorder.requests, [])

    def test_key_with_newline_is_rejected(self):
        recorder = Recorder()
        client = GapGPTClient(
            make_config(api_key="unit-test-key\r\nX-Injected: 1"),
            transport=recorder,
        )
        with self.assertRaises(GapGPTError) as caught:
            client.chat([{"role": "user", "content": "hi"}])
        self.assertEqual(caught.exception.code, "invalid_config")
        self.assertNotIn("X-Injected", str(caught.exception))
        self.assertEqual(recorder.requests, [])

    def test_non_latin1_key_is_rejected_without_traceback_leak(self):
        secret = "unit-test-key-\u2603"
        recorder = Recorder()
        client = GapGPTClient(make_config(api_key=secret), transport=recorder)
        with self.assertRaises(GapGPTError) as caught:
            client.chat([{"role": "user", "content": "hi"}])
        rendered = "".join(traceback.format_exception(caught.exception))
        self.assertEqual(caught.exception.code, "invalid_config")
        self.assertNotIn(secret, rendered)
        self.assertNotIn(secret, str(caught.exception))
        self.assertEqual(recorder.requests, [])

    def test_key_inside_base_url_is_rejected(self):
        recorder = Recorder()
        client = GapGPTClient(
            make_config(base_url=f"https://example.test/{KEY}"),
            transport=recorder,
        )
        with self.assertRaises(GapGPTError) as caught:
            client.chat([{"role": "user", "content": "hi"}])
        self.assertEqual(caught.exception.code, "invalid_config")
        self.assertNotIn(KEY, str(caught.exception))
        self.assertEqual(recorder.requests, [])

    def test_userinfo_and_bad_scheme_are_rejected(self):
        recorder = Recorder()
        client = GapGPTClient(
            make_config(base_url="https://alice:s3cret@example.test/v1"),
            transport=recorder,
        )
        with self.assertRaises(GapGPTError) as caught:
            client.chat([{"role": "user", "content": "hi"}])
        self.assertEqual(caught.exception.code, "invalid_config")
        self.assertNotIn("s3cret", str(caught.exception))
        client = GapGPTClient(
            make_config(base_url="file:///tmp/gapgpt"),
            transport=recorder,
        )
        with self.assertRaises(GapGPTError) as caught:
            client.chat([{"role": "user", "content": "hi"}])
        self.assertIn("http(s)", caught.exception.message)
        self.assertEqual(recorder.requests, [])

    def test_timeout_and_unreachable_hide_reason(self):
        client = GapGPTClient(
            make_config(),
            transport=Recorder(error=urllib.error.URLError(TimeoutError(KEY))),
        )
        with self.assertRaises(GapGPTError) as caught:
            client.chat([{"role": "user", "content": "hi"}])
        self.assertEqual(caught.exception.code, "timeout")
        self.assertEqual(caught.exception.http_status, 504)
        self.assertNotIn(KEY, str(caught.exception))

        client = GapGPTClient(
            make_config(),
            transport=Recorder(error=urllib.error.URLError(KEY)),
        )
        with self.assertRaises(GapGPTError) as caught:
            client.chat([{"role": "user", "content": "hi"}])
        self.assertEqual(caught.exception.code, "upstream_unavailable")
        self.assertNotIn(KEY, str(caught.exception))

    def test_empty_messages_rejected(self):
        client = GapGPTClient(make_config(), transport=Recorder())
        with self.assertRaises(GapGPTError) as caught:
            client.chat([])
        self.assertEqual(caught.exception.http_status, 400)

    def test_smoke_uses_fixed_prompt(self):
        recorder = Recorder()
        client = GapGPTClient(make_config(), transport=recorder)
        result = client.smoke()
        self.assertEqual(result["ok"], True)
        self.assertEqual(result["reply"], "pong")
        self.assertEqual(result["model"], DEFAULT_MODEL)
        payload = json.loads(recorder.requests[0].data.decode("utf-8"))
        self.assertEqual(payload["messages"], [{"role": "user", "content": SMOKE_PROMPT}])
        self.assertNotIn(KEY, json.dumps(result))

    def test_redirect_handler_refuses(self):
        handler = gapgpt._NoRedirect()
        with self.assertRaises(urllib.error.HTTPError):
            handler.redirect_request(
                urllib.request.Request("https://example.test/v1/chat/completions"),
                None,
                302,
                "Found",
                {},
                "https://evil.example/steal",
            )


class _Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        return

    def do_GET(self):
        self._handle()

    def do_POST(self):
        self._handle()

    def _handle(self):
        length = int(self.headers.get("Content-Length", "0") or "0")
        body = self.rfile.read(length) if length else b""
        self.server.hits.append(
            {
                "path": self.path,
                "auth": self.headers.get("Authorization"),
                "body": body,
            }
        )
        mode = self.server.mode
        try:
            if mode == "redirect":
                self.send_response(302)
                self.send_header("Location", "/steal")
                self.end_headers()
                return
            if mode == "unauthorized":
                payload = json.dumps({"error": KEY}).encode("utf-8")
                self.send_response(401)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
                return
            if mode == "timeout":
                import time

                time.sleep(5)
            payload = json.dumps(CHAT_OK).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        except Exception:
            return


def serve(mode):
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    httpd.mode = mode
    httpd.hits = []
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    return httpd


class LocalServerTests(unittest.TestCase):
    def setUp(self):
        self.httpd = None

    def tearDown(self):
        if self.httpd is not None:
            self.httpd.shutdown()
            self.httpd.server_close()

    def _client(self, mode, timeout=5):
        self.httpd = serve(mode)
        port = self.httpd.server_address[1]
        return GapGPTClient(
            make_config(base_url=f"http://127.0.0.1:{port}/v1"),
            timeout=timeout,
        )

    def test_real_http_chat_completions(self):
        client = self._client("ok")
        text = client.chat_text([{"role": "user", "content": "hi"}])
        self.assertEqual(text, "pong")
        hit = self.httpd.hits[0]
        self.assertEqual(hit["path"], "/v1/chat/completions")
        self.assertEqual(hit["auth"], f"Bearer {KEY}")
        self.assertNotIn(KEY.encode(), hit["body"])

    def test_real_http_invalid_key(self):
        client = self._client("unauthorized")
        with self.assertRaises(GapGPTError) as caught:
            client.smoke()
        err = caught.exception
        rendered = json.dumps(err.to_dict()) + "".join(traceback.format_exception(err))
        self.assertEqual(err.code, "unauthorized")
        self.assertEqual(err.upstream_status, 401)
        self.assertNotIn(KEY, rendered)

    def test_socket_timeout_is_controlled(self):
        client = self._client("timeout", timeout=0.5)
        with self.assertRaises(GapGPTError) as caught:
            client.chat([{"role": "user", "content": "hi"}])
        self.assertEqual(caught.exception.code, "timeout")
        self.assertEqual(caught.exception.http_status, 504)
        self.assertNotIn(KEY, str(caught.exception))
        self.assertNotIn("Traceback", json.dumps(caught.exception.to_dict()))

    def test_redirect_is_not_followed(self):
        client = self._client("redirect")
        with self.assertRaises(GapGPTError) as caught:
            client.chat([{"role": "user", "content": "hi"}])
        self.assertEqual(caught.exception.code, "upstream_error")
        self.assertEqual(caught.exception.upstream_status, 302)
        self.assertEqual([hit["path"] for hit in self.httpd.hits], ["/v1/chat/completions"])
        self.assertNotIn(KEY, str(caught.exception))

    def test_debuglevel_does_not_print_key(self):
        import http.client

        old_http = http.client.HTTPConnection.debuglevel
        old_https = http.client.HTTPSConnection.debuglevel
        http.client.HTTPConnection.debuglevel = 1
        http.client.HTTPSConnection.debuglevel = 1
        stdout = io.StringIO()
        stderr = io.StringIO()
        try:
            client = self._client("ok")
            with redirect_stdout(stdout), redirect_stderr(stderr):
                client.chat_text([{"role": "user", "content": "hi"}])
        finally:
            http.client.HTTPConnection.debuglevel = old_http
            http.client.HTTPSConnection.debuglevel = old_https
        self.assertNotIn(KEY, stdout.getvalue())
        self.assertNotIn(KEY, stderr.getvalue())

    def test_cli_smoke_against_local_server(self):
        self.httpd = serve("ok")
        port = self.httpd.server_address[1]
        env = os.environ.copy()
        env["GAP_CODE_API_KEY"] = KEY
        env["GAPGPT_BASE_URL"] = f"http://127.0.0.1:{port}/v1"
        env["GAPGPT_MODEL"] = DEFAULT_MODEL
        proc = subprocess.run(
            [sys.executable, "gapgpt.py", "smoke"],
            cwd=API_DIR,
            env=env,
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
        self.assertNotIn(KEY, proc.stdout)
        self.assertNotIn(KEY, proc.stderr)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertEqual(json.loads(proc.stdout)["reply"], "pong")


class CliTests(unittest.TestCase):
    def test_status_hides_key(self):
        buf = io.StringIO()
        with patch.dict(os.environ, {"GAP_CODE_API_KEY": KEY, "GAPGPT_MODEL": "custom"}):
            with redirect_stdout(buf):
                code = gapgpt.main(["status"])
        self.assertEqual(code, 0)
        self.assertNotIn(KEY, buf.getvalue())
        body = json.loads(buf.getvalue())
        self.assertTrue(body["configured"])
        self.assertEqual(body["model"], "custom")

    def test_smoke_missing_key(self):
        buf = io.StringIO()
        with patch.dict(os.environ, {"GAP_CODE_API_KEY": ""}):
            with redirect_stdout(buf):
                code = gapgpt.main(["smoke"])
        self.assertEqual(code, 1)
        body = json.loads(buf.getvalue())
        self.assertEqual(body["error"], "not_configured")
        self.assertNotIn("Traceback", buf.getvalue())

    def test_smoke_unexpected_error_is_controlled(self):
        buf = io.StringIO()

        def boom(self):
            raise RuntimeError(KEY)

        with patch.object(GapGPTClient, "smoke", boom):
            with redirect_stdout(buf), redirect_stderr(io.StringIO()):
                code = gapgpt.main(["smoke"])
        self.assertEqual(code, 1)
        self.assertNotIn(KEY, buf.getvalue())
        self.assertEqual(json.loads(buf.getvalue())["error"], "internal_error")
        self.assertNotIn("Traceback", buf.getvalue())


class SourceTests(unittest.TestCase):
    def test_repo_has_no_hardcoded_key(self):
        import re

        skip = {".git", ".venv", "venv", "__pycache__", "tests"}
        pattern = re.compile(r"(sk-[A-Za-z0-9]{8,}|Bearer [A-Za-z0-9_\-]{12,})")
        for path in REPO_ROOT.rglob("*"):
            if not path.is_file():
                continue
            if any(part in skip for part in path.parts):
                continue
            if path.name.endswith(".test.js"):
                continue
            if path.suffix not in {".py", ".md", ".yml", ".yaml", ".example", ".txt", ".html", ".conf", ".js", ".css"} and path.name not in {
                ".env.example",
                ".gitignore",
                "Dockerfile",
            }:
                continue
            text = path.read_text(encoding="utf-8")
            self.assertIsNone(pattern.search(text), path)
            self.assertNotIn(KEY, text, path)

    def test_env_example_placeholder_is_empty(self):
        lines = (REPO_ROOT / ".env.example").read_text(encoding="utf-8").splitlines()
        matches = [line for line in lines if line.startswith("GAP_CODE_API_KEY=")]
        self.assertEqual(matches, ["GAP_CODE_API_KEY="])
        gitignore = (REPO_ROOT / ".gitignore").read_text(encoding="utf-8")
        self.assertIn(".env", gitignore)
        self.assertIn("!.env.example", gitignore)


class LiveSmokeTest(unittest.TestCase):
    def test_live_chat_completions(self):
        if os.environ.get("GAPGPT_LIVE_SMOKE") != "1":
            self.skipTest(
                "set GAPGPT_LIVE_SMOKE=1 and GAP_CODE_API_KEY to call GapGPT"
            )
        client = GapGPTClient()
        if not client.config.configured:
            self.fail("GAPGPT_LIVE_SMOKE=1 but GAP_CODE_API_KEY is not set")
        result = client.smoke()
        rendered = json.dumps(result)
        self.assertNotIn(client.config.api_key, rendered)
        self.assertTrue(result["ok"])
        self.assertTrue(result["reply"])
        self.assertEqual(result["base_url"], client.config.public_status()["base_url"])


if __name__ == "__main__":
    unittest.main()

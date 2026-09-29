"""Flask tests for POST /vision/fridge. No network and no database."""

import base64
import io
import json
import logging
import unittest
import urllib.error
from unittest.mock import patch

import app as app_module
from gapgpt import DEFAULT_MODEL, GapGPTClient, GapGPTConfig
from vision import USER_PROMPT, VISION_CLIENT_TIMEOUT

KEY = "unit-test-key"
JPEG = b"\xff\xd8\xff\xd9"
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 16


def config(**overrides):
    data = {
        "api_key": KEY,
        "base_url": "https://example.test/v1",
        "model": DEFAULT_MODEL,
    }
    data.update(overrides)
    return GapGPTConfig(**data)


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


def chat_response(content):
    return FakeResponse(
        json.dumps(
            {"choices": [{"message": {"role": "assistant", "content": content}}]},
            ensure_ascii=False,
        )
    )


class EndpointTests(unittest.TestCase):
    def setUp(self):
        self.client = app_module.app.test_client()

    def _client(self, transport, **config_overrides):
        return GapGPTClient(config(**config_overrides), transport=transport)

    def _post_file(self, gap_client, raw=JPEG, name="fridge.jpg", mime="image/jpeg", path="/vision/fridge"):
        with patch("app.build_gapgpt_client", return_value=gap_client) as builder:
            response = self.client.post(
                path,
                data={"image": (io.BytesIO(raw), name, mime)},
            )
        return response, builder

    def test_get_is_not_allowed(self):
        res = self.client.get("/vision/fridge")
        self.assertEqual(res.status_code, 405)
        self.assertEqual(res.get_json()["error"], "method_not_allowed")

    def test_missing_image_does_not_call_upstream(self):
        seen = []

        def transport(request, timeout):
            del request, timeout
            seen.append(True)
            raise AssertionError("upstream was called")

        gap_client = self._client(transport)
        with patch("app.build_gapgpt_client", return_value=gap_client):
            res = self.client.post("/vision/fridge", data=b"", content_type="application/octet-stream")
        self.assertEqual(res.status_code, 400)
        self.assertEqual(res.get_json()["error"], "invalid_image")
        self.assertEqual(seen, [])
        self.assertNotIn(KEY, res.get_data(as_text=True))

    def test_html_upload_is_rejected(self):
        secret = b"<html>" + KEY.encode() + b"</html>"
        gap_client = self._client(lambda *args: (_ for _ in ()).throw(AssertionError("called")))
        res, _builder = self._post_file(gap_client, raw=secret, name="x.html", mime="text/html")
        self.assertEqual(res.status_code, 400)
        self.assertEqual(res.get_json()["error"], "invalid_image")
        text = res.get_data(as_text=True)
        self.assertNotIn(KEY, text)
        self.assertNotIn("<html>", text)
        self.assertNotIn("Traceback", text)

    def test_missing_key_does_not_call_upstream(self):
        seen = []

        def transport(request, timeout):
            del request, timeout
            seen.append(True)

        gap_client = self._client(transport, api_key="")
        res, _builder = self._post_file(gap_client)
        self.assertEqual(res.status_code, 503)
        self.assertEqual(res.get_json()["error"], "not_configured")
        self.assertEqual(seen, [])
        self.assertNotIn("Traceback", res.get_data(as_text=True))

    def test_success_returns_candidates_and_hides_image(self):
        seen = {}

        def transport(request, timeout):
            seen["payload"] = json.loads(request.data.decode("utf-8"))
            seen["auth"] = request.get_header("Authorization")
            seen["timeout"] = timeout
            return chat_response(
                json.dumps(
                    {"ingredients": ["شیر", "شیر", "تخم‌مرغ"]},
                    ensure_ascii=False,
                )
            )

        gap_client = GapGPTClient(
            config(),
            timeout=VISION_CLIENT_TIMEOUT,
            transport=transport,
        )
        res, builder = self._post_file(gap_client)
        self.assertEqual(res.status_code, 200, res.get_data(as_text=True))
        body = res.get_json()
        self.assertEqual(body, {"ok": True, "ingredients": ["شیر", "تخم‌مرغ"]})
        text = res.get_data(as_text=True)
        encoded = base64.b64encode(JPEG).decode("ascii")
        self.assertNotIn(encoded, text)
        self.assertNotIn("data:image", text)
        self.assertNotIn(KEY, text)
        self.assertEqual(seen["payload"]["model"], DEFAULT_MODEL)
        self.assertEqual(seen["auth"], f"Bearer {KEY}")
        self.assertEqual(seen["timeout"], VISION_CLIENT_TIMEOUT)
        parts = seen["payload"]["messages"][1]["content"]
        self.assertEqual(parts[0]["text"], USER_PROMPT)
        self.assertTrue(parts[1]["image_url"]["url"].startswith("data:image/jpeg;base64,"))
        self.assertNotIn(KEY.encode(), json.dumps(seen["payload"]).encode())
        self.assertEqual(builder.call_args.kwargs["timeout"], VISION_CLIENT_TIMEOUT)

        prefixed, _builder = self._post_file(gap_client, path="/api/vision/fridge")
        self.assertEqual(prefixed.status_code, 200, prefixed.get_data(as_text=True))
        self.assertEqual(prefixed.get_json()["ingredients"], ["شیر", "تخم‌مرغ"])

    def test_png_magic_wins_over_declared_type(self):
        seen = {}

        def transport(request, timeout):
            del timeout
            seen["payload"] = json.loads(request.data.decode("utf-8"))
            return chat_response('{"ingredients":["ماست"]}')

        gap_client = self._client(transport)
        res, _builder = self._post_file(
            gap_client,
            raw=PNG,
            name="photo.txt",
            mime="text/plain",
        )
        self.assertEqual(res.status_code, 200, res.get_data(as_text=True))
        url = seen["payload"]["messages"][1]["content"][1]["image_url"]["url"]
        self.assertTrue(url.startswith("data:image/png;base64,"))

    def test_json_base64_body(self):
        def transport(request, timeout):
            del request, timeout
            return chat_response('{"ingredients":["پیاز"]}')

        gap_client = self._client(transport)
        payload = {
            "mime": "text/plain",
            "image_base64": base64.b64encode(JPEG).decode("ascii"),
        }
        with patch("app.build_gapgpt_client", return_value=gap_client):
            res = self.client.post("/vision/fridge", json=payload)
        self.assertEqual(res.status_code, 200, res.get_data(as_text=True))
        self.assertEqual(res.get_json()["ingredients"], ["پیاز"])
        self.assertNotIn(KEY, res.get_data(as_text=True))

    def test_larger_multipart_file_is_accepted(self):
        raw = b"\xff\xd8\xff" + (b"\x00" * (120 * 1024))

        def transport(request, timeout):
            del request, timeout
            return chat_response('{"ingredients":["دوغ"]}')

        gap_client = self._client(transport)
        res, _builder = self._post_file(gap_client, raw=raw)
        self.assertEqual(res.status_code, 200, res.get_data(as_text=True))
        self.assertEqual(res.get_json()["ingredients"], ["دوغ"])

    def test_empty_model_list(self):
        def transport(request, timeout):
            del request, timeout
            return chat_response('{"ingredients":[]}')

        gap_client = self._client(transport)
        res, _builder = self._post_file(gap_client)
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.get_json(), {"ok": True, "ingredients": []})

    def test_bad_model_text_is_not_echoed(self):
        def transport(request, timeout):
            del request, timeout
            return chat_response(f"not json {KEY}")

        gap_client = self._client(transport)
        res, _builder = self._post_file(gap_client)
        self.assertEqual(res.status_code, 502)
        self.assertEqual(res.get_json()["error"], "bad_response")
        text = res.get_data(as_text=True)
        self.assertNotIn(KEY, text)
        self.assertNotIn("not json", text)
        self.assertNotIn("Traceback", text)

    def test_unauthorized_hides_key(self):
        def transport(request, timeout):
            del request, timeout
            raise urllib.error.HTTPError(
                "https://example.test/v1/chat/completions",
                401,
                "Unauthorized",
                hdrs=None,
                fp=io.BytesIO(json.dumps({"error": KEY}).encode("utf-8")),
            )

        gap_client = self._client(transport)
        res, _builder = self._post_file(gap_client)
        self.assertEqual(res.status_code, 502)
        body = res.get_json()
        self.assertEqual(body["error"], "unauthorized")
        self.assertEqual(body["upstream_status"], 401)
        text = res.get_data(as_text=True)
        self.assertNotIn(KEY, text)
        self.assertNotIn("Traceback", text)

    def test_unexpected_error_hides_image_and_key(self):
        marker = "data:image/jpeg;base64,SHOULD-NOT-LOG"

        class Boom(GapGPTClient):
            def chat_with_image(self, text, image, mime, **options):
                del text, image, mime, options
                raise RuntimeError(f"exploded {KEY} {marker}")

        records = []

        class ListHandler(logging.Handler):
            def emit(self, record):
                records.append(self.format(record))

        handler = ListHandler()
        app_module.app.logger.addHandler(handler)
        try:
            res, _builder = self._post_file(Boom(config(), transport=lambda *args: None))
        finally:
            app_module.app.logger.removeHandler(handler)
        self.assertEqual(res.status_code, 500)
        self.assertEqual(res.get_json()["error"], "internal_error")
        text = res.get_data(as_text=True)
        self.assertNotIn(KEY, text)
        self.assertNotIn(marker, text)
        self.assertNotIn("Traceback", text)
        logged = "\n".join(records)
        self.assertNotIn(KEY, logged)
        self.assertNotIn(marker, logged)
        self.assertTrue(any("RuntimeError" in line for line in records))

    def test_route_body_cap_stays_above_recipe_json(self):
        res = self.client.post(
            "/vision/fridge",
            data=b"x" * (70 * 1024),
            content_type="application/octet-stream",
        )
        self.assertNotEqual(res.status_code, 413)
        self.assertEqual(res.get_json()["error"], "invalid_image")


if __name__ == "__main__":
    unittest.main()

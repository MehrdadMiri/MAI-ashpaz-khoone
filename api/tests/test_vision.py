"""Unit tests for fridge-photo parsing. No network."""

import base64
import json
import unittest

from gapgpt import DEFAULT_MODEL, MAX_IMAGE_BYTES, GapGPTClient, GapGPTConfig, GapGPTError
from vision import (
    SYSTEM_PROMPT,
    USER_PROMPT,
    VisionRequestError,
    detect_image_mime,
    image_from_base64,
    image_from_bytes,
    parse_ingredients,
    recognize_fridge,
)

KEY = "unit-test-key"
JPEG = b"\xff\xd8\xff\xd9"
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 8
GIF = b"GIF89a" + b"\x01\x00\x01\x00"
WEBP = b"RIFF" + b"\x00\x00\x00\x00" + b"WEBP" + b"xxxx"


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


def chat_response(content):
    return FakeResponse(
        json.dumps(
            {"choices": [{"message": {"role": "assistant", "content": content}}]},
            ensure_ascii=False,
        )
    )


class ImageTests(unittest.TestCase):
    def test_magic_bytes(self):
        self.assertEqual(detect_image_mime(JPEG), "image/jpeg")
        self.assertEqual(detect_image_mime(PNG), "image/png")
        self.assertEqual(detect_image_mime(GIF), "image/gif")
        self.assertEqual(detect_image_mime(WEBP), "image/webp")
        self.assertIsNone(detect_image_mime(b"<svg></svg>"))
        self.assertIsNone(detect_image_mime(b""))

    def test_rejects_non_images_without_echoing_bytes(self):
        secret = b"<html>" + KEY.encode() + b"</html>"
        with self.assertRaises(VisionRequestError) as caught:
            image_from_bytes(secret)
        self.assertEqual(caught.exception.code, "invalid_image")
        self.assertNotIn(KEY, caught.exception.message)
        self.assertNotIn("<html>", caught.exception.message)

    def test_rejects_oversize_image(self):
        huge = b"\xff\xd8\xff" + b"\x00" * MAX_IMAGE_BYTES
        with self.assertRaises(VisionRequestError) as caught:
            image_from_bytes(huge)
        self.assertEqual(caught.exception.code, "image_too_large")
        self.assertEqual(caught.exception.http_status, 413)

    def test_base64_and_data_url(self):
        raw, mime = image_from_base64(base64.b64encode(JPEG).decode("ascii"))
        self.assertEqual(raw, JPEG)
        self.assertEqual(mime, "image/jpeg")
        data_url = "data:image/png;base64," + base64.b64encode(PNG).decode("ascii")
        raw, mime = image_from_base64(data_url)
        self.assertEqual(mime, "image/png")
        self.assertEqual(raw, PNG)

    def test_bad_base64_hides_the_value(self):
        with self.assertRaises(VisionRequestError) as caught:
            image_from_base64(KEY)
        self.assertEqual(caught.exception.code, "invalid_image")
        self.assertNotIn(KEY, caught.exception.message)
        self.assertNotIn(KEY, str(caught.exception.to_dict()))


class ParseTests(unittest.TestCase):
    def test_json_list_is_deduped_and_normalized(self):
        text = json.dumps(
            {
                "ingredients": [
                    "  \u0634\u064a\u0631 ",
                    "شیر",
                    "\u0643\u0631\u0641\u0633",
                    "کرفس",
                    "https://evil.test/x",
                    "[redacted]",
                ]
            },
            ensure_ascii=False,
        )
        self.assertEqual(parse_ingredients(text), ["شیر", "کرفس"])

    def test_fenced_json_and_object_names(self):
        text = '```json\n{"items":[{"name":"تخم مرغ"},{"name":"  "}]} \n```'
        self.assertEqual(parse_ingredients(text), ["تخم مرغ"])

    def test_empty_list_is_success(self):
        self.assertEqual(parse_ingredients('{"ingredients":[]}'), [])

    def test_prose_is_an_error_and_hides_the_text(self):
        with self.assertRaises(GapGPTError) as caught:
            parse_ingredients(f"I see {KEY} in the fridge")
        self.assertEqual(caught.exception.code, "bad_response")
        self.assertNotIn(KEY, caught.exception.message)
        self.assertNotIn("I see", caught.exception.message)

    def test_prompt_does_not_ask_for_secrets(self):
        self.assertIn("JSON", SYSTEM_PROMPT)
        self.assertIn("Persian", SYSTEM_PROMPT)
        self.assertIn("مواد غذایی", SYSTEM_PROMPT)
        self.assertIn("یخچال", USER_PROMPT)
        self.assertNotIn("GAP_CODE_API_KEY", SYSTEM_PROMPT)
        self.assertNotIn("sk-", SYSTEM_PROMPT)


class RecognizeTests(unittest.TestCase):
    def test_sends_image_to_gapgpt_and_returns_names_only(self):
        seen = {}

        def transport(request, timeout):
            seen["payload"] = json.loads(request.data.decode("utf-8"))
            seen["auth"] = request.get_header("Authorization")
            seen["timeout"] = timeout
            return chat_response(
                json.dumps({"ingredients": ["پنیر", "ماست"]}, ensure_ascii=False)
            )

        client = GapGPTClient(config(), timeout=12, transport=transport)
        result = recognize_fridge(client, JPEG, "image/jpeg")
        self.assertEqual(result, {"ok": True, "ingredients": ["پنیر", "ماست"]})
        self.assertEqual(seen["payload"]["model"], DEFAULT_MODEL)
        self.assertEqual(seen["payload"]["messages"][0]["role"], "system")
        parts = seen["payload"]["messages"][1]["content"]
        self.assertEqual(parts[0]["text"], USER_PROMPT)
        self.assertTrue(parts[1]["image_url"]["url"].startswith("data:image/jpeg;base64,"))
        self.assertEqual(seen["auth"], f"Bearer {KEY}")
        self.assertNotIn(KEY.encode(), request_body(seen))
        self.assertNotIn(KEY, json.dumps(result))

    def test_redacted_key_is_not_a_candidate(self):
        def transport(request, timeout):
            del request, timeout
            leaked = json.dumps({"ingredients": ["شیر", KEY]}, ensure_ascii=False)
            return chat_response(leaked)

        client = GapGPTClient(config(), transport=transport)
        result = recognize_fridge(client, JPEG, "image/jpeg")
        self.assertEqual(result["ingredients"], ["شیر"])
        self.assertNotIn(KEY, json.dumps(result))


def request_body(seen):
    return json.dumps(seen["payload"]).encode("utf-8")


if __name__ == "__main__":
    unittest.main()

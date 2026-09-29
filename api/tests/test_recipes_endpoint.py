"""Flask tests for POST /recipes/generate. No network and no database."""

import io
import json
import logging
import unittest
import urllib.error
from unittest.mock import patch

import app as app_module
from gapgpt import DEFAULT_MODEL, GapGPTClient, GapGPTConfig
from recipes import RECIPE_CLIENT_TIMEOUT

KEY = "unit-test-key"


def config(**overrides):
    data = {
        "api_key": KEY,
        "base_url": "https://example.test/v1",
        "model": DEFAULT_MODEL,
    }
    data.update(overrides)
    return GapGPTConfig(**data)


def dish(title, ingredients, steps, cost=1000):
    return {
        "title": title,
        "ingredients": ingredients,
        "steps": steps,
        "cost_toman": cost,
    }


def recipe_json():
    return {
        "recipes": [
            dish(
                "عدس‌پلو",
                ["برنج", "عدس", "پیاز"],
                ["پیاز را تفت بده", "عدس را بپز", "برنج را دم کن"],
                180000,
            ),
            dish(
                "لوبیا پلو",
                ["برنج", "لوبیا"],
                ["لوبیا را بپز", "برنج را اضافه کن", "دم کن"],
                160000,
            ),
            dish(
                "ماست و خیار",
                ["ماست", "خیار"],
                ["ماست را هم بزن", "خیار را اضافه کن", "سرد سرو کن"],
                70000,
            ),
        ]
    }


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

    def _post(self, body=None, gap_client=None, path="/recipes/generate"):
        if gap_client is None:
            return self.client.post(path, json=body)
        with patch("app.build_gapgpt_client", return_value=gap_client) as builder:
            response = self.client.post(path, json=body)
        return response, builder

    def test_get_is_not_allowed(self):
        res = self.client.get("/recipes/generate")
        self.assertEqual(res.status_code, 405)
        self.assertEqual(res.get_json()["error"], "method_not_allowed")

    def test_empty_pantry_and_bad_budget(self):
        res = self.client.post(
            "/recipes/generate",
            json={"ingredients": [], "budget": 10},
        )
        self.assertEqual(res.status_code, 400)
        self.assertEqual(res.get_json()["error"], "empty_ingredients")

        res = self.client.post(
            "/recipes/generate",
            json={"ingredients": ["برنج"], "budget": True},
        )
        self.assertEqual(res.status_code, 400)
        self.assertEqual(res.get_json()["error"], "invalid_budget")
        self.assertNotIn("True", res.get_data(as_text=True))

    def test_invalid_json_is_controlled(self):
        res = self.client.post(
            "/recipes/generate",
            data="{not-json",
            content_type="application/json",
        )
        self.assertEqual(res.status_code, 400)
        body = res.get_json()
        self.assertEqual(body["error"], "invalid_request")
        self.assertNotIn("Traceback", res.get_data(as_text=True))

    def test_oversized_body(self):
        res = self.client.post(
            "/recipes/generate",
            data="x" * (70 * 1024),
            content_type="application/json",
        )
        self.assertEqual(res.status_code, 413)
        self.assertEqual(res.get_json()["error"], "invalid_request")

    def test_missing_key_does_not_call_upstream(self):
        seen = []

        def transport(request, timeout):
            seen.append(request)
            raise AssertionError("upstream was called")

        gap_client = GapGPTClient(config(api_key=""), transport=transport)
        res, _builder = self._post(
            {"ingredients": ["برنج", "عدس"], "budget": 1500000},
            gap_client,
        )
        self.assertEqual(res.status_code, 503)
        self.assertEqual(res.get_json()["error"], "not_configured")
        self.assertEqual(seen, [])
        self.assertNotIn("Traceback", res.get_data(as_text=True))

    def test_success_sends_pantry_budget_and_model(self):
        seen = {}

        def transport(request, timeout):
            seen["payload"] = json.loads(request.data.decode("utf-8"))
            seen["auth"] = request.get_header("Authorization")
            seen["timeout"] = timeout
            return chat_response(json.dumps(recipe_json(), ensure_ascii=False))

        gap_client = GapGPTClient(config(), timeout=RECIPE_CLIENT_TIMEOUT, transport=transport)
        res, builder = self._post(
            {"ingredients": ["  برنج ", "عدس", "برنج"], "budget": 1500000},
            gap_client,
        )
        self.assertEqual(res.status_code, 200, res.get_data(as_text=True))
        body = res.get_json()
        self.assertTrue(body["ok"])
        self.assertGreaterEqual(len(body["recipes"]), 3)
        self.assertEqual(body["recipes"][0]["title"], "عدس‌پلو")
        self.assertIn("برنج", body["recipes"][0]["ingredients"])
        self.assertTrue(body["recipes"][0]["steps"])
        self.assertIn("عدس‌پلو", res.get_data(as_text=True))
        self.assertNotIn(KEY, res.get_data(as_text=True))

        user = seen["payload"]["messages"][1]["content"]
        self.assertEqual(seen["payload"]["model"], DEFAULT_MODEL)
        self.assertIn("برنج", user)
        self.assertIn("عدس", user)
        self.assertIn("بودجه هفته: 1500000 تومان", user)
        self.assertEqual(user.count("\n- برنج"), 1)
        self.assertEqual(seen["auth"], f"Bearer {KEY}")
        self.assertNotIn(KEY.encode(), json.dumps(seen["payload"]).encode())
        self.assertEqual(builder.call_args.kwargs["timeout"], RECIPE_CLIENT_TIMEOUT)
        self.assertEqual(seen["timeout"], RECIPE_CLIENT_TIMEOUT)

        prefixed, _builder = self._post(
            {"ingredients": ["برنج", "عدس"], "budget": 1500000},
            gap_client,
            path="/api/recipes/generate",
        )
        self.assertEqual(prefixed.status_code, 200, prefixed.get_data(as_text=True))
        self.assertEqual(prefixed.get_json()["recipes"][0]["title"], "عدس‌پلو")

    def test_unspecified_budget_is_still_sent(self):
        seen = {}

        def transport(request, timeout):
            del timeout
            seen["payload"] = json.loads(request.data.decode("utf-8"))
            return chat_response(json.dumps(recipe_json(), ensure_ascii=False))

        gap_client = GapGPTClient(config(), transport=transport)
        res, _builder = self._post({"ingredients": ["پیاز"]}, gap_client)
        self.assertEqual(res.status_code, 200)
        user = seen["payload"]["messages"][1]["content"]
        self.assertIn("بودجه هفته: مشخص نشده.", user)
        self.assertIn("پیاز", user)

    def test_unauthorized_hides_key_and_traceback(self):
        def transport(request, timeout):
            del request, timeout
            raise urllib.error.HTTPError(
                "https://example.test/v1/chat/completions",
                401,
                "Unauthorized",
                hdrs=None,
                fp=io.BytesIO(json.dumps({"error": KEY}).encode("utf-8")),
            )

        gap_client = GapGPTClient(config(), transport=transport)
        res, _builder = self._post(
            {"ingredients": ["برنج"], "budget": 10},
            gap_client,
        )
        self.assertEqual(res.status_code, 502)
        body = res.get_json()
        self.assertEqual(body["error"], "unauthorized")
        self.assertEqual(body["upstream_status"], 401)
        text = res.get_data(as_text=True)
        self.assertNotIn(KEY, text)
        self.assertNotIn("Traceback", text)

    def test_ingredient_equal_to_key_is_not_sent(self):
        seen = []

        def transport(request, timeout):
            del timeout
            seen.append(request)
            raise AssertionError("must not send the key")

        gap_client = GapGPTClient(config(), transport=transport)
        res, _builder = self._post(
            {"ingredients": [KEY, "برنج"], "budget": 10},
            gap_client,
        )
        self.assertEqual(res.status_code, 400)
        self.assertEqual(res.get_json()["error"], "invalid_request")
        self.assertEqual(seen, [])
        self.assertNotIn(KEY, res.get_data(as_text=True))

    def test_bad_model_json_is_controlled(self):
        def transport(request, timeout):
            del request, timeout
            return chat_response("this is not json")

        gap_client = GapGPTClient(config(), transport=transport)
        res, _builder = self._post({"ingredients": ["برنج"], "budget": 10}, gap_client)
        self.assertEqual(res.status_code, 502)
        self.assertEqual(res.get_json()["error"], "bad_response")
        text = res.get_data(as_text=True)
        self.assertNotIn("this is not json", text)
        self.assertNotIn(KEY, text)
        self.assertNotIn("Traceback", text)

    def test_unexpected_error_hides_exception_text(self):
        class Boom(GapGPTClient):
            def chat_text(self, messages, **options):
                raise RuntimeError(f"exploded {KEY}")

        records = []

        class ListHandler(logging.Handler):
            def emit(self, record):
                records.append(self.format(record))

        handler = ListHandler()
        app_module.app.logger.addHandler(handler)
        try:
            res, _builder = self._post(
                {"ingredients": ["برنج"], "budget": 10},
                Boom(config(), transport=lambda *args: None),
            )
        finally:
            app_module.app.logger.removeHandler(handler)
        self.assertEqual(res.status_code, 500)
        self.assertEqual(res.get_json()["error"], "internal_error")
        text = res.get_data(as_text=True)
        self.assertNotIn(KEY, text)
        self.assertNotIn("Traceback", text)
        self.assertNotIn(KEY, "\n".join(records))

    def test_leftover_prompt_skips_used_dinner_without_leaking_the_key(self):
        seen = {}
        extra = dish(
            "کوکو سبزی",
            ["سبزی", "تخم‌مرغ"],
            ["سبزی را خرد کن", "تخم‌مرغ را بزن", "سرخ کن"],
            110000,
        )
        payload = recipe_json()
        payload["recipes"] = payload["recipes"] + [extra]

        def transport(request, timeout):
            del timeout
            seen["payload"] = json.loads(request.data.decode("utf-8"))
            return chat_response(json.dumps(payload, ensure_ascii=False))

        gap_client = GapGPTClient(config(), transport=transport)
        res, _builder = self._post(
            {
                "ingredients": ["برنج", "عدس", "پیاز", "ماست"],
                "budget": 1500000,
                "remaining": ["ماست"],
                "skip": ["عدس‌پلو"],
                "full": False,
            },
            gap_client,
        )
        self.assertEqual(res.status_code, 200, res.get_data(as_text=True))
        body = res.get_json()
        self.assertEqual(body["mode"], "leftovers")
        titles = [item["title"] for item in body["recipes"]]
        self.assertEqual(len(titles), 3)
        self.assertNotIn("عدس‌پلو", titles)
        self.assertNotIn(KEY, res.get_data(as_text=True))
        user = seen["payload"]["messages"][1]["content"]
        self.assertIn("مواد باقی‌مانده:", user)
        self.assertIn("\n- ماست", user)
        self.assertIn("عدس‌پلو", user)
        self.assertIn("بودجه هفته: 1500000 تومان", user)
        self.assertNotIn(KEY, user)

    def test_full_regenerate_ignores_skip_and_keeps_budget(self):
        seen = {}

        def transport(request, timeout):
            del timeout
            seen["payload"] = json.loads(request.data.decode("utf-8"))
            return chat_response(json.dumps(recipe_json(), ensure_ascii=False))

        gap_client = GapGPTClient(config(), transport=transport)
        res, _builder = self._post(
            {
                "ingredients": ["برنج", "عدس", "ماست"],
                "budget": 1500000,
                "remaining": ["ماست"],
                "skip": ["عدس‌پلو"],
                "full": True,
            },
            gap_client,
        )
        self.assertEqual(res.status_code, 200, res.get_data(as_text=True))
        body = res.get_json()
        self.assertEqual(body["mode"], "full")
        self.assertEqual(body["recipes"][0]["title"], "عدس‌پلو")
        self.assertNotIn(KEY, res.get_data(as_text=True))
        user = seen["payload"]["messages"][1]["content"]
        self.assertIn("بازتولید کامل:", user)
        self.assertIn("بودجه هفته: 1500000 تومان", user)
        self.assertIn("برنج", user)
        self.assertNotIn("عدس‌پلو", user)
        self.assertNotIn("وعده‌های خورده‌شده:", user)

    def test_empty_remaining_and_key_in_skip_are_not_sent(self):
        seen = []

        def transport(request, timeout):
            del timeout
            seen.append(request)
            raise AssertionError("upstream was called")

        gap_client = GapGPTClient(config(), transport=transport)
        res, _builder = self._post(
            {
                "ingredients": ["برنج"],
                "remaining": [],
                "skip": [KEY],
                "budget": 10,
            },
            gap_client,
        )
        self.assertEqual(res.status_code, 400)
        self.assertEqual(res.get_json()["error"], "no_remaining")
        self.assertEqual(seen, [])
        self.assertNotIn(KEY, res.get_data(as_text=True))
        self.assertNotIn("Traceback", res.get_data(as_text=True))

        res, _builder = self._post(
            {
                "ingredients": ["برنج"],
                "skip": [KEY],
                "budget": 10,
            },
            gap_client,
        )
        self.assertEqual(res.status_code, 400)
        self.assertEqual(res.get_json()["error"], "invalid_request")
        self.assertEqual(seen, [])
        self.assertNotIn(KEY, res.get_data(as_text=True))

    def test_diet_filters_reach_the_prompt_and_bad_values_stay_hidden(self):
        seen = {}

        def transport(request, timeout):
            del timeout
            seen["payload"] = json.loads(request.data.decode("utf-8"))
            return chat_response(json.dumps(recipe_json(), ensure_ascii=False))

        gap_client = GapGPTClient(config(), timeout=RECIPE_CLIENT_TIMEOUT, transport=transport)
        res, _builder = self._post(
            {
                "ingredients": ["برنج", "عدس", "ماست"],
                "budget": 1500000,
                "filters": {"vegetarian": True, "no_onion": True, "diabetic": False},
            },
            gap_client,
        )
        self.assertEqual(res.status_code, 200, res.get_data(as_text=True))
        body = res.get_json()
        self.assertEqual(
            body["filters"],
            {"vegetarian": True, "no_onion": True, "diabetic": False},
        )
        self.assertEqual(len(body["recipes"]), 3)
        user = seen["payload"]["messages"][1]["content"]
        self.assertIn("محدودیت غذایی:", user)
        self.assertIn("- گیاهی:", user)
        self.assertIn("- بدون پیاز:", user)
        self.assertNotIn("- مناسب دیابت:", user)
        self.assertNotIn(KEY, res.get_data(as_text=True))

        secret = "filter-secret-value"
        rejected, _builder = self._post(
            {"ingredients": ["برنج"], "filters": {"diabetic": secret}},
            gap_client,
        )
        self.assertEqual(rejected.status_code, 400)
        self.assertEqual(rejected.get_json()["error"], "invalid_request")
        self.assertNotIn(secret, rejected.get_data(as_text=True))


if __name__ == "__main__":
    unittest.main()

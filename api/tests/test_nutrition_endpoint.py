"""Flask tests for POST /recipes/nutrition. No network and no database."""

import json
import logging
import unittest
from unittest.mock import patch

import app as app_module
from gapgpt import DEFAULT_MODEL, GapGPTClient, GapGPTConfig
from nutrition import NUTRITION_CLIENT_TIMEOUT, clear_nutrition_cache

KEY = "unit-test-key"


def config(**overrides):
    data = {
        "api_key": KEY,
        "base_url": "https://example.test/v1",
        "model": DEFAULT_MODEL,
    }
    data.update(overrides)
    return GapGPTConfig(**data)


def dish(title="عدس‌پلو"):
    return {
        "title": title,
        "ingredients": ["برنج", "عدس"],
        "steps": ["عدس را بپز", "برنج را دم کن", "سرو کن"],
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
        clear_nutrition_cache()
        self.client = app_module.app.test_client()

    def tearDown(self):
        clear_nutrition_cache()

    def _post(self, body=None, gap_client=None, path="/recipes/nutrition"):
        if gap_client is None:
            return self.client.post(path, json=body)
        with patch("app.build_gapgpt_client", return_value=gap_client) as builder:
            response = self.client.post(path, json=body)
        return response, builder

    def test_get_is_not_allowed(self):
        res = self.client.get("/recipes/nutrition")
        self.assertEqual(res.status_code, 405)
        self.assertEqual(res.get_json()["error"], "method_not_allowed")

    def test_bad_body_does_not_call_upstream(self):
        seen = []

        def transport(request, timeout):
            del timeout
            seen.append(request)
            raise AssertionError("upstream was called")

        gap_client = GapGPTClient(config(), transport=transport)
        res, _builder = self._post({"recipes": KEY}, gap_client)
        self.assertEqual(res.status_code, 400)
        self.assertEqual(res.get_json()["error"], "invalid_request")
        self.assertEqual(seen, [])
        text = res.get_data(as_text=True)
        self.assertNotIn(KEY, text)
        self.assertNotIn("Traceback", text)

    def test_success_caches_and_hides_the_key(self):
        seen = []

        def transport(request, timeout):
            seen.append(json.loads(request.data.decode("utf-8")))
            self.assertEqual(timeout, NUTRITION_CLIENT_TIMEOUT)
            content = json.dumps(
                {
                    "estimates": [
                        {
                            "kcal": 480,
                            "protein_g": 16,
                            "carbs_g": 70,
                            "fat_g": 14,
                            "note": KEY,
                        }
                    ]
                },
                ensure_ascii=False,
            )
            return chat_response(content)

        gap_client = GapGPTClient(
            config(),
            timeout=NUTRITION_CLIENT_TIMEOUT,
            transport=transport,
        )
        res, builder = self._post({"recipes": [dish()]}, gap_client)
        self.assertEqual(res.status_code, 200, res.get_data(as_text=True))
        body = res.get_json()
        self.assertTrue(body["ok"])
        self.assertTrue(body["available"])
        self.assertEqual(
            body["estimates"][0],
            {"kcal": 480, "protein_g": 16, "carbs_g": 70, "fat_g": 14},
        )
        self.assertNotIn(KEY, res.get_data(as_text=True))
        self.assertEqual(builder.call_args.kwargs["timeout"], NUTRITION_CLIENT_TIMEOUT)
        self.assertEqual(seen[0]["model"], DEFAULT_MODEL)
        self.assertNotIn(KEY, json.dumps(seen[0]))

        again, _builder = self._post({"recipes": [dish()]}, gap_client)
        self.assertEqual(again.status_code, 200)
        self.assertEqual(again.get_json()["estimates"][0]["kcal"], 480)
        self.assertEqual(len(seen), 1)

        prefixed, _builder = self._post(
            {"recipes": [dish()]},
            gap_client,
            path="/api/recipes/nutrition",
        )
        self.assertEqual(prefixed.status_code, 200)
        self.assertEqual(prefixed.get_json()["estimates"][0]["kcal"], 480)
        self.assertEqual(len(seen), 1)

    def test_upstream_and_missing_key_keep_http_200(self):
        def transport(request, timeout):
            del request, timeout
            raise TimeoutError(KEY)

        gap_client = GapGPTClient(config(), transport=transport)
        records = []

        class ListHandler(logging.Handler):
            def emit(self, record):
                records.append(self.format(record))

        handler = ListHandler()
        app_module.app.logger.addHandler(handler)
        logging.getLogger("nutrition").addHandler(handler)
        try:
            res, _builder = self._post(
                {"recipes": [dish(title="SECRET-DISH")]},
                gap_client,
            )
        finally:
            app_module.app.logger.removeHandler(handler)
            logging.getLogger("nutrition").removeHandler(handler)
        self.assertEqual(res.status_code, 200, res.get_data(as_text=True))
        body = res.get_json()
        self.assertTrue(body["ok"])
        self.assertFalse(body["available"])
        self.assertEqual(body["estimates"], [None])
        text = res.get_data(as_text=True) + "\n".join(records)
        self.assertNotIn(KEY, text)
        self.assertNotIn("SECRET-DISH", text)
        self.assertNotIn("Traceback", text)

        empty = GapGPTClient(config(api_key=""), transport=transport)
        res, _builder = self._post({"recipes": [dish()]}, empty)
        self.assertEqual(res.status_code, 200)
        self.assertFalse(res.get_json()["available"])
        self.assertEqual(res.get_json()["estimates"], [None])

    def test_key_inside_a_recipe_is_not_sent_or_returned(self):
        seen = []

        def transport(request, timeout):
            del request, timeout
            seen.append(1)
            raise AssertionError("upstream was called")

        gap_client = GapGPTClient(config(), transport=transport)
        res, _builder = self._post({"recipes": [dish(title=KEY)]}, gap_client)
        self.assertEqual(res.status_code, 200, res.get_data(as_text=True))
        body = res.get_json()
        self.assertTrue(body["ok"])
        self.assertFalse(body["available"])
        self.assertEqual(body["estimates"], [None])
        self.assertEqual(seen, [])
        text = res.get_data(as_text=True)
        self.assertNotIn(KEY, text)
        self.assertNotIn("Traceback", text)

    def test_root_lists_the_route(self):
        body = self.client.get("/").get_json()
        self.assertEqual(body["recipes_nutrition"], "/recipes/nutrition")


if __name__ == "__main__":
    unittest.main()

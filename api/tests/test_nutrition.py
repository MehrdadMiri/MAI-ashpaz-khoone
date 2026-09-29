"""Unit tests for nutrition estimates. No network."""

import json
import logging
import unittest
from pathlib import Path

from gapgpt import DEFAULT_MODEL, GapGPTClient, GapGPTConfig, GapGPTError
from nutrition import (
    NUTRITION_CLIENT_TIMEOUT,
    NUTRITION_SYSTEM_PROMPT,
    NutritionRequestError,
    build_messages,
    clear_nutrition_cache,
    estimate_nutrition,
    parse_estimates,
    parse_nutrition_body,
    recipe_cache_key,
)


def dish(title="عدس‌پلو", ingredients=None, steps=None):
    return {
        "title": title,
        "ingredients": ingredients or ["برنج", "عدس", "پیاز"],
        "steps": steps or ["پیاز را تفت بده", "عدس را بپز", "برنج را دم کن"],
    }


class Response:
    def __init__(self, content):
        body = {
            "choices": [{"message": {"role": "assistant", "content": content}}]
        }
        self._raw = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.status = 200

    def read(self, n=-1):
        data = self._raw
        self._raw = b""
        if n is None or n < 0:
            return data
        return data[:n]

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


def estimates_json(rows):
    return json.dumps({"estimates": rows}, ensure_ascii=False)


class BodyTests(unittest.TestCase):
    def test_accepts_recipes_and_ignores_extra_fields(self):
        recipes = parse_nutrition_body(
            {"recipes": [dict(dish(), cost_toman=10, note="skip")], "budget": 1}
        )
        self.assertEqual(len(recipes), 1)
        self.assertEqual(set(recipes[0]), {"title", "ingredients", "steps"})
        self.assertEqual(recipes[0]["title"], "عدس‌پلو")

    def test_normalizes_spelling_for_the_cache_key(self):
        left = parse_nutrition_body({"recipes": [dish(title="  كرفس پلو  ")]})
        right = parse_nutrition_body({"recipes": [dish(title="کرفس پلو")]})
        self.assertEqual(left[0]["title"], right[0]["title"])
        self.assertEqual(recipe_cache_key(left[0]), recipe_cache_key(right[0]))

    def test_cost_does_not_change_the_cache_key(self):
        base = dish()
        other = dict(base, cost_toman=999)
        self.assertEqual(recipe_cache_key(base), recipe_cache_key(other))

    def test_rejects_bad_shapes_without_echoing_them(self):
        secret = "pantry-secret-value"
        cases = (
            None,
            [dish()],
            {},
            {"recipes": []},
            {"recipes": secret},
            {"recipes": [secret]},
            {"recipes": [dish(title="برنج\nsecret")]},
            {"recipes": [dish()] * 7},
        )
        for body in cases:
            with self.assertRaises(NutritionRequestError) as caught:
                parse_nutrition_body(body)
            self.assertEqual(caught.exception.http_status, 400)
            rendered = caught.exception.message + json.dumps(caught.exception.to_dict())
            self.assertNotIn(secret, rendered)
            self.assertNotIn("Traceback", rendered)

    def test_long_field_is_not_echoed(self):
        secret = "ن" + "SECRET" + ("ن" * 200)
        with self.assertRaises(NutritionRequestError) as caught:
            parse_nutrition_body({"recipes": [dish(title=secret)]})
        self.assertNotIn("SECRET", caught.exception.message)
        self.assertNotIn("SECRET", json.dumps(caught.exception.to_dict()))


class PromptTests(unittest.TestCase):
    def test_messages_treat_recipes_as_data(self):
        messages = build_messages([dish()])
        self.assertEqual(messages[0]["content"], NUTRITION_SYSTEM_PROMPT)
        self.assertIn("untrusted", NUTRITION_SYSTEM_PROMPT)
        self.assertIn("یک وعده", NUTRITION_SYSTEM_PROMPT)
        user = messages[1]["content"]
        self.assertIn("عدس‌پلو", user)
        self.assertIn("untrusted", user)
        self.assertNotIn("unit-test-key", user)


class ParseTests(unittest.TestCase):
    def test_plain_and_fenced_json(self):
        rows = [
            {"kcal": 450, "protein_g": 18, "carbs_g": 62, "fat_g": 14},
            {"kcal": 90},
        ]
        parsed = parse_estimates(estimates_json(rows), 2)
        self.assertEqual(parsed[0]["kcal"], 450)
        self.assertEqual(parsed[0]["protein_g"], 18)
        self.assertEqual(parsed[1], {"kcal": 90})
        fenced = "```json\n" + estimates_json(rows) + "\n```"
        self.assertEqual(parse_estimates(fenced, 2)[0]["kcal"], 450)

    def test_persian_digits_aliases_and_rounding(self):
        text = estimates_json(
            [{"calories": "۴۵۰", "protein": "۱۸٫۴", "carbohydrates": 62.2, "fat": 0}]
        )
        parsed = parse_estimates(text, 1)
        self.assertEqual(
            parsed[0],
            {"kcal": 450, "protein_g": 18, "carbs_g": 62, "fat_g": 0},
        )

    def test_drops_bad_numbers_and_length_mismatches(self):
        text = estimates_json(
            [
                {"kcal": -5, "protein_g": 10},
                {"kcal": 99999, "fat_g": 3},
                {"kcal": True},
                {"kcal": 100, "note": "unit-test-key", "protein_g": "nope"},
            ]
        )
        parsed = parse_estimates(text, 4)
        self.assertEqual(parsed[0], None)
        self.assertEqual(parsed[1], None)
        self.assertEqual(parsed[2], None)
        self.assertEqual(parsed[3], {"kcal": 100})
        self.assertNotIn("note", parsed[3])
        self.assertIsNone(parse_estimates(estimates_json([{"kcal": 1}]), 2)[0])
        self.assertIsNone(parse_estimates(estimates_json([{"kcal": 1}]), 2)[1])

    def test_unreadable_text_raises_without_the_reply(self):
        marker = "HIDDEN-NOTE"
        with self.assertRaises(GapGPTError) as caught:
            parse_estimates(f"not json {marker}", 1)
        self.assertEqual(caught.exception.code, "bad_response")
        self.assertNotIn(marker, str(caught.exception))
        self.assertNotIn(marker, json.dumps(caught.exception.to_dict()))


class EstimateTests(unittest.TestCase):
    def setUp(self):
        clear_nutrition_cache()

    def tearDown(self):
        clear_nutrition_cache()

    def _client(self, transport, api_key="unit-test-key"):
        return GapGPTClient(
            GapGPTConfig(
                api_key=api_key,
                base_url="https://example.test/v1",
                model=DEFAULT_MODEL,
            ),
            timeout=NUTRITION_CLIENT_TIMEOUT,
            transport=transport,
        )

    def test_calls_model_once_then_uses_the_cache(self):
        seen = []

        def transport(request, timeout):
            seen.append(json.loads(request.data.decode("utf-8")))
            self.assertEqual(timeout, NUTRITION_CLIENT_TIMEOUT)
            self.assertEqual(request.get_header("Authorization"), "Bearer unit-test-key")
            return Response(estimates_json([{"kcal": 450, "protein_g": 18, "carbs_g": 60, "fat_g": 12}]))

        client = self._client(transport)
        first = estimate_nutrition(client, [dish(title="  كرفس‌پلو ")])
        second = estimate_nutrition(client, [dish(title="کرفس‌پلو")])
        self.assertEqual(len(seen), 1)
        self.assertEqual(seen[0]["model"], DEFAULT_MODEL)
        self.assertNotIn("unit-test-key", json.dumps(seen[0]))
        self.assertEqual(first["available"], True)
        self.assertEqual(first["estimates"][0]["kcal"], 450)
        self.assertEqual(second["estimates"][0]["protein_g"], 18)
        self.assertIn("کرفس‌پلو", seen[0]["messages"][1]["content"])

    def test_partial_cache_sends_only_the_miss(self):
        calls = []

        def transport(request, timeout):
            del timeout
            user = json.loads(request.data.decode("utf-8"))["messages"][1]["content"]
            calls.append(user)
            if "کوکو سبزی" in user:
                rows = [{"kcal": 200}]
            else:
                rows = [{"kcal": 100}]
            return Response(estimates_json(rows))

        client = self._client(transport)
        estimate_nutrition(client, [dish()])
        both = estimate_nutrition(
            client,
            [dish(), dish(title="کوکو سبزی", ingredients=["سبزی", "تخم‌مرغ"], steps=["خرد کن", "بزن", "سرخ کن"])],
        )
        self.assertEqual(len(calls), 2)
        self.assertNotIn("عدس‌پلو", calls[1])
        self.assertIn("کوکو سبزی", calls[1])
        self.assertEqual(both["estimates"][0]["kcal"], 100)
        self.assertEqual(both["estimates"][1]["kcal"], 200)

    def test_upstream_failure_is_soft_and_does_not_log_the_recipe(self):
        marker = "SECRET-RECIPE"

        def transport(request, timeout):
            del request, timeout
            raise TimeoutError(marker)

        records = []

        class ListHandler(logging.Handler):
            def emit(self, record):
                records.append(self.format(record))

        handler = ListHandler()
        logger = logging.getLogger("nutrition")
        logger.addHandler(handler)
        try:
            result = estimate_nutrition(self._client(transport), [dish(title=marker)])
        finally:
            logger.removeHandler(handler)
        self.assertTrue(result["ok"])
        self.assertFalse(result["available"])
        self.assertEqual(result["estimates"], [None])
        rendered = json.dumps(result) + "\n".join(records)
        self.assertNotIn(marker, rendered)
        self.assertNotIn("unit-test-key", rendered)
        self.assertIn("timeout", rendered)

    def test_failed_estimate_is_not_cached(self):
        calls = []

        def transport(request, timeout):
            del request, timeout
            calls.append(1)
            if len(calls) == 1:
                return Response("not json")
            return Response(estimates_json([{"kcal": 10}]))

        client = self._client(transport)
        first = estimate_nutrition(client, [dish()])
        second = estimate_nutrition(client, [dish()])
        self.assertFalse(first["available"])
        self.assertEqual(second["estimates"][0]["kcal"], 10)
        self.assertEqual(len(calls), 2)

    def test_missing_key_with_a_warm_cache_still_returns_numbers(self):
        def transport(request, timeout):
            del request, timeout
            return Response(estimates_json([{"kcal": 320, "fat_g": 9}]))

        estimate_nutrition(self._client(transport), [dish()])

        def boom(request, timeout):
            del request, timeout
            raise AssertionError("cache hit must not call GapGPT")

        result = estimate_nutrition(self._client(boom, api_key=""), [dish()])
        self.assertEqual(result["estimates"][0]["kcal"], 320)
        self.assertEqual(result["available"], True)

    def test_missing_key_without_cache_does_not_call_upstream(self):
        def transport(request, timeout):
            del request, timeout
            raise AssertionError("upstream was called")

        result = estimate_nutrition(self._client(transport, api_key=""), [dish()])
        self.assertTrue(result["ok"])
        self.assertFalse(result["available"])
        self.assertEqual(result["estimates"], [None])

    def test_timeout_constant_fits_the_proxy(self):
        root = Path(__file__).resolve().parents[2]
        dockerfile = (root / "api" / "Dockerfile").read_text(encoding="utf-8")
        nginx = (root / "web" / "nginx.conf").read_text(encoding="utf-8")
        self.assertEqual(NUTRITION_CLIENT_TIMEOUT, 30.0)
        self.assertLess(NUTRITION_CLIENT_TIMEOUT, 110)
        self.assertIn("nutrition.py", dockerfile)
        self.assertIn("proxy_read_timeout 110s;", nginx)


if __name__ == "__main__":
    unittest.main()

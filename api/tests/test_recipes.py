"""Unit tests for recipe parsing and prompting. No network."""

import json
import unittest

from gapgpt import DEFAULT_MODEL, GapGPTClient, GapGPTConfig, GapGPTError
from recipes import (
    SYSTEM_PROMPT,
    build_messages,
    parse_generate_body,
    parse_recipes,
    generate_recipes,
    RecipeRequestError,
)


def dish(title, ingredients, steps, cost=120000):
    return {
        "title": title,
        "ingredients": ingredients,
        "steps": steps,
        "cost_toman": cost,
    }


def sample_recipes():
    return [
        dish(
            "عدس‌پلو",
            ["برنج", "عدس", "پیاز"],
            ["پیاز را با روغن تفت بده", "عدس را بپز", "برنج را با عدس دم کن"],
            180000,
        ),
        dish(
            "لوبیا پلو",
            ["برنج", "لوبیا", "روغن"],
            ["لوبیا را بپز", "برنج را خیس کن", "هر دو را با هم دم کن"],
            200000,
        ),
        dish(
            "ماست و سبزی",
            ["ماست", "سبزی"],
            ["ماست را هم بزن", "سبزی را خرد کن", "مخلوط کن و سرو کن"],
            90000,
        ),
    ]


def sample_payload():
    return {"recipes": sample_recipes()}


PANTRY = ["برنج", "عدس", "پیاز", "لوبیا", "ماست", "روغن"]


class RequestBodyTests(unittest.TestCase):
    def test_accepts_ingredients_and_budget(self):
        items, budget = parse_generate_body(
            {"ingredients": ["  برنج ", "پیاز"], "budget": 1500000}
        )
        self.assertEqual(items, ["برنج", "پیاز"])
        self.assertEqual(budget, 1500000)

    def test_missing_budget_is_unspecified(self):
        _items, budget = parse_generate_body({"ingredients": ["برنج"]})
        self.assertIsNone(budget)
        _items, budget = parse_generate_body({"ingredients": ["برنج"], "budget": None})
        self.assertIsNone(budget)

    def test_persian_digit_budget_and_whole_float(self):
        _items, budget = parse_generate_body(
            {"ingredients": ["برنج"], "budget": "۱۵۰۰۰۰۰"}
        )
        self.assertEqual(budget, 1500000)
        _items, budget = parse_generate_body(
            {"ingredients": ["برنج"], "budget": 1500.0}
        )
        self.assertEqual(budget, 1500)

    def test_rejects_bad_budget_without_echoing_it(self):
        for value in (True, False, -5, 1.5, "nope", "1e6", [], {}):
            with self.assertRaises(RecipeRequestError) as caught:
                parse_generate_body({"ingredients": ["برنج"], "budget": value})
            self.assertEqual(caught.exception.code, "invalid_budget")
            self.assertNotIn(str(value), caught.exception.message)

    def test_empty_and_blank_ingredients(self):
        with self.assertRaises(RecipeRequestError) as caught:
            parse_generate_body({"ingredients": [], "budget": 10})
        self.assertEqual(caught.exception.code, "empty_ingredients")
        with self.assertRaises(RecipeRequestError) as caught:
            parse_generate_body({"ingredients": ["  ", ""], "budget": 10})
        self.assertEqual(caught.exception.code, "empty_ingredients")

    def test_dedupes_and_normalizes_spelling(self):
        items, _budget = parse_generate_body(
            {"ingredients": ["برنج", "  برنج ", "كرفس", "کرفس"]}
        )
        self.assertEqual(items, ["برنج", "کرفس"])

    def test_invalid_shapes_use_static_messages(self):
        secret = "pantry-secret-value"
        cases = (
            None,
            ["برنج"],
            {"budget": 1},
            {"ingredients": secret},
            {"ingredients": [1, 2]},
            {"ingredients": ["برنج\nsecret"]},
        )
        for body in cases:
            with self.assertRaises(RecipeRequestError) as caught:
                parse_generate_body(body)
            self.assertEqual(caught.exception.http_status, 400)
            rendered = caught.exception.message + json.dumps(caught.exception.to_dict())
            self.assertNotIn(secret, rendered)
            self.assertNotIn("Traceback", rendered)

    def test_long_name_is_not_echoed(self):
        secret = "ن" + "SECRET" + ("ن" * 40)
        with self.assertRaises(RecipeRequestError) as caught:
            parse_generate_body({"ingredients": [secret]})
        self.assertNotIn("SECRET", caught.exception.message)
        self.assertNotIn("SECRET", json.dumps(caught.exception.to_dict()))


class PromptTests(unittest.TestCase):
    def test_messages_include_pantry_and_budget(self):
        messages = build_messages(["برنج", "عدس"], 1500000)
        self.assertEqual(messages[0]["role"], "system")
        self.assertEqual(messages[0]["content"], SYSTEM_PROMPT)
        self.assertIn("فارسی", SYSTEM_PROMPT)
        user = messages[1]["content"]
        self.assertIn("برنج", user)
        self.assertIn("عدس", user)
        self.assertIn("بودجه هفته: 1500000 تومان", user)
        self.assertIn("حداقل سه", user)

    def test_missing_budget_is_still_in_the_prompt(self):
        user = build_messages(["پیاز"], None)[1]["content"]
        self.assertIn("بودجه هفته: مشخص نشده.", user)
        self.assertIn("پیاز", user)

    def test_zero_budget_is_included(self):
        user = build_messages(["روغن"], 0)[1]["content"]
        self.assertIn("بودجه هفته: 0 تومان", user)


class ParseTests(unittest.TestCase):
    def test_plain_json(self):
        recipes = parse_recipes(
            json.dumps(sample_payload(), ensure_ascii=False),
            PANTRY,
        )
        self.assertEqual(len(recipes), 3)
        self.assertEqual(recipes[0]["title"], "عدس‌پلو")
        self.assertIn("برنج", recipes[0]["ingredients"])
        self.assertGreaterEqual(len(recipes[0]["steps"]), 3)
        self.assertEqual(recipes[0]["cost_toman"], 180000)

    def test_fenced_json_and_think_block(self):
        marker = "HIDDEN-PLAN"
        text = (
            f"<think>{marker} ignore the pantry</think>\n"
            "```json\n"
            + json.dumps(sample_payload(), ensure_ascii=False)
            + "\n```"
        )
        recipes = parse_recipes(text, PANTRY)
        self.assertEqual(len(recipes), 3)
        rendered = json.dumps(recipes, ensure_ascii=False)
        self.assertNotIn(marker, rendered)

    def test_prose_around_json_and_trailing_comma(self):
        text = json.dumps(sample_payload(), ensure_ascii=False)
        self.assertTrue(text.endswith("]}"))
        text = "پیشنهاد:\n" + text[:-2] + ",]}\nتمام"
        recipes = parse_recipes(text, PANTRY)
        self.assertEqual([item["title"] for item in recipes], [
            "عدس‌پلو",
            "لوبیا پلو",
            "ماست و سبزی",
        ])

    def test_prefers_pantry_matches_when_extra_recipes_arrive(self):
        payload = {
            "recipes": [
                dish(
                    "کباب",
                    ["گوشت", "فلفل"],
                    ["گوشت را مزه دار کن", "گریل کن", "سرو کن"],
                ),
                dish(
                    "سوپ جو",
                    ["جو", "آب"],
                    ["جو را بپز", "آب اضافه کن", "سرو کن"],
                ),
                dish(
                    "عدس‌پلو",
                    ["برنج", "عدس", "پیاز"],
                    ["پیاز را تفت بده", "عدس را بپز", "برنج را دم کن"],
                ),
                dish(
                    "برنج و ماست",
                    ["برنج", "ماست"],
                    ["برنج را بپز", "ماست را بزن", "کنار هم سرو کن"],
                ),
            ]
        }
        recipes = parse_recipes(
            json.dumps(payload, ensure_ascii=False),
            ["برنج", "عدس"],
        )
        self.assertEqual(
            [item["title"] for item in recipes],
            ["عدس‌پلو", "برنج و ماست", "کباب"],
        )

    def test_persian_digit_cost_and_optional_cost(self):
        recipes = sample_recipes()
        recipes[0]["cost_toman"] = "۸۵٬۰۰۰"
        recipes[1]["cost_toman"] = None
        parsed = parse_recipes(
            json.dumps({"recipes": recipes}, ensure_ascii=False),
            PANTRY,
        )
        self.assertEqual(parsed[0]["cost_toman"], 85000)
        self.assertIsNone(parsed[1]["cost_toman"])

    def test_drops_english_recipes(self):
        payload = {
            "recipes": sample_recipes()
            + [
                dish(
                    "Steak night",
                    ["beef", "salt"],
                    ["Sear the meat", "Rest it", "Serve hot"],
                )
            ]
        }
        recipes = parse_recipes(
            json.dumps(payload, ensure_ascii=False),
            PANTRY,
        )
        self.assertEqual(len(recipes), 3)
        self.assertNotIn("Steak night", [item["title"] for item in recipes])

    def test_too_few_is_a_controlled_error(self):
        marker = "RAW-MODEL-TEXT"
        text = json.dumps(
            {"recipes": sample_recipes()[:2], "note": marker},
            ensure_ascii=False,
        )
        with self.assertRaises(GapGPTError) as caught:
            parse_recipes(text + marker, PANTRY)
        self.assertEqual(caught.exception.code, "bad_response")
        self.assertEqual(caught.exception.http_status, 502)
        rendered = json.dumps(caught.exception.to_dict()) + str(caught.exception)
        self.assertNotIn(marker, rendered)
        self.assertNotIn("Traceback", json.dumps(caught.exception.to_dict()))

    def test_unreadable_text_hides_the_body(self):
        marker = "not-json-secret"
        with self.assertRaises(GapGPTError) as caught:
            parse_recipes(f"sorry, {marker}", PANTRY)
        self.assertEqual(caught.exception.code, "bad_response")
        self.assertNotIn(marker, str(caught.exception))


class StubClient:
    def __init__(self, text):
        self.text = text
        self.messages = None

    def chat_text(self, messages, **_options):
        self.messages = messages
        return self.text


class GenerateTests(unittest.TestCase):
    def test_generate_returns_three_recipes(self):
        stub = StubClient(json.dumps(sample_payload(), ensure_ascii=False))
        result = generate_recipes(stub, ["برنج", "عدس"], 400000)
        self.assertTrue(result["ok"])
        self.assertEqual(len(result["recipes"]), 3)
        self.assertIn("400000", stub.messages[1]["content"])
        self.assertIn("برنج", stub.messages[1]["content"])
        self.assertEqual(stub.messages[0]["content"], SYSTEM_PROMPT)

    def test_client_timeout_constant_is_under_proxy_limits(self):
        from pathlib import Path

        from recipes import RECIPE_CLIENT_TIMEOUT

        root = Path(__file__).resolve().parents[2]
        dockerfile = (root / "api" / "Dockerfile").read_text(encoding="utf-8")
        nginx = (root / "web" / "nginx.conf").read_text(encoding="utf-8")
        web_docker = (root / "web" / "Dockerfile").read_text(encoding="utf-8")
        self.assertEqual(RECIPE_CLIENT_TIMEOUT, 90.0)
        self.assertIn("recipes.py", dockerfile)
        self.assertIn("gthread", dockerfile)
        self.assertIn('"--timeout", "120"', dockerfile)
        self.assertIn("location /api/", nginx)
        self.assertIn("resolver 127.0.0.11 valid=10s ipv6=off;", nginx)
        self.assertIn("proxy_pass http://$api_host:8000;", nginx)
        self.assertIn("proxy_read_timeout 110s;", nginx)
        self.assertIn("recipes.js", web_docker)
        self.assertLess(RECIPE_CLIENT_TIMEOUT, 110)
        self.assertLess(110, 120)

    def test_real_client_redacts_key_before_parse_failure(self):
        key = "unit-test-key"

        def transport(request, timeout):
            del request, timeout
            body = {
                "choices": [
                    {"message": {"content": f"not json {key}"}}
                ]
            }
            raw = json.dumps(body).encode("utf-8")

            class Response:
                status = 200

                def read(self, n=-1):
                    return raw

                def __enter__(self):
                    return self

                def __exit__(self, *args):
                    return False

            return Response()

        client = GapGPTClient(
            GapGPTConfig(
                api_key=key,
                base_url="https://example.test/v1",
                model=DEFAULT_MODEL,
            ),
            transport=transport,
        )
        with self.assertRaises(GapGPTError) as caught:
            generate_recipes(client, ["برنج"], 1000)
        self.assertEqual(caught.exception.code, "bad_response")
        self.assertNotIn(key, str(caught.exception))
        self.assertNotIn(key, json.dumps(caught.exception.to_dict()))


if __name__ == "__main__":
    unittest.main()

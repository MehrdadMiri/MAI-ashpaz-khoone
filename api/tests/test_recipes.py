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
    violates_diet,
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


class LeftoverRequestTests(unittest.TestCase):
    def test_remaining_and_skip_are_kept(self):
        parsed = parse_generate_body(
            {
                "ingredients": ["برنج", "عدس", "ماست"],
                "budget": 1500000,
                "remaining": ["ماست", "  ماست "],
                "skip": ["عدس پلو", "عدس‌پلو"],
                "full": False,
            }
        )
        self.assertEqual(parsed.ingredients, ["برنج", "عدس", "ماست"])
        self.assertEqual(parsed.budget, 1500000)
        self.assertEqual(parsed.remaining, ["ماست"])
        self.assertEqual(parsed.skip, ["عدس پلو"])
        self.assertFalse(parsed.full)
        items, budget = parsed
        self.assertEqual(items, ["برنج", "عدس", "ماست"])
        self.assertEqual(budget, 1500000)

    def test_empty_remaining_is_controlled(self):
        secret = "SECRET-DINNER"
        with self.assertRaises(RecipeRequestError) as caught:
            parse_generate_body(
                {
                    "ingredients": ["برنج"],
                    "remaining": [],
                    "skip": [secret],
                    "budget": 10,
                }
            )
        self.assertEqual(caught.exception.code, "no_remaining")
        self.assertEqual(caught.exception.http_status, 400)
        rendered = caught.exception.message + json.dumps(caught.exception.to_dict())
        self.assertNotIn(secret, rendered)
        self.assertNotIn("Traceback", rendered)

    def test_full_regenerate_allows_empty_remaining(self):
        parsed = parse_generate_body(
            {
                "ingredients": ["برنج", "ماست"],
                "remaining": [],
                "skip": ["عدس‌پلو"],
                "full": True,
                "budget": 0,
            }
        )
        self.assertTrue(parsed.full)
        self.assertEqual(parsed.remaining, [])
        self.assertEqual(parsed.skip, ["عدس‌پلو"])
        self.assertEqual(parsed.budget, 0)

    def test_bad_leftover_fields_do_not_echo_values(self):
        secret = "skip-secret-value"
        cases = (
            {"ingredients": ["برنج"], "full": secret},
            {"ingredients": ["برنج"], "remaining": secret},
            {"ingredients": ["برنج"], "skip": [secret + "\n"]},
            {"ingredients": ["برنج"], "skip": [1]},
            {"ingredients": ["برنج"], "remaining": ["ن" * 80]},
        )
        for body in cases:
            with self.assertRaises(RecipeRequestError) as caught:
                parse_generate_body(body)
            self.assertEqual(caught.exception.http_status, 400)
            rendered = caught.exception.message + json.dumps(caught.exception.to_dict())
            self.assertNotIn(secret, rendered)
            self.assertNotIn("Traceback", rendered)


class LeftoverPromptTests(unittest.TestCase):
    def test_leftover_prompt_prefers_remaining_and_skips_titles(self):
        messages = build_messages(
            ["برنج", "عدس", "ماست"],
            1500000,
            remaining=["ماست"],
            skip=["عدس‌پلو"],
        )
        self.assertEqual(messages[0]["content"], SYSTEM_PROMPT)
        self.assertIn("week budget", SYSTEM_PROMPT)
        user = messages[1]["content"]
        self.assertIn("مواد باقی‌مانده:", user)
        self.assertIn("\n- ماست", user)
        self.assertIn("وعده‌های خورده‌شده:", user)
        self.assertIn("عدس‌پلو", user)
        self.assertIn("نباید تکرار شوند", user)
        self.assertIn("بودجه هفته: 1500000 تومان", user)
        self.assertIn("دستورها را بیشتر با مواد باقی‌مانده بساز.", user)

    def test_same_remaining_list_does_not_duplicate_the_pantry(self):
        user = build_messages(
            ["برنج"],
            None,
            remaining=["برنج"],
            skip=["سوپ جو"],
        )[1]["content"]
        self.assertEqual(user.count("\n- برنج"), 1)
        self.assertNotIn("مواد باقی‌مانده:", user)
        self.assertIn("سوپ جو", user)
        self.assertIn("بودجه هفته: مشخص نشده.", user)

    def test_full_prompt_ignores_leftover_skip(self):
        user = build_messages(
            ["برنج", "ماست"],
            400000,
            remaining=["ماست"],
            skip=["عدس‌پلو"],
            full=True,
        )[1]["content"]
        self.assertIn("بازتولید کامل:", user)
        self.assertIn("بودجه هفته: 400000 تومان", user)
        self.assertIn("برنج", user)
        self.assertIn("ماست", user)
        self.assertNotIn("عدس‌پلو", user)
        self.assertNotIn("وعده‌های خورده‌شده:", user)
        self.assertNotIn("مواد باقی‌مانده:", user)


class LeftoverParseTests(unittest.TestCase):
    def test_skip_drops_eaten_titles_including_spelling_variants(self):
        extra = dish(
            "کوکو سبزی",
            ["سبزی", "تخم‌مرغ"],
            ["سبزی را خرد کن", "تخم‌مرغ را بزن", "سرخ کن"],
            110000,
        )
        variant = dish(
            "عدس‌پلو با کشمش",
            ["برنج", "عدس"],
            ["عدس را بپز", "برنج را دم کن", "کشمش را اضافه کن"],
        )
        payload = {"recipes": sample_recipes() + [extra, variant]}
        recipes = parse_recipes(
            json.dumps(payload, ensure_ascii=False),
            ["ماست", "روغن"],
            skip=["عدس پلو"],
        )
        titles = [item["title"] for item in recipes]
        self.assertEqual(len(titles), 3)
        self.assertNotIn("عدس‌پلو", titles)
        self.assertNotIn("عدس‌پلو با کشمش", titles)
        self.assertIn("ماست و سبزی", titles)

    def test_too_few_after_skip_hides_the_title(self):
        marker = "SECRET-DINNER"
        payload = {
            "recipes": [
                dish(marker, ["برنج"], ["برنج را بپز", "دم کن", "سرو کن"]),
                dish(
                    "لوبیا پلو",
                    ["برنج", "لوبیا"],
                    ["لوبیا را بپز", "برنج را دم کن", "سرو کن"],
                ),
            ]
        }
        with self.assertRaises(GapGPTError) as caught:
            parse_recipes(json.dumps(payload, ensure_ascii=False), PANTRY, skip=[marker])
        self.assertEqual(caught.exception.code, "bad_response")
        rendered = json.dumps(caught.exception.to_dict()) + str(caught.exception)
        self.assertNotIn(marker, rendered)


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

    def test_leftover_generate_skips_used_dinners(self):
        extra = dish(
            "کوکو سبزی",
            ["سبزی", "تخم‌مرغ"],
            ["سبزی را خرد کن", "تخم‌مرغ را بزن", "سرخ کن"],
            110000,
        )
        stub = StubClient(json.dumps({"recipes": sample_recipes() + [extra]}, ensure_ascii=False))
        result = generate_recipes(
            stub,
            ["برنج", "عدس", "ماست"],
            1500000,
            remaining=["ماست"],
            skip=["عدس‌پلو"],
        )
        self.assertEqual(result["mode"], "leftovers")
        titles = [item["title"] for item in result["recipes"]]
        self.assertEqual(len(titles), 3)
        self.assertNotIn("عدس‌پلو", titles)
        user = stub.messages[1]["content"]
        self.assertIn("مواد باقی‌مانده:", user)
        self.assertIn("عدس‌پلو", user)
        self.assertIn("بودجه هفته: 1500000 تومان", user)

    def test_full_generate_ignores_skip(self):
        stub = StubClient(json.dumps(sample_payload(), ensure_ascii=False))
        result = generate_recipes(
            stub,
            ["برنج", "عدس", "ماست"],
            1500000,
            remaining=["ماست"],
            skip=["عدس‌پلو"],
            full=True,
        )
        self.assertEqual(result["mode"], "full")
        self.assertEqual(result["recipes"][0]["title"], "عدس‌پلو")
        user = stub.messages[1]["content"]
        self.assertIn("بازتولید کامل:", user)
        self.assertIn("بودجه هفته: 1500000 تومان", user)
        self.assertNotIn("عدس‌پلو", user)
        self.assertNotIn("وعده‌های خورده‌شده:", user)


class DietFilterTests(unittest.TestCase):
    def test_missing_filters_are_off_and_absent_from_the_user_prompt(self):
        parsed = parse_generate_body({"ingredients": ["برنج"], "budget": 10})
        self.assertEqual(
            parsed.filters,
            {"vegetarian": False, "no_onion": False, "diabetic": False},
        )
        user = build_messages(["برنج"], 10)[1]["content"]
        self.assertNotIn("محدودیت غذایی", user)
        self.assertIn("محدودیت غذایی", SYSTEM_PROMPT)

    def test_null_filters_are_off(self):
        parsed = parse_generate_body({"ingredients": ["برنج"], "filters": None})
        self.assertFalse(any(parsed.filters.values()))

    def test_combination_is_parsed_and_written_into_the_prompt(self):
        parsed = parse_generate_body(
            {
                "ingredients": ["برنج", "ماست"],
                "budget": 1500000,
                "full": True,
                "filters": {
                    "vegetarian": True,
                    "no_onion": True,
                    "diabetic": False,
                    "vegan": True,
                },
            }
        )
        self.assertEqual(
            parsed.filters,
            {"vegetarian": True, "no_onion": True, "diabetic": False},
        )
        user = build_messages(
            ["برنج", "ماست"],
            1500000,
            full=True,
            filters=parsed.filters,
        )[1]["content"]
        self.assertIn("محدودیت غذایی:", user)
        self.assertIn("- گیاهی:", user)
        self.assertIn("- بدون پیاز:", user)
        self.assertNotIn("- مناسب دیابت:", user)
        self.assertIn("بازتولید کامل:", user)
        self.assertIn("بر فهرست مواد آشپزخانه مقدم", user)
        self.assertIn("گیاهی", SYSTEM_PROMPT)
        self.assertIn("بدون پیاز", SYSTEM_PROMPT)
        self.assertIn("مناسب دیابت", SYSTEM_PROMPT)

    def test_bad_filter_type_is_static(self):
        secret = "filter-secret-value"
        with self.assertRaises(RecipeRequestError) as caught:
            parse_generate_body(
                {"ingredients": ["برنج"], "filters": {"vegetarian": secret}}
            )
        self.assertEqual(caught.exception.code, "invalid_request")
        rendered = caught.exception.message + json.dumps(caught.exception.to_dict())
        self.assertNotIn(secret, rendered)
        with self.assertRaises(RecipeRequestError) as listed:
            parse_generate_body({"ingredients": ["برنج"], "filters": [secret]})
        self.assertNotIn(secret, listed.exception.message)

    def test_obvious_meat_is_dropped_when_three_remain(self):
        payload = {
            "recipes": [
                dish("کباب مرغ", ["مرغ", "برنج"], ["مرغ را بپز", "برنج را دم کن", "سرو کن"]),
                dish("عدس‌پلو", ["برنج", "عدس"], ["عدس را بپز", "برنج را دم کن", "سرو کن"]),
                dish("ماست و سبزی", ["ماست", "سبزی"], ["ماست را هم بزن", "سبزی را خرد کن", "سرو کن"]),
                dish("خوراک لوبیا", ["لوبیا", "روغن"], ["لوبیا را بپز", "روغن اضافه کن", "سرو کن"]),
            ]
        }
        recipes = parse_recipes(
            json.dumps(payload, ensure_ascii=False),
            ["برنج", "عدس", "لوبیا", "ماست"],
            filters={"vegetarian": True},
        )
        titles = [item["title"] for item in recipes]
        self.assertEqual(len(titles), 3)
        self.assertNotIn("کباب مرغ", titles)

    def test_egg_is_allowed_for_vegetarian(self):
        payload = {
            "recipes": [
                dish(
                    "کوکو سبزی",
                    ["تخم‌مرغ", "سبزی"],
                    ["سبزی را خرد کن", "با تخم‌مرغ مخلوط کن", "سرخ کن"],
                ),
                dish("عدس‌پلو", ["برنج", "عدس"], ["عدس را بپز", "برنج را دم کن", "سرو کن"]),
                dish("ماست و خیار", ["ماست", "خیار"], ["ماست را هم بزن", "خیار را اضافه کن", "سرد سرو کن"]),
            ]
        }
        recipes = parse_recipes(
            json.dumps(payload, ensure_ascii=False),
            ["برنج", "عدس", "ماست"],
            filters={"vegetarian": True},
        )
        self.assertIn("کوکو سبزی", [item["title"] for item in recipes])

    def test_onion_in_steps_is_dropped_when_alternatives_exist(self):
        payload = {
            "recipes": [
                dish("عدس‌پلو", ["برنج", "عدس"], ["پیاز را تفت بده", "عدس را بپز", "برنج را دم کن"]),
                dish("لوبیا پلو", ["برنج", "لوبیا"], ["لوبیا را بپز", "برنج را دم کن", "سرو کن"]),
                dish("ماست و سبزی", ["ماست", "سبزی"], ["ماست را هم بزن", "سبزی را خرد کن", "سرو کن"]),
                dish("خوراک کدو", ["کدو", "روغن"], ["کدو را بپز", "روغن اضافه کن", "سرو کن"]),
            ]
        }
        recipes = parse_recipes(
            json.dumps(payload, ensure_ascii=False),
            ["برنج", "عدس", "لوبیا", "ماست"],
            filters={"no_onion": True},
        )
        self.assertNotIn("عدس‌پلو", [item["title"] for item in recipes])
        self.assertEqual(len(recipes), 3)

    def test_too_few_clean_recipes_still_returns_three(self):
        recipes = parse_recipes(
            json.dumps(sample_payload(), ensure_ascii=False),
            PANTRY,
            filters={"vegetarian": True, "no_onion": True, "diabetic": True},
        )
        self.assertEqual(len(recipes), 3)

    def test_diabetic_drops_sugar_and_ignores_blood_sugar_wording(self):
        payload = {
            "recipes": [
                dish("شربت", ["شکر", "آب"], ["شکر را حل کن", "سرد کن", "سرو کن"]),
                dish("عدس‌پلو", ["برنج", "عدس"], ["عدس را بپز", "برنج را دم کن", "سرو کن"]),
                dish("ماست و سبزی", ["ماست", "سبزی"], ["ماست را هم بزن", "سبزی را خرد کن", "سرو کن"]),
                dish("خوراک لوبیا", ["لوبیا"], ["لوبیا را بپز", "نمک بزن", "سرو کن"]),
            ]
        }
        recipes = parse_recipes(
            json.dumps(payload, ensure_ascii=False),
            ["برنج", "عدس", "لوبیا", "ماست"],
            filters={"diabetic": True},
        )
        self.assertNotIn("شربت", [item["title"] for item in recipes])
        blood = dish(
            "عدس‌پلو",
            ["برنج", "عدس"],
            ["عدس را بپز", "برای قند خون مناسب است", "سرو کن"],
        )
        self.assertFalse(violates_diet(blood, {"diabetic": True}))

    def test_negation_does_not_count_as_meat(self):
        recipe = dish(
            "خوراک سبزی",
            ["سبزی", "روغن"],
            ["بدون گوشت بپز", "روغن اضافه کن", "سرو کن"],
        )
        self.assertFalse(violates_diet(recipe, {"vegetarian": True}))
        self.assertTrue(
            violates_diet(
                dish("کباب", ["گوشت"], ["گوشت را بپز", "برگردان", "سرو کن"]),
                {"vegetarian": True},
            )
        )

    def test_generate_includes_filters_and_gapgpt_errors_still_raise(self):
        stub = StubClient(json.dumps(sample_payload(), ensure_ascii=False))
        filters = {"vegetarian": True, "no_onion": False, "diabetic": True}
        result = generate_recipes(stub, ["برنج", "عدس", "ماست"], 1000, filters=filters)
        self.assertEqual(result["filters"], filters)
        self.assertEqual(len(result["recipes"]), 3)
        user = stub.messages[1]["content"]
        self.assertIn("- گیاهی:", user)
        self.assertIn("- مناسب دیابت:", user)
        self.assertNotIn("- بدون پیاز:", user)

        class Boom:
            def chat_text(self, messages, **_options):
                del messages, _options
                raise GapGPTError("timeout", "timed out", http_status=504)

        with self.assertRaises(GapGPTError) as caught:
            generate_recipes(Boom(), ["برنج"], 10, filters=filters)
        self.assertEqual(caught.exception.code, "timeout")


if __name__ == "__main__":
    unittest.main()

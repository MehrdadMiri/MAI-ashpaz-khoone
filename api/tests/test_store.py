"""Pantry and plan storage. No network. Postgres tests skip when the server is down."""

import logging
import os
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

import store

ROOT = Path(__file__).resolve().parents[2]
USER = "local-user-demo1"


def recipe(title="عدس‌پلو", ingredients=None, steps=None, cost=180000):
    return {
        "title": title,
        "ingredients": ["برنج", "عدس"] if ingredients is None else ingredients,
        "steps": ["بپز"] if steps is None else steps,
        "cost_toman": cost,
    }


class SanitizeTests(unittest.TestCase):
    def test_arabic_and_persian_pantry_names_collapse(self):
        pantry = store.sanitize_pantry(
            {"items": ["  سيب زميني ", "سیب‌زمینی", "كرفس", "کرفس", ""], "budget": "۱۲۳"}
        )
        self.assertEqual(pantry["items"], ["سیب زمینی", "کرفس"])
        self.assertEqual(pantry["budget"], "123")
        self.assertEqual(store.identity_key("عدس‌پلو"), "عدسپلو")

    def test_invalid_budget_and_long_names_are_dropped(self):
        pantry = store.sanitize_pantry(
            {
                "items": ["ن" * 41, "برنج", 12, "برنج"],
                "budget": "nope",
            }
        )
        self.assertEqual(pantry["items"], ["برنج"])
        self.assertEqual(pantry["budget"], "")
        self.assertEqual(
            pantry["filters"],
            {"vegetarian": False, "no_onion": False, "diabetic": False},
        )
        self.assertEqual(store.sanitize_budget(1_000_000_000_001), "")
        self.assertEqual(store.sanitize_budget(0), "0")
        self.assertEqual(store.sanitize_budget("1,500"), "1500")

    def test_diet_filters_keep_only_real_trues(self):
        pantry = store.sanitize_pantry(
            {
                "items": ["برنج"],
                "budget": "10",
                "filters": {
                    "vegetarian": True,
                    "no_onion": "yes",
                    "diabetic": 1,
                    "extra": True,
                },
            }
        )
        self.assertEqual(
            pantry["filters"],
            {"vegetarian": True, "no_onion": False, "diabetic": False},
        )
        missing = store.sanitize_pantry({"items": ["ماست"]})
        self.assertFalse(any(missing["filters"].values()))
        self.assertEqual(missing["household"], 4)

    def test_household_defaults_to_four_and_servings_stay_on_the_recipe(self):
        pantry = store.sanitize_pantry({"items": ["برنج"], "household": "۸"})
        self.assertEqual(pantry["household"], 8)
        junk = store.sanitize_pantry({"items": ["برنج"], "household": "nope"})
        self.assertEqual(junk["household"], 4)
        wide = store.sanitize_pantry({"items": ["برنج"], "household": 99})
        self.assertEqual(wide["household"], 4)
        self.assertEqual(store.sanitize_household(True), 4)

        plan = store.sanitize_plan(
            {
                "recipes": [
                    {
                        "title": "عدس‌پلو",
                        "ingredients": ["۲۰۰ گرم برنج"],
                        "steps": ["بپز"],
                        "cost_toman": 10,
                        "servings": 8,
                    }
                ]
            }
        )
        self.assertEqual(plan["recipes"][0]["servings"], 8)
        self.assertEqual(plan["recipes"][0]["ingredients"], ["۲۰۰ گرم برنج"])
        self.assertEqual(plan["recipes"][0]["cost_toman"], 10)
        dropped = store.sanitize_plan(
            {
                "recipes": [
                    {
                        "title": "سوپ",
                        "ingredients": ["آب"],
                        "steps": ["بپز"],
                        "servings": 0,
                    }
                ]
            }
        )
        self.assertNotIn("servings", dropped["recipes"][0])

    def test_plan_keeps_an_eaten_day_and_recomputes_ids(self):
        plan = store.sanitize_plan(
            {
                "recipes": [recipe("كباب", ["پیاز"], ["بپز"], 10)],
                "slots": {"fri": "r:کباب", "sat": "missing", "nope": "r:کباب"},
                "used": {"fri": True, "sat": True},
            }
        )
        self.assertEqual(plan["recipes"][0]["title"], "کباب")
        self.assertEqual(plan["recipes"][0]["id"], "r:کباب")
        self.assertEqual(plan["slots"]["fri"]["dinner"], "r:کباب")
        self.assertIsNone(plan["slots"]["fri"]["breakfast"])
        self.assertIsNone(plan["slots"]["fri"]["lunch"])
        self.assertTrue(plan["used"]["fri"]["dinner"])
        self.assertFalse(plan["used"]["fri"]["breakfast"])
        self.assertIsNone(plan["slots"]["sat"]["dinner"])
        self.assertFalse(plan["used"]["sat"]["dinner"])
        self.assertNotIn("nope", plan["slots"])

    def test_plan_keeps_breakfast_lunch_and_dinner(self):
        plan = store.sanitize_plan(
            {
                "recipes": [
                    recipe("املت", ["تخم‌مرغ"]),
                    recipe("کتلت", ["گوشت"]),
                    recipe("عدس‌پلو", ["برنج"]),
                ],
                "slots": {
                    "sat": {
                        "breakfast": "r:املت",
                        "lunch": "r:کتلت",
                        "dinner": "r:عدسپلو",
                        "snack": "r:املت",
                    }
                },
                "used": {"sat": {"breakfast": True, "lunch": False, "dinner": True}},
            }
        )
        self.assertEqual(plan["slots"]["sat"]["breakfast"], "r:املت")
        self.assertEqual(plan["slots"]["sat"]["lunch"], "r:کتلت")
        self.assertEqual(plan["slots"]["sat"]["dinner"], "r:عدسپلو")
        self.assertNotIn("snack", plan["slots"]["sat"])
        self.assertTrue(plan["used"]["sat"]["breakfast"])
        self.assertFalse(plan["used"]["sat"]["lunch"])
        self.assertTrue(plan["used"]["sat"]["dinner"])
        self.assertIsNone(plan["slots"]["sun"]["breakfast"])

    def test_assigned_recipes_survive_the_catalog_cap(self):
        recipes = [recipe("ثابت")]
        recipes.extend(recipe("غذا %d" % index) for index in range(30))
        plan = store.sanitize_plan(
            {
                "recipes": recipes,
                "slots": {"sat": "r:ثابت"},
                "used": {"sat": False},
            }
        )
        self.assertLessEqual(len(plan["recipes"]), store.MAX_RECIPES)
        self.assertEqual(plan["slots"]["sat"]["dinner"], "r:ثابت")
        self.assertIsNone(plan["slots"]["sat"]["lunch"])
        self.assertTrue(any(item["title"] == "ثابت" for item in plan["recipes"]))

    def test_secret_is_rejected_and_not_echoed(self):
        secret = "pantry-secret-value"
        with patch.dict(os.environ, {"GAP_CODE_API_KEY": secret}):
            with self.assertRaises(store.StoreError) as caught:
                store.prepare_pantry({"items": ["برنج", secret], "budget": ""})
        self.assertEqual(caught.exception.code, "invalid_request")
        self.assertNotIn(secret, caught.exception.message)
        self.assertNotIn(secret, str(caught.exception.to_dict()))

    def test_user_id_rules(self):
        self.assertEqual(store.require_user_id("  local-user-demo1  "), USER)
        with self.assertRaises(store.StoreError) as caught:
            store.require_user_id("short")
        self.assertEqual(caught.exception.code, "invalid_user")
        self.assertNotIn("short", caught.exception.message)
        with self.assertRaises(store.StoreError) as missing:
            store.user_id_from_request(FakeRequest(), None)
        self.assertEqual(missing.exception.code, "missing_user")


class FakeRequest:
    def __init__(self, header=None, query=None, body=None):
        self.headers = {"X-Local-User-Id": header} if header is not None else {}
        self.args = {"local_user_id": query} if query is not None else {}
        self._body = body
        self.method = "PUT" if body is not None else "GET"

    def get_json(self, silent=True):
        return self._body


class FakeConn:
    def __init__(self):
        self.statements = []

    def execute(self, sql, params=None):
        self.statements.append(sql)
        return self

    def fetchone(self):
        return (1,)

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


class SchemaTests(unittest.TestCase):
    def tearDown(self):
        store.reset_schema_ready()

    def test_ping_applies_the_migration_once(self):
        store.reset_schema_ready()
        first = FakeConn()
        with patch("store.connect", return_value=first):
            self.assertTrue(store.ping())
        text = "\n".join(first.statements)
        self.assertIn("CREATE TABLE IF NOT EXISTS pantry_state", text)
        self.assertIn("CREATE TABLE IF NOT EXISTS week_plan_state", text)
        self.assertIn("SELECT 1", text)

        second = FakeConn()
        with patch("store.connect", return_value=second):
            self.assertTrue(store.ping())
        self.assertEqual(second.statements, ["SELECT 1"])

    def test_database_errors_log_the_class_only(self):
        store.reset_schema_ready()
        secret = "database-secret-value"
        records = []

        class ListHandler(logging.Handler):
            def emit(self, record):
                records.append(self.format(record))

        handler = ListHandler()
        store.logger.addHandler(handler)
        try:
            with patch("store.connect", side_effect=RuntimeError("برنج " + secret)):
                self.assertFalse(store.ping())
        finally:
            store.logger.removeHandler(handler)
        text = "\n".join(records)
        self.assertIn("RuntimeError", text)
        self.assertNotIn(secret, text)
        self.assertNotIn("برنج", text)

    def test_compose_mounts_the_migration(self):
        compose = (ROOT / "docker-compose.yml").read_text(encoding="utf-8")
        dockerfile = (ROOT / "api" / "Dockerfile").read_text(encoding="utf-8")
        sql_path = ROOT / "api" / "migrations" / "001_kitchen_state.sql"
        sql = sql_path.read_text(encoding="utf-8")
        self.assertIn("pgdata:/var/lib/postgresql/data", compose)
        self.assertIn(
            "./api/migrations/001_kitchen_state.sql:/docker-entrypoint-initdb.d/001_kitchen_state.sql:ro",
            compose,
        )
        self.assertIn("store.py", dockerfile)
        self.assertIn("migrations", dockerfile)
        self.assertIn("CREATE TABLE IF NOT EXISTS pantry_state", sql)
        self.assertIn("CREATE TABLE IF NOT EXISTS week_plan_state", sql)
        self.assertNotIn("GAP_CODE_API_KEY", sql)
        source = (ROOT / "api" / "store.py").read_text(encoding="utf-8")
        self.assertIn("WHERE local_user_id = %s", source)
        self.assertNotIn("f\"SELECT", source)


def postgres_settings():
    return {
        "POSTGRES_HOST": os.environ.get("ASHPAZ_TEST_POSTGRES_HOST", "127.0.0.1"),
        "POSTGRES_PORT": os.environ.get("ASHPAZ_TEST_POSTGRES_PORT", "5432"),
        "POSTGRES_USER": os.environ.get("POSTGRES_USER", "ashpaz"),
        "POSTGRES_PASSWORD": os.environ.get("POSTGRES_PASSWORD", "change-me"),
        "POSTGRES_DB": os.environ.get("POSTGRES_DB", "ashpaz"),
    }


class PostgresKitchenTests(unittest.TestCase):
    def setUp(self):
        self._env = patch.dict(os.environ, postgres_settings(), clear=False)
        self._env.start()
        store.reset_schema_ready()
        try:
            with store.connect() as conn:
                conn.execute("SELECT 1")
        except Exception as exc:
            self._env.stop()
            self.skipTest("postgres unavailable (" + exc.__class__.__name__ + ")")
        self.user = "tst" + uuid.uuid4().hex
        self.kitchen = store.PostgresKitchen()

    def tearDown(self):
        try:
            with store.connect() as conn:
                conn.execute("DELETE FROM pantry_state WHERE local_user_id LIKE 'tst%'")
                conn.execute("DELETE FROM week_plan_state WHERE local_user_id LIKE 'tst%'")
        except Exception:
            pass
        self._env.stop()
        store.reset_schema_ready()

    def test_pantry_and_plan_roundtrip_without_cross_talk(self):
        other = "tst" + uuid.uuid4().hex
        saved = self.kitchen.save_pantry(
            self.user,
            {"items": ["برنج", "كرفس"], "budget": "1500000"},
        )
        self.assertTrue(saved["found"])
        self.assertEqual(saved["pantry"]["items"], ["برنج", "کرفس"])
        self.assertIsInstance(saved["updated_at"], str)

        missing_plan = self.kitchen.load_plan(self.user)
        self.assertFalse(missing_plan["found"])

        plan = self.kitchen.save_plan(
            self.user,
            {
                "recipes": [recipe()],
                "slots": {"sat": "r:عدسپلو"},
                "used": {"sat": True},
            },
        )
        self.assertEqual(plan["plan"]["slots"]["sat"]["dinner"], "r:عدسپلو")
        self.assertIsNone(plan["plan"]["slots"]["sat"]["breakfast"])
        self.assertTrue(plan["plan"]["used"]["sat"]["dinner"])
        self.assertEqual(plan["plan"]["recipes"][0]["ingredients"], ["برنج", "عدس"])

        again = self.kitchen.load_pantry(self.user)
        self.assertEqual(again["pantry"]["items"], ["برنج", "کرفس"])
        self.assertEqual(again["pantry"]["budget"], "1500000")
        self.assertFalse(self.kitchen.load_pantry(other)["found"])
        self.assertFalse(self.kitchen.load_plan(other)["found"])

        cleared = self.kitchen.save_pantry(self.user, {"items": [], "budget": "1500000"})
        self.assertEqual(cleared["pantry"]["items"], [])
        self.assertEqual(self.kitchen.load_plan(self.user)["plan"]["slots"]["sat"]["dinner"], "r:عدسپلو")


if __name__ == "__main__":
    unittest.main()

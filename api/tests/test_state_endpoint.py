"""Flask tests for pantry and plan persistence. The default suite uses memory."""

import logging
import os
import unittest
import uuid
from unittest.mock import patch

import app as app_module
import store

USER = "local-user-demo1"
OTHER = "local-user-demo2"
KEY = "unit-test-key-value"


def pantry_body(items=None, budget=""):
    return {"pantry": {"items": ["برنج"] if items is None else items, "budget": budget}}


def plan_body():
    return {
        "plan": {
            "recipes": [
                {
                    "title": "عدس‌پلو",
                    "ingredients": ["برنج", "۲۰۰ گرم گوشت"],
                    "steps": ["بپز"],
                    "cost_toman": 10,
                }
            ],
            "slots": {"sat": "r:عدسپلو"},
            "used": {"sat": True},
        }
    }


class EndpointTests(unittest.TestCase):
    def setUp(self):
        self.memory = store.MemoryKitchen()
        self.patcher = patch("store.get_store", return_value=self.memory)
        self.patcher.start()
        self.client = app_module.app.test_client()

    def tearDown(self):
        self.patcher.stop()

    def test_missing_and_invalid_user_are_static_errors(self):
        missing = self.client.get("/pantry")
        self.assertEqual(missing.status_code, 400)
        self.assertEqual(missing.get_json()["error"], "missing_user")

        huge = "x" * 80
        invalid = self.client.get("/plan", headers={"X-Local-User-Id": huge})
        self.assertEqual(invalid.status_code, 400)
        self.assertEqual(invalid.get_json()["error"], "invalid_user")
        self.assertNotIn(huge, invalid.get_data(as_text=True))

        post = self.client.post("/pantry", json=pantry_body())
        self.assertEqual(post.status_code, 405)
        self.assertEqual(post.get_json()["error"], "method_not_allowed")

    def test_pantry_roundtrip_prefers_the_header_and_the_api_prefix(self):
        saved = self.client.put(
            "/pantry?local_user_id=" + OTHER,
            headers={"X-Local-User-Id": USER},
            json=pantry_body(["كرفس", "کرفس"], "1500"),
        )
        self.assertEqual(saved.status_code, 200)
        body = saved.get_json()
        self.assertTrue(body["found"])
        self.assertEqual(
            body["pantry"],
            {
                "items": ["کرفس"],
                "budget": "1500",
                "filters": {"vegetarian": False, "no_onion": False, "diabetic": False},
                "household": 4,
            },
        )
        self.assertNotIn(KEY, saved.get_data(as_text=True))

        loaded = self.client.get("/api/pantry", headers={"X-Local-User-Id": USER})
        self.assertEqual(loaded.status_code, 200)
        self.assertEqual(loaded.get_json()["pantry"]["items"], ["کرفس"])

        other = self.client.get("/pantry", query_string={"local_user_id": OTHER})
        self.assertFalse(other.get_json()["found"])
        self.assertEqual(other.get_json()["pantry"]["items"], [])

        empty_plan = self.client.get("/plan", headers={"X-Local-User-Id": USER})
        self.assertFalse(empty_plan.get_json()["found"])

    def test_pantry_roundtrip_keeps_diet_filters(self):
        saved = self.client.put(
            "/pantry",
            headers={"X-Local-User-Id": USER},
            json={
                "pantry": {
                    "items": ["برنج"],
                    "budget": "10",
                    "filters": {
                        "vegetarian": True,
                        "no_onion": True,
                        "diabetic": False,
                        "extra": True,
                    },
                }
            },
        )
        self.assertEqual(saved.status_code, 200)
        self.assertEqual(
            saved.get_json()["pantry"]["filters"],
            {"vegetarian": True, "no_onion": True, "diabetic": False},
        )
        loaded = self.client.get("/pantry", headers={"X-Local-User-Id": USER})
        self.assertEqual(loaded.get_json()["pantry"]["filters"]["no_onion"], True)
        self.assertNotIn("extra", loaded.get_data(as_text=True))

    def test_plan_roundtrip_keeps_the_eaten_flag(self):
        saved = self.client.put(
            "/api/plan",
            headers={"X-Local-User-Id": USER},
            json=plan_body(),
        )
        self.assertEqual(saved.status_code, 200)
        plan = saved.get_json()["plan"]
        self.assertEqual(plan["slots"]["sat"]["dinner"], "r:عدسپلو")
        self.assertIsNone(plan["slots"]["sat"]["breakfast"])
        self.assertTrue(plan["used"]["sat"]["dinner"])
        self.assertEqual(plan["recipes"][0]["ingredients"], ["برنج", "۲۰۰ گرم گوشت"])

        loaded = self.client.get("/plan", headers={"X-Local-User-Id": USER})
        self.assertEqual(loaded.get_json()["plan"]["used"]["sat"]["dinner"], True)
        self.assertFalse(self.client.get("/pantry", headers={"X-Local-User-Id": USER}).get_json()["found"])

    def test_bad_json_and_secret_are_not_stored(self):
        bad = self.client.put(
            "/pantry",
            data="not-json",
            headers={"Content-Type": "application/json", "X-Local-User-Id": USER},
        )
        self.assertEqual(bad.status_code, 400)
        self.assertEqual(bad.get_json()["error"], "invalid_request")

        missing = self.client.put(
            "/plan",
            headers={"X-Local-User-Id": USER},
            json={"local_user_id": USER},
        )
        self.assertEqual(missing.status_code, 400)
        self.assertEqual(missing.get_json()["error"], "invalid_plan")

        with patch.dict(os.environ, {"GAP_CODE_API_KEY": KEY}):
            rejected = self.client.put(
                "/pantry",
                headers={"X-Local-User-Id": USER},
                json=pantry_body([KEY], ""),
            )
        self.assertEqual(rejected.status_code, 400)
        self.assertEqual(rejected.get_json()["error"], "invalid_request")
        text = rejected.get_data(as_text=True)
        self.assertNotIn(KEY, text)
        self.assertFalse(self.memory.pantries)

    def test_database_failure_hides_the_payload(self):
        class Boom(store.PostgresKitchen):
            def save_pantry(self, user_id, pantry):
                raise RuntimeError("برنج " + KEY)

        records = []

        class ListHandler(logging.Handler):
            def emit(self, record):
                records.append(self.format(record))

        handler = ListHandler()
        app_module.app.logger.addHandler(handler)
        try:
            with patch("store.get_store", return_value=Boom()):
                res = self.client.put(
                    "/pantry",
                    headers={"X-Local-User-Id": USER},
                    json=pantry_body(["برنج"], "10"),
                )
        finally:
            app_module.app.logger.removeHandler(handler)
        self.assertEqual(res.status_code, 500)
        self.assertEqual(res.get_json()["error"], "internal_error")
        text = res.get_data(as_text=True) + "\n".join(records)
        self.assertNotIn(KEY, text)
        self.assertNotIn("برنج", text)
        self.assertTrue(any("RuntimeError" in line for line in records))

    def test_root_lists_the_state_routes(self):
        body = self.client.get("/").get_json()
        self.assertEqual(body["pantry"], "/pantry")
        self.assertEqual(body["plan"], "/plan")


class PostgresEndpointTests(unittest.TestCase):
    def setUp(self):
        self._env = patch.dict(
            os.environ,
            {
                "POSTGRES_HOST": os.environ.get("ASHPAZ_TEST_POSTGRES_HOST", "127.0.0.1"),
                "POSTGRES_PORT": os.environ.get("ASHPAZ_TEST_POSTGRES_PORT", "5432"),
                "POSTGRES_USER": os.environ.get("POSTGRES_USER", "ashpaz"),
                "POSTGRES_PASSWORD": os.environ.get("POSTGRES_PASSWORD", "change-me"),
                "POSTGRES_DB": os.environ.get("POSTGRES_DB", "ashpaz"),
                "GAP_CODE_API_KEY": "",
            },
            clear=False,
        )
        self._env.start()
        store.reset_schema_ready()
        try:
            with store.connect() as conn:
                conn.execute("SELECT 1")
        except Exception as exc:
            self._env.stop()
            self.skipTest("postgres unavailable (" + exc.__class__.__name__ + ")")
        self.client = app_module.app.test_client()
        self.user = "tst" + uuid.uuid4().hex

    def tearDown(self):
        try:
            with store.connect() as conn:
                conn.execute("DELETE FROM pantry_state WHERE local_user_id LIKE 'tst%'")
                conn.execute("DELETE FROM week_plan_state WHERE local_user_id LIKE 'tst%'")
        except Exception:
            pass
        self._env.stop()
        store.reset_schema_ready()

    def test_health_and_refresh_use_postgres(self):
        health = self.client.get("/health")
        self.assertEqual(health.status_code, 200)
        body = health.get_json()
        self.assertEqual(body["database"], "ok")
        text = health.get_data(as_text=True)
        self.assertNotIn("change-me", text)
        self.assertNotIn("GAP_CODE_API_KEY", text)

        saved = self.client.put(
            "/api/pantry",
            headers={"X-Local-User-Id": self.user},
            json=pantry_body(["پیاز"], "20"),
        )
        self.assertEqual(saved.status_code, 200)
        loaded = self.client.get("/pantry", headers={"X-Local-User-Id": self.user})
        self.assertEqual(
            loaded.get_json()["pantry"],
            {
                "items": ["پیاز"],
                "budget": "20",
                "filters": {"vegetarian": False, "no_onion": False, "diabetic": False},
                "household": 4,
            },
        )
        self.assertNotIn("change-me", loaded.get_data(as_text=True))


if __name__ == "__main__":
    unittest.main()

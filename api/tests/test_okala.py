"""Okala price parsing, matching, and refresh. No live network unless flagged."""

import json
import os
import unittest
from datetime import timedelta, timezone
from unittest.mock import patch

import okala
import store

ROOT_FIXTURE = okala.FIXTURE_PATH


def product(name, price, ok_price=None, stock=True, product_id=1):
    raw = {
        "id": product_id,
        "name": name,
        "price": price,
        "hasQuantity": stock,
    }
    if ok_price is not None:
        raw["okPrice"] = ok_price
    return raw


class ParseTests(unittest.TestCase):
    def test_fixture_prices_the_seed_set_in_toman(self):
        products = okala.load_fixture_products()
        rice = okala.best_match("برنج", products)
        self.assertIsNotNone(rice)
        self.assertNotIn("آرد", rice["product_title"])
        self.assertEqual(rice["product_id"], "190868")
        self.assertEqual(rice["pack_price_toman"], 4125000)
        self.assertEqual(rice["pack_quantity"], 10)
        self.assertEqual(rice["unit"], "کیلوگرم")
        self.assertEqual(rice["unit_price_toman"], 412500)
        self.assertEqual(rice["product_url"], "https://www.okala.com/product/190868")

        onion = okala.best_match("پیاز", products)
        self.assertFalse(onion["in_stock"])
        # Discounted okPrice is the payable rial amount.
        self.assertEqual(onion["pack_price_toman"], 176963)
        self.assertEqual(onion["pack_quantity"], 2)

        potato = okala.best_match("سیب‌زمینی", products)
        self.assertIn("سیب زمینی", potato["product_title"])
        self.assertIsNone(okala.best_match("پیازچه", products))
        self.assertIsNone(okala.best_match("شیرین", products))
        milk = okala.best_match("شیر", products)
        self.assertTrue(milk["product_title"].startswith("شیر"))
        self.assertNotIn("شیرین", milk["product_title"])

        for name in okala.SEED_NAMES:
            self.assertIsNotNone(okala.best_match(name, products), name)

    def test_in_stock_beats_a_cheaper_missing_pack(self):
        rows = okala.parse_products(
            [
                product("برنج تمام شده 1 کیلوگرمی", 1_000_000, stock=False, product_id=1),
                product("برنج گران 1 کیلوگرمی", 10_000_000, stock=True, product_id=2),
                product("برنج ارزان 2 کیلوگرمی", 10_000_000, stock=True, product_id=3),
            ]
        )
        chosen = okala.best_match("برنج", rows)
        self.assertEqual(chosen["product_id"], "3")
        self.assertTrue(chosen["in_stock"])

    def test_rial_field_becomes_toman_and_stock_quantity_is_not_the_pack(self):
        parsed = okala.normalize_product(
            {
                "id": 9,
                "name": "روغن 810 گرمی",
                "price": 3612730,
                "quantity": 122,
                "hasQuantity": True,
            }
        )
        self.assertEqual(parsed["pack_price_toman"], 361273)
        self.assertEqual(parsed["pack_quantity"], 0.81)
        self.assertEqual(parsed["unit"], "کیلوگرم")

    def test_disallowed_site_paths_are_not_fetch_urls(self):
        self.assertFalse(okala.allowed_fetch_url("https://www.okala.com/cart"))
        self.assertFalse(okala.allowed_fetch_url("https://www.okala.com/search?keyword=برنج"))
        self.assertFalse(okala.allowed_fetch_url("https://www.okala.com/checkout"))
        self.assertFalse(okala.allowed_fetch_url("https://www.okala.com/store/2319"))
        self.assertFalse(okala.allowed_fetch_url("https://www.okala.com/shopping-assistant/cart"))
        self.assertTrue(okala.allowed_fetch_url(okala.category_url("groceries", 1461, 2319)))
        with self.assertRaises(okala.OkalaFetchError):
            okala.http_get_json("https://www.okala.com/cart")


class QuoteTests(unittest.TestCase):
    def setUp(self):
        self.book = okala.MemoryPriceBook()
        self.now = okala._now()
        self.env = patch.dict(os.environ, {"OKALA_LIVE": "0", "OKALA_MIN_INTERVAL_SECONDS": "60"}, clear=False)
        self.env.start()
        okala.refresh_prices(force=True, now=self.now, book=self.book)

    def tearDown(self):
        self.env.stop()

    def test_recipe_cost_uses_okala_and_scales_once_with_household(self):
        four = okala.quote_recipe(
            ["۲۰۰ گرم برنج"],
            household=4,
            servings=4,
            estimate_toman=10000,
            now=self.now,
            book=self.book,
        )
        eight = okala.quote_recipe(
            ["۲۰۰ گرم برنج"],
            household=8,
            servings=4,
            estimate_toman=10000,
            now=self.now,
            book=self.book,
        )
        self.assertEqual(four["source"], "okala")
        self.assertEqual(four["toman"], 82500)
        self.assertEqual(eight["source"], "okala")
        self.assertEqual(eight["toman"], 165000)
        self.assertNotEqual(eight["toman"], 20000)

    def test_partial_and_estimate_fallback(self):
        partial = okala.quote_recipe(
            ["۲۰۰ گرم برنج", "۲۰۰ گرم زعفران"],
            household=4,
            servings=4,
            estimate_toman=50000,
            now=self.now,
            book=self.book,
        )
        self.assertEqual(partial["source"], "partial")
        self.assertEqual(partial["toman"], 82500)

        missing = okala.quote_recipe(
            ["۲۰۰ گرم زعفران"],
            household=8,
            servings=4,
            estimate_toman=10000,
            now=self.now,
            book=self.book,
        )
        self.assertEqual(missing["source"], "estimate")
        self.assertEqual(missing["toman"], 20000)
        self.assertFalse(missing["stale"])

    def test_stale_price_falls_back_to_the_estimate(self):
        old = self.now - timedelta(days=3)
        for row in self.book.load_all():
            row["fetched_at"] = old
            self.book.save_rows([row])
        quoted = okala.quote_recipe(
            ["۲۰۰ گرم برنج"],
            household=4,
            servings=4,
            estimate_toman=180000,
            now=self.now,
            book=self.book,
        )
        self.assertEqual(quoted["source"], "estimate")
        self.assertEqual(quoted["toman"], 180000)
        self.assertTrue(quoted["stale"])


class RefreshTests(unittest.TestCase):
    def test_refresh_stores_seed_prices_from_the_fixture_without_network(self):
        book = okala.MemoryPriceBook()

        def boom(url):
            raise AssertionError(url)

        with patch.dict(os.environ, {"OKALA_LIVE": "0"}):
            payload = okala.refresh_prices(force=True, book=book, transport=boom)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["origin"], "fixture")
        self.assertFalse(payload["degraded"])
        names = {item["name"] for item in payload["items"]}
        self.assertTrue(set(okala.SEED_NAMES).issubset(names))
        self.assertEqual(payload["unmatched"], [])
        rice = next(item for item in payload["items"] if item["name"] == "برنج")
        self.assertFalse(rice["stale"])
        self.assertEqual(rice["pack_price_toman"], 4125000)

    def test_live_failure_keeps_the_last_price(self):
        book = okala.MemoryPriceBook()
        now = okala._now()
        book.save_rows(
            [
                {
                    "name": "برنج",
                    "name_key": store.identity_key("برنج"),
                    "matched": True,
                    "product_id": "1",
                    "product_title": "برنج ذخیره‌شده 1 کیلوگرمی",
                    "product_url": "https://www.okala.com/product/1",
                    "pack_price_toman": 1000,
                    "pack_quantity": 1,
                    "unit": "کیلوگرم",
                    "unit_price_toman": 1000,
                    "in_stock": True,
                    "origin": "live",
                    "fetched_at": now - timedelta(hours=2),
                }
            ]
        )

        def fail(url):
            raise okala.OkalaFetchError("upstream")

        with patch.dict(os.environ, {"OKALA_LIVE": "1", "OKALA_MIN_INTERVAL_SECONDS": "60"}):
            payload = okala.refresh_prices(
                ["برنج"],
                force=True,
                now=now,
                book=book,
                transport=fail,
                sleep=lambda _seconds: None,
            )
        self.assertTrue(payload["degraded"])
        self.assertTrue(payload["from_cache"])
        rice = next(item for item in payload["items"] if item["name"] == "برنج")
        self.assertEqual(rice["pack_price_toman"], 1000)
        quoted = okala.quote_recipe(
            ["۱ کیلوگرم برنج"],
            household=4,
            servings=4,
            estimate_toman=999,
            now=now,
            book=book,
        )
        self.assertEqual(quoted["source"], "okala")
        self.assertEqual(quoted["toman"], 1000)

    def test_a_second_force_refresh_waits_and_does_not_call_out(self):
        book = okala.MemoryPriceBook()
        now = okala._now()
        calls = []

        def transport(url):
            calls.append(url)
            return json.loads(ROOT_FIXTURE.read_text(encoding="utf-8"))

        with patch.dict(os.environ, {"OKALA_LIVE": "1", "OKALA_MIN_INTERVAL_SECONDS": "60", "OKALA_REQUEST_DELAY_SECONDS": "0"}):
            first = okala.refresh_prices(force=True, now=now, book=book, transport=transport, sleep=lambda _s: None)
            second = okala.refresh_prices(
                force=True,
                now=now + timedelta(seconds=10),
                book=book,
                transport=transport,
                sleep=lambda _s: None,
            )
        self.assertFalse(first["throttled"])
        self.assertTrue(second["throttled"])
        self.assertTrue(second["from_cache"])
        self.assertEqual(len(calls), len(okala.CATEGORIES))

    def test_rate_limit_stops_the_batch(self):
        pauses = []
        calls = []

        def transport(url):
            calls.append(url)
            if len(calls) == 1:
                return json.loads(ROOT_FIXTURE.read_text(encoding="utf-8"))
            raise okala.OkalaFetchError("rate_limited")

        with patch.dict(os.environ, {"OKALA_LIVE": "1", "OKALA_REQUEST_DELAY_SECONDS": "1.5"}):
            products, errors = okala.fetch_live_products(
                transport=transport,
                sleep=lambda seconds: pauses.append(seconds),
            )
        self.assertEqual(len(calls), 2)
        self.assertEqual(pauses, [1.5])
        self.assertIn("rate_limited", errors)
        self.assertTrue(products)
        for url in calls:
            self.assertTrue(okala.allowed_fetch_url(url))
            self.assertNotIn("/cart", url)
            self.assertNotIn("/search", url)

    def test_unmatched_name_is_listed(self):
        book = okala.MemoryPriceBook()
        with patch.dict(os.environ, {"OKALA_LIVE": "0"}):
            payload = okala.refresh_prices(["زعفران"], force=True, book=book)
        self.assertIn("زعفران", payload["unmatched"])

    def test_cart_assist_does_not_prefill_or_checkout(self):
        book = okala.MemoryPriceBook()
        with patch.dict(os.environ, {"OKALA_LIVE": "0"}):
            okala.refresh_prices(force=True, book=book)
        cart = okala.cart_assist(
            [
                {"name": "برنج", "quantity_label": "۲۰۰ گرم"},
                {"name": "پیاز", "quantity_label": "۲ عدد"},
                "زعفران",
            ],
            book=book,
        )
        self.assertFalse(cart["prefill"])
        self.assertFalse(cart["checkout"])
        self.assertEqual(cart["homepage"], "https://www.okala.com/")
        self.assertNotIn("/cart", cart["homepage"])
        self.assertNotIn("/search", cart["homepage"])
        self.assertIn("پرداخت اینجا انجام نمی‌شود", cart["message"])
        self.assertEqual(cart["copy_text"].splitlines()[0], "برنج")
        rice = cart["items"][0]
        self.assertTrue(rice["matched"])
        self.assertTrue(rice["product_url"].startswith("https://www.okala.com/product/"))
        self.assertNotIn("/cart", rice["product_url"])
        self.assertFalse(cart["items"][2]["matched"])
        blob = json.dumps(cart, ensure_ascii=False)
        self.assertNotIn("GAP_CODE_API_KEY", blob)

    @unittest.skipUnless(os.environ.get("OKALA_LIVE_SMOKE") == "1", "set OKALA_LIVE_SMOKE=1")
    def test_live_smoke_one_catalog_page(self):
        payload = okala.http_get_json(okala.category_url("groceries", 1461, okala.DEFAULT_STORE_ID))
        products = okala.parse_products(payload)
        self.assertGreater(len(products), 0)
        self.assertGreater(products[0]["pack_price_toman"], 0)


class MigrationTests(unittest.TestCase):
    def test_price_table_is_created_with_the_other_migrations(self):
        sql = (store.MIGRATION_DIR / "002_okala_prices.sql").read_text(encoding="utf-8")
        names = [path.name for path in store.migration_files()]
        self.assertEqual(names[0], "001_kitchen_state.sql")
        self.assertIn("002_okala_prices.sql", names)
        self.assertIn("CREATE TABLE IF NOT EXISTS okala_price", sql)
        self.assertNotIn("GAP_CODE_API_KEY", sql)
        compose = (store.MIGRATION_DIR.parents[1] / "docker-compose.yml").read_text(encoding="utf-8")
        self.assertIn("002_okala_prices.sql", compose)


if __name__ == "__main__":
    unittest.main()

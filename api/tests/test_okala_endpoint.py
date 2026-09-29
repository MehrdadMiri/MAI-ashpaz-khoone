"""Price routes. The suite uses the in-memory book and the fixture catalog."""

import os
import unittest
from unittest.mock import patch

import app as app_module
import okala


class PriceEndpointTests(unittest.TestCase):
    def setUp(self):
        self.book = okala.MemoryPriceBook()
        self.book_patch = patch("okala.get_book", return_value=self.book)
        self.book_patch.start()
        self.env = patch.dict(os.environ, {"OKALA_LIVE": "0", "OKALA_MIN_INTERVAL_SECONDS": "0"}, clear=False)
        self.env.start()
        self.client = app_module.app.test_client()

    def tearDown(self):
        self.book_patch.stop()
        self.env.stop()

    def test_refresh_then_quote_and_cart(self):
        refreshed = self.client.post("/prices/refresh", json={"force": True, "names": ["زعفران"]})
        self.assertEqual(refreshed.status_code, 200)
        body = refreshed.get_json()
        self.assertTrue(body["ok"])
        self.assertEqual(body["origin"], "fixture")
        self.assertIn("برنج", [item["name"] for item in body["items"]])
        self.assertIn("زعفران", body["unmatched"])
        self.assertNotIn("GAP_CODE_API_KEY", refreshed.get_data(as_text=True))

        listed = self.client.get("/prices")
        self.assertEqual(listed.status_code, 200)
        self.assertGreaterEqual(len(listed.get_json()["items"]), 8)

        quoted = self.client.post(
            "/api/prices/quote",
            json={
                "ingredients": ["۲۰۰ گرم برنج"],
                "household": 8,
                "servings": 4,
                "estimate_toman": 10000,
            },
        )
        self.assertEqual(quoted.status_code, 200)
        quote = quoted.get_json()
        self.assertEqual(quote["source"], "okala")
        self.assertEqual(quote["toman"], 165000)
        self.assertEqual(quote["household"], 8)

        cart = self.client.post(
            "/prices/cart",
            json={"items": [{"name": "برنج", "quantity_label": "۴۰۰ گرم"}]},
        )
        self.assertEqual(cart.status_code, 200)
        assist = cart.get_json()
        self.assertFalse(assist["prefill"])
        self.assertFalse(assist["checkout"])
        self.assertNotIn("/cart", assist["homepage"])
        self.assertIn("پرداخت", assist["message"])

        blocked = self.client.get("/prices/refresh")
        self.assertEqual(blocked.status_code, 405)

    def test_a_bad_body_stays_a_static_error(self):
        res = self.client.post("/prices/refresh", json=["برنج"])
        self.assertEqual(res.status_code, 400)
        self.assertEqual(res.get_json()["error"], "invalid_request")

    def test_failure_path_still_quotes_the_last_price(self):
        self.client.post("/prices/refresh", json={"force": True})

        def fail(*_args, **_kwargs):
            raise okala.OkalaFetchError("upstream")

        with patch.dict(os.environ, {"OKALA_LIVE": "1"}):
            with patch("okala.fetch_catalog", side_effect=fail):
                failed = self.client.post("/prices/refresh", json={"force": True, "names": ["برنج"]})
        self.assertEqual(failed.status_code, 200)
        self.assertTrue(failed.get_json()["degraded"])
        quoted = self.client.post(
            "/prices/quote",
            json={"ingredients": ["۲۰۰ گرم برنج"], "household": 4, "servings": 4, "estimate_toman": 10},
        )
        self.assertEqual(quoted.get_json()["source"], "okala")
        self.assertEqual(quoted.get_json()["toman"], 82500)


if __name__ == "__main__":
    unittest.main()

"""Okala unit prices for آشپزخونه.

The public catalog JSON at apigateway.okala.com is read only when a person
asks to refresh, or when an optional slow timer is turned on. Search, cart,
checkout, and store HTML paths from www.okala.com/robots.txt are never
requested. Prices are rial in that JSON and are stored as toman.

A bundled snapshot is the fallback when the live catalog does not answer,
and only when nothing is stored yet. A later failure keeps the last row.
Tests pass a fixture or a fake transport and do not touch the network.
"""

from __future__ import annotations

import json
import logging
import math
import os
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

import store

logger = logging.getLogger(__name__)

FIXTURE_PATH = Path(__file__).resolve().parent / "fixtures" / "okala_catalog.json"
HOME_URL = "https://www.okala.com/"
PRODUCT_URL = "https://www.okala.com/product/{product_id}"
API_HOST = "apigateway.okala.com"
USER_AGENT = (
    "ashpaz-khoone/0.3 (manual price refresh; "
    "+https://github.com/MehrdadMiri/MAI-ashpaz-khoone)"
)

# One page per category. The ingredient name is not put in the URL.
CATEGORIES = (
    ("groceries", 1461),
    ("fruits-vegetables", 1470),
    ("dairy-products", 1462),
    ("proteins", 1463),
)

SEED_NAMES = (
    "برنج",
    "پیاز",
    "عدس",
    "لوبیا",
    "سیب‌زمینی",
    "گوجه‌فرنگی",
    "ماست",
    "روغن",
)

DEFAULT_TTL_SECONDS = 86400
DEFAULT_MIN_INTERVAL_SECONDS = 60
DEFAULT_DELAY_SECONDS = 1.5
DEFAULT_TIMEOUT_SECONDS = 8
DEFAULT_STORE_ID = 2319
MIN_PERIODIC_SECONDS = 3600
MAX_NAMES = 40
MAX_BODY_BYTES = 2_000_000
COPY_LIMIT = 10

CART_MESSAGE = (
    "سبد اُکالا از اینجا پر نمی‌شود. نام‌ها را کپی کنید و در جست‌وجوی لیستی اُکالا بگذارید. "
    "پرداخت اینجا انجام نمی‌شود."
)
CART_TRUNCATED = "جست‌وجوی لیستی اُکالا ده نام را با هم می‌گیرد. ده نام اول کپی می‌شود."

_PACK_RE = re.compile(
    r"(\d+(?:[.,]\d+)?)\s*"
    r"(کیلو\s*گرمی|کیلو\s*گرم|کیلویی|کیلو|میلی\s*لیتری|گرمی|گرم|لیتری|لیتر|عددی|عدد)"
)
_LINE_RE = re.compile(
    r"^(\d+(?:[.,]\d+)?)\s*"
    r"(کیلوگرم|کیلو|میلی‌لیتر|میلی لیتر|گرم|لیتر|عدد|پیمانه|قاشق|لیوان)?\s*(.+)$"
)
_SLUG_RE = re.compile(r"^[a-z0-9-]{1,40}$")
_PRODUCT_URL_RE = re.compile(r"^https://www\.okala\.com/product/\d+$")

_refresh_lock = threading.Lock()
_scheduler_started = False
_book: PriceBook | None = None


class PriceError(Exception):
    def __init__(self, code: str, message: str, http_status: int) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.http_status = http_status

    def to_dict(self) -> dict[str, Any]:
        return {"ok": False, "error": self.code, "message": self.message}


class OkalaFetchError(Exception):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


class PriceBook:
    def load_all(self) -> list[dict[str, Any]]:
        raise NotImplementedError

    def save_rows(self, rows: list[dict[str, Any]]) -> None:
        raise NotImplementedError


def _setting_int(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _setting_float(name: str, default: float) -> float:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        value = float(raw)
    except ValueError:
        return default
    if not math.isfinite(value) or value < 0:
        return default
    return value


def ttl_seconds() -> int:
    value = _setting_int("OKALA_CACHE_TTL_SECONDS", DEFAULT_TTL_SECONDS)
    return value if value > 0 else DEFAULT_TTL_SECONDS


def min_interval_seconds() -> int:
    value = _setting_int("OKALA_MIN_INTERVAL_SECONDS", DEFAULT_MIN_INTERVAL_SECONDS)
    return value if value >= 0 else DEFAULT_MIN_INTERVAL_SECONDS


def delay_seconds() -> float:
    return _setting_float("OKALA_REQUEST_DELAY_SECONDS", DEFAULT_DELAY_SECONDS)


def timeout_seconds() -> float:
    value = _setting_float("OKALA_TIMEOUT_SECONDS", DEFAULT_TIMEOUT_SECONDS)
    return value if value > 0 else DEFAULT_TIMEOUT_SECONDS


def store_id() -> int:
    value = _setting_int("OKALA_STORE_ID", DEFAULT_STORE_ID)
    return value if value > 0 else DEFAULT_STORE_ID


def live_enabled() -> bool:
    raw = os.environ.get("OKALA_LIVE", "1").strip().lower()
    return raw not in {"0", "false", "off", "no"}


def periodic_seconds() -> int:
    value = _setting_int("OKALA_REFRESH_INTERVAL_SECONDS", 0)
    if value <= 0:
        return 0
    return max(value, MIN_PERIODIC_SECONDS)


def round_toman(value: float) -> int:
    """Half-up for positive amounts, matching the page's Math.round."""
    if not math.isfinite(value) or value <= 0:
        return 0
    return int(math.floor(value + 0.5))


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _parse_time(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        if value.tzinfo is None:
            return value.replace(tzinfo=timezone.utc)
        return value
    if isinstance(value, str) and value:
        text = value.replace("Z", "+00:00")
        try:
            parsed = datetime.fromisoformat(text)
        except ValueError:
            return None
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed
    return None


def _iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    return value.astimezone(timezone.utc).replace(microsecond=0).isoformat()


def is_stale(fetched_at: Any, now: datetime | None = None, ttl: int | None = None) -> bool:
    moment = _parse_time(fetched_at)
    if moment is None:
        return True
    current = now or _now()
    limit = ttl_seconds() if ttl is None else ttl
    return (current - moment).total_seconds() > limit


def tokens(value: Any) -> list[str]:
    text = store.display_name(value).replace("\u200c", " ")
    parts: list[str] = []
    for part in text.split():
        key = store.identity_key(part)
        if key:
            parts.append(key)
    return parts


def name_matches(query: Any, product_name: Any) -> bool:
    query_tokens = tokens(query)
    product_tokens = tokens(product_name)
    if not query_tokens or len(product_tokens) < len(query_tokens):
        return False
    if len("".join(query_tokens)) < 2:
        return False
    return product_tokens[: len(query_tokens)] == query_tokens


def _ascii_digits(value: str) -> str:
    return value.translate(store._DIGIT_TRANSLATION)


def _unit_kind(label: str) -> str:
    compact = re.sub(r"\s+", "", label)
    if compact.startswith("کیلو"):
        return "kg"
    if compact.startswith("میلی"):
        return "ml"
    if compact.startswith("گرم"):
        return "g"
    if compact.startswith("لیتر"):
        return "l"
    return "count"


def pack_size(name: str) -> tuple[float, str] | None:
    """Pack size written in the product title. Stock `quantity` is not a pack."""
    text = _ascii_digits(store.display_name(name).replace("\u200c", " "))
    found: list[tuple[float, str]] = []
    for match in _PACK_RE.finditer(text):
        raw = match.group(1).replace(",", ".")
        try:
            qty = float(raw)
        except ValueError:
            continue
        if not math.isfinite(qty) or qty <= 0 or qty > 100000:
            continue
        found.append((qty, _unit_kind(match.group(2))))
    if not found:
        return None
    measured = [item for item in found if item[1] != "count"]
    qty, kind = (measured or found)[-1]
    if kind == "g":
        return (round(qty / 1000, 6), "کیلوگرم")
    if kind == "kg":
        return (round(qty, 6), "کیلوگرم")
    if kind == "ml":
        return (round(qty / 1000, 6), "لیتر")
    if kind == "l":
        return (round(qty, 6), "لیتر")
    return (round(qty, 6), "عدد")


def _positive(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    if not math.isfinite(number) or number <= 0:
        return None
    return number


def payable_rial(product: dict[str, Any]) -> float | None:
    """Customer price. `okPrice` is the discounted rial amount when it is lower."""
    price = _positive(product.get("price"))
    discounted = _positive(product.get("okPrice"))
    if discounted is not None and (price is None or discounted <= price):
        return discounted
    return price


def _product_name(product: dict[str, Any]) -> str:
    raw = product.get("name", product.get("title"))
    return store.display_name(raw)


def _product_id(product: dict[str, Any]) -> str:
    raw = product.get("id", product.get("productId"))
    if isinstance(raw, bool) or raw is None:
        return ""
    if isinstance(raw, float):
        if not raw.is_integer():
            return ""
        raw = int(raw)
    text = str(raw).strip()
    if not text.isdigit():
        return ""
    return text


def product_url(product_id: str) -> str:
    if not product_id.isdigit():
        return ""
    return PRODUCT_URL.format(product_id=product_id)


def safe_product_url(url: Any) -> str:
    if not isinstance(url, str):
        return ""
    if _PRODUCT_URL_RE.fullmatch(url):
        return url
    return ""


def parse_products(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, dict):
        rows = payload.get("data", payload.get("products"))
    elif isinstance(payload, list):
        rows = payload
    else:
        return []
    if not isinstance(rows, list):
        return []
    parsed: list[dict[str, Any]] = []
    for raw in rows:
        if not isinstance(raw, dict):
            continue
        item = normalize_product(raw)
        if item is not None:
            parsed.append(item)
    return parsed


def normalize_product(raw: dict[str, Any]) -> dict[str, Any] | None:
    name = _product_name(raw)
    rial = payable_rial(raw)
    size = pack_size(name)
    if not name or rial is None or size is None:
        return None
    pack_quantity, unit = size
    if pack_quantity <= 0:
        return None
    toman = round_toman(rial / 10)
    if toman <= 0:
        return None
    product_id = _product_id(raw)
    in_stock = raw.get("hasQuantity") is not False
    return {
        "product_id": product_id,
        "product_title": name,
        "product_url": product_url(product_id),
        "pack_price_toman": toman,
        "pack_quantity": pack_quantity,
        "unit": unit,
        "unit_price_toman": round_toman(toman / pack_quantity),
        "in_stock": bool(in_stock),
    }


def load_fixture_products() -> list[dict[str, Any]]:
    try:
        payload = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        logger.warning("okala fixture unreadable: %s", exc.__class__.__name__)
        return []
    return parse_products(payload)


def fixture_captured_at() -> str:
    try:
        payload = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return ""
    captured = payload.get("captured_at") if isinstance(payload, dict) else ""
    return captured if isinstance(captured, str) else ""


def best_match(query: str, products: list[dict[str, Any]]) -> dict[str, Any] | None:
    found = [item for item in products if name_matches(query, item.get("product_title"))]
    if not found:
        return None
    stocked = [item for item in found if item.get("in_stock")]
    pool = stocked or found

    def sort_key(item: dict[str, Any]) -> tuple[float, str]:
        unit_price = item["pack_price_toman"] / item["pack_quantity"]
        return (unit_price, item.get("product_id") or "")

    return min(pool, key=sort_key)


def _row_from_match(name: str, match: dict[str, Any] | None, origin: str, fetched_at: datetime) -> dict[str, Any]:
    shown = store.display_name(name)
    base = {
        "name": shown,
        "name_key": store.identity_key(shown),
        "matched": match is not None,
        "origin": origin,
        "fetched_at": fetched_at,
    }
    if match is None:
        base.update(
            {
                "product_id": "",
                "product_title": "",
                "product_url": "",
                "pack_price_toman": None,
                "pack_quantity": None,
                "unit": "",
                "unit_price_toman": None,
                "in_stock": False,
            }
        )
        return base
    base.update(match)
    return base


def normalize_names(raw: Any) -> list[str]:
    if raw is None:
        incoming: list[Any] = list(SEED_NAMES)
    elif isinstance(raw, list):
        incoming = list(SEED_NAMES) + list(raw)
    else:
        raise PriceError("invalid_request", "Request was rejected", 400)
    names: list[str] = []
    seen: set[str] = set()
    for item in incoming:
        if not isinstance(item, str):
            continue
        shown = store.display_name(item)
        key = store.identity_key(shown)
        if not key or len(shown) > store.MAX_NAME_LENGTH or key in seen:
            continue
        if len(key) < 2:
            continue
        seen.add(key)
        names.append(shown)
        if len(names) >= MAX_NAMES:
            break
    store.reject_secret(names)
    return names or [store.display_name(name) for name in SEED_NAMES]


def category_url(slug: str, category_id: int, chosen_store: int | None = None) -> str:
    if not _SLUG_RE.fullmatch(slug):
        raise OkalaFetchError("blocked_url")
    sid = store_id() if chosen_store is None else chosen_store
    return (
        f"https://{API_HOST}/api/unicorn/v2/products/store/{int(sid)}"
        f"?pC_Id={int(category_id)}&slug={slug}"
    )


def allowed_fetch_url(url: str) -> bool:
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme != "https" or parsed.hostname != API_HOST:
        return False
    if parsed.username or parsed.password or parsed.fragment:
        return False
    parts = [part for part in parsed.path.split("/") if part]
    if len(parts) != 6:
        return False
    if parts[:5] != ["api", "unicorn", "v2", "products", "store"]:
        return False
    if not parts[5].isdigit():
        return False
    query = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
    if set(query) - {"pC_Id", "slug"}:
        return False
    slug = (query.get("slug") or [""])[0]
    category = (query.get("pC_Id") or [""])[0]
    if not _SLUG_RE.fullmatch(slug) or not category.isdigit():
        return False
    return True


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ARG002
        raise OkalaFetchError("redirect")


def http_get_json(url: str) -> Any:
    if not allowed_fetch_url(url):
        raise OkalaFetchError("blocked_url")
    request = urllib.request.Request(
        url,
        headers={"Accept": "application/json", "User-Agent": USER_AGENT},
        method="GET",
    )
    opener = urllib.request.build_opener(_NoRedirect)
    try:
        with opener.open(request, timeout=timeout_seconds()) as response:
            status = getattr(response, "status", 200)
            if status == 429:
                raise OkalaFetchError("rate_limited")
            if status >= 400:
                raise OkalaFetchError("upstream")
            raw = response.read(MAX_BODY_BYTES + 1)
    except OkalaFetchError:
        raise
    except urllib.error.HTTPError as exc:
        if exc.code == 429:
            raise OkalaFetchError("rate_limited")
        logger.warning("okala http failed: %s", exc.__class__.__name__)
        raise OkalaFetchError("upstream") from None
    except Exception as exc:
        logger.warning("okala fetch failed: %s", exc.__class__.__name__)
        raise OkalaFetchError("upstream") from None
    if len(raw) > MAX_BODY_BYTES:
        raise OkalaFetchError("too_large")
    try:
        return json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise OkalaFetchError("bad_json") from None


def fetch_live_products(
    transport: Callable[[str], Any] | None = None,
    sleep: Callable[[float], None] | None = None,
) -> tuple[list[dict[str, Any]], list[str]]:
    """Polite category reads. A 429 stops the rest of the batch."""
    get = transport or http_get_json
    pause = sleep if sleep is not None else time.sleep
    delay = delay_seconds()
    merged: dict[str, dict[str, Any]] = {}
    order: list[str] = []
    errors: list[str] = []
    for index, (slug, category_id) in enumerate(CATEGORIES):
        if index and delay:
            pause(delay)
        url = category_url(slug, category_id)
        try:
            payload = get(url)
        except OkalaFetchError as exc:
            errors.append(exc.code)
            logger.warning("okala category skipped: %s", exc.code)
            if exc.code == "rate_limited":
                break
            continue
        for product in parse_products(payload):
            key = product["product_id"] or product["product_title"]
            current = merged.get(key)
            if current is None:
                merged[key] = product
                order.append(key)
            elif product["in_stock"] and not current["in_stock"]:
                merged[key] = product
    products = [merged[key] for key in order]
    if not products:
        raise OkalaFetchError("upstream")
    return products, errors


def fetch_catalog(
    transport: Callable[[str], Any] | None = None,
    sleep: Callable[[float], None] | None = None,
) -> dict[str, Any]:
    if not live_enabled():
        return {
            "products": load_fixture_products(),
            "origin": "fixture",
            "degraded": False,
            "errors": [],
        }
    products, errors = fetch_live_products(transport=transport, sleep=sleep)
    return {
        "products": products,
        "origin": "live",
        "degraded": bool(errors),
        "errors": errors,
    }


def _by_key(rows: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    found: dict[str, dict[str, Any]] = {}
    for row in rows:
        key = row.get("name_key") or ""
        if key:
            found[key] = row
    return found


def _newest(rows: list[dict[str, Any]]) -> datetime | None:
    moments = [_parse_time(row.get("fetched_at")) for row in rows]
    live = [moment for moment in moments if moment is not None]
    if not live:
        return None
    return max(live)


def _public_item(row: dict[str, Any], now: datetime, ttl: int) -> dict[str, Any]:
    fetched = _parse_time(row.get("fetched_at"))
    matched = bool(row.get("matched"))
    item = {
        "name": row.get("name") or "",
        "name_key": row.get("name_key") or "",
        "matched": matched,
        "product_id": row.get("product_id") or "",
        "product_title": row.get("product_title") or "",
        "product_url": safe_product_url(row.get("product_url")),
        "pack_price_toman": row.get("pack_price_toman"),
        "pack_quantity": row.get("pack_quantity"),
        "unit": row.get("unit") or "",
        "unit_price_toman": row.get("unit_price_toman"),
        "in_stock": bool(row.get("in_stock")),
        "origin": row.get("origin") or "cache",
        "fetched_at": _iso(fetched),
        "stale": is_stale(fetched, now, ttl) if matched else False,
    }
    return item


def _payload(
    rows: list[dict[str, Any]],
    *,
    now: datetime,
    origin: str,
    degraded: bool,
    from_cache: bool,
    throttled: bool,
    errors: list[str] | None = None,
) -> dict[str, Any]:
    ttl = ttl_seconds()
    items = []
    unmatched = []
    for row in rows:
        item = _public_item(row, now, ttl)
        if item["matched"]:
            items.append(item)
        elif item["name"]:
            unmatched.append(item["name"])
    newest = _newest(rows)
    return {
        "ok": True,
        "ttl_seconds": ttl,
        "min_interval_seconds": min_interval_seconds(),
        "origin": origin,
        "live": origin == "live" and not degraded and not from_cache,
        "degraded": degraded,
        "from_cache": from_cache,
        "throttled": throttled,
        "captured_at": fixture_captured_at() if origin == "fixture" else "",
        "refreshed_at": _iso(newest),
        "items": items,
        "unmatched": unmatched,
        "errors": errors or [],
    }


class MemoryPriceBook(PriceBook):
    def __init__(self) -> None:
        self.rows: dict[str, dict[str, Any]] = {}

    def load_all(self) -> list[dict[str, Any]]:
        return [dict(row) for row in self.rows.values()]

    def save_rows(self, rows: list[dict[str, Any]]) -> None:
        for row in rows:
            key = row.get("name_key") or ""
            if key:
                self.rows[key] = dict(row)


class PostgresPriceBook(PriceBook):
    def load_all(self) -> list[dict[str, Any]]:
        try:
            with store.connect() as conn:
                store.ensure_schema(conn)
                found = conn.execute(
                    """
                    SELECT name_key, display_name, matched, product_id, product_title,
                           product_url, pack_price_toman, pack_quantity, unit,
                           unit_price_toman, in_stock, origin, fetched_at
                    FROM okala_price
                    ORDER BY display_name
                    """
                ).fetchall()
        except Exception as exc:
            logger.warning("okala load failed: %s", exc.__class__.__name__)
            raise store.StoreError(
                "database_unavailable",
                "Saved kitchen data is unavailable",
                503,
            ) from None
        store.mark_schema_ready()
        rows = []
        for found_row in found:
            rows.append(
                {
                    "name_key": found_row[0],
                    "name": found_row[1],
                    "matched": found_row[2],
                    "product_id": found_row[3] or "",
                    "product_title": found_row[4] or "",
                    "product_url": found_row[5] or "",
                    "pack_price_toman": found_row[6],
                    "pack_quantity": found_row[7],
                    "unit": found_row[8] or "",
                    "unit_price_toman": found_row[9],
                    "in_stock": bool(found_row[10]),
                    "origin": found_row[11],
                    "fetched_at": found_row[12],
                }
            )
        return rows

    def save_rows(self, rows: list[dict[str, Any]]) -> None:
        try:
            with store.connect() as conn:
                store.ensure_schema(conn)
                for row in rows:
                    conn.execute(
                        """
                        INSERT INTO okala_price (
                            name_key, display_name, matched, product_id, product_title,
                            product_url, pack_price_toman, pack_quantity, unit,
                            unit_price_toman, in_stock, origin, fetched_at
                        )
                        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                        ON CONFLICT (name_key) DO UPDATE
                        SET display_name = EXCLUDED.display_name,
                            matched = EXCLUDED.matched,
                            product_id = EXCLUDED.product_id,
                            product_title = EXCLUDED.product_title,
                            product_url = EXCLUDED.product_url,
                            pack_price_toman = EXCLUDED.pack_price_toman,
                            pack_quantity = EXCLUDED.pack_quantity,
                            unit = EXCLUDED.unit,
                            unit_price_toman = EXCLUDED.unit_price_toman,
                            in_stock = EXCLUDED.in_stock,
                            origin = EXCLUDED.origin,
                            fetched_at = EXCLUDED.fetched_at
                        """,
                        (
                            row["name_key"],
                            row["name"],
                            bool(row["matched"]),
                            row.get("product_id") or None,
                            row.get("product_title") or None,
                            safe_product_url(row.get("product_url")) or None,
                            row.get("pack_price_toman"),
                            row.get("pack_quantity"),
                            row.get("unit") or None,
                            row.get("unit_price_toman"),
                            bool(row.get("in_stock")),
                            row.get("origin") or "fixture",
                            _parse_time(row.get("fetched_at")),
                        ),
                    )
        except store.StoreError:
            raise
        except Exception as exc:
            logger.warning("okala save failed: %s", exc.__class__.__name__)
            raise store.StoreError(
                "database_unavailable",
                "Saved kitchen data is unavailable",
                503,
            ) from None
        store.mark_schema_ready()


def get_book() -> PriceBook:
    global _book
    if _book is None:
        _book = PostgresPriceBook()
    return _book


def set_book(book: PriceBook | None) -> None:
    global _book
    _book = book


def _fresh_enough(rows: list[dict[str, Any]], names: list[str], now: datetime) -> bool:
    indexed = _by_key(rows)
    ttl = ttl_seconds()
    for name in names:
        row = indexed.get(store.identity_key(name))
        if row is None or is_stale(row.get("fetched_at"), now, ttl):
            return False
    return True


def refresh_prices(
    names: Any = None,
    *,
    force: bool = False,
    now: datetime | None = None,
    transport: Callable[[str], Any] | None = None,
    sleep: Callable[[float], None] | None = None,
    book: PriceBook | None = None,
) -> dict[str, Any]:
    current = now or _now()
    chosen = book or get_book()
    wanted = normalize_names(names)
    if not _refresh_lock.acquire(blocking=False):
        return _payload(
            chosen.load_all(),
            now=current,
            origin="cache",
            degraded=False,
            from_cache=True,
            throttled=True,
        )
    try:
        existing = chosen.load_all()
        if not force and existing and _fresh_enough(existing, wanted, current):
            return _payload(
                existing,
                now=current,
                origin="cache",
                degraded=False,
                from_cache=True,
                throttled=False,
            )
        newest = _newest(existing)
        if force and newest is not None:
            age = (current - newest).total_seconds()
            if age < min_interval_seconds():
                return _payload(
                    existing,
                    now=current,
                    origin="cache",
                    degraded=False,
                    from_cache=True,
                    throttled=True,
                )
        try:
            catalog = fetch_catalog(transport=transport, sleep=sleep)
        except OkalaFetchError:
            if existing:
                return _payload(
                    existing,
                    now=current,
                    origin="cache",
                    degraded=True,
                    from_cache=True,
                    throttled=False,
                    errors=["okala_unavailable"],
                )
            catalog = {
                "products": load_fixture_products(),
                "origin": "fixture",
                "degraded": True,
                "errors": ["okala_unavailable"],
            }
        previous = _by_key(existing)
        degraded = bool(catalog.get("degraded"))
        origin = catalog.get("origin") or "fixture"
        rows: list[dict[str, Any]] = []
        for name in wanted:
            match = best_match(name, catalog["products"])
            key = store.identity_key(store.display_name(name))
            if match is None and degraded and previous.get(key, {}).get("matched"):
                kept = dict(previous[key])
                rows.append(kept)
                continue
            rows.append(_row_from_match(name, match, origin, current))
        chosen.save_rows(rows)
        # Keep older rows that this refresh did not ask about.
        saved = _by_key(chosen.load_all())
        for row in rows:
            saved[row["name_key"]] = row
        return _payload(
            list(saved.values()),
            now=current,
            origin=origin,
            degraded=degraded,
            from_cache=False,
            throttled=False,
            errors=list(catalog.get("errors") or []),
        )
    finally:
        _refresh_lock.release()


def load_prices(now: datetime | None = None, book: PriceBook | None = None) -> dict[str, Any]:
    current = now or _now()
    rows = (book or get_book()).load_all()
    origin = "cache"
    if rows:
        origins = {row.get("origin") for row in rows}
        if origins == {"live"}:
            origin = "live"
        elif origins == {"fixture"}:
            origin = "fixture"
    return _payload(
        rows,
        now=current,
        origin=origin,
        degraded=False,
        from_cache=True,
        throttled=False,
    )


def _line_unit(label: str | None) -> str:
    if not label:
        return ""
    compact = label.replace("\u200c", "").replace(" ", "")
    if compact.startswith("کیلو"):
        return "کیلو"
    if compact.startswith("میلی"):
        return "میلی‌لیتر"
    if compact.startswith("گرم"):
        return "گرم"
    if compact.startswith("لیتر"):
        return "لیتر"
    if compact.startswith("عدد"):
        return "عدد"
    return label


def parse_ingredient_line(raw: Any) -> dict[str, Any] | None:
    text = _ascii_digits(store.display_name(raw).replace("\u200c", " "))
    if not text:
        return None
    match = _LINE_RE.match(text)
    if not match:
        name = store.display_name(text)
        if not name:
            return None
        return {"qty": None, "unit": "", "name": name}
    try:
        qty = float(match.group(1).replace(",", "."))
    except ValueError:
        qty = None
    if qty is not None and (not math.isfinite(qty) or qty < 0):
        qty = None
    name = store.display_name(match.group(3))
    if not name:
        return None
    return {"qty": qty, "unit": _line_unit(match.group(2)), "name": name}


def to_base(qty: float, unit: str) -> tuple[str, float] | None:
    if not math.isfinite(qty) or qty < 0:
        return None
    if unit in {"گرم"}:
        return ("کیلوگرم", qty / 1000)
    if unit in {"کیلو", "کیلوگرم"}:
        return ("کیلوگرم", qty)
    if unit in {"میلی‌لیتر", "میلی لیتر"}:
        return ("لیتر", qty / 1000)
    if unit == "لیتر":
        return ("لیتر", qty)
    if unit == "عدد":
        return ("عدد", qty)
    return None


def lookup_price(name: str, rows: list[dict[str, Any]]) -> dict[str, Any] | None:
    query = tokens(name)
    if not query:
        return None
    best: dict[str, Any] | None = None
    best_len = -1
    for row in rows:
        if not row.get("matched"):
            continue
        row_tokens = tokens(row.get("name"))
        if not row_tokens or len(query) < len(row_tokens):
            continue
        if query[: len(row_tokens)] != row_tokens:
            continue
        if len(row_tokens) > best_len:
            best = row
            best_len = len(row_tokens)
    return best


def _scaled_estimate(estimate: Any, household: int, servings: int) -> int | None:
    if isinstance(estimate, bool) or not isinstance(estimate, (int, float)):
        return None
    number = float(estimate)
    if not math.isfinite(number) or number <= 0:
        return None
    factor = household / servings
    scaled = round_toman(number * factor)
    return scaled or None


def quote_recipe(
    ingredients: Any,
    *,
    household: Any = None,
    servings: Any = None,
    estimate_toman: Any = None,
    now: datetime | None = None,
    book: PriceBook | None = None,
) -> dict[str, Any]:
    current = now or _now()
    people = store.sanitize_household(household)
    base = store.sanitize_servings(servings)
    if base is None:
        base = store.DEFAULT_HOUSEHOLD
    factor = people / base
    rows = (book or get_book()).load_all()
    ttl = ttl_seconds()
    lines = ingredients if isinstance(ingredients, list) else []
    total = 0.0
    priced = 0
    missing = 0
    saw_stale = False
    for raw in lines[: store.MAX_INGREDIENT_LINES]:
        parsed = parse_ingredient_line(raw)
        if parsed is None or parsed["qty"] is None:
            continue
        row = lookup_price(parsed["name"], rows)
        if row is None:
            missing += 1
            continue
        if is_stale(row.get("fetched_at"), current, ttl):
            saw_stale = True
            missing += 1
            continue
        converted = to_base(float(parsed["qty"]) * factor, parsed["unit"] or "")
        pack = row.get("pack_quantity") or 0
        pack_price = row.get("pack_price_toman") or 0
        if (
            converted is None
            or converted[0] != row.get("unit")
            or not pack
            or not pack_price
        ):
            missing += 1
            continue
        total += pack_price * converted[1] / pack
        priced += 1
    estimate = _scaled_estimate(estimate_toman, people, base)
    if priced and missing == 0:
        source = "okala"
        toman = round_toman(total)
    elif priced:
        source = "partial"
        toman = round_toman(total)
    else:
        source = "estimate"
        toman = estimate or 0
    return {
        "ok": True,
        "source": source,
        "toman": toman,
        "estimate_toman": estimate,
        "stale": saw_stale and source == "estimate",
        "household": people,
        "servings": base,
        "priced_lines": priced,
        "missing_lines": missing,
    }


def cart_assist(items: Any, *, book: PriceBook | None = None, now: datetime | None = None) -> dict[str, Any]:
    current = now or _now()
    rows = (book or get_book()).load_all()
    if not isinstance(items, list):
        items = []
    listed: list[dict[str, Any]] = []
    copy_names: list[str] = []
    for raw in items[:MAX_NAMES]:
        if isinstance(raw, str):
            name = store.display_name(raw)
            quantity_label = ""
        elif isinstance(raw, dict):
            name = store.display_name(raw.get("name"))
            label = raw.get("quantity_label", raw.get("quantityLabel", ""))
            quantity_label = store.display_name(label) if isinstance(label, str) else ""
        else:
            continue
        if not name:
            continue
        row = lookup_price(name, rows)
        public = _public_item(row, current, ttl_seconds()) if row else None
        url = public["product_url"] if public else ""
        if len(copy_names) < COPY_LIMIT:
            copy_names.append(name)
        listed.append(
            {
                "name": name,
                "quantity_label": quantity_label,
                "matched": bool(public and public["matched"] and not public["stale"]),
                "product_title": public["product_title"] if public else "",
                "product_url": url,
                "unit_price_toman": public["unit_price_toman"] if public and not public["stale"] else None,
                "unit": public["unit"] if public else "",
            }
        )
    store.reject_secret({"items": listed, "copy": copy_names})
    message = CART_MESSAGE
    truncated = len([item for item in items if isinstance(item, (str, dict))]) > COPY_LIMIT
    if truncated:
        message = CART_MESSAGE + " " + CART_TRUNCATED
    return {
        "ok": True,
        "prefill": False,
        "checkout": False,
        "homepage": HOME_URL,
        "copy_text": "\n".join(copy_names),
        "truncated": truncated,
        "message": message,
        "items": listed,
    }


def start_scheduler() -> None:
    """Optional slow refresh. Off unless OKALA_REFRESH_INTERVAL_SECONDS is set."""
    global _scheduler_started
    interval = periodic_seconds()
    if interval <= 0 or _scheduler_started:
        return
    _scheduler_started = True

    def loop() -> None:
        while True:
            time.sleep(interval)
            try:
                refresh_prices(force=False)
            except Exception as exc:
                logger.warning("okala periodic refresh failed: %s", exc.__class__.__name__)

    threading.Thread(target=loop, name="okala-refresh", daemon=True).start()

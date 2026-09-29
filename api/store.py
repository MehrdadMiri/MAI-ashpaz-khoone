"""Postgres persistence for pantry chips and the 7-day plan.

Rows are keyed by a browser-local id. There are no accounts. The GapGPT key
is never written, logged, or returned. SQL values are parameters.
"""

from __future__ import annotations

import json
import logging
import math
import os
import re
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import psycopg
from psycopg.types.json import Jsonb

logger = logging.getLogger(__name__)

MIGRATION_PATH = Path(__file__).resolve().parent / "migrations" / "001_kitchen_state.sql"

DAYS = ("sat", "sun", "mon", "tue", "wed", "thu", "fri")
MEALS = ("breakfast", "lunch", "dinner")
MAX_PANTRY_ITEMS = 100
MIN_HOUSEHOLD = 1
MAX_HOUSEHOLD = 12
DEFAULT_HOUSEHOLD = 4
MAX_NAME_LENGTH = 40
MAX_BUDGET = 1_000_000_000_000
MAX_RECIPES = 24
MAX_TITLE = 120
MAX_INGREDIENT_LINES = 16
MAX_INGREDIENT_LINE = 80
MAX_STEPS = 12
MAX_STEP_LENGTH = 400
MAX_COST = 10**15
_MIN_SECRET_LEN = 8

USER_ID_RE = re.compile(r"^[A-Za-z0-9_-]{8,64}$")
USER_ID_MESSAGE = (
    "local_user_id must be 8 to 64 letters, digits, underscores, or hyphens"
)
MISSING_USER_MESSAGE = (
    "Send local_user_id in the X-Local-User-Id header, the query string, or the JSON body"
)

_DIGIT_TRANSLATION = str.maketrans("۰۱۲۳۴۵۶۷۸۹٠١٢٣٤٥٦٧٨٩", "01234567890123456789")
_NAME_TRANSLATION = str.maketrans(
    {
        "ي": "ی",
        "ى": "ی",
        "ك": "ک",
        "ة": "ه",
        "ۀ": "ه",
        "\u0640": None,
        "\u200e": None,
        "\u200f": None,
        "\u0000": None,
    }
)
_CONTROL_RE = re.compile(r"[\u0000-\u001F\u007F]")

_schema_lock = threading.Lock()
_schema_ready = False


class StoreError(Exception):
    """Request or storage failure. The message is static and never echoes the payload."""

    def __init__(self, code: str, message: str, http_status: int) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.http_status = http_status

    def to_dict(self) -> dict[str, Any]:
        return {"ok": False, "error": self.code, "message": self.message}


class KitchenStore:
    def load_pantry(self, user_id: str) -> dict[str, Any]:
        raise NotImplementedError

    def save_pantry(self, user_id: str, pantry: Any) -> dict[str, Any]:
        raise NotImplementedError

    def load_plan(self, user_id: str) -> dict[str, Any]:
        raise NotImplementedError

    def save_plan(self, user_id: str, plan: Any) -> dict[str, Any]:
        raise NotImplementedError


def setting(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def postgres_kwargs() -> dict[str, Any]:
    return {
        "host": setting("POSTGRES_HOST") or "db",
        "port": setting("POSTGRES_PORT") or "5432",
        "user": setting("POSTGRES_USER") or "ashpaz",
        "password": os.environ.get("POSTGRES_PASSWORD", "change-me"),
        "dbname": setting("POSTGRES_DB") or "ashpaz",
        "connect_timeout": 3,
    }


def connect():
    return psycopg.connect(**postgres_kwargs())


def configured_secret() -> str:
    raw = os.environ.get("GAP_CODE_API_KEY", "")
    if not isinstance(raw, str):
        return ""
    return raw.strip()


def contains_secret(value: Any, secret: str | None = None) -> bool:
    if secret is None:
        secret = configured_secret()
    if len(secret) < _MIN_SECRET_LEN:
        return False
    if isinstance(value, str):
        return secret in value
    if isinstance(value, list):
        return any(contains_secret(item, secret) for item in value)
    if isinstance(value, dict):
        return any(
            contains_secret(key, secret) or contains_secret(item, secret)
            for key, item in value.items()
        )
    return False


def reject_secret(value: Any) -> None:
    if contains_secret(value):
        raise StoreError("invalid_request", "Request was rejected", 400)


def display_name(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    text = value.translate(_NAME_TRANSLATION)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def identity_key(value: Any) -> str:
    text = display_name(value).replace("\u200c", "").replace("\u200d", "")
    text = re.sub(r"\s+", "", text)
    return text.lower()


# Same three flags as recipe generation. Unknown keys are dropped.
DIET_FILTER_KEYS = ("vegetarian", "no_onion", "diabetic")


def empty_diet_filters() -> dict[str, bool]:
    return {key: False for key in DIET_FILTER_KEYS}


def sanitize_filters(raw: Any) -> dict[str, bool]:
    """Keep only real ``True`` values. A bad flag is stored as off."""
    filters = empty_diet_filters()
    if not isinstance(raw, dict):
        return filters
    for key in DIET_FILTER_KEYS:
        filters[key] = raw.get(key) is True
    return filters


def sanitize_household(raw: Any) -> int:
    """Keep 1–12. Anything else, including a missing value, is the default of 4."""
    if isinstance(raw, bool) or raw is None or raw == "":
        return DEFAULT_HOUSEHOLD
    if isinstance(raw, int):
        number = raw
    elif isinstance(raw, float):
        if not math.isfinite(raw) or not raw.is_integer():
            return DEFAULT_HOUSEHOLD
        number = int(raw)
    elif isinstance(raw, str):
        text = raw.translate(_DIGIT_TRANSLATION)
        text = re.sub(r"[\s,٬،]", "", text)
        if not text.isdigit():
            return DEFAULT_HOUSEHOLD
        number = int(text)
    else:
        return DEFAULT_HOUSEHOLD
    if number < MIN_HOUSEHOLD or number > MAX_HOUSEHOLD:
        return DEFAULT_HOUSEHOLD
    return number


def sanitize_servings(raw: Any) -> int | None:
    """A recipe's base headcount. Missing or unusable values stay unset (base 4 on display)."""
    if isinstance(raw, bool) or raw is None or raw == "":
        return None
    if isinstance(raw, int):
        number = raw
    elif isinstance(raw, float):
        if not math.isfinite(raw) or not raw.is_integer():
            return None
        number = int(raw)
    elif isinstance(raw, str):
        text = raw.translate(_DIGIT_TRANSLATION)
        text = re.sub(r"[\s,٬،]", "", text)
        if not text.isdigit():
            return None
        number = int(text)
    else:
        return None
    if number < MIN_HOUSEHOLD or number > MAX_HOUSEHOLD:
        return None
    return number


def empty_pantry() -> dict[str, Any]:
    return {
        "items": [],
        "budget": "",
        "filters": empty_diet_filters(),
        "household": DEFAULT_HOUSEHOLD,
    }


def empty_day_slots() -> dict[str, None]:
    return {meal: None for meal in MEALS}


def empty_day_used() -> dict[str, bool]:
    return {meal: False for meal in MEALS}


def empty_plan() -> dict[str, Any]:
    return {
        "recipes": [],
        "slots": {day: empty_day_slots() for day in DAYS},
        "used": {day: empty_day_used() for day in DAYS},
    }


def sanitize_budget(raw: Any) -> str:
    if isinstance(raw, bool) or raw is None:
        return ""
    if isinstance(raw, int):
        text = str(raw)
    elif isinstance(raw, float):
        if not math.isfinite(raw) or not raw.is_integer():
            return ""
        text = str(int(raw))
    elif isinstance(raw, str):
        text = raw.translate(_DIGIT_TRANSLATION)
        text = re.sub(r"[\s,٬،]", "", text)
    else:
        return ""
    if not text or not text.isdigit():
        return ""
    value = int(text)
    if value < 0 or value > MAX_BUDGET:
        return ""
    return str(value)


def sanitize_pantry(raw: Any) -> dict[str, Any]:
    state = empty_pantry()
    if not isinstance(raw, dict):
        return state
    seen: set[str] = set()
    items = raw.get("items")
    if isinstance(items, list):
        for item in items:
            if len(state["items"]) >= MAX_PANTRY_ITEMS:
                break
            if not isinstance(item, str):
                continue
            name = display_name(item)
            key = identity_key(name)
            if not key or len(name) > MAX_NAME_LENGTH or key in seen:
                continue
            seen.add(key)
            state["items"].append(name)
    state["budget"] = sanitize_budget(raw.get("budget", ""))
    state["filters"] = sanitize_filters(raw.get("filters"))
    state["household"] = sanitize_household(raw.get("household", DEFAULT_HOUSEHOLD))
    return state


def clean_line(value: Any, limit: int) -> str:
    if not isinstance(value, str):
        return ""
    text = _CONTROL_RE.sub(" ", value)
    text = re.sub(r"\s+", " ", text).strip()
    if not text:
        return ""
    if len(text) > limit:
        text = text[:limit].strip()
    return text


def clean_list(value: Any, max_items: int, item_limit: int) -> list[str]:
    if not isinstance(value, list):
        return []
    items: list[str] = []
    for item in value:
        if len(items) >= max_items:
            break
        text = clean_line(item, item_limit)
        if text:
            items.append(text)
    return items


def _cost(value: Any) -> int | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if isinstance(value, float):
        if not math.isfinite(value):
            return None
        number = math.floor(value + 0.5)
    else:
        number = value
    if number < 0 or number > MAX_COST:
        return None
    return int(number)


def normalize_recipe(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    title = display_name(clean_line(raw.get("title"), MAX_TITLE))
    key = identity_key(title)
    if not title or not key:
        return None
    recipe: dict[str, Any] = {
        "id": "r:" + key,
        "title": title,
        "ingredients": clean_list(raw.get("ingredients"), MAX_INGREDIENT_LINES, MAX_INGREDIENT_LINE),
        "steps": clean_list(raw.get("steps"), MAX_STEPS, MAX_STEP_LENGTH),
        "cost_toman": _cost(raw.get("cost_toman")),
    }
    servings = sanitize_servings(raw.get("servings"))
    if servings is not None:
        recipe["servings"] = servings
    return recipe


def _assigned_ids(slots: dict[str, Any]) -> set[str]:
    found: set[str] = set()
    for value in slots.values():
        if isinstance(value, str) and value:
            found.add(value)
        elif isinstance(value, dict):
            for meal_id in value.values():
                if isinstance(meal_id, str) and meal_id:
                    found.add(meal_id)
    return found


def _read_day_slots(raw: Any) -> dict[str, str | None]:
    """A string on the day is the older dinner-only save."""
    meals = empty_day_slots()
    if isinstance(raw, str):
        meals["dinner"] = raw
        return meals
    if isinstance(raw, dict):
        for meal in MEALS:
            slot_id = raw.get(meal)
            meals[meal] = slot_id if isinstance(slot_id, str) else None
    return meals


def _read_day_used(raw: Any, meals: dict[str, str | None]) -> dict[str, bool]:
    used = empty_day_used()
    if isinstance(raw, bool):
        used["dinner"] = bool(meals["dinner"]) and raw
        return used
    if isinstance(raw, dict):
        for meal in MEALS:
            used[meal] = bool(meals[meal]) and raw.get(meal) is True
    return used


def _prune_recipes(recipes: list[dict[str, Any]], slots: dict[str, Any]) -> list[dict[str, Any]]:
    if len(recipes) <= MAX_RECIPES:
        return recipes
    assigned = _assigned_ids(slots)
    kept = [recipe for recipe in recipes if recipe["id"] in assigned]
    rest = [recipe for recipe in recipes if recipe["id"] not in assigned]
    room = MAX_RECIPES - len(kept)
    if room < 0:
        room = 0
    if len(rest) > room:
        rest = rest[-room:]
    return kept + rest


def sanitize_plan(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raw = {}
    recipes: list[dict[str, Any]] = []
    seen: dict[str, dict[str, Any]] = {}
    incoming = raw.get("recipes")
    if isinstance(incoming, list):
        for item in incoming:
            recipe = normalize_recipe(item)
            if not recipe or recipe["id"] in seen:
                continue
            seen[recipe["id"]] = recipe
            recipes.append(recipe)
    slots_in = raw.get("slots") if isinstance(raw.get("slots"), dict) else {}
    used_in = raw.get("used") if isinstance(raw.get("used"), dict) else {}
    slots: dict[str, dict[str, str | None]] = {}
    used: dict[str, dict[str, bool]] = {}
    for day in DAYS:
        migrated = _read_day_slots(slots_in.get(day))
        day_slots = empty_day_slots()
        for meal in MEALS:
            slot_id = migrated[meal]
            day_slots[meal] = slot_id if isinstance(slot_id, str) and slot_id in seen else None
        slots[day] = day_slots
        used[day] = _read_day_used(used_in.get(day), day_slots)
    recipes = _prune_recipes(recipes, slots)
    live = {recipe["id"] for recipe in recipes}
    for day in DAYS:
        for meal in MEALS:
            if slots[day][meal] not in live:
                slots[day][meal] = None
                used[day][meal] = False
    return {"recipes": recipes, "slots": slots, "used": used}


def prepare_pantry(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise StoreError("invalid_pantry", "Pantry must be an object", 400)
    reject_secret(raw)
    clean = sanitize_pantry(raw)
    reject_secret(clean)
    return clean


def prepare_plan(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise StoreError("invalid_plan", "Plan must be an object", 400)
    reject_secret(raw)
    clean = sanitize_plan(raw)
    reject_secret(clean)
    return clean


def require_user_id(value: Any) -> str:
    if not isinstance(value, str) or len(value) > 80:
        raise StoreError("invalid_user", USER_ID_MESSAGE, 400)
    text = value.strip()
    if not USER_ID_RE.fullmatch(text):
        raise StoreError("invalid_user", USER_ID_MESSAGE, 400)
    reject_secret(text)
    return text


def user_id_from_request(req: Any, body: dict[str, Any] | None = None) -> str:
    header = req.headers.get("X-Local-User-Id")
    query = req.args.get("local_user_id")
    has_body_id = isinstance(body, dict) and "local_user_id" in body
    for candidate in (header, query):
        if isinstance(candidate, str):
            text = candidate.strip()
            if text:
                return require_user_id(candidate)
        elif candidate is not None:
            raise StoreError("invalid_user", USER_ID_MESSAGE, 400)
    if has_body_id:
        body_id = body.get("local_user_id") if isinstance(body, dict) else None
        if not isinstance(body_id, str):
            raise StoreError("invalid_user", USER_ID_MESSAGE, 400)
        if body_id.strip():
            return require_user_id(body_id)
    raise StoreError("missing_user", MISSING_USER_MESSAGE, 400)


def read_json_object(req: Any) -> dict[str, Any]:
    data = req.get_json(silent=True)
    if not isinstance(data, dict):
        raise StoreError("invalid_request", "Request must be a JSON object", 400)
    reject_secret(data)
    return data


def _iso(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.isoformat()
    return str(value)


def _as_object(value: Any) -> dict[str, Any]:
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError:
            return {}
    if isinstance(value, dict):
        return value
    return {}


def _db_unavailable(action: str, exc: BaseException) -> None:
    logger.warning("%s: %s", action, exc.__class__.__name__)
    raise StoreError("database_unavailable", "Saved kitchen data is unavailable", 503) from None


def _statements(sql: str) -> list[str]:
    parts: list[str] = []
    current: list[str] = []
    for line in sql.splitlines():
        stripped = line.strip()
        if stripped.startswith("--"):
            continue
        current.append(line)
        if stripped.endswith(";"):
            text = "\n".join(current).strip()
            if text:
                parts.append(text)
            current = []
    tail = "\n".join(current).strip()
    if tail:
        parts.append(tail)
    return parts


def reset_schema_ready() -> None:
    global _schema_ready
    with _schema_lock:
        _schema_ready = False


def mark_schema_ready() -> None:
    global _schema_ready
    with _schema_lock:
        _schema_ready = True


def ensure_schema(conn: Any) -> None:
    if _schema_ready:
        return
    with _schema_lock:
        if _schema_ready:
            return
        for statement in _statements(MIGRATION_PATH.read_text(encoding="utf-8")):
            conn.execute(statement)


def ping() -> bool:
    try:
        with connect() as conn:
            ensure_schema(conn)
            conn.execute("SELECT 1").fetchone()
    except Exception as exc:
        logger.warning("database check failed: %s", exc.__class__.__name__)
        return False
    mark_schema_ready()
    return True


def _pantry_payload(found: bool, pantry: dict[str, Any], updated_at: Any) -> dict[str, Any]:
    return {
        "ok": True,
        "found": found,
        "pantry": pantry,
        "updated_at": _iso(updated_at) if found else None,
    }


def _plan_payload(found: bool, plan: dict[str, Any], updated_at: Any) -> dict[str, Any]:
    return {
        "ok": True,
        "found": found,
        "plan": plan,
        "updated_at": _iso(updated_at) if found else None,
    }


class MemoryKitchen(KitchenStore):
    """In-memory stand-in for tests. Not used by the running api."""

    def __init__(self) -> None:
        self.pantries: dict[str, tuple[dict[str, Any], str]] = {}
        self.plans: dict[str, tuple[dict[str, Any], str]] = {}

    def load_pantry(self, user_id: str) -> dict[str, Any]:
        user_id = require_user_id(user_id)
        row = self.pantries.get(user_id)
        if row is None:
            return _pantry_payload(False, empty_pantry(), None)
        pantry, updated = row
        return _pantry_payload(True, sanitize_pantry(pantry), updated)

    def save_pantry(self, user_id: str, pantry: Any) -> dict[str, Any]:
        user_id = require_user_id(user_id)
        clean = prepare_pantry(pantry)
        updated = datetime.now(timezone.utc).isoformat()
        self.pantries[user_id] = (clean, updated)
        return _pantry_payload(True, clean, updated)

    def load_plan(self, user_id: str) -> dict[str, Any]:
        user_id = require_user_id(user_id)
        row = self.plans.get(user_id)
        if row is None:
            return _plan_payload(False, empty_plan(), None)
        plan, updated = row
        return _plan_payload(True, sanitize_plan(plan), updated)

    def save_plan(self, user_id: str, plan: Any) -> dict[str, Any]:
        user_id = require_user_id(user_id)
        clean = prepare_plan(plan)
        updated = datetime.now(timezone.utc).isoformat()
        self.plans[user_id] = (clean, updated)
        return _plan_payload(True, clean, updated)


class PostgresKitchen(KitchenStore):
    def load_pantry(self, user_id: str) -> dict[str, Any]:
        user_id = require_user_id(user_id)
        try:
            with connect() as conn:
                ensure_schema(conn)
                row = conn.execute(
                    "SELECT pantry, updated_at FROM pantry_state WHERE local_user_id = %s",
                    (user_id,),
                ).fetchone()
        except StoreError:
            raise
        except Exception as exc:
            _db_unavailable("pantry load failed", exc)
        mark_schema_ready()
        if row is None:
            return _pantry_payload(False, empty_pantry(), None)
        return _pantry_payload(True, sanitize_pantry(_as_object(row[0])), row[1])

    def save_pantry(self, user_id: str, pantry: Any) -> dict[str, Any]:
        user_id = require_user_id(user_id)
        clean = prepare_pantry(pantry)
        try:
            with connect() as conn:
                ensure_schema(conn)
                row = conn.execute(
                    """
                    INSERT INTO pantry_state (local_user_id, pantry)
                    VALUES (%s, %s)
                    ON CONFLICT (local_user_id) DO UPDATE
                    SET pantry = EXCLUDED.pantry,
                        updated_at = now()
                    RETURNING updated_at
                    """,
                    (user_id, Jsonb(clean)),
                ).fetchone()
        except StoreError:
            raise
        except Exception as exc:
            _db_unavailable("pantry save failed", exc)
        mark_schema_ready()
        if row is None:
            _db_unavailable("pantry save failed", RuntimeError("missing row"))
        return _pantry_payload(True, clean, row[0])

    def load_plan(self, user_id: str) -> dict[str, Any]:
        user_id = require_user_id(user_id)
        try:
            with connect() as conn:
                ensure_schema(conn)
                row = conn.execute(
                    "SELECT plan, updated_at FROM week_plan_state WHERE local_user_id = %s",
                    (user_id,),
                ).fetchone()
        except StoreError:
            raise
        except Exception as exc:
            _db_unavailable("plan load failed", exc)
        mark_schema_ready()
        if row is None:
            return _plan_payload(False, empty_plan(), None)
        return _plan_payload(True, sanitize_plan(_as_object(row[0])), row[1])

    def save_plan(self, user_id: str, plan: Any) -> dict[str, Any]:
        user_id = require_user_id(user_id)
        clean = prepare_plan(plan)
        try:
            with connect() as conn:
                ensure_schema(conn)
                row = conn.execute(
                    """
                    INSERT INTO week_plan_state (local_user_id, plan)
                    VALUES (%s, %s)
                    ON CONFLICT (local_user_id) DO UPDATE
                    SET plan = EXCLUDED.plan,
                        updated_at = now()
                    RETURNING updated_at
                    """,
                    (user_id, Jsonb(clean)),
                ).fetchone()
        except StoreError:
            raise
        except Exception as exc:
            _db_unavailable("plan save failed", exc)
        mark_schema_ready()
        if row is None:
            _db_unavailable("plan save failed", RuntimeError("missing row"))
        return _plan_payload(True, clean, row[0])


_store: KitchenStore | None = None


def get_store() -> KitchenStore:
    global _store
    if _store is None:
        _store = PostgresKitchen()
    return _store

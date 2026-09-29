"""Ashpaz-khoone API.

The shared GapGPT client lives in gapgpt.py. /health reports whether a key
is configured and does not call the model. POST /gapgpt/smoke sends one
fixed chat completion when GAP_CODE_API_KEY is set. POST /recipes/generate
asks that client for Persian recipes from pantry items and a week budget.
Leftover fields prefer remaining chips and skip eaten dinners. ``full``
ignores that skip.
POST /vision/fridge sends one or more fridge photos, in order, to that
client's vision call and returns candidate ingredient names with confidence.
It does not store them.
"""

import json
import os

import psycopg
from flask import Flask, jsonify, request
from werkzeug.exceptions import HTTPException

from gapgpt import MAX_FRIDGE_IMAGES, MAX_IMAGE_BYTES, GapGPTClient, GapGPTConfig, GapGPTError
from recipes import (
    RECIPE_CLIENT_TIMEOUT,
    RecipeRequestError,
    generate_recipes,
    parse_generate_body,
)
from vision import (
    VISION_CLIENT_TIMEOUT,
    VisionRequestError,
    read_fridge_request,
    recognize_fridge,
)

# Recipe JSON stays small. Fridge photos need a higher cap; nginx matches it.
# Each photo may arrive as base64 (about 4/3) plus a short JSON wrapper.
JSON_MAX_BYTES = 64 * 1024
_PER_IMAGE_BODY = ((MAX_IMAGE_BYTES + 2) // 3) * 4 + 2048
VISION_REQUEST_MAX_BYTES = MAX_FRIDGE_IMAGES * _PER_IMAGE_BODY + 65536

class ApiPrefixMiddleware:
    """Treat /api/... as an alias of /... so nginx can forward the path unchanged."""

    def __init__(self, wsgi):
        self.wsgi = wsgi

    def __call__(self, environ, start_response):
        path = environ.get("PATH_INFO") or ""
        if path == "/api":
            environ["PATH_INFO"] = "/"
        elif path.startswith("/api/"):
            environ["PATH_INFO"] = path[4:] or "/"
        return self.wsgi(environ, start_response)


app = Flask(__name__)
app.wsgi_app = ApiPrefixMiddleware(app.wsgi_app)
# Insertion order, so documented smoke JSON matches the response body.
app.json.sort_keys = False
app.json.ensure_ascii = False
# Fridge uploads are the largest accepted body. Other routes stay at JSON_MAX_BYTES
# via before_request. Non-file form fields stay small; photos are file parts.
app.config["MAX_CONTENT_LENGTH"] = VISION_REQUEST_MAX_BYTES
app.config["MAX_FORM_MEMORY_SIZE"] = JSON_MAX_BYTES


def setting(name, default=""):
    return os.environ.get(name, default).strip()


def gapgpt_status():
    # Report whether a key is present. Never include the key itself.
    return GapGPTConfig.from_env().public_status()


def build_gapgpt_client(timeout=None):
    if timeout is None:
        return GapGPTClient()
    return GapGPTClient(timeout=timeout)


def database_ok():
    try:
        with psycopg.connect(
            host=setting("POSTGRES_HOST") or "db",
            port=setting("POSTGRES_PORT") or "5432",
            user=setting("POSTGRES_USER") or "ashpaz",
            password=os.environ.get("POSTGRES_PASSWORD", "change-me"),
            dbname=setting("POSTGRES_DB") or "ashpaz",
            connect_timeout=3,
        ) as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT 1")
                cur.fetchone()
        return True
    except Exception as exc:
        app.logger.warning("database check failed: %s", exc.__class__.__name__)
        return False


def scrub_public_body(raw: bytes) -> bytes:
    """Drop secrets and stack traces from a JSON response body.

    The configured key is removed only when it is long enough that replacing
    it cannot rewrite ordinary words. Tracebacks are replaced with a static
    JSON error so a leaked stack never reaches the browser.
    """
    if not isinstance(raw, (bytes, bytearray)):
        return raw
    body = bytes(raw)
    secret = os.environ.get("GAP_CODE_API_KEY", "")
    if isinstance(secret, str):
        secret = secret.strip()
    else:
        secret = ""
    if len(secret) >= 8:
        token = secret.encode("utf-8")
        if token in body:
            body = body.replace(token, b"[redacted]")
        escaped = json.dumps(secret)[1:-1].encode("utf-8")
        if escaped != token and escaped in body:
            body = body.replace(escaped, b"[redacted]")
    if b"Traceback (most recent call last)" in body:
        body = b'{"ok":false,"error":"internal_error","message":"Request failed"}'
    return body


def respond_gapgpt(fn, failure_message):
    """Run a GapGPT call and return JSON. Unexpected failures omit exception text."""
    try:
        return jsonify(fn())
    except GapGPTError as exc:
        return jsonify(exc.to_dict()), exc.http_status
    except Exception as exc:
        app.logger.warning("gapgpt call failed: %s", exc.__class__.__name__)
        return (
            jsonify(
                {
                    "ok": False,
                    "error": "internal_error",
                    "message": failure_message,
                }
            ),
            500,
        )


@app.before_request
def limit_request_body():
    length = request.content_length
    if length is None:
        return None
    if request.path == "/vision/fridge":
        limit = VISION_REQUEST_MAX_BYTES
    else:
        limit = JSON_MAX_BYTES
    if length > limit:
        return request_too_large(None)
    return None


@app.after_request
def scrub_json_response(response):
    mimetype = response.mimetype or ""
    if mimetype != "application/json":
        return response
    try:
        raw = response.get_data()
    except Exception:
        return response
    cleaned = scrub_public_body(raw)
    if cleaned == raw:
        return response
    response.set_data(cleaned)
    return response


@app.errorhandler(Exception)
def unhandled_error(exc):
    """JSON only. HTTP errors keep their status. The body never includes the key."""
    if isinstance(exc, HTTPException):
        return exc
    app.logger.warning("unhandled error: %s", exc.__class__.__name__)
    return (
        jsonify(
            {
                "ok": False,
                "error": "internal_error",
                "message": "Request failed",
            }
        ),
        500,
    )


@app.errorhandler(413)
def request_too_large(_exc):
    return (
        jsonify(
            {
                "ok": False,
                "error": "invalid_request",
                "message": "Request is too large",
            }
        ),
        413,
    )


@app.get("/")
def root():
    return jsonify(
        {
            "service": "api",
            "name": "ashpaz-khoone",
            "health": "/health",
            "gapgpt_smoke": "/gapgpt/smoke",
            "recipes_generate": "/recipes/generate",
            "vision_fridge": "/vision/fridge",
        }
    )


@app.get("/health")
def health():
    db_ok = database_ok()
    body = {
        "status": "ok" if db_ok else "unavailable",
        "service": "api",
        "database": "ok" if db_ok else "unavailable",
        "gapgpt": gapgpt_status(),
    }
    return jsonify(body), (200 if db_ok else 503)


@app.get("/gapgpt/smoke")
def gapgpt_smoke_get():
    return (
        jsonify(
            {
                "ok": False,
                "error": "method_not_allowed",
                "message": "Use POST /gapgpt/smoke to run the fixed chat check",
            }
        ),
        405,
    )


@app.post("/gapgpt/smoke")
def gapgpt_smoke():
    # Fixed prompt only. The request body is ignored so this is not an open proxy.
    return respond_gapgpt(
        lambda: build_gapgpt_client().smoke(),
        "GapGPT smoke check failed",
    )


@app.get("/recipes/generate")
def recipes_generate_get():
    return (
        jsonify(
            {
                "ok": False,
                "error": "method_not_allowed",
                "message": "Use POST /recipes/generate",
            }
        ),
        405,
    )


@app.post("/recipes/generate")
def recipes_generate():
    # Body fields are pantry data. Error text stays static and never echoes them.
    try:
        parsed = parse_generate_body(request.get_json(silent=True))
    except RecipeRequestError as exc:
        return jsonify(exc.to_dict()), exc.http_status
    return respond_gapgpt(
        lambda: generate_recipes(
            build_gapgpt_client(timeout=RECIPE_CLIENT_TIMEOUT),
            parsed.ingredients,
            parsed.budget,
            remaining=parsed.remaining,
            skip=parsed.skip,
            full=parsed.full,
        ),
        "Recipe generation failed",
    )


@app.get("/vision/fridge")
def vision_fridge_get():
    return (
        jsonify(
            {
                "ok": False,
                "error": "method_not_allowed",
                "message": "Use POST /vision/fridge",
            }
        ),
        405,
    )


@app.post("/vision/fridge")
def vision_fridge():
    # Photos are untrusted and are not logged. Errors never echo them or the key.
    try:
        images = read_fridge_request(request)
    except VisionRequestError as exc:
        return jsonify(exc.to_dict()), exc.http_status
    return respond_gapgpt(
        lambda: recognize_fridge(
            build_gapgpt_client(timeout=VISION_CLIENT_TIMEOUT),
            images,
        ),
        "Fridge vision failed",
    )

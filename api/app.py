"""Ashpaz-khoone API.

The shared GapGPT client lives in gapgpt.py. /health reports whether a key
is configured and does not call the model. POST /gapgpt/smoke sends one
fixed chat completion when GAP_CODE_API_KEY is set.
"""

import os

import psycopg
from flask import Flask, jsonify

from gapgpt import GapGPTClient, GapGPTConfig, GapGPTError

app = Flask(__name__)
# Insertion order, so documented smoke JSON matches the response body.
app.json.sort_keys = False


def setting(name, default=""):
    return os.environ.get(name, default).strip()


def gapgpt_status():
    # Report whether a key is present. Never include the key itself.
    return GapGPTConfig.from_env().public_status()


def build_gapgpt_client():
    return GapGPTClient()


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


@app.get("/")
def root():
    return jsonify(
        {
            "service": "api",
            "name": "ashpaz-khoone",
            "health": "/health",
            "gapgpt_smoke": "/gapgpt/smoke",
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

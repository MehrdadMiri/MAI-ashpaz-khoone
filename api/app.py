"""Ashpaz-khoone API scaffold.

Later tickets add the GapGPT client, pantry, recipes, and meal plan.
This process starts when GAP_CODE_API_KEY is unset. /health stays OK either way.
"""

import os

import psycopg
from flask import Flask, jsonify

app = Flask(__name__)


def setting(name, default=""):
    return os.environ.get(name, default).strip()


def gapgpt_status():
    # Report whether a key is present. Never include the key itself.
    return {
        "configured": bool(setting("GAP_CODE_API_KEY")),
        "base_url": setting("GAPGPT_BASE_URL") or "https://api.gapgpt.app/v1",
        "model": setting("GAPGPT_MODEL") or "gpt-5.6-luna",
    }


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


@app.get("/")
def root():
    return jsonify(
        {
            "service": "api",
            "name": "ashpaz-khoone",
            "health": "/health",
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

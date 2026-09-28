# MAI-ashpaz-khoone

Persian RTL AI meal and recipe demo (آشپزخونه).

`docker compose up --build` starts three services.

| Service | Image | URL |
| --- | --- | --- |
| web | nginx, static landing page | http://localhost:8080 |
| api | Python (Flask + Gunicorn) | http://localhost:8000 |
| db | Postgres 16 | localhost:5432 |

The API includes a shared GapGPT client (`api/gapgpt.py`) for later recipe and fridge-vision work. Later tickets add pantry, recipes, fridge vision, and the meal plan. Product UI will be Persian RTL. This scaffold’s docs and code comments are English. The landing page title is آشپزخونه.

The GitHub repository is public.

## Run

```bash
docker compose up --build
```

The stack starts with no API key. `/health` stays OK when `GAP_CODE_API_KEY` is unset. Chat calls use that variable; see [GapGPT client](#gapgpt-client) below.

To set local variables, copy the example file and edit it. Compose reads `.env` from this directory (and the shell) and passes `GAP_CODE_API_KEY` into the **api** service.

```bash
cp .env.example .env
docker compose up --build
```

Stop the stack with `docker compose down`. Postgres data lives in the `pgdata` volume. `docker compose down -v` removes that volume. The database is initialized from `POSTGRES_*` on first start, so change those only on an empty volume.

## Environment variables

| Variable | Required to boot | Default |
| --- | --- | --- |
| `GAP_CODE_API_KEY` | No | empty |
| `GAPGPT_BASE_URL` | No | `https://api.gapgpt.app/v1` |
| `GAPGPT_MODEL` | No | `gpt-5.6-luna` |
| `POSTGRES_USER` | No | `ashpaz` |
| `POSTGRES_PASSWORD` | No | `change-me` |
| `POSTGRES_DB` | No | `ashpaz` |

`.env.example` has placeholders only. `.gitignore` excludes `.env`. Do not commit `GAP_CODE_API_KEY` or any real key. Put the key only in the environment or the gitignored `.env`. Do not put it in URLs, command lines, or logs.

## GapGPT client

`api/gapgpt.py` is the shared OpenAI-compatible client. It reads configuration from the environment only and posts to `{GAPGPT_BASE_URL}/chat/completions` with `Authorization: Bearer <GAP_CODE_API_KEY>`.

| Variable | Default |
| --- | --- |
| `GAP_CODE_API_KEY` | empty (calls fail with a controlled error until this is set) |
| `GAPGPT_BASE_URL` | `https://api.gapgpt.app/v1` |
| `GAPGPT_MODEL` | `gpt-5.6-luna` |

```python
from gapgpt import GapGPTClient

text = GapGPTClient().chat_text([
    {"role": "user", "content": "سلام"},
])
```

`chat` returns the JSON object. `content` may be a string or a list of parts, so a later vision call can pass image parts through the same client. The key is not written to logs, error messages, or return values.

`/health` reports `gapgpt.configured`, `base_url`, and `model`. It does not call the model. `POST /gapgpt/smoke` sends one fixed prompt (`Reply with exactly: pong`). A request body is ignored, so the route cannot forward a caller-supplied prompt.

| Situation | HTTP | `error` |
| --- | --- | --- |
| Key missing | 503 | `not_configured` |
| Upstream rejects the key (401/403) | 502 | `unauthorized` |
| GapGPT unreachable | 502 | `upstream_unavailable` |
| Timeout | 504 | `timeout` |
| Other upstream HTTP error | 502 | `upstream_error` |
| Success | 200 | `ok: true` plus `reply` |

## Demo path (QA)

1. From a clean shell (no `GAP_CODE_API_KEY` in the environment, and no real key in `.env`), run `docker compose up --build`.
2. Wait until `web`, `api`, and `db` are running. `docker compose ps` should show them healthy.
3. Open http://localhost:8080 and confirm the آشپزخونه landing page.
4. Confirm web health:

   ```bash
   curl -fsS http://localhost:8080/health
   ```

   Expected body: `ok`.

5. Confirm API health, including the database:

   ```bash
   curl -fsS http://localhost:8000/health
   ```

   Expected JSON includes `"status": "ok"`, `"database": "ok"`, and `"gapgpt": {"configured": false, "base_url": "https://api.gapgpt.app/v1", "model": "gpt-5.6-luna"}`.

6. Optional: set `GAP_CODE_API_KEY` in `.env` (or the shell) and recreate the api service (`docker compose up -d --force-recreate api`). `/health` stays OK. `gapgpt.configured` becomes `true` when the variable is non-empty. The key is not returned by the API.

## GapGPT checks (SE/QA)

Unit tests mock HTTP or talk to a local socket. They do not need a key and do not call GapGPT. `LiveSmokeTest` is skipped unless you opt in.

```bash
cd api
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python -m unittest discover -s tests -v
```

Expected: every test OK, with `LiveSmokeTest` skipped.

Smoke check without a key (controlled error, no stack trace). The stack from the demo path can already be running:

```bash
curl -sS -X POST http://localhost:8000/gapgpt/smoke -w "\nHTTP %{http_code}\n"
```

Expected HTTP 503:

```json
{"ok":false,"error":"not_configured","message":"GAP_CODE_API_KEY is not set"}
```

The same check inside the api container:

```bash
docker compose exec api python gapgpt.py status
docker compose exec api python gapgpt.py smoke
```

`status` prints `configured`, `base_url`, and `model` only. `smoke` exits 1 when the key is missing and prints the same JSON. `GET /gapgpt/smoke` returns HTTP 405; the check is POST only.

Invalid key: put a non-empty placeholder such as `invalid` in the gitignored `.env` (not a real key), recreate api, and POST `/gapgpt/smoke` again. Expected HTTP 502 and `"error": "unauthorized"`. The body has no stack trace and no key value.

Live call when a real key is available: write it only to the gitignored `.env` or the environment, then recreate the api service. Do not paste the key into the shell history, git, or this file.

```bash
docker compose up -d --build --force-recreate api
curl -sS -X POST http://localhost:8000/gapgpt/smoke -w "\nHTTP %{http_code}\n"
```

Expected HTTP 200 and JSON with `"ok": true`, the model name, and a short `reply`. The API key must not appear in the body.

Optional live unit test, from `api/` with the key already in the environment:

```bash
GAPGPT_LIVE_SMOKE=1 .venv/bin/python -m unittest tests.test_gapgpt.LiveSmokeTest -v
```

If `GAPGPT_LIVE_SMOKE` is unset, that test skips. If the flag is set and the key is missing, the test fails with `GAP_CODE_API_KEY is not set` and does not print a key.

# MAI-ashpaz-khoone

Persian RTL AI meal and recipe demo (آشپزخونه).

`docker compose up --build` starts three services.

| Service | Image | URL |
| --- | --- | --- |
| web | nginx, Persian pantry UI | http://localhost:8080 |
| api | Python (Flask + Gunicorn) | http://localhost:8000 |
| db | Postgres 16 | localhost:5432 |

The web page is a Persian RTL pantry. You can add and remove ingredient chips, load a sample set of Iranian staples, and set a numeric week budget. The list and budget stay in this browser (`localStorage`); they are not stored in Postgres. «پیشنهاد دستور» asks the shared GapGPT client (`api/gapgpt.py`) for at least three Persian recipes from those chips and the week budget. «عکس یخچال» sends one photo to the same client and shows candidate chips; nothing is added to the pantry until you confirm. Later tickets add the meal plan. Product UI is Persian RTL. This scaffold’s docs and code comments are English.

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

`chat` returns the JSON object. `content` may be a string or a list of parts. `chat_with_image` builds that list for one image (`image_url` data URL) and posts it to the same `/chat/completions` endpoint. Fridge vision uses it. The key is not written to logs, error messages, or return values. Image bytes are not written to logs or API responses.

`/health` reports `gapgpt.configured`, `base_url`, and `model`. It does not call the model. `POST /gapgpt/smoke` sends one fixed prompt (`Reply with exactly: pong`). A request body is ignored, so the route cannot forward a caller-supplied prompt.

| Situation | HTTP | `error` |
| --- | --- | --- |
| Key missing | 503 | `not_configured` |
| Upstream rejects the key (401/403) | 502 | `unauthorized` |
| GapGPT unreachable | 502 | `upstream_unavailable` |
| Timeout | 504 | `timeout` |
| Other upstream HTTP error | 502 | `upstream_error` |
| Success | 200 | `ok: true` plus `reply` |

## Pantry UI

After `docker compose up --build`, open http://localhost:8080.

The page is Persian, right to left, and set in Vazirmatn. On a new browser the kitchen is empty and shows «هنوز چیزی در آشپزخانه نیست».

- «بارگذاری نمونه» loads eight staples: برنج، پیاز، عدس، لوبیا، سیب‌زمینی، گوجه‌فرنگی، ماست، روغن. Loading again does not duplicate them.
- Type a name and press «افزودن». The same name, including extra spaces and Arabic/Persian letter variants, is ignored.
- Tap a chip to remove it. «پاک کردن» empties the list and leaves the week budget as it is. «بارگذاری نمونه» then restores those eight staples.
- «بودجه هفته» in the header is the numeric week budget in تومان. Reload the page and it is still there.

Ingredient rules without a browser:

```bash
node --test web/pantry.test.js
```

Web `/health` is unchanged.

## Recipe suggestions

«پیشنهاد دستور» is on the pantry page. It sends the chips and the week budget already stored by the pantry (`AshpazPantry`) to `POST /api/recipes/generate`.

The browser calls `http://localhost:8080/api/recipes/generate`. Nginx proxies `/api/` to the api service and forwards that path. The api accepts `/api/...` as an alias of the same routes, so `POST /recipes/generate` on port 8000 and `POST /api/recipes/generate` on port 8080 are the same call. The web `/health` check is still the nginx `ok` response. API health through the proxy is `http://localhost:8080/api/health`.

The request JSON is `{ "ingredients": ["برنج"], "budget": 1500000 }`. `budget` may be `null` when the week field is empty; the model prompt still includes that budget context. The api service calls GapGPT with `GapGPTClient.chat_text` and the configured model (`gpt-5.6-luna` unless `GAPGPT_MODEL` is set). The key stays in the api container. The page never receives it.

A successful body is `ok: true` and `recipes` with three objects. Each object has `title`, `ingredients`, `steps`, and `cost_toman` (`null` when the model gives no number). The page shows those as RTL cards: title, ingredient tags, steps, and a rough cost badge when a cost is present. «افزودن به برنامه» is on each card and disabled until the meal-plan ticket.

While the request is in flight the status line is «در حال پختن ایده‌ها…» and both «پیشنهاد دستور» and «تلاش دوباره» are disabled, so a second click does not send another request. Failures stay on the page as short Persian text plus «تلاش دوباره». The page does not show stack traces, upstream bodies, or the API key.

| Situation | HTTP | `error` | What the page says |
| --- | --- | --- | --- |
| No pantry items | 400 | `empty_ingredients` | ask for at least one ingredient (the page does this before calling) |
| Bad budget | 400 | `invalid_budget` | the week budget is not a number |
| Key missing | 503 | `not_configured` | the suggestion service is not ready |
| Upstream rejects the key | 502 | `unauthorized` | friendly retry |
| Timeout | 504 | `timeout` | friendly retry |
| Unreadable model output, or fewer than three usable recipes | 502 | `bad_response` | friendly retry |

The model is asked for Iranian home cooking in Persian that prefers the pantry names. QA should spot-check that the cards use those names.

Checks without a browser:

```bash
node --test web/recipes.test.js
```

## Fridge photo

«عکس یخچال» is on the pantry page. It does not add anything by itself.

1. Open «عکس یخچال». «گرفتن عکس» calls `getUserMedia` with `facingMode: environment` (the back camera when the phone has one) and shows a preview. «انتخاب عکس» opens a file picker.
2. If the camera API is missing, «گرفتن عکس» uses a file input with `capture="environment"`.
3. If the camera is denied or fails, the sheet says «دسترسی به دوربین داده نشد. می‌توانید یک عکس انتخاب کنید.» and leaves the file picker. It does not keep asking for the camera.
4. The chosen frame is posted as multipart field `image` to `POST /api/vision/fridge` (nginx) or `POST /vision/fridge` (api port 8000). Same `/api/` proxy as recipes.
5. While that request runs, the sheet says «در حال تشخیص مواد…».
6. The api service calls `GapGPTClient.chat_with_image` with model `gpt-5.6-luna` unless `GAPGPT_MODEL` is set. The model is asked for Persian food names as JSON. The response to the browser is `{"ok": true, "ingredients": ["شیر", "تخم‌مرغ"]}`. An empty list means no food was recognized. Names are not stored on the server.
7. The confirm sheet shows those names as chips you can uncheck or edit, and a field to add another name. «انصراف» or closing the sheet leaves the pantry as it was.
8. «تأیید و افزودن به انبار» merges only the checked names with the same dedupe rules as typing a chip (spacing and Arabic/Persian letter variants count as the same item). After that, the chips are the normal pantry chips: tap one to remove it.

The page maps failures to short Persian text and «تلاش دوباره». It does not show the server message, stack traces, the photo, or the API key.

| Situation | HTTP | `error` | What the page says |
| --- | --- | --- | --- |
| Not an image, or not JPEG/PNG/WEBP/GIF | 400 | `invalid_image` | choose a JPEG or PNG |
| Image larger than 6 MB | 413 | `image_too_large` | choose a smaller photo |
| Key missing | 503 | `not_configured` | the vision service is not ready |
| Upstream rejects the key | 502 | `unauthorized` | friendly retry |
| Timeout | 504 | `timeout` | friendly retry |
| Unreadable model output | 502 | `bad_response` | friendly retry |
| No food in a readable answer | 200 | — | empty confirm sheet; you can type a name |

JPEG, PNG, WEBP, and GIF are detected from magic bytes. The declared file type is not trusted. SVG and HTML are rejected.

Checks without a browser:

```bash
node --test web/fridge.test.js
```

## Demo path (QA)

1. From a clean shell (no `GAP_CODE_API_KEY` in the environment, and no real key in `.env`), run `docker compose up --build`.
2. Wait until `web`, `api`, and `db` are running. `docker compose ps` should show them healthy.
3. Open http://localhost:8080 and confirm the آشپزخونه pantry (empty state, then «بارگذاری نمونه»). See [Pantry UI](#pantry-ui).
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

7. Open http://localhost:8080. Click «عکس یخچال», then «انتخاب عکس», and pick a JPEG. Without a key, the sheet shows «در حال تشخیص مواد…» and then a Persian message that the vision service is not ready, with «تلاش دوباره». The pantry chips do not change. Closing the sheet also leaves the pantry unchanged.

   The same check from the shell (a tiny JPEG, not a real photo):

   ```bash
   python3 - <<'PY'
   from pathlib import Path
   Path("/tmp/fridge.jpg").write_bytes(bytes.fromhex("ffd8ffe000104a46494600010100000100010000ffd9"))
   PY
   curl -sS -X POST http://localhost:8000/vision/fridge \
     -F "image=@/tmp/fridge.jpg;type=image/jpeg" \
     -w "\nHTTP %{http_code}\n"
   ```

   Expected HTTP 503 and `"error": "not_configured"`. No stack trace, no API key, and no image bytes in the body. The proxied path is the same call:

   ```bash
   curl -sS -X POST http://localhost:8080/api/vision/fridge \
     -F "image=@/tmp/fridge.jpg;type=image/jpeg"
   ```

8. Open http://localhost:8080. Click «بارگذاری نمونه» and set «بودجه هفته» to a number such as `1500000`. Click «پیشنهاد دستور».

   Without a key, the status line shows «در حال پختن ایده‌ها…» and then a Persian message that the suggestion service is not ready, with «تلاش دوباره». The page does not show a stack trace or a key. An empty pantry does not call the API; it asks you to add an ingredient.

   The same check from the shell:

   ```bash
   curl -sS -X POST http://localhost:8000/recipes/generate \
     -H 'Content-Type: application/json' \
     -d '{"ingredients":["برنج","عدس","پیاز"],"budget":1500000}' \
     -w "\nHTTP %{http_code}\n"
   ```

   Expected HTTP 503 and `"error": "not_configured"`. No stack trace and no key. The proxied path is the same JSON:

   ```bash
   curl -sS -X POST http://localhost:8080/api/recipes/generate \
     -H 'Content-Type: application/json' \
     -d '{"ingredients":["برنج","عدس","پیاز"],"budget":1500000}'
   ```

9. With a real key only in the gitignored `.env` or the environment, recreate the api service and repeat step 8. After the loading line, at least three Persian cards appear. Each card has a title, ingredient tags, and steps. A rough تومان badge appears when the model returns a cost. «افزودن به برنامه» is visible and disabled.

   Spot-check the cards against the sample pantry (برنج، پیاز، عدس، لوبیا، سیب‌زمینی، گوجه‌فرنگی، ماست، روغن). Those names should show up as the main ingredients. The request includes the week budget you typed.

   Expected HTTP 200 from the recipe curl in step 8: `"ok": true` and a `recipes` array of three objects. The API key must not appear in the body.

10. Live fridge photo, only when a real key is available. Do not print the key, commit it, or paste it into the shell history. QA often keeps it in a host file such as `…/MAI/.env` (gitignored). This repo’s `.env` is gitignored too. Load the variable without echoing it, then recreate api:

   ```bash
   # Replace the path with the host file that already holds GAP_CODE_API_KEY.
   set -a
   . /path/to/MAI/.env
   set +a
   test -n "$GAP_CODE_API_KEY" && echo "GAP_CODE_API_KEY is set (value hidden)"
   docker compose up -d --build --force-recreate api web
   ```

   Repeat the curl in step 7 with a real fridge photo instead of the tiny JPEG. Expected HTTP 200, `"ok": true`, and an `ingredients` array of strings. The body must not contain the API key or the image.

   On http://localhost:8080, use «عکس یخچال» with that photo. After «در حال تشخیص مواد…», edit or uncheck chips, then press «تأیید و افزودن به انبار». Only the names you left checked appear in the pantry, without duplicates. «انصراف» adds nothing. Tap a new chip to remove it, the same as any other pantry chip.

## GapGPT checks (SE/QA)

Unit tests mock HTTP or talk to a local socket. They do not need a key and do not call GapGPT. `LiveSmokeTest` is skipped unless you opt in.

```bash
cd api
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python -m unittest discover -s tests -v
```

Expected: every test OK, with `LiveSmokeTest` skipped. From the repo root, `node --test web/pantry.test.js web/recipes.test.js web/fridge.test.js` covers the pantry, the recipe page, and the fridge confirm sheet.

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

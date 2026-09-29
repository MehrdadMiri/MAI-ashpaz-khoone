# MAI-ashpaz-khoone

Persian RTL AI meal and recipe demo (آشپزخونه).

`docker compose up --build` starts three services.

| Service | Image | URL |
| --- | --- | --- |
| web | nginx, Persian pantry UI | http://localhost:8080 |
| api | Python (Flask + Gunicorn) | http://localhost:8000 |
| db | Postgres 16 | localhost:5432 |

The web page is a Persian RTL pantry. You can add and remove ingredient chips, load a sample set of Iranian staples, set a numeric week budget, and set تعداد نفرات (how many people the amounts and prices are for). «به‌روزرسانی قیمت‌ها» stores Okala unit prices (تومان) and the recipe, week, and shopping costs prefer those prices. «سبد اُکالا» on مواد خرید copies the list and opens Okala; it does not check out. The list and budget are stored in Postgres for a browser-local id, and cached in this browser (`localStorage`) when the api or database is unavailable. «پیشنهاد دستور» asks the shared GapGPT client (`api/gapgpt.py`) for three Persian recipes from those chips and the week budget. After that, the button reads «پیشنهاد دستورهای بیشتر» and appends another batch (5 or 7 when the pantry has enough names). «بازتولید کامل» replaces the cards. If a meal is marked «خورده شد», that call prefers the chips still left and asks the model not to repeat those meals. «عکس یخچال» sends one photo to the same client and shows candidate chips; nothing is added to the pantry until you confirm. Adding a dish fills one day and one meal. «برنامه ۷ روزه» is the separate action that fills صبحانه، ناهار، and شام from شنبه through جمعه. The plan can print or download the week. The plan does not call GapGPT. «مواد خرید» diffs every planned meal against the pantry chips, lets you add or edit a row by hand, shows a price when one exists, and can print or download the list. That list does not call GapGPT. After the recipe cards appear, the page asks the same client for a rough per-serving calorie estimate (and protein, carbohydrate, and fat when the model returns them). Each card says those numbers are an AI estimate. If that call fails, the cards stay without them. Product UI is Persian RTL. This scaffold’s docs and code comments are English.

The GitHub repository is public: https://github.com/MehrdadMiri/MAI-ashpaz-khoone. `.env` is gitignored. `.env.example` has placeholders only, and `GAP_CODE_API_KEY` there is empty. Do not commit a real key.

`v0.1.0` is the tagged MVP. `v0.2.0` is already tagged. The release gate for `v0.3.0` is [docs/QA-SMOKE.md](docs/QA-SMOKE.md). Notes for that tag are [docs/RELEASE.md](docs/RELEASE.md). This repository does not create the tag here.

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

Stop the stack with `docker compose down`. Postgres data, including saved pantries and week plans, lives in the `pgdata` volume. `docker compose down -v` removes that volume. `POSTGRES_USER`, `POSTGRES_PASSWORD`, and `POSTGRES_DB` are applied when that volume is first created, so change them only on an empty volume. See [Saved pantry and week plan](#saved-pantry-and-week-plan).

## Add to Home Screen

برای نصب، سایت را در مرورگر گوشی باز کنید و «افزودن به صفحهٔ اصلی» را بزنید.

Add to Home Screen from the browser menu to install آشپزخونه as a standalone app. Chrome treats http://localhost:8080 as a secure context, so install works there; any other host needs HTTPS. The service worker caches the page shell only. Recipe generation, fridge photos, and the GapGPT key stay on the server.

```bash
node --test web/pwa.test.js
```

## Environment variables

| Variable | Required to boot | Default |
| --- | --- | --- |
| `GAP_CODE_API_KEY` | No | empty |
| `GAPGPT_BASE_URL` | No | `https://api.gapgpt.app/v1` |
| `GAPGPT_MODEL` | No | `gpt-5.6-luna` |
| `POSTGRES_USER` | No | `ashpaz` |
| `POSTGRES_PASSWORD` | No | `change-me` |
| `POSTGRES_DB` | No | `ashpaz` |
| `OKALA_LIVE` | No | `1` |
| `OKALA_CACHE_TTL_SECONDS` | No | `86400` |
| `OKALA_MIN_INTERVAL_SECONDS` | No | `60` |
| `OKALA_REQUEST_DELAY_SECONDS` | No | `1.5` |
| `OKALA_TIMEOUT_SECONDS` | No | `8` |
| `OKALA_STORE_ID` | No | `2319` |
| `OKALA_REFRESH_INTERVAL_SECONDS` | No | `0` |

`.env.example` has placeholders only. `.gitignore` excludes `.env`. Do not commit `GAP_CODE_API_KEY` or any real key. The Okala settings are not secrets. Put the GapGPT key only in the environment or the gitignored `.env`. Do not put it in URLs, command lines, or logs.

## Saved pantry and week plan

Pantry chips, the week budget, diet filters, تعداد نفرات, and the 7-day plan are stored in Postgres, one row per browser session. The plan row includes recipe titles, ingredient lines, steps, costs, the servings those amounts were written for, the شنبه–جمعه slots for صبحانه، ناهار، and شام, and «خورده شد» on each meal. An older dinner-only row is read as شام. Manual shopping rows and plan-line edits live in `shopping_state` for that same session. There is no account and no password. On the first visit the page creates a random id, stores it in `localStorage` (`ashpaz-khoone.local-user.v1`) and a `ashpaz_local_user` cookie (`Path=/`, `SameSite=Lax`, one year), and sends it as `X-Local-User-Id`. When that cookie is present and well formed, the api uses it and ignores a different header or query id. The id is not a credential. Do not put `GAP_CODE_API_KEY`, or any other secret, in the pantry, the plan, or the shopping list.

`GET` and `PUT /pantry` and `GET` and `PUT /plan` are the routes. Nginx forwards `/api/pantry` and `/api/plan` to them. A missing row is `found: false` and does not wipe the browser. A saved row is what a refresh shows for that id.

The page writes the browser copy under that id: `ashpaz-khoone.pantry.v1.<id>`, `ashpaz-khoone.plan.v1.<id>`, `ashpaz-khoone.shopping.v1.<id>`, and `ashpaz-khoone.okala-prices.v1.<id>`. An older unscoped key (`ashpaz-khoone.pantry.v1` and the same pattern for the plan, shopping list, sync meta, and Okala price cache) is copied once onto the first id that opens this browser, then left there. A later id does not read it, so a demo already on this browser is not wiped and is not handed to the next user. If the api or Postgres is unavailable, that scoped copy is what you see, and the next load tries the api again. An edit that has not reached Postgres yet is sent again before a saved row can replace it.

The tables are `pantry_state` and `week_plan_state`. `POSTGRES_USER`, `POSTGRES_PASSWORD`, and `POSTGRES_DB` are the role, password, and database name. The Postgres image applies them only when the `pgdata` volume is created. Changing them later does not alter a volume that already has data. `POSTGRES_HOST` and `POSTGRES_PORT` are set on the api container (`db` and `5432` on the compose network). Port `5432` is published for local tools.

`api/migrations/001_kitchen_state.sql` is mounted into `docker-entrypoint-initdb.d`, so a new volume creates the tables. Those init scripts do not run again on a volume that already exists. The api runs the same files (`CREATE TABLE IF NOT EXISTS`, then `004_session_users.sql`) when it reaches the database, including from `/health`, so an older volume gains the tables without a reset. `004` copies a sentinel row `legacy-shared` onto `local-user-default` only when that default row is still missing. A normal browser id is not moved, and an install that never used the sentinel changes nothing. `/health` is still that check plus `SELECT 1`. It does not return pantry rows or the database password.

Requests that contain the configured `GAP_CODE_API_KEY` are rejected and are not written. Failure logs record the exception class only. They do not include the pantry, the plan, or the key.

```bash
curl -sS http://localhost:8000/pantry -H 'X-Local-User-Id: local-user-demo1'
curl -sS -X PUT http://localhost:8000/pantry \
  -H 'Content-Type: application/json' \
  -H 'X-Local-User-Id: local-user-demo1' \
  -d '{"pantry":{"items":["برنج","پیاز"],"budget":"1500000"}}'
curl -sS -X PUT http://localhost:8080/api/plan \
  -H 'Content-Type: application/json' \
  -H 'X-Local-User-Id: local-user-demo1' \
  -d '{"local_user_id":"local-user-demo1","plan":{"recipes":[],"slots":{},"used":{}}}'
```

`local-user-demo1` is a placeholder id, not a credential. A refresh of http://localhost:8080 keeps the chips, the budget, the week, and the manual shopping rows for that browser. A second browser, or a private window, gets its own id and does not see those rows.

### Multi-user isolation

Each visitor is one `local_user_id`. Pantry, week plan (including servings and صبحانه، ناهار، شام), and shopping list (plan rows rebuilt on the page, plus manual rows and saved مقدار) are filtered by that id on every GET and PUT. Okala unit prices stay one shared catalog in `okala_price`. The last price snapshot in this browser is stored per id, so one user's offline cache is not the next user's. There is still no signup.

To check two users:

- This browser is user A. Add a chip, a meal, and a manual مواد خرید row. Reload. They stay.
- Click «کاربر جدید» (or open a private window). The pantry, week, and shopping list are empty. User A's rows are still in Postgres under the previous id.
- In the first browser profile, do not click «کاربر جدید» again. Reload shows user A's data. A private window still shows the empty store.
- Clearing only the `ashpaz_local_user` cookie is not a new user while `ashpaz-khoone.local-user.v1` remains. «کاربر جدید» replaces both. To return to an old id, put that id back in the cookie and in `ashpaz-khoone.local-user.v1`, then reload.
- Two curls, with no cookie, also stay apart:

```bash
curl -sS -X PUT http://localhost:8000/pantry \
  -H 'Content-Type: application/json' \
  -H 'X-Local-User-Id: local-user-demo1' \
  -d '{"pantry":{"items":["پیاز"],"budget":"10"}}'
curl -sS http://localhost:8000/pantry -H 'X-Local-User-Id: local-user-demo2'
```

The second body is `found: false` and an empty pantry. `local-user-demo1` still has پیاز.

Checks without a browser:

```bash
node --test web/persist.test.js
cd api && python3 -m unittest tests.test_store tests.test_state_endpoint -v
```

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

`chat` returns the JSON object. `content` may be a string or a list of parts. `chat_with_image` builds that list for one image (`image_url` data URL). `chat_with_images` does the same for several photos, in the order given, as one `/chat/completions` call. Fridge vision uses that. The key is not written to logs, error messages, or return values. Image bytes are not written to logs or API responses. JSON responses are scrubbed again before they leave the api process: a configured key of 8 or more characters is replaced, and a body that contains a Python traceback is replaced with a static `internal_error`. Unexpected exceptions return that same JSON shape and log only the exception class name.

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

The page is Persian, right to left, and set in Vazirmatn. On a new browser the kitchen is empty: an illustration, «هنوز چیزی در آشپزخانه نیست», and three ways in: «بارگذاری نمونه», «افزودن ماده» (focuses the name field), and «عکس یخچال».

- «بارگذاری نمونه» loads eight staples: برنج، پیاز، عدس، لوبیا، سیب‌زمینی، گوجه‌فرنگی، ماست، روغن. Loading again does not duplicate them.
- Type a name and press «افزودن». The same name, including extra spaces and Arabic/Persian letter variants, is ignored.
- Tap a chip to remove it. «پاک کردن» empties the list and leaves the week budget as it is. «بارگذاری نمونه» then restores those eight staples.
- «بودجه هفته» in the header is the numeric week budget in تومان. Reload the page and it is still there. With the api and database up, the chips and the budget are the Postgres row for this browser's local id.

Ingredient rules without a browser:

```bash
node --test web/pantry.test.js
```

Web `/health` is unchanged.

## Recipe suggestions

«پیشنهاد دستور» is on the pantry page. It sends the chips and the week budget already stored by the pantry (`AshpazPantry`) to `POST /api/recipes/generate`.

The browser calls `http://localhost:8080/api/recipes/generate`. Nginx proxies `/api/` to the api service and forwards that path. The api accepts `/api/...` as an alias of the same routes, so `POST /recipes/generate` on port 8000 and `POST /api/recipes/generate` on port 8080 are the same call. The web `/health` check is still the nginx `ok` response. API health through the proxy is `http://localhost:8080/api/health`.

The request JSON is `{ "ingredients": ["برنج"], "budget": 1500000, "household": 4, "count": 3 }`. `budget` may be `null` when the week field is empty; the model prompt still includes that budget context. `household` is تعداد نفرات (1 to 12). Missing `household` means 4. The prompt asks for ingredient quantities and `cost_toman` for that many people, and each returned recipe is stamped with `servings` set to the same number. Leftover regenerate adds `remaining`, `skip`, and `full` (see [Leftover regenerate](#leftover-regenerate)). Active diet chips add `filters` (see [Diet filters](#diet-filters)).

`count` is how many recipes that call should return: 3, 5, or 7. The allowance follows the distinct names the model cooks from (remaining chips in leftover mode when that list is shorter, otherwise the pantry): **1–4 names → 3**, **5–7 names → 5**, **8 or more → 7**. A missing `count` uses that allowance. An explicit `count` above the allowance is clamped down. Any other `count` is HTTP 400 `invalid_request` and the message does not echo the value.

The first «پیشنهاد دستور» always sends `count: 3`, even when the pantry would allow 5 or 7. After that success the button reads «پیشنهاد دستورهای بیشتر». That click sends the allowance (and `exclude`, the titles already on the page) and **adds** the new cards. It does not remove the ones already shown. «بازتولید کامل» replaces the cards and sends the allowance for the full pantry. A failed «بیشتر» leaves the cards that are already there.

### تعداد نفرات

«تعداد نفرات» sits in the header next to «بودجه هفته». It starts at ۴ and stays between ۱ and ۱۲. «−» and «+» step it. The value is stored on the pantry snapshot (`household` in `ashpaz-khoone.pantry.v1` and in the Postgres pantry row), so a reload keeps it. «پاک کردن» empties the chips and leaves the headcount, the week budget, and the diet filters as they are. Changing it does not clear the week or the recipe cards.

Stored recipe lines and `cost_toman` are for that recipe's `servings` people. Older recipes with no `servings` are treated as **4 people**, the same default. The page multiplies displayed amounts and costs by `تعداد نفرات / servings`. A line with no number, such as «برنج», stays as written. Steps are not rewritten. The calorie line stays «در هر وعده» and is not multiplied.

Recipe cards show «برای … نفر», the scaled ingredient tags, and the scaled تومان badge. The week plan's meal costs and the budget comparison use the scaled costs. The same dish on two slots still counts twice. «مواد خرید» scales each planned line by that meal's servings before it adds quantities. When a fresh Okala unit price matches a line, the shown cost is that unit price times the scaled quantity. It is not scaled a second time. A missing or stale Okala row keeps the scaled GapGPT `cost_toman`. Generate and «بازتولید کامل» both send the current headcount.

```bash
curl -sS -X POST http://localhost:8000/recipes/generate \
  -H 'Content-Type: application/json' \
  -d '{"ingredients":["برنج","عدس"],"budget":1500000,"household":4}'
```

A household outside 1–12 is HTTP 400 `invalid_household`. The message does not echo the value. The page asks for a number from ۱ to ۱۲. The api service calls GapGPT with `GapGPTClient.chat_text` and the configured model (`gpt-5.6-luna` unless `GAPGPT_MODEL` is set). The key stays in the api container. The page never receives it.

### Diet filters

Three chips sit with «پیشنهاد دستور»: «گیاهی», «بدون پیاز», and «مناسب دیابت». Each one toggles on its own, and any combination is allowed. The choice is stored on the pantry snapshot (`filters` in `ashpaz-khoone.pantry.v1` and in the Postgres pantry row), so a reload keeps it. «پاک کردن» empties the chips and leaves the filters as they are.

When at least one chip is on, the generate body includes all three flags:

```json
"filters": {"vegetarian": true, "no_onion": false, "diabetic": true}
```

Missing `filters`, or `null`, means all three are off. A value that is not `true` or `false` is HTTP 400 `invalid_request`. The message does not echo that value. The GapGPT prompt lists only the active limits and tells the model they override the pantry, including a pantry item the limit forbids. After the reply, the api drops a recipe that clearly names a forbidden food when at least three other recipes remain. If fewer than three pass, the ranked recipes are still returned, so the check cannot fail generation. A timeout, a missing key, or an unreadable reply is unchanged: the page shows the Persian retry, and the chips stay.

```bash
curl -sS -X POST http://localhost:8000/recipes/generate \
  -H 'Content-Type: application/json' \
  -d '{"ingredients":["برنج","عدس","ماست"],"budget":1500000,"filters":{"vegetarian":true,"no_onion":true,"diabetic":false}}'
```

A successful body is `ok: true` and `recipes` with three objects. Each object has `title`, `ingredients`, `steps`, and `cost_toman` (`null` when the model gives no number). The page shows those as RTL cards: title, ingredient tags, steps, and a rough cost badge when a cost is present. It then asks for a nutrition estimate ([Nutrition estimates](#nutrition-estimates)). «افزودن به برنامه» on each card opens the day sheet for the meal plan.

Before the first successful suggestion, the panel says to set the week budget and press «پیشنهاد دستور». That prompt is not an error. An empty budget is still sent as `null`.

While the request is in flight the status line is «در حال پختن ایده‌ها…», three skeleton cards stand in for the results, and both «پیشنهاد دستور» and «تلاش دوباره» are disabled, so a second click does not send another request. Failures stay on the page as short Persian text plus «تلاش دوباره». Service failures (missing or rejected key, timeout, network, 5xx) also show a hint to check `GAP_CODE_API_KEY` and the compose logs. The page does not show stack traces, upstream bodies, or the key value. The browser never reads `body.message`.

| Situation | HTTP | `error` | What the page says |
| --- | --- | --- | --- |
| No pantry items | 400 | `empty_ingredients` | ask for at least one ingredient (the page does this before calling) |
| Eaten dinners used every chip | 400 | `no_remaining` | add an ingredient, or press «بازتولید کامل» (the page does this before calling) |
| Bad budget | 400 | `invalid_budget` | the week budget is not a number |
| Key missing | 503 | `not_configured` | the suggestion service is not ready, plus the key hint |
| Upstream rejects the key | 502 | `unauthorized` | friendly retry, plus the key hint |
| Timeout | 504 | `timeout` | friendly retry, plus the key hint |
| Unreadable model output, or fewer usable recipes than requested | 502 | `bad_response` | friendly retry, plus the key hint |

The model is asked for Iranian home cooking in Persian that prefers the pantry names. QA should spot-check that the cards use those names.

Checks without a browser:

```bash
node --test web/recipes.test.js
cd api && python3 -m unittest tests.test_nutrition tests.test_nutrition_endpoint -v
```

## Nutrition estimates

After the cards are on the page, the browser calls `POST /api/recipes/nutrition` with the title, ingredients, and steps already shown. It does not send the API key. The api service calls the same GapGPT client and model (`gpt-5.6-luna` unless `GAPGPT_MODEL` is set) and asks for one serving, not the whole pot.

A successful body is `{"ok": true, "available": true, "estimates": [{"kcal": 480, "protein_g": 16, "carbs_g": 70, "fat_g": 14}]}`. One entry lines up with each recipe. `kcal` is required. Protein, carbohydrate, and fat are omitted when the model gave no usable number. The card shows Persian digits, «در هر وعده», and «این عددها برآورد هوش مصنوعی هستند، نه مقدار دقیق غذا.» The disclaimer is fixed copy in the page. The browser does not render `body.message` or any label the model returns.

The api process caches an estimate by a hash of the normalized title, ingredients, and steps. Cost is not part of the key. A repeat of the same recipe does not call GapGPT. The cache stores the numbers only.

If the key is missing, the call times out, or the reply cannot be read, the route still returns HTTP 200 with `"available": false` and `null` for each recipe. Cached numbers are still returned when GapGPT is down. The recipe cards stay, and the recipe error box is not used. `POST /recipes/generate` is unchanged: a nutrition failure does not fail generation.

```bash
curl -sS -X POST http://localhost:8000/recipes/nutrition \
  -H 'Content-Type: application/json' \
  -d '{"recipes":[{"title":"عدس‌پلو","ingredients":["برنج","عدس"],"steps":["عدس را بپز","برنج را دم کن","سرو کن"]}]}'
```

Without a key this is HTTP 200, `"available": false`, and the body does not contain a key. With a key, `"available": true` and a `kcal` on each estimate the model could read. The same call through the page is `POST http://localhost:8080/api/recipes/nutrition`.

## Fridge photo

«عکس یخچال» is on the pantry page. It does not add anything by itself. One confirm flow can take up to six photos. Tagging waits for the `v0.3.0` gate in [docs/QA-SMOKE.md](docs/QA-SMOKE.md).

1. Open «عکس یخچال». «گرفتن عکس» calls `getUserMedia` with `facingMode: environment` (the back camera when the phone has one) and shows a preview. «انتخاب عکس» opens a file picker that accepts several photos (`multiple`).
2. If the camera API is missing, «گرفتن عکس» uses a file input with `capture="environment"`.
3. If the camera is denied or fails, the sheet says «دسترسی به دوربین داده نشد. می‌توانید یک عکس انتخاب کنید.» and leaves the file picker. It does not keep asking for the camera. Photos already queued stay in the tray.
4. Each camera frame is kept, in order, until you press «تشخیص مواد». «ثبت این عکس» does not call the API. «عکس دیگر» adds a gallery photo to the same tray. «حذف» drops one photo. «انصراف» on the tray closes the sheet and does not change the pantry.
5. «تشخیص مواد» posts every queued photo as a repeated multipart field `image`, in tray order, to `POST /api/vision/fridge` (nginx) or `POST /vision/fridge` (api port 8000). The same route still accepts one `image` or JSON `image_base64`. Several photos can also be a JSON `images` array of base64 or data URLs, in order. A seventh photo is refused with `too_many_images` and is not sent upstream.
6. While that request runs, the sheet shows the photos and «در حال تشخیص مواد…». «انصراف», the close button, or Escape cancels the request. Cancelling does not change the pantry and does not show an error.
7. The api service calls `GapGPTClient.chat_with_images` once, with model `gpt-5.6-luna` unless `GAPGPT_MODEL` is set. Image parts stay in upload order. The model is asked for Persian food names and a confidence from 0 to 1. The response to the browser is `{"ok": true, "ingredients": [{"name": "شیر", "confidence": 0.9}]}`. `confidence` is `null` when the model gave no usable number. The same normalized Persian spelling is returned once, keeping the higher confidence. Alias pairs such as گوجه and گوجه‌فرنگی stay as separate rows so the page can merge them. An empty list means no food was recognized. This vision route does not write those names. They stay off the pantry until you confirm; confirming saves them with the rest of the pantry ([Saved pantry and week plan](#saved-pantry-and-week-plan)). The body never includes image bytes or the API key.
8. The page merges near-duplicates before the confirm sheet: Arabic/Persian letters, spacing, and ZWNJ, plus a short alias list (گوجه / گوجه‌فرنگی, فلفل دلمه / فلفل دلمه‌ای, رب گوجه / رب گوجه‌فرنگی). A single short name is not rewritten. When two aliases merge, the chip uses the longer name and the higher confidence. The sheet says «مواد تکراری یا هم‌نام یکی شدند» when that happened.
9. Each chip shows a confidence: «اطمینان ۹۰٪» at 75% and above, a middle band from 45%, and a low band below that. A missing score says «نامشخص». Editing the name marks the chip «دستی». You can uncheck a chip or type another name. «انصراف» or closing the sheet leaves the pantry as it was.
10. «تأیید و افزودن به انبار» merges only the checked names with the same dedupe rules as typing a chip. After that, the chips are the normal pantry chips: tap one to remove it.

The page maps failures to short Persian text and «تلاش دوباره». Service failures also hint to check `GAP_CODE_API_KEY` and the compose logs. It does not show the server message, stack traces, or the key value. The photo preview is only on screen while detection is running; an error hides it. The pantry chips stay as they were.

| Situation | HTTP | `error` | What the page says |
| --- | --- | --- | --- |
| Not an image, or not JPEG/PNG/WEBP/GIF | 400 | `invalid_image` | choose a JPEG or PNG |
| Image larger than 6 MB | 413 | `image_too_large` | choose a smaller photo |
| More than six photos | 400 | `too_many_images` | at most six photos |
| Key missing | 503 | `not_configured` | the vision service is not ready, plus the key hint |
| Upstream rejects the key | 502 | `unauthorized` | friendly retry, plus the key hint |
| Timeout | 504 | `timeout` | friendly retry, plus the key hint |
| Unreadable model output | 502 | `bad_response` | friendly retry, plus the key hint |
| No food in a readable answer | 200 | — | empty confirm sheet; you can type a name |

JPEG, PNG, WEBP, and GIF are detected from magic bytes. The declared file type is not trusted. SVG and HTML are rejected. One bad photo fails the whole batch; nothing is written to the pantry. Logs record the exception class only, never the image bytes or the key.

Checks without a browser:

```bash
node --test web/fridge.test.js
```

## Meal plan

«برنامه ۷ روزه» is on the same page, under the recipe cards. It does not call GapGPT. No API key is required to view the week, print it, or download it.

The week is شنبه through جمعه. Each day has سه وعده: صبحانه، ناهار، شام. An empty slot shows «خالی». Assignments, recipe titles, and «خورده شد» are stored per meal in Postgres for this browser's local id. The browser also keeps them in `localStorage` (`ashpaz-khoone.plan.v1.<id>`) and uses that copy when the api or database is unavailable.

Older saves stored one شام per day (`slots.sat` as a recipe id, `used.sat` as a boolean). Those load as the شام slot. صبحانه and ناهار start «خالی». Share links with `v: 1` do the same. New links are `v: 2` and list every filled meal.

- «افزودن به برنامه» on a recipe card opens a sheet of the ۲۱ وعده (seven days × سه وعده), the same sheet pattern as fridge confirm. Pick a slot to assign that recipe. That write touches **only** the chosen day and meal. The other days, and the other meals on that day, stay as they are. A slot that already has a dish offers «جایگزین», which also changes only that slot.
- «برنامه ۷ روزه» is a separate button. It fills every empty slot from the recipes already on the page. Assigning one dish does not press it. When more than one recipe exists, a day does not get the same dish for صبحانه، ناهار، and شام. With only one recipe, that dish fills the empty slots. Slots you already filled stay as they are. With no recipes yet, every slot stays «خالی» and the status line asks you to suggest recipes first. «انتخاب» on an empty slot opens the recipe list once recipes exist.
- On a filled slot, «جایگزین» opens that list, plus «خالی» to clear that slot only.
- «خورده شد» on a filled slot marks that meal as eaten. Press it again to undo. Replacing or clearing that slot clears the mark. The mark is stored on the plan (`used.day.meal`), in Postgres and in `ashpaz-khoone.plan.v1`, and is what leftover regenerate skips. Print and Markdown add «خورده شد» on that meal. Empty slots have no toggle.
- If the week budget is set and a recipe has a تومان cost, a line under the title sums every planned meal at the current تعداد نفرات. The same dish on two slots counts twice. When the sum is over the budget the line says so and adds that چاپ و خروجی are still allowed. You can still assign, swap, print, and download. Changing تعداد نفرات updates that sum and does not clear the slots.
- «کپی لینک» copies a link that reopens this week. The link is only a `#p=` hash on this page: day, meal, title, cost, «خورده شد», ingredients, and steps. It does not include the browser's local user id, `GAP_CODE_API_KEY`, or other environment values. Opening it replaces the plan in this browser; Postgres then stores that week under the reader's own id. An empty week still copies, and opening that link shows «برنامه هفته خالی است».
- «چاپ / خروجی» opens a sheet with «چاپ» and «دانلود مارک‌داون», and shows the same share link so it can be copied from the field.

Print uses `@media print` in `web/pantry.css` (`A4`, RTL, Vazirmatn). To print once: open http://localhost:8080, click «چاپ / خروجی», then «چاپ». The poster is a white page. Each day is one block that does not split across pages: «روز» and the Iranian weekday, then «وعده» and صبحانه، ناهار، and شام, each with the recipe title or «خالی». The pantry, recipe cards, fridge sheet, footer, and buttons stay hidden.

«دانلود مارک‌داون» saves `برنامه-۷-روزه.md`: a heading, then each day with صبحانه، ناهار، and شام (title or «خالی»).

Checks without a browser and without an API key:

```bash
node --test web/plan.test.js
```

QA on http://localhost:8080, still with no key:

1. Confirm seven days, شنبه first and جمعه last. Each day shows صبحانه، ناهار، and شام, each «خالی» with «انتخاب». The plan says «برنامه هفته خالی است».
2. Click «چاپ / خروجی», then «چاپ». The preview is an A4 poster: white, Persian, right to left. Each day shows «روز» and three «وعده» lines, and «خالی» when nothing is assigned. The pantry and the recipe controls are not in the preview. Close the preview.
3. Click «کپی لینک». The copied address ends with `#p=` and does not contain `local_user_id` or an API key. Open it in a new tab. The week is still the empty slots, and the page says the shared plan is empty. The hash is then removed so a later edit is not reset on reload. With a filled week, the same link restores صبحانه، ناهار، and شام.
4. Click «چاپ / خروجی», then «دانلود مارک‌داون». The file lists all seven days and all three meals as خالی.
5. After «پیشنهاد دستور» (that call needs a key), «افزودن به برنامه» chooses one slot, «جایگزین» swaps that slot, and «برنامه ۷ روزه» fills any slot that is still «خالی» without repeating one dish across the three meals of a day when other recipes exist. «خورده شد» on a filled slot does not need a key. Copy the link again and open it: those titles come back, still without a key in the address.

## Leftover regenerate

«پیشنهاد دستور» is leftover-aware. The first success shows three cards and the button becomes «پیشنهاد دستورهای بیشتر», which appends. «بازتولید کامل» is the explicit full path and replaces the cards. Neither button clears the pantry chips or the week budget. Assigned meals stay on the week until you change them. New cards are remembered for «افزودن به برنامه» and «برنامه ۷ روزه».

On each filled slot, «خورده شد» toggles that meal. While it is on, that slot is marked eaten. Breakfast, lunch, and dinner are independent. An older dinner-only week still marks شام, because that save loads as the dinner slot.

- «پیشنهاد دستور» sends the full chip list as `ingredients`, plus `remaining` (chips not used by eaten meals) and `skip` (those meal titles), with `full: false`. A chip is treated as used when an eaten meal’s ingredient line is the same pantry name, including «۲ عدد پیاز» for پیاز. «روغن» is not used up by «روغن زیتون». The prompt still includes the week budget. The model is told to cook from the remaining chips and not to repeat the skipped titles. The response drops a title that matches a skipped meal (spacing and ZWNJ ignored). A successful body is `mode: "leftovers"`. The status line says the ideas came from what is left. If every chip was used, the page does not call the API; it asks you to add a chip or press «بازتولید کامل».
- «بازتولید کامل» sends `ingredients`, `budget`, and `full: true`. It does not send `skip`. The prompt tells the model to ignore leftovers, and the week budget is still in that prompt. Eaten titles may come back. The body is `mode: "full"`. «تلاش دوباره» repeats whichever button failed.
- With no meal marked eaten, «پیشنهاد دستور» stays `{ "ingredients", "budget" }` and `mode` is `"pantry"`.

```json
{
  "ingredients": ["برنج", "عدس", "پیاز", "ماست"],
  "budget": 1500000,
  "remaining": ["ماست"],
  "skip": ["عدس‌پلو"],
  "full": false
}
```

Checks without a browser and without an API key:

```bash
node --test web/recipes.test.js web/plan.test.js
cd api && python3 -m unittest tests.test_recipes tests.test_recipes_endpoint -v
```

Live smoke, only with a real key in the host file `…/MAI/.env` (gitignored; never print it, never commit it). This repo’s `.env` is gitignored too. Load the variable without echoing it, recreate api, then call both shapes. Do not create a tag from this check. The `v0.3.0` gate is [docs/QA-SMOKE.md](docs/QA-SMOKE.md).

```bash
set -a
# shellcheck disable=SC1091
source /path/to/MAI/.env
set +a
test -n "$GAP_CODE_API_KEY" && echo "GAP_CODE_API_KEY is set (value hidden)"
docker compose up -d --force-recreate api
```

Leftover (remaining chips, skip the eaten meal). Expect HTTP 200, `"mode": "leftovers"`, and three recipes whose titles are not the skipped meal. The body must not contain the key.

```bash
curl -sS -X POST http://localhost:8000/recipes/generate \
  -H 'Content-Type: application/json' \
  -d '{"ingredients":["برنج","عدس","پیاز","ماست"],"budget":1500000,"remaining":["ماست"],"skip":["عدس‌پلو"],"full":false}'
```

Full regenerate (ignore that skip, keep the budget). Expect HTTP 200 and `"mode": "full"`. The eaten title may appear. The body must not contain the key.

```bash
curl -sS -X POST http://localhost:8000/recipes/generate \
  -H 'Content-Type: application/json' \
  -d '{"ingredients":["برنج","عدس","پیاز","ماست"],"budget":1500000,"full":true}'
```

Without a key, both curls return HTTP 503 and `"error": "not_configured"`. An explicit empty `remaining` list without `full: true` returns HTTP 400 and `"error": "no_remaining"`, and does not call GapGPT. If `skip` contains the API key, the call is refused before it is sent.

On http://localhost:8080 with the same key: mark one filled slot «خورده شد», press «پیشنهاد دستور», and confirm the new cards appear, that slot stays, and the chips stay. Then press «بازتولید کامل» and confirm the chips still stay. With the key removed, both buttons show the Persian error and «تلاش دوباره», and retry repeats the same button.

## Shopping list

«مواد خرید» is on the week plan. It does not call GapGPT and does not read `GAP_CODE_API_KEY`. The browser diffs pantry chips against the ingredient lines already stored on each planned meal — صبحانه، ناهار، and شام — the same lines the recipe cards show. Change a chip or a slot and those plan rows are rebuilt. Names you add yourself are stored beside that diff, in Postgres table `shopping_state` for this browser id and in `ashpaz-khoone.shopping.v1` when the api is down. Adding a row does not wipe the plan, and rebuilding the plan does not wipe the manual rows. Same names are shown once.

- A chip covers a recipe line after the pantry's usual cleanup (spacing, ZWNJ, Arabic and Persian letters). A pantry name also covers a longer line when the extra words are only size or prep, so پیاز covers «۲ عدد پیاز متوسط». «روغن» does not cover «روغن زیتون».
- A quantity on the stored line is kept (`۲۰۰ گرم`, `نصف پیمانه`, `۳ عدد`, `یک و نیم پیمانه`) and then scaled by `تعداد نفرات / servings` (4 when the recipe has no servings). The same item and unit are added across the meals that need it. Different units stay side by side. With no quantity, a repeated item says how many meals need it. The section says the amounts were counted for that headcount.
- «افزودن» takes a Persian name and an optional مقدار and واحد. «ویرایش» changes the name or the amount. «حذف» drops a manual row, or hides a plan row. «خریدم» and then «پاک کردن تیک‌خورده‌ها» removes the checked rows. A quantity you type, or save with «ویرایش», is yours: تعداد نفرات does not change it. Plan rows that you have not edited still scale. The line under the title says so. An empty مقدار on «ویرایش» gives that plan row back to headcount scaling.
- A fresh Okala match shows the line total («… تومان · اُکالا») when the unit converts (گرم and کیلو to کیلوگرم, میلی‌لیتر to لیتر, عدد to عدد). A piece count against a weighed pack shows «هر کیلوگرم … تومان · اُکالا» instead of a guessed total. A stale row that still converts shows the last line total as «حدود … تومان · کهنه»; otherwise it keeps the last unit price and says «کهنه». The list shows «جمع … تومان · اُکالا» when every counted line is fresh, and «جمع حدود …» when a stale line is included. A row with no Okala price stays unlabeled. Recipe cards still use the GapGPT «حدود» estimate for a whole meal. Manual names are sent with «به‌روزرسانی قیمت‌ها» and copied by «سبد اُکالا» when they are on the list. See [Okala prices](#okala-prices).
- Rows are grouped with a small built-in map: سبزی و صیفی، میوه، پروتئین، لبنیات، حبوبات و غلات، نان و آرد، چاشنی و ادویه، خشکبار. Anything else is «سایر».
- «چاپ / خروجی» on this section prints only the list (white page, Vazirmatn, RTL) or downloads `مواد-خرید.md`. Printing the week still hides this section.

Empty states:

- No meal on the week: «برنامه هفته خالی است».
- No meal and no chips: «برنامه و آشپزخانه خالی است».
- Chips empty, week filled: «آشپزخانه خالی است», and every planned ingredient is on the list.
- Every planned ingredient is already a chip: «چیزی برای خرید نمانده».

If a planned meal has no ingredient lines, that slot is named under the list and left off it. Guessing those lines with GapGPT (`gpt-5.6-luna` through `GapGPTClient`) is not wired. Recipe cards already include `ingredients`, so the list stays a client-side diff and a missing list stays visible instead of being filled with a guessed one.

Checks without a browser and without an API key:

```bash
node --test web/shop.test.js
```

QA on http://localhost:8080, still with no key. «بارگذاری نمونه» fills the pantry. The week can be filled without a model by writing the plan key the page already uses, then reloading:

```js
localStorage.setItem(
  "ashpaz-khoone.plan.v1",
  JSON.stringify({
    recipes: [
      {
        title: "عدس پلو",
        ingredients: ["برنج", "عدس", "پیاز", "۲۰۰ گرم گوشت"],
        steps: ["بپز"],
        cost_toman: 0,
      },
    ],
    slots: {
      sat: { breakfast: null, lunch: null, dinner: "r:عدسپلو" },
      sun: { breakfast: null, lunch: null, dinner: null },
      mon: { breakfast: null, lunch: null, dinner: null },
      tue: { breakfast: null, lunch: null, dinner: null },
      wed: { breakfast: null, lunch: null, dinner: null },
      thu: { breakfast: null, lunch: null, dinner: null },
      fri: { breakfast: null, lunch: null, dinner: null },
    },
  }),
);
```

The slot id is `r:` plus the title with spaces and ZWNJ removed. A legacy string such as `slots.sat = "r:عدسپلو"` still loads as شام. If this browser already has a plan in Postgres, reload shows that row instead of this snippet. The snippet is what you see when the api is unavailable, or when `GET /plan` is `found: false` (the page then saves this cache). The unscoped key is adopted by this browser's first id when `ashpaz-khoone.plan.v1.<id>` is still empty. If that scoped key is already present, set `ashpaz-khoone.plan.v1.` plus the value of `ashpaz-khoone.local-user.v1` instead. After reload:

1. Click «مواد خرید». برنج، عدس، and پیاز are already chips, so they are absent. گوشت is listed as ۲۰۰ گرم under پروتئین. Type زعفران, an optional مقدار, and «افزودن». It stays after reload (`ashpaz-khoone.shopping.v1.<id>`, or Postgres `shopping_state` when the api is up) and گوشت is still there. Changing تعداد نفرات changes گوشت only. A price appears on a row when Okala has one; «جمع» is the sum of those line totals. That row is not visible to another id.
2. «چاپ / خروجی» on the shopping section, then «چاپ». The preview is the list, in Persian, on white. The pantry and the seven day cards are not in it.
3. «دانلود مارک‌داون» saves `مواد-خرید.md`.
4. Clear every slot (or remove the plan key and reload). The section says the week is empty.
5. With the شام restored, «پاک کردن» says the pantry is empty and lists every ingredient on that meal. Breakfast or lunch on the same day is included too.

With a key, the same checks work after «پیشنهاد دستور» and «برنامه ۷ روزه» instead of the `localStorage` snippet. The page still does not send the list to GapGPT.

«سبد اُکالا» on the same section does not fill Okala's basket and does not take payment. It copies up to ten names (one per line, for Okala's list search) and can open https://www.okala.com/ or a `https://www.okala.com/product/<id>` page when a price row has that id. See [Okala prices](#okala-prices).

## Okala prices

«به‌روزرسانی قیمت‌ها» on the pantry is the way prices update. The page sends the eight staples plus the current chips and shopping names to `POST /api/prices/refresh`. Nothing is scraped on a timer unless you set one. `/health` does not call Okala.

The api reads the public catalog JSON at `https://apigateway.okala.com` (one page for groceries, produce, dairy, and proteins, store `OKALA_STORE_ID`, default `2319`). It does not request the HTML paths disallowed by https://www.okala.com/robots.txt: `/search`, `/cart`, `/checkout`, `/store`, and `/shopping-assistant`. There is no Okala session and no bearer token in this repo. The catalog `price` / `okPrice` fields are rial; the row stores toman (`round(rial / 10)`, half up). The pack size is parsed from the product title. The stock `quantity` field is not a pack size. Among in-stock title matches, the lowest unit price is kept. An out-of-stock shelf price is kept only when nothing in stock matches. Names that do not match are listed under the button («در اُکالا پیدا نشد»).

Matching is the pantry's Persian cleanup plus token prefix: «برنج» matches «برنج عنبربو …» and does not match «آرد برنج». «پیاز» does not match «پیازچه». «شیر» does not match «شیرین».

Rows live in Postgres table `okala_price` (shared catalog, not a user). The browser also keeps `ashpaz-khoone.okala-prices.v1` so a later api miss can still show the last prices.

| Knob | Default | Behavior |
| --- | --- | --- |
| Cache TTL | 24h (`OKALA_CACHE_TTL_SECONDS`) | After this, recipe and week totals fall back to the GapGPT estimate. The shopping line can still show the last line total as «حدود … · کهنه», or the last unit price marked «کهنه» when the unit does not convert. |
| Minimum gap | 60s (`OKALA_MIN_INTERVAL_SECONDS`) | A second press inside this window does not call Okala again. |
| Delay | 1.5s (`OKALA_REQUEST_DELAY_SECONDS`) | Pause between category pages. A 429 stops the rest of that refresh. |
| Live | `OKALA_LIVE=1` | `0` never calls out and loads `api/fixtures/okala_catalog.json` (snapshot `2026-09-29`). |
| Periodic | `OKALA_REFRESH_INTERVAL_SECONDS=0` | Off. A positive value is raised to at least 3600 seconds and refreshes only when rows are stale. |

If the live catalog fails and a row is already stored, that row stays and the page says اُکالا did not answer. If nothing is stored yet, the bundled snapshot is saved and marked degraded. Recipe cards, the week sum, and مواد خرید keep working: fresh Okala when the unit converts, «بخشی از اُکالا» when only some lines convert, otherwise «حدود … تومان» from `cost_toman` scaled by تعداد نفرات. A line with no number, or a پیمانه, is not converted into a weight.

Okala does not offer a public prefilled basket. `POST /prices/cart` returns `prefill: false` and `checkout: false`, a homepage link, a ten-line copy text, and product links only under `/product/<id>`. Paying or completing the order stays on Okala.

```bash
curl -sS -X POST http://localhost:8000/prices/refresh \
  -H 'Content-Type: application/json' \
  -d '{"force":true,"names":["زعفران"]}'
curl -sS -X POST http://localhost:8000/prices/quote \
  -H 'Content-Type: application/json' \
  -d '{"ingredients":["۲۰۰ گرم برنج"],"household":8,"servings":4,"estimate_toman":10000}'
curl -sS -X POST http://localhost:8000/prices/cart \
  -H 'Content-Type: application/json' \
  -d '{"items":[{"name":"برنج","quantity_label":"۴۰۰ گرم"}]}'
```

With `OKALA_LIVE=0` the first curl stores the fixture and does not use the network. A quote for ۲۰۰ گرم برنج at ۸ نفر is `165000` toman from the snapshot (the 4-person line is half of that). `OKALA_LIVE_SMOKE=1` is an optional one-page live check and is skipped in CI.

```bash
node --test web/prices.test.js
cd api && python3 -m unittest tests.test_okala tests.test_okala_endpoint -v
```

## QA smoke

The release gate for `v0.3.0` is [docs/QA-SMOKE.md](docs/QA-SMOKE.md). `v0.2.0` is already tagged. Run the gate with a real key only in the gitignored `.env` or the environment. Do not print the key. `.env.example` stays placeholders only (`GAP_CODE_API_KEY` empty, model `gpt-5.6-luna`). The repository is public. Do not create the `v0.3.0` tag or a GitHub Release from this checklist. SE tags after the path is green. The notes for that tag are [docs/RELEASE.md](docs/RELEASE.md).

1. Compose up with the key set. The آشپزخونه page loads.
2. «بارگذاری نمونه» shows at least eight chips.
3. One fridge photo, then confirm, adds only the checked names. Several photos share one confirm sheet, with confidence and merged names.
4. Set a week budget and «پیشنهاد دستور» returns three cards, then the button reads «پیشنهاد دستورهای بیشتر» and appends. With eight sample chips that later call asks for seven. «تعداد نفرات» starts at ۴, survives a reload, and scales card amounts, meal costs, the budget line, and «مواد خرید» without clearing the week. Generate and «بازتولید کامل» send that headcount.
5. Diet chips «گیاهی», «بدون پیاز», and «مناسب دیابت» can be combined, survive a reload, and are named on the status line.
6. After the cards, a rough calorie line may appear. If that estimate fails, the cards stay and the recipe error is not used.
7. Adding one dish fills only that day and meal. «برنامه ۷ روزه» is the separate fill for شنبه through جمعه. «خورده شد» marks one meal; «پیشنهاد دستور» then prefers remaining chips and skips that meal, and «بازتولید کامل» does not.
8. Edit the pantry and generate again.
9. «کپی لینک» copies a `#p=` link. «چاپ» is an A4 poster. A soft over-budget line does not block export. «مواد خرید» lists what the dinners need and the pantry does not have.
10. «به‌روزرسانی قیمت‌ها» stores Okala unit prices (fixture when `OKALA_LIVE=0`). Cards, the week, and shopping rows say اُکالا when that price is used, «بخشی از اُکالا» when only some lines match, and «حدود» for the GapGPT estimate. A failed refresh keeps the last price or that estimate. On مواد خرید, «جمع» sums the line totals, and a stale line says «کهنه». A manual name is included in the refresh and in «سبد اُکالا». «سبد اُکالا» copies at most ten names and opens the store; it does not prefill a basket or take payment. Headcount still scales each plan quantity once; a مقدار you typed stays.
11. Chips, budget, diet filters, the week, and a manual مواد خرید row survive a reload in Postgres for this browser id. With api stopped, the same browser still shows its `localStorage` copy (`ashpaz-khoone.pantry.v1.<id>`, `ashpaz-khoone.plan.v1.<id>`, `ashpaz-khoone.shopping.v1.<id>`). «کاربر جدید» starts an empty store and leaves the previous id in Postgres.
12. Break or unset `GAP_CODE_API_KEY`, recreate api, and confirm a Persian error with «تلاش دوباره» and no key value. Nutrition without a usable key stays HTTP 200 with `"available": false`. Restore the key and generate again.
13. The manifest and `/sw.js` are served for install. The footer says «افزودن به صفحهٔ اصلی». The worker caches the page shell only and does not call GapGPT. Chrome can install from http://localhost:8080; any other host needs HTTPS.
14. Leave tagging `v0.3.0` for SE after this path is green. Do not create the tag or a GitHub Release from this checklist.

The longer [demo path](#demo-path-qa) below still covers a boot with no key.

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

7. Open http://localhost:8080. Click «عکس یخچال», then «انتخاب عکس», pick a JPEG, and press «تشخیص مواد». Without a key, the sheet shows «در حال تشخیص مواد…» and then a Persian message that the vision service is not ready, with «تلاش دوباره». The pantry chips do not change. Closing the sheet also leaves the pantry unchanged. «انصراف» on the photo tray, before «تشخیص مواد», also leaves the pantry unchanged.

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

9. With a real key only in the gitignored `.env` or the environment, recreate the api service and repeat step 8. After the loading line, three Persian cards appear. Each card has a title, ingredient tags, and steps. A rough تومان badge appears when the model returns a cost. The button then reads «پیشنهاد دستورهای بیشتر». «افزودن به برنامه» opens one slot. Choosing it puts that title on that day and meal only. The other days stay «خالی» until «برنامه ۷ روزه». See [Meal plan](#meal-plan).

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

   Do not tag from this step. The `v0.3.0` gate is [docs/QA-SMOKE.md](docs/QA-SMOKE.md). Repeat the curl in step 7 with a real fridge photo instead of the tiny JPEG. For two photos, repeat the field in order (the page does the same):

   ```bash
   curl -sS -X POST http://localhost:8000/vision/fridge \
     -F "image=@/tmp/fridge-a.jpg;type=image/jpeg" \
     -F "image=@/tmp/fridge-b.jpg;type=image/jpeg"
   ```

   Expected HTTP 200, `"ok": true`, and an `ingredients` array of objects `{"name": "…", "confidence": 0.9}`. `confidence` is a number from 0 to 1, or `null`. The same Persian spelling appears once. The body must not contain the API key or the image bytes.

   On http://localhost:8080, use «عکس یخچال» with two photos, then «تشخیص مواد». Chips show «اطمینان …٪». The same food from both photos, including گوجه and گوجه‌فرنگی, is one chip. After «در حال تشخیص مواد…», edit or uncheck chips, then press «تأیید و افزودن به انبار». Only the names you left checked appear in the pantry, without duplicates. «انصراف» adds nothing. Tap a new chip to remove it, the same as any other pantry chip.

11. Meal plan, print, and download do not need a key. On http://localhost:8080 confirm seven days from شنبه to جمعه, each «خالی». Use «چاپ / خروجی» once, as in [Meal plan](#meal-plan). With recipe cards from step 9, assign a day, swap it with «جایگزین», and click «برنامه ۷ روزه» to fill any day that is still «خالی». Reload the page. With api and db healthy, those days are still there.

12. Shopping list, print, and download do not need a key. With the sample pantry and a dinner on the week (step 11, or the `localStorage` snippet in [Shopping list](#shopping-list)), open «مواد خرید». Chips already in the pantry are absent. Add a name with «افزودن»; it stays beside the plan rows after reload, and its مقدار does not follow تعداد نفرات. «چاپ / خروجی» on that section prints only the list and downloads `مواد-خرید.md`. An empty week with no manual row says «برنامه هفته خالی است». «پاک کردن» with a filled week says «آشپزخانه خالی است» and lists every planned ingredient. A matched row shows an Okala or «حدود» / «کهنه» price, and «جمع» when a line total exists.

## GapGPT checks (SE/QA)

Unit tests mock HTTP or talk to a local socket. They do not need a key and do not call GapGPT. `LiveSmokeTest` is skipped unless you opt in.

```bash
cd api
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python -m unittest discover -s tests -v
```

Expected: every test OK, with `LiveSmokeTest` and the optional Okala live catalog check skipped. Postgres persistence tests skip unless a database is reachable at `127.0.0.1:5432` (or `ASHPAZ_TEST_POSTGRES_HOST` / `ASHPAZ_TEST_POSTGRES_PORT`). From the repo root, `node --test web/household.test.js web/pantry.test.js web/recipes.test.js web/fridge.test.js web/plan.test.js web/shop.test.js web/persist.test.js web/pwa.test.js web/prices.test.js` covers household scaling, the pantry, the recipe page, the fridge confirm sheet, the meal plan, the shopping list, server persistence, the installable web app, and Okala price labels.

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

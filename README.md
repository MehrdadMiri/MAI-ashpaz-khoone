# MAI-ashpaz-khoone

Persian RTL AI meal and recipe demo (آشپزخونه).

`docker compose up --build` starts three services.

| Service | Image | URL |
| --- | --- | --- |
| web | nginx, Persian pantry UI | http://localhost:8080 |
| api | Python (Flask + Gunicorn) | http://localhost:8000 |
| db | Postgres 16 | localhost:5432 |

The web page is a Persian RTL pantry. You can add and remove ingredient chips, load a sample set of Iranian staples, and set a numeric week budget. The list and budget are stored in Postgres for a browser-local id, and cached in this browser (`localStorage`) when the api or database is unavailable. «پیشنهاد دستور» asks the shared GapGPT client (`api/gapgpt.py`) for at least three Persian recipes from those chips and the week budget. If a شام is marked «خورده شد», that call prefers the chips still left and asks the model not to repeat those dinners. «بازتولید کامل» uses every chip again and does not skip them. «عکس یخچال» sends one photo to the same client and shows candidate chips; nothing is added to the pantry until you confirm. «برنامه ۷ روزه» assigns those recipes to شنبه through جمعه and can print or download the week. The plan does not call GapGPT. «مواد خرید» diffs those planned dinners against the pantry chips and can print or download the missing items. That list does not call GapGPT either. After the recipe cards appear, the page asks the same client for a rough per-serving calorie estimate (and protein, carbohydrate, and fat when the model returns them). Each card says those numbers are an AI estimate. If that call fails, the cards stay without them. Product UI is Persian RTL. This scaffold’s docs and code comments are English.

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

`.env.example` has placeholders only. `.gitignore` excludes `.env`. Do not commit `GAP_CODE_API_KEY` or any real key. Put the key only in the environment or the gitignored `.env`. Do not put it in URLs, command lines, or logs.

## Saved pantry and week plan

Pantry chips, the week budget, diet filters, and the 7-day plan are stored in Postgres. The plan row includes recipe titles, ingredient lines, steps, costs, the شنبه–جمعه slots, and «خورده شد». There is no account and no password. On the first visit the page creates a random id, stores it in `localStorage` (`ashpaz-khoone.local-user.v1`) and a `ashpaz_local_user` cookie (`Path=/`, `SameSite=Lax`, one year), and sends it as `X-Local-User-Id`. The same id may also be a `local_user_id` query or JSON field. It is not a credential. Do not put `GAP_CODE_API_KEY`, or any other secret, in the pantry or the plan.

`GET` and `PUT /pantry` and `GET` and `PUT /plan` are the routes. Nginx forwards `/api/pantry` and `/api/plan` to them. A missing row is `found: false` and does not wipe the browser. A saved row is what a refresh shows for that id.

The page still writes `ashpaz-khoone.pantry.v1` and `ashpaz-khoone.plan.v1` on every change. If the api or Postgres is unavailable, those keys are the copy you see, and the next load tries the api again. An edit that has not reached Postgres yet is sent again before a saved row can replace it.

The tables are `pantry_state` and `week_plan_state`. `POSTGRES_USER`, `POSTGRES_PASSWORD`, and `POSTGRES_DB` are the role, password, and database name. The Postgres image applies them only when the `pgdata` volume is created. Changing them later does not alter a volume that already has data. `POSTGRES_HOST` and `POSTGRES_PORT` are set on the api container (`db` and `5432` on the compose network). Port `5432` is published for local tools.

`api/migrations/001_kitchen_state.sql` is mounted into `docker-entrypoint-initdb.d`, so a new volume creates the tables. Those init scripts do not run again on a volume that already exists. The api runs the same file (`CREATE TABLE IF NOT EXISTS`) when it reaches the database, including from `/health`, so an older volume gains the tables without a reset. `/health` is still that check plus `SELECT 1`. It does not return pantry rows or the database password.

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

`local-user-demo1` is a placeholder id, not a credential. A refresh of http://localhost:8080 keeps the chips, the budget, and the week for that browser. Checks without a browser:

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

The request JSON is `{ "ingredients": ["برنج"], "budget": 1500000 }`. `budget` may be `null` when the week field is empty; the model prompt still includes that budget context. Leftover regenerate adds `remaining`, `skip`, and `full` (see [Leftover regenerate](#leftover-regenerate)). Active diet chips add `filters` (see [Diet filters](#diet-filters)). The api service calls GapGPT with `GapGPTClient.chat_text` and the configured model (`gpt-5.6-luna` unless `GAPGPT_MODEL` is set). The key stays in the api container. The page never receives it.

### Diet filters

Three chips sit with «پیشنهاد دستور»: «گیاهی», «بدون پیاز», and «مناسب دیابت». Each one toggles on its own, and any combination is allowed. The choice is stored on the pantry snapshot (`filters` in `ashpaz-khoone.pantry.v1` and in the Postgres pantry row), so a reload keeps it. «پاک کردن» empties the chips and leaves the filters as they are.

When at least one chip is on, the generate body includes all three flags:

```json
"filters": {"vegetarian": true, "no_onion": false, "diabetic": true}
```

Missing `filters`, or `null`, means all three are off. A value that is not `true` or `false` is HTTP 400 `invalid_request`. The message does not echo that value. The GapGPT prompt lists only the active limits and tells the model they override the pantry, including a pantry item the limit forbids. After the reply, the api drops a recipe that clearly names a forbidden food when three other recipes remain. If fewer than three pass, the three recipes are still returned, so the check cannot fail generation. A timeout, a missing key, or an unreadable reply is unchanged: the page shows the Persian retry, and the chips stay.

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
| Unreadable model output, or fewer than three usable recipes | 502 | `bad_response` | friendly retry, plus the key hint |

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

«عکس یخچال» is on the pantry page. It does not add anything by itself. One confirm flow can take up to six photos. This slice does not create a `v0.2.0` tag.

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

The week is شنبه through جمعه, one شام per day. An empty day shows «خالی». Assignments, recipe titles, and «خورده شد» are stored in Postgres for this browser's local id. The browser also keeps them in `localStorage` (`ashpaz-khoone.plan.v1`) and uses that copy when the api or database is unavailable.

- «افزودن به برنامه» on a recipe card opens a sheet of the seven days, the same sheet pattern as fridge confirm. Pick a day to assign that recipe. A day that already has a شام offers «جایگزین».
- «برنامه ۷ روزه» fills every empty day from the recipes already on the page, repeating them when there are fewer than seven. Days you already filled stay as they are. With no recipes yet, the seven days stay «خالی» and the status line asks you to suggest recipes first. «انتخاب» on an empty day opens the recipe list once recipes exist.
- On a filled day, «جایگزین» opens that list, plus «خالی» to clear the day.
- «خورده شد» on a filled day marks that شام as eaten. Press it again to undo. Replacing or clearing the day clears the mark. The mark is stored on the plan (`used`), in Postgres and in `ashpaz-khoone.plan.v1`, and is what leftover regenerate skips. Print and Markdown add «خورده شد» on that day. Empty days have no toggle.
- If the week budget is set and a recipe has a تومان cost, a line under the title sums the شام costs. When the sum is over the budget the line says so and adds that چاپ و خروجی are still allowed. You can still assign, swap, print, and download.
- «کپی لینک» copies a link that reopens this week. The link is only a `#p=` hash on this page: day, شام title, cost, «خورده شد», ingredients, and steps. It does not include the browser's local user id, `GAP_CODE_API_KEY`, or other environment values. Opening it replaces the plan in this browser; Postgres then stores that week under the reader's own id. An empty week still copies, and opening that link shows «برنامه هفته خالی است».
- «چاپ / خروجی» opens a sheet with «چاپ» and «دانلود مارک‌داون», and shows the same share link so it can be copied from the field.

Print uses `@media print` in `web/pantry.css` (`A4`, RTL, Vazirmatn). To print once: open http://localhost:8080, click «چاپ / خروجی», then «چاپ». The poster is a white page. Each day is one block that does not split across pages: «روز» and the Iranian weekday, then «وعده» and شام, then the recipe title or «خالی». The pantry, recipe cards, fridge sheet, footer, and buttons stay hidden.

«دانلود مارک‌داون» saves `برنامه-۷-روزه.md`: a heading and one line per day, with the Persian day name and the recipe title (or «خالی»).

Checks without a browser and without an API key:

```bash
node --test web/plan.test.js
```

QA on http://localhost:8080, still with no key:

1. Confirm seven days, شنبه first and جمعه last. Each shows «خالی» and «انتخاب». The plan says «برنامه هفته خالی است».
2. Click «چاپ / خروجی», then «چاپ». The preview is an A4 poster: white, Persian, right to left. Each day shows «روز» and «وعده», and «خالی» when nothing is assigned. The pantry and the recipe controls are not in the preview. Close the preview.
3. Click «کپی لینک». The copied address ends with `#p=` and does not contain `local_user_id` or an API key. Open it in a new tab. The week is still the seven empty days, and the page says the shared plan is empty. The hash is then removed so a later edit is not reset on reload. With a filled week, the same link restores those شام titles.
4. Click «چاپ / خروجی», then «دانلود مارک‌داون». The file lists all seven days as خالی.
5. After «پیشنهاد دستور» (that call needs a key), «افزودن به برنامه» chooses a day, «جایگزین» swaps it, and «برنامه ۷ روزه» fills any day that is still «خالی». «خورده شد» on a filled day does not need a key. Copy the link again and open it: those titles come back, still without a key in the address.

## Leftover regenerate

«پیشنهاد دستور» is leftover-aware. «بازتولید کامل» is the explicit full path. Neither button clears the pantry chips or the week budget. Assigned dinners stay on the week until you change them. New cards are remembered for «افزودن به برنامه» and «برنامه ۷ روزه».

On each filled day, «خورده شد» toggles that شام. While it is on, the day is marked eaten.

- «پیشنهاد دستور» sends the full chip list as `ingredients`, plus `remaining` (chips not used by eaten dinners) and `skip` (those dinner titles), with `full: false`. A chip is treated as used when an eaten dinner’s ingredient line is the same pantry name, including «۲ عدد پیاز» for پیاز. «روغن» is not used up by «روغن زیتون». The prompt still includes the week budget. The model is told to cook from the remaining chips and not to repeat the skipped titles. The response drops a title that matches a skipped dinner (spacing and ZWNJ ignored). A successful body is `mode: "leftovers"`. The status line says the ideas came from what is left. If every chip was used, the page does not call the API; it asks you to add a chip or press «بازتولید کامل».
- «بازتولید کامل» sends `ingredients`, `budget`, and `full: true`. It does not send `skip`. The prompt tells the model to ignore leftovers, and the week budget is still in that prompt. Eaten titles may come back. The body is `mode: "full"`. «تلاش دوباره» repeats whichever button failed.
- With no شام marked eaten, «پیشنهاد دستور» stays `{ "ingredients", "budget" }` and `mode` is `"pantry"`.

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

Live smoke, only with a real key in the host file `…/MAI/.env` (gitignored; never print it, never commit it). This repo’s `.env` is gitignored too. Load the variable without echoing it, recreate api, then call both shapes. Do not create a `v0.2.0` tag from this check.

```bash
set -a
# shellcheck disable=SC1091
source /path/to/MAI/.env
set +a
test -n "$GAP_CODE_API_KEY" && echo "GAP_CODE_API_KEY is set (value hidden)"
docker compose up -d --force-recreate api
```

Leftover (remaining chips, skip the eaten dinner). Expect HTTP 200, `"mode": "leftovers"`, and three recipes whose titles are not the skipped dinner. The body must not contain the key.

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

On http://localhost:8080 with the same key: mark one filled day «خورده شد», press «پیشنهاد دستور», and confirm the new cards appear, that day stays, and the chips stay. Then press «بازتولید کامل» and confirm the chips still stay. With the key removed, both buttons show the Persian error and «تلاش دوباره», and retry repeats the same button.

## Shopping list

«مواد خرید» is on the week plan. It does not call GapGPT and does not read `GAP_CODE_API_KEY`. The browser diffs pantry chips against the ingredient lines already stored on each planned شام — the same lines the recipe cards show. The shopping list is not its own Postgres row and it has no `localStorage` key. Change a chip or a day and the list is rebuilt.

- A chip covers a recipe line after the pantry's usual cleanup (spacing, ZWNJ, Arabic and Persian letters). A pantry name also covers a longer line when the extra words are only size or prep, so پیاز covers «۲ عدد پیاز متوسط». «روغن» does not cover «روغن زیتون».
- A quantity on the stored line is kept (`۲۰۰ گرم`, `نصف پیمانه`, `۳ عدد`, `یک و نیم پیمانه`). The same item and unit are added across the days that شام is planned. Different units stay side by side. With no quantity, a repeated item says how many dinners need it.
- Rows are grouped with a small built-in map: سبزی و صیفی، میوه، پروتئین، لبنیات، حبوبات و غلات، نان و آرد، چاشنی و ادویه، خشکبار. Anything else is «سایر».
- «چاپ / خروجی» on this section prints only the list (white page, Vazirmatn, RTL) or downloads `مواد-خرید.md`. Printing the week still hides this section.

Empty states:

- No شام on the week: «برنامه هفته خالی است».
- No شام and no chips: «برنامه و آشپزخانه خالی است».
- Chips empty, week filled: «آشپزخانه خالی است», and every planned ingredient is on the list.
- Every planned ingredient is already a chip: «چیزی برای خرید نمانده».

If a planned dinner has no ingredient lines, that day is named under the list and left off it. Guessing those lines with GapGPT (`gpt-5.6-luna` through `GapGPTClient`) is not wired. Recipe cards already include `ingredients`, so the list stays a client-side diff and a missing list stays visible instead of being filled with a guessed one.

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
      sat: "r:عدسپلو",
      sun: null,
      mon: null,
      tue: null,
      wed: null,
      thu: null,
      fri: null,
    },
  }),
);
```

The slot id is `r:` plus the title with spaces and ZWNJ removed. If this browser already has a plan in Postgres, reload shows that row instead of this snippet. The snippet is what you see when the api is unavailable, or when `GET /plan` is `found: false` (the page then saves this cache). After reload:

1. Click «مواد خرید». برنج، عدس، and پیاز are already chips, so they are absent. گوشت is listed as ۲۰۰ گرم under پروتئین.
2. «چاپ / خروجی» on the shopping section, then «چاپ». The preview is the list, in Persian, on white. The pantry and the seven day cards are not in it.
3. «دانلود مارک‌داون» saves `مواد-خرید.md`.
4. Clear every day (or remove the plan key and reload). The section says the week is empty.
5. With the dinner restored, «پاک کردن» says the pantry is empty and lists every ingredient on that dinner.

With a key, the same checks work after «پیشنهاد دستور» and «برنامه ۷ روزه» instead of the `localStorage` snippet. The page still does not send the list to GapGPT.

## QA smoke

The release smoke for this slice is [docs/QA-SMOKE.md](docs/QA-SMOKE.md). Run it with a real key only in the gitignored `.env` or the environment. Do not print the key. Do not tag `v0.1.0` from this work; that tag is ticket #8 after this path is green.

1. Compose up with the key set. The آشپزخونه page loads.
2. «بارگذاری نمونه» shows at least eight chips.
3. Fridge photo, then confirm, adds only the checked names.
4. Set a week budget and «پیشنهاد دستور» returns at least three cards.
5. «برنامه ۷ روزه» fills شنبه through جمعه. Empty days stay «خالی» until filled. «خورده شد» marks a day; «پیشنهاد دستور» then prefers remaining chips and skips that dinner, and «بازتولید کامل» does not.
6. Edit the pantry and generate again.
7. «چاپ / خروجی» prints and downloads Markdown. A soft over-budget line does not block export.
8. Break or unset `GAP_CODE_API_KEY`, recreate api, and confirm a Persian error with «تلاش دوباره» and no key value. Restore the key and generate again.
9. Leave tagging `v0.1.0` for ticket #8.

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

9. With a real key only in the gitignored `.env` or the environment, recreate the api service and repeat step 8. After the loading line, at least three Persian cards appear. Each card has a title, ingredient tags, and steps. A rough تومان badge appears when the model returns a cost. «افزودن به برنامه» on a card opens the seven days. Choosing one puts that title on the week. See [Meal plan](#meal-plan).

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

   Do not tag `v0.2.0`. Repeat the curl in step 7 with a real fridge photo instead of the tiny JPEG. For two photos, repeat the field in order (the page does the same):

   ```bash
   curl -sS -X POST http://localhost:8000/vision/fridge \
     -F "image=@/tmp/fridge-a.jpg;type=image/jpeg" \
     -F "image=@/tmp/fridge-b.jpg;type=image/jpeg"
   ```

   Expected HTTP 200, `"ok": true`, and an `ingredients` array of objects `{"name": "…", "confidence": 0.9}`. `confidence` is a number from 0 to 1, or `null`. The same Persian spelling appears once. The body must not contain the API key or the image bytes.

   On http://localhost:8080, use «عکس یخچال» with two photos, then «تشخیص مواد». Chips show «اطمینان …٪». The same food from both photos, including گوجه and گوجه‌فرنگی, is one chip. After «در حال تشخیص مواد…», edit or uncheck chips, then press «تأیید و افزودن به انبار». Only the names you left checked appear in the pantry, without duplicates. «انصراف» adds nothing. Tap a new chip to remove it, the same as any other pantry chip.

11. Meal plan, print, and download do not need a key. On http://localhost:8080 confirm seven days from شنبه to جمعه, each «خالی». Use «چاپ / خروجی» once, as in [Meal plan](#meal-plan). With recipe cards from step 9, assign a day, swap it with «جایگزین», and click «برنامه ۷ روزه» to fill any day that is still «خالی». Reload the page. With api and db healthy, those days are still there.

12. Shopping list, print, and download do not need a key. With the sample pantry and a dinner on the week (step 11, or the `localStorage` snippet in [Shopping list](#shopping-list)), open «مواد خرید». Chips already in the pantry are absent. «چاپ / خروجی» on that section prints only the list and downloads `مواد-خرید.md`. An empty week says «برنامه هفته خالی است». «پاک کردن» with a filled week says «آشپزخانه خالی است» and lists every planned ingredient.

## GapGPT checks (SE/QA)

Unit tests mock HTTP or talk to a local socket. They do not need a key and do not call GapGPT. `LiveSmokeTest` is skipped unless you opt in.

```bash
cd api
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python -m unittest discover -s tests -v
```

Expected: every test OK, with `LiveSmokeTest` skipped. Postgres persistence tests skip unless a database is reachable at `127.0.0.1:5432` (or `ASHPAZ_TEST_POSTGRES_HOST` / `ASHPAZ_TEST_POSTGRES_PORT`). From the repo root, `node --test web/pantry.test.js web/recipes.test.js web/fridge.test.js web/plan.test.js web/shop.test.js web/persist.test.js web/pwa.test.js` covers the pantry, the recipe page, the fridge confirm sheet, the meal plan, the shopping list, server persistence, and the installable web app.

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

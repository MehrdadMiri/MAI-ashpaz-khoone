# QA smoke — آشپزخونه v0.2.0

Release gate for tag `v0.2.0`. `v0.1.0` is already tagged (pantry chips, one fridge photo, recipe cards, the 7-day plan, and the empty, loading, and error polish). This checklist is the full path that must be green before that next tag. It keeps the v0.1 path and adds the v0.2 theme:

| v0.2 feature | Step |
| --- | --- |
| Shopping list (مواد خرید) | 7b |
| Leftover-aware regenerate | 5b |
| Multi-photo fridge vision | 3b |
| Postgres pantry/plan persist + localStorage fallback | 7c |
| Nutrition on cards (soft-fail) | 4c |
| Share/print week (`#p=` + A4 poster) | 7 |
| Diet filters (گیاهی / بدون پیاز / مناسب دیابت) | 4b |
| Household size (تعداد نفرات scales amounts and cost) | 4d |
| Okala prices and assisted cart (ticket #20) | 7d |
| PWA install (manifest, service worker shell-only, install note) | 9 |

Do **not** create the `v0.2.0` tag or a GitHub Release from this checklist. SE tags after this path is green. Short notes for that tag are [RELEASE.md](RELEASE.md).

Steps 5, 5b, 7, and 7b also cover the v0.3 week (صبحانه، ناهار، شام — ۲۱ slots). Step 7d covers v0.3 Okala prices. Do **not** create a `v0.3.0` tag from those checks.

## Repo and secrets

The GitHub repository is public: https://github.com/MehrdadMiri/MAI-ashpaz-khoone

- `.gitignore` ignores `.env` and `.env.*`, and keeps `.env.example`.
- `.env.example` is placeholders only. `GAP_CODE_API_KEY=` is empty. `GAPGPT_MODEL` is `gpt-5.6-luna`. `POSTGRES_PASSWORD` is the local placeholder `change-me`.
- No real `GAP_CODE_API_KEY` belongs in git, the shell history, a screenshot, or a log paste. Put the key only in the gitignored `.env` or the environment.

Confirm before the rest of the gate. The last command should print nothing (exit 1): the example key line has no value.

```bash
git check-ignore -v .env
git grep -n '^GAP_CODE_API_KEY=' -- .env.example
git grep -n '^GAP_CODE_API_KEY=.' -- .env.example
```

Expected: `.gitignore` matches `.env`, and `.env.example` shows `GAP_CODE_API_KEY=` with nothing after the equals sign.

Confirm a loaded key without printing it:

```bash
test -n "$GAP_CODE_API_KEY" && echo "GAP_CODE_API_KEY is set (value hidden)"
```

## Automated checks

No key and no network:

```bash
node --test web/household.test.js web/pantry.test.js web/recipes.test.js web/fridge.test.js web/plan.test.js web/shop.test.js web/persist.test.js web/pwa.test.js web/prices.test.js
cd api && python3 -m unittest discover -s tests -v
```

`LiveSmokeTest` stays skipped unless `GAPGPT_LIVE_SMOKE=1`. `test_live_smoke_one_catalog_page` stays skipped unless `OKALA_LIVE_SMOKE=1`. The default suite uses `api/fixtures/okala_catalog.json` and does not call okala.com.

Installability is `web/pwa.test.js` plus the footer line «افزودن به صفحهٔ اصلی» (step 9). Chrome can install from http://localhost:8080; any other host needs HTTPS. The service worker caches the page shell only and does not call GapGPT.

## Checklist

### 1. Compose up with a key — the UI loads

From the repo root, with the key only in `.env`:

```bash
cp .env.example .env
# Edit .env and set GAP_CODE_API_KEY there. Do not echo the value.
docker compose up --build
```

Wait until `web`, `api`, and `db` are healthy (`docker compose ps`).

- Open http://localhost:8080. The page is Persian, right to left, title آشپزخونه.
- `curl -fsS http://localhost:8080/health` returns `ok`.
- `curl -fsS http://localhost:8000/health` is JSON with `"status": "ok"` and `"gapgpt": {"configured": true, ...}`. The body must not contain the key. `model` is `gpt-5.6-luna` unless `GAPGPT_MODEL` was changed.

### 2. Seed — at least eight chips

On a fresh browser profile (or after «پاک کردن»):

- The empty kitchen shows an illustration, «هنوز چیزی در آشپزخانه نیست», and the actions «بارگذاری نمونه», «افزودن ماده», and «عکس یخچال».
- «افزودن ماده» focuses the name field. «عکس یخچال» opens the sheet and does not add a chip by itself.
- «بارگذاری نمونه» loads برنج، پیاز، عدس، لوبیا، سیب‌زمینی، گوجه‌فرنگی، ماست، روغن. The count is at least 8. Running it again does not duplicate them.

### 3. Fridge photo — confirm — pantry

- «عکس یخچال» → «انتخاب عکس» (or the camera). A gallery photo or a camera frame waits in the tray. Press «تشخیص مواد».
- While the request runs, the sheet shows that photo and «در حال تشخیص مواد…». «پیشنهاد دستور» is unrelated; this sheet’s own controls stay single-submit.
- «انصراف» on the tray, before detection, closes the sheet and adds nothing. «انصراف» during the wait closes the sheet, adds nothing, and does not show an error. The pantry is unchanged. Try the photo again.
- On the confirm sheet, each chip shows «اطمینان …٪» or «نامشخص». Uncheck or edit a name if you want. «تأیید و افزودن به انبار» adds only the checked names, without duplicates. «انصراف» on the confirm sheet adds nothing.

### 3b. Several fridge photos — confidence and merged names

Up to six photos share one confirm flow. This step is part of the v0.2.0 gate. The tag itself is step 10.

- Add at least two photos before detection: multi-select in «انتخاب عکس», or «ثبت این عکس» twice, or one of each plus «عکس دیگر». The tray lists them in that order. «حذف» drops one and keeps the rest in order.
- «تشخیص مواد» sends one request. The sheet shows those photos and «در حال تشخیص مواد…». Cancel still adds nothing.
- Confirm chips show a confidence. The same food from more than one photo is a single chip (spacing, ZWNJ, and Arabic/Persian letters). گوجه together with گوجه‌فرنگی is also one chip, labeled گوجه‌فرنگی, and the sheet says «مواد تکراری یا هم‌نام یکی شدند». پیاز and پیازچه stay separate.
- Uncheck one chip. «تأیید و افزودن به انبار» adds only the checked names. «انصراف» adds nothing.
- A seventh photo is refused in Persian. The pantry does not change.

Shell, key missing or invalid (the body must not contain the key, a traceback, or the image):

```bash
python3 - <<'PY'
from pathlib import Path
jpeg = bytes.fromhex("ffd8ffe000104a46494600010100000100010000ffd9")
Path("/tmp/fridge-a.jpg").write_bytes(jpeg)
Path("/tmp/fridge-b.jpg").write_bytes(jpeg)
PY
curl -sS -X POST http://localhost:8000/vision/fridge \
  -F "image=@/tmp/fridge-a.jpg;type=image/jpeg" \
  -F "image=@/tmp/fridge-b.jpg;type=image/jpeg"
```

Missing key: HTTP 503, `"error": "not_configured"`. Invalid key: HTTP 502, `"error": "unauthorized"`.

Live smoke with a real key only in the host file `…/MAI/.env` (or this repo’s gitignored `.env`). Do not echo the value. Do not tag `v0.2.0` from this step.

```bash
set -a
# shellcheck disable=SC1091
source /path/to/MAI/.env
set +a
test -n "$GAP_CODE_API_KEY" && echo "GAP_CODE_API_KEY is set (value hidden)"
docker compose up -d --force-recreate api
```

Repeat the two-photo curl with real fridge JPEGs instead of the tiny file. Expected HTTP 200, `"ok": true`, and `ingredients` as objects `{"name","confidence"}`. Confidence is from 0 to 1, or `null`. The body must not contain the key or the image bytes. On the page, confirm only the chips you leave checked.

### 4. Budget — generate at least three

- Set «بودجه هفته» to a number such as `1500000`.
- Before the first success, the recipe panel asks you to set the budget and press «پیشنهاد دستور».
- Press «پیشنهاد دستور» once. The status is «در حال پختن ایده‌ها…», skeleton cards show, and the button does not send a second request while the first is in flight.
- At least three Persian cards appear. Each has a title, ingredient tags, and steps. Spot-check them against the pantry names. A تومان badge appears when the model returned a cost.
- Continue with 4b and 4c before leaving these cards.

### 4b. Diet filters

Three chips sit under the recipe actions: «گیاهی», «بدون پیاز», and «مناسب دیابت». The group label is «محدودیت غذایی».

- Each chip toggles on its own. Any combination is allowed, including all three and none.
- Turn on «گیاهی» and «مناسب دیابت». Leave «بدون پیاز» off. Press «پیشنهاد دستور». At least three cards still appear. The status line includes «با محدودیت گیاهی، مناسب دیابت.» and does not name «بدون پیاز».
- Reload http://localhost:8080. The same chips stay on. They are stored with the pantry (`filters` on `ashpaz-khoone.pantry.v1` and on the Postgres pantry row).
- Turn every chip off and generate again. That call is allowed, and the status line does not say «با محدودیت».
- «پاک کردن» empties the pantry chips and leaves the diet chips as they are.

Shell, key missing or invalid (the body must not contain the key or a traceback):

```bash
curl -sS -X POST http://localhost:8000/recipes/generate \
  -H 'Content-Type: application/json' \
  -d '{"ingredients":["برنج","عدس","ماست"],"budget":1500000,"filters":{"vegetarian":true,"no_onion":true,"diabetic":false}}'
```

Missing key: HTTP 503, `"error": "not_configured"`. Invalid key: HTTP 502, `"error": "unauthorized"`. A filter value that is not `true` or `false` is HTTP 400, `"error": "invalid_request"`, and the message does not echo that value.

Live smoke uses the same key file as step 3b. Do not echo the value. Expected HTTP 200, `"ok": true`, and three recipes. The body must not contain the key.

### 4c. Nutrition on the cards (soft-fail)

After the cards from step 4 are on the page, the browser calls `POST /api/recipes/nutrition`. That call can fail without removing the cards.

- While the estimate runs, each card may show «در حال برآورد کالری…».
- When numbers come back, the card shows «حدود … کیلوکالری در هر وعده», and protein, carbohydrate, and fat when those numbers came back. The card says «این عددها برآورد هوش مصنوعی هستند، نه مقدار دقیق غذا.»
- If the estimate call fails, the cards stay and that block is absent. It does not use the recipe error or «تلاش دوباره». A generate failure is separate and still uses that error.

Without a key, nutrition is HTTP 200 and does not fail the recipe route. The body must not contain the key:

```bash
curl -sS -X POST http://localhost:8000/recipes/nutrition \
  -H 'Content-Type: application/json' \
  -d '{"recipes":[{"title":"عدس‌پلو","ingredients":["برنج","عدس"],"steps":["عدس را بپز","برنج را دم کن","سرو کن"]}]}'
```

Expected: HTTP 200, `"available": false`, and `null` for that recipe. With a real key in the gitignored `.env` only, the same call is HTTP 200, `"available": true`, and a `kcal` on each estimate the model could read. Do not echo the key. Calorie lines stay «در هر وعده». They are not multiplied by تعداد نفرات.

### 4d. تعداد نفرات — portions and cost

This check is the v0.3 household-size slice (ticket #19). Do **not** create a `v0.3.0` tag from it.

The header control is «تعداد نفرات». It starts at ۴, next to «بودجه هفته». «−» and «+» move it. The allowed range is ۱ to ۱۲.

Stored recipe amounts and `cost_toman` are for that recipe's `servings`. A recipe saved before this control, with no `servings`, is treated as 4 people. Displayed quantities and costs use `تعداد نفرات / servings`. Changing the number does not clear the week, the chips, or the cards.

- With cards on the page, each card says «برای ۴ نفر». Set the control to ۲. Ingredient amounts that had a number are cut in half, the تومان badge is cut in half, and the week’s meal costs and budget line follow. Slots you already filled stay filled, with the same titles.
- Set it to ۸. Those amounts and costs double from the 4-person base (or scale from each recipe’s own `servings`). A line with no number, such as «برنج», stays as written. Steps are not rewritten.
- Reload http://localhost:8080. تعداد نفرات is still the number you set. It is `household` on `ashpaz-khoone.pantry.v1` and on the Postgres pantry row. «پاک کردن» empties the chips and leaves the headcount.
- Press «پیشنهاد دستور», then «بازتولید کامل». Both requests include `household`. New cards are stamped for that headcount, so at the current number the new amounts match the model and are not scaled a second time. The week slots stay until you change them.
- «مواد خرید» quantities follow the same scale. The section says the amounts were counted for that headcount. Chips you already have are still absent.
- The calorie line, when it appears, still says «در هر وعده» and is not multiplied.

Shell, no key (the body must not contain a key or a traceback):

```bash
curl -sS -X POST http://localhost:8000/recipes/generate \
  -H 'Content-Type: application/json' \
  -d '{"ingredients":["برنج","عدس"],"budget":1500000,"household":8}'
```

Missing key: HTTP 503, `"error": "not_configured"`. The same call with `"household": 0` or `"household": 99` is HTTP 400, `"error": "invalid_household"`, and the message does not echo that value. A missing `household` is accepted as 4 once a key is present.

Automated checks, no key and no network:

```bash
node --test web/household.test.js web/pantry.test.js web/recipes.test.js web/plan.test.js web/shop.test.js web/persist.test.js
cd api && python3 -m unittest tests.test_recipes tests.test_store tests.test_state_endpoint -v
```

### 5. Seven-day plan — صبحانه، ناهار، شام

This check is the v0.3 meal-slot slice (ticket #18). Do **not** create a `v0.3.0` tag from it.

- The week is شنبه through جمعه. Each day shows سه وعده: صبحانه، ناهار، شام. An empty slot says «خالی» and offers «انتخاب».
- «برنامه ۷ روزه» fills every empty slot from the cards. With more than one recipe, one day does not get the same dish for all three meals. A single recipe may fill every empty slot. Slots you already filled stay as they are.
- «افزودن به برنامه» on a card assigns that recipe to one slot (۲۱ choices). «جایگزین» swaps that slot. «خالی» on that sheet clears that slot only.
- On a filled slot, «خورده شد» toggles that meal. The other meals on the day stay as they are. Press again to undo. «جایگزین» or «خالی» on that slot clears its mark. The pantry chips do not change.
- An older dinner-only week (one recipe id on the day) still shows that dish as شام. صبحانه and ناهار start «خالی».

### 5b. Leftover regenerate vs full regenerate

Needs at least one filled day (step 5) and the sample chips (step 2). This step is part of the v0.2.0 gate. The tag itself is step 10.

- Mark one شام «خورده شد». That slot shows the meal is eaten. The other meals, the other days, and the chips stay. Marking صبحانه does not mark ناهار or شام.
- Press «پیشنهاد دستور». The request uses the chips that eaten meal did not use, and it skips that meal’s title. The week budget is still sent. At least three new cards replace the previous cards. The eaten slot stays. The pantry chips are unchanged.
- Press «بازتولید کامل». This call uses every chip, keeps the same budget, and does not skip the eaten title. The cards refresh. The chips and the eaten mark stay.
- If the eaten meals have used every chip, «پیشنهاد دستور» does not call the API. It asks you to add a chip or press «بازتولید کامل». «بازتولید کامل» still calls with the full chip list.
- Diet chips that are still on (step 4b) stay on for both buttons. The status line still names them.

Shell, key missing or invalid (the body must not contain the key or a traceback):

```bash
curl -sS -X POST http://localhost:8000/recipes/generate \
  -H 'Content-Type: application/json' \
  -d '{"ingredients":["برنج","عدس","پیاز","ماست"],"budget":1500000,"remaining":["ماست"],"skip":["عدس‌پلو"],"full":false}'

curl -sS -X POST http://localhost:8000/recipes/generate \
  -H 'Content-Type: application/json' \
  -d '{"ingredients":["برنج","عدس","پیاز","ماست"],"budget":1500000,"full":true}'
```

Missing key: HTTP 503, `"error": "not_configured"`. Invalid key: HTTP 502, `"error": "unauthorized"`. Empty `remaining` without `"full": true` is HTTP 400, `"error": "no_remaining"`, and does not call GapGPT.

Live smoke with a real key only in the host file `…/MAI/.env` (or this repo’s gitignored `.env`). Do not echo the value. Do not tag `v0.2.0` from this step.

```bash
set -a
# shellcheck disable=SC1091
source /path/to/MAI/.env
set +a
test -n "$GAP_CODE_API_KEY" && echo "GAP_CODE_API_KEY is set (value hidden)"
docker compose up -d --force-recreate api
```

Repeat the two curls. Leftover: HTTP 200, `"mode": "leftovers"`, three recipes, titles not «عدس‌پلو». Full: HTTP 200, `"mode": "full"`, three recipes, budget still applied, the eaten title is allowed. Neither body contains the key. On the page, a bad key still shows the Persian error and «تلاش دوباره» for both buttons, and retry repeats the button you pressed.

### 6. Edit the pantry — generate again

- Remove one chip and add a different ingredient.
- Press «پیشنهاد دستور» again. A new set of at least three cards replaces the previous set. The pantry chips you just edited are still there. The week keeps the meals already assigned unless you change them.

### 7. Share and print the week

- «چاپ / خروجی» → «چاپ». The preview is an A4 poster: white, Persian, right to left. Each day is one block («روز», weekday, then «وعده» for صبحانه، ناهار، and شام, title or «خالی») and is not split across pages. Pantry, recipe controls, and sheets are not in the preview. An empty week also shows «برنامه هفته خالی است».
- «کپی لینک» copies a `#p=` link that reopens the same seven days and all three meals, including an empty week. The link does not contain `local_user_id` or an API key. Opening it in this browser replaces the week; Postgres then stores that week under this browser’s own id. A `v: 1` link still opens as شام only.
- «چاپ / خروجی» → «دانلود مارک‌داون» saves `برنامه-۷-روزه.md` with صبحانه، ناهار، and شام on every day.
- If the summed meal costs are over «بودجه هفته», the plan line says «بیشتر از بودجه هفته» and چاپ و خروجی are still allowed. Print and download still work. The warning does not block them. The same dish on two slots counts twice.

### 7b. مواد خرید

After the week has at least one meal (step 5) and the pantry has chips (step 2). This check does not call GapGPT. Do **not** create a `v0.3.0` tag from it.

- «مواد خرید» on the plan scrolls to the shopping list.
- Rows are ingredients on every planned meal (صبحانه، ناهار، شام) that are not already chips. A chip covers the usual spelling variants (spacing, ZWNJ, Arabic/Persian letters). Filling all ۲۱ slots still drops chips you already have and adds quantities across those slots.
- If a stored line has a quantity, the row shows it, scaled for تعداد نفرات (step 4d). Rows are grouped (سبزی و صیفی، پروتئین، …). The section says the amounts were counted for that headcount.
- «چاپ / خروجی» on that section → «چاپ» is a white RTL page of the list only. The week grid and the pantry are hidden.
- «دانلود مارک‌داون» saves `مواد-خرید.md` with Persian headings.
- With no meal left on the week, the section says «برنامه هفته خالی است».
- With a filled week, «پاک کردن» says «آشپزخانه خالی است» and lists every planned ingredient.

Without a key, the same list can be checked after «بارگذاری نمونه» by saving a plan in the browser and reloading. See the shopping-list section of the README for the `localStorage` snippet (`ashpaz-khoone.plan.v1`, Saturday slot `r:عدسپلو`). If this browser id already has a plan in Postgres, reload shows that row; the snippet applies when the api is down or `GET /plan` is `found: false`.

### 7c. Pantry and plan survive refresh

With `db` and `api` healthy. No API key is required. This step is part of the v0.2.0 gate.

- Add a chip and a week budget. Turn on one diet chip (step 4b). Set تعداد نفرات to something other than ۴ (step 4d). Reload http://localhost:8080. The chip, the budget, the diet chip, and the headcount are still there.
- Assign a شام and a صبحانه, and mark «خورده شد» on one of them. Reload. Both meals and that mark are still there. The other meal is not marked eaten.
- In this browser, `localStorage` holds `ashpaz-khoone.pantry.v1` (chips, budget, `filters`, `household`) and `ashpaz-khoone.plan.v1` (the week, including «خورده شد» and `servings` on recipes that have it). The browser id is `ashpaz-khoone.local-user.v1`. None of those values is `GAP_CODE_API_KEY`.
- Stop the api container and reload. The same browser still shows that cached pantry and plan. Start api again and reload. The saved Postgres rows are back, including the diet filters.

```bash
docker compose stop api
# Reload http://localhost:8080 and confirm the cached chips and week.
docker compose start api
```

### 7d. Okala prices and assisted cart

This check is the v0.3 price slice (ticket #20). Do **not** create a `v0.3.0` tag from it. It does not need `GAP_CODE_API_KEY`. `/health` does not call Okala.

The pantry button «به‌روزرسانی قیمت‌ها» is the primary refresh. It posts the pantry and shopping names to `POST /api/prices/refresh`. The page does not scrape on its own.

With `OKALA_LIVE=0` (or when the live catalog fails and the price book is empty) the api stores the bundled fixture. A live failure that already has rows keeps those rows and says the last stored price remains. A quote that is missing or older than the cache TTL falls back to the scaled GapGPT `cost_toman` and the card says «قیمت اُکالا کهنه است».

- After refresh, a matched staple such as برنج shows an اُکالا badge on the recipe card, the week budget, and the shopping row. A recipe that mixes matched and unmatched lines says «بخشی از اُکالا». A line with no Okala price still says «حدود».
- Unmatched names appear under the button in Persian («در اُکالا پیدا نشد»).
- «تعداد نفرات» scales the quantity once. Okala unit price times that quantity is the line cost. Doubling headcount doubles that line; it is not scaled again.
- On «مواد خرید», each matched row shows the Okala line total. A stale row keeps the last unit price and says «کهنه».
- «سبد اُکالا» copies up to ten names for Okala’s list search, and can open the store homepage or a product page. The basket is not prefilled here. Payment is not completed here. The status line stays Persian.

Shell, no live network when `OKALA_LIVE=0`:

```bash
curl -sS -X POST http://localhost:8000/prices/refresh \
  -H 'Content-Type: application/json' \
  -d '{"force":true,"names":["برنج"]}'
curl -sS -X POST http://localhost:8000/prices/quote \
  -H 'Content-Type: application/json' \
  -d '{"ingredients":["۲۰۰ گرم برنج"],"household":8,"servings":4,"estimate_toman":10000}'
curl -sS -X POST http://localhost:8000/prices/cart \
  -H 'Content-Type: application/json' \
  -d '{"items":[{"name":"برنج","quantity_label":"۴۰۰ گرم"}]}'
```

The quote for ۲۰۰ گرم برنج at ۸ نفر is `165000` toman from the fixture. The cart body has `"prefill": false` and `"checkout": false`, and `open_url` is the Okala homepage.

Automated checks, no key and no live Okala:

```bash
node --test web/prices.test.js
cd api && python3 -m unittest tests.test_okala tests.test_okala_endpoint -v
```

### 8. Break the key — Persian error and retry — restore

Unset the key, or set it to a non-empty placeholder such as `invalid`. Do not use a real secret as the placeholder. Recreate api:

```bash
docker compose up -d --force-recreate api
```

- «پیشنهاد دستور» shows «در حال پختن ایده‌ها…», then a short Persian error and «تلاش دوباره». The hint may name `GAP_CODE_API_KEY` and docker compose logs. It must not show the key value, a stack trace, or the raw server body. The pantry chips stay.
- «عکس یخچال» with one or two JPEGs, then «تشخیص مواد», does the same for vision: Persian error, «تلاش دوباره», preview only while the request was running, pantry unchanged.
- «تلاش دوباره» sends the request again and shows the same friendly error while the key is still bad. The page does not crash.
- Repeat the nutrition curl in step 4c. It stays HTTP 200 with `"available": false`. It does not use the recipe error.
- Put the real key back in `.env` only, recreate api, and repeat steps 4 and 3. Generate returns at least three cards. A fridge photo can be confirmed into the pantry again. Step 4c can show a calorie line again.

Shell spot-check while the key is missing or invalid (the body must not contain the key or a traceback):

```bash
curl -sS -X POST http://localhost:8000/recipes/generate \
  -H 'Content-Type: application/json' \
  -d '{"ingredients":["برنج","عدس","پیاز"],"budget":1500000}'
```

Missing key: HTTP 503, `"error": "not_configured"`. Invalid key: HTTP 502, `"error": "unauthorized"`.

### 9. Install to the home screen

No API key. The footer install note on http://localhost:8080 is: برای نصب برنامه، در منوی مرورگر «افزودن به صفحهٔ اصلی» را بزنید.

Manifest and service worker (the worker body must not contain `GAP_CODE_API_KEY`):

```bash
curl -sSI http://localhost:8080/manifest.webmanifest
curl -fsS http://localhost:8080/manifest.webmanifest
curl -sSI http://localhost:8080/sw.js
curl -fsS http://localhost:8080/sw.js
```

- The manifest is `Content-Type: application/manifest+json; charset=utf-8` and `Cache-Control: no-cache`. `name` and `short_name` are آشپزخونه, `lang` is `fa`, `dir` is `rtl`, `start_url` and `scope` are `/`, `display` is `standalone`. Icons include 192 and 512, both `any` and `maskable`. The file has no API key.
- `/sw.js` is `Content-Type: application/javascript; charset=utf-8` and `Cache-Control: no-cache`. It is the worker, not the pantry HTML. It caches the page shell (`/`, CSS, scripts, fonts, manifest, icons) and does not intercept `/api/` or `/health`.
- Chrome can install from http://localhost:8080. Any other host needs HTTPS. After install, the app opens standalone on `/`.
- With the worker active, recipe generation, fridge photos, and the key still go to the api. The worker does not call GapGPT. Stopping the network still serves the cached shell; `/api/` does not come from that cache.

`node --test web/pwa.test.js` covers the same manifest, icon, worker, and install-note checks without a browser.

### 10. Tag is SE, after this gate

When every step above is green, stop. Do not create tag `v0.2.0` and do not publish a GitHub Release. SE tags `v0.2.0` after this checklist is green. The release notes for that tag are [RELEASE.md](RELEASE.md).

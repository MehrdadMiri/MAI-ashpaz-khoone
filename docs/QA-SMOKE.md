# QA smoke — آشپزخونه

Release check for the Persian RTL meal demo after empty, loading, and error states are in place (US-08, Designs §4). This is the path to run before anyone tags `v0.1.0`.

Do **not** create the `v0.1.0` tag from this checklist. Tagging is ticket #8, and only after this path is green.

The key never goes in git, the shell history, a screenshot, or a log paste. Put `GAP_CODE_API_KEY` only in the gitignored `.env` or the environment. Confirm it without printing it:

```bash
test -n "$GAP_CODE_API_KEY" && echo "GAP_CODE_API_KEY is set (value hidden)"
```

Automated checks (no key, no network):

```bash
node --test web/pantry.test.js web/recipes.test.js web/fridge.test.js web/plan.test.js
cd api && python3 -m unittest discover -s tests -v
```

`LiveSmokeTest` stays skipped unless `GAPGPT_LIVE_SMOKE=1`.

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
- `curl -fsS http://localhost:8000/health` is JSON with `"status": "ok"` and `"gapgpt": {"configured": true, ...}`. The body must not contain the key.

### 2. Seed — at least eight chips

On a fresh browser profile (or after «پاک کردن»):

- The empty kitchen shows an illustration, «هنوز چیزی در آشپزخانه نیست», and the actions «بارگذاری نمونه», «افزودن ماده», and «عکس یخچال».
- «افزودن ماده» focuses the name field. «عکس یخچال» opens the sheet and does not add a chip by itself.
- «بارگذاری نمونه» loads برنج، پیاز، عدس، لوبیا، سیب‌زمینی، گوجه‌فرنگی، ماست، روغن. The count is at least 8. Running it again does not duplicate them.

### 3. Fridge photo — confirm — pantry

- «عکس یخچال» → «انتخاب عکس» (or the camera) and pick a JPEG of food.
- While the request runs, the sheet shows that photo and «در حال تشخیص مواد…». «پیشنهاد دستور» is unrelated; this sheet’s own controls stay single-submit.
- «انصراف» during that wait closes the sheet, adds nothing, and does not show an error. The pantry is unchanged. Try the photo again.
- On the confirm sheet, uncheck or edit a name if you want. «تأیید و افزودن به انبار» adds only the checked names, without duplicates. «انصراف» on the confirm sheet adds nothing.

### 4. Budget — generate at least three

- Set «بودجه هفته» to a number such as `1500000`.
- Before the first success, the recipe panel asks you to set the budget and press «پیشنهاد دستور».
- Press «پیشنهاد دستور» once. The status is «در حال پختن ایده‌ها…», skeleton cards show, and the button does not send a second request while the first is in flight.
- At least three Persian cards appear. Each has a title, ingredient tags, and steps. Spot-check them against the pantry names. A تومان badge appears when the model returned a cost.

### 5. Seven-day plan

- The week is شنبه through جمعه. A day with no شام says «خالی» and offers «انتخاب».
- «برنامه ۷ روزه» fills every empty day from the cards (repeating recipes when there are fewer than seven). Days you already filled stay as they are.
- «افزودن به برنامه» on a card assigns that recipe to one day. «جایگزین» swaps a filled day. «خالی» on that sheet clears the day.

### 6. Edit the pantry — generate again

- Remove one chip and add a different ingredient.
- Press «پیشنهاد دستور» again. A new set of at least three cards replaces the previous set. The pantry chips you just edited are still there. The week keeps the dinners already assigned unless you change them.

### 7. Export and print

- «چاپ / خروجی» → «چاپ». The preview is white, Persian, and shows the seven days (title or «خالی»). Pantry, recipe controls, and sheets are not in the preview.
- «چاپ / خروجی» → «دانلود مارک‌داون» saves `برنامه-۷-روزه.md` with one line per day.
- If the summed شام costs are over «بودجه هفته», the plan line says «بیشتر از بودجه هفته» and that چاپ و خروجی are still allowed. Print and download still work. The warning does not block them.

### 8. Break the key — Persian error and retry — restore

Unset the key, or set it to a non-empty placeholder such as `invalid`. Do not use a real secret as the placeholder. Recreate api:

```bash
docker compose up -d --force-recreate api
```

- «پیشنهاد دستور» shows «در حال پختن ایده‌ها…», then a short Persian error and «تلاش دوباره». The hint may name `GAP_CODE_API_KEY` and docker compose logs. It must not show the key value, a stack trace, or the raw server body. The pantry chips stay.
- «عکس یخچال» with a JPEG does the same for vision: Persian error, «تلاش دوباره», preview only while the request was running, pantry unchanged.
- «تلاش دوباره» sends the request again and shows the same friendly error while the key is still bad. The page does not crash.
- Put the real key back in `.env` only, recreate api, and repeat steps 4 and 3. Generate returns at least three cards. A fridge photo can be confirmed into the pantry again.

Shell spot-check while the key is missing or invalid (the body must not contain the key or a traceback):

```bash
curl -sS -X POST http://localhost:8000/recipes/generate \
  -H 'Content-Type: application/json' \
  -d '{"ingredients":["برنج","عدس","پیاز"],"budget":1500000}'
```

Missing key: HTTP 503, `"error": "not_configured"`. Invalid key: HTTP 502, `"error": "unauthorized"`.

### 9. Tag is the next ticket

When steps 1–8 pass, stop. `v0.1.0` is ticket #8. This checklist does not create that tag.

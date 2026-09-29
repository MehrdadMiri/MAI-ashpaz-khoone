# v0.3.0

Follows the tagged release `v0.2.0` (shopping, leftover regenerate, fridge v2, Postgres persist, nutrition, share/print, diet filters, and a home-screen install).

`v0.3.0` adds, on top of `v0.2.0`:

- Breakfast, lunch, and dinner on the week plan (صبحانه، ناهار، شام — ۲۱ slots)
- تعداد نفرات scales displayed amounts and cost
- Okala prices from «به‌روزرسانی قیمت‌ها» (or the bundled fixture) and an assisted cart: «سبد اُکالا» copies names and opens the store; it does not check out
- Manual مواد خرید rows, with a price when a catalog match exists
- Multi-user isolation: «کاربر جدید» keeps pantry, plan, and shopping separate per browser session
- The first «پیشنهاد دستور» returns three cards; «پیشنهاد دستورهای بیشتر» appends another batch. A richer pantry asks for five or seven
- Assigning a recipe fills one slot. «برنامه ۷ روزه» is the explicit full-week fill

GapGPT stays `gpt-5.6-luna`. The repository is public. `.env` is gitignored. `.env.example` has placeholders only, and `GAP_CODE_API_KEY` there is empty.

Do not create tag `v0.3.0` or a GitHub Release from the docs change that added this file. SE tags after [QA-SMOKE.md](QA-SMOKE.md) is green.

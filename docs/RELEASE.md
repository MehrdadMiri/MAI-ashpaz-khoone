# v0.2.0

Follows the tagged MVP `v0.1.0` (pantry chips, one fridge photo, recipe cards, the 7-day plan, and empty, loading, and error polish).

`v0.2.0` adds:

- Shopping list (مواد خرید) from the week plan and the pantry
- Leftover-aware regenerate (remaining chips, skip eaten dinners, «بازتولید کامل»)
- Fridge vision v2: up to six photos, confidence, and merged names
- Postgres persist for the pantry and the week plan, with a localStorage fallback
- Rough nutrition on the recipe cards; a failed estimate leaves the cards up
- Share and print the week: a `#p=` link and an A4 poster
- Diet filters: گیاهی، بدون پیاز، مناسب دیابت
- Home-screen install: web app manifest, a service worker that caches the page shell only, and the install note

GapGPT stays `gpt-5.6-luna`. The repository is public. `.env` is gitignored. `.env.example` has placeholders only, and `GAP_CODE_API_KEY` there is empty.

Do not create tag `v0.2.0` or a GitHub Release from the docs change that added this file. SE tags after [QA-SMOKE.md](QA-SMOKE.md) is green.

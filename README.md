# MAI-ashpaz-khoone

Persian RTL AI meal and recipe demo (آشپزخونه).

This ticket is the foundation: `docker compose up --build` starts three services.

| Service | Image | URL |
| --- | --- | --- |
| web | nginx, static landing page | http://localhost:8080 |
| api | Python (Flask + Gunicorn) | http://localhost:8000 |
| db | Postgres 16 | localhost:5432 |

Later tickets add the GapGPT client, pantry, recipes, fridge vision, and meal plan. Product UI will be Persian RTL. This scaffold’s docs and code comments are English. The landing page title is آشپزخونه.

## Run

```bash
docker compose up --build
```

The stack starts with no API key. `/health` on the API stays OK when `GAP_CODE_API_KEY` is unset. Model calls are not part of this ticket.

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

`.env.example` has placeholders only. `.gitignore` excludes `.env`. Do not commit `GAP_CODE_API_KEY` or any real key.

### GapGPT

- Base URL: `https://api.gapgpt.app/v1`
- Model: `gpt-5.6-luna`
- API key variable: `GAP_CODE_API_KEY`

## Demo path (QA)

1. From a clean shell (no `GAP_CODE_API_KEY`), run `docker compose up --build`.
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

6. Optional: put a placeholder or real key in `.env` as `GAP_CODE_API_KEY` and recreate the api service. `/health` stays OK. `gapgpt.configured` becomes `true` when the variable is non-empty. The key is not returned by the API.

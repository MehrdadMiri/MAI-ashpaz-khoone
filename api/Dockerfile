FROM python:3.12-slim

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py gapgpt.py recipes.py ./

RUN useradd --create-home --uid 10001 appuser \
    && chown appuser:appuser /app
USER appuser

EXPOSE 8000

# gthread keeps /health responsive while a recipe call waits on GapGPT.
# --timeout stays above RECIPE_CLIENT_TIMEOUT (90s) in recipes.py.
CMD ["gunicorn", "--bind", "0.0.0.0:8000", "--worker-class", "gthread", "--workers", "1", "--threads", "4", "--timeout", "120", "--access-logfile", "-", "app:app"]

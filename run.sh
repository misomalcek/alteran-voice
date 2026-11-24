#!/usr/bin/env bash
# Alteran Voice — local run. Needs uv (https://docs.astral.sh/uv/).
cd "$(dirname "$0")"
[ -f .env ] || { echo "missing voice/.env (GROQ_API_KEY, OPENROUTER_API_KEY)"; exit 1; }
uv sync
exec uv run uvicorn server:app --host 127.0.0.1 --port "${PORT:-8787}"
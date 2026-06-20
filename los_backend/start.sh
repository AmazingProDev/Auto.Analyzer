#!/usr/bin/env bash
# Start the LOS FastAPI backend on port 8001.
# Run from the los_backend/ directory.
set -euo pipefail

cd "$(dirname "$0")"

if [ -x ".venv/bin/python" ]; then
  PYTHON_BIN=".venv/bin/python"
elif [ -x "/opt/homebrew/bin/python3.12" ]; then
  PYTHON_BIN="/opt/homebrew/bin/python3.12"
else
  PYTHON_BIN="python3"
fi

exec "$PYTHON_BIN" -m uvicorn app.main:app --host 0.0.0.0 --port 8001 --reload

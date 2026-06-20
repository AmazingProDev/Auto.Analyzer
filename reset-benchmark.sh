#!/usr/bin/env bash
# Reset the Nemo benchmark caches and reload from scratch.
# Use after bumping a benchmark version constant in server.py, or whenever the
# benchmark results look stale. Collapses the manual cache dance into one command.
#
# Steps: clear the SQLite library cache -> (re)start server.py on :8000 -> POST /load.
# The in-memory + (path,mtime) parse caches are cleared by the restart.
#
# Usage:
#   ./reset-benchmark.sh           # clear cache, ensure server up, reload
#   ./reset-benchmark.sh --touch   # also `touch` the configured time-series files
#                                  # (busts the (path,mtime) parse cache when siblings
#                                  #  were added without changing the time-series)
set -euo pipefail

PORT="${OPTIM_PORT:-8000}"
SQLITE="$HOME/.optim_analyzer/benchmark_nemo_library.sqlite3"
NEMO_DIR="${OPTIM_UPLOAD_DIR:-/tmp/optim_uploads}/benchmark_nemo"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "==> Clearing SQLite library cache: $SQLITE"
rm -f "$SQLITE" && echo "    cleared" || echo "    (none)"

if [[ "${1:-}" == "--touch" ]]; then
  echo "==> Touching time-series files in $NEMO_DIR"
  shopt -s nullglob
  for f in "$NEMO_DIR"/*.txt; do
    case "$(basename "$f")" in
      *[Ss]ession*[Ss]tatistic*) ;;            # skip session-stats siblings
      *) touch "$f" && echo "    touched $(basename "$f")" ;;
    esac
  done
fi

# (Re)start the server on $PORT.
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "==> Restarting server on :$PORT"
  PID="$(lsof -nP -tiTCP:"$PORT" -sTCP:LISTEN | head -1)"
  kill "$PID" 2>/dev/null || true
  sleep 1
else
  echo "==> Starting server on :$PORT"
fi
( cd "$SCRIPT_DIR" && nohup python3 server.py > /tmp/optim_server.log 2>&1 & )

echo "==> Waiting for :$PORT ..."
for _ in $(seq 1 30); do
  if curl -s -o /dev/null "http://localhost:$PORT/" 2>/dev/null; then break; fi
  sleep 0.5
done

echo "==> Reloading benchmark dataset (POST /api/benchmark-nemo/load)"
curl -s -X POST "http://localhost:$PORT/api/benchmark-nemo/load" \
  -H 'Content-Type: application/json' -d '{}' \
  -o /tmp/optim_benchmark_load.json -w "    HTTP %{http_code}\n" || true

python3 - <<'PY' || true
import json
try:
    d = json.load(open("/tmp/optim_benchmark_load.json"))
except Exception as e:
    print("    (could not parse load response:", e, ")"); raise SystemExit
ds = d.get("dataset", {}) or {}
tl = (ds.get("charts", {}) or {}).get("dlTimelineByMetric", {}) or {}
print(f"    cached={d.get('cached')} parserVersion={ds.get('parserVersion')} analysisVersion={ds.get('analysisVersion')} operators={list(tl.keys())}")
for op in ("IAM", "Orange", "INWI"):
    kp = (tl.get(op, {}) or {}).get("downloadEventKpis", {}) or {}
    if kp:
        print(f"      {op}: DLtime={kp.get('downloadDurationAvgS')}s byteRate={kp.get('dlAppRateMbps')}Mbps status={kp.get('dlStatus')}")
PY

echo "==> Done. Server log: /tmp/optim_server.log"

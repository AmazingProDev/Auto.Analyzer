# Setup & run — Optim Analyzer (EMA Solution)

How to get a fresh clone running. Two backends: the **main app** (`server.py`, port 8000) and
the optional **LOS backend** (`los_backend/`, FastAPI, port 8001). The frontend is static
(`index.html` + `app.js`) served by the main app — no build step.

> Some runtime files are intentionally **not** in git (see `.gitignore`): virtualenvs,
> `outputs/`, `tmp/`, runtime DBs, and the large `bdd_sectors.json` data blob. They are either
> regenerable (below) or recreated by the app at runtime.

## Prerequisites
- **Python 3.11+** (developed on 3.13).
- **Node.js 18+** (only needed to run the JS tests).
- macOS/Linux. (Windows: use WSL or adapt the shell scripts.)

## 1. Main app (required)

```bash
# from the repo root
python3 -m venv .venv && source .venv/bin/activate     # optional but recommended
pip install -r requirements.txt                         # libsql, asn1tools, pycrate
python3 server.py                                        # serves http://localhost:8000
```

Open <http://localhost:8000> in a browser.

- `requirements.txt` = main server deps. `requirements.backend.txt` = decoder-only subset
  (asn1tools, pycrate) if you only need TRP/NAS/RRC decoding.
- The server is the Python stdlib HTTP server (no framework); most of its logic is stdlib +
  the local modules (`local_ai/`, `trp_importer.py`, `nemo_lte_importer.py`, `bdd_matcher.py`, …).

### BDD sectors data (`bdd_sectors.json`)
Not stored in git (78 MB). You do **not** need to copy it manually — recreate it from the UI:
upload your multi-RAT BDD `.xlsx` via the app (**Update BDD** / `POST /api/bdd/upload`), which
parses it and writes `bdd_sectors.json` (+ `.gz`) to the repo root automatically. Until then the
BDD sector layers are simply empty; everything else works.

## 2. LOS backend (optional — only for the Line-of-Sight simulator)

Heavier geospatial stack (rasterio, geopandas, GDAL). Its own venv.

```bash
cd los_backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
bash start.sh                                            # uvicorn app.main:app on :8001
```

The main app talks to it at `http://localhost:8001`. ATOLL rasters/vectors are preprocessed via
`los_backend/scripts/` (see `convert_atoll_rasters.py`, `preprocess_vectors.sh`) — processed
geodata is referenced by `los_backend/active_geodata.json` and is not committed.

## 3. Tests

```bash
# Python
python3 -m pytest tests/ -q

# JavaScript (needs node deps)
npm install            # xlsx, jsdom, @libsql/client
node tests/<file>.test.js      # e.g. tests/benchmark-nemo-scorecard-state.test.js
```

## 4. Benchmark cache reset (dev convenience)
After changing benchmark version constants in `server.py`, or if benchmark results look stale:

```bash
./reset-benchmark.sh           # clear SQLite cache, restart server, reload + print KPIs
./reset-benchmark.sh --touch   # also re-touch the time-series files
```

See `CLAUDE.md` for the full file map, benchmark pipeline, and version/cache gotchas.

## Ports
| Service | Port | Start |
|---|---|---|
| Main app + frontend | 8000 | `python3 server.py` |
| LOS backend (optional) | 8001 | `bash los_backend/start.sh` |

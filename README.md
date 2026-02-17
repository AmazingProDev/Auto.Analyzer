# Optim Analyzer

## Importing TRP

The app now supports server-side `.trp` import with persisted run history.

### Run locally

1. Start the server:

```bash
python3 server.py
```

2. Open the app in your browser (served by `server.py` on port `8000`).
3. Click **Import TRP** in the header and select a `.trp` file.

### What happens

- Upload endpoint: `POST /api/trp/import`
- Safe ZIP extraction (zip-slip protected)
- CDF decode from:
  - `trp/providers/sp*/cdf/declarations.cdf`
  - `trp/providers/sp*/cdf/lookuptables.cdf`
  - `trp/providers/sp*/cdf/data.cdf`
- GPS track parse from: `trp/positions/wptrack.xml`
- Data persisted into SQLite DB.

### Storage locations

- Uploaded TRP files: `data/uploads/`
- SQLite database: `data/trp_runs.db`

### APIs used by run detail UI

- `GET /api/runs?limit=300` (runs list for `/runs` page)
- `GET /api/runs/{runId}`
- `GET /api/runs/{runId}/catalog` (sidebar KPI tree + events catalog)
- `GET /api/runs/{runId}/kpi?name=<kpi_name>`
- `GET /api/runs/{runId}/events?name=<event_name>&limit=<n>`

### Runs list page

- Open `/runs` to browse previously imported TRP runs without re-uploading.
- Use the **Runs** header button to open the same list.

### Notes

- If no track exists, UI shows **No track found**.
- If MOS/any KPI is missing, UI still works with available KPI names.

## Turso + Vercel backend config

The backend now supports Turso automatically when environment variables are set.

### Required env vars

- `TURSO_DATABASE_URL` (example: `libsql://<db-name>-<org>.turso.io`)
- `TURSO_AUTH_TOKEN`

### Optional env vars

- `TURSO_LOCAL_REPLICA_PATH` (default follows `TRP_DB_PATH`, useful on Vercel: `/tmp/trp_runs.db`)
- `TRP_DB_PATH` (local fallback sqlite path)
- `OPTIM_DATA_DIR` (where uploads/temp DB live; default is `/tmp/optim_analyzer_data` on Vercel)

### Vercel steps

1. In Turso:
   - create DB and token
2. In Vercel project settings -> Environment Variables, add:
   - `TURSO_DATABASE_URL`
   - `TURSO_AUTH_TOKEN`
   - `TRP_DB_PATH=/tmp/trp_runs.db`
   - `OPTIM_DATA_DIR=/tmp/optim_analyzer_data`
3. Deploy backend.
4. In the frontend header `API` setting, set your backend base URL.

When Turso env vars are present, writes are committed locally then synced to Turso.

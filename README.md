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

## NMFS external converter bridge

Secure `.nmfs` files usually contain encrypted payload. The app now does:
1. local NMFS metadata decode in browser
2. automatic fallback to backend converter (`POST /api/nmfs/decode`)

### Configure converter command

Set environment variable on the backend host:

```bash
export OPTIM_NMFS_CONVERTER_CMD='python "C:\\path\\to\\Optim_Analyzer\\tools\\nmfs_com_extract.py" --input "{input}" --output "{output}"'
```

Placeholders:
- `{input}`: uploaded `.nmfs` absolute path
- `{output}`: suggested decoded text output path (expected `.nmf` text)

Optional:

```bash
export OPTIM_NMFS_TIMEOUT_SEC=180
export OPTIM_NMFS_KEEP_TEMP=0
```

If converter is not configured or fails, import still keeps NMFS metadata but no secure payload measurements are decoded.

### Recommended decode path (from binary analysis)

Based on parser binary inspection:
- `CParserFactory::CreateParser(...)` dispatches `.nmf` vs `.nmfs`
- secure NMFS container magic is `NMFS` (`4E 4D 46 53`)
- secure reading/decrypt/decompress path is in `Parser.dll` / `Parser64.dll` / `ParserStorage.dll`

Use COM automation route implemented by:
- `tools/nmfs_com_extract.py`

This script uses:
- `AnalyzeParser.ParserEngine` + `CreateParser()` (preferred)
- fallback `AnalyzeParser.FileParser`
- `FileName`, `Parse()`, `GetMeasurement(index)` loop

### UI settings panel

You can configure/test converter from the app header:
- `🧩 NMFS` button
- saves settings via:
  - `GET /api/nmfs/config`
  - `POST /api/nmfs/config`
  - `POST /api/nmfs/config/test`

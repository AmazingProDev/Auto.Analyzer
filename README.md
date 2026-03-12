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

## LTE IntraFreq HO analysis

The app now includes a dedicated **LTE IntraFreq HO Analysis** workflow.

### Entry points

- Header button: `🔁 LTE HO`
- Backend run endpoint: `POST /api/ho-analysis/run`
- Result endpoints:
  - `GET /api/ho-analysis/{id}`
  - `GET /api/ho-analysis/{id}/events?page=1&pageSize=100`
  - `GET /api/ho-analysis/{id}/events/{eventId}`
  - `GET /api/ho-analysis/{id}/kpis`
  - `GET /api/ho-analysis/{id}/export`

### Implementation structure

- Shared telecom logic: [lte_ho_analysis.js](/Users/abdelilah/Documents/Codex%20project/Optim_Analyzer/lte_ho_analysis.js)
- Backend CLI bridge: [ho_analysis_cli.js](/Users/abdelilah/Documents/Codex%20project/Optim_Analyzer/ho_analysis_cli.js)
- Backend HTTP integration: [server.py](/Users/abdelilah/Documents/Codex%20project/Optim_Analyzer/server.py)
- Frontend modal/page logic: [app.js](/Users/abdelilah/Documents/Codex%20project/Optim_Analyzer/app.js)

### Detection logic

The analyzer uses two layers:

1. Signaling-driven correlation
- measurement report
- HO command / HOA / RRC reconfiguration
- HO complete
- fail / RLF / re-establishment / drop

2. State-driven fallback
- serving PCI / EARFCN transition when signaling is incomplete

A handover is marked **intra-frequency** only when:

```text
source EARFCN == target EARFCN
```

If EARFCN cannot be reconstructed, the event is kept for debug but excluded from strict intrafreq confidence.

### Radio reconstruction

For each HO, the module reconstructs a configurable window around the event and derives:

- serving RSRP / RSRQ trend
- chosen target trend
- best same-frequency neighbor trend
- effective delta trend
- `T_better`
- `T_a3_like`
- `T_report`
- `T_command`
- `T_access`
- `T_complete`
- `T_fail`

### Effective delta

Primary dominance metric:

```text
effective_delta =
  (target_rsrp + target_cio_or_0)
  - (serving_rsrp + serving_cio_or_0)
```

If CIO is missing, the analyzer uses `0` and records the assumption.

### Classification rules

Current rule engine returns one of:

- `successful`
- `too-late`
- `too-early`
- `ping-pong`
- `wrong-target`
- `execution-failure`
- `missing-report/config-issue`

Every event also carries:

- `reasons[]`
- `recommendedActions[]`
- `assumptions[]`
- `thresholdsUsed`
- `confidence`
- `debug`

### Threshold tuning

Defaults are centralized in `DEFAULT_CONFIG` inside [lte_ho_analysis.js](/Users/abdelilah/Documents/Codex%20project/Optim_Analyzer/lte_ho_analysis.js).

Current defaults:

- `SIGNIFICANT_DELTA_DB = 4`
- `MARGINAL_DELTA_DB = 1.5`
- `SERVING_WEAK_RSRP_DBM = -102`
- `SERVING_VERY_WEAK_RSRP_DBM = -108`
- `POOR_RSRQ_DB = -12`
- `CRITICAL_RSRQ_DB = -15`
- `PING_PONG_TIME_MS = 30000`
- `PING_PONG_DISTANCE_M = 500`
- `REPORT_TO_COMMAND_WARN_MS = 1000`
- `COMMAND_TO_COMPLETE_WARN_MS = 1500`
- `SUSTAINED_STRONGER_MS = 1000`

Tune these before changing classifier code.

### Notes

- The current implementation is production-oriented but still heuristic when logs lack explicit LTE signaling.
- `A3/A5` decoding, CIO, and target selection quality improve when the raw log exposes those fields explicitly.
- The current UI is a dedicated modal rather than a separate route; it is still backed by a standalone analysis module and API surface.

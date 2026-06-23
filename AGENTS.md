# Agent Notes

See **`CLAUDE.md`** for the full file map, benchmark pipeline, and run/verify steps. Key conventions
are mirrored below so any agent (Codex included) has them without opening CLAUDE.md.

- When reading PDF files for this project, use `notebooklm-mcp` first.

## Project
Radio drive-test analysis webapp. Backend `server.py` (~18k lines, Python stdlib HTTP, port 8000).
Frontend `app.js` (~74k lines, vanilla JS, no build) + `index.html`. Run: `python3 server.py`.

## Must-do rules
- **Bump `app.js?v=vNNN`** in `index.html` on every `app.js` edit (else the browser serves stale JS).
- **Benchmark version constants** in `server.py`: bump `_BENCHMARK_NEMO_PARSER_VERSION` (~line 116) on
  row-parsing changes; bump `_BENCHMARK_NEMO_ANALYSIS_VERSION` (~line 14559) on analysis/KPI changes.
- After backend changes: **restart the server**; if results look stale,
  `rm -f ~/.optim_analyzer/benchmark_nemo_library.sqlite3` and restart (SQLite + in-memory caches persist).
- **Operator order is fixed IAM → Orange → INWI**; use `benchmarkNemoOperatorOrder()` (app.js).
  Colors: IAM `#2563eb`, Orange `#f97316`, INWI `#7c3aed`.
- **Files are huge** — make targeted edits, `grep` for anchors, never rewrite whole files; line numbers drift.
- **Syntax-check before restart:** `python3 -c "import ast; ast.parse(open('server.py').read())"` and
  `node -e "new Function(require('fs').readFileSync('app.js','utf8'))"`.
- Verify behavior with text/DOM first (`preview_eval`, console logs); screenshot only at the end.

## Benchmark essentials
- A Nemo DT = 4 operations (ping, ping-timeout, HTTP upload, HTTP download).
  `_nemo_extract_dl_events(rows)` (server.py ~2305) isolates the **download** session from the time-series
  alone and computes download-only KPIs. The "Data transfer session statistics" file is optional/secondary.
- DL avg (byte-based) = `Bytes DL × 8 / Download time`; avg app DL = per-second curve mean. Both are shown.
- Working data: single DT per operator → keep "directional, n=1" framing in summaries.
- Macro DL diagnosis (IAM-focused root-cause engine, `benchmark_nemo_macro_state.js`): full decision
  tree, context-vs-cause split, LTE-only handling, confidence scoring and KPI table are documented in
  **`MACRO_LOGIC.md`**.
- Active spec for in-progress upgrades: `CODEX_BENCHMARK_PLAN.md`.

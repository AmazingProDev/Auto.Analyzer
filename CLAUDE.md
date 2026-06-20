# CLAUDE.md — Optim Analyzer (EMA Solution)

Radio-network drive-test analysis webapp: Nemo/TRP log parsing, multi-operator 5G/LTE
benchmarking (IAM vs Orange vs INWI), serving/neighbor analysis, LOS simulation, and a map UI.
Single-user desktop-style tool; Python stdlib HTTP backend + a large vanilla-JS frontend.

> Line numbers below are approximate — files change often. **Always `grep` for the anchor
> (function/const name) rather than trusting a line number.**

## Run & verify

> Fresh-clone setup (deps, LOS backend, BDD data, tests): see **`SETUP.md`**.

- **Dev server:** `python3 server.py` on port **8000** (see `.claude/launch.json`, name `optim-analyzer`).
  Prefer the preview tooling / `preview_start` over raw Bash for the server.
- **Frontend:** static `index.html` + `app.js` served by the same server. `app.js` is **cache-busted**
  by `<script src="app.js?v=vNNN">` in `index.html` (currently `v629`).
  **You MUST bump that token on every `app.js` change** or the browser serves stale JS.
- **Syntax checks (cheap, do before restart):**
  - `python3 -c "import ast; ast.parse(open('server.py').read())"`
  - `node -e "new Function(require('fs').readFileSync('app.js','utf8'))"`
- **Verify behavior with TEXT first, screenshot last.** Use `preview_eval` / `preview_snapshot` /
  console logs to assert DOM state; take one screenshot only for final visual confirmation
  (screenshots are image-token heavy).
- **Benchmark API smoke test:**
  `curl -s -X POST http://localhost:8000/api/benchmark-nemo/load -H 'Content-Type: application/json' -d '{}'`
  then inspect `dataset.charts.dlTimelineByMetric[op]`.

## File map

- **`server.py`** (~18k lines) — entire backend: tabular parsing, benchmark pipeline, deep analysis,
  serving-cell resolution, NAS/RRC decoders, HTTP routes (`do_POST`/`do_GET`, search `path == "/api/..."`).
- **`app.js`** (~74k lines) — entire frontend (no build step). Benchmark UI, map, charts (Chart.js),
  window manager hooks. Cache-busted via the `?v=` token.
- **`index.html`** — markup. Benchmark panel = `<section id="benchmarkNemoSection">` (~line 516);
  benchmark cards ~lines 540–620.
- **`style.css`** (~5.6k lines) — styles. Benchmark uses `.benchmark-nemo-card`; windows use
  `.floating-window` / `.window-*`.
- **`window_manager.js`** — `window.WM.makeFloating(...)`; the benchmark window is created ~line 415.
- **`metric_registry.js`, `map_renderer.js`, `theme_*.js`, `los_*.js`, `trp_*.{js,py}`** — feature modules.
- **Python decoders:** `nas_decoder.py`, `*_rrc_*.py`, `trp_*.py`, `nemo_lte_importer.py`.
- **`tests/`** — Python (`test_*.py`) and JS (`*.test.js`) tests.
- **`CODEX_BENCHMARK_PLAN.md`** — spec for the analysis-quality / presentation upgrades (Codex executes).
- **`reset-benchmark.sh`** — one-command cache reset + server restart + benchmark reload (see gotcha #2).

## Benchmark pipeline (Nemo TXT) — data flow

Input: per-operator **time-series** TXT (277-col Nemo export), e.g.
`/tmp/optim_uploads/benchmark_nemo/Mohammedia-{IAM,Orange,INWI}.txt` (configured paths).
Source originals live in `/Users/abdelilah/Desktop/EMA Solution/`.

1. **Parse** — `_nemo_parse_operator_file(_uncached)` (~line 3566) →
   `{operator, rows:[...], rowsByMeasurementTitle, technologyStatus, sessionStats, ...}`.
   Each `row` carries normalized fields (see glossary). Cached by `(path, mtime)` in `_NEMO_PARSE_CACHE`.
2. **Download/upload/ping reconstruction** — `_nemo_extract_dl_events(rows)` (~line 2305).
   A DT runs 4 operations (ping, ping-timeout, HTTP upload, HTTP download). This fn reads the Event IDs
   (DAA/DAC/DREQ/DCOMP/DAD) **and** per-row transfer KPIs to classify each session and **isolate the
   single real HTTP download**, then computes download-only KPIs (no averaging across operations).
   Returns `{sessions, markers, downloadWindow, download, upload, pings, kpis, ...}`.
   **This is derived from the time-series alone — the separate "Data transfer session statistics" file
   (`_nemo_parse_session_stats`, ~line 3398) is an OPTIONAL/secondary path, not required.**
3. **Dataset build** — `_benchmark_nemo_build_dataset(...)` (~line 14587) →
   timeline builder loop produces `dl_timeline_by_metric[op]` with per-metric `points` (scoped to the
   download window via `_tl_build_series`), `downloadEventMarkers`, `downloadEventKpis`, and
   `sessionStats = {kpis, download, upload, pings}` (all from `dl_events`). Also deep analysis:
   `_benchmark_deep_findings` (~11702), `_deep_causal_chain` (~12408), layer/gap analysis.
4. **Serve** — `/api/benchmark-nemo/load` (~17805) and `/upload` (~18013). Result cached in SQLite
   (see gotchas) keyed by parser+analysis version + file hashes.
5. **Frontend render** — `app.js`: `tlByMetric = dataset.charts.dlTimelineByMetric` (~3189);
   `buildTlView(cat)` (~3282) builds the timeline; `renderStats` (~3527) the per-operator stat row;
   then the scorecard / startup-latency / upload / reliability / RF cards render in the same block.

### KPI glossary (download session)
- **avg app DL** = per-second mean of `appDlMbps` (the timeline curve average).
- **DL avg (byte-based)** = `Bytes DL × 8 / Download time / 1e6` = `kpis.dlAppRateMbps`.
- **Download time** = DCOMP − DREQ (Nemo "Download time" KPI) = `downloadDurationAvgS`.
- **connect** = DAC − DAA = `timeToConnectAvgMs`. **setup** = DREQ − DAA = `startDelayAvgS`.
- **session time** = DAD − DAA = `dlSessionTimeS`.
- Per-row fields: `appDlMbps, dlPrbPct, prbsAvgDl, schBitratePerPrb, caTotalBwMhz, primaryBwMhz,
  sumSecondaryBwMhz, bandwidthPrbs, pdschDl5gMbps, pdschDlLteMbps, rsrpNr, sinrNr, _dt`.

## Gotchas / conventions (READ BEFORE EDITING)

1. **Version constants gate caching** (`server.py`):
   - `_BENCHMARK_NEMO_PARSER_VERSION` (~line 116, currently **6**) — bump on any change to **row parsing**.
   - `_BENCHMARK_NEMO_ANALYSIS_VERSION` (~line 14559, currently **48**) — bump on any change to **analysis/
     KPI computation from already-parsed rows** (most benchmark logic changes).
2. **Caches that hide your changes:** the dataset is cached in
   `~/.optim_analyzer/benchmark_nemo_library.sqlite3` (`BENCHMARK_NEMO_LIBRARY_DB_PATH`) **and** in an
   in-memory store + `_NEMO_PARSE_CACHE` (keyed by file mtime). After a backend change:
   bump the right version → **restart the server**; if results still look stale,
   `rm -f ~/.optim_analyzer/benchmark_nemo_library.sqlite3` and restart. If you add sibling files without
   changing the time-series, `touch` the time-series file to bust the mtime parse cache.
   **Shortcut: `./reset-benchmark.sh`** does all of this (clear SQLite → restart → reload + print KPIs);
   `./reset-benchmark.sh --touch` also touches the time-series files.
3. **Frontend cache-bust:** bump `app.js?v=vNNN` in `index.html` on every `app.js` edit.
4. **Operator order is fixed: IAM → Orange → INWI** — use `benchmarkNemoOperatorOrder(name)` (app.js ~1165)
   for every per-operator table/chart. Colors: IAM `#2563eb`, Orange `#f97316`, INWI `#7c3aed`.
5. **Files are huge** — never rewrite `server.py`/`app.js` wholesale; make targeted `Edit`s and `grep` for
   anchors. Don't read the whole file; read the region you need.
6. **n=1 caveat:** the working data is a single DT per operator. Keep "directional, not statistically
   significant" framing in any new summary/scorecard.
7. **Don't trust odd values blindly:** the 2nd ICMP ping always times out (test artifact); RF window-
   averages can include ramp-up. Cross-check before drawing conclusions.

## Workflow expectations
- For non-trivial work, **plan first** (plan mode or a written plan); for multi-step work use the task list.
- The user often provides **ground-truth expected values** (timing chains, formulas) — verify against them.
- Multi-agent: Claude Code plans / does hard reasoning; **Codex executes precise specs** (see
  `CODEX_BENCHMARK_PLAN.md`). Keep `AGENTS.md` in sync with the key conventions here.
- Commit/push only when asked; branch off `main` first if needed.

# Codex execution plan — Benchmark analysis quality + presentation

Scope: 5 features for the **Nemo TXT benchmark** (IAM vs Orange vs INWI). Implement in order.
Do **not** touch the LOS, TRP, or map subsystems.

## 0. Context & files

- **Backend:** `server.py` — benchmark pipeline.
  - `_nemo_extract_dl_events(rows)` (~lines 2305–2490): reconstructs the download/upload/ping
    operations from the time-series Event IDs + per-row KPIs. Returns
    `{sessions, markers, downloadIntervals, sessionIntervals, downloadWindow, download, upload, pings, kpis}`.
    It already iterates the rows inside each session window and fills RF buckets
    (`rsrpNr`, `sinrNr`, `dlPrbPct`, `pdschDl5gMbps`, `pdschDlLteMbps`) — **extend that same loop** for Tasks A & B.
  - Timeline builder loop (~lines 14520–14610): builds `dl_timeline_by_metric[op]` →
    `op_entry` with per-metric `points`, `downloadEventMarkers`, `downloadEventKpis`,
    and `sessionStats = {kpis, download, upload, pings}` (all from `dl_events`).
  - Version constants: `_BENCHMARK_NEMO_PARSER_VERSION = 6` (line ~116),
    `_BENCHMARK_NEMO_ANALYSIS_VERSION = 44` (line ~14294).
- **Frontend:** `app.js` (cache-busted by `index.html` `<script src="app.js?v=v626">`, line ~1091).
  - `buildTlView(cat)` (~line 3088) returns the chart view; `renderStats(statsItems)` (~line 3330)
    renders the per-operator stats row; the upload/reliability/RF cards are built in the block
    after the DL timeline card is shown (~lines 3690–3990, inside
    `if (benchmarkNemoDlTimelineCanvas && tlOpNames.length > 0) { ... }`).
  - `tlByMetric` = `dataset.charts.dlTimelineByMetric`; `tlOpNames` = its keys.
  - `benchmarkNemoOperatorOrder(name)` helper → fixed order IAM→Orange→INWI (use it everywhere).
  - No-data path that hides cards: search for the array
    `["benchmarkNemoStartupLatencyCard","benchmarkNemoUploadCard","benchmarkNemoReliabilityCard","benchmarkNemoAuthRfCard"]`
    (~line 2905) — add new card IDs there.
  - Chart cleanup/destroy block (~line 2222) — add any new Chart instance there.
- **Markup:** `index.html` — benchmark cards at lines 555–600, inside
  `<section id="benchmarkNemoSection">` (line 516).
- **Styles:** `style.css` — `.benchmark-nemo-card` and window classes.
- **Window manager:** `window_manager.js:415` creates the benchmark floating window.

## 1. Conventions & gotchas (MUST READ)

1. **Per-row field names** already parsed and available on each `row` dict:
   `appDlMbps`, `dlPrbPct` (PRB utilisation %), `prbsAvgDl`, `schBitratePerPrb`,
   `caTotalBwMhz`, `primaryBwMhz`, `sumSecondaryBwMhz`, `pdschDl5gMbps`, `pdschDlLteMbps`,
   `rsrpNr`, `sinrNr`, `_dt` (datetime). Use `_nemo_pick_float_resolved` patterns already in the file; for
   Tasks A/B you only read existing row fields — **no new parsing**.
2. **Version bumps:** Tasks A & B change only analysis-stage computation (rows are already parsed),
   so bump **`_BENCHMARK_NEMO_ANALYSIS_VERSION` 44 → 45** only. Do **not** bump the parser version.
   Frontend tasks: bump the cache-bust token **`app.js?v=v626` → `app.js?v=v627`** in `index.html`.
3. **After backend change:** restart the server and reload. The dataset is cached in
   `~/.optim_analyzer/benchmark_nemo_library.sqlite3` keyed by the version constants; bumping the
   analysis version forces a rebuild from cached rows. If results look stale, delete that file and restart.
4. **Operator order:** every per-operator table/chart must use `benchmarkNemoOperatorOrder` → IAM, Orange, INWI.
   Operator colors: IAM `#2563eb`, Orange `#f97316`, INWI `#7c3aed`.
5. **Test data:** time-series files in `/tmp/optim_uploads/benchmark_nemo/Mohammedia-{IAM,Orange,INWI}.txt`
   (configured paths). One DT each = ping, ping(timeout), upload, download.
6. **Verify via API:** `curl -s -X POST http://localhost:8000/api/benchmark-nemo/load -H 'Content-Type: application/json' -d '{}'`
   then inspect `dataset.charts.dlTimelineByMetric[op].downloadEventKpis` / `.sessionStats.download`.
7. **Known-good current values** (download session): IAM 4.728 s / 338.4 Mbps byte-based / 345.1 curve /
   peak 482.8 / SINR≈15 / PRB≈5%; Orange 13.094 s / 122.2 / PRB≈58%; INWI 4.263 s / 375.3 / SINR<0 / PRB≈43%.

---

## TASK A — Slow-start vs steady-state throughput (analysis #3)

**Goal:** the file-average (Bytes DL × 8 / Download time) understates capacity on short transfers because
TCP slow-start dominates. Add a steady-state metric + a slow-start interpretation, especially for IAM
(4.7 s transfer, file-avg 338 vs peak 482).

**Where:** `_nemo_extract_dl_events`, in the per-session row-scan loop that already fills the RF buckets.

1. In that loop, also collect positive `appDlMbps` samples **with their `_dt`** for the session:
   `app_samples.append((rdt, float(appDl)))` when `appDl` is not None and > 0.
2. After the loop, for each session compute (only meaningful for the download session, but compute generically):
   - `peak_mbps = max(v for _, v in app_samples)` (None if empty).
   - `ramp_threshold = 0.9 * peak_mbps`.
   - `ramp_end = first sample (t, v) with v >= ramp_threshold` (by time order).
   - `ramp_up_s = round((ramp_end_t - dreq_dt).total_seconds(), 2)` (fallback: first sample time).
   - `steady_samples = [v for (t, v) in app_samples if t >= ramp_end_t]`.
   - `steady_state_mbps = round(mean(steady_samples), 1)`.
   - `file_avg = avg_rate` (the byte-based rate already computed in this function).
   - `slow_start_loss_pct = round((1 - file_avg/steady_state_mbps) * 100, 1)` when `steady_state_mbps`.
   - `slow_start_dominated = (eff_time and ramp_up_s and ramp_up_s / eff_time >= 0.25)`.
   - `peak_to_avg_ratio = round(peak_mbps / file_avg, 2)`.
3. Add these to the per-session dict (so they appear in `download`/`upload`):
   `peakMbps, steadyStateMbps, rampUpSeconds, slowStartLossPct, slowStartDominated, peakToAvgRatio`.
4. In the `kpis` block (download session only), add:
   `dlPeakMbps, dlSteadyStateMbps, dlRampUpSeconds, dlSlowStartLossPct, dlSlowStartDominated`.
5. Add a human note `dlSlowStartNote` (string or None) — generate when `dlSlowStartDominated`:
   `"Short {eff_time}s transfer is slow-start dominated: steady-state {steady} Mbps vs file-average {fileavg} Mbps ({loss}% lower). Network capacity is better represented by the steady-state figure."`
   For IAM this should fire; for Orange (13 s) it should not.

**Frontend (`app.js`):**
6. In `renderStats`, after the existing `DL avg` chip, add a `steady` chip when
   `evtKpis.dlSteadyStateMbps != null`: label `steady`, value `XXX.X Mbps`, color `#34d399`.
7. Below the timeline stats (or in the scorecard, Task C), when `evtKpis.dlSlowStartNote` is present for IAM,
   render a one-line callout (small, amber left-border) with the note text. Put it in a new
   `<div id="benchmarkNemoSlowStartNote">` placed right after `#benchmarkNemoDlTimelineStats` in `index.html`.

**Verify:** API → IAM `downloadEventKpis.dlSteadyStateMbps` ≈ 430–470, `dlSlowStartDominated=true`, note present;
Orange `dlSlowStartDominated=false`.

---

## TASK B — RF-independent (normalized) efficiency (analysis #4)

**Goal:** compare *network efficiency* independent of momentary RF, to back the "IAM is scheduler/PRB-limited
(has headroom)" vs "Orange is loaded" vs "INWI is coverage-limited" narrative.

**Where:** same row-scan loop in `_nemo_extract_dl_events`.

1. Collect positive samples in the download window for: `dlPrbPct`, `caTotalBwMhz` (fallback `primaryBwMhz`),
   `schBitratePerPrb`. (PRB mean is already computed as `prbUtilMean`.)
2. Compute (prefer steady-state throughput from Task A; else `avg_rate`):
   - `bw_mhz = median(caTotalBwMhz samples)` (fallback primary; None if absent).
   - `mbps_per_mhz = round(steady_or_avg / bw_mhz, 2)` — i.e. bits/s/Hz spectral efficiency.
   - `mbps_per_prb_pct = round(steady_or_avg / prbUtilMean, 2)` — throughput per 1% PRB used.
   - `efficiency_class`:
     - `prbUtilMean < 15` → `"headroom"` (scheduler/PRB-limited — could go faster).
     - `prbUtilMean > 70` → `"loaded"` (capacity-limited).
     - else `"moderate"`.
3. Add to the download dict + `kpis`: `bwMHz, mbpsPerMHz, mbpsPerPrbPct, efficiencyClass`.

**Frontend:** extend the existing **Download-session RF & layer split** card
(`#benchmarkNemoAuthRfBody`, built ~line 3900) with two columns: `Mbps/MHz` and `Mbps per %PRB`,
and an `Efficiency` badge from `efficiencyClass` (green=headroom, amber=moderate, red=loaded).
Keep the IAM/Orange/INWI order.

**Verify:** API → IAM `efficiencyClass="headroom"` (PRB ~5%), Orange/INWI `"loaded"` or `"moderate"`;
`mbpsPerMHz` populated for all three.

---

## TASK C — Executive scorecard at the top (presentation #1)

**Goal:** one verdict-style table at the very top of the results so the analyst sees the winner per
dimension without scrolling.

**Markup (`index.html`):** insert a new card **immediately before** `#benchmarkNemoDlTimelineCard`
(line ~555):
```html
<div id="benchmarkNemoScorecardCard" class="benchmark-nemo-card" style="display:none;margin-bottom:16px">
  <div class="benchmark-nemo-card-title" style="margin:0 0 4px 0">Executive scorecard</div>
  <div style="color:#64748b;font-size:11px;margin-bottom:10px">Per-operator winner by dimension (this DT). n=1 drive test — directional, not statistically significant.</div>
  <div id="benchmarkNemoScorecardBody"></div>
</div>
```

**Frontend (`app.js`):** add `renderBenchmarkNemoScorecard(tlByMetric, tlOpNames)` and call it inside the
same block where the other cards render (where `tlByMetric` is in scope). Build a table:
- Rows = operators in `benchmarkNemoOperatorOrder`.
- Columns:
  - **DL** = `downloadEventKpis.dlAppRateMbps` (byte) + `dlSteadyStateMbps` (steady, Task A).
  - **UL** = `sessionStats.kpis.ulAppTputMbps`.
  - **Latency** = `downloadEventKpis.timeToConnectAvgMs` (connect) / `startDelayAvgS` (setup).
  - **Reliability** = `sessionStats.kpis.pingSuccessPct` + DL/UL status.
  - **RF** = `sessionStats.download.ssSinrMean`.
  - **Efficiency** = `sessionStats.download.efficiencyClass` (Task B).
- For each numeric column, compute the rank and tint the best cell green, worst red (use a helper:
  higher-is-better for DL/UL/RF/reliability; lower-is-better for latency).
- Add a bold **verdict line** under the table: e.g.
  `"DL & latency: IAM · Upload: Orange · RF: IAM · Reliability: tie (ping 50% all)."`
  computed from the per-column winners.
- Hide the card when no operators (add `benchmarkNemoScorecardCard` to the no-data hide array, line ~2905).

**Verify:** scorecard appears at top; DL winner IAM (or INWI by steady-state — show both), UL winner Orange,
RF winner IAM; verdict line matches.

---

## TASK D — Section grouping + collapsible headers (presentation #2)

**Goal:** group the long card stack into 3 collapsible sections.

**Markup (`index.html`):** wrap existing cards (do **not** delete them, just nest) into:
- **Throughput & Capacity** → `#benchmarkNemoDlTimelineCard`, `#benchmarkNemoStartupLatencyCard`, `#benchmarkNemoUploadCard`.
- **Latency & Reliability** → `#benchmarkNemoReliabilityCard`.
- **RF Diagnosis** → `#benchmarkNemoAuthRfCard`, `#benchmarkNemoLayerAnalysis`.
Leave `#benchmarkNemoScorecardCard` (Task C) **above** all sections, always visible.

Section pattern:
```html
<div class="bn-section">
  <button type="button" class="bn-section-header" aria-expanded="true">Throughput &amp; Capacity</button>
  <div class="bn-section-body"> …cards… </div>
</div>
```

**Styles (`style.css`):** add `.bn-section`, `.bn-section-header` (clickable, chevron via ::after that
rotates), `.bn-section.collapsed .bn-section-body { display:none }`. Match the existing dark theme
(`var(--bn-divider)`, card backgrounds).

**JS (`app.js`):** one delegated click handler: clicking `.bn-section-header` toggles `.collapsed` on its
`.bn-section` and flips `aria-expanded`. Default all expanded. Persist state in `localStorage`
(`benchmarkNemoSectionCollapsed`) — optional.

**Verify:** three section headers render; clicking collapses/expands; charts still resize correctly when a
section is re-expanded (call `Chart.instances` resize on expand if a canvas was hidden).

---

## TASK E — Window/layout ergonomics (presentation #4)

**Goal:** the benchmark window opens tiny (580×350) bottom-right and renders behind the sidebar.

**Edit `window_manager.js` (~line 415):** change the `makeFloating(benchmarkPanel, …)` options to a
large, centered window:
```js
const _bw = Math.min(1180, Math.round(window.innerWidth * 0.92));
const _bh = Math.min(840, Math.round(window.innerHeight * 0.9));
window.WM.makeFloating(benchmarkPanel, "5G Benchmark Analysis", {
  x: Math.max(8, Math.round((window.innerWidth - _bw) / 2)),
  y: Math.max(8, Math.round((window.innerHeight - _bh) / 2)),
  width: _bw,
  height: _bh,
  hidden: true,
});
```
Also ensure: the panel body scrolls (the inner results container must be `overflow:auto` with a bounded
height) and the window z-index sits above `#smartcare-sidebar`. If `WM.makeFloating` clamps to viewport,
verify the centered values aren't overridden. Do **not** regress the SmartCare sidebar window directly below.

**Verify:** open Analysis → benchmark; the window is centered, ~1180×840, fully visible, body scrolls,
not clipped by the sidebar. (Confirm via a browser screenshot.)

---

## 2. Version bumps & cache (apply once, after backend tasks)

- `server.py`: `_BENCHMARK_NEMO_ANALYSIS_VERSION` 44 → **45**.
- `index.html`: `app.js?v=v626` → **`v627`**.
- Restart the server. If stale: `rm -f ~/.optim_analyzer/benchmark_nemo_library.sqlite3` then restart.

## 3. Verification checklist (run all)

1. `python3 -c "import ast; ast.parse(open('server.py').read())"` → OK.
2. `node -e "new Function(require('fs').readFileSync('app.js','utf8'))"` → OK.
3. API load (curl above) → for IAM: `dlSteadyStateMbps` set, `dlSlowStartDominated=true`,
   `efficiencyClass="headroom"`, `mbpsPerMHz` set.
4. Browser: scorecard at top with verdict; three collapsible sections toggle; steady/efficiency columns
   present; window centered & scrollable; **no console errors**.
5. Operator order IAM→Orange→INWI everywhere; no NaN/"undefined" in any cell.

## 4. Out of scope / do not change
- The download-from-time-series logic itself (already correct) beyond the additive fields above.
- The session-stats-file parser (`_nemo_parse_session_stats`) — leave as the optional path.
- Parser version (no new parsing is introduced).

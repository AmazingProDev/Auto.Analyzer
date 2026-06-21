# Codex spec — Cumulative macro/scorecard download-session KPIs across N DTs

Goal: make the **Macro diagnosis** and **Executive scorecard** work for multi-DT cumulative scope
("Tous les DT", e.g. Kenitra 54 DTs). Today they show "No valid DL session" / all "—" / "active
download samples: 0" while the **DL Ranking works** — because ranking uses the `App. rate DL` column
but macro/scorecard read the event-reconstructed download session, which is broken for N>1 DTs.
Author: domain owner (IAM). Extends [CODEX_CUMUL_AGGREGATION_PLAN.md] from ranking to session KPIs.

Implement in `server.py` (dataset build + `_nemo_extract_dl_events` aggregation). Read `CLAUDE.md`.
Bump `_BENCHMARK_NEMO_ANALYSIS_VERSION` + `app.js?v=`. Analysis-stage only.

## A. Root causes (verified)
1. **Event-less rows fed to reconstruction.** Build runs `_nemo_extract_dl_events(session_rows)` with
   `session_rows = item.get("_sessionStatsRows") or op_rows` (server.py ~15889). In the **windowed**
   parse, `_sessionStatsRows` = `light_rows` (server.py ~4734) which keeps transfer-KPI fields but
   **omits `eventId`/`eventText`** → 0 DAA/DREQ/DCOMP/DAD found → `sessions=0`, `download=None`,
   `kpis={}` → empty macro/scorecard. (Non-windowed parse sets `_sessionStatsRows`=full rows, which is
   why a direct call works.)
2. **Single-DT isolation.** `_nemo_extract_dl_events` finds all download sessions (45 for Kenitra IAM)
   but **collapses to one** (`kpis.sessionCount=1`, `download`=one session, `throughputSamples=14`).
   No aggregation across the 54 per-DT downloads — built for the historical n=1 case (CLAUDE.md gotcha
   #6).
3. **Download-only export.** The DL-extractor (`tools/extract_dl_sessions.py`) strips ping+upload, so
   latency/reliability have no data; it also dropped the DAA start-event for 8/54 DTs (46 DAA / 54 DT).

## B. Fixes
### B1. Feed event-bearing rows (server.py ~15889)
Use rows that carry `eventId` for reconstruction. `_sessionStatsRows` is event-less in windowed mode,
so:
```python
session_rows = op_rows
ssr = item.get("_sessionStatsRows")
if ssr and any(r.get("eventId") for r in ssr):
    session_rows = ssr
```
(Equivalently: never pass `light_rows` to `_nemo_extract_dl_events`; the windowed `rows` already carry
events — confirmed: dl_events on windowed `rows` → 45 sessions, download non-None.)

### B2. Aggregate across ALL download sessions (the core change)
`_nemo_extract_dl_events` already classifies every session (`kind=="download"`, `success`). When >1
download session exists, return an **aggregate** `download` dict + `kpis` over all download sessions,
using the cumul methodology (consistent with [CODEX_CUMUL_AGGREGATION_PLAN.md]):
- **DT-weighted mean** (each download = one vote): `steadyStateMbps`, `avgRateMbps`, `peakMbps`,
  `downloadDurationS`, `startDelayS`, `timeToConnectMs`, `sessionDurationS`, `nrBandDwellPct.*` (n78…),
  `spectralEff*`, `deliveryEfficiencyPct`, `schedulerYield`, `aggBwMhz`, `scellCount`.
- **Pooled mean weighted by per-session sample count**: `ssRsrpMean`, `ssSinrMean`, `prbUtilMean`,
  `mod256Pct`, `avgRank`, `cqiMean`, `avgMcs`, `nrPdschTput`, `ltePdschTput`, `macDlTput`
  (weight by `throughputSamples`/`rfSamples`).
- **Sum**: `throughputSamples`, `rfSamples`, `bytesDl`. **Count**: `kpis.sessionCount` = #download
  sessions. **Rate**: `success` → DL success rate = successes / #downloads.
- `nrDwellPct` is still overridden by serving-cell download presence in the timeline builder (keep).
Preserve current single-session behavior when sessionCount==1. Add `kpis.dtCount`, `kpis.dlSuccessCount`.

### B3. Per-DT robustness (why only 6/54 produced steady-state)
Investigate the download-classification/selection: many DTs yield a session (DAA=1, appDl rows present)
but `download=None`. Likely a min-sample / direction / Bytes-DL threshold that rejects short fast
downloads (e.g. the 497 Mbps DT has only 3 app-DL rows). Aggregation in B2 must include every
download-classified session, even short ones; lower or remove the per-session steady-state gate for
inclusion (still expose `throughputSamples` so confidence can down-weight short ones). When DAA is
missing, fall back to the first Bytes-DL/appDl row as the session start so the 8 DAA-less DTs still
count. Target: ≥50/54 downloads aggregated for Kenitra IAM.

### B4. Honest latency/reliability for download-only exports
When no upload/ping sessions are found (download-only extracted file), the scorecard + latency panels
must show **"n/a — download-only export"**, NOT "✗ Fail". Add a dataset flag
`sessionStats.downloadOnly = true` when uploads/pings are absent; frontend renders n/a.

## C. Diagnostic harness (reproduces the issue)
```python
import server, re, collections, statistics as st
f="/tmp/optim_uploads/benchmark_nemo/Kenitra-IAM-DL.txt"
p=server._nemo_parse_operator_file(f); rows=p["rows"]
de=server._nemo_extract_dl_events(rows)
print(de["kpis"]["sessionCount"], de["download"] is not None,
      sum(1 for s in de["sessions"] if s.get("kind")=="download"))
# -> 1, True, 45  (45 downloads found, only 1 reported -> must aggregate)
```

## D. Acceptance (Kenitra DL-extracted files, 54 DTs)
- Macro "All DTs" non-empty: DT-weighted steady ≈ ranking (IAM ~106, Orange ~90, INWI ~147 Mbps),
  `kpis.sessionCount` ≈ 50–54, `throughputSamples` = sum (hundreds, not 14), pooled SINR/RSRP/rank/
  256QAM present, n78 dwell present, 5G% matches the Radio-presence panel.
- Scorecard: active download samples > 0 for all three; DL winner INWI; confidence reflects n=54.
- Latency/reliability: "n/a — download-only export" (not Fail).
- DL Ranking unchanged (INWI #1 146.8 / IAM 105.6 / Orange 89.5, win-rate INWI 25 / IAM 17 / Orange 12).

## E. Note on the proper long-term path
This makes the macro correct on the **DL-extracted stopgap** files. The full fix is
[CODEX_SCALE_PLAN.md] (memory-bounded import of the real 200 MB files with ping/upload/download +
full resolution), after which latency/reliability also become real. B2's per-DT aggregation is needed
either way.

## Versions / verify
Bump analysis version + `app.js?v=`. Verify via API/Node on the Kenitra DL files (per
[[verification-preference]]); confirm macro/scorecard populated, sessionCount≈54, ranking unchanged;
`pytest tests/ -q` + `node --test tests/benchmark-nemo-*.test.js`. Add tests for multi-download
aggregation (DT-weighted vs pooled split) and the download-only flag.

## Do not
Report one DT as if it were all 54. Average RF with DT-weighting (RF is pooled). Show "Fail" for
absent upload/ping on a download-only export. Change single-DT (n=1) behavior or the DL ranking.

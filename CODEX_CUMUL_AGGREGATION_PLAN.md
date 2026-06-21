# Codex spec — Cumulative-DTs aggregation methodology + location win-rate

Goal: make the **"Tous les DT (cumulé)"** scope aggregate each KPI with the *right* method —
**DT-weighted** (one location = one vote) for the benchmark ranking, **pooled** (sample/time-weighted)
for radio/scheduler diagnosis — and add a **location win-rate** since the 54 DTs are at different
locations. Author: domain owner (IAM optimization).

Implement in `server.py` (cumulative aggregation in the dataset build) + the ranking UI in `app.js`.
Read `CLAUDE.md` first. Bump `_BENCHMARK_NEMO_ANALYSIS_VERSION` (+ `app.js?v=`). Analysis-stage only.

## A. Reconciliation with current code
The codebase already computes a **DT-weighted DL average** for the cumulative scope (see the memory
note: "Tous les DT avg must be DT-weighted (mean of per-DT averages)"; `app_stats["pooledAverage"]`
exists at server.py ~5324; cumulative aggregation lives in the dataset build / `_optim_*` /
`_nemo_operator_kpis`). This spec **extends that principle to all KPIs** and adds win-rate. Do not
rebuild the per-DT machinery — change only *which* aggregation each KPI uses in the cumulative scope.

## B. Aggregation method per KPI (cumulative scope)
**DT-weighted average** = mean of the per-DT values (each DT counts once):
- DL App. rate, UL App. rate
- DL session duration, UL session duration
- 5G share per test/location
- Peak DL per test, Peak UL per test  → DT-weighted **or P90 across DTs** (expose both; rank on P90 or mean, configurable)

**Per-test/session rate** = successes ÷ tests (count-based):
- DL success rate, UL success rate, DL completion rate

**Pooled average / distribution** (sample/time-weighted — keep or switch these to pooled):
- RSRP, RSRQ, SINR, CQI, MCS, Rank, Modulation share, PRB usage, BLER, Retransmission,
  Band usage (time share), Serving-cell usage (time share)

Tag every cumulative KPI in the payload with its method, e.g. `aggMethod: "dt_weighted" | "pooled" |
"rate"`, so the UI can label it and the two never get conflated.

## C. Cross-DT matching (REQUIRED for win-rate)
Operators label the same DT with different suffixes (IAM/Orange `…​.4`, INWI `…​.6`). Match DTs across
operators by the **Measurement Title with the trailing `.<n>` suffix stripped** (e.g.
`26Jun04_135005`). Only matched DTs are comparable.

## D. Location win-rate (new)
For each matched DT, compare operators on **DT-weighted DL App. rate** (the ranking KPI) and award the
win to the strictly-highest; ties → shared/no-win (define explicitly). Output per operator:
`locationWins`, `locationsCompared`, `winPct`. Also compute the same for UL. Surface in the ranking
panel: e.g. "INWI wins 33/54 locations · IAM 21/54". (Exact counts are computed; the 35/19 in the
brief was illustrative.)

## E. Ranking vs diagnosis separation (presentation)
- **Final ranking** uses the **DT-weighted** KPIs + win-rate. Headline conclusion example for the
  Kenitra data: *"INWI provides better typical DL user experience across the tested locations
  (DT-weighted +~33%); IAM leads only in ~21/54 locations."*
- **Pooled** values are shown as a **diagnostic/time-weighted** indicator, clearly labeled "not the
  benchmark ranking" (the brief: pooled shows only ~+6%, dominated by shared low-throughput periods).
Show both numbers with their method labels so the difference is transparent (DT-weighted 108/144 vs
pooled 56/59 for IAM/INWI).

## F. Acceptance (Kenitra, App. rate DL)
- Cumulative DL ranking (DT-weighted): IAM ≈ 108 Mbps, INWI ≈ 144 Mbps, INWI #1.
- Pooled DL shown as diagnostic: IAM ≈ 56, INWI ≈ 59 (labeled diagnostic, +~6%).
- Win-rate: INWI ≈ 33/54, IAM ≈ 21/54 (computed from matched DTs; show actual).
- Radio KPIs (SINR/RSRP/PRB/…) in cumulative scope are pooled.
- Each cumulative KPI carries its `aggMethod` tag; UI labels DT-weighted vs pooled.
(NB: the supplied Orange file is a byte-identical duplicate of IAM — when a real Orange export is
loaded, all three rank cleanly; until then Orange mirrors IAM.)

## Versions / verify
Bump analysis version + `app.js?v=`. Verify the cumulative DL ranking + win-rate via the API/Node
on the Kenitra DL-extracted files; confirm radio KPIs are pooled and ranking KPIs DT-weighted; UI
shows win-rate and method labels; `pytest tests/ -q` + macro JS tests green; add tests for the
aggregation-method selection and win-rate.

## Do not
Rank on pooled averages. Compare DTs across operators without suffix-stripped title matching. Conflate
DT-weighted and pooled (always tag + label). Change single-DT scope behavior.

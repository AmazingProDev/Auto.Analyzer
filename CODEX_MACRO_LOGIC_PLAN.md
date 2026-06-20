# Codex spec — Macro DL Diagnosis automation (authoritative, v4)

This is the definitive behavior for the **Macro Benchmark DL Analysis**. It supersedes the earlier
v3 notes. Author: domain owner (IAM optimization). For each selected DT (or "All DTs"), produce one
row per operator in fixed order **IAM → Orange → INWI**, and an automatically-generated **IAM-only**
root cause + action + structured evidence + blocked causes + confidence. Competitors are references.

Implement in `benchmark_nemo_macro_state.js` (pure logic + thresholds), `server.py` (a few new
per-operator KPIs), the macro UI in `app.js`, and `tests/benchmark-nemo-macro-state.test.js`.
Read `CLAUDE.md` first. Bump `_BENCHMARK_NEMO_ANALYSIS_VERSION` (new KPIs) and `app.js?v=`.

## A. Reconciliation with current code (do NOT rebuild what exists)
Already in `benchmark_nemo_macro_state.js`: per-op builder, fixed order, `diagnoseMacro`, dual
references (`selectMacroReferences` w/ technical score), confidence scorer, thresholds +
localStorage + `exportMacroProfile`/`importMacroProfile`, DT-type detect, causal-chain guard.
Already in payload (`sessionStats.download`): dlSteady/dlByte, nrDwellPct (now = serving-cell
download presence), nrBandDwellPct.n78, mod256Pct, avgRank, aggBwMhz, scellCount, prbUtilMean,
spectralEffMbpsPerMhz, ssRsrpMean, ssSinrMean, nrRoutePresencePct, rfConsistencyIssues.
**This spec = the changes/additions on top.**

## B. New per-operator KPIs to add (server.py `_nemo_extract_dl_events`, analysis-stage)
Add to the download dict (windowed, same pattern as existing): `cqiMean`, `avgMcs`,
`throughputSamples` (count of active app-DL seconds), `rfSamples` (= rfSampleCount, already present),
`byteVsCurveDeltaPct` = |dlByte − dlSteady| / dlSteady × 100, `schedulerYield` (if derivable; else
omit), and ensure `deliveryEfficiencyPct` (app ÷ MAC) is populated. `nrBands` summary string
(e.g. "n78/n28") from nrBandDwellPct keys.

## C. Thresholds (replace `MACRO_DEFAULT_THRESHOLDS` with this superset; keep editable+profile)
```
atParGapPct:10, closeGapPct:20, moderateGapPct:35,
minDlDurationSec:20, minThroughputSamples:10, minRfSamples:10, maxByteVsCurveDeltaPct:15,
minNrDwellPct:5, lowNrDwellPct:30, minN78DwellPct:5, n78GapPts:10,
sinrGapDb:3, rsrpGapDb:6, poorSinrDb:5, poorRsrpDbm:-110,
bandwidthGapPct:20, scellGapCount:1, rankGap:0.5, qam256GapPts:15,
highPrbPct:80, lowPrbPct:15, seGapPct:20,
lowConfidenceMaxScore:45, mediumConfidenceMaxScore:75
```

## D. Verdict codes (fixed list) + UI labels
`NO_VALID_DL_SESSION`=No valid DL session · `IAM_AT_PAR_OR_LEADING`=IAM at par / leading ·
`IAM_CLOSE_TO_BEST`=IAM close to best competitor · `NO_5G_FOR_IAM`=No 5G for IAM during DL ·
`LOW_5G_RETENTION`=5G / EN-DC retention limitation · `NO_N78_CBAND`=No C-Band n78 usage ·
`N78_UNDER_USED`=n78 C-Band under-used · `RF_COVERAGE_QUALITY_LIMITATION`=Coverage / quality
limitation · `ACTIVE_BANDWIDTH_LIMITATION`=Active bandwidth limitation · `CA_LIMITATION`=CA / SCell
limitation · `MIMO_RANK_LIMITATION`=MIMO / rank limitation · `MODULATION_LIMITATION`=Modulation
limitation · `CAPACITY_LOAD_LIMITATION`=Capacity / load limitation ·
`SCHEDULER_ALLOCATION_LIMITATION`=Scheduler / allocation limitation ·
`SERVER_TCP_APPLICATION_LIMITATION`=Server / TCP / application limitation ·
`MIXED_OR_INCONCLUSIVE`=Mixed / inconclusive. (Migrate existing codes to these names.)

## E. Decision tree (strict order — upstream wins over downstream)
0 valid DL → 1 at-par(≤atParGapPct) → **2 close-to-best (gap >10 & ≤20 ⇒ severity="Optimization
opportunity", DO NOT stop — keep evaluating the reason)** → 3 NO_5G → 4 LOW_5G_RETENTION →
5 NO_N78_CBAND → 6 N78_UNDER_USED → 7 RF_COVERAGE_QUALITY → 8 ACTIVE_BANDWIDTH → 9 CA/SCell →
10 MIMO → 11 MODULATION → 12 CAPACITY_LOAD → 13 SCHEDULER → 14 SERVER_TCP → 15 MIXED.
Severity tiers from gap: ≤10 none · ≤20 "Optimization opportunity" · ≤35 "Moderate gap" ·
>35 "Significant degradation". The verdict headline must reflect severity (close-to-best ≠ failure).

### Critical block rules (must enforce)
- **RF block:** if IAM `ssSinrMean ≥ ref.ssSinrMean` AND IAM `ssRsrpMean ≥ ref.ssRsrpMean` →
  RF_COVERAGE_QUALITY is **blocked**; push blockedCause "RF limitation blocked: IAM RF ≥ reference"
  and a positive evidence line. Only fire RF rule on `iamRfWorse` (gap beyond sinrGapDb/rsrpGapDb) OR
  `iamRfPoor` (sinr<poorSinrDb or rsrp<poorRsrpDbm).
- **Active-bandwidth vs CA:** compute bwGapPct = (ref.activeBw − iam.activeBw)/ref.activeBw×100. If
  ≥ bandwidthGapPct → ACTIVE_BANDWIDTH_LIMITATION. Use CA_LIMITATION **only** when
  `ref.scellCount − iam.scellCount ≥ scellGapCount`. If all SCells = 0 → never CA; use active-bandwidth.
- **MIMO / Modulation:** only when RF comparable (|ΔSINR|≤sinrGapDb & |ΔRSRP|≤rsrpGapDb) AND gap
  beyond rankGap / qam256GapPts. Otherwise block.
- **Scheduler:** only if good RF AND prbPct<lowPrbPct AND gap>closeGapPct **AND no PRB warning**
  (below). If PRB warning active → block SCHEDULER, never primary.

## F. References (exists — confirm/keep)
`bestThroughputCompetitor` = max dlSteady among valid {Orange,INWI}. `bestTechnicalCompetitor` =
max technicalScore (0.30 nrDwell, 0.25 n78, 0.15 activeBw, 0.10 sinr, 0.10 rank, 0.10 256QAM).

## G. Consistency warnings → confidence + blocks
- **PRB:** dlSteady>300 && prbPct<10 ⇒ `prbConsistencyWarning` → block SCHEDULER/LOAD as primary;
  message "High throughput with very low PRB — PRB may not be aggregated across carriers/RATs."
- **RF-vs-throughput:** ref dlSteady>400 && ref ssSinr<0 ⇒ `rfThroughputContradiction`.
- **BW/SCell:** activeBw>50 && scellCount==0 ⇒ `bandwidthScellContradiction`.
Each adds a confidence reason; PRB/RF ones cap confidence at Low.

## H. Confidence (0–100, replace level mapping with score)
Start 100; subtract: shortDL(<minDlDurationSec) −25; lowTputSamples(<minThroughputSamples) −20;
lowRfSamples(<minRfSamples) −20; byteVsCurveDelta>maxByteVsCurveDeltaPct −15; prbConsistencyWarning
−20; rfThroughputContradiction −15; device parity unknown −10; same-location unknown −15.
label: ≤lowConfidenceMaxScore Low · ≤mediumConfidenceMaxScore Medium · else High. Return
`{score,label,reasons[]}`; **UI must show reasons.**

## I. Evidence (structured) + conclusion generator
Each evidence item = {kpi, iamValue, refValue, diff, interpretation} (e.g. "n78 dwell 50% vs 100%,
gap 50 pts → under-used C-Band"). Add `buildConclusion(ctx,diagnosis)` producing the human-readable
paragraph (see template §12 of the source). Verdict object returns: operator rows, both references,
primaryCode+label, severity, gapPct, gapMbps, evidence[], secondary[], blockedCauses[], actions[],
confidence{label,score,reasons}, efficiencyInsight, warnings[], and `conclusionText`.

## J. JSON output schema (return this from buildBenchmarkNemoMacroModel.verdict)
Per the source §13: dtId, dtType, scope, operators[ (all KPIs incl. loadState) ], references{best
throughput,best technical}, diagnosis{ primaryCode, primaryLabel, severity, gapPct, gapMbps,
evidence[], secondary[], blockedCauses[], action[], confidence{label,score,reasons[]}, conclusionText }.

## K. UI (app.js macro mode) — three levels
1. **Macro card (header):** "IAM close to best — n78 retention / active bandwidth optimization · Gap
   12.8% / 67 Mbps · Confidence Low". Show severity, references, confidence + reasons.
2. **Operator table:** the full KPI columns from the source §1B (add CQI, NR bands, Active BW,
   Load State); IAM row carries the conclusion; competitors tagged best-throughput / best-technical.
3. **Evidence drawer** (click IAM conclusion): structured evidence + blocked causes + warnings + the
   "why this diagnosis" bullets. Keep the threshold editor + export/import profile.

## L. Target output for the Mohammedia "All DTs" case (acceptance)
Primary `N78_UNDER_USED`, severity "Optimization opportunity", gap 12.8%/67 Mbps; RF blocked
(IAM 15.4 dB/−102 ≥ INWI −1.9/−111); secondary "Active bandwidth limitation"; efficiencyInsight
present (IAM 12.94 > INWI 7.42 bps/Hz); warnings: PRB consistency + INWI RF-vs-throughput;
confidence Low with those reasons; conclusionText ≈ source §12.

## Versions / tests
Bump analysis version + `app.js?v=`. Tests: every block rule, gap tiers, PRB-warning blocks
SCHEDULER, RF block, active-bw-vs-CA, references differ case, confidence score+reasons, and the §L
acceptance fixture. `node --test tests/benchmark-nemo-macro-state.test.js` + `pytest tests/ -q`.

## Do not
Use n75 (C-Band = n78). Present a ≤20% gap as a hard failure. Allow RF/MIMO/Modulation/Scheduler
causes when their block rule applies. Contradict the detailed causal chain.

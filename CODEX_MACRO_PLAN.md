# Codex execution plan — Macro DT Diagnosis (IAM root-cause)  ·  v2

A new **"Macro" analysis mode**: for the selected DT, one row per operator (IAM → Orange → INWI)
with key DL-session KPIs, plus a **Conclusion** (on IAM's row only) giving IAM's single primary
root cause + action + evidence + secondary contributors + confidence — via a deterministic,
threshold-driven decision tree that is kept consistent with the detailed causal-chain analysis.

Read `CLAUDE.md` + `AGENTS.md` first. Line numbers approximate — `grep` for anchors.

## Locked decisions
1. **C-Band = `n78` only.** Never use `n75`.
2. **IAM-centric verdict**, with the 5G/NR branch split into four distinct states (see tree):
   no 5G deployment/coverage · NR detected but not retained during DL · no n78 usage · n78 under-used.
3. **Two competitor references:**
   - **Best-throughput competitor (`C_tput`)** — highest DL steady throughput → used for the DL gap,
     at-par test, and ΔMbps.
   - **Best-technical competitor (`C_tech`)** — highest composite radio/capacity score → used for the
     RF / CA / MIMO / modulation comparisons. (May differ from `C_tput`.)
4. **Confidence is a multi-factor score** (§ Confidence), not a single n.
5. **Verdict object** (IAM) must carry: `primary`, `action`, `evidence`, `secondary[]`, `confidence`.
6. **Thresholds**: defaults in code, editable in UI, persisted in localStorage, **export/import as a
   JSON "threshold profile."**
7. **DT-type aware**: Static / Mobility / Event / Indoor — adjusts confidence + interpretation.
8. **Never contradicts the detailed causal-chain** (§ Consistency guard).

## Dependencies / ordering
Land the validity layer first (`CODEX_VALIDITY_PLAN.md`): macro consumes **active-slot RF**
(`ssSinrMean`, `ssRsrpMean`, `prbUtilMean`), **steady-state throughput** (`dlSteadyStateMbps`),
**device parity** (`deviceByOperator`), and the **confidence inputs**. Reuse
`_deep_download_window_nr_share` (server.py ~L12695) and the deep causal-chain output
(`execSummary.causalChain`, produced by `_deep_causal_chain` ~L12408).

---

## TASK A — Backend: DL-session KPIs + context for the macro view

Extend `_nemo_extract_dl_events` (server.py ~L2305) — analysis-stage, **no parser bump**. Add to the
download dict + `kpis` (DL-window, active slots where applicable):

1. `nrDwellPct` — % of DL-window on NR/EN-DC (reuse `_deep_download_window_nr_share`).
2. `nrRoutePresencePct` — route-wide NR presence (pass through `technologyStatus.nrPresencePct`) so
   the **retention** rule can compare "NR on route" vs "NR during DL."
3. `nrBandDwellPct` — `{ "n78": x, "n1": y, "n28": z, … }` per-NR-band dwell % in the DL window.
4. `mod256Pct` — % of active DL slots at 256QAM.
5. `avgRank` — mean MIMO layers over active slots.
6. `aggBwMhz` (mean `caTotalBwMhz`, fallback `primaryBwMhz`+`sumSecondaryBwMhz`), `scellCount`.
7. `spectralEffMbpsPerMhz` = `dlSteadyStateMbps / aggBwMhz`.
8. `dlCentroid` `{lat, lon}` (mean GPS over DL window) + `dlMedianSpeedKmh` (from a `Speed` column if
   present, else derived from consecutive GPS deltas) — feed the **location** confidence factor and
   **DT-type auto-detection**.
9. `recoverableMbps` per cause if gap-attribution is available (optional).

Also ensure the per-DT payload exposes the deep **causalChain** (breakpoint + stage states) for the
Consistency guard, and `deviceByOperator` (from the validity layer).

**Verify (API):** `dlTimelineByMetric[op].sessionStats.download` has `nrDwellPct`,
`nrRoutePresencePct`, `nrBandDwellPct.n78`, `mod256Pct`, `avgRank`, `aggBwMhz`, `scellCount`,
`dlCentroid`, `dlMedianSpeedKmh` for IAM/Orange/INWI.

---

## TASK B — Frontend decision module `benchmark_nemo_macro_state.js` (pure, tested)

Mirror `benchmark_nemo_scorecard_state.js` (browser global + `module.exports`). All verdict logic
here so threshold edits re-run instantly with no server round-trip.

### B1. Thresholds (single tuning source) + profiles
`MACRO_DEFAULT_THRESHOLDS`:
```
atParGapPct: 10,
no5gDwellPct: 5,          // NR dwell in DL < 5% AND route NR < 5% ⇒ no 5G deployment
retentionDropPts: 30,     // route NR − DL NR > 30 pts (route had NR, DL lost it) ⇒ retention
noN78DwellPct: 5,
n78UnderusePts: 10,       // IAM n78 < C_tech n78 − 10 pts
sinrGapDb: 3, rsrpGapDb: 6,
caBwGapPct: 20,
rankGap: 0.5,
mod256GapPts: 15,
prbLowPct: 15, prbHighPct: 80,
serverTcpFloorMbps: null, // optional absolute App<<MAC heuristic
// composite weights for C_tech score:
techW: { sinr: 0.30, rank: 0.20, mod256: 0.20, n78: 0.15, aggBw: 0.15 },
// confidence factor weights & cutoffs (see B4)
conf: { minDlSec: 8, minActiveSlots: 8, low: 0.5, high: 0.8 }
```
- `loadMacroThresholds()/saveMacroThresholds(obj)` — localStorage key `benchmarkNemoMacroThresholds`,
  deep-merged over defaults (copy the `loadBenchmarkMycomThresholds` pattern).
- `exportMacroProfile()` → JSON string; `importMacroProfile(json)` → validate & persist. (UI buttons in C.)

### B2. References
- `C_tput` = valid competitor with max `dlSteady`.
- `C_tech` = valid competitor with max composite score
  `Σ techW[k]·normalize(metric_k)` over {sinr, avgRank, mod256Pct, n78Pct, aggBwMhz}
  (normalize per-metric across the 3 operators). Return both; verdict names both.

### B3. Decision tree — `diagnoseMacro(perOp, ctx, thresholds)`
`ctx` = `{ causalChain, dtType, deviceByOperator, dlCentroids }`. Evaluate top-down; **first match =
primary**, all other matches = `secondary[]`. Order (upstream wins over downstream symptom):

| # | code | condition | label → action | ref |
|---|---|---|---|---|
|0|`NO_DL`|IAM invalid/failed DL|No valid DL session → re-test|—|
|0b|`AT_PAR`|gap ≤ atParGapPct|IAM at par / leading → no action|C_tput|
|1|`NO_5G`|IAM nrDwellPct < no5gDwellPct **and** nrRoutePresencePct < no5gDwellPct|No 5G coverage/deployment → deploy/enable 5G|C_tput|
|2|`ENDC_RETENTION`|route NR present but (nrRoutePresencePct − nrDwellPct) > retentionDropPts|NR not retained during DL → EN-DC/5G retention optimization (anchor, B1/SCG stability)|C_tput|
|3|`NO_N78`|IAM n78 dwell < noN78DwellPct|No C-Band (n78) usage → deploy/activate n78|C_tech|
|4|`N78_UNDERUSE`|IAM n78 < C_tech.n78 − n78UnderusePts|Under-used n78 → improve n78 selection/retention|C_tech|
|5|`COVERAGE`|IAM sinr < C_tech.sinr − sinrGapDb **or** rsrp < C_tech.rsrp − rsrpGapDb|Coverage/Quality limitation → RF optimization|C_tech|
|6|`CA_BW`|IAM aggBw < C_tech.aggBw·(1−caBwGapPct/100) or fewer SCells|CA/bandwidth limitation → add carriers/SCells|C_tech|
|7|`MIMO`|IAM avgRank < C_tech.avgRank − rankGap (RF comparable)|MIMO/rank limitation|C_tech|
|8|`MODULATION`|C_tech.mod256Pct > IAM.mod256Pct + mod256GapPts (RF comparable)|Modulation limitation|C_tech|
|9|`LOAD`|IAM prbPct > prbHighPct|Capacity/load limitation → offload/expand|C_tech|
|10|`SCHEDULER`|IAM prbPct < prbLowPct with good RF & spectrum|Scheduler/allocation limitation → scheduler/CA-activation tuning|C_tech|
|11|`SERVER_TCP`|radio healthy (no rule 1-10) but throughput still < gap → App≪MAC / short slow-start-bound transfer|Server/TCP/application limitation → multi-thread/server/file-size methodology|C_tput|
|12|`MIXED`|none dominant|Mixed — see detailed analysis|—|

"RF comparable" = NOT(rule 5) — so an upstream RF cause always outranks the MIMO/modulation symptoms
it produces. Tree order exactly matches the requested sequence:
`NO_DL → AT_PAR → NO_5G → ENDC_RETENTION → NO_N78 → N78_UNDERUSE → COVERAGE → CA_BW → MIMO → MODULATION → LOAD → SCHEDULER → SERVER_TCP → MIXED`.

### B4. Confidence scoring
`scoreConfidence(perOp, ctx, thresholds)` → `{level: "Low"|"Medium"|"High", score, factors{…}, reasons[]}`.
Factors (each 0–1, then weighted-averaged; cutoffs `conf.low`/`conf.high`):
- `dlDuration` — IAM DL duration vs `conf.minDlSec` (short slow-start-bound transfer ⇒ lower).
- `validSamples` — `activeSlotCount` vs `conf.minActiveSlots`.
- `availability` — required RF/NR/CA fields present & non-null for IAM and C_tech.
- `sameLocation` — proximity of operators' `dlCentroid`s (closer ⇒ higher; unknown GPS ⇒ 0.5).
  *(Lightweight scoring factor only — NOT the standalone co-location check that was descoped.)*
- `deviceParity` — same device model across operators (different/unknown ⇒ lower).
- `dtType` — Static 1.0 · Indoor 0.7 · Mobility 0.8 · Event 0.7 (see B5).
Always list the dragging factors in `reasons[]` (e.g. "n=1 DT", "short 4.7 s transfer", "devices differ").

### B5. DT-type awareness
`detectDtType(perOp, manualOverride)` → one of `Static | Mobility | Event | Indoor`:
- auto from `dlMedianSpeedKmh`: <3 ⇒ Static, >15 ⇒ Mobility; poor/absent GPS ⇒ Indoor; else Static.
- `manualOverride` (from UI) wins. Effects: feeds `dtType` confidence factor **and** an
  `interpretationNote` (e.g. Mobility → "RF reflects route average; coverage verdict is route-level";
  Indoor → "GPS-based location validity reduced"; Static → "single-point result, high spatial confidence").

### B6. Consistency guard (must agree with causal chain)
After `primary` is chosen, reconcile with `ctx.causalChain.breakPoint`:
- Map macro codes ↔ causal stages (RF→COVERAGE, spectral-eff/MCS→MODULATION, MIMO→MIMO,
  PRB→SCHEDULER/LOAD, bandwidth→CA_BW, NR presence→NO_5G/RETENTION).
- If macro `primary` is **downstream** of the causal-chain break, override `primary` to the
  upstream cause the chain identifies (and move the demoted one to `secondary`).
- Emit `consistency: {aligned: bool, causalBreak, note}`. The two views must never disagree.

### B7. Verdict object (returned by `diagnoseMacro`)
```
{ bestThroughputCompetitor, bestTechnicalCompetitor, gapPct, deltaMbps,
  primary: {code, label, action},
  evidence: [ "IAM SINR 8.2 dB vs Orange 14.1 dB (−5.9)", "n78 dwell 12% vs 68%", … ],
  secondary: [ {code, label}, … ],
  confidence: {level, score, factors, reasons},
  dtType, interpretationNote,
  consistency: {aligned, causalBreak, note} }
```

### B8. Test — `tests/benchmark-nemo-macro-state.test.js`
Cases per rule code; AT_PAR; NO_DL; C_tput≠C_tech selection; COVERAGE outranks MODULATION/MIMO;
ENDC_RETENTION vs NO_5G split; consistency guard demotes a downstream primary; confidence Low on
n=1/short transfer; DT-type override changes confidence + note; profile export/import round-trip.

---

## TASK C — Frontend "Macro" mode + UI

1. **Button** `#benchmarkNemoMacroBtn` ("Macro") in `#benchmarkNemoModeControls` (index.html ~L533);
   wire next to Express/Detailed/EMA handlers (mode → render macro, hide others).
2. **Card** `#benchmarkNemoMacroCard` with: a header line, a **DT-type selector** (auto + manual
   override), the table `#benchmarkNemoMacroBody`, the IAM verdict block, and a `⚙ thresholds` panel.
3. **Table** — one row per operator in `benchmarkNemoOperatorOrder` (IAM→Orange→INWI). Columns:
   Operator · DL (steady/byte) · 5G % · n78 % · SS-RSRP · SS-SINR · 256QAM % · avg rank ·
   agg BW/#SCells · PRB % · spectral eff · **Conclusion**.
   - **Conclusion only on IAM's row**: primary (bold) + action + a confidence badge; `secondary[]`
     as small chips; `evidence[]` as a tooltip/expander. Color the deciding metric cells.
   - Competitor rows: tag **`C_tput` ⭐ (throughput)** and **`C_tech` 🛠 (technical)**; others "ref".
   - Header: `"Macro — DT <name> · <DT-type> · IAM vs <C_tput> (gap −XX%, ≈ΔY Mbps) · radio ref <C_tech> · confidence <level>"`.
4. **Thresholds panel:** numeric inputs per key → `saveMacroThresholds` + re-run `diagnoseMacro`
   live; **Reset to defaults**; **Export profile** (download JSON) + **Import profile** (file/paste).
5. Hide `#benchmarkNemoMacroCard` in the no-data path (add id to the hide array, app.js ~L2905).

**Verify (browser, no console errors):** Macro mode renders; IAM Conclusion shows primary/action/
evidence/secondary/confidence; C_tput and C_tech tagged (and can differ); editing a threshold re-runs
live; DT-type override changes confidence + note; profile export/import works; macro primary always
matches the detailed causal-chain break; IAM→Orange→INWI order.

## Versions & cache
- Analysis-stage only → bump `_BENCHMARK_NEMO_ANALYSIS_VERSION` by 1. No parser bump.
- `index.html`: bump `app.js?v=…` and add `<script src="benchmark_nemo_macro_state.js?v=…">`.
- Reset + reload: `./reset-benchmark.sh`.

## Verification checklist
1. `python3 -c "import ast; ast.parse(open('server.py').read())"`; `node -e "new Function(require('fs').readFileSync('app.js','utf8'))"`.
2. `node tests/benchmark-nemo-macro-state.test.js`; `python3 -m pytest tests/ -q`.
3. API: Task A KPIs present per operator; causalChain + deviceByOperator exposed.
4. Browser checks above; confirm **macro verdict == causal-chain family** on the Mohammedia DT.

## Do not change
- Download-isolation / deep-analysis engines beyond the additive KPIs in Task A.
- No GPS **co-location gate/check** feature (location enters only as a soft confidence factor).
- No parser-stage changes.

# Codex execution plan — Benchmark validity & confidence layer

Goal: make every benchmark verdict **defensible** by (A) fixing RF aggregation so it's physically
consistent + flagging impossible values, (B) surfacing device-model parity, and (C) quantifying
confidence/uncertainty instead of showing over-precise point estimates.

**Explicitly out of scope:** GPS co-location / comparability check (deferred by request).

Read `CLAUDE.md` + `AGENTS.md` first. Line numbers are approximate — `grep` for the anchor.

## Current state (verified)
- `server.py`: `_BENCHMARK_NEMO_PARSER_VERSION = 6` (~L116), `_BENCHMARK_NEMO_ANALYSIS_VERSION = 48` (~L14559).
- `index.html`: cache-bust `app.js?v=v629` (~L1114).
- `_nemo_extract_dl_events(rows)` (~L2305): per-session row-scan loop fills RF buckets
  `rf_rsrp, rf_sinr, rf_prb, nr_pdsch, lte_pdsch` (~L2432, appended ~L2499-2500), means computed
  ~L2621-2622 (`_avg_series`), stored on the session dict ~L2719 (`ssRsrpMean`, `ssSinrMean`,
  `prbUtilMean`, `nrPdschTput`, `ltePdschTput`). **Today it averages over ALL rows in the
  [DAA,DAD] window — including connect/ramp/idle — which is why INWI shows SINR −1.8 dB with
  375 Mbps (physically impossible).**
- Per-row fields available: `appDlMbps, rsrpNr, sinrNr, dlPrbPct, pdschDl5gMbps, pdschDlLteMbps, _dt`.
- No device-name column is parsed today.
- Frontend cards: scorecard (`#benchmarkNemoScorecardBody`), RF card (`#benchmarkNemoAuthRfBody`),
  stats row (`renderStats`, app.js ~L3527). Operator order via `benchmarkNemoOperatorOrder`.

---

## TASK A — Active-slot RF re-aggregation + consistency validator (accuracy fix)

**Where:** `_nemo_extract_dl_events`, the per-session row-scan loop + the means block after it.

1. **Gate RF/PHY collection to active download slots.** For each row in the window compute:
   ```
   app  = row.get("appDlMbps");  nrp = row.get("pdschDl5gMbps");  ltep = row.get("pdschDlLteMbps")
   active = (app and app > 0) or (nrp and nrp > 0) or (ltep and ltep > 0)
   ```
   Only when `active` is true, append to the RF/PHY buckets. Track `active_slot_count`.
   (This excludes connect/ramp/idle rows that pull SINR negative.)

2. **Throughput-weight the SINR (and RSRP) mean.** Append `(value, weight)` with
   `weight = app or ((nrp or 0)+(ltep or 0)) or 1.0`, and compute a weighted mean:
   `sum(v*w)/sum(w)`. Fall back to a simple mean of active slots if weights are all zero.
   PRB and PDSCH means can stay simple means **over active slots**.

3. **Consistency validator.** After computing the means, build `rf_consistency_flags: list[str]`:
   - `ssSinrMean is not None and ssSinrMean < 0 and (nrPdschTput or 0) > 50` →
     `"SINR<0 dB with high NR PDSCH ({nrPdschTput} Mbps) — RF average unreliable"`.
   - `ssRsrpMean is not None and ssRsrpMean < -120 and ((nrPdschTput or 0)+(ltePdschTput or 0)) > 50` →
     `"very low RSRP with high throughput — check RF attribution"`.
   - `active_slot_count < 3` → `"only {n} active-download samples — RF average is low-confidence"`.

4. **Expose** on the session dict + `kpis`: `activeSlotCount`, `rfConsistencyFlags`
   (and keep the existing `ssRsrpMean/ssSinrMean/prbUtilMean/nrPdschTput/ltePdschTput`, now active-slot).

**Frontend (RF card, `#benchmarkNemoAuthRfBody`):** when a row has `rfConsistencyFlags`, render a
small amber ⚠ badge in that operator's row with the flag text on hover/title. The SINR cell should
now show a realistic positive value for INWI.

**Verify:** API → INWI `sessionStats.download.ssSinrMean` is now physically consistent with its NR
throughput (expect a positive dB value, not −1.8); `activeSlotCount` present for all three; the
impossible-combo flag is **absent** after the fix (it should only appear for genuinely sparse data).

---

## TASK B — Device-model parity (accuracy / professional)

Different chipsets ⇒ different RF/throughput; a benchmark across different devices isn't directly
comparable. Surface it.

1. **Parse the device (parser-stage).** In `_nemo_parse_operator_file_uncached`, resolve a device
   column via aliases (use the existing `resolve(header_map, (...))` pattern):
   `("Device name", "Device label", "Device", "Terminal name", "Terminal", "Equipment", "UE model", "Model")`.
   Store `operator_file["deviceName"]` = the most frequent non-empty value across rows (or first
   non-empty). If none found, set `None` (graceful — no column in some exports).
   *(Optional: if `operator_file["sessionStats"]` exists and has a device, use it as fallback.)*

2. **Dataset build:** collect `deviceByOperator = {op: deviceName}` and a boolean
   `devicesComparable = (count of distinct non-None device names) <= 1`. Attach to the dataset
   payload (e.g. `dataset["benchmarkValidity"] = {deviceByOperator, devicesComparable, ...}` —
   reuse this object for Task C too).

3. **Frontend:** show the device per operator in the scorecard (or a small "Test conditions" line)
   and, when `devicesComparable` is false, a warning:
   `"⚠ Different device models across operators — RF/throughput not strictly comparable."`
   If all devices are unknown/None, show nothing (no false warning).

**Verify:** API → `dataset.benchmarkValidity.deviceByOperator` populated when the export has a device
column; warning appears only when models differ.

---

## TASK C — Confidence & uncertainty (accuracy / professional)

Stop presenting n=1 point estimates as if they were statistically settled.

1. **Per-operator uncertainty (analysis-stage, in `_nemo_extract_dl_events` or the timeline builder):**
   from the active-download per-second `appDlMbps` samples, compute a spread and attach to `kpis`:
   `dlSampleSpread = {min, p10, p50, p90, max, n}` (reuse any existing percentile helper, e.g.
   `_nemo_percentile`).

2. **Run-level confidence (dataset build):** add to `dataset["benchmarkValidity"]`:
   - `dtCount` = number of DTs analyzed (`len(dtList)` or 1).
   - `confidenceLevel`: `"Low"` if `dtCount <= 1` or any operator `activeSlotCount < 5`;
     `"Medium"` if `dtCount` in 2–3; `"High"` if `dtCount >= 4`.
   - `confidenceReason`: short string, e.g. `"n=1 drive test; 4 active download seconds (IAM)"`.

3. **Frontend:**
   - **Scorecard header:** a confidence badge (`Low`=amber, `Medium`=blue, `High`=green) +
     `"n=<dtCount> DT"`. Keep the existing "directional, not statistically significant" caption when Low.
   - **Numbers match evidence:** when `confidenceLevel == "Low"`, render DL/UL throughput as whole
     Mbps (no decimals) and append the range from `dlSampleSpread`, e.g. `"338 Mbps (120–482)"`.
   - **Methodology note** (small text under the scorecard): `dtCount`, per-operator active samples,
     device models, and `confidenceReason` — this is the audit-defensibility line.

**Verify:** scorecard shows a `Low` badge + `n=1 DT`; IAM DL renders as `338 Mbps (≈120–482)` not
`338.41`; methodology note lists the conditions.

---

## Version bumps & cache (apply once, after backend tasks)
- Task A & C are analysis-stage → bump `_BENCHMARK_NEMO_ANALYSIS_VERSION` **48 → 49**.
- Task B parses a new column (parser-stage) → bump `_BENCHMARK_NEMO_PARSER_VERSION` **6 → 7**.
- `index.html`: `app.js?v=v629` → **`v630`**.
- Reset caches + reload: **`./reset-benchmark.sh`** (clears SQLite, restarts, reloads, prints KPIs).
  A parser bump requires the SQLite clear — the script handles it.

## Verification checklist (run all)
1. `python3 -c "import ast; ast.parse(open('server.py').read())"` and
   `node -e "new Function(require('fs').readFileSync('app.js','utf8'))"` → OK.
2. `python3 -m pytest tests/ -q` → green (update any benchmark test fixtures you touch).
3. `./reset-benchmark.sh` then inspect the API: INWI SINR now physically consistent;
   `activeSlotCount`, `dlSampleSpread`, `benchmarkValidity.{deviceByOperator,confidenceLevel}` present.
4. Browser (no console errors): RF card shows realistic INWI SINR + ⚠ flags only when warranted;
   scorecard shows confidence badge + ranges; methodology note present; operator order IAM→Orange→INWI.

## Do not change
- The time-series download-isolation logic (already correct) beyond the additive fields above.
- The deep-analysis engine (`_deep_build_detailed_analysis` etc.).
- No GPS / co-location work in this task.

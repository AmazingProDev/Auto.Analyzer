# Macro DL Diagnosis — detailed logic

The **Macro Benchmark DL Analysis** produces one IAM-focused root-cause verdict per selected DT (or
"All DTs"). It is a **pure client-side module** — [`benchmark_nemo_macro_state.js`](benchmark_nemo_macro_state.js)
— computed from the loaded dataset; competitors (Orange, INWI) are references, never the subject.
Operator order is fixed **IAM → Orange → INWI**. Tests:
[`tests/benchmark-nemo-macro-state.test.js`](tests/benchmark-nemo-macro-state.test.js)
(`node --test`). Cache-bust: `benchmark_nemo_macro_state.js?v=` in `index.html`.

> Design rule: **context ≠ root cause**. Conditions that describe the *segment* (LTE-only, PHY metrics
> not exported) are reported as **context**; the **primary** is the IAM-specific root cause. Blocked
> causes and data-quality warnings are kept in their own arrays, separate from secondary contributors.

## 1. Inputs (per operator)
- **Throughput:** `dlSteadyMbps` (curve), `dlByteMbps`/`dlAppRateMbps` (byte-based); `dlThroughput()` = steady ?? byte ?? appRate.
- **5G:** `nrDwellPct` (active-DL), `nrRoutePresencePct` (route), `nrBandDwellPct.n78`.
- **RF:** `ssRsrpMean`, `ssSinrMean`.
- **PHY/resource:** `mod256Pct`, `avgRank`, `aggBwMhz`, `scellCount`, `prbPct`, `cqiMean`, `avgMcs`, `spectralEffMbpsPerMhz`, `schedulerYield`, `deliveryEfficiencyPct`.
- **Quality/validity:** `dlDurationS`, `throughputSamples`, `rfSamples`, `byteVsCurveDeltaPct`, `slowStartDominated`, `dlCentroid`, `deviceModel`.

## 2. Reference selection (four references)
- **Best-throughput reference** = competitor with the highest `dlThroughput`.
- **Best-technical reference** = competitor with the highest normalised (0–1) weighted score:
  - **EN-DC mode** (≥1 operator has 5G): `0.30·nrDwell + 0.25·n78 + 0.15·aggBw + 0.10·SINR + 0.10·rank + 0.10·256QAM`.
  - **LTE-only mode** (no operator ≥5% 5G): `0.35·SINR + 0.25·RSRP + 0.20·DL + 0.10·CQI + 0.10·256QAM`.
    CQI/256QAM read as **≤0 are treated as not-exported and ignored** — the term is dropped and the
    weights are renormalised over the available metrics. SINR/RSRP/DL are always included.
- **Best-capacity reference** = competitor with the highest `0.30·n78 + 0.25·NR-active-BW +
  0.20·NR-PDSCH-tput + 0.15·sched-bitrate/PRB + 0.10·DL`. Drives the n78-retention/active-BW promotion.
- **Best-RF reference** = operator (incl. IAM) with the strongest SS-SINR, then SS-RSRP.
- **Best-BLER reference** = competitor with the lowest NR DL BLER.

## 3. Context flags
- **`lteOnly`** — no operator reaches `minNrDwellPct` (5%) on active **or** route 5G.
- **5G/EN-DC vs 5G/n78** — non-LTE-only segments emit `FIVEG_N78_SEGMENT` (a operator used n78 ≥5%) or `FIVEG_ENDC_SEGMENT`.
- **`nrDominantIam`** — IAM carries ≥70% of DL traffic on NR → `NR_DOMINANT_IAM` (LTE anchor weighted as minor).
- **`competitorHas5g`** — a non-IAM operator reaches the 5G floor.
- **`phyUnavailable`** (IAM) — `aggBw=0 & prb=0 & rank=0 & mcs=0` while `DL>0` → zeros are "not exported", not real.
- **RF** vs best-technical ref: `sinrGap=ref−IAM`, `rsrpGap=ref−IAM`
  - `rfComparable` = `|sinrGap|≤3 dB & |rsrpGap|≤6 dB`
  - `iamRfWorse` = `sinrGap>3 OR rsrpGap>6` · `iamRfPoor` = `SINR<5 dB OR RSRP<−110 dBm`
  - `iamRfAtLeastAsGood` = IAM SINR ≥ ref **and** RSRP ≥ ref → **blocks** any RF cause
  - `goodRf` = IAM SINR ≥ 5 dB **and** RSRP ≥ −110 dBm

`context[]` carries `LTE_ONLY_SEGMENT`, `FIVEG_N78_SEGMENT`/`FIVEG_ENDC_SEGMENT`, `NR_DOMINANT_IAM`
and/or `PHY_METRICS_UNAVAILABLE`. Context describes the segment and is kept **separate** from the
root cause, secondary contributors, symptoms, blocked causes and warnings.

## 4. Gap & severity
`gapPct = (refDL − iamDL)/refDL × 100` against the best-throughput reference.

| gapPct | severity |
|---|---|
| ≤10 | None (IAM at par / leading) |
| ≤20 | Optimization opportunity |
| ≤35 | Moderate gap |
| >35 | Significant degradation |

## 5. Decision tree (rules collected in priority order; upstream wins)
```
0  no IAM / no DL ................... NO_VALID_DL_SESSION
1  gap ≤ 10% ........................ IAM_AT_PAR_OR_LEADING   (stop)
2  10% < gap ≤ 20% .................. IAM_CLOSE_TO_BEST       (keep evaluating)

   ── 5G / n78 ──
   if lteOnly:  BLOCK NO_5G_FOR_IAM + BLOCK NO_N78_CBAND   (shared context)
   else:
       NO_5G_FOR_IAM    if IAM 5G<5% AND a competitor has 5G
       LOW_5G_RETENTION if IAM dwell<30% but route≥30%
       NO_N78_CBAND     if IAM n78<5% AND competitor has 5G AND ref n78>0
       N78_RETENTION_BANDWIDTH_LIMITATION  (combined, promoted) if
            (capRef.n78 − iamN78 ≥ 10 pts) AND (capRef NR-active-BW ≥ 1.2× IAM's).
            Supersedes N78_UNDER_USED + ACTIVE_BANDWIDTH (folded into it, not repeated).
       N78_UNDER_USED   if (refN78 − iamN78) > 10 pts

   ── RF ──
   if iamRfWorse OR iamRfPoor:
       if iamRfAtLeastAsGood → BLOCK RF
       else → RF_COVERAGE_QUALITY_LIMITATION
              (renamed LTE_RF_COVERAGE_QUALITY_LIMITATION when lteOnly)

   ── PHY / resource  (all gated by !phyUnavailable) ──
   ACTIVE_BANDWIDTH_LIMITATION      if bwGap ≥ 20%
   CA_LIMITATION                    if SCells not all-zero AND scellGap ≥ 1
   MIMO_RANK_LIMITATION             if rankGap > 0.5  → only if rfComparable, else BLOCK
   MODULATION_LIMITATION            if 256QAM gap > 15 pts AND rfComparable AND no n78/BW cause
                                    → else → SYMPTOM (link-adaptation symptom, not a root cause)
   CAPACITY_LOAD_LIMITATION         if PRB ≥ 80%  → BLOCK on PRB-consistency warning
   SCHEDULER_ALLOCATION_LIMITATION  primary-path: goodRF AND PRB<15% AND gap>20% (BLOCK on PRB warn);
                                    contributor-path: IAM sched-bitrate/PRB OR NR-PDSCH tput >20%
                                    below the capacity reference → secondary contributor.
   NR_BLER_RETX_LIMITATION          primary-eligible only if NR BLER > 10% (severe); otherwise a
                                    secondary contributor when IAM BLER ≥ ref + 1 pt. (DL HARQ retx
                                    and BLER>10%-share are not exported → BLER-avg only.)

   ── application (last resort) ──
   SERVER_TCP_APPLICATION_LIMITATION  fires ONLY if gap>10% AND
        (byteVsCurve>15% OR slowStart OR delivery<75%) AND
        no upstream radio cause matched AND goodRF.
        Otherwise BLOCKED (any radio cause, weak/poor RF, or not-good RF blocks it).

   fallback → LTE_ONLY_IAM_UNDERPERFORMANCE (if lteOnly) else MIXED_OR_INCONCLUSIVE
```
**Primary** = first matched rule in evaluation order (which follows this priority); if it is
`IAM_CLOSE_TO_BEST` and other causes matched, the highest-priority real cause (by `RULE_ORDER`) is
promoted. The **causal-chain guard** can pull an upstream cause to primary so the macro never
contradicts the detailed causal chain. Remaining matches → **secondary** (sorted by `RULE_ORDER`).

## 6. Consistency warnings (`warnings[]`, separate from secondary)
- **`prbConsistencyWarning`** — IAM DL>300 & PRB<10% → blocks scheduler/capacity, caps confidence Low.
- **`rfThroughputContradiction`** — ref DL>400 & SINR<0 → caps confidence Low.
- **`bandwidthScellContradiction`** — aggBW>50 & SCell=0.

## 7. Confidence (start 100, subtract penalties)
| condition | penalty |
|---|---|
| short DL (<20 s) | −25 |
| few throughput samples (<10) | −20 |
| few RF samples (<10) | −20 |
| byte-vs-curve delta >15% | −15 |
| slow-start-dominated transfer | −10 |
| **PHY metrics unavailable** (hard) | −25, **cap ≤ Medium** |
| prbConsistencyWarning (hard) | −20, cap ≤ Low |
| rfThroughputContradiction (hard) | −15, cap ≤ Low |
| devices mismatched (`false`) **or** unknown | −10 |
| not co-located (`false`) **or** location unknown | −15 |

Device/location penalties apply **only** when parity/co-location is mismatched or genuinely unknown.
Co-location is tri-state from the DT centroid distance (≤250 m = co-located, >250 m = apart, no GPS =
unknown). **Methodology floor:** when *only* soft penalties apply (no hard contradiction), confidence
floors at **Medium** — the gap is real, only the attribution precision is limited; hard penalties
(PHY-unavailable, PRB/RF contradictions) bypass the floor and can force **Low**. Label:
**≤45 Low · ≤75 Medium · else High**. Reasons render as **"penalties: …"**, never "High because <negative>".

## 8. Directional flag
`directional = true` when the download is short (`<minDlDurationSec`) **or** throughput/RF samples are
thin. The conclusion then states *"Treat as directional, not statistically firm…"*. (n=1 DTs are
directional by nature; see CLAUDE.md gotcha #6.)

## 9. Output schema (`diagnoseMacro` → `{ references, diagnosis }`)
```
references: { bestThroughput, bestTechnical, bestCapacity, bestRf, bestBler }
diagnosis: {
  primaryCode, primaryLabel, severity, gapPct, gapMbps,
  context[      {code, message} ],   // segment conditions — NOT a root cause
  evidence[     {kpi, iamValue, refValue, diff, interpretation} ],
  secondary[    {code, label, detail} ],   // contributors (incl. scheduler/BLER)
  symptoms[     {code, label, message} ],  // e.g. modulation when explained upstream
  blockedCauses[{code, message} ],   // rules deliberately not fired, with reason
  warnings[     {code, message, operator} ],  // incl. enDcStability, PRB/RF contradictions
  directional,  action[],
  confidence{ label, score, reasons[] },
  efficiencyInsight, consistency, conclusionText
}
```

## 9b. Expanded-KPI acceptance (5G/n78 segment, e.g. Mohammedia)
Primary **N78_RETENTION_BANDWIDTH_LIMITATION**, Optimization opportunity, capacity ref = INWI, RF ref =
IAM (→ RF blocked), scheduler secondary, Server/TCP blocked. Confidence **Low** on the real data (PRB
contradiction is a hard penalty); a segment without that contradiction floors at **Medium**.

## 9c. Validity & presentation refinements
- **Label:** when the combined cause is primary AND n78 continuity is stable (`n78DropCount === 0`),
  the label reads **"n78 usage share / active NR bandwidth limitation"** (vs "…retention…"). Evidence
  reports n78 **share** and n78 **continuity** separately, and does not imply a drop/instability when
  drop count is 0.
- **Scheduler under PRB warning:** the ref-relative scheduler/PRB signal is shown as a **warning**
  (`schedulerLowConfidence`), not a firm secondary, when `prbConsistencyWarning` is active.
- **Invalid-zero KPIs:** MCS = 0 while CQI/rank/modulation are valid → MCS is set to `—` and excluded;
  delivery = 0 for **all** operators while DL>0 → delivery `—` and excluded.
- **Bandwidth columns:** Observed **Aggregated BW** (CA total) vs **NR configured** vs **NR active**.
  The active-bandwidth root-cause evidence uses **NR active BW**.
- **Table cell:** the IAM conclusion cell shows only label · severity · gap · confidence; the full
  explanation lives in the evidence drawer (“Full explanation”).

## 10. Worked example — DT7 Kenitra (LTE-only)
`lteOnly` → `context = [LTE_ONLY_SEGMENT, PHY_METRICS_UNAVAILABLE]`; 5G/n78 blocked; RF fires
(IAM SINR 2.1 vs INWI 8.6, gap 6.5>3) → **primary `LTE_RF_COVERAGE_QUALITY_LIMITATION`**; PHY rules
skipped (`metricsUnavailable`, shown "—"); byte-vs-curve would trip server/TCP but it is **blocked**
(radio cause present); best refs **INWI/INWI** (LTE scoring); **directional** (8 RF samples);
confidence **Low** (RF samples −20, byte −15, PHY −25 + cap, device/location). Verdict reads:

> Significant degradation: IAM is 71% (120 Mbps) behind INWI. **Context:** LTE-only benchmark — no
> operator used 5G/n78… PHY KPIs not exported, shown "—". **Primary root cause:** LTE RF quality
> limitation vs best operator (IAM SS-SINR/RSRP weaker than INWI). Server/TCP blocked (radio cause
> first). Treat as directional. Confidence Low — penalties: few RF samples; byte-vs-curve 32%; PHY
> unavailable; device parity unknown; same-location unknown.

## 11. Thresholds (`MACRO_DEFAULT_THRESHOLDS`, editable + localStorage profile)
`atParGapPct 10 · closeGapPct 20 · moderateGapPct 35 · minDlDurationSec 20 · minThroughputSamples 10
· minRfSamples 10 · maxByteVsCurveDeltaPct 15 · minNrDwellPct 5 · lowNrDwellPct 30 · minN78DwellPct 5
· n78GapPts 10 · sinrGapDb 3 · rsrpGapDb 6 · poorSinrDb 5 · poorRsrpDbm −110 · bandwidthGapPct 20 ·
scellGapCount 1 · rankGap 0.5 · qam256GapPts 15 · highPrbPct 80 · lowPrbPct 15 · seGapPct 20 ·
lowConfidenceMaxScore 45 · mediumConfidenceMaxScore 75`

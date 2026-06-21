(function (root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.BenchmarkNemoMacroState = Object.assign(
      {},
      root.BenchmarkNemoMacroState || {},
      api,
    );
  }
})(
  typeof globalThis !== "undefined" ? globalThis : this,
  function (root) {
    const STORAGE_KEY = "benchmarkNemoMacroThresholds";
    const OPERATOR_ORDER = ["IAM", "ORANGE", "INWI"];
    const RULE_ORDER = [
      "NO_VALID_DL_SESSION",
      "IAM_AT_PAR_OR_LEADING",
      "IAM_CLOSE_TO_BEST",
      "NO_5G_FOR_IAM",
      "LOW_5G_RETENTION",
      "NO_N78_CBAND",
      "N78_UNDER_USED",
      "RF_COVERAGE_QUALITY_LIMITATION",
      "LTE_RF_COVERAGE_QUALITY_LIMITATION",
      "ACTIVE_BANDWIDTH_LIMITATION",
      "CA_LIMITATION",
      "MIMO_RANK_LIMITATION",
      "MODULATION_LIMITATION",
      "CAPACITY_LOAD_LIMITATION",
      "SCHEDULER_ALLOCATION_LIMITATION",
      "SERVER_TCP_APPLICATION_LIMITATION",
      "LTE_ONLY_BENCHMARK_GAP",
      "MIXED_OR_INCONCLUSIVE",
    ];
    const TECHNICAL_WEIGHTS = {
      nrDwellPct: 0.3,
      n78Pct: 0.25,
      aggBwMhz: 0.15,
      ssSinrMean: 0.1,
      avgRank: 0.1,
      mod256Pct: 0.1,
    };
    const DT_TYPE_FACTORS = {
      Static: 1.0,
      Indoor: 0.7,
      Mobility: 0.8,
      Event: 0.7,
    };
    const DT_TYPE_NOTES = {
      Static: "Single-point directional DT with the strongest spatial comparability.",
      Mobility: "Directional result averaged over a route rather than one fixed point.",
      Indoor: "Indoor scope reduces the certainty of GPS-based co-location checks.",
      Event: "Event-driven DTs are directional and may not reflect steady-state network behavior.",
    };
    const MACRO_DEFAULT_THRESHOLDS = {
      atParGapPct: 10,
      closeGapPct: 20,
      moderateGapPct: 35,
      minDlDurationSec: 20,
      minThroughputSamples: 10,
      minRfSamples: 10,
      maxByteVsCurveDeltaPct: 15,
      minNrDwellPct: 5,
      lowNrDwellPct: 30,
      minN78DwellPct: 5,
      n78GapPts: 10,
      sinrGapDb: 3,
      rsrpGapDb: 6,
      poorSinrDb: 5,
      poorRsrpDbm: -110,
      bandwidthGapPct: 20,
      scellGapCount: 1,
      rankGap: 0.5,
      qam256GapPts: 15,
      highPrbPct: 80,
      lowPrbPct: 15,
      seGapPct: 20,
      lowConfidenceMaxScore: 45,
      mediumConfidenceMaxScore: 75,
    };

    function clone(value) {
      return JSON.parse(JSON.stringify(value));
    }

    function mergeDeep(base, extra) {
      const out = Array.isArray(base) ? base.slice() : { ...base };
      Object.keys(extra || {}).forEach((key) => {
        const next = extra[key];
        if (
          next &&
          typeof next === "object" &&
          !Array.isArray(next) &&
          out[key] &&
          typeof out[key] === "object" &&
          !Array.isArray(out[key])
        ) {
          out[key] = mergeDeep(out[key], next);
        } else {
          out[key] = next;
        }
      });
      return out;
    }

    function asNumber(value) {
      if (value === null || value === undefined || value === "") return null;
      const num = Number(value);
      return Number.isFinite(num) ? num : null;
    }

    function round1(value) {
      const num = asNumber(value);
      return num === null ? null : Number(num.toFixed(1));
    }

    function upper(value) {
      return String(value || "").trim().toUpperCase();
    }

    function operatorOrder(name) {
      const idx = OPERATOR_ORDER.indexOf(upper(name));
      return idx < 0 ? OPERATOR_ORDER.length : idx;
    }

    function formatNumber(value, digits) {
      const num = asNumber(value);
      if (num === null) return "—";
      return Number(num.toFixed(digits == null ? 1 : digits));
    }

    function normalizeThresholds(input) {
      return mergeDeep(clone(MACRO_DEFAULT_THRESHOLDS), input || {});
    }

    function loadMacroThresholds() {
      try {
        if (!root || !root.localStorage) {
          return clone(MACRO_DEFAULT_THRESHOLDS);
        }
        const raw = root.localStorage.getItem(STORAGE_KEY);
        return normalizeThresholds(raw ? JSON.parse(raw) : {});
      } catch (_error) {
        return clone(MACRO_DEFAULT_THRESHOLDS);
      }
    }

    function saveMacroThresholds(input) {
      const thresholds = normalizeThresholds(input);
      try {
        if (root && root.localStorage) {
          root.localStorage.setItem(STORAGE_KEY, JSON.stringify(thresholds));
        }
      } catch (_error) {
        // Ignore localStorage failures.
      }
      return thresholds;
    }

    function exportMacroProfile() {
      return JSON.stringify(loadMacroThresholds(), null, 2);
    }

    function importMacroProfile(json) {
      const parsed =
        typeof json === "string" ? JSON.parse(json) : json || {};
      return saveMacroThresholds(parsed);
    }

    function dlThroughput(op) {
      return (
        asNumber(op && op.dlSteadyMbps) ??
        asNumber(op && op.dlByteMbps) ??
        asNumber(op && op.dlAppRateMbps)
      );
    }

    function normalizeBandShares(raw) {
      const out = {};
      Object.keys(raw || {}).forEach((key) => {
        const value = asNumber(raw[key]);
        out[String(key).trim().toLowerCase()] = value == null ? 0 : value;
      });
      return out;
    }

    function getNested(source, path) {
      let value = source;
      for (let i = 0; i < path.length; i += 1) {
        if (!value || typeof value !== "object") return null;
        value = value[path[i]];
      }
      return value == null ? null : value;
    }

    function firstNumber(...values) {
      for (let i = 0; i < values.length; i += 1) {
        const num = asNumber(values[i]);
        if (num !== null) return num;
      }
      return null;
    }

    function buildBenchmarkNemoMacroPerOp(dataset) {
      const tlByMetric = ((dataset || {}).charts || {}).dlTimelineByMetric || {};
      const validity = (dataset && dataset.benchmarkValidity) || {};
      const deviceByOperator = validity.deviceByOperator || {};
      const operatorRows = (Array.isArray(dataset && dataset.operators)
        ? dataset.operators
        : []
      ).slice();
      const operators = Object.keys(tlByMetric)
        .concat(operatorRows.map((row) => row && row.operator))
        .filter(Boolean)
        .filter((value, index, array) => array.indexOf(value) === index)
        .sort((a, b) => operatorOrder(a) - operatorOrder(b));
      const out = {};
      operators.forEach((operator) => {
        const tl = tlByMetric[operator] || {};
        const evt = tl.downloadEventKpis || {};
        const download = ((tl.sessionStats || {}).download) || {};
        const opMeta = operatorRows.find(
          (row) => upper(row && row.operator) === upper(operator),
        );
        const opKpis = (opMeta && opMeta.kpis) || {};
        const nrBandDwellPct = normalizeBandShares(
          download.nrBandDwellPct ||
            evt.nrBandDwellPct ||
            getNested(opKpis, ["nrBandDwellPct"]) ||
            {},
        );
        const nrBands =
          String(download.nrBands || evt.nrBands || "").trim() ||
          (Object.keys(nrBandDwellPct).length
            ? Object.keys(nrBandDwellPct).sort().join("/")
            : "");
        const cqiFallback =
          getNested(opKpis, ["cqi", "median"]) ??
          getNested(opKpis, ["cqiMedian"]);
        const sinrFallback =
          getNested(opKpis, ["sinr", "median"]) ??
          getNested(opKpis, ["sinrMedian"]);
        const rsrpFallback =
          getNested(opKpis, ["rsrp", "median"]) ??
          getNested(opKpis, ["rsrpMedian"]);
        const prbFallback =
          getNested(opKpis, ["dlPrbUtilPct", "average"]) ??
          getNested(opKpis, ["prbAvg"]);
        out[upper(operator)] = {
          operator,
          dlSteadyMbps: firstNumber(
            evt.dlSteadyStateMbps,
            download.steadyStateMbps,
          ),
          dlByteMbps: firstNumber(
            evt.dlAppRateMbps,
            download.avgRateMbps,
            evt.dlAppTputMbps,
          ),
          dlAppRateMbps: firstNumber(
            evt.dlAppRateMbps,
            download.avgRateMbps,
            evt.dlAppTputMbps,
          ),
          dlDurationS: firstNumber(
            evt.downloadDurationAvgS,
            download.effTransferTimeS,
            download.downloadDurationAvgS,
          ),
          activeSlotCount: firstNumber(
            evt.activeSlotCount,
            download.activeSlotCount,
          ),
          throughputSamples: firstNumber(
            download.throughputSamples,
            evt.throughputSamples,
            evt.activeSlotCount,
            download.activeSlotCount,
          ),
          rfSamples: firstNumber(
            download.rfSamples,
            evt.rfSamples,
            evt.rfSampleCount,
            download.rfSampleCount,
          ),
          byteVsCurveDeltaPct: firstNumber(
            download.byteVsCurveDeltaPct,
            evt.byteVsCurveDeltaPct,
          ),
          nrDwellPct: firstNumber(
            download.nrDwellPct,
            evt.nrDwellPct,
          ),
          nrRoutePresencePct: firstNumber(
            download.nrRoutePresencePct,
            evt.nrRoutePresencePct,
          ),
          nrBandDwellPct,
          nrBands: nrBands || null,
          mod256Pct: firstNumber(download.mod256Pct, evt.mod256Pct),
          avgRank: firstNumber(download.avgRank, evt.avgRank),
          aggBwMhz: firstNumber(
            download.aggBwMhz,
            download.bwMHz,
            evt.aggBwMhz,
            evt.bwMHz,
          ),
          scellCount: firstNumber(download.scellCount, evt.scellCount),
          prbPct: firstNumber(download.prbUtilMean, evt.prbUtilMean, prbFallback),
          spectralEffMbpsPerMhz: firstNumber(
            download.spectralEffMbpsPerMhz,
            download.mbpsPerMHz,
            evt.spectralEffMbpsPerMhz,
            evt.mbpsPerMHz,
          ),
          ssRsrpMean: firstNumber(download.ssRsrpMean, evt.ssRsrpMean, rsrpFallback),
          ssSinrMean: firstNumber(download.ssSinrMean, evt.ssSinrMean, sinrFallback),
          loadState: String(download.loadState || evt.loadState || "").toLowerCase(),
          slowStartDominated: Boolean(
            evt.dlSlowStartDominated ?? download.slowStartDominated,
          ),
          deliveryEfficiencyPct: firstNumber(
            download.deliveryEfficiencyPct,
            evt.deliveryEfficiencyPct,
          ),
          schedulerYield: firstNumber(
            download.schedulerYield,
            download.schedulerYieldMbpsPerPrbPct,
            evt.schedulerYield,
            evt.schedulerYieldMbpsPerPrbPct,
          ),
          cqiMean: firstNumber(download.cqiMean, evt.cqiMean, cqiFallback),
          avgMcs: firstNumber(download.avgMcs, evt.avgMcs),
          dlCentroid: download.dlCentroid || evt.dlCentroid || null,
          dlMedianSpeedKmh: firstNumber(
            download.dlMedianSpeedKmh,
            evt.dlMedianSpeedKmh,
          ),
          deviceModel:
            deviceByOperator[operator] ||
            (opMeta && opMeta.deviceModel) ||
            null,
          rfConsistencyIssues:
            evt.rfConsistencyIssues ||
            download.rfConsistencyIssues ||
            [],
        };
      });
      return out;
    }

    function metricNormalize(allRows, getter) {
      const values = allRows
        .map(getter)
        .map(asNumber)
        .filter((value) => value !== null);
      const min = values.length ? Math.min(...values) : null;
      const max = values.length ? Math.max(...values) : null;
      return function (row) {
        const value = asNumber(getter(row));
        if (value === null) return 0;
        if (min === null || max === null || max === min) return 1;
        return (value - min) / (max - min);
      };
    }

    function selectMacroReferences(perOp) {
      const allRows = Object.values(perOp || {}).filter(Boolean);
      const competitors = allRows.filter(
        (row) => upper(row.operator) !== "IAM" && dlThroughput(row) !== null,
      );
      const bestThroughputCompetitor = competitors.length
        ? competitors
            .slice()
            .sort((a, b) => dlThroughput(b) - dlThroughput(a))[0]
        : null;
      // LTE-only segment: no operator has meaningful 5G, so NR/n78/BW/rank are absent or
      // stale. Score the technical reference on the LTE-relevant KPIs (SINR + RSRP + DL +
      // CQI + 256QAM) instead — otherwise a weaker competitor can win on a phantom NR metric.
      const lteOnly = !allRows.some(
        (row) =>
          (asNumber(row.nrDwellPct) || 0) >= 5 ||
          (asNumber(row.nrRoutePresencePct) || 0) >= 5,
      );
      const normSinr = metricNormalize(allRows, (row) => row.ssSinrMean);
      const normMod256 = metricNormalize(allRows, (row) => row.mod256Pct);
      if (lteOnly) {
        const normRsrp = metricNormalize(allRows, (row) => row.ssRsrpMean);
        const normDl = metricNormalize(allRows, (row) => dlThroughput(row));
        const normCqi = metricNormalize(allRows, (row) => row.cqiMean);
        competitors.forEach((row) => {
          row._macroTechScore =
            0.35 * normSinr(row) +
            0.25 * normRsrp(row) +
            0.2 * normDl(row) +
            0.1 * normCqi(row) +
            0.1 * normMod256(row);
        });
      } else {
        const normNrDwell = metricNormalize(allRows, (row) => row.nrDwellPct);
        const normN78 = metricNormalize(
          allRows,
          (row) => (row.nrBandDwellPct || {}).n78,
        );
        const normBw = metricNormalize(allRows, (row) => row.aggBwMhz);
        const normRank = metricNormalize(allRows, (row) => row.avgRank);
        competitors.forEach((row) => {
          row._macroTechScore =
            TECHNICAL_WEIGHTS.nrDwellPct * normNrDwell(row) +
            TECHNICAL_WEIGHTS.n78Pct * normN78(row) +
            TECHNICAL_WEIGHTS.aggBwMhz * normBw(row) +
            TECHNICAL_WEIGHTS.ssSinrMean * normSinr(row) +
            TECHNICAL_WEIGHTS.avgRank * normRank(row) +
            TECHNICAL_WEIGHTS.mod256Pct * normMod256(row);
        });
      }
      const bestTechnicalCompetitor = competitors.length
        ? competitors
            .slice()
            .sort((a, b) => (b._macroTechScore || 0) - (a._macroTechScore || 0))[0]
        : bestThroughputCompetitor;
      return { bestThroughputCompetitor, bestTechnicalCompetitor };
    }

    function detectDtType(perOp, manualOverride) {
      const raw = String(manualOverride || "").trim();
      if (raw && raw !== "Auto") return raw;
      const iam = perOp && perOp.IAM;
      if (!iam) return "Static";
      const speed = asNumber(iam.dlMedianSpeedKmh);
      if (speed === null) {
        return iam.dlCentroid ? "Static" : "Indoor";
      }
      if (speed > 15) return "Mobility";
      if (speed < 3) return "Static";
      return "Static";
    }

    function distanceScore(iam, peer) {
      if (
        !iam ||
        !peer ||
        !iam.dlCentroid ||
        !peer.dlCentroid ||
        asNumber(iam.dlCentroid.lat) === null ||
        asNumber(iam.dlCentroid.lon) === null ||
        asNumber(peer.dlCentroid.lat) === null ||
        asNumber(peer.dlCentroid.lon) === null
      ) {
        return null;
      }
      const toRad = (deg) => (deg * Math.PI) / 180;
      const lat1 = toRad(iam.dlCentroid.lat);
      const lon1 = toRad(iam.dlCentroid.lon);
      const lat2 = toRad(peer.dlCentroid.lat);
      const lon2 = toRad(peer.dlCentroid.lon);
      const dLat = lat2 - lat1;
      const dLon = lon2 - lon1;
      const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
      return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    function labelForSeverity(gapPct, thresholds) {
      if (gapPct === null) return "Directional";
      if (gapPct <= thresholds.atParGapPct) return "None";
      if (gapPct <= thresholds.closeGapPct) return "Optimization opportunity";
      if (gapPct <= thresholds.moderateGapPct) return "Moderate gap";
      return "Significant degradation";
    }

    function ruleDefinition(code) {
      const defs = {
        NO_VALID_DL_SESSION: {
          label: "No valid DL session",
          action:
            "Re-run the DT with a valid download session before using macro automation.",
        },
        IAM_AT_PAR_OR_LEADING: {
          label: "IAM at par / leading",
          action:
            "No macro DL action from this directional DT alone; validate on more DTs before tuning.",
        },
        IAM_CLOSE_TO_BEST: {
          label: "IAM close to best competitor",
          action:
            "Treat this as an optimization opportunity, not a failure; use the evidence chain to prioritize small gains.",
        },
        NO_5G_FOR_IAM: {
          label: "No 5G for IAM during DL",
          action:
            "Validate 5G availability on the tested path before deeper scheduler or modulation analysis.",
        },
        LOW_5G_RETENTION: {
          label: "5G / EN-DC retention limitation",
          action:
            "Improve EN-DC retention and NR persistence during the active download window.",
        },
        NO_N78_CBAND: {
          label: "No C-Band n78 usage",
          action:
            "Enable or recover n78 usage on the tested path before downstream capacity tuning.",
        },
        N78_UNDER_USED: {
          label: "n78 C-Band under-used",
          action:
            "Improve n78 selection and persistence so IAM stays on C-Band during the active download.",
        },
        RF_COVERAGE_QUALITY_LIMITATION: {
          label: "Coverage / quality limitation",
          action:
            "Prioritize RF coverage and quality optimization before scheduler or throughput policy changes.",
        },
        LTE_RF_COVERAGE_QUALITY_LIMITATION: {
          label: "LTE RF quality limitation vs best operator",
          action:
            "LTE-only segment (no 5G for any operator): check IAM's LTE serving layer — coverage footprint, azimuth/tilt, overshooting, interference, PCI/RS pollution and serving-cell selection at the DT centroid. Separately verify whether 5G/n78 should exist here.",
        },
        LTE_ONLY_BENCHMARK_GAP: {
          label: "LTE-only benchmark gap",
          action:
            "No 5G detected for any operator in this DT segment; treat as an LTE performance gap and diagnose with LTE RF / CQI / modulation / bandwidth / load / scheduler, not 5G/n78 causes.",
        },
        ACTIVE_BANDWIDTH_LIMITATION: {
          label: "Active bandwidth limitation",
          action:
            "Increase the usable active bandwidth during download before chasing deeper layer tuning.",
        },
        CA_LIMITATION: {
          label: "CA / SCell limitation",
          action:
            "Recover CA/SCell activation and secondary-layer usage during the active download.",
        },
        MIMO_RANK_LIMITATION: {
          label: "MIMO / rank limitation",
          action:
            "Improve rank utilization and beamforming once RF is comparable.",
        },
        MODULATION_LIMITATION: {
          label: "Modulation limitation",
          action:
            "Improve CQI-to-MCS efficiency and 256QAM usage once RF is comparable.",
        },
        CAPACITY_LOAD_LIMITATION: {
          label: "Capacity / load limitation",
          action:
            "Investigate cell load or add capacity on the active serving layer.",
        },
        SCHEDULER_ALLOCATION_LIMITATION: {
          label: "Scheduler / allocation limitation",
          action:
            "Investigate scheduler allocation yield, PRB grant behavior, and active-layer policy.",
        },
        SERVER_TCP_APPLICATION_LIMITATION: {
          label: "Server / TCP / application limitation",
          action:
            "Retest with a longer transfer or cleaner application path before treating radio as the main root cause.",
        },
        MIXED_OR_INCONCLUSIVE: {
          label: "Mixed / inconclusive",
          action:
            "Use the evidence chain and repeat DTs to separate methodology effects from network causes.",
        },
      };
      return defs[code] || defs.MIXED_OR_INCONCLUSIVE;
    }

    function mapCausalBreakToMacroCode(causalBreak, iam, thresholds) {
      const text = String(causalBreak || "").toLowerCase();
      if (!text) return "";
      if (text.includes("aggregated bandwidth") || text.includes("bandwidth")) {
        return "ACTIVE_BANDWIDTH_LIMITATION";
      }
      if (text.includes("resource scheduling") || text.includes("prb")) {
        return asNumber(iam && iam.prbPct) !== null &&
          iam.prbPct >= thresholds.highPrbPct
          ? "CAPACITY_LOAD_LIMITATION"
          : "SCHEDULER_ALLOCATION_LIMITATION";
      }
      if (text.includes("spectral efficiency") || text.includes("modulation")) {
        return "MODULATION_LIMITATION";
      }
      if (
        text.includes("rf quality") ||
        text.includes("sinr") ||
        text.includes("channel feedback")
      ) {
        return "RF_COVERAGE_QUALITY_LIMITATION";
      }
      if (text.includes("not explained") || text.includes("tcp")) {
        return "SERVER_TCP_APPLICATION_LIMITATION";
      }
      return "";
    }

    function ruleIndex(code) {
      const idx = RULE_ORDER.indexOf(code);
      return idx < 0 ? RULE_ORDER.length : idx;
    }

    function pushEvidence(bucket, kpi, iamValue, refValue, diff, interpretation) {
      bucket.push({
        kpi,
        iamValue: iamValue == null ? null : round1(iamValue),
        refValue: refValue == null ? null : round1(refValue),
        diff: diff == null ? null : round1(diff),
        interpretation,
      });
    }

    function buildConclusion(ctx, diagnosis) {
      const iam = ctx.iam;
      const bestThroughput = ctx.bestThroughput;
      const bestTechnical = ctx.bestTechnical;
      const severity = diagnosis.severity || "Directional";
      const label = diagnosis.primaryLabel || "Mixed / inconclusive";
      const pieces = [];
      pieces.push(
        severity +
          ": IAM is " +
          (diagnosis.gapPct == null
            ? "directional versus peers"
            : formatNumber(diagnosis.gapPct, 1) +
              "% (" +
              formatNumber(diagnosis.gapMbps, 0) +
              " Mbps) behind " +
              ((bestThroughput && bestThroughput.operator) || "the best competitor") +
              "."),
      );
      pieces.push("Primary macro diagnosis: " + label + ".");
      if (diagnosis.primaryCode === "N78_UNDER_USED") {
        pieces.push(
          "IAM extracts fewer Mbps mainly because it spends less of the active download on n78 C-Band than " +
            ((bestTechnical && bestTechnical.operator) || "the technical reference") +
            ".",
        );
      } else if (diagnosis.primaryCode === "ACTIVE_BANDWIDTH_LIMITATION") {
        pieces.push(
          "The active-download bandwidth available to IAM stays below the technical reference.",
        );
      } else if (diagnosis.primaryCode === "RF_COVERAGE_QUALITY_LIMITATION") {
        pieces.push(
          "RF quality is materially worse for IAM during the active download window.",
        );
      } else if (diagnosis.primaryCode === "LTE_RF_COVERAGE_QUALITY_LIMITATION") {
        pieces.push(
          "No 5G/n78 was detected for any operator on this DT segment, so this is an LTE-only gap — not 'No 5G for IAM'. The most likely cause is weaker LTE RF quality for IAM versus " +
            ((bestTechnical && bestTechnical.operator) || "the best operator") +
            " (lower SS-SINR / RSRP), which is consistent with the lower throughput.",
        );
      } else if (diagnosis.primaryCode === "LTE_ONLY_BENCHMARK_GAP") {
        pieces.push(
          "No 5G was detected for any operator on this DT segment; this is an LTE-only benchmark gap, not an IAM-specific 5G/n78 problem.",
        );
      } else if (diagnosis.primaryCode === "IAM_CLOSE_TO_BEST") {
        pieces.push(
          "This is framed as an optimization opportunity rather than a hard failure.",
        );
      }
      if (diagnosis.efficiencyInsight) {
        const eff = diagnosis.efficiencyInsight;
        pieces.push(
          "Per-MHz efficiency is " +
            formatNumber(eff.iamValue, 2) +
            " versus " +
            formatNumber(eff.referenceValue, 2) +
            " bps/Hz for " +
            (eff.referenceOperator || "the reference") +
            ", so the gap is not explained by poorer spectral efficiency alone.",
        );
      }
      if (Array.isArray(diagnosis.blockedCauses) && diagnosis.blockedCauses.length) {
        pieces.push(
          diagnosis.blockedCauses
            .map((item) => item.message)
            .join(" "),
        );
      }
      if (diagnosis.confidence) {
        pieces.push(
          diagnosis.confidence.reasons.length
            ? "Confidence " +
                diagnosis.confidence.label +
                " — penalties: " +
                diagnosis.confidence.reasons.join("; ") +
                "."
            : "Confidence " + diagnosis.confidence.label + ".",
        );
      }
      if (iam && iam.deviceModel && ctx.devicesComparable === false) {
        pieces.push("Devices differ across operators, so keep the result directional.");
      }
      return pieces.join(" ");
    }

    function scoreMacroConfidence(ctx, thresholds) {
      const iam = ctx.iam;
      const reasons = [];
      let score = 100;
      const warnings = ctx.warnings || [];
      if (asNumber(iam && iam.dlDurationS) !== null && iam.dlDurationS < thresholds.minDlDurationSec) {
        score -= 25;
        reasons.push(
          "short DL (" + formatNumber(iam.dlDurationS, 1) + " s)",
        );
      }
      if (
        asNumber(iam && iam.throughputSamples) !== null &&
        iam.throughputSamples < thresholds.minThroughputSamples
      ) {
        score -= 20;
        reasons.push(
          "few throughput samples (" + formatNumber(iam.throughputSamples, 0) + ")",
        );
      }
      if (
        asNumber(iam && iam.rfSamples) !== null &&
        iam.rfSamples < thresholds.minRfSamples
      ) {
        score -= 20;
        reasons.push(
          "few RF samples (" + formatNumber(iam.rfSamples, 0) + ")",
        );
      }
      if (
        asNumber(iam && iam.byteVsCurveDeltaPct) !== null &&
        iam.byteVsCurveDeltaPct > thresholds.maxByteVsCurveDeltaPct
      ) {
        score -= 15;
        reasons.push(
          "byte-vs-curve delta " +
            formatNumber(iam.byteVsCurveDeltaPct, 1) +
            "% exceeds " +
            thresholds.maxByteVsCurveDeltaPct +
            "%",
        );
      }
      if (iam && iam.metricsUnavailable) {
        score -= 25;
        reasons.push("NR/PHY resource metrics unavailable or invalid (CQI/MCS/rank/BW/PRB)");
      }
      const prbWarning = warnings.find((item) => item.code === "prbConsistencyWarning");
      const rfWarning = warnings.find((item) => item.code === "rfThroughputContradiction");
      if (prbWarning) {
        score -= 20;
        reasons.push(prbWarning.message);
      }
      if (rfWarning) {
        score -= 15;
        reasons.push(rfWarning.message);
      }
      if (ctx.devicesComparable !== true) {
        score -= 10;
        reasons.push("device parity unknown or mismatched");
      }
      if (ctx.sameLocationKnown !== true) {
        score -= 15;
        reasons.push("same-location comparability unknown");
      }
      score = Math.max(0, Math.min(100, score));
      if (prbWarning || rfWarning) {
        score = Math.min(score, thresholds.lowConfidenceMaxScore);
      }
      // Missing/invalid PHY metrics cap confidence at Medium — the throughput gap can be
      // clear while the detailed technical attribution stays uncertain.
      if (iam && iam.metricsUnavailable) {
        score = Math.min(score, thresholds.mediumConfidenceMaxScore);
      }
      const label =
        score <= thresholds.lowConfidenceMaxScore
          ? "Low"
          : score <= thresholds.mediumConfidenceMaxScore
            ? "Medium"
            : "High";
      return { score, label, reasons };
    }

    function diagnoseMacro(perOp, ctx, thresholdsInput) {
      const thresholds = normalizeThresholds(thresholdsInput);
      const iam = perOp && perOp.IAM;
      const refs = selectMacroReferences(perOp);
      const bestThroughput = refs.bestThroughputCompetitor;
      const bestTechnical = refs.bestTechnicalCompetitor || bestThroughput;
      const iamDl = dlThroughput(iam);
      const refDl = dlThroughput(bestThroughput);
      const gapPct =
        iamDl !== null && refDl !== null && refDl > 0
          ? round1(((refDl - iamDl) / refDl) * 100)
          : null;
      const gapMbps =
        iamDl !== null && refDl !== null
          ? round1(refDl - iamDl)
          : null;
      const severity = labelForSeverity(gapPct, thresholds);
      const evidence = [];
      const secondary = [];
      const blockedCauses = [];
      const warnings = [];
      const actions = [];
      const matches = [];

      function addMatch(code, detail) {
        const rule = ruleDefinition(code);
        matches.push({
          code,
          label: rule.label,
          action: rule.action,
          detail: detail || "",
        });
      }

      function addBlockedCause(code, message) {
        blockedCauses.push({ code, message });
      }

      function addWarning(code, message, operator) {
        warnings.push({ code, message, operator: operator || null });
      }

      const routeN78 = asNumber(iam && iam.nrBandDwellPct && iam.nrBandDwellPct.n78) || 0;
      const refN78 =
        asNumber(bestTechnical && bestTechnical.nrBandDwellPct && bestTechnical.nrBandDwellPct.n78) ||
        0;
      const sinrGap =
        asNumber(bestTechnical && bestTechnical.ssSinrMean) !== null &&
        asNumber(iam && iam.ssSinrMean) !== null
          ? bestTechnical.ssSinrMean - iam.ssSinrMean
          : null;
      const rsrpGap =
        asNumber(bestTechnical && bestTechnical.ssRsrpMean) !== null &&
        asNumber(iam && iam.ssRsrpMean) !== null
          ? bestTechnical.ssRsrpMean - iam.ssRsrpMean
          : null;
      const rfComparable =
        sinrGap !== null &&
        rsrpGap !== null &&
        Math.abs(sinrGap) <= thresholds.sinrGapDb &&
        Math.abs(rsrpGap) <= thresholds.rsrpGapDb;
      const iamRfPoor =
        (asNumber(iam && iam.ssSinrMean) !== null &&
          iam.ssSinrMean < thresholds.poorSinrDb) ||
        (asNumber(iam && iam.ssRsrpMean) !== null &&
          iam.ssRsrpMean < thresholds.poorRsrpDbm);
      const iamRfWorse =
        (sinrGap !== null && sinrGap > thresholds.sinrGapDb) ||
        (rsrpGap !== null && rsrpGap > thresholds.rsrpGapDb);
      const iamRfAtLeastAsGood =
        asNumber(iam && iam.ssSinrMean) !== null &&
        asNumber(iam && iam.ssRsrpMean) !== null &&
        asNumber(bestTechnical && bestTechnical.ssSinrMean) !== null &&
        asNumber(bestTechnical && bestTechnical.ssRsrpMean) !== null &&
        iam.ssSinrMean >= bestTechnical.ssSinrMean &&
        iam.ssRsrpMean >= bestTechnical.ssRsrpMean;
      const allRows = Object.values(perOp || {}).filter(Boolean);
      const allZeroScells =
        allRows.length > 0 &&
        allRows.every((row) => (asNumber(row.scellCount) || 0) === 0);
      const bwGapPct =
        asNumber(iam && iam.aggBwMhz) !== null &&
        asNumber(bestTechnical && bestTechnical.aggBwMhz) !== null &&
        bestTechnical.aggBwMhz > 0
          ? round1(
              ((bestTechnical.aggBwMhz - iam.aggBwMhz) / bestTechnical.aggBwMhz) *
                100,
            )
          : null;
      const scellGap =
        asNumber(iam && iam.scellCount) !== null &&
        asNumber(bestTechnical && bestTechnical.scellCount) !== null
          ? round1(bestTechnical.scellCount - iam.scellCount)
          : null;
      const rankGap =
        asNumber(bestTechnical && bestTechnical.avgRank) !== null &&
        asNumber(iam && iam.avgRank) !== null
          ? round1(bestTechnical.avgRank - iam.avgRank)
          : null;
      const qamGap =
        asNumber(bestTechnical && bestTechnical.mod256Pct) !== null &&
        asNumber(iam && iam.mod256Pct) !== null
          ? round1(bestTechnical.mod256Pct - iam.mod256Pct)
          : null;
      const seGapPct =
        asNumber(bestThroughput && bestThroughput.spectralEffMbpsPerMhz) !== null &&
        asNumber(iam && iam.spectralEffMbpsPerMhz) !== null &&
        bestThroughput.spectralEffMbpsPerMhz > 0
          ? round1(
              ((bestThroughput.spectralEffMbpsPerMhz - iam.spectralEffMbpsPerMhz) /
                bestThroughput.spectralEffMbpsPerMhz) *
                100,
            )
          : null;
      const goodRf =
        asNumber(iam && iam.ssSinrMean) !== null &&
        asNumber(iam && iam.ssRsrpMean) !== null &&
        iam.ssSinrMean >= thresholds.poorSinrDb &&
        iam.ssRsrpMean >= thresholds.poorRsrpDbm;

      // LTE-only segment: no operator reached the 5G-dwell floor (active window OR route).
      // Then "No 5G for IAM" / "No n78" are context conditions, not IAM-specific causes.
      const operatorHas5g = (row) =>
        (asNumber(row && row.nrDwellPct) || 0) >= thresholds.minNrDwellPct ||
        (asNumber(row && row.nrRoutePresencePct) || 0) >= thresholds.minNrDwellPct;
      const lteOnly = allRows.length > 0 && !allRows.some(operatorHas5g);
      const competitorHas5g = allRows.some(
        (row) => upper(row.operator) !== "IAM" && operatorHas5g(row),
      );
      // NR/PHY resource KPIs are unavailable (all zero) yet IAM downloaded data → the
      // zeros are "not exported", not real. Don't let them drive MIMO/modulation/load.
      const phyUnavailable =
        (asNumber(iam && iam.aggBwMhz) || 0) === 0 &&
        (asNumber(iam && iam.prbPct) || 0) === 0 &&
        (asNumber(iam && iam.avgRank) || 0) === 0 &&
        (asNumber(iam && iam.avgMcs) || 0) === 0 &&
        (dlThroughput(iam) || 0) > 0;
      if (iam) iam.metricsUnavailable = phyUnavailable;
      if (ctx) {
        ctx.lteOnly = lteOnly;
        ctx.phyUnavailable = phyUnavailable;
      }

      if (iam) {
        if (
          asNumber(iam.dlSteadyMbps) !== null &&
          asNumber(iam.prbPct) !== null &&
          iam.dlSteadyMbps > 300 &&
          iam.prbPct < 10
        ) {
          addWarning(
            "prbConsistencyWarning",
            "High throughput with very low PRB — PRB may not be aggregated across carriers/RATs.",
            "IAM",
          );
        }
      }

      [bestThroughput, bestTechnical]
        .filter(Boolean)
        .filter(
          (row, index, array) =>
            array.findIndex((item) => upper(item.operator) === upper(row.operator)) ===
            index,
        )
        .forEach((row) => {
          if (
            asNumber(row.dlSteadyMbps) !== null &&
            asNumber(row.ssSinrMean) !== null &&
            row.dlSteadyMbps > 400 &&
            row.ssSinrMean < 0
          ) {
            addWarning(
              "rfThroughputContradiction",
              row.operator +
                ": high throughput with negative SINR — verify RF export consistency.",
              row.operator,
            );
          }
        });

      allRows.forEach((row) => {
        if (
          asNumber(row.aggBwMhz) !== null &&
          asNumber(row.scellCount) !== null &&
          row.aggBwMhz > 50 &&
          row.scellCount === 0
        ) {
          addWarning(
            "bandwidthScellContradiction",
            row.operator +
              ": active bandwidth is high while SCell count is zero — confirm CA export coverage.",
            row.operator,
          );
        }
      });

      if (iamRfAtLeastAsGood) {
        addBlockedCause(
          "RF_COVERAGE_QUALITY_LIMITATION",
          "RF limitation blocked: IAM RF ≥ reference.",
        );
        pushEvidence(
          evidence,
          "RF comparability",
          iam.ssSinrMean,
          bestTechnical && bestTechnical.ssSinrMean,
          sinrGap == null ? null : -sinrGap,
          "RF >= reference: IAM SS-SINR " +
            formatNumber(iam.ssSinrMean, 1) +
            " dB and SS-RSRP " +
            formatNumber(iam.ssRsrpMean, 1) +
            " dBm are at least as good as " +
            ((bestTechnical && bestTechnical.operator) || "the technical reference") +
            ".",
        );
      }

      if (!iam || iamDl === null) {
        addMatch(
          "NO_VALID_DL_SESSION",
          "IAM has no valid steady or byte-based download throughput in this scope.",
        );
      } else if (gapPct !== null && gapPct <= thresholds.atParGapPct) {
        addMatch(
          "IAM_AT_PAR_OR_LEADING",
          "IAM is within " + thresholds.atParGapPct + "% of the best throughput reference.",
        );
        pushEvidence(
          evidence,
          "DL throughput gap",
          iamDl,
          refDl,
          gapPct,
          "IAM is at par or effectively leading within the directional tolerance band.",
        );
      } else {
        const closeToBest =
          gapPct !== null &&
          gapPct > thresholds.atParGapPct &&
          gapPct <= thresholds.closeGapPct;
        if (closeToBest) {
          addMatch(
            "IAM_CLOSE_TO_BEST",
            "Gap stays within the optimization-opportunity band; keep evaluating the reason.",
          );
        }

        if (lteOnly) {
          // No operator had 5G in this DT segment → absence of 5G/n78 is a shared context
          // condition, not an IAM-specific root cause. Block both and note the LTE-only mode.
          addBlockedCause(
            "NO_5G_FOR_IAM",
            "No 5G detected for any operator in this DT segment (LTE-only) — not IAM-specific.",
          );
          addBlockedCause(
            "NO_N78_CBAND",
            "No n78 / C-Band for any operator in this LTE-only segment — not IAM-specific.",
          );
          pushEvidence(
            evidence,
            "5G availability",
            iam.nrDwellPct,
            null,
            null,
            "LTE-only benchmark: no operator reached the 5G-dwell floor on this DT segment.",
          );
        } else {
          if (
            asNumber(iam.nrDwellPct) !== null &&
            asNumber(iam.nrRoutePresencePct) !== null &&
            iam.nrDwellPct < thresholds.minNrDwellPct &&
            iam.nrRoutePresencePct < thresholds.minNrDwellPct &&
            competitorHas5g
          ) {
            addMatch(
              "NO_5G_FOR_IAM",
              "IAM has almost no 5G during the active download while a competitor uses 5G.",
            );
            pushEvidence(
              evidence,
              "5G dwell",
              iam.nrDwellPct,
              iam.nrRoutePresencePct,
              iam.nrRoutePresencePct - iam.nrDwellPct,
              "No effective 5G for IAM while a competitor has 5G.",
            );
          } else if (
            asNumber(iam.nrDwellPct) !== null &&
            asNumber(iam.nrRoutePresencePct) !== null &&
            iam.nrDwellPct < thresholds.lowNrDwellPct &&
            iam.nrRoutePresencePct >= thresholds.lowNrDwellPct
          ) {
            addMatch(
              "LOW_5G_RETENTION",
              "5G is present on the route but not retained through the active download.",
            );
            pushEvidence(
              evidence,
              "5G retention",
              iam.nrDwellPct,
              iam.nrRoutePresencePct,
              iam.nrRoutePresencePct - iam.nrDwellPct,
              "Route NR presence exceeds active-download NR dwell, pointing to retention loss.",
            );
          }

          if (routeN78 < thresholds.minN78DwellPct && competitorHas5g && refN78 > 0) {
            addMatch(
              "NO_N78_CBAND",
              "IAM shows effectively no n78 usage while a competitor uses C-Band.",
            );
            pushEvidence(
              evidence,
              "n78 dwell",
              routeN78,
              refN78,
              refN78 - routeN78,
              "n78 C-Band is absent for IAM while a competitor uses it.",
            );
          } else if (refN78 - routeN78 > thresholds.n78GapPts) {
            addMatch(
              "N78_UNDER_USED",
              "IAM under-uses n78 compared with the best technical reference.",
            );
            pushEvidence(
              evidence,
              "n78 dwell",
              routeN78,
              refN78,
              refN78 - routeN78,
              "n78 dwell " +
                formatNumber(routeN78, 1) +
                "% vs " +
                formatNumber(refN78, 1) +
                "% shows under-used C-Band.",
            );
          }
        }

        if (iamRfPoor || iamRfWorse) {
          if (iamRfAtLeastAsGood) {
            addBlockedCause(
              "RF_COVERAGE_QUALITY_LIMITATION",
              "RF limitation blocked: IAM RF ≥ reference.",
            );
          } else {
            // In an LTE-only segment label this as the LTE RF limitation so the verdict
            // reads "LTE RF quality limitation vs best operator", not a generic NR-tinged one.
            const rfCode = lteOnly
              ? "LTE_RF_COVERAGE_QUALITY_LIMITATION"
              : "RF_COVERAGE_QUALITY_LIMITATION";
            addMatch(
              rfCode,
              lteOnly
                ? "LTE-only segment: IAM LTE RF quality is materially worse than the best operator."
                : "IAM RF quality is materially worse or objectively poor during download.",
            );
            pushEvidence(
              evidence,
              "RF quality",
              iam && iam.ssSinrMean,
              bestTechnical && bestTechnical.ssSinrMean,
              sinrGap,
              "RF gap indicates " +
                (lteOnly ? "LTE coverage / quality limitation." : "coverage / quality limitation."),
            );
          }
        }

        if (!phyUnavailable && bwGapPct !== null && bwGapPct >= thresholds.bandwidthGapPct) {
          addMatch(
            "ACTIVE_BANDWIDTH_LIMITATION",
            "IAM active bandwidth materially trails the technical reference.",
          );
          pushEvidence(
            evidence,
            "Active bandwidth",
            iam && iam.aggBwMhz,
            bestTechnical && bestTechnical.aggBwMhz,
            bwGapPct,
            "Active BW " +
              formatNumber(iam && iam.aggBwMhz, 1) +
              " MHz vs " +
              formatNumber(bestTechnical && bestTechnical.aggBwMhz, 1) +
              " MHz.",
          );
        }

        if (
          !phyUnavailable &&
          !allZeroScells &&
          scellGap !== null &&
          scellGap >= thresholds.scellGapCount
        ) {
          addMatch(
            "CA_LIMITATION",
            "Reference activates materially more SCells than IAM.",
          );
          pushEvidence(
            evidence,
            "SCell count",
            iam && iam.scellCount,
            bestTechnical && bestTechnical.scellCount,
            scellGap,
            "CA gap remains visible in active-download SCell count.",
          );
        }

        if (!phyUnavailable && rankGap !== null && rankGap > thresholds.rankGap) {
          if (rfComparable) {
            addMatch(
              "MIMO_RANK_LIMITATION",
              "Average rank trails the technical reference while RF is comparable.",
            );
            pushEvidence(
              evidence,
              "Average rank",
              iam && iam.avgRank,
              bestTechnical && bestTechnical.avgRank,
              rankGap,
              "MIMO rank gap persists after RF comparability check.",
            );
          } else {
            addBlockedCause(
              "MIMO_RANK_LIMITATION",
              "MIMO limitation blocked: RF is not comparable enough for a fair rank verdict.",
            );
          }
        }

        if (!phyUnavailable && qamGap !== null && qamGap > thresholds.qam256GapPts) {
          if (rfComparable) {
            addMatch(
              "MODULATION_LIMITATION",
              "256QAM usage trails the technical reference while RF is comparable.",
            );
            pushEvidence(
              evidence,
              "256QAM share",
              iam && iam.mod256Pct,
              bestTechnical && bestTechnical.mod256Pct,
              qamGap,
              "Modulation gap remains after the RF comparability check.",
            );
          } else {
            addBlockedCause(
              "MODULATION_LIMITATION",
              "Modulation limitation blocked: RF is not comparable enough for a fair modulation verdict.",
            );
          }
        }

        const prbWarningActive = warnings.some(
          (item) => item.code === "prbConsistencyWarning",
        );
        if (!phyUnavailable && asNumber(iam && iam.prbPct) !== null && iam.prbPct >= thresholds.highPrbPct) {
          if (prbWarningActive) {
            addBlockedCause(
              "CAPACITY_LOAD_LIMITATION",
              "Capacity/load blocked: PRB warning says the PRB metric may not aggregate across all carriers.",
            );
          } else {
            addMatch(
              "CAPACITY_LOAD_LIMITATION",
              "IAM PRB utilization is high enough to indicate capacity/load pressure.",
            );
            pushEvidence(
              evidence,
              "PRB utilization",
              iam && iam.prbPct,
              null,
              null,
              "High PRB suggests capacity or load limitation.",
            );
          }
        }

        if (
          !phyUnavailable &&
          goodRf &&
          asNumber(iam && iam.prbPct) !== null &&
          iam.prbPct < thresholds.lowPrbPct &&
          gapPct !== null &&
          gapPct > thresholds.closeGapPct
        ) {
          if (prbWarningActive) {
            addBlockedCause(
              "SCHEDULER_ALLOCATION_LIMITATION",
              "Scheduler limitation blocked: PRB may not be aggregated across carriers/RATs.",
            );
          } else {
            addMatch(
              "SCHEDULER_ALLOCATION_LIMITATION",
              "Gap remains with good RF but low PRB utilization, pointing to scheduler yield/allocation.",
            );
            pushEvidence(
              evidence,
              "Scheduler yield",
              iam && iam.schedulerYield,
              null,
              null,
              "Low PRB load with a remaining DL gap points to allocation efficiency rather than raw load.",
            );
          }
        }

        if (
          gapPct !== null &&
          gapPct > thresholds.atParGapPct &&
          (
            (asNumber(iam && iam.byteVsCurveDeltaPct) !== null &&
              iam.byteVsCurveDeltaPct > thresholds.maxByteVsCurveDeltaPct) ||
            iam.slowStartDominated ||
            (asNumber(iam && iam.deliveryEfficiencyPct) !== null &&
              iam.deliveryEfficiencyPct < 75)
          )
        ) {
          // A radio (RF) limitation explains the gap upstream of the application — and a
          // competitor reaching far higher throughput in the same context proves the server
          // can deliver more. So block server/TCP when RF is the detected limiter.
          const rfLimitationDetected = matches.some(
            (m) =>
              m.code === "RF_COVERAGE_QUALITY_LIMITATION" ||
              m.code === "LTE_RF_COVERAGE_QUALITY_LIMITATION",
          );
          if (rfLimitationDetected || iamRfPoor || iamRfWorse) {
            addBlockedCause(
              "SERVER_TCP_APPLICATION_LIMITATION",
              "Server / TCP blocked: a radio (RF) limitation is detected first, and a competitor reaches far higher throughput in the same context.",
            );
          } else {
            addMatch(
              "SERVER_TCP_APPLICATION_LIMITATION",
              "Application-layer behavior suggests the file transfer itself depresses the byte-based result.",
            );
            pushEvidence(
              evidence,
              "Byte vs curve delta",
              iam && iam.byteVsCurveDeltaPct,
              thresholds.maxByteVsCurveDeltaPct,
              null,
              "Large byte-vs-curve delta / slow start points to transfer-method effects.",
            );
          }
        }

        if (!matches.length) {
          // LTE-only segment with no clear LTE sub-cause → name it an LTE-only benchmark gap
          // rather than a generic "mixed / inconclusive".
          addMatch(
            lteOnly ? "LTE_ONLY_BENCHMARK_GAP" : "MIXED_OR_INCONCLUSIVE",
            lteOnly
              ? "No 5G for any operator and no dominant LTE sub-cause isolated; LTE-only performance gap."
              : "No single upstream macro cause dominated after the available checks.",
          );
        }
      }

      let primary = matches[0] || {
        code: "MIXED_OR_INCONCLUSIVE",
        ...ruleDefinition("MIXED_OR_INCONCLUSIVE"),
      };

      if (
        primary.code === "IAM_CLOSE_TO_BEST" &&
        matches.length > 1
      ) {
        primary = matches
          .slice(1)
          .sort((a, b) => ruleIndex(a.code) - ruleIndex(b.code))[0];
      }

      matches
        .filter((item) => item.code !== primary.code)
        .sort((a, b) => ruleIndex(a.code) - ruleIndex(b.code))
        .forEach((item) => {
          if (item.code === "IAM_CLOSE_TO_BEST" && primary.code !== "IAM_CLOSE_TO_BEST") {
            return;
          }
          secondary.push({
            code: item.code,
            label: item.label,
            detail: item.detail,
          });
        });

      const causalBreak = (((ctx || {}).causalChain || {}).breakPoint) || "";
      const suggestedCode = mapCausalBreakToMacroCode(causalBreak, iam, thresholds);
      const consistency = {
        aligned: true,
        causalBreak,
        note: "Macro verdict aligns with the detailed causal chain.",
      };
      if (
        suggestedCode &&
        primary.code &&
        ruleIndex(suggestedCode) < ruleIndex(primary.code)
      ) {
        secondary.unshift({
          code: primary.code,
          label: primary.label,
          detail: "Kept as secondary after the causal-chain guard promoted an upstream cause.",
        });
        primary = {
          code: suggestedCode,
          ...ruleDefinition(suggestedCode),
          detail:
            "Promoted upstream so the macro verdict does not contradict the detailed causal-chain break.",
        };
        consistency.aligned = false;
        consistency.note =
          "Macro verdict was pulled upstream to stay consistent with the detailed causal-chain break.";
      }

      const sameLocationMeters = distanceScore(iam, bestTechnical || bestThroughput);
      const confidence = scoreMacroConfidence(
        {
          iam,
          warnings,
          devicesComparable: ctx.devicesComparable,
          sameLocationKnown: sameLocationMeters !== null,
        },
        thresholds,
      );
      const efficiencyInsight =
        asNumber(iam && iam.spectralEffMbpsPerMhz) !== null &&
        asNumber(bestThroughput && bestThroughput.spectralEffMbpsPerMhz) !== null
          ? {
              iamValue: round1(iam.spectralEffMbpsPerMhz),
              referenceValue: round1(bestThroughput.spectralEffMbpsPerMhz),
              referenceOperator: bestThroughput && bestThroughput.operator,
              interpretation:
                iam.spectralEffMbpsPerMhz >
                bestThroughput.spectralEffMbpsPerMhz
                  ? "IAM extracts more Mbps per MHz than the throughput leader, so the gap points upstream to band/bandwidth usage rather than raw spectral efficiency."
                  : "IAM extracts fewer Mbps per MHz than the throughput leader, so spectral efficiency still contributes to the gap.",
            }
          : null;
      const diagnosis = {
        primaryCode: primary.code,
        primaryLabel: ruleDefinition(primary.code).label,
        severity,
        gapPct,
        gapMbps,
        evidence,
        secondary,
        blockedCauses,
        action: [ruleDefinition(primary.code).action],
        confidence,
        efficiencyInsight,
        warnings,
        consistency,
        conclusionText: "",
      };
      diagnosis.conclusionText = buildConclusion(
        {
          iam,
          bestThroughput,
          bestTechnical,
          devicesComparable: ctx.devicesComparable,
        },
        diagnosis,
      );
      return {
        references: {
          bestThroughput,
          bestTechnical,
        },
        diagnosis,
      };
    }

    function inferScope(dataset) {
      const explicit = String(
        (dataset && dataset.scopeLabel) ||
          (dataset && dataset.scope) ||
          "",
      ).trim();
      if (explicit) return explicit;
      const windowMode = String((dataset && dataset.windowMode) || "").trim();
      if (windowMode === "all_dt_session") return "All DTs";
      if (windowMode === "session_dl_active") return "Session DL active";
      if (windowMode === "download_only") return "Download only";
      return "All DTs";
    }

    function buildBenchmarkNemoMacroModel(dataset, options) {
      const perOp = buildBenchmarkNemoMacroPerOp(dataset);
      const thresholds = normalizeThresholds(
        (options && options.thresholds) || loadMacroThresholds(),
      );
      const validity = (dataset && dataset.benchmarkValidity) || {};
      const dtType = detectDtType(perOp, options && options.dtTypeOverride);
      const diagnosis = diagnoseMacro(
        perOp,
        {
          causalChain:
            ((dataset && dataset.macroContext) || {}).causalChain ||
            (((dataset && dataset.deepBenchmark) || {}).execSummary || {}).causalChain ||
            {},
          devicesComparable: validity.devicesComparable,
        },
        thresholds,
      );
      const references = diagnosis.references || {};
      const verdict = {
        dtId:
          (dataset && dataset.currentDtId) ||
          (dataset && dataset.dtId) ||
          null,
        dtType,
        scope: inferScope(dataset),
        operators: Object.values(perOp)
          .filter(Boolean)
          .sort((a, b) => operatorOrder(a.operator) - operatorOrder(b.operator)),
        references,
        diagnosis: diagnosis.diagnosis,
        warnings: diagnosis.diagnosis.warnings,
      };
      const rows = verdict.operators.map((row) => ({
        ...row,
        role:
          upper(row.operator) === upper(references.bestThroughput && references.bestThroughput.operator) &&
          upper(row.operator) === upper(references.bestTechnical && references.bestTechnical.operator)
            ? "throughput+technical"
            : upper(row.operator) === upper(references.bestThroughput && references.bestThroughput.operator)
              ? "throughput"
              : upper(row.operator) === upper(references.bestTechnical && references.bestTechnical.operator)
                ? "technical"
                : upper(row.operator) === "IAM"
                  ? "iam"
                  : "reference",
      }));
      return {
        available: rows.length > 0,
        perOp,
        rows,
        thresholds,
        dtType,
        verdict,
      };
    }

    return {
      MACRO_DEFAULT_THRESHOLDS,
      buildBenchmarkNemoMacroPerOp,
      buildBenchmarkNemoMacroModel,
      detectDtType,
      diagnoseMacro,
      exportMacroProfile,
      importMacroProfile,
      loadMacroThresholds,
      normalizeThresholds,
      saveMacroThresholds,
      scoreMacroConfidence,
      selectMacroReferences,
    };
  },
);

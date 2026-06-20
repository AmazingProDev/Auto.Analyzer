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
      "NO_DL",
      "AT_PAR",
      "NO_5G",
      "ENDC_RETENTION",
      "NO_N78",
      "N78_UNDERUSE",
      "COVERAGE",
      "CA_BW",
      "MIMO",
      "MODULATION",
      "LOAD",
      "SCHEDULER",
      "SERVER_TCP",
      "MIXED",
    ];
    const DT_TYPE_FACTORS = {
      Static: 1.0,
      Indoor: 0.7,
      Mobility: 0.8,
      Event: 0.7,
    };
    const DT_TYPE_NOTES = {
      Static: "Single-point result with the strongest spatial comparability.",
      Mobility: "RF reflects a route average more than one fixed point.",
      Indoor: "GPS-based location validity is reduced in this scope.",
      Event: "This result is event-specific rather than a stable steady-state sample.",
    };
    const MACRO_DEFAULT_THRESHOLDS = {
      atParGapPct: 10,
      no5gDwellPct: 5,
      retentionDropPts: 30,
      noN78DwellPct: 5,
      n78UnderusePts: 10,
      sinrGapDb: 3,
      rsrpGapDb: 6,
      caBwGapPct: 20,
      rankGap: 0.5,
      mod256GapPts: 15,
      prbLowPct: 15,
      prbHighPct: 80,
      serverTcpFloorMbps: null,
      techW: {
        sinr: 0.3,
        rank: 0.2,
        mod256: 0.2,
        n78: 0.15,
        aggBw: 0.15,
      },
      conf: {
        minDlSec: 8,
        minActiveSlots: 8,
        low: 0.5,
        high: 0.8,
      },
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
        return 0.5;
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
      const meters = 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      if (meters <= 150) return 1;
      if (meters <= 400) return 0.8;
      if (meters <= 900) return 0.6;
      return 0.4;
    }

    function normalizeBandShares(raw) {
      const out = {};
      Object.keys(raw || {}).forEach((key) => {
        out[String(key).trim().toLowerCase()] = asNumber(raw[key]) || 0;
      });
      return out;
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
        out[upper(operator)] = {
          operator,
          dlSteadyMbps: asNumber(evt.dlSteadyStateMbps ?? download.steadyStateMbps),
          dlByteMbps: asNumber(evt.dlAppRateMbps ?? download.avgRateMbps),
          dlDurationS: asNumber(evt.downloadDurationAvgS ?? download.effTransferTimeS),
          activeSlotCount: asNumber(evt.activeSlotCount ?? download.activeSlotCount),
          nrDwellPct: asNumber(download.nrDwellPct),
          nrRoutePresencePct: asNumber(
            download.nrRoutePresencePct ?? evt.nrRoutePresencePct,
          ),
          nrBandDwellPct: normalizeBandShares(download.nrBandDwellPct),
          mod256Pct: asNumber(download.mod256Pct),
          avgRank: asNumber(download.avgRank),
          aggBwMhz: asNumber(download.aggBwMhz ?? download.bwMHz),
          scellCount: asNumber(download.scellCount),
          prbPct: asNumber(download.prbUtilMean),
          spectralEffMbpsPerMhz: asNumber(
            download.spectralEffMbpsPerMhz ??
              download.mbpsPerMHz ??
              evt.mbpsPerMHz,
          ),
          ssRsrpMean: asNumber(download.ssRsrpMean),
          ssSinrMean: asNumber(download.ssSinrMean),
          loadState: String(download.loadState || evt.loadState || "").toLowerCase(),
          slowStartDominated: Boolean(
            evt.dlSlowStartDominated ?? download.slowStartDominated,
          ),
          deliveryEfficiencyPct: asNumber(download.deliveryEfficiencyPct),
          dlCentroid: download.dlCentroid || null,
          dlMedianSpeedKmh: asNumber(download.dlMedianSpeedKmh),
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

    function selectMacroReferences(perOp, thresholds) {
      const allRows = Object.values(perOp || {}).filter(Boolean);
      const competitors = allRows.filter(
        (row) => upper(row.operator) !== "IAM" && dlThroughput(row) !== null,
      );
      const bestThroughputCompetitor = competitors.length
        ? competitors.slice().sort((a, b) => dlThroughput(b) - dlThroughput(a))[0]
        : null;
      const w = (thresholds && thresholds.techW) || MACRO_DEFAULT_THRESHOLDS.techW;
      const normSinr = metricNormalize(allRows, (row) => row.ssSinrMean);
      const normRank = metricNormalize(allRows, (row) => row.avgRank);
      const normMod256 = metricNormalize(allRows, (row) => row.mod256Pct);
      const normN78 = metricNormalize(
        allRows,
        (row) => (row.nrBandDwellPct || {}).n78,
      );
      const normBw = metricNormalize(allRows, (row) => row.aggBwMhz);
      competitors.forEach((row) => {
        row._macroTechScore =
          w.sinr * normSinr(row) +
          w.rank * normRank(row) +
          w.mod256 * normMod256(row) +
          w.n78 * normN78(row) +
          w.aggBw * normBw(row);
      });
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

    function scoreMacroConfidence(perOp, ctx, thresholds) {
      const iam = perOp && perOp.IAM;
      const refs = selectMacroReferences(perOp, thresholds);
      const cTech = refs.bestTechnicalCompetitor;
      const validity = (ctx && ctx.validity) || {};
      const dtType = (ctx && ctx.dtType) || "Static";
      const conf = (thresholds && thresholds.conf) || MACRO_DEFAULT_THRESHOLDS.conf;
      const sameDevice = validity.devicesComparable;
      const dtCount = asNumber(validity.dtCount) || 1;
      const availabilityFields = ["ssSinrMean", "avgRank", "mod256Pct", "aggBwMhz", "prbPct"];
      const availableCount = availabilityFields.reduce((count, field) => {
        return count +
          (asNumber(iam && iam[field]) !== null && asNumber(cTech && cTech[field]) !== null
            ? 1
            : 0);
      }, 0);
      const factors = {
        dtCount: dtCount >= 4 ? 1 : dtCount >= 2 ? 0.7 : 0.4,
        dlDuration: iam && iam.dlDurationS ? Math.min(1, iam.dlDurationS / conf.minDlSec) : 0.4,
        validSamples:
          iam && iam.activeSlotCount
            ? Math.min(1, iam.activeSlotCount / conf.minActiveSlots)
            : 0.3,
        availability: availabilityFields.length
          ? availableCount / availabilityFields.length
          : 0.5,
        sameLocation: cTech ? distanceScore(iam, cTech) : 0.5,
        deviceParity:
          sameDevice === true ? 1 : sameDevice === false ? 0.5 : 0.6,
        dtType: DT_TYPE_FACTORS[dtType] || 0.8,
      };
      const reasons = [];
      if (factors.dtCount < 0.8) reasons.push("n=" + dtCount + " DT");
      if (factors.dlDuration < 0.8 && iam && iam.dlDurationS != null) {
        reasons.push("short " + formatNumber(iam.dlDurationS, 1) + " s transfer");
      }
      if (factors.validSamples < 0.8 && iam && iam.activeSlotCount != null) {
        reasons.push("only " + iam.activeSlotCount + " active download samples");
      }
      if (factors.deviceParity < 0.8) reasons.push("devices differ or are unknown");
      if (factors.sameLocation < 0.8) reasons.push("operator centroids are not co-located");
      if (factors.availability < 0.8) reasons.push("some RF or capacity fields are missing");
      const score =
        Object.values(factors).reduce((sum, value) => sum + value, 0) /
        Object.keys(factors).length;
      let level =
        score >= conf.high ? "High" : score <= conf.low ? "Low" : "Medium";
      if (
        dtCount <= 1 &&
        (factors.dlDuration < 0.8 || factors.validSamples < 0.8)
      ) {
        level = "Low";
      }
      return { level, score, factors, reasons };
    }

    function mapCausalBreakToMacroCode(causalBreak, iam, refs, thresholds) {
      const text = String(causalBreak || "").toLowerCase();
      if (!text) return "";
      if (text.includes("aggregated bandwidth")) return "CA_BW";
      if (text.includes("resource scheduling")) {
        return asNumber(iam && iam.prbPct) !== null &&
          iam.prbPct >= thresholds.prbHighPct
          ? "LOAD"
          : "SCHEDULER";
      }
      if (text.includes("spectral efficiency")) return "MODULATION";
      if (text.includes("rf quality") || text.includes("sinr") || text.includes("channel feedback")) {
        return "COVERAGE";
      }
      if (text.includes("not explained")) return "SERVER_TCP";
      return "";
    }

    function ruleIndex(code) {
      const idx = RULE_ORDER.indexOf(code);
      return idx < 0 ? RULE_ORDER.length : idx;
    }

    function ruleDefinition(code) {
      const defs = {
        NO_DL: {
          label: "No valid DL session",
          action: "Re-test with a valid download session before drawing a macro verdict.",
        },
        AT_PAR: {
          label: "IAM at par / leading",
          action: "No major DL action from this directional DT alone.",
        },
        NO_5G: {
          label: "No 5G coverage / deployment",
          action: "Deploy or enable 5G on the tested path before deeper scheduler analysis.",
        },
        ENDC_RETENTION: {
          label: "NR not retained during download",
          action: "Optimize EN-DC / SCG retention, anchor stability, and NR leg persistence.",
        },
        NO_N78: {
          label: "No n78 usage",
          action: "Deploy or activate n78 on the tested route.",
        },
        N78_UNDERUSE: {
          label: "n78 under-used",
          action: "Improve n78 selection and retention during the active download.",
        },
        COVERAGE: {
          label: "Coverage / quality limitation",
          action: "Prioritize RF optimization before downstream scheduler tuning.",
        },
        CA_BW: {
          label: "CA / bandwidth limitation",
          action: "Expand aggregated bandwidth, BWP, or usable SCell layer on the route.",
        },
        MIMO: {
          label: "MIMO / rank limitation",
          action: "Improve rank utilization and beamforming before tuning throughput policy.",
        },
        MODULATION: {
          label: "Modulation limitation",
          action: "Improve CQI-to-MCS efficiency and link adaptation on the active layer.",
        },
        LOAD: {
          label: "Capacity / load limitation",
          action: "Offload or expand capacity on the loaded serving layer.",
        },
        SCHEDULER: {
          label: "Scheduler / allocation limitation",
          action: "Investigate scheduler policy, PRB allocation, and CA activation.",
        },
        SERVER_TCP: {
          label: "Server / TCP / methodology limitation",
          action: "Retest with a larger or multi-thread transfer before treating radio as the root cause.",
        },
        MIXED: {
          label: "Mixed limitation",
          action: "Use the detailed causal chain to prioritize the next validation step.",
        },
      };
      return defs[code] || defs.MIXED;
    }

    function diagnoseMacro(perOp, ctx, thresholdsInput) {
      const thresholds = normalizeThresholds(thresholdsInput);
      const iam = perOp && perOp.IAM;
      const refs = selectMacroReferences(perOp, thresholds);
      const cTput = refs.bestThroughputCompetitor;
      const cTech = refs.bestTechnicalCompetitor || cTput;
      const iamDl = dlThroughput(iam);
      const tputDl = dlThroughput(cTput);
      const deficitPct =
        iamDl !== null && tputDl !== null && tputDl > 0
          ? ((tputDl - iamDl) / tputDl) * 100
          : null;
      const gapPct = deficitPct === null ? null : round1(deficitPct);
      const deltaMbps =
        iamDl !== null && tputDl !== null ? round1(iamDl - tputDl) : null;
      const matches = [];
      const addMatch = (code, evidence) => {
        matches.push({
          code,
          ...ruleDefinition(code),
          evidence: evidence.filter(Boolean),
        });
      };

      if (!iam || iamDl === null) {
        addMatch("NO_DL", ["IAM has no valid steady or byte-based download throughput in this scope."]);
      } else if (gapPct !== null && gapPct <= thresholds.atParGapPct) {
        addMatch("AT_PAR", [
          "IAM steady download is within " +
            thresholds.atParGapPct +
            "% of " +
            (cTput ? cTput.operator : "the best competitor") +
            ".",
        ]);
      } else {
        const iamN78 = asNumber(iam.nrBandDwellPct && iam.nrBandDwellPct.n78) || 0;
        const techN78 = asNumber(cTech && cTech.nrBandDwellPct && cTech.nrBandDwellPct.n78) || 0;
        const sinrGap =
          asNumber(cTech && cTech.ssSinrMean) !== null && asNumber(iam.ssSinrMean) !== null
            ? cTech.ssSinrMean - iam.ssSinrMean
            : null;
        const rsrpGap =
          asNumber(cTech && cTech.ssRsrpMean) !== null && asNumber(iam.ssRsrpMean) !== null
            ? cTech.ssRsrpMean - iam.ssRsrpMean
            : null;
        const coverageMatch =
          (sinrGap !== null && sinrGap > thresholds.sinrGapDb) ||
          (rsrpGap !== null && rsrpGap > thresholds.rsrpGapDb);
        if (
          asNumber(iam.nrDwellPct) !== null &&
          iam.nrDwellPct < thresholds.no5gDwellPct &&
          asNumber(iam.nrRoutePresencePct) !== null &&
          iam.nrRoutePresencePct < thresholds.no5gDwellPct
        ) {
          addMatch("NO_5G", [
            "NR dwell is only " + formatNumber(iam.nrDwellPct, 1) + "% during DL.",
            "Route-wide NR presence is only " + formatNumber(iam.nrRoutePresencePct, 1) + "%.",
          ]);
        }
        if (
          asNumber(iam.nrRoutePresencePct) !== null &&
          asNumber(iam.nrDwellPct) !== null &&
          iam.nrRoutePresencePct - iam.nrDwellPct > thresholds.retentionDropPts
        ) {
          addMatch("ENDC_RETENTION", [
            "Route NR presence is " +
              formatNumber(iam.nrRoutePresencePct, 1) +
              "% but DL-window NR dwell drops to " +
              formatNumber(iam.nrDwellPct, 1) +
              "%.",
          ]);
        }
        if (iamN78 < thresholds.noN78DwellPct) {
          addMatch("NO_N78", [
            "IAM n78 dwell is only " + formatNumber(iamN78, 1) + "%.",
          ]);
        }
        if (techN78 - iamN78 > thresholds.n78UnderusePts) {
          addMatch("N78_UNDERUSE", [
            "IAM n78 dwell is " +
              formatNumber(iamN78, 1) +
              "% versus " +
              formatNumber(techN78, 1) +
              "% for " +
              (cTech ? cTech.operator : "the technical reference") +
              ".",
          ]);
        }
        if (coverageMatch) {
          addMatch("COVERAGE", [
            asNumber(iam.ssSinrMean) !== null && asNumber(cTech && cTech.ssSinrMean) !== null
              ? "SINR " + formatNumber(iam.ssSinrMean, 1) + " dB vs " + formatNumber(cTech.ssSinrMean, 1) + " dB."
              : "",
            asNumber(iam.ssRsrpMean) !== null && asNumber(cTech && cTech.ssRsrpMean) !== null
              ? "RSRP " + formatNumber(iam.ssRsrpMean, 1) + " dBm vs " + formatNumber(cTech.ssRsrpMean, 1) + " dBm."
              : "",
          ]);
        }
        if (
          cTech &&
          ((asNumber(iam.aggBwMhz) !== null &&
            asNumber(cTech.aggBwMhz) !== null &&
            iam.aggBwMhz < cTech.aggBwMhz * (1 - thresholds.caBwGapPct / 100)) ||
            (asNumber(iam.scellCount) !== null &&
              asNumber(cTech.scellCount) !== null &&
              iam.scellCount + 0.05 < cTech.scellCount))
        ) {
          addMatch("CA_BW", [
            "Active BW " +
              formatNumber(iam.aggBwMhz, 1) +
              " MHz vs " +
              formatNumber(cTech.aggBwMhz, 1) +
              " MHz.",
            "Avg SCells " +
              formatNumber(iam.scellCount, 1) +
              " vs " +
              formatNumber(cTech.scellCount, 1) +
              ".",
          ]);
        }
        if (
          !coverageMatch &&
          cTech &&
          asNumber(iam.avgRank) !== null &&
          asNumber(cTech.avgRank) !== null &&
          cTech.avgRank - iam.avgRank > thresholds.rankGap
        ) {
          addMatch("MIMO", [
            "Avg rank " +
              formatNumber(iam.avgRank, 1) +
              " vs " +
              formatNumber(cTech.avgRank, 1) +
              ".",
          ]);
        }
        if (
          !coverageMatch &&
          cTech &&
          asNumber(iam.mod256Pct) !== null &&
          asNumber(cTech.mod256Pct) !== null &&
          cTech.mod256Pct - iam.mod256Pct > thresholds.mod256GapPts
        ) {
          addMatch("MODULATION", [
            "256QAM share " +
              formatNumber(iam.mod256Pct, 1) +
              "% vs " +
              formatNumber(cTech.mod256Pct, 1) +
              "%.",
          ]);
        }
        if (asNumber(iam.prbPct) !== null && iam.prbPct > thresholds.prbHighPct) {
          addMatch("LOAD", [
            "PRB utilization is high at " + formatNumber(iam.prbPct, 1) + "%.",
          ]);
        }
        const goodRf =
          (asNumber(iam.ssSinrMean) === null || iam.ssSinrMean >= 5) &&
          (asNumber(iam.ssRsrpMean) === null || iam.ssRsrpMean >= -105);
        const comparableSpectrum =
          !cTech ||
          asNumber(iam.aggBwMhz) === null ||
          asNumber(cTech.aggBwMhz) === null ||
          iam.aggBwMhz >= cTech.aggBwMhz * 0.8;
        if (
          goodRf &&
          comparableSpectrum &&
          asNumber(iam.prbPct) !== null &&
          iam.prbPct < thresholds.prbLowPct &&
          gapPct !== null &&
          gapPct > thresholds.atParGapPct
        ) {
          addMatch("SCHEDULER", [
            "PRB utilization is only " + formatNumber(iam.prbPct, 1) + "% with a remaining DL gap.",
          ]);
        }
        if (
          goodRf &&
          comparableSpectrum &&
          gapPct !== null &&
          gapPct > thresholds.atParGapPct &&
          (iam.slowStartDominated ||
            (asNumber(iam.deliveryEfficiencyPct) !== null &&
              iam.deliveryEfficiencyPct < 75))
        ) {
          addMatch("SERVER_TCP", [
            iam.slowStartDominated
              ? "The short transfer is slow-start dominated."
              : "",
            asNumber(iam.deliveryEfficiencyPct) !== null
              ? "Delivery efficiency is " +
                formatNumber(iam.deliveryEfficiencyPct, 1) +
                "%."
              : "",
          ]);
        }
        if (!matches.length) {
          addMatch("MIXED", ["No single macro rule dominated this DT slice."]);
        }
      }

      let primary = matches[0];
      const secondary = matches.slice(1).map((item) => ({
        code: item.code,
        label: item.label,
      }));
      const causalBreak =
        (((ctx || {}).causalChain || {}).breakPoint) || "";
      const suggestedCode = mapCausalBreakToMacroCode(
        causalBreak,
        iam,
        refs,
        thresholds,
      );
      let consistency = {
        aligned: true,
        causalBreak,
        note: "Macro verdict aligns with the detailed causal chain.",
      };
      if (
        suggestedCode &&
        primary &&
        suggestedCode !== primary.code &&
        ruleIndex(suggestedCode) < ruleIndex(primary.code)
      ) {
        secondary.unshift({ code: primary.code, label: primary.label });
        primary = {
          code: suggestedCode,
          ...ruleDefinition(suggestedCode),
          evidence: primary.evidence,
        };
        consistency = {
          aligned: false,
          causalBreak,
          note:
            "Macro verdict was pulled upstream to stay consistent with the detailed causal-chain break.",
        };
      }

      const confidence = scoreMacroConfidence(perOp, ctx, thresholds);
      const dtType = (ctx && ctx.dtType) || "Static";
      return {
        bestThroughputCompetitor: cTput ? cTput.operator : "",
        bestTechnicalCompetitor: cTech ? cTech.operator : "",
        gapPct,
        deltaMbps,
        primary: {
          code: primary.code,
          label: primary.label,
          action: primary.action,
        },
        evidence: primary.evidence || [],
        secondary,
        confidence,
        dtType,
        interpretationNote: DT_TYPE_NOTES[dtType] || "",
        consistency,
      };
    }

    function round1(value) {
      return value == null ? null : Number(Number(value).toFixed(1));
    }

    function buildBenchmarkNemoMacroModel(dataset, options) {
      const perOp = buildBenchmarkNemoMacroPerOp(dataset);
      const thresholds = normalizeThresholds(
        (options && options.thresholds) || loadMacroThresholds(),
      );
      const validity = (dataset && dataset.benchmarkValidity) || {};
      const dtType = detectDtType(perOp, options && options.dtTypeOverride);
      const verdict = diagnoseMacro(perOp, {
        causalChain:
          ((dataset && dataset.macroContext) || {}).causalChain ||
          (((dataset && dataset.deepBenchmark) || {}).execSummary || {}).causalChain ||
          {},
        validity,
        dtType,
      }, thresholds);
      const rows = Object.values(perOp)
        .sort((a, b) => operatorOrder(a.operator) - operatorOrder(b.operator))
        .map((row) => ({
          ...row,
          role:
            upper(row.operator) === upper(verdict.bestThroughputCompetitor) &&
            upper(row.operator) === upper(verdict.bestTechnicalCompetitor)
              ? "throughput+technical"
              : upper(row.operator) === upper(verdict.bestThroughputCompetitor)
                ? "throughput"
                : upper(row.operator) === upper(verdict.bestTechnicalCompetitor)
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

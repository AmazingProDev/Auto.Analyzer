(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.BenchmarkNemoScorecardState = Object.assign(
      {},
      root.BenchmarkNemoScorecardState || {},
      api,
    );
  }
})(
  typeof globalThis !== "undefined" ? globalThis : this,
  function () {
    const OPERATOR_ORDER = ["IAM", "ORANGE", "INWI"];
    const LOAD_STATE_LABELS = {
      headroom: "Headroom",
      moderate: "Moderate",
      loaded: "Loaded",
      rf_limited: "RF-limited",
      delivery_limited: "Delivery-limited",
      mixed: "Mixed",
    };
    const LOAD_STATE_SCORES = {
      headroom: 5,
      moderate: 4,
      loaded: 3,
      delivery_limited: 2,
      rf_limited: 1,
      mixed: 0,
    };
    const CONFIDENCE_LABELS = {
      low: "Low confidence",
      medium: "Medium confidence",
      high: "High confidence",
    };
    const CONFIDENCE_SCORES = {
      low: 1,
      medium: 2,
      high: 3,
    };

    function operatorOrder(name) {
      const idx = OPERATOR_ORDER.indexOf(String(name || "").trim().toUpperCase());
      return idx < 0 ? OPERATOR_ORDER.length : idx;
    }

    function asNumber(value) {
      const num = Number(value);
      return Number.isFinite(num) ? num : null;
    }

    function normalizeLoadState(value) {
      const key = String(value || "").trim().toLowerCase();
      return LOAD_STATE_LABELS[key] ? key : "";
    }

    function normalizeConfidenceClass(value) {
      const key = String(value || "").trim().toLowerCase();
      return CONFIDENCE_LABELS[key] ? key : "";
    }

    function rankNumericRows(rows, getter, direction) {
      const valid = rows
        .map((row) => ({ row, value: asNumber(getter(row)) }))
        .filter((entry) => entry.value !== null)
        .sort((a, b) =>
          direction === "desc" ? b.value - a.value : a.value - b.value,
        );
      let rank = 0;
      let prev = null;
      valid.forEach((entry, index) => {
        if (prev === null || entry.value !== prev) {
          rank = index + 1;
          prev = entry.value;
        }
        entry.row.rank = rank;
      });
    }

    function winnersFromRows(rows, metricKey) {
      const bestRank = rows.reduce((best, row) => {
        const rank = row.metrics[metricKey] ? row.metrics[metricKey].rank : null;
        if (rank == null) return best;
        return best == null || rank < best ? rank : best;
      }, null);
      if (bestRank == null) return [];
      return rows
        .filter((row) => row.metrics[metricKey] && row.metrics[metricKey].rank === bestRank)
        .map((row) => row.operator);
    }

    function verdictSegment(label, winners, tieLabel) {
      if (!winners.length) return "";
      if (winners.length > 1) return label + ": " + (tieLabel || "tie");
      return label + ": " + winners[0];
    }

    function buildBenchmarkNemoScorecardModel(tlByMetric, operatorNames) {
      const names = (Array.isArray(operatorNames) ? operatorNames : Object.keys(tlByMetric || {}))
        .slice()
        .sort((a, b) => operatorOrder(a) - operatorOrder(b));
      const rows = names.map((operator) => {
        const opData = (tlByMetric || {})[operator] || {};
        const evtKpis = opData.downloadEventKpis || {};
        const sessionStats = opData.sessionStats || {};
        const kpis = sessionStats.kpis || {};
        const download = sessionStats.download || {};
        const loadState = normalizeLoadState(download.loadState || download.efficiencyClass);
        const confidenceClass = normalizeConfidenceClass(download.confidenceClass);
        const reliabilityScore =
          (asNumber(kpis.pingSuccessPct) || 0) +
          (kpis.dlSuccess ? 25 : 0) +
          (kpis.ulSuccess ? 25 : 0);
        return {
          operator,
          metrics: {
            dlAvg: {
              value: asNumber(evtKpis.dlAppRateMbps),
              label: evtKpis.dlAppRateMbps != null ? Number(evtKpis.dlAppRateMbps).toFixed(1) + " Mbps" : "—",
              rank: null,
            },
            dlSteady: {
              value: asNumber(evtKpis.dlSteadyStateMbps),
              label:
                evtKpis.dlSteadyStateMbps != null
                  ? Number(evtKpis.dlSteadyStateMbps).toFixed(1) + " Mbps"
                  : "—",
              rank: null,
            },
            ul: {
              value: asNumber(kpis.ulAppTputMbps),
              label: kpis.ulAppTputMbps != null ? Number(kpis.ulAppTputMbps).toFixed(1) + " Mbps" : "—",
              rank: null,
            },
            latency: {
              value: asNumber(evtKpis.startDelayAvgS),
              label:
                evtKpis.startDelayAvgS != null || evtKpis.timeToConnectAvgMs != null
                  ? (evtKpis.startDelayAvgS != null
                      ? Number(evtKpis.startDelayAvgS).toFixed(2) + "s"
                      : "—") +
                    " / " +
                    (evtKpis.timeToConnectAvgMs != null
                      ? Math.round(evtKpis.timeToConnectAvgMs) + "ms"
                      : "—")
                  : "—",
              rank: null,
            },
            reliability: {
              value: reliabilityScore,
              label:
                (kpis.pingSuccessPct != null ? Math.round(kpis.pingSuccessPct) + "% ping" : "—") +
                " · DL " +
                (kpis.dlSuccess ? "ok" : "fail") +
                " · UL " +
                (kpis.ulSuccess ? "ok" : "fail"),
              rank: null,
            },
            rf: {
              value: asNumber(download.ssSinrMean),
              label: download.ssSinrMean != null ? Number(download.ssSinrMean).toFixed(1) + " dB" : "—",
              rank: null,
            },
            loadState: {
              value: LOAD_STATE_SCORES[loadState] ?? null,
              label: LOAD_STATE_LABELS[loadState] || "—",
              classKey: loadState || "",
              rank: null,
            },
            confidence: {
              value: CONFIDENCE_SCORES[confidenceClass] || null,
              label: CONFIDENCE_LABELS[confidenceClass] || "—",
              classKey: confidenceClass || "",
              rank: null,
            },
          },
        };
      });

      rankNumericRows(rows.map((row) => row.metrics.dlAvg), (metric) => metric.value, "desc");
      rankNumericRows(rows.map((row) => row.metrics.dlSteady), (metric) => metric.value, "desc");
      rankNumericRows(rows.map((row) => row.metrics.ul), (metric) => metric.value, "desc");
      rankNumericRows(rows.map((row) => row.metrics.latency), (metric) => metric.value, "asc");
      rankNumericRows(rows.map((row) => row.metrics.reliability), (metric) => metric.value, "desc");
      rankNumericRows(rows.map((row) => row.metrics.rf), (metric) => metric.value, "desc");
      rankNumericRows(rows.map((row) => row.metrics.loadState), (metric) => metric.value, "desc");
      rankNumericRows(rows.map((row) => row.metrics.confidence), (metric) => metric.value, "desc");

      const verdictParts = [
        verdictSegment("DL avg", winnersFromRows(rows, "dlAvg")),
        verdictSegment("DL steady", winnersFromRows(rows, "dlSteady")),
        verdictSegment("Upload", winnersFromRows(rows, "ul")),
        verdictSegment("Latency", winnersFromRows(rows, "latency")),
        verdictSegment("Reliability", winnersFromRows(rows, "reliability"), "tie"),
        verdictSegment("RF", winnersFromRows(rows, "rf")),
        verdictSegment("Load", winnersFromRows(rows, "loadState")),
      ].filter(Boolean);

      return {
        rows,
        verdict: verdictParts.join(" · "),
      };
    }

    return {
      buildBenchmarkNemoScorecardModel,
      normalizeBenchmarkNemoEfficiencyClass: normalizeLoadState,
    };
  },
);

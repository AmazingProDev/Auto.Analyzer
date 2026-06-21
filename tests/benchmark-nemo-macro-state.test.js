const test = require("node:test");
const assert = require("node:assert/strict");

global.localStorage = (() => {
  let store = new Map();
  return {
    getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
      store.set(key, String(value));
    },
    removeItem(key) {
      store.delete(key);
    },
    clear() {
      store = new Map();
    },
  };
})();

const {
  buildBenchmarkNemoMacroModel,
  importMacroProfile,
  loadMacroThresholds,
  selectMacroReferences,
} = require("../benchmark_nemo_macro_state.js");

function mergeDeep(base, extra) {
  if (!extra || typeof extra !== "object") return base;
  const out = Array.isArray(base) ? base.slice() : { ...base };
  Object.keys(extra).forEach((key) => {
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

function makeDataset(overrides = {}) {
  const base = {
    benchmarkValidity: {
      dtCount: 2,
      devicesComparable: true,
      deviceByOperator: {
        IAM: "Phone A",
        Orange: "Phone A",
        INWI: "Phone A",
      },
    },
    macroContext: {
      causalChain: {
        breakPoint: "",
      },
    },
    charts: {
      dlTimelineByMetric: {
        IAM: {
          downloadEventKpis: {
            dlSteadyStateMbps: 338,
            dlAppRateMbps: 320,
            downloadDurationAvgS: 26,
            activeSlotCount: 16,
            throughputSamples: 16,
            rfSampleCount: 16,
            byteVsCurveDeltaPct: 5,
          },
          sessionStats: {
            download: {
              nrDwellPct: 85,
              nrRoutePresencePct: 90,
              nrBandDwellPct: { n78: 65, n1: 20 },
              nrBands: "n78/n1",
              mod256Pct: 48,
              avgRank: 1.9,
              aggBwMhz: 90,
              scellCount: 2.5,
              prbUtilMean: 55,
              spectralEffMbpsPerMhz: 3.76,
              ssRsrpMean: -88,
              ssSinrMean: 16,
              deliveryEfficiencyPct: 82,
              cqiMean: 11.8,
              avgMcs: 17.5,
              throughputSamples: 16,
              rfSamples: 16,
              byteVsCurveDeltaPct: 5,
              loadState: "moderate",
              dlCentroid: { lat: 33.57311, lon: -7.58984 },
              dlMedianSpeedKmh: 0.8,
            },
          },
        },
        Orange: {
          downloadEventKpis: {
            dlSteadyStateMbps: 420,
            dlAppRateMbps: 400,
            downloadDurationAvgS: 26,
            activeSlotCount: 18,
            throughputSamples: 18,
            rfSampleCount: 18,
            byteVsCurveDeltaPct: 4.8,
          },
          sessionStats: {
            download: {
              nrDwellPct: 88,
              nrRoutePresencePct: 92,
              nrBandDwellPct: { n78: 55, n1: 28 },
              nrBands: "n78/n1",
              mod256Pct: 42,
              avgRank: 1.8,
              aggBwMhz: 80,
              scellCount: 2.2,
              prbUtilMean: 68,
              spectralEffMbpsPerMhz: 5.25,
              ssRsrpMean: -90,
              ssSinrMean: 14,
              deliveryEfficiencyPct: 84,
              cqiMean: 10.9,
              avgMcs: 16.2,
              throughputSamples: 18,
              rfSamples: 18,
              byteVsCurveDeltaPct: 4.8,
              loadState: "loaded",
              dlCentroid: { lat: 33.57318, lon: -7.5897 },
              dlMedianSpeedKmh: 0.9,
            },
          },
        },
        INWI: {
          downloadEventKpis: {
            dlSteadyStateMbps: 390,
            dlAppRateMbps: 375,
            downloadDurationAvgS: 26,
            activeSlotCount: 17,
            throughputSamples: 17,
            rfSampleCount: 17,
            byteVsCurveDeltaPct: 3.2,
          },
          sessionStats: {
            download: {
              nrDwellPct: 92,
              nrRoutePresencePct: 94,
              nrBandDwellPct: { n78: 80, n1: 10 },
              nrBands: "n78/n1",
              mod256Pct: 74,
              avgRank: 2.6,
              aggBwMhz: 100,
              scellCount: 3.2,
              prbUtilMean: 50,
              spectralEffMbpsPerMhz: 3.9,
              ssRsrpMean: -82,
              ssSinrMean: 22,
              deliveryEfficiencyPct: 88,
              cqiMean: 13.4,
              avgMcs: 21.3,
              throughputSamples: 17,
              rfSamples: 17,
              byteVsCurveDeltaPct: 3.2,
              loadState: "moderate",
              dlCentroid: { lat: 33.57316, lon: -7.58978 },
              dlMedianSpeedKmh: 1.1,
            },
          },
        },
      },
    },
  };
  return mergeDeep(base, overrides);
}

function makeMohammediaAcceptanceDataset() {
  return makeDataset({
    benchmarkValidity: {
      dtCount: 1,
    },
    macroContext: {
      causalChain: {
        breakPoint: "Spectral efficiency (bits/PRB)",
      },
    },
    charts: {
      dlTimelineByMetric: {
        IAM: {
          downloadEventKpis: {
            dlSteadyStateMbps: 456.0,
            dlAppRateMbps: 338.4,
            downloadDurationAvgS: 4.7,
            activeSlotCount: 8,
            throughputSamples: 8,
            rfSampleCount: 8,
            byteVsCurveDeltaPct: 25.8,
          },
          sessionStats: {
            download: {
              nrDwellPct: 100,
              nrRoutePresencePct: 100,
              nrBandDwellPct: { n78: 50, n28: 50 },
              nrBands: "n78/n28",
              mod256Pct: 35,
              avgRank: 1.9,
              aggBwMhz: 33.89,
              scellCount: 0,
              prbUtilMean: 6.6,
              spectralEffMbpsPerMhz: 12.94,
              ssRsrpMean: -102,
              ssSinrMean: 15.4,
              deliveryEfficiencyPct: 82,
              cqiMean: 12.0,
              avgMcs: 18.0,
              throughputSamples: 8,
              rfSamples: 8,
              byteVsCurveDeltaPct: 25.8,
              loadState: "headroom",
              dlCentroid: { lat: 33.680679, lon: -7.380298 },
              dlMedianSpeedKmh: 0,
            },
          },
        },
        Orange: {
          downloadEventKpis: {
            dlSteadyStateMbps: 201.0,
            dlAppRateMbps: 122.2,
            downloadDurationAvgS: 13.0,
            activeSlotCount: 26,
            throughputSamples: 26,
            rfSampleCount: 26,
            byteVsCurveDeltaPct: 39.2,
          },
          sessionStats: {
            download: {
              nrDwellPct: 100,
              nrRoutePresencePct: 100,
              nrBandDwellPct: { n78: 20, n28: 80 },
              nrBands: "n78/n28",
              mod256Pct: 20,
              avgRank: 1.3,
              aggBwMhz: 29.23,
              scellCount: 0,
              prbUtilMean: 57.8,
              spectralEffMbpsPerMhz: 10.04,
              ssRsrpMean: -108,
              ssSinrMean: 12.0,
              deliveryEfficiencyPct: 75,
              cqiMean: 8.5,
              avgMcs: 11.5,
              throughputSamples: 26,
              rfSamples: 26,
              byteVsCurveDeltaPct: 39.2,
              loadState: "loaded",
              dlCentroid: { lat: 33.680679, lon: -7.380298 },
              dlMedianSpeedKmh: 0,
            },
          },
        },
        INWI: {
          downloadEventKpis: {
            dlSteadyStateMbps: 523.0,
            dlAppRateMbps: 375.3,
            downloadDurationAvgS: 4.7,
            activeSlotCount: 8,
            throughputSamples: 8,
            rfSampleCount: 8,
            byteVsCurveDeltaPct: 28.2,
          },
          sessionStats: {
            download: {
              nrDwellPct: 100,
              nrRoutePresencePct: 100,
              nrBandDwellPct: { n78: 100 },
              nrBands: "n78",
              mod256Pct: 60,
              avgRank: 2.0,
              aggBwMhz: 47.37,
              scellCount: 0,
              prbUtilMean: 8.0,
              spectralEffMbpsPerMhz: 7.42,
              ssRsrpMean: -111,
              ssSinrMean: -1.9,
              deliveryEfficiencyPct: 80,
              cqiMean: 8.0,
              avgMcs: 9.0,
              throughputSamples: 8,
              rfSamples: 8,
              byteVsCurveDeltaPct: 28.2,
              loadState: "headroom",
              dlCentroid: { lat: 33.680679, lon: -7.380297 },
              dlMedianSpeedKmh: 0,
            },
          },
        },
      },
    },
  });
}

test.beforeEach(() => {
  global.localStorage.clear();
});

test("macro model chooses different throughput and technical references when warranted", () => {
  const perOp = buildBenchmarkNemoMacroModel(makeDataset()).perOp;
  const refs = selectMacroReferences(perOp, loadMacroThresholds());
  assert.equal(refs.bestThroughputCompetitor.operator, "Orange");
  assert.equal(refs.bestTechnicalCompetitor.operator, "INWI");
});

test("NO_VALID_DL_SESSION verdict is returned when IAM has no valid download session", () => {
  const dataset = makeDataset({
    charts: {
      dlTimelineByMetric: {
        IAM: {
          downloadEventKpis: {
            dlSteadyStateMbps: null,
            dlAppRateMbps: null,
          },
        },
      },
    },
  });
  const model = buildBenchmarkNemoMacroModel(dataset);
  assert.equal(model.verdict.diagnosis.primaryCode, "NO_VALID_DL_SESSION");
});

test("IAM_AT_PAR_OR_LEADING is returned for gaps within 10%", () => {
  const dataset = makeDataset({
    charts: {
      dlTimelineByMetric: {
        IAM: { downloadEventKpis: { dlSteadyStateMbps: 379 } },
        Orange: { downloadEventKpis: { dlSteadyStateMbps: 400 } },
        INWI: { downloadEventKpis: { dlSteadyStateMbps: 360 } },
      },
    },
  });
  const model = buildBenchmarkNemoMacroModel(dataset);
  assert.equal(model.verdict.diagnosis.primaryCode, "IAM_AT_PAR_OR_LEADING");
  assert.equal(model.verdict.diagnosis.severity, "None");
});

test("IAM_CLOSE_TO_BEST keeps optimization-opportunity severity when no deeper cause dominates", () => {
  const dataset = makeDataset({
    charts: {
      dlTimelineByMetric: {
        IAM: {
          downloadEventKpis: { dlSteadyStateMbps: 357 },
          sessionStats: {
            download: {
              nrBandDwellPct: { n78: 62, n1: 18 },
              aggBwMhz: 96,
              scellCount: 2.5,
              prbUtilMean: 42,
              ssSinrMean: 16,
              ssRsrpMean: -88,
              mod256Pct: 48,
              avgRank: 1.9,
            },
          },
        },
        Orange: {
          downloadEventKpis: { dlSteadyStateMbps: 420 },
        },
        INWI: {
          downloadEventKpis: { dlSteadyStateMbps: 390 },
          sessionStats: {
            download: {
              nrBandDwellPct: { n78: 64, n1: 16 },
              aggBwMhz: 100,
              scellCount: 2.5,
              prbUtilMean: 45,
              ssSinrMean: 16.5,
              ssRsrpMean: -88.5,
              mod256Pct: 49,
              avgRank: 2.0,
            },
          },
        },
      },
    },
  });
  const model = buildBenchmarkNemoMacroModel(dataset);
  assert.equal(model.verdict.diagnosis.primaryCode, "IAM_CLOSE_TO_BEST");
  assert.equal(model.verdict.diagnosis.severity, "Optimization opportunity");
});

test("NO_5G_FOR_IAM and LOW_5G_RETENTION remain distinct branches", () => {
  const no5g = buildBenchmarkNemoMacroModel(
    makeDataset({
      charts: {
        dlTimelineByMetric: {
          IAM: {
            sessionStats: {
              download: {
                nrDwellPct: 2,
                nrRoutePresencePct: 3,
                nrBandDwellPct: { n78: 0 },
              },
            },
          },
        },
      },
    }),
  );
  assert.equal(no5g.verdict.diagnosis.primaryCode, "NO_5G_FOR_IAM");

  const retention = buildBenchmarkNemoMacroModel(
    makeDataset({
      charts: {
        dlTimelineByMetric: {
          IAM: {
            sessionStats: {
              download: {
                nrDwellPct: 18,
                nrRoutePresencePct: 70,
                nrBandDwellPct: { n78: 4 },
              },
            },
          },
        },
      },
    }),
  );
  assert.equal(retention.verdict.diagnosis.primaryCode, "LOW_5G_RETENTION");
});

test("active bandwidth wins over CA when all operators have zero SCells", () => {
  const model = buildBenchmarkNemoMacroModel(
    makeDataset({
      charts: {
        dlTimelineByMetric: {
          IAM: {
            downloadEventKpis: { dlSteadyStateMbps: 240 },
            sessionStats: {
              download: {
                aggBwMhz: 60,
                scellCount: 0,
                nrBandDwellPct: { n78: 80 },
                prbUtilMean: 40,
                ssSinrMean: 16,
                ssRsrpMean: -90,
                avgRank: 2.0,
                mod256Pct: 50,
              },
            },
          },
          INWI: {
            sessionStats: {
              download: {
                aggBwMhz: 90,
                scellCount: 0,
                nrBandDwellPct: { n78: 82 },
                prbUtilMean: 45,
                ssSinrMean: 17,
                ssRsrpMean: -91,
                avgRank: 2.0,
                mod256Pct: 50,
              },
            },
          },
        },
      },
    }),
  );
  assert.equal(
    model.verdict.diagnosis.primaryCode,
    "ACTIVE_BANDWIDTH_LIMITATION",
  );
});

test("RF limitation is blocked when IAM RF is at least as good as the technical reference", () => {
  const model = buildBenchmarkNemoMacroModel(makeMohammediaAcceptanceDataset());
  assert.notEqual(
    model.verdict.diagnosis.primaryCode,
    "RF_COVERAGE_QUALITY_LIMITATION",
  );
  assert.ok(
    model.verdict.diagnosis.blockedCauses.some((item) =>
      /RF limitation blocked/i.test(item.message || ""),
    ),
  );
  assert.ok(
    model.verdict.diagnosis.evidence.some((item) =>
      /RF >= reference/i.test(item.interpretation || ""),
    ),
  );
});

test("PRB consistency warning blocks scheduler/load and caps confidence at Low", () => {
  const model = buildBenchmarkNemoMacroModel(
    makeDataset({
      benchmarkValidity: { dtCount: 1 },
      charts: {
        dlTimelineByMetric: {
          IAM: {
            downloadEventKpis: {
              dlSteadyStateMbps: 350,
              downloadDurationAvgS: 15,
              activeSlotCount: 12,
              throughputSamples: 12,
              rfSampleCount: 12,
            },
            sessionStats: {
              download: {
                prbUtilMean: 5,
                aggBwMhz: 96,
                scellCount: 2,
                nrBandDwellPct: { n78: 70 },
                ssSinrMean: 16,
                ssRsrpMean: -92,
                avgRank: 2.0,
                mod256Pct: 52,
                spectralEffMbpsPerMhz: 3.64,
              },
            },
          },
          INWI: {
            downloadEventKpis: { dlSteadyStateMbps: 520 },
            sessionStats: {
              download: {
                prbUtilMean: 45,
                aggBwMhz: 96,
                scellCount: 2,
                nrBandDwellPct: { n78: 70 },
                ssSinrMean: 16,
                ssRsrpMean: -92,
                avgRank: 2.0,
                mod256Pct: 52,
                spectralEffMbpsPerMhz: 5.4,
              },
            },
          },
        },
      },
    }),
  );
  assert.notEqual(
    model.verdict.diagnosis.primaryCode,
    "SCHEDULER_ALLOCATION_LIMITATION",
  );
  assert.notEqual(
    model.verdict.diagnosis.primaryCode,
    "CAPACITY_LOAD_LIMITATION",
  );
  assert.ok(
    model.verdict.diagnosis.blockedCauses.some((item) =>
      /PRB may not be aggregated/i.test(item.message || ""),
    ),
  );
  assert.equal(model.verdict.diagnosis.confidence.label, "Low");
});

test("profile import and reload round-trip through localStorage for v4 thresholds", () => {
  importMacroProfile(
    JSON.stringify({
      atParGapPct: 7,
      closeGapPct: 18,
      minDlDurationSec: 24,
      highPrbPct: 85,
    }),
  );
  const thresholds = loadMacroThresholds();
  assert.equal(thresholds.atParGapPct, 7);
  assert.equal(thresholds.closeGapPct, 18);
  assert.equal(thresholds.minDlDurationSec, 24);
  assert.equal(thresholds.highPrbPct, 85);
  assert.equal(thresholds.lowPrbPct, 15);
});

test("acceptance-style Mohammedia fixture yields n78 under-use with blocked RF and warnings", () => {
  const model = buildBenchmarkNemoMacroModel(makeMohammediaAcceptanceDataset());
  const diagnosis = model.verdict.diagnosis;

  assert.equal(model.verdict.scope, "All DTs");
  assert.equal(model.verdict.references.bestThroughput.operator, "INWI");
  assert.equal(model.verdict.references.bestTechnical.operator, "INWI");
  assert.equal(diagnosis.primaryCode, "N78_UNDER_USED");
  assert.equal(diagnosis.severity, "Optimization opportunity");
  assert.ok(Math.abs(diagnosis.gapPct - 12.8) < 0.2);
  assert.ok(Math.abs(diagnosis.gapMbps - 67) < 1);
  assert.ok(
    diagnosis.secondary.some((item) => item.code === "ACTIVE_BANDWIDTH_LIMITATION"),
  );
  assert.ok(
    diagnosis.blockedCauses.some((item) =>
      /RF limitation blocked/i.test(item.message || ""),
    ),
  );
  assert.ok(
    diagnosis.warnings.some((item) => item.code === "prbConsistencyWarning"),
  );
  assert.ok(
    diagnosis.warnings.some((item) => item.code === "rfThroughputContradiction"),
  );
  assert.equal(diagnosis.confidence.label, "Low");
  assert.ok(
    diagnosis.confidence.reasons.some((item) =>
      /PRB may not be aggregated/i.test(item),
    ),
  );
  assert.ok(
    diagnosis.efficiencyInsight &&
      diagnosis.efficiencyInsight.iamValue > diagnosis.efficiencyInsight.referenceValue,
  );
  assert.match(
    diagnosis.conclusionText,
    /Optimization opportunity|under-used C-Band|active bandwidth/i,
  );
});

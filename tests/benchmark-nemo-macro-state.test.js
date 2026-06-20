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

function makeDataset(overrides = {}) {
  const base = {
    benchmarkValidity: {
      dtCount: 1,
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
            downloadDurationAvgS: 13,
            activeSlotCount: 16,
          },
          sessionStats: {
            download: {
              nrDwellPct: 85,
              nrRoutePresencePct: 90,
              nrBandDwellPct: { n78: 65, n1: 20 },
              mod256Pct: 48,
              avgRank: 1.9,
              aggBwMhz: 90,
              scellCount: 2.5,
              prbUtilMean: 55,
              spectralEffMbpsPerMhz: 3.76,
              ssRsrpMean: -88,
              ssSinrMean: 16,
              deliveryEfficiencyPct: 82,
              dlCentroid: { lat: 33.57311, lon: -7.58984 },
              dlMedianSpeedKmh: 0.8,
            },
          },
        },
        Orange: {
          downloadEventKpis: {
            dlSteadyStateMbps: 420,
            dlAppRateMbps: 400,
            downloadDurationAvgS: 13,
            activeSlotCount: 18,
          },
          sessionStats: {
            download: {
              nrDwellPct: 88,
              nrRoutePresencePct: 92,
              nrBandDwellPct: { n78: 55, n1: 28 },
              mod256Pct: 42,
              avgRank: 1.8,
              aggBwMhz: 80,
              scellCount: 2.2,
              prbUtilMean: 68,
              spectralEffMbpsPerMhz: 5.25,
              ssRsrpMean: -90,
              ssSinrMean: 14,
              deliveryEfficiencyPct: 84,
              dlCentroid: { lat: 33.57318, lon: -7.5897 },
              dlMedianSpeedKmh: 0.9,
            },
          },
        },
        INWI: {
          downloadEventKpis: {
            dlSteadyStateMbps: 390,
            dlAppRateMbps: 375,
            downloadDurationAvgS: 13,
            activeSlotCount: 17,
          },
          sessionStats: {
            download: {
              nrDwellPct: 92,
              nrRoutePresencePct: 94,
              nrBandDwellPct: { n78: 80, n1: 10 },
              mod256Pct: 74,
              avgRank: 2.6,
              aggBwMhz: 100,
              scellCount: 3.2,
              prbUtilMean: 50,
              spectralEffMbpsPerMhz: 3.9,
              ssRsrpMean: -82,
              ssSinrMean: 22,
              deliveryEfficiencyPct: 88,
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

test.beforeEach(() => {
  global.localStorage.clear();
});

test("macro model chooses different throughput and technical references when warranted", () => {
  const perOp = buildBenchmarkNemoMacroModel(makeDataset()).perOp;
  const refs = selectMacroReferences(perOp, loadMacroThresholds());
  assert.equal(refs.bestThroughputCompetitor.operator, "Orange");
  assert.equal(refs.bestTechnicalCompetitor.operator, "INWI");
});

test("AT_PAR verdict wins when IAM is within the throughput gap threshold", () => {
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
  assert.equal(model.verdict.primary.code, "AT_PAR");
});

test("NO_DL verdict is returned when IAM has no valid download session", () => {
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
  assert.equal(model.verdict.primary.code, "NO_DL");
});

test("NO_5G and ENDC_RETENTION remain distinct branches", () => {
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
  assert.equal(no5g.verdict.primary.code, "NO_5G");

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
  assert.equal(retention.verdict.primary.code, "ENDC_RETENTION");
});

test("coverage outranks downstream MIMO and modulation symptoms", () => {
  const model = buildBenchmarkNemoMacroModel(
    makeDataset({
      charts: {
        dlTimelineByMetric: {
          IAM: {
            sessionStats: {
              download: {
                ssSinrMean: 8,
                ssRsrpMean: -98,
                nrBandDwellPct: { n78: 78, n1: 10 },
                mod256Pct: 10,
                avgRank: 1.1,
              },
            },
          },
        },
      },
    }),
  );
  assert.equal(model.verdict.primary.code, "COVERAGE");
});

test("consistency guard pulls a downstream scheduler verdict upstream", () => {
  const model = buildBenchmarkNemoMacroModel(
    makeDataset({
      macroContext: {
        causalChain: {
          breakPoint: "Aggregated bandwidth",
        },
      },
      charts: {
        dlTimelineByMetric: {
          IAM: {
            downloadEventKpis: {
              dlSteadyStateMbps: 280,
            },
            sessionStats: {
              download: {
                prbUtilMean: 8,
                aggBwMhz: 82,
                scellCount: 2.5,
                ssSinrMean: 20,
                ssRsrpMean: -84,
                mod256Pct: 46,
                avgRank: 1.9,
                nrBandDwellPct: { n78: 79 },
              },
            },
          },
          INWI: {
            sessionStats: {
              download: {
                aggBwMhz: 96,
                scellCount: 2.5,
                ssSinrMean: 21,
                ssRsrpMean: -83,
                nrBandDwellPct: { n78: 80 },
              },
            },
          },
        },
      },
    }),
  );
  assert.equal(model.verdict.primary.code, "CA_BW");
  assert.equal(model.verdict.consistency.aligned, false);
});

test("confidence falls to Low on n=1 short-transfer evidence", () => {
  const model = buildBenchmarkNemoMacroModel(
    makeDataset({
      benchmarkValidity: {
        dtCount: 1,
        devicesComparable: false,
      },
      charts: {
        dlTimelineByMetric: {
          IAM: {
            downloadEventKpis: {
              downloadDurationAvgS: 4.7,
              activeSlotCount: 4,
            },
          },
        },
      },
    }),
  );
  assert.equal(model.verdict.confidence.level, "Low");
  assert.match(model.verdict.confidence.reasons.join(" | "), /n=1 DT/);
  assert.match(model.verdict.confidence.reasons.join(" | "), /short 4.7 s transfer/);
});

test("DT-type override changes the interpretation note and reduces confidence", () => {
  const autoModel = buildBenchmarkNemoMacroModel(makeDataset());
  const mobilityModel = buildBenchmarkNemoMacroModel(makeDataset(), {
    dtTypeOverride: "Mobility",
  });
  assert.equal(autoModel.verdict.dtType, "Static");
  assert.equal(mobilityModel.verdict.dtType, "Mobility");
  assert.match(mobilityModel.verdict.interpretationNote, /route average/i);
  assert.ok(mobilityModel.verdict.confidence.score < autoModel.verdict.confidence.score);
});

test("profile import and reload round-trip through localStorage", () => {
  importMacroProfile(
    JSON.stringify({
      atParGapPct: 7,
      techW: { sinr: 0.45 },
      conf: { minDlSec: 10 },
    }),
  );
  const thresholds = loadMacroThresholds();
  assert.equal(thresholds.atParGapPct, 7);
  assert.equal(thresholds.techW.sinr, 0.45);
  assert.equal(thresholds.conf.minDlSec, 10);
  assert.equal(thresholds.techW.rank, 0.2);
});

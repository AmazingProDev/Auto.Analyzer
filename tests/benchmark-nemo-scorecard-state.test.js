const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildBenchmarkNemoScorecardModel,
} = require("../benchmark_nemo_scorecard_state.js");

test("buildBenchmarkNemoScorecardModel ranks operators and builds a verdict", () => {
  const tlByMetric = {
    IAM: {
      downloadEventKpis: {
        dlAppRateMbps: 338.4,
        dlSteadyStateMbps: 466.3,
        throughputSpreadMbps: { min: 120, p10: 140, p50: 338, p90: 482, max: 500 },
        timeToConnectAvgMs: 81,
        startDelayAvgS: 0.84,
      },
      sessionStats: {
        kpis: {
          ulAppTputMbps: 85,
          pingSuccessPct: 50,
          dlSuccess: true,
          ulSuccess: true,
        },
        download: {
          ssSinrMean: 15,
          loadState: "headroom",
          confidenceClass: "low",
        },
      },
    },
    Orange: {
      downloadEventKpis: {
        dlAppRateMbps: 122.2,
        dlSteadyStateMbps: 122.4,
        throughputSpreadMbps: { min: 80, p10: 90, p50: 122, p90: 150, max: 160 },
        timeToConnectAvgMs: 92,
        startDelayAvgS: 1.1,
      },
      sessionStats: {
        kpis: {
          ulAppTputMbps: 96,
          pingSuccessPct: 50,
          dlSuccess: true,
          ulSuccess: true,
        },
        download: {
          ssSinrMean: 8,
          loadState: "loaded",
          confidenceClass: "high",
        },
      },
    },
    INWI: {
      downloadEventKpis: {
        dlAppRateMbps: 375.3,
        dlSteadyStateMbps: 410,
        throughputSpreadMbps: { min: 140, p10: 180, p50: 375, p90: 498, max: 500 },
        timeToConnectAvgMs: 109,
        startDelayAvgS: 1.6,
      },
      sessionStats: {
        kpis: {
          ulAppTputMbps: 70,
          pingSuccessPct: 50,
          dlSuccess: true,
          ulSuccess: true,
        },
        download: {
          ssSinrMean: -1,
          loadState: "rf_limited",
          confidenceClass: "medium",
        },
      },
    },
  };

  const model = buildBenchmarkNemoScorecardModel(tlByMetric, ["INWI", "Orange", "IAM"]);

  assert.deepEqual(
    model.rows.map((row) => row.operator),
    ["IAM", "Orange", "INWI"],
  );
  assert.equal(model.rows[0].metrics.dlAvg.rank, 2);
  assert.equal(model.rows[0].metrics.dlSteady.rank, 1);
  assert.equal(model.rows[1].metrics.ul.rank, 1);
  assert.equal(model.rows[0].metrics.rf.rank, 1);
  assert.equal(model.rows[0].metrics.loadState.label, "Headroom");
  assert.equal(model.rows[0].metrics.confidence.label, "Low confidence");
  assert.equal(model.rows[0].metrics.dlAvg.label, "338 Mbps");
  assert.equal(model.rows[0].metrics.dlAvg.rangeLabel, "≈120–500");
  assert.match(model.verdict, /DL avg: INWI/);
  assert.match(model.verdict, /DL steady: IAM/);
  assert.match(model.verdict, /Upload: Orange/);
  assert.match(model.verdict, /Reliability: tie/);
  assert.match(model.verdict, /Load: IAM/);
});

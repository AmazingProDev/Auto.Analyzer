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
  assert.match(model.verdict, /DL avg: INWI/);
  assert.match(model.verdict, /DL steady: IAM/);
  assert.match(model.verdict, /Upload: Orange/);
  assert.match(model.verdict, /Reliability: tie/);
  assert.match(model.verdict, /Load: IAM/);
});

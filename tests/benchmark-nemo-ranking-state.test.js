const test = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizeBenchmarkNemoRankingMetric,
  buildBenchmarkNemoRankingRows,
} = require("../benchmark_nemo_ranking_state.js");

test("normalizeBenchmarkNemoRankingMetric always resolves to app_rate_dl", () => {
  assert.equal(
    normalizeBenchmarkNemoRankingMetric(undefined),
    "app_rate_dl",
  );
  // The removed "App rate DL avg" metric now normalizes to App. rate DL.
  assert.equal(
    normalizeBenchmarkNemoRankingMetric("app_rate_dl_avg"),
    "app_rate_dl",
  );
});

test("buildBenchmarkNemoRankingRows uses the DT-weighted App. rate DL (avgDlMbps)", () => {
  const rows = buildBenchmarkNemoRankingRows(
    [
      { operator: "IAM", avgDlMbps: 50, avgDlAppRateMbps: 150 },
      { operator: "Orange", avgDlMbps: 80, avgDlAppRateMbps: 120 },
    ],
    undefined,
  );
  assert.deepEqual(
    rows.map((row) => row.value),
    [50, 80],
  );
});

test("buildBenchmarkNemoRankingRows ignores the legacy avg metric", () => {
  const rows = buildBenchmarkNemoRankingRows(
    [
      { operator: "IAM", avgDlMbps: 50, avgDlAppRateMbps: 150 },
      { operator: "Orange", avgDlMbps: 80, avgDlAppRateMbps: 120 },
    ],
    "app_rate_dl_avg",
  );
  // The removed avg metric no longer changes the displayed value.
  assert.deepEqual(
    rows.map((row) => row.value),
    [50, 80],
  );
});

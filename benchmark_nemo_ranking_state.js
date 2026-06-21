(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.BenchmarkNemoRankingState = Object.assign(
      {},
      root.BenchmarkNemoRankingState || {},
      api,
    );
  }
})(
  typeof globalThis !== "undefined" ? globalThis : this,
  function () {
    // DL throughput is computed only from "App. rate DL". The "App rate DL avg" metric
    // was removed at the user's request, so every value normalizes to app_rate_dl.
    const DEFAULT_METRIC = "app_rate_dl";
    const VALID_METRICS = new Set(["app_rate_dl"]);

    function normalizeBenchmarkNemoRankingMetric(metric) {
      return VALID_METRICS.has(metric) ? metric : DEFAULT_METRIC;
    }

    function buildBenchmarkNemoRankingRows(rankingRows, metric) {
      const selectedMetric = normalizeBenchmarkNemoRankingMetric(metric);
      // avgDlMbps is the DT-weighted "App. rate DL" average that the deep analysis / KPI
      // table also use — keep the ranking chart consistent with them.
      return (Array.isArray(rankingRows) ? rankingRows : []).map((row) => ({
        ...row,
        selectedMetric,
        aggMethod: row?.avgDlAggMethod || "dt_weighted",
        pooledValue:
          row?.avgDlPooledMbps != null ? Number(row.avgDlPooledMbps) : null,
        pooledAggMethod: row?.avgDlPooledAggMethod || "pooled",
        value: Number(row?.avgDlMbps || 0),
      }));
    }

    return {
      DEFAULT_BENCHMARK_NEMO_RANKING_METRIC: DEFAULT_METRIC,
      normalizeBenchmarkNemoRankingMetric,
      buildBenchmarkNemoRankingRows,
    };
  },
);

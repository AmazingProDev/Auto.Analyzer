(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.BenchmarkNemoUiState = Object.assign(
      {},
      root.BenchmarkNemoUiState || {},
      api,
    );
  }
})(
  typeof globalThis !== "undefined" ? globalThis : this,
  function () {
    const BENCHMARK_NEMO_SECTION_KEYS = ["throughput", "reliability", "rf"];

    function normalizeBenchmarkNemoDtScopeIndex(scopeIndex) {
      if (scopeIndex === null || scopeIndex === undefined || scopeIndex === "") {
        return -1;
      }
      const parsed = Number(scopeIndex);
      if (!Number.isFinite(parsed)) {
        return -1;
      }
      const normalized = Math.trunc(parsed);
      return normalized >= 0 ? normalized : -1;
    }

    function resolveBenchmarkNemoModeReloadState(scopeIndex) {
      const preservedDtScopeIndex =
        normalizeBenchmarkNemoDtScopeIndex(scopeIndex);
      return {
        preservedDtScopeIndex,
        keepScopedView: preservedDtScopeIndex >= 0,
      };
    }

    function normalizeBenchmarkNemoSectionCollapsed(state) {
      const raw = state && typeof state === "object" ? state : {};
      return BENCHMARK_NEMO_SECTION_KEYS.reduce((acc, key) => {
        acc[key] = Boolean(raw[key]);
        return acc;
      }, {});
    }

    function toggleBenchmarkNemoSectionCollapsed(state, sectionKey) {
      const normalized = normalizeBenchmarkNemoSectionCollapsed(state);
      if (!BENCHMARK_NEMO_SECTION_KEYS.includes(sectionKey)) {
        return normalized;
      }
      return {
        ...normalized,
        [sectionKey]: !normalized[sectionKey],
      };
    }

    return {
      BENCHMARK_NEMO_SECTION_KEYS,
      normalizeBenchmarkNemoDtScopeIndex,
      resolveBenchmarkNemoModeReloadState,
      normalizeBenchmarkNemoSectionCollapsed,
      toggleBenchmarkNemoSectionCollapsed,
    };
  },
);

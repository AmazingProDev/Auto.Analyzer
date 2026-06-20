const test = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizeBenchmarkNemoSectionCollapsed,
  toggleBenchmarkNemoSectionCollapsed,
} = require("../benchmark_nemo_ui_state.js");

test("normalizeBenchmarkNemoSectionCollapsed keeps only known collapsed flags", () => {
  const normalized = normalizeBenchmarkNemoSectionCollapsed({
    throughput: true,
    reliability: 0,
    rf: "yes",
    extra: true,
  });

  assert.deepEqual(normalized, {
    throughput: true,
    reliability: false,
    rf: true,
  });
});

test("toggleBenchmarkNemoSectionCollapsed flips one section without mutating peers", () => {
  const state = { throughput: false, reliability: true, rf: false };

  assert.deepEqual(toggleBenchmarkNemoSectionCollapsed(state, "throughput"), {
    throughput: true,
    reliability: true,
    rf: false,
  });
});

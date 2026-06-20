const test = require("node:test");
const assert = require("node:assert/strict");

const {
  getServingMatchMaxDistanceMeters,
  pickPlausibleSiteCandidate,
} = require("../site_match_utils");

test("L1800 serving-site sanity limit rejects very far candidates", () => {
  assert.equal(getServingMatchMaxDistanceMeters(1320), 5000);

  const farCandidate = {
    cellName: "CoMPT_CAS_BRIGADETITTMLLIL",
    lat: 33.754463,
    lng: -7.277427,
    freq: 1320,
    tech: "4G",
  };

  const match = pickPlausibleSiteCandidate([farCandidate], {
    lat: 33.672272,
    lng: -7.386638,
    earfcn: 1320,
    tech: "4G",
  });

  assert.equal(match, null);
});

test("nearest plausible candidate is kept when within sanity limit", () => {
  const nearCandidate = {
    cellName: "Near_L1800_Cell",
    lat: 33.678,
    lng: -7.392,
    freq: 1320,
    tech: "4G",
  };
  const farCandidate = {
    cellName: "Far_L1800_Cell",
    lat: 33.754463,
    lng: -7.277427,
    freq: 1320,
    tech: "4G",
  };

  const match = pickPlausibleSiteCandidate([farCandidate, nearCandidate], {
    lat: 33.672272,
    lng: -7.386638,
    earfcn: 1320,
    tech: "4G",
  });

  assert.ok(match);
  assert.equal(match.cellName, "Near_L1800_Cell");
  assert.ok(match._dist_m < 5000);
});

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.siteMatchUtils = api;
  }
})(
  typeof globalThis !== "undefined"
    ? globalThis
    : typeof window !== "undefined"
      ? window
      : this,
  function () {
    function toFiniteNumber(value) {
      const num = Number(value);
      return Number.isFinite(num) ? num : null;
    }

    function haversineMeters(lat1, lon1, lat2, lon2) {
      const a1 = toFiniteNumber(lat1);
      const o1 = toFiniteNumber(lon1);
      const a2 = toFiniteNumber(lat2);
      const o2 = toFiniteNumber(lon2);
      if (a1 === null || o1 === null || a2 === null || o2 === null) {
        return Infinity;
      }
      const radians = (deg) => (deg * Math.PI) / 180;
      const earthRadiusM = 6371000;
      const dLat = radians(a2 - a1);
      const dLon = radians(o2 - o1);
      const lat1r = radians(a1);
      const lat2r = radians(a2);
      const sinLat = Math.sin(dLat / 2);
      const sinLon = Math.sin(dLon / 2);
      const h =
        sinLat * sinLat +
        Math.cos(lat1r) * Math.cos(lat2r) * sinLon * sinLon;
      return 2 * earthRadiusM * Math.asin(Math.min(1, Math.sqrt(h)));
    }

    function earfcnToBand(earfcn) {
      const e = toFiniteNumber(earfcn);
      if (e === null) return "";
      if (e >= 6150 && e <= 6449) return "L800";
      if (e >= 2750 && e <= 3449) return "L900";
      if (e >= 1200 && e <= 1949) return "L1800";
      if (e >= 300 && e <= 699) return "L2100";
      if (e >= 2400 && e <= 2700) return "L2600";
      if (e >= 3400 && e <= 3799) return "L2600";
      return "";
    }

    function nrArfcnToBand(arfcn) {
      const n = toFiniteNumber(arfcn);
      if (n === null) return "";
      if (n >= 151600 && n <= 160600) return "n28";
      if (n >= 361000 && n <= 376000) return "n3";
      if (n >= 384000 && n <= 396000) return "n1";
      if (n >= 422000 && n <= 440000) return "n1";
      if (n >= 499200 && n <= 537999) return "n41";
      if (n >= 620000 && n <= 680000) return "n78";
      if (n >= 693334 && n <= 733333) return "n79";
      return "";
    }

    function getServingMatchMaxDistanceMeters(earfcn, tech) {
      const techText = String(tech || "").toUpperCase();
      const band =
        techText.includes("5G") || techText.includes("NR")
          ? nrArfcnToBand(earfcn)
          : earfcnToBand(earfcn);
      const limits = {
        L800: 8000,
        L900: 7000,
        L1800: 5000,
        L2100: 4000,
        L2600: 3000,
        n28: 7000,
        n3: 5000,
        n1: 4500,
        n41: 3500,
        n78: 2500,
        n79: 2500,
      };
      if (band && limits[band]) return limits[band];
      if (techText.includes("5G") || techText.includes("NR")) return 4000;
      return 5000;
    }

    function pickPlausibleSiteCandidate(candidates, point, options) {
      if (!Array.isArray(candidates) || !candidates.length) return null;
      const opts = options || {};
      const pointLat = toFiniteNumber(point && point.lat);
      const pointLng = toFiniteNumber(point && point.lng);
      if (pointLat === null || pointLng === null) return candidates[0] || null;

      const pointFreq = toFiniteNumber(
        point && (point.earfcn ?? point.freq ?? point.nrarfcn),
      );
      const pointTech = String(
        (point && (point.tech ?? point.rat)) || opts.tech || "",
      );
      const explicitMax = toFiniteNumber(opts.maxDistanceMeters);
      const decorated = candidates
        .map((candidate) => {
          const dist = haversineMeters(
            pointLat,
            pointLng,
            candidate && candidate.lat,
            candidate && (candidate.lng ?? candidate.lon),
          );
          const freq = toFiniteNumber(
            candidate && (candidate.currentFreq ?? candidate.freq ?? pointFreq),
          );
          const tech = String(
            (candidate && (candidate.tech ?? candidate.rat)) || pointTech,
          );
          const maxDistance =
            explicitMax !== null
              ? explicitMax
              : getServingMatchMaxDistanceMeters(freq, tech);
          return { candidate, dist, maxDistance };
        })
        .sort((a, b) => a.dist - b.dist);

      const best = decorated[0];
      if (!best || !Number.isFinite(best.dist) || best.dist > best.maxDistance) {
        return null;
      }
      return { ...best.candidate, _dist_m: best.dist };
    }

    return {
      haversineMeters,
      getServingMatchMaxDistanceMeters,
      pickPlausibleSiteCandidate,
    };
  },
);

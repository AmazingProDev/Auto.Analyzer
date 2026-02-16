(function (root, factory) {
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = factory();
    } else {
        root.trpThroughputUtils = factory();
    }
}(typeof window !== 'undefined' ? window : globalThis, function () {
    function isFiniteNum(v) {
        return Number.isFinite(Number(v));
    }

    function toEpochMs(v) {
        const t = new Date(v || '').getTime();
        return Number.isFinite(t) ? t : null;
    }

    function percentile(values, p) {
        const arr = (values || []).filter(isFiniteNum).map(Number).sort((a, b) => a - b);
        if (!arr.length) return null;
        const idx = Math.min(arr.length - 1, Math.max(0, Math.floor((p / 100) * (arr.length - 1))));
        return arr[idx];
    }

    function normalizeThroughputPoints(points) {
        const raw = (points || []).filter(p => isFiniteNum(p && p.y));
        const vals = raw.map(p => Number(p.y)).filter(v => v > 0).sort((a, b) => a - b);
        const median = vals.length ? vals[Math.floor(vals.length / 2)] : 0;
        let divisor = 1;
        let unitLabel = 'Mbps (raw)';
        if (median >= 1000000) {
            divisor = 1000000;
            unitLabel = 'Mbps';
        } else if (median >= 1000) {
            divisor = 1000;
            unitLabel = 'Mbps';
        }
        return {
            divisor,
            unitLabel,
            points: raw.map(p => ({ x: p.x, y: Number(p.y) / divisor }))
        };
    }

    function summarizeThroughput(pointsMbps, lowThresholdMbps) {
        const vals = (pointsMbps || []).map(p => Number(p.y)).filter(isFiniteNum);
        if (!vals.length) {
            return {
                avg: null,
                median: null,
                p10: null,
                p90: null,
                peak: null,
                pct_below_5: null,
                sample_count: 0
            };
        }
        const sum = vals.reduce((a, b) => a + b, 0);
        const below = vals.filter(v => v < Number(lowThresholdMbps || 5)).length;
        return {
            avg: sum / vals.length,
            median: percentile(vals, 50),
            p10: percentile(vals, 10),
            p90: percentile(vals, 90),
            peak: Math.max(...vals),
            pct_below_5: (below / vals.length) * 100,
            sample_count: vals.length
        };
    }

    function detectDips(pointsMbps, thresholdMbps, minDurationSec) {
        const out = [];
        const pts = (pointsMbps || []).filter(p => isFiniteNum(p && p.y) && toEpochMs(p.x) !== null);
        if (!pts.length) return out;

        let startIdx = -1;
        let minVal = Infinity;
        for (let i = 0; i < pts.length; i++) {
            const val = Number(pts[i].y);
            const isDip = val < thresholdMbps;
            if (isDip) {
                if (startIdx < 0) {
                    startIdx = i;
                    minVal = val;
                } else {
                    minVal = Math.min(minVal, val);
                }
            }
            const endsDip = startIdx >= 0 && (!isDip || i === pts.length - 1);
            if (endsDip) {
                const endIdx = isDip && i === pts.length - 1 ? i : i - 1;
                const t0 = toEpochMs(pts[startIdx].x);
                const t1 = toEpochMs(pts[endIdx].x);
                const durSec = t0 !== null && t1 !== null ? Math.max(0, (t1 - t0) / 1000) : 0;
                if (durSec >= Number(minDurationSec || 3)) {
                    out.push({
                        start: pts[startIdx].x,
                        end: pts[endIdx].x,
                        min: Number.isFinite(minVal) ? minVal : null,
                        duration_sec: durSec,
                        startIndex: startIdx,
                        endIndex: endIdx
                    });
                }
                startIdx = -1;
                minVal = Infinity;
            }
        }
        return out;
    }

    function alignSeriesBySecond(a, b) {
        const mapB = new Map();
        (b || []).forEach(p => {
            const t = toEpochMs(p && p.x);
            const v = Number(p && p.y);
            if (t === null || !isFiniteNum(v)) return;
            mapB.set(Math.floor(t / 1000), v);
        });
        const out = [];
        (a || []).forEach(p => {
            const t = toEpochMs(p && p.x);
            const v = Number(p && p.y);
            if (t === null || !isFiniteNum(v)) return;
            const key = Math.floor(t / 1000);
            if (!mapB.has(key)) return;
            out.push({ x: p.x, a: v, b: mapB.get(key) });
        });
        return out;
    }

    function correlation(aVals, bVals) {
        const n = Math.min((aVals || []).length, (bVals || []).length);
        if (n < 3) return null;
        const a = aVals.slice(0, n);
        const b = bVals.slice(0, n);
        const meanA = a.reduce((s, v) => s + v, 0) / n;
        const meanB = b.reduce((s, v) => s + v, 0) / n;
        let num = 0;
        let denA = 0;
        let denB = 0;
        for (let i = 0; i < n; i++) {
            const da = a[i] - meanA;
            const db = b[i] - meanB;
            num += da * db;
            denA += da * da;
            denB += db * db;
        }
        if (denA <= 0 || denB <= 0) return null;
        return num / Math.sqrt(denA * denB);
    }

    function mismatchVerdict(alignedPoints) {
        const rows = (alignedPoints || []).filter(r => isFiniteNum(r.a) && isFiniteNum(r.b) && Number(r.a) > 0);
        if (!rows.length) {
            return { flag: 'mixed', ratio_median: null, app_lt_70_ratio_pct: null, correlation: null };
        }
        const ratios = rows.map(r => Number(r.b) / Number(r.a)).filter(isFiniteNum);
        const medianRatio = percentile(ratios, 50);
        const appLt70 = rows.filter(r => Number(r.b) < 0.7 * Number(r.a)).length / rows.length;
        const corr = correlation(rows.map(r => Number(r.a)), rows.map(r => Number(r.b)));
        let flag = 'mixed';
        if (medianRatio !== null && medianRatio < 0.7 && appLt70 > 0.4) flag = 'app-limited';
        else if (medianRatio !== null && medianRatio >= 0.9) flag = 'radio-limited';
        return {
            flag,
            ratio_median: medianRatio,
            app_lt_70_ratio_pct: appLt70 * 100,
            correlation: corr
        };
    }

    function scoreMetricName(name, patterns) {
        const low = String(name || '').toLowerCase();
        let best = { score: -1, source: 'regex' };
        patterns.forEach(p => {
            if (p.type === 'exact' && low === p.value) {
                best = { score: 100, source: 'exact' };
            } else if (p.type === 'contains' && low.includes(p.value) && best.score < 70) {
                best = { score: 70, source: 'regex' };
            } else if (p.type === 'regex' && p.value.test(low) && best.score < 60) {
                best = { score: 60, source: 'regex' };
            }
        });
        return best;
    }

    function discoverThroughputSignals(metricsFlat) {
        const rows = (metricsFlat || []).map(m => ({
            name: String((m && m.name) || ''),
            metric_id: (m && m.metric_id) || null
        })).filter(r => r.name);

        const definitions = {
            dl_radio: [
                { type: 'exact', value: 'radio.lte.servingcelltotal.pdsch.throughput' },
                { type: 'contains', value: 'pdsch.throughput' },
                { type: 'regex', value: /radio\..*downlink.*throughput/ }
            ],
            ul_radio: [
                { type: 'exact', value: 'radio.lte.servingcelltotal.pusch.throughput' },
                { type: 'contains', value: 'pusch.throughput' },
                { type: 'regex', value: /radio\..*uplink.*throughput/ }
            ],
            dl_app: [
                { type: 'exact', value: 'data.http.download.throughput' },
                { type: 'contains', value: 'http.download.throughput' },
                { type: 'regex', value: /(data\.)?(http|ftp|iperf).*?(download|downlink|dl).*?(throughput|bitrate|thp)/ }
            ],
            ul_app: [
                { type: 'exact', value: 'data.http.upload.throughput' },
                { type: 'contains', value: 'http.upload.throughput' },
                { type: 'regex', value: /(data\.)?(http|ftp|iperf).*?(upload|uplink|ul).*?(throughput|bitrate|thp)/ }
            ]
        };

        const out = {};
        Object.keys(definitions).forEach(key => {
            let best = null;
            rows.forEach(r => {
                const scored = scoreMetricName(r.name, definitions[key]);
                if (scored.score < 0) return;
                if (!best || scored.score > best.score) {
                    best = {
                        key,
                        name: r.name,
                        metric_id: r.metric_id,
                        score: scored.score,
                        source: scored.source,
                        confidence: Number((scored.score / 100).toFixed(2))
                    };
                }
            });
            out[key] = best;
        });

        const driverRegex = /(sinr|snr|rsrp|rsrq|cqi|mcs|\bri\b|layers|rank|prb|\brb\b|resource\s*block|bler|harq|rlc.*retx|pdcp.*discard)/i;
        const driverSignals = rows.filter(r => driverRegex.test(r.name)).slice(0, 24).map(r => ({
            key: 'driver',
            name: r.name,
            metric_id: r.metric_id,
            score: 55,
            source: 'regex',
            confidence: 0.55
        }));

        return {
            primary: out,
            drivers: driverSignals,
            used: Object.values(out).filter(Boolean).concat(driverSignals)
        };
    }

    function filterInterestingEvents(events) {
        const re = /(rrc|idle|connected|handover|\bho\b|rlf|re-?establish|cell|pci|earfcn)/i;
        return (events || []).filter(e => re.test(String((e && e.event_name) || '')));
    }

    function compileRegexList(list) {
        return (list || []).map(p => {
            try {
                return new RegExp(String(p), 'i');
            } catch (_e) {
                return null;
            }
        }).filter(Boolean);
    }

    function normalizeMetricSeries(points, normalization) {
        const raw = (points || []).filter(p => isFiniteNum(p && p.y)).map(p => ({ x: p.x, y: Number(p.y), raw_y: Number(p.y) }));
        const vals = raw.map(p => p.y);
        const median = percentile(vals, 50) || 0;
        let unit = normalization || 'unitless';
        let conversion = 'none';

        if (normalization === 'Mbps') {
            if (median >= 1000000) {
                raw.forEach(p => { p.y = p.y / 1000000; });
                conversion = 'bps->Mbps';
            } else if (median >= 1000) {
                raw.forEach(p => { p.y = p.y / 1000; });
                conversion = 'kbps->Mbps';
            } else {
                conversion = 'already-Mbps';
            }
            unit = 'Mbps';
        } else if (normalization === 'percent') {
            if (median <= 1.0) {
                raw.forEach(p => { p.y = p.y * 100; });
                conversion = 'fraction->percent';
            } else {
                conversion = 'already-percent';
            }
            unit = '%';
        } else if (normalization === 'ms') {
            if (median > 10000) conversion = 'warning-possible-microseconds';
            unit = 'ms';
        }

        return { points: raw, unit, raw_median: median, conversion };
    }

    function runSanityChecks(key, points) {
        const vals = (points || []).map(p => Number(p.y)).filter(isFiniteNum);
        if (!vals.length) return { pass: true, checks: ['No numeric samples'] };
        const min = Math.min(...vals);
        const max = Math.max(...vals);
        const checks = [];
        let pass = true;
        const lowKey = String(key || '').toLowerCase();
        const assertRange = (lo, hi, label) => {
            if (min < lo || max > hi) {
                pass = false;
                checks.push(`${label}: out-of-range [${min.toFixed(2)}, ${max.toFixed(2)}], expected ${lo}..${hi}`);
            } else {
                checks.push(`${label}: ok`);
            }
        };
        if (lowKey.includes('cqi')) assertRange(0, 15, 'CQI');
        if (lowKey.includes('ri') || lowKey.includes('rank')) assertRange(0, 4, 'RI/Rank');
        if (lowKey.includes('mcs')) assertRange(0, 31, 'MCS');
        if (lowKey.includes('bler')) assertRange(0, 100, 'BLER');
        if (lowKey.includes('code_rate') || lowKey.includes('code')) assertRange(0, 120, 'Code rate');
        if (lowKey.includes('prb') || lowKey.includes('rb')) assertRange(0, 300, 'PRB/RB');
        if (lowKey.includes('rtt') || lowKey.includes('jitter')) assertRange(0, 2000, 'RTT/Jitter');
        if (lowKey.includes('loss')) assertRange(0, 100, 'Packet loss');
        if (!checks.length) checks.push('No rule for this KPI key');
        return { pass, checks };
    }

    function joinSeriesWithTrack(track, series, toleranceMs) {
        const tol = Number.isFinite(Number(toleranceMs)) ? Number(toleranceMs) : 500;
        const tr = (track || []).map(p => ({ ...p, _t: toEpochMs(p.t || p.time) })).filter(p => Number.isFinite(p._t));
        const sr = (series || []).map(p => ({ ...p, _t: toEpochMs(p.t || p.x || p.time) })).filter(p => Number.isFinite(p._t));
        if (!tr.length || !sr.length) return [];
        let j = 0;
        const out = [];
        for (let i = 0; i < tr.length; i++) {
            const t = tr[i];
            while (j + 1 < sr.length && sr[j + 1]._t <= t._t) j++;
            let best = sr[j];
            if (j + 1 < sr.length) {
                const a = sr[j];
                const b = sr[j + 1];
                if (Math.abs(b._t - t._t) < Math.abs(a._t - t._t)) best = b;
            }
            if (best && Math.abs(best._t - t._t) <= tol) {
                out.push({
                    t: t.t || t.time,
                    lat: t.lat,
                    lon: t.lon,
                    value: Number(best.y !== undefined ? best.y : best.value),
                    raw_value: best.raw_y !== undefined ? best.raw_y : best.raw_value
                });
            }
        }
        return out;
    }

    function inferStateChangeEvents(series, label, diffThreshold) {
        const thr = Number.isFinite(Number(diffThreshold)) ? Number(diffThreshold) : 0;
        const rows = (series || []).filter(p => isFiniteNum(p && p.y));
        const out = [];
        for (let i = 1; i < rows.length; i++) {
            const prev = Number(rows[i - 1].y);
            const cur = Number(rows[i].y);
            if (Math.abs(cur - prev) > thr) {
                out.push({
                    t: rows[i].x || rows[i].t || rows[i].time,
                    kind: label,
                    details: { from: prev, to: cur }
                });
            }
        }
        return out;
    }

    
    // ------------------------------
    // Default map legends per metric/event key
    // ------------------------------
    const _LEGEND_COLORS_5 = ['#1d4ed8', '#0284c7', '#22c55e', '#f59e0b', '#ef4444'];
    const _LEGEND_COLORS_4 = ['#0284c7', '#22c55e', '#f59e0b', '#ef4444'];

    const LEGEND_PRESETS = {
        // PHY
        kpi_cqi_dl: { kind: 'binned', unit: 'CQI', bins: [
            { min: 0, max: 3, label: 'Poor (0–3)' },
            { min: 4, max: 6, label: 'Fair (4–6)' },
            { min: 7, max: 9, label: 'Good (7–9)' },
            { min: 10, max: 12, label: 'Very Good (10–12)' },
            { min: 13, max: 15, label: 'Excellent (13–15)' }
        ]},
        kpi_mcs_dl: { kind: 'binned', unit: 'MCS', bins: [
            { min: 0, max: 5, label: 'Very Low (0–5)' },
            { min: 6, max: 10, label: 'Low (6–10)' },
            { min: 11, max: 15, label: 'Medium (11–15)' },
            { min: 16, max: 20, label: 'High (16–20)' },
            { min: 21, max: 31, label: 'Very High (21–31)' }
        ]},
        kpi_mcs_ul: { kind: 'binned', unit: 'MCS', bins: [
            { min: 0, max: 5, label: 'Very Low (0–5)' },
            { min: 6, max: 10, label: 'Low (6–10)' },
            { min: 11, max: 15, label: 'Medium (11–15)' },
            { min: 16, max: 20, label: 'High (16–20)' },
            { min: 21, max: 31, label: 'Very High (21–31)' }
        ]},
        kpi_modulation: { kind: 'categorical', unit: 'Mod', categories: [
            { value: 'QPSK', label: 'QPSK' },
            { value: '16QAM', label: '16QAM' },
            { value: '64QAM', label: '64QAM' },
            { value: '256QAM', label: '256QAM' }
        ]},
        kpi_pci: { kind: 'categorical_dynamic', unit: 'PCI', maxCategories: 8 },
        kpi_earfcn: { kind: 'categorical_dynamic', unit: 'EARFCN', maxCategories: 8 },
        kpi_timing_advance: { kind: 'binned', unit: 'TA', bins: [
            { min: 0, max: 50, label: 'Near (0–50)' },
            { min: 51, max: 200, label: 'Mid (51–200)' },
            { min: 201, max: 500, label: 'Far (201–500)' },
            { min: 501, max: 900, label: 'Very Far (501–900)' },
            { min: 901, max: 1282, label: 'Extreme (901–1282)' }
        ]},
        // MIMO/CA
        kpi_pmi: { kind: 'auto_percentile', unit: 'PMI', bins: 5 },
        kpi_rank_layers: { kind: 'categorical', unit: 'Rank', categories: [
            { value: 1, label: 'Rank 1' },
            { value: 2, label: 'Rank 2' },
            { value: 3, label: 'Rank 3' },
            { value: 4, label: 'Rank 4' }
        ]},
        // Reliability
        kpi_bler_dl: { kind: 'binned_percent', unit: '%', bins: [
            { min: 0, max: 1, label: 'Excellent (≤1%)' },
            { min: 1, max: 5, label: 'Good (1–5%)' },
            { min: 5, max: 10, label: 'OK (5–10%)' },
            { min: 10, max: 20, label: 'Poor (10–20%)' },
            { min: 20, max: 100, label: 'Bad (>20%)' }
        ]},
        // Events (marker legend)
        ev_handover: { kind: 'event', unit: '', categories: [
            { value: 'HO', label: 'Handover' }
        ]},
        ev_pci_change: { kind: 'event', unit: '', categories: [
            { value: 'PCI', label: 'PCI Change' }
        ]},
        ev_earfcn_change: { kind: 'event', unit: '', categories: [
            { value: 'EARFCN', label: 'EARFCN Change' }
        ]},
        ev_rrc_state: { kind: 'event', unit: '', categories: [
            { value: 'RRC', label: 'RRC State Change' }
        ]},
        ev_bearer: { kind: 'event', unit: '', categories: [
            { value: 'Bearer', label: 'Bearer / EPS Bearer' }
        ]},
        ev_ta_jumps: { kind: 'event', unit: '', categories: [
            { value: 'TA', label: 'TA Jump' }
        ]}
    };

    function _hashColor(str) {
        const s = String(str ?? '');
        let h = 2166136261;
        for (let i = 0; i < s.length; i++) h = (h ^ s.charCodeAt(i)) * 16777619;
        const palette = ['#22d3ee', '#a78bfa', '#34d399', '#fb7185', '#f59e0b', '#60a5fa', '#f472b6', '#c084fc'];
        return palette[Math.abs(h) % palette.length];
    }

    function buildDefaultLegend(key, unit, valuesOrPoints) {
        const preset = LEGEND_PRESETS[key];
        const vals = (valuesOrPoints || []).map(p => (p && typeof p === 'object' ? (p.y ?? p.value) : p))
            .map(Number).filter(v => Number.isFinite(v));

        // Stats for verification / display
        const stats = vals.length ? {
            min: Math.min(...vals),
            max: Math.max(...vals),
            median: vals.slice().sort((a,b)=>a-b)[Math.floor(vals.length*0.5)]
        } : { min: null, max: null, median: null };

        // If BLER percent-like, ensure unit '%'
        if (preset && preset.kind === 'binned_percent') {
            return { ...preset, unit: '%', colors: _LEGEND_COLORS_5, stats, source: 'preset' };
        }

        if (preset && preset.kind === 'binned') {
            return { ...preset, unit: preset.unit || unit || '', colors: _LEGEND_COLORS_5, stats, source: 'preset' };
        }

        if (preset && preset.kind === 'categorical') {
            // category colors by fixed list order
            const cats = preset.categories || [];
            return {
                ...preset,
                unit: preset.unit || unit || '',
                categories: cats.map((c, i) => ({ ...c, color: _LEGEND_COLORS_4[i % _LEGEND_COLORS_4.length] })),
                stats,
                source: 'preset'
            };
        }

        if (preset && preset.kind === 'categorical_dynamic') {
            // Build categories from observed values (top N by frequency)
            const freq = new Map();
            vals.forEach(v => freq.set(String(v), (freq.get(String(v)) || 0) + 1));
            const ordered = Array.from(freq.entries()).sort((a,b)=>b[1]-a[1]).slice(0, preset.maxCategories || 8);
            const categories = ordered.map(([v,_c]) => ({ value: v, label: v, color: _hashColor(v) }));
            return { ...preset, unit: preset.unit || unit || '', categories, stats, source: 'dynamic' };
        }

        if (preset && preset.kind === 'event') {
            const categories = (preset.categories || []).map((c, i) => ({ ...c, color: _LEGEND_COLORS_4[i % _LEGEND_COLORS_4.length] }));
            return { ...preset, categories, stats, source: 'preset' };
        }

        // Auto percentile fallback (continuous)
        if (vals.length >= 10) {
            const sorted = vals.slice().sort((a,b)=>a-b);
            const p10 = percentile(sorted, 10);
            const p30 = percentile(sorted, 30);
            const p50 = percentile(sorted, 50);
            const p70 = percentile(sorted, 70);
            const p90 = percentile(sorted, 90);
            const bins = [
                { min: -Infinity, max: p10, label: 'Very Low' },
                { min: p10, max: p30, label: 'Low' },
                { min: p30, max: p70, label: 'Medium' },
                { min: p70, max: p90, label: 'High' },
                { min: p90, max: Infinity, label: 'Very High' }
            ];
            return { kind: 'binned', unit: unit || '', bins, colors: _LEGEND_COLORS_5, stats, source: 'auto_percentile' };
        }

        return { kind: 'binned', unit: unit || '', bins: [{min:-Infinity,max:Infinity,label:'All values'}], colors: ['#22c55e'], stats, source: 'auto_flat' };
    }

    function classifyValueToLegend(value, legend) {
        if (!legend) return { color: '#22c55e', label: '' };
        const v = value;
        if (legend.kind === 'binned' || legend.kind === 'binned_percent') {
            const bins = legend.bins || [];
            for (let i = 0; i < bins.length; i++) {
                const b = bins[i];
                if (Number(v) >= Number(b.min) && Number(v) <= Number(b.max)) {
                    return { color: (legend.colors && legend.colors[i]) || _LEGEND_COLORS_5[i % 5], label: b.label || '' };
                }
            }
            // edge: Infinity bins
            for (let i = 0; i < bins.length; i++) {
                const b = bins[i];
                if (Number(v) > Number(b.min) && (b.max === Infinity || Number(v) < Number(b.max))) {
                    return { color: (legend.colors && legend.colors[i]) || _LEGEND_COLORS_5[i % 5], label: b.label || '' };
                }
            }
            return { color: (legend.colors && legend.colors[legend.colors.length-1]) || _LEGEND_COLORS_5[4], label: bins[bins.length-1]?.label || '' };
        }
        if (legend.kind.startsWith('categorical')) {
            const cats = legend.categories || [];
            const s = String(v);
            const found = cats.find(c => String(c.value) === s || String(c.label) === s);
            if (found) return { color: found.color || _hashColor(s), label: found.label || s };
            return { color: _hashColor(s), label: s };
        }
        return { color: '#22c55e', label: '' };
    }

    function legendToHtml(legend) {
        if (!legend) return '';
        const unit = legend.unit ? ' ' + unitEscape(String(legend.unit)) : '';
        if (legend.kind === 'event') {
            const cats = legend.categories || [];
            const rows = cats.map(c =>
                '<div class="driver-legend-row"><span class="driver-swatch" style="background:' + unitEscape(c.color || '#22c55e') + ';"></span>' +
                '<span>' + unitEscape(c.label || c.value || '') + '</span></div>'
            ).join('');
            return '<div class="driver-legend"><div class="driver-legend-title">Legend</div>' + rows + '</div>';
        }
        if (legend.kind.startsWith('categorical')) {
            const cats = legend.categories || [];
            const rows = cats.map(c =>
                '<div class="driver-legend-row"><span class="driver-swatch" style="background:' + unitEscape(c.color || '#22c55e') + ';"></span>' +
                '<span>' + unitEscape(c.label || c.value || '') + '</span></div>'
            ).join('');
            return '<div class="driver-legend"><div class="driver-legend-title">Legend</div>' + rows + '</div>';
        }
        const bins = legend.bins || [];
        const rows = bins.map((b, i) => {
            const range = (b.min === -Infinity ? '≤ ' + fmtNum(b.max) : (b.max === Infinity ? '> ' + fmtNum(b.min) : fmtNum(b.min) + '–' + fmtNum(b.max)));
            return '<div class="driver-legend-row"><span class="driver-swatch" style="background:' + unitEscape((legend.colors && legend.colors[i]) || _LEGEND_COLORS_5[i % 5]) + ';"></span>' +
                '<span>' + unitEscape(b.label || '') + '</span>' +
                '<span class="driver-legend-range">' + unitEscape(range) + unit + '</span></div>';
        }).join('');
        return '<div class="driver-legend"><div class="driver-legend-title">Legend</div>' + rows + '</div>';
    }

    // Use existing escape/formatters if present; fallback to local
    function unitEscape(s) { return String(s).replace(/[&<>"']/g, (m)=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m])); }
    function fmtNum(x, d=2) { const n = Number(x); if (!Number.isFinite(n)) return ''; return n.toFixed(d).replace(/\.0+$/,'').replace(/(\.[0-9]*?)0+$/,'$1'); }


return {
        toEpochMs,
        percentile,
        normalizeThroughputPoints,
        summarizeThroughput,
        detectDips,
        alignSeriesBySecond,
        mismatchVerdict,
        discoverThroughputSignals,
        filterInterestingEvents,
        compileRegexList,
        normalizeMetricSeries,
        runSanityChecks,
        joinSeriesWithTrack,
        inferStateChangeEvents,
        buildDefaultLegend,
        classifyValueToLegend,
        legendToHtml
    };
}));

document.addEventListener('DOMContentLoaded', () => {
    const fileInput = document.getElementById('fileInput');
    const fileStatus = document.getElementById('fileStatus');
    const logsList = document.getElementById('logsList');
    // define custom projection
    if (window.proj4) {
        window.proj4.defs("EPSG:32629", "+proj=utm +zone=29 +north +datum=WGS84 +units=m +no_defs");
    }

    const shpInput = document.getElementById('shpInput');

    // Initialize Map
    const map = new MapRenderer('map');
    window.map = map.map; // Expose Leaflet instance globally for inline onclicks
    window.mapRenderer = map; // Expose Renderer helper for debugging/verification

    // ------------------------------
    // Dynamic SmartCare Thresholds
    // ------------------------------
    const normalizeKey = (k) => k.toLowerCase().replace(/[\s\-_()%]/g, '');

    const resolveMetricKeys = (points, metricAliases) => {
        const keyMap = {};
        if (!points || points.length === 0) return keyMap;
        const sample = points.find(p => p && typeof p === 'object') || points[0];
        if (!sample) return keyMap;
        const keys = Object.keys(sample);
        const norm = keys.map(k => [k, normalizeKey(k)]);

        Object.entries(metricAliases).forEach(([metric, aliases]) => {
            for (const a of aliases) {
                const na = normalizeKey(a);
                const found = norm.find(([, nk]) => nk === na || nk.includes(na));
                if (found) {
                    keyMap[metric] = found[0];
                    break;
                }
            }
        });
        return keyMap;
    };

    const collectMetric = (points, key) => {
        const arr = [];
        if (!key) return arr;
        for (let i = 0; i < points.length; i++) {
            const v = parseFloat(points[i][key]);
            if (!Number.isNaN(v)) arr.push(v);
        }
        return arr;
    };

    const quantile = (arr, q) => {
        if (!arr || arr.length === 0) return null;
        const a = arr.slice().sort((x, y) => x - y);
        const pos = (a.length - 1) * q;
        const base = Math.floor(pos);
        const rest = pos - base;
        if (a[base + 1] !== undefined) {
            return a[base] + rest * (a[base + 1] - a[base]);
        }
        return a[base];
    };

    const computeSmartCareThresholds = (points) => {
        const aliases = {
            rsrp: ['Dominant RSRP (dBm)'],
            rsrq: ['Dominant RSRQ (dB)'],
            cqi: ['Average DL Wideband CQI', 'Average DL Wideband CQI (Code Word 0)'],
            dlLow: ['DL Low-Throughput Ratio (%)'],
            ulLow: ['UL Low-Throughput Ratio (%)'],
            dlSpecEff: ['DL Spectrum Efficiency (Kbps/MHz)'],
            ulSpecEff: ['UL Spectrum Efficiency (Kbps/MHz)'],
            dlRB: ['Average DL RB Quantity'],
            ulRB: ['Average UL RB Quantity'],
            dlBler: ['DL IBLER (%)'],
            ulBler: ['UL IBLER (%)'],
            traffic: ['Total Traffic Volume (MB)']
        };

        const keys = resolveMetricKeys(points, aliases);
        const data = {};
        Object.keys(keys).forEach(k => { data[k] = collectMetric(points, keys[k]); });

        return {
            rsrp: { good: quantile(data.rsrp, 0.6), fair: quantile(data.rsrp, 0.3) },
            rsrq: { good: quantile(data.rsrq, 0.6), degraded: quantile(data.rsrq, 0.3) },
            cqi: { good: quantile(data.cqi, 0.6), moderate: quantile(data.cqi, 0.3) },
            dlLow: { severe: quantile(data.dlLow, 0.8), degraded: quantile(data.dlLow, 0.6) },
            ulLow: { severe: quantile(data.ulLow, 0.8), degraded: quantile(data.ulLow, 0.6) },
            dlSpecEff: { veryLow: quantile(data.dlSpecEff, 0.2), low: quantile(data.dlSpecEff, 0.4) },
            ulSpecEff: { low: quantile(data.ulSpecEff, 0.4) },
            dlRB: { veryLow: quantile(data.dlRB, 0.2), moderate: quantile(data.dlRB, 0.6), congested: quantile(data.dlRB, 0.8) },
            ulRB: { veryLow: quantile(data.ulRB, 0.2), moderate: quantile(data.ulRB, 0.6), congested: quantile(data.ulRB, 0.8) },
            bler: { degraded: quantile(data.dlBler, 0.7), unstable: quantile(data.dlBler, 0.85) },
            traffic: { veryLow: quantile(data.traffic, 0.1), low: quantile(data.traffic, 0.2) }
        };
    };

    // Prevent click-selection during map drag (avoids snap-back)
    window.__mapDragInProgress = false;
    if (window.map) {
        window.map.on('movestart', () => { window.__mapDragInProgress = true; });
        window.map.on('moveend', () => {
            setTimeout(() => { window.__mapDragInProgress = false; }, 80);
        });
    }

    // Sidebar resizers (logs + SmartCare)
    const resizers = document.querySelectorAll('.sidebar-resizer');
    let activeResize = null;

    resizers.forEach((resizer) => {
        resizer.addEventListener('mousedown', (e) => {
            const targetId = resizer.getAttribute('data-target');
            const targetEl = document.getElementById(targetId);
            if (!targetEl) return;

            activeResize = {
                target: targetEl,
                startX: e.clientX,
                startWidth: targetEl.getBoundingClientRect().width,
                side: resizer.classList.contains('sidebar-resizer-left') ? 'left' : 'right'
            };
            document.body.style.cursor = 'ew-resize';
            document.body.style.userSelect = 'none';
            e.preventDefault();
            e.stopPropagation();
        });
    });

    document.addEventListener('mousemove', (e) => {
        if (!activeResize) return;
        const dx = e.clientX - activeResize.startX;
        let newWidth = activeResize.startWidth;
        if (activeResize.side === 'right') {
            newWidth = activeResize.startWidth + dx;
        } else {
            newWidth = activeResize.startWidth - dx;
        }

        const minW = 220;
        const maxW = 520;
        newWidth = Math.max(minW, Math.min(maxW, newWidth));
        activeResize.target.style.width = newWidth + 'px';

        if (window.map && typeof window.map.invalidateSize === 'function') {
            window.map.invalidateSize(false);
        }
    });

    document.addEventListener('mouseup', () => {
        if (activeResize) {
            activeResize = null;
            document.body.style.cursor = 'default';
            document.body.style.userSelect = '';
        }
    });

    const getMapClickableEntries = () => {
        const entries = [];
        const order = window.dtLayerOrder || [];
        const pushEntry = (entry, keyHint) => {
            if (!entry || entry.visible === false) return;
            if (!Array.isArray(entry.points) || entry.points.length === 0) return;
            const logId = entry.logId ?? (typeof keyHint === 'string' ? keyHint.split('::')[0] : undefined);
            if (logId === undefined || logId === null || String(logId).trim() === '') return;
            entries.push(Object.assign({}, entry, { logId }));
        };

        if (window.metricLegendEntries) {
            order.forEach(key => pushEntry(window.metricLegendEntries[key], key));
        }
        if (window.eventLegendEntries) {
            Object.keys(window.eventLegendEntries).forEach(key => pushEntry(window.eventLegendEntries[key], key));
        }
        return entries;
    };

    // Fallback map click -> nearest DT/Event point (in case markers are not clickable)
    window.map.on('click', (e) => {
        if (window.__mapDragInProgress) return;
        try {
            const entries = getMapClickableEntries();
            if (entries.length === 0) return;

            const clickPt = window.map.latLngToContainerPoint(e.latlng);
            let best = null;
            let bestDist = Infinity;
            const maxDist = 12;

            for (const entry of entries) {
                const pts = entry.points || [];
                for (let i = 0; i < pts.length; i++) {
                    const p = pts[i];
                    if (p.lat === undefined || p.lat === null || p.lng === undefined || p.lng === null) continue;
                    const pt = window.map.latLngToContainerPoint([p.lat, p.lng]);
                    const dx = pt.x - clickPt.x;
                    const dy = pt.y - clickPt.y;
                    const d2 = dx * dx + dy * dy;
                    if (d2 <= maxDist * maxDist && d2 < bestDist) {
                        bestDist = d2;
                        best = { logId: entry.logId, point: p };
                    }
                }
            }

            if (best) {
                const evt = new CustomEvent('map-point-clicked', {
                    detail: { logId: best.logId, point: best.point, source: 'map_fallback' }
                });
                window.dispatchEvent(evt);
            }
        } catch (err) {
            console.warn('[App] Map click fallback failed:', err);
        }
    });

    // DOM-level click picker to ensure DT point selection even if Leaflet click is blocked
    if (!window.__mapClickPickerInstalled) {
        const mapEl = document.getElementById('map');
        if (mapEl) {
            mapEl.addEventListener('click', (ev) => {
                try {
                    if (window.__mapDragInProgress) return;
                    const target = ev.target;
                    if (target && (
                        target.closest('#draggable-legend') ||
                        target.closest('.modal-content') ||
                        target.closest('#smartcare-sidebar') ||
                        target.closest('#sidebar') ||
                        target.closest('#logs-sidebar')
                    )) {
                        return;
                    }
                    if (!window.map) return;

                    const rect = mapEl.getBoundingClientRect();
                    const x = ev.clientX - rect.left;
                    const y = ev.clientY - rect.top;
                    if (x < 0 || y < 0 || x > rect.width || y > rect.height) return;

                    const entries = getMapClickableEntries();
                    if (entries.length === 0) return;

                    const clickLatLng = window.map.containerPointToLatLng([x, y]);
                    const clickPt = window.map.latLngToContainerPoint(clickLatLng);
                    let best = null;
                    let bestDist = Infinity;
                    const maxDist = 18;

                    for (const entry of entries) {
                        const pts = entry.points || [];
                        for (let i = 0; i < pts.length; i++) {
                            const p = pts[i];
                            if (p.lat === undefined || p.lat === null || p.lng === undefined || p.lng === null) continue;
                            const pt = window.map.latLngToContainerPoint([p.lat, p.lng]);
                            const dx = pt.x - clickPt.x;
                            const dy = pt.y - clickPt.y;
                            const d2 = dx * dx + dy * dy;
                            if (d2 <= maxDist * maxDist && d2 < bestDist) {
                                bestDist = d2;
                                best = { logId: entry.logId, point: p };
                            }
                        }
                    }

                    if (best) {
                        const evt = new CustomEvent('map-point-clicked', {
                            detail: { logId: best.logId, point: best.point, source: 'map_dom' }
                        });
                        window.dispatchEvent(evt);
                    }
                } catch (err) {
                    console.warn('[App] Map DOM click picker failed:', err);
                }
            }, true);
            window.__mapClickPickerInstalled = true;
        }
    }

    // ----------------------------------------------------
    // THEMATIC CONFIGURATION & HELPERS
    // ----------------------------------------------------
    // Helper to map metric names to theme keys
    window.getThresholdKey = (metric) => {
        if (!metric) return 'rsrp';
        const m = metric.toLowerCase();

        // Discrete identity metrics (Cell/Network identifiers)
        if (m.startsWith('__info_') || m.startsWith('__derived_') || m.includes('earfcn') || m.includes('tracking area') || m.includes('tac') || m.includes('enodeb') || m.includes('physical cell') || m.includes('pci') || m === 'cellid' || m.includes('cell id') || m.includes('cellidentity')) return 'discrete';

        // LTE neighbors specific legends
        if (m.includes('radio.lte.neighbor[') && m.endsWith('.rsrp')) return 'neighbor_rsrp';
        if (m.includes('radio.lte.neighbor[') && m.endsWith('.rsrq')) return 'neighbor_rsrq';

        // ---- Explicit KPI-specific legends ----
        // RSRP
        if (m.includes('rsrp') || m.includes('rscp') || m.includes('signallevel') || m.includes('level')) return 'rsrp';

        // RSRQ
        if (m.includes('rsrq')) return 'rsrq';

        // SINR / RS-SINR
        if (m.includes('sinr') || m.includes('rssinr')) return 'sinr';

        // Throughput: split DL vs UL when possible
        if (m.includes('throughput')) {
            if (m.includes('downlink') || m.includes('dl')) return 'dl_throughput';
            if (m.includes('uplink') || m.includes('ul')) return 'ul_throughput';
            return 'throughput'; // generic fallback
        }

        // BLER
        if (m.includes('bler')) return 'bler';

        // ---- Throughput Drivers (LTE PHY/Scheduling) ----
        // CQI
        if (m.includes('cqi')) return 'cqi';

        // MCS
        if (m.includes('mcs')) return 'mcs';

        // Timing Advance
        if (m.includes('timingadvance') || m.includes('timing advance') || m === 'ta' || m.endsWith('_ta') || m.includes('_ta_')) return 'timing_advance';

        // PMI
        if (m.includes('pmi')) return 'pmi';

        // Rank / Layers (incl. proxy)
        if (m.includes('rank') || m.includes('layers') || m.includes('ri')) return 'rank_layers';

        // Modulation is categorical
        if (m.includes('modulation') || m.includes('qam') || m.includes('qpsk')) return 'discrete';

        // Generic quality bucket (UMTS-like)
        if (m.includes('qual') || m.includes('ecno')) return 'quality';

        return 'rsrp';
    };

    // Global Theme Configuration
    window.themeConfig = {
        thresholds: {
            'rsrp': [
                { min: -70, max: undefined, color: '#22c55e', label: 'Excellent (>= -70 dBm)' },
                { min: -85, max: -70, color: '#84cc16', label: 'Good (-85 to -70 dBm)' },
                { min: -95, max: -85, color: '#eab308', label: 'Fair (-95 to -85 dBm)' },
                { min: -105, max: -95, color: '#f97316', label: 'Poor (-105 to -95 dBm)' },
                { min: undefined, max: -105, color: '#ef4444', label: 'Bad (< -105 dBm)' }
            ],
            'level': [
                { min: -70, max: undefined, color: '#22c55e', label: 'Excellent (>= -70)' },      // Green (34,197,94)
                { min: -85, max: -70, color: '#84cc16', label: 'Good (-85 to -70)' },             // Light Green (132,204,22)
                { min: -95, max: -85, color: '#eab308', label: 'Fair (-95 to -85)' },             // Yellow (234,179,8)
                { min: -105, max: -95, color: '#f97316', label: 'Poor (-105 to -95)' },            // Orange (249,115,22)
                { min: undefined, max: -105, color: '#ef4444', label: 'Bad (< -105)' }             // Red (239,68,68)
            ],
            'quality': [
                { min: -10, max: undefined, color: '#22c55e', label: 'Excellent (>= -10)' },
                { min: -15, max: -10, color: '#eab308', label: 'Fair (-15 to -10)' },
                { min: undefined, max: -15, color: '#ef4444', label: 'Poor (< -15)' }
            ],

            'rsrq': [
                { min: -10, max: undefined, color: '#22c55e', label: 'Excellent (>= -10 dB)' },
                { min: -15, max: -10, color: '#84cc16', label: 'Good (-15 to -10 dB)' },
                { min: -20, max: -15, color: '#eab308', label: 'Fair (-20 to -15 dB)' },
                { min: undefined, max: -20, color: '#ef4444', label: 'Poor (< -20 dB)' }
            ],
            // LTE Neighbor presets
            'neighbor_rsrp': [
                { min: -80, max: undefined, color: '#22c55e', label: 'Good (>= -80 dBm)' },
                { min: -90, max: -80, color: '#84cc16', label: 'Fair (-90 to -80 dBm)' },
                { min: -100, max: -90, color: '#eab308', label: 'Weak (-100 to -90 dBm)' },
                { min: -110, max: -100, color: '#f97316', label: 'Poor (-110 to -100 dBm)' },
                { min: undefined, max: -110, color: '#ef4444', label: 'Bad (< -110 dBm)' }
            ],
            'neighbor_rsrq': [
                { min: -10, max: undefined, color: '#22c55e', label: 'Good (>= -10 dB)' },
                { min: -15, max: -10, color: '#84cc16', label: 'Fair (-15 to -10 dB)' },
                { min: -20, max: -15, color: '#f97316', label: 'Poor (-20 to -15 dB)' },
                { min: undefined, max: -20, color: '#ef4444', label: 'Bad (< -20 dB)' }
            ],
            'sinr': [
                { min: 20, max: undefined, color: '#22c55e', label: 'Excellent (>= 20 dB)' },
                { min: 13, max: 20, color: '#84cc16', label: 'Good (13 to 20 dB)' },
                { min: 0, max: 13, color: '#eab308', label: 'Fair (0 to 13 dB)' },
                { min: -3, max: 0, color: '#f97316', label: 'Poor (-3 to 0 dB)' },
                { min: undefined, max: -3, color: '#ef4444', label: 'Bad (< -3 dB)' }
            ],
                        'dl_throughput': [
                { min: 50000, max: undefined, color: '#22c55e', label: 'Excellent (>= 50 Mbps)' },
                { min: 20000, max: 50000, color: '#84cc16', label: 'Very Good (20–50 Mbps)' },
                { min: 10000, max: 20000, color: '#eab308', label: 'Good (10–20 Mbps)' },
                { min: 5000, max: 10000, color: '#f97316', label: 'Fair (5–10 Mbps)' },
                { min: 1000, max: 5000, color: '#ef4444', label: 'Poor (1–5 Mbps)' },
                { min: -Infinity, max: 1000, color: '#991b1b', label: 'Very Poor (< 1 Mbps)' }
            ],
            'ul_throughput': [
                { min: 10000, max: undefined, color: '#22c55e', label: 'Excellent (>= 10 Mbps)' },
                { min: 5000, max: 10000, color: '#84cc16', label: 'Very Good (5–10 Mbps)' },
                { min: 2000, max: 5000, color: '#eab308', label: 'Good (2–5 Mbps)' },
                { min: 1000, max: 2000, color: '#f97316', label: 'Fair (1–2 Mbps)' },
                { min: 500, max: 1000, color: '#ef4444', label: 'Poor (0.5–1 Mbps)' },
                { min: -Infinity, max: 500, color: '#991b1b', label: 'Very Poor (< 0.5 Mbps)' }
            ],
            'throughput': [
                { min: 20000, max: undefined, color: '#22c55e', label: 'Excellent (>= 20000 Kbps)' },
                { min: 10000, max: 20000, color: '#84cc16', label: 'Good (10000-20000 Kbps)' },
                { min: 3000, max: 10000, color: '#eab308', label: 'Fair (3000-10000 Kbps)' },
                { min: 1000, max: 3000, color: '#f97316', label: 'Poor (1000-3000 Kbps)' },
                { min: undefined, max: 1000, color: '#ef4444', label: 'Bad (< 1000 Kbps)' }
            ],
            'bler': [
                { min: undefined, max: 2, color: '#22c55e', label: 'Good (< 2%)' },
                { min: 2, max: 10, color: '#eab308', label: 'Fair (2-10%)' },
                { min: 10, max: undefined, color: '#ef4444', label: 'Bad (> 10%)' }
            ],

            // --- Throughput Drivers & Events defaults ---
            // CQI is typically 0..15
            'cqi': [
                { min: 13, max: undefined, color: '#22c55e', label: 'Excellent (13–15)' },
                { min: 10, max: 13, color: '#84cc16', label: 'Very Good (10–12)' },
                { min: 7, max: 10, color: '#eab308', label: 'Good (7–9)' },
                { min: 4, max: 7, color: '#f97316', label: 'Fair (4–6)' },
                { min: undefined, max: 4, color: '#ef4444', label: 'Poor (0–3)' }
            ],

            // MCS bins (generic LTE-style 0..31)
            'mcs': [
                { min: 21, max: undefined, color: '#22c55e', label: 'Very High (21–31)' },
                { min: 16, max: 21, color: '#84cc16', label: 'High (16–20)' },
                { min: 11, max: 16, color: '#eab308', label: 'Medium (11–15)' },
                { min: 6, max: 11, color: '#f97316', label: 'Low (6–10)' },
                { min: undefined, max: 6, color: '#ef4444', label: 'Very Low (0–5)' }
            ],

            // Timing Advance (index-based)
            'timing_advance': [
                { min: 0, max: 50, color: '#22c55e', label: 'Near (0–50)' },
                { min: 50, max: 200, color: '#84cc16', label: 'Mid (51–200)' },
                { min: 200, max: 500, color: '#eab308', label: 'Far (201–500)' },
                { min: 500, max: 900, color: '#f97316', label: 'Very Far (501–900)' },
                { min: 900, max: undefined, color: '#ef4444', label: 'Extreme (>= 901)' }
            ],

            // PMI (ordinal-ish). Defaults can be adjusted by user.
            'pmi': [
                { min: 12, max: undefined, color: '#22c55e', label: 'High' },
                { min: 8, max: 12, color: '#84cc16', label: 'Medium-High' },
                { min: 4, max: 8, color: '#eab308', label: 'Medium' },
                { min: 1, max: 4, color: '#f97316', label: 'Low' },
                { min: undefined, max: 1, color: '#ef4444', label: 'Very Low' }
            ],

            // Rank/Layers (1..4). Rendered as thresholds for consistent UI.
            'rank_layers': [
                { min: 4, max: undefined, color: '#22c55e', label: 'Rank 4' },
                { min: 3, max: 4, color: '#84cc16', label: 'Rank 3' },
                { min: 2, max: 3, color: '#eab308', label: 'Rank 2' },
                { min: 1, max: 2, color: '#f97316', label: 'Rank 1' },
                { min: undefined, max: 1, color: '#ef4444', label: 'Unknown/0' }
            ]

        }
    };

    // Global Listener for Map Rendering Completion (Async Legend)
    window.addEventListener('layer-metric-ready', (e) => {
        // console.log('[App] layer-metric-ready received for: ' + (e.detail.metric));
        if (typeof window.updateLegend === 'function') {
            window.updateLegend();
        }
        if (typeof window.applyDTLayerOrder === 'function') {
            window.applyDTLayerOrder();
        }
    });

    // Handle Map Point Clicks (Draw Line to Serving Cell)
    window.addEventListener('map-point-clicked', (e) => {
        const { point } = e.detail;
        if (!point || !mapRenderer) return;

        // Calculate Start Point: Prefer Polygon Centroid if available
        let startPt = { lat: point.lat, lng: point.lng };

        if (point.geometry && (point.geometry.type === 'Polygon' || point.geometry.type === 'MultiPolygon')) {
            try {
                // Simple Average of coordinates for Centroid (good enough for small 50m squares)
                let coords = point.geometry.coordinates;
                // Unwrap MultiPolygon outer
                if (point.geometry.type === 'MultiPolygon') coords = coords[0];
                // Unwrap Polygon outer ring
                if (Array.isArray(coords[0])) coords = coords[0];

                if (coords.length > 0) {
                    let sumLat = 0, sumLng = 0, count = 0;
                    coords.forEach(c => {
                        // GeoJSON is [lng, lat]
                        if (c.length >= 2) {
                            sumLng += c[0];
                            sumLat += c[1];
                            count++;
                        }
                    });
                    if (count > 0) {
                        startPt = { lat: sumLat / count, lng: sumLng / count };
                        // console.log("Calculated Centroid:", startPt);
                    }
                }
            } catch (err) {
                console.warn("Failed to calc centroid:", err);
            }
        }

        // 1. Find Serving Cell
        const servingCell = mapRenderer.getServingCell(point);

        if (servingCell) {
            // Only highlight in this legacy path. Point-details renderer owns line drawing/colors.
            const bestId = servingCell.rawEnodebCellId || servingCell.calculatedEci || servingCell.cellId;
            mapRenderer.highlightCell(bestId);
        } else {
            // Do not clear here: point-details resolver can still resolve serving/neighbors
            // with richer LTE key handling and should own the final connection rendering.
            console.warn('[App] Serving Cell not found in legacy click path.');
        }
    });

    // SPIDER SMARTCARE LOGIC
    // SPIDER MODE TOGGLE
    window.isSpiderMode = false; // Default OFF
    const spiderBtn = document.getElementById('spiderSmartCareBtn');
    if (spiderBtn) {
        spiderBtn.onclick = () => {
            window.isSpiderMode = !window.isSpiderMode;
            if (window.isSpiderMode) {
                spiderBtn.classList.remove('btn-red');
                spiderBtn.classList.add('btn-green');
                spiderBtn.innerHTML = '🕸️ Spider: ON';
                // Optional: Clear any existing connections when turning ON? 
                // Usually user wants to CLICK to see them.
            } else {
                spiderBtn.classList.remove('btn-green');
                spiderBtn.classList.add('btn-red');
                spiderBtn.innerHTML = '🕸️ Spider: OFF';
                // Clear connections when turning OFF
                if (window.mapRenderer) {
                    window.mapRenderer.clearConnections();
                }
            }
        };
    }

    // Map Drop Zone Logic
    const mapContainer = document.getElementById('map');
    mapContainer.addEventListener('dragover', (e) => {
        e.preventDefault(); // Allow Drop
        mapContainer.style.boxShadow = 'inset 0 0 20px rgba(59, 130, 246, 0.5)';
    });

    mapContainer.addEventListener('dragleave', (e) => {
        mapContainer.style.boxShadow = 'none';
    });





    // --- CONSOLIDATED KML EXPORT (MODAL) ---
    const exportKmlBtn = document.getElementById('exportKmlBtn');
    if (exportKmlBtn) {
        exportKmlBtn.onclick = (e) => {
            e.preventDefault();
            const modal = document.getElementById('exportKmlModal');
            if (modal) modal.style.display = 'block';
        };
    }

    // Modal Action: Current View
    const btnExportCurrentView = document.getElementById('btnExportCurrentView');
    if (btnExportCurrentView) {
        btnExportCurrentView.onclick = () => {
            const renderer = window.mapRenderer;
            if (!renderer || !renderer.activeLogId || !renderer.activeMetric) {
                alert("No active data to export.");
                return;
            }
            const log = loadedLogs.find(l => l.id === renderer.activeLogId);
            if (!log) {
                alert("Log data not found.");
                return;
            }
            const kml = renderer.exportToKML(renderer.activeLogId, log.points, renderer.activeMetric);
            if (!kml) {
                alert("Failed to generate KML.");
                return;
            }
            const blob = new Blob([kml], { type: 'application/vnd.google-earth.kml+xml' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = (log.name) + '_' + (renderer.activeMetric) + '.kml';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            document.getElementById('exportKmlModal').style.display = 'none'; // Close modal
        };
    }

    // Modal Action: All Sites
    const btnExportAllSites = document.getElementById('btnExportAllSites');
    if (btnExportAllSites) {
        btnExportAllSites.onclick = () => {
            const renderer = window.mapRenderer;
            if (!renderer || !renderer.siteIndex || !renderer.siteIndex.all) {
                alert("No site database loaded.");
                return;
            }

            // Get Active Points to Filter Sites (Requested Feature: "Export only serving sites")
            let activePoints = null;
            if (renderer.activeLogId && window.loadedLogs) {
                const activeLog = window.loadedLogs.find(l => l.id === renderer.activeLogId);
                if (activeLog && activeLog.points) {
                    activePoints = activeLog.points;
                }
            }

            const kml = renderer.exportSitesToKML(activePoints);
            if (!kml) {
                alert("Failed to generate Sites KML.");
                return;
            }
            const blob = new Blob([kml], { type: 'application/vnd.google-earth.kml+xml' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'Sites_Database_' + (new Date().getTime()) + '.kml';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            document.getElementById('exportKmlModal').style.display = 'none'; // Close modal
        };
    }



    // --- CONSOLIDATED IMPORT (MODAL) ---
    const importBtn = document.getElementById('importBtn');
    if (importBtn) {
        importBtn.onclick = (e) => {
            e.preventDefault();
            const modal = document.getElementById('importModal');
            if (modal) modal.style.display = 'block';
        };
    }

    const btnImportSites = document.getElementById('btnImportSites');
    if (btnImportSites) {
        btnImportSites.onclick = () => {
            const siteInput = document.getElementById('siteInput');
            if (siteInput) siteInput.click();
            document.getElementById('importModal').style.display = 'none';
        };
    }

    const btnImportSmartCare = document.getElementById('btnImportSmartCare');
    if (btnImportSmartCare) {
        btnImportSmartCare.onclick = () => {
            const shpInput = document.getElementById('shpInput');
            if (shpInput) shpInput.click();
            document.getElementById('importModal').style.display = 'none';
        };
    }

    const btnImportLog = document.getElementById('btnImportLog');
    if (btnImportLog) {
        btnImportLog.onclick = () => {
            const fileInput = document.getElementById('fileInput');
            if (fileInput) fileInput.click();
            document.getElementById('importModal').style.display = 'none';
        };
    }

    // --- SmartCare SHP/Excel Import Logic ---
    // Initialize Sidebar Logic
    const scSidebar = document.getElementById('smartcare-sidebar');
    const scToggleBtn = document.getElementById('toggleSmartCareSidebar');
    const scLayerList = document.getElementById('smartcare-layer-list');
    const dtLayerList = document.getElementById('dt-layer-list');

    if (scToggleBtn) {
        scToggleBtn.onclick = () => {
            // Minimize/Expand logic could be just hiding the list or sliding
            // For now, let's just slide it out completely or toggle visibility
            // But the request said "hide/unhide it".
            // Let's toggle a class 'minimized' or just hide.
            scSidebar.style.display = 'none'; // Simple hide
        };
    }

    // To show it again, we might need a button in the main header or it auto-shows on import.
    // Let's add an "Show Sidebar" logic if it's hidden?
    // Actually, user asked "possibility to hide/unhide it".
    // Let's assume the button closes it. We might need a way to open it back.
    // For now, let's ensure it opens on import.

    function addSmartCareLayer(log) {
        if (!scSidebar || !scLayerList) return;
        const { name, id: layerId, customMetrics, type, points } = log;
        const techLabel = type === 'excel' ? '4G (Excel)' : 'SHP';
        const pointCount = points ? points.length : 0;

        scSidebar.style.display = 'flex'; // Auto-show

        const item = document.createElement('div');
        item.className = 'sc-layer-group-header expanded'; // Default open on import
        item.id = 'sc-group-' + (layerId);

        // Toggle Logic embedded in onclick
        item.onclick = (e) => {
            // Prevent toggling if clicking specific control buttons
            if (e.target.closest('.sc-btn') || e.target.closest('.sc-metric-button')) return;
            item.classList.toggle('expanded');
        };

        let metricsHtml = '<div style="font-size:10px; color:#666; font-style:italic;">No metrics found</div>';

        if (customMetrics && customMetrics.length > 0) {
            // Group Metrics
            const groups = {
                'Standard': [],
                'Active Set': [],
                'Monitored Set': [],
                'Detected Set': []
            };

            customMetrics.forEach(m => {
                const lower = m.toLowerCase();
                if (/^a\d+_/.test(lower)) groups['Active Set'].push(m);
                else if (/^m\d+_/.test(lower)) groups['Monitored Set'].push(m);
                else if (/^d\d+_/.test(lower)) groups['Detected Set'].push(m);
                else groups['Standard'].push(m);
            });

            metricsHtml = '<div class="sc-metric-container" style="display:flex; flex-direction:column; gap:5px;">';

            Object.keys(groups).forEach(groupName => {
                const list = groups[groupName];
                if (list.length === 0) return;

                metricsHtml += `
                    <div class="sc-metric-group">
                        <div style="font-size:10px; font-weight:bold; color:#888; margin-bottom:2px; text-transform:uppercase;">${groupName}</div>
                        <div style="display:flex; flex-wrap:wrap; gap:4px;">
                            ${list.map(m => `
                                <div class="sc-metric-button ${log.currentParam === m ? 'active' : ''}" 
                                     onclick="window.showMetricOptions(event, '${layerId}', '${m}', 'smartcare')">
                                     ${m}
                                </div>
                            `).join('')}
                        </div>
                    </div>`;
            });

            metricsHtml += '</div>';
        }

        item.innerHTML = '\n' +
            '            <div class="sc-group-title-row">\n' +
            '                <div class="sc-group-name">\n' +
            '                    <span class="sc-caret">▶</span>\n' +
            '                    ' + (name) + '\n' +
            '                </div>\n' +
            '                <!-- Top Level Controls -->\n' +
            '                <div class="sc-layer-controls">\n' +
            '                    <button class="sc-btn sc-btn-toggle" onclick="toggleSmartCareLayer(\'' + (layerId) + '\')" title="Toggle Visibility">👁️</button>\n' +
            '                    <button class="sc-btn sc-btn-remove" onclick="removeSmartCareLayer(\'' + (layerId) + '\')" title="Remove Layer">❌</button>\n' +
            '                </div>\n' +
            '            </div>\n' +
            '\n' +
            '            <!-- Expandable Body -->\n' +
            '            <div class="sc-layer-body">\n' +
            '                <!-- Meta Row -->\n' +
            '                <div class="sc-meta-row">\n' +
            '                    <div class="sc-meta-left">\n' +
            '                        <span class="sc-tech-badge-sm">' + (techLabel) + '</span>\n' +
            '                        <span class="sc-count-badge-sm">' + (pointCount) + ' pts</span>\n' +
            '                    </div>\n' +
            '                </div>\n' +
            '                <!-- Metrics Grid -->\n' +
            '                ' + (metricsHtml) + '\n' +
            '            </div>\n' +
            '        ';

        scLayerList.appendChild(item);
    }

    // --- DT Layers Sidebar (Metrics/Events shown on map) ---
    window.updateDTLayersSidebar = () => {
        if (!dtLayerList) return;
        dtLayerList.innerHTML = '';

        if (!window.dtLayerOrder) window.dtLayerOrder = [];
        const entries = [];
        if (window.metricLegendEntries) {
            Object.entries(window.metricLegendEntries).forEach(([key, entry]) => {
                entries.push({
                    key,
                    title: entry.title || key,
                    visible: entry.visible !== false,
                    type: 'metric',
                    layerId: entry.layerId
                });
            });
        }
        if (window.eventLegendEntries) {
            Object.entries(window.eventLegendEntries).forEach(([key, entry]) => {
                entries.push({
                    key,
                    title: entry.title || key,
                    visible: entry.visible !== false,
                    type: 'event',
                    layerId: entry.layerId,
                    iconUrl: entry.iconUrl
                });
            });
        }

        // Keep a stable ordering list
        const presentKeys = new Set(entries.map(e => e.key));
        window.dtLayerOrder = (window.dtLayerOrder || []).filter(k => presentKeys.has(k));
        entries.forEach(e => {
            if (!window.dtLayerOrder.includes(e.key)) window.dtLayerOrder.push(e.key);
        });

        const orderIndex = new Map(window.dtLayerOrder.map((k, i) => [k, i]));
        entries.sort((a, b) => (orderIndex.get(a.key) ?? 0) - (orderIndex.get(b.key) ?? 0));

        if (entries.length === 0) {
            dtLayerList.innerHTML = '<div style="padding:6px 8px; color:#777; font-size:11px;">No DT layers</div>';
            // Ensure map is cleared when no DT layers are active
            if (window.mapRenderer) {
                if (window.mapRenderer.logLayers) {
                    Object.keys(window.mapRenderer.logLayers).forEach(id => {
                        window.mapRenderer.clearLayer(id);
                    });
                }
                if (window.mapRenderer.eventLayers) {
                    Object.keys(window.mapRenderer.eventLayers).forEach(id => {
                        window.mapRenderer.removeEventsLayer(id);
                    });
                }
            }
            if (typeof window.applyDTLayerOrder === 'function') {
                window.applyDTLayerOrder();
            }
            return;
        }

        // Ensure sidebar is visible when DT layers exist
        if (scSidebar) scSidebar.style.display = 'flex';

        entries.forEach((entry, idx) => {
            const item = document.createElement('div');
            item.style.cssText = 'display:flex; align-items:center; gap:6px; padding:6px 8px; border-bottom:1px solid #333; font-size:11px; color:#ddd;';
            const icon = entry.iconUrl
                ? '<img src="' + entry.iconUrl + '" style="width:14px; height:14px;" />'
                : '<span style="display:inline-block; width:10px; height:10px; border-radius:50%; background:#22c55e;"></span>';
            const topBadge = idx === 0
                ? '<span title="Top layer" style="display:inline-block; padding:1px 4px; border-radius:6px; font-size:9px; line-height:1; color:#0f172a; background:#38bdf8; margin-right:2px;">TOP</span>'
                : '';
            item.innerHTML =
                icon +
                topBadge +
                '<span style="flex:1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">' + entry.title + '</span>' +
                '<button class="sc-btn sc-btn-toggle" title="Move Up" data-action="up">↑</button>' +
                '<button class="sc-btn sc-btn-toggle" title="Move Down" data-action="down">↓</button>' +
                '<button class="sc-btn sc-btn-toggle" title="Toggle Visibility" data-action="toggle">' + (entry.visible ? '👁️' : '🚫') + '</button>' +
                '<button class="sc-btn sc-btn-remove" title="Remove Layer" data-action="remove">❌</button>';

            const btns = item.querySelectorAll('button');
            btns.forEach(btn => {
                btn.onclick = (e) => {
                    e.stopPropagation();
                    if (btn.dataset.action === 'up' || btn.dataset.action === 'down') {
                        const idx = window.dtLayerOrder.indexOf(entry.key);
                        if (idx !== -1) {
                            const swapWith = btn.dataset.action === 'up' ? idx - 1 : idx + 1;
                            if (swapWith >= 0 && swapWith < window.dtLayerOrder.length) {
                                const tmp = window.dtLayerOrder[idx];
                                window.dtLayerOrder[idx] = window.dtLayerOrder[swapWith];
                                window.dtLayerOrder[swapWith] = tmp;
                            }
                        }
                        window.applyDTLayerOrder();
                        window.updateDTLayersSidebar();
                        return;
                    }
                    if (btn.dataset.action === 'toggle') {
                        if (entry.type === 'metric') window.toggleMetricLegendLayer(entry.key);
                        else window.toggleEventLegendLayer(entry.key);
                    } else {
                        if (entry.type === 'metric') window.removeMetricLegendLayer(entry.key);
                        else window.removeEventLegendLayer(entry.key);
                    }
                    window.updateDTLayersSidebar();
                };
            });
            dtLayerList.appendChild(item);
        });

        if (typeof window.applyDTLayerOrder === 'function') {
            window.applyDTLayerOrder();
        }
    };

    window.moveDTLayerToTop = (key) => {
        if (!key) return;
        if (!window.dtLayerOrder) window.dtLayerOrder = [];
        window.dtLayerOrder = window.dtLayerOrder.filter(k => k !== key);
        window.dtLayerOrder.unshift(key);
    };

    window.applyDTLayerOrder = () => {
        if (!window.mapRenderer) return;
        const order = window.dtLayerOrder || [];
        // Adjust pane stacking so the top DT layer type wins against the other type
        if (window.mapRenderer.map && order.length > 0) {
            const topKey = order[0];
            let topType = null;
            if (window.eventLegendEntries && window.eventLegendEntries[topKey]) topType = 'event';
            if (window.metricLegendEntries && window.metricLegendEntries[topKey]) topType = 'metric';

            const eventsPane = window.mapRenderer.map.getPane('eventsPane');
            const sitesPane = window.mapRenderer.map.getPane('sitesPane');
            if (eventsPane && sitesPane) {
                if (topType === 'metric') {
                    // Put events below DT metric points
                    eventsPane.style.zIndex = 640;
                    sitesPane.style.zIndex = 650;
                } else if (topType === 'event') {
                    // Put events above DT metric points
                    eventsPane.style.zIndex = 680;
                    sitesPane.style.zIndex = 650;
                }
            }
        }
        // bring layers to front in order (last call ends up on top)
        for (let i = order.length - 1; i >= 0; i--) {
            const key = order[i];
            if (window.metricLegendEntries && window.metricLegendEntries[key]) {
                const entry = window.metricLegendEntries[key];
                const layer = window.mapRenderer.logLayers && window.mapRenderer.logLayers[entry.layerId];
                if (layer && window.map && window.map.hasLayer(layer)) {
                    layer.eachLayer(l => {
                        if (typeof l.bringToFront === 'function') l.bringToFront();
                    });
                }
            }
            if (window.eventLegendEntries && window.eventLegendEntries[key]) {
                const entry = window.eventLegendEntries[key];
                const layer = window.mapRenderer.eventLayers && window.mapRenderer.eventLayers[entry.layerId];
                if (layer && window.map && window.map.hasLayer(layer)) {
                    layer.eachLayer(l => {
                        if (typeof l.bringToFront === 'function') l.bringToFront();
                    });
                }
            }
        }
    };

    window.switchSmartCareMetric = (layerId, metric) => {
        const log = window.loadedLogs.find(l => l.id === layerId);
        if (log && window.mapRenderer) {
            console.log('[SmartCare] Switching metric for ' + (layerId) + ' to ' + (metric));
            log.currentParam = metric; // Track active metric for this layer
            window.mapRenderer.updateLayerMetric(layerId, log.points, metric);

            // Update UI active state
            const container = document.querySelector('#sc-item-' + (layerId) + ' .sc-metric-container');
            if (container) {
                container.querySelectorAll('.sc-metric-button').forEach(btn => {
                    btn.classList.toggle('active', btn.textContent === metric);
                });
            }
        }
    };

    window.showMetricOptions = (event, layerId, metric, type = 'regular') => {
        event.stopPropagation();

        // Remove existing menu if any
        const existingMenu = document.querySelector('.sc-metric-menu');
        if (existingMenu) existingMenu.remove();

        const log = window.loadedLogs.find(l => l.id === layerId);
        if (!log) return;

        const menu = document.createElement('div');
        menu.className = 'sc-metric-menu';

        // Position menu near the clicked button
        const rect = event.currentTarget.getBoundingClientRect();
        menu.style.top = (rect.bottom + window.scrollY + 5) + 'px';
        menu.style.left = (rect.left + window.scrollX) + 'px';

        menu.innerHTML = '\n' +
            '            <div class="sc-menu-item" id="menu-map-' + (layerId) + '">\n' +
            '                <span>🗺️</span> Map\n' +
            '            </div>\n' +
            '            <div class="sc-menu-item" id="menu-grid-' + (layerId) + '">\n' +
            '                <span>📊</span> Grid\n' +
            '            </div>\n' +
            '            <div class="sc-menu-item" id="menu-chart-' + (layerId) + '">\n' +
            '                <span>📈</span> Chart\n' +
            '            </div>\n' +
            '        ';

        document.body.appendChild(menu);
        const isNeighborMetric = /^radio\.lte\.neighbor\[\d+\]\./i.test(String(metric || ''));
        const noSampleMsg = isNeighborMetric
            ? 'No samples for this neighbor metric.'
            : 'No samples for this metric in this run.';
        const ensurePreparedMetric = async () => {
            if (!(log.trpRunId && window.prepareTrpMetric)) return true;
            const prepared = await window.prepareTrpMetric(layerId, metric);
            if (prepared === false) {
                console.warn('[Neighbors] no samples for metric:', metric);
                alert(noSampleMsg);
                return false;
            }
            return true;
        };

        // Map Click Handler (add overlay metric layer, keep existing)
        menu.querySelector('#menu-map-' + (layerId)).onclick = async () => {
            if (type === 'driver_entry') {
                await openDriverEntryInView(log, String(metric || ''), 'map');
                menu.remove();
                return;
            }
            const ready = await ensurePreparedMetric();
            if (!ready) { menu.remove(); return; }
            if (window.addMetricLegendLayer) {
                window.addMetricLegendLayer(log, metric);
            }
            menu.remove();
        };

        // Grid Click Handler
        menu.querySelector('#menu-grid-' + (layerId)).onclick = async () => {
            if (type === 'driver_entry') {
                await openDriverEntryInView(log, String(metric || ''), 'grid');
                menu.remove();
                return;
            }
            const ready = await ensurePreparedMetric();
            if (!ready) { menu.remove(); return; }
            window.openGridModal(log, metric);
            menu.remove();
        };

        // Chart Click Handler
        menu.querySelector('#menu-chart-' + (layerId)).onclick = async () => {
            if (type === 'driver_entry') {
                await openDriverEntryInView(log, String(metric || ''), 'chart');
                menu.remove();
                return;
            }
            const ready = await ensurePreparedMetric();
            if (!ready) { menu.remove(); return; }
            window.openChartModal(log, metric);
            menu.remove();
        };

        // Auto-position adjustment if it goes off screen
        const menuRect = menu.getBoundingClientRect();
        if (menuRect.right > window.innerWidth) {
            menu.style.left = (window.innerWidth - menuRect.width - 10) + 'px';
        }
        if (menuRect.bottom > window.innerHeight) {
            menu.style.top = (rect.top + window.scrollY - menuRect.height - 5) + 'px';
        }
    };

    // Close menu when clicking outside
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.sc-metric-menu')) {
            const menu = document.querySelector('.sc-metric-menu');
            if (menu) menu.remove();
        }
    });

    window.toggleSmartCareLayer = (layerId) => {
        const log = window.loadedLogs.find(l => l.id === layerId);
        if (log) {
            log.visible = !log.visible;
            // Trigger redraw
            if (window.mapRenderer) {
                // If it's the active one, clear it? Or just re-render all?
                // Our current renderer handles specific layers if update is called
                // But simplified:
                if (log.visible) {
                    window.mapRenderer.renderLog(log, window.mapRenderer.currentMetric || 'level', true);
                } else {
                    window.mapRenderer.clearLayer(layerId);
                }
            }

            // Update UI Icon
            const btn = document.querySelector('#sc-item-' + (layerId) + ' .sc-btn-toggle');
            if (btn) {
                btn.textContent = log.visible ? '👁️' : '🚫';
                btn.classList.toggle('hidden-layer', !log.visible);
            }
        }
    };

    window.removeSmartCareLayer = (layerId) => {
        if (!confirm('Remove this SmartCare layer?')) return;

        // Remove from data
        const idx = window.loadedLogs.findIndex(l => l.id === layerId);
        if (idx !== -1) {
            window.loadedLogs.splice(idx, 1);
        }

        // Remove from map
        if (window.mapRenderer) {
            window.mapRenderer.clearLayer(layerId);
        }

        // Remove from Sidebar
        const item = document.getElementById('sc-item-' + (layerId));
        if (item) item.remove();

        // Hide sidebar if empty
        if (scLayerList.children.length === 0) {
            scSidebar.style.display = 'none';
        }
    }

    shpInput.onchange = async (e) => {
        const files = Array.from(e.target.files);
        console.log('[Import] Selected ' + (files.length) + ' files:', files.map(f => f.name));

        if (files.length === 0) return;

        // Filter for Excel files (Case Insensitive)
        const excelFiles = files.filter(f => {
            const name = f.name.toLowerCase();
            return name.endsWith('.xlsx') || name.endsWith('.xls');
        });

        console.log('[Import] Detected ' + (excelFiles.length) + ' Excel files.');

        if (excelFiles.length > 0) {
            // Check if multiple Excel files selected
            if (excelFiles.length > 1) {
                console.log("[Import] Multiple Excel files detected. Auto-merging...");
                await handleMergedExcelImport(excelFiles);
            } else {
                // Single File
                await handleExcelImport(excelFiles[0]);
            }
        } else {
            // Proceed with Shapefile (assuming legacy behavior for non-Excel)
            await handleShpImport(files);
        }

        shpInput.value = ''; // Reset
    };

    // Refactored Helper: Parse a single Excel file and return points/metrics
    async function parseExcelFile(file) {
        try {
            const data = await file.arrayBuffer();
            const workbook = XLSX.read(data);
            const sheet = workbook.Sheets[workbook.SheetNames[0]];
            const json = XLSX.utils.sheet_to_json(sheet);

            console.log('[Excel] Parsed ' + (file.name) + ': ' + (json.length) + ' rows');

            // Safe fallback for Projection
            if (!window.proj4.defs['EPSG:32629']) {
                window.proj4.defs('EPSG:32629', '+proj=utm +zone=29 +datum=WGS84 +units=m +no_defs');
            }

            // Grid Dimensions (Default)
            let detectedRx = 20.8;
            let detectedRy = 24.95;

            const points = json.map((row, idx) => {
                // Heuristic Column Mapping
                const latKey = Object.keys(row).find(k => /lat/i.test(k));
                const lngKey = Object.keys(row).find(k => /long|lng/i.test(k));

                if (!latKey || !lngKey) return null;

                const lat = parseFloat(row[latKey]);
                const lng = parseFloat(row[lngKey]);

                if (isNaN(lat) || isNaN(lng)) return null;

                // --- 50m Grid Generation ---
                let [x, y] = window.proj4("EPSG:4326", "EPSG:32629", [lng, lat]);
                let tx = x;
                let ty = y;

                const rx = detectedRx;
                const ry = detectedRy;
                const corners = [
                    [tx - rx, ty - ry],
                    [tx + rx, ty - ry],
                    [tx + rx, ty + ry],
                    [tx - rx, ty + ry],
                    [tx - rx, ty - ry] // Close ring
                ];

                const cornersWGS = corners.map(c => window.proj4("EPSG:32629", "EPSG:4326", c));

                const geometry = {
                    type: "Polygon",
                    coordinates: [cornersWGS]
                };

                // Attribute Mapping
                const rsrpKey = Object.keys(row).find(k => /rsrp|level|signal/i.test(k));
                const cellKey = Object.keys(row).find(k => /cell_name|name|site/i.test(k));
                const timeKey = Object.keys(row).find(k => /time/i.test(k));
                const pciKey = Object.keys(row).find(k => /pci|sc/i.test(k));

                const nodebCellIdKey = Object.keys(row).find(k => /nodeb id-cell id/i.test(k) || /enodeb id-cell id/i.test(k));
                const standardCellIdKey = Object.keys(row).find(k => /^cell[_\s]?id$/i.test(k) || /^ci$/i.test(k) || /^eci$/i.test(k));

                let foundCellId = nodebCellIdKey ? row[nodebCellIdKey] : (standardCellIdKey ? row[standardCellIdKey] : undefined);
                const rncKey = Object.keys(row).find(k => /^rnc$/i.test(k));
                const cidKey = Object.keys(row).find(k => /^cid$/i.test(k));
                const rnc = rncKey ? row[rncKey] : undefined;
                const cid = cidKey ? row[cidKey] : undefined;

                let calculatedEci = null;
                if (foundCellId) {
                    const parts = String(foundCellId).split('-');
                    if (parts.length === 2) {
                        const enb = parseInt(parts[0]);
                        const id = parseInt(parts[1]);
                        if (!isNaN(enb) && !isNaN(id)) calculatedEci = (enb * 256) + id;
                    } else if (!isNaN(parseInt(foundCellId))) {
                        calculatedEci = parseInt(foundCellId);
                    }
                } else if (rnc && cid) {
                    foundCellId = (rnc) + '/' + (cid);
                }

                return {
                    id: idx, // Will need re-indexing when merging
                    lat,
                    lng,
                    rsrp: rsrpKey ? parseFloat(row[rsrpKey]) : undefined,
                    level: rsrpKey ? parseFloat(row[rsrpKey]) : undefined,
                    cellName: cellKey ? row[cellKey] : undefined,
                    sc: pciKey ? row[pciKey] : undefined,
                    time: timeKey ? row[timeKey] : '00:00:00',
                    cellId: foundCellId,
                    rnc: rnc,
                    cid: cid,
                    calculatedEci: calculatedEci,
                    geometry: geometry,
                    properties: row
                };
            }).filter(p => p !== null);

            // Detect Metrics
            // Detect Metrics (Robust Scan of 50 rows)
            const keysSet = new Set();
            if (json && json.length > 0) {
                const scanLimit = Math.min(json.length, 50);
                for (let i = 0; i < scanLimit; i++) {
                    Object.keys(json[i]).forEach(k => keysSet.add(k));
                }
            }
            const customMetrics = Array.from(keysSet);
            // Removed restrictive number-only filtering to allow all columns.

            return { points, customMetrics };
        } catch (e) {
            console.error('Error parsing ' + (file.name), e);
            throw e;
        }
    }

    async function handleExcelImport(file) {
        fileStatus.textContent = 'Parsing Excel: ' + (file.name) + '...';
        try {
            const { points, customMetrics } = await parseExcelFile(file);

            const fileName = file.name.split('.')[0];
            const logId = 'excel_' + (Date.now());

            points.forEach(p => { p.__logId = logId; });
            const newLog = {
                id: logId,
                name: fileName,
                points: points,
                color: '#3b82f6',
                visible: true,
                type: 'excel',
                customMetrics: customMetrics,
                currentParam: 'level' // Default
            };
            newLog.dynamicThresholds = computeSmartCareThresholds(points);

            loadedLogs.push(newLog);
            updateLogsList();
            addSmartCareLayer(newLog);
            fileStatus.textContent = 'Loaded Excel: ' + (fileName);

            // Auto-Zoom
            const latLngs = points.map(p => [p.lat, p.lng]);
            const bounds = L.latLngBounds(latLngs);
            window.map.fitBounds(bounds);

            if (window.mapRenderer) {
                window.mapRenderer.updateLayerMetric(logId, points, 'level');
            }
        } catch (e) {
            console.error(e);
            alert('Failed to import ' + (file.name));
            fileStatus.textContent = 'Import Failed';
        }
    }

    async function handleMergedExcelImport(files) {
        fileStatus.textContent = 'Merging ' + (files.length) + ' Excel files...';

        // Map to store merged points: Key -> Point
        const mergedPointsMap = new Map();
        const allMetrics = new Set();
        const nameList = [];

        try {
            for (let i = 0; i < files.length; i++) {
                const file = files[i];
                fileStatus.textContent = 'Parsing ' + (i + 1) + '/' + (files.length) + ': ' + (file.name) + '...';
                const result = await parseExcelFile(file);

                nameList.push(file.name.split('.')[0]);
                result.customMetrics.forEach(m => allMetrics.add(m));

                // MERGE LOGIC (Spatial Join)
                result.points.forEach(p => {
                    // Precision for 50m grid (5 decimals is ~1m, adequate for aggregation)
                    const key = (p.lat.toFixed(5)) + '_' + (p.lng.toFixed(5));

                    if (mergedPointsMap.has(key)) {
                        const existing = mergedPointsMap.get(key);

                        // 1. Merge Properties (Dictionary Union)
                        existing.properties = { ...existing.properties, ...p.properties };

                        // 2. Merge Top-Level Keys (excluding identity/geometry)
                        const keysToExclude = ['id', 'geometry', 'lat', 'lng', 'properties'];
                        Object.keys(p).forEach(k => {
                            if (!keysToExclude.includes(k) && p[k] !== undefined) {
                                // Overwrite or add
                                existing[k] = p[k];
                            }
                        });

                        // 3. Preserve Geometry if existing was missing (unlikely for same key)
                        if (!existing.geometry && p.geometry) {
                            existing.geometry = p.geometry;
                        }

                    } else {
                        // New Point
                        mergedPointsMap.set(key, p);
                    }
                });
            }

            const pooledPoints = Array.from(mergedPointsMap.values());

            if (pooledPoints.length === 0) {
                alert("No valid data found in selected files.");
                fileStatus.textContent = 'Merge Failed (No Data)';
                return;
            }

            // Re-index IDs to ensure clean array connectivity
            pooledPoints.forEach((p, idx) => p.id = idx);

            const fileName = nameList.length > 3 ? (nameList[0]) + '_plus_' + (nameList.length - 1) + '_merged' : nameList.join('_');
            const logId = 'smartcare_merged_' + (Date.now());

            pooledPoints.forEach(p => { p.__logId = logId; });
            const newLog = {
                id: logId,
                name: fileName + " (Merged)",
                points: pooledPoints,
                color: '#3b82f6',
                visible: true,
                type: 'excel',
                customMetrics: Array.from(allMetrics),
                currentParam: 'level'
            };
            newLog.dynamicThresholds = computeSmartCareThresholds(pooledPoints);

            loadedLogs.push(newLog);
            updateLogsList();
            addSmartCareLayer(newLog);
            fileStatus.textContent = 'Merged ' + (files.length) + ' files successfully.';

            // Auto-Zoom
            const latLngs = pooledPoints.map(p => [p.lat, p.lng]);
            const bounds = L.latLngBounds(latLngs);
            window.map.fitBounds(bounds);

            if (window.mapRenderer) {
                window.mapRenderer.updateLayerMetric(logId, pooledPoints, 'level');
            }

        } catch (e) {
            console.error("Merge Error:", e);
            alert("Error during merge: " + e.message);
            fileStatus.textContent = 'Merge Failed';
        }
    }

    async function handleTRPImport(file) {
        fileStatus.textContent = 'Unzipping TRP...';
        try {
            if (!window.JSZip) {
                alert("JSZip library not loaded. Please refresh or check internet connection.");
                return;
            }
            const zip = await JSZip.loadAsync(file);
            console.log("[TRP] Zip loaded. Files:", Object.keys(zip.files).length);

            const channelLogs = [];
            zip.forEach((relativePath, zipEntry) => {
                // Look for channel.log files (usually in channels/chX/)
                if (relativePath.endsWith('channel.log')) channelLogs.push(zipEntry);
            });

            console.log('[TRP] Found ' + (channelLogs.length) + ' channel logs.');

            let allPoints = [];
            let allSignaling = [];
            let allCallSessions = [];
            let detectedConfig = null;

            for (const logFile of channelLogs) {
                try {
                    // Peek at first bytes to check for binary
                    const head = await logFile.async('uint8array');
                    let isBinary = false;
                    // Check first 100 bytes for nulls which usually indicates binary/datalog
                    for (let i = 0; i < Math.min(head.length, 100); i++) {
                        if (head[i] === 0) { isBinary = true; break; }
                    }

                    if (!isBinary) {
                        const text = await logFile.async('string');
                        // Use existing NMF parser
                        const parserResult = NMFParser.parse(text);
                        if (parserResult.points.length > 0 || parserResult.signaling.length > 0) {
                            console.log('[TRP] Parsed ' + (parserResult.points.length) + ' points from ' + (logFile.name));
                            allPoints = allPoints.concat(parserResult.points);
                            allSignaling = allSignaling.concat(parserResult.signaling);
                            if (Array.isArray(parserResult.callSessions) && parserResult.callSessions.length > 0) {
                                allCallSessions = allCallSessions.concat(parserResult.callSessions);
                            }
                            if (parserResult.config && !detectedConfig) detectedConfig = parserResult.config;
                        }
                    } else {
                        console.warn('[TRP] Skipping binary log: ' + (logFile.name));
                        // Future: Implement binary parser or service.xml correlation if needed
                    }
                } catch (err) {
                    console.warn('[TRP] Failed to parse ' + (logFile.name) + ':', err);
                }
            }

            if (allPoints.length === 0 && allSignaling.length === 0) {
                console.warn("[TRP] No text logs found. Attempting XML Fallback (GPX + Events)...");

                // Fallback Strategy: Parse wptrack.xml (GPS) and services.xml (Events)
                const fallbackData = await parseTRPFallback(zip);
                if (fallbackData.points.length > 0 || fallbackData.signaling.length > 0) {
                    allPoints = fallbackData.points;
                    allSignaling = fallbackData.signaling;
                    fileStatus.textContent = 'Loaded TRP (Route & Events Only)';
                    // Alert user about missing radio data
                    alert("⚠️ Radio Data Missing\n\nThe radio measurements (RSRP/RSCP) in this TRP file are binary/encrypted and cannot be read.\n\nHowever, we have successfully extracted:\n- GPS Track (Gray route)\n- Call Events (Services)\n\nVisualizing map data now.");
                } else {
                    alert("No readable data found in TRP file (Binary Logs + No Accessible GPS/Events).");
                    fileStatus.textContent = 'TRP Import Failed';
                    return;
                }
            }

            // Create Log Object
            const logId = 'trp_' + (Date.now());
            const newLog = {
                id: logId,
                name: file.name,
                points: allPoints,
                signaling: allSignaling,
                callSessions: allCallSessions,
                color: '#8b5cf6', // Violet
                visible: true,
                type: 'nmf', // Treat as NMF-like standard log
                currentParam: 'level',
                config: detectedConfig
            };

            loadedLogs.push(newLog);
            updateLogsList();

            // Auto-Zoom and Render
            if (allPoints.length > 0) {
                const latLngs = allPoints.map(p => [p.lat, p.lng]);
                const bounds = L.latLngBounds(latLngs);
                window.map.fitBounds(bounds);
                if (window.mapRenderer) {
                    window.mapRenderer.renderLog(newLog, 'level');
                }
            }

            fileStatus.textContent = 'Loaded TRP: ' + (file.name);


        } catch (e) {
            console.error("[TRP] Error:", e);
            fileStatus.textContent = 'TRP Error';
            alert("Error processing TRP file: " + e.message);
        }
    }


    async function parseTRPFallback(zip) {
        const results = { points: [], signaling: [] };
        let trackPoints = [];

        // 1. Parse GPS Track (wptrack.xml)
        try {
            const trackFile = Object.keys(zip.files).find(f => f.endsWith('wptrack.xml'));
            if (trackFile) {
                const text = await zip.files[trackFile].async('string');
                const parser = new DOMParser();
                const doc = parser.parseFromString(text, "text/xml");
                const trkpts = doc.getElementsByTagName("trkpt");

                for (let i = 0; i < trkpts.length; i++) {
                    const pt = trkpts[i];
                    const lat = parseFloat(pt.getAttribute("lat"));
                    const lon = parseFloat(pt.getAttribute("lon"));
                    const timeTag = pt.getElementsByTagName("time")[0];
                    const time = timeTag ? timeTag.textContent : null;

                    if (!isNaN(lat) && !isNaN(lon)) {
                        // Track Point
                        trackPoints.push({
                            lat: lat,
                            lng: lon,
                            time: time,
                            timestamp: time ? new Date(time).getTime() : 0,
                            type: 'MEASUREMENT',
                            level: -140, // Gray/Low
                            cellId: 'N/A',
                            details: 'GPS Track Point',
                            properties: { source: 'wptrack' }
                        });
                    }
                }
                console.log('[TRP Fallback] Parsed ' + (trackPoints.length) + ' GPS points.');
            }
        } catch (e) {
            console.warn("[TRP Fallback] Error parsing wptrack.xml", e);
        }

        // 2. Parse Services/Events (services.xml)
        try {
            const servicesFile = Object.keys(zip.files).find(f => f.endsWith('services.xml'));
            if (servicesFile) {
                const text = await zip.files[servicesFile].async('string');
                const parser = new DOMParser();
                const doc = parser.parseFromString(text, "text/xml");
                const serviceInfos = doc.getElementsByTagName("ServiceInformation");

                for (let i = 0; i < serviceInfos.length; i++) {
                    const info = serviceInfos[i];

                    // Extract Name
                    let name = "Unknown Service";
                    const nameTag = info.getElementsByTagName("Name")[0];
                    if (nameTag) {
                        const content = nameTag.getElementsByTagName("Content")[0]; // Sometimes nested
                        name = content ? content.textContent : nameTag.textContent;
                        // Clean up "Voice Quality" -> VoiceQuality
                        if (typeof name === 'string') name = name.trim();
                    }

                    // Extract Action (Start/Stop)
                    let action = "";
                    const actionTag = info.getElementsByTagName("ServiceAction")[0];
                    if (actionTag) {
                        const val = actionTag.getElementsByTagName("Value")[0];
                        action = val ? val.textContent : "";
                    }

                    // Extract Time
                    let time = null;
                    const props = info.getElementsByTagName("Properties")[0];
                    if (props) {
                        const timeTag = props.getElementsByTagName("UtcTime")[0]; // Correct tag structure?
                        // Structure is <UtcTime><Time>...</Time></UtcTime> inside Properties usually
                        if (timeTag) {
                            const t = timeTag.getElementsByTagName("Time")[0];
                            if (t) time = t.textContent;
                        }
                    }

                    if (time) {
                        // Map to nearest GPS point
                        const eventTime = new Date(time).getTime();
                        let closestPt = null;
                        let minDiff = 10000; // 10 seconds max diff?

                        // Find closest track point
                        // Optimization: Track points are sorted by time usually.
                        // Simple linear search for now or find relative index
                        if (trackPoints.length > 0) {
                            // Find closest
                            for (let k = 0; k < trackPoints.length; k++) {
                                const diff = Math.abs(trackPoints[k].timestamp - eventTime);
                                if (diff < minDiff) {
                                    minDiff = diff;
                                    closestPt = trackPoints[k];
                                }
                            }
                        }

                        results.signaling.push({
                            lat: closestPt ? closestPt.lat : (trackPoints[0] ? trackPoints[0].lat : 0),
                            lng: closestPt ? closestPt.lng : (trackPoints[0] ? trackPoints[0].lng : 0),
                            time: time,
                            type: 'SIGNALING',
                            event: (name) + ' ' + (action), // e.g. "Voice Quality Stop"
                            message: 'Service: ' + (name),
                            details: 'Action: ' + (action),
                            direction: '-'
                        });
                    }
                }
                console.log('[TRP Fallback] Parsed ' + (results.signaling.length) + ' Service Events.');
            }
        } catch (e) {
            console.warn("[TRP Fallback] Error parsing services.xml", e);
        }

        results.points = trackPoints;
        return results;
    }

    async function handleShpImport(files) {
        fileStatus.textContent = 'Parsing SHP...';
        try {
            let geojson;
            const zipFile = files.find(f => f.name.endsWith('.zip'));

            if (zipFile) {
                // Parse ZIP containing SHP/DBF
                const buffer = await zipFile.arrayBuffer();
                geojson = await shp(buffer);
            } else {
                // Parse individual SHP/DBF files
                const shpFile = files.find(f => f.name.endsWith('.shp'));
                const dbfFile = files.find(f => f.name.endsWith('.dbf'));
                const prjFile = files.find(f => f.name.endsWith('.prj'));

                if (!shpFile) {
                    alert('Please select at least a .shp file (and ideally a .dbf file)');
                    return;
                }

                const shpBuffer = await shpFile.arrayBuffer();
                const dbfBuffer = dbfFile ? await dbfFile.arrayBuffer() : null;

                // Read PRJ if available
                if (prjFile) {
                    const prjText = await prjFile.text();
                    console.log("[SHP] Found .prj file:", prjText);
                    if (window.proj4 && prjText.trim()) {
                        try {
                            window.proj4.defs("USER_PRJ", prjText);
                            console.log("[SHP] Registered 'USER_PRJ' from file.");
                        } catch (e) {
                            console.error("[SHP] Failed to register .prj:", e);
                        }
                    }
                }

                console.log("[SHP] Parsing individual files...");
                const geometries = shp.parseShp(shpBuffer);
                const properties = dbfBuffer ? shp.parseDbf(dbfBuffer) : [];
                geojson = shp.combine([geometries, properties]);
            }

            console.log("[SHP] Parsed GeoJSON:", geojson);

            if (!geojson) throw new Error("Failed to parse Shapefile");

            // Shapefiles can contain multiple layers if combined or passed as ZIP
            const features = Array.isArray(geojson) ? geojson.flatMap(g => g.features) : geojson.features;

            console.log("[SHP] Extracted Features Count:", features ? features.length : 0);

            if (!features || features.length === 0) {
                alert('No features found in Shapefile.');
                return;
            }

            const fileName = files[0].name.split('.')[0];
            const logId = 'shp_' + (Date.now());

            // Convert GeoJSON Features to App Points
            const points = features.map((f, idx) => {
                const props = f.properties || {};
                const coords = f.geometry.coordinates;

                // Handle Point objects (Shapefiles can be points, lines, or polygons)
                // For SmartCare, they are usually points or centroids
                let lat, lng;
                let rawGeometry = f.geometry; // Store raw geometry for rendering polygons

                if (f.geometry.type === 'Point') {
                    [lng, lat] = coords;
                } else if (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon') {
                    // Use simple centroid for metadata but keep geometry for rendering
                    const bounds = L.geoJSON(f).getBounds();
                    const center = bounds.getCenter();
                    lat = center.lat;
                    lng = center.lng;
                } else {
                    return null; // Skip unsupported types (e.g. PolyLine for now)
                }

                // Field Mapping Logic
                const findField = (regex) => {
                    const key = Object.keys(props).find(k => regex.test(k));
                    return key ? props[key] : undefined;
                };

                const rsrp = findField(/rsrp|level|signal/i);
                const cellName = findField(/cell_name|name|site/i);
                const rsrq = findField(/rsrq|quality/i);
                const pci = findField(/pci|sc/i);

                return {
                    id: idx,
                    lat,
                    lng,
                    rsrp: rsrp !== undefined ? parseFloat(rsrp) : undefined,
                    level: rsrp !== undefined ? parseFloat(rsrp) : undefined,
                    rsrq: rsrq !== undefined ? parseFloat(rsrq) : undefined,
                    sc: pci,
                    cellName: cellName,
                    time: props.time || props.timestamp || '00:00:00',
                    geometry: rawGeometry,
                    properties: props // Keep EVERYTHING
                };
            }).filter(p => p !== null);

            if (points.length === 0) {
                alert('No valid points found in Shapefile.');
                return;
            }

            // Detect all possible metrics from first feature properties
            const firstProps = features[0].properties || {};
            const customMetrics = Object.keys(firstProps).filter(key => {
                const val = firstProps[key];
                return typeof val === 'number' || (!isNaN(parseFloat(val)) && isFinite(val));
            });
            console.log("[SHP] Detected metrics:", customMetrics);

            const newLog = {
                id: logId,
                name: fileName,
                points: points,
                type: 'shp',
                tech: points[0].rsrp !== undefined ? '4G' : 'Unknown',
                customMetrics: customMetrics,
                currentParam: 'level',
                visible: true,
                color: '#38bdf8'
            };
            points.forEach(p => { p.__logId = logId; });
            newLog.dynamicThresholds = computeSmartCareThresholds(points);

            loadedLogs.push(newLog);
            updateLogsList();
            addSmartCareLayer(newLog); // Pass full log object
            fileStatus.textContent = 'Loaded SHP: ' + (fileName);

            // Auto-render level on map
            map.updateLayerMetric(logId, points, 'level');

            // AUTO-ZOOM to Data
            if (points.length > 0) {
                const lats = points.map(p => p.lat);
                const lngs = points.map(p => p.lng);
                const minLat = Math.min(...lats);
                const maxLat = Math.max(...lats);
                const minLng = Math.min(...lngs);
                const maxLng = Math.max(...lngs);

                console.log("[SHP] Bounds:", { minLat, maxLat, minLng, maxLng });

                // AUTOMATIC REPROJECTION (UTM Zone 29N -> WGS84)
                // If coordinates look like meters (e.g. > 180 or < -180), reproject.
                // Typical UTM Y is > 0, X can be large.
                if (Math.abs(minLat) > 90 || Math.abs(minLng) > 180) {
                    console.log("[SHP] Detected Projected Coordinates (likely UTM). Reprojecting from EPSG:32629...");

                    if (window.proj4) {
                        points.forEach(p => {
                            // Proj4 takes [x, y] -> [lng, lat]
                            const sourceProj = window.proj4.defs("USER_PRJ") ? "USER_PRJ" : "EPSG:32629";
                            const reprojected = window.proj4(sourceProj, "EPSG:4326", [p.lng, p.lat]);
                            p.lng = reprojected[0];
                            p.lat = reprojected[1];
                        });

                        // Recalculate Bounds
                        const newLats = points.map(p => p.lat);
                        const newLngs = points.map(p => p.lng);
                        const newMinLat = Math.min(...newLats);
                        const newMaxLat = Math.max(...newLats);
                        const newMinLng = Math.min(...newLngs);
                        const newMaxLng = Math.max(...newLngs);

                        console.log("[SHP] Reprojected Bounds:", { newMinLat, newMaxLat, newMinLng, newMaxLng });
                        window.map.fitBounds([[newMinLat, newMinLng], [newMaxLat, newMaxLng]]);
                    } else {
                        alert("Coordinates appear to be projected (UTM), but proj4js library is missing. Cannot reproject.");
                    }
                } else {
                    if (Math.abs(maxLat - minLat) < 0.0001 && Math.abs(maxLng - minLng) < 0.0001) {
                        window.map.setView([minLat, minLng], 15);
                    } else {
                        window.map.fitBounds([[minLat, minLng], [maxLat, maxLng]]);
                    }
                }
            }

        } catch (err) {
            console.error("SHP Import Error:", err);
            alert("Failed to import SHP: " + err.message);
            fileStatus.textContent = 'Import failed';
        }
    }

    async function callOpenAIAPI(key, model, prompt) {
        const url = 'https://api.openai.com/v1/chat/completions';

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + (key)
            },
            body: JSON.stringify({
                model: model,
                messages: [
                    { role: "system", content: "You are an expert RF Optimization Engineer. Analyze drive test data." },
                    { role: "user", content: prompt }
                ],
                temperature: 0.7
            })
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error?.message || 'OpenAI API Request Failed');
        }

        return data.choices[0].message.content;
    }

    window.runAIAnalysis = async function () {
        const providerRadio = document.querySelector('input[name="aiProvider"]:checked');
        const provider = providerRadio ? providerRadio.value : 'gemini';
        const model = document.getElementById('geminiModelSelect').value;
        let key = '';

        if (provider === 'gemini') {
            const kInput = document.getElementById('geminiApiKey');
            key = kInput ? kInput.value.trim() : '';
            if (!key) { alert('Please enter a Gemini API Key first.'); return; }
        } else {
            const kInput = document.getElementById('openaiApiKey');
            key = kInput ? kInput.value.trim() : '';
            if (!key) { alert('Please enter an OpenAI API Key first.'); return; }
        }

        if (loadedLogs.length === 0) {
            alert('No logs loaded to analyze.');
            return;
        }

        const aiContent = document.getElementById('aiContent');
        const aiLoading = document.getElementById('aiLoading');
        const apiKeySection = document.getElementById('aiApiKeySection');

        // Show Loading
        if (apiKeySection) apiKeySection.style.display = 'none';
        if (aiContent) aiContent.innerHTML = '';
        if (aiLoading) aiLoading.style.display = 'flex';

        try {
            const metrics = extractLogMetrics();
            const prompt = generateAIPrompt(metrics);
            let result = '';

            if (provider === 'gemini') {
                result = await callGeminiAPI(key, model, prompt);
            } else {
                result = await callOpenAIAPI(key, model, prompt);
            }

            renderAIResult(result);
        } catch (error) {
            console.error("AI Error:", error);
            let userMsg = error.message;
            if (userMsg.includes('API key not valid') || userMsg.includes('Incorrect API key')) userMsg = 'Invalid API Key. Please check your key.';
            if (userMsg.includes('404')) userMsg = 'Model not found or API endpoint invalid.';
            if (userMsg.includes('429') || userMsg.includes('insufficient_quota')) userMsg = 'Quota exceeded. Check your plan.';

            if (aiContent) {
                aiContent.innerHTML = '<div style="color: #ef4444; text-align: center; padding: 20px;">\n' +
                    '                    <h3>Analysis Failed</h3>\n' +
                    '                    <p><strong>Error:</strong> ' + (userMsg) + '</p>\n' +
                    '                    <p style="font-size:12px; color:#aaa; margin-top:5px;">Check console for details.</p>\n' +
                    '                    <div style="display:flex; justify-content:center; gap:10px; margin-top:20px;">\n' +
                    '                         <button onclick="window.runAIAnalysis()" class="btn" style="background: linear-gradient(135deg, #6366f1 0%, #a855f7 100%); width: auto;">Retry</button>\n' +
                    '                         <button onclick="document.getElementById(\'aiApiKeySection\').style.display=\'block\'; document.getElementById(\'aiLoading\').style.display=\'none\'; document.getElementById(\'aiContent\').innerHTML=\'\';" class="btn" style="background:#555;">Back</button>\n' +
                    '                    </div>\n' +
                    '                </div>';
            }
        } finally {
            if (aiLoading) aiLoading.style.display = 'none';
        }
    }

    function extractLogMetrics() {
        // Aggregate data from all loaded logs or the active one
        // For simplicity, let's look at the first log or combined
        let totalPoints = 0;
        let weakSignalCount = 0;
        let avgRscp = 0;
        let avgEcno = 0;
        let totalRscp = 0;
        let totalEcno = 0;
        let technologies = new Set();
        let collectedCells = {}; // SC -> count

        loadedLogs.forEach(log => {
            log.points.forEach(p => {
                totalPoints++;

                // Tech detection
                let tech = 'Unknown';
                if (p.rscp !== undefined) tech = '3G';
                else if (p.rsrp !== undefined) tech = '4G';
                else if (p.rxLev !== undefined) tech = '2G'; // Simplified
                if (tech !== 'Unknown') technologies.add(tech);

                // 3G Metrics
                if (p.rscp !== undefined && p.rscp !== null) {
                    totalRscp += p.rscp;
                    if (p.rscp < -100) weakSignalCount++;
                }
                if (p.ecno !== undefined && p.ecno !== null) {
                    totalEcno += p.ecno;
                }

                // Top Servers
                if (p.sc !== undefined) {
                    collectedCells[p.sc] = (collectedCells[p.sc] || 0) + 1;
                }
            });
        });

        if (totalPoints === 0) throw new Error("No data points found.");

        const validRscpCount = totalPoints; // Approximation
        avgRscp = (totalRscp / validRscpCount).toFixed(1);
        avgEcno = (totalEcno / validRscpCount).toFixed(1);
        const weakSignalPct = ((weakSignalCount / totalPoints) * 100).toFixed(1);

        // Sort top 5 cells
        const topCells = Object.entries(collectedCells)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([sc, count]) => 'SC ' + (sc) + ' (' + (((count / totalPoints) * 100).toFixed(1)) + '%)')
            .join(', ');

        return {
            totalPoints,
            technologies: Array.from(technologies).join(', '),
            avgRscp,
            avgEcno,
            weakSignalPct,
            topCells
        };
    }

    function generateAIPrompt(metrics) {
        return 'You are an expert RF Optimization Engineer. Analyze the following drive test summary data:\n' +
            '        \n' +
            '        - Technologies Found: ' + (metrics.technologies) + '\n' +
            '        - Total Samples: ' + (metrics.totalPoints) + '\n' +
            '        - Average Signal Strength (RSCP/RSRP): ' + (metrics.avgRscp) + ' dBm\n' +
            '        - Average Quality (EcNo/RSRQ): ' + (metrics.avgEcno) + ' dB\n' +
            '        - Weak Coverage Samples (< -100dBm): ' + (metrics.weakSignalPct) + '%\n' +
            '        - Top Serving Cells: ' + (metrics.topCells) + '\n' +
            '\n' +
            '        Provide a concise analysis in Markdown format:\n' +
            '        1. **Overall Health**: Assess the network condition (Good, Fair, Poor).\n' +
            '        2. **Key Issues**: Identify potential problems (e.g., coverage holes, interference, dominance).\n' +
            '        3. **Recommended Actions**: Suggest 3 specific optimization actions (e.g., downtilt, power adjustment, neighbor checks).\n' +
            '        \n' +
            '        Keep it professional and technical.';
    }

    async function callGeminiAPI(key, model, prompt) {
        // Use selected model
        const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + (model) + ':generateContent?key=' + (key);

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                contents: [{
                    parts: [{
                        text: prompt
                    }]
                }]
            })
        });

        if (!response.ok) {
            const errData = await response.json();
            throw new Error(errData.error?.message || 'API Request Failed');
        }

        const data = await response.json();
        return data.candidates[0].content.parts[0].text;
    }

    function renderAIResult(markdownText) {
        // Simple Markdown to HTML converter (bold, headings, lists)
        let html = markdownText
            .replace(/^### (.*$)/gim, '<h3>$1</h3>')
            .replace(/^## (.*$)/gim, '<h2>$1</h2>')
            .replace(/^# (.*$)/gim, '<h1>$1</h1>')
            .replace(/\*\*(.*)\*\*/gim, '<strong>$1</strong>')
            .replace(/\n\n/gim, '<br><br>')
            .replace(/^- (.*$)/gim, '<ul><li>$1</li></ul>') // Naive list
            .replace(/<\/ul><ul>/gim, '') // Merge lists
            ;

        aiContent.innerHTML = html;

        // Show "Analysis Done" button or reset?
        // We keep the "Generate" button visible in the bottom if user wants to retry.
    }

    // Event Filters (Global)
    window.isAbnormalCause = (val) => {
        if (val === undefined || val === null) return true;
        const s = String(val).toLowerCase();
        if (s.includes('normal')) return false;
        if (s.includes('success')) return false;
        if (s.includes('clearing')) return false;
        return true;
    };

    window.getSessionDropPoints = (log) => {
        if (!log || !Array.isArray(log.callSessions) || !Array.isArray(log.points)) return [];
        const droppedSessions = log.callSessions.filter(s => {
            if (!s) return false;
            const isUmtsCall = s?._source === 'umts' && s?.kind === 'UMTS_CALL';
            if (!isUmtsCall) return false;
            if (s.drop === true) return true;
            const et = String(s.endType || '').toUpperCase();
            return et === 'DROP' || et.includes('ABNORMAL') || et.includes('RLF') || et.includes('UNEXPECTED_IDLE');
        });
        if (droppedSessions.length === 0) return [];

        const result = [];
        droppedSessions.forEach((s) => {
            const hit = (typeof findSessionAnchorPoint === 'function')
                ? findSessionAnchorPoint(log, s, 'drop')
                : null;
            const best = hit?.point || null;

            if (best) {
                const mergedProps = Object.assign({}, best.properties || {}, {
                    'Event': 'Drop Call',
                    'Session ID': s.sessionId || 'N/A',
                    'End Type': s.endType || 'DROP',
                    'Drop': 'Yes'
                });
                result.push(Object.assign({}, best, {
                    type: 'EVENT',
                    event: 'Drop Call',
                    message: 'Drop Call',
                    sessionId: s.sessionId,
                    endType: s.endType || 'DROP',
                    drop: true,
                    properties: mergedProps
                }));
            }
        });

        return result;
    };

    window.filter3gDropCalls = (log) => {
        const sessionDropPoints = window.getSessionDropPoints(log);
        if (sessionDropPoints.length > 0) return sessionDropPoints;
        if (!log || !log.events) return [];
        return log.events.filter(p => {
            if (!p || !p.event) return false;
            const evt = String(p.event).toLowerCase();
            if (evt.includes('call drop')) return true;
            if (evt.includes('rrc release')) {
                const cause = p.properties?.rrc_rel_cause || p.properties?.['RRC Release Cause'] || p.message;
                return window.isAbnormalCause(cause);
            }
            return false;
        });
    };

    window.filterHOF = (log) => {
        if (!log || !log.events) return [];
        return log.events.filter(p => {
            if (!p || !p.event) return false;
            const evt = String(p.event).toLowerCase();
            return evt.includes('ho fail') || evt.includes('handover fail') || evt.includes('handover failure') || evt.includes('hof');
        });
    };

    const parsePointTimeMs = (t) => {
        if (!t) return NaN;
        const txt = String(t).trim();
        const iso = Date.parse(txt);
        if (!Number.isNaN(iso)) return iso;
        const m = txt.match(/^(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/);
        if (!m) return NaN;
        const hh = parseInt(m[1], 10);
        const mm = parseInt(m[2], 10);
        const ss = parseInt(m[3], 10);
        const ms = parseInt((m[4] || '0').padEnd(3, '0'), 10);
        return (((hh * 60 + mm) * 60 + ss) * 1000) + ms;
    };

    const distanceMeters = (aLat, aLng, bLat, bLng) => {
        if (![aLat, aLng, bLat, bLng].every(v => Number.isFinite(Number(v)))) return Infinity;
        const rad = Math.PI / 180;
        const dLat = (Number(bLat) - Number(aLat)) * rad;
        const dLng = (Number(bLng) - Number(aLng)) * rad;
        const lat1 = Number(aLat) * rad;
        const lat2 = Number(bLat) * rad;
        const sinDLat = Math.sin(dLat / 2);
        const sinDLng = Math.sin(dLng / 2);
        const aa = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLng * sinDLng;
        return 6371000 * (2 * Math.atan2(Math.sqrt(aa), Math.sqrt(1 - aa)));
    };

    const getSessionModeFromMapPoint = (point) => {
        if (!point) return null;
        if (point.setupFailure === true) return 'setupFailure';
        if (point.drop === true) return 'drop';
        const evt = String(point.event || point.message || point.type || '').toLowerCase();
        const endType = String(point.endType || point?.properties?.['End Type'] || '').toLowerCase();
        if (evt.includes('setup failure') || evt.includes('call fail') || endType.includes('call_setup_failure')) return 'setupFailure';
        if (evt.includes('drop') || endType === 'drop' || endType.includes('abnormal')) return 'drop';
        return null;
    };

    const findUmtsFailedSessionFromPoint = (log, point, mode) => {
        if (!log || !point || !Array.isArray(log.callSessions) || (mode !== 'drop' && mode !== 'setupFailure')) return null;
        const isDrop = mode === 'drop';
        const candidates = log.callSessions.filter(s =>
            s &&
            s._source === 'umts' &&
            s.kind === 'UMTS_CALL' &&
            (isDrop ? !!s.drop : !!s.setupFailure)
        );
        if (candidates.length === 0) return null;

        const pointSessionId = String(point.sessionId || point?.properties?.['Session ID'] || '').trim();
        if (pointSessionId) {
            const bySession = candidates.find(s => String(s.sessionId || '').trim() === pointSessionId);
            if (bySession) return bySession;
        }

        const pointCallId = String(
            point.callId ??
            point.callTransactionId ??
            point?.properties?.['Call ID'] ??
            point?.properties?.['Call Id'] ??
            ''
        ).trim();
        if (pointCallId) {
            const byCallId = candidates.find(s => String(s.callId ?? s.callTransactionId ?? '').trim() === pointCallId);
            if (byCallId) return byCallId;
        }

        const clickedTs = parsePointTimeMs(point.time || point.timestamp || point.ts || point?.properties?.Time);
        let best = null;
        let bestScore = Infinity;
        for (const s of candidates) {
            const hit = (typeof findSessionAnchorPoint === 'function') ? findSessionAnchorPoint(log, s, mode) : null;
            const anchor = hit?.point;
            if (!anchor) continue;
            if (point.id !== undefined && anchor.id !== undefined && String(point.id) === String(anchor.id)) return s;

            const tAnchor = parsePointTimeMs(anchor.time || anchor.timestamp || anchor.ts || anchor?.properties?.Time);
            const timeDiff = (Number.isFinite(clickedTs) && Number.isFinite(tAnchor)) ? Math.abs(clickedTs - tAnchor) : Infinity;
            const geoDiff = distanceMeters(point.lat, point.lng, anchor.lat, anchor.lng);
            const score = Math.min(timeDiff, geoDiff * 100);
            if (score < bestScore) {
                bestScore = score;
                best = { session: s, timeDiff, geoDiff };
            }
        }

        if (!best) return null;
        if (best.timeDiff <= 3000 || best.geoDiff <= 40) return best.session;
        return null;
    };

    window.getCallSetupFailurePoints = (log) => {
        if (!log || !Array.isArray(log.callSessions) || !Array.isArray(log.points)) return [];
        const failedSessions = log.callSessions.filter(s => s &&
            s?._source === 'umts' &&
            s?.kind === 'UMTS_CALL' &&
            (s.setupFailure || String(s.endType || '').toUpperCase() === 'CALL_SETUP_FAILURE'));
        if (failedSessions.length === 0) return [];

        const result = [];
        failedSessions.forEach((s) => {
            const hit = (typeof findSessionAnchorPoint === 'function')
                ? findSessionAnchorPoint(log, s, 'setupFailure')
                : null;
            const best = hit?.point || null;

            if (best) {
                const mergedProps = Object.assign({}, best.properties || {}, {
                    'Event': 'Call Setup Failure',
                    'Session ID': s.sessionId || 'N/A',
                    'End Type': s.endType || 'CALL_SETUP_FAILURE',
                    'Setup Failure': 'Yes'
                });
                result.push(Object.assign({}, best, {
                    type: 'EVENT',
                    event: 'Call Setup Failure',
                    message: 'Call Setup Failure',
                    sessionId: s.sessionId,
                    endType: s.endType || 'CALL_SETUP_FAILURE',
                    setupFailure: true,
                    properties: mergedProps
                }));
            }
        });

        return result;
    };

    window.filter3gCallFailure = (log) => {
        const setupFailPoints = window.getCallSetupFailurePoints(log);
        if (setupFailPoints.length > 0) return setupFailPoints;
        if (!log || !log.events) return [];
        return log.events.filter(p => {
            if (!p || !p.event) return false;
            const evt = String(p.event).toLowerCase();
            return evt.includes('call fail') || evt.includes('call failure');
        });
    };

    mapContainer.addEventListener('drop', (e) => {
        e.preventDefault();
        mapContainer.style.boxShadow = 'none';

        try {
            const data = JSON.parse(e.dataTransfer.getData('application/json'));
            if (data && data.logId && data.param) {
                // Determine Log and Points
                const log = loadedLogs.find(l => l.id === data.logId);
                if (data.type === 'metric') {
                    // Add overlay metric layer (keep existing)
                    if (window.addMetricLegendLayer) {
                        window.addMetricLegendLayer(log, data.param);
                    }
                } else if (data.type === 'event') {
                    if (data.param === 'call_drops' && log.events) {
                        const layerId = 'event__' + log.id + '__call_drops';
                        map.addEventsLayer(layerId, log.events);
                        if (!window.eventLegendEntries) window.eventLegendEntries = {};
                        const eventKey = log.id + '::call_drops';
                        window.eventLegendEntries[eventKey] = {
                            title: 'Call Drops',
                            iconUrl: 'icons/3g_dropcall.png',
                            count: log.events.length,
                            logId: log.id,
                            points: log.events,
                            layerId: layerId,
                            visible: true
                        };
                        if (window.moveDTLayerToTop) window.moveDTLayerToTop(eventKey);
                        if (window.applyDTLayerOrder) window.applyDTLayerOrder();
                        if (window.updateLegend) window.updateLegend();
                        if (window.updateDTLayersSidebar) window.updateDTLayersSidebar();
                    }
                    if (data.param === '3g_dropcall' && log) {
                        const drops = window.filter3gDropCalls(log);
                        const layerId = 'event__' + log.id + '__3g_dropcall';
                        map.addEventsLayer(layerId, drops, {
                            iconUrl: 'icons/3g_dropcall.png',
                            iconSize: [32, 32],
                            iconAnchor: [16, 16]
                        });
                        if (!window.eventLegendEntries) window.eventLegendEntries = {};
                        const eventKey = log.id + '::3g_dropcall';
                        window.eventLegendEntries[eventKey] = {
                            title: 'Drop Call',
                            iconUrl: 'icons/3g_dropcall.png',
                            count: drops.length,
                            logId: log.id,
                            points: drops,
                            layerId: layerId,
                            visible: true
                        };
                        if (window.moveDTLayerToTop) window.moveDTLayerToTop(eventKey);
                        if (window.applyDTLayerOrder) window.applyDTLayerOrder();
                        if (window.updateLegend) window.updateLegend();
                        if (window.updateDTLayersSidebar) window.updateDTLayersSidebar();
                    }
                    if (data.param === '3g_call_failure' && log) {
                        const fails = window.filter3gCallFailure(log);
                        const layerId = 'event__' + log.id + '__3g_call_failure';
                        map.addEventsLayer(layerId, fails, {
                            iconUrl: 'icons/3G_CallFailure.png',
                            iconSize: [28, 28],
                            iconAnchor: [14, 14]
                        });
                        if (!window.eventLegendEntries) window.eventLegendEntries = {};
                        const eventKey = log.id + '::3g_call_failure';
                        window.eventLegendEntries[eventKey] = {
                            title: 'Call Failure',
                            iconUrl: 'icons/3G_CallFailure.png',
                            count: fails.length,
                            logId: log.id,
                            points: fails,
                            layerId: layerId,
                            visible: true
                        };
                        if (window.moveDTLayerToTop) window.moveDTLayerToTop(eventKey);
                        if (window.applyDTLayerOrder) window.applyDTLayerOrder();
                        if (window.updateLegend) window.updateLegend();
                        if (window.updateDTLayersSidebar) window.updateDTLayersSidebar();
                    }
                    if (data.param === 'hof_handover_failure' && log.events) {
                        const hofs = window.filterHOF(log);
                        const layerId = 'event__' + log.id + '__hof';
                        map.addEventsLayer(layerId, hofs, {
                            iconUrl: 'icons/HOF.png',
                            iconSize: [28, 28],
                            iconAnchor: [14, 14]
                        });
                        if (!window.eventLegendEntries) window.eventLegendEntries = {};
                        const eventKey = log.id + '::hof_handover_failure';
                        window.eventLegendEntries[eventKey] = {
                            title: 'Handover Failure',
                            iconUrl: 'icons/HOF.png',
                            count: hofs.length,
                            logId: log.id,
                            points: hofs,
                            layerId: layerId,
                            visible: true
                        };
                        if (window.moveDTLayerToTop) window.moveDTLayerToTop(eventKey);
                        if (window.applyDTLayerOrder) window.applyDTLayerOrder();
                        if (window.updateLegend) window.updateLegend();
                        if (window.updateDTLayersSidebar) window.updateDTLayersSidebar();
                    }
                }
            }
        } catch (err) {
            console.error('Drop Error:', err);
        }
    });

    // Chart Drop Zone Logic (Docked & Modal)
    const handleChartDrop = (e) => {
        e.preventDefault();
        e.currentTarget.style.boxShadow = 'none';
        e.currentTarget.style.border = 'none';

        try {
            const data = JSON.parse(e.dataTransfer.getData('application/json'));
            if (data && data.logId && data.param) {
                const log = loadedLogs.find(l => l.id === data.logId);
                if (log) {
                    console.log('Dropped on Chart:', data);
                    window.openChartModal(log, data.param);
                }
            }
        } catch (err) {
            console.error('Chart Drop Error:', err);
        }
    };

    const handleChartDragOver = (e) => {
        e.preventDefault();
        e.currentTarget.style.boxShadow = 'inset 0 0 20px rgba(59, 130, 246, 0.5)';
        e.currentTarget.style.border = '2px dashed #3b82f6';
    };

    const handleChartDragLeave = (e) => {
        e.currentTarget.style.boxShadow = 'none';
        e.currentTarget.style.border = 'none';
    };

    const dockedChartZone = document.getElementById('dockedChart');
    if (dockedChartZone) {
        dockedChartZone.addEventListener('dragover', handleChartDragOver);
        dockedChartZone.addEventListener('dragleave', handleChartDragLeave);
        dockedChartZone.addEventListener('drop', handleChartDrop);
    }

    const chartModal = document.getElementById('chartModal'); // or .modal-content?
    if (chartModal) {
        // Target the content specifically to avoid drop on backdrop
        const content = chartModal.querySelector('.modal-content');
        if (content) {
            content.addEventListener('dragover', handleChartDragOver);
            content.addEventListener('dragleave', handleChartDragLeave);
            content.addEventListener('drop', handleChartDrop);
        }
    }

    const loadedLogs = [];
    let currentSignalingLogId = null;
    let currentCallSessionLogId = null;


    function openChartModal(log, param) {
        // Store for Docking/Sync
        window.currentChartLogId = log.id;
        window.currentChartParam = param;

        let activeIndex = 0; // Track selected point index

        let container;
        let isDocked = isChartDocked;

        if (isDocked) {
            container = document.getElementById('dockedChart');
            container.innerHTML = ''; // Clear previous
        } else {
            let modal = document.getElementById('chartModal');
            if (modal) modal.remove();

            modal = document.createElement('div');
            modal.id = 'chartModal';
            // Initial size and position, with resize enabled
            modal.style.cssText = 'position:fixed; top:10%; left:10%; width:80%; height:70%; background:#1e1e1e; border:1px solid #444; z-index:2000; display:flex; flex-direction:column; box-shadow:0 0 20px rgba(0,0,0,0.8); resize:both; overflow:hidden; min-width:400px; min-height:300px;';
            document.body.appendChild(modal);
            container = modal;
        }

        // Initialize Chart in container (Calling internal helper or global?)
        // The chart initialization logic was inside openChartModal in the duplicate block.
        // We need to make sure we actually render the chart here!
        // But wait, the previous "duplicate" block actually contained the logic to RENDER the chart.
        // If I just close the function here, the chart won't render?
        // Let's check where the chart rendering logic is. 
        // It follows immediately in the old code.
        // I need to keep the chart rendering logic INSIDE openChartModal.
        // But the GRID logic must be OUTSIDE.

        // I will assume the Chart Logic continues after this replacement chunk. 
        // I will NOT close the function here yet. I need to find where the Chart Logic ENDS.

        // Wait, looking at Step 840/853...
        // The Grid System block starts at line 119.
        // The Chart Logic (preparing datasets) starts at line 410!
        // So the Grid Logic was INTERJECTED in the middle of openChartModal!
        // This is messy.

        // I should:
        // 1. Leave openChartModal alone for now (it's huge).
        // 2. Extract the Grid Logic OUT of it.
        // 3. But the Grid Logic is physically located between lines 119 and 400.
        // 4. And the Chart Logic resumes at 410?

        // Let's verify line 410.
        // Step 853 shows line 410: const labels = []; ...
        // YES.

        // So I need to MOVE lines 118-408 OUT of openChartModal.
        // But 'openChartModal' starts at line 95.
        // Does the Chart Logic use variables from top of 'openChartModal'?
        // 'isDocked', 'container', 'log', 'param'.
        // Yes.

        // 1. Setup Container.
        // 2. [GRID LOGIC - WRONG PLACE]
        // 3. Prepare Data.
        // 4. Render Chart.

        // Grid Logic Moved to Global Scope

        // Prepare Data
        const labels = [];
        // Datasets arrays (OPTIMIZED: {x,y} format for Decimation)
        const dsServing = [];
        const dsA2 = [];
        const dsA3 = [];
        const dsN1 = [];
        const dsN2 = [];
        const dsN3 = [];

        const isComposite = (param === 'rscp_not_combined');

        // Original dataPoints for non-composite case
        const dataPoints = [];

        log.points.forEach((p, i) => {
            // ... parsing logic same as before ... 
            // Base Value (Serving)
            let val = p[param];
            if (param === 'rscp_not_combined') val = p.level !== undefined ? p.level : (p.rscp !== undefined ? p.rscp : -999);
            else if (param.startsWith('active_set_')) {
                const sub = param.replace('active_set_', '');
                const lowerSub = sub.toLowerCase();
                val = p[lowerSub];
            } else {
                if (param === 'band' && p.parsed) val = p.parsed.serving.band;
                if (val === undefined && p.parsed && p.parsed.serving[param] !== undefined) val = p.parsed.serving[param];
            }

            // Always add point to prevent index mismatch (Chart Index must equal Log Index)
            const label = p.time || 'Pt ' + (i);
            labels.push(label);

            // OPTIMIZATION: Push {x,y} objects
            dsServing.push({ x: i, y: parseFloat(val) });

            if (isComposite) {
                dsA2.push({ x: i, y: p.a2_rscp !== undefined ? parseFloat(p.a2_rscp) : null });
                dsA3.push({ x: i, y: p.a3_rscp !== undefined ? parseFloat(p.a3_rscp) : null });
                dsN1.push({ x: i, y: p.n1_rscp !== undefined ? parseFloat(p.n1_rscp) : null });
                dsN2.push({ x: i, y: p.n2_rscp !== undefined ? parseFloat(p.n2_rscp) : null });
                dsN3.push({ x: i, y: p.n3_rscp !== undefined ? parseFloat(p.n3_rscp) : null });
            } else {
                dataPoints.push({ x: i, y: parseFloat(val) });
            }
        });

        // Default Settings
        const chartSettings = {
            type: 'bar', // FORCED BAR
            servingColor: '#3b82f6', // BLUE for Serving (A1)
            useGradient: false,
            a2Color: '#3b82f6', // BLUE
            a3Color: '#3b82f6', // BLUE
            n1Color: '#22c55e', // GREEN
            n2Color: '#22c55e', // GREEN
            n3Color: '#22c55e', // GREEN
        };

        const controlsId = 'chartControls_' + Date.now();
        const headerId = 'chartHeader_' + Date.now();

        // Header Buttons
        const dockBtn = isDocked
            ? '<button onclick="window.undockChart()" style="background:#555; color:white; border:none; padding:5px 10px; cursor:pointer; font-size:11px;">Undock</button>'
            : '<button onclick="window.dockChart()" style="background:#3b82f6; color:white; border:none; padding:5px 10px; cursor:pointer; font-size:11px;">Dock</button>';

        const closeBtn = isDocked
            ? ''
            : '<button onclick="window.currentChartInstance=null;window.currentChartLogId=null;document.getElementById(\'chartModal\').remove()" style="background:#ef4444; color:white; border:none; padding:5px 10px; cursor:pointer; pointer-events:auto;">Close</button>';

        const dragCursor = isDocked ? 'default' : 'move';

        container.innerHTML = '\n' +
            '                    <div id="' + (headerId) + '" style="padding:10px; background:#2d2d2d; border-bottom:1px solid #444; display:flex; justify-content:space-between; align-items:center; cursor:' + (dragCursor) + '; user-select:none;">\n' +
            '                        <div style="display:flex; align-items:center; pointer-events:none;">\n' +
            '                            <h3 style="margin:0; margin-right:20px; pointer-events:auto; font-size:14px;">' + (log.name) + ' - ' + (isComposite ? 'RSCP & Neighbors' : param.toUpperCase()) + ' (Snapshot)</h3>\n' +
            '                            <button id="styleToggleBtn" style="background:#333; color:#ccc; border:1px solid #555; padding:5px 10px; cursor:pointer; pointer-events:auto; font-size:11px;">⚙️ Style</button>\n' +
            '                        </div>\n' +
            '                        <div style="pointer-events:auto; display:flex; gap:10px;">\n' +
            '                            ' + (dockBtn) + '\n' +
            '                            ' + (closeBtn) + '\n' +
            '                        </div>\n' +
            '                    </div>\n' +
            '                    \n' +
            '                    <!-- Settings Panel -->\n' +
            '                    <div id="' + (controlsId) + '" style="display:none; background:#252525; padding:10px; border-bottom:1px solid #444; gap:15px; align-items:center; flex-wrap:wrap;">\n' +
            '                        <!-- Serving Controls -->\n' +
            '                        <div style="display:flex; flex-direction:column; gap:2px; border-right:1px solid #444; padding-right:10px;">\n' +
            '                            <label style="color:#aaa; font-size:10px; font-weight:bold;">Serving</label>\n' +
            '                             <input type="color" id="pickerServing" value="#3b82f6" style="border:none; width:30px; height:20px; cursor:pointer;">\n' +
            '                        </div>\n' +
            '\n' +
            (isComposite ?
                '<div style="display:flex; flex-direction:column; gap:2px; padding-right:5px;">' +
                '    <label style="color:#aaa; font-size:10px;">N1 Style</label>' +
                '    <input type="color" id="pickerN1" value="#22c55e" style="border:none; width:30px; height:20px; cursor:pointer;">' +
                '</div>' +
                '<div style="display:flex; flex-direction:column; gap:2px; padding-right:5px;">' +
                '    <label style="color:#aaa; font-size:10px;">N2 Style</label>' +
                '    <input type="color" id="pickerN2" value="#22c55e" style="border:none; width:30px; height:20px; cursor:pointer;">' +
                '</div>'
                : '') +
            '</div>' +
            '<div style="display:flex; flex-direction:column; gap:2px;">' +
            '<label style="color:#aaa; font-size:10px;">N3 Style</label>' +
            '<input type="color" id="pickerN3" value="#22c55e" style="border:none; width:30px; height:20px; cursor:pointer;">' +
            '</div>' +
            '                    </div>\n' +
            '\n' +
            '                    <div style="flex:1; padding:10px; display:flex; gap:10px; height: 100%; min-height: 0;">\n' +
            '                        <!-- Bar Chart Section (100%) -->\n' +
            '                        <div id="barChartContainer" style="flex:1; position:relative; min-width:0;">\n' +
            '                            <canvas id="barChartCanvas"></canvas>\n' +
            '                             <div id="barOverlayInfo" style="position:absolute; top:10px; right:10px; color:white; background:rgba(0,0,0,0.7); padding:2px 5px; border-radius:4px; font-size:10px; pointer-events:none;">\n' +
            '                                Snapshot\n' +
            '                            </div>\n' +
            '                        </div>\n' +
            '                    </div>\n' +
            '                    <!-- Resize handle visual cue (bottom right) -->\n' +
            '                    <div style="position:absolute; bottom:2px; right:2px; width:10px; height:10px; cursor:nwse-resize;"></div>\n' +
            '                ';

        // Settings Toggle Logic
        document.getElementById('styleToggleBtn').onclick = () => {
            const panel = document.getElementById(controlsId);
            panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';
        };

        // DRAG LOGIC (Only if not docked)
        if (!isDocked) {
            const header = document.getElementById(headerId);
            let isDragging = false;
            let dragStartX, dragStartY;
            let diffX, diffY; // Difference between mouse and modal top-left

            header.addEventListener('mousedown', (e) => {
                // Only drag if left click and target is not a button/input (handled by pointer-events in HTML structure but good to be safe)
                if (e.target.tagName === 'BUTTON' || e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;

                isDragging = true;

                // Calculate offset of mouse from modal top-left
                const rect = container.getBoundingClientRect();
                diffX = e.clientX - rect.left;
                diffY = e.clientY - rect.top;

                document.addEventListener('mousemove', onMouseMove);
                document.addEventListener('mouseup', onMouseUp);
            });

            function onMouseMove(e) {
                if (!isDragging) return;

                let newLeft = e.clientX - diffX;
                let newTop = e.clientY - diffY;

                container.style.left = newLeft + 'px';
                container.style.top = newTop + 'px';
            }

            function onMouseUp() {
                isDragging = false;
                document.removeEventListener('mousemove', onMouseMove);
                document.removeEventListener('mouseup', onMouseUp);
            }
        }

        const barCtx = document.getElementById('barChartCanvas').getContext('2d');

        // Define Gradient Creator (Use Line Context)
        const createGradient = (color1, color2) => {
            const g = barCtx.createLinearGradient(0, 0, 0, 400);
            g.addColorStop(0, color1);
            g.addColorStop(1, color2);
            return g;
        };



        // Vertical Line Plugin with Badge Style (Pill)
        const verticalLinePlugin = {
            id: 'verticalLine',
            afterDraw: (chart) => {
                if (chart.config.type === 'line' && activeIndex !== null) {
                    // console.log('Drawing Vertical Line for Index:', activeIndex);
                    const meta = chart.getDatasetMeta(0);
                    if (!meta.data[activeIndex]) return;
                    const point = meta.data[activeIndex];
                    const ctx = chart.ctx;

                    if (point && !point.skip) {
                        const x = point.x;
                        const topY = chart.scales.y.top;
                        const bottomY = chart.scales.y.bottom;
                        const y = point.y; // Point Value Y position

                        ctx.save();

                        // 1. Draw Vertical Line (Subtle)
                        ctx.beginPath();
                        ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
                        ctx.lineWidth = 1;
                        ctx.moveTo(x, topY);
                        ctx.lineTo(x, bottomY);
                        ctx.stroke();

                        // 2. Draw Glow Dot on Point
                        ctx.shadowColor = '#ff00cc';
                        ctx.shadowBlur = 10;
                        ctx.beginPath();
                        ctx.fillStyle = '#ff00cc';
                        ctx.arc(x, y, 4, 0, Math.PI * 2);
                        ctx.fill();

                        // Reset Shadow for Badge
                        ctx.shadowBlur = 0;

                        // 3. Draw Badge (Pill) ABOVE the point
                        const measure = chart.data.datasets[0].data[activeIndex];
                        const text = typeof measure === 'object' ? measure.y.toFixed(1) : (typeof measure === 'number' ? measure.toFixed(1) : measure);

                        ctx.font = 'bold 12px sans-serif';
                        const textWidth = ctx.measureText(text).width;
                        const paddingX = 10;
                        const paddingY = 4;
                        const badgeWidth = textWidth + paddingX * 2;
                        const badgeHeight = 22;
                        const badgeX = x - badgeWidth / 2;
                        const badgeY = y - 35; // Position 35px above point

                        // Draw Pill Background
                        ctx.beginPath();
                        ctx.roundRect(badgeX, badgeY, badgeWidth, badgeHeight, 10);
                        ctx.fillStyle = '#ff00cc';
                        ctx.fill();

                        // Draw small triangle arrow pointing down
                        ctx.beginPath();
                        ctx.moveTo(x, badgeY + badgeHeight);
                        ctx.lineTo(x - 4, badgeY + badgeHeight + 4);
                        ctx.lineTo(x + 4, badgeY + badgeHeight + 4);
                        ctx.fill();

                        // Draw Text
                        ctx.fillStyle = 'white';
                        ctx.textAlign = 'center';
                        ctx.textBaseline = 'middle';
                        ctx.fillText(text, x, badgeY + badgeHeight / 2);

                        ctx.restore();

                        // Store Badge Rect for Hit Testing
                        chart.lastBadgeRect = {
                            x: badgeX,
                            y: badgeY,
                            w: badgeWidth,
                            h: badgeHeight
                        };
                    }
                } else {
                    chart.lastBadgeRect = null;
                }
            }
        };

        // Custom Plugin for Line Glow
        const glowPlugin = {
            id: 'glowEffect',
            beforeDatasetDraw: (chart, args) => {
                const ctx = chart.ctx;
                if (chart.config.type === 'line' && args.index === 0) {
                    ctx.save();
                    ctx.shadowColor = chartSettings.servingColor;
                    ctx.shadowBlur = 15;
                    ctx.shadowOffsetX = 0;
                    ctx.shadowOffsetY = 0;
                }
            },
            afterDatasetDraw: (chart, args) => {
                const ctx = chart.ctx;
                if (chart.config.type === 'line' && args.index === 0) {
                    ctx.restore();
                }
            }
        };

        // Construct Data Logic
        const getChartConfigData = (overrideMode) => {
            const currentType = overrideMode || chartSettings.type;
            const isBar = currentType === 'bar';
            // Scale Floor for Bar Chart (dBm)
            const floor = -120;

            // ----------------------------------------------------
            // MODE: BAR (Snapshot) with Floating Bars (Pillars)
            // ----------------------------------------------------
            if (isBar) {
                // Ensure active index is valid
                if (activeIndex === null || activeIndex < 0) activeIndex = 0;
                if (activeIndex >= log.points.length) activeIndex = log.points.length - 1;

                const p = log.points[activeIndex];

                // Extract Values
                // Serving
                let valServing = p[param];
                if (param === 'rscp_not_combined') valServing = p.level !== undefined ? p.level : (p.rscp !== undefined ? p.rscp : -999);
                else {
                    if (param === 'band' && p.parsed) valServing = p.parsed.serving.band;
                    if (valServing === undefined && p.parsed && p.parsed.serving[param] !== undefined) valServing = p.parsed.serving[param];
                }

                // Helper to format float bar: [floor, val]
                const mkBar = (v) => (v !== undefined && v !== null && !isNaN(v)) ? [floor, parseFloat(v)] : null;

                if (isComposite) {
                    // Logic to find Unique Neighbors (Not in Active Set)
                    // Active Set SCs
                    const activeSCs = [p.sc, p.a2_sc, p.a3_sc].filter(sc => sc !== null && sc !== undefined);

                    let uniqueNeighbors = [];
                    if (p.parsed && p.parsed.neighbors) {
                        uniqueNeighbors = p.parsed.neighbors.filter(n => !activeSCs.includes(n.pci));
                    }

                    // Fallback to top 3 if logic fails or array empty, but ideally we use these
                    const n1 = uniqueNeighbors.length > 0 ? uniqueNeighbors[0] : null;
                    const n2 = uniqueNeighbors.length > 1 ? uniqueNeighbors[1] : null;
                    const n3 = uniqueNeighbors.length > 2 ? uniqueNeighbors[2] : null;

                    // Helper for SC Label
                    const lbl = (prefix, sc) => sc !== undefined && sc !== null ? (prefix) + ' (' + (sc) + ')' : prefix;

                    // Dynamic Data Construction
                    const candidates = [
                        { label: lbl('A1', p.sc), val: valServing, color: chartSettings.servingColor },
                        { label: lbl('A2', p.a2_sc), val: p.a2_rscp, color: chartSettings.a2Color },
                        { label: lbl('A3', p.a3_sc), val: p.a3_rscp, color: chartSettings.a3Color },
                        { label: lbl('N1', n1 ? n1.pci : null), val: (n1 ? n1.rscp : null), color: chartSettings.n1Color },
                        { label: lbl('N2', n2 ? n2.pci : null), val: (n2 ? n2.rscp : null), color: chartSettings.n2Color },
                        { label: lbl('N3', n3 ? n3.pci : null), val: (n3 ? n3.rscp : null), color: chartSettings.n3Color }
                    ];

                    // Filter valid entries
                    // Valid if val is defined, not null, not NaN, and not -999 (placeholder)
                    const validData = candidates.filter(c =>
                        c.val !== undefined &&
                        c.val !== null &&
                        !isNaN(c.val) &&
                        c.val !== -999 &&
                        c.val > -140 // Sanity check for empty/invalid RSCP
                    );

                    return {
                        labels: validData.map(c => c.label),
                        datasets: [{
                            label: 'Signal Strength',
                            data: validData.map(c => mkBar(c.val)),
                            backgroundColor: validData.map(c => c.color),
                            borderColor: '#fff',
                            borderWidth: 1,
                            borderRadius: 4,
                            barPercentage: 0.6, // Make bars slightly thinner
                            categoryPercentage: 0.8
                        }]
                    };
                } else {
                    // Single metric for Serving only? Or compare something else?
                    // If standard metric, maybe just show it
                    return {
                        labels: ['Serving'],
                        datasets: [{
                            label: param.toUpperCase(),
                            data: [mkBar(valServing)],
                            backgroundColor: [chartSettings.servingColor],
                            borderColor: '#fff',
                            borderWidth: 1,
                            borderRadius: 4
                        }]
                    };
                }
            }

            // ----------------------------------------------------
            // MODE: LINE (Time Series) - NEON STYLE
            // ----------------------------------------------------
            else {
                const datasets = [];

                // Gradient Stroke for Main Line
                // Use a horizontal gradient (magento to blue)
                let gradientStroke = chartSettings.servingColor;
                if (chartSettings.useGradient) {
                    const width = barCtx.canvas.width;
                    const gradient = barCtx.createLinearGradient(0, 0, width, 0);
                    gradient.addColorStop(0, '#ff00cc'); // Magenta
                    gradient.addColorStop(0.5, '#a855f7'); // Purple
                    gradient.addColorStop(1, '#3b82f6'); // Blue
                    gradientStroke = gradient;
                }

                if (isComposite) {
                    // ... (keep existing composite logic)
                    datasets.push({
                        label: 'Serving RSCP (A1)',
                        data: dsServing,
                        borderColor: chartSettings.servingColor, // BLUE
                        backgroundColor: 'rgba(59, 130, 246, 0.1)',
                        borderWidth: 3,
                        pointRadius: 0,
                        pointHoverRadius: 6,
                        tension: 0.2,
                        fill: true
                    });

                    datasets.push({
                        label: 'A2 RSCP',
                        data: dsA2,
                        borderColor: chartSettings.a2Color,
                        backgroundColor: 'transparent',
                        borderWidth: 2,
                        pointRadius: 0,
                        pointHoverRadius: 4,
                        tension: 0.2,
                        fill: false
                    });

                    datasets.push({
                        label: 'A3 RSCP',
                        data: dsA3,
                        borderColor: chartSettings.a3Color,
                        backgroundColor: 'transparent',
                        borderWidth: 2,
                        pointRadius: 0,
                        pointHoverRadius: 4,
                        tension: 0.2,
                        fill: false
                    });

                    // Neighbors (All Green)
                    datasets.push({
                        label: 'N1 RSCP',
                        data: dsN1,
                        borderColor: chartSettings.n1Color,
                        backgroundColor: 'transparent',
                        borderWidth: 1,
                        pointRadius: 0,
                        pointHoverRadius: 4,
                        tension: 0.2,
                        fill: false
                    });
                    datasets.push({
                        label: 'N2 RSCP',
                        data: dsN2,
                        borderColor: chartSettings.n2Color,
                        backgroundColor: 'transparent',
                        borderWidth: 1,
                        pointRadius: 0,
                        pointHoverRadius: 4,
                        tension: 0.2,
                        fill: false
                    });
                    datasets.push({
                        label: 'N3 RSCP',
                        data: dsN3,
                        borderColor: chartSettings.n3Color,
                        backgroundColor: 'transparent',
                        borderWidth: 1,
                        pointRadius: 0,
                        pointHoverRadius: 4,
                        tension: 0.2,
                        fill: false
                    });
                } else if (param === 'active_set') {
                    // Active Set Mode (6 Lines, Dual Axis)

                    // A1 (Serving)
                    datasets.push({
                        label: 'A1 RSCP',
                        data: dsServing,
                        borderColor: chartSettings.servingColor, // Blue-ish default
                        backgroundColor: 'transparent',
                        borderWidth: 2,
                        pointRadius: 0,
                        pointHoverRadius: 4,
                        tension: 0.2,
                        yAxisID: 'y'
                    });
                    datasets.push({
                        label: 'A1 SC',
                        data: log.points.map((p, i) => ({ x: i, y: p.sc !== undefined ? p.sc : (p.parsed && p.parsed.serving ? p.parsed.serving.sc : null) })),
                        borderColor: chartSettings.servingColor,
                        borderDash: [5, 5],
                        borderWidth: 1,
                        pointRadius: 0,
                        pointHoverRadius: 4,
                        tension: 0, // Stepped
                        yAxisID: 'y1'
                    });

                    // A2 (Neighborhood 1)
                    datasets.push({
                        label: 'A2 RSCP',
                        data: dsN1, // mapped from n1_rscp
                        borderColor: chartSettings.n1Color,
                        backgroundColor: 'transparent',
                        borderWidth: 2,
                        pointRadius: 0,
                        pointHoverRadius: 4,
                        tension: 0.2,
                        yAxisID: 'y'
                    });
                    datasets.push({
                        label: 'A2 SC',
                        data: log.points.map((p, i) => ({ x: i, y: p.n1_sc !== undefined ? p.n1_sc : (p.parsed && p.parsed.neighbors && p.parsed.neighbors[0] ? p.parsed.neighbors[0].pci : null) })),
                        borderColor: chartSettings.n1Color,
                        borderDash: [5, 5],
                        borderWidth: 1,
                        pointRadius: 0,
                        pointHoverRadius: 4,
                        tension: 0,
                        yAxisID: 'y1'
                    });

                    // A3 (Neighborhood 2)
                    datasets.push({
                        label: 'A3 RSCP',
                        data: dsN2, // mapped from n2_rscp
                        borderColor: chartSettings.n2Color,
                        backgroundColor: 'transparent',
                        borderWidth: 2,
                        pointRadius: 0,
                        pointHoverRadius: 4,
                        tension: 0.2,
                        yAxisID: 'y'
                    });
                    datasets.push({
                        label: 'A3 SC',
                        data: log.points.map((p, i) => ({ x: i, y: p.n2_sc !== undefined ? p.n2_sc : (p.parsed && p.parsed.neighbors && p.parsed.neighbors[1] ? p.parsed.neighbors[1].pci : null) })),
                        borderColor: chartSettings.n2Color,
                        borderDash: [5, 5],
                        borderWidth: 1,
                        pointRadius: 0,
                        pointHoverRadius: 4,
                        tension: 0,
                        yAxisID: 'y1'
                    });

                } else {
                    datasets.push({
                        label: param.toUpperCase(),
                        data: dataPoints,
                        borderColor: gradientStroke,
                        backgroundColor: 'rgba(51, 51, 255, 0.02)',
                        borderWidth: 3,
                        pointRadius: 0,
                        pointHoverRadius: 6,
                        tension: 0.4,
                        fill: true
                    });
                }

                return {
                    labels: labels, // Global time labels
                    datasets: datasets
                };
            }
        };

        // Custom Plugin for Bar Labels (Level, SC, Band)
        const barLabelsPlugin = {
            id: 'barLabels',
            afterDraw: (chart) => {
                if (chart.config.type === 'bar') {
                    const ctx = chart.ctx;
                    // Only Dataset 0 usually
                    const meta = chart.getDatasetMeta(0);
                    if (!meta.data || meta.data.length === 0) return;

                    // Get Current Point Data
                    if (activeIndex === null || activeIndex < 0) return; // Should allow default
                    // Actually activeIndex matches the selected point in Log.
                    // The chart data itself is ALREADY the snapshot of that point.

                    // We need to retrieve the SC/Band info.
                    // The Chart Data only has numbers (RSCP).
                    // We need to access the source 'log' point.

                    // Accessing the outer 'log' variable from closure.
                    const p = log.points[activeIndex];
                    if (!p) return;

                    meta.data.forEach((bar, index) => {
                        if (!bar || bar.hidden) return;

                        // Determine Content based on Index
                        const val = chart.data.datasets[0].data[index];
                        const levelVal = Array.isArray(val) ? val[1] : val;

                        if (levelVal === null || levelVal === undefined) return;

                        let textLines = [];
                        textLines.push((levelVal.toFixed(1))); // Level

                        if (index === 0) {
                            // Serving
                            const sc = p.sc ?? (p.parsed && p.parsed.serving ? p.parsed.serving.sc : '-');
                            const band = p.parsed && p.parsed.serving ? p.parsed.serving.band : '-';
                            if (sc !== undefined) textLines.push('SC: ' + (sc));
                            if (band) textLines.push(band);
                        } else {
                            // For others (A2, A3, N1...), use the SC included in the Axis Label
                            // Label format: "Name (SC)" e.g. "N1 (120)"
                            const axisLabel = chart.data.labels[index];
                            const match = /\((\d+)\)/.exec(axisLabel);
                            if (match) {
                                textLines.push('SC: ' + (match[1]));
                            } else {
                                // Fallback if no SC in label (e.g. empty or legacy)
                            }
                        }

                        // Draw Text
                        const x = bar.x;
                        const y = bar.base; // Bottom of the bar

                        ctx.save();
                        ctx.textAlign = 'center';
                        ctx.textBaseline = 'bottom'; // Draw from bottom up
                        ctx.font = 'bold 11px sans-serif';

                        // Draw each line moving up from bottom
                        let curY = y - 5;

                        // Iterate normal order: Level first (at bottom)
                        // If we want Level at the very bottom, we draw it first at curY.
                        // Then move curY up for next lines.
                        textLines.forEach((line, i) => {
                            if (i === 0) { // The Level Value (first)
                                ctx.fillStyle = '#fff';
                                ctx.font = 'bold 12px sans-serif';
                            } else {
                                ctx.fillStyle = 'rgba(255,255,255,0.8)'; // Lighter white
                                ctx.font = '10px sans-serif';
                            }
                            ctx.fillText(line, x, curY);
                            curY -= 12; // Line height moving up
                        });

                        ctx.restore();
                    });
                }
            }
        };

        // Common Option Factory
        const getCommonOptions = (isLine) => {
            const opts = {
                responsive: true,
                maintainAspectRatio: false,
                animation: false,
                normalized: true,
                parsing: isLine ? false : true, // Only disable parsing for Line (custom x/y)
                layout: { padding: { top: 40 } },
                onClick: (e) => {
                    // Only Line Chart drives selection
                    if (isLine) {
                        const points = lineChartInstance.getElementsAtEventForMode(e, 'nearest', { intersect: false }, true);
                        if (points.length) {
                            activeIndex = points[0].index;
                            if (window.updateDualCharts) {
                                window.updateDualCharts(activeIndex);
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        type: isLine ? 'linear' : 'category', // LINEAR for Line Chart (Decimation), CATEGORY for Bar
                        ticks: {
                            color: '#666',
                            maxTicksLimit: 10,
                            callback: isLine ? function (val, index) {
                                // Map Linear Index back to Label
                                return labels[val] || '';
                            } : undefined
                        },
                        grid: { color: 'rgba(255,255,255,0.05)', display: false }
                    },
                    y: {
                        ticks: { color: '#666' },
                        grid: { color: 'rgba(255,255,255,0.1)' }
                    }
                },
                plugins: {
                    legend: { display: isComposite, labels: { color: '#ccc' } },
                    tooltip: {
                        enabled: false,
                        mode: 'index',
                        intersect: false
                    },
                    zoom: isLine ? {
                        zoom: {
                            wheel: { enabled: true, modifierKey: 'ctrl' },
                            pinch: { enabled: true },
                            mode: 'x'
                        },
                        pan: { enabled: true, mode: 'x' }
                    } : false,
                    // DECIMATION PLUGIN CONFIG
                    decimation: isLine ? {
                        enabled: true,
                        algorithm: 'min-max', // Preserves peaks, good for signal data
                        samples: 200, // Downsample to ~200 px resolution (very fast)
                        threshold: 500 // Only kick in if > 500 points
                    } : false
                }
            };
            return opts;
        };

        // ... REST OF FILE ...

        // Instantiate Bar Chart
        let barChartInstance = new Chart(barCtx, {
            type: 'bar',
            data: getChartConfigData('bar'),
            options: getCommonOptions(false),
            plugins: [barLabelsPlugin] // Only Bar gets labels
        });

        const updateBarOverlay = () => {
            const overlay = document.getElementById('barOverlayInfo');
            if (overlay) {
                overlay.textContent = (log.points[activeIndex] ? log.points[activeIndex].time : 'N/A');
            }
        };

        // Ensure updateDualCharts uses correct data structure update
        window.updateDualCharts = (idx, skipGlobalSync = false) => {
            activeIndex = idx;
            // No need to rebuild data for Line Chart, just draw updates (selection)
            // But Bar chart relies on getChartConfigData('bar') which is fresh.
            barChartInstance.data = getChartConfigData('bar');
            barChartInstance.update();
            updateBarOverlay();

            if (!skipGlobalSync && log.points[idx]) {
                const source = isScrubbing ? 'chart_scrub' : 'chart';
                window.globalSync(window.currentChartLogId, idx, source);
            }
        };

        // ----------------------------------------------------
        // Drag / Scrubbing Logic for Line Chart
        // ----------------------------------------------------
        let isScrubbing = false;
        const lineCanvas = document.getElementById('lineChartCanvas');

        if (lineCanvas) {
            // Helper to check if mouse is over badge
            const isOverBadge = (e) => {
                if (!lineChartInstance || !lineChartInstance.lastBadgeRect) return false;
                const rect = lineCanvas.getBoundingClientRect();
                const x = e.clientX - rect.left;
                const y = e.clientY - rect.top;
                const b = lineChartInstance.lastBadgeRect;
                return (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h);
            };

            const handleScrub = (e) => {
                const points = lineChartInstance.getElementsAtEventForMode(e, 'nearest', { intersect: false }, true);
                if (points.length) {
                    const idx = points[0].index;
                    if (idx !== activeIndex) {
                        window.updateDualCharts(idx);
                    }
                }
            };

            // Explicit Click Listener for robust syncing
            lineCanvas.onclick = (e) => {
                handleScrub(e);
                if (activeIndex !== null && lineChartInstance) {
                    // window.zoomChartToActive(); // Check if exists
                }
            };

            lineCanvas.addEventListener('mousedown', (e) => {
                if (isOverBadge(e)) {
                    isScrubbing = true;
                    lineCanvas.style.cursor = 'grabbing';
                    handleScrub(e);
                    e.stopPropagation();
                }
            }, true);

            lineCanvas.addEventListener('mousemove', (e) => {
                if (isScrubbing) {
                    handleScrub(e);
                    lineCanvas.style.cursor = 'grabbing';
                } else {
                    if (isOverBadge(e)) {
                        lineCanvas.style.cursor = 'grab';
                    } else {
                        lineCanvas.style.cursor = 'default';
                    }
                }
            });
        }

        // Store globally for Sync
        window.currentChartLogId = log.id;
        window.currentChartInstance = barChartInstance;

        // Function to update Active Index from Map
        window.currentChartActiveIndexSet = (idx) => {
            window.updateDualCharts(idx, true); // True = Skip Global Sync loopback
        };

        // Global function to update the Floating Info Panel


        // Event Listeners for Controls
        const updateChartStyle = () => {
            // No Type Select anymore, or ignored

            chartSettings.servingColor = document.getElementById('pickerServing').value;
            chartSettings.useGradient = false; // Always false for bar chart

            if (isComposite) {
                chartSettings.n1Color = document.getElementById('pickerN1').value;
                chartSettings.n2Color = document.getElementById('pickerN2').value;
                chartSettings.n3Color = document.getElementById('pickerN3').value;
            }

            // Update Both Charts (Data & Options if needed)
            barChartInstance.data = getChartConfigData('bar');
            barChartInstance.update();
        };

        // Listen for Async Map Rendering Completion - MOVED TO GLOBAL
        // window.addEventListener('layer-metric-ready', (e) => { ... });

        // Handle Theme Change
        const themeSelect = document.getElementById('themeSelect');
        if (themeSelect) {
            themeSelect.addEventListener('change', (e) => {
                if (typeof window.updateLegend === 'function') window.updateLegend();
            });
        }
        // Bind events
        document.getElementById('pickerServing').addEventListener('input', updateChartStyle);

        if (isComposite) {
            document.getElementById('pickerN1').addEventListener('input', updateChartStyle);
            document.getElementById('pickerN2').addEventListener('input', updateChartStyle);
            document.getElementById('pickerN3').addEventListener('input', updateChartStyle);
        }

        if (isComposite) {
            document.getElementById('pickerN1').addEventListener('input', updateChartStyle);
            document.getElementById('pickerN2').addEventListener('input', updateChartStyle);
            document.getElementById('pickerN3').addEventListener('input', updateChartStyle);
        }

    }

    // ----------------------------------------------------
    // SEARCH LOGIC (CGPS)
    // ----------------------------------------------------
    const searchInput = document.getElementById('searchInput');
    const searchBtn = document.getElementById('searchBtn');

    window.searchMarker = null;

    window.handleSearch = () => {
        const query = searchInput.value.trim();
        if (!query) return;

        // 1. Coordinate Search (Prioritized)
        const numberPattern = /[-+]?\d+([.,]\d+)?/g;
        const matches = query.match(numberPattern);

        // Check for specific Lat/Lng pattern (2 numbers, no text mixed in usually)
        // If query looks like "Site A" or "123456", we shouldn't treat it as coords just because it has numbers.
        const isCoordinateFormat = matches && matches.length >= 2 && matches.length <= 3 && !/[a-zA-Z]/.test(query);

        if (isCoordinateFormat) {
            const lat = parseFloat(matches[0].replace(',', '.'));
            const lng = parseFloat(matches[1].replace(',', '.'));

            if (!isNaN(lat) && !isNaN(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
                // ... Coordinate Found ...
                window.map.flyTo([lat, lng], 18, { animate: true, duration: 1.5 });
                if (window.searchMarker) window.map.removeLayer(window.searchMarker);
                window.searchMarker = L.marker([lat, lng]).addTo(window.map)
                    .bindPopup('<b>Search Location</b><br>Lat: ' + (lat) + '<br>Lng: ' + (lng)).openPopup();
                document.getElementById('fileStatus').textContent = 'Zoomed to ' + (lat.toFixed(6)) + ', ' + (lng.toFixed(6));
                return;
            }
        }

        // 2. Site / Cell Search
        if (window.mapRenderer && window.mapRenderer.siteData) {
            const qLower = query.toLowerCase();
            const results = [];

            // Helper to score matches
            const scoreMatch = (s) => {
                let score = 0;
                const name = (s.cellName || s.name || s.siteName || '').toLowerCase();
                const id = String(s.cellId || '').toLowerCase();
                const cid = String(s.cid || '').toLowerCase();
                const pci = String(s.sc || s.pci || '').toLowerCase();

                // Exact Matches
                if (name === qLower) score += 100;
                if (id === qLower) score += 100;
                if (cid === qLower) score += 90;

                // Partial Matches
                if (name.includes(qLower)) score += 50;
                if (id.includes(qLower)) score += 40;

                // PCI (Only if query is short number)
                if (pci === qLower && qLower.length < 4) score += 20;

                return score;
            };

            for (const s of window.mapRenderer.siteData) {
                const score = scoreMatch(s);
                if (score > 0) results.push({ s, score });
            }

            results.sort((a, b) => b.score - a.score);

            if (results.length > 0) {
                const best = results[0].s;
                // Determine Zoom Level - if many matches, maybe fit bounds? For now, zoom to best.
                const zoom = (best.lat && best.lng) ? 17 : window.map.getZoom();
                if (best.lat && best.lng) {
                    window.mapRenderer.setView(best.lat, best.lng);
                    // Highlight
                    if (best.cellId) window.mapRenderer.highlightCell(best.cellId);

                    document.getElementById('fileStatus').textContent = 'Found: ' + (best.cellName || best.name) + ' (' + (best.cellId) + ')';
                } else {
                    alert('Site found but has no coordinates: ' + (best.cellName || best.name));
                }
                return;
            }
        }

        // 3. Fallback
        alert("No location or site found for: " + query);
    };

    if (searchBtn) {
        searchBtn.onclick = window.handleSearch;
    }

    const rulerBtn = document.getElementById('rulerBtn');
    if (rulerBtn) {
        rulerBtn.onclick = () => {
            if (window.mapRenderer) window.mapRenderer.toggleRulerMode();
        };
    }

    if (searchInput) {
        searchInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') window.handleSearch();
        });
    }

    // ----------------------------------------------------
    // THEMATIC SETTINGS UI LOGIC
    // ----------------------------------------------------
    const themeSettingsBtn = document.getElementById('themeSettingsBtn');
    const themeSettingsPanel = document.getElementById('themeSettingsPanel');
    const closeThemeSettings = document.getElementById('closeThemeSettings');
    const applyThemeBtn = document.getElementById('applyThemeBtn');
    const resetThemeBtn = document.getElementById('resetThemeBtn');
    const themeSelect = document.getElementById('themeSelect');
    const thresholdsContainer = document.getElementById('thresholdsContainer');

    // Smooth Edges Toggle
    // Smooth Edges Button Logic (Toggle)
    const btnSmoothEdges = document.getElementById('btnSmoothEdges');
    window.isSmoothingEnabled = false; // Default OFF

    if (btnSmoothEdges) {
        btnSmoothEdges.onclick = () => {
            window.isSmoothingEnabled = !window.isSmoothingEnabled;

            if (window.mapRenderer) {
                window.mapRenderer.toggleSmoothing(window.isSmoothingEnabled);
            }

            // Visual Feedback
            if (window.isSmoothingEnabled) {
                btnSmoothEdges.innerHTML = '💧 Smooth: ON';
                btnSmoothEdges.classList.add('btn-green');
            } else {
                btnSmoothEdges.innerHTML = '💧 Smooth';
                btnSmoothEdges.classList.remove('btn-green');
            }
        };
    }

    // Zones (Boundaries) Modal Logic
    const btnZones = document.getElementById('btnZones');
    const boundariesModal = document.getElementById('boundariesModal');
    const closeBoundariesModal = document.getElementById('closeBoundariesModal');

    if (btnZones && boundariesModal) {
        btnZones.onclick = () => {
            boundariesModal.style.display = 'flex'; // Use flex to center the modal content
        };
        closeBoundariesModal.onclick = () => {
            boundariesModal.style.display = 'none';
        };
        // Close on click outside
        window.addEventListener('click', (event) => {
            if (event.target === boundariesModal) {
                boundariesModal.style.display = 'none';
            }
        });
    }

    // Boundary Checkboxes
    ['chkRegions', 'chkProvinces', 'chkCommunes'].forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.addEventListener('change', (e) => {
                const type = id.replace('chk', '').toLowerCase(); // regions, provinces, communes
                if (window.mapRenderer) {
                    window.mapRenderer.toggleBoundary(type, e.target.checked);
                }
            });
        }
    });

    // DR Selection Logic
    const drSelect = document.getElementById('drSelect');
    if (drSelect) {
        drSelect.addEventListener('change', (e) => {
            const val = e.target.value;
            if (window.mapRenderer) {
                window.mapRenderer.filterDR(val);
            }
        });
    }

    // Legend Elements
    let legendControl = null;

    // Helper: Update Theme Color from Legend
    window.handleLegendColorChange = (themeKey, idx, newColor) => {
        if (!window.themeConfig || !window.themeConfig.thresholds[themeKey]) return;
        window.themeConfig.thresholds[themeKey][idx].color = newColor;

        // Trigger Update
        refreshThemeLayers(themeKey);
    };

    // Helper: Update discrete color (identity metrics like Freq/CellId)
    window.handleLegendDiscreteColorChange = (metric, val, newColor, layerId) => {
        if (!window.mapRenderer) return;
        if (!window.mapRenderer.customDiscreteColors) window.mapRenderer.customDiscreteColors = {};
        const scopedKey = `${String(metric || '')}::${String(val)}`;
        window.mapRenderer.customDiscreteColors[scopedKey] = newColor;
        // Backward compatibility for older entries that used value-only keys
        window.mapRenderer.customDiscreteColors[String(val)] = newColor;

        // Re-render only the target layer
        const log = window.loadedLogs.find(l => l.id === layerId);
        if (log) {
            const m = log.currentParam || metric || 'level';
            window.mapRenderer.updateLayerMetric(log.id, log.points, m);
        } else if (window.metricLegendEntries) {
            const entry = Object.values(window.metricLegendEntries).find(e => e.layerId === layerId);
            if (entry) {
                window.mapRenderer.updateLayerMetric(entry.layerId, entry.points, entry.metric);
            }
        }
        if (window.updateLegend) window.updateLegend();
    };

    window.toggleLogLayerVisibility = (logId) => {
        const log = window.loadedLogs.find(l => l.id === logId);
        if (!log || !window.mapRenderer) return;
        log.visible = log.visible === false ? true : false;
        const metric = log.currentParam || 'level';
        if (log.visible) {
            window.mapRenderer.addLogLayer(log.id, log.points, metric, true);
        } else {
            window.mapRenderer.clearLayer(log.id);
        }
        if (window.updateLegend) window.updateLegend();
    };

    window.removeLogLayerFromLegend = (logId) => {
        if (typeof window.removeLog === 'function') {
            window.removeLog(logId);
        } else if (window.mapRenderer) {
            window.mapRenderer.clearLayer(logId);
        }
        if (window.updateLegend) window.updateLegend();
    };

    // Helper: Update Theme Threshold from Legend
    window.handleLegendThresholdChange = (themeKey, idx, type, newValue) => {
        if (!window.themeConfig || !window.themeConfig.thresholds[themeKey]) return;
        const t = window.themeConfig.thresholds[themeKey][idx];
        const val = parseFloat(newValue);

        if (isNaN(val)) return; // Validate

        if (type === 'min') t.min = val;
        if (type === 'max') t.max = val;

        // Auto-update Label
        if (t.min !== undefined && t.max !== undefined) t.label = (t.min) + ' to ' + (t.max);
        else if (t.min !== undefined) t.label = '> ' + (t.min);
        else if (t.max !== undefined) t.label = '< ' + (t.max);

        // Trigger Update
        refreshThemeLayers(themeKey);
    };

    // Helper: Refresh specific layers
    function refreshThemeLayers(themeKey) {
        // Re-render relevant layers
        window.loadedLogs.forEach(log => {
            // Check if log uses this theme
            const currentMetric = log.currentParam || 'level';
            const key = window.getThresholdKey ? window.getThresholdKey(currentMetric) : currentMetric;

            if (key === themeKey) {
                if (window.mapRenderer) {
                    window.mapRenderer.updateLayerMetric(log.id, log.points, currentMetric);
                }
            }
        });

        // Re-render overlay metric layers
        if (window.metricLegendEntries) {
            Object.values(window.metricLegendEntries).forEach(entry => {
                if (!entry || !entry.metric) return;
                const key = window.getThresholdKey ? window.getThresholdKey(entry.metric) : entry.metric;
                if (key === themeKey && window.mapRenderer) {
                    window.mapRenderer.updateLayerMetric(entry.layerId, entry.points, entry.metric);
                }
            });
        }

        // Update Legend UI to reflect new stats/labels
        window.updateLegend();
    }

    // Add overlay metric layer + legend entry (keeps existing layers)
    window.addMetricLegendLayer = (log, metric) => {
        if (!log || !metric || !window.mapRenderer) return;
        if (!window.metricLegendEntries) window.metricLegendEntries = {};

        const key = log.id + '::' + metric;
        const safeMetric = String(metric).replace(/[^a-zA-Z0-9_-]/g, '_');
        const layerId = 'metric__' + (log.id) + '__' + (safeMetric);

        // Replace existing layer with same key
        if (window.mapRenderer.logLayers && window.mapRenderer.logLayers[layerId]) {
            window.mapRenderer.removeLogLayer(layerId);
        }

        // Ensure base log layer is hidden when DT layers are used
        if (window.mapRenderer.logLayers && window.mapRenderer.logLayers[log.id]) {
            window.mapRenderer.clearLayer(log.id);
        }
        log.visible = false;

        window.mapRenderer.addLogLayer(layerId, log.points, metric, true);
        // Track current metric for this log (for later toggles)
        log.currentParam = metric;

        window.metricLegendEntries[key] = {
            title: (log.trpMetricLabels && log.trpMetricLabels[metric]) ? log.trpMetricLabels[metric] : metric,
            metric: metric,
            layerId: layerId,
            logId: log.id,
            points: log.points,
            visible: true
        };

        if (window.updateLegend) window.updateLegend();
        if (window.updateDTLayersSidebar) window.updateDTLayersSidebar();
        if (window.applyDTLayerOrder) window.applyDTLayerOrder();
    };

    window.toggleMetricLegendLayer = (key) => {
        if (!window.metricLegendEntries || !window.metricLegendEntries[key]) return;
        const entry = window.metricLegendEntries[key];
        entry.visible = entry.visible === false ? true : false;
        const layerId = entry.layerId;
        if (layerId && window.mapRenderer && window.map) {
            if (entry.visible) {
                window.map.addLayer(window.mapRenderer.logLayers[layerId]);
            } else {
                window.map.removeLayer(window.mapRenderer.logLayers[layerId]);
            }
        }
        if (window.updateLegend) window.updateLegend();
        if (window.updateDTLayersSidebar) window.updateDTLayersSidebar();
    };

    window.removeMetricLegendLayer = (key) => {
        if (!window.metricLegendEntries || !window.metricLegendEntries[key]) return;
        const entry = window.metricLegendEntries[key];
        const layerId = entry.layerId;
        if (layerId && window.mapRenderer) {
            window.mapRenderer.removeLogLayer(layerId);
        }
        delete window.metricLegendEntries[key];
        if (window.updateLegend) window.updateLegend();
        if (window.updateDTLayersSidebar) window.updateDTLayersSidebar();
    };

    window.updateLegend = function () {
        if (!window.themeConfig || !window.map) return;
        const renderer = window.mapRenderer;

        // Helper to check if legacy control exists and remove it
        if (typeof legendControl !== 'undefined' && legendControl) {
            if (typeof legendControl.remove === 'function') legendControl.remove();
            legendControl = null;
        }

        // Check if draggable legend already exists to preserve position
        let container = document.getElementById('draggable-legend');
        let scrollContent;

        if (!container) {
            container = document.createElement('div');
            container.id = 'draggable-legend';

            // Map Bounds for Initial Placement
            let topPos = 10;
            let rightPos = 10;
            const mapEl = document.getElementById('map');
            const scSidebar = document.getElementById('smartcare-sidebar');
            if (mapEl) {
                const rect = mapEl.getBoundingClientRect();
                topPos = rect.top + 10;
                rightPos = Math.max(10, (window.innerWidth - rect.right) + 10);
            }
            if (scSidebar) {
                const sidebarStyle = window.getComputedStyle(scSidebar);
                if (sidebarStyle.display !== 'none') {
                    const sbRect = scSidebar.getBoundingClientRect();
                    rightPos = Math.max(rightPos, (window.innerWidth - sbRect.left) + 10);
                }
            }

            container.setAttribute('style', '\n' +
                '                position: fixed;\n' +
                '                top: ' + (topPos) + 'px; \n' +
                '                right: ' + (rightPos) + 'px;\n' +
                '                width: 320px;\n' +
                '                min-width: 250px;\n' +
                '                max-width: 600px;\n' +
                '                max-height: 80vh;\n' +
                '                background-color: rgba(30, 30, 30, 0.95);\n' +
                '                border: 2px solid #555;\n' +
                '                border-radius: 6px;\n' +
                '                color: #fff;\n' +
                '                z-index: 10001; \n' +
                '                box-shadow: 0 4px 15px rgba(0,0,0,0.6);\n' +
                '                display: flex;\n' +
                '                flex-direction: column;\n' +
                '                resize: both;\n' +
                '                overflow: hidden;\n' +
                '            ');

            // Disable Map Interactions passing through Legend
            if (typeof L !== 'undefined' && L.DomEvent) {
                L.DomEvent.disableClickPropagation(container);
                L.DomEvent.disableScrollPropagation(container);
            }

            // Global Header (Drag Handle)
            const mainHeader = document.createElement('div');
            mainHeader.setAttribute('style', '\n' +
                '                padding: 8px 10px;\n' +
                '                background-color: #252525;\n' +
                '                font-weight: bold;\n' +
                '                font-size: 13px;\n' +
                '                border-bottom: 1px solid #444;\n' +
                '                cursor: grab;\n' +
                '                display: flex;\n' +
                '                justify-content: space-between;\n' +
                '                align-items: center;\n' +
                '                border-radius: 6px 6px 0 0;\n' +
                '                flex-shrink: 0;\n' +
                '            ');
            mainHeader.innerHTML = '\n' +
                '                <span>Legend</span>\n' +
                '                <div style="display:flex; gap:8px; align-items:center;">\n' +
                '                     <span onclick="this.closest(\'#draggable-legend\').remove(); window.legendControl=null;" style="cursor:pointer; color:#aaa; font-size:18px; line-height:1;">&times;</span>\n' +
                '                </div>\n' +
                '            ';
            container.appendChild(mainHeader);

            // Scrollable Content Area
            scrollContent = document.createElement('div');
            scrollContent.id = 'draggable-legend-content';
            scrollContent.setAttribute('style', 'overflow-y: auto; flex: 1; padding: 5px;');
            container.appendChild(scrollContent);

            document.body.appendChild(container);

            if (typeof makeElementDraggable === 'function') {
                makeElementDraggable(mainHeader, container);
            }

            // Bind KML Export once
            const kmlBtn = container.querySelector('#btnLegacyExport');
            if (kmlBtn) {
                kmlBtn.onclick = (e) => {
                    e.preventDefault(); e.stopPropagation();
                    const modal = document.getElementById('exportKmlModal');
                    if (modal) modal.style.display = 'block';
                };
            }

        } else {
            scrollContent = container.querySelector('#draggable-legend-content');
            if (scrollContent) scrollContent.innerHTML = '';
        }

        if (!scrollContent) return;

        // Populate Content
        let hasContent = false;
        const allLogs = window.loadedLogs || [];

        if (allLogs.length === 0) {
            scrollContent.innerHTML = '<div style="padding:10px; color:#888; text-align:center;">No layers.</div>';
        } else {
            allLogs.forEach(log => {
                // Skip default/base log layers in legend; show only DT layers (metric/event entries)
                if (!log.visible) return;
                // If there are DT metric layers from this log, hide base legend to avoid duplication
                if (window.metricLegendEntries && Object.values(window.metricLegendEntries).some(e => e.logId === log.id)) {
                    return;
                }
                const statsObj = renderer.layerStats ? renderer.layerStats[log.id] : null;
                if (!statsObj) return;

                hasContent = true;
                const metric = statsObj.metric || 'level';
                const stats = statsObj.activeMetricStats || new Map();
                const total = statsObj.totalActiveSamples || 0;

                const section = document.createElement('div');
                section.setAttribute('style', 'margin-bottom: 10px; border: 1px solid #444; border-radius: 4px; overflow: hidden;');

                const sectHeader = document.createElement('div');
                const isVisible = log.visible !== false;
                sectHeader.innerHTML = '<span style="font-weight:bold; color:#eee;">' + (log.name) + '</span> <span style="font-size:10px; color:#aaa;">(' + (metric) + ')</span>' +
                    '<span style="float:right; display:flex; gap:6px;">' +
                    '<button style="background:#333; color:#ccc; border:1px solid #555; border-radius:3px; padding:2px 6px; cursor:pointer;" onclick="window.toggleLogLayerVisibility(\'' + log.id + '\')">' + (isVisible ? 'Hide' : 'Show') + '</button>' +
                    '<button style="background:#333; color:#ccc; border:1px solid #555; border-radius:3px; padding:2px 6px; cursor:pointer;" onclick="window.removeLogLayerFromLegend(\'' + log.id + '\')">Remove</button>' +
                    '</span>';
                sectHeader.setAttribute('style', 'background:#333; padding: 5px 8px; font-size:12px; border-bottom:1px solid #444;');
                section.appendChild(sectHeader);

                const sectBody = document.createElement('div');
                sectBody.setAttribute('style', 'padding:5px; background:rgba(0,0,0,0.2);');

                const isDiscreteLegend = (window.getThresholdKey && window.getThresholdKey(metric) === 'discrete');

                if (isDiscreteLegend || metric === 'cellId' || metric === 'cid' || metric === 'freq' || metric === 'Freq' || metric === 'earfcn' || metric === 'EARFCN' || metric === 'uarfcn' || metric === 'UARFCN' || metric === 'channel' || metric === 'Channel') {
                    const ids = statsObj.activeMetricIds || [];
                    let sortedIds;
                    if (entry.__discreteCounts && entry.__discreteCounts.size > 0) {
                        sortedIds = Array.from(entry.__discreteCounts.entries())
                            .sort((a, b) => b[1] - a[1])
                            .map(([k]) => k);
                    } else {
                        sortedIds = ids.slice().sort((a, b) => (stats.get(b) || 0) - (stats.get(a) || 0));
                    }
                    if (sortedIds.length > 0) {
                        let html = '<div style="display:flex; flex-direction:column; gap:4px;">';
                        sortedIds.slice(0, 50).forEach(id => {
                            const color = renderer.getDiscreteColor(id, metric);
                            let name = id;
                            if (window.mapRenderer && window.mapRenderer.siteIndex && window.mapRenderer.siteIndex.byId) {
                                const site = window.mapRenderer.siteIndex.byId.get(id);
                                if (site) name = site.cellName || site.name || id;
                            }
                            const count = (entry.__discreteCounts && entry.__discreteCounts.get(String(id)) !== undefined) ? entry.__discreteCounts.get(String(id)) : (stats.get(id) || 0);
                            const total = (entry.__discreteTotal && entry.__discreteTotal > 0) ? entry.__discreteTotal : (entry.points ? entry.points.length : 0);
                            const pct = (total > 0) ? (count / total * 100) : 0;
                            html += '<div class="legend-row">\n' +
                                '                                <input type="color" value="' + (color) + '" class="legend-color-input" onchange="window.handleLegendDiscreteColorChange(\'' + (metric) + '\', \'' + (id) + '\', this.value, \'' + (log.id) + '\')">\n' +
                                '                                <span class="legend-label">' + (name) + '</span>\n' +
                                '                                <span class="legend-count">' + (count) + ' (' + (pct.toFixed(1)) + '%)</span>\n' +
                                '                            </div>';
                        });
                        if (sortedIds.length > 50) html += '<div style="font-size:10px; color:#888; text-align:center; padding: 4px;">+ ' + (sortedIds.length - 50) + ' more...</div>';
                        html += '</div>';
                        sectBody.innerHTML = html;
                    }
                }
                else {
                    const key = window.getThresholdKey ? window.getThresholdKey(metric) : metric;
                    const thresholds = (window.themeConfig && window.themeConfig.thresholds[key]) ? window.themeConfig.thresholds[key] : null;
                    if (thresholds) {
                        let html = '<div style="display:flex; flex-direction:column; gap:6px;">';
                        thresholds.forEach((t, idx) => {
                            const count = stats.get(t.label) || 0;
                            const pct = total > 0 ? ((count / total) * 100).toFixed(1) : '0';
                            const minVal = t.min !== undefined ? '<input type="number" value="' + (t.min) + '" class="legend-input" onchange="window.handleLegendThresholdChange(\'' + (key) + '\', ' + (idx) + ', \'min\', this.value)">' : '-∞';
                            const maxVal = t.max !== undefined ? '<input type="number" value="' + (t.max) + '" class="legend-input" onchange="window.handleLegendThresholdChange(\'' + (key) + '\', ' + (idx) + ', \'max\', this.value)">' : '+∞';
                            html += '<div class="legend-row">\n' +
                                '                                <input type="color" value="' + (t.color) + '" class="legend-color-input" onchange="window.handleLegendColorChange(\'' + (key) + '\', ' + (idx) + ', this.value)">\n' +
                                '                                <div class="legend-label" style="display:flex; align-items:center; gap:4px;">\n' +
                                '                                    ' + (minVal) + ' <span style="font-size:9px; color:#666;">to</span> ' + (maxVal) + '\n' +
                                '                                </div>\n' +
                                '                                <span class="legend-count">' + (count) + ' (' + (pct) + '%)</span>\n' +
                                '                            </div>';
                        });
                        html += '</div>';
                        sectBody.innerHTML = html;
                    }
                }
                section.appendChild(sectBody);
                scrollContent.appendChild(section);
            });
        }

        // Append Metric Overlay Legends (keep existing)
        if (window.metricLegendEntries && Object.keys(window.metricLegendEntries).length > 0) {
            Object.entries(window.metricLegendEntries).forEach(([key, entry]) => {
                const statsObj = renderer.layerStats ? renderer.layerStats[entry.layerId] : null;
                if (!statsObj) return;

                const metric = statsObj.metric || entry.metric || 'level';
                const stats = statsObj.activeMetricStats || new Map();
                const total = statsObj.totalActiveSamples || 0;
                const isVisible = entry.visible !== false;

                const section = document.createElement('div');
                section.setAttribute('style', 'margin-bottom: 10px; border: 1px solid #444; border-radius: 4px; overflow: hidden;');

                const sectHeader = document.createElement('div');
                sectHeader.innerHTML = '<span style="font-weight:bold; color:#eee;">' + (entry.title) + '</span> <span style="font-size:10px; color:#aaa;">(' + (metric) + ')</span>' +
                    '<span style="float:right; display:flex; gap:6px;">' +
                    '<button style="background:#333; color:#ccc; border:1px solid #555; border-radius:3px; padding:2px 6px; cursor:pointer;" onclick="window.toggleMetricLegendLayer(\'' + (key) + '\')">' + (isVisible ? 'Hide' : 'Show') + '</button>' +
                    '<button style="background:#333; color:#ccc; border:1px solid #555; border-radius:3px; padding:2px 6px; cursor:pointer;" onclick="window.removeMetricLegendLayer(\'' + (key) + '\')">Remove</button>' +
                    '</span>';
                sectHeader.setAttribute('style', 'background:#333; padding: 5px 8px; font-size:12px; border-bottom:1px solid #444;');
                section.appendChild(sectHeader);

                const sectBody = document.createElement('div');
                sectBody.setAttribute('style', 'padding:5px; background:rgba(0,0,0,0.2);');

                const isDiscreteLegend = (window.getThresholdKey && window.getThresholdKey(metric) === 'discrete');

                if (isDiscreteLegend || metric === 'cellId' || metric === 'cid' || metric === 'freq' || metric === 'Freq' || metric === 'earfcn' || metric === 'EARFCN' || metric === 'uarfcn' || metric === 'UARFCN' || metric === 'channel' || metric === 'Channel') {
                    
let ids = statsObj.activeMetricIds || [];
// For TRP identifier metrics (__info_*), compute unique values directly from points if renderer stats didn't populate ids
if (isDiscreteLegend && (!ids || ids.length === 0)) {
    const counts = new Map();
    const pts = entry.points || [];
    for (let i = 0; i < pts.length; i++) {
        const v = pts[i] ? pts[i][metric] : undefined;
        if (v === undefined || v === null || v === '') continue;
        const keyv = String(v);
        counts.set(keyv, (counts.get(keyv) || 0) + 1);
    }
    ids = Array.from(counts.keys());
    // Replace stats map with counts for rendering
    if (counts.size > 0) {
        // stats is a const above; create a local accessor
        entry.__discreteCounts = counts;
        entry.__discreteTotal = Array.from(counts.values()).reduce((a,b)=>a+b,0);
    }
}
                    const sortedIds = ids.slice().sort((a, b) => (stats.get(b) || 0) - (stats.get(a) || 0));
                    if (sortedIds.length > 0) {
                        let html = '<div style="display:flex; flex-direction:column; gap:4px;">';
                        sortedIds.slice(0, 50).forEach(id => {
                            const color = renderer.getDiscreteColor(id, metric);
                            let name = id;
                            if (window.mapRenderer && window.mapRenderer.siteIndex && window.mapRenderer.siteIndex.byId) {
                                const site = window.mapRenderer.siteIndex.byId.get(id);
                                if (site) name = site.cellName || site.name || id;
                            }
                            const count = (entry.__discreteCounts && entry.__discreteCounts.get(String(id)) !== undefined) ? entry.__discreteCounts.get(String(id)) : (stats.get(id) || 0);
                            const totalDiscrete = (entry.__discreteTotal && entry.__discreteTotal > 0)
                                ? entry.__discreteTotal
                                : (Array.isArray(entry.points) ? entry.points.length : 0);
                            const pct = totalDiscrete > 0 ? ((count / totalDiscrete) * 100) : 0;
                            html += '<div class="legend-row">\n' +
                                '                                <input type="color" value="' + (color) + '" class="legend-color-input" onchange="window.handleLegendDiscreteColorChange(\'' + (metric) + '\', \'' + (id) + '\', this.value, \'' + (entry.layerId) + '\')">\n' +
                                '                                <span class="legend-label">' + (name) + '</span>\n' +
                                '                                <span class="legend-count">' + (count) + ' (' + (pct.toFixed(1)) + '%)</span>\n' +
                                '                            </div>';
                        });
                        if (sortedIds.length > 50) html += '<div style="font-size:10px; color:#888; text-align:center; padding: 4px;">+ ' + (sortedIds.length - 50) + ' more...</div>';
                        html += '</div>';
                        sectBody.innerHTML = html;
                    }
                }
                else {
                    const keyMetric = window.getThresholdKey ? window.getThresholdKey(metric) : metric;
                    const thresholds = (window.themeConfig && window.themeConfig.thresholds[keyMetric]) ? window.themeConfig.thresholds[keyMetric] : null;
                    if (thresholds) {
                        let html = '<div style="display:flex; flex-direction:column; gap:6px;">';
                        thresholds.forEach((t, idx) => {
                            const count = stats.get(t.label) || 0;
                            const pct = total > 0 ? ((count / total) * 100).toFixed(1) : '0';
                            const minVal = t.min !== undefined ? '<input type="number" value="' + (t.min) + '" class="legend-input" onchange="window.handleLegendThresholdChange(\'' + (keyMetric) + '\', ' + (idx) + ', \'min\', this.value)">' : '-∞';
                            const maxVal = t.max !== undefined ? '<input type="number" value="' + (t.max) + '" class="legend-input" onchange="window.handleLegendThresholdChange(\'' + (keyMetric) + '\', ' + (idx) + ', \'max\', this.value)">' : '+∞';
                            html += '<div class="legend-row">\n' +
                                '                                <input type="color" value="' + (t.color) + '" class="legend-color-input" onchange="window.handleLegendColorChange(\'' + (keyMetric) + '\', ' + (idx) + ', this.value)">\n' +
                                '                                <div class="legend-label" style="display:flex; align-items:center; gap:4px;">\n' +
                                '                                    ' + (minVal) + ' <span style="font-size:9px; color:#666;">to</span> ' + (maxVal) + '\n' +
                                '                                </div>\n' +
                                '                                <span class="legend-count">' + (count) + ' (' + (pct) + '%)</span>\n' +
                                '                            </div>';
                        });
                        html += '</div>';
                        sectBody.innerHTML = html;
                    }
                }

                section.appendChild(sectBody);
                scrollContent.appendChild(section);
            });
        }

        // Append Event Legends (e.g., 3G_DropCall) without clearing metric legend
        if (window.eventLegendEntries && Object.keys(window.eventLegendEntries).length > 0) {
            const section = document.createElement('div');
            section.setAttribute('style', 'margin-bottom: 10px; border: 1px solid #444; border-radius: 4px; overflow: hidden;');

            const sectHeader = document.createElement('div');
            sectHeader.innerHTML = '<span style="font-weight:bold; color:#eee;">Events</span>';
            sectHeader.setAttribute('style', 'background:#333; padding: 5px 8px; font-size:12px; border-bottom:1px solid #444;');
            section.appendChild(sectHeader);

            const sectBody = document.createElement('div');
            sectBody.setAttribute('style', 'padding:5px; background:rgba(0,0,0,0.2);');

            let html = '<div style="display:flex; flex-direction:column; gap:6px;">';
            Object.entries(window.eventLegendEntries).forEach(([key, entry]) => {
                const count = entry.count ?? 0;
                const layerId = entry.layerId;
                const isVisible = entry.visible !== false;
                const iconHtml = entry.iconUrl
                    ? '<img src="' + entry.iconUrl + '" style="width:18px; height:18px; margin-right:6px;" />'
                    : '<span style="display:inline-block; width:14px; height:14px; margin-right:8px; border-radius:50%; background:' + (entry.color || '#fff') + '; border:1px solid #666;"></span>';
                html += '<div class="legend-row" style="align-items:center;">' +
                    iconHtml +
                    '<span class="legend-label">' + entry.title + '</span>' +
                    '<span class="legend-count">' + count + '</span>' +
                    '<span style="margin-left:auto; display:flex; gap:6px;">' +
                    '<button style="background:#333; color:#ccc; border:1px solid #555; border-radius:3px; padding:2px 6px; cursor:pointer;" ' +
                    'onclick="window.toggleEventLegendLayer(\'' + key + '\')">' + (isVisible ? 'Hide' : 'Show') + '</button>' +
                    '<button style="background:#333; color:#ccc; border:1px solid #555; border-radius:3px; padding:2px 6px; cursor:pointer;" ' +
                    'onclick="window.removeEventLegendLayer(\'' + key + '\')">Remove</button>' +
                    '</span>' +
                    '</div>';
            });
            html += '</div>';
            sectBody.innerHTML = html;
            section.appendChild(sectBody);
            scrollContent.appendChild(section);
        }

        // Sync DT Layers sidebar
        if (window.updateDTLayersSidebar) window.updateDTLayersSidebar();
    };

    window.toggleEventLegendLayer = (key) => {
        if (!window.eventLegendEntries || !window.eventLegendEntries[key]) return;
        const entry = window.eventLegendEntries[key];
        entry.visible = entry.visible === false ? true : false;
        const layerId = entry.layerId;
        if (layerId && window.mapRenderer && window.map) {
            if (entry.visible) {
                window.map.addLayer(window.mapRenderer.eventLayers[layerId]);
            } else {
                window.map.removeLayer(window.mapRenderer.eventLayers[layerId]);
            }
        }
        if (window.updateLegend) window.updateLegend();
    };

    window.removeEventLegendLayer = (key) => {
        if (!window.eventLegendEntries || !window.eventLegendEntries[key]) return;
        const entry = window.eventLegendEntries[key];
        const layerId = entry.layerId;
        if (layerId && window.mapRenderer && window.mapRenderer.eventLayers && window.mapRenderer.eventLayers[layerId]) {
            window.map.removeLayer(window.mapRenderer.eventLayers[layerId]);
            delete window.mapRenderer.eventLayers[layerId];
        }
        delete window.eventLegendEntries[key];
        if (window.updateLegend) window.updateLegend();
    };
    // Hook updateLegend into UI actions
    // Initial Load (delayed to ensure map exists)
    setTimeout(window.updateLegend, 2000);

    // Global Add/Remove Handlers (attached to window for inline onclicks)
    window.removeThreshold = (idx) => {
        const theme = themeSelect.value;
        if (window.themeConfig.thresholds[theme].length <= 1) {
            alert("Must have at least one range.");
            return;
        }
        window.themeConfig.thresholds[theme].splice(idx, 1);
        renderThresholdInputs();
        // Note: Changes not applied to map until "Apply" is clicked, but UI updates immediately.
    };

    window.addThreshold = () => {
        const theme = themeSelect.value;
        // Add a default gray range
        window.themeConfig.thresholds[theme].push({
            min: -120, max: -100, color: '#cccccc', label: 'New Range'
        });
        renderThresholdInputs();
    };

    function renderThresholdInputs() {
        if (!window.themeConfig) return;
        const theme = themeSelect.value; // 'level' or 'quality'
        const thresholds = window.themeConfig.thresholds[theme];
        thresholdsContainer.innerHTML = '';

        thresholds.forEach((t, idx) => {
            const div = document.createElement('div');
            div.className = 'setting-item';
            div.style.marginBottom = '5px';

            // Allow Min/Max editing based on position
            let inputs = '';
            // If it has Min, show Min Input
            if (t.min !== undefined) {
                inputs += '<label style="font-size:10px; color:#aaa;">Min</label>\n' +
                    '                           <input type="number" class="thresh-min" data-idx="' + (idx) + '" value="' + (t.min) + '" style="width:50px; background:#333; border:1px solid #555; color:#fff; font-size:11px; padding:2px;">';
            } else {
                inputs += '<span style="font-size:10px; color:#aaa; width:50px; display:inline-block;">( -∞ )</span>';
            }

            // If it has Max, show Max Input
            if (t.max !== undefined) {
                inputs += '<label style="font-size:10px; color:#aaa; margin-left:5px;">Max</label>\n' +
                    '                           <input type="number" class="thresh-max" data-idx="' + (idx) + '" value="' + (t.max) + '" style="width:50px; background:#333; border:1px solid #555; color:#fff; font-size:11px; padding:2px;">';
            } else {
                inputs += '<span style="font-size:10px; color:#aaa; width:50px; display:inline-block; margin-left:5px;">( +∞ )</span>';
            }

            // Remove Button
            const removeBtn = '<button onclick="window.removeThreshold(' + (idx) + ')" style="margin-left:auto; background:none; border:none; color:#ef4444; cursor:pointer;" title="Remove Range">✖</button>';

            div.innerHTML = '\n' +
                '                <div style="display:flex; align-items:center;">\n' +
                '                    <input type="color" class="thresh-color" data-idx="' + (idx) + '" value="' + (t.color) + '" style="border:none; width:20px; height:20px; cursor:pointer; margin-right:5px;">\n' +
                '                    ' + (inputs) + '\n' +
                '                    ' + (removeBtn) + '\n' +
                '                </div>\n' +
                '            ';
            thresholdsContainer.appendChild(div);
        });

        // Add "Add Range" Button at bottom
        const addDiv = document.createElement('div');
        addDiv.style.textAlign = 'center';
        addDiv.style.marginTop = '10px';
        addDiv.innerHTML = '<button onclick="window.addThreshold()" style="background:#3b82f6; border:none; color:white; padding:4px 10px; border-radius:4px; font-size:11px; cursor:pointer;">+ Add Range</button>';
        thresholdsContainer.appendChild(addDiv);
    }

    if (themeSettingsBtn) {
        themeSettingsBtn.onclick = () => {
            themeSettingsPanel.style.display = 'block';
            renderThresholdInputs();
            // Maybe update legend preview? Legend updates on Apply
        };
    }

    if (closeThemeSettings) {
        closeThemeSettings.onclick = () => {
            themeSettingsPanel.style.display = 'none';
        };
    }

    if (themeSelect) {
        themeSelect.onchange = () => {
            renderThresholdInputs();
            // Automatically update legend to preview?
            updateLegend();
        };
    }

    if (applyThemeBtn) {
        applyThemeBtn.onclick = () => {
            const theme = themeSelect.value;
            const inputs = thresholdsContainer.querySelectorAll('.setting-item');

            // Reconstruct thresholds array
            let newThresholds = [];
            inputs.forEach(div => {
                const color = div.querySelector('.thresh-color').value;
                const minInput = div.querySelector('.thresh-min');
                const maxInput = div.querySelector('.thresh-max');

                let t = { color: color };
                if (minInput) t.min = parseFloat(minInput.value);
                if (maxInput) t.max = parseFloat(maxInput.value);

                // Keep label? (Simple logic: recreate label on load or lose it)
                // For now, lose custom label, rely on auto-label in legend
                if (t.min !== undefined && t.max !== undefined) t.label = (t.min) + ' to ' + (t.max);
                else if (t.min !== undefined) t.label = '> ' + (t.min);
                else if (t.max !== undefined) t.label = '< ' + (t.max);

                newThresholds.push(t);
            });

            // Update Config
            window.themeConfig.thresholds[theme] = newThresholds;

            // Re-render Legend
            updateLegend();

            // Update Map Layers
            // Iterate all visible log layers and re-render if they match current metric type
            loadedLogs.forEach(log => {
                const currentMetric = log.currentParam || 'level'; // We need to create this prop if missing
                const key = window.getThresholdKey(currentMetric);
                if (key === theme) {
                    // Force Re-render
                    map.updateLayerMetric(log.id, log.points, currentMetric);
                }
            });
            alert('Theme Updated!');
        };
    }

    // Grid Logic (Moved from openChartModal)
    let currentGridLogId = null;
    let currentGridColumns = [];

    function renderGrid() {
        try {
            if (!window.currentGridLogId) return;
            const log = loadedLogs.find(l => l.id === window.currentGridLogId);
            if (!log) return;

            // Determine container
            let container = document.getElementById('gridBody');

            if (!container) {
                console.error("Grid container not found");
                return;
            }

            // Update Title
            const titleEl = document.getElementById('gridTitle');
            if (titleEl) titleEl.textContent = 'Grid View: ' + (log.name);

            // Store ID for dragging context
            window.currentGridLogId = log.id;

            // Build Table
            // Build Table
            // Ensure headers are draggable for metric drop functionality
            let tableHtml = '<table style="width:100%; border-collapse:collapse; color:#eee; font-size:12px;">\n' +
                '                <thead style="position:sticky; top:0; background:#333; height:30px;">\n' +
                '                    <tr>\n' +
                '                        <th style="padding:4px 8px; text-align:left;">Time</th>\n' +
                '                        <th style="padding:4px 8px; text-align:left;">Lat</th>\n' +
                '                        <th style="padding:4px 8px; text-align:left;">Lng</th>\n' +
                '                        <th draggable="true" ondragstart="window.handleHeaderDragStart(event)" data-param="cellId" style="padding:4px 8px; text-align:left; cursor:grab;">RNC/CID</th>';

            window.currentGridColumns.forEach(col => {
                if (col === 'cellId') return; // Skip cellId as it is handled by RNC/CID column
                tableHtml += '<th draggable="true" ondragstart="window.handleHeaderDragStart(event)" data-param="' + (col) + '" style="padding:4px 8px; text-align:left; text-transform:uppercase; cursor:grab;">' + (col) + '</th>';
            });
            tableHtml += '</tr></thead><tbody>';

            let rowsHtml = '';
            const limit = 5000; // Limit for performance

            // Filtering: If the main column is an event/failure, filter points that actually have that data
            const mainCol = window.currentGridColumns[0];
            const eventMetrics = ['RLF indication', 'UL sync loss (UE can’t reach NodeB)', 'DL sync loss (Interference / coverage)', 'T310', 'T312', 'AS Event', 'HO Command', 'HO Completion'];

            let pointsToRender = log.points;
            if (eventMetrics.includes(mainCol)) {
                pointsToRender = log.points.filter(p => p.properties && p.properties[mainCol] !== undefined);
            }

            pointsToRender.slice(0, limit).forEach((p, i) => {
                // Add ID and Click Handler
                // RNC/CID Formatter
                const rncCid = (p.rnc !== undefined && p.rnc !== null && p.cid !== undefined && p.cid !== null)
                    ? (p.rnc) + '/' + (p.cid)
                    : (p.cellId || '-');

                const latVal = (p.lat !== null && p.lat !== undefined) ? p.lat.toFixed(5) : '-';
                const lngVal = (p.lng !== null && p.lng !== undefined) ? p.lng.toFixed(5) : '-';

                let row = '<tr id="grid-row-' + (i) + '" class="grid-row" onclick="window.globalSync(\'' + (log.id) + '\', ' + (i) + ', \'grid\')" style="cursor:pointer; transition: background 0.1s;">\n' +
                    '                <td style="padding:4px 8px; border-bottom:1px solid #333;">' + (p.time) + '</td>\n' +
                    '                <td style="padding:4px 8px; border-bottom:1px solid #333;">' + (latVal) + '</td>\n' +
                    '                <td style="padding:4px 8px; border-bottom:1px solid #333;">' + (lngVal) + '</td>\n' +
                    '                <td style="padding:4px 8px; border-bottom:1px solid #333;">' + (rncCid) + '</td>';

                window.currentGridColumns.forEach(col => {
                    if (col === 'cellId') return; // Skip cellId
                    let val = p[col];

                    // Fallback to properties if not at root (for new RLF events)
                    if (val === undefined && p.properties) {
                        val = p.properties[col];
                    }

                    // Handling complex parsing access
                    if (col.startsWith('n') && col.includes('_')) {
                        // Neighbors
                        const parts = col.split('_'); // n1_rscp -> [n1, rscp]
                        const nIdx = parseInt(parts[0].replace('n', '')) - 1;
                        let field = parts[1];

                        // Map 'sc' to 'pci' for neighbors as parser stores it as pci
                        if (field === 'sc') field = 'pci';

                        if (p.parsed && p.parsed.neighbors && p.parsed.neighbors[nIdx]) {
                            const nestedVal = p.parsed.neighbors[nIdx][field];
                            if (nestedVal !== undefined) val = nestedVal;
                        }

                    } else if (col.startsWith('active_set_')) {
                        // Dynamic AS metrics (A1_RSCP, A2_SC, etc)
                        const sub = col.replace('active_set_', ''); // A1_RSCP
                        const lowerSub = sub.toLowerCase(); // a1_rscp
                        val = p[lowerSub]; // Access getter directly
                    } else if (col.startsWith('AS_')) {
                        // Keep backward compatibility for "Active Set" drag drop if it generates AS_A1_RSCP
                        // Format: AS_A1_RSCP
                        const parts = col.split('_'); // [AS, A1, RSCP]
                        const key = parts[1].toLowerCase() + '_' + parts[2].toLowerCase(); // a1_rscp
                        val = p[key];
                    } else {
                        // Standard Column
                        // Try top level, then parsed
                        if (val === undefined && p.parsed && p.parsed.serving && p.parsed.serving[col] !== undefined) val = p.parsed.serving[col];

                        // Special case: level vs rscp vs signal
                        if ((col === 'rscp' || col === 'rscp_not_combined') && (val === undefined || val === null)) {
                            val = p.level;
                            if (val === undefined && p.parsed && p.parsed.serving) val = p.parsed.serving.level;
                        }

                        // Fallback for Freq
                        if (col === 'freq' && (val === undefined || val === null)) {
                            val = p.freq;
                        }
                    }

                    // Properties Fallback (Crucial for "Serving RSCP", "Serving SC", etc.)
                    if (val === undefined && p.properties && p.properties[col] !== undefined) {
                        val = p.properties[col];
                    }

                    // Special formatting for Cell ID in Grid
                    if (col.toLowerCase() === 'cellid' && p.rnc !== null && p.rnc !== undefined) {
                        const cid = p.cid !== undefined && p.cid !== null ? p.cid : (p.cellId & 0xFFFF);
                        val = (p.rnc) + '/' + (cid);
                    }

                    // Format numbers
                    if (val === undefined || val === null) val = '';
                    if (typeof val === 'number') {
                        if (String(val).includes('.')) val = val.toFixed(2); // Cleaner floats
                    }

                    row += '<td style="padding:4px 8px; border-bottom:1px solid #333;">' + (val) + '</td>';
                });
                row += '</tr>';
                rowsHtml += row;
            });

            tableHtml += rowsHtml + '</tbody></table>';
            container.innerHTML = tableHtml;

        } catch (err) {
            console.error('Render Grid Error', err);
        }
    };

    // ----------------------------------------------------
    // GLOBAL SYNC HIGHLIGHTER
    // ----------------------------------------------------
    // Optimization: Track last highlighted row to avoid O(N) DOM query
    window.lastHighlightedRowIndex = null;

    window.highlightPoint = (logId, index) => {
        // 1. Highlight Grid Row
        if (window.currentGridLogId === logId) {
            const row = document.getElementById('grid-row-' + index);
            if (row) {
                row.classList.add('selected-row');
                // Debounce scroll or check if needed? ScrollIntoView is expensive.
                // Only scroll if strictly necessary? For now, keep it but maybe 'nearest'?
                row.scrollIntoView({ behavior: 'auto', block: 'nearest' }); // 'smooth' is slow for rapid sync
                window.lastHighlightedRowIndex = index;
            }
        }

        // 2. Highlight Map Marker (if map renderer supports it)
        if (window.map && window.map.highlightMarker) {
            window.map.highlightMarker(logId, index);
        }

        // 3. Highlight Chart
        if (window.currentChartInstance && window.currentChartLogId === logId) {
            if (window.currentChartActiveIndexSet) window.currentChartActiveIndexSet(index);

            // Zoom to point on chart
            const chart = window.currentChartInstance;
            if (chart.config.type === 'line') {
                const windowSize = 20; // View 20 points around selection
                const newMin = Math.max(0, index - windowSize / 2);
                const newMax = Math.min(chart.data.labels.length - 1, index + windowSize / 2);

                // Update Zoom Limits
                chart.options.scales.x.min = newMin;
                chart.options.scales.x.max = newMax;
                chart.update('none'); // Efficient update
            }
        }

        // 4. Highlight Signaling (Time-based Sync)
        const signalingModal = document.getElementById('signalingModal');
        // Ensure visible
        if (logId && (signalingModal.style.display !== 'none' || window.isSignalingDocked)) {
            if (window.currentSignalingLogId !== logId && window.showSignalingModal) {
                window.showSignalingModal(logId);
            }

            const log = loadedLogs.find(l => l.id === logId);
            if (log && log.points && log.points[index]) {
                const point = log.points[index];
                const targetTime = point.time;
                const parseTime = (t) => {
                    const [h, m, s] = t.split(':');
                    return (parseInt(h) * 3600 + parseInt(m) * 60 + parseFloat(s)) * 1000;
                };
                const tTarget = parseTime(targetTime);

                let bestIdx = null;
                let minDiff = Infinity;
                const rows = document.querySelectorAll('#signalingTableBody tr');

                rows.forEach((row) => {
                    if (!row.pointData) return;
                    // Reset style
                    row.classList.remove('selected-row');
                    row.style.background = ''; // Clear inline

                    const t = parseTime(row.pointData.time);
                    const diff = Math.abs(t - tTarget);
                    if (diff < minDiff) { // Sync within 5s
                        minDiff = diff;
                        bestIdx = row;
                    }
                });

                if (bestIdx && minDiff < 5000) {
                    bestIdx.classList.add('selected-row');
                    bestIdx.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
            }
        }
    };

    const handleGridDrop = (e) => {
        e.preventDefault();
        e.currentTarget.style.boxShadow = 'none';

        try {
            const data = JSON.parse(e.dataTransfer.getData('application/json'));
            if (data && data.logId && data.param) {
                // Verify Log ID Match
                if (data.logId !== window.currentGridLogId) {
                    alert('Cannot add metric from a different log. Please open a new grid for that log.');
                    return;
                }

                // Add Column if not exists
                if (data.param === 'active_set') {
                    // Explode into 6 columns
                    const columns = ['AS_A1_RSCP', 'AS_A1_SC', 'AS_A2_RSCP', 'AS_A2_SC', 'AS_A3_RSCP', 'AS_A3_SC'];
                    columns.forEach(col => {
                        if (!window.currentGridColumns.includes(col)) {
                            window.currentGridColumns.push(col);
                        }
                    });
                    renderGrid();
                } else if (!window.currentGridColumns.includes(data.param)) {
                    window.currentGridColumns.push(data.param);
                    renderGrid();
                }
            }
        } catch (err) {
            console.error('Grid Drop Error', err);
        }
    };

    const handleGridDragOver = (e) => {
        e.preventDefault();
        e.currentTarget.style.boxShadow = 'inset 0 0 20px rgba(59, 130, 246, 0.5)';
    };

    const handleGridDragLeave = (e) => {
        e.currentTarget.style.boxShadow = 'none';
    };

    // Initialize Draggable Logic
    function makeElementDraggable(headerEl, containerEl) {
        let isDragging = false;
        let startX, startY, initialLeft, initialTop;

        headerEl.onmousedown = dragMouseDown;

        function dragMouseDown(e) {
            // Prevent dragging if clicking on interactive elements
            if (e.target.closest('button, input, select, textarea, .sc-metric-button, .close')) return;

            e = e || window.event;
            e.preventDefault();
            // Get mouse cursor position at startup
            startX = e.clientX;
            startY = e.clientY;

            // Get element position (removing 'px' to get integer)
            const rect = containerEl.getBoundingClientRect();
            initialLeft = rect.left;
            initialTop = rect.top;

            // Lock position coordinates to allow smooth dragging even if right/bottom were used
            containerEl.style.left = initialLeft + "px";
            containerEl.style.top = initialTop + "px";
            containerEl.style.right = "auto";
            containerEl.style.bottom = "auto";

            document.onmouseup = closeDragElement;
            document.onmousemove = elementDrag;

            headerEl.style.cursor = 'grabbing';
            isDragging = true;
        }

        function elementDrag(e) {
            if (!isDragging) return;
            e = e || window.event;
            e.preventDefault();

            // Calculate cursor movement
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;

            let newLeft = initialLeft + dx;
            let newTop = initialTop + dy;

            // Bounds Checking
            const rect = containerEl.getBoundingClientRect();
            const winW = window.innerWidth;
            const winH = window.innerHeight;

            // Prevent dragging off left/right
            if (newLeft < 0) newLeft = 0;
            if (newLeft + rect.width > winW) newLeft = winW - rect.width;

            // Prevent dragging off top/bottom
            if (newTop < 0) newTop = 0;
            if (newTop + rect.height > winH) newTop = winH - rect.height;

            // Set new position
            containerEl.style.left = newLeft + "px";
            containerEl.style.top = newTop + "px";

            // Remove any margin that might interfere
            containerEl.style.margin = "0";
        }

        function closeDragElement() {
            isDragging = false;
            document.onmouseup = null;
            document.onmousemove = null;
            headerEl.style.cursor = 'grab';
        }

        headerEl.style.cursor = 'grab';
    }

    // Expose to window for global access
    window.makeElementDraggable = makeElementDraggable;

    // Helper: Make analysis modals draggable + ensure top layer
    window.attachAnalysisDrag = (overlayEl) => {
        if (!overlayEl) return;
        overlayEl.style.zIndex = '10003';
        overlayEl.dataset.dragging = 'false';
        const modal = overlayEl.querySelector('.analysis-modal');
        const header = overlayEl.querySelector('.analysis-header');
        if (modal) {
            modal.style.position = 'fixed';
            modal.style.top = '80px';
            modal.style.left = '50%';
            modal.style.transform = 'translateX(-50%)';
            modal.style.zIndex = '10004';
            const rect = modal.getBoundingClientRect();
            modal.style.left = rect.left + 'px';
            modal.style.top = rect.top + 'px';
            modal.style.transform = 'none';
        }
        if (header && modal && typeof makeElementDraggable === 'function') {
            header.style.cursor = 'grab';
            makeElementDraggable(header, modal);
            modal.dataset.draggable = 'true';
            header.addEventListener('mousedown', () => {
                overlayEl.dataset.dragging = 'true';
                const stopDrag = () => {
                    overlayEl.dataset.dragging = 'false';
                    document.removeEventListener('mouseup', stopDrag);
                };
                document.addEventListener('mouseup', stopDrag);
            });
        }
    };

    // Attach Listeners to Grid Modal
    const gridModal = document.getElementById('gridModal');
    if (gridModal) {
        const content = gridModal.querySelector('.modal-content');
        if (content) {
            content.addEventListener('dragover', handleGridDragOver);
            content.addEventListener('dragleave', handleGridDragLeave);
            content.addEventListener('drop', handleGridDrop);
        }

        // Make Header Draggable
        const header = gridModal.querySelector('.modal-header');
        if (header) {
            makeElementDraggable(header, gridModal);
        }
    }

    // Make Floating Info Panel Draggable
    const floatPanel = document.getElementById('floatingInfoPanel');
    const floatHeader = document.getElementById('infoPanelHeader');
    if (floatPanel && floatHeader) {
        // Reuse existing drag logic helper if simple enough, or roll strict one.
        // makeElementDraggable expects (headerEl, containerEl) and handles absolute positioning.
        // floatPanel is fixed, but logic usually sets top/left style which works for fixed too.
        makeElementDraggable(floatHeader, floatPanel);
    }

    // Attach Listeners to Docked Grid (Enable Drop when Docked)
    const dockedGridEl = document.getElementById('dockedGrid');
    if (dockedGridEl) {
        dockedGridEl.addEventListener('dragover', handleGridDragOver);
        dockedGridEl.addEventListener('dragleave', handleGridDragLeave);
        dockedGridEl.addEventListener('drop', handleGridDrop);
    }

    // Docking Logic
    window.isGridDocked = false;

    // Docking Logic for Grid
    window.dockGrid = () => {
        if (window.isGridDocked) return;
        window.isGridDocked = true;

        const modal = document.getElementById('gridModal');
        // Support both class names during transition or use loose selector
        const modalContent = modal.querySelector('.modal-content') || modal.querySelector('.modal-content-grid');
        const dockContainer = document.getElementById('dockedGrid');

        if (modalContent && dockContainer) {
            // Move Header and Body
            const header = modalContent.querySelector('.grid-modal-header') || modalContent.querySelector('.modal-header');
            const body = modalContent.querySelector('.grid-body') || modalContent.querySelector('.modal-body');

            if (header && body) {
                // Clear placeholders (like dockedGridBody) to prevent layout conflicts
                dockContainer.innerHTML = '';
                dockContainer.appendChild(header);
                dockContainer.appendChild(body);

                // Update UI (Button in Docked View)
                const dockBtn = header.querySelector('.dock-btn') || header.querySelector('.btn-dock');
                if (dockBtn) {
                    dockBtn.innerHTML = '&#8599;'; // Undock Icon (North East Arrow)
                    dockBtn.title = 'Undock';
                    dockBtn.onclick = window.undockGrid; // Correct: Click to Undock
                    dockBtn.style.background = '#555';
                }
                const closeBtn = header.querySelector('.close');
                if (closeBtn) closeBtn.style.display = 'none'; // Hide close button in docked mode

                modal.style.display = 'none'; // Hide modal when docked
                updateDockedLayout(); // Show docked container
            }
        }
    };

    window.toggleGridDock = () => {
        if (window.isGridDocked) window.undockGrid();
        else window.dockGrid();
    };
    window.undockGrid = () => {
        if (!window.isGridDocked) return;
        window.isGridDocked = false;

        const modal = document.getElementById('gridModal');
        const modalContent = modal.querySelector('.modal-content') || modal.querySelector('.modal-content-grid');
        const dockContainer = document.getElementById('dockedGrid');

        // Note: dockContainer has them as direct children now
        const header = dockContainer.querySelector('.grid-modal-header') || dockContainer.querySelector('.modal-header');
        const body = dockContainer.querySelector('.grid-body') || dockContainer.querySelector('.modal-body');

        if (header && body) {
            modalContent.appendChild(header);
            modalContent.appendChild(body);

            // Update UI
            const dockBtn = header.querySelector('.dock-btn') || header.querySelector('.btn-dock');
            if (dockBtn) {
                dockBtn.innerHTML = '&#8601;'; // Undock Icon (fixed from down arrow)
                dockBtn.title = 'Dock';
                dockBtn.onclick = window.dockGrid;
                dockBtn.style.background = '#444'; // fixed color
            }
            // Show Close Button
            const closeBtn = header.querySelector('.close');
            if (closeBtn) closeBtn.style.display = 'block';

            modal.style.display = 'block';
            dockContainer.innerHTML = ''; // Clear remnants
            updateDockedLayout();
        }
        renderGrid();
    };

    // Export Grid to CSV
    window.exportGridToCSV = () => {
        if (!window.currentGridLogId || !window.currentGridColumns) return;
        const log = loadedLogs.find(l => l.id === window.currentGridLogId);
        if (!log) return;

        const headers = ['Time', 'Lat', 'Lng', ...window.currentGridColumns.map(c => c.toUpperCase())];
        const rows = [headers.join(',')];

        // Limit should match render limit or be unlimited for export? 
        // User probably expects ALL points in export. I will export ALL points.
        log.points.forEach(p => {
            // Basic columns
            let rowData = [
                p.time || '',
                p.lat,
                p.lng
            ];

            // Dynamic parameter columns
            window.currentGridColumns.forEach(col => {
                let val = p[col];

                // Fallback to properties if not at root
                if (val === undefined && p.properties) {
                    val = p.properties[col];
                }

                // --- Logic mirrored from renderGrid ---
                // Neighbors
                if (col.startsWith('n') && col.includes('_')) {
                    const parts = col.split('_');
                    const nIdx = parseInt(parts[0].replace('n', '')) - 1;
                    let field = parts[1];
                    if (field === 'sc') field = 'pci';

                    if (p.parsed && p.parsed.neighbors && p.parsed.neighbors[nIdx]) {
                        const nestedVal = p.parsed.neighbors[nIdx][field];
                        if (nestedVal !== undefined) val = nestedVal;
                    }
                } else if (col === 'band' || col === 'rscp' || col === 'rscp_not_combined' || col === 'ecno' || col === 'sc' || col === 'freq' || col === 'lac' || col === 'level' || col === 'active_set') {
                    // Try top level, then parsed
                    if (val === undefined && p.parsed && p.parsed.serving && p.parsed.serving[col] !== undefined) val = p.parsed.serving[col];

                    // Special case fallbacks
                    if ((col === 'rscp' || col === 'rscp_not_combined') && (val === undefined || val === null)) {
                        val = p.level;
                        if (val === undefined && p.parsed && p.parsed.serving) val = p.parsed.serving.level;
                    }
                    if (col === 'freq' && (val === undefined || val === null)) {
                        val = p.freq;
                    }

                }
                // --------------------------------------

                // RNC/CID Formatting for Export (Moved outside to ensure it runs)
                if (col.toLowerCase() === 'cellid' && (p.rnc !== null && p.rnc !== undefined)) {
                    const cid = p.cid !== undefined && p.cid !== null ? p.cid : (p.cellId & 0xFFFF);
                    val = (p.rnc) + '/' + (cid);
                }

                if (val === undefined || val === null) val = '';
                // Escape commas for CSV
                if (String(val).includes(',')) val = '"' + (val) + '"';
                rowData.push(val);
            });
            rows.push(rowData.join(','));
        });

        const csvContent = "data:text/csv;charset=utf-8," + rows.join("\n");
        const encodedUri = encodeURI(csvContent);
        const link = document.createElement("a");
        link.setAttribute("href", encodedUri);
        link.setAttribute("download", 'grid_export_' + (log.name) + '.csv');
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    };

    // Sort Grid (Stub - to prevent error if clicked, though implementation is non-trivial for dynamic cols)
    window.sortGrid = () => {
        alert('Sort functionality coming soon.');
    };

    window.toggleGridDock = () => {
        if (window.isGridDocked) window.undockGrid();
        else window.dockGrid();
    };

    window.openGridModal = (log, param) => {
        window.currentGridLogId = log.id;
        window.currentGridColumns = [param];

        if (window.isGridDocked) {
            document.getElementById('dockedGrid').style.display = 'flex';
            document.getElementById('gridModal').style.display = 'none';
        } else {
            const modal = document.getElementById('gridModal');
            modal.style.display = 'block';
            document.getElementById('dockedGrid').style.display = 'none';
        }

        renderGrid();
    };



    // ----------------------------------------------------
    // EXPORT OPTIM FILE FEATURE
    // ----------------------------------------------------
    window.exportOptimFile = (logId) => {
        const log = loadedLogs.find(l => l.id === logId);
        if (!log) return;

        const headers = [
            'Date', 'Time', 'Latitude', 'Longitude',
            'Serving Band', 'Serving RSCP', 'Serving EcNo', 'Serving SC', 'Serving LAC', 'Serving Freq', 'Serving RNC',
            'N1 Band', 'N1 RSCP', 'N1 EcNo', 'N1 SC', 'N1 LAC', 'N1 Freq',
            'N2 Band', 'N2 RSCP', 'N2 EcNo', 'N2 SC', 'N2 LAC', 'N2 Freq',
            'N3 Band', 'N3 RSCP', 'N3 EcNo', 'N3 SC', 'N3 LAC', 'N3 Freq'
        ];

        // Helper to guess band from freq (Simplified logic matching parser)
        const getBand = (f) => {
            if (!f) return '';
            f = parseFloat(f);
            if (f >= 10562 && f <= 10838) return 'B1 (2100)';
            if (f >= 2937 && f <= 3088) return 'B8 (900)';
            if (f > 10000) return 'High Band';
            if (f < 4000) return 'Low Band';
            return 'Unknown';
        };

        const rows = [];
        rows.push(headers.join(','));

        log.points.forEach(p => {
            if (!p.parsed) return;

            const s = p.parsed.serving;
            const n = p.parsed.neighbors || [];

            const gn = (idx, field) => {
                if (idx >= n.length) return '';
                const nb = n[idx];
                if (field === 'band') return getBand(nb.freq);
                if (field === 'lac') return s.lac;
                return nb[field] !== undefined ? nb[field] : '';
            };

            const row = [
                new Date().toISOString().split('T')[0],
                p.time,
                p.lat,
                p.lng,
                getBand(s.freq),
                s.level,
                s.ecno !== null ? s.ecno : '',
                s.sc,
                s.lac,
                s.freq,
                p.rnc || '',
                gn(0, 'band'), gn(0, 'rscp'), gn(0, 'ecno'), gn(0, 'pci'), gn(0, 'lac'), gn(0, 'freq'),
                gn(1, 'band'), gn(1, 'rscp'), gn(1, 'ecno'), gn(1, 'pci'), gn(1, 'lac'), gn(1, 'freq'),
                gn(2, 'band'), gn(2, 'rscp'), gn(2, 'ecno'), gn(2, 'pci'), gn(2, 'lac'), gn(2, 'freq')
            ];
            rows.push(row.join(','));
        });

        const csvContent = "data:text/csv;charset=utf-8," + rows.join("\n");
        const encodedUri = encodeURI(csvContent);
        const link = document.createElement("a");
        link.setAttribute("href", encodedUri);
        link.setAttribute("download", (log.name) + '_optim_export.csv');
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    };


    // Expose removeLog globally for the onclick handler (dirty but quick for prototype)
    window.removeLog = (id) => {
        const index = loadedLogs.findIndex(l => l.id === id);
        if (index > -1) {
            map.removeLogLayer(id);
            loadedLogs.splice(index, 1);
            updateLogsList();
            fileStatus.textContent = 'Log removed.';
        }
    };

    // ----------------------------------------------------
    // CENTRALIZED SYNCHRONIZATION
    // ----------------------------------------------------
    // --- Global Helper: Lookup Cell Name from SiteData ---
    window.resolveSmartSite = (p) => {
        const NO_MATCH = { name: null, id: null };
        try {
            if (!window.mapRenderer) return NO_MATCH;

            // Use the central logic in MapRenderer
            const s = window.mapRenderer.getServingCell(p);

            if (s) {
                const tech = String(s.tech || '').toLowerCase();
                const isLte = tech.includes('4g') || tech.includes('lte') || Boolean(s.rawEnodebCellId);

                // LTE priority: use eNodeB ID-Cell ID as identity key.
                let finalId = s.cellId || s.calculatedEci || s.id;
                if (isLte && s.rawEnodebCellId) {
                    finalId = s.rawEnodebCellId;
                } else if (s.rnc && s.cid) {
                    finalId = (s.rnc) + '/' + (s.cid);
                }

                return {
                    name: s.cellName || s.name || s.siteName,
                    id: finalId,
                    lat: s.lat,
                    lng: s.lng,
                    tipLat: s.tipLat,
                    tipLng: s.tipLng,
                    azimuth: s.azimuth,
                    range: s.currentRadius || s.range || 100, // Expose visual radius with safe fallback
                    rnc: s.rnc,
                    cid: s.cid,
                    pci: s.pci || s.sc,
                    freq: s.currentFreq || s.freq,
                    rawEnodebCellId: s.rawEnodebCellId
                };
            }

            return NO_MATCH;
        } catch (e) {
            console.warn("resolveSmartSite error:", e);
            return NO_MATCH;
        }
    };


    // ----------------------------------------------------
    // --- Global Helper: Highlight and Pan ---
    // ----------------------------------------------------
    // --- Global Helper: Highlight and Pan ---
    window.highlightAndPan = (lat, lng, cellId, type) => {
        // 1. Pan to Sector (Keep Zoom)
        if (lat && lng && !isNaN(lat) && !isNaN(lng)) {
            if (window.map) window.map.panTo([lat, lng]);
            else if (window.mapRenderer && window.mapRenderer.map) window.mapRenderer.map.panTo([lat, lng]);
        }

        // 2. Highlight Sector
        if (window.mapRenderer && cellId) {
            const color = (type === 'serving') ? '#3b82f6' : '#22c55e'; // Blue or Green
            window.mapRenderer.setSectorHighlight(cellId, color);
        }
    };

    // Helper: Generate HTML and Connections for a SINGLE point
    function generatePointInfoHTML(p, logColor) {
        // ... (existing code) ...
        let connectionTargets = [];
        const sLac = p.lac || (p.parsed && p.parsed.serving ? p.parsed.serving.lac : null);
        const sFreq = p.freq || (p.parsed && p.parsed.serving ? p.parsed.serving.freq : null);

        // 1. Serving Cell Connection
        let servingRes = window.resolveSmartSite(p);
        const servingCellKey = servingRes && (servingRes.rawEnodebCellId || servingRes.id);
        if ((servingRes && Number.isFinite(Number(servingRes.lat)) && Number.isFinite(Number(servingRes.lng))) || servingCellKey) {
            connectionTargets.push({
                lat: Number.isFinite(Number(servingRes.lat)) ? Number(servingRes.lat) : null,
                lng: Number.isFinite(Number(servingRes.lng)) ? Number(servingRes.lng) : null,
                color: '#3b82f6', weight: 8, cellId: servingCellKey,
                azimuth: servingRes.azimuth, range: servingRes.range, // Enable "Tip" connection
                tipLat: servingRes.tipLat, tipLng: servingRes.tipLng
            });
        }

        const resolveNeighbor = (pci, cellId, freq) => {
            return window.resolveSmartSite({
                sc: pci, cellId: cellId, lac: sLac, freq: freq || sFreq, lat: p.lat, lng: p.lng
            });
        }

        // 2. Active Set Connections
        if (p.a2_sc !== undefined && p.a2_sc !== null) {
            const a2Res = resolveNeighbor(p.a2_sc, null, sFreq);
            if (a2Res.lat && a2Res.lng) connectionTargets.push({
                lat: a2Res.lat, lng: a2Res.lng, color: '#ef4444', weight: 8, cellId: a2Res.id,
                azimuth: a2Res.azimuth, range: a2Res.range, tipLat: a2Res.tipLat, tipLng: a2Res.tipLng
            });
        }
        if (p.a3_sc !== undefined && p.a3_sc !== null) {
            const a3Res = resolveNeighbor(p.a3_sc, null, sFreq);
            if (a3Res.lat && a3Res.lng) connectionTargets.push({
                lat: a3Res.lat, lng: a3Res.lng, color: '#ef4444', weight: 8, cellId: a3Res.id,
                azimuth: a3Res.azimuth, range: a3Res.range, tipLat: a3Res.tipLat, tipLng: a3Res.tipLng
            });
        }

        // Generate RAW Data HTML
        let rawHtml = '';

        // Ensure properties exist, fallback to p (filtered) if not
        const sourceObj = p.properties ? p.properties : p;
        const ignoredKeys = ['lat', 'lng', 'parsed', 'layer', '_neighborsHelper', 'details', 'active_set', 'properties'];

        Object.entries(sourceObj).forEach(([k, v]) => {
            if (!p.properties) {
                if (ignoredKeys.includes(k)) return;
                if (typeof v === 'object' && v !== null) return;
                if (typeof v === 'function') return;
            } else {
                // For Excel/CSV, hide internal tracking keys if any exist in properties
                if (k.toLowerCase() === 'lat' || k.toLowerCase() === 'latitude') return;
                if (k.toLowerCase() === 'lng' || k.toLowerCase() === 'longitude' || k.toLowerCase() === 'lon') return;
            }

            // Skip null/undefined/empty
            if (v === null || v === undefined || v === '') return;

            // Format Value
            let displayVal = v;
            if (typeof v === 'number') {
                if (Number.isInteger(v)) displayVal = v;
                else displayVal = Number(v).toFixed(3).replace(/\.?0+$/, '');
            }

            rawHtml += '<div style="display:flex; justify-content:space-between; border-bottom:1px solid #444; font-size:11px; padding:3px 0;">\n' +
                '                <span style="color:#aaa; font-weight:500; margin-right: 10px;">' + (k) + '</span>\n' +
                '                <span style="color:#fff; font-weight:bold; word-break: break-all; text-align: right;">' + (displayVal) + '</span>\n' +
                '            </div>';
        });

        let html = '\n' +
            '            <div style="padding: 10px;">\n' +
            '                <!-- Serving Cell Header (Fixed) -->\n' +
            '                ' + (servingRes && servingRes.name ?
                '<div style="margin-bottom:10px; padding-bottom:10px; border-bottom:1px solid #444;">' +
                '    <div style="font-size:14px; font-weight:bold; color:#22c55e;">' + servingRes.name + '</div>' +
                '    <div style="font-size:11px; color:#888;">ID: ' + (servingRes.id || '-') + '</div>' +
                '</div>' : '') + '\n' +
            '\n' +
            '                <div style="display:flex; justify-content:space-between; margin-bottom:10px; border-bottom: 2px solid #555; padding-bottom:5px;">\n' +
            '                    <span style="font-size:12px; color:#ccc;">' + (p.time || sourceObj.Time || 'No Time') + '</span>\n' +
            '                    <span style="font-size:12px; color:#ccc;">' + (p.lat.toFixed(5)) + ', ' + (p.lng.toFixed(5)) + '</span>\n' +
            '                </div>\n' +
            '\n' +
            '                <!-- Event Info (Highlight) -->\n' +
            '                ' + (p.event ?
                '<div style="background:#451a1a; color:#f87171; padding:5px; border-radius:4px; margin-bottom:10px; font-weight:bold; text-align:center;">' +
                p.event +
                '</div>' : '') + '\n' +
            '                \n' +
            '                <div class="raw-data-container" style="max-height: 400px; overflow-y: auto;">\n' +
            '                    ' + (rawHtml) + '\n' +
            '                </div>\n' +
            '                \n' +
            '                <div style="display:flex; flex-wrap:wrap; gap:5px; margin-top:10px;">\n' +
            '                    <button class="btn btn-blue" onclick="window.analyzePoint(this)" style="flex:1; justify-content: center; min-width: 120px;">SmartCare Analysis</button>\n' +
            '                    <button class="btn btn-blue" onclick="window.deepAnalyzePoint(this)" style="flex:1; justify-content: center; min-width: 120px; background-color:#0f766e; color:#fff;">Deep Analysis</button>\n' +
            '                    <button class="btn btn-blue" onclick="window.dtAnalyzePoint(this)" style="flex:1; justify-content: center; min-width: 120px; background-color:#0ea5e9; color:#fff;">DT Analysis</button>\n' +
            '                </div>\n' +
            '                    <!-- Hidden data stash for the analyzer -->\n' +
            '                    <script type="application/json" id="point-data-stash">\n' +
            '                    ${(() => {\n' +
            '                // Robust Key Finder for Stash\n' +
            '                const findKey = (obj, target) => {\n' +
            '                    const t = target.toLowerCase().replace(/\s/g, \'\');\n' +
            '                    for (let k of Object.keys(obj)) {\n' +
            '                        if (k.toLowerCase().replace(/\s/g, \'\') === t) return obj[k];\n' +
            '                    }\n' +
            '                    return undefined;\n' +
            '                };\n' +
            '                const cellName = findKey(sourceObj, \'Cell Name\') || findKey(sourceObj, \'CellName\') || findKey(sourceObj, \'Site Name\');\n' +
            '                const cellId = findKey(sourceObj, \'Cell ID\') || findKey(sourceObj, \'CellID\') || findKey(sourceObj, \'CI\');\n' +
            '\n' +
            '                return JSON.stringify({\n' +
            '                    ...sourceObj,\n' +
            '                    lat: p.lat,\n' +
            '                    lng: p.lng,\n' +
            '                    \'Cell Identifier\': servingRes && servingRes.name ? servingRes.name : (cellName || servingRes.id || cellId || \'Unknown\'),\n' +
            '                    \'Cell Name\': servingRes && servingRes.name ? servingRes.name : (cellName || \'Unknown\'),\n' +
            '                    \'Tech\': p.tech || sourceObj.Tech || (p.rsrp !== undefined ? \'LTE\' : \'UMTS\')\n' +
            '                });\n' +
            '            })()}\n' +
            '                    </script>\n' +
            '</div>' +
            '</div>';
        return { html, connectionTargets };
    }




    // --- ANALYSIS ENGINE & CONFIGURATION ---

    // 1. Default Thresholds (The Source of Truth)
    const defaultAnalysisThresholds = {
        coverage: {
            rsrp: { good: -90, fair: -100 }, // >= -90 Good, > -100 Fair
            rscp: { good: -85, fair: -95 }
        },
        quality: {
            rsrq: { good: -9, degraded: -11 }, // >= -9 Good, > -11 Degraded
            ecno: { good: -8, degraded: -12 },
            cqi: { good: 9, moderate: 6 }
        },
        userExp: {
            dlLowThptRatio: { severe: 80, degraded: 25 }, // >= 80 Severe, >= 25 Degraded
            ulLowThptRatio: 0 // Binary check usually
        },
        load: {
            prb: { congested: 80, moderate: 70, low: 10 } // >= 80 Congested, < 70 Moderate, <= 10 Very Low
        },
        spectral: {
            eff: { low: 2000, veryLow: 1000 } // < 2000 Low, < 1000 Very Low
        },
        stability: {
            bler: { unstable: 20, degraded: 10 } // > 20 Unstable, > 10 Degraded. (Logic inverted in code: <=10 Stable)
        },
        mimo: {
            rank2: { good: 30, limited: 15 } // >= 30 Good, >= 15 Limited
        }
    };

    // 2. Initialize Global State (Load from LocalStorage or Default)
    window.analysisThresholds = JSON.parse(localStorage.getItem('mr_analyzer_thresholds')) || JSON.parse(JSON.stringify(defaultAnalysisThresholds));

    // 3. Helper to Save
    window.saveAnalysisThresholds = () => {
        localStorage.setItem('mr_analyzer_thresholds', JSON.stringify(window.analysisThresholds));
        console.log('Thresholds saved:', window.analysisThresholds);
    };

    // 4. Helper to Reset
    window.resetAnalysisThresholds = () => {
        window.analysisThresholds = JSON.parse(JSON.stringify(defaultAnalysisThresholds));
        window.saveAnalysisThresholds();
        // Refresh UI if open
        if (document.getElementById('analysisSettingsForm')) {
            window.openAnalysisSettings();
        }
    };

    // 5. Settings Modal UI
    window.openAnalysisSettings = () => {
        const t = window.analysisThresholds;

        // Helper to create input row
        const row = (label, path, val, tooltip) => `
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
                <label style="flex:1; font-size:12px; color:#ccc;" title="${tooltip}">${label}</label>
                <input type="number" step="1" value="${val}" 
                    onchange="updateThreshold('${path}', this.value)"
                    style="width:60px; background:#333; border:1px solid #555; color:#fff; padding:2px 5px; border-radius:3px;">
        `;

        const html = `
            <div class="analysis-modal-overlay analysis-settings-overlay" onclick="if(event.target===this) this.remove()">
                <div class="analysis-modal" style="width: 500px; max-width: 90vw; background:#1f2937; border:1px solid #374151;">
                    <div class="analysis-header" style="background:#111827; padding:15px; border-bottom:1px solid #374151; display:flex; justify-content:space-between; align-items:center;">
                        <h3 style="margin:0; color:#fff;">Analysis Thresholds</h3>
                        <div style="display:flex; gap:10px;">
                            <button onclick="window.resetAnalysisThresholds()" style="background:#555; color:#fff; border:none; padding:4px 8px; border-radius:3px; font-size:11px; cursor:pointer;">Reset Defaults</button>
                            <button class="analysis-close-btn" onclick="this.closest('.analysis-modal-overlay').remove()" style="background:none; border:none; color:#fff; font-size:20px; cursor:pointer;">×</button>
                        </div>
                    </div>
                    <div id="analysisSettingsForm" class="analysis-content" style="padding: 20px; overflow-y:auto; max-height:70vh; color:#eee;">
                        
                        <h4 style="border-bottom:1px solid #444; padding-bottom:5px; margin-top:0;">Coverage (Good / Fair)</h4>
                        ${row('RSRP Good (>=)', 'coverage.rsrp.good', t.coverage.rsrp.good, 'Signal Level required to be considered Good')}
                        ${row('RSRP Fair (>)', 'coverage.rsrp.fair', t.coverage.rsrp.fair, 'Signal Level required to be considered Fair')}
                        
                        <h4 style="border-bottom:1px solid #444; padding-bottom:5px; margin-top:15px;">Quality (Good / Degraded)</h4>
                        ${row('RSRQ Good (>=)', 'quality.rsrq.good', t.quality.rsrq.good, 'Signal Quality required to be considered Good')}
                        ${row('RSRQ Degraded (>)', 'quality.rsrq.degraded', t.quality.rsrq.degraded, 'Signal Quality required to be considered Degraded')}
                        ${row('CQI Good (>=)', 'quality.cqi.good', t.quality.cqi.good, 'CQI required to be considered Good')}
                        ${row('CQI Moderate (>=)', 'quality.cqi.moderate', t.quality.cqi.moderate, 'CQI required to be considered Moderate')}

                        <h4 style="border-bottom:1px solid #444; padding-bottom:5px; margin-top:15px;">User Experience</h4>
                        ${row('DL Low Thpt Ratio - Severe (>=)', 'userExp.dlLowThptRatio.severe', t.userExp.dlLowThptRatio.severe, '% Samples with Low Throughput to be considered Severe')}
                        ${row('DL Low Thpt Ratio - Degraded (>=)', 'userExp.dlLowThptRatio.degraded', t.userExp.dlLowThptRatio.degraded, '% Samples with Low Throughput to be considered Degraded')}

                        <h4 style="border-bottom:1px solid #444; padding-bottom:5px; margin-top:15px;">Cell Load (PRB Usage)</h4>
                        ${row('Congested (>=)', 'load.prb.congested', t.load.prb.congested, 'Average DL PRB Usage to be considered Congested')}
                        ${row('Moderate (<)', 'load.prb.moderate', t.load.prb.moderate, 'Average DL PRB Usage to be considered Moderate')}
                        ${row('Very Low (<=)', 'load.prb.low', t.load.prb.low, 'Average DL PRB Usage to be considered Very Low')}

                    </div>
                    <div style="padding:15px; background:#111827; border-top:1px solid #374151; text-align:right;">
                        <button onclick="document.querySelector('.analysis-settings-overlay').remove();" style="background:#2563eb; color:white; border:none; padding:6px 15px; border-radius:4px; cursor:pointer;">Done</button>
                    </div>
                </div>
        `;

        const div = document.createElement('div');
        div.innerHTML = html;
        document.body.appendChild(div.firstElementChild);

        // Global Updater for Inputs
        window.updateThreshold = (path, value) => {
            const keys = path.split('.');
            let obj = window.analysisThresholds;
            for (let i = 0; i < keys.length - 1; i++) {
                obj = obj[keys[i]];
            }
            obj[keys[keys.length - 1]] = parseFloat(value);
            window.saveAnalysisThresholds();
        };
    };


    function analyzeSmartCarePoint(data) {
        // --- Safe KPI extractor ---
        const getVal = (...aliases) => {
            for (const a of aliases) {
                const na = a.toLowerCase().replace(/[\s\-_()%]/g, '');
                for (const k in data) {
                    const nk = k.toLowerCase().replace(/[\s\-_()%]/g, '');
                    if (nk === na || nk.includes(na)) {
                        const v = parseFloat(data[k]);
                        if (!Number.isNaN(v)) return v;
                    }
                }
            }
            return null;
        };

        // --- Safe String extractor ---
        const getStringVal = (...aliases) => {
            for (const a of aliases) {
                const na = a.toLowerCase().replace(/[\s\-_()%]/g, '');
                for (const k in data) {
                    const nk = k.toLowerCase().replace(/[\s\-_()%]/g, '');
                    if (nk === na || nk.includes(na)) {
                        return data[k];
                    }
                }
            }
            return null;
        };

        // --- Extract ALL SmartCare KPIs ---
        const kpi = {
            rsrp: getVal('dominant rsrp'),
            rsrq: getVal('dominant rsrq'),
            cqi: getVal('average dl wideband cqi'),
            cqi0: getVal('average dl wideband cqi (code word 0)', 'average dl wideband cqi code word 0'),
            cqi1: getVal('average dl wideband cqi (code word 1)', 'average dl wideband cqi code word 1'),
            dlLow: getVal('dl low-throughput ratio'),
            dlSpecEff: getVal('dl spectrum efficiency'),
            ulSpecEff: getVal('ul spectrum efficiency'),
            dlRB: getVal('average dl rb quantity'),
            ulLow: getVal('ul low-throughput ratio'),
            ulRB: getVal('average ul rb quantity'),
            mrCount: getVal('dominant mr count'),
            traffic: getVal('total traffic volume'),

            // --- MIMO / Rank ---
            rank1Pct: getVal('rank 1 percentage'),
            rank2Pct: getVal('rank 2 percentage'),
            rank3Pct: getVal('rank 3 percentage'),
            rank4Pct: getVal('rank 4 percentage'),

            // --- BLER ---
            dlBler: getVal('dl ibler'),
            ulBler: getVal('ul ibler'),

            // --- Carrier Aggregation ---
            dl1cc: getVal('dl 1cc percentage'),
            dl2cc: getVal('dl 2cc percentage'),
            dl3cc: getVal('dl 3cc percentage'),
            dl4cc: getVal('dl 4cc percentage'),

            // --- Throughput reference ---
            avgDlThp: getVal('average dl throughput'),
            maxDlThp: getVal('maximum dl throughput'),
            avgUlThp: getVal('average ul throughput'),
            maxUlThp: getVal('maximum ul throughput')
        };

        const identity = {
            enbName: getStringVal('eNodeB Name', 'eNodeBName', 'Site Name'),
            enbId: getStringVal('eNodeB ID-Cell ID', 'eNodeB ID - Cell ID', 'Cell ID')
        };

        // --- Status (Using Configured Thresholds) ---
        const status = {};
        const T = window.analysisThresholds;

        // Coverage
        if (kpi.rsrp !== null) {
            status.coverage =
                kpi.rsrp >= T.coverage.rsrp.good ? 'Good' :
                    kpi.rsrp > T.coverage.rsrp.fair ? 'Fair' : 'Poor';
        }

        // Quality
        if (kpi.rsrq !== null) {
            status.signalQuality =
                kpi.rsrq >= T.quality.rsrq.good ? 'Good' :
                    kpi.rsrq > T.quality.rsrq.degraded ? 'Degraded' : 'Poor';
        }

        if (kpi.cqi !== null) {
            status.channelQuality =
                kpi.cqi >= T.quality.cqi.good ? 'Good' :
                    kpi.cqi >= T.quality.cqi.moderate ? 'Moderate' : 'Poor';
        }

        // User Experience
        if (kpi.dlLow !== null) {
            status.dlUserExperience =
                kpi.dlLow >= T.userExp.dlLowThptRatio.severe ? 'Severely Degraded' :
                    kpi.dlLow >= T.userExp.dlLowThptRatio.degraded ? 'Degraded' : 'Acceptable';

            // Add binary check for UL if needed
            // if (kpi.ulLow !== null && kpi.ulLow > 0) ...
        }

        // Load
        if (kpi.dlRB !== null) {
            status.load =
                kpi.dlRB <= T.load.prb.low ? 'Very Low Load' :
                    kpi.dlRB < T.load.prb.moderate ? 'Moderate Load' : 'Congested';

            // Adjust to match user expectation: Congested if >= configured value
            if (kpi.dlRB >= T.load.prb.congested) status.load = 'Congested';
        }

        // Spectral Efficiency
        if (kpi.dlSpecEff !== null) {
            status.spectralEfficiency =
                kpi.dlSpecEff < T.spectral.eff.veryLow ? 'Very Low' :
                    kpi.dlSpecEff < T.spectral.eff.low ? 'Low' : 'Normal';
        }

        // MIMO Status
        if (kpi.rank2Pct !== null) {
            status.mimo =
                kpi.rank2Pct >= T.mimo.rank2.good ? 'Good' :
                    kpi.rank2Pct >= T.mimo.rank2.limited ? 'Limited' : 'Poor';
        }

        // --- Rank Dominance ---
        if (kpi.rank1Pct !== null && kpi.rank2Pct !== null) {
            if (kpi.rank1Pct > 70 && kpi.rank2Pct < 20) {
                status.rankBehavior = 'Rank-1 Dominant';
            } else {
                status.rankBehavior = 'Balanced MIMO';
            }
        }

        // --- Carrier Aggregation Status ---
        if (kpi.dl3cc !== null && kpi.dl3cc === 100 && status.spectralEfficiency !== 'Normal') {
            status.ca = 'Active but Ineffective';
        } else if (kpi.dl1cc !== null && kpi.dl1cc >= 60) {
            status.ca = 'Underutilized';
        } else if (kpi.dl2cc !== null || kpi.dl3cc !== null) {
            status.ca = 'Effective';
        }

        // --- BLER Status (Link Stability) ---
        if (kpi.dlBler !== null) {
            status.dlLink =
                kpi.dlBler <= T.stability.bler.degraded ? 'Stable' :
                    kpi.dlBler <= T.stability.bler.unstable ? 'Degraded' : 'Unstable';
        }

        // --- Interpretation ---
        const interpretation = [];

        if (status.coverage !== 'Poor' && status.signalQuality === 'Poor') {
            interpretation.push(
                'Signal power is available, but radio quality is degraded by interference.'
            );
        }

        if (status.dlUserExperience !== 'Acceptable' && kpi.ulLow === 0) {
            interpretation.push(
                'Downlink-only degradation detected; uplink performance is healthy.'
            );
        }

        if (
            status.coverage === 'Poor' &&
            status.channelQuality === 'Good'
        ) {
            interpretation.push(
                'Despite weak coverage, good CQI indicates selective scheduling and noise-limited conditions rather than strong interference.'
            );
        }

        // --- Throughput Root Causes ---
        const throughputRootCauses = [];

        if (status.dlUserExperience !== 'Acceptable') {
            // A) MIMO-related degradation
            if (status.mimo === 'Poor') {
                throughputRootCauses.push('Limited spatial multiplexing (low Rank-2 usage) is reducing DL throughput.');
            }
            // B) CA-related degradation
            if (status.ca === 'Active but Ineffective') {
                throughputRootCauses.push('Carrier Aggregation is enabled but secondary carriers have poor radio quality.');
            }
            // C) BLER-related degradation
            if (status.dlLink === 'Unstable') {
                throughputRootCauses.push('High DL BLER is causing retransmissions and reducing effective throughput.');
            }
            // D) Coverage-related degradation
            if (status.coverage === 'Poor') {
                throughputRootCauses.push('Weak signal strength at the cell edge limits achievable DL throughput.');
            }
            // E) CA + MIMO combined degradation (advanced)
            if (status.mimo === 'Poor' && status.ca === 'Underutilized') {
                throughputRootCauses.push('Throughput is limited by both poor MIMO utilization and lack of effective carrier aggregation.');
            }
        }

        // --- Diagnosis ---
        const diagnosis = [];

        if (
            status.coverage !== 'Poor' &&
            status.signalQuality === 'Poor' &&
            ['Low', 'Very Low'].includes(status.spectralEfficiency) &&
            status.load !== 'Congested'
        ) {
            diagnosis.push('Interference-Limited Cell');
        }

        if (
            status.coverage === 'Poor' &&
            ['Low', 'Very Low'].includes(status.spectralEfficiency)
        ) {
            diagnosis.push('Coverage-Limited Cell');
        }

        if (status.load === 'Congested') {
            diagnosis.push('Capacity-Limited Cell');
        }

        // --- Actions ---
        const actions = [];

        if (diagnosis.includes('Interference-Limited Cell')) {
            actions.push(
                'Increase electrical downtilt and reduce DL power where overlap exists',
                'Review neighbor relations and PCI planning'
            );
        }

        if (diagnosis.includes('Coverage-Limited Cell')) {
            actions.push(
                'Optimize physical parameters (Antenna height, Tilt, and Azimuth)',
                'Evaluate for New Site deployment or Repeater installation'
            );
        }

        if (status.load === 'Congested') {
            actions.push(
                'Perform Capacity Extension (Add new carrier or split sector)',
                'Review load balancing parameters and offload to underutilized layers'
            );
        }

        if (throughputRootCauses.some(c => c.includes('spatial multiplexing'))) {
            actions.push('Verify antenna cross-polarization and RF paths to improve MIMO performance');
        }
        if (throughputRootCauses.some(c => c.includes('Carrier Aggregation'))) {
            actions.push('Improve secondary carrier coverage and align antenna configuration across bands');
        }
        if (throughputRootCauses.some(c => c.includes('BLER'))) {
            actions.push('Optimize link adaptation and interference conditions to reduce retransmissions');
        }

        // --- Confidence ---
        let confidence = 35;
        if (kpi.mrCount >= 1000) confidence = 70;
        else if (kpi.mrCount >= 100) confidence = 55;

        if (status.dlUserExperience === 'Severely Degraded') confidence += 10;
        if (status.spectralEfficiency === 'Very Low') confidence += 10;
        if (interpretation.length) confidence += 10;
        if (kpi.mrCount < 20 || kpi.traffic < 1) confidence -= 20;

        confidence = Math.min(95, Math.max(20, confidence));

        return {
            kpi,
            status,
            interpretation,
            diagnosis,
            actions,
            confidence,
            throughputRootCauses,
            identity
        };
    }
    window.analyzeSmartCarePoint = analyzeSmartCarePoint;

    window.smartcareAnalysis = (btn) => {
        try {
            let script = document.getElementById('point-data-stash');
            if (!script && btn) {
                const container = btn.closest('.panel, .card, .modal') || btn.parentNode;
                script = container?.querySelector('#point-data-stash');
            }
            if (!script) {
                alert('Smartcare analysis data missing.');
                return;
            }

            const data = JSON.parse(script.textContent);
            const result = analyzeSmartCarePoint(data);
            const { kpi, status, identity } = result;

            const coverage = status.coverage || 'Unknown';
            const quality = status.signalQuality || 'Unknown';
            const dlExp = status.dlUserExperience || 'Unknown';
            const load = status.load || 'Unknown';
            const mimo = status.mimo || 'N/A';
            const ca = status.ca || 'N/A';

            const ulLow = kpi.ulLow ?? null;
            const ulExp = ulLow === null ? 'Unknown' : (ulLow >= 20 ? 'Degraded' : 'Good');

            const findings = [];
            const addFinding = (title, detail) => findings.push({ title, detail });

            if (coverage === 'Poor') addFinding('Coverage is weak', `RSRP ${kpi.rsrp ?? 'N/A'} dBm suggests cell-edge conditions.`);
            if (coverage === 'Fair') addFinding('Coverage is moderate', 'Performance may vary with mobility or fast fading.');
            if (quality === 'Poor' || quality === 'Degraded') addFinding('Radio quality is degraded', `RSRQ ${kpi.rsrq ?? 'N/A'} dB indicates interference or high load.`);

            if (dlExp !== 'Acceptable') addFinding('DL experience degraded', `Low-throughput ratio ${kpi.dlLow ?? 'N/A'}% indicates many slow sessions.`);
            else addFinding('DL experience healthy', 'Low-throughput ratio is low and DL rates are good.');

            if (ulExp === 'Degraded') addFinding('UL experience degraded', `UL low-throughput ratio ${kpi.ulLow ?? 'N/A'}% suggests UL instability.`);

            if (kpi.avgDlThp !== null && kpi.avgDlThp < 3000) addFinding('Average DL throughput low', `Avg DL Thp ${(kpi.avgDlThp / 1000).toFixed(2)} Mbps is low for this load.`);
            if (kpi.avgUlThp !== null && kpi.avgUlThp < 1000) addFinding('Average UL throughput low', `Avg UL Thp ${(kpi.avgUlThp / 1000).toFixed(2)} Mbps is low.`);

            if (kpi.dlBler !== null && kpi.dlBler > 10) addFinding('DL BLER high', `DL IBLER ${kpi.dlBler.toFixed(2)}% may cause retransmissions.`);
            if (kpi.ulBler !== null && kpi.ulBler > 10) addFinding('UL BLER high', `UL IBLER ${kpi.ulBler.toFixed(2)}% indicates uplink errors.`);

            if (kpi.cqi !== null && kpi.cqi < 7) addFinding('CQI low', `CQI ${kpi.cqi.toFixed(2)} indicates poor DL channel quality.`);
            if (kpi.dlSpecEff !== null && kpi.dlSpecEff < 1000) addFinding('DL spectral efficiency low', `DL SE ${kpi.dlSpecEff.toFixed(0)} Kbps/MHz suggests inefficiency.`);

            if (mimo === 'Poor') addFinding('MIMO utilization poor', `Rank‑2 usage ${kpi.rank2Pct ?? 'N/A'}% is low.`);
            if (ca === 'Underutilized') addFinding('CA underutilized', `1CC ${kpi.dl1cc ?? 'N/A'}%, 2CC ${kpi.dl2cc ?? 'N/A'}%, 3CC ${kpi.dl3cc ?? 'N/A'}%.`);
            if (load === 'Congested') addFinding('Cell load congested', `DL RB ${kpi.dlRB ?? 'N/A'} indicates capacity pressure.`);

            const recommendations = [];
            const addRec = (title, detail, priority = 'P2') => {
                recommendations.push({ title, detail, priority });
            };

            if (ulExp === 'Degraded') {
                addRec('UL performance degraded',
                    'Check UL noise floor, uplink interference sources, and power control settings (TPC, target SNR).',
                    'P1');
            }
            if (kpi.ulBler !== null && kpi.ulBler > 10) {
                addRec('High UL BLER',
                    'Optimize UL link adaptation and verify UL coverage balance; consider tilt/height or UL interference cleanup.',
                    'P1');
            }
            if (kpi.dlBler !== null && kpi.dlBler > 10) {
                addRec('High DL BLER',
                    'Tune MCS and BLER targets; review interference and RSRQ distribution.',
                    'P1');
            }
            if (quality === 'Poor' || quality === 'Degraded') {
                addRec('Radio quality degraded',
                    'Investigate interference, neighbor dominance, and PCI/RSRQ distribution.',
                    'P2');
            }
            if (coverage === 'Poor') {
                addRec('Coverage weak',
                    'Review tilt/azimuth and consider small-cell or sector split for edge improvement.',
                    'P2');
            }
            if (load === 'Congested') {
                addRec('Capacity congestion',
                    'Add carrier or split sector; optimize load balancing to offload traffic.',
                    'P2');
            }
            if (mimo === 'Poor') {
                addRec('MIMO utilization low',
                    'Check antenna paths, cross‑pol isolation, and rank‑2 enablement.',
                    'P3');
            }
            if (ca === 'Underutilized') {
                addRec('CA underutilized',
                    'Review CA configuration and SCell add thresholds; ensure band overlap.',
                    'P3');
            }

            const existing = document.querySelector('.smartcare-analysis-modal');
            if (existing) existing.remove();

            const modalHtml = `
                <div class="analysis-modal-overlay smartcare-analysis-modal" style="z-index:10003;" onclick="if(event.target===this && this.dataset.dragging!=='true') this.remove()">
                    <div class="analysis-modal" style="width: 640px; max-width: 92vw; position:fixed; z-index:10004;">
                        <div class="analysis-header" style="background:#2563eb; cursor:grab;">
                            <h3>Smartcare LTE Analysis</h3>
                            <button class="analysis-close-btn" onclick="this.closest('.analysis-modal-overlay').remove()">×</button>
                        </div>
                        <div class="analysis-content" style="padding: 20px; background: #0b1220; color: #e5e7eb;">
                            ${identity?.enbName ? `<div style="font-size:13px; color:#e5e7eb;"><b>eNodeB:</b> ${identity.enbName}</div>` : ''}
                            ${identity?.enbId ? `<div style="font-size:12px; color:#9ca3af; margin-bottom:10px;"><b>ID:</b> ${identity.enbId}</div>` : ''}

                            <div style="font-size:13px; margin-bottom:10px;">
                                <div><b>Coverage:</b> ${coverage} (RSRP ${kpi.rsrp ?? 'N/A'} dBm)</div>
                                <div><b>Quality:</b> ${quality} (RSRQ ${kpi.rsrq ?? 'N/A'} dB)</div>
                                <div><b>DL Experience:</b> ${dlExp} (DL low-throughput ${kpi.dlLow ?? 'N/A'}%)</div>
                                <div><b>UL Experience:</b> ${ulExp} (UL low-throughput ${kpi.ulLow ?? 'N/A'}%)</div>
                                <div><b>Load:</b> ${load} (DL RB ${kpi.dlRB ?? 'N/A'}, UL RB ${kpi.ulRB ?? 'N/A'})</div>
                                <div><b>MIMO:</b> ${mimo} (Rank2 ${kpi.rank2Pct ?? 'N/A'}%)</div>
                                <div><b>CA:</b> ${ca} (3CC ${kpi.dl3cc ?? 'N/A'}%)</div>
                            </div>

                            <div style="margin-top:10px;">
                                <div style="font-size:12px; color:#38bdf8; margin-bottom:6px; text-transform:uppercase; letter-spacing:0.6px;">Findings</div>
                                ${findings.length ? findings.map(f => `
                                    <div style="margin-bottom:8px; font-size:12px; color:#e5e7eb;">
                                        • <b>${f.title}</b><br>
                                        <span style="color:#94a3b8;">${f.detail}</span>
                                    </div>
                                `).join('') : '<div>No major issues detected.</div>'}
                            </div>

                            <div style="margin-top:12px;">
                                <div style="font-size:12px; color:#38bdf8; margin-bottom:6px; text-transform:uppercase; letter-spacing:0.6px;">Recommendations</div>
                                ${recommendations.length ? recommendations.map(r => {
                                    const priColor = r.priority === 'P1' ? '#ef4444' : (r.priority === 'P2' ? '#f97316' : '#eab308');
                                    return `<div style="margin-bottom:8px; font-size:12px; color:#e5e7eb;">
                                        • <span style="color:${priColor}; font-weight:700;">[${r.priority}]</span> <b>${r.title}</b><br>
                                        <span style="color:#94a3b8;">${r.detail}</span>
                                    </div>`;
                                }).join('') : '<div>No specific recommendations.</div>'}
                            </div>
                        </div>
                    </div>
                </div>
            `;

            const div = document.createElement('div');
            div.innerHTML = modalHtml;
            const overlay = div.firstElementChild;
            document.body.appendChild(overlay);

            if (overlay) {
                if (typeof window.attachAnalysisDrag === 'function') {
                    window.attachAnalysisDrag(overlay);
                } else {
                    setTimeout(() => window.attachAnalysisDrag && window.attachAnalysisDrag(overlay), 0);
                }
            }
        } catch (e) {
            console.error('Smartcare analysis error:', e);
            alert('Smartcare analysis error: ' + e.message);
        }
    };

    function explainCoverage(status, kpi) {
        if (!status.coverage) return 'Coverage data unavailable.';
        const val = kpi.rsrp !== null ? `(${kpi.rsrp} dBm)` : '';
        if (status.coverage === 'Poor') {
            return `Weak signal strength ${val} indicates cell-edge or noise-limited conditions.`;
        }
        if (status.coverage === 'Fair') {
            return `Moderate signal strength ${val} suggests partial coverage or transition zone.`;
        }
        return `Strong received signal strength ${val} indicates good coverage conditions.`;
    }

    function deepGetVal(data, ...aliases) {
        for (const a of aliases) {
            const na = a.toLowerCase().replace(/[\s\-_()%]/g, '');
            for (const k in data) {
                const nk = k.toLowerCase().replace(/[\s\-_()%]/g, '');
                if (nk === na || nk.includes(na)) {
                    const v = parseFloat(data[k]);
                    if (!Number.isNaN(v)) return v;
                }
            }
        }
        return null;
    }

    function buildDeepAnalysisScenarios(data, result) {
        const { kpi, status } = result;
        const traffic = kpi.traffic ?? 0;
        const cqi = (kpi.cqi0 ?? kpi.cqi);
        const dlThp = kpi.avgDlThp;
        const dlBler = (kpi.dlBler ?? 0);
        const dlRb = (kpi.dlRB ?? 0);
        const rank1 = (kpi.rank1Pct ?? 0);
        const dl1cc = (kpi.dl1cc ?? 0);
        const users = deepGetVal(data, 'rrc connected users', 'average users', 'number of subscribers', 'subscriber count');
        const packetLoss = deepGetVal(data, 'dl packet loss rate', 'packet loss', 'pl', 'ip packet loss') ?? 0;
        const dlBigPacketThp = deepGetVal(data, 'dl big-packet throughput', 'dl big packet throughput', 'dl large packet throughput');
        const ulSmallPktTraffic = deepGetVal(data, 'ul small-packet traffic', 'ul small packet traffic', 'ul small packet volume');
        const ulTrafficVol = deepGetVal(data, 'ul traffic volume', 'total ul traffic volume', 'ul total traffic');
        const sccRsrp = deepGetVal(data, 'scc rsrp', 'scc1 rsrp', 'scc2 rsrp', 'secondary carrier rsrp');
        const qci8 = deepGetVal(data, 'qci8 traffic', 'qci 8 traffic', 'qci8 percentage', 'qci 8 percentage');
        const qci9 = deepGetVal(data, 'qci9 traffic', 'qci 9 traffic', 'qci9 percentage', 'qci 9 percentage');

        const DL_TRAFFIC_MIN_MB = 1;
        const DL_THP_LOW_THRESHOLD = 2000;
        const SUBSCRIBERS_HIGH_THRESHOLD = 20;
        const SCC_RSRP_THRESHOLD = -110;

        const ulSmallPktRatio = (ulSmallPktTraffic !== null && ulTrafficVol !== null && ulTrafficVol > 0)
            ? ((ulSmallPktTraffic / ulTrafficVol) * 100)
            : null;
        const qci8qci9Share = (qci8 !== null || qci9 !== null) ? ((qci8 || 0) + (qci9 || 0)) : null;

        const dlThpIsLow = dlThp !== null && dlThp < DL_THP_LOW_THRESHOLD;
        const toConfidence = (base) => Math.max(0.05, Math.min(0.98, Number(base.toFixed(2))));
        const scenarios = [];
        const allRcas = [];

        const fmtVal = (v, unit = '') => (v === null || v === undefined || Number.isNaN(v)) ? 'N/A' : `${v}${unit}`;
        const kpiSnapshot = [
            `DL Traffic=${fmtVal(Number(traffic.toFixed(3)), ' MB')}`,
            `DL Throughput=${fmtVal(dlThp, ' Kbps')}`,
            `DL Big-Packet Throughput=${fmtVal(dlBigPacketThp, ' Kbps')}`,
            `UL Small-Packet Ratio=${fmtVal(ulSmallPktRatio !== null ? Number(ulSmallPktRatio.toFixed(1)) : null, '%')}`,
            `RSRP=${fmtVal(kpi.rsrp, ' dBm')}`,
            `RSRQ=${fmtVal(kpi.rsrq, ' dB')}`,
            `CQI=${fmtVal(cqi)}`,
            `DL IBLER=${fmtVal(Number(dlBler.toFixed(2)), '%')}`,
            `DL RB=${fmtVal(Number(dlRb.toFixed(1)), '%')}`,
            `Subscribers=${fmtVal(users)}`,
            `Packet Loss=${fmtVal(packetLoss, '%')}`,
            `Rank1=${fmtVal(Number(rank1.toFixed(1)), '%')}`,
            `DL 1CC=${fmtVal(Number(dl1cc.toFixed(1)), '%')}`,
            `SCC RSRP=${fmtVal(sccRsrp, ' dBm')}`,
            `QCI8+QCI9=${fmtVal(qci8qci9Share !== null ? Number(qci8qci9Share.toFixed(1)) : null, '%')}`
        ];
        const buildNotMatchedText = (reasons) => {
            const checks = reasons.filter(Boolean).map((r, i) => `${i + 1}. ${r}`).join('\n');
            return [
                'This RCA is not the cause for this sample.',
                `Why not matched (actual vs required):\n${checks || 'No failed conditions captured.'}`
            ].join('\n\n');
        };

        const pushRca = (entry, matched, notMatchedReasons) => {
            if (matched) scenarios.push(entry);
            allRcas.push({
                ...entry,
                matched,
                suppressed: false,
                interpretation: matched ? entry.interpretation : 'Not matched: this RCA is not the cause for this sample.',
                technicalExplanation: matched ? entry.technicalExplanation : buildNotMatchedText(notMatchedReasons)
            });
        };

        // RCA-01: low-traffic indicator (does not suppress other RCA checks)
        const rca01 = (traffic < DL_TRAFFIC_MIN_MB) || (dlBigPacketThp === null && traffic < DL_TRAFFIC_MIN_MB);
        const rca01Entry = {
            scenarioId: 'RCA-01',
            scenarioName: 'Low Traffic – Throughput KPI Not Representative',
            domain: 'Traffic',
            interpretation: 'Throughput KPIs are statistically invalid due to insufficient payload.',
            technicalExplanation: `DL Traffic Volume is ${traffic.toFixed(3)} MB (< ${DL_TRAFFIC_MIN_MB} MB)${dlBigPacketThp === null ? ' and DL Big-Packet Throughput is N/A' : ''}.`,
            recommendedActions: [
                'Suppress all throughput degradation alarms.',
                'Mark cell as "Low Traffic / KPI Not Representative".',
                'Exclude from optimization actions.'
            ],
            confidenceScore: 0.98,
            severity: 'INFO'
        };
        pushRca(
            rca01Entry,
            rca01,
            [
                `DL Traffic Volume ${traffic.toFixed(3)} MB is >= ${DL_TRAFFIC_MIN_MB} MB`,
                'DL Big-Packet Throughput is available or traffic is not low'
            ],
        );

        const rca02Match =
            ulSmallPktRatio !== null && ulSmallPktRatio > 70 &&
            dlBigPacketThp === null &&
            dlThpIsLow;
        pushRca({
            scenarioId: 'RCA-02',
            scenarioName: 'Small-Packet Dominated Traffic (DL)',
            domain: 'Traffic',
            interpretation: 'Traffic pattern (signaling / IoT / keep-alive) prevents meaningful throughput.',
            technicalExplanation: `UL Small-Packet ratio is ${ulSmallPktRatio !== null ? ulSmallPktRatio.toFixed(1) : 'N/A'}% (>70%), DL Big-Packet Throughput is N/A, and DL Throughput is low (${dlThp ?? 'N/A'} Kbps).`,
            recommendedActions: [
                'Classify as application-driven behavior.',
                'Do not apply radio or capacity optimization.',
                'Inform KPI consumer that throughput is misleading.'
            ],
            confidenceScore: toConfidence(0.9),
            severity: 'INFO'
        }, rca02Match, [
            `UL Small-Packet ratio is ${ulSmallPktRatio === null ? 'N/A' : ulSmallPktRatio.toFixed(1) + '%'} (needs > 70%)`,
            `DL Big-Packet Throughput is ${dlBigPacketThp === null ? 'N/A' : 'available'}`,
            `DL Throughput is ${dlThp === null ? 'N/A' : dlThp + ' Kbps'} (needs < ${DL_THP_LOW_THRESHOLD})`
        ]);

        const rca03Match = (kpi.rsrp !== null && kpi.rsrp < -110) && (cqi !== null && cqi < 7) && traffic >= DL_TRAFFIC_MIN_MB;
        pushRca({
            scenarioId: 'RCA-03',
            scenarioName: 'Coverage-Limited Throughput',
            domain: 'Radio',
            interpretation: 'Weak signal forces low MCS, limiting throughput.',
            technicalExplanation: `RSRP ${kpi.rsrp} dBm (< -110), Average DL CQI ${cqi} (< 7), DL Traffic ${traffic.toFixed(3)} MB (>= 1 MB).`,
            recommendedActions: [
                'Coverage optimization (tilt, power, azimuth).',
                'Indoor solution or small cell.',
                'Monitor edge-user distribution.'
            ],
            confidenceScore: toConfidence(0.78),
            severity: 'MAJOR'
        }, rca03Match, [
            `RSRP ${kpi.rsrp ?? 'N/A'} dBm (needs < -110)`,
            `Average DL CQI ${cqi ?? 'N/A'} (needs < 7)`,
            `DL Traffic ${traffic.toFixed(3)} MB (needs >= 1 MB)`
        ]);

        const rca04Match = (kpi.rsrp !== null && kpi.rsrp >= -100) && (kpi.rsrq !== null && kpi.rsrq < -13) && dlBler > 10 && traffic >= DL_TRAFFIC_MIN_MB;
        pushRca({
            scenarioId: 'RCA-04',
            scenarioName: 'Interference-Limited Throughput',
            domain: 'Radio',
            interpretation: 'Interference reduces SINR causing retransmissions.',
            technicalExplanation: `RSRP ${kpi.rsrp} dBm (>= -100), RSRQ ${kpi.rsrq} dB (< -13), DL IBLER ${dlBler.toFixed(2)}% (>10), DL Traffic ${traffic.toFixed(3)} MB.`,
            recommendedActions: [
                'Interference audit.',
                'PCI / neighbor optimization.',
                'ICIC / eICIC tuning.'
            ],
            confidenceScore: toConfidence(0.8),
            severity: 'MAJOR'
        }, rca04Match, [
            `RSRP ${kpi.rsrp ?? 'N/A'} dBm (needs >= -100)`,
            `RSRQ ${kpi.rsrq ?? 'N/A'} dB (needs < -13)`,
            `DL IBLER ${dlBler.toFixed(2)}% (needs > 10)`,
            `DL Traffic ${traffic.toFixed(3)} MB (needs >= 1 MB)`
        ]);

        const rca05Match = dlRb > 80 && users !== null && users >= SUBSCRIBERS_HIGH_THRESHOLD && traffic >= DL_TRAFFIC_MIN_MB;
        pushRca({
            scenarioId: 'RCA-05',
            scenarioName: 'Congestion / Capacity Limitation',
            domain: 'Capacity',
            interpretation: 'Radio resources are exhausted due to high load.',
            technicalExplanation: `Average DL RB Quantity ${dlRb.toFixed(1)}% (>80), subscribers ${users} (high), DL Traffic ${traffic.toFixed(3)} MB.`,
            recommendedActions: [
                'Add carrier or bandwidth.',
                'Load balancing.',
                'Small cell deployment.'
            ],
            confidenceScore: toConfidence(0.85),
            severity: 'CRITICAL'
        }, rca05Match, [
            `Average DL RB Quantity ${dlRb.toFixed(1)}% (needs > 80)`,
            `Subscribers ${users ?? 'N/A'} (needs >= ${SUBSCRIBERS_HIGH_THRESHOLD})`,
            `DL Traffic ${traffic.toFixed(3)} MB (needs >= 1 MB)`
        ]);

        const rca06Match = (kpi.rsrp !== null && kpi.rsrp >= -100) && (cqi !== null && cqi >= 10) && packetLoss > 0;
        pushRca({
            scenarioId: 'RCA-06',
            scenarioName: 'Transport / Backhaul Bottleneck',
            domain: 'Transport',
            interpretation: 'Backhaul limits throughput despite good radio.',
            technicalExplanation: `RSRP ${kpi.rsrp} dBm (>= -100), Average DL CQI ${cqi} (>=10), DL Packet Loss Rate ${packetLoss}% (>0).`,
            recommendedActions: [
                'Upgrade backhaul capacity.',
                'Check QoS policing.',
                'Inspect S1 transport congestion.'
            ],
            confidenceScore: toConfidence(0.86),
            severity: 'CRITICAL'
        }, rca06Match, [
            `RSRP ${kpi.rsrp ?? 'N/A'} dBm (needs >= -100)`,
            `Average DL CQI ${cqi ?? 'N/A'} (needs >= 10)`,
            `DL Packet Loss Rate ${packetLoss}% (needs > 0)`
        ]);

        const rca07Match = dlBler > 15 && packetLoss <= 0.0001 && traffic >= DL_TRAFFIC_MIN_MB;
        pushRca({
            scenarioId: 'RCA-07',
            scenarioName: 'High Retransmissions (BLER Issue)',
            domain: 'Radio',
            interpretation: 'Excessive HARQ retransmissions reduce effective throughput.',
            technicalExplanation: `DL IBLER ${dlBler.toFixed(2)}% (>15), DL Packet Loss Rate ${packetLoss}% (=0), DL Traffic ${traffic.toFixed(3)} MB.`,
            recommendedActions: [
                'Tune link adaptation.',
                'Power control optimization.',
                'Interference mitigation.'
            ],
            confidenceScore: toConfidence(0.79),
            severity: 'MAJOR'
        }, rca07Match, [
            `DL IBLER ${dlBler.toFixed(2)}% (needs > 15)`,
            `DL Packet Loss Rate ${packetLoss}% (needs = 0)`,
            `DL Traffic ${traffic.toFixed(3)} MB (needs >= 1 MB)`
        ]);

        const rca08Match = rank1 > 80 && (kpi.rsrp !== null && kpi.rsrp >= -100) && traffic >= DL_TRAFFIC_MIN_MB;
        pushRca({
            scenarioId: 'RCA-08',
            scenarioName: 'MIMO Under-Utilization',
            domain: 'Radio',
            interpretation: 'Spatial multiplexing not achieved.',
            technicalExplanation: `Rank 1 Percentage ${rank1.toFixed(1)}% (>80), RSRP ${kpi.rsrp} dBm (>= -100), DL Traffic ${traffic.toFixed(3)} MB.`,
            recommendedActions: [
                'Antenna calibration.',
                'Cross-polarization check.',
                'Improve SINR.'
            ],
            confidenceScore: toConfidence(0.66),
            severity: 'MINOR'
        }, rca08Match, [
            `Rank 1 Percentage ${rank1.toFixed(1)}% (needs > 80)`,
            `RSRP ${kpi.rsrp ?? 'N/A'} dBm (needs >= -100)`,
            `DL Traffic ${traffic.toFixed(3)} MB (needs >= 1 MB)`
        ]);

        const rca09Match = dl1cc === 100 && sccRsrp !== null && sccRsrp >= SCC_RSRP_THRESHOLD && traffic >= DL_TRAFFIC_MIN_MB;
        pushRca({
            scenarioId: 'RCA-09',
            scenarioName: 'Carrier Aggregation Not Effective',
            domain: 'Capacity',
            interpretation: 'Bandwidth not fully utilized.',
            technicalExplanation: `DL 1CC Percentage is 100%, SCC RSRP ${sccRsrp} dBm (>= ${SCC_RSRP_THRESHOLD}), DL Traffic ${traffic.toFixed(3)} MB.`,
            recommendedActions: [
                'Verify CA configuration.',
                'Optimize SCC activation thresholds.',
                'License/config check.'
            ],
            confidenceScore: toConfidence(0.64),
            severity: 'MINOR'
        }, rca09Match, [
            `DL 1CC Percentage ${dl1cc.toFixed(1)}% (needs = 100%)`,
            `SCC RSRP ${sccRsrp ?? 'N/A'} dBm (needs >= ${SCC_RSRP_THRESHOLD})`,
            `DL Traffic ${traffic.toFixed(3)} MB (needs >= 1 MB)`
        ]);

        const rca10Match = qci8qci9Share !== null && qci8qci9Share > 80 && dlRb < 50 && dlThpIsLow;
        pushRca({
            scenarioId: 'RCA-10',
            scenarioName: 'QoS-Limited Throughput',
            domain: 'QoS',
            interpretation: 'Scheduler prioritization limits best-effort traffic.',
            technicalExplanation: `QCI 8+9 share is ${qci8qci9Share !== null ? qci8qci9Share.toFixed(1) : 'N/A'}% (>80), Average DL RB Quantity ${dlRb.toFixed(1)}% (<50), DL Throughput ${dlThp ?? 'N/A'} Kbps (low).`,
            recommendedActions: [
                'Review QoS policies.',
                'Adjust scheduler fairness.',
                'Capacity planning if persistent.'
            ],
            confidenceScore: toConfidence(0.62),
            severity: 'MINOR'
        }, rca10Match, [
            `QCI 8+9 share ${qci8qci9Share === null ? 'N/A' : qci8qci9Share.toFixed(1) + '%'} (needs > 80%)`,
            `Average DL RB Quantity ${dlRb.toFixed(1)}% (needs < 50%)`,
            `DL Throughput ${dlThp === null ? 'N/A' : dlThp + ' Kbps'} (needs < ${DL_THP_LOW_THRESHOLD})`
        ]);

        if (!scenarios.length) {
            scenarios.push({
                scenarioId: 'RCA-00',
                scenarioName: 'No Matching Throughput RCA',
                domain: 'Traffic',
                interpretation: 'No RCA rule matched this sample.',
                technicalExplanation: 'All configured RCA trigger conditions were evaluated in priority order without a match.',
                recommendedActions: [
                    'Keep monitoring with larger time windows.',
                    'Correlate with complaint and service-level data.'
                ],
                confidenceScore: toConfidence(0.5),
                severity: 'INFO'
            });
        }

        return {
            scenarios,
            allRcas,
            meta: {
                guardTriggered: rca01,
                throughputRepresentative: !(rca01 || scenarios.some(s => s.scenarioId === 'RCA-02')),
                suppressionApplied: false,
                mrMinThreshold: 'N/A',
                kpiSnapshot
            }
        };
    }

    window.deepAnalyzePoint = (btn) => {
        try {
            let script = document.getElementById('point-data-stash');
            if (!script && btn) {
                const container = btn.closest('.panel, .card, .modal') || btn.parentNode;
                script = container?.querySelector('#point-data-stash');
            }
            if (!script) {
                alert('Smartcare analysis data missing.');
                return;
            }

            const data = JSON.parse(script.textContent);
            const result = analyzeSmartCarePoint(data);
            const { kpi, status, identity, confidence } = result;
            const deepResult = buildDeepAnalysisScenarios(data, result);
            const scenarios = deepResult.scenarios;
            const orderedRcas = Array.isArray(deepResult.allRcas) && deepResult.allRcas.length ? deepResult.allRcas : scenarios;

            // Expose structured output for debugging/export integrations.
            window.lastDeepAnalysisResults = scenarios;
            window.lastDeepAnalysisAllRcas = orderedRcas;

            const severityColor = (sev) => (
                sev === 'CRITICAL' ? '#ef4444' :
                    sev === 'MAJOR' ? '#f97316' :
                        sev === 'MINOR' ? '#eab308' : '#22c55e'
            );

            const esc = (v) => String(v ?? '')
                .replaceAll('&', '&amp;')
                .replaceAll('<', '&lt;')
                .replaceAll('>', '&gt;')
                .replaceAll('"', '&quot;')
                .replaceAll("'", '&#39;');

            const stripHtml = (txt) => String(txt ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
            const sectionTitle = (num, title) => `
                <div style="display:flex; align-items:center; gap:10px; margin-top:14px;">
                    <span style="min-width:30px; height:30px; border-radius:8px; background:linear-gradient(180deg,#9ec5ff,#6b8fcf); color:#f8fafc; font-weight:700; display:inline-flex; align-items:center; justify-content:center; font-size:20px;">${num}</span>
                    <h4 style="margin:0; color:#60a5fa; font-size:clamp(24px,4vw,44px); font-weight:800; line-height:1.05;">${title}</h4>
                </div>
                <div style="height:1px; background:#334155; margin:12px 0 16px;"></div>
            `;

            const coverageLabel = status?.coverage || 'Unknown';
            const qualityLabel = status?.signalQuality || 'Unknown';
            const cqiLabel = status?.channelQuality || 'Unknown';
            const dlExpLabel = status?.dlUserExperience || 'Unknown';
            const loadLabel = status?.load || 'Unknown';
            const seLabel = status?.spectralEfficiency || 'Unknown';

            const dlAvgMbps = kpi.avgDlThp !== null && kpi.avgDlThp !== undefined ? (kpi.avgDlThp / 1000).toFixed(2) : 'N/A';
            const dlMaxMbps = kpi.maxDlThp !== null && kpi.maxDlThp !== undefined ? (kpi.maxDlThp / 1000).toFixed(2) : 'N/A';
            const spectralText = stripHtml(explainSpectralEfficiency(status || {}, kpi || {}));

            const scenarioCards = orderedRcas.map((s) => `
                <div style="background:#0f172a; border:1px solid #1f2937; border-radius:8px; padding:12px; margin-bottom:10px;">
                    <div style="display:flex; justify-content:space-between; gap:8px; align-items:center; margin-bottom:6px;">
                        <div style="font-size:13px; color:#e5e7eb; font-weight:700;">${esc(s.scenarioId)} - ${esc(s.scenarioName)}</div>
                        <div style="display:flex; gap:6px; align-items:center;">
                            <span style="font-size:11px; font-weight:700; padding:2px 8px; border-radius:999px; color:#fff; background:${s.matched ? '#15803d' : '#475569'};">${s.matched ? 'MATCHED' : 'NOT MATCHED'}</span>
                            <span style="font-size:11px; font-weight:700; padding:2px 8px; border-radius:999px; color:#fff; background:${severityColor(s.severity)};">${esc(s.severity)}</span>
                        </div>
                    </div>
                    <div style="font-size:11px; color:#94a3b8; margin-bottom:8px;">
                        <b>Domain:</b> ${esc(s.domain)} | <b>Confidence:</b> ${esc(s.confidenceScore)}
                    </div>
                    <div style="font-size:12px; color:#e5e7eb; margin-bottom:6px;">${esc(s.interpretation)}</div>
                    <div style="font-size:12px; color:#cbd5e1; margin-bottom:6px; white-space:pre-wrap;">${esc(s.technicalExplanation)}</div>
                    <ul style="margin:6px 0 0 18px; color:#d1d5db; font-size:12px;">
                        ${(s.recommendedActions || []).map(a => `<li>${esc(a)}</li>`).join('') || '<li>No actions</li>'}
                    </ul>
                </div>
            `).join('');

            const existing = document.querySelector('.deep-analysis-modal');
            if (existing) existing.remove();

            const modalHtml = `
                <div class="analysis-modal-overlay deep-analysis-modal" style="z-index:10003;" onclick="if(event.target===this && this.dataset.dragging!=='true') this.remove()">
                    <div class="analysis-modal" style="width: 760px; max-width: 95vw; position:fixed; z-index:10004;">
                        <div class="analysis-header" style="background:#0b2447; cursor:grab;">
                            <h3>Deep SmartCare Analysis</h3>
                            <button class="analysis-close-btn" onclick="this.closest('.analysis-modal-overlay').remove()">×</button>
                        </div>
                        <div class="analysis-content" style="padding:18px; background:#071326; color:#e5e7eb; max-height:78vh; overflow-y:auto;">
                            <div style="margin-bottom:10px;">
                                ${identity && identity.enbName ? `<div style="color:#e5e7eb; font-size:14px;"><b>eNodeB:</b> ${esc(identity.enbName)}</div>` : ''}
                                ${identity && identity.enbId ? `<div style="color:#9ca3af; font-size:12px;"><b>ID:</b> ${esc(identity.enbId)}</div>` : ''}
                            </div>
                            ${sectionTitle('1', 'Data Confidence Assessment')}
                            <ul style="margin:0 0 8px 18px; color:#e5e7eb; font-size:15px; line-height:1.8;">
                                <li><b>MR Count:</b> ${kpi.mrCount ?? 'N/A'}</li>
                                <li><b>Total Traffic:</b> ${kpi.traffic ?? 'N/A'} MB</li>
                                <li><b>Confidence Score:</b> ${confidence ?? 'N/A'}%</li>
                            </ul>

                            ${sectionTitle('2', 'Coverage Status')}
                            <p style="margin:0 0 6px; font-size:15px;"><b>Coverage:</b> <span style="color:${getStatusColor(coverageLabel)}; font-weight:700;">${esc(coverageLabel)}</span></p>
                            <p style="margin:0 0 12px; color:#cbd5e1; font-size:14px;">${esc(explainCoverage(status || {}, kpi || {}))}</p>

                            ${sectionTitle('3', 'Signal Quality')}
                            <p style="margin:0 0 6px; font-size:15px;"><b>Signal Quality:</b> <span style="color:${getStatusColor(qualityLabel)}; font-weight:700;">${esc(qualityLabel)}</span></p>
                            <p style="margin:0 0 12px; color:#cbd5e1; font-size:14px;">${esc(explainSignalQuality(status || {}, kpi || {}))}</p>

                            ${sectionTitle('4', 'Channel Quality')}
                            <p style="margin:0 0 6px; font-size:15px;"><b>CQI Status:</b> <span style="color:${getStatusColor(cqiLabel)}; font-weight:700;">${esc(cqiLabel)}</span></p>
                            <p style="margin:0 0 12px; color:#cbd5e1; font-size:14px;">${esc(explainCQI(status || {}, kpi || {}))}</p>

                            ${sectionTitle('5', 'Downlink User Experience')}
                            <p style="margin:0 0 6px; font-size:15px;"><b>DL Experience:</b> <span style="color:${getStatusColor(dlExpLabel)}; font-weight:700;">${esc(dlExpLabel)}</span></p>
                            <p style="margin:0 0 12px; color:#cbd5e1; font-size:14px;">User experience summary. Low-throughput ratio: ${kpi.dlLow ?? 'N/A'}% | Avg Thp: ${dlAvgMbps} Mbps, Max: ${dlMaxMbps} Mbps.</p>

                            ${sectionTitle('6', 'Load & Capacity')}
                            <p style="margin:0 0 6px; font-size:15px;"><b>Cell Load:</b> <span style="color:${getStatusColor(loadLabel)}; font-weight:700;">${esc(loadLabel)}</span></p>
                            <p style="margin:0 0 12px; color:#cbd5e1; font-size:14px;">${esc(explainLoad(status || {}, kpi || {}))}</p>

                            ${sectionTitle('7', 'Spectrum Efficiency')}
                            <p style="margin:0 0 6px; font-size:15px;"><b>Spectral Efficiency:</b> <span style="color:${getStatusColor(seLabel)}; font-weight:700;">${esc(seLabel)}</span></p>
                            <p style="margin:0 0 12px; color:#cbd5e1; font-size:14px;">${esc(spectralText || 'Spectral efficiency details unavailable.')}</p>

                            ${sectionTitle('8', 'All RCA Rules (Ordered Execution)')}
                            ${scenarioCards}
                        </div>
                    </div>
                </div>
            `;

            document.body.insertAdjacentHTML('beforeend', modalHtml);
            const overlay = document.querySelector('.deep-analysis-modal');
            const modal = overlay?.querySelector('.analysis-modal');
            const header = overlay?.querySelector('.analysis-header');
            if (header && modal && typeof makeElementDraggable === 'function') {
                makeElementDraggable(header, modal);
            }

            return scenarios;
        } catch (err) {
            console.error('Deep analysis error:', err);
            return [];
        }
    };

    function explainSignalQuality(status, kpi) {
        if (!status.signalQuality) return 'Signal quality data unavailable.';
        const val = kpi.rsrq !== null ? `(${kpi.rsrq} dB)` : '';
        if (status.signalQuality === 'Poor') {
            return `Poor RSRQ ${val} reflects degraded radio quality, often due to noise or interference.`;
        }
        if (status.signalQuality === 'Degraded') {
            return `RSRQ ${val} indicates moderate radio quality degradation.`;
        }
        return `Good RSRQ ${val} indicates clean radio conditions.`;
    }

    function explainCQI(status, kpi) {
        if (!status.channelQuality) return 'CQI data unavailable.';
        const val = kpi.cqi !== null ? `(CQI=${kpi.cqi})` : '';
        if (status.channelQuality === 'Good') {
            return `Good CQI ${val} indicates favorable SINR during scheduled transmissions.`;
        }
        if (status.channelQuality === 'Moderate') {
            return `CQI ${val} reflects variable radio conditions.`;
        }
        return `Low CQI ${val} indicates poor downlink channel quality.`;
    }

    function explainDLUserExperience(status, kpi) {
        if (!status.dlUserExperience) return 'DL experience data unavailable.';
        const lowRatio = kpi.dlLow !== null ? `Low-throughput ratio: ${kpi.dlLow}%` : '';
        const thpInfo = kpi.avgDlThp !== null ? `Avg Thp: ${(kpi.avgDlThp / 1000).toFixed(2)} Mbps, Max: ${((kpi.maxDlThp || 0) / 1000).toFixed(2)} Mbps` : '';
        const details = [lowRatio, thpInfo].filter(x => x).join(' | ');

        if (status.dlUserExperience === 'Degraded' || status.dlUserExperience === 'Severely Degraded') {
            return `Performance is constrained. ${details}. A significant portion of sessions suffer from low throughput.`;
        }
        return `User experience is acceptable. ${details}. Most user sessions achieve sufficient throughput.`;
    }

    function explainLoad(status, kpi) {
        if (!status.load) return 'Load data unavailable.';
        const val = kpi.dlRB !== null ? `(${kpi.dlRB} RBs)` : '';
        if (status.load === 'Congested') {
            return `High RB usage ${val} indicates capacity saturation.`;
        }
        return `Cell load ${val} is not a limiting factor.`;
    }

    function explainSpectralEfficiency(status, kpi) {
        if (!status.spectralEfficiency) return 'Spectral efficiency data unavailable.';
        const val = kpi.dlSpecEff !== null ? `(${kpi.dlSpecEff} bps/Hz)` : '';
        if (status.spectralEfficiency === 'Very Low') {
            // Convert Kbps/MHz to bps/Hz (divide by 1000)
            const valBpsHz = (kpi.dlSpecEff / 1000).toFixed(2);
            return `DL spectrum efficiency is critically low (${valBpsHz} bps/Hz), indicating severe radio inefficiency caused by retransmissions, poor MIMO utilization, and/or interference. Corrective actions should prioritize BLER reduction, MIMO optimization, and scheduler tuning. Performance must be validated after corrective measures.

            <div style="margin-top:10px;">
                <h5 style="color:#fcd34d; font-size:14px; margin-bottom:10px;">🧠 What This Means (Diagnosis)</h5>
                <p style="color:#ddd; font-size:12px; margin-bottom:10px;">
                    With very low spectrum efficiency, the cell:
                </p>
                <ul style="margin:5px 0 15px 15px; color:#ddd;">
                    <li>Consumes radio resources but delivers little data</li>
                    <li>Suffers from inefficient modulation, spatial multiplexing, or retransmissions</li>
                    <li>Is constrained by radio quality, MIMO, or scheduler behavior</li>
                </ul>

                <p style="color:#eee; font-size:12px; margin-bottom:15px;">
                    <strong>📉 Typical healthy DL SE:</strong><br>
                    • Good cell: 1.5–3.0 bps/Hz<br>
                    • Acceptable: ≥ 1.0 bps/Hz<br>
                    • Critical: < 0.7 bps/Hz<br>
                    ➡️ ${valBpsHz} bps/Hz = Critical radio degradation
                </p>

                <h5 style="color:#fcd34d; font-size:14px; margin-bottom:10px; cursor:pointer; user-select:none;" onclick="const el = this.nextElementSibling; el.style.display = el.style.display === 'none' ? 'block' : 'none';">🛠️ Corrective Actions (Prioritized) 🔽</h5>
                <div style="display:none;">

                <div style="margin-bottom:15px; border-left:3px solid #ef4444; padding-left:10px;">
                    <strong style="color:#f87171;">🔴 Priority 1 — Reduce BLER & Retransmissions (Top Driver)</strong><br>
                    <span style="font-size:12px; color:#bbb;">Goal: Stop wasting RBs</span>
                    <ul style="margin:5px 0 5px 15px; color:#ddd;">
                        <li>Tune DL BLER target (less aggressive)</li>
                        <li>Optimize CQI → MCS mapping</li>
                        <li>Reduce use of high-order modulation under unstable SINR</li>
                        <li>Investigate HARQ retransmission rates</li>
                    </ul>
                    <span style="font-size:12px; color:#86efac;">📌 High BLER is the fastest way to destroy spectrum efficiency.</span>
                </div>

                <div style="margin-bottom:15px; border-left:3px solid #ef4444; padding-left:10px;">
                    <strong style="color:#f87171;">🔴 Priority 2 — Improve MIMO Utilization</strong><br>
                    <span style="font-size:12px; color:#bbb;">Goal: Increase bits per RB</span>
                    <ul style="margin:5px 0 5px 15px; color:#ddd;">
                        <li>Investigate Rank-1 dominance</li>
                        <li>Inspect antenna & feeder health</li>
                        <li>Improve cross-polarization isolation</li>
                        <li>Enable / optimize beamforming</li>
                        <li>Tune rank switching thresholds</li>
                    </ul>
                    <span style="font-size:12px; color:#86efac;">📌 Without Rank-2+, SE will remain low regardless of CA.</span>
                </div>

                <div style="margin-bottom:15px; border-left:3px solid #ef4444; padding-left:10px;">
                    <strong style="color:#f87171;">🔴 Priority 3 — Interference Mitigation</strong><br>
                    <span style="font-size:12px; color:#bbb;">Goal: Improve SINR</span>
                    <ul style="margin:5px 0 5px 15px; color:#ddd;">
                        <li>Optimize antenna tilt & azimuth</li>
                        <li>Reduce overshooting cells</li>
                        <li>Tune ICIC / eICIC</li>
                        <li>Re-evaluate neighbor dominance</li>
                    </ul>
                    <span style="font-size:12px; color:#86efac;">📌 Poor RSRQ/SINR directly limits achievable MCS.</span>
                </div>

                <div style="margin-bottom:15px; border-left:3px solid #f97316; padding-left:10px;">
                    <strong style="color:#fdba74;">🟠 Priority 4 — Scheduler Optimization</strong><br>
                    <span style="font-size:12px; color:#bbb;">Goal: Use RBs efficiently</span>
                    <ul style="margin:5px 0 5px 15px; color:#ddd;">
                        <li>Tune proportional-fair scheduler</li>
                        <li>Avoid over-allocating RBs to poor-SINR UEs</li>
                        <li>Balance GBR vs non-GBR traffic</li>
                        <li>Enable CA-aware scheduling</li>
                    </ul>
                    <span style="font-size:12px; color:#86efac;">📌 Scheduler inefficiency amplifies radio problems.</span>
                </div>

                <div style="margin-bottom:15px; border-left:3px solid #f97316; padding-left:10px;">
                    <strong style="color:#fdba74;">🟠 Priority 5 — Carrier Aggregation & Band Alignment</strong><br>
                    <span style="font-size:12px; color:#bbb;">Goal: Maximize usable bandwidth efficiency</span>
                    <ul style="margin:5px 0 5px 15px; color:#ddd;">
                        <li>Ensure CA is active and utilized</li>
                        <li>Align PCell and SCell coverage</li>
                        <li>Remove overly strict SCell addition thresholds</li>
                    </ul>
                    <span style="font-size:12px; color:#86efac;">📌 CA improves throughput, but also stabilizes SE when used correctly.</span>
                </div>

                <div style="margin-bottom:15px; border-left:3px solid #eab308; padding-left:10px;">
                    <strong style="color:#fde047;">🟡 Priority 6 — Hardware & Parameter Audit</strong><br>
                    <span style="font-size:12px; color:#bbb;">Goal: Eliminate hidden losses</span>
                    <ul style="margin:5px 0 5px 15px; color:#ddd;">
                        <li>Check RRU output power balance</li>
                        <li>Verify VSWR / feeder losses</li>
                        <li>Audit recent parameter changes</li>
                        <li>Roll back mis-tuned features if needed</li>
                    </ul>
                </div>
                </div>
            </div>`;
        }
        if (status.spectralEfficiency === 'Low') {
            return `Low spectrum efficiency ${val} indicates radio limitations rather than traffic demand.`;
        }
        return `Spectrum efficiency ${val} is within expected range.`;
    }

    function explainMimo(status, kpi) {
        if (!status.mimo) return 'MIMO performance data unavailable.';
        const rankInfo = `Rank usage: R1=${kpi.rank1Pct || 0}%, R2=${kpi.rank2Pct || 0}%, R3=${kpi.rank3Pct || 0}%, R4=${kpi.rank4Pct || 0}%`;
        if (status.mimo === 'Poor') {
            return `MIMO performance is poor. ${status.rankBehavior}. ${rankInfo}. Recommend checking antenna paths.`;
        }
        if (status.mimo === 'Limited') {
            return `MIMO performance is limited. ${status.rankBehavior}. ${rankInfo}. Sub-optimal spatial multiplexing.`;
        }
        return `Good MIMO performance. ${status.rankBehavior}. ${rankInfo}. Spatial multiplexing is effective.`;
    }

    function explainCA(status, kpi) {
        if (!status.ca) return 'Carrier Aggregation data unavailable.';
        const ccInfo = `CC usage: 1CC=${kpi.dl1cc || 0}%, 2CC=${kpi.dl2cc || 0}%, 3CC=${kpi.dl3cc || 0}%, 4CC=${kpi.dl4cc || 0}%`;
        if (status.ca === 'Active but Ineffective') {
            return `CA is active but ineffective due to poor secondary carrier quality. ${ccInfo}.`;
        }
        if (status.ca === 'Underutilized') {
            if ((kpi.dl1cc || 0) >= 100) {
                return `Carrier Aggregation is underutilized. ${ccInfo}. 
                <div style="margin-top:5px;">
                    <h5 style="color:#fcd34d; font-size:14px; margin-bottom:10px;">🧠 What This Means (Diagnosis)</h5>
                    <p style="color:#ddd; font-size:12px; margin-bottom:10px;">
                        When 1CC = 100% and multi-CC = 0%, it indicates one or more of the following:
                    </p>
                    <ul style="margin:5px 0 15px 15px; color:#ddd;">
                        <li>CA is misconfigured or inactive</li>
                        <li>Inter-frequency mobility is failing</li>
                        <li>UE capability or band combination is not matched</li>
                        <li>Secondary Cell (SCell) addition conditions are not met</li>
                        <li>Radio quality thresholds prevent CA activation</li>
                    </ul>

                    <p style="color:#f87171; font-size:12px; margin-bottom:15px;">
                        <strong>📉 Impact:</strong> Peak/Avg throughput severely limited. Poor spectrum utilization.
                    </p>

                    <h5 style="color:#fcd34d; font-size:14px; margin-bottom:10px; cursor:pointer; user-select:none;" onclick="const el = this.nextElementSibling; el.style.display = el.style.display === 'none' ? 'block' : 'none';">🛠️ Corrective Actions (Prioritized) 🔽</h5>
                    <div style="display:none;">

                    <div style="margin-bottom:15px; border-left:3px solid #ef4444; padding-left:10px;">
                        <strong style="color:#f87171;">🔴 Priority 1 — CA Configuration Verification (Mandatory)</strong><br>
                        <span style="font-size:12px; color:#bbb;">Goal: Ensure CA is technically possible</span>
                        <ul style="margin:5px 0 5px 15px; color:#ddd;">
                            <li>Verify CA is enabled on the eNodeB</li>
                            <li>Confirm PCell–SCell band combinations are correctly configured</li>
                            <li>Check license availability for CA</li>
                            <li>Ensure SCells are not barred or deactivated</li>
                            <li>Validate bandwidth configuration on all carriers</li>
                        </ul>
                        <span style="font-size:12px; color:#86efac;">📌 Most common root cause in the field.</span>
                    </div>

                    <div style="margin-bottom:15px; border-left:3px solid #ef4444; padding-left:10px;">
                        <strong style="color:#f87171;">🔴 Priority 2 — Inter-Frequency & SCell Addition Conditions</strong><br>
                        <span style="font-size:12px; color:#bbb;">Goal: Allow UEs to activate CA</span>
                        <ul style="margin:5px 0 5px 15px; color:#ddd;">
                            <li>Review SCell addition thresholds (RSRP / RSRQ / SINR)</li>
                            <li>Relax overly strict A3 / event-based conditions</li>
                            <li>Check inter-frequency neighbor relations</li>
                            <li>Ensure X2/S1 signaling stability for SCell control</li>
                        </ul>
                        <span style="font-size:12px; color:#86efac;">📌 Overly conservative thresholds silently kill CA.</span>
                    </div>

                    <div style="margin-bottom:15px; border-left:3px solid #f97316; padding-left:10px;">
                        <strong style="color:#fdba74;">🟠 Priority 3 — Radio Quality Alignment Across Carriers</strong><br>
                        <span style="font-size:12px; color:#bbb;">Goal: Make secondary carriers usable</span>
                        <ul style="margin:5px 0 5px 15px; color:#ddd;">
                            <li>Compare RSRP/RSRQ of PCell vs SCells</li>
                            <li>Optimize tilt & power balance between carriers</li>
                            <li>Reduce interference on higher-frequency bands</li>
                            <li>Align coverage footprints across bands</li>
                        </ul>
                        <span style="font-size:12px; color:#86efac;">📌 CA fails if SCells are significantly weaker than PCell.</span>
                    </div>

                    <div style="margin-bottom:15px; border-left:3px solid #f97316; padding-left:10px;">
                        <strong style="color:#fdba74;">🟠 Priority 4 — UE Capability & Traffic Conditions</strong><br>
                        <span style="font-size:12px; color:#bbb;">Goal: Confirm demand and capability exist</span>
                        <ul style="margin:5px 0 5px 15px; color:#ddd;">
                            <li>Analyze UE category distribution</li>
                            <li>Verify supported CA band combinations in the UE base</li>
                            <li>Confirm sufficient DL traffic volume (CA won’t trigger on very low traffic)</li>
                            <li>Validate CA is enabled in UE capability signaling</li>
                        </ul>
                        <span style="font-size:12px; color:#86efac;">📌 CA will not activate for low-category or idle UEs.</span>
                    </div>

                    <div style="margin-bottom:15px; border-left:3px solid #f97316; padding-left:10px;">
                        <strong style="color:#fdba74;">🟠 Priority 5 — Scheduler & Feature Interaction</strong><br>
                        <span style="font-size:12px; color:#bbb;">Goal: Ensure scheduler allows CA usage</span>
                        <ul style="margin:5px 0 5px 15px; color:#ddd;">
                            <li>Verify CA-aware scheduler is enabled</li>
                            <li>Check GBR/QCI impact (real-time traffic can block CA)</li>
                            <li>Ensure load-balancing policies don’t pin UEs to PCell</li>
                            <li>Review feature conflicts (e.g., legacy ICIC settings)</li>
                        </ul>
                    </div>

                    <div style="margin-bottom:15px; border-left:3px solid #eab308; padding-left:10px;">
                        <strong style="color:#fde047;">🟡 Priority 6 — Software, Alarms & Stability</strong><br>
                        <span style="font-size:12px; color:#bbb;">Goal: Detect hidden failures</span>
                        <ul style="margin:5px 0 5px 15px; color:#ddd;">
                            <li>Check CA-related alarms or counters (SCell add/remove failures)</li>
                            <li>Review recent software upgrades or parameter changes</li>
                            <li>Apply recommended vendor patches</li>
                            <li>Monitor SCell addition success rate</li>
                        </ul>
                    </div>
                    </div>
                </div>`;
            }
            return `Carrier Aggregation is underutilized. ${ccInfo}. Possible configuration or traffic demand issue.`;
        }
        return `Carrier Aggregation is effective. ${ccInfo}. Multi-carrier scheduling is performing well.`;
    }

    function explainLinkStability(status, kpi) {
        if (!status.dlLink) return 'Link stability data unavailable.';
        const blerInfo = `BLER: DL=${(kpi.dlBler || 0).toFixed(2)}%, UL=${(kpi.ulBler || 0).toFixed(2)}%`;

        if (status.dlLink === 'Unstable') {
            return `Radio link is unstable due to high BLER. ${blerInfo}. Expect frequent retransmissions.`;
        }

        if (status.dlLink === 'Degraded') {
            const T = window.analysisThresholds;
            const degradedThresh = (T && T.stability && T.stability.bler && T.stability.bler.degraded) ? T.stability.bler.degraded : 10;
            const isUlDegraded = (kpi.ulBler || 0) > degradedThresh;

            let baseMsg = `Radio link quality is degraded. ${blerInfo}. Performance may be inconsistent.`;

            // Display detailed actions ONLY if UL is NOT degraded (i.e. DL-specific issue)
            if (!isUlDegraded) {
                return baseMsg + `<br>
            Corrective actions should prioritize interference mitigation, MCS tuning, and MIMO stability improvements. Monitoring post-optimization is required to confirm BLER normalization.
            
            <div style="margin-top:15px; padding-top:15px; border-top:1px solid #444;">
                <h5 style="color:#fcd34d; font-size:14px; margin-bottom:10px; cursor:pointer; user-select:none;" onclick="const el = this.nextElementSibling; el.style.display = el.style.display === 'none' ? 'block' : 'none';">🛠️ Corrective Actions (Prioritized) 🔽</h5>
                <div style="display:none;">

                <div style="margin-bottom:15px; border-left:3px solid #ef4444; padding-left:10px;">
                    <strong style="color:#f87171;">🔴 Priority 1 — Radio & Interference Stabilization</strong><br>
                    <span style="font-size:12px; color:#bbb;">Goal: Reduce DL retransmissions</span>
                    <ul style="margin:5px 0 5px 15px; color:#ddd;">
                        <li>Optimize antenna tilt and azimuth to reduce interference overlap</li>
                        <li>Review neighbor cell dominance & overshooting</li>
                        <li>Enable or tune ICIC / eICIC</li>
                        <li>Check RSRQ & SINR distributions for interference patterns</li>
                    </ul>
                    <span style="font-size:12px; color:#86efac;">📌 Expected impact: Immediate BLER reduction</span>
                </div>

                <div style="margin-bottom:15px; border-left:3px solid #ef4444; padding-left:10px;">
                    <strong style="color:#f87171;">🔴 Priority 2 — Link Adaptation & MCS Control</strong><br>
                    <span style="font-size:12px; color:#bbb;">Goal: Prevent overly aggressive modulation</span>
                    <ul style="margin:5px 0 5px 15px; color:#ddd;">
                        <li>Increase DL BLER target margin</li>
                        <li>Tune CQI → MCS mapping</li>
                        <li>Limit high-order modulation (64QAM / 256QAM) in poor SINR conditions</li>
                        <li>Enable conservative MCS fallback for unstable links</li>
                    </ul>
                    <span style="font-size:12px; color:#86efac;">📌 Expected impact: Stabilizes throughput, fewer HARQ retries</span>
                </div>

                <div style="margin-bottom:15px; border-left:3px solid #f97316; padding-left:10px;">
                    <strong style="color:#fdba74;">🟠 Priority 3 — MIMO & Spatial Stability</strong><br>
                    <span style="font-size:12px; color:#bbb;">Goal: Improve spatial channel reliability</span>
                    <ul style="margin:5px 0 5px 15px; color:#ddd;">
                        <li>Investigate Rank-1 dominance</li>
                        <li>Inspect antenna cross-polarization</li>
                        <li>Enable / optimize beamforming</li>
                        <li>Verify RRU & antenna health (VSWR, feeder loss)</li>
                    </ul>
                    <span style="font-size:12px; color:#86efac;">📌 Expected impact: Improves DL BLER and throughput simultaneously</span>
                </div>

                <div style="margin-bottom:15px; border-left:3px solid #f97316; padding-left:10px;">
                    <strong style="color:#fdba74;">🟠 Priority 4 — Mobility & Fast Fading Control</strong><br>
                    <span style="font-size:12px; color:#bbb;">Goal: Reduce transient BLER spikes</span>
                    <ul style="margin:5px 0 5px 15px; color:#ddd;">
                        <li>Optimize handover margins & TTT</li>
                        <li>Tune DL outer-loop power control</li>
                        <li>Adjust scheduler behavior for high-speed UEs</li>
                        <li>Enable robust retransmission settings</li>
                    </ul>
                    <span style="font-size:12px; color:#86efac;">📌 Expected impact: Improves user experience for moving users</span>
                </div>

                <div style="margin-bottom:15px; border-left:3px solid #eab308; padding-left:10px;">
                    <strong style="color:#fde047;">🟡 Priority 5 — Scheduler & Resource Handling</strong><br>
                    <span style="font-size:12px; color:#bbb;">Goal: Avoid BLER amplification under load</span>
                    <ul style="margin:5px 0 5px 15px; color:#ddd;">
                        <li>Tune proportional-fair scheduler weights</li>
                        <li>Reduce aggressive scheduling for poor SINR users</li>
                        <li>Balance GBR vs non-GBR traffic</li>
                        <li>Avoid excessive RB assignment during unstable radio</li>
                    </ul>
                    <span style="font-size:12px; color:#86efac;">📌 Expected impact: Reduces wasted RBs due to retransmissions</span>
                </div>

                <div style="margin-bottom:15px; border-left:3px solid #3b82f6; padding-left:10px;">
                    <strong style="color:#93c5fd;">🔵 Priority 6 — Monitoring & Validation</strong><br>
                    <span style="font-size:12px; color:#bbb;">Goal: Confirm improvement and prevent recurrence</span>
                    <ul style="margin:5px 0 5px 15px; color:#ddd;">
                        <li>Track BLER vs CQI vs Rank</li>
                        <li>Correlate BLER with RSRQ / SINR</li>
                        <li>Re-evaluate after peak traffic hours</li>
                        <li>Set BLER alarms (DL > 10%)</li>
                    </ul>
                    <span style="font-size:12px; color:#86efac;">📌 Expected impact: Sustained stability</span>
                </div>
                </div>
            </div>`;
            }
            // Fallback for when UL IS also degraded (or no data)
            // If UL is also degraded, show the specific dual-link degradation message
            if (isUlDegraded) {
                return `The radio link is critically degraded. ${blerInfo}. This indicates unstable channel conditions and potential RF/interference or hardware issues. Immediate actions should focus on RF integrity checks, interference mitigation, and conservative link adaptation tuning. Performance validation is required post-optimization.
                
                <h5 style="color:#fcd34d; font-size:14px; margin-top:15px; margin-bottom:10px;">🧠 What This Situation Means (Diagnosis)</h5>
                <ul style="margin:5px 0 15px 15px; color:#ddd;">
                    <li><b>Poor radio channel stability</b></li>
                    <li>High interference or fast fading</li>
                    <li>Power control and link adaptation issues</li>
                    <li>Possible antenna / RF hardware degradation</li>
                </ul>

                <h5 style="color:#fcd34d; font-size:14px; margin-bottom:10px; cursor:pointer; user-select:none;" onclick="const el = this.nextElementSibling; el.style.display = el.style.display === 'none' ? 'block' : 'none';">🛠️ Corrective Actions (Strict Priority Order) 🔽</h5>
                <div style="display:none;">

                <div style="margin-bottom:15px; border-left:3px solid #ef4444; padding-left:10px;">
                    <strong style="color:#f87171;">🔴 Priority 1 — RF Integrity & Hardware Health (MANDATORY)</strong><br>
                    <span style="font-size:12px; color:#bbb;">Goal: Eliminate physical-layer faults</span>
                    <ul style="margin:5px 0 5px 15px; color:#ddd;">
                        <li>Perform antenna, feeder, and jumper inspection</li>
                        <li>Check VSWR / return loss</li>
                        <li>Verify RRU output power stability</li>
                        <li>Confirm UL receiver sensitivity</li>
                        <li>Inspect MIMO port balance</li>
                    </ul>
                    <span style="font-size:12px; color:#86efac;">📌 Why critical: Hardware issues are the #1 cause when DL and UL BLER are both high.</span>
                </div>

                <div style="margin-bottom:15px; border-left:3px solid #ef4444; padding-left:10px;">
                    <strong style="color:#f87171;">🔴 Priority 2 — Interference & Noise Floor Reduction</strong><br>
                    <span style="font-size:12px; color:#bbb;">Goal: Improve SINR in both directions</span>
                    <ul style="margin:5px 0 5px 15px; color:#ddd;">
                        <li>Optimize antenna tilt & azimuth</li>
                        <li>Identify and mitigate overshooting cells</li>
                        <li>Review neighbor dominance</li>
                        <li>Enable or retune ICIC / eICIC</li>
                        <li>Investigate external interference sources</li>
                    </ul>
                    <span style="font-size:12px; color:#86efac;">📌 Why: UL BLER > 10% almost always implies high noise or interference.</span>
                </div>

                <div style="margin-bottom:15px; border-left:3px solid #ef4444; padding-left:10px;">
                    <strong style="color:#f87171;">🔴 Priority 3 — Link Adaptation & Power Control</strong><br>
                    <span style="font-size:12px; color:#bbb;">Goal: Stabilize transmissions</span>
                    <ul style="margin:5px 0 5px 15px; color:#ddd;">
                        <li>Increase DL & UL BLER target margins</li>
                        <li>Tune CQI → MCS mapping (reduce aggressive MCS)</li>
                        <li>Optimize UL power control parameters</li>
                        <li>Limit high-order modulation under unstable SINR</li>
                    </ul>
                    <span style="font-size:12px; color:#86efac;">📌 Expected effect: Immediate BLER reduction at the cost of slightly lower peak rates (acceptable).</span>
                </div>

                <div style="margin-bottom:15px; border-left:3px solid #f97316; padding-left:10px;">
                    <strong style="color:#fdba74;">🟠 Priority 4 — MIMO & Spatial Stability</strong><br>
                    <span style="font-size:12px; color:#bbb;">Goal: Improve channel robustness</span>
                    <ul style="margin:5px 0 5px 15px; color:#ddd;">
                        <li>Check Rank-1 dominance</li>
                        <li>Optimize MIMO switching thresholds</li>
                        <li>Enable / optimize beamforming</li>
                        <li>Validate antenna cross-polarization isolation</li>
                    </ul>
                    <span style="font-size:12px; color:#86efac;">📌 Why: Unstable spatial channels amplify BLER in both DL & UL.</span>
                </div>

                <div style="margin-bottom:15px; border-left:3px solid #f97316; padding-left:10px;">
                    <strong style="color:#fdba74;">🟠 Priority 5 — Mobility & Fast-Fading Control</strong><br>
                    <span style="font-size:12px; color:#bbb;">Goal: Reduce transient radio failures</span>
                    <ul style="margin:5px 0 5px 15px; color:#ddd;">
                        <li>Optimize handover margins and TTT</li>
                        <li>Reduce ping-pong handovers</li>
                        <li>Tune scheduler for high-speed UEs</li>
                        <li>Enable robust HARQ settings</li>
                    </ul>
                    <span style="font-size:12px; color:#86efac;">📌 Why: Mobility-induced fading impacts DL and UL equally.</span>
                </div>

                <div style="margin-bottom:15px; border-left:3px solid #eab308; padding-left:10px;">
                    <strong style="color:#fde047;">🟡 Priority 6 — Scheduler & Resource Discipline</strong><br>
                    <span style="font-size:12px; color:#bbb;">Goal: Avoid BLER amplification</span>
                    <ul style="margin:5px 0 5px 15px; color:#ddd;">
                        <li>Avoid aggressive RB allocation to poor SINR UEs</li>
                        <li>Tune PF scheduler fairness</li>
                        <li>Reduce retransmission storms</li>
                        <li>Balance GBR vs non-GBR traffic</li>
                    </ul>
                    <span style="font-size:12px; color:#86efac;">📌 Why: Over-scheduling bad radio links worsens BLER.</span>
                </div>

                <div style="margin-bottom:15px; border-left:3px solid #3b82f6; padding-left:10px;">
                    <strong style="color:#93c5fd;">📊 Validation & Monitoring (Required)</strong><br>
                    <span style="font-size:12px; color:#bbb;">Monitor After Actions:</span>
                    <ul style="margin:5px 0 5px 15px; color:#ddd;">
                        <li>DL & UL BLER trends (target < 8%)</li>
                        <li>BLER vs SINR distribution</li>
                        <li>Rank-2+ usage</li>
                        <li>HARQ retransmission rate</li>
                    </ul>
                    <span style="font-size:12px; color:#86efac;">Alarm Recommendation: DL BLER > 10%, UL BLER > 8%</span>
                </div></div>`;
            }

            return baseMsg;
        }
        return `Radio link is stable. ${blerInfo}. Link adaptation is performing optimally.`;
    }

    function getStatusColor(value) {
        if (!value) return '#94a3b8'; // gray
        const low = value.toLowerCase();
        if (
            low.includes('good') ||
            low.includes('acceptable') ||
            low.includes('stable') ||
            low.includes('normal') ||
            low.includes('effective') ||
            low.includes('very low load') ||
            (low.includes('load') && low.includes('low'))
        ) return '#4ade80'; // green

        if (
            low.includes('fair') ||
            low.includes('moderate') ||
            low.includes('moderate load') ||
            low.includes('limited') ||
            low.includes('underutilized') ||
            low === 'degraded'
        ) return '#facc15'; // yellow

        if (
            low.includes('poor') ||
            low.includes('severely') ||
            low.includes('unstable') ||
            low.includes('congested') ||
            low.includes('ineffective')
        ) return '#f87171'; // red

        return '#ddd';
    }

    function renderAnalysisResult(result, container) {
        const { kpi, status, interpretation, diagnosis, actions, confidence } = result;
        const ulLow = kpi.ulLow ?? null;
        const ulExp = ulLow === null ? 'Unknown' : (ulLow >= 20 ? 'Degraded' : 'Good');

        container.innerHTML = `
            <style>
                .analysis-content h3 { color: #fff; margin-bottom: 20px; font-size: 18px; border-bottom: 2px solid #2563eb; padding-bottom: 8px; }
                .analysis-content h4 { color: #60a5fa; margin-top: 20px; margin-bottom: 10px; font-size: 15px; border-bottom: 1px solid #333; padding-bottom: 4px; }
                .analysis-content p { margin: 8px 0; font-size: 13px; line-height: 1.5; color: #ddd; }
                .analysis-content ul { padding-left: 20px; margin: 10px 0; }
                .analysis-content li { margin-bottom: 6px; font-size: 13px; color: #ddd; }
                .analysis-content b { color: #fff; }
                .summary-box { background: rgba(37, 99, 235, 0.1); border-left: 4px solid #2563eb; padding: 15px; border-radius: 4px; margin-top: 25px; }
            </style>

            <h3>📍 LTE Cell Performance Analysis</h3>
            ${result.identity && result.identity.enbName ? `<div style="color:#e5e7eb; font-size:14px; margin-bottom:4px;"><b>eNodeB:</b> ${result.identity.enbName}</div>` : ''}
            ${result.identity && result.identity.enbId ? `<div style="color:#9ca3af; font-size:13px; margin-bottom:15px;"><b>ID:</b> ${result.identity.enbId}</div>` : ''}

            <h4>1️⃣ Data Confidence Assessment</h4>
            <ul>
                <li><b>MR Count:</b> ${kpi.mrCount ?? 'N/A'}</li>
                <li><b>Total Traffic:</b> ${kpi.traffic ?? 'N/A'} MB</li>
                <li><b>Confidence Score:</b> ${confidence}%</li>
            </ul>

            <h4>2️⃣ Coverage Status</h4>
                <p><b>Coverage:</b> <span style="color:${getStatusColor(status.coverage)}">${status.coverage || 'Unknown'}</span></p>
                <p>${explainCoverage(status, kpi)}</p>

            <h4>3️⃣ Signal Quality</h4>
                <p><b>Signal Quality:</b> <span style="color:${getStatusColor(status.signalQuality)}">${status.signalQuality || 'Unknown'}</span></p>
                <p>${explainSignalQuality(status, kpi)}</p>

            <h4>4️⃣ Channel Quality</h4>
                <p><b>CQI Status:</b> <span style="color:${getStatusColor(status.channelQuality)}">${status.channelQuality || 'Unknown'}</span></p>
                <p>${explainCQI(status, kpi)}</p>

            <h4>5️⃣ Downlink User Experience</h4>
                <p><b>DL Experience:</b> <span style="color:${status.dlUserExperience === 'Degraded' ? '#ef4444' : getStatusColor(status.dlUserExperience)}">${status.dlUserExperience || 'Unknown'}</span></p>
                <p>${explainDLUserExperience(status, kpi)}</p>

            <h4>6️⃣ Load & Capacity</h4>
                <p><b>Cell Load:</b> <span style="color:${getStatusColor(status.load)}">${status.load || 'Unknown'}</span></p>
                <p>${explainLoad(status, kpi)}</p>

            <h4>7️⃣ Spectrum Efficiency</h4>
                <p><b>Spectral Efficiency:</b> <span style="color:${status.spectralEfficiency === 'Very Low' ? '#ef4444' : getStatusColor(status.spectralEfficiency)}">${status.spectralEfficiency || 'Unknown'}</span></p>
                <p>${explainSpectralEfficiency(status, kpi)}</p>

            <h4>8️⃣ MIMO Performance</h4>
                <p><b>MIMO Status:</b> <span style="color:${getStatusColor(status.mimo)}">${status.mimo || 'N/A'}</span></p>
                <p>${explainMimo(status, kpi)}</p>

            <h4>9️⃣ Carrier Aggregation</h4>
                <p><b>CA Status:</b> <span style="color:${getStatusColor(status.ca)}">${status.ca || 'N/A'}</span></p>
                <p>${explainCA(status, kpi)}</p>

            <h4>🔟 Link Stability (BLER)</h4>
                <p><b>Link Status:</b> <span style="color:${status.dlLink === 'Degraded' ? '#ef4444' : getStatusColor(status.dlLink)}">${status.dlLink || 'N/A'}</span></p>
                <p>${explainLinkStability(status, kpi)}</p>

            <h4>1️⃣1️⃣ Interpretation (WHY)</h4>
                <ul>
                    ${interpretation.length
                    ? interpretation.map(i => `<li>${i}</li>`).join('')
                    : '<li>No dominant interpretation identified.</li>'}
                </ul>

            <h4>🔍 1️⃣2️⃣ Throughput Degradation Analysis</h4>
                <ul>
                    ${result.throughputRootCauses.length
                    ? result.throughputRootCauses.map(c => `<li>${c}</li>`).join('')
                    : '<li>No dominant throughput degradation factor identified.</li>'}
                </ul>

            <h4>1️⃣3️⃣ Expert Diagnosis (WHAT)</h4>
                <ul>
                    ${diagnosis.length
                    ? diagnosis.map(d => `<li><b>${d}</b></li>`).join('')
                    : '<li>No Specific Root Cause Identified</li>'}
                </ul>

            <h4>🛠️ 1️⃣4️⃣ Optimization Actions</h4>
                <ul>
                    ${actions.length
                    ? actions.map(a => `<li>${a}</li>`).join('')
                    : '<li>Monitor KPI Trend for degradation</li>'}
                </ul>

            <h4>📊 1️⃣5️⃣ Diagnosis Confidence</h4>
                <p>
                    <b>${confidence}%</b> –
                    ${confidence >= 70 ? 'High confidence' :
                    confidence >= 50 ? 'Medium confidence' :
                        'Low confidence'}
                </p>

            <div class="summary-box">
                <h4>🧠 Executive Summary</h4>
                <p>
                    This LTE cell is diagnosed as
                    <b>${diagnosis.length ? diagnosis.join(', ') : 'Normal or Undefined'}</b>,
                    with performance mainly constrained by
                    <b>${status.coverage === 'Poor' ? 'coverage limitations' :
                status.signalQuality === 'Poor' ? 'radio quality degradation' :
                    'capacity factors'}</b>.
                </p>
        `;
    }



    // --- Helper for Sampling SmartCare Layers ---
    // --- Helper for Sampling SmartCare Layers ---
    window.findNearestSmartCarePointAndLog = (targetLat, targetLng) => {
        let bestMatch = null;
        let minDist = 0.005; // approx 500m

        // Helper: safe coordinate access
        const getCoord = (p, keys) => {
            for (const k of keys) {
                if (p[k] !== undefined) return parseFloat(p[k]);
            }
            return null;
        };

        loadedLogs.forEach(log => {
            if (!log.points || log.points.length === 0) return;
            if (log.type === 'excel' && log.name.includes('Rabat')) return;

            log.points.forEach((p, index) => {
                const lat = getCoord(p, ['lat', 'latitude', 'Latitude', 'LAT', 'y', 'y_coord']);
                const lng = getCoord(p, ['lng', 'longitude', 'Longitude', 'LONG', 'x', 'x_coord']);

                if (lat === null || lng === null) return;

                const dLat = lat - targetLat;
                const dLng = lng - targetLng;
                const dist = Math.sqrt(dLat * dLat + dLng * dLng);

                if (dist < minDist) {
                    minDist = dist;
                    bestMatch = { point: p, logId: log.id, index: index, dist: dist, logName: log.name };
                }
            });
        });

        return bestMatch;
    };

    window.findNearestSmartCareAnalysis = (targetLat, targetLng) => {
        const match = window.findNearestSmartCarePointAndLog(targetLat, targetLng);
        if (match) {
            return window.analyzeSmartCarePoint(match.point);
        }
        return null;
    };

    // OLD FUNCTION STUB TO BE REMOVED (kept to match closing brace later if needed, but we handle it by creating new funcs)
    // Actually we are replacing the start of the old function.
    // We need to consume the OLD function body or comment it out?
    // If we just put the new functions here, the rest of the file (lines 4508+) will be syntax error.
    // We MUST replace the whole block.

    // Let's try matching the header and commenting out the rest? No.
    // I will try to match the WHOLE block one last time with looser constraints?
    // No, I'll match the header and replace it with `window.findNearestSmartCareAnalysis = (targetLat, targetLng) => { /* New Code */ }; //` and try to comment out the old body?
    // That's messy.

    // BACKTRACK: I will use `multi_replace_file_content` to replace 4505-4539.
    // I will read it carefully one more time.



    window.analyzePoint = (btn) => {
        try {
            let script = document.getElementById('point-data-stash');
            if (!script && btn) {
                const container = btn.closest('.panel, .card, .modal') || btn.parentNode;
                script = container?.querySelector('#point-data-stash');
            }

            if (!script) {
                alert('Analysis data missing.');
                return;
            }

            const data = JSON.parse(script.textContent);

            // 🔹 ENGINE
            const result = analyzeSmartCarePoint(data);
            console.log('AnalyzePoint Result:', result);

            // 🔹 RENDERER (Dynamic Modal)
            const existingModal = document.querySelector('.analysis-modal-overlay-std');
            if (existingModal) existingModal.remove();

            const modalHtml = `
                <div class="analysis-modal-overlay analysis-modal-overlay-std" style="z-index:10003;" onclick="if(event.target===this && this.dataset.dragging!=='true') this.remove()">
                    <div class="analysis-modal" style="width: 600px; max-width: 90vw; position:fixed; z-index:10004;">
                        <div class="analysis-header" style="background:#2563eb; cursor:grab;">
                            <h3>Cell Performance Analysis</h3>
                            <div style="display:flex; gap:10px;">
                                <button onclick="window.openAnalysisSettings()" style="background:#374151; color:#ccc; border:1px solid #555; padding:4px 8px; border-radius:3px; cursor:pointer; font-size:12px;">⚙ Settings</button>
                                <button class="analysis-close-btn" onclick="this.closest('.analysis-modal-overlay').remove()">×</button>
                            </div>
                        </div>
                        <div id="analysis-output" class="analysis-content" style="padding: 25px; background: #111827; color: #eee;">
                            <!-- Renderer content goes here -->
                        </div>
                    </div>
                </div>
            `;

            const div = document.createElement('div');
            div.innerHTML = modalHtml;
            while (div.firstElementChild) {
                document.body.appendChild(div.firstElementChild);
            }

            const overlay = document.querySelector('.analysis-modal-overlay-std');
            if (overlay) {
                if (typeof window.attachAnalysisDrag === 'function') {
                    window.attachAnalysisDrag(overlay);
                } else {
                    setTimeout(() => window.attachAnalysisDrag && window.attachAnalysisDrag(overlay), 0);
                }
            }

            const output = document.getElementById('analysis-output');
            renderAnalysisResult(result, output);

        } catch (e) {
            console.error('AnalyzePoint error:', e);
            alert('Analysis error: ' + e.message);
        }
    };

    window.dtAnalyzePoint = (btn) => {
        try {
            let script = document.getElementById('point-data-stash');
            if (!script && btn) {
                const container = btn.closest('.panel, .card, .modal') || btn.parentNode;
                script = container?.querySelector('#point-data-stash');
            }

            if (!script) {
                alert('DT analysis data missing.');
                return;
            }

            const d = JSON.parse(script.textContent);

            const norm = (s) => String(s).toLowerCase().replace(/[\s\-_\/]/g, '');
            const getVal = (key) => {
                const target = norm(key);
                for (const k of Object.keys(d)) {
                    if (norm(k) === target) return d[k];
                }
                return undefined;
            };
            const getNum = (key) => {
                const v = getVal(key);
                const n = parseFloat(v);
                return isNaN(n) ? null : n;
            };

            const getDtConfig = () => {
                const defaults = {
                    lang: 'EN',
                    rscp: { good: -75, fair: -85, poor: -95 },
                    ecno: { good: -10, fair: -15, poor: -20 },
                    rssi: { good: -75, fair: -85, poor: -95 },
                    bler: { good: 2, moderate: 10 },
                    pilot: { ecno: -15, delta: 6, count: 3 }
                };
                try {
                    const saved = JSON.parse(localStorage.getItem('dtAnalysisConfig') || '{}');
                    return {
                        ...defaults,
                        ...saved,
                        rscp: { ...defaults.rscp, ...(saved.rscp || {}) },
                        ecno: { ...defaults.ecno, ...(saved.ecno || {}) },
                        rssi: { ...defaults.rssi, ...(saved.rssi || {}) },
                        bler: { ...defaults.bler, ...(saved.bler || {}) },
                        pilot: { ...defaults.pilot, ...(saved.pilot || {}) }
                    };
                } catch {
                    return defaults;
                }
            };
            const saveDtConfig = (cfg) => {
                localStorage.setItem('dtAnalysisConfig', JSON.stringify(cfg));
            };

            const cfg = getDtConfig();

            const i18n = {
                EN: {
                    settings: 'Settings',
                    save: 'Save',
                    cancel: 'Cancel',
                    thresholds: 'Thresholds',
                    language: 'Language',
                    score: 'Score',
                    coverage: 'Coverage',
                    quality: 'Quality',
                    rssi: 'RSSI',
                    activeSet: 'Active Set Size',
                    pilotPollution: 'Pilot Pollution',
                    suspected: 'Suspected',
                    notDetected: 'Not detected',
                    strongestNeighbor: 'Strongest neighbor',
                    neighborsTop: 'Neighbors (Top by RSCP)',
                    neighborsHelp: 'Sorted by strongest RSCP. ΔRSCP shows neighbor power relative to serving (positive = stronger). Use this to spot close-power neighbors that could trigger SHO or indicate pilot pollution.',
                    trends: 'Trends',
                    findings: 'Findings',
                    recommendations: 'Recommendations',
                    summary: 'Summary',
                    noNeighbors: 'No neighbors',
                    noRecommendations: 'No specific recommendations.',
                    rscp: 'RSCP',
                    ecno: 'EcNo',
                    bler: 'BLER',
                    pilot: 'Pilot Pollution',
                    good: 'Good',
                    fair: 'Fair',
                    poor: 'Poor',
                    moderate: 'Moderate',
                    bad: 'Bad'
                },
                FR: {
                    settings: 'Paramètres',
                    save: 'Enregistrer',
                    cancel: 'Annuler',
                    thresholds: 'Seuils',
                    language: 'Langue',
                    score: 'Score',
                    coverage: 'Couverture',
                    quality: 'Qualité',
                    rssi: 'RSSI',
                    activeSet: 'Taille Ensemble Actif',
                    pilotPollution: 'Pollution de pilotes',
                    suspected: 'Suspectée',
                    notDetected: 'Non détectée',
                    strongestNeighbor: 'Voisin le plus fort',
                    neighborsTop: 'Voisins (Top RSCP)',
                    neighborsHelp: "Trié par RSCP le plus fort. ΔRSCP montre la puissance du voisin par rapport au serving (positif = plus fort). Utile pour détecter le SHO ou la pollution de pilotes.",
                    trends: 'Tendances',
                    findings: 'Constats',
                    recommendations: 'Recommandations',
                    summary: 'Résumé',
                    noNeighbors: 'Aucun voisin',
                    noRecommendations: 'Aucune recommandation spécifique.',
                    rscp: 'RSCP',
                    ecno: 'EcNo',
                    bler: 'BLER',
                    pilot: 'Pollution de pilotes',
                    good: 'Bon',
                    fair: 'Moyen',
                    poor: 'Faible',
                    moderate: 'Modéré',
                    bad: 'Mauvais'
                }
            };
            const t = i18n[cfg.lang] || i18n.EN;
            const tr = (key) => t[key] || key;
            const tText = (en, fr) => (cfg.lang === 'FR' ? fr : en);

            const servingRscp = getNum('Serving RSCP') ?? getNum('rscp') ?? getNum('level');
            const servingEcno = getNum('EcNo') ?? getNum('Serving EcNo') ?? getNum('rsrq');
            const rssi = getNum('RSSI');
            const asSize = getNum('Active Set Size') ?? getNum('as_size');
            const cellName = getVal('Cell Name') || getVal('Cell Identifier') || 'Unknown';
            const lat = getNum('lat') ?? getNum('latitude');
            const lng = getNum('lng') ?? getNum('longitude') ?? getNum('lon');
            const timeStr = getVal('Time') || getVal('time') || getVal('timestamp');
            const ueTx = getNum('UE Tx Power');
            const nbTx = getNum('NodeB Tx Power');
            const tpc = getNum('TPC');
            const rrcState = getVal('RRC State');
            const blerDl = getNum('BLER DL') ?? getNum('bler_dl');
            const blerUl = getNum('BLER UL') ?? getNum('bler_ul');

            const interp = [];
            const addInterp = (metric, status, why, action) => {
                interp.push({ metric, status, why, action });
            };
            if (rrcState) {
                if (rrcState === 'CELL_DCH') addInterp('RRC', 'OK', tText('Dedicated channel active.', 'Canal dédié actif.'), tText('No action.', 'Aucune action.'));
                else if (rrcState === 'CELL_FACH') addInterp('RRC', 'Degraded', tText('Common channel (low activity or weak coverage).', 'Canal commun (faible activité ou couverture faible).'), tText('Check coverage and throughput; consider SHO thresholds.', 'Vérifier couverture et débit; ajuster seuils SHO.'));
                else if (rrcState === 'CELL_PCH' || rrcState === 'URA_PCH') addInterp('RRC', 'Idle', tText('Paging state.', 'Etat de pagination.'), tText('No action unless stuck during active session.', 'Aucune action sauf blocage en session active.'));
                else if (rrcState === 'IDLE') addInterp('RRC', 'Idle', tText('No dedicated resources.', 'Pas de ressources dédiées.'), tText('No action unless session expected.', 'Aucune action sauf session attendue.'));
                else addInterp('RRC', 'Info', rrcState, tText('No action.', 'Aucune action.'));
            }
            if (ueTx !== null) {
                if (ueTx > 0) addInterp('UE Tx', 'Degraded', tText('UL power is high (possible UL coverage issue or interference).', 'Puissance UL élevée (couverture UL faible ou interférence).'), tText('Check UL coverage, antenna tilt, and UL interference sources.', 'Vérifier couverture UL, tilt antenne, interférences UL.'));
                else if (ueTx > -10) addInterp('UE Tx', 'Moderate', tText('UL power moderate.', 'Puissance UL modérée.'), tText('Monitor if persistent.', 'Surveiller si persistant.'));
                else addInterp('UE Tx', 'OK', tText('UL power low (good conditions).', 'Puissance UL faible (bonnes conditions).'), tText('No action.', 'Aucune action.'));
            }
            if (nbTx !== null) {
                if (nbTx > 20) addInterp('NodeB Tx', 'Degraded', tText('DL power high (load or coverage dominance).', 'Puissance DL élevée (charge ou dominance couverture).'), tText('Review DL power, tilt/azimuth, and load balancing.', 'Vérifier puissance DL, tilt/azimut et équilibrage de charge.'));
                else if (nbTx > 10) addInterp('NodeB Tx', 'Moderate', tText('DL power moderate.', 'Puissance DL modérée.'), tText('Monitor if persistent.', 'Surveiller si persistant.'));
                else addInterp('NodeB Tx', 'OK', tText('DL power low.', 'Puissance DL faible.'), tText('No action.', 'Aucune action.'));
            }
            if (tpc !== null) {
                if (tpc > 0) addInterp('TPC', 'Degraded', tText('Network is requesting UE to increase power.', 'Le réseau demande d’augmenter la puissance UE.'), tText('Investigate UL path loss and interference.', 'Analyser pertes UL et interférences.'));
                else if (tpc < 0) addInterp('TPC', 'OK', tText('Network requests power reduction.', 'Le réseau demande de réduire la puissance.'), tText('No action.', 'Aucune action.'));
                else addInterp('TPC', 'OK', tText('Neutral TPC.', 'TPC neutre.'), tText('No action.', 'Aucune action.'));
            }
            if (blerDl !== null) {
                if (blerDl > cfg.bler.moderate) addInterp('BLER DL', 'Degraded', tText('High DL errors (quality/interference).', 'Erreurs DL élevées (qualité/interférence).'), tText('Check EcNo, interference, and downlink power.', 'Vérifier EcNo, interférences et puissance DL.'));
                else if (blerDl > cfg.bler.good) addInterp('BLER DL', 'Moderate', tText('Moderate DL errors.', 'Erreurs DL modérées.'), tText('Monitor and correlate with EcNo/RSCP.', 'Surveiller et corréler avec EcNo/RSCP.'));
                else addInterp('BLER DL', 'OK', tText('Low DL errors.', 'Erreurs DL faibles.'), tText('No action.', 'Aucune action.'));
            }
            if (blerUl !== null) {
                if (blerUl > cfg.bler.moderate) addInterp('BLER UL', 'Degraded', tText('High UL errors (UL interference/coverage).', 'Erreurs UL élevées (interférence/couverture UL).'), tText('Check UL coverage and noise; review TPC behavior.', 'Vérifier couverture UL et bruit; revoir TPC.'));
                else if (blerUl > cfg.bler.good) addInterp('BLER UL', 'Moderate', tText('Moderate UL errors.', 'Erreurs UL modérées.'), tText('Monitor and correlate with UE Tx.', 'Surveiller et corréler avec UE Tx.'));
                else addInterp('BLER UL', 'OK', tText('Low UL errors.', 'Erreurs UL faibles.'), tText('No action.', 'Aucune action.'));
            }

            const resolveNeighborName = (sc, freq) => {
                if (!window.resolveSmartSite || sc === null || sc === undefined) return 'Unknown';
                const resolved = window.resolveSmartSite({
                    sc: sc,
                    freq: freq,
                    pci: sc,
                    lat: lat,
                    lng: lng
                });
                if (resolved && resolved.name && resolved.name !== 'Unknown') return resolved.name;
                return 'Unknown';
            };

            const qualityLabel = (ecno) => {
                if (ecno === null) return 'Unknown';
                if (ecno >= cfg.ecno.good) return 'Good';
                if (ecno >= cfg.ecno.fair) return 'Fair';
                if (ecno >= cfg.ecno.poor) return 'Poor';
                return 'Bad';
            };

            const coverageLabel = (rscp) => {
                if (rscp === null) return 'Unknown';
                if (rscp >= cfg.rscp.good) return 'Good';
                if (rscp >= cfg.rscp.fair) return 'Fair';
                if (rscp >= cfg.rscp.poor) return 'Poor';
                return 'Bad';
            };

            const neighbors = [];
            for (let i = 1; i <= 16; i++) {
                const sc = getNum(`M${i} SC`);
                const rscp = getNum(`M${i} RSCP`);
                const ecno = getNum(`M${i} EcNo`);
                const freq = getNum(`M${i} Freq`) ?? getNum('Freq');
                if (sc === null && rscp === null && ecno === null) continue;
                neighbors.push({ type: `M${i}`, sc, rscp, ecno, freq });
            }

            let strongestNeighbor = null;
            neighbors.forEach(n => {
                if (n.rscp === null) return;
                if (!strongestNeighbor || n.rscp > strongestNeighbor.rscp) strongestNeighbor = n;
            });

            // Resolve names for neighbors
            neighbors.forEach(n => {
                n.name = resolveNeighborName(n.sc, n.freq);
            });
            if (strongestNeighbor) strongestNeighbor.name = resolveNeighborName(strongestNeighbor.sc, strongestNeighbor.freq);

            const quality = qualityLabel(servingEcno);
            const coverage = coverageLabel(servingRscp);

            const statusColor = (label) => {
                if (label === 'Good') return '#22c55e';
                if (label === 'Fair' || label === 'Moderate') return '#eab308';
                if (label === 'Poor' || label === 'Bad') return '#ef4444';
                return '#94a3b8';
            };

            const interferenceFlag = (rssi !== null && servingEcno !== null && rssi > cfg.rssi.good && servingEcno < cfg.ecno.fair);
            const asFlag = (asSize !== null && asSize <= 1);
            const strongNeighborCount = neighbors.reduce((acc, n) => {
                if (servingRscp === null || n.rscp === null) return acc;
                return (n.rscp >= (servingRscp - cfg.pilot.delta)) ? acc + 1 : acc;
            }, 0);
            const pilotPollution = (servingEcno !== null && servingEcno < cfg.pilot.ecno) && (strongNeighborCount >= cfg.pilot.count);
            // Overshooting analysis disabled (per user request)

            const scoreFromRscp = (rscp) => {
                if (rscp === null) return 0;
                if (rscp >= cfg.rscp.good) return 90;
                if (rscp >= cfg.rscp.fair) return 70;
                if (rscp >= cfg.rscp.poor) return 50;
                return 30;
            };
            const scoreFromEcno = (ecno) => {
                if (ecno === null) return 0;
                if (ecno >= cfg.ecno.good) return 90;
                if (ecno >= cfg.ecno.fair) return 70;
                if (ecno >= cfg.ecno.poor) return 45;
                return 20;
            };
            const coverageScore = scoreFromRscp(servingRscp);
            const qualityScore = scoreFromEcno(servingEcno);
            const totalScore = Math.round((0.45 * coverageScore) + (0.55 * qualityScore));
            const scoreLabel = totalScore >= 80 ? 'Good' : totalScore >= 60 ? 'Moderate' : totalScore >= 40 ? 'Poor' : 'Bad';

            const rootCauses = [];
            if (coverage === 'Poor' || coverage === 'Bad') rootCauses.push({ label: 'Coverage', color: '#f97316' });
            if (quality === 'Poor' || quality === 'Bad') rootCauses.push({ label: 'Interference', color: '#ef4444' });
            if (pilotPollution) rootCauses.push({ label: 'Pilot Pollution', color: '#dc2626' });
            if (asFlag) rootCauses.push({ label: 'Mobility', color: '#f59e0b' });
            if (!rootCauses.length) rootCauses.push({ label: 'Stable', color: '#22c55e' });

            const header = `3G DT Analysis - ${cellName}`;
            const summary = [
                `${tr('coverage')}: <span style="color:${statusColor(coverage)}; font-weight:700;">${coverage}</span>${servingRscp !== null ? ` (RSCP ${servingRscp.toFixed(1)} dBm)` : ''}`,
                `${tr('quality')}: <span style="color:${statusColor(quality)}; font-weight:700;">${quality}</span>${servingEcno !== null ? ` (EcNo ${servingEcno.toFixed(1)} dB)` : ''}`,
                rssi !== null ? `${tr('rssi')}: ${rssi.toFixed(1)} dBm` : null,
                asSize !== null ? `${tr('activeSet')}: ${asSize}` : null,
                `${tr('pilotPollution')}: <span style="color:${pilotPollution ? '#ef4444' : '#22c55e'}; font-weight:700;">${pilotPollution ? tr('suspected') : tr('notDetected')}</span>`
            ].filter(Boolean);

            const findings = [];
            const addFinding = (text, confidence = 0.6) => {
                findings.push({ text, confidence });
            };

            if (quality === 'Poor' || quality === 'Bad') {
                addFinding(
                    tText(
                        `EcNo is ${servingEcno?.toFixed(1)} dB (threshold: < -15 dB) which indicates interference or load.`,
                        `EcNo = ${servingEcno?.toFixed(1)} dB (seuil: < -15 dB) indiquant interférence ou charge.`
                    ),
                    servingEcno !== null && servingEcno < -18 ? 0.85 : 0.7
                );
            } else if (quality === 'Fair') {
                addFinding(
                    tText(
                        `EcNo is ${servingEcno?.toFixed(1)} dB (borderline range -15 to -10 dB).`,
                        `EcNo = ${servingEcno?.toFixed(1)} dB (limite -15 à -10 dB).`
                    ),
                    0.55
                );
            }

            if (coverage === 'Poor' || coverage === 'Bad') {
                addFinding(
                    tText(
                        `RSCP is ${servingRscp?.toFixed(1)} dBm (threshold: < -95 dBm) which suggests weak coverage or edge.`,
                        `RSCP = ${servingRscp?.toFixed(1)} dBm (seuil: < -95 dBm) indiquant couverture faible/bord de cellule.`
                    ),
                    servingRscp !== null && servingRscp < -100 ? 0.85 : 0.7
                );
            } else if (coverage === 'Fair') {
                addFinding(
                    tText(
                        `RSCP is ${servingRscp?.toFixed(1)} dBm (borderline range -85 to -75 dBm).`,
                        `RSCP = ${servingRscp?.toFixed(1)} dBm (limite -85 à -75 dBm).`
                    ),
                    0.55
                );
            }

            if (interferenceFlag) {
                addFinding(
                    tText(
                        `RSSI is ${rssi?.toFixed(1)} dBm with EcNo ${servingEcno?.toFixed(1)} dB (high RSSI + low EcNo). This suggests interference/pilot overlap.`,
                        `RSSI = ${rssi?.toFixed(1)} dBm avec EcNo ${servingEcno?.toFixed(1)} dB (RSSI élevé + EcNo faible). Suggestion d’interférences/chevauchement de pilotes.`
                    ),
                    0.8
                );
            }

            if (pilotPollution) {
                addFinding(
                    tText(
                        `Pilot pollution suspected: ${strongNeighborCount} neighbors within 6 dB of serving (RSCP ${servingRscp?.toFixed(1)} dBm) and EcNo < -15 dB.`,
                        `Pollution de pilotes suspectée : ${strongNeighborCount} voisins à 6 dB du serving (RSCP ${servingRscp?.toFixed(1)} dBm) et EcNo < -15 dB.`
                    ),
                    0.85
                );
            }

            if (asFlag) {
                addFinding(
                    tText(
                        `Active Set Size is ${asSize} (<= 1), indicating no soft handover support.`,
                        `Taille de l’ensemble actif = ${asSize} (<= 1), indiquant absence de soft handover.`
                    ),
                    0.7
                );
            }

            if (strongestNeighbor && servingRscp !== null && strongestNeighbor.rscp !== null) {
                const delta = strongestNeighbor.rscp - servingRscp;
                addFinding(
                    tText(
                        `Strongest neighbor ${strongestNeighbor.type} is ${delta.toFixed(1)} dB relative to serving (SC ${strongestNeighbor.sc}).`,
                        `Le voisin le plus fort ${strongestNeighbor.type} est à ${delta.toFixed(1)} dB du serving (SC ${strongestNeighbor.sc}).`
                    ),
                    Math.abs(delta) <= 3 ? 0.75 : 0.55
                );
                if (delta >= -3) {
                    addFinding(
                        tText(
                            `Neighbor ${strongestNeighbor.type} is close in power (<= 3 dB). SHO/add thresholds should be validated.`,
                            `Le voisin ${strongestNeighbor.type} est proche en puissance (<= 3 dB). Vérifier les seuils SHO/ajout.`
                        ),
                        0.7
                    );
                }
            }

            if (asFlag && strongNeighborCount >= 1) {
                addFinding(
                    tText(
                        `Mobility risk: strong neighbors detected but AS size stays at ${asSize}. Check neighbor list and SHO parameters.`,
                        `Risque mobilité : voisins forts détectés mais AS reste à ${asSize}. Vérifier liste voisins et paramètres SHO.`
                    ),
                    0.7
                );
            }

            const neighborText = strongestNeighbor
                ? `${tr('strongestNeighbor')}: ${strongestNeighbor.name || 'Unknown'} ${strongestNeighbor.type} (SC ${strongestNeighbor.sc ?? '-'} / RSCP ${strongestNeighbor.rscp?.toFixed(1) ?? '-'} / EcNo ${strongestNeighbor.ecno?.toFixed(1) ?? '-'})`
                : tr('noNeighbors');

            const recommendations = [];
            const addRec = (text, priority = 'P2') => {
                recommendations.push({ text, priority });
            };

            if (pilotPollution) {
                addRec(tText('Pilot pollution suspected: audit PSC reuse and rebalance pilot power between dominant cells.',
                    'Pollution de pilotes suspectée : auditer la réutilisation PSC et rééquilibrer la puissance pilote.'), 'P1');
                addRec(tText('Consider antenna downtilt or azimuth adjustment to reduce overlapping strong pilots.',
                    'Considérer un downtilt/azimut pour réduire le chevauchement des pilotes.'), 'P2');
            }
            if (interferenceFlag) {
                addRec(tText('Investigate high RSSI with poor EcNo: check interference sources, high load, or external noise.',
                    'RSSI élevé et EcNo faible : vérifier interférences, charge, ou bruit externe.'), 'P1');
            }
            if (quality === 'Poor' || quality === 'Bad') {
                addRec(tText('Improve quality: verify neighbor definitions, optimize handover thresholds (A3/A2), and review CPICH power.',
                    'Améliorer la qualité : vérifier voisins, ajuster seuils A3/A2, et puissance CPICH.'), 'P2');
                addRec(tText('Check PSC planning to avoid confusion with nearby dominant cells.',
                    'Vérifier le plan PSC pour éviter confusion avec cellules dominantes.'), 'P2');
            }
            if (coverage === 'Poor' || coverage === 'Bad') {
                addRec(tText('Improve coverage: review antenna tilt/height, consider sector split or small cell for edge areas.',
                    'Améliorer couverture : vérifier tilt/hauteur, envisager split secteur ou small cell.'), 'P2');
            }
            if (asFlag) {
                addRec(tText('AS size is low: validate active/monitored set thresholds and ensure neighbors are properly configured.',
                    "AS faible : valider seuils active/monitored et config voisins."), 'P2');
            }
            if (strongestNeighbor && servingRscp !== null && strongestNeighbor.rscp !== null) {
                const delta = (strongestNeighbor.rscp - servingRscp).toFixed(1);
                addRec(tText(`Neighbor delta is ${delta} dB: if within 3 dB, consider earlier add-to-AS to stabilize mobility.`,
                    `Delta voisin ${delta} dB : si < 3 dB, ajouter plus tôt à l’AS.`), 'P3');
            }

            const summaryText = (() => {
                const parts = [];
                const servingName = cellName || 'Unknown';
                parts.push(`${tr('score')}: ${scoreLabel} (${totalScore}).`);
                parts.push(`${tr('coverage')} ${coverage}, ${tr('quality')} ${quality}.`);
                if (pilotPollution) parts.push(`${tr('pilotPollution')} ${tr('suspected').toLowerCase()}.`);
                if (interferenceFlag) parts.push(tText('Interference signs present.', "Signes d'interférences présents."));
                if (asFlag) parts.push(`${tr('activeSet')} low.`);
                if (strongestNeighbor && servingRscp !== null && strongestNeighbor.rscp !== null) {
                    const delta = (strongestNeighbor.rscp - servingRscp).toFixed(1);
                    const snName = strongestNeighbor.name || 'Unknown';
                    parts.push(`${tr('strongestNeighbor')}: ${snName} ${strongestNeighbor.type} (ΔRSCP ${delta} dB).`);
                }
                return parts.join(' ');
            })();
            if (quality === 'Good' && coverage === 'Good' && !pilotPollution) {
                addRec(tText('No immediate action required. Monitor trends for consistency.',
                    'Aucune action immédiate. Surveiller les tendances.'), 'P4');
            }

            // Build neighbor table
            const neighborRows = neighbors
                .slice()
                .sort((a, b) => {
                    const ra = parseFloat(a.rscp);
                    const rb = parseFloat(b.rscp);
                    if (isNaN(ra) && isNaN(rb)) return 0;
                    if (isNaN(ra)) return 1;
                    if (isNaN(rb)) return -1;
                    return rb - ra;
                })
                .slice(0, 8)
                .map(n => {
                    const delta = (servingRscp !== null && n.rscp !== null) ? (n.rscp - servingRscp).toFixed(1) : '-';
                    return `<tr>
                        <td>${n.type}</td>
                        <td>${n.name || 'Unknown'}</td>
                        <td>${n.sc ?? '-'}</td>
                        <td>${n.rscp ?? '-'}</td>
                        <td>${n.ecno ?? '-'}</td>
                        <td>${delta}</td>
                    </tr>`;
                }).join('');

            // Time-series context (sparkline) using nearest log point
            const findNearestLogPoint = () => {
                if (!window.loadedLogs || lat === null || lng === null) return null;
                const preferred = window.mapRenderer && window.mapRenderer.activeLogId
                    ? window.loadedLogs.find(l => l.id === window.mapRenderer.activeLogId)
                    : null;
                const logs = preferred ? [preferred, ...window.loadedLogs.filter(l => l !== preferred)] : window.loadedLogs;
                let best = null;
                logs.forEach(log => {
                    if (!log || !log.points || log.type === 'excel' || log.type === 'shp') return;
                    log.points.forEach((p, idx) => {
                        if (p.lat === undefined || p.lng === undefined) return;
                        let dist = Math.hypot(p.lat - lat, p.lng - lng);
                        if (timeStr && p.time && p.time === timeStr) dist *= 0.1;
                        if (!best || dist < best.dist) best = { log, point: p, index: idx, dist };
                    });
                });
                return best;
            };

            const pickSeries = (pts, key) => {
                return pts.map(p => {
                    if (key === 'rscp') return (p.level ?? p.rscp ?? (p.parsed && p.parsed.serving ? p.parsed.serving.rscp : null));
                    if (key === 'ecno') return (p.ecno ?? (p.parsed && p.parsed.serving ? p.parsed.serving.ecno : null));
                    return null;
                });
            };

            const buildSparkline = (values, color) => {
                const v = values.filter(x => x !== null && !isNaN(x));
                if (v.length === 0) return '<div style="color:#94a3b8; font-size:12px;">No chart data</div>';
                const w = 240, h = 60, pad = 6;
                const min = Math.min(...v);
                const max = Math.max(...v);
                const span = max - min || 1;
                const pts = values.map((val, i) => {
                    if (val === null || isNaN(val)) return null;
                    const x = pad + (i / (values.length - 1)) * (w - pad * 2);
                    const y = h - pad - ((val - min) / span) * (h - pad * 2);
                    return `${x},${y}`;
                }).filter(Boolean).join(' ');
                return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
                    <polyline fill="none" stroke="${color}" stroke-width="2" points="${pts}" />
                </svg>`;
            };

            let chartHtml = `<div style="color:#94a3b8; font-size:12px;">${tText('No chart data', 'Aucune donnée graphique')}</div>`;
            const nearest = findNearestLogPoint();
            if (nearest) {
                const start = Math.max(0, nearest.index - 25);
                const end = Math.min(nearest.log.points.length, nearest.index + 25);
                const slice = nearest.log.points.slice(start, end);
                const rscpSeries = pickSeries(slice, 'rscp');
                const ecnoSeries = pickSeries(slice, 'ecno');
                const rscpVals = rscpSeries.filter(v => v !== null && !isNaN(v));
                const ecnoVals = ecnoSeries.filter(v => v !== null && !isNaN(v));
                const rscpAvg = rscpVals.length ? (rscpVals.reduce((a,b)=>a+b,0) / rscpVals.length) : null;
                const ecnoAvg = ecnoVals.length ? (ecnoVals.reduce((a,b)=>a+b,0) / ecnoVals.length) : null;
                const rscpMin = rscpVals.length ? Math.min(...rscpVals) : null;
                const rscpMax = rscpVals.length ? Math.max(...rscpVals) : null;
                const ecnoMin = ecnoVals.length ? Math.min(...ecnoVals) : null;
                const ecnoMax = ecnoVals.length ? Math.max(...ecnoVals) : null;
                const rscpTrend = (rscpVals.length >= 2 && rscpVals[0] !== null && rscpVals[rscpVals.length - 1] !== null)
                    ? (rscpVals[rscpVals.length - 1] - rscpVals[0])
                    : null;
                const ecnoTrend = (ecnoVals.length >= 2 && ecnoVals[0] !== null && ecnoVals[ecnoVals.length - 1] !== null)
                    ? (ecnoVals[ecnoVals.length - 1] - ecnoVals[0])
                    : null;

                const trendLabel = (t) => {
                    if (t === null) return 'stable';
                    if (t > 3) return 'improving';
                    if (t < -3) return 'degrading';
                    return 'stable';
                };

                const interpret = [];
                if (rscpAvg !== null && rscpAvg < -95) interpret.push(tText('Coverage is weak across the window.', 'Couverture faible sur la fenêtre.'));
                if (ecnoAvg !== null && ecnoAvg < -15) interpret.push(tText('Quality is poor across the window (interference/load).', 'Qualité faible sur la fenêtre (interférences/charge).'));
                if (trendLabel(rscpTrend) === 'degrading') interpret.push(tText('RSCP trend is degrading (coverage worsening).', 'Tendance RSCP en baisse (couverture se dégrade).'));
                if (trendLabel(ecnoTrend) === 'degrading') interpret.push(tText('EcNo trend is degrading (quality worsening).', 'Tendance EcNo en baisse (qualité se dégrade).'));
                if (!interpret.length) interpret.push(tText('Trends look stable around the point.', 'Tendances stables autour du point.'));

                chartHtml = `
                    <div style="display:flex; gap:12px; flex-wrap:wrap;">
                        <div>
                            <div style="font-size:11px; color:#94a3b8; margin-bottom:4px;">RSCP (nearby)</div>
                            ${buildSparkline(rscpSeries, '#22c55e')}
                            <div style="font-size:11px; color:#94a3b8; margin-top:4px;">
                                Avg: ${rscpAvg !== null ? rscpAvg.toFixed(1) : '-'} dBm, 
                                Min/Max: ${rscpMin !== null ? rscpMin.toFixed(1) : '-'} / ${rscpMax !== null ? rscpMax.toFixed(1) : '-'},
                                Trend: <b>${trendLabel(rscpTrend)}</b>
                            </div>
                        </div>
                        <div>
                            <div style="font-size:11px; color:#94a3b8; margin-bottom:4px;">EcNo (nearby)</div>
                            ${buildSparkline(ecnoSeries, '#38bdf8')}
                            <div style="font-size:11px; color:#94a3b8; margin-top:4px;">
                                Avg: ${ecnoAvg !== null ? ecnoAvg.toFixed(1) : '-'} dB, 
                                Min/Max: ${ecnoMin !== null ? ecnoMin.toFixed(1) : '-'} / ${ecnoMax !== null ? ecnoMax.toFixed(1) : '-'},
                                Trend: <b>${trendLabel(ecnoTrend)}</b>
                            </div>
                        </div>
                    </div>
                    <div style="margin-top:6px; font-size:11px; color:#94a3b8;">
                        RSCP = coverage strength, EcNo = quality. Higher (less negative) is better.
                    </div>
                    <div style="margin-top:6px; font-size:11px; color:#e2e8f0;">
                        <div><b>Quick rules</b></div>
                        <div>• Good coverage, bad quality → interference or pilot overlap.</div>
                        <div>• Bad coverage + bad quality → edge coverage or obstruction.</div>
                        <div>• RSCP stable but EcNo drops → interference or load.</div>
                        <div>• Both drop → coverage loss (distance/obstruction).</div>
                    </div>
                    <div style="margin-top:6px; font-size:11px; color:#e2e8f0;">
                        ${tText('Interpretation', 'Interprétation')}: ${interpret.join(' ')}
                    </div>
                    <div style="margin-top:6px; font-size:11px; color:#64748b;">
                        ${tText('These mini charts show ~50 samples around the nearest log point (by position/time). Use them to spot local coverage/quality swings and whether the trend is improving or degrading.',
                        'Ces mini-graphes montrent ~50 échantillons autour du point le plus proche (position/temps). Utilisez-les pour repérer les variations locales de couverture/qualité et la tendance (amélioration/dégradation).')}
                    </div>
                `;
            }

            const existingModal = document.querySelector('.dt-analysis-modal-overlay');
            if (existingModal) existingModal.remove();

            const modalHtml = `
                <div class="analysis-modal-overlay dt-analysis-modal-overlay" style="z-index:10003;" onclick="if(event.target===this && this.dataset.dragging!=='true') this.remove()">
                    <div class="analysis-modal" style="width: 640px; max-width: 92vw; position:fixed; z-index:10004;">
                        <div class="analysis-header" style="background:#0ea5e9; cursor:grab;">
                            <h3>${header}</h3>
                            <div style="display:flex; gap:8px; align-items:center;">
                                <button class="analysis-close-btn" onclick="window.openDtSettings()">⚙ ${t.settings}</button>
                                <button class="analysis-close-btn" onclick="this.closest('.analysis-modal-overlay').remove()">×</button>
                            </div>
                        </div>
                        <div class="analysis-content" style="padding: 20px; background: #0b1220; color: #e5e7eb;">
                            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
                                <div style="font-size:12px; color:#94a3b8;">${tr('score')}</div>
                                <div style="font-size:18px; font-weight:700; color:${statusColor(scoreLabel)};">${totalScore} (${scoreLabel})</div>
                            </div>
                            <div style="display:flex; gap:6px; flex-wrap:wrap; margin-bottom:10px;">
                                ${rootCauses.map(t => `<span style="background:${t.color}; color:#fff; padding:2px 6px; border-radius:10px; font-size:11px;">${t.label}</span>`).join('')}
                            </div>
                            <div style="font-size:13px; margin-bottom:10px;">
                                ${summary.map(s => `<div>${s}</div>`).join('')}
                            </div>
                            <div style="margin-top:8px; font-size:12px; color:#94a3b8;">
                                ${rrcState ? `RRC State: <b style="color:#e2e8f0;">${rrcState}</b>` : ''}
                                ${ueTx !== null ? ` | UE Tx: <b style="color:#e2e8f0;">${ueTx.toFixed(1)}</b>` : ''}
                                ${nbTx !== null ? ` | NodeB Tx: <b style="color:#e2e8f0;">${nbTx.toFixed(1)}</b>` : ''}
                                ${tpc !== null ? ` | TPC: <b style="color:#e2e8f0;">${tpc}</b>` : ''}
                                ${blerDl !== null ? ` | BLER DL: <b style="color:#e2e8f0;">${blerDl}</b>` : ''}
                                ${blerUl !== null ? ` | BLER UL: <b style="color:#e2e8f0;">${blerUl}</b>` : ''}
                            </div>
                            ${interp.length ? `<div style="margin-top:6px; font-size:11px; color:#cbd5f5;">
                                ${interp.map(t => {
                                    const statusColor = t.status === 'OK' ? '#22c55e' : (t.status === 'Moderate' ? '#eab308' : '#ef4444');
                                    const statusLabel = t.status === 'Degraded' ? 'NOK' : t.status;
                                    return `• <b>${t.metric}</b> <span style="color:${statusColor}; font-weight:700;">(${statusLabel})</span> — ${t.why} <span style="color:#94a3b8;">Action: ${t.action}</span>`;
                                }).join('<br>')}
                            </div>` : ''}
                            <div style="margin:10px 0; color:#cbd5f5;">${neighborText}</div>
                            <div style="margin-top:10px;">
                                <div style="font-size:12px; color:#94a3b8; margin-bottom:6px; text-transform:uppercase; letter-spacing:0.6px;">${tr('neighborsTop')}</div>
                                <div style="font-size:11px; color:#64748b; margin-bottom:6px;">
                                    ${tr('neighborsHelp')}
                                </div>
                                <table style="width:100%; border-collapse:collapse; font-size:11px;">
                                    <thead>
                                        <tr style="color:#94a3b8; text-align:left;">
                                            <th>Type</th><th>Name</th><th>SC</th><th>RSCP</th><th>EcNo</th><th>ΔRSCP</th>
                                        </tr>
                                    </thead>
                                    <tbody>${neighborRows || `<tr><td colspan="6">${tr('noNeighbors')}</td></tr>`}</tbody>
                                </table>
                            </div>
                            <div style="margin-top:12px;">
                                <div style="font-size:12px; color:#94a3b8; margin-bottom:6px; text-transform:uppercase; letter-spacing:0.6px;">${tr('trends')}</div>
                                ${chartHtml}
                            </div>
                            <div style="margin-top:10px;">
                                <div style="font-size:12px; color:#38bdf8; margin-bottom:6px; text-transform:uppercase; letter-spacing:0.6px;">${tr('findings')}</div>
                                ${findings.length ? findings.map(f => {
                                    return `<div style="margin-bottom:6px; font-size:12px; color:#e5e7eb;">• ${f.text}</div>`;
                                }).join('') : `<div style="font-size:12px; color:#e5e7eb;">${tText('No major issues detected for this point.', 'Aucun problème majeur détecté pour ce point.')}</div>`}
                            </div>
                            <div style="margin-top:12px;">
                                <div style="font-size:12px; color:#38bdf8; margin-bottom:6px; text-transform:uppercase; letter-spacing:0.6px;">${tr('recommendations')}</div>
                                ${recommendations.length ? recommendations.map(r => {
                                    const priColor = r.priority === 'P1' ? '#ef4444' : (r.priority === 'P2' ? '#f97316' : (r.priority === 'P3' ? '#eab308' : '#94a3b8'));
                                    return `<div style="margin-bottom:6px; font-size:12px; color:#e5e7eb;">• <span style="color:${priColor}; font-weight:700;">[${r.priority}]</span> ${r.text}</div>`;
                                }).join('') : `<div style="font-size:12px; color:#e5e7eb;">${tr('noRecommendations')}</div>`}
                            </div>
                            <div style="margin-top:12px; padding-top:10px; border-top:1px solid #1f2937;">
                                <div style="font-size:12px; color:#38bdf8; margin-bottom:6px; text-transform:uppercase; letter-spacing:0.6px;">${tr('summary')}</div>
                                <div style="font-size:12px; color:#e5e7eb;">${summaryText}</div>
                            </div>
                        </div>
                    </div>
                </div>
                <div id="dt-settings-modal" style="position:fixed; inset:0; background:rgba(0,0,0,0.6); display:none; align-items:center; justify-content:center; z-index:10005;">
                    <div style="background:#111827; color:#e5e7eb; padding:16px; border-radius:8px; width:560px; max-width:92vw;">
                        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
                            <div style="font-weight:700;">${t.settings}</div>
                            <button style="background:#1f2937; color:#fff; border:none; padding:4px 8px; cursor:pointer;" onclick="window.closeDtSettings()">×</button>
                        </div>
                        <div style="margin-bottom:10px;">
                            <label style="font-size:12px; color:#94a3b8;">${t.language}</label>
                            <select id="dt-lang" style="width:100%; padding:6px; margin-top:4px; background:#0b1220; color:#e5e7eb; border:1px solid #334155;">
                                <option value="EN" ${cfg.lang === 'EN' ? 'selected' : ''}>EN</option>
                                <option value="FR" ${cfg.lang === 'FR' ? 'selected' : ''}>FR</option>
                            </select>
                        </div>
                        <div style="font-size:12px; color:#94a3b8; margin-bottom:6px;">${t.thresholds}</div>
                        <div style="display:grid; grid-template-columns: repeat(3, 1fr); gap:8px;">
                            <div>
                                <div style="font-size:11px;">${t.rscp} (${t.good}/${t.fair}/${t.poor})</div>
                                <input id="dt-rscp-good" value="${cfg.rscp.good}" style="width:100%; margin-top:4px;" />
                                <input id="dt-rscp-fair" value="${cfg.rscp.fair}" style="width:100%; margin-top:4px;" />
                                <input id="dt-rscp-poor" value="${cfg.rscp.poor}" style="width:100%; margin-top:4px;" />
                            </div>
                            <div>
                                <div style="font-size:11px;">${t.ecno} (${t.good}/${t.fair}/${t.poor})</div>
                                <input id="dt-ecno-good" value="${cfg.ecno.good}" style="width:100%; margin-top:4px;" />
                                <input id="dt-ecno-fair" value="${cfg.ecno.fair}" style="width:100%; margin-top:4px;" />
                                <input id="dt-ecno-poor" value="${cfg.ecno.poor}" style="width:100%; margin-top:4px;" />
                            </div>
                            <div>
                                <div style="font-size:11px;">${t.rssi} (${t.good}/${t.fair}/${t.poor})</div>
                                <input id="dt-rssi-good" value="${cfg.rssi.good}" style="width:100%; margin-top:4px;" />
                                <input id="dt-rssi-fair" value="${cfg.rssi.fair}" style="width:100%; margin-top:4px;" />
                                <input id="dt-rssi-poor" value="${cfg.rssi.poor}" style="width:100%; margin-top:4px;" />
                            </div>
                            <div>
                                <div style="font-size:11px;">${t.bler} (${t.good}/${t.moderate})</div>
                                <input id="dt-bler-good" value="${cfg.bler.good}" style="width:100%; margin-top:4px;" />
                                <input id="dt-bler-mod" value="${cfg.bler.moderate}" style="width:100%; margin-top:4px;" />
                            </div>
                            <div>
                                <div style="font-size:11px;">${t.pilot} (EcNo, ΔRSCP, Count)</div>
                                <input id="dt-pilot-ecno" value="${cfg.pilot.ecno}" style="width:100%; margin-top:4px;" />
                                <input id="dt-pilot-delta" value="${cfg.pilot.delta}" style="width:100%; margin-top:4px;" />
                                <input id="dt-pilot-count" value="${cfg.pilot.count}" style="width:100%; margin-top:4px;" />
                            </div>
                        </div>
                        <div style="display:flex; gap:8px; justify-content:flex-end; margin-top:12px;">
                            <button id="dt-settings-cancel" style="background:#374151; color:#e5e7eb; border:none; padding:6px 10px; cursor:pointer;">${t.cancel}</button>
                            <button id="dt-settings-save" style="background:#0ea5e9; color:#fff; border:none; padding:6px 10px; cursor:pointer;">${t.save}</button>
                        </div>
                    </div>
                </div>
            `;

            const div = document.createElement('div');
            div.innerHTML = modalHtml;
            while (div.firstElementChild) {
                document.body.appendChild(div.firstElementChild);
            }

            const overlay = document.querySelector('.dt-analysis-modal-overlay');
            if (overlay) {
                // Attach drag after layout
                setTimeout(() => window.attachAnalysisDrag(overlay), 0);
            }

            window.openDtSettings = () => {
                const el = document.getElementById('dt-settings-modal');
                if (el) el.style.display = 'flex';
            };
            window.closeDtSettings = () => {
                const el = document.getElementById('dt-settings-modal');
                if (el) el.style.display = 'none';
            };

            const settingsModal = document.getElementById('dt-settings-modal');
            const cancelBtn = document.getElementById('dt-settings-cancel');
            const saveBtn = document.getElementById('dt-settings-save');
            if (cancelBtn) cancelBtn.onclick = () => settingsModal.style.display = 'none';
            if (saveBtn) {
                saveBtn.onclick = () => {
                    const nextCfg = {
                        lang: document.getElementById('dt-lang').value,
                        rscp: {
                            good: parseFloat(document.getElementById('dt-rscp-good').value),
                            fair: parseFloat(document.getElementById('dt-rscp-fair').value),
                            poor: parseFloat(document.getElementById('dt-rscp-poor').value)
                        },
                        ecno: {
                            good: parseFloat(document.getElementById('dt-ecno-good').value),
                            fair: parseFloat(document.getElementById('dt-ecno-fair').value),
                            poor: parseFloat(document.getElementById('dt-ecno-poor').value)
                        },
                        rssi: {
                            good: parseFloat(document.getElementById('dt-rssi-good').value),
                            fair: parseFloat(document.getElementById('dt-rssi-fair').value),
                            poor: parseFloat(document.getElementById('dt-rssi-poor').value)
                        },
                        bler: {
                            good: parseFloat(document.getElementById('dt-bler-good').value),
                            moderate: parseFloat(document.getElementById('dt-bler-mod').value)
                        },
                        pilot: {
                            ecno: parseFloat(document.getElementById('dt-pilot-ecno').value),
                            delta: parseFloat(document.getElementById('dt-pilot-delta').value),
                            count: parseInt(document.getElementById('dt-pilot-count').value, 10)
                        }
                    };
                    saveDtConfig(nextCfg);
                    settingsModal.style.display = 'none';
                    // Re-run DT analysis with updated thresholds/language
                    window.dtAnalyzePoint(btn);
                };
            }

        } catch (e) {
            console.error('DT Analysis error:', e);
            alert('DT Analysis error: ' + e.message);
        }
    };


    
    // Global function to update the Floating Info Panel (Single Point)
    window.updateFloatingInfoPanel = (p, logColor, contextLog) => {
        try {
            const panel = document.getElementById('floatingInfoPanel');
            const content = document.getElementById('infoPanelContent');
            const headerDom = document.getElementById('infoPanelHeader'); // GET HEADER

            if (!panel || !content) return;
            window.__activePointLog = getOwningLogForPoint(p, contextLog || window.__activePointLog);

            if (panel.style.display !== 'block') panel.style.display = 'block';

            // 1. Set Stash for Toggle Re-render compatibility (Treat single as one-item array)
            // This ensures window.togglePointDetailsMode() works because it calls updateFloatingInfoPanelMulti(lastMultiHits)
            window.lastMultiHits = [p];

            // 2. Inject Toggle Button if missing
            let toggleBtn = document.getElementById('toggleViewBtn');
            if (headerDom && !toggleBtn) {
                const closeBtn = headerDom.querySelector('.info-panel-close');
                toggleBtn = document.createElement('span');
                toggleBtn.id = 'toggleViewBtn';
                toggleBtn.className = 'toggle-view-btn';
                toggleBtn.innerHTML = '⚙️ View';
                toggleBtn.title = 'Switch View Mode';
                toggleBtn.onclick = (e) => { e.stopPropagation(); window.togglePointDetailsMode(); };
                toggleBtn.style.marginRight = '10px';
                toggleBtn.style.fontSize = '12px';
                toggleBtn.style.cursor = 'pointer';
                toggleBtn.style.color = '#ccc';

                if (closeBtn) headerDom.insertBefore(toggleBtn, closeBtn);
                else headerDom.appendChild(toggleBtn);
            }

            // 3. Select Generator based on Mode
            const mode = window.pointDetailsMode || 'log'; // Default to log if undefined
            const generator = mode === 'log' ? generatePointInfoHTMLLog : generatePointInfoHTML;

            // 4. Generate
            // Note: generatePointInfoHTMLLog takes (p, logColor)
            // Note: generatePointInfoHTML takes (p, logColor) - now updated to use it
            const { html, connectionTargets } = generator(p, logColor);

            content.innerHTML = html;

            // Update Connections (always for point details, independent from spider mode)
            if (window.mapRenderer) {
                let startPt = { lat: p.lat, lng: p.lng };
                window.mapRenderer.drawConnections(startPt, connectionTargets);
            }
        } catch (e) {
            console.error("Error updating Info Panel:", e);
        }
    };

    // NEW: Multi-Layer Info Panel
    // --- NEW: Toggle Logic ---
    window.pointDetailsMode = 'log'; // 'simple' or 'log'

    window.togglePointDetailsMode = () => {
        window.pointDetailsMode = window.pointDetailsMode === 'simple' ? 'log' : 'simple';
        // Re-render currently stashed hits if available (UI refresh)
        const stashMeta = document.getElementById('point-data-stash-meta');
        if (stashMeta && stashMeta.textContent) {
            try {
                const meta = JSON.parse(stashMeta.textContent);
                // We need to re-call updateFloatingInfoPanelMulti with the ORIGINAL hits.
                // But hits are not fully serialized.
                // We can just rely on the user clicking again or, better, we store the last hits globally?
                if (window.lastMultiHits) {
                    window.updateFloatingInfoPanelMulti(window.lastMultiHits);
                }
            } catch (e) { console.error(e); }
        }
    };

    function getBestServerFromMimo(blocks) {
        const list = Array.isArray(blocks) ? blocks : [];
        return list.reduce((best, c) =>
            !best || (Number.isFinite(c?.rscp) && c.rscp > best.rscp) ? c : best
            , null);
    }

    function getOwningLogForPoint(point, preferredLog) {
        const logs = Array.isArray(window.loadedLogs) ? window.loadedLogs : [];
        const inLog = (log) => {
            if (!log || !Array.isArray(log.points)) return false;
            if (log.points.includes(point)) return true;
            const pid = point && point.id;
            const ptime = point && point.time;
            const plat = Number(point && point.lat);
            const plng = Number(point && point.lng);
            return log.points.some(lp => {
                if (!lp) return false;
                if (pid !== undefined && lp.id === pid && ptime && lp.time === ptime) return true;
                if (ptime && lp.time === ptime && Number.isFinite(plat) && Number.isFinite(plng)) {
                    return Math.abs(Number(lp.lat) - plat) < 1e-7 && Math.abs(Number(lp.lng) - plng) < 1e-7;
                }
                return false;
            });
        };
        if (inLog(preferredLog)) return preferredLog;
        return logs.find(inLog) || null;
    }

    function extractLteTrpServingAndNeighbors(point) {
        const toNumIfFinite = (v) => {
            if (v === null || v === undefined || v === '') return null;
            const n = Number(v);
            return Number.isFinite(n) ? n : null;
        };
        const resolveField = (suffix) => {
            const s = String(suffix || '').toLowerCase();
            if (!s) return null;
            if (/(^|\.)(pci)$/.test(s) || s.includes('physicalcellid')) return 'pci';
            if (/(^|\.)(rsrp)$/.test(s)) return 'rsrp';
            if (/(^|\.)(rsrq)$/.test(s)) return 'rsrq';
            if (s.includes('earfcn')) return 'earfcn';
            if (s.includes('cellidentity') || s.endsWith('.cellid') || s.endsWith('cellid')) return 'cellid';
            return null;
        };
        const ensureBucket = (obj, key) => {
            if (!obj[key]) obj[key] = { pci: null, rsrp: null, rsrq: null, earfcn: null, cellid: null };
            return obj[key];
        };

        const servingByCell = {};
        const neighborsByCell = {};
        const sources = [point, point && point.properties];
        sources.forEach((src) => {
            if (!src || typeof src !== 'object') return;
            Object.entries(src).forEach(([rawKey, rawValue]) => {
                if (rawValue === null || rawValue === undefined || rawValue === '' || typeof rawValue === 'object') return;
                const key = String(rawKey || '').toLowerCase();
                let m = key.match(/radio\.lte\.servingcell(?:total)?(?:\[(\d+)\])?\.(.+)$/i);
                if (m) {
                    const idx = m[1] || 'serving';
                    const field = resolveField(m[2]);
                    if (!field) return;
                    const bucket = ensureBucket(servingByCell, idx);
                    const n = toNumIfFinite(rawValue);
                    bucket[field] = n !== null ? n : bucket[field];
                    return;
                }
                m = key.match(/radio\.lte\.neighbor\[(\d+)\]\.(.+)$/i);
                if (m) {
                    const idx = m[1] || '0';
                    const field = resolveField(m[2]);
                    if (!field) return;
                    const bucket = ensureBucket(neighborsByCell, idx);
                    const n = toNumIfFinite(rawValue);
                    bucket[field] = n !== null ? n : bucket[field];
                }
            });
        });

        const serving = Object.values(servingByCell)
            .sort((a, b) => {
                const score = (x) =>
                    (Number.isFinite(x.rsrp) ? 3 : 0) +
                    (Number.isFinite(x.rsrq) ? 2 : 0) +
                    (Number.isFinite(x.pci) ? 2 : 0) +
                    (Number.isFinite(x.earfcn) ? 1 : 0);
                return score(b) - score(a);
            })[0] || null;

        const precomputedWindowNeighbors = Array.isArray(point && point.__lteTrpNeighborWindow && point.__lteTrpNeighborWindow.neighbors)
            ? point.__lteTrpNeighborWindow.neighbors
                .map((n, idx) => ({
                    idx: idx + 1,
                    pci: toNumIfFinite(n && n.pci),
                    rsrp: toNumIfFinite(n && n.rsrp),
                    rsrq: toNumIfFinite(n && n.rsrq),
                    earfcn: toNumIfFinite(n && n.earfcn),
                    cellid: null
                }))
                .filter(n => Number.isFinite(n.rsrp) || Number.isFinite(n.rsrq) || Number.isFinite(n.pci))
            : [];

        const neighborsBase = precomputedWindowNeighbors.length
            ? precomputedWindowNeighbors
            : Object.entries(neighborsByCell)
                .map(([idx, n]) => ({ idx: Number(idx), ...n }))
                .filter(n => Number.isFinite(n.rsrp) || Number.isFinite(n.rsrq) || Number.isFinite(n.pci));

        const neighbors = neighborsBase
            .sort((a, b) => {
                const ra = Number.isFinite(a.rsrp) ? a.rsrp : -999;
                const rb = Number.isFinite(b.rsrp) ? b.rsrp : -999;
                if (rb !== ra) return rb - ra;
                return (a.idx || 0) - (b.idx || 0);
            });

        return { serving, neighbors };
    }

    // --- NEW: Log View Generator ---
    function generatePointInfoHTMLLog(p, logColor) {
        // Extract Serving
        let sName = 'Unknown', sSC = '-', sRSCP = '-', sEcNo = '-', sFreq = '-', sRnc = null, sCid = null, sLac = null;
        let isLTE = false;
        const activeLog = getOwningLogForPoint(p, window.__activePointLog);
        const isTrpPoint = Boolean((p && p.properties && p.properties.source === 'trp_track') || (activeLog && activeLog.trpRunId));
        const logTech = String((activeLog && activeLog.tech) || p?.Tech || p?.tech || '').toUpperCase();

        // Explicit Name Resolution (Matches Map Logic)
        let servingRes = null;
        if (window.resolveSmartSite) {
            servingRes = window.resolveSmartSite(p);
            if (servingRes && servingRes.name) sName = servingRes.name;
        }

        // --- Normalize UMTS serving from raw MIMOMEAS blocks (best RSCP) ---
        try {
            // Common places parser may store blocks
            const mimoBlocks =
                (p && p.parsed && (p.parsed.mimoBlocks || p.parsed.blocks || p.parsed.cells)) ||
                (p && (p.mimoBlocks || p.blocks || p.cells)) ||
                null;

            if (Array.isArray(mimoBlocks) && mimoBlocks.length) {
                const best = getBestServerFromMimo(mimoBlocks);
                if (best) {
                    if (!p.parsed) p.parsed = {};
                    p.parsed.serving = {
                        ...p.parsed.serving,
                        sc: best.psc ?? best.sc ?? best.SCID ?? best.scramblingCode ?? best.code,
                        rscp: Number.isFinite(best.rscp) ? best.rscp : p.parsed.serving?.rscp,
                        ecno: Number.isFinite(best.ecno) ? best.ecno : p.parsed.serving?.ecno,
                        freq: best.uarfcn ?? best.freq ?? p.parsed.serving?.freq,
                        cellId: best.cellId ?? best.cid ?? p.parsed.serving?.cellId
                    };
                }
            }
        } catch (e) {
            // no-op, do not break Point Details
        }

        const connectionTargets = [];

        if (p.parsed && p.parsed.serving) {
            const s = p.parsed.serving;
            if (sName === 'Unknown') sName = s.cellName || s.name || p.cellName || sName;
            sSC = s.sc !== undefined ? s.sc : sSC;

            // Flexible Level Extraction
            sRSCP = s.rscp !== undefined ? s.rscp : (s.rsrp !== undefined ? s.rsrp : (s.level !== undefined ? s.level : sRSCP));
            sEcNo = s.ecno !== undefined ? s.ecno : (s.rsrq !== undefined ? s.rsrq : sEcNo);

            sFreq = s.freq !== undefined ? s.freq : sFreq;
            sRnc = s.rnc || p.rnc;
            sCid = s.cid || p.cid;
            sLac = s.lac || p.lac;
            isLTE = s.rsrp !== undefined;
        } else {
            // Flat fallback
            if (sName === 'Unknown') sName = p.cellName || p.siteName || sName;
            sSC = p.sc !== undefined ? p.sc : sSC;
            sRSCP = p.rscp !== undefined ? p.rscp : (p.rsrp !== undefined ? p.rsrp : (p.level !== undefined ? p.level : sRSCP));
            sEcNo = p.ecno !== undefined ? p.ecno : (p.qual !== undefined ? p.qual : sEcNo);
            sFreq = p.freq !== undefined ? p.freq : sFreq;
            sRnc = p.rnc;
            sCid = p.cid;
            sLac = p.lac;
            isLTE = p.Tech === 'LTE';
        }
        if (!isLTE && logTech.includes('LTE')) isLTE = true;

        // DATABASE FALLBACK: If RNC/CID are still missing but we resolved a site, use its IDs
        if ((sRnc === null || sRnc === undefined) && servingRes && servingRes.rnc) {
            sRnc = servingRes.rnc;
            sCid = servingRes.cid;
            if (sName === 'Unknown') sName = servingRes.name || sName;
        }

        // TRP LTE override: extract serving + neighbors from decoded LTE metric keys at this timestamp.
        const lteTrpCtx = (isTrpPoint && isLTE) ? extractLteTrpServingAndNeighbors(p) : null;
        if (lteTrpCtx && lteTrpCtx.serving) {
            const sv = lteTrpCtx.serving;
            if (Number.isFinite(sv.pci)) sSC = sv.pci;
            if (Number.isFinite(sv.rsrp)) sRSCP = sv.rsrp;
            if (Number.isFinite(sv.rsrq)) sEcNo = sv.rsrq;
            if (Number.isFinite(sv.earfcn)) sFreq = sv.earfcn;
            isLTE = true;
            // Avoid stale serving cache from an earlier resolve pass before LTE serving extraction.
            delete p._cachedServing;
        }

        const isLteTrp = Boolean(isTrpPoint && isLTE);
        const idHeader = isLteTrp ? 'PCI' : 'SC';
        const levelHeader = isLTE ? 'RSRP' : 'RSCP';
        const qualHeader = isLTE ? 'RSRQ' : 'EcNo';

        // Helpers for case-insensitive key lookup (from p or p.properties)
        const getValCI = (key) => {
            if (p[key] !== undefined) return p[key];
            if (p.properties) {
                const keys = Object.keys(p.properties);
                const match = keys.find(k => k.toLowerCase() === String(key).toLowerCase());
                if (match) return p.properties[match];
            }
            return undefined;
        };
        const findByKeyPattern = (obj, predicate) => {
            if (!obj || typeof obj !== 'object') return undefined;
            const keys = Object.keys(obj);
            for (const k of keys) {
                if (predicate(String(k || '').toLowerCase())) return obj[k];
            }
            return undefined;
        };
        const toCleanIdString = (v) => {
            if (v === undefined || v === null) return null;
            const s = String(v).trim();
            if (!s || s === '-' || s.toLowerCase() === 'n/a' || s.toLowerCase() === 'unknown') return null;
            return s;
        };
        const parseFiniteInt = (v) => {
            const n = Number(v);
            if (!Number.isFinite(n)) return null;
            return Math.round(n);
        };
        const pointLteEci = (() => {
            const direct = [
                getValCI('Radio.Lte.ServingCell[8].CellIdentity.Complete'),
                getValCI('radio.lte.servingcell[8].cellidentity.complete'),
                getValCI('cellidentity.complete'),
                p.lteEci,
                p.eci
            ];
            for (const c of direct) {
                const v = parseFiniteInt(c);
                if (v !== null && v > 255) return v;
            }
            const fuzzyTop = findByKeyPattern(p, (k) =>
                ((k.includes('servingcell') && k.includes('cellidentity') && k.includes('complete')) || k.includes('cellidentitycomplete') || k === 'eci')
            );
            {
                const v = parseFiniteInt(fuzzyTop);
                if (v !== null && v > 255) return v;
            }
            const fuzzyProps = findByKeyPattern(p.properties, (k) =>
                ((k.includes('servingcell') && k.includes('cellidentity') && k.includes('complete')) || k.includes('cellidentitycomplete') || k === 'eci')
            );
            {
                const v = parseFiniteInt(fuzzyProps);
                if (v !== null && v > 255) return v;
            }
            const cellV = parseFiniteInt(p.cellId);
            if (cellV !== null && cellV > 65535) return cellV;
            return null;
        })();
        const decodedLteId = (pointLteEci !== null)
            ? { eci: pointLteEci, enb: Math.floor(pointLteEci / 256), cid: pointLteEci % 256 }
            : null;
        const forceResolveFromServingRf = Boolean(
            isLTE &&
            Number.isFinite(Number(sSC)) &&
            Number.isFinite(Number(sFreq))
        );
        if ((forceResolveFromServingRf || !servingRes || !servingRes.name || servingRes.name === 'Unknown' || !Number.isFinite(Number(servingRes.lat)) || !Number.isFinite(Number(servingRes.lng))) && window.resolveSmartSite) {
            const probe = {
                sc: sSC,
                pci: sSC,
                freq: sFreq,
                lac: sLac,
                lat: p.lat,
                lng: p.lng,
                properties: p.properties
            };
            // Only use decoded ECI fallback when we don't have a reliable serving RF pair.
            if (decodedLteId && !forceResolveFromServingRf) {
                probe.cellId = decodedLteId.eci;
                probe.rawEnodebCellId = `${decodedLteId.enb}-${decodedLteId.cid}`;
                probe.enodebCellId = probe.rawEnodebCellId;
            }
            const resolvedServing = window.resolveSmartSite(probe);
            if (resolvedServing && (resolvedServing.id || resolvedServing.name || (resolvedServing.lat && resolvedServing.lng))) {
                servingRes = resolvedServing;
                if (resolvedServing.name) sName = resolvedServing.name;
                if ((sRnc === null || sRnc === undefined) && Number.isFinite(Number(resolvedServing.rnc))) sRnc = resolvedServing.rnc;
                if ((sCid === null || sCid === undefined) && Number.isFinite(Number(resolvedServing.cid))) sCid = resolvedServing.cid;
            }
        }
        if ((sRnc === null || sRnc === undefined) && decodedLteId && !forceResolveFromServingRf) sRnc = decodedLteId.enb;
        if ((sCid === null || sCid === undefined) && decodedLteId && !forceResolveFromServingRf) sCid = decodedLteId.cid;
        const servingEnodebCellId = (() => {
            const fromResolver = toCleanIdString(servingRes && (servingRes.rawEnodebCellId || servingRes.id));
            if (fromResolver && /^\d+\s*[-/]\s*\d+$/.test(fromResolver)) return fromResolver.replace(/\s+/g, '');
            if (decodedLteId && !forceResolveFromServingRf) return `${decodedLteId.enb}-${decodedLteId.cid}`;
            const candidates = [
                'eNodeB ID-Cell ID',
                'eNodeB ID - Cell ID',
                'enodeb id-cell id',
                'enodebid-cellid',
                'enodebidcellid',
                'rawEnodebCellId'
            ];
            for (const key of candidates) {
                const val = toCleanIdString(getValCI(key));
                if (!val) continue;
                if (/^\d+\s*[-/]\s*\d+$/.test(val)) return val.replace(/\s+/g, '');
            }
            const cellTxt = toCleanIdString(p.cellId);
            if (cellTxt && /^\d+\s*[-/]\s*\d+$/.test(cellTxt)) return cellTxt.replace(/\s+/g, '');
            if (Number.isFinite(Number(sRnc)) && Number.isFinite(Number(sCid))) return `${Number(sRnc)}-${Number(sCid)}`;
            return null;
        })();

        // Determine Identity Label
        let identityLabel = sSC + ' / ' + sFreq; // Default
        if (isLTE && servingEnodebCellId) {
            identityLabel = servingEnodebCellId;
        } else if (servingRes && servingRes.id) {
            identityLabel = servingRes.id;
        } else if (sRnc !== null && sRnc !== undefined && sCid !== null && sCid !== undefined) {
            identityLabel = sRnc + '/' + sCid; // UMTS RNC/CID
        } else if (p.cellId && p.cellId !== 'N/A') {
            identityLabel = p.cellId; // LTE ECI or synthesized UMTS CID
        }
        const servingLineCellId = (servingRes && (servingRes.rawEnodebCellId || servingRes.id)) || servingEnodebCellId || null;
        if ((servingRes && Number.isFinite(Number(servingRes.lat)) && Number.isFinite(Number(servingRes.lng))) || servingLineCellId) {
            connectionTargets.push({
                lat: (servingRes && Number.isFinite(Number(servingRes.lat))) ? Number(servingRes.lat) : null,
                lng: (servingRes && Number.isFinite(Number(servingRes.lng))) ? Number(servingRes.lng) : null,
                color: '#3b82f6', weight: 8, cellId: servingLineCellId,
                azimuth: servingRes.azimuth, range: servingRes.range, tipLat: servingRes.tipLat, tipLng: servingRes.tipLng
            });
        }

        const readNeighborMetric = (prefix, idx) => {
            const base = `${prefix}${idx}`;
            const sc = getValCI(`${base}_sc`) ?? getValCI(`${base} SC`);
            const rscp = getValCI(`${base}_rscp`) ?? getValCI(`${base} RSCP`);
            const ecno = getValCI(`${base}_ecno`) ?? getValCI(`${base} EcNo`);
            const freq = getValCI(`${base}_freq`) ?? getValCI(`${base} Freq`) ?? sFreq;

            if (sc === undefined && rscp === undefined && ecno === undefined) return null;
            return {
                type: `${prefix.toUpperCase()}${idx}`,
                sc: sc !== undefined ? sc : '-',
                rscp: rscp !== undefined ? rscp : '-',
                ecno: ecno !== undefined ? ecno : '-',
                freq: freq !== undefined ? freq : '-'
            };
        };
        const normalizeCellKeyPart = (v) => {
            if (v === undefined || v === null) return null;
            const s = String(v).trim();
            if (!s || s === '-' || s.toLowerCase() === 'n/a' || s.toLowerCase() === 'unknown') return null;
            const n = Number(s);
            return Number.isFinite(n) ? String(n) : s.toLowerCase();
        };
        const servingScKey = normalizeCellKeyPart(sSC);
        const servingFreqKey = normalizeCellKeyPart(sFreq);
        const isServingEquivalentNeighbor = (n) => {
            if (!n) return false;
            const nScKey = normalizeCellKeyPart(n.sc);
            const nFreqKey = normalizeCellKeyPart(n.freq);
            if (!nScKey || !servingScKey) return false;
            if (nScKey !== servingScKey) return false;
            // If frequency is missing on either side, SC match alone is enough to avoid duplicate serving row.
            if (!servingFreqKey || !nFreqKey) return true;
            return nFreqKey === servingFreqKey;
        };

        // Neighbors
        let rawNeighbors = [];
        let explicitNeighbors = [];
        let lteTrpNeighbors = [];

        if (isLteTrp && lteTrpCtx && Array.isArray(lteTrpCtx.neighbors)) {
            lteTrpNeighbors = lteTrpCtx.neighbors.map((n, idx) => ({
                type: 'N' + (idx + 1),
                sc: Number.isFinite(n.pci) ? n.pci : '-',
                rsrp: Number.isFinite(n.rsrp) ? n.rsrp : '-',
                rscp: Number.isFinite(n.rsrp) ? n.rsrp : '-',
                ecno: Number.isFinite(n.rsrq) ? n.rsrq : '-',
                freq: Number.isFinite(n.earfcn) ? n.earfcn : '-',
                cellName: null
            }));
        }

        // Prefer explicit M/A/D metrics if available (UMTS DT style)
        if (!isLTE) {
            for (let i = 1; i <= 16; i++) {
                const m = readNeighborMetric('m', i);
                if (m) explicitNeighbors.push(m);
            }
            for (let i = 2; i <= 16; i++) {
                const a = readNeighborMetric('a', i);
                if (a) explicitNeighbors.push(a);
            }
            for (let i = 1; i <= 16; i++) {
                const d = readNeighborMetric('d', i);
                if (d) explicitNeighbors.push(d);
            }
            // Avoid showing serving cell again as A2/A3/Mx when vendor fields duplicate SC/FREQ.
            explicitNeighbors = explicitNeighbors.filter(n => !isServingEquivalentNeighbor(n));
        }
        const resolveN = (sc, freq, cellName) => {
            if (window.resolveSmartSite && (sc !== undefined || freq !== undefined)) {
                // Try with current LAC first
                let nRes = window.resolveSmartSite({
                    sc: sc, freq: freq, pci: sc, lat: p.lat, lng: p.lng, lac: sLac
                });

                // Fallback: Try without LAC (neighbors are often on different LACs)
                if ((!nRes || nRes.name === 'Unknown') && sLac) {
                    nRes = window.resolveSmartSite({
                        sc: sc, freq: freq, pci: sc, lat: p.lat, lng: p.lng
                    });
                }

                if (nRes && nRes.name && nRes.name !== 'Unknown') {
                    return {
                        name: nRes.name, rnc: nRes.rnc, cid: nRes.cid, id: nRes.id, lat: nRes.lat, lng: nRes.lng,
                        azimuth: nRes.azimuth, range: nRes.range, tipLat: nRes.tipLat, tipLng: nRes.tipLng
                    };
                }
            }
            return {
                name: cellName || 'Unknown', rnc: null, cid: null, id: null, lat: null, lng: null,
                azimuth: null, range: null, tipLat: null, tipLng: null
            };
        };

        if (explicitNeighbors.length === 0 && p.parsed && p.parsed.neighbors) {
            p.parsed.neighbors.forEach(n => {
                const sc = n.pci !== undefined ? n.pci : (n.sc !== undefined ? n.sc : undefined);
                const freq = n.freq !== undefined ? n.freq : undefined;

                // FILTER: Skip if this neighbor matches the serving cell
                if (sc == sSC && freq == sFreq) return;

                rawNeighbors.push({
                    sc: sc !== undefined ? sc : '-',
                    rsrp: n.rsrp !== undefined ? n.rsrp : (n.rscp !== undefined ? n.rscp : -140),
                    rscp: n.rscp !== undefined ? n.rscp : -140, // Default low for sort
                    ecno: n.ecno !== undefined ? n.ecno : '-',
                    freq: n.freq !== undefined ? n.freq : '-',
                    cellName: n.cellName,
                    type: n.type // Capture type from parser (A2, M1...)
                });
            });
        }
        // Fallback Flat Neighbors (N1..N3)
        if (rawNeighbors.length === 0) {
            if (p.n1_sc !== undefined && (p.n1_sc != sSC)) rawNeighbors.push({ sc: p.n1_sc, rscp: p.n1_rscp || -140, ecno: p.n1_ecno, freq: sFreq });
            if (p.n2_sc !== undefined && (p.n2_sc != sSC)) rawNeighbors.push({ sc: p.n2_sc, rscp: p.n2_rscp || -140, ecno: p.n2_ecno, freq: sFreq });
            if (p.n3_sc !== undefined && (p.n3_sc != sSC)) rawNeighbors.push({ sc: p.n3_sc, rscp: p.n3_rscp || -140, ecno: p.n3_ecno, freq: sFreq });
        }

        // Sort by RSRP (fallback RSCP) descending (strongest to weakest)
        const sourceNeighbors = (lteTrpNeighbors.length > 0)
            ? lteTrpNeighbors
            : (explicitNeighbors.length > 0 ? explicitNeighbors : rawNeighbors);
        const neighborSignalLevel = (n) => {
            const rsrp = parseFloat(n && n.rsrp);
            if (!isNaN(rsrp)) return rsrp;
            const rscp = parseFloat(n && n.rscp);
            if (!isNaN(rscp)) return rscp;
            return null;
        };
        const neighborsSource = sourceNeighbors
            .filter(n => !isServingEquivalentNeighbor(n))
            .slice()
            .sort((a, b) => {
                const valA = neighborSignalLevel(a);
                const valB = neighborSignalLevel(b);
                if (valA === null && valB === null) return 0;
                if (valA === null) return 1;
                if (valB === null) return -1;
                return valB - valA;
            });

        const neighbors = neighborsSource.map((n, i) => {
            const resolved = resolveN(n.sc, n.freq, n.cellName);
            return {
                type: n.type || ('N' + (i + 1)),
                name: resolved.name,
                rnc: resolved.rnc,
                cid: resolved.cid,
                id: resolved.id, // Pass ID
                lat: resolved.lat,
                lng: resolved.lng,
                tipLat: resolved.tipLat,
                tipLng: resolved.tipLng,
                azimuth: resolved.azimuth,
                range: resolved.range,
                sc: n.sc,
                rscp: n.rscp === -140 ? '-' : n.rscp,
                ecno: n.ecno,
                freq: n.freq
            };
        });

        // Build HTML
        let rows = '';

        // Serving Click Logic
        let sClickAction = '';
        /* FIX: Use highlightAndPan */
        if (servingRes && servingRes.lat && servingRes.lng) {
            const safeId = servingRes.id || (servingRes.rnc && servingRes.cid ? servingRes.rnc + '/' + servingRes.cid : '');
            sClickAction = 'onclick="window.highlightAndPan(' + servingRes.lat + ', ' + servingRes.lng + ', \'' + safeId + '\', \'serving\')" style="cursor: pointer; color: #fff; "';
        }

        // Serving Row
        rows += '<tr class="log-row serving-row">' +
            '<td class="log-cell-type">Serving</td>' +
            '<td class="log-cell-name"><span class="log-header-serving" ' + sClickAction + '>' + sName + '</span> <span style="color:#666; font-size:10px;">(' + identityLabel + ')</span></td>' +
            '<td class="log-cell-val">' + sSC + '</td>' +
            '<td class="log-cell-val">' + sRSCP + '</td>' +
            '<td class="log-cell-val">' + sEcNo + '</td>' +
            '<td class="log-cell-val">' + sFreq + '</td>' +
            '</tr>';

        neighbors.forEach(n => {
            let nIdLabel = n.sc + '/' + n.freq;
            if (n.rnc && n.cid) nIdLabel = n.rnc + '/' + n.cid;

            let nClickAction = '';
            /* FIX: Use highlightAndPan */
            if (n.lat && n.lng) {
                const safeId = n.id || (n.rnc && n.cid ? n.rnc + '/' + n.cid : '');
                nClickAction = 'onclick="window.highlightAndPan(' + n.lat + ', ' + n.lng + ', \'' + safeId + '\', \'neighbor\') " style="cursor: pointer; "';
            }

            // Color Type D red
            const typeStyle = n.type.startsWith('D') ? 'color: #DC2626; font-weight: bold;' : '';
            const typePrefix = (n.type || '').toString().charAt(0);
            const typeLabel = typePrefix === 'A' ? 'Active' : (typePrefix === 'M' ? 'Monitored' : (typePrefix === 'D' ? 'Detected' : ''));
            const typeText = typeLabel ? `${n.type} (${typeLabel})` : n.type;

            rows += '<tr class="log-row">' +
                '<td class="log-cell-type" style="' + typeStyle + '" title="' + (typeLabel || '') + '">' + typeText + '</td>' +
                '<td class="log-cell-name"><span ' + nClickAction + '>' + n.name + '</span> <span style="color:#666; font-size:10px;">(' + nIdLabel + ')</span></td>' +
                '<td class="log-cell-val">' + n.sc + '</td>' +
                '<td class="log-cell-val">' + n.rscp + '</td>' +
                '<td class="log-cell-val">' + n.ecno + '</td>' +
                '<td class="log-cell-val">' + n.freq + '</td>' +
                '</tr>';
        });

        // ----------------------------------------------------
        // OTHER METRICS (fixed ordered list requested by user)
        // ----------------------------------------------------
        const normalizeMissing = (v) => {
            if (v === undefined || v === null) return 'N/A';
            if (typeof v === 'string') {
                const s = v.trim();
                if (!s || s === '-' || s.toLowerCase() === 'nan' || s.toLowerCase() === 'unknown') return 'N/A';
                return s;
            }
            if (typeof v === 'number') {
                if (!Number.isFinite(v)) return 'N/A';
                return Number.isInteger(v) ? String(v) : String(Number(v.toFixed(1)));
            }
            return String(v);
        };
        const getFromObjCI = (obj, key) => {
            if (!obj || typeof obj !== 'object') return undefined;
            const wanted = String(key || '').toLowerCase();
            const match = Object.keys(obj).find(k => String(k || '').toLowerCase() === wanted);
            return match ? obj[match] : undefined;
        };
        const getAny = (...keys) => {
            for (const k of keys) {
                const v1 = getValCI(k);
                if (v1 !== undefined && v1 !== null && String(v1).trim() !== '') return v1;
                const v2 = getFromObjCI(p?.parsed?.serving, k);
                if (v2 !== undefined && v2 !== null && String(v2).trim() !== '') return v2;
            }
            return undefined;
        };
        const findByTokens = (tokens) => {
            const t = (tokens || []).map(x => String(x || '').toLowerCase());
            const sources = [p, p?.properties, p?.parsed?.serving];
            for (const src of sources) {
                if (!src || typeof src !== 'object') continue;
                for (const [k, v] of Object.entries(src)) {
                    if (v === undefined || v === null || typeof v === 'object') continue;
                    const lk = String(k || '').toLowerCase();
                    const ok = t.every(tok => lk.includes(tok));
                    if (ok) return v;
                }
            }
            return undefined;
        };
        const enbOnly = (() => {
            const txt = String(servingEnodebCellId || '').trim();
            if (!txt) return undefined;
            const m = txt.match(/^(\d+)\s*[-/]\s*(\d+)$/);
            return m ? m[1] : undefined;
        })();
        const metricRows = [];
        const pushMetric = (label, value) => metricRows.push({ label, value: normalizeMissing(value), header: false });
        const pushHeader = (label) => metricRows.push({ label, value: '', header: true });

        pushMetric('Serving cell name', sName);
        pushMetric('Application throughput DL', getAny('Application throughput DL', 'Application Throughput DL', 'App Throughput DL') ?? findByTokens(['application', 'throughput', 'dl']));
        pushMetric('Cell ID', getAny('Cell ID', 'cell id') ?? p.cellId);
        pushMetric('Cellid', getAny('Cellid', 'cellid') ?? p.cellId);
        pushMetric('DL throughput', getAny('DL throughput', 'PDSCH Throughput', 'Radio.Lte.ServingCell[8].Pdsch.Throughput') ?? findByTokens(['throughput', 'dl']));
        pushMetric('Downlink EARFCN', sFreq);
        pushMetric('eNodeB ID', enbOnly);
        pushMetric('Physical cell ID', sSC);
        pushMetric('RSRP', sRSCP);
        pushMetric('RSRQ', sEcNo);
        pushMetric('SINR', getAny('SINR', 'RS-SINR', 'RSSINR', 'RS SINR') ?? findByTokens(['sinr']));
        pushMetric('Tracking area code', getAny('Tracking area code', 'TAC') ?? findByTokens(['tracking', 'area', 'code']));
        pushMetric('UL throughput', getAny('UL throughput', 'PUSCH Throughput') ?? findByTokens(['throughput', 'ul']));
        pushMetric('CQI (DL)', getAny('CQI (DL)', 'CQI', 'Downlink CQI') ?? findByTokens(['cqi']));
        pushMetric('DL MCS', getAny('DL MCS') ?? findByTokens(['dl', 'mcs']));
        pushMetric('UL MCS', getAny('UL MCS') ?? findByTokens(['ul', 'mcs']));
        const dlMod = getAny('DL Modulation') ?? findByTokens(['dl', 'modulation']);
        const ulMod = getAny('UL Modulation') ?? findByTokens(['ul', 'modulation']);
        pushMetric('Modulation (DL/UL)', ((dlMod || ulMod) ? `${normalizeMissing(dlMod)} / ${normalizeMissing(ulMod)}` : 'N/A'));
        pushMetric('Timing Advance', getAny('Timing Advance', 'TA') ?? findByTokens(['timing', 'advance']));
        pushMetric('MIMO/CA', getAny('MIMO/CA', 'MIMO', 'CA') ?? findByTokens(['mimo']) ?? findByTokens(['carrier', 'aggregation']));
        pushMetric('PMI', getAny('PMI') ?? findByTokens(['pmi']));
        pushMetric('Rank/Layers (feedback proxy)', getAny('Rank', 'Layers', 'Rank Indicator') ?? findByTokens(['rank']) ?? findByTokens(['layer']));

        pushHeader('RELIABILITY');
        pushMetric('BLER DL', getAny('BLER DL', 'blerDl', 'DL BLER') ?? findByTokens(['bler', 'dl']));

        pushHeader('EVENTS');
        pushMetric('RRC State', getAny('RRC State', 'rrcState') ?? findByTokens(['rrc', 'state']));
        pushMetric('HO Start/Complete', getAny('HO Start/Complete') ?? findByTokens(['ho', 'start']) ?? findByTokens(['ho', 'complete']));
        pushMetric('Cell/PCI Change (inferred)', getAny('Cell/PCI Change (inferred)') ?? findByTokens(['pci', 'change']) ?? findByTokens(['cell', 'change']));
        pushMetric('EARFCN/Band Change (inferred)', getAny('EARFCN/Band Change (inferred)') ?? findByTokens(['earfcn', 'change']) ?? findByTokens(['band', 'change']));
        pushMetric('RRC State Transition', getAny('RRC State Transition') ?? findByTokens(['rrc', 'transition']));
        pushMetric('Bearer / EPS Bearer', getAny('Bearer / EPS Bearer', 'EPS Bearer') ?? findByTokens(['eps', 'bearer']) ?? findByTokens(['bearer']));
        pushMetric('TA Jumps', getAny('TA Jumps') ?? findByTokens(['ta', 'jump']));

        pushHeader('Neighbors');
        for (let i = 1; i <= 4; i++) {
            const n = neighbors[i - 1] || {};
            pushMetric(`N${i} cell name`, n.name || 'N/A');
            pushMetric(`N${i} RSRP`, n.rscp);
            pushMetric(`N${i} RSRQ`, n.ecno);
            pushMetric(`N${i} SINR`, n.sinr ?? 'N/A');
            pushMetric(`N${i} Freq`, n.freq);
        }

        let extraMetricsHtml = '';
        metricRows.forEach((row) => {
            if (row.header) {
                extraMetricsHtml += '<div style="border-bottom:1px solid #334155; padding:6px 0 4px 0; margin-top:4px; color:#93c5fd; font-size:11px; font-weight:700;">' +
                    row.label +
                    '</div>';
                return;
            }
            extraMetricsHtml += '<div style="display:flex; justify-content:space-between; border-bottom:1px solid #444; font-size:11px; padding:3px 0;">' +
                '<span style="color:#aaa; margin-right: 10px;">' + row.label + '</span>' +
                '<span style="color:#fff; font-weight:bold; text-align: right;">' + row.value + '</span>' +
                '</div>';
        });
        const extraMetricsSection = '<div style="margin-top:15px; border-top:1px solid #555; padding-top:10px;">' +
            '<div style="font-size:12px; font-weight:bold; color:#ccc; margin-bottom:5px;">Other Metrics</div>' +
            '<div style="max-height: 260px; overflow-y: auto;">' +
            extraMetricsHtml +
            '</div>' +
            '</div>';

        // --- NEW: Extract eNodeB Specific Fields ---
        let enbNameDisplay = '';
        let enbIdDisplay = '';

        if (p.properties) {
            const getVal = (candidates) => {
                const keys = Object.keys(p.properties);
                for (const c of candidates) {
                    const match = keys.find(k => k.toLowerCase() === c.toLowerCase());
                    if (match) return p.properties[match];
                }
                return null;
            };
            const rawName = getVal(['eNodeB Name', 'eNodeBName']);
            if (rawName) enbNameDisplay = `<div style="font-size:11px; color:#e5e7eb;"><b>eNB:</b> ${rawName}</div>`;

            const rawId = getVal(['eNodeB ID-Cell ID', 'eNodeB ID - Cell ID']);
            if (rawId) enbIdDisplay = `<div style="font-size:11px; color:#e5e7eb;"><b>ID:</b> ${rawId}</div>`;
        }

        const html = '<div class="log-view-container">' +
            '<div style="display:flex; justify-content:space-between; align-items:flex-end; margin-bottom:5px;">' +
            '<div>' +
            '<div class="log-header-serving" style="font-size:14px; margin-bottom:2px;">' + sName + '</div>' +
            enbNameDisplay +
            enbIdDisplay +
            '<div style="color:#aaa; font-size:11px; margin-top:2px;">Lat: ' + p.lat.toFixed(6) + '  Lng: ' + p.lng.toFixed(6) + '</div>' +
            '</div>' +
            '<div style="color:#aaa; font-size:11px;">' + (p.time || '') + '</div>' +
            '</div>' +

            '<table class="log-details-table">' +
            '<thead>' +
            '<tr>' +
            '<th style="width:10%">Type</th>' +
            '<th style="width:40%">Cell Name</th>' +
            '<th>' + idHeader + '</th>' +
            '<th>' + levelHeader + '</th>' +
            '<th>' + qualHeader + '</th>' +
            '<th>Freq</th>' +
            '</tr>' +
            '</thead>' +
            '<tbody>' +
            rows +
            '</tbody>' +
            '</table>' +

            extraMetricsSection +

            '<div style="display:flex; flex-wrap:wrap; gap:5px; margin-top:15px; border-top:1px solid #444; padding-top:10px;">' +
            '<button class="btn btn-blue" onclick="window.analyzePoint(this)" style="flex:1; justify-content: center; min-width: 120px;">SmartCare Analysis</button>' +
            '<button class="btn btn-blue" onclick="window.deepAnalyzePoint(this)" style="flex:1; justify-content: center; min-width: 120px; background-color:#0f766e; color:#fff;">Deep Analysis</button>' +
            '<button class="btn btn-blue" onclick="window.dtAnalyzePoint(this)" style="flex:1; justify-content: center; min-width: 120px; background-color:#0ea5e9; color:#fff;">DT Analysis</button>' +
            '</div>' +

            '<!-- Hidden data stash for the analyzer -->' +
            '<script type="application/json" id="point-data-stash">' +
            JSON.stringify({
                ...(p.properties || p),
                lat: p.lat,
                lng: p.lng,
                'Cell Identifier': sName !== 'Unknown' ? sName : identityLabel,
                'Cell Name': sName,
                'Tech': isLTE ? 'LTE' : 'UMTS'
            }) +
            '</script>' +
            '</div>' +
            '</div>';


        // Add connection targets for top 3 neighbors if they resolve
        neighbors.slice(0, 3).forEach(n => {
            const hasDirectCoords = Number.isFinite(Number(n.lat)) && Number.isFinite(Number(n.lng));
            if (hasDirectCoords) {
                connectionTargets.push({
                    lat: Number(n.lat), lng: Number(n.lng), color: '#ef4444', weight: 4, cellId: n.id,
                    azimuth: n.azimuth, range: n.range, tipLat: n.tipLat, tipLng: n.tipLng
                });
                return;
            }
            if (!window.resolveSmartSite) return;
            const nRes = window.resolveSmartSite({ sc: n.sc, freq: n.freq, lat: p.lat, lng: p.lng, pci: n.sc, lac: sLac });
            if (nRes && Number.isFinite(Number(nRes.lat)) && Number.isFinite(Number(nRes.lng))) {
                connectionTargets.push({
                    lat: Number(nRes.lat), lng: Number(nRes.lng), color: '#ef4444', weight: 4, cellId: nRes.id,
                    azimuth: nRes.azimuth, range: nRes.range, tipLat: nRes.tipLat, tipLng: nRes.tipLng
                });
                return;
            }
            if (nRes && (nRes.rawEnodebCellId || nRes.id)) {
                connectionTargets.push({
                    lat: null, lng: null, color: '#ef4444', weight: 4, cellId: (nRes.rawEnodebCellId || nRes.id),
                    azimuth: nRes.azimuth, range: nRes.range, tipLat: nRes.tipLat, tipLng: nRes.tipLng
                });
                return;
            }
            if (n && n.id) {
                connectionTargets.push({
                    lat: null, lng: null, color: '#ef4444', weight: 4, cellId: n.id,
                    azimuth: n.azimuth, range: n.range, tipLat: n.tipLat, tipLng: n.tipLng
                });
            }
        });

        return { html, connectionTargets };
    }


    window.updateFloatingInfoPanelMulti = (hits) => {
        try {
            window.lastMultiHits = hits; // Store for toggle re-render

            const panel = document.getElementById('floatingInfoPanel');
            const content = document.getElementById('infoPanelContent');
            const headerDom = document.getElementById('infoPanelHeader');

            if (!panel || !content) return;

            if (panel.style.display !== 'block') panel.style.display = 'block';
            content.innerHTML = ''; // Clear

            // Inject Toggle Button into Header if not present
            let toggleBtn = document.getElementById('toggleViewBtn');
            if (!toggleBtn && headerDom) {
                // Remove existing title text to replace with flex container if needed, or just append
                // Let's repurpose the header content slightly
                const closeBtn = headerDom.querySelector('.info-panel-close');

                toggleBtn = document.createElement('span');
                toggleBtn.id = 'toggleViewBtn';
                toggleBtn.className = 'toggle-view-btn';
                toggleBtn.innerHTML = '⚙️ View';
                toggleBtn.title = 'Switch View Mode';
                toggleBtn.onclick = (e) => { e.stopPropagation(); window.togglePointDetailsMode(); };

                // Insert before close button
                headerDom.insertBefore(toggleBtn, closeBtn);
            }

            let allConnectionTargets = [];
            let aggregatedData = [];

            hits.forEach((hit, idx) => {
                const { log, point } = hit;

                // Collect Data for Unified Analysis
                aggregatedData.push({
                    name: 'Layer: ' + log.name,
                    data: point.properties ? point.properties : point
                });

                // Header for this Log Layer
                const header = document.createElement('div');
                header.style.cssText = 'background:#ef4444; color:#fff; padding:5px; font-weight:bold; font-size:12px; margin-top:' + (idx > 0 ? '10px' : '0') + '; border-radius:4px 4px 0 0;';
                header.textContent = 'Layer: ' + log.name;
                content.appendChild(header);

                // Body Selection
                // Use new Log Generator if mode is 'log', else default
                const generator = window.pointDetailsMode === 'log' ? generatePointInfoHTMLLog : generatePointInfoHTML;
                const { html, connectionTargets } = generator(point, log.color, false);

                const body = document.createElement('div');
                body.innerHTML = html;
                content.appendChild(body);

                // Aggregate connections
                if (connectionTargets) allConnectionTargets = allConnectionTargets.concat(connectionTargets);
            });

            // Update Connections (Draw ALL lines from ALL layers)
            if (window.mapRenderer && hits.length > 0) {
                const primary = hits[0].point;
                window.mapRenderer.drawConnections({ lat: primary.lat, lng: primary.lng }, allConnectionTargets);
            }

            // Removed unified Analyze button from sidebar per request

        } catch (e) {
            console.error("Error updating Multi-Info Panel:", e);
        }
    };

    window.syncMarker = null; // Global marker for current sync point


    window.globalSync = (logId, index, source, skipPanel = false) => {
        const log = loadedLogs.find(l => l.id === logId);
        if (!log || !log.points[index]) return;

        const point = log.points[index];

        // 1. Update Map (Marker & View)
        // 1. Update Map (Marker & View)
        // Always update marker, even if source is map (to show selection highlight)
        if (!window.syncMarker) {
            window.syncMarker = L.circleMarker([point.lat, point.lng], {
                radius: 18, // Larger radius to surround the point
                color: '#ffff00', // Yellow
                weight: 4,
                fillColor: 'transparent',
                fillOpacity: 0
            }).addTo(window.map);
        } else {
            window.syncMarker.setLatLng([point.lat, point.lng]);
            // Ensure style is consistent (in case it was overwritten or different)
            window.syncMarker.setStyle({
                radius: 18,
                color: '#ffff00',
                weight: 4,
                fillColor: 'transparent',
                fillOpacity: 0
            });
        }

        // View Navigation (Zoom/Pan) - User Request: Zoom in on click
        // UPDATED: Keep current zoom, just pan.
        // AB: User requested to NOT move map when clicking ON the map.
        if (source !== 'chart_scrub' && source !== 'map') {
            // const targetZoom = Math.max(window.map.getZoom(), 17); // Previous logic
            // window.map.flyTo([point.lat, point.lng], targetZoom, { animate: true, duration: 0.5 });

            // New Logic: Pan only, preserve zoom
            window.map.panTo([point.lat, point.lng], { animate: true, duration: 0.5 });
        }

        // 2. Update Charts
        if (source !== 'chart' && source !== 'chart_scrub') {
            if (window.currentChartLogId === logId && window.updateDualCharts) {
                // We need to update the chart's active index WITHOUT triggering a loop
                // updateDualCharts draws the chart.
                // We simply set the index and draw.
                window.updateDualCharts(index, true); // true = skipSync to avoid loop

                // AUTO ZOOM if requested (User Request: Zoom on Click)
                if (window.zoomChartToActive) {
                    window.zoomChartToActive();
                }
            }
        }

        // 3. Update Floating Panel
        if (window.updateFloatingInfoPanel && !skipPanel) {
            window.__activePointLog = log;
            window.updateFloatingInfoPanel(point, log.color, log);
        }

        // 4. Update Grid
        if (window.currentGridLogId === logId) {
            const row = document.getElementById('grid-row-' + index);
            if (row) {
                document.querySelectorAll('.grid-row').forEach(r => r.classList.remove('selected-row'));
                row.classList.add('selected-row');

                if (source !== 'grid') {
                    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
            }
        }

        // 5. Update Signaling
        if (source !== 'signaling') {
            // Find closest signaling row by time logic (reuised from highlightPoint)
            const targetTime = point.time;
            const parseTime = (t) => {
                const [h, m, s] = t.split(':');
                return (parseInt(h) * 3600 + parseInt(m) * 60 + parseFloat(s)) * 1000;
            };
            const tTarget = parseTime(targetTime);
            let bestIdx = null;
            let minDiff = Infinity;
            const rows = document.querySelectorAll('#signalingTableBody tr');
            rows.forEach((row) => {
                if (!row.pointData) return;
                row.classList.remove('selected-row');
                const t = parseTime(row.pointData.time);
                const diff = Math.abs(t - tTarget);
                if (diff < minDiff) {
                    minDiff = diff;
                    bestIdx = row;
                }
            });
            if (bestIdx && minDiff < 5000) {
                bestIdx.classList.add('selected-row');
                bestIdx.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
        }
    };

    // Global Listener for Custom Legend Color Changes
    window.addEventListener('metric-color-changed', (e) => {
        const { id, color } = e.detail;
        console.log('[App] Color overridden for ' + id + ' -> ' + color);

        // Re-render ALL logs currently showing Discrete Metrics (CellId or CID)
        loadedLogs.forEach(log => {
            if (log.currentParam === 'cellId' || log.currentParam === 'cid') {
                window.mapRenderer.addLogLayer(log.id, log.points, log.currentParam);
            }
        });
    });

    // Global Sync Listener (Legacy Adapatation)
    // Global Sync Listener (Aligning with User Logic: Coordinator Pattern)
    window.addEventListener('map-point-clicked', (e) => {
        const { logId, point, source } = e.detail;

        const log = loadedLogs.find(l => l.id === logId);

        // --- PROBE REDIRECTION: Click on Rabat Excel -> Click on SmartCare ---
        if (log && log.type === 'excel' && point['Analyze point'] && window.findNearestSmartCarePointAndLog) {
            const probed = window.findNearestSmartCarePointAndLog(point.lat, point.lng);
            if (probed) {
                console.log(`[Interaction] Redirecting click from ${logId} to SmartCare ${probed.logId}`);
                // Hijack: Sync the SmartCare point instead
                window.globalSync(probed.logId, probed.index, source || 'map');
                return;
            }
        }

        if (log) {
            const mode = getSessionModeFromMapPoint(point);
            if (mode) {
                const matchedSession = findUmtsFailedSessionFromPoint(log, point, mode);
                if (matchedSession && typeof syncSessionPointToMap === 'function' && typeof renderDropAnalysis === 'function') {
                    syncSessionPointToMap(log, matchedSession, mode);
                    renderDropAnalysis(log, matchedSession);
                    return;
                }
            }

            // Prioritize ID match
            let index = -1;
            if (point.id !== undefined) {
                index = log.points.findIndex(p => p.id === point.id);
            }
            // Fallback to Time
            if (index === -1 && point.time) {
                index = log.points.findIndex(p => p.time === point.time);
            }
            // Fallback to Coord (Tolerance 1e-5 for roughly 1m)
            if (index === -1) {
                index = log.points.findIndex(p => Math.abs(p.lat - point.lat) < 0.00001 && Math.abs(p.lng - point.lng) < 0.00001);
            }

            if (index !== -1) {
                // The Coordinator: globalSync
                // Logic: catches map-point-clicked and calls window.globalSync(). 
                // It specifically invokes window.updateFloatingInfoPanel(point) (via skipPanel=false default)
                window.globalSync(logId, index, source || 'map');
            } else {
                console.warn("[App] Sync Index not found for clicked point.");
                // Fallback: If we can't sync index, just update the panel directly
                if (window.updateFloatingInfoPanel) {
                    window.__activePointLog = log;
                    window.updateFloatingInfoPanel(point, log.color, log);
                }
            }
        }
    });

    // SPIDER OPTION: Sector Click Listener
    window.addEventListener('site-sector-clicked', (e) => {
        // GATED: Only run if Spider Mode is ON
        if (!window.isSpiderMode) return;

        const sector = e.detail;
        if (!sector || !window.mapRenderer) return;

        console.log("[Spider] Sector Clicked:", sector);

        // Find all points served by this sector
        const targetPoints = [];

        // Calculate "Tip Top" (Outer Edge Center) based on Azimuth
        // Use range from the event (current rendering range)
        const range = sector.range || 200;
        const rad = Math.PI / 180;
        const azRad = (sector.azimuth || 0) * rad;
        const latRad = sector.lat * rad;

        const dy = Math.cos(azRad) * range;
        const dx = Math.sin(azRad) * range;
        const dLat = dy / 111111;
        const dLng = dx / (111111 * Math.cos(latRad));

        const startPt = {
            lat: sector.lat + dLat,
            lng: sector.lng + dLng
        };

        const norm = (v) => v !== undefined && v !== null ? String(v).trim() : '';
        const isValid = (v) => v !== undefined && v !== null && v !== 'N/A' && v !== '';

        loadedLogs.forEach(log => {
            log.points.forEach(p => {
                let isMatch = false;

                // 1. Strict RNC/CID Match (Highest Priority)
                if (isValid(sector.rnc) && isValid(sector.cid) && isValid(p.rnc) && isValid(p.cellId)) {
                    if (norm(sector.rnc) === norm(p.rnc) && norm(sector.cid) === norm(p.cellId)) {
                        isMatch = true;
                    }
                }

                // 2. Generic CellID Match (Fallback)
                if (!isMatch && sector.cellId && isValid(p.cellId)) {
                    if (norm(sector.cellId) === norm(p.cellId)) {
                        isMatch = true;
                    }
                    // Support "RNC/CID" format in sector.cellId
                    else if (String(sector.cellId).includes('/')) {
                        const parts = String(sector.cellId).split('/');
                        const cid = parts[parts.length - 1];
                        const rnc = parts.length > 1 ? parts[parts.length - 2] : null;

                        if (rnc && isValid(p.rnc) && norm(p.rnc) === norm(rnc) && norm(p.cellId) === norm(cid)) {
                            isMatch = true;
                        } else if (norm(p.cellId) === norm(cid) && !isValid(p.rnc)) {
                            isMatch = true;
                        }
                    }
                }

                // 3. SC Match (Secondary Fallback)
                if (!isMatch && sector.sc !== undefined && isValid(p.sc)) {
                    if (p.sc == sector.sc) {
                        isMatch = true;
                        // Refine with LAC if available
                        if (sector.lac && isValid(p.lac) && norm(sector.lac) !== norm(p.lac)) {
                            isMatch = false;
                        }
                    }
                }

                if (isMatch) {
                    targetPoints.push({
                        lat: p.lat,
                        lng: p.lng,
                        color: '#ffff00', // Yellow lines
                        weight: 2,
                        dashArray: '4, 4'
                    });
                }
            });
        });

        if (targetPoints.length > 0) {
            console.log('[Spider] Found ' + targetPoints.length + ' points.');
            window.mapRenderer.drawConnections(startPt, targetPoints);
            fileStatus.textContent = 'Spider: Showing ' + targetPoints.length + ' points for ' + (sector.cellId || sector.sc);
        } else {
            console.warn("[Spider] No matching points found.");
            fileStatus.textContent = 'Spider: No points found for ' + (sector.cellId || sector.sc);
            window.mapRenderer.clearConnections();
        }
    });

    fileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;

        fileStatus.textContent = 'Loading ' + file.name + '...';


        // TRP Zip Import
        if (file.name.toLowerCase().endsWith('.trp')) {
            handleTRPImport(file);
            return;
        }

        // NMFS Binary Check
        if (file.name.toLowerCase().endsWith('.nmfs')) {
            const headerReader = new FileReader();
            headerReader.onload = (event) => {
                const arr = new Uint8Array(event.target.result);
                // ASCII for NMFS is 78 77 70 83 (0x4e 0x4d 0x46 0x53)
                // Check if starts with NMFS
                let isNMFS = false;
                if (arr.length >= 4) {
                    if (arr[0] === 0x4e && arr[1] === 0x4d && arr[2] === 0x46 && arr[3] === 0x53) {
                        isNMFS = true;
                    }
                }

                if (isNMFS) {
                    alert("⚠️ SECURE FILE DETECTED\n\nThis is a proprietary Keysight Nemo 'Secure' Binary file (.nmfs).\n\nThis application can only parse TEXT log files (.nmf or .csv).\n\nPlease open this file in Nemo Outdoor/Analyze and export it as 'Nemo File Format (Text)'.");
                    fileStatus.textContent = 'Error: Encrypted NMFS file.';
                    e.target.value = ''; // Reset
                    return;
                } else {
                    // Fallback: Maybe it's a text file named .nmfs? Try parsing as text.
                    console.warn("File named .nmfs but missing signature. Attempting text parse...");
                    parseTextLog(file);
                }
            };
            headerReader.readAsArrayBuffer(file.slice(0, 10));
            return;
        }

        // Excel / CSV Detection (Binary Read)
        if (file.name.toLowerCase().endsWith('.xlsx') || file.name.toLowerCase().endsWith('.xls')) {
            const reader = new FileReader();
            reader.onload = (event) => {
                try {
                    fileStatus.textContent = 'Parsing Excel...';
                    const data = event.target.result;
                    const result = ExcelParser.parse(data);

                    handleParsedResult(result, file.name);

                } catch (err) {
                    console.error('Excel Parse Error:', err);
                    fileStatus.textContent = 'Error parsing Excel: ' + err.message;
                }
            };
            reader.readAsArrayBuffer(file);
            e.target.value = '';
            return;
        }

        // Standard Text Log
        parseTextLog(file);

        function parseTextLog(f) {
            const reader = new FileReader();
            reader.onload = (event) => {
                const content = event.target.result;
                fileStatus.textContent = 'Parsing...';

                setTimeout(() => {
                    try {
                        const result = NMFParser.parse(content);
                        handleParsedResult(result, f.name);
                    } catch (err) {
                        console.error('Parser Error:', err);
                        fileStatus.textContent = 'Error parsing file: ' + err.message;
                    }
                }, 100);
            };
            reader.readAsText(f);
            e.target.value = '';
        }

        function getRandomColor() {
            const letters = '0123456789ABCDEF';
            let color = '#';
            for (let i = 0; i < 6; i++) {
                color += letters[Math.floor(Math.random() * 16)];
            }
            return color;
        }

        function handleParsedResult(result, fileName) {
            // Handle new parser return format (object vs array)
            const parsedData = Array.isArray(result) ? result : result.points;
            const technology = Array.isArray(result) ? 'Unknown' : result.tech;
            const signalingData = !Array.isArray(result) ? result.signaling : [];
            const eventsData = !Array.isArray(result) ? result.events : [];
            const callSessionsData = !Array.isArray(result) ? (result.callSessions || []) : [];
            const umtsCallAnalysis = !Array.isArray(result) ? (result.umtsCallAnalysis || null) : null;
            const customMetrics = !Array.isArray(result) ? result.customMetrics : []; // New for Excel
            const configData = !Array.isArray(result) ? result.config : null;
            const configHistory = !Array.isArray(result) ? result.configHistory : [];

            // --- AUTO ANALYSIS: Analyze all points immediately ---
            if (window.analyzeSmartCarePoint && parsedData && parsedData.length > 0) {
                console.log("Running Auto-Analysis on " + parsedData.length + " points...");
                parsedData.forEach(p => {
                    // 1. Try Sampling from existing SmartCare Grid
                    let analysis = null;
                    if (window.findNearestSmartCareAnalysis && p.lat && p.lng) {
                        analysis = window.findNearestSmartCareAnalysis(p.lat, p.lng);
                    }

                    // 2. Fallback: Self-Analysis
                    if (!analysis) {
                        analysis = window.analyzeSmartCarePoint(p);
                    }

                    // Comprehensive Result for "Analyze point" column
                    // Comprehensive Result for "Analyze point" column
                    const parts = [];

                    // Always include Status Overview if available
                    if (analysis.status) {
                        const s = analysis.status;
                        const statusSummary = [];
                        if (s.coverage) statusSummary.push(`Coverage: ${s.coverage}`);
                        if (s.signalQuality) statusSummary.push(`Quality: ${s.signalQuality}`);
                        if (s.load && s.load !== 'Normal') statusSummary.push(`Load: ${s.load}`);
                        if (statusSummary.length > 0) parts.push(statusSummary.join(', '));
                    }

                    if (analysis.diagnosis && analysis.diagnosis.length) parts.push("Diagnosis: " + analysis.diagnosis.join(', '));
                    if (analysis.interpretation && analysis.interpretation.length) parts.push("Interpretation: " + analysis.interpretation.join('; '));
                    if (analysis.throughputRootCauses && analysis.throughputRootCauses.length) parts.push("Causes: " + analysis.throughputRootCauses.join('; '));
                    if (analysis.actions && analysis.actions.length) parts.push("Actions: " + analysis.actions.join('; '));

                    const fullResult = parts.length > 0 ? parts.join(' | ') : 'Normal / No Issues Detected';
                    p['Analyze point'] = fullResult;
                });

                // Do not add "Analyze point" to metrics list (hidden from sidebar)
            }

            console.log('Parsed ' + parsedData.length + ' measurement points and ' + (signalingData ? signalingData.length : 0) + ' signaling messages.Tech: ' + technology);

            if (parsedData.length > 0 || (signalingData && signalingData.length > 0)) {
                const id = Date.now().toString();
                const name = fileName.replace(/\.[^/.]+$/, "");
                const defaultMetric = (technology && (technology.toLowerCase().includes('3g') || technology.toLowerCase().includes('umts') || technology.toLowerCase().includes('wcdma')))
                    ? 'EcNo'
                    : 'level';

                // Add to Logs
                loadedLogs.push({
                    id: id,
                    name: name,
                    points: parsedData,
                    signaling: signalingData,
                    events: eventsData,
                    callSessions: callSessionsData,
                    umtsCallAnalysis: umtsCallAnalysis,
                    tech: technology,
                    customMetrics: customMetrics,
                    color: getRandomColor(),
                    visible: false,
                    currentParam: defaultMetric,
                    config: configData,
                    configHistory: configHistory
                });

                if (umtsCallAnalysis && umtsCallAnalysis.summary) {
                    const s = umtsCallAnalysis.summary;
                    console.log('[UMTS Analyzer] Sessions:', s.totalCaaSessions, 'Success:', s.outcomes?.SUCCESS || 0, 'SetupFail:', s.outcomes?.CALL_SETUP_FAILURE || s.outcomes?.SETUP_FAILURE || 0, 'Drop:', s.outcomes?.DROP_CALL || 0);
                }

                // Update UI
                updateLogsList();

                if (parsedData.length > 0) {
                    console.log('[App] Debug First Point:', parsedData[0]);
                    // Keep map empty on import; user will add metrics/events explicitly
                }

                fileStatus.textContent = 'Loaded: ' + name + '(' + parsedData.length + ' pts)';


            } else {
                fileStatus.textContent = 'No valid data found.';
            }
        }
    });

    // Site Import Logic
    const siteInput = document.getElementById('siteInput');
    if (siteInput) {
        siteInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;

            fileStatus.textContent = 'Importing Sites...';

            const reader = new FileReader();
            reader.onload = (event) => {
                try {
                    const data = new Uint8Array(event.target.result);
                    const workbook = XLSX.read(data, { type: 'array' });
                    const firstSheetName = workbook.SheetNames[0];
                    const worksheet = workbook.Sheets[firstSheetName];
                    const json = XLSX.utils.sheet_to_json(worksheet);

                    console.log('Imported Rows:', json.length);

                    if (json.length === 0) {
                        fileStatus.textContent = 'No rows found in Excel.';
                        return;
                    }

                    // Parse Sectors
                    // Try to match common headers
                    // Map needs: lat, lng, azimuth, name, cellId, tech, color
                    const sectors = json.map(row => {
                        // Normalize helper: lowercase, remove ALL non-alphanumeric chars
                        const normalize = (str) => String(str).toLowerCase().replace(/[^a-z0-9]/g, '');
                        const rowKeys = Object.keys(row);

                        const getVal = (possibleNames) => {
                            for (let name of possibleNames) {
                                const target = normalize(name);
                                // Check exact match of normalized keys
                                const foundKey = rowKeys.find(k => normalize(k) === target);
                                if (foundKey) return row[foundKey];
                            }
                            return undefined;
                        };

                        const lat = parseFloat(getVal(['lat', 'latitude', 'lat_decimal']));
                        const lng = parseFloat(getVal(['long', 'lng', 'longitude', 'lon', 'long_decimal']));
                        // Extended Azimuth keywords (including 'azimut' for French)
                        const azimuth = parseFloat(getVal(['azimuth', 'azimut', 'dir', 'bearing', 'az']));
                        const name = getVal(['nodeb name', 'nodeb_name', 'nodebname', 'site', 'sitename', 'site_name', 'name', 'site name']);
                        const cellId = getVal(['cell', 'cellid', 'ci', 'cell_name', 'cell id', 'cell_id']);

                        // New Fields for Strict Matching
                        const lac = getVal(['lac', 'location area code']);
                        const pci = getVal(['psc', 'sc', 'pci', 'physical cell id', 'physcial cell id', 'scrambling code', 'physicalcellid']);
                        const freq = getVal(['downlink uarfcn', 'dl uarfcn', 'uarfcn', 'freq', 'frequency', 'dl freq', 'downlink earfcn', 'dl earfcn', 'earfcn', 'downlinkearfcn']);
                        const band = getVal(['band', 'band name', 'freq band']);

                        // Specific Request: eNodeB ID-Cell ID
                        const enodebCellIdRaw = getVal(['enodeb id-cell id', 'enodebid-cellid', 'enodebidcellid']);

                        let rnc = parseInt(getVal(['rnc', 'rncid', 'rnc_id', 'enodeb', 'enodebid', 'enodeb id', 'enodeb_id']));
                        let cid = parseInt(getVal(['cid', 'c_id', 'ci', 'cell id', 'cell_id', 'cellid']));

                        let calculatedEci = null;
                        if (enodebCellIdRaw) {
                            const parts = String(enodebCellIdRaw).split('-');
                            if (parts.length === 2) {
                                const enb = parseInt(parts[0]);
                                const c = parseInt(parts[1]);
                                if (!isNaN(enb) && !isNaN(c)) {
                                    // Standard LTE ECI Calculation: eNodeB * 256 + CellID
                                    calculatedEci = (enb * 256) + c;

                                    // Fallback: If RNC/CID columns were missing, use these
                                    if (isNaN(rnc)) rnc = enb;
                                    if (isNaN(cid)) cid = c;
                                }
                            }
                        }

                        let tech = getVal(['tech', 'technology', 'system', 'rat']);
                        const cellName = getVal(['cell name', 'cellname']) || '';

                        // Infer Tech from Name if missing
                        if (!tech) {
                            const combinedName = (name + ' ' + cellName).toLowerCase();
                            if (combinedName.includes('4g') || combinedName.includes('lte') || combinedName.includes('earfcn')) tech = '4G';
                            else if (combinedName.includes('3g') || combinedName.includes('umts') || combinedName.includes('wcdma')) tech = '3G';
                            else if (combinedName.includes('2g') || combinedName.includes('gsm')) tech = '2G';
                            else if (combinedName.includes('5g') || combinedName.includes('nr')) tech = '5G';
                        }

                        // Robust Fallback: Attempt to extract RNC from CellID or RawID if still missing
                        if (isNaN(rnc) || !rnc) {
                            const candidates = [String(enodebCellIdRaw), String(cellId), String(name)];
                            for (let c of candidates) {
                                if (c) {
                                    // Check if it's a Big Int (RNC+CID)
                                    const val = parseInt(c);
                                    if (!isNaN(val) && val > 65535) {
                                        rnc = val >> 16;
                                        cid = val & 0xFFFF;
                                        break;
                                    }

                                    if (c.includes('-') || c.includes('/')) {
                                        const parts = c.split(/[-/]/);
                                        if (parts.length === 2) {
                                            const p1 = parseInt(parts[0]);
                                            if (!isNaN(p1) && p1 > 0 && p1 < 65535) {
                                                rnc = p1;
                                                // Also recover CID if missing
                                                if (isNaN(cid)) cid = parseInt(parts[1]);
                                                break;
                                            }
                                        }
                                    }
                                }
                            }
                        }

                        // Determine Color
                        let color = '#3b82f6';
                        if (tech) {
                            const t = tech.toString().toLowerCase();
                            if (t.includes('3g') || t.includes('umts')) color = '#eab308'; // Yellow/Orange
                            if (t.includes('4g') || t.includes('lte')) color = '#3b82f6'; // Blue
                            if (t.includes('2g') || t.includes('gsm')) color = '#ef4444'; // Red
                            if (t.includes('5g') || t.includes('nr')) color = '#a855f7'; // Purple
                        }

                        return {
                            ...row, // Preserve ALL original columns
                            lat, lng, azimuth: isNaN(azimuth) ? 0 : azimuth,
                            name, siteName: name, // Ensure siteName is present
                            cellName,
                            cellId,
                            lac,
                            lac,
                            pci: parseInt(pci), sc: parseInt(pci),
                            freq: parseInt(freq),
                            band,
                            tech,
                            color,
                            rawEnodebCellId: enodebCellIdRaw,
                            calculatedEci: calculatedEci,
                            rnc: isNaN(rnc) ? undefined : rnc,
                            cid: isNaN(cid) ? undefined : cid
                        };
                    })
                    // Filter out invalid
                    const validSectors = sectors.filter(s => s && s.lat && s.lng);

                    if (validSectors.length > 0) {
                        const id = Date.now().toString();
                        const name = file.name.replace(/\.[^/.]+$/, "");

                        console.log('[Sites] Importing ' + validSectors.length + ' sites as layer: ' + name);

                        // Add Layer
                        try {
                            if (window.mapRenderer) {
                                console.log('[Sites] Calling mapRenderer.addSiteLayer...');
                                window.mapRenderer.addSiteLayer(id, name, validSectors, false); // DO NOT FIT BOUNDS
                                console.log('[Sites] addSiteLayer successful. Adding sidebar item...');
                                addSiteLayerToSidebar(id, name, validSectors.length);
                                console.log('[Sites] Sidebar item added.');
                            } else {
                                throw new Error("MapRenderer not initialized");
                            }
                            fileStatus.textContent = 'Sites Imported: ' + validSectors.length + '(' + name + ')';
                        } catch (innerErr) {
                            console.error('[Sites] CRITICAL ERROR adding layer:', innerErr);
                            alert('Error adding site layer: ' + innerErr.message);
                            fileStatus.textContent = 'Error adding layer: ' + innerErr.message;
                        }
                    } else {
                        fileStatus.textContent = 'No valid site data found (check Lat/Lng)';
                    }
                    e.target.value = ''; // Reset input
                } catch (err) {
                    console.error('Site Import Error:', err);
                    fileStatus.textContent = 'Error parsing sites: ' + err.message;
                }
            };
            reader.readAsArrayBuffer(file);
        });
    }

    // --- Site Layer Management UI ---
    window.siteLayersList = []; // Track UI state locally if needed, but renderer is source of truth

    function addSiteLayerToSidebar(id, name, count) {
        const container = document.getElementById('sites-layer-list');
        if (!container) {
            console.error('[Sites] CRITICAL: Sidebar container #sites-layer-list NOT FOUND in DOM.');
            return;
        }

        // AUTO-SHOW SIDEBAR
        const sidebar = document.getElementById('smartcare-sidebar');
        if (sidebar) {
            sidebar.style.display = 'flex';
        }

        const item = document.createElement('div');
        item.className = 'layer-item';
        item.id = 'site-layer-' + id;

        item.innerHTML =
            '<div class="layer-info">' +
            '<span class="layer-name" title="' + name + '" style="font-size:13px;">' + name + '</span>' +
            '</div>' +
            '<div class="layer-controls">' +
            '<button class="layer-btn settings-btn" data-id="' + id + '" title="Layer Settings">⚙️</button>' +
            '<button class="layer-btn visibility-btn" data-id="' + id + '" title="Toggle Visibility">👁️</button>' +
            '<button class="layer-btn remove-btn" data-id="' + id + '" title="Remove Layer">✕</button>' +
            '</div>';


        // Event Listeners
        const settingsBtn = item.querySelector('.settings-btn');
        settingsBtn.onclick = (e) => {
            e.stopPropagation();
            // Open Settings Panel in "Layer Mode"
            const panel = document.getElementById('siteSettingsPanel');
            if (panel) {
                panel.style.display = 'block';
                window.editingLayerId = id; // Set Context

                // Update Title to show we are editing a layer
                const title = panel.querySelector('h3');
                if (title) title.textContent = 'Settings: ' + name;
            }
        };
        const visBtn = item.querySelector('.visibility-btn');
        visBtn.onclick = () => {
            const isVisible = visBtn.style.opacity !== '0.5';
            const newState = !isVisible;

            // UI Toggle
            visBtn.style.opacity = newState ? '1' : '0.5';
            if (!newState) visBtn.textContent = '━';
            else visBtn.textContent = '👁️';

            // Logic Toggle
            if (window.mapRenderer) {
                window.mapRenderer.toggleSiteLayer(id, newState);
            }
        };

        const removeBtn = item.querySelector('.remove-btn');
        removeBtn.onclick = (e) => {
            e.stopPropagation();
            if (confirm('Remove site layer "' + name + '" ? ')) {
                if (window.mapRenderer) {
                    window.mapRenderer.removeSiteLayer(id);
                }
                item.remove();
            }
        };

        container.appendChild(item);
    }

    // Site Settings UI Logic
    const settingsBtn = document.getElementById('siteSettingsBtn');
    const settingsPanel = document.getElementById('siteSettingsPanel');
    const closeSettings = document.getElementById('closeSiteSettings');
    const siteColorBy = document.getElementById('siteColorBy'); // NEW

    if (settingsBtn && settingsPanel) {
        settingsBtn.onclick = () => {
            // Open in "Global Mode"
            window.editingLayerId = null;
            const title = settingsPanel.querySelector('h3');
            if (title) title.textContent = 'Site Settings (Global)';

            settingsPanel.style.display = settingsPanel.style.display === 'none' ? 'block' : 'none';
        };
        closeSettings.onclick = () => settingsPanel.style.display = 'none';

        const updateSiteStyles = () => {
            const range = document.getElementById('rangeSiteDist').value;
            const beam = document.getElementById('rangeIconBeam').value;
            const opacity = document.getElementById('rangeSiteOpacity').value;
            const color = document.getElementById('pickerSiteColor').value;
            const useOverride = document.getElementById('checkSiteColorOverride').checked;
            const showSiteNames = document.getElementById('checkShowSiteNames').checked;
            const showCellNames = document.getElementById('checkShowCellNames').checked;

            const colorBy = siteColorBy ? siteColorBy.value : 'tech';

            // Context-Aware Update
            if (window.editingLayerId) {
                // Layer Specific
                if (map) {
                    map.updateLayerSettings(window.editingLayerId, {
                        range: range,
                        beamwidth: beam,
                        opacity: opacity,
                        color: color,
                        useOverride: useOverride,
                        showSiteNames: showSiteNames,
                        showCellNames: showCellNames
                    });
                }
            } else {
                // Global
                if (map) {
                    map.updateSiteSettings({
                        range: range,
                        beamwidth: beam,
                        opacity: opacity,
                        color: color,
                        useOverride: useOverride,
                        showSiteNames: showSiteNames,
                        showCellNames: showCellNames,
                        colorBy: colorBy
                    });
                }
            }

            document.getElementById('valRange').textContent = range;
            document.getElementById('valBeam').textContent = beam;
            document.getElementById('valOpacity').textContent = opacity;

            if (map) {
                // Logic moved above
            }
        };

        // Listeners for Site Settings
        document.getElementById('rangeSiteDist').addEventListener('input', updateSiteStyles);
        document.getElementById('rangeIconBeam').addEventListener('input', updateSiteStyles);
        document.getElementById('rangeSiteOpacity').addEventListener('input', updateSiteStyles);
        document.getElementById('pickerSiteColor').addEventListener('input', updateSiteStyles);
        document.getElementById('checkSiteColorOverride').addEventListener('change', updateSiteStyles);
        document.getElementById('checkShowSiteNames').addEventListener('change', updateSiteStyles);
        document.getElementById('checkShowCellNames').addEventListener('change', updateSiteStyles);
        if (siteColorBy) siteColorBy.addEventListener('change', updateSiteStyles);

        // Initial sync
        setTimeout(updateSiteStyles, 100);
    }

    // Generic Modal Close
    window.onclick = (event) => {
        if (event.target == document.getElementById('gridModal')) {
            document.getElementById('gridModal').style.display = "none";
        }
        if (event.target == document.getElementById('chartModal')) {
            document.getElementById('chartModal').style.display = "none";
        }
        if (event.target == document.getElementById('signalingModal')) {
            document.getElementById('signalingModal').style.display = "none";
        }
        if (event.target == document.getElementById('callSessionsModal')) {
            document.getElementById('callSessionsModal').style.display = "none";
        }
        if (event.target == document.getElementById('dropAnalysisModal')) {
            document.getElementById('dropAnalysisModal').style.display = "none";
        }
    }


    window.closeSignalingModal = () => {
        document.getElementById('signalingModal').style.display = 'none';
    };



    // Apply to Signaling Modal
    const sigModal = document.getElementById('signalingModal');
    const sigContent = sigModal.querySelector('.modal-content');
    const sigHeader = sigModal.querySelector('.modal-header'); // We need to ensure header exists

    if (sigContent && sigHeader) {
        makeElementDraggable(sigHeader, sigContent);
    }

    window.showSignalingModal = (logId) => {
        console.log('Opening Signaling Modal for Log ID:', logId);
        const log = loadedLogs.find(l => l.id.toString() === logId.toString()); // Ensure string comparison

        if (!log) {
            console.error('Log not found for ID:', logId);
            return;
        }

        currentSignalingLogId = log.id;
        renderSignalingTable();

        // Show modal
        document.getElementById('signalingModal').style.display = 'block';

        // Ensure visibility if it was closed or moved off screen?
        // Reset position if first open? optional.
    };

    window.filterSignaling = () => {
        renderSignalingTable();
    };

    window.closeCallSessionsModal = () => {
        const modal = document.getElementById('callSessionsModal');
        if (modal) modal.style.display = 'none';
    };

    window.closeDropAnalysisModal = () => {
        const modal = document.getElementById('dropAnalysisModal');
        if (modal) modal.style.display = 'none';
    };

    const ensureCallSessionsModal = () => {
        let modal = document.getElementById('callSessionsModal');
        if (modal) return modal;

        modal = document.createElement('div');
        modal.id = 'callSessionsModal';
        modal.className = 'modal';
        modal.style.zIndex = '10030';
        modal.innerHTML =
            '<div class="modal-content" style="max-width:1180px; width:92vw; max-height:88vh; background:#111827; color:#e5e7eb; border:1px solid #334155; display:flex; flex-direction:column;">' +
            '  <div class="modal-header" style="display:flex; justify-content:space-between; align-items:center; padding:10px 14px; border-bottom:1px solid #334155; cursor:move;">' +
            '    <h3 id="callSessionsModalTitle" style="margin:0; font-size:16px;">Call Sessions</h3>' +
            '    <span class="close" style="color:#94a3b8; cursor:pointer; font-size:20px;" onclick="window.closeCallSessionsModal()">&times;</span>' +
            '  </div>' +
            '  <div class="modal-body" style="padding:10px 12px; overflow:auto;">' +
            '    <div style="display:grid; grid-template-columns: minmax(220px, 1fr) 180px 140px 140px; gap:8px; margin-bottom:8px;">' +
            '      <input id="callSessionSearch" placeholder="Search CallID / IMSI / TMSI" style="padding:6px 8px; border:1px solid #334155; border-radius:4px; background:#0f172a; color:#e5e7eb;" oninput="window.filterCallSessions()"/>' +
            '      <select id="callSessionRrcFilter" style="padding:6px 8px; border:1px solid #334155; border-radius:4px; background:#0f172a; color:#e5e7eb;" onchange="window.filterCallSessions()">' +
            '        <option value="ALL">All RRC States</option>' +
            '      </select>' +
            '      <input id="callSessionStartFilter" placeholder="Start >= (HH:MM:SS)" style="padding:6px 8px; border:1px solid #334155; border-radius:4px; background:#0f172a; color:#e5e7eb;" oninput="window.filterCallSessions()"/>' +
            '      <input id="callSessionEndFilter" placeholder="End <= (HH:MM:SS)" style="padding:6px 8px; border:1px solid #334155; border-radius:4px; background:#0f172a; color:#e5e7eb;" oninput="window.filterCallSessions()"/>' +
            '    </div>' +
            '    <div id="callSessionsSummary" style="font-size:11px; color:#93c5fd; margin-bottom:8px;"></div>' +
            '    <table style="width:100%; border-collapse:collapse; font-size:11px;">' +
            '      <thead>' +
            '        <tr style="background:#1e293b;">' +
            '          <th style="text-align:left; padding:6px; border:1px solid #334155;">Session</th>' +
            '          <th style="text-align:left; padding:6px; border:1px solid #334155;">Call/Transaction</th>' +
            '          <th style="text-align:left; padding:6px; border:1px solid #334155;">IMSI / TMSI</th>' +
            '          <th style="text-align:left; padding:6px; border:1px solid #334155;">Start</th>' +
            '          <th style="text-align:left; padding:6px; border:1px solid #334155;">End</th>' +
            '          <th style="text-align:left; padding:6px; border:1px solid #334155;">Duration (s)</th>' +
            '          <th style="text-align:left; padding:6px; border:1px solid #334155;">End Type</th>' +
            '          <th style="text-align:left; padding:6px; border:1px solid #334155;">Failure Reason</th>' +
            '          <th style="text-align:left; padding:6px; border:1px solid #334155;">Drop</th>' +
            '          <th style="text-align:left; padding:6px; border:1px solid #334155;">Setup Failure</th>' +
            '          <th style="text-align:left; padding:6px; border:1px solid #334155;">RRC States</th>' +
            '          <th style="text-align:left; padding:6px; border:1px solid #334155;">RAB</th>' +
            '          <th style="text-align:left; padding:6px; border:1px solid #334155;">Measurements</th>' +
            '        </tr>' +
            '      </thead>' +
            '      <tbody id="callSessionsTableBody"></tbody>' +
            '    </table>' +
            '  </div>' +
            '</div>';

        document.body.appendChild(modal);
        const content = modal.querySelector('.modal-content');
        const header = modal.querySelector('.modal-header');
        if (content && header) makeElementDraggable(header, content);
        return modal;
    };

    const parseSessionTimeToMs = (timeValue) => {
        if (!timeValue) return NaN;
        const txt = String(timeValue).trim();
        const iso = Date.parse(txt);
        if (!Number.isNaN(iso)) return iso;
        const m = txt.match(/^(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/);
        if (!m) return NaN;
        const hh = parseInt(m[1], 10);
        const mm = parseInt(m[2], 10);
        const ss = parseInt(m[3], 10);
        const ms = parseInt((m[4] || '0').padEnd(3, '0'), 10);
        return (((hh * 60 + mm) * 60 + ss) * 1000) + ms;
    };

    const ensureDropAnalysisModal = () => {
        let modal = document.getElementById('dropAnalysisModal');
        if (modal) return modal;

        modal = document.createElement('div');
        modal.id = 'dropAnalysisModal';
        modal.className = 'modal';
        modal.style.zIndex = '10040';
        modal.innerHTML =
            '<div class="modal-content" style="max-width:760px; width:88vw; max-height:84vh; background:#0b1220; color:#e5e7eb; border:1px solid #334155; display:flex; flex-direction:column;">' +
            '  <div class="modal-header" style="display:flex; justify-content:space-between; align-items:center; padding:10px 14px; border-bottom:1px solid #334155; cursor:move;">' +
            '    <h3 id="dropAnalysisTitle" style="margin:0; font-size:16px;">Call Failure Analysis</h3>' +
            '    <span class="close" style="color:#94a3b8; cursor:pointer; font-size:20px;" onclick="window.closeDropAnalysisModal()">&times;</span>' +
            '  </div>' +
            '  <div class="modal-body" id="dropAnalysisBody" style="padding:12px 14px; overflow:auto;"></div>' +
            '</div>';

        document.body.appendChild(modal);
        const content = modal.querySelector('.modal-content');
        const header = modal.querySelector('.modal-header');
        if (content && header) makeElementDraggable(header, content);
        return modal;
    };

    const summarizeDropRadio = (session) => {
        const ms = Array.isArray(session?.radioMeasurementsTimeline) ? session.radioMeasurementsTimeline : [];
        if (ms.length === 0) return 'No radio measurements available near drop.';
        const tail = ms.slice(-8);
        const avg = (arr) => {
            const vals = arr.filter(v => typeof v === 'number' && !Number.isNaN(v));
            if (vals.length === 0) return null;
            return vals.reduce((a, b) => a + b, 0) / vals.length;
        };
        const avgRscp = avg(tail.map(x => x.rscp));
        const avgRsrp = avg(tail.map(x => x.rsrp));
        const avgEcno = avg(tail.map(x => x.ecno));
        const avgRsrq = avg(tail.map(x => x.rsrq));
        const avgRssi = avg(tail.map(x => x.rssi));

        const parts = [];
        if (avgRscp !== null) parts.push('Avg RSCP (last samples): ' + avgRscp.toFixed(1) + ' dBm');
        if (avgRsrp !== null) parts.push('Avg RSRP (last samples): ' + avgRsrp.toFixed(1) + ' dBm');
        if (avgEcno !== null) parts.push('Avg EcNo (last samples): ' + avgEcno.toFixed(1) + ' dB');
        if (avgRsrq !== null) parts.push('Avg RSRQ (last samples): ' + avgRsrq.toFixed(1) + ' dB');
        if (avgRssi !== null) parts.push('Avg RSSI (last samples): ' + avgRssi.toFixed(1) + ' dBm');
        return parts.length ? parts.join('<br>') : 'No usable radio metrics available near drop.';
    };

    const buildDropInsights = (log, session) => {
        const endMs = parseSessionTimeToMs(session?.endTime || session?.startTime);
        const points = Array.isArray(log?.points) ? log.points : [];
        const nearWindow = points.filter(p => {
            const t = parseSessionTimeToMs(p?.time);
            if (Number.isNaN(t) || Number.isNaN(endMs)) return false;
            return Math.abs(t - endMs) <= 30000;
        });
        const beforeDrop = nearWindow.filter(p => {
            const t = parseSessionTimeToMs(p?.time);
            return !Number.isNaN(t) && !Number.isNaN(endMs) && t <= endMs;
        });
        const measurements = beforeDrop.filter(p => p?.type === 'MEASUREMENT');
        const events = nearWindow.filter(p => p?.type === 'EVENT' || p?.event || p?.message);

        const msgOf = (p) => [p?.event, p?.message, p?.properties?.Event, p?.properties?.Message].filter(Boolean).join(' ').toUpperCase();
        const hasEvent = (matcher) => events.some(e => matcher(msgOf(e)));
        const avg = (vals) => {
            const n = vals.filter(v => typeof v === 'number' && !Number.isNaN(v));
            if (!n.length) return null;
            return n.reduce((a, b) => a + b, 0) / n.length;
        };
        const median = (vals) => {
            const n = vals.filter(v => typeof v === 'number' && !Number.isNaN(v)).sort((a, b) => a - b);
            if (!n.length) return null;
            const mid = Math.floor(n.length / 2);
            return n.length % 2 === 0 ? (n[mid - 1] + n[mid]) / 2 : n[mid];
        };
        const num = (v) => {
            const x = parseFloat(v);
            return Number.isNaN(x) ? null : x;
        };

        const recentTail = measurements.slice(-8);
        const avgRscp = avg(recentTail.map(m => num(m?.rscp ?? m?.level ?? m?.properties?.['Serving RSCP'])));
        const avgEcno = avg(recentTail.map(m => num(m?.ecno ?? m?.properties?.['EcNo'] ?? m?.properties?.['Serving EcNo'])));
        const avgUlTx = avg(recentTail.map(m => num(m?.properties?.['UE Tx Power'])));
        const latestUlTx = (() => {
            const last = recentTail[recentTail.length - 1];
            return num(last?.properties?.['UE Tx Power']);
        })();
        const rlfOccurred = String(session?.endTrigger || '').toUpperCase().includes('RADIO_LINK_FAILURE')
            || hasEvent(txt => txt.includes('RLF') || txt.includes('RADIO LINK FAILURE'));

        // 10s pre-drop trend analysis (RSCP / EcNo / UL Tx / BLER/FER)
        const trendWindow = measurements.filter(m => {
            const t = parseSessionTimeToMs(m?.time);
            if (Number.isNaN(t) || Number.isNaN(endMs)) return false;
            return t >= (endMs - 10000) && t <= endMs;
        });
        const series = (extractor) => trendWindow
            .map(m => ({ t: parseSessionTimeToMs(m?.time), v: num(extractor(m)) }))
            .filter(x => !Number.isNaN(x.t) && x.v !== null)
            .sort((a, b) => a.t - b.t);
        const rscpSeries = series(m => m?.rscp ?? m?.level ?? m?.properties?.['Serving RSCP']);
        const ecnoSeries = series(m => m?.ecno ?? m?.properties?.['EcNo'] ?? m?.properties?.['Serving EcNo']);
        const ulTxSeries = series(m => m?.properties?.['UE Tx Power']);
        const blerSeries = series(m => m?.bler_dl ?? m?.properties?.['BLER DL'] ?? m?.bler_ul ?? m?.properties?.['BLER UL']);
        const ferSeries = series(m => m?.fer_dl ?? m?.properties?.['FER DL'] ?? m?.fer_ul ?? m?.properties?.['FER UL'] ?? m?.properties?.['FER']);
        const freqSeries = series(m => m?.freq ?? m?.properties?.['Freq']);
        const buildServingLabel = (m) => {
            const name = String(m?.serving_cell_name || m?.properties?.['Serving Cell Name'] || m?.properties?.['serving_cell_name'] || m?.properties?.['Serving Cell'] || '').trim();
            if (name) return name;
            const rnc = m?.rnc ?? m?.properties?.['RNC'];
            const cid = m?.cid ?? m?.properties?.['CID'] ?? m?.properties?.['Cell ID'];
            if (rnc !== undefined && rnc !== null && cid !== undefined && cid !== null && String(rnc) !== 'N/A' && String(cid) !== 'N/A') {
                return String(rnc) + '/' + String(cid);
            }
            const sc = m?.sc ?? m?.properties?.['Serving SC'] ?? m?.properties?.['SC'];
            const fq = m?.freq ?? m?.properties?.['Freq'];
            if (sc !== undefined && sc !== null && fq !== undefined && fq !== null && String(sc) !== 'N/A' && String(fq) !== 'N/A') {
                return String(sc) + '/' + String(fq);
            }
            return '';
        };

        const cellNameSeries = trendWindow
            .map(m => ({
                t: parseSessionTimeToMs(m?.time),
                v: buildServingLabel(m)
            }))
            .filter(x => !Number.isNaN(x.t) && x.v)
            .sort((a, b) => a.t - b.t);

        const markerEvents10s = nearWindow
            .map(p => {
                const t = parseSessionTimeToMs(p?.time);
                if (Number.isNaN(t) || Number.isNaN(endMs) || t < (endMs - 10000) || t > endMs) return null;
                const txt = [p?.event, p?.message, p?.properties?.Event, p?.properties?.Message].filter(Boolean).join(' ').toUpperCase();
                if (txt.includes('RLF') || txt.includes('RADIO LINK FAILURE')) return { t, label: 'RLF' };
                if (txt.includes('HOF') || txt.includes('HANDOVER FAILURE') || txt.includes('HO FAILURE')) return { t, label: 'HOF' };
                return null;
            })
            .filter(Boolean);

        const trendDrop = (s) => (s.length >= 2 ? (s[s.length - 1].v - s[0].v) : null);
        const ratioDecreasing = (s) => {
            if (s.length < 2) return null;
            let dec = 0;
            for (let i = 1; i < s.length; i++) if (s[i].v < s[i - 1].v) dec++;
            return dec / (s.length - 1);
        };
        const rscpDrop10s = trendDrop(rscpSeries);
        const ecnoDrop10s = trendDrop(ecnoSeries);
        const rscpContinuouslyDropping = ratioDecreasing(rscpSeries) !== null && ratioDecreasing(rscpSeries) >= 0.7 && rscpDrop10s !== null && rscpDrop10s <= -3;
        const ecnoContinuouslyDropping = ratioDecreasing(ecnoSeries) !== null && ratioDecreasing(ecnoSeries) >= 0.7 && ecnoDrop10s !== null && ecnoDrop10s <= -2;

        const latestRscp = rscpSeries.length ? rscpSeries[rscpSeries.length - 1].v : null;
        const latestEcno = ecnoSeries.length ? ecnoSeries[ecnoSeries.length - 1].v : null;
        const suddenCellEdgeBehavior = rscpDrop10s !== null && rscpDrop10s <= -8 && latestRscp !== null && latestRscp < -95;
        const goodRscpBadEcno = latestRscp !== null && latestRscp >= -90 && latestEcno !== null && latestEcno < -14;
        const bothBad = latestRscp !== null && latestRscp < -95 && latestEcno !== null && latestEcno < -14;

        const ulLimited = (latestUlTx !== null && latestUlTx > 21) || (avgUlTx !== null && avgUlTx > 21);

        const blerStart = blerSeries.length ? blerSeries[0].v : null;
        const blerEnd = blerSeries.length ? blerSeries[blerSeries.length - 1].v : null;
        const blerMedian = median(blerSeries.map(x => x.v));
        const blerMax = blerSeries.length ? Math.max(...blerSeries.map(x => x.v)) : null;
        const risingBler = blerStart !== null && blerEnd !== null && (blerEnd - blerStart) >= 3 && blerEnd >= 5;
        const blerSpike = blerMedian !== null && blerMax !== null && (blerMax - blerMedian) >= 5;

        const ferStart = ferSeries.length ? ferSeries[0].v : null;
        const ferEnd = ferSeries.length ? ferSeries[ferSeries.length - 1].v : null;
        const ferMedian = median(ferSeries.map(x => x.v));
        const ferMax = ferSeries.length ? Math.max(...ferSeries.map(x => x.v)) : null;
        const risingFer = ferStart !== null && ferEnd !== null && (ferEnd - ferStart) >= 3 && ferEnd >= 5;
        const ferSpike = ferMedian !== null && ferMax !== null && (ferMax - ferMedian) >= 5;

        let lastHoMs = null;
        beforeDrop.forEach(p => {
            const txt = msgOf(p);
            if (txt.includes('HO COMMAND') || txt.includes('HO COMPLETION') || txt.includes('HANDOVER')) {
                const t = parseSessionTimeToMs(p.time);
                if (!Number.isNaN(t) && (lastHoMs === null || t > lastHoMs)) lastHoMs = t;
            }
        });
        const dropAfterHoSec = (lastHoMs !== null && !Number.isNaN(endMs)) ? ((endMs - lastHoMs) / 1000) : null;
        const dropWithin5sAfterHo = dropAfterHoSec !== null && dropAfterHoSec >= 0 && dropAfterHoSec < 5;
        const hoFailure = hasEvent(txt => txt.includes('HO FAILURE') || txt.includes('HOF') || txt.includes('HANDOVER FAILURE'));
        const interRatHoFailure = hasEvent(txt => (txt.includes('INTER-RAT') || txt.includes('IRAT')) && txt.includes('HO') && txt.includes('FAIL'));

        const rabReleaseResource = String(session?.endTrigger || '').toUpperCase().includes('RAB_RELEASE')
            || hasEvent(txt => txt.includes('RAB RELEASE') && txt.includes('RESOURCE'));
        const iuReleaseNoResource = String(session?.endTrigger || '').toUpperCase().includes('IU_RELEASE')
            || hasEvent(txt => txt.includes('IU RELEASE') && txt.includes('NO RESOURCE'));

        let suddenPowerOrCodeReduction = false;
        if (measurements.length >= 2) {
            const first = measurements[Math.max(0, measurements.length - 8)];
            const last = measurements[measurements.length - 1];
            const firstTx = num(first?.properties?.['UE Tx Power']);
            const lastTx = num(last?.properties?.['UE Tx Power']);
            const firstAs = num(first?.as_size ?? first?.properties?.['Active Set Size']);
            const lastAs = num(last?.as_size ?? last?.properties?.['Active Set Size']);
            if (firstTx !== null && lastTx !== null && (firstTx - lastTx) >= 5) suddenPowerOrCodeReduction = true;
            if (firstAs !== null && lastAs !== null && (firstAs - lastAs) >= 1) suddenPowerOrCodeReduction = true;
        }

        const mscInitiatedIuRelease = String(session?.endTrigger || '').toUpperCase().includes('MSC_RELEASE_WITHOUT_DISCONNECT')
            || hasEvent(txt => txt.includes('MSC') && txt.includes('IU RELEASE'));
        const goodRadioBeforeDrop = (avgRscp !== null && avgEcno !== null && avgRscp >= -95 && avgEcno >= -14);

        const radioPoor = (
            (avgRscp !== null && avgRscp < -95) ||
            (avgEcno !== null && avgEcno < -14) ||
            (avgUlTx !== null && avgUlTx > 21)
        );
        const recentHoInstability = dropWithin5sAfterHo || hoFailure || interRatHoFailure;

        const radioFindings = [];
        if (avgRscp !== null && avgRscp < -95) radioFindings.push('RSCP below threshold (' + avgRscp.toFixed(1) + ' dBm < -95 dBm)');
        if (avgEcno !== null && avgEcno < -14) radioFindings.push('Ec/No below threshold (' + avgEcno.toFixed(1) + ' dB < -14 dB)');
        if (avgUlTx !== null && avgUlTx > 21) radioFindings.push('UL Tx Power high (' + avgUlTx.toFixed(1) + ' dBm > 21 dBm)');
        if (rlfOccurred && radioPoor && !recentHoInstability) {
            radioFindings.push('RLF with poor radio and no recent HO instability');
        }
        if (rscpContinuouslyDropping) radioFindings.push('RSCP continuously dropping during last 10s');
        if (ecnoContinuouslyDropping) radioFindings.push('Ec/No continuously dropping during last 10s');
        if (suddenCellEdgeBehavior) radioFindings.push('Sudden cell-edge behavior detected (fast RSCP decay)');
        if (goodRscpBadEcno) radioFindings.push('Pattern: good RSCP + bad Ec/No -> likely interference');
        if (bothBad) radioFindings.push('Pattern: both RSCP and Ec/No poor -> weak coverage');
        if (ulLimited) radioFindings.push('Uplink-limited condition (UL Tx > 21 dBm)');
        if (risingBler || risingFer) radioFindings.push('Rising BLER/FER before drop -> radio instability');
        if (blerSpike || ferSpike) radioFindings.push('Sudden BLER/FER spike -> fast fading/interference');

        const mobilityFindings = [];
        if (dropWithin5sAfterHo) mobilityFindings.push('Drop occurred ' + dropAfterHoSec.toFixed(1) + ' s after HO');
        if (hoFailure) mobilityFindings.push('Handover failure event detected');
        if (interRatHoFailure) mobilityFindings.push('Inter-RAT HO failure detected');

        const congestionFindings = [];
        if (rabReleaseResource) congestionFindings.push('RAB release/resource indicator detected');
        if (iuReleaseNoResource) congestionFindings.push('IU release/no-resource indicator detected');
        if (suddenPowerOrCodeReduction) congestionFindings.push('Sudden power/code reduction pattern detected');

        const coreFindings = [];
        const coreEligible = mscInitiatedIuRelease && goodRadioBeforeDrop && !recentHoInstability;
        if (coreEligible) {
            coreFindings.push('MSC/IU release present with good radio and no HO instability');
        }

        const radioValues = {
            avgRscp: avgRscp,
            avgEcno: avgEcno,
            avgUlTx: avgUlTx,
            latestUlTx: latestUlTx,
            rlfOccurred: rlfOccurred,
            rscpDrop10s: rscpDrop10s,
            ecnoDrop10s: ecnoDrop10s,
            rscpContinuouslyDropping: rscpContinuouslyDropping,
            ecnoContinuouslyDropping: ecnoContinuouslyDropping,
            suddenCellEdgeBehavior: suddenCellEdgeBehavior,
            goodRscpBadEcno: goodRscpBadEcno,
            bothBad: bothBad,
            ulLimited: ulLimited,
            risingBler: risingBler,
            blerSpike: blerSpike,
            risingFer: risingFer,
            ferSpike: ferSpike,
            blerEnd: blerEnd,
            ferEnd: ferEnd,
            rscpSeries10s: rscpSeries.map(p => ({ t: p.t, v: p.v })),
            ecnoSeries10s: ecnoSeries.map(p => ({ t: p.t, v: p.v })),
            freqSeries10s: freqSeries.map(p => ({ t: p.t, v: p.v })),
            cellNameSeries10s: cellNameSeries.map(p => ({ t: p.t, v: p.v })),
            markerEvents10s: markerEvents10s
        };
        const mobilityValues = {
            dropAfterHoSec: dropAfterHoSec,
            dropWithin5sAfterHo: dropWithin5sAfterHo,
            hoFailure: hoFailure,
            interRatHoFailure: interRatHoFailure
        };
        const congestionValues = {
            rabReleaseResource: rabReleaseResource,
            iuReleaseNoResource: iuReleaseNoResource,
            suddenPowerOrCodeReduction: suddenPowerOrCodeReduction
        };
        const coreValues = {
            mscInitiatedIuRelease: mscInitiatedIuRelease,
            goodRadioBeforeDrop: goodRadioBeforeDrop
        };

        return {
            radioFindings,
            mobilityFindings,
            congestionFindings,
            coreFindings,
            values: {
                radio: radioValues,
                mobility: mobilityValues,
                congestion: congestionValues,
                core: coreValues
            },
            scores: {
                radio: radioFindings.length,
                mobility: mobilityFindings.length,
                congestion: congestionFindings.length,
                core: coreFindings.length
            },
            flags: {
                radioPoor,
                recentHoInstability,
                coreEligible,
                mobilityOverride: dropWithin5sAfterHo
            }
        };
    };

    const renderInsightBlock = (title, findings, explanation, valueLines, extraHtml) => {
        const has = Array.isArray(findings) && findings.length > 0;
        const status = has ? '<span style="color:#fca5a5;">Matched</span>' : '<span style="color:#86efac;">No strong indicator</span>';
        const details = has
            ? findings.map(x => '<div style="margin-bottom:4px;">- ' + x + '</div>').join('')
            : '<div style="color:#9ca3af;">No explicit signal found in this category around drop time.</div>';
        const valuesHtml = Array.isArray(valueLines) && valueLines.length
            ? valueLines.map(v => '<div style="margin-bottom:2px;">' + v + '</div>').join('')
            : '<div style="color:#9ca3af;">No values available.</div>';
        return '' +
            '<div style="padding:8px; background:#111827; border:1px solid #334155; border-radius:6px; margin-bottom:8px;">' +
            '  <div style="font-size:12px; font-weight:600; color:#bfdbfe; margin-bottom:6px;">' + title + ' - ' + status + '</div>' +
            '  <div style="font-size:12px; color:#9ca3af; margin-bottom:6px;">' + (explanation || '') + '</div>' +
            (extraHtml ? ('  <div style="margin-bottom:8px;">' + extraHtml + '</div>') : '') +
            '  <div style="font-size:12px; color:#cbd5e1; margin-bottom:6px;">' + valuesHtml + '</div>' +
            '  <div style="font-size:12px; color:#d1d5db;">' + details + '</div>' +
            '</div>';
    };

    const deriveDropRootCause = (insights) => {
        const scores = insights?.scores || { radio: 0, mobility: 0, congestion: 0, core: 0 };
        const domains = [
            { key: 'radio', label: 'Radio Coverage / Quality', actions: ['Check coverage holes (RSCP), interference (Ec/No), and UL budget near drop area.', 'Audit UL power control and pilot pollution around serving/neighbor cells.'] },
            { key: 'mobility', label: 'Mobility', actions: ['Audit HO thresholds/hysteresis/TTT and neighbor definitions on serving/target cells.', 'Review inter-RAT mobility parameters and missing neighbors for the route segment.'] },
            { key: 'congestion', label: 'Congestion', actions: ['Check RAB/Iu resource counters and admission control at drop timestamp.', 'Review code/power utilization and sudden channel resource reductions.'] },
            { key: 'core', label: 'Core Network', actions: ['Investigate MSC/Iu traces for release origin and reject causes.', 'Validate core signaling continuity despite good radio context.'] }
        ];

        if (insights?.flags?.mobilityOverride) {
            const mobility = domains.find(d => d.key === 'mobility');
            return {
                topDomain: mobility.label,
                confidence: 90,
                summary: 'Mobility override: drop occurred within 5s of HO, so mobility is prioritized.',
                recommendations: mobility.actions
            };
        }
        domains.sort((a, b) => (scores[b.key] || 0) - (scores[a.key] || 0));
        const top = domains[0];
        const second = domains[1];
        const topScore = scores[top.key] || 0;
        const secondScore = scores[second.key] || 0;
        const total = (scores.radio || 0) + (scores.mobility || 0) + (scores.congestion || 0) + (scores.core || 0);
        const confidence = topScore === 0 ? 0 : Math.min(95, Math.max(35, Math.round((topScore / Math.max(1, total)) * 100 + (topScore - secondScore) * 8)));
        const summary = topScore === 0
            ? 'No dominant root-cause signal. More signaling/radio context is needed.'
            : 'Most likely domain: ' + top.label + '.';
        return {
            topDomain: topScore > 0 ? top.label : 'Undetermined',
            confidence,
            summary,
            recommendations: top.actions
        };
    };

    const buildMiniTrendSvg = (rscpSeries, ecnoSeries, freqSeries, cellNameSeries, markerEvents, options) => {
        const opts = options || {};
        const finalEventLabel = String(opts.finalEventLabel || 'DROP');
        const endTickLabel = String(opts.endTickLabel || '0s(drop)');
        const showDefaultFinalMarker = opts.showDefaultFinalMarker !== false;
        const zoomFactor = Number.isFinite(Number(opts.zoomFactor)) ? Math.max(1, Number(opts.zoomFactor)) : 1;
        const requestedPanMs = Number.isFinite(Number(opts.panMs)) ? Math.max(0, Number(opts.panMs)) : 0;
        const rAll = Array.isArray(rscpSeries) ? rscpSeries.filter(p => typeof p?.t === 'number' && typeof p?.v === 'number') : [];
        const eAll = Array.isArray(ecnoSeries) ? ecnoSeries.filter(p => typeof p?.t === 'number' && typeof p?.v === 'number') : [];
        const fAll = Array.isArray(freqSeries) ? freqSeries.filter(p => typeof p?.t === 'number' && typeof p?.v === 'number') : [];
        const nAll = Array.isArray(cellNameSeries) ? cellNameSeries.filter(p => typeof p?.t === 'number' && typeof p?.v === 'string' && p.v.trim()) : [];
        const mAll = Array.isArray(markerEvents) ? markerEvents.filter(ev => ev && typeof ev.t === 'number' && Number.isFinite(ev.t)) : [];
        if (!rAll.length && !eAll.length) {
            return '<div style="font-size:11px; color:#9ca3af;">No RSCP/EcNo samples in last 10s.</div>';
        }

        const width = 560;
        const height = 160;
        const padL = 38;
        const padR = 38;
        const padT = 14;
        const padB = 24;
        const plotW = width - padL - padR;
        const plotH = height - padT - padB;

        const allTimesRaw = rAll.concat(eAll).concat(fAll).concat(nAll).map(p => p.t);
        const rawMin = Math.min(...allTimesRaw);
        const rawMax = Math.max(...allTimesRaw);
        const rawSpan = Math.max(1, rawMax - rawMin);
        const visibleSpan = rawSpan / zoomFactor;
        const maxPanMs = Math.max(0, rawSpan - visibleSpan);
        const panMs = Math.max(0, Math.min(maxPanMs, requestedPanMs));
        const visMax = rawMax - panMs;
        const visMin = visMax - visibleSpan;
        const inWindow = (t) => t >= visMin && t <= visMax;

        const r = rAll.filter(p => inWindow(p.t));
        const e = eAll.filter(p => inWindow(p.t));
        const f = fAll.filter(p => inWindow(p.t));
        const n = nAll.filter(p => inWindow(p.t));
        const markerFiltered = mAll.filter(ev => inWindow(ev.t));

        const allTimes = r.concat(e).concat(f).concat(n).map(p => p.t);
        if (!allTimes.length) return '<div style="font-size:11px; color:#9ca3af;">No samples in zoomed window.</div>';
        const tMin = Math.min(...allTimes);
        const tMax = Math.max(...allTimes);
        const tSpan = Math.max(1, tMax - tMin);

        const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
        const xAt = (t) => padL + ((t - tMin) / tSpan) * plotW;
        const yRscp = (v) => {
            const minV = -120;
            const maxV = -60;
            const n = (clamp(v, minV, maxV) - minV) / (maxV - minV);
            return padT + (1 - n) * plotH;
        };
        const yEcno = (v) => {
            const minV = -24;
            const maxV = 0;
            const n = (clamp(v, minV, maxV) - minV) / (maxV - minV);
            return padT + (1 - n) * plotH;
        };

        const pathFrom = (series, yFn) => {
            if (!series.length) return '';
            return series.map((p, i) => (i === 0 ? 'M ' : ' L ') + xAt(p.t).toFixed(1) + ' ' + yFn(p.v).toFixed(1)).join('');
        };

        const gridLines = [0.25, 0.5, 0.75].map(fr => {
            const y = (padT + fr * plotH).toFixed(1);
            return '<line x1="' + padL + '" y1="' + y + '" x2="' + (width - padR) + '" y2="' + y + '" stroke="#334155" stroke-width="1" />';
        }).join('');

        const axis =
            '<line x1="' + padL + '" y1="' + padT + '" x2="' + padL + '" y2="' + (height - padB) + '" stroke="#64748b" stroke-width="1"/>' +
            '<line x1="' + (width - padR) + '" y1="' + padT + '" x2="' + (width - padR) + '" y2="' + (height - padB) + '" stroke="#64748b" stroke-width="1"/>' +
            '<line x1="' + padL + '" y1="' + (height - padB) + '" x2="' + (width - padR) + '" y2="' + (height - padB) + '" stroke="#64748b" stroke-width="1"/>';

        const rscpPath = pathFrom(r, yRscp);
        const ecnoPath = pathFrom(e, yEcno);
        const dropX = (width - padR);
        const rLast = r.length ? r[r.length - 1] : null;
        const eLast = e.length ? e[e.length - 1] : null;
        const windowSec = tSpan / 1000;
        const t0 = (r.length || e.length) ? ('-' + (windowSec >= 10 ? Math.round(windowSec) : windowSec.toFixed(1)) + 's') : '';
        const t1 = endTickLabel;

        const nameAtTime = (t) => {
            let last = null;
            for (let i = 0; i < n.length; i++) {
                if (n[i].t <= t) last = n[i].v;
                else break;
            }
            return last;
        };

        const segments = [];
        if (f.length || n.length) {
            const tPoints = Array.from(new Set((f.map(x => x.t)).concat(n.map(x => x.t)).sort((a, b) => a - b)));
            let currentFreq = f.length ? f[0].v : null;
            let segStart = tPoints[0];
            let currentName = nameAtTime(segStart);

            for (let i = 0; i < tPoints.length; i++) {
                const t = tPoints[i];
                const fAt = (() => {
                    let last = currentFreq;
                    for (let j = 0; j < f.length; j++) {
                        if (f[j].t <= t) last = f[j].v;
                        else break;
                    }
                    return last;
                })();
                const nAt = nameAtTime(t);

                if (i > 0 && (fAt !== currentFreq || nAt !== currentName)) {
                    segments.push({ t0: segStart, t1: tPoints[i - 1], freq: currentFreq, name: currentName });
                    segStart = t;
                    currentFreq = fAt;
                    currentName = nAt;
                } else {
                    currentFreq = fAt;
                    currentName = nAt;
                }
            }
            const endT = tPoints[tPoints.length - 1];
            if (segStart !== undefined && endT !== undefined) {
                segments.push({ t0: segStart, t1: endT, freq: currentFreq, name: currentName });
            }
        } else {
            segments.push({ t0: tMin, t1: tMax, freq: null, name: null });
        }
        const freqPalette = ['#22d3ee', '#38bdf8', '#60a5fa', '#818cf8', '#a78bfa', '#34d399', '#f59e0b'];
        const freqColor = (freq) => {
            const idx = Math.abs(Math.round(freq)) % freqPalette.length;
            return freqPalette[idx];
        };
        const freqBandY = height - padB + 5;
        const freqBandH = 8;
        const labelShort = (txt) => {
            if (!txt) return '';
            const t = String(txt);
            return t.length > 16 ? (t.slice(0, 16) + '...') : t;
        };
        const freqBands = segments.map(seg => {
            const x0 = xAt(seg.t0);
            const x1 = xAt(seg.t1);
            const w = Math.max(2, x1 - x0);
            const c = freqColor(seg.freq || 0);
            const label = seg.name || (seg.freq !== null ? String(seg.freq) : '');
            return '<rect x="' + x0.toFixed(1) + '" y="' + freqBandY + '" width="' + w.toFixed(1) + '" height="' + freqBandH + '" fill="' + c + '" opacity="0.9" />' +
                (label ? '<text x="' + (x0 + 2).toFixed(1) + '" y="' + (freqBandY - 2) + '" font-size="9" fill="' + c + '">' + labelShort(label) + '</text>' : '');
        }).join('');
        const freqTransitions = [];
        for (let i = 1; i < segments.length; i++) {
            const x = xAt(segments[i].t0);
            freqTransitions.push('<line x1="' + x.toFixed(1) + '" y1="' + padT + '" x2="' + x.toFixed(1) + '" y2="' + (height - padB) + '" stroke="#22d3ee" stroke-width="1" stroke-dasharray="2 2" />');
        }
        const topNameLabels = segments.map(seg => {
            if (!seg.name) return '';
            const xMid = (xAt(seg.t0) + xAt(seg.t1)) / 2;
            return '<text x="' + xMid.toFixed(1) + '" y="' + (padT - 4) + '" text-anchor="middle" font-size="10" fill="#e2e8f0">' + labelShort(seg.name) + '</text>';
        }).join('');
        const preparedMarkers = markerFiltered
            .filter(ev => ev && typeof ev.t === 'number' && Number.isFinite(ev.t))
            .map(ev => ({
                t: ev.t,
                label: String(ev.label || ''),
                shortLabel: String(ev.shortLabel || ev.label || ''),
                color: String(ev.color || '#ef4444')
            }))
            .sort((a, b) => a.t - b.t);
        let lastBaseX = -Infinity;
        let overlapRun = 0;
        const markerLines = preparedMarkers.map((ev) => {
            const baseX = xAt(ev.t);
            if (Math.abs(baseX - lastBaseX) < 20) overlapRun += 1;
            else overlapRun = 0;
            lastBaseX = baseX;

            const shiftedX = clamp(baseX - overlapRun * 16, padL + 2, width - padR - 2);
            const labelY = padT + 10 + ((overlapRun % 2) * 11);
            const text = ev.shortLabel || ev.label || 'MARK';
            const chipW = clamp((text.length * 6) + 8, 24, 72);
            const chipX = clamp(shiftedX - (chipW / 2), padL + 2, width - padR - chipW - 2);
            const chipY = labelY - 8;

            return '' +
                '<line x1="' + shiftedX.toFixed(1) + '" y1="' + padT + '" x2="' + shiftedX.toFixed(1) + '" y2="' + (height - padB) + '" stroke="' + ev.color + '" stroke-width="1.7" stroke-dasharray="4 3" />' +
                '<rect x="' + chipX.toFixed(1) + '" y="' + chipY.toFixed(1) + '" width="' + chipW.toFixed(1) + '" height="12" rx="4" ry="4" fill="rgba(15,23,42,0.92)" stroke="' + ev.color + '" stroke-width="1" />' +
                '<text x="' + (chipX + 4).toFixed(1) + '" y="' + (labelY + 1).toFixed(1) + '" font-size="9" fill="' + ev.color + '">' + text + '</text>';
        }).join('');

        return '' +
            '<svg viewBox="0 0 ' + width + ' ' + height + '" width="100%" height="160" style="display:block; background:#0f172a; border:1px solid #334155; border-radius:6px;">' +
            gridLines +
            axis +
            freqTransitions.join('') +
            markerLines +
            (showDefaultFinalMarker ? ('<line x1="' + dropX + '" y1="' + padT + '" x2="' + dropX + '" y2="' + (height - padB) + '" stroke="#ef4444" stroke-width="1.5" stroke-dasharray="4 3" />') : '') +
            (rscpPath ? '<path d="' + rscpPath + '" fill="none" stroke="#22c55e" stroke-width="2" />' : '') +
            (ecnoPath ? '<path d="' + ecnoPath + '" fill="none" stroke="#f59e0b" stroke-width="2" />' : '') +
            (rLast ? ('<circle cx="' + xAt(rLast.t).toFixed(1) + '" cy="' + yRscp(rLast.v).toFixed(1) + '" r="3.5" fill="#22c55e" stroke="#0f172a" stroke-width="1" />') : '') +
            (eLast ? ('<circle cx="' + xAt(eLast.t).toFixed(1) + '" cy="' + yEcno(eLast.v).toFixed(1) + '" r="3.5" fill="#f59e0b" stroke="#0f172a" stroke-width="1" />') : '') +
            freqBands +
            topNameLabels +
            (showDefaultFinalMarker ? ('<text x="' + (dropX - 56) + '" y="' + (padT - 2) + '" font-size="10" fill="#fca5a5">' + finalEventLabel + '</text>') : '') +
            '<text x="' + (padL - 32) + '" y="' + (padT + 10) + '" font-size="10" fill="#86efac">RSCP</text>' +
            '<text x="' + (width - padR + 6) + '" y="' + (padT + 10) + '" font-size="10" fill="#fcd34d">EcNo</text>' +
            '<text x="' + padL + '" y="' + (height - padB + 20) + '" font-size="10" fill="#67e8f9">Serving Freq timeline</text>' +
            '<text x="' + padL + '" y="' + (height - 6) + '" font-size="10" fill="#94a3b8">' + t0 + '</text>' +
            '<text x="' + (width - padR - 42) + '" y="' + (height - 6) + '" font-size="10" fill="#94a3b8">' + t1 + '</text>' +
            '<circle cx="' + (padL + 8) + '" cy="' + (padT + 10) + '" r="3" fill="#22c55e"/>' +
            '<text x="' + (padL + 16) + '" y="' + (padT + 13) + '" font-size="10" fill="#cbd5e1">RSCP</text>' +
            '<circle cx="' + (padL + 72) + '" cy="' + (padT + 10) + '" r="3" fill="#f59e0b"/>' +
            '<text x="' + (padL + 80) + '" y="' + (padT + 13) + '" font-size="10" fill="#cbd5e1">EcNo</text>' +
            '</svg>';
    };

    const buildZoomableMiniTrend = (svgHtml, chartKey, chartPayload) => {
        const id = `miniChart_${String(chartKey || Date.now()).replace(/[^a-zA-Z0-9_-]/g, '_')}`;
        const payloadEnc = chartPayload ? encodeURIComponent(JSON.stringify(chartPayload)) : '';
        return '' +
            '<div class="mini-chart-zoom-wrap" data-chart-id="' + id + '" data-chart-payload="' + payloadEnc + '" style="margin-top:6px;">' +
            '  <div style="display:flex; align-items:center; justify-content:flex-end; gap:6px; margin-bottom:6px;">' +
            '    <button class="btn-mini-chart-pan" data-op="left" data-target="' + id + '" onclick="window.__miniChartPan && window.__miniChartPan(\'' + id + '\', \'left\'); return false;" style="background:#0b1220; border:1px solid #334155; color:#cbd5e1; padding:2px 8px; border-radius:6px; cursor:pointer; font-size:11px;">◀</button>' +
            '    <button class="btn-mini-chart-pan" data-op="right" data-target="' + id + '" onclick="window.__miniChartPan && window.__miniChartPan(\'' + id + '\', \'right\'); return false;" style="background:#0b1220; border:1px solid #334155; color:#cbd5e1; padding:2px 8px; border-radius:6px; cursor:pointer; font-size:11px;">▶</button>' +
            '    <button class="btn-mini-chart-zoom" data-op="out" data-target="' + id + '" onclick="window.__miniChartZoom && window.__miniChartZoom(\'' + id + '\', \'out\'); return false;" style="background:#0b1220; border:1px solid #334155; color:#cbd5e1; padding:2px 8px; border-radius:6px; cursor:pointer; font-size:11px;">-</button>' +
            '    <button class="btn-mini-chart-zoom" data-op="reset" data-target="' + id + '" onclick="window.__miniChartZoom && window.__miniChartZoom(\'' + id + '\', \'reset\'); return false;" style="background:#0b1220; border:1px solid #334155; color:#cbd5e1; padding:2px 8px; border-radius:6px; cursor:pointer; font-size:11px;">100%</button>' +
            '    <button class="btn-mini-chart-zoom" data-op="in" data-target="' + id + '" onclick="window.__miniChartZoom && window.__miniChartZoom(\'' + id + '\', \'in\'); return false;" style="background:#0b1220; border:1px solid #334155; color:#cbd5e1; padding:2px 8px; border-radius:6px; cursor:pointer; font-size:11px;">+</button>' +
            '  </div>' +
            '  <div class="mini-chart-scroll" style="overflow:auto; border-radius:6px; cursor:grab;">' +
            '    <div id="' + id + '" class="mini-chart-stage" data-zoom="1" data-pan-ms="0" style="min-width:560px;">' + svgHtml + '</div>' +
            '  </div>' +
            '</div>';
    };

    const getMiniChartRawSpanMs = (payload) => {
        const series = []
            .concat(Array.isArray(payload?.rscpSeries) ? payload.rscpSeries : [])
            .concat(Array.isArray(payload?.ecnoSeries) ? payload.ecnoSeries : [])
            .concat(Array.isArray(payload?.freqSeries) ? payload.freqSeries : [])
            .concat(Array.isArray(payload?.cellNameSeries) ? payload.cellNameSeries : []);
        const times = series.map(p => Number(p?.t)).filter(Number.isFinite);
        if (!times.length) return 0;
        return Math.max(1, Math.max(...times) - Math.min(...times));
    };

    const clampMiniChartPanMs = (payload, zoomFactor, panMs) => {
        const rawSpan = getMiniChartRawSpanMs(payload);
        if (!Number.isFinite(rawSpan) || rawSpan <= 0) return 0;
        const visible = rawSpan / Math.max(1, zoomFactor);
        const maxPan = Math.max(0, rawSpan - visible);
        return Math.max(0, Math.min(maxPan, Number.isFinite(panMs) ? panMs : 0));
    };

    const rerenderMiniChartStage = (stage) => {
        if (!stage) return;
        const wrap = stage.closest('.mini-chart-zoom-wrap');
        if (!wrap) return;
        const payloadTxt = wrap.getAttribute('data-chart-payload') || '';
        if (!payloadTxt) return;
        try {
            const payload = JSON.parse(decodeURIComponent(payloadTxt));
            const zoom = Number(stage.getAttribute('data-zoom') || '1') || 1;
            const panMsRaw = Number(stage.getAttribute('data-pan-ms') || '0') || 0;
            const panMs = clampMiniChartPanMs(payload, zoom, panMsRaw);
            stage.setAttribute('data-pan-ms', String(panMs));
            const opts = Object.assign({}, payload.options || {}, { zoomFactor: zoom, panMs });
            stage.innerHTML = buildMiniTrendSvg(
                payload.rscpSeries || [],
                payload.ecnoSeries || [],
                payload.freqSeries || [],
                payload.cellNameSeries || [],
                payload.markerEvents || [],
                opts
            );
            const resetBtn = wrap.querySelector('button.btn-mini-chart-zoom[data-op="reset"]');
            if (resetBtn) resetBtn.textContent = Math.round(zoom * 100) + '%';
        } catch (err) {
            console.warn('[MiniChart] failed to render payload:', err);
        }
    };

    const applyMiniChartZoom = (targetId, op) => {
        const stage = document.getElementById(targetId);
        if (!stage) return;
        const current = Number(stage.getAttribute('data-zoom') || '1') || 1;
        let next = current;
        if (op === 'in') next = Math.min(6, current + 0.5);
        else if (op === 'out') next = Math.max(1, current - 0.5);
        else next = 1;
        stage.setAttribute('data-zoom', String(next));
        stage.setAttribute('data-pan-ms', String(Number(stage.getAttribute('data-pan-ms') || '0') || 0));
        rerenderMiniChartStage(stage);
    };
    window.__miniChartZoom = applyMiniChartZoom;
    window.__miniChartRerender = rerenderMiniChartStage;
    const applyMiniChartPan = (targetId, dir, stepRatio = 0.25) => {
        const stage = document.getElementById(targetId);
        if (!stage) return;
        const wrap = stage.closest('.mini-chart-zoom-wrap');
        if (!wrap) return;
        const payloadTxt = wrap.getAttribute('data-chart-payload') || '';
        if (!payloadTxt) return;
        try {
            const payload = JSON.parse(decodeURIComponent(payloadTxt));
            const zoom = Number(stage.getAttribute('data-zoom') || '1') || 1;
            const rawSpan = getMiniChartRawSpanMs(payload);
            if (!Number.isFinite(rawSpan) || rawSpan <= 0) return;
            const visibleSpan = rawSpan / Math.max(1, zoom);
            const panStep = Math.max(1, visibleSpan * Math.max(0.05, Math.min(0.8, stepRatio)));
            const currentPan = Number(stage.getAttribute('data-pan-ms') || '0') || 0;
            const nextPan = (dir === 'left') ? (currentPan + panStep) : (currentPan - panStep);
            stage.setAttribute('data-pan-ms', String(nextPan));
            rerenderMiniChartStage(stage);
        } catch (err) {
            console.warn('[MiniChart] failed to pan payload:', err);
        }
    };
    window.__miniChartPan = applyMiniChartPan;

    const buildDropOneParagraphSummary = (session, insights, root) => {
        const vals = insights?.values || {};
        const scores = insights?.scores || {};
        const radio = vals.radio || {};
        const mobility = vals.mobility || {};
        const congestion = vals.congestion || {};
        const core = vals.core || {};

        const rscp = (typeof radio.avgRscp === 'number' && !Number.isNaN(radio.avgRscp)) ? radio.avgRscp.toFixed(1) : 'N/A';
        const ecno = (typeof radio.avgEcno === 'number' && !Number.isNaN(radio.avgEcno)) ? radio.avgEcno.toFixed(1) : 'N/A';

        const radioQualityAssessment = (() => {
            const poor = (typeof radio.avgRscp === 'number' && radio.avgRscp < -95) ||
                (typeof radio.avgEcno === 'number' && radio.avgEcno < -14) ||
                (typeof radio.avgUlTx === 'number' && radio.avgUlTx > 21);
            const good = (typeof radio.avgRscp === 'number' && radio.avgRscp >= -90) &&
                (typeof radio.avgEcno === 'number' && radio.avgEcno >= -10);
            if (poor) return 'poor';
            if (good) return 'good';
            return 'marginal';
        })();

        const radioConclusion = (() => {
            if (radioQualityAssessment === 'poor') return 'supports radio coverage/quality contribution';
            if (radioQualityAssessment === 'good') return 'rules out coverage or interference issues';
            return 'does not strongly confirm or exclude radio contribution';
        })();

        const keyTriggerEvent = (() => {
            if (insights?.flags?.mobilityOverride) return 'last handover';
            const trig = String(session?.endTrigger || '').toUpperCase();
            if (trig.includes('RADIO_LINK_FAILURE')) return 'radio link failure';
            if (trig.includes('IU_RELEASE')) return 'IU release';
            if (trig.includes('RRC_CONNECTION_RELEASE')) return 'RRC release';
            if (trig.includes('HANDOVER')) return 'handover';
            return 'the key release event';
        })();

        const timeAfterTrigger = (() => {
            if (typeof mobility.dropAfterHoSec === 'number' && !Number.isNaN(mobility.dropAfterHoSec) && mobility.dropAfterHoSec >= 0) {
                return mobility.dropAfterHoSec.toFixed(1);
            }
            return 'N/A';
        })();

        const interpretation = (() => {
            if (insights?.flags?.mobilityOverride) return 'post-handover instability';
            if (root?.topDomain === 'Radio Coverage / Quality') return 'radio degradation near call end';
            if (root?.topDomain === 'Congestion') return 'resource pressure at release';
            if (root?.topDomain === 'Core Network') return 'core-side release despite acceptable radio';
            return 'a mixed set of contributing indicators';
        })();

        const finalClassification = (() => {
            if (root?.topDomain === 'Mobility') return 'Mobility-related drop';
            if (root?.topDomain === 'Radio Coverage / Quality') return 'Radio-related drop';
            if (root?.topDomain === 'Congestion') return 'Congestion-related drop';
            if (root?.topDomain === 'Core Network') return 'Core-network-related drop';
            return 'Undetermined drop';
        })();

        const excluded = [];
        if ((scores.radio || 0) === 0) excluded.push('radio degradation');
        if ((scores.mobility || 0) === 0) excluded.push('mobility instability');
        if ((scores.congestion || 0) === 0) excluded.push('congestion/resource pressure');
        if ((scores.core || 0) === 0) excluded.push('core network release');
        const excludedDomains = excluded.length ? excluded.join(' or ') : 'major alternative domains';

        const primaryRootCause = root?.topDomain || 'Undetermined';
        const confidence = Number.isFinite(root?.confidence) ? root.confidence : 0;

        return 'The call was successfully established and subsequently dropped due to ' + primaryRootCause +
            '. The drop occurred ' + timeAfterTrigger + ' seconds after ' + keyTriggerEvent +
            ', indicating ' + interpretation +
            '. Radio conditions prior to the drop were ' + radioQualityAssessment +
            ' (RSCP ' + rscp + ' dBm, Ec/No ' + ecno + ' dB), which ' + radioConclusion +
            '. No evidence of ' + excludedDomains +
            ' was observed during the call. The drop is therefore classified as ' + finalClassification +
            ' with ' + confidence + '% confidence.';
    };

    const buildPostHoLikelyCauses = (insights, root) => {
        const mobilityLikely = !!(insights?.flags?.mobilityOverride || (insights?.scores?.mobility || 0) > 0 || root?.topDomain === 'Mobility');
        if (!mobilityLikely) return '';
        const causes = [
            'HO hysteresis too low',
            'Time-to-trigger too short',
            'Overlapping coverage imbalance',
            'Pilot pollution',
            'Missing or wrong neighbor ranking'
        ];
        return '' +
            '<div style="padding:8px; background:#111827; border:1px solid #334155; border-radius:6px; margin-bottom:10px;">' +
            '  <div style="font-size:12px; font-weight:600; color:#bfdbfe; margin-bottom:6px;">Likely Root Causes (Post-Handover Instability)</div>' +
            '  <div style="font-size:12px; color:#d1d5db;">' +
            causes.map(c => '<div style="margin-bottom:4px;">- ' + c + '</div>').join('') +
            '  </div>' +
            '</div>';
    };

    const buildDropEventTimeline = (log, session) => {
        const points = Array.isArray(log?.points) ? log.points : [];
        const endMs = parseSessionTimeToMs(session?.endTime || session?.startTime);
        if (Number.isNaN(endMs)) return [];
        const events = points.filter(p => {
            const t = parseSessionTimeToMs(p?.time);
            if (Number.isNaN(t)) return false;
            const isEvt = p?.type === 'EVENT' || p?.event || p?.message;
            return isEvt && Math.abs(t - endMs) <= 15000;
        }).map(p => {
            const t = parseSessionTimeToMs(p.time);
            return {
                time: p.time,
                deltaSec: ((t - endMs) / 1000).toFixed(1),
                label: [p?.event, p?.message, p?.properties?.Event, p?.properties?.Message].filter(Boolean)[0] || 'Event'
            };
        }).sort((a, b) => parseFloat(a.deltaSec) - parseFloat(b.deltaSec));
        return events.slice(0, 10);
    };

    const ACTION_LIBRARY = {
        OPT_NEIGHBOR_LAYER_WEAK_COVERAGE: {
            title: 'Optimize neighbor/layer options in weak-coverage routes',
            solving: [
                'User moves into weak serving area but:',
                '• No proper neighbor in list',
                '• Wrong priority',
                '• No IFHO/IRAT fallback'
            ],
            steps: [
                {
                    title: 'A) Extract route segment',
                    bullets: [
                        'For drop/setup fail cluster:',
                        '• List serving PSCs',
                        '• List strongest 3 neighbors at those GPS points',
                        'Check:',
                        '• Is the strongest neighbor in the neighbor list?',
                        '• Is it configured for: SHO / IFHO / IRAT?'
                    ]
                },
                {
                    title: 'B) Parameter audit',
                    bullets: [
                        'Review:',
                        '• Neighbor list completeness',
                        '• Missing PSCs',
                        '• Incorrect scrambling code definitions',
                        '• IFHO thresholds'
                    ]
                },
                {
                    title: 'C) Engineering actions',
                    bullets: [
                        'P0:',
                        '• Add missing neighbor definitions',
                        '• Correct wrong PSC/UARFCN mapping',
                        'P1:',
                        '• Adjust inter-frequency measurement trigger',
                        'P2:',
                        '• Review layer priority (e.g., 900 vs 2100)'
                    ]
                }
            ]
        },
        INVEST_UL_TX_SAT_ZONES: {
            title: 'Investigate uplink coverage limits and UE Tx saturation zones',
            solving: [
                'You suspect uplink limitation (UL budget exhausted) when:',
                '• UE Tx power stays high (often >= 21-23 dBm) for several seconds',
                '• Call setup failures / drops cluster geographically',
                '• RSCP may be weak-to-moderate, EcNo may be unstable',
                '• DL may look \'OK\' but UL cannot sustain the link'
            ],
            steps: [
                {
                    title: 'A) Identify saturation zones from the NMF route',
                    bullets: [
                        '1) Filter to the last window before failure (e.g., 10s before CAD/CARE).',
                        '2) Extract per timestamp: GPS, UE Tx (TXPC), RSCP/EcNo (MIMOMEAS best server), BLER (RLCBLER), PSC/UARFCN.',
                        '3) Mark a sample as \'UL-saturated\' if:',
                        '   • UE Tx >= 21 dBm (or your chosen threshold), AND',
                        '   • persists >= 3 consecutive samples OR >= 3 seconds in time.',
                        '4) Cluster saturated samples by GPS (e.g., within 50-100 m) to find hotspots.'
                    ]
                },
                {
                    title: 'B) Validate it’s truly UL-limited (not only DL interference)',
                    bullets: [
                        'Check these patterns in the same window:',
                        '• UL-limited signature:',
                        '  - UE Tx high (near max) + RSCP weak + EcNo poor/unstable',
                        '  - Drops/setup failures repeat in the same segment',
                        '• DL-interference signature (NOT UL-limited):',
                        '  - UE Tx low/normal + RSCP strong + EcNo very bad + BLER spikes',
                        'If UE Tx is consistently high while RSCP is weak, UL limitation is very likely.'
                    ]
                },
                {
                    title: 'C) Cross-check with network-side evidence (if you have OSS counters)',
                    bullets: [
                        'Pull counters/KPIs for the serving cell(s) covering the hotspot:',
                        '• UL Noise Rise / RTWP trend (high indicates UL interference/load)',
                        '• RRC failures / RLF causes (uplink-related, poor coverage)',
                        '• UL BLER / retransmissions (if available)',
                        '• Iub/Iu issues (to exclude transport problems)',
                        'If UL Noise Rise is high during the same period, prioritize interference/source hunt.'
                    ]
                },
                {
                    title: 'D) Practical actions (prioritized)',
                    bullets: [
                        'P0 (fast checks):',
                        '• Verify antenna feeders/VSWR/alarms for the serving site (hardware issues can mimic UL holes).',
                        '• Check tilt/azimuth mismatch (overshoot/coverage gap) and confirm dominant coverage along the route.',
                        '• Identify if hotspot is on the edge between two layers (900/2100) with poor fallback.',
                        '',
                        'P1 (optimization):',
                        '• Adjust tilt / CPICH / layer strategy to improve UL margin where the route is failing.',
                        '• Add/repair neighbors to allow earlier HO to a better UL cell before saturation.',
                        '',
                        'P2 (structural):',
                        '• Consider densification / additional carrier/layer changes if the hole is persistent and wide.',
                        '• Add monitoring: alert when UE Tx high ratio spikes on that corridor.'
                    ]
                }
            ]
        },
        INVEST_UL_TX_SATURATION: {
            title: 'Investigate UL Tx saturation / uplink-limited coverage',
            solving: [
                'Call drops or setup failures happen with high UE Tx and weak RSCP.',
                'This usually indicates uplink budget limitation near coverage edge.'
            ],
            steps: [
                {
                    title: 'A) Verify radio signature',
                    bullets: [
                        'Check last-10s window for:',
                        '• UE Tx p90 / max near upper range',
                        '• Weak RSCP and degraded Ec/No',
                        '• Repeated drops in same geography'
                    ]
                },
                {
                    title: 'B) Field and site checks',
                    bullets: [
                        'Inspect:',
                        '• Feeder/connector/VSWR alarms',
                        '• Antenna tilt/azimuth mismatch',
                        '• Sector overlap and overshoot',
                        '• UL noise rise and interference floor'
                    ]
                },
                {
                    title: 'C) Optimization actions',
                    bullets: [
                        'P0:',
                        '• Correct physical faults and obvious tilt/azimuth issues',
                        'P1:',
                        '• Tune neighbors/layer fallback for edge retention',
                        'P2:',
                        '• Consider densification where weak-UL cluster persists'
                    ]
                }
            ]
        },
        AUDIT_PILOT_POLLUTION_SHO: {
            title: 'Audit pilot pollution and SHO behavior',
            solving: [
                'Drops occur with good RSCP but poor Ec/No and BLER spikes.',
                'Likely too many close-power pilots and unstable serving dominance.'
            ],
            steps: [
                {
                    title: 'A) Identify pollution zone',
                    bullets: [
                        'For affected points, list:',
                        '• Serving + top 3 pilots',
                        '• RSCP delta to serving',
                        '• Active-set size/churn',
                        'Mark zones where many pilots are within ~6 dB.'
                    ]
                },
                {
                    title: 'B) SHO / neighbor audit',
                    bullets: [
                        'Review:',
                        '• Missing/wrong neighbors',
                        '• A3/A5 thresholds, hysteresis, TTT',
                        '• Excessive ping-pong or late HO signs'
                    ]
                },
                {
                    title: 'C) Corrective actions',
                    bullets: [
                        'P0:',
                        '• Rebalance CPICH pilot powers and fix obvious neighbor defects',
                        'P1:',
                        '• Tune SHO thresholds/hysteresis/TTT',
                        'P2:',
                        '• Re-test route and compare Ec/No+BLER before/after'
                    ]
                }
            ]
        },
        TRACE_SETUP_TIMEOUT_PATH: {
            title: 'Trace setup timeout path (CAD cause 102)',
            solving: [
                'Setup fails with timer expiry before call connect.',
                'Cause is usually signaling path delay/failure across RNC/core/transport.'
            ],
            steps: [
                {
                    title: 'A) Build failing call ladder',
                    bullets: [
                        'Collect all signaling around failure:',
                        '• RRC connection request/setup',
                        '• NAS/CC setup messages',
                        '• RAB assignment steps',
                        'Mark where message progression stops.'
                    ]
                },
                {
                    title: 'B) Correlate network-side counters',
                    bullets: [
                        'Check same time window for:',
                        '• RNC/MSC reject/timeout counters',
                        '• Iu/Iub transport latency/resets',
                        '• Retransmission spikes'
                    ]
                },
                {
                    title: 'C) Remediation plan',
                    bullets: [
                        'P0:',
                        '• Fix immediate signaling/transport faults causing timeout',
                        'P1:',
                        '• Tune timer-related parameters only after root cause confirmation',
                        'P2:',
                        '• Add monitoring alarm for repeated setup-timeout clusters'
                    ]
                }
            ]
        },
        VALIDATE_PILOT_DOMINANCE_DROP_CLUSTER: {
            title: 'Validate pilot dominance in drop cluster',
            solving: [
                'Drops can occur when serving pilot is not dominant enough.',
                'Near-equal pilots create unstable serving selection and quality degradation.'
            ],
            steps: [
                {
                    title: 'A) Compute dominance along route',
                    bullets: [
                        'For each drop-cluster point compute:',
                        '• ΔRSCP = RSCP(best pilot) - RSCP(2nd best pilot)',
                        'Flag weak dominance where:',
                        '• ΔRSCP < 3 dB'
                    ]
                },
                {
                    title: 'B) Validate active set behavior',
                    bullets: [
                        'Check active-set dynamics in same segment:',
                        '• Active set size >= 3',
                        '• Frequent active-set churn / SHO instability'
                    ]
                },
                {
                    title: 'C) Review CPICH strategy',
                    bullets: [
                        'Review CPICH power and dominance balancing:',
                        '• Reduce overlapping strong pilots',
                        '• Improve serving-cell dominance on route',
                        'Owner: RAN Optimization'
                    ]
                }
            ]
        }
    };
    ACTION_LIBRARY.INVEST_UL_TX_SATURATION = ACTION_LIBRARY.INVEST_UL_TX_SAT_ZONES;
    ACTION_LIBRARY.INVEST_SETUP_UL_LIMITATION = ACTION_LIBRARY.INVEST_UL_TX_SAT_ZONES;
    ACTION_LIBRARY.SOLVE_INTERFERENCE_STRONG_SIGNAL = ACTION_LIBRARY.SOLVE_INTERFERENCE_STRONG_SIGNAL || {
        title: 'Solve interference-under-strong-signal',
        solving: [
            'Signal level is acceptable but quality and decode performance collapse.',
            'Typical signature: high BLER with low/normal UE Tx and non-weak RSCP.'
        ],
        steps: [
            {
                title: 'A) Confirm signature',
                bullets: [
                    'Validate RSCP, EcNo, BLER and UE Tx in the last 10s before failure.',
                    'Rule-of-thumb: RSCP >= -90 dBm, BLER high, UE Tx not saturated.'
                ]
            },
            {
                title: 'B) Isolate dominant interferers',
                bullets: [
                    'Identify recurring competing pilots by location/time.',
                    'Correlate with repeated failures and quality collapse.'
                ]
            },
            {
                title: 'C) Mitigate and verify',
                bullets: [
                    'Tune CPICH/tilt/overlap where needed.',
                    'Re-drive and compare EcNo/BLER before and after changes.'
                ]
            }
        ]
    };
    ACTION_LIBRARY.SOLVE_INTERFERENCE_UNDER_STRONG_SIGNAL = ACTION_LIBRARY.SOLVE_INTERFERENCE_STRONG_SIGNAL;

    const ACTION_ID_ALIASES_UI = {
        SOLVE_INTERFERENCE_UNDER_STRONG_SIGNAL: 'SOLVE_INTERFERENCE_STRONG_SIGNAL'
    };

    function canonicalActionIdUi(actionId) {
        const id = String(actionId || '').trim().toUpperCase();
        return ACTION_ID_ALIASES_UI[id] || id;
    }

    function findActionInSession(session, actionId) {
        const canon = canonicalActionIdUi(actionId);
        const collections = [
            session?.umts?.classification?.recommendations,
            session?.classification?.recommendations,
            session?.recommendedActions,
            session?.umts?.setupFailureDeepAnalysis?.recommendedActions,
            session?.setupFailureDeepAnalysis?.recommendedActions
        ];
        for (const list of collections) {
            if (!Array.isArray(list)) continue;
            const hit = list.find((r) => canonicalActionIdUi(r?.actionId || '') === canon);
            if (hit) return hit;
        }
        return null;
    }

    function formatActionMetric(v, unit, digits = 1) {
        return Number.isFinite(v) ? `${Number(v).toFixed(digits)}${unit ? ` ${unit}` : ''}` : 'n/a';
    }

    function formatInterferenceStrongSignalPopup(session, action) {
        const cls = session?.umts?.classification || session?.classification || null;
        const snap = session?.umts?.snapshot || session?.snapshot || cls?.snapshot || null;
        const pp = cls?.pilotPollution || snap?.pilotPollution || null;
        const strong = pp?.strongRscpBadEcno || {};
        const delta = pp?.deltaStats || {};

        const rscpSeriesVals = Array.isArray(snap?.seriesRscp) ? snap.seriesRscp.map(p => Number(p?.value)).filter(Number.isFinite) : [];
        const ecnoSeriesVals = Array.isArray(snap?.seriesEcno) ? snap.seriesEcno.map(p => Number(p?.value)).filter(Number.isFinite) : [];
        const rscpMin = rscpSeriesVals.length ? Math.min(...rscpSeriesVals) : (Number.isFinite(snap?.rscpMin) ? snap.rscpMin : null);
        const rscpMed = Number.isFinite(snap?.rscpMedian) ? snap.rscpMedian : null;
        const rscpMax = rscpSeriesVals.length ? Math.max(...rscpSeriesVals) : (Number.isFinite(snap?.rscpLast) ? snap.rscpLast : null);
        const ecnoMin = ecnoSeriesVals.length ? Math.min(...ecnoSeriesVals) : (Number.isFinite(snap?.ecnoMin) ? snap.ecnoMin : null);
        const ecnoMed = Number.isFinite(snap?.ecnoMedian) ? snap.ecnoMedian : null;
        const ecnoMax = ecnoSeriesVals.length ? Math.max(...ecnoSeriesVals) : (Number.isFinite(snap?.ecnoLast) ? snap.ecnoLast : null);
        const blerMax = Number.isFinite(snap?.blerMax) ? snap.blerMax : null;
        const txP90 = Number.isFinite(snap?.txP90) ? snap.txP90 : null;
        const servingTxt = (Number.isFinite(snap?.lastPsc) || Number.isFinite(snap?.lastUarfcn))
            ? `Serving context: PSC ${Number.isFinite(snap?.lastPsc) ? snap.lastPsc : 'n/a'} / UARFCN ${Number.isFinite(snap?.lastUarfcn) ? snap.lastUarfcn : 'n/a'}`
            : 'Serving context: n/a';

        const S = Number.isFinite(strong?.strongCount) ? strong.strongCount : 0;
        const SB = Number.isFinite(strong?.strongBadCount) ? strong.strongBadCount : 0;
        const B = Number.isFinite(strong?.denomBestValid) ? strong.denomBestValid : 0;
        const N = Number.isFinite(strong?.denomTotalMimo) ? strong.denomTotalMimo : (Number.isFinite(delta?.totalMimoSamples) ? delta.totalMimoSamples : 0);
        const ratioBad = Number.isFinite(strong?.ratioBad) ? `${(strong.ratioBad * 100).toFixed(0)}%` : 'n/a';
        const ratioStrongShare = Number.isFinite(strong?.ratioStrongShare) ? `${(strong.ratioStrongShare * 100).toFixed(0)}%` : 'n/a';
        const K = Number.isFinite(delta?.samplesWith2Pilots) ? delta.samplesWith2Pilots : 0;
        const Y = Number.isFinite(delta?.totalMimoSamples) ? delta.totalMimoSamples : N;
        const dominanceLine = `ΔRSCP computed on ${K}/${Y} timestamps meeting the ≥2-pilot criterion.`;
        const dominanceUnavailableLine = K === 0
            ? `ΔRSCP not computable (0/${Y} ≥2-pilot timestamps). Dominance inference disabled.`
            : null;
        const bestServerDen = B > 0 ? B : N;
        const strongDenominatorLine = `Strong RSCP+bad EcNo computed on ${SB}/${bestServerDen} best-server samples.`;
        const interferenceLevel = pp?.interferenceLevel || 'n/a';
        const interferenceScore = Number.isFinite(pp?.interferenceScore) ? pp.interferenceScore : null;
        const dominanceLevel = pp?.dominanceLevel || (K === 0 ? 'N/A' : 'n/a');
        const dominanceScore = Number.isFinite(pp?.dominanceScore) ? pp.dominanceScore : null;
        const dominanceContributionLine = String(dominanceLevel).toUpperCase() === 'HIGH'
            ? 'Dominance overlap may also contribute; resolve overlap first.'
            : null;
        const prioritizeInterference = String(interferenceLevel).toUpperCase() === 'HIGH';
        const recRows = [
            {
                priority: 'P0',
                action: 'Verify DL load and noise-rise on serving cell',
                rationale: 'High BLER under good RSCP suggests interference',
                owner: 'RAN Optimization'
            },
            {
                priority: 'P0',
                action: 'Check CPICH power vs traffic power balance',
                rationale: 'Misconfigured power split can degrade EcNo',
                owner: 'Optimization'
            },
            {
                priority: 'P1',
                action: 'Audit neighbor dominance & SHO thresholds',
                rationale: 'Missing SHO can amplify interference',
                owner: 'Optimization'
            },
            {
                priority: 'P1',
                action: 'Inspect hardware alarms (PA, VSWR, feeder)',
                rationale: 'Hardware distortion can raise noise floor',
                owner: 'Field / RAN'
            },
            {
                priority: 'P1',
                action: 'Analyze EcNo/BLER distribution on same PSC',
                rationale: 'Validate persistent footprint vs isolated event',
                owner: 'RAN'
            }
        ];

        return {
            title: 'Solve interference-under-strong-signal',
            sections: [
                {
                    title: '🔍 What you\'re solving',
                    body: 'Downlink decoding collapses even though coverage is acceptable. UE is not power-limited, but BLER/quality indicates interference/noise rise or control-channel decode impairment.'
                },
                {
                    title: '📡 What physically happens on the network',
                    body:
                        '• CPICH (pilot) power is strong -> RSCP looks good.\n' +
                        '• Interference or cell load increases -> EcNo drops.\n' +
                        '• DPCH / control channel decoding becomes unstable.\n' +
                        '• CRC errors increase -> BLER spikes.\n' +
                        '• RRC / NAS messages fail to decode.\n' +
                        '• Call setup aborts before connection completes.\n\n' +
                        'Even though coverage appears fine, the radio environment is polluted.'
                },
                {
                    title: '🎯 Why this case fits this + Interpretation',
                    body:
                        `Coverage OK: RSCP median = ${formatActionMetric(rscpMed, 'dBm')} (threshold -90)\n` +
                        `UL margin OK: UE Tx p90 = ${formatActionMetric(txP90, 'dBm')} (threshold 18)\n` +
                        `DL quality: EcNo median = ${formatActionMetric(ecnoMed, 'dB')}\n` +
                        `Decode collapse: BLER max = ${formatActionMetric(blerMax, '%')}\n` +
                        `Interference proxy: strong RSCP + bad EcNo ratio = ${SB}/${S} (${ratioBad})\n` +
                        `Strong RSCP share = ${S}/${B} (${ratioStrongShare})\n` +
                        `Dominance/Overlap risk: ${dominanceLevel}${dominanceScore !== null ? ` (${dominanceScore}/100)` : ''}\n` +
                        `Interference-under-strong-signal risk: ${interferenceLevel}${interferenceScore !== null ? ` (${interferenceScore}/100)` : ''}\n` +
                        `${dominanceLine}\n` +
                        `${strongDenominatorLine}\n` +
                        `${dominanceUnavailableLine ? `${dominanceUnavailableLine}\n` : ''}` +
                        `RSCP (min/med/max): ${formatActionMetric(rscpMin, 'dBm')} / ${formatActionMetric(rscpMed, 'dBm')} / ${formatActionMetric(rscpMax, 'dBm')}\n` +
                        `EcNo (min/med/max): ${formatActionMetric(ecnoMin, 'dB')} / ${formatActionMetric(ecnoMed, 'dB')} / ${formatActionMetric(ecnoMax, 'dB')}\n` +
                        `${servingTxt}`
                },
                {
                    title: '🚦 Engineering Interpretation',
                    body:
                        'Strong pilot energy with poor quality usually indicates DL interference or dominance issues: overshooting neighbors, unstable active-set behavior, non-serving interference, feeder/power imbalance, or external noise rise.' +
                        (dominanceContributionLine ? ` ${dominanceContributionLine}` : '')
                },
                {
                    title: '🛠 Recommended Actions',
                    tableRows: recRows,
                    tableHint: prioritizeInterference ? 'Interference level is High: prioritize P0 interference actions first.' : ''
                }
            ]
        };
    }

    function ensureActionModal() {
        if (document.getElementById('actionModalOverlay')) return;
        const overlay = document.createElement('div');
        overlay.id = 'actionModalOverlay';
        overlay.style.cssText = 'position: fixed; inset: 0; background: radial-gradient(circle at 20% 10%, rgba(30,64,175,0.28), rgba(0,0,0,0.82) 42%), rgba(0,0,0,0.78); display: none; align-items: center; justify-content: center; z-index: 99999; backdrop-filter: blur(4px);';

        const modal = document.createElement('div');
        modal.id = 'actionModal';
        modal.style.cssText = 'width: min(960px, 92vw); max-height: 86vh; overflow: auto; background: linear-gradient(180deg, #0f172a 0%, #111827 100%); color: #e5e7eb; border: 1px solid rgba(96,165,250,0.25); border-radius: 16px; box-shadow: 0 24px 90px rgba(0,0,0,0.62); padding: 0; font-family: Manrope, "Segoe UI", "Helvetica Neue", Arial, sans-serif; transform: translateY(8px) scale(0.99); opacity: 0;';
        modal.innerHTML = '' +
            '<div style="padding:16px 18px; border-bottom:1px solid rgba(148,163,184,0.24); background: linear-gradient(90deg, rgba(30,41,59,0.95), rgba(17,24,39,0.9)); display:flex; align-items:center; justify-content:space-between; gap:12px;">' +
            '<div style="display:flex; flex-direction:column; gap:4px;">' +
            '<div style="font-size:11px; letter-spacing:0.08em; text-transform:uppercase; color:#93c5fd; font-weight:700;">Action Playbook</div>' +
            '<div id="actionModalTitle" style="font-size:18px; font-weight:800; color:#e2e8f0;"></div>' +
            '</div>' +
            '<button id="actionModalClose" style="background: rgba(15,23,42,0.7); border: 1px solid rgba(148,163,184,0.35); color: #e5e7eb; padding: 7px 12px; border-radius: 10px; cursor:pointer; font-weight:600;">Close</button>' +
            '</div>' +
            '<div id="actionModalBody" style="padding:16px 18px 18px 18px;"></div>';
        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        const close = () => {
            modal.style.transition = 'all 120ms ease-in';
            modal.style.opacity = '0';
            modal.style.transform = 'translateY(8px) scale(0.99)';
            setTimeout(() => { overlay.style.display = 'none'; }, 120);
        };
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) close();
        });
        document.getElementById('actionModalClose').addEventListener('click', close);
        window.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') close();
        });

        overlay.__openActionModal = () => {
            overlay.style.display = 'flex';
            requestAnimationFrame(() => {
                modal.style.transition = 'all 180ms ease-out';
                modal.style.opacity = '1';
                modal.style.transform = 'translateY(0) scale(1)';
            });
        };
    }

    function renderActionDetail(actionId, sessionCandidate) {
        ensureActionModal();
        const overlay = document.getElementById('actionModalOverlay');
        const titleEl = document.getElementById('actionModalTitle');
        const bodyEl = document.getElementById('actionModalBody');
        const canonId = canonicalActionIdUi(actionId);
        const session = sessionCandidate || window.selectedUmtsSession || null;
        const actionFromSession = findActionInSession(session, canonId);
        if (canonId === 'SOLVE_INTERFERENCE_STRONG_SIGNAL') {
            const payload = formatInterferenceStrongSignalPopup(session, actionFromSession);
            titleEl.textContent = payload.title;
            bodyEl.innerHTML = (payload.sections || []).map((sec) => (
                '<div style="margin-top:12px; padding:13px 14px; border-radius:14px; background: rgba(15,23,42,0.75); border: 1px solid rgba(148,163,184,0.22);">' +
                '<div style="font-weight:800; color:#e2e8f0; font-size:13px; margin-bottom:8px;">' + escapeHtml(sec.title || '-') + '</div>' +
                (
                    Array.isArray(sec.tableRows)
                        ? (
                            (sec.tableHint ? ('<div style="font-size:12px; color:#fcd34d; margin-bottom:6px;">' + escapeHtml(sec.tableHint) + '</div>') : '') +
                            '<table style="width:100%; border-collapse:collapse; font-size:12px; color:#d1d5db;">' +
                            '<thead><tr style="color:#93c5fd;"><th style="padding:6px; border:1px solid #334155; text-align:left;">Priority</th><th style="padding:6px; border:1px solid #334155; text-align:left;">Action</th><th style="padding:6px; border:1px solid #334155; text-align:left;">Rationale</th><th style="padding:6px; border:1px solid #334155; text-align:left;">Owner</th></tr></thead>' +
                            '<tbody>' +
                            sec.tableRows.map((r) => (
                                '<tr>' +
                                '<td style="padding:6px; border:1px solid #334155;">' + escapeHtml(r.priority || '-') + '</td>' +
                                '<td style="padding:6px; border:1px solid #334155;">' + escapeHtml(r.action || '-') + '</td>' +
                                '<td style="padding:6px; border:1px solid #334155;">' + escapeHtml(r.rationale || '-') + '</td>' +
                                '<td style="padding:6px; border:1px solid #334155;">' + escapeHtml(r.owner || '-') + '</td>' +
                                '</tr>'
                            )).join('') +
                            '</tbody></table>'
                        )
                        : ('<div style="white-space:pre-line; color:#cbd5e1; line-height:1.55; font-size:12.5px;">' + decorateOkNokText(String(sec.body || '')) + '</div>')
                ) +
                '</div>'
            )).join('');
            if (typeof overlay.__openActionModal === 'function') overlay.__openActionModal();
            else overlay.style.display = 'flex';
            return;
        }
        if (actionFromSession && (actionFromSession.detailsText || actionFromSession.detailsMarkdown)) {
            const rendered = Array.isArray(actionFromSession.detailsText)
                ? actionFromSession.detailsText.join('\n')
                : String(actionFromSession.detailsText || actionFromSession.detailsMarkdown || '');
            titleEl.textContent = actionFromSession.title || actionFromSession.action || canonId;
            bodyEl.innerHTML = '' +
                '<div style="padding:14px; border-radius:14px; background: linear-gradient(135deg, rgba(30,64,175,0.18), rgba(2,132,199,0.10)); border:1px solid rgba(96,165,250,0.25);">' +
                '<div style="font-size:13px; font-weight:800; color:#bfdbfe; margin-bottom:8px;">Analyzer-provided details</div>' +
                '<div style="white-space:pre-line; color:#dbeafe; line-height:1.55; font-size:12.5px;">' + decorateOkNokText(rendered) + '</div>' +
                '</div>';
            if (typeof overlay.__openActionModal === 'function') overlay.__openActionModal();
            else overlay.style.display = 'flex';
            return;
        }
        const entry = ACTION_LIBRARY[canonId] || ACTION_LIBRARY[actionId];
        if (!entry) {
            titleEl.textContent = 'Action details';
            const snap = session?.umts?.snapshot || session?.snapshot || session?.umts?.classification?.snapshot || null;
            const fallbackMetrics = snap
                ? ('<div style="margin-top:8px; color:#d1d5db;">' +
                    'RSCP median: ' + formatActionMetric(snap?.rscpMedian, 'dBm') + '<br>' +
                    'EcNo median: ' + formatActionMetric(snap?.ecnoMedian, 'dB') + '<br>' +
                    'BLER max: ' + formatActionMetric(snap?.blerMax, '%') + '<br>' +
                    'UE Tx p90: ' + formatActionMetric(snap?.txP90, 'dBm') +
                    '</div>')
                : '';
            bodyEl.innerHTML = '<div style="color:#fca5a5; padding:12px; border:1px solid rgba(248,113,113,0.35); border-radius:12px; background:rgba(127,29,29,0.15);">No template found for actionId: ' + canonId + '</div>' + fallbackMetrics;
            if (typeof overlay.__openActionModal === 'function') overlay.__openActionModal();
            else overlay.style.display = 'flex';
            return;
        }
        titleEl.textContent = entry.title;
        const solvingHtml = Array.isArray(entry.solving) && entry.solving.length
            ? '<div style="margin-top:6px; padding:14px; border-radius:14px; background: linear-gradient(135deg, rgba(30,64,175,0.18), rgba(2,132,199,0.10)); border:1px solid rgba(96,165,250,0.25);">' +
            '<div style="font-weight:800; margin-bottom:8px; color:#bfdbfe; font-size:13px;">What you are solving</div>' +
            '<div style="white-space:pre-line; color:#dbeafe; line-height:1.55; font-size:13px;">' + decorateOkNokText(entry.solving.join('\n')) + '</div>' +
            '</div>'
            : '';
        const stepsHtml = (entry.steps || []).map(s => '' +
            '<div style="margin-top:12px; padding:13px 14px; border-radius:14px; background: rgba(15,23,42,0.75); border: 1px solid rgba(148,163,184,0.22);">' +
            '<div style="display:flex; align-items:center; gap:8px; margin-bottom:8px;">' +
            '<span style="display:inline-flex; align-items:center; justify-content:center; min-width:22px; height:22px; border-radius:999px; background:rgba(34,197,94,0.2); color:#86efac; font-size:11px; font-weight:800;">' + (String(s.title || '').charAt(0) || 'S') + '</span>' +
            '<div style="font-weight:800; color:#e2e8f0; font-size:13px;">' + s.title + '</div>' +
            '</div>' +
            '<div style="white-space:pre-line; color:#cbd5e1; line-height:1.55; font-size:12.5px;">' + decorateOkNokText(Array.isArray(s.bullets) ? s.bullets.join('\n') : '') + '</div>' +
            '</div>'
        ).join('');
        bodyEl.innerHTML = solvingHtml +
            '<div style="margin-top:14px; margin-bottom:2px; font-weight:800; letter-spacing:0.02em; color:#cbd5e1;">Step-by-step</div>' +
            stepsHtml;
        if (typeof overlay.__openActionModal === 'function') overlay.__openActionModal();
        else overlay.style.display = 'flex';
    }

    function escapeHtml(v) {
        return String(v == null ? '' : v)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function okNokBadgeHtml(status) {
        const s = String(status || '').toUpperCase();
        if (s === 'OK') {
            return '<span style="display:inline-block; padding:1px 7px; border-radius:999px; font-size:10px; font-weight:700; color:#bbf7d0; background:rgba(22,163,74,0.22); border:1px solid rgba(74,222,128,0.45);">OK</span>';
        }
        if (s === 'NOK') {
            return '<span style="display:inline-block; padding:1px 7px; border-radius:999px; font-size:10px; font-weight:700; color:#fecaca; background:rgba(220,38,38,0.20); border:1px solid rgba(248,113,113,0.45);">NOK</span>';
        }
        if (s === 'N/A') {
            return '<span style="display:inline-block; padding:1px 7px; border-radius:999px; font-size:10px; font-weight:700; color:#cbd5e1; background:rgba(100,116,139,0.25); border:1px solid rgba(148,163,184,0.35);">N/A</span>';
        }
        return escapeHtml(status);
    }

    function decorateOkNokText(rawText) {
        const text = escapeHtml(rawText);
        return text
            .replace(/\bNOK\b/g, okNokBadgeHtml('NOK'))
            .replace(/\bOK\b/g, okNokBadgeHtml('OK'))
            .replace(/\bN\/A\b/g, okNokBadgeHtml('N/A'));
    }

    function openPilotPollutionDetails(session) {
        ensureActionModal();
        const overlay = document.getElementById('actionModalOverlay');
        const titleEl = document.getElementById('actionModalTitle');
        const bodyEl = document.getElementById('actionModalBody');
        const pp = session?.umts?.classification?.pilotPollution || session?.pilotPollution || null;
        titleEl.textContent = 'Pilot Pollution Verification (Detailed)';
        if (!pp) {
            bodyEl.innerHTML = '<div style="color:#fca5a5; padding:12px; border:1px solid rgba(248,113,113,0.35); border-radius:12px; background:rgba(127,29,29,0.15);">No pilot pollution details available.</div>';
            if (typeof overlay.__openActionModal === 'function') overlay.__openActionModal();
            else overlay.style.display = 'flex';
            return;
        }
        const lines = Array.isArray(pp.detailsText) ? pp.detailsText : [];
        bodyEl.innerHTML = '' +
            '<div style="padding:14px; border-radius:14px; background: linear-gradient(135deg, rgba(30,64,175,0.18), rgba(2,132,199,0.10)); border:1px solid rgba(96,165,250,0.25);">' +
            '<div style="font-size:13px; font-weight:800; color:#bfdbfe; margin-bottom:8px;">Analyzer Evidence</div>' +
            '<div style="white-space:pre-line; color:#dbeafe; line-height:1.55; font-size:12.5px;">' + lines.map(x => decorateOkNokText(x)).join('\n') + '</div>' +
            '</div>';
        if (typeof overlay.__openActionModal === 'function') overlay.__openActionModal();
        else overlay.style.display = 'flex';
    }

    function openUeTxP90Details() {
        ensureActionModal();
        const overlay = document.getElementById('actionModalOverlay');
        const titleEl = document.getElementById('actionModalTitle');
        const bodyEl = document.getElementById('actionModalBody');
        titleEl.textContent = 'What High UE Tx p90 Indicates';
        bodyEl.innerHTML = '' +
            '<div style="padding:14px; border-radius:14px; background: linear-gradient(135deg, rgba(30,64,175,0.18), rgba(2,132,199,0.10)); border:1px solid rgba(96,165,250,0.25); margin-bottom:12px;">' +
            '<div style="color:#dbeafe; line-height:1.55; font-size:13px;">UE Tx p90 shows how hard the phone had to transmit most of the time. A high value means the phone was often transmitting near its maximum power, which can lead to call drops.</div>' +
            '<div style="color:#dbeafe; line-height:1.55; font-size:13px; margin-top:10px;">If UE Tx p90 is high, it usually means:</div>' +
            '<div style="white-space:pre-line; color:#dbeafe; line-height:1.55; font-size:13px; margin-top:6px;">• UE is far from NodeB\n• Indoor penetration loss\n• Uplink coverage imbalance\n• Interference on UL</div>' +
            '<div style="color:#dbeafe; line-height:1.55; font-size:13px; margin-top:10px;">Often correlated with:</div>' +
            '<div style="white-space:pre-line; color:#dbeafe; line-height:1.55; font-size:13px; margin-top:6px;">• Rising BLER\n• RLF\n• Voice drops</div>' +
            '</div>' +
            '<div style="font-size:14px; font-weight:800; color:#bfdbfe; margin-bottom:8px;">How to Interpret UE Tx p90 (3G Voice)</div>' +
            '<table style="width:100%; border-collapse:collapse; font-size:12px; color:#d1d5db;">' +
            '  <thead><tr style="color:#93c5fd;"><th style="padding:7px; border:1px solid #334155; text-align:left;">UE Tx p90</th><th style="padding:7px; border:1px solid #334155; text-align:left;">Interpretation</th></tr></thead>' +
            '  <tbody>' +
            '    <tr><td style="padding:7px; border:1px solid #334155;">&lt; 10 dBm</td><td style="padding:7px; border:1px solid #334155;">Excellent UL margin</td></tr>' +
            '    <tr><td style="padding:7px; border:1px solid #334155;">10-18 dBm</td><td style="padding:7px; border:1px solid #334155;">Normal</td></tr>' +
            '    <tr><td style="padding:7px; border:1px solid #334155;">&gt; 21 dBm</td><td style="padding:7px; border:1px solid #334155;">UL-limited / coverage issue</td></tr>' +
            '    <tr><td style="padding:7px; border:1px solid #334155;">>= 23 dBm</td><td style="padding:7px; border:1px solid #334155;">Near UE power cap</td></tr>' +
            '  </tbody>' +
            '</table>' +
            '<div style="font-size:12px; color:#94a3b8; margin-top:8px;">UE max power is typically about 23-24 dBm.</div>';
        if (typeof overlay.__openActionModal === 'function') overlay.__openActionModal();
        else overlay.style.display = 'flex';
    }

    function openResolvePilotPollutionDetails(session) {
        ensureActionModal();
        const overlay = document.getElementById('actionModalOverlay');
        const titleEl = document.getElementById('actionModalTitle');
        const bodyEl = document.getElementById('actionModalBody');
        const pp = session?.umts?.classification?.pilotPollution || session?.classification?.pilotPollution || session?.pilotPollution || null;
        const overlapLevel = String(pp?.dominanceLevel || '').toUpperCase();
        titleEl.textContent = 'Resolve Pilot Pollution';

        if (overlapLevel !== 'HIGH') {
            bodyEl.innerHTML = '' +
                '<div style="padding:12px; border-radius:12px; border:1px solid rgba(148,163,184,0.35); background:rgba(15,23,42,0.6); color:#d1d5db;">' +
                'This playbook is intended for <b>Overlap / dominance risk: High</b>.<br>' +
                'Current overlap/dominance risk: <b>' + escapeHtml(pp?.dominanceLevel || 'Unknown') + '</b>.' +
                '</div>';
            if (typeof overlay.__openActionModal === 'function') overlay.__openActionModal();
            else overlay.style.display = 'flex';
            return;
        }

        const formatResolveBody = (text) => {
            const lines = String(text || '').split('\n');
            return lines.map((line) => {
                if (/^\s*[0-9]+️⃣\s+/.test(line)) {
                    return '<span style="font-weight:800; color:#e2e8f0;">' + line + '</span>';
                }
                return line;
            }).join('\n');
        };
        const secCard = (title, body) => '' +
            '<div style="margin-top:10px; padding:13px; border-radius:12px; border:1px solid rgba(148,163,184,0.22); background:linear-gradient(180deg, rgba(15,23,42,0.9), rgba(15,23,42,0.65));">' +
            '<div style="font-size:16px; font-weight:900; color:#93c5fd; margin-bottom:8px; letter-spacing:0.01em;">' + title + '</div>' +
            '<div style="white-space:pre-line; color:#d1d5db; line-height:1.55; font-size:12.5px;">' + formatResolveBody(body) + '</div>' +
            '</div>';
        const pCard = (label, color, body) => '' +
            '<div style="margin-top:10px; padding:13px; border-radius:12px; border:1px solid ' + color + '; background:rgba(15,23,42,0.72);">' +
            '<div style="display:inline-block; font-size:13px; font-weight:900; color:#e2e8f0; background:' + color.replace('0.45', '0.22') + '; border:1px solid ' + color + '; border-radius:999px; padding:3px 11px; margin-bottom:8px; letter-spacing:0.01em;">' + label + '</div>' +
            '<div style="white-space:pre-line; color:#d1d5db; line-height:1.55; font-size:12.5px;">' + formatResolveBody(body) + '</div>' +
            '</div>';
        bodyEl.innerHTML = '' +
            '<div style="padding:12px; border-radius:12px; border:1px solid rgba(59,130,246,0.35); background:linear-gradient(135deg, rgba(30,64,175,0.18), rgba(2,132,199,0.08)); color:#dbeafe; font-size:13px; line-height:1.6;">' +
            '<b>Condition matched:</b> Overlap / dominance risk is <b>High</b>. This playbook targets cell-edge dominance collapse.' +
            '</div>' +
            secCard('🔍 What does “High overlap / poor dominance under weak coverage” mean?',
                'It means:\n\n' +
                'RSCP is weak to moderate (e.g. −86 to −95 dBm)\n' +
                'Multiple pilots are received at almost identical power (ΔRSCP ≈ 0–2 dB)\n' +
                'Active-set proxy high (3–4 pilots within 3 dB)\n' +
                'EcNo poor (because power is low and energy spreads across pilots)\n' +
                'UE often near cell edge\n' +
                'Setup failures or drops happen when mobility or UL margin collapses\n\n' +
                'This is not classic interference (strong RSCP + bad EcNo).\n' +
                'It is a cell-edge dominance collapse.'
            ) +
            secCard('📡 What physically happens on the network',
                'At cell edge:\n\n' +
                'No pilot dominates.\n' +
                'Energy is split between 2–4 cells.\n' +
                'UE cannot lock cleanly to one serving cell.\n' +
                'SHO may try to help, but uplink becomes weak.\n' +
                'Setup procedures (RRC/CC) are sensitive to instability.\n' +
                'Failures cluster at border zones.\n\n' +
                'So it’s more of a coverage geometry problem than a pure interference problem.'
            ) +
            secCard('🚦 Engineering Interpretation',
                'This condition typically indicates one (or more) of:\n\n' +
                'Border between sectors/sites poorly aligned\n' +
                'Too much overlap from neighbors (overshoot)\n' +
                'Inadequate dominance planning\n' +
                'Wrong tilt/azimuth causing edge-to-edge fighting\n' +
                'Layer misbalance (900/2100 edge conflict)\n' +
                'HO thresholds too late (UE remains too long in weak cell)'
            ) +
            '<div style="margin-top:14px; font-size:18px; font-weight:900; color:#67e8f9; letter-spacing:0.01em;">🛠 Recommended Actions (Structured + Prioritized)</div>' +
            '<div style="font-size:12px; color:#94a3b8; margin-top:4px;">Below is what your analyzer should output for this condition.</div>' +
            pCard('🔥 P0 – Immediate (High Impact)', 
                'rgba(248,113,113,0.45)',
                '1️⃣ Improve Dominance at Cell Edge\n' +
                'Generate ΔRSCP dominance map along the failing segment.\n' +
                'Identify the 2–3 strongest PSCs involved.\n' +
                'Check mechanical/electrical tilt alignment.\n' +
                'Reduce overlap if excessive (slight down-tilt on overshooter).\n' +
                'Ensure one sector clearly dominates by ≥4–5 dB in the border area.\n' +
                'Owner: RAN Optimization\n' +
                '2️⃣ Validate Border Geometry\n' +
                'Overlay GPS route on serving cell coverage footprint.\n' +
                'Check if failure cluster is exactly on inter-site border.\n' +
                'Verify azimuth orientation and sector boundary alignment.\n' +
                'Confirm no cross-sector beam overlap > expected.\n' +
                'Owner: RAN Planning\n' +
                '3️⃣ Validate UL Margin\n' +
                'Even if RSCP is weak but not terrible, check UE Tx in this zone.\n' +
                'If UE Tx rises > 20–21 dBm before failure → UL-limited.\n' +
                'If UL-limited, fix UL margin before anything else.\n' +
                'Owner: RAN Optimization'
            ) +
            pCard('⚙️ P1 – Parameter Optimization',
                'rgba(250,204,21,0.45)',
                '4️⃣ Tune HO Thresholds\n' +
                'If UE remains too long in weak serving cell:\n' +
                'Slightly increase Event 1A threshold\n' +
                'Adjust hysteresis/TTT to allow earlier HO\n' +
                'Reduce ping-pong risk after changes\n' +
                'Goal:\n' +
                'Move UE earlier to stronger cell before setup attempt.\n' +
                '5️⃣ Review Neighbor Definitions\n' +
                'Ensure all strongest pilots in overlap zone are declared neighbors.\n' +
                'Check IFHO/IRAT fallback configuration.\n' +
                'Confirm no missing PSC definitions.'
            ) +
            pCard('📊 P2 – Structural / Longer-Term',
                'rgba(96,165,250,0.45)',
                '6️⃣ Rebalance Layer Strategy\n' +
                'If 900 & 2100 overlap poorly:\n' +
                'Define clear dominance strategy (e.g., 900 for coverage, 2100 for capacity).\n' +
                'Adjust layer priority or thresholds.\n' +
                '7️⃣ Consider Densification (if persistent)\n' +
                'If overlap area is wide and chronic:\n' +
                'Micro-site\n' +
                'Carrier rebalancing\n' +
                'Sector splitting'
            );
        if (typeof overlay.__openActionModal === 'function') overlay.__openActionModal();
        else overlay.style.display = 'flex';
    }

    function ensureActionLinkDelegation() {
        if (window.__actionLinkDelegationBound) return;
        document.addEventListener('click', (e) => {
            const a = e.target && e.target.closest ? e.target.closest('a.action-link') : null;
            if (!a) return;
            e.preventDefault();
            const actionId = a.getAttribute('data-action-id');
            if (!actionId) return;
            if (actionId === 'RESOLVE_PILOT_POLLUTION') {
                const current = window.selectedUmtsSession || null;
                openResolvePilotPollutionDetails(current);
                return;
            }
            const current = window.selectedUmtsSession || null;
            renderActionDetail(actionId, current);
        });
        document.addEventListener('click', (e) => {
            const btn = e.target && e.target.closest ? e.target.closest('button.btn-see-more-pp') : null;
            if (!btn) return;
            e.preventDefault();
            const current = window.selectedUmtsSession || null;
            if (current) openPilotPollutionDetails(current);
        });
        document.addEventListener('click', (e) => {
            const btn = e.target && e.target.closest ? e.target.closest('button.btn-ue-tx-help') : null;
            if (!btn) return;
            e.preventDefault();
            openUeTxP90Details();
        });
        document.addEventListener('click', (e) => {
            const btn = e.target && e.target.closest ? e.target.closest('button.btn-mini-chart-zoom') : null;
            if (!btn) return;
            e.preventDefault();
            const targetId = btn.getAttribute('data-target');
            const op = btn.getAttribute('data-op');
            if (targetId) applyMiniChartZoom(targetId, op || 'reset');
        });
        document.addEventListener('wheel', (e) => {
            const scroller = e.target && e.target.closest ? e.target.closest('.mini-chart-scroll') : null;
            if (!scroller) return;
            const stage = scroller.querySelector('.mini-chart-stage');
            if (!stage || !stage.id) return;
            e.preventDefault();
            const op = e.deltaY < 0 ? 'in' : 'out';
            applyMiniChartZoom(stage.id, op);
        }, { passive: false });
        let miniChartDrag = null;
        document.addEventListener('mousedown', (e) => {
            const scroller = e.target && e.target.closest ? e.target.closest('.mini-chart-scroll') : null;
            if (!scroller) return;
            const stage = scroller.querySelector('.mini-chart-stage');
            if (!stage || !stage.id) return;
            const wrap = stage.closest('.mini-chart-zoom-wrap');
            const payloadTxt = wrap ? (wrap.getAttribute('data-chart-payload') || '') : '';
            if (!payloadTxt) return;
            let payload = null;
            try { payload = JSON.parse(decodeURIComponent(payloadTxt)); } catch (err) { payload = null; }
            if (!payload) return;
            miniChartDrag = {
                stage,
                scroller,
                payload,
                startX: e.clientX,
                panStart: Number(stage.getAttribute('data-pan-ms') || '0') || 0,
                zoom: Number(stage.getAttribute('data-zoom') || '1') || 1
            };
            scroller.style.cursor = 'grabbing';
            e.preventDefault();
        });
        document.addEventListener('mousemove', (e) => {
            if (!miniChartDrag) return;
            const rawSpan = getMiniChartRawSpanMs(miniChartDrag.payload);
            if (!Number.isFinite(rawSpan) || rawSpan <= 0) return;
            const visibleSpan = rawSpan / Math.max(1, miniChartDrag.zoom);
            const widthPx = Math.max(1, miniChartDrag.scroller.clientWidth || 1);
            const msPerPx = visibleSpan / widthPx;
            const dx = e.clientX - miniChartDrag.startX;
            const nextPan = miniChartDrag.panStart + (dx * msPerPx);
            miniChartDrag.stage.setAttribute('data-pan-ms', String(nextPan));
            rerenderMiniChartStage(miniChartDrag.stage);
            e.preventDefault();
        });
        document.addEventListener('mouseup', () => {
            if (!miniChartDrag) return;
            if (miniChartDrag.scroller) miniChartDrag.scroller.style.cursor = 'grab';
            miniChartDrag = null;
        });
        window.__actionLinkDelegationBound = true;
    }

    const renderDropAnalysis = (log, session) => {
        ensureActionLinkDelegation();
        ensureDropAnalysisModal();
        const titleEl = document.getElementById('dropAnalysisTitle');
        const bodyEl = document.getElementById('dropAnalysisBody');
        if (!titleEl || !bodyEl) return;
        const umtsClassification = session?.umts?.classification || null;
        const umtsSnapshot = session?.umts?.snapshot || null;
        const isAuthoritativeUmtsSession = (session?._source === 'umts') && (session?.kind === 'UMTS_CALL') && !!umtsClassification;
        if (isAuthoritativeUmtsSession) {
            window.selectedUmtsSession = session;
            const isSetupFailure = umtsClassification.resultType === 'CALL_SETUP_FAILURE';
            const caseLabel = isSetupFailure ? 'Setup Failure' : (umtsClassification.resultType === 'DROP_CALL' ? 'Drop Call' : 'Call Result');
            const trendMessage = umtsSnapshot?.trendMessage || 'No MIMOMEAS samples in last 10s.';
            const sampleCount = Number.isFinite(umtsSnapshot?.mimoSampleCount) ? umtsSnapshot.mimoSampleCount : (Number.isFinite(umtsSnapshot?.sampleCount) ? umtsSnapshot.sampleCount : 0);
            const timeline = Array.isArray(session?.eventTimeline) ? session.eventTimeline : [];
            const timelineHtml = timeline.length
                ? timeline.map(e => '<div style=\"margin-bottom:3px;\">' + (e.time || '-') + ' - ' + (e.event || '-') + '</div>').join('')
                : '<div style=\"color:#9ca3af;\">No events in session window.</div>';
            const fmt = (v, unit) => (typeof v === 'number' && !Number.isNaN(v)) ? (v.toFixed(1) + (unit ? (' ' + unit) : '')) : 'N/A';
            const statusBadge = (ok) => {
                if (ok === null) return '<span style="margin-left:8px; padding:1px 7px; border-radius:999px; font-size:10px; font-weight:700; color:#cbd5e1; background:rgba(100,116,139,0.25); border:1px solid rgba(148,163,184,0.35);">N/A</span>';
                return ok
                    ? '<span style="margin-left:8px; padding:1px 7px; border-radius:999px; font-size:10px; font-weight:700; color:#bbf7d0; background:rgba(22,163,74,0.22); border:1px solid rgba(74,222,128,0.45);">OK</span>'
                    : '<span style="margin-left:8px; padding:1px 7px; border-radius:999px; font-size:10px; font-weight:700; color:#fecaca; background:rgba(220,38,38,0.20); border:1px solid rgba(248,113,113,0.45);">NOK</span>';
            };
            const metricLine = (label, valueText, ok, thresholdText) => {
                const color = ok === null ? '#d1d5db' : (ok ? '#22c55e' : '#ef4444');
                const hint = thresholdText ? ` <span style="color:#94a3b8; font-size:11px;">(${thresholdText})</span>` : '';
                return `<span style="color:${color};">${label}: ${valueText}</span>${hint}${statusBadge(ok)}`;
            };
            const thresholdProfileByCategory = (category) => {
                const c = String(category || '').toUpperCase();
                if (c === 'DROP_INTERFERENCE' || c === 'SETUP_FAIL_DL_INTERFERENCE') {
                    return { rscpMinOk: -90, ecnoMinOk: -12, blerMaxOk: 10, txP90MaxOk: 18 };
                }
                if (c === 'DROP_COVERAGE_UL' || c === 'SETUP_FAIL_UL_COVERAGE') {
                    return { rscpMinOk: -98, ecnoMinOk: -16, blerMaxOk: 30, txP90MaxOk: 20 };
                }
                if (c === 'DROP_COVERAGE_DL') {
                    return { rscpMinOk: -105, ecnoMinOk: -13, blerMaxOk: 25, txP90MaxOk: 21 };
                }
                if (c === 'SETUP_TIMEOUT') {
                    return { rscpMinOk: -95, ecnoMinOk: -14, blerMaxOk: 30, txP90MaxOk: 21 };
                }
                return { rscpMinOk: -95, ecnoMinOk: -14, blerMaxOk: 20, txP90MaxOk: 21 };
            };
            const metricProfile = thresholdProfileByCategory(umtsClassification?.category);
            const rscpOk = Number.isFinite(umtsSnapshot?.rscpMedian) ? (umtsSnapshot.rscpMedian > metricProfile.rscpMinOk) : null;
            const ecnoOk = Number.isFinite(umtsSnapshot?.ecnoMedian) ? (umtsSnapshot.ecnoMedian > metricProfile.ecnoMinOk) : null;
            const blerOk = Number.isFinite(umtsSnapshot?.blerMax) ? (umtsSnapshot.blerMax < metricProfile.blerMaxOk) : null;
            const txOk = Number.isFinite(umtsSnapshot?.txP90) ? (umtsSnapshot.txP90 < metricProfile.txP90MaxOk) : null;
            const interpretUeTxP90 = (txP90) => {
                if (!Number.isFinite(txP90)) {
                    return { label: 'N/A', color: '#94a3b8', bg: 'rgba(100,116,139,0.2)', border: 'rgba(148,163,184,0.35)', why: 'No valid UE Tx p90 sample in window.' };
                }
                if (txP90 >= 23) {
                    return { label: 'Near UE power cap', color: '#fecaca', bg: 'rgba(220,38,38,0.20)', border: 'rgba(248,113,113,0.45)', why: 'UE is transmitting close to maximum power; uplink margin is critically low.' };
                }
                if (txP90 > 21) {
                    return { label: 'UL-limited / coverage issue', color: '#fecaca', bg: 'rgba(220,38,38,0.20)', border: 'rgba(248,113,113,0.45)', why: 'High UE Tx indicates uplink-limited conditions or weak indoor/edge coverage.' };
                }
                if (txP90 < 10) {
                    return { label: 'Excellent UL margin', color: '#93c5fd', bg: 'rgba(37,99,235,0.20)', border: 'rgba(96,165,250,0.45)', why: 'UE transmits with low power, indicating strong uplink margin.' };
                }
                return { label: 'Normal', color: '#bbf7d0', bg: 'rgba(22,163,74,0.22)', border: 'rgba(74,222,128,0.45)', why: 'UE Tx is in typical operating range for stable uplink.' };
            };
            const txInterpretation = interpretUeTxP90(umtsSnapshot?.txP90);
            const txInterpretationHtml = '' +
                '<div style="margin-top:4px; margin-bottom:6px; font-size:11px; color:#d1d5db;">' +
                '<span style="display:inline-block; padding:2px 8px; border-radius:999px; font-weight:700; color:' + txInterpretation.color + '; background:' + txInterpretation.bg + '; border:1px solid ' + txInterpretation.border + ';">' + txInterpretation.label + '</span>' +
                '<span style="margin-left:8px; color:#94a3b8;">' + txInterpretation.why + '</span>' +
                '</div>';
            const metricStateLabel = (ok) => ok === null ? 'N/A' : (ok ? 'OK' : 'NOK');
            const explanationMetricStatuses = [
                `RSCP median status: ${metricStateLabel(rscpOk)}`,
                `EcNo median status: ${metricStateLabel(ecnoOk)}`,
                `BLER max status: ${metricStateLabel(blerOk)}`,
                `UE Tx p90 status: ${metricStateLabel(txOk)}`
            ];
            const explanationMetricStatusesHtml = [
                '- ' + decorateOkNokText(explanationMetricStatuses[0]),
                '- ' + decorateOkNokText(explanationMetricStatuses[1]),
                '- ' + decorateOkNokText(explanationMetricStatuses[2]),
                '- ' + (txOk === false
                    ? ('UE Tx p90 status: ' + okNokBadgeHtml('NOK') + ' <button class="btn-ue-tx-help" style="margin-left:8px; background:#111827; border:1px solid rgba(248,113,113,0.45); color:#fecaca; padding:2px 8px; border-radius:8px; cursor:pointer; font-size:10px;">Why?</button>')
                    : decorateOkNokText(explanationMetricStatuses[3]))
            ];
            const evidence = Array.isArray(umtsClassification.evidence) ? umtsClassification.evidence : [];
            const explanation = umtsClassification.explanation || {};
            const whyWeThinkSo = Array.isArray(explanation.whyWeThinkSo) ? explanation.whyWeThinkSo : [];
            const recommendations = Array.isArray(umtsClassification.recommendations) ? umtsClassification.recommendations : [];
            const oneParagraphSummary = umtsClassification.oneParagraphSummary || umtsClassification.reason || '-';
            const contextBundle = session?.umts?.contextBundle || session?.contextBundle || null;
            const showContextBundle = isSetupFailure && !!contextBundle;
            const pilotPollution = umtsClassification.pilotPollution || null;
            const ppScore = Number.isFinite(pilotPollution?.score) ? pilotPollution.score : (Number.isFinite(pilotPollution?.pollutionScore) ? pilotPollution.pollutionScore : null);
            const ppLevel = pilotPollution?.riskLevel || pilotPollution?.pollutionLevel || null;
            const ppDominanceScore = Number.isFinite(pilotPollution?.dominanceScore) ? pilotPollution.dominanceScore : null;
            const ppDominanceLevel = pilotPollution?.dominanceLevel || null;
            const ppInterferenceScore = Number.isFinite(pilotPollution?.interferenceScore) ? pilotPollution.interferenceScore : null;
            const ppInterferenceLevel = pilotPollution?.interferenceLevel || null;
            const ppFinalLabel = pilotPollution?.finalLabel || null;
            const ppDominanceAvailable = pilotPollution?.dominanceAvailable !== false;
            const pilotPollutionText = (!ppDominanceAvailable)
                ? `N/A (0/${Number.isFinite(pilotPollution?.deltaStats?.totalMimoSamples) ? pilotPollution.deltaStats.totalMimoSamples : 0} >=2-pilot)`
                : ((ppScore !== null && ppLevel) ? `${ppLevel} (${ppScore}%)` : 'n/a');
            const pilotPollutionBadge = (() => {
                if (!ppDominanceAvailable) {
                    return '<span style="display:inline-block; margin-left:8px; padding:2px 8px; border-radius:999px; font-size:11px; font-weight:700; color:#cbd5e1; background:rgba(100,116,139,0.25); border:1px solid rgba(148,163,184,0.35);">Pilot Pollution: N/A (no >=2 pilots)</span>';
                }
                if (ppScore === null || !ppLevel) {
                    return '<span style="display:inline-block; margin-left:8px; padding:2px 8px; border-radius:999px; font-size:11px; font-weight:700; color:#cbd5e1; background:rgba(100,116,139,0.25); border:1px solid rgba(148,163,184,0.35);">Pilot Pollution: N/A</span>';
                }
                if (ppLevel === 'High') {
                    return '<span style="display:inline-block; margin-left:8px; padding:2px 8px; border-radius:999px; font-size:11px; font-weight:700; color:#fecaca; background:rgba(220,38,38,0.20); border:1px solid rgba(248,113,113,0.45);">Pilot Pollution: High</span>';
                }
                if (ppLevel === 'Moderate') {
                    return '<span style="display:inline-block; margin-left:8px; padding:2px 8px; border-radius:999px; font-size:11px; font-weight:700; color:#fde68a; background:rgba(202,138,4,0.20); border:1px solid rgba(250,204,21,0.45);">Pilot Pollution: Moderate</span>';
                }
                return '<span style="display:inline-block; margin-left:8px; padding:2px 8px; border-radius:999px; font-size:11px; font-weight:700; color:#bbf7d0; background:rgba(22,163,74,0.22); border:1px solid rgba(74,222,128,0.45);">Pilot Pollution: Low</span>';
            })();
            const toNumOrNull = (v) => {
                if (Number.isFinite(v)) return Number(v);
                const n = Number.parseInt(String(v ?? '').trim(), 10);
                return Number.isFinite(n) ? n : null;
            };
            const decodeCadCauseUi = (cause) => {
                const map = {
                    16: 'Normal call clearing',
                    17: 'User busy',
                    18: 'No user responding',
                    19: 'No answer from user',
                    21: 'Call rejected',
                    27: 'Destination out of order',
                    34: 'No circuit/channel available',
                    41: 'Temporary failure',
                    42: 'Switching equipment congestion',
                    47: 'Resource unavailable',
                    102: 'Setup timeout'
                };
                return map[cause] || 'Unknown cause';
            };
            const renderCadCauseBadge = (causeVal) => {
                const cause = toNumOrNull(causeVal);
                if (!Number.isFinite(cause)) {
                    return '<span style="display:inline-block; margin-left:8px; padding:2px 8px; border-radius:999px; font-size:11px; font-weight:700; color:#cbd5e1; background:rgba(100,116,139,0.25); border:1px solid rgba(148,163,184,0.35);">Cause: N/A</span>';
                }
                const label = `Cause ${cause}: ${decodeCadCauseUi(cause)}`;
                if (cause === 16) {
                    return '<span style="display:inline-block; margin-left:8px; padding:2px 8px; border-radius:999px; font-size:11px; font-weight:700; color:#bbf7d0; background:rgba(22,163,74,0.22); border:1px solid rgba(74,222,128,0.45);">' + escapeHtml(label) + '</span>';
                }
                if (cause === 102 || [18, 19, 34, 41, 42, 47].includes(cause)) {
                    return '<span style="display:inline-block; margin-left:8px; padding:2px 8px; border-radius:999px; font-size:11px; font-weight:700; color:#fecaca; background:rgba(220,38,38,0.20); border:1px solid rgba(248,113,113,0.45);">' + escapeHtml(label) + '</span>';
                }
                return '<span style="display:inline-block; margin-left:8px; padding:2px 8px; border-radius:999px; font-size:11px; font-weight:700; color:#fde68a; background:rgba(202,138,4,0.20); border:1px solid rgba(250,204,21,0.45);">' + escapeHtml(label) + '</span>';
            };
            const cadCauseForBadges = toNumOrNull(
                session?.umts?.setupFailureDeepAnalysis?.signalingAssessment?.cadCause ??
                session?.setupFailureDeepAnalysis?.signalingAssessment?.cadCause ??
                contextBundle?.callControlContext?.cadCause ??
                null
            );
            const cadCauseBadge = renderCadCauseBadge(cadCauseForBadges);
            const ppDetails = pilotPollution?.details || {};
            const ppDelta = pilotPollution?.deltaStats || {};
            const ppStrong = pilotPollution?.strongRscpBadEcno || {};
            const ppActive = pilotPollution?.activeSet || {};
            const pilotPollutionEvidence = [];
            if (Number.isFinite(ppDetails.deltaMedian)) pilotPollutionEvidence.push(`ΔRSCP median: ${ppDetails.deltaMedian.toFixed(2)} dB`);
            if (Number.isFinite(ppDetails.deltaRatio)) pilotPollutionEvidence.push(`ΔRSCP<3 dB ratio: ${(ppDetails.deltaRatio * 100).toFixed(0)}%`);
            else if (Number.isFinite(ppDelta.samplesWith2Pilots) && Number(ppDelta.samplesWith2Pilots) === 0) pilotPollutionEvidence.push('ΔRSCP<3 dB ratio: n/a (0/0)');
            if (Number.isFinite(ppDetails.deltaStd)) pilotPollutionEvidence.push(`ΔRSCP std: ${ppDetails.deltaStd.toFixed(2)} dB`);
            if (Number.isFinite(ppDetails.badEcnoStrongRscpRatio)) pilotPollutionEvidence.push(`Strong-RSCP with bad EcNo ratio: ${(ppDetails.badEcnoStrongRscpRatio * 100).toFixed(0)}%`);
            if (Number.isFinite(ppDetails.pscSwitchCount)) pilotPollutionEvidence.push(`Best PSC switches: ${ppDetails.pscSwitchCount}`);
            if (Number.isFinite(ppDetails.activeSetMean) || Number.isFinite(ppDetails.activeSetMax)) {
                const asMean = Number.isFinite(ppDetails.activeSetMean) ? ppDetails.activeSetMean.toFixed(2) : 'n/a';
                const asMax = Number.isFinite(ppDetails.activeSetMax) ? ppDetails.activeSetMax : 'n/a';
                pilotPollutionEvidence.push(`Active set mean/max: ${asMean} / ${asMax}`);
            }
            if (Number.isFinite(ppDelta.samplesWith2Pilots) && Number.isFinite(ppDelta.totalMimoSamples)) {
                pilotPollutionEvidence.push(`Dominance denominator (>=2 pilots): ${ppDelta.samplesWith2Pilots}/${ppDelta.totalMimoSamples}`);
            }
            const strongB = Number.isFinite(ppStrong.denomBestValid) ? ppStrong.denomBestValid : 0;
            const strongN = Number.isFinite(ppStrong.denomTotalMimo) ? ppStrong.denomTotalMimo : 0;
            const strongS = Number.isFinite(ppStrong.strongCount) ? ppStrong.strongCount : 0;
            const strongSB = Number.isFinite(ppStrong.strongBadCount) ? ppStrong.strongBadCount : 0;
            const strongShare = Number.isFinite(ppStrong.ratioStrongShare) ? `${(ppStrong.ratioStrongShare * 100).toFixed(0)}%` : 'n/a';
            const strongBad = Number.isFinite(ppStrong.ratioBad) ? `${(ppStrong.ratioBad * 100).toFixed(0)}%` : 'n/a';
            pilotPollutionEvidence.push(`Strong RSCP share: ${strongShare} (${strongS}/${strongB})`);
            pilotPollutionEvidence.push(`Strong RSCP + bad EcNo: ${strongBad} (${strongSB}/${strongS})`);
            if (strongB || strongN) pilotPollutionEvidence.push(`Best-server denominator: ${strongB}/${strongN}`);
            if (Number.isFinite(ppActive.mean) || Number.isFinite(ppActive.max)) {
                const asMean = Number.isFinite(ppActive.mean) ? ppActive.mean.toFixed(2) : 'n/a';
                const asMax = Number.isFinite(ppActive.max) ? ppActive.max : 'n/a';
                pilotPollutionEvidence.push(`Active set proxy mean/max: ${asMean} / ${asMax}`);
            }
            const confidencePct = Math.round((Number(umtsClassification.confidence) || 0) * 100);
            const parseCsvLite = (line) => String(line || '').split(',');
            const parseDec = (v) => {
                const n = parseFloat(v);
                return Number.isFinite(n) ? n : null;
            };
            const servingCellName = (() => {
                const psc = umtsSnapshot?.lastPsc;
                const uarfcn = umtsSnapshot?.lastUarfcn;
                if (window.resolveSmartSite && Number.isFinite(psc)) {
                    const r = window.resolveSmartSite({ sc: psc, freq: uarfcn, pci: psc });
                    if (r && r.name && r.name !== 'Unknown') return r.name;
                }
                if (Number.isFinite(psc) && Number.isFinite(uarfcn)) return `PSC ${psc} / UARFCN ${uarfcn}`;
                if (Number.isFinite(psc)) return `PSC ${psc}`;
                return 'Unknown';
            })();
            const chartHtml = (() => {
                const rscpRaw = Array.isArray(umtsSnapshot?.seriesRscp) ? umtsSnapshot.seriesRscp : [];
                const ecnoRaw = Array.isArray(umtsSnapshot?.seriesEcno) ? umtsSnapshot.seriesEcno : [];
                const rscpSeries = rscpRaw
                    .map(p => ({ t: Number(p?.ts), v: Number(p?.value) }))
                    .filter(p => Number.isFinite(p.t) && Number.isFinite(p.v));
                const ecnoSeries = ecnoRaw
                    .map(p => ({ t: Number(p?.ts), v: Number(p?.value) }))
                    .filter(p => Number.isFinite(p.t) && Number.isFinite(p.v));
                if (!rscpSeries.length && !ecnoSeries.length) {
                    return '<div style="font-size:12px; color:#9ca3af; margin-top:6px;">No RSCP/EcNo chart samples in window.</div>';
                }

                const baseSeries = rscpSeries.length ? rscpSeries : ecnoSeries;
                const constFreq = Number.isFinite(umtsSnapshot?.lastUarfcn) ? Number(umtsSnapshot.lastUarfcn) : null;
                const constName = (Number.isFinite(umtsSnapshot?.lastPsc) && Number.isFinite(umtsSnapshot?.lastUarfcn))
                    ? `${Number(umtsSnapshot.lastPsc)}/${Number(umtsSnapshot.lastUarfcn)}`
                    : null;
                const freqSeries = constFreq === null ? [] : baseSeries.map(p => ({ t: p.t, v: constFreq }));
                const cellNameSeries = constName ? baseSeries.map(p => ({ t: p.t, v: constName })) : [];

                const minTs = Math.min(...baseSeries.map(p => p.t));
                const maxTs = Math.max(...baseSeries.map(p => p.t));
                const dayMs = 24 * 3600 * 1000;
                const seriesLooksAbsolute = maxTs >= dayMs;
                const absAnchor = Number.isFinite(umtsSnapshot?.windowEndTs) && umtsSnapshot.windowEndTs >= dayMs
                    ? umtsSnapshot.windowEndTs
                    : NaN;
                const toTodMs = (absMs) => {
                    const d = new Date(absMs);
                    return (((d.getUTCHours() * 60 + d.getUTCMinutes()) * 60 + d.getUTCSeconds()) * 1000) + d.getUTCMilliseconds();
                };
                const alignToSeriesDomain = (rawTime) => {
                    const parsed = parseSessionTimeToMs(rawTime);
                    if (!Number.isFinite(parsed)) return NaN;
                    if (seriesLooksAbsolute) {
                        if (parsed >= dayMs) return parsed;
                        if (!Number.isFinite(absAnchor)) return NaN;
                        const base = new Date(absAnchor);
                        const dayStartUtc = Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), 0, 0, 0, 0);
                        const c0 = dayStartUtc + parsed;
                        const c1 = c0 - dayMs;
                        const c2 = c0 + dayMs;
                        const ref = maxTs;
                        const candidates = [c0, c1, c2];
                        candidates.sort((a, b) => Math.abs(a - ref) - Math.abs(b - ref));
                        return candidates[0];
                    }
                    return parsed >= dayMs ? toTodMs(parsed) : parsed;
                };

                const markerCandidates = [
                    session?.markerTime,
                    session?.markerTsIso,
                    Number.isFinite(umtsSnapshot?.lastMimoTs) ? umtsSnapshot.lastMimoTs : null,
                    Number.isFinite(umtsSnapshot?.windowEndTs) ? umtsSnapshot.windowEndTs : null,
                    session?.endTime
                ];
                let markerTs = NaN;
                for (let i = 0; i < markerCandidates.length; i++) {
                    const aligned = alignToSeriesDomain(markerCandidates[i]);
                    if (Number.isFinite(aligned)) {
                        markerTs = Math.max(minTs, Math.min(maxTs, aligned));
                        break;
                    }
                }
                const markerEvents = Number.isFinite(markerTs) ? [{ t: markerTs, label: 'SETUP FAIL' }] : [];
                const miniTrend = buildMiniTrendSvg(
                    rscpSeries,
                    ecnoSeries,
                    freqSeries,
                    cellNameSeries,
                    markerEvents,
                    { finalEventLabel: 'SETUP FAIL', endTickLabel: '0s(fail)', showDefaultFinalMarker: true }
                );
                const zoomableMiniTrend = buildZoomableMiniTrend(miniTrend, `${session?.sessionId || 'umts'}_main`, {
                    rscpSeries,
                    ecnoSeries,
                    freqSeries,
                    cellNameSeries,
                    markerEvents,
                    options: { finalEventLabel: 'SETUP FAIL', endTickLabel: '0s(fail)', showDefaultFinalMarker: true }
                });
                return '' +
                    '<div style="margin-top:8px; font-size:12px; color:#d1d5db;">Serving cell: <b>' + servingCellName + '</b></div>' +
                    '<div style="margin-top:8px; font-size:12px; font-weight:600; color:#bfdbfe; margin-bottom:6px;">RSCP / EcNo Mini Trend (Last 10s)</div>' +
                    zoomableMiniTrend;
            })();

            titleEl.textContent = caseLabel + ' Analysis - ' + (session?.sessionId || 'Session');
            const recRows = recommendations.length
                ? recommendations.map(r => (
                    (() => {
                        const actionId = r.actionId || '';
                        const actionText = r.action || '-';
                        const actionHtml = actionId
                            ? '<a href="#" class="action-link" data-action-id="' + actionId + '" style="color:#93c5fd; text-decoration:underline;">' + actionText + '</a>'
                            : actionText;
                        return (
                    '<tr>' +
                    '<td style="padding:6px; border:1px solid #334155;">' + (r.priority || '-') + '</td>' +
                    '<td style="padding:6px; border:1px solid #334155;">' + actionHtml + '</td>' +
                    '<td style="padding:6px; border:1px solid #334155;">' + (r.rationale || '-') + '</td>' +
                    '<td style="padding:6px; border:1px solid #334155;">' + (r.ownerHint || '-') + '</td>' +
                    '</tr>'
                        );
                    })()
                )).join('')
                : '<tr><td colspan="4" style="padding:6px; border:1px solid #334155; color:#9ca3af;">No recommendations provided.</td></tr>';
            const renderTimelineRows = (rows, emptyText) => {
                if (!Array.isArray(rows) || rows.length === 0) return '<div style="color:#9ca3af;">' + escapeHtml(emptyText) + '</div>';
                return rows.map((r) => (
                    '<div style="margin-bottom:4px;">' +
                    '<span style="color:#93c5fd;">' + escapeHtml(r?.tsIso || '-') + '</span>' +
                    ' <span style="color:#fde68a;">[' + escapeHtml(r?.header || '-') + ']</span>' +
                    '<div style="color:#d1d5db; margin-left:8px;">' + escapeHtml(r?.raw || '-') + '</div>' +
                    '</div>'
                )).join('');
            };
            const contextBundleHtml = (() => {
                if (!showContextBundle) return '';
                if (!contextBundle) {
                    return '<div style="padding:8px; background:#111827; border:1px solid #334155; border-radius:6px; margin-bottom:10px;">' +
                        '<div style="font-size:12px; font-weight:600; color:#bfdbfe; margin-bottom:6px;">Expanded Context Bundle (Auto)</div>' +
                        '<div style="font-size:12px; color:#fca5a5;">Context bundle is unavailable for this session.</div>' +
                        '</div>';
                }
                const w = contextBundle.windows || {};
                const rc = contextBundle.radioContext || {};
                const sc = contextBundle.signalingContext || {};
                const cc = contextBundle.callControlContext || {};
                const fmtC = (v, d = 1) => (Number.isFinite(v) ? Number(v).toFixed(d) : 'N/A');
                const bestSeries = Array.isArray(rc.bestServerSeries) ? rc.bestServerSeries : [];
                const rscpSeriesCtx = bestSeries
                    .map(p => ({ t: Date.parse(p?.tsIso || ''), v: Number(p?.rscp) }))
                    .filter(p => Number.isFinite(p.t) && Number.isFinite(p.v));
                const ecnoSeriesCtx = bestSeries
                    .map(p => ({ t: Date.parse(p?.tsIso || ''), v: Number(p?.ecno) }))
                    .filter(p => Number.isFinite(p.t) && Number.isFinite(p.v));
                const baseCtxSeries = rscpSeriesCtx.length ? rscpSeriesCtx : ecnoSeriesCtx;
                const freqSeriesCtx = bestSeries
                    .map(p => ({ t: Date.parse(p?.tsIso || ''), v: Number(p?.uarfcn) }))
                    .filter(p => Number.isFinite(p.t) && Number.isFinite(p.v));
                const cellNameSeriesCtx = bestSeries
                    .map(p => {
                        const t = Date.parse(p?.tsIso || '');
                        const psc = Number(p?.psc);
                        const uarfcn = Number(p?.uarfcn);
                        if (!Number.isFinite(t) || !Number.isFinite(psc)) return null;
                        return { t, v: Number.isFinite(uarfcn) ? `${psc}/${uarfcn}` : `${psc}` };
                    })
                    .filter(Boolean);
                const contextChartHtml = (() => {
                    if (!baseCtxSeries.length) {
                        return '<div style="font-size:12px; color:#9ca3af; margin-bottom:8px;">No RSCP/EcNo samples available for context chart.</div>';
                    }
                    const minTs = Math.min(...baseCtxSeries.map(p => p.t));
                    const maxTs = Math.max(...baseCtxSeries.map(p => p.t));
                    const clampTs = (v) => Math.max(minTs, Math.min(maxTs, v));
                    const markerTs = (iso) => {
                        const t = Date.parse(iso || '');
                        return Number.isFinite(t) ? clampTs(t) : null;
                    };
                    const markerEvents = [];
                    const setupTs = markerTs(cc.endTsReal || w.radioWindowEndIso);
                    if (Number.isFinite(setupTs)) markerEvents.push({ t: setupTs, label: 'SETUP FAIL', shortLabel: 'FAIL', color: '#ef4444', tsIso: cc.endTsReal || w.radioWindowEndIso || null });
                    const hoTs = markerTs(sc.closestRrcOrHoBeforeEnd?.tsIso);
                    if (Number.isFinite(hoTs)) markerEvents.push({ t: hoTs, label: 'Closest RRCSM/SHO', shortLabel: 'RRCSM/SHO', color: '#22d3ee', tsIso: sc.closestRrcOrHoBeforeEnd?.tsIso || null });
                    const relTs = markerTs(sc.closestReleaseRejectCause?.tsIso);
                    if (Number.isFinite(relTs)) markerEvents.push({ t: relTs, label: 'Closest release/reject/failure', shortLabel: 'REL/REJ', color: '#f59e0b', tsIso: sc.closestReleaseRejectCause?.tsIso || null });

                    const svg = buildMiniTrendSvg(
                        rscpSeriesCtx,
                        ecnoSeriesCtx,
                        freqSeriesCtx,
                        cellNameSeriesCtx,
                        markerEvents,
                        { finalEventLabel: 'SETUP FAIL', endTickLabel: '0s(fail)', showDefaultFinalMarker: false }
                    );
                    const zoomableSvg = buildZoomableMiniTrend(svg, `${session?.sessionId || 'umts'}_context`, {
                        rscpSeries: rscpSeriesCtx,
                        ecnoSeries: ecnoSeriesCtx,
                        freqSeries: freqSeriesCtx,
                        cellNameSeries: cellNameSeriesCtx,
                        markerEvents,
                        options: { finalEventLabel: 'SETUP FAIL', endTickLabel: '0s(fail)', showDefaultFinalMarker: false }
                    });
                    const markerLegend = markerEvents.length
                        ? markerEvents.map((m) => (
                            '<div style="display:flex; align-items:center; gap:6px; margin-right:12px;">' +
                            '<span style="display:inline-block; width:8px; height:8px; border-radius:999px; background:' + escapeHtml(String(m.color || '#94a3b8')) + ';"></span>' +
                            '<span style="color:#cbd5e1;">' + escapeHtml(String(m.label || '-')) + '</span>' +
                            '<span style="color:#93c5fd;">' + escapeHtml(String(m.tsIso || '-')) + '</span>' +
                            '</div>'
                        )).join('')
                        : '<span style="color:#9ca3af;">No markers in context window.</span>';
                    return '' +
                        '<div style="font-size:12px; font-weight:600; color:#bfdbfe; margin:8px 0 6px;">Context Trend (RSCP / EcNo + Key Markers)</div>' +
                        zoomableSvg +
                        '<div style="display:flex; flex-wrap:wrap; align-items:center; gap:4px; font-size:11px; color:#94a3b8; margin-top:6px;">' + markerLegend + '</div>';
                })();
                return '' +
                    '<div style="padding:8px; background:#111827; border:1px solid #334155; border-radius:6px; margin-bottom:10px;">' +
                    '  <div style="font-size:12px; font-weight:700; color:#93c5fd; margin-bottom:8px;">Expanded Context Bundle (Auto)</div>' +
                    '  <div style="display:grid; grid-template-columns: 180px 1fr; gap:6px; font-size:12px; margin-bottom:8px;">' +
                    '    <div style="color:#93c5fd;">Radio Window</div><div>' + escapeHtml((w.radioWindowStartIso || '-') + ' → ' + (w.radioWindowEndIso || '-')) + ' (last ' + escapeHtml(String(w.radioPreEndSec ?? '-')) + 's)</div>' +
                    '    <div style="color:#93c5fd;">Signaling Window</div><div>' + escapeHtml((w.signalingWindowStartIso || '-') + ' → ' + (w.signalingWindowEndIso || '-')) + ' (±' + escapeHtml(String(w.signalingAroundEndSec ?? '-')) + 's)</div>' +
                    '  </div>' +
                    '  <div style="font-size:12px; font-weight:600; color:#bfdbfe; margin:8px 0 4px;">Radio Context</div>' +
                    '  <div style="font-size:12px; color:#d1d5db; line-height:1.5;">' +
                    'MIMOMEAS samples: ' + escapeHtml(String(rc.mimoSampleCount ?? 0)) + '<br>' +
                    'RSCP (min/median/max): ' + fmtC(rc.rscpMin) + ' / ' + fmtC(rc.rscpMedian) + ' / ' + fmtC(rc.rscpMax) + ' dBm<br>' +
                    'EcNo (min/median/max): ' + fmtC(rc.ecnoMin) + ' / ' + fmtC(rc.ecnoMedian) + ' / ' + fmtC(rc.ecnoMax) + ' dB<br>' +
                    'UE Tx (last/p90/max): ' + fmtC(rc.txLast) + ' / ' + fmtC(rc.txP90) + ' / ' + fmtC(rc.txMax) + ' dBm<br>' +
                    'BLER (max/trend): ' + fmtC(rc.blerMax) + ' / ' + fmtC(rc.blerTrend) + '</div>' +
                    contextChartHtml +
                    '  <div style="font-size:12px; font-weight:600; color:#bfdbfe; margin:10px 0 4px;">Call-Control Context</div>' +
                    '  <div style="display:grid; grid-template-columns: 120px 1fr; gap:6px; font-size:12px; margin-bottom:8px;">' +
                    '    <div style="color:#93c5fd;">CAA/CAC</div><div>' + escapeHtml((cc.cAA || '-') + ' / ' + (cc.cACConnected || '-')) + '</div>' +
                    '    <div style="color:#93c5fd;">CAD/CAF/CARE</div><div>' + escapeHtml((cc.cAD || '-') + ' / ' + (cc.cAF || '-') + ' / ' + (cc.cARE || '-')) + '</div>' +
                    '    <div style="color:#93c5fd;">CAD status/cause</div><div>' + escapeHtml(String(cc.cadStatus ?? '-')) + ' / ' + escapeHtml(String(cc.cadCause ?? '-')) + renderCadCauseBadge(cc.cadCause) + '</div>' +
                    '    <div style="color:#93c5fd;">CAF reason</div><div>' + escapeHtml(String(cc.cafReason ?? '-')) + '</div>' +
                    '    <div style="color:#93c5fd;">Connected ever</div><div>' + (cc.connectedEver ? 'Yes' : 'No') + '</div>' +
                    '  </div>' +
                    '  <div style="font-size:12px; font-weight:600; color:#bfdbfe; margin:10px 0 4px;">Signaling Context</div>' +
                    '  <div style="font-size:12px; color:#d1d5db; margin-bottom:6px;">Total events in window: ' + escapeHtml(String(sc.totalEventsInWindow ?? 0)) + '</div>' +
                    '  <div style="font-size:12px; color:#d1d5db; margin-bottom:4px;"><b>Closest RRCSM/SHO before end:</b></div>' +
                    '  <div style="font-size:12px; color:#d1d5db; margin-bottom:8px;">' + renderTimelineRows(sc.closestRrcOrHoBeforeEnd ? [sc.closestRrcOrHoBeforeEnd] : [], 'No RRCSM/SHO event found.') + '</div>' +
                    '  <div style="font-size:12px; color:#d1d5db; margin-bottom:4px;"><b>Closest release/reject/failure cause:</b></div>' +
                    '  <div style="font-size:12px; color:#d1d5db; margin-bottom:8px;">' + renderTimelineRows(sc.closestReleaseRejectCause ? [sc.closestReleaseRejectCause] : [], 'No release/reject/failure event found.') + '</div>' +
                    '  <div style="font-size:12px; color:#d1d5db; margin-bottom:4px;"><b>Last 20 events before end:</b></div>' +
                    '  <div style="font-size:12px; color:#d1d5db; max-height:180px; overflow:auto; border:1px solid #334155; border-radius:6px; padding:6px; margin-bottom:8px;">' +
                    renderTimelineRows(sc.last20EventsBeforeEnd, 'No events before end in this window.') + '</div>' +
                    '  <div style="font-size:12px; color:#d1d5db; margin-bottom:4px;"><b>First 10 events after start:</b></div>' +
                    '  <div style="font-size:12px; color:#d1d5db; max-height:180px; overflow:auto; border:1px solid #334155; border-radius:6px; padding:6px;">' +
                    renderTimelineRows(sc.first10EventsAfterStart, 'No events after start in this window.') + '</div>' +
                    '</div>';
            })();
            const deepAnalysis = isSetupFailure ? (session?.umts?.setupFailureDeepAnalysis || session?.setupFailureDeepAnalysis || null) : null;
            const deepAnalysisHtml = (() => {
                if (!isSetupFailure || !deepAnalysis) return '';
                const ra = deepAnalysis.radioAssessment || {};
                const sa = deepAnalysis.signalingAssessment || {};
                const it = deepAnalysis.interpretation || {};
                const cl = deepAnalysis.classification || {};
                const cf = deepAnalysis.confidence || {};
                const daRecs = Array.isArray(deepAnalysis.recommendedActions) ? deepAnalysis.recommendedActions : [];
                const metricTxt = (v, u) => (Number.isFinite(v) ? `${Number(v).toFixed(1)}${u ? ` ${u}` : ''}` : 'N/A');
                const yesNoBadge = (v) => v
                    ? '<span style="display:inline-block; margin:0 6px; padding:1px 8px; border-radius:999px; font-size:10px; font-weight:700; color:#bbf7d0; background:rgba(22,163,74,0.22); border:1px solid rgba(74,222,128,0.45);">Yes</span>'
                    : '<span style="display:inline-block; margin:0 6px; padding:1px 8px; border-radius:999px; font-size:10px; font-weight:700; color:#fecaca; background:rgba(220,38,38,0.20); border:1px solid rgba(248,113,113,0.45);">No</span>';
                const yesNoBadgeRelease = (v) => v
                    ? '<span style="display:inline-block; margin:0 6px; padding:1px 8px; border-radius:999px; font-size:10px; font-weight:700; color:#fecaca; background:rgba(220,38,38,0.20); border:1px solid rgba(248,113,113,0.45);">Yes</span>'
                    : '<span style="display:inline-block; margin:0 6px; padding:1px 8px; border-radius:999px; font-size:10px; font-weight:700; color:#bbf7d0; background:rgba(22,163,74,0.22); border:1px solid rgba(74,222,128,0.45);">No</span>';
                const sigLine = (label, flag, yesExplain, noExplain) => (
                    escapeHtml(label) + ': ' + yesNoBadge(!!flag) +
                    '<span style="color:#94a3b8;">(' + escapeHtml(!!flag ? yesExplain : noExplain) + ')</span>'
                );
                const sigLineRelease = (label, flag, yesExplain, noExplain) => (
                    escapeHtml(label) + ': ' + yesNoBadgeRelease(!!flag) +
                    '<span style="color:#94a3b8;">(' + escapeHtml(!!flag ? yesExplain : noExplain) + ')</span>'
                );
                const deepRecRows = daRecs.length
                    ? daRecs.map((r) => {
                        const actionId = r.actionId || '';
                        const actionText = r.action || '-';
                        const actionHtml = actionId
                            ? '<a href="#" class="action-link" data-action-id="' + actionId + '" style="color:#93c5fd; text-decoration:underline;">' + escapeHtml(actionText) + '</a>'
                            : escapeHtml(actionText);
                        return '<tr>' +
                            '<td style="padding:6px; border:1px solid #334155;">' + escapeHtml(r.priority || '-') + '</td>' +
                            '<td style="padding:6px; border:1px solid #334155;">' + actionHtml + '</td>' +
                            '<td style="padding:6px; border:1px solid #334155;">' + escapeHtml(r.rationale || '-') + '</td>' +
                            '<td style="padding:6px; border:1px solid #334155;">' + escapeHtml(r.ownerHint || '-') + '</td>' +
                            '</tr>';
                    }).join('')
                    : '<tr><td colspan="4" style="padding:6px; border:1px solid #334155; color:#9ca3af;">No recommendations provided.</td></tr>';
                return '' +
                    '<div style="padding:8px; background:#111827; border:1px solid #334155; border-radius:6px; margin-bottom:10px;">' +
                    '  <div style="font-size:12px; font-weight:700; color:#bfdbfe; margin-bottom:8px;">Setup Failure Deep Analysis</div>' +
                    '  <div style="font-size:12px; color:#d1d5db; margin-bottom:8px;"><b>1) Radio Assessment</b><br>' +
                    'RSCP (min/median/max): ' + metricTxt(ra?.metrics?.rscpMin, 'dBm') + ' / ' + metricTxt(ra?.metrics?.rscpMedian, 'dBm') + ' / ' + metricTxt(ra?.metrics?.rscpMax, 'dBm') + '<br>' +
                    'EcNo (min/median/max): ' + metricTxt(ra?.metrics?.ecnoMin, 'dB') + ' / ' + metricTxt(ra?.metrics?.ecnoMedian, 'dB') + ' / ' + metricTxt(ra?.metrics?.ecnoMax, 'dB') + '<br>' +
                    'UE Tx (p90): ' + metricTxt(ra?.metrics?.txP90, 'dBm') + '<br>' +
                    'BLER (max): ' + metricTxt(ra?.metrics?.blerMax, '%') + '<br>' +
                    'Evaluation: ' + escapeHtml(ra?.evaluation || '-') + '</div>' +
                    '  <div style="font-size:12px; color:#d1d5db; margin-bottom:8px;"><b>2) Signaling Assessment</b><br>' +
                    sigLine(
                        'RRC Direct Transfer observed',
                        !!sa?.directTransferObserved,
                        'RRC connection was already active -> UE and network were exchanging NAS messages',
                        'No direct-transfer signaling seen before end'
                    ) + '<br>' +
                    sigLineRelease(
                        'Explicit L3 RELEASE/REJECT near end',
                        !!(sa?.explicitL3ReleaseRejectNearEnd ?? sa?.immediateReleaseNearEnd),
                        'Release/reject happened close to end timestamp (control-plane termination)',
                        'No immediate release/reject found near end'
                    ) + '<br>' +
                    sigLine(
                        'Connection established (CAC state=3)',
                        !!sa?.connectedEver,
                        'Call reached connected state',
                        'Call never connected (setup failure stage)'
                    ) + '<br>' +
                    'Terminal marker: ' + escapeHtml(
                        String(sa?.terminalMarkerLabel || (
                            (sa?.terminalMarker === 'CAF')
                                ? `CAF reason ${sa?.cafReason ?? 'N/A'} (${sa?.cafReasonLabel || 'Unknown/tool-specific reason'})`
                                : (sa?.terminalMarker || 'N/A')
                        ))
                    ) + '<br>' +
                    'CAD status/cause: ' + escapeHtml(String(sa?.cadStatus ?? '-')) + ' / ' + escapeHtml(String(sa?.cadCause ?? '-')) + renderCadCauseBadge(sa?.cadCause) + '<br>' +
                    'Evaluation: ' + escapeHtml(sa?.evaluation || '-') + '</div>' +
                    '  <div style="font-size:12px; color:#d1d5db; margin-bottom:8px;"><b>3) Technical Interpretation</b><br>' + escapeHtml(it?.summary || '-') + '</div>' +
                    '  <div style="font-size:12px; color:#d1d5db; margin-bottom:8px;"><b>4) Root Cause Classification</b><br>' +
                    'Category: ' + escapeHtml(cl?.category || '-') + '<br>' +
                    'Domain: ' + escapeHtml(cl?.domain || '-') + '</div>' +
                    '  <div style="font-size:12px; color:#d1d5db; margin-bottom:8px;"><b>5) Confidence</b><br>' +
                    'Classifier confidence: ' + Math.round((Number(cl?.confidence) || 0) * 100) + '%<br>' +
                    'Evidence strength: ' + Math.round((Number(cf?.normalized) || 0) * 100) + '% (score ' + escapeHtml(String(cf?.score ?? '-')) + '/100)</div>' +
                    '  <div style="font-size:12px; font-weight:600; color:#bfdbfe; margin-bottom:6px;"><b>6) Structured Recommended Actions</b></div>' +
                    '  <table style="width:100%; border-collapse:collapse; font-size:12px; color:#d1d5db;">' +
                    '    <thead><tr style="color:#93c5fd;"><th style="padding:6px; border:1px solid #334155; text-align:left;">Priority</th><th style="padding:6px; border:1px solid #334155; text-align:left;">Action</th><th style="padding:6px; border:1px solid #334155; text-align:left;">Rationale</th><th style="padding:6px; border:1px solid #334155; text-align:left;">Owner</th></tr></thead>' +
                    '    <tbody>' + deepRecRows + '</tbody>' +
                    '  </table>' +
                    '</div>';
            })();
            bodyEl.innerHTML =
                '<div style=\"display:grid; grid-template-columns: 180px 1fr; gap:8px; font-size:12px; margin-bottom:10px;\">' +
                '  <div style=\"color:#93c5fd;\">Log</div><div>' + (log?.name || '-') + '</div>' +
                '  <div style=\"color:#93c5fd;\">Session</div><div>' + (session?.sessionId || '-') + '</div>' +
                '  <div style=\"color:#93c5fd;\">Call ID</div><div>' + (session?.callTransactionId || '-') + '</div>' +
                '  <div style=\"color:#93c5fd;\">Type</div><div>' + (umtsClassification.resultType || '-') + '</div>' +
                '  <div style=\"color:#93c5fd;\">Category</div><div>' + (umtsClassification.category || '-') + pilotPollutionBadge + cadCauseBadge + '</div>' +
                '  <div style=\"color:#93c5fd;\">Domain</div><div>' + (umtsClassification.domain || 'Undetermined') + '</div>' +
                '  <div style=\"color:#93c5fd;\">Confidence</div><div>' + confidencePct + '%</div>' +
                '</div>' +
                deepAnalysisHtml +
                '<div style=\"padding:8px; background:#111827; border:1px solid #334155; border-radius:6px; margin-bottom:10px;\">' +
                '  <div style=\"font-size:12px; font-weight:600; color:#bfdbfe; margin-bottom:6px;\">One-Paragraph Summary</div>' +
                '  <div style=\"font-size:12px; color:#d1d5db; line-height:1.5;\">' + oneParagraphSummary + '</div>' +
                '</div>' +
                '<div style=\"padding:8px; background:#111827; border:1px solid #334155; border-radius:6px; margin-bottom:10px;\">' +
                '  <div style=\"font-size:12px; font-weight:600; color:#bfdbfe; margin-bottom:6px;\">Authoritative Summary</div>' +
                '  <div style=\"font-size:12px; color:#d1d5db;\">' + (umtsClassification.reason || '-') + '</div>' +
                '</div>' +
                '<div style=\"padding:8px; background:#111827; border:1px solid #334155; border-radius:6px; margin-bottom:10px;\">' +
                '  <div style=\"font-size:12px; font-weight:600; color:#bfdbfe; margin-bottom:6px;\">Explanation</div>' +
                '  <div style=\"font-size:12px; color:#d1d5db; margin-bottom:6px;\">' + (explanation.whatHappened || '-') + '</div>' +
                '  <div style=\"display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:6px;\">' +
                '    <div style=\"font-size:12px; color:#d1d5db;\"><b>Pilot Pollution Risk:</b> ' + pilotPollutionText + '</div>' +
                (pilotPollution
                    ? '    <button class="btn-see-more-pp" style="background:#111827; border:1px solid rgba(255,255,255,0.15); color:#e5e7eb; padding:4px 10px; border-radius:10px; cursor:pointer; font-size:11px;">See more details</button>'
                    : '') +
                '  </div>' +
                ((ppDominanceScore !== null || ppInterferenceScore !== null || ppFinalLabel)
                    ? ('  <div style=\"font-size:12px; color:#d1d5db; margin-bottom:6px;\">' +
                        ('<div>Dominance/Overlap risk: ' + (ppDominanceAvailable ? ((ppDominanceLevel || '-') + ' (' + (ppDominanceScore ?? 0) + '/100)') : 'N/A (0/' + (ppDelta?.totalMimoSamples ?? 0) + ' >=2-pilot)') + '</div>') +
                        (ppInterferenceScore !== null ? ('<div>Interference-under-strong-signal risk: ' + (ppInterferenceLevel || '-') + ' (' + ppInterferenceScore + '/100)</div>') : '') +
                        (ppFinalLabel ? ('<div>Overall label: ' + ppFinalLabel + '</div>') : '') +
                        '</div>')
                    : '') +
                (pilotPollutionEvidence.length
                    ? ('  <div style=\"font-size:12px; color:#d1d5db; margin-bottom:6px;\">' + ('- ' + pilotPollutionEvidence.join('<br>- ')) + '</div>')
                    : '') +
                '  <div style=\"font-size:12px; color:#d1d5db; margin-bottom:6px;\">' + explanationMetricStatusesHtml.join('<br>') + '</div>' +
                '  <div style=\"font-size:12px; color:#d1d5db;\">' + (whyWeThinkSo.length ? ('- ' + whyWeThinkSo.map(x => decorateOkNokText(x)).join('<br>- ')) : 'No detailed evidence bullets.') + '</div>' +
                '</div>' +
                '<div style=\"padding:8px; background:#111827; border:1px solid #334155; border-radius:6px; margin-bottom:10px;\">' +
                '  <div style=\"font-size:12px; font-weight:600; color:#bfdbfe; margin-bottom:6px;\">Evidence</div>' +
                '  <div style=\"font-size:12px; color:#d1d5db;\">' + (evidence.length ? ('- ' + evidence.join('<br>- ')) : 'No evidence provided.') + '</div>' +
                '</div>' +
                '<div style=\"padding:8px; background:#111827; border:1px solid #334155; border-radius:6px; margin-bottom:10px;\">' +
                '  <div style=\"font-size:12px; font-weight:600; color:#bfdbfe; margin-bottom:6px;\">Recommended Actions</div>' +
                '  <table style=\"width:100%; border-collapse:collapse; font-size:12px; color:#d1d5db;\">' +
                '    <thead><tr style=\"color:#93c5fd;\"><th style=\"padding:6px; border:1px solid #334155; text-align:left;\">Priority</th><th style=\"padding:6px; border:1px solid #334155; text-align:left;\">Action</th><th style=\"padding:6px; border:1px solid #334155; text-align:left;\">Rationale</th><th style=\"padding:6px; border:1px solid #334155; text-align:left;\">Owner</th></tr></thead>' +
                '    <tbody>' + recRows + '</tbody>' +
                '  </table>' +
                '</div>' +
                contextBundleHtml +
                '<div style=\"padding:8px; background:#111827; border:1px solid #334155; border-radius:6px; margin-bottom:10px;\">' +
                '  <div style=\"font-size:12px; font-weight:600; color:#bfdbfe; margin-bottom:6px;\">Windowed Radio Snapshot</div>' +
                '  <div style=\"font-size:12px; color:#d1d5db;\">' +
                metricLine('RSCP median', fmt(umtsSnapshot?.rscpMedian, 'dBm'), rscpOk, `OK if > ${metricProfile.rscpMinOk} dBm`) + '<br>' +
                metricLine('EcNo median', fmt(umtsSnapshot?.ecnoMedian, 'dB'), ecnoOk, `OK if > ${metricProfile.ecnoMinOk} dB`) + '<br>' +
                metricLine('BLER max', fmt(umtsSnapshot?.blerMax, '%'), blerOk, `OK if < ${metricProfile.blerMaxOk}%`) + '<br>' +
                metricLine('UE Tx (last/p90/max)', (fmt(umtsSnapshot?.txLast, 'dBm') + ' / ' + fmt(umtsSnapshot?.txP90, 'dBm') + ' / ' + fmt(umtsSnapshot?.txMax, 'dBm')), txOk, `OK if p90 < ${metricProfile.txP90MaxOk} dBm`) + '<br>' +
                txInterpretationHtml +
                'Trend basis: ' + (umtsSnapshot?.trendBasis || 'last 10s window') + '<br>' +
                'RSCP trend Δ: ' + fmt(umtsSnapshot?.rscpTrendDelta, 'dB') + '<br>' +
                'EcNo trend Δ: ' + fmt(umtsSnapshot?.ecnoTrendDelta, 'dB') + '<br>' +
                'MIMOMEAS sample count: ' + sampleCount + '<br>' +
                trendMessage +
                '</div>' + chartHtml +
                '</div>' +
                (isSetupFailure
                    ? '<div style=\"padding:8px; background:#111827; border:1px solid #334155; border-radius:6px; margin-bottom:10px;\">' +
                    '  <div style=\"font-size:12px; font-weight:600; color:#bfdbfe; margin-bottom:6px;\">Mobility / HO / RLF</div>' +
                    '  <div style=\"font-size:12px; color:#d1d5db;\">Not applicable (call never connected).</div>' +
                    '</div>'
                    : '') +
                '<div style=\"padding:8px; background:#111827; border:1px solid #334155; border-radius:6px; margin-top:10px;\">' +
                '  <div style=\"font-size:12px; font-weight:600; color:#bfdbfe; margin-bottom:6px;\">Session Timeline</div>' +
                '  <div style=\"font-size:12px; color:#d1d5db;\">' + timelineHtml + '</div>' +
                '</div>';

            document.getElementById('dropAnalysisModal').style.display = 'block';
            return;
        }
        const isSetupFailure = !!session?.setupFailure;
        const isDropCall = !!session?.drop;
        const caseLabel = isSetupFailure ? 'Setup Failure' : (isDropCall ? 'Drop Call' : 'Generic Session');
        const triggerLabel = isSetupFailure ? 'Failure Trigger' : 'Drop Trigger';
        const radioLabel = isSetupFailure ? 'Radio Context Near Setup Failure' : 'Radio Context Near Drop';
        const timelineLabel = isSetupFailure ? 'Event Timeline Around Setup Failure' : 'Event Timeline Around Drop';

        const reasonLabel = session?.failureReason?.label || '-';
        const reasonCause = session?.failureReason?.cause || '-';
        const endType = session?.endType || '-';
        const endTrigger = session?.endTrigger || '-';
        const rrcTrail = (session?.rrcStates || []).map(x => x.state).filter(Boolean).join(' -> ') || '-';
        const duration = typeof session?.durationMs === 'number' ? (session.durationMs / 1000).toFixed(1) + ' s' : '-';
        const insights = buildDropInsights(log, session);
        const root = deriveDropRootCause(insights);
        const oneParagraph = isSetupFailure
            ? 'Session ended during call setup before confirmed connection. Generic RRC/session indicators are shown for context; UMTS authoritative call-end markers are unavailable for this session.'
            : buildDropOneParagraphSummary(session, insights, root);
        const likelyPostHoHtml = buildPostHoLikelyCauses(insights, root);
        const timeline = buildDropEventTimeline(log, session);
        const v = insights.values || {};
        const fmtNum = (x, unit) => (typeof x === 'number' && !Number.isNaN(x)) ? (x.toFixed(1) + (unit ? (' ' + unit) : '')) : 'N/A';
        const yn = (val) => val
            ? '<span style="color:#f87171; font-weight:600;">Yes</span>'
            : '<span style="color:#22c55e; font-weight:600;">No</span>';
        const miniTrendSvg = buildMiniTrendSvg(
            v.radio?.rscpSeries10s,
            v.radio?.ecnoSeries10s,
            v.radio?.freqSeries10s,
            v.radio?.cellNameSeries10s,
            v.radio?.markerEvents10s
        );
        const timelineHtml = timeline.length
            ? timeline.map(e => '<div style="margin-bottom:3px;">[' + e.deltaSec + 's] ' + e.time + ' - ' + e.label + '</div>').join('')
            : '<div style="color:#9ca3af;">No nearby event timeline found (±15s).</div>';

        titleEl.textContent = 'RRC Session Analysis - ' + (session?.sessionId || 'Session');
        bodyEl.innerHTML =
            '<div style="display:grid; grid-template-columns: 180px 1fr; gap:8px; font-size:12px; margin-bottom:10px;">' +
            '  <div style="color:#93c5fd;">Log</div><div>' + (log?.name || '-') + '</div>' +
            '  <div style="color:#93c5fd;">Session</div><div>' + (session?.sessionId || '-') + '</div>' +
            '  <div style="color:#93c5fd;">Call ID</div><div>' + (session?.callTransactionId || '-') + '</div>' +
            '  <div style="color:#93c5fd;">Window</div><div>' + (session?.startTime || '-') + ' → ' + (session?.endTime || '-') + ' (' + duration + ')</div>' +
            '  <div style="color:#93c5fd;">' + triggerLabel + '</div><div>' + endTrigger + '</div>' +
            '  <div style="color:#93c5fd;">End Type</div><div>' + endType + '</div>' +
            '  <div style="color:#93c5fd;">Failure Reason</div><div>' + reasonLabel + '</div>' +
            '  <div style="color:#93c5fd;">Cause</div><div>' + reasonCause + '</div>' +
            '</div>' +
            '<div style="padding:8px; background:#111827; border:1px solid #334155; border-radius:6px; margin-bottom:10px;">' +
            '  <div style="font-size:12px; font-weight:600; color:#bfdbfe; margin-bottom:6px;">Root-Cause Summary</div>' +
            '  <div style="font-size:12px; color:#d1d5db; margin-bottom:4px;">' + root.summary + '</div>' +
            '  <div style="font-size:12px; color:#d1d5db; margin-bottom:4px;">Primary domain: <b>' + root.topDomain + '</b> | Confidence: <b>' + root.confidence + '%</b></div>' +
            '  <div style="font-size:12px; color:#d1d5db;">Recommendations:<br>- ' + root.recommendations.join('<br>- ') + '</div>' +
            '</div>' +
            '<div style="padding:8px; background:#111827; border:1px solid #334155; border-radius:6px; margin-bottom:10px;">' +
            '  <div style="font-size:12px; font-weight:600; color:#bfdbfe; margin-bottom:6px;">One-Paragraph Summary</div>' +
            '  <div style="font-size:12px; color:#d1d5db; line-height:1.5;">' + oneParagraph + '</div>' +
            '</div>' +
            likelyPostHoHtml +
            '<div style="padding:8px; background:#111827; border:1px solid #334155; border-radius:6px; margin-bottom:10px;">' +
            '  <div style="font-size:12px; font-weight:600; color:#bfdbfe; margin-bottom:6px;">RRC Evolution</div>' +
            '  <div style="font-size:12px; color:#d1d5db;">' + rrcTrail + '</div>' +
            '</div>' +
            '<div style="padding:8px; background:#111827; border:1px solid #334155; border-radius:6px;">' +
            '  <div style="font-size:12px; font-weight:600; color:#bfdbfe; margin-bottom:6px;">' + radioLabel + '</div>' +
            '  <div style="font-size:12px; color:#d1d5db;">' + summarizeDropRadio(session) + '</div>' +
            '</div>' +
            '<div style="padding:8px; background:#111827; border:1px solid #334155; border-radius:6px; margin-top:10px;">' +
            '  <div style="font-size:12px; font-weight:600; color:#bfdbfe; margin-bottom:6px;">' + timelineLabel + '</div>' +
            '  <div style="font-size:12px; color:#d1d5db;">' + timelineHtml + '</div>' +
            '</div>' +
            '<div style="margin-top:10px;">' +
            renderInsightBlock(
                '1) Radio Coverage / Quality',
                insights.radioFindings,
                'Checks weak coverage/interference behavior using 10s RSCP/EcNo trend, UL budget, and BLER/FER dynamics before drop.',
                [
                    'Avg RSCP (last samples): ' + fmtNum(v.radio?.avgRscp, 'dBm') + ' | Threshold: < -95 dBm',
                    'Avg Ec/No (last samples): ' + fmtNum(v.radio?.avgEcno, 'dB') + ' | Threshold: < -14 dB',
                    'RSCP trend over 10s: ' + fmtNum(v.radio?.rscpDrop10s, 'dB') + ' (negative means dropping) | Continuous drop: ' + yn(v.radio?.rscpContinuouslyDropping),
                    'Ec/No trend over 10s: ' + fmtNum(v.radio?.ecnoDrop10s, 'dB') + ' (negative means dropping) | Continuous drop: ' + yn(v.radio?.ecnoContinuouslyDropping),
                    'Cell-edge behavior: ' + (v.radio?.suddenCellEdgeBehavior ? 'Detected' : 'Not detected'),
                    'Pattern check: Good RSCP + bad Ec/No = ' + yn(v.radio?.goodRscpBadEcno) + ' (interference likely) | Both bad = ' + yn(v.radio?.bothBad) + ' (weak coverage likely)',
                    'UL Tx Power: Avg ' + fmtNum(v.radio?.avgUlTx, 'dBm') + ', Latest ' + fmtNum(v.radio?.latestUlTx, 'dBm') + ' | UL-limited (>21 dBm): ' + yn(v.radio?.ulLimited),
                    'BLER/FER near drop: BLER end ' + fmtNum(v.radio?.blerEnd, '%') + ', FER end ' + fmtNum(v.radio?.ferEnd, '%') + ' | Rising=' + yn((v.radio?.risingBler || v.radio?.risingFer)) + ', Spike=' + yn((v.radio?.blerSpike || v.radio?.ferSpike)),
                    'RLF occurred: ' + yn(v.radio?.rlfOccurred)
                ],
                '<div style="font-size:12px; font-weight:600; color:#bfdbfe; margin-bottom:6px;">RSCP / EcNo Mini Trend (Last 10s)</div>' + miniTrendSvg
            ) +
            renderInsightBlock(
                '2) Mobility',
                insights.mobilityFindings,
                'Checks if handover instability triggered the call drop.',
                [
                    'Drop time after last HO: ' + (typeof v.mobility?.dropAfterHoSec === 'number' ? v.mobility.dropAfterHoSec.toFixed(1) + ' s' : 'N/A') + ' | Rule: < 5 s',
                    'HO failure event: ' + yn(v.mobility?.hoFailure),
                    'Inter-RAT HO failure: ' + yn(v.mobility?.interRatHoFailure)
                ]
            ) +
            renderInsightBlock(
                '3) Congestion',
                insights.congestionFindings,
                'Checks whether resource pressure/capacity events likely caused release.',
                [
                    'RAB release (resource): ' + yn(v.congestion?.rabReleaseResource),
                    'IU release (no resource): ' + yn(v.congestion?.iuReleaseNoResource),
                    'Sudden power/code reduction: ' + yn(v.congestion?.suddenPowerOrCodeReduction)
                ]
            ) +
            renderInsightBlock(
                '4) Core Network',
                insights.coreFindings,
                'Checks whether core-side release happened despite acceptable radio context.',
                [
                    'MSC-initiated IU release: ' + yn(v.core?.mscInitiatedIuRelease),
                    'Good radio before drop: ' + yn(v.core?.goodRadioBeforeDrop)
                ]
            ) +
            '</div>';

        document.getElementById('dropAnalysisModal').style.display = 'block';
    };

    const showCallSessionsModal = (logId) => {
        const log = loadedLogs.find(l => l.id.toString() === logId.toString());
        if (!log) return;
        currentCallSessionLogId = log.id;
        ensureCallSessionsModal();
        renderCallSessionsTable();
        document.getElementById('callSessionsModal').style.display = 'block';
    };

    const filterCallSessions = () => {
        renderCallSessionsTable();
    };
    window.showCallSessionsModal = showCallSessionsModal;
    window.filterCallSessions = filterCallSessions;

    const findSessionAnchorPoint = (log, session, mode) => {
        if (!log || !Array.isArray(log.points) || log.points.length === 0 || !session) return null;
        const parseT = parseSessionTimeToMs;
        const markerCandidate = session?.markerTime || session?.markerTsIso ||
            (Number.isFinite(session?.umts?.snapshot?.windowEndTs) ? new Date(session.umts.snapshot.windowEndTs).toISOString() : null);
        const targetTime = markerCandidate || (session.endTime || session.startTime);
        const targetMs = parseT(targetTime);
        const dayMs = 24 * 3600 * 1000;
        const parseTodMsAny = (timeValue) => {
            if (!timeValue) return NaN;
            const txt = String(timeValue).trim();
            const m = txt.match(/^(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/);
            if (m) {
                const hh = parseInt(m[1], 10);
                const mm = parseInt(m[2], 10);
                const ss = parseInt(m[3], 10);
                const ms = parseInt((m[4] || '0').padEnd(3, '0'), 10);
                return (((hh * 60 + mm) * 60 + ss) * 1000) + ms;
            }
            const iso = Date.parse(txt);
            if (Number.isNaN(iso)) return NaN;
            const d = new Date(iso);
            return (((d.getUTCHours() * 60 + d.getUTCMinutes()) * 60 + d.getUTCSeconds()) * 1000) + d.getUTCMilliseconds();
        };
        const targetTodMs = parseTodMsAny(targetTime);

        const isDropLikeEvent = (p) => {
            const txt = [
                p?.event,
                p?.message,
                p?.properties?.Event,
                p?.properties?.Message
            ].filter(Boolean).join(' ').toUpperCase();
            return (
                txt.includes('DROP') ||
                txt.includes('RLF') ||
                txt.includes('RADIO LINK FAILURE') ||
                txt.includes('ABNORMAL') ||
                txt.includes('CALL FAIL')
            );
        };

        const pointTypeRank = (p) => {
            const t = String(p?.type || '').toUpperCase();
            const hasSignal = Number.isFinite(parseFloat(p?.rscp)) || Number.isFinite(parseFloat(p?.ecno)) ||
                Number.isFinite(parseFloat(p?.level)) || Number.isFinite(parseFloat(p?.properties?.['Serving RSCP']));
            const hasTx = Number.isFinite(parseFloat(p?.properties?.['UE Tx Power']));
            const hasBler = Number.isFinite(parseFloat(p?.bler_dl)) || Number.isFinite(parseFloat(p?.properties?.['BLER DL']));
            if (hasSignal || t === 'MEASUREMENT') return 0; // MIMOMEAS/CELLMEAS-like
            if (hasTx) return 1; // TXPC-like
            if (hasBler) return 2; // RLCBLER-like
            if (t === 'SIGNALING') return 3;
            return 4; // events/fallback
        };

        let exact = null;
        let best = null;
        let minDiff = Infinity;
        let bestDropLike = null;
        let minDropDiff = Infinity;
        let bestRank = Infinity;

        for (let i = 0; i < log.points.length; i++) {
            const p = log.points[i];
            if (!p || !p.time) continue;
            const pMs = parseT(p.time);
            const pTodMs = parseTodMsAny(p.time);
            let diff = Infinity;

            // Compare in same time domain when possible
            if (!Number.isNaN(targetMs) && !Number.isNaN(pMs)) {
                const bothTod = targetMs < dayMs && pMs < dayMs;
                const bothAbs = targetMs >= dayMs && pMs >= dayMs;
                if (bothTod || bothAbs) diff = Math.min(diff, Math.abs(pMs - targetMs));
            }
            // Fallback for mixed formats (ISO vs HH:MM:SS.mmm): compare time-of-day
            if (!Number.isNaN(targetTodMs) && !Number.isNaN(pTodMs)) {
                diff = Math.min(diff, Math.abs(pTodMs - targetTodMs));
            }

            if (p.time === targetTime) {
                exact = { point: p, index: i };
                if (mode !== 'drop' || isDropLikeEvent(p)) break;
            }
            const rank = pointTypeRank(p);
            if (diff < minDiff || (Math.abs(diff - minDiff) < 1e-6 && rank < bestRank)) {
                minDiff = diff;
                best = { point: p, index: i };
                bestRank = rank;
            }
            if (mode === 'drop' && isDropLikeEvent(p) && diff < minDropDiff) {
                minDropDiff = diff;
                bestDropLike = { point: p, index: i };
            }
        }

        if (mode === 'drop') {
            if (exact && isDropLikeEvent(exact.point)) return exact;
            if (bestDropLike && minDropDiff <= 15000) return bestDropLike;
        }
        if (exact) return exact;
        if (best && minDiff <= 2000) return best;
        return best || null;
    };

    const syncSessionPointToMap = (log, session, mode) => {
        const hit = findSessionAnchorPoint(log, session, mode);
        if (!hit || !hit.point) return;

        const p = hit.point;
        const enrichedPoint = (() => {
            const lbs = session?.umts?.snapshot?.lastBestServer;
            if (!lbs) return p;
            const toNum = (v) => {
                const n = Number(v);
                return Number.isFinite(n) ? n : null;
            };
            // For call-session drop/setup panels, force serving metrics from UMTS snapshot
            // so Point Details matches analysis snapshot/mini-chart source.
            const forceUmtsServing = mode === 'drop' || mode === 'setupFailure';
            const hasServingSc = forceUmtsServing ? false : (toNum(p?.sc) !== null || toNum(p?.parsed?.serving?.sc) !== null || toNum(p?.properties?.['Serving SC']) !== null);
            const hasServingFreq = forceUmtsServing ? false : (toNum(p?.freq) !== null || toNum(p?.parsed?.serving?.freq) !== null || toNum(p?.properties?.['Serving Freq']) !== null);
            const hasServingRscp = forceUmtsServing ? false : (toNum(p?.rscp) !== null || toNum(p?.level) !== null || toNum(p?.parsed?.serving?.rscp) !== null || toNum(p?.properties?.['Serving RSCP']) !== null);
            const hasServingEcno = forceUmtsServing ? false : (toNum(p?.ecno) !== null || toNum(p?.parsed?.serving?.ecno) !== null || toNum(p?.properties?.['Serving EcNo']) !== null || toNum(p?.properties?.['EcNo']) !== null);

            const parsed = Object.assign({}, p.parsed || {});
            parsed.serving = Object.assign({}, parsed.serving || {});
            if (!hasServingSc && Number.isFinite(lbs.psc)) parsed.serving.sc = lbs.psc;
            if (!hasServingFreq && Number.isFinite(lbs.uarfcn)) parsed.serving.freq = lbs.uarfcn;
            if (!hasServingRscp && Number.isFinite(lbs.rscp)) parsed.serving.rscp = lbs.rscp;
            if (!hasServingEcno && Number.isFinite(lbs.ecno)) parsed.serving.ecno = lbs.ecno;
            if (!parsed.serving.cellId && lbs.cellId !== undefined && lbs.cellId !== null) parsed.serving.cellId = lbs.cellId;

            const props = Object.assign({}, p.properties || {}, {
                'Cell ID': p?.properties?.['Cell ID'] ?? lbs.cellId
            });
            if (!hasServingSc && Number.isFinite(lbs.psc) && props['Serving SC'] === undefined) props['Serving SC'] = lbs.psc;
            if (!hasServingFreq && Number.isFinite(lbs.uarfcn) && props['Serving Freq'] === undefined) props['Serving Freq'] = lbs.uarfcn;
            if (!hasServingRscp && Number.isFinite(lbs.rscp) && props['Serving RSCP'] === undefined) props['Serving RSCP'] = lbs.rscp;
            if (!hasServingEcno && Number.isFinite(lbs.ecno) && props['Serving EcNo'] === undefined) props['Serving EcNo'] = lbs.ecno;
            if (forceUmtsServing) props['Serving Source'] = 'UMTS MIMOMEAS best-server (session snapshot)';

            return Object.assign({}, p, {
                parsed,
                properties: props,
                sc: hasServingSc ? p.sc : (Number.isFinite(lbs.psc) ? lbs.psc : p.sc),
                freq: hasServingFreq ? p.freq : (Number.isFinite(lbs.uarfcn) ? lbs.uarfcn : p.freq),
                rscp: hasServingRscp ? p.rscp : (Number.isFinite(lbs.rscp) ? lbs.rscp : p.rscp),
                ecno: hasServingEcno ? p.ecno : (Number.isFinite(lbs.ecno) ? lbs.ecno : p.ecno),
                cellId: p.cellId ?? lbs.cellId
            });
        })();
        if (window.updateFloatingInfoPanel) {
            window.__activePointLog = log;
            window.updateFloatingInfoPanel(enrichedPoint, log?.color, log);
        }
        if (p.lat !== undefined && p.lng !== undefined && window.map && window.map.setView) {
            window.map.setView([p.lat, p.lng], 17);
        }

        if (typeof window.globalSync === 'function') {
            window.globalSync(log.id, hit.index, 'call-session', true);
            return;
        }

        window.dispatchEvent(new CustomEvent('map-point-clicked', {
            detail: { logId: log.id, point: p, source: 'call-session' }
        }));
    };

    function renderCallSessionsTable() {
        if (!currentCallSessionLogId) return;
        const log = loadedLogs.find(l => l.id.toString() === currentCallSessionLogId.toString());
        if (!log) return;

        const sessions = Array.isArray(log.callSessions) ? log.callSessions : [];
        const title = document.getElementById('callSessionsModalTitle');
        const tbody = document.getElementById('callSessionsTableBody');
        const summary = document.getElementById('callSessionsSummary');
        const searchEl = document.getElementById('callSessionSearch');
        const rrcEl = document.getElementById('callSessionRrcFilter');
        const startEl = document.getElementById('callSessionStartFilter');
        const endEl = document.getElementById('callSessionEndFilter');
        if (!tbody || !summary || !rrcEl) return;

        if (title) title.textContent = 'Call Sessions - ' + log.name;
        tbody.innerHTML = '';

        const rrcStates = new Set();
        sessions.forEach(s => {
            (s.rrcStates || []).forEach(st => {
                if (st && st.state) rrcStates.add(st.state);
            });
        });
        const sortedRrc = Array.from(rrcStates).sort();
        const currentRrc = rrcEl.value || 'ALL';
        rrcEl.innerHTML = '<option value="ALL">All RRC States</option>' +
            sortedRrc.map(s => '<option value="' + s + '"' + (currentRrc === s ? ' selected' : '') + '>' + s + '</option>').join('');

        const textFilter = String(searchEl?.value || '').trim().toLowerCase();
        const rrcFilter = rrcEl.value || 'ALL';
        const startFilterMs = parseSessionTimeToMs(startEl?.value || '');
        const endFilterMs = parseSessionTimeToMs(endEl?.value || '');

        const filtered = sessions.filter(s => {
            const callTxt = String(s.callTransactionId || '').toLowerCase();
            const imsiTxt = String(s.imsi || '').toLowerCase();
            const tmsiTxt = String(s.tmsi || '').toLowerCase();
            const sidTxt = String(s.sessionId || '').toLowerCase();
            const textOk = !textFilter || callTxt.includes(textFilter) || imsiTxt.includes(textFilter) || tmsiTxt.includes(textFilter) || sidTxt.includes(textFilter);
            if (!textOk) return false;

            if (rrcFilter !== 'ALL') {
                const hasRrc = (s.rrcStates || []).some(st => String(st.state || '') === rrcFilter);
                if (!hasRrc) return false;
            }

            const sStart = parseSessionTimeToMs(s.startTime);
            const sEnd = parseSessionTimeToMs(s.endTime);
            if (!Number.isNaN(startFilterMs) && !Number.isNaN(sStart) && sStart < startFilterMs) return false;
            if (!Number.isNaN(endFilterMs) && !Number.isNaN(sEnd) && sEnd > endFilterMs) return false;
            return true;
        });

        summary.textContent = 'Showing ' + filtered.length + ' / ' + sessions.length + ' sessions';

        if (filtered.length === 0) {
            tbody.innerHTML = '<tr><td colspan="13" style="text-align:center; padding:14px; border:1px solid #334155; color:#9ca3af;">No sessions match the filters.</td></tr>';
            return;
        }

        filtered.forEach(s => {
            const tr = document.createElement('tr');
            tr.style.background = '#0f172a';
            const isUmtsCall = s?._source === 'umts' && s?.kind === 'UMTS_CALL';

            const startMs = parseSessionTimeToMs(s.startTime);
            const endMs = parseSessionTimeToMs(s.endTime);
            const durationSec = (!Number.isNaN(startMs) && !Number.isNaN(endMs) && endMs >= startMs)
                ? ((endMs - startMs) / 1000).toFixed(1)
                : 'N/A';
            const rrcText = (s.rrcStates || []).map(st => st.state).filter(Boolean).join(' -> ') || 'N/A';
            const rabCount = Array.isArray(s.rabLifecycle) ? s.rabLifecycle.length : 0;
            const measCount = Array.isArray(s.radioMeasurementsTimeline) ? s.radioMeasurementsTimeline.length : 0;
            const idsText = [s.imsi || '-', s.tmsi || '-'].join(' / ');
            const endType = isUmtsCall ? (s.endType || '-') : 'RRC_SESSION';
            const failureReason = s.failureReason?.label || '-';
            const ynHtml = (val) => val
                ? '<span style="color:#f87171; font-weight:600;">Yes</span>'
                : '<span style="color:#22c55e; font-weight:600;">No</span>';
            const dropText = ynHtml(isUmtsCall ? !!s.drop : false);
            const setupFailureText = ynHtml(isUmtsCall ? !!s.setupFailure : false);

            const td = (value) => '<td style="padding:6px; border:1px solid #334155; vertical-align:top;">' + value + '</td>';
            tr.innerHTML =
                td(s.sessionId || '-') +
                td(s.callTransactionId || '-') +
                td(idsText) +
                td(s.startTime || '-') +
                td(s.endTime || '-') +
                td(durationSec) +
                td(endType) +
                td(failureReason) +
                td(dropText) +
                td(setupFailureText) +
                td('<span title="' + rrcText + '" style="display:inline-block; max-width:260px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">' + rrcText + '</span>') +
                td(String(rabCount)) +
                td(String(measCount));

            const dropCell = tr.children[8];
            const setupCell = tr.children[9];
            if (dropCell && isUmtsCall && s.drop) {
                dropCell.style.cursor = 'pointer';
                dropCell.style.color = '#fca5a5';
                dropCell.title = 'Click to analyze drop and sync map';
                dropCell.onclick = (e) => {
                    e.stopPropagation();
                    syncSessionPointToMap(log, s, 'drop');
                    renderDropAnalysis(log, s);
                };
            }
            if (setupCell && isUmtsCall && s.setupFailure) {
                setupCell.style.cursor = 'pointer';
                setupCell.style.color = '#fde68a';
                setupCell.title = 'Click to analyze setup failure and sync map';
                setupCell.onclick = (e) => {
                    e.stopPropagation();
                    syncSessionPointToMap(log, s, 'setupFailure');
                    renderDropAnalysis(log, s);
                };
            }

            tbody.appendChild(tr);
        });
    }

    function renderSignalingTable() {
        if (!currentSignalingLogId) return;
        const log = loadedLogs.find(l => l.id.toString() === currentSignalingLogId.toString());
        if (!log) return;

        const getField = (p, keys) => {
            for (const k of keys) {
                if (p && p[k] !== undefined && p[k] !== null && String(p[k]).trim() !== '') return p[k];
                if (p && p.properties && p.properties[k] !== undefined && p.properties[k] !== null && String(p.properties[k]).trim() !== '') return p.properties[k];
            }
            return undefined;
        };
        const parseDetails = (p) => {
            const d = p?.details || p?.Details || p?.properties?.Details || '';
            if (!d) return [];
            return String(d).split(',');
        };
        const getCategory = (p) => getField(p, ['category', 'Category', 'type', 'Type', 'msgType', 'Message Type', 'Layer']);
        const inferDirectionFromMessage = (msg) => {
            const m = String(msg || '').toUpperCase();
            if (m.includes('UPLINK')) return 'UL';
            if (m.includes('DOWNLINK')) return 'DL';
            if (m.includes('SERVICE_REQUEST')) return 'UL';
            if (m.includes('SERVICE_ACCEPT')) return 'DL';
            if (m.includes('PDP_CONTEXT_REQUEST')) return 'UL';
            if (m.includes('PDP_CONTEXT_ACCEPT')) return 'DL';
            if (m.includes('MODIFY_PDP_CONTEXT_REQUEST')) return 'UL';
            if (m.includes('MODIFY_PDP_CONTEXT_ACCEPT')) return 'DL';
            if (m.includes('RRC_CONNECTION_REQUEST')) return 'UL';
            if (m.includes('RRC_CONNECTION_SETUP')) return 'DL';
            if (m.includes('RRC_CONNECTION_SETUP_COMPLETE')) return 'UL';
            if (m.includes('RRC_CONNECTION_RELEASE')) return 'DL';
            if (m.includes('SYSTEM_INFORMATION')) return 'DL';
            if (m.includes('MEASUREMENT_CONTROL')) return 'DL';
            if (m.includes('MEASUREMENT_REPORT')) return 'UL';
            if (m.includes('SECURITY_MODE_COMMAND')) return 'DL';
            if (m.includes('SECURITY_MODE_COMPLETE')) return 'UL';
            if (m.includes('IDENTITY_REQUEST')) return 'DL';
            if (m.includes('IDENTITY_RESPONSE')) return 'UL';
            if (m.includes('AUTHENTICATION_REQUEST')) return 'DL';
            if (m.includes('AUTHENTICATION_RESPONSE')) return 'UL';
            if (m.includes('LOCATION_UPDATE_REQUEST')) return 'UL';
            if (m.includes('LOCATION_UPDATE_ACCEPT')) return 'DL';
            if (m.includes('ROUTING_AREA_UPDATE_REQUEST')) return 'UL';
            if (m.includes('ROUTING_AREA_UPDATE_ACCEPT')) return 'DL';
            if (m.includes('CM_SERVICE_REQUEST')) return 'UL';
            if (m.includes('CALL_PROCEEDING')) return 'DL';
            if (m.includes('SETUP') && !m.includes('SETUP_COMPLETE')) return 'UL';
            return undefined;
        };
        const getDirection = (p) => {
            const direct = getField(p, ['direction', 'Direction', 'dir', 'Dir', 'UL/DL', 'Uplink/Downlink']);
            if (direct) return direct;
            const detailsParts = parseDetails(p);
            const detailsStr = String(p?.details || '');
            if (/UL|Uplink/i.test(detailsStr)) return 'UL';
            if (/DL|Downlink/i.test(detailsStr)) return 'DL';
            // Heuristic: some logs encode direction as 0/1 in details[2]
            if (detailsParts[2] === '0') return 'DL';
            if (detailsParts[2] === '1') return 'UL';
            const msg = getMessage(p);
            const inferred = inferDirectionFromMessage(msg);
            if (inferred) return inferred;
            return undefined;
        };
        const getTime = (p) => getField(p, ['time', 'Time', 'timestamp', 'Timestamp', 'ts']);
        const getMessage = (p) => getField(p, ['message', 'Message', 'msg', 'Msg', 'details', 'Details', 'name', 'Name']);

        const filterElement = document.getElementById('signalingFilter');
        const filter = filterElement ? filterElement.value : 'ALL';
        if (!filterElement) console.warn('Signaling Filter Dropdown not found in DOM!');

        const tbody = document.getElementById('signalingTableBody');
        const title = document.getElementById('signalingModalTitle');

        tbody.innerHTML = '';
        title.textContent = 'Signaling Data - ' + log.name;

        // Filter Data
        let sigPoints = log.signaling || [];
        if (filter !== 'ALL') {
            sigPoints = sigPoints.filter(p => getCategory(p) === filter);
        }

        if (sigPoints.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding:20px;">No messages found matching filter.</td></tr>';
        } else {
            const limit = 2000;
            const displayPoints = sigPoints.slice(0, limit);

            if (sigPoints.length > limit) {
                const tr = document.createElement('tr');
                tr.innerHTML = '<td colspan="6" style="background:#552200; color:#fff; text-align:center;">Showing first ' + limit + ' of ' + sigPoints.length + ' messages.</td>';
                tbody.appendChild(tr);
            }

            displayPoints.forEach((p, index) => {
                const tr = document.createElement('tr');
                const timeVal = getTime(p) || '';
                tr.id = 'sig-row-' + String(timeVal).replace(/[:.]/g, '') + '-' + index;
                tr.className = 'signaling-row'; // Add class for selection
                tr.style.cursor = 'pointer';

                // Row Click = Sync (Map + Chart)
                tr.onclick = (e) => {
                    // Ignore clicks on buttons
                    if (e.target.tagName === 'BUTTON') return;

                    // 1. Sync Map
                    if (p.lat && p.lng) {
                        window.map.setView([p.lat, p.lng], 16);

                        // Dispatch event for Chart Sync
                        const event = new CustomEvent('map-point-clicked', {
                            detail: { logId: currentSignalingLogId, point: p, source: 'signaling' }
                        });
                        window.dispatchEvent(event);
                    } else {
                        // Try to find closest GPS point by time? 
                        // For now, just try chart sync via time
                        const event = new CustomEvent('map-point-clicked', {
                            detail: { logId: currentSignalingLogId, point: p, source: 'signaling' }
                        });
                        window.dispatchEvent(event);
                    }

                    // Low-level Visual Highlight (Overridden by highlightPoint later)
                    // But good for immediate feedback
                    document.querySelectorAll('.signaling-row').forEach(r => r.classList.remove('selected-row'));
                    tr.classList.add('selected-row');
                };

                const mapBtn = (p.lat && p.lng)
                    ? '<button onclick="window.map.setView([' + p.lat + ', ' + p.lng + '], 16); event.stopPropagation();" class="btn" style="padding:2px 6px; font-size:10px; background-color:#3b82f6;">Map</button>'
                    : '<span style="color:#666; font-size:10px;">No GPS</span>';

                // Store point data for the info button handler (simulated via dataset or just passing object index if we could, but stringifying is easier for this hack)
                // Better: attach object to DOM element directly
                tr.pointData = p;

                let categoryVal = getCategory(p) || 'N/A';
                const detailsParts = parseDetails(p);
                if (categoryVal === 'SIGNALING' && detailsParts.length > 0) {
                    categoryVal = detailsParts[0] || categoryVal;
                }
                let directionVal = getDirection(p) || 'N/A';
                if (directionVal === 'N/A' && detailsParts.length > 2) {
                    if (detailsParts[2] === '0') directionVal = 'DL';
                    if (detailsParts[2] === '1') directionVal = 'UL';
                }
                const msgVal = getMessage(p) || 'N/A';
                const rrcCause = getField(p, ['rrc_rel_cause', 'RRC Release Cause', 'RRC Release', 'RRC Cause', 'RRC_RELEASE_CAUSE']);
                const csCause = getField(p, ['cs_rel_cause', 'CS Release Cause', 'CS Release', 'CS Cause', 'CS_RELEASE_CAUSE']);
                const releaseCauseText = [rrcCause ? `RRC: ${rrcCause}` : '', csCause ? `CS: ${csCause}` : ''].filter(Boolean).join(' | ') || '—';
                let typeClass = 'badge-rrc';
                if (categoryVal === 'L3') typeClass = 'badge-l3';

                tr.innerHTML =
                    '<td>' + timeVal + '</td>' +
                    '<td><span class="' + typeClass + '">' + categoryVal + '</span></td>' +
                    '<td>' + directionVal + '</td>' +
                    '<td style="max-width:260px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="' + msgVal + '">' + msgVal + '</td>' +
                    '<td style="max-width:260px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="' + releaseCauseText + '">' + releaseCauseText + '</td>' +
                    '<td>' +
                    mapBtn +
                    '<button onclick="const p = this.parentElement.parentElement.pointData; showSignalingPayload(p); event.stopPropagation();" class="btn" style="padding:2px 6px; font-size:10px; background-color:#475569;">Info</button>' +
                    '</td>';
                tbody.appendChild(tr);
            });
        }
    }

    // Payload Viewer
    function showSignalingPayload(point) {
        // Create Modal on the fly if not exists
        let modal = document.getElementById('payloadModal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'payloadModal';
            modal.className = 'modal';
            modal.innerHTML =
                '<div class="modal-content" style="max-width: 600px; background: #1f2937; color: #e5e7eb; border: 1px solid #374151; position:fixed; z-index:10004;">' +
                '<div class="modal-header" style="border-bottom: 1px solid #374151; padding: 10px 15px; display:flex; justify-content:space-between; align-items:center; cursor:grab;">' +
                '<h3 style="margin:0; font-size:16px;">Signaling Details</h3>' +
                '<span class="close" onclick="document.getElementById(\'payloadModal\').style.display=\'none\'" style="color:#9ca3af; cursor:pointer; font-size:20px;">&times;</span>' +
                '</div>' +
                '<div class="modal-body" style="padding: 15px; max-height: 70vh; overflow-y: auto;">' +
                '<div id="payloadContent"></div>' +
                '</div>' +
                '<div class="modal-footer" style="padding: 10px 15px; border-top: 1px solid #374151; text-align: right;">' +
                '<button onclick="document.getElementById(\'payloadModal\').style.display=\'none\'" class="btn" style="background:#4b5563;">Close</button>' +
                '</div>' +
                '</div>';
            document.body.appendChild(modal);
        }

        const content = document.getElementById('payloadContent');
        const payloadRaw = point.payload || point.Payload || point.details || point.Details || 'No Hex Payload Available';
        const msgText = point.message || point.Message || point.msg || point.Msg || point.details || point.Details || point.name || point.Name || 'N/A';
        const timeText = point.time || point.Time || point.timestamp || point.Timestamp || '';
        const dirText = point.direction || point.Direction || point.dir || point.Dir || point['UL/DL'] || point['Uplink/Downlink'] || point?.properties?.Direction || 'N/A';

        // Format Hex (group bytes + optional ASCII)
        const isHex = (s) => !!s && /^[0-9a-fA-F]+$/.test(s) && s.length % 2 === 0;
        const formatHex = (str) => {
            if (!str) return str;
            if (!isHex(str)) return str;
            const bytes = str.match(/.{1,2}/g) || [];
            let out = '';
            for (let i = 0; i < bytes.length; i++) {
                out += bytes[i] + ' ';
                if ((i + 1) % 16 === 0) out += '\n';
            }
            return out.trim();
        };
        const hexToAscii = (str) => {
            if (!isHex(str)) return '';
            const bytes = str.match(/.{1,2}/g) || [];
            let out = '';
            for (let i = 0; i < bytes.length; i++) {
                const b = parseInt(bytes[i], 16);
                out += (b >= 32 && b <= 126) ? String.fromCharCode(b) : '.';
                if ((i + 1) % 16 === 0) out += '\n';
            }
            return out.trim();
        };

        const keys = Object.keys(point || {}).sort();
        const lowerKey = (k) => String(k || '').toLowerCase();
        const hasAny = (arr) => arr.some(k => point[k] !== undefined && point[k] !== null && String(point[k]).trim() !== '');

        const identityKeys = keys.filter(k => /cell|rnc|cid|lac|enodeb|nodeb|site|name|imsi|imei|msisdn|ue id|tac|cgi|ecgi|pci|psc|sc\b|scrambling|freq|arfcn|uarfcn|earfcn|band/i.test(k));
        const radioKeys = keys.filter(k => /(rscp|ecno|rssi|rsrp|rsrq|sinr|bler|tx power|tpc|cqi|mcs|rank|rb|dl|ul)/i.test(k));
        const causeKeys = keys.filter(k => /(cause|release|drop|fail|handover|ho|rlf|t3|t310|t312|rrc)/i.test(k));
        const payloadKeys = keys.filter(k => /(payload|hex|message|msg|nas|rrc|l3|details)/i.test(k));
        const used = new Set([...identityKeys, ...radioKeys, ...causeKeys, ...payloadKeys]);
        const otherKeys = keys.filter(k => !used.has(k));

        const highlightKeys = keys.filter(k => /(rrc|release|cause|cell|sc\b|scrambling|rnc|cid|lac|psc|pci|freq|uarfcn|earfcn|band)/i.test(k));
        const formatVal = (v) => (v === undefined || v === null) ? 'N/A' : (typeof v === 'object' ? JSON.stringify(v) : String(v));
        const row = (k, v) => {
            const isHighlight = highlightKeys.includes(k);
            const labelColor = isHighlight ? '#60a5fa' : '#9ca3af';
            const valColor = isHighlight ? '#e2e8f0' : '#e5e7eb';
            const weight = isHighlight ? '700' : '400';
            return '<div style="display:flex; justify-content:space-between; gap:10px; border-bottom:1px solid #2f3b4a; padding:4px 0;">' +
                '<div style="font-size:11px; color:' + labelColor + '; white-space:nowrap; font-weight:' + weight + ';">' + k + '</div>' +
                '<div style="font-size:11px; color:' + valColor + '; text-align:right; word-break:break-all; font-weight:' + weight + ';">' + formatVal(v) + '</div>' +
                '</div>';
        };

        const section = (title, list) => {
            if (!list || list.length === 0) return '';
            let html = '<div style="margin-top:10px; border-top:1px solid #374151; padding-top:10px;">' +
                '<div style="font-size: 11px; color: #9ca3af; text-transform: uppercase; font-weight: 600; margin-bottom:6px;">' + title + '</div>';
            list.forEach(k => { html += row(k, point[k]); });
            html += '</div>';
            return html;
        };

        let fieldsHtml = '';
        fieldsHtml += section('Identity', identityKeys);
        fieldsHtml += section('Radio', radioKeys);
        fieldsHtml += section('Causes', causeKeys);
        fieldsHtml += section('Payload', payloadKeys);
        fieldsHtml += section('Other', otherKeys);

        content.innerHTML =
            '<div style="margin-bottom: 15px;">' +
            '<div style="font-size: 11px; color: #9ca3af; text-transform: uppercase; font-weight: 600;">Message Type</div>' +
            '<div style="font-size: 14px; color: #fff; font-weight: bold;">' + msgText + '</div>' +
            '</div>' +
            '<div style="display:flex; gap:20px; margin-bottom: 15px;">' +
            '<div style="flex:1">' +
            '<div style="font-size: 11px; color: #9ca3af; text-transform: uppercase; font-weight: 600;">Time</div>' +
            '<div style="font-size: 13px; color: #e5e7eb;">' + timeText + '</div>' +
            '</div>' +
            '<div style="flex:1">' +
            '<div style="font-size: 11px; color: #9ca3af; text-transform: uppercase; font-weight: 600;">Direction</div>' +
            '<div style="font-size: 13px; color: #e5e7eb;">' + dirText + '</div>' +
            '</div>' +
            '</div>' +
            '<div>' +
            '<div style="font-size: 11px; color: #9ca3af; text-transform: uppercase; font-weight: 600; margin-bottom: 5px;">Payload (Hex)</div>' +
            '<div style="font-family: monospace; background: #111827; padding: 10px; border-radius: 4px; border: 1px solid #374151; color: #10b981; font-size: 12px; white-space: pre-wrap; word-break: break-all;">' +
            formatHex(payloadRaw) +
            '</div>' +
            (hexToAscii(payloadRaw) ? '<div style="margin-top:6px; font-size: 11px; color:#9ca3af; text-transform: uppercase; font-weight:600;">Payload (ASCII)</div>' +
            '<div style="font-family: monospace; background: #0b1220; padding: 8px; border-radius: 4px; border: 1px solid #2f3b4a; color: #e5e7eb; font-size: 12px; white-space: pre-wrap; word-break: break-all;">' +
            hexToAscii(payloadRaw) +
            '</div>' : '') +
            '</div>' +
            fieldsHtml;

        modal.style.display = 'block';
        modal.style.zIndex = '10003';

        const contentEl = modal.querySelector('.modal-content');
        const headerEl = modal.querySelector('.modal-header');
        if (contentEl) {
            // Lock initial position for dragging
            contentEl.style.top = '80px';
            contentEl.style.left = '50%';
            contentEl.style.transform = 'translateX(-50%)';
            const rect = contentEl.getBoundingClientRect();
            contentEl.style.left = rect.left + 'px';
            contentEl.style.top = rect.top + 'px';
            contentEl.style.transform = 'none';
        }
        if (headerEl && contentEl && typeof makeElementDraggable === 'function') {
            makeElementDraggable(headerEl, contentEl);
        }
    }
    window.showSignalingPayload = showSignalingPayload;

    // ---------------------------------------------------------
    // ---------------------------------------------------------
    // DOCKING SYSTEM
    // ---------------------------------------------------------
    let isChartDocked = false;
    let isSignalingDocked = false;
    window.isGridDocked = false; // Exposed global

    const bottomPanel = document.getElementById('bottomPanel');
    const bottomContent = document.getElementById('bottomContent');
    const bottomResizer = document.getElementById('bottomResizer');
    const dockedChart = document.getElementById('dockedChart');
    const dockedSignaling = document.getElementById('dockedSignaling');
    const dockedGrid = document.getElementById('dockedGrid');

    // Resizer Logic
    let isResizingBottom = false;

    bottomResizer.addEventListener('mousedown', (e) => {
        isResizingBottom = true;
        document.body.style.cursor = 'ns-resize';
        e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
        if (!isResizingBottom) return;
        const containerHeight = document.getElementById('center-pane').offsetHeight;
        const newHeight = containerHeight - (e.clientY - document.getElementById('center-pane').getBoundingClientRect().top);

        // Min/Max constraints
        if (newHeight > 50 && newHeight < containerHeight - 50) {
            bottomPanel.style.height = newHeight + 'px';
        }
    });

    document.addEventListener('mouseup', () => {
        if (isResizingBottom) {
            isResizingBottom = false;
            document.body.style.cursor = 'default';
            // Trigger Resize for Chart if needed
            if (window.currentChartInstance) window.currentChartInstance.resize();
        }
    });

    // Update Layout Visibility
    function updateDockedLayout() {
        const bottomPanel = document.getElementById('bottomPanel');
        const dockedChart = document.getElementById('dockedChart');
        const dockedSignaling = document.getElementById('dockedSignaling');
        const dockedGrid = document.getElementById('dockedGrid');

        if (!bottomPanel || !dockedChart || !dockedSignaling || !dockedGrid) {
            console.warn('Docking elements missing, skipping layout update.');
            return;
        }

        const anyDocked = isChartDocked || isSignalingDocked || window.isGridDocked;

        if (anyDocked) {
            bottomPanel.style.display = 'flex';
            // Force flex basis to 0 0 300px to prevent #map from squashing it
            bottomPanel.style.flex = '0 0 300px';
            bottomPanel.style.height = '300px';
            bottomPanel.style.minHeight = '100px'; // Prevent full collapse
        } else {
            bottomPanel.style.display = 'none';
        }

        dockedChart.style.display = isChartDocked ? 'flex' : 'none';
        dockedSignaling.style.display = isSignalingDocked ? 'flex' : 'none';

        // Explicitly handle Grid Display
        if (window.isGridDocked) {
            dockedGrid.style.display = 'flex';
            dockedGrid.style.flexDirection = 'column'; // Ensure column layout
        } else {
            dockedGrid.style.display = 'none';
        }

        // Count active items
        const activeItems = [isChartDocked, isSignalingDocked, window.isGridDocked].filter(Boolean).length;

        if (activeItems > 0) {
            const width = 100 / activeItems; // e.g. 50% or 33.3%
            // Apply styles
            [dockedChart, dockedSignaling, dockedGrid].forEach(el => {
                // Ensure flex basis is reasonable
                el.style.flex = '1 1 auto';
                el.style.width = width + '%';
                el.style.borderRight = '1px solid #444';
                el.style.height = '100%'; // Full height of bottomPanel
            });
            // Remove last border
            if (window.isGridDocked) dockedGrid.style.borderRight = 'none';
            else if (isSignalingDocked) dockedSignaling.style.borderRight = 'none';
            else dockedChart.style.borderRight = 'none';
        }

        // Trigger Chart Resize
        if (isChartDocked && window.currentChartInstance) {
            setTimeout(() => window.currentChartInstance.resize(), 50);
        }
    }

    // Docking Actions
    window.dockChart = () => {
        isChartDocked = true;

        // Close Floating Modal if open
        const modal = document.getElementById('chartModal');
        if (modal) modal.remove();

        updateDockedLayout();

        // Re-open Chart in Docked Mode
        if (window.currentChartLogId) {
            // Ensure ID type match (string handling)
            const log = loadedLogs.find(l => l.id.toString() === window.currentChartLogId.toString());

            if (log && window.currentChartParam) {
                openChartModal(log, window.currentChartParam);
            } else {
                console.error('Docking failed: Log or Param not valid', { log, param: window.currentChartParam });
            }
        }
    };

    window.undockChart = () => {
        isChartDocked = false;
        dockedChart.innerHTML = ''; // Clear docked
        updateDockedLayout();

        // Re-open as Modal
        if (window.currentChartLogId && window.currentChartParam) {
            const log = loadedLogs.find(l => l.id === window.currentChartLogId);
            if (log) openChartModal(log, window.currentChartParam);
        }
    };

    // ---------------------------------------------------------
    // DOCKING SYSTEM - SIGNALING EXTENSION
    // ---------------------------------------------------------

    // Inject Dock Button into Signaling Modal Header if not present
    function ensureSignalingDockButton() {
        // Use a more specific selector or retry mechanism if needed, but for now standard check
        const header = document.querySelector('#signalingModal .modal-header');
        if (header && !header.querySelector('.dock-btn')) {
            const dockBtn = document.createElement('button');
            dockBtn.className = 'dock-btn';
            dockBtn.textContent = 'Dock';
            // Explicitly set onclick attribute to ensure it persists and isn't lost
            dockBtn.setAttribute('onclick', "alert('Docking...'); window.dockSignaling();");
            dockBtn.style.cssText = 'background:#3b82f6; color:white; border:none; padding:4px 10px; cursor:pointer; font-size:11px; margin-left: auto; margin-right: 15px; pointer-events: auto; z-index: 9999; position: relative;';

            // Insert before the close button
            const closeBtn = header.querySelector('.close');
            header.insertBefore(dockBtn, closeBtn);
        }
    }
    // Call it once
    ensureSignalingDockButton();

    window.dockSignaling = () => {
        if (isSignalingDocked) return;
        isSignalingDocked = true;

        // Move Content
        const modalContent = document.querySelector('#signalingModal .modal-content');
        if (!modalContent) {
            console.error('Signaling modal content not found');
            return;
        }
        const header = modalContent.querySelector('.modal-header');
        const body = modalContent.querySelector('.modal-body');

        // Verify elements exist before moving
        if (header && body) {
            dockedSignaling.appendChild(header);
            dockedSignaling.appendChild(body);

            // Modify Header for Docked State
            header.style.borderBottom = '1px solid #444';

            // Fix: Body needs to stretch in flex container
            body.style.flex = '1';
            body.style.overflowY = 'auto'; // Ensure scrollable

            // Change Dock Button to Undock
            const dockBtn = header.querySelector('.dock-btn');
            if (dockBtn) {
                dockBtn.textContent = 'Undock';
                dockBtn.onclick = window.undockSignaling;
                dockBtn.style.background = '#555';
            }

            // Hide Close Button
            const closeBtn = header.querySelector('.close');
            if (closeBtn) closeBtn.style.display = 'none';

            // Hide Modal Wrapper
            document.getElementById('signalingModal').style.display = 'none';

            updateDockedLayout();
        } else {
            console.error('Signaling modal parts missing', { header, body });
            isSignalingDocked = false; // Revert state if failed
        }
    };

    window.undockSignaling = () => {
        if (!isSignalingDocked) return;
        isSignalingDocked = false;

        const header = dockedSignaling.querySelector('.modal-header');
        const body = dockedSignaling.querySelector('.modal-body');
        const modalContent = document.querySelector('#signalingModal .modal-content');

        if (header && body) {
            modalContent.appendChild(header);
            modalContent.appendChild(body);

            // Restore Header
            // Change Undock Button to Dock
            const dockBtn = header.querySelector('.dock-btn');
            if (dockBtn) {
                dockBtn.textContent = 'Dock';
                dockBtn.onclick = window.dockSignaling;
                dockBtn.style.background = '#3b82f6';
            }

            // Show Close Button
            const closeBtn = header.querySelector('.close');
            if (closeBtn) closeBtn.style.display = 'block';
        }

        dockedSignaling.innerHTML = ''; // Should be empty anyway
        updateDockedLayout();

        // Show Modal
        if (currentSignalingLogId) {
            document.getElementById('signalingModal').style.display = 'block';
        }
    };

    // Redefine showSignalingModal to handle visibility only (rendering is same ID based)
    window.showSignalingModal = (logId) => {
        console.log('Opening Signaling Modal for Log ID:', logId);
        const log = loadedLogs.find(l => l.id.toString() === logId.toString());

        if (!log) {
            console.error('Log not found for ID:', logId);
            return;
        }

        currentSignalingLogId = log.id;
        renderSignalingTable();

        if (isSignalingDocked) {
            // Ensure docked view is visible
            updateDockedLayout();
        } else {
            // Show modal
            document.getElementById('signalingModal').style.display = 'block';
            ensureSignalingDockButton();
        }
    };

    // Initial call to update layout state
    updateDockedLayout();

    // Global Function to Update Sidebar List
    const updateLogsList = function () {
        const container = document.getElementById('logsList');
        if (!container) return; // Safety check
        container.innerHTML = '';

        loadedLogs.forEach(log => {
            // Exclude SmartCare layers (Excel/SHP) which are in the right sidebar
            if (log.type === 'excel' || log.type === 'shp') return;

            const item = document.createElement('div');
            // REMOVED overflow:hidden to prevent clipping issues. FORCED display:block to override any cached flex rules.
            item.style.cssText = 'background:#252525; margin-bottom:5px; border-radius:4px; border:1px solid #333; min-height: 50px; display: block !important;';

            // Header
            const header = document.createElement('div');
            header.className = 'log-header';
            header.style.cssText = 'padding:8px 10px; cursor:pointer; display:flex; justify-content:space-between; align-items:center; background:#2d2d2d; border-bottom:1px solid #333;';
            header.innerHTML =
                '<span style="font-weight:bold; color:#ddd; font-size:12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:160px;">' + log.name + '</span>' +
                '<div style="display:flex; gap:5px;">' +
                '    <!-- Export Button -->' +
                '    <button onclick="window.exportOptimFile(\'' + log.id + '\'); event.stopPropagation(); " title="Export Optim CSV" style="background:#059669; color: white; border: none; width: 20px; height: 20px; border - radius: 3px; cursor: pointer; display: flex; align - items: center; justify - content: center; ">⬇</button>' +
                '    <button onclick="event.stopPropagation(); window.removeLog(\'' + log.id + '\') " style="background: #ef4444; color: white; border: none; width: 20px; height: 20px; border - radius: 3px; cursor: pointer; display: flex; align - items: center; justify - content: center; ">×</button>' +
                '</div>';

            // Toggle Logic
            header.onclick = () => {
                const body = item.querySelector('.log-body');
                // Check computed style or inline style
                const isHidden = body.style.display === 'none';
                body.style.display = isHidden ? 'block' : 'none';
            };

            // Body (Default: Visible)
            const body = document.createElement('div');
            body.className = 'log-body';
            body.style.cssText = 'padding:10px; display:block;';

            // Stats
            const count = log.points.length;
            const stats = document.createElement('div');
            stats.style.cssText = 'font-size:10px; color:#888; margin-bottom:8px;';
            stats.innerHTML =
                '<span style="background:#3b82f6; color:white; padding:2px 4px; border-radius:2px;">' + log.tech + '</span>' +
                '<span style="margin-left:5px;">' + count + ' pts</span>';

            // --- NEW: Detected Config Display (Event 1A) ---
            if (log.config) {
                const c = log.config;
                const configDiv = document.createElement('div');
                configDiv.style.cssText = 'margin-top:5px; padding:5px; background:#1f2937; border-radius:3px; font-size:10px; color:#9ca3af; border-left:2px solid #6ee7b7;';

                let configHtml = '<div style="margin-bottom:2px; font-weight:bold; color:#6ee7b7;">Handover (SHO / IFHO) parameters</div>';

                // Button to open Grid
                configHtml += '<button onclick="window.showEvent1AGrid(\'' + log.id + '\')" style="margin-top:5px; width:100%; font-size:10px; padding:3px; background:#374151; border:1px solid #4b5563; color:#e5e7eb; cursor:pointer; border-radius:2px;">Event 1A – Add cell to Active Set</button>';

                configDiv.innerHTML = configHtml;
                stats.appendChild(configDiv);
            }

            // Actions
            const actions = document.createElement('div');
            actions.style.cssText = 'display:flex; flex-direction:column; gap:4px;';

            const addAction = (label, param, type = 'metric') => {
                const btn = document.createElement('div');
                btn.textContent = label;
                btn.className = 'param-item'; // Add class for styling if needed
                btn.draggable = true; // Make Draggable
                btn.style.cssText = 'padding:4px 8px; background:#333; color:#ccc; font-size:11px; border-radius:3px; cursor:pointer; hover:background:#444; transition:background 0.2s;';

                btn.onmouseover = () => btn.style.background = '#444';
                btn.onmouseout = () => btn.style.background = '#333';

                // Drag Start Handler
                btn.ondragstart = (e) => {
                    e.dataTransfer.setData('application/json', JSON.stringify({
                        logId: log.id,
                        param: param,
                        label: label,
                        type: type
                    }));
                    e.dataTransfer.effectAllowed = 'copy';
                };

                // Left Click Handler - Opens Context Menu or Plots Events
                btn.onclick = (e) => {
                    if (type === 'event') {
                        if (window.mapRenderer) {
                            if (typeof param === 'string' && param.startsWith('trp_event:')) {
                                const trpEventName = param.slice('trp_event:'.length);
                                const filteredEvents = (log.events || []).filter(ev => String(ev && ev.event_name || '') === trpEventName);
                                const layerId = 'event__' + log.id + '__trp_' + String(trpEventName).replace(/[^a-zA-Z0-9_-]/g, '_');
                                window.mapRenderer.addEventsLayer(layerId, filteredEvents);
                                if (!window.eventLegendEntries) window.eventLegendEntries = {};
                                const eventKey = log.id + '::trp_event::' + trpEventName;
                                window.eventLegendEntries[eventKey] = {
                                    title: trpEventName,
                                    iconUrl: null,
                                    color: '#6b7280',
                                    count: filteredEvents.length,
                                    logId: log.id,
                                    points: filteredEvents,
                                    layerId: layerId,
                                    visible: true
                                };
                                if (window.moveDTLayerToTop) window.moveDTLayerToTop(eventKey);
                                if (window.applyDTLayerOrder) window.applyDTLayerOrder();
                                if (window.updateLegend) window.updateLegend();
                            } else 
                            if (param === '3g_dropcall') {
                                const drops = window.filter3gDropCalls(log);
                                const layerId = 'event__' + log.id + '__3g_dropcall';
                                window.mapRenderer.addEventsLayer(layerId, drops, {
                                    iconUrl: 'icons/3g_dropcall.png',
                                    iconSize: [32, 32],
                                    iconAnchor: [16, 16]
                                });
                                if (!window.eventLegendEntries) window.eventLegendEntries = {};
                                const eventKey = log.id + '::3g_dropcall';
                                window.eventLegendEntries[eventKey] = {
                                    title: 'Drop Call',
                                    iconUrl: 'icons/3g_dropcall.png',
                                    count: drops.length,
                                    logId: log.id,
                                    points: drops,
                                    layerId: layerId,
                                    visible: true
                                };
                                if (window.moveDTLayerToTop) window.moveDTLayerToTop(eventKey);
                                if (window.applyDTLayerOrder) window.applyDTLayerOrder();
                                if (window.updateLegend) window.updateLegend();
                            } else if (param === '3g_call_failure') {
                                const fails = window.filter3gCallFailure(log);
                                const layerId = 'event__' + log.id + '__3g_call_failure';
                                window.mapRenderer.addEventsLayer(layerId, fails, {
                                    iconUrl: 'icons/3G_CallFailure.png',
                                    iconSize: [28, 28],
                                    iconAnchor: [14, 14]
                                });
                                if (!window.eventLegendEntries) window.eventLegendEntries = {};
                                const eventKey = log.id + '::3g_call_failure';
                                window.eventLegendEntries[eventKey] = {
                                    title: 'Call Failure',
                                    iconUrl: 'icons/3G_CallFailure.png',
                                    count: fails.length,
                                    logId: log.id,
                                    points: fails,
                                    layerId: layerId,
                                    visible: true
                                };
                                if (window.moveDTLayerToTop) window.moveDTLayerToTop(eventKey);
                                if (window.applyDTLayerOrder) window.applyDTLayerOrder();
                                if (window.updateLegend) window.updateLegend();
                            } else if (param === 'hof_handover_failure') {
                                const hofs = window.filterHOF(log);
                                const layerId = 'event__' + log.id + '__hof';
                                window.mapRenderer.addEventsLayer(layerId, hofs, {
                                    iconUrl: 'icons/HOF.png',
                                    iconSize: [28, 28],
                                    iconAnchor: [14, 14]
                                });
                                if (!window.eventLegendEntries) window.eventLegendEntries = {};
                                const eventKey = log.id + '::hof_handover_failure';
                                window.eventLegendEntries[eventKey] = {
                                    title: 'Handover Failure',
                                    iconUrl: 'icons/HOF.png',
                                    count: hofs.length,
                                    logId: log.id,
                                    points: hofs,
                                    layerId: layerId,
                                    visible: true
                                };
                                if (window.moveDTLayerToTop) window.moveDTLayerToTop(eventKey);
                                if (window.applyDTLayerOrder) window.applyDTLayerOrder();
                                if (window.updateLegend) window.updateLegend();
                            } else {
                                const layerId = 'event__' + log.id + '__' + param;
                                window.mapRenderer.addEventsLayer(layerId, log.events);
                                if (!window.eventLegendEntries) window.eventLegendEntries = {};
                                const eventKey = log.id + '::' + param;
                                window.eventLegendEntries[eventKey] = {
                                    title: label,
                                    iconUrl: null,
                                    color: '#6b7280',
                                    count: log.events.length,
                                    layerId: layerId,
                                    visible: true
                                };
                                if (window.moveDTLayerToTop) window.moveDTLayerToTop(eventKey);
                                if (window.applyDTLayerOrder) window.applyDTLayerOrder();
                                if (window.updateLegend) window.updateLegend();
                            }
                        }
                    } else if (type === 'throughput') {
                        if (window.openThroughputAnalysisPanel) {
                            window.openThroughputAnalysisPanel(log, String(param || 'dl'));
                        }
                    } else if (type === 'driver_entry') {
                        window.showMetricOptions(e, log.id, param, 'driver_entry');
                    } else {
                        window.showMetricOptions(e, log.id, param, 'regular');
                    }
                };
                return btn;
            };

            // Helper for Group Headers
            const addHeader = (text) => {
                const d = document.createElement('div');
                d.textContent = text;
                d.style.cssText = 'font-size:10px; color:#aaa; margin-top:8px; margin-bottom:4px; font-weight:bold; text-transform:uppercase; letter-spacing:0.5px;';
                return d;
            };

            // NEW: DYNAMIC METRICS VS FIXED METRICS
            // If customMetrics exist, use them. Else use Fixed NMF list.

            if (log.trpRunId && (!log.customMetrics || log.customMetrics.length === 0)) {
                actions.appendChild(addHeader('KPIs'));
                const empty = document.createElement('div');
                empty.textContent = 'No valid KPI samples decoded';
                empty.style.cssText = 'font-size:11px;color:#fca5a5;padding:4px 6px;';
                actions.appendChild(empty);
                const neighborsHeader = addHeader('Neighbors');
                actions.appendChild(neighborsHeader);
                const noN = document.createElement('div');
                noN.textContent = 'No neighbor samples';
                noN.style.cssText = 'font-size:11px;color:#94a3b8;padding:4px 6px;';
                actions.appendChild(noN);
                // IMPORTANT: this code runs inside loadedLogs.forEach(...). If we `return` here
                // without appending the DOM nodes, the log item never shows up in the sidebar.
                body.appendChild(stats);
                body.appendChild(actions);
                item.appendChild(header);
                item.appendChild(body);
                container.appendChild(item);
                return;
            }

            if (log.customMetrics && log.customMetrics.length > 0) {
                if (log.trpRunId) {
                    const orderedMetricDefs = [
                        { label: 'RSRP', keys: ['rsrp'] },
                        { label: 'RSRQ', keys: ['rsrq'] },
                        { label: 'SINR', keys: ['sinr', 'rs-sinr', 'rssinr'] },
                        { label: 'DL throughput', keys: ['dl throughput', 'pdsch.throughput', 'downlink throughput'] },
                        { label: 'Application throughput DL', keys: ['application throughput dl', 'data.http.download.throughput', 'http.download.throughput'] },
                        { label: 'UL throughput', keys: ['ul throughput', 'pusch.throughput', 'uplink throughput'] },
                        { label: 'Radio Throughput DL', keys: ['radio throughput dl', 'servingcelltotal.pdsch.throughput', 'pdsch.throughput'] },
                        { label: 'Radio Throughput UL', keys: ['radio throughput ul', 'servingcelltotal.pusch.throughput', 'pusch.throughput'] },
                        { label: 'Cellid', keys: ['cellid', 'cellidentity'] },
                        { label: 'Physical cell ID', keys: ['physical cell id', '.pci'] },
                        { label: 'eNodeB ID', keys: ['enodeb id', '.enodebid'] },
                        { label: 'Cell ID', keys: ['cell id', '.cell.id'] },
                        { label: 'Downlink EARFCN', keys: ['earfcn'] },
                        { label: 'Tracking area code', keys: ['tracking area code', '.tac'] }
                    ];
                    const byLabel = new Map();
                    const byMetricLower = new Map();
                    (Array.isArray(log.customMetrics) ? log.customMetrics : []).forEach(m => {
                        const label = (log.trpMetricLabels && log.trpMetricLabels[m]) ? log.trpMetricLabels[m] : String(m || '');
                        if (label && !byLabel.has(label)) byLabel.set(label, m);
                        byMetricLower.set(String(m || '').toLowerCase(), m);
                    });

                    const finalMetrics = [];
                    const seenMetric = new Set();
                    orderedMetricDefs.forEach(def => {
                        let metricName = byLabel.get(def.label);
                        if (!metricName) {
                            const targetKeys = (def.keys || []).map(k => String(k).toLowerCase());
                            for (const m of (Array.isArray(log.customMetrics) ? log.customMetrics : [])) {
                                const raw = String(m || '').toLowerCase();
                                const label = String((log.trpMetricLabels && log.trpMetricLabels[m]) ? log.trpMetricLabels[m] : m || '').toLowerCase();
                                if (targetKeys.some(k => raw.includes(k) || label.includes(k))) {
                                    metricName = m;
                                    break;
                                }
                            }
                        }
                        if (!metricName || seenMetric.has(metricName)) return;
                        finalMetrics.push(metricName);
                        seenMetric.add(metricName);
                    });

                    // Keep TRP KPI list clean and deterministic (avoid long noisy tails / duplicates).
                    // If none of the ordered KPIs are available, fall back to first sample-backed metrics.
                    if (!finalMetrics.length) {
                        (Array.isArray(log.customMetrics) ? log.customMetrics : []).forEach(m => {
                            if (seenMetric.has(m)) return;
                            finalMetrics.push(m);
                            seenMetric.add(m);
                        });
                    }

                    const header = addHeader('TRP KPIs');
                    actions.appendChild(header);
                    finalMetrics.forEach(m => {
                        const label = (log.trpMetricLabels && log.trpMetricLabels[m]) ? log.trpMetricLabels[m] : m;
                        const btn = addAction(label, m, 'metric');
                        if (String(m).startsWith('__info_')) {
                            const v = (log.trpInfoValues && log.trpInfoValues[m] !== undefined && log.trpInfoValues[m] !== null) ? log.trpInfoValues[m] : '';
                            if (v !== '') btn.title = `${label}: ${v}`;
                        }
                        actions.appendChild(btn);
                    });

                    // Build dynamic LTE Neighbors group from decoded TRP sample-backed neighbor list.
                    // Verification:
                    // 1) import run, inspect console -> "[Neighbors] found X neighbor signals"
                    // 2) click N1 RSRP -> request /api/runs/<id>/kpi?name=Radio.Lte.Neighbor[1].Rsrp
                    // 3) map/grid/chart should render when samples exist
                    const neighborsHeader = addHeader('Neighbors');
                    actions.appendChild(neighborsHeader);
                    const sampleNeighborRows = Array.isArray(log.trpNeighborMetrics)
                        ? log.trpNeighborMetrics
                        : [];
                    const neighborIdxPattern = /^Radio\.Lte\.Neighbor\[(\d+)\]\./i;
                    const fieldOrder = ['pci', 'rsrp', 'rsrq', 'earfcn'];
                    const fieldLabel = { pci: 'PCI', rsrp: 'RSRP', rsrq: 'RSRQ', earfcn: 'Freq' };
                    const subgroupDefs = [
                        { field: 'pci', title: 'PCI neighbors' },
                        { field: 'rsrp', title: 'RSRP neighbors' },
                        { field: 'rsrq', title: 'RSRQ neighbors' },
                        { field: 'earfcn', title: 'Freq neighbors' }
                    ];
                    const byNeighbor = new Map();
                    const upsert = (metricName, sampleCountHint) => {
                        const metric = String(metricName || '');
                        const m = neighborIdxPattern.exec(metric);
                        if (!m) return;
                        const idx = Number(m[1]);
                        if (!Number.isFinite(idx)) return;
                        const low = metric.toLowerCase();
                        let field = null;
                        if (/(\.|_)pci\b/.test(low) || low.includes('physicalcellid')) field = 'pci';
                        else if (/(\.|_)rsrp\b/.test(low)) field = 'rsrp';
                        else if (/(\.|_)rsrq\b/.test(low)) field = 'rsrq';
                        else if (/earfcn\b/.test(low) || /frequency\b/.test(low)) field = 'earfcn';
                        if (!fieldOrder.includes(field)) return;
                        const sc = Number(sampleCountHint);
                        if (Number.isFinite(sc) && sc <= 0) return;
                        if (!byNeighbor.has(idx)) byNeighbor.set(idx, {});
                        const slot = byNeighbor.get(idx);
                        const prev = slot[field];
                        const exactScore = (name) => {
                            const n = String(name || '').toLowerCase();
                            if (field === 'pci') return n.endsWith('.pci') ? 3 : (n.includes('physicalcellid') ? 2 : 1);
                            if (field === 'rsrp') return n.endsWith('.rsrp') ? 3 : 1;
                            if (field === 'rsrq') return n.endsWith('.rsrq') ? 3 : 1;
                            if (field === 'earfcn') return n.endsWith('.earfcn') ? 3 : (n.endsWith('.frequency') ? 2 : 1);
                            return 0;
                        };
                        const prevScore = prev ? exactScore(prev.name) : -1;
                        const currScore = exactScore(metricName);
                        // Prefer better semantic match and higher sample_count.
                        if (!prev || currScore > prevScore || (currScore === prevScore && (Number(sc) || 0) > (Number(prev.sampleCount) || 0))) {
                            slot[field] = { name: metric, sampleCount: Number.isFinite(sc) ? sc : null };
                        }
                    };
                    // Primary source: decoded TRP neighbor samples pushed via /api/runs/<id>/sidebar.
                    // This avoids /catalog-driven neighbor discovery and keeps only sample-backed neighbors.
                    sampleNeighborRows.forEach(row => upsert(row && row.name, row && row.sample_count));

                    const neighborByField = { pci: [], rsrp: [], rsrq: [], earfcn: [] };
                    const sortedNeighborIdx = Array.from(byNeighbor.keys()).sort((a, b) => a - b);
                    sortedNeighborIdx.forEach((idx, ord) => {
                        const displayIndex = ord + 1; // UI compact index: N1, N2, ...
                        const slot = byNeighbor.get(idx) || {};
                        fieldOrder.forEach(f => {
                            if (!slot[f]) return;
                            neighborByField[f].push({
                                label: `N${displayIndex} ${fieldLabel[f]}`,
                                metric: slot[f].name,
                                originalIndex: idx
                            });
                        });
                    });
                    const neighborSignals = fieldOrder.reduce((acc, f) => acc + (neighborByField[f] ? neighborByField[f].length : 0), 0);
                    console.log('[Neighbors] found', neighborSignals, 'neighbor signals across', sortedNeighborIdx.length, 'neighbor indexes (from sidebar/TRP samples)');

                    if (!neighborSignals) {
                        const noN = document.createElement('div');
                        noN.textContent = 'No neighbor samples';
                        noN.style.cssText = 'font-size:11px;color:#94a3b8;padding:4px 6px;';
                        actions.appendChild(noN);
                    } else {
                        subgroupDefs.forEach(def => {
                            const wrap = document.createElement('div');
                            wrap.style.marginBottom = '4px';
                            const head = document.createElement('div');
                            head.innerHTML = '▶ ' + def.title;
                            head.style.cssText = 'font-size:10px; color:#93c5fd; margin-bottom:4px; font-weight:bold; text-transform:uppercase; letter-spacing:0.5px; cursor:pointer; user-select:none;';
                            const body = document.createElement('div');
                            body.style.display = 'none';
                            body.style.paddingLeft = '6px';
                            body.style.flexDirection = 'column';
                            body.style.gap = '4px';
                            head.onclick = () => {
                                const hidden = body.style.display === 'none';
                                body.style.display = hidden ? 'flex' : 'none';
                                head.innerHTML = (hidden ? '▼ ' : '▶ ') + def.title;
                            };

                            const rows = neighborByField[def.field] || [];
                            if (!rows.length) {
                                const noRow = document.createElement('div');
                                noRow.textContent = 'No samples';
                                noRow.style.cssText = 'font-size:11px;color:#94a3b8;padding:2px 0;';
                                body.appendChild(noRow);
                            } else {
                                rows.forEach(ns => {
                                    const btn = addAction(ns.label, ns.metric, 'metric');
                                    if (Number.isFinite(Number(ns.originalIndex))) {
                                        btn.title = `${ns.label} (source Neighbor[${ns.originalIndex}])`;
                                    }
                                    body.appendChild(btn);
                                });
                            }
                            wrap.appendChild(head);
                            wrap.appendChild(body);
                            actions.appendChild(wrap);
                        });
                    }

                    if (Array.isArray(window.TRP_METRIC_REGISTRY) && window.TRP_METRIC_REGISTRY.length) {
                        actions.appendChild(addHeader('Throughput Drivers & Events'));
                        const grouped = {};
                        const disabledEntries = [];
                        window.TRP_METRIC_REGISTRY.forEach(entry => {
                            if (entry && entry.disabled) {
                                disabledEntries.push(entry);
                                return;
                            }
                            const cat = entry.category || 'Other';
                            if (!grouped[cat]) grouped[cat] = [];
                            grouped[cat].push(entry);
                        });
                        Object.keys(grouped).forEach(cat => {
                            const gWrap = document.createElement('div');
                            gWrap.style.marginBottom = '5px';
                            const gHead = document.createElement('div');
                            gHead.innerHTML = '▶ ' + cat;
                            gHead.style.cssText = 'font-size:10px; color:#93c5fd; margin-bottom:4px; font-weight:bold; text-transform:uppercase; letter-spacing:0.5px; cursor:pointer; user-select:none;';
                            const gBody = document.createElement('div');
                            gBody.style.display = 'none';
                            gBody.style.paddingLeft = '5px';
                            gBody.style.flexDirection = 'column';
                            gBody.style.gap = '4px';
                            gHead.onclick = () => {
                                const hidden = gBody.style.display === 'none';
                                gBody.style.display = hidden ? 'flex' : 'none';
                                gHead.innerHTML = (hidden ? '▼ ' : '▶ ') + cat;
                            };
                            grouped[cat].forEach(entry => {
                                gBody.appendChild(addAction(entry.label, entry.key, 'driver_entry'));
                            });
                            gWrap.appendChild(gHead);
                            gWrap.appendChild(gBody);
                            actions.appendChild(gWrap);
                        });

                        if (disabledEntries.length) {
                            const uWrap = document.createElement('div');
                            uWrap.style.marginTop = '6px';
                            const uHead = document.createElement('div');
                            uHead.innerHTML = '▶ Unsupported in this TRP (' + disabledEntries.length + ')';
                            uHead.style.cssText = 'font-size:10px; color:#fca5a5; margin-bottom:4px; font-weight:bold; text-transform:uppercase; letter-spacing:0.5px; cursor:pointer; user-select:none;';
                            const uBody = document.createElement('div');
                            uBody.style.display = 'none';
                            uBody.style.paddingLeft = '6px';
                            uBody.style.fontSize = '11px';
                            uBody.style.color = '#94a3b8';
                            uBody.style.lineHeight = '1.4';
                            uBody.innerHTML = disabledEntries.map(e => '• ' + (e.label || e.key)).join('<br>');
                            uHead.onclick = () => {
                                const hidden = uBody.style.display === 'none';
                                uBody.style.display = hidden ? 'block' : 'none';
                                uHead.innerHTML = (hidden ? '▼ ' : '▶ ') + 'Unsupported in this TRP (' + disabledEntries.length + ')';
                            };
                            uWrap.appendChild(uHead);
                            uWrap.appendChild(uBody);
                            actions.appendChild(uWrap);
                        }
                    }
                    // IMPORTANT: this code runs inside loadedLogs.forEach(...). If we `return` here
                    // without appending the DOM nodes, the log item never shows up in the sidebar.
                    body.appendChild(stats);
                    body.appendChild(actions);
                    item.appendChild(header);
                    item.appendChild(body);
                    container.appendChild(item);
                    return;
                }
                const groups = log.trpRunId ? {
                    'Serving Metrics': [],
                    'Neighbor Metrics': [],
                    'Throughput': [],
                    'Quality (SINR/RSRQ/BLER)': [],
                    'Voice / MOS': [],
                    'IMS / VoLTE': [],
                    'Mobility / RRC': [],
                    'Power': [],
                    'Call / Events / State': [],
                    'Other': []
                } : {
                    'Standard': [],
                    'DT Analysis': [],
                    'POWER CONTROL': [],
                    'HANDOVER & ACTIVE SET ANALYSIS': [],
                    'RADIO LINK FAILURE (RLF)': [],
                    'RRC & CS RELEASE CAUSE': [],
                    'Active Set': [],
                    'Monitored Set': [],
                    'Detected Set': []
                };

                log.customMetrics.forEach(m => {
                    const low = String(m || '').toLowerCase();
                    if (log.trpRunId) {
                        if (low.includes('neighbor') || low.includes('neighbour') || low.includes('.cell[') || low.includes('[64].') || low.includes('adjacent')) {
                            groups['Neighbor Metrics'].push(m);
                        } else if (low.includes('throughput') || low.includes('rate') || low.includes('bitrate') || low.includes('kbit') || low.includes('mbit')) {
                            groups['Throughput'].push(m);
                        } else if (low.includes('sinr') || low.includes('rsrq') || low.includes('bler') || low.includes('fer') || low.includes('cqi')) {
                            groups['Quality (SINR/RSRQ/BLER)'].push(m);
                        } else if (low.includes('mos') || low.includes('polqa') || low.includes('voice quality') || low.includes('aqm')) {
                            groups['Voice / MOS'].push(m);
                        } else if (low.includes('ims') || low.includes('volte') || low.includes('sip') || low.includes('epsbearer') || low.includes('pcscf')) {
                            groups['IMS / VoLTE'].push(m);
                        } else if (low.includes('rrc') || low.includes('handover') || low.includes('reselection') || low.includes('mobility') || low.includes('emm')) {
                            groups['Mobility / RRC'].push(m);
                        } else if (low.includes('power') || low.includes('tx') || low.includes('rx') || low.includes('phich') || low.includes('headroom')) {
                            groups['Power'].push(m);
                        } else if (low.includes('call') || low.includes('event') || low.includes('state') || low.includes('status')) {
                            groups['Call / Events / State'].push(m);
                        } else if (low.includes('serving') || low.includes('rsrp') || low.includes('rscp') || low.includes('pci') || low.includes('cellname') || low.includes('earfcn') || low.includes('uarfcn')) {
                            groups['Serving Metrics'].push(m);
                        } else {
                            groups['Other'].push(m);
                        }
                    } else {
                        if (/^a\d+_/.test(low)) groups['Active Set'].push(m);
                        else if (/^m\d+_/.test(low)) groups['Monitored Set'].push(m);
                        else if (/^d\d+_/.test(low)) groups['Detected Set'].push(m);
                        else if (m === 'UE Tx Power' || m === 'NodeB Tx Power' || m === 'TPC') groups['POWER CONTROL'].push(m);
                        else if (m === 'RRC State' || m === 'bler_dl' || m === 'bler_ul' || m === 'Throughput' || m === 'RSSI') groups['DT Analysis'].push(m);
                        else if (m === 'Active Set Size' || m === 'AS Event' || m === 'HO Command' || m === 'HO Completion') groups['HANDOVER & ACTIVE SET ANALYSIS'].push(m);
                        else if (m === 'RLF indication' || m === 'UL sync loss (UE can’t reach NodeB)' || m === 'DL sync loss (Interference / coverage)' || m === 'T310' || m === 'T312') groups['RADIO LINK FAILURE (RLF)'].push(m);
                        else if (m === 'rrc_rel_cause' || m === 'cs_rel_cause' || m === 'iucs_status') groups['RRC & CS RELEASE CAUSE'].push(m);
                        else groups['Standard'].push(m);
                    }
                });

                Object.keys(groups).forEach(groupName => {
                    const list = groups[groupName];
                    if (list.length === 0) return;

                    // Group Container
                    const groupContainer = document.createElement('div');
                    groupContainer.style.marginBottom = '5px';

                    // Header
                    const header = document.createElement('div');
                    header.innerHTML = '▶ ' + groupName;
                    header.style.cssText = 'font-size:10px; color:#aaa; margin-bottom:4px; font-weight:bold; text-transform:uppercase; letter-spacing:0.5px; cursor:pointer; user-select:none;';

                    // Metric List Container
                    const body = document.createElement('div');
                    body.style.display = 'none'; // Default hidden
                    body.style.paddingLeft = '5px'; // Indent
                    body.style.flexDirection = 'column';
                    body.style.gap = '4px';

                    // Open "Standard" by default
                    if (groupName === 'Standard') {
                        body.style.display = 'flex';
                        header.innerHTML = '▼ ' + groupName;
                    }

                    // Toggle Logic
                    header.onclick = () => {
                        const isHidden = body.style.display === 'none';
                        body.style.display = isHidden ? 'flex' : 'none';
                        header.innerHTML = (isHidden ? '▼ ' : '▶ ') + groupName;
                    };

                    const seenLabels = new Set();
                    list.forEach(metric => {
                        if (String(metric).toLowerCase() === 'analyze point') return;
                        let label = metric;
                        if (metric === 'level' || metric === 'Level') label = 'RSCP';
                        if (metric === 'ecno' || metric === 'EcNo') label = 'Serving EcNo';
                        if (metric === 'sc' || metric === 'SC') label = 'Scrambling Code';
                        if (metric === 'throughput_dl') label = 'DL Throughput (Kbps)';
                        if (metric === 'throughput_ul') label = 'UL Throughput (Kbps)';
                        const labelKey = String(label).toLowerCase();
                        if (seenLabels.has(labelKey)) return;
                        seenLabels.add(labelKey);

                        // Use existing helper to create button
                        const btn = addAction(label, metric);
                        body.appendChild(btn);
                    });

                    groupContainer.appendChild(header);
                    groupContainer.appendChild(body);
                    actions.appendChild(groupContainer);
                });

                // Also add "Time" and "GPS" if they exist in basic points but maybe not in customMetrics list?
                // The parser excludes Time/Lat/Lon from customMetrics.
                // So we can re-add them if we want buttons for them (usually just Time/Speed).
                actions.appendChild(document.createElement('hr')).style.cssText = "border:0; border-top:1px solid #444; margin:10px 0;";
                actions.appendChild(addAction('Time', 'time'));

            } else {
                // FALLBACK: OLD STATIC NMF METRICS

                // GROUP: Serving Cell
                actions.appendChild(addHeader('Serving Cell'));
                actions.appendChild(addAction('RSCP', 'rscp_not_combined'));
                actions.appendChild(addAction('Serving EcNo', 'ecno'));
                actions.appendChild(addAction('Scrambling Code', 'sc'));
                actions.appendChild(addAction('Serving RNC', 'rnc'));
                actions.appendChild(addAction('Active Set', 'active_set'));
                actions.appendChild(addAction('Serving Freq', 'freq'));
                actions.appendChild(addAction('Serving Band', 'band'));
                actions.appendChild(addAction('LAC', 'lac'));
                actions.appendChild(addAction('Cell ID', 'cellId'));
                actions.appendChild(addAction('Serving Cell Name', 'serving_cell_name'));

                // GROUP: Active Set (Individual)
                actions.appendChild(addHeader('Active Set Members'));
                actions.appendChild(addAction('A1 RSCP', 'active_set_A1_RSCP'));
                actions.appendChild(addAction('A1 SC', 'active_set_A1_SC'));
                actions.appendChild(addAction('A2 RSCP', 'active_set_A2_RSCP'));
                actions.appendChild(addAction('A2 SC', 'active_set_A2_SC'));
                actions.appendChild(addAction('A3 RSCP', 'active_set_A3_RSCP'));
                actions.appendChild(addAction('A3 SC', 'active_set_A3_SC'));

                // GROUP: RRC & CS RELEASE CAUSE
                actions.appendChild(addHeader('RRC & CS RELEASE CAUSE'));
                actions.appendChild(addAction('RRC Release Cause', 'rrc_rel_cause'));
                actions.appendChild(addAction('CS Release Cause', 'cs_rel_cause'));
                actions.appendChild(addAction('IU-CS Status', 'iucs_status'));

                // GROUP: Neighbors
                actions.appendChild(addHeader('Neighbors'));
                // Neighbors Loop (N1 - N8)
                for (let i = 1; i <= 8; i++) {
                    actions.appendChild(addAction('N' + i + ' RSCP', 'n' + i + '_rscp'));
                    actions.appendChild(addAction('N' + i + ' EcNo', 'n' + i + '_ecno'));
                    actions.appendChild(addAction('N' + i + ' Scrambling Code', 'n' + i + '_sc'));
                }

                // OUTSIDE GROUPS: Composite & General
                actions.appendChild(document.createElement('hr')).style.cssText = "border:0; border-top:1px solid #444; margin:10px 0;";

                actions.appendChild(addAction('Composite RSCP & Neighbors', 'rscp_not_combined'));

                actions.appendChild(document.createElement('hr')).style.cssText = "border:0; border-top:1px solid #444; margin:10px 0;";

                // GPS & Others
                actions.appendChild(addAction('GPS Speed', 'speed'));
                actions.appendChild(addAction('GPS Altitude', 'alt'));
                actions.appendChild(addAction('Time', 'time'));

            }

            // Left sidebar Events group removed by request.

            // Resurrected Signaling Modal Button
            const sigBtn = document.createElement('div');
            sigBtn.className = 'metric-item';
            sigBtn.style.padding = '4px 8px';
            sigBtn.style.cursor = 'pointer';
            sigBtn.style.margin = '2px 0';
            sigBtn.style.fontSize = '11px';
            sigBtn.style.color = '#ccc';
            sigBtn.style.borderRadius = '4px';
            sigBtn.style.backgroundColor = 'rgba(168, 85, 247, 0.1)'; // Purple tint
            sigBtn.style.border = '1px solid rgba(168, 85, 247, 0.2)';
            sigBtn.textContent = 'Show Signaling';
            sigBtn.onclick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (window.showSignalingModal) {
                    window.showSignalingModal(log.id);
                } else {
                    alert('Signaling Modal function missing!');
                }
            };
            sigBtn.onmouseover = () => sigBtn.style.backgroundColor = 'rgba(168, 85, 247, 0.2)';
            sigBtn.onmouseout = () => sigBtn.style.backgroundColor = 'rgba(168, 85, 247, 0.1)';
            actions.appendChild(sigBtn);

            const sessionsCount = Array.isArray(log.callSessions) ? log.callSessions.length : 0;
            if (sessionsCount > 0) {
                const sessionsBtn = document.createElement('div');
                sessionsBtn.className = 'metric-item';
                sessionsBtn.style.padding = '4px 8px';
                sessionsBtn.style.cursor = 'pointer';
                sessionsBtn.style.margin = '2px 0';
                sessionsBtn.style.fontSize = '11px';
                sessionsBtn.style.color = '#d1fae5';
                sessionsBtn.style.borderRadius = '4px';
                sessionsBtn.style.backgroundColor = 'rgba(16, 185, 129, 0.15)';
                sessionsBtn.style.border = '1px solid rgba(16, 185, 129, 0.35)';
                sessionsBtn.textContent = 'Show Call Sessions (' + sessionsCount + ')';
                sessionsBtn.onclick = (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (window.showCallSessionsModal) window.showCallSessionsModal(log.id);
                };
                sessionsBtn.onmouseover = () => sessionsBtn.style.backgroundColor = 'rgba(16, 185, 129, 0.24)';
                sessionsBtn.onmouseout = () => sessionsBtn.style.backgroundColor = 'rgba(16, 185, 129, 0.15)';
                actions.appendChild(sessionsBtn);
            }

            // Add components
            body.appendChild(stats);
            body.appendChild(actions);
            item.appendChild(header);
            item.appendChild(body);
            container.appendChild(item);
        });
    };

    let throughputPanelChart = null;
    window.trpThroughputState = {
        selectedStart: null,
        selectedEnd: null,
        lastAction: 'dl',
        lastSummary: null,
        lastLogId: null,
        rawMode: false
    };

    function tpEscape(v) {
        return String(v == null ? '' : v)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/\"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    function fmtNum(v, d = 2) {
        return Number.isFinite(Number(v)) ? Number(v).toFixed(d) : 'n/a';
    }

    function toMs(v) {
        const t = new Date(v || '').getTime();
        return Number.isFinite(t) ? t : null;
    }

    function clipSeriesWindow(points, start, end) {
        if (!start || !end) return (points || []).slice();
        const a = toMs(start);
        const b = toMs(end);
        if (!Number.isFinite(a) || !Number.isFinite(b)) return (points || []).slice();
        return (points || []).filter(p => {
            const t = toMs(p && p.x);
            return Number.isFinite(t) && t >= a && t <= b;
        });
    }

    async function fetchThroughputSummary(runId) {
        const res = await fetch('/api/runs/' + encodeURIComponent(runId) + '/throughput-summary');
        const data = await res.json();
        if (!res.ok || data.status !== 'success') {
            throw new Error((data && data.message) || ('HTTP ' + res.status));
        }
        return data;
    }

    function ensureThroughputModal() {
        let modal = document.getElementById('throughputAnalysisModal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'throughputAnalysisModal';
            modal.className = 'analysis-modal-overlay';
            modal.style.zIndex = '10006';
            modal.innerHTML =
                '<div class="analysis-modal throughput-analysis-modal" style="width:920px;max-width:96vw;">' +
                '  <div class="analysis-header" style="display:flex;justify-content:space-between;align-items:center;background:#0f172a;">' +
                '    <h3 id="throughputTitle">Throughput Analysis</h3>' +
                '    <button class="analysis-close-btn" onclick="document.getElementById(\'throughputAnalysisModal\').style.display=\'none\'">×</button>' +
                '  </div>' +
                '  <div class="analysis-content" style="padding:12px;max-height:82vh;overflow:auto;">' +
                '    <div id="throughputToolbar" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px;"></div>' +
                '    <div id="throughputSummaryCards" style="display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:6px;margin-bottom:8px;"></div>' +
                '    <div style="margin-bottom:8px;"><label style="font-size:12px;color:#cbd5e1;"><input type="checkbox" id="throughputRawToggle"> Compare raw vs normalized</label></div>' +
                '    <canvas id="throughputCanvas" height="150"></canvas>' +
                '    <div id="throughputSecondary" style="margin-top:10px;"></div>' +
                '    <div id="throughputDebug" style="margin-top:10px;background:#0b1220;border:1px solid #22334f;border-radius:6px;padding:8px;"></div>' +
                '  </div>' +
                '</div>';
            modal.addEventListener('click', (e) => {
                if (e.target === modal) modal.style.display = 'none';
            });
            document.body.appendChild(modal);
        }
        modal.style.display = 'flex';
        return modal;
    }

    function renderTpChart(datasets, title) {
        const cvs = document.getElementById('throughputCanvas');
        if (!cvs || !window.Chart) return;
        const ctx = cvs.getContext('2d');
        if (throughputPanelChart) {
            throughputPanelChart.destroy();
            throughputPanelChart = null;
        }
        throughputPanelChart = new Chart(ctx, {
            type: 'line',
            data: { datasets: datasets || [] },
            options: {
                animation: false,
                parsing: true,
                normalized: true,
                scales: {
                    x: { type: 'category', ticks: { color: '#94a3b8', maxTicksLimit: 12 } },
                    y: { ticks: { color: '#94a3b8' }, title: { display: true, text: title || 'Mbps', color: '#cbd5e1' } }
                },
                plugins: { legend: { labels: { color: '#e2e8f0' } } }
            }
        });
    }

    function renderTpCards(summary) {
        const box = document.getElementById('throughputSummaryCards');
        if (!box) return;
        const dl = summary && summary.dl ? summary.dl : {};
        const rows = [
            ['Avg', fmtNum(dl.avg)],
            ['Median', fmtNum(dl.median)],
            ['P10', fmtNum(dl.p10)],
            ['P90', fmtNum(dl.p90)],
            ['Peak', fmtNum(dl.peak)],
            ['%<5Mbps', fmtNum(dl.pct_below_5, 1)]
        ];
        box.innerHTML = rows.map(r =>
            '<div style="background:#0b1220;border:1px solid #22334f;border-radius:6px;padding:6px;">' +
            '<div style="font-size:11px;color:#94a3b8;">' + tpEscape(r[0]) + '</div>' +
            '<div style="font-size:14px;color:#f8fafc;font-weight:700;">' + tpEscape(r[1]) + '</div></div>'
        ).join('');
    }

    async function loadSeriesForMetric(runId, metricName) {
        if (!metricName) return [];
        if (window.trpFetchSeries) {
            try {
                const series = await window.trpFetchSeries(runId, metricName);
                return (series || []).filter(r => Number.isFinite(Number(r.value_num))).map(r => ({ x: r.time, y: Number(r.value_num) }));
            } catch (_e) {}
        }
        const res = await fetch('/api/runs/' + encodeURIComponent(runId) + '/kpi?name=' + encodeURIComponent(metricName));
        const data = await res.json();
        if (!res.ok || data.status !== 'success') return [];
        return (data.series || []).filter(r => Number.isFinite(Number(r.value_num))).map(r => ({ x: r.time, y: Number(r.value_num) }));
    }

    function renderTpDebug(summary) {
        const d = document.getElementById('throughputDebug');
        if (!d) return;
        const used = (summary && summary.signals_used) || [];
        const debugRows = used.map(s =>
            '<tr><td>' + tpEscape(s.name) + '</td><td>' + tpEscape(s.id) + '</td><td>' + tpEscape(s.source) + '</td><td>' + tpEscape(s.confidence) + '</td></tr>'
        ).join('');
        d.innerHTML =
            '<div style="font-size:12px;color:#93c5fd;font-weight:700;margin-bottom:6px;">Declaration Validation</div>' +
            '<table style="width:100%;font-size:11px;color:#cbd5e1;border-collapse:collapse;">' +
            '<thead><tr><th style="text-align:left;">Signal Name</th><th>ID</th><th>Rule</th><th>Confidence</th></tr></thead><tbody>' +
            (debugRows || '<tr><td colspan="4">No throughput signal matched for this run.</td></tr>') +
            '</tbody></table>' +
            '<div style="margin-top:6px;font-size:11px;color:#94a3b8;">Expected search: PDSCH/PUSCH throughput, Data.Http.Download/Upload throughput, iperf/ftp/bitrate/thp variants.</div>';
        if (used.length) console.table(used);
    }

    async function renderRootCause(log, summary) {
        const holder = document.getElementById('throughputSecondary');
        if (!holder) return;
        if (!window.trpThroughputUtils || !log || !log.trpCatalog) {
            holder.innerHTML = '<div style="color:#fca5a5;font-size:12px;">Root cause inputs unavailable.</div>';
            return;
        }
        const discover = window.trpThroughputUtils.discoverThroughputSignals(log.trpCatalog.metricsFlat || []);
        const driverSignals = (discover.drivers || []).slice(0, 8);
        const start = window.trpThroughputState.selectedStart;
        const end = window.trpThroughputState.selectedEnd;
        const rows = [];
        const datasets = [];
        const colors = ['#22d3ee', '#f59e0b', '#a78bfa', '#34d399', '#f43f5e', '#60a5fa'];
        for (let i = 0; i < driverSignals.length; i++) {
            const s = driverSignals[i];
            const raw = await loadSeriesForMetric(log.trpRunId, s.name);
            const clipped = clipSeriesWindow(raw, start, end);
            const vals = clipped.map(p => Number(p.y)).filter(Number.isFinite);
            if (!vals.length) continue;
            const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
            const median = window.trpThroughputUtils.percentile(vals, 50);
            rows.push('<tr><td>' + tpEscape(s.name) + '</td><td>' + fmtNum(avg) + '</td><td>' + fmtNum(median) + '</td></tr>');
            if (datasets.length < 4) {
                datasets.push({
                    label: s.name,
                    data: clipped,
                    borderColor: colors[datasets.length % colors.length],
                    borderWidth: 2,
                    pointRadius: 0,
                    tension: 0.2
                });
            }
        }
        holder.innerHTML =
            '<div style="font-size:12px;color:#93c5fd;font-weight:700;margin-bottom:6px;">Root Cause Panel (selected window)</div>' +
            '<table style="width:100%;font-size:11px;color:#cbd5e1;border-collapse:collapse;">' +
            '<thead><tr><th style="text-align:left;">Metric</th><th>Avg</th><th>Median</th></tr></thead><tbody>' +
            (rows.join('') || '<tr><td colspan="3">No driver KPI available for this run window.</td></tr>') +
            '</tbody></table>';
        if (datasets.length) renderTpChart(datasets, 'Driver metrics (raw units)');
    }

    window.openThroughputAnalysisPanel = async (log, action) => {
        if (!log || !log.trpRunId) return;
        const modal = ensureThroughputModal();
        const title = modal.querySelector('#throughputTitle');
        const secondary = modal.querySelector('#throughputSecondary');
        const toolbar = modal.querySelector('#throughputToolbar');
        const rawToggle = modal.querySelector('#throughputRawToggle');
        if (title) title.textContent = 'Throughput Analysis - ' + log.name;
        if (secondary) secondary.innerHTML = '<div style="color:#94a3b8;font-size:12px;">Loading...</div>';

        const currentAction = action || window.trpThroughputState.lastAction || 'dl';
        window.trpThroughputState.lastAction = currentAction;
        const prevLogId = window.trpThroughputState.lastLogId;

        const labels = [
            ['dl', 'DL Throughput'],
            ['ul', 'UL Throughput'],
            ['dips', 'Throughput Dips'],
            ['mismatch', 'Radio vs App Mismatch'],
            ['root_cause', 'Root Cause Panel'],
            ['events_timeline', 'Events Timeline']
        ];
        toolbar.innerHTML = labels.map(([k, l]) =>
            '<button class="btn header-btn" data-tp-action="' + k + '" style="' + (k === currentAction ? 'background:#2563eb;color:#fff;' : '') + '">' + l + '</button>'
        ).join('');
        toolbar.querySelectorAll('button[data-tp-action]').forEach(btn => {
            btn.onclick = () => window.openThroughputAnalysisPanel(log, btn.getAttribute('data-tp-action'));
        });

        if (rawToggle) {
            rawToggle.checked = !!window.trpThroughputState.rawMode;
            rawToggle.onchange = () => {
                window.trpThroughputState.rawMode = !!rawToggle.checked;
                window.openThroughputAnalysisPanel(log, currentAction);
            };
        }

        let summary = window.trpThroughputState.lastSummary;
        if (!summary || prevLogId !== log.id) {
            summary = await fetchThroughputSummary(log.trpRunId);
            window.trpThroughputState.lastSummary = summary;
        }
        window.trpThroughputState.lastLogId = log.id;
        renderTpCards(summary);
        renderTpDebug(summary);

        const util = window.trpThroughputUtils;
        const sf = summary.signals_found || {};
        const nmeta = summary.normalization || {};
        let dlRadio = (summary.series && summary.series.dl_radio) || [];
        let ulRadio = (summary.series && summary.series.ul_radio) || [];
        let dlApp = (summary.series && summary.series.dl_app) || [];
        let ulApp = (summary.series && summary.series.ul_app) || [];

        // Raw-vs-normalized toggle (developer mode)
        if (window.trpThroughputState.rawMode && util) {
            const loadRawAndNormalize = async (sig, normalized, norm) => {
                if (!sig || !sig.name) return normalized;
                const raw = await loadSeriesForMetric(log.trpRunId, sig.name);
                const div = (norm && Number(norm.divisor)) || 1;
                return raw.map(p => ({ x: p.x, y: Number(p.y) / div }));
            };
            dlRadio = await loadRawAndNormalize(sf.dl_radio, dlRadio, nmeta.dl_radio);
            ulRadio = await loadRawAndNormalize(sf.ul_radio, ulRadio, nmeta.ul_radio);
            dlApp = await loadRawAndNormalize(sf.dl_app, dlApp, nmeta.dl_app);
            ulApp = await loadRawAndNormalize(sf.ul_app, ulApp, nmeta.ul_app);
        }

        const clip = (s) => clipSeriesWindow(s, window.trpThroughputState.selectedStart, window.trpThroughputState.selectedEnd);
        const color = { dlr: '#22d3ee', dla: '#f59e0b', ulr: '#34d399', ula: '#f97316', dlt: '#ef4444' };
        const mk = (label, data, c) => ({ label, data: clip(data), borderColor: c, borderWidth: 2, pointRadius: 0, tension: 0.2 });

        if (currentAction === 'dl') {
            const sets = [];
            if (dlRadio.length) sets.push(mk('DL Radio Throughput (Mbps)', dlRadio, color.dlr));
            if (dlApp.length) sets.push(mk('DL App Throughput (Mbps)', dlApp, color.dla));
            renderTpChart(sets, 'Mbps');
            secondary.innerHTML = sets.length ? '' : '<div style=\"color:#fca5a5;font-size:12px;\">Not available in this run. Searched: Radio.Lte.ServingCellTotal.Pdsch.Throughput, Data.Http.Download.Throughput and regex variants.</div>';
        } else if (currentAction === 'ul') {
            const sets = [];
            if (ulRadio.length) sets.push(mk('UL Radio Throughput (Mbps)', ulRadio, color.ulr));
            if (ulApp.length) sets.push(mk('UL App Throughput (Mbps)', ulApp, color.ula));
            renderTpChart(sets, 'Mbps');
            secondary.innerHTML = sets.length ? '' : '<div style=\"color:#fca5a5;font-size:12px;\">Not available in this run. Searched: Radio.Lte.ServingCellTotal.Pusch.Throughput, Data.Http.Upload.Throughput, Data.Iperf.Ul.Throughput and regex variants.</div>';
        } else if (currentAction === 'dips') {
            if (!dlRadio.length) {
                renderTpChart([], 'Mbps');
                secondary.innerHTML = '<div style=\"color:#fca5a5;font-size:12px;\">Not available in this run. Searched DL radio throughput declaration variants (PDSCH/downlink/throughput).</div>';
                return;
            }
            const p10 = Number(summary && summary.dl && summary.dl.p10);
            const thr = Number.isFinite(p10) ? p10 : 5;
            const dips = util ? util.detectDips(dlRadio, thr, 3) : (summary.dips || []);
            renderTpChart([mk('DL Radio Throughput (Mbps)', dlRadio, color.dlr)], 'Mbps');
            secondary.innerHTML =
                '<div style=\"font-size:12px;color:#93c5fd;font-weight:700;margin-bottom:6px;\">Dip intervals (threshold=' + fmtNum(thr) + ' Mbps)</div>' +
                (dips.length ? dips.map((d, idx) =>
                    '<div class=\"tp-dip-item\" data-idx=\"' + idx + '\" style=\"padding:6px;border:1px solid #22334f;border-radius:6px;margin-bottom:4px;cursor:pointer;\">' +
                    '#'+(idx+1)+' ' + tpEscape(d.start) + ' → ' + tpEscape(d.end) + ' | min=' + fmtNum(d.min) + ' Mbps</div>'
                ).join('') : '<div style=\"color:#94a3b8;font-size:12px;\">No dips detected.</div>');
            secondary.querySelectorAll('.tp-dip-item').forEach(node => {
                node.onclick = () => {
                    const d = dips[Number(node.getAttribute('data-idx'))];
                    window.trpThroughputState.selectedStart = d.start;
                    window.trpThroughputState.selectedEnd = d.end;
                    window.openThroughputAnalysisPanel(log, 'root_cause');
                };
            });
        } else if (currentAction === 'mismatch') {
            if (!dlRadio.length || !dlApp.length) {
                renderTpChart([
                    mk('DL Radio Throughput (Mbps)', dlRadio, color.dlr),
                    mk('DL App Throughput (Mbps)', dlApp, color.dla)
                ], 'Mbps');
                secondary.innerHTML = '<div style=\"color:#fca5a5;font-size:12px;\">Not available in this run. Need both DL radio and DL app throughput signals to compute mismatch.</div>';
                return;
            }
            const aligned = util ? util.alignSeriesBySecond(dlRadio, dlApp) : [];
            const delta = aligned.map(r => ({ x: r.x, y: Number(r.a) - Number(r.b) }));
            const verdict = util ? util.mismatchVerdict(aligned) : (summary.mismatch || {});
            renderTpChart([
                mk('DL Radio Throughput (Mbps)', dlRadio, color.dlr),
                mk('DL App Throughput (Mbps)', dlApp, color.dla),
                mk('Delta Radio-App (Mbps)', delta, color.dlt)
            ], 'Mbps');
            secondary.innerHTML =
                '<div style=\"display:flex;gap:8px;align-items:center;flex-wrap:wrap;\">' +
                '<span style=\"padding:4px 8px;border-radius:999px;background:#1d4ed8;color:#fff;font-size:11px;\">' + tpEscape((verdict.flag || 'mixed').toUpperCase()) + '</span>' +
                '<span style=\"font-size:12px;color:#cbd5e1;\">ratio median=' + fmtNum(verdict.ratio_median, 3) + '</span>' +
                '<span style=\"font-size:12px;color:#cbd5e1;\">app&lt;0.7*radio=' + fmtNum(verdict.app_lt_70_ratio_pct, 1) + '%</span>' +
                '<span style=\"font-size:12px;color:#cbd5e1;\">corr=' + fmtNum(verdict.correlation, 3) + '</span>' +
                '</div>';
        } else if (currentAction === 'root_cause') {
            await renderRootCause(log, summary);
        } else if (currentAction === 'events_timeline') {
            const events = (summary.events || []);
            const dl = clip(dlRadio);
            const maxY = dl.length ? Math.max(...dl.map(p => Number(p.y) || 0)) : 1;
            const evPts = events.map(e => ({ x: e.time, y: maxY, event_name: e.event_name }));
            renderTpChart([
                mk('DL Radio Throughput (Mbps)', dlRadio, color.dlr),
                {
                    label: 'Events',
                    data: clip(evPts),
                    borderColor: '#f43f5e',
                    backgroundColor: '#f43f5e',
                    showLine: false,
                    pointRadius: 3
                }
            ], 'Mbps');
            secondary.innerHTML =
                '<div style=\"font-size:12px;color:#93c5fd;font-weight:700;margin-bottom:6px;\">Events Timeline</div>' +
                (events.length ? events.map((e, i) =>
                    '<div class=\"tp-event-item\" data-idx=\"' + i + '\" style=\"padding:6px;border:1px solid #22334f;border-radius:6px;margin-bottom:4px;cursor:pointer;\">' +
                    tpEscape(e.time) + ' - ' + tpEscape(e.event_name) + '</div>'
                ).join('') : '<div style=\"color:#94a3b8;font-size:12px;\">No throughput-related events found.</div>');
            secondary.querySelectorAll('.tp-event-item').forEach(node => {
                node.onclick = () => {
                    const e = events[Number(node.getAttribute('data-idx'))];
                    const t = toMs(e.time);
                    if (!Number.isFinite(t)) return;
                    window.trpThroughputState.selectedStart = new Date(t - 10000).toISOString();
                    window.trpThroughputState.selectedEnd = new Date(t + 10000).toISOString();
                    window.openThroughputAnalysisPanel(log, 'events_timeline');
                };
            });
        }
    };

    const driverSignalsCache = new Map();
    const driverTrackCache = new Map();
    window.driverSelectionState = {
        runId: null,
        key: null,
        label: null,
        itemType: null,
        signalsUsed: [],
        unit: '',
        window: null,
        viewMode: 'chart',
        verification: null
    };

    async function fetchRunSignals(runId) {
        if (driverSignalsCache.has(runId)) return driverSignalsCache.get(runId);
        const res = await fetch('/api/runs/' + encodeURIComponent(runId) + '/signals');
        const data = await res.json();
        const rows = (res.ok && data.status === 'success') ? (data.signals || []) : [];
        driverSignalsCache.set(runId, rows);
        return rows;
    }

    async function fetchRunTimeseries(runId, signal) {
        const res = await fetch('/api/runs/' + encodeURIComponent(runId) + '/timeseries?signal=' + encodeURIComponent(signal));
        const data = await res.json();
        if (!res.ok || data.status !== 'success') return [];
        return data.series || [];
    }

    async function fetchRunTrack(runId) {
        if (driverTrackCache.has(runId)) return driverTrackCache.get(runId);
        const res = await fetch('/api/runs/' + encodeURIComponent(runId) + '/track');
        const data = await res.json();
        const rows = (res.ok && data.status === 'success') ? (data.track || []) : [];
        driverTrackCache.set(runId, rows);
        return rows;
    }

    async function fetchTypedEvents(runId, typeKey) {
        const res = await fetch('/api/runs/' + encodeURIComponent(runId) + '/events?type=' + encodeURIComponent(typeKey) + '&limit=8000');
        const data = await res.json();
        if (!res.ok || data.status !== 'success') return [];
        return data.events || [];
    }

    function scoreSignalMatch(name, entry) {
        const low = String(name || '').toLowerCase();
        const exacts = (entry.exactCandidates || []).map(s => String(s || '').toLowerCase());
        for (const ex of exacts) {
            if (low === ex) return { score: 100, method: 'exact' };
        }
        const regs = window.trpThroughputUtils ? window.trpThroughputUtils.compileRegexList(entry.regexCandidates || []) : [];
        let regexHit = false;
        regs.forEach(re => { if (re.test(low)) regexHit = true; });
        if (!regexHit) return null;
        let score = 50;
        if (low.includes('lte')) score += 3;
        if (low.includes('servingcell') || low.includes('pcell')) score += 2;
        if (/(dl|ul|pdsch|pusch)/.test(low)) score += 2;
        const kws = ['mcs', 'cqi', 'bler', 'harq', 'prb', 'rb', 'ri', 'pmi', 'tcp', 'rtt', 'jitter', 'loss', 'pdcp', 'rlc', 'rrc', 'earfcn', 'pci'];
        kws.forEach(k => { if (low.includes(k)) score += 1; });
        return { score, method: 'regex' };
    }

    async function resolveSignalsForEntry(runId, entry) {
        const signals = await fetchRunSignals(runId);
        const scored = [];
        signals.forEach(s => {
            const m = scoreSignalMatch(s.signal_name, entry);
            if (!m) return;
            scored.push({
                signal_id: s.signal_id,
                signal_name: s.signal_name,
                match: m.method,
                score: m.score
            });
        });
        // Fallback: if no strict candidate matched, use label tokens.
        if (!scored.length) {
            const tokens = String((entry && entry.label) || '')
                .toLowerCase()
                .split(/[^a-z0-9]+/)
                .filter(t => t.length >= 3);
            if (tokens.length) {
                signals.forEach(s => {
                    const low = String(s.signal_name || '').toLowerCase();
                    let hits = 0;
                    tokens.forEach(t => { if (low.includes(t)) hits += 1; });
                    if (!hits) return;
                    scored.push({
                        signal_id: s.signal_id,
                        signal_name: s.signal_name,
                        match: 'label-fallback',
                        score: 30 + hits
                    });
                });
            }
        }
        scored.sort((a, b) => b.score - a.score || String(a.signal_name).localeCompare(String(b.signal_name)));
        const best = scored.length ? scored[0].score : -1;
        const selected = scored.filter(x => x.score >= best - 2).slice(0, (entry.key === 'kpi_per_carrier_throughput' ? 4 : 3));
        return { selected, allMatches: scored, signalCount: signals.length };
    }

    async function prepareDriverMetricOnLog(log, entryKey) {
        const entry = (window.TRP_METRIC_REGISTRY || []).find(x => x.key === entryKey);
        if (!entry) throw new Error('Unknown driver entry: ' + entryKey);
        const resolved = await resolveSignalsForEntry(log.trpRunId, entry);
        if (!resolved.selected || !resolved.selected.length) {
            const searched = []
                .concat((entry.exactCandidates || []).slice(0, 4))
                .concat((entry.regexCandidates || []).slice(0, 4).map(r => '/' + r + '/i'));
            const details = searched.length ? ('Searched: ' + searched.join(', ')) : 'No candidate patterns configured.';
            throw new Error('No matched signal for "' + entry.label + '" in this run. ' + details);
        }

        const primary = resolved.selected[0];
        const rows = await fetchRunTimeseries(log.trpRunId, primary.signal_id || primary.signal_name);
        const pointsRaw = (rows || [])
            .filter(r => Number.isFinite(Number(r && r.value)))
            .map(r => ({ x: r.t, y: Number(r.value) }));
        if (!pointsRaw.length) {
            throw new Error('Matched signal has no numeric samples: ' + (primary.signal_name || primary.signal_id));
        }
        const norm = window.trpThroughputUtils.normalizeMetricSeries(pointsRaw, entry.normalization);
        const s = norm.points.slice().sort((a, b) => (toMs(a.x) || 0) - (toMs(b.x) || 0));
        const toleranceMs = 500;
        let j = 0;
        (log.points || []).forEach(pt => {
            const t = Number(pt.timestamp || toMs(pt.time));
            if (!Number.isFinite(t)) return;
            while (j + 1 < s.length && (toMs(s[j + 1].x) || -Infinity) <= t) j++;
            let best = s[j];
            if (j + 1 < s.length) {
                const a = s[j];
                const b = s[j + 1];
                const at = toMs(a.x);
                const bt = toMs(b.x);
                if (Number.isFinite(at) && Number.isFinite(bt) && Math.abs(bt - t) < Math.abs(at - t)) best = b;
            }
            const bt = toMs(best && best.x);
            if (best && Number.isFinite(bt) && Math.abs(bt - t) <= toleranceMs) {
                pt['__drv_' + entry.key] = Number(best.y);
            }
        });

        if (!log.trpMetricLabels) log.trpMetricLabels = {};
        const syntheticMetric = '__drv_' + entry.key;
        log.trpMetricLabels[syntheticMetric] = entry.label + (norm.unit ? (' (' + norm.unit + ')') : '');
        return {
            entry,
            resolved,
            syntheticMetric,
            normalization: norm
        };
    }

    async function openDriverEntryInView(log, entryKey, viewMode) {
        const entry = (window.TRP_METRIC_REGISTRY || []).find(x => x.key === entryKey);
        try {
            const prepared = await prepareDriverMetricOnLog(log, entryKey);
            if (viewMode === 'map') {
                if (window.addMetricLegendLayer) window.addMetricLegendLayer(log, prepared.syntheticMetric);
                return;
            }
            if (viewMode === 'grid') {
                window.openGridModal(log, prepared.syntheticMetric);
                return;
            }
            window.openChartModal(log, prepared.syntheticMetric);
        } catch (err) {
            const state = window.driverSelectionState || {};
            const msg = (err && err.message ? err.message : String(err || 'Unknown error'));
            const target = document.getElementById('driverMainView');
            if (target) {
                target.innerHTML =
                    '<div style="padding:10px;border:1px solid #3f2431;border-radius:8px;background:#1a1016;color:#fecdd3;font-size:13px;">' +
                    '<div style="font-weight:700;margin-bottom:6px;">Not available in this run</div>' +
                    '<div>' + tpEscape(msg) + '</div>' +
                    '</div>';
            }
            state.verification = {
                matches: [],
                sample_count: 0,
                first_ts: null,
                last_ts: null,
                raw_median: 0,
                conversion: 'none',
                unit: (entry && entry.normalization) || 'unitless',
                sanity: { pass: true, checks: ['No matching signal found in this run'] }
            };
            setDriverVerificationPanel(state);
        }
    }

    function ensureDriverModal() {
        let el = document.getElementById('driverEntryModal');
        if (!el) {
            el = document.createElement('div');
            el.id = 'driverEntryModal';
            el.className = 'analysis-modal-overlay';
            el.style.zIndex = '10007';
            el.innerHTML =
                '<div class="analysis-modal driver-entry-modal" style="width:980px;max-width:96vw;">' +
                '<div class="analysis-header" style="background:#0b2447;">' +
                '<h3 id="driverEntryTitle">Throughput Drivers & Events</h3>' +
                '<button class="analysis-close-btn" onclick="document.getElementById(\'driverEntryModal\').style.display=\'none\'">×</button>' +
                '</div>' +
                '<div class="analysis-content" style="padding:12px;max-height:82vh;overflow:auto;">' +
                '<div id="driverViewChooser" class="driver-view-chooser"></div>' +
                '<div id="driverMainView" style="margin-top:8px;"></div>' +
                '<div id="driverVerificationPanel" style="margin-top:10px;"></div>' +
                '</div></div>';
            el.addEventListener('click', (e) => { if (e.target === el) el.style.display = 'none'; });
            document.body.appendChild(el);
        }
        el.style.display = 'flex';
        return el;
    }

    function setDriverVerificationPanel(state) {
        const box = document.getElementById('driverVerificationPanel');
        if (!box) return;
        const ver = state.verification || {};
        const matches = (ver.matches || []).map(m =>
            '<tr><td>' + tpEscape(m.signal_name) + '</td><td>' + tpEscape(m.signal_id) + '</td><td>' + tpEscape(m.match) + '</td><td>' + tpEscape(m.score) + '</td></tr>'
        ).join('');
        const checks = ((ver.sanity && ver.sanity.checks) || []).map(c => '<li>' + tpEscape(c) + '</li>').join('');
        box.innerHTML =
            '<div style="background:#0b1220;border:1px solid #22334f;border-radius:6px;padding:8px;">' +
            '<div style="font-size:12px;color:#93c5fd;font-weight:700;margin-bottom:6px;">Verification</div>' +
            '<table style="width:100%;font-size:11px;color:#cbd5e1;border-collapse:collapse;">' +
            '<thead><tr><th style="text-align:left;">Signal</th><th>ID</th><th>Method</th><th>Score</th></tr></thead><tbody>' +
            (matches || '<tr><td colspan="4">No matched signal</td></tr>') + '</tbody></table>' +
            '<div style="font-size:11px;color:#cbd5e1;margin-top:6px;">Samples: ' + tpEscape(ver.sample_count) + ' | Span: ' + tpEscape(ver.first_ts || 'n/a') + ' → ' + tpEscape(ver.last_ts || 'n/a') + '</div>' +
            '<div style="font-size:11px;color:#cbd5e1;">Normalization: median=' + tpEscape(fmtNum(ver.raw_median, 3)) + ', conversion=' + tpEscape(ver.conversion || 'none') + ', unit=' + tpEscape(ver.unit || '') + '</div>' +
            '<div style="font-size:11px;color:' + ((ver.sanity && ver.sanity.pass) ? '#86efac' : '#fca5a5') + ';">Sanity: ' + ((ver.sanity && ver.sanity.pass) ? 'PASS' : 'WARN') + '</div>' +
            '<ul style="margin:4px 0 0 16px;padding:0;font-size:11px;color:#94a3b8;">' + checks + '</ul>' +
            '</div>';
    }

    async function renderDriverSelectionView(log) {
        const state = window.driverSelectionState;
        const entry = (window.TRP_METRIC_REGISTRY || []).find(x => x.key === state.key);
        const target = document.getElementById('driverMainView');
        const chooser = document.getElementById('driverViewChooser');
        if (!target || !entry) return;

        chooser.innerHTML =
            '<div class="driver-segment">' +
            '<button data-mode="chart" class="' + (state.viewMode === 'chart' ? 'active' : '') + '">Chart</button>' +
            '<button data-mode="map" class="' + (state.viewMode === 'map' ? 'active' : '') + '">Map</button>' +
            '<button data-mode="grid" class="' + (state.viewMode === 'grid' ? 'active' : '') + '">Grid</button>' +
            '</div>';
        chooser.querySelectorAll('button[data-mode]').forEach(btn => {
            btn.onclick = async () => {
                state.viewMode = btn.getAttribute('data-mode');
                await renderDriverSelectionView(log);
            };
        });

        const seriesBySignal = [];
        for (const sig of state.signalsUsed) {
            const rows = await fetchRunTimeseries(log.trpRunId, sig.signal_id || sig.signal_name);
            seriesBySignal.push({ sig, rows });
        }
        const primaryRows = (seriesBySignal[0] && seriesBySignal[0].rows) ? seriesBySignal[0].rows : [];
        const pointsRaw = primaryRows.filter(r => Number.isFinite(Number(r.value))).map(r => ({ x: r.t, y: Number(r.value) }));
        const norm = window.trpThroughputUtils.normalizeMetricSeries(pointsRaw, entry.normalization);
        const sanity = window.trpThroughputUtils.runSanityChecks(entry.key, norm.points);
        state.unit = norm.unit;
        state.verification = {
            matches: state.signalsUsed,
            sample_count: norm.points.length,
            first_ts: norm.points[0] ? norm.points[0].x : null,
            last_ts: norm.points[norm.points.length - 1] ? norm.points[norm.points.length - 1].x : null,
            raw_median: norm.raw_median,
            conversion: norm.conversion,
            unit: norm.unit,
            sanity
        };
        setDriverVerificationPanel(state);

        if (state.viewMode === 'chart') {
            target.innerHTML = '<canvas id="driverChartCanvas" height="180"></canvas>';
            const ctx = document.getElementById('driverChartCanvas').getContext('2d');
            const ds = [];
            const colors = ['#22d3ee', '#f59e0b', '#a78bfa', '#34d399'];
            seriesBySignal.forEach((blk, i) => {
                const r = blk.rows.filter(x => Number.isFinite(Number(x.value))).map(x => ({ x: x.t, y: Number(x.value) }));
                const n = window.trpThroughputUtils.normalizeMetricSeries(r, entry.normalization);
                ds.push({ label: blk.sig.signal_name + ' (' + n.unit + ')', data: n.points, borderColor: colors[i % colors.length], borderWidth: 2, tension: 0.2, pointRadius: 0 });
            });
            if (window.driverChartInstance) {
                window.driverChartInstance.destroy();
            }
            window.driverChartInstance = new Chart(ctx, {
                type: 'line',
                data: { datasets: ds },
                options: { animation: false, scales: { x: { ticks: { color: '#94a3b8', maxTicksLimit: 10 } }, y: { ticks: { color: '#94a3b8' } } }, plugins: { legend: { labels: { color: '#e2e8f0' } } } }
            });
            if (entry.type === 'event') {
                const ev = await fetchTypedEvents(log.trpRunId, entry.key);
                const inferred = [];
                const taMode = entry.key.includes('ta');
                for (let i = 1; i < primaryRows.length; i++) {
                    const a = primaryRows[i - 1];
                    const b = primaryRows[i];
                    const va = a && a.value;
                    const vb = b && b.value;
                    if (taMode && Number.isFinite(Number(va)) && Number.isFinite(Number(vb))) {
                        if (Math.abs(Number(vb) - Number(va)) >= 5) {
                            inferred.push({ t: b.t, kind: entry.label, details: { from: va, to: vb } });
                        }
                    } else if (String(va) !== String(vb)) {
                        inferred.push({ t: b.t, kind: entry.label, details: { from: va, to: vb } });
                    }
                }
                target.innerHTML += '<div style="margin-top:8px;font-size:12px;color:#cbd5e1;">Events: explicit=' + ev.length + ', inferred=' + inferred.length + '</div>';
            }
        } else if (state.viewMode === 'grid') {
            const allRows = norm.points.slice(0, 20000);
            const track = await fetchRunTrack(log.trpRunId);
            const joined = window.trpThroughputUtils.joinSeriesWithTrack(track, norm.points, 500);
            const latLonByTime = new Map(joined.map(j => [String(j.t || ''), { lat: j.lat, lon: j.lon }]));
            target.innerHTML =
                '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:6px;">' +
                '<label style="font-size:11px;color:#94a3b8;">Min <input id="driverGridMin" type="number" step="any" style="width:90px;"></label>' +
                '<label style="font-size:11px;color:#94a3b8;">Max <input id="driverGridMax" type="number" step="any" style="width:90px;"></label>' +
                '<label style="font-size:11px;color:#94a3b8;">Sort <select id="driverGridSort"><option value="time">Time</option><option value="value_desc">Value desc</option><option value="value_asc">Value asc</option></select></label>' +
                '<span id="driverGridCount" style="font-size:11px;color:#94a3b8;"></span></div>' +
                '<table class="data-table"><thead><tr><th>Time</th><th>Value (' + tpEscape(norm.unit) + ')</th><th>Raw</th><th>Lat</th><th>Lon</th></tr></thead><tbody id="driverGridBody"></tbody></table>';
            const minIn = target.querySelector('#driverGridMin');
            const maxIn = target.querySelector('#driverGridMax');
            const sortSel = target.querySelector('#driverGridSort');
            const countEl = target.querySelector('#driverGridCount');
            const bodyEl = target.querySelector('#driverGridBody');
            const renderRows = () => {
                const minV = minIn && minIn.value !== '' ? Number(minIn.value) : null;
                const maxV = maxIn && maxIn.value !== '' ? Number(maxIn.value) : null;
                const sortMode = sortSel ? sortSel.value : 'time';
                let rows = allRows.filter(r => (minV === null || Number(r.y) >= minV) && (maxV === null || Number(r.y) <= maxV));
                if (sortMode === 'value_desc') rows = rows.slice().sort((a, b) => Number(b.y) - Number(a.y));
                else if (sortMode === 'value_asc') rows = rows.slice().sort((a, b) => Number(a.y) - Number(b.y));
                else rows = rows.slice().sort((a, b) => (toMs(a.x) || 0) - (toMs(b.x) || 0));
                const clipped = rows.slice(0, 5000);
                if (countEl) countEl.textContent = 'Showing ' + clipped.length + ' / ' + rows.length;
                if (bodyEl) {
                    bodyEl.innerHTML = clipped.map(r =>
                        '<tr><td>' + tpEscape(r.x) + '</td><td>' + tpEscape(fmtNum(r.y, 3)) + '</td><td>' + tpEscape(fmtNum(r.raw_y, 3)) + '</td><td>' + tpEscape(latLonByTime.get(String(r.x || '')) ? fmtNum(latLonByTime.get(String(r.x || '')).lat, 6) : '') + '</td><td>' + tpEscape(latLonByTime.get(String(r.x || '')) ? fmtNum(latLonByTime.get(String(r.x || '')).lon, 6) : '') + '</td></tr>'
                    ).join('');
                }
            };
            if (minIn) minIn.oninput = renderRows;
            if (maxIn) maxIn.oninput = renderRows;
            if (sortSel) sortSel.onchange = renderRows;
            renderRows();
        } else if (state.viewMode === 'map') {
            const track = await fetchRunTrack(log.trpRunId);
            if (!track.length) {
                target.innerHTML = '<div style="color:#fca5a5;font-size:12px;">Map not available (no GPS)</div>';
                return;
            }
            const joined = window.trpThroughputUtils.joinSeriesWithTrack(track, norm.points, 500);
            if (!joined.length) {
                target.innerHTML = '<div style="color:#fca5a5;font-size:12px;">No time join found between GPS and metric (<=0.5s)</div>';
                return;
            }
            target.innerHTML = '<div style="font-size:12px;color:#cbd5e1;">Rendering ' + joined.length + ' joined samples on map.</div>';
            if (window.mapRenderer && typeof window.mapRenderer.renderMetricOnMap === 'function') {
                const legend = (window.trpThroughputUtils && typeof window.trpThroughputUtils.buildDefaultLegend === 'function')
                    ? window.trpThroughputUtils.buildDefaultLegend(state.key, norm.unit, norm.points)
                    : null;

                const r = window.mapRenderer.renderMetricOnMap({
                    key: state.key,
                    label: state.label,
                    unit: norm.unit,
                    legend,
                    mapPoints: joined
                });

                // Default legend UI (metric-aware)
                if (window.trpThroughputUtils && typeof window.trpThroughputUtils.legendToHtml === 'function' && legend) {
                    const html = window.trpThroughputUtils.legendToHtml(legend);
                    const st = (legend && legend.stats) ? legend.stats : (r && r.stats ? r.stats : null);
                    if (st) {
                        target.innerHTML += '<div style="font-size:11px;color:#94a3b8;margin-top:6px;">Stats: min=' + fmtNum(st.min) + ', median=' + fmtNum(st.median) + ', max=' + fmtNum(st.max) + ' ' + tpEscape(legend.unit || norm.unit) + '</div>';
                    }
                    target.innerHTML += html;
                } else if (r && r.stats) {
                    target.innerHTML += '<div style="font-size:11px;color:#94a3b8;margin-top:6px;">Stats: min=' + fmtNum(r.stats.min) + ', median=' + fmtNum(r.stats.median) + ', max=' + fmtNum(r.stats.max) + ' ' + tpEscape(norm.unit) + '</div>';
                }
            }
        }
    }

    window.openDriverEntryPanel = async (log, entryKey, preferredViewMode) => {
        if (!log || !log.trpRunId) return;
        const entry = (window.TRP_METRIC_REGISTRY || []).find(x => x.key === entryKey);
        if (!entry) return;
        const modal = ensureDriverModal();
        const title = modal.querySelector('#driverEntryTitle');
        if (title) title.textContent = entry.label + ' - ' + log.name;
        const resolved = await resolveSignalsForEntry(log.trpRunId, entry);
        window.driverSelectionState = {
            runId: log.trpRunId,
            key: entry.key,
            label: entry.label,
            itemType: entry.type,
            signalsUsed: resolved.selected,
            unit: '',
            window: null,
            viewMode: (preferredViewMode || 'chart'),
            verification: { matches: resolved.allMatches.slice(0, 8) }
        };
        await renderDriverSelectionView(log);
    };

    // DEBUG EXPORT FOR TESTING
    window.loadedLogs = loadedLogs;
    window.updateLogsList = updateLogsList;
    window.openChartModal = openChartModal;
    window.showSignalingModal = showSignalingModal;
    window.showCallSessionsModal = showCallSessionsModal;
    window.dockChart = dockChart;
    window.dockSignaling = dockSignaling;
    window.undockChart = undockChart;
    window.undockSignaling = undockSignaling;

    // ----------------------------------------------------
    // EXPORT OPTIM FILE FEATURE
    // ----------------------------------------------------
    window.exportOptimFile = (logId) => {
        const log = loadedLogs.find(l => l.id === logId);
        if (!log) return;

        const headers = [
            'Date', 'Time', 'Latitude', 'Longitude',
            'Serving Band', 'Serving RSCP', 'Serving EcNo', 'Serving SC', 'Serving LAC', 'Serving Freq',
            'N1 Band', 'N1 RSCP', 'N1 EcNo', 'N1 SC', 'N1 LAC', 'N1 Freq',
            'N2 Band', 'N2 RSCP', 'N2 EcNo', 'N2 SC', 'N2 LAC', 'N2 Freq',
            'N3 Band', 'N3 RSCP', 'N3 EcNo', 'N3 SC', 'N3 LAC', 'N3 Freq'
        ];

        // Helper to guess band from freq (Simplified logic matching parser)
        const getBand = (f) => {
            if (!f) return '';
            f = parseFloat(f);
            if (f >= 10562 && f <= 10838) return 'B1 (2100)';
            if (f >= 2937 && f <= 3088) return 'B8 (900)';
            if (f > 10000) return 'High Band';
            if (f < 4000) return 'Low Band';
            return 'Unknown';
        };

        const rows = [];
        rows.push(headers.join(','));

        log.points.forEach(p => {
            if (!p.parsed) return;

            const s = p.parsed.serving;
            const n = p.parsed.neighbors || [];

            const gn = (idx, field) => {
                if (idx >= n.length) return '';
                const nb = n[idx];
                if (field === 'band') return getBand(nb.freq);
                if (field === 'lac') return s.lac;
                return nb[field] !== undefined ? nb[field] : '';
            };

            const row = [
                new Date().toISOString().split('T')[0],
                p.time,
                p.lat,
                p.lng,
                getBand(s.freq),
                s.level,
                s.ecno !== null ? s.ecno : '',
                s.sc,
                s.lac,
                s.freq,
                gn(0, 'band'), gn(0, 'rscp'), gn(0, 'ecno'), gn(0, 'pci'), gn(0, 'lac'), gn(0, 'freq'),
                gn(1, 'band'), gn(1, 'rscp'), gn(1, 'ecno'), gn(1, 'pci'), gn(1, 'lac'), gn(1, 'freq'),
                gn(2, 'band'), gn(2, 'rscp'), gn(2, 'ecno'), gn(2, 'pci'), gn(2, 'lac'), gn(2, 'freq')
            ];
            rows.push(row.join(','));
        });

        const csvContent = "data:text/csv;charset=utf-8," + rows.join("\n");
        const encodedUri = encodeURI(csvContent);
        const link = document.createElement("a");
        link.setAttribute("href", encodedUri);
        link.setAttribute("download", log.name + "_optim_export.csv");
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    };



    // ----------------------------------------------------
    // CONTEXT MENU LOGIC (Re-added)
    // ----------------------------------------------------
    window.currentContextLogId = null;
    window.currentContextParam = null;


    // DRAG AND DROP MAP HANDLERS
    window.allowDrop = (ev) => {
        ev.preventDefault();
    };

    window.drop = (ev) => {
        ev.preventDefault();
        try {
            const data = JSON.parse(ev.dataTransfer.getData("application/json"));
            if (!data || !data.logId || !data.param) return;

            console.log("Dropped Metric:", data);

            const log = loadedLogs.find(l => l.id.toString() === data.logId.toString());
            if (!log) return;

            // 1. Determine Theme based on Metric
            const p = data.param.toLowerCase();
            const l = data.label.toLowerCase();
            const themeSelect = document.getElementById('themeSelect');
            let newTheme = 'level'; // Default

            // Heuristic for Quality vs Coverage vs CellID
            if (p === 'cellid' || p === 'cid' || p === 'cell_id') {
                // Temporarily add option if missing or just hijack the value
                let opt = Array.from(themeSelect.options).find(o => o.value === 'cellId');
                if (!opt) {
                    opt = document.createElement('option');
                    opt.value = 'cellId';
                    opt.text = 'Cell ID';
                    themeSelect.add(opt);
                }
                newTheme = 'cellId';
            } else if (p.includes('qual') || p.includes('ecno') || p.includes('sinr')) {
                newTheme = 'quality';
            }

            // 2. Apply Theme if detected
            if (newTheme && themeSelect) {
                themeSelect.value = newTheme;
                console.log('[Drop] Switched theme to: ' + newTheme);

                // Trigger any change handlers if strictly needed, but we usually just call render
                if (window.renderThresholdInputs) {
                    window.renderThresholdInputs();
                }
                // Force Legend Update
                // Force Legend Update (REMOVED: let Async event handle it)
                // if (window.updateLegend) {
                //    window.updateLegend();
                // }
            }

            // 3. Visualize
            if (window.mapRenderer) {
                log.currentParam = data.param; // SYNC: Update active metric for this log
                window.mapRenderer.updateLayerMetric(log.id, log.points, data.param);

                // Ensure Legend is updated AGAIN after metric update (metrics might be calc'd inside renderer)
                // Ensure Legend is updated AGAIN after metric update (metrics might be calc'd inside renderer)
                // REMOVED: let Async event handle it to avoid "0 Cell IDs" flash
                // setTimeout(() => {
                //     if (window.updateLegend) window.updateLegend();
                // }, 100);
            } else {
                console.error("[Drop] window.mapRenderer is undefined!");
                alert("Internal Error: Map Renderer not initialized.");
            }

        } catch (e) {
            console.error("Drop failed:", e);
            alert("Drop failed: " + e.message);
        }
    };

    // ----------------------------------------------------
    // USER POINT MANUAL ENTRY
    // ----------------------------------------------------
    const addPointBtn = document.getElementById('addPointBtn');
    const userPointModal = document.getElementById('userPointModal');
    const submitUserPoint = document.getElementById('submitUserPoint');

    if (addPointBtn && userPointModal) {
        addPointBtn.onclick = () => {
            userPointModal.style.display = 'block';

            // Make Draggable
            const upContent = userPointModal.querySelector('.modal-content');
            const upHeader = userPointModal.querySelector('.modal-header');
            if (typeof makeElementDraggable === 'function' && upContent && upHeader) {
                makeElementDraggable(upHeader, upContent);
            }

            // Optional: Auto-fill from Search Input if it looks like coords
            const searchInput = document.getElementById('searchInput');
            if (searchInput && searchInput.value) {
                const parts = searchInput.value.split(',');
                if (parts.length === 2) {
                    const lat = parseFloat(parts[0].trim());
                    const lng = parseFloat(parts[1].trim());
                    if (!isNaN(lat) && !isNaN(lng)) {
                        document.getElementById('upLat').value = lat;
                        document.getElementById('upLng').value = lng;
                    }
                }
            }
        };
    }

    if (submitUserPoint) {
        submitUserPoint.onclick = () => {
            const nameInput = document.getElementById('upName');
            const latInput = document.getElementById('upLat');
            const lngInput = document.getElementById('upLng');

            const name = nameInput.value.trim() || 'User Point';
            const lat = parseFloat(latInput.value);
            const lng = parseFloat(lngInput.value);

            if (isNaN(lat) || isNaN(lng)) {
                alert('Invalid Coordinates. Please enter valid numbers.');
                return;
            }

            if (!window.map) {
                alert('Map not initialized.');
                return;
            }

            // Add Marker via Leaflet
            // Using a distinct icon color or style could be nice, but default blue is fine for now.
            const marker = L.marker([lat, lng]).addTo(window.map);

            // Assign a unique ID to the marker for removal
            const markerId = 'user_point_' + Date.now();
            marker._pointId = markerId;

            // Store marker in a global map if not exists
            if (!window.userMarkers) window.userMarkers = {};
            window.userMarkers[markerId] = marker;

            // Define global remover if not exists
            if (!window.removeUserPoint) {
                window.removeUserPoint = (id) => {
                    const m = window.userMarkers[id];
                    if (m) {
                        m.remove();
                        delete window.userMarkers[id];
                    }
                };
            }

            const popupContent = `
            <div style="font-size:13px; min-width:150px;">
                <b>${name}</b><br>
                <div style="color:#888; font-size:11px; margin-top:4px;">${lat.toFixed(5)}, ${lng.toFixed(5)}</div>
                <button onclick="window.removeUserPoint('${markerId}')" style="margin-top:8px; background:#ef4444; color:white; border:none; padding:2px 5px; border-radius:3px; cursor:pointer; font-size:10px;">Remove</button>
            `;

            marker.bindPopup(popupContent).openPopup();

            // Close Modal
            userPointModal.style.display = 'none';

            // Pan to location
            window.map.panTo([lat, lng]);

            // Clear Inputs (Optional, or keep for repeated entry?)
            // Let's keep name but clear coords or clear all? 
            // Clearing all is standard.
            nameInput.value = '';
            latInput.value = '';
            lngInput.value = '';
        };
    }

});

// --- SITE EDITOR LOGIC ---

window.refreshSites = function () {
    if (window.mapRenderer && window.mapRenderer.siteData) {
        // Pass id, name, sectors, fitBounds
        window.mapRenderer.addSiteLayer('default_layer', 'Sites', window.mapRenderer.siteData, false);
    }
};

function ensureSiteEditorDraggable() {
    const modal = document.getElementById('siteEditorModal');
    if (!modal) return;
    const content = modal.querySelector('.modal-content');
    const header = modal.querySelector('.modal-header');

    // Center it initially (if not already moved)
    if (!content.dataset.centered) {
        const w = 400; // rough width
        const h = 500; // rough height
        content.style.position = 'absolute';
        // Simple center based on viewport
        content.style.left = Math.max(0, (window.innerWidth - w) / 2) + 'px';
        content.style.top = Math.max(0, (window.innerHeight - h) / 2) + 'px';
        content.style.margin = '0'; // Remove auto margin if present
        content.dataset.centered = "true";
    }

    // Init Drag if not done
    if (typeof makeElementDraggable === 'function' && !content.dataset.draggable) {
        makeElementDraggable(header, content);
        content.dataset.draggable = "true";
        header.style.cursor = "move"; // Explicitly show move cursor on header
    }
}

window.openAddSectorModal = function () {
    document.getElementById('siteEditorTitle').textContent = "Add New Site";
    document.getElementById('editOriginalId').value = "";
    document.getElementById('editOriginalIndex').value = ""; // Clear Index

    // Clear inputs
    document.getElementById('editSiteName').value = "";
    document.getElementById('editCellName').value = "";
    document.getElementById('editCellId').value = "";
    document.getElementById('editLat').value = "";
    document.getElementById('editLng').value = "";
    document.getElementById('editAzimuth').value = "0";
    document.getElementById('editPci').value = "";
    document.getElementById('editTech').value = "4G";

    // Hide Delete Button for New Entry
    document.getElementById('btnDeleteSector').style.display = 'none';

    // Hide Sibling Button
    const btnSibling = document.getElementById('btnAddSiblingSector');
    if (btnSibling) btnSibling.style.display = 'none';

    const modal = document.getElementById('siteEditorModal');
    modal.style.display = 'block';

    ensureSiteEditorDraggable();

    // Auto-center
    const content = modal.querySelector('.modal-content');
    requestAnimationFrame(() => {
        const rect = content.getBoundingClientRect();
        if (rect.width > 0) {
            content.style.left = Math.max(0, (window.innerWidth - rect.width) / 2) + 'px';
            content.style.top = Math.max(0, (window.innerHeight - rect.height) / 2) + 'px';
        }
    });
};

// Index-based editing (Robust for duplicates)
// Layer-compatible editing
window.editSector = function (layerId, index) {
    if (!window.mapRenderer || !window.mapRenderer.siteLayers) return;
    const layer = window.mapRenderer.siteLayers.get(String(layerId));
    if (!layer || !layer.sectors || !layer.sectors[index]) {
        console.error("Sector not found:", layerId, index);
        return;
    }
    const s = layer.sectors[index];

    document.getElementById('siteEditorTitle').textContent = "Edit Sector";
    document.getElementById('editOriginalId').value = s.cellId || ""; // keep original for reference if needed

    // Store context for saving
    document.getElementById('editLayerId').value = layerId;
    document.getElementById('editOriginalIndex').value = index;

    // Populate
    document.getElementById('editSiteName').value = s.siteName || s.name || "";
    document.getElementById('editCellName').value = s.cellName || "";
    document.getElementById('editCellId').value = s.cellId || "";
    document.getElementById('editLat').value = s.lat;
    document.getElementById('editLng').value = s.lng;
    document.getElementById('editAzimuth').value = s.azimuth || 0;
    document.getElementById('editPci').value = s.sc || s.pci || "";
    document.getElementById('editTech').value = s.tech || "4G";
    document.getElementById('editBeamwidth').value = s.beamwidth || 65;

    // UI Helpers
    document.getElementById('btnDeleteSector').style.display = 'inline-block';
    const btnSibling = document.getElementById('btnAddSiblingSector');
    if (btnSibling) btnSibling.style.display = 'inline-block';

    const modal = document.getElementById('siteEditorModal');
    modal.style.display = 'block';

    if (typeof ensureSiteEditorDraggable === 'function') ensureSiteEditorDraggable();

    // Auto-center
    const content = modal.querySelector('.modal-content');
    requestAnimationFrame(() => {
        const rect = content.getBoundingClientRect();
        if (rect.width > 0) {
            content.style.left = Math.max(0, (window.innerWidth - rect.width) / 2) + 'px';
            content.style.top = Math.max(0, (window.innerHeight - rect.height) / 2) + 'px';
        }
    });
};

window.addSectorToCurrentSite = function () {
    // Read current context before clearing
    const currentName = document.getElementById('editSiteName').value;
    const currentLat = document.getElementById('editLat').value;
    const currentLng = document.getElementById('editLng').value;
    const currentTech = document.getElementById('editTech').value;

    // Switch to Add Mode
    document.getElementById('siteEditorTitle').textContent = "Add Sector to Site";
    document.getElementById('editOriginalId').value = ""; // Clear
    document.getElementById('editOriginalIndex').value = ""; // Clear Index

    // Clear Attributes specific to sector
    document.getElementById('editCellName').value = ""; // Clear Cell Name
    document.getElementById('editCellId').value = "";
    document.getElementById('editAzimuth').value = "0";
    document.getElementById('editPci').value = "";

    // Keep Site-level Attributes
    document.getElementById('editSiteName').value = currentName;
    document.getElementById('editLat').value = currentLat;
    document.getElementById('editLng').value = currentLng;
    document.getElementById('editTech').value = currentTech;

    // Hide Delete & Sibling Buttons
    document.getElementById('btnDeleteSector').style.display = 'none';
    const btnSibling = document.getElementById('btnAddSiblingSector');
    if (btnSibling) btnSibling.style.display = 'none';
};



window.saveSector = function () {
    if (!window.mapRenderer) return;

    const layerId = document.getElementById('editLayerId').value;
    const originalIndex = document.getElementById('editOriginalIndex').value;

    // Validate Layer
    let layer = null;
    let sectors = null;

    if (layerId && window.mapRenderer.siteLayers.has(layerId)) {
        layer = window.mapRenderer.siteLayers.get(layerId);
        sectors = layer.sectors;
    } else {
        // Fallback for VERY legacy or newly created "default" sites without layer?
        // Unlikely in new architecture. Alert error.
        alert("Layer Context Lost. Cannot save sector.");
        return;
    }

    // Determine target index
    let idx = -1;
    if (originalIndex !== "" && originalIndex !== null) {
        idx = parseInt(originalIndex, 10);
    }

    const isNew = (idx === -1);

    const newAzimuth = parseInt(document.getElementById('editAzimuth').value, 10);
    const newSiteName = document.getElementById('editSiteName').value;

    const newObj = {
        siteName: newSiteName,
        name: newSiteName,
        cellName: (document.getElementById('editCellName').value || newSiteName),
        cellId: (document.getElementById('editCellId').value || newSiteName + "_1"),
        lat: parseFloat(document.getElementById('editLat').value),
        lng: parseFloat(document.getElementById('editLng').value),
        azimuth: isNaN(newAzimuth) ? 0 : newAzimuth,
        // Tech & PCI
        tech: document.getElementById('editTech').value,
        sc: document.getElementById('editPci').value,
        pci: document.getElementById('editPci').value, // Sync both
        // Beamwidth
        beamwidth: parseInt(document.getElementById('editBeamwidth').value, 10) || 65
    };

    // Compute RNC/CID if possible
    try {
        if (String(newObj.cellId).includes('/')) {
            const parts = newObj.cellId.split('/');
            newObj.rnc = parts[0];
            newObj.cid = parts[1];
        } else {
            // If numeric > 65535, try split
            const num = parseInt(newObj.cellId, 10);
            if (!isNaN(num) && num > 65535) {
                newObj.rnc = num >> 16;
                newObj.cid = num & 0xFFFF;
            }
        }
    } catch (e) { }

    // Add Derived Props
    newObj.rawEnodebCellId = newObj.cellId;

    if (isNew) {
        sectors.push(newObj);
        console.log('[SiteEditor] created sector in layer ' + layerId);
    } else {
        // Update valid index
        if (sectors[idx]) {
            const oldS = sectors[idx];
            const oldAzimuth = oldS.azimuth;
            const oldSiteName = oldS.siteName || oldS.name;

            // 1. Update the target sector
            // Merge to preserve other props like frequency if not edited
            sectors[idx] = { ...sectors[idx], ...newObj };
            console.log('[SiteEditor] updated sector ' + idx + ' in layer ' + layerId);

            // 2. Synchronize Azimuth if changed
            if (oldAzimuth !== newAzimuth && !isNaN(oldAzimuth) && !isNaN(newAzimuth)) {
                // Find others with same site name and SAME OLD AZIMUTH
                sectors.forEach((s, subIdx) => {
                    const sName = s.siteName || s.name;
                    // Loose check for Site Name match
                    if (String(sName) === String(oldSiteName) && subIdx !== idx) {
                        if (s.azimuth === oldAzimuth) {
                            s.azimuth = newAzimuth; // Sync
                            console.log('[SiteEditor] Synced azimuth for sector ' + subIdx);
                        }
                    }
                });
            }
        }
    }

    // Refresh Map
    window.mapRenderer.rebuildSiteIndex();
    window.mapRenderer.renderSites(false);

    document.getElementById('siteEditorModal').style.display = 'none';
};


window.deleteSectorCurrent = function () {
    const originalIndex = document.getElementById('editOriginalIndex').value;
    const originalId = document.getElementById('editOriginalId').value;

    if (!confirm("Are you sure you want to delete this sector?")) return;

    if (window.mapRenderer && window.mapRenderer.siteData) {
        let idx = -1;
        if (originalIndex !== "") {
            idx = parseInt(originalIndex, 10);
        } else if (originalId) {
            idx = window.mapRenderer.siteData.findIndex(x => String(x.cellId) === String(originalId));
        }

        if (idx !== -1) {
            window.mapRenderer.siteData.splice(idx, 1);
            window.refreshSites();
            document.getElementById('siteEditorModal').style.display = 'none';
            // Sync to Backend
            window.syncToBackend(window.mapRenderer.siteData);
        }
    }
};

window.syncToBackend = function (siteData) {
    if (!siteData) return;

    // Show saving feedback
    const status = document.getElementById('fileStatus');
    if (status) status.textContent = "Saving to Excel...";

    fetch('/save_sites', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(siteData)
    })
        .then(response => response.json())
        .then(data => {
            console.log('Save success:', data);
            if (status) status.textContent = "Changes saved to sites_updated.xlsx";
            setTimeout(() => { if (status) status.textContent = ""; }, 3000);
        })
        .catch((error) => {
            console.error('Save error:', error);
            if (status) status.textContent = "Error saving to Excel (Check console)";
        });
};

// Initialize Map Action Controls Draggability
// Map Action Controls are now fixed in the header, no draggability needed.

// ----------------------------------------------------
window.generateManagementSummary = (d) => {
    if (!d) {
        const script = document.getElementById('point-data-stash');
        if (script) d = JSON.parse(script.textContent);
    }
    if (!d) return;

    const getVal = (keys) => {
        for (const k of keys) {
            if (d[k] !== undefined && d[k] !== null && d[k] !== '') {
                const clean = String(d[k]).replace(/[^\d.-]/g, '');
                const floatVal = parseFloat(clean);
                if (!isNaN(floatVal)) return floatVal;
            }
        }
        return null;
    };

    // Metrics
    const rsrp = getVal(['RSRP', 'Signal Strength', 'rsrp']);
    const sinr = getVal(['SINR', 'Sinr', 'sinr']);
    const dlTput = getVal(['DL Throughput', 'Downlink Throughput', 'DL_Throughput']);
    const prbLoad = getVal(['PRB Load', 'Load', 'Cell Load']);

    // Context
    const cellId = d['Cell Identifier'] || 'Unknown';

    // Robust Location Lookup
    const latRaw = d['lat'] || d['Latitude'] || d['latitude'] || d['LAT'];
    const lngRaw = d['lng'] || d['Longitude'] || d['longitude'] || d['LONG'];

    let location = "Unknown";
    if (latRaw && lngRaw) {
        const lat = parseFloat(latRaw);
        const lng = parseFloat(lngRaw);
        if (!isNaN(lat) && !isNaN(lng)) {
            location = lat.toFixed(5) + ', ' + lng.toFixed(5);
        }
    }

    // --- 2. Logic Engine ---

    // A. Overall Performance Status
    let status = "Satisfactory";
    let statusClass = "status-ok"; // Default Green

    if (rsrp !== null && rsrp < -110) { status = "Critically Degraded (Coverage)"; statusClass = "status-bad"; }
    else if (sinr !== null && sinr < 0) { status = "Critically Degraded (Interference)"; statusClass = "status-bad"; }
    else if (rsrp !== null && rsrp < -100) { status = "Poor"; statusClass = "status-bad"; }
    else if (sinr !== null && sinr < 5) { status = "Suboptimal"; statusClass = "status-warn"; }
    else if (rsrp > -95 && sinr > 10) { status = "Excellent"; statusClass = "status-ok"; }

    // B. User Impact & Service
    let userExp = "Satisfactory";
    let impactedService = "None specific";
    let impactClass = "status-ok";
    let isLowTput = false;

    if (dlTput !== null) {
        if (dlTput < 1) { userExp = "Severely Limited"; impactedService = "Real-time Video & Browsing"; isLowTput = true; impactClass = "status-bad"; }
        else if (dlTput < 3) { userExp = "Degraded"; impactedService = "HD Video Streaming"; isLowTput = true; impactClass = "status-warn"; }
        else if (dlTput < 5) { userExp = "Acceptable"; impactedService = "File Downloads"; impactClass = "status-warn"; }
        else { userExp = "Good"; impactedService = "High Bandwidth Applications"; impactClass = "status-ok"; }
    } else {
        if (status.includes("Critical")) { userExp = "Severely Limited"; impactedService = "All Data Services"; impactClass = "status-bad"; }
        else if (status.includes("Poor")) { userExp = "Degraded"; impactedService = "High Bitrate Video"; impactClass = "status-warn"; }
    }

    // C. Primary Issues
    let primaryCause = "None detected";
    let secondaryCause = "";

    if (rsrp !== null && rsrp < -110) primaryCause = "Weak RF Coverage (Dead Zone)";
    else if (sinr !== null && sinr < 3) primaryCause = "High Signal Interference";
    else if (prbLoad !== null && prbLoad > 80) primaryCause = "High Capacity Utilization (Load)";
    else if (sinr !== null && sinr < 8) primaryCause = "Moderate Interference (Pilot Pollution)";
    else if (rsrp !== null && rsrp < -100) primaryCause = "Weak RF Coverage (Edge of Cell)";

    if (primaryCause.includes("Coverage") && sinr !== null && sinr < 5) secondaryCause = "Compounded by Interference";
    if (primaryCause.includes("Interference") && rsrp !== null && rsrp < -105) secondaryCause = "Compounded by Weak Signal";

    // D. Congestion Analysis
    let congestionStatus = "not congested";
    let issueType = "radio-quality-related";
    let congestionClass = "status-ok";

    if (prbLoad !== null && prbLoad > 75) {
        congestionStatus = "congested";
        issueType = "capacity-related";
        congestionClass = "status-bad";
    } else if (rsrp > -95 && sinr > 10 && isLowTput) {
        congestionStatus = "likely congested (Backhaul/Transport)";
        issueType = "capacity-related";
        congestionClass = "status-warn";
    }

    // E. Actions
    let highPriority = [];
    let mediumPriority = [];
    let conclusionAction = "targeted optimization";

    if (primaryCause.includes("Coverage") && congestionStatus.includes("congested")) {
        highPriority.push("Review Power Settings / Load Balancing");
        highPriority.push("Capacity Expansion (Carrier Add/Sector Split)");
        conclusionAction = "capacity expansion";
    } else if (primaryCause.includes("Coverage")) {
        highPriority.push("Check Antenna Tilt (Uptilt if possible)");
        highPriority.push("Verify Neighbor Cell Relations");
        mediumPriority.push("Drive Test Verification required");
    } else if (primaryCause.includes("Interference")) {
        highPriority.push("Check Overshooting Neighbors");
        highPriority.push("Review Antenna Downtilts");
        mediumPriority.push("PCI Planning Review");
    } else if (congestionStatus.includes("congested")) {
        highPriority.push("Load Balancing Strategy Review");
        highPriority.push("Capacity Expansion Planning");
        conclusionAction = "capacity expansion";
    } else {
        highPriority.push("Routine Performance Monitoring");
        mediumPriority.push("Verify Parameter Consistency");
    }

    if (highPriority.length === 0) highPriority.push("Monitor Performance Trend");

    // --- 3. Format Output (HTML Structure) ---
    // Helper to colorize Cause
    const causeClass = primaryCause === "None detected" ? "status-ok" : "status-bad";

    const report = `
                    < div class="report-block" >
                <h4>CELL PERFORMANCE – MANAGEMENT SUMMARY</h4>
                <div style="display:flex; justify-content:space-between; margin-bottom:10px;">
                    <div><strong>Cell ID:</strong> ${cellId}</div>
                    <div><strong>Location:</strong> ${location}</div>
                    <div><strong>Technology:</strong> LTE</div>
                </div>
            </div >

            <div class="report-block">
                <h4>Overall Performance Status</h4>
                <p>The cell performance is classified as <span class="${statusClass}" style="padding:2px 6px; border-radius:4px; font-weight:bold;">${status}</span>.</p>

            <div class="report-block">
                <h4>User Impact</h4>
                <p>
                   Downlink user experience is <span class="${impactClass}" style="font-weight:bold;">${userExp}</span>,
                   mainly affecting <strong>${impactedService}</strong> traffic.
                </p>

            <div class="report-block">
                <h4>Primary Issue(s)</h4>
                <p>The main performance limitation(s) identified are:</p>
                <ul>
                    <li><span class="${causeClass}" style="font-weight:bold;">${primaryCause}</span></li>
                    ${secondaryCause ? '<li>' + (secondaryCause) + '</li>' : ''}
                </ul>
                <p style="margin-top:5px; font-size:0.9em; color:#bbb;">
                    <em>This issue is impacting: Data speeds, Service stability, User experience consistency.</em>
                </p>

            <div class="report-block">
                <h4>Network Load Assessment</h4>
                <p>The cell is <span class="${congestionClass}" style="font-weight:bold;">${congestionStatus}</span>,</p>
                <p>indicating that the performance issue is <strong>${issueType}</strong>.</p>

            <div class="report-block">
                <h4>Recommended Actions</h4>
                
                <h5 style="color:#ff6b6b; margin:10px 0 5px 0;">Immediate actions recommended:</h5>
                <ul>
                    ${highPriority.map(a => '<li>' + (a) + '</li>').join('')}
                </ul>

                <h5 style="color:#ffd93d; margin:10px 0 5px 0;">Supporting optimization actions:</h5>
                <ul>
                    ${mediumPriority.length > 0 ? mediumPriority.map(a => '<li>' + (a) + '</li>').join('') : '<li>None required at this stage</li>'}
                </ul>

            <div class="report-block" style="border-left: 4px solid #a29bfe; background: rgba(162, 155, 254, 0.1);">
                <h4 style="color:#a29bfe;">EXECUTIVE CONCLUSION</h4>
                <p>
                    This LTE cell requires <strong>${conclusionAction.toUpperCase()}</strong> 
                    to improve customer experience and overall network efficiency.
                </p>
            `;

    // --- 4. Display ---
    window.showAnalysisModal(report, "MANAGEMENT SUMMARY");
};

window.showAnalysisModal = (content, title) => {
    let modal = document.getElementById('analysisModal');

    // --- LAZY CREATE MODAL IF MISSING ---
    if (!modal) {
        const modalHtml = `
    <div class="analysis-modal-overlay" onclick="const m=document.querySelector('.analysis-modal-overlay'); if(event.target===m) m.remove()">
        <div class="analysis-modal" id="analysisModal" style="width: 800px; max-width: 90vw; display:flex;">
            <div class="analysis-header">
                <h3 id="analysisModalTitle">Cell Performance Analysis Report</h3>
                <button class="analysis-close-btn" onclick="document.querySelector('.analysis-modal-overlay').remove()">×</button>
            <div class="analysis-content" style="padding: 30px;" id="analysisResultBody">
                <!-- Content Injected Here -->
        </div>
                </div >
    `;
        const div = document.createElement('div');
        div.innerHTML = modalHtml;
        document.body.appendChild(div.firstElementChild);
        modal = document.getElementById('analysisModal'); // Re-select
    }

    const body = document.getElementById('analysisResultBody');
    const header = document.getElementById('analysisModalTitle');

    if (header && title) header.textContent = title;

    // Always render HTML now. 
    // Logic for "MANAGEMENT SUMMARY" specifically handled <pre> before, 
    // now we WANT HTML for it too.
    body.innerHTML = content;

    // Ensure overlay is visible if it was hidden or re-created
    const overlay = modal.closest('.analysis-modal-overlay');
    if (overlay) overlay.style.display = 'flex'; // Assuming flex for overlay centering
    modal.style.display = 'block';
};


window.showEvent1AGrid = function (logId) {
    const log = loadedLogs.find(l => l.id === logId);
    if (!log) return;

    // Use history if available, else fallback to single config
    const history = log.configHistory && log.configHistory.length > 0 ? log.configHistory : (log.config ? [log.config] : []);

    const existing = document.querySelector('.event1a-modal-overlay');
    if (existing) existing.remove();

    // Helper to find point and pan map
    window.locateEvent1A = function (timeStr) {
        if (!timeStr || timeStr === 'N/A') return;
        // Find point with this time
        const point = log.points.find(p => p.time === timeStr);
        if (point) {
            // Pan map
            if (window.map) {
                window.map.setView([point.lat, point.lng], 18);
                // Optional: Create a temporary popup or marker
                L.popup()
                    .setLatLng([point.lat, point.lng])
                    .setContent(`<b>Event 1A Point</b><br>Time: ${timeStr}`)
                    .openOn(window.map);
            }
        } else {
            console.warn('Point not found for time:', timeStr);
        }
    };

    let rowsHtml = '';
    history.forEach(item => {
        const timeVal = item.time || 'N/A';
        const cursorStyle = timeVal !== 'N/A' ? 'cursor:pointer;' : '';
        const hoverEffect = timeVal !== 'N/A' ? 'onmouseover="this.style.background=\'#4b5563\'" onmouseout="this.style.background=\'\'" onclick="window.locateEvent1A(\'' + timeVal + '\')"' : '';

        // Map old 'threshold' to 'thresholdRSCP' if legacy
        const rscpThresh = item.thresholdRSCP ?? item.threshold ?? '-';
        const ecnoThresh = item.thresholdEcNo ?? '-';

        rowsHtml += `
            <tr style="border-bottom:1px solid #374151; transition:background 0.2s; ${cursorStyle}" ${hoverEffect}>
                <td style="padding:8px; font-size:12px; color:#d1d5db;">${timeVal}</td>
                <td style="padding:8px; font-size:12px; font-weight:bold; color:#fff;">${item.range ?? '-'} <span style="font-size:10px; font-weight:normal; color:#9ca3af;">dB</span></td>
                <td style="padding:8px; font-size:12px; font-weight:bold; color:#fff;">${item.hysteresis ?? '-'} <span style="font-size:10px; font-weight:normal; color:#9ca3af;">dB</span></td>
                <td style="padding:8px; font-size:12px; font-weight:bold; color:#fff;">${item.timeToTrigger ?? '-'} <span style="font-size:10px; font-weight:normal; color:#9ca3af;">ms</span></td>
                <td style="padding:8px; font-size:12px; font-weight:bold; color:#fff;">${rscpThresh}</td>
                <td style="padding:8px; font-size:12px; font-weight:bold; color:#fff;">${ecnoThresh}</td>
                <td style="padding:8px; font-size:10px; color:#d1d5db; max-width:150px; overflow:hidden; text-overflow:ellipsis;" title="${item.rawValues ? item.rawValues.join(', ') : ''}">${item.rawValues ? item.rawValues.join(', ') : '-'}</td>
                <td style="padding:8px; font-size:12px; font-weight:bold; color:#fff;">${item.maxActiveSet ?? '3'}</td>
            </tr>
        `;
    });

    const html = `
            <div class="event1a-modal-overlay" style="position:fixed; top:0; left:0; width:100vw; height:100vh; background:rgba(0,0,0,0.6); display:flex; justify-content:center; align-items:center; z-index:9999;" onclick="if(event.target===this) this.remove()">
                <div style="background:#1f2937; color:#f3f4f6; padding:20px; border-radius:8px; width:600px; max-height:80vh; display:flex; flex-direction:column; box-shadow:0 4px 6px rgba(0,0,0,0.3);">
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:15px; border-bottom:1px solid #374151; padding-bottom:10px;">
                        <h3 style="margin:0; font-size:16px;">Event 1A – Add cell to Active Set (History)</h3>
                        <button onclick="this.closest('.event1a-modal-overlay').remove()" style="background:none; border:none; color:#9ca3af; font-size:18px; cursor:pointer;">×</button>
                    </div>
                    
                    <div style="color:#9ca3af; font-size:12px; margin-bottom:10px;">
                        * Click on a row to locate the configuration point on the map.
                    </div>

                    <div style="overflow-y:auto; flex:1;">
                        <table style="width:100%; border-collapse:collapse; text-align:left;">
                            <thead>
                                <tr style="background:#374151; position:sticky; top:0;">
                                    <th style="padding:8px; font-size:11px; color:#9ca3af; font-weight:normal;">Time</th>
                                    <th style="padding:8px; font-size:11px; color:#9ca3af; font-weight:normal;">Ec/No Range</th>
                                    <th style="padding:8px; font-size:11px; color:#9ca3af; font-weight:normal;">Hysteresis</th>
                                    <th style="padding:8px; font-size:11px; color:#9ca3af; font-weight:normal;">Time to Trigger</th>
                                    <th style="padding:8px; font-size:11px; color:#9ca3af; font-weight:normal;">RSCP Thresh</th>
                                    <th style="padding:8px; font-size:11px; color:#9ca3af; font-weight:normal;">Ec/No Thresh</th>
                                    <th style="padding:8px; font-size:11px; color:#9ca3af; font-weight:normal;">Raw Params (Debug)</th>
                                    <th style="padding:8px; font-size:11px; color:#9ca3af; font-weight:normal;">Max AS</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${rowsHtml}
                            </tbody>
                        </table>
                    </div>

                    <div style="margin-top:20px; text-align:right; border-top:1px solid #374151; padding-top:10px;">
                        <button onclick="this.closest('.event1a-modal-overlay').remove()" style="padding:6px 16px; background:#2563eb; color:white; border:none; border-radius:4px; cursor:pointer;">Close</button>
                    </div>
                </div>
        `;

    const div = document.createElement('div');
    div.innerHTML = html;
    document.body.appendChild(div.firstElementChild);
};



// --- Throughput Analysis Feature ---
window.throughputAnalysis = (btn) => {
    try {
        let script = document.getElementById('point-data-stash');
        if (!script && btn) {
            const container = btn.closest('.panel, .card, .modal') || btn.parentNode;
            script = container?.querySelector('#point-data-stash');
        }

        if (!script) {
            alert('Analysis data missing.');
            return;
        }

        const data = JSON.parse(script.textContent);

        // 1. Evaluate Scenarios
        const report = performSmartThroughputAnalysis(data);
        console.log('Throughput Analysis Report:', report);

        // 2. Render Report
        renderThroughputReport(report);

    } catch (e) {
        console.error('Throughput Analysis error:', e);
        alert('Analysis error: ' + e.message);
    }
};

function performSmartThroughputAnalysis(data) {
    // Helper to get float values safely
    const getVal = (...aliases) => {
        for (const a of aliases) {
            const na = a.toLowerCase().replace(/[\s\-_()%]/g, '');
            for (const k in data) {
                const nk = k.toLowerCase().replace(/[\s\-_()%]/g, '');
                if (nk === na || nk.includes(na)) {
                    const v = parseFloat(data[k]);
                    if (!Number.isNaN(v)) return v;
                }
            }
        }
        return null;
    };

    const kpi = {
        rsrp: getVal('dominant rsrp', 'rsrp'),
        rsrq: getVal('dominant rsrq', 'rsrq'),
        cqi: getVal('average dl wideband cqi', 'cqi'),
        sinr: getVal('sinr', 'average sinr'),
        bler: getVal('dl ibler', 'bler'),
        ulBler: getVal('ul ibler'),
        avgDlThp: getVal('average dl throughput', 'avg dl thp'),
        maxDlThp: getVal('maximum dl throughput', 'max dl thp'),
        dlLowRatio: getVal('dl low-throughput ratio', 'dl low thp ratio'),
        dlRbQty: getVal('average dl rb quantity', 'dl rb'),
        ulRbQty: getVal('average ul rb quantity', 'ul rb'),
        rank1: getVal('rank 1 percentage', 'rank1'),
        rank2: getVal('rank 2 percentage', 'rank2'),
        dl1cc: getVal('dl 1cc percentage'),
        dl2cc: getVal('dl 2cc percentage'),
        specEff: getVal('dl spectrum efficiency', 'spectral efficiency'),
        traffic: getVal('total traffic volume'),
        users: getVal('rrc connected users', 'average users'),
        packetLoss: getVal('packet loss', 'pl'),
        latency: getVal('latency', 'rtt'),
        retrans: getVal('rlc retransmission', 'harq retransmission'),
        ulThp: getVal('average ul throughput'),
        maxUlThp: getVal('maximum ul throughput', 'max ul thp')
    };

    // --- SMART RCA LOGIC ---
    let primaryDiagnosis = "Healthy / Normal Performance";
    let color = "green";
    const contributors = [];
    const actions = [];
    let rcaNarrative = "Metrics indicate the cell is performing within expected parameters.";

    // Thresholds
    const t = {
        traffic: 0.5,
        coverage: { rsrp: -110, cqi: 7 },
        quality: { rsrq: -14, sinr: 5 },
        load: { prb: 80 },
        efficiency: { se: 1.0, cqi: 10 },
        throughput: { low: 2000 } // kbps
    };

    // 1. Data Validity Check (Low Traffic)
    if (kpi.traffic !== null && kpi.traffic < t.traffic) {
        primaryDiagnosis = "⚠️ LOW TRAFFIC VOLUME";
        color = "gray";
        rcaNarrative = `Total traffic volume (${kpi.traffic} MB) is too low for reliable analysis.`;
        contributors.push(`Traffic Volume < ${t.traffic} MB`);
        actions.push("Ignore this point for performance benchmarking.");
        actions.push("Retest with larger file download.");

        return { kpi, primaryDiagnosis, color, rcaNarrative, contributors, actions };
    }

    // Only proceed to detailed RCA if Throughput is Low
    if (kpi.avgDlThp !== null && kpi.avgDlThp < t.throughput.low) {

        // 2. Coverage Check
        // If RSRP < -110 dBm AND CQI is low (< 7) -> Coverage Limited.
        if (kpi.rsrp !== null && kpi.rsrp < t.coverage.rsrp && kpi.cqi !== null && kpi.cqi < t.coverage.cqi) {
            primaryDiagnosis = "⚠️ COVERAGE LIMITED";
            color = "red";
            rcaNarrative = "Throughput is limited by weak signal strength and poor channel quality.";
            contributors.push(`RSRP (${kpi.rsrp} dBm) < ${t.coverage.rsrp} dBm`);
            contributors.push(`CQI (${kpi.cqi}) < ${t.coverage.cqi}`);

            actions.push("Check antenna tilt (uptilt/azimuth adjustment).");
            actions.push("Verify site coverage area.");
            actions.push("Consider coverage expansion (New Site/Repeater).");

        }
        // 3. Quality Check
        // Is RSRQ < -14 dB or SINR < 5 dB? -> Quality/Interference Limited.
        else if ((kpi.rsrq !== null && kpi.rsrq < t.quality.rsrq) || (kpi.sinr !== null && kpi.sinr < t.quality.sinr)) {
            primaryDiagnosis = "⚠️ QUALITY / INTERFERENCE LIMITED";
            color = "orange";
            rcaNarrative = "Signal quality is degraded by interference, impacting throughput.";
            if (kpi.rsrq < t.quality.rsrq) contributors.push(`RSRQ (${kpi.rsrq} dB) < ${t.quality.rsrq} dB`);
            if (kpi.sinr < t.quality.sinr) contributors.push(`SINR (${kpi.sinr} dB) < ${t.quality.sinr} dB`);

            actions.push("Check for overshooting neighbors/pollution.");
            actions.push("Optimize antenna downtilts.");
            actions.push("Review PCI planning (Collision/Confusion).");

        }
        // 4. Load Check
        // If PRB Usage > 80% AND Radio Quality is good (implied else) -> Capacity Limited
        else if (kpi.dlRbQty !== null && kpi.dlRbQty > t.load.prb) {
            primaryDiagnosis = "⚠️ CAPACITY LIMITED (CONGESTION)";
            color = "red";
            rcaNarrative = "High cell load is restricting user throughput resources.";
            contributors.push(`PRB Usage (${kpi.dlRbQty}%) > ${t.load.prb}%`);

            actions.push("Enable Carrier Aggregation / Load Balancing.");
            actions.push("Capacity Expansion (New Carrier/Sector Split).");
            actions.push("Check user density and heavy traffic users.");

        }
        // 5. Efficiency Check
        // If Spectral Efficiency < 1.0 AND CQI >= 10 -> Radio Efficiency Issue
        else if (kpi.specEff !== null && kpi.specEff < t.efficiency.se && kpi.cqi !== null && kpi.cqi >= t.efficiency.cqi) {
            primaryDiagnosis = "⚠️ RADIO EFFICIENCY ISSUE";
            color = "yellow";
            rcaNarrative = "Channel quality (CQI) is good, but Spectrum Efficiency is unexpectedly low.";
            contributors.push(`Spectral Efficiency (${kpi.specEff}) < ${t.efficiency.se} bps/Hz`);
            contributors.push(`CQI (${kpi.cqi}) >= ${t.efficiency.cqi}`);

            if (kpi.rank1 > 80) contributors.push(`MIMO Rank 1 High: ${kpi.rank1}%`);

            actions.push("Check MIMO configuration and cabling.");
            actions.push("Verify transmission mode settings.");
            actions.push("Check for potential device limitations.");

        }
        // 6. UE/Backhaul Check
        // If Radio & Load are good but Thp is low -> Non-Radio Issue
        else {
            primaryDiagnosis = "⚠️ NON-RADIO ISSUE (BACKHAUL / UE / CORE)";
            color = "yellow";
            rcaNarrative = "Radio conditions (Coverage, Quality, Load) appear healthy, yet throughput is low.";
            contributors.push("Radio Metrics: Healthy");
            contributors.push(`Throughput: ${(kpi.avgDlThp / 1000).toFixed(2)} Mbps`);

            if (kpi.packetLoss > 1) contributors.push(`Packet Loss: ${kpi.packetLoss}%`);
            if (kpi.latency > 100) contributors.push(`Latency: ${kpi.latency} ms`);

            actions.push("Investigate Transport/Backhaul for congestion/errors.");
            actions.push("Check Core Network logs for GTP errors.");
            actions.push("Verify UE Category/Capability limitations.");
            actions.push("Check TCP Window performance (TCP Optimizers).");
        }

    } else if (kpi.avgDlThp !== null) {
        // High Throughput
        primaryDiagnosis = "✅ HEALTHY PERFORMANCE";
        color = "green";
        rcaNarrative = "Throughput is good (>2 Mbps). No critical issues detected.";
    }

    return { kpi, primaryDiagnosis, color, rcaNarrative, contributors, actions };
}

function renderThroughputReport(report) {
    const modalHtml = `
            <div class="analysis-modal-overlay nav-modal-overlay" onclick="if(event.target===this) this.remove()">
                <div class="analysis-modal" style="width: 800px; max-width: 95vw;">
                    <div class="analysis-header" style="background:#ea580c;"> <!-- Orange/Red for Thp Analysis -->
                        <h3>📉 LTE Throughput Diagnostic</h3>
                         <button class="analysis-close-btn" onclick="this.closest('.analysis-modal-overlay').remove()">×</button>
                    </div>
                    <div class="analysis-content" style="padding: 25px; background: #111827; color: #eee; max-height:80vh; overflow-y:auto;">
                        <div style="display:flex; gap:20px; margin-bottom:20px;">
                            <div style="flex:1; padding:15px; background:rgba(37, 99, 235, 0.1); border-radius:6px; border-left:4px solid #2563eb;">
                                <div style="font-size:12px; color:#aaa; margin-bottom:4px;">DOWNLINK</div>
                                ${report.kpi.avgDlThp ? `<div style="font-size:16px; font-weight:bold; color:#fff;">Avg: ${(report.kpi.avgDlThp / 1000).toFixed(2)} Mbps</div>` : ''}
                                ${report.kpi.maxDlThp ? `<div style="font-size:14px; color:#ccc;">Max: ${(report.kpi.maxDlThp / 1000).toFixed(2)} Mbps</div>` : ''}
                            </div>
                            <div style="flex:1; padding:15px; background:rgba(16, 185, 129, 0.1); border-radius:6px; border-left:4px solid #10b981;">
                                <div style="font-size:12px; color:#aaa; margin-bottom:4px;">UPLINK</div>
                                ${report.kpi.ulThp ? `<div style="font-size:16px; font-weight:bold; color:#fff;">Avg: ${(report.kpi.ulThp / 1000).toFixed(2)} Mbps</div>` : '<div style="color:#666; font-style:italic;">No UL Data</div>'}
                                ${report.kpi.maxUlThp ? `<div style="font-size:14px; color:#ccc;">Max: ${(report.kpi.maxUlThp / 1000).toFixed(2)} Mbps</div>` : ''}
                            </div>
                        </div>

                        <!-- Diagnosis Header -->
                        <div style="text-align:center; padding:20px; border-radius:8px; margin-bottom:25px; background:${report.color === 'red' ? 'rgba(239, 68, 68, 0.2)' : report.color === 'orange' ? 'rgba(249, 115, 22, 0.2)' : report.color === 'yellow' ? 'rgba(234, 179, 8, 0.2)' : 'rgba(16, 185, 129, 0.2)'}; border:2px solid ${report.color === 'red' ? '#ef4444' : report.color === 'orange' ? '#f97316' : report.color === 'yellow' ? '#eab308' : '#10b981'};">
                             <h2 style="margin:0; color:#fff; font-size:24px;">${report.primaryDiagnosis}</h2>
                             <p style="margin:10px 0 0 0; color:#ddd; font-size:15px;">${report.rcaNarrative}</p>
                        </div>

                        <!-- Contributors -->
                        ${report.contributors.length > 0 ? `
                        <div style="margin-bottom:25px;">
                            <h4 style="color:#bfdbfe; border-bottom:1px solid #333; padding-bottom:5px;">📊 Key Contributors</h4>
                             <ul style="display:grid; grid-template-columns: 1fr 1fr; gap:10px; margin-top:10px; padding-left:20px;">
                                ${report.contributors.map(c => `<li style="color:#e5e7eb;">${c}</li>`).join('')}
                             </ul>
                        </div>` : ''}

                         <!-- Actions -->
                        ${report.actions.length > 0 ? `
                        <div style="margin-bottom:25px;">
                            <h4 style="color:#86efac; border-bottom:1px solid #333; padding-bottom:5px;">🛠️ Recommended Actions</h4>
                             <ul style="margin-top:10px; padding-left:20px;">
                                ${report.actions.map(a => `<li style="color:#e5e7eb; margin-bottom:5px;">${a}</li>`).join('')}
                             </ul>
                        </div>` : ''}

                         <div style="margin-top:30px; border-top:1px solid #333; padding-top:10px; font-size:12px; color:#666;">
                            * AI Diagnosis matches the strongest correlation path.
                        </div>
                    </div>
                </div>
        `;

    const div = document.createElement('div');
    div.innerHTML = modalHtml;
    document.body.appendChild(div.firstElementChild);
}

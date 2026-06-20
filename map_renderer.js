class MapRenderer {
    constructor(elementId) {
        // PERFORMANCE: preferCanvas = true forces Leaflet to use Canvas renderer for Vectors
        // This makes rendering 10k-50k points buttery smooth compared to SVG.
        this.map = L.map(elementId, {
            preferCanvas: true,
            zoomControl: false,
            zoomSnap: 0.25,          // allow quarter-level zoom positions
            zoomDelta: 0.5,          // each scroll tick / +- button moves 0.5 levels
            wheelPxPerZoomLevel: 100 // pixels of scroll needed per full zoom level (default 60)
        }).setView([33.5, -7.5], 6);

        // Base Maps
        const darkLayer = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
            subdomains: 'abcd',
            maxZoom: 20
        });

        const lightLayer = L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
            subdomains: 'abcd',
            maxZoom: 20
        });

        const osmLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
            maxZoom: 19
        });

        const satelliteLayer = L.tileLayer('https://{s}.google.com/vt/lyrs=s&x={x}&y={y}&z={z}', {
            maxZoom: 20,
            subdomains: ['mt0', 'mt1', 'mt2', 'mt3'],
            attribution: '&copy; Google'
        });

        const googleHybridLayer = L.tileLayer('https://{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}', {
            maxZoom: 20,
            subdomains: ['mt0', 'mt1', 'mt2', 'mt3'],
            attribution: '&copy; Google'
        });

        // Set Default
        satelliteLayer.addTo(this.map);

        const baseMaps = {
            "Dark": darkLayer,
            "Light": lightLayer,
            "Streets": osmLayer,
            "Satellite": satelliteLayer,
            "Hybrid": googleHybridLayer
        };
        this.baseMaps = baseMaps;

        // Wire up the custom MAP dropdown from the header
        const mapLayerSelect = document.getElementById('mapLayerSelect');
        if (mapLayerSelect) {
            mapLayerSelect.value = 'Satellite';
            mapLayerSelect.addEventListener('change', (e) => {
                const selected = e.target.value;
                if (this.baseMaps[selected]) {
                    // Remove all existing base maps
                    Object.values(this.baseMaps).forEach(layer => {
                        if (this.map.hasLayer(layer)) {
                            this.map.removeLayer(layer);
                        }
                    });
                    // Add selected
                    this.baseMaps[selected].addTo(this.map);
                }
            });

            // Keep dropdown in sync if user uses the standard Leaflet control
            this.map.on('baselayerchange', (e) => {
                mapLayerSelect.value = e.name;
            });
        }

        this.logLayers = {}; // Store layers by ID/Name

        // Site Labels Layer (separate for performance)
        this.siteLabelsLayer = L.layerGroup();

        // Custom Pane for Connections (Lines)
        this.map.createPane('connectionsPane');
        this.map.getPane('connectionsPane').style.zIndex = 800;
        this.map.getPane('connectionsPane').style.pointerEvents = 'none';
        this.connectionsRenderer = L.canvas({ pane: 'connectionsPane' });

        // CUSTOM PANE FOR SITES (sectors) — z=750, ABOVE all RF panes.
        // SVG paths only fire on actual polygon geometry so empty space between
        // sectors falls through. Being at z=750 guarantees sector clicks are
        // never blocked by the RF canvas layers below.
        this.map.createPane('sitesPane');
        this.map.getPane('sitesPane').style.zIndex = 750;
        this.map.getPane('sitesPane').style.pointerEvents = 'auto';
        this.sitesRenderer = L.canvas({ pane: 'sitesPane', tolerance: 5 });
        this.sitesSvgRenderer = L.svg({ pane: 'sitesPane' });

        // RF log points (RSRP, etc.) — z=660, below sectors (750).
        this.map.createPane('logPointsPane');
        this.map.getPane('logPointsPane').style.zIndex = 660;
        this.map.getPane('logPointsPane').style.pointerEvents = 'auto';
        this.logPointsRenderer = L.canvas({ pane: 'logPointsPane', tolerance: 5 });

        // CUSTOM PANE FOR LABELS — z=700, between dots and sites, no pointer events
        this.map.createPane('labelsPane');
        this.map.getPane('labelsPane').style.zIndex = 760;
        this.map.getPane('labelsPane').style.pointerEvents = 'none';

        // CUSTOM PANE FOR EVENTS — z=665
        this.map.createPane('eventsPane');
        this.map.getPane('eventsPane').style.zIndex = 665;
        this.map.getPane('eventsPane').style.pointerEvents = 'auto';

        // CUSTOM PANE FOR PILOT POLLUTION CIRCLES — z=670
        this.map.createPane('pilotPollutionPane');
        this.map.getPane('pilotPollutionPane').style.zIndex = 670;
        this.map.getPane('pilotPollutionPane').style.pointerEvents = 'auto';

        // CUSTOM PANE FOR SMARTCARE GRIDS — z=640
        this.map.createPane('smartCarePane');
        this.map.getPane('smartCarePane').style.zIndex = 640;
        this.smartCareRenderer = L.canvas({ pane: 'smartCarePane', tolerance: 5 });



        this.connectionsLayer = L.layerGroup().addTo(this.map); // Layer for lines
        this.customDiscreteColors = {}; // User-overridden colors (ID -> Color)
        this.siteLayers = new Map(); // Store layers by ID: { id, name, sectors, visible, polygonLayer, labelLayer }
        this.siteIndex = null; // Composite index of all VISIBLE layers
        this._undoStack = []; // each entry: [{layerId, idx, lat, lng, azimuth, cellName, cellId, pci, sc, freq}]
        this._redoStack = [];

        // Optim: Only show labels on high zoom with debounce to prevent UI freeze
        let zoomTimeout;
        this.map.on('zoomend', () => {
            clearTimeout(zoomTimeout);
            zoomTimeout = setTimeout(() => {
                this.updateLabelVisibility();
                // Check if we have active layers (siteData is legacy/aggregated, siteLayers is source of truth)
                if (this.siteLayers.size > 0 || (this.siteData && this.siteData.length > 0)) {
                    this.renderSites(false); // Refresh LOD (Dots vs Sectors)
                }
            }, 300); // Wait for zoom to settle
        });

        // Ruler State
        this.rulerActive = false;
        this.rulerPoints = [];
        this.rulerLayer = L.layerGroup().addTo(this.map);
        this.rulerTempLine = null;
        this.rulerTooltip = null;

        this.layerStats = {}; // Stores stats per layer ID { activeMetricIds, activeMetricStats, totalActiveSamples }

        this.initRuler();
    }

    initRuler() {
        this.map.on('click', (e) => {
            if (!this.rulerActive) return;
            this.handleRulerClick(e.latlng);
        });

        this.map.on('mousemove', (e) => {
            if (!this.rulerActive || this.rulerPoints.length === 0) return;
            this.handleRulerMove(e.latlng);
        });

        window.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.rulerActive) {
                this.toggleRulerMode(); // Cancel on Esc
            }
        });
    }

    toggleRulerMode() {
        this.rulerActive = !this.rulerActive;
        const btn = document.getElementById('rulerBtn');

        if (btn) btn.classList.toggle('active', this.rulerActive);

        if (this.rulerActive) {
            this.map.getContainer().style.cursor = 'crosshair';
        } else {
            this.map.getContainer().style.cursor = '';
            this.clearRuler();
        }
    }

    handleRulerClick(latlng) {
        if (this.rulerPoints.length >= 2) {
            this.clearRuler();
        }

        this.rulerPoints.push(latlng);

        // Add start/end marker
        L.circleMarker(latlng, {
            radius: 5,
            color: '#ef4444',
            fillColor: '#fff',
            fillOpacity: 1,
            weight: 2,
            pane: 'markerPane'
        }).addTo(this.rulerLayer);

        if (this.rulerPoints.length === 2) {
            this.finishRuler();
        }
    }

    handleRulerMove(latlng) {
        const start = this.rulerPoints[0];

        // Clear previous temp layers
        if (this.rulerTempLine) this.rulerLayer.removeLayer(this.rulerTempLine);
        if (this.rulerHaloLine) this.rulerLayer.removeLayer(this.rulerHaloLine);

        // 1. Halo Line (for visibility)
        this.rulerHaloLine = L.polyline([start, latlng], {
            className: 'ruler-line-halo',
            interactive: false
        }).addTo(this.rulerLayer);

        // 2. Dash Line
        this.rulerTempLine = L.polyline([start, latlng], {
            className: 'ruler-line',
            interactive: false
        }).addTo(this.rulerLayer);

        // 3. Calculation
        const dist = start.distanceTo(latlng);
        const bearing = this.calculateBearing(start.lat, start.lng, latlng.lat, latlng.lng);

        const distStr = dist > 1000 ? (dist / 1000).toFixed(3) + ' km' : dist.toFixed(1) + ' m';
        const dirStr = bearing.toFixed(1) + '°';

        // 4. Update Tooltip (Follow cursor)
        if (!this.rulerTooltip) {
            this.rulerTooltip = L.tooltip({
                permanent: true,
                direction: 'right',
                className: 'ruler-tooltip',
                offset: [15, 0]
            });
        }
        this.rulerTooltip.setLatLng(latlng).setContent(`${distStr} | ${dirStr}`).addTo(this.rulerLayer);
    }

    setSectorHighlight(id, color) {
        this.externalHighlight = { id, color };
        this.renderSites(false); // Re-render to apply
    }

    clearRuler() {
        this.rulerPoints = [];
        this.rulerLayer.clearLayers();
        this.rulerTempLine = null;
        this.rulerHaloLine = null;
        this.rulerTooltip = null;
    }

    calculateBearing(lat1, lon1, lat2, lon2) {
        const rad = Math.PI / 180;
        const φ1 = lat1 * rad;
        const φ2 = lat2 * rad;
        const Δλ = (lon2 - lon1) * rad;

        const y = Math.sin(Δλ) * Math.cos(φ2);
        const x = Math.cos(φ1) * Math.sin(φ2) -
            Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
        let θ = Math.atan2(y, x);
        const brng = (θ * 180 / Math.PI + 360) % 360;
        return brng;
    }

    updateLabelVisibility() {
        const zoom = this.map.getZoom();
        const forced = !!(this.siteSettings && this.siteSettings.forceSiteNames);

        if (forced || zoom >= 14) {
            if (!this.map.hasLayer(this.siteLabelsLayer)) {
                this.siteLabelsLayer.addTo(this.map);
            }
        } else {
            if (this.map.hasLayer(this.siteLabelsLayer)) {
                this.map.removeLayer(this.siteLabelsLayer);
            }
        }
    }

    setView(lat, lng) {
        this.map.setView([lat, lng], 15);
    }

    getColor(val, metric = 'level') {
        if (val === undefined || val === null || val === 'N/A' || val === '') return '#888';

        const rangeKey = (window.getThresholdKey ? window.getThresholdKey(metric) : null);
        const m = String(metric || '').toLowerCase();
        if (rangeKey === 'discrete' || m.includes('band') || m.includes('freq') || m.includes('pci') || m.includes('cid')) {
            return this.getDiscreteColor(val, metric);
        }

        // 2. Thematic Thresholds
        if (window.getThresholdKey && window.themeConfig) {
            if (rangeKey) {
                const thresholds = window.themeConfig.thresholds[rangeKey];
                if (thresholds) {
                    const numVal = Number(val);
                    if (!Number.isFinite(numVal)) return '#888';
                    for (const t of thresholds) {
                        const lo = (t.min !== undefined && t.min !== null) ? Number(t.min) : -Infinity;
                        const hi = (t.max !== undefined && t.max !== null) ? Number(t.max) : Infinity;
                        if (numVal >= lo && numVal < hi) return t.color;
                    }
                    // Fallback: check if value matches the last band's upper bound (inclusive)
                    if (thresholds.length) {
                        const last = thresholds[thresholds.length - 1];
                        const lastHi = (last.max !== undefined && last.max !== null) ? Number(last.max) : Infinity;
                        if (numVal >= lastHi) return last.color;
                    }
                    return '#888';
                }
            }
        }

        return '#3b82f6';
    }

    getMetricValue(p, metric) {
        if (!p) return undefined;
        let val = p[metric];
        const metricStr = String(metric || '');
        const metricLower = metricStr.toLowerCase();
        const metricNorm = metricLower.replace(/[^a-z0-9]/g, '');
        const normalizeIntegerLabel = (raw) => {
            if (raw === undefined || raw === null) return raw;
            const txt = String(raw).trim();
            if (!txt || txt.toUpperCase() === 'N/A') return raw;
            const num = Number(txt.replace(/[^0-9.+-]/g, ''));
            if (Number.isFinite(num)) {
                if (Math.abs(num - Math.round(num)) < 1e-6) return String(Math.round(num));
                return String(Number(num.toFixed(3)));
            }
            return txt;
        };
        const normalizeCellIdLabel = (raw, context = {}) => {
            if (raw === undefined || raw === null) return raw;
            const txt = String(raw).trim();
            if (!txt || txt.toUpperCase() === 'N/A') return raw;

            const techText = String(
                context.tech ??
                context.Tech ??
                context.propertiesTech ??
                context.rat ??
                ''
            ).trim().toUpperCase();
            const contextRnc = Number(context.rnc ?? context.RNC ?? context.propertiesRnc);
            const contextCid = Number(context.cid ?? context.CID ?? context.cellId ?? context.propertiesCid);

            const normalizePart = (part) => {
                const cleaned = String(part || '').trim();
                const num = Number(cleaned);
                if (Number.isFinite(num)) {
                    if (Math.abs(num - Math.round(num)) < 1e-6) return String(Math.round(num));
                    return String(num);
                }
                return cleaned;
            };

            const split = txt
                .replace(/\s*-\s*/g, '/')
                .replace(/\s*\\\s*/g, '/')
                .replace(/\s+/g, '')
                .split('/')
                .filter(Boolean);

            if (split.length >= 2) {
                return `${normalizePart(split[0])}/${normalizePart(split[1])}`;
            }

            const wholeNum = Number(txt);
            const looksUmts = techText === 'UMTS' || techText === '3G';
            if (Number.isFinite(wholeNum) && wholeNum > 65535 && looksUmts) {
                const decodedRnc = Math.floor(wholeNum / 65536);
                const decodedCid = wholeNum % 65536;
                if (Number.isFinite(contextRnc) && Number.isFinite(contextCid)) {
                    return `${normalizePart(contextRnc)}/${normalizePart(contextCid)}`;
                }
                if (Number.isFinite(contextRnc) && decodedRnc === contextRnc) {
                    return `${normalizePart(contextRnc)}/${normalizePart(decodedCid)}`;
                }
                return `${normalizePart(decodedRnc)}/${normalizePart(decodedCid)}`;
            }

            return normalizePart(txt);
        };
        const normalizeFreqLabel = (raw) => {
            if (raw === undefined || raw === null) return raw;
            const txt = String(raw).trim();
            if (!txt || txt.toUpperCase() === 'N/A') return raw;

            const num = Number(txt.replace(/[^0-9.+-]/g, ''));
            if (Number.isFinite(num)) {
                if (Math.abs(num - Math.round(num)) < 1e-6) return String(Math.round(num));
                return String(Number(num.toFixed(3)));
            }
            return txt;
        };
        const normalizeBandLabel = (raw) => {
            if (raw === undefined || raw === null) return raw;
            const txt = String(raw).trim();
            if (!txt || txt.toUpperCase() === 'N/A') return raw;

            const bandByNumber = {
                1: 'B1 (2100)',
                2: 'B2 (1900)',
                3: 'B3 (1800)',
                7: 'B7 (2600)',
                8: 'B8 (900)',
                20: 'B20 (800)',
                28: 'B28 (700)',
                38: 'B38 (2600 TDD)',
                40: 'B40 (2300)',
                41: 'B41 (2500)'
            };
            const bandByFreq = {
                700: 'B28 (700)',
                800: 'B20 (800)',
                900: 'B8 (900)',
                1800: 'B3 (1800)',
                1900: 'B2 (1900)',
                2100: 'B1 (2100)',
                2300: 'B40 (2300)',
                2500: 'B41 (2500)',
                2600: 'B7 (2600)'
            };

            const upper = txt.toUpperCase();
            const bMatch = upper.match(/^B\s*(\d+)(?:\s*\(([^)]+)\))?$/);
            if (bMatch) {
                const bandNum = Number(bMatch[1]);
                if (bandByNumber[bandNum]) return bandByNumber[bandNum];
                return `B${bandNum}`;
            }
            const bandMatch = upper.match(/^BAND\s*(\d+)$/);
            if (bandMatch) {
                const bandNum = Number(bandMatch[1]);
                if (bandByNumber[bandNum]) return bandByNumber[bandNum];
                return `B${bandNum}`;
            }
            const num = Number(txt.replace(/[^0-9.]/g, ''));
            if (Number.isFinite(num) && bandByFreq[num]) return bandByFreq[num];

            return txt;
        };
        const pickFirstDefined = (...vals) => {
            for (let i = 0; i < vals.length; i++) {
                const v = vals[i];
                if (v !== undefined && v !== null && v !== '') return v;
            }
            return undefined;
        };
        const getObjectValueFlexible = (obj) => {
            if (!obj || typeof obj !== 'object') return undefined;
            if (obj[metricStr] !== undefined) return obj[metricStr];
            if (metricLower && obj[metricLower] !== undefined) return obj[metricLower];
            const keyExactCi = Object.keys(obj).find((k) => String(k || '').toLowerCase() === metricLower);
            if (keyExactCi && obj[keyExactCi] !== undefined) return obj[keyExactCi];
            const keyNorm = Object.keys(obj).find((k) => String(k || '').toLowerCase().replace(/[^a-z0-9]/g, '') === metricNorm);
            if (keyNorm && obj[keyNorm] !== undefined) return obj[keyNorm];
            return undefined;
        };

        // 1. Serving Cell Name Resolution
        if (metric === 'serving_cell_name') {
            return this.resolveServingName(p) || 'Unknown';
        }

        // 2. Identity Resolution (Smart ID)
        if (metric === 'cellId' || metric === 'cid' || metric === 'Cell ID') {
            if (window.resolveSmartSite) {
                const resolved = window.resolveSmartSite(p);
                if (resolved && resolved.id) return normalizeCellIdLabel(resolved.id, {
                    tech: p?.Tech ?? p?.properties?.Tech,
                    rnc: p?.rnc ?? p?.properties?.RNC,
                    cid: p?.cid ?? p?.properties?.CID ?? p?.cellId ?? p?.properties?.['Cell ID']
                });
            }
            if (p.rnc !== undefined && p.cid !== undefined) {
                return normalizeCellIdLabel(`${p.rnc}/${p.cid}`, {
                    tech: p?.Tech ?? p?.properties?.Tech,
                    rnc: p?.rnc,
                    cid: p?.cid
                });
            }
            return normalizeCellIdLabel(p.cellId || p.cid, {
                tech: p?.Tech ?? p?.properties?.Tech,
                rnc: p?.rnc ?? p?.properties?.RNC,
                cid: p?.cid ?? p?.properties?.CID ?? p?.cellId ?? p?.properties?.['Cell ID']
            });
        }
        if (metric === 'Serving PCI') {
            val = pickFirstDefined(
                val,
                p.pci,
                p.sc,
                p.parsed && p.parsed.serving_lte ? p.parsed.serving_lte.pci : undefined,
                p.properties ? p.properties['Serving PCI'] : undefined
            );
        }
        if (metric === 'Serving EARFCN') {
            val = pickFirstDefined(
                val,
                p.earfcn,
                p.freq,
                p.parsed && p.parsed.serving_lte ? p.parsed.serving_lte.earfcn : undefined,
                p.properties ? p.properties['Serving EARFCN'] : undefined
            );
        }
        if (metric === 'Serving SINR') {
            val = pickFirstDefined(
                val,
                p.sinr,
                p.parsed && p.parsed.serving_lte ? p.parsed.serving_lte.sinr : undefined,
                p.properties ? p.properties['Serving SINR'] : undefined,
                p.properties ? p.properties['SINR'] : undefined
            );
        }
        if (metric === 'Serving RSRP') {
            val = pickFirstDefined(
                val,
                p['LTE Serving RSRP'],
                p.rsrp,
                p.parsed && p.parsed.serving_lte ? p.parsed.serving_lte.rsrp : undefined,
                p.properties ? p.properties['LTE Serving RSRP'] : undefined,
                p.properties ? p.properties['Serving RSRP'] : undefined,
                p.level
            );
        }
        if (metric === 'Serving RSRQ') {
            val = pickFirstDefined(
                val,
                p['LTE Serving RSRQ'],
                p.rsrq,
                p.parsed && p.parsed.serving_lte ? p.parsed.serving_lte.rsrq : undefined,
                p.properties ? p.properties['LTE Serving RSRQ'] : undefined,
                p.properties ? p.properties['Serving RSRQ'] : undefined,
                p.ecno
            );
        }
        if (metric === 'Serving RSCP') {
            val = pickFirstDefined(
                val,
                p['3G Serving RSCP'],
                p.parsed && p.parsed.serving_3g ? p.parsed.serving_3g.rscp : undefined,
                p.properties ? p.properties['3G Serving RSCP'] : undefined,
                p.properties ? p.properties['Serving RSCP'] : undefined,
                p.rscp,
                p.level
            );
        }
        if (metric === 'Serving EcNo') {
            val = pickFirstDefined(
                val,
                p['3G Serving EcNo'],
                p.parsed && p.parsed.serving_3g ? p.parsed.serving_3g.ecno : undefined,
                p.properties ? p.properties['3G Serving EcNo'] : undefined,
                p.properties ? p.properties['Serving EcNo'] : undefined,
                p.ecno
            );
        }
        if (metric === 'Serving Freq') {
            val = pickFirstDefined(
                val,
                p['3G Serving Freq'],
                p['LTE Serving EARFCN'],
                p.parsed && p.parsed.serving_3g ? p.parsed.serving_3g.freq : undefined,
                p.parsed && p.parsed.serving_lte ? p.parsed.serving_lte.earfcn : undefined,
                p.properties ? p.properties['3G Serving Freq'] : undefined,
                p.properties ? p.properties['LTE Serving EARFCN'] : undefined,
                p.properties ? p.properties['Serving Freq'] : undefined,
                p.freq
            );
        }

        // 3. Radio Metrics Fallbacks
        if (metric === 'rscp_not_combined' || metric === 'rscp') {
            if (val === undefined) val = p.level || p.rscp;
            if (val === undefined && p.parsed && p.parsed.serving) val = p.parsed.serving.level || p.parsed.serving.rscp;
        }
        if (metricLower.includes('rscp') || metricLower.includes('rsrp') || metricLower.includes('signallevel')) {
            val = pickFirstDefined(
                val,
                p.level,
                p.rscp,
                p.rsrp,
                p.parsed && p.parsed.serving ? p.parsed.serving.level : undefined,
                p.parsed && p.parsed.serving ? p.parsed.serving.rscp : undefined,
                p.parsed && p.parsed.serving ? p.parsed.serving.rsrp : undefined,
                p.properties ? p.properties['Serving RSCP'] : undefined,
                p.properties ? p.properties['Serving RSRP'] : undefined
            );
        }
        if (metricLower.includes('ecno') || metricLower.includes('quality') || metricLower === 'qual' || metricLower.includes('rsrq')) {
            val = pickFirstDefined(
                val,
                p.ecno,
                p.qual,
                p.rsrq,
                p.parsed && p.parsed.serving ? p.parsed.serving.ecno : undefined,
                p.parsed && p.parsed.serving ? p.parsed.serving.qual : undefined,
                p.parsed && p.parsed.serving ? p.parsed.serving.rsrq : undefined,
                p.properties ? p.properties['EcNo'] : undefined,
                p.properties ? p.properties['Serving EcNo'] : undefined,
                p.properties ? p.properties['RSRQ'] : undefined
            );
        }
        if (metric.startsWith('active_set_')) {
            const sub = metric.replace('active_set_', '').toLowerCase();
            val = p[sub];
        }

        // 3b. Case/shape-insensitive fallback on point object
        if (val === undefined) {
            val = getObjectValueFlexible(p);
        }

        // 4. Serving Struct Fallback
        if (val === undefined && p.parsed && p.parsed.serving) {
            val = p.parsed.serving[metric];
        }
        if (val === undefined && p.parsed && p.parsed.serving) {
            val = getObjectValueFlexible(p.parsed.serving);
        }
        if (val === undefined && p.parsed) {
            val = getObjectValueFlexible(p.parsed);
        }

        // 5. Raw Properties Fallback (SHP etc.)
        if (val === undefined && p.properties) {
            val = p.properties[metric];
        }
        if (val === undefined && p.properties) {
            val = getObjectValueFlexible(p.properties);
        }

        if (
            metricNorm === 'cellid' ||
            metricNorm === 'cid' ||
            metricNorm === 'servingcellid'
        ) {
            val = normalizeCellIdLabel(val, {
                tech: p?.Tech ?? p?.properties?.Tech,
                rnc: p?.rnc ?? p?.properties?.RNC,
                cid: p?.cid ?? p?.properties?.CID ?? p?.cellId ?? p?.properties?.['Cell ID']
            });
        }
        if (
            metricNorm === 'freq' ||
            metricNorm === 'servingfreq' ||
            metricNorm === 'earfcn' ||
            metricNorm === 'servingearfcn' ||
            metricNorm === 'uarfcn' ||
            metricNorm === 'servinguarfcn' ||
            metricNorm === 'arfcn' ||
            metricNorm === 'servingarfcn' ||
            metricNorm === 'channel'
        ) {
            val = normalizeFreqLabel(val);
        }
        if (
            metricNorm === 'rnc' ||
            metricNorm === 'servingrnc' ||
            metricNorm === 'lac' ||
            metricNorm === 'servinglac'
        ) {
            val = normalizeIntegerLabel(val);
        }
        if (metricNorm === 'band' || metricNorm === 'servingband') {
            val = normalizeBandLabel(val);
        }

        return val;
    }

    getDiscreteColor(val, metric = '') {
        if (val === undefined || val === null || val === '' || val === 'N/A') return '#ff0000'; // RED for Invalid (Debug)

        // Check for Custom Overrides first
        const sVal = String(val);
        const metricKey = String(metric || '');
        const scopedKey = metricKey ? `${metricKey}::${sVal}` : sVal;
        if (this.customDiscreteColors && this.customDiscreteColors[scopedKey]) {
            return this.customDiscreteColors[scopedKey];
        }
        if (this.customDiscreteColors && this.customDiscreteColors[sVal]) {
            return this.customDiscreteColors[sVal];
        }

        // Normalize: Remove whitespace to match Index keys
        const str = sVal.replace(/\s/g, '');

        // RRC State Fixed Colors
        if (sVal === 'CELL_DCH') return '#00ff00'; // Green
        if (sVal === 'CELL_FACH') return '#ffff00'; // Yellow
        if (sVal === 'IDLE') return '#808080'; // Gray
        if (sVal === 'CELL_PCH' || sVal === 'URA_PCH') return '#ff00ff'; // Magenta

        // HO / AS Events
        if (sVal === 'AS Add') return '#22c55e'; // Green
        if (sVal === 'AS Remove') return '#ef4444'; // Red
        if (sVal === 'HO Command') return '#f97316'; // Orange
        if (sVal === 'HO Completion') return '#0000ff'; // Blue

        // RLF / Sync Events
        if (sVal === 'RLF indication') return '#ff0000'; // Bright Red
        if (sVal === 'UL sync loss (UE can’t reach NodeB)') return '#eab308'; // Yellow/Gold
        if (sVal === 'DL sync loss (Interference / coverage)') return '#f87171'; // Light Red/Coral
        if (sVal.startsWith('T310') || sVal.startsWith('T312')) return '#a855f7'; // Purple

        // Custom 12-color palette from user image
        // Expanded 20-color palette for better unique value representation
        const palette = [
            '#FF0000', // red
            '#0000FF', // blue
            '#00A300', // green
            '#FFFF00', // yellow
            '#FF8C00', // orange
            '#FF1493', // pink
            '#FFFFFF', // white
            '#808080', // gray
            '#FF00FF', // magenta
            '#6A0DAD', // purple
            '#00CED1', // dark cyan
            '#8B4513', // brown
            '#1E90FF', // dodger blue
            '#FFD700', // gold
            '#7FFF00', // chartreuse
            '#FF6347', // tomato
            '#98FB98', // pale green
            '#DDA0DD', // plum
            '#F0E68C', // khaki
            '#000000'  // black
        ];

        // Robust 53-bit hash for better dispersion of similar strings (like RNC/CID)
        const cyrb53 = (str, seed = 0) => {
            let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
            for (let i = 0, ch; i < str.length; i++) {
                ch = str.charCodeAt(i);
                h1 = Math.imul(h1 ^ ch, 2654435761);
                h2 = Math.imul(h2 ^ ch, 1597334677);
            }
            h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
            h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
            h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
            h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
            return 4294967296 * (2097151 & h2) + (h1 >>> 0);
        };

        const hash = cyrb53(metricKey ? `${metricKey}:${str}` : str);
        const index = hash % palette.length;
        return palette[index];
    }

    rebuildSiteIndex() {
        // Aggregates all visible sectors for fast lookup
        const allVisibleSectors = [];
        this.siteLayers.forEach(layer => {
            if (layer.visible && layer.sectors) {
                // Avoid spread operator for large arrays to prevent stack overflow
                for (let i = 0; i < layer.sectors.length; i++) {
                    allVisibleSectors.push(layer.sectors[i]);
                }
            }
        });

        console.log(`[MapRenderer] Rebuilding Index. Total Visible Sectors: ${allVisibleSectors.length}`);

        this.siteIndex = {
            byId: new Map(),
            bySc: new Map(),
            all: allVisibleSectors
        };

        const normalizeId = (v) => String(v == null ? '' : v).replace(/\s/g, '');
        const toEnbCidCanonical = (v) => {
            if (v === undefined || v === null) return null;
            const s = String(v).trim();
            if (!s) return null;
            const m = s.match(/(\d+)\D+(\d+)/);
            if (!m) return null;
            return `${Number(m[1])}-${Number(m[2])}`;
        };
        allVisibleSectors.forEach(s => {
            if (s.cellId) {
                const normId = normalizeId(s.cellId);
                this.siteIndex.byId.set(normId, s);
                if (s.rnc && s.cid) {
                    const rncCid = normalizeId(`${s.rnc}/${s.cid}`);
                    this.siteIndex.byId.set(rncCid, s);
                    this.siteIndex.byId.set(normalizeId(`${s.rnc}-${s.cid}`), s);
                }
            }
            if (s.rawEnodebCellId) {
                const raw = normalizeId(s.rawEnodebCellId);
                if (raw) {
                    this.siteIndex.byId.set(raw, s);
                    this.siteIndex.byId.set(raw.replace(/\//g, '-'), s);
                    this.siteIndex.byId.set(raw.replace(/-/g, '/'), s);
                }
                const canonical = toEnbCidCanonical(s.rawEnodebCellId);
                if (canonical) {
                    this.siteIndex.byId.set(normalizeId(canonical), s);
                    this.siteIndex.byId.set(normalizeId(canonical.replace(/-/g, '/')), s);
                }
            }
            if (s.calculatedEci !== undefined && s.calculatedEci !== null) {
                this.siteIndex.byId.set(normalizeId(String(s.calculatedEci)), s);
            }
            const sc = s.sc || s.pci;
            if (sc !== undefined) {
                const key = String(sc);
                if (!this.siteIndex.bySc.has(key)) {
                    this.siteIndex.bySc.set(key, []);
                }
                this.siteIndex.bySc.get(key).push(s);
            }
        });
        console.log(`[MapRenderer] Index Rebuilt. byId: ${this.siteIndex.byId.size}, bySc: ${this.siteIndex.bySc.size}`);
    }

    getServingCell(p) {
        // PERFORMANCE: Check Cache
        if (p && p._cachedServing) return p._cachedServing;

        if (!this.siteIndex) {
            console.warn('[MapRenderer] getServingCell: Site Index missing, attempting to rebuild...');
            this.rebuildSiteIndex();
        }

        if (!this.siteIndex) return null;
        // Uses this.siteIndex.all instead of this.siteData
        const siteData = this.siteIndex.all;
        if (!siteData || siteData.length === 0) {
            // console.warn('[MapRenderer] getServingCell: No site data in index.'); // Too verbose
            return null;
        }

        // ... logic continues ...
        const normalizeId = (v) => String(v == null ? '' : v).replace(/\s/g, '');
        const normalizeName = (v) => String(v == null ? '' : v).trim().toLowerCase().replace(/[\s_-]+/g, '');
        const findByKeyPattern = (obj, predicate) => {
            if (!obj || typeof obj !== 'object') return undefined;
            const keys = Object.keys(obj);
            for (const k of keys) {
                if (predicate(String(k || '').toLowerCase())) return obj[k];
            }
            return undefined;
        };
        const toEnbCidCanonical = (v) => {
            if (v === undefined || v === null) return null;
            const s = String(v).trim();
            if (!s) return null;
            const m = s.match(/(\d+)\D+(\d+)/);
            if (!m) return null;
            return `${Number(m[1])}-${Number(m[2])}`;
        };
        const getValCI = (obj, name) => {
            if (!obj || typeof obj !== 'object') return undefined;
            const wanted = String(name || '').toLowerCase();
            const key = Object.keys(obj).find(k => String(k || '').toLowerCase() === wanted);
            return key ? obj[key] : undefined;
        };
        const parseFiniteInt = (v) => {
            const n = Number(v);
            if (!Number.isFinite(n)) return null;
            return Math.round(n);
        };
        const parseFiniteNumber = (v) => {
            const n = Number(v);
            return Number.isFinite(n) ? n : null;
        };
        const pickPlausibleServingCandidate = (arr) => {
            if (!Array.isArray(arr) || !arr.length) return null;
            const plat = parseFiniteNumber(p && p.lat);
            const plng = parseFiniteNumber(p && p.lng);
            if (plat === null || plng === null) return arr[0];
            const helper = window.siteMatchUtils;
            if (helper && typeof helper.pickPlausibleSiteCandidate === 'function') {
                return helper.pickPlausibleSiteCandidate(arr, {
                    lat: plat,
                    lng: plng,
                    earfcn: measuredFreq,
                    tech: p && (p.Tech || p.tech)
                });
            }
            return arr.slice().sort((a, b) => {
                const distA = Math.pow(Number(a.lat || 0) - plat, 2) + Math.pow(Number(a.lng || 0) - plng, 2);
                const distB = Math.pow(Number(b.lat || 0) - plat, 2) + Math.pow(Number(b.lng || 0) - plng, 2);
                return distA - distB;
            })[0];
        };
        const props = p.properties && typeof p.properties === 'object' ? p.properties : null;
        const servingCellName = (() => {
            const direct = [
                p.serving_cell_name,
                p.servingCellName,
                p.parsed && p.parsed.serving ? p.parsed.serving.cellName : null,
                p['Serving Cell Name'],
                p['Serving Cell']
            ];
            for (const candidate of direct) {
                if (candidate === undefined || candidate === null) continue;
                const txt = String(candidate).trim();
                if (txt && txt.toUpperCase() !== 'N/A' && txt.toUpperCase() !== 'UNKNOWN') return txt;
            }
            if (props) {
                const fromProps = getValCI(props, 'Serving Cell Name')
                    || getValCI(props, 'serving_cell_name')
                    || getValCI(props, 'Serving Cell');
                if (fromProps !== undefined && fromProps !== null) {
                    const txt = String(fromProps).trim();
                    if (txt && txt.toUpperCase() !== 'N/A' && txt.toUpperCase() !== 'UNKNOWN') return txt;
                }
            }
            return null;
        })();
        const measuredPci = (() => {
            const direct = [
                p.sc,
                p.pci,
                p['Radio.Lte.ServingCell[8].Pci'],
                p['radio.lte.servingcell[8].pci'],
                p.parsed && p.parsed.serving ? p.parsed.serving.sc : null,
                p.parsed && p.parsed.serving ? p.parsed.serving.pci : null
            ];
            for (const c of direct) {
                const v = parseFiniteInt(c);
                if (v !== null) return v;
            }
            if (props) {
                const fromProps = getValCI(props, 'Radio.Lte.ServingCell[8].Pci')
                    || getValCI(props, 'radio.lte.servingcell[8].pci')
                    || getValCI(props, 'serving pci')
                    || findByKeyPattern(props, (k) => k.includes('servingcell') && k.endsWith('.pci'));
                const v = parseFiniteInt(fromProps);
                if (v !== null) return v;
            }
            return null;
        })();
        const measuredFreq = (() => {
            const direct = [
                p.freq,
                p.earfcn,
                p['Radio.Lte.ServingCell[8].Downlink.Earfcn'],
                p['radio.lte.servingcell[8].downlink.earfcn'],
                p.parsed && p.parsed.serving ? p.parsed.serving.freq : null
            ];
            for (const c of direct) {
                const v = parseFiniteInt(c);
                if (v !== null) return v;
            }
            if (props) {
                const fromProps = getValCI(props, 'Radio.Lte.ServingCell[8].Downlink.Earfcn')
                    || getValCI(props, 'radio.lte.servingcell[8].downlink.earfcn')
                    || getValCI(props, 'downlink earfcn')
                    || getValCI(props, 'earfcn')
                    || findByKeyPattern(props, (k) => k.includes('servingcell') && k.includes('earfcn'));
                const v = parseFiniteInt(fromProps);
                if (v !== null) return v;
            }
            return null;
        })();
        const measuredLac = (() => {
            const direct = [
                p.lac,
                p.parsed && p.parsed.serving ? p.parsed.serving.lac : null
            ];
            for (const c of direct) {
                const v = parseFiniteInt(c);
                if (v !== null) return v;
            }
            if (props) {
                const fromProps = getValCI(props, 'lac') || getValCI(props, 'location area code');
                const v = parseFiniteInt(fromProps);
                if (v !== null) return v;
            }
            return null;
        })();
        const measuredBsic = (() => {
            const direct = [
                p.bsic,
                p.parsed && p.parsed.serving ? p.parsed.serving.bsic : null
            ];
            for (const c of direct) {
                const v = parseFiniteInt(c);
                if (v !== null) return v;
            }
            if (props) {
                const fromProps = getValCI(props, 'bsic') || getValCI(props, 'base station identity code');
                const v = parseFiniteInt(fromProps);
                if (v !== null) return v;
            }
            return null;
        })();
        const hasMeasuredRf = measuredPci !== null || measuredFreq !== null || measuredLac !== null || measuredBsic !== null;
        const isRfCompatible = (site) => {
            if (!site || typeof site !== 'object') return false;
            const sitePci = parseFiniteInt(site.pci !== undefined ? site.pci : site.sc);
            const siteFreq = parseFiniteNumber(site.currentFreq !== undefined ? site.currentFreq : site.freq);
            const siteLac = parseFiniteInt(site.lac);
            const siteBsic = parseFiniteInt(site.bsic);

            if (measuredPci !== null && sitePci !== null && sitePci !== measuredPci) return false;
            if (measuredFreq !== null && siteFreq !== null && Math.abs(siteFreq - measuredFreq) >= 1) return false;
            if (measuredLac !== null && siteLac !== null && siteLac !== measuredLac) return false;
            if (measuredBsic !== null && siteBsic !== null && siteBsic !== measuredBsic) return false;
            return true;
        };
        const pointLteEci = (() => {
            const direct = [
                p.lteEci,
                p.eci,
                p['Radio.Lte.ServingCell[8].CellIdentity.Complete'],
                p['radio.lte.servingcell[8].cellidentity.complete'],
                p.cellIdentityComplete
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
            if (props) {
                const fromProps = getValCI(props, 'Radio.Lte.ServingCell[8].CellIdentity.Complete')
                    || getValCI(props, 'radio.lte.servingcell[8].cellidentity.complete')
                    || getValCI(props, 'cellidentity.complete');
                const v = parseFiniteInt(fromProps);
                if (v !== null && v > 255) return v;
                const fuzzyProps = findByKeyPattern(props, (k) =>
                    (k.includes('servingcell') && k.includes('cellidentity') && k.includes('complete')) || k.includes('cellidentitycomplete') || k === 'eci'
                );
                const v2 = parseFiniteInt(fuzzyProps);
                if (v2 !== null && v2 > 255) return v2;
            }
            const fromCellId = parseFiniteInt(p.cellId);
            if (fromCellId !== null && fromCellId > 65535) return fromCellId;
            return null;
        })();

        if (pointLteEci !== null) {
            const eciKey = normalizeId(String(pointLteEci));
            if (this.siteIndex.byId.has(eciKey)) {
                const hit = this.siteIndex.byId.get(eciKey);
                if (!hasMeasuredRf || isRfCompatible(hit)) {
                    p._cachedServing = hit;
                    return hit;
                }
            }
            const eciHit = siteData.find(x => Number(x.calculatedEci) === pointLteEci);
            if (eciHit) {
                if (!hasMeasuredRf || isRfCompatible(eciHit)) {
                    p._cachedServing = eciHit;
                    return eciHit;
                }
            }
        }

        const pointEnodebCellId = (() => {
            const directCandidates = [
                p.enodebCellId,
                p.enodebCellIdKey,
                p.rawEnodebCellId,
                p.enodeb_id_cell_id,
                p.enodebid_cellid,
                p['eNodeB ID-Cell ID'],
                p['eNodeB ID - Cell ID']
            ];
            for (const c of directCandidates) {
                if (c !== undefined && c !== null && String(c).trim()) return String(c).trim();
            }
            if (props) {
                const fromProps = getValCI(props, 'eNodeB ID-Cell ID')
                    || getValCI(props, 'eNodeB ID - Cell ID')
                    || getValCI(props, 'enodebid-cellid')
                    || getValCI(props, 'enodebidcellid')
                    || getValCI(props, 'enodeb id-cell id');
                if (fromProps !== undefined && fromProps !== null && String(fromProps).trim()) {
                    return String(fromProps).trim();
                }
                const fuzzyProps = findByKeyPattern(props, (k) => (k.includes('enodeb') || k.includes('nodeb')) && k.includes('cell') && k.includes('id'));
                if (fuzzyProps !== undefined && fuzzyProps !== null && String(fuzzyProps).trim()) {
                    return String(fuzzyProps).trim();
                }
            }
            const cellText = p.cellId !== undefined && p.cellId !== null ? String(p.cellId).trim() : '';
            if (/^\d+\s*[-/]\s*\d+$/.test(cellText)) return cellText;
            if (p.rnc != null && p.cid != null && Number.isFinite(Number(p.rnc)) && Number.isFinite(Number(p.cid))) {
                return `${Number(p.rnc)}-${Number(p.cid)}`;
            }
            if (pointLteEci !== null) {
                const enb = Math.floor(pointLteEci / 256);
                const cid = pointLteEci % 256;
                return `${enb}-${cid}`;
            }
            return null;
        })();

        const pci = measuredPci;
        const lac = measuredLac;
        const freq = measuredFreq;
        const cellId = p.cellId;

        // 0. PRIORITY: Strict eNodeB ID-Cell ID Matching for LTE
        if (pointEnodebCellId) {
            const raw = normalizeId(pointEnodebCellId);
            const variants = [raw, raw.replace(/\//g, '-'), raw.replace(/-/g, '/')];
            const canonical = toEnbCidCanonical(pointEnodebCellId);
            if (canonical) {
                variants.push(normalizeId(canonical), normalizeId(canonical.replace(/-/g, '/')));
            }
            for (const key of variants) {
                if (this.siteIndex.byId.has(key)) {
                    const hit = this.siteIndex.byId.get(key);
                    if (!hasMeasuredRf || isRfCompatible(hit)) {
                        p._cachedServing = hit;
                        return hit;
                    }
                }
            }
            const fallback = siteData.find(x => {
                const siteRaw = normalizeId(x.rawEnodebCellId || '');
                if (siteRaw === raw) return true;
                const siteCanonical = toEnbCidCanonical(x.rawEnodebCellId || x.cellId || x.calculatedEci);
                return canonical && siteCanonical === canonical;
            });
            if (fallback) {
                if (!hasMeasuredRf || isRfCompatible(fallback)) {
                    p._cachedServing = fallback;
                    return fallback;
                }
            }
        }

        // NEW: Priority RNC/CID Lookup (3G)
        if (p.rnc != null && p.cid != null) {
            const key = `${p.rnc}/${p.cid}`.replace(/\s/g, '');
            if (this.siteIndex.byId.has(key)) {
                const hit = this.siteIndex.byId.get(key);
                if (!hasMeasuredRf || isRfCompatible(hit)) return hit;
            }

            // Fallback: Try matching as Long Cell ID
            const longId = (Number(p.rnc) << 16) + Number(p.cid);
            let s = siteData.find(x => x.cellId == longId || x.calculatedEci == longId || x.rawEnodebCellId == longId);
            if (s && (!hasMeasuredRf || isRfCompatible(s))) return s;

            // Fallback 2: CID Bitmask Discrepancy (Some logs set bit 12, value 4096, which site data ignores)
            const maskedCid = p.cid & 0xEFFF;
            const maskedLongId = (Number(p.rnc) << 16) + maskedCid;
            const maskedKey = `${p.rnc}/${maskedCid}`;

            if (this.siteIndex.byId.has(maskedKey)) {
                const hit = this.siteIndex.byId.get(maskedKey);
                if (!hasMeasuredRf || isRfCompatible(hit)) return hit;
            }
            s = siteData.find(x => x.cellId == maskedLongId || x.cellId == maskedCid || x.rawEnodebCellId == maskedLongId);
            if (s && (!hasMeasuredRf || isRfCompatible(s))) return s;

            // Fallback 3: Short ID Match (RNC + High 12 bits of CID) - Very common in 3G
            const shortId = p.cid >> 4;
            const shortKeyMatch = siteData.find(x => x.rnc == p.rnc && (x.cid >> 4) == shortId);
            if (shortKeyMatch && (!hasMeasuredRf || isRfCompatible(shortKeyMatch))) return shortKeyMatch;
        }

        // 1. PRIORITY: Strict eNodeB ID-Cell ID / CellID Matching
        if (cellId) {
            if (typeof cellId === 'number' && cellId > 65535) {
                const s = siteData.find(x => x.calculatedEci === cellId);
                if (s && (!hasMeasuredRf || isRfCompatible(s))) return s;
            }
            const s = siteData.find(x => x.rawEnodebCellId == cellId);
            if (s && (!hasMeasuredRf || isRfCompatible(s))) return s;
        }

        // 1b. Direct name matching from imported Serving Cell Name
        if (servingCellName) {
            const wanted = normalizeName(servingCellName);
            const byName = siteData.filter((x) => {
                const siteNames = [
                    x.cellName,
                    x.name,
                    x.siteName,
                    x.id,
                    x.rawEnodebCellId
                ].filter(Boolean).map(normalizeName).filter(Boolean);
                return siteNames.includes(wanted);
            });
            if (byName.length) {
                const compatible = byName.filter((x) => !hasMeasuredRf || isRfCompatible(x));
                const pool = compatible.length ? compatible : byName;
                const winner = pickPlausibleServingCandidate(pool);
                if (winner) {
                    p._cachedServing = winner;
                    return winner;
                }
            }
        }

        // 1. GSM Matching: BSIC + ARFCN (Freq) + LAC + PROXIMITY
        if (measuredBsic !== null && measuredFreq !== null && measuredLac !== null && p.lat && p.lng) {
            const nearbyRadius = 0.02;
            const match = siteData.find(x => {
                const bsicMatch = (x.bsic == measuredBsic);
                const freqMatch = (Math.abs((x.freq || x.currentFreq) - measuredFreq) < 1);
                const lacMatch = (x.lac == measuredLac);
                const distMatch = Math.abs(x.lat - p.lat) < nearbyRadius && Math.abs(x.lng - p.lng) < nearbyRadius;
                return bsicMatch && freqMatch && lacMatch && distMatch;
            });
            if (match) return match;
        }

        // 2. WCDMA/3G Falling: SC + Freq + PROXIMITY (When RNC/CID is missing)
        if (measuredPci !== null && measuredFreq !== null && p.lat && p.lng) {
            const nearbyRadius = 0.02; // Roughly 2km
            const candidates = siteData.filter(x => {
                // Ignore sites that have a tech specified as LTE or GSM if we're looking for 3G (SC matching)
                const tech = String(x.tech || '').toUpperCase();
                if (tech.includes('LTE') || tech.includes('GSM') || tech.includes('2G')) return false;

                const scMatch = (x.sc == measuredPci || x.pci == measuredPci);
                const freqMatch = (Math.abs((x.freq || x.currentFreq) - measuredFreq) < 1);
                const distMatch = Math.abs(x.lat - p.lat) < nearbyRadius && Math.abs(x.lng - p.lng) < nearbyRadius;
                return scMatch && freqMatch && distMatch;
            });

            if (candidates.length > 0) {
                const winner = candidates.length === 1 ? candidates[0] : candidates.sort((a, b) => {
                    const distA = Math.pow(a.lat - p.lat, 2) + Math.pow(a.lng - p.lng, 2);
                    const distB = Math.pow(b.lat - p.lat, 2) + Math.pow(b.lng - p.lng, 2);
                    return distA - distB;
                })[0];
                return winner;
            }
        }

        // 3. Last Resort: CellID Only (Strict for LTE, Legacy for others)
        if (cellId) {
            const norm = String(cellId).replace(/\s/g, '');
            if (this.siteIndex.byId.has(norm)) {
                const s = this.siteIndex.byId.get(norm);
                if (!hasMeasuredRf || isRfCompatible(s)) {
                    p._cachedServing = s; // Cache
                    return s;
                }
            }

            // Fix: Check for Long ID decomposition (RNC/CID)
            const val = Number(cellId);
            if (!isNaN(val) && val > 65535) {
                const rnc = val >> 16;
                const cid = val & 0xFFFF;

                // 1. Exact Match
                let key = `${rnc}/${cid}`;
                if (this.siteIndex.byId.has(key)) {
                    const s = this.siteIndex.byId.get(key);
                    if (!hasMeasuredRf || isRfCompatible(s)) {
                        p._cachedServing = s;
                        return s;
                    }
                }

                // 2. Masked Match (Bit 12 Issue)
                const maskedCid = cid & 0xEFFF;
                const maskedKey = `${rnc}/${maskedCid}`;
                if (this.siteIndex.byId.has(maskedKey)) {
                    const s = this.siteIndex.byId.get(maskedKey);
                    if (!hasMeasuredRf || isRfCompatible(s)) {
                        p._cachedServing = s;
                        return s;
                    }
                }

                // 3. Short ID Match (Shifted CID) - keys might not be in index, search siteData
                // This matches RNC + (CID >> 4)
                const shortCid = cid >> 4;
                const shortMatch = siteData.find(x => x.rnc == rnc && (x.cid >> 4) == shortCid);
                if (shortMatch && (!hasMeasuredRf || isRfCompatible(shortMatch))) {
                    p._cachedServing = shortMatch;
                    return shortMatch;
                }
            }
            // Loose Match for Names (Case Insensitive + Trim)
            const looseId = String(cellId).trim().toLowerCase();
            const s = siteData.find(x => {
                if (x.cellId == cellId) return true;
                const matchesName = (x.cellName && String(x.cellName).toLowerCase().trim() === looseId) ||
                    (x.name && String(x.name).toLowerCase().trim() === looseId);
                return matchesName;
            });

            if (s && (!hasMeasuredRf || isRfCompatible(s))) {
                p._cachedServing = s; // Cache
                return s;
            }
        }

        delete p._cachedServing; // Do not cache misses; site layers may load/update later.
        return null;
    }

    resolveServingName(p) {
        const s = this.getServingCell(p);
        if (s) return s.cellName || s.name || s.siteName;
        return null;
    }

    addLogLayer(id, points, metric = 'level', preventZoom = false) {
        this.activeLogId = id;
        this.activeMetric = metric;
        const allowZoom = !preventZoom;

        // Store for Heatmap use
        this.currentPoints = points;
        this.currentMetric = metric;

        // Create a new layer group for this log
        const layerGroup = L.layerGroup();

        if (!points || points.length === 0) {
            console.warn("[MapRenderer] addLogLayer: No points to render.");
            return;
        }

        let validCount = 0;
        let naCount = 0;
        let firstValid = null;

        points.forEach((p, idx) => {
            let val = this.getMetricValue(p, metric);
            if (val === undefined || val === null || val === 'N/A' || val === '') {
                naCount++;
            } else {
                validCount++;
                if (!firstValid) firstValid = { idx, val, p };
            }
        });

        if (!firstValid) {
            console.warn("[MapRenderer] NO VALID POINTS FOUND for this metric!");
        }


        // CHUNKED RENDERING: Process points in batches to avoid freezing UI
        const CHUNK_SIZE = 1000;
        const totalPoints = points.length;
        let pIdx = 0;
        const validLocations = [];
        const idsCollection = new Map(); // Accumulate IDs for Legend here
        let totalValidsForMetric = 0;
        const rangeKey = (window.getThresholdKey ? window.getThresholdKey(metric) : null);
        const isIdentityMetric = (rangeKey === 'discrete') || 
                                 (metric.toLowerCase().includes('band') || metric.toLowerCase().includes('freq') || metric.toLowerCase().includes('pci') || metric.toLowerCase().includes('cid'));
        const thresholds = (rangeKey && window.themeConfig && window.themeConfig.thresholds)
            ? window.themeConfig.thresholds[rangeKey]
            : null;

        const processChunk = () => {
            const end = Math.min(pIdx + CHUNK_SIZE, totalPoints);
            for (let i = pIdx; i < end; i++) {
                const p = points[i];
                const val = this.getMetricValue(p, metric);
                const metricNorm = String(metric || '').toLowerCase().replace(/[^a-z0-9]/g, '');
                const isServingRscpMetric = (
                    metricNorm === 'level' ||
                    metricNorm === 'rscp' ||
                    metricNorm === 'rscpnotcombined' ||
                    metricNorm === 'servingrscp'
                );

                // Handle Identity Metrics Collection for Legend
                if (isIdentityMetric) {
                    if (val !== undefined && val !== null) {
                        const sVal = String(val);
                        idsCollection.set(sVal, (idsCollection.get(sVal) || 0) + 1);
                        totalValidsForMetric++;
                    }
                }


                // Collect Stats for Thematic Metrics (RSRP, RSRQ, etc.)
                // If it's not cellId/cid, it might be a thematic metric mapping to level or quality
                if (!isIdentityMetric && thresholds && val !== undefined && val !== null) {
                    // Find matching label — use [min, max) semantics matching getColor
                    const numV = Number(val);
                    let matched = false;
                    if (Number.isFinite(numV)) {
                        for (const t of thresholds) {
                            const lo = (t.min !== undefined && t.min !== null) ? Number(t.min) : -Infinity;
                            const hi = (t.max !== undefined && t.max !== null) ? Number(t.max) : Infinity;
                            if (numV >= lo && numV < hi) {
                                idsCollection.set(t.label, (idsCollection.get(t.label) || 0) + 1);
                                matched = true;
                                break;
                            }
                        }
                        // Fallback: value at or above last band's upper bound
                        if (!matched && thresholds.length) {
                            const last = thresholds[thresholds.length - 1];
                            const lastHi = (last.max !== undefined && last.max !== null) ? Number(last.max) : Infinity;
                            if (numV >= lastHi) {
                                idsCollection.set(last.label, (idsCollection.get(last.label) || 0) + 1);
                                matched = true;
                            }
                        }
                    }
                    if (matched) totalValidsForMetric++;
                }

                // For Serving RSCP, draw only points that carry valid RSCP values (no gray placeholders).
                if (isServingRscpMetric) {
                    const nVal = Number(val);
                    if (!Number.isFinite(nVal)) continue;
                } else if (metric !== 'level' && metric !== 'quality') { 
                    // Skip 'N/A', empty string, null, undefined, and literal NaN values 
                    // so different layers/technologies can overlay cleanly without drawing gray points over each other
                    if (val === undefined || val === null || val === 'N/A' || val === '' || Number.isNaN(val)) continue;
                    
                    // Explicit numerical check for standard metrics: if it's parsed as NaN, skip it.
                    if (typeof val === 'number' && !Number.isFinite(val)) continue;
                }

                const color = this.getColor(val, metric);

                if (p.lat !== undefined && p.lat !== null && p.lng !== undefined && p.lng !== null) {
                    validLocations.push([p.lat, p.lng]);

                    let layer;
                    const isEvent = p.type === 'EVENT';
                    let radius = isEvent ? 7 : 4; // Events are larger


                    const weight = isEvent ? 2 : 1; // Thicker border for events

                    // CHECK FOR POLYGON GEOMETRY (Imported SHP Grid)
                    if (p.geometry && (p.geometry.type === 'Polygon' || p.geometry.type === 'MultiPolygon')) {
                        // Manually create L.polygon to ensure 'renderer' option is passed correctly
                        // L.geoJSON doesn't always propagate the renderer option to generated paths
                        const isMulti = p.geometry.type === 'MultiPolygon';
                        const latlngs = L.GeoJSON.coordsToLatLngs(p.geometry.coordinates, isMulti ? 2 : 1);

                        layer = L.polygon(latlngs, {
                            pane: 'smartCarePane', // Specific Pane (Z 640)
                            renderer: this.smartCareRenderer,
                            fillColor: color,
                            color: "transparent",
                            weight: 0,
                            opacity: 0,
                            fillOpacity: 0.8,
                            interactive: true
                        }).addTo(layerGroup);
                    } else {
                        // Default Point Rendering
                        layer = L.circleMarker([p.lat, p.lng], {
                            radius: radius,
                            fillColor: color,
                            color: isEvent ? "#fff" : "#000",
                            weight: weight,
                            opacity: 1,
                            fillOpacity: isEvent ? 1 : 0.8,
                            pane: 'logPointsPane',
                            renderer: this.logPointsRenderer,
                            interactive: true
                        }).addTo(layerGroup);
                    }

                    const emitPointClick = (detailName, e) => {
                        window.dispatchEvent(new CustomEvent(detailName, {
                            detail: {
                                logId: id,
                                point: p,
                                clientX: e?.originalEvent?.clientX,
                                clientY: e?.originalEvent?.clientY
                            }
                        }));
                    };
                    layer.on('click', (e) => {
                        L.DomEvent.stopPropagation(e);
                        emitPointClick('map-point-clicked', e);
                    });
                    layer.on('contextmenu', (e) => {
                        L.DomEvent.stop(e);
                        emitPointClick('map-point-contextmenu', e);
                    });
                    layer.on('mousedown', (e) => {
                        if ((e?.originalEvent?.button ?? -1) !== 2) return;
                        L.DomEvent.stop(e);
                        emitPointClick('map-point-contextmenu', e);
                    });
                }
            }

            pIdx = end;
            if (pIdx < totalPoints) {
                // Yield to main thread
                setTimeout(processChunk, 0);
            } else {
                // Done
                if (allowZoom && validLocations.length > 0) {
                    this.map.fitBounds(validLocations);
                }

                // Finalize Legend IDs if applicable
                const statsObj = {
                    metric,
                    activeMetricIds: null,
                    activeMetricStats: idsCollection,
                    totalActiveSamples: totalValidsForMetric
                };

                if (isIdentityMetric) {
                    this.activeMetricIds = Array.from(idsCollection.keys()).sort(); // Legacy global array
                    this.activeMetricStats = idsCollection;
                    this.totalActiveSamples = totalValidsForMetric;

                    statsObj.activeMetricIds = this.activeMetricIds;

                    if (metric === 'cellId' || metric === 'cid' || metric === 'Cell ID') {
                        // HIGHLIGHT PASS TRIGGER
                        // Pass the Set of IDs directly for O(1) lookups in renderSites
                        const activeSet = new Set(idsCollection.keys());
                        this.renderSites(false, activeSet);
                    }
                } else {
                    // For thematic metrics (level, quality), we also expose stats
                    this.activeMetricStats = idsCollection;
                    this.totalActiveSamples = totalValidsForMetric;
                    this.activeMetricIds = null;
                }

                // Store stats for this layer
                this.layerStats[id] = statsObj;

                // Signal that rendering and ID collection is complete
                window.dispatchEvent(new CustomEvent('layer-metric-ready', { detail: { metric } }));
                if (typeof window.updateLegend === 'function') window.updateLegend();
                if (typeof window.updateDTLayersSidebar === 'function') window.updateDTLayersSidebar();

                // Ensure sites are still on top and visible
                if (window.refreshSites) window.refreshSites();
            }
        };

        this.logLayers[id] = layerGroup;
        layerGroup.addTo(this.map);

        // Start Processing
        processChunk();

        // Set render order (higher zIndex = on top)
        if (typeof this.layerZ === 'number') {
            layerGroup.eachLayer(l => {
                if (typeof l.setZIndexOffset === 'function') l.setZIndexOffset(this.layerZ);
            });
        }
    }

    highlightMarker(logId, index) {
        const layerGroup = this.logLayers[logId];
        if (!layerGroup) return;

        const layers = layerGroup.getLayers();
        if (layers[index]) {
            const marker = layers[index];
            const latLng = marker.getLatLng();

            // 1. Remove previous highlight
            if (this.currentHighlight) {
                this.map.removeLayer(this.currentHighlight);
            }

            // 2. Create pulsing highlight ring
            this.currentHighlight = L.circleMarker(latLng, {
                radius: 10,
                fill: false,
                color: '#ef4444', // Red Pulse
                weight: 3,
                className: 'pulsing-highlight',
                interactive: false // Don't block clicks
            }).addTo(this.map);

            // 3. Open Popup
            marker.openPopup();

            // 4. Ensure view contains it 
            if (!this.map.getBounds().contains(latLng)) {
                this.map.panTo(latLng);
            }
        }
    }

    clearLayer(id) {
        if (this.logLayers[id]) {
            this.map.removeLayer(this.logLayers[id]);
            delete this.logLayers[id];

            // Clear stats
            if (this.layerStats && this.layerStats[id]) {
                delete this.layerStats[id];
            }

            if (this.activeLogId === id) {
                this.activeLogId = null;
            }
        }
    }

    renderMetricOnMap(selection) {
        const overlayId = '__driver_metric_overlay__';
        this.clearLayer(overlayId);
        const points = (selection && selection.mapPoints) || [];
        if (!points.length) return { ok: false, reason: 'no_points' };

        const vals = points.map(p => Number(p.value)).filter(v => Number.isFinite(v));
        if (!vals.length) return { ok: false, reason: 'no_numeric_values' };
        const min = Math.min(...vals);
        const max = Math.max(...vals);
        const span = Math.max(1e-9, max - min);
        const sorted = vals.slice().sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length * 0.5)];

        const legend = (selection && selection.legend) || null;

        const colorFor = (v) => {
            // If a legend is provided, use bin/categorical mapping
            if (legend && window.trpThroughputUtils && typeof window.trpThroughputUtils.classifyValueToLegend === 'function') {
                const c = window.trpThroughputUtils.classifyValueToLegend(v, legend);
                return c && c.color ? c.color : '#22c55e';
            }
            // Fallback: simple 5-band continuous ramp by min/max
            const t = Math.max(0, Math.min(1, (Number(v) - min) / span));
            if (t < 0.2) return '#1d4ed8';
            if (t < 0.4) return '#0284c7';
            if (t < 0.6) return '#22c55e';
            if (t < 0.8) return '#f59e0b';
            return '#ef4444';
        };

        const layerGroup = L.layerGroup();
        const latlngs = [];
        points.forEach(p => {
            const lat = Number(p.lat);
            const lon = Number(p.lon);
            const val = Number(p.value);
            if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(val)) return;
            latlngs.push([lat, lon]);
            L.circleMarker([lat, lon], {
                radius: 4,
                color: colorFor(val),
                fillColor: colorFor(val),
                fillOpacity: 0.9,
                weight: 1,
                pane: 'sitesPane'
            }).bindTooltip(`${selection.label || 'Metric'}: ${val.toFixed(2)} ${selection.unit || ''}`).addTo(layerGroup);
        });

        if (!latlngs.length) return { ok: false, reason: 'no_geo_match' };
        layerGroup.addTo(this.map);
        this.logLayers[overlayId] = layerGroup;
        try {
            this.map.fitBounds(L.latLngBounds(latlngs), { padding: [20, 20] });
        } catch (_e) {}
        return { ok: true, stats: { min, median, max } };
    }

    renderLog(log, metric = 'level', preventZoom = false) {
        // If it already exists, maybe clear first to ensure fresh render?
        this.clearLayer(log.id);

        if (log.points && log.points.length > 0) {
            // Use existing point rendering logic
            // Note: addLogLayer creates the group and adds it to map
            this.addLogLayer(log.id, log.points, metric, preventZoom);
        }
    }

    updateLayerMetric(id, points, metric) {
        console.log(`[MapRenderer] updateLayerMetric: id=${id}, points=${points ? points.length : 0}, metric=${metric}`);

        // SYNC SITES SETUP
        if (metric === 'cellId' || metric === 'cid' || metric === 'Cell ID') {
            // DEFER ID Collection to addLogLayer (Chunked) to avoid freeze
            // this.activeMetricIds will be updated when rendering finishes.

            // Force Identity Mode
            if (!this.siteSettings) this.siteSettings = {};
            this.siteSettings.colorBy = 'identity';

            // Render Sites with Highlights (Initial pass, update happens after async processing)
            this.renderSites(false);
        } else {
            this.activeMetricIds = null;
        }

        // OVERLAY MODE for RRC/CS
        if (metric === 'rrc_rel_cause' || metric === 'cs_rel_cause' || metric === 'iucs_status') {
            this.addOverlayLayer(id, points, metric);
            return;
        }

        this.removeLogLayer(id);
        this.addLogLayer(id, points, metric, true);
    }

    removeLogLayer(id) {
        if (this.logLayers[id]) {
            this.map.removeLayer(this.logLayers[id]);
            delete this.logLayers[id];
        }
        this.removeEventsLayer(id);
    }

    addEventsLayer(id, points, options = {}) {
        if (!this.eventLayers) this.eventLayers = {};
        if (this.eventLayers[id]) this.map.removeLayer(this.eventLayers[id]);

        const normalizeEventName = (v) => String(v || '').toLowerCase().trim();
        const buildSpecialEventIcon = (eventName) => {
            const e = normalizeEventName(eventName);
            let glyph = null;
            if (e.includes('ul sync loss')) glyph = '↑';
            else if (e.includes('dl sync loss')) glyph = '↓';
            else if (e.includes('rlf indication') || e === 'rlf' || e.includes('radio link failure')) glyph = '!';
            if (!glyph) return null;
            return L.divIcon({
                className: 'event-special-icon',
                html:
                    '<div style="width:24px;height:40px;display:flex;align-items:flex-end;justify-content:center;">' +
                    '<span style="color:#ef4444;font-size:34px;line-height:1;font-weight:900;text-shadow:0 0 2px rgba(0,0,0,0.7),0 0 1px #fff;">' + glyph + '</span>' +
                    '</div>',
                iconSize: [24, 40],
                iconAnchor: [12, 36]
            });
        };

        const layerGroup = L.layerGroup();
        const useIcon = options && options.iconUrl;
        const useFlag = !!(options && options.useFlag);
        const iconObj = useIcon ? L.icon({
            iconUrl: options.iconUrl,
            iconSize: options.iconSize || [32, 32],
            iconAnchor: options.iconAnchor || [16, 16],
            className: options.iconClass || ''
        }) : null;
        const flagColor = (options && options.flagColor) || '#ef4444';
        const isTallFlag = String((options && options.flagStyle) || '').toLowerCase() === 'tall';
        const flagWidth = isTallFlag ? 18 : 14;
        const flagHeight = isTallFlag ? 34 : 18;
        const poleHeight = isTallFlag ? 32 : 16;
        const poleWidth = isTallFlag ? 3 : 2;
        const triangleTop = isTallFlag ? 3 : 2;
        const triangleHalfHeight = isTallFlag ? 7 : 5;
        const triangleWidth = isTallFlag ? 13 : 10;
        const poleLeft = isTallFlag ? 1 : 1;
        const triangleLeft = isTallFlag ? 4 : 3;
        const iconAnchorY = isTallFlag ? 32 : 16;
        const flagIcon = useFlag ? L.divIcon({
            className: 'event-flag-icon',
            html: '<div style="position:relative;width:' + flagWidth + 'px;height:' + flagHeight + 'px;">' +
                '<span style="position:absolute;left:' + poleLeft + 'px;top:1px;width:' + poleWidth + 'px;height:' + poleHeight + 'px;background:#f8fafc;border-radius:1px;opacity:0.95;"></span>' +
                '<span style="position:absolute;left:' + triangleLeft + 'px;top:' + triangleTop + 'px;width:0;height:0;border-top:' + triangleHalfHeight + 'px solid transparent;border-bottom:' + triangleHalfHeight + 'px solid transparent;border-left:' + triangleWidth + 'px solid ' + flagColor + ';filter:drop-shadow(0 0 1px rgba(0,0,0,0.6));"></span>' +
                '</div>',
            iconSize: [flagWidth, flagHeight],
            iconAnchor: [2, iconAnchorY]
        }) : null;

        points.forEach(p => {
            if (!p.event) return;
            // Aggressive Filter for Testing
            const evt = p.event.toLowerCase();
            if (evt.includes('disconnect') || evt.includes('release') || evt.includes('end') || evt.includes('normal')) return;

            // Skip points with invalid valid coordinates to prevent Leaflet crash
            if (p.lat === undefined || p.lat === null || p.lng === undefined || p.lng === null || isNaN(p.lat) || isNaN(p.lng)) return;

            let color = '#000';


            let fillColor = '#fff';
            let radius = 6;
            let label = p.event;

            switch (p.event) {
                case 'HO Fail':
                    color = '#f97316'; // Orange
                    fillColor = '#f97316';
                    radius = 7;
                    break;
                case 'Call Drop':
                    color = '#ef4444'; // Red
                    fillColor = '#ef4444';
                    radius = 8;
                    break;
                case 'Call Fail':
                    color = '#991b1b'; // Dark Red
                    fillColor = '#991b1b';
                    radius = 8;
                    break;
                case 'Call Disconnect':
                    color = '#6b7280'; // Grey
                    fillColor = '#6b7280';
                    radius = 5;
                    break;
            }

            const specialIcon = buildSpecialEventIcon(p.event);
            const marker = specialIcon
                ? L.marker([p.lat, p.lng], { icon: specialIcon, pane: 'eventsPane', interactive: true })
                : useIcon
                    ? L.marker([p.lat, p.lng], { icon: iconObj, pane: 'eventsPane', interactive: true })
                    : useFlag
                        ? L.marker([p.lat, p.lng], { icon: flagIcon, pane: 'eventsPane', interactive: true })
                        : L.circleMarker([p.lat, p.lng], {
                            radius: radius,
                            color: '#fff', // White border for contrast
                            weight: 2,
                            fillColor: fillColor,
                            fillOpacity: 1,
                            pane: 'eventsPane',
                            className: 'event-marker',
                            interactive: true
                        });

            if (typeof this.layerZ === 'number') {
                if (typeof marker.setZIndexOffset === 'function') marker.setZIndexOffset(this.layerZ);
            }

            marker.on('click', (e) => {
                L.DomEvent.stopPropagation(e);
                const forcedMode = String(id || '').includes('__3g_call_failure')
                    ? 'setupFailure'
                    : (String(id || '').includes('__3g_dropcall') ? 'drop' : null);
                const failureEventText = String(
                    p?.event ||
                    p?.message ||
                    p?.type ||
                    p?.properties?.Event ||
                    p?.properties?.['Event Name'] ||
                    p?.properties?.Message ||
                    ''
                ).toLowerCase();
                if (
                    p?.setupFailure === true ||
                    p?.drop === true ||
                    forcedMode === 'setupFailure' ||
                    forcedMode === 'drop' ||
                    failureEventText.includes('drop') ||
                    failureEventText.includes('call fail') ||
                    failureEventText.includes('setup failure') ||
                    failureEventText.includes('caf')
                ) {
                    window.dispatchEvent(new CustomEvent('map-failure-clicked', {
                        detail: { logId: id, point: p, source: 'event_icon', mode: forcedMode }
                    }));
                }
                window.dispatchEvent(new CustomEvent('map-point-clicked', {
                    detail: { logId: id, point: p, source: 'event_icon', mode: forcedMode }
                }));
            });

            layerGroup.addLayer(marker);
        });

        layerGroup.addTo(this.map);
        this.eventLayers[id] = layerGroup;
    }

    removeEventsLayer(id) {
        if (this.eventLayers && this.eventLayers[id]) {
            this.map.removeLayer(this.eventLayers[id]);
            delete this.eventLayers[id];
        }
    }

    // ── Pilot Pollution event circles ─────────────────────────────────────────

    drawPilotPollutionOverlay(layerId, events) {
        if (!this.eventLayers) this.eventLayers = {};
        if (this.eventLayers[layerId]) {
            this.map.removeLayer(this.eventLayers[layerId]);
            delete this.eventLayers[layerId];
        }
        if (!Array.isArray(events) || events.length === 0) return;

        const SEV_COLOR = { High: '#ef4444', Medium: '#f97316', Low: '#facc15' };
        const SEV_BORDER = { High: '#fca5a5', Medium: '#fdba74', Low: '#fde68a' };
        const shortTime = (iso) => iso ? String(iso).replace(/^\d{4}-\d{2}-\d{2}T/, '').replace(/\.\d{3}Z$/, 'Z') : '—';
        const fmtCoord = (v) => v != null ? Number(v).toFixed(5) : '—';

        const group = L.layerGroup();

        events.forEach((ev, idx) => {
            const lat = ev.centerLat;
            const lon = ev.centerLon;
            if (lat == null || lon == null || isNaN(lat) || isNaN(lon)) return;

            const sev = String(ev.severity || 'Low');
            const circleColor = SEV_COLOR[sev] || '#ef4444';
            const borderColor = SEV_BORDER[sev] || '#fca5a5';

            // Radius: half route length, clamped to [80, 400] m
            const radius = Math.max(80, Math.min(400, (ev.routeLengthMeters || 200) / 2));

            // Filled circle
            const circle = L.circle([lat, lon], {
                radius,
                color: borderColor,
                weight: 1.5,
                fillColor: circleColor,
                fillOpacity: 0.15,
                opacity: 0.7,
                pane: 'pilotPollutionPane',
                interactive: true,
            });

            const evNum = idx + 1;
            // Wrap in a transform div so the label floats above the circle center.
            // iconSize:[0,0] + iconAnchor:[0,0] means the anchor point is at the
            // top-left of a zero-size box; the inner div's translate(-50%,-100%)
            // then centres horizontally and places the bottom edge at that point.
            const labelHtml =
                '<div style="' +
                    'transform:translate(-50%,-100%);' +
                    'margin-top:-8px;' +
                    'display:inline-block;' +
                    'background:rgba(10,14,26,0.88);' +
                    'border:1px solid ' + borderColor + ';' +
                    'border-radius:8px;' +
                    'padding:6px 10px;' +
                    'font-family:system-ui,sans-serif;' +
                    'font-size:11px;' +
                    'line-height:1.6;' +
                    'color:#e2e8f0;' +
                    'white-space:nowrap;' +
                    'pointer-events:none;' +
                    'box-shadow:0 3px 10px rgba(0,0,0,0.6);' +
                '">' +
                    '<div style="font-weight:700;color:' + borderColor + ';margin-bottom:1px;">Event ' + evNum + ' · EARFCN ' + (ev.carrier || '—') + '</div>' +
                    '<div style="color:' + circleColor + ';font-weight:600;">' + sev + ' risk</div>' +
                    '<div style="color:#94a3b8;font-size:10.5px;">⏱ ' + shortTime(ev.startTime) + ' → ' + shortTime(ev.endTime) + '</div>' +
                    '<div style="color:#64748b;font-size:10px;">📍 ' + fmtCoord(lat) + ', ' + fmtCoord(lon) + '</div>' +
                '</div>';

            const labelIcon = L.divIcon({
                className: '',
                html: labelHtml,
                iconSize: [0, 0],
                iconAnchor: [0, 0],
            });

            const labelMarker = L.marker([lat, lon], {
                icon: labelIcon,
                interactive: false,
                pane: 'pilotPollutionPane',
                zIndexOffset: 100,
            });

            // Click on circle → re-open the analysis modal for this event
            circle.on('click', (e) => {
                L.DomEvent.stopPropagation(e);
                window.dispatchEvent(new CustomEvent('pp-event-circle-clicked', {
                    detail: { eventIndex: idx, event: ev },
                }));
            });

            group.addLayer(circle);
            group.addLayer(labelMarker);
        });

        group.addTo(this.map);
        this.eventLayers[layerId] = group;
    }

    removePilotPollutionOverlay(layerId) {
        if (this.eventLayers && this.eventLayers[layerId]) {
            this.map.removeLayer(this.eventLayers[layerId]);
            delete this.eventLayers[layerId];
        }
    }

    addSiteLayer(id, name, sectors, fitBounds = true) {
        // Create new layer group (we can keep separate groups or merge into one 'sitesLayer' - merging is better for Z-index control)
        // But for toggle, separate management is easier.
        // Let's store raw data and re-render everything when something changes (to keep Z-Index and batching clean).
        // Actually, re-rendering ALL sites is fast enough for <10k sites.

        if (this.siteLayers.has(id)) {
            console.warn(`Layer ${id} already exists, replacing.`);
        }

        this.siteLayers.set(id, {
            id: id,
            name: name,
            sectors: sectors,
            visible: true,
            settings: null // Will store {color, opacity, range, beamwidth, useOverride} individually
        });

        this.rebuildSiteIndex();
        this.renderSites(fitBounds);
    }

    reorderSiteLayer(id, direction) {
        if (!this.siteLayers.has(id)) return false;
        const entries = Array.from(this.siteLayers.entries());
        const idx = entries.findIndex(([layerId]) => layerId === id);
        if (idx === -1) return false;
        const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
        if (swapIdx < 0 || swapIdx >= entries.length) return false;
        const tmp = entries[idx];
        entries[idx] = entries[swapIdx];
        entries[swapIdx] = tmp;
        this.siteLayers = new Map(entries);
        this.rebuildSiteIndex();
        this.renderSites(false);
        return true;
    }

    addOverlayLayer(id, points, metric) {
        // Overlay for RRC/CS Release Causes (Red Flags)
        // Do not clear existing logLayers. Just add a new specific layer.
        const overlayId = id + '_overlay_' + metric;

        if (this.logLayers[overlayId]) {
            this.map.removeLayer(this.logLayers[overlayId]);
        }

        const layerGroup = L.layerGroup();
        let count = 0;

        points.forEach(p => {
            if (!p.lat || !p.lng) return;

            // EVENT ONLY: To prevent drawing flags on every measurement point (sticky state)
            if (p.type !== 'EVENT') return;

            const val = this.getMetricValue(p, metric);

            // Filter Invalid Data for Overlay
            // Allow "Normal" and "Normal Clearing" as per user request to see "valid data"
            if (!val || val === 'N/A' || val === '-') return;

            const isNormal = val.toString().toLowerCase().includes('normal');

            // Color Logic: Red for Abnormal, Green (Hue Rotated) for Normal
            // 🚩 is Red (0deg). Rotating ~100deg-120deg makes it Green.
            const colorStyle = isNormal ? 'filter: hue-rotate(110deg);' : '';

            // RED/GREEN FLAG ICON
            const flagIcon = L.divIcon({
                className: 'custom-flag-icon',
                html: `<div style="font-size: 24px; color: red; text-shadow: 2px 2px 0px white; ${colorStyle}">🚩</div>`,
                iconSize: [24, 24],
                iconAnchor: [4, 20] // Bottom-left corner roughly
            });

            const marker = L.marker([p.lat, p.lng], { icon: flagIcon, zIndexOffset: 1000 })
                .addTo(layerGroup);

            const emitOverlayPoint = (detailName, e) => {
                window.dispatchEvent(new CustomEvent(detailName, {
                    detail: {
                        logId: overlayId,
                        point: p,
                        clientX: e?.originalEvent?.clientX,
                        clientY: e?.originalEvent?.clientY
                    }
                }));
            };
            const popupTitle = metric === 'cs_rel_cause'
                ? 'CS Release Cause'
                : metric === 'rrc_rel_cause'
                    ? 'RRC Release Cause'
                    : metric;
            const popupMessage = p?.messageSpec || p?.message || p?.properties?.Message || p?.properties?.['Message Spec'] || 'Unknown';
            const popupParsedCs = p?.cs_rel_cause || p?.properties?.['CS Release Cause'] || '-';
            const popupButton = (metric === 'cs_rel_cause' || metric === 'rrc_rel_cause')
                ? `<button onclick="window.openReleaseCausePayloadByMeta('${String((p && p.__sourceLogId) || id).replace(/'/g, "\\'")}', ${Number.isFinite(Number(p && (metric === 'cs_rel_cause' ? p.__csReleaseCauseIndex : p.__rrcReleaseCauseIndex))) ? Number(metric === 'cs_rel_cause' ? p.__csReleaseCauseIndex : p.__rrcReleaseCauseIndex) : -1}, '${metric === 'cs_rel_cause' ? 'cs' : 'rrc'}'); return false;" class="btn" style="margin-top:6px; padding:2px 8px; font-size:10px; background:#3b82f6;">Full decoded message</button>`
                : '';
            marker.bindPopup(
                `<div style="min-width:210px;">` +
                `<div style="font-weight:700; margin-bottom:4px;">${popupTitle}</div>` +
                `<div><b>Message:</b> ${popupMessage}</div>` +
                `${metric === 'cs_rel_cause' ? `<div><b>Parsed CS cause:</b> ${popupParsedCs}</div>` : ''}` +
                `<div><b>Cause:</b> ${val}</div>` +
                `<div><b>Time:</b> ${p.time || '-'}</div>` +
                `${popupButton}` +
                `</div>`
            );
            marker.on('click', (e) => {
                L.DomEvent.stop(e);
                emitOverlayPoint('map-point-clicked', e);
            });
            marker.on('contextmenu', (e) => {
                L.DomEvent.stop(e);
                emitOverlayPoint('map-point-contextmenu', e);
            });
            marker.on('mousedown', (e) => {
                if ((e?.originalEvent?.button ?? -1) !== 2) return;
                L.DomEvent.stop(e);
                emitOverlayPoint('map-point-contextmenu', e);
            });
            marker.on('add', () => {
                const markerEl = marker.getElement && marker.getElement();
                if (!markerEl || markerEl.dataset.failureContextBound === 'true') return;
                const domHandler = (ev) => {
                    ev.preventDefault();
                    ev.stopPropagation();
                    if (typeof ev.stopImmediatePropagation === 'function') ev.stopImmediatePropagation();
                    emitOverlayPoint('map-point-contextmenu', { originalEvent: ev });
                    return false;
                };
                markerEl.dataset.failureContextBound = 'true';
                markerEl.addEventListener('contextmenu', domHandler, true);
                markerEl.addEventListener('mousedown', (ev) => {
                    if ((ev.button ?? -1) !== 2) return;
                    domHandler(ev);
                }, true);
            });
            count++;
        });

        if (count > 0) {
            layerGroup.addTo(this.map);
            this.logLayers[overlayId] = layerGroup; // Track it to allow removal later if needed
            console.log(`[MapRenderer] Added Overlay ${metric}: ${count} points.`);
        } else {
            alert(`No abnormal ${metric} events found.`);
        }
    }

    removeSiteLayer(id) {
        if (this.siteLayers.has(id)) {
            console.log(`[MapRenderer] Removing Site Layer: ${id}`);
            this.siteLayers.delete(id);
            this.rebuildSiteIndex();
            this.renderSites(false);
            return true;
        } else {
            console.warn(`[MapRenderer] removeSiteLayer: ID ${id} not found. Available:`, Array.from(this.siteLayers.keys()));
        }
        return false;
    }

    toggleSiteLayer(id, visible) {
        const layer = this.siteLayers.get(id);
        if (layer) {
            layer.visible = visible;
            this.rebuildSiteIndex();
            this.renderSites(false);
        }
    }

    updateLayerSettings(id, settings) {
        if (this.siteLayers.has(id)) {
            const layer = this.siteLayers.get(id);
            // Merge existing settings with new ones
            layer.settings = { ...(layer.settings || {}), ...settings };
            this.renderSites(false);
        }
    }

    updateSiteSettings(settings) {
        this.siteSettings = { ...this.siteSettings, ...settings };
        if (this.siteLayers.size > 0 || (this.siteData && this.siteData.length > 0)) {
            this.renderSites(false); // Do NOT fit bounds on settings update
        }
    }

    // ── Undo / Redo ─────────────────────────────────────────────────────────────

    _sectorSnapshot(layerId, idx) {
        const lyr = this.siteLayers.get(layerId);
        const s   = lyr && lyr.sectors[idx];
        if (!s) return null;
        return { layerId, idx,
            lat: s.lat, lng: s.lng, azimuth: s.azimuth,
            cellName: s.cellName, cellId: s.cellId,
            pci: s.pci, sc: s.sc, freq: s.freq };
    }

    pushUndo(snapshots) {
        const valid = snapshots.filter(Boolean);
        if (!valid.length) return;
        this._undoStack.push(valid);
        this._redoStack = [];
        if (this._undoStack.length > 50) this._undoStack.shift();
    }

    _applySnapshots(snapshots) {
        snapshots.forEach(({ layerId, idx, ...fields }) => {
            const lyr = this.siteLayers.get(layerId);
            if (lyr && lyr.sectors[idx]) Object.assign(lyr.sectors[idx], fields);
        });
        this.rebuildSiteIndex();
        this.renderSites(false);
    }

    undo() {
        if (!this._undoStack.length) return;
        const before  = this._undoStack.pop();
        const current = before.map(({ layerId, idx }) => this._sectorSnapshot(layerId, idx)).filter(Boolean);
        this._redoStack.push(current);
        this._applySnapshots(before);
    }

    redo() {
        if (!this._redoStack.length) return;
        const after   = this._redoStack.pop();
        const current = after.map(({ layerId, idx }) => this._sectorSnapshot(layerId, idx)).filter(Boolean);
        this._undoStack.push(current);
        this._applySnapshots(after);
    }

    getSiteColor(s) {
        if (this.siteSettings && this.siteSettings.colorBy === 'identity') {
            let idStr = s.cellId;
            if (s.rnc && s.cid) idStr = `${s.rnc}/${s.cid}`;
            return this.getDiscreteColor(idStr);
        }

        const tech = (s.tech || '').toLowerCase();
        if (tech.includes('5g') || tech.includes('nr')) return '#8b5cf6'; // Purple
        if (tech.includes('4g') || tech.includes('lte')) return '#ef4444'; // Red
        if (tech.includes('3g') || tech.includes('umts') || tech.includes('wcdma')) return '#f59e0b'; // Amber
        if (tech.includes('2g') || tech.includes('gsm')) return '#3b82f6'; // Blue
        return '#6b7280'; // Gray
    }

    renderSites(fitBounds = false, activeCellIds = null) {
        if (!activeCellIds && this.activeMetricIds) {
            // SAFEGUARD: activeMetricIds might be an array (legacy) or null
            if (Array.isArray(this.activeMetricIds)) {
                activeCellIds = new Set(this.activeMetricIds);
            } else if (this.activeMetricIds instanceof Set) {
                activeCellIds = this.activeMetricIds;
            } else {
                activeCellIds = null;
            }
        }
        if (this.sitesLayer) {
            this.map.removeLayer(this.sitesLayer);
        }

        // Aggregate ALL Visible Sectors
        let visibleSectors = [];
        this.siteLayers.forEach(layer => {
            if (layer.visible && layer.sectors) {
                // Avoid spread operator for large arrays to prevent stack overflow
                for (let i = 0; i < layer.sectors.length; i++) {
                    visibleSectors.push(layer.sectors[i]);
                }
            }
        });

        if (visibleSectors.length === 0) {
            console.warn('[MapRenderer] No visible sectors to render.');
            return;
        }
        console.log(`[MapRenderer] Rendering ${visibleSectors.length} sectors.`);

        // AUTO-ZOOM (Fix for "Dots only" issue)
        if (fitBounds) {
            let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
            for (let i = 0; i < visibleSectors.length; i++) {
                const s = visibleSectors[i];
                const lat = s.lat;
                const lng = s.lng;
                if (isNaN(lat) || isNaN(lng)) continue;
                if (lat < minLat) minLat = lat;
                if (lat > maxLat) maxLat = lat;
                if (lng < minLng) minLng = lng;
                if (lng > maxLng) maxLng = lng;
            }
            if (minLat !== Infinity && minLng !== Infinity) {
                this.map.fitBounds([[minLat, minLng], [maxLat, maxLng]], { padding: [50, 50] });
            }
        }

        // Fix: Reuse existing layer group to avoid leaks/ghost layers
        if (!this.sitesLayer) {
            this.sitesLayer = L.layerGroup().addTo(this.map);
        } else {
            this.sitesLayer.clearLayers();
            if (!this.map.hasLayer(this.sitesLayer)) {
                this.sitesLayer.addTo(this.map);
            }
        }

        // Clear Labels
        if (this.siteLabelsLayer) {
            this.siteLabelsLayer.clearLayers();
        }


        const globalSettings = this.siteSettings || {};
        const bounds = this.map.getBounds().pad(0.2); // Only draw what's visible (plus buffer)

        this.sitePolygons = {};
        this._siteRotPolygons = new Map();
        this._sitePolygonsByName = new Map();
        const renderedSiteLabels = new Set();

        // Loop through each layer to render with its specific settings
        this.siteLayers.forEach(layer => {
            if (!layer.visible || !layer.sectors) return;

            // Determine Effective Settings for this Layer
            // If layer.settings exists, merge it on top of defaults. 
            // BUT: If a specific property is set in layer.settings, use it. 
            // If layer.settings is null, use globalSettings.

            // Strategy: Start with Global Defaults -> Override with Global User Settings -> Override with Layer Settings
            const defaults = { range: 100, opacity: 0.6, beamwidth: 35, color: null, useOverride: false };
            const effective = { ...defaults, ...globalSettings, ...(layer.settings || {}) };

            const range = parseInt(effective.range) || 100;
            const opacity = parseFloat(effective.opacity) || 0.6;
            const beam = parseInt(effective.beamwidth) || 35;
            const overrideColor = effective.useOverride ? effective.color : null;

            // Calculate LOD based on Zoom (re-calculated here or consistent)
            const zoom = this.map.getZoom();
            const showDetailedSectors = zoom >= 12;

            layer.sectors.forEach((s, index) => {
                if (s.lat === undefined || s.lng === undefined || isNaN(s.lat) || isNaN(s.lng)) return;
                // Group key: physical centre + azimuth so all techs at the same direction share one key.
                // This is order-independent and works even when 2G/3G/4G store sectors in different order.
                const _posKey   = `${s.lat.toFixed(5)}@@${s.lng.toFixed(5)}@@${Math.round(s.azimuth || 0)}`;
                const isKmlSite = String(s.source || '').toLowerCase() === 'kml';
                const kmlShape = String((effective && effective.markerShape) || s.markerShape || 'diamond').toLowerCase();
                const azimuth = s.azimuth || 0;
                // PERFORMANCE: Skip if outside visible area
                if (!bounds.contains([s.lat, s.lng])) return;

                const getPoint = (originLat, originLng, bearing, dist) => {
                    const rad = Math.PI / 180;
                    const latRad = originLat * rad;
                    const bearRad = bearing * rad;
                    const dy = Math.cos(bearRad) * dist;
                    const dx = Math.sin(bearRad) * dist;
                    const dLat = dy / 111111;
                    const dLng = dx / (111111 * Math.cos(latRad));
                    return [originLat + dLat, originLng + dLng];
                };

                const getOffsetPoint = (originLat, originLng, dx, dy) => {
                    const rad = Math.PI / 180;
                    const latRad = originLat * rad;
                    const dLat = dy / 111111;
                    const dLng = dx / (111111 * Math.cos(latRad));
                    return [originLat + dLat, originLng + dLng];
                };

                const buildKmlShapeHtml = (shape, color) => {
                    const base = 'width:16px;height:16px;background:' + color + ';border:2px solid rgba(255,255,255,0.95);box-shadow:0 2px 8px rgba(2,6,23,0.35);';
                    if (shape === 'triangle') return `<div style="${base}clip-path:polygon(50% 0%, 100% 100%, 0% 100%);"></div>`;
                    if (shape === 'square') return `<div style="${base}border-radius:3px;"></div>`;
                    if (shape === 'pentagon') return `<div style="${base}clip-path:polygon(50% 0%, 100% 38%, 82% 100%, 18% 100%, 0% 38%);"></div>`;
                    if (shape === 'hexagon') return `<div style="${base}clip-path:polygon(25% 0%, 75% 0%, 100% 50%, 75% 100%, 25% 100%, 0% 50%);"></div>`;
                    if (shape === 'octagon') return `<div style="${base}clip-path:polygon(30% 0%, 70% 0%, 100% 30%, 100% 70%, 70% 100%, 30% 100%, 0% 70%, 0% 30%);"></div>`;
                    if (shape === 'star') return `<div style="${base}clip-path:polygon(50% 0%, 61% 35%, 98% 35%, 68% 57%, 79% 91%, 50% 70%, 21% 91%, 32% 57%, 2% 35%, 39% 35%);"></div>`;
                    if (shape === 'cross') return `<div style="${base}clip-path:polygon(35% 0%, 65% 0%, 65% 35%, 100% 35%, 100% 65%, 65% 65%, 65% 100%, 35% 100%, 35% 65%, 0% 65%, 0% 35%, 35% 35%);"></div>`;
                    if (shape === 'circle') return `<div style="${base}border-radius:999px;"></div>`;
                    return `<div style="${base}transform:rotate(45deg);border-radius:2px;"></div>`;
                };

                const buildKmlShapeLatLngs = (originLat, originLng, shape, sizeMeters) => {
                    const n = (dx, dy) => getOffsetPoint(originLat, originLng, dx, dy);
                    switch (shape) {
                        case 'triangle':
                            return [n(0, sizeMeters), n(sizeMeters * 0.9, -sizeMeters * 0.7), n(-sizeMeters * 0.9, -sizeMeters * 0.7)];
                        case 'square':
                            return [n(-sizeMeters, sizeMeters), n(sizeMeters, sizeMeters), n(sizeMeters, -sizeMeters), n(-sizeMeters, -sizeMeters)];
                        case 'pentagon':
                            return [0, 72, 144, 216, 288].map((angle) => getPoint(originLat, originLng, angle, sizeMeters));
                        case 'hexagon':
                            return [0, 60, 120, 180, 240, 300].map((angle) => getPoint(originLat, originLng, angle, sizeMeters));
                        case 'octagon':
                            return [0, 45, 90, 135, 180, 225, 270, 315].map((angle) => getPoint(originLat, originLng, angle, sizeMeters));
                        case 'star': {
                            const pts = [];
                            for (let i = 0; i < 10; i++) {
                                const angle = i * 36;
                                const dist = i % 2 === 0 ? sizeMeters : sizeMeters * 0.45;
                                pts.push(getPoint(originLat, originLng, angle, dist));
                            }
                            return pts;
                        }
                        case 'cross':
                            return [
                                n(-sizeMeters * 0.35, sizeMeters),
                                n(sizeMeters * 0.35, sizeMeters),
                                n(sizeMeters * 0.35, sizeMeters * 0.35),
                                n(sizeMeters, sizeMeters * 0.35),
                                n(sizeMeters, -sizeMeters * 0.35),
                                n(sizeMeters * 0.35, -sizeMeters * 0.35),
                                n(sizeMeters * 0.35, -sizeMeters),
                                n(-sizeMeters * 0.35, -sizeMeters),
                                n(-sizeMeters * 0.35, -sizeMeters * 0.35),
                                n(-sizeMeters, -sizeMeters * 0.35),
                                n(-sizeMeters, sizeMeters * 0.35),
                                n(-sizeMeters * 0.35, sizeMeters * 0.35),
                            ];
                        case 'circle':
                            return null;
                        case 'diamond':
                        default:
                            return [n(0, sizeMeters), n(sizeMeters, 0), n(0, -sizeMeters), n(-sizeMeters, 0)];
                    }
                };

                const bindSectorInteractions = (shapeLayer) => {
                    if (!shapeLayer) return;
                    shapeLayer.__sectorData = s;
                    shapeLayer.__sectorAzimuth = azimuth;
                    shapeLayer.__sectorRange = range;
                    shapeLayer.__sectorBeamwidth = beam;
                    shapeLayer.bindTooltip(`
                        <strong>${s.name || 'Unknown Site'}</strong><br>
                        Cell: ${s.cellId || '-'} &nbsp;|&nbsp; Az: ${azimuth}° &nbsp;|&nbsp; ${s.tech || '-'}
                    `, { sticky: true, opacity: 0.9 });

                    shapeLayer.on('contextmenu', (e) => {
                        L.DomEvent.stopPropagation(e);
                        let displayId = `${s.rnc}/${s.cid}`;
                        if ((!s.rnc || s.rnc === 'undefined') && s.cellId && String(s.cellId).match(/[\-\/]/)) {
                            const parts = String(s.cellId).split(/[\-\/]/);
                            if (parts.length === 2) displayId = `${parts[0]}/${parts[1]}`;
                        }
                        shapeLayer.bindPopup(`
                            <div style="font-family:sans-serif;font-size:13px;">
                                <strong>${s.name || 'Unknown Site'}</strong><br>
                                Cell: ${s.cellId || '-'}<br>
                                Azimuth: ${azimuth}°<br>
                                Tech: ${s.tech || '-'}<br>
                                <span style="font-size:10px;color:#888;">(RNC/CID: ${displayId})</span><br>
                                <button style="margin-top:5px;cursor:pointer;" onclick="window.editSector('${layer.id}', ${index})">Edit</button>
                            </div>
                        `, { autoPan: false }).openPopup();
                    });

                    shapeLayer.on('click', (e) => {
                        console.log('[Spider] Sector click handler fired:', s.cellId || s.cellName || s.sc, 'dragJustEnded:', this._siteDragJustEnded);
                        if (this._siteDragJustEnded) return;
                        L.DomEvent.stopPropagation(e);
                        this._dispatchSectorClicked(s, {
                            azimuth: azimuth,
                            range: range,
                            beamwidth: beam,
                        });
                    });
                };

                // ... render logic ...
                if (!showDetailedSectors) {
                    let quickLayer;
                    if (isKmlSite) {
                        quickLayer = L.marker([s.lat, s.lng], {
                            icon: L.divIcon({
                                className: '',
                                html: buildKmlShapeHtml(kmlShape, s.color || this.getSiteColor(s)),
                                iconSize: [16, 16],
                                iconAnchor: [8, 8]
                            }),
                            pane: 'sitesPane',
                            interactive: true
                        }).addTo(this.sitesLayer);
                    } else {
                        // Draw simple dot at low zoom
                        quickLayer = L.circleMarker([s.lat, s.lng], {
                            radius: 6,
                            color: this.getSiteColor(s), // Note: Dot color doesn't usually use override unless we want it to
                            weight: 1.5,
                            fillOpacity: 0.8,
                            pane: 'sitesPane',
                            interactive: true
                        }).addTo(this.sitesLayer);
                    }
                    bindSectorInteractions(quickLayer);
                    this._registerSectorPolygonAliases(s, quickLayer);
                    return;
                }

                // SECTOR LOGIC
                const center = [s.lat, s.lng];
                let color;
                let finalFillOpacity = opacity;
                let weight = parseInt(effective.strokeWidth) || 1;
                let radiusOffset = 0;

                // Stroke settings (independent from fill)
                const strokeColor = effective.strokeColor || '#ffffff';
                const strokeOpacity = effective.strokeOpacity != null ? parseFloat(effective.strokeOpacity) : 0.8;
                let finalStrokeColor = strokeColor;
                let finalStrokeOpacity = strokeOpacity;

                // 1. External Highlight (User Click) - Highest Priority
                let currentRadius = range; // Base radius

                if (this.externalHighlight && (
                    s.cellId == this.externalHighlight.id ||
                    `${s.rnc}/${s.cid}` == this.externalHighlight.id ||
                    String(s.rawEnodebCellId || '').replace(/\s/g, '') === String(this.externalHighlight.id || '').replace(/\s/g, '')
                )) {
                    color = this.externalHighlight.color;
                    finalOpacity = 1;
                    finalFillOpacity = 0.8;
                    finalStrokeColor = color;
                    finalStrokeOpacity = 1;
                    weight = 4; // Thick border
                    radiusOffset = 10; // Make it larger
                }
                else if (activeCellIds) {
                    // HIGHLIGHT PASS (Dimming Unused Sectors)
                    // Default to DIMMED
                    color = '#555';
                    finalOpacity = 0.1;
                    finalFillOpacity = 0.1; // Faded out
                    finalStrokeColor = '#555';
                    finalStrokeOpacity = 0.1;

                    let idStr = String(s.cellId);
                    let rncCidStr = null;
                    if (s.rnc && s.cid) rncCidStr = `${s.rnc}/${s.cid}`;

                    // Check for Match
                    let isMatch = false;
                    if (activeCellIds.has(idStr)) isMatch = true;
                    if (rncCidStr && activeCellIds.has(rncCidStr)) isMatch = true;
                    // Also check numeric match just in case
                    if (s.cellId && activeCellIds.has(Number(s.cellId))) isMatch = true;

                    if (isMatch) {
                        // MATCH: Use Identity Color
                        color = this.getDiscreteColor(rncCidStr || idStr);
                        finalOpacity = 1;
                        finalFillOpacity = 0.6;
                        finalStrokeColor = strokeColor;
                        finalStrokeOpacity = strokeOpacity;
                        weight = Math.max(weight, 2);
                    }
                } else {
                    // STANDARD MODE: explicit override → sector's own color → tech default
                    color = overrideColor || s.color || this.getSiteColor(s);
                }

                s.currentRadius = range + radiusOffset; // PERSIST RADIUS FOR CONNECTIONS

                // Calculations
                let polygon;
                if (isKmlSite) {
                    const glyphRadius = 20 + radiusOffset * 0.15;
                    s.tipLat = s.lat;
                    s.tipLng = s.lng;
                    if (kmlShape === 'circle') {
                        polygon = L.circle(center, {
                            radius: glyphRadius,
                            color: finalStrokeColor,
                            weight: Math.max(weight, 1.5),
                            fillColor: color,
                            fillOpacity: Math.max(finalFillOpacity, 0.75),
                            opacity: finalStrokeOpacity,
                            pane: 'sitesPane',
                            renderer: this.sitesSvgRenderer
                        }).addTo(this.sitesLayer);
                    } else {
                        polygon = L.polygon(buildKmlShapeLatLngs(s.lat, s.lng, kmlShape, glyphRadius), {
                            color: finalStrokeColor,
                            weight: Math.max(weight, 1.5),
                            fillColor: color,
                            fillOpacity: Math.max(finalFillOpacity, 0.75),
                            opacity: finalStrokeOpacity,
                            className: 'sector-polygon',
                            interactive: true,
                            pane: 'sitesPane',
                            renderer: this.sitesSvgRenderer
                        }).addTo(this.sitesLayer);
                    }
                } else if (s.beam > 300) { // Omni
                    s.tipLat = s.lat;
                    s.tipLng = s.lng;
                    polygon = L.circle(center, {
                        radius: range + radiusOffset,
                        color: finalStrokeColor,
                        weight: weight,
                        fillColor: color,
                        fillOpacity: finalFillOpacity,
                        opacity: finalStrokeOpacity,
                        pane: 'sitesPane',
                        renderer: this.sitesSvgRenderer
                    }).addTo(this.sitesLayer);
                } else {
                    const tip = getPoint(s.lat, s.lng, azimuth, range + radiusOffset);
                    s.tipLat = tip[0];
                    s.tipLng = tip[1];
                    const p1 = getPoint(s.lat, s.lng, azimuth - beam / 2, range + radiusOffset);
                    const p2 = getPoint(s.lat, s.lng, azimuth + beam / 2, range + radiusOffset);

                    polygon = L.polygon([center, p1, p2], {
                        color: finalStrokeColor,
                        weight: weight,
                        fillColor: color,
                        fillOpacity: finalFillOpacity,
                        opacity: finalStrokeOpacity,
                        className: 'sector-polygon',
                        interactive: true,
                        pane: 'sitesPane',
                        renderer: this.sitesSvgRenderer
                    }).addTo(this.sitesLayer);
                }

                this._registerSectorPolygonAliases(s, polygon);

                // Register polygon for azimuth-rotation grouping (by position index, not azimuth value)
                // Each entry stores its own beam+totalR so 2G/3G/4G shapes are preserved on rotate
                if (s.tipLat && s.tipLng) {
                    if (!this._siteRotPolygons.has(_posKey)) {
                        this._siteRotPolygons.set(_posKey, { entries: [], cLat: s.lat, cLng: s.lng });
                    }
                    this._siteRotPolygons.get(_posKey).entries.push({
                        sector: s, polygon, totalR: range + radiusOffset, beam,
                    });
                }

                // Register polygon for site-move grouping — keyed by centre lat/lng so all tech layers
                // for the same physical site are always grouped together regardless of name differences.
                const _siteCenter = `${s.lat.toFixed(5)}@@${s.lng.toFixed(5)}`;
                if (!this._sitePolygonsByName.has(_siteCenter)) this._sitePolygonsByName.set(_siteCenter, []);
                this._sitePolygonsByName.get(_siteCenter).push({
                    polygon, s,
                    totalR: range + radiusOffset, beam,
                    isOmni: s.beam > 300,
                });

                // Labels
                if (effective.showSiteNames || globalSettings.forceSiteNames) {
                    const siteName = s.siteName || s.name;
                    if (siteName && !renderedSiteLabels.has(siteName)) {
                        renderedSiteLabels.add(siteName);
                        L.marker(center, {
                            icon: L.divIcon({
                                className: 'site-label',
                                html: `<div style="background:rgba(0,0,0,0.4); color:#fff; font-size:10px; padding:2px 4px; border-radius:3px; white-space:nowrap; transform: translate(-50%, -50%); position: absolute; left: 0; top: 0;">${siteName}</div>`,
                                iconSize: [0, 0]
                            }),
                            interactive: false,
                            pane: 'labelsPane'
                        }).addTo(this.siteLabelsLayer);
                    }
                }
                if (effective.showCellNames) {
                    const tipMid = [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2];
                    L.marker(tipMid, { icon: L.divIcon({ className: 'cell-label', html: `<div style="color:#ddd; font-size:9px; text-shadow:0 0 2px #000; white-space:nowrap;">${s.cellId || ''}</div>`, iconAnchor: [10, 0] }), interactive: false, pane: 'labelsPane' }).addTo(this.siteLabelsLayer);
                }

                // MOUSEDOWN: plain drag = move site | Shift+drag = rotate azimuth
                polygon.on('mousedown', (e) => {
                    if (e.originalEvent.button !== 0) return;
                    L.DomEvent.stopPropagation(e);

                    if (e.originalEvent.shiftKey) {
                        // ── ROTATION MODE (Shift+drag) ───────────────────────────────────────
                        this.map.dragging.disable();
                        const rg        = this._siteRotPolygons.get(_posKey);
                        const cLat      = s.lat;
                        const cLng      = s.lng;
                        const labelR    = range + radiusOffset;
                        const initialAz = Math.round(azimuth);
                        let   currentAz = azimuth;

                        // Capture before-state for undo (all techs at this site centre + azimuth)
                        const _rotSnap = [];
                        this.siteLayers.forEach((lyr, layerId) => {
                            if (!lyr.sectors) return;
                            lyr.sectors.forEach((sec, idx) => {
                                if (sec.lat === cLat && sec.lng === cLng && Math.round(sec.azimuth) === initialAz)
                                    _rotSnap.push(this._sectorSnapshot(layerId, idx));
                            });
                        });

                        const _azHtml = (az) =>
                            `<div style="display:inline-block;background:rgba(15,15,25,0.92);color:#fde68a;` +
                            `font-size:13px;font-weight:700;padding:4px 10px;border-radius:8px;` +
                            `white-space:nowrap;border:1px solid rgba(253,230,138,0.4);` +
                            `box-shadow:0 2px 8px rgba(0,0,0,0.6);letter-spacing:0.04em;` +
                            `pointer-events:none;transform:translate(-50%,-130%);`+
                            `position:absolute;left:0;top:0;">${az}°</div>`;

                        if (this._azLabel) this.map.removeLayer(this._azLabel);
                        this._azLabel = L.marker(getPoint(cLat, cLng, currentAz, labelR * 0.55), {
                            icon: L.divIcon({ className: '', html: _azHtml(currentAz), iconSize: [0, 0] }),
                            interactive: false, pane: 'labelsPane',
                        }).addTo(this.map);

                        if (this._azDirLine) this.map.removeLayer(this._azDirLine);
                        this._azDirLine = L.polyline(
                            [[cLat, cLng], getPoint(cLat, cLng, currentAz, 500)],
                            { color: '#ef4444', weight: 2.5, dashArray: '8,5', opacity: 0.9, interactive: false, pane: 'labelsPane' }
                        ).addTo(this.map);

                        const onRotMove = (ev) => {
                            const pt     = this.map.mouseEventToContainerPoint(ev);
                            const latlng = this.map.containerPointToLatLng(pt);
                            const dlat   = latlng.lat - cLat;
                            const dlng   = (latlng.lng - cLng) * Math.cos(cLat * Math.PI / 180);
                            currentAz    = Math.round((Math.atan2(dlng, dlat) * 180 / Math.PI + 360) % 360);

                            if (this._azLabel) {
                                this._azLabel.setLatLng(getPoint(cLat, cLng, currentAz, labelR * 0.55));
                                this._azLabel.setIcon(L.divIcon({ className: '', html: _azHtml(currentAz), iconSize: [0, 0] }));
                            }
                            if (this._azDirLine) {
                                this._azDirLine.setLatLngs([[cLat, cLng], getPoint(cLat, cLng, currentAz, 500)]);
                            }
                            // Rotate every tech's polygon using its OWN beam/range so shapes stay correct
                            if (rg) {
                                rg.entries.forEach(({ sector: sec, polygon: poly, totalR: entryR, beam: entryBw }) => {
                                    sec.azimuth = currentAz;
                                    const p1 = getPoint(cLat, cLng, currentAz - entryBw / 2, entryR);
                                    const p2 = getPoint(cLat, cLng, currentAz + entryBw / 2, entryR);
                                    poly.setLatLngs([[cLat, cLng], p1, p2]);
                                });
                            }
                        };

                        const onRotUp = () => {
                            document.removeEventListener('mousemove', onRotMove);
                            document.removeEventListener('mouseup', onRotUp);
                            if (this._azLabel) { this.map.removeLayer(this._azLabel); this._azLabel = null; }
                            if (this._azDirLine) { this.map.removeLayer(this._azDirLine); this._azDirLine = null; }
                            this.map.dragging.enable();
                            // Apply final azimuth to off-screen sectors (on-screen already updated by onRotMove)
                            this.siteLayers.forEach(lyr => {
                                if (!lyr.sectors) return;
                                lyr.sectors.forEach(sec => {
                                    if (sec.lat === cLat && sec.lng === cLng && Math.round(sec.azimuth) === initialAz)
                                        sec.azimuth = currentAz;
                                });
                            });
                            if (currentAz !== azimuth) this.pushUndo(_rotSnap);
                            this._siteDragJustEnded = true;
                            setTimeout(() => { this._siteDragJustEnded = false; }, 60);
                            this.renderSites(false);
                        };

                        document.addEventListener('mousemove', onRotMove);
                        document.addEventListener('mouseup', onRotUp);

                    } else {
                        // ── MOVE MODE (plain drag) ───────────────────────────────────────────
                        const dragSiteName = s.siteName || s.name || String(s.cellId || '');
                        const origLat      = s.lat;
                        const origLng      = s.lng;
                        const origSiteKey  = `${origLat.toFixed(5)}@@${origLng.toFixed(5)}`;

                        // Capture before-state for undo (all techs sharing this site centre)
                        const _moveSnap = [];
                        this.siteLayers.forEach((lyr, layerId) => {
                            if (!lyr.sectors) return;
                            lyr.sectors.forEach((sec, idx) => {
                                if (sec.lat === origLat && sec.lng === origLng)
                                    _moveSnap.push(this._sectorSnapshot(layerId, idx));
                            });
                        });

                        this._siteDragState = {
                            startX: e.originalEvent.clientX,
                            startY: e.originalEvent.clientY,
                            dragging: false,
                            currentLat: origLat,
                            currentLng: origLng,
                        };

                        const onMove = (ev) => {
                            const ds = this._siteDragState;
                            if (!ds) return;
                            const dx = ev.clientX - ds.startX;
                            const dy = ev.clientY - ds.startY;
                            if (!ds.dragging && Math.sqrt(dx * dx + dy * dy) > 6) {
                                ds.dragging = true;
                                this.map.dragging.disable();
                                this.map.getContainer().style.cursor = 'grabbing';
                            }
                            if (ds.dragging) {
                                const pt     = this.map.mouseEventToContainerPoint(ev);
                                const latlng = this.map.containerPointToLatLng(pt);
                                ds.currentLat = latlng.lat;
                                ds.currentLng = latlng.lng;
                                if (!this._dragMarker) {
                                    this._dragMarker = L.marker([latlng.lat, latlng.lng], {
                                        icon: L.divIcon({
                                            className: 'site-drag-pin',
                                            html: `<div>${dragSiteName}</div>`,
                                            iconSize: [0, 0],
                                        }),
                                        interactive: false,
                                        pane: 'labelsPane',
                                    }).addTo(this.map);
                                } else {
                                    this._dragMarker.setLatLng([latlng.lat, latlng.lng]);
                                }
                                // Move all tech polygons visually — keyed by original site centre
                                const siteEntries = this._sitePolygonsByName.get(origSiteKey);
                                if (siteEntries) {
                                    siteEntries.forEach(({ polygon: poly, s: sec, totalR, beam: bw, isOmni }) => {
                                        if (isOmni) {
                                            poly.setLatLng([latlng.lat, latlng.lng]);
                                        } else {
                                            const az = sec.azimuth || 0;
                                            const q1 = getPoint(latlng.lat, latlng.lng, az - bw / 2, totalR);
                                            const q2 = getPoint(latlng.lat, latlng.lng, az + bw / 2, totalR);
                                            poly.setLatLngs([[latlng.lat, latlng.lng], q1, q2]);
                                        }
                                    });
                                }
                            }
                        };

                        const onUp = () => {
                            document.removeEventListener('mousemove', onMove);
                            document.removeEventListener('mouseup', onUp);
                            const ds = this._siteDragState;
                            const wasDragging = ds && ds.dragging;
                            this._siteDragState = null;
                            if (this._dragMarker) { this.map.removeLayer(this._dragMarker); this._dragMarker = null; }
                            if (wasDragging) {
                                this._siteDragJustEnded = true;
                                setTimeout(() => { this._siteDragJustEnded = false; }, 60);
                                this.pushUndo(_moveSnap);
                                // Update all sectors sharing the original centre (all techs, on-screen + off-screen)
                                this.siteLayers.forEach(lyr => {
                                    if (!lyr.sectors) return;
                                    lyr.sectors.forEach(sec => {
                                        if (sec.lat === origLat && sec.lng === origLng) {
                                            sec.lat = ds.currentLat;
                                            sec.lng = ds.currentLng;
                                        }
                                    });
                                });
                                this.rebuildSiteIndex();
                                this.renderSites(false);
                                this.map.dragging.enable();
                                this.map.getContainer().style.cursor = '';
                            }
                        };

                        document.addEventListener('mousemove', onMove);
                        document.addEventListener('mouseup', onUp);
                    }
                });

                bindSectorInteractions(polygon);

                this._registerSectorPolygonAliases(s, polygon);
            });
        });

        this.customDiscreteColors = this.customDiscreteColors || {}; // Ensure defined
        this.updateLabelVisibility();


    }

    _normalizeSitePolygonKey(v) {
        return String(v == null ? '' : v).replace(/\s/g, '');
    }

    _registerSitePolygonAlias(key, polygon) {
        if (!polygon || key === undefined || key === null) return;
        const raw = String(key).trim();
        if (!raw) return;
        this.sitePolygons[raw] = polygon;
        const normalized = this._normalizeSitePolygonKey(raw);
        if (normalized) this.sitePolygons[normalized] = polygon;
        const lowered = normalized.toLowerCase();
        if (lowered) this.sitePolygons[lowered] = polygon;
        if (raw.includes('/')) {
            this.sitePolygons[raw.replace(/\//g, '-')] = polygon;
            this.sitePolygons[normalized.replace(/\//g, '-')] = polygon;
            this.sitePolygons[lowered.replace(/\//g, '-')] = polygon;
        }
        if (raw.includes('-')) {
            this.sitePolygons[raw.replace(/-/g, '/')] = polygon;
            this.sitePolygons[normalized.replace(/-/g, '/')] = polygon;
            this.sitePolygons[lowered.replace(/-/g, '/')] = polygon;
        }
    }

    _registerSectorPolygonAliases(sector, polygon) {
        if (!sector || !polygon) return;
        this._registerSitePolygonAlias(sector.cellId, polygon);
        this._registerSitePolygonAlias(sector.rawEnodebCellId, polygon);
        this._registerSitePolygonAlias(sector.calculatedEci, polygon);
        this._registerSitePolygonAlias(sector.cellName, polygon);
        this._registerSitePolygonAlias(sector.name, polygon);
        this._registerSitePolygonAlias(sector.siteName, polygon);
        if (sector.rnc != null && sector.cid != null) {
            this._registerSitePolygonAlias(`${sector.rnc}/${sector.cid}`, polygon);
            this._registerSitePolygonAlias(`${sector.rnc}-${sector.cid}`, polygon);
        }
    }

    _getSitePolygon(cellId) {
        if (!cellId || !this.sitePolygons) return null;
        const raw = String(cellId).trim();
        const keys = [
            raw,
            this._normalizeSitePolygonKey(raw),
            this._normalizeSitePolygonKey(raw).toLowerCase(),
            raw.replace(/\//g, '-'),
            raw.replace(/-/g, '/'),
            this._normalizeSitePolygonKey(raw.replace(/\//g, '-')),
            this._normalizeSitePolygonKey(raw.replace(/-/g, '/')),
            this._normalizeSitePolygonKey(raw.replace(/\//g, '-')).toLowerCase(),
            this._normalizeSitePolygonKey(raw.replace(/-/g, '/')).toLowerCase(),
        ].filter(Boolean);
        for (const key of keys) {
            if (this.sitePolygons[key]) return this.sitePolygons[key];
        }
        const site = (() => {
            if (!this.siteIndex) return null;
            const byId = this.siteIndex.byId;
            for (const key of keys) {
                if (byId && byId.has(key)) return byId.get(key);
            }
            if (!Array.isArray(this.siteIndex.all)) return null;
            const wanted = raw.toLowerCase();
            return this.siteIndex.all.find((s) => {
                const candidates = [
                    s && s.cellId,
                    s && s.rawEnodebCellId,
                    s && s.cellName,
                    s && s.name,
                    s && s.siteName,
                ].filter(Boolean).map((v) => String(v).trim().toLowerCase());
                return candidates.includes(wanted);
            }) || null;
        })();
        if (!site) return null;
        this._registerSectorPolygonAliases(site, this.sitePolygons[site.cellId] || this.sitePolygons[site.rawEnodebCellId] || this.sitePolygons[site.calculatedEci] || null);
        const siteKeys = [
            site.cellId,
            site.rawEnodebCellId,
            site.calculatedEci,
            site.cellName,
            site.name,
            site.siteName,
            site.rnc != null && site.cid != null ? `${site.rnc}/${site.cid}` : null,
            site.rnc != null && site.cid != null ? `${site.rnc}-${site.cid}` : null,
        ].filter(Boolean);
        for (const key of siteKeys) {
            const polygon = this.sitePolygons[key] || this.sitePolygons[this._normalizeSitePolygonKey(key)] || this.sitePolygons[this._normalizeSitePolygonKey(key).toLowerCase()];
            if (polygon) return polygon;
        }
        return null;
    }

    setMeasurementInteractivity(enabled) {
        const setLayerInteractivity = (layer) => {
            if (!layer) return;
            if (layer.options) layer.options.interactive = !!enabled;
            if (typeof layer.off === 'function' && !enabled && typeof layer.closePopup === 'function') {
                try { layer.closePopup(); } catch (_) {}
            }
            const el = typeof layer.getElement === 'function' ? layer.getElement() : null;
            if (el && el.style) {
                el.style.pointerEvents = enabled ? '' : 'none';
            }
            if (layer._path && layer._path.style) {
                layer._path.style.pointerEvents = enabled ? '' : 'none';
            }
        };
        const applyGroup = (groupMap) => {
            if (!groupMap) return;
            Object.values(groupMap).forEach((group) => {
                if (!group || typeof group.eachLayer !== 'function') return;
                group.eachLayer((layer) => setLayerInteractivity(layer));
            });
        };
        applyGroup(this.logLayers);
        applyGroup(this.eventLayers);
    }

    _dispatchSectorClicked(sector, overrides = {}) {
        if (!sector) return false;
        window.dispatchEvent(new CustomEvent('site-sector-clicked', {
            detail: {
                cellId: sector.cellId,
                cellName: sector.cellName || sector.name || null,
                rawEnodebCellId: sector.rawEnodebCellId,
                calculatedEci: sector.calculatedEci,
                siteName: sector.siteName || sector.name || sector.cellName,
                sc: sector.sc || sector.pci,
                pci: sector.pci || sector.sc,
                lac: sector.lac,
                tac: sector.tac,
                freq: sector.freq,
                lat: sector.lat,
                lng: sector.lng,
                azimuth: overrides.azimuth != null ? overrides.azimuth : sector.azimuth,
                rnc: sector.rnc,
                cid: sector.cid,
                range: overrides.range != null ? overrides.range : (sector.currentRadius || sector.range || 100),
                beamwidth: overrides.beamwidth != null ? overrides.beamwidth : sector.beam,
            }
        }));
        return true;
    }

    dispatchSectorClickForMapClick(latlng, maxPixelDistance = 18) {
        const result = { handled: false, foundSector: false, sector: null };
        if (!this.map || !this.sitesLayer || !latlng) return result;
        const layerPoint = this.map.latLngToLayerPoint(latlng);
        const clickPt = this.map.latLngToContainerPoint(latlng);
        let nearest = null;
        let nearestDist2 = Infinity;

        this.sitesLayer.eachLayer((layer) => {
            if (!layer || !layer.__sectorData) return;
            if (typeof layer._containsPoint === 'function') {
                try {
                    if (layer._containsPoint(layerPoint)) {
                        nearest = layer;
                        nearestDist2 = 0;
                        return;
                    }
                } catch (_) {}
            }
            if (nearestDist2 === 0) return;
            const s = layer.__sectorData;
            const lat = Number(s && s.lat);
            const lng = Number(s && s.lng);
            if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
            const pt = this.map.latLngToContainerPoint([lat, lng]);
            const dx = pt.x - clickPt.x;
            const dy = pt.y - clickPt.y;
            const d2 = dx * dx + dy * dy;
            if (d2 <= maxPixelDistance * maxPixelDistance && d2 < nearestDist2) {
                nearest = layer;
                nearestDist2 = d2;
            }
        });

        if (!nearest || !nearest.__sectorData) return result;
        result.foundSector = true;
        result.sector = nearest.__sectorData;
        result.handled = this._dispatchSectorClicked(nearest.__sectorData, {
            azimuth: nearest.__sectorAzimuth,
            range: nearest.__sectorRange,
            beamwidth: nearest.__sectorBeamwidth,
        });
        return result;
    }

    highlightCell(cellId) {
        if (!cellId || !this.sitePolygons) return;

        // Reset previous highlight
        if (this.currentHighlight) {
            const { poly, originalStyle } = this.currentHighlight;
            poly.setStyle(originalStyle);
            this.currentHighlight = null;
        }

        const polygon = this._getSitePolygon(cellId);
        if (polygon) {
            // Save original style (approximate or just hardcoded default if easier)
            // But checking current options is safer
            const originalStyle = {
                color: polygon.options.color,
                weight: polygon.options.weight,
                fillColor: polygon.options.fillColor,
                fillOpacity: polygon.options.fillOpacity
            };

            // Apply Highlight
            polygon.setStyle({
                color: '#ffff00', // Bright Yellow Border
                weight: 4,
                fillColor: '#ffff00', // Yellow Fill
                fillOpacity: 0.6,
                interactive: false // Logic attempt
            });

            // FORCE CSS pointer-events: none (Leaflet setStyle might not update interactivity dynamically on all versions)
            if (polygon.getElement && polygon.getElement()) {
                polygon.getElement().style.pointerEvents = 'none';
            } else if (polygon._path) { // Older Leaflet / Canvas fallback
                polygon._path.style.pointerEvents = 'none';
            }

            polygon.bringToFront();

            // Pan to it - REMOVED per user request to keep current zoom/view
            // if (polygon.getBounds) {
            //     this.map.panTo(polygon.getBounds().getCenter());
            // }

            this.currentHighlight = { poly: polygon, originalStyle: originalStyle };
        } else {
            console.warn(`Cell ID ${cellId} not found in site polygons.`);
        }
    }

    setCustomColor(id, color) {
        this.customDiscreteColors[id] = color;
        // Optimization: We could surgically update just those points/polygons, 
        // but re-rendering is much safer to ensure consistency with current metric.
        // Firing global events to trigger re-rendering of active log/theme
        window.dispatchEvent(new CustomEvent('metric-color-changed', { detail: { id, color } }));
    }

    async zoomToCell(cellId) {
        if (!cellId) return;

        // 1. Try finding existing polygon (rendered)
        const polygon = this._getSitePolygon(cellId);
        if (polygon) {
            const center = polygon.getBounds().getCenter();

            // Check if already on screen
            if (this.map.getBounds().contains(center)) {
                this.map.panTo(center, { animate: true });
            } else {
                this.map.flyTo(center, 17, { animate: true, duration: 1.5 });
            }
            this.highlightCell(cellId);
            return;
        }

        // 2. Fallback: Search in Raw Data (if not currently rendered/visible)
        console.log(`[MapRenderer] Cell ${cellId} not rendered. Searching raw data...`);
        let foundSector = null;

        for (const layer of this.siteLayers.values()) {
            if (!layer.sectors) continue;
            foundSector = layer.sectors.find(s => {
                if (String(s.cellId) === String(cellId)) return true;
                if (s.rawEnodebCellId === cellId) return true;
                if (s.calculatedEci == cellId) return true;
                if (s.rnc && s.cid && `${s.rnc}/${s.cid}` === String(cellId)) return true;
                return false;
            });
            if (foundSector) break;
        }

        if (foundSector) {
            console.log(`[MapRenderer] Found ${cellId} in raw data. Flying to ${foundSector.lat}, ${foundSector.lng}`);
            this.map.flyTo([foundSector.lat, foundSector.lng], 17, { animate: true, duration: 1.5 });

            // Wait a bit for render to catch up after move, then highlight
            this.map.once('moveend', () => {
                setTimeout(() => {
                    this.highlightCell(cellId);
                }, 500);
            });
        } else {
            console.warn(`[MapRenderer] zoomToCell: Cell ${cellId} not found anywhere.`);
        }
    }


    drawConnections(startPt, targets) {
        // Store for refresh after renderSites updates sector tip positions
        this._lastConnectionStartPt = startPt || null;
        this._lastConnectionTargets = (targets && targets.length) ? targets.slice() : [];
        // Clear previous connections
        this.connectionsLayer.clearLayers();
        if (!startPt || !targets || targets.length === 0) return;
        const maxNeighborLines = Number.isFinite(Number(window.__pointDetailsVisibleNeighborLineCount))
            ? Math.max(0, Math.min(7, Math.round(Number(window.__pointDetailsVisibleNeighborLineCount))))
            : 7;
        let visibleNeighborCount = 0;
        const visibleTargets = targets.filter((t) => {
            const role = String((t && t.connectionRole) || '').toLowerCase();
            if (role !== 'neighbor' && role !== 'detected') return true;
            if (visibleNeighborCount >= maxNeighborLines) return false;
            visibleNeighborCount += 1;
            return true;
        });
        if (visibleTargets.length === 0) return;
        const toFiniteNumber = (v) => {
            if (v === undefined || v === null || v === '') return null;
            if (typeof v === 'number') return Number.isFinite(v) ? v : null;
            const n = Number(String(v).replace(',', '.').trim());
            return Number.isFinite(n) ? n : null;
        };
        const startLat = toFiniteNumber(startPt.lat);
        const startLng = toFiniteNumber(startPt.lng);
        if (startLat === null || startLng === null) return;
        const normalizeId = (v) => String(v == null ? '' : v).replace(/\s/g, '');
        const resolveCoordsFromCellId = (cellId) => {
            if (!cellId) return null;
            const raw = String(cellId);
            const keys = [raw, raw.replace(/\//g, '-'), raw.replace(/-/g, '/')].map(normalizeId);
            for (const k of keys) {
                const poly = this.sitePolygons && this.sitePolygons[k];
                if (!poly) continue;
                const b = poly.getBounds && poly.getBounds();
                if (!b || !b.isValid || !b.isValid()) continue;
                const c = b.getCenter();
                if (Number.isFinite(c.lat) && Number.isFinite(c.lng)) return { lat: c.lat, lng: c.lng };
            }
            if (this.siteIndex && this.siteIndex.byId) {
                for (const k of keys) {
                    if (!this.siteIndex.byId.has(k)) continue;
                    const s = this.siteIndex.byId.get(k);
                    const lat = toFiniteNumber(s && s.lat);
                    const lng = toFiniteNumber(s && s.lng);
                    if (lat !== null && lng !== null) return { lat, lng };
                }
            }
            return null;
        };

        visibleTargets.forEach(t => {
            let baseLat = toFiniteNumber(t.lat);
            let baseLng = toFiniteNumber(t.lng);
            if (baseLat === null || baseLng === null) {
                const fallback = resolveCoordsFromCellId(t.cellId);
                if (!fallback) return;
                baseLat = fallback.lat;
                baseLng = fallback.lng;
            }

            let destLat = baseLat;
            let destLng = baseLng;

            // 1. Precise Tip Calculation via precomputed tip (preferred)
            const tipLat = toFiniteNumber(t.tipLat);
            const tipLng = toFiniteNumber(t.tipLng);
            if (tipLat !== null && tipLng !== null) {
                destLat = tipLat;
                destLng = tipLng;
            }
            // 2. Precise Tip Calculation via Azimuth
            else {
                const azimuth = toFiniteNumber(t.azimuth);
                const range = toFiniteNumber(t.range);
                if (azimuth !== null && range !== null && range > 0) {
                const rad = Math.PI / 180;
                    const latRad = baseLat * rad;
                    const azRad = azimuth * rad;
                    const dist = range; // meters

                    const dy = Math.cos(azRad) * dist;
                    const dx = Math.sin(azRad) * dist;
                    const dLat = dy / 111111;
                    const dLng = dx / (111111 * Math.cos(latRad));

                    destLat = baseLat + dLat;
                    destLng = baseLng + dLng;
                }
                // 3. Fallback: Polygon Centroid Logic
                else if (t.cellId && this.sitePolygons[t.cellId]) {
                    const poly = this.sitePolygons[t.cellId];
                    // Polygon structure: [center, p1, p2]
                    // Leaflet polygons often return nested arrays: [[center, p1, p2]]
                    const latLngs = poly.getLatLngs();
                    const points = Array.isArray(latLngs[0]) ? latLngs[0] : latLngs;

                    if (points.length >= 3) {
                        const p1 = points[1];
                        const p2 = points[2];
                        destLat = (p1.lat + p2.lat) / 2;
                        destLng = (p1.lng + p2.lng) / 2;
                    }
                }
            }

            if (!Number.isFinite(destLat) || !Number.isFinite(destLng)) return;
            L.polyline([[startLat, startLng], [destLat, destLng]], {
                color: t.color,
                weight: t.weight || 3,
                opacity: 1.0,
                dashArray: '10, 5',
                pane: 'connectionsPane', // Force to top
                renderer: this.connectionsRenderer, // Force to Connections Canvas
                interactive: false // Don't block clicks
            }).addTo(this.connectionsLayer);
        });
    }

    drawSpiderLines(segments) {
        // Clear previous connections
        this.connectionsLayer.clearLayers();
        if (!segments || segments.length === 0) return;
        const grouped = new Map();
        segments.forEach((seg) => {
            if (!seg || !Array.isArray(seg.from) || !Array.isArray(seg.to)) return;
            const color = seg.color || '#3b82f6';
            const weight = Number.isFinite(Number(seg.weight)) ? Number(seg.weight) : 1;
            const opacity = Number.isFinite(Number(seg.opacity)) ? Number(seg.opacity) : 0.6;
            const dash = seg.dashArray || '';
            const key = `${color}__${weight}__${opacity}__${dash}`;
            if (!grouped.has(key)) {
                grouped.set(key, {
                    color,
                    weight,
                    opacity,
                    dashArray: dash,
                    lines: [],
                });
            }
            grouped.get(key).lines.push([seg.from, seg.to]);
        });
        grouped.forEach((group) => {
            if (!group.lines.length) return;
            const opts = {
                color: group.color,
                weight: group.weight,
                opacity: group.opacity,
                pane: 'connectionsPane',
                renderer: this.connectionsRenderer,
                interactive: false
            };
            if (group.dashArray) opts.dashArray = group.dashArray;
            L.polyline(group.lines, opts).addTo(this.connectionsLayer);
        });
    }

    clearConnections() {
        this.connectionsLayer.clearLayers();
        this._lastConnectionStartPt = null;
        this._lastConnectionTargets = [];
    }

    refreshConnections() {
        const startPt = this._lastConnectionStartPt;
        const targets = this._lastConnectionTargets;
        if (!startPt || !targets || !targets.length) return;
        const normalizeId = (v) => String(v == null ? '' : v).replace(/\s/g, '');
        const refreshed = targets.map(t => {
            if (!t.cellId) return t;
            const raw = String(t.cellId);
            const keys = [raw, raw.replace(/\//g, '-'), raw.replace(/-/g, '/')].map(normalizeId);
            for (const k of keys) {
                const s = this.siteIndex && this.siteIndex.byId && this.siteIndex.byId.get(k);
                if (s && s.tipLat != null && s.tipLng != null) {
                    return { ...t, tipLat: s.tipLat, tipLng: s.tipLng };
                }
            }
            return t;
        });
        this.drawConnections(startPt, refreshed);
    }


    exportToKML(logId, logPoints, metricName) {
        if (!logPoints || logPoints.length === 0) return null;

        const isDiscrete = (metricName === 'cellId' || metricName === 'cid');

        let kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${metricName.toUpperCase()} Analysis - ${new Date().toLocaleTimeString()}</name>
    <open>1</open>
`;

        // Helper to convert #RRGGBB to aabbggrr
        const hexToKmlColor = (hex) => {
            if (!hex || hex[0] !== '#') return 'ffcccccc';
            const r = hex.substring(1, 3);
            const g = hex.substring(3, 5);
            const b = hex.substring(5, 7);
            return 'ff' + b + g + r; // Fully opaque
        };

        // Collect Unique Styles
        const styles = new Set();
        // Grouping Map: Label -> Array of Placemarks
        const groups = new Map();

        const settings = this.siteSettings || {};
        const range = parseInt(settings.range) || 100;
        const rad = Math.PI / 180;

        // Determine Thresholds if applicable
        let thresholds = null;
        if (window.getThresholdKey && window.themeConfig) {
            const rangeKey = window.getThresholdKey(metricName);
            if (rangeKey && window.themeConfig.thresholds[rangeKey]) {
                thresholds = window.themeConfig.thresholds[rangeKey];
            }
        }

        logPoints.forEach((p, idx) => {
            if (p.lat === undefined || p.lng === undefined) return;

            const val = this.getMetricValue(p, metricName);
            const color = this.getColor(val, metricName);

            const styleId = 's_' + color.replace('#', '');
            styles.add({ id: styleId, color: hexToKmlColor(color) });

            // Detailed Description Generation
            const safeVal = (v) => (v !== undefined && v !== '-' && !isNaN(v) ? Number(v).toFixed(1) : '-');
            const formatId = (id) => {
                if (!id || id === 'N/A') return id;
                const strId = String(id);
                if (strId.includes('/')) return id;
                const num = Number(strId.replace(/[^\d]/g, ''));
                if (!isNaN(num) && num > 65535) return `${num >> 16}/${num & 0xFFFF}`;
                return id;
            };

            const s = (p.parsed && p.parsed.serving) ? p.parsed.serving : {};
            const sFreq = s.freq;
            const sLac = s.lac;

            const servingRes = window.resolveSmartSite ? window.resolveSmartSite(p) : { name: 'Unknown', id: p.cellId };
            const servingData = {
                type: 'Serving',
                name: servingRes.name || 'Unknown',
                cellId: servingRes.id || p.cellId,
                displayId: formatId(servingRes.id || p.cellId),
                sc: p.sc,
                rscp: p.rscp !== undefined ? p.rscp : (p.level !== undefined ? p.level : (s.level !== undefined ? s.level : '-')),
                ecno: p.ecno !== undefined ? p.ecno : (s.ecno !== undefined ? s.ecno : '-'),
                freq: sFreq || '-'
            };

            // Table Rows Construction (Simplified for brevity as string interpolation)
            // Note: Keeping the rich description logic is good, but for the task "Grouping", the key is the folder logic below.
            // I will retain the detailed description logic.

            const resolveNeighbor = (pci, cellId, freq) => {
                if (!window.resolveSmartSite) return { name: 'Unknown', id: cellId || pci };
                return window.resolveSmartSite({
                    sc: pci, cellId: cellId, lac: sLac, freq: freq || sFreq, lat: p.lat, lng: p.lng
                });
            };

            let activeRows = [];
            // ... (Logic for neighbors same as previous) ...
            if (p.a2_sc !== undefined && p.a2_sc !== null) {
                const a2Res = resolveNeighbor(p.a2_sc, null, sFreq);
                const nA2 = p.parsed && p.parsed.neighbors ? p.parsed.neighbors.find(n => n.pci === p.a2_sc) : null;
                activeRows.push({ type: '2nd Active', name: a2Res.name, cellId: a2Res.id, sc: p.a2_sc, rscp: p.a2_rscp || (nA2 ? nA2.rscp : '-'), ecno: nA2 ? nA2.ecno : '-', freq: sFreq || '-' });
            }
            if (p.a3_sc !== undefined && p.a3_sc !== null) {
                const a3Res = resolveNeighbor(p.a3_sc, null, sFreq);
                const nA3 = p.parsed && p.parsed.neighbors ? p.parsed.neighbors.find(n => n.pci === p.a3_sc) : null;
                activeRows.push({ type: '3rd Active', name: a3Res.name, cellId: a3Res.id, sc: p.a3_sc, rscp: p.a3_rscp || (nA3 ? nA3.rscp : '-'), ecno: nA3 ? nA3.ecno : '-', freq: sFreq || '-' });
            }
            // Detected/Neighbor rows
            let otherRows = [];
            if (p.parsed && p.parsed.neighbors) {
                const activeSCs = [p.sc, p.a2_sc, p.a3_sc].filter(x => x !== undefined && x !== null);
                p.parsed.neighbors.forEach((n, idx) => {
                    const nRes = resolveNeighbor(n.pci, n.cellId, n.freq);
                    const type = n.type === 'detected' ? `D${n.idx || (idx + 1)}` : `N${idx + 1}`;
                    if (n.type === 'detected' || !activeSCs.includes(n.pci)) {
                        otherRows.push({ type: type, name: nRes.name, cellId: nRes.id, sc: n.pci, rscp: n.rscp, ecno: n.ecno, freq: n.freq });
                    }
                });
            }

            const renderRow = (d, bold = false) => `
                <tr style="border-bottom:1px solid #ccc; ${bold ? 'font-weight:bold;' : ''}">
                    <td>${d.type}</td><td>${d.name} (${formatId(d.cellId || '-')})</td><td align="right">${d.sc || ''}</td><td align="right">${safeVal(d.rscp)}</td><td align="right">${safeVal(d.ecno)}</td><td align="right">${d.freq}</td>
                </tr>`;

            const rowsHtml = renderRow(servingData, true) + activeRows.map(r => renderRow(r)).join('') + otherRows.map(r => renderRow(r)).join('');

            const desc = `
                <div style="font-family:sans-serif; width:400px; font-size:12px;">
                    <div style="font-weight:bold; font-size:14px; color:#22c55e;">${servingData.name}</div>
                    <div style="color:#555;">Time: ${p.time || 'N/A'} (Lat:${Number(p.lat).toFixed(5)}, Lng:${Number(p.lng).toFixed(5)})</div>
                    <table style="width:100%; border-collapse:collapse; font-size:11px; margin-top:5px;">
                        <tr style="background:#f3f4f6;"><th align="left">Type</th><th align="left">Cell</th><th>SC</th><th>RSCP</th><th>EcNo</th><th>Freq</th></tr>
                        ${rowsHtml}
                    </table>
                </div>`;

            // Geometry (Spider Line)
            let geometry = `<Point><coordinates>${p.lng},${p.lat},0</coordinates></Point>`;
            if (window.resolveSmartSite) {
                const res = window.resolveSmartSite(p);
                if (res && res.lat && res.lng && res.site) {
                    const tipLat = res.lat, tipLng = res.lng; // Simplified for brevity, assume direct line logic matches
                    geometry = `<MultiGeometry><Point><coordinates>${p.lng},${p.lat},0</coordinates></Point><LineString><coordinates>${p.lng},${p.lat},0 ${tipLng},${tipLat},0</coordinates></LineString></MultiGeometry>`;
                }
            }

            // DETERMINE GROUP FOLDER
            let groupName = 'Others';
            if (thresholds && val !== undefined && val !== null && val !== 'N/A') {
                for (const t of thresholds) {
                    if ((t.min === undefined || val > t.min) && (t.max === undefined || val <= t.max)) {
                        groupName = t.label;
                        break;
                    }
                }
            } else if (val !== undefined && val !== null && val !== '') {
                // Discrete grouping (e.g. SC, PCI)
                groupName = String(val);
            }

            if (!groups.has(groupName)) groups.set(groupName, []);
            groups.get(groupName).push(`    <Placemark>
      <name></name>
      <description><![CDATA[${desc}]]></description>
      <styleUrl>#sm_${styleId}</styleUrl>
${geometry}
    </Placemark>`);
        });

        // Add Style Definitions
        styles.forEach(s => {
            // ... (Style definitions same as before) ...
            kml += `    <Style id="${s.id}_normal">
      <IconStyle><color>${s.color}</color><scale>1.2</scale><Icon><href>http://maps.google.com/mapfiles/kml/shapes/shaded_dot.png</href></Icon></IconStyle>
      <LabelStyle><scale>0</scale></LabelStyle><LineStyle><color>${s.color}</color><width>0</width></LineStyle>
    </Style>
    <Style id="${s.id}_highlight">
      <IconStyle><color>${s.color}</color><scale>1.2</scale><Icon><href>http://maps.google.com/mapfiles/kml/shapes/shaded_dot.png</href></Icon></IconStyle>
      <LabelStyle><scale>0</scale></LabelStyle><LineStyle><color>${s.color}</color><width>4</width></LineStyle>
    </Style>
    <StyleMap id="sm_${s.id}">
      <Pair><key>normal</key><styleUrl>#${s.id}_normal</styleUrl></Pair>
      <Pair><key>highlight</key><styleUrl>#${s.id}_highlight</styleUrl></Pair>
    </StyleMap>\n`;
        });

        // Add Folders
        // Sort keys for better organization (optional but nice)
        const sortedKeys = Array.from(groups.keys()).sort();

        // If using thresholds, we might want to sort by strict order (Excellent -> Bad)
        // But map iteration order + string sort is better than nothing.
        // If these are labels like "Excellent (> -70)", alphabetical might be weird ("Bad" comes before "Excellent"?)
        // Let's rely on insertion order if possible, or leave basic sort.
        // Actually, for thresholds, iterating the 'thresholds' array to pick keys would be best order.

        let orderedKeys = sortedKeys;
        if (thresholds) {
            const tLabels = thresholds.map(t => t.label);
            const others = sortedKeys.filter(k => !tLabels.includes(k));
            orderedKeys = [...tLabels.filter(k => groups.has(k)), ...others];
        }

        // XML Escaping Helper
        const escapeXml = (unsafe) => {
            if (typeof unsafe !== 'string') return unsafe;
            return unsafe.replace(/[<>&'"]/g, (c) => {
                switch (c) {
                    case '<': return '&lt;';
                    case '>': return '&gt;';
                    case '&': return '&amp;';
                    case '\'': return '&apos;';
                    case '"': return '&quot;';
                }
            });
        };

        orderedKeys.forEach(key => {
            const content = groups.get(key);
            if (content && content.length > 0) {
                kml += `    <Folder>\n      <name>${escapeXml(key)}</name>\n`;
                kml += content.join('\n');
                kml += `\n    </Folder>\n`;
            }
        });

        kml += '\n  </Document>\n</kml>';

        return kml;
    }
    // Unified Export: Points + Relevant Sites
    exportUnifiedKML(logPoints, metricName) {
        if (!logPoints || logPoints.length === 0) {
            console.warn("No points to export.");
            return;
        }

        // XML Escaping Helper
        const escapeXml = (unsafe) => {
            if (unsafe === undefined || unsafe === null) return '';
            // Strip control characters which are invalid in XML 1.0 (except \t, \n, \r)
            const clean = String(unsafe).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
            return clean.replace(/[<>&'"]/g, (c) => {
                switch (c) {
                    case '<': return '&lt;';
                    case '>': return '&gt;';
                    case '&': return '&amp;';
                    case '\'': return '&apos;';
                    case '"': return '&quot;';
                }
            });
        };

        // 1. Generate Points KML Parts (Now Returns Points & Lines Separately)
        const pointData = this._generatePointsKMLParts(logPoints, metricName);

        // 2. Generate Sites KML Parts
        const siteData = this._generateSitesKMLParts(logPoints);

        // 4. Construct KML
        const timeStr = new Date().toLocaleTimeString();
        let kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2">
  <Document>
    <name>${escapeXml(metricName.toUpperCase())} Analysis (Unified) - ${timeStr}</name>
    <open>1</open>

    <Style id="poly_s"><LineStyle><color>ff000000</color><width>1</width></LineStyle><PolyStyle><fill>0</fill></PolyStyle></Style>

    <!-- STYLES -->
    ${pointData.styles.map(s => s.xml).join('')}
    ${siteData.styles.map(s => s.xml).join('')}

    <!-- SITES FOLDER (Includes Interactive Spider Lines) -->
    <Folder>
      <name>Sites (Serving)</name>
      ${siteData.placemarks.join('\n')}
    </Folder>

    <!-- LOG POINTS FOLDER -->
    <Folder>
      <name>Log Points</name>
      ${pointData.pointFolders}
    </Folder>

    <!-- SPIDER LINES FOLDER (Persistent Visibility via Sidebar) -->
    <Folder>
      <name>Spider Lines Points</name>
      <visibility>0</visibility>
      <open>0</open>
      ${pointData.lineFolders}
    </Folder>
  </Document>
</kml>`;

        //     <name>Spider Lines Points</name>
        //     <visibility>0</visibility>
        //     ${pointData.lineFolders}
        //   </Folder>
        // </Document>
        // </kml>`;
        //
        // this.downloadFile(kml, `Data_Export_${metricName}.kml`);

        // Return KML string so app.js can handle download with proper filename (log name)
        return kml;
    }

    // Restored exportSitesToKML for the "Export Sites" button
    exportSitesToKML(logPoints, defaultColor) {
        // Reuse the unified generation logic for consistent styling/hierarchy
        const siteData = this._generateSitesKMLParts(logPoints);

        if (!siteData.placemarks || siteData.placemarks.length === 0) {
            console.warn("No sites to export.");
            return "";
        }

        const escapeXml = (unsafe) => {
            if (unsafe === undefined || unsafe === null) return '';
            const clean = String(unsafe).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
            return clean.replace(/[<>&'"]/g, (c) => {
                switch (c) {
                    case '<': return '&lt;';
                    case '>': return '&gt;';
                    case '&': return '&amp;';
                    case '\'': return '&apos;';
                    case '"': return '&quot;';
                }
            });
        };

        const timeStr = new Date().toLocaleTimeString();
        let kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>Sites Export - ${timeStr}</name>
    <open>1</open>
    <Style id="folder_style_hidden"><ListStyle><listItemType>checkHideChildren</listItemType></ListStyle></Style>

    <!-- STYLES -->
    ${siteData.styles.map(s => s.xml).join('')}

    <!-- SITES FOLDER -->
    <Folder>
      <name>Sites (Serving)</name>
      ${siteData.placemarks.join('\n')}
    </Folder>
  </Document>
</kml>`;

        return kml;
    }

    // internal helper for points refactored from exportToKML
    _generatePointsKMLParts(logPoints, metricName) {
        // ... (Logic from exportToKML but returning { styles: [{id, xml}], folders: string }) ...
        // COPYING LOGIC FROM exportToKML (Simplified for brevity in thought process, full in code)

        const settings = this.siteSettings || {};
        const range = parseInt(settings.range) || 100;
        const rad = Math.PI / 180;
        const pointGroups = new Map();
        const lineGroups = new Map();
        const styles = new Set();
        const styleDefs = [];

        const escapeXml = (unsafe) => {
            if (typeof unsafe !== 'string') return unsafe;
            // Strip control chars (0-31), allowing 9 (\t), 10 (\n), 13 (\r).
            const clean = unsafe.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
            return clean.replace(/[<>&'"]/g, (c) => {
                switch (c) {
                    case '<': return '&lt;'; case '>': return '&gt;'; case '&': return '&amp;'; case '\'': return '&apos;'; case '"': return '&quot;';
                }
            });
        };

        const hexToKmlColor = (hex) => {
            if (!hex || hex[0] !== '#') return 'ffcccccc';
            return 'ff' + hex.substring(5, 7) + hex.substring(3, 5) + hex.substring(1, 3);
        };

        let thresholds = null;
        if (window.getThresholdKey && window.themeConfig) {
            const rangeKey = window.getThresholdKey(metricName);
            if (rangeKey && window.themeConfig.thresholds[rangeKey]) thresholds = window.themeConfig.thresholds[rangeKey];
        }

        logPoints.forEach(p => {
            if (p.lat === undefined || p.lng === undefined) return;
            const val = this.getMetricValue(p, metricName);
            const color = this.getColor(val, metricName);
            // Sanitize ID to ensure it's a valid XML Name (no parens, spaces, etc from rgb() strings)
            const styleId = 's_' + color.replace(/[^a-zA-Z0-9]/g, '');

            if (!styles.has(styleId)) {
                styles.add(styleId);
                const kColor = hexToKmlColor(color);
                const kPolyColor = '7f' + kColor.substring(2); // 50% Opacity for Polygon Fill
                styleDefs.push({
                    id: styleId, xml: `
    <Style id="${styleId}_normal">
        <BalloonStyle><bgColor>991a1a1a</bgColor><text><![CDATA[<font color="#ffffff">$[description]</font>]]></text></BalloonStyle>
        <IconStyle><color>${kColor}</color><scale>1.2</scale><Icon><href>http://maps.google.com/mapfiles/kml/shapes/shaded_dot.png</href></Icon></IconStyle>
        <LabelStyle><scale>0</scale></LabelStyle>
        <LineStyle><color>${kColor}</color><width>0</width></LineStyle>
        <PolyStyle><color>${kPolyColor}</color><outline>0</outline><fill>1</fill></PolyStyle>
    </Style>
    <Style id="${styleId}_highlight">
        <BalloonStyle><bgColor>991a1a1a</bgColor><text><![CDATA[<font color="#ffffff">$[description]</font>]]></text></BalloonStyle>
        <IconStyle><color>${kColor}</color><scale>1.2</scale><Icon><href>http://maps.google.com/mapfiles/kml/shapes/shaded_dot.png</href></Icon></IconStyle>
        <LabelStyle><scale>0</scale></LabelStyle>
        <LineStyle><color>${kColor}</color><width>4</width></LineStyle>
        <PolyStyle><color>${kPolyColor}</color><outline>1</outline><fill>1</fill></PolyStyle>
    </Style>
    <StyleMap id="sm_${styleId}"><Pair><key>normal</key><styleUrl>#${styleId}_normal</styleUrl></Pair><Pair><key>highlight</key><styleUrl>#${styleId}_highlight</styleUrl></Pair></StyleMap>\n`
                });
            }

            // Grouping Logic
            let groupName = 'Others';
            if (thresholds && val !== undefined && val !== null && val !== 'N/A') {
                for (const t of thresholds) {
                    if ((t.min === undefined || val > t.min) && (t.max === undefined || val <= t.max)) { groupName = t.label; break; }
                }
            } else if (val !== undefined && val !== null && val !== '') { groupName = String(val); }

            // Geometry logic
            let geometryPoint = `<Point><coordinates>${p.lng},${p.lat},0</coordinates></Point>`;
            let geometryPoly = null;

            // Check for Polygon Geometry (Grid)
            if (p.geometry && (p.geometry.type === 'Polygon' || p.geometry.type === 'MultiPolygon')) {
                try {
                    let coords = p.geometry.coordinates;
                    // Unwrap MultiPolygon
                    if (p.geometry.type === 'MultiPolygon') coords = coords[0];
                    // Unwrap Polygon Ring
                    if (Array.isArray(coords[0]) && Array.isArray(coords[0][0])) coords = coords[0];

                    // Build LinearRing String matching KML format: lng,lat,0 lng,lat,0 ...
                    const coordStr = coords.map(c => `${c[0]},${c[1]},0`).join(' ');

                    geometryPoly = `<Polygon>
                        <outerBoundaryIs>
                            <LinearRing>
                                <coordinates>${coordStr}</coordinates>
                            </LinearRing>
                        </outerBoundaryIs>
                    </Polygon>`;
                } catch (e) {
                    console.warn("Failed to generate KML Polygon:", e);
                }
            }

            let geometryLine = null;
            let lineStyleId = null;
            let sectorGroupName = null;

            if (window.resolveSmartSite) {
                const res = window.resolveSmartSite(p);
                if (res && res.lat && res.lng && res.site) {
                    // Spider Line (To Sector Tip)
                    const s = res.site;
                    const az = parseFloat(s.beam || s.azimuth || 0);
                    const aRad = az * rad;
                    // Calculate Tip Offset
                    const tDy = Math.cos(aRad) * range;
                    const tDx = Math.sin(aRad) * range;
                    const tLat = s.lat + (tDy / 111111);
                    const tLng = s.lng + (tDx / (111111 * Math.cos(s.lat * rad)));

                    geometryLine = `<LineString><coordinates>${p.lng},${p.lat},0 ${tLng.toFixed(6)},${tLat.toFixed(6)},0</coordinates></LineString>`;
                    sectorGroupName = s.cellName || s.name || s.siteName || `Sector ${s.cellId || s.cid || 'Unknown'}`;

                    // COLOR SYNC: Use Serving Site Color for Spider Line
                    let sId = s.cellId; // Or cid logic
                    if (this.activeMetricStats) { // Quick check if we have active stats logic available
                        const activeIds = new Set(this.activeMetricStats.keys());
                        if (activeIds.has(String(s.cid))) sId = s.cid;
                        else if (activeIds.has(String(s.cellId))) sId = s.cellId;
                    }
                    const siteColor = this.getDiscreteColor(sId);
                    const safeLineColorSuffix = siteColor.replace(/[^a-zA-Z0-9]/g, '');
                    lineStyleId = 'spider_s_' + safeLineColorSuffix;

                    // Add Line Style if missing
                    if (!styles.has(lineStyleId)) {
                        styles.add(lineStyleId);
                        const kLineColor = hexToKmlColor(siteColor);
                        // Simple Line Style
                        styleDefs.push({
                            id: lineStyleId, xml: `
        <Style id="${lineStyleId}"><LineStyle><color>${kLineColor}</color><width>2</width></LineStyle><PolyStyle><fill>0</fill></PolyStyle></Style>\n`
                        });
                    }
                }
            }

            // RICH HTML DESCRIPTION GENERATOR (MATCHING WEB APP STYLE)
            const genDesc = () => {
                // Resolved Serving Name for Header
                const getName = (searchPci, searchId, searchFreq) => {
                    if (window.resolveSmartSite) {
                        const res = window.resolveSmartSite({
                            sc: searchPci,
                            cellId: searchId,
                            freq: searchFreq,
                            lat: p.lat,
                            lng: p.lng
                        });
                        return res.name;
                    }
                    return null;
                };

                const s = p.parsed && p.parsed.serving ? p.parsed.serving : {};
                const sId = p.cellId || s.cellId;
                const sSc = p.sc ?? s.sc ?? s.pci;
                const sRscp = p.level ?? p.rscp ?? s.level ?? s.rscp;
                const sEcno = p.ecno ?? s.ecno;
                const sFreq = p.freq ?? s.freq;

                // Format ID
                let sIdStr = sId;
                if (sId && sId > 65535 && !String(sId).includes('/')) {
                    sIdStr = `${sId >> 16}/${sId & 0xFFFF}`;
                }

                const sNameRes = getName(sSc, sId, sFreq);
                const tableServingName = sNameRes ? `${sNameRes} <span style="color:#888; font-weight:normal;">(${sIdStr || '-'})</span>` : `Unknown <span style="color:#888; font-weight:normal;">(${sIdStr || '-'})</span>`;
                // Header Serving Name (Plain text)
                const headerServingName = sNameRes || `Unknown`;

                // Main Container (Dark Theme #1e1e1e)
                // Use inline-block + min-width to allow expansion for long labels while ensuring base width
                let html = `<div style="padding:2px; display:inline-block;"><div style="min-width:450px; font-family:'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; font-size:12px; background:#1e1e1e; color:#e5e5e5; padding:0; border-radius:6px; overflow:visible; box-shadow: 0 4px 12px rgba(0,0,0,0.3); text-align:left;">`;

                // 1. "Window" Header
                html += `<div style="padding:8px 12px; background:#2d2d2d; font-weight:bold; font-size:13px; border-bottom:1px solid #333;">Point Details</div>`;

                // 2. Info Block (Serving Name Big + Meta)
                html += `<div style="padding:12px;">
                            <div style="font-size:16px; font-weight:bold; color:#22c55e; margin-bottom:4px;">${headerServingName}</div>
                            <div style="display:flex; justify-content:space-between; color:#888; font-size:11px; margin-bottom:15px;">
                                <span>Lat: ${p.lat.toFixed(6)} &nbsp; Lng: ${p.lng.toFixed(6)}</span>
                                <span>${p.time}</span>
                            </div>
                `;

                // 3. Table
                html += `<table style="width:100%; border-collapse:collapse; font-size:11px; table-layout:auto;">
                            <thead>
                                <tr style="color:#888; border-bottom:1px solid #444;">
                                    <th style="text-align:left; padding:6px; font-weight:600;">Type</th>
                                    <th style="text-align:left; padding:6px; font-weight:600;">Cell Name</th>
                                    <th style="text-align:right; padding:6px; font-weight:600;">SC</th>
                                    <th style="text-align:right; padding:6px; font-weight:600;">RSCP</th>
                                    <th style="text-align:right; padding:6px; font-weight:600;">EcNo</th>
                                    <th style="text-align:right; padding:6px; font-weight:600;">Freq</th>
                                </tr>
                            </thead>
                            <tbody>`;

                const row = (type, nameHtml, sc, rscp, ecno, freq, isBold = false) => {
                    const rowStyle = `border-bottom:1px solid #333; ${isBold ? 'font-weight:bold; color:#fff;' : 'color:#ccc;'}`;
                    return `<tr style="${rowStyle}">
                                <td style="padding:6px; white-space:nowrap;">${type}</td>
                                <td style="padding:6px; max-width:300px; overflow-wrap:anywhere;">${nameHtml}</td>
                                <td style="padding:6px; text-align:right;">${sc || '-'}</td>
                                <td style="padding:6px; text-align:right;">${rscp || '-'}</td>
                                <td style="padding:6px; text-align:right;">${ecno || '-'}</td>
                                <td style="padding:6px; text-align:right;">${freq || '-'}</td>
                            </tr>`;
                };

                // Serving Row
                html += row('Serving', tableServingName, sSc, sRscp, sEcno, sFreq, true);

                // Active Set
                if (p.a2_sc !== undefined && p.a2_sc !== null && p.a2_sc !== '') {
                    const name = getName(p.a2_sc, p.a2_cellid, sFreq);
                    const label = name ? `${name} <span style="color:#888; font-weight:normal;">(${p.a2_cellid || '-'})</span>` : (p.a2_cellid || p.a2_sc);
                    html += row('Active 2', label, p.a2_sc, p.a2_rscp, '-', sFreq);
                }
                if (p.a3_sc !== undefined && p.a3_sc !== null && p.a3_sc !== '') {
                    const name = getName(p.a3_sc, p.a3_cellid, sFreq);
                    const label = name ? `${name} <span style="color:#888; font-weight:normal;">(${p.a3_cellid || '-'})</span>` : (p.a3_cellid || p.a3_sc);
                    html += row('Active 3', label, p.a3_sc, p.a3_rscp, '-', sFreq);
                }

                // Neighbors
                if (p.parsed && p.parsed.neighbors && p.parsed.neighbors.length > 0) {
                    p.parsed.neighbors.forEach((n, i) => {
                        const name = getName(n.pci, null, n.freq);
                        const label = name || 'Unknown';
                        html += row(`N${i + 1}`, label, n.pci, n.rscp, n.ecno, n.freq);
                    });
                }

                html += `   </tbody>
                        </table>
                    </div></div>`; // Close Main Container and Wrapper
                return html;
            };

            const desc = `<![CDATA[${genDesc()}]]>`;

            // NOTE: The previous `exportToKML` had a massive HTML table generator.
            // I should probably extract that generator if I want to persist it, or just simplify here.
            // Given the user wants "dots colored... export... import serving sectors", the table is likely secondary, 
            // but degrading it is bad.
            // I will use a simplified description for the Unified export to avoid massive code dupe, 
            // unless I refactor `renderRow` out. 
            // Let's stick to simple extraction for now.

            if (!pointGroups.has(groupName)) pointGroups.set(groupName, []);

            // Build Placemark content
            let placemarkGeo = geometryPoint;
            if (geometryPoly) {
                placemarkGeo = geometryPoly; // PREFER POLYGON IF AVAILABLE
            }

            // If Spider Line exists, wrap in MultiGeometry
            if (geometryLine) {
                placemarkGeo = `<MultiGeometry>${placemarkGeo}${geometryLine}</MultiGeometry>`;
            }

            pointGroups.get(groupName).push(`    <Placemark><name>Point ${p.id || ''}</name><description>${desc}</description><styleUrl>#sm_${styleId}</styleUrl>${placemarkGeo}</Placemark>`);


            // Permanent Line Placemark (For persistent visibility via Sidebar) (Hidden Logic remains same)
            if (geometryLine && lineStyleId) {
                const lgName = sectorGroupName || 'Others';
                // Create a deterministic unique ID for the Group Placemark (we need a way to target it)
                // Since there can be multiple lines per group, we might need a Folder-level targeting or just the first line.
                // KML links target IDs.
                // Let's rely on the Folder structure or give lines specific IDs.
                // Better strategy: The user wants to "check the visibility".
                // We can't auto-check. But we can link to them.

                if (!lineGroups.has(lgName)) lineGroups.set(lgName, []);

                // Assign a unique ID to the FIRST line in this group so we can link to it.
                // We check if the group is empty (this is the first push).
                let placemarkIdAttr = '';
                if (lineGroups.get(lgName).length === 0) {
                    const safeTargetId = 'target_' + lgName.replace(/[^a-zA-Z0-9]/g, '');
                    placemarkIdAttr = ` id = "${safeTargetId}"`;
                }

                // We'll give the ID to the Placemark of the line.
                // Since a group has multiple lines, we can't link to "The Group" easily unless we define the Folder ID, which buildFolders generates dynamically.
                // Simplified approach: Just ensure the lines have IDs if we want to link specific ones, but here we want the "Sector".
                // Since we returned to "Grouped by Sector", the Folder is the container.
                // We can't easily ID the generated Folder string.

                // Let's stick to the limitation explanation first, but for now just restore the raw lines.
                lineGroups.get(lgName).push(`    <Placemark${placemarkIdAttr}><name></name><description>${desc}</description><styleUrl>#${lineStyleId}</styleUrl>${geometryLine}</Placemark>`);
            }
        });

        const buildFolders = (groupMap) => {
            let res = '';
            const sortedKeys = Array.from(groupMap.keys()).sort();
            let orderedKeys = sortedKeys;
            if (thresholds) {
                const tLabels = thresholds.map(t => t.label);
                const others = sortedKeys.filter(k => !tLabels.includes(k));
                orderedKeys = [...tLabels.filter(k => groupMap.has(k)), ...others];
            }
            orderedKeys.forEach(k => {
                const safeId = 'folder_' + k.replace(/[^a-zA-Z0-9]/g, '');
                // For Spider Lines Point folders, we want them unchecked by default too
                const isSpiderLineFolder = (groupMap === lineGroups);
                const visibilityTag = (isSpiderLineFolder || k.toString().trim() === 'Connection Lines') ? '<visibility>0</visibility><open>0</open><styleUrl>#folder_style_hidden</styleUrl>\n' : '';
                res += `    <Folder id="${safeId}">\n      <name>${escapeXml(k)}</name>\n${visibilityTag}` + groupMap.get(k).join('\n') + `\n    </Folder>\n`;
            });
            return res;
        };

        return { styles: styleDefs, pointFolders: buildFolders(pointGroups), lineFolders: buildFolders(lineGroups) };
    }

    // internal helper for sites
    _generateSitesKMLParts(logPoints) {
        if (!this.siteIndex || !this.siteIndex.all) return { styles: [], placemarks: [] };

        const settings = this.siteSettings || {};
        const range = parseInt(settings.range) || 100;
        const beam = parseInt(settings.beamwidth) || 35;
        const rad = Math.PI / 180;

        // Thresholds reused for coloring logic if needed, but we used getDiscreteColor
        // We need to know 'groupName' (Metric Label) for each point to group lines by ColorName
        const metricName = this.activeMetric || 'RSCP';
        const thresholds = (this.thresholds && this.thresholds[metricName]) || null;

        const getGroupName = (val) => {
            if (thresholds && val !== undefined && val !== null && val !== 'N/A') {
                for (const t of thresholds) {
                    if ((t.min === undefined || val > t.min) && (t.max === undefined || val <= t.max)) return t.label;
                }
            }
            return 'Connection Lines';
        };

        const escapeXml = (unsafe) => {
            if (unsafe === undefined) return '';
            const clean = String(unsafe).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
            return clean.replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '\'': '&apos;', '"': '&quot;' }[c]));
        };
        const hexToKmlColor = (hex) => {
            if (!hex || hex[0] !== '#') return '99cccccc';
            return 'cc' + hex.substring(5, 7) + hex.substring(3, 5) + hex.substring(1, 3);
        };

        const styles = new Set();
        const styleDefs = [];
        const placemarks = []; // Now returns Folders strings

        // 1. Map Points to Sites and Groups
        // Structure: siteUniqueKey -> Map(groupName -> [Line XML])
        const siteLines = new Map();
        const relevantSiteIds = new Set();

        if (logPoints && window.resolveSmartSite) {
            logPoints.forEach(p => {
                const res = window.resolveSmartSite(p);
                if (res && res.id && res.site && res.lat && res.lng) {
                    relevantSiteIds.add(String(res.id));
                    if (p.lat !== undefined && p.lng !== undefined) {
                        // Build Line Geometry
                        const s = res.site;
                        const sKey = `${s.lat}_${s.lng}_${s.cellName || s.name || s.siteName || `Sector ${s.cellId || s.cid || 'Unknown'}`} `; // Sync Key

                        const az = parseFloat(s.beam || s.azimuth || 0);
                        const aRad = az * rad;
                        const tDy = Math.cos(aRad) * range;
                        const tDx = Math.sin(aRad) * range;
                        const tLat = s.lat + (tDy / 111111);
                        const tLng = s.lng + (tDx / (111111 * Math.cos(s.lat * rad)));

                        // Style for Line (Based on Serving Site Color, same as before)
                        let sId = s.cellId;
                        if (this.activeMetricStats) {
                            const activeIds = new Set(this.activeMetricStats.keys());
                            if (activeIds.has(String(s.cid))) sId = s.cid;
                            else if (activeIds.has(String(s.cellId))) sId = s.cellId;
                        }
                        const siteColor = this.getDiscreteColor(sId);
                        const safeLineColorSuffix = siteColor.replace(/[^a-zA-Z0-9]/g, '');
                        const lineStyleId = 'spider_s_' + safeLineColorSuffix;

                        if (!styles.has(lineStyleId)) {
                            styles.add(lineStyleId);
                            const kLineColor = hexToKmlColor(siteColor);
                            styleDefs.push({ id: lineStyleId, xml: `<Style id="${lineStyleId}"><LineStyle><color>${kLineColor}</color><width>2</width></LineStyle><PolyStyle><fill>0</fill></PolyStyle></Style>\n` });
                        }

                        // Add shared folder style for Connection Lines (checkHideChildren)
                        if (!styles.has('folder_style_hidden')) {
                            styles.add('folder_style_hidden');
                            styleDefs.push({ id: 'folder_style_hidden', xml: `<Style id="folder_style_hidden"><ListStyle><listItemType>checkHideChildren</listItemType></ListStyle></Style>\n` });
                        }

                        // Determine Group for this specific point (for Line Grouping)
                        let val = p[metricName];
                        if (val === undefined && p.parsed && p.parsed.serving) val = p.parsed.serving[metricName.toLowerCase()];
                        const gName = getGroupName(val);

                        const lineXml = `<Placemark><name></name><styleUrl>#${lineStyleId}</styleUrl><LineString><coordinates>${p.lng},${p.lat},0 ${tLng.toFixed(6)},${tLat.toFixed(6)},0</coordinates></LineString></Placemark>`;

                        if (!siteLines.has(sKey)) siteLines.set(sKey, new Map());
                        if (!siteLines.get(sKey).has(gName)) siteLines.get(sKey).set(gName, []);
                        siteLines.get(sKey).get(gName).push(lineXml);
                    }
                }
            });
        }

        const activeIds = new Set(this.activeMetricStats ? this.activeMetricStats.keys() : []);
        const labeledSites = new Set();

        this.siteIndex.all.forEach(s => {
            if (s.lat === undefined || s.lng === undefined) return;

            // Strict Filter
            const sIdFull = String(s.cellId);
            const sIdCid = String(s.cid);
            if (relevantSiteIds.size > 0 && !relevantSiteIds.has(sIdFull) && !relevantSiteIds.has(sIdCid)) return;

            // Geometry (Wedge)
            const azimuth = parseFloat(s.beam || s.azimuth || 0);
            const startAngle = (azimuth - beam / 2) * rad;
            const endAngle = (azimuth + beam / 2) * rad;
            const latRad = s.lat * rad;
            const coords = [`${s.lng},${s.lat},0`];
            for (let i = 0; i <= 10; i++) {
                const a = startAngle + (endAngle - startAngle) * (i / 10);
                const dy = Math.cos(a) * range;
                const dx = Math.sin(a) * range;
                const dLat = dy / 111111;
                const dLng = dx / (111111 * Math.cos(latRad));
                coords.push(`${s.lng + dLng},${s.lat + dLat},0`);
            }
            coords.push(`${s.lng},${s.lat},0`);

            // Color Sync
            let id = s.cellId;
            if (activeIds.has(String(s.cid))) id = s.cid;
            else if (activeIds.has(String(s.cellId))) id = s.cellId;

            const color = this.getDiscreteColor(id);
            // Sanitize ID
            const safeColorSuffix = color.replace(/[^a-zA-Z0-9]/g, '');
            const styleId = 'site_s_' + safeColorSuffix;

            // Define StyleMap (Hover Effect)
            if (!styles.has(styleId)) {
                styles.add(styleId);
                const kColor = hexToKmlColor(color);
                // Revert to simple style (No StyleMap needed for Folder grouping)
                styleDefs.push({ id: styleId, xml: `<Style id="${styleId}"><LineStyle><color>ff000000</color><width>1</width></LineStyle><PolyStyle><color>${kColor}</color><fill>1</fill><outline>1</outline></PolyStyle><IconStyle><scale>0</scale></IconStyle><LabelStyle><scale>1.1</scale></LabelStyle></Style>\n` });
            }

            const siteName = s.cellName || s.name || s.siteName || `Sector ${s.cellId || s.cid || 'Unknown'} `;
            const siteUniqueKey = `${s.lat}_${s.lng}_${siteName} `;

            // Site Wedge Placemark
            const wedgeXml = `<Placemark><name>${escapeXml(siteName)}</name><styleUrl>#${styleId}</styleUrl><Polygon><outerBoundaryIs><LinearRing><coordinates>${coords.join(' ')}</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>`;

            // Generate Sector Folder
            let sectorContent = wedgeXml + '\n';

            // Add Line Groups if they exist
            if (siteLines.has(siteUniqueKey)) {
                const groups = siteLines.get(siteUniqueKey);
                // Sort groups? or just iterate
                groups.forEach((lines, gName) => {
                    const isSpider = gName.toString().trim() === 'Connection Lines';
                    // Applying styleUrl to folder for checkHideChildren behavior
                    const visibilityXml = isSpider ? '<visibility>0</visibility><open>0</open><styleUrl>#folder_style_hidden</styleUrl>' : '';

                    sectorContent += `      <Folder>\n        <name>${escapeXml(gName)}</name>\n${visibilityXml}` + lines.join('\n') + `\n      </Folder>\n`;
                });
            }

            // Create Sector Folder
            placemarks.push(`    <Folder>\n      <name>${escapeXml(siteName)}</name>\n${sectorContent}    </Folder>`);
        });

        return { styles: styleDefs, placemarks: placemarks };
    }
    toggleSmoothing(enable) {
        // Apply Blur to sitesPane (Shared Canvas)
        // Note: This blurs both Grids and Sites, but ensures Interactivity works in Sharp mode.
        const panes = [this.map.getPane('sitesPane'), this.map.getPane('logPointsPane')].filter(Boolean);
        panes.forEach((pane) => {
            pane.style.transition = 'filter 0.3s ease';
            pane.style.filter = enable ? 'blur(8px)' : 'none';
        });
        if (panes.length) {
            console.log(`[MapRenderer] Grid Interpolation (Smoothing) ${enable ? 'ENABLED' : 'DISABLED'}`);
        }

        if (this.heatLayer) {
            this.map.removeLayer(this.heatLayer);
            this.heatLayer = null;
        }
    }

    // Toggle Boundary Layers (Regions, Provinces, Communes)
    // type: 'regions', 'provinces', 'communes'
    async toggleBoundary(type, visible) {
        if (!this.boundaryLayers) this.boundaryLayers = {};

        if (visible) {
            if (this.boundaryLayers[type]) {
                if (!this.map.hasLayer(this.boundaryLayers[type])) {
                    this.boundaryLayers[type].addTo(this.map);
                }
            } else {
                await this.loadBoundary(type);
            }
        } else {
            if (this.boundaryLayers[type] && this.map.hasLayer(this.boundaryLayers[type])) {
                this.map.removeLayer(this.boundaryLayers[type]);
            }
        }
    }

    async loadBoundary(type) {
        const basePath = 'boundaries_data'; // Symlink to avoid character encoding issues
        let url = '';
        let style = {};

        if (type === 'regions') {
            url = `${basePath}/DA_REGIONS_12R.zip`;
            style = { color: 'black', weight: 3, fill: false, opacity: 0.8 };
        } else if (type === 'provinces') {
            url = `${basePath}/DA_PROVINCES_12R.zip`;
            style = { color: '#333', weight: 1.5, fill: false, opacity: 0.7 };
        } else if (type === 'communes') {
            url = `${basePath}/DA_COMMUNES_12R.zip`;
            style = { color: '#666', weight: 0.5, dashArray: '4, 4', fill: false, opacity: 0.6 };
        } else if (type === 'drs') {
            // Special handling for DRs: Aggregate from Provinces
            await this.generateDRLayer();
            return;
        }

        console.log(`[MapRenderer] Loading boundary: ${type} from ${url}`);

        try {
            // shp(url) returns a promise that resolves to GeoJSON
            const geojson = await shp(url);

            const layer = L.geoJSON(geojson, {
                style: style,
                pane: 'labelsPane', // Use labelsPane (high z-index) so borders sit on top
                interactive: false  // Non-interactive to not block clicks on data below
            });

            this.boundaryLayers[type] = layer;
            layer.addTo(this.map);
            console.log(`[MapRenderer] Loaded ${type} successfully.`);

        } catch (e) {
            console.error(`[MapRenderer] Failed to load ${type}:`, e);
            alert(`Error loading ${type}:\nMake sure the .zip file exists in ${basePath}.\nDetails: ${e.message}`);
        }
    }

    // Filter DRs
    async filterDR(drName) {
        if (!drName) {
            // Remove if exists
            if (this.boundaryLayers['drs']) {
                this.map.removeLayer(this.boundaryLayers['drs']);
                delete this.boundaryLayers['drs'];
            }
            return;
        }
        await this.generateDRLayer(drName);
    }

    async generateDRLayer(filterDR = "All") {
        const basePath = 'boundaries_data';
        const url = `${basePath}/DA_PROVINCES_12R.zip`;

        // Mapping: Normalized Province Name -> DR Code
        // Corrections applied: FS->FES, MEKNS->MEKNES, TTOUAN->TETOUAN, etc.
        const PROVINCE_TO_DR_CODE = {
            "ALHOCEIMA": "DRT",
            "CHEFCHAOUEN": "DRT",
            "FAHSANJRA": "DRT",
            "LARACHE": "DRT",
            "OUEZZANE": "DRR",
            "TANGERASSILAH": "DRT",
            "TETOUAN": "DRT",
            "MDIQFNIDEQ": "DRT",
            "BERKANE": "DRO",
            "DRIOUCH": "DRO",
            "FIGUIG": "DRO",
            "GUERCIF": "DRO",
            "JERADA": "DRO",
            "NADOR": "DRO",
            "OUJDAANGAD": "DRO",
            "TAOURIRT": "DRO",
            "MEKNES": "DRF",
            "BOULEMANE": "DRF",
            "ELHAJEB": "DRF",
            "FES": "DRF",
            "IFRANE": "DRF",
            "SEFROU": "DRF",
            "TAOUNATE": "DRF",
            "TAZA": "DRF",
            "MOULAYYACOUB": "DRF",
            "KENITRA": "DRR",
            "KHEMISSET": "DRR",
            "RABAT": "DRR",
            "SALE": "DRR",
            "SIDIKACEM": "DRR",
            "SIDISLIMANE": "DRR",
            "SKHIRATETEMARA": "DRR",
            "AZILAL": "DRS",
            "BENIMELLAL": "DRS",
            "FQUIHBENSALAH": "DRS",
            "KHENIFRA": "DRF",
            "KHOURIBGA": "DRS",
            "BENSLIMANE": "DRS",
            "BERRECHID": "DRS",
            "CASABLANCA": "DRC",
            "ELJADIDA": "DRS",
            "MEDIUNA": "DRC",
            "MEDIOUNA": "DRC",
            "MDIOUNA": "DRC",
            "MOHAMMEDIA": "DRC",
            "MOHAMMADIA": "DRC",
            "NOUACEUR": "DRC",
            "MOHAMMEDIA": "DRC",
            "MOHAMMADIA": "DRC",
            "NOUACEUR": "DRC",
            "SETTAT": "DRS",
            "SIDIBENNOUR": "DRS",
            "ALHAOUZ": "DRM",
            "CHICHAOUA": "DRM",
            "ELKELAADESSRAGHNA": "DRM",
            "ESSAOUIRA": "DRM",
            "MARRAKECH": "DRM",
            "REHAMNA": "DRM",
            "SAFI": "DRM",
            "YOUSSOUFIA": "DRM",
            "ERRACHIDIA": "DRF",
            "MIDELT": "DRF",
            "OUARZAZATE": "DRM",
            "TINGHIR": "DRM",
            "ZAGORA": "DRM",
            "AGADIRIDAOUTANANE": "DRA",
            "CHTOUKAAITBAHA": "DRA",
            "INEZGANEAITMELLOUL": "DRA",
            "TAROUDANNT": "DRA",
            "TATA": "DRA",
            "TIZNIT": "DRA",
            "ASSAZAG": "DRA",
            "GUELMIM": "DRA",
            "SIDIIFNI": "DRA",
            "TANTAN": "DRA",
            "BOUJDOUR": "DRA",
            "ESSEMARA": "DRA",
            "LAAYOUNE": "DRA",
            "TARFAYA": "DRA",
            "AOUSSERD": "DRA",
            "OUEDEDDAHAB": "DRA"
        };

        // Map Codes to Readable Names (for UI and Coloring)
        const DR_CODE_MAP = {
            "DRT": "DR Tanger",
            "DRR": "DR Rabat",
            "DRO": "DR Oujda",
            "DRF": "DR Fes",
            "DRS": "DR Beni Mellal", // Covering Settat/Beni Mellal
            "DRC": "DR Casa",
            "DRM": "DR Marrakech",
            "DRA": "DR Agadir"     // Covering South
        };

        const DR_COLORS = {
            "DR Casa": "#e6194b", "DR Rabat": "#3cb44b", "DR Fes": "#ffe119", "DR Tanger": "#4363d8",
            "DR Marrakech": "#f58231", "DR Agadir": "#911eb4", "DR Oujda": "#46f0f0", "DR Beni Mellal": "#f032e6",
            "DR Errachidia": "#bcf60c", "DR Sud": "#fabebe", "Unknown": "#808080"
        };

        try {
            // Cache GeoJSON to avoid re-downloading/parsing
            if (!this.cachedProvinceGeoJSON) {
                console.log(`[MapRenderer] Fetching Provinces for DR generation...`);
                this.cachedProvinceGeoJSON = await shp(url);
            }

            const geojson = this.cachedProvinceGeoJSON;

            if (typeof turf === 'undefined') {
                console.error("[MapRenderer] Turf.js missing.");
                return;
            }

            const drFeatures = {};

            // Group by DRFeatures
            geojson.features.forEach(f => {
                let nameKey = 'NOM_PROV_P';
                if (!f.properties[nameKey]) {
                    nameKey = Object.keys(f.properties).find(k => k.toLowerCase().includes('nom') || k.toLowerCase().includes('name'));
                }

                const rawName = f.properties[nameKey] ? f.properties[nameKey].toString() : "UNKNOWN";

                // Robust Normalization: 
                // 1. Decompose accents (NFD) -> 'é' becomes 'e' + '´'
                // 2. Remove combining diacritical marks ([\u0300-\u036f])
                // 3. To Upper Case
                // 4. Remove non-A-Z characters
                const normName = rawName.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/[^A-Z]/g, '');

                const code = PROVINCE_TO_DR_CODE[normName];
                const dr = code ? (DR_CODE_MAP[code] || "Unknown") : "Unknown";

                if (dr === "Unknown") {
                    // Log unmapped provinces to help debug missing areas
                    if (!this.loggedUnmapped) this.loggedUnmapped = new Set();
                    if (!this.loggedUnmapped.has(rawName)) {
                        console.warn(`[MapRenderer] Unmapped Province: '${rawName}' -> Normalized: '${normName}'`);
                        this.loggedUnmapped.add(rawName);
                    }
                }

                // Filter logic
                if (filterDR === "All" || filterDR === dr) {
                    if (!drFeatures[dr]) drFeatures[dr] = [];
                    drFeatures[dr].push(f);
                }
            });

            // --- COMMUNE EXCEPTIONS ---
            // Move Bouznika, Charrate, El Mansouria from Benslimane (DRS) to Rabat (DRR)
            try {
                const exceptionCommunes = ["Bouznika", "Charrate", "El Mansouria"];

                // Only proceed if relevant DRs are active or filtering All
                const affectsRabat = (filterDR === "All" || filterDR === "DR Rabat");
                const affectsSource = (filterDR === "All" || filterDR === "DR Beni Mellal");

                if (affectsRabat || affectsSource) {
                    if (!this.cachedCommuneGeoJSON) {
                        console.log(`[MapRenderer] Fetching Communes for Exception logic from ${basePath}/DA_COMMUNES_12R.zip...`);
                        try {
                            this.cachedCommuneGeoJSON = await shp(`${basePath}/DA_COMMUNES_12R.zip`);
                            console.log(`[MapRenderer] Loaded Communes. Total Features: ${this.cachedCommuneGeoJSON.features.length}`);
                            if (this.cachedCommuneGeoJSON.features.length > 0) {
                                console.log("[MapRenderer] Sample Commune Props:", this.cachedCommuneGeoJSON.features[0].properties);
                            }
                        } catch (err) {
                            console.error("[MapRenderer] Failed to load Communes shapefile:", err);
                            this.cachedCommuneGeoJSON = { features: [] }; // Prevent retry loop failure
                        }
                    }
                    const commGeo = this.cachedCommuneGeoJSON;

                    // Find the 3 communes
                    const targets = commGeo.features.filter(f => {
                        const n = f.properties.NOM_COM_P || f.properties.NOM_COM || f.properties.Nom_Com || f.properties.Nom_Commun || f.properties.NAME || "";
                        // Loose match
                        const match = exceptionCommunes.some(t => n.toLowerCase().includes(t.toLowerCase()));
                        if (match) console.log(`[MapRenderer] Found target commune: ${n}`);
                        return match;
                    });

                    console.log(`[MapRenderer] Exception Communes found: ${targets.length} / ${exceptionCommunes.length}`);

                    if (targets.length > 0) {
                        console.log(`[MapRenderer] Found ${targets.length} exception communes to move.`);

                        // 1. Remove from Source (Benslimane in DR Beni Mellal)
                        // We need to find Benslimane in drFeatures['DR Beni Mellal']
                        // Benslimane norm name is BENSLIMANE

                        const sourceDR = "DR Beni Mellal"; // or wherever Benslimane is mapped
                        if (drFeatures[sourceDR]) {
                            const bensIndex = drFeatures[sourceDR].findIndex(f => {
                                const raw = f.properties.NOM_PROV_P || "";
                                return raw.toUpperCase().includes("BENSLIMANE");
                            });

                            if (bensIndex !== -1) {
                                let bensFeature = drFeatures[sourceDR][bensIndex];

                                // Difference: Benslimane - Union(Targets)
                                try {
                                    let toRemove = targets[0];
                                    if (targets.length > 1) {
                                        for (let i = 1; i < targets.length; i++) toRemove = turf.union(toRemove, targets[i]);
                                    }

                                    const newBens = turf.difference(bensFeature, toRemove);
                                    if (newBens) {
                                        // Update properties from original
                                        newBens.properties = bensFeature.properties;
                                        drFeatures[sourceDR][bensIndex] = newBens; // Replace
                                        console.log("[MapRenderer] Successfully subtracted communes from Benslimane.");
                                    }
                                } catch (err) {
                                    console.error("Error diffing communes from Benslimane", err);
                                }
                            }
                        }

                        // 2. Add to Target (DR Rabat)
                        if (drFeatures["DR Rabat"]) {
                            targets.forEach(t => drFeatures["DR Rabat"].push(t));
                        } else if (filterDR === "All" || filterDR === "DR Rabat") {
                            drFeatures["DR Rabat"] = targets;
                        }
                    }
                }
            } catch (ex) {
                console.error("[MapRenderer] Commune Exception Warning:", ex);
            }
            // --------------------------

            // Ensure storage exists
            if (!this.boundaryLayers) this.boundaryLayers = {};

            const finalFeatures = [];

            for (const [drName, features] of Object.entries(drFeatures)) {
                if (features.length > 0) {
                    if (filterDR !== "All" && drName !== filterDR) continue;
                    if (filterDR === "All" && drName === "Unknown") continue;

                    let merged = null;

                    // Filter valid geometries
                    const validFeatures = features.filter(f => f.geometry && (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon'));

                    if (validFeatures.length === 0) continue;

                    try {
                        // Try Modern Turf (Collection)
                        // v7+ wants turf.union(featureCollection)
                        if (validFeatures.length > 1) {
                            try {
                                const fc = { type: 'FeatureCollection', features: validFeatures };
                                merged = turf.union(fc);
                            } catch (e_v7) {
                                // Fallback to iterative (v6 style or robust fallback)
                                // console.warn("v7 union failed", e_v7);
                                merged = validFeatures[0];
                                for (let i = 1; i < validFeatures.length; i++) {
                                    merged = turf.union(merged, validFeatures[i]);
                                }
                            }
                        } else {
                            merged = validFeatures[0];
                        }
                    } catch (e) {
                        console.warn(`[MapRenderer] Merge failed for ${drName}. Using raw features.`, e);
                        merged = null;
                    }

                    if (merged) {
                        merged.properties = { DR_NAME: drName };
                        finalFeatures.push(merged);
                    } else {
                        // Fallback
                        console.log(`[MapRenderer] Using raw features for ${drName} (Merge incomplete)`);
                        validFeatures.forEach(f => {
                            f.properties.DR_NAME = drName;
                            finalFeatures.push(f);
                        });
                    }
                }
            }

            // Remove existing logic to refresh
            if (this.boundaryLayers['drs']) {
                this.map.removeLayer(this.boundaryLayers['drs']);
            }

            const mergedGeoJSON = { type: "FeatureCollection", features: finalFeatures };

            const layer = L.geoJSON(mergedGeoJSON, {
                style: (feature) => ({
                    color: DR_COLORS[feature.properties.DR_NAME] || 'black',
                    weight: 3,
                    fillColor: DR_COLORS[feature.properties.DR_NAME],
                    fillOpacity: 0.2,
                    interactive: false
                }),
                pane: 'labelsPane'
            });

            this.boundaryLayers['drs'] = layer;
            layer.addTo(this.map);
            console.log(`[MapRenderer] Displaying ${filterDR === 'All' ? 'All' : filterDR} DRs.`);

        } catch (e) {
            console.error("[MapRenderer] Failed to generate DR layer:", e);
            alert("Error generating DR layer.");
        }
    }
}

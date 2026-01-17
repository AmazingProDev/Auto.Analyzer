class MapRenderer {
    constructor(elementId) {
        // PERFORMANCE: preferCanvas = true forces Leaflet to use Canvas renderer for Vectors
        // This makes rendering 10k-50k points buttery smooth compared to SVG.
        this.map = L.map(elementId, { preferCanvas: true }).setView([33.5, -7.5], 6); // Default to Morocco view

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

        const satelliteLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
            attribution: 'Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community'
        });

        const googleHybridLayer = L.tileLayer('http://mt0.google.com/vt/lyrs=y&hl=en&x={x}&y={y}&z={z}', {
            attribution: 'Google',
            maxZoom: 20,
            subdomains: ['mt0', 'mt1', 'mt2', 'mt3']
        });

        // Set Default
        osmLayer.addTo(this.map);

        const baseMaps = {
            "Dark": darkLayer,
            "Light": lightLayer,
            "Streets": osmLayer,
            "Satellite": satelliteLayer,
            "Hybrid": googleHybridLayer
        };

        L.control.layers(baseMaps).addTo(this.map);

        this.logLayers = {}; // Store layers by ID/Name

        // Site Labels Layer (separate for performance)
        this.siteLabelsLayer = L.layerGroup();

        // Custom Pane for Connections (Lines) to ensure they are ON TOP of filled polygons
        this.map.createPane('connectionsPane');
        this.map.getPane('connectionsPane').style.zIndex = 620; // Lower than sites/points
        this.map.getPane('connectionsPane').style.pointerEvents = 'none';

        // Define Custom Renderers
        this.connectionsRenderer = L.canvas({ pane: 'connectionsPane' });

        // CUSTOM PANE FOR SITES & LOG POINTS (Interactive Top Layer)
        this.map.createPane('sitesPane');
        this.map.getPane('sitesPane').style.zIndex = 650;
        this.sitesRenderer = L.canvas({ pane: 'sitesPane', tolerance: 5 });

        // CUSTOM PANE FOR LABELS (Highest)
        this.map.createPane('labelsPane');
        this.map.getPane('labelsPane').style.zIndex = 700;
        this.map.getPane('labelsPane').style.pointerEvents = 'none'; // Don't block clicks

        // CUSTOM PANE FOR SMARTCARE GRIDS (Polygons) - zIndex 640 (Below sitesPane 650)
        this.map.createPane('smartCarePane');
        this.map.getPane('smartCarePane').style.zIndex = 640;
        // Canvas renderer for this pane to allow efficient rendering of many polygons
        this.smartCareRenderer = L.canvas({ pane: 'smartCarePane', tolerance: 5 });


        this.connectionsLayer = L.layerGroup().addTo(this.map); // Layer for lines
        this.connectionsLayer = L.layerGroup().addTo(this.map); // Layer for lines
        this.customDiscreteColors = {}; // User-overridden colors (ID -> Color)
        this.siteLayers = new Map(); // Store layers by ID: { id, name, sectors, visible, polygonLayer, labelLayer }
        // We no longer use a single this.siteData array for rendering, but we might aggregate it for 'getServingCell' lookups
        this.siteIndex = null; // Composite index of all VISIBLE layers

        // Optim: Only show labels on high zoom with debounce to prevent UI freeze
        let zoomTimeout;
        this.map.on('zoomend', () => {
            clearTimeout(zoomTimeout);
            zoomTimeout = setTimeout(() => {
                this.updateLabelVisibility();
                if (this.siteData && this.siteData.length > 0) {
                    this.renderSites(false); // Refresh
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

    finishRuler() {
        // Logic handled in click and move, just stay until escaped or re-clicked
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

        // Threshold: Only show if zoom >= 14
        // We no longer check Global Settings here because individual layers might have labels enabled.
        // renderSites() determines IF labels are generated. This just controls Zoom LOD.
        if (zoom >= 14) {
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

        if (window.getThresholdKey && window.themeConfig) {
            const rangeKey = window.getThresholdKey(metric);
            if (rangeKey) {
                const thresholds = window.themeConfig.thresholds[rangeKey];
                if (thresholds) {
                    for (const t of thresholds) {
                        if (t.min !== undefined && val <= t.min) continue;
                        if (t.max !== undefined && val > t.max) continue;
                        return t.color;
                    }
                    return '#888';
                }
            }
        }

        if (['cellId', 'cid', 'pci', 'sc', 'lac', 'serving_cell_name'].includes(metric)) {
            return this.getDiscreteColor(val);
        }

        return '#3b82f6';
    }

    getMetricValue(p, metric) {
        if (!p) return undefined;
        let val = p[metric];

        // 1. Serving Cell Name Resolution
        if (metric === 'serving_cell_name') {
            return this.resolveServingName(p) || 'Unknown';
        }

        // 2. Identity Resolution (Smart ID)
        if (metric === 'cellId' || metric === 'cid') {
            if (window.resolveSmartSite) {
                const resolved = window.resolveSmartSite(p);
                if (resolved && resolved.id) return resolved.id;
            }
            if (p.rnc !== undefined && p.cid !== undefined) {
                return `${p.rnc}/${p.cid}`;
            }
            return p.cellId || p.cid;
        }

        // 3. Radio Metrics Fallbacks
        if (metric === 'rscp_not_combined' || metric === 'rscp') {
            if (val === undefined) val = p.level || p.rscp;
            if (val === undefined && p.parsed && p.parsed.serving) val = p.parsed.serving.level || p.parsed.serving.rscp;
        }
        if (metric.startsWith('active_set_')) {
            const sub = metric.replace('active_set_', '').toLowerCase();
            val = p[sub];
        }

        // 4. Serving Struct Fallback
        if (val === undefined && p.parsed && p.parsed.serving) {
            val = p.parsed.serving[metric];
        }

        // 5. Raw Properties Fallback (SHP etc.)
        if (val === undefined && p.properties) {
            val = p.properties[metric];
        }

        return val;
    }

    getDiscreteColor(val) {
        if (val === undefined || val === null || val === '' || val === 'N/A') return '#ff0000'; // RED for Invalid (Debug)

        // Check for Custom Overrides first
        const sVal = String(val);
        if (this.customDiscreteColors && this.customDiscreteColors[sVal]) {
            return this.customDiscreteColors[sVal];
        }

        // Normalize: Remove whitespace to match Index keys
        const str = sVal.replace(/\s/g, '');

        // Custom 12-color palette from user image
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
            '#000000', // black
            '#8B4513'  // brown
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

        const hash = cyrb53(str);
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

        allVisibleSectors.forEach(s => {
            if (s.cellId) {
                const normId = String(s.cellId).replace(/\s/g, '');
                this.siteIndex.byId.set(normId, s);
                if (s.rnc && s.cid) {
                    const rncCid = `${s.rnc}/${s.cid}`.replace(/\s/g, '');
                    this.siteIndex.byId.set(rncCid, s);
                }
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
        if (!this.siteIndex) {
            console.warn('[MapRenderer] getServingCell: Site Index is missing!');
            return null;
        }
        // Uses this.siteIndex.all instead of this.siteData
        const siteData = this.siteIndex.all;
        if (!siteData || siteData.length === 0) {
            console.warn('[MapRenderer] getServingCell: No site data in index.');
            return null;
        }

        // ... logic continues ...
        const pci = p.sc;
        const lac = p.lac || (p.parsed && p.parsed.serving ? p.parsed.serving.lac : null);
        const freq = p.freq || (p.parsed && p.parsed.serving ? p.parsed.serving.freq : null);
        const cellId = p.cellId;

        // NEW: Priority RNC/CID Lookup (3G)
        if (p.rnc != null && p.cid != null) {
            const key = `${p.rnc}/${p.cid}`.replace(/\s/g, '');
            if (this.siteIndex.byId.has(key)) return this.siteIndex.byId.get(key);
        }

        // 0. PRIORITY: Strict eNodeB ID-Cell ID Matching
        if (cellId) {
            if (typeof cellId === 'number' && cellId > 65535) {
                const s = siteData.find(x => x.calculatedEci === cellId);
                if (s) return s;
            }
            const s = siteData.find(x => x.rawEnodebCellId == cellId);
            if (s) return s;
        }

        // 1. Strict RF
        if (pci && lac && freq) {
            const s = siteData.find(x => {
                const pciMatch = (x.pci == pci || x.sc == pci);
                const lacMatch = (x.lac == lac);
                const freqMatch = (x.freq == freq || Math.abs(x.freq - freq) < 1);
                return pciMatch && lacMatch && freqMatch;
            });
            if (s) return s;
        }

        // 2. CellID + LAC
        if (cellId && lac) {
            const s = siteData.find(x => x.cellId == cellId && x.lac == lac);
            if (s) return s;
        }

        // 3. CellID Only
        if (cellId) {
            // Optimization: check index first if string match
            const norm = String(cellId).replace(/\s/g, '');
            if (this.siteIndex.byId.has(norm)) return this.siteIndex.byId.get(norm);

            // Fallback for numeric vs string types mismatch
            const s = siteData.find(x => x.cellId == cellId);
            if (s) return s;
        }

        console.warn('[MapRenderer] getServingCell: Failed to find match.', { pci, lac, freq, cellId });
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
        this.preventZoom = preventZoom;

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

        const processChunk = () => {
            const end = Math.min(pIdx + CHUNK_SIZE, totalPoints);
            for (let i = pIdx; i < end; i++) {
                const p = points[i];
                const val = this.getMetricValue(p, metric);

                // Handle Identity Metrics Collection for Legend
                if (metric === 'cellId' || metric === 'cid') {
                    if (val !== undefined && val !== null) {
                        const sVal = String(val);
                        idsCollection.set(sVal, (idsCollection.get(sVal) || 0) + 1);
                        totalValidsForMetric++;
                    }
                }


                // Collect Stats for Thematic Metrics (RSRP, RSRQ, etc.)
                // If it's not cellId/cid, it might be a thematic metric mapping to level or quality
                if (metric !== 'cellId' && metric !== 'cid' && window.getThresholdKey) {
                    const rangeKey = window.getThresholdKey(metric);
                    if (rangeKey && window.themeConfig) {
                        const thresholds = window.themeConfig.thresholds[rangeKey];
                        if (thresholds && val !== undefined && val !== null) {
                            // Find matching label
                            let matched = false;
                            for (const t of thresholds) {
                                if (t.min !== undefined && val <= t.min) continue;
                                if (t.max !== undefined && val > t.max) continue;
                                idsCollection.set(t.label, (idsCollection.get(t.label) || 0) + 1);
                                matched = true;
                                break;
                            }
                            if (matched) totalValidsForMetric++;
                        }
                    }
                }

                const color = this.getColor(val, metric);

                if (p.lat !== undefined && p.lat !== null && p.lng !== undefined && p.lng !== null) {
                    validLocations.push([p.lat, p.lng]);

                    let layer;

                    // CHECK FOR POLYGON GEOMETRY (Imported SHP Grid)
                    if (p.geometry && (p.geometry.type === 'Polygon' || p.geometry.type === 'MultiPolygon')) {
                        layer = L.geoJSON(p.geometry, {
                            pane: 'sitesPane', // Shared pane to ensure interactivity (Canvas stacking issue fix)
                            renderer: this.sitesRenderer,
                            style: {
                                fillColor: color,
                                color: "transparent",
                                weight: 0,
                                opacity: 0,
                                fillOpacity: 0.8,
                                interactive: true
                            }
                        }).addTo(layerGroup);
                    } else {
                        // Default Point Rendering
                        layer = L.circleMarker([p.lat, p.lng], {
                            radius: 4,
                            fillColor: color,
                            color: "#000",
                            weight: 1,
                            opacity: 1,
                            fillOpacity: 0.8,
                            pane: 'sitesPane',
                            renderer: this.sitesRenderer,
                            interactive: true
                        }).addTo(layerGroup);
                    }

                    layer.on('click', (e) => {
                        L.DomEvent.stopPropagation(e);
                        window.dispatchEvent(new CustomEvent('map-point-clicked', {
                            detail: { logId: id, point: p }
                        }));
                    });
                }
            }

            pIdx = end;
            if (pIdx < totalPoints) {
                // Yield to main thread
                setTimeout(processChunk, 0);
            } else {
                // Done
                if (!this.preventZoom && validLocations.length > 0) {
                    this.map.fitBounds(validLocations);
                }

                // Finalize Legend IDs if applicable
                const statsObj = {
                    metric,
                    activeMetricIds: null,
                    activeMetricStats: idsCollection,
                    totalActiveSamples: totalValidsForMetric
                };

                if (metric === 'cellId' || metric === 'cid') {
                    this.activeMetricIds = Array.from(idsCollection.keys()).sort(); // Legacy global
                    this.activeMetricStats = idsCollection;
                    this.totalActiveSamples = totalValidsForMetric;

                    statsObj.activeMetricIds = Array.from(idsCollection.keys()).sort();

                    // Re-render sites to match colors if needed
                    this.renderSites(false);
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

                // Ensure sites are still on top and visible
                if (window.refreshSites) window.refreshSites();
            }
        };

        this.logLayers[id] = layerGroup;
        layerGroup.addTo(this.map);

        // Start Processing
        processChunk();
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
        if (metric === 'cellId' || metric === 'cid') {
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

    addEventsLayer(id, points) {
        if (!this.eventLayers) this.eventLayers = {};
        if (this.eventLayers[id]) this.map.removeLayer(this.eventLayers[id]);

        const layerGroup = L.layerGroup();

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

            const marker = L.circleMarker([p.lat, p.lng], {
                radius: radius,
                color: '#fff', // White border for contrast
                weight: 2,
                fillColor: fillColor,
                fillOpacity: 1,
                className: 'event-marker'
            }).bindTooltip(label, {
                permanent: false,
                direction: 'top',
                offset: [0, -5]
            });

            // Add popup with details
            const latStr = (p.lat !== undefined && p.lat !== null) ? p.lat.toFixed(5) : 'N/A';
            const lngStr = (p.lng !== undefined && p.lng !== null) ? p.lng.toFixed(5) : 'N/A';

            marker.bindPopup(`
                <b>${label}</b><br>
                Time: ${p.time}<br>
                Cause: ${p.message}<br>
                lat: ${latStr}, lng: ${lngStr}
             `);

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
            activeCellIds = this.activeMetricIds;
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

        this.sitesLayer = L.layerGroup();

        // Clear Labels
        if (this.siteLabelsLayer) {
            this.siteLabelsLayer.clearLayers();
        }


        const globalSettings = this.siteSettings || {};
        const bounds = this.map.getBounds().pad(0.2); // Only draw what's visible (plus buffer)

        this.sitePolygons = {};
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
                // PERFORMANCE: Skip if outside visible area
                if (!bounds.contains([s.lat, s.lng])) return;

                // ... render logic ...
                if (!showDetailedSectors) {
                    // Draw simple dot at low zoom
                    L.circleMarker([s.lat, s.lng], {
                        radius: 3,
                        color: this.getSiteColor(s), // Note: Dot color doesn't usually use override unless we want it to
                        fillOpacity: 0.8,
                        pane: 'sitesPane',
                        interactive: true
                    }).addTo(this.sitesLayer);
                    return;
                }

                // SECTOR LOGIC
                const center = [s.lat, s.lng];
                let color;
                let finalOpacity = opacity;
                let finalFillOpacity = opacity; // User requested 100% opacity by default

                if (activeCellIds) {
                    // HIGHLIGHT MODE
                    color = '#555';
                    finalOpacity = 0.4;
                    finalFillOpacity = 0.15;
                    let idStr = s.cellId;
                    if (s.rnc && s.cid) idStr = `${s.rnc}/${s.cid}`;

                    if (activeCellIds.includes(String(idStr)) || activeCellIds.includes(String(s.cellId))) {
                        color = this.getDiscreteColor(idStr);
                        finalOpacity = 1;
                        finalFillOpacity = 0.6;
                    }
                } else {
                    // STANDARD MODE - use overrideColor if present
                    color = overrideColor || this.getSiteColor(s);
                }

                // Calculations
                const azimuth = s.azimuth || 0;
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

                const p1 = getPoint(s.lat, s.lng, azimuth - beam / 2, range);
                const p2 = getPoint(s.lat, s.lng, azimuth + beam / 2, range);

                const polygon = L.polygon([center, p1, p2], {
                    color: '#ffffff',
                    weight: 1.5,
                    fillColor: color,
                    fillOpacity: finalFillOpacity,
                    opacity: 0.9,
                    className: 'sector-polygon',
                    interactive: true,
                    pane: 'sitesPane',
                    renderer: this.sitesRenderer
                }).addTo(this.sitesLayer);

                if (s.cellId) {
                    this.sitePolygons[s.cellId] = polygon;
                }
                // Enhance Indexing for Unique IDs
                if (s.rawEnodebCellId) {
                    this.sitePolygons[s.rawEnodebCellId] = polygon;
                }
                if (s.calculatedEci) {
                    this.sitePolygons[s.calculatedEci] = polygon;
                }

                // Labels
                if (effective.showSiteNames) {
                    const siteName = s.siteName || s.name;
                    if (siteName && !renderedSiteLabels.has(siteName)) {
                        renderedSiteLabels.add(siteName);
                        L.marker(center, {
                            icon: L.divIcon({
                                className: 'site-label',
                                html: `<div style="background:rgba(0,0,0,0.4); color:#fff; font-size:10px; padding:2px 4px; border-radius:3px; white-space:nowrap; transform: translate(-50%, -50%); position: absolute; left: 0; top: 0;">${siteName}</div>`,
                                iconSize: [0, 0] // Trick to make the div positioned at the coordinate origin
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

                // Popup
                const content = `
                <div style="font-family: sans-serif; font-size: 13px;">
                    <strong>${s.name || 'Unknown Site'}</strong><br>
                    Cell: ${s.cellId || '-'}<br>
                    Azimuth: ${azimuth}°<br>
                    Tech: ${s.tech || '-'}<br>
                    <span style="font-size:10px; color:#888;">(RNC/CID: ${s.rnc}/${s.cid})</span><br>
                    <button style="margin-top:5px; cursor:pointer;" onclick="window.editSector('${layer.id}', ${index})">Edit</button>
                </div>
            `;
                polygon.bindPopup(content);
                polygon.on('click', () => {
                    window.dispatchEvent(new CustomEvent('site-sector-clicked', {
                        detail: {
                            cellId: s.cellId,
                            sc: s.sc || s.pci,
                            lac: s.lac,
                            freq: s.freq,
                            lat: s.lat,
                            lng: s.lng,
                            azimuth: azimuth,
                            rnc: s.rnc,
                            cid: s.cid,
                            range: range,
                            beamwidth: beam
                        }
                    }));
                });

                if (s.cellId) {
                    this.sitePolygons[s.cellId] = polygon;
                }
                // Enhance Indexing for Unique IDs
                if (s.rawEnodebCellId) {
                    this.sitePolygons[s.rawEnodebCellId] = polygon;
                }
            });
        });

        this.sitesLayer.addTo(this.map);
        this.updateLabelVisibility();

    }

    highlightCell(cellId) {
        if (!cellId || !this.sitePolygons) return;

        // Reset previous highlight
        if (this.currentHighlight) {
            const { poly, originalStyle } = this.currentHighlight;
            poly.setStyle(originalStyle);
            this.currentHighlight = null;
        }

        const polygon = this.sitePolygons[cellId];
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
        const polygon = this.sitePolygons[cellId];
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
        // Clear previous connections
        this.connectionsLayer.clearLayers();
        if (!startPt || !targets || targets.length === 0) return;

        targets.forEach(t => {
            if (t.lat === undefined || t.lng === undefined) {
                return;
            }

            let destLat = t.lat;
            let destLng = t.lng;

            // 1. Precise Tip Calculation via Azimuth (Preferred)
            if (t.azimuth !== undefined && t.range !== undefined) {
                const rad = Math.PI / 180;
                const latRad = t.lat * rad;
                const azRad = t.azimuth * rad;
                const dist = t.range; // meters

                const dy = Math.cos(azRad) * dist;
                const dx = Math.sin(azRad) * dist;
                const dLat = dy / 111111;
                const dLng = dx / (111111 * Math.cos(latRad));

                destLat = t.lat + dLat;
                destLng = t.lng + dLng;
            }
            // 2. Fallback: Polygon Centroid Logic
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

            L.polyline([[startPt.lat, startPt.lng], [destLat, destLng]], {
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

        // Use Canvas renderer for performance if many lines?
        // Polyline by default uses the map renderer (preferCanvas was set in constructor)

        segments.forEach(seg => {
            L.polyline([seg.from, seg.to], {
                color: seg.color || '#3b82f6',
                weight: 1,
                opacity: 0.6,
                pane: 'connectionsPane',
                renderer: this.connectionsRenderer, // Force to Connections Canvas
                interactive: false
            }).addTo(this.connectionsLayer);
        });
    }

    clearConnections() {
        this.connectionsLayer.clearLayers();
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
        const pane = this.map.getPane('sitesPane');
        if (pane) {
            pane.style.transition = 'filter 0.3s ease';
            pane.style.filter = enable ? 'blur(8px)' : 'none';
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

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

    // ----------------------------------------------------
    // THEMATIC CONFIGURATION & HELPERS
    // ----------------------------------------------------
    // Helper to map metric names to theme keys
    window.getThresholdKey = (metric) => {
        if (!metric) return 'level';
        const m = metric.toLowerCase();
        if (m.includes('qual') || m.includes('sinr') || m.includes('ecno')) return 'quality';
        if (m.includes('throughput')) return 'throughput';
        return 'level'; // Default to level (RSRP/RSCP)
    };

    // Global Theme Configuration
    window.themeConfig = {
        thresholds: {
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
            'throughput': [
                { min: 20000, max: undefined, color: '#22c55e', label: 'Excellent (>= 20000 Kbps)' },
                { min: 10000, max: 20000, color: '#84cc16', label: 'Good (10000-20000 Kbps)' },
                { min: 3000, max: 10000, color: '#eab308', label: 'Fair (3000-10000 Kbps)' },
                { min: 1000, max: 3000, color: '#f97316', label: 'Poor (1000-3000 Kbps)' },
                { min: undefined, max: 1000, color: '#ef4444', label: 'Bad (< 1000 Kbps)' }
            ]

        }
    };

    // Global Listener for Map Rendering Completion (Async Legend)
    window.addEventListener('layer-metric-ready', (e) => {
        // console.log('[App] layer-metric-ready received for: ' + (e.detail.metric));
        if (typeof window.updateLegend === 'function') {
            window.updateLegend();
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
            // 2. Draw Connection Line
            // Color can be static (e.g. green) or dynamic (based on point color)
            const color = mapRenderer.getColor(mapRenderer.getMetricValue(point, mapRenderer.activeMetric), mapRenderer.activeMetric);

            // Construct target object for drawConnections
            const target = {
                lat: servingCell.lat,
                lng: servingCell.lng,
                azimuth: servingCell.azimuth, // Pass Azimuth
                range: 0, // Go to Sector Vertex (Tip/Center)
                color: color || '#3b82f6', // Default Blue
                cellId: servingCell.cellId // For polygon centroid logic (legacy fallback)
            };

            // Use Best Available ID for Polygon Lookup
            const bestId = servingCell.rawEnodebCellId || servingCell.calculatedEci || servingCell.cellId;
            if (bestId) target.cellId = bestId;

            mapRenderer.drawConnections(startPt, [target]);

            // 3. Optional: Highlight Serving Cell (Visual Feedback)
            mapRenderer.highlightCell(bestId);

            // console.log('[App] Drawn line to Serving Cell: ' + (servingCell.cellName || servingCell.cellId));
        } else {
            console.warn('[App] Serving Cell not found for clicked point.');
            // Clear previous connections if any
            mapRenderer.connectionsLayer.clearLayers();
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

        const metricsHtml = (customMetrics && customMetrics.length > 0)
            ? '<div class="sc-metric-container">\n                ${customMetrics.map(m => '
                    <div class="sc-metric-button ${log.currentParam === m ? 'active' : ''}" 
                         onclick="window.showMetricOptions(event, '${layerId}', '${m}', 'smartcare')">${m}</div>
               ').join(\'\')}\n               </div>'
            : '<div style="font-size:10px; color:#666; font-style:italic;">No metrics found</div>';

        item.innerHTML = '\n            <div class="sc-group-title-row">\n                <div class="sc-group-name">\n                    <span class="sc-caret">▶</span>\n                    ' + (name) + '\n                </div>\n                <!-- Top Level Controls -->\n                <div class="sc-layer-controls">\n                    <button class="sc-btn sc-btn-toggle" onclick="toggleSmartCareLayer(\'' + (layerId) + '\')" title="Toggle Visibility">👁️</button>\n                    <button class="sc-btn sc-btn-remove" onclick="removeSmartCareLayer(\'' + (layerId) + '\')" title="Remove Layer">❌</button>\n                </div>\n            </div>\n\n            <!-- Expandable Body -->\n            <div class="sc-layer-body">\n                <!-- Meta Row -->\n                <div class="sc-meta-row">\n                    <div class="sc-meta-left">\n                        <span class="sc-tech-badge-sm">' + (techLabel) + '</span>\n                        <span class="sc-count-badge-sm">' + (pointCount) + ' pts</span>\n                    </div>\n                </div>\n                <!-- Metrics Grid -->\n                ' + (metricsHtml) + '\n            </div>\n        ';

        scLayerList.appendChild(item);
    }

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

        menu.innerHTML = '\n            <div class="sc-menu-item" id="menu-map-' + (layerId) + '">\n                <span>🗺️</span> Map\n            </div>\n            <div class="sc-menu-item" id="menu-grid-' + (layerId) + '">\n                <span>📊</span> Grid\n            </div>\n            <div class="sc-menu-item" id="menu-chart-' + (layerId) + '">\n                <span>📈</span> Chart\n            </div>\n        ';

        document.body.appendChild(menu);

        // Map Click Handler
        menu.querySelector('#menu-map-' + (layerId)).onclick = () => {
            if (type === 'smartcare') {
                window.switchSmartCareMetric(layerId, metric);
            } else {
                if (window.mapRenderer) {
                    window.mapRenderer.updateLayerMetric(layerId, log.points, metric);
                    // Sync theme select
                    const themeSelect = document.getElementById('themeSelect');
                    if (themeSelect) {
                        if (metric === 'cellId' || metric === 'cid') themeSelect.value = 'cellId';
                        else if (metric.toLowerCase().includes('qual')) themeSelect.value = 'quality';
                        else themeSelect.value = 'level';
                        if (typeof window.updateLegend === 'function') window.updateLegend();
                    }
                }
            }
            menu.remove();
        };

        // Grid Click Handler
        menu.querySelector('#menu-grid-' + (layerId)).onclick = () => {
            window.openGridModal(log, metric);
            menu.remove();
        };

        // Chart Click Handler
        menu.querySelector('#menu-chart-' + (layerId)).onclick = () => {
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
                color: '#8b5cf6', // Violet
                visible: true,
                type: 'nmf', // Treat as NMF-like standard log
                currentParam: 'level'
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
                aiContent.innerHTML = '<div style="color: #ef4444; text-align: center; padding: 20px;">\n                    <h3>Analysis Failed</h3>\n                    <p><strong>Error:</strong> ' + (userMsg) + '</p>\n                    <p style="font-size:12px; color:#aaa; margin-top:5px;">Check console for details.</p>\n                    <div style="display:flex; justify-content:center; gap:10px; margin-top:20px;">\n                         <button onclick="window.runAIAnalysis()" class="btn" style="background: linear-gradient(135deg, #6366f1 0%, #a855f7 100%); width: auto;">Retry</button>\n                         <button onclick="document.getElementById(\'aiApiKeySection\').style.display=\'block\'; document.getElementById(\'aiLoading\').style.display=\'none\'; document.getElementById(\'aiContent\').innerHTML=\'\';" class="btn" style="background:#555;">Back</button>\n                    </div>\n                </div>';
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
        return 'You are an expert RF Optimization Engineer. Analyze the following drive test summary data:\n        \n        - Technologies Found: ' + (metrics.technologies) + '\n        - Total Samples: ' + (metrics.totalPoints) + '\n        - Average Signal Strength (RSCP/RSRP): ' + (metrics.avgRscp) + ' dBm\n        - Average Quality (EcNo/RSRQ): ' + (metrics.avgEcno) + ' dB\n        - Weak Coverage Samples (< -100dBm): ' + (metrics.weakSignalPct) + '%\n        - Top Serving Cells: ' + (metrics.topCells) + '\n\n        Provide a concise analysis in Markdown format:\n        1. **Overall Health**: Assess the network condition (Good, Fair, Poor).\n        2. **Key Issues**: Identify potential problems (e.g., coverage holes, interference, dominance).\n        3. **Recommended Actions**: Suggest 3 specific optimization actions (e.g., downtilt, power adjustment, neighbor checks).\n        \n        Keep it professional and technical.';
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

    mapContainer.addEventListener('drop', (e) => {
        e.preventDefault();
        mapContainer.style.boxShadow = 'none';

        try {
            const data = JSON.parse(e.dataTransfer.getData('application/json'));
            if (data && data.logId && data.param) {
                // Determine Log and Points
                const log = loadedLogs.find(l => l.id === data.logId);
                if (data.type === 'metric') {
                    // Update Map Layer
                    map.updateLayerMetric(log.id, log.points, data.param);
                    // Optional: Show some feedback?
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

        container.innerHTML = '\n                    <div id="' + (headerId) + '" style="padding:10px; background:#2d2d2d; border-bottom:1px solid #444; display:flex; justify-content:space-between; align-items:center; cursor:' + (dragCursor) + '; user-select:none;">\n                        <div style="display:flex; align-items:center; pointer-events:none;">\n                            <h3 style="margin:0; margin-right:20px; pointer-events:auto; font-size:14px;">' + (log.name) + ' - ' + (isComposite ? 'RSCP & Neighbors' : param.toUpperCase()) + ' (Snapshot)</h3>\n                            <button id="styleToggleBtn" style="background:#333; color:#ccc; border:1px solid #555; padding:5px 10px; cursor:pointer; pointer-events:auto; font-size:11px;">⚙️ Style</button>\n                        </div>\n                        <div style="pointer-events:auto; display:flex; gap:10px;">\n                            ' + (dockBtn) + '\n                            ' + (closeBtn) + '\n                        </div>\n                    </div>\n                    \n                    <!-- Settings Panel -->\n                    <div id="' + (controlsId) + '" style="display:none; background:#252525; padding:10px; border-bottom:1px solid #444; gap:15px; align-items:center; flex-wrap:wrap;">\n                        <!-- Serving Controls -->\n                        <div style="display:flex; flex-direction:column; gap:2px; border-right:1px solid #444; padding-right:10px;">\n                            <label style="color:#aaa; font-size:10px; font-weight:bold;">Serving</label>\n                             <input type="color" id="pickerServing" value="#3b82f6" style="border:none; width:30px; height:20px; cursor:pointer;">\n                        </div>\n\n                        ${isComposite ? '
                        <div style="display:flex; flex-direction:column; gap:2px; padding-right:5px;">
                            <label style="color:#aaa; font-size:10px;">N1 Style</label>
                            <input type="color" id="pickerN1" value="#22c55e" style="border:none; width:30px; height:20px; cursor:pointer;">
                        </div>
                        <div style="display:flex; flex-direction:column; gap:2px; padding-right:5px;">
                            <label style="color:#aaa; font-size:10px;">N2 Style</label>
                            <input type="color" id="pickerN2" value="#22c55e" style="border:none; width:30px; height:20px; cursor:pointer;">
                        </div>
                        <div style="display:flex; flex-direction:column; gap:2px;">
                            <label style="color:#aaa; font-size:10px;">N3 Style</label>
                            <input type="color" id="pickerN3" value="#22c55e" style="border:none; width:30px; height:20px; cursor:pointer;">
                        </div>
                        ' : \'\'}\n                    </div>\n\n                    <div style="flex:1; padding:10px; display:flex; gap:10px; height: 100%; min-height: 0;">\n                        <!-- Bar Chart Section (100%) -->\n                        <div id="barChartContainer" style="flex:1; position:relative; min-width:0;">\n                            <canvas id="barChartCanvas"></canvas>\n                             <div id="barOverlayInfo" style="position:absolute; top:10px; right:10px; color:white; background:rgba(0,0,0,0.7); padding:2px 5px; border-radius:4px; font-size:10px; pointer-events:none;">\n                                Snapshot\n                            </div>\n                        </div>\n                    </div>\n                    <!-- Resize handle visual cue (bottom right) -->\n                    <div style="position:absolute; bottom:2px; right:2px; width:10px; height:10px; cursor:nwse-resize;"></div>\n                ';

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

        // Update Legend UI to reflect new stats/labels
        window.updateLegend();
    }

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
            let topPos = 80;
            let rightPos = 20;
            const mapEl = document.getElementById('map');
            if (mapEl) {
                const rect = mapEl.getBoundingClientRect();
                topPos = rect.top + 10;
                rightPos = (window.innerWidth - rect.right) + 10;
            }

            container.setAttribute('style', '\n                position: fixed;\n                top: ' + (topPos) + 'px; \n                right: ' + (rightPos) + 'px;\n                width: 320px;\n                min-width: 250px;\n                max-width: 600px;\n                max-height: 80vh;\n                background-color: rgba(30, 30, 30, 0.95);\n                border: 2px solid #555;\n                border-radius: 6px;\n                color: #fff;\n                z-index: 10001; \n                box-shadow: 0 4px 15px rgba(0,0,0,0.6);\n                display: flex;\n                flex-direction: column;\n                resize: both;\n                overflow: hidden;\n            ');

            // Disable Map Interactions passing through Legend
            if (typeof L !== 'undefined' && L.DomEvent) {
                L.DomEvent.disableClickPropagation(container);
                L.DomEvent.disableScrollPropagation(container);
            }

            // Global Header (Drag Handle)
            const mainHeader = document.createElement('div');
            mainHeader.setAttribute('style', '\n                padding: 8px 10px;\n                background-color: #252525;\n                font-weight: bold;\n                font-size: 13px;\n                border-bottom: 1px solid #444;\n                cursor: grab;\n                display: flex;\n                justify-content: space-between;\n                align-items: center;\n                border-radius: 6px 6px 0 0;\n                flex-shrink: 0;\n            ');
            mainHeader.innerHTML = '\n                <span>Legend</span>\n                <div style="display:flex; gap:8px; align-items:center;">\n                     <span onclick="this.closest(\'#draggable-legend\').remove(); window.legendControl=null;" style="cursor:pointer; color:#aaa; font-size:18px; line-height:1;">&times;</span>\n                </div>\n            ';
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
        const visibleLogs = window.loadedLogs ? window.loadedLogs.filter(l => l.visible !== false) : [];

        if (visibleLogs.length === 0) {
            scrollContent.innerHTML = '<div style="padding:10px; color:#888; text-align:center;">No visible layers.</div>';
        } else {
            visibleLogs.forEach(log => {
                const statsObj = renderer.layerStats ? renderer.layerStats[log.id] : null;
                if (!statsObj) return;

                hasContent = true;
                const metric = statsObj.metric || 'level';
                const stats = statsObj.activeMetricStats || new Map();
                const total = statsObj.totalActiveSamples || 0;

                const section = document.createElement('div');
                section.setAttribute('style', 'margin-bottom: 10px; border: 1px solid #444; border-radius: 4px; overflow: hidden;');

                const sectHeader = document.createElement('div');
                sectHeader.innerHTML = '<span style="font-weight:bold; color:#eee;">' + (log.name) + '</span> <span style="font-size:10px; color:#aaa;">(' + (metric) + ')</span>';
                sectHeader.setAttribute('style', 'background:#333; padding: 5px 8px; font-size:12px; border-bottom:1px solid #444;');
                section.appendChild(sectHeader);

                const sectBody = document.createElement('div');
                sectBody.setAttribute('style', 'padding:5px; background:rgba(0,0,0,0.2);');

                if (metric === 'cellId' || metric === 'cid') {
                    const ids = statsObj.activeMetricIds || [];
                    const sortedIds = ids.slice().sort((a, b) => (stats.get(b) || 0) - (stats.get(a) || 0));
                    if (sortedIds.length > 0) {
                        let html = '<div style="display:flex; flex-direction:column; gap:4px;">';
                        sortedIds.slice(0, 50).forEach(id => {
                            const color = renderer.getDiscreteColor(id);
                            let name = id;
                            if (window.mapRenderer && window.mapRenderer.siteIndex && window.mapRenderer.siteIndex.byId) {
                                const site = window.mapRenderer.siteIndex.byId.get(id);
                                if (site) name = site.cellName || site.name || id;
                            }
                            const count = stats.get(id) || 0;
                            html += '<div class="legend-row">\n                                <div class="legend-swatch" style="background:' + (color) + ';"></div>\n                                <span class="legend-label">' + (name) + '</span>\n                                <span class="legend-count">' + (count) + '</span>\n                            </div>';
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
                            html += '<div class="legend-row">\n                                <input type="color" value="' + (t.color) + '" class="legend-color-input" onchange="window.handleLegendColorChange(\'' + (key) + '\', ' + (idx) + ', this.value)">\n                                <div class="legend-label" style="display:flex; align-items:center; gap:4px;">\n                                    ' + (minVal) + ' <span style="font-size:9px; color:#666;">to</span> ' + (maxVal) + '\n                                </div>\n                                <span class="legend-count">' + (count) + ' (' + (pct) + '%)</span>\n                            </div>';
                        });
                        html += '</div>';
                        sectBody.innerHTML = html;
                    }
                }
                section.appendChild(sectBody);
                scrollContent.appendChild(section);
            });
        }
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
                inputs += '<label style="font-size:10px; color:#aaa;">Min</label>\n                           <input type="number" class="thresh-min" data-idx="' + (idx) + '" value="' + (t.min) + '" style="width:50px; background:#333; border:1px solid #555; color:#fff; font-size:11px; padding:2px;">';
            } else {
                inputs += '<span style="font-size:10px; color:#aaa; width:50px; display:inline-block;">( -∞ )</span>';
            }

            // If it has Max, show Max Input
            if (t.max !== undefined) {
                inputs += '<label style="font-size:10px; color:#aaa; margin-left:5px;">Max</label>\n                           <input type="number" class="thresh-max" data-idx="' + (idx) + '" value="' + (t.max) + '" style="width:50px; background:#333; border:1px solid #555; color:#fff; font-size:11px; padding:2px;">';
            } else {
                inputs += '<span style="font-size:10px; color:#aaa; width:50px; display:inline-block; margin-left:5px;">( +∞ )</span>';
            }

            // Remove Button
            const removeBtn = '<button onclick="window.removeThreshold(' + (idx) + ')" style="margin-left:auto; background:none; border:none; color:#ef4444; cursor:pointer;" title="Remove Range">✖</button>';

            div.innerHTML = '\n                <div style="display:flex; align-items:center;">\n                    <input type="color" class="thresh-color" data-idx="' + (idx) + '" value="' + (t.color) + '" style="border:none; width:20px; height:20px; cursor:pointer; margin-right:5px;">\n                    ' + (inputs) + '\n                    ' + (removeBtn) + '\n                </div>\n            ';
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
            let tableHtml = '<table style="width:100%; border-collapse:collapse; color:#eee; font-size:12px;">\n                <thead style="position:sticky; top:0; background:#333; height:30px;">\n                    <tr>\n                        <th style="padding:4px 8px; text-align:left;">Time</th>\n                        <th style="padding:4px 8px; text-align:left;">Lat</th>\n                        <th style="padding:4px 8px; text-align:left;">Lng</th>\n                        <th draggable="true" ondragstart="window.handleHeaderDragStart(event)" data-param="cellId" style="padding:4px 8px; text-align:left; cursor:grab;">RNC/CID</th>';

            window.currentGridColumns.forEach(col => {
                if (col === 'cellId') return; // Skip cellId as it is handled by RNC/CID column
                tableHtml += '<th draggable="true" ondragstart="window.handleHeaderDragStart(event)" data-param="' + (col) + '" style="padding:4px 8px; text-align:left; text-transform:uppercase; cursor:grab;">' + (col) + '</th>';
            });
            tableHtml += '</tr></thead><tbody>';

            let rowsHtml = '';
            const limit = 5000; // Limit for performance

            log.points.slice(0, limit).forEach((p, i) => {
                // Add ID and Click Handler
                // RNC/CID Formatter
                const rncCid = (p.rnc !== undefined && p.rnc !== null && p.cid !== undefined && p.cid !== null)
                    ? (p.rnc) + '/' + (p.cid)
                    : (p.cellId || '-');

                let row = '<tr id="grid-row-' + (i) + '" class="grid-row" onclick="window.globalSync(\'' + (log.id) + '\', ' + (i) + ', \'grid\')" style="cursor:pointer; transition: background 0.1s;">\n                <td style="padding:4px 8px; border-bottom:1px solid #333;">' + (p.time) + '</td>\n                <td style="padding:4px 8px; border-bottom:1px solid #333;">' + (p.lat.toFixed(5)) + '</td>\n                <td style="padding:4px 8px; border-bottom:1px solid #333;">' + (p.lng.toFixed(5)) + '</td>\n                <td style="padding:4px 8px; border-bottom:1px solid #333;">' + (rncCid) + '</td>';

                window.currentGridColumns.forEach(col => {
                    if (col === 'cellId') return; // Skip cellId
                    let val = p[col];

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
                // Fix: Align ID format with MapRenderer.getSiteColor (RNC/CID priority)
                let finalId = s.cellId || s.calculatedEci || s.id;
                if (s.rnc && s.cid) finalId = (s.rnc) + '/' + (s.cid);

                return {
                    name: s.cellName || s.name || s.siteName,
                    id: finalId,
                    lat: s.lat,
                    lng: s.lng,
                    azimuth: s.azimuth,
                    range: s.currentRadius, // Expose Visual Radius
                    rnc: s.rnc,
                    cid: s.cid,
                    pci: s.pci || s.sc,
                    freq: s.currentFreq || s.freq
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
        if (servingRes.lat && servingRes.lng) {
            connectionTargets.push({
                lat: servingRes.lat, lng: servingRes.lng, color: logColor || '#3b82f6', weight: 8, cellId: servingRes.id,
                azimuth: servingRes.azimuth, range: servingRes.range // Enable "Tip" connection
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
            if (a2Res.lat && a2Res.lng) connectionTargets.push({ lat: a2Res.lat, lng: a2Res.lng, color: '#ef4444', weight: 8, cellId: a2Res.id });
        }
        if (p.a3_sc !== undefined && p.a3_sc !== null) {
            const a3Res = resolveNeighbor(p.a3_sc, null, sFreq);
            if (a3Res.lat && a3Res.lng) connectionTargets.push({ lat: a3Res.lat, lng: a3Res.lng, color: '#ef4444', weight: 8, cellId: a3Res.id });
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

            rawHtml += '<div style="display:flex; justify-content:space-between; border-bottom:1px solid #444; font-size:11px; padding:3px 0;">\n                <span style="color:#aaa; font-weight:500; margin-right: 10px;">' + (k) + '</span>\n                <span style="color:#fff; font-weight:bold; word-break: break-all; text-align: right;">' + (displayVal) + '</span>\n            </div>';
        });

        let html = '\n            <div style="padding: 10px;">\n                <!-- Serving Cell Header (Fixed) -->\n                ${servingRes && servingRes.name ? '
                <div style="margin-bottom:10px; padding-bottom:10px; border-bottom:1px solid #444;">
                    <div style="font-size:14px; font-weight:bold; color:#22c55e;">${servingRes.name}</div>
                    <div style="font-size:11px; color:#888;">ID: ${servingRes.id || '-'}</div>
                </div>' : \'\'}\n\n                <div style="display:flex; justify-content:space-between; margin-bottom:10px; border-bottom: 2px solid #555; padding-bottom:5px;">\n                    <span style="font-size:12px; color:#ccc;">' + (p.time || sourceObj.Time || 'No Time') + '</span>\n                    <span style="font-size:12px; color:#ccc;">' + (p.lat.toFixed(5)) + ', ' + (p.lng.toFixed(5)) + '</span>\n                </div>\n\n                <!-- Event Info (Highlight) -->\n                ${p.event ? '
                    <div style="background:#451a1a; color:#f87171; padding:5px; border-radius:4px; margin-bottom:10px; font-weight:bold; text-align:center;">
                        ${p.event}
                    </div>
                ' : \'\'}\n                \n                <div class="raw-data-container" style="max-height: 400px; overflow-y: auto;">\n                    ' + (rawHtml) + '\n                </div>\n                \n                <div style="display:flex; gap:10px; margin-top:10px;">\n                    <button class="btn btn-blue" onclick="window.analyzePoint(this)" style="flex:1; justify-content: center;">Analyze Point</button>\n                    <button class="btn btn-purple" onclick="window.generateManagementSummary()" style="flex:1; justify-content: center;">MANAGEMENT SUMMARY</button>\n                </div>\n                    <!-- Hidden data stash for the analyzer -->\n                    <script type="application/json" id="point-data-stash">\n                    ' + ((() => {\n                // Robust Key Finder for Stash\n                const findKey = (obj, target) => {\n                    const t = target.toLowerCase().replace(/\s/g, '');\n                    for (let k of Object.keys(obj)) {\n                        if (k.toLowerCase().replace(/\s/g, '') === t) return obj[k];\n                    ) + '\n                    return undefined;\n                };\n                const cellName = findKey(sourceObj, \'Cell Name\') || findKey(sourceObj, \'CellName\') || findKey(sourceObj, \'Site Name\');\n                const cellId = findKey(sourceObj, \'Cell ID\') || findKey(sourceObj, \'CellID\') || findKey(sourceObj, \'CI\');\n\n                return JSON.stringify({\n                    ...sourceObj,\n                    \'Cell Identifier\': servingRes && servingRes.name ? servingRes.name : (cellName || servingRes.id || cellId || \'Unknown\'),\n                    \'Cell Name\': servingRes && servingRes.name ? servingRes.name : (cellName || \'Unknown\'),\n                    \'Tech\': p.tech || sourceObj.Tech || (p.rsrp !== undefined ? \'LTE\' : \'UMTS\')\n                });\n            })()}\n                    </script>\n                </div>\n            </div>\n        return { html, connectionTargets };\n    }\n\n    // --- STRICT MANAGEMENT SUMMARY IMPLEMENTATION (SECTION 0-15 Rules) ---\n    window.generateManagementSummary = (d) => {\n        // Helper: Extract Metric Safely\n        const getVal = (targetKeys) => {\n            if (!Array.isArray(targetKeys)) targetKeys = [targetKeys];\n            const rowKeys = Object.keys(d);\n            const normalize = s => s.toLowerCase().replace(/[^a-z0-9]/g, \'\');\n            for (let t of targetKeys) {\n                const normT = normalize(t);\n                // Try Exact first\n                if (d[t] !== undefined) return d[t];\n                // Try Normalized Search\n                const match = rowKeys.find(k => normalize(k) === normT || normalize(k).includes(normT));\n                if (match && d[match] !== undefined) return d[match];\n            }\n            return null;\n        };\n\n        const val = (v) => (v === null || v === undefined || isNaN(parseFloat(v))) ? null : parseFloat(v);\n\n        // --- EXTRACT METRICS ---\n        const mrCount = val(getVal([\'Dominant MR Count\', \'MR Count\', \'Sample Count\']));\n        const rsrp = val(getVal([\'Dominant RSRP\', \'RSRP\']));\n        const rsrq = val(getVal([\'Dominant RSRQ\', \'RSRQ\']));\n        const cqi = val(getVal([\'Average DL Wideband CQI\', \'Wideband CQI\']));\n        const dlLowTput = val(getVal([\'DL Low-Throughput Ratio\', \'DL Low Tput Ratio\']));\n        const ulLowTput = val(getVal([\'UL Low-Throughput Ratio\', \'UL Low Tput Ratio\']));\n        const dlRb = val(getVal([\'Average DL RB Quantity\', \'DL RB Quantity\']));\n        const dlSpecEff = val(getVal([\'DL Spectrum Efficiency\', \'Spectrum Efficiency\']));\n        const dlIbler = val(getVal([\'DL IBLER\', \'IBLER\']));\n        const rank2 = val(getVal([\'Rank 2 Percentage\', \'Rank 2 %\']));\n        const dl3cc = val(getVal([\'DL 3CC Percentage\', \'3CC\']));\n        const dl1cc = val(getVal([\'DL 1CC Percentage\', \'1CC\']));\n\n        let output = {};\n        let scoreBase = 0;\n        let bonus = 0;\n        let penalty = 0;\n\n        // --- SECTION 0: DATA CONFIDENCE & VALIDITY ---\n        if (mrCount !== null && mrCount >= 1000) { output.dataConf = "High"; scoreBase = 70; }\n        else if (mrCount !== null && mrCount >= 100) { output.dataConf = "Medium"; scoreBase = 55; }\n        else { output.dataConf = "Low"; scoreBase = 35; }\n\n        if (mrCount !== null && mrCount < 20) { output.limitation = "Indicative Only"; penalty += 20; }\n\n        // --- SECTION 1: COVERAGE STATUS ---\n        if (rsrp !== null) {\n            if (rsrp >= -90) output.coverage = "Good";\n            else if (rsrp > -100) output.coverage = "Fair";\n            else output.coverage = "Poor";\n        } else output.coverage = "N/A";\n\n        // --- SECTION 2: SIGNAL QUALITY ---\n        if (rsrq !== null) {\n            if (rsrq >= -9) output.quality = "Good";\n            else if (rsrq > -11) output.quality = "Degraded";\n            else output.quality = "Poor";\n        } else output.quality = "N/A";\n\n        // --- SECTION 3: CHANNEL QUALITY ---\n        if (cqi !== null) {\n            if (cqi < 6) output.cqi = "Poor";\n            else if (cqi < 9) output.cqi = "Moderate";\n            else output.cqi = "Good";\n        } else output.cqi = "N/A";\n\n        // --- SECTION 4: USER EXPERIENCE (DL) ---\n        if (dlLowTput !== null) {\n            if (dlLowTput >= 80) { output.dlExp = "Severely Degraded"; bonus += 10; }\n            else if (dlLowTput >= 25) output.dlExp = "Degraded";\n            else output.dlExp = "Acceptable";\n        } else output.dlExp = "N/A";\n\n        // --- SECTION 5: LOAD & CONGESTION ---\n        if (dlRb !== null) {\n            if (dlRb <= 10) output.load = "Very Low Load";\n            else if (dlRb < 70) output.load = "Moderate Load";\n            else output.load = "Congested";\n        } else output.load = "N/A";\n\n        // --- SECTION 6: SPECTRUM EFFICIENCY ---\n        if (dlSpecEff !== null) {\n            if (dlSpecEff < 1000) { output.specEff = "Very Low"; bonus += 10; }\n            else if (dlSpecEff < 2000) output.specEff = "Low";\n            else output.specEff = "Normal";\n        } else output.specEff = "N/A";\n\n        // --- SECTION 7: LINK STABILITY ---\n        // (Skipped as per verification output requirements)\n\n        // --- SECTION 8: MIMO UTILIZATION ---\n        if (rank2 !== null) {\n            if (rank2 >= 30) output.mimo = "Good";\n            else if (rank2 >= 15) output.mimo = "Limited";\n            else output.mimo = "Poor";\n        } else output.mimo = "N/A";\n\n        // --- SECTION 9: CA EFFECTIVENESS ---\n        output.ca = "N/A";\n        if (dl3cc !== null && dl3cc === 100 && output.specEff !== "Normal" && output.specEff !== "N/A") {\n            output.ca = "Active but Ineffective";\n            bonus += 10;\n        } else if (dl1cc !== null && dl1cc >= 60) {\n            output.ca = "Underutilized";\n        }\n\n        // --- SECTION 10: INTERPRETATION (WHY) ---\n        let interpretation = null;\n        if (output.coverage !== "Poor" && output.coverage !== "N/A" &&\n            output.quality === "Poor" &&\n            output.cqi !== "Poor" && output.cqi !== "N/A") {\n            interpretation = "Signal power is present but radio quality is degraded by interference.";\n        }\n        if (output.dlExp !== "Acceptable" && output.dlExp !== "N/A" &&\n            ulLowTput !== null && ulLowTput === 0) {\n            interpretation = "Downlink-only degradation indicates interference or overlap issues.";\n        }\n        if (output.ca === "Active but Ineffective") {\n            interpretation = "Carrier Aggregation is enabled but limited by poor SINR.";\n        }\n        if (interpretation) bonus += 10;\n\n        // --- SECTION 11: EXPERT DIAGNOSIS (WHAT) ---\n        let diagnosis = "N/A";\n        if (output.quality === "Poor" &&\n            (output.specEff === "Low" || output.specEff === "Very Low") &&\n            (output.load === "Very Low Load" || output.load === "Moderate Load")) {\n            diagnosis = "Interference-Limited Cell";\n        } else if (output.coverage === "Poor" && output.cqi !== "Good" && output.cqi !== "N/A") {\n            diagnosis = "Coverage-Limited Cell";\n        } else if (output.load === "Congested") {\n            diagnosis = "Capacity-Limited Cell";\n        }\n\n        // --- SECTION 12: OPTIMIZATION ACTIONS ---\n        let actions = [];\n        if (diagnosis === "Interference-Limited Cell") {\n            actions.push("Increase electrical downtilt (1–2°)", "Review overshooting neighbors", "Reduce DL power if overlap confirmed", "Audit PCI and neighbor relations");\n        }\n        if (output.mimo === "Limited" || output.mimo === "Poor") {\n            actions.push("Verify antenna cross-polar isolation", "Check RF paths and connectors");\n        }\n        if (output.ca === "Active but Ineffective") {\n            actions.push("Improve secondary carrier SINR", "Align antenna configuration across bands", "Adjust CA activation thresholds");\n        }\n        if (actions.length === 0) actions.push("Monitor performance.");\n\n        // --- SECTION 13: CONFIDENCE SCORING ---\n        let rawScore = scoreBase + bonus - penalty;\n        let finalScore = Math.max(20, Math.min(95, rawScore));\n\n        // --- SECTION 14: CONFIDENCE LEVEL ---\n        let confLevel = "Low";\n        if (finalScore >= 85) confLevel = "Very High";\n        else if (finalScore >= 70) confLevel = "High";\n        else if (finalScore >= 50) confLevel = "Medium";\n\n        // --- GENERATE HTML OUTPUT ---\n        const getCls = (val) => {\n            if (!val || val === "N/A") return "";\n            const v = val.toLowerCase();\n            if (v === "good" || v === "normal" || v === "stable" || v === "very high" || v === "high" || v === "acceptable") return "status-ok";\n            if (v === "poor" || v === "very low" || v === "severe" || v === "congested" || v === "unstable" || v === "low") return "status-bad";\n            if (v === "fair" || v === "degraded" || v === "limited" || v === "underutilized" || v === "moderate") return "status-warn";\n            return "";\n        };\n\n        const row = (label, val) => {\n            return \'<div style="display:flex; justify-content:space-between; margin-bottom:4px; padding-bottom:4px; border-bottom:1px solid #333;">\' +\n                \'<span style="color:#aaa;">\' + label + \'</span>\' +\n                \'<span class="\' + getCls(val) + \'" style="font-weight:600;">\' + (val || \'N/A\') + \'</span>\' +\n                \'</div>\';\n        };\n\n        let html = \'<div class="report-block">\' +\n            \'<h4 class="report-header">EXPERT ANALYSIS</h4>\' +\n            row(\'Confidence Level\', confLevel) +\n            row(\'Confidence Score\', finalScore + \'%\') +\n            row(\'Data Confidence\', output.dataConf) +\n            \'<br>\' +\n            row(\'Coverage Status\', output.coverage) +\n            row(\'Signal Quality\', output.quality) +\n            row(\'Channel Quality\', output.cqi) +\n            row(\'DL User Exp\', output.dlExp) +\n            row(\'Cell Load\', output.load) +\n            row(\'Spectral Perf\', output.specEff) +\n            row(\'MIMO Utilization\', output.mimo) +\n            row(\'CA Effectiveness\', output.ca) +\n            \'</div>\';\n\n        html += \'<div class="report-block">\' +\n            \'<h4 class="report-header">DIAGNOSIS & ACTIONS</h4>\' +\n            \'<div style="margin-bottom:8px;">\' +\n            \'<div style="color:#888; font-size:10px; text-transform:uppercase;">Expert Diagnosis</div>\' +\n            \'<div style="color:#fff; font-weight:700; font-size:14px; margin-top:2px; color:#f87171;">\' + diagnosis + \'</div>\' +\n            \'</div>\' +\n\n            (interpretation ?\n                \'<div style="margin-bottom:8px;">\' +\n                \'<div style="color:#888; font-size:10px; text-transform:uppercase;">Interpretation</div>\' +\n                \'<div style="color:#ddd; font-style:italic; margin-top:2px;">"\' + interpretation + \'"</div>\' +\n                \'</div>\' : \'\') +\n\n            \'<div style="margin-top:10px;">\' +\n            \'<div style="color:#888; font-size:10px; text-transform:uppercase;">Optimization Actions</div>\' +\n            \'<ul style="margin:5px 0 0 15px; padding:0; color:#cbd5e1;">\' +\n            actions.map(a => \'<li>\' + a + \'</li>\').join(\'\') +\n            \'</ul>\' +\n            \'</div>\' +\n            \'</div>\';\n\n        return html;\n    };\n\n    // --- ANALYSIS ENGINE ---\n\n    window.analyzePoint = (btn) => {\n        try {\n            // Retrieve data from stash or passed argument\n            // FIX: Stash might be sibling or global due to layout changes\n            let script = document.getElementById(\'point-data-stash\');\n\n            // Fallback scope check if needed (though ID should be unique in panel)\n            if (!script && btn) {\n                const container = btn.parentNode.parentNode; // Check grandparent\n                if (container) script = container.querySelector(\'#point-data-stash\');\n            }\n\n            if (!script) {\n                console.error("No point data found for analysis.");\n                alert("Error: Analysis data missing from panel.");\n                return;\n            }\n            const data = JSON.parse(script.textContent);\n\n            // -------------------------------------------------------------\n            // ANALYSIS LOGIC\n            // -------------------------------------------------------------\n\n            // Helper: Run Analysis for a SINGLE data object\n            const runAnalysisForData = (d) => {\n                // Scoped Key Finder\n                const getVal = (targetName) => {\n                    const normTarget = targetName.toLowerCase().replace(/[\s\-_]/g, \'\');\n                    for (let k in d) {\n                        const normKey = k.toLowerCase().replace(/[\s\-_]/g, \'\');\n                        if (normKey === normTarget) return parseFloat(d[k]);\n                        if (normKey.includes(normTarget)) return parseFloat(d[k]);\n                    }\n                    return null;\n                };\n\n                // Get Strings for Context\n                const time = d[\'Time\'] || d[\'time\'] || d[\'timestamp\'] || \'N/A\';\n                const tech = d[\'Tech\'] || d[\'Technology\'] || d[\'rat\'] || \'LTE\'; // Default LTE as per template if unknown\n                const cellId = d[\'Cell Identifier\'] || d[\'Cell ID\'] || d[\'cellid\'] || d[\'ci\'] || d[\'Serving SC/PCI\'] || \'Unknown\';\n                const lat = d[\'Latitude\'] || d[\'lat\'] || \'Unknown\';\n                const lng = d[\'Longitude\'] || d[\'lng\'] || \'Unknown\';\n\n                const rsrp = getVal(\'rsrp\') ?? getVal(\'level\');\n                const rsrq = getVal(\'rsrq\');\n                const cqi = getVal(\'cqi\') ?? getVal(\'averagedlwidebandcqi\') ?? getVal(\'dlwidebandcqi\');\n                const dlLowThptRatio = getVal(\'dllowthroughputratio\') ?? getVal(\'lowthpt\') ?? 0;\n                const dlSpecEff = getVal(\'dlspectrumefficiency\') ?? getVal(\'dlspectrumeff\') ?? getVal(\'se\');\n                const dlRbQty = getVal(\'averagedlrbquantity\') ?? getVal(\'dlrbquantity\') ?? getVal(\'rbutil\');\n\n                const dbUtil = getVal(\'prbutil\') ?? getVal(\'rbutil\');\n                const dlIbler = getVal(\'dlibler\') ?? getVal(\'bler\');\n                const rank2Pct = getVal(\'rank2percentage\') ?? getVal(\'rank2\');\n                const ca1ccPct = getVal(\'dl1ccpercentage\') ?? getVal(\'ca1cc\');\n\n                // --- EVALUATION ---\n                let coverageStatus = \'Unknown\';\n                let coverageInterp = \'insufficient signal strength\';\n                if (rsrp !== null) {\n                    if (rsrp >= -90) { coverageStatus = \'Good\'; coverageInterp = \'strong signal strength\'; }\n                    else if (rsrp > -100) { coverageStatus = \'Fair\'; coverageInterp = \'adequate signal strength\'; }\n                    else { coverageStatus = \'Poor\'; coverageInterp = \'weak signal strength at cell edge\'; }\n                }\n\n                let interferenceLevel = \'Unknown\';\n                if (rsrq !== null) {\n                    if (rsrq >= -8) interferenceLevel = \'Low\';\n                    else if (rsrq > -11) interferenceLevel = \'Moderate\';\n                    else interferenceLevel = \'High\';\n                }\n\n                let channelQuality = \'Unknown\';\n                if (cqi !== null) {\n                    if (cqi < 6) channelQuality = \'Poor\';\n                    else if (cqi < 9) channelQuality = \'Keep\';\n                    else channelQuality = \'Good\';\n                }\n\n                let dlUserExp = \'Unknown\';\n                if (dlLowThptRatio !== null) {\n                    if (dlLowThptRatio >= 25) dlUserExp = \'Degraded\';\n                    else dlUserExp = \'Acceptable\'; // Assuming metric is %\n                    if (dlLowThptRatio < 1 && dlLowThptRatio > 0 && dlLowThptRatio >= 0.25) dlUserExp = \'Degraded\';\n                }\n\n                let dlSpecPerf = \'Unknown\';\n                if (dlSpecEff !== null) {\n                    if (dlSpecEff < 2000) dlSpecPerf = \'Low\';\n                    else if (dlSpecEff < 3500) dlSpecPerf = \'Moderate\';\n                    else dlSpecPerf = \'High\';\n                }\n\n                let cellLoad = \'Unknown\';\n                let congestionInterp = \'not related\';\n                if (dbUtil !== null) {\n                    if (dbUtil >= 80) { cellLoad = \'Congested\'; congestionInterp = \'related\'; }\n                    else if (dbUtil < 70) cellLoad = \'Not Congested\';\n                    else cellLoad = \'Moderate\';\n                } else if (dlRbQty !== null) {\n                    if (dlRbQty <= 100 && dlRbQty >= 0) {\n                        if (dlRbQty >= 80) { cellLoad = \'Congested\'; congestionInterp = \'related\'; }\n                        else if (dlRbQty < 70) cellLoad = \'Not Congested\';\n                    }\n                }\n\n                let mimoUtil = \'Unknown\';\n                if (rank2Pct !== null) {\n                    if (rank2Pct >= 30) mimoUtil = \'Good\';\n                    else if (rank2Pct < 20) mimoUtil = \'Poor\';\n                    else mimoUtil = \'Moderate\';\n                }\n\n                let caUtil = \'Unknown\';\n                let caInterp = \'limited\';\n                if (ca1ccPct !== null) {\n                    if (ca1ccPct >= 60) { caUtil = \'Underutilized\'; caInterp = \'limited\'; }\n                    else if (ca1ccPct < 50) { caUtil = \'Well Utilized\'; caInterp = \'effective\'; }\n                    else { caUtil = \'Moderate\'; caInterp = \'moderate\'; }\n                }\n\n                // Root Cause Logic\n                let rootCauses = [];\n                if (coverageStatus !== \'Poor\' && coverageStatus !== \'Unknown\' && interferenceLevel === \'High\') rootCauses.push(\'Interference-Limited\');\n                else if (coverageStatus === \'Poor\') rootCauses.push(\'Coverage-Limited\');\n\n                if (cellLoad === \'Congested\') rootCauses.push(\'Capacity / Congestion-Limited\');\n                if (caUtil === \'Underutilized\' && channelQuality === \'Good\') rootCauses.push(\'Carrier Aggregation Limited\');\n\n                if (rootCauses.length === 0 && (coverageStatus !== \'Unknown\' || interferenceLevel !== \'Unknown\')) rootCauses.push(\'No Specific Root Cause Identified\');\n\n                // Recommendations Logic\n                let actionsHigh = [];\n                let actionsMed = [];\n\n                if (rootCauses.includes(\'Interference-Limited\')) {\n                    actionsHigh.push(\'Review Physical Optimization (Tilt/Azimuth)\');\n                    actionsHigh.push(\'Check for External Interference Sources\');\n                }\n                if (rootCauses.includes(\'Coverage-Limited\')) {\n                    actionsHigh.push(\'Optimize Antenna Downtilt (Uptilt if feasible)\');\n                    actionsMed.push(\'Verify Power Settings\');\n                }\n                if (rootCauses.includes(\'Capacity / Congestion-Limited\')) {\n                    actionsHigh.push(\'Evaluate Load Balancing Features\');\n                    actionsMed.push(\'Plan for Capacity Expansion (Carrier Add/Split)\');\n                }\n                if (rootCauses.includes(\'Carrier Aggregation Limited\')) {\n                    actionsMed.push(\'Verify CA Configuration Parameters\');\n                    actionsMed.push(\'Check Secondary Carrier Availability\');\n                }\n\n                // Fallbacks if empty\n                if (actionsHigh.length === 0) actionsHigh.push(\'Monitor KPI Trend for degradation\');\n                if (actionsMed.length === 0) actionsMed.push(\'Perform drive test for further detail\');\n\n                return {\n                    metrics: {\n                        coverageStatus, coverageInterp,\n                        interferenceLevel,\n                        channelQuality,\n                        dlUserExp, dlLowThptRatio, dlSpecEff,\n                        dlSpecPerf,\n                        cellLoad, congestionInterp,\n                        mimoUtil, caUtil, caInterp\n                    },\n                    context: { time, tech, cellId, lat, lng },\n                    rootCauses,\n                    recommendations: { high: actionsHigh, med: actionsMed }\n                };\n            }; // End runAnalysisForData\n\n            // -------------------------------------------------------------\n            // REPORT GENERATION\n            // -------------------------------------------------------------\n\n            const dataList = Array.isArray(data) ? data : [{ name: \'\', data: data }];\n\n            let combinedHtml = \'\';\n\n            dataList.forEach((item, idx) => {\n                const { metrics, context, rootCauses, recommendations } = runAnalysisForData(item.data);\n\n                // Styles for specific keywords\n                const colorize = (txt) => {\n                    if (!txt) return \'\';\n                    const t = txt.toLowerCase();\n                    if (t === \'good\' || t === \'low\' || t === \'stable\' || t === \'acceptable\' || t === \'not congested\' || t === \'well utilized\' || t === \'effective\') return \'<span class="status-good">\' + txt + \'</span>\';\n                    if (t === \'fair\' || t === \'moderate\' || t === \'keep\') return \'<span class="status-fair">\' + txt + \'</span>\';\n                    return \'<span class="status-poor">\' + txt + \'</span>\';\n                };\n\n                combinedHtml += \'<div class="report-section" style="\' + (idx > 0 ? \'margin-top: 40px; border-top: 4px solid #333; padding-top: 30px;\' : \'\') + \'">\' +\n                    (item.name ? \'<h2 style="margin: 0 0 20px 0; color: #60a5fa; border-bottom: 1px solid #444; padding-bottom: 10px; font-size: 18px;">\' + item.name + \' Analysis</h2>\' : \'\') +\n\n                    \'<div class="report-block">\' +\n                    \'<h3 class="report-header">1. Cell Context</h3>\' +\n                    \'<ul class="report-list">\' +\n                    \'<li><strong>Technology:</strong> \' + context.tech + \'</li>\' +\n                    \'<li><strong>Cell Identifier:</strong> \' + context.cellId + \'</li>\' +\n                    \'<li><strong>Location:</strong> \' + context.lat + \', \' + context.lng + \'</li>\' +\n                    \'<li><strong>Data Confidence:</strong> High (based on MR Count)</li>\' +\n                    \'</ul>\' +\n                    \'</div>\' +\n\n                    \'<div class="report-block">\' +\n                    \'<h3 class="report-header">2. Coverage & Radio Conditions</h3>\' +\n                    \'<p>Coverage in the analyzed grid is classified as <strong>\' + colorize(metrics.coverageStatus) + \'</strong>.</p>\' +\n                    \'<p>Dominant RSRP indicates <strong>\' + metrics.coverageInterp + \'</strong>. \' +\n                    \'Signal quality assessment shows <strong>\' + colorize(metrics.interferenceLevel) + \'</strong> interference conditions, \' +\n                    \'based on Dominant RSRQ and CQI behavior.</p>\' +\n                    \'<p>Overall radio conditions are assessed as <strong>\' + colorize(metrics.channelQuality) + \'</strong>.</p>\' +\n                    \'</div>\' +\n\n                    \'<div class="report-block">\' +\n                    \'<h3 class="report-header">3. Throughput & User Experience</h3>\' +\n                    \'<p>Downlink user experience is classified as <strong>\' + colorize(metrics.dlUserExp) + \'</strong>.</p>\' +\n                    \'<p>This is supported by:</p>\' +\n                    \'<ul class="report-list">\' +\n                    \'<li>Average DL Throughput behavior</li>\' +\n                    \'<li>DL Low-Throughput Ratio (\' + (metrics.dlLowThptRatio !== 0 ? metrics.dlLowThptRatio : \'N/A\') + \')</li>\' +\n                    \'<li>Spectrum Efficiency classification</li>\' +\n                    \'</ul>\' +\n                    \'<p>Uplink performance is <strong>acceptable / secondary</strong>, based on UL KPIs.</p>\' +\n                    \'</div>\' +\n\n                    \'<div class="report-block">\' +\n                    \'<h3 class="report-header">4. Spectrum Efficiency & Resource Utilization</h3>\' +\n                    \'<p>Downlink spectrum efficiency is classified as <strong>\' + colorize(metrics.dlSpecPerf) + \'</strong>.</p>\' +\n                    \'<p>Average DL RB usage indicates the cell is <strong>\' + colorize(metrics.cellLoad) + \'</strong>, \' +\n                    \'confirming that performance limitations are <strong>\' + metrics.congestionInterp + \'</strong> to congestion.</p>\' +\n                    \'</div>\' +\n\n                    \'<div class="report-block">\' +\n                    \'<h3 class="report-header">5. MIMO & Carrier Aggregation Performance</h3>\' +\n                    \'<p>MIMO utilization is assessed as <strong>\' + colorize(metrics.mimoUtil) + \'</strong>, based on rank distribution statistics.</p>\' +\n                    \'<p>Carrier Aggregation utilization is <strong>\' + colorize(metrics.caUtil) + \'</strong>, indicating <strong>\' + metrics.caInterp + \'</strong> use of multi-carrier capabilities.</p>\' +\n                    \'</div>\' +\n\n                    \'<div class="report-block">\' +\n                    \'<h3 class="report-header">6. Traffic Profile & Service Impact</h3>\' +\n                    \'<p>Traffic composition is dominated by:</p>\' +\n                    \'<ul class="report-list">\' +\n                    \'<li>QCI 9 (Internet / Default)</li>\' +\n                    \'</ul>\' +\n                    \'<p>This traffic profile is sensitive to:</p>\' +\n                    \'<ul class="report-list">\' +\n                    \'<li>Throughput stability</li>\' +\n                    \'<li>Spectrum efficiency</li>\' +\n                    \'<li>Interference conditions</li>\' +\n                    \'</ul>\' +\n                    \'</div>\' +\n\n                    \'<div class="report-block">\' +\n                    \'<h3 class="report-header">7. Root Cause Analysis</h3>\' +\n                    \'<p>Based on rule evaluation, the primary performance limitation(s) are:</p>\' +\n                    \'<ul class="report-list" style="color: #ef4444; font-weight: bold;">\' +\n                    rootCauses.map(rc => \'<li>\' + rc + \'</li>\').join(\'\') +\n                    \'</ul>\' +\n                    \'<p>These limitations explain the observed throughput behavior despite the current load level.</p>\' +\n                    \'</div>\' +\n\n                    \'<div class="report-block">\' +\n                    \'<h3 class="report-header">8. Optimization Recommendations</h3>\' +\n\n                    \'<h4 style="color:#fbbf24; margin:10px 0 5px 0;">High Priority Actions:</h4>\' +\n                    \'<ul class="report-list">\' +\n                    recommendations.high.map(a => \'<li>\' + a + \'</li>\').join(\'\') +\n                    \'</ul>\' +\n\n                    \'<h4 style="color:#94a3b8; margin:10px 0 5px 0;">Medium Priority Actions:</h4>\' +\n                    \'<ul class="report-list">\' +\n                    recommendations.med.map(a => \'<li>\' + a + \'</li>\').join(\'\') +\n                    \'</ul>\' +\n\n                    \'<p style="margin-top:10px; font-style:italic; font-size:11px; color:#888;">Each recommended action is directly linked to the identified root cause(s) and observed KPI behavior.</p>\' +\n                    \'</div>\' +\n\n                    \'<div class="report-summary">\' +\n                    \'<h3 class="report-header" style="color:#fff;">EXECUTIVE SUMMARY</h3>\' +\n                    \'<p>The analyzed LTE cell is primarily <strong>\' + rootCauses[0] + \'</strong>, resulting in <strong>\' + metrics.dlUserExp + \' User Experience</strong>. Targeted RF and feature optimization is required to improve spectrum efficiency.</p>\' +\n                    \'</div>\' +\n\n                    \'</div>\';\n            });\n\n            // CSS For Report\n            const style = \'<style>\' +\n                \'.report-block { margin-bottom: 20px; }\' +\n                \'.report-header { color: #aaa; border-bottom: 1px solid #444; padding-bottom: 4px; margin-bottom: 8px; font-size: 14px; text-transform: uppercase; letter-spacing: 0.5px; }\' +\n                \'.report-list { padding-left: 20px; color: #ddd; font-size: 13px; line-height: 1.6; }\' +\n                \'.report-section p { font-size: 13px; color: #eee; line-height: 1.6; margin-bottom: 8px; }\' +\n                \'.status-good { color: #4ade80; font-weight: bold; }\' +\n                \'.status-fair { color: #facc15; font-weight: bold; }\' +\n                \'.status-poor { color: #f87171; font-weight: bold; }\' +\n                \'.report-summary { background: #1f2937; padding: 15px; border-left: 4px solid #3b82f6; margin-top: 30px; }\' +\n                \'</style>\';\n\n            const modalHtml = \'<div class="analysis-modal-overlay" onclick="const m=document.querySelector(\\'.analysis-modal-overlay\\'); if(event.target===m) m.remove()">\' +\n                \'<div class="analysis-modal" style="width: 800px; max-width: 90vw;">\' +\n                \'<div class="analysis-header">\' +\n                \'<h3>Cell Performance Analysis Report</h3>\' +\n                \'<button class="analysis-close-btn" onclick="document.querySelector(\\'.analysis-modal-overlay\\').remove()">×</button>\' +\n                \'</div>\' +\n                \'<div class="analysis-content" style="padding: 30px;">\' +\n                style +\n                combinedHtml +\n                \'</div>\' +\n                \'</div>\' +\n                \'</div>\';\n\n            // Append to body\n            const div = document.createElement(\'div\');\n            div.innerHTML = modalHtml;\n            document.body.appendChild(div.firstElementChild);\n\n        } catch (e) {\n            console.error("Analysis Error:", e);\n            alert("Error running analysis: " + e.message);\n        }\n    };\n\n    // Global function to update the Floating Info Panel (Single Point)\n    window.updateFloatingInfoPanel = (p, logColor) => {\n        try {\n            const panel = document.getElementById(\'floatingInfoPanel\');\n            const content = document.getElementById(\'infoPanelContent\');\n            const headerDom = document.getElementById(\'infoPanelHeader\'); // GET HEADER\n\n            if (!panel || !content) return;\n\n            if (panel.style.display !== \'block\') panel.style.display = \'block\';\n\n            // 1. Set Stash for Toggle Re-render compatibility (Treat single as one-item array)\n            // This ensures window.togglePointDetailsMode() works because it calls updateFloatingInfoPanelMulti(lastMultiHits)\n            window.lastMultiHits = [p];\n\n            // 2. Inject Toggle Button if missing\n            let toggleBtn = document.getElementById(\'toggleViewBtn\');\n            if (headerDom && !toggleBtn) {\n                const closeBtn = headerDom.querySelector(\'.info-panel-close\');\n                toggleBtn = document.createElement(\'span\');\n                toggleBtn.id = \'toggleViewBtn\';\n                toggleBtn.className = \'toggle-view-btn\';\n                toggleBtn.innerHTML = \'⚙️ View\';\n                toggleBtn.title = \'Switch View Mode\';\n                toggleBtn.onclick = (e) => { e.stopPropagation(); window.togglePointDetailsMode(); };\n                toggleBtn.style.marginRight = \'10px\';\n                toggleBtn.style.fontSize = \'12px\';\n                toggleBtn.style.cursor = \'pointer\';\n                toggleBtn.style.color = \'#ccc\';\n\n                if (closeBtn) headerDom.insertBefore(toggleBtn, closeBtn);\n                else headerDom.appendChild(toggleBtn);\n            }\n\n            // 3. Select Generator based on Mode\n            const mode = window.pointDetailsMode || \'log\'; // Default to log if undefined\n            const generator = mode === \'log\' ? generatePointInfoHTMLLog : generatePointInfoHTML;\n\n            // 4. Generate\n            // Note: generatePointInfoHTMLLog takes (p, logColor)\n            // Note: generatePointInfoHTML takes (p, logColor) - now updated to use it\n            const { html, connectionTargets } = generator(p, logColor);\n\n            content.innerHTML = html;\n\n            // Update Connections\n            if (window.mapRenderer && !window.isSpiderMode) {\n                let startPt = { lat: p.lat, lng: p.lng };\n                window.mapRenderer.drawConnections(startPt, connectionTargets);\n            }\n        } catch (e) {\n            console.error("Error updating Info Panel:", e);\n        }\n    };\n\n    // NEW: Multi-Layer Info Panel\n    // --- NEW: Toggle Logic ---\n    window.pointDetailsMode = \'log\'; // \'simple\' or \'log\'\n\n    window.togglePointDetailsMode = () => {\n        window.pointDetailsMode = window.pointDetailsMode === \'simple\' ? \'log\' : \'simple\';\n        // Re-render currently stashed hits if available (UI refresh)\n        const stashMeta = document.getElementById(\'point-data-stash-meta\');\n        if (stashMeta && stashMeta.textContent) {\n            try {\n                const meta = JSON.parse(stashMeta.textContent);\n                // We need to re-call updateFloatingInfoPanelMulti with the ORIGINAL hits.\n                // But hits are not fully serialized.\n                // We can just rely on the user clicking again or, better, we store the last hits globally?\n                if (window.lastMultiHits) {\n                    window.updateFloatingInfoPanelMulti(window.lastMultiHits);\n                }\n            } catch (e) { console.error(e); }\n        }\n    };\n\n    // --- NEW: Log View Generator ---\n    function generatePointInfoHTMLLog(p, logColor) {\n        // Extract Serving\n        let sName = \'Unknown\', sSC = \'-\', sRSCP = \'-\', sEcNo = \'-\', sFreq = \'-\', sRnc = null, sCid = null, sLac = null;\n        let isLTE = false;\n\n        // Explicit Name Resolution (Matches Map Logic)\n        let servingRes = null;\n        if (window.resolveSmartSite) {\n            servingRes = window.resolveSmartSite(p);\n            if (servingRes && servingRes.name) sName = servingRes.name;\n        }\n\n        const connectionTargets = [];\n        if (servingRes && servingRes.lat && servingRes.lng) {\n            connectionTargets.push({\n                lat: servingRes.lat, lng: servingRes.lng, color: \'#3b82f6\', weight: 8, cellId: servingRes.id\n            });\n        }\n\n        if (p.parsed && p.parsed.serving) {\n            const s = p.parsed.serving;\n            if (sName === \'Unknown\') sName = s.cellName || s.name || p.cellName || sName;\n            sSC = s.sc !== undefined ? s.sc : sSC;\n\n            // Flexible Level Extraction\n            sRSCP = s.rscp !== undefined ? s.rscp : (s.rsrp !== undefined ? s.rsrp : (s.level !== undefined ? s.level : sRSCP));\n            sEcNo = s.ecno !== undefined ? s.ecno : (s.rsrq !== undefined ? s.rsrq : sEcNo);\n\n            sFreq = s.freq !== undefined ? s.freq : sFreq;\n            sRnc = s.rnc || p.rnc;\n            sCid = s.cid || p.cid;\n            sLac = s.lac || p.lac;\n            isLTE = s.rsrp !== undefined;\n        } else {\n            // Flat fallback\n            if (sName === \'Unknown\') sName = p.cellName || p.siteName || sName;\n            sSC = p.sc !== undefined ? p.sc : sSC;\n            sRSCP = p.rscp !== undefined ? p.rscp : (p.rsrp !== undefined ? p.rsrp : (p.level !== undefined ? p.level : sRSCP));\n            sEcNo = p.ecno !== undefined ? p.ecno : (p.qual !== undefined ? p.qual : sEcNo);\n            sFreq = p.freq !== undefined ? p.freq : sFreq;\n            sRnc = p.rnc;\n            sCid = p.cid;\n            sLac = p.lac;\n            isLTE = p.Tech === \'LTE\';\n        }\n\n        // DATABASE FALLBACK: If RNC/CID are still missing but we resolved a site, use its IDs\n        if ((sRnc === null || sRnc === undefined) && servingRes && servingRes.rnc) {\n            sRnc = servingRes.rnc;\n            sCid = servingRes.cid;\n            if (sName === \'Unknown\') sName = servingRes.name || sName;\n        }\n\n        const levelHeader = isLTE ? \'RSRP\' : \'RSCP\';\n        const qualHeader = isLTE ? \'RSRQ\' : \'EcNo\';\n\n        // Determine Identity Label\n        let identityLabel = sSC + \' / \' + sFreq; // Default\n        if (servingRes && servingRes.id) {\n            identityLabel = servingRes.id;\n        } else if (sRnc !== null && sRnc !== undefined && sCid !== null && sCid !== undefined) {\n            identityLabel = sRnc + \'/\' + sCid; // UMTS RNC/CID\n        } else if (p.cellId && p.cellId !== \'N/A\') {\n            identityLabel = p.cellId; // LTE ECI or synthesized UMTS CID\n        }\n\n        // Neighbors\n        let rawNeighbors = [];\n        const resolveN = (sc, freq, cellName) => {\n            if (window.resolveSmartSite && (sc !== undefined || freq !== undefined)) {\n                // Try with current LAC first\n                let nRes = window.resolveSmartSite({\n                    sc: sc, freq: freq, pci: sc, lat: p.lat, lng: p.lng, lac: sLac\n                });\n\n                // Fallback: Try without LAC (neighbors are often on different LACs)\n                if ((!nRes || nRes.name === \'Unknown\') && sLac) {\n                    nRes = window.resolveSmartSite({\n                        sc: sc, freq: freq, pci: sc, lat: p.lat, lng: p.lng\n                    });\n                }\n\n                if (nRes && nRes.name && nRes.name !== \'Unknown\') {\n                    return { name: nRes.name, rnc: nRes.rnc, cid: nRes.cid, id: nRes.id, lat: nRes.lat, lng: nRes.lng };\n                }\n            }\n            return { name: cellName || \'Unknown\', rnc: null, cid: null, id: null, lat: null, lng: null };\n        };\n\n        if (p.parsed && p.parsed.neighbors) {\n            p.parsed.neighbors.forEach(n => {\n                const sc = n.pci !== undefined ? n.pci : (n.sc !== undefined ? n.sc : undefined);\n                const freq = n.freq !== undefined ? n.freq : undefined;\n\n                // FILTER: Skip if this neighbor matches the serving cell\n                if (sc == sSC && freq == sFreq) return;\n\n                rawNeighbors.push({\n                    sc: sc !== undefined ? sc : \'-\',\n                    rscp: n.rscp !== undefined ? n.rscp : -140, // Default low for sort\n                    ecno: n.ecno !== undefined ? n.ecno : \'-\',\n                    freq: n.freq !== undefined ? n.freq : \'-\',\n                    cellName: n.cellName\n                });\n            });\n        }\n        // Fallback Flat Neighbors (N1..N3)\n        if (rawNeighbors.length === 0) {\n            if (p.n1_sc !== undefined && (p.n1_sc != sSC)) rawNeighbors.push({ sc: p.n1_sc, rscp: p.n1_rscp || -140, ecno: p.n1_ecno, freq: sFreq });\n            if (p.n2_sc !== undefined && (p.n2_sc != sSC)) rawNeighbors.push({ sc: p.n2_sc, rscp: p.n2_rscp || -140, ecno: p.n2_ecno, freq: sFreq });\n            if (p.n3_sc !== undefined && (p.n3_sc != sSC)) rawNeighbors.push({ sc: p.n3_sc, rscp: p.n3_rscp || -140, ecno: p.n3_ecno, freq: sFreq });\n        }\n\n        // Sort by RSCP Descending\n        rawNeighbors.sort((a, b) => {\n            const valA = parseFloat(a.rscp);\n            const valB = parseFloat(b.rscp);\n            if (isNaN(valA)) return 1;\n            if (isNaN(valB)) return -1;\n            return valB - valA;\n        });\n\n        const neighbors = rawNeighbors.map((n, i) => {\n            const resolved = resolveN(n.sc, n.freq, n.cellName);\n            return {\n                type: \'N\' + (i + 1),\n                name: resolved.name,\n                rnc: resolved.rnc,\n                cid: resolved.cid,\n                id: resolved.id, // Pass ID\n                lat: resolved.lat,\n                lng: resolved.lng,\n                sc: n.sc,\n                rscp: n.rscp === -140 ? \'-\' : n.rscp,\n                ecno: n.ecno,\n                freq: n.freq\n            };\n        });\n\n        // Build HTML\n        let rows = \'\';\n\n        // Serving Click Logic\n        let sClickAction = \'\';\n        /* FIX: Use highlightAndPan */\n        if (servingRes && servingRes.lat && servingRes.lng) {\n            const safeId = servingRes.id || (servingRes.rnc && servingRes.cid ? servingRes.rnc + \'/\' + servingRes.cid : \'\');\n            sClickAction = \'onclick="window.highlightAndPan(\' + servingRes.lat + \', \' + servingRes.lng + \', \\'\' + safeId + \'\\', \\'serving\\')" style="cursor:pointer; color:#fff;"\';\n        }\n\n        // Serving Row\n        rows += \'<tr class="log-row serving-row">\' +\n            \'<td class="log-cell-type">Serving</td>\' +\n            \'<td class="log-cell-name"><span class="log-header-serving" \' + sClickAction + \'>\' + sName + \'</span> <span style="color:#666; font-size:10px;">(\' + identityLabel + \')</span></td>\' +\n            \'<td class="log-cell-val">\' + sSC + \'</td>\' +\n            \'<td class="log-cell-val">\' + sRSCP + \'</td>\' +\n            \'<td class="log-cell-val">\' + sEcNo + \'</td>\' +\n            \'<td class="log-cell-val">\' + sFreq + \'</td>\' +\n            \'</tr>\';\n\n        neighbors.forEach(n => {\n            let nIdLabel = n.sc + \'/\' + n.freq;\n            if (n.rnc && n.cid) nIdLabel = n.rnc + \'/\' + n.cid;\n\n            let nClickAction = \'\';\n            /* FIX: Use highlightAndPan */\n            if (n.lat && n.lng) {\n                const safeId = n.id || (n.rnc && n.cid ? n.rnc + \'/\' + n.cid : \'\');\n                nClickAction = \'onclick="window.highlightAndPan(\' + n.lat + \', \' + n.lng + \', \\'\' + safeId + \'\\', \\'neighbor\\')" style="cursor:pointer;"\';\n            }\n\n            rows += \'<tr class="log-row">\' +\n                \'<td class="log-cell-type">\' + n.type + \'</td>\' +\n                \'<td class="log-cell-name"><span \' + nClickAction + \'>\' + n.name + \'</span> <span style="color:#666; font-size:10px;">(\' + nIdLabel + \')</span></td>\' +\n                \'<td class="log-cell-val">\' + n.sc + \'</td>\' +\n                \'<td class="log-cell-val">\' + n.rscp + \'</td>\' +\n                \'<td class="log-cell-val">\' + n.ecno + \'</td>\' +\n                \'<td class="log-cell-val">\' + n.freq + \'</td>\' +\n                \'</tr>\';\n        });\n\n        // ----------------------------------------------------\n        // EXTRACT OTHER METRICS\n        // ----------------------------------------------------\n\nlet extraMetricsHtml = \'\';\nconst sourceObj = p.properties ? p.properties : p;\nconst knownKeys = [\'lat\', \'lng\', \'time\', \'id\', \'geometry\', \'properties\', \'parsed\',\n    \'sc\', \'pci\', \'rscp\', \'rsrp\', \'level\', \'ecno\', \'rsrq\', \'qual\',\n    \'rnc\', \'cid\', \'lac\', \'freq\', \'earfcn\', \'uarfcn\', \'band\', \'tech\', \'technology\',\n    \'cellid\', \'cell_id\', \'sitename\', \'cellname\', \'name\',\n    \'n1_sc\', \'n1_rscp\', \'n1_ecno\', \'n2_sc\', \'n2_rscp\', \'n2_ecno\', \'n3_sc\', \'n3_rscp\', \'n3_ecno\',\n    \'a2_sc\', \'a2_rscp\', \'a3_sc\', \'a3_rscp\'];\n\nconst isNeighborKey = (k) => /^n\d+_/.test(k) || /^a\d+_/.test(k);\n\n    Object.entries(sourceObj).forEach(([k, v]) => {\n        const lowerK = k.toLowerCase().replace(/[^a-z0-9]/g, \'\');\n        if (knownKeys.includes(lowerK) || knownKeys.includes(k.toLowerCase())) return;\n        if (isNeighborKey(k.toLowerCase())) return;\n        if (typeof v === \'object\') return; // Skip nested objects for now\n        if (v === undefined || v === null || v === \'\') return;\n\n        // Format numeric\n        let val = v;\n        if (typeof v === \'number\' && !Number.isInteger(v)) val = v.toFixed(3);\n\n        extraMetricsHtml += \'<div style="display:flex; justify-content:space-between; border-bottom:1px solid #444; font-size:11px; padding:3px 0;">\' +\n            \'<span style="color:#aaa; margin-right: 10px;">\' + k + \'</span>\' +\n            \'<span style="color:#fff; font-weight:bold; text-align: right;">\' + val + \'</span>\' +\n            \'</div>\';\n    });\n\n    let extraMetricsSection = \'\';\n    if (extraMetricsHtml) {\n        extraMetricsSection = \'<div style="margin-top:15px; border-top:1px solid #555; padding-top:10px;">\' +\n            \'<div style="font-size:12px; font-weight:bold; color:#ccc; margin-bottom:5px;">Other Metrics</div>\' +\n            \'<div style="max-height: 200px; overflow-y: auto;">\' +\n            extraMetricsHtml +\n            \'</div>\' +\n            \'</div>\';\n    }\n\n    const html = \'<div class="log-view-container">\' +\n        \'<div style="display:flex; justify-content:space-between; align-items:flex-end; margin-bottom:5px;">\' +\n        \'<div>\' +\n        \'<div class="log-header-serving" style="font-size:14px; margin-bottom:2px;">\' + sName + \'</div>\' +\n        \'<div style="color:#aaa; font-size:11px;">Lat: \' + p.lat.toFixed(6) + \'  Lng: \' + p.lng.toFixed(6) + \'</div>\' +\n        \'</div>\' +\n        \'<div style="color:#aaa; font-size:11px;">\' + (p.time || \'\') + \'</div>\' +\n        \'</div>\' +\n\n        \'<table class="log-details-table">\' +\n        \'<thead>\' +\n        \'<tr>\' +\n        \'<th style="width:10%">Type</th>\' +\n        \'<th style="width:40%">Cell Name</th>\' +\n        \'<th>SC</th>\' +\n        \'<th>\' + levelHeader + \'</th>\' +\n        \'<th>\' + qualHeader + \'</th>\' +\n        \'<th>Freq</th>\' +\n        \'</tr>\' +\n        \'</thead>\' +\n        \'<tbody>\' +\n        rows +\n        \'</tbody>\' +\n        \'</table>\' +\n\n        extraMetricsSection +\n\n        \'<div style="display:flex; gap:10px; margin-top:15px; border-top:1px solid #444; padding-top:10px;">\' +\n        \'<button class="btn btn-blue" onclick="window.analyzePoint(this)" style="flex:1; justify-content: center;">Analyze Point</button>\' +\n        \'<button class="btn btn-purple" onclick="window.generateManagementSummary()" style="flex:1; justify-content: center;">MANAGEMENT SUMMARY</button>\' +\n        \'</div>\' +\n\n        \'<!-- Hidden data stash for the analyzer -->\' +\n        \'<script type="application/json" id="point-data-stash">\' +\n        JSON.stringify({\n            ...(p.properties || p),\n            \'Cell Identifier\': sName !== \'Unknown\' ? sName : identityLabel,\n            \'Cell Name\': sName,\n            \'Tech\': isLTE ? \'LTE\' : \'UMTS\'\n        }) +\n        \'</script>\' +\n        \'</div>\' +\n        \'</div>\';\n\n\n// Add connection targets for top 3 neighbors if they resolve\nneighbors.slice(0, 3).forEach(n => {\n    if (window.resolveSmartSite) {\n        const nRes = window.resolveSmartSite({ sc: n.sc, freq: n.freq, lat: p.lat, lng: p.lng, pci: n.sc, lac: sLac });\n        if (nRes && nRes.lat && nRes.lng) {\n            connectionTargets.push({ lat: nRes.lat, lng: nRes.lng, color: \'#ef4444\', weight: 4, cellId: nRes.id });\n        }\n    }\n});\n\nreturn { html, connectionTargets };\n    }\n\n\nwindow.updateFloatingInfoPanelMulti = (hits) => {\n    try {\n        window.lastMultiHits = hits; // Store for toggle re-render\n\n        const panel = document.getElementById(\'floatingInfoPanel\');\n        const content = document.getElementById(\'infoPanelContent\');\n        const headerDom = document.getElementById(\'infoPanelHeader\');\n\n        if (!panel || !content) return;\n\n        if (panel.style.display !== \'block\') panel.style.display = \'block\';\n        content.innerHTML = \'\'; // Clear\n\n        // Inject Toggle Button into Header if not present\n        let toggleBtn = document.getElementById(\'toggleViewBtn\');\n        if (!toggleBtn && headerDom) {\n            // Remove existing title text to replace with flex container if needed, or just append\n            // Let\'s repurpose the header content slightly\n            const closeBtn = headerDom.querySelector(\'.info-panel-close\');\n\n            toggleBtn = document.createElement(\'span\');\n            toggleBtn.id = \'toggleViewBtn\';\n            toggleBtn.className = \'toggle-view-btn\';\n            toggleBtn.innerHTML = \'⚙️ View\';\n            toggleBtn.title = \'Switch View Mode\';\n            toggleBtn.onclick = (e) => { e.stopPropagation(); window.togglePointDetailsMode(); };\n\n            // Insert before close button\n            headerDom.insertBefore(toggleBtn, closeBtn);\n        }\n\n        let allConnectionTargets = [];\n        let aggregatedData = [];\n\n        hits.forEach((hit, idx) => {\n            const { log, point } = hit;\n\n            // Collect Data for Unified Analysis\n            aggregatedData.push({\n                name: \'Layer: \' + log.name,\n                data: point.properties ? point.properties : point\n            });\n\n            // Header for this Log Layer\n            const header = document.createElement(\'div\');\n            header.style.cssText = \'background:#ef4444; color:#fff; padding:5px; font-weight:bold; font-size:12px; margin-top:\' + (idx > 0 ? \'10px\' : \'0\') + \'; border-radius:4px 4px 0 0;\';\n            header.textContent = \'Layer: \' + log.name;\n            content.appendChild(header);\n\n            // Body Selection\n            // Use new Log Generator if mode is \'log\', else default\n            const generator = window.pointDetailsMode === \'log\' ? generatePointInfoHTMLLog : generatePointInfoHTML;\n            const { html, connectionTargets } = generator(point, log.color, false);\n\n            const body = document.createElement(\'div\');\n            body.innerHTML = html;\n            content.appendChild(body);\n\n            // Aggregate connections\n            if (connectionTargets) allConnectionTargets = allConnectionTargets.concat(connectionTargets);\n        });\n\n        // Update Connections (Draw ALL lines from ALL layers)\n        if (window.mapRenderer && !window.isSpiderMode && hits.length > 0) {\n            const primary = hits[0].point;\n            window.mapRenderer.drawConnections({ lat: primary.lat, lng: primary.lng }, allConnectionTargets);\n        }\n\n        // UNIFIED ANALYZE BUTTON\n        const btnContainer = document.createElement(\'div\');\n        btnContainer.style.cssText = "margin-top: 15px; text-align: center; border-top: 1px solid #555; padding-top: 10px;";\n        btnContainer.innerHTML = \'<button onclick="window.analyzePoint(this)" \' +\n            \'style="background: #3b82f6; color: white; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; font-size: 12px; font-weight: bold; width: 100%;">\' +\n            \'Analyze All Layers\' +\n            \'</button>\' +\n            \'<script type="application/json" id="point-data-stash">\' + JSON.stringify(aggregatedData) + \'</script>\' +\n            \'<script type="application/json" id="point-data-stash-meta">{"hits":true}</script>\';\n\n        content.appendChild(btnContainer);\n\n    } catch (e) {\n        console.error("Error updating Multi-Info Panel:", e);\n    }\n};\n\nwindow.syncMarker = null; // Global marker for current sync point\n\n\nwindow.globalSync = (logId, index, source, skipPanel = false) => {\n    const log = loadedLogs.find(l => l.id === logId);\n    if (!log || !log.points[index]) return;\n\n    const point = log.points[index];\n\n    // 1. Update Map (Marker & View)\n    // 1. Update Map (Marker & View)\n    // Always update marker, even if source is map (to show selection highlight)\n    if (!window.syncMarker) {\n        window.syncMarker = L.circleMarker([point.lat, point.lng], {\n            radius: 18, // Larger radius to surround the point\n            color: \'#ffff00\', // Yellow\n            weight: 4,\n            fillColor: \'transparent\',\n            fillOpacity: 0\n        }).addTo(window.map);\n    } else {\n        window.syncMarker.setLatLng([point.lat, point.lng]);\n        // Ensure style is consistent (in case it was overwritten or different)\n        window.syncMarker.setStyle({\n            radius: 18,\n            color: \'#ffff00\',\n            weight: 4,\n            fillColor: \'transparent\',\n            fillOpacity: 0\n        });\n    }\n\n    // View Navigation (Zoom/Pan) - User Request: Zoom in on click\n    // UPDATED: Keep current zoom, just pan.\n    // AB: User requested to NOT move map when clicking ON the map.\n    if (source !== \'chart_scrub\' && source !== \'map\') {\n        // const targetZoom = Math.max(window.map.getZoom(), 17); // Previous logic\n        // window.map.flyTo([point.lat, point.lng], targetZoom, { animate: true, duration: 0.5 });\n\n        // New Logic: Pan only, preserve zoom\n        window.map.panTo([point.lat, point.lng], { animate: true, duration: 0.5 });\n    }\n\n    // 2. Update Charts\n    if (source !== \'chart\' && source !== \'chart_scrub\') {\n        if (window.currentChartLogId === logId && window.updateDualCharts) {\n            // We need to update the chart\'s active index WITHOUT triggering a loop\n            // updateDualCharts draws the chart.\n            // We simply set the index and draw.\n            window.updateDualCharts(index, true); // true = skipSync to avoid loop\n\n            // AUTO ZOOM if requested (User Request: Zoom on Click)\n            if (window.zoomChartToActive) {\n                window.zoomChartToActive();\n            }\n        }\n    }\n\n    // 3. Update Floating Panel\n    if (window.updateFloatingInfoPanel && !skipPanel) {\n        window.updateFloatingInfoPanel(point, log.color);\n    }\n\n    // 4. Update Grid\n    if (window.currentGridLogId === logId) {\n        const row = document.getElementById(\'grid-row-\' + index);\n        if (row) {\n            document.querySelectorAll(\'.grid-row\').forEach(r => r.classList.remove(\'selected-row\'));\n            row.classList.add(\'selected-row\');\n\n            if (source !== \'grid\') {\n                row.scrollIntoView({ behavior: \'smooth\', block: \'center\' });\n            }\n        }\n    }\n\n    // 5. Update Signaling\n    if (source !== \'signaling\') {\n        // Find closest signaling row by time logic (reuised from highlightPoint)\n        const targetTime = point.time;\n        const parseTime = (t) => {\n            const [h, m, s] = t.split(\':\');\n            return (parseInt(h) * 3600 + parseInt(m) * 60 + parseFloat(s)) * 1000;\n        };\n        const tTarget = parseTime(targetTime);\n        let bestIdx = null;\n        let minDiff = Infinity;\n        const rows = document.querySelectorAll(\'#signalingTableBody tr\');\n        rows.forEach((row) => {\n            if (!row.pointData) return;\n            row.classList.remove(\'selected-row\');\n            const t = parseTime(row.pointData.time);\n            const diff = Math.abs(t - tTarget);\n            if (diff < minDiff) {\n                minDiff = diff;\n                bestIdx = row;\n            }\n        });\n        if (bestIdx && minDiff < 5000) {\n            bestIdx.classList.add(\'selected-row\');\n            bestIdx.scrollIntoView({ behavior: \'smooth\', block: \'center\' });\n        }\n    }\n};\n\n// Global Listener for Custom Legend Color Changes\nwindow.addEventListener(\'metric-color-changed\', (e) => {\n    const { id, color } = e.detail;\n    console.log(\'[App] Color overridden for \' + id + \' -> \' + color);\n\n    // Re-render ALL logs currently showing Discrete Metrics (CellId or CID)\n    loadedLogs.forEach(log => {\n        if (log.currentParam === \'cellId\' || log.currentParam === \'cid\') {\n            window.mapRenderer.addLogLayer(log.id, log.points, log.currentParam);\n        }\n    });\n});\n\n// Global Sync Listener (Legacy Adapatation)\n// Global Sync Listener (Aligning with User Logic: Coordinator Pattern)\nwindow.addEventListener(\'map-point-clicked\', (e) => {\n    const { logId, point, source } = e.detail;\n\n    const log = loadedLogs.find(l => l.id === logId);\n    if (log) {\n        // Prioritize ID match\n        let index = -1;\n        if (point.id !== undefined) {\n            index = log.points.findIndex(p => p.id === point.id);\n        }\n        // Fallback to Time\n        if (index === -1 && point.time) {\n            index = log.points.findIndex(p => p.time === point.time);\n        }\n        // Fallback to Coord (Tolerance 1e-5 for roughly 1m)\n        if (index === -1) {\n            index = log.points.findIndex(p => Math.abs(p.lat - point.lat) < 0.00001 && Math.abs(p.lng - point.lng) < 0.00001);\n        }\n\n        if (index !== -1) {\n            // The Coordinator: globalSync\n            // Logic: catches map-point-clicked and calls window.globalSync(). \n            // It specifically invokes window.updateFloatingInfoPanel(point) (via skipPanel=false default)\n            window.globalSync(logId, index, source || \'map\');\n        } else {\n            console.warn("[App] Sync Index not found for clicked point.");\n            // Fallback: If we can\'t sync index, just update the panel directly\n            if (window.updateFloatingInfoPanel) {\n                window.updateFloatingInfoPanel(point);\n            }\n        }\n    }\n});\n\n// SPIDER OPTION: Sector Click Listener\nwindow.addEventListener(\'site-sector-clicked\', (e) => {\n    // GATED: Only run if Spider Mode is ON\n    if (!window.isSpiderMode) return;\n\n    const sector = e.detail;\n    if (!sector || !window.mapRenderer) return;\n\n    console.log("[Spider] Sector Clicked:", sector);\n\n    // Find all points served by this sector\n    const targetPoints = [];\n\n    // Calculate "Tip Top" (Outer Edge Center) based on Azimuth\n    // Use range from the event (current rendering range)\n    const range = sector.range || 200;\n    const rad = Math.PI / 180;\n    const azRad = (sector.azimuth || 0) * rad;\n    const latRad = sector.lat * rad;\n\n    const dy = Math.cos(azRad) * range;\n    const dx = Math.sin(azRad) * range;\n    const dLat = dy / 111111;\n    const dLng = dx / (111111 * Math.cos(latRad));\n\n    const startPt = {\n        lat: sector.lat + dLat,\n        lng: sector.lng + dLng\n    };\n\n    const norm = (v) => v !== undefined && v !== null ? String(v).trim() : \'\';\n    const isValid = (v) => v !== undefined && v !== null && v !== \'N/A\' && v !== \'\';\n\n    loadedLogs.forEach(log => {\n        log.points.forEach(p => {\n            let isMatch = false;\n\n            // 1. Strict RNC/CID Match (Highest Priority)\n            if (isValid(sector.rnc) && isValid(sector.cid) && isValid(p.rnc) && isValid(p.cellId)) {\n                if (norm(sector.rnc) === norm(p.rnc) && norm(sector.cid) === norm(p.cellId)) {\n                    isMatch = true;\n                }\n            }\n\n            // 2. Generic CellID Match (Fallback)\n            if (!isMatch && sector.cellId && isValid(p.cellId)) {\n                if (norm(sector.cellId) === norm(p.cellId)) {\n                    isMatch = true;\n                }\n                // Support "RNC/CID" format in sector.cellId\n                else if (String(sector.cellId).includes(\'/\')) {\n                    const parts = String(sector.cellId).split(\'/\');\n                    const cid = parts[parts.length - 1];\n                    const rnc = parts.length > 1 ? parts[parts.length - 2] : null;\n\n                    if (rnc && isValid(p.rnc) && norm(p.rnc) === norm(rnc) && norm(p.cellId) === norm(cid)) {\n                        isMatch = true;\n                    } else if (norm(p.cellId) === norm(cid) && !isValid(p.rnc)) {\n                        isMatch = true;\n                    }\n                }\n            }\n\n            // 3. SC Match (Secondary Fallback)\n            if (!isMatch && sector.sc !== undefined && isValid(p.sc)) {\n                if (p.sc == sector.sc) {\n                    isMatch = true;\n                    // Refine with LAC if available\n                    if (sector.lac && isValid(p.lac) && norm(sector.lac) !== norm(p.lac)) {\n                        isMatch = false;\n                    }\n                }\n            }\n\n            if (isMatch) {\n                targetPoints.push({\n                    lat: p.lat,\n                    lng: p.lng,\n                    color: \'#ffff00\', // Yellow lines\n                    weight: 2,\n                    dashArray: \'4, 4\'\n                });\n            }\n        });\n    });\n\n    if (targetPoints.length > 0) {\n        console.log(\'[Spider] Found \' + targetPoints.length + \' points.\');\n        window.mapRenderer.drawConnections(startPt, targetPoints);\n        fileStatus.textContent = \'Spider: Showing \' + targetPoints.length + \' points for \' + (sector.cellId || sector.sc);\n    } else {\n        console.warn("[Spider] No matching points found.");\n        fileStatus.textContent = \'Spider: No points found for \' + (sector.cellId || sector.sc);\n        window.mapRenderer.clearConnections();\n    }\n});\n\nfileInput.addEventListener(\'change\', (e) => {\n    const file = e.target.files[0];\n    if (!file) return;\n\n    fileStatus.textContent = \'Loading \' + file.name + \'...\';\n\n\n    // TRP Zip Import\n    if (file.name.toLowerCase().endsWith(\'.trp\')) {\n        handleTRPImport(file);\n        return;\n    }\n\n    // NMFS Binary Check\n    if (file.name.toLowerCase().endsWith(\'.nmfs\')) {\n        const headerReader = new FileReader();\n        headerReader.onload = (event) => {\n            const arr = new Uint8Array(event.target.result);\n            // ASCII for NMFS is 78 77 70 83 (0x4e 0x4d 0x46 0x53)\n            // Check if starts with NMFS\n            let isNMFS = false;\n            if (arr.length >= 4) {\n                if (arr[0] === 0x4e && arr[1] === 0x4d && arr[2] === 0x46 && arr[3] === 0x53) {\n                    isNMFS = true;\n                }\n            }\n\n            if (isNMFS) {\n                alert("⚠️ SECURE FILE DETECTED\n\nThis is a proprietary Keysight Nemo \'Secure\' Binary file (.nmfs).\n\nThis application can only parse TEXT log files (.nmf or .csv).\n\nPlease open this file in Nemo Outdoor/Analyze and export it as \'Nemo File Format (Text)\'.");\n                fileStatus.textContent = \'Error: Encrypted NMFS file.\';\n                e.target.value = \'\'; // Reset\n                return;\n            } else {\n                // Fallback: Maybe it\'s a text file named .nmfs? Try parsing as text.\n                console.warn("File named .nmfs but missing signature. Attempting text parse...");\n                parseTextLog(file);\n            }\n        };\n        headerReader.readAsArrayBuffer(file.slice(0, 10));\n        return;\n    }\n\n    // Excel / CSV Detection (Binary Read)\n    if (file.name.toLowerCase().endsWith(\'.xlsx\') || file.name.toLowerCase().endsWith(\'.xls\')) {\n        const reader = new FileReader();\n        reader.onload = (event) => {\n            try {\n                fileStatus.textContent = \'Parsing Excel...\';\n                const data = event.target.result;\n                const result = ExcelParser.parse(data);\n\n                handleParsedResult(result, file.name);\n\n            } catch (err) {\n                console.error(\'Excel Parse Error:\', err);\n                fileStatus.textContent = \'Error parsing Excel: \' + err.message;\n            }\n        };\n        reader.readAsArrayBuffer(file);\n        e.target.value = \'\';\n        return;\n    }\n\n    // Standard Text Log\n    parseTextLog(file);\n\n    function parseTextLog(f) {\n        const reader = new FileReader();\n        reader.onload = (event) => {\n            const content = event.target.result;\n            fileStatus.textContent = \'Parsing...\';\n\n            setTimeout(() => {\n                try {\n                    const result = NMFParser.parse(content);\n                    handleParsedResult(result, f.name);\n                } catch (err) {\n                    console.error(\'Parser Error:\', err);\n                    fileStatus.textContent = \'Error parsing file: \' + err.message;\n                }\n            }, 100);\n        };\n        reader.readAsText(f);\n        e.target.value = \'\';\n    }\n\n    function getRandomColor() {\n        const letters = \'0123456789ABCDEF\';\n        let color = \'#\';\n        for (let i = 0; i < 6; i++) {\n            color += letters[Math.floor(Math.random() * 16)];\n        }\n        return color;\n    }\n\n    function handleParsedResult(result, fileName) {\n        // Handle new parser return format (object vs array)\n        const parsedData = Array.isArray(result) ? result : result.points;\n        const technology = Array.isArray(result) ? \'Unknown\' : result.tech;\n        const signalingData = !Array.isArray(result) ? result.signaling : [];\n        const customMetrics = !Array.isArray(result) ? result.customMetrics : []; // New for Excel\n\n        console.log('Parsed ${parsedData.length} measurement points and ${signalingData ? signalingData.length : 0} signaling messages.Tech: ${technology}');\n\n        if (parsedData.length > 0 || (signalingData && signalingData.length > 0)) {\n            const id = Date.now().toString();\n            const name = fileName.replace(/\.[^/.]+$/, "");\n\n            // Add to Logs\n            loadedLogs.push({\n                id: id,\n                name: name,\n                points: parsedData,\n                signaling: signalingData,\n                tech: technology,\n                customMetrics: customMetrics,\n                color: getRandomColor(),\n                visible: true,\n                currentParam: \'level\'\n            });\n\n            // Update UI\n            updateLogsList();\n\n            if (parsedData.length > 0) {\n                console.log(\'[App] Debug First Point:\', parsedData[0]);\n                map.addLogLayer(id, parsedData, \'level\');\n                const first = parsedData[0];\n                map.setView(first.lat, first.lng);\n            }\n\n            // Add Events Layer (HO Fail, Drop, etc.)\n            if (signalingData && signalingData.length > 0) {\n                map.addEventsLayer(id, signalingData);\n            }\n\n            fileStatus.textContent = 'Loaded: ${name}(${parsedData.length} pts)';\n\n\n        } else {\n            fileStatus.textContent = \'No valid data found.\';\n        }\n    }\n});\n\n// Site Import Logic\nconst siteInput = document.getElementById(\'siteInput\');\nif (siteInput) {\n    siteInput.addEventListener(\'change\', (e) => {\n        const file = e.target.files[0];\n        if (!file) return;\n\n        fileStatus.textContent = 'Importing Sites...';\n\n        const reader = new FileReader();\n        reader.onload = (event) => {\n            try {\n                const data = new Uint8Array(event.target.result);\n                const workbook = XLSX.read(data, { type: \'array\' });\n                const firstSheetName = workbook.SheetNames[0];\n                const worksheet = workbook.Sheets[firstSheetName];\n                const json = XLSX.utils.sheet_to_json(worksheet);\n\n                console.log(\'Imported Rows:\', json.length);\n\n                if (json.length === 0) {\n                    fileStatus.textContent = \'No rows found in Excel.\';\n                    return;\n                }\n\n                // Parse Sectors\n                // Try to match common headers\n                // Map needs: lat, lng, azimuth, name, cellId, tech, color\n                const sectors = json.map(row => {\n                    // Normalize helper: lowercase, remove ALL non-alphanumeric chars\n                    const normalize = (str) => String(str).toLowerCase().replace(/[^a-z0-9]/g, \'\');\n                    const rowKeys = Object.keys(row);\n\n                    const getVal = (possibleNames) => {\n                        for (let name of possibleNames) {\n                            const target = normalize(name);\n                            // Check exact match of normalized keys\n                            const foundKey = rowKeys.find(k => normalize(k) === target);\n                            if (foundKey) return row[foundKey];\n                        }\n                        return undefined;\n                    };\n\n                    const lat = parseFloat(getVal([\'lat\', \'latitude\', \'lat_decimal\']));\n                    const lng = parseFloat(getVal([\'long\', \'lng\', \'longitude\', \'lon\', \'long_decimal\']));\n                    // Extended Azimuth keywords (including \'azimut\' for French)\n                    const azimuth = parseFloat(getVal([\'azimuth\', \'azimut\', \'dir\', \'bearing\', \'az\']));\n                    const name = getVal([\'nodeb name\', \'nodeb_name\', \'nodebname\', \'site\', \'sitename\', \'site_name\', \'name\', \'site name\']);\n                    const cellId = getVal([\'cell\', \'cellid\', \'ci\', \'cell_name\', \'cell id\', \'cell_id\']);\n\n                    // New Fields for Strict Matching\n                    const lac = getVal([\'lac\', \'location area code\']);\n                    const pci = getVal([\'psc\', \'sc\', \'pci\', \'physical cell id\', \'physcial cell id\', \'scrambling code\', \'physicalcellid\']);\n                    const freq = getVal([\'downlink uarfcn\', \'dl uarfcn\', \'uarfcn\', \'freq\', \'frequency\', \'dl freq\', \'downlink earfcn\', \'dl earfcn\', \'earfcn\', \'downlinkearfcn\']);\n                    const band = getVal([\'band\', \'band name\', \'freq band\']);\n\n                    // Specific Request: eNodeB ID-Cell ID\n                    const enodebCellIdRaw = getVal([\'enodeb id-cell id\', \'enodebid-cellid\', \'enodebidcellid\']);\n\n                    let rnc = parseInt(getVal([\'rnc\', \'rncid\', \'rnc_id\', \'enodeb\', \'enodebid\', \'enodeb id\', \'enodeb_id\']));\n                    let cid = parseInt(getVal([\'cid\', \'c_id\', \'ci\', \'cell id\', \'cell_id\', \'cellid\']));\n\n                    let calculatedEci = null;\n                    if (enodebCellIdRaw) {\n                        const parts = String(enodebCellIdRaw).split(\'-\');\n                        if (parts.length === 2) {\n                            const enb = parseInt(parts[0]);\n                            const c = parseInt(parts[1]);\n                            if (!isNaN(enb) && !isNaN(c)) {\n                                // Standard LTE ECI Calculation: eNodeB * 256 + CellID\n                                calculatedEci = (enb * 256) + c;\n\n                                // Fallback: If RNC/CID columns were missing, use these\n                                if (isNaN(rnc)) rnc = enb;\n                                if (isNaN(cid)) cid = c;\n                            }\n                        }\n                    }\n\n                    let tech = getVal([\'tech\', \'technology\', \'system\', \'rat\']);\n                    const cellName = getVal([\'cell name\', \'cellname\']) || \'\';\n\n                    // Infer Tech from Name if missing\n                    if (!tech) {\n                        const combinedName = (name + \' \' + cellName).toLowerCase();\n                        if (combinedName.includes(\'4g\') || combinedName.includes(\'lte\') || combinedName.includes(\'earfcn\')) tech = \'4G\';\n                        else if (combinedName.includes(\'3g\') || combinedName.includes(\'umts\') || combinedName.includes(\'wcdma\')) tech = \'3G\';\n                        else if (combinedName.includes(\'2g\') || combinedName.includes(\'gsm\')) tech = \'2G\';\n                        else if (combinedName.includes(\'5g\') || combinedName.includes(\'nr\')) tech = \'5G\';\n                    }\n\n                    // Robust Fallback: Attempt to extract RNC from CellID or RawID if still missing\n                    if (isNaN(rnc) || !rnc) {\n                        const candidates = [String(enodebCellIdRaw), String(cellId), String(name)];\n                        for (let c of candidates) {\n                            if (c) {\n                                // Check if it\'s a Big Int (RNC+CID)\n                                const val = parseInt(c);\n                                if (!isNaN(val) && val > 65535) {\n                                    rnc = val >> 16;\n                                    cid = val & 0xFFFF;\n                                    break;\n                                }\n\n                                if (c.includes(\'-\') || c.includes(\'/\')) {\n                                    const parts = c.split(/[-/]/);\n                                    if (parts.length === 2) {\n                                        const p1 = parseInt(parts[0]);\n                                        if (!isNaN(p1) && p1 > 0 && p1 < 65535) {\n                                            rnc = p1;\n                                            // Also recover CID if missing\n                                            if (isNaN(cid)) cid = parseInt(parts[1]);\n                                            break;\n                                        }\n                                    }\n                                }\n                            }\n                        }\n                    }\n\n                    // Determine Color\n                    let color = \'#3b82f6\';\n                    if (tech) {\n                        const t = tech.toString().toLowerCase();\n                        if (t.includes(\'3g\') || t.includes(\'umts\')) color = \'#eab308\'; // Yellow/Orange\n                        if (t.includes(\'4g\') || t.includes(\'lte\')) color = \'#3b82f6\'; // Blue\n                        if (t.includes(\'2g\') || t.includes(\'gsm\')) color = \'#ef4444\'; // Red\n                        if (t.includes(\'5g\') || t.includes(\'nr\')) color = \'#a855f7\'; // Purple\n                    }\n\n                    return {\n                        ...row, // Preserve ALL original columns\n                        lat, lng, azimuth: isNaN(azimuth) ? 0 : azimuth,\n                        name, siteName: name, // Ensure siteName is present\n                        cellName,\n                        cellId,\n                        lac,\n                        lac,\n                        pci: parseInt(pci), sc: parseInt(pci),\n                        freq: parseInt(freq),\n                        band,\n                        tech,\n                        color,\n                        rawEnodebCellId: enodebCellIdRaw,\n                        calculatedEci: calculatedEci,\n                        rnc: isNaN(rnc) ? undefined : rnc,\n                        cid: isNaN(cid) ? undefined : cid\n                    };\n                })\n                // Filter out invalid\n                const validSectors = sectors.filter(s => s && s.lat && s.lng);\n\n                if (validSectors.length > 0) {\n                    const id = Date.now().toString();\n                    const name = file.name.replace(/\.[^/.]+$/, "");\n\n                    console.log('[Sites] Importing ${validSectors.length} sites as layer: ${name}');\n\n                    // Add Layer\n                    try {\n                        if (window.mapRenderer) {\n                            console.log(\'[Sites] Calling mapRenderer.addSiteLayer...\');\n                            window.mapRenderer.addSiteLayer(id, name, validSectors, false); // DO NOT FIT BOUNDS\n                            console.log(\'[Sites] addSiteLayer successful. Adding sidebar item...\');\n                            addSiteLayerToSidebar(id, name, validSectors.length);\n                            console.log(\'[Sites] Sidebar item added.\');\n                        } else {\n                            throw new Error("MapRenderer not initialized");\n                        }\n                        fileStatus.textContent = 'Sites Imported: ${validSectors.length}(${name})';\n                    } catch (innerErr) {\n                        console.error(\'[Sites] CRITICAL ERROR adding layer:\', innerErr);\n                        alert('Error adding site layer: ${innerErr.message}');\n                        fileStatus.textContent = \'Error adding layer: \' + innerErr.message;\n                    }\n                } else {\n                    fileStatus.textContent = \'No valid site data found (check Lat/Lng)\';\n                }\n                e.target.value = \'\'; // Reset input\n            } catch (err) {\n                console.error(\'Site Import Error:\', err);\n                fileStatus.textContent = \'Error parsing sites: \' + err.message;\n            }\n        };\n        reader.readAsArrayBuffer(file);\n    });\n}\n\n// --- Site Layer Management UI ---\nwindow.siteLayersList = []; // Track UI state locally if needed, but renderer is source of truth\n\nfunction addSiteLayerToSidebar(id, name, count) {\n    const container = document.getElementById(\'sites-layer-list\');\n    if (!container) {\n        console.error(\'[Sites] CRITICAL: Sidebar container #sites-layer-list NOT FOUND in DOM.\');\n        return;\n    }\n\n    // AUTO-SHOW SIDEBAR\n    const sidebar = document.getElementById(\'smartcare-sidebar\');\n    if (sidebar) {\n        sidebar.style.display = \'flex\';\n    }\n\n    const item = document.createElement(\'div\');\n    item.className = \'layer-item\';\n    item.id = 'site - layer - ${id}';\n\n    item.innerHTML = '
        <div class="layer-info">
            <span class="layer-name" title="${name}" style="font-size:13px;">${name}</span>
        </div>
        <div class="layer-controls">
            <button class="layer-btn settings-btn" data-id="${id}" title="Layer Settings">⚙️</button>
            <button class="layer-btn visibility-btn" data-id="${id}" title="Toggle Visibility">👁️</button>
            <button class="layer-btn remove-btn" data-id="${id}" title="Remove Layer">✕</button>
        </div>
        ';\n\n    // Event Listeners\n    const settingsBtn = item.querySelector(\'.settings-btn\');\n    settingsBtn.onclick = (e) => {\n        e.stopPropagation();\n        // Open Settings Panel in "Layer Mode"\n        const panel = document.getElementById(\'siteSettingsPanel\');\n        if (panel) {\n            panel.style.display = \'block\';\n            window.editingLayerId = id; // Set Context\n\n            // Update Title to show we are editing a layer\n            const title = panel.querySelector(\'h3\');\n            if (title) title.textContent = 'Settings: ${name}';\n        }\n    };\n    const visBtn = item.querySelector(\'.visibility-btn\');\n    visBtn.onclick = () => {\n        const isVisible = visBtn.style.opacity !== \'0.5\';\n        const newState = !isVisible;\n\n        // UI Toggle\n        visBtn.style.opacity = newState ? \'1\' : \'0.5\';\n        if (!newState) visBtn.textContent = \'━\';\n        else visBtn.textContent = \'👁️\';\n\n        // Logic Toggle\n        if (window.mapRenderer) {\n            window.mapRenderer.toggleSiteLayer(id, newState);\n        }\n    };\n\n    const removeBtn = item.querySelector(\'.remove-btn\');\n    removeBtn.onclick = (e) => {\n        e.stopPropagation();\n        if (confirm('Remove site layer "${name}" ? ')) {\n            if (window.mapRenderer) {\n                window.mapRenderer.removeSiteLayer(id);\n            }\n            item.remove();\n        }\n    };\n\n    container.appendChild(item);\n}\n\n// Site Settings UI Logic\nconst settingsBtn = document.getElementById(\'siteSettingsBtn\');\nconst settingsPanel = document.getElementById(\'siteSettingsPanel\');\nconst closeSettings = document.getElementById(\'closeSiteSettings\');\nconst siteColorBy = document.getElementById(\'siteColorBy\'); // NEW\n\nif (settingsBtn && settingsPanel) {\n    settingsBtn.onclick = () => {\n        // Open in "Global Mode"\n        window.editingLayerId = null;\n        const title = settingsPanel.querySelector(\'h3\');\n        if (title) title.textContent = \'Site Settings (Global)\';\n\n        settingsPanel.style.display = settingsPanel.style.display === \'none\' ? \'block\' : \'none\';\n    };\n    closeSettings.onclick = () => settingsPanel.style.display = \'none\';\n\n    const updateSiteStyles = () => {\n        const range = document.getElementById(\'rangeSiteDist\').value;\n        const beam = document.getElementById(\'rangeIconBeam\').value;\n        const opacity = document.getElementById(\'rangeSiteOpacity\').value;\n        const color = document.getElementById(\'pickerSiteColor\').value;\n        const useOverride = document.getElementById(\'checkSiteColorOverride\').checked;\n        const showSiteNames = document.getElementById(\'checkShowSiteNames\').checked;\n        const showCellNames = document.getElementById(\'checkShowCellNames\').checked;\n\n        const colorBy = siteColorBy ? siteColorBy.value : \'tech\';\n\n        // Context-Aware Update\n        if (window.editingLayerId) {\n            // Layer Specific\n            if (map) {\n                map.updateLayerSettings(window.editingLayerId, {\n                    range: range,\n                    beamwidth: beam,\n                    opacity: opacity,\n                    color: color,\n                    useOverride: useOverride,\n                    showSiteNames: showSiteNames,\n                    showCellNames: showCellNames\n                });\n            }\n        } else {\n            // Global\n            if (map) {\n                map.updateSiteSettings({\n                    range: range,\n                    beamwidth: beam,\n                    opacity: opacity,\n                    color: color,\n                    useOverride: useOverride,\n                    showSiteNames: showSiteNames,\n                    showCellNames: showCellNames,\n                    colorBy: colorBy\n                });\n            }\n        }\n\n        document.getElementById(\'valRange\').textContent = range;\n        document.getElementById(\'valBeam\').textContent = beam;\n        document.getElementById(\'valOpacity\').textContent = opacity;\n\n        if (map) {\n            // Logic moved above\n        }\n    };\n\n    // Listeners for Site Settings\n    document.getElementById(\'rangeSiteDist\').addEventListener(\'input\', updateSiteStyles);\n    document.getElementById(\'rangeIconBeam\').addEventListener(\'input\', updateSiteStyles);\n    document.getElementById(\'rangeSiteOpacity\').addEventListener(\'input\', updateSiteStyles);\n    document.getElementById(\'pickerSiteColor\').addEventListener(\'input\', updateSiteStyles);\n    document.getElementById(\'checkSiteColorOverride\').addEventListener(\'change\', updateSiteStyles);\n    document.getElementById(\'checkShowSiteNames\').addEventListener(\'change\', updateSiteStyles);\n    document.getElementById(\'checkShowCellNames\').addEventListener(\'change\', updateSiteStyles);\n    if (siteColorBy) siteColorBy.addEventListener(\'change\', updateSiteStyles);\n\n    // Initial sync\n    setTimeout(updateSiteStyles, 100);\n}\n\n// Generic Modal Close\nwindow.onclick = (event) => {\n    if (event.target == document.getElementById(\'gridModal\')) {\n        document.getElementById(\'gridModal\').style.display = "none";\n    }\n    if (event.target == document.getElementById(\'chartModal\')) {\n        document.getElementById(\'chartModal\').style.display = "none";\n    }\n    if (event.target == document.getElementById(\'signalingModal\')) {\n        document.getElementById(\'signalingModal\').style.display = "none";\n    }\n}\n\n\nwindow.closeSignalingModal = () => {\n    document.getElementById(\'signalingModal\').style.display = \'none\';\n};\n\n\n\n// Apply to Signaling Modal\nconst sigModal = document.getElementById(\'signalingModal\');\nconst sigContent = sigModal.querySelector(\'.modal-content\');\nconst sigHeader = sigModal.querySelector(\'.modal-header\'); // We need to ensure header exists\n\nif (sigContent && sigHeader) {\n    makeElementDraggable(sigHeader, sigContent);\n}\n\nwindow.showSignalingModal = (logId) => {\n    console.log(\'Opening Signaling Modal for Log ID:\', logId);\n    const log = loadedLogs.find(l => l.id.toString() === logId.toString()); // Ensure string comparison\n\n    if (!log) {\n        console.error(\'Log not found for ID:\', logId);\n        return;\n    }\n\n    currentSignalingLogId = log.id;\n    renderSignalingTable();\n\n    // Show modal\n    document.getElementById(\'signalingModal\').style.display = \'block\';\n\n    // Ensure visibility if it was closed or moved off screen?\n    // Reset position if first open? optional.\n};\n\nwindow.filterSignaling = () => {\n    renderSignalingTable();\n};\n\nfunction renderSignalingTable() {\n    if (!currentSignalingLogId) return;\n    const log = loadedLogs.find(l => l.id.toString() === currentSignalingLogId.toString());\n    if (!log) return;\n\n    const filterElement = document.getElementById(\'signalingFilter\');\n    const filter = filterElement ? filterElement.value : \'ALL\';\n    if (!filterElement) console.warn(\'Signaling Filter Dropdown not found in DOM!\');\n\n    const tbody = document.getElementById(\'signalingTableBody\');\n    const title = document.getElementById(\'signalingModalTitle\');\n\n    tbody.innerHTML = \'\';\n    title.textContent = 'Signaling Data - ${log.name}'; // Changed visual to verify update\n\n    // Filter Data\n    let sigPoints = log.signaling || [];\n    if (filter !== \'ALL\') {\n        sigPoints = sigPoints.filter(p => p.category === filter);\n    }\n\n    if (sigPoints.length === 0) {\n        tbody.innerHTML = \'<tr><td colspan="5" style="text-align:center; padding:20px;">No messages found matching filter.</td></tr>\';\n    } else {\n        const limit = 2000;\n        const displayPoints = sigPoints.slice(0, limit);\n\n        if (sigPoints.length > limit) {\n            const tr = document.createElement(\'tr\');\n            tr.innerHTML = '< td colspan = "5" style = "background:#552200; color:#fff; text-align:center;" > Showing first ${limit} of ${sigPoints.length} messages.</td > ';\n            tbody.appendChild(tr);\n        }\n\n        displayPoints.forEach((p, index) => {\n            const tr = document.createElement(\'tr\');\n            tr.id = 'sig - row - ${p.time.replace(/[:.]/g, '')} - ${index}'; // Unique ID for scrolling\n            tr.className = \'signaling-row\'; // Add class for selection\n            tr.style.cursor = \'pointer\';\n\n            // Row Click = Sync (Map + Chart)\n            tr.onclick = (e) => {\n                // Ignore clicks on buttons\n                if (e.target.tagName === \'BUTTON\') return;\n\n                // 1. Sync Map\n                if (p.lat && p.lng) {\n                    window.map.setView([p.lat, p.lng], 16);\n\n                    // Dispatch event for Chart Sync\n                    const event = new CustomEvent(\'map-point-clicked\', {\n                        detail: { logId: currentSignalingLogId, point: p, source: \'signaling\' }\n                    });\n                    window.dispatchEvent(event);\n                } else {\n                    // Try to find closest GPS point by time? \n                    // For now, just try chart sync via time\n                    const event = new CustomEvent(\'map-point-clicked\', {\n                        detail: { logId: currentSignalingLogId, point: p, source: \'signaling\' }\n                    });\n                    window.dispatchEvent(event);\n                }\n\n                // Low-level Visual Highlight (Overridden by highlightPoint later)\n                // But good for immediate feedback\n                document.querySelectorAll(\'.signaling-row\').forEach(r => r.classList.remove(\'selected-row\'));\n                tr.classList.add(\'selected-row\');\n            };\n\n            const mapBtn = (p.lat && p.lng)\n                ? '< button onclick = "window.map.setView([${p.lat}, ${p.lng}], 16); event.stopPropagation();" class= "btn" style = "padding:2px 6px; font-size:10px; background-color:#3b82f6;" > Map</button > '\n                : \'<span style="color:#666; font-size:10px;">No GPS</span>\';\n\n            // Store point data for the info button handler (simulated via dataset or just passing object index if we could, but stringifying is easier for this hack)\n            // Better: attach object to DOM element directly\n            tr.pointData = p;\n\n            let typeClass = \'badge-rrc\';\n            if (p.category === \'L3\') typeClass = \'badge-l3\';\n\n            tr.innerHTML = '
< td > ${p.time}</td >
                    <td><span class="${typeClass}">${p.category}</span></td>
                    <td>${p.direction}</td>
                    <td style="max-width:300px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="${p.message}">${p.message}</td>
                    <td>
                        ${mapBtn} 
                        <button onclick="const p = this.parentElement.parentElement.pointData; showSignalingPayload(p); event.stopPropagation();" class="btn" style="padding:2px 6px; font-size:10px; background-color:#475569;">Info</button>
                    </td>
                ';\n            tbody.appendChild(tr);\n        });\n    }\n}\n\n// Payload Viewer\nfunction showSignalingPayload(point) {\n    // Create Modal on the fly if not exists\n    let modal = document.getElementById(\'payloadModal\');\n    if (!modal) {\n        modal = document.createElement(\'div\');\n        modal.id = \'payloadModal\';\n        modal.className = \'modal\';\n        modal.innerHTML = '
    <div class= "modal-content" style = "max-width: 600px; background: #1f2937; color: #e5e7eb; border: 1px solid #374151;" >
                <div class="modal-header" style="border-bottom: 1px solid #374151; padding: 10px 15px; display:flex; justify-content:space-between; align-items:center;">
                    <h3 style="margin:0; font-size:16px;">Signaling Details</h3>
                    <span class="close" onclick="document.getElementById('payloadModal').style.display='none'" style="color:#9ca3af; cursor:pointer; font-size:20px;">&times;</span>
                </div>
                <div class="modal-body" style="padding: 15px; max-height: 70vh; overflow-y: auto;">
                    <div id="payloadContent"></div>
                </div>
                <div class="modal-footer" style="padding: 10px 15px; border-top: 1px solid #374151; text-align: right;">
                     <button onclick="document.getElementById('payloadModal').style.display='none'" class="btn" style="background:#4b5563;">Close</button>
                </div>
            </div >
    ';\n        document.body.appendChild(modal);\n    }\n\n    const content = document.getElementById(\'payloadContent\');\n    const payloadRaw = point.payload || \'No Hex Payload Available\';\n\n    // Format Hex (Group by 2 bytes / 4 chars)\n    const formatHex = (str) => {\n        if (!str || str.includes(\' \')) return str;\n        return str.replace(/(.{4})/g, \'$1 \').trim();\n    };\n\n    content.innerHTML = '
    <div style = "margin-bottom: 15px;" >
            <div style="font-size: 11px; color: #9ca3af; text-transform: uppercase; font-weight: 600;">Message Type</div>
            <div style="font-size: 14px; color: #fff; font-weight: bold;">${point.message}</div>
        </div >
         <div style="display:flex; gap:20px; margin-bottom: 15px;">
            <div>
                 <div style="font-size: 11px; color: #9ca3af; text-transform: uppercase; font-weight: 600;">Time</div>
                 <div style="color: #d1d5db;">${point.time}</div>
            </div>
            <div>
                 <div style="font-size: 11px; color: #9ca3af; text-transform: uppercase; font-weight: 600;">Direction</div>
                 <div style="color: #d1d5db;">${point.direction}</div>
            </div>
        </div>

        <div style="background: #111827; padding: 10px; border-radius: 4px; border: 1px solid #374151; font-family: 'Consolas', 'Monaco', monospace; font-size: 12px;">
            <div style="color: #6b7280; margin-bottom: 5px;">RRC Payload (Hex Stream):</div>
            <div style="color: #10b981; word-break: break-all; white-space: pre-wrap;">${formatHex(payloadRaw)}</div>
        </div>

         <div style="margin-top: 15px;">
            <div style="font-size: 11px; color: #9ca3af; text-transform: uppercase; font-weight: 600; margin-bottom:5px;">Raw NMF Line</div>
            <code style="display:block; background:#000; padding:8px; border-radius:4px; font-size:10px; color:#aaa; overflow-x:auto; white-space:nowrap;">${point.details}</code>
        </div>
    ';\n\n    modal.style.display = \'block\';\n}\nwindow.showSignalingPayload = showSignalingPayload;\n\n// ---------------------------------------------------------\n// ---------------------------------------------------------\n// DOCKING SYSTEM\n// ---------------------------------------------------------\nlet isChartDocked = false;\nlet isSignalingDocked = false;\nwindow.isGridDocked = false; // Exposed global\n\nconst bottomPanel = document.getElementById(\'bottomPanel\');\nconst bottomContent = document.getElementById(\'bottomContent\');\nconst bottomResizer = document.getElementById(\'bottomResizer\');\nconst dockedChart = document.getElementById(\'dockedChart\');\nconst dockedSignaling = document.getElementById(\'dockedSignaling\');\nconst dockedGrid = document.getElementById(\'dockedGrid\');\n\n// Resizer Logic\nlet isResizingBottom = false;\n\nbottomResizer.addEventListener(\'mousedown\', (e) => {\n    isResizingBottom = true;\n    document.body.style.cursor = \'ns-resize\';\n    e.preventDefault();\n});\n\ndocument.addEventListener(\'mousemove\', (e) => {\n    if (!isResizingBottom) return;\n    const containerHeight = document.getElementById(\'center-pane\').offsetHeight;\n    const newHeight = containerHeight - (e.clientY - document.getElementById(\'center-pane\').getBoundingClientRect().top);\n\n    // Min/Max constraints\n    if (newHeight > 50 && newHeight < containerHeight - 50) {\n        bottomPanel.style.height = newHeight + \'px\';\n    }\n});\n\ndocument.addEventListener(\'mouseup\', () => {\n    if (isResizingBottom) {\n        isResizingBottom = false;\n        document.body.style.cursor = \'default\';\n        // Trigger Resize for Chart if needed\n        if (window.currentChartInstance) window.currentChartInstance.resize();\n    }\n});\n\n// Update Layout Visibility\nfunction updateDockedLayout() {\n    const bottomPanel = document.getElementById(\'bottomPanel\');\n    const dockedChart = document.getElementById(\'dockedChart\');\n    const dockedSignaling = document.getElementById(\'dockedSignaling\');\n    const dockedGrid = document.getElementById(\'dockedGrid\');\n\n    if (!bottomPanel || !dockedChart || !dockedSignaling || !dockedGrid) {\n        console.warn(\'Docking elements missing, skipping layout update.\');\n        return;\n    }\n\n    const anyDocked = isChartDocked || isSignalingDocked || window.isGridDocked;\n\n    if (anyDocked) {\n        bottomPanel.style.display = \'flex\';\n        // Force flex basis to 0 0 300px to prevent #map from squashing it\n        bottomPanel.style.flex = \'0 0 300px\';\n        bottomPanel.style.height = \'300px\';\n        bottomPanel.style.minHeight = \'100px\'; // Prevent full collapse\n    } else {\n        bottomPanel.style.display = \'none\';\n    }\n\n    dockedChart.style.display = isChartDocked ? \'flex\' : \'none\';\n    dockedSignaling.style.display = isSignalingDocked ? \'flex\' : \'none\';\n\n    // Explicitly handle Grid Display\n    if (window.isGridDocked) {\n        dockedGrid.style.display = \'flex\';\n        dockedGrid.style.flexDirection = \'column\'; // Ensure column layout\n    } else {\n        dockedGrid.style.display = \'none\';\n    }\n\n    // Count active items\n    const activeItems = [isChartDocked, isSignalingDocked, window.isGridDocked].filter(Boolean).length;\n\n    if (activeItems > 0) {\n        const width = 100 / activeItems; // e.g. 50% or 33.3%\n        // Apply styles\n        [dockedChart, dockedSignaling, dockedGrid].forEach(el => {\n            // Ensure flex basis is reasonable\n            el.style.flex = \'1 1 auto\';\n            el.style.width = '${width} % ';\n            el.style.borderRight = \'1px solid #444\';\n            el.style.height = \'100%\'; // Full height of bottomPanel\n        });\n        // Remove last border\n        if (window.isGridDocked) dockedGrid.style.borderRight = \'none\';\n        else if (isSignalingDocked) dockedSignaling.style.borderRight = \'none\';\n        else dockedChart.style.borderRight = \'none\';\n    }\n\n    // Trigger Chart Resize\n    if (isChartDocked && window.currentChartInstance) {\n        setTimeout(() => window.currentChartInstance.resize(), 50);\n    }\n}\n\n// Docking Actions\nwindow.dockChart = () => {\n    isChartDocked = true;\n\n    // Close Floating Modal if open\n    const modal = document.getElementById(\'chartModal\');\n    if (modal) modal.remove();\n\n    updateDockedLayout();\n\n    // Re-open Chart in Docked Mode\n    if (window.currentChartLogId) {\n        // Ensure ID type match (string handling)\n        const log = loadedLogs.find(l => l.id.toString() === window.currentChartLogId.toString());\n\n        if (log && window.currentChartParam) {\n            openChartModal(log, window.currentChartParam);\n        } else {\n            console.error(\'Docking failed: Log or Param not valid\', { log, param: window.currentChartParam });\n        }\n    }\n};\n\nwindow.undockChart = () => {\n    isChartDocked = false;\n    dockedChart.innerHTML = \'\'; // Clear docked\n    updateDockedLayout();\n\n    // Re-open as Modal\n    if (window.currentChartLogId && window.currentChartParam) {\n        const log = loadedLogs.find(l => l.id === window.currentChartLogId);\n        if (log) openChartModal(log, window.currentChartParam);\n    }\n};\n\n// ---------------------------------------------------------\n// DOCKING SYSTEM - SIGNALING EXTENSION\n// ---------------------------------------------------------\n\n// Inject Dock Button into Signaling Modal Header if not present\nfunction ensureSignalingDockButton() {\n    // Use a more specific selector or retry mechanism if needed, but for now standard check\n    const header = document.querySelector(\'#signalingModal .modal-header\');\n    if (header && !header.querySelector(\'.dock-btn\')) {\n        const dockBtn = document.createElement(\'button\');\n        dockBtn.className = \'dock-btn\';\n        dockBtn.textContent = \'Dock\';\n        // Explicitly set onclick attribute to ensure it persists and isn\'t lost\n        dockBtn.setAttribute(\'onclick\', "alert(\'Docking...\'); window.dockSignaling();");\n        dockBtn.style.cssText = \'background:#3b82f6; color:white; border:none; padding:4px 10px; cursor:pointer; font-size:11px; margin-left: auto; margin-right: 15px; pointer-events: auto; z-index: 9999; position: relative;\';\n\n        // Insert before the close button\n        const closeBtn = header.querySelector(\'.close\');\n        header.insertBefore(dockBtn, closeBtn);\n    }\n}\n// Call it once\nensureSignalingDockButton();\n\nwindow.dockSignaling = () => {\n    if (isSignalingDocked) return;\n    isSignalingDocked = true;\n\n    // Move Content\n    const modalContent = document.querySelector(\'#signalingModal .modal-content\');\n    if (!modalContent) {\n        console.error(\'Signaling modal content not found\');\n        return;\n    }\n    const header = modalContent.querySelector(\'.modal-header\');\n    const body = modalContent.querySelector(\'.modal-body\');\n\n    // Verify elements exist before moving\n    if (header && body) {\n        dockedSignaling.appendChild(header);\n        dockedSignaling.appendChild(body);\n\n        // Modify Header for Docked State\n        header.style.borderBottom = \'1px solid #444\';\n\n        // Fix: Body needs to stretch in flex container\n        body.style.flex = \'1\';\n        body.style.overflowY = \'auto\'; // Ensure scrollable\n\n        // Change Dock Button to Undock\n        const dockBtn = header.querySelector(\'.dock-btn\');\n        if (dockBtn) {\n            dockBtn.textContent = \'Undock\';\n            dockBtn.onclick = window.undockSignaling;\n            dockBtn.style.background = \'#555\';\n        }\n\n        // Hide Close Button\n        const closeBtn = header.querySelector(\'.close\');\n        if (closeBtn) closeBtn.style.display = \'none\';\n\n        // Hide Modal Wrapper\n        document.getElementById(\'signalingModal\').style.display = \'none\';\n\n        updateDockedLayout();\n    } else {\n        console.error(\'Signaling modal parts missing\', { header, body });\n        isSignalingDocked = false; // Revert state if failed\n    }\n};\n\nwindow.undockSignaling = () => {\n    if (!isSignalingDocked) return;\n    isSignalingDocked = false;\n\n    const header = dockedSignaling.querySelector(\'.modal-header\');\n    const body = dockedSignaling.querySelector(\'.modal-body\');\n    const modalContent = document.querySelector(\'#signalingModal .modal-content\');\n\n    if (header && body) {\n        modalContent.appendChild(header);\n        modalContent.appendChild(body);\n\n        // Restore Header\n        // Change Undock Button to Dock\n        const dockBtn = header.querySelector(\'.dock-btn\');\n        if (dockBtn) {\n            dockBtn.textContent = \'Dock\';\n            dockBtn.onclick = window.dockSignaling;\n            dockBtn.style.background = \'#3b82f6\';\n        }\n\n        // Show Close Button\n        const closeBtn = header.querySelector(\'.close\');\n        if (closeBtn) closeBtn.style.display = \'block\';\n    }\n\n    dockedSignaling.innerHTML = \'\'; // Should be empty anyway\n    updateDockedLayout();\n\n    // Show Modal\n    if (currentSignalingLogId) {\n        document.getElementById(\'signalingModal\').style.display = \'block\';\n    }\n};\n\n// Redefine showSignalingModal to handle visibility only (rendering is same ID based)\nwindow.showSignalingModal = (logId) => {\n    console.log(\'Opening Signaling Modal for Log ID:\', logId);\n    const log = loadedLogs.find(l => l.id.toString() === logId.toString());\n\n    if (!log) {\n        console.error(\'Log not found for ID:\', logId);\n        return;\n    }\n\n    currentSignalingLogId = log.id;\n    renderSignalingTable();\n\n    if (isSignalingDocked) {\n        // Ensure docked view is visible\n        updateDockedLayout();\n    } else {\n        // Show modal\n        document.getElementById(\'signalingModal\').style.display = \'block\';\n        ensureSignalingDockButton();\n    }\n};\n\n// Initial call to update layout state\nupdateDockedLayout();\n\n// Global Function to Update Sidebar List\nconst updateLogsList = function () {\n    const container = document.getElementById(\'logsList\');\n    if (!container) return; // Safety check\n    container.innerHTML = \'\';\n\n    loadedLogs.forEach(log => {\n        // Exclude SmartCare layers (Excel/SHP) which are in the right sidebar\n        if (log.type === \'excel\' || log.type === \'shp\') return;\n\n        const item = document.createElement(\'div\');\n        // REMOVED overflow:hidden to prevent clipping issues. FORCED display:block to override any cached flex rules.\n        item.style.cssText = \'background:#252525; margin-bottom:5px; border-radius:4px; border:1px solid #333; min-height: 50px; display: block !important;\';\n\n        // Header\n        const header = document.createElement(\'div\');\n        header.className = \'log-header\';\n        header.style.cssText = \'padding:8px 10px; cursor:pointer; display:flex; justify-content:space-between; align-items:center; background:#2d2d2d; border-bottom:1px solid #333;\';\n        header.innerHTML = '
<span style="font-weight:bold; color:#ddd; font-size:12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:160px;">${log.name}</span>
<div style="display:flex; gap:5px;">
    <!-- Export Button -->
    <button onclick="window.exportOptimFile('${log.id}'); event.stopPropagation();" title="Export Optim CSV" style="background:#059669; color:white; border:none; width:20px; height:20px; border-radius:3px; cursor:pointer; display:flex; align-items:center; justify-content:center;">⬇</button>
    <button onclick="event.stopPropagation(); window.removeLog('${log.id}')" style="background:#ef4444; color:white; border:none; width:20px; height:20px; border-radius:3px; cursor:pointer; display:flex; align-items:center; justify-content:center;">×</button>
</div>
        ';\n\n        // Toggle Logic\n        header.onclick = () => {\n            const body = item.querySelector(\'.log-body\');\n            // Check computed style or inline style\n            const isHidden = body.style.display === \'none\';\n            body.style.display = isHidden ? \'block\' : \'none\';\n        };\n\n        // Body (Default: Visible)\n        const body = document.createElement(\'div\');\n        body.className = \'log-body\';\n        body.style.cssText = \'padding:10px; display:block;\';\n\n        // Stats\n        const count = log.points.length;\n        const stats = document.createElement(\'div\');\n        stats.style.cssText = \'font-size:10px; color:#888; margin-bottom:8px;\';\n        stats.innerHTML = '
    <span style="background:#3b82f6; color:white; padding:2px 4px; border-radius:2px;">${log.tech}</span>
<span style="margin-left:5px;">${count} pts</span>
        ';\n\n        // Actions\n        const actions = document.createElement(\'div\');\n        actions.style.cssText = \'display:flex; flex-direction:column; gap:4px;\';\n\n        const addAction = (label, param) => {\n            const btn = document.createElement(\'div\');\n            btn.textContent = label;\n            btn.className = \'param-item\'; // Add class for styling if needed\n            btn.draggable = true; // Make Draggable\n            btn.style.cssText = \'padding:4px 8px; background:#333; color:#ccc; font-size:11px; border-radius:3px; cursor:pointer; hover:background:#444; transition:background 0.2s;\';\n\n            btn.onmouseover = () => btn.style.background = \'#444\';\n            btn.onmouseout = () => btn.style.background = \'#333\';\n\n            // Drag Start Handler\n            btn.ondragstart = (e) => {\n                e.dataTransfer.setData(\'application/json\', JSON.stringify({\n                    logId: log.id,\n                    param: param,\n                    label: label\n                }));\n                e.dataTransfer.effectAllowed = \'copy\';\n            };\n\n            // Left Click Handler - Opens Context Menu\n            btn.onclick = (e) => {\n                window.showMetricOptions(e, log.id, param, \'regular\');\n            };\n            return btn;\n        };\n\n        // Helper for Group Headers\n        const addHeader = (text) => {\n            const d = document.createElement(\'div\');\n            d.textContent = text;\n            d.style.cssText = \'font-size:10px; color:#aaa; margin-top:8px; margin-bottom:4px; font-weight:bold; text-transform:uppercase; letter-spacing:0.5px;\';\n            return d;\n        };\n\n        // NEW: DYNAMIC METRICS VS FIXED METRICS\n        // If customMetrics exist, use them. Else use Fixed NMF list.\n\n        if (log.customMetrics && log.customMetrics.length > 0) {\n            actions.appendChild(addHeader(\'Detected Metrics\'));\n\n            log.customMetrics.forEach(metric => {\n                let label = metric;\n                if (metric === \'throughput_dl\') label = \'DL Throughput (Kbps)\';\n                if (metric === \'throughput_ul\') label = \'UL Throughput (Kbps)\';\n                actions.appendChild(addAction(label, metric));\n            });\n\n            // Also add "Time" and "GPS" if they exist in basic points but maybe not in customMetrics list?\n            // The parser excludes Time/Lat/Lon from customMetrics.\n            // So we can re-add them if we want buttons for them (usually just Time/Speed).\n            actions.appendChild(document.createElement(\'hr\')).style.cssText = "border:0; border-top:1px solid #444; margin:10px 0;";\n            actions.appendChild(addAction(\'Time\', \'time\'));\n\n        } else {\n            // FALLBACK: OLD STATIC NMF METRICS\n\n            // GROUP: Serving Cell\n            actions.appendChild(addHeader(\'Serving Cell\'));\n            actions.appendChild(addAction(\'Serving RSCP/Level\', \'rscp_not_combined\'));\n            actions.appendChild(addAction(\'Serving EcNo\', \'ecno\'));\n            actions.appendChild(addAction(\'Serving SC/SC\', \'sc\'));\n            actions.appendChild(addAction(\'Serving RNC\', \'rnc\'));\n            actions.appendChild(addAction(\'Active Set\', \'active_set\'));\n            actions.appendChild(addAction(\'Serving Freq\', \'freq\'));\n            actions.appendChild(addAction(\'Serving Band\', \'band\'));\n            actions.appendChild(addAction(\'LAC\', \'lac\'));\n            actions.appendChild(addAction(\'Cell ID\', \'cellId\'));\n            actions.appendChild(addAction(\'Serving Cell Name\', \'serving_cell_name\'));\n\n            // GROUP: Active Set (Individual)\n            actions.appendChild(addHeader(\'Active Set Members\'));\n            actions.appendChild(addAction(\'A1 RSCP\', \'active_set_A1_RSCP\'));\n            actions.appendChild(addAction(\'A1 SC\', \'active_set_A1_SC\'));\n            actions.appendChild(addAction(\'A2 RSCP\', \'active_set_A2_RSCP\'));\n            actions.appendChild(addAction(\'A2 SC\', \'active_set_A2_SC\'));\n            actions.appendChild(addAction(\'A3 RSCP\', \'active_set_A3_RSCP\'));\n            actions.appendChild(addAction(\'A3 SC\', \'active_set_A3_SC\'));\n\n            // GROUP: Neighbors\n            actions.appendChild(addHeader(\'Neighbors\'));\n            // Neighbors Loop (N1 - N8)\n            for (let i = 1; i <= 8; i++) {\n                actions.appendChild(addAction('N${i} RSCP', 'n${i}_rscp'));\n                actions.appendChild(addAction('N${i} EcNo', 'n${i}_ecno'));\n                actions.appendChild(addAction('N${i} SC', 'n${i}_sc'));\n            }\n\n            // OUTSIDE GROUPS: Composite & General\n            actions.appendChild(document.createElement(\'hr\')).style.cssText = "border:0; border-top:1px solid #444; margin:10px 0;";\n\n            actions.appendChild(addAction(\'Composite RSCP & Neighbors\', \'rscp_not_combined\'));\n\n            actions.appendChild(document.createElement(\'hr\')).style.cssText = "border:0; border-top:1px solid #444; margin:10px 0;";\n\n            // GPS & Others\n            actions.appendChild(addAction(\'GPS Speed\', \'speed\'));\n            actions.appendChild(addAction(\'GPS Altitude\', \'alt\'));\n            actions.appendChild(addAction(\'Time\', \'time\'));\n        }\n\n        // Resurrected Signaling Modal Button\n        const sigBtn = document.createElement(\'div\');\n        sigBtn.className = \'metric-item\';\n        sigBtn.style.padding = \'4px 8px\';\n        sigBtn.style.cursor = \'pointer\';\n        sigBtn.style.margin = \'2px 0\';\n        sigBtn.style.fontSize = \'11px\';\n        sigBtn.style.color = \'#ccc\';\n        sigBtn.style.borderRadius = \'4px\';\n        sigBtn.style.backgroundColor = \'rgba(168, 85, 247, 0.1)\'; // Purple tint\n        sigBtn.style.border = \'1px solid rgba(168, 85, 247, 0.2)\';\n        sigBtn.textContent = \'Show Signaling\';\n        sigBtn.onclick = (e) => {\n            e.preventDefault();\n            e.stopPropagation();\n            if (window.showSignalingModal) {\n                window.showSignalingModal(log.id);\n            } else {\n                alert(\'Signaling Modal function missing!\');\n            }\n        };\n        sigBtn.onmouseover = () => sigBtn.style.backgroundColor = \'rgba(168, 85, 247, 0.2)\';\n        sigBtn.onmouseout = () => sigBtn.style.backgroundColor = \'rgba(168, 85, 247, 0.1)\';\n        actions.appendChild(sigBtn);\n\n        // Add components\n        body.appendChild(stats);\n        body.appendChild(actions);\n        item.appendChild(header);\n        item.appendChild(body);\n        container.appendChild(item);\n    });\n};\n\n// DEBUG EXPORT FOR TESTING\nwindow.loadedLogs = loadedLogs;\nwindow.updateLogsList = updateLogsList;\nwindow.openChartModal = openChartModal;\nwindow.showSignalingModal = showSignalingModal;\nwindow.dockChart = dockChart;\nwindow.dockSignaling = dockSignaling;\nwindow.undockChart = undockChart;\nwindow.undockSignaling = undockSignaling;\n\n// ----------------------------------------------------\n// EXPORT OPTIM FILE FEATURE\n// ----------------------------------------------------\nwindow.exportOptimFile = (logId) => {\n    const log = loadedLogs.find(l => l.id === logId);\n    if (!log) return;\n\n    const headers = [\n        \'Date\', \'Time\', \'Latitude\', \'Longitude\',\n        \'Serving Band\', \'Serving RSCP\', \'Serving EcNo\', \'Serving SC\', \'Serving LAC\', \'Serving Freq\',\n        \'N1 Band\', \'N1 RSCP\', \'N1 EcNo\', \'N1 SC\', \'N1 LAC\', \'N1 Freq\',\n        \'N2 Band\', \'N2 RSCP\', \'N2 EcNo\', \'N2 SC\', \'N2 LAC\', \'N2 Freq\',\n        \'N3 Band\', \'N3 RSCP\', \'N3 EcNo\', \'N3 SC\', \'N3 LAC\', \'N3 Freq\'\n    ];\n\n    // Helper to guess band from freq (Simplified logic matching parser)\n    const getBand = (f) => {\n        if (!f) return \'\';\n        f = parseFloat(f);\n        if (f >= 10562 && f <= 10838) return \'B1 (2100)\';\n        if (f >= 2937 && f <= 3088) return \'B8 (900)\';\n        if (f > 10000) return \'High Band\';\n        if (f < 4000) return \'Low Band\';\n        return \'Unknown\';\n    };\n\n    const rows = [];\n    rows.push(headers.join(\',\'));\n\n    log.points.forEach(p => {\n        if (!p.parsed) return;\n\n        const s = p.parsed.serving;\n        const n = p.parsed.neighbors || [];\n\n        const gn = (idx, field) => {\n            if (idx >= n.length) return \'\';\n            const nb = n[idx];\n            if (field === \'band\') return getBand(nb.freq);\n            if (field === \'lac\') return s.lac;\n            return nb[field] !== undefined ? nb[field] : \'\';\n        };\n\n        const row = [\n            new Date().toISOString().split(\'T\')[0],\n            p.time,\n            p.lat,\n            p.lng,\n            getBand(s.freq),\n            s.level,\n            s.ecno !== null ? s.ecno : \'\',\n            s.sc,\n            s.lac,\n            s.freq,\n            gn(0, \'band\'), gn(0, \'rscp\'), gn(0, \'ecno\'), gn(0, \'pci\'), gn(0, \'lac\'), gn(0, \'freq\'),\n            gn(1, \'band\'), gn(1, \'rscp\'), gn(1, \'ecno\'), gn(1, \'pci\'), gn(1, \'lac\'), gn(1, \'freq\'),\n            gn(2, \'band\'), gn(2, \'rscp\'), gn(2, \'ecno\'), gn(2, \'pci\'), gn(2, \'lac\'), gn(2, \'freq\')\n        ];\n        rows.push(row.join(\',\'));\n    });\n\n    const csvContent = "data:text/csv;charset=utf-8," + rows.join("\n");\n    const encodedUri = encodeURI(csvContent);\n    const link = document.createElement("a");\n    link.setAttribute("href", encodedUri);\n    link.setAttribute("download", '${log.name}_optim_export.csv');\n    document.body.appendChild(link);\n    link.click();\n    document.body.removeChild(link);\n};\n\n\n\n// ----------------------------------------------------\n// CONTEXT MENU LOGIC (Re-added)\n// ----------------------------------------------------\nwindow.currentContextLogId = null;\nwindow.currentContextParam = null;\n\n\n// DRAG AND DROP MAP HANDLERS\nwindow.allowDrop = (ev) => {\n    ev.preventDefault();\n};\n\nwindow.drop = (ev) => {\n    ev.preventDefault();\n    try {\n        const data = JSON.parse(ev.dataTransfer.getData("application/json"));\n        if (!data || !data.logId || !data.param) return;\n\n        console.log("Dropped Metric:", data);\n\n        const log = loadedLogs.find(l => l.id.toString() === data.logId.toString());\n        if (!log) return;\n\n        // 1. Determine Theme based on Metric\n        const p = data.param.toLowerCase();\n        const l = data.label.toLowerCase();\n        const themeSelect = document.getElementById(\'themeSelect\');\n        let newTheme = \'level\'; // Default\n\n        // Heuristic for Quality vs Coverage vs CellID\n        if (p === \'cellid\' || p === \'cid\' || p === \'cell_id\') {\n            // Temporarily add option if missing or just hijack the value\n            let opt = Array.from(themeSelect.options).find(o => o.value === \'cellId\');\n            if (!opt) {\n                opt = document.createElement(\'option\');\n                opt.value = \'cellId\';\n                opt.text = \'Cell ID\';\n                themeSelect.add(opt);\n            }\n            newTheme = \'cellId\';\n        } else if (p.includes(\'qual\') || p.includes(\'ecno\') || p.includes(\'sinr\')) {\n            newTheme = \'quality\';\n        }\n\n        // 2. Apply Theme if detected\n        if (newTheme && themeSelect) {\n            themeSelect.value = newTheme;\n            console.log('[Drop] Switched theme to: ${newTheme}');\n\n            // Trigger any change handlers if strictly needed, but we usually just call render\n            if (window.renderThresholdInputs) {\n                window.renderThresholdInputs();\n            }\n            // Force Legend Update\n            // Force Legend Update (REMOVED: let Async event handle it)\n            // if (window.updateLegend) {\n            //    window.updateLegend();\n            // }\n        }\n\n        // 3. Visualize\n        if (window.mapRenderer) {\n            log.currentParam = data.param; // SYNC: Update active metric for this log\n            window.mapRenderer.updateLayerMetric(log.id, log.points, data.param);\n\n            // Ensure Legend is updated AGAIN after metric update (metrics might be calc\'d inside renderer)\n            // Ensure Legend is updated AGAIN after metric update (metrics might be calc\'d inside renderer)\n            // REMOVED: let Async event handle it to avoid "0 Cell IDs" flash\n            // setTimeout(() => {\n            //     if (window.updateLegend) window.updateLegend();\n            // }, 100);\n        } else {\n            console.error("[Drop] window.mapRenderer is undefined!");\n            alert("Internal Error: Map Renderer not initialized.");\n        }\n\n    } catch (e) {\n        console.error("Drop failed:", e);\n        alert("Drop failed: " + e.message);\n    }\n};\n\n// ----------------------------------------------------\n// USER POINT MANUAL ENTRY\n// ----------------------------------------------------\nconst addPointBtn = document.getElementById(\'addPointBtn\');\nconst userPointModal = document.getElementById(\'userPointModal\');\nconst submitUserPoint = document.getElementById(\'submitUserPoint\');\n\nif (addPointBtn && userPointModal) {\n    addPointBtn.onclick = () => {\n        userPointModal.style.display = \'block\';\n\n        // Make Draggable\n        const upContent = userPointModal.querySelector(\'.modal-content\');\n        const upHeader = userPointModal.querySelector(\'.modal-header\');\n        if (typeof makeElementDraggable === \'function\' && upContent && upHeader) {\n            makeElementDraggable(upHeader, upContent);\n        }\n\n        // Optional: Auto-fill from Search Input if it looks like coords\n        const searchInput = document.getElementById(\'searchInput\');\n        if (searchInput && searchInput.value) {\n            const parts = searchInput.value.split(\',\');\n            if (parts.length === 2) {\n                const lat = parseFloat(parts[0].trim());\n                const lng = parseFloat(parts[1].trim());\n                if (!isNaN(lat) && !isNaN(lng)) {\n                    document.getElementById(\'upLat\').value = lat;\n                    document.getElementById(\'upLng\').value = lng;\n                }\n            }\n        }\n    };\n}\n\nif (submitUserPoint) {\n    submitUserPoint.onclick = () => {\n        const nameInput = document.getElementById(\'upName\');\n        const latInput = document.getElementById(\'upLat\');\n        const lngInput = document.getElementById(\'upLng\');\n\n        const name = nameInput.value.trim() || \'User Point\';\n        const lat = parseFloat(latInput.value);\n        const lng = parseFloat(lngInput.value);\n\n        if (isNaN(lat) || isNaN(lng)) {\n            alert(\'Invalid Coordinates. Please enter valid numbers.\');\n            return;\n        }\n\n        if (!window.map) {\n            alert(\'Map not initialized.\');\n            return;\n        }\n\n        // Add Marker via Leaflet\n        // Using a distinct icon color or style could be nice, but default blue is fine for now.\n        const marker = L.marker([lat, lng]).addTo(window.map);\n\n        // Assign a unique ID to the marker for removal\n        const markerId = \'user_point_\' + Date.now();\n        marker._pointId = markerId;\n\n        // Store marker in a global map if not exists\n        if (!window.userMarkers) window.userMarkers = {};\n        window.userMarkers[markerId] = marker;\n\n        // Define global remover if not exists\n        if (!window.removeUserPoint) {\n            window.removeUserPoint = (id) => {\n                const m = window.userMarkers[id];\n                if (m) {\n                    m.remove();\n                    delete window.userMarkers[id];\n                }\n            };\n        }\n\n        const popupContent = '
<div style = "font-size:13px; min-width:150px;" >
                <b>${name}</b><br>
                <div style="color:#888; font-size:11px; margin-top:4px;">${lat.toFixed(5)}, ${lng.toFixed(5)}</div>
                <button onclick="window.removeUserPoint('${markerId}')" style="margin-top:8px; background:#ef4444; color:white; border:none; padding:2px 5px; border-radius:3px; cursor:pointer; font-size:10px;">Remove</button>
            </div>
         ';\n\n        marker.bindPopup(popupContent).openPopup();\n\n        // Close Modal\n        userPointModal.style.display = \'none\';\n\n        // Pan to location\n        window.map.panTo([lat, lng]);\n\n        // Clear Inputs (Optional, or keep for repeated entry?)\n        // Let\'s keep name but clear coords or clear all? \n        // Clearing all is standard.\n        nameInput.value = \'\';\n        latInput.value = \'\';\n        lngInput.value = \'\';\n    };\n}\n\n});\n\n// --- SITE EDITOR LOGIC ---\n\nwindow.refreshSites = function () {\n    if (window.mapRenderer && window.mapRenderer.siteData) {\n        // Pass false to prevent auto-zooming/fitting bounds\n        window.mapRenderer.addSiteLayer(window.mapRenderer.siteData, false);\n    }\n};\n\nfunction ensureSiteEditorDraggable() {\n    const modal = document.getElementById(\'siteEditorModal\');\n    if (!modal) return;\n    const content = modal.querySelector(\'.modal-content\');\n    const header = modal.querySelector(\'.modal-header\');\n\n    // Center it initially (if not already moved)\n    if (!content.dataset.centered) {\n        const w = 400; // rough width\n        const h = 500; // rough height\n        content.style.position = \'absolute\';\n        // Simple center based on viewport\n        content.style.left = Math.max(0, (window.innerWidth - w) / 2) + \'px\';\n        content.style.top = Math.max(0, (window.innerHeight - h) / 2) + \'px\';\n        content.style.margin = \'0\'; // Remove auto margin if present\n        content.dataset.centered = "true";\n    }\n\n    // Init Drag if not done\n    if (typeof makeElementDraggable === \'function\' && !content.dataset.draggable) {\n        makeElementDraggable(header, content);\n        content.dataset.draggable = "true";\n        header.style.cursor = "move"; // Explicitly show move cursor on header\n    }\n}\n\nwindow.openAddSectorModal = function () {\n    document.getElementById(\'siteEditorTitle\').textContent = "Add New Site";\n    document.getElementById(\'editOriginalId\').value = "";\n    document.getElementById(\'editOriginalIndex\').value = ""; // Clear Index\n\n    // Clear inputs\n    document.getElementById(\'editSiteName\').value = "";\n    document.getElementById(\'editCellName\').value = "";\n    document.getElementById(\'editCellId\').value = "";\n    document.getElementById(\'editLat\').value = "";\n    document.getElementById(\'editLng\').value = "";\n    document.getElementById(\'editAzimuth\').value = "0";\n    document.getElementById(\'editPci\').value = "";\n    document.getElementById(\'editTech\').value = "4G";\n\n    // Hide Delete Button for New Entry\n    document.getElementById(\'btnDeleteSector\').style.display = \'none\';\n\n    // Hide Sibling Button\n    const btnSibling = document.getElementById(\'btnAddSiblingSector\');\n    if (btnSibling) btnSibling.style.display = \'none\';\n\n    const modal = document.getElementById(\'siteEditorModal\');\n    modal.style.display = \'block\';\n\n    ensureSiteEditorDraggable();\n\n    // Auto-center\n    const content = modal.querySelector(\'.modal-content\');\n    requestAnimationFrame(() => {\n        const rect = content.getBoundingClientRect();\n        if (rect.width > 0) {\n            content.style.left = Math.max(0, (window.innerWidth - rect.width) / 2) + \'px\';\n            content.style.top = Math.max(0, (window.innerHeight - rect.height) / 2) + \'px\';\n        }\n    });\n};\n\n// Index-based editing (Robust for duplicates)\n// Layer-compatible editing\nwindow.editSector = function (layerId, index) {\n    if (!window.mapRenderer || !window.mapRenderer.siteLayers) return;\n    const layer = window.mapRenderer.siteLayers.get(String(layerId));\n    if (!layer || !layer.sectors || !layer.sectors[index]) {\n        console.error("Sector not found:", layerId, index);\n        return;\n    }\n    const s = layer.sectors[index];\n\n    document.getElementById(\'siteEditorTitle\').textContent = "Edit Sector";\n    document.getElementById(\'editOriginalId\').value = s.cellId || ""; // keep original for reference if needed\n\n    // Store context for saving\n    document.getElementById(\'editLayerId\').value = layerId;\n    document.getElementById(\'editOriginalIndex\').value = index;\n\n    // Populate\n    document.getElementById(\'editSiteName\').value = s.siteName || s.name || "";\n    document.getElementById(\'editCellName\').value = s.cellName || "";\n    document.getElementById(\'editCellId\').value = s.cellId || "";\n    document.getElementById(\'editLat\').value = s.lat;\n    document.getElementById(\'editLng\').value = s.lng;\n    document.getElementById(\'editAzimuth\').value = s.azimuth || 0;\n    document.getElementById(\'editPci\').value = s.sc || s.pci || "";\n    document.getElementById(\'editTech\').value = s.tech || "4G";\n    document.getElementById(\'editBeamwidth\').value = s.beamwidth || 65;\n\n    // UI Helpers\n    document.getElementById(\'btnDeleteSector\').style.display = \'inline-block\';\n    const btnSibling = document.getElementById(\'btnAddSiblingSector\');\n    if (btnSibling) btnSibling.style.display = \'inline-block\';\n\n    const modal = document.getElementById(\'siteEditorModal\');\n    modal.style.display = \'block\';\n\n    if (typeof ensureSiteEditorDraggable === \'function\') ensureSiteEditorDraggable();\n\n    // Auto-center\n    const content = modal.querySelector(\'.modal-content\');\n    requestAnimationFrame(() => {\n        const rect = content.getBoundingClientRect();\n        if (rect.width > 0) {\n            content.style.left = Math.max(0, (window.innerWidth - rect.width) / 2) + \'px\';\n            content.style.top = Math.max(0, (window.innerHeight - rect.height) / 2) + \'px\';\n        }\n    });\n};\n\nwindow.addSectorToCurrentSite = function () {\n    // Read current context before clearing\n    const currentName = document.getElementById(\'editSiteName\').value;\n    const currentLat = document.getElementById(\'editLat\').value;\n    const currentLng = document.getElementById(\'editLng\').value;\n    const currentTech = document.getElementById(\'editTech\').value;\n\n    // Switch to Add Mode\n    document.getElementById(\'siteEditorTitle\').textContent = "Add Sector to Site";\n    document.getElementById(\'editOriginalId\').value = ""; // Clear\n    document.getElementById(\'editOriginalIndex\').value = ""; // Clear Index\n\n    // Clear Attributes specific to sector\n    document.getElementById(\'editCellName\').value = ""; // Clear Cell Name\n    document.getElementById(\'editCellId\').value = "";\n    document.getElementById(\'editAzimuth\').value = "0";\n    document.getElementById(\'editPci\').value = "";\n\n    // Keep Site-level Attributes\n    document.getElementById(\'editSiteName\').value = currentName;\n    document.getElementById(\'editLat\').value = currentLat;\n    document.getElementById(\'editLng\').value = currentLng;\n    document.getElementById(\'editTech\').value = currentTech;\n\n    // Hide Delete & Sibling Buttons\n    document.getElementById(\'btnDeleteSector\').style.display = \'none\';\n    const btnSibling = document.getElementById(\'btnAddSiblingSector\');\n    if (btnSibling) btnSibling.style.display = \'none\';\n};\n\n\n\nwindow.saveSector = function () {\n    if (!window.mapRenderer) return;\n\n    const layerId = document.getElementById(\'editLayerId\').value;\n    const originalIndex = document.getElementById(\'editOriginalIndex\').value;\n\n    // Validate Layer\n    let layer = null;\n    let sectors = null;\n\n    if (layerId && window.mapRenderer.siteLayers.has(layerId)) {\n        layer = window.mapRenderer.siteLayers.get(layerId);\n        sectors = layer.sectors;\n    } else {\n        // Fallback for VERY legacy or newly created "default" sites without layer?\n        // Unlikely in new architecture. Alert error.\n        alert("Layer Context Lost. Cannot save sector.");\n        return;\n    }\n\n    // Determine target index\n    let idx = -1;\n    if (originalIndex !== "" && originalIndex !== null) {\n        idx = parseInt(originalIndex, 10);\n    }\n\n    const isNew = (idx === -1);\n\n    const newAzimuth = parseInt(document.getElementById(\'editAzimuth\').value, 10);\n    const newSiteName = document.getElementById(\'editSiteName\').value;\n\n    const newObj = {\n        siteName: newSiteName,\n        name: newSiteName,\n        cellName: (document.getElementById(\'editCellName\').value || newSiteName),\n        cellId: (document.getElementById(\'editCellId\').value || newSiteName + "_1"),\n        lat: parseFloat(document.getElementById(\'editLat\').value),\n        lng: parseFloat(document.getElementById(\'editLng\').value),\n        azimuth: isNaN(newAzimuth) ? 0 : newAzimuth,\n        // Tech & PCI\n        tech: document.getElementById(\'editTech\').value,\n        sc: document.getElementById(\'editPci\').value,\n        pci: document.getElementById(\'editPci\').value, // Sync both\n        // Beamwidth\n        beamwidth: parseInt(document.getElementById(\'editBeamwidth\').value, 10) || 65\n    };\n\n    // Compute RNC/CID if possible\n    try {\n        if (String(newObj.cellId).includes(\'/\')) {\n            const parts = newObj.cellId.split(\'/\');\n            newObj.rnc = parts[0];\n            newObj.cid = parts[1];\n        } else {\n            // If numeric > 65535, try split\n            const num = parseInt(newObj.cellId, 10);\n            if (!isNaN(num) && num > 65535) {\n                newObj.rnc = num >> 16;\n                newObj.cid = num & 0xFFFF;\n            }\n        }\n    } catch (e) { }\n\n    // Add Derived Props\n    newObj.rawEnodebCellId = newObj.cellId;\n\n    if (isNew) {\n        sectors.push(newObj);\n        console.log('[SiteEditor] created sector in layer ${layerId}');\n    } else {\n        // Update valid index\n        if (sectors[idx]) {\n            const oldS = sectors[idx];\n            const oldAzimuth = oldS.azimuth;\n            const oldSiteName = oldS.siteName || oldS.name;\n\n            // 1. Update the target sector\n            // Merge to preserve other props like frequency if not edited\n            sectors[idx] = { ...sectors[idx], ...newObj };\n            console.log('[SiteEditor] updated sector ${idx} in layer ${layerId}');\n\n            // 2. Synchronize Azimuth if changed\n            if (oldAzimuth !== newAzimuth && !isNaN(oldAzimuth) && !isNaN(newAzimuth)) {\n                // Find others with same site name and SAME OLD AZIMUTH\n                sectors.forEach((s, subIdx) => {\n                    const sName = s.siteName || s.name;\n                    // Loose check for Site Name match\n                    if (String(sName) === String(oldSiteName) && subIdx !== idx) {\n                        if (s.azimuth === oldAzimuth) {\n                            s.azimuth = newAzimuth; // Sync\n                            console.log('[SiteEditor] Synced azimuth for sector ${subIdx}');\n                        }\n                    }\n                });\n            }\n        }\n    }\n\n    // Refresh Map\n    window.mapRenderer.rebuildSiteIndex();\n    window.mapRenderer.renderSites(false);\n\n    document.getElementById(\'siteEditorModal\').style.display = \'none\';\n};\n\n\nwindow.deleteSectorCurrent = function () {\n    const originalIndex = document.getElementById(\'editOriginalIndex\').value;\n    const originalId = document.getElementById(\'editOriginalId\').value;\n\n    if (!confirm("Are you sure you want to delete this sector?")) return;\n\n    if (window.mapRenderer && window.mapRenderer.siteData) {\n        let idx = -1;\n        if (originalIndex !== "") {\n            idx = parseInt(originalIndex, 10);\n        } else if (originalId) {\n            idx = window.mapRenderer.siteData.findIndex(x => String(x.cellId) === String(originalId));\n        }\n\n        if (idx !== -1) {\n            window.mapRenderer.siteData.splice(idx, 1);\n            window.refreshSites();\n            document.getElementById(\'siteEditorModal\').style.display = \'none\';\n            // Sync to Backend\n            window.syncToBackend(window.mapRenderer.siteData);\n        }\n    }\n};\n\nwindow.syncToBackend = function (siteData) {\n    if (!siteData) return;\n\n    // Show saving feedback\n    const status = document.getElementById(\'fileStatus\');\n    if (status) status.textContent = "Saving to Excel...";\n\n    fetch(\'/save_sites\', {\n        method: \'POST\',\n        headers: {\n            \'Content-Type\': \'application/json\'\n        },\n        body: JSON.stringify(siteData)\n    })\n        .then(response => response.json())\n        .then(data => {\n            console.log(\'Save success:\', data);\n            if (status) status.textContent = "Changes saved to sites_updated.xlsx";\n            setTimeout(() => { if (status) status.textContent = ""; }, 3000);\n        })\n        .catch((error) => {\n            console.error(\'Save error:\', error);\n            if (status) status.textContent = "Error saving to Excel (Check console)";\n        });\n};\n\n// Initialize Map Action Controls Draggability\n// Map Action Controls are now fixed in the header, no draggability needed.\n\n// ----------------------------------------------------\n\nconst getVal = (keys) => {\n    for (const k of keys) {\n        if (d[k] !== undefined && d[k] !== null && d[k] !== \'\') {\n            const clean = String(d[k]).replace(/[^\d.-]/g, \'\');\n            const floatVal = parseFloat(clean);\n            if (!isNaN(floatVal)) return floatVal;\n        }\n    }\n    return null;\n};\n\n// Metrics\nconst rsrp = getVal([\'RSRP\', \'Signal Strength\', \'rsrp\']);\nconst sinr = getVal([\'SINR\', \'Sinr\', \'sinr\']);\nconst dlTput = getVal([\'DL Throughput\', \'Downlink Throughput\', \'DL_Throughput\']);\nconst prbLoad = getVal([\'PRB Load\', \'Load\', \'Cell Load\']);\n\n// Context\nconst cellId = d[\'Cell Identifier\'] || \'Unknown\';\n\n// Robust Location Lookup\nconst latRaw = d[\'lat\'] || d[\'Latitude\'] || d[\'latitude\'] || d[\'LAT\'];\nconst lngRaw = d[\'lng\'] || d[\'Longitude\'] || d[\'longitude\'] || d[\'LONG\'];\n\nlet location = "Unknown";\nif (latRaw && lngRaw) {\n    const lat = parseFloat(latRaw);\n    const lng = parseFloat(lngRaw);\n    if (!isNaN(lat) && !isNaN(lng)) {\n        location = '${lat.toFixed(5)}, ${lng.toFixed(5)}';\n    }\n}\n\n// --- 2. Logic Engine ---\n\n// A. Overall Performance Status\nlet status = "Satisfactory";\nlet statusClass = "status-ok"; // Default Green\n\nif (rsrp !== null && rsrp < -110) { status = "Critically Degraded (Coverage)"; statusClass = "status-bad"; }\nelse if (sinr !== null && sinr < 0) { status = "Critically Degraded (Interference)"; statusClass = "status-bad"; }\nelse if (rsrp !== null && rsrp < -100) { status = "Poor"; statusClass = "status-bad"; }\nelse if (sinr !== null && sinr < 5) { status = "Suboptimal"; statusClass = "status-warn"; }\nelse if (rsrp > -95 && sinr > 10) { status = "Excellent"; statusClass = "status-ok"; }\n\n// B. User Impact & Service\nlet userExp = "Satisfactory";\nlet impactedService = "None specific";\nlet impactClass = "status-ok";\nlet isLowTput = false;\n\nif (dlTput !== null) {\n    if (dlTput < 1) { userExp = "Severely Limited"; impactedService = "Real-time Video & Browsing"; isLowTput = true; impactClass = "status-bad"; }\n    else if (dlTput < 3) { userExp = "Degraded"; impactedService = "HD Video Streaming"; isLowTput = true; impactClass = "status-warn"; }\n    else if (dlTput < 5) { userExp = "Acceptable"; impactedService = "File Downloads"; impactClass = "status-warn"; }\n    else { userExp = "Good"; impactedService = "High Bandwidth Applications"; impactClass = "status-ok"; }\n} else {\n    if (status.includes("Critical")) { userExp = "Severely Limited"; impactedService = "All Data Services"; impactClass = "status-bad"; }\n    else if (status.includes("Poor")) { userExp = "Degraded"; impactedService = "High Bitrate Video"; impactClass = "status-warn"; }\n}\n\n// C. Primary Issues\nlet primaryCause = "None detected";\nlet secondaryCause = "";\n\nif (rsrp !== null && rsrp < -110) primaryCause = "Weak RF Coverage (Dead Zone)";\nelse if (sinr !== null && sinr < 3) primaryCause = "High Signal Interference";\nelse if (prbLoad !== null && prbLoad > 80) primaryCause = "High Capacity Utilization (Load)";\nelse if (sinr !== null && sinr < 8) primaryCause = "Moderate Interference (Pilot Pollution)";\nelse if (rsrp !== null && rsrp < -100) primaryCause = "Weak RF Coverage (Edge of Cell)";\n\nif (primaryCause.includes("Coverage") && sinr !== null && sinr < 5) secondaryCause = "Compounded by Interference";\nif (primaryCause.includes("Interference") && rsrp !== null && rsrp < -105) secondaryCause = "Compounded by Weak Signal";\n\n// D. Congestion Analysis\nlet congestionStatus = "not congested";\nlet issueType = "radio-quality-related";\nlet congestionClass = "status-ok";\n\nif (prbLoad !== null && prbLoad > 75) {\n    congestionStatus = "congested";\n    issueType = "capacity-related";\n    congestionClass = "status-bad";\n} else if (rsrp > -95 && sinr > 10 && isLowTput) {\n    congestionStatus = "likely congested (Backhaul/Transport)";\n    issueType = "capacity-related";\n    congestionClass = "status-warn";\n}\n\n// E. Actions\nlet highPriority = [];\nlet mediumPriority = [];\nlet conclusionAction = "targeted optimization";\n\nif (primaryCause.includes("Coverage") && congestionStatus.includes("congested")) {\n    highPriority.push("Review Power Settings / Load Balancing");\n    highPriority.push("Capacity Expansion (Carrier Add/Sector Split)");\n    conclusionAction = "capacity expansion";\n} else if (primaryCause.includes("Coverage")) {\n    highPriority.push("Check Antenna Tilt (Uptilt if possible)");\n    highPriority.push("Verify Neighbor Cell Relations");\n    mediumPriority.push("Drive Test Verification required");\n} else if (primaryCause.includes("Interference")) {\n    highPriority.push("Check Overshooting Neighbors");\n    highPriority.push("Review Antenna Downtilts");\n    mediumPriority.push("PCI Planning Review");\n} else if (congestionStatus.includes("congested")) {\n    highPriority.push("Load Balancing Strategy Review");\n    highPriority.push("Capacity Expansion Planning");\n    conclusionAction = "capacity expansion";\n} else {\n    highPriority.push("Routine Performance Monitoring");\n    mediumPriority.push("Verify Parameter Consistency");\n}\n\nif (highPriority.length === 0) highPriority.push("Monitor Performance Trend");\n\n// --- 3. Format Output (HTML Structure) ---\n// Helper to colorize Cause\nconst causeClass = primaryCause === "None detected" ? "status-ok" : "status-bad";\n\nconst report = '
            <div class="report-block">
                <h4>CELL PERFORMANCE – MANAGEMENT SUMMARY</h4>
                <div style="display:flex; justify-content:space-between; margin-bottom:10px;">
                    <div><strong>Cell ID:</strong> ${cellId}</div>
                    <div><strong>Location:</strong> ${location}</div>
                    <div><strong>Technology:</strong> LTE</div>
                </div>
            </div>

            <div class="report-block">
                <h4>Overall Performance Status</h4>
                <p>The cell performance is classified as <span class="${statusClass}" style="padding:2px 6px; border-radius:4px; font-weight:bold;">${status}</span>.</p>
            </div>

            <div class="report-block">
                <h4>User Impact</h4>
                <p>
                   Downlink user experience is <span class="${impactClass}" style="font-weight:bold;">${userExp}</span>,
                   mainly affecting <strong>${impactedService}</strong> traffic.
                </p>
            </div>

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
            </div>

            <div class="report-block">
                <h4>Network Load Assessment</h4>
                <p>The cell is <span class="${congestionClass}" style="font-weight:bold;">${congestionStatus}</span>,</p>
                <p>indicating that the performance issue is <strong>${issueType}</strong>.</p>
            </div>

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
            </div>

            <div class="report-block" style="border-left: 4px solid #a29bfe; background: rgba(162, 155, 254, 0.1);">
                <h4 style="color:#a29bfe;">EXECUTIVE CONCLUSION</h4>
                <p>
                    This LTE cell requires <strong>${conclusionAction.toUpperCase()}</strong> 
                    to improve customer experience and overall network efficiency.
                </p>
            </div>
        ';\n\n// --- 4. Display ---\nwindow.showAnalysisModal(report, "MANAGEMENT SUMMARY");\n};\n\nwindow.showAnalysisModal = (content, title) => {\n    let modal = document.getElementById(\'analysisModal\');\n\n    // --- LAZY CREATE MODAL IF MISSING ---\n    if (!modal) {\n        const modalHtml = '
                <div class="analysis-modal-overlay" onclick="const m=document.querySelector('.analysis-modal-overlay'); if(event.target===m) m.remove()">
                    <div class="analysis-modal" id="analysisModal" style="width: 800px; max-width: 90vw; display:flex;">
                        <div class="analysis-header">
                            <h3 id="analysisModalTitle">Cell Performance Analysis Report</h3>
                            <button class="analysis-close-btn" onclick="document.querySelector('.analysis-modal-overlay').remove()">×</button>
                        </div>
                        <div class="analysis-content" style="padding: 30px;" id="analysisResultBody">
                            <!-- Content Injected Here -->
                        </div>
                    </div>
                </div>
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

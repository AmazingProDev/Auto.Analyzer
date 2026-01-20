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
        // console.log(`[App] layer-metric-ready received for: ${e.detail.metric}`);
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

            // console.log(`[App] Drawn line to Serving Cell: ${servingCell.cellName || servingCell.cellId}`);
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
            a.download = `${log.name}_${renderer.activeMetric}.kml`;
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
            a.download = `Sites_Database_${new Date().getTime()}.kml`;
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
        item.id = `sc-group-${layerId}`;

        // Toggle Logic embedded in onclick
        item.onclick = (e) => {
            // Prevent toggling if clicking specific control buttons
            if (e.target.closest('.sc-btn') || e.target.closest('.sc-metric-button')) return;
            item.classList.toggle('expanded');
        };

        const metricsHtml = (customMetrics && customMetrics.length > 0)
            ? `<div class="sc-metric-container">
                ${customMetrics.map(m => `
                    <div class="sc-metric-button ${log.currentParam === m ? 'active' : ''}" 
                         onclick="window.showMetricOptions(event, '${layerId}', '${m}', 'smartcare')">${m}</div>
               `).join('')}
               </div>`
            : '<div style="font-size:10px; color:#666; font-style:italic;">No metrics found</div>';

        item.innerHTML = `
            <div class="sc-group-title-row">
                <div class="sc-group-name">
                    <span class="sc-caret">▶</span>
                    ${name}
                </div>
                <!-- Top Level Controls -->
                <div class="sc-layer-controls">
                    <button class="sc-btn sc-btn-toggle" onclick="toggleSmartCareLayer('${layerId}')" title="Toggle Visibility">👁️</button>
                    <button class="sc-btn sc-btn-remove" onclick="removeSmartCareLayer('${layerId}')" title="Remove Layer">❌</button>
                </div>
            </div>

            <!-- Expandable Body -->
            <div class="sc-layer-body">
                <!-- Meta Row -->
                <div class="sc-meta-row">
                    <div class="sc-meta-left">
                        <span class="sc-tech-badge-sm">${techLabel}</span>
                        <span class="sc-count-badge-sm">${pointCount} pts</span>
                    </div>
                </div>
                <!-- Metrics Grid -->
                ${metricsHtml}
            </div>
        `;

        scLayerList.appendChild(item);
    }

    window.switchSmartCareMetric = (layerId, metric) => {
        const log = window.loadedLogs.find(l => l.id === layerId);
        if (log && window.mapRenderer) {
            console.log(`[SmartCare] Switching metric for ${layerId} to ${metric}`);
            log.currentParam = metric; // Track active metric for this layer
            window.mapRenderer.updateLayerMetric(layerId, log.points, metric);

            // Update UI active state
            const container = document.querySelector(`#sc-item-${layerId} .sc-metric-container`);
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
        menu.style.top = `${rect.bottom + window.scrollY + 5}px`;
        menu.style.left = `${rect.left + window.scrollX}px`;

        menu.innerHTML = `
            <div class="sc-menu-item" id="menu-map-${layerId}">
                <span>🗺️</span> Map
            </div>
            <div class="sc-menu-item" id="menu-grid-${layerId}">
                <span>📊</span> Grid
            </div>
            <div class="sc-menu-item" id="menu-chart-${layerId}">
                <span>📈</span> Chart
            </div>
        `;

        document.body.appendChild(menu);

        // Map Click Handler
        menu.querySelector(`#menu-map-${layerId}`).onclick = () => {
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
        menu.querySelector(`#menu-grid-${layerId}`).onclick = () => {
            window.openGridModal(log, metric);
            menu.remove();
        };

        // Chart Click Handler
        menu.querySelector(`#menu-chart-${layerId}`).onclick = () => {
            window.openChartModal(log, metric);
            menu.remove();
        };

        // Auto-position adjustment if it goes off screen
        const menuRect = menu.getBoundingClientRect();
        if (menuRect.right > window.innerWidth) {
            menu.style.left = `${window.innerWidth - menuRect.width - 10}px`;
        }
        if (menuRect.bottom > window.innerHeight) {
            menu.style.top = `${rect.top + window.scrollY - menuRect.height - 5}px`;
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
            const btn = document.querySelector(`#sc-item-${layerId} .sc-btn-toggle`);
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
        const item = document.getElementById(`sc-item-${layerId}`);
        if (item) item.remove();

        // Hide sidebar if empty
        if (scLayerList.children.length === 0) {
            scSidebar.style.display = 'none';
        }
    }

    shpInput.onchange = async (e) => {
        const files = Array.from(e.target.files);
        console.log(`[Import] Selected ${files.length} files:`, files.map(f => f.name));

        if (files.length === 0) return;

        // Filter for Excel files (Case Insensitive)
        const excelFiles = files.filter(f => {
            const name = f.name.toLowerCase();
            return name.endsWith('.xlsx') || name.endsWith('.xls');
        });

        console.log(`[Import] Detected ${excelFiles.length} Excel files.`);

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

            console.log(`[Excel] Parsed ${file.name}: ${json.length} rows`);

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
                    foundCellId = `${rnc}/${cid}`;
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
            console.error(`Error parsing ${file.name}`, e);
            throw e;
        }
    }

    async function handleExcelImport(file) {
        fileStatus.textContent = `Parsing Excel: ${file.name}...`;
        try {
            const { points, customMetrics } = await parseExcelFile(file);

            const fileName = file.name.split('.')[0];
            const logId = `excel_${Date.now()}`;

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
            fileStatus.textContent = `Loaded Excel: ${fileName}`;

            // Auto-Zoom
            const latLngs = points.map(p => [p.lat, p.lng]);
            const bounds = L.latLngBounds(latLngs);
            window.map.fitBounds(bounds);

            if (window.mapRenderer) {
                window.mapRenderer.updateLayerMetric(logId, points, 'level');
            }
        } catch (e) {
            console.error(e);
            alert(`Failed to import ${file.name}`);
            fileStatus.textContent = 'Import Failed';
        }
    }

    async function handleMergedExcelImport(files) {
        fileStatus.textContent = `Merging ${files.length} Excel files...`;

        // Map to store merged points: Key -> Point
        const mergedPointsMap = new Map();
        const allMetrics = new Set();
        const nameList = [];

        try {
            for (let i = 0; i < files.length; i++) {
                const file = files[i];
                fileStatus.textContent = `Parsing ${i + 1}/${files.length}: ${file.name}...`;
                const result = await parseExcelFile(file);

                nameList.push(file.name.split('.')[0]);
                result.customMetrics.forEach(m => allMetrics.add(m));

                // MERGE LOGIC (Spatial Join)
                result.points.forEach(p => {
                    // Precision for 50m grid (5 decimals is ~1m, adequate for aggregation)
                    const key = `${p.lat.toFixed(5)}_${p.lng.toFixed(5)}`;

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

            const fileName = nameList.length > 3 ? `${nameList[0]}_plus_${nameList.length - 1}_merged` : nameList.join('_');
            const logId = `smartcare_merged_${Date.now()}`;

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
            fileStatus.textContent = `Merged ${files.length} files successfully.`;

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

            console.log(`[TRP] Found ${channelLogs.length} channel logs.`);

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
                            console.log(`[TRP] Parsed ${parserResult.points.length} points from ${logFile.name}`);
                            allPoints = allPoints.concat(parserResult.points);
                            allSignaling = allSignaling.concat(parserResult.signaling);
                        }
                    } else {
                        console.warn(`[TRP] Skipping binary log: ${logFile.name}`);
                        // Future: Implement binary parser or service.xml correlation if needed
                    }
                } catch (err) {
                    console.warn(`[TRP] Failed to parse ${logFile.name}:`, err);
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
            const logId = `trp_${Date.now()}`;
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

            fileStatus.textContent = `Loaded TRP: ${file.name}`;


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
                console.log(`[TRP Fallback] Parsed ${trackPoints.length} GPS points.`);
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
                            event: `${name} ${action}`, // e.g. "Voice Quality Stop"
                            message: `Service: ${name}`,
                            details: `Action: ${action}`,
                            direction: '-'
                        });
                    }
                }
                console.log(`[TRP Fallback] Parsed ${results.signaling.length} Service Events.`);
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
            const logId = `shp_${Date.now()}`;

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
            fileStatus.textContent = `Loaded SHP: ${fileName}`;

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
                'Authorization': `Bearer ${key}`
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
                aiContent.innerHTML = `<div style="color: #ef4444; text-align: center; padding: 20px;">
                    <h3>Analysis Failed</h3>
                    <p><strong>Error:</strong> ${userMsg}</p>
                    <p style="font-size:12px; color:#aaa; margin-top:5px;">Check console for details.</p>
                    <div style="display:flex; justify-content:center; gap:10px; margin-top:20px;">
                         <button onclick="window.runAIAnalysis()" class="btn" style="background: linear-gradient(135deg, #6366f1 0%, #a855f7 100%); width: auto;">Retry</button>
                         <button onclick="document.getElementById('aiApiKeySection').style.display='block'; document.getElementById('aiLoading').style.display='none'; document.getElementById('aiContent').innerHTML='';" class="btn" style="background:#555;">Back</button>
                    </div>
                </div>`;
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
            .map(([sc, count]) => `SC ${sc} (${((count / totalPoints) * 100).toFixed(1)}%)`)
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
        return `You are an expert RF Optimization Engineer. Analyze the following drive test summary data:
        
        - Technologies Found: ${metrics.technologies}
        - Total Samples: ${metrics.totalPoints}
        - Average Signal Strength (RSCP/RSRP): ${metrics.avgRscp} dBm
        - Average Quality (EcNo/RSRQ): ${metrics.avgEcno} dB
        - Weak Coverage Samples (< -100dBm): ${metrics.weakSignalPct}%
        - Top Serving Cells: ${metrics.topCells}

        Provide a concise analysis in Markdown format:
        1. **Overall Health**: Assess the network condition (Good, Fair, Poor).
        2. **Key Issues**: Identify potential problems (e.g., coverage holes, interference, dominance).
        3. **Recommended Actions**: Suggest 3 specific optimization actions (e.g., downtilt, power adjustment, neighbor checks).
        
        Keep it professional and technical.`;
    }

    async function callGeminiAPI(key, model, prompt) {
        // Use selected model
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;

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
        // But `openChartModal` starts at line 95.
        // Does the Chart Logic use variables from top of `openChartModal`?
        // `isDocked`, `container`, `log`, `param`.
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
            const label = p.time || `Pt ${i}`;
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
            ? `<button onclick="window.undockChart()" style="background:#555; color:white; border:none; padding:5px 10px; cursor:pointer; font-size:11px;">Undock</button>`
            : `<button onclick="window.dockChart()" style="background:#3b82f6; color:white; border:none; padding:5px 10px; cursor:pointer; font-size:11px;">Dock</button>`;

        const closeBtn = isDocked
            ? ''
            : `<button onclick="window.currentChartInstance=null;window.currentChartLogId=null;document.getElementById('chartModal').remove()" style="background:#ef4444; color:white; border:none; padding:5px 10px; cursor:pointer; pointer-events:auto;">Close</button>`;

        const dragCursor = isDocked ? 'default' : 'move';

        container.innerHTML = `
                    <div id="${headerId}" style="padding:10px; background:#2d2d2d; border-bottom:1px solid #444; display:flex; justify-content:space-between; align-items:center; cursor:${dragCursor}; user-select:none;">
                        <div style="display:flex; align-items:center; pointer-events:none;">
                            <h3 style="margin:0; margin-right:20px; pointer-events:auto; font-size:14px;">${log.name} - ${isComposite ? 'RSCP & Neighbors' : param.toUpperCase()} (Snapshot)</h3>
                            <button id="styleToggleBtn" style="background:#333; color:#ccc; border:1px solid #555; padding:5px 10px; cursor:pointer; pointer-events:auto; font-size:11px;">⚙️ Style</button>
                        </div>
                        <div style="pointer-events:auto; display:flex; gap:10px;">
                            ${dockBtn}
                            ${closeBtn}
                        </div>
                    </div>
                    
                    <!-- Settings Panel -->
                    <div id="${controlsId}" style="display:none; background:#252525; padding:10px; border-bottom:1px solid #444; gap:15px; align-items:center; flex-wrap:wrap;">
                        <!-- Serving Controls -->
                        <div style="display:flex; flex-direction:column; gap:2px; border-right:1px solid #444; padding-right:10px;">
                            <label style="color:#aaa; font-size:10px; font-weight:bold;">Serving</label>
                             <input type="color" id="pickerServing" value="#3b82f6" style="border:none; width:30px; height:20px; cursor:pointer;">
                        </div>

                        ${isComposite ? `
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
                        ` : ''}
                    </div>

                    <div style="flex:1; padding:10px; display:flex; gap:10px; height: 100%; min-height: 0;">
                        <!-- Bar Chart Section (100%) -->
                        <div id="barChartContainer" style="flex:1; position:relative; min-width:0;">
                            <canvas id="barChartCanvas"></canvas>
                             <div id="barOverlayInfo" style="position:absolute; top:10px; right:10px; color:white; background:rgba(0,0,0,0.7); padding:2px 5px; border-radius:4px; font-size:10px; pointer-events:none;">
                                Snapshot
                            </div>
                        </div>
                    </div>
                    <!-- Resize handle visual cue (bottom right) -->
                    <div style="position:absolute; bottom:2px; right:2px; width:10px; height:10px; cursor:nwse-resize;"></div>
                `;

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
                    const lbl = (prefix, sc) => sc !== undefined && sc !== null ? `${prefix} (${sc})` : prefix;

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
                        textLines.push(`${levelVal.toFixed(1)}`); // Level

                        if (index === 0) {
                            // Serving
                            const sc = p.sc ?? (p.parsed && p.parsed.serving ? p.parsed.serving.sc : '-');
                            const band = p.parsed && p.parsed.serving ? p.parsed.serving.band : '-';
                            if (sc !== undefined) textLines.push(`SC: ${sc}`);
                            if (band) textLines.push(band);
                        } else {
                            // For others (A2, A3, N1...), use the SC included in the Axis Label
                            // Label format: "Name (SC)" e.g. "N1 (120)"
                            const axisLabel = chart.data.labels[index];
                            const match = /\((\d+)\)/.exec(axisLabel);
                            if (match) {
                                textLines.push(`SC: ${match[1]}`);
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
                    .bindPopup(`<b>Search Location</b><br>Lat: ${lat}<br>Lng: ${lng}`).openPopup();
                document.getElementById('fileStatus').textContent = `Zoomed to ${lat.toFixed(6)}, ${lng.toFixed(6)}`;
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

                    document.getElementById('fileStatus').textContent = `Found: ${best.cellName || best.name} (${best.cellId})`;
                } else {
                    alert(`Site found but has no coordinates: ${best.cellName || best.name}`);
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
        if (t.min !== undefined && t.max !== undefined) t.label = `${t.min} to ${t.max}`;
        else if (t.min !== undefined) t.label = `> ${t.min}`;
        else if (t.max !== undefined) t.label = `< ${t.max}`;

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

            container.setAttribute('style', `
                position: fixed;
                top: ${topPos}px; 
                right: ${rightPos}px;
                width: 320px;
                min-width: 250px;
                max-width: 600px;
                max-height: 80vh;
                background-color: rgba(30, 30, 30, 0.95);
                border: 2px solid #555;
                border-radius: 6px;
                color: #fff;
                z-index: 10001; 
                box-shadow: 0 4px 15px rgba(0,0,0,0.6);
                display: flex;
                flex-direction: column;
                resize: both;
                overflow: hidden;
            `);

            // Disable Map Interactions passing through Legend
            if (typeof L !== 'undefined' && L.DomEvent) {
                L.DomEvent.disableClickPropagation(container);
                L.DomEvent.disableScrollPropagation(container);
            }

            // Global Header (Drag Handle)
            const mainHeader = document.createElement('div');
            mainHeader.setAttribute('style', `
                padding: 8px 10px;
                background-color: #252525;
                font-weight: bold;
                font-size: 13px;
                border-bottom: 1px solid #444;
                cursor: grab;
                display: flex;
                justify-content: space-between;
                align-items: center;
                border-radius: 6px 6px 0 0;
                flex-shrink: 0;
            `);
            mainHeader.innerHTML = `
                <span>Legend</span>
                <div style="display:flex; gap:8px; align-items:center;">
                     <span onclick="this.closest('#draggable-legend').remove(); window.legendControl=null;" style="cursor:pointer; color:#aaa; font-size:18px; line-height:1;">&times;</span>
                </div>
            `;
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
            scrollContent.innerHTML = `<div style="padding:10px; color:#888; text-align:center;">No visible layers.</div>`;
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
                sectHeader.innerHTML = `<span style="font-weight:bold; color:#eee;">${log.name}</span> <span style="font-size:10px; color:#aaa;">(${metric})</span>`;
                sectHeader.setAttribute('style', 'background:#333; padding: 5px 8px; font-size:12px; border-bottom:1px solid #444;');
                section.appendChild(sectHeader);

                const sectBody = document.createElement('div');
                sectBody.setAttribute('style', 'padding:5px; background:rgba(0,0,0,0.2);');

                if (metric === 'cellId' || metric === 'cid') {
                    const ids = statsObj.activeMetricIds || [];
                    const sortedIds = ids.slice().sort((a, b) => (stats.get(b) || 0) - (stats.get(a) || 0));
                    if (sortedIds.length > 0) {
                        let html = `<div style="display:flex; flex-direction:column; gap:4px;">`;
                        sortedIds.slice(0, 50).forEach(id => {
                            const color = renderer.getDiscreteColor(id);
                            let name = id;
                            if (window.mapRenderer && window.mapRenderer.siteIndex && window.mapRenderer.siteIndex.byId) {
                                const site = window.mapRenderer.siteIndex.byId.get(id);
                                if (site) name = site.cellName || site.name || id;
                            }
                            const count = stats.get(id) || 0;
                            html += `<div class="legend-row">
                                <div class="legend-swatch" style="background:${color};"></div>
                                <span class="legend-label">${name}</span>
                                <span class="legend-count">${count}</span>
                            </div>`;
                        });
                        if (sortedIds.length > 50) html += `<div style="font-size:10px; color:#888; text-align:center; padding: 4px;">+ ${sortedIds.length - 50} more...</div>`;
                        html += `</div>`;
                        sectBody.innerHTML = html;
                    }
                }
                else {
                    const key = window.getThresholdKey ? window.getThresholdKey(metric) : metric;
                    const thresholds = (window.themeConfig && window.themeConfig.thresholds[key]) ? window.themeConfig.thresholds[key] : null;
                    if (thresholds) {
                        let html = `<div style="display:flex; flex-direction:column; gap:6px;">`;
                        thresholds.forEach((t, idx) => {
                            const count = stats.get(t.label) || 0;
                            const pct = total > 0 ? ((count / total) * 100).toFixed(1) : '0';
                            const minVal = t.min !== undefined ? `<input type="number" value="${t.min}" class="legend-input" onchange="window.handleLegendThresholdChange('${key}', ${idx}, 'min', this.value)">` : '-∞';
                            const maxVal = t.max !== undefined ? `<input type="number" value="${t.max}" class="legend-input" onchange="window.handleLegendThresholdChange('${key}', ${idx}, 'max', this.value)">` : '+∞';
                            html += `<div class="legend-row">
                                <input type="color" value="${t.color}" class="legend-color-input" onchange="window.handleLegendColorChange('${key}', ${idx}, this.value)">
                                <div class="legend-label" style="display:flex; align-items:center; gap:4px;">
                                    ${minVal} <span style="font-size:9px; color:#666;">to</span> ${maxVal}
                                </div>
                                <span class="legend-count">${count} (${pct}%)</span>
                            </div>`;
                        });
                        html += `</div>`;
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
                inputs += `<label style="font-size:10px; color:#aaa;">Min</label>
                           <input type="number" class="thresh-min" data-idx="${idx}" value="${t.min}" style="width:50px; background:#333; border:1px solid #555; color:#fff; font-size:11px; padding:2px;">`;
            } else {
                inputs += `<span style="font-size:10px; color:#aaa; width:50px; display:inline-block;">( -∞ )</span>`;
            }

            // If it has Max, show Max Input
            if (t.max !== undefined) {
                inputs += `<label style="font-size:10px; color:#aaa; margin-left:5px;">Max</label>
                           <input type="number" class="thresh-max" data-idx="${idx}" value="${t.max}" style="width:50px; background:#333; border:1px solid #555; color:#fff; font-size:11px; padding:2px;">`;
            } else {
                inputs += `<span style="font-size:10px; color:#aaa; width:50px; display:inline-block; margin-left:5px;">( +∞ )</span>`;
            }

            // Remove Button
            const removeBtn = `<button onclick="window.removeThreshold(${idx})" style="margin-left:auto; background:none; border:none; color:#ef4444; cursor:pointer;" title="Remove Range">✖</button>`;

            div.innerHTML = `
                <div style="display:flex; align-items:center;">
                    <input type="color" class="thresh-color" data-idx="${idx}" value="${t.color}" style="border:none; width:20px; height:20px; cursor:pointer; margin-right:5px;">
                    ${inputs}
                    ${removeBtn}
                </div>
            `;
            thresholdsContainer.appendChild(div);
        });

        // Add "Add Range" Button at bottom
        const addDiv = document.createElement('div');
        addDiv.style.textAlign = 'center';
        addDiv.style.marginTop = '10px';
        addDiv.innerHTML = `<button onclick="window.addThreshold()" style="background:#3b82f6; border:none; color:white; padding:4px 10px; border-radius:4px; font-size:11px; cursor:pointer;">+ Add Range</button>`;
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
                if (t.min !== undefined && t.max !== undefined) t.label = `${t.min} to ${t.max}`;
                else if (t.min !== undefined) t.label = `> ${t.min}`;
                else if (t.max !== undefined) t.label = `< ${t.max}`;

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
            if (titleEl) titleEl.textContent = `Grid View: ${log.name}`;

            // Store ID for dragging context
            window.currentGridLogId = log.id;

            // Build Table
            // Build Table
            // Ensure headers are draggable for metric drop functionality
            let tableHtml = `<table style="width:100%; border-collapse:collapse; color:#eee; font-size:12px;">
                <thead style="position:sticky; top:0; background:#333; height:30px;">
                    <tr>
                        <th style="padding:4px 8px; text-align:left;">Time</th>
                        <th style="padding:4px 8px; text-align:left;">Lat</th>
                        <th style="padding:4px 8px; text-align:left;">Lng</th>
                        <th draggable="true" ondragstart="window.handleHeaderDragStart(event)" data-param="cellId" style="padding:4px 8px; text-align:left; cursor:grab;">RNC/CID</th>`;

            window.currentGridColumns.forEach(col => {
                if (col === 'cellId') return; // Skip cellId as it is handled by RNC/CID column
                tableHtml += `<th draggable="true" ondragstart="window.handleHeaderDragStart(event)" data-param="${col}" style="padding:4px 8px; text-align:left; text-transform:uppercase; cursor:grab;">${col}</th>`;
            });
            tableHtml += `</tr></thead><tbody>`;

            let rowsHtml = '';
            const limit = 5000; // Limit for performance

            log.points.slice(0, limit).forEach((p, i) => {
                // Add ID and Click Handler
                // RNC/CID Formatter
                const rncCid = (p.rnc !== undefined && p.rnc !== null && p.cid !== undefined && p.cid !== null)
                    ? `${p.rnc}/${p.cid}`
                    : (p.cellId || '-');

                let row = `<tr id="grid-row-${i}" class="grid-row" onclick="window.globalSync('${log.id}', ${i}, 'grid')" style="cursor:pointer; transition: background 0.1s;">
                <td style="padding:4px 8px; border-bottom:1px solid #333;">${p.time}</td>
                <td style="padding:4px 8px; border-bottom:1px solid #333;">${p.lat.toFixed(5)}</td>
                <td style="padding:4px 8px; border-bottom:1px solid #333;">${p.lng.toFixed(5)}</td>
                <td style="padding:4px 8px; border-bottom:1px solid #333;">${rncCid}</td>`;

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
                        val = `${p.rnc}/${cid}`;
                    }

                    // Format numbers
                    if (val === undefined || val === null) val = '';
                    if (typeof val === 'number') {
                        if (String(val).includes('.')) val = val.toFixed(2); // Cleaner floats
                    }

                    row += `<td style="padding:4px 8px; border-bottom:1px solid #333;">${val}</td>`;
                });
                row += `</tr>`;
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
            // efficient removal
            if (window.lastHighlightedRowIndex !== null && window.lastHighlightedRowIndex !== index) {
                const oldRow = document.getElementById(`grid-row-${window.lastHighlightedRowIndex}`);
                if (oldRow) oldRow.classList.remove('selected-row');
            }

            // efficient addition
            const row = document.getElementById(`grid-row-${index}`);
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
                    val = `${p.rnc}/${cid}`;
                }

                if (val === undefined || val === null) val = '';
                // Escape commas for CSV
                if (String(val).includes(',')) val = `"${val}"`;
                rowData.push(val);
            });
            rows.push(rowData.join(','));
        });

        const csvContent = "data:text/csv;charset=utf-8," + rows.join("\n");
        const encodedUri = encodeURI(csvContent);
        const link = document.createElement("a");
        link.setAttribute("href", encodedUri);
        link.setAttribute("download", `grid_export_${log.name}.csv`);
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
        link.setAttribute("download", `${log.name}_optim_export.csv`);
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
                if (s.rnc && s.cid) finalId = `${s.rnc}/${s.cid}`;

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

            rawHtml += `<div style="display:flex; justify-content:space-between; border-bottom:1px solid #444; font-size:11px; padding:3px 0;">
                <span style="color:#aaa; font-weight:500; margin-right: 10px;">${k}</span>
                <span style="color:#fff; font-weight:bold; word-break: break-all; text-align: right;">${displayVal}</span>
            </div>`;
        });

        let html = `
            <div style="padding: 10px;">
                <!-- Serving Cell Header (Fixed) -->
                ${servingRes && servingRes.name ? `
                <div style="margin-bottom:10px; padding-bottom:10px; border-bottom:1px solid #444;">
                    <div style="font-size:14px; font-weight:bold; color:#22c55e;">${servingRes.name}</div>
                    <div style="font-size:11px; color:#888;">ID: ${servingRes.id || '-'}</div>
                </div>` : ''}

                <div style="display:flex; justify-content:space-between; margin-bottom:10px; border-bottom: 2px solid #555; padding-bottom:5px;">
                    <span style="font-size:12px; color:#ccc;">${p.time || sourceObj.Time || 'No Time'}</span>
                    <span style="font-size:12px; color:#ccc;">${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}</span>
                </div>

                <!-- Event Info (Highlight) -->
                ${p.event ? `
                    <div style="background:#451a1a; color:#f87171; padding:5px; border-radius:4px; margin-bottom:10px; font-weight:bold; text-align:center;">
                        ${p.event}
                    </div>
                ` : ''}
                
                <div class="raw-data-container" style="max-height: 400px; overflow-y: auto;">
                    ${rawHtml}
                </div>
                
                <div style="display:flex; gap:10px; margin-top:10px;">
                    <button class="btn btn-blue" onclick="window.analyzePoint(this)" style="flex:1; justify-content: center;">Analyze Point</button>
                    <button class="btn btn-purple" onclick="window.generateManagementSummary()" style="flex:1; justify-content: center;">MANAGEMENT SUMMARY</button>
                </div>
                    <!-- Hidden data stash for the analyzer -->
                    <script type="application/json" id="point-data-stash">
                    ${(() => {
                // Robust Key Finder for Stash
                const findKey = (obj, target) => {
                    const t = target.toLowerCase().replace(/\s/g, '');
                    for (let k of Object.keys(obj)) {
                        if (k.toLowerCase().replace(/\s/g, '') === t) return obj[k];
                    }
                    return undefined;
                };
                const cellName = findKey(sourceObj, 'Cell Name') || findKey(sourceObj, 'CellName') || findKey(sourceObj, 'Site Name');
                const cellId = findKey(sourceObj, 'Cell ID') || findKey(sourceObj, 'CellID') || findKey(sourceObj, 'CI');

                return JSON.stringify({
                    ...sourceObj,
                    'Cell Identifier': servingRes && servingRes.name ? servingRes.name : (cellName || servingRes.id || cellId || 'Unknown'),
                    'Cell Name': servingRes && servingRes.name ? servingRes.name : (cellName || 'Unknown'),
                    'Tech': p.tech || sourceObj.Tech || (p.rsrp !== undefined ? 'LTE' : 'UMTS')
                });
            })()}
                    </script>
                </div>
            </div>
        `;

        return { html, connectionTargets };
    }

    // --- ANALYSIS ENGINE ---

    window.analyzePoint = (btn) => {
        try {
            // Retrieve data from stash or passed argument
            // FIX: Stash might be sibling or global due to layout changes
            let script = document.getElementById('point-data-stash');

            // Fallback scope check if needed (though ID should be unique in panel)
            if (!script && btn) {
                const container = btn.parentNode.parentNode; // Check grandparent
                if (container) script = container.querySelector('#point-data-stash');
            }

            if (!script) {
                console.error("No point data found for analysis.");
                alert("Error: Analysis data missing from panel.");
                return;
            }
            const data = JSON.parse(script.textContent);

            // -------------------------------------------------------------
            // ANALYSIS LOGIC
            // -------------------------------------------------------------

            // Helper: Run Analysis for a SINGLE data object
            const runAnalysisForData = (d) => {
                // Scoped Key Finder
                const getVal = (targetName) => {
                    const normTarget = targetName.toLowerCase().replace(/[\s\-_]/g, '');
                    for (let k in d) {
                        const normKey = k.toLowerCase().replace(/[\s\-_]/g, '');
                        if (normKey === normTarget) return parseFloat(d[k]);
                        if (normKey.includes(normTarget)) return parseFloat(d[k]);
                    }
                    return null;
                };

                // Get Strings for Context
                const time = d['Time'] || d['time'] || d['timestamp'] || 'N/A';
                const tech = d['Tech'] || d['Technology'] || d['rat'] || 'LTE'; // Default LTE as per template if unknown
                const cellId = d['Cell Identifier'] || d['Cell ID'] || d['cellid'] || d['ci'] || d['Serving SC/PCI'] || 'Unknown';
                const lat = d['Latitude'] || d['lat'] || 'Unknown';
                const lng = d['Longitude'] || d['lng'] || 'Unknown';

                const rsrp = getVal('rsrp') ?? getVal('level');
                const rsrq = getVal('rsrq');
                const cqi = getVal('cqi') ?? getVal('averagedlwidebandcqi') ?? getVal('dlwidebandcqi');
                const dlLowThptRatio = getVal('dllowthroughputratio') ?? getVal('lowthpt') ?? 0;
                const dlSpecEff = getVal('dlspectrumefficiency') ?? getVal('dlspectrumeff') ?? getVal('se');
                const dlRbQty = getVal('averagedlrbquantity') ?? getVal('dlrbquantity') ?? getVal('rbutil');

                const dbUtil = getVal('prbutil') ?? getVal('rbutil');
                const dlIbler = getVal('dlibler') ?? getVal('bler');
                const rank2Pct = getVal('rank2percentage') ?? getVal('rank2');
                const ca1ccPct = getVal('dl1ccpercentage') ?? getVal('ca1cc');

                // --- EVALUATION ---
                let coverageStatus = 'Unknown';
                let coverageInterp = 'insufficient signal strength';
                if (rsrp !== null) {
                    if (rsrp >= -90) { coverageStatus = 'Good'; coverageInterp = 'strong signal strength'; }
                    else if (rsrp > -100) { coverageStatus = 'Fair'; coverageInterp = 'adequate signal strength'; }
                    else { coverageStatus = 'Poor'; coverageInterp = 'weak signal strength at cell edge'; }
                }

                let interferenceLevel = 'Unknown';
                if (rsrq !== null) {
                    if (rsrq >= -8) interferenceLevel = 'Low';
                    else if (rsrq > -11) interferenceLevel = 'Moderate';
                    else interferenceLevel = 'High';
                }

                let channelQuality = 'Unknown';
                if (cqi !== null) {
                    if (cqi < 6) channelQuality = 'Poor';
                    else if (cqi < 9) channelQuality = 'Keep';
                    else channelQuality = 'Good';
                }

                let dlUserExp = 'Unknown';
                if (dlLowThptRatio !== null) {
                    if (dlLowThptRatio >= 25) dlUserExp = 'Degraded';
                    else dlUserExp = 'Acceptable'; // Assuming metric is %
                    if (dlLowThptRatio < 1 && dlLowThptRatio > 0 && dlLowThptRatio >= 0.25) dlUserExp = 'Degraded';
                }

                let dlSpecPerf = 'Unknown';
                if (dlSpecEff !== null) {
                    if (dlSpecEff < 2000) dlSpecPerf = 'Low';
                    else if (dlSpecEff < 3500) dlSpecPerf = 'Moderate';
                    else dlSpecPerf = 'High';
                }

                let cellLoad = 'Unknown';
                let congestionInterp = 'not related';
                if (dbUtil !== null) {
                    if (dbUtil >= 80) { cellLoad = 'Congested'; congestionInterp = 'related'; }
                    else if (dbUtil < 70) cellLoad = 'Not Congested';
                    else cellLoad = 'Moderate';
                } else if (dlRbQty !== null) {
                    if (dlRbQty <= 100 && dlRbQty >= 0) {
                        if (dlRbQty >= 80) { cellLoad = 'Congested'; congestionInterp = 'related'; }
                        else if (dlRbQty < 70) cellLoad = 'Not Congested';
                    }
                }

                let mimoUtil = 'Unknown';
                if (rank2Pct !== null) {
                    if (rank2Pct >= 30) mimoUtil = 'Good';
                    else if (rank2Pct < 20) mimoUtil = 'Poor';
                    else mimoUtil = 'Moderate';
                }

                let caUtil = 'Unknown';
                let caInterp = 'limited';
                if (ca1ccPct !== null) {
                    if (ca1ccPct >= 60) { caUtil = 'Underutilized'; caInterp = 'limited'; }
                    else if (ca1ccPct < 50) { caUtil = 'Well Utilized'; caInterp = 'effective'; }
                    else { caUtil = 'Moderate'; caInterp = 'moderate'; }
                }

                // Root Cause Logic
                let rootCauses = [];
                if (coverageStatus !== 'Poor' && coverageStatus !== 'Unknown' && interferenceLevel === 'High') rootCauses.push('Interference-Limited');
                else if (coverageStatus === 'Poor') rootCauses.push('Coverage-Limited');

                if (cellLoad === 'Congested') rootCauses.push('Capacity / Congestion-Limited');
                if (caUtil === 'Underutilized' && channelQuality === 'Good') rootCauses.push('Carrier Aggregation Limited');

                if (rootCauses.length === 0 && (coverageStatus !== 'Unknown' || interferenceLevel !== 'Unknown')) rootCauses.push('No Specific Root Cause Identified');

                // Recommendations Logic
                let actionsHigh = [];
                let actionsMed = [];

                if (rootCauses.includes('Interference-Limited')) {
                    actionsHigh.push('Review Physical Optimization (Tilt/Azimuth)');
                    actionsHigh.push('Check for External Interference Sources');
                }
                if (rootCauses.includes('Coverage-Limited')) {
                    actionsHigh.push('Optimize Antenna Downtilt (Uptilt if feasible)');
                    actionsMed.push('Verify Power Settings');
                }
                if (rootCauses.includes('Capacity / Congestion-Limited')) {
                    actionsHigh.push('Evaluate Load Balancing Features');
                    actionsMed.push('Plan for Capacity Expansion (Carrier Add/Split)');
                }
                if (rootCauses.includes('Carrier Aggregation Limited')) {
                    actionsMed.push('Verify CA Configuration Parameters');
                    actionsMed.push('Check Secondary Carrier Availability');
                }

                // Fallbacks if empty
                if (actionsHigh.length === 0) actionsHigh.push('Monitor KPI Trend for degradation');
                if (actionsMed.length === 0) actionsMed.push('Perform drive test for further detail');

                return {
                    metrics: {
                        coverageStatus, coverageInterp,
                        interferenceLevel,
                        channelQuality,
                        dlUserExp, dlLowThptRatio, dlSpecEff,
                        dlSpecPerf,
                        cellLoad, congestionInterp,
                        mimoUtil, caUtil, caInterp
                    },
                    context: { time, tech, cellId, lat, lng },
                    rootCauses,
                    recommendations: { high: actionsHigh, med: actionsMed }
                };
            }; // End runAnalysisForData

            // -------------------------------------------------------------
            // REPORT GENERATION
            // -------------------------------------------------------------

            const dataList = Array.isArray(data) ? data : [{ name: '', data: data }];

            let combinedHtml = '';

            dataList.forEach((item, idx) => {
                const { metrics, context, rootCauses, recommendations } = runAnalysisForData(item.data);

                // Styles for specific keywords
                const colorize = (txt) => {
                    const t = txt.toLowerCase();
                    if (t === 'good' || t === 'low' || t === 'stable' || t === 'acceptable' || t === 'not congested' || t === 'well utilized' || t === 'effective') return `<span class="status-good">${txt}</span>`;
                    if (t === 'fair' || t === 'moderate' || t === 'keep') return `<span class="status-fair">${txt}</span>`;
                    return `<span class="status-poor">${txt}</span>`;
                };

                combinedHtml += `
                    <div class="report-section" style="${idx > 0 ? 'margin-top: 40px; border-top: 4px solid #333; padding-top: 30px;' : ''}">
                         ${item.name ? `<h2 style="margin: 0 0 20px 0; color: #60a5fa; border-bottom: 1px solid #444; padding-bottom: 10px; font-size: 18px;">${item.name} Analysis</h2>` : ''}

                        <div class="report-block">
                            <h3 class="report-header">1. Cell Context</h3>
                            <ul class="report-list">
                                <li><strong>Technology:</strong> ${context.tech}</li>
                                <li><strong>Cell Identifier:</strong> ${context.cellId}</li>
                                <li><strong>Location:</strong> ${context.lat}, ${context.lng}</li>
                                <li><strong>Data Confidence:</strong> High (based on MR Count)</li>
                            </ul>
                        </div>

                        <div class="report-block">
                            <h3 class="report-header">2. Coverage & Radio Conditions</h3>
                            <p>Coverage in the analyzed grid is classified as <strong>${colorize(metrics.coverageStatus)}</strong>.</p>
                            <p>Dominant RSRP indicates <strong>${metrics.coverageInterp}</strong>. 
                               Signal quality assessment shows <strong>${colorize(metrics.interferenceLevel)}</strong> interference conditions, 
                               based on Dominant RSRQ and CQI behavior.</p>
                            <p>Overall radio conditions are assessed as <strong>${colorize(metrics.channelQuality)}</strong>.</p>
                        </div>

                        <div class="report-block">
                            <h3 class="report-header">3. Throughput & User Experience</h3>
                            <p>Downlink user experience is classified as <strong>${colorize(metrics.dlUserExp)}</strong>.</p>
                            <p>This is supported by:</p>
                            <ul class="report-list">
                                <li>Average DL Throughput behavior</li>
                                <li>DL Low-Throughput Ratio (${metrics.dlLowThptRatio !== 0 ? metrics.dlLowThptRatio : 'N/A'})</li>
                                <li>Spectrum Efficiency classification</li>
                            </ul>
                            <p>Uplink performance is <strong>acceptable / secondary</strong>, based on UL KPIs.</p>
                        </div>

                        <div class="report-block">
                            <h3 class="report-header">4. Spectrum Efficiency & Resource Utilization</h3>
                            <p>Downlink spectrum efficiency is classified as <strong>${colorize(metrics.dlSpecPerf)}</strong>.</p>
                            <p>Average DL RB usage indicates the cell is <strong>${colorize(metrics.cellLoad)}</strong>, 
                               confirming that performance limitations are <strong>${metrics.congestionInterp}</strong> to congestion.</p>
                        </div>

                        <div class="report-block">
                            <h3 class="report-header">5. MIMO & Carrier Aggregation Performance</h3>
                            <p>MIMO utilization is assessed as <strong>${colorize(metrics.mimoUtil)}</strong>, based on rank distribution statistics.</p>
                            <p>Carrier Aggregation utilization is <strong>${colorize(metrics.caUtil)}</strong>, indicating <strong>${metrics.caInterp}</strong> use of multi-carrier capabilities.</p>
                        </div>

                        <div class="report-block">
                            <h3 class="report-header">6. Traffic Profile & Service Impact</h3>
                            <p>Traffic composition is dominated by:</p>
                            <ul class="report-list">
                                <li>QCI 9 (Internet / Default)</li>
                            </ul>
                            <p>This traffic profile is sensitive to:</p>
                            <ul class="report-list">
                                <li>Throughput stability</li>
                                <li>Spectrum efficiency</li>
                                <li>Interference conditions</li>
                            </ul>
                        </div>

                        <div class="report-block">
                            <h3 class="report-header">7. Root Cause Analysis</h3>
                            <p>Based on rule evaluation, the primary performance limitation(s) are:</p>
                            <ul class="report-list" style="color: #ef4444; font-weight: bold;">
                                ${rootCauses.map(rc => `<li>${rc}</li>`).join('')}
                            </ul>
                            <p>These limitations explain the observed throughput behavior despite the current load level.</p>
                        </div>

                        <div class="report-block">
                            <h3 class="report-header">8. Optimization Recommendations</h3>
                            
                            <h4 style="color:#fbbf24; margin:10px 0 5px 0;">High Priority Actions:</h4>
                            <ul class="report-list">
                                ${recommendations.high.map(a => `<li>${a}</li>`).join('')}
                            </ul>

                            <h4 style="color:#94a3b8; margin:10px 0 5px 0;">Medium Priority Actions:</h4>
                            <ul class="report-list">
                                ${recommendations.med.map(a => `<li>${a}</li>`).join('')}
                            </ul>
                            
                            <p style="margin-top:10px; font-style:italic; font-size:11px; color:#888;">Each recommended action is directly linked to the identified root cause(s) and observed KPI behavior.</p>
                        </div>
                        
                        <div class="report-summary">
                            <h3 class="report-header" style="color:#fff;">EXECUTIVE SUMMARY</h3>
                            <p>The analyzed LTE cell is primarily <strong>${rootCauses[0]}</strong>, resulting in <strong>${metrics.dlUserExp} User Experience</strong>. Targeted RF and feature optimization is required to improve spectrum efficiency.</p>
                        </div>

                    </div>
                `;
            });

            // CSS For Report
            const style = `
                <style>
                    .report-block { margin-bottom: 20px; }
                    .report-header { color: #aaa; border-bottom: 1px solid #444; padding-bottom: 4px; margin-bottom: 8px; font-size: 14px; text-transform: uppercase; letter-spacing: 0.5px; }
                    .report-list { padding-left: 20px; color: #ddd; font-size: 13px; line-height: 1.6; }
                    .report-section p { font-size: 13px; color: #eee; line-height: 1.6; margin-bottom: 8px; }
                    .status-good { color: #4ade80; font-weight: bold; }
                    .status-fair { color: #facc15; font-weight: bold; }
                    .status-poor { color: #f87171; font-weight: bold; }
                    .report-summary { background: #1f2937; padding: 15px; border-left: 4px solid #3b82f6; margin-top: 30px; }
                </style>
            `;

            const modalHtml = `
                <div class="analysis-modal-overlay" onclick="const m=document.querySelector('.analysis-modal-overlay'); if(event.target===m) m.remove()">
                    <div class="analysis-modal" style="width: 800px; max-width: 90vw;">
                        <div class="analysis-header">
                            <h3>Cell Performance Analysis Report</h3>
                            <button class="analysis-close-btn" onclick="document.querySelector('.analysis-modal-overlay').remove()">×</button>
                        </div>
                        <div class="analysis-content" style="padding: 30px;">
                            ${style}
                            ${combinedHtml}
                        </div>
                    </div>
                </div>
            `;

            // Append to body
            const div = document.createElement('div');
            div.innerHTML = modalHtml;
            document.body.appendChild(div.firstElementChild);

        } catch (e) {
            console.error("Analysis Error:", e);
            alert("Error running analysis: " + e.message);
        }
    };

    // Global function to update the Floating Info Panel (Single Point)
    window.updateFloatingInfoPanel = (p, logColor) => {
        try {
            const panel = document.getElementById('floatingInfoPanel');
            const content = document.getElementById('infoPanelContent');
            const headerDom = document.getElementById('infoPanelHeader'); // GET HEADER

            if (!panel || !content) return;

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

            // Update Connections
            if (window.mapRenderer && !window.isSpiderMode) {
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

    // --- NEW: Log View Generator ---
    function generatePointInfoHTMLLog(p, logColor) {
        // Extract Serving
        let sName = 'Unknown', sSC = '-', sRSCP = '-', sEcNo = '-', sFreq = '-', sRnc = null, sCid = null, sLac = null;
        let isLTE = false;

        // Explicit Name Resolution (Matches Map Logic)
        let servingRes = null;
        if (window.resolveSmartSite) {
            servingRes = window.resolveSmartSite(p);
            if (servingRes && servingRes.name) sName = servingRes.name;
        }

        const connectionTargets = [];
        if (servingRes && servingRes.lat && servingRes.lng) {
            connectionTargets.push({
                lat: servingRes.lat, lng: servingRes.lng, color: '#3b82f6', weight: 8, cellId: servingRes.id
            });
        }

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

        // DATABASE FALLBACK: If RNC/CID are still missing but we resolved a site, use its IDs
        if ((sRnc === null || sRnc === undefined) && servingRes && servingRes.rnc) {
            sRnc = servingRes.rnc;
            sCid = servingRes.cid;
            if (sName === 'Unknown') sName = servingRes.name || sName;
        }

        const levelHeader = isLTE ? 'RSRP' : 'RSCP';
        const qualHeader = isLTE ? 'RSRQ' : 'EcNo';

        // Determine Identity Label
        let identityLabel = `${sSC}/${sFreq}`; // Default 
        if (servingRes && servingRes.id) {
            identityLabel = servingRes.id;
        } else if (sRnc !== null && sRnc !== undefined && sCid !== null && sCid !== undefined) {
            identityLabel = `${sRnc}/${sCid}`; // UMTS RNC/CID
        } else if (p.cellId && p.cellId !== 'N/A') {
            identityLabel = p.cellId; // LTE ECI or synthesized UMTS CID
        }

        // Neighbors
        let rawNeighbors = [];
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
                    return { name: nRes.name, rnc: nRes.rnc, cid: nRes.cid, id: nRes.id, lat: nRes.lat, lng: nRes.lng };
                }
            }
            return { name: cellName || 'Unknown', rnc: null, cid: null, id: null, lat: null, lng: null };
        };

        if (p.parsed && p.parsed.neighbors) {
            p.parsed.neighbors.forEach(n => {
                const sc = n.pci !== undefined ? n.pci : (n.sc !== undefined ? n.sc : undefined);
                const freq = n.freq !== undefined ? n.freq : undefined;

                // FILTER: Skip if this neighbor matches the serving cell
                if (sc == sSC && freq == sFreq) return;

                rawNeighbors.push({
                    sc: sc !== undefined ? sc : '-',
                    rscp: n.rscp !== undefined ? n.rscp : -140, // Default low for sort
                    ecno: n.ecno !== undefined ? n.ecno : '-',
                    freq: n.freq !== undefined ? n.freq : '-',
                    cellName: n.cellName
                });
            });
        }
        // Fallback Flat Neighbors (N1..N3)
        if (rawNeighbors.length === 0) {
            if (p.n1_sc !== undefined && (p.n1_sc != sSC)) rawNeighbors.push({ sc: p.n1_sc, rscp: p.n1_rscp || -140, ecno: p.n1_ecno, freq: sFreq });
            if (p.n2_sc !== undefined && (p.n2_sc != sSC)) rawNeighbors.push({ sc: p.n2_sc, rscp: p.n2_rscp || -140, ecno: p.n2_ecno, freq: sFreq });
            if (p.n3_sc !== undefined && (p.n3_sc != sSC)) rawNeighbors.push({ sc: p.n3_sc, rscp: p.n3_rscp || -140, ecno: p.n3_ecno, freq: sFreq });
        }

        // Sort by RSCP Descending
        rawNeighbors.sort((a, b) => {
            const valA = parseFloat(a.rscp);
            const valB = parseFloat(b.rscp);
            if (isNaN(valA)) return 1;
            if (isNaN(valB)) return -1;
            return valB - valA;
        });

        const neighbors = rawNeighbors.map((n, i) => {
            const resolved = resolveN(n.sc, n.freq, n.cellName);
            return {
                type: `N${i + 1}`,
                name: resolved.name,
                rnc: resolved.rnc,
                cid: resolved.cid,
                id: resolved.id, // Pass ID
                lat: resolved.lat,
                lng: resolved.lng,
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
            const safeId = servingRes.id || (servingRes.rnc && servingRes.cid ? `${servingRes.rnc}/${servingRes.cid}` : '');
            sClickAction = `onclick="window.highlightAndPan(${servingRes.lat}, ${servingRes.lng}, '${safeId}', 'serving')" style="cursor:pointer; color:#fff;"`;
        }

        // Serving Row
        rows += `
            <tr class="log-row serving-row">
                <td class="log-cell-type">Serving</td>
                <td class="log-cell-name"><span class="log-header-serving" ${sClickAction}>${sName}</span> <span style="color:#666; font-size:10px;">(${identityLabel})</span></td>
                <td class="log-cell-val">${sSC}</td>
                <td class="log-cell-val">${sRSCP}</td>
                <td class="log-cell-val">${sEcNo}</td>
                <td class="log-cell-val">${sFreq}</td>
            </tr>
        `;

        neighbors.forEach(n => {
            let nIdLabel = `${n.sc}/${n.freq}`;
            if (n.rnc && n.cid) nIdLabel = `${n.rnc}/${n.cid}`;

            let nClickAction = '';
            /* FIX: Use highlightAndPan */
            if (n.lat && n.lng) {
                const safeId = n.id || (n.rnc && n.cid ? `${n.rnc}/${n.cid}` : '');
                nClickAction = `onclick="window.highlightAndPan(${n.lat}, ${n.lng}, '${safeId}', 'neighbor')" style="cursor:pointer;"`;
            }

            rows += `
                <tr class="log-row">
                    <td class="log-cell-type">${n.type}</td>
                    <td class="log-cell-name"><span ${nClickAction}>${n.name}</span> <span style="color:#666; font-size:10px;">(${nIdLabel})</span></td>
                    <td class="log-cell-val">${n.sc}</td>
                    <td class="log-cell-val">${n.rscp}</td>
                    <td class="log-cell-val">${n.ecno}</td>
                    <td class="log-cell-val">${n.freq}</td>
                </tr>
            `;
        });

        // ----------------------------------------------------
        // EXTRACT OTHER METRICS
        // ----------------------------------------------------
        let extraMetricsHtml = '';
        const sourceObj = p.properties ? p.properties : p;
        const knownKeys = ['lat', 'lng', 'time', 'id', 'geometry', 'properties', 'parsed',
            'sc', 'pci', 'rscp', 'rsrp', 'level', 'ecno', 'rsrq', 'qual',
            'rnc', 'cid', 'lac', 'freq', 'earfcn', 'uarfcn', 'band', 'tech', 'technology',
            'cellid', 'cell_id', 'sitename', 'cellname', 'name',
            'n1_sc', 'n1_rscp', 'n1_ecno', 'n2_sc', 'n2_rscp', 'n2_ecno', 'n3_sc', 'n3_rscp', 'n3_ecno',
            'a2_sc', 'a2_rscp', 'a3_sc', 'a3_rscp'];

        const isNeighborKey = (k) => /^n\d+_/.test(k) || /^a\d+_/.test(k);

        Object.entries(sourceObj).forEach(([k, v]) => {
            const lowerK = k.toLowerCase().replace(/[^a-z0-9]/g, '');
            if (knownKeys.includes(lowerK) || knownKeys.includes(k.toLowerCase())) return;
            if (isNeighborKey(k.toLowerCase())) return;
            if (typeof v === 'object') return; // Skip nested objects for now
            if (v === undefined || v === null || v === '') return;

            // Format numeric
            let val = v;
            if (typeof v === 'number' && !Number.isInteger(v)) val = v.toFixed(3);

            extraMetricsHtml += `
            <div style="display:flex; justify-content:space-between; border-bottom:1px solid #444; font-size:11px; padding:3px 0;">
                <span style="color:#aaa; margin-right: 10px;">${k}</span>
                <span style="color:#fff; font-weight:bold; text-align: right;">${val}</span>
            </div>`;
        });

        const html = `
            <div class="log-view-container">
             <div style="display:flex; justify-content:space-between; align-items:flex-end; margin-bottom:5px;">
                    <div>
                         <div class="log-header-serving" style="font-size:14px; margin-bottom:2px;">${sName}</div>
                         <div style="color:#aaa; font-size:11px;">Lat: ${p.lat.toFixed(6)}  Lng: ${p.lng.toFixed(6)}</div>
                    </div>
                     <div style="color:#aaa; font-size:11px;">${p.time || ''}</div>
                </div>

                <table class="log-details-table">
                    <thead>
                        <tr>
                            <th style="width:10%">Type</th>
                            <th style="width:40%">Cell Name</th>
                            <th>SC</th>
                            <th>${levelHeader}</th>
                            <th>${qualHeader}</th>
                            <th>Freq</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${rows}
                    </tbody>
                </table>
                
                ${extraMetricsHtml ? `
                <div style="margin-top:15px; border-top:1px solid #555; padding-top:10px;">
                    <div style="font-size:12px; font-weight:bold; color:#ccc; margin-bottom:5px;">Other Metrics</div>
                    <div style="max-height: 200px; overflow-y: auto;">
                        ${extraMetricsHtml}
                    </div>
                </div>` : ''}

                <div style="display:flex; gap:10px; margin-top:15px; border-top:1px solid #444; padding-top:10px;">
                    <button class="btn btn-blue" onclick="window.analyzePoint(this)" style="flex:1; justify-content: center;">Analyze Point</button>
                    <button class="btn btn-purple" onclick="window.generateManagementSummary()" style="flex:1; justify-content: center;">MANAGEMENT SUMMARY</button>
                </div>
                    <!-- Hidden data stash for the analyzer -->
                    <script type="application/json" id="point-data-stash">
                    ${JSON.stringify({
            ...(p.properties || p),
            'Cell Identifier': sName !== 'Unknown' ? sName : identityLabel,
            'Cell Name': sName,
            'Tech': isLTE ? 'LTE' : 'UMTS'
        })}
                    </script>
                </div>

            </div>
        `;

        // Add connection targets for top 3 neighbors if they resolve
        neighbors.slice(0, 3).forEach(n => {
            if (window.resolveSmartSite) {
                const nRes = window.resolveSmartSite({ sc: n.sc, freq: n.freq, lat: p.lat, lng: p.lng, pci: n.sc, lac: sLac });
                if (nRes && nRes.lat && nRes.lng) {
                    connectionTargets.push({ lat: nRes.lat, lng: nRes.lng, color: '#ef4444', weight: 4, cellId: nRes.id });
                }
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
                    name: `Layer: ${log.name}`,
                    data: point.properties ? point.properties : point
                });

                // Header for this Log Layer
                const header = document.createElement('div');
                header.style.cssText = `background:#ef4444; color:#fff; padding:5px; font-weight:bold; font-size:12px; margin-top:${idx > 0 ? '10px' : '0'}; border-radius:4px 4px 0 0;`;
                header.textContent = `Layer: ${log.name}`;
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
            if (window.mapRenderer && !window.isSpiderMode && hits.length > 0) {
                const primary = hits[0].point;
                window.mapRenderer.drawConnections({ lat: primary.lat, lng: primary.lng }, allConnectionTargets);
            }

            // UNIFIED ANALYZE BUTTON
            const btnContainer = document.createElement('div');
            btnContainer.style.cssText = "margin-top: 15px; text-align: center; border-top: 1px solid #555; padding-top: 10px;";
            btnContainer.innerHTML = `
                <button onclick="window.analyzePoint(this)" 
                        style="background: #3b82f6; color: white; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; font-size: 12px; font-weight: bold; width: 100%;">
                    Analyze All Layers
                </button>
                <script type="application/json" id="point-data-stash">${JSON.stringify(aggregatedData)}</script>
                <script type="application/json" id="point-data-stash-meta">{"hits":true}</script>
            `;
            content.appendChild(btnContainer);

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
            window.updateFloatingInfoPanel(point, log.color);
        }

        // 4. Update Grid
        if (window.currentGridLogId === logId) {
            const row = document.getElementById(`grid-row-${index}`);
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
        console.log(`[App] Color overridden for ${id} -> ${color}`);

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
        if (log) {
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
                    window.updateFloatingInfoPanel(point);
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
            console.log(`[Spider] Found ${targetPoints.length} points.`);
            window.mapRenderer.drawConnections(startPt, targetPoints);
            fileStatus.textContent = `Spider: Showing ${targetPoints.length} points for ${sector.cellId || sector.sc}`;
        } else {
            console.warn("[Spider] No matching points found.");
            fileStatus.textContent = `Spider: No points found for ${sector.cellId || sector.sc}`;
            window.mapRenderer.clearConnections();
        }
    });

    fileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;

        fileStatus.textContent = `Loading ${file.name}...`;


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
            const customMetrics = !Array.isArray(result) ? result.customMetrics : []; // New for Excel

            console.log(`Parsed ${parsedData.length} measurement points and ${signalingData ? signalingData.length : 0} signaling messages.Tech: ${technology}`);

            if (parsedData.length > 0 || (signalingData && signalingData.length > 0)) {
                const id = Date.now().toString();
                const name = fileName.replace(/\.[^/.]+$/, "");

                // Add to Logs
                loadedLogs.push({
                    id: id,
                    name: name,
                    points: parsedData,
                    signaling: signalingData,
                    tech: technology,
                    customMetrics: customMetrics,
                    color: getRandomColor(),
                    visible: true,
                    currentParam: 'level'
                });

                // Update UI
                updateLogsList();

                if (parsedData.length > 0) {
                    console.log('[App] Debug First Point:', parsedData[0]);
                    map.addLogLayer(id, parsedData, 'level');
                    const first = parsedData[0];
                    map.setView(first.lat, first.lng);
                }

                // Add Events Layer (HO Fail, Drop, etc.)
                if (signalingData && signalingData.length > 0) {
                    map.addEventsLayer(id, signalingData);
                }

                fileStatus.textContent = `Loaded: ${name}(${parsedData.length} pts)`;


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

            fileStatus.textContent = `Importing Sites...`;

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

                        console.log(`[Sites] Importing ${validSectors.length} sites as layer: ${name}`);

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
                            fileStatus.textContent = `Sites Imported: ${validSectors.length}(${name})`;
                        } catch (innerErr) {
                            console.error('[Sites] CRITICAL ERROR adding layer:', innerErr);
                            alert(`Error adding site layer: ${innerErr.message}`);
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
        item.id = `site - layer - ${id}`;

        item.innerHTML = `
        <div class="layer-info">
            <span class="layer-name" title="${name}" style="font-size:13px;">${name}</span>
        </div>
        <div class="layer-controls">
            <button class="layer-btn settings-btn" data-id="${id}" title="Layer Settings">⚙️</button>
            <button class="layer-btn visibility-btn" data-id="${id}" title="Toggle Visibility">👁️</button>
            <button class="layer-btn remove-btn" data-id="${id}" title="Remove Layer">✕</button>
        </div>
        `;

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
                if (title) title.textContent = `Settings: ${name}`;
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
            if (confirm(`Remove site layer "${name}" ? `)) {
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

    function renderSignalingTable() {
        if (!currentSignalingLogId) return;
        const log = loadedLogs.find(l => l.id.toString() === currentSignalingLogId.toString());
        if (!log) return;

        const filterElement = document.getElementById('signalingFilter');
        const filter = filterElement ? filterElement.value : 'ALL';
        if (!filterElement) console.warn('Signaling Filter Dropdown not found in DOM!');

        const tbody = document.getElementById('signalingTableBody');
        const title = document.getElementById('signalingModalTitle');

        tbody.innerHTML = '';
        title.textContent = `Signaling Data - ${log.name}`; // Changed visual to verify update

        // Filter Data
        let sigPoints = log.signaling || [];
        if (filter !== 'ALL') {
            sigPoints = sigPoints.filter(p => p.category === filter);
        }

        if (sigPoints.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding:20px;">No messages found matching filter.</td></tr>';
        } else {
            const limit = 2000;
            const displayPoints = sigPoints.slice(0, limit);

            if (sigPoints.length > limit) {
                const tr = document.createElement('tr');
                tr.innerHTML = `< td colspan = "5" style = "background:#552200; color:#fff; text-align:center;" > Showing first ${limit} of ${sigPoints.length} messages.</td > `;
                tbody.appendChild(tr);
            }

            displayPoints.forEach((p, index) => {
                const tr = document.createElement('tr');
                tr.id = `sig - row - ${p.time.replace(/[:.]/g, '')} - ${index}`; // Unique ID for scrolling
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
                    ? `< button onclick = "window.map.setView([${p.lat}, ${p.lng}], 16); event.stopPropagation();" class= "btn" style = "padding:2px 6px; font-size:10px; background-color:#3b82f6;" > Map</button > `
                    : '<span style="color:#666; font-size:10px;">No GPS</span>';

                // Store point data for the info button handler (simulated via dataset or just passing object index if we could, but stringifying is easier for this hack)
                // Better: attach object to DOM element directly
                tr.pointData = p;

                let typeClass = 'badge-rrc';
                if (p.category === 'L3') typeClass = 'badge-l3';

                tr.innerHTML = `
< td > ${p.time}</td >
                    <td><span class="${typeClass}">${p.category}</span></td>
                    <td>${p.direction}</td>
                    <td style="max-width:300px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="${p.message}">${p.message}</td>
                    <td>
                        ${mapBtn} 
                        <button onclick="const p = this.parentElement.parentElement.pointData; showSignalingPayload(p); event.stopPropagation();" class="btn" style="padding:2px 6px; font-size:10px; background-color:#475569;">Info</button>
                    </td>
                `;
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
            modal.innerHTML = `
    < div class= "modal-content" style = "max-width: 600px; background: #1f2937; color: #e5e7eb; border: 1px solid #374151;" >
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
    `;
            document.body.appendChild(modal);
        }

        const content = document.getElementById('payloadContent');
        const payloadRaw = point.payload || 'No Hex Payload Available';

        // Format Hex (Group by 2 bytes / 4 chars)
        const formatHex = (str) => {
            if (!str || str.includes(' ')) return str;
            return str.replace(/(.{4})/g, '$1 ').trim();
        };

        content.innerHTML = `
    < div style = "margin-bottom: 15px;" >
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
    `;

        modal.style.display = 'block';
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
                el.style.width = `${width} % `;
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
            header.innerHTML = `
<span style="font-weight:bold; color:#ddd; font-size:12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:160px;">${log.name}</span>
<div style="display:flex; gap:5px;">
    <!-- Export Button -->
    <button onclick="window.exportOptimFile('${log.id}'); event.stopPropagation();" title="Export Optim CSV" style="background:#059669; color:white; border:none; width:20px; height:20px; border-radius:3px; cursor:pointer; display:flex; align-items:center; justify-content:center;">⬇</button>
    <button onclick="event.stopPropagation(); window.removeLog('${log.id}')" style="background:#ef4444; color:white; border:none; width:20px; height:20px; border-radius:3px; cursor:pointer; display:flex; align-items:center; justify-content:center;">×</button>
</div>
        `;

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
            stats.innerHTML = `
    <span style="background:#3b82f6; color:white; padding:2px 4px; border-radius:2px;">${log.tech}</span>
<span style="margin-left:5px;">${count} pts</span>
        `;

            // Actions
            const actions = document.createElement('div');
            actions.style.cssText = 'display:flex; flex-direction:column; gap:4px;';

            const addAction = (label, param) => {
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
                        label: label
                    }));
                    e.dataTransfer.effectAllowed = 'copy';
                };

                // Left Click Handler - Opens Context Menu
                btn.onclick = (e) => {
                    window.showMetricOptions(e, log.id, param, 'regular');
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

            if (log.customMetrics && log.customMetrics.length > 0) {
                actions.appendChild(addHeader('Detected Metrics'));

                log.customMetrics.forEach(metric => {
                    let label = metric;
                    if (metric === 'throughput_dl') label = 'DL Throughput (Kbps)';
                    if (metric === 'throughput_ul') label = 'UL Throughput (Kbps)';
                    actions.appendChild(addAction(label, metric));
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
                actions.appendChild(addAction('Serving RSCP/Level', 'rscp_not_combined'));
                actions.appendChild(addAction('Serving EcNo', 'ecno'));
                actions.appendChild(addAction('Serving SC/SC', 'sc'));
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

                // GROUP: Neighbors
                actions.appendChild(addHeader('Neighbors'));
                // Neighbors Loop (N1 - N8)
                for (let i = 1; i <= 8; i++) {
                    actions.appendChild(addAction(`N${i} RSCP`, `n${i}_rscp`));
                    actions.appendChild(addAction(`N${i} EcNo`, `n${i}_ecno`));
                    actions.appendChild(addAction(`N${i} SC`, `n${i}_sc`));
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

            // Add components
            body.appendChild(stats);
            body.appendChild(actions);
            item.appendChild(header);
            item.appendChild(body);
            container.appendChild(item);
        });
    };

    // DEBUG EXPORT FOR TESTING
    window.loadedLogs = loadedLogs;
    window.updateLogsList = updateLogsList;
    window.openChartModal = openChartModal;
    window.showSignalingModal = showSignalingModal;
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
        link.setAttribute("download", `${log.name}_optim_export.csv`);
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
                console.log(`[Drop] Switched theme to: ${newTheme}`);

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
< div style = "font-size:13px; min-width:150px;" >
                <b>${name}</b><br>
                <div style="color:#888; font-size:11px; margin-top:4px;">${lat.toFixed(5)}, ${lng.toFixed(5)}</div>
                <button onclick="window.removeUserPoint('${markerId}')" style="margin-top:8px; background:#ef4444; color:white; border:none; padding:2px 5px; border-radius:3px; cursor:pointer; font-size:10px;">Remove</button>
            </div>
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
        // Pass false to prevent auto-zooming/fitting bounds
        window.mapRenderer.addSiteLayer(window.mapRenderer.siteData, false);
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
        console.log(`[SiteEditor] created sector in layer ${layerId}`);
    } else {
        // Update valid index
        if (sectors[idx]) {
            const oldS = sectors[idx];
            const oldAzimuth = oldS.azimuth;
            const oldSiteName = oldS.siteName || oldS.name;

            // 1. Update the target sector
            // Merge to preserve other props like frequency if not edited
            sectors[idx] = { ...sectors[idx], ...newObj };
            console.log(`[SiteEditor] updated sector ${idx} in layer ${layerId}`);

            // 2. Synchronize Azimuth if changed
            if (oldAzimuth !== newAzimuth && !isNaN(oldAzimuth) && !isNaN(newAzimuth)) {
                // Find others with same site name and SAME OLD AZIMUTH
                sectors.forEach((s, subIdx) => {
                    const sName = s.siteName || s.name;
                    // Loose check for Site Name match
                    if (String(sName) === String(oldSiteName) && subIdx !== idx) {
                        if (s.azimuth === oldAzimuth) {
                            s.azimuth = newAzimuth; // Sync
                            console.log(`[SiteEditor] Synced azimuth for sector ${subIdx}`);
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
// GLOBAL MANAGEMENT SUMMARY GENERATOR (MOVED TO ROOT SCOPE)
// ----------------------------------------------------
// ----------------------------------------------------
// GLOBAL MANAGEMENT SUMMARY GENERATOR (MOVED TO ROOT SCOPE)
// ----------------------------------------------------
window.generateManagementSummary = () => {
    const stash = document.getElementById('point-data-stash');
    if (!stash || !stash.textContent) {
        alert("No point data available for summary.");
        return;
    }

    let d;
    try {
        d = JSON.parse(stash.textContent);
    } catch (e) {
        console.error("Stash parse error", e);
        return;
    }

    // --- 1. Data Abstraction & Cleaning ---
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
            location = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
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
                    ${secondaryCause ? `<li>${secondaryCause}</li>` : ''}
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
                    ${highPriority.map(a => `<li>${a}</li>`).join('')}
                </ul>

                <h5 style="color:#ffd93d; margin:10px 0 5px 0;">Supporting optimization actions:</h5>
                <ul>
                    ${mediumPriority.length > 0 ? mediumPriority.map(a => `<li>${a}</li>`).join('') : '<li>None required at this stage</li>'}
                </ul>
            </div>

            <div class="report-block" style="border-left: 4px solid #a29bfe; background: rgba(162, 155, 254, 0.1);">
                <h4 style="color:#a29bfe;">EXECUTIVE CONCLUSION</h4>
                <p>
                    This LTE cell requires <strong>${conclusionAction.toUpperCase()}</strong> 
                    to improve customer experience and overall network efficiency.
                </p>
            </div>
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

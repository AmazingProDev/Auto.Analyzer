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

    // Fallback map click -> nearest DT point (in case markers are not clickable)
    window.map.on('click', (e) => {
        try {
            if (!window.metricLegendEntries) return;
            const order = window.dtLayerOrder || [];
            const entries = [];
            order.forEach(key => {
                const entry = window.metricLegendEntries[key];
                if (entry && entry.visible !== false) entries.push(entry);
            });
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
                    if (!window.metricLegendEntries || !window.map) return;

                    const rect = mapEl.getBoundingClientRect();
                    const x = ev.clientX - rect.left;
                    const y = ev.clientY - rect.top;
                    if (x < 0 || y < 0 || x > rect.width || y > rect.height) return;

                    const order = window.dtLayerOrder || [];
                    const entries = [];
                    order.forEach(key => {
                        const entry = window.metricLegendEntries[key];
                        if (entry && entry.visible !== false) entries.push(entry);
                    });
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
        if (!metric) return 'level';
        const m = metric.toLowerCase();
        if (m.includes('qual') || m.includes('sinr') || m.includes('ecno')) return 'quality';
        if (m.includes('throughput')) return 'throughput';
        if (m.includes('bler')) return 'bler';
        if (m.includes('rscp') || m.includes('rsrp') || m.includes('level') || m === 'rssi' || m.includes('tx power')) return 'level';
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
            ],
            'bler': [
                { min: undefined, max: 2, color: '#22c55e', label: 'Good (< 2%)' },
                { min: 2, max: 10, color: '#eab308', label: 'Fair (2-10%)' },
                { min: 10, max: undefined, color: '#ef4444', label: 'Bad (> 10%)' }
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

        // Map Click Handler (add overlay metric layer, keep existing)
        menu.querySelector('#menu-map-' + (layerId)).onclick = () => {
            if (window.addMetricLegendLayer) {
                window.addMetricLegendLayer(log, metric);
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

    window.filter3gDropCalls = (log) => {
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

    window.filter3gCallFailure = (log) => {
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
                            layerId: layerId,
                            visible: true
                        };
                        if (window.moveDTLayerToTop) window.moveDTLayerToTop(eventKey);
                        if (window.applyDTLayerOrder) window.applyDTLayerOrder();
                        if (window.updateLegend) window.updateLegend();
                        if (window.updateDTLayersSidebar) window.updateDTLayersSidebar();
                    }
                    if (data.param === '3g_dropcall' && log.events) {
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
                            layerId: layerId,
                            visible: true
                        };
                        if (window.moveDTLayerToTop) window.moveDTLayerToTop(eventKey);
                        if (window.applyDTLayerOrder) window.applyDTLayerOrder();
                        if (window.updateLegend) window.updateLegend();
                        if (window.updateDTLayersSidebar) window.updateDTLayersSidebar();
                    }
                    if (data.param === '3g_call_failure' && log.events) {
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
            title: metric,
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
            let topPos = 80;
            let rightPos = 20;
            const mapEl = document.getElementById('map');
            if (mapEl) {
                const rect = mapEl.getBoundingClientRect();
                topPos = rect.top + 10;
                rightPos = (window.innerWidth - rect.right) + 10;
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

                if (metric === 'cellId' || metric === 'cid' || metric === 'freq' || metric === 'Freq' || metric === 'earfcn' || metric === 'EARFCN' || metric === 'uarfcn' || metric === 'UARFCN' || metric === 'channel' || metric === 'Channel') {
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
                            html += '<div class="legend-row">\n' +
                                '                                <input type="color" value="' + (color) + '" class="legend-color-input" onchange="window.handleLegendDiscreteColorChange(\'' + (metric) + '\', \'' + (id) + '\', this.value, \'' + (log.id) + '\')">\n' +
                                '                                <span class="legend-label">' + (name) + '</span>\n' +
                                '                                <span class="legend-count">' + (count) + '</span>\n' +
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

                if (metric === 'cellId' || metric === 'cid' || metric === 'freq' || metric === 'Freq' || metric === 'earfcn' || metric === 'EARFCN' || metric === 'uarfcn' || metric === 'UARFCN' || metric === 'channel' || metric === 'Channel') {
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
                            html += '<div class="legend-row">\n' +
                                '                                <input type="color" value="' + (color) + '" class="legend-color-input" onchange="window.handleLegendDiscreteColorChange(\'' + (metric) + '\', \'' + (id) + '\', this.value, \'' + (entry.layerId) + '\')">\n' +
                                '                                <span class="legend-label">' + (name) + '</span>\n' +
                                '                                <span class="legend-count">' + (count) + '</span>\n' +
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
            </div>
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
            dlLow: getVal('dl low-throughput ratio'),
            dlSpecEff: getVal('dl spectrum efficiency'),
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
            </div>
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


    window.deepAnalyzePoint = (btn) => {
        try {
            let script = document.getElementById('point-data-stash');
            if (!script && btn) {
                const container = btn.parentNode.parentNode;
                if (container) script = container.querySelector('#point-data-stash');
            }
            if (!script) {
                alert("Error: Analysis data missing.");
                return;
            }
            const d = JSON.parse(script.textContent);

            const getVal = (target) => {
                const t = target.toLowerCase().replace(/[\s\-_]/g, '');
                for (let k in d) {
                    const normK = k.toLowerCase().replace(/[\s\-_]/g, '');
                    if (normK === t || normK.includes(t)) {
                        const val = parseFloat(d[k]);
                        return isNaN(val) ? null : val;
                    }
                }
                return null;
            };

            // Metrics Extraction
            const mrCount = getVal('dominantmrcount') ?? getVal('mrcount') ?? 0;
            const rsrp = getVal('rsrp') ?? getVal('level') ?? getVal('dominantrsrp');
            const rsrq = getVal('rsrq') ?? getVal('dominantrsrq');
            const cqi = getVal('averagedlwidebandcqi') ?? getVal('cqi') ?? getVal('dlwidebandcqi');
            const dlThptRatio = getVal('dllowthroughputratio') ?? getVal('lowthptratio') ?? 0;
            const dlRbQty = getVal('averagedlrbquantity') ?? getVal('dlrbquantity') ?? getVal('rbqty');
            const dlSpecEff = getVal('dlspectrumefficiency') ?? getVal('spectrumeff');
            const dlIbler = getVal('dlibler') ?? getVal('ibler') ?? getVal('bler');
            const rank2Pct = getVal('rank2percentage') ?? getVal('rank2');
            const ca3ccPct = getVal('dl3ccpercentage') ?? getVal('ca3cc');
            const ca1ccPct = getVal('dl1ccpercentage') ?? getVal('ca1cc');
            const ulThptRatio = getVal('ullowthroughputratio') ?? 0;

            // SECTION 0: DATA CONFIDENCE
            let dataConfidence = "Low";
            if (mrCount >= 1000) dataConfidence = "High";
            else if (mrCount >= 100) dataConfidence = "Medium";

            let analysisLimitation = null;
            if (mrCount < 20) analysisLimitation = "Indicative Only";

            // SECTION 1: COVERAGE STATUS
            let coverageStatus = "Unknown";
            if (rsrp !== null) {
                if (rsrp >= -90) coverageStatus = "Good";
                else if (rsrp > -100) coverageStatus = "Fair";
                else coverageStatus = "Poor";
            }

            // SECTION 2: SIGNAL QUALITY
            let signalQuality = "Unknown";
            if (rsrq !== null) {
                if (rsrq >= -9) signalQuality = "Good";
                else if (rsrq > -11) signalQuality = "Degraded";
                else signalQuality = "Poor";
            }

            // SECTION 3: CHANNEL QUALITY
            let channelQuality = "Unknown";
            if (cqi !== null) {
                if (cqi < 6) channelQuality = "Poor";
                else if (cqi < 9) channelQuality = "Moderate";
                else channelQuality = "Good";
            }

            // SECTION 4: USER EXPERIENCE
            let dlUserExp = "Unknown";
            if (dlThptRatio !== null) {
                if (dlThptRatio >= 80) dlUserExp = "Severely Degraded";
                else if (dlThptRatio >= 25) dlUserExp = "Degraded";
                else dlUserExp = "Acceptable";
            }

            // SECTION 5: LOAD & CONGESTION
            let cellLoadStatus = "Unknown";
            if (dlRbQty !== null) {
                if (dlRbQty <= 10) cellLoadStatus = "Very Low Load";
                else if (dlRbQty < 70) cellLoadStatus = "Moderate Load";
                else if (dlRbQty >= 80) cellLoadStatus = "Congested";
            }

            // SECTION 6: SPECTRUM EFFICIENCY
            let dlSpectralPerf = "Unknown";
            if (dlSpecEff !== null) {
                if (dlSpecEff < 1000) dlSpectralPerf = "Very Low";
                else if (dlSpecEff < 2000) dlSpectralPerf = "Low";
                else dlSpectralPerf = "Normal";
            }

            // SECTION 7: LINK STABILITY
            let dlLinkStability = "Unknown";
            if (dlIbler !== null) {
                if (dlIbler <= 10) dlLinkStability = "Stable";
                else dlLinkStability = "Unstable";
            }

            // SECTION 8: MIMO UTILIZATION
            let mimoUtil = "Unknown";
            if (rank2Pct !== null) {
                if (rank2Pct >= 30) mimoUtil = "Good";
                else if (rank2Pct >= 15) mimoUtil = "Limited";
                else mimoUtil = "Poor";
            }

            // SECTION 9: CA EFFECTIVENESS
            let caEffectiveness = null;
            if (ca3ccPct === 100 && dlSpectralPerf !== "Normal") caEffectiveness = "Active but Ineffective";

            let caUtilization = null;
            if (ca1ccPct >= 60) caUtilization = "Underutilized";

            // SECTION 10: INTERPRETATION
            let interpretation = null;
            if (coverageStatus !== "Poor" && signalQuality === "Poor" && channelQuality !== "Poor") {
                interpretation = "Signal power is present but radio quality is degraded by interference.";
            } else if (dlUserExp !== "Acceptable" && ulThptRatio === 0) {
                interpretation = "Downlink-only degradation indicates interference or overlap issues.";
            } else if (caEffectiveness === "Active but Ineffective") {
                interpretation = "Carrier Aggregation is enabled but limited by poor SINR.";
            }

            // SECTION 11: EXPERT DIAGNOSIS
            let expertDiagnosis = "Inconclusive";
            if (signalQuality === "Poor" && (dlSpectralPerf === "Low" || dlSpectralPerf === "Very Low") && (cellLoadStatus === "Very Low Load" || cellLoadStatus === "Moderate Load")) {
                expertDiagnosis = "Interference-Limited Cell";
            } else if (coverageStatus === "Poor" && channelQuality !== "Good") {
                expertDiagnosis = "Coverage-Limited Cell";
            } else if (cellLoadStatus === "Congested") {
                expertDiagnosis = "Capacity-Limited Cell";
            }

            // SECTION 12: OPTIMIZATION ACTIONS
            let actions = [];
            if (expertDiagnosis === "Interference-Limited Cell") {
                actions.push("Increase electrical downtilt (1–2°)", "Review overshooting neighbors", "Reduce DL power if overlap confirmed", "Audit PCI and neighbor relations");
            } else if (expertDiagnosis === "Coverage-Limited Cell") {
                actions.push("Optimize antenna orientation", "Check for hardware issues");
            } else if (expertDiagnosis === "Capacity-Limited Cell") {
                actions.push("Evaluate load balancing", "Plan for capacity expansion");
            }

            if (mimoUtil === "Limited" || mimoUtil === "Poor") {
                actions.push("Verify antenna cross-polar isolation", "Check RF paths and connectors");
            }
            if (caEffectiveness === "Active but Ineffective") {
                actions.push("Improve secondary carrier SINR", "Align antenna configuration across bands", "Adjust CA activation thresholds");
            }
            if (actions.length === 0) actions.push("Monitor KPI trends", "No critical actions identified");

            // SECTION 13/14: CONFIDENCE SCORING
            let base = 35;
            if (dataConfidence === "High") base = 70;
            else if (dataConfidence === "Medium") base = 55;

            let bonuses = 0;
            if (interpretation) bonuses += 10;
            if (dlUserExp === "Severely Degraded") bonuses += 10;
            if (dlSpectralPerf === "Very Low") bonuses += 10;
            if (caEffectiveness) bonuses += 10;

            let penalties = 0;
            if (analysisLimitation === "Indicative Only") penalties += 20;

            let score = Math.min(95, Math.max(20, base + bonuses - penalties));
            let confidenceLevel = "Low";
            if (score >= 85) confidenceLevel = "Very High";
            else if (score >= 70) confidenceLevel = "High";
            else if (score >= 50) confidenceLevel = "Medium";

            // OUTPUT GENERATION
            const colorize = (t) => {
                if (!t) return '#94a3b8';
                const low = t.toLowerCase();
                if (low.includes('good') || low.includes('stable') || low.includes('acceptable') || low.includes('normal') || low.includes('very high') || low.includes('high')) return '#4ade80';
                if (low.includes('fair') || low.includes('moderate') || low.includes('medium') || low.includes('limited')) return '#facc15';
                return '#f87171';
            };

            const html = `
                <div class="analysis-modal-overlay" onclick="if(event.target===this) this.remove()">
                    <div class="analysis-modal" style="width: 700px; max-width: 90vw;">
                        <div class="analysis-header" style="background:#059669;">
                            <h3>Deep RF Performance Analysis</h3>
                            <button class="analysis-close-btn" onclick="this.closest('.analysis-modal-overlay').remove()">×</button>
                        </div>
                        <div class="analysis-content" style="padding:25px; background:#111827; color:#e5e7eb; font-family:Inter, sans-serif;">
                            
                            <div style="display:grid; grid-template-columns: 1fr 1fr; gap:20px; margin-bottom:25px;">
                                <div style="background:#1f2937; padding:15px; border-radius:8px; border-left:4px solid #10b981;">
                                    <div style="font-size:11px; color:#9ca3af; text-transform:uppercase;">Data Confidence</div>
                                    <div style="font-size:20px; font-weight:bold; color:${colorize(dataConfidence)}">${dataConfidence}</div>
                                    <div style="font-size:10px; color:#6b7280; margin-top:4px;">Sample Count: ${mrCount}</div>
                                </div>
                                <div style="background:#1f2937; padding:15px; border-radius:8px; border-left:4px solid #3b82f6;">
                                    <div style="font-size:11px; color:#9ca3af; text-transform:uppercase;">Diagnosis Confidence</div>
                                    <div style="font-size:20px; font-weight:bold; color:${colorize(confidenceLevel)}">${score}% (${confidenceLevel})</div>
                                    <div style="font-size:10px; color:#6b7280; margin-top:4px;">Rule-based Scoring</div>
                                </div>
                            </div>

                            <div style="margin-bottom:20px;">
                                <h4 style="color:#60a5fa; border-bottom:1px solid #374151; padding-bottom:5px; margin-bottom:12px; font-size:14px;">1. KPI CLASSIFICATION</h4>
                                <div style="display:grid; grid-template-columns: 1fr 1fr; gap:10px; font-size:13px;">
                                    <div>Coverage: <span style="font-weight:bold; color:${colorize(coverageStatus)}">${coverageStatus}</span></div>
                                    <div>Signal Quality: <span style="font-weight:bold; color:${colorize(signalQuality)}">${signalQuality}</span></div>
                                    <div>Channel (CQI): <span style="font-weight:bold; color:${colorize(channelQuality)}">${channelQuality}</span></div>
                                    <div>UX (Throughput): <span style="font-weight:bold; color:${colorize(dlUserExp)}">${dlUserExp}</span></div>
                                    <div>Cell Load: <span style="font-weight:bold; color:${colorize(cellLoadStatus)}">${cellLoadStatus}</span></div>
                                    <div>Spectrum Eff: <span style="font-weight:bold; color:${colorize(dlSpectralPerf)}">${dlSpectralPerf}</span></div>
                                    <div>Link Stability: <span style="font-weight:bold; color:${colorize(dlLinkStability)}">${dlLinkStability}</span></div>
                                    <div>MIMO Utilization: <span style="font-weight:bold; color:${colorize(mimoUtil)}">${mimoUtil}</span></div>
                                </div>
                                ${caEffectiveness ? `<div style="margin-top:10px; font-size:13px;">CA Effectiveness: <span style="color:#f87171; font-weight:bold;">${caEffectiveness}</span></div>` : ''}
                                ${caUtilization ? `<div style="margin-top:5px; font-size:13px;">CA Utilization: <span style="color:#facc15; font-weight:bold;">${caUtilization}</span></div>` : ''}
                            </div>

                            <div style="margin-bottom:20px;">
                                <h4 style="color:#60a5fa; border-bottom:1px solid #374151; padding-bottom:5px; margin-bottom:10px; font-size:14px;">2. INTERPRETATION & DIAGNOSIS</h4>
                                <div style="background:#1f2937; padding:12px; border-radius:6px; margin-bottom:10px; border-left:3px solid #6366f1;">
                                    <div style="font-size:11px; color:#9ca3af; margin-bottom:4px;">Analysis Context:</div>
                                    <div style="font-size:13px; line-height:1.5;">${interpretation || "Normal operational behavior observed or standard performance limitations."}</div>
                                </div>
                                <div style="background:#450a0a; padding:12px; border-radius:6px; border-left:3px solid #ef4444;">
                                    <div style="font-size:11px; color:#f87171; margin-bottom:4px;">Expert Diagnosis:</div>
                                    <div style="font-size:14px; font-weight:bold; color:#fecaca;">${expertDiagnosis}</div>
                                </div>
                            </div>

                            <div>
                                <h4 style="color:#60a5fa; border-bottom:1px solid #374151; padding-bottom:5px; margin-bottom:10px; font-size:14px;">3. OPTIMIZATION RECOMMENDATIONS</h4>
                                <ul style="margin:0; padding-left:20px; font-size:13px; line-height:1.7; color:#d1d5db;">
                                    ${actions.map(a => `<li>${a}</li>`).join('')}
                                </ul>
                            </div>

                            <div style="margin-top:25px; font-size:10px; color:#4b5563; text-align:center; font-style:italic;">
                                Deep Analysis Engine v2.0 | Rules-based Diagnostic Model
                            </div>
                        </div>
                    </div>
                </div>
            `;

            const div = document.createElement('div');
            div.innerHTML = html;
            document.body.appendChild(div.firstElementChild);

        } catch (e) {
            console.error(e);
            alert("Deep Analysis failed: " + e.message);
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
        let identityLabel = sSC + ' / ' + sFreq; // Default
        if (servingRes && servingRes.id) {
            identityLabel = servingRes.id;
        } else if (sRnc !== null && sRnc !== undefined && sCid !== null && sCid !== undefined) {
            identityLabel = sRnc + '/' + sCid; // UMTS RNC/CID
        } else if (p.cellId && p.cellId !== 'N/A') {
            identityLabel = p.cellId; // LTE ECI or synthesized UMTS CID
        }

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

        // Neighbors
        let rawNeighbors = [];
        let explicitNeighbors = [];

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
                    return { name: nRes.name, rnc: nRes.rnc, cid: nRes.cid, id: nRes.id, lat: nRes.lat, lng: nRes.lng };
                }
            }
            return { name: cellName || 'Unknown', rnc: null, cid: null, id: null, lat: null, lng: null };
        };

        if (explicitNeighbors.length === 0 && p.parsed && p.parsed.neighbors) {
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

        // Sort by RSCP Descending (strongest to weakest)
        const neighborsSource = (explicitNeighbors.length > 0 ? explicitNeighbors : rawNeighbors)
            .slice()
            .sort((a, b) => {
                const valA = parseFloat(a.rscp);
                const valB = parseFloat(b.rscp);
                if (isNaN(valA) && isNaN(valB)) return 0;
                if (isNaN(valA)) return 1;
                if (isNaN(valB)) return -1;
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

            extraMetricsHtml += '<div style="display:flex; justify-content:space-between; border-bottom:1px solid #444; font-size:11px; padding:3px 0;">' +
                '<span style="color:#aaa; margin-right: 10px;">' + k + '</span>' +
                '<span style="color:#fff; font-weight:bold; text-align: right;">' + val + '</span>' +
                '</div>';
        });

        let extraMetricsSection = '';
        if (extraMetricsHtml) {
            extraMetricsSection = '<div style="margin-top:15px; border-top:1px solid #555; padding-top:10px;">' +
                '<div style="font-size:12px; font-weight:bold; color:#ccc; margin-bottom:5px;">Other Metrics</div>' +
                '<div style="max-height: 200px; overflow-y: auto;">' +
                extraMetricsHtml +
                '</div>' +
                '</div>';
        }

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
            '<th>SC</th>' +
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
            if (window.mapRenderer && !window.isSpiderMode && hits.length > 0) {
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
            window.updateFloatingInfoPanel(point, log.color);
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
                    tech: technology,
                    customMetrics: customMetrics,
                    color: getRandomColor(),
                    visible: false,
                    currentParam: defaultMetric,
                    config: configData,
                    configHistory: configHistory
                });

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

            if (log.customMetrics && log.customMetrics.length > 0) {
                const groups = {
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
                    const low = m.toLowerCase();
                    if (/^a\d+_/.test(low)) groups['Active Set'].push(m);
                    else if (/^m\d+_/.test(low)) groups['Monitored Set'].push(m);
                    else if (/^d\d+_/.test(low)) groups['Detected Set'].push(m);
                    else if (m === 'UE Tx Power' || m === 'NodeB Tx Power' || m === 'TPC') groups['POWER CONTROL'].push(m);
                    else if (m === 'RRC State' || m === 'bler_dl' || m === 'bler_ul' || m === 'Throughput' || m === 'RSSI') groups['DT Analysis'].push(m);
                    else if (m === 'Active Set Size' || m === 'AS Event' || m === 'HO Command' || m === 'HO Completion') groups['HANDOVER & ACTIVE SET ANALYSIS'].push(m);
                    else if (m === 'RLF indication' || m === 'UL sync loss (UE can’t reach NodeB)' || m === 'DL sync loss (Interference / coverage)' || m === 'T310' || m === 'T312') groups['RADIO LINK FAILURE (RLF)'].push(m);
                    else if (m === 'rrc_rel_cause' || m === 'cs_rel_cause' || m === 'iucs_status') groups['RRC & CS RELEASE CAUSE'].push(m);
                    else groups['Standard'].push(m);
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

            // GROUP: Events
            if (log.events && log.events.length > 0) {
                actions.appendChild(document.createElement('hr')).style.cssText = "border:0; border-top:1px solid #444; margin:10px 0;";
                actions.appendChild(addHeader('Events'));
                if (log.tech && (String(log.tech).toLowerCase().includes('3g') || String(log.tech).toLowerCase().includes('umts'))) {
                    actions.appendChild(addAction('Drop Call', '3g_dropcall', 'event'));
                }
                actions.appendChild(addAction('Call Failure', '3g_call_failure', 'event'));
                actions.appendChild(addAction('Handover Failure', 'hof_handover_failure', 'event'));
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
            </div>
        `;

    const div = document.createElement('div');
    div.innerHTML = modalHtml;
    document.body.appendChild(div.firstElementChild);
}

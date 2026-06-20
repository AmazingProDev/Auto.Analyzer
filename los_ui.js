/**
 * los_ui.js — Line-of-Sight simulation panel.
 * Uses the main Leaflet map (window.mapRenderer.map) — no embedded mini-map.
 */
(function () {
    'use strict';

    // ── State ────────────────────────────────────────────────────────────────
    let _state      = 'idle';
    let _target     = null;   // { lon, lat }
    let _obsAgl     = 25.0;
    let _tgtAgl     = 1.5;
    let _freqMhz    = 1800;
    let _spacingM   = 2;
    let _lastResult = null;
    let _observers  = [];     // [{ id, label, lon, lat, height_agl_m, color, result, marker, lineLayer, blockerLayer }]
    let _selectedObserverId = null;
    let _observerSeq = 0;
    let _sampleLineStart = null;
    let _sampleLineEnd = null;
    let _sampleLineDragTimer = null;
    let _sampleLineRequestSeq = 0;

    // Leaflet layer references on the main map
    let _tgtMarker      = null;
    let _viewshedLayer  = null;
    let _featuresLayer  = null;
    let _sampleMarkersLayer = null;
    let _sampleLineLayer = null;
    let _sampleLineStartMarker = null;
    let _sampleLineEndMarker = null;

    // Map click handler bound reference (so we can remove it)
    let _mapClickBound = null;

    // Layer visibility state
    const _layerVisible = { buildings: true, vegetation: true, viewshed: true };
    const _observerColors = ['#38bdf8', '#f97316', '#22c55e', '#a78bfa', '#facc15', '#fb7185', '#14b8a6', '#60a5fa'];

    // Panel drag / collapse state
    let _panelDragged    = false;
    let _ctrlsCollapsed  = false;

    // ── DOM helpers ──────────────────────────────────────────────────────────
    function el(id) { return document.getElementById(id); }

    function setCoordDisplay(elId, lonlat) {
        const d = el(elId);
        if (!d) return;
        d.textContent = lonlat
            ? `${lonlat.lat.toFixed(5)}, ${lonlat.lon.toFixed(5)}`
            : '— click map —';
    }

    function _getSelectedObserver() {
        return _observers.find(obs => obs.id === _selectedObserverId) || null;
    }

    function _hasComputedObservers() {
        return _observers.some(obs => !!obs.result);
    }

    function _observerStatusText(observer) {
        if (!observer || !observer.result) return 'Not computed';
        const status = observer.result.visible ? 'Clear' : `Blocked: ${_reasonLabel(observer.result.reason)}`;
        const distance = observer.result.distance_m != null ? `${observer.result.distance_m.toFixed(0)} m` : '—';
        return `${status} · ${distance}`;
    }

    function _ensureSelectedObserver() {
        if (_selectedObserverId && _getSelectedObserver()) return;
        _selectedObserverId = _observers.length ? _observers[0].id : null;
    }

    function _updateObserverFieldDisplay() {
        const selected = _getSelectedObserver();
        const obsInput = el('los-obs-agl');
        if (selected) {
            if (obsInput && document.activeElement !== obsInput) {
                obsInput.value = selected.height_agl_m;
            }
            setCoordDisplay('los-obs-coord', selected);
        } else {
            setCoordDisplay('los-obs-coord', null);
        }
    }

    function _renderObserverList() {
        _ensureSelectedObserver();
        const listEl = el('los-observers-list');
        const summaryEl = el('los-observers-summary');
        if (!listEl) return;
        if (!_observers.length) {
            listEl.innerHTML = '<div style="font-size:12px;color:#64748b;">No observers added yet. Click <b>Add Observer</b> and place points on the map.</div>';
            if (summaryEl) summaryEl.textContent = 'No observers yet';
            _updateObserverFieldDisplay();
            return;
        }
        const computedCount = _observers.filter(obs => !!obs.result).length;
        if (summaryEl) {
            summaryEl.textContent = `${_observers.length} observer${_observers.length === 1 ? '' : 's'} · ${computedCount} computed`;
        }
        listEl.innerHTML = _observers.map(obs => {
            const selected = obs.id === _selectedObserverId;
            const status = _observerStatusText(obs);
            return `
                <div data-observer-id="${obs.id}" style="display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:10px;border:1px solid ${selected ? obs.color : 'rgba(51,65,85,0.75)'};background:${selected ? 'rgba(15,23,42,0.92)' : 'rgba(2,6,23,0.5)'};">
                  <button data-observer-select="${obs.id}" style="flex:1;display:flex;align-items:center;gap:8px;min-width:0;background:none;border:none;color:#e2e8f0;cursor:pointer;padding:0;text-align:left;">
                    <span style="width:12px;height:12px;border-radius:999px;background:${obs.color};flex:0 0 auto;"></span>
                    <span style="display:flex;flex-direction:column;min-width:0;">
                      <span style="font-size:12px;font-weight:700;color:${selected ? obs.color : '#e2e8f0'};">${obs.label}</span>
                      <span style="font-size:11px;color:#94a3b8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${status}</span>
                    </span>
                  </button>
                  <button data-observer-remove="${obs.id}" title="Remove observer" style="background:none;border:none;color:#94a3b8;cursor:pointer;font-size:13px;padding:2px 4px;line-height:1;">✕</button>
                </div>
            `;
        }).join('');

        listEl.querySelectorAll('[data-observer-select]').forEach(btn => {
            btn.addEventListener('click', () => {
                _selectedObserverId = btn.getAttribute('data-observer-select');
                _renderObserverList();
                _refreshObserverMarkers();
                _refreshObserverResultVisuals();
                _renderSelectedObserverResult();
            });
        });
        listEl.querySelectorAll('[data-observer-remove]').forEach(btn => {
            btn.addEventListener('click', () => {
                _removeObserver(btn.getAttribute('data-observer-remove'));
            });
        });
        _updateObserverFieldDisplay();
    }

    function _createObserver(lon, lat) {
        const label = `O${_observerSeq + 1}`;
        const observer = {
            id: `obs-${Date.now()}-${_observerSeq + 1}`,
            label,
            lon,
            lat,
            height_agl_m: _obsAgl || 25,
            color: _observerColors[_observerSeq % _observerColors.length],
            result: null,
            marker: null,
            lineLayer: null,
            blockerLayer: null,
        };
        _observerSeq += 1;
        _observers.push(observer);
        _selectedObserverId = observer.id;
        _renderObserverList();
        _refreshObserverMarkers();
    }

    function _removeObserver(id) {
        const observer = _observers.find(obs => obs.id === id);
        if (observer) {
            if (observer.marker) observer.marker.remove();
            if (observer.lineLayer) observer.lineLayer.remove();
            if (observer.blockerLayer) observer.blockerLayer.remove();
        }
        _observers = _observers.filter(obs => obs.id !== id);
        if (_selectedObserverId === id) {
            _selectedObserverId = _observers.length ? _observers[0].id : null;
        }
        _renderObserverList();
        _refreshObserverMarkers();
        _refreshObserverResultVisuals();
        _renderSelectedObserverResult();
    }

    function _renderSample(sample) {
        const coordEl = el('los-sample-coord');
        const valueEl = el('los-sample-value');
        if (coordEl) {
            coordEl.textContent = `${sample.lat.toFixed(5)}, ${sample.lon.toFixed(5)}`;
        }
        if (valueEl) {
            const ground = sample.ground_m == null ? '—' : `${Number(sample.ground_m).toFixed(2)} m`;
            const clutter = sample.clutter_height_agl_m == null ? '—' : `${Number(sample.clutter_height_agl_m).toFixed(2)} m`;
            const surface = sample.obstacle_surface_m == null ? '—' : `${Number(sample.obstacle_surface_m).toFixed(2)} m`;
            const dataset = sample.active_dataset && sample.active_dataset.atoll_root
                ? sample.active_dataset.atoll_root.split('/').filter(Boolean).pop()
                : 'unknown';
            valueEl.textContent = `Ground: ${ground} | Clutter AGL: ${clutter} | Surface: ${surface} | Dataset: ${dataset}`;
        }
    }

    async function _inspectPoint(lonlat) {
        try {
            const sample = await window.losSamplePoint(lonlat.lon, lonlat.lat);
            _renderSample(sample);
            _addSampleMarker(sample);
        } catch (err) {
            const valueEl = el('los-sample-value');
            if (valueEl) valueEl.textContent = `Sample failed: ${err.message}`;
        }
    }

    function _addSampleMarker(sample) {
        const map = _getMap();
        if (!map) return;
        _ensureLayers();
        if (!_sampleMarkersLayer) return;
        const marker = L.circleMarker([sample.lat, sample.lon], {
            pane: 'losMarkersPane',
            radius: 4,
            color: '#ffffff',
            weight: 1.2,
            fillColor: '#38bdf8',
            fillOpacity: 0.95,
            interactive: false,
        });
        const ground = sample.ground_m == null ? '—' : `${Number(sample.ground_m).toFixed(1)} m`;
        marker.bindTooltip(`Ground ${ground}`, {
            direction: 'top',
            offset: [0, -6],
            opacity: 0.9,
        });
        marker.addTo(_sampleMarkersLayer);
        const markers = _sampleMarkersLayer.getLayers();
        if (markers.length > 12) {
            _sampleMarkersLayer.removeLayer(markers[0]);
        }
    }

    function _clearSampleMarkers() {
        if (_sampleMarkersLayer) _sampleMarkersLayer.clearLayers();
    }

    function _sampleLineHandleIcon(label) {
        return L.divIcon({
            className: '',
            iconSize: [22, 22],
            iconAnchor: [11, 11],
            html:
                `<div style="width:22px;height:22px;border-radius:50%;background:#0f172a;border:2px solid #38bdf8;color:#38bdf8;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:800;box-shadow:0 2px 8px rgba(2,6,23,0.45);">${label}</div>`,
        });
    }

    function _syncSampleLineGeometry() {
        if (_sampleLineLayer && _sampleLineStart && _sampleLineEnd) {
            _sampleLineLayer.setLatLngs([
                [_sampleLineStart.lat, _sampleLineStart.lon],
                [_sampleLineEnd.lat, _sampleLineEnd.lon],
            ]);
        }
    }

    function _updateSampleLineStatus(text) {
        const coordEl = el('los-sample-coord');
        const valueEl = el('los-sample-value');
        if (coordEl && _sampleLineStart && _sampleLineEnd) {
            coordEl.textContent = `A ${_sampleLineStart.lat.toFixed(5)}, ${_sampleLineStart.lon.toFixed(5)} | B ${_sampleLineEnd.lat.toFixed(5)}, ${_sampleLineEnd.lon.toFixed(5)}`;
        }
        if (valueEl && text) {
            valueEl.textContent = text;
        }
    }

    function _drawSampleLine(start, end) {
        const map = _getMap();
        if (!map) return;
        _ensureLayers();
        if (_sampleLineLayer) {
            _sampleLineLayer.remove();
            _sampleLineLayer = null;
        }
        _sampleLineLayer = L.polyline(
            [[start.lat, start.lon], [end.lat, end.lon]],
            { color: '#38bdf8', weight: 2, dashArray: '5 5', pane: 'losPane' }
        ).addTo(map);
    }

    function _ensureSampleLineMarkers() {
        const map = _getMap();
        if (!map || !_sampleLineStart || !_sampleLineEnd) return;
        _ensureLayers();

        if (!_sampleLineStartMarker) {
            _sampleLineStartMarker = L.marker(
                [_sampleLineStart.lat, _sampleLineStart.lon],
                { icon: _sampleLineHandleIcon('A'), draggable: true, pane: 'losMarkersPane' }
            ).addTo(map);
            _sampleLineStartMarker.on('drag', () => {
                const ll = _sampleLineStartMarker.getLatLng();
                _sampleLineStart = { lon: ll.lng, lat: ll.lat };
                _syncSampleLineGeometry();
                _queueInspectLineProfile(false);
            });
            _sampleLineStartMarker.on('dragend', () => {
                const ll = _sampleLineStartMarker.getLatLng();
                _sampleLineStart = { lon: ll.lng, lat: ll.lat };
                _syncSampleLineGeometry();
                _queueInspectLineProfile(true);
            });
        } else {
            _sampleLineStartMarker.setLatLng([_sampleLineStart.lat, _sampleLineStart.lon]);
        }

        if (!_sampleLineEndMarker) {
            _sampleLineEndMarker = L.marker(
                [_sampleLineEnd.lat, _sampleLineEnd.lon],
                { icon: _sampleLineHandleIcon('B'), draggable: true, pane: 'losMarkersPane' }
            ).addTo(map);
            _sampleLineEndMarker.on('drag', () => {
                const ll = _sampleLineEndMarker.getLatLng();
                _sampleLineEnd = { lon: ll.lng, lat: ll.lat };
                _syncSampleLineGeometry();
                _queueInspectLineProfile(false);
            });
            _sampleLineEndMarker.on('dragend', () => {
                const ll = _sampleLineEndMarker.getLatLng();
                _sampleLineEnd = { lon: ll.lng, lat: ll.lat };
                _syncSampleLineGeometry();
                _queueInspectLineProfile(true);
            });
        } else {
            _sampleLineEndMarker.setLatLng([_sampleLineEnd.lat, _sampleLineEnd.lon]);
        }
    }

    async function _runInspectLineProfile(start, end) {
        const reqSeq = ++_sampleLineRequestSeq;
        try {
            const profileResult = await window.losGetProfile(
                start.lon, start.lat,
                end.lon, end.lat,
                _spacingM || 2,
                false
            );
            if (reqSeq !== _sampleLineRequestSeq) return;
            const wrap = el('los-profile-wrap');
            const title = el('los-profile-title');
            if (wrap) wrap.style.display = '';
            if (title) title.textContent = 'Terrain Profile (Inspect Line)';
            if (window.losRenderGroundProfile) {
                window.losRenderGroundProfile(profileResult.profile, 'Ground (DTM)');
            }
            _updateSampleLineStatus(
                `Terrain profile: ${profileResult.distance_m.toFixed(0)} m | Drag A/B to update in real time.`
            );
        } catch (err) {
            if (reqSeq !== _sampleLineRequestSeq) return;
            const valueEl = el('los-sample-value');
            if (valueEl) valueEl.textContent = `Inspect line failed: ${err.message}`;
        }
    }

    function _queueInspectLineProfile(immediate = false) {
        if (!_sampleLineStart || !_sampleLineEnd) return;
        if (_sampleLineDragTimer) {
            clearTimeout(_sampleLineDragTimer);
            _sampleLineDragTimer = null;
        }
        const start = { ..._sampleLineStart };
        const end = { ..._sampleLineEnd };
        _updateSampleLineStatus('Updating terrain profile…');
        if (immediate) {
            _runInspectLineProfile(start, end);
            return;
        }
        _sampleLineDragTimer = setTimeout(() => {
            _sampleLineDragTimer = null;
            _runInspectLineProfile(start, end);
        }, 120);
    }

    function _clearSampleLine() {
        _sampleLineStart = null;
        _sampleLineEnd = null;
        if (_sampleLineDragTimer) {
            clearTimeout(_sampleLineDragTimer);
            _sampleLineDragTimer = null;
        }
        _sampleLineRequestSeq += 1;
        if (_sampleLineLayer) {
            _sampleLineLayer.remove();
            _sampleLineLayer = null;
        }
        if (_sampleLineStartMarker) {
            _sampleLineStartMarker.remove();
            _sampleLineStartMarker = null;
        }
        if (_sampleLineEndMarker) {
            _sampleLineEndMarker.remove();
            _sampleLineEndMarker = null;
        }
    }

    async function _inspectLine(start, end) {
        _sampleLineStart = { ...start };
        _sampleLineEnd = { ...end };
        _drawSampleLine(start, end);
        _ensureSampleLineMarkers();
        _updateSampleLineStatus('Updating terrain profile…');
        _queueInspectLineProfile(true);
    }

    // ── Main Leaflet map accessor ────────────────────────────────────────────
    function _getMap() {
        return window.mapRenderer && window.mapRenderer.map;
    }

    // ── Ensure LOS layers are added to the main map (idempotent) ────────────
    function _ensureLayers() {
        const map = _getMap();
        if (!map) return false;

        // Dedicated pane below Leaflet's marker pane so LOS geometry doesn't block site clicks
        if (!map.getPane('losPane')) {
            map.createPane('losPane');
            map.getPane('losPane').style.zIndex = '620';
            map.getPane('losPane').style.pointerEvents = 'none';
        }
        // Separate pane for LOS markers so they are interactive and above geometry
        if (!map.getPane('losMarkersPane')) {
            map.createPane('losMarkersPane');
            map.getPane('losMarkersPane').style.zIndex = '750';
            // Do not set pointerEvents: auto on the pane container itself; Leaflet handles interactive children automatically.
        }

        // Buildings + vegetation polygons
        if (!_featuresLayer) {
            _featuresLayer = L.geoJSON(null, {
                pane: 'losPane',
                style: feat => feat.properties.feature_type === 'building'
                    ? { fillColor: '#f97316', fillOpacity: 0.28, color: '#ea580c', weight: 1.2 }
                    : { fillColor: '#22c55e', fillOpacity: 0.28, color: '#16a34a', weight: 1 },
            }).addTo(map);
        }

        // Viewshed polygon
        if (!_viewshedLayer) {
            _viewshedLayer = L.geoJSON(null, {
                pane: 'losPane',
                style: { fillColor: '#22c55e', fillOpacity: 0.18, color: '#16a34a', weight: 1.5, dashArray: '6 4' },
            }).addTo(map);
        }

        if (!_sampleMarkersLayer) {
            _sampleMarkersLayer = L.layerGroup().addTo(map);
        }

        // Refresh features when user pans/zooms (re-registers safely)
        map.off('moveend', _loadFeatures).on('moveend', _loadFeatures);
        return true;
    }

    // ── Load buildings + vegetation within current main map view ─────────────
    function _loadFeatures() {
        const map = _getMap();
        if (!map || !_featuresLayer) return;
        const b = map.getBounds();
        const base = window.LOS_BASE || `${window.location.protocol}//${window.location.hostname}:8001`;
        const maxPerType = 5000;
        const url = `${base}/api/los/features` +
            `?min_lon=${b.getWest().toFixed(6)}&min_lat=${b.getSouth().toFixed(6)}` +
            `&max_lon=${b.getEast().toFixed(6)}&max_lat=${b.getNorth().toFixed(6)}` +
            `&max_per_type=${maxPerType}`;
        fetch(url)
            .then(r => r.ok ? r.json() : null)
            .then(d => {
                if (!d || !_featuresLayer) return;
                _featuresLayer.clearLayers();
                _featuresLayer.addData(d);
                _applyFeatureVisibility();
            })
            .catch(() => {});
    }

    function _applyFeatureVisibility() {
        if (!_featuresLayer) return;
        _featuresLayer.eachLayer(layer => {
            const ft = layer.feature && layer.feature.properties && layer.feature.properties.feature_type;
            if (ft === 'building') {
                layer.setStyle({ opacity: _layerVisible.buildings ? 1 : 0, fillOpacity: _layerVisible.buildings ? 0.28 : 0 });
            } else if (ft === 'vegetation') {
                layer.setStyle({ opacity: _layerVisible.vegetation ? 1 : 0, fillOpacity: _layerVisible.vegetation ? 0.28 : 0 });
            }
        });
    }

    // ── SVG marker HTML ──────────────────────────────────────────────────────
    function _antennaIconHTML() {
        return `<div class="los-marker-antenna" title="Observer — drag to move">
<svg xmlns="http://www.w3.org/2000/svg" width="36" height="56" viewBox="0 0 36 56">
  <rect x="15.5" y="8"  width="5" height="8"  rx="1" fill="#ffffff" stroke="#ccc" stroke-width="0.3"/>
  <rect x="15.5" y="16" width="5" height="8"  rx="1" fill="#e53e3e"/>
  <rect x="15.5" y="24" width="5" height="8"  rx="1" fill="#ffffff" stroke="#ccc" stroke-width="0.3"/>
  <rect x="15.5" y="32" width="5" height="8"  rx="1" fill="#e53e3e"/>
  <rect x="15.5" y="40" width="5" height="8"  rx="1" fill="#ffffff" stroke="#ccc" stroke-width="0.3"/>
  <rect x="15.5" y="48" width="5" height="7"  rx="1" fill="#e53e3e"/>
  <rect x="10"   y="53" width="16" height="3" rx="1.5" fill="#1e293b"/>
  <rect x="16.5" y="3"  width="3"  height="7" rx="1" fill="#94a3b8"/>
  <line x1="18" y1="7" x2="4"  y2="12" stroke="#94a3b8" stroke-width="1.8" stroke-linecap="round"/>
  <line x1="18" y1="7" x2="32" y2="12" stroke="#94a3b8" stroke-width="1.8" stroke-linecap="round"/>
  <rect x="2"  y="10" width="5" height="4" rx="1" fill="#60a5fa" stroke="#3b82f6" stroke-width="0.8"/>
  <rect x="29" y="10" width="5" height="4" rx="1" fill="#60a5fa" stroke="#3b82f6" stroke-width="0.8"/>
  <circle cx="18" cy="12" r="2.5" fill="#fde047" stroke="#ca8a04" stroke-width="0.8"/>
</svg></div>`;
    }

    function _phoneIconHTML() {
        return `<div class="los-marker-phone" title="Target — drag to move">
<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28">
  <circle cx="14" cy="14" r="13" fill="rgba(0,0,0,0.35)"/>
  <circle cx="14" cy="13" r="12" fill="#7c3aed"/>
  <rect x="9" y="5" width="10" height="16" rx="2" fill="#e2e8f0" stroke="#c4b5fd" stroke-width="0.8"/>
  <rect x="10.2" y="7.2" width="7.6" height="10" rx="1" fill="#1e293b"/>
  <rect x="12" y="6" width="4" height="1" rx="0.5" fill="#94a3b8"/>
  <circle cx="14" cy="19.5" r="1" fill="#94a3b8"/>
  <rect x="15.5" y="9.5" width="1.2" height="1.5" rx="0.3" fill="#22c55e"/>
  <rect x="16.9" y="9"   width="1.2" height="2"   rx="0.3" fill="#22c55e"/>
</svg></div>`;
    }

    function _observerIconHTML(observer, selected) {
        return `<div title="${observer.label} — drag to move" style="width:28px;height:28px;border-radius:50%;background:#0f172a;border:2px solid ${observer.color};display:flex;align-items:center;justify-content:center;color:${selected ? observer.color : '#e2e8f0'};font-size:11px;font-weight:800;box-shadow:0 2px 10px rgba(2,6,23,0.45);">${observer.label}</div>`;
    }

    let _losDragTimer = null;
    function _queueComputeLos(observerIds) {
        if (_losDragTimer) clearTimeout(_losDragTimer);
        _losDragTimer = setTimeout(() => {
            _losDragTimer = null;
            if (_hasComputedObservers()) {
                _computeObservers(observerIds, { silent: true });
            }
        }, 400);
    }

    // ── Marker management on main map ────────────────────────────────────────
    function _refreshObserverMarkers() {
        const map = _getMap();
        if (!map) return;
        _ensureLayers();

        if (_tgtMarker) { _tgtMarker.remove(); _tgtMarker = null; }
        if (_target) {
            _tgtMarker = L.marker([_target.lat, _target.lon], {
                icon: L.divIcon({ html: _phoneIconHTML(), className: '', iconSize: [28, 28], iconAnchor: [14, 14] }),
                draggable: true,
                pane: 'losMarkersPane',
            }).addTo(map);
            _tgtMarker.on('drag', () => {
                const ll = _tgtMarker.getLatLng();
                _target = { lon: ll.lng, lat: ll.lat };
                setCoordDisplay('los-tgt-coord', _target);
                _observers.forEach(observer => {
                    if (observer.lineLayer) {
                        observer.lineLayer.setLatLngs([[observer.lat, observer.lon], [_target.lat, _target.lon]]);
                    }
                });
                _queueComputeLos(_observers.map(obs => obs.id));
            });
            _tgtMarker.on('dragend', () => {
                const ll = _tgtMarker.getLatLng();
                _target = { lon: ll.lng, lat: ll.lat };
                setCoordDisplay('los-tgt-coord', _target);
                if (_hasComputedObservers()) {
                    _computeObservers(_observers.map(obs => obs.id), { silent: true });
                }
            });
        }

        _observers.forEach(observer => {
            if (observer.marker) {
                observer.marker.remove();
                observer.marker = null;
            }
            const selected = observer.id === _selectedObserverId;
            observer.marker = L.marker([observer.lat, observer.lon], {
                icon: L.divIcon({ html: _observerIconHTML(observer, selected), className: '', iconSize: [28, 28], iconAnchor: [14, 14] }),
                draggable: true,
                pane: 'losMarkersPane',
            }).addTo(map);
            observer.marker.on('click', () => {
                _selectedObserverId = observer.id;
                _renderObserverList();
                _refreshObserverMarkers();
                _refreshObserverResultVisuals();
                _renderSelectedObserverResult();
            });
            observer.marker.on('drag', () => {
                const ll = observer.marker.getLatLng();
                observer.lon = ll.lng;
                observer.lat = ll.lat;
                if (observer.id === _selectedObserverId) {
                    _updateObserverFieldDisplay();
                }
                if (observer.lineLayer) {
                    observer.lineLayer.setLatLngs([[_target ? observer.lat : observer.lat, observer.lon], [_target ? _target.lat : observer.lat, _target ? _target.lon : observer.lon]]);
                }
                if (_target && (observer.result || _hasComputedObservers())) {
                    _queueComputeLos([observer.id]);
                }
            });
            observer.marker.on('dragend', () => {
                const ll = observer.marker.getLatLng();
                observer.lon = ll.lng;
                observer.lat = ll.lat;
                if (observer.id === _selectedObserverId) {
                    _updateObserverFieldDisplay();
                }
                _renderObserverList();
                if (_target && (observer.result || _hasComputedObservers())) {
                    _computeObservers([observer.id], { silent: true });
                } else {
                    _refreshObserverResultVisuals();
                }
            });
        });
    }

    function _clearObserverResultVisuals() {
        _observers.forEach(observer => {
            if (observer.lineLayer) {
                observer.lineLayer.remove();
                observer.lineLayer = null;
            }
            if (observer.blockerLayer) {
                observer.blockerLayer.remove();
                observer.blockerLayer = null;
            }
        });
    }

    function _refreshObserverResultVisuals() {
        const map = _getMap();
        if (!map || !_target) return;
        _ensureLayers();
        _clearObserverResultVisuals();
        _observers.forEach(observer => {
            if (!observer.result) return;
            const selected = observer.id === _selectedObserverId;
            observer.lineLayer = L.polyline(
                [[observer.lat, observer.lon], [_target.lat, _target.lon]],
                {
                    color: observer.color,
                    weight: selected ? 4 : 2.5,
                    opacity: selected ? 1 : 0.72,
                    dashArray: observer.result.visible ? null : '6 4',
                    pane: 'losPane',
                }
            ).addTo(map);
            if (!observer.result.visible && observer.result.location) {
                observer.blockerLayer = L.circleMarker(
                    [observer.result.location.lat, observer.result.location.lon],
                    {
                        radius: selected ? 6 : 4.5,
                        color: '#fff',
                        weight: 1.5,
                        fillColor: observer.color,
                        fillOpacity: 1,
                        pane: 'losPane',
                    }
                ).addTo(map);
            }
        });
    }

    // ── Map pick mode ────────────────────────────────────────────────────────
    function _startPicking(mode) {
        _stopPicking();
        const map = _getMap();
        if (!map) return;
        _mapClickBound = e => _onMapClick(e);
        map.on('click', _mapClickBound);
        map.getContainer().style.cursor = mode === 'picking_observer' ? 'crosshair' : 'cell';
    }

    function _stopPicking() {
        const map = _getMap();
        if (map && _mapClickBound) {
            map.off('click', _mapClickBound);
            map.getContainer().style.cursor = '';
        }
        _mapClickBound = null;
    }

    function _onMapClick(e) {
        const lon = e.latlng.lng;
        const lat = e.latlng.lat;
        if (_state === 'picking_observer') {
            _createObserver(lon, lat);
            _stopPicking();
            _setState('idle');
        } else if (_state === 'picking_target') {
            _target = { lon, lat };
            setCoordDisplay('los-tgt-coord', _target);
            _stopPicking();
            _setState('idle');
            _refreshObserverMarkers();
            if (_hasComputedObservers()) {
                _computeObservers(_observers.map(obs => obs.id), { silent: true });
            }
        } else if (_state === 'picking_sample') {
            _stopPicking();
            _setState('idle');
            _inspectPoint({ lon, lat });
        } else if (_state === 'picking_sample_line') {
            if (!_sampleLineStart) {
                _sampleLineStart = { lon, lat };
                const coordEl = el('los-sample-coord');
                const valueEl = el('los-sample-value');
                if (coordEl) coordEl.textContent = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
                if (valueEl) valueEl.textContent = 'Inspect line: first point set. Click the second point on the map.';
            } else {
                const start = _sampleLineStart;
                const end = { lon, lat };
                _stopPicking();
                _setState('idle');
                _inspectLine(start, end);
            }
        }
    }

    // ── State / instructions ─────────────────────────────────────────────────
    function _setState(s) {
        _state = s;
        const instrEl = el('los-instructions');
        if (instrEl) {
            instrEl.innerHTML =
                s === 'picking_observer'
                    ? '<span style="color:#60a5fa;font-weight:700">&#x25CF; Click the map to place the OBSERVER (antenna tower).</span>'
                    : s === 'picking_target'
                    ? '<span style="color:#a78bfa;font-weight:700">&#x25CF; Click the map to place the TARGET (phone).</span>'
                    : s === 'picking_sample'
                    ? '<span style="color:#38bdf8;font-weight:700">&#x25CF; Click the map to inspect the terrain sample used by LOS.</span>'
                    : s === 'picking_sample_line'
                    ? '<span style="color:#38bdf8;font-weight:700">&#x25CF; Click the first point, then the second point, to validate the terrain profile. After that, drag A or B to update it live.</span>'
                    : s === 'computing'
                    ? 'Computing line of sight&hellip;'
                    : '<strong>Step 1</strong> — click <em>Observer</em>, then click the map.<br>'
                    + '<strong>Step 2</strong> — click <em>Target</em>, then click the map.';
        }
        const spinner = el('los-spinner');
        if (spinner) spinner.classList.toggle('los-spinner--active', s === 'computing');
    }

    // ── LOS line + blocker on main map ───────────────────────────────────────
    function _clearLosLine() {
        _clearObserverResultVisuals();
    }

    // ── Helpers ───────────────────────────────────────────────────────────────
    function _reasonLabel(reason) {
        return { clutter_height: 'Terrain/Clutter', building: 'Building', vegetation: 'Vegetation' }[reason]
            || (reason ? reason.replace(/_/g, ' ') : 'Obstruction');
    }

    // ── Result rendering ──────────────────────────────────────────────────────
    function _renderResult(result, observer = null) {
        _lastResult = result;
        el('los-result').classList.add('los-result--show');

        const prefix = observer ? `${observer.label} · ` : '';
        el('los-badge').innerHTML = result.visible
            ? `<span class="los-badge los-badge--clear">&#x2713; ${prefix}CLEAR LOS</span>`
            : `<span class="los-badge los-badge--blocked">&#x2717; ${prefix}BLOCKED &mdash; ${_reasonLabel(result.reason)}</span>`;

        const blockerDisplay = result.blocker_id
            ? result.blocker_id
            : (result.reason ? _reasonLabel(result.reason) : '—');

        const stats = [
            ['Observer',     observer ? observer.label : '—'],
            ['Distance',     result.distance_m != null ? result.distance_m.toFixed(0) + ' m' : '—'],
            ['Blocker',      result.visible ? '—' : blockerDisplay],
            ['Blocker dist', result.distance_to_blocker_m != null ? result.distance_to_blocker_m.toFixed(0) + ' m' : '—'],
            ['Ray height',   result.ray_height_m != null ? result.ray_height_m.toFixed(1) + ' m' : '—'],
            ['Obstacle ht',  result.obstacle_height_m != null ? result.obstacle_height_m.toFixed(1) + ' m' : '—'],
            ['Clearance',    result.clearance_m != null ? result.clearance_m.toFixed(1) + ' m' : '—'],
            ...(result.loss_db != null ? [['RF loss', result.loss_db.toFixed(1) + ' dB']] : []),
        ];
        el('los-stats').innerHTML = stats.map(([k, v]) =>
            `<div class="los-stat"><span class="los-stat__label">${k}</span>` +
            `<span class="los-stat__value${result.clearance_m < 0 && k === 'Clearance' ? ' los-stat__value--warn' : ''}">${v}</span></div>`
        ).join('');

        if (result.profile && result.profile.length && window.losRenderProfile) {
            el('los-profile-wrap').style.display = '';
            window.losRenderProfile(result.profile, result);
        }
    }

    function _renderSelectedObserverResult() {
        const observer = _getSelectedObserver();
        if (!observer || !observer.result) {
            _clearResult();
            const badge = el('los-badge');
            const stats = el('los-stats');
            if (badge) badge.innerHTML = '';
            if (stats) stats.innerHTML = _observers.length
                ? '<div class="los-stat"><span class="los-stat__label">Selected observer</span><span class="los-stat__value">Compute LOS to see details</span></div>'
                : '<div class="los-stat"><span class="los-stat__label">Observers</span><span class="los-stat__value">Add at least one observer</span></div>';
            const resultWrap = el('los-result');
            if (resultWrap) resultWrap.classList.add('los-result--show');
            return;
        }
        _renderResult(observer.result, observer);
    }

    function _clearResult() {
        const r = el('los-result');
        if (r) r.classList.remove('los-result--show');
        const pw = el('los-profile-wrap');
        if (pw) pw.style.display = 'none';
        if (window.losClearProfile) window.losClearProfile();
        _clearLosLine();
    }

    // ── Compute ───────────────────────────────────────────────────────────────
    let _computing = false;
    async function _computeObservers(observerIds = null, { silent = false } = {}) {
        if (_computing && silent) return;   // skip drag-triggered calls while busy
        if (!_target) {
            if (!silent) alert('Set the target first.');
            return;
        }
        if (!_observers.length) {
            if (!silent) alert('Add at least one observer first.');
            return;
        }
        _obsAgl   = parseFloat(el('los-obs-agl').value)  || 25;
        _tgtAgl   = parseFloat(el('los-tgt-agl').value)  || 1.5;
        _freqMhz  = parseFloat(el('los-freq').value)     || null;
        _spacingM = parseFloat(el('los-spacing').value)  || 2;

        const selected = _getSelectedObserver();
        if (selected && Number.isFinite(_obsAgl)) {
            selected.height_agl_m = _obsAgl;
        }

        const targets = observerIds
            ? _observers.filter(obs => observerIds.includes(obs.id))
            : _observers.slice();
        if (!targets.length) return;

        _computing = true;
        _setState('computing');
        try {
            const options = {
                include_terrain: true,
                include_clutter_height: true,
                include_buildings: true,
                include_vegetation: true,
                sample_spacing_m: _spacingM,
                frequency_mhz: _freqMhz || undefined,
                custom_obstacles: window.losObstaclesGetAll
                    ? window.losObstaclesGetAll().map(o => ({
                          geometry:   o.geojson_wgs84,
                          properties: { name: o.name, obstacle_type: o.type, height_agl_m: o.height_agl_m },
                      }))
                    : [],
            };
            const results = await Promise.all(targets.map(observer =>
                window.losComputeLos(
                    { lon: observer.lon, lat: observer.lat, height_agl_m: observer.height_agl_m },
                    { lon: _target.lon,  lat: _target.lat,  height_agl_m: _tgtAgl },
                    options,
                ).then(result => ({ observer, result }))
            ));
            results.forEach(({ observer, result }) => {
                observer.result = result;
            });
            _renderObserverList();
            _refreshObserverMarkers();
            _refreshObserverResultVisuals();
            _renderSelectedObserverResult();
            _setState('idle');
        } catch (err) {
            if (!silent) alert('LOS computation failed: ' + err.message);
            _setState('idle');
        } finally {
            _computing = false;
        }
    }

    // _compute moved below with error handling

    // ── Reset ─────────────────────────────────────────────────────────────────
    function _reset() {
        _target = null;
        _lastResult = null;
        _observers.forEach(observer => {
            if (observer.marker) observer.marker.remove();
            if (observer.lineLayer) observer.lineLayer.remove();
            if (observer.blockerLayer) observer.blockerLayer.remove();
        });
        _observers = [];
        _selectedObserverId = null;
        if (_tgtMarker) { _tgtMarker.remove(); _tgtMarker = null; }
        setCoordDisplay('los-obs-coord', null);
        setCoordDisplay('los-tgt-coord', null);
        const sampleCoordEl = el('los-sample-coord');
        const sampleValueEl = el('los-sample-value');
        if (sampleCoordEl) sampleCoordEl.textContent = '— click Inspect, then map —';
        if (sampleValueEl) sampleValueEl.textContent = 'Ground: —';
        _clearSampleMarkers();
        _clearSampleLine();
        _clearResult();
        _stopPicking();
        _setState('idle');
        _renderObserverList();
        _renderSelectedObserverResult();
    }

    // ── Panel drag ────────────────────────────────────────────────────────────
    function _initPanelDrag() {
        const header = el('los-panel-header');
        const panel  = el('los-panel');
        if (!header || !panel) return;

        header.addEventListener('mousedown', e => {
            if (e.target === el('los-panel-close')) return;
            if (e.target === el('los-panel-collapse')) return;
            if (e.target.closest && e.target.closest('#los-panel-collapse')) return;
            e.preventDefault();
            const rect = panel.getBoundingClientRect();
            panel.style.transform = 'none';
            panel.style.left = rect.left + 'px';
            panel.style.top  = rect.top  + 'px';
            _panelDragged = true;

            const offX = e.clientX - rect.left;
            const offY = e.clientY - rect.top;

            function onMove(ev) {
                panel.style.left = Math.max(0, Math.min(window.innerWidth  - panel.offsetWidth,  ev.clientX - offX)) + 'px';
                panel.style.top  = Math.max(0, Math.min(window.innerHeight - panel.offsetHeight, ev.clientY - offY)) + 'px';
            }
            function onUp() {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup',   onUp);
            }
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup',   onUp);
        });
    }

    // ── Section resize (top-pane ↔ profile) ──────────────────────────────────
    function _initSectionResize() {
        document.querySelectorAll('#los-panel .los-section-handle').forEach(handle => {
            handle.addEventListener('mousedown', e => {
                e.preventDefault();
                e.stopPropagation();
                const prev = handle.previousElementSibling;
                if (!prev) return;
                const startY = e.clientY;
                const startH = prev.getBoundingClientRect().height;
                function onMove(ev) {
                    const newH = Math.max(60, startH + (ev.clientY - startY));
                    prev.style.height    = newH + 'px';
                    prev.style.minHeight = '0';
                    prev.style.flex      = 'none';
                }
                function onUp() {
                    document.removeEventListener('mousemove', onMove);
                    document.removeEventListener('mouseup',   onUp);
                }
                document.addEventListener('mousemove', onMove);
                document.addEventListener('mouseup',   onUp);
            });
        });
    }

    // ── Viewshed ──────────────────────────────────────────────────────────────
    async function _computeViewshed() {
        const observer = _getSelectedObserver();
        if (!observer) { alert('Select or add an observer first.'); return; }
        const radius  = parseFloat(el('los-vs-radius').value) || 1000;
        const azStep  = parseFloat(el('los-vs-az').value)     || 2;
        const spinner = el('los-spinner');
        if (spinner) spinner.classList.add('los-spinner--active');

        try {
            const feature = await window.losComputeViewshed(
                { lon: observer.lon, lat: observer.lat, height_agl_m: observer.height_agl_m },
                { max_radius_m: radius, az_step_deg: azStep, r_step_m: 5, include_clutter: true },
            );
            if (_viewshedLayer) {
                _viewshedLayer.clearLayers();
                _viewshedLayer.addData({ type: 'FeatureCollection', features: [feature] });
            }
            const vsToggle = el('los-toggle-viewshed');
            const vsClear  = el('los-btn-clear-viewshed');
            if (vsToggle) { vsToggle.style.display = ''; vsToggle.classList.add('los-layer-btn--active'); }
            if (vsClear)  vsClear.style.display = '';
            _layerVisible.viewshed = true;
        } catch (err) {
            alert('Viewshed failed: ' + err.message);
        } finally {
            if (spinner) spinner.classList.remove('los-spinner--active');
        }
    }

    function _clearViewshed() {
        if (_viewshedLayer) _viewshedLayer.clearLayers();
        const vsToggle = el('los-toggle-viewshed');
        const vsClear  = el('los-btn-clear-viewshed');
        if (vsToggle) { vsToggle.style.display = 'none'; vsToggle.classList.remove('los-layer-btn--active'); }
        if (vsClear)  vsClear.style.display = 'none';
    }

    // ── Layer toggles ─────────────────────────────────────────────────────────
    function _setLayerVisible(key, visible) {
        _layerVisible[key] = visible;
        if (key === 'buildings' || key === 'vegetation') {
            _applyFeatureVisibility();
        } else if (key === 'viewshed' && _viewshedLayer) {
            _viewshedLayer.eachLayer(l => l.setStyle({
                opacity: visible ? 1 : 0,
                fillOpacity: visible ? 0.18 : 0,
            }));
        }
    }

    function _initLayerToggles() {
        [
            ['los-toggle-buildings',  'buildings'],
            ['los-toggle-vegetation', 'vegetation'],
            ['los-toggle-viewshed',   'viewshed'],
        ].forEach(([btnId, key]) => {
            const btn = el(btnId);
            if (!btn) return;
            btn.addEventListener('click', () => {
                const next = !_layerVisible[key];
                _setLayerVisible(key, next);
                btn.classList.toggle('los-layer-btn--active', next);
            });
        });
    }

    // ── Controls collapse toggle ──────────────────────────────────────────────
    function _toggleControls() {
        _ctrlsCollapsed = !_ctrlsCollapsed;
        const topPane = el('los-top-pane');
        const btn     = el('los-panel-collapse');
        if (topPane) topPane.style.display = _ctrlsCollapsed ? 'none' : '';
        if (btn) {
            btn.textContent = _ctrlsCollapsed ? '▼' : '▲';
            btn.title = _ctrlsCollapsed ? 'Show controls' : 'Hide controls';
        }
    }

    async function _compute(e) {
        if (e) e.preventDefault();
        try {
            await _computeObservers(null, { silent: false });
        } catch (err) {
            alert('Compute error: ' + err.message);
        }
    }

    // ── Open / close ──────────────────────────────────────────────────────────
    function losOpen() {
        const panel = el('los-panel');
        if (!panel) return;
        if (!_panelDragged) {
            panel.style.transform = 'translate(-50%, -50%)';
            panel.style.left = '50%';
            panel.style.top  = '50%';
        }
        panel.classList.add('los-panel--open');
        // Attach layers to main map and load initial features
        if (_ensureLayers()) {
            _loadFeatures();
        }
    }

    function losClose() {
        const panel = el('los-panel');
        if (panel) panel.classList.remove('los-panel--open');
        _stopPicking();
        _clearSampleMarkers();
        _clearSampleLine();
        _setState('idle');
    }

    // ── Init ──────────────────────────────────────────────────────────────────
    function losInit() {
        _initPanelDrag();
        _initSectionResize();
        _initLayerToggles();

        el('los-open-btn')?.addEventListener('click', losOpen);
        el('los-panel-close')?.addEventListener('click', losClose);
        el('los-panel-collapse')?.addEventListener('click', _toggleControls);

        const obsAglInput = el('los-obs-agl');
        if (obsAglInput) {
            obsAglInput.addEventListener('input', () => {
                const selected = _getSelectedObserver();
                if (selected) {
                    selected.height_agl_m = parseFloat(obsAglInput.value) || 25;
                    _renderObserverList();
                }
            });
        }

        el('los-btn-sample')?.addEventListener('click', () => {
            _clearSampleLine();
            _setState('picking_sample');
            _startPicking('picking_sample');
        });
        el('los-btn-sample-line')?.addEventListener('click', () => {
            _clearSampleLine();
            _setState('picking_sample_line');
            _startPicking('picking_sample_line');
            const coordEl = el('los-sample-coord');
            const valueEl = el('los-sample-value');
            if (coordEl) coordEl.textContent = '— waiting for first point —';
            if (valueEl) valueEl.textContent = 'Inspect line: click the first point on the map.';
        });
        el('los-btn-clear-observers')?.addEventListener('click', () => {
            _reset();
        });
        el('los-btn-observer')?.addEventListener('click', () => {
            _setState('picking_observer');
            _startPicking('picking_observer');
        });
        el('los-btn-target')?.addEventListener('click', () => {
            _setState('picking_target');
            _startPicking('picking_target');
        });
        
        // Ensure both compute buttons trigger
        const btn1 = el('los-btn-compute');
        if (btn1) btn1.addEventListener('click', _compute);
        const btn2 = el('los-btn-compute-bar');
        if (btn2) btn2.addEventListener('click', _compute);

        el('los-btn-viewshed')?.addEventListener('click', () => {
            const opts = el('los-viewshed-opts');
            if (opts) opts.style.display = opts.style.display === 'none' ? '' : 'none';
            _computeViewshed();
        });
        el('los-btn-clear-viewshed')?.addEventListener('click', _clearViewshed);

        document.addEventListener('keydown', e => {
            if (e.key === 'Escape') {
                if (_state === 'picking_observer' || _state === 'picking_target' || _state === 'picking_sample' || _state === 'picking_sample_line') {
                    _stopPicking();
                    _clearSampleLine();
                    _setState('idle');
                } else {
                    losClose();
                }
            }
        });

        _renderObserverList();
        _renderSelectedObserverResult();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', losInit);
    } else {
        losInit();
    }

    /**
     * Hand-off from Pilot Pollution Analyzer: populate LOS Simulator
     * with pollutant cells as observers and the DT point as target.
     */
    function losPollutionHandoff(pollutants, target) {
        if (!pollutants || !target) return;
        try {
            // Remove existing observer markers
            _observers.forEach(obs => {
                if (obs.marker) obs.marker.remove();
                if (obs.lineLayer) obs.lineLayer.remove();
                if (obs.blockerLayer) obs.blockerLayer.remove();
            });
            _observers.length = 0;
            _observerSeq = 0;

            // Add each pollutant cell as an observer (matching _createObserver structure)
            pollutants.forEach((p, idx) => {
                if (!p.cellLat || !p.cellLng) return;
                _observers.push({
                    id: `poll_${Date.now()}_${idx}`,
                    label: p.name || `SC=${p.sc}`,
                    lon: p.cellLng,
                    lat: p.cellLat,
                    height_agl_m: p.cellHeight || 30,
                    color: _observerColors[idx % _observerColors.length],
                    result: null,
                    marker: null,
                    lineLayer: null,
                    blockerLayer: null
                });
                _observerSeq++;
            });

            // Set the target to the DT measurement point
            _target = {
                lat: target.lat,
                lon: target.lng
            };

            // Select first observer
            _selectedObserverId = _observers.length ? _observers[0].id : null;

            // Refresh the UI
            _renderObserverList();
            _refreshObserverMarkers();

            // Trigger compute if we have valid observers
            if (_observers.length > 0) {
                _queueComputeLos(_observers.map(obs => obs.id));
            }
        } catch (e) {
            console.warn('[LOS UI] Handoff error:', e);
        }
    }

    window.losOpen  = losOpen;
    window.losClose = losClose;
    window.losReset = _reset;
    window.losPollutionHandoff = losPollutionHandoff;
})();

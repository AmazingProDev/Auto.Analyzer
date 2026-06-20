/**
 * los_obstacles.js — custom obstacle drawing, management, and persistence for the LOS panel.
 * Operates on the main Leaflet map (window.mapRenderer.map).
 */
(function () {
    'use strict';

    const STORAGE_KEY = 'los_custom_obstacles';
    const TYPE_COLOR  = { building: '#f97316', vegetation: '#22c55e' };

    // ── State ────────────────────────────────────────────────────────────────
    let _obstacles  = [];   // [{ id, name, type, height_agl_m, geojson_wgs84 }]
    let _layers     = {};   // id → L.polygon on main map

    // Drawing state
    let _drawing        = false;
    let _vertices       = [];   // [L.LatLng, ...]
    let _drawPolyline   = null; // L.polyline preview
    let _drawMarkers    = [];   // L.circleMarker vertex dots
    let _drawClickFn    = null;
    let _drawDblClickFn = null;

    // ── Main map accessor ────────────────────────────────────────────────────
    function _getMap() {
        return window.mapRenderer && window.mapRenderer.map;
    }

    function _ensurePane() {
        const map = _getMap();
        if (!map) return false;
        if (!map.getPane('losPane')) {
            map.createPane('losPane');
            map.getPane('losPane').style.zIndex = '620';
            map.getPane('losPane').style.pointerEvents = 'none';
        }
        return true;
    }

    // ── Persistence ──────────────────────────────────────────────────────────
    function _save() {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(_obstacles)); } catch (_) {}
    }

    function _load() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (raw) {
                _obstacles = JSON.parse(raw);
                _obstacles.forEach(o => _addMapLayer(o));
            }
        } catch (_) {}
        _renderList();
    }

    // ── Map layer management ─────────────────────────────────────────────────
    function _addMapLayer(obs) {
        if (!_ensurePane()) return;
        const map = _getMap();
        if (!map) return;
        const latLngs = obs.geojson_wgs84.coordinates[0].map(([lng, lat]) => [lat, lng]);
        const poly = L.polygon(latLngs, {
            pane:        'losPane',
            color:       TYPE_COLOR[obs.type] || '#60a5fa',
            weight:      2,
            fillOpacity: 0.28,
            dashArray:   '5 3',
        }).addTo(map);
        poly.bindTooltip(
            `<b>${obs.name}</b><br>${obs.type} &bull; ${obs.height_agl_m} m AGL`,
            { sticky: true, className: 'los-obs-tooltip' }
        );
        _layers[obs.id] = poly;
    }

    function _removeMapLayer(id) {
        if (_layers[id]) { _layers[id].remove(); delete _layers[id]; }
    }

    // ── Drawing ──────────────────────────────────────────────────────────────
    function _startDraw() {
        if (_drawing) { _stopDraw(false); return; }
        const map = _getMap();
        if (!map) return;

        _drawing  = true;
        _vertices = [];
        _drawPolyline = L.polyline([], { color: '#60a5fa', weight: 2, dashArray: '5 3' }).addTo(map);
        map.getContainer().style.cursor = 'crosshair';

        _drawClickFn = e => {
            _vertices.push(e.latlng);
            const dot = L.circleMarker(e.latlng, {
                radius: 4, color: '#60a5fa', fillColor: '#fff', fillOpacity: 1, weight: 2,
            }).addTo(map);
            _drawMarkers.push(dot);
            _drawPolyline.setLatLngs([..._vertices, _vertices[0]]);
        };

        _drawDblClickFn = e => {
            e.originalEvent && e.originalEvent.preventDefault();
            if (_vertices.length >= 3) _stopDraw(true);
            else _stopDraw(false);
        };

        map.on('click',    _drawClickFn);
        map.on('dblclick', _drawDblClickFn);
        _setDrawActive(true);
        _setInstructions('Click to add vertices — double-click to finish.');
    }

    function _stopDraw(finish) {
        const map = _getMap();
        _drawing = false;
        if (_drawPolyline) { _drawPolyline.remove(); _drawPolyline = null; }
        _drawMarkers.forEach(m => m.remove());
        _drawMarkers = [];
        if (map) {
            map.off('click',    _drawClickFn);
            map.off('dblclick', _drawDblClickFn);
            map.getContainer().style.cursor = '';
        }
        _drawClickFn = _drawDblClickFn = null;
        _setDrawActive(false);
        _setInstructions('');

        if (finish) {
            _showForm(_vertices.slice());
        }
        _vertices = [];
    }

    function _setDrawActive(on) {
        const btn = document.getElementById('los-obs-draw-btn');
        if (btn) btn.classList.toggle('los-layer-btn--active', on);
    }

    function _setInstructions(text) {
        const el = document.getElementById('los-obs-instructions');
        if (el) el.textContent = text;
    }

    // ── Property form ────────────────────────────────────────────────────────
    let _pendingVertices = null;

    function _showForm(vertices) {
        _pendingVertices = vertices;
        const form = document.getElementById('los-obs-form');
        if (!form) return;
        document.getElementById('los-obs-form-name').value   = '';
        document.getElementById('los-obs-form-height').value = '10';
        document.getElementById('los-obs-form-type').value   = 'building';
        form.style.display = '';
        document.getElementById('los-obs-form-name').focus();
    }

    function _confirmForm() {
        if (!_pendingVertices) return;
        const name      = document.getElementById('los-obs-form-name').value.trim() || 'Obstacle';
        const type      = document.getElementById('los-obs-form-type').value;
        const heightAgl = parseFloat(document.getElementById('los-obs-form-height').value) || 5;

        // Build closed GeoJSON ring [lon, lat]
        const ring = _pendingVertices.map(ll => [ll.lng, ll.lat]);
        ring.push(ring[0]);

        const obs = {
            id:            Date.now() + Math.random(),
            name,
            type,
            height_agl_m:  heightAgl,
            geojson_wgs84: { type: 'Polygon', coordinates: [ring] },
        };
        _obstacles.push(obs);
        _addMapLayer(obs);
        _save();
        _renderList();
        _cancelForm();
    }

    function _cancelForm() {
        _pendingVertices = null;
        const form = document.getElementById('los-obs-form');
        if (form) form.style.display = 'none';
    }

    // ── Obstacle list ────────────────────────────────────────────────────────
    function _renderList() {
        const list = document.getElementById('los-obs-list');
        if (!list) return;
        if (_obstacles.length === 0) {
            list.innerHTML = '<div class="los-obs-empty">No custom obstacles. Click Draw to add one.</div>';
            return;
        }
        list.innerHTML = _obstacles.map(obs => `
            <div class="los-obs-item">
              <span class="los-obs-dot" style="background:${TYPE_COLOR[obs.type] || '#60a5fa'}"></span>
              <span class="los-obs-name">${obs.name}</span>
              <span class="los-obs-meta">${obs.type[0].toUpperCase() + obs.type.slice(1)} &bull; ${obs.height_agl_m}m</span>
              <button class="los-obs-del" data-id="${obs.id}" title="Delete">✕</button>
            </div>`).join('');
        list.querySelectorAll('.los-obs-del').forEach(btn => {
            btn.addEventListener('click', () => {
                const id = parseFloat(btn.dataset.id);
                _removeMapLayer(id);
                _obstacles = _obstacles.filter(o => o.id !== id);
                _save();
                _renderList();
            });
        });
    }

    // ── Export / Import ──────────────────────────────────────────────────────
    function _export() {
        if (_obstacles.length === 0) { alert('No custom obstacles to export.'); return; }
        const fc = {
            type: 'FeatureCollection',
            features: _obstacles.map(obs => ({
                type:     'Feature',
                geometry: obs.geojson_wgs84,
                properties: {
                    name:          obs.name,
                    obstacle_type: obs.type,
                    height_agl_m:  obs.height_agl_m,
                },
            })),
        };
        const blob = new Blob([JSON.stringify(fc, null, 2)], { type: 'application/json' });
        const url  = URL.createObjectURL(blob);
        const a    = Object.assign(document.createElement('a'), { href: url, download: 'los_obstacles.geojson' });
        a.click();
        URL.revokeObjectURL(url);
    }

    function _import() {
        const input = Object.assign(document.createElement('input'), { type: 'file', accept: '.geojson,.json' });
        input.onchange = e => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = ev => {
                try {
                    const fc = JSON.parse(ev.target.result);
                    let count = 0;
                    (fc.features || []).forEach(f => {
                        if (!f.geometry || f.geometry.type !== 'Polygon') return;
                        const props = f.properties || {};
                        const obs = {
                            id:            Date.now() + Math.random(),
                            name:          props.name || 'Imported',
                            type:          props.obstacle_type || 'building',
                            height_agl_m:  parseFloat(props.height_agl_m) || 5,
                            geojson_wgs84: f.geometry,
                        };
                        _obstacles.push(obs);
                        _addMapLayer(obs);
                        count++;
                    });
                    _save();
                    _renderList();
                    if (count === 0) alert('No valid Polygon features found in file.');
                } catch (_) {
                    alert('Could not read file — make sure it is valid GeoJSON.');
                }
            };
            reader.readAsText(file);
        };
        input.click();
    }

    // ── Public API ───────────────────────────────────────────────────────────
    window.losObstaclesGetAll = () => _obstacles;

    // ── Init ─────────────────────────────────────────────────────────────────
    function init() {
        const drawBtn    = document.getElementById('los-obs-draw-btn');
        const exportBtn  = document.getElementById('los-obs-export-btn');
        const importBtn  = document.getElementById('los-obs-import-btn');
        const confirmBtn = document.getElementById('los-obs-form-confirm');
        const cancelBtn  = document.getElementById('los-obs-form-cancel');

        if (drawBtn)    drawBtn.addEventListener('click', _startDraw);
        if (exportBtn)  exportBtn.addEventListener('click', _export);
        if (importBtn)  importBtn.addEventListener('click', _import);
        if (confirmBtn) confirmBtn.addEventListener('click', _confirmForm);
        if (cancelBtn)  cancelBtn.addEventListener('click', _cancelForm);

        // Cancel drawing on Escape
        document.addEventListener('keydown', e => {
            if (e.key === 'Escape' && _drawing) _stopDraw(false);
            if (e.key === 'Escape' && _pendingVertices) _cancelForm();
        });

        _load();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();

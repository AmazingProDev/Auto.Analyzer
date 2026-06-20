/**
 * los_pollution.js — LOS-enhanced Pilot Pollution Analysis Module
 *
 * Tech-agnostic enrichment layer that classifies polluting neighbor cells
 * as LOS / NLOS-over-propagating / NLOS using the LOS backend API (port 8001).
 *
 * Exports: window.losEnrichNeighbors(pollutants, dtPoint, opts) → Promise
 *          window.losPollutionAvailable() → Promise<boolean>
 */
(function () {
    'use strict';

    // ─── Session cache ───────────────────────────────────────────────────
    if (!window.__losPollutionCache) {
        window.__losPollutionCache = new Map();
    }
    const _cache = window.__losPollutionCache;

    function _cacheKey(cellId, lat, lng) {
        return `${cellId}|${lat.toFixed(5)}|${lng.toFixed(5)}`;
    }

    // ─── Concurrency limiter ─────────────────────────────────────────────
    const MAX_CONCURRENT = 6;
    let _inflight = 0;
    const _queue = [];

    function _enqueue(fn) {
        return new Promise((resolve, reject) => {
            _queue.push({ fn, resolve, reject });
            _drain();
        });
    }

    function _drain() {
        while (_inflight < MAX_CONCURRENT && _queue.length > 0) {
            const { fn, resolve, reject } = _queue.shift();
            _inflight++;
            fn().then(resolve, reject).finally(() => {
                _inflight--;
                _drain();
            });
        }
    }

    // ─── Pre-flight check (once per session) ─────────────────────────────
    let _layersChecked = false;
    let _layersAvailable = false;
    let _layersPromise = null;

    async function _checkLayers() {
        if (_layersChecked) return _layersAvailable;
        if (_layersPromise) return _layersPromise;

        _layersPromise = (async () => {
            try {
                if (!window.losGetLayers) {
                    _layersChecked = true;
                    _layersAvailable = false;
                    return false;
                }
                const resp = await window.losGetLayers();
                // Backend returns { layers: [ { id, available, ... }, ... ] }
                const layerList = resp && resp.layers ? resp.layers : (Array.isArray(resp) ? resp : []);
                const dtmLayer = layerList.find(l => l.id === 'dtm');
                const hasDtm = dtmLayer && dtmLayer.available;
                _layersChecked = true;
                _layersAvailable = !!hasDtm;
                return _layersAvailable;
            } catch (e) {
                console.warn('[LOS Pollution] Backend pre-flight failed:', e.message);
                _layersChecked = true;
                _layersAvailable = false;
                return false;
            }
        })();

        return _layersPromise;
    }

    /**
     * Check if LOS pollution analysis is available (backend up + data loaded)
     */
    async function losPollutionAvailable() {
        return _checkLayers();
    }

    // ─── Single cell LOS computation ─────────────────────────────────────
    async function _computeCellLos(cell, dtPoint, opts) {
        const TIMEOUT_MS = opts.timeoutMs || 4000;

        const observer = {
            lon: cell.cellLng,
            lat: cell.cellLat,
            height_agl_m: cell.cellHeight || 30
        };
        const target = {
            lon: dtPoint.lng,
            lat: dtPoint.lat,
            height_agl_m: 1.5
        };
        const options = {
            include_terrain: true,
            include_clutter_height: true,
            include_buildings: true,
            include_vegetation: true,
            sample_spacing_m: 2
        };
        if (opts.frequencyMhz) {
            options.frequency_mhz = opts.frequencyMhz;
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

        try {
            // Use the existing losComputeLos but with our own abort
            const base = window.LOS_BASE || 'http://localhost:8001';
            const res = await fetch(`${base}/api/los`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ observer, target, options }),
                signal: controller.signal
            });
            clearTimeout(timer);

            if (!res.ok) {
                throw new Error(`LOS API ${res.status}`);
            }
            return await res.json();
        } catch (e) {
            clearTimeout(timer);
            if (e.name === 'AbortError') {
                throw new Error('Timeout');
            }
            throw e;
        }
    }

    // ─── Classification logic ────────────────────────────────────────────
    function _classify(losResult, cell, servingRscp) {
        if (!losResult) {
            return { verdict: 'unknown', pill: 'unknown', reason: null, clearance: null };
        }

        const visible = losResult.visible;
        const delta = (cell.rscp !== null && servingRscp !== null)
            ? cell.rscp - servingRscp
            : null;

        if (visible) {
            return {
                verdict: 'los',
                pill: 'los',
                reason: null,
                clearance: null,
                delta
            };
        }

        // NLOS — check if over-propagating
        const clearance = losResult.clearance_m ?? losResult.min_clearance_m ?? null;
        const reason = losResult.reason || losResult.blocker_type || null;

        if (delta !== null && delta >= 0) {
            // Stronger than serving AND blocked → over-propagating
            return {
                verdict: 'nlos_over',
                pill: 'nlos-over',
                reason,
                clearance,
                delta
            };
        } else if (delta !== null && delta >= -5) {
            // Within pollution threshold AND blocked → still over-propagating (mild)
            return {
                verdict: 'nlos_over',
                pill: 'nlos-over',
                reason,
                clearance,
                delta
            };
        } else {
            // Weak and blocked → normal NLOS, not a pollutant
            return {
                verdict: 'nlos',
                pill: 'nlos',
                reason,
                clearance,
                delta
            };
        }
    }

    // ─── Recommendation generation ───────────────────────────────────────
    function _generateRecommendation(classification, cell, servingRscp, lang) {
        const isEn = (lang || 'EN').toUpperCase() !== 'FR';
        const name = cell.name || cell.cellId || `SC=${cell.sc}`;
        const delta = classification.delta;
        const clr = classification.clearance !== null
            ? classification.clearance.toFixed(1)
            : '?';
        const reason = classification.reason || 'obstruction';

        switch (classification.verdict) {
            case 'los':
                if (delta !== null && delta >= 0) {
                    return isEn
                        ? `Cell <b>${name}</b> is in clean LOS and stronger than serving (+${delta.toFixed(1)} dB) — re-allocate PSC or swap serving.`
                        : `Cellule <b>${name}</b> en LOS directe, plus forte que servante (+${delta.toFixed(1)} dB) — réallouer PSC ou permuter servante.`;
                }
                return isEn
                    ? `LOS contributor <b>${name}</b> adds to pilot pollution (Δ${delta !== null ? delta.toFixed(1) : '?'} dB) — reduce TX by 1–2 dB or down-tilt 1°.`
                    : `Contributeur LOS <b>${name}</b> ajoute à la pollution pilote (Δ${delta !== null ? delta.toFixed(1) : '?'} dB) — réduire TX 1–2 dB ou incliner 1°.`;

            case 'nlos_over':
                if (delta !== null && delta >= 0) {
                    const reducDb = Math.round(delta + 3);
                    const tilt = Math.max(1, Math.round(delta / 4));
                    return isEn
                        ? `Cell <b>${name}</b> over-propagates via NLOS (${reason}, clearance ${clr} m). Reduce ${reducDb} dB or down-tilt ${tilt}°.`
                        : `Cellule <b>${name}</b> sur-propage en NLOS (${reason}, dégagement ${clr} m). Réduire ${reducDb} dB ou incliner ${tilt}°.`;
                }
                return isEn
                    ? `Cell <b>${name}</b> leaks via diffraction (clearance ${clr} m) — down-tilt 1°.`
                    : `Cellule <b>${name}</b> fuite par diffraction (dégagement ${clr} m) — incliner 1°.`;

            case 'nlos':
                // Suppress — already weak and blocked
                return null;

            default:
                return null;
        }
    }

    // ─── DOM patching ────────────────────────────────────────────────────
    function _patchTableRow(cellId, classification) {
        const cell = document.querySelector(`.los-cell[data-cell-id="${CSS.escape(cellId)}"]`);
        if (!cell) return;

        const { verdict, pill, clearance, reason } = classification;
        let label, tooltip;

        switch (verdict) {
            case 'los':
                label = 'LOS';
                tooltip = 'Line-of-Sight path clear';
                break;
            case 'nlos_over':
                label = 'NLOS over';
                tooltip = `Blocked by ${reason || 'obstruction'}` +
                    (clearance !== null ? ` (clearance ${clearance.toFixed(1)} m)` : '');
                break;
            case 'nlos':
                label = 'NLOS';
                tooltip = 'No Line-of-Sight — signal blocked';
                break;
            default:
                label = '—';
                tooltip = 'LOS analysis unavailable';
        }

        cell.innerHTML = `<span class="los-pill los-pill--${pill}" title="${tooltip}">${label}</span>`;
    }

    function _patchRecommendations(recommendations, lang) {
        const container = document.getElementById('dt-los-recs');
        if (!container) return;

        const isEn = (lang || 'EN').toUpperCase() !== 'FR';
        const validRecs = recommendations.filter(r => r !== null);

        if (validRecs.length === 0) {
            container.style.display = 'none';
            return;
        }

        container.style.display = '';
        container.innerHTML = `
            <div class="los-recs-title">${isEn ? 'LOS-Enhanced Recommendations' : 'Recommandations LOS'}</div>
            ${validRecs.map(r => `<div class="los-rec-item">• ${r}</div>`).join('')}
        `;
    }

    function _showBanner(type) {
        const container = document.getElementById('dt-los-recs');
        if (!container) return;

        container.style.display = '';
        if (type === 'offline') {
            container.innerHTML = `
                <div class="los-pollution-banner los-pollution-banner--offline">
                    <span class="banner-icon">⚠️</span>
                    <span>LOS analysis unavailable — start the LOS backend (port 8001)</span>
                </div>`;
        } else if (type === 'nodata') {
            container.innerHTML = `
                <div class="los-pollution-banner los-pollution-banner--nodata">
                    <span class="banner-icon">ℹ️</span>
                    <span>Activate ATOLL geodata to enable LOS classification</span>
                </div>`;
        }
    }

    // ─── Main enrichment function ────────────────────────────────────────
    /**
     * Enrich pollutant neighbors with LOS classification.
     *
     * @param {Array} pollutants - Array of { cellId, name, sc, freq, rscp, ecno, cellLat, cellLng, cellHeight, type }
     * @param {Object} dtPoint - { lat, lng } of the drive-test measurement point
     * @param {Object} opts - { servingRscp, lang, frequencyMhz, timeoutMs, threshold }
     * @returns {Promise<Object>} - { results: Map<cellId, classification>, recommendations: string[] }
     */
    async function losEnrichNeighbors(pollutants, dtPoint, opts = {}) {
        const { servingRscp, lang, frequencyMhz, timeoutMs } = opts;

        // Guard: check if LOS API is available
        if (!window.losComputeLos) {
            _showBanner('offline');
            return { results: new Map(), recommendations: [] };
        }

        // Pre-flight layer check
        let layersOk = false;
        try {
            layersOk = await _checkLayers();
        } catch (e) {
            // Network error → backend offline
        }
        if (!layersOk) {
            // If pre-flight failed due to network = offline; if responded but no DTM = nodata
            const bannerType = _layersChecked ? 'nodata' : 'offline';
            _showBanner(bannerType);
            // Hide LOS column shimmers
            document.querySelectorAll('.los-cell').forEach(el => {
                el.innerHTML = '<span class="los-pill los-pill--unknown" title="LOS unavailable">—</span>';
            });
            return { results: new Map(), recommendations: [] };
        }

        // Filter to only pollutants with valid coordinates
        const validPollutants = pollutants.filter(p =>
            p.cellLat != null && p.cellLng != null &&
            Number.isFinite(p.cellLat) && Number.isFinite(p.cellLng)
        );

        // Mark cells without coords
        pollutants.forEach(p => {
            if (!p.cellLat || !p.cellLng || !Number.isFinite(p.cellLat) || !Number.isFinite(p.cellLng)) {
                const cellId = p.cellId || `${p.sc || 'x'}_${p.freq || 'x'}`;
                _patchTableRow(cellId, { verdict: 'unknown', pill: 'unknown', clearance: null, reason: null });
            }
        });

        const results = new Map();
        const recommendations = [];

        // Compute LOS for each valid pollutant with concurrency limiting
        const promises = validPollutants.map(cell => {
            const cellId = cell.cellId || `${cell.sc || 'x'}_${cell.freq || 'x'}`;
            const key = _cacheKey(cellId, dtPoint.lat, dtPoint.lng);

            // Check cache first
            if (_cache.has(key)) {
                const cached = _cache.get(key);
                results.set(cellId, cached);
                _patchTableRow(cellId, cached);
                const rec = _generateRecommendation(cached, cell, servingRscp, lang);
                if (rec) recommendations.push(rec);
                return Promise.resolve();
            }

            // Enqueue LOS computation
            return _enqueue(async () => {
                try {
                    const losResult = await _computeCellLos(cell, dtPoint, {
                        frequencyMhz,
                        timeoutMs
                    });
                    const classification = _classify(losResult, cell, servingRscp);
                    _cache.set(key, classification);
                    results.set(cellId, classification);
                    _patchTableRow(cellId, classification);
                    const rec = _generateRecommendation(classification, cell, servingRscp, lang);
                    if (rec) recommendations.push(rec);
                } catch (e) {
                    console.warn(`[LOS Pollution] Failed for ${cellId}:`, e.message);
                    const fallback = { verdict: 'unknown', pill: 'unknown', reason: null, clearance: null, delta: null };
                    results.set(cellId, fallback);
                    _patchTableRow(cellId, fallback);
                }
            });
        });

        await Promise.all(promises);

        // Patch recommendations section
        _patchRecommendations(recommendations, lang);

        return { results, recommendations };
    }

    // ─── Reset cache (useful for testing) ────────────────────────────────
    function losPollutionClearCache() {
        _cache.clear();
        _layersChecked = false;
        _layersAvailable = false;
        _layersPromise = null;
    }

    // ─── Exports ─────────────────────────────────────────────────────────
    window.losEnrichNeighbors = losEnrichNeighbors;
    window.losPollutionAvailable = losPollutionAvailable;
    window.losPollutionClearCache = losPollutionClearCache;

})();

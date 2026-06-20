/**
 * los_api.js — HTTP client for the LOS FastAPI backend (port 8001).
 */
function resolveLosBase() {
    if (window.LOS_BASE_OVERRIDE) return String(window.LOS_BASE_OVERRIDE).replace(/\/+$/, '');
    const protocol = window.location && window.location.protocol ? window.location.protocol : 'http:';
    const hostname = window.location && window.location.hostname ? window.location.hostname : 'localhost';
    return `${protocol}//${hostname}:8001`;
}

const LOS_BASE = resolveLosBase();

async function losComputeLos(observer, target, options = {}) {
    const res = await fetch(`${LOS_BASE}/api/los`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ observer, target, options }),
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: res.statusText }));
        throw new Error(err.detail || `LOS API error ${res.status}`);
    }
    return res.json();
}

async function losGetProfile(obsLon, obsLat, tgtLon, tgtLat, spacingM = 2, includeClutterHeight = true) {
    const url = new URL(`${LOS_BASE}/api/los/profile`);
    url.searchParams.set('obs_lon', obsLon);
    url.searchParams.set('obs_lat', obsLat);
    url.searchParams.set('tgt_lon', tgtLon);
    url.searchParams.set('tgt_lat', tgtLat);
    url.searchParams.set('spacing_m', spacingM);
    url.searchParams.set('include_clutter_height', includeClutterHeight ? 'true' : 'false');
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Profile API error ${res.status}`);
    return res.json();
}

async function losGetLayers() {
    const res = await fetch(`${LOS_BASE}/api/los/layers`);
    if (!res.ok) throw new Error(`Layers API error ${res.status}`);
    return res.json();
}

async function losComputeViewshed(observer, options = {}) {
    const res = await fetch(`${LOS_BASE}/api/los/viewshed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ observer, ...options }),
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: res.statusText }));
        throw new Error(err.detail || `Viewshed API error ${res.status}`);
    }
    return res.json();
}

async function losSamplePoint(lon, lat) {
    const url = new URL(`${LOS_BASE}/api/los/sample`);
    url.searchParams.set('lon', lon);
    url.searchParams.set('lat', lat);
    const res = await fetch(url);
    if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: res.statusText }));
        throw new Error(err.detail || `Sample API error ${res.status}`);
    }
    return res.json();
}

window.losComputeLos      = losComputeLos;
window.losGetProfile      = losGetProfile;
window.losGetLayers       = losGetLayers;
window.losComputeViewshed = losComputeViewshed;
window.losSamplePoint     = losSamplePoint;
window.LOS_BASE           = LOS_BASE;
window.LOS_TILE_URL       = `${LOS_BASE}/tiles/ortho/{z}/{x}/{y}.png`;

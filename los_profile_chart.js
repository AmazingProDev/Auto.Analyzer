/**
 * los_profile_chart.js
 * Renders the terrain + obstacle elevation profile using Chart.js.
 * Assumes Chart.js is already loaded globally (cdn or local).
 */
(function () {
    let _chart = null;
    let _canvas = null;

    function _ensureCanvas() {
        if (_canvas) return _canvas;
        // Reuse the canvas already in the static HTML if present
        _canvas = document.getElementById('los-profile-canvas');
        if (!_canvas) {
            _canvas = document.createElement('canvas');
            _canvas.id = 'los-profile-canvas';
            _canvas.style.cssText = 'width:100%;height:180px;';
            const wrap = document.getElementById('los-profile-wrap');
            if (wrap) wrap.appendChild(_canvas);
        }
        return _canvas;
    }

    function losRenderProfile(profile, result) {
        if (!profile || !profile.length) return;

        const labels  = profile.map(p => p.distance_m.toFixed(0) + 'm');
        const ground  = profile.map(p => p.ground_m);
        const ray     = profile.map(p => p.ray_m);
        const blocked = !!(result && !result.visible);

        // Split obstacle surface by type
        const surfBld = profile.map(p => p.surface_type === 'building'   ? p.obstacle_surface_m : null);
        const surfVeg = profile.map(p => p.surface_type === 'vegetation'  ? p.obstacle_surface_m : null);
        const surfClt = profile.map(p => (!p.surface_type || p.surface_type === 'clutter') ? p.obstacle_surface_m : null);

        const blockerDist = result && !result.visible ? result.distance_to_blocker_m : null;

        const canvas = _ensureCanvas();
        canvas.style.width  = '100%';
        canvas.style.height = '100%';

        if (_chart) { _chart.destroy(); _chart = null; }

        _chart = new Chart(canvas, {
            type: 'line',
            data: {
                labels,
                datasets: [
                    {
                        label: 'Ground (DTM)',
                        data: ground,
                        borderColor: '#78716c',
                        backgroundColor: 'rgba(120,113,108,0.20)',
                        fill: true,
                        pointRadius: 0,
                        borderWidth: 1,
                        tension: 0.2,
                        order: 4,
                    },
                    {
                        label: 'Clutter/DHM',
                        data: surfClt,
                        borderColor: 'rgba(148,163,184,0.6)',
                        backgroundColor: 'rgba(148,163,184,0.12)',
                        fill: true,
                        spanGaps: false,
                        pointRadius: 0,
                        borderWidth: 1,
                        tension: 0.2,
                        order: 3,
                    },
                    {
                        label: 'Vegetation',
                        data: surfVeg,
                        borderColor: '#22c55e',
                        backgroundColor: 'rgba(34,197,94,0.25)',
                        fill: true,
                        spanGaps: false,
                        pointRadius: 0,
                        borderWidth: 1.5,
                        tension: 0.2,
                        order: 2,
                    },
                    {
                        label: 'Buildings',
                        data: surfBld,
                        borderColor: '#f97316',
                        backgroundColor: 'rgba(249,115,22,0.30)',
                        fill: true,
                        spanGaps: false,
                        pointRadius: 0,
                        borderWidth: 1.5,
                        tension: 0.2,
                        order: 1,
                    },
                    {
                        label: 'LOS ray',
                        data: ray,
                        borderColor: blocked ? '#ef4444' : '#22c55e',
                        backgroundColor: 'transparent',
                        fill: false,
                        pointRadius: 0,
                        borderWidth: 2,
                        tension: 0,
                        order: 0,
                    },
                ],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: { duration: 200 },
                plugins: {
                    legend: { labels: { color: '#e2e8f0', font: { size: 11 } } },
                    tooltip: {
                        mode: 'index',
                        callbacks: {
                            label: ctx => `${ctx.dataset.label}: ${ctx.parsed.y.toFixed(1)} m`,
                        },
                    },
                    annotation: blockerDist ? {
                        annotations: {
                            blocker: {
                                type: 'line',
                                xMin: blockerDist.toFixed(0) + 'm',
                                xMax: blockerDist.toFixed(0) + 'm',
                                borderColor: '#ef4444',
                                borderWidth: 2,
                                borderDash: [4, 4],
                                label: {
                                    display: true,
                                    content: '⚠ Block',
                                    color: '#ef4444',
                                    font: { size: 10 },
                                },
                            },
                        },
                    } : {},
                },
                scales: {
                    x: {
                        ticks: { color: '#94a3b8', maxTicksLimit: 8, font: { size: 10 } },
                        grid:  { color: 'rgba(255,255,255,0.05)' },
                    },
                    y: {
                        ticks: {
                            color: '#94a3b8',
                            font: { size: 10 },
                            callback: v => v.toFixed(0) + ' m',
                        },
                        grid: { color: 'rgba(255,255,255,0.05)' },
                    },
                },
            },
        });
    }

    function losClearProfile() {
        if (_chart) { _chart.destroy(); _chart = null; }
    }

    function losRenderGroundProfile(profile, titleText = 'Terrain Profile') {
        if (!profile || !profile.length) return;

        const labels = profile.map(p => p.distance_m.toFixed(0) + 'm');
        const ground = profile.map(p => p.ground_m);

        const canvas = _ensureCanvas();
        canvas.style.width = '100%';
        canvas.style.height = '100%';

        if (_chart) { _chart.destroy(); _chart = null; }

        _chart = new Chart(canvas, {
            type: 'line',
            data: {
                labels,
                datasets: [
                    {
                        label: titleText,
                        data: ground,
                        borderColor: '#38bdf8',
                        backgroundColor: 'rgba(56,189,248,0.18)',
                        fill: true,
                        pointRadius: 0,
                        borderWidth: 2,
                        tension: 0.18,
                    },
                ],
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: { duration: 180 },
                plugins: {
                    legend: { labels: { color: '#e2e8f0', font: { size: 11 } } },
                    tooltip: {
                        mode: 'index',
                        callbacks: {
                            label: ctx => `${ctx.dataset.label}: ${ctx.parsed.y.toFixed(1)} m`,
                        },
                    },
                },
                scales: {
                    x: {
                        ticks: { color: '#94a3b8', maxTicksLimit: 8, font: { size: 10 } },
                        grid: { color: 'rgba(255,255,255,0.05)' },
                    },
                    y: {
                        ticks: {
                            color: '#94a3b8',
                            font: { size: 10 },
                            callback: v => v.toFixed(0) + ' m',
                        },
                        grid: { color: 'rgba(255,255,255,0.05)' },
                    },
                },
            },
        });
    }

    window.losRenderProfile = losRenderProfile;
    window.losClearProfile  = losClearProfile;
    window.losRenderGroundProfile = losRenderGroundProfile;
})();

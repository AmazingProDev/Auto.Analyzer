(function () {
    function qs(id) { return document.getElementById(id); }
    let trpApiBase = '';
    const TRP_API_BASE_STORAGE_KEY = 'OPTIM_API_BASE_URL';
    const trpSeriesCache = new Map(); // key: "<runId>::<metricName>" => Promise<series[]>

    function normalizeApiBase(raw) {
        const s = String(raw || '').trim();
        if (!s) return '';
        let cleaned = s.replace(/\/+$/, '');
        // Guard against common misconfiguration (base accidentally set to endpoint path).
        cleaned = cleaned.replace(/\/api\/runs$/i, '');
        cleaned = cleaned.replace(/\/api$/i, '');
        return cleaned.replace(/\/+$/, '');
    }

    function readStoredApiBase() {
        try {
            return normalizeApiBase(localStorage.getItem(TRP_API_BASE_STORAGE_KEY) || '');
        } catch (_e) {
            return '';
        }
    }

    function setApiBase(raw) {
        const base = normalizeApiBase(raw);
        trpApiBase = base;
        try {
            if (base) localStorage.setItem(TRP_API_BASE_STORAGE_KEY, base);
            else localStorage.removeItem(TRP_API_BASE_STORAGE_KEY);
        } catch (_e) {}
        return trpApiBase;
    }

    function inferAltApiBases() {
        const out = [];
        try {
            const u = new URL(window.location.href);
            const proto = u.protocol || 'http:';
            const host = u.hostname || '';
            const port = u.port || '';
            const localHost = host === 'localhost' || host === '127.0.0.1';

            if (port === '8001') out.push(`${proto}//${host}:8000`);
            if (localHost) {
                out.push(`${proto}//${host}:8000`);
                if (host !== 'localhost') out.push(`${proto}//localhost:8000`);
                if (host !== '127.0.0.1') out.push(`${proto}//127.0.0.1:8000`);
            }
        } catch (_e) {}

        return Array.from(new Set(out.map(normalizeApiBase).filter(Boolean)));
    }

    function initApiBase() {
        const fromWindow = normalizeApiBase(window.OPTIM_API_BASE_URL || window.API_BASE_URL || '');
        const fromStorage = readStoredApiBase();
        trpApiBase = fromWindow || fromStorage || '';
    }

    const trpState = {
        runId: null,
        runDetail: null,
        catalog: null,
        sidebarTab: 'kpis',
        selectedMetric: null,
        selectedEventName: null,
        eventRows: []
    };

    const TRP_NEIGHBOR_WINDOW_STORAGE_KEY = 'OPTIM_TRP_NEIGHBOR_WINDOW_MS';
    const TRP_NEIGHBOR_ALIGN_STORAGE_KEY = 'OPTIM_TRP_NEIGHBOR_ALIGN_MS';
    const TRP_NEIGHBOR_WINDOW_DEFAULT_MS = 1000;
    const TRP_NEIGHBOR_ALIGN_DEFAULT_MS = 300;
    const TRP_NEIGHBOR_WINDOW_MIN_MS = 100;
    const TRP_NEIGHBOR_WINDOW_MAX_MS = 10000;
    const TRP_NEIGHBOR_ALIGN_MIN_MS = 20;
    const TRP_NEIGHBOR_ALIGN_MAX_MS = 2000;
    let trpNeighborConfigBusy = false;

    function clampIntInRange(raw, fallback, min, max) {
        const n = Number(raw);
        if (!Number.isFinite(n)) return fallback;
        const v = Math.round(n);
        return Math.min(max, Math.max(min, v));
    }

    function getNeighborWindowConfig() {
        let windowMs = TRP_NEIGHBOR_WINDOW_DEFAULT_MS;
        let alignMs = TRP_NEIGHBOR_ALIGN_DEFAULT_MS;
        try {
            const w = localStorage.getItem(TRP_NEIGHBOR_WINDOW_STORAGE_KEY);
            const a = localStorage.getItem(TRP_NEIGHBOR_ALIGN_STORAGE_KEY);
            windowMs = clampIntInRange(w, TRP_NEIGHBOR_WINDOW_DEFAULT_MS, TRP_NEIGHBOR_WINDOW_MIN_MS, TRP_NEIGHBOR_WINDOW_MAX_MS);
            alignMs = clampIntInRange(a, TRP_NEIGHBOR_ALIGN_DEFAULT_MS, TRP_NEIGHBOR_ALIGN_MIN_MS, TRP_NEIGHBOR_ALIGN_MAX_MS);
        } catch (_e) {}
        return { windowMs, alignMs };
    }

    function setNeighborWindowConfig(windowMs, alignMs) {
        const w = clampIntInRange(windowMs, TRP_NEIGHBOR_WINDOW_DEFAULT_MS, TRP_NEIGHBOR_WINDOW_MIN_MS, TRP_NEIGHBOR_WINDOW_MAX_MS);
        const a = clampIntInRange(alignMs, TRP_NEIGHBOR_ALIGN_DEFAULT_MS, TRP_NEIGHBOR_ALIGN_MIN_MS, TRP_NEIGHBOR_ALIGN_MAX_MS);
        try {
            localStorage.setItem(TRP_NEIGHBOR_WINDOW_STORAGE_KEY, String(w));
            localStorage.setItem(TRP_NEIGHBOR_ALIGN_STORAGE_KEY, String(a));
        } catch (_e) {}
        return { windowMs: w, alignMs: a };
    }

    function setNeighborConfigStatus(text, isError) {
        const el = qs('trpNeighborCfgStatus');
        if (!el) return;
        el.textContent = String(text || '');
        el.style.color = isError ? '#fca5a5' : '#93c5fd';
    }

    function syncNeighborConfigUi() {
        const cfg = getNeighborWindowConfig();
        const w = qs('trpNeighborWindowMs');
        const a = qs('trpNeighborAlignMs');
        if (w) w.value = String(cfg.windowMs);
        if (a) a.value = String(cfg.alignMs);
        setNeighborConfigStatus('Current: window +/-' + cfg.windowMs + ' ms, align +/-' + cfg.alignMs + ' ms');
        return cfg;
    }

    async function rebuildNeighborContextForLoadedRuns() {
        const logs = Array.isArray(window.loadedLogs) ? window.loadedLogs : [];
        const lteTrpLogs = logs.filter(log =>
            log &&
            log.trpRunId &&
            Array.isArray(log.points) &&
            log.points.length > 0 &&
            String(log.tech || '').toUpperCase().includes('LTE')
        );
        if (!lteTrpLogs.length) return { runs: 0, points: 0 };

        const cfg = getNeighborWindowConfig();
        let runs = 0;
        let points = 0;

        for (const log of lteTrpLogs) {
            let neighborMetrics = Array.isArray(log.trpNeighborMetrics) ? log.trpNeighborMetrics : [];
            if (!neighborMetrics.length) {
                try {
                    const sidebar = await fetchRunSidebar(log.trpRunId);
                    neighborMetrics = Array.isArray(sidebar && sidebar.neighbors) ? sidebar.neighbors : [];
                    if (neighborMetrics.length) log.trpNeighborMetrics = neighborMetrics;
                } catch (_e) {
                    neighborMetrics = [];
                }
            }
            let servingEarfcnSet = Array.isArray(log.trpServingEarfcnSet) ? log.trpServingEarfcnSet : [];
            if (!servingEarfcnSet.length) {
                try {
                    servingEarfcnSet = await fetchServingEarfcnSet(log.trpRunId, log.trpAllMetricNames || log.customMetrics || []);
                    if (servingEarfcnSet.length) log.trpServingEarfcnSet = servingEarfcnSet.slice();
                } catch (_e) {
                    servingEarfcnSet = [];
                }
            }
            await hydrateLteNeighborWindowContext(log.points, log.trpRunId, neighborMetrics, {
                ...cfg,
                servingEarfcnSet
            });
            runs += 1;
            points += log.points.length;
        }
        return { runs, points };
    }

    async function fetchServingEarfcnSet(runId, metricNames) {
        const candidates = (metricNames || []).filter((name) => {
            const n = String(name || '').toLowerCase();
            return n.includes('radio.lte.servingcell') && n.includes('earfcn') && !n.includes('neighbor');
        });
        if (!candidates.length) return [];
        const name = candidates[0];
        try {
            const rows = await fetchSeries(runId, name);
            const out = new Set();
            (rows || []).forEach((r) => {
                const v = Number(r && r.value_num);
                if (!Number.isFinite(v)) return;
                out.add(Math.round(v));
            });
            return Array.from(out.values()).sort((a, b) => a - b);
        } catch (_e) {
            return [];
        }
    }

    async function applyNeighborConfigFromUi(useDefaults = false) {
        if (trpNeighborConfigBusy) return;
        trpNeighborConfigBusy = true;

        const applyBtn = qs('trpNeighborCfgApply');
        const resetBtn = qs('trpNeighborCfgReset');
        if (applyBtn) applyBtn.disabled = true;
        if (resetBtn) resetBtn.disabled = true;

        try {
            const wInput = qs('trpNeighborWindowMs');
            const aInput = qs('trpNeighborAlignMs');
            const current = getNeighborWindowConfig();
            const nextW = useDefaults ? TRP_NEIGHBOR_WINDOW_DEFAULT_MS : clampIntInRange(wInput && wInput.value, current.windowMs, TRP_NEIGHBOR_WINDOW_MIN_MS, TRP_NEIGHBOR_WINDOW_MAX_MS);
            const nextA = useDefaults ? TRP_NEIGHBOR_ALIGN_DEFAULT_MS : clampIntInRange(aInput && aInput.value, current.alignMs, TRP_NEIGHBOR_ALIGN_MIN_MS, TRP_NEIGHBOR_ALIGN_MAX_MS);
            setNeighborWindowConfig(nextW, nextA);
            syncNeighborConfigUi();

            setNeighborConfigStatus('Saved. Rebuilding LTE neighbor context...');
            const info = await rebuildNeighborContextForLoadedRuns();
            if (info.runs > 0) {
                setNeighborConfigStatus('Saved. Rebuilt ' + info.runs + ' LTE run(s) (' + info.points + ' points).');
            } else {
                setNeighborConfigStatus('Saved. New values will apply to next LTE TRP import.');
            }
        } catch (err) {
            setNeighborConfigStatus('Failed to apply settings: ' + (err && err.message ? err.message : err), true);
        } finally {
            if (applyBtn) applyBtn.disabled = false;
            if (resetBtn) resetBtn.disabled = false;
            trpNeighborConfigBusy = false;
        }
    }

    function bindNeighborConfigControls() {
        const applyBtn = qs('trpNeighborCfgApply');
        const resetBtn = qs('trpNeighborCfgReset');
        const wInput = qs('trpNeighborWindowMs');
        const aInput = qs('trpNeighborAlignMs');

        if (applyBtn && !applyBtn.dataset.bound) {
            applyBtn.addEventListener('click', async () => { await applyNeighborConfigFromUi(false); });
            applyBtn.dataset.bound = '1';
        }
        if (resetBtn && !resetBtn.dataset.bound) {
            resetBtn.addEventListener('click', async () => { await applyNeighborConfigFromUi(true); });
            resetBtn.dataset.bound = '1';
        }

        const bindEnter = (el) => {
            if (!el || el.dataset.boundEnter) return;
            el.addEventListener('keydown', async (ev) => {
                if (ev.key === 'Enter') {
                    ev.preventDefault();
                    await applyNeighborConfigFromUi(false);
                }
            });
            el.dataset.boundEnter = '1';
        };
        bindEnter(wInput);
        bindEnter(aInput);
    }

    function buildApiUrl(path) {
        if (!trpApiBase) return path;
        return trpApiBase.replace(/\/+$/, '') + path;
    }

    
    function normalizeThroughputSeries(metricName, points) {
        // Heuristic unit normalization:
        // - Many TEMS Pocket throughput KPIs are in kbps
        // - Some tools export in bps
        const name = String(metricName || '');
        const isTp = /throughput|bitrate|thp/i.test(name);
        if (!isTp) return { points, yLabel: null };
        const ys = points.map(p => Number(p.y)).filter(v => Number.isFinite(v) && v > 0);
        if (!ys.length) return { points, yLabel: 'Mbps' };
        ys.sort((a,b)=>a-b);
        const median = ys[Math.floor(ys.length/2)];
        let div = 1;
        // If median looks like bps (tens of millions), convert bps -> Mbps
        if (median >= 1_000_000) div = 1_000_000;
        // If median looks like kbps (thousands+), convert kbps -> Mbps
        else if (median >= 1_000) div = 1_000;
        const scaled = points.map(p => ({ x: p.x, y: Number(p.y) / div }));
        return { points: scaled, yLabel: 'Mbps' };
    }

    function inferAltApiBase() {
        return inferAltApiBases()[0] || '';
    }

    async function tryAlternateApiBases(sendFn) {
        const original = trpApiBase;
        const alternatives = inferAltApiBases().filter((b) => b && b !== original);
        for (const alt of alternatives) {
            trpApiBase = alt;
            try {
                const out = await sendFn();
                const status = Number(out && out.status);
                if (status && status !== 404 && status !== 405 && status !== 501) {
                    setApiBase(alt);
                    return out;
                }
            } catch (_e) {}
        }
        trpApiBase = original;
        return null;
    }

    async function promptApiBaseAndRetry(sendFn) {
        const suggested = inferAltApiBase() || 'http://localhost:8000';
        const entered = window.prompt(
            'Backend API URL is required for TRP import. Example: http://localhost:8000',
            suggested
        );
        if (!entered) return null;
        const previous = trpApiBase;
        setApiBase(entered);
        try {
            const out = await sendFn();
            const status = Number(out && out.status);
            if (status && status !== 404 && status !== 405 && status !== 501) return out;
        } catch (_e) {}
        trpApiBase = previous;
        return null;
    }

    async function ensureApiReadyForUpload() {
        if (trpApiBase) return;
        try {
            const { res, payload } = await fetchJsonWithApiFallback('/api/runs');
            if (res.ok && payload && payload.status === 'success') return;
        } catch (_e) {}
    }

    async function fetchJsonWithApiFallback(path, options) {
        const primaryUrl = buildApiUrl(path);
        let res = await fetch(primaryUrl, options);
        if ((res.status === 404 || res.status === 405 || res.status === 501) && !trpApiBase) {
            const altRes = await tryAlternateApiBases(() => fetch(buildApiUrl(path), options));
            if (altRes) res = altRes;
            else {
                const prompted = await promptApiBaseAndRetry(() => fetch(buildApiUrl(path), options));
                if (prompted) res = prompted;
            }
        }
        let payload = null;
        try {
            payload = await res.json();
        } catch (_e) {
            payload = null;
        }
        return { res, payload };
    }

    function ensureUploadProgressUi() {
        let wrap = qs('trpUploadProgressWrap');
        if (wrap) return wrap;
        const status = qs('fileStatus');
        const parent = status && status.parentElement ? status.parentElement : document.body;
        wrap = document.createElement('div');
        wrap.id = 'trpUploadProgressWrap';
        wrap.style.cssText = 'display:none;align-items:center;gap:8px;min-width:190px;';
        wrap.innerHTML =
            '<div style="width:120px;height:6px;background:#1f2937;border-radius:999px;overflow:hidden;border:1px solid #334155;">' +
            '  <div id="trpUploadProgressBar" style="height:100%;width:0%;background:linear-gradient(90deg,#22d3ee,#2bb3a3);transition:width .15s ease;"></div>' +
            '</div>' +
            '<span id="trpUploadProgressText" style="font-size:11px;color:#93c5fd;white-space:nowrap;">0%</span>';
        if (status && status.nextSibling) parent.insertBefore(wrap, status.nextSibling);
        else parent.appendChild(wrap);
        return wrap;
    }

    const uploadProgressState = {
        percent: 0,
        ticker: null,
        hasComputableProgress: false
    };

    function stopUploadProgressTicker() {
        if (uploadProgressState.ticker) {
            clearInterval(uploadProgressState.ticker);
            uploadProgressState.ticker = null;
        }
    }

    function resetUploadProgressState() {
        stopUploadProgressTicker();
        uploadProgressState.percent = 0;
        uploadProgressState.hasComputableProgress = false;
    }

    function startUploadProgressTicker() {
        stopUploadProgressTicker();
        uploadProgressState.ticker = setInterval(() => {
            if (uploadProgressState.hasComputableProgress) return;
            const next = uploadProgressState.percent < 50
                ? uploadProgressState.percent + 2
                : uploadProgressState.percent + 1;
            const clamped = Math.min(90, next);
            if (clamped <= uploadProgressState.percent) return;
            setUploadProgress(clamped, Math.round(clamped) + '%');
            setStatus('Uploading TRP: ' + Math.round(clamped) + '%');
        }, 400);
    }

    function startFinalizingProgressTicker() {
        stopUploadProgressTicker();
        uploadProgressState.ticker = setInterval(() => {
            const next = Math.min(99, uploadProgressState.percent + 1);
            if (next <= uploadProgressState.percent) return;
            setUploadProgress(next, Math.round(next) + '%');
            setStatus('Importing KPIs: ' + Math.round(next) + '%');
        }, 300);
    }

    function setUploadProgress(percent, text) {
        const wrap = ensureUploadProgressUi();
        const bar = qs('trpUploadProgressBar');
        const lbl = qs('trpUploadProgressText');
        wrap.style.display = 'inline-flex';
        if (Number.isFinite(Number(percent))) {
            const requested = Math.max(0, Math.min(100, Number(percent)));
            const p = Math.max(uploadProgressState.percent, requested);
            uploadProgressState.percent = p;
            if (bar) bar.style.width = p.toFixed(1) + '%';
            if (lbl) lbl.textContent = text || (Math.round(p) + '%');
        } else {
            if (bar) bar.style.width = uploadProgressState.percent.toFixed(1) + '%';
            if (lbl) lbl.textContent = text || 'Uploading...';
        }
    }

    function hideUploadProgress() {
        stopUploadProgressTicker();
        const wrap = qs('trpUploadProgressWrap');
        if (wrap) wrap.style.display = 'none';
    }

    async function postFormWithProgress(path, formData, onProgress) {
        const sendOnce = (url) => new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open('POST', url, true);
            xhr.upload.onprogress = (e) => {
                if (typeof onProgress !== 'function') return;
                if (e.lengthComputable && e.total > 0) onProgress((e.loaded / e.total) * 100);
                else onProgress(null);
            };
            xhr.onerror = () => reject(new Error('Network error during upload'));
            xhr.onload = () => {
                let payload = null;
                try { payload = JSON.parse(xhr.responseText || 'null'); }
                catch (_e) { payload = null; }
                resolve({
                    status: xhr.status,
                    ok: xhr.status >= 200 && xhr.status < 300,
                    payload
                });
            };
            xhr.send(formData);
        });

        let out = await sendOnce(buildApiUrl(path));
        if ((out.status === 404 || out.status === 405 || out.status === 501) && !trpApiBase) {
            const altOut = await tryAlternateApiBases(() => sendOnce(buildApiUrl(path)));
            if (altOut) out = altOut;
            else {
                const prompted = await promptApiBaseAndRetry(() => sendOnce(buildApiUrl(path)));
                if (prompted) out = prompted;
            }
        }
        return out;
    }

    function ensureTrpControls() {
        const actions = document.querySelector('.header-map-actions');
        if (!actions) return;

        let input = qs('trpImportInput');
        if (!input) {
            input = document.createElement('input');
            input.type = 'file';
            input.id = 'trpImportInput';
            input.accept = '.trp';
            input.className = 'hidden-input';
            actions.appendChild(input);
        }

        let importTrpBtn = qs('importTrpBtn');
        if (!importTrpBtn) {
            importTrpBtn = document.createElement('button');
            importTrpBtn.id = 'importTrpBtn';
            importTrpBtn.className = 'btn header-btn';
            importTrpBtn.title = 'Import TRP run and decode KPIs/events';
            importTrpBtn.textContent = '📥 Import TRP';
            const importBtn = qs('importBtn');
            if (importBtn && importBtn.parentNode === actions) {
                actions.insertBefore(importTrpBtn, importBtn.nextSibling);
            } else {
                actions.appendChild(importTrpBtn);
            }
        }
        if (!importTrpBtn.dataset.bound) {
            importTrpBtn.addEventListener('click', (ev) => {
                ev.preventDefault();
                ev.stopPropagation();

                // Reset selection so choosing the same file again still triggers 'change'
                try { input.value = ''; } catch (_e) {}

                // Give user feedback (if status element exists in UI)
                try { setStatus('Choose a .trp file…'); } catch (_e) {}

                try {
                    if (typeof input.showPicker === 'function') input.showPicker();
                    else input.click();
                } catch (_e) {
                    input.click();
                }
            });
            importTrpBtn.dataset.bound = '1';
        }

        const runsBtn = qs('runsListBtn');
        if (runsBtn && runsBtn.parentNode) {
            runsBtn.parentNode.removeChild(runsBtn);
        }

        if (!input.dataset.bound) {
            input.addEventListener('change', async () => {
                const file = input.files && input.files[0];
                if (!file) {
                    try { setStatus('No file selected.'); } catch (_e) {}
                    return;
                }
                try {
                    await uploadTrp(file);
                } finally {
                    // allow re-selecting the same file
                    try { input.value = ''; } catch (_e) {}
                }
            });
            input.dataset.bound = '1';
        }
    }

    function setStatus(text) {
        const el = qs('fileStatus');
        if (el) el.textContent = text;
    }

    async function uploadTrp(file) {
        await ensureApiReadyForUpload();
        resetUploadProgressState();
        setStatus('Uploading TRP: 0%');
        setUploadProgress(0, '0%');
        startUploadProgressTicker();
        const form = new FormData();
        form.append('file', file, file.name);

        let response;
        let payload;
        try {
            const out = await postFormWithProgress('/api/trp/import', form, (p) => {
                if (Number.isFinite(Number(p))) {
                    uploadProgressState.hasComputableProgress = true;
                    stopUploadProgressTicker();
                    const pct = Math.round(Number(p));
                    setUploadProgress(p, pct + '%');
                    setStatus('Uploading TRP: ' + pct + '%');
                } else {
                    setUploadProgress(null, 'Uploading...');
                    setStatus('Uploading TRP...');
                }
            });
            response = { ok: out.ok, status: out.status };
            payload = out.payload;
        } catch (err) {
            hideUploadProgress();
            setStatus('TRP: upload failed');
            alert('Upload failed: ' + (err && err.message ? err.message : err));
            return;
        }

        if (!payload) {
            hideUploadProgress();
            setStatus('TRP: invalid server response');
            alert('Invalid response from server.');
            return;
        }

        if (!response.ok || payload.status !== 'success') {
            hideUploadProgress();
            setStatus('TRP: import failed');
            const report = payload && payload.importReport ? payload.importReport : null;
            let msg = (payload && payload.message) || ('HTTP ' + response.status);
            if (report) {
                const parts = [];
                if (Number.isFinite(Number(report.channelLogFrames))) parts.push('frames=' + report.channelLogFrames);
                if (Number.isFinite(Number(report.decodedSamples))) parts.push('samples=' + report.decodedSamples);
                if (Number.isFinite(Number(report.decodedEvents))) parts.push('events=' + report.decodedEvents);
                if (Array.isArray(report.warnings) && report.warnings.length) parts.push('warnings=' + report.warnings.slice(0, 3).join(' | '));
                if (parts.length) msg += '\n\nImport report: ' + parts.join(' ; ');
            }
            alert(msg);
            return;
        }

        stopUploadProgressTicker();
        if (uploadProgressState.percent < 95) {
            setUploadProgress(95, '95%');
        }
        setStatus('Importing KPIs...');
        startFinalizingProgressTicker();
        await injectRunIntoLoadedLogs(payload.runId, file.name);
        stopUploadProgressTicker();
        setUploadProgress(100, '100%');
        setStatus('TRP loaded: 100%');
        setTimeout(() => {
            hideUploadProgress();
            setStatus('');
        }, 3000);
    }

    function escapeHtml(v) {
        return String(v == null ? '' : v)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function ensureRunModal() {
        let overlay = qs('trpRunOverlay');
        if (overlay) return overlay;

        overlay = document.createElement('div');
        overlay.id = 'trpRunOverlay';
        overlay.style.cssText = [
            'position:fixed',
            'inset:0',
            'z-index:100000',
            'background:rgba(2,6,23,0.78)',
            'display:none'
        ].join(';');

        overlay.innerHTML = [
            '<div id="trpRunModal" style="position:absolute;inset:3% 3%;background:#0b1220;border:1px solid #2b3f63;border-radius:14px;overflow:hidden;display:flex;flex-direction:column;">',
            '  <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 14px;border-bottom:1px solid #22334f;">',
            '    <div style="font-weight:700;color:#dbeafe">TRP Run Detail</div>',
            '    <button id="trpRunClose" class="btn header-btn" style="padding:6px 10px;">Close</button>',
            '  </div>',
            '  <div id="trpRunBody" style="display:grid;grid-template-columns:380px 1fr;gap:10px;flex:1;min-height:0;padding:10px;">',
            '    <div style="display:flex;flex-direction:column;gap:10px;min-height:0;overflow:hidden;">',
            '      <div id="trpRunSummary" style="background:#111c2f;border:1px solid #2b3f63;border-radius:10px;padding:10px;color:#dbeafe"></div>',
            '      <div id="trpNeighborCfgCard" style="background:#111c2f;border:1px solid #2b3f63;border-radius:10px;padding:10px;color:#dbeafe;">',
            '        <div style="font-size:12px;font-weight:700;color:#dbeafe;margin-bottom:8px;">LTE Neighbor Window Settings</div>',
            '        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">',
            '          <label style="display:flex;flex-direction:column;gap:4px;font-size:11px;color:#93c5fd;">Window (ms, +/- around point)',
            '            <input id="trpNeighborWindowMs" type="number" min="100" max="10000" step="50" style="background:#0a1424;color:#dbeafe;border:1px solid #35507a;border-radius:6px;padding:4px 6px;"/>',
            '          </label>',
            '          <label style="display:flex;flex-direction:column;gap:4px;font-size:11px;color:#93c5fd;">Align tolerance (ms)',
            '            <input id="trpNeighborAlignMs" type="number" min="20" max="2000" step="10" style="background:#0a1424;color:#dbeafe;border:1px solid #35507a;border-radius:6px;padding:4px 6px;"/>',
            '          </label>',
            '        </div>',
            '        <div style="display:flex;gap:6px;align-items:center;margin-top:8px;">',
            '          <button id="trpNeighborCfgApply" class="btn header-btn" style="padding:4px 8px;">Apply</button>',
            '          <button id="trpNeighborCfgReset" class="btn header-btn" style="padding:4px 8px;">Reset</button>',
            '          <span id="trpNeighborCfgStatus" style="font-size:11px;color:#93c5fd;"></span>',
            '        </div>',
            '      </div>',
            '      <div style="background:#111c2f;border:1px solid #2b3f63;border-radius:10px;padding:10px;display:flex;flex-direction:column;min-height:0;flex:1;">',
            '        <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;">',
            '          <button id="trpTabKpis" class="btn header-btn" style="padding:4px 8px;">KPIs</button>',
            '          <button id="trpTabEvents" class="btn header-btn" style="padding:4px 8px;">Events</button>',
            '          <input id="trpCatalogSearch" placeholder="Search KPI or Event" style="flex:1;background:#0a1424;color:#dbeafe;border:1px solid #35507a;border-radius:6px;padding:4px 8px;"/>',
            '        </div>',
            '        <div id="trpCatalogHint" style="font-size:11px;color:#93c5fd;margin-bottom:6px;"></div>',
            '        <div id="trpCatalogPane" style="overflow:auto;flex:1;min-height:0;border:1px solid #1f3559;border-radius:8px;padding:6px;background:#08101d;"></div>',
            '      </div>',
            '    </div>',
            '    <div style="display:grid;grid-template-rows:50% 50%;gap:10px;min-height:0;">',
            '      <div id="trpRunMap" style="background:#0f172a;border:1px solid #2b3f63;border-radius:10px;min-height:240px;"></div>',
            '      <div style="background:#111c2f;border:1px solid #2b3f63;border-radius:10px;padding:10px;display:flex;flex-direction:column;min-height:0;">',
            '        <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;">',
            '          <b id="trpMainTitle" style="color:#dbeafe;">KPI time-series</b>',
            '          <select id="trpKpiSelect" style="min-width:240px;background:#0a1424;color:#dbeafe;border:1px solid #35507a;border-radius:6px;padding:4px 8px;"></select>',
            '        </div>',
            '        <div id="trpMainKpi" style="position:relative;flex:1;min-height:0;"><canvas id="trpKpiChart"></canvas></div>',
            '        <div id="trpMainEvents" style="display:none;flex:1;min-height:0;overflow:hidden;">',
            '          <div id="trpSelectedEventLabel" style="font-size:12px;color:#cbd5e1;margin-bottom:6px;"></div>',
            '          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;height:calc(100% - 22px);">',
            '            <div id="trpEventsList" style="overflow:auto;border:1px solid #1f3559;border-radius:8px;background:#08101d;font-size:12px;"></div>',
            '            <pre id="trpEventParams" style="margin:0;overflow:auto;white-space:pre-wrap;background:#08101d;border:1px solid #1f3559;border-radius:8px;padding:8px;color:#cbd5e1;min-height:0;"></pre>',
            '          </div>',
            '        </div>',
            '      </div>',
            '    </div>',
            '  </div>',
            '</div>'
        ].join('');

        document.body.appendChild(overlay);

        qs('trpRunClose').addEventListener('click', () => {
            overlay.style.display = 'none';
        });
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) overlay.style.display = 'none';
        });

        qs('trpTabKpis').addEventListener('click', () => {
            trpState.sidebarTab = 'kpis';
            renderCatalogPane();
        });
        qs('trpTabEvents').addEventListener('click', () => {
            trpState.sidebarTab = 'events';
            renderCatalogPane();
        });
        qs('trpCatalogSearch').addEventListener('input', () => renderCatalogPane());
        qs('trpKpiSelect').addEventListener('change', async (e) => {
            const name = e.target.value;
            if (name) await selectKpiMetric(name);
        });

        bindNeighborConfigControls();
        syncNeighborConfigUi();

        return overlay;
    }

    let trpLeafletMap = null;
    let trpLeafletTrack = null;
    let trpChart = null;

    function ensureRunsListModal() {
        let overlay = qs('trpRunsOverlay');
        if (overlay) return overlay;
        overlay = document.createElement('div');
        overlay.id = 'trpRunsOverlay';
        overlay.style.cssText = 'position:fixed;inset:0;z-index:99990;background:rgba(2,6,23,0.72);display:none;';
        overlay.innerHTML = [
            '<div style="position:absolute;inset:6% 12%;background:#0b1220;border:1px solid #2b3f63;border-radius:14px;display:flex;flex-direction:column;overflow:hidden;">',
            '  <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 14px;border-bottom:1px solid #22334f;">',
            '    <div style="font-weight:700;color:#dbeafe;">Imported Runs</div>',
            '    <button id="trpRunsClose" class="btn header-btn" style="padding:6px 10px;">Close</button>',
            '  </div>',
            '  <div style="padding:10px;display:flex;gap:8px;align-items:center;border-bottom:1px solid #1e2d46;">',
            '    <input id="trpRunsSearch" placeholder="Search by filename..." style="flex:1;background:#0a1424;color:#dbeafe;border:1px solid #35507a;border-radius:6px;padding:6px 8px;">',
            '    <button id="trpRunsRefresh" class="btn header-btn" style="padding:6px 10px;">Refresh</button>',
            '  </div>',
            '  <div id="trpRunsList" style="padding:10px;overflow:auto;flex:1;"></div>',
            '</div>'
        ].join('');
        document.body.appendChild(overlay);
        qs('trpRunsClose').addEventListener('click', () => { overlay.style.display = 'none'; });
        qs('trpRunsRefresh').addEventListener('click', () => openRunsList());
        overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.style.display = 'none'; });
        return overlay;
    }

    async function fetchRunsList() {
        const { res, payload: data } = await fetchJsonWithApiFallback('/api/runs?limit=300');
        if (!res.ok || data.status !== 'success') throw new Error(data.message || ('HTTP ' + res.status));
        return Array.isArray(data.runs) ? data.runs : [];
    }

    async function openRunsList() {
        const overlay = ensureRunsListModal();
        overlay.style.display = 'block';
        const listEl = qs('trpRunsList');
        const searchEl = qs('trpRunsSearch');
        if (!listEl || !searchEl) return;
        listEl.innerHTML = '<div style="color:#cbd5e1;">Loading runs...</div>';
        let rows = [];
        try {
            rows = await fetchRunsList();
        } catch (err) {
            listEl.innerHTML = `<div style="color:#fca5a5;">Failed to load runs: ${escapeHtml(err && err.message ? err.message : err)}</div>`;
            return;
        }
        const render = () => {
            const q = String(searchEl.value || '').trim().toLowerCase();
            const filtered = rows.filter(r => !q || String(r.filename || '').toLowerCase().includes(q));
            if (!filtered.length) {
                listEl.innerHTML = '<div style="color:#cbd5e1;">No runs found.</div>';
                return;
            }
            listEl.innerHTML = [
                '<table style="width:100%;border-collapse:collapse;font-size:12px;color:#dbeafe;">',
                '<thead><tr style="text-align:left;background:#0e1a2e;">',
                '<th style="padding:8px;border-bottom:1px solid #2b3f63;">Run ID</th>',
                '<th style="padding:8px;border-bottom:1px solid #2b3f63;">File</th>',
                '<th style="padding:8px;border-bottom:1px solid #2b3f63;">Imported</th>',
                '<th style="padding:8px;border-bottom:1px solid #2b3f63;">Start</th>',
                '<th style="padding:8px;border-bottom:1px solid #2b3f63;">End</th>',
                '<th style="padding:8px;border-bottom:1px solid #2b3f63;">KPIs</th>',
                '<th style="padding:8px;border-bottom:1px solid #2b3f63;">Events</th>',
                '<th style="padding:8px;border-bottom:1px solid #2b3f63;">Action</th>',
                '</tr></thead><tbody>',
                filtered.map(r => (
                    `<tr style="border-bottom:1px solid #1e2d46;">` +
                    `<td style="padding:8px;">${escapeHtml(r.id)}</td>` +
                    `<td style="padding:8px;">${escapeHtml(r.filename || '')}</td>` +
                    `<td style="padding:8px;">${escapeHtml(r.imported_at || '')}</td>` +
                    `<td style="padding:8px;">${escapeHtml(r.start_time || 'n/a')}</td>` +
                    `<td style="padding:8px;">${escapeHtml(r.end_time || 'n/a')}</td>` +
                    `<td style="padding:8px;">${escapeHtml((r.metadata && r.metadata.metric_count) || 0)}</td>` +
                    `<td style="padding:8px;">${escapeHtml((r.metadata && r.metadata.event_count) || 0)}</td>` +
                    `<td style="padding:8px;"><button class=\"btn header-btn trp-open-run\" data-run-id=\"${escapeHtml(r.id)}\" style=\"padding:4px 8px;\">Open</button></td>` +
                    `</tr>`
                )).join(''),
                '</tbody></table>'
            ].join('');
            const btns = listEl.querySelectorAll('.trp-open-run');
            btns.forEach(btn => {
                btn.addEventListener('click', async () => {
                    const id = Number(btn.getAttribute('data-run-id'));
                    if (!Number.isFinite(id)) return;
                    overlay.style.display = 'none';
                    await openRunDetail(id);
                });
            });
        };
        searchEl.oninput = render;
        render();
    }

    async function fetchRunDetail(runId) {
        const out = await fetchJsonWithApiFallback('/api/runs/' + encodeURIComponent(runId));
        if (!out.res.ok || out.payload.status !== 'success') throw new Error(out.payload.message || ('HTTP ' + out.res.status));
        return out.payload;
    }

    async function fetchRunCatalog(runId) {
        const out = await fetchJsonWithApiFallback('/api/runs/' + encodeURIComponent(runId) + '/catalog');
        if (!out.res.ok || out.payload.status !== 'success') throw new Error(out.payload.message || ('HTTP ' + out.res.status));
        return out.payload;
    }

    async function fetchRunSidebar(runId) {
        const out = await fetchJsonWithApiFallback('/api/runs/' + encodeURIComponent(runId) + '/sidebar');
        if (!out.res.ok || out.payload.status !== 'success') throw new Error(out.payload.message || ('HTTP ' + out.res.status));
        return out.payload;
    }

    async function openRunDetail(runId) {
        const overlay = ensureRunModal();
        overlay.style.display = 'block';
        syncNeighborConfigUi();

        const body = qs('trpRunBody');
        if (body) body.style.opacity = '0.55';

        try {
            const [detail, catalog] = await Promise.all([
                fetchRunDetail(runId),
                fetchRunCatalog(runId)
            ]);
            trpState.runId = runId;
            trpState.runDetail = detail;
            trpState.catalog = catalog;
            trpState.sidebarTab = 'kpis';
            trpState.selectedMetric = null;
            trpState.selectedEventName = null;
            trpState.eventRows = [];

            renderSummary(detail.run, catalog);
            renderMap(detail.track_points || []);
            renderCatalogPane();
            setupKpiSelect(catalog.metricsFlat || []);

            const defaults = catalog.defaults || {};
            const defaultMetric = defaults.rsrpMetricName || defaults.sinrMetricName || defaults.mosMetricName || ((catalog.metricsFlat || [])[0] && (catalog.metricsFlat || [])[0].name);
            if (defaultMetric) {
                await selectKpiMetric(defaultMetric);
            } else {
                setMainMode('kpi');
                setMainTitle('No KPI available for this run');
            }
        } catch (err) {
            alert('Failed to load run detail/catalog: ' + (err && err.message ? err.message : err));
        } finally {
            if (body) body.style.opacity = '1';
        }

        try {
            window.history.pushState({ runId }, '', '/index.html#/runs/' + runId);
        } catch (_e) {
            window.location.hash = '/runs/' + runId;
        }
    }

    function toEpochMs(v) {
        const t = new Date(v || '').getTime();
        return Number.isFinite(t) ? t : null;
    }

    
    function buildFriendlyTrpLabels(metricNames) {
        const labels = {};
        (metricNames || []).forEach(name => {
            const n = String(name || '');
            const nl = n.toLowerCase();
            if (nl.includes('rsrp') && !nl.includes('neighbor')) labels[n] = 'RSRP';
            else if (nl.includes('rsrq') && !nl.includes('neighbor')) labels[n] = 'RSRQ';
            else if (nl.includes('sinr') || nl.includes('rs-sinr') || nl.includes('rssinr')) labels[n] = 'SINR';
            else if (nl.includes('data.http') && nl.includes('throughput') && (nl.includes('download') || nl.includes('downlink'))) labels[n] = 'Application throughput DL';
            else if (nl.includes('data.http') && nl.includes('throughput') && (nl.includes('upload') || nl.includes('uplink'))) labels[n] = 'Application throughput UL';
            else if (nl.includes('radio.lte.servingcell') && nl.includes('pdsch') && nl.includes('throughput')) labels[n] = 'DL throughput';
            else if (nl.includes('radio.lte.servingcelltotal.pusch.throughput') || (nl.includes('radio.lte.servingcell') && nl.includes('pusch') && nl.includes('throughput'))) labels[n] = 'UL throughput';
            else if ((nl.includes('downlink') || nl.includes('dl')) && nl.includes('throughput')) labels[n] = 'DL throughput';
            else if ((nl.includes('uplink') || nl.includes('ul')) && nl.includes('throughput')) labels[n] = 'UL throughput';
            else if (nl.includes('throughput') && nl.includes('down')) labels[n] = 'DL throughput';
            else if (nl.includes('throughput') && nl.includes('up')) labels[n] = 'UL throughput';
            else if (nl.includes('cellid') || nl.includes('cell identity') || nl.includes('.cell_id')) labels[n] = 'Cellid';
            else if (nl.includes('physical cell id') || nl.includes('.pci')) labels[n] = 'Physical cell ID';
            else if (nl.includes('enodeb id') || nl.includes('.enodebid')) labels[n] = 'eNodeB ID';
            else if (nl.includes('tracking area code') || nl.includes('.tac')) labels[n] = 'Tracking area code';
            else if (nl.includes('earfcn')) labels[n] = 'Downlink EARFCN';
            else if (nl.includes(' cell id') || nl.includes('.cell.id') || nl.endsWith('.cellid')) labels[n] = 'Cell ID';
            else if (nl.startsWith('__derived_enodeb_id')) labels[n] = 'eNodeB ID';
            else if (nl.startsWith('__derived_cell_id')) labels[n] = 'Cell ID';
        });
        // If we still have unlabeled throughput metrics (some logs use generic names), label by position.
        const tp = (metricNames || []).filter(m => String(m||'').toLowerCase().includes('throughput'));
        if (tp.length === 2) {
            const a = String(tp[0]); const b = String(tp[1]);
            if (!labels[a]) labels[a] = 'DL throughput';
            if (!labels[b]) labels[b] = 'UL throughput';
        }
        return labels;
    }

    function pickApplicationThroughputMetrics(metricsFlat) {
        const names = (metricsFlat || [])
            .filter(m => Number(m && m.stats && m.stats.sample_count) > 0)
            .map(m => String(m.name || ''));

        function pick(candidates, direction) {
            if (!candidates.length) return null;
            const sorted = candidates.slice().sort((a, b) => {
                const score = (raw) => {
                    const n = String(raw || '').toLowerCase();
                    let s = 0;
                    if (n.includes('data.http')) s += 80;
                    if (n.includes('http')) s += 30;
                    if (n.includes('throughput')) s += 20;
                    if (direction === 'dl' && (n.includes('download') || n.includes('downlink'))) s += 25;
                    if (direction === 'ul' && (n.includes('upload') || n.includes('uplink'))) s += 25;
                    if (n.includes('application')) s += 10;
                    return s;
                };
                return score(b) - score(a);
            });
            return sorted[0];
        }

        const tpNames = names.filter(n => n.toLowerCase().includes('throughput'));
        const dlCandidates = tpNames.filter(n => {
            const low = n.toLowerCase();
            return (low.includes('data.http') || low.includes('http')) &&
                (low.includes('download') || low.includes('downlink'));
        });
        const ulCandidates = tpNames.filter(n => {
            const low = n.toLowerCase();
            return (low.includes('data.http') || low.includes('http')) &&
                (low.includes('upload') || low.includes('uplink'));
        });

        return {
            dl: pick(dlCandidates, 'dl'),
            ul: pick(ulCandidates, 'ul')
        };
    }

    function pickBestMetric(candidates, keyword) {
        if (!candidates || !candidates.length) return null;

        function score(m) {
            const name = String(m || '').toLowerCase();
            let s = 0;

            // Strong preference for real serving cell metrics.
            if (name.includes('radio.lte.servingcell')) s += 50;
            if (name.includes('radio.lte.servingsystem')) s += 40;

            // Prefer exact metric endings.
            if (name.endsWith('.pci')) s += 30;
            if (name.endsWith('.earfcn')) s += 30;
            if (name.endsWith('.tac')) s += 30;
            if (name.endsWith('.cellidentity') || name.endsWith('.cellid')) s += 30;

            // Penalize control/lock/override metrics.
            if (name.includes('lock')) s -= 100;
            if (name.includes('override')) s -= 100;
            if (name.includes('controlfunction')) s -= 80;
            if (name.includes('device')) s -= 50;

            return s;
        }

        return candidates.sort((a, b) => score(b) - score(a))[0];
    }

    function pickIdentifierMetrics(metricsFlat) {
        const catalogMetrics = (metricsFlat || [])
            .filter(m => Number(m && m.stats && m.stats.sample_count) > 0)
            .map(m => String(m.name || ''));

        const pciMetric = pickBestMetric(
            catalogMetrics.filter(m => m.toLowerCase().includes('pci')),
            'pci'
        );

        const earfcnMetric = pickBestMetric(
            catalogMetrics.filter(m => m.toLowerCase().includes('earfcn')),
            'earfcn'
        );

        const tacMetric = pickBestMetric(
            catalogMetrics.filter(m => m.toLowerCase().includes('tac')),
            'tac'
        );

        const cellIdMetric = pickBestMetric(
            catalogMetrics.filter(m =>
                m.toLowerCase().includes('cellidentity') ||
                m.toLowerCase().includes('cellid')
            ),
            'cellid'
        );

        const enodebMetric = pickBestMetric(
            catalogMetrics.filter(m => m.toLowerCase().includes('enodeb')),
            'enodeb'
        );

        const localCellIdMetric = pickBestMetric(
            catalogMetrics.filter(m => m.toLowerCase().includes('.cell.id') || m.toLowerCase().includes(' cell id')),
            'localcellid'
        );

        return Array.from(new Set([cellIdMetric, pciMetric, enodebMetric, localCellIdMetric, earfcnMetric, tacMetric].filter(Boolean)));
    }

    function buildInfoFallbackMetrics(trpInfo) {
        const defs = [
            { key: '__info_cellid', src: 'cellid', label: 'Cellid' },
            { key: '__info_pci', src: 'pci', label: 'Physical cell ID' },
            { key: '__info_enodeb_id', src: 'enodeb_id', label: 'eNodeB ID' },
            { key: '__info_cell_id', src: 'cell_id', label: 'Cell ID' },
            { key: '__info_dl_earfcn', src: 'dl_earfcn', label: 'Downlink EARFCN' },
            { key: '__info_tac', src: 'tac', label: 'Tracking area code' }
        ];
        const out = [];
        const values = {};
        const labels = {};
        const info = (trpInfo && typeof trpInfo === 'object') ? trpInfo : {};
        defs.forEach(d => {
            const v = info[d.src];
            if (v === undefined || v === null || String(v).trim() === '') return;
            out.push(d.key);
            values[d.key] = v;
            labels[d.key] = d.label;
        });
        return { keys: out, values, labels };
    }

function detectTrpTechnology(metricsFlat, eventCatalog) {
        const names = (metricsFlat || []).map(m => String((m && m.name) || '').toLowerCase());
        const events = (eventCatalog || []).map(e => String((e && e.event_name) || '').toLowerCase());
        const text = names.concat(events).join(' ');
        if (text.includes('radio.lte.') || text.includes('.lte.')) return 'LTE';
        const score = { LTE: 0, NR5G: 0, UMTS3G: 0 };

        if (/\\blte\\b|rsrp|rsrq|sinr|enodeb|volte|ims/.test(text)) score.LTE += 4;
        if (/5g|\\bnr\\b|ss-rsrp|ssrsrp|ss-sinr|gnodeb/.test(text)) score.NR5G += 4;
        if (/umts|wcdma|rscp|ecno|uarfcn|psc/.test(text)) score.UMTS3G += 4;

        names.forEach(n => {
            if (n.includes('rsrp') || n.includes('rsrq') || n.includes('sinr') || n.includes('volte') || n.includes('ims')) score.LTE += 1;
            if (n.includes('ss-rsrp') || n.includes('ssrsrp') || n.includes('ss-sinr') || n.includes('nr')) score.NR5G += 1;
            if (n.includes('rscp') || n.includes('ecno') || n.includes('umts') || n.includes('wcdma')) score.UMTS3G += 1;
        });

        const best = Object.entries(score).sort((a, b) => b[1] - a[1])[0];
        if (!best || best[1] <= 0) return 'TRP';
        if (best[0] === 'LTE') return 'LTE';
        if (best[0] === 'NR5G') return '5G NR';
        if (best[0] === 'UMTS3G') return 'UMTS 3G';
        return 'TRP';
    }

    function rankMetricForTech(name, tech) {
        const n = String(name || '').toLowerCase();
        const sharedBoost = (n.includes('mos') || n.includes('volte') || n.includes('ims')) ? 5 : 0;
        if (tech === 'LTE') {
            if (n.includes('rsrp')) return 100 + sharedBoost;
            if (n.includes('rs-sinr') || n.includes('sinr')) return 95 + sharedBoost;
            if (n.includes('rsrq')) return 90 + sharedBoost;
            if (n.includes('mos')) return 88;
            if (n.includes('bler')) return 75;
            if (n.includes('throughput')) return 70;
            if (n.includes('lte') || n.includes('volte') || n.includes('ims')) return 65 + sharedBoost;
        } else if (tech === '5G NR') {
            if (n.includes('ss-rsrp') || n.includes('ssrsrp')) return 100 + sharedBoost;
            if (n.includes('ss-sinr') || n.includes('sinr')) return 95 + sharedBoost;
            if (n.includes('ss-rsrq') || n.includes('ssrsrq') || n.includes('rsrq')) return 90 + sharedBoost;
            if (n.includes('mos')) return 88;
            if (n.includes('bler')) return 75;
            if (n.includes('throughput')) return 70;
            if (n.includes('nr') || n.includes('5g') || n.includes('ims')) return 65 + sharedBoost;
        } else if (tech === 'UMTS 3G') {
            if (n.includes('rscp')) return 100 + sharedBoost;
            if (n.includes('ecno')) return 95 + sharedBoost;
            if (n.includes('mos')) return 88;
            if (n.includes('bler')) return 80;
            if (n.includes('tx')) return 70;
            if (n.includes('umts') || n.includes('wcdma') || n.includes('uarfcn') || n.includes('psc')) return 65 + sharedBoost;
        }
        return sharedBoost;
    }

    function buildTechMetricOrder(metricsFlat, tech) {
        const allNames = (metricsFlat || []).map(m => m && m.name).filter(Boolean);
        const scored = allNames.map(name => ({ name, score: rankMetricForTech(name, tech) }));
        scored.sort((a, b) => b.score - a.score || String(a.name).localeCompare(String(b.name)));
        return scored.map(x => x.name);
    }

    function pickFirstByKeywords(names, keywords, options) {
        const opts = options || {};
        const prefer = (opts.prefer || []).map(x => String(x).toLowerCase());
        const avoid = (opts.avoid || []).map(x => String(x).toLowerCase());
        let best = null;
        let bestScore = -1;
        for (const n of names) {
            const low = String(n || '').toLowerCase();
            let hits = 0;
            keywords.forEach(k => { if (low.includes(String(k).toLowerCase())) hits += 1; });
            if (!hits) continue;
            let score = hits * 10;
            prefer.forEach(k => { if (low.includes(k)) score += 8; });
            avoid.forEach(k => { if (low.includes(k)) score -= 12; });
            if (low.includes('servingcell')) score += 6;
            if (low.includes('neighbor')) score -= 10;
            if (score > bestScore) {
                bestScore = score;
                best = n;
            }
        }
        return best;
    }

    function pickCoreSidebarMetrics(orderedNames, tech) {
        const names = orderedNames || [];
        const out = [];
        const add = (v) => { if (v && !out.includes(v)) out.push(v); };

        if (tech === '5G NR') {
            add(pickFirstByKeywords(names, ['ss-rsrp', 'ssrsrp', 'rsrp'], { prefer: ['servingcell'], avoid: ['neighbor'] }));
            add(pickFirstByKeywords(names, ['ss-rsrq', 'ssrsrq', 'rsrq'], { prefer: ['servingcell'], avoid: ['neighbor'] }));
            add(pickFirstByKeywords(names, ['ss-sinr', 'sinr']));
        } else if (tech === 'UMTS 3G') {
            add(pickFirstByKeywords(names, ['rscp', 'rsrp']));
            add(pickFirstByKeywords(names, ['ecno', 'rsrq']));
            add(pickFirstByKeywords(names, ['sinr']));
        } else {
            add(pickFirstByKeywords(names, ['rsrp'], { prefer: ['servingcell'], avoid: ['neighbor'] }));
            add(pickFirstByKeywords(names, ['rsrq'], { prefer: ['servingcell'], avoid: ['neighbor'] }));
            add(pickFirstByKeywords(names, ['rs-sinr', 'sinr'], { prefer: ['servingcell'], avoid: ['neighbor'] }));
        }

        add(pickFirstByKeywords(
            names,
            ['dl throughput', 'downlink throughput', 'throughput dl', 'throughput_dl', 'dl rate', 'pdsch.throughput'],
            { prefer: ['servingcell', 'pdsch'], avoid: ['neighbor', 'http download'] }
        ));
        add(pickFirstByKeywords(
            names,
            ['ul throughput', 'uplink throughput', 'throughput ul', 'throughput_ul', 'ul rate', 'pusch.throughput'],
            { prefer: ['servingcell', 'pusch'], avoid: ['neighbor', 'http upload'] }
        ));

        // Ensure exactly practical core set if available.
        return out.slice(0, 5);
    }

    function filterSampleBackedMetrics(metricsFlat) {
        return (metricsFlat || []).filter(m => {
            const sc = Number(m && m.stats && m.stats.sample_count);
            return Number.isFinite(sc) && sc > 0;
        });
    }

    function hasSampleBacked(metricsFlat) {
        return filterSampleBackedMetrics(metricsFlat).length > 0;
    }

    function buildTechEventTypes(eventsCatalog, tech) {
        const rows = (eventsCatalog || []).slice();
        const scoreEvent = (name) => {
            const n = String(name || '').toLowerCase();
            let s = 0;
            if (n.includes('call') || n.includes('volte') || n.includes('ims') || n.includes('sip')) s += 8;
            if (n.includes('drop') || n.includes('fail') || n.includes('reject') || n.includes('release')) s += 6;
            if (tech === 'LTE' && (n.includes('lte') || n.includes('enodeb') || n.includes('rrc'))) s += 4;
            if (tech === '5G NR' && (n.includes('nr') || n.includes('5g') || n.includes('gnodeb'))) s += 4;
            if (tech === 'UMTS 3G' && (n.includes('umts') || n.includes('wcdma') || n.includes('rnc'))) s += 4;
            return s;
        };
        rows.sort((a, b) => {
            const sa = scoreEvent(a.event_name);
            const sb = scoreEvent(b.event_name);
            return sb - sa || Number(b.count || 0) - Number(a.count || 0);
        });
        return rows;
    }

    
    function mapSeriesToPoints(points, metricName, series, toleranceMs = 2000) {
        if (!Array.isArray(points) || !Array.isArray(series) || !metricName) return;
        // Prepare sorted series by time (epoch ms)
        const s = series
            .map(r => ({ t: toEpochMs(r.time), v: Number(r.value_num) }))
            .filter(x => Number.isFinite(x.t) && Number.isFinite(x.v))
            .sort((a,b) => a.t - b.t);
        if (!s.length) return;

        let j = 0;
        for (let i = 0; i < points.length; i++) {
            const pt = points[i];
            const t = Number(pt.timestamp || toEpochMs(pt.time));
            if (!Number.isFinite(t)) continue;

            while (j + 1 < s.length && s[j + 1].t <= t) j++;
            // choose closest of j and j+1
            let best = s[j];
            if (j + 1 < s.length) {
                const a = s[j], b = s[j+1];
                if (Math.abs(b.t - t) < Math.abs(a.t - t)) best = b;
            }
            if (best && Math.abs(best.t - t) <= toleranceMs) {
                pt[metricName] = best.v;
                // keep legacy field for rendering if needed
                if (String(metricName).toLowerCase().includes('rsrp') || String(metricName).toLowerCase().includes('rscp')) {
                    pt.level = best.v;
                }
            }
        }
    }

    function normalizeNeighborFieldName(rawField) {
        const s = String(rawField || '').toLowerCase();
        if (s === 'pci') return 'pci';
        if (s === 'rsrp') return 'rsrp';
        if (s === 'rsrq') return 'rsrq';
        if (s === 'earfcn' || s === 'frequency') return 'earfcn';
        return null;
    }

    function parseLteNeighborMetricName(metricName) {
        const m = String(metricName || '').match(/^Radio\.Lte\.Neighbor\[(\d+)\]\.(Pci|Rsrp|Rsrq|Earfcn|Frequency)$/i);
        if (!m) return null;
        const field = normalizeNeighborFieldName(m[2]);
        if (!field) return null;
        return { index: Number(m[1]), field };
    }

    function lowerBoundByTime(samples, targetMs) {
        let lo = 0;
        let hi = Array.isArray(samples) ? samples.length : 0;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (samples[mid].t < targetMs) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    }

    function nearestValueWithin(samples, targetMs, maxDeltaMs) {
        if (!Array.isArray(samples) || !samples.length) return null;
        const idx = lowerBoundByTime(samples, targetMs);
        let best = null;
        if (idx < samples.length) best = samples[idx];
        if (idx > 0) {
            const prev = samples[idx - 1];
            if (!best || Math.abs(prev.t - targetMs) <= Math.abs(best.t - targetMs)) best = prev;
        }
        if (!best) return null;
        if (Math.abs(best.t - targetMs) > maxDeltaMs) return null;
        return Number.isFinite(Number(best.v)) ? Number(best.v) : null;
    }

    async function hydrateLteNeighborWindowContext(points, runId, sidebarNeighbors, options = {}) {
        if (!Array.isArray(points) || !points.length || !runId) return;

        const windowMs = Number.isFinite(Number(options.windowMs)) ? Number(options.windowMs) : 1000;
        const alignMs = Number.isFinite(Number(options.alignMs)) ? Number(options.alignMs) : 300;
        const servingEarfcnSet = new Set(
            (Array.isArray(options.servingEarfcnSet) ? options.servingEarfcnSet : [])
                .map(v => Number(v))
                .filter(v => Number.isFinite(v))
                .map(v => Math.round(v))
        );

        const metricNames = Array.from(new Set(
            (sidebarNeighbors || [])
                .map(row => row && row.name)
                .filter(name => parseLteNeighborMetricName(name))
        ));
        if (!metricNames.length) return;

        const loaded = await Promise.all(metricNames.map(async (name) => {
            try {
                const rows = await fetchSeries(runId, name);
                return { name, rows: Array.isArray(rows) ? rows : [] };
            } catch (_e) {
                return { name, rows: [] };
            }
        }));

        const samplesByIndex = {};
        const ensureIndexBucket = (idx) => {
            const key = String(idx);
            if (!samplesByIndex[key]) {
                samplesByIndex[key] = { pci: [], rsrp: [], rsrq: [], earfcn: [] };
            }
            return samplesByIndex[key];
        };

        loaded.forEach(({ name, rows }) => {
            const meta = parseLteNeighborMetricName(name);
            if (!meta) return;
            const bucket = ensureIndexBucket(meta.index);
            if (!bucket[meta.field]) return;
            rows.forEach((r) => {
                const t = toEpochMs(r && r.time);
                const v = Number(r && r.value_num);
                if (!Number.isFinite(t) || !Number.isFinite(v)) return;
                bucket[meta.field].push({ t, v });
            });
        });

        const indexKeys = Object.keys(samplesByIndex);
        if (!indexKeys.length) return;
        indexKeys.forEach((idxKey) => {
            const b = samplesByIndex[idxKey];
            Object.values(b).forEach(arr => arr.sort((a, b2) => a.t - b2.t));
        });

        for (const p of points) {
            const t = Number(p && (p.timestamp || toEpochMs(p.time)));
            if (!Number.isFinite(t)) continue;

            const byPci = new Map();

            for (const idxKey of indexKeys) {
                const idxBucket = samplesByIndex[idxKey];
                const pciSamples = idxBucket.pci;
                if (!Array.isArray(pciSamples) || !pciSamples.length) continue;

                const start = lowerBoundByTime(pciSamples, t - windowMs);
                const end = lowerBoundByTime(pciSamples, t + windowMs + 1);

                for (let i = start; i < end; i++) {
                    const pciRaw = Number(pciSamples[i].v);
                    const pci = Number.isFinite(pciRaw) ? Math.round(pciRaw) : null;
                    if (!Number.isFinite(pci)) continue;

                    const row = byPci.get(pci) || {
                        pci,
                        rsrpSum: 0,
                        rsrpCount: 0,
                        rsrqSum: 0,
                        rsrqCount: 0,
                        earfcnVotes: {},
                        sampleCount: 0
                    };
                    row.sampleCount += 1;

                    const sampleTime = pciSamples[i].t;
                    const rsrp = nearestValueWithin(idxBucket.rsrp, sampleTime, alignMs);
                    if (Number.isFinite(rsrp)) {
                        row.rsrpSum += rsrp;
                        row.rsrpCount += 1;
                    }
                    const rsrq = nearestValueWithin(idxBucket.rsrq, sampleTime, alignMs);
                    if (Number.isFinite(rsrq)) {
                        row.rsrqSum += rsrq;
                        row.rsrqCount += 1;
                    }
                    const earfcn = nearestValueWithin(idxBucket.earfcn, sampleTime, alignMs);
                    if (Number.isFinite(earfcn)) {
                        // TRP neighbor EARFCN in this source is encoded on a x2 scale (e.g., 12600 -> 6300).
                        const e = Math.round(earfcn / 2);
                        row.earfcnVotes[e] = (row.earfcnVotes[e] || 0) + 1;
                    }

                    byPci.set(pci, row);
                }
            }

            const neighbors = Array.from(byPci.values())
                .map((row) => ({
                    pci: row.pci,
                    rsrp: row.rsrpCount ? Number((row.rsrpSum / row.rsrpCount).toFixed(1)) : null,
                    rsrq: row.rsrqCount ? Number((row.rsrqSum / row.rsrqCount).toFixed(1)) : null,
                    earfcn: (() => {
                        const entries = Object.entries(row.earfcnVotes || {});
                        if (!entries.length) return null;
                        entries.sort((a, b) => {
                            const ca = Number(a[1] || 0);
                            const cb = Number(b[1] || 0);
                            if (cb !== ca) return cb - ca;
                            return Number(a[0]) - Number(b[0]);
                        });
                        const raw = Number(entries[0][0]);
                        if (!Number.isFinite(raw)) return null;
                        if (servingEarfcnSet.size > 0 && !servingEarfcnSet.has(raw)) {
                            const half = raw / 2;
                            if (Number.isInteger(half) && servingEarfcnSet.has(half)) return half;
                        }
                        return raw;
                    })(),
                    sample_count: row.sampleCount
                }))
                .sort((a, b) => {
                    const ra = Number.isFinite(a.rsrp) ? a.rsrp : -999;
                    const rb = Number.isFinite(b.rsrp) ? b.rsrp : -999;
                    if (rb !== ra) return rb - ra;
                    if ((b.sample_count || 0) !== (a.sample_count || 0)) return (b.sample_count || 0) - (a.sample_count || 0);
                    return (a.pci || 0) - (b.pci || 0);
                });

            p.__lteTrpNeighborWindow = {
                window_ms: windowMs,
                neighbors
            };
        }
    }

function buildTrpPointsFromTrack(track, defaultMetricName, defaultSeries) {
        const points = (track || []).map((p, idx) => {
            const ts = toEpochMs(p.time);
            return {
                id: idx,
                lat: Number(p.lat),
                lng: Number(p.lon),
                time: p.time || '',
                timestamp: ts || 0,
                type: 'MEASUREMENT',
                level: -140,
                sc: null,
                ecno: null,
                cellId: 'N/A',
                properties: { source: 'trp_track' }
            };
        }).filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lng));

        if (defaultMetricName && Array.isArray(defaultSeries) && defaultSeries.length) {
            mapSeriesToPoints(points, defaultMetricName, defaultSeries);
            // If default isn't RSRP-like, still keep "level" populated for renderer if it relies on it
            const lowName = String(defaultMetricName).toLowerCase();
            if (!lowName.includes('rsrp') && !lowName.includes('rscp')) {
                for (const pt of points) {
                    const v = Number(pt[defaultMetricName]);
                    if (Number.isFinite(v)) { pt.level = v; }
                }
            }
        }
        return points;
    }


    async function injectRunIntoLoadedLogs(runId, fallbackFileName) {
        const loadedLogs = window.loadedLogs;
        const updateLogsList = window.updateLogsList;
        if (!Array.isArray(loadedLogs) || typeof updateLogsList !== 'function') {
            // fallback to existing detail modal if app sidebar internals are unavailable
            await openRunDetail(runId);
            return;
        }

        const [detail, catalog, sidebar] = await Promise.all([
            fetchRunDetail(runId),
            fetchRunCatalog(runId),
            fetchRunSidebar(runId)
        ]);

        const logId = `trp_run_${runId}`;
        const existsIdx = loadedLogs.findIndex(l => String(l.id) === logId);
        const defaults = (catalog && catalog.defaults) || {};
        const allMetrics = catalog.metricsFlat || [];
        const sampledMetrics = filterSampleBackedMetrics(allMetrics);
        const sidebarKpis = (sidebar && Array.isArray(sidebar.kpis)) ? sidebar.kpis : [];
        const sidebarMetricNames = sidebarKpis.map(k => k && k.name).filter(Boolean);
        const trpInfo = (sidebar && sidebar.info) ? sidebar.info : {};
        const sidebarNeighbors = (sidebar && Array.isArray(sidebar.neighbors)) ? sidebar.neighbors : [];

        const metricsForSelection = sampledMetrics.length ? sampledMetrics : allMetrics;
        let detectedTech = detectTrpTechnology(metricsForSelection, catalog.events || []);
        const orderedMetricNames = sidebarMetricNames.length
            ? sidebarMetricNames.slice()
            : buildTechMetricOrder(metricsForSelection, detectedTech);
        if (detectedTech === 'UMTS 3G') {
            const hasLte = orderedMetricNames.some(n => String(n).toLowerCase().includes('radio.lte') || String(n).toLowerCase().includes('rsrp') || String(n).toLowerCase().includes('rsrq'));
            if (hasLte) detectedTech = 'LTE';
        }
        const defaultCandidates = [defaults.rsrpMetricName, defaults.sinrMetricName, defaults.mosMetricName].filter(Boolean);
        const defaultMetricName = defaultCandidates.find(n => orderedMetricNames.includes(n)) || orderedMetricNames[0] || null;
        const defaultSeries = defaultMetricName ? await fetchSeries(runId, defaultMetricName) : [];
        const points = buildTrpPointsFromTrack(detail.track_points || [], defaultMetricName, defaultSeries);
        const servingEarfcnSet = await fetchServingEarfcnSet(runId, orderedMetricNames);

        if (String(detectedTech || '').toUpperCase().includes('LTE')) {
            try {
                const neighborCfg = getNeighborWindowConfig();
                await hydrateLteNeighborWindowContext(points, runId, sidebarNeighbors, {
                    ...neighborCfg,
                    servingEarfcnSet
                });
            } catch (e) {
                console.warn('[TRP][Neighbors] failed to build window context:', e);
            }
        }

        const coreFromFullList = pickCoreSidebarMetrics(orderedMetricNames, detectedTech);
        const orderedKpis = coreFromFullList.length
            ? coreFromFullList
            : (() => {
                const desiredOrder = ['RSRP', 'RSRQ', 'SINR', 'DL throughput', 'UL throughput'];
                const tmpLabels = buildFriendlyTrpLabels(sidebarMetricNames);
                return (sidebarMetricNames || []).slice().sort((a, b) => {
                    const la = tmpLabels[a] || a;
                    const lb = tmpLabels[b] || b;
                    const ia = desiredOrder.indexOf(la);
                    const ib = desiredOrder.indexOf(lb);
                    const sa = ia === -1 ? 999 : ia;
                    const sb = ib === -1 ? 999 : ib;
                    if (sa !== sb) return sa - sb;
                    return String(la).localeCompare(String(lb));
                }).slice(0, 5);
            })();

        const identifierMetrics = pickIdentifierMetrics(metricsForSelection);
        const appTpMetrics = pickApplicationThroughputMetrics(metricsForSelection);
        const infoFallback = buildInfoFallbackMetrics(trpInfo);

        // KPI buttons (top section) are the 5 requested KPIs, already ordered.
        const customMetrics = orderedKpis.slice();
        const labelMapForOrder = buildFriendlyTrpLabels(
            customMetrics.concat([appTpMetrics.dl, appTpMetrics.ul].filter(Boolean))
        );
        const insertAfterLabel = (metricName, anchorLabel) => {
            if (!metricName || customMetrics.includes(metricName)) return;
            let idx = -1;
            for (let i = 0; i < customMetrics.length; i++) {
                const lbl = labelMapForOrder[customMetrics[i]] || customMetrics[i];
                if (lbl === anchorLabel) idx = i;
            }
            if (idx >= 0) customMetrics.splice(idx + 1, 0, metricName);
            else customMetrics.push(metricName);
        };
        insertAfterLabel(appTpMetrics.dl, 'DL throughput');
        insertAfterLabel(appTpMetrics.ul, 'UL throughput');

        // Identifier buttons should be driven by real sample-backed series when possible (so legends show multiple unique values).
        // Only fall back to run-level info (__info_*) if no per-sample identifier metric exists.
        const identifierOrderLabels = [
            'Cellid',
            'Physical cell ID',
            'eNodeB ID',
            'Cell ID',
            'Downlink EARFCN',
            'Tracking area code'
        ];

        const idLabelsMap = buildFriendlyTrpLabels(identifierMetrics);
        const labelToMetric = {};
        identifierMetrics.forEach(n => {
            const lbl = idLabelsMap[n];
            if (lbl && !labelToMetric[lbl]) labelToMetric[lbl] = n;
        });

        const derivedMap = {};
        const trpInfoMetricValues = {};

        // Prefer a per-sample "Cellid / Cell Identity" metric as the base for derived IDs
        const cellidBaseMetric = labelToMetric['Cellid'] || null;

        const identifierKeys = [];
        identifierOrderLabels.forEach(lbl => {
            if (labelToMetric[lbl]) {
                identifierKeys.push(labelToMetric[lbl]);
                return;
            }
            // Derive eNodeB ID / Cell ID from Cellid/ECGI when direct series is missing.
            if ((lbl === 'eNodeB ID' || lbl === 'Cell ID') && cellidBaseMetric) {
                const k = (lbl === 'eNodeB ID') ? '__derived_enodeb_id' : '__derived_cell_id';
                identifierKeys.push(k);
                derivedMap[k] = { baseMetric: cellidBaseMetric, kind: (lbl === 'eNodeB ID') ? 'enodeb' : 'cell' };
                return;
            }
            // Fallback to constant run-level info only if we really have nothing else.
            const fbKey = (lbl === 'Cellid') ? '__info_cellid'
                : (lbl === 'Physical cell ID') ? '__info_pci'
                : (lbl === 'eNodeB ID') ? '__info_enodeb_id'
                : (lbl === 'Cell ID') ? '__info_cell_id'
                : (lbl === 'Downlink EARFCN') ? '__info_dl_earfcn'
                : (lbl === 'Tracking area code') ? '__info_tac'
                : null;
            if (fbKey && infoFallback.values && infoFallback.values[fbKey] !== undefined) {
                identifierKeys.push(fbKey);
                trpInfoMetricValues[fbKey] = infoFallback.values[fbKey];
            }
        });

        identifierKeys.forEach(k => {
            if (!customMetrics.includes(k)) customMetrics.push(k);
        });

        const trpMetricLabels = buildFriendlyTrpLabels(customMetrics);
        Object.assign(trpMetricLabels, infoFallback.labels);
        // Stamp fallback info values onto all points for __info_* metrics.
        if (Object.keys(trpInfoMetricValues).length) {
            for (const p of points) {
                for (const k of Object.keys(trpInfoMetricValues)) {
                    p[k] = trpInfoMetricValues[k];
                }
            }
        }
        const trpEventTypes = buildTechEventTypes(catalog.events || [], detectedTech);
        const logObj = {
            id: logId,
            name: (detail.run && detail.run.filename) || fallbackFileName || `TRP-${runId}`,
            points,
            signaling: [],
            events: detail.events || [],
            callSessions: [],
            tech: detectedTech,
            customMetrics,
            color: '#8b5cf6',
            visible: false,
            type: 'nmf',
            currentParam: defaultMetricName || 'level',
            trpRunId: runId,
            trpCatalog: catalog,
            trpEventTypes,
            trpMetricLabels,
            trpInfo,
            trpNeighborMetrics: sidebarNeighbors,
            trpAllMetricNames: orderedMetricNames.slice(),
            trpServingEarfcnSet: servingEarfcnSet.slice(),
            trpInfoMetricKeys: (identifierKeys || []).slice(),
            trpDerivedMap: derivedMap || {},
            trpInfoValues: { ...trpInfoMetricValues }
        };

        if (existsIdx >= 0) loadedLogs[existsIdx] = logObj;
        else loadedLogs.push(logObj);

        updateLogsList();

        if (window.map && points.length > 0 && window.L) {
            try {
                const bounds = window.L.latLngBounds(points.map(p => [p.lat, p.lng]));
                window.map.fitBounds(bounds);
            } catch (_e) {}
        }

        if (!customMetrics.length) {
            setStatus(`No samples decoded (decode failed or TRP contains no data).`);
        }
    }

    window.showTrpMetric = async (logId, metricName) => {
        try {
            const log = (window.loadedLogs || []).find(l => String(l.id) === String(logId));
            if (!log || !log.trpRunId) return;
            await openRunDetail(log.trpRunId);
            if (metricName) await selectKpiMetric(metricName);
        } catch (e) {
            alert('TRP metric view failed: ' + (e && e.message ? e.message : e));
        }
    };

    window.prepareTrpMetric = async (logId, metricName) => {
        const log = (window.loadedLogs || []).find(l => String(l.id) === String(logId));
        if (!log || !log.trpRunId || !metricName) return false;

        let series = null;

        // Derived identifier metrics (eNodeB ID / Cell ID) computed from a base Cellid/ECGI series
        if (log.trpDerivedMap && log.trpDerivedMap[metricName]) {
            const cfg = log.trpDerivedMap[metricName];
            const baseMetric = cfg && cfg.baseMetric;
            if (!baseMetric) return false;
            const baseSeries = await fetchSeries(log.trpRunId, baseMetric);
            if (!baseSeries || !baseSeries.length) return false;

            series = baseSeries.map(s => {
                const v = Number(s.value_num);
                if (!Number.isFinite(v)) return { time: s.time, value_num: null, value_str: s.value_str || null, metric_id: null };
                if (cfg.kind === 'enodeb') {
                    return { time: s.time, value_num: Math.floor(v / 256), value_str: null, metric_id: null };
                }
                if (cfg.kind === 'cell') {
                    return { time: s.time, value_num: (v % 256), value_str: null, metric_id: null };
                }
                return { time: s.time, value_num: v, value_str: null, metric_id: null };
            });
        } else if (String(metricName).startsWith('__info_')) {
            // Constant run-level info: values are already stamped onto points (if present).
            series = [];
        } else {
            series = await fetchSeries(log.trpRunId, metricName);
            if (!series || !series.length) return false;
        }

        if (series && series.length > 0) {
            const unique = new Set(series.map(s => (s.value !== undefined ? s.value : s.value_num)));
            if (unique.size === 1 && Number([...unique][0]) === 0) {
                console.warn('Ignoring zero-only metric:', metricName);
                return false;
            }
        }

        if (series && series.length) {
            mapSeriesToPoints(log.points || [], metricName, series);
        }

        // For LTE TRP points-details, preload serving/neighbor context metrics so clicking a map point
        // can immediately render Serving + Neighbors (PCI/RSRP/RSRQ/EARFCN) at the same timestamp.
        if (String(log.tech || '').toUpperCase().includes('LTE') && Array.isArray(log.customMetrics)) {
            const pointsRef = log.points || [];
            const hasMapped = (name) => pointsRef.some(p => p && p[name] !== undefined && p[name] !== null);
            const rank = (name) => {
                const n = String(name || '').toLowerCase();
                let s = 0;
                if (n.includes('radio.lte.servingcell')) s += 20;
                if (n.includes('radio.lte.neighbor')) s += 15;
                if (n.endsWith('.pci')) s += 8;
                if (n.endsWith('.rsrp')) s += 7;
                if (n.endsWith('.rsrq')) s += 6;
                if (n.includes('earfcn')) s += 5;
                return s;
            };
            const related = log.customMetrics
                .filter(m => {
                    const n = String(m || '').toLowerCase();
                    if (n === String(metricName || '').toLowerCase()) return false;
                    if (hasMapped(m)) return false;
                    const isServing = n.includes('radio.lte.servingcell');
                    const isNeighbor = n.includes('radio.lte.neighbor');
                    const isWanted = n.endsWith('.pci') || n.endsWith('.rsrp') || n.endsWith('.rsrq') || n.includes('earfcn') || n.includes('cellidentity');
                    return (isServing || isNeighbor) && isWanted;
                })
                .sort((a, b) => rank(b) - rank(a))
                .slice(0, 18);

            if (related.length) {
                const loaded = await Promise.all(related.map(async (m) => {
                    try {
                        const s = await fetchSeries(log.trpRunId, m);
                        return { m, s: Array.isArray(s) ? s : [] };
                    } catch (_e) {
                        return { m, s: [] };
                    }
                }));
                loaded.forEach(({ m, s }) => {
                    if (s && s.length) mapSeriesToPoints(pointsRef, m, s);
                });
            }
        }

        // For non-RSRP metrics, some renderers still use `level` as the active field.
        const lowName = String(metricName).toLowerCase();
        if (!lowName.includes('rsrp') && !lowName.includes('rscp')) {
            (log.points || []).forEach(p => {
                const v = Number(p[metricName]);
                if (Number.isFinite(v)) p.level = v;
            });
        }
        log.currentParam = metricName;
        return true;
    };

    window.showTrpEventTimeline = async (logId, eventName) => {
        try {
            const log = (window.loadedLogs || []).find(l => String(l.id) === String(logId));
            if (!log || !log.trpRunId) return;
            await openRunDetail(log.trpRunId);
            if (eventName) await selectEventType(eventName);
        } catch (e) {
            alert('TRP event view failed: ' + (e && e.message ? e.message : e));
        }
    };

    function renderSummary(run, catalog) {
        const start = run.start_time || 'n/a';
        const end = run.end_time || 'n/a';
        let duration = 'n/a';
        if (start !== 'n/a' && end !== 'n/a') {
            const a = new Date(start).getTime();
            const b = new Date(end).getTime();
            if (Number.isFinite(a) && Number.isFinite(b) && b >= a) {
                duration = ((b - a) / 1000).toFixed(1) + ' s';
            }
        }

        const md = run.metadata || {};
        const metricsCount = (catalog && Array.isArray(catalog.metricsFlat)) ? catalog.metricsFlat.length : 0;
        const eventTypesCount = (catalog && Array.isArray(catalog.events)) ? catalog.events.length : 0;
        qs('trpRunSummary').innerHTML = [
            `<div><b>Run #${escapeHtml(run.id)}</b> - ${escapeHtml(run.filename || '')}</div>`,
            `<div style="margin-top:6px;font-size:12px;">Imported: ${escapeHtml(run.imported_at || 'n/a')}</div>`,
            `<div style="margin-top:6px;font-size:12px;">Start: ${escapeHtml(start)}</div>`,
            `<div style="font-size:12px;">End: ${escapeHtml(end)}</div>`,
            `<div style="font-size:12px;">Duration: ${escapeHtml(duration)}</div>`,
            `<div style="margin-top:8px;font-size:12px;">KPI rows: ${escapeHtml(md.metric_count || 0)} | Event rows: ${escapeHtml(md.event_count || 0)} | Track: ${escapeHtml(md.track_points || 0)}</div>`,
            `<div style="font-size:12px;">Catalog: ${escapeHtml(metricsCount)} metrics, ${escapeHtml(eventTypesCount)} event types</div>`
        ].join('');
    }

    function renderMap(track) {
        const mapDiv = qs('trpRunMap');
        if (!mapDiv) return;
        if (!window.L) {
            mapDiv.innerHTML = '<div style="padding:12px;color:#cbd5e1;">Leaflet unavailable.</div>';
            return;
        }
        if (!trpLeafletMap) {
            trpLeafletMap = L.map(mapDiv, { zoomControl: true });
            L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                maxZoom: 19,
                attribution: '&copy; OpenStreetMap contributors'
            }).addTo(trpLeafletMap);
        }
        if (trpLeafletTrack) {
            trpLeafletMap.removeLayer(trpLeafletTrack);
            trpLeafletTrack = null;
        }

        const latlngs = (track || [])
            .filter(p => Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lon)))
            .map(p => [Number(p.lat), Number(p.lon)]);

        if (!latlngs.length) {
            mapDiv.innerHTML = '<div style="padding:12px;color:#cbd5e1;">No track found.</div>';
            return;
        }

        mapDiv.innerHTML = '';
        trpLeafletMap.invalidateSize();
        trpLeafletTrack = L.polyline(latlngs, { color: '#38bdf8', weight: 4, opacity: 0.9 }).addTo(trpLeafletMap);
        trpLeafletMap.fitBounds(trpLeafletTrack.getBounds(), { padding: [20, 20] });
    }

    function setMainTitle(text) {
        const t = qs('trpMainTitle');
        if (t) t.textContent = text;
    }

    function setMainMode(mode) {
        const kpiPane = qs('trpMainKpi');
        const eventsPane = qs('trpMainEvents');
        const select = qs('trpKpiSelect');
        if (!kpiPane || !eventsPane || !select) return;
        if (mode === 'events') {
            kpiPane.style.display = 'none';
            eventsPane.style.display = 'block';
            select.style.display = 'none';
        } else {
            kpiPane.style.display = 'block';
            eventsPane.style.display = 'block';
            eventsPane.style.display = 'none';
            select.style.display = 'inline-block';
        }
    }

    function setupKpiSelect(metricsFlat) {
        const select = qs('trpKpiSelect');
        if (!select) return;
        const names = (metricsFlat || []).map(m => m && m.name).filter(Boolean);
        select.innerHTML = names.map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('');
    }

    function renderCatalogPane() {
        const pane = qs('trpCatalogPane');
        const hint = qs('trpCatalogHint');
        const search = qs('trpCatalogSearch');
        const cat = trpState.catalog;
        if (!pane || !hint || !search || !cat) return;

        const q = String(search.value || '').trim().toLowerCase();
        const isKpi = trpState.sidebarTab === 'kpis';
        hint.textContent = isKpi ? 'KPI catalog (tree by metric path)' : 'Event catalog (grouped by prefix/category)';

        if (isKpi) {
            const flat = Array.isArray(cat.metricsFlat) ? cat.metricsFlat : [];
            if (q) {
                const hits = flat.filter(m => String(m.name || '').toLowerCase().includes(q));
                pane.innerHTML = hits.map(m => {
                    const stats = m.stats || {};
                    const chips = Number.isFinite(Number(stats.sample_count))
                        ? `<span style=\"font-size:11px;color:#7dd3fc;\">samples:${escapeHtml(stats.sample_count)}</span>`
                        : '';
                    return `<div class=\"trp-kpi-hit\" data-name=\"${escapeHtml(m.name)}\" style=\"padding:6px 8px;border-bottom:1px solid #1f3559;cursor:pointer;\">` +
                        `<div style=\"font-size:12px;color:#dbeafe;\">${escapeHtml(m.name)}</div>` +
                        `<div style=\"font-size:11px;color:#94a3b8;\">dtype:${escapeHtml(m.dtype || 'unknown')} ${chips}</div>` +
                        `</div>`;
                }).join('') || '<div style="padding:8px;color:#cbd5e1;">No KPI match.</div>';
                pane.querySelectorAll('.trp-kpi-hit').forEach(node => {
                    node.addEventListener('click', async () => {
                        const name = node.getAttribute('data-name');
                        if (name) await selectKpiMetric(name);
                    });
                });
                return;
            }
            pane.innerHTML = renderMetricsTreeHtml(cat.metricsTree || []);
            bindMetricsTreeHandlers(pane);
        } else {
            const grouped = cat.eventsGrouped || {};
            const sections = [];
            const roots = Object.keys(grouped).sort((a, b) => a.localeCompare(b));
            roots.forEach(root => {
                const rows = grouped[root] || [];
                const filtered = q ? rows.filter(r => String(r.event_name || '').toLowerCase().includes(q)) : rows;
                if (!filtered.length) return;
                sections.push(`<div style=\"padding:6px 8px;font-size:12px;font-weight:700;color:#93c5fd;\">${escapeHtml(root)}</div>`);
                filtered.forEach(r => {
                    sections.push(`<div class=\"trp-event-type-hit\" data-name=\"${escapeHtml(r.event_name)}\" style=\"padding:6px 10px;border-bottom:1px solid #1f3559;cursor:pointer;display:flex;justify-content:space-between;gap:8px;\">` +
                        `<span style=\"font-size:12px;color:#dbeafe;\">${escapeHtml(r.event_name)}</span>` +
                        `<span style=\"font-size:11px;color:#7dd3fc;\">${escapeHtml(r.count || 0)}</span>` +
                        `</div>`);
                });
            });
            pane.innerHTML = sections.join('') || '<div style="padding:8px;color:#cbd5e1;">No event match.</div>';
            pane.querySelectorAll('.trp-event-type-hit').forEach(node => {
                node.addEventListener('click', async () => {
                    const name = node.getAttribute('data-name');
                    if (name) await selectEventType(name);
                });
            });
        }
    }

    function renderMetricsTreeHtml(nodes, depth) {
        const d = Number.isFinite(depth) ? depth : 0;
        return (nodes || []).map(node => {
            if (node.type === 'folder') {
                return `<details ${d < 1 ? 'open' : ''} style=\"margin-left:${d * 12}px;\">` +
                    `<summary style=\"cursor:pointer;color:#93c5fd;font-size:12px;\">${escapeHtml(node.label)}</summary>` +
                    `${renderMetricsTreeHtml(node.children || [], d + 1)}` +
                    `</details>`;
            }
            const metric = node.metric || {};
            const stats = metric.stats || {};
            const chip = Number.isFinite(Number(stats.sample_count))
                ? `<span style=\"margin-left:6px;font-size:10px;color:#7dd3fc;\">${escapeHtml(stats.sample_count)}</span>`
                : '';
            return `<div class=\"trp-tree-metric\" data-name=\"${escapeHtml(metric.name || '')}\" style=\"margin-left:${d * 12}px;padding:4px 6px;cursor:pointer;border-radius:4px;color:#dbeafe;font-size:12px;\">${escapeHtml(node.label)}${chip}</div>`;
        }).join('');
    }

    function bindMetricsTreeHandlers(container) {
        container.querySelectorAll('.trp-tree-metric').forEach(el => {
            el.addEventListener('click', async () => {
                const name = el.getAttribute('data-name');
                if (!name) return;
                await selectKpiMetric(name);
            });
        });
    }

    async function fetchSeries(runId, name) {
        const cacheKey = String(runId) + '::' + String(name || '');
        if (trpSeriesCache.has(cacheKey)) {
            return trpSeriesCache.get(cacheKey);
        }
        const request = (async () => {
        const isNeighborMetric = /^Radio\.Lte\.Neighbor\[\d+\]\./i.test(String(name || ''));
        // Verification trace:
        // click a Neighbors button (e.g., N1 RSRP) and confirm this request is logged
        // with /api/runs/<runId>/kpi?name=Radio.Lte.Neighbor[1].Rsrp
        if (isNeighborMetric) {
            console.log('[Neighbors] requesting KPI series:', '/api/runs/' + encodeURIComponent(runId) + '/kpi?name=' + encodeURIComponent(name));
        }
        const { res, payload: data } = await fetchJsonWithApiFallback('/api/runs/' + encodeURIComponent(runId) + '/kpi?name=' + encodeURIComponent(name));
        if (!res.ok || data.status !== 'success') throw new Error(data.message || ('HTTP ' + res.status));
        const series = data.series || [];
        if (isNeighborMetric) {
            console.log('[Neighbors] received samples:', series.length, 'for', name);
        }
        return series;
        })();
        trpSeriesCache.set(cacheKey, request);
        return request;
    }

    async function fetchEvents(runId, eventName) {
        let path = '/api/runs/' + encodeURIComponent(runId) + '/events?limit=5000';
        if (eventName) path += '&name=' + encodeURIComponent(eventName);
        const { res, payload: data } = await fetchJsonWithApiFallback(path);
        if (!res.ok || data.status !== 'success') throw new Error(data.message || ('HTTP ' + res.status));
        return data.events || [];
    }

    async function fetchSignals(runId) {
        const { res, payload: data } = await fetchJsonWithApiFallback('/api/runs/' + encodeURIComponent(runId) + '/signals');
        if (!res.ok || data.status !== 'success') throw new Error(data.message || ('HTTP ' + res.status));
        return data.signals || [];
    }

    async function fetchTimeseries(runId, signal) {
        const { res, payload: data } = await fetchJsonWithApiFallback('/api/runs/' + encodeURIComponent(runId) + '/timeseries?signal=' + encodeURIComponent(signal));
        if (!res.ok || data.status !== 'success') throw new Error(data.message || ('HTTP ' + res.status));
        return data.series || [];
    }

    async function fetchTrack(runId) {
        const { res, payload: data } = await fetchJsonWithApiFallback('/api/runs/' + encodeURIComponent(runId) + '/track');
        if (!res.ok || data.status !== 'success') throw new Error(data.message || ('HTTP ' + res.status));
        return data.track || [];
    }

    // Expose helpers for cross-module consumers (sidebar throughput analysis).
    window.trpFetchSeries = fetchSeries;
    window.trpFetchEvents = fetchEvents;
    window.trpFetchCatalog = fetchRunCatalog;
    window.trpFetchSignals = fetchSignals;
    window.trpFetchTimeseries = fetchTimeseries;
    window.trpFetchTrack = fetchTrack;

    async function selectKpiMetric(name) {
        trpState.selectedMetric = name;
        trpState.selectedEventName = null;
        setMainMode('kpi');
        setMainTitle('KPI: ' + name);
        const select = qs('trpKpiSelect');
        if (select && select.value !== name) select.value = name;
        await renderKpiChart(trpState.runId, [name]);
    }

    async function selectEventType(name) {
        trpState.selectedEventName = name;
        trpState.selectedMetric = null;
        setMainMode('events');
        setMainTitle('Events: ' + name);
        const label = qs('trpSelectedEventLabel');
        if (label) label.textContent = 'Timeline for event type: ' + name;
        try {
            trpState.eventRows = await fetchEvents(trpState.runId, name);
            renderEventRows(trpState.eventRows);
        } catch (err) {
            const list = qs('trpEventsList');
            if (list) list.innerHTML = `<div style=\"padding:8px;color:#fca5a5;\">Failed to load events: ${escapeHtml(err && err.message ? err.message : err)}</div>`;
        }
    }

    function renderEventRows(events) {
        const list = qs('trpEventsList');
        const params = qs('trpEventParams');
        if (!list || !params) return;

        list.innerHTML = (events || []).map((e, idx) =>
            `<div class="trp-event-item" data-idx="${idx}" style="padding:6px 8px;border-bottom:1px solid #22334f;cursor:pointer;">` +
            `<div style="font-size:11px;color:#94a3b8;">${escapeHtml(e.time || '')}</div>` +
            `<div style="font-size:12px;color:#e2e8f0;">${escapeHtml(e.event_name || '')}</div>` +
            `</div>`
        ).join('') || '<div style="padding:8px;color:#cbd5e1;">No events found.</div>';

        params.textContent = 'Click an event to view params';
        list.querySelectorAll('.trp-event-item').forEach((n, i) => {
            n.addEventListener('click', () => {
                const e = (events || [])[i] || {};
                params.textContent = JSON.stringify(e.params || [], null, 2);
            });
        });
    }

    async function renderKpiChart(runId, kpiNames) {
        const canvas = qs('trpKpiChart');
        if (!canvas || !window.Chart) return;

        const colors = ['#38bdf8', '#22c55e', '#f59e0b', '#ef4444', '#a78bfa'];
        const datasets = [];

        for (let i = 0; i < kpiNames.length; i++) {
            const name = kpiNames[i];
            try {
                const series = await fetchSeries(runId, name);
                const pointsRaw = series
                    .filter(r => Number.isFinite(Number(r.value_num)))
                    .map(r => ({ x: String(r.time || ''), y: Number(r.value_num) }));
                const norm = normalizeThroughputSeries(name, pointsRaw);
                const points = norm.points;
                datasets.push({
                    label: norm.yLabel ? `${name} (${norm.yLabel})` : name,
                    data: points,
                    borderColor: colors[i % colors.length],
                    backgroundColor: colors[i % colors.length],
                    borderWidth: 2,
                    pointRadius: 0,
                    tension: 0.2
                });
            } catch (err) {
                console.error('KPI load error', name, err);
            }
        }

        if (trpChart) {
            trpChart.destroy();
            trpChart = null;
        }

        const ctx = canvas.getContext('2d');
        trpChart = new Chart(ctx, {
            type: 'line',
            data: { datasets },
            options: {
                parsing: false,
                normalized: true,
                maintainAspectRatio: false,
                scales: {
                    x: {
                        type: 'category',
                        ticks: { color: '#cbd5e1' },
                        grid: { color: 'rgba(148,163,184,0.25)' }
                    },
                    y: {
                        ticks: { color: '#cbd5e1' },
                        grid: { color: 'rgba(148,163,184,0.25)' }
                    }
                },
                plugins: {
                    legend: { labels: { color: '#e2e8f0' } },
                    title: { display: false }
                }
            }
        });
    }

    window.trpBuildApiUrl = buildApiUrl;
    window.trpGetApiBase = () => trpApiBase;
    window.trpSetApiBase = (url) => setApiBase(url);
    window.setOptimApiBase = (url) => setApiBase(url);

    initApiBase();

    document.addEventListener('DOMContentLoaded', async () => {
        ensureTrpControls();
        const path = String(window.location.pathname || '');
        const hash = String(window.location.hash || '');
        const m = path.match(/^\/runs\/(\d+)$/);
        const mh = hash.match(/^#\/runs\/(\d+)$/);
        if (m) await openRunDetail(Number(m[1]));
        else if (mh) await openRunDetail(Number(mh[1]));
        else if (path === '/runs' || hash === '#/runs' || hash === '#runs') {
            await openRunsList();
        }
    });
})();

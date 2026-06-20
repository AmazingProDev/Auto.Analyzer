document.addEventListener('DOMContentLoaded', () => {
    const modal = document.getElementById('localAiModal');
    const openBtn = document.getElementById('btnLocalAiAnalysis');
    const closeBtn = document.getElementById('localAiCloseBtn');
    const refreshBtn = document.getElementById('localAiRefreshBtn');
    const chooseFileBtn = document.getElementById('localAiChooseFileBtn');
    const useLoadedBtn = document.getElementById('localAiUseLoadedBtn');
    const form = document.getElementById('localAiUploadForm');
    const fileInput = document.getElementById('localAiFileInput');
    const analyzeBtn = document.getElementById('localAiAnalyzeBtn');
    const selectedFile = document.getElementById('localAiSelectedFile');
    const healthBadge = document.getElementById('localAiHealthBadge');
    const healthText = document.getElementById('localAiHealthText');
    const modelBadge = document.getElementById('localAiModelBadge');
    const modelText = document.getElementById('localAiModelText');
    const progressText = document.getElementById('localAiProgressText');
    const progressValue = document.getElementById('localAiProgressValue');
    const progressBar = document.getElementById('localAiProgressBar');
    const errorBox = document.getElementById('localAiErrorBox');
    const resultsEl = document.getElementById('localAiResults');
    const fileStatus = document.getElementById('fileStatus');

    if (!modal || !openBtn || !closeBtn || !form || !fileInput || !analyzeBtn || !resultsEl) {
        return;
    }

    let stagedSource = null;

    const escapeHtml = (value) => String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

    const setBadgeState = (element, text, state) => {
        if (!element) return;
        element.textContent = text;
        element.classList.remove('is-pending', 'is-ok', 'is-error');
        element.classList.add(state || 'is-pending');
    };

    const setProgress = (percent, label) => {
        const value = Math.max(0, Math.min(100, Number(percent) || 0));
        if (progressBar) progressBar.style.width = `${value}%`;
        if (progressValue) progressValue.textContent = `${Math.round(value)}%`;
        if (progressText && label) progressText.textContent = label;
    };

    const showError = (message) => {
        if (!errorBox) return;
        const text = String(message || '').trim();
        errorBox.hidden = !text;
        errorBox.textContent = text;
    };

    const renderSimpleEmptyState = (message) => {
        resultsEl.innerHTML = `<div class="local-ai-results-empty">${escapeHtml(message)}</div>`;
    };

    const buildFlatPairs = (obj, prefix = '', depth = 0, out = []) => {
        if (!obj || typeof obj !== 'object' || depth > 2) return out;
        Object.entries(obj).forEach(([key, value]) => {
            const nextKey = prefix ? `${prefix}.${key}` : key;
            if (value === null || value === undefined || value === '') return;
            if (typeof value === 'object' && !Array.isArray(value)) {
                buildFlatPairs(value, nextKey, depth + 1, out);
                return;
            }
            if (Array.isArray(value)) {
                const compact = value
                    .filter((item) => item !== null && item !== undefined && item !== '')
                    .slice(0, 8)
                    .map((item) => typeof item === 'object' ? JSON.stringify(item) : String(item).trim())
                    .filter(Boolean)
                    .join(',');
                if (compact) out.push([nextKey, compact]);
                return;
            }
            if (['string', 'number', 'boolean'].includes(typeof value)) {
                const text = String(value).trim();
                if (text) out.push([nextKey, text]);
            }
        });
        return out;
    };

    const getPreferredLoadedLog = () => {
        const logs = Array.isArray(window.loadedLogs) ? window.loadedLogs : [];
        if (!logs.length) return null;
        const activeId = window.mapRenderer && window.mapRenderer.activeLogId ? String(window.mapRenderer.activeLogId) : '';
        if (activeId) {
            const active = logs.find((item) => String(item && item.id) === activeId);
            if (active) return active;
        }
        return logs[logs.length - 1] || null;
    };

    const buildTextFromLoadedLog = (log) => {
        if (!log || typeof log !== 'object') {
            throw new Error('No loaded log is available to analyze.');
        }
        const lines = [];
        const pushLine = (prefix, obj, extra = {}) => {
            const pairs = buildFlatPairs({ ...obj, ...extra })
                .filter(([key]) => !/^(_|color$|visible$|currentParam$|configHistory$|points$|signaling$|events$|customMetrics$)/i.test(key))
                .slice(0, 40)
                .map(([key, value]) => `${key}=${value}`);
            if (pairs.length) lines.push(`${prefix} ${pairs.join(' | ')}`);
        };

        lines.push(`# Optim Analyzer loaded-log export`);
        lines.push(`# log_name=${log.name || 'Unnamed'} | tech=${log.tech || 'Unknown'} | points=${Array.isArray(log.points) ? log.points.length : 0} | signaling=${Array.isArray(log.signaling) ? log.signaling.length : 0} | events=${Array.isArray(log.events) ? log.events.length : 0}`);

        (Array.isArray(log.signaling) ? log.signaling : []).forEach((row, index) => {
            pushLine('[SIGNALING]', row, { row_index: index + 1 });
        });
        (Array.isArray(log.events) ? log.events : []).forEach((row, index) => {
            pushLine('[EVENT]', row, { row_index: index + 1 });
        });
        (Array.isArray(log.points) ? log.points : []).forEach((row, index) => {
            pushLine('[POINT]', row, { row_index: index + 1 });
        });

        return {
            fileName: `${String(log.name || 'loaded-log').replace(/[^\w.-]+/g, '_')}.txt`,
            text: lines.join('\n'),
            label: `Loaded log: ${log.name || 'Unnamed log'}`,
        };
    };

    const renderTextList = (items, emptyText) => {
        const values = Array.isArray(items) ? items.filter(Boolean) : [];
        if (!values.length) {
            return `<div class="local-ai-pill-item">${escapeHtml(emptyText)}</div>`;
        }
        return values.map((item) => `<div class="local-ai-pill-item">${escapeHtml(item)}</div>`).join('');
    };

    const renderCauseList = (items) => {
        const values = Array.isArray(items) ? items : [];
        if (!values.length) {
            return `<div class="local-ai-cause-item">No strong recurring cause was detected across the analyzed chunks.</div>`;
        }
        return values.map((item) => {
            const cause = escapeHtml(item.cause || 'Unknown');
            const count = escapeHtml(String(item.count ?? 0));
            const confidence = escapeHtml(item.top_confidence || 'low');
            return `<div class="local-ai-cause-item"><strong>${cause}</strong><br>Seen in ${count} chunk(s) • top confidence ${confidence}</div>`;
        }).join('');
    };

    const formatFailureDomain = (value) => {
        const key = String(value || 'unknown').trim().toLowerCase();
        const labels = {
            radio_coverage: 'Radio coverage',
            radio_interference: 'Radio interference / quality',
            mobility: 'Mobility / handover',
            congestion: 'Congestion / admission',
            core_signaling: 'Core / signaling',
            policy_or_network_release: 'Policy / network-initiated release',
            device_or_ue: 'Device / UE',
            unknown: 'Unknown / insufficient evidence',
        };
        return labels[key] || labels.unknown;
    };

    const renderTriggerList = (items) => {
        const values = Array.isArray(items) ? items : [];
        if (!values.length) {
            return `<div class="local-ai-cause-item">No dominant trigger event was extracted.</div>`;
        }
        return values.map((item) => {
            const trigger = escapeHtml(item.trigger || 'Unknown trigger');
            const count = escapeHtml(String(item.count ?? 0));
            const confidence = escapeHtml(item.top_confidence || 'low');
            return `<div class="local-ai-cause-item"><strong>${trigger}</strong><br>Seen in ${count} chunk(s) • top confidence ${confidence}</div>`;
        }).join('');
    };

    const renderDomainList = (items) => {
        const values = Array.isArray(items) ? items : [];
        if (!values.length) {
            return `<div class="local-ai-cause-item">No dominant failure domain was extracted.</div>`;
        }
        return values.map((item) => {
            const label = escapeHtml(formatFailureDomain(item.domain || item.label));
            const count = escapeHtml(String(item.count ?? 0));
            const confidence = escapeHtml(item.top_confidence || 'low');
            return `<div class="local-ai-cause-item"><strong>${label}</strong><br>Seen in ${count} chunk(s) • top confidence ${confidence}</div>`;
        }).join('');
    };

    const formatIdentifierSummary = (identifiers) => {
        if (!identifiers || typeof identifiers !== 'object') return 'No identifiers detected';
        const bits = [];
        ['imsi', 'ue', 'cell', 'bearer', 'cause_codes', 'session'].forEach((key) => {
            const values = Array.isArray(identifiers[key]) ? identifiers[key] : [];
            if (values.length) {
                bits.push(`${key}: ${values.slice(0, 3).join(', ')}`);
            }
        });
        return bits.length ? bits.join(' | ') : 'No identifiers detected';
    };

    const renderChunkCards = (items) => {
        const values = Array.isArray(items) ? items : [];
        if (!values.length) {
            return `<div class="local-ai-chunk-card"><div class="local-ai-chunk-body">No chunk analyses were returned.</div></div>`;
        }
        return values.map((item, index) => {
            const statusChip = item.status === 'error'
                ? `<span class="local-ai-chip is-error">Chunk error</span>`
                : `<span class="local-ai-chip">Confidence ${escapeHtml(item.confidence || 'n/a')}</span>`;
            const ratChip = `<span class="local-ai-chip">RAT ${escapeHtml(item.rat_hint || item.suspected_rat || 'unknown')}</span>`;
            const timeChip = `<span class="local-ai-chip">${escapeHtml(item.start_timestamp || 'N/A')} → ${escapeHtml(item.end_timestamp || 'N/A')}</span>`;
            const summary = escapeHtml(item.summary || 'No summary available.');
            const rootCause = escapeHtml(item.likely_root_cause || item.error || 'Unknown');
            const triggerEvent = escapeHtml(item.trigger_event || 'No trigger extracted.');
            const failureDomain = escapeHtml(formatFailureDomain(item.failure_domain));
            const evidenceHtml = renderTextList(item.evidence, 'No deterministic evidence was retained for this chunk.');
            const anomalyHtml = renderTextList(item.anomalies, 'No anomalies listed for this chunk.');
            const nextChecksHtml = renderTextList(item.next_checks, 'No follow-up checks suggested for this chunk.');
            const confidenceRationale = escapeHtml(item.confidence_rationale || 'No explicit confidence rationale returned.');
            
            const chartId = `localAiChart_${index}`;
            if (item.radio_series && item.radio_series.length > 0) {
                window._pendingLocalAiCharts.push({ id: chartId, series: item.radio_series, signalSeries: item.signal_series || [] });
            }

            let neighborHtml = '';
            if (item.neighbor_series && item.neighbor_series.length > 0) {
                 neighborHtml = `<table class="local-ai-table">
                     <thead><tr><th>Time</th><th>Serving PSC/PCI</th><th>Candidate PSC/PCI</th><th>dRSCP (dB)</th><th>dEcNo (dB)</th></tr></thead>
                     <tbody>
                         ${item.neighbor_series.map(r => `<tr>
                             <td>${escapeHtml(r.time || '')}</td>
                             <td>${escapeHtml(r.serving_sc || '')}</td>
                             <td style="font-weight: bold;">${escapeHtml(r.candidate_sc || '')}</td>
                             <td>${r.delta_rscp != null ? r.delta_rscp : '-'}</td>
                             <td>${r.delta_ecno != null ? r.delta_ecno : '-'}</td>
                         </tr>`).join('')}
                     </tbody>
                 </table>`;
            }

            return `
                <div class="local-ai-chunk-card">
                    <div class="local-ai-chunk-meta">
                        <span class="local-ai-chip">${escapeHtml(item.chunk_id || 'chunk')}</span>
                        ${ratChip}
                        ${timeChip}
                        ${statusChip}
                    </div>
                    <h4>${escapeHtml(item.chunk_id || 'Chunk')}</h4>
                    <div class="local-ai-chunk-body">
                        <div><span class="local-ai-inline-label">Summary:</span> ${summary}</div>
                        <div class="local-ai-inline-list">
                            <div><span class="local-ai-inline-label">Trigger event:</span> ${triggerEvent}</div>
                            <div><span class="local-ai-inline-label">Failure domain:</span> ${failureDomain}</div>
                            <div><span class="local-ai-inline-label">Likely root cause:</span> ${rootCause}</div>
                            <div><span class="local-ai-inline-label">Identifiers:</span> ${escapeHtml(formatIdentifierSummary(item.identifiers))}</div>
                            <div><span class="local-ai-inline-label">Confidence rationale:</span> ${confidenceRationale}</div>
                        </div>
                    </div>

                    ${(item.radio_series && item.radio_series.length > 0) ? `
                    <div class="local-ai-inline-list">
                        <div><span class="local-ai-inline-label">Radio Context Timeline</span></div>
                        <div class="local-ai-chart-wrapper" style="position: relative; height: 180px; width: 100%; margin-top: 5px;">
                            <canvas id="${chartId}"></canvas>
                        </div>
                    </div>` : ''}

                    ${neighborHtml ? `
                    <div class="local-ai-inline-list">
                        <div><span class="local-ai-inline-label">Neighbor Candidates</span></div>
                        <div class="local-ai-table-container">${neighborHtml}</div>
                    </div>` : ''}

                    <div class="local-ai-inline-list">
                        <div><span class="local-ai-inline-label">Evidence</span></div>
                        <div class="local-ai-pill-list">${evidenceHtml}</div>
                    </div>
                    <div class="local-ai-inline-list">
                        <div><span class="local-ai-inline-label">Anomalies</span></div>
                        <div class="local-ai-pill-list">${anomalyHtml}</div>
                    </div>
                    <div class="local-ai-inline-list">
                        <div><span class="local-ai-inline-label">Next checks</span></div>
                        <div class="local-ai-pill-list">${nextChecksHtml}</div>
                    </div>
                </div>
            `;
        }).join('');
    };

    const getDomainColorClass = (domainLabel) => {
        const lower = String(domainLabel || '').toLowerCase();
        if (lower.includes('coverage')) return 'domain-red';
        if (lower.includes('interference') || lower.includes('pollution')) return 'domain-orange';
        if (lower.includes('core') || lower.includes('signaling')) return 'domain-purple';
        if (lower.includes('mobility')) return 'domain-blue';
        return 'domain-gray';
    };

    const renderResults = (payload) => {
        window._pendingLocalAiCharts = [];
        const preprocessing = payload.preprocessing || {};
        const report = payload.report || {};
        const stats = report.stats || {};
        const summary = escapeHtml(report.overall_summary || 'No overall summary returned.');
        const requestId = escapeHtml(payload.requestId || 'n/a');
        const detectedRat = escapeHtml(report.detected_rat || preprocessing.detectedRat || 'unknown');
        const chunkCount = escapeHtml(String(preprocessing.chunkCount ?? stats.total_chunks ?? 0));
        
        const dominantDomain = report.dominant_failure_domain || null;
        let originalDomainRaw = dominantDomain ? (dominantDomain.domain || dominantDomain.label) : '';
        const dominantDomainText = dominantDomain ? escapeHtml(formatFailureDomain(originalDomainRaw)) : 'Unknown / insufficient evidence';
        const domainColor = getDomainColorClass(originalDomainRaw);

        const partialFailures = Array.isArray(report.partial_failures) ? report.partial_failures : [];
        const chunkSummaries = Array.isArray(report.chunk_summaries) ? report.chunk_summaries : [];
        const showChunkSummaries = chunkSummaries.length > 0;
        
        let triggerHtml = renderTriggerList(report.trigger_events);
        if (!triggerHtml) triggerHtml = '<div style="color:#94a3b8; font-style:italic;">No triggers identified.</div>';

        const rootCauseText = Array.isArray(report.likely_causes) && report.likely_causes.length > 0 
            ? escapeHtml(report.likely_causes.map(item => typeof item === 'object' ? item.cause || item.description : item).join(' '))
            : 'No root cause identified.';

        resultsEl.innerHTML = `
            <div class="local-ai-executive-banner">
                <div class="local-ai-banner-header">
                    <div style="display: flex; gap: 12px; align-items: center;">
                        <span class="local-ai-domain-badge ${domainColor}">${dominantDomainText}</span>
                        <span style="color: #64748b; font-size: 13px;">RAT: ${detectedRat}</span>
                    </div>
                </div>
                <div style="font-size: 18px; font-weight: 600; line-height: 1.4; color: #f8fafc;">
                    ${summary}
                </div>
                <div class="local-ai-root-cause-box">
                    <span style="color: #38bdf8; font-weight: 700; text-transform: uppercase; font-size: 11px; letter-spacing: 0.1em; display: block; margin-bottom: 6px;">Likely Root Cause</span>
                    ${rootCauseText}
                </div>
            </div>

            <div class="local-ai-dashboard-grid">
                <div class="local-ai-artifact-section">
                    <div class="local-ai-artifact-header">Observed Triggers</div>
                    <div class="local-ai-artifact-content" style="padding: 12px;">
                        <div class="local-ai-cause-list">${triggerHtml}</div>
                    </div>
                </div>
                <div class="local-ai-artifact-section">
                    <div class="local-ai-artifact-header">Secondary Domains</div>
                    <div class="local-ai-artifact-content" style="padding: 12px;">
                        <div class="local-ai-cause-list">${renderDomainList(report.failure_domains)}</div>
                    </div>
                </div>
            </div>

            <div class="local-ai-artifact-section">
                <div class="local-ai-artifact-header">System Engineering Evidence</div>
                <div class="local-ai-artifact-content">
                    ${(report.evidence || []).length > 0 ? 
                        report.evidence.map(e => `<div class="local-ai-evidence-pill">${escapeHtml(typeof e === 'object' ? e.description || JSON.stringify(e) : e)}</div>`).join('') 
                        : '<div style="color:#94a3b8; font-size: 13px;">No evidence logged.</div>'
                    }
                </div>
            </div>

            <div class="local-ai-dashboard-grid">
                <div class="local-ai-artifact-section">
                    <div class="local-ai-artifact-header">Anomalies Detected</div>
                    <div class="local-ai-artifact-content">
                        ${(report.anomalies || []).length > 0 ? 
                            report.anomalies.map(a => `<div class="local-ai-evidence-pill" style="border-left: 2px solid #fbbf24;">${escapeHtml(typeof a === 'object' ? a.description || JSON.stringify(a) : a)}</div>`).join('') 
                            : '<div style="color:#94a3b8; font-size: 13px;">No anomalies highlighted.</div>'
                        }
                    </div>
                </div>
                <div class="local-ai-artifact-section">
                    <div class="local-ai-artifact-header">Next Actionable Checks</div>
                    <div class="local-ai-artifact-content">
                        ${(report.recommended_next_checks || []).length > 0 ? 
                            report.recommended_next_checks.map(c => `<div class="local-ai-evidence-pill" style="border-left: 2px solid #34d399;">${escapeHtml(typeof c === 'object' ? c.action || c.check || JSON.stringify(c) : c)}</div>`).join('') 
                            : '<div style="color:#94a3b8; font-size: 13px;">No next checks suggested.</div>'
                        }
                    </div>
                </div>
            </div>

            ${partialFailures.length ? `
                <div class="local-ai-artifact-section" style="border-color: rgba(248,113,113,0.3);">
                    <div class="local-ai-artifact-header" style="color: #fca5a5;">Partial Process Failures</div>
                    <div class="local-ai-artifact-content">
                        ${partialFailures.map(item => `<div class="local-ai-evidence-pill" style="color: #fca5a5;">${escapeHtml(item.chunkId)}: ${escapeHtml(item.message)}</div>`).join('')}
                    </div>
                </div>
            ` : ''}

            ${showChunkSummaries ? `
                <div class="local-ai-artifact-section">
                    <div class="local-ai-artifact-header">Diagnostic Chunk Summaries & Diagrams</div>
                    <div class="local-ai-artifact-content" style="padding: 12px; display: grid; gap: 16px;">
                        ${renderChunkCards(chunkSummaries)}
                    </div>
                </div>
            ` : ''}
        `;
    };

    const updateSelectedFile = () => {
        const file = fileInput.files && fileInput.files[0];
        if (!file) {
            if (stagedSource) {
                const suffix = stagedSource.kind === 'loaded-log'
                    ? 'prepared from currently loaded app data'
                    : 'prepared issue-focused bundle';
                selectedFile.textContent = `${stagedSource.label} • ${suffix}`;
                analyzeBtn.disabled = false;
                return;
            }
            selectedFile.textContent = 'No file selected. You can also analyze the log already loaded in the app.';
            analyzeBtn.disabled = true;
            return;
        }
        stagedSource = null;
        selectedFile.textContent = `${file.name} • ${(file.size / 1024 / 1024).toFixed(2)} MB`;
        analyzeBtn.disabled = false;
    };

    const fetchJson = async (url, options) => {
        const response = await fetch(url, options);
        let payload = null;
        try {
            payload = await response.json();
        } catch (_error) {
            payload = null;
        }
        return { response, payload };
    };

    const refreshStatus = async () => {
        setBadgeState(healthBadge, 'Checking…', 'is-pending');
        setBadgeState(modelBadge, 'Checking…', 'is-pending');
        healthText.textContent = 'Checking local AI server reachability…';
        modelText.textContent = 'Checking whether the configured model is loaded…';
        try {
            const [healthResult, modelResult] = await Promise.all([
                fetchJson('/api/local-ai/health'),
                fetchJson('/api/local-ai/model-check'),
            ]);
            const health = (healthResult.payload || {}).health || {};
            const model = (modelResult.payload || {}).model || {};
            setBadgeState(healthBadge, health.ok ? 'Reachable' : 'Unavailable', health.ok ? 'is-ok' : 'is-error');
            setBadgeState(modelBadge, model.ok ? 'Loaded' : 'Missing', model.ok ? 'is-ok' : 'is-error');
            healthText.textContent = health.message || 'No health details returned.';
            modelText.textContent = model.message || 'No model details returned.';
            const backendName = health.backend === 'ollama' ? 'Ollama' : health.backend === 'lmstudio' ? 'LM Studio' : 'Local AI';
            const backendLabelEl = document.getElementById('localAiBackendLabel');
            if (backendLabelEl) backendLabelEl.textContent = backendName;
            const titleEl = document.getElementById('localAiModalTitle');
            if (titleEl) titleEl.textContent = (health.backend === 'ollama' ? 'Ollama' : health.backend === 'lmstudio' ? 'LM Studio' : 'Local AI') + ' Analysis';
            const subtitleEl = document.getElementById('localAiModalSubtitle');
            if (subtitleEl) subtitleEl.textContent = `All logfile data stays on your Mac and is sent only to your local ${backendName} server.`;
        } catch (error) {
            setBadgeState(healthBadge, 'Unavailable', 'is-error');
            setBadgeState(modelBadge, 'Unknown', 'is-error');
            healthText.textContent = error && error.message ? error.message : 'Failed to query local AI endpoints.';
            modelText.textContent = 'Refresh status once Ollama is running and the model is loaded.';
        }
    };

    const openModal = async () => {
        modal.style.display = 'flex';
        showError('');
        setProgress(0, 'Idle');
        updateSelectedFile();
        await refreshStatus();
    };

    const closeModal = () => {
        modal.style.display = 'none';
    };

    const runAnalysis = async () => {
        const file = fileInput.files && fileInput.files[0];
        if (!file && !stagedSource) {
            showError('Choose a plain-text logfile or use the loaded log already imported in the app.');
            return false;
        }
        analyzeBtn.disabled = true;
        refreshBtn.disabled = true;
        if (chooseFileBtn) chooseFileBtn.disabled = true;
        if (useLoadedBtn) useLoadedBtn.disabled = true;
        showError('');
        setProgress(8, 'Uploading logfile to local backend…');
        renderSimpleEmptyState('Running local chunk analysis. This can take longer for large files and slow local inference.');
        try {
            const formData = new FormData();
            let displayName = file ? file.name : (stagedSource && stagedSource.fileName) || 'loaded-log.txt';
            if (file) {
                formData.append('file', file, file.name);
            } else {
                const blob = new Blob([stagedSource.text], { type: 'text/plain' });
                formData.append('file', blob, stagedSource.fileName || 'loaded-log.txt');
            }
            setProgress(22, 'Backend is validating and chunking the logfile…');
            const { response, payload } = await fetchJson('/api/local-ai/analyze-log', {
                method: 'POST',
                body: formData,
            });
            if (!response.ok || !payload || payload.status === 'error') {
                const requestId = payload && payload.requestId ? ` (request ${payload.requestId})` : '';
                throw new Error(`${(payload && payload.message) || `HTTP ${response.status}`}${requestId}`);
            }
            setProgress(payload.status === 'partial_success' ? 90 : 100, payload.status === 'partial_success' ? 'Analysis finished with partial chunk failures.' : 'Local AI analysis complete.');
            renderResults(payload);

            // Execute chart rendering post-inject
            setTimeout(() => {
                if (window._pendingLocalAiCharts && window.Chart) {
                    window._pendingLocalAiCharts.forEach((req) => {
                        const canvas = document.getElementById(req.id);
                        if (!canvas) return;
                        
                        const series = req.series;
                        const signalSeries = req.signalSeries || [];
                        const labels = series.map(s => s.time || '');
                        const hasUmts = series.some(s => s.rscp != null || s.ecno != null);
                        const hasLte = series.some(s => s.rsrp != null || s.rsrq != null);

                        const datasets = [];
                        if (hasUmts) {
                            datasets.push({
                                label: 'RSCP (dBm)', data: series.map(s => s.rscp),
                                borderColor: '#3b82f6', backgroundColor: 'rgba(59, 130, 246, 0.1)',
                                yAxisID: 'y', fill: true, tension: 0.1, pointRadius: 2
                            });
                            datasets.push({
                                label: 'EcNo (dB)', data: series.map(s => s.ecno),
                                borderColor: '#ef4444', backgroundColor: 'transparent',
                                yAxisID: 'y1', tension: 0.1, pointRadius: 2
                            });
                        } else if (hasLte) {
                            datasets.push({
                                label: 'RSRP (dBm)', data: series.map(s => s.rsrp),
                                borderColor: '#3b82f6', backgroundColor: 'rgba(59, 130, 246, 0.1)',
                                yAxisID: 'y', fill: true, tension: 0.1, pointRadius: 2
                            });
                            datasets.push({
                                label: 'RSRQ (dB)', data: series.map(s => s.rsrq),
                                borderColor: '#ef4444', backgroundColor: 'transparent',
                                yAxisID: 'y1', tension: 0.1, pointRadius: 2
                            });
                        }

                        const annotations = {};
                        let annCount = 0;
                        signalSeries.forEach((evt) => {
                            const msgLower = (evt.message || '').toLowerCase();
                            if (msgLower.includes('drop') || msgLower.includes('fail') || msgLower.includes('reject') || msgLower.includes('timeout') || msgLower.includes('caf') || msgLower.includes('rlf')) {
                                let matchValue = evt.time;
                                if (!labels.includes(evt.time)) {
                                    const fallback = labels.find(l => String(l) >= String(evt.time));
                                    matchValue = fallback || labels[labels.length - 1];
                                }
                                annotations[`line${annCount++}`] = {
                                    type: 'line',
                                    scaleID: 'x',
                                    value: matchValue,
                                    borderColor: 'rgba(239, 68, 68, 0.85)',
                                    borderWidth: 2,
                                    borderDash: [4, 4],
                                    label: {
                                        position: 'start',
                                        backgroundColor: 'rgba(239, 68, 68, 0.95)',
                                        color: '#ffffff',
                                        content: evt.message,
                                        font: { size: 9 },
                                        display: true
                                    }
                                };
                            }
                        });

                        const configOpts = {
                            responsive: true,
                            maintainAspectRatio: false,
                            interaction: { mode: 'index', intersect: false },
                            plugins: { 
                                legend: { position: 'top', labels: { boxWidth: 12, font: { size: 10 } } }
                            },
                            scales: {
                                x: { ticks: { maxTicksLimit: 6, font: { size: 9 } } },
                                y: { type: 'linear', display: true, position: 'left', ticks: { font: { size: 9 } } },
                                y1: { type: 'linear', display: true, position: 'right', grid: { drawOnChartArea: false }, ticks: { font: { size: 9 } } }
                            }
                        };

                        if (Object.keys(annotations).length > 0) {
                            configOpts.plugins.annotation = { annotations };
                        }

                        new Chart(canvas.getContext('2d'), {
                            type: 'line',
                            data: { labels, datasets },
                            options: configOpts
                        });
                    });
                }
            }, 150);

            if (fileStatus) {
                fileStatus.textContent = `Local AI analyzed ${displayName} (${payload.report?.stats?.analyzed_chunks || 0}/${payload.report?.stats?.total_chunks || 0} chunks)`;
            }
            return true;
        } catch (error) {
            setProgress(100, 'Analysis failed');
            showError(error && error.message ? error.message : 'Local AI analysis failed.');
            renderSimpleEmptyState('The analysis did not complete. Review the error above, then verify Ollama is running locally and the configured model is loaded.');
            return false;
        } finally {
            analyzeBtn.disabled = !((fileInput.files && fileInput.files[0]) || stagedSource);
            refreshBtn.disabled = false;
            if (chooseFileBtn) chooseFileBtn.disabled = false;
            if (useLoadedBtn) useLoadedBtn.disabled = false;
        }
    };

    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        await runAnalysis();
    });

    openBtn.addEventListener('click', openModal);
    closeBtn.addEventListener('click', closeModal);
    refreshBtn.addEventListener('click', refreshStatus);
    if (chooseFileBtn) {
        chooseFileBtn.addEventListener('click', () => {
            stagedSource = null;
            fileInput.click();
        });
    }
    if (useLoadedBtn) {
        useLoadedBtn.addEventListener('click', () => {
            try {
                const log = getPreferredLoadedLog();
                if (!log) {
                    throw new Error('No loaded log found. Import a logfile in the app first, then click Use Loaded Log.');
                }
                stagedSource = {
                    kind: 'loaded-log',
                    ...buildTextFromLoadedLog(log),
                };
                if (fileInput) fileInput.value = '';
                showError('');
                updateSelectedFile();
            } catch (error) {
                showError(error && error.message ? error.message : 'Could not prepare the loaded log for Local AI.');
            }
        });
    }
    fileInput.addEventListener('change', updateSelectedFile);
    modal.addEventListener('click', (event) => {
        if (event.target === modal) {
            closeModal();
        }
    });
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && modal.style.display === 'flex') {
            closeModal();
        }
    });

    updateSelectedFile();

    window.openLocalAiWithPreparedSource = async (source, options = {}) => {
        if (!source || typeof source.text !== 'string' || !String(source.text).trim()) {
            throw new Error('Prepared Local AI source is empty.');
        }
        stagedSource = {
            kind: String(source.kind || 'prepared'),
            label: String(source.label || source.fileName || 'Prepared Local AI source'),
            fileName: String(source.fileName || 'prepared-local-ai.txt'),
            text: String(source.text || ''),
        };
        if (fileInput) fileInput.value = '';
        modal.style.display = 'flex';
        showError('');
        setProgress(0, 'Prepared issue bundle loaded');
        updateSelectedFile();
        await refreshStatus();
        if (options.autoAnalyze !== false) {
            await runAnalysis();
        }
    };
});

const { buildRadioStore, addRadioRecord, buildSnapshot, parseNumber } = require('./nmfRadioSnapshot');
const { classifySession, buildRadioEvaluation } = require('./nmfUmtsDropRules');

function parseCsvLine(line) {
    const out = [];
    let cur = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
            if (inQuotes && line[i + 1] === '"') {
                cur += '"';
                i += 1;
            } else {
                inQuotes = !inQuotes;
            }
            continue;
        }
        if (ch === ',' && !inQuotes) {
            out.push(cur);
            cur = '';
            continue;
        }
        cur += ch;
    }
    out.push(cur);
    return out;
}

function parseStartDate(parts) {
    for (const value of parts) {
        const txt = String(value || '').trim().replace(/^"|"$/g, '');
        const m = txt.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
        if (!m) continue;
        const day = Number.parseInt(m[1], 10);
        const month = Number.parseInt(m[2], 10);
        const year = Number.parseInt(m[3], 10);
        return { day, month, year };
    }
    return null;
}

function parseTodMs(timeText) {
    const m = String(timeText || '').trim().match(/^(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/);
    if (!m) return null;
    const hh = Number.parseInt(m[1], 10);
    const mm = Number.parseInt(m[2], 10);
    const ss = Number.parseInt(m[3], 10);
    const ms = Number.parseInt((m[4] || '0').padEnd(3, '0'), 10);
    return (((hh * 60 + mm) * 60 + ss) * 1000) + ms;
}

function createTimestampBuilder() {
    let baseUtcMs = null;
    let prevTodMs = null;
    let dayOffset = 0;

    function setBaseDate(dmy) {
        if (!dmy) return;
        baseUtcMs = Date.UTC(dmy.year, dmy.month - 1, dmy.day, 0, 0, 0, 0);
        prevTodMs = null;
        dayOffset = 0;
    }

    function buildAbsoluteMs(timeText) {
        if (!Number.isFinite(baseUtcMs)) return null;
        const todMs = parseTodMs(timeText);
        if (!Number.isFinite(todMs)) return null;

        const rolloverThreshold = 6 * 3600 * 1000;
        if (Number.isFinite(prevTodMs) && todMs < (prevTodMs - rolloverThreshold)) {
            dayOffset += 1;
        }
        prevTodMs = todMs;

        return baseUtcMs + dayOffset * 24 * 3600 * 1000 + todMs;
    }

    return { setBaseDate, buildAbsoluteMs };
}

function getOrCreateSession(map, sessionKey, callId, deviceId) {
    const key = String(sessionKey);
    let session = map.get(key);
    if (!session) {
        session = {
            sessionKey: key,
            callId: callId ? String(callId) : '',
            deviceId: deviceId ? String(deviceId) : '',
            startTs: null,
            connectedTs: null,
            cadStatus: null,
            cadCause: null,
            cafReason: null,
            endTsCad: null,
            endTsCaf: null,
            endTsCare: null,
            endTsReal: null,
            dialedNumber: null,
            resultType: 'UNCLASSIFIED',
            classification: null,
            snapshot: null,
            eventTimeline: []
        };
        map.set(key, session);
    }
    if (callId !== undefined && callId !== null && String(callId).trim() !== '') session.callId = String(callId);
    if (deviceId !== undefined && deviceId !== null && String(deviceId).trim() !== '') session.deviceId = String(deviceId);
    return session;
}

function finalizeSessionType(session) {
    session.endTsReal = session.endTsCare || session.endTsCaf || session.endTsCad || null;

    if (session.cadStatus === 1 && session.cadCause === 16) {
        session.resultType = 'SUCCESS';
        return;
    }

    if (!Number.isFinite(session.connectedTs) && (
        Number.isFinite(session.endTsCaf) || session.cadStatus === 2 || session.cadCause === 102
    )) {
        session.resultType = 'CALL_SETUP_FAILURE';
        return;
    }

    if (Number.isFinite(session.connectedTs) && (
        Number.isFinite(session.endTsCare) || session.cadStatus === 2 ||
        (Number.isFinite(session.cadCause) && session.cadCause !== 16)
    )) {
        session.resultType = 'DROP_CALL';
        return;
    }

    // Connected but no explicit end marker in parsed range should not be marked as drop.
    if (Number.isFinite(session.connectedTs)) {
        session.resultType = 'INCOMPLETE_OR_UNKNOWN_END';
        return;
    }
    session.resultType = 'UNCLASSIFIED';
}

function formatTs(ms) {
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function summarize(sessions) {
    const summary = {
        totalCaaSessions: sessions.length,
        outcomes: {
            SUCCESS: 0,
            CALL_SETUP_FAILURE: 0,
            SETUP_FAILURE: 0,
            DROP_CALL: 0,
            INCOMPLETE_OR_UNKNOWN_END: 0,
            UNCLASSIFIED: 0
        }
    };

    for (const s of sessions) {
        if (summary.outcomes[s.resultType] === undefined) summary.outcomes[s.resultType] = 0;
        summary.outcomes[s.resultType] += 1;
        if (s.resultType === 'CALL_SETUP_FAILURE') summary.outcomes.SETUP_FAILURE += 1;
    }
    return summary;
}

function lowerBound(rows, ts) {
    let lo = 0;
    let hi = rows.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (rows[mid].ts < ts) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

function upperBound(rows, ts) {
    let lo = 0;
    let hi = rows.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (rows[mid].ts <= ts) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

function median(values) {
    if (!Array.isArray(values) || values.length === 0) return null;
    const sorted = values.slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function getBestServerFromBlocks(blocks) {
    const list = Array.isArray(blocks) ? blocks : [];
    return list.reduce((best, cur) => {
        if (!cur || !Number.isFinite(cur.rscp)) return best;
        return (!best || cur.rscp > best.rscp) ? cur : best;
    }, null);
}

function buildSetupFailureContextBundle(session, radioStore, eventsByDevice, options = {}) {
    if (!session || !Number.isFinite(session.endTsReal)) return null;
    const radioPreEndSec = Number.isFinite(options.radioPreEndSec) ? options.radioPreEndSec : 20;
    const signalingAroundEndSec = Number.isFinite(options.signalingAroundEndSec) ? options.signalingAroundEndSec : 20;
    const endTs = session.endTsReal;
    const radioFromTs = endTs - Math.max(1, radioPreEndSec) * 1000;
    const signalingFromTs = endTs - Math.max(1, signalingAroundEndSec) * 1000;
    const signalingToTs = endTs + Math.max(1, signalingAroundEndSec) * 1000;

    const deviceId = String(session.deviceId || '');
    const dev = radioStore.byDevice.get(deviceId) || { mimoRows: [], txpcRows: [], rlcRows: [] };

    const mimoFrom = lowerBound(dev.mimoRows, radioFromTs);
    const mimoTo = upperBound(dev.mimoRows, endTs);
    const bestServerSeries = [];
    for (let i = mimoFrom; i < mimoTo; i++) {
        const row = dev.mimoRows[i];
        const byPsc = new Map();
        for (const sample of row.samples || []) {
            const key = String(sample.psc);
            const agg = byPsc.get(key) || {
                psc: sample.psc,
                rscpSum: 0,
                ecnoSum: 0,
                count: 0,
                cellId: sample.cellId,
                uarfcn: sample.uarfcn
            };
            agg.rscpSum += sample.rscp;
            agg.ecnoSum += sample.ecno;
            agg.count += 1;
            if (agg.cellId === null && sample.cellId !== null) agg.cellId = sample.cellId;
            if (agg.uarfcn === null && sample.uarfcn !== null) agg.uarfcn = sample.uarfcn;
            byPsc.set(key, agg);
        }
        const blocks = [];
        for (const agg of byPsc.values()) {
            if (!Number.isFinite(agg.rscpSum) || !Number.isFinite(agg.ecnoSum) || !Number.isFinite(agg.count) || agg.count <= 0) continue;
            blocks.push({
                ts: row.ts,
                psc: agg.psc,
                rscp: agg.rscpSum / agg.count,
                ecno: agg.ecnoSum / agg.count,
                cellId: agg.cellId,
                uarfcn: agg.uarfcn
            });
        }
        const best = getBestServerFromBlocks(blocks);
        if (best) bestServerSeries.push(best);
    }
    const rscpValues = bestServerSeries.map(x => x.rscp).filter(Number.isFinite);
    const ecnoValues = bestServerSeries.map(x => x.ecno).filter(Number.isFinite);

    const txFrom = lowerBound(dev.txpcRows, radioFromTs);
    const txTo = upperBound(dev.txpcRows, endTs);
    const txRows = dev.txpcRows.slice(txFrom, txTo).filter(v => Number.isFinite(v.tx));
    const txValues = txRows.map(v => v.tx);

    const rlcFrom = lowerBound(dev.rlcRows, radioFromTs);
    const rlcTo = upperBound(dev.rlcRows, endTs);
    const blerRows = dev.rlcRows.slice(rlcFrom, rlcTo);
    const blerMax = blerRows.length ? blerRows.reduce((m, r) => (r.blerMax > m ? r.blerMax : m), -Infinity) : null;
    let blerTrend = null;
    if (blerRows.length >= 2) {
        const first = blerRows[0];
        const last = blerRows[blerRows.length - 1];
        blerTrend = Number.isFinite(first.blerMean) && Number.isFinite(last.blerMean) ? (last.blerMean - first.blerMean) : null;
    }

    const deviceEvents = (eventsByDevice.get(deviceId) || []).slice().sort((a, b) => a.ts - b.ts);
    const signalingWindowEvents = deviceEvents.filter(e => e.ts >= signalingFromTs && e.ts <= signalingToTs);
    const last20EventsBeforeEnd = deviceEvents.filter(e => e.ts >= signalingFromTs && e.ts <= endTs).slice(-20);
    const first10EventsAfterStart = Number.isFinite(session.startTs)
        ? deviceEvents.filter(e => e.ts >= session.startTs && e.ts <= signalingToTs).slice(0, 10)
        : [];
    const closestRrcOrHoBeforeEnd = deviceEvents
        .filter(e => e.ts <= endTs && (String(e.header || '').toUpperCase() === 'RRCSM' || String(e.header || '').toUpperCase() === 'SHO'))
        .slice(-1)[0] || null;
    const releaseRejectCandidates = signalingWindowEvents
        .filter(e => /reject|release|fail|cause/i.test(String(e.raw || '')) || /CAD|CAF|CARE/i.test(String(e.header || '')))
        .map(e => ({ ...e, dist: Math.abs(endTs - e.ts) }))
        .sort((a, b) => a.dist - b.dist);
    const closestReleaseReject = releaseRejectCandidates.length ? releaseRejectCandidates[0] : null;

    const briefEvent = (e) => e ? ({
        tsIso: formatTs(e.ts),
        header: e.header,
        raw: e.raw
    }) : null;

    return {
        type: 'SETUP_FAILURE_CONTEXT_BUNDLE',
        windows: {
            radioPreEndSec,
            signalingAroundEndSec,
            radioWindowStartIso: formatTs(radioFromTs),
            radioWindowEndIso: formatTs(endTs),
            signalingWindowStartIso: formatTs(signalingFromTs),
            signalingWindowEndIso: formatTs(signalingToTs)
        },
        radioContext: {
            mimoSampleCount: bestServerSeries.length,
            rscpMin: rscpValues.length ? Math.min(...rscpValues) : null,
            rscpMax: rscpValues.length ? Math.max(...rscpValues) : null,
            rscpMedian: median(rscpValues),
            ecnoMin: ecnoValues.length ? Math.min(...ecnoValues) : null,
            ecnoMax: ecnoValues.length ? Math.max(...ecnoValues) : null,
            ecnoMedian: median(ecnoValues),
            txLast: txValues.length ? txValues[txValues.length - 1] : null,
            txP90: txValues.length ? txValues.slice().sort((a, b) => a - b)[Math.max(0, Math.ceil(0.9 * txValues.length) - 1)] : null,
            txMax: txValues.length ? Math.max(...txValues) : null,
            blerMax,
            blerTrend,
            bestServerSeries: bestServerSeries.map(s => ({
                tsIso: formatTs(s.ts),
                psc: s.psc,
                uarfcn: s.uarfcn,
                rscp: s.rscp,
                ecno: s.ecno
            })),
            txSeries: txRows.map(r => ({ tsIso: formatTs(r.ts), tx: r.tx })),
            blerSeries: blerRows.map(r => ({ tsIso: formatTs(r.ts), blerMax: r.blerMax, blerMean: r.blerMean }))
        },
        signalingContext: {
            totalEventsInWindow: signalingWindowEvents.length,
            last20EventsBeforeEnd: last20EventsBeforeEnd.map(briefEvent),
            first10EventsAfterStart: first10EventsAfterStart.map(briefEvent),
            closestRrcOrHoBeforeEnd: briefEvent(closestRrcOrHoBeforeEnd),
            closestReleaseRejectCause: briefEvent(closestReleaseReject)
        },
        callControlContext: {
            deviceId: session.deviceId || null,
            callId: session.callId || null,
            connectedEver: Number.isFinite(session.connectedTs),
            cAA: formatTs(session.startTs),
            cACConnected: formatTs(session.connectedTs),
            cAD: formatTs(session.endTsCad),
            cAF: formatTs(session.endTsCaf),
            cARE: formatTs(session.endTsCare),
            endTsReal: formatTs(session.endTsReal),
            cadStatus: session.cadStatus ?? null,
            cadCause: session.cadCause ?? null,
            cafReason: session.cafReason ?? null
        }
    };
}

function isRadioHealthySnapshot(snapshot) {
    return Number.isFinite(snapshot?.rscpMedian) && snapshot.rscpMedian > -85 &&
        Number.isFinite(snapshot?.ecnoMedian) && snapshot.ecnoMedian > -10 &&
        Number.isFinite(snapshot?.txP90) && snapshot.txP90 < 20 &&
        Number.isFinite(snapshot?.blerMax) && snapshot.blerMax < 5;
}

function analyzeSetupSignaling(ctx, session) {
    const signaling = ctx?.signalingContext || {};
    const allRows = []
        .concat(Array.isArray(signaling.first10EventsAfterStart) ? signaling.first10EventsAfterStart : [])
        .concat(Array.isArray(signaling.last20EventsBeforeEnd) ? signaling.last20EventsBeforeEnd : []);
    const hasDirectTransfer = allRows.some(e => /DIRECT_TRANSFER/i.test(String(e?.raw || '')));
    const releaseNearEnd = /RELEASE|REJECT|FAIL/i.test(String(signaling?.closestReleaseRejectCause?.raw || ''));
    const hasCongestionHints = allRows.some(e => /(NO[_\s-]?RESOURCE|ADMISSION|CONGEST|POWER LIMIT|CODE LIMIT|CE FULL|CHANNEL ALLOCATION FAILURE|NO RADIO RESOURCE)/i.test(String(e?.raw || '')));
    const hasMobilityNearEnd = /SHO|HO|HANDOVER/i.test(String(signaling?.closestRrcOrHoBeforeEnd?.raw || ''));
    return {
        hasDirectTransfer,
        releaseNearEnd,
        hasCongestionHints,
        hasMobilityNearEnd,
        connectedEver: Number.isFinite(session?.connectedTs),
        cadStatus: session?.cadStatus ?? null,
        cadCause: session?.cadCause ?? null,
        cafReason: session?.cafReason ?? null
    };
}

function buildSetupFailureDeepAnalysis(session) {
    if (!session || session.resultType !== 'CALL_SETUP_FAILURE') return null;
    const snapshot = session.snapshot || {};
    const ctx = session.contextBundle || {};
    const signalingEval = analyzeSetupSignaling(ctx, session);
    const radioHealthy = isRadioHealthySnapshot(snapshot);
    const category = String(session?.classification?.category || 'SETUP_FAIL_UNKNOWN');
    const domain = String(session?.classification?.domain || 'Undetermined');
    const clsConfidence = Number.isFinite(session?.classification?.confidence) ? session.classification.confidence : 0.5;

    const radioAssessment = {
        evaluation: buildRadioEvaluation(snapshot, category, domain, session),
        radioHealthy,
        metrics: {
            rscpMin: snapshot?.rscpMin ?? null,
            rscpMedian: snapshot?.rscpMedian ?? null,
            rscpMax: snapshot?.rscpLast ?? snapshot?.rscpMax ?? null,
            ecnoMin: snapshot?.ecnoMin ?? null,
            ecnoMedian: snapshot?.ecnoMedian ?? null,
            ecnoMax: snapshot?.ecnoLast ?? snapshot?.ecnoMax ?? null,
            txP90: snapshot?.txP90 ?? null,
            blerMax: snapshot?.blerMax ?? null,
            blerEvidence: snapshot?.blerEvidence === true,
            rlcBlerSamplesCount: Number.isFinite(snapshot?.rlcBlerSamplesCount) ? snapshot.rlcBlerSamplesCount : 0,
            mimoSampleCount: snapshot?.mimoSampleCount ?? 0
        }
    };

    const signalingAssessment = {
        rrcEstablished: signalingEval.hasDirectTransfer,
        directTransferObserved: signalingEval.hasDirectTransfer,
        immediateReleaseNearEnd: signalingEval.releaseNearEnd,
        connectedEver: signalingEval.connectedEver,
        cadStatus: signalingEval.cadStatus,
        cadCause: signalingEval.cadCause,
        cafReason: signalingEval.cafReason,
        evaluation: (() => {
            if (session?.cadCause === 102) {
                return signalingEval.releaseNearEnd
                    ? 'Setup timer expired before call connection (CAD cause 102: timer expiry); explicit release/reject marker observed near setup end.'
                    : 'Setup timer expired before call connection (CAD cause 102: timer expiry); no explicit release/reject marker was decoded near setup end.';
            }
            return signalingEval.releaseNearEnd
                ? 'Setup reached signaling exchange and terminated by release/reject near setup end.'
                : 'No immediate release/reject marker was found near setup end.';
        })()
    };

    let interpretationSummary = 'Setup failure likely originated from mixed radio/signaling factors.';
    if (category === 'SETUP_FAIL_SIGNALING_OR_CORE' || (radioHealthy && signalingEval.releaseNearEnd && !signalingEval.connectedEver)) {
        interpretationSummary = 'Strong radio with immediate signaling release indicates core/signaling-layer rejection.';
    } else if (category === 'SETUP_FAIL_UL_COVERAGE') {
        interpretationSummary = 'Setup failed due to uplink margin exhaustion in weak/unstable coverage.';
    } else if (category === 'SETUP_FAIL_DL_INTERFERENCE') {
        interpretationSummary = 'Setup failed under downlink interference/quality collapse despite acceptable signal strength.';
    } else if (category === 'SETUP_FAIL_MOBILITY') {
        interpretationSummary = 'Setup failed around mobility instability (HO/SHO proximity).';
    } else if (category === 'SETUP_FAIL_CONGESTION') {
        interpretationSummary = 'Setup failed under admission/resource congestion conditions.';
    } else if (category === 'SETUP_TIMEOUT') {
        interpretationSummary = 'Setup timed out in signaling path before connection establishment.';
    }

    const breakdown = {
        radioHealthy: radioHealthy ? 40 : 0,
        immediateRelease: signalingEval.releaseNearEnd ? 25 : 0,
        noConnection: !signalingEval.connectedEver ? 15 : 0,
        noMobility: !signalingEval.hasMobilityNearEnd ? 10 : 0,
        noCongestion: !signalingEval.hasCongestionHints ? 10 : 0
    };
    const rawScore = breakdown.radioHealthy + breakdown.immediateRelease + breakdown.noConnection + breakdown.noMobility + breakdown.noCongestion;
    const normalizedScore = Math.min(0.95, rawScore / 100);

    return {
        radioAssessment,
        signalingAssessment,
        interpretation: {
            summary: interpretationSummary
        },
        classification: {
            resultType: session.resultType,
            category,
            domain,
            reason: session?.classification?.reason || null,
            confidence: clsConfidence
        },
        confidence: {
            score: rawScore,
            normalized: normalizedScore,
            breakdown
        },
        recommendedActions: Array.isArray(session?.classification?.recommendations)
            ? session.classification.recommendations
            : []
    };
}

function analyzeUmtsCallSessions(content, options = {}) {
    const windowSeconds = Number.isFinite(options.windowSeconds) ? options.windowSeconds : 10;
    const CALL_HEADERS = new Set(['CAA', 'CAC', 'CAD', 'CAF', 'CARE']);
    const UMTS_TIMELINE_HEADERS = new Set([
        'RRCSM', 'L3SM', 'L3MM',
        'RRC', 'RRA', 'RRD', 'RRF',
        'RABA', 'RABD', 'RBI',
        'SHO', 'CELLMEAS'
    ]);

    const tsBuilder = createTimestampBuilder();
    const sessionsMap = new Map();
    const radioStore = buildRadioStore();
    const eventsByDevice = new Map();

    const addEvent = (deviceId, ts, header, parts) => {
        const key = String(deviceId || '');
        let arr = eventsByDevice.get(key);
        if (!arr) {
            arr = [];
            eventsByDevice.set(key, arr);
        }
        arr.push({ ts, header, raw: parts.join(',') });
    };

    const ingestCall = (header, parts, ts) => {
        const h = String(header || '').trim().toUpperCase();
        if (!CALL_HEADERS.has(h)) return;
        const callId = String(parts[3] || '').trim();
        const callDeviceId = String(parts[4] || '').trim();
        if (!callId || !callDeviceId) return;

        const sessionKey = `${callDeviceId}:${callId}`;
        const session = getOrCreateSession(sessionsMap, sessionKey, callId, callDeviceId);

        if (h === 'CAA') {
            if (!Number.isFinite(session.startTs) || ts < session.startTs) session.startTs = ts;
            const dial = String(parts[7] || '').trim().replace(/^"|"$/g, '');
            if (dial) session.dialedNumber = dial;
        } else if (h === 'CAC') {
            const state = parseNumber(parts[6]);
            if (state === 3 && !Number.isFinite(session.connectedTs)) session.connectedTs = ts;
        } else if (h === 'CAD') {
            const status = parseNumber(parts[6]);
            const cause = parseNumber(parts[7]);
            session.cadStatus = status === null ? session.cadStatus : status;
            session.cadCause = cause === null ? session.cadCause : cause;
            session.endTsCad = ts;
        } else if (h === 'CAF') {
            const reason = parseNumber(parts[6]);
            session.cafReason = reason === null ? session.cafReason : reason;
            session.endTsCaf = ts;
        } else if (h === 'CARE') {
            session.endTsCare = ts;
        }
        addEvent(session.deviceId, ts, h, parts);
    };

    const lines = String(content || '').split(/\r?\n/);
    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;

        const parts = parseCsvLine(line);
        const header = String(parts[0] || '').trim().toUpperCase();

        if (header === '#START') {
            tsBuilder.setBaseDate(parseStartDate(parts));
            continue;
        }

        if (!parts[1]) continue;
        const ts = tsBuilder.buildAbsoluteMs(parts[1]);
        if (!Number.isFinite(ts)) continue;

        if (header === 'MIMOMEAS' || header === 'TXPC' || header === 'RLCBLER') {
            const deviceId = String(parts[3] || '').trim();
            addRadioRecord(radioStore, header, parts, ts, deviceId);
            addEvent(deviceId, ts, header, parts);
            continue;
        }

        if (UMTS_TIMELINE_HEADERS.has(header)) {
            const deviceId = String(parts[3] || '').trim();
            if (deviceId) addEvent(deviceId, ts, header, parts);
            continue;
        }

        if (CALL_HEADERS.has(header)) {
            ingestCall(header, parts, ts);
        }
    }

    const sessions = Array.from(sessionsMap.values()).sort((a, b) => {
        const aStart = Number.isFinite(a.startTs) ? a.startTs : Number.POSITIVE_INFINITY;
        const bStart = Number.isFinite(b.startTs) ? b.startTs : Number.POSITIVE_INFINITY;
        if (aStart !== bStart) return aStart - bStart;
        return Number.parseInt(a.callId, 10) - Number.parseInt(b.callId, 10);
    });

    const isSameCallEvent = (event, session) => {
        if (!event || !session) return false;
        const h = String(event.header || '').toUpperCase();
        if (!CALL_HEADERS.has(h)) return true;
        const parts = parseCsvLine(event.raw || '');
        const evCallId = String(parts[3] || '').trim();
        const evDeviceId = String(parts[4] || '').trim();
        return evCallId === String(session.callId || '') && evDeviceId === String(session.deviceId || '');
    };

    for (const session of sessions) {
        finalizeSessionType(session);
        if ((session.resultType === 'CALL_SETUP_FAILURE' || session.resultType === 'DROP_CALL') && Number.isFinite(session.endTsReal)) {
            session.snapshot = buildSnapshot(radioStore, session.endTsReal, windowSeconds, session.deviceId || '');
            if (session.snapshot) {
                session.snapshot.trendBasis = session.resultType === 'CALL_SETUP_FAILURE'
                    ? 'last 10s before setup failure'
                    : 'last 10s before drop/end';
            }
        }
        session.markerTs = session.snapshot?.lastMimoTs ?? session.snapshot?.lastTxTs ?? session.endTsReal ?? null;
        session.callStartTs = Number.isFinite(session.startTs) ? session.startTs : null;
        session.analysisWindowStartTs = Number.isFinite(session.endTsReal)
            ? (session.endTsReal - Math.max(1, windowSeconds) * 1000)
            : null;

        if (session.resultType === 'CALL_SETUP_FAILURE' && Number.isFinite(session.endTsReal)) {
            session.contextBundle = buildSetupFailureContextBundle(session, radioStore, eventsByDevice, {
                radioPreEndSec: 20,
                signalingAroundEndSec: 20
            });
        } else {
            session.contextBundle = null;
        }
        session.classification = classifySession(session, session.snapshot);
        session.category = session.classification?.category || null;
        session.confidence = session.classification?.confidence ?? null;
        session.reason = session.classification?.reason || null;
        session.domain = session.classification?.domain || null;
        session.evidence = session.classification?.evidence || [];
        session.explanation = session.classification?.explanation || null;
        session.recommendations = Array.isArray(session.classification?.recommendations) ? session.classification.recommendations : [];
        session.oneParagraphSummary = session.classification?.oneParagraphSummary || null;
        session.setupFailureDeepAnalysis = buildSetupFailureDeepAnalysis(session);

        const deviceEvents = eventsByDevice.get(String(session.deviceId || '')) || [];
        if (Number.isFinite(session.startTs) && Number.isFinite(session.endTsReal)) {
            const seen = new Set();
            session.eventTimeline = deviceEvents
                .filter(e => e.ts >= session.startTs && e.ts <= session.endTsReal)
                .filter(e => isSameCallEvent(e, session))
                .sort((a, b) => a.ts - b.ts)
                .filter(e => {
                    const k = `${e.ts}|${e.header}|${e.raw}`;
                    if (seen.has(k)) return false;
                    seen.add(k);
                    return true;
                })
                .map(e => ({ ts: e.ts, time: formatTs(e.ts), event: e.header, details: e.raw }));
        } else {
            session.eventTimeline = [];
        }
    }

    return {
        summary: summarize(sessions),
        sessions: sessions.map(s => ({
            ...s,
            callStartTsIso: formatTs(s.callStartTs),
            analysisWindowStartTsIso: formatTs(s.analysisWindowStartTs),
            markerTsIso: formatTs(s.markerTs),
            startTsIso: formatTs(s.callStartTs),
                connectedTsIso: formatTs(s.connectedTs),
                endTsRealIso: formatTs(s.endTsReal),
                contextBundle: s.contextBundle || null,
                setupFailureDeepAnalysis: s.setupFailureDeepAnalysis || null
            })),
        radioSeries: {
            byDevice: Array.from(radioStore.byDevice.entries()).map(([deviceId, dev]) => ({
                deviceId,
                mimoCount: dev.mimoRows.length,
                txpcCount: dev.txpcRows.length,
                rlcCount: dev.rlcRows.length
            }))
        }
    };
}

module.exports = {
    analyzeUmtsCallSessions,
    parseCsvLine,
    parseStartDate,
    parseTodMs,
    createTimestampBuilder
};

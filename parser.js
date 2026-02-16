const CallSessionBuilder = {
    build(records, options = {}) {
        const timeWindowMs = Number.isFinite(options.timeWindowMs) ? options.timeWindowMs : 30000;
        const rrcNasFollowMs = Number.isFinite(options.rrcNasFollowMs) ? options.rrcNasFollowMs : 5000;
        const minValidAttemptMs = Number.isFinite(options.minValidAttemptMs) ? options.minValidAttemptMs : 2000;
        const maxSetupWindowMs = Number.isFinite(options.maxSetupWindowMs) ? options.maxSetupWindowMs : 30000;

        const parseTimeToMs = (timeValue) => {
            if (!timeValue) return NaN;
            const txt = String(timeValue).trim();
            const isoMs = Date.parse(txt);
            if (!Number.isNaN(isoMs)) return isoMs;

            const m = txt.match(/^(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/);
            if (!m) return NaN;
            const hh = parseInt(m[1], 10);
            const mm = parseInt(m[2], 10);
            const ss = parseInt(m[3], 10);
            const ms = parseInt((m[4] || '0').padEnd(3, '0'), 10);
            return (((hh * 60 + mm) * 60 + ss) * 1000) + ms;
        };

        const normalizeIdValue = (value) => {
            if (value === undefined || value === null) return null;
            const txt = String(value).trim();
            if (!txt || txt.toUpperCase() === 'N/A' || txt.toUpperCase() === 'UNKNOWN') return null;
            return txt;
        };

        const readKeyByPattern = (obj, patterns) => {
            if (!obj || typeof obj !== 'object') return null;
            for (const [k, v] of Object.entries(obj)) {
                const key = String(k).toLowerCase().replace(/[^a-z0-9]/g, '');
                if (patterns.some(p => p.test(key))) {
                    const normalized = normalizeIdValue(v);
                    if (normalized) return normalized;
                }
            }
            return null;
        };

        const extractFromText = (text, pattern) => {
            if (!text) return null;
            const m = String(text).match(pattern);
            return m ? normalizeIdValue(m[1]) : null;
        };

        const extractIdentifiers = (record) => {
            const props = record && record.properties ? record.properties : {};
            const txtPool = [record?.details, record?.message, props?.Message].filter(Boolean).join(' | ');

            const callId = normalizeIdValue(
                readKeyByPattern(record, [/^callid$/, /^callidentifier$/, /^transactionid$/, /^transid$/, /^tid$/]) ||
                readKeyByPattern(props, [/^callid$/, /^callidentifier$/, /^transactionid$/, /^transid$/, /^tid$/]) ||
                extractFromText(txtPool, /\b(?:call\s*id|transaction\s*id|trans(?:action)?\s*id|tid)\s*[:=]\s*([A-Za-z0-9_-]+)/i)
            );

            const imsi = normalizeIdValue(
                readKeyByPattern(record, [/^imsi$/]) ||
                readKeyByPattern(props, [/^imsi$/]) ||
                extractFromText(txtPool, /\bimsi\s*[:=]\s*([0-9]{5,20})\b/i)
            );

            const tmsi = normalizeIdValue(
                readKeyByPattern(record, [/^tmsi$/]) ||
                readKeyByPattern(props, [/^tmsi$/]) ||
                extractFromText(txtPool, /\btmsi\s*[:=]\s*([A-Fa-f0-9]{4,16})\b/i)
            );

            return { callId, imsi, tmsi };
        };

        const isRrcState = (value) => {
            if (!value) return false;
            const txt = String(value).toUpperCase();
            return ['IDLE', 'CELL_DCH', 'CELL_FACH', 'CELL_PCH', 'URA_PCH', 'CONNECTED', 'INACTIVE'].includes(txt);
        };

        const parseRrcFromRecord = (record) => {
            const props = record?.properties || {};
            const explicitState = normalizeIdValue(record?.['RRC State'] || props['RRC State'] || record?.rrcState);
            if (isRrcState(explicitState)) return explicitState;

            const msg = String(record?.message || props?.Message || '').toUpperCase();
            if (msg.includes('RRC_CONNECTION_RELEASE') || msg.includes('RRC RELEASE')) return 'IDLE';
            if (msg.includes('CELL_UPDATE')) return 'CELL_FACH';
            if (msg.includes('PAGING')) return 'CELL_PCH';
            if (msg.includes('RRC_CONNECTION_SETUP') || msg.includes('RADIO_BEARER_SETUP')) return 'CONNECTED';
            return null;
        };

        const parseRabEvent = (record) => {
            const source = String(record?.event || record?.message || record?.properties?.Message || '').toUpperCase();
            if (!source.includes('RAB')) return null;
            let phase = 'UPDATE';
            if (source.includes('SETUP') || source.includes('ASSIGN') || source.includes('ESTABLISH') || source.includes('ADD')) phase = 'START';
            if (source.includes('RELEASE') || source.includes('REMOVE') || source.includes('DELETE')) phase = 'END';
            return {
                time: record.time || null,
                phase,
                event: record.event || record.message || 'RAB Event',
                detail: record.message || record.details || null
            };
        };

        const parseMeasurement = (record) => {
            if (record?.type !== 'MEASUREMENT') return null;
            const props = record.properties || {};
            const pick = (...vals) => {
                for (const v of vals) {
                    if (v === undefined || v === null || v === '' || Number.isNaN(v)) continue;
                    return v;
                }
                return null;
            };
            const m = {
                time: record.time || null,
                rscp: pick(record.level, props['Serving RSCP'], props['RSCP']),
                rsrp: pick(props['Serving RSRP'], props['RSRP']),
                ecno: pick(record.ecno, props['EcNo'], props['Serving EcNo']),
                rsrq: pick(props['RSRQ']),
                rssi: pick(record.rssi, props['RSSI']),
                blerDl: pick(record.bler_dl, props['BLER DL']),
                blerUl: pick(record.bler_ul, props['BLER UL']),
                freq: pick(record.freq, props['Freq'])
            };
            const hasSignal = Object.values(m).some(v => v !== null && v !== m.time);
            return hasSignal ? m : null;
        };

        const getCorrelationKey = (ids) => {
            if (ids.callId) return `CALL:${ids.callId}`;
            if (ids.imsi && ids.tmsi) return `IMSI:${ids.imsi}|TMSI:${ids.tmsi}`;
            if (ids.imsi) return `IMSI:${ids.imsi}`;
            if (ids.tmsi) return `TMSI:${ids.tmsi}`;
            return '__ANON__';
        };

        const isIdleState = (rrc) => ['IDLE', 'CELL_PCH', 'URA_PCH'].includes(String(rrc || '').toUpperCase());

        const getMessageEnvelope = (record) => {
            const parts = [
                record?.event,
                record?.message,
                record?.details,
                record?.properties?.Message,
                record?.properties?.Event
            ].filter(Boolean).map(v => String(v).toUpperCase());
            return parts.join(' | ');
        };

        const parseSemanticFlags = (record) => {
            const msg = getMessageEnvelope(record);
            const props = record?.properties || {};
            const rrcCause = String(record?.rrc_rel_cause || props['RRC Release Cause'] || props['rrc_rel_cause'] || '').toUpperCase();
            const csCause = String(record?.cs_rel_cause || props['CS Release Cause'] || props['cs_rel_cause'] || '').toUpperCase();
            const causeEnvelope = `${rrcCause} ${csCause}`;

            const has = (s) => msg.includes(s);
            const hasWord = (s) => new RegExp(`\\b${s}\\b`, 'i').test(msg);

            const isCmServiceRequest = has('CM_SERVICE_REQUEST') || has('CM SERVICE REQUEST');
            const isSetupMoMt = (hasWord('SETUP') && !has('SETUP_COMPLETE') && !has('RRC_CONNECTION_SETUP') && !has('RRC SETUP'));
            const isRrcConnectionRequest = has('RRC_CONNECTION_REQUEST') || has('RRC CONNECTION REQUEST');
            const isRabAssignmentRequest = has('RAB_ASSIGNMENT_REQUEST') || has('RAB ASSIGNMENT REQUEST') || has('RAB_ASSIGNMENT_REQ');
            const isCallProceeding = has('CALL_PROCEEDING') || has('CALL PROCEEDING');

            const isNasCallControl = (
                isCmServiceRequest ||
                isSetupMoMt ||
                isCallProceeding ||
                has('CC ') ||
                has('CALL CONTROL')
            );

            const isRrcSetupComplete = has('RRC_CONNECTION_SETUP_COMPLETE') || has('RRC CONNECTION SETUP COMPLETE');
            const isRabAssignComplete = has('RAB_ASSIGNMENT_COMPLETE') || has('RAB ASSIGNMENT COMPLETE') || has('RAB ASSIGN COMPLETE');
            const isRrcConnectionReject = has('RRC_CONNECTION_REJECT') || has('RRC CONNECTION REJECT');
            const isRabAssignmentFailure = has('RAB_ASSIGNMENT_FAILURE') || has('RAB ASSIGNMENT FAILURE') || has('RAB ASSIGN FAIL');
            const isConnect = hasWord('CONNECT') && !has('RRC_CONNECTION') && !has('SETUP_COMPLETE');
            const isDisconnect = hasWord('DISCONNECT');
            const isRelease = hasWord('RELEASE');
            const isRrcRelease = has('RRC_CONNECTION_RELEASE') || has('RRC CONNECTION RELEASE');

            const isRlf = has('RADIO LINK FAILURE') || has('RLF');
            const isIuRelease = has('IU RELEASE') || has('IU-CS RELEASE') || has('IUCS RELEASE');
            const isCmServiceReject = has('CM_SERVICE_REJECT') || has('CM SERVICE REJECT');
            const isCallReject = has('CALL_REJECT') || has('CALL REJECT');
            const isRabRelease = has('RAB RELEASE');
            const isHoFailure = has('HANDOVER FAILURE') || has('HO FAILURE') || has('HO_FAIL') || has('HOF') || has('INTER-RAT HO FAILURE') || has('IRAT HO FAILURE');

            const isNormalCause = causeEnvelope.includes('NORMAL');
            const isAbnormalCause = (
                causeEnvelope.includes('ABNORMAL') ||
                causeEnvelope.includes('FAIL') ||
                causeEnvelope.includes('ERROR') ||
                causeEnvelope.includes('RLF')
            );

            return {
                isCmServiceRequest,
                isSetupMoMt,
                isRrcConnectionRequest,
                isRabAssignmentRequest,
                isCallProceeding,
                isNasCallControl,
                isRrcSetupComplete,
                isRabAssignComplete,
                isRrcConnectionReject,
                isRabAssignmentFailure,
                isConnect,
                isDisconnect,
                isRelease,
                isRrcRelease,
                isRlf,
                isIuRelease,
                isCmServiceReject,
                isCallReject,
                isRabRelease,
                isHoFailure,
                isRrcReleaseNormal: isRrcRelease && isNormalCause,
                isRrcReleaseAbnormal: isRrcRelease && isAbnormalCause,
                isIuReleaseAbnormal: isIuRelease && isAbnormalCause
            };
        };

        const sortedRecords = (Array.isArray(records) ? records : [])
            .filter(r => r && r.time)
            .slice()
            .sort((a, b) => {
                const ta = parseTimeToMs(a.time);
                const tb = parseTimeToMs(b.time);
                if (Number.isNaN(ta) && Number.isNaN(tb)) return String(a.time).localeCompare(String(b.time));
                if (Number.isNaN(ta)) return 1;
                if (Number.isNaN(tb)) return -1;
                return ta - tb;
            });

        const sessions = [];
        let seq = 1;
        const stateByKey = new Map();

        const ensureKeyState = (key) => {
            if (!stateByKey.has(key)) {
                stateByKey.set(key, {
                    ueRrcState: 'IDLE',
                    activeSession: null,
                    pendingRrcRequestMs: null,
                    pendingRrcRequestTime: null
                });
            }
            return stateByKey.get(key);
        };

        const appendToSession = (session, rec, ids) => {
            if (!session.callTransactionId && ids.callId) session.callTransactionId = ids.callId;
            if (!session.imsi && ids.imsi) session.imsi = ids.imsi;
            if (!session.tmsi && ids.tmsi) session.tmsi = ids.tmsi;

            session.recordsCount += 1;
            const recMs = parseTimeToMs(rec.time);
            if (Number.isNaN(parseTimeToMs(session.startTime)) || (!Number.isNaN(recMs) && recMs < parseTimeToMs(session.startTime))) session.startTime = rec.time;
            if (Number.isNaN(parseTimeToMs(session.endTime)) || (!Number.isNaN(recMs) && recMs > parseTimeToMs(session.endTime))) session.endTime = rec.time;

            const rrcState = parseRrcFromRecord(rec);
            if (rrcState) {
                const last = session.rrcStates[session.rrcStates.length - 1];
                if (!last || last.state !== rrcState) {
                    session.rrcStates.push({ time: rec.time, state: rrcState });
                }
            }

            const rabEvent = parseRabEvent(rec);
            if (rabEvent) session.rabLifecycle.push(rabEvent);

            const measurement = parseMeasurement(rec);
            if (measurement) session.radioMeasurementsTimeline.push(measurement);
        };

        const createSession = (startTime, ids, startTrigger) => {
            const s = {
                sessionId: `call-session-${seq++}`,
                _source: 'generic',
                kind: 'RRC_SESSION',
                callTransactionId: ids.callId,
                imsi: ids.imsi,
                tmsi: ids.tmsi,
                resultType: 'RRC_SESSION',
                timeWindowMs,
                startTime,
                endTime: startTime,
                rrcStates: [],
                rabLifecycle: [],
                radioMeasurementsTimeline: [],
                recordsCount: 0,
                state: 'CALL_ATTEMPT',
                startTrigger,
                endTrigger: null,
                endType: null,
                drop: false,
                setupFailure: false,
                callFailed: false,
                hasConnect: false,
                callSetupSuccess: false,
                attemptStarted: true,
                ignored: false,
                incomplete: false,
                sawRrcSetupComplete: false,
                sawRrcConnectionReject: false,
                sawCmServiceReject: false,
                sawCallReject: false,
                sawRabAssignmentFailure: false,
                sawRabReleaseBeforeConnect: false,
                sawRlfBeforeConnect: false,
                failureReason: null,
                hasCsRab: false,
                disconnectSeen: false,
                normalClearingSeen: false
            };
            sessions.push(s);
            return s;
        };

        const classifyFailureReason = (session) => {
            if (!session || !session.setupFailure || session.hasConnect) return null;

            if (session.sawRrcConnectionReject && !session.sawRrcSetupComplete) {
                return {
                    code: 'RRC_FAILURE',
                    label: 'RRC Failure',
                    cause: 'overage / access congestion'
                };
            }
            if (session.sawCmServiceReject && session.sawCallReject) {
                return {
                    code: 'CORE_NAS_REJECT',
                    label: 'Core / NAS Reject',
                    cause: 'authentication, MSC congestion, no circuit'
                };
            }
            if (session.sawRabAssignmentFailure && session.sawRabReleaseBeforeConnect) {
                return {
                    code: 'RAB_SETUP_FAILURE',
                    label: 'RAB Setup Failure',
                    cause: 'code shortage, power congestion'
                };
            }
            if (session.sawRlfBeforeConnect) {
                return {
                    code: 'EARLY_RADIO_FAILURE',
                    label: 'Early Radio Failure',
                    cause: 'very poor RSCP / EcNo'
                };
            }
            return {
                code: 'UNKNOWN_FAILURE',
                label: 'Unknown Failure',
                cause: 'unclassified call setup failure'
            };
        };

        const endSession = (session, endTime, endTrigger, endType, asDrop) => {
            if (!session || session.state === 'ENDED') return;
            session.state = 'ENDED';
            session.endTime = endTime || session.endTime;
            const hasCallContext = !!(session.callTransactionId && String(session.callTransactionId).trim());
            const requestedEndType = endType || session.endType || 'UNKNOWN';
            const normalizedEndType = (!hasCallContext && requestedEndType === 'DROP')
                ? 'RRC_SESSION_ABNORMAL_END'
                : requestedEndType;
            const normalizedTrigger = (!hasCallContext && endTrigger === 'UNEXPECTED_IDLE_TRANSITION')
                ? 'RRC_IDLE_TRANSITION'
                : endTrigger;
            session.endTrigger = normalizedTrigger || session.endTrigger;
            session.endType = normalizedEndType;
            session.drop = hasCallContext ? !!asDrop : false;
            session.resultType = session.kind === 'RRC_SESSION'
                ? (session.drop ? 'RRC_SESSION_ABNORMAL_END' : 'RRC_SESSION')
                : session.resultType;
            session.callFailed = false;
            session.callSetupSuccess = false;
            session.failureReason = null;

            const startMs = parseTimeToMs(session.startTime);
            const endMs = parseTimeToMs(session.endTime);
            const durationMs = (!Number.isNaN(startMs) && !Number.isNaN(endMs) && endMs >= startMs) ? (endMs - startMs) : null;
            session.durationMs = durationMs;

            if (session.hasConnect) {
                session.callSetupSuccess = true;
                session.setupFailure = false;
                session.failureReason = null;
                return;
            }

            // Single truth rule: attempt started + no CONNECT + ended => Call Setup Failure.
            if (session.attemptStarted) {
                if (durationMs !== null && durationMs < minValidAttemptMs) {
                    session.ignored = true;
                    session.setupFailure = false;
                    session.callFailed = false;
                    session.endType = 'IGNORED_SHORT_ATTEMPT';
                    session.drop = false;
                    session.failureReason = null;
                    return;
                }

                if (durationMs !== null && durationMs > maxSetupWindowMs) {
                    session.incomplete = true;
                    session.setupFailure = false;
                    session.callFailed = false;
                    session.endType = 'INCOMPLETE_OR_ONGOING';
                    session.drop = false;
                    session.failureReason = null;
                    return;
                }

                session.setupFailure = true;
                session.callFailed = true;
                session.endType = 'CALL_SETUP_FAILURE';
                session.drop = false;
                session.failureReason = classifyFailureReason(session);
            }
        };

        const moveState = (session, nextState) => {
            if (!session || !nextState) return;
            session.state = nextState;
        };

        const resolveRuntimeKey = (baseKey) => {
            if (baseKey !== '__ANON__') return baseKey;
            const activeKeys = Array.from(stateByKey.entries())
                .filter(([k, st]) => k !== '__ANON__' && st.activeSession && st.activeSession.state !== 'ENDED')
                .map(([k]) => k);
            if (activeKeys.length === 1) return activeKeys[0];
            return '__ANON__';
        };

        for (const rec of sortedRecords) {
            const ids = extractIdentifiers(rec);
            const key = resolveRuntimeKey(getCorrelationKey(ids));
            const keyState = ensureKeyState(key);
            const sem = parseSemanticFlags(rec);
            const recMs = parseTimeToMs(rec.time);

            const prevRrc = keyState.ueRrcState;
            const parsedRrc = parseRrcFromRecord(rec);
            if (parsedRrc) keyState.ueRrcState = parsedRrc;
            const isIdleNow = isIdleState(keyState.ueRrcState);
            const wasIdle = isIdleState(prevRrc);
            const active = keyState.activeSession && keyState.activeSession.state !== 'ENDED' ? keyState.activeSession : null;

            if (!active && wasIdle && sem.isRrcConnectionRequest) {
                keyState.pendingRrcRequestMs = recMs;
                keyState.pendingRrcRequestTime = rec.time;
            }

            let session = active;

            const primaryStart = wasIdle && (sem.isCmServiceRequest || sem.isSetupMoMt);
            const secondaryStart = wasIdle && (sem.isRabAssignmentRequest || sem.isCallProceeding);
            const startFromRrcThenNas = (
                !session &&
                keyState.pendingRrcRequestMs !== null &&
                !Number.isNaN(recMs) &&
                sem.isNasCallControl &&
                recMs >= keyState.pendingRrcRequestMs &&
                (recMs - keyState.pendingRrcRequestMs) <= rrcNasFollowMs
            );

            if (!session && (primaryStart || secondaryStart || startFromRrcThenNas)) {
                let trigger = 'START_FALLBACK';
                let startTime = rec.time;
                if (primaryStart) trigger = sem.isCmServiceRequest ? 'CM_SERVICE_REQUEST' : 'SETUP';
                else if (secondaryStart) trigger = sem.isRabAssignmentRequest ? 'RAB_ASSIGNMENT_REQUEST' : 'CALL_PROCEEDING';
                else if (startFromRrcThenNas) {
                    trigger = 'RRC_CONNECTION_REQUEST_PLUS_NAS_CC';
                    startTime = keyState.pendingRrcRequestTime || rec.time;
                }

                session = createSession(startTime, ids, trigger);
                keyState.activeSession = session;
                keyState.pendingRrcRequestMs = null;
                keyState.pendingRrcRequestTime = null;
            }

            if (session) {
                appendToSession(session, rec, ids);

                const recEndMs = parseTimeToMs(rec.time);
                const sessionEndMs = parseTimeToMs(session.endTime);
                if (!Number.isNaN(recEndMs) && !Number.isNaN(sessionEndMs) && recEndMs > sessionEndMs + timeWindowMs) {
                    endSession(session, session.endTime, 'TIME_WINDOW_EXCEEDED', 'NORMAL', false);
                    keyState.activeSession = null;
                    continue;
                }

                if (sem.isRrcSetupComplete) moveState(session, 'RRC_CONNECTED');
                if (sem.isRrcSetupComplete) session.sawRrcSetupComplete = true;
                if (sem.isRrcConnectionReject) session.sawRrcConnectionReject = true;
                if (sem.isCmServiceReject) session.sawCmServiceReject = true;
                if (sem.isCallReject) session.sawCallReject = true;
                if (sem.isRabAssignmentFailure) session.sawRabAssignmentFailure = true;
                if (sem.isRabRelease && !session.hasConnect) session.sawRabReleaseBeforeConnect = true;
                if (sem.isRlf && !session.hasConnect) session.sawRlfBeforeConnect = true;
                if (sem.isRabAssignComplete) {
                    session.hasCsRab = true;
                    moveState(session, 'RAB_ESTABLISHED');
                }
                if (sem.isConnect) {
                    session.hasConnect = true;
                    moveState(session, 'ACTIVE_CALL');
                }
                if (sem.isDisconnect) {
                    session.disconnectSeen = true;
                    moveState(session, 'RELEASING');
                }
                if (session.hasCsRab && !isIdleNow && session.state !== 'ENDED' && !session.hasConnect) {
                    moveState(session, 'RAB_ESTABLISHED');
                }

                const connectEstablished = !!session.hasConnect;
                const abnormalAfterConnect = connectEstablished && !session.normalClearingSeen;

                if (sem.isRlf) {
                    endSession(session, rec.time, 'RADIO_LINK_FAILURE', abnormalAfterConnect ? 'DROP' : 'CALL_SETUP_FAILURE', abnormalAfterConnect);
                    keyState.activeSession = null;
                    continue;
                }
                if (sem.isIuReleaseAbnormal) {
                    endSession(session, rec.time, 'IU_RELEASE_ABNORMAL', abnormalAfterConnect ? 'DROP' : 'CALL_SETUP_FAILURE', abnormalAfterConnect);
                    keyState.activeSession = null;
                    continue;
                }
                if (sem.isRrcReleaseAbnormal) {
                    endSession(session, rec.time, 'RRC_CONNECTION_RELEASE_ABNORMAL', abnormalAfterConnect ? 'DROP' : 'CALL_SETUP_FAILURE', abnormalAfterConnect);
                    keyState.activeSession = null;
                    continue;
                }
                if (sem.isHoFailure && (sem.isRelease || sem.isRrcRelease || sem.isIuRelease)) {
                    endSession(session, rec.time, 'HANDOVER_FAILURE_RELEASE', abnormalAfterConnect ? 'DROP' : 'CALL_SETUP_FAILURE', abnormalAfterConnect);
                    keyState.activeSession = null;
                    continue;
                }
                if (connectEstablished && sem.isIuRelease && !session.disconnectSeen && !session.normalClearingSeen) {
                    endSession(session, rec.time, 'MSC_RELEASE_WITHOUT_DISCONNECT', 'DROP', true);
                    keyState.activeSession = null;
                    continue;
                }
                if (sem.isRrcReleaseNormal || (sem.isRrcRelease && session.disconnectSeen)) {
                    session.normalClearingSeen = true;
                    endSession(session, rec.time, 'RRC_CONNECTION_RELEASE_NORMAL', 'NORMAL', false);
                    keyState.activeSession = null;
                    continue;
                }
                if (sem.isCmServiceReject) {
                    endSession(session, rec.time, 'CM_SERVICE_REJECT', 'CALL_SETUP_FAILURE', false);
                    keyState.activeSession = null;
                    continue;
                }
                if (sem.isCallReject) {
                    endSession(session, rec.time, 'CALL_REJECT', 'CALL_SETUP_FAILURE', false);
                    keyState.activeSession = null;
                    continue;
                }
                if (sem.isRabRelease && !session.hasConnect) {
                    endSession(session, rec.time, 'RAB_RELEASE', 'CALL_SETUP_FAILURE', false);
                    keyState.activeSession = null;
                    continue;
                }
                if (sem.isIuRelease && !session.hasConnect) {
                    endSession(session, rec.time, 'IU_RELEASE', 'CALL_SETUP_FAILURE', false);
                    keyState.activeSession = null;
                    continue;
                }
                if (sem.isDisconnect && sem.isRelease) {
                    session.normalClearingSeen = true;
                    endSession(session, rec.time, 'DISCONNECT_RELEASE', 'NORMAL', false);
                    keyState.activeSession = null;
                    continue;
                }

                const transitionedToIdle = !isIdleState(prevRrc) && isIdleNow;
                if (transitionedToIdle) {
                    const expected = session.disconnectSeen || sem.isRelease || sem.isRrcReleaseNormal;
                    if (expected) endSession(session, rec.time, 'RETURN_TO_IDLE', 'NORMAL', false);
                    else endSession(session, rec.time, 'RRC_IDLE_TRANSITION', 'NORMAL', false);
                    keyState.activeSession = null;
                    continue;
                }
            }
        }

        return sessions;
    }
};

const UmtsCallAnalyzer = {
    analyze(content, options = {}) {
        const windowSeconds = Number.isFinite(options.windowSeconds) ? options.windowSeconds : 10;

        const parseCsvLine = (line) => {
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
        };

        const parseNumber = (v) => {
            if (v === undefined || v === null || v === '') return null;
            const n = parseFloat(String(v).trim());
            return Number.isFinite(n) ? n : null;
        };
        const median = (vals) => {
            if (!vals.length) return null;
            const a = vals.slice().sort((x, y) => x - y);
            const mid = Math.floor(a.length / 2);
            return a.length % 2 === 0 ? (a[mid - 1] + a[mid]) / 2 : a[mid];
        };
        const percentile = (vals, p) => {
            if (!vals.length) return null;
            const a = vals.slice().sort((x, y) => x - y);
            const idx = Math.ceil((p / 100) * a.length) - 1;
            return a[Math.max(0, Math.min(a.length - 1, idx))];
        };
        const stddev = (vals) => {
            if (!vals || vals.length < 2) return 0;
            const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
            const variance = vals.reduce((acc, v) => acc + ((v - mean) ** 2), 0) / vals.length;
            return Math.sqrt(variance);
        };
        const modeNumber = (vals) => {
            if (!Array.isArray(vals) || !vals.length) return null;
            const counts = new Map();
            let bestValue = null;
            let bestCount = 0;
            for (const v of vals) {
                if (!Number.isFinite(v)) continue;
                const next = (counts.get(v) || 0) + 1;
                counts.set(v, next);
                if (next > bestCount) {
                    bestCount = next;
                    bestValue = v;
                }
            }
            return Number.isFinite(bestValue) ? bestValue : null;
        };
        const getBestServerFromMimo = (blocks) => {
            const list = Array.isArray(blocks) ? blocks : [];
            return list.reduce((best, c) => {
                if (!c || !Number.isFinite(c.rscp)) return best;
                return (!best || c.rscp > best.rscp) ? c : best;
            }, null);
        };
        const lowerBound = (rows, ts) => {
            let lo = 0;
            let hi = rows.length;
            while (lo < hi) {
                const mid = (lo + hi) >> 1;
                if (rows[mid].ts < ts) lo = mid + 1;
                else hi = mid;
            }
            return lo;
        };
        const upperBound = (rows, ts) => {
            let lo = 0;
            let hi = rows.length;
            while (lo < hi) {
                const mid = (lo + hi) >> 1;
                if (rows[mid].ts <= ts) lo = mid + 1;
                else hi = mid;
            }
            return lo;
        };

        const parseStartDate = (parts) => {
            for (const raw of parts) {
                const txt = String(raw || '').trim().replace(/^"|"$/g, '');
                const m = txt.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
                if (!m) continue;
                return {
                    day: parseInt(m[1], 10),
                    month: parseInt(m[2], 10),
                    year: parseInt(m[3], 10)
                };
            }
            return null;
        };
        const parseTodMs = (txt) => {
            const m = String(txt || '').trim().match(/^(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/);
            if (!m) return null;
            const hh = parseInt(m[1], 10);
            const mm = parseInt(m[2], 10);
            const ss = parseInt(m[3], 10);
            const ms = parseInt((m[4] || '0').padEnd(3, '0'), 10);
            return (((hh * 60 + mm) * 60 + ss) * 1000) + ms;
        };

        const tsState = { baseUtcMs: null, prevTodMs: null, dayOffset: 0 };
        const setBaseDate = (dmy) => {
            if (!dmy) return;
            tsState.baseUtcMs = Date.UTC(dmy.year, dmy.month - 1, dmy.day, 0, 0, 0, 0);
            tsState.prevTodMs = null;
            tsState.dayOffset = 0;
        };
        const buildAbsMs = (todText) => {
            if (!Number.isFinite(tsState.baseUtcMs)) return null;
            const todMs = parseTodMs(todText);
            if (!Number.isFinite(todMs)) return null;
            const rolloverThreshold = 6 * 3600 * 1000;
            if (Number.isFinite(tsState.prevTodMs) && todMs < (tsState.prevTodMs - rolloverThreshold)) {
                tsState.dayOffset += 1;
            }
            tsState.prevTodMs = todMs;
            return tsState.baseUtcMs + tsState.dayOffset * 24 * 3600 * 1000 + todMs;
        };

        const radioStore = { byDevice: new Map() };
        const eventsByDevice = new Map();
        const CALL_HEADERS = new Set(['CAA', 'CAC', 'CAD', 'CAF', 'CARE']);
        const UMTS_TIMELINE_HEADERS = new Set([
            'RRCSM', 'L3SM', 'L3MM',
            'RRC', 'RRA', 'RRD', 'RRF',
            'RABA', 'RABD', 'RBI',
            'SHO', 'CELLMEAS'
        ]);
        const getDeviceStore = (deviceId) => {
            const key = String(deviceId || '');
            let dev = radioStore.byDevice.get(key);
            if (!dev) {
                dev = { mimoRows: [], txpcRows: [], rlcRows: [] };
                radioStore.byDevice.set(key, dev);
            }
            return dev;
        };
        const addDeviceEvent = (deviceId, ts, header, parts) => {
            const key = String(deviceId || '');
            let arr = eventsByDevice.get(key);
            if (!arr) {
                arr = [];
                eventsByDevice.set(key, arr);
            }
            arr.push({ ts, header, raw: parts.join(',') });
        };
        const parseMimoSamples = (parts) => {
            const start = 7;
            const remaining = parts.length - start;
            if (remaining <= 0) return [];
            let blockSize = 8;
            if (remaining % 8 !== 0) {
                if (remaining % 9 === 0) blockSize = 9;
                else return [];
            }
            const out = [];
            for (let i = start; i + blockSize - 1 < parts.length; i += blockSize) {
                const cellId = parseNumber(parts[i]);
                const uarfcn = parseNumber(parts[i + 1]);
                const psc = parseNumber(parts[i + 2]);
                const rscp = parseNumber(parts[i + 5]);
                const ecno = parseNumber(parts[i + 6]);
                const rssi = parseNumber(parts[i + 7]);
                if (psc === null || rscp === null || ecno === null) continue;
                out.push({ psc, rscp, ecno, rssi, cellId, uarfcn });
            }
            return out;
        };
        const parseRlcBler = (parts) => {
            const decimalNums = [];
            for (let i = 4; i < parts.length; i++) {
                const raw = String(parts[i] || '').trim();
                if (!raw) continue;
                const n = parseNumber(raw);
                if (n === null) continue;
                if (n >= 0 && n <= 100) {
                    if (raw.includes('.')) decimalNums.push(n);
                }
            }
            const nums = decimalNums;
            if (!nums.length) return null;
            return {
                blerMax: nums.reduce((a, b) => (a > b ? a : b), -Infinity),
                blerMean: nums.reduce((a, b) => a + b, 0) / nums.length
            };
        };
        const addRadio = (header, parts, ts, deviceId) => {
            const dev = getDeviceStore(deviceId);
            if (header === 'MIMOMEAS') {
                const samples = parseMimoSamples(parts);
                if (samples.length) dev.mimoRows.push({ ts, samples });
                return;
            }
            if (header === 'TXPC') {
                const tx = parseNumber(parts[4]);
                if (tx !== null) dev.txpcRows.push({ ts, tx });
                return;
            }
            if (header === 'RLCBLER') {
                const row = parseRlcBler(parts);
                if (row) dev.rlcRows.push({ ts, blerMax: row.blerMax, blerMean: row.blerMean });
            }
        };
        const buildSnapshot = (endTs, deviceId) => {
            if (!Number.isFinite(endTs)) return null;
            const dev = getDeviceStore(deviceId);
            const fromTs = endTs - (Math.max(1, windowSeconds) * 1000);
            const snap = {
                mimoSampleCount: 0,
                txSampleCountValid: 0,
                blerRowCount: 0,
                sampleCount: 0,
                trendMinSamples: 2,
                rscpMedian: null, rscpMin: null, rscpLast: null,
                ecnoMedian: null, ecnoMin: null, ecnoLast: null,
                lastPsc: null, lastCellId: null, lastUarfcn: null,
                lastMimoTs: null, lastTxTs: null, lastBestServer: null,
                txP90: null, txMax: null, txLast: null,
                blerMax: null, blerMean: null,
                rlcBlerSamplesCount: 0,
                blerEvidenceMinSamples: 3,
                blerEvidence: false,
                bestServerSamples: [],
                uniquePscCount: 0,
                seriesRscp: [],
                seriesEcno: [],
                rscpTrendDelta: null,
                ecnoTrendDelta: null,
                trendDurationSec: null,
                pilotDominanceDeltaMedian: null,
                pilotDominanceLowCount: 0,
                pilotDominanceSampleCount: 0,
                pilotDominanceLowRatio: null,
                pilotDominanceDeltaStd: null,
                activeSetSizeMean: null,
                activeSetSizeMax: null,
                badEcnoStrongRscpRatio: null,
                strongBadCount: 0,
                validBestCount: 0,
                pscSwitchCount: 0,
                pollutionScore: null,
                pollutionLevel: null,
                pilotPollution: null,
                pilotPollutionDetected: null,
                pilotPollutionEvidence: []
            };
            const mFrom = lowerBound(dev.mimoRows, fromTs);
            const mTo = upperBound(dev.mimoRows, endTs);
            const best = [];
            const dominanceDeltas = [];
            const activeSetSizes = [];
            for (let i = mFrom; i < mTo; i++) {
                const row = dev.mimoRows[i];
                const byPsc = new Map();
                row.samples.forEach(s => {
                    const key = String(s.psc);
                    const cur = byPsc.get(key) || { psc: s.psc, rscpSum: 0, ecnoSum: 0, rssiSum: 0, rssiCount: 0, count: 0, cellId: s.cellId, uarfcn: s.uarfcn };
                    cur.rscpSum += s.rscp;
                    cur.ecnoSum += s.ecno;
                    if (Number.isFinite(s.rssi)) {
                        cur.rssiSum += s.rssi;
                        cur.rssiCount += 1;
                    }
                    cur.count += 1;
                    byPsc.set(key, cur);
                });
                const blocks = [];
                byPsc.forEach(v => {
                    const avgRscp = v.rscpSum / v.count;
                    blocks.push({ ts: row.ts, rscp: avgRscp, ecno: v.ecnoSum / v.count, rssi: v.rssiCount > 0 ? (v.rssiSum / v.rssiCount) : null, psc: v.psc, cellId: v.cellId, uarfcn: v.uarfcn });
                });
                if (blocks.length) activeSetSizes.push(blocks.length);
                if (blocks.length >= 2) {
                    const sorted = blocks.slice().sort((a, b) => b.rscp - a.rscp);
                    const delta = sorted[0].rscp - sorted[1].rscp;
                    if (Number.isFinite(delta)) dominanceDeltas.push(delta);
                }
                const bestSample = getBestServerFromMimo(blocks);
                if (bestSample) best.push(bestSample);
            }
            if (best.length) {
                const rscpVals = best.map(x => x.rscp);
                const ecnoVals = best.map(x => x.ecno);
                const last = best[best.length - 1];
                snap.rscpMedian = median(rscpVals);
                snap.rscpMin = Math.min(...rscpVals);
                snap.rscpLast = last.rscp;
                snap.ecnoMedian = median(ecnoVals);
                snap.ecnoMin = Math.min(...ecnoVals);
                snap.ecnoLast = last.ecno;
                snap.lastPsc = last.psc;
                snap.lastCellId = last.cellId;
                snap.lastUarfcn = last.uarfcn;
                snap.bestServerSamples = best;
                snap.uniquePscCount = new Set(best.map(x => String(x.psc))).size;
                snap.lastMimoTs = last.ts;
                snap.lastBestServer = {
                    psc: last.psc,
                    uarfcn: last.uarfcn,
                    cellId: last.cellId,
                    rscp: last.rscp,
                    ecno: last.ecno,
                    rssi: Number.isFinite(last.rssi) ? last.rssi : null
                };
                snap.seriesRscp = best.map(v => ({ ts: v.ts, value: v.rscp }));
                snap.seriesEcno = best.map(v => ({ ts: v.ts, value: v.ecno }));
                const validBest = best.filter(v => Number.isFinite(v.rscp) && Number.isFinite(v.ecno));
                const validBestCount = validBest.length;
                const strongRscpCount = validBest.filter(v => v.rscp > -85).length;
                const strongBadCount = validBest.filter(v => v.rscp > -85 && v.ecno < -14).length;
                snap.validBestCount = validBestCount;
                snap.strongBadCount = strongBadCount;
                snap.badEcnoStrongRscpRatio = strongRscpCount ? (strongBadCount / strongRscpCount) : null;
                let switches = 0;
                for (let i = 1; i < best.length; i++) {
                    if (best[i].psc !== best[i - 1].psc) switches += 1;
                }
                snap.pscSwitchCount = switches;
            }
            if (dominanceDeltas.length) {
                snap.pilotDominanceSampleCount = dominanceDeltas.length;
                snap.pilotDominanceDeltaMedian = median(dominanceDeltas);
                snap.pilotDominanceDeltaStd = stddev(dominanceDeltas);
                snap.pilotDominanceLowCount = dominanceDeltas.filter(d => Number.isFinite(d) && d < 3).length;
                snap.pilotDominanceLowRatio = snap.pilotDominanceLowCount / dominanceDeltas.length;
            }
            if (activeSetSizes.length) {
                snap.activeSetSizeMean = activeSetSizes.reduce((a, b) => a + b, 0) / activeSetSizes.length;
                snap.activeSetSizeMax = Math.max(...activeSetSizes);
            }
            // Preload TX/BLER so interference scoring can use finalized metrics.
            const preTxFrom = lowerBound(dev.txpcRows, fromTs);
            const preTxTo = upperBound(dev.txpcRows, endTs);
            if (preTxTo > preTxFrom) {
                const txValues = dev.txpcRows.slice(preTxFrom, preTxTo).map(v => v.tx).filter(v => Number.isFinite(v));
                if (txValues.length) {
                    snap.txP90 = computeP90(txValues);
                    snap.txMax = Math.max(...txValues);
                    snap.txLast = txValues[txValues.length - 1];
                }
            }
            const preRFrom = lowerBound(dev.rlcRows, fromTs);
            const preRTo = upperBound(dev.rlcRows, endTs);
            if (preRTo > preRFrom) {
                const blerRowsPre = dev.rlcRows.slice(preRFrom, preRTo);
                snap.blerMax = blerRowsPre.reduce((m, r) => (r.blerMax > m ? r.blerMax : m), -Infinity);
                snap.blerMean = blerRowsPre.reduce((sum, r) => sum + r.blerMean, 0) / blerRowsPre.length;
            }
            const deltaMedianRaw = Number.isFinite(snap.pilotDominanceDeltaMedian) ? snap.pilotDominanceDeltaMedian : null;
            const deltaRatioRaw = Number.isFinite(snap.pilotDominanceLowRatio) ? snap.pilotDominanceLowRatio : null;
            const deltaStdRaw = Number.isFinite(snap.pilotDominanceDeltaStd) ? snap.pilotDominanceDeltaStd : null;
            const pscSwitchCount = Number.isFinite(snap.pscSwitchCount) ? snap.pscSwitchCount : 0;
            const activeSetMean = Number.isFinite(snap.activeSetSizeMean) ? snap.activeSetSizeMean : 0;
            const activeSetMax = Number.isFinite(snap.activeSetSizeMax) ? snap.activeSetSizeMax : 0;
            const totalMimoSamples = best.length;
            const samplesWith2Pilots = dominanceDeltas.length;
            const deltaCoverageRatio = totalMimoSamples > 0 ? (samplesWith2Pilots / totalMimoSamples) : null;
            const deltaLowConfidence = !Number.isFinite(deltaCoverageRatio) || deltaCoverageRatio < 0.30;
            const validBest = best.filter(v => Number.isFinite(v.rscp) && Number.isFinite(v.ecno));
            const validBestCount = Number.isFinite(snap.validBestCount) ? snap.validBestCount : validBest.length;
            const strongBadCount = Number.isFinite(snap.strongBadCount) ? snap.strongBadCount : validBest.filter(v => v.rscp > -85 && v.ecno < -14).length;
            const bestPsc = modeNumber(best.map(v => v.psc));
            const rscpValidValues = validBest.map(v => v.rscp);
            const ecnoValidValues = validBest.map(v => v.ecno);
            const levelFromScore = (v) => v >= 60 ? 'High' : (v >= 35 ? 'Moderate' : 'Low');
            const strongRscpCount = validBest.filter(v => v.rscp > -85).length;
            const ratioStrongShare = validBestCount > 0 ? (strongRscpCount / validBestCount) : null;
            const ratioBad = strongRscpCount > 0 ? (strongBadCount / strongRscpCount) : null;
            const strongRscpShare = ratioStrongShare;
            const dominanceAvailable = samplesWith2Pilots > 0;
            const hasStrongDominanceEvidence = dominanceAvailable && !deltaLowConfidence;
            const deltaMedian = dominanceAvailable ? deltaMedianRaw : null;
            const deltaRatio = dominanceAvailable ? deltaRatioRaw : null;
            const deltaStd = dominanceAvailable ? deltaStdRaw : null;
            let dominanceScore = 0;
            if (hasStrongDominanceEvidence) {
                if (deltaMedian !== null && deltaMedian < 2) dominanceScore += 30;
                if (Number.isFinite(deltaRatio) && deltaRatio > 0.70) dominanceScore += 30;
                if (Number.isFinite(deltaStd) && deltaStd > 2) dominanceScore += 10;
            }
            if (dominanceAvailable) {
                if (activeSetMax >= 3) dominanceScore += 20;
                if (activeSetMean >= 2) dominanceScore += 10;
                if (pscSwitchCount > 2) dominanceScore += 20;
                dominanceScore = Math.max(0, Math.min(100, dominanceScore));
            } else {
                dominanceScore = null;
            }

            let interferenceScore = 0;
            if (Number.isFinite(snap.blerMax) && snap.blerMax >= 80) interferenceScore += 40;
            if (Number.isFinite(snap.ecnoMedian) && snap.ecnoMedian <= -12) interferenceScore += 30;
            if (Number.isFinite(snap.rscpMedian) && snap.rscpMedian >= -90) interferenceScore += 20;
            if (Number.isFinite(snap.txP90) && snap.txP90 <= 18) interferenceScore += 10;
            interferenceScore = Math.max(0, Math.min(100, interferenceScore));

            const dominanceLevel = dominanceAvailable ? levelFromScore(dominanceScore) : 'N/A';
            const interferenceLevel = levelFromScore(interferenceScore);
            let finalLabel = 'Low overlap risk';
            let pollutionScore = dominanceAvailable ? dominanceScore : interferenceScore;
            let pollutionLevel = dominanceAvailable ? dominanceLevel : interferenceLevel;
            const explicitDlInterferenceSignature = Number.isFinite(snap.blerMax) && snap.blerMax >= 80 &&
                Number.isFinite(snap.rscpMedian) && snap.rscpMedian >= -90 &&
                Number.isFinite(snap.txP90) && snap.txP90 <= 18;
            if (interferenceScore >= 60 && ((Number.isFinite(strongRscpShare) && strongRscpShare >= 0.30) || explicitDlInterferenceSignature)) {
                finalLabel = hasStrongDominanceEvidence ? 'Pilot Pollution / DL Interference' : 'DL Interference (dominance evidence unavailable)';
                pollutionScore = interferenceScore;
                pollutionLevel = interferenceLevel;
            } else if (hasStrongDominanceEvidence && dominanceScore >= 60 && Number.isFinite(strongRscpShare) && strongRscpShare < 0.30) {
                finalLabel = 'High overlap / poor dominance under weak coverage';
                pollutionScore = dominanceScore;
                pollutionLevel = dominanceLevel;
            } else if (hasStrongDominanceEvidence && dominanceScore >= 35) {
                finalLabel = 'Overlap risk';
                pollutionScore = dominanceScore;
                pollutionLevel = dominanceLevel;
            } else if (!hasStrongDominanceEvidence && interferenceScore < 60) {
                finalLabel = 'Dominance unavailable / low interference risk';
                pollutionScore = interferenceScore;
                pollutionLevel = interferenceLevel;
            }
            snap.pollutionScore = pollutionScore;
            snap.pollutionLevel = dominanceAvailable ? pollutionLevel : 'N/A';
            const countBelow3 = Number.isFinite(snap.pilotDominanceLowCount) ? snap.pilotDominanceLowCount : 0;
            const deltaMedianText = samplesWith2Pilots > 0 && deltaMedian !== null ? `${deltaMedian.toFixed(2)} dB` : 'n/a';
            const deltaStdText = samplesWith2Pilots > 0 && Number.isFinite(deltaStd) ? `${deltaStd.toFixed(2)} dB` : 'n/a';
            const deltaRatioPct = (samplesWith2Pilots > 0 && Number.isFinite(deltaRatio)) ? (deltaRatio * 100).toFixed(0) : 'n/a';
            const deltaRatioDen = samplesWith2Pilots > 0 ? `${countBelow3}/${samplesWith2Pilots}` : '0/0';
            const strongSharePct = validBestCount > 0 && Number.isFinite(ratioStrongShare) ? (ratioStrongShare * 100).toFixed(0) : 'n/a';
            const strongBadPct = strongRscpCount > 0 && Number.isFinite(ratioBad) ? (ratioBad * 100).toFixed(0) : 'n/a';
            const detailsText = [
                `Window: ${Math.max(1, windowSeconds)}s before end. MIMOMEAS samples: ${totalMimoSamples}.`,
                `Final classification: ${finalLabel} (${pollutionLevel}, ${pollutionScore}/100).`,
                `Overlap / dominance risk: ${hasStrongDominanceEvidence ? `${dominanceLevel} (${dominanceScore}/100)` : `N/A (0/${totalMimoSamples} >=2-pilot)`}.`,
                `Interference-under-strong-signal risk: ${interferenceLevel} (${interferenceScore}/100).`,
                `Overall label: ${finalLabel}.`,
                `ΔRSCP(best-2nd): computed only on timestamps with >=2 pilots (${samplesWith2Pilots}/${totalMimoSamples}).`,
                `• ΔRSCP median: ${deltaMedianText}`,
                `• ΔRSCP <3 dB ratio: ${deltaRatioPct}${deltaRatioPct === 'n/a' ? '' : '%'} (${deltaRatioDen})`,
                `• ΔRSCP std: ${deltaStdText}`,
                'Strong RSCP + bad EcNo (best server):',
                '• Thresholds: RSCP > -85 dBm AND EcNo < -14 dB',
                `• Strong RSCP share computed on ${strongRscpCount}/${validBestCount} best-server samples (RSCP > -85): ${strongSharePct}${strongSharePct === 'n/a' ? '' : '%'}`,
                `• Strong RSCP + bad EcNo computed on ${strongBadCount}/${strongRscpCount} strong samples (EcNo < -14): ${strongBadPct}${strongBadPct === 'n/a' ? '' : '%'}`,
                `• Best-server denominator reference: ${validBestCount}/${totalMimoSamples}`,
                `• RSCP range: ${rscpValidValues.length ? `${Math.min(...rscpValidValues).toFixed(2)} .. ${Math.max(...rscpValidValues).toFixed(2)}` : 'n/a'} dBm`,
                `• EcNo range: ${ecnoValidValues.length ? `${Math.min(...ecnoValidValues).toFixed(2)} .. ${Math.max(...ecnoValidValues).toFixed(2)}` : 'n/a'} dB`,
                'Serving stability:',
                `• Best PSC switches: ${pscSwitchCount}${Number.isFinite(bestPsc) ? ` (best PSC: ${bestPsc})` : ''}`,
                'Active-set proxy (<=3 dB):',
                '• Definition: pilots within 3 dB of best RSCP per timestamp',
                `• Mean/max: ${activeSetMean.toFixed(2)} / ${activeSetMax}`
            ];
            if (!dominanceAvailable) {
                detailsText.push('Dominance evidence unavailable: no timestamps with >=2 pilots were found in this window.');
            } else if (deltaLowConfidence) {
                detailsText.push(`Dominance evidence is low-confidence: only ${samplesWith2Pilots}/${totalMimoSamples} timestamps have >=2 pilots.`);
            }
            if (deltaLowConfidence) {
                detailsText.push(
                    `ΔRSCP could only be calculated at ${samplesWith2Pilots} time points because nearby cells were not consistently detectable. As a result, the ΔRSCP analysis is based on limited data and should be interpreted with caution.`
                );
            }
            snap.pilotPollution = {
                riskLevel: dominanceAvailable ? pollutionLevel : 'N/A',
                score: pollutionScore,
                pollutionScore,
                pollutionLevel: dominanceAvailable ? pollutionLevel : 'N/A',
                dominanceScore,
                dominanceLevel,
                dominanceAvailable,
                interferenceScore,
                interferenceLevel,
                strongRscpShare,
                finalLabel,
                deltaStats: {
                    medianDb: deltaMedian,
                    stdDb: deltaStd,
                    lt3dbRatio: deltaRatio,
                    samplesWith2Pilots,
                    totalMimoSamples,
                    computedCount: samplesWith2Pilots,
                    confidenceLow: deltaLowConfidence,
                    deltaUnavailableReason: dominanceAvailable ? null : 'no >=2 pilot timestamps',
                    deltas: dominanceDeltas.slice()
                },
                strongRscpBadEcno: {
                    ratio: ratioBad,
                    ratioStrongShare,
                    ratioBad,
                    strongCount: strongRscpCount,
                    strongBadCount,
                    denomBestValid: validBestCount,
                    denomTotalMimo: totalMimoSamples,
                    rscpThresholdDbm: -85,
                    ecnoThresholdDb: -14,
                    rscpMinDbm: rscpValidValues.length ? Math.min(...rscpValidValues) : null,
                    rscpMaxDbm: rscpValidValues.length ? Math.max(...rscpValidValues) : null,
                    ecnoMinDb: ecnoValidValues.length ? Math.min(...ecnoValidValues) : null,
                    ecnoMaxDb: ecnoValidValues.length ? Math.max(...ecnoValidValues) : null
                },
                bestPscSwitches: pscSwitchCount,
                bestPsc,
                activeSet: {
                    definition: 'count of pilots within 3 dB of best RSCP per timestamp',
                    mean: activeSetMean,
                    max: activeSetMax
                },
                detailsText,
                details: {
                    deltaMedian,
                    deltaRatio,
                    deltaStd,
                    deltaConfidenceLow: deltaLowConfidence,
                    badEcnoStrongRscpRatio: ratioBad,
                    pscSwitchCount,
                    activeSetMean,
                    activeSetMax
                }
            };
            snap.pilotPollutionDetected = pollutionScore >= 35;
            snap.pilotPollutionEvidence = [
                `Final=${finalLabel} (${pollutionLevel}, ${pollutionScore}/100), dominance=${dominanceScore}/100, interference=${interferenceScore}/100`,
                `Dominance denominator (>=2 pilots): ${samplesWith2Pilots}/${totalMimoSamples}`,
                `Strong RSCP share=${Number.isFinite(ratioStrongShare) ? `${(ratioStrongShare * 100).toFixed(0)}%` : 'n/a'} (${strongRscpCount}/${validBestCount})`,
                (deltaLowConfidence ? 'ΔRSCP confidence is low (<30% of samples have >=2 pilots), excluded from primary root-cause scoring.' : 'ΔRSCP confidence is acceptable for scoring.'),
                `ΔRSCP median=${deltaMedian !== null ? deltaMedian.toFixed(2) : 'n/a'} dB, ΔRSCP<3dB ratio=${Number.isFinite(deltaRatio) ? `${(deltaRatio * 100).toFixed(0)}%` : 'n/a'}, ΔRSCP std=${Number.isFinite(deltaStd) ? deltaStd.toFixed(2) : 'n/a'} dB`,
                `Strong-RSCP with bad EcNo ratio=${Number.isFinite(ratioBad) ? `${(ratioBad * 100).toFixed(0)}%` : 'n/a'} (${strongBadCount}/${strongRscpCount})`,
                `Best PSC switches=${pscSwitchCount}, activeSet mean=${activeSetMean.toFixed(2)}, max=${activeSetMax}`
            ];

            const txFrom = lowerBound(dev.txpcRows, fromTs);
            const txTo = upperBound(dev.txpcRows, endTs);
            if (txTo > txFrom) {
                const txVals = dev.txpcRows.slice(txFrom, txTo).map(v => v.tx).filter(v => Number.isFinite(v));
                snap.txSampleCountValid = txVals.length;
                if (txVals.length) {
                    snap.txP90 = percentile(txVals, 90);
                    snap.txMax = Math.max(...txVals);
                    snap.txLast = txVals[txVals.length - 1];
                    const txRows = dev.txpcRows.slice(txFrom, txTo).filter(v => Number.isFinite(v.tx));
                    snap.lastTxTs = txRows.length ? txRows[txRows.length - 1].ts : null;
                }
            }
            const rFrom = lowerBound(dev.rlcRows, fromTs);
            const rTo = upperBound(dev.rlcRows, endTs);
            if (rTo > rFrom) {
                const rows = dev.rlcRows.slice(rFrom, rTo);
                snap.blerRowCount = rows.length;
                snap.rlcBlerSamplesCount = rows.length;
                snap.blerMax = rows.reduce((m, r) => (r.blerMax > m ? r.blerMax : m), -Infinity);
                snap.blerMean = rows.reduce((s, r) => s + r.blerMean, 0) / rows.length;
            }
            snap.blerEvidence = Number.isFinite(snap.rlcBlerSamplesCount) && snap.rlcBlerSamplesCount >= snap.blerEvidenceMinSamples;
            snap.mimoSampleCount = best.length;
            snap.sampleCount = best.length;
            if (best.length >= 2) {
                const first = best[0];
                const last = best[best.length - 1];
                snap.rscpTrendDelta = last.rscp - first.rscp;
                snap.ecnoTrendDelta = last.ecno - first.ecno;
                snap.trendDurationSec = Math.max(0.001, (last.ts - first.ts) / 1000);
            }
            snap.trendMessage = best.length === 0 ? 'No MIMOMEAS samples in last 10s.' : (best.length < 2 ? `Only ${best.length} MIMOMEAS samples in last 10s — trend not computed.` : `Trend computed from ${best.length} MIMOMEAS samples in last 10s.`);
            return snap;
        };

        const computeP90 = (values) => {
            if (!Array.isArray(values) || values.length === 0) return null;
            const sorted = values.slice().sort((a, b) => a - b);
            const idx = Math.max(0, Math.ceil(0.9 * sorted.length) - 1);
            return sorted[idx];
        };

        const makeEventBrief = (e) => e ? ({
            tsIso: Number.isFinite(e.ts) ? new Date(e.ts).toISOString() : null,
            header: e.header,
            raw: e.raw
        }) : null;

        const buildSetupFailureContextBundle = (session, radioPreEndSec = 20, signalingAroundEndSec = 20) => {
            if (!session || !Number.isFinite(session.endTsReal)) return null;
            const endTs = session.endTsReal;
            const radioFromTs = endTs - Math.max(1, radioPreEndSec) * 1000;
            const signalingFromTs = endTs - Math.max(1, signalingAroundEndSec) * 1000;
            const signalingToTs = endTs + Math.max(1, signalingAroundEndSec) * 1000;

            const dev = getDeviceStore(session.deviceId || '');
            const mimoFrom = lowerBound(dev.mimoRows, radioFromTs);
            const mimoTo = upperBound(dev.mimoRows, endTs);
            const bestServerSeries = [];
            for (let i = mimoFrom; i < mimoTo; i++) {
                const row = dev.mimoRows[i];
                const byPsc = new Map();
                (row.samples || []).forEach(s => {
                    const key = String(s.psc);
                    const cur = byPsc.get(key) || { psc: s.psc, rscpSum: 0, ecnoSum: 0, count: 0, cellId: s.cellId, uarfcn: s.uarfcn };
                    cur.rscpSum += s.rscp;
                    cur.ecnoSum += s.ecno;
                    cur.count += 1;
                    byPsc.set(key, cur);
                });
                const blocks = [];
                byPsc.forEach(v => {
                    if (!Number.isFinite(v.count) || v.count <= 0) return;
                    blocks.push({
                        ts: row.ts,
                        psc: v.psc,
                        rscp: v.rscpSum / v.count,
                        ecno: v.ecnoSum / v.count,
                        cellId: v.cellId,
                        uarfcn: v.uarfcn
                    });
                });
                const best = getBestServerFromMimo(blocks);
                if (best) bestServerSeries.push(best);
            }

            const rscpValues = bestServerSeries.map(s => s.rscp).filter(Number.isFinite);
            const ecnoValues = bestServerSeries.map(s => s.ecno).filter(Number.isFinite);

            const txFrom = lowerBound(dev.txpcRows, radioFromTs);
            const txTo = upperBound(dev.txpcRows, endTs);
            const txRows = dev.txpcRows.slice(txFrom, txTo).filter(v => Number.isFinite(v.tx));
            const txValues = txRows.map(v => v.tx);

            const rFrom = lowerBound(dev.rlcRows, radioFromTs);
            const rTo = upperBound(dev.rlcRows, endTs);
            const blerRows = dev.rlcRows.slice(rFrom, rTo);
            const blerMax = blerRows.length ? blerRows.reduce((m, r) => (r.blerMax > m ? r.blerMax : m), -Infinity) : null;
            const blerTrend = blerRows.length >= 2 && Number.isFinite(blerRows[0].blerMean) && Number.isFinite(blerRows[blerRows.length - 1].blerMean)
                ? (blerRows[blerRows.length - 1].blerMean - blerRows[0].blerMean)
                : null;

            const deviceEvents = (eventsByDevice.get(String(session.deviceId || '')) || []).slice().sort((a, b) => a.ts - b.ts);
            const signalingWindowEvents = deviceEvents.filter(e => e.ts >= signalingFromTs && e.ts <= signalingToTs);
            const last20EventsBeforeEnd = deviceEvents.filter(e => e.ts >= signalingFromTs && e.ts <= endTs).slice(-20);
            const first10EventsAfterStart = Number.isFinite(session.startTs)
                ? deviceEvents.filter(e => e.ts >= session.startTs && e.ts <= signalingToTs).slice(0, 10)
                : [];
            const closestRrcOrHoBeforeEnd = deviceEvents
                .filter(e => e.ts <= endTs && (String(e.header || '').toUpperCase() === 'RRCSM' || String(e.header || '').toUpperCase() === 'SHO'))
                .slice(-1)[0] || null;
            const closestReleaseReject = signalingWindowEvents
                .filter(e => /reject|release|fail|cause/i.test(String(e.raw || '')) || /CAD|CAF|CARE/i.test(String(e.header || '')))
                .map(e => ({ ...e, dist: Math.abs(endTs - e.ts) }))
                .sort((a, b) => a.dist - b.dist)[0] || null;

            return {
                type: 'SETUP_FAILURE_CONTEXT_BUNDLE',
                windows: {
                    radioPreEndSec,
                    signalingAroundEndSec,
                    radioWindowStartIso: new Date(radioFromTs).toISOString(),
                    radioWindowEndIso: new Date(endTs).toISOString(),
                    signalingWindowStartIso: new Date(signalingFromTs).toISOString(),
                    signalingWindowEndIso: new Date(signalingToTs).toISOString()
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
                    txP90: computeP90(txValues),
                    txMax: txValues.length ? Math.max(...txValues) : null,
                    blerMax,
                    blerTrend,
                    bestServerSeries: bestServerSeries.map(s => ({
                        tsIso: Number.isFinite(s.ts) ? new Date(s.ts).toISOString() : null,
                        psc: s.psc,
                        uarfcn: s.uarfcn,
                        rscp: s.rscp,
                        ecno: s.ecno
                    })),
                    txSeries: txRows.map(r => ({ tsIso: Number.isFinite(r.ts) ? new Date(r.ts).toISOString() : null, tx: r.tx })),
                    blerSeries: blerRows.map(r => ({ tsIso: Number.isFinite(r.ts) ? new Date(r.ts).toISOString() : null, blerMax: r.blerMax, blerMean: r.blerMean }))
                },
                signalingContext: {
                    totalEventsInWindow: signalingWindowEvents.length,
                    last20EventsBeforeEnd: last20EventsBeforeEnd.map(makeEventBrief),
                    first10EventsAfterStart: first10EventsAfterStart.map(makeEventBrief),
                    closestRrcOrHoBeforeEnd: makeEventBrief(closestRrcOrHoBeforeEnd),
                    closestReleaseRejectCause: makeEventBrief(closestReleaseReject)
                },
                callControlContext: {
                    deviceId: session.deviceId || null,
                    callId: session.callId || null,
                    connectedEver: Number.isFinite(session.connectedTs),
                    cAA: Number.isFinite(session.startTs) ? new Date(session.startTs).toISOString() : null,
                    cACConnected: Number.isFinite(session.connectedTs) ? new Date(session.connectedTs).toISOString() : null,
                    cAD: Number.isFinite(session.endTsCad) ? new Date(session.endTsCad).toISOString() : null,
                    cAF: Number.isFinite(session.endTsCaf) ? new Date(session.endTsCaf).toISOString() : null,
                    cARE: Number.isFinite(session.endTsCare) ? new Date(session.endTsCare).toISOString() : null,
                    endTsReal: Number.isFinite(session.endTsReal) ? new Date(session.endTsReal).toISOString() : null,
                    cadStatus: session.cadStatus ?? null,
                    cadCause: session.cadCause ?? null,
                    cafReason: session.cafReason ?? null
                }
            };
        };

        const isHealthyRadioSnapshot = (snapshot) => (
            Number.isFinite(snapshot?.rscpMedian) && snapshot.rscpMedian > -85 &&
            Number.isFinite(snapshot?.ecnoMedian) && snapshot.ecnoMedian > -10 &&
            Number.isFinite(snapshot?.txP90) && snapshot.txP90 < 20 &&
            snapshot?.blerEvidence === true &&
            Number.isFinite(snapshot?.blerMax) && snapshot.blerMax < 5
        );

        const decodeCadCauseLabel = (cause) => {
            const map = {
                16: 'Normal call clearing',
                17: 'User busy',
                18: 'No user responding',
                19: 'No answer from user',
                21: 'Call rejected',
                27: 'Destination out of order',
                34: 'No circuit/channel available',
                41: 'Temporary failure',
                42: 'Switching equipment congestion',
                47: 'Resource unavailable',
                102: 'Setup timeout (timer expiry)'
            };
            return map[cause] || 'Unknown cause';
        };

        const buildRadioEvaluation = (snapshot, category, domain, session) => {
            const rscp = snapshot?.rscpMedian;
            const ecno = snapshot?.ecnoMedian;
            const tx = snapshot?.txP90;
            const bler = snapshot?.blerMax;
            const blerEvidence = snapshot?.blerEvidence === true;
            const rlcCount = Number.isFinite(snapshot?.rlcBlerSamplesCount) ? snapshot.rlcBlerSamplesCount : 0;
            const parts = [];

            if (Number.isFinite(rscp)) {
                parts.push(rscp >= -90
                    ? `Coverage is acceptable (RSCP median ${rscp.toFixed(1)} dBm).`
                    : `Coverage is weak (RSCP median ${rscp.toFixed(1)} dBm).`);
            } else {
                parts.push('Coverage is not assessable (RSCP median n/a).');
            }

            if (Number.isFinite(tx)) {
                if (tx <= 18) parts.push(`Uplink margin appears strong (UE Tx p90 ${tx.toFixed(1)} dBm), arguing against UL limitation.`);
                else parts.push(`UE Tx is elevated (p90 ${tx.toFixed(1)} dBm), suggesting uplink stress or poor UL margin.`);
            } else {
                parts.push('Uplink margin is not assessable (UE Tx p90 n/a).');
            }

            if (Number.isFinite(ecno)) {
                if (ecno <= -14) parts.push(`Downlink quality is severely degraded (EcNo median ${ecno.toFixed(1)} dB), consistent with interference/overlap or weak dominance.`);
                else if (ecno <= -12) parts.push(`Downlink quality is borderline (EcNo median ${ecno.toFixed(1)} dB).`);
                else parts.push(`Downlink quality is acceptable (EcNo median ${ecno.toFixed(1)} dB).`);
            } else {
                parts.push('Downlink quality is not assessable (EcNo median n/a).');
            }

            if (blerEvidence) {
                if (Number.isFinite(bler) && bler >= 80) parts.push(`DL decoding collapses (BLER max ${bler.toFixed(1)}%), indicating DL decode impairment.`);
                else if (Number.isFinite(bler)) parts.push(`BLER is not elevated (max ${bler.toFixed(1)}%).`);
            } else {
                parts.push('BLER is not informative during setup (insufficient RLC BLER samples); do not use BLER to judge DL health.');
            }

            const isTimeout = category === 'SETUP_TIMEOUT' || domain === 'Signaling/Timeout' || Number(session?.cadCause) === 102;
            if (isTimeout && Number.isFinite(ecno) && ecno <= -14) {
                parts.push('Radio quality (very low EcNo) may contribute to retransmissions/latency, which can drive timeout even when BLER is not measurable.');
            }
            const isDlSignature = blerEvidence &&
                Number.isFinite(bler) && bler >= 80 &&
                Number.isFinite(rscp) && rscp >= -90 &&
                (!Number.isFinite(tx) || tx <= 18);
            if (isDlSignature) {
                parts.push('This matches a DL decode-impairment signature (interference/noise-rise/control-channel decode issues).');
            }
            if (Number.isFinite(rlcCount) && rlcCount > 0 && rlcCount < 3) {
                parts.push(`RLC BLER sample count is low (${rlcCount}), so BLER confidence is limited.`);
            }
            return parts.join(' ');
        };

        const decodeCafReasonLabel = (reason) => {
            const map = {
                0: 'Unknown/Not provided',
                1: 'User action / call aborted (tool-specific)',
                2: 'Setup failed / call attempt aborted (network or radio procedure failed)',
                3: 'Call rejected (tool-specific)'
            };
            return map[reason] || 'Unknown/tool-specific reason';
        };

        const buildSetupFailureDeepAnalysis = (session, snapshot, contextBundle, classification) => {
            if (!session || session.resultType !== 'CALL_SETUP_FAILURE') return null;
            const radioHealthy = isHealthyRadioSnapshot(snapshot || {});
            const sc = contextBundle?.signalingContext || {};
            const allEvents = []
                .concat(Array.isArray(sc.first10EventsAfterStart) ? sc.first10EventsAfterStart : [])
                .concat(Array.isArray(sc.last20EventsBeforeEnd) ? sc.last20EventsBeforeEnd : []);
            const hasDirectTransfer = allEvents.some(e => /DIRECT_TRANSFER/i.test(String(e?.raw || '')));
            const releaseNearEnd = /RELEASE|REJECT|FAIL/i.test(String(sc?.closestReleaseRejectCause?.raw || ''));
            const hasMobilityNearEnd = /SHO|HO|HANDOVER/i.test(String(sc?.closestRrcOrHoBeforeEnd?.raw || ''));
            const hasCongestionHints = allEvents.some(e => /(NO[_\s-]?RESOURCE|ADMISSION|CONGEST|POWER LIMIT|CODE LIMIT|CE FULL|CHANNEL ALLOCATION FAILURE|NO RADIO RESOURCE)/i.test(String(e?.raw || '')));
            const noConnection = !Number.isFinite(session?.connectedTs);
            const dlSignature = (snapshot?.blerEvidence === true || (Number.isFinite(snapshot?.blerMax) && snapshot.blerMax >= 95)) &&
                Number.isFinite(snapshot?.blerMax) && snapshot.blerMax >= 80 &&
                Number.isFinite(snapshot?.txP90) && snapshot.txP90 <= 18 &&
                Number.isFinite(snapshot?.rscpMedian) && snapshot.rscpMedian >= -90;
            const terminalMarker = Number.isFinite(session?.endTsCaf)
                ? 'CAF'
                : (Number.isFinite(session?.endTsCad) ? 'CAD' : (Number.isFinite(session?.endTsCare) ? 'CARE' : 'UNKNOWN'));
            const cafReasonLabel = decodeCafReasonLabel(session?.cafReason);
            const cadCauseLabel = decodeCadCauseLabel(session?.cadCause);

            let interpretation = 'Setup failure likely originated from mixed radio/signaling factors.';
            const cat = String(classification?.category || 'SETUP_FAIL_UNKNOWN');
            if (cat === 'SETUP_FAIL_SIGNALING_OR_CORE' || (radioHealthy && releaseNearEnd && noConnection)) interpretation = 'Strong and stable radio conditions with immediate release indicate signaling/core-layer rejection.';
            else if (cat === 'SETUP_FAIL_UL_COVERAGE') interpretation = 'Setup failed due to uplink margin limitation under weak/unstable radio conditions.';
            else if (cat === 'SETUP_FAIL_DL_INTERFERENCE') interpretation = 'Setup failed under downlink quality/interference degradation.';
            else if (cat === 'SETUP_FAIL_MOBILITY') interpretation = 'Setup failed around mobility transition instability.';
            else if (cat === 'SETUP_FAIL_CONGESTION') interpretation = 'Setup failed with admission/resource congestion indicators.';
            else if (cat === 'SETUP_TIMEOUT') interpretation = 'Setup timer expired before connection could complete.';

            let breakdown = {
                radioHealthy: radioHealthy ? 40 : 0,
                immediateRelease: releaseNearEnd ? 25 : 0,
                noConnection: noConnection ? 15 : 0,
                noMobility: !hasMobilityNearEnd ? 10 : 0,
                noCongestion: !hasCongestionHints ? 10 : 0
            };
            let score = breakdown.radioHealthy + breakdown.immediateRelease + breakdown.noConnection + breakdown.noMobility + breakdown.noCongestion;
            if (cat === 'SETUP_FAIL_DL_INTERFERENCE') {
                breakdown = {
                    blerVeryHigh: ((snapshot?.blerEvidence === true || (Number.isFinite(snapshot?.blerMax) && snapshot.blerMax >= 95)) && Number.isFinite(snapshot?.blerMax) && snapshot.blerMax >= 80) ? 50 : 0,
                    ulNotLimited: (Number.isFinite(snapshot?.txP90) && snapshot.txP90 <= 18) ? 20 : 0,
                    coverageAcceptable: (Number.isFinite(snapshot?.rscpMedian) && snapshot.rscpMedian >= -90) ? 15 : 0,
                    ecnoDegraded: (Number.isFinite(snapshot?.ecnoMedian) && snapshot.ecnoMedian <= -12) ? 15 : 0
                };
                score = Object.values(breakdown).reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
            }

            return {
                radioAssessment: {
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
                    },
                    evaluation: buildRadioEvaluation(snapshot, cat, classification?.domain, session)
                },
                signalingAssessment: {
                    rrcEstablished: hasDirectTransfer,
                    directTransferObserved: hasDirectTransfer,
                    explicitL3ReleaseRejectNearEnd: releaseNearEnd,
                    immediateReleaseNearEnd: releaseNearEnd,
                    connectedEver: !noConnection,
                    cadStatus: session?.cadStatus ?? null,
                    cadCause: session?.cadCause ?? null,
                    cadCauseLabel,
                    cafReason: session?.cafReason ?? null,
                    cafReasonLabel,
                    terminalMarker,
                    terminalMarkerLabel: terminalMarker === 'CAF'
                        ? `CAF reason ${session?.cafReason ?? 'N/A'} (${cafReasonLabel})`
                        : terminalMarker,
                    evaluation: (session?.cadCause === 102)
                        ? (releaseNearEnd
                            ? 'Setup timer expired before call connection (CAD cause 102: timer expiry); explicit release/reject marker observed near setup end.'
                            : 'Setup timer expired before call connection (CAD cause 102: timer expiry); no explicit release/reject marker was decoded near setup end.')
                        : ((hasDirectTransfer && !releaseNearEnd && terminalMarker === 'CAF')
                        ? `Signaling progressed into NAS/CC exchange (e.g., SETUP + IDENTITY), but no explicit L3 RELEASE/REJECT cause was decoded near the end; the termination marker is CAF(reason=${session?.cafReason ?? 'N/A'} - ${cafReasonLabel}). Attribution therefore relies primarily on radio DL evidence for this case.`
                        : (releaseNearEnd
                            ? 'An explicit L3 release/reject was observed near the end, which strengthens core/signaling attribution (especially under healthy radio conditions).'
                            : 'No explicit L3 release/reject cause was decoded near setup end.'))
                },
                interpretation: {
                    summary: interpretation
                },
                classification: {
                    resultType: classification?.resultType || 'CALL_SETUP_FAILURE',
                    category: classification?.category || 'SETUP_FAIL_UNKNOWN',
                    domain: classification?.domain || 'Undetermined',
                    confidence: Number.isFinite(classification?.confidence) ? classification.confidence : 0.5,
                    reason: classification?.reason || null
                },
                confidence: {
                    score,
                    normalized: Math.min(0.95, score / 100),
                    breakdown
                },
                recommendedActions: Array.isArray(classification?.recommendations) ? classification.recommendations : []
            };
        };

        const classify = (session, snapshot) => {
            const fmtNum = (v, unit) => Number.isFinite(v) ? `${v.toFixed(1)}${unit ? ` ${unit}` : ''}` : null;
            const decodeCadCause = (cause) => {
                const map = {
                    16: 'Normal call clearing',
                    17: 'User busy',
                    18: 'No user responding',
                    19: 'No answer from user',
                    21: 'Call rejected',
                    27: 'Destination out of order',
                    34: 'No circuit/channel available',
                    41: 'Temporary failure',
                    42: 'Switching equipment congestion',
                    47: 'Resource unavailable',
                    102: 'Setup timeout (timer expiry)'
                };
                return map[cause] || 'Unknown cause';
            };
            const buildCoreReason = (s, snap, causeLabel) => {
                const rscpTxt = Number.isFinite(snap?.rscpMedian) ? snap.rscpMedian.toFixed(1) : 'n/a';
                const ecnoTxt = Number.isFinite(snap?.ecnoMedian) ? snap.ecnoMedian.toFixed(1) : 'n/a';
                const txTxt = Number.isFinite(snap?.txP90) ? snap.txP90.toFixed(1) : 'n/a';
                const blerTxt = Number.isFinite(snap?.blerMax) ? snap.blerMax.toFixed(1) : 'n/a';
                const radioSummary = `RSCP ${rscpTxt} dBm, EcNo ${ecnoTxt} dB, UE Tx p90 ${txTxt} dBm, BLER max ${blerTxt}%.`;
                const causeText = s?.cadCause === 18
                    ? 'Cause 18 (No user responding) indicates call-control timeout or no response from downstream network element.'
                    : `CAD cause ${s?.cadCause ?? 'n/a'} (${causeLabel}).`;
                return [
                    `Radio conditions were stable during setup attempt (${radioSummary})`,
                    'An immediate signaling release was observed at failure time.',
                    causeText,
                    'This strongly indicates a core or higher-layer signaling termination rather than a radio-originated setup failure.'
                ].join(' ');
            };
            const sortRec = (arr) => {
                const rank = { P0: 0, P1: 1, P2: 2 };
                return (arr || []).slice().sort((a, b) => (rank[a?.priority] ?? 9) - (rank[b?.priority] ?? 9));
            };
            const ACTION_ID_ALIASES = {
                SOLVE_INTERFERENCE_UNDER_STRONG_SIGNAL: 'SOLVE_INTERFERENCE_STRONG_SIGNAL'
            };
            const canonicalActionId = (actionId) => {
                const id = String(actionId || '').trim().toUpperCase();
                return ACTION_ID_ALIASES[id] || id;
            };
            const metricRangeFromSeries = (series, fallbackMin, fallbackMax) => {
                const vals = Array.isArray(series) ? series.map(v => Number(v?.value)).filter(Number.isFinite) : [];
                if (vals.length) return { min: Math.min(...vals), max: Math.max(...vals) };
                return {
                    min: Number.isFinite(fallbackMin) ? fallbackMin : null,
                    max: Number.isFinite(fallbackMax) ? fallbackMax : null
                };
            };
            const buildInterferenceStrongSignalDetails = (s, snap) => {
                const rscpRange = metricRangeFromSeries(snap?.seriesRscp, snap?.rscpMin, snap?.rscpLast);
                const ecnoRange = metricRangeFromSeries(snap?.seriesEcno, snap?.ecnoMin, snap?.ecnoLast);
                const pp = snap?.pilotPollution || {};
                const strong = pp?.strongRscpBadEcno || {};
                const validBest = Number.isFinite(strong?.denomBestValid) ? strong.denomBestValid : 0;
                const totalMimo = Number.isFinite(strong?.denomTotalMimo) ? strong.denomTotalMimo : 0;
                const strongCount = Number.isFinite(strong?.strongCount) ? strong.strongCount : 0;
                const strongBadCount = Number.isFinite(strong?.strongBadCount) ? strong.strongBadCount : 0;
                const strongSharePct = validBest > 0 ? Math.round((strongCount / validBest) * 100) : 0;
                const strongBadPct = validBest > 0 ? Math.round((strongBadCount / validBest) * 100) : 0;
                const fmt = (v, d = 1) => Number.isFinite(v) ? Number(v).toFixed(d) : 'n/a';
                const k = Number.isFinite(pp?.deltaStats?.samplesWith2Pilots) ? pp.deltaStats.samplesWith2Pilots : 0;
                const y = Number.isFinite(pp?.deltaStats?.totalMimoSamples) ? pp.deltaStats.totalMimoSamples : totalMimo;
                const deltaLine = `ΔRSCP computed on ${k}/${y} timestamps meeting the ≥2-pilot criterion.`;
                const deltaUnavailable = k === 0 ? `ΔRSCP not computable (0/${y} ≥2-pilot timestamps). Dominance inference disabled.` : null;
                return [
                    'DL interference-under-strong-signal verification:',
                    `- RSCP (min/median/max): ${fmt(rscpRange.min)} / ${fmt(snap?.rscpMedian)} / ${fmt(rscpRange.max)} dBm`,
                    `- EcNo (min/median/max): ${fmt(ecnoRange.min)} / ${fmt(snap?.ecnoMedian)} / ${fmt(ecnoRange.max)} dB`,
                    `- BLER max: ${fmt(snap?.blerMax)} %`,
                    `- UE Tx p90: ${fmt(snap?.txP90)} dBm`,
                    `- Strong RSCP share (> -85 dBm): ${strongSharePct}% (${strongCount}/${validBest})`,
                    `- Strong RSCP+bad EcNo ratio: ${strongBadPct}% (${strongBadCount}/${strongCount})`,
                    `- ${deltaLine}`,
                    `- Strong RSCP+bad EcNo computed on ${strongBadCount}/${validBest || totalMimo} best-server samples.`,
                    ...(deltaUnavailable ? [`- ${deltaUnavailable}`] : []),
                    `- Best-server denominator: ${validBest}/${totalMimo}`
                ].join('\n');
            };
            const buildRecommendations = (resultType, category, s, snap) => {
                const map = {
                    DROP_INTERFERENCE: [
                        { priority: 'P0', actionId: 'RESOLVE_PILOT_POLLUTION', action: 'Resolve Pilot Pollution', rationale: 'Pilot Pollution risk is high; apply overlap/dominance remediation to stabilize serving behavior.', ownerHint: 'RAN Optimization' },
                        { priority: 'P0', actionId: 'VALIDATE_PILOT_DOMINANCE_DROP_CLUSTER', action: 'Validate pilot dominance in drop cluster (ΔRSCP(best-2nd)<3 dB, active set size >=3, CPICH review).', rationale: 'Weak serving dominance and large active set indicate pilot pollution risk in interference drops.', ownerHint: 'RAN Optimization' },
                        { priority: 'P0', actionId: 'AUDIT_PILOT_POLLUTION_SHO', action: 'Audit pilot pollution/dominance and SHO settings in drop area.', rationale: 'Good RSCP with poor quality/BLER indicates interference.', ownerHint: 'Optimization' },
                        { priority: 'P0', actionId: 'CHECK_INTERFERENCE_SOURCES', action: 'Check localized interference sources by time/location correlation.', rationale: 'Interference is often recurrent and localized.', ownerHint: 'Field' },
                        { priority: 'P1', actionId: 'VERIFY_DL_QUALITY_KPIS', action: 'Review EcNo/BLER/SHO KPIs on serving and strong neighbors.', rationale: 'Confirms persistence and impacted cells.', ownerHint: 'RAN' }
                    ],
                    DROP_COVERAGE_UL: [
                        { priority: 'P0', actionId: 'INVEST_UL_TX_SAT_ZONES', action: 'Investigate uplink coverage limits and UE Tx saturation zones.', rationale: 'High UE Tx near max indicates UL-limited coverage; cluster these zones to target RAN fixes.', ownerHint: 'RAN' },
                        { priority: 'P1', actionId: 'OPT_NEIGHBOR_LAYER_WEAK_COVERAGE', action: 'Tune neighbors/layer fallback for edge robustness.', rationale: 'Improves retention at coverage edge.', ownerHint: 'Optimization' }
                    ],
                    DROP_COVERAGE_DL: [
                        { priority: 'P0', actionId: 'CHECK_DL_COVERAGE_AZIMUTH_TILT', action: 'Investigate DL coverage weakness (tilt/azimuth/overshoot).', rationale: 'Very weak DL quality drives drops.', ownerHint: 'RAN' },
                        { priority: 'P1', actionId: 'TUNE_NEIGHBOR_SHO_PARAMETERS', action: 'Tune neighbor and SHO parameters for smoother transition.', rationale: 'Reduces edge release risk.', ownerHint: 'Optimization' }
                    ],
                    SETUP_TIMEOUT: [
                        { priority: 'P0', actionId: 'TRACE_SETUP_TIMEOUT_PATH', action: 'Trace CAD cause 102 timeout path across RNC/core signaling.', rationale: 'Timer expiry implies setup signaling did not complete.', ownerHint: 'Core' },
                        { priority: 'P1', actionId: 'CHECK_SIGNALING_LATENCY_RETX', action: 'Check signaling latency/retransmission spikes at failure times.', rationale: 'Delay spikes are common timeout drivers.', ownerHint: 'Transport' }
                    ],
                    SETUP_FAIL_UL_COVERAGE: [
                        { priority: 'P0', actionId: 'INVEST_UL_TX_SAT_ZONES', action: 'Investigate uplink coverage limits and UE Tx saturation zones.', rationale: 'High UE Tx near max indicates UL-limited coverage; cluster these zones to target RAN fixes.', ownerHint: 'RAN' },
                        { priority: 'P1', actionId: 'OPT_NEIGHBOR_LAYER_WEAK_COVERAGE', action: 'Optimize neighbor/layer options in weak-coverage routes.', rationale: 'Raises setup success at edge.', ownerHint: 'Optimization' }
                    ],
                    SETUP_FAIL_DL_INTERFERENCE: [
                        { priority: 'P0', actionId: 'SOLVE_INTERFERENCE_STRONG_SIGNAL', action: 'Solve interference-under-strong-signal.', rationale: 'BLER high under acceptable RSCP with low UL Tx indicates downlink interference/noise-rise decode impairment.', ownerHint: 'RAN Optimization' },
                        { priority: 'P1', actionId: 'COLLECT_DOMINANCE_CONTEXT', action: 'Collect additional dominance context (CELLMEAS neighbors + >=2 pilot availability).', rationale: 'When overlap is not measurable, multi-pilot evidence is required before dominance remediation.', ownerHint: 'Optimization' },
                        { priority: 'P1', actionId: 'VERIFY_DL_QUALITY_KPIS', action: 'Review EcNo/BLER distributions on affected serving/overlap cells.', rationale: 'Validates persistent interference footprint.', ownerHint: 'RAN' },
                        { priority: 'P1', actionId: 'MAP_CAF_REASON_CODES', action: 'Decode/map CAF reason codes for setup failures.', rationale: 'CAF is the terminal marker; mapping reason values improves attribution consistency.', ownerHint: 'Optimization' }
                    ],
                    SETUP_FAIL_MOBILITY: [
                        { priority: 'P0', actionId: 'AUDIT_SETUP_MOBILITY', action: 'Audit mobility events and neighbor readiness around setup failure.', rationale: 'Setup failed shortly after HO/SHO activity.', ownerHint: 'Optimization' },
                        { priority: 'P1', actionId: 'TUNE_SETUP_HO_THRESHOLDS', action: 'Tune HO thresholds/hysteresis/TTT to reduce late mobility transitions during setup.', rationale: 'Late mobility transitions can destabilize setup completion.', ownerHint: 'Optimization' }
                    ],
                    SETUP_FAIL_CONGESTION: [
                        { priority: 'P0', actionId: 'CHECK_SETUP_RESOURCE_LIMITS', action: 'Check code/power/admission resource limits at setup failure time.', rationale: 'Resource shortage can block setup completion.', ownerHint: 'RAN' },
                        { priority: 'P1', actionId: 'APPLY_SETUP_LOAD_BALANCING', action: 'Apply load balancing/capacity optimization on impacted cells.', rationale: 'Reduces setup blocking during busy periods.', ownerHint: 'Optimization' }
                    ],
                    SETUP_FAIL_SIGNALING_OR_CORE: [
                        { priority: 'P0', actionId: 'TRACE_SETUP_CORE_SIGNALING', action: 'Trace setup signaling path across RNC/core for reject/release causes.', rationale: 'Radio appears healthy; signaling/core path is most likely.', ownerHint: 'Core' },
                        { priority: 'P1', actionId: 'CHECK_CONTROL_PLANE_LATENCY', action: 'Check control-plane latency/retransmissions around setup end.', rationale: 'Timing and retransmission issues commonly affect setup completion.', ownerHint: 'Transport' }
                    ]
                };
                const fallback = resultType === 'DROP_CALL'
                    ? [
                        { priority: 'P0', actionId: 'CAPTURE_EVIDENCE_BUNDLE', action: 'Collect full evidence bundle (events + 10s radio series) for clustered drops.', rationale: 'Unknown drops need richer context.', ownerHint: 'Optimization' },
                        { priority: 'P1', actionId: 'EXPAND_PARSER_RELEASE_CAUSES', action: 'Expand parser coverage for missing release causes.', rationale: 'Improves classification determinism.', ownerHint: 'RAN' }
                    ]
                    : [
                        { priority: 'P0', actionId: 'CAPTURE_EVIDENCE_BUNDLE', action: 'Collect expanded signaling/radio context for setup failures.', rationale: 'Unknown setup failures need richer context.', ownerHint: 'Optimization' },
                        { priority: 'P1', actionId: 'EXPAND_PARSER_RELEASE_CAUSES', action: 'Add missing reject/release parser hooks if available.', rationale: 'Improves attribution quality.', ownerHint: 'RAN' }
                    ];
                const recs = (map[category] || fallback).slice(0, 4).map((rec) => {
                    const next = { ...rec };
                    const canon = canonicalActionId(next.actionId || '');
                    if (canon) next.actionId = canon;
                    if (canon === 'SOLVE_INTERFERENCE_STRONG_SIGNAL') {
                        next.title = 'Solve interference-under-strong-signal';
                        next.detailsText = buildInterferenceStrongSignalDetails(s, snap);
                    }
                    return next;
                });
                return sortRec(recs);
            };
            const withNarrative = (cls) => {
                const why = Array.isArray(cls?.evidence) ? cls.evidence.filter(Boolean).map(String) : [];
                const sig = [];
                const rscpTxt = fmtNum(snapshot?.rscpMedian, 'dBm');
                const ecnoTxt = fmtNum(snapshot?.ecnoMedian, 'dB');
                const blerTxt = snapshot?.blerEvidence ? fmtNum(snapshot?.blerMax, '%') : null;
                const txTxt = fmtNum(snapshot?.txP90, 'dBm');
                if (rscpTxt) sig.push(`RSCP median: ${rscpTxt}`);
                if (ecnoTxt) sig.push(`Ec/No median: ${ecnoTxt}`);
                if (blerTxt) sig.push(`BLER max: ${blerTxt}`);
                if (!snapshot?.blerEvidence) sig.push(`BLER: not informative (insufficient RLC BLER samples during setup${Number.isFinite(snapshot?.rlcBlerSamplesCount) ? `: ${snapshot.rlcBlerSamplesCount}` : ''})`);
                if (txTxt) sig.push(`UE Tx p90: ${txTxt}`);
                const pp = snapshot?.pilotPollution || null;
                const ppScore = Number.isFinite(pp?.score) ? pp.score : (Number.isFinite(pp?.pollutionScore) ? pp.pollutionScore : null);
                const ppLevel = pp?.riskLevel || pp?.pollutionLevel || null;
                if (pp && Number.isFinite(ppScore)) {
                    const d = pp.details || {};
                    const deltaStats = pp.deltaStats || {};
                    const deltaMedian = Number.isFinite(deltaStats.medianDb) ? deltaStats.medianDb : d.deltaMedian;
                    const deltaRatio = Number.isFinite(deltaStats.lt3dbRatio) ? deltaStats.lt3dbRatio : d.deltaRatio;
                    sig.push(`Pilot pollution risk: ${ppLevel || 'Unknown'} (${ppScore}/100)`);
                    sig.push(`ΔRSCP median=${Number.isFinite(deltaMedian) ? deltaMedian.toFixed(2) : 'n/a'} dB, ΔRSCP<3dB ratio=${Number.isFinite(deltaRatio) ? (deltaRatio * 100).toFixed(0) : 'n/a'}%`);
                }
                sig.forEach(s => { if (why.length < 6) why.push(s); });
                let recs = buildRecommendations(cls.resultType, cls.category, session, snapshot);
                const shouldRecommendPollution = (pilotPollution) => {
                    const ds = pilotPollution?.deltaStats;
                    if (!ds || !Number.isFinite(ds.totalMimoSamples) || ds.totalMimoSamples <= 0) return false;
                    const ratio = (Number(ds.samplesWith2Pilots) || 0) / ds.totalMimoSamples;
                    const level = String(pilotPollution?.riskLevel || pilotPollution?.pollutionLevel || '').trim();
                    return (level === 'High' || level === 'Moderate') && ratio >= 0.30;
                };
                const allowResolvePilot = shouldRecommendPollution(pp);
                if (allowResolvePilot) {
                    const exists = recs.some(r => String(r?.actionId || '').toUpperCase() === 'RESOLVE_PILOT_POLLUTION');
                    if (!exists) {
                        recs = sortRec([
                            {
                                priority: 'P0',
                                actionId: 'RESOLVE_PILOT_POLLUTION',
                                action: 'Resolve Pilot Pollution',
                                rationale: 'Pilot Pollution/overlap risk is high; resolve dominance collapse before or alongside category-specific actions.',
                                ownerHint: 'RAN Optimization'
                            },
                            ...recs
                        ]).slice(0, 4);
                    }
                }
                if (!allowResolvePilot) recs = recs.filter(r => String(r?.actionId || '').toUpperCase() !== 'RESOLVE_PILOT_POLLUTION');
                const confPct = Math.round((Number(cls.confidence) || 0) * 100);
                const durationSec = (Number.isFinite(session?.startTs) && Number.isFinite(session?.endTsReal) && session.endTsReal >= session.startTs)
                    ? ((session.endTsReal - session.startTs) / 1000)
                    : null;
                let whatHappened = 'Session analyzed.';
                if (cls.resultType === 'DROP_CALL') whatHappened = 'Call dropped after connection with abnormal end behavior.';
                if (cls.resultType === 'CALL_SETUP_FAILURE') whatHappened = 'Call setup failed before connection was established.';
                if (cls.resultType === 'INCOMPLETE_OR_UNKNOWN_END') whatHappened = 'Call connected but no explicit end marker was found in parsed range.';
                let summary = `${cls.category} (${confPct}%).`;
                if (cls.resultType === 'DROP_CALL') {
                    summary = `A UMTS voice call dropped${Number.isFinite(durationSec) ? ` after ${durationSec.toFixed(1)}s` : ''}. The most likely cause is ${cls.category} (${confPct}%), driven by ${(why.slice(0, 3).join('; ') || 'available abnormal-end indicators')}.`;
                } else if (cls.resultType === 'CALL_SETUP_FAILURE') {
                    const dlSig = cls.category === 'SETUP_FAIL_DL_INTERFERENCE' &&
                        (snapshot?.blerEvidence === true || (Number.isFinite(snapshot?.blerMax) && snapshot.blerMax >= 95)) &&
                        Number.isFinite(snapshot?.blerMax) && snapshot.blerMax >= 80 &&
                        Number.isFinite(snapshot?.txP90) && snapshot.txP90 <= 18 &&
                        Number.isFinite(snapshot?.rscpMedian) && snapshot.rscpMedian >= -90;
                    const hasL3Release = Array.isArray(session?.eventTimeline) && session.eventTimeline.some(e => /(RELEASE|REJECT)/i.test(`${e?.event || ''} ${e?.details || ''}`));
                    const hasDirectTransfer = Array.isArray(session?.eventTimeline) && session.eventTimeline.some(e => /DIRECT_TRANSFER/i.test(`${e?.event || ''} ${e?.details || ''}`));
                    const cafReason = Number.isFinite(session?.cafReason) ? session.cafReason : null;
                    const cafReasonLabel = (() => {
                        const map = {
                            0: 'Unknown/Not provided',
                            1: 'User action / call aborted (tool-specific)',
                            2: 'Setup failed / call attempt aborted (network or radio procedure failed)',
                            3: 'Call rejected (tool-specific)'
                        };
                        return map[cafReason] || 'Unknown/tool-specific reason';
                    })();
                    summary = `A UMTS call setup failed before connection${Number.isFinite(durationSec) ? ` (~${durationSec.toFixed(1)}s after start)` : ''}.`;
                    if (dlSig) {
                        summary += ` Coverage was acceptable (RSCP median ${Number(snapshot.rscpMedian).toFixed(1)} dBm) and UL margin was strong (UE Tx p90 ${Number(snapshot.txP90).toFixed(1)} dBm), ruling out UL limitation; downlink quality was degraded (EcNo median ${Number.isFinite(snapshot?.ecnoMedian) ? Number(snapshot.ecnoMedian).toFixed(1) : 'n/a'} dB) and DL decoding collapsed (BLER max ${Number.isFinite(snapshot?.blerMax) ? Number(snapshot.blerMax).toFixed(1) : 'n/a'}%), matching a DL decode-impairment signature.`;
                    } else {
                        summary += ` Radio metrics were RSCP ${Number.isFinite(snapshot?.rscpMedian) ? Number(snapshot.rscpMedian).toFixed(1) : 'n/a'} dBm, EcNo ${Number.isFinite(snapshot?.ecnoMedian) ? Number(snapshot.ecnoMedian).toFixed(1) : 'n/a'} dB, UE Tx p90 ${Number.isFinite(snapshot?.txP90) ? Number(snapshot.txP90).toFixed(1) : 'n/a'} dBm, ${snapshot?.blerEvidence ? `BLER max ${Number.isFinite(snapshot?.blerMax) ? Number(snapshot.blerMax).toFixed(1) : 'n/a'}%` : 'BLER n/a (insufficient setup-phase evidence)'}.`;
                    }
                    if (hasDirectTransfer && !hasL3Release && cafReason !== null) {
                        summary += ` Signaling progressed into NAS/CC exchange, but no explicit L3 RELEASE/REJECT was decoded; termination marker was CAF(reason=${cafReason} - ${cafReasonLabel}).`;
                    } else if (hasL3Release) {
                        summary += ' An explicit L3 release/reject was observed near end.';
                    }
                }
                if (Number.isFinite(snapshot?.lastPsc) || Number.isFinite(snapshot?.lastUarfcn)) {
                    summary += ` Serving context near end: PSC ${Number.isFinite(snapshot?.lastPsc) ? snapshot.lastPsc : 'N/A'} / UARFCN ${Number.isFinite(snapshot?.lastUarfcn) ? snapshot.lastUarfcn : 'N/A'}.`;
                }
                if (Number.isFinite(session?.cafReason)) {
                    const cafMap = {
                        0: 'Unknown/Not provided',
                        1: 'User action / call aborted (tool-specific)',
                        2: 'Setup failed / call attempt aborted (network or radio procedure failed)',
                        3: 'Call rejected (tool-specific)'
                    };
                    summary += ` CAF reason ${session.cafReason} (${cafMap[session.cafReason] || 'Unknown/tool-specific reason'}).`;
                }
                const metricLine = [rscpTxt ? `RSCP ${rscpTxt}` : null, ecnoTxt ? `Ec/No ${ecnoTxt}` : null, blerTxt ? `BLER max ${blerTxt}` : null, txTxt ? `UE Tx p90 ${txTxt}` : null].filter(Boolean);
                if (!snapshot?.blerEvidence) metricLine.push('BLER n/a (insufficient setup-phase evidence)');
                if (metricLine.length) summary += ` Final-window radio metrics: ${metricLine.join(', ')}.`;
                const deltaStats = pp?.deltaStats || null;
                if (Number.isFinite(deltaStats?.totalMimoSamples) && deltaStats.totalMimoSamples > 0 && (Number(deltaStats?.samplesWith2Pilots) || 0) === 0) {
                    summary += ` Dominance inference disabled (${Number(deltaStats?.samplesWith2Pilots) || 0}/${deltaStats.totalMimoSamples} >=2-pilot timestamps).`;
                } else if (Number.isFinite(deltaStats?.totalMimoSamples) && Number(deltaStats?.samplesWith2Pilots) > 0) {
                    summary += ` ΔRSCP dominance was computed on ${Number(deltaStats.samplesWith2Pilots)}/${deltaStats.totalMimoSamples} timestamps meeting the >=2-pilot criterion.`;
                }
                const cleanAction = (txt) => String(txt || '').trim().replace(/[.]+$/g, '');
                const p0 = recs.filter(r => r.priority === 'P0').map(r => cleanAction(r.action)).filter(Boolean).slice(0, 2);
                if (p0.length) summary += ` Recommended next actions: ${p0.join('; ')}.`;
                return {
                    ...cls,
                    explanation: {
                        whatHappened,
                        whyWeThinkSo: why,
                        keySignals: {
                            ...(Number.isFinite(snapshot?.rscpMedian) ? { rscp: snapshot.rscpMedian } : {}),
                            ...(Number.isFinite(snapshot?.ecnoMedian) ? { ecno: snapshot.ecnoMedian } : {}),
                            ...(Number.isFinite(snapshot?.blerMax) ? { blerMax: snapshot.blerMax } : {}),
                            ...(Number.isFinite(snapshot?.txP90) ? { txP90: snapshot.txP90 } : {}),
                            ...(Number.isFinite(snapshot?.lastPsc) ? { lastPsc: String(snapshot.lastPsc) } : {}),
                            ...(Number.isFinite(snapshot?.lastUarfcn) ? { lastUarfcn: String(snapshot.lastUarfcn) } : {}),
                            ...(pp && Number.isFinite(ppScore) ? { pollutionScore: ppScore, pollutionLevel: ppLevel || 'Unknown' } : {})
                        }
                    },
                    pilotPollution: pp || null,
                    recommendations: recs,
                    oneParagraphSummary: summary
                };
            };
            const num = (v) => Number.isFinite(v) ? v : null;
            const cause = session.cadCause;
            const tx = num(snapshot?.txP90);
            const rscp = num(snapshot?.rscpMedian);
            const ecno = num(snapshot?.ecnoMedian);
            const bler = num(snapshot?.blerMax);
            const hasTimelineMatch = (regex) => Array.isArray(session?.eventTimeline) && session.eventTimeline.some(e => regex.test(`${e?.event || ''} ${e?.details || ''}`));
            const findLastHoDeltaSec = () => {
                const endTs = Number.isFinite(session?.endTsReal) ? session.endTsReal : null;
                if (!endTs || !Array.isArray(session?.eventTimeline)) return null;
                const hoTs = session.eventTimeline
                    .map(e => Number.isFinite(e?.ts) ? e.ts : Date.parse(e?.time || ''))
                    .filter(ts => Number.isFinite(ts) && ts <= endTs)
                    .filter((ts, idx) => {
                        const raw = `${session.eventTimeline[idx]?.event || ''} ${session.eventTimeline[idx]?.details || ''}`.toUpperCase();
                        return raw.includes('HO') || raw.includes('HANDOVER') || raw.includes('SHO');
                    })
                    .sort((a, b) => a - b);
                if (!hoTs.length) return null;
                return (endTs - hoTs[hoTs.length - 1]) / 1000;
            };
            const radioHealthy = (
                rscp !== null && rscp > -85 &&
                ecno !== null && ecno > -10 &&
                tx !== null && tx < 20 &&
                snapshot?.blerEvidence === true &&
                bler !== null && bler < 5
            );
            const mk = (resultType, category, domain, reason, confidence, evidence) => ({
                resultType,
                category,
                domain,
                reason,
                confidence,
                evidence
            });

            if (session.resultType === 'SUCCESS') {
                return withNarrative(mk('SUCCESS', 'SUCCESS', 'Normal', 'SUCCESS: normal clearing (CAD status=1, cause=16).', 1, ['CAD status=1 and cause=16']));
            }
            if (session.resultType === 'CALL_SETUP_FAILURE') {
                const hasSignalingReleaseReject = hasTimelineMatch(/(REJECT|RELEASE|CAUSE|FAIL)/i);
                // 1) UL coverage
                if (tx !== null && tx >= 21 && ((rscp !== null && rscp <= -95) || (ecno !== null && ecno <= -16) || (bler !== null && bler >= 20))) {
                    return withNarrative(mk('CALL_SETUP_FAILURE', 'SETUP_FAIL_UL_COVERAGE', 'Radio/Coverage', 'SETUP_FAIL_UL_COVERAGE: high UE Tx with weak/unstable uplink conditions.', 0.85, [`txP90=${tx}`, `rscpMedian=${rscp}`, `ecnoMedian=${ecno}`, `blerMax=${bler}`]));
                }
                // 2) DL interference
                if ((snapshot?.blerEvidence === true || (bler !== null && bler >= 95)) && bler !== null && bler >= 80 && (tx === null || tx <= 18) && rscp !== null && rscp >= -90) {
                    const ev = [
                        `blerMax=${bler} >= 80 (DL decode failure signature)`,
                        `txP90=${tx} <= 18 (UL margin OK; not UL-limited)`,
                        `rscpMedian=${rscp} >= -90 (coverage OK)`
                    ];
                    if (ecno !== null) ev.push(`ecnoMedian=${ecno} dB (${ecno <= -12 ? 'quality degraded' : 'quality OK'})`);
                    if (snapshot?.blerEvidence !== true) ev.push('BLER evidence is limited (<3 RLCBLER rows), but BLER collapse is extreme and retained as supporting evidence.');
                    const ds = snapshot?.pilotPollution?.deltaStats;
                    if (ds && Number.isFinite(ds.totalMimoSamples) && ds.totalMimoSamples > 0) {
                        ev.push(`ΔRSCP computed on ${(ds.samplesWith2Pilots || 0)}/${ds.totalMimoSamples} timestamps meeting >=2-pilot criterion.`);
                        if ((ds.samplesWith2Pilots || 0) === 0) ev.push('Dominance/overlap inference disabled (no >=2 pilots).');
                    }
                    const reason =
                        'DL decode impairment during setup: BLER is extremely high while UL power is low and RSCP is acceptable. ' +
                        'This points to downlink quality collapse (interference/noise rise/control-channel decode issues), not UL limitation.';
                    return withNarrative(mk('CALL_SETUP_FAILURE', 'SETUP_FAIL_DL_INTERFERENCE', 'Radio/Interference', reason, 0.8, ev));
                }
                // 3) Mobility
                const hoDelta = findLastHoDeltaSec();
                if (hoDelta !== null && hoDelta <= 5) {
                    return withNarrative(mk('CALL_SETUP_FAILURE', 'SETUP_FAIL_MOBILITY', 'Radio/Mobility', 'SETUP_FAIL_MOBILITY: setup failure occurred shortly after mobility activity.', 0.8, [`Last HO/SHO event was ${hoDelta.toFixed(1)}s before setup end`]));
                }
                // 4) Congestion
                if (hasTimelineMatch(/(NO[_\s-]?RESOURCE|ADMISSION|CONGEST|POWER LIMIT|CODE LIMIT|CE FULL|CHANNEL ALLOCATION FAILURE|NO RADIO RESOURCE)/i)) {
                    return withNarrative(mk('CALL_SETUP_FAILURE', 'SETUP_FAIL_CONGESTION', 'Radio/Congestion', 'SETUP_FAIL_CONGESTION: resource/admission congestion indicators around setup failure.', 0.75, ['Resource/admission congestion markers found in signaling timeline']));
                }
                // 5) Core/signaling (with safety gate)
                if (cause === 102) return withNarrative(mk('CALL_SETUP_FAILURE', 'SETUP_TIMEOUT', 'Signaling/Timeout', 'SETUP_TIMEOUT: CAD cause=102 (Setup timeout - timer expiry).', 0.85, ['CAD cause=102 (Setup timeout - timer expiry)', hasSignalingReleaseReject ? 'Explicit release/reject marker observed near setup end' : 'No explicit release/reject marker decoded near setup end']));
                if (!(tx !== null && tx >= 21) && !(rscp !== null && rscp <= -90) && !(ecno !== null && ecno <= -14)) {
                    const hasCongestionHints = hasTimelineMatch(/(NO[_\s-]?RESOURCE|ADMISSION|CONGEST|POWER LIMIT|CODE LIMIT|CE FULL|CHANNEL ALLOCATION FAILURE|NO RADIO RESOURCE)/i);
                    const hasCoreIndicators = hasSignalingReleaseReject || session.cafReason !== null || session.cadStatus !== null || cause !== null;
                    const hoDelta = findLastHoDeltaSec();
                    const coreScore = (
                        (radioHealthy ? 40 : 0) +
                        (hasSignalingReleaseReject ? 25 : 0) +
                        (!Number.isFinite(session?.connectedTs) ? 15 : 0) +
                        (!(Number.isFinite(hoDelta) && hoDelta <= 5) ? 10 : 0) +
                        (!hasCongestionHints ? 10 : 0)
                    );
                    if (radioHealthy && hasCoreIndicators && coreScore >= 70) {
                        const causeLabel = decodeCadCause(cause);
                        const reason = buildCoreReason(session, snapshot || {}, causeLabel);
                        return withNarrative(mk(
                            'CALL_SETUP_FAILURE',
                            'SETUP_FAIL_SIGNALING_OR_CORE',
                            'Core/Signaling',
                            reason,
                            Math.min(0.95, coreScore / 100),
                            [
                                'Radio appears healthy while signaling/release indicators exist near setup failure',
                                `Core/signaling score=${coreScore}`,
                                `CAD cause=${cause ?? 'n/a'} (${causeLabel})`
                            ]
                        ));
                    }
                }
                return withNarrative(mk('CALL_SETUP_FAILURE', 'SETUP_FAIL_UNKNOWN', 'Undetermined', 'SETUP_FAIL_UNKNOWN: setup failed without dominant radio signature.', 0.5, ['No rule matched']));
            }
            if (session.resultType === 'DROP_CALL') {
                if (rscp !== null && rscp >= -85 && ((ecno !== null && ecno <= -16) || (bler !== null && bler >= 50)) && (tx === null || tx <= 18)) {
                    return withNarrative(mk('DROP_CALL', 'DROP_INTERFERENCE', 'Radio/Interference', 'DROP_INTERFERENCE: strong RSCP with bad quality/BLER and non-saturated Tx.', 0.7, [`rscpMedian=${rscp}`, `ecnoMedian=${ecno}`, `blerMax=${bler}`, `txP90=${tx}`]));
                }
                if (tx !== null && tx >= 21 && rscp !== null && rscp <= -95) {
                    return withNarrative(mk('DROP_CALL', 'DROP_COVERAGE_UL', 'Radio/Coverage', 'DROP_COVERAGE_UL: high UE Tx and weak RSCP.', 0.7, [`txP90=${tx}`, `rscpMedian=${rscp}`]));
                }
                if (rscp !== null && rscp <= -108 && ecno !== null && ecno <= -14) {
                    return withNarrative(mk('DROP_CALL', 'DROP_COVERAGE_DL', 'Radio/Coverage', 'DROP_COVERAGE_DL: very weak downlink coverage.', 0.7, [`rscpMedian=${rscp}`, `ecnoMedian=${ecno}`]));
                }
                return withNarrative(mk('DROP_CALL', 'DROP_UNKNOWN', 'Undetermined', 'DROP_UNKNOWN: connected call ended abnormally without dominant signature.', 0.5, ['No rule matched']));
            }
            if (session.resultType === 'INCOMPLETE_OR_UNKNOWN_END') {
                return withNarrative(mk('INCOMPLETE_OR_UNKNOWN_END', 'INCOMPLETE_OR_UNKNOWN_END', 'Undetermined', 'Connected call has no explicit end marker (CAD/CAF/CARE) in parsed range.', 0.5, ['Connected without end marker']));
            }
            return withNarrative(mk('UNCLASSIFIED', 'UNCLASSIFIED', 'Undetermined', 'UNCLASSIFIED.', 0.5, ['No rule matched']));
        };

        const sessions = new Map();
        const getSession = (sessionKey, callId, deviceId) => {
            const key = String(sessionKey);
            let s = sessions.get(key);
            if (!s) {
                s = {
                    sessionKey: key,
                    callId: String(callId || ''),
                    deviceId: String(deviceId || ''),
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
                    category: null,
                    confidence: null,
                    reason: null,
                    snapshot: null,
                    classification: null
                };
                sessions.set(key, s);
            }
            if (callId !== undefined && callId !== null && String(callId).trim() !== '') s.callId = String(callId);
            if (deviceId !== undefined && deviceId !== null && String(deviceId).trim() !== '') s.deviceId = String(deviceId);
            return s;
        };

        const lines = String(content || '').split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;
            const parts = parseCsvLine(line);
            const header = String(parts[0] || '').trim().toUpperCase();

            if (header === '#START') {
                setBaseDate(parseStartDate(parts));
                continue;
            }
            if (!parts[1]) continue;
            const ts = buildAbsMs(parts[1]);
            if (!Number.isFinite(ts)) continue;

            if (header === 'MIMOMEAS' || header === 'TXPC' || header === 'RLCBLER') {
                const deviceId = String(parts[3] || '').trim();
                addRadio(header, parts, ts, deviceId);
                addDeviceEvent(deviceId, ts, header, parts);
                continue;
            }
            if (UMTS_TIMELINE_HEADERS.has(header)) {
                const deviceId = String(parts[3] || '').trim();
                if (deviceId) addDeviceEvent(deviceId, ts, header, parts);
                continue;
            }
            if (!CALL_HEADERS.has(header)) continue;

            const callId = String(parts[3] || '').trim();
            if (!callId) continue;
            const callDeviceId = String(parts[4] || '').trim();
            const sessionKey = `${callDeviceId}:${callId}`;
            const s = getSession(sessionKey, callId, callDeviceId);

            if (header === 'CAA') {
                if (!Number.isFinite(s.startTs) || ts < s.startTs) s.startTs = ts;
                const dial = String(parts[7] || '').trim().replace(/^"|"$/g, '');
                if (dial) s.dialedNumber = dial;
                addDeviceEvent(s.deviceId, ts, header, parts);
            } else if (header === 'CAC') {
                const state = parseNumber(parts[6]);
                if (state === 3 && !Number.isFinite(s.connectedTs)) s.connectedTs = ts;
                addDeviceEvent(s.deviceId, ts, header, parts);
            } else if (header === 'CAD') {
                const status = parseNumber(parts[6]);
                const cause = parseNumber(parts[7]);
                s.cadStatus = status === null ? s.cadStatus : status;
                s.cadCause = cause === null ? s.cadCause : cause;
                s.endTsCad = ts;
                addDeviceEvent(s.deviceId, ts, header, parts);
            } else if (header === 'CAF') {
                const reason = parseNumber(parts[6]);
                s.cafReason = reason === null ? s.cafReason : reason;
                s.endTsCaf = ts;
                addDeviceEvent(s.deviceId, ts, header, parts);
            } else if (header === 'CARE') {
                s.endTsCare = ts;
                addDeviceEvent(s.deviceId, ts, header, parts);
            }
        }

        const out = Array.from(sessions.values()).sort((a, b) => {
            const at = Number.isFinite(a.startTs) ? a.startTs : Number.POSITIVE_INFINITY;
            const bt = Number.isFinite(b.startTs) ? b.startTs : Number.POSITIVE_INFINITY;
            if (at !== bt) return at - bt;
            return parseInt(a.callId, 10) - parseInt(b.callId, 10);
        });

        const summary = { totalCaaSessions: out.length, outcomes: { SUCCESS: 0, CALL_SETUP_FAILURE: 0, SETUP_FAILURE: 0, DROP_CALL: 0, INCOMPLETE_OR_UNKNOWN_END: 0, UNCLASSIFIED: 0 } };
        const isSameCallEvent = (event, session) => {
            if (!event || !session) return false;
            const h = String(event.header || '').toUpperCase();
            if (!CALL_HEADERS.has(h)) return true;
            const evParts = parseCsvLine(event.raw || '');
            const evCallId = String(evParts[3] || '').trim();
            const evDeviceId = String(evParts[4] || '').trim();
            return evCallId === String(session.callId || '') && evDeviceId === String(session.deviceId || '');
        };
        out.forEach(s => {
            s.endTsReal = s.endTsCare || s.endTsCaf || s.endTsCad || null;
            if (s.cadStatus === 1 && s.cadCause === 16) s.resultType = 'SUCCESS';
            else if (!Number.isFinite(s.connectedTs) && (Number.isFinite(s.endTsCaf) || s.cadStatus === 2 || s.cadCause === 102)) s.resultType = 'CALL_SETUP_FAILURE';
            else if (Number.isFinite(s.connectedTs) && (Number.isFinite(s.endTsCare) || s.cadStatus === 2 || (Number.isFinite(s.cadCause) && s.cadCause !== 16))) s.resultType = 'DROP_CALL';
            else if (Number.isFinite(s.connectedTs)) s.resultType = 'INCOMPLETE_OR_UNKNOWN_END';
            else s.resultType = 'UNCLASSIFIED';

            if ((s.resultType === 'CALL_SETUP_FAILURE' || s.resultType === 'DROP_CALL') && Number.isFinite(s.endTsReal)) {
                s.snapshot = buildSnapshot(s.endTsReal, s.deviceId || '');
                if (s.snapshot) {
                    s.snapshot.trendBasis = s.resultType === 'CALL_SETUP_FAILURE'
                        ? 'last 10s before setup failure'
                        : 'last 10s before drop/end';
                }
            }
            s.markerTs = s.snapshot?.lastMimoTs ?? s.snapshot?.lastTxTs ?? s.endTsReal ?? null;
            s.callStartTs = Number.isFinite(s.startTs) ? s.startTs : null;
            s.analysisWindowStartTs = Number.isFinite(s.endTsReal)
                ? (s.endTsReal - Math.max(1, windowSeconds) * 1000)
                : null;
            const cls = classify(s, s.snapshot);
            s.classification = cls;
            s.category = cls.category;
            s.confidence = cls.confidence;
            s.reason = cls.reason;
            if (s.resultType === 'CALL_SETUP_FAILURE' && Number.isFinite(s.endTsReal)) {
                s.contextBundle = buildSetupFailureContextBundle(s, 20, 20);
            } else {
                s.contextBundle = null;
            }
            s.setupFailureDeepAnalysis = buildSetupFailureDeepAnalysis(s, s.snapshot, s.contextBundle, s.classification);

            summary.outcomes[s.resultType] = (summary.outcomes[s.resultType] || 0) + 1;
            if (s.resultType === 'CALL_SETUP_FAILURE') summary.outcomes.SETUP_FAILURE += 1;
            s.callStartTsIso = Number.isFinite(s.callStartTs) ? new Date(s.callStartTs).toISOString() : null;
            s.analysisWindowStartTsIso = Number.isFinite(s.analysisWindowStartTs) ? new Date(s.analysisWindowStartTs).toISOString() : null;
            s.markerTsIso = Number.isFinite(s.markerTs) ? new Date(s.markerTs).toISOString() : null;
            s.startTsIso = s.callStartTsIso;
            s.connectedTsIso = Number.isFinite(s.connectedTs) ? new Date(s.connectedTs).toISOString() : null;
            s.endTsRealIso = Number.isFinite(s.endTsReal) ? new Date(s.endTsReal).toISOString() : null;
            const deviceEvents = eventsByDevice.get(String(s.deviceId || '')) || [];
            s.eventTimeline = (Number.isFinite(s.startTs) && Number.isFinite(s.endTsReal))
                ? deviceEvents
                    .filter(e => e.ts >= s.startTs && e.ts <= s.endTsReal)
                    .filter(e => isSameCallEvent(e, s))
                    .sort((a, b) => a.ts - b.ts)
                    .filter((e, idx, arr) => idx === arr.findIndex(x => x.ts === e.ts && x.header === e.header && x.raw === e.raw))
                    .map(e => ({ ts: e.ts, time: Number.isFinite(e.ts) ? new Date(e.ts).toISOString() : null, event: e.header, details: e.raw }))
                : [];
        });

        return {
            summary,
            sessions: out,
            radioSeries: {
                byDevice: Array.from(radioStore.byDevice.entries()).map(([deviceId, dev]) => ({
                    deviceId,
                    mimoCount: dev.mimoRows.length,
                    txpcCount: dev.txpcRows.length,
                    rlcCount: dev.rlcRows.length
                }))
            }
        };
    },

    toUiSessions(analysis) {
        if (!analysis || !Array.isArray(analysis.sessions)) return [];
        const toNum = (v) => (typeof v === 'number' && !Number.isNaN(v)) ? v : null;
        return analysis.sessions.map(s => {
            const snapshot = s.snapshot || null;
            const timeline = snapshot && Array.isArray(snapshot.bestServerSamples)
                ? snapshot.bestServerSamples.map(v => ({
                    time: Number.isFinite(v.ts) ? new Date(v.ts).toISOString() : (s.endTsRealIso || s.endTsReal || null),
                    rscp: toNum(v.rscp),
                    ecno: toNum(v.ecno),
                    bler_dl: toNum(snapshot.blerMax),
                    properties: {
                        'UE Tx Power': toNum(snapshot.txLast ?? snapshot.txP90),
                        'BLER DL': toNum(snapshot.blerMax),
                        'Trend Message': snapshot.trendMessage || ''
                    }
                }))
                : [];

            return {
                sessionId: `UMTS-${s.callId}`,
                kind: 'UMTS_CALL',
                deviceId: s.deviceId || '',
                callId: s.callId,
                callTransactionId: s.callId,
                imsi: null,
                tmsi: null,
                startTime: s.startTsIso || null,
                endTime: s.endTsRealIso || s.startTsIso || null,
                markerTime: s.markerTsIso || s.endTsRealIso || s.startTsIso || null,
                markerTsIso: s.markerTsIso || null,
                durationMs: (Number.isFinite(s.startTs) && Number.isFinite(s.endTsReal) && s.endTsReal >= s.startTs) ? (s.endTsReal - s.startTs) : null,
                endType: s.resultType === 'DROP_CALL'
                    ? 'DROP'
                    : (s.resultType === 'CALL_SETUP_FAILURE'
                        ? 'CALL_SETUP_FAILURE'
                        : (s.resultType === 'INCOMPLETE_OR_UNKNOWN_END' ? 'INCOMPLETE_OR_UNKNOWN_END' : 'NORMAL')),
                endTrigger: s.reason || s.category || s.resultType,
                drop: s.resultType === 'DROP_CALL',
                setupFailure: s.resultType === 'CALL_SETUP_FAILURE',
                failureReason: {
                    label: s.category || s.resultType,
                    cause: s.reason || '-'
                },
                rrcStates: [],
                rabLifecycle: [],
                radioMeasurementsTimeline: timeline,
                eventTimeline: Array.isArray(s.eventTimeline) ? s.eventTimeline : [],
                umts: {
                    resultType: s.resultType,
                    classification: s.classification || null,
                    snapshot: s.snapshot || null,
                    contextBundle: s.contextBundle || null,
                    setupFailureDeepAnalysis: s.setupFailureDeepAnalysis || null
                },
                contextBundle: s.contextBundle || null,
                setupFailureDeepAnalysis: s.setupFailureDeepAnalysis || null,
                _source: 'umts'
            };
        });
    }
};

const NMFParser = {
    parse(content) {
        const lines = content.split(/\r?\n/);
        const uniqueHeaders = new Set();

        // Pass 1: State Tracking Structures
        const identityTrack = []; // [{time, cid, rnc, lac, psc}]
        const gpsTrack = [];      // [{time, lat, lng, alt, speed}]

        // --- PASS 1: Collection ---
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line || line.startsWith('#')) continue;
            const parts = line.split(',');
            const header = parts[0];
            const time = parts[1];
            if (!time) continue;

            if (header === 'CHI') {
                const tech = parseInt(parts[3]);
                let state = { time, cid: null, rnc: null, lac: null, psc: null };

                if (tech === 5) {
                    // Refined 3G Search
                    let foundBigId = false;
                    for (let k = 6; k < parts.length; k++) {
                        const val = parseInt(parts[k]);
                        if (!isNaN(val) && val > 20000) {
                            state.cid = val;
                            state.rnc = val >> 16;
                            foundBigId = true;
                            // Search for LAC and PSC nearby
                            for (let j = 1; j <= 4; j++) {
                                if (k + j >= parts.length) break;
                                const cand = parts[k + j];
                                if (cand.includes('.') || cand === '') continue;
                                const cVal = parseInt(cand);
                                if (!isNaN(cVal) && cVal > 0 && cVal < 65535) {
                                    if (!state.lac || state.lac === 0) state.lac = cVal;
                                    else if (state.psc === null && cVal <= 511) state.psc = cVal;
                                }
                            }
                            break;
                        }
                    }
                    if (!foundBigId) {
                        // Strict fallback check for specific columns (Standard NMF: 9=RNC, 12=CID or vice versa)
                        // If we didn't find a Big ID, we look for two valid integers
                        let candidates = [];
                        for (let k = 6; k < parts.length; k++) {
                            const cVal = parseInt(parts[k]);
                            if (!isNaN(cVal) && !parts[k].includes('.') && cVal > 0) candidates.push({ idx: k, val: cVal });
                        }
                        // Priority: If we have an obvious RNC/CID pair (e.g. 445 and 58134)
                        let rnc = candidates.find(c => c.val > 10 && c.val < 4096);
                        let cid = candidates.find(c => c.val > 4096 && c.val < 65535 && (!rnc || c.idx !== rnc.idx));
                        if (rnc && cid) {
                            state.rnc = rnc.val;
                            state.cid = (rnc.val << 16) + cid.val;
                        }
                    }

                    // --- NEW: Event 1A Config Extraction (Heuristic) ---
                    // Pattern in user log: ... 3.0,100,5.0,1280,0.5,100 ...
                    // Mapping Hypothesis: Hysteresis, RSCP_Thresh, Range, TTT, ?, ?
                    // We look for the sequence of float, int/float, float, 1280/640/320 
                    for (let x = 10; x < parts.length - 5; x++) {
                        const v1 = parseFloat(parts[x]);
                        const v2 = parseFloat(parts[x + 1]);
                        const v3 = parseFloat(parts[x + 2]);
                        const v4 = parseInt(parts[x + 3]);
                        const v5 = parseFloat(parts[x + 4]);
                        const v6 = parseFloat(parts[x + 5]);

                        // Check for TTT characteristic values (1280, 640, 320, 160)
                        if (!isNaN(v1) && !isNaN(v3) && [1280, 640, 320, 160, 100, 200].includes(v4)) {
                            // Valid candidate sequence
                            if (v1 >= 0 && v1 <= 10 && v3 >= 0 && v3 <= 10) {
                                // Initialize history if needed
                                if (!this.event1AHistory) this.event1AHistory = [];

                                // Capture entry
                                this.event1AHistory.push({
                                    time: time,
                                    hysteresis: v1,
                                    thresholdRSCP: v2,
                                    range: v3,
                                    timeToTrigger: v4,
                                    filterCoef: v5,
                                    thresholdEcNo: v6,
                                    rawValues: [v1, v2, v3, v4, v5, v6, parseFloat(parts[x + 6]), parseFloat(parts[x + 7])],
                                    maxActiveSet: 3 // Default
                                });

                                // Keep legacy single config for backward compatibility/summary
                                if (!this.detected1AConfig) {
                                    this.detected1AConfig = this.event1AHistory[0];
                                }
                            }
                        }
                    }
                } else if (tech === 7) {
                    // LTE
                    if (parts.length > 10) {
                        state.cid = parseInt(parts[9]);
                        state.lac = parseInt(parts[10]);
                    }
                }
                if (state.cid) identityTrack.push(state);

            } else if (header === 'GPS') {
                if (parts.length > 4) {
                    const lat = parseFloat(parts[4]);
                    const lng = parseFloat(parts[3]);
                    if (!isNaN(lat) && !isNaN(lng)) {
                        gpsTrack.push({
                            time,
                            lat, lng,
                            alt: parseFloat(parts[5]),
                            speed: parseFloat(parts[8])
                        });
                    }
                }
            } else if (header === 'EDCHI' || header === 'CHI' || header === 'PCHI') {
                const tech = parseInt(parts[3]);
                if (tech === 5) {
                    // Extract PSC and Freq from Event Identity records
                    const freq = parseFloat(parts[10]);
                    const psc = parseInt(parts[11]);
                    if (!isNaN(freq) && freq > 0) {
                        // Create a partial identity state if we don't have a full UCID yet
                        identityTrack.push({
                            time,
                            freq: freq,
                            psc: psc,
                            source: header
                        });
                    }
                }
            } else if (header === 'RRCSM') {
                // PASS 1 SIGNALING HEURISTIC: Extract authoritative UCID from hex payloads
                const tech = parseInt(parts[3]);
                const hex = parts[parts.length - 1];
                if (tech === 5 && hex && hex.length > 30) {
                    const msgType = parts[5];
                    const isRelevantMsg = msgType && (
                        msgType.includes('RECONFIGURATION') ||
                        msgType.includes('ACTIVE_SET_UPDATE') ||
                        msgType.includes('MEASUREMENT_CONTROL') ||
                        msgType.includes('CELL_UPDATE') ||
                        msgType.includes('TRANSPORT_CHANNEL') ||
                        msgType.includes('HANDOVER_FROM_UTRAN') ||
                        msgType.includes('SYSTEM_INFORMATION')
                    );

                    if (isRelevantMsg) {
                        // HEURISTIC: Skip headers
                        const payload = hex.substring(8);

                        // Search for known RNC hex patterns: 442-446 (0x1BA-0x1BE)
                        let foundIdx = -1;
                        let matchedRnc = null;

                        const patterns = { "1BA": 442, "1BB": 443, "1BC": 444, "1BD": 445, "1BE": 446 };
                        for (const [prefix, rncVal] of Object.entries(patterns)) {
                            const idx = payload.indexOf(prefix);
                            if (idx !== -1) {
                                foundIdx = idx;
                                matchedRnc = rncVal;
                                break;
                            }
                        }

                        if (foundIdx !== -1 && foundIdx + 6 <= payload.length) {
                            const ucidShortHex = payload.substring(foundIdx, foundIdx + 6);
                            const ucidShortVal = parseInt(ucidShortHex, 16);
                            if (!isNaN(ucidShortVal)) {
                                const rnc = ucidShortVal >> 12;
                                const cidShort = (ucidShortVal & 0xFFF);

                                // Synthesize a 28nd bit compatible ID (RNC << 16 + ShortCID << 4)
                                const synthesizedCid = (rnc << 16) + (cidShort << 4);

                                identityTrack.push({
                                    time,
                                    cid: synthesizedCid,
                                    rnc: matchedRnc,
                                    psc: parseInt(parts[8]),
                                    source: 'signaling_rrc',
                                    isSignaling: true
                                });
                            }
                        }
                    }
                }
            } else if (header === 'CHI') {
                const tech = parseInt(parts[3]);
                if (tech === 5) {
                    const ucid = parseInt(parts[7]);
                    const rnc = parseInt(parts[8]);
                    const lac = parseInt(parts[9]);
                    if (!isNaN(rnc) && !isNaN(ucid)) {
                        identityTrack.push({ time, cid: ucid, rnc: rnc, lac: lac, source: 'CHI', isSignaling: true });
                    }
                } else if (tech === 7) {
                    const eci = parseInt(parts[9]);
                    const tac = parseInt(parts[10]);
                    if (!isNaN(eci)) {
                        identityTrack.push({ time, cid: eci, lac: tac, source: 'CHI', isSignaling: true });
                    }
                }
            } else if (header === 'CREL') {
                const tech = parseInt(parts[10]);
                const rnc = parseInt(parts[12]);
                const ucid = parseInt(parts[13]);
                if (tech === 5 && !isNaN(rnc) && !isNaN(ucid)) {
                    identityTrack.push({ time, cid: ucid, rnc: rnc, source: 'CREL', isSignaling: true });
                }
            } else if (header === 'RRD') {
                const cause = parts[6];
                if (cause === '1' || cause === '5') {
                    identityTrack.push({
                        time,
                        source: 'RRD_EVENT',
                        isEvent: true,
                        eventType: cause === '1' ? 'Call Drop' : 'Call Fail',
                        eventCause: cause
                    });
                }
            }
        }

        // Sort tracks to ensure lookup works
        const timeSort = (a, b) => a.time.localeCompare(b.time);
        identityTrack.sort(timeSort);
        gpsTrack.sort(timeSort);

        // --- Helper: Find State at Time ---
        const findLastAt = (track, time) => {
            if (!track.length) return null;
            let last = null;
            for (let item of track) {
                if (item.time.localeCompare(time) <= 0) last = item;
                else break;
            }
            return last;
        };

        // --- PASS 2: Processing ---
        let allPoints = [];
        let currentNeighbors = []; // Global state for signaling snapshot
        let currentRrcState = 'IDLE'; // Default Initial State
        let latestUeTxPower = null;
        let latestNodeBTxPower = null;
        let latestTpc = null;
        let lastAsSize = null;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line || line.startsWith('#')) continue;
            const parts = line.split(',');
            const header = parts[0];
            const time = parts[1];
            if (!time) continue;

            const state = findLastAt(identityTrack, time) || { cid: 'N/A', rnc: null, lac: 'N/A', psc: null };
            const gps = findLastAt(gpsTrack, time);

            // RRC State State Machine (Simple Heuristic)
            const upperHeader = header.toUpperCase();
            if (upperHeader === 'RRCSM') {
                const partsForMsg = line.toUpperCase(); // check whole line for ease
                const isDl = parts[4] === '2';
                const isUl = parts[4] === '1';

                if (partsForMsg.includes('RADIO_BEARER_SETUP') ||
                    partsForMsg.includes('RADIO_BEARER_RECONFIGURATION') ||
                    partsForMsg.includes('PHYSICAL_CHANNEL_RECONFIGURATION') ||
                    partsForMsg.includes('ACTIVE_SET_UPDATE') ||
                    partsForMsg.includes('MEASUREMENT_CONTROL')) {
                    currentRrcState = 'CELL_DCH';

                    if (isDl && !partsForMsg.includes('COMPLETE')) {
                        // Handover Command
                        allPoints.push({
                            lat: gps ? gps.lat : null, lng: gps ? gps.lng : null, time,
                            type: 'EVENT', event: 'HO Command', message: parts[5],
                            properties: {
                                'Time': time, 'Type': 'EVENT', 'Event': 'HO Command', 'Message': parts[5],
                                'HO Command': 'HO Command'
                            }
                        });
                    }
                } else if (partsForMsg.includes('CELL_UPDATE')) {
                    currentRrcState = 'CELL_FACH';
                } else if (partsForMsg.includes('PAGING_TYPE')) {
                    currentRrcState = 'IDLE'; // or PCH
                } else if (partsForMsg.includes('RRC_CONNECTION_RELEASE')) {
                    currentRrcState = 'IDLE';
                    // Added Release Cause Logic
                    allPoints.push({
                        lat: gps ? gps.lat : null, lng: gps ? gps.lng : null, time,
                        type: 'EVENT', event: 'RRC Release', message: 'RRC Connection Released',
                        properties: {
                            'Time': time, 'Type': 'EVENT', 'Event': 'RRC Release',
                            'RRC Release Cause': 'Normal (Implied)',
                            'rrc_rel_cause': 'Normal',
                            'cs_rel_cause': state.cs_cause || 'N/A',
                            'iucs_status': 'Released'
                        }
                    });
                    if (!state.rrc_cause) state.rrc_cause = 'Normal';
                    state.iucs_status = 'Released';
                } else if (partsForMsg.includes('RRC_CONNECTION_REJECT')) {
                    currentRrcState = 'IDLE';
                }

                if (isUl && partsForMsg.includes('COMPLETE')) {
                    // Handover / Message Completion
                    allPoints.push({
                        lat: gps ? gps.lat : null, lng: gps ? gps.lng : null, time,
                        type: 'EVENT', event: 'HO Completion', message: parts[5],
                        properties: {
                            'Time': time, 'Type': 'EVENT', 'Event': 'HO Completion', 'Message': parts[5],
                            'HO Completion': 'HO Completion'
                        }
                    });
                }

                // --- NEW: Radio Link Failure & Sync Status ---
                const msgUpper = partsForMsg.replace(/_/g, ' '); // Normalize for loose matching
                if (msgUpper.includes('OUT') && msgUpper.includes('SYNC')) {
                    allPoints.push({
                        lat: gps ? gps.lat : null, lng: gps ? gps.lng : null, time,
                        type: 'EVENT', event: 'DL sync loss (Interference / coverage)', message: 'Downlink Out of Sync Indication',
                        properties: {
                            'Time': time, 'Type': 'EVENT', 'Event': 'DL sync loss (Interference / coverage)',
                            'DL sync loss (Interference / coverage)': 'DL sync loss (Interference / coverage)'
                        }
                    });
                }
                if (msgUpper.includes('UL') && msgUpper.includes('SYNC') && msgUpper.includes('LOSS')) {
                    allPoints.push({
                        lat: gps ? gps.lat : null, lng: gps ? gps.lng : null, time,
                        type: 'EVENT', event: 'UL sync loss (UE can’t reach NodeB)', message: 'Uplink Synchronization Loss',
                        properties: {
                            'Time': time, 'Type': 'EVENT', 'Event': 'UL sync loss (UE can’t reach NodeB)',
                            'UL sync loss (UE can’t reach NodeB)': 'UL sync loss (UE can’t reach NodeB)'
                        }
                    });
                }
                if (msgUpper.includes('RL FAILURE') || msgUpper.includes('RADIO LINK FAILURE') || msgUpper.includes('RLF') || msgUpper.includes('REESTABLISHMENT')) {
                    allPoints.push({
                        lat: gps ? gps.lat : null, lng: gps ? gps.lng : null, time,
                        type: 'EVENT', event: 'RLF indication', message: parts[5] || 'Radio Link Failure Indication',
                        properties: {
                            'Time': time, 'Type': 'EVENT', 'Event': 'RLF indication',
                            'RLF indication': 'RLF indication'
                        }
                    });
                }

                // --- NEW: Timers (T310, T312) ---
                if (partsForMsg.includes('T310_EXPIRY') || partsForMsg.includes('T310 EXPIRED')) {
                    allPoints.push({
                        lat: gps ? gps.lat : null, lng: gps ? gps.lng : null, time,
                        type: 'EVENT', event: 'T310', message: 'Timer T310 Expired',
                        properties: { 'Time': time, 'Type': 'EVENT', 'Event': 'T310', 'T310': 'Expired' }
                    });
                }
                if (partsForMsg.includes('T312_EXPIRY') || partsForMsg.includes('T312 EXPIRED')) {
                    allPoints.push({
                        lat: gps ? gps.lat : null, lng: gps ? gps.lng : null, time,
                        type: 'EVENT', event: 'T312', message: 'Timer T312 Expired',
                        properties: { 'Time': time, 'Type': 'EVENT', 'Event': 'T312', 'T312': 'Expired' }
                    });
                }
            } else if (upperHeader === 'L3SM') {
                const messageName = parts[5].replace(/^"|"$/g, '');
                if (messageName === 'RELEASE' || messageName === 'DISCONNECT') {
                    // CS Release
                    allPoints.push({
                        lat: gps ? gps.lat : null, lng: gps ? gps.lng : null, time,
                        type: 'EVENT', event: 'CS Release', message: 'CS Call Released',
                        properties: {
                            'Time': time, 'Type': 'EVENT', 'Event': 'CS Release',
                            'CS Release Cause': 'Normal Clearing',
                            'rrc_rel_cause': state.rrc_cause || 'N/A',
                            'cs_rel_cause': 'Normal Clearing',
                            'iucs_status': 'Released'
                        }
                    });
                    state.cs_cause = 'Normal Clearing';
                    state.iucs_status = 'Released';
                } else if (messageName === 'CONNECT' || messageName === 'SETUP') {
                    state.iucs_status = 'Connected';
                    state.cs_cause = '-';
                }
            } else if (upperHeader === 'RRCSM' || upperHeader === 'L3SM') {
                const msgUpper = line.toUpperCase().replace(/_/g, ' ');
                if (msgUpper.includes('T310')) {
                    allPoints.push({
                        lat: gps ? gps.lat : null, lng: gps ? gps.lng : null, time,
                        type: 'EVENT', event: 'T310', message: 'T310 Timer Expired',
                        properties: { 'Time': time, 'Type': 'EVENT', 'Event': 'T310', 'T310': 'Expired' }
                    });
                }
                if (msgUpper.includes('T312')) {
                    allPoints.push({
                        lat: gps ? gps.lat : null, lng: gps ? gps.lng : null, time,
                        type: 'EVENT', event: 'T312', message: 'T312 Timer Expired',
                        properties: { 'Time': time, 'Type': 'EVENT', 'Event': 'T312', 'T312': 'Expired' }
                    });
                }
            } else if (upperHeader === 'TXPC') {
                const val = parseFloat(parts[4]);
                if (!isNaN(val)) latestUeTxPower = val;
                const tpc = parseInt(parts[5]);
                if (!isNaN(tpc)) latestTpc = tpc;
            } else if (upperHeader === 'RXPC') {
                const val = parseFloat(parts[5]);
                if (!isNaN(val)) latestNodeBTxPower = val;
            } else if (upperHeader === 'RRD') {
                const cause = parts[6];
                if (cause === '1' || cause === '5') {
                    const eventName = (cause === '1') ? 'Call Drop' : 'RLF indication';
                    allPoints.push({
                        lat: gps ? gps.lat : null, lng: gps ? gps.lng : null, time,
                        type: 'EVENT', event: eventName, message: `RRD Release Cause ${cause}`,
                        properties: {
                            'Time': time, 'Type': 'EVENT', 'Event': eventName,
                            [eventName]: eventName
                        }
                    });
                }
            } else if (upperHeader === 'RRA') {
                const cause = parts[5]; // RRA code is usually at index 5 or 6 depending on subversion
                let eventName = null;
                if (cause === '16' || cause === '2') eventName = 'RLF indication';
                else if (cause === '12') eventName = 'DL sync loss (Interference / coverage)';
                else if (cause === '4') eventName = 'UL sync loss (UE can’t reach NodeB)';

                if (eventName) {
                    allPoints.push({
                        lat: gps ? gps.lat : null, lng: gps ? gps.lng : null, time,
                        type: 'EVENT', event: eventName, message: `Radio Resource Alarm (RRA Cause ${cause})`,
                        properties: { 'Time': time, 'Type': 'EVENT', 'Event': eventName, [eventName]: eventName }
                    });
                }
            } else if (upperHeader === 'RRCSM') {
                // Clean parts (remove quotes)
                const messageName = parts[5].replace(/^"|"$/g, '');
                // console.log(`[DEBUG] RRCSM Msg: ${messageName}`);
                if (messageName.includes('RELEASE')) console.log(`[DEBUG] RRCSM RELEASE: ${messageName}`);

                if (messageName === 'RRC_CONNECTION_RELEASE') {
                    allPoints.push({
                        lat: gps ? gps.lat : null, lng: gps ? gps.lng : null, time,
                        type: 'EVENT', event: 'RRC Release', message: 'RRC Connection Released',
                        properties: {
                            'Time': time, 'Type': 'EVENT', 'Event': 'RRC Release',
                            'RRC Release Cause': 'Normal (Implied)',
                            'rrc_rel_cause': 'Normal',
                            'cs_rel_cause': state.cs_cause || 'N/A',
                            'iucs_status': 'Released'
                        }
                    });
                    // Track last RRC Cause for metric
                    if (!state.rrc_cause) state.rrc_cause = 'Normal';
                    state.iucs_status = 'Released';
                }
            } else if (upperHeader === 'CAF') {
                const cause = parts[6];
                if (cause === '2') {
                    const messageName = parts[5].replace(/^"|"$/g, '');
                    // Original RRC Release check removed (wrong place) or kept as fallback? 
                    // Keeping as fallback if needed, but the main one is RRCSM.
                    if (messageName === 'RRC_CONNECTION_RELEASE') {
                        // Fallback logic SAME as above
                        if (!state.rrc_cause) state.rrc_cause = 'Normal';
                        state.iucs_status = 'Released';
                    } else {
                        // Original RLF indication for CAF cause 2
                        allPoints.push({
                            lat: gps ? gps.lat : null, lng: gps ? gps.lng : null, time,
                            type: 'EVENT', event: 'RLF indication', message: 'Channel Activation Failure (CAF)',
                            properties: { 'Time': time, 'Type': 'EVENT', 'Event': 'RLF indication', 'RLF indication': 'RLF indication' }
                        });
                    }
                }
            } else if (upperHeader === 'L3SM') {
                // CS Release (CC Release)
                const messageName = parts[5].replace(/^"|"$/g, '');
                if (messageName.includes('RELEASE') || messageName.includes('DISCONNECT')) console.log(`[DEBUG] L3SM RELEASE: ${messageName}`);
                if (messageName === 'RELEASE' || messageName === 'DISCONNECT') {
                    // CS Release
                    allPoints.push({
                        lat: gps ? gps.lat : null, lng: gps ? gps.lng : null, time,
                        type: 'EVENT', event: 'CS Release', message: 'CS Call Released',
                        properties: {
                            'Time': time, 'Type': 'EVENT', 'Event': 'CS Release',
                            'CS Release Cause': 'Normal Clearing',
                            'rrc_rel_cause': state.rrc_cause || 'N/A',
                            'cs_rel_cause': 'Normal Clearing',
                            'iucs_status': 'Released'
                        }
                    });
                    state.cs_cause = 'Normal Clearing';
                    state.iucs_status = 'Released';
                } else if (messageName === 'CONNECT' || messageName === 'SETUP') {
                    state.iucs_status = 'Connected';
                    state.cs_cause = '-'; // Reset cause on new call
                }

                const msgUpper = line.toUpperCase();
                if (msgUpper.includes('OUT') && msgUpper.includes('SYNC')) {
                    allPoints.push({
                        lat: gps ? gps.lat : null, lng: gps ? gps.lng : null, time,
                        type: 'EVENT', event: 'DL sync loss (Interference / coverage)', message: 'Downlink Out of Sync Indication (L3)',
                        properties: {
                            'Time': time, 'Type': 'EVENT', 'Event': 'DL sync loss (Interference / coverage)',
                            'DL sync loss (Interference / coverage)': 'DL sync loss (Interference / coverage)'
                        }
                    });
                }
                if (msgUpper.includes('RL FAILURE') || msgUpper.includes('RADIO LINK FAILURE') || msgUpper.includes('RLF') || msgUpper.includes('REESTABLISHMENT')) {
                    allPoints.push({
                        lat: gps ? gps.lat : null, lng: gps ? gps.lng : null, time,
                        type: 'EVENT', event: 'RLF indication', message: 'Radio Link Failure Indication (L3)',
                        properties: {
                            'Time': time, 'Type': 'EVENT', 'Event': 'RLF indication',
                            'RLF indication': 'RLF indication'
                        }
                    });
                }
            }

            if (upperHeader === 'CELLMEAS') {
                if (!gps) continue;
                const techId = parseInt(parts[3]);

                let servingFreq = null;
                let servingLevel = null;
                let servingSc = null;
                let servingEcNo = null;
                let servingBand = 'Unknown';
                let valRssi = null;
                let activeSetCount = 1;
                let monitoredSetCount = 0;
                let neighbors = [];

                if (techId === 5) {
                    // UMTS (Tech 5)
                    const toNumCell = (v) => {
                        const x = parseFloat(v);
                        return Number.isFinite(x) ? x : null;
                    };
                    const toIntCell = (v) => {
                        const x = parseInt(v, 10);
                        return Number.isFinite(x) ? x : null;
                    };
                    const looksLikePlmn = (v) => /^[0-9]{5}$/.test(String(v || '').trim());
                    const near = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 1;
                    const validSc = (v) => Number.isFinite(v) && v >= 0 && v <= 512;
                    const scanUmtsServing = (arr, sfreq) => {
                        for (let i = 0; i < arr.length - 3; i++) {
                            if (!looksLikePlmn(arr[i])) continue;
                            const freq = toNumCell(arr[i + 1]);
                            const sc = toIntCell(arr[i + 2]);
                            if (!near(freq, sfreq) || !validSc(sc)) continue;
                            return { sc, ecno: toNumCell(arr[i + 3]) };
                        }
                        return null;
                    };
                    const scanUmtsCellBlocks = (arr) => {
                        const blocks = [];
                        const seen = new Set();
                        for (let k = 0; k < arr.length - 6; k++) {
                            const setType = toIntCell(arr[k]);
                            if (setType === null || setType < 0 || setType > 3) continue;
                            const plmn = String(arr[k + 1] || '').trim();
                            const uarfcn = toNumCell(arr[k + 2]);
                            const psc = toIntCell(arr[k + 3]);
                            const ecno = toNumCell(arr[k + 4]);
                            const rscp = toNumCell(arr[k + 6]);
                            const ok =
                                looksLikePlmn(plmn) &&
                                uarfcn !== null && uarfcn > 2000 &&
                                psc !== null && psc >= 0 && psc <= 512 &&
                                rscp !== null && rscp < -20 && rscp > -140;
                            if (!ok) continue;
                            const key = `${Math.round(uarfcn)}:${psc}:${setType}`;
                            if (seen.has(key)) continue;
                            seen.add(key);
                            blocks.push({ setType, freq: uarfcn, psc, ecno, rscp, _k: k });
                        }
                        return blocks;
                    };
                    const scanUmtsCellBlocksFallback = (arr) => {
                        const blocks = [];
                        const seen = new Set();
                        for (let k = 15; k < arr.length - 6; k += 8) {
                            const setType = toIntCell(arr[k]);
                            if (setType === null || setType < 0 || setType > 3) continue;
                            const uarfcn = toNumCell(arr[k + 2]);
                            const psc = toIntCell(arr[k + 3]);
                            const ecno = toNumCell(arr[k + 4]);
                            const rscp = toNumCell(arr[k + 6]);
                            const ok =
                                uarfcn !== null && uarfcn > 2000 &&
                                psc !== null && psc >= 0 && psc <= 512 &&
                                rscp !== null && rscp < -20 && rscp > -140;
                            if (!ok) continue;
                            const key = `${Math.round(uarfcn)}:${psc}:${setType}`;
                            if (seen.has(key)) continue;
                            seen.add(key);
                            blocks.push({ setType, freq: uarfcn, psc, ecno, rscp, _k: k });
                        }
                        return blocks;
                    };
                    const labelUmtsNeighbors = (inNeighbors, sfreq, actCount, monCount) => {
                        const cleanNeighbors = (inNeighbors || []).filter(n => !n.isServing);
                        const rscpDesc = (a, b) => (Number(b?.rscp) || -999) - (Number(a?.rscp) || -999);
                        const isInterFreq = (n) =>
                            Number.isFinite(Number(n?.freq)) &&
                            Number.isFinite(Number(sfreq)) &&
                            Math.abs(Number(n.freq) - Number(sfreq)) >= 1;

                        const activeSlots = Math.max(0, (actCount || 1) - 1);
                        const hasMonitoredContext = Math.max(0, monCount || 0) > 0;

                        const activeCandidates = [];
                        const monitored = [];
                        const detected = [];
                        const unknown = [];

                        for (const n of cleanNeighbors) {
                            const st = Number.isFinite(Number(n?.setType)) ? Number(n.setType) : null;
                            if (st === 0 || st === 1) activeCandidates.push(n);
                            else if (st === 2) monitored.push(n);
                            else if (st !== null && st > 2) detected.push(n);
                            else unknown.push(n);
                        }

                        activeCandidates.sort(rscpDesc);
                        monitored.sort(rscpDesc);
                        detected.sort(rscpDesc);
                        unknown.sort(rscpDesc);

                        // Keep only the configured active set size in A*, overflow goes to monitored/detected.
                        const active = activeCandidates.slice(0, activeSlots);
                        const overflowActive = activeCandidates.slice(activeSlots);
                        for (const n of overflowActive) {
                            if (isInterFreq(n) || hasMonitoredContext) monitored.push(n);
                            else detected.push(n);
                        }

                        // Unknown setType inference: inter-frequency + monitored context -> monitored, else detected.
                        for (const n of unknown) {
                            if (isInterFreq(n) && hasMonitoredContext) monitored.push(n);
                            else detected.push(n);
                        }

                        active.sort(rscpDesc);
                        monitored.sort(rscpDesc);
                        detected.sort(rscpDesc);

                        const activeLabeled = active.slice(0, 16);
                        const monitoredLabeled = monitored.slice(0, 16);
                        const detectedLabeled = detected.slice(0, 16);

                        activeLabeled.forEach((n, i) => {
                            n.type = `A${i + 2}`;
                            n.name = n.type;
                            n.setLabel = 'Active';
                        });
                        monitoredLabeled.forEach((n, i) => {
                            n.type = `M${i + 1}`;
                            n.name = n.type;
                            n.setLabel = 'Monitored';
                        });
                        detectedLabeled.forEach((n, i) => {
                            n.type = `D${i + 1}`;
                            n.name = n.type;
                            n.setLabel = 'Detected';
                        });

                        return { neighbors: [...activeLabeled, ...monitoredLabeled, ...detectedLabeled] };
                    };

                    servingFreq = toNumCell(parts[7]);
                    servingLevel = toNumCell(parts[8]); // RSCP
                    servingSc = null;
                    servingEcNo = null;
                    activeSetCount = parseInt(parts[5]) || 1;
                    monitoredSetCount = parseInt(parts[6]) || 0;

                    if (servingFreq !== null && servingFreq <= 0) servingFreq = null;
                    if (servingFreq !== null) {
                        if (servingFreq >= 10562 && servingFreq <= 10838) servingBand = 'B1 (2100)';
                        else if (servingFreq >= 2937 && servingFreq <= 3088) servingBand = 'B8 (900)';
                    }

                    const servingMatch = scanUmtsServing(parts, servingFreq);
                    if (servingMatch) {
                        servingSc = servingMatch.sc;
                        servingEcNo = servingMatch.ecno;
                    }

                    let blocks = scanUmtsCellBlocks(parts);
                    if (!blocks.length) {
                        blocks = scanUmtsCellBlocksFallback(parts);
                    }

                    neighbors = blocks.map((b) => {
                        const isServing = near(b.freq, servingFreq) && validSc(servingSc) && b.psc === servingSc;
                        return {
                            freq: b.freq,
                            pci: b.psc,
                            ecno: b.ecno,
                            rscp: b.rscp,
                            setType: b.setType,
                            isServing
                        };
                    });

                    if (!validSc(servingSc) && neighbors.length) {
                        const onServingFreq = neighbors.filter((n) => near(n.freq, servingFreq));
                        const fallbackServing = (onServingFreq.length ? onServingFreq : neighbors)
                            .reduce((best, n) => (!best || n.rscp > best.rscp) ? n : best, null);
                        if (fallbackServing) {
                            servingSc = fallbackServing.pci;
                            if (servingEcNo === null) servingEcNo = fallbackServing.ecno;
                            neighbors.forEach((n) => {
                                n.isServing = near(n.freq, servingFreq) && n.pci === servingSc;
                            });
                        }
                    }

                    const labeled = labelUmtsNeighbors(neighbors, servingFreq, activeSetCount, monitoredSetCount);
                    neighbors = labeled.neighbors;

                    // RSSI calculation for 3G
                    if (Number.isFinite(servingLevel) && Number.isFinite(servingEcNo)) {
                        valRssi = servingLevel - servingEcNo;
                    }
                } else if (techId === 7) {
                    // LTE/HSPA+ (Tech 7)
                    // LTE format: [cellId?, earfcn, pci, rssi, rsrp, rsrq, cellId]
                    servingFreq = parseFloat(parts[9]);
                    servingLevel = parseFloat(parts[12]); // RSRP
                    servingSc = parseInt(parts[10]) || 'N/A'; // PCI
                    servingEcNo = parseFloat(parts[13]); // RSRQ
                    valRssi = parseFloat(parts[11]); // RSSI
                    if (isNaN(servingFreq) || servingFreq <= 0) servingFreq = null;
                    servingBand = parts[14];
                    activeSetCount = 1;
                    monitoredSetCount = parseInt(parts[6]) || 0;

                    // Neighbors: Robust Scanning (Tech 7)
                    for (let k = 15; k < parts.length - 6; k++) {
                        const type = parseInt(parts[k]);
                        const freq = parseFloat(parts[k + 2]);
                        const pci = parseInt(parts[k + 3]);
                        const rsrp = parseFloat(parts[k + 4]);
                        const rssi = parseFloat(parts[k + 5]);
                        const rsrq = parseFloat(parts[k + 6]);

                        const isValidType = !isNaN(type) && type >= 0 && type <= 3;
                        const isValidFreq = !isNaN(freq) && freq > 100;
                        const isValidPci = !isNaN(pci) && pci >= 0 && pci <= 1008;
                        const isValidRsrp = !isNaN(rsrp) && rsrp < -20 && rsrp > -200;

                        if (isValidType && isValidFreq && isValidPci && isValidRsrp) {
                            neighbors.push({
                                freq: freq,
                                pci: pci,
                                ecno: rsrq, // RSRQ
                                rscp: rsrp,  // RSRP
                                rssi: rssi
                            });
                            k += 8; // Advance
                        }
                    }
                } else {
                    // Fallback
                    servingFreq = parseFloat(parts[7]);
                    servingLevel = parseFloat(parts[8]);
                    servingSc = parts[9];
                    activeSetCount = parseInt(parts[5]) || 1;
                }

                // SANITY CHECK: Swap if indices are misaligned
                if (servingLevel > -15 && servingFreq < -50) {
                    let tmp = servingFreq; servingFreq = servingLevel; servingLevel = tmp;
                }

                let rnc = state.rnc;
                if ((!rnc || isNaN(rnc)) && state.cid > 65535) {
                    rnc = state.cid >> 16;
                }
                const cid = (state.cid && !isNaN(state.cid)) ? (state.cid & 0xFFFF) : null;

                const point = {
                    lat: gps.lat, lng: gps.lng, time,
                    type: 'MEASUREMENT', level: servingLevel, ecno: servingEcNo, sc: servingSc, freq: servingFreq,
                    cellId: state.cid, rnc: rnc, cid: cid, lac: state.lac,
                    parsed: {
                        serving: {
                            freq: servingFreq, [techId === 5 ? 'rscp' : 'rsrp']: servingLevel, band: servingBand, sc: servingSc,
                            [techId === 5 ? 'ecno' : 'rsrq']: servingEcNo, lac: state.lac, cellId: state.cid, rnc: rnc, cid: cid
                        },
                        neighbors
                    },
                    properties: {
                        'Time': time,
                        'Tech': techId === 5 ? 'UMTS' : (techId === 7 ? 'LTE' : 'Unknown'),
                        'Cell ID': state.cid,
                        'RNC': rnc,
                        'CID': cid,
                        'LAC': state.lac,
                        'Freq': (servingFreq !== null ? servingFreq : 'N/A'),
                        'RNC/CID': (rnc !== null && cid !== null) ? `${rnc}/${cid}` : 'N/A',
                        [techId === 5 ? 'Serving RSCP' : 'Serving RSRP']: servingLevel,
                        'Serving SC': servingSc,
                        [techId === 5 ? 'EcNo' : 'RSRQ']: servingEcNo,
                        'RRC State': currentRrcState,
                        'RSSI': valRssi,
                        'UE Tx Power': latestUeTxPower,
                        'NodeB Tx Power': latestNodeBTxPower,
                        'TPC': latestTpc
                    }
                };

                // Detect AS Add / Remove Events
                if (lastAsSize !== null && activeSetCount !== lastAsSize) {
                    const eventName = activeSetCount > lastAsSize ? 'AS Add' : 'AS Remove';
                    allPoints.push({
                        lat: gps.lat, lng: gps.lng, time,
                        type: 'EVENT', event: eventName,
                        message: `Size: ${lastAsSize} -> ${activeSetCount}`,
                        properties: {
                            'Time': time, 'Type': 'EVENT',
                            'Event': eventName,
                            'AS Event': eventName,
                            'Details': `Active Set size changed from ${lastAsSize} to ${activeSetCount}`,
                            'rrc_rel_cause': state.rrc_cause || 'N/A',
                            'cs_rel_cause': state.cs_cause || 'N/A',
                            'iucs_status': state.iucs_status || 'N/A'
                        }
                    });
                }
                lastAsSize = activeSetCount;

                point.properties['Active Set Size'] = activeSetCount;
                point.as_size = activeSetCount;
                point.activeSetCount = activeSetCount;

                if (neighbors && neighbors.length > 0) {
                    currentNeighbors = neighbors;
                }

                // Flatten Neighbors with A/M/D logic
                if (neighbors && neighbors.length > 0) {
                    const cleanNeighbors = neighbors.filter(n => !n.isServing);

                    cleanNeighbors.forEach((n, idx) => {
                        let prefix = 'd';
                        let num = 0;
                        if (techId === 5 && typeof n.type === 'string') {
                            const t = String(n.type).trim().toUpperCase();
                            prefix = t.startsWith('A') ? 'a' : (t.startsWith('M') ? 'm' : 'd');
                            const parsedNum = parseInt(t.slice(1), 10);
                            num = Number.isFinite(parsedNum) ? parsedNum : (idx + 1);
                        } else {
                            const numActiveNeighbors = Math.max(0, activeSetCount - 1);
                            if (idx < numActiveNeighbors) {
                                prefix = 'a';
                                num = idx + 2;
                            } else if (idx < (numActiveNeighbors + monitoredSetCount)) {
                                prefix = 'm';
                                num = idx - numActiveNeighbors + 1;
                            } else {
                                prefix = 'd';
                                num = idx - (numActiveNeighbors + monitoredSetCount) + 1;
                            }
                            if (!n.type) {
                                n.type = prefix.toUpperCase() + num;
                                n.name = n.type;
                            }
                        }

                        // Limit valid count to avoid spam (12 max usually enough)
                        if (num > 16) return;

                        const keyBase = `${prefix}${num}`;

                        point[`${keyBase}_rscp`] = n.rscp;
                        point[`${keyBase}_ecno`] = n.ecno;
                        point[`${keyBase}_sc`] = n.pci;
                        point[`${keyBase}_freq`] = n.freq;

                        // Add to properties for Popup
                        point.properties[`${prefix.toUpperCase()}${num} SC`] = n.pci;
                        point.properties[`${prefix.toUpperCase()}${num} RSCP`] = n.rscp;
                        point.properties[`${prefix.toUpperCase()}${num} EcNo`] = n.ecno;
                    });
                }

                allPoints.push(point);

            } else if (header.toUpperCase().includes('RRC') || header.toUpperCase().includes('L3')) {
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
                // Heuristic for message name
                let message = 'Unknown';
                for (let k = 2; k < parts.length; k++) {
                    const p = parts[k].trim();
                    if (p.length > 5 && !/^\d+$/.test(p)) { message = p; break; }
                }
                if (parts[5]) {
                    const m = parts[5].replace(/^"|"$/g, '');
                    if (m && !/^\d+$/.test(m)) message = m;
                }

                const channel = parts[6] ? parts[6].replace(/^"|"$/g, '') : undefined;
                const freq = parts[7] ? parseFloat(parts[7]) : undefined;
                const sc = parts[8] ? parseInt(parts[8]) : undefined;
                // Direction: try from raw line or infer from message
                let direction = null;
                const lineUpper = line.toUpperCase();
                if (lineUpper.includes('UPLINK')) direction = 'UL';
                else if (lineUpper.includes('DOWNLINK')) direction = 'DL';
                if (!direction && parts.length > 2) {
                    if (parts[2] === '0') direction = 'DL';
                    if (parts[2] === '1') direction = 'UL';
                }
                if (!direction && parts.length > 4) {
                    if (parts[4] === '1') direction = 'UL';
                    if (parts[4] === '2') direction = 'DL';
                }
                if (!direction) direction = inferDirectionFromMessage(message);

                allPoints.push({
                    lat: gps ? gps.lat : null, lng: gps ? gps.lng : null,
                    time, type: 'SIGNALING', message, details: line,
                    radioSnapshot: { cellId: state.cid, lac: state.lac, psc: state.psc, rnc: state.rnc, neighbors: currentNeighbors.slice(0, 8) },
                    rrc_rel_cause: state.rrc_cause || 'N/A',
                    cs_rel_cause: state.cs_cause || 'N/A',
                    direction: direction || 'N/A',
                    channel: channel || 'N/A',
                    freq: !isNaN(freq) ? freq : 'N/A',
                    sc: !isNaN(sc) ? sc : 'N/A',
                    properties: {
                        'Time': time,
                        'Type': 'SIGNALING',
                        'Message': message,
                        'RRC Release Cause': state.rrc_cause || 'N/A',
                        'CS Release Cause': state.cs_cause || 'N/A',
                        'Direction': direction || 'N/A',
                        'Channel': channel || 'N/A',
                        'Freq': !isNaN(freq) ? freq : 'N/A',
                        'SC': !isNaN(sc) ? sc : 'N/A'
                    }
                });
            } else if (upperHeader === 'RLCBLER' || upperHeader === 'MACBLER') {
                if (gps && parts.length > 10) {
                    // Indexes: 4 -> BLER DL, 10 -> BLER UL (Based on User NMF: "RLCBLER,Time,,5,0.0,..." -> 5=tech, 0.0=DL BLER?)
                    // NMF Format: RLCBLER,Time,,Tech,DL_BLER,Blocks_DL,Err_DL,?,DL_Thru?,UL_BLER...
                    // User Example: RLCBLER,10:21:36.788,,5,0.0,100,0,2,4,1,0.0,100,0,32,0.0,0,0
                    // Part 4 is 0.0 (DL BLER likely)
                    // Part 10 is 0.0 (UL BLER likely)

                    const tech = parseInt(parts[3]);
                    const dlBler = parseFloat(parts[4]);
                    const ulBler = parseFloat(parts[10]);

                    if (!isNaN(dlBler) || !isNaN(ulBler)) {
                        allPoints.push({
                            lat: gps.lat, lng: gps.lng, time,
                            type: 'MEASUREMENT', // Treat as measurement to allow coloring
                            bler_dl: !isNaN(dlBler) ? dlBler : undefined,
                            bler_ul: !isNaN(ulBler) ? ulBler : undefined,
                            cellId: state.cid,
                            properties: {
                                'Time': time,
                                'Tech': tech === 5 ? 'UMTS' : 'LTE',
                                'Cell ID': state.cid,
                                'BLER DL': !isNaN(dlBler) ? dlBler : 'N/A',
                                'BLER UL': !isNaN(ulBler) ? ulBler : 'N/A'
                            }
                        });
                    }
                }
            }
        }

        const measurementPoints = allPoints.filter(p => p.type === 'MEASUREMENT');
        const signalingPoints = allPoints.filter(p => p.type === 'SIGNALING');
        const eventPoints = allPoints.filter(p => p.type === 'EVENT');

        // Detect Technology based on measurements
        let detectedTech = 'Unknown';
        if (measurementPoints.length > 0) {
            const sample = measurementPoints.slice(0, 50);
            const freqs = sample.map(p => p.freq).filter(f => !isNaN(f) && f > 0);
            if (freqs.length > 0) {
                const is3G = freqs.some(f => (f >= 10500 && f <= 10900) || (f >= 2900 && f <= 3100) || (f >= 4300 && f <= 4500));
                if (is3G) {
                    detectedTech = '3G (UMTS)';
                } else {
                    const avgFreq = freqs.reduce((a, b) => a + b, 0) / freqs.length;
                    if (avgFreq < 1000) detectedTech = '2G (GSM)';
                    else if (avgFreq > 120000) detectedTech = '5G (NR)';
                    else detectedTech = '4G (LTE)';
                }
            }
        }

        // Build dynamic metric list based on actual data in the file
        const metricSet = new Set();
        const excludeKeys = new Set([
            'lat', 'lng', 'time', 'type', 'parsed', 'geometry', 'properties',
            'event', 'message', 'timestamp', 'tech', 'source',
            'details', 'radioSnapshot'
        ]);
        const shouldExcludePropKey = (k) => /^(time|tech|type|lat|lng|lon|long|latitude|longitude|gps|event|message|details|radiosnapshot|rnc\/cid)$/i.test(k);

        const normalizeKey = (k) => String(k).toLowerCase().replace(/[\s_]+/g, ' ').trim();
        const canonicalizeKey = (k) => {
            const nk = normalizeKey(k);
            const admMatch = nk.match(/^(a|m|d)\s*(\d+)\s*(rscp|ecno|sc|freq)$/);
            if (admMatch) return `${admMatch[1]}${admMatch[2]}_${admMatch[3]}`;

            const map = {
                'cell id': 'Cell ID',
                'cellid': 'Cell ID',
                'cid': 'Cell ID',
                'rnc': 'RNC',
                'lac': 'LAC',
                'freq': 'Freq',
                'ecno': 'EcNo',
                'rssi': 'RSSI',
                'ue tx power': 'UE Tx Power',
                'nodeb tx power': 'NodeB Tx Power',
                'bler dl': 'BLER DL',
                'bler ul': 'BLER UL',
                'rrc state': 'RRC State',
                'ho command': 'HO Command',
                'ho completion': 'HO Completion',
                'as event': 'AS Event',
                'active set size': 'Active Set Size',
                'as size': 'Active Set Size',
                'tpc': 'TPC',
                'serving rscp': 'Serving RSCP',
                'serving sc': 'Serving SC',
                'serving ecno': 'Serving EcNo',
                'serving rnc': 'Serving RNC',
                'serving lac': 'Serving LAC',
                'serving freq': 'Serving Freq'
            };
            return map[nk] || k;
        };

        const addPointMetrics = (p) => {
            if (!p) return;
            Object.keys(p).forEach(k => {
                if (excludeKeys.has(k)) return;
                const v = p[k];
                if (v === undefined || v === null || v === '') return;
                metricSet.add(canonicalizeKey(k));
            });
            if (p.properties) {
                Object.keys(p.properties).forEach(k => {
                    if (shouldExcludePropKey(k)) return;
                    const v = p.properties[k];
                    if (v === undefined || v === null || v === '') return;
                    metricSet.add(canonicalizeKey(k));
                });
            }
        };

        measurementPoints.forEach(addPointMetrics);
        signalingPoints.forEach(addPointMetrics);
        eventPoints.forEach(p => {
            addPointMetrics(p);
            if (p.event) metricSet.add(p.event); // Add event names as metric buttons
        });

        const customMetrics = Array.from(metricSet);
        const callSessions = CallSessionBuilder
            .build(measurementPoints.concat(eventPoints, signalingPoints))
            .map(s => ({
                ...s,
                _source: s?._source || 'generic',
                kind: s?.kind || 'RRC_SESSION'
            }));
        const umtsCallAnalysis = UmtsCallAnalyzer.analyze(content, { windowSeconds: 10 });
        const umtsUiSessions = UmtsCallAnalyzer.toUiSessions(umtsCallAnalysis);
        const keyFrom = (s) => {
            const dev = String(s?.deviceId ?? s?.sessionId ?? '').trim();
            const cid = String(s?.callId ?? s?.callTransactionId ?? '').trim();
            return `${dev}|${cid}`;
        };
        const indexByKey = new Map();
        for (let i = 0; i < callSessions.length; i++) {
            indexByKey.set(keyFrom(callSessions[i]), i);
        }
        for (const us of umtsUiSessions) {
            const k = keyFrom(us);
            const idx = indexByKey.get(k);
            if (idx === undefined) {
                callSessions.push({ ...us, _source: 'umts' });
                indexByKey.set(k, callSessions.length - 1);
            } else {
                callSessions[idx] = { ...callSessions[idx], ...us, _source: 'umts' };
            }
        }

        return {
            points: measurementPoints.concat(eventPoints),
            signaling: signalingPoints,
            events: eventPoints,
            callSessions,
            umtsCallAnalysis,
            tech: detectedTech,
            config: this.detected1AConfig || null,
            configHistory: this.event1AHistory || [],
            customMetrics: customMetrics // Dynamic list based on actual file content
        };
    }

};

const ExcelParser = {
    parse(arrayBuffer) {
        const workbook = XLSX.read(arrayBuffer, { type: 'array' });
        const firstSheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[firstSheetName];
        const json = XLSX.utils.sheet_to_json(worksheet, { defval: "" }); // defval to keep empty/nulls safely

        if (json.length === 0) return { points: [], tech: 'Unknown', customMetrics: [] };

        // 1. Identify Key Columns (Time, Lat, Lon)
        // ROBUST HEADER EXTRACTION: Scan first 50 rows to find ALL potential keys (sparse data support)
        const keysSet = new Set();
        if (json && json.length > 0) {
            const scanLimit = Math.min(json.length, 50);
            for (let i = 0; i < scanLimit; i++) {
                Object.keys(json[i]).forEach(k => keysSet.add(k));
            }
        }
        const keys = Array.from(keysSet);

        const normalize = k => k.toLowerCase().replace(/[\s_]/g, '');

        let timeKey = keys.find(k => /^(time|timestamp|date|datetime)$/i.test(normalize(k)) || /time/i.test(normalize(k))); // Prioritize exact, then loose
        let latKey = keys.find(k => /^(lat|latitude|y_coord|y|cgpslat|cgpslatitude)$/i.test(normalize(k)) || /latitude/i.test(normalize(k)));
        let lngKey = keys.find(k => /^(lon|long|longitude|lng|x_coord|x|cgpslon|cgpslongitude)$/i.test(normalize(k)) || /longitude/i.test(normalize(k)));

        // 2. Identify Metrics (Include All Keys as requested)
        const customMetrics = [...keys]; // User wants EVERY column to be a metric
        // const customMetrics = keys.filter(k => k !== timeKey && k !== latKey && k !== lngKey);

        // 1. Identify Best Columns for Primary Metrics
        const detectBestColumn = (candidates, exclusions = []) => {
            // Enhanced exclusion check
            const isExcluded = (n) => {
                if (n.includes('serving')) return false; // Always trust 'serving'
                if (exclusions.some(ex => n.includes(ex))) return true;

                // Strict 'AS' and 'Neighbor' patterns
                if (n.includes('as') && !n.includes('meas') && !n.includes('class') && !n.includes('phase') && !n.includes('pass') && !n.includes('alias')) return true;
                if (/\bn\d/.test(n) || /^n\d/.test(n)) return true; // n1, n2...

                return false;
            };

            for (let cand of candidates) {
                // 1. Strict match
                let match = keys.find(k => {
                    const n = normalize(k);
                    if (isExcluded(n)) return false;
                    return n === cand || n === normalize(cand);
                });
                if (match) return match;

                // 2. Loose match
                match = keys.find(k => {
                    const n = normalize(k);
                    if (isExcluded(n)) return false;
                    return n.includes(cand);
                });
                if (match) return match;
            }
            return null;
        };

        const scCol = detectBestColumn(['servingcellsc', 'servingsc', 'primarysc', 'primarypci', 'dl_pci', 'dl_sc', 'bestsc', 'bestpci', 'sc', 'pci', 'psc', 'scramblingcode', 'physicalcellid', 'physicalcellidentity', 'phycellid'], ['active', 'set', 'neighbor', 'target', 'candidate']);
        const levelCol = detectBestColumn(['servingcellrsrp', 'servingrsrp', 'rsrp', 'rscp', 'level'], ['active', 'set', 'neighbor']);
        const ecnoCol = detectBestColumn(['servingcellrsrq', 'servingrsrq', 'rsrq', 'ecno', 'sinr'], ['active', 'set', 'neighbor']);
        const freqCol = detectBestColumn(['servingcelldlearfcn', 'earfcn', 'uarfcn', 'freq', 'channel'], ['active', 'set', 'neighbor']);
        const bandCol = detectBestColumn(['band'], ['active', 'set', 'neighbor']);
        // Prioritize "NodeB ID-Cell ID" or "EnodeB ID-Cell ID" for strict sector matching
        const cellIdCol = detectBestColumn(['enodeb id-cell id', 'enodebid-cellid', 'nodeb id-cell id', 'cellid', 'ci', 'cid', 'cell_id', 'identity'], ['active', 'set', 'neighbor', 'target']);

        // Throughput Detection
        const dlThputCol = detectBestColumn(['averagedlthroughput', 'dlthroughput', 'downlinkthroughput'], []);
        const ulThputCol = detectBestColumn(['averageulthroughput', 'ulthroughput', 'uplinkthroughput'], []);

        // Number Parsing Helper (handles comma decimals)
        const parseNumber = (val) => {
            if (typeof val === 'number') return val;
            if (typeof val === 'string') {
                const clean = val.trim().replace(',', '.');
                const f = parseFloat(clean);
                return isNaN(f) ? NaN : f;
            }
            return NaN;
        };

        const points = [];
        const len = json.length;

        // HEURISTIC: Check if detected CellID column is actually PCI (Small Integers)
        // If we found a CellID column but NO SC Column, and values are small (< 1000), swap it.
        if (cellIdCol && !scCol && len > 0) {
            let smallCount = 0;
            let checkLimit = Math.min(len, 20);
            for (let i = 0; i < checkLimit; i++) {
                const val = json[i][cellIdCol];
                const num = parseNumber(val);
                if (!isNaN(num) && num >= 0 && num < 1000) {
                    smallCount++;
                }
            }
            // If majority look like PCIs, treat as PCI
            if (smallCount > (checkLimit * 0.8)) {
                // console.log('[Parser] Swapping CellID column to SC column based on value range.');
                // We treat this column as SC. We can also keep it as ID if we have nothing else? 
                // Using valid PCI as ID isn't great for uniqueness, but better than nothing.
                // Actually, let's just assign it to scCol variable context for the loop
            }
        }

        for (let i = 0; i < len; i++) {
            const row = json[i];
            const lat = parseNumber(row[latKey]);
            const lng = parseNumber(row[lngKey]);
            const time = row[timeKey];

            if (!isNaN(lat) && !isNaN(lng)) {
                // Create Base Point from Best Columns
                const point = {
                    lat: lat,
                    lng: lng,
                    time: time || 'N/A',
                    type: 'MEASUREMENT',
                    level: -999,
                    ecno: 0,
                    sc: 0,
                    rnc: null, // Init RNC
                    cid: null, // Init CID
                    // Use resolved columns directly
                    level: (levelCol && row[levelCol] !== undefined) ? parseNumber(row[levelCol]) : -999,
                    ecno: (ecnoCol && row[ecnoCol] !== undefined) ? parseNumber(row[ecnoCol]) : 0,
                    sc: (scCol && row[scCol] !== undefined) ? parseInt(parseNumber(row[scCol])) : 0,
                    freq: (freqCol && row[freqCol] !== undefined) ? parseNumber(row[freqCol]) : undefined,
                    band: (bandCol && row[bandCol] !== undefined) ? row[bandCol] : undefined,
                    cellId: (cellIdCol && row[cellIdCol] !== undefined) ? row[cellIdCol] : undefined,
                    throughput_dl: (dlThputCol && row[dlThputCol] !== undefined) ? (parseNumber(row[dlThputCol]) * 1000.0) : undefined, // Convert -> Kbps
                    throughput_ul: (ulThputCol && row[ulThputCol] !== undefined) ? (parseNumber(row[ulThputCol]) * 1000.0) : undefined  // Convert -> Kbps
                };

                // Fallback: If SC is 0 and CellID looks like PCI (and no explicit SC col), try to recover
                if (point.sc === 0 && !scCol && point.cellId) {
                    const maybePci = parseNumber(point.cellId);
                    if (!isNaN(maybePci) && maybePci < 1000) {
                        point.sc = parseInt(maybePci);
                    }
                }

                // Parse RNC/CID from CellID if format is "RNC/CID" (e.g., "871/7588")
                if (point.cellId) {
                    const cidStr = String(point.cellId);
                    if (cidStr.includes('/')) {
                        const parts = cidStr.split('/');
                        if (parts.length === 2) {
                            const r = parseInt(parts[0]);
                            const c = parseInt(parts[1]);
                            if (!isNaN(r)) point.rnc = r;
                            if (!isNaN(c)) point.cid = c;
                        }
                    } else {
                        // Check if it's a Big Int (RNC+CID)
                        const val = parseInt(point.cellId);
                        if (!isNaN(val)) {
                            if (val > 65535) {
                                point.rnc = val >> 16;
                                point.cid = val & 0xFFFF;
                            } else {
                                point.cid = val;
                            }
                        }
                    }
                }

                // Add Custom Metrics (keep existing logic for other columns)
                // Also scan for Neighbors (N1..N32) and Detected Set (D1..D12)
                for (let j = 0; j < customMetrics.length; j++) {
                    const m = customMetrics[j];
                    const val = row[m];

                    // Add all proprietary columns to point for popup details
                    if (typeof val !== 'number' && !isNaN(parseFloat(val))) {
                        point[m] = parseFloat(val);
                    } else {
                        point[m] = val;
                    }

                    const normM = normalize(m);

                    // ----------------------------------------------------------------
                    // ACTIVE SET & NEIGHBORS (Enhanced parsing)
                    // ----------------------------------------------------------------

                    // Regex helpers
                    const extractIdx = (str, prefix) => {
                        const matcha = str.match(new RegExp(`${prefix} (\\d +)`));
                        return matcha ? parseInt(matcha[1]) : null;
                    };

                    // Neighbors N1..N8 (Extizing to N32 support)
                    // Matches: "neighborcelldlearfcnn1", "neighborcellidentityn1", "n1_sc" etc.
                    if (normM.includes('n') && (normM.includes('sc') || normM.includes('pci') || normM.includes('identity') || normM.includes('rscp') || normM.includes('rsrp') || normM.includes('ecno') || normM.includes('rsrq') || normM.includes('freq') || normM.includes('earfcn'))) {
                        // Exclude if it looks like primary SC (though mapped above, safe to skip)
                        if (m === scCol) continue;

                        // Flexible Digit Extractor: Matches "n1", "neighbor...n1", "n_1"
                        // Specifically targets the user's "Nx" format at the end of string
                        const digitMatch = normM.match(/n(\d+)/);

                        if (digitMatch) {
                            const idx = parseInt(digitMatch[1]);
                            if (idx >= 1 && idx <= 32) {
                                if (!point._neighborsHelper) point._neighborsHelper = {};
                                if (!point._neighborsHelper[idx]) point._neighborsHelper[idx] = {};

                                // Use parseNumber to handle strings/commas
                                const numVal = parseNumber(val);

                                if (normM.includes('sc') || normM.includes('pci') || normM.includes('identity')) point._neighborsHelper[idx].pci = parseInt(numVal);
                                if (normM.includes('rscp') || normM.includes('rsrp')) point._neighborsHelper[idx].rscp = numVal;
                                if (normM.includes('ecno') || normM.includes('rsrq')) point._neighborsHelper[idx].ecno = numVal;
                                if (normM.includes('freq') || normM.includes('earfcn')) point._neighborsHelper[idx].freq = numVal;
                            }
                        }
                    }

                    // Detected Set D1..D8
                    if (normM.includes('d') && !normM.includes('data') && !normM.includes('band') && (normM.includes('sc') || normM.includes('pci'))) {
                        const digitMatch = normM.match(/d(\d+)/);
                        if (digitMatch) {
                            const idx = parseInt(digitMatch[1]);
                            if (idx >= 1 && idx <= 32) {
                                if (!point._neighborsHelper) point._neighborsHelper = {};
                                const key = 100 + idx;
                                if (!point._neighborsHelper[key]) point._neighborsHelper[key] = { type: 'detected' };

                                const numVal = parseNumber(val);

                                if (normM.includes('sc') || normM.includes('pci')) point._neighborsHelper[key].pci = parseInt(numVal);
                                if (normM.includes('rscp') || normM.includes('rsrp')) point._neighborsHelper[key].rscp = numVal;
                                if (normM.includes('ecno') || normM.includes('rsrq')) point._neighborsHelper[key].ecno = numVal;
                            }
                        }
                    }
                } // End Custom Metrics Loop

                // Construct Neighbors Array from Helper
                const neighbors = [];
                if (point._neighborsHelper) {
                    Object.keys(point._neighborsHelper).sort((a, b) => a - b).forEach(idx => {
                        neighbors.push(point._neighborsHelper[idx]);
                    });
                    delete point._neighborsHelper; // Parsing cleanup
                }

                // Add parsed object for safety if app expects it
                point.parsed = {
                    serving: {
                        level: point.level,
                        ecno: point.ecno,
                        sc: point.sc,
                        freq: point.freq,
                        band: point.band,
                        lac: point.lac || 0 // Default LAC
                    },
                    neighbors: neighbors
                };

                points.push(point);
            } // End if !isNaN
        } // End for i loop

        // Add Computed Metrics to List
        if (dlThputCol) customMetrics.push('throughput_dl');
        if (ulThputCol) customMetrics.push('throughput_ul');

        return {
            points: points,
            tech: '4G (Excel)', // Assume 4G or Generic
            customMetrics: customMetrics.concat(['rrc_rel_cause', 'cs_rel_cause', 'iucs_status']),
            signaling: [], // No signaling in simple excel for now
            debugInfo: {
                scCol: scCol,
                cellIdCol: cellIdCol,
                rncCol: null, // extracted from cellId usually
                levelCol: levelCol
            }
        };
    }
};

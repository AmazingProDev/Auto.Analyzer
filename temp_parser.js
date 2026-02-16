const { analyzeUmtsCallSessions } = require('./nmfCallSession');

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

                        const active = activeCandidates.slice(0, activeSlots);
                        const overflowActive = activeCandidates.slice(activeSlots);
                        for (const n of overflowActive) {
                            if (isInterFreq(n) || hasMonitoredContext) monitored.push(n);
                            else detected.push(n);
                        }

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
                    if (servingFreq !== null && servingFreq >= 10562 && servingFreq <= 10838) servingBand = 'B1 (2100)';
                    else if (servingFreq !== null && servingFreq >= 2937 && servingFreq <= 3088) servingBand = 'B8 (900)';

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

                    if (Number.isFinite(servingLevel) && Number.isFinite(servingEcNo)) {
                        valRssi = servingLevel - servingEcNo;
                    }
                } else if (techId === 7) {
                    // LTE/HSPA+ (Tech 7)
                    servingFreq = parseFloat(parts[8]);
                    servingLevel = parseFloat(parts[12]); // RSRP
                    servingSc = parseInt(parts[10]) || 'N/A'; // PCI
                    servingEcNo = parseFloat(parts[13]); // RSRQ
                    valRssi = parseFloat(parts[11]); // RSSI
                    servingBand = parts[14];
                    activeSetCount = 1;
                    monitoredSetCount = parseInt(parts[6]) || 0;

                    // Neighbors: Robust Scanning (Tech 7)
                    for (let k = 15; k < parts.length - 6; k++) {
                        const type = parseInt(parts[k]);
                        const freq = parseFloat(parts[k + 1]);
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
                        'Freq': servingFreq,
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
                    // Filter out the serving cell entry (duplicates) before labeling
                    const cleanNeighbors = neighbors.filter(n => !n.isServing);

                    cleanNeighbors.forEach((n, idx) => {
                        let prefix = 'd'; // Default Detected
                        let num = 0;

                        if (techId === 5 && typeof n.type === 'string') {
                            const t = String(n.type).trim().toUpperCase();
                            prefix = t.startsWith('A') ? 'a' : (t.startsWith('M') ? 'm' : 'd');
                            const parsedNum = parseInt(t.slice(1), 10);
                            num = Number.isFinite(parsedNum) ? parsedNum : (idx + 1);
                        } else {
                            // Fallback to old counting logic for Tech 7 or other techs
                            const numActiveNeighbors = Math.max(0, activeSetCount - 1);

                            // Active Set Neighbors
                            if (idx < numActiveNeighbors) {
                                prefix = 'a';
                                num = idx + 2; // A2, A3...
                            }
                            // Monitored Set Neighbors
                            else if (idx < (numActiveNeighbors + monitoredSetCount)) {
                                prefix = 'm';
                                num = idx - numActiveNeighbors + 1; // M1, M2...
                            }
                            // Detected Set Neighbors
                            else {
                                prefix = 'd';
                                num = idx - (numActiveNeighbors + monitoredSetCount) + 1; // D1, D2...
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
                // Heuristic for message name
                let message = 'Unknown';
                for (let k = 2; k < parts.length; k++) {
                    const p = parts[k].trim();
                    if (p.length > 5 && !/^\d+$/.test(p)) { message = p; break; }
                }

                allPoints.push({
                    lat: gps ? gps.lat : null, lng: gps ? gps.lng : null,
                    time, type: 'SIGNALING', message, details: line,
                    radioSnapshot: { cellId: state.cid, lac: state.lac, psc: state.psc, rnc: state.rnc, neighbors: currentNeighbors.slice(0, 8) },
                    properties: { 'Time': time, 'Type': 'SIGNALING', 'Message': message }
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
        const umtsCallAnalysis = analyzeUmtsCallSessions(content, { windowSeconds: 10 });

        return {
            points: measurementPoints.concat(eventPoints),
            signaling: signalingPoints,
            events: eventPoints,
            tech: detectedTech,
            config: this.detected1AConfig || null,
            configHistory: this.event1AHistory || [],
            customMetrics: customMetrics, // Dynamic list based on actual file content
            umtsCallAnalysis
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

module.exports = { NMFParser };

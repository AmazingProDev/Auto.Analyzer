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

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line || line.startsWith('#')) continue;
            const parts = line.split(',');
            const header = parts[0];
            const time = parts[1];
            if (!time) continue;

            const state = findLastAt(identityTrack, time) || { cid: 'N/A', rnc: null, lac: 'N/A', psc: null };
            const gps = findLastAt(gpsTrack, time);

            if (header === 'CELLMEAS') {
                if (!gps) continue;
                const techId = parseInt(parts[3]);
                let servingFreq = parseFloat(parts[7]);
                let servingLevel = parseFloat(parts[8]);
                let servingBand = 'Unknown';
                let servingSc = null;
                let servingEcNo = null;
                let neighbors = [];

                if (techId === 5) {
                    // Band Logic
                    if (servingFreq >= 10562 && servingFreq <= 10838) servingBand = 'B1 (2100)';
                    else if (servingFreq >= 2937 && servingFreq <= 3088) servingBand = 'B8 (900)';

                    // Initialize serving SC from identity track if available
                    if (state.psc !== undefined && state.psc !== null) servingSc = state.psc;

                    // Neighbors
                    let nStartIndex = 14;
                    let nBlockSize = 17;
                    for (let j = nStartIndex; j < parts.length; j += nBlockSize) {
                        if (j + 4 >= parts.length) break;
                        const nFreq = parseFloat(parts[j]);
                        const nPci = parseInt(parts[j + 1]);
                        const nEcNo = parseFloat(parts[j + 2]);
                        const nRscp = parseFloat(parts[j + 4]);
                        if (!isNaN(nFreq) && !isNaN(nPci)) {
                            neighbors.push({ freq: nFreq, pci: nPci, ecno: nEcNo, rscp: nRscp });

                            // If this neighbor entry matches our serving freq and SC, capture its metrics
                            if (Math.abs(nFreq - servingFreq) < 1 && (nPci === servingSc || servingSc === null)) {
                                if (servingSc === null) servingSc = nPci;
                                if (servingEcNo === null) servingEcNo = nEcNo;
                                // Do NOT overwrite servingLevel (RSCP) as it comes from the primary header
                            }
                        }
                    }
                    currentNeighbors = neighbors;
                }

                const rnc = state.rnc;
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
                        'Tech': techId === 5 ? 'UMTS' : 'LTE',
                        'Cell ID': state.cid,
                        'RNC': rnc,
                        'CID': cid,
                        'RNC/CID': (rnc !== null && cid !== null) ? `${rnc}/${cid}` : 'N/A',
                        [techId === 5 ? 'Serving RSCP' : 'Serving RSRP']: servingLevel,
                        'Serving SC/PCI': servingSc,
                        [techId === 5 ? 'EcNo' : 'RSRQ']: servingEcNo
                    }
                };
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
            }
        }

        const measurementPoints = allPoints.filter(p => p.type === 'MEASUREMENT');
        const signalingPoints = allPoints.filter(p => p.type === 'SIGNALING');

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

        return { points: measurementPoints, signaling: signalingPoints, tech: detectedTech };
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
        // ROBUST HEADER EXTRACTION: Get headers explicitly, don't rely on json[0] keys
        const headerJson = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
        const keys = (headerJson && headerJson.length > 0) ? headerJson[0].map(k => String(k)) : Object.keys(json[0]);

        const normalize = k => k.toLowerCase().replace(/[\s_]/g, '');

        let timeKey = keys.find(k => /time/i.test(normalize(k)));
        let latKey = keys.find(k => /lat/i.test(normalize(k)));
        let lngKey = keys.find(k => /lon/i.test(normalize(k)) || /lng/i.test(normalize(k)));

        // 2. Identify Metrics (Exclude key columns)
        const customMetrics = keys.filter(k => k !== timeKey && k !== latKey && k !== lngKey);

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
            customMetrics: customMetrics,
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

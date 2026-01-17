const NMFParser = {
    parse(content) {
        const lines = content.split(/\r?\n/);
        let allPoints = []; // Renamed to avoid confusion
        let currentGPS = null;
        let currentLAC = 'N/A';

        // Debug Wrapper for currentCellID
        let _currentCellID = 'N/A';
        // We can't easily use a setter here without an object, but we can log updates
        // Let's manually log where we assign it.
        let currentCellID = 'N/A';
        let currentRNC = null; // New Global RNC Tracker
        const setCellID = (val) => {
            if (val !== currentCellID) {
                // console.log(`[Parser] CellID Changed: ${currentCellID} -> ${val}`);
                currentCellID = val;
            }
        };
        let currentPSC = null;

        const uniqueHeaders = new Set();

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;

            const parts = line.split(',');
            const header = parts[0];
            uniqueHeaders.add(header);

            if (header.startsWith('#')) continue;

            if (header === 'CHI') {
                const tech = parseInt(parts[3]);

                // CHI Parsing Rule based on Technology
                // Tech 5 (3G/UMTS): CHI,Time,,5,PLMN,1,Freq,CellID,LAC,PSC...
                // Tech 7 (4G/LTE):  CHI,Time,,7,PLMN,1,?,?,?,CellID,LAC...

                if (tech === 5) {
                    // Robust search for Cell ID (Large Integer) in Tech 5 CHI line
                    // Standard formats vary: Ind 7, 8, 9, or 10.
                    // We look for a value > 20000 (Safety threshold) to identify a valid RNC-based CellID
                    let foundCid = false;
                    for (let k = 6; k < Math.min(parts.length, 14); k++) {
                        const val = parseInt(parts[k]);
                        if (!isNaN(val) && val > 20000) {
                            currentCellID = val;
                            foundCid = true;
                            // Try to guess LAC as next valid small short
                            if (k + 1 < parts.length) {
                                const nextVal = parseInt(parts[k + 1]);
                                if (!isNaN(nextVal) && nextVal > 0 && nextVal < 65535) currentLAC = nextVal;
                                // Try to guess PSC after LAC (k+2)
                                if (k + 2 < parts.length) {
                                    const pscVal = parseInt(parts[k + 2]);
                                    if (!isNaN(pscVal) && pscVal >= 0 && pscVal <= 511) currentPSC = pscVal;
                                }
                            }
                            break;
                        }
                    }
                    if (!foundCid) {
                        // RNC Search Logic: 
                        for (let k = 6; k < Math.min(parts.length, 14); k++) {
                            const rncCand = parseInt(parts[k]);
                            if (!isNaN(rncCand) && rncCand > 0 && rncCand < 4096) {
                                // Heuristic: Avoid Tech(5), Status(1)
                                if (rncCand > 10) {
                                    currentRNC = rncCand;
                                    // Now look for CID (Small) in this CHI line logic
                                    // CID is usually near RNC.
                                    for (let m = 6; m < Math.min(parts.length, 14); m++) {
                                        if (m === k) continue; // Skip RNC itself
                                        const cidCand = parseInt(parts[m]);
                                        // HEURISTIC REFINEMENT:
                                        // 1. Strict Float Exclusion: metrics like '3.0' or '6.0' are NOT IDs.
                                        if (parts[m].includes('.')) continue;

                                        // 2. Avoid Frequencies (UARFCNs). Frequencies are usually followed by a Level (negative number or float).
                                        if (m + 1 < parts.length) {
                                            const nextVal = parseFloat(parts[m + 1]);
                                            if (!isNaN(nextVal) && (nextVal < 0 || parts[m + 1].includes('.'))) {
                                                continue;
                                            }
                                        }

                                        // 3. Known UARFCN Ranges
                                        if ((cidCand >= 10562 && cidCand <= 10838) ||
                                            (cidCand >= 2937 && cidCand <= 3088) ||
                                            (cidCand > 9000)) {
                                            continue;
                                        }

                                        // CID > 0, < 65535.
                                        if (!isNaN(cidCand) && cidCand > 0 && cidCand < 65535) {
                                            // Heuristic: CID is usually larger than RNC? Not always.
                                            if (cidCand !== 5 && cidCand !== 1) { // Avoid obvious Tech/Status
                                                const synId = (currentRNC << 16) + cidCand;
                                                setCellID(synId);
                                                foundCid = true;

                                                // DEBUG: Trace origin of Weird IDs
                                                if (currentRNC === 320 || cidCand === 3) {
                                                    // console.log(`[Parser DEBUG] Synthesized RNC=${currentRNC} CID=${cidCand} from Indices RNC=${k} CID=${m}`);
                                                    // console.log(`[Parser DEBUG] Parts[m]: "${parts[m]}"`);
                                                }
                                                break;
                                            }
                                        }
                                    }
                                    break;
                                }
                            }
                        }
                    }

                    if (!foundCid) {
                        // Fallback to strict index if search failed (though search covers strict ind 7)
                        if (parts.length >= 8) {
                            const cid = parseInt(parts[7]);
                            if (!isNaN(cid) && cid > 0) currentCellID = cid;
                            const lac = parseInt(parts[8]);
                            if (!isNaN(lac)) currentLAC = lac;
                            // Heuristic: Search for a valid PSC (Integer 0-511, NOT float)
                            // Skip known indices for CellID (7/9) and LAC (8/10)
                            // We look specifically for an integer that doesn't contain '.'
                            for (let k = 9; k < parts.length; k++) {
                                if (parts[k] && !parts[k].includes('.') && parts[k] !== '') {
                                    const candidate = parseInt(parts[k]);
                                    // PSC is usually <= 511. 
                                    // Avoid confusing with other small integers like tech (5) or status (1) or PLMN (50001)
                                    // PSC usually appears around indices 9-12.
                                    if (!isNaN(candidate) && candidate >= 0 && candidate <= 511) {
                                        // Double check it's not the same as a small CellID or LAC (unlikely here as they are large)
                                        // Basic Priority: Index 9, 11, 12... 
                                        // Current Logic: Take the first valid integer found after index 9?
                                        // Or specific index? 
                                        // Let's rely on it being the first "clean" integer > 0? No, SC can be 0.

                                        // Given "3.0" at index 9 was filtered, let's see what's next.
                                        // In the user's log: 3.0, 320, 6.0, 640...
                                        // 320 is valid PSC. 640 is invalid.
                                        // So maybe 320 is the PSC?

                                        // Let's extract valid candidates and log them for now
                                        // But to fix the "3" issue, excluding '.' is the key.
                                        currentPSC = candidate;
                                        // console.log(`[Parser] CHI Found PSC Candidate (Index ${k}): ${candidate}`);
                                        break; // Take first match? 
                                    }
                                }
                            }
                        }
                    }
                } else if (tech === 7) {
                    if (parts.length > 10) {
                        const cid = parseInt(parts[9]);
                        if (!isNaN(cid)) currentCellID = cid;
                        const lac = parseInt(parts[10]);
                        if (!isNaN(lac)) currentLAC = lac;
                    }
                } else {
                    // Fallback / Default
                    if (parts.length > 10) {
                        // Heuristic from before, but likely one of the above matches better
                        const lac = parseInt(parts[10]);
                        if (!isNaN(lac)) currentLAC = lac;
                        const cid = parseInt(parts[8]);
                        if (!isNaN(cid)) currentCellID = cid;
                    }
                }
            } else if (header === 'GPS') {
                if (parts.length > 4) {
                    const lat = parseFloat(parts[4]);
                    const lng = parseFloat(parts[3]);
                    const alt = parseFloat(parts[5]);
                    const speed = parseFloat(parts[8]);

                    if (!isNaN(lat) && !isNaN(lng)) {
                        currentGPS = { lat, lng, alt, speed };
                    }
                }
            } else if (header === 'CELLMEAS') {
                if (!currentGPS) continue;

                // DEBUG: Log CELLMEAS to find PSC (Looking for 288)
                // Only log first few to avoid spam
                // if (Math.random() < 0.01) console.log('[Parser] CELLMEAS Debug:', parts);

                const techId = parseInt(parts[3]);
                let servingFreq = 0;
                let servingLevel = -999;
                let servingBand = 'Unknown';
                let servingSc = null;
                let servingEcNo = null;

                let neighbors = [];
                let nBlockSize = 18;
                let nStartIndex = 14;

                let n1_rscp, n1_ecno, n1_sc;
                let n2_rscp, n2_ecno, n2_sc;
                let n3_rscp, n3_ecno, n3_sc;

                if (techId === 5) {
                    // UMTS
                    servingFreq = parseFloat(parts[7]);
                    servingLevel = parseFloat(parts[8]);

                    // Attempt to parse CellID from CELLMEAS
                    if (parts.length > 12) {
                        const cellIdCandidate = parseInt(parts[12]);

                        // Rule 1: Standard Big Cell ID (RNC+CID combined)
                        if (!isNaN(cellIdCandidate) && cellIdCandidate > 20000) {
                            if (currentCellID !== 'N/A' && currentCellID !== cellIdCandidate) {
                                currentPSC = null;
                            }
                            setCellID(cellIdCandidate);
                            currentRNC = (cellIdCandidate >> 16); // Extract RNC from valid ID
                        }
                        // Rule 2: Split RNC/CID Case (Small CID + Known RNC)
                        else if (!isNaN(cellIdCandidate) && cellIdCandidate > 0 && cellIdCandidate < 65535 && currentRNC > 0) {
                            // Synthesize Full ID
                            const synthesizedID = (currentRNC << 16) + cellIdCandidate;
                            if (currentCellID !== 'N/A' && currentCellID !== synthesizedID) {
                                currentPSC = null;
                            }
                            setCellID(synthesizedID);

                        }
                    }

                    // Removed flaky LAC guessing from CELLMEAS (Indices 11/13 were unreliable)

                    if (servingFreq >= 10562 && servingFreq <= 10838) servingBand = 'B1 (2100)';
                    else if (servingFreq >= 2937 && servingFreq <= 3088) servingBand = 'B8 (900)';
                    else if (servingFreq > 10000) servingBand = 'High Band';
                    else if (servingFreq < 4000) servingBand = 'Low Band';

                    // Use PSC from CHI if available (REVERTED: CHI index 9 is bad)
                    // if (currentPSC !== null) {
                    //    servingSc = currentPSC;
                    // }

                    nStartIndex = 14;
                    nBlockSize = 17;
                    for (let j = nStartIndex; j < parts.length; j += nBlockSize) {
                        if (j + 4 >= parts.length) break;
                        const nFreq = parseFloat(parts[j]);
                        const nPci = parseInt(parts[j + 1]);
                        const nEcNo = parseFloat(parts[j + 2]);
                        const nRscp = parseFloat(parts[j + 4]);

                        if (!isNaN(nFreq) && !isNaN(nPci)) {
                            let nBand = 'Unknown';
                            // Same band logic as serving
                            if (nFreq >= 10562 && nFreq <= 10838) nBand = 'B1 (2100)';
                            else if (nFreq >= 2937 && nFreq <= 3088) nBand = 'B8 (900)';
                            else if (nFreq > 10000) nBand = 'High Band';
                            else if (nFreq < 4000) nBand = 'Low Band';

                            neighbors.push({ freq: nFreq, pci: nPci, ecno: nEcNo, rscp: nRscp, band: nBand });
                            if (Math.abs(nFreq - servingFreq) < 1 && servingSc === null) {
                                servingSc = nPci;
                                servingEcNo = nEcNo;
                            }
                        }
                    }
                    if (neighbors.length > 0 && n1_rscp === undefined) {
                        // Fallback N1 logic will be handled below
                    }
                } else if (techId === 1 || techId === 2) {
                    if (parts.length > 11) {
                        servingFreq = parseFloat(parts[8]);
                        servingLevel = parseFloat(parts[11]);
                    }
                } else {
                    servingFreq = parseFloat(parts[7]);
                    servingLevel = parseFloat(parts[8]);
                }

                if (servingLevel > -20 && servingLevel !== -999) {
                    if (servingLevel > 0) servingLevel = NaN;
                }

                // RELAXED FILTER: If we have a valid Cell ID, keep the point even if level is bad.
                // Only skip if BOTH level is bad AND Cell ID is missing.
                if ((servingLevel === -999 || isNaN(servingLevel)) && (!currentCellID || currentCellID <= 0)) {
                    continue;
                }

                neighbors.sort((a, b) => b.rscp - a.rscp);

                if (neighbors.length > 0) {
                    // Check if Serving SC was found
                    if (servingSc !== null) {
                        // Filter out the serving cell from neighbors to avoid A1 == A2
                        neighbors = neighbors.filter(n => n.pci !== servingSc);
                    }

                    // Re-sort after filtering (just in case)
                    neighbors.sort((a, b) => b.rscp - a.rscp);
                }

                if (neighbors.length > 0) {
                    n1_sc = neighbors[0].pci;
                    n1_rscp = neighbors[0].rscp;
                    n1_ecno = neighbors[0].ecno;
                }
                if (neighbors.length > 1) {
                    n2_sc = neighbors[1].pci;
                    n2_rscp = neighbors[1].rscp;
                    n2_ecno = neighbors[1].ecno;
                }
                if (neighbors.length > 2) {
                    n3_sc = neighbors[2].pci;
                    n3_rscp = neighbors[2].rscp;
                    n3_ecno = neighbors[2].ecno;
                }

                const cellData = {
                    serving: {
                        freq: servingFreq,
                        level: servingLevel,
                        band: servingBand,
                        sc: servingSc,
                        ecno: servingEcNo,
                        lac: currentLAC,
                        cellId: currentCellID
                    },
                    neighbors: neighbors
                };

                const point = {
                    lat: currentGPS.lat,
                    lng: currentGPS.lng,
                    time: parts[1],
                    type: 'MEASUREMENT', // Standardize type
                    level: servingLevel,
                    ecno: servingEcNo,
                    sc: servingSc,
                    freq: servingFreq,
                    cellId: currentCellID,
                    rnc: ((!isNaN(currentCellID) && currentCellID >= 0) ? (currentCellID >> 16) : null),
                    cid: ((!isNaN(currentCellID) && currentCellID >= 0) ? (currentCellID & 0xFFFF) : null),
                    lac: currentLAC,
                    active_set: (() => {
                        let aset = [];
                        // 1. Identify Candidates (Serving + Neighbors in Window)
                        // Note: servingLevel is RSCP for 3G
                        const windowSize = 6;
                        let candidates = [];

                        if (servingSc !== null && servingLevel !== -999 && !isNaN(servingLevel)) {
                            candidates.push({ pci: servingSc, rscp: servingLevel, type: 'S' });
                        }

                        neighbors.forEach(n => {
                            if (Math.abs(n.freq - servingFreq) < 1) { // Only intra-freq
                                if (n.rscp >= servingLevel - windowSize) {
                                    // Avoid duplicates (if neighbor is serving, though parser filters that usually)
                                    if (!candidates.some(c => c.pci === n.pci)) {
                                        candidates.push({ pci: n.pci, rscp: n.rscp, type: 'N' });
                                    }
                                }
                            }
                        });

                        // 2. Sort by RSCP Descending
                        candidates.sort((a, b) => b.rscp - a.rscp);

                        // 3. Extract SCs for the string representation
                        aset = candidates.map(c => c.pci);

                        return aset.join(', ');
                    })(),
                    // A1..A3 Metrics (Sorted Active Set)
                    get a1_sc() {
                        const parts = this.active_set.split(', ');
                        return parts.length > 0 && parts[0] !== '' ? parseInt(parts[0]) : null;
                    },
                    get a1_rscp() {
                        const sc = this.a1_sc;
                        if (sc === null) return null;
                        if (this.sc === sc) return this.level; // Serving
                        // Check neighbors
                        const n = this.parsed.neighbors.find(x => x.pci === sc);
                        return n ? n.rscp : null;
                    },
                    get a2_sc() {
                        const parts = this.active_set.split(', ');
                        return parts.length > 1 ? parseInt(parts[1]) : null;
                    },
                    get a2_rscp() {
                        const sc = this.a2_sc;
                        if (sc === null) return null;
                        if (this.sc === sc) return this.level;
                        const n = this.parsed.neighbors.find(x => x.pci === sc);
                        return n ? n.rscp : null;
                    },
                    get a3_sc() {
                        const parts = this.active_set.split(', ');
                        return parts.length > 2 ? parseInt(parts[2]) : null;
                    },
                    get a3_rscp() {
                        const sc = this.a3_sc;
                        if (sc === null) return null;
                        if (this.sc === sc) return this.level;
                        const n = this.parsed.neighbors.find(x => x.pci === sc);
                        return n ? n.rscp : null;
                    },
                    get a3_rscp() {
                        const sc = this.a3_sc;
                        if (sc === null) return null;
                        if (this.sc === sc) return this.level;
                        const n = this.parsed.neighbors.find(x => x.pci === sc);
                        return n ? n.rscp : null;
                    },
                    n1_sc, n1_rscp, n1_ecno,
                    n2_sc, n2_rscp, n2_ecno,
                    n3_sc, n3_rscp, n3_ecno,
                    details: line,
                    parsed: cellData,
                    properties: { // Standardized Raw Data Container
                        'Time': parts[1],
                        'Type': 'MEASUREMENT',
                        'Tech': techId === 5 ? 'UMTS' : (techId === 7 ? 'LTE' : (techId === 1 || techId === 2 ? 'GSM' : techId)),
                        'Serving Freq': servingFreq,
                        'Serving Band': servingBand,
                        'Serving Level': servingLevel,
                        'Serving Qual': servingEcNo,
                        'Serving SC/PCI': servingSc,
                        'Cell ID': currentCellID,
                        'RNC': ((!isNaN(currentCellID) && currentCellID >= 0) ? (currentCellID >> 16) : null),
                        'CID': ((!isNaN(currentCellID) && currentCellID >= 0) ? (currentCellID & 0xFFFF) : null),
                        'LAC': currentLAC,
                        // Flattened Neighbors (Top 3)
                        'N1 PCI': n1_sc, 'N1 Level': n1_rscp, 'N1 Qual': n1_ecno,
                        'N2 PCI': n2_sc, 'N2 Level': n2_rscp, 'N2 Qual': n2_ecno,
                        'N3 PCI': n3_sc, 'N3 Level': n3_rscp, 'N3 Qual': n3_ecno
                    }
                };

                allPoints.push(point);

            } else if (header.toUpperCase().includes('RRC') || header.toUpperCase().includes('L3') || header.toUpperCase().includes('NAS')) {
                const time = parts[1];
                let direction = '-';
                let message = 'Unknown'; // Initialize message
                let payload = 'N/A'; // Initialize payload

                // Improved Heuristic: Search for the "best" candidate for a message name across ALL parts.
                // We want the longest string that contains letters and is not a common keyword.

                let longestCandidate = '';
                // let bestIndex = -1; // Unused

                for (let k = 2; k < parts.length; k++) {
                    const p = parts[k].trim().replace(/"/g, '');
                    // Skip numeric, empty, or short strings
                    if (!p || p.length < 3 || /^\d+$/.test(p)) continue;

                    // Skip common keywords
                    const up = p.toUpperCase();
                    if (['UL', 'DL', 'UPLINK', 'DOWNLINK', 'UMTS', 'LTE', 'GSM', 'WCDMA'].includes(up)) {
                        if (['UL', 'DL', 'UPLINK', 'DOWNLINK'].includes(up)) direction = p;
                        continue;
                    }

                    // HEX FILTER: If string is purely Hex characters (0-9, A-F), it's likely a raw payload dump.
                    // A valid message name usually contains letters G-Z (e.g. "REQUEST", "Master") or underscores.
                    // Exception: Short hex words could be names, but usually > 8 chars hex is payload.
                    if (/^[0-9A-Fa-f]+$/.test(p) && p.length > 6) {
                        payload = p; // Capture it!
                        continue;
                    }

                    // Prefer strings with underscores (very strong signal for a message name)
                    const hasUnderscore = p.includes('_');
                    const currentHasUnderscore = longestCandidate.includes('_');

                    // If current candidate has underscore and new one doesn't, keep current (unless new is much longer?)
                    // Actually, underscore is a better indicator than length for things like "MEASUREMENT_REPORT" vs "SomeLongGarbageString".

                    if (hasUnderscore && !currentHasUnderscore) {
                        longestCandidate = p;
                    } else if (!hasUnderscore && currentHasUnderscore) {
                        // Keep existing
                    } else {
                        // Both have underscore, or neither. Use length.
                        if (p.length > longestCandidate.length) {
                            longestCandidate = p;
                        }
                    }
                }

                if (longestCandidate) {
                    message = longestCandidate;
                }

                if (message) message = message.replace(/"/g, '');

                // Event Detection Logic
                let eventType = null;
                const mUpper = message.toUpperCase();

                if (mUpper.includes('HANDOVER_FAILURE') ||
                    mUpper.includes('ACTIVE_SET_UPDATE_FAILURE') ||
                    mUpper.includes('PHYSICAL_CHANNEL_RECONFIGURATION_FAILURE') ||
                    (mUpper.includes('FAILURE') && (mUpper.includes('HO') || mUpper.includes('RECONF')))) {
                    eventType = 'HO Fail';
                } else if (mUpper.includes('RADIO_LINK_FAILURE') || mUpper.includes('RLF') || mUpper.includes('DROP')) {
                    eventType = 'Call Drop';
                } else if (mUpper.includes('DISCONNECT') || mUpper.includes('RELEASE_COMPLETE') || mUpper.includes('DEACTIVATE')) {
                    eventType = 'Call Disconnect';
                } else if (mUpper.includes('REJECT') || mUpper.includes('SETUP_FAILURE') || mUpper.includes('CALL_FAIL') || mUpper.includes('ABORT')) {
                    eventType = 'Call Fail';
                }

                allPoints.push({
                    lat: currentGPS ? currentGPS.lat : null,
                    lng: currentGPS ? currentGPS.lng : null,
                    time: time,
                    type: 'SIGNALING',
                    category: (header.toUpperCase().includes('L3') || header.toUpperCase().includes('NAS')) ? 'L3' : 'RRC',
                    direction: direction,
                    message: message,
                    payload: payload,
                    details: line,
                    event: eventType, // New property
                    properties: {
                        'Time': time,
                        'Type': 'SIGNALING',
                        'Category': (header.toUpperCase().includes('L3') || header.toUpperCase().includes('NAS')) ? 'L3' : 'RRC',
                        'Direction': direction,
                        'Message': message,
                        'Event': eventType,
                        'Payload': payload
                    }
                });
            }
        }

        // console.log('--- NMF PARSER DEBUG ---');
        // console.log('Unique Event Headers Found:', Array.from(uniqueHeaders));
        // console.log('Signaling Points Found:', allPoints.filter(p => p.type === 'SIGNALING').length);
        // console.log('------------------------');

        // Split points
        const measurementPoints = allPoints.filter(p => p.type === 'MEASUREMENT');
        const signalingPoints = allPoints.filter(p => p.type === 'SIGNALING');

        // Detect Technology based on measurements
        let detectedTech = 'Unknown';
        if (measurementPoints.length > 0) {
            const sample = measurementPoints.slice(0, 50);
            const freqs = sample.map(p => p.parsed && p.parsed.serving ? parseFloat(p.parsed.serving.freq) : NaN).filter(f => !isNaN(f));
            const is3G = freqs.some(f => (f >= 10500 && f <= 10900) || (f >= 2900 && f <= 3100) || (f >= 4300 && f <= 4500));
            if (is3G) {
                detectedTech = '3G (UMTS)';
            } else {
                const avgFreq = freqs.reduce((a, b) => a + b, 0) / freqs.length;
                if (avgFreq < 1000) detectedTech = '2G (GSM)';
                else if (avgFreq > 120000) detectedTech = '5G (NR)';
                else detectedTech = '4G (LTE)';
            }
            if (freqs.includes(10788)) detectedTech = '3G (WCDMA)';
        }

        return {
            points: measurementPoints,
            signaling: signalingPoints,
            tech: detectedTech
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
                    throughput_ul: (ulThputCol && row[ulThputCol] !== undefined) ? (parseNumber(row[ulThputCol]) * 1000.0) : undefined,  // Convert -> Kbps
                    properties: { ...row } // Populate with raw Excel row data
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
                        // Conventional Short CID
                        point.cid = parseInt(point.cellId);
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

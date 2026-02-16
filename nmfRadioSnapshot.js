function parseNumber(value) {
    if (value === undefined || value === null || value === '') return null;
    const n = Number.parseFloat(String(value).trim());
    return Number.isFinite(n) ? n : null;
}

function median(values) {
    if (!values || values.length === 0) return null;
    const sorted = values.slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function stddev(values) {
    if (!values || values.length < 2) return 0;
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((acc, v) => acc + ((v - mean) ** 2), 0) / values.length;
    return Math.sqrt(variance);
}

function modeNumber(values) {
    if (!Array.isArray(values) || !values.length) return null;
    const counts = new Map();
    let bestValue = null;
    let bestCount = 0;
    for (const value of values) {
        if (!Number.isFinite(value)) continue;
        const next = (counts.get(value) || 0) + 1;
        counts.set(value, next);
        if (next > bestCount) {
            bestCount = next;
            bestValue = value;
        }
    }
    return Number.isFinite(bestValue) ? bestValue : null;
}

function percentile(values, p) {
    if (!values || values.length === 0) return null;
    const sorted = values.slice().sort((a, b) => a - b);
    const idx = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, Math.min(sorted.length - 1, idx))];
}

function getBestServerFromMimo(blocks) {
    const list = Array.isArray(blocks) ? blocks : [];
    return list.reduce((best, c) => {
        if (!c || !Number.isFinite(c.rscp)) return best;
        return (!best || c.rscp > best.rscp) ? c : best;
    }, null);
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

function parseMimoSamples(parts) {
    const start = 7;
    const remaining = parts.length - start;
    if (remaining <= 0) return [];

    let blockSize = 8;
    if (remaining % 8 !== 0) {
        if (remaining % 9 === 0) blockSize = 9;
        else return [];
    }

    const samples = [];
    for (let i = start; i + blockSize - 1 < parts.length; i += blockSize) {
        const cellId = parseNumber(parts[i]);
        const uarfcn = parseNumber(parts[i + 1]);
        const psc = parseNumber(parts[i + 2]);
        const branch = parseNumber(parts[i + 3]);
        const rscp = parseNumber(parts[i + 5]);
        const ecno = parseNumber(parts[i + 6]);
        const rssi = parseNumber(parts[i + 7]);

        if (psc === null || rscp === null || ecno === null) continue;
        samples.push({ psc, branch, rscp, ecno, rssi, cellId, uarfcn });
    }
    return samples;
}

function parseRlcBler(parts) {
    const decimalNums = [];
    for (let i = 4; i < parts.length; i++) {
        const raw = String(parts[i] ?? '').trim();
        if (!raw) continue;
        const n = parseNumber(raw);
        if (n === null || n < 0 || n > 100) continue;
        if (raw.includes('.')) decimalNums.push(n);
    }

    const nums = decimalNums;
    if (nums.length === 0) return null;

    const max = nums.reduce((a, b) => (a > b ? a : b), -Infinity);
    const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
    return { blerMax: max, blerMean: mean, samples: nums };
}

function buildRadioStore() {
    return {
        byDevice: new Map()
    };
}

function getDeviceStore(store, deviceId) {
    const key = String(deviceId || '');
    let dev = store.byDevice.get(key);
    if (!dev) {
        dev = { mimoRows: [], txpcRows: [], rlcRows: [] };
        store.byDevice.set(key, dev);
    }
    return dev;
}

function addRadioRecord(store, header, parts, ts, deviceId) {
    const dev = getDeviceStore(store, deviceId);

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
        if (row) dev.rlcRows.push({ ts, blerMax: row.blerMax, blerMean: row.blerMean, samples: row.samples });
    }
}

function buildSnapshot(store, endTs, windowSeconds = 10, deviceId = '') {
    if (!Number.isFinite(endTs)) return null;

    const dev = store.byDevice.get(String(deviceId || '')) || { mimoRows: [], txpcRows: [], rlcRows: [] };
    const windowMs = Math.max(1, windowSeconds) * 1000;
    const fromTs = endTs - windowMs;

    const snapshot = {
        windowStartTs: fromTs,
        windowEndTs: endTs,
        mimoSampleCount: 0,
        txSampleCountValid: 0,
        blerRowCount: 0,
        sampleCount: 0,
        trendMinSamples: 2,
        rscpMedian: null,
        rscpMin: null,
        rscpLast: null,
        ecnoMedian: null,
        ecnoMin: null,
        ecnoLast: null,
        lastPsc: null,
        lastCellId: null,
        lastUarfcn: null,
        lastMimoTs: null,
        lastTxTs: null,
        lastBestServer: null,
        txP90: null,
        txMax: null,
        txLast: null,
        blerMax: null,
        blerMean: null,
        rlcBlerSamplesCount: 0,
        blerEvidenceMinSamples: 3,
        blerEvidence: false,
        bestServerSamples: [],
        uniquePscCount: 0,
        txSamples: [],
        txSeries: [],
        blerRows: [],
        seriesRscp: [],
        seriesEcno: [],
        rscpTrendDelta: null,
        ecnoTrendDelta: null,
        trendDurationSec: null
    };
    snapshot.pilotDominanceDeltaMedian = null;
    snapshot.pilotDominanceLowCount = 0;
    snapshot.pilotDominanceSampleCount = 0;
    snapshot.pilotDominanceLowRatio = null;
    snapshot.pilotDominanceDeltaStd = null;
    snapshot.activeSetSizeMean = null;
    snapshot.activeSetSizeMax = null;
    snapshot.badEcnoStrongRscpRatio = null;
    snapshot.strongBadCount = 0;
    snapshot.validBestCount = 0;
    snapshot.pscSwitchCount = 0;
    snapshot.pollutionScore = null;
    snapshot.pollutionLevel = null;
    snapshot.pilotPollution = null;
    snapshot.pilotPollutionDetected = null; // backward compatibility
    snapshot.pilotPollutionEvidence = [];

    const mimoFrom = lowerBound(dev.mimoRows, fromTs);
    const mimoTo = upperBound(dev.mimoRows, endTs);
    const dominanceDeltas = [];
    const activeSetSizes = [];

    for (let i = mimoFrom; i < mimoTo; i++) {
        const row = dev.mimoRows[i];
        const byPsc = new Map();

        for (const s of row.samples) {
            const key = String(s.psc);
            const agg = byPsc.get(key) || {
                psc: s.psc,
                rscpSum: 0,
                ecnoSum: 0,
                rssiSum: 0,
                rssiCount: 0,
                count: 0,
                cellId: s.cellId,
                uarfcn: s.uarfcn
            };
            agg.rscpSum += s.rscp;
            agg.ecnoSum += s.ecno;
            if (Number.isFinite(s.rssi)) {
                agg.rssiSum += s.rssi;
                agg.rssiCount += 1;
            }
            agg.count += 1;
            if (agg.cellId === null && s.cellId !== null) agg.cellId = s.cellId;
            if (agg.uarfcn === null && s.uarfcn !== null) agg.uarfcn = s.uarfcn;
            byPsc.set(key, agg);
        }

        const blocks = [];
        for (const agg of byPsc.values()) {
            const avgRscp = agg.rscpSum / agg.count;
            const avgEcno = agg.ecnoSum / agg.count;
            blocks.push({
                ts: row.ts,
                psc: agg.psc,
                rscp: avgRscp,
                ecno: avgEcno,
                rssi: agg.rssiCount > 0 ? (agg.rssiSum / agg.rssiCount) : null,
                cellId: agg.cellId,
                uarfcn: agg.uarfcn
            });
        }
        if (blocks.length) activeSetSizes.push(blocks.length);
        if (blocks.length >= 2) {
            const sorted = blocks.slice().sort((a, b) => b.rscp - a.rscp);
            const delta = sorted[0].rscp - sorted[1].rscp;
            if (Number.isFinite(delta)) dominanceDeltas.push(delta);
        }
        const best = getBestServerFromMimo(blocks);

        if (best) snapshot.bestServerSamples.push(best);
    }

    if (snapshot.bestServerSamples.length) {
        const rscpVals = snapshot.bestServerSamples.map(v => v.rscp);
        const ecnoVals = snapshot.bestServerSamples.map(v => v.ecno);
        const last = snapshot.bestServerSamples[snapshot.bestServerSamples.length - 1];
        snapshot.uniquePscCount = new Set(snapshot.bestServerSamples.map(v => String(v.psc))).size;

        snapshot.rscpMedian = median(rscpVals);
        snapshot.rscpMin = Math.min(...rscpVals);
        snapshot.rscpLast = last.rscp;
        snapshot.ecnoMedian = median(ecnoVals);
        snapshot.ecnoMin = Math.min(...ecnoVals);
        snapshot.ecnoLast = last.ecno;
        snapshot.lastPsc = last.psc;
        snapshot.lastCellId = last.cellId;
        snapshot.lastUarfcn = last.uarfcn;
        snapshot.lastMimoTs = last.ts;
        snapshot.lastBestServer = {
            psc: last.psc,
            uarfcn: last.uarfcn,
            cellId: last.cellId,
            rscp: last.rscp,
            ecno: last.ecno,
            rssi: Number.isFinite(last.rssi) ? last.rssi : null
        };
        snapshot.seriesRscp = snapshot.bestServerSamples.map(v => ({ ts: v.ts, value: v.rscp }));
        snapshot.seriesEcno = snapshot.bestServerSamples.map(v => ({ ts: v.ts, value: v.ecno }));
        const validBest = snapshot.bestServerSamples.filter(v => Number.isFinite(v.rscp) && Number.isFinite(v.ecno));
        const validBestCount = validBest.length;
        const strongRscpCount = validBest.filter(v => v.rscp > -85).length;
        const strongBadCount = validBest.filter(v => v.rscp > -85 && v.ecno < -14).length;
        snapshot.validBestCount = validBestCount;
        snapshot.strongBadCount = strongBadCount;
        snapshot.badEcnoStrongRscpRatio = strongRscpCount ? (strongBadCount / strongRscpCount) : null;
        let switches = 0;
        for (let i = 1; i < snapshot.bestServerSamples.length; i++) {
            if (snapshot.bestServerSamples[i].psc !== snapshot.bestServerSamples[i - 1].psc) switches += 1;
        }
        snapshot.pscSwitchCount = switches;
    }
    if (dominanceDeltas.length) {
        snapshot.pilotDominanceSampleCount = dominanceDeltas.length;
        snapshot.pilotDominanceDeltaMedian = median(dominanceDeltas);
        snapshot.pilotDominanceDeltaStd = stddev(dominanceDeltas);
        snapshot.pilotDominanceLowCount = dominanceDeltas.filter(d => Number.isFinite(d) && d < 3).length;
        snapshot.pilotDominanceLowRatio = snapshot.pilotDominanceLowCount / dominanceDeltas.length;
    }
    if (activeSetSizes.length) {
        snapshot.activeSetSizeMean = activeSetSizes.reduce((a, b) => a + b, 0) / activeSetSizes.length;
        snapshot.activeSetSizeMax = Math.max(...activeSetSizes);
    }
    // Preload TX/BLER so interference scoring can use finalized metrics.
    const preTxFrom = lowerBound(dev.txpcRows, fromTs);
    const preTxTo = upperBound(dev.txpcRows, endTs);
    if (preTxTo > preTxFrom) {
        const txValues = dev.txpcRows.slice(preTxFrom, preTxTo).map(v => v.tx).filter(v => Number.isFinite(v));
        if (txValues.length) {
            snapshot.txP90 = percentile(txValues, 90);
            snapshot.txMax = Math.max(...txValues);
            snapshot.txLast = txValues[txValues.length - 1];
        }
    }
    const preRlcFrom = lowerBound(dev.rlcRows, fromTs);
    const preRlcTo = upperBound(dev.rlcRows, endTs);
    if (preRlcTo > preRlcFrom) {
        const blerRows = dev.rlcRows.slice(preRlcFrom, preRlcTo);
        snapshot.blerMax = blerRows.reduce((m, r) => (r.blerMax > m ? r.blerMax : m), -Infinity);
        snapshot.blerMean = blerRows.reduce((sum, r) => sum + r.blerMean, 0) / blerRows.length;
    }
    const deltaMedianRaw = Number.isFinite(snapshot.pilotDominanceDeltaMedian) ? snapshot.pilotDominanceDeltaMedian : null;
    const deltaRatioRaw = Number.isFinite(snapshot.pilotDominanceLowRatio) ? snapshot.pilotDominanceLowRatio : null;
    const deltaStdRaw = Number.isFinite(snapshot.pilotDominanceDeltaStd) ? snapshot.pilotDominanceDeltaStd : null;
    const pscSwitchCount = Number.isFinite(snapshot.pscSwitchCount) ? snapshot.pscSwitchCount : 0;
    const activeSetMean = Number.isFinite(snapshot.activeSetSizeMean) ? snapshot.activeSetSizeMean : 0;
    const activeSetMax = Number.isFinite(snapshot.activeSetSizeMax) ? snapshot.activeSetSizeMax : 0;
    const totalMimoSamples = snapshot.bestServerSamples.length;
    const samplesWith2Pilots = dominanceDeltas.length;
    const deltaCoverageRatio = totalMimoSamples > 0 ? (samplesWith2Pilots / totalMimoSamples) : null;
    const deltaLowConfidence = !Number.isFinite(deltaCoverageRatio) || deltaCoverageRatio < 0.30;
    const validBest = snapshot.bestServerSamples.filter(v => Number.isFinite(v.rscp) && Number.isFinite(v.ecno));
    const validBestCount = Number.isFinite(snapshot.validBestCount) ? snapshot.validBestCount : validBest.length;
    const strongBadCount = Number.isFinite(snapshot.strongBadCount) ? snapshot.strongBadCount : validBest.filter(v => v.rscp > -85 && v.ecno < -14).length;
    const bestPsc = modeNumber(snapshot.bestServerSamples.map(v => v.psc));
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
    if (Number.isFinite(snapshot.blerMax) && snapshot.blerMax >= 80) interferenceScore += 40;
    if (Number.isFinite(snapshot.ecnoMedian) && snapshot.ecnoMedian <= -12) interferenceScore += 30;
    if (Number.isFinite(snapshot.rscpMedian) && snapshot.rscpMedian >= -90) interferenceScore += 20;
    if (Number.isFinite(snapshot.txP90) && snapshot.txP90 <= 18) interferenceScore += 10;
    interferenceScore = Math.max(0, Math.min(100, interferenceScore));

    const dominanceLevel = dominanceAvailable ? levelFromScore(dominanceScore) : 'N/A';
    const interferenceLevel = levelFromScore(interferenceScore);
    let finalLabel = 'Low overlap risk';
    let finalScore = dominanceAvailable ? dominanceScore : interferenceScore;
    let finalLevel = dominanceAvailable ? dominanceLevel : interferenceLevel;
    const explicitDlInterferenceSignature = Number.isFinite(snapshot.blerMax) && snapshot.blerMax >= 80 &&
        Number.isFinite(snapshot.rscpMedian) && snapshot.rscpMedian >= -90 &&
        Number.isFinite(snapshot.txP90) && snapshot.txP90 <= 18;
    if (interferenceScore >= 60 && ((Number.isFinite(strongRscpShare) && strongRscpShare >= 0.30) || explicitDlInterferenceSignature)) {
        finalLabel = hasStrongDominanceEvidence ? 'Pilot Pollution / DL Interference' : 'DL Interference (dominance evidence unavailable)';
        finalScore = interferenceScore;
        finalLevel = interferenceLevel;
    } else if (hasStrongDominanceEvidence && dominanceScore >= 60 && Number.isFinite(strongRscpShare) && strongRscpShare < 0.30) {
        finalLabel = 'High overlap / poor dominance under weak coverage';
        finalScore = dominanceScore;
        finalLevel = dominanceLevel;
    } else if (hasStrongDominanceEvidence && dominanceScore >= 35) {
        finalLabel = 'Overlap risk';
        finalScore = dominanceScore;
        finalLevel = dominanceLevel;
    } else if (!hasStrongDominanceEvidence && interferenceScore < 60) {
        finalLabel = 'Dominance unavailable / low interference risk';
        finalScore = interferenceScore;
        finalLevel = interferenceLevel;
    }

    snapshot.pollutionScore = finalScore; // backward compatibility
    snapshot.pollutionLevel = dominanceAvailable ? finalLevel : 'N/A'; // backward compatibility
    const countBelow3 = Number.isFinite(snapshot.pilotDominanceLowCount) ? snapshot.pilotDominanceLowCount : 0;
    const deltaMedianText = samplesWith2Pilots > 0 && deltaMedian !== null ? `${deltaMedian.toFixed(2)} dB` : 'n/a';
    const deltaStdText = samplesWith2Pilots > 0 && Number.isFinite(deltaStd) ? `${deltaStd.toFixed(2)} dB` : 'n/a';
    const deltaRatioPct = (samplesWith2Pilots > 0 && Number.isFinite(deltaRatio)) ? (deltaRatio * 100).toFixed(0) : 'n/a';
    const deltaRatioDen = samplesWith2Pilots > 0 ? `${countBelow3}/${samplesWith2Pilots}` : '0/0';
    const strongSharePct = validBestCount > 0 && Number.isFinite(ratioStrongShare) ? (ratioStrongShare * 100).toFixed(0) : 'n/a';
    const strongBadPct = strongRscpCount > 0 && Number.isFinite(ratioBad) ? (ratioBad * 100).toFixed(0) : 'n/a';
    const detailsText = [
        `Window: ${Math.max(1, windowSeconds)}s before end. MIMOMEAS samples: ${totalMimoSamples}.`,
        `Final classification: ${finalLabel} (${finalLevel}, ${finalScore}/100).`,
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
    snapshot.pilotPollution = {
        riskLevel: dominanceAvailable ? snapshot.pollutionLevel : 'N/A',
        score: finalScore,
        pollutionScore: finalScore,
        pollutionLevel: snapshot.pollutionLevel,
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
    snapshot.pilotPollutionDetected = finalScore >= 35;
    snapshot.pilotPollutionEvidence = [
        `Final=${finalLabel} (${finalLevel}, ${finalScore}/100), dominance=${dominanceScore}/100, interference=${interferenceScore}/100`,
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
        snapshot.txSamples = dev.txpcRows.slice(txFrom, txTo).map(v => v.tx).filter(v => Number.isFinite(v));
        snapshot.txSeries = dev.txpcRows.slice(txFrom, txTo)
            .filter(v => Number.isFinite(v.tx))
            .map(v => ({ ts: v.ts, value: v.tx }));
        snapshot.txSampleCountValid = snapshot.txSamples.length;
        if (snapshot.txSamples.length) {
            snapshot.txP90 = percentile(snapshot.txSamples, 90);
            snapshot.txMax = Math.max(...snapshot.txSamples);
            snapshot.txLast = snapshot.txSamples[snapshot.txSamples.length - 1];
            snapshot.lastTxTs = snapshot.txSeries[snapshot.txSeries.length - 1]?.ts ?? null;
        }
    }

    const rlcFrom = lowerBound(dev.rlcRows, fromTs);
    const rlcTo = upperBound(dev.rlcRows, endTs);
    if (rlcTo > rlcFrom) {
        snapshot.blerRows = dev.rlcRows.slice(rlcFrom, rlcTo);
        snapshot.blerRowCount = snapshot.blerRows.length;
        snapshot.rlcBlerSamplesCount = snapshot.blerRowCount;
        snapshot.blerMax = snapshot.blerRows.reduce((m, r) => (r.blerMax > m ? r.blerMax : m), -Infinity);
        snapshot.blerMean = snapshot.blerRows.reduce((sum, r) => sum + r.blerMean, 0) / snapshot.blerRows.length;
    }
    snapshot.blerEvidence = Number.isFinite(snapshot.rlcBlerSamplesCount) && snapshot.rlcBlerSamplesCount >= snapshot.blerEvidenceMinSamples;

    snapshot.mimoSampleCount = snapshot.bestServerSamples.length;
    snapshot.sampleCount = snapshot.bestServerSamples.length;
    if (snapshot.bestServerSamples.length >= 2) {
        const first = snapshot.bestServerSamples[0];
        const last = snapshot.bestServerSamples[snapshot.bestServerSamples.length - 1];
        snapshot.rscpTrendDelta = last.rscp - first.rscp;
        snapshot.ecnoTrendDelta = last.ecno - first.ecno;
        snapshot.trendDurationSec = Math.max(0.001, (last.ts - first.ts) / 1000);
    }
    snapshot.trendMessage = snapshot.mimoSampleCount === 0
        ? 'No MIMOMEAS samples in last 10s.'
        : (snapshot.mimoSampleCount < snapshot.trendMinSamples
            ? `Only ${snapshot.mimoSampleCount} MIMOMEAS samples in last 10s — trend not computed.`
            : `Trend computed from ${snapshot.mimoSampleCount} MIMOMEAS samples in last 10s.`);

    return snapshot;
}

module.exports = {
    buildRadioStore,
    addRadioRecord,
    buildSnapshot,
    parseNumber,
    median,
    percentile
};

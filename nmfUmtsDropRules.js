function clamp01(v) {
    if (v < 0) return 0;
    if (v > 1) return 1;
    return v;
}

function hasNum(v) {
    return Number.isFinite(v);
}

function mk(resultType, category, domain, reason, confidence, evidence, snapshot) {
    return {
        resultType,
        category,
        domain,
        confidence: clamp01(confidence),
        reason,
        evidence,
        snapshot
    };
}

function fmtNum(v, unit, decimals = 1) {
    if (!Number.isFinite(v)) return null;
    return `${v.toFixed(decimals)}${unit ? ` ${unit}` : ''}`;
}

function decodeCadCause(cause) {
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
}

function buildRadioEvaluation(snapshot, category, domain, session) {
    const rscp = snapshot?.rscpMedian;
    const ecno = snapshot?.ecnoMedian;
    const tx = snapshot?.txP90;
    const bler = snapshot?.blerMax;
    const blerEvidence = snapshot?.blerEvidence === true;
    const rlcBlerSamplesCount = Number.isFinite(snapshot?.rlcBlerSamplesCount) ? snapshot.rlcBlerSamplesCount : 0;

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
        else parts.push('BLER evidence was expected but BLER value is unavailable.');
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
    if (Number.isFinite(rlcBlerSamplesCount) && rlcBlerSamplesCount > 0 && rlcBlerSamplesCount < 3) {
        parts.push(`RLC BLER sample count is low (${rlcBlerSamplesCount}), so BLER confidence is limited.`);
    }
    return parts.join(' ');
}

function metricBullet(label, valueText) {
    if (!valueText) return null;
    return `${label}: ${valueText}`;
}

function findLastHoDeltaSec(session) {
    const endTs = Number.isFinite(session?.endTsReal) ? session.endTsReal : null;
    if (!endTs || !Array.isArray(session?.eventTimeline)) return null;
    const ho = session.eventTimeline
        .filter(e => {
            const txt = `${e?.event || ''} ${e?.details || ''}`.toUpperCase();
            return txt.includes('HO') || txt.includes('HANDOVER') || txt.includes('SHO');
        })
        .map(e => Number.isFinite(e?.ts) ? e.ts : Date.parse(e?.time || ''))
        .filter(ts => Number.isFinite(ts) && ts <= endTs)
        .sort((a, b) => a - b);
    if (!ho.length) return null;
    return (endTs - ho[ho.length - 1]) / 1000;
}

function sortRecommendations(items) {
    const rank = { P0: 0, P1: 1, P2: 2 };
    return (items || []).slice().sort((a, b) => (rank[a?.priority] ?? 9) - (rank[b?.priority] ?? 9));
}

const ACTION_ID_ALIASES = {
    SOLVE_INTERFERENCE_UNDER_STRONG_SIGNAL: 'SOLVE_INTERFERENCE_STRONG_SIGNAL'
};

function canonicalActionId(actionId) {
    const id = String(actionId || '').trim().toUpperCase();
    return ACTION_ID_ALIASES[id] || id;
}

function metricRangeFromSeries(series, fallbackMin, fallbackMax) {
    const vals = Array.isArray(series) ? series.map(v => Number(v?.value)).filter(Number.isFinite) : [];
    if (vals.length) return { min: Math.min(...vals), max: Math.max(...vals) };
    const min = Number.isFinite(fallbackMin) ? fallbackMin : null;
    const max = Number.isFinite(fallbackMax) ? fallbackMax : null;
    return { min, max };
}

function buildInterferenceStrongSignalDetails(session, snapshot) {
    const rscpRange = metricRangeFromSeries(snapshot?.seriesRscp, snapshot?.rscpMin, snapshot?.rscpLast);
    const ecnoRange = metricRangeFromSeries(snapshot?.seriesEcno, snapshot?.ecnoMin, snapshot?.ecnoLast);
    const pp = snapshot?.pilotPollution || {};
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
        `- RSCP (min/median/max): ${fmt(rscpRange.min)} / ${fmt(snapshot?.rscpMedian)} / ${fmt(rscpRange.max)} dBm`,
        `- EcNo (min/median/max): ${fmt(ecnoRange.min)} / ${fmt(snapshot?.ecnoMedian)} / ${fmt(ecnoRange.max)} dB`,
        `- BLER max: ${fmt(snapshot?.blerMax)} %`,
        `- UE Tx p90: ${fmt(snapshot?.txP90)} dBm`,
        `- Strong RSCP share (> -85 dBm): ${strongSharePct}% (${strongCount}/${validBest})`,
        `- Strong RSCP+bad EcNo ratio: ${strongBadPct}% (${strongBadCount}/${strongCount})`,
        `- ${deltaLine}`,
        `- Strong RSCP+bad EcNo computed on ${strongBadCount}/${validBest || totalMimo} best-server samples.`,
        ...(deltaUnavailable ? [`- ${deltaUnavailable}`] : []),
        `- Best-server denominator: ${validBest}/${totalMimo}`
    ].join('\n');
}

function buildRecommendations(resultType, category, session, snapshot) {
    const byCategory = {
        DROP_INTERFERENCE: [
            { priority: 'P0', actionId: 'RESOLVE_PILOT_POLLUTION', action: 'Resolve Pilot Pollution', rationale: 'Pilot Pollution risk is high; apply overlap/dominance remediation to stabilize serving behavior.', ownerHint: 'RAN Optimization' },
            { priority: 'P0', actionId: 'VALIDATE_PILOT_DOMINANCE_DROP_CLUSTER', action: 'Validate pilot dominance in drop cluster (ΔRSCP(best-2nd)<3 dB, active set size >=3, CPICH review).', rationale: 'Weak serving dominance and large active set indicate pilot pollution risk in interference drops.', ownerHint: 'RAN Optimization' },
            { priority: 'P0', actionId: 'AUDIT_PILOT_POLLUTION_SHO', action: 'Audit pilot pollution and dominance in the drop area (top pilots, active-set churn, SHO behavior).', rationale: 'Strong RSCP with poor quality/BLER is a classic interference signature.', ownerHint: 'Optimization' },
            { priority: 'P0', actionId: 'CHECK_INTERFERENCE_SOURCES', action: 'Validate external/internal interference sources around the affected cell sector and time bucket.', rationale: 'Interference is often location/time-specific and repeatable.', ownerHint: 'Field' },
            { priority: 'P1', actionId: 'VERIFY_DL_QUALITY_KPIS', action: 'Review DL quality KPIs (EcNo distribution, BLER, SHO failures) per serving/neighbor cells.', rationale: 'Confirms whether interference is persistent and cell-specific.', ownerHint: 'RAN' },
            { priority: 'P2', actionId: 'REPEAT_DRIVE_TEST_POST_CHANGE', action: 'Repeat drive test after optimization changes to verify drop-rate improvement.', rationale: 'Closes the loop with objective post-change validation.', ownerHint: 'Optimization' }
        ],
        DROP_COVERAGE_UL: [
            { priority: 'P0', actionId: 'INVEST_UL_TX_SAT_ZONES', action: 'Investigate uplink coverage limits and UE Tx saturation zones.', rationale: 'High UE Tx near max indicates UL-limited coverage; cluster these zones to target RAN fixes.', ownerHint: 'RAN' },
            { priority: 'P1', actionId: 'OPT_NEIGHBOR_LAYER_WEAK_COVERAGE', action: 'Optimize neighbor/layer fallback strategy (including IRAT where applicable).', rationale: 'Improves call robustness at cell edge.', ownerHint: 'Optimization' },
            { priority: 'P2', actionId: 'PLAN_COVERAGE_DENSIFICATION', action: 'Evaluate coverage expansion/densification in repeated weak-UL zones.', rationale: 'Persistent edge drops may require structural coverage improvement.', ownerHint: 'Optimization' }
        ],
        DROP_COVERAGE_DL: [
            { priority: 'P0', actionId: 'CHECK_DL_COVERAGE_AZIMUTH_TILT', action: 'Investigate DL coverage weakness (RSCP/EcNo), including tilt, azimuth, and overshooting sectors.', rationale: 'Very weak downlink quality directly drives call drops.', ownerHint: 'RAN' },
            { priority: 'P1', actionId: 'TUNE_NEIGHBOR_SHO_PARAMETERS', action: 'Tune neighbor relations and SHO parameters for smoother serving transition.', rationale: 'Coverage holes are amplified by mobility misalignment.', ownerHint: 'Optimization' },
            { priority: 'P2', actionId: 'FIELD_VERIFY_DROP_GEOGRAPHY', action: 'Plan targeted field verification across the repeated drop geography.', rationale: 'Confirms spatial persistence and validates remediation impact.', ownerHint: 'Field' }
        ],
        DROP_MOBILITY: [
            { priority: 'P0', action: 'Audit missing/wrong neighbors and HO priorities between serving and candidate cells.', rationale: 'Mobility defects cause abrupt radio release after HO attempts.', ownerHint: 'Optimization' },
            { priority: 'P0', action: 'Retune HO thresholds, hysteresis, and TTT to reduce ping-pong and late HO.', rationale: 'Threshold misconfiguration is a major mobility-drop driver.', ownerHint: 'Optimization' },
            { priority: 'P1', action: 'Validate IFHO/IRAT handover configuration and target-layer readiness.', rationale: 'Cross-layer mobility failures often surface as drops.', ownerHint: 'RAN' }
        ],
        DROP_CONGESTION: [
            { priority: 'P0', action: 'Check admission/code/power utilization at drop timestamps and busy-hour overlap.', rationale: 'Resource saturation can trigger abnormal release.', ownerHint: 'RAN' },
            { priority: 'P1', action: 'Apply load balancing/capacity tuning on overloaded sectors.', rationale: 'Reduces resource-driven call terminations.', ownerHint: 'Optimization' },
            { priority: 'P2', action: 'Enable tighter congestion monitoring thresholds and alerts.', rationale: 'Prevents recurrence through proactive control.', ownerHint: 'Optimization' }
        ],
        DROP_CORE_TRANSPORT: [
            { priority: 'P0', action: 'Check Iub/Iu transport stability and correlate link resets/alarms at drop time.', rationale: 'Transport instability can terminate otherwise healthy calls.', ownerHint: 'Transport' },
            { priority: 'P1', action: 'Analyze core release causes with MSC/RNC traces for matching sessions.', rationale: 'Validates network-side release origin.', ownerHint: 'Core' },
            { priority: 'P2', action: 'Improve resiliency and alarming on affected path elements.', rationale: 'Reduces impact of transient transport/core faults.', ownerHint: 'Transport' }
        ],
        DROP_UNKNOWN: [
            { priority: 'P0', actionId: 'CAPTURE_EVIDENCE_BUNDLE', action: 'Capture full evidence bundle (last 50 events + last 10s radio series) for clustered drops.', rationale: 'Unknown drops need richer context to isolate root cause.', ownerHint: 'Optimization' },
            { priority: 'P1', actionId: 'EXPAND_PARSER_RELEASE_CAUSES', action: 'Expand parser coverage for missing release causes and signaling markers.', rationale: 'Classification quality depends on signaling completeness.', ownerHint: 'RAN' },
            { priority: 'P2', actionId: 'REFINE_RULE_THRESHOLDS', action: 'Refine rule thresholds after additional labeled samples.', rationale: 'Improves deterministic category precision.', ownerHint: 'Optimization' }
        ],
        SETUP_TIMEOUT: [
            { priority: 'P0', actionId: 'TRACE_SETUP_TIMEOUT_PATH', action: 'Trace setup timer expiry path (CAD cause 102) across RNC/core signaling.', rationale: 'Timer expiry indicates control-plane setup did not complete in time.', ownerHint: 'Core' },
            { priority: 'P1', actionId: 'CHECK_SIGNALING_LATENCY_RETX', action: 'Check signaling latency spikes and retransmission counters around failure time.', rationale: 'Excessive signaling delay commonly causes setup timeout.', ownerHint: 'Transport' }
        ],
        SETUP_FAIL_UL_COVERAGE: [
            { priority: 'P0', actionId: 'INVEST_UL_TX_SAT_ZONES', action: 'Investigate uplink coverage limits and UE Tx saturation zones.', rationale: 'High UE Tx near max indicates UL-limited coverage; cluster these zones to target RAN fixes.', ownerHint: 'RAN' },
            { priority: 'P1', actionId: 'OPT_NEIGHBOR_LAYER_WEAK_COVERAGE', action: 'Tune neighbor/layer reselection options in weak-coverage areas.', rationale: 'Improves setup success probability at edge locations.', ownerHint: 'Optimization' }
        ],
        SETUP_FAIL_DL_INTERFERENCE: [
            { priority: 'P0', actionId: 'SOLVE_INTERFERENCE_STRONG_SIGNAL', action: 'Solve interference-under-strong-signal.', rationale: 'BLER high under acceptable RSCP with low UL Tx indicates downlink interference/noise-rise decode impairment.', ownerHint: 'RAN Optimization' },
            { priority: 'P1', actionId: 'COLLECT_DOMINANCE_CONTEXT', action: 'Collect additional dominance context (CELLMEAS neighbors + >=2 pilot availability).', rationale: 'When overlap is not measurable, multi-pilot evidence is required before dominance remediation.', ownerHint: 'Optimization' },
            { priority: 'P1', actionId: 'VERIFY_DL_QUALITY_KPIS', action: 'Review EcNo/BLER distributions on serving/overlapping cells for persistent impairment.', rationale: 'Confirms whether issue is local and recurrent.', ownerHint: 'RAN' },
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
        ],
        SETUP_FAIL_UNKNOWN: [
            { priority: 'P0', actionId: 'CAPTURE_EVIDENCE_BUNDLE', action: 'Collect expanded signaling/radio context for failed setup attempts.', rationale: 'Unknown setup failures need richer cause visibility.', ownerHint: 'Optimization' },
            { priority: 'P1', actionId: 'EXPAND_PARSER_RELEASE_CAUSES', action: 'Add missing parser hooks for release/reject causes if available in logs.', rationale: 'Improves deterministic setup-failure attribution.', ownerHint: 'RAN' }
        ]
    };
    const fallback = resultType === 'DROP_CALL'
        ? byCategory.DROP_UNKNOWN
        : (resultType === 'CALL_SETUP_FAILURE' ? byCategory.SETUP_FAIL_UNKNOWN : []);
    const recs = byCategory[category] || fallback;
    const limited = recs.slice(0, 4).map((rec) => {
        const next = { ...rec };
        const canon = canonicalActionId(next.actionId || '');
        if (canon) next.actionId = canon;
        if (canon === 'SOLVE_INTERFERENCE_STRONG_SIGNAL') {
            next.title = 'Solve interference-under-strong-signal';
            next.detailsText = buildInterferenceStrongSignalDetails(session, snapshot);
        }
        return next;
    });
    return sortRecommendations(limited);
}

function buildNarrative(session, cls, snapshot) {
    const resultType = cls?.resultType;
    const category = cls?.category || 'UNKNOWN';
    const confidencePct = Math.round((Number(cls?.confidence) || 0) * 100);
    const why = [];
    if (Array.isArray(cls?.evidence)) {
        cls.evidence.filter(Boolean).forEach(e => why.push(String(e)));
    }
    const rscpTxt = fmtNum(snapshot?.rscpMedian, 'dBm');
    const ecnoTxt = fmtNum(snapshot?.ecnoMedian, 'dB');
    const blerTxt = snapshot?.blerEvidence ? fmtNum(snapshot?.blerMax, '%') : null;
    const txTxt = fmtNum(snapshot?.txP90, 'dBm');
    const signalBullets = [
        metricBullet('RSCP median', rscpTxt),
        metricBullet('Ec/No median', ecnoTxt),
        metricBullet('BLER max', blerTxt),
        snapshot?.blerEvidence ? null : `BLER: not informative (insufficient RLC BLER samples during setup${Number.isFinite(snapshot?.rlcBlerSamplesCount) ? `: ${snapshot.rlcBlerSamplesCount}` : ''})`,
        metricBullet('UE Tx p90', txTxt)
    ].filter(Boolean);
    const pp = snapshot?.pilotPollution || null;
    const ppScore = Number.isFinite(pp?.score) ? pp.score : (Number.isFinite(pp?.pollutionScore) ? pp.pollutionScore : null);
    const ppLevel = pp?.riskLevel || pp?.pollutionLevel || null;
    if (pp && Number.isFinite(ppScore)) {
        const d = pp.details || {};
        const deltaStats = pp.deltaStats || {};
        const deltaMedian = Number.isFinite(deltaStats.medianDb) ? deltaStats.medianDb : d.deltaMedian;
        const deltaRatio = Number.isFinite(deltaStats.lt3dbRatio) ? deltaStats.lt3dbRatio : d.deltaRatio;
        const deltaLowConfidence = !!deltaStats.confidenceLow || !!d.deltaConfidenceLow;
        signalBullets.push(`Pilot pollution risk: ${ppLevel || 'Unknown'} (${ppScore}/100)`);
        if (deltaLowConfidence) {
            signalBullets.push('ΔRSCP confidence is low (<30% of samples with >=2 pilots), so it was not used as primary root-cause evidence.');
        } else {
            signalBullets.push(`ΔRSCP median=${Number.isFinite(deltaMedian) ? deltaMedian.toFixed(2) : 'n/a'} dB, ΔRSCP<3dB ratio=${Number.isFinite(deltaRatio) ? (deltaRatio * 100).toFixed(0) : 'n/a'}%`);
        }
    }
    if (Number.isFinite(session?.rrcActiveSetSizeReported) && Number.isFinite(pp?.activeSet?.mean) && Math.abs(session.rrcActiveSetSizeReported - pp.activeSet.mean) >= 1) {
        signalBullets.push('Note: RRC Active Set Size (reported) may differ from Active-set proxy (<=3 dB) because the proxy counts only near-equal-strength pilots.');
    }
    signalBullets.forEach(b => {
        if (why.length < 5) why.push(b);
    });

    const durationSec = (Number.isFinite(session?.startTs) && Number.isFinite(session?.endTsReal) && session.endTsReal >= session.startTs)
        ? ((session.endTsReal - session.startTs) / 1000)
        : null;
    const hoDelta = findLastHoDeltaSec(session);

    let whatHappened = 'Session analyzed.';
    if (resultType === 'DROP_CALL') {
        whatHappened = 'Call dropped after connection with abnormal end behavior.';
        if (category === 'DROP_INTERFERENCE') whatHappened = 'Call dropped while signal strength remained good but radio quality degraded.';
        if (category === 'DROP_COVERAGE_UL') whatHappened = 'Call dropped with uplink-limited coverage conditions.';
        if (category === 'DROP_COVERAGE_DL') whatHappened = 'Call dropped under very weak downlink coverage.';
    } else if (resultType === 'CALL_SETUP_FAILURE') {
        whatHappened = 'Call setup failed before connection was established.';
        if (category === 'SETUP_TIMEOUT') whatHappened = 'Call setup failed due to signaling timeout.';
        if (category === 'SETUP_FAIL_DL_INTERFERENCE') whatHappened = 'Call setup failed under downlink quality/interference conditions.';
        if (category === 'SETUP_FAIL_MOBILITY') whatHappened = 'Call setup failed around a mobility transition (HO/SHO proximity).';
        if (category === 'SETUP_FAIL_CONGESTION') whatHappened = 'Call setup failed with congestion/resource-admission indicators.';
        if (category === 'SETUP_FAIL_SIGNALING_OR_CORE') whatHappened = 'Call setup failed with healthy radio and signaling/core indicators.';
    } else if (resultType === 'INCOMPLETE_OR_UNKNOWN_END') {
        whatHappened = 'Call connected but no explicit end marker was found in parsed range.';
    }

    let recommendations = buildRecommendations(resultType, category, session, snapshot);
    const shouldRecommendPollution = (pilotPollution) => {
        const ds = pilotPollution?.deltaStats;
        if (!ds || !Number.isFinite(ds.totalMimoSamples) || ds.totalMimoSamples <= 0) return false;
        const ratio = (Number(ds.samplesWith2Pilots) || 0) / ds.totalMimoSamples;
        const level = String(pilotPollution?.riskLevel || pilotPollution?.pollutionLevel || '').trim();
        return (level === 'High' || level === 'Moderate') && ratio >= 0.30;
    };
    const allowResolvePilot = shouldRecommendPollution(pp);
    if (allowResolvePilot) {
        const exists = recommendations.some(r => String(r?.actionId || '').toUpperCase() === 'RESOLVE_PILOT_POLLUTION');
        if (!exists) {
            recommendations = sortRecommendations([
                {
                    priority: 'P0',
                    actionId: 'RESOLVE_PILOT_POLLUTION',
                    action: 'Resolve Pilot Pollution',
                    rationale: 'Pilot Pollution/overlap risk is high; resolve dominance collapse before or alongside category-specific actions.',
                    ownerHint: 'RAN Optimization'
                },
                ...recommendations
            ]).slice(0, 4);
        }
    }
    if (!allowResolvePilot) recommendations = recommendations.filter(r => String(r?.actionId || '').toUpperCase() !== 'RESOLVE_PILOT_POLLUTION');
    const p0 = recommendations.filter(r => r.priority === 'P0').map(r => r.action);

    const keySignals = {};
    if (Number.isFinite(snapshot?.rscpMedian)) keySignals.rscp = snapshot.rscpMedian;
    if (Number.isFinite(snapshot?.ecnoMedian)) keySignals.ecno = snapshot.ecnoMedian;
    if (Number.isFinite(snapshot?.blerMax)) keySignals.blerMax = snapshot.blerMax;
    if (Number.isFinite(snapshot?.txP90)) keySignals.txP90 = snapshot.txP90;
    if (Number.isFinite(snapshot?.lastPsc)) keySignals.lastPsc = String(snapshot.lastPsc);
    if (Number.isFinite(snapshot?.lastUarfcn)) keySignals.lastUarfcn = String(snapshot.lastUarfcn);
    if (pp && Number.isFinite(ppScore)) {
        keySignals.pollutionScore = ppScore;
        keySignals.pollutionLevel = ppLevel || 'Unknown';
    }

    const metricSummaryParts = [];
    if (rscpTxt) metricSummaryParts.push(`RSCP ${rscpTxt}`);
    if (ecnoTxt) metricSummaryParts.push(`Ec/No ${ecnoTxt}`);
    if (blerTxt) metricSummaryParts.push(`BLER max ${blerTxt}`);
    if (txTxt) metricSummaryParts.push(`UE Tx p90 ${txTxt}`);
    const evidenceTop = why.slice(0, 3).join('; ');
    const cleanAction = (txt) => String(txt || '').trim().replace(/[.]+$/g, '');
    const p0Text = p0.slice(0, 2).map(cleanAction).filter(Boolean).join('; ');
    const deltaStats = pp?.deltaStats || null;

    let oneParagraphSummary = `${category} (${confidencePct}%)`;
    if (resultType === 'DROP_CALL') {
        oneParagraphSummary = `A UMTS voice call dropped${Number.isFinite(durationSec) ? ` after ${durationSec.toFixed(1)}s` : ''}. The most likely cause is ${category} (${confidencePct}%), driven by ${evidenceTop || 'available abnormal end indicators'}.`;
    } else if (resultType === 'CALL_SETUP_FAILURE') {
        oneParagraphSummary = `A UMTS voice call setup failed (call never connected)${Number.isFinite(durationSec) ? ` after ${durationSec.toFixed(1)}s from attempt start` : ''}. The most likely cause is ${category} (${confidencePct}%), driven by ${evidenceTop || 'available setup-failure indicators'}.`;
    } else if (resultType === 'INCOMPLETE_OR_UNKNOWN_END') {
        oneParagraphSummary = `A UMTS voice call connected but no explicit end marker was captured in parsed logs, so final outcome is ${category.toLowerCase()}.`;
    }
    if (!snapshot?.blerEvidence) {
        const idx = metricSummaryParts.findIndex(p => /^BLER max/i.test(p));
        if (idx >= 0) metricSummaryParts.splice(idx, 1);
        metricSummaryParts.push('BLER n/a (insufficient setup-phase evidence)');
    }
    if (metricSummaryParts.length) oneParagraphSummary += ` Final-window radio metrics: ${metricSummaryParts.join(', ')}.`;
    if (Number.isFinite(deltaStats?.totalMimoSamples) && deltaStats.totalMimoSamples > 0 && (Number(deltaStats?.samplesWith2Pilots) || 0) === 0) {
        oneParagraphSummary += ` Dominance inference disabled (${Number(deltaStats?.samplesWith2Pilots) || 0}/${deltaStats.totalMimoSamples} >=2-pilot timestamps).`;
    }
    if (Number.isFinite(hoDelta)) oneParagraphSummary += ` The end occurred ${hoDelta.toFixed(1)}s after the last HO event.`;
    if (p0Text) oneParagraphSummary += ` Recommended next actions: ${p0Text}.`;

    return {
        explanation: {
            whatHappened,
            whyWeThinkSo: why.slice(0, 6),
            keySignals: Object.keys(keySignals).length ? keySignals : undefined
        },
        pilotPollution: pp || null,
        recommendations,
        oneParagraphSummary
    };
}

function withNarrative(session, cls, snapshot) {
    return {
        ...cls,
        ...buildNarrative(session, cls, snapshot)
    };
}

function hasTimelineMatch(session, regex) {
    if (!Array.isArray(session?.eventTimeline)) return false;
    return session.eventTimeline.some((e) => regex.test(`${e?.event || ''} ${e?.details || ''}`));
}

function isRadioHealthyForCore(snapshot) {
    const rscp = snapshot?.rscpMedian;
    const ecno = snapshot?.ecnoMedian;
    const tx = snapshot?.txP90;
    const bler = snapshot?.blerMax;
    return hasNum(rscp) && rscp > -85 &&
        hasNum(ecno) && ecno > -10 &&
        hasNum(tx) && tx < 20 &&
        snapshot?.blerEvidence === true &&
        hasNum(bler) && bler < 5;
}

function buildCoreReason(session, snapshot, causeLabel) {
    const rscpTxt = hasNum(snapshot?.rscpMedian) ? snapshot.rscpMedian.toFixed(1) : 'n/a';
    const ecnoTxt = hasNum(snapshot?.ecnoMedian) ? snapshot.ecnoMedian.toFixed(1) : 'n/a';
    const txTxt = hasNum(snapshot?.txP90) ? snapshot.txP90.toFixed(1) : 'n/a';
    const blerTxt = (snapshot?.blerEvidence === true && hasNum(snapshot?.blerMax))
        ? snapshot.blerMax.toFixed(1)
        : 'n/a (insufficient evidence)';
    const radioSummary = `RSCP ${rscpTxt} dBm, EcNo ${ecnoTxt} dB, UE Tx p90 ${txTxt} dBm, BLER max ${blerTxt}%.`;

    let causeText = '';
    if (session?.cadCause === 18) {
        causeText = 'Cause 18 (No user responding) indicates call-control timeout or no response from downstream network element.';
    } else {
        causeText = `CAD cause ${session?.cadCause ?? 'n/a'} (${causeLabel}).`;
    }

    return [
        `Radio conditions were stable during setup attempt (${radioSummary})`,
        'An immediate signaling release was observed at failure time.',
        causeText,
        'This strongly indicates a core or higher-layer signaling termination rather than a radio-originated setup failure.'
    ].join(' ');
}

function classifySetupFailure(session, snapshot) {
    const txP90 = snapshot?.txP90;
    const rscpMedian = snapshot?.rscpMedian;
    const ecnoMedian = snapshot?.ecnoMedian;
    const blerMax = snapshot?.blerMax;
    const cause = session?.cadCause;
    const hoDelta = findLastHoDeltaSec(session);
    const hasCongestionHints = hasTimelineMatch(session, /(NO[_\s-]?RESOURCE|ADMISSION|CONGEST|POWER LIMIT|CODE LIMIT|CE FULL|CHANNEL ALLOCATION FAILURE|NO RADIO RESOURCE)/i);
    const hasSignalingReleaseReject = hasTimelineMatch(session, /(REJECT|RELEASE|CAUSE|FAIL)/i);

    // 1) UL Coverage
    if (
        hasNum(txP90) && txP90 >= 21 &&
        ((hasNum(rscpMedian) && rscpMedian <= -95) || (hasNum(ecnoMedian) && ecnoMedian <= -16) || (hasNum(blerMax) && blerMax >= 20))
    ) {
        return mk(
            'CALL_SETUP_FAILURE',
            'SETUP_FAIL_UL_COVERAGE',
            'Radio/Coverage',
            'SETUP_FAIL_UL_COVERAGE: high UE Tx with weak/unstable radio.',
            0.85,
            [`txP90=${txP90}`, `rscpMedian=${rscpMedian}`, `ecnoMedian=${ecnoMedian}`, `blerMax=${blerMax}`],
            snapshot
        );
    }

    // 2) DL Interference
    const hasStrongBlerCollapse = hasNum(blerMax) && blerMax >= 95;
    if (
        (snapshot?.blerEvidence === true || hasStrongBlerCollapse) &&
        hasNum(blerMax) && blerMax >= 80 &&
        (!hasNum(txP90) || txP90 <= 18) &&
        hasNum(rscpMedian) && rscpMedian >= -90
    ) {
        const ev = [
            `blerMax=${blerMax} >= 80 (DL decode failure signature)`,
            `txP90=${txP90} <= 18 (UL margin OK; not UL-limited)`,
            `rscpMedian=${rscpMedian} >= -90 (coverage OK)`
        ];
        if (hasNum(ecnoMedian)) {
            ev.push(`ecnoMedian=${ecnoMedian} dB (${ecnoMedian <= -12 ? 'quality degraded' : 'quality OK'})`);
        }
        if (snapshot?.blerEvidence !== true) {
            ev.push('BLER evidence is limited (<3 RLCBLER rows), but BLER collapse is extreme and retained as supporting evidence.');
        }
        const ds = snapshot?.pilotPollution?.deltaStats;
        if (ds && Number.isFinite(ds.totalMimoSamples) && ds.totalMimoSamples > 0) {
            ev.push(`ΔRSCP computed on ${(ds.samplesWith2Pilots || 0)}/${ds.totalMimoSamples} timestamps meeting >=2-pilot criterion.`);
            if ((ds.samplesWith2Pilots || 0) === 0) {
                ev.push('Dominance/overlap inference disabled (no >=2 pilots).');
            }
        }
        const reason =
            'DL decode impairment during setup: BLER is extremely high while UL power is low and RSCP is acceptable. ' +
            'This points to downlink quality collapse (interference/noise rise/control-channel decode issues), not UL limitation.';
        return mk(
            'CALL_SETUP_FAILURE',
            'SETUP_FAIL_DL_INTERFERENCE',
            'Radio/Interference',
            reason,
            0.80,
            ev,
            snapshot
        );
    }

    // 3) Mobility
    if (hasNum(hoDelta) && hoDelta <= 5) {
        return mk(
            'CALL_SETUP_FAILURE',
            'SETUP_FAIL_MOBILITY',
            'Radio/Mobility',
            'SETUP_FAIL_MOBILITY: setup failure occurred shortly after mobility activity.',
            0.80,
            [`Last HO/SHO event was ${hoDelta.toFixed(1)}s before setup end`],
            snapshot
        );
    }

    // 4) Congestion
    if (hasCongestionHints) {
        return mk(
            'CALL_SETUP_FAILURE',
            'SETUP_FAIL_CONGESTION',
            'Radio/Congestion',
            'SETUP_FAIL_CONGESTION: resource/admission congestion indicators around setup failure.',
            0.75,
            ['Resource/admission congestion markers found in signaling timeline'],
            snapshot
        );
    }

    // 5) Core/Signaling (with radio safety gates)
    if (cause === 102) {
        return mk(
            'CALL_SETUP_FAILURE',
            'SETUP_TIMEOUT',
            'Signaling/Timeout',
            'SETUP_TIMEOUT: CAD cause=102 (Setup timeout - timer expiry).',
            0.85,
            ['CAD cause=102 (Setup timeout - timer expiry)', hasSignalingReleaseReject ? 'Explicit release/reject marker observed near setup end' : 'No explicit release/reject marker decoded near setup end'],
            snapshot
        );
    }
    if (hasNum(txP90) && txP90 >= 21) return null;
    if (hasNum(rscpMedian) && rscpMedian <= -90) return null;
    if (hasNum(ecnoMedian) && ecnoMedian <= -14) return null;
    const hasCoreIndicators = hasSignalingReleaseReject || hasNum(session?.cafReason) || hasNum(session?.cadStatus) || hasNum(cause);
    const coreScore = (
        (isRadioHealthyForCore(snapshot) ? 40 : 0) +
        (hasSignalingReleaseReject ? 25 : 0) +
        (!hasNum(session?.connectedTs) ? 15 : 0) +
        (!(hasNum(hoDelta) && hoDelta <= 5) ? 10 : 0) +
        (!hasCongestionHints ? 10 : 0)
    );
    if (coreScore >= 70 && hasCoreIndicators && isRadioHealthyForCore(snapshot)) {
        const causeLabel = decodeCadCause(cause);
        const reason = buildCoreReason(session, snapshot || {}, causeLabel);
        return mk(
            'CALL_SETUP_FAILURE',
            'SETUP_FAIL_SIGNALING_OR_CORE',
            'Core/Signaling',
            reason,
            Math.min(0.95, coreScore / 100),
            [
                'Radio appears healthy while signaling/release indicators exist near setup failure',
                `Core/signaling score=${coreScore}`,
                `CAD cause=${cause ?? 'n/a'} (${causeLabel})`
            ],
            snapshot
        );
    }

    // 6) Unknown
    return mk(
        'CALL_SETUP_FAILURE',
        'SETUP_FAIL_UNKNOWN',
        'Undetermined',
        'Setup failed without dominant signature.',
        0.5,
        ['No rule matched'],
        snapshot
    );
}

function classifySession(session, snapshot) {
    const txP90 = snapshot?.txP90;
    const rscpMedian = snapshot?.rscpMedian;
    const ecnoMedian = snapshot?.ecnoMedian;
    const blerMax = snapshot?.blerMax;
    const cause = session?.cadCause;

    if (session.resultType === 'SUCCESS') {
        return withNarrative(session, mk(
            'SUCCESS',
            'SUCCESS',
            'Normal',
            'Normal clearing (CAD status=1, cause=16).',
            1,
            ['CAD status=1 and cause=16'],
            snapshot
        ), snapshot);
    }

    if (session.resultType === 'CALL_SETUP_FAILURE') {
        const setupCls = classifySetupFailure(session, snapshot);
        return withNarrative(session, setupCls, snapshot);
    }

    if (session.resultType === 'DROP_CALL') {
        const interference = (
            hasNum(rscpMedian) && rscpMedian >= -85 &&
            ((hasNum(ecnoMedian) && ecnoMedian <= -16) || (hasNum(blerMax) && blerMax >= 50)) &&
            (!hasNum(txP90) || txP90 <= 18)
        );
        if (interference) {
            return withNarrative(session, mk(
                'DROP_CALL',
                'DROP_INTERFERENCE',
                'Radio/Interference',
                'DROP_INTERFERENCE: strong RSCP with degraded quality/BLER and low-to-mid TX.',
                0.7,
                [
                    `rscpMedian=${rscpMedian} >= -85`,
                    `ecnoMedian=${ecnoMedian} <= -16 or blerMax=${blerMax} >= 50`,
                    `txP90=${txP90} <= 18`
                ],
                snapshot
            ), snapshot);
        }

        const ulCoverage = hasNum(txP90) && txP90 >= 21 && hasNum(rscpMedian) && rscpMedian <= -95;
        if (ulCoverage) {
            return withNarrative(session, mk(
                'DROP_CALL',
                'DROP_COVERAGE_UL',
                'Radio/Coverage',
                'DROP_COVERAGE_UL: high UE Tx with weak RSCP.',
                0.7,
                [`txP90=${txP90} >= 21`, `rscpMedian=${rscpMedian} <= -95`],
                snapshot
            ), snapshot);
        }

        const dlCoverage = hasNum(rscpMedian) && rscpMedian <= -108 && hasNum(ecnoMedian) && ecnoMedian <= -14;
        if (dlCoverage) {
            return withNarrative(session, mk(
                'DROP_CALL',
                'DROP_COVERAGE_DL',
                'Radio/Coverage',
                'DROP_COVERAGE_DL: very weak downlink coverage.',
                0.7,
                [`rscpMedian=${rscpMedian} <= -108`, `ecnoMedian=${ecnoMedian} <= -14`],
                snapshot
            ), snapshot);
        }

        return withNarrative(session, mk(
            'DROP_CALL',
            'DROP_UNKNOWN',
            'Undetermined',
            'Connected call ended abnormally without dominant signature.',
            0.5,
            ['No rule matched'],
            snapshot
        ), snapshot);
    }

    if (session.resultType === 'INCOMPLETE_OR_UNKNOWN_END') {
        return withNarrative(session, mk(
            'INCOMPLETE_OR_UNKNOWN_END',
            'INCOMPLETE_OR_UNKNOWN_END',
            'Undetermined',
            'Call connected but no explicit end marker (CAD/CAF/CARE) in parsed range.',
            0.5,
            ['Connected without end marker in parsed range'],
            snapshot
        ), snapshot);
    }

    return withNarrative(session, mk('UNCLASSIFIED', 'UNCLASSIFIED', 'Undetermined', 'No matching call outcome.', 0.5, ['No rule matched'], snapshot), snapshot);
}

module.exports = {
    classifySession,
    buildRadioEvaluation
};

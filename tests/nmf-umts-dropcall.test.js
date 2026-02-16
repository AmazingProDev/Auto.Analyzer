const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { NMFParser } = require('../temp_parser');
const { analyzeUmtsCallSessions } = require('../nmfCallSession');
const { buildRadioStore, addRadioRecord, buildSnapshot } = require('../nmfRadioSnapshot');

function approx(actual, expected, tolerance) {
    assert.ok(Number.isFinite(actual), `expected finite number, got ${actual}`);
    assert.ok(Math.abs(actual - expected) <= tolerance, `expected ${actual} to be within ${tolerance} of ${expected}`);
}

function assertPrioritySorted(recommendations) {
    const rank = { P0: 0, P1: 1, P2: 2 };
    for (let i = 1; i < recommendations.length; i++) {
        const prev = rank[recommendations[i - 1].priority];
        const cur = rank[recommendations[i].priority];
        assert.ok(prev <= cur, `recommendations not sorted by priority at index ${i - 1}/${i}`);
    }
}

test('UMTS call sessions and root-cause rules from NMF', () => {
    const fixturePath = path.join(__dirname, 'fixtures', 'umts_dropcall_sample.nmf');
    const content = fs.readFileSync(fixturePath, 'utf8');

    const result = NMFParser.parse(content);
    const analysis = result.umtsCallAnalysis;

    assert.ok(analysis, 'umtsCallAnalysis should be present');
    assert.equal(analysis.summary.totalCaaSessions, 37);
    assert.equal(analysis.summary.outcomes.SUCCESS, 33);
    assert.equal(analysis.summary.outcomes.CALL_SETUP_FAILURE, 3);
    assert.equal(analysis.summary.outcomes.DROP_CALL, 1);

    const byCallId = new Map(analysis.sessions.map(s => [`${s.deviceId}:${s.callId}`, s]));

    const call59 = byCallId.get('5:59');
    assert.equal(call59.resultType, 'CALL_SETUP_FAILURE');
    assert.equal(call59.category, 'SETUP_TIMEOUT');
    assert.equal(call59.domain, 'Signaling/Timeout');
    assert.ok(call59.setupFailureDeepAnalysis, 'call59 should include setupFailureDeepAnalysis');
    assert.match(
        String(call59.setupFailureDeepAnalysis?.radioAssessment?.evaluation || ''),
        /BLER is not informative during setup \(insufficient RLC BLER samples\)/i
    );
    assert.match(
        String(call59.setupFailureDeepAnalysis?.signalingAssessment?.evaluation || ''),
        /Setup timer expired before call connection/i
    );
    assert.ok(call59.classification?.pilotPollution, 'call59 should include pilotPollution');
    assert.notEqual(call59.classification.pilotPollution.finalLabel, 'Pilot Pollution / DL Interference');
    assert.ok(Number(call59.classification.pilotPollution.deltaStats?.samplesWith2Pilots || 0) >= 0);
    if (
        String(call59.classification.pilotPollution.dominanceLevel || '').toUpperCase() === 'HIGH' ||
        String(call59.classification.pilotPollution.finalLabel || '') === 'High overlap / poor dominance under weak coverage' ||
        String(call59.classification.pilotPollution.finalLabel || '') === 'Pilot Pollution / DL Interference'
    ) {
        assert.ok(
            (call59.classification?.recommendations || []).some(r => String(r?.actionId) === 'RESOLVE_PILOT_POLLUTION'),
            'Resolve Pilot Pollution should be injected when overlap/pollution risk is high'
        );
    }

    const call61 = byCallId.get('5:61');
    assert.equal(call61.resultType, 'CALL_SETUP_FAILURE');
    assert.equal(call61.category, 'SETUP_FAIL_UL_COVERAGE');
    approx(call61.snapshot.txP90, 22.5, 0.1);
    approx(call61.snapshot.rscpMedian, -94, 0.5);

    const call15 = byCallId.get('5:15');
    assert.equal(call15.resultType, 'CALL_SETUP_FAILURE');
    assert.equal(call15.category, 'SETUP_FAIL_DL_INTERFERENCE');
    assert.ok(call15.confidence >= 0.6);
    assert.ok(call15.callStartTsIso.endsWith('23:31:59.915Z'), `unexpected callStartTsIso: ${call15.callStartTsIso}`);
    assert.ok(call15.startTsIso.endsWith('23:31:59.915Z'), `unexpected startTsIso: ${call15.startTsIso}`);
    assert.ok(call15.analysisWindowStartTsIso.endsWith('23:31:52.084Z'), `unexpected analysisWindowStartTsIso: ${call15.analysisWindowStartTsIso}`);
    assert.ok(call15.endTsRealIso.endsWith('23:32:02.084Z'), `unexpected endTsRealIso: ${call15.endTsRealIso}`);
    assert.ok(call15.markerTsIso.endsWith('23:32:01.671Z'), `unexpected markerTsIso: ${call15.markerTsIso}`);
    approx(call15.snapshot.rscpMedian, -80.1, 0.2);
    approx(call15.snapshot.ecnoMedian, -12.6, 0.2);
    assert.equal(call15.snapshot.mimoSampleCount, 3);
    assert.equal(call15.snapshot.blerMax, 100);
    assert.equal(call15.snapshot.txLast, 2.6);
    assert.ok(!/successfully established/i.test(call15.reason || ''));
    assert.ok(!/dropped/i.test(call15.reason || ''));
    assert.ok(!/successfully established/i.test(call15.classification?.reason || ''));
    assert.ok(!/dropped/i.test(call15.classification?.reason || ''));
    assert.ok(typeof call15.classification?.oneParagraphSummary === 'string' && call15.classification.oneParagraphSummary.length > 20);
    assert.match(call15.classification.oneParagraphSummary, /setup failed|never connected/i);
    assert.doesNotMatch(call15.classification.oneParagraphSummary, /dropped/i);
    assert.ok(Array.isArray(call15.classification?.recommendations) && call15.classification.recommendations.length >= 2);
    const recInterf = (call15.classification?.recommendations || []).find(r => String(r?.actionId || '') === 'SOLVE_INTERFERENCE_STRONG_SIGNAL');
    assert.ok(recInterf, 'call15 should include SOLVE_INTERFERENCE_STRONG_SIGNAL recommendation');
    assert.ok(String(recInterf?.detailsText || '').length > 20, 'interference recommendation must include detailsText');
    assert.match(String(recInterf.detailsText), /BLER max/i);
    assert.match(String(recInterf.detailsText), /RSCP/i);
    assert.match(String(recInterf.detailsText), /EcNo/i);
    assert.match(String(recInterf.detailsText), /UE Tx p90/i);
    assert.match(String(recInterf.detailsText), /ΔRSCP computed on .*timestamps meeting the ≥2-pilot criterion\./i);
    assert.match(String(recInterf.detailsText), /Strong RSCP\+bad EcNo computed on .*best-server samples\./i);
    assert.equal(call15.classification.recommendations[0].priority, 'P0');
    assertPrioritySorted(call15.classification.recommendations);
    assert.ok(Array.isArray(call15.classification?.explanation?.whyWeThinkSo) && call15.classification.explanation.whyWeThinkSo.length >= 2);
    assert.ok(call15.classification.explanation.whyWeThinkSo.some(x => /bler/i.test(String(x))));
    assert.ok(call15.classification.explanation.whyWeThinkSo.some(x => /tx/i.test(String(x))));
    assert.ok(call15.snapshot.mimoSampleCount > 0);
    assert.ok(!(call15.snapshot.trendMessage || '').toLowerCase().includes('no mimomeas samples'));

    const call62 = byCallId.get('5:62');
    assert.equal(call62.resultType, 'DROP_CALL');
    assert.equal(call62.category, 'DROP_INTERFERENCE');
    approx(call62.snapshot.rscpMedian, -48.3, 1);
    approx(call62.snapshot.ecnoMedian, -24.6, 1);
    assert.ok(call62.snapshot.blerMax >= 100);
    assert.ok(Array.isArray(call62.classification?.recommendations) && call62.classification.recommendations.length >= 2);
    assert.equal(call62.classification.recommendations[0].priority, 'P0');
    assertPrioritySorted(call62.classification.recommendations);
    assert.ok(call62.classification.recommendations.some(r => /interference|pilot/i.test(String(r.action))));
    assert.ok(typeof call62.classification?.oneParagraphSummary === 'string' && call62.classification.oneParagraphSummary.length > 20);
    assert.ok(/RSCP/i.test(call62.classification.oneParagraphSummary));
    assert.ok(/Ec\/No|EcNo/i.test(call62.classification.oneParagraphSummary));
    assert.ok(/BLER/i.test(call62.classification.oneParagraphSummary));
    assert.ok(call62.classification.pilotPollution, 'call62 should include pilotPollution');
    assert.equal(call62.classification.pilotPollution.finalLabel, 'DL Interference (dominance evidence unavailable)');
    assert.equal(call62.classification.pilotPollution.interferenceLevel, 'High');
    assert.equal(call62.classification.pilotPollution.deltaStats?.totalMimoSamples, 15);
    assert.equal(call62.classification.pilotPollution.deltaStats?.samplesWith2Pilots, 2);
    assert.equal(call62.classification.pilotPollution.deltaStats?.confidenceLow, true);
    assert.equal(call62.classification.pilotPollution.dominanceAvailable, true);
    assert.equal(call62.classification.pilotPollution.strongRscpBadEcno?.denomTotalMimo, 15);
    assert.ok((call62.classification.pilotPollution.detailsText || []).join('\n').includes('Overlap / dominance risk: N/A (0/15 >=2-pilot).'));
    assert.ok((call62.classification.pilotPollution.detailsText || []).join('\n').match(/2\s*\/\s*15/));
    assert.ok(
        (call62.classification.pilotPollution.detailsText || []).join('\n').includes('ΔRSCP could only be calculated at 2 time points because nearby cells were not consistently detectable. As a result, the ΔRSCP analysis is based on limited data and should be interpreted with caution.')
    );

    assert.ok(call62.endTsRealIso.startsWith('2025-12-24T00:20:19.599'), `unexpected endTsRealIso: ${call62.endTsRealIso}`);

    const call11 = byCallId.get('5:11');
    assert.ok(call11, 'call 5:11 must exist');
    assert.ok(Number.isFinite(call11.connectedTs), 'call 5:11 should be connected');
    assert.notEqual(call11.resultType, 'DROP_CALL');
    assert.notEqual(call11.resultType, 'CALL_SETUP_FAILURE');
    assert.equal(call11.cadStatus, 1);
    assert.equal(call11.cadCause, 16);
});

test('UMTS-15 pilot pollution details text uses correct denominators and dominance-unavailable wording', () => {
    const fixturePath = path.join(__dirname, '..', 'logs', '25Dec23_Autoroute dual.1.nmf');
    assert.ok(fs.existsSync(fixturePath), `missing fixture: ${fixturePath}`);
    const content = fs.readFileSync(fixturePath, 'utf8');
    const analysis = analyzeUmtsCallSessions(content, { windowSeconds: 10 });
    const call15 = (analysis.sessions || []).find(s => String(s?.deviceId) === '5' && String(s?.callId) === '15');
    assert.ok(call15, 'call 5:15 must exist');
    const text = String((call15.classification?.pilotPollution?.detailsText || []).join('\n'));

    assert.ok(text.includes('ΔRSCP(best-2nd): computed only on timestamps with >=2 pilots (0/15).'));
    assert.ok(text.includes('• ΔRSCP median: n/a'));
    assert.ok(text.includes('• ΔRSCP <3 dB ratio: n/a (0/0)'));
    assert.ok(text.includes('• Strong RSCP share computed on 14/15 best-server samples (RSCP > -85): 93%'));
    assert.ok(text.includes('• Strong RSCP + bad EcNo computed on 3/14 strong samples (EcNo < -14): 21%'));
    assert.ok(text.includes('• Best-server denominator reference: 15/15'));
    assert.ok(
        text.includes('ΔRSCP could only be calculated at 0 time points because nearby cells were not consistently detectable. As a result, the ΔRSCP analysis is based on limited data and should be interpreted with caution.')
    );
    assert.ok(text.includes('Overlap / dominance risk: N/A (0/15 >=2-pilot).'));
    assert.ok(text.includes('Interference-under-strong-signal risk: High (100/100).'));
    assert.ok(text.includes('Strong RSCP + bad EcNo computed on 3/14 strong samples (EcNo < -14): 20%') || text.includes('Strong RSCP + bad EcNo computed on 3/14 strong samples (EcNo < -14): 21%'));
    assert.ok(!text.includes('ΔRSCP <3 dB ratio: 0% (0/15)'));
    assert.ok(!text.includes('ΔRSCP std: 0.00'));
});

test('pilot-pollution evidence formatting handles K large (dominance valid)', () => {
    const store = buildRadioStore();
    const base = Date.UTC(2025, 11, 23, 23, 0, 0, 0);
    for (let i = 0; i < 10; i++) {
        const ts = base + i * 1000;
        const parts = [
            'MIMOMEAS', '23:00:00.000', '', '5', '0', '2', '8',
            '50008', '3032', '100', '0', '0', String(-70 - (i % 2)), '-8.0', '-80.0',
            '50008', '3032', '101', '0', '0', String(-73 - (i % 2)), '-10.0', '-82.0'
        ];
        addRadioRecord(store, 'MIMOMEAS', parts, ts, '5');
    }
    const snapshot = buildSnapshot(store, base + 9000, 10, '5');
    const pp = snapshot?.pilotPollution || {};
    const txt = String((pp.detailsText || []).join('\n'));

    assert.equal(pp.deltaStats?.samplesWith2Pilots, 10);
    assert.equal(pp.deltaStats?.totalMimoSamples, 10);
    assert.equal(pp.deltaStats?.confidenceLow, false);
    assert.notEqual(pp.dominanceLevel, 'N/A');
    assert.ok(!txt.includes('ΔRSCP <3 dB ratio: n/a (0/0)'));
    assert.ok(txt.includes('ΔRSCP(best-2nd): computed only on timestamps with >=2 pilots (10/10).'));
});

test('UMTS analyzer does not inherit CAD from another callId', () => {
    const content = [
        '#START,23:28:06.740,,"23.12.2025"',
        'CAA,23:32:40.100,1,11,5,1,1,"0537547011",,30000,,',
        'CAC,23:32:43.200,1,11,5,1,3,0,1',
        'CAD,23:32:45.400,1,9,5,1,1,16'
    ].join('\n');

    const analysis = analyzeUmtsCallSessions(content, { windowSeconds: 10 });
    const byCallId = new Map(analysis.sessions.map(s => [`${s.deviceId}:${s.callId}`, s]));
    const call11 = byCallId.get('5:11');
    assert.ok(call11, 'call 5:11 must exist');
    assert.ok(Number.isFinite(call11.connectedTs), 'call 5:11 should be connected');
    assert.equal(call11.resultType, 'INCOMPLETE_OR_UNKNOWN_END');
    assert.equal(call11.cadStatus, null);
    assert.equal(call11.cadCause, null);
    assert.equal(call11.endTsCad, null);
    assert.equal(call11.endTsCare, null);
    assert.equal(call11.endTsCaf, null);
    assert.notEqual(call11.resultType, 'DROP_CALL');
    assert.notEqual(call11.resultType, 'CALL_SETUP_FAILURE');
});

test('auto-collects expanded context bundle for SETUP_FAIL_UNKNOWN', () => {
    const content = [
        '#START,23:00:00.000,,"23.12.2025"',
        'CAA,23:00:10.000,1,77,5,1,1,"0600000077",,30000,,',
        'RRCSM,23:00:12.000,,5,STATE,CONNECTING',
        'MIMOMEAS,23:00:15.000,,5,0,2,8,50008,3032,28,0,0,-89.0,-12.0,-80.0,50008,3032,28,1,0,-87.0,-11.0,-79.0',
        'TXPC,23:00:18.000,,5,11.0,0,1.0,0,348,402,46.4',
        'L3SM,23:00:22.000,,5,RRC CONNECTION SETUP',
        'MIMOMEAS,23:00:24.000,,5,0,2,8,50008,3032,28,0,0,-88.0,-13.0,-81.0,50008,3032,28,1,0,-86.0,-12.0,-80.0',
        'RLCBLER,23:00:29.000,,5,10.0,30,17,2,4,1,12.0,29,16,2,8.0,1,1',
        'CAF,23:00:30.000,1,77,5,1,2,',
        'SHO,23:00:31.000,,5,EVENT,ACTIVE_SET_UPDATE'
    ].join('\n');

    const analysis = analyzeUmtsCallSessions(content, { windowSeconds: 10 });
    const byCallId = new Map(analysis.sessions.map(s => [`${s.deviceId}:${s.callId}`, s]));
    const call77 = byCallId.get('5:77');
    assert.ok(call77, 'call 5:77 must exist');
    assert.equal(call77.resultType, 'CALL_SETUP_FAILURE');
    assert.equal(call77.category, 'SETUP_FAIL_UNKNOWN');
    assert.ok(call77.contextBundle, 'context bundle should exist for SETUP_FAIL_UNKNOWN');
    assert.equal(call77.contextBundle.type, 'SETUP_FAILURE_CONTEXT_BUNDLE');
    assert.equal(call77.contextBundle.windows.radioPreEndSec, 20);
    assert.equal(call77.contextBundle.windows.signalingAroundEndSec, 20);
    assert.ok(call77.contextBundle.radioContext.mimoSampleCount >= 2);
    assert.ok(Number.isFinite(call77.contextBundle.radioContext.rscpMedian));
    assert.ok(Number.isFinite(call77.contextBundle.radioContext.txLast));
    assert.ok(Number.isFinite(call77.contextBundle.radioContext.blerMax));
    assert.ok(call77.contextBundle.signalingContext.totalEventsInWindow >= 2);
    assert.ok(Array.isArray(call77.contextBundle.signalingContext.last20EventsBeforeEnd));
    assert.ok(Array.isArray(call77.contextBundle.signalingContext.first10EventsAfterStart));
    assert.equal(call77.contextBundle.callControlContext.connectedEver, false);
    assert.ok(String(call77.contextBundle.callControlContext.cAA || '').includes('23:00:10.000Z'));
    assert.ok(String(call77.contextBundle.callControlContext.cAF || '').includes('23:00:30.000Z'));
});

test('UMTS CELLMEAS parsing keeps serving out of neighbors and labels A2/A3 sequentially', () => {
    const row = 'CELLMEAS,23:32:01.671,,5,0,3,3,3032,-80.1,50008,10838,-95.1,50001,10813,-96.9,50001,9,17,0,50008,3032,28,-12.6,,-92.7,0,,,,,-19.0,-88.0,0,12915.0,,1,50008,3032,287,-5.8,,-85.9,0,,,,,-12.0,-84.0,0,3574.0,,1,50001,10838,28,-12.6,,-107.7,0,,,,,,,0,13009.5,,1,50001,10813,28,-13.2,,-110.1,0,,,,,,,0,13009.0,,1,50008,3032,262,-15.4,,-93.9,0,,,,,-29.0,-93.0,0,33937.0,,1,50008,3032,254,-16.3,,-94.8,0,,,,,-32.0,-95.0,0,33426.0,,1,50008,3032,279,-19.9,,-98.4,0,,,,,,,0,3063.0,,1,50008,3032,118,-24.4,,-102.9,0,,,,,,,0,1565.0,,1,50001,10813,20,,,-124.4,0,,,,,,,0,11985.0,';
    const content = [
        '#START,23:32:00.000,,\"23.12.2025\"',
        'GPS,23:32:01.670,,-9.129111,30.799948,400,,,,',
        row
    ].join('\n');

    const parsed = NMFParser.parse(content);
    const p = (parsed.points || []).find(x => x.time === '23:32:01.671' && x.type === 'MEASUREMENT');
    assert.ok(p, 'CELLMEAS measurement point should exist');
    assert.equal(p?.parsed?.serving?.sc, 28, 'serving PSC should be 28');
    approx(Number(p?.parsed?.serving?.ecno), -12.6, 0.01);

    const neighbors = Array.isArray(p?.parsed?.neighbors) ? p.parsed.neighbors : [];
    assert.ok(neighbors.some(n => Number(n?.pci) === 287), 'PSC 287 neighbor should be present');
    assert.ok(neighbors.some(n => Number(n?.pci) === 262), 'PSC 262 neighbor should be present');
    assert.ok(
        !neighbors.some(n => Number(n?.pci) === 28 && Math.abs(Number(n?.freq) - 3032) < 1),
        'serving 3032/28 must not appear in neighbors'
    );

    assert.equal(Number(p.as_size), 3, 'active set size should be 3 (serving + 2 active neighbors)');
    const activeLabels = neighbors
        .map(n => String(n?.type || '').toUpperCase())
        .filter(t => t.startsWith('A'))
        .sort();
    assert.deepEqual(activeLabels, ['A2', 'A3'], 'active labels must be exactly A2/A3');
});

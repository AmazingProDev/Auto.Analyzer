const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeInterFreqHo, isInterFreq, computeMeasurementSparsity } = require('../lte_ho_analysis');

function point(ts, serving, neighbors = [], extra = {}) {
    return {
        time: ts,
        technology: 'LTE',
        lat: extra.lat ?? 33.9,
        lon: extra.lon ?? -6.3,
        'Serving PCI': serving.pci,
        'Serving EARFCN': serving.earfcn,
        RSRP: serving.rsrp,
        RSRQ: serving.rsrq,
        SINR: serving.sinr,
        parsed: {
            neighbors: neighbors.map((n) => ({
                type: n.role || 'M1',
                pci: n.pci,
                earfcn: n.earfcn,
                rsrp: n.rsrp,
                rsrq: n.rsrq,
                sinr: n.sinr,
            }))
        }
    };
}

function event(ts, name, props = {}) {
    return {
        time: ts,
        type: 'EVENT',
        event: name,
        message: name,
        properties: Object.assign({ Time: ts, Event: name }, props)
    };
}

test('detects inter-frequency HO correctly by EARFCN inequality', () => {
    assert.equal(isInterFreq(1320, 3050), true);
    assert.equal(isInterFreq(1320, 1320), false);
});

test('computes target-frequency sparsity metrics', () => {
    const windowPoints = [
        { ts: 0, neighbors: [{ pci: 10, earfcn: 3050, rsrp: -98 }] },
        { ts: 1000, neighbors: [] },
        { ts: 2000, neighbors: [{ pci: 10, earfcn: 3050, rsrp: -96 }] },
        { ts: 3000, neighbors: [] },
    ];
    const out = computeMeasurementSparsity(windowPoints, 3050, { pci: 10, earfcn: 3050 }, { TARGET_SAMPLING_RATIO_SPARSE: 0.6 });
    assert.equal(out.targetFrequencySampleCount, 2);
    assert.equal(out.chosenTargetSampleCount, 2);
    assert.equal(out.sparse, true);
});

test('classifies a clean inter-frequency HO as successful', () => {
    const dataset = {
        points: [
            point('00:00:00.000', { pci: 101, earfcn: 1320, rsrp: -92, rsrq: -9 }, [{ pci: 205, earfcn: 3050, rsrp: -88, rsrq: -10 }]),
            point('00:00:01.000', { pci: 101, earfcn: 1320, rsrp: -96, rsrq: -11 }, [{ pci: 205, earfcn: 3050, rsrp: -89, rsrq: -10 }]),
            point('00:00:02.000', { pci: 205, earfcn: 3050, rsrp: -87, rsrq: -9 }, [{ pci: 101, earfcn: 1320, rsrp: -101, rsrq: -14 }]),
        ],
        events: [
            event('00:00:00.700', 'MeasurementReport'),
            event('00:00:01.000', 'A3/A5 Event', {
                'HO source PCI': 101,
                'HO source EARFCN': 1320,
                'HO target PCI': 205,
                'HO target EARFCN': 3050,
                'A5 event': 'Yes'
            }),
            event('00:00:02.100', 'Handover Complete')
        ]
    };
    const out = analyzeInterFreqHo(dataset);
    assert.equal(out.events.length, 1);
    assert.equal(out.events[0].isInterFreq, true);
    assert.equal(out.events[0].classification, 'successful');
    assert.ok(out.kpis.summary.interfreqHoSuccessRate > 0.9 || out.kpis.summary.interfreqHoSuccessRate === 1);
});

test('classifies late target visibility as measurement_limited', () => {
    const dataset = {
        points: [
            point('00:00:00.000', { pci: 300, earfcn: 1320, rsrp: -98, rsrq: -10 }, []),
            point('00:00:01.000', { pci: 300, earfcn: 1320, rsrp: -103, rsrq: -13 }, []),
            point('00:00:02.200', { pci: 300, earfcn: 1320, rsrp: -106, rsrq: -15 }, [{ pci: 410, earfcn: 3050, rsrp: -95, rsrq: -9 }]),
            point('00:00:03.000', { pci: 410, earfcn: 3050, rsrp: -94, rsrq: -9 }, [{ pci: 300, earfcn: 1320, rsrp: -110, rsrq: -16 }]),
        ],
        events: [
            event('00:00:02.300', 'MeasurementReport'),
            event('00:00:02.700', 'A3/A5 Event', {
                'HO source PCI': 300,
                'HO source EARFCN': 1320,
                'HO target PCI': 410,
                'HO target EARFCN': 3050,
                'A5 event': 'Yes'
            }),
            event('00:00:03.100', 'Handover Complete')
        ]
    };
    const out = analyzeInterFreqHo(dataset, { config: { TARGET_VISIBLE_LATE_MS: 800, TARGET_SAMPLING_RATIO_SPARSE: 0.3 } });
    assert.equal(out.events.length, 1);
    assert.equal(out.events[0].classification, 'measurement_limited');
});

test('classifies inter-frequency HO execution failure', () => {
    const dataset = {
        points: [
            point('00:00:00.000', { pci: 500, earfcn: 1320, rsrp: -100, rsrq: -11 }, [{ pci: 600, earfcn: 3050, rsrp: -94, rsrq: -9 }]),
            point('00:00:01.000', { pci: 500, earfcn: 1320, rsrp: -105, rsrq: -15 }, [{ pci: 600, earfcn: 3050, rsrp: -93, rsrq: -8 }]),
            point('00:00:02.000', { pci: 600, earfcn: 3050, rsrp: -97, rsrq: -10 }, [{ pci: 500, earfcn: 1320, rsrp: -112, rsrq: -17 }]),
        ],
        events: [
            event('00:00:00.400', 'MeasurementReport'),
            event('00:00:01.000', 'A3/A5 Event', {
                'HO source PCI': 500,
                'HO source EARFCN': 1320,
                'HO target PCI': 600,
                'HO target EARFCN': 3050,
                'A5 event': 'Yes'
            }),
            event('00:00:01.500', 'RLF indication')
        ]
    };
    const out = analyzeInterFreqHo(dataset);
    assert.equal(out.events.length, 1);
    assert.equal(out.events[0].classification, 'execution_failure');
});

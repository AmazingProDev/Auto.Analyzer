const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeIntraFreqHo, computeEffectiveDelta, isIntraFreq } = require('../lte_ho_analysis');

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

test('computeEffectiveDelta applies CIO correctly', () => {
    assert.equal(computeEffectiveDelta(-100, -95, 0, 0), 5);
    assert.equal(computeEffectiveDelta(-100, -95, 2, 0), 3);
    assert.equal(isIntraFreq(1320, 1320), true);
    assert.equal(isIntraFreq(1320, 3050), false);
});

test('classifies a clean intra-frequency HO as successful', () => {
    const dataset = {
        points: [
            point('00:00:00.000', { pci: 101, earfcn: 1320, rsrp: -92, rsrq: -8 }, [{ pci: 102, earfcn: 1320, rsrp: -88, rsrq: -9 }]),
            point('00:00:01.000', { pci: 101, earfcn: 1320, rsrp: -95, rsrq: -9 }, [{ pci: 102, earfcn: 1320, rsrp: -89, rsrq: -9 }]),
            point('00:00:02.000', { pci: 102, earfcn: 1320, rsrp: -87, rsrq: -8 }, [{ pci: 101, earfcn: 1320, rsrp: -96, rsrq: -10 }]),
            point('00:00:03.000', { pci: 102, earfcn: 1320, rsrp: -86, rsrq: -8 }, [{ pci: 101, earfcn: 1320, rsrp: -97, rsrq: -10 }]),
        ],
        events: [
            event('00:00:00.800', 'MeasurementReport'),
            event('00:00:01.000', 'A3/A5 Event', { 'HO source PCI': 101, 'HO source EARFCN': 1320, 'HO target PCI': 102, 'HO target EARFCN': 1320, 'A3 offset': 3, 'HO hysteresis': 1, 'HO TTT': 320 }),
            event('00:00:02.100', 'Handover Complete')
        ]
    };
    const out = analyzeIntraFreqHo(dataset);
    assert.equal(out.events.length, 1);
    assert.equal(out.events[0].classification, 'successful');
    assert.equal(out.events[0].isIntraFreq, true);
    assert.ok(out.kpis.summary.intrafreqHoSuccessRate > 0.9 || out.kpis.summary.intrafreqHoSuccessRate === 1);
});

test('classifies a too-late / execution-failure HO when target is stronger and RLF follows', () => {
    const dataset = {
        points: [
            point('00:00:00.000', { pci: 201, earfcn: 1320, rsrp: -103, rsrq: -13 }, [{ pci: 202, earfcn: 1320, rsrp: -96, rsrq: -10 }]),
            point('00:00:01.000', { pci: 201, earfcn: 1320, rsrp: -107, rsrq: -15 }, [{ pci: 202, earfcn: 1320, rsrp: -98, rsrq: -10 }]),
            point('00:00:02.000', { pci: 202, earfcn: 1320, rsrp: -99, rsrq: -10 }, [{ pci: 201, earfcn: 1320, rsrp: -110, rsrq: -16 }]),
        ],
        events: [
            event('00:00:00.500', 'MeasurementReport'),
            event('00:00:01.000', 'A3/A5 Event', { 'HO source PCI': 201, 'HO source EARFCN': 1320, 'HO target PCI': 202, 'HO target EARFCN': 1320 }),
            event('00:00:01.400', 'RLF indication')
        ]
    };
    const out = analyzeIntraFreqHo(dataset);
    assert.equal(out.events.length, 1);
    assert.match(out.events[0].classification, /too-late|execution-failure/);
    assert.ok(out.events[0].reasons.length >= 1);
});

test('detects ping-pong on A->B->A return within the configured window', () => {
    const dataset = {
        points: [
            point('00:00:00.000', { pci: 301, earfcn: 1320, rsrp: -90, rsrq: -8 }, [{ pci: 302, earfcn: 1320, rsrp: -88, rsrq: -9 }]),
            point('00:00:02.000', { pci: 302, earfcn: 1320, rsrp: -87, rsrq: -8 }, [{ pci: 301, earfcn: 1320, rsrp: -91, rsrq: -9 }]),
            point('00:00:12.000', { pci: 301, earfcn: 1320, rsrp: -89, rsrq: -8 }, [{ pci: 302, earfcn: 1320, rsrp: -90, rsrq: -9 }]),
        ],
        events: [
            event('00:00:01.000', 'A3/A5 Event', { 'HO source PCI': 301, 'HO source EARFCN': 1320, 'HO target PCI': 302, 'HO target EARFCN': 1320 }),
            event('00:00:11.000', 'A3/A5 Event', { 'HO source PCI': 302, 'HO source EARFCN': 1320, 'HO target PCI': 301, 'HO target EARFCN': 1320 })
        ]
    };
    const out = analyzeIntraFreqHo(dataset);
    assert.equal(out.events.length, 2);
    assert.equal(out.events[0].classification, 'ping-pong');
});

test('flags missing-report/config issue when target stays stronger but no MR/command exists', () => {
    const dataset = {
        points: [
            point('00:00:00.000', { pci: 401, earfcn: 1320, rsrp: -101, rsrq: -11 }, [{ pci: 402, earfcn: 1320, rsrp: -95, rsrq: -9 }]),
            point('00:00:01.500', { pci: 401, earfcn: 1320, rsrp: -104, rsrq: -13 }, [{ pci: 402, earfcn: 1320, rsrp: -96, rsrq: -9 }]),
            point('00:00:03.000', { pci: 402, earfcn: 1320, rsrp: -97, rsrq: -10 }, [{ pci: 401, earfcn: 1320, rsrp: -108, rsrq: -14 }]),
        ],
        events: [
            event('00:00:02.000', 'RLF indication')
        ]
    };
    const out = analyzeIntraFreqHo(dataset);
    assert.equal(out.events.length, 1);
    assert.ok(['missing-report/config-issue', 'too-late', 'execution-failure'].includes(out.events[0].classification));
});

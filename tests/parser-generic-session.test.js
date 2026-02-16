const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadParserInternals() {
    const parserPath = path.join(__dirname, '..', 'parser.js');
    const src = fs.readFileSync(parserPath, 'utf8');
    const wrapped = `${src}\nmodule.exports = { CallSessionBuilder, UmtsCallAnalyzer };`;
    const context = {
        module: { exports: {} },
        exports: {},
        require,
        console
    };
    vm.runInNewContext(wrapped, context, { filename: parserPath });
    return context.module.exports;
}

test('generic RRC session without callId is not marked as DROP', () => {
    const { CallSessionBuilder } = loadParserInternals();
    assert.ok(CallSessionBuilder && typeof CallSessionBuilder.build === 'function');

    const records = [
        {
            time: '2025-12-23T23:00:00.000Z',
            type: 'SIGNALING',
            message: 'CM_SERVICE_REQUEST',
            properties: { 'RRC State': 'IDLE' }
        },
        {
            time: '2025-12-23T23:00:01.000Z',
            type: 'SIGNALING',
            message: 'CONNECT',
            properties: { 'RRC State': 'CONNECTED' }
        },
        {
            time: '2025-12-23T23:00:03.000Z',
            type: 'SIGNALING',
            message: 'STATE_CHANGE',
            properties: { 'RRC State': 'IDLE' }
        }
    ];

    const sessions = CallSessionBuilder.build(records);
    assert.ok(Array.isArray(sessions));
    assert.ok(sessions.length >= 1);

    const s = sessions[0];
    assert.equal(s._source, 'generic');
    assert.equal(s.kind, 'RRC_SESSION');
    assert.equal(s.callTransactionId, null);
    assert.equal(s.drop, false);
    assert.notEqual(String(s.endType || '').toUpperCase(), 'DROP');
    assert.equal(s.endTrigger, 'RRC_IDLE_TRANSITION');
});


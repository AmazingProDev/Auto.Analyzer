const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadParserInternals() {
    const parserPath = path.join(__dirname, '..', 'parser.js');
    const src = fs.readFileSync(parserPath, 'utf8');
    const wrapped = `${src}\nmodule.exports = { NMFParser };`;
    const context = {
        module: { exports: {} },
        exports: {},
        require,
        console
    };
    vm.runInNewContext(wrapped, context, { filename: parserPath });
    return context.module.exports;
}

test('parseNmfs decodes secure NMFS metadata from sample file', () => {
    const { NMFParser } = loadParserInternals();
    assert.ok(NMFParser && typeof NMFParser.parseNmfs === 'function');

    const samplePath = path.join(__dirname, '..', '25Dec16_195209.1.nmfs');
    const buf = fs.readFileSync(samplePath);
    const arr = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    const result = NMFParser.parseNmfs(arr);

    assert.ok(result && typeof result === 'object');
    assert.ok(result.nmfs);
    assert.equal(result.nmfs.signature, 'NMFS');
    assert.equal(result.nmfs.decodeMode, 'metadata_only_secure_payload');
    assert.ok(result.nmfs.metadataCount > 0);
    assert.equal(result.nmfs.hasStartTag, true);
    assert.equal(result.nmfs.hasStopTag, true);
    assert.ok(Array.isArray(result.signaling));
    assert.ok(result.signaling.length >= 1);
});

test('parseNmfs extracts plaintext NMF lines inside NMFS container', () => {
    const { NMFParser } = loadParserInternals();
    assert.ok(NMFParser && typeof NMFParser.parseNmfs === 'function');

    const nmfsText =
        '#PRODUCT,,,"NEMO HANDY-A"\r\n' +
        '#START,10:00:00.000,,"16.12.2025"\r\n' +
        'CHI,10:00:00.000,,7,0,0,0,0,0,51328008,8362\r\n' +
        'GPS,10:00:00.000,,-6.8200,34.0100,10,0,0,20\r\n' +
        '#STOP,10:00:10.000,,"16.12.2025"\r\n';
    const raw = Buffer.concat([
        Buffer.from([0x4e, 0x4d, 0x46, 0x53, 0x01, 0x00, 0x00, 0x51]),
        Buffer.from(nmfsText, 'latin1')
    ]);
    const arr = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
    const result = NMFParser.parseNmfs(arr);

    assert.ok(result && result.nmfs);
    assert.equal(result.nmfs.signature, 'NMFS');
    assert.equal(result.nmfs.decodeMode, 'metadata_plus_plaintext');
    assert.ok(result.nmfs.recordLineCount >= 2);
});

test('parseNmfs falls back to text parser when signature is not NMFS', () => {
    const { NMFParser } = loadParserInternals();
    assert.ok(NMFParser && typeof NMFParser.parseNmfs === 'function');

    const text = 'GPS,10:00:00.000,,-6.82,34.01,10,0,0,20\n';
    const raw = Buffer.from(text, 'utf8');
    const arr = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
    const result = NMFParser.parseNmfs(arr);

    assert.ok(result && result.nmfs);
    assert.equal(result.nmfs.decodeMode, 'text_fallback');
});

#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { analyzeIntraFreqHo, analyzeInterFreqHo } = require('./lte_ho_analysis');

async function readStdin() {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf8');
}

(async function main() {
    try {
        const raw = await readStdin();
        const payload = raw ? JSON.parse(raw) : {};
        const mode = String(payload.mode || payload.analysisMode || 'intrafreq').toLowerCase();
        const analyzer = mode === 'interfreq' ? analyzeInterFreqHo : analyzeIntraFreqHo;
        const result = analyzer(payload.dataset || payload.input || payload, payload.options || {});
        process.stdout.write(JSON.stringify({ ok: true, result }));
    } catch (err) {
        process.stdout.write(JSON.stringify({ ok: false, error: err && err.message ? err.message : String(err) }));
        process.exitCode = 1;
    }
})();

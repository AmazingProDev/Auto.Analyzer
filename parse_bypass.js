const fs = require('fs');
const xlsx = require('xlsx');

const file = '/tmp/bypass.xlsx';
if (!fs.existsSync(file)) {
    console.log('File not found:', file);
    process.exit(1);
}

const data = fs.readFileSync(file);
const wb = xlsx.read(data, {type:'buffer'});
const s = wb.SheetNames[0];
const ws = wb.Sheets[s];
const rows = xlsx.utils.sheet_to_json(ws, {defval: ''});

const headers = Object.keys(rows[0] || {});
console.log('--- COLUMNS ---');
console.log(headers.filter(h => /(lat|lon|gps|event|call|stab|estab|connect|drop|fail)/i.test(h)).join(', '));

const uniqueEvents = new Set();
rows.forEach(row => {
    Object.keys(row).forEach(k => {
        if (/event type/i.test(k) && row[k]) uniqueEvents.add(row[k].trim());
    });
});
console.log('--- UNIQUE EVENT TYPES ---');
console.log(Array.from(uniqueEvents).join(', '));

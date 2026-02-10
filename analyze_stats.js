const fs = require('fs');
const { NMFParser } = require('./temp_parser.js');

const filePath = '/Users/abdelilah/Documents/My projects/MRs Analyser/25Aug19_160235 VIP AKRACHE.3.nmf';

try {
    const fileContent = fs.readFileSync(filePath, 'utf8');
    const result = NMFParser.parse(fileContent);

    console.log(`Parsed ${result.points.length} points.`);

    // Aggregate Metrics
    const metrics = {
        'rrc_rel_cause': new Set(),
        'cs_rel_cause': new Set(),
        'iucs_status': new Set()
    };

    result.points.forEach(p => {
        if (p.properties) {
            if (p.properties['rrc_rel_cause']) metrics['rrc_rel_cause'].add(p.properties['rrc_rel_cause']);
            if (p.properties['cs_rel_cause']) metrics['cs_rel_cause'].add(p.properties['cs_rel_cause']);
            if (p.properties['iucs_status']) metrics['iucs_status'].add(p.properties['iucs_status']);
        }
    });

    console.log('\n--- Analysis Results ---');
    Object.keys(metrics).forEach(key => {
        console.log(`\nMetric: ${key}`);
        const values = Array.from(metrics[key]);
        if (values.length === 0) {
            console.log('  (No values found)');
        } else {
            values.forEach(v => console.log(`  - ${v}`));
        }
    });

} catch (err) {
    console.error('Error:', err.message);
}

const fs = require('fs');

// Mock DOM
const jsdom = require("jsdom");
const { JSDOM } = jsdom;
const dom = new JSDOM(`
<!DOCTYPE html>
<html>
<body>
    <div id="benchmarkNemoIamServingCells" style="display:none;"></div>
</body>
</html>
`);
global.document = dom.window.document;
global.window = dom.window;

let currentLang = 'en';
function escapeHtml(unsafe) {
    if (typeof unsafe !== 'string') return unsafe;
    return unsafe.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const benchmarkNemoIamServingCells = document.getElementById('benchmarkNemoIamServingCells');

// Payload from backend
const dataset = {
    iamServingCells: {
        available: true,
        matchedCount: 2467,
        gpsRows: 2467,
        uniqueSiteCount: 2,
        uniqueCellCount: 5,
        matchMethods: { pci_freq: 0, pci_only: 1047, proximity: 1420 },
        techBreakdown: { "4G": 2467 },
        cells: [
            { cellName: "4G_RAB_StadeAlBarid_S2_101558213", siteName: "4G_RAB_StadeAlBarid_S2_101558", tech: "4G", band: "", hitCount: 1420, sharePercent: 57.5 },
        ]
    }
};

try {
    const sc = dataset.iamServingCells || {};
    if (!sc.available) {
        if (sc.bddAvailable === false) {
            benchmarkNemoIamServingCells.style.display = 'block';
            const noMsg = 'BDD not loaded';
            benchmarkNemoIamServingCells.innerHTML = '<div class="benchmark-nemo-warning benchmark-nemo-warning--info" style="margin:0">' + escapeHtml(noMsg) + '</div>';
        } else {
            benchmarkNemoIamServingCells.style.display = 'none';
        }
    } else {
        benchmarkNemoIamServingCells.style.display = 'block';
        const techColors = { '4G': '#3b82f6', '5G': '#a855f7' };
        const secTitle = 'IAM Serving Cells (from BDD)';
        const matchLabel = 'GPS points matched';
        const siteLabel = 'unique sites';
        const cellLabel = 'unique cells';
        const unmatchLabel = 'unmatched';
        const techLabel = 'Tech breakdown';
        const topCellLabel = 'Top serving cells (by GPS sample frequency)';
        const allSitesLabel = 'IAM sites involved';
        const cells = Array.isArray(sc.cells) ? sc.cells : [];
        const topCells = cells.slice(0, 15);
        const techBreakdown = sc.techBreakdown || {};
        const matchMethods = sc.matchMethods || {};
        const techChips = Object.entries(techBreakdown).map(([tech, cnt]) =>
            '<span class="bn-serving-tech-chip" style="background:' + (techColors[tech.split('/')[0]] || '#64748b') + '22;border:1px solid ' + (techColors[tech.split('/')[0]] || '#64748b') + ';color:' + (techColors[tech.split('/')[0]] || '#64748b') + ';border-radius:12px;padding:2px 9px;font-size:11px;font-weight:700;">'
            + escapeHtml(tech) + ' · ' + cnt + '</span>'
        ).join(' ');
        const methodLabel = 'Match quality';
        const pciFreqCount = matchMethods.pci_earfcn || 0;
        const pciCount = matchMethods.pci_only || 0;
        const proxCount = matchMethods.proximity || 0;
        const matchQualHtml = (pciFreqCount || pciCount || proxCount)
            ? '<span style="font-size:10px;color:#64748b;margin-left:6px">' + methodLabel + ': '
                + (pciFreqCount ? '<span style="color:#34d399">PCI+ARFCN·' + pciFreqCount + '</span> ' : '')
                + (pciCount ? '<span style="color:#7dd3fc">PCI·' + pciCount + '</span> ' : '')
                + (proxCount ? '<span style="color:#fb923c">GPS·' + proxCount + '</span>' : '')
                + '</span>'
            : '';

        benchmarkNemoIamServingCells.innerHTML = ''
            + '<div class="benchmark-nemo-sc-header">'
            + '<span class="benchmark-nemo-sc-title">📡 ' + escapeHtml(secTitle) + '</span>'
            + '<span class="bn-serving-badge">' + escapeHtml(String(sc.matchedCount || 0)) + ' / ' + escapeHtml(String(sc.gpsRows || 0)) + ' ' + matchLabel + '</span>'
            + '<span class="bn-serving-badge bn-serving-badge--site">🏢 ' + escapeHtml(String(sc.uniqueSiteCount || 0)) + ' ' + siteLabel + '</span>'
            + '<span class="bn-serving-badge bn-serving-badge--cell">📶 ' + escapeHtml(String(sc.uniqueCellCount || 0)) + ' ' + cellLabel + '</span>'
            + (sc.unmatchedCount ? '<span class="bn-serving-badge bn-serving-badge--warn">⚠ ' + escapeHtml(String(sc.unmatchedCount)) + ' ' + unmatchLabel + '</span>' : '')
            + matchQualHtml
            + '</div>'
            + (techChips ? '<div class="bn-serving-tech-row">' + techLabel + ': ' + techChips + '</div>' : '')
            + '<div class="bn-serving-sites-label">' + escapeHtml(allSitesLabel) + ':</div>'
            + '<div class="bn-serving-sites-chips">'
            + (sc.uniqueSites || []).map((s) =>
                '<span class="bn-site-chip">' + escapeHtml(s) + '</span>'
            ).join('')
            + '</div>'
            + '<div class="bn-serving-cells-label">' + escapeHtml(topCellLabel) + ':</div>'
            + '<div class="benchmark-nemo-table-wrap"><table class="benchmark-config-table benchmark-nemo-table">'
            + '<thead><tr>'
            + '<th>Cell</th>'
            + '<th>Site</th>'
            + '<th>Tech</th>'
            + '<th>Band</th>'
            + '<th>GPS Hits</th>'
            + '<th>Share</th>'
            + '</tr></thead><tbody>'
            + topCells.map((cell) => {
                const techColor = techColors[cell.tech] || '#64748b';
                const techBadge = '<span style="color:' + techColor + ';font-weight:700;font-size:11px">' + escapeHtml(cell.tech || '') + '</span>';
                const shareBar = '<div style="display:flex;align-items:center;gap:6px"><div style="height:6px;border-radius:3px;background:' + techColor + ';width:' + Math.max(4, (cell.sharePercent || 0)) + 'px;max-width:80px"></div><span>' + escapeHtml(String(cell.sharePercent || 0)) + '%</span></div>';
                return '<tr>'
                    + '<td><strong>' + escapeHtml(cell.cellName || '—') + '</strong></td>'
                    + '<td>' + escapeHtml(cell.siteName || '—') + '</td>'
                    + '<td>' + techBadge + '</td>'
                    + '<td><span style="font-size:11px;color:#94a3b8">' + escapeHtml(cell.band || '—') + '</span></td>'
                    + '<td>' + escapeHtml(String(cell.hitCount || 0)) + '</td>'
                    + '<td>' + shareBar + '</td>'
                    + '</tr>';
            }).join('')
            + '</tbody></table></div>';
    }
    console.log("SUCCESS");
} catch(e) {
    console.error("ERROR:", e);
}

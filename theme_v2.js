
// ----------------------------------------------------
// THEME & THRESHOLD CONFIGURATION
// ----------------------------------------------------
window.themeConfig = {
    activeMetric: 'level', // Default Metric
    // Default Thresholds (can be modified by UI)
    thresholds: {
        // RSRP (LTE & NR)
        rsrp: [
            { min: -80, color: '#22c55e', label: 'Excellent ( > -80 )' },
            { min: -90, max: -80, color: '#84cc16', label: 'Good ( -90 to -80 )' },
            { min: -100, max: -90, color: '#eab308', label: 'Fair ( -100 to -90 )' },
            { min: -110, max: -100, color: '#f97316', label: 'Poor ( -110 to -100 )' },
            { max: -110, color: '#ef4444', label: 'Bad ( < -110 )' }
        ],
        // RSRQ (LTE & NR)
        rsrq: [
            { min: -10, color: '#22c55e', label: 'Excellent ( > -10 )' },
            { min: -15, max: -10, color: '#84cc16', label: 'Good ( -15 to -10 )' },
            { min: -20, max: -15, color: '#f97316', label: 'Fair ( -20 to -15 )' },
            { max: -20, color: '#ef4444', label: 'Bad ( < -20 )' }
        ],
        // SINR (LTE & NR)
        sinr: [
            { min: 20, color: '#22c55e', label: 'Excellent ( > 20 )' },
            { min: 10, max: 20, color: '#84cc16', label: 'Good ( 10 to 20 )' },
            { min: 0, max: 10, color: '#eab308', label: 'Fair ( 0 to 10 )' },
            { max: 0, color: '#ef4444', label: 'Bad ( < 0 )' }
        ],
        // CQI
        cqi: [
            { min: 12, color: '#22c55e', label: 'Excellent ( 13-15 )' },
            { min: 9, max: 12, color: '#84cc16', label: 'Good ( 10-12 )' },
            { min: 6, max: 9, color: '#eab308', label: 'Fair ( 7-9 )' },
            { max: 6, color: '#ef4444', label: 'Bad ( 0-6 )' }
        ],
        // MCS
        mcs: [
            { min: 20, color: '#22c55e', label: 'High ( 20-31 )' },
            { min: 10, max: 20, color: '#84cc16', label: 'Mid ( 10-19 )' },
            { max: 10, color: '#eab308', label: 'Low ( 0-9 )' }
        ],
        // Throughput (Mbps)
        throughput: [
            { min: 100, color: '#22c55e', label: 'Excellent ( > 100 Mbps )' },
            { min: 50, max: 100, color: '#84cc16', label: 'Good ( 50-100 Mbps )' },
            { min: 10, max: 50, color: '#eab308', label: 'Fair ( 10-50 Mbps )' },
            { min: 5, max: 10, color: '#f97316', label: 'Poor ( 5-10 Mbps )' },
            { max: 5, color: '#ef4444', label: 'Bad ( < 5 Mbps )' }
        ],
        // Legacy 'level' and 'quality' (mapping to rsrp/rsrq)
        level: [
            { min: -80, color: '#22c55e', label: 'Excellent ( > -80 )' },
            { min: -90, max: -80, color: '#84cc16', label: 'Good ( -90 to -80 )' },
            { min: -100, max: -90, color: '#eab308', label: 'Fair ( -100 to -90 )' },
            { min: -110, max: -100, color: '#f97316', label: 'Poor ( -110 to -100 )' },
            { max: -110, color: '#ef4444', label: 'Bad ( < -110 )' }
        ],
        quality: [
            { min: -10, color: '#22c55e', label: 'Excellent ( > -10 )' },
            { min: -15, max: -10, color: '#84cc16', label: 'Good ( -15 to -10 )' },
            { min: -20, max: -15, color: '#f97316', label: 'Fair ( -20 to -15 )' },
            { max: -20, color: '#ef4444', label: 'Bad ( < -20 )' }
        ]
    }
};

// Map 'metric' names to threshold keys
window.getThresholdKey = (metric) => {
    if (!metric) return null;
    const m = metric.toLowerCase();

    // RSRP
    if (m.includes('rsrp') || m === 'level' || m.includes('rscp')) return 'rsrp';
    // RSRQ
    if (m.includes('rsrq') || m === 'quality' || m.includes('ecno')) return 'rsrq';
    // SINR
    if (m.includes('sinr')) return 'sinr';
    // CQI
    if (m.includes('cqi')) return 'cqi';
    // MCS
    if (m.includes('mcs')) return 'mcs';
    // Throughput
    if (m.includes('throughput') || m.includes('thr')) return 'throughput';

    // Discrete/Categorical Metrics
    const discrete = [
        'pci', 'cid', 'cellid', 'sc', 'beam', 'index', 'band', 'freq', 'earfcn', 'uarfcn', 'arfcn', 'channel', 'bandwidth',
        'rnc', 'lac', 'name', 'state', 'event', 'cause', 'technology', 'ssb', 'slot', 'frame', 'mode', 'type'
    ];
    if (discrete.some(d => m.includes(d))) return 'discrete';

    return null; // Default fallback
};

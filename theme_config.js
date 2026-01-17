
// ----------------------------------------------------
// THEME & THRESHOLD CONFIGURATION
// ----------------------------------------------------
window.themeConfig = {
    activeMetric: 'level', // Default Metric
    // Default Thresholds (can be modified by UI)
    thresholds: {
        // Coverage (RSCP / RSRP / Level)
        level: [
            { min: -70, color: '#22c55e', label: 'Excellent ( > -70 )' },
            { min: -85, max: -70, color: '#84cc16', label: 'Good ( -85 to -70 )' },
            { min: -95, max: -85, color: '#eab308', label: 'Fair ( -95 to -85 )' },
            { min: -105, max: -95, color: '#f97316', label: 'Poor ( -105 to -95 )' },
            { max: -105, color: '#ef4444', label: 'Bad ( < -105 )' }
        ],
        // Quality (EcNo / RSRQ)
        quality: [
            { min: -6, color: '#22c55e', label: 'Excellent ( > -6 )' },
            { min: -10, max: -6, color: '#84cc16', label: 'Good ( -10 to -6 )' },
            { min: -14, max: -10, color: '#eab308', label: 'Fair ( -14 to -10 )' },
            { min: -18, max: -14, color: '#f97316', label: 'Poor ( -18 to -14 )' },
            { max: -18, color: '#ef4444', label: 'Bad ( < -18 )' }
        ]
    }
};

// Map 'metric' names to threshold keys
window.getThresholdKey = (metric) => {
    if (!metric) return null;
    const m = metric.toLowerCase();

    // Check for RSCP/RSRP/Level variants
    if (m.includes('rscp') || m.includes('rsrp') || m === 'level' || m.includes('level')) return 'level';

    // Check for EcNo/RSRQ/Quality variants
    if (m.includes('ecno') || m.includes('rsrq') || m === 'quality' || m.includes('quality')) return 'quality';

    return null; // Uses discrete coloring
};

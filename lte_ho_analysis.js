(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.LteHoAnalysis = factory();
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const DEFAULT_CONFIG = {
        SIGNIFICANT_DELTA_DB: 4,
        MARGINAL_DELTA_DB: 1.5,
        SERVING_WEAK_RSRP_DBM: -102,
        SERVING_VERY_WEAK_RSRP_DBM: -108,
        POOR_RSRQ_DB: -12,
        CRITICAL_RSRQ_DB: -15,
        PING_PONG_TIME_MS: 30000,
        PING_PONG_DISTANCE_M: 500,
        REPORT_TO_COMMAND_WARN_MS: 1000,
        COMMAND_TO_COMPLETE_WARN_MS: 1500,
        SUSTAINED_STRONGER_MS: 1000,
        MR_TO_COMMAND_MAX_MS: 3000,
        COMMAND_TO_COMPLETE_MAX_MS: 5000,
        COMMAND_TO_FAIL_MAX_MS: 5000,
        COMMAND_WINDOW_MS: 5000,
        RECONSTRUCTION_WINDOW_BEFORE_MS: 5000,
        RECONSTRUCTION_WINDOW_AFTER_MS: 5000,
        MAX_SAMPLE_GAP_MS: 1500,
        DEFAULT_A3_OFFSET_DB: 3,
        STABLE_DWELL_MS: 3000,
        WRONG_TARGET_ALT_MARGIN_DB: 2,
        MISSING_REPORT_LOOKBACK_MS: 4000,
        DEBUG: false
    };

    const DEFAULT_MAPPING = {
        pointTime: ['ts', 'timestamp', 'time', 'Time'],
        pointLat: ['lat', 'latitude', 'Latitude'],
        pointLon: ['lon', 'lng', 'longitude', 'Longitude', 'Lng'],
        technology: ['technology', 'tech', 'Tech'],
        servingPci: ['serving_pci', 'pci', 'Physical cell ID', 'Serving PCI', 'Serving SC', 'SC'],
        servingEarfcn: ['serving_earfcn', 'earfcn', 'Downlink EARFCN', 'Serving EARFCN', 'Serving Freq', 'EARFCN', 'Freq'],
        servingEci: ['serving_ecgi', 'serving_eci', 'eci', 'ecgi', 'Cell ID', 'Cellid'],
        servingCellName: ['serving_cell_name', 'Serving cell name', 'Serving Cell Name', 'Cell Name', 'cellName', 'siteName', 'name'],
        servingRsrp: ['serving_rsrp', 'rsrp', 'Serving RSRP', 'RSRP'],
        servingRsrq: ['serving_rsrq', 'rsrq', 'Serving RSRQ', 'RSRQ'],
        servingSinr: ['serving_sinr', 'sinr', 'Serving SINR', 'SINR'],
        a3Offset: ['a3_offset', 'A3 offset', 'A3 Offset', 'rrc_recfg_a3_offset_db'],
        tttMs: ['ttt_ms', 'HO TTT', 'Time-to-Trigger', 'Time To Trigger', 'rrc_recfg_ttt_ms'],
        hysteresisDb: ['hysteresis', 'HO hysteresis', 'Hysteresis', 'rrc_recfg_hysteresis_db'],
        servingCio: ['source_cio', 'serving_cio', 'Serving CIO', 'CIO serving'],
        targetCio: ['target_cio', 'Target CIO', 'CIO target'],
        l3FilterCoeff: ['l3_filter_coefficient', 'L3 Filter Coefficient', 'L3 filter coefficient'],
        eventType: ['event_type', 'event', 'Event', 'message_type', 'message', 'Message', 'type', 'Type'],
        eventSubtype: ['subtype', 'Subtype', 'kind', 'Kind']
    };

    function createConfig(overrides) {
        return Object.assign({}, DEFAULT_CONFIG, overrides || {});
    }

    function toFiniteNumber(value) {
        if (value === null || value === undefined || value === '') return null;
        const n = Number(value);
        return Number.isFinite(n) ? n : null;
    }

    function toInt(value) {
        const n = toFiniteNumber(value);
        return Number.isFinite(n) ? Math.round(n) : null;
    }

    function hasValue(value) {
        return !(value === undefined || value === null || value === '' || (typeof value === 'number' && !Number.isFinite(value)));
    }

    function valueFromObject(obj, keys) {
        if (!obj || typeof obj !== 'object') return undefined;
        for (const key of keys) {
            if (Object.prototype.hasOwnProperty.call(obj, key) && hasValue(obj[key])) return obj[key];
            const hit = Object.keys(obj).find((k) => String(k).toLowerCase() === String(key).toLowerCase());
            if (hit && hasValue(obj[hit])) return obj[hit];
        }
        return undefined;
    }

    function parseTs(value) {
        if (value === null || value === undefined || value === '') return null;
        if (typeof value === 'number' && Number.isFinite(value)) {
            return value > 1e12 ? value : value;
        }
        const raw = String(value).trim();
        if (!raw) return null;
        const tod = raw.match(/^(\d{1,2}):(\d{2}):(\d{2})(?:[.,](\d{1,3}))?$/);
        if (tod) {
            const hh = Number(tod[1]);
            const mm = Number(tod[2]);
            const ss = Number(tod[3]);
            const ms = Number(String(tod[4] || '0').padEnd(3, '0').slice(0, 3));
            return (((hh * 60) + mm) * 60 + ss) * 1000 + ms;
        }
        const parsed = Date.parse(raw);
        return Number.isFinite(parsed) ? parsed : null;
    }

    function normalizeTech(value) {
        const txt = String(value || '').trim().toUpperCase();
        if (!txt) return undefined;
        if (txt.includes('LTE') || txt === '4G') return 'LTE';
        if (txt.includes('NR') || txt.includes('5G')) return 'NR';
        if (txt.includes('UMTS') || txt.includes('WCDMA') || txt === '3G') return 'UMTS';
        if (txt.includes('GSM') || txt === '2G') return 'GSM';
        return txt;
    }

    function distanceMeters(lat1, lon1, lat2, lon2) {
        const nums = [lat1, lon1, lat2, lon2].map(toFiniteNumber);
        if (nums.some((v) => !Number.isFinite(v))) return Infinity;
        const [aLat, aLon, bLat, bLon] = nums.map((v) => v * Math.PI / 180);
        const dLat = bLat - aLat;
        const dLon = bLon - aLon;
        const sinLat = Math.sin(dLat / 2);
        const sinLon = Math.sin(dLon / 2);
        const h = sinLat * sinLat + Math.cos(aLat) * Math.cos(bLat) * sinLon * sinLon;
        return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
    }

    function shallowClone(obj) {
        return obj && typeof obj === 'object' ? JSON.parse(JSON.stringify(obj)) : obj;
    }

    function inspectSchema(input) {
        const points = Array.isArray(input) ? input : (Array.isArray(input && input.points) ? input.points : []);
        const events = Array.isArray(input && input.events) ? input.events : [];
        const collectKeys = (rows) => {
            const counts = new Map();
            rows.forEach((row) => {
                if (!row || typeof row !== 'object') return;
                Object.keys(row).forEach((key) => counts.set(key, (counts.get(key) || 0) + 1));
                if (row.properties && typeof row.properties === 'object') {
                    Object.keys(row.properties).forEach((key) => counts.set(`properties.${key}`, (counts.get(`properties.${key}`) || 0) + 1));
                }
            });
            return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).map(([key, count]) => ({ key, count }));
        };
        return {
            pointCount: points.length,
            eventCount: events.length,
            pointKeys: collectKeys(points),
            eventKeys: collectKeys(events),
            samples: {
                firstPoint: points[0] || null,
                firstEvent: events[0] || null
            }
        };
    }

    function schemaToFieldMapping(schema) {
        const pointKeys = new Set((schema && Array.isArray(schema.pointKeys) ? schema.pointKeys : []).map((x) => String(x.key || '')));
        const eventKeys = new Set((schema && Array.isArray(schema.eventKeys) ? schema.eventKeys : []).map((x) => String(x.key || '')));
        const mapping = shallowClone(DEFAULT_MAPPING);
        if (pointKeys.has('properties.Serving PCI')) mapping.servingPci.unshift('properties.Serving PCI');
        if (pointKeys.has('properties.Serving EARFCN')) mapping.servingEarfcn.unshift('properties.Serving EARFCN');
        if (pointKeys.has('properties.RSRP')) mapping.servingRsrp.unshift('properties.RSRP');
        if (pointKeys.has('properties.RSRQ')) mapping.servingRsrq.unshift('properties.RSRQ');
        if (eventKeys.has('properties.Event')) mapping.eventType.unshift('properties.Event');
        return mapping;
    }

    function parseNeighborFields(row) {
        if (!row || typeof row !== 'object') return [];
        if (Array.isArray(row.parsed && row.parsed.neighbors) && row.parsed.neighbors.length) {
            return row.parsed.neighbors.map((n) => ({
                role: String(n && (n.type || n.role || '') || '').trim() || undefined,
                pci: toInt(n && (n.pci ?? n.sc)),
                earfcn: toInt(n && (n.earfcn ?? n.freq)),
                eci: hasValue(n && (n.eci ?? n.ecgi ?? n.cellId)) ? String(n.eci ?? n.ecgi ?? n.cellId) : undefined,
                name: hasValue(n && (n.cellName ?? n.name)) ? String(n.cellName ?? n.name) : undefined,
                rsrp: toFiniteNumber(n && (n.rsrp ?? n.rscp)),
                rsrq: toFiniteNumber(n && (n.rsrq ?? n.ecno)),
                sinr: toFiniteNumber(n && n.sinr)
            })).filter((n) => Number.isFinite(n.pci) || Number.isFinite(n.earfcn));
        }
        const sources = [row, row.properties].filter((x) => x && typeof x === 'object');
        const found = [];
        sources.forEach((src) => {
            Object.keys(src).forEach((key) => {
                const match = String(key).match(/^([AMDNM]\d+)\s+(PCI|SC|EARFCN|FREQ|RSRP|RSCP|RSRQ|ECNO|ECNO|SINR|ECGI|ECI|CELL NAME|NAME)$/i);
                if (!match) return;
                const bucket = match[1].toUpperCase();
                const field = match[2].toUpperCase();
                let rowObj = found.find((x) => x.role === bucket);
                if (!rowObj) {
                    rowObj = { role: bucket };
                    found.push(rowObj);
                }
                const val = src[key];
                if (field === 'PCI' || field === 'SC') rowObj.pci = toInt(val);
                else if (field === 'EARFCN' || field === 'FREQ') rowObj.earfcn = toInt(val);
                else if (field === 'RSRP' || field === 'RSCP') rowObj.rsrp = toFiniteNumber(val);
                else if (field === 'RSRQ' || field === 'ECNO') rowObj.rsrq = toFiniteNumber(val);
                else if (field === 'SINR') rowObj.sinr = toFiniteNumber(val);
                else if (field === 'ECGI' || field === 'ECI') rowObj.eci = String(val);
                else if (field === 'CELL NAME' || field === 'NAME') rowObj.name = String(val);
            });
        });
        return found.filter((n) => Number.isFinite(n.pci) || Number.isFinite(n.earfcn));
    }

    function normalizeEvent(rawEvent, mapping) {
        const props = rawEvent && rawEvent.properties && typeof rawEvent.properties === 'object' ? rawEvent.properties : {};
        const eventType = valueFromObject(rawEvent, mapping.eventType) ?? valueFromObject(props, mapping.eventType);
        const eventSubtype = valueFromObject(rawEvent, mapping.eventSubtype) ?? valueFromObject(props, mapping.eventSubtype);
        const ts = parseTs(valueFromObject(rawEvent, mapping.pointTime) ?? valueFromObject(props, mapping.pointTime));
        const lat = toFiniteNumber(valueFromObject(rawEvent, mapping.pointLat) ?? valueFromObject(props, mapping.pointLat));
        const lon = toFiniteNumber(valueFromObject(rawEvent, mapping.pointLon) ?? valueFromObject(props, mapping.pointLon));
        const message = String(rawEvent?.message || props?.Message || eventType || '').trim() || undefined;
        return {
            ts,
            lat,
            lon,
            kind: String(eventType || '').trim() || 'event',
            subtype: String(eventSubtype || '').trim() || undefined,
            message,
            raw: rawEvent,
            properties: props
        };
    }

    function normalizePoint(rawPoint, mapping) {
        const props = rawPoint && rawPoint.properties && typeof rawPoint.properties === 'object' ? rawPoint.properties : {};
        const ts = parseTs(valueFromObject(rawPoint, mapping.pointTime) ?? valueFromObject(props, mapping.pointTime));
        const lat = toFiniteNumber(valueFromObject(rawPoint, mapping.pointLat) ?? valueFromObject(props, mapping.pointLat));
        const lon = toFiniteNumber(valueFromObject(rawPoint, mapping.pointLon) ?? valueFromObject(props, mapping.pointLon));
        const technology = normalizeTech(valueFromObject(rawPoint, mapping.technology) ?? valueFromObject(props, mapping.technology) ?? rawPoint.tech);
        const servingCell = {
            pci: toInt(valueFromObject(rawPoint, mapping.servingPci) ?? valueFromObject(props, mapping.servingPci)),
            earfcn: toInt(valueFromObject(rawPoint, mapping.servingEarfcn) ?? valueFromObject(props, mapping.servingEarfcn)),
            eci: hasValue(valueFromObject(rawPoint, mapping.servingEci) ?? valueFromObject(props, mapping.servingEci))
                ? String(valueFromObject(rawPoint, mapping.servingEci) ?? valueFromObject(props, mapping.servingEci))
                : undefined,
            name: hasValue(
                valueFromObject(rawPoint, mapping.servingCellName)
                ?? valueFromObject(props, mapping.servingCellName)
                ?? rawPoint?.parsed?.serving?.cellName
                ?? rawPoint?.parsed?.serving?.name
            ) ? String(
                valueFromObject(rawPoint, mapping.servingCellName)
                ?? valueFromObject(props, mapping.servingCellName)
                ?? rawPoint?.parsed?.serving?.cellName
                ?? rawPoint?.parsed?.serving?.name
            ) : undefined,
            rsrp: toFiniteNumber(valueFromObject(rawPoint, mapping.servingRsrp) ?? valueFromObject(props, mapping.servingRsrp)),
            rsrq: toFiniteNumber(valueFromObject(rawPoint, mapping.servingRsrq) ?? valueFromObject(props, mapping.servingRsrq)),
            sinr: toFiniteNumber(valueFromObject(rawPoint, mapping.servingSinr) ?? valueFromObject(props, mapping.servingSinr))
        };
        const neighbors = parseNeighborFields(rawPoint);
        const events = [];
        const pointEventType = valueFromObject(rawPoint, mapping.eventType) ?? valueFromObject(props, mapping.eventType);
        if (String(rawPoint?.type || '').toUpperCase() === 'EVENT' || (pointEventType && !neighbors.length && !Number.isFinite(servingCell.rsrp) && !Number.isFinite(servingCell.pci))) {
            events.push(normalizeEvent(rawPoint, mapping));
        }
        const config = {
            a3Offset: toFiniteNumber(valueFromObject(rawPoint, mapping.a3Offset) ?? valueFromObject(props, mapping.a3Offset)),
            tttMs: toFiniteNumber(valueFromObject(rawPoint, mapping.tttMs) ?? valueFromObject(props, mapping.tttMs)),
            hysteresisDb: toFiniteNumber(valueFromObject(rawPoint, mapping.hysteresisDb) ?? valueFromObject(props, mapping.hysteresisDb)),
            servingCio: toFiniteNumber(valueFromObject(rawPoint, mapping.servingCio) ?? valueFromObject(props, mapping.servingCio)),
            targetCio: toFiniteNumber(valueFromObject(rawPoint, mapping.targetCio) ?? valueFromObject(props, mapping.targetCio)),
            l3FilterCoeff: toFiniteNumber(valueFromObject(rawPoint, mapping.l3FilterCoeff) ?? valueFromObject(props, mapping.l3FilterCoeff))
        };
        return {
            ts,
            lat,
            lon,
            technology,
            servingCell,
            neighbors,
            events,
            config,
            raw: rawPoint
        };
    }

    function normalizeLogDataset(input, mappingOverrides) {
        const schema = inspectSchema(input);
        const mapping = Object.assign({}, schemaToFieldMapping(schema), mappingOverrides || {});
        const sourcePoints = Array.isArray(input) ? input : (Array.isArray(input && input.points) ? input.points : []);
        const sourceEvents = Array.isArray(input && input.events) ? input.events : [];
        const normalizedPoints = [];
        const normalizedEvents = [];
        sourcePoints.forEach((raw) => {
            const point = normalizePoint(raw, mapping);
            if (Number.isFinite(point.ts)) normalizedPoints.push(point);
            point.events.forEach((ev) => {
                if (Number.isFinite(ev.ts)) normalizedEvents.push(ev);
            });
        });
        sourceEvents.forEach((raw) => {
            const ev = normalizeEvent(raw, mapping);
            if (Number.isFinite(ev.ts)) normalizedEvents.push(ev);
        });
        normalizedPoints.sort((a, b) => a.ts - b.ts);
        normalizedEvents.sort((a, b) => a.ts - b.ts);
        const missingFields = [];
        if (!normalizedPoints.some((p) => normalizeTech(p.technology) === 'LTE')) missingFields.push('technology=LTE');
        if (!normalizedPoints.some((p) => Number.isFinite(p.servingCell.pci))) missingFields.push('serving_pci');
        if (!normalizedPoints.some((p) => Number.isFinite(p.servingCell.earfcn))) missingFields.push('serving_earfcn');
        if (!normalizedPoints.some((p) => Number.isFinite(p.servingCell.rsrp))) missingFields.push('serving_rsrp');
        return {
            mapping,
            schema,
            points: normalizedPoints,
            events: normalizedEvents,
            missingFields,
            meta: {
                pointCount: normalizedPoints.length,
                eventCount: normalizedEvents.length,
                hasNeighborMeasurements: normalizedPoints.some((p) => Array.isArray(p.neighbors) && p.neighbors.length > 0)
            }
        };
    }

    function buildIndexes(points, events) {
        const ltePoints = points.filter((p) => normalizeTech(p.technology) === 'LTE' && Number.isFinite(p.ts));
        return {
            ltePoints,
            events: Array.isArray(events) ? events.filter((e) => Number.isFinite(e.ts)) : []
        };
    }

    function detectServingCellTransitions(points) {
        const transitions = [];
        let prev = null;
        points.forEach((point, idx) => {
            if (!Number.isFinite(point?.ts)) return;
            if (!prev) {
                prev = point;
                return;
            }
            const prevPci = toInt(prev.servingCell && prev.servingCell.pci);
            const currPci = toInt(point.servingCell && point.servingCell.pci);
            const prevEarfcn = toInt(prev.servingCell && prev.servingCell.earfcn);
            const currEarfcn = toInt(point.servingCell && point.servingCell.earfcn);
            const changed = (Number.isFinite(prevPci) && Number.isFinite(currPci) && prevPci !== currPci)
                || (Number.isFinite(prevEarfcn) && Number.isFinite(currEarfcn) && prevEarfcn !== currEarfcn)
                || (hasValue(prev.servingCell?.eci) && hasValue(point.servingCell?.eci) && String(prev.servingCell.eci) !== String(point.servingCell.eci));
            if (changed) {
                transitions.push({
                    id: `transition_${transitions.length + 1}`,
                    boundaryTs: point.ts,
                    beforeIdx: Math.max(0, idx - 1),
                    afterIdx: idx,
                    sourceCell: shallowClone(prev.servingCell),
                    targetCell: shallowClone(point.servingCell),
                    sourcePoint: prev,
                    targetPoint: point
                });
            }
            prev = point;
        });
        return transitions;
    }

    function classifyEventName(event) {
        const name = `${event?.kind || ''} ${event?.subtype || ''} ${event?.message || ''}`.toLowerCase();
        if (/a3\/a5 event|\bhoa\b|ho command|handover command|rrcconnectionreconfiguration/.test(name)) return 'ho_command';
        if (/measurementreport|measurement report/.test(name)) return 'measurement_report';
        if (/handover complete|ho complete|rrcconnectionreconfigurationcomplete|\bhos\b|\bhoi\b/.test(name)) return 'ho_complete';
        if (/rlf|radio link failure|re-establishment|reestablishment|call drop|drop call|hof|handover failure/.test(name)) return 'failure';
        if (/rach|target access|sync/.test(name)) return 'access';
        return 'other';
    }

    function getEventSourceTarget(event) {
        const props = event?.properties || {};
        return {
            sourcePci: toInt(valueFromObject(props, ['HO source PCI', 'rrc_recfg_src_pci', 'Serving PCI'])),
            sourceEarfcn: toInt(valueFromObject(props, ['HO source EARFCN', 'rrc_recfg_src_earfcn', 'Serving EARFCN'])),
            targetPci: toInt(valueFromObject(props, ['HO target PCI', 'rrc_recfg_tgt_pci', 'Target PCI'])),
            targetEarfcn: toInt(valueFromObject(props, ['HO target EARFCN', 'rrc_recfg_tgt_earfcn', 'Target EARFCN'])),
            a3Offset: toFiniteNumber(valueFromObject(props, ['A3 offset', 'rrc_recfg_a3_offset_db'])),
            hysteresisDb: toFiniteNumber(valueFromObject(props, ['HO hysteresis', 'rrc_recfg_hysteresis_db'])),
            tttMs: toFiniteNumber(valueFromObject(props, ['HO TTT', 'Time-to-Trigger', 'rrc_recfg_ttt_ms'])),
            sourceCio: toFiniteNumber(valueFromObject(props, ['source_cio', 'Serving CIO'])),
            targetCio: toFiniteNumber(valueFromObject(props, ['target_cio', 'Target CIO']))
        };
    }

    function getExactA3FromReportEvent(event) {
        const props = event?.properties || {};
        const raw = valueFromObject(props, ['measurement_report_a3_eval_json']);
        if (!hasValue(raw)) return null;
        try {
            const parsed = JSON.parse(String(raw));
            return parsed && typeof parsed === 'object' ? parsed : null;
        } catch (_e) {
            return null;
        }
    }

    function findNearestEvent(events, ts, classifier, maxDeltaMs, predicate) {
        let best = null;
        events.forEach((ev) => {
            if (classifier && classifyEventName(ev) !== classifier) return;
            if (predicate && !predicate(ev)) return;
            const d = Math.abs(ev.ts - ts);
            if (!Number.isFinite(d) || d > maxDeltaMs) return;
            if (!best || d < best.delta) best = { event: ev, delta: d };
        });
        return best ? best.event : null;
    }

    function findPreferredMeasurementReport(events, anchorTs, maxDeltaMs) {
        const candidates = (Array.isArray(events) ? events : []).filter((ev) => {
            if (classifyEventName(ev) !== 'measurement_report') return false;
            const d = Math.abs(Number(ev.ts) - Number(anchorTs));
            return Number.isFinite(d) && d <= maxDeltaMs;
        });
        if (!candidates.length) return null;
        candidates.sort((a, b) => {
            const aExact = getExactA3FromReportEvent(a) ? 1 : 0;
            const bExact = getExactA3FromReportEvent(b) ? 1 : 0;
            if (aExact !== bExact) return bExact - aExact;
            const aBefore = Number(a.ts) <= Number(anchorTs) ? 1 : 0;
            const bBefore = Number(b.ts) <= Number(anchorTs) ? 1 : 0;
            if (aBefore !== bBefore) return bBefore - aBefore;
            return Math.abs(Number(a.ts) - Number(anchorTs)) - Math.abs(Number(b.ts) - Number(anchorTs));
        });
        return candidates[0] || null;
    }

    function findFirstEventAfter(events, ts, classifier, maxDeltaMs, predicate) {
        const filtered = events.filter((ev) => ev.ts >= ts && ev.ts - ts <= maxDeltaMs && (!classifier || classifyEventName(ev) === classifier) && (!predicate || predicate(ev)));
        filtered.sort((a, b) => a.ts - b.ts);
        return filtered[0] || null;
    }

    function isIntraFreq(sourceEarfcn, targetEarfcn) {
        if (!Number.isFinite(sourceEarfcn) || !Number.isFinite(targetEarfcn)) return null;
        return Number(sourceEarfcn) === Number(targetEarfcn);
    }

    function interpolateNearestSample(points, ts, maxGapMs) {
        let best = null;
        for (let i = 0; i < points.length; i++) {
            const p = points[i];
            const d = Math.abs(p.ts - ts);
            if (d > maxGapMs) continue;
            if (!best || d < best.d) best = { p, d };
        }
        return best ? best.p : null;
    }

    function interpolateNearestSampleAtOrBefore(points, ts, maxGapMs) {
        let best = null;
        for (let i = 0; i < points.length; i++) {
            const p = points[i];
            if (!Number.isFinite(p?.ts) || p.ts > ts) continue;
            const d = ts - p.ts;
            if (d > maxGapMs) continue;
            if (!best || d < best.d) best = { p, d };
        }
        return best ? best.p : null;
    }

    function getServingSampleAt(points, ts, maxGapMs) {
        return interpolateNearestSample(points, ts, maxGapMs);
    }

    function getTargetSampleAt(points, ts, targetCell, maxGapMs) {
        const sample = interpolateNearestSample(points, ts, maxGapMs);
        if (!sample) return null;
        const targetPci = toInt(targetCell && targetCell.pci);
        const targetEarfcn = toInt(targetCell && targetCell.earfcn);
        if (Number.isFinite(targetPci) && Number(sample.servingCell?.pci) === targetPci && (!Number.isFinite(targetEarfcn) || Number(sample.servingCell?.earfcn) === targetEarfcn)) {
            return {
                ts: sample.ts,
                rsrp: toFiniteNumber(sample.servingCell?.rsrp),
                rsrq: toFiniteNumber(sample.servingCell?.rsrq),
                sinr: toFiniteNumber(sample.servingCell?.sinr),
                source: 'serving'
            };
        }
        const neighbor = (sample.neighbors || []).find((n) => {
            if (Number.isFinite(targetPci) && Number(n.pci) !== targetPci) return false;
            if (Number.isFinite(targetEarfcn) && Number(n.earfcn) !== targetEarfcn) return false;
            return true;
        });
        if (!neighbor) return null;
        return {
            ts: sample.ts,
            rsrp: toFiniteNumber(neighbor.rsrp),
            rsrq: toFiniteNumber(neighbor.rsrq),
            sinr: toFiniteNumber(neighbor.sinr),
            source: 'neighbor'
        };
    }

    function getBestSameFreqNeighborAt(points, ts, earfcn, excludePci, maxGapMs) {
        const sample = interpolateNearestSample(points, ts, maxGapMs);
        if (!sample || !Array.isArray(sample.neighbors)) return null;
        const filtered = sample.neighbors.filter((n) => {
            if (Number.isFinite(earfcn) && Number(n.earfcn) !== Number(earfcn)) return false;
            if (Number.isFinite(excludePci) && Number(n.pci) === Number(excludePci)) return false;
            return Number.isFinite(n.rsrp);
        }).sort((a, b) => Number(b.rsrp) - Number(a.rsrp));
        return filtered[0] ? Object.assign({ ts: sample.ts }, filtered[0]) : null;
    }

    function computeEffectiveDelta(servingRsrp, targetRsrp, servingCio, targetCio) {
        const s = toFiniteNumber(servingRsrp);
        const t = toFiniteNumber(targetRsrp);
        if (!Number.isFinite(s) || !Number.isFinite(t)) return null;
        return (t + (toFiniteNumber(targetCio) || 0)) - (s + (toFiniteNumber(servingCio) || 0));
    }

    function reconstructWindow(points, event, cfg) {
        const anchorTs = Number.isFinite(event.commandTs) ? event.commandTs : (Number.isFinite(event.startTs) ? event.startTs : event.reportTs);
        const startTs = anchorTs - cfg.RECONSTRUCTION_WINDOW_BEFORE_MS;
        const endTs = anchorTs + cfg.RECONSTRUCTION_WINDOW_AFTER_MS;
        const windowPoints = points.filter((p) => p.ts >= startTs && p.ts <= endTs);
        const servingSeries = [];
        const targetSeries = [];
        const bestNeighborSeries = [];
        const deltaSeries = [];
        windowPoints.forEach((p) => {
            const servingRsrp = toFiniteNumber(p.servingCell?.rsrp);
            const servingRsrq = toFiniteNumber(p.servingCell?.rsrq);
            if (Number.isFinite(servingRsrp)) servingSeries.push({ ts: p.ts, rsrp: servingRsrp, rsrq: servingRsrq, sinr: toFiniteNumber(p.servingCell?.sinr) });
            const target = getTargetSampleAt([p], p.ts, event.targetCell, cfg.MAX_SAMPLE_GAP_MS);
            if (target && Number.isFinite(target.rsrp)) {
                targetSeries.push({ ts: p.ts, rsrp: target.rsrp, rsrq: target.rsrq, sinr: target.sinr, source: target.source });
            }
            const best = getBestSameFreqNeighborAt([p], p.ts, toInt(event.sourceEarfcn), toInt(event.targetCell?.pci), cfg.MAX_SAMPLE_GAP_MS);
            if (best && Number.isFinite(best.rsrp)) bestNeighborSeries.push({ ts: p.ts, pci: best.pci, earfcn: best.earfcn, rsrp: best.rsrp, rsrq: best.rsrq, sinr: best.sinr });
            const eff = computeEffectiveDelta(servingRsrp, target && target.rsrp, event.config?.servingCio, event.config?.targetCio);
            if (Number.isFinite(eff)) deltaSeries.push({ ts: p.ts, effectiveDeltaDb: eff });
        });
        return { startTs, endTs, points: windowPoints, servingSeries, targetSeries, bestNeighborSeries, deltaSeries };
    }

    function estimateFirstTs(series, predicate, minSustainMs) {
        if (!Array.isArray(series) || !series.length) return null;
        for (let i = 0; i < series.length; i++) {
            if (!predicate(series[i])) continue;
            const next = series[i + 1];
            if (!Number.isFinite(minSustainMs) || minSustainMs <= 0) return series[i].ts;
            if (next && next.ts - series[i].ts >= minSustainMs) return series[i].ts;
        }
        return null;
    }

    function findBestAlternativeNeighbor(window, sourceEarfcn, chosenTarget, sourceCell, eventConfig, referenceTs, cfg) {
        const candidates = new Map();
        const refTs = Number.isFinite(referenceTs) ? referenceTs : null;
        const beforeMs = Number.isFinite(cfg?.MR_TO_COMMAND_MAX_MS) ? Math.max(cfg.MR_TO_COMMAND_MAX_MS, 1000) : 3000;
        const afterMs = 400;
        window.points.forEach((p) => {
            if (Number.isFinite(refTs)) {
                if (p.ts < refTs - beforeMs || p.ts > refTs + afterMs) return;
            }
            (p.neighbors || []).forEach((n) => {
                if (!Number.isFinite(n.rsrp)) return;
                if (Number.isFinite(sourceEarfcn) && Number(n.earfcn) !== Number(sourceEarfcn)) return;
                if (Number.isFinite(chosenTarget?.pci) && Number(n.pci) === Number(chosenTarget.pci)) return;
                if (Number.isFinite(sourceCell?.pci) && Number(n.pci) === Number(sourceCell.pci)) return;
                const key = `${n.pci || '?'}|${n.earfcn || '?'}`;
                const delta = computeEffectiveDelta(p.servingCell?.rsrp, n.rsrp, eventConfig?.servingCio, 0);
                if (!Number.isFinite(delta)) return;
                const prev = candidates.get(key);
                if (!prev || delta > prev.bestDeltaDb) {
                    candidates.set(key, {
                        pci: n.pci,
                        earfcn: n.earfcn,
                        name: hasValue(n.name ?? n.cellName) ? String(n.name ?? n.cellName) : undefined,
                        rsrp: n.rsrp,
                        rsrq: n.rsrq,
                        bestDeltaDb: delta,
                        ts: p.ts
                    });
                }
            });
        });
        const arr = Array.from(candidates.values()).sort((a, b) => b.bestDeltaDb - a.bestDeltaDb);
        return arr[0] || null;
    }

    function computeDurations(event) {
        return {
            betterToReportMs: Number.isFinite(event.T_better) && Number.isFinite(event.reportTs) ? event.reportTs - event.T_better : null,
            a3ToReportMs: Number.isFinite(event.T_a3_like) && Number.isFinite(event.reportTs) ? event.reportTs - event.T_a3_like : null,
            reportToCommandMs: Number.isFinite(event.reportTs) && Number.isFinite(event.commandTs) ? event.commandTs - event.reportTs : null,
            commandToCompleteMs: Number.isFinite(event.commandTs) && Number.isFinite(event.completeTs) ? event.completeTs - event.commandTs : null,
            commandToFailMs: Number.isFinite(event.commandTs) && Number.isFinite(event.failTs) ? event.failTs - event.commandTs : null
        };
    }

    function detectPingPong(events, cfg) {
        const bySourceTarget = [];
        for (let i = 0; i < events.length; i++) {
            const ev = events[i];
            for (let j = i + 1; j < events.length; j++) {
                const next = events[j];
                if (!Number.isFinite(ev.completeTs || ev.commandTs) || !Number.isFinite(next.startTs || next.commandTs)) continue;
                const firstTs = ev.completeTs || ev.commandTs;
                const secondTs = next.startTs || next.commandTs;
                if (secondTs - firstTs > cfg.PING_PONG_TIME_MS) break;
                const reverse = Number(ev.sourceCell?.pci) === Number(next.targetCell?.pci) && Number(ev.targetCell?.pci) === Number(next.sourceCell?.pci);
                if (!reverse) continue;
                const firstGeo = ev.geoPoints && ev.geoPoints[ev.geoPoints.length - 1];
                const secondGeo = next.geoPoints && next.geoPoints[0];
                const dist = firstGeo && secondGeo ? distanceMeters(firstGeo.lat, firstGeo.lon, secondGeo.lat, secondGeo.lon) : Infinity;
                if (dist <= cfg.PING_PONG_DISTANCE_M || !Number.isFinite(dist)) {
                    bySourceTarget.push({ firstId: ev.id, secondId: next.id, distanceM: Number.isFinite(dist) ? dist : null, deltaMs: secondTs - firstTs });
                    break;
                }
            }
        }
        return bySourceTarget;
    }

    function buildRecommendedActions(classification, event, cfg) {
        const actions = [];
        if (classification === 'too-late') {
            actions.push('Reduce A3 offset.');
            actions.push('Shorten TTT.');
            actions.push('Review source sector overshooting coverage.');
        } else if (classification === 'too-early') {
            actions.push('Increase A3 offset slightly.');
            actions.push('Increase TTT to reduce premature HO.');
            actions.push('Review CIO balance to avoid weak target preference.');
        } else if (classification === 'ping-pong') {
            actions.push('Increase TTT or hysteresis to reduce ping-pong.');
            actions.push('Review overlap between source and target sectors.');
        } else if (classification === 'wrong-target') {
            actions.push('Verify neighbor definition and target priority.');
            actions.push('Review CIO and neighbor list ordering.');
        } else if (classification === 'execution-failure') {
            actions.push('Investigate target access / HO execution failure.');
            actions.push('Check target coverage and random access stability.');
        } else if (classification === 'missing-report/config-issue') {
            actions.push('Verify measurement reporting configuration.');
            actions.push('Check A3/A5 trigger setup and neighbor meas objects.');
        }
        if (!Number.isFinite(event.config?.servingCio) || !Number.isFinite(event.config?.targetCio)) {
            actions.push('Review CIO values; current analysis assumed CIO = 0.');
        }
        return Array.from(new Set(actions));
    }

    function classifyHandover(event, context, cfg) {
        const reasons = [];
        const assumptions = [];
        const thresholdsUsed = {
            SIGNIFICANT_DELTA_DB: cfg.SIGNIFICANT_DELTA_DB,
            MARGINAL_DELTA_DB: cfg.MARGINAL_DELTA_DB,
            SERVING_WEAK_RSRP_DBM: cfg.SERVING_WEAK_RSRP_DBM,
            SERVING_VERY_WEAK_RSRP_DBM: cfg.SERVING_VERY_WEAK_RSRP_DBM,
            PING_PONG_TIME_MS: cfg.PING_PONG_TIME_MS,
            PING_PONG_DISTANCE_M: cfg.PING_PONG_DISTANCE_M
        };
        if (context.exactA3 && Number.isFinite(context.exactA3?.a3OffsetDb)) thresholdsUsed.EXACT_A3_OFFSET_DB = Number(context.exactA3.a3OffsetDb);
        if (context.exactA3 && Number.isFinite(context.exactA3?.hysteresisDb)) thresholdsUsed.EXACT_A3_HYSTERESIS_DB = Number(context.exactA3.hysteresisDb);
        if (!Number.isFinite(event.config?.servingCio) || !Number.isFinite(event.config?.targetCio)) assumptions.push('CIO not available; assumed zero.');
        if (!context.exactA3 && !Number.isFinite(event.config?.a3Offset)) assumptions.push('A3 offset missing; default heuristic threshold used.');
        if (context.exactA3 && Array.isArray(context.exactA3.assumptions)) assumptions.push(...context.exactA3.assumptions);
        const metrics = event.metrics;
        const sourcePci = toInt(event?.sourceCell?.pci);
        const targetPci = toInt(event?.targetCell?.pci);
        const sourceEci = hasValue(event?.sourceCell?.eci) ? String(event.sourceCell.eci).trim() : '';
        const targetEci = hasValue(event?.targetCell?.eci) ? String(event.targetCell.eci).trim() : '';
        const sameDisplayedPciPair = Number.isFinite(sourcePci) && Number.isFinite(targetPci) && sourcePci === targetPci;
        const distinctCellIdentityProof = !!(sourceEci && targetEci && sourceEci !== targetEci);
        const allowWrongTargetClassification = !sameDisplayedPciPair || distinctCellIdentityProof;
        let classification = 'successful';
        let confidence = 0.55;
        const exactA3Best = context.exactA3 && context.exactA3.bestNeighbor ? context.exactA3.bestNeighbor : null;
        const exactA3Triggered = exactA3Best && exactA3Best.enterSatisfied === true;

        if (context.pingPongPartner) {
            classification = 'ping-pong';
            confidence = 0.92;
            reasons.push(`Serving returned to the old cell within ${context.pingPongPartner.deltaMs} ms.`);
        } else if (event.commandTs && !event.completeTs && event.failTs) {
            classification = 'execution-failure';
            confidence = 0.9;
            reasons.push('HO command exists but completion is missing while a failure marker appears in the execution window.');
        } else if (!event.reportTs && !event.commandTs && context.targetStrongerSustained && (event.failTs || (Number.isFinite(metrics.servingRsrpAtCommandDbm) && metrics.servingRsrpAtCommandDbm <= cfg.SERVING_WEAK_RSRP_DBM))) {
            classification = 'missing-report/config-issue';
            confidence = 0.78;
            reasons.push('Target was stronger for a sustained interval but no report/command was found before degradation/failure.');
        } else if (allowWrongTargetClassification && event.completeTs && context.bestAlternative && Number.isFinite(context.bestAlternative.bestDeltaDb) && Number.isFinite(metrics.effectiveDeltaAtCommandDb) && context.bestAlternative.bestDeltaDb - metrics.effectiveDeltaAtCommandDb >= cfg.WRONG_TARGET_ALT_MARGIN_DB) {
            classification = 'wrong-target';
            confidence = 0.82;
            reasons.push(`Another same-frequency neighbor had ${context.bestAlternative.bestDeltaDb.toFixed(1)} dB dominance, exceeding the chosen target by at least ${cfg.WRONG_TARGET_ALT_MARGIN_DB.toFixed(1)} dB.`);
        } else if (Number.isFinite(metrics.effectiveDeltaAtCommandDb) && metrics.effectiveDeltaAtCommandDb >= cfg.SIGNIFICANT_DELTA_DB && Number.isFinite(metrics.servingRsrpAtCommandDbm) && metrics.servingRsrpAtCommandDbm <= cfg.SERVING_WEAK_RSRP_DBM && (event.failTs || metrics.servingRsrpAtCommandDbm <= cfg.SERVING_VERY_WEAK_RSRP_DBM)) {
            classification = 'too-late';
            confidence = 0.88;
            reasons.push(`Target cell was stronger than serving by ${metrics.effectiveDeltaAtCommandDb.toFixed(1)} dB before or at HO command.`);
            reasons.push(`Serving RSRP at command time had already dropped to ${metrics.servingRsrpAtCommandDbm.toFixed(1)} dBm.`);
            if (event.failTs && Number.isFinite(metrics.commandToFailMs)) reasons.push(`Failure followed ${metrics.commandToFailMs} ms after the HO command.`);
        } else if (event.commandTs && event.completeTs && Number.isFinite(metrics.effectiveDeltaAtCommandDb) && metrics.effectiveDeltaAtCommandDb <= cfg.MARGINAL_DELTA_DB && Number.isFinite(metrics.servingRsrpAtCommandDbm) && metrics.servingRsrpAtCommandDbm > cfg.SERVING_WEAK_RSRP_DBM) {
            classification = 'too-early';
            confidence = 0.76;
            reasons.push(`Target advantage at command time was only ${metrics.effectiveDeltaAtCommandDb.toFixed(1)} dB while serving RSRP remained ${metrics.servingRsrpAtCommandDbm.toFixed(1)} dBm.`);
        } else if (event.completeTs && !event.failTs) {
            classification = 'successful';
            confidence = 0.74;
            reasons.push('HO command and completion were both found with no failure marker in the execution window.');
        }

        if (exactA3Triggered && Number.isFinite(exactA3Best.deltaVsThreshold)) {
            reasons.unshift(`Exact A3 evaluation at report time was satisfied for PCI ${Number.isFinite(exactA3Best.pci) ? exactA3Best.pci : '?'} with margin ${exactA3Best.deltaVsThreshold.toFixed(1)} dB over the configured threshold.`);
            confidence = Math.min(0.97, confidence + 0.06);
        } else if (context.exactA3 && exactA3Best && exactA3Best.enterSatisfied === false && Number.isFinite(exactA3Best.deltaVsThreshold)) {
            reasons.unshift(`Exact A3 evaluation at report time was not satisfied; best candidate PCI ${Number.isFinite(exactA3Best.pci) ? exactA3Best.pci : '?'} stayed ${Math.abs(exactA3Best.deltaVsThreshold).toFixed(1)} dB below the entering threshold.`);
            confidence = Math.min(0.97, confidence + 0.04);
        }

        if (!allowWrongTargetClassification && sameDisplayedPciPair) {
            assumptions.push('Wrong-target classification suppressed because source/target PCI are identical and distinct ECGI/ECI proof is unavailable.');
        }

        if (!reasons.length) reasons.push('Classification fell back to best-effort heuristic due to incomplete signaling or radio evidence.');
        return {
            label: classification,
            confidence,
            reasons,
            thresholdsUsed,
            assumptions,
            recommendedActions: buildRecommendedActions(classification, event, cfg)
        };
    }

    function correlateMobilityEvents(normalized, transitions, cfg) {
        const points = normalized.points;
        const events = normalized.events;
        const hoEvents = [];
        transitions.forEach((transition, idx) => {
            const startTs = transition.boundaryTs;
            const sourceCell = shallowClone(transition.sourceCell);
            const targetCell = shallowClone(transition.targetCell);
            const matchingCommand = findNearestEvent(events, startTs, 'ho_command', cfg.MR_TO_COMMAND_MAX_MS, (ev) => {
                const ctx = getEventSourceTarget(ev);
                if (Number.isFinite(ctx.targetPci) && Number.isFinite(targetCell.pci) && ctx.targetPci !== Number(targetCell.pci)) return false;
                return true;
            });
            const commandTs = matchingCommand ? matchingCommand.ts : null;
            const correlationAnchorTs = Number.isFinite(commandTs) ? commandTs : startTs;
            const reportEvent = findPreferredMeasurementReport(events, correlationAnchorTs, cfg.MR_TO_COMMAND_MAX_MS)
                || findNearestEvent(events, correlationAnchorTs, 'measurement_report', cfg.MR_TO_COMMAND_MAX_MS, null);
            const completeEvent = findFirstEventAfter(events, correlationAnchorTs, 'ho_complete', cfg.COMMAND_TO_COMPLETE_MAX_MS, null);
            const failEvent = Number.isFinite(commandTs)
                ? findFirstEventAfter(events, correlationAnchorTs, 'failure', cfg.COMMAND_TO_FAIL_MAX_MS, null)
                : findNearestEvent(events, correlationAnchorTs, 'failure', cfg.COMMAND_TO_FAIL_MAX_MS, null);
            const accessEvent = findFirstEventAfter(events, correlationAnchorTs, 'access', cfg.COMMAND_TO_COMPLETE_MAX_MS, null);
            const commandCtx = getEventSourceTarget(matchingCommand);
            const effectiveSource = {
                pci: Number.isFinite(commandCtx.sourcePci) ? commandCtx.sourcePci : sourceCell.pci,
                earfcn: Number.isFinite(commandCtx.sourceEarfcn) ? commandCtx.sourceEarfcn : sourceCell.earfcn,
                eci: sourceCell.eci,
                name: sourceCell.name
            };
            const effectiveTarget = {
                pci: Number.isFinite(commandCtx.targetPci) ? commandCtx.targetPci : targetCell.pci,
                earfcn: Number.isFinite(commandCtx.targetEarfcn) ? commandCtx.targetEarfcn : targetCell.earfcn,
                eci: targetCell.eci,
                name: targetCell.name
            };
            const isIntra = isIntraFreq(effectiveSource.earfcn, effectiveTarget.earfcn);
            const eventConfig = {
                a3Offset: Number.isFinite(commandCtx.a3Offset) ? commandCtx.a3Offset : (Number.isFinite(transition.sourcePoint?.config?.a3Offset) ? transition.sourcePoint.config.a3Offset : null),
                tttMs: Number.isFinite(commandCtx.tttMs) ? commandCtx.tttMs : (Number.isFinite(transition.sourcePoint?.config?.tttMs) ? transition.sourcePoint.config.tttMs : null),
                hysteresisDb: Number.isFinite(commandCtx.hysteresisDb) ? commandCtx.hysteresisDb : (Number.isFinite(transition.sourcePoint?.config?.hysteresisDb) ? transition.sourcePoint.config.hysteresisDb : null),
                servingCio: Number.isFinite(commandCtx.sourceCio) ? commandCtx.sourceCio : (Number.isFinite(transition.sourcePoint?.config?.servingCio) ? transition.sourcePoint.config.servingCio : 0),
                targetCio: Number.isFinite(commandCtx.targetCio) ? commandCtx.targetCio : (Number.isFinite(transition.sourcePoint?.config?.targetCio) ? transition.sourcePoint.config.targetCio : 0),
                l3FilterCoeff: Number.isFinite(transition.sourcePoint?.config?.l3FilterCoeff) ? transition.sourcePoint.config.l3FilterCoeff : null
            };
            const event = {
                id: `ho_${String(idx + 1).padStart(5, '0')}`,
                sourceCell: effectiveSource,
                targetCell: effectiveTarget,
                sourceEarfcn: effectiveSource.earfcn,
                targetEarfcn: effectiveTarget.earfcn,
                isIntraFreq: isIntra,
                startTs,
                reportTs: reportEvent ? reportEvent.ts : null,
                commandTs,
                accessTs: accessEvent ? accessEvent.ts : null,
                completeTs: completeEvent ? completeEvent.ts : (!failEvent ? transition.targetPoint.ts : null),
                failTs: failEvent ? failEvent.ts : null,
                servingMetricsAtCommand: null,
                targetMetricsAtCommand: null,
                bestNeighborAtCommand: null,
                effectiveDeltaAtReport: null,
                effectiveDeltaAtCommand: null,
                classification: null,
                confidence: null,
                reasons: [],
                kpiFlags: [],
                geoPoints: [
                    { lat: transition.sourcePoint.lat, lon: transition.sourcePoint.lon, ts: transition.sourcePoint.ts, label: 'before' },
                    { lat: transition.targetPoint.lat, lon: transition.targetPoint.lon, ts: transition.targetPoint.ts, label: 'after' }
                ].filter((x) => Number.isFinite(x.lat) && Number.isFinite(x.lon)),
                rawRefs: {
                    transition,
                    reportEvent,
                    commandEvent: matchingCommand,
                    completeEvent,
                    failEvent,
                    accessEvent
                },
                config: eventConfig
            };
            hoEvents.push(event);
        });
        return hoEvents;
    }

    function enrichHandoverEvents(events, normalized, cfg) {
        const points = normalized.points;
        events.forEach((event) => {
            const window = reconstructWindow(points, event, cfg);
            const sourcePointTs = Number(event.rawRefs?.transition?.sourcePoint?.ts);
            const reportTs = Number(event.reportTs);
            const commandTs = Number(event.commandTs);
            const startTs = Number(event.startTs);
            const decisionTs = Number.isFinite(sourcePointTs)
                ? sourcePointTs
                : (reportTs || commandTs || startTs);
            const decisionSampleSource = Number.isFinite(sourcePointTs)
                ? 'pre-HO source sample'
                : (Number.isFinite(reportTs)
                    ? 'report sample'
                    : (Number.isFinite(commandTs)
                        ? 'command sample'
                        : 'fallback transition sample'));
            const servingAtCommand = interpolateNearestSampleAtOrBefore(points, decisionTs, cfg.MAX_SAMPLE_GAP_MS) || getServingSampleAt(points, decisionTs, cfg.MAX_SAMPLE_GAP_MS);
            const targetAtCommand = getTargetSampleAt(
                [servingAtCommand].filter(Boolean),
                decisionTs,
                event.targetCell,
                cfg.MAX_SAMPLE_GAP_MS
            ) || getTargetSampleAt(points, decisionTs, event.targetCell, cfg.MAX_SAMPLE_GAP_MS);
            const reportServing = getServingSampleAt(points, event.reportTs || event.commandTs || event.startTs, cfg.MAX_SAMPLE_GAP_MS);
            const reportTarget = getTargetSampleAt(points, event.reportTs || event.commandTs || event.startTs, event.targetCell, cfg.MAX_SAMPLE_GAP_MS);
            const exactA3 = getExactA3FromReportEvent(event.rawRefs?.reportEvent);
            const bestNeighborAtCommand = getBestSameFreqNeighborAt(
                [servingAtCommand].filter(Boolean),
                decisionTs,
                event.sourceEarfcn,
                event.targetCell?.pci,
                cfg.MAX_SAMPLE_GAP_MS
            ) || getBestSameFreqNeighborAt(points, decisionTs, event.sourceEarfcn, event.targetCell?.pci, cfg.MAX_SAMPLE_GAP_MS);
            event.servingMetricsAtCommand = servingAtCommand ? {
                rsrp: toFiniteNumber(servingAtCommand.servingCell?.rsrp),
                rsrq: toFiniteNumber(servingAtCommand.servingCell?.rsrq),
                sinr: toFiniteNumber(servingAtCommand.servingCell?.sinr)
            } : null;
            event.targetMetricsAtCommand = targetAtCommand ? {
                rsrp: targetAtCommand.rsrp,
                rsrq: targetAtCommand.rsrq,
                sinr: targetAtCommand.sinr
            } : null;
            event.bestNeighborAtCommand = bestNeighborAtCommand ? shallowClone(bestNeighborAtCommand) : null;
            event.decisionSampleTs = Number.isFinite(decisionTs) ? decisionTs : null;
            event.decisionSampleSource = decisionSampleSource;
            event.exactA3 = exactA3 ? shallowClone(exactA3) : null;
            event.effectiveDeltaAtCommand = computeEffectiveDelta(event.servingMetricsAtCommand?.rsrp, event.targetMetricsAtCommand?.rsrp, event.config.servingCio, event.config.targetCio);
            event.effectiveDeltaAtReport = computeEffectiveDelta(reportServing?.servingCell?.rsrp, reportTarget?.rsrp, event.config.servingCio, event.config.targetCio);
            event.T_better = estimateFirstTs(window.points.map((p) => {
                const target = getTargetSampleAt([p], p.ts, event.targetCell, cfg.MAX_SAMPLE_GAP_MS);
                return {
                    ts: p.ts,
                    delta: Number.isFinite(target?.rsrp) && Number.isFinite(p.servingCell?.rsrp) ? target.rsrp - p.servingCell.rsrp : null
                };
            }).filter((x) => Number.isFinite(x.delta)), (x) => x.delta > 0, cfg.SUSTAINED_STRONGER_MS);
            const a3Threshold = Number.isFinite(event.config.a3Offset) ? event.config.a3Offset : cfg.DEFAULT_A3_OFFSET_DB;
            event.T_a3_like = exactA3 && exactA3.bestNeighbor && exactA3.bestNeighbor.enterSatisfied === true && Number.isFinite(event.reportTs)
                ? event.reportTs
                : estimateFirstTs(window.deltaSeries, (x) => Number.isFinite(x.effectiveDeltaDb) && x.effectiveDeltaDb >= a3Threshold, cfg.SUSTAINED_STRONGER_MS);
            const postHoServing = getServingSampleAt(points, (event.completeTs || event.commandTs || event.startTs) + Math.min(cfg.STABLE_DWELL_MS, cfg.RECONSTRUCTION_WINDOW_AFTER_MS), cfg.MAX_SAMPLE_GAP_MS);
            const postHoQualityGain = Number.isFinite(postHoServing?.servingCell?.rsrp) && Number.isFinite(servingAtCommand?.servingCell?.rsrp)
                ? postHoServing.servingCell.rsrp - servingAtCommand.servingCell.rsrp
                : null;
            event.metrics = Object.assign(computeDurations(event), {
                effectiveDeltaAtCommandDb: event.effectiveDeltaAtCommand,
                effectiveDeltaAtReportDb: event.effectiveDeltaAtReport,
                servingRsrpAtCommandDbm: toFiniteNumber(event.servingMetricsAtCommand?.rsrp),
                servingRsrqAtCommandDb: toFiniteNumber(event.servingMetricsAtCommand?.rsrq),
                targetRsrpAtCommandDbm: toFiniteNumber(event.targetMetricsAtCommand?.rsrp),
                targetRsrqAtCommandDb: toFiniteNumber(event.targetMetricsAtCommand?.rsrq),
                bestNeighborDeltaAtCommandDb: computeEffectiveDelta(event.servingMetricsAtCommand?.rsrp, bestNeighborAtCommand?.rsrp, event.config.servingCio, 0),
                postHoQualityGainDb: postHoQualityGain,
                exactA3TriggeredAtReport: exactA3 && exactA3.bestNeighbor ? exactA3.bestNeighbor.enterSatisfied : null,
                exactA3MarginAtReportDb: exactA3 && exactA3.bestNeighbor ? toFiniteNumber(exactA3.bestNeighbor.deltaVsThreshold) : null,
                exactA3BestNeighborPci: exactA3 && exactA3.bestNeighbor ? toInt(exactA3.bestNeighbor.pci) : null
            });
            event.chart = buildChartOutput(event, window);
            event.map = buildMapOutput(event, window);
            event.debug = buildDebugOutput(event, window);
        });
        const pingPongs = detectPingPong(events, cfg);
        const byId = new Map(events.map((ev) => [ev.id, ev]));
        pingPongs.forEach((pp) => {
            const first = byId.get(pp.firstId);
            const second = byId.get(pp.secondId);
            if (first) first._pingPongPartner = pp;
            if (second) second._pingPongPartner = pp;
        });
        events.forEach((event) => {
            const referenceTs = Number.isFinite(event.reportTs)
                ? event.reportTs
                : (Number.isFinite(event.commandTs) ? event.commandTs : Number(event.rawRefs?.transition?.sourcePoint?.ts));
            const bestAlternative = findBestAlternativeNeighbor(
                reconstructWindow(points, event, cfg),
                event.sourceEarfcn,
                event.targetCell,
                event.sourceCell,
                event.config,
                referenceTs,
                cfg
            );
            const targetStrongerSustained = Number.isFinite(event.T_better) && (!Number.isFinite(event.reportTs) || event.reportTs - event.T_better >= cfg.SUSTAINED_STRONGER_MS);
            const classification = classifyHandover(event, {
                pingPongPartner: event._pingPongPartner || null,
                bestAlternative,
                targetStrongerSustained,
                exactA3: event.exactA3 || null
            }, cfg);
            event.classification = classification.label;
            event.confidence = classification.confidence;
            event.reasons = classification.reasons;
            event.assumptions = classification.assumptions;
            event.thresholdsUsed = classification.thresholdsUsed;
            event.recommendedActions = classification.recommendedActions;
            event.bestAlternative = bestAlternative;
            event.kpiFlags = buildKpiFlags(event);
        });
        return events;
    }

    function buildKpiFlags(event) {
        const flags = [];
        if (event.isIntraFreq === true) flags.push('intrafreq');
        if (event.classification === 'successful') flags.push('success');
        if (event.classification === 'execution-failure') flags.push('execution_failure');
        if (event.classification === 'too-late') flags.push('too_late');
        if (event.classification === 'too-early') flags.push('too_early');
        if (event.classification === 'ping-pong') flags.push('ping_pong');
        if (event.classification === 'wrong-target') flags.push('wrong_target');
        if (event.classification === 'missing-report/config-issue') flags.push('missing_report_config');
        return flags;
    }

    function buildChartOutput(event, window) {
        return {
            startTs: window.startTs,
            endTs: window.endTs,
            series: {
                servingRsrp: window.servingSeries.map((p) => ({ ts: p.ts, value: p.rsrp })),
                targetRsrp: window.targetSeries.map((p) => ({ ts: p.ts, value: p.rsrp })),
                bestSameFreqNeighborRsrp: window.bestNeighborSeries.map((p) => ({ ts: p.ts, value: p.rsrp, pci: p.pci })),
                servingRsrq: window.servingSeries.map((p) => ({ ts: p.ts, value: p.rsrq })),
                targetRsrq: window.targetSeries.map((p) => ({ ts: p.ts, value: p.rsrq })),
                effectiveDelta: window.deltaSeries.map((p) => ({ ts: p.ts, value: p.effectiveDeltaDb }))
            },
            markers: [
                { key: 'decision', ts: event.decisionSampleTs },
                { key: 'target_better', ts: event.T_better },
                { key: 'a3_like', ts: event.T_a3_like },
                { key: 'report', ts: event.reportTs },
                { key: 'command', ts: event.commandTs },
                { key: 'access', ts: event.accessTs },
                { key: 'complete', ts: event.completeTs },
                { key: 'fail', ts: event.failTs }
            ].filter((m) => Number.isFinite(m.ts))
        };
    }

    function buildMapOutput(event, window) {
        return {
            reportPoint: buildMarkerPoint(event.rawRefs?.reportEvent),
            commandPoint: buildMarkerPoint(event.rawRefs?.commandEvent),
            completePoint: buildMarkerPoint(event.rawRefs?.completeEvent || event.rawRefs?.transition?.targetPoint),
            failPoint: buildMarkerPoint(event.rawRefs?.failEvent),
            polyline: window.points
                .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon))
                .map((p) => ({ lat: p.lat, lon: p.lon, ts: p.ts }))
        };
    }

    function buildMarkerPoint(raw) {
        const source = raw && raw.raw ? raw.raw : raw;
        if (!source) return null;
        const lat = toFiniteNumber(source.lat ?? source.latitude ?? source?.raw?.lat);
        const lon = toFiniteNumber(source.lon ?? source.lng ?? source.longitude ?? source?.raw?.lng);
        const ts = parseTs(source.ts ?? source.time ?? source.timestamp);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
        return { lat, lon, ts: Number.isFinite(ts) ? ts : null };
    }

    function buildDebugOutput(event, window) {
        const missing = [];
        if (!Number.isFinite(event.sourceEarfcn)) missing.push('source_earfcn');
        if (!Number.isFinite(event.targetEarfcn)) missing.push('target_earfcn');
        if (!Number.isFinite(event.metrics?.servingRsrpAtCommandDbm)) missing.push('serving_rsrp_at_command');
        if (!Number.isFinite(event.metrics?.targetRsrpAtCommandDbm)) missing.push('target_rsrp_at_command');
        const reportProps = event.rawRefs?.reportEvent?.properties || {};
        let exactA3Eval = null;
        const exactA3EvalRaw = valueFromObject(reportProps, ['measurement_report_a3_eval_json']);
        if (hasValue(exactA3EvalRaw)) {
            try {
                exactA3Eval = JSON.parse(String(exactA3EvalRaw));
            } catch (_e) {
                exactA3Eval = null;
            }
        }
        return {
            matchedRawEvents: {
                report: event.rawRefs?.reportEvent || null,
                command: event.rawRefs?.commandEvent || null,
                complete: event.rawRefs?.completeEvent || null,
                fail: event.rawRefs?.failEvent || null
            },
            exactA3: {
                mappingSummary: valueFromObject(reportProps, ['measurement_report_a3_mapping_summary']) || null,
                sourceTime: valueFromObject(reportProps, ['measurement_report_a3_source_time']) || null,
                sourcePci: valueFromObject(reportProps, ['measurement_report_a3_source_pci']) || null,
                evaluationSummary: valueFromObject(reportProps, ['measurement_report_a3_eval_summary']) || null,
                evaluation: exactA3Eval
            },
            assumptionsUsed: event.assumptions || [],
            missingFields: missing,
            windowPointCount: window.points.length
        };
    }

    function aggregateKpis(events) {
        const totals = {
            totalLteHos: events.length,
            totalIntraFreqHos: events.filter((e) => e.isIntraFreq === true).length,
            intrafreqHoSuccessRate: null,
            intrafreqHoExecutionFailureRate: null,
            tooLateCount: 0,
            tooEarlyCount: 0,
            pingPongCount: 0,
            wrongTargetCount: 0,
            missingReportConfigIssueCount: 0,
            averageReportToCommandMs: null,
            averageCommandToCompleteMs: null,
            averageEffectiveDeltaAtCommand: null,
            averageServingRsrpAtCommand: null,
            averageTargetRsrpAtCommand: null
        };
        const intra = events.filter((e) => e.isIntraFreq === true);
        const countByClass = (label) => intra.filter((e) => e.classification === label).length;
        totals.tooLateCount = countByClass('too-late');
        totals.tooEarlyCount = countByClass('too-early');
        totals.pingPongCount = countByClass('ping-pong');
        totals.wrongTargetCount = countByClass('wrong-target');
        totals.missingReportConfigIssueCount = countByClass('missing-report/config-issue');
        totals.executionFailureCount = countByClass('execution-failure');
        totals.successCount = countByClass('successful');
        totals.intrafreqHoSuccessRate = intra.length ? totals.successCount / intra.length : null;
        totals.intrafreqHoExecutionFailureRate = intra.length ? totals.executionFailureCount / intra.length : null;
        const avg = (vals) => vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
        totals.averageReportToCommandMs = avg(intra.map((e) => e.metrics?.reportToCommandMs).filter(Number.isFinite));
        totals.averageCommandToCompleteMs = avg(intra.map((e) => e.metrics?.commandToCompleteMs).filter(Number.isFinite));
        totals.averageEffectiveDeltaAtCommand = avg(intra.map((e) => e.metrics?.effectiveDeltaAtCommandDb).filter(Number.isFinite));
        totals.averageServingRsrpAtCommand = avg(intra.map((e) => e.metrics?.servingRsrpAtCommandDbm).filter(Number.isFinite));
        totals.averageTargetRsrpAtCommand = avg(intra.map((e) => e.metrics?.targetRsrpAtCommandDbm).filter(Number.isFinite));

        const groupBy = (keyFn) => {
            const map = new Map();
            intra.forEach((ev) => {
                const key = keyFn(ev);
                const bucket = map.get(key) || { total: 0, successful: 0, executionFailure: 0, tooLate: 0, tooEarly: 0, pingPong: 0, wrongTarget: 0, missingReportConfigIssue: 0 };
                bucket.total += 1;
                if (ev.classification === 'successful') bucket.successful += 1;
                if (ev.classification === 'execution-failure') bucket.executionFailure += 1;
                if (ev.classification === 'too-late') bucket.tooLate += 1;
                if (ev.classification === 'too-early') bucket.tooEarly += 1;
                if (ev.classification === 'ping-pong') bucket.pingPong += 1;
                if (ev.classification === 'wrong-target') bucket.wrongTarget += 1;
                if (ev.classification === 'missing-report/config-issue') bucket.missingReportConfigIssue += 1;
                map.set(key, bucket);
            });
            return Object.fromEntries(map.entries());
        };

        return {
            summary: totals,
            bySourceCell: groupBy((ev) => `${ev.sourceCell?.pci || '?'}|${ev.sourceCell?.earfcn || '?'}`),
            bySourceTargetPair: groupBy((ev) => `${ev.sourceCell?.pci || '?'}:${ev.sourceCell?.earfcn || '?'}->${ev.targetCell?.pci || '?'}:${ev.targetCell?.earfcn || '?'}`),
            byRouteSegment: groupBy((ev) => `${Math.round((ev.startTs || 0) / 60000)}`),
            byLogfile: groupBy((ev) => String(ev.rawRefs?.transition?.sourcePoint?.raw?.logfile_id || ev.rawRefs?.transition?.sourcePoint?.raw?.file || 'default')),
            byDevice: groupBy((ev) => String(ev.rawRefs?.transition?.sourcePoint?.raw?.device_id || 'default'))
        };
    }

    function createEventSummaryCard(event) {
        return {
            id: event.id,
            sourceCell: event.sourceCell,
            targetCell: event.targetCell,
            earfcn: event.sourceEarfcn,
            intraInterLabel: event.isIntraFreq === true ? 'IntraFreq' : (event.isIntraFreq === false ? 'InterFreq' : 'Unknown'),
            resultLabel: event.classification,
            confidence: event.confidence,
            keyExplanation: event.reasons && event.reasons[0] ? event.reasons[0] : ''
        };
    }

    function analyzeIntraFreqHo(input, options) {
        const cfg = createConfig(options && options.config);
        const normalized = normalizeLogDataset(input, options && options.mapping);
        const indexes = buildIndexes(normalized.points, normalized.events);
        const transitions = detectServingCellTransitions(indexes.ltePoints);
        const candidates = correlateMobilityEvents(normalized, transitions, cfg);
        const enriched = enrichHandoverEvents(candidates, normalized, cfg);
        const kpis = aggregateKpis(enriched);
        return {
            generatedAt: new Date().toISOString(),
            config: cfg,
            schema: normalized.schema,
            mapping: normalized.mapping,
            normalization: {
                missingFields: normalized.missingFields,
                pointCount: normalized.meta.pointCount,
                eventCount: normalized.meta.eventCount,
                hasNeighborMeasurements: normalized.meta.hasNeighborMeasurements
            },
            summaryCards: enriched.map(createEventSummaryCard),
            events: enriched,
            kpis,
            debug: {
                transitionsDetected: transitions.length,
                normalizedEventCount: normalized.events.length,
                normalizedPointCount: normalized.points.length
            }
        };
    }

    return {
        DEFAULT_CONFIG,
        DEFAULT_MAPPING,
        createConfig,
        inspectSchema,
        schemaToFieldMapping,
        normalizeLogDataset,
        detectServingCellTransitions,
        correlateMobilityEvents,
        isIntraFreq,
        getServingSampleAt,
        getTargetSampleAt,
        getBestSameFreqNeighborAt,
        interpolateNearestSample,
        computeEffectiveDelta,
        detectPingPong,
        findBestAlternativeNeighbor,
        classifyHandover,
        aggregateKpis,
        analyzeIntraFreqHo,
        distanceMeters
    };
});

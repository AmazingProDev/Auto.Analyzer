import os
import re
import zlib
from datetime import datetime, timezone
from xml.etree import ElementTree as ET


MAX_FRAME_SCAN = 2_000_000
MAX_RECORD_LEN = 262144


def utc_iso_from_epoch_seconds(epoch_s):
    try:
        return datetime.fromtimestamp(float(epoch_s), tz=timezone.utc).isoformat().replace('+00:00', 'Z')
    except Exception:
        return None


def parse_iso(ts):
    if not ts:
        return None
    try:
        if ts.endswith('Z'):
            ts = ts[:-1] + '+00:00'
        return datetime.fromisoformat(ts)
    except Exception:
        return None


def decode_maybe_compressed(buf):
    if buf is None:
        raise ValueError('Empty input buffer')
    if len(buf) == 0:
        return {'dataBuf': b'', 'method': 'plain'}

    attempts = []

    def _find_zlib_start(b: bytes, max_scan: int = 64) -> int:
        max_i = min(len(b) - 2, max_scan)
        for i in range(max_i):
            if b[i] == 0x78 and b[i + 1] in (0x01, 0x9C, 0xDA):
                return i
        return -1

    start = _find_zlib_start(buf)
    payload = buf[start:] if start >= 0 else buf

    try:
        out = zlib.decompress(payload)
        return {'dataBuf': out, 'method': 'zlib', 'offset': (start if start >= 0 else 0)}
    except Exception as e:
        attempts.append(f'zlib:{e}')

    try:
        out = zlib.decompress(payload, -zlib.MAX_WBITS)
        if len(out) >= max(8, int(len(payload) * 0.2)):
            return {'dataBuf': out, 'method': 'rawdeflate', 'offset': (start if start >= 0 else 0)}
        attempts.append(f'rawdeflate:output_too_small({len(out)})')
    except Exception as e:
        attempts.append(f'rawdeflate:{e}')

    if start >= 0:
        raise ValueError('Found zlib header but decompression failed: ' + '; '.join(attempts))

    return {'dataBuf': buf, 'method': 'plain', 'offset': 0}


def read_varint(data, pos):
    shift = 0
    result = 0
    start = pos
    while pos < len(data):
        b = data[pos]
        pos += 1
        result |= (b & 0x7F) << shift
        if not (b & 0x80):
            return result, pos
        shift += 7
        if shift > 70:
            break
    return None, start


def decode_zigzag(n):
    if n is None:
        return None
    return (n >> 1) ^ (-(n & 1))


def _decode_float32_le(b):
    import struct
    try:
        return float(struct.unpack('<f', b)[0])
    except Exception:
        return None


def _decode_float64_le(b):
    import struct
    try:
        return float(struct.unpack('<d', b)[0])
    except Exception:
        return None


def iter_fields(data, max_fields=100000):
    pos = 0
    count = 0
    ln = len(data)
    while pos < ln and count < max_fields:
        key, pos2 = read_varint(data, pos)
        if key is None or pos2 <= pos:
            break
        pos = pos2
        field_no = key >> 3
        wire = key & 0x07
        if wire == 0:
            val, pos3 = read_varint(data, pos)
            if val is None or pos3 <= pos:
                break
            pos = pos3
            yield field_no, wire, val
        elif wire == 1:
            if pos + 8 > ln:
                break
            yield field_no, wire, data[pos:pos + 8]
            pos += 8
        elif wire == 2:
            length, pos3 = read_varint(data, pos)
            if length is None or length < 0 or pos3 + length > ln:
                break
            pos = pos3
            yield field_no, wire, data[pos:pos + length]
            pos += length
        elif wire == 5:
            if pos + 4 > ln:
                break
            yield field_no, wire, data[pos:pos + 4]
            pos += 4
        else:
            break
        count += 1


def try_decode_text(b):
    if not b:
        return None
    for enc in ('utf-8', 'latin1'):
        try:
            s = b.decode(enc)
            s = s.strip('\x00').strip()
            if s:
                return s
        except Exception:
            continue
    return None


def parse_track_xml(path):
    points = []
    if not os.path.exists(path):
        return points
    try:
        root = ET.parse(path).getroot()
        for elem in root.iter():
            tag = elem.tag.lower()
            if not (tag.endswith('trkpt') or tag.endswith('wpt') or tag.endswith('point')):
                continue
            lat = elem.attrib.get('lat') or elem.attrib.get('latitude')
            lon = elem.attrib.get('lon') or elem.attrib.get('longitude')
            if lat is None or lon is None:
                continue
            try:
                lat_f = float(lat)
                lon_f = float(lon)
            except Exception:
                continue
            ts = None
            speed = None
            alt = None
            for c in list(elem):
                ctag = c.tag.lower()
                text = (c.text or '').strip()
                if ctag.endswith('time') and text:
                    ts = text
                elif ctag.endswith('speed') and text:
                    try:
                        speed = float(text)
                    except Exception:
                        pass
                elif ctag.endswith('ele') and text:
                    try:
                        alt = float(text)
                    except Exception:
                        pass
            points.append({'time': ts, 'lat': lat_f, 'lon': lon_f, 'alt': alt, 'speed': speed})
    except Exception:
        return []
    return points


def parse_lookup_tables(buf):
    out = {}
    for _, wire, payload in iter_fields(buf, max_fields=300000):
        if wire != 2:
            continue
        table_name = None
        table = {}
        for _, w2, v2 in iter_fields(payload, max_fields=500):
            if w2 == 2:
                s = try_decode_text(v2)
                if s and table_name is None and len(s) < 120:
                    table_name = s
                # nested enum entries
                if v2:
                    enum_val = None
                    enum_name = None
                    for _, w3, v3 in iter_fields(v2, max_fields=50):
                        if w3 == 0 and enum_val is None and isinstance(v3, int):
                            enum_val = int(v3)
                        elif w3 == 2 and enum_name is None:
                            s3 = try_decode_text(v3)
                            if s3:
                                enum_name = s3
                    if enum_val is not None and enum_name:
                        table[enum_val] = enum_name
        if table_name and table:
            out[table_name] = table
    return out


def parse_declarations(buf):
    metric_map = {}
    unknown_records = []
    # try record-wise parse first
    for _, wire, payload in iter_fields(buf, max_fields=400000):
        if wire != 2:
            continue
        name = None
        metric_id = None
        dtype = 'unknown'
        lookup = None
        strings = []
        ints = []
        for f2, w2, v2 in iter_fields(payload, max_fields=500):
            if w2 == 2:
                s = try_decode_text(v2)
                if s:
                    strings.append(s)
            elif w2 == 0 and isinstance(v2, int):
                ints.append(int(v2))
        for s in strings:
            if '.' in s and len(s) < 220:
                name = s
                break
        if name:
            for iv in ints:
                if iv > 0:
                    metric_id = iv
                    break
        if name and metric_id:
            metric_map[int(metric_id)] = {
                'name': name,
                'dtype': dtype,
                'lookup': lookup,
                'kind': 'event' if any(x in name.lower() for x in ('event', 'call', 'ims', 'sip', 'rtp', 'state')) else 'metric'
            }
        elif payload and len(payload) <= 512:
            unknown_records.append(payload[:64].hex())

    if metric_map:
        return metric_map, unknown_records

    # fallback regex extraction
    seen = set()
    for m in re.finditer(rb'([A-Za-z][A-Za-z0-9_.\[\]\-]{4,180})\x10', buf):
        raw_name = m.group(1)
        if b'.' not in raw_name:
            continue
        try:
            name = raw_name.decode('utf-8')
        except Exception:
            name = raw_name.decode('latin1', errors='ignore')
        name = (name or '').strip().strip('\x00')
        if not name or name in seen:
            continue
        mid, _ = read_varint(buf, m.end())
        if not isinstance(mid, int) or mid <= 0:
            continue
        metric_map[int(mid)] = {
            'name': name,
            'dtype': 'unknown',
            'lookup': None,
            'kind': 'event' if any(x in name.lower() for x in ('event', 'call', 'ims', 'sip', 'rtp', 'state')) else 'metric'
        }
        seen.add(name)
    return metric_map, unknown_records


def _parse_record_varint_len(data, offset):
    ln, p = read_varint(data, offset)
    if ln is None or p <= offset or ln <= 0 or ln > MAX_RECORD_LEN:
        return None
    end = p + ln
    if end > len(data):
        return None
    return {
        'nextOffset': end,
        'recordBuf': data[p:end],
        'header': {'payloadLen': ln, 'format': 'varint_len'}
    }


def _parse_record_u32_len(data, offset):
    if offset + 4 > len(data):
        return None
    ln = int.from_bytes(data[offset:offset + 4], 'little', signed=False)
    if ln <= 0 or ln > MAX_RECORD_LEN:
        return None
    start = offset + 4
    end = start + ln
    if end > len(data):
        return None
    return {
        'nextOffset': end,
        'recordBuf': data[start:end],
        'header': {'payloadLen': ln, 'format': 'u32_len'}
    }


def choose_frame_parser(data):
    candidates = [('varint_len', _parse_record_varint_len), ('u32_len', _parse_record_u32_len)]
    best = candidates[0]
    best_score = -1
    for name, fn in candidates:
        off = 0
        ok = 0
        fail = 0
        for _ in range(200):
            if off >= len(data):
                break
            r = fn(data, off)
            if not r:
                fail += 1
                off += 1
                if fail > 25:
                    break
                continue
            ok += 1
            off = r['nextOffset']
        score = ok - fail
        if score > best_score:
            best_score = score
            best = (name, fn)
    return best


def decode_value_from_record(record_buf):
    # Decode common payload types from protobuf-like record.
    msg_id = None
    timestamp = None
    value_num = None
    value_str = None
    params = []
    varints = []

    for f, w, v in iter_fields(record_buf, max_fields=200):
        if w == 0 and isinstance(v, int):
            varints.append((f, int(v)))
            params.append({'param_id': f, 'param_value': int(v), 'param_type': 'varint'})
            if timestamp is None and 946684800 <= v <= 4102444800:
                timestamp = utc_iso_from_epoch_seconds(v)
        elif w == 5 and value_num is None:
            fv = _decode_float32_le(v)
            if fv is not None:
                value_num = fv
            params.append({'param_id': f, 'param_value': value_num, 'param_type': 'float32'})
        elif w == 1 and value_num is None:
            dv = _decode_float64_le(v)
            if dv is not None:
                value_num = dv
            params.append({'param_id': f, 'param_value': value_num, 'param_type': 'float64'})
        elif w == 2:
            s = try_decode_text(v)
            if s and value_str is None:
                value_str = s
            params.append({'param_id': f, 'param_value': s if s is not None else f'bytes[{len(v)}]', 'param_type': 'string' if s is not None else 'bytes'})

    if varints:
        msg_id = varints[0][1]
    # better chance: second varint often acts as id
    if len(varints) >= 2 and varints[1][1] > 0:
        msg_id = varints[1][1]

    if value_num is None and value_str is None and varints:
        # fallback numeric value from last varint
        value_num = float(varints[-1][1])

    return {
        'msg_id': msg_id,
        'timestamp': timestamp,
        'value_num': value_num,
        'value_str': value_str,
        'params': params,
        'varints': [v for _, v in varints]
    }


def _derive_tags(name):
    up = str(name or '').upper()
    tags = []
    for kw in ('RSRP', 'SINR', 'MOS', 'VOLTE', 'IMS', 'RTP', 'RSRQ', 'BLER', 'RSCP', 'ECNO', 'CALL'):
        if kw in up:
            tags.append(kw)
    return tags


def _infer_value_kind(dtype, num_count, str_count):
    d = str(dtype or '').lower()
    if any(x in d for x in ('int', 'float', 'double', 'num', 'decimal', 'long', 'short')):
        return 'numeric'
    if any(x in d for x in ('string', 'text', 'bool', 'enum')):
        return 'string'
    return 'numeric' if num_count >= str_count else 'string'


def build_catalogs(kpis, events, metric_map):
    metric_rows = {}
    for r in kpis:
        name = r.get('name')
        if not name:
            continue
        key = name
        m = metric_rows.get(key)
        if m is None:
            m = {
                'metric_id': int(r.get('metric_id') or 0),
                'name': name,
                'dtype': r.get('dtype') or 'unknown',
                'lookup': r.get('lookup'),
                '_num_count': 0,
                '_str_count': 0,
                '_sample_count': 0,
                '_sum': 0.0,
                '_min': None,
                '_max': None
            }
            metric_rows[key] = m
        vn = r.get('value_num')
        vs = r.get('value_str')
        if isinstance(vn, (int, float)):
            f = float(vn)
            m['_num_count'] += 1
            m['_sample_count'] += 1
            m['_sum'] += f
            m['_min'] = f if m['_min'] is None else min(m['_min'], f)
            m['_max'] = f if m['_max'] is None else max(m['_max'], f)
        elif vs is not None:
            m['_str_count'] += 1
            m['_sample_count'] += 1

    # ensure declaration metrics are included even without samples
    for mid, meta in (metric_map or {}).items():
        name = (meta or {}).get('name')
        if not name:
            continue
        if name not in metric_rows:
            metric_rows[name] = {
                'metric_id': int(mid),
                'name': name,
                'dtype': (meta or {}).get('dtype') or 'unknown',
                'lookup': (meta or {}).get('lookup'),
                '_num_count': 0,
                '_str_count': 0,
                '_sample_count': 0,
                '_sum': 0.0,
                '_min': None,
                '_max': None
            }

    metrics = []
    for m in metric_rows.values():
        kind = _infer_value_kind(m['dtype'], m['_num_count'], m['_str_count'])
        stats = {'sample_count': m['_sample_count']}
        if m['_num_count'] > 0:
            stats['min'] = m['_min']
            stats['max'] = m['_max']
            stats['avg'] = m['_sum'] / m['_num_count']
        metrics.append({
            'metric_id': m['metric_id'],
            'name': m['name'],
            'dtype': m['dtype'],
            'lookup': m['lookup'],
            'value_kind': kind,
            'path_segments': str(m['name']).split('.'),
            'tags': _derive_tags(m['name']),
            'stats': stats
        })
    metrics.sort(key=lambda x: x['name'])

    events_by_name = {}
    for e in events:
        name = e.get('event_name') or 'UnknownEvent'
        row = events_by_name.get(name)
        if row is None:
            row = {
                'event_name': name,
                'metric_id': e.get('metric_id'),
                'count': 0,
                'first_seen': e.get('time'),
                'last_seen': e.get('time'),
                '_param_ids': set()
            }
            events_by_name[name] = row
        row['count'] += 1
        t = e.get('time')
        if t and (row['first_seen'] is None or t < row['first_seen']):
            row['first_seen'] = t
        if t and (row['last_seen'] is None or t > row['last_seen']):
            row['last_seen'] = t
        for p in e.get('params') or []:
            pid = p.get('param_id')
            if pid is not None:
                row['_param_ids'].add(str(pid))
    ev_catalog = []
    for e in events_by_name.values():
        ev_catalog.append({
            'event_name': e['event_name'],
            'metric_id': e['metric_id'],
            'count': e['count'],
            'first_seen': e['first_seen'],
            'last_seen': e['last_seen'],
            'param_ids': sorted(e['_param_ids'])
        })
    ev_catalog.sort(key=lambda x: x['event_name'])
    return metrics, ev_catalog


def decode_raw_trp_variant(extracted_root):
    trp_root = os.path.join(extracted_root, 'trp')
    if not os.path.isdir(trp_root):
        raise ValueError('Missing trp/ root in archive')

    entry_paths = []
    for root, _, files in os.walk(trp_root):
        for f in files:
            rel = os.path.relpath(os.path.join(root, f), extracted_root).replace('\\', '/')
            entry_paths.append(rel)
    entry_paths.sort()

    channel_path = os.path.join(trp_root, 'channel.log')
    decl_path = os.path.join(trp_root, 'declarations.bin')
    lookup_path = os.path.join(trp_root, 'lookuptables.bin')
    track_path = os.path.join(trp_root, 'positions', 'wptrack.xml')

    warnings = []
    errors = []
    if not os.path.exists(channel_path):
        raise ValueError('raw TRP variant requires trp/channel.log')
    if not os.path.exists(decl_path):
        warnings.append('declarations.bin missing')
    if not os.path.exists(lookup_path):
        warnings.append('lookuptables.bin missing')

    metric_map = {}
    lookups = {}
    unknown_decl_records = []
    dict_loaded = False

    if os.path.exists(decl_path):
        with open(decl_path, 'rb') as f:
            raw = f.read()
        try:
            decoded = decode_maybe_compressed(raw)
            metric_map, unknown_decl_records = parse_declarations(decoded['dataBuf'])
            dict_loaded = dict_loaded or bool(metric_map)
        except Exception as e:
            warnings.append(f'declarations decode failed: {e}')

    if os.path.exists(lookup_path):
        with open(lookup_path, 'rb') as f:
            raw = f.read()
        try:
            decoded = decode_maybe_compressed(raw)
            lookups = parse_lookup_tables(decoded['dataBuf'])
            dict_loaded = dict_loaded or bool(lookups)
        except Exception as e:
            warnings.append(f'lookuptables decode failed: {e}')

    with open(channel_path, 'rb') as f:
        channel_raw = f.read()
    decoded_channel = decode_maybe_compressed(channel_raw)
    channel_buf = decoded_channel['dataBuf']

    metric_ids = set(int(k) for k in (metric_map or {}).keys())

    def run_parse(parse_name, parse_fn):
        offset = 0
        fail_streak = 0
        frames = 0
        unknown_frames = 0
        kpis = []
        events = []
        base_time = None

        while offset < len(channel_buf) and frames < MAX_FRAME_SCAN:
            rec = parse_fn(channel_buf, offset)
            if not rec:
                offset += 1
                fail_streak += 1
                if fail_streak > 20000:
                    break
                continue
            fail_streak = 0
            offset = rec['nextOffset']
            frames += 1
            payload = rec['recordBuf']
            if not payload:
                continue

            decoded = decode_value_from_record(payload)
            msg_id = decoded['msg_id']
            if metric_ids:
                for vv in decoded.get('varints') or []:
                    if vv in metric_ids:
                        msg_id = vv
                        break
            ts = decoded['timestamp']

            if ts is None:
                if base_time is None:
                    base_time = datetime.now(timezone.utc)
                ts = utc_iso_from_epoch_seconds(base_time.timestamp() + (frames / 10.0))
            else:
                dt = parse_iso(ts)
                if dt is not None:
                    base_time = dt

            meta = metric_map.get(int(msg_id)) if isinstance(msg_id, int) else None
            if meta:
                name = meta.get('name') or f'Metric.{msg_id}'
                dtype = meta.get('dtype') or 'unknown'
                lookup = meta.get('lookup')
                value_num = decoded['value_num']
                value_str = decoded['value_str']

                if value_num is None:
                    for vv in reversed(decoded.get('varints') or []):
                        if vv == msg_id:
                            continue
                        if 946684800 <= vv <= 4102444800:
                            continue
                        value_num = float(vv)
                        break

                if value_str is None and value_num is not None and lookup in lookups:
                    m = lookups[lookup].get(int(value_num))
                    if m is not None:
                        value_str = str(m)

                if meta.get('kind') == 'event':
                    events.append({
                        'time': ts,
                        'event_name': name,
                        'metric_id': int(msg_id) if isinstance(msg_id, int) else None,
                        'params': decoded['params']
                    })
                else:
                    kpis.append({
                        'time': ts,
                        'metric_id': int(msg_id) if isinstance(msg_id, int) else 0,
                        'name': name,
                        'value_num': value_num,
                        'value_str': value_str,
                        'dtype': dtype,
                        'lookup': lookup
                    })
            else:
                unknown_frames += 1
                s = decoded.get('value_str')
                if s and any(x in s.lower() for x in ('volte', 'ims', 'call', 'sip', 'rtp', 'event')):
                    events.append({
                        'time': ts,
                        'event_name': f'RawEvent.{s[:80]}',
                        'metric_id': int(msg_id) if isinstance(msg_id, int) else None,
                        'params': decoded['params']
                    })
        return parse_name, frames, unknown_frames, kpis, events

    parser_name, parser_fn = choose_frame_parser(channel_buf)
    chosen_name, frames, unknown_frames, kpis, events = run_parse(parser_name, parser_fn)
    if frames == 0:
        alt_name = 'u32_len' if parser_name == 'varint_len' else 'varint_len'
        alt_fn = _parse_record_u32_len if alt_name == 'u32_len' else _parse_record_varint_len
        chosen_name, frames, unknown_frames, kpis, events = run_parse(alt_name, alt_fn)
    parser_name = chosen_name

    track_points = parse_track_xml(track_path)
    metrics_catalog, events_catalog = build_catalogs(kpis, events, metric_map)

    report = {
        'zipEntriesSummary': {
            'totalEntries': len(entry_paths),
            'hasChannelLog': os.path.exists(channel_path),
            'hasDeclarationsBin': os.path.exists(decl_path),
            'hasLookuptablesBin': os.path.exists(lookup_path),
            'hasTrackXml': os.path.exists(track_path),
            'sampleEntries': entry_paths[:120]
        },
        'dictionaryLoaded': bool(dict_loaded),
        'channelParser': parser_name,
        'channelLogFrames': int(frames),
        'unknownFrames': int(unknown_frames),
        'decodedSamples': int(len(kpis)),
        'decodedEvents': int(len(events)),
        'warnings': warnings,
        'errors': errors
    }
    if unknown_decl_records:
        report['unknownDeclarationRecords'] = unknown_decl_records[:50]

    return {
        'metadata': {
            'rawVariant': True,
            'entriesCount': len(entry_paths),
            'declarationsCount': len(metric_map),
            'lookupTablesCount': len(lookups)
        },
        'trackPoints': track_points,
        'kpiSamples': kpis,
        'events': events,
        'catalogs': {
            'metrics': metrics_catalog,
            'events': events_catalog
        },
        'importReport': report
    }


def decode_provider_channels_variant(extracted_root, metric_map, lookups, base_time_iso=None):
    trp_root = os.path.join(extracted_root, 'trp')
    providers_root = os.path.join(trp_root, 'providers')
    if not os.path.isdir(providers_root):
        return {'kpiSamples': [], 'events': [], 'report': {'channelLogFrames': 0, 'decodedSamples': 0, 'decodedEvents': 0, 'warnings': ['providers root missing']}}

    channel_paths = []
    for root, _, files in os.walk(providers_root):
        for f in files:
            if f.lower() == 'channel.log':
                channel_paths.append(os.path.join(root, f))
    channel_paths.sort()

    warnings = []
    total_frames = 0
    unknown_frames = 0
    kpis = []
    events = []

    metric_ids = set(int(k) for k in (metric_map or {}).keys())
    base_dt = parse_iso(base_time_iso) if base_time_iso else datetime.now(timezone.utc)
    time_cursor = base_dt.timestamp() if base_dt else datetime.now(timezone.utc).timestamp()

    def parse_blob(blob, parse_name, parse_fn):
        nonlocal time_cursor, total_frames, unknown_frames
        fail_streak = 0
        off = 0
        while off < len(blob):
            rec = parse_fn(blob, off)
            if not rec:
                off += 1
                fail_streak += 1
                if fail_streak > 20000:
                    break
                continue
            fail_streak = 0
            off = rec['nextOffset']
            total_frames += 1
            dec = decode_value_from_record(rec['recordBuf'])
            msg_id = dec.get('msg_id')
            if metric_ids:
                for vv in dec.get('varints') or []:
                    if vv in metric_ids:
                        msg_id = vv
                        break
            ts = dec.get('timestamp') or utc_iso_from_epoch_seconds(time_cursor)
            time_cursor += 0.1
            meta = metric_map.get(int(msg_id)) if isinstance(msg_id, int) else None
            if not meta:
                unknown_frames += 1
                continue
            name = meta.get('name') or f'Metric.{msg_id}'
            dtype = meta.get('dtype') or 'unknown'
            lookup = meta.get('lookup')
            value_num = dec.get('value_num')
            value_str = dec.get('value_str')
            if value_num is None:
                for vv in reversed(dec.get('varints') or []):
                    if vv == msg_id:
                        continue
                    if 946684800 <= vv <= 4102444800:
                        continue
                    value_num = float(vv)
                    break
            if value_str is None and value_num is not None and lookup in lookups:
                mapped = lookups[lookup].get(int(value_num))
                if mapped is not None:
                    value_str = str(mapped)

            if meta.get('kind') == 'event':
                events.append({
                    'time': ts,
                    'event_name': name,
                    'metric_id': int(msg_id) if isinstance(msg_id, int) else None,
                    'params': dec.get('params') or []
                })
            else:
                kpis.append({
                    'time': ts,
                    'metric_id': int(msg_id) if isinstance(msg_id, int) else 0,
                    'name': name,
                    'value_num': value_num,
                    'value_str': value_str,
                    'dtype': dtype,
                    'lookup': lookup
                })

    for ch in channel_paths:
        try:
            with open(ch, 'rb') as f:
                raw = f.read()
            dec = decode_maybe_compressed(raw)
            buf = dec['dataBuf']
            pname, pfn = choose_frame_parser(buf)
            parse_blob(buf, pname, pfn)
            if total_frames == 0:
                alt = _parse_record_u32_len if pfn is _parse_record_varint_len else _parse_record_varint_len
                parse_blob(buf, 'alt', alt)
        except Exception as e:
            warnings.append(f'channel parse failed {os.path.basename(ch)}: {e}')

    return {
        'kpiSamples': kpis,
        'events': events,
        'report': {
            'channelLogFrames': total_frames,
            'unknownFrames': unknown_frames,
            'decodedSamples': len(kpis),
            'decodedEvents': len(events),
            'warnings': warnings
        }
    }

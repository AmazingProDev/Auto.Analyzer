import os
import re
import zlib
from datetime import datetime, timezone
from xml.etree import ElementTree as ET


MAX_FRAME_SCAN = 2_000_000
MAX_RECORD_LEN = 262144
_ARRAY_SEGMENT_RE = re.compile(r"\[(\d+)\]")


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


_DECL_EVENT_KEYWORDS = ('event', 'call', 'ims', 'sip', 'rtp', 'state', 'signaling',
                        'message', 'rrc', 'nas', 'layer3', 'l3', 'errc', 'nrrc')


def parse_lookup_tables(buf):
    # CDF format: sequence of [varint length][protobuf record].
    # Each record: field 1 = table name, field 2 (repeated) = enum entries.
    # Each enum entry sub-message: field 1 = string name.  Values are 0-indexed by position.
    out = {}
    pos = 0
    while pos < len(buf):
        ln, p = read_varint(buf, pos)
        if ln is None or p <= pos or ln <= 0:
            break
        rec = buf[p:p + ln]
        pos = p + ln

        table_name = None
        entries = {}
        entry_idx = 0

        for f, w, v in iter_fields(rec, max_fields=500):
            if f == 1 and w == 2 and table_name is None:
                s = try_decode_text(v)
                if s and len(s) < 120:
                    table_name = s
            elif f == 2 and w == 2 and table_name is not None:
                entry_name = None
                for f2, w2, v2 in iter_fields(v, max_fields=20):
                    if f2 == 1 and w2 == 2:
                        s2 = try_decode_text(v2)
                        if s2:
                            entry_name = s2
                        break
                if entry_name is not None:
                    entries[entry_idx] = entry_name
                    entry_idx += 1

        if table_name and entries:
            out[table_name] = entries
    return out


def _parse_one_decl_record(rec):
    """Return (name, metric_id, lookup) from a single CDF declaration protobuf record."""
    name = None
    metric_id = None
    lookup = None
    for f, w, v in iter_fields(rec, max_fields=500):
        if f == 1 and w == 2 and name is None:
            s = try_decode_text(v)
            if s and '.' in s and len(s) < 220:
                name = s
        elif f == 2 and w == 0 and isinstance(v, int) and metric_id is None and v > 0:
            metric_id = int(v)
        elif f == 5 and w == 2 and lookup is None:
            # Type-descriptor sub-message: field 6 = lookup table name
            for f2, w2, v2 in iter_fields(v, max_fields=20):
                if f2 == 6 and w2 == 2:
                    s2 = try_decode_text(v2)
                    if s2 and len(s2) < 100:
                        lookup = s2
                    break
    return (name, metric_id, lookup) if (name and metric_id) else None


def parse_declarations(buf):
    metric_map = {}
    unknown_records = []

    # Primary path: CDF length-prefixed record stream.
    # Each record is a protobuf sub-message: field 1=name, field 2=global_id, field 5=type_descriptor.
    # The type-descriptor's field 6 carries the lookup-table name for enum metrics.
    pos = 0
    while pos < len(buf):
        ln, p = read_varint(buf, pos)
        if ln is None or p <= pos or ln <= 0:
            break
        rec = buf[p:p + ln]
        pos = p + ln
        result = _parse_one_decl_record(rec)
        if result:
            name, metric_id, lookup = result
            metric_map[metric_id] = {
                'name': name,
                'dtype': 'unknown',
                'lookup': lookup,
                'kind': 'event' if any(x in name.lower() for x in _DECL_EVENT_KEYWORDS) else 'metric'
            }
        elif rec and len(rec) <= 512:
            unknown_records.append(rec[:64].hex())

    # Supplemental regex scan: catches nested sub-declarations embedded in field 6 blobs
    # (complex message types carry child metric declarations inline).
    # Only adds metrics not already found by the primary parse; lookup is unavailable here.
    seen = set(metric_map.keys())
    for m in re.finditer(rb'([A-Za-z][A-Za-z0-9_.\[\]\-]{4,180})\x10', buf):
        raw_name = m.group(1)
        if b'.' not in raw_name:
            continue
        try:
            name = raw_name.decode('utf-8')
        except Exception:
            name = raw_name.decode('latin1', errors='ignore')
        name = (name or '').strip().strip('\x00')
        if not name:
            continue
        mid, _ = read_varint(buf, m.end())
        if not isinstance(mid, int) or mid <= 0 or mid in seen:
            continue
        seen.add(mid)
        metric_map[mid] = {
            'name': name,
            'dtype': 'unknown',
            'lookup': None,
            'kind': 'event' if any(x in name.lower() for x in _DECL_EVENT_KEYWORDS) else 'metric'
        }
    return _expand_array_metric_map(metric_map), unknown_records


def _array_dims_from_name(name):
    dims = []
    for token in _ARRAY_SEGMENT_RE.findall(str(name or '')):
        try:
            size = int(token)
        except Exception:
            return []
        if size <= 0:
            return []
        dims.append(size)
    return dims


def _flattened_array_name(name, offset, dims):
    if not dims:
        return str(name or '')
    rem = int(max(0, offset))
    coords = [0] * len(dims)
    for i in range(len(dims) - 1, -1, -1):
        size = max(1, int(dims[i]))
        coords[i] = rem % size
        rem //= size
    coord_iter = iter(coords)
    return _ARRAY_SEGMENT_RE.sub(lambda _: f"[{next(coord_iter)}]", str(name or ''), count=len(dims))


def _expand_array_metric_map(metric_map):
    expanded = dict(metric_map or {})
    for metric_id, meta in sorted((metric_map or {}).items(), key=lambda kv: int(kv[0])):
        if not isinstance(meta, dict):
            continue
        name = str(meta.get('name') or '').strip()
        if not name:
            continue
        dims = _array_dims_from_name(name)
        if not dims:
            continue
        total = 1
        for size in dims:
            total *= int(size)
            if total > 100000:
                total = 0
                break
        if total <= 1:
            continue
        base_id = int(metric_id)
        for offset in range(total):
            actual_id = base_id + offset
            if actual_id in expanded and actual_id != base_id:
                continue
            row = dict(meta)
            row['declared_name'] = name
            row['expanded_name'] = _flattened_array_name(name, offset, dims)
            row['base_metric_id'] = base_id
            row['array_index'] = offset
            row['idx'] = offset
            row['array_dims'] = list(dims)
            row['array_count'] = total
            expanded[actual_id] = row
    return expanded


# Compatibility aliases for importer variants expecting *_cdf names.
def _read_cdf_input(src):
    if isinstance(src, (bytes, bytearray)):
        return bytes(src)
    if isinstance(src, str):
        with open(src, 'rb') as f:
            raw = f.read()
        dec = decode_maybe_compressed(raw)
        return dec.get('dataBuf') or b''
    return b''


def parse_lookup_tables_cdf(buf_or_path):
    return parse_lookup_tables(_read_cdf_input(buf_or_path))


def parse_declarations_cdf(buf_or_path):
    return parse_declarations(_read_cdf_input(buf_or_path))


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


def decode_cdf_data_variant(extracted_root, metric_map, lookups, base_time_iso=None):
    def iter_len_prefixed_records(buf, max_records=5_000_000):
        if not buf:
            return
        pos = 0
        count = 0
        while pos < len(buf) and count < max_records:
            ln, p = read_varint(buf, pos)
            if ln is None or p <= pos or ln <= 0:
                break
            end = p + ln
            if end > len(buf):
                break
            rec = buf[p:end]
            if rec:
                yield rec
                count += 1
            pos = end

    def parse_metric_sample(msg_bytes):
        metric_id = None
        value_num = None
        value_str = None
        varints = []
        for f, w, v in iter_fields(msg_bytes, max_fields=200):
            if w == 0 and isinstance(v, int):
                if f == 1 and metric_id is None and v > 0:
                    metric_id = int(v)
                else:
                    varints.append((f, int(v)))
            elif w == 5 and value_num is None:
                value_num = _decode_float32_le(v)
            elif w == 1 and value_num is None:
                value_num = _decode_float64_le(v)
            elif w == 2 and value_str is None:
                s = try_decode_text(v)
                if s is not None:
                    value_str = s
                elif v:
                    # Preserve binary blobs (e.g. Message.3Gpp.Layer3Message payloads)
                    # as latin1 so _parse_layer3_blob can round-trip them back to bytes.
                    value_str = v.decode("latin1", errors="replace")

        if metric_id is None:
            for _, vv in varints:
                if vv > 1000:
                    metric_id = vv
                    break
        if value_num is None and value_str is None and varints:
            vv = varints[0][1]
            if -10_000_000_000 < vv < 10_000_000_000:
                value_num = float(vv)
        return metric_id, value_num, value_str

    trp_root = os.path.join(extracted_root, 'trp')
    providers_root = os.path.join(trp_root, 'providers')
    if not os.path.isdir(providers_root):
        return {'kpiSamples': [], 'events': [], 'frames': 0, 'report': {'decodedSamples': 0, 'decodedEvents': 0, 'warnings': ['providers root missing']}}

    data_paths = []
    for root, _, files in os.walk(providers_root):
        for f in files:
            if f.lower() == 'data.cdf':
                data_paths.append(os.path.join(root, f))
    data_paths.sort()
    if not data_paths:
        return {'kpiSamples': [], 'events': [], 'frames': 0, 'report': {'decodedSamples': 0, 'decodedEvents': 0, 'warnings': ['data.cdf not found']}}

    MAX_KPI_ROWS = 500000
    MAX_EVENT_ROWS = 200000
    kpis = []
    events = []
    warnings = []
    total_frames = 0

    for path in data_paths:
        try:
            data_bytes = _read_cdf_input(path)
            for rec in iter_len_prefixed_records(data_bytes):
                total_frames += 1
                ts_iso = None
                samples = []

                for f, w, v in iter_fields(rec, max_fields=200):
                    if f == 1 and w == 2 and v:
                        sec = None
                        nanos = 0
                        for f2, w2, v2 in iter_fields(v, max_fields=20):
                            if f2 == 1 and w2 == 0 and isinstance(v2, int):
                                sec = int(v2)
                            elif f2 == 2 and w2 == 0 and isinstance(v2, int):
                                nanos = int(v2)
                        if sec is not None and 946684800 <= sec <= 4102444800:
                            ts_iso = utc_iso_from_epoch_seconds(sec + (nanos / 1e9 if nanos else 0))
                    elif w == 2 and v:
                        mid, vn, vs = parse_metric_sample(v)
                        if mid:
                            samples.append((mid, vn, vs))

                if not ts_iso or not samples:
                    continue

                for metric_id, value_num, value_str in samples:
                    meta = metric_map.get(metric_id, {})
                    name = meta.get('name') or f'Metric.{metric_id}'
                    dtype = meta.get('dtype') or 'unknown'
                    lookup_name = meta.get('lookup')
                    declared_name = meta.get('declared_name') or name
                    expanded_name = meta.get('expanded_name')
                    base_metric_id = meta.get('base_metric_id')
                    sample_idx = meta.get('idx')
                    mapped_str = value_str
                    if mapped_str is None and value_num is not None and lookup_name and lookup_name in lookups:
                        mapped = lookups[lookup_name].get(int(value_num))
                        if mapped is not None:
                            mapped_str = str(mapped)

                    kpis.append({
                        'time': ts_iso,
                        'metric_id': int(metric_id),
                        'name': name,
                        'declared_name': declared_name,
                        'expanded_name': expanded_name,
                        'base_metric_id': int(base_metric_id) if isinstance(base_metric_id, int) else None,
                        'value_num': value_num,
                        'value_str': mapped_str,
                        'dtype': dtype,
                        'lookup': lookup_name,
                        'idx': int(sample_idx) if isinstance(sample_idx, int) else None,
                    })

                    lname = name.lower()
                    if any(t in lname for t in ('volte', 'call', 'ims', 'rrc', 'sip', 'voice', 'event', 'state')):
                        events.append({
                            'time': ts_iso,
                            'event_name': name,
                            'metric_id': int(metric_id),
                            'params': [
                                {'param_id': 'value_num', 'param_value': value_num, 'param_type': 'float'},
                                {'param_id': 'value_str', 'param_value': mapped_str, 'param_type': 'string'}
                            ]
                        })
                    if len(kpis) >= MAX_KPI_ROWS:
                        break
                if len(kpis) >= MAX_KPI_ROWS:
                    break
        except Exception as e:
            warnings.append(f'data.cdf parse failed {os.path.basename(path)}: {e}')

    if len(events) > MAX_EVENT_ROWS:
        events = events[:MAX_EVENT_ROWS]
    return {
        'kpiSamples': kpis,
        'events': events,
        'frames': total_frames,
        'report': {
            'decodedSamples': len(kpis),
            'decodedEvents': len(events),
            'warnings': warnings
        }
    }


# .NET DateTime tick epoch (Jan 1, 0001) relative to Unix epoch (Jan 1, 1970), in 100-ns intervals.
_DOTNET_EPOCH_OFFSET_100NS = 621_355_968_000_000_000


def extract_ch7_pcap(extracted_root):
    """Extract IP packets from the ch7 IPSniffer channel and return (pcap_bytes, error_str).

    The channel stream has a 40-byte TEMS header per packet, carrying a .NET DateTime tick
    timestamp (little-endian uint64, 100-ns resolution, offset from 0001-01-01 UTC).
    The Ethernet frame follows immediately at offset 40.  Packet boundaries are derived
    from the IPv4/IPv6 total-length field — no fixed-size framing needed.
    """
    import struct as _struct

    providers_root = os.path.join(extracted_root, 'trp', 'providers')
    ch7_path = None
    for root, _, files in os.walk(providers_root):
        if 'channel.log' in files and os.path.basename(os.path.dirname(root)) == 'ch7':
            ch7_path = os.path.join(root, 'channel.log')
            break
    # Broader fallback: any channel directory named ch7
    if ch7_path is None:
        for root, dirs, files in os.walk(providers_root):
            if 'channel.log' in files and 'ch7' in os.path.relpath(root, providers_root):
                ch7_path = os.path.join(root, 'channel.log')
                break
    if ch7_path is None or not os.path.exists(ch7_path):
        return None, 'ch7 IPSniffer channel not found in this TRP file'

    try:
        with open(ch7_path, 'rb') as fh:
            raw = fh.read()
        dec = decode_maybe_compressed(raw)
        buf = dec.get('dataBuf') or b''
    except Exception as exc:
        return None, f'ch7 read/decompress failed: {exc}'

    if not buf:
        return None, 'ch7 channel is empty'

    _TEMS_HDR = 40
    _ETH_HDR = 14

    # libpcap global header: magic, ver_major, ver_minor, thiszone, sigfigs, snaplen, network
    out = bytearray(_struct.pack('<IHHiIII', 0xa1b2c3d4, 2, 4, 0, 0, 65535, 1))
    packet_count = 0
    off = 0

    while off + _TEMS_HDR + _ETH_HDR < len(buf):
        # Decode .NET DateTime tick timestamp from TEMS header bytes 0-7
        raw_tick = _struct.unpack_from('<Q', buf, off)[0]
        unix_100ns = raw_tick - _DOTNET_EPOCH_OFFSET_100NS
        if unix_100ns < 0:
            unix_100ns = 0
        ts_sec = unix_100ns // 10_000_000
        ts_usec = (unix_100ns % 10_000_000) // 10

        eth_off = off + _TEMS_HDR
        ethertype = _struct.unpack_from('>H', buf, eth_off + 12)[0]

        if ethertype == 0x0800:        # IPv4
            if eth_off + 18 > len(buf):
                break
            ip_total = _struct.unpack_from('>H', buf, eth_off + 16)[0]
            frame_len = _ETH_HDR + ip_total
        elif ethertype == 0x86DD:      # IPv6
            if eth_off + 22 > len(buf):
                break
            ip_payload = _struct.unpack_from('>H', buf, eth_off + 18)[0]
            frame_len = _ETH_HDR + 40 + ip_payload
        else:
            break

        if eth_off + frame_len > len(buf):
            break

        eth_frame = buf[eth_off:eth_off + frame_len]
        # libpcap per-packet header: ts_sec, ts_usec, incl_len, orig_len
        out += _struct.pack('<IIII', ts_sec, ts_usec, len(eth_frame), len(eth_frame))
        out += eth_frame
        packet_count += 1
        off += _TEMS_HDR + frame_len

    if packet_count == 0:
        return None, 'no IPv4/IPv6 packets found in ch7'

    return bytes(out), None


# ---------------------------------------------------------------------------
# ch1 NAS EMM/ESM event extractor
# ---------------------------------------------------------------------------

_NAS_DIAG_LOG_CODES = frozenset({0xB0E2, 0xB0E3, 0xB0E5, 0xB0EC, 0xB0ED, 0xB0EE})
_NAS_DIAG_QCOM_HDR = 4   # Qualcomm prefix bytes before raw NAS PDU (confirmed)
_NAS_TEMS_CH1_HDR  = 20  # TEMS ch1 record header: <Q H I I H> = 8+2+4+4+2

# Codes where direction is known from the log code itself
_NAS_CODE_DIR = {0xB0E2: 'DL', 0xB0E3: 'UL'}


_NAS_LABEL_FIXUPS = {
    'Act Default EPS Bearer Ctxt Request': 'Activate Default Bearer Request',
    'Act Default EPS Bearer Ctxt Accept':  'Activate Default Bearer Accept',
    'Act Default EPS Bearer Ctxt Reject':  'Activate Default Bearer Reject',
    'Act Dedi EPS Bearer Ctxt Request':    'Activate Dedicated Bearer Request',
    'Act Dedi EPS Bearer Ctxt Accept':     'Activate Dedicated Bearer Accept',
    'Act Dedi EPS Bearer Ctxt Reject':     'Activate Dedicated Bearer Reject',
    'Deact EPS Bearer Ctxt Request':       'Deactivate Bearer Request',
    'Deact EPS Bearer Ctxt Accept':        'Deactivate Bearer Accept',
    'Modify EPS Bearer Ctxt Request':      'Modify Bearer Request',
    'Modify EPS Bearer Ctxt Accept':       'Modify Bearer Accept',
    'Modify EPS Bearer Ctxt Reject':       'Modify Bearer Reject',
    'PDN Connectivity Request':            'PDN Connect Request',
    'PDN Connectivity Reject':             'PDN Connect Reject',
    'PDN Disconnect Request':              'PDN Disconnect Request',
}


def _nas_cls_to_label(cls_name):
    """'EMMAttachRequest' → 'NAS: EMM Attach Request'"""
    import re as _re
    if cls_name.startswith('EMM'):
        prefix, body = 'EMM', cls_name[3:]
    elif cls_name.startswith('ESM'):
        prefix, body = 'ESM', cls_name[3:]
    else:
        prefix, body = '', cls_name
    spaced = _re.sub(r'(?<=[a-z])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])', ' ', body)
    spaced = _NAS_LABEL_FIXUPS.get(spaced, spaced)
    return f'NAS: {prefix} {spaced}'.strip() if prefix else f'NAS: {spaced}'.strip()


def _extract_esm_apn_ip(val, out):
    """Walk a pycrate ESM get_val() list and pull APN + IP into out dict."""
    import socket as _socket
    if not isinstance(val, (list, tuple)):
        return
    for ie in val[1:]:   # skip [EBI, PD, PTI, MT] header element
        if not isinstance(ie, (list, tuple)) or len(ie) < 2:
            continue
        ie_val = ie[1]
        # APN: list of [label_len, label_bytes] — stop at MNC/MCC/GPRS operator labels
        if isinstance(ie_val, list) and ie_val and isinstance(ie_val[0], (list, tuple)):
            labels = []
            for lbl in ie_val:
                if not (isinstance(lbl, (list, tuple)) and len(lbl) == 2 and isinstance(lbl[1], bytes)):
                    continue
                s = lbl[1].decode('ascii', errors='replace').strip()
                if s.upper() in ('GPRS',) or s.upper().startswith('MNC') or s.upper().startswith('MCC'):
                    break
                if s:
                    labels.append(s)
            if labels and 'APN' not in out:
                candidate = '.'.join(labels)
                if 2 < len(candidate) < 100:
                    out['APN'] = candidate
        # PDN Address: somewhere in a sub-list there will be a 4- or 16-byte IP
        elif isinstance(ie_val, (list, tuple)):
            for item in ie_val:
                if isinstance(item, bytes) and len(item) == 4 and 'IP' not in out:
                    try:
                        out['IP'] = _socket.inet_ntoa(item)
                    except Exception:
                        pass
                elif isinstance(item, bytes) and len(item) == 16 and 'IP' not in out:
                    try:
                        out['IP'] = _socket.inet_ntop(_socket.AF_INET6, item)
                    except Exception:
                        pass


def extract_ch1_nas_events(extracted_root):
    """Parse the ch1 Qualcomm DIAG stream and return NAS EMM/ESM events.

    Returns (events_list, error_str).
    events_list entries are dicts compatible with the run's event list:
      { 'time': ISO-str, 'event_name': str, 'params': [],
        'params_map': {...}, 'source': 'nas_ch1' }
    error_str is non-None only when the whole channel is unavailable.
    Individual undecoded packets are silently skipped.
    """
    import struct as _struct
    import datetime as _dt
    import warnings as _warn

    # ---- locate ch1 channel.log (same pattern as extract_ch7_pcap) ----------
    providers_root = os.path.join(extracted_root, 'trp', 'providers')
    ch1_path = None
    for root, _, files in os.walk(providers_root):
        if 'channel.log' in files and os.path.basename(os.path.dirname(root)) == 'ch1':
            ch1_path = os.path.join(root, 'channel.log')
            break
    if ch1_path is None:
        for root, _, files in os.walk(providers_root):
            if 'channel.log' in files and 'ch1' in os.path.relpath(root, providers_root):
                ch1_path = os.path.join(root, 'channel.log')
                break
    if not ch1_path or not os.path.exists(ch1_path):
        return [], 'ch1 channel not found'

    try:
        with open(ch1_path, 'rb') as fh:
            raw = fh.read()
        dec = decode_maybe_compressed(raw)
        buf = dec.get('dataBuf') or b''
    except Exception as exc:
        return [], f'ch1 read/decompress failed: {exc}'

    if not buf:
        return [], 'ch1 channel is empty'

    # ---- load pycrate NAS decoders (optional — degrade gracefully) ----------
    try:
        with _warn.catch_warnings():
            _warn.simplefilter('ignore')
            from pycrate_mobile.NASLTE import (
                EMMTypeMTClasses, EMMTypeMOClasses, ESMTypeClasses,
            )
        _has_pycrate = True
    except ImportError:
        EMMTypeMTClasses = EMMTypeMOClasses = ESMTypeClasses = {}
        _has_pycrate = False

    # .NET Windows tick → ISO-8601 UTC
    _WIN_EPOCH = _dt.datetime(1, 1, 1, tzinfo=_dt.timezone.utc)

    def _tick_iso(ticks):
        try:
            return (_WIN_EPOCH + _dt.timedelta(microseconds=ticks / 10)).isoformat()
        except Exception:
            return ''

    # ---- walk TEMS ch1 records ----------------------------------------------
    events = []
    off = 0
    n = len(buf)

    while off + _NAS_TEMS_CH1_HDR <= n:
        ticks, _m1, _m2, _m3, payload_len = _struct.unpack_from('<QHIIH', buf, off)
        pstart = off + _NAS_TEMS_CH1_HDR
        pend   = pstart + payload_len
        if pend > n:
            off += 1
            continue
        payload = buf[pstart:pend]
        off = pend

        # ---- Qualcomm DIAG LOG_F envelope check ----------------------------
        if len(payload) < 26:
            continue
        if payload[0:2] != b'\x00\x02':
            continue
        if payload[10] != 0x10:
            continue
        log_code = _struct.unpack_from('<H', payload, 16)[0]
        if log_code not in _NAS_DIAG_LOG_CODES:
            continue

        body = payload[26:]
        if len(body) <= _NAS_DIAG_QCOM_HDR:
            continue
        nas_pdu = body[_NAS_DIAG_QCOM_HDR:]
        if len(nas_pdu) < 2:
            continue

        # ---- decode NAS PDU ------------------------------------------------
        pd  = nas_pdu[0] & 0x0F
        t   = _tick_iso(ticks)
        dir_hint = _NAS_CODE_DIR.get(log_code, '')

        if pd == 0x07:    # EMM
            mt  = nas_pdu[1]
            cls = (EMMTypeMTClasses.get(mt) or EMMTypeMOClasses.get(mt)) if _has_pycrate else None
            if cls is None:
                continue
            label = _nas_cls_to_label(cls.__name__)
            pm = {'direction': dir_hint} if dir_hint else {}
            try:
                msg = cls()
                msg.from_bytes(nas_pdu)
            except Exception:
                pass   # label is still valid; IE details just won't be available
            events.append({
                'time': t, 'event_name': label,
                'params': [], 'params_map': pm, 'source': 'nas_ch1',
            })

        elif pd == 0x02:  # ESM
            ebi = (nas_pdu[0] >> 4) & 0x0F
            mt  = nas_pdu[2] if len(nas_pdu) > 2 else 0
            cls = ESMTypeClasses.get(mt) if _has_pycrate else None
            if cls is None:
                continue
            label = _nas_cls_to_label(cls.__name__)
            pm = {'EPS Bearer': str(ebi)}
            if dir_hint:
                pm['direction'] = dir_hint
            # For Activate Default Bearer Request, extract APN + IP
            if _has_pycrate and 'ActDefault' in cls.__name__ and 'Request' in cls.__name__:
                try:
                    msg = cls()
                    msg.from_bytes(nas_pdu)
                    _extract_esm_apn_ip(msg.get_val(), pm)
                except Exception:
                    pass
            events.append({
                'time': t, 'event_name': label,
                'params': [], 'params_map': pm, 'source': 'nas_ch1',
            })

    return events, None


# ---------------------------------------------------------------------------
# ch1 RRC (B0C0 LTE_RRC_OTA_PACKET) event extractor
# ---------------------------------------------------------------------------

_RRC_B0C0_LOG_CODE = 0xB0C0

# Confirmed B0C0 body layout (payload[26:]):
#   bytes[0:4]   = 0x1b101010 (constant Qualcomm version marker)
#   bytes[4]     = 0x60 (constant channel indicator)
#   bytes[5]     = direction  (0 = DL/BCCH, 1 = UL)
#   bytes[6:8]   = PCI uint16le
#   bytes[8:12]  = EARFCN uint32le
#   bytes[12:16] = modem timestamp uint32le
#   bytes[16:20] = PDU length N uint32be
#   bytes[20]    = 0x00 pad byte
#   bytes[21:21+N] = RRC PDU (UPER encoded)

_RRC_MIN_BODY = 22   # minimum meaningful body length

# UL messages to emit in the event timeline
_RRC_UL_KEEP = frozenset({
    'rrcConnectionRequest',
    'rrcConnectionSetupComplete',
    'rrcConnectionReconfigurationComplete',
    'rrcConnectionReestablishmentRequest',
    'rrcConnectionReestablishmentComplete',
    'rrcConnectionReleaseComplete',
    'securityModeComplete',
    'securityModeFailure',
    'measurementReport',
    'ueCapabilityInformation',
    'ulInformationTransfer',
    'scgFailureInformation-r12',
    'failureInformation-r15',
    'wlanConnectionStatusReport-r13',
})

# Clean label map (camelCase RRC message → display name)
_RRC_LABEL_MAP = {
    'rrcConnectionRequest':                 'RRC: Connection Request',
    'rrcConnectionSetupComplete':           'RRC: Connection Setup Complete',
    'rrcConnectionReconfigurationComplete': 'RRC: Reconfiguration Complete',
    'rrcConnectionReestablishmentRequest':  'RRC: Reestablishment Request',
    'rrcConnectionReestablishmentComplete': 'RRC: Reestablishment Complete',
    'rrcConnectionReleaseComplete':         'RRC: Release Complete',
    'securityModeComplete':                 'RRC: Security Mode Complete',
    'securityModeFailure':                  'RRC: Security Mode Failure',
    'measurementReport':                    'RRC: Measurement Report',
    'ueCapabilityInformation':              'RRC: UE Capability Information',
    'ulInformationTransfer':                'RRC: UL Info Transfer',
    'scgFailureInformation-r12':            'RRC: SCG Failure',
    'failureInformation-r15':               'RRC: Failure Information',
    'wlanConnectionStatusReport-r13':       'RRC: WLAN Status Report',
}


def _rrc_pycrate_msg_name(val):
    """Extract the innermost choice name from a pycrate decoded SEQUENCE value."""
    if not isinstance(val, dict):
        return None
    msg = val.get('message')
    if not isinstance(msg, tuple) or len(msg) < 2:
        return None
    inner = msg[1]                      # e.g. ('c1', ('ueCapabilityInformation', {...}))
    if isinstance(inner, tuple) and len(inner) >= 2:
        deeper = inner[1]               # e.g. ('ueCapabilityInformation', {...})
        if isinstance(deeper, tuple) and len(deeper) >= 1:
            return deeper[0]
        return inner[0]
    if isinstance(inner, tuple) and len(inner) == 1:
        return inner[0]
    return None


def extract_ch1_rrc_events(extracted_root):
    """Parse ch1 Qualcomm DIAG B0C0 (LTE_RRC_OTA_PACKET) packets and return RRC events.

    Returns (events_list, error_str).
    Only UL messages in _RRC_UL_KEEP are emitted as events.
    DL bodies are decoded as BCCH-DL-SCH; SIB1 cell identity / TAC is extracted
    and returned as a single 'RRC: Cell Info' event per unique (PCI, EARFCN).
    """
    import struct as _struct
    import datetime as _dt
    import warnings as _warn

    # ---- locate ch1 (same walk as NAS extractor) ----------------------------
    providers_root = os.path.join(extracted_root, 'trp', 'providers')
    ch1_path = None
    for root, _, files in os.walk(providers_root):
        if 'channel.log' in files and os.path.basename(os.path.dirname(root)) == 'ch1':
            ch1_path = os.path.join(root, 'channel.log')
            break
    if ch1_path is None:
        for root, _, files in os.walk(providers_root):
            if 'channel.log' in files and 'ch1' in os.path.relpath(root, providers_root):
                ch1_path = os.path.join(root, 'channel.log')
                break
    if not ch1_path or not os.path.exists(ch1_path):
        return [], 'ch1 channel not found'

    try:
        with open(ch1_path, 'rb') as fh:
            raw = fh.read()
        dec = decode_maybe_compressed(raw)
        buf = dec.get('dataBuf') or b''
    except Exception as exc:
        return [], f'ch1 read/decompress failed: {exc}'

    if not buf:
        return [], 'ch1 channel is empty'

    # ---- load pycrate EUTRA RRC (optional) ----------------------------------
    _UlDcch = _UlCcch = _BcchDlSch = None
    try:
        with _warn.catch_warnings():
            _warn.simplefilter('ignore')
            from pycrate_asn1dir import RRCLTE as _RRCLTE
            _eutra = _RRCLTE.EUTRA_RRC_Definitions()
            _UlDcch    = _eutra.UL_DCCH_Message
            _UlCcch    = _eutra.UL_CCCH_Message
            _BcchDlSch = _eutra.BCCH_DL_SCH_Message
    except Exception:
        pass

    if _UlDcch is None:
        return [], 'pycrate RRCLTE not available'

    # .NET Windows tick → ISO-8601 UTC (same helper as NAS extractor)
    _WIN_EPOCH = _dt.datetime(1, 1, 1, tzinfo=_dt.timezone.utc)

    def _tick_iso(ticks):
        try:
            return (_WIN_EPOCH + _dt.timedelta(microseconds=ticks / 10)).isoformat()
        except Exception:
            return ''

    # ---- walk TEMS ch1 records ----------------------------------------------
    events = []
    cell_info_seen = {}   # (pci, earfcn) → True, to avoid duplicate cell events
    off = 0
    n   = len(buf)

    while off + _NAS_TEMS_CH1_HDR <= n:
        ticks, _m1, _m2, _m3, payload_len = _struct.unpack_from('<QHIIH', buf, off)
        pstart = off + _NAS_TEMS_CH1_HDR
        pend   = pstart + payload_len
        if pend > n:
            off += 1
            continue
        payload = buf[pstart:pend]
        off = pend

        # ---- Qualcomm DIAG LOG_F envelope check ----------------------------
        if len(payload) < 26:
            continue
        if payload[0:2] != b'\x00\x02':
            continue
        if payload[10] != 0x10:
            continue
        log_code = _struct.unpack_from('<H', payload, 16)[0]
        if log_code != _RRC_B0C0_LOG_CODE:
            continue

        body = payload[26:]
        if len(body) < _RRC_MIN_BODY:
            continue

        # ---- parse confirmed B0C0 header ------------------------------------
        direction = body[5]
        pci       = _struct.unpack_from('<H', body, 6)[0]
        earfcn    = _struct.unpack_from('<I', body, 8)[0]
        pdu_len   = _struct.unpack_from('>I', body, 16)[0]
        if body[20] != 0x00:
            continue           # unexpected pad byte — skip
        if 21 + pdu_len > len(body) or pdu_len == 0:
            continue
        pdu = body[21:21 + pdu_len]

        t = _tick_iso(ticks)

        if direction == 1:
            # ---- UL: try UL-DCCH then UL-CCCH ------------------------------
            msg_name = None
            pm = {'PCI': str(pci), 'EARFCN': str(earfcn), 'direction': 'UL'}
            for decoder in (_UlDcch, _UlCcch):
                try:
                    decoder.from_uper(pdu)
                    val = decoder.get_val()
                    msg_name = _rrc_pycrate_msg_name(val)
                    break
                except Exception:
                    pass
            if not msg_name:
                continue
            if msg_name not in _RRC_UL_KEEP:
                continue
            label = _RRC_LABEL_MAP.get(msg_name, f'RRC: {msg_name}')
            events.append({
                'time': t, 'event_name': label,
                'params': [], 'params_map': pm, 'source': 'rrc_b0c0',
            })

        else:
            # ---- DL: decode as BCCH-DL-SCH, extract SIB1 cell info ---------
            key = (pci, earfcn)
            if key in cell_info_seen:
                continue       # already emitted a cell-info event for this cell
            try:
                _BcchDlSch.from_uper(pdu)
                val = _BcchDlSch.get_val()
                inner_name = _rrc_pycrate_msg_name(val)
                if inner_name != 'systemInformationBlockType1':
                    continue
                # Walk val to extract cell identity fields
                sib1 = val.get('message', (None, None))[1]   # ('c1', ('sib1', {...}))
                if isinstance(sib1, tuple) and len(sib1) >= 2:
                    sib1 = sib1[1]    # {'cellAccessRelatedInfo': {...}, ...}
                if not isinstance(sib1, dict):
                    continue
                car = sib1.get('cellAccessRelatedInfo', {})
                tac_bits = car.get('trackingAreaCode')
                cell_id_bits = car.get('cellIdentity')
                plmn_list = car.get('plmn-IdentityList', [])
                pm = {'PCI': str(pci), 'EARFCN': str(earfcn)}
                if isinstance(tac_bits, tuple) and len(tac_bits) >= 1:
                    tac_val = tac_bits[0]
                    pm['TAC'] = f'0x{tac_val:04X}' if isinstance(tac_val, int) else str(tac_val)
                if isinstance(cell_id_bits, tuple) and len(cell_id_bits) >= 1:
                    cid = cell_id_bits[0]
                    if isinstance(cid, int):
                        enb_id   = (cid >> 8) & 0xFFFFF
                        local_cid = cid & 0xFF
                        pm['eNB ID']  = str(enb_id)
                        pm['Cell ID'] = str(local_cid)
                for plmn in plmn_list[:1]:
                    if not isinstance(plmn, dict):
                        continue
                    pid = plmn.get('plmn-Identity', {})
                    mcc = pid.get('mcc', [])
                    mnc = pid.get('mnc', [])
                    if mcc and mnc:
                        pm['PLMN'] = ''.join(str(d) for d in mcc) + '-' + ''.join(str(d) for d in mnc)
                cell_info_seen[key] = True
                events.append({
                    'time': t, 'event_name': 'RRC: Cell Info (SIB1)',
                    'params': [], 'params_map': pm, 'source': 'rrc_b0c0',
                })
            except Exception:
                pass

    return events, None

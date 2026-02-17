import json
import os
import re
import sqlite3
import tempfile
import zipfile
import zlib
from datetime import datetime, timezone
from xml.etree import ElementTree as ET
from trp_raw_decoder import decode_raw_trp_variant, decode_provider_channels_variant
from db_client import connect_db, sync_if_needed

MAX_KPI_ROWS = 500000
MAX_EVENT_ROWS = 200000
TAG_KEYWORDS = ['RSRP', 'SINR', 'MOS', 'VOLTE', 'IMS', 'RRC', 'SIP', 'CALL', 'BLER', 'RSRQ', 'RSCP', 'ECNO', 'THROUGHPUT']
KPI_TYPE_ORDER = ['rsrp', 'rsrq', 'sinr', 'dl_tp', 'ul_tp']
KPI_PATTERNS = {
    'rsrp': [
        r'radio\.lte\.servingcell.*\.rsrp',
        r'radio\.common\.mrdc\.cell.*\.rsrp',
        r'radio\.nr\..*rsrp',
        r'.*rsrp'
    ],
    'rsrq': [
        r'radio\.lte\.servingcell.*\.rsrq',
        r'radio\.common\.mrdc\.cell.*\.rsrq',
        r'radio\.nr\..*rsrq',
        r'.*rsrq'
    ],
    'sinr': [
        r'radio\.lte\.servingcell.*\.(rs)?sinr',
        r'radio\..*\.sinr',
        r'radio\.nr\..*sinr',
        r'.*sinr'
    ],
    'dl_tp': [
        # LTE downlink transport
        r'.*\.(pdsch)\.throughput\b',
        r'.*pdsch.*throughput.*',
        # Generic DL throughput naming
        r'.*(downlink|dl|download).*(throughput|thp|bitrate).*',
        r'.*(throughput|thp|bitrate).*(downlink|dl|download).*'
    ],
    'ul_tp': [
        # LTE uplink transport
        r'.*\.(pusch)\.throughput\b',
        r'.*pusch.*throughput.*',
        # Generic UL throughput naming
        r'.*(uplink|ul).*(throughput|thp|bitrate).*',
        r'.*(throughput|thp|bitrate).*(uplink|ul).*'
    ]
}

INFO_PATTERNS = {
    # ECGI / Cell identity (often large integer)
    'cellid': [
        r'\.ecgi\b',
        r'\.eutrancellidentity\b',
        r'\.cellidentity\b',
        r'\.cellid\b'
    ],
    # PCI
    'pci': [
        r'\.pci\b',
        r'physicalcellid',
        r'\.physicalcellid\b'
    ],
    # Downlink EARFCN
    'dl_earfcn': [
        r'earfcn.*dl',
        r'dl.*earfcn',
        r'downlinkearfcn',
        r'\.earfcn\b'
    ],
    # Tracking area code
    'tac': [
        r'\.tac\b',
        r'trackingareacode',
        r'trackingarea.*code'
    ],
    # eNodeB ID (sometimes explicit)
    'enodeb_id': [
        r'enodeb.*id',
        r'\.enbid\b',
        r'\.enodebid\b',
        r'\.enodeb\b'
    ],
    # Local Cell ID (sometimes explicit)
    'cell_id': [
        r'\.(local)?cellid\b',
        r'cell\s*id\b',
        r'cellid\b'
    ]
}

INFO_LABELS = {
    'cellid': 'Cellid',
    'pci': 'Physical cell ID',
    'dl_earfcn': 'Downlink EARFCN',
    'tac': 'Tracking area code',
    'enodeb_id': 'eNodeB ID',
    'cell_id': 'Cell ID'
}

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


def is_safe_member_path(member_name):
    norm = os.path.normpath(member_name.replace('\\', '/'))
    if norm.startswith('../') or norm.startswith('..\\'):
        return False
    if os.path.isabs(norm):
        return False
    return True


def safe_extract_zip(zip_path, out_dir):
    extracted = []
    with zipfile.ZipFile(zip_path, 'r') as zf:
        for info in zf.infolist():
            name = info.filename
            if not is_safe_member_path(name):
                raise ValueError(f'Unsafe zip member path: {name}')
            if name.endswith('/'):
                continue
            dest_path = os.path.abspath(os.path.join(out_dir, os.path.normpath(name)))
            out_abs = os.path.abspath(out_dir)
            if not (dest_path == out_abs or dest_path.startswith(out_abs + os.sep)):
                raise ValueError(f'Zip-slip blocked: {name}')
            os.makedirs(os.path.dirname(dest_path), exist_ok=True)
            with zf.open(info, 'r') as src, open(dest_path, 'wb') as dst:
                dst.write(src.read())
            extracted.append(dest_path)
    return extracted


def decompress_cdf_payload(raw_bytes):
    if raw_bytes is None:
        return b''
    payload = raw_bytes

    def find_zlib_start(b, max_scan=64):
        max_i = min(len(b) - 2, max_scan)
        for i in range(max_i):
            if b[i] == 0x78 and b[i + 1] in (0x01, 0x9C, 0xDA):
                return i
        return -1

    start = find_zlib_start(payload)
    zpayload = payload[start:] if start >= 0 else payload
    attempts = []

    try:
        out = zlib.decompress(zpayload)
        return out
    except Exception as e:
        attempts.append(f'zlib:{e}')

    try:
        out = zlib.decompress(zpayload, -zlib.MAX_WBITS)
        if len(out) >= max(8, int(len(zpayload) * 0.2)):
            return out
        attempts.append(f'rawdeflate:output_too_small({len(out)})')
    except Exception as e:
        attempts.append(f'rawdeflate:{e}')

    # If it looks compressed but inflate failed, surface the error instead of silently
    # returning compressed bytes as "plain".
    if start >= 0:
        raise ValueError('Found zlib header but decompression failed: ' + '; '.join(attempts))

    return payload


def read_varint(data, pos):
    shift = 0
    result = 0
    while pos < len(data):
        b = data[pos]
        pos += 1
        result |= (b & 0x7F) << shift
        if not (b & 0x80):
            return result, pos
        shift += 7
        if shift > 70:
            break
    return None, pos


def iter_len_prefixed_records(buf, max_records=5_000_000):
    """Iterate <varint length><bytes> records. Falls back to single record if framing not detected."""
    if not buf:
        return
    pos = 0
    records = 0
    # quick probe: first varint length must be plausible
    first_len, p2 = read_varint(buf, 0)
    framing_ok = isinstance(first_len, int) and 0 < first_len < len(buf) and p2 < len(buf) and (p2 + first_len) <= len(buf)
    if not framing_ok:
        # yield as one record
        yield buf
        return
    while pos < len(buf) and records < max_records:
        ln, pos2 = read_varint(buf, pos)
        if not isinstance(ln, int) or ln <= 0:
            break
        end = pos2 + ln
        if end > len(buf):
            break
        rec = buf[pos2:end]
        if rec:
            yield rec
            records += 1
        pos = end
    if records == 0:
        yield buf



def iter_fields(data, max_fields=100000):
    pos = 0
    count = 0
    ln = len(data)
    while pos < ln and count < max_fields:
        key, pos2 = read_varint(data, pos)
        if key is None:
            break
        pos = pos2
        field_no = key >> 3
        wire = key & 0x07
        if wire == 0:
            val, pos = read_varint(data, pos)
            yield field_no, wire, val
        elif wire == 1:
            if pos + 8 > ln:
                break
            yield field_no, wire, data[pos:pos + 8]
            pos += 8
        elif wire == 2:
            length, pos = read_varint(data, pos)
            if length is None or length < 0 or pos + length > ln:
                break
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
    try:
        s = b.decode('utf-8')
    except Exception:
        try:
            s = b.decode('latin1')
        except Exception:
            return None
    s = s.strip('\x00').strip()
    if not s:
        return None
    printable = sum(1 for ch in s if 32 <= ord(ch) <= 126 or ch in '\n\r\t')
    if printable / max(1, len(s)) < 0.75:
        return None
    return s


def parse_declarations(decl_bytes):
    """
    Parse declarations from TRP CDF declarations stream.
    In TEMS Pocket TRPs this is typically a sequence of length-prefixed protobuf messages
    where each message directly contains fields like:
      - a short dotted name (often field 1, wire 2)
      - a numeric metric id (often field 2, wire 0)
      - an optional description (wire 2)
    We extract a best-effort id->name map.
    """
    metric_map = {}

    for rec in iter_len_prefixed_records(decl_bytes):
        strings = []
        ints = []
        for f, w, v in iter_fields(rec, max_fields=300):
            if w == 2:
                s = try_decode_text(v)
                if s:
                    strings.append((f, s))
            elif w == 0 and isinstance(v, int):
                ints.append((f, int(v)))

        if not ints or not strings:
            continue

        # metric id is very often field 2
        metric_id = None
        for f, n in ints:
            if f == 2 and n > 0:
                metric_id = n
                break
        if metric_id is None:
            for _, n in ints:
                if n > 1000:
                    metric_id = n
                    break

        # metric name is often field 1 and includes dots
        name = None
        for f, s in strings:
            if f == 1 and '.' in s and 3 < len(s) < 200:
                name = s
                break
        if name is None:
            for _, s in strings:
                if '.' in s and 3 < len(s) < 200:
                    name = s
                    break
        if name is None:
            name = strings[0][1]

        if metric_id and name and metric_id not in metric_map:
            metric_map[int(metric_id)] = {'name': name, 'dtype': 'unknown', 'lookup': None}

    # Fallback: some declarations payloads are semi-binary with embedded metric names.
    if metric_map:
        return metric_map

    seen = set()
    for m in re.finditer(rb'([A-Za-z][A-Za-z0-9_.\[\]\-]{4,160})\x10', decl_bytes or b''):
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
        metric_id, _ = read_varint(decl_bytes, m.end())
        if not isinstance(metric_id, int) or metric_id <= 0:
            continue
        metric_map[int(metric_id)] = {'name': name, 'dtype': 'unknown', 'lookup': None}
        seen.add(name)

    return metric_map

def parse_lookups(lookup_bytes):
    """
    Parse lookup tables (enums) from TRP CDF lookuptables stream.
    Stored commonly as length-prefixed protobuf messages.
    Returns mapping: table_name -> {int_value: label}
    """
    lookups = {}

    def _ingest_message(msg_bytes: bytes):
        nonlocal lookups
        for _, wire, payload in iter_fields(msg_bytes, max_fields=200000):
            if wire != 2 or not payload:
                continue
            table_name = None
            entries = {}
            nested_chunks = []
            for _, w2, v2 in iter_fields(payload, max_fields=800):
                if w2 == 2:
                    s = try_decode_text(v2)
                    if s and table_name is None and len(s) < 120 and (' ' not in s or len(s.split()) <= 3):
                        table_name = s
                    nested_chunks.append(v2)

            for ch in nested_chunks:
                txt = None
                val = None
                for _, w3, v3 in iter_fields(ch, max_fields=80):
                    if w3 == 2 and txt is None:
                        s = try_decode_text(v3)
                        if s:
                            txt = s
                    elif w3 == 0 and isinstance(v3, int):
                        val = int(v3)
                if txt is not None and val is not None:
                    entries[val] = txt

            if table_name and entries and table_name not in lookups:
                lookups[table_name] = entries

    for rec in iter_len_prefixed_records(lookup_bytes):
        _ingest_message(rec)

    return lookups

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


def parse_metric_sample(sample_payload):
    metric_id = None
    value_num = None
    value_str = None
    varints = []

    for f, w, v in iter_fields(sample_payload, max_fields=100):
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

    if metric_id is None:
        for _, v in varints:
            if v > 1000:
                metric_id = v
                break

    if value_num is None and value_str is None and varints:
        v = varints[0][1]
        if -10_000_000_000 < v < 10_000_000_000:
            value_num = float(v)

    return metric_id, value_num, value_str


def decode_data_cdf(data_bytes, metric_map, lookups):
    """
    Decode KPI samples from TRP CDF data stream.
    Records are usually framed as <varint len><protobuf msg>.
    Each msg commonly contains:
      - field 1 (wire 2): timestamp message with (field1=epoch seconds, field2=nanos)
      - other wire-2 submessages: metric sample messages with (field1=metric_id, field10=float32, etc.)
    """
    kpis = []
    events = []

    for rec in iter_len_prefixed_records(data_bytes):
        ts_iso = None
        samples = []

        for f, w, v in iter_fields(rec, max_fields=200):
            if f == 1 and w == 2 and v:
                # timestamp submessage
                sec = None
                nanos = 0
                for f2, w2, v2 in iter_fields(v, max_fields=20):
                    if f2 == 1 and w2 == 0 and isinstance(v2, int):
                        sec = int(v2)
                    elif f2 == 2 and w2 == 0 and isinstance(v2, int):
                        nanos = int(v2)
                if sec is not None and 946684800 <= sec <= 4102444800:
                    # include nanos if present
                    ts_iso = utc_iso_from_epoch_seconds(sec + (nanos / 1e9 if nanos else 0))
            elif w == 2 and v:
                metric_id, value_num, value_str = parse_metric_sample(v)
                if metric_id:
                    samples.append((metric_id, value_num, value_str))

        if not ts_iso or not samples:
            continue

        for metric_id, value_num, value_str in samples:
            meta = metric_map.get(metric_id, {})
            name = meta.get('name') or f'Metric.{metric_id}'
            dtype = meta.get('dtype') or 'unknown'
            lookup_name = meta.get('lookup')

            mapped_str = value_str
            if mapped_str is None and value_num is not None and lookup_name and lookup_name in lookups:
                mapped = lookups[lookup_name].get(int(value_num))
                if mapped is not None:
                    mapped_str = str(mapped)

            kpis.append({
                'time': ts_iso,
                'metric_id': int(metric_id),
                'name': name,
                'value_num': value_num,
                'value_str': mapped_str,
                'dtype': dtype,
                'lookup': lookup_name
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

    if len(events) > MAX_EVENT_ROWS:
        events = events[:MAX_EVENT_ROWS]
    return kpis, events

def parse_wptrack_xml(path):
    points = []
    if not os.path.exists(path):
        return points
    try:
        tree = ET.parse(path)
        root = tree.getroot()
        for elem in root.iter():
            tag = elem.tag.lower()
            if tag.endswith('trkpt') or tag.endswith('wpt') or tag.endswith('point'):
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


def ensure_schema(conn):
    cur = conn.cursor()
    cur.executescript(
        """
        CREATE TABLE IF NOT EXISTS runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            filename TEXT NOT NULL,
            imported_at TEXT NOT NULL,
            start_time TEXT,
            end_time TEXT,
            metadata_json TEXT
        );
        CREATE TABLE IF NOT EXISTS kpi_samples (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            run_id INTEGER NOT NULL,
            time TEXT NOT NULL,
            metric_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            value_num REAL,
            value_str TEXT,
            dtype TEXT,
            lookup TEXT,
            FOREIGN KEY(run_id) REFERENCES runs(id)
        );
        CREATE TABLE IF NOT EXISTS events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            run_id INTEGER NOT NULL,
            time TEXT NOT NULL,
            event_name TEXT NOT NULL,
            metric_id INTEGER,
            params_json TEXT,
            FOREIGN KEY(run_id) REFERENCES runs(id)
        );
        CREATE TABLE IF NOT EXISTS track_points (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            run_id INTEGER NOT NULL,
            time TEXT,
            lat REAL NOT NULL,
            lon REAL NOT NULL,
            alt REAL,
            speed REAL,
            FOREIGN KEY(run_id) REFERENCES runs(id)
        );
        CREATE TABLE IF NOT EXISTS run_metrics (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            run_id INTEGER NOT NULL,
            metric_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            dtype TEXT,
            lookup TEXT,
            value_kind TEXT,
            path_json TEXT,
            tags_json TEXT,
            stats_json TEXT,
            FOREIGN KEY(run_id) REFERENCES runs(id)
        );
        CREATE TABLE IF NOT EXISTS run_events_catalog (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            run_id INTEGER NOT NULL,
            event_name TEXT NOT NULL,
            metric_id INTEGER,
            count INTEGER NOT NULL,
            first_seen TEXT,
            last_seen TEXT,
            param_ids_json TEXT,
            FOREIGN KEY(run_id) REFERENCES runs(id)
        );
        CREATE TABLE IF NOT EXISTS kpi_summary (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            run_id INTEGER NOT NULL,
            kpi_type TEXT NOT NULL,
            chosen_name TEXT,
            sample_count INTEGER NOT NULL DEFAULT 0,
            avg REAL,
            min REAL,
            max REAL,
            first_time TEXT,
            last_time TEXT,
            meta_json TEXT,
            FOREIGN KEY(run_id) REFERENCES runs(id)
        );
        CREATE INDEX IF NOT EXISTS idx_kpi_run_time ON kpi_samples(run_id, time);
        CREATE INDEX IF NOT EXISTS idx_kpi_run_name ON kpi_samples(run_id, name);
        CREATE INDEX IF NOT EXISTS idx_events_run_time ON events(run_id, time);
        CREATE INDEX IF NOT EXISTS idx_track_run_time ON track_points(run_id, time);
        CREATE INDEX IF NOT EXISTS idx_run_metrics_run_name ON run_metrics(run_id, name);
        CREATE INDEX IF NOT EXISTS idx_run_events_catalog_run_name ON run_events_catalog(run_id, event_name);
        CREATE INDEX IF NOT EXISTS idx_kpi_summary_run_type ON kpi_summary(run_id, kpi_type);
        CREATE INDEX IF NOT EXISTS idx_kpi_summary_run_sample ON kpi_summary(run_id, sample_count);
        """
    )
    conn.commit()
    sync_if_needed(conn)


def _derive_tags(name):
    up = StringUpper(name)
    tags = [kw for kw in TAG_KEYWORDS if kw in up]
    return tags


def StringUpper(v):
    return str(v or '').upper()


def infer_value_kind(dtype, sample_num_count, sample_str_count):
    d = StringUpper(dtype)
    if any(x in d for x in ('INT', 'FLOAT', 'DOUBLE', 'NUM', 'DECIMAL', 'LONG', 'SHORT')):
        return 'numeric'
    if any(x in d for x in ('STRING', 'TEXT', 'BOOL', 'ENUM')):
        return 'string'
    if sample_num_count > sample_str_count:
        return 'numeric'
    if sample_str_count > 0:
        return 'string'
    return 'numeric'


def build_metric_catalog(kpis):
    by_name = {}
    for row in kpis:
        name = row.get('name')
        if not name:
            continue
        metric_id = int(row.get('metric_id') or 0)
        key = name
        item = by_name.get(key)
        if item is None:
            item = {
                'metric_id': metric_id,
                'name': name,
                'dtype': row.get('dtype') or 'unknown',
                'lookup': row.get('lookup'),
                '_num_count': 0,
                '_str_count': 0,
                '_sample_count': 0,
                '_sum': 0.0,
                '_min': None,
                '_max': None
            }
            by_name[key] = item
        val_num = row.get('value_num')
        val_str = row.get('value_str')
        if isinstance(val_num, (int, float)):
            f = float(val_num)
            item['_num_count'] += 1
            item['_sample_count'] += 1
            item['_sum'] += f
            item['_min'] = f if item['_min'] is None else min(item['_min'], f)
            item['_max'] = f if item['_max'] is None else max(item['_max'], f)
        elif val_str is not None:
            item['_str_count'] += 1
            item['_sample_count'] += 1

    out = []
    for item in by_name.values():
        kind = infer_value_kind(item.get('dtype'), item['_num_count'], item['_str_count'])
        stats = {'sample_count': item['_sample_count']}
        if item['_num_count'] > 0:
            stats.update({
                'min': item['_min'],
                'max': item['_max'],
                'avg': (item['_sum'] / item['_num_count']) if item['_num_count'] else None
            })
        out.append({
            'metric_id': item['metric_id'],
            'name': item['name'],
            'dtype': item.get('dtype') or 'unknown',
            'lookup': item.get('lookup'),
            'value_kind': kind,
            'path_segments': str(item['name']).split('.'),
            'tags': _derive_tags(item['name']),
            'stats': stats
        })
    out.sort(key=lambda x: x['name'])
    return out


def build_metric_catalog_from_map(metric_map):
    out = []
    for metric_id, meta in (metric_map or {}).items():
        name = str((meta or {}).get('name') or f'Metric.{metric_id}')
        out.append({
            'metric_id': int(metric_id),
            'name': name,
            'dtype': (meta or {}).get('dtype') or 'unknown',
            'lookup': (meta or {}).get('lookup'),
            'value_kind': 'numeric',
            'path_segments': name.split('.'),
            'tags': _derive_tags(name),
            'stats': {'sample_count': 0}
        })
    out.sort(key=lambda x: x['name'])
    return out


def build_event_catalog(events):
    by_name = {}
    for e in events:
        name = e.get('event_name')
        if not name:
            continue
        time = e.get('time')
        metric_id = int(e.get('metric_id') or 0) if e.get('metric_id') is not None else None
        item = by_name.get(name)
        if item is None:
            item = {
                'event_name': name,
                'metric_id': metric_id,
                'count': 0,
                'first_seen_time': time,
                'last_seen_time': time,
                '_param_ids': set()
            }
            by_name[name] = item
        item['count'] += 1
        if time and (item['first_seen_time'] is None or time < item['first_seen_time']):
            item['first_seen_time'] = time
        if time and (item['last_seen_time'] is None or time > item['last_seen_time']):
            item['last_seen_time'] = time
        params = e.get('params') or []
        for p in params:
            pid = p.get('param_id')
            if pid is not None:
                item['_param_ids'].add(str(pid))

    out = []
    for item in by_name.values():
        out.append({
            'event_name': item['event_name'],
            'metric_id': item['metric_id'],
            'count': item['count'],
            'first_seen_time': item['first_seen_time'],
            'last_seen_time': item['last_seen_time'],
            'param_ids': sorted(item['_param_ids'])
        })
    out.sort(key=lambda x: x['event_name'])
    return out


def build_metrics_tree(metrics_flat):
    roots = {}

    def ensure_folder(parent_children, key, label):
        for c in parent_children:
            if c.get('type') == 'folder' and c.get('key') == key:
                return c
        node = {'key': key, 'label': label, 'type': 'folder', 'children': []}
        parent_children.append(node)
        return node

    top = []
    for metric in metrics_flat:
        segs = metric.get('path_segments') or str(metric.get('name') or '').split('.')
        if not segs:
            continue
        current_children = top
        path_acc = []
        for seg in segs[:-1]:
            path_acc.append(seg)
            node = ensure_folder(current_children, '.'.join(path_acc), seg)
            current_children = node['children']
        leaf_key = metric.get('name')
        current_children.append({
            'key': leaf_key,
            'label': segs[-1],
            'type': 'metric',
            'metric': {
                'metric_id': metric.get('metric_id'),
                'name': metric.get('name'),
                'dtype': metric.get('dtype'),
                'lookup': metric.get('lookup'),
                'value_kind': metric.get('value_kind'),
                'stats': metric.get('stats') or {}
            }
        })
    return top


def pick_default_metrics(metrics_flat):
    names = [str(m.get('name') or '') for m in metrics_flat]
    lower = [(n, n.lower()) for n in names]

    def pick(keyword):
        for raw, lo in lower:
            if keyword in lo:
                return raw
        return None

    return {
        'rsrpMetricName': pick('rsrp'),
        'sinrMetricName': pick('sinr'),
        'mosMetricName': pick('mos')
    }


def build_events_grouped(events_catalog):
    grouped = {}
    for item in events_catalog:
        name = str(item.get('event_name') or '')
        prefix = name.split('.', 1)[0].strip() if '.' in name else (name.split('_', 1)[0].strip() if '_' in name else '')
        if not prefix:
            prefix = 'Other'
        grouped.setdefault(prefix, []).append(item)
    for rows in grouped.values():
        rows.sort(key=lambda x: (str(x.get('event_name') or '').lower(), -int(x.get('count') or 0)))
    return grouped


def _safe_float(v):
    try:
        f = float(v)
        if f != f:  # NaN guard
            return None
        return f
    except Exception:
        return None


def _normalize_metric_name(name):
    low = str(name or '').lower().strip()
    low = low.replace('_', '.')
    low = re.sub(r'\s+', '', low)
    return low


def _candidate_matches(metric_name, kpi_type):
    low = _normalize_metric_name(metric_name)
    for pat in KPI_PATTERNS.get(kpi_type, []):
        if re.search(pat, low, flags=re.IGNORECASE):
            return True
    return False


def _metric_score(metric_name, sample_count):
    low = _normalize_metric_name(metric_name)
    score = 0
    if 'servingcell' in low:
        score += 5
    if 'pdsch' in low:
        score += 4
    if 'pusch' in low:
        score += 4
    if 'http' in low and 'throughput' in low:
        score += 2

    if 'downlink' in low or '.dl.' in low or low.endswith('.dl'):
        score += 3
    if 'uplink' in low or '.ul.' in low or low.endswith('.ul'):
        score += 3
    if 'pocket.data' in low:
        score += 2
    score += min(1000, int(sample_count or 0))
    return score



def _info_candidate_matches(metric_name, info_key):
    low = _normalize_metric_name(metric_name)
    for pat in INFO_PATTERNS.get(info_key, []):
        if re.search(pat, low, flags=re.IGNORECASE):
            return True
    return False


def build_trp_info_summary(kpis, metric_map=None):
    """Extract stable LTE/NR identifiers (PCI/TAC/EARFCN/etc.) from decoded KPI samples."""
    metric_map = metric_map or {}
    names_from_decl = [str((meta or {}).get('name') or '') for _, meta in metric_map.items() if (meta or {}).get('name')]
    by_name_counts = {}
    by_name_mode = {}

    for row in kpis:
        name = str(row.get('name') or '')
        if not name:
            continue
        v_num = _safe_float(row.get('value_num'))
        v_str = (row.get('value_str') or None)
        token = None
        if v_num is not None and abs(v_num - int(v_num)) < 1e-6:
            token = int(v_num)
        elif v_num is not None:
            token = float(v_num)
        elif v_str:
            token = str(v_str)
        if token is None:
            continue
        d = by_name_counts.get(name)
        if d is None:
            d = {}
            by_name_counts[name] = d
        d[token] = d.get(token, 0) + 1

    for name, counts in by_name_counts.items():
        best_token, best_count = None, -1
        for tok, c in counts.items():
            if c > best_count:
                best_token, best_count = tok, c
        by_name_mode[name] = {'value': best_token, 'count': best_count, 'sample_count': sum(counts.values())}

    all_known_names = sorted(set([n for n in names_from_decl if n] + list(by_name_mode.keys())))
    out = {}

    def pick_best(info_key):
        candidates = [n for n in all_known_names if _info_candidate_matches(n, info_key)]
        if not candidates:
            return None, None
        scored = []
        for n in candidates:
            meta = by_name_mode.get(n) or {}
            sc = int(meta.get('sample_count') or 0)
            score = _metric_score(n, sc)
            scored.append((score, sc, n))
        scored.sort(key=lambda x: (-x[0], -x[1], x[2]))
        for _, sc, n in scored:
            if sc > 0:
                v = (by_name_mode.get(n) or {}).get('value')
                return n, v
        return scored[0][2], None

    for key in INFO_LABELS.keys():
        name, val = pick_best(key)
        if name:
            out[key] = {'label': INFO_LABELS[key], 'metric': name, 'value': val}

    cellid_val = (out.get('cellid') or {}).get('value')

    def is_intlike(x):
        return isinstance(x, int) or (isinstance(x, float) and abs(x - int(x)) < 1e-6)

    if cellid_val is not None and is_intlike(cellid_val):
        ecgi = int(cellid_val)
        derived_enb = ecgi // 256
        derived_cell = ecgi % 256
        if (out.get('enodeb_id') or {}).get('value') in (None, ''):
            out['enodeb_id'] = {'label': INFO_LABELS['enodeb_id'], 'metric': (out.get('cellid') or {}).get('metric'), 'value': derived_enb, 'derivedFrom': 'cellid'}
        if (out.get('cell_id') or {}).get('value') in (None, ''):
            out['cell_id'] = {'label': INFO_LABELS['cell_id'], 'metric': (out.get('cellid') or {}).get('metric'), 'value': derived_cell, 'derivedFrom': 'cellid'}

    simple = {k: obj.get('value') for k, obj in out.items()}
    return {'fields': out, 'values': simple}


def build_kpi_type_summary(kpis, metric_map=None):
    metric_map = metric_map or {}
    names_from_decl = [str((meta or {}).get('name') or '') for _, meta in metric_map.items() if (meta or {}).get('name')]
    by_name = {}

    for row in kpis:
        name = str(row.get('name') or '')
        if not name:
            continue
        item = by_name.get(name)
        if item is None:
            item = {
                'sample_count': 0,
                'num_count': 0,
                'sum': 0.0,
                'min': None,
                'max': None,
                'first_time': None,
                'last_time': None
            }
            by_name[name] = item
        item['sample_count'] += 1
        t = row.get('time')
        if t and (item['first_time'] is None or t < item['first_time']):
            item['first_time'] = t
        if t and (item['last_time'] is None or t > item['last_time']):
            item['last_time'] = t
        f = _safe_float(row.get('value_num'))
        if f is not None:
            item['num_count'] += 1
            item['sum'] += f
            item['min'] = f if item['min'] is None else min(item['min'], f)
            item['max'] = f if item['max'] is None else max(item['max'], f)

    all_known_names = sorted(set([n for n in names_from_decl if n] + list(by_name.keys())))
    chosen = {k: None for k in KPI_TYPE_ORDER}
    stats = {}
    missing_data = []

    for kpi_type in KPI_TYPE_ORDER:
        candidates = [n for n in all_known_names if _candidate_matches(n, kpi_type)]
        if not candidates:
            missing_data.append({
                'kpi_type': kpi_type,
                'reason': 'KPI not found in declarations',
                'candidatesFoundCount': 0
            })
            stats[kpi_type] = {
                'sample_count': 0,
                'avg': None,
                'min': None,
                'max': None,
                'first_time': None,
                'last_time': None
            }
            continue

        scored = []
        for name in candidates:
            sample_count = int((by_name.get(name) or {}).get('sample_count') or 0)
            scored.append((_metric_score(name, sample_count), sample_count, name))
        scored.sort(key=lambda x: (-x[0], -x[1], x[2]))

        best_name = None
        best_item = None
        for _, sc, name in scored:
            if sc > 0:
                best_name = name
                best_item = by_name.get(name)
                break
        if not best_name:
            best_name = scored[0][2]
            best_item = by_name.get(best_name)

        chosen[kpi_type] = best_name
        if not best_item or int(best_item.get('sample_count') or 0) <= 0:
            missing_data.append({
                'kpi_type': kpi_type,
                'reason': 'KPI exists but has 0 decoded samples',
                'candidatesFoundCount': len(candidates)
            })
            stats[kpi_type] = {
                'sample_count': 0,
                'avg': None,
                'min': None,
                'max': None,
                'first_time': None,
                'last_time': None
            }
            continue

        num_count = int(best_item.get('num_count') or 0)
        avg = (best_item['sum'] / num_count) if num_count > 0 else None
        stats[kpi_type] = {
            'sample_count': int(best_item.get('sample_count') or 0),
            'avg': avg,
            'min': best_item.get('min'),
            'max': best_item.get('max'),
            'first_time': best_item.get('first_time'),
            'last_time': best_item.get('last_time')
        }

    return {'chosen': chosen, 'stats': stats, 'missingData': missing_data}


def parse_services_xml(path, base_time_iso=None):
    rows = []
    if not os.path.exists(path):
        return rows
    try:
        root = ET.parse(path).getroot()
    except Exception:
        return rows

    ns_uri = ''
    if root.tag.startswith('{') and '}' in root.tag:
        ns_uri = root.tag[1:root.tag.index('}')]
    ns = {'x': ns_uri} if ns_uri else {}
    q = (lambda t: f'{{{ns_uri}}}{t}') if ns_uri else (lambda t: t)

    items = root.findall('.//x:ServiceInformation', ns) if ns_uri else root.findall('.//ServiceInformation')
    base_dt = parse_iso(base_time_iso) if base_time_iso else None
    seq = 0

    for item in items:
        props = {}
        plist = item.findall('.//x:Property', ns) if ns_uri else item.findall('.//Property')
        for p in plist:
            n = p.findtext(q('Name')) if ns_uri else p.findtext('Name')
            n = (n or '').strip()
            if not n:
                continue
            texts = [t.strip() for t in p.itertext() if t and t.strip()]
            if texts:
                props[n] = texts[-1]

        event_name = props.get('Name') or props.get('Identity') or props.get('ServiceIdentity') or 'ServiceEvent'
        utc_raw = props.get('UtcTime') or props.get('UtcTimestamp') or props.get('Timestamp') or props.get('Time')
        ts_iso = None
        if utc_raw:
            dt = parse_iso(utc_raw)
            if dt is not None:
                ts_iso = dt.isoformat().replace('+00:00', 'Z')
            else:
                try:
                    sec = float(utc_raw)
                    if 946684800 <= sec <= 4102444800:
                        ts_iso = utc_iso_from_epoch_seconds(sec)
                    elif base_dt is not None:
                        ts_iso = (base_dt.replace(tzinfo=timezone.utc).timestamp() + sec)
                        ts_iso = utc_iso_from_epoch_seconds(ts_iso)
                except Exception:
                    pass

        if not ts_iso:
            # Ensure events are still available in catalog/timeline.
            if base_dt is not None:
                ts_iso = utc_iso_from_epoch_seconds(base_dt.replace(tzinfo=timezone.utc).timestamp() + seq)
            else:
                ts_iso = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
            seq += 1

        params = []
        for k, v in props.items():
            params.append({'param_id': k, 'param_value': v, 'param_type': 'string'})

        rows.append({
            'time': ts_iso,
            'event_name': str(event_name),
            'metric_id': None,
            'params': params
        })
    return rows


def _calc_time_bounds(kpis, events, track_points):
    all_times = []
    for row in kpis:
        if row.get('time'):
            all_times.append(row['time'])
    for row in events:
        if row.get('time'):
            all_times.append(row['time'])
    for row in track_points:
        if row.get('time'):
            all_times.append(row['time'])
    parsed = [parse_iso(t) for t in all_times]
    parsed = [p for p in parsed if p is not None]
    if not parsed:
        return None, None
    return min(parsed).isoformat().replace('+00:00', 'Z'), max(parsed).isoformat().replace('+00:00', 'Z')


def import_trp_file(trp_path, db_path, storage_dir):
    os.makedirs(storage_dir, exist_ok=True)
    os.makedirs(os.path.dirname(db_path), exist_ok=True)

    stages = ['extracting']

    with tempfile.TemporaryDirectory(prefix='trp_extract_') as temp_dir:
        safe_extract_zip(trp_path, temp_dir)

        provider_cdf_dirs = []
        providers_root = os.path.join(temp_dir, 'trp', 'providers')
        if os.path.isdir(providers_root):
            for name in os.listdir(providers_root):
                if not name.lower().startswith('sp'):
                    continue
                cdf_dir = os.path.join(providers_root, name, 'cdf')
                if os.path.isdir(cdf_dir):
                    provider_cdf_dirs.append(cdf_dir)

        metric_map = {}
        lookups = {}
        kpis = []
        events = []
        metrics_catalog = None
        events_catalog = None
        import_report = {}

        raw_channel = os.path.join(temp_dir, 'trp', 'channel.log')
        raw_decl = os.path.join(temp_dir, 'trp', 'declarations.bin')
        raw_lookup = os.path.join(temp_dir, 'trp', 'lookuptables.bin')
        is_raw_variant = os.path.exists(raw_channel) and (os.path.exists(raw_decl) or os.path.exists(raw_lookup)) and len(provider_cdf_dirs) == 0

        stages.append('decoding')
        if is_raw_variant:
            raw_decoded = decode_raw_trp_variant(temp_dir)
            kpis = raw_decoded.get('kpiSamples') or []
            events = raw_decoded.get('events') or []
            track_points = raw_decoded.get('trackPoints') or []
            metrics_catalog = (raw_decoded.get('catalogs') or {}).get('metrics') or []
            events_catalog = (raw_decoded.get('catalogs') or {}).get('events') or []
            import_report = raw_decoded.get('importReport') or {}
        else:
            for cdf_dir in provider_cdf_dirs:
                decl_path = os.path.join(cdf_dir, 'declarations.cdf')
                lookup_path = os.path.join(cdf_dir, 'lookuptables.cdf')
                data_path = os.path.join(cdf_dir, 'data.cdf')

                if os.path.exists(decl_path):
                    with open(decl_path, 'rb') as f:
                        metric_map.update(parse_declarations(decompress_cdf_payload(f.read())))
                if os.path.exists(lookup_path):
                    with open(lookup_path, 'rb') as f:
                        lookups.update(parse_lookups(decompress_cdf_payload(f.read())))
                if os.path.exists(data_path):
                    with open(data_path, 'rb') as f:
                        part_kpis, part_events = decode_data_cdf(decompress_cdf_payload(f.read()), metric_map, lookups)
                        kpis.extend(part_kpis)
                        events.extend(part_events)

            track_path = os.path.join(temp_dir, 'trp', 'positions', 'wptrack.xml')
            track_points = parse_wptrack_xml(track_path)
            base_time_for_services = track_points[0]['time'] if track_points else None
            if len(kpis) == 0 and os.path.isdir(providers_root):
                # Fallback for provider channel.log variant where data.cdf decode yields no KPI samples.
                raw_fallback = decode_provider_channels_variant(temp_dir, metric_map, lookups, base_time_iso=base_time_for_services)
                fb_kpis = raw_fallback.get('kpiSamples') or []
                fb_events = raw_fallback.get('events') or []
                if fb_kpis:
                    kpis.extend(fb_kpis)
                if fb_events:
                    events.extend(fb_events)
                import_report = raw_fallback.get('report') or {}
            if os.path.isdir(providers_root):
                for name in os.listdir(providers_root):
                    if not name.lower().startswith('sp'):
                        continue
                    services_path = os.path.join(providers_root, name, 'services', 'services.xml')
                    service_events = parse_services_xml(services_path, base_time_iso=base_time_for_services)
                    if service_events:
                        events.extend(service_events)

    start_time, end_time = _calc_time_bounds(kpis, events, track_points)
    kpi_selection = build_kpi_type_summary(kpis, metric_map)
    chosen = kpi_selection['chosen']
    chosen_stats = kpi_selection['stats']
    missing_data = kpi_selection['missingData']
    trp_info = build_trp_info_summary(kpis, metric_map)
    inferred_names = sorted(list({r['name'] for r in kpis if r.get('name')}))
    if not inferred_names and metric_map:
        inferred_names = sorted(list({(meta or {}).get('name') for _, meta in metric_map.items() if (meta or {}).get('name')}))

    variant = 'raw' if is_raw_variant else 'cdf'
    metadata = {
        'providers_detected': len(provider_cdf_dirs),
        'metric_count': len(kpis),
        'event_count': len(events),
        'track_points': len(track_points),
        'kpi_names': inferred_names[:5000],
        'chosen_kpis': chosen,
        'trp_info': trp_info,
        'variant': variant
    }

    stages.append('saving')
    conn = connect_db(db_path)
    try:
        ensure_schema(conn)
        cur = conn.cursor()
        cur.execute(
            "INSERT INTO runs(filename, imported_at, start_time, end_time, metadata_json) VALUES(?,?,?,?,?)",
            (os.path.basename(trp_path), datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'), start_time, end_time, json.dumps(metadata))
        )
        run_id = cur.lastrowid

        cur.executemany(
            "INSERT INTO kpi_samples(run_id, time, metric_id, name, value_num, value_str, dtype, lookup) VALUES(?,?,?,?,?,?,?,?)",
            [
                (run_id, r.get('time'), int(r.get('metric_id') or 0), r.get('name') or '', r.get('value_num'), r.get('value_str'), r.get('dtype') or 'unknown', r.get('lookup'))
                for r in kpis if r.get('time') and r.get('name')
            ]
        )
        cur.executemany(
            "INSERT INTO events(run_id, time, event_name, metric_id, params_json) VALUES(?,?,?,?,?)",
            [
                (run_id, e.get('time'), e.get('event_name') or '', int(e.get('metric_id') or 0), json.dumps(e.get('params') or []))
                for e in events if e.get('time') and e.get('event_name')
            ]
        )
        cur.executemany(
            "INSERT INTO track_points(run_id, time, lat, lon, alt, speed) VALUES(?,?,?,?,?,?)",
            [
                (run_id, p.get('time'), float(p.get('lat')), float(p.get('lon')), p.get('alt'), p.get('speed'))
                for p in track_points
            ]
        )

        if metrics_catalog is None:
            metrics_catalog = build_metric_catalog(kpis)
            if not metrics_catalog and metric_map:
                metrics_catalog = build_metric_catalog_from_map(metric_map)
        if events_catalog is None:
            events_catalog = build_event_catalog(events)
        cur.executemany(
            "INSERT INTO run_metrics(run_id, metric_id, name, dtype, lookup, value_kind, path_json, tags_json, stats_json) VALUES(?,?,?,?,?,?,?,?,?)",
            [
                (
                    run_id,
                    int(m.get('metric_id') or 0),
                    m.get('name') or '',
                    m.get('dtype') or 'unknown',
                    m.get('lookup'),
                    m.get('value_kind') or 'numeric',
                    json.dumps(m.get('path_segments') or []),
                    json.dumps(m.get('tags') or []),
                    json.dumps(m.get('stats') or {})
                )
                for m in metrics_catalog if m.get('name')
            ]
        )
        cur.executemany(
            "INSERT INTO run_events_catalog(run_id, event_name, metric_id, count, first_seen, last_seen, param_ids_json) VALUES(?,?,?,?,?,?,?)",
            [
                (
                    run_id,
                    e.get('event_name') or '',
                    int(e.get('metric_id') or 0) if e.get('metric_id') is not None else None,
                    int(e.get('count') or 0),
                    e.get('first_seen_time'),
                    e.get('last_seen_time'),
                    json.dumps(e.get('param_ids') or [])
                )
                for e in events_catalog if e.get('event_name')
            ]
        )
        cur.executemany(
            "INSERT INTO kpi_summary(run_id, kpi_type, chosen_name, sample_count, avg, min, max, first_time, last_time, meta_json) VALUES(?,?,?,?,?,?,?,?,?,?)",
            [
                (
                    run_id,
                    kpi_type,
                    chosen.get(kpi_type),
                    int((chosen_stats.get(kpi_type) or {}).get('sample_count') or 0),
                    (chosen_stats.get(kpi_type) or {}).get('avg'),
                    (chosen_stats.get(kpi_type) or {}).get('min'),
                    (chosen_stats.get(kpi_type) or {}).get('max'),
                    (chosen_stats.get(kpi_type) or {}).get('first_time'),
                    (chosen_stats.get(kpi_type) or {}).get('last_time'),
                    json.dumps({
                        'candidatesFoundCount': next((m.get('candidatesFoundCount') for m in missing_data if m.get('kpi_type') == kpi_type), None)
                    })
                )
                for kpi_type in KPI_TYPE_ORDER
            ]
        )

        conn.commit()
        sync_if_needed(conn)
        stages.append('done')
        return {
            'runId': run_id,
            'metricsCount': len(metrics_catalog),
            'eventTypesCount': len(events_catalog),
            'chosen': chosen,
            'info': (trp_info or {}).get('values') or {},
            'stats': chosen_stats,
            'missingData': missing_data,
            'debug': {
                'variant': variant,
                'entriesFound': (import_report or {}).get('zipEntriesSummary') or {},
                'errors': (import_report or {}).get('errors') or []
            },
            'importReport': import_report or {
                'decodedSamples': len(kpis),
                'decodedEvents': len(events),
                'warnings': [],
                'errors': []
            },
            'stages': stages,
            'summary': {
                'filename': os.path.basename(trp_path),
                'startTime': start_time,
                'endTime': end_time,
                'kpiCount': len(kpis),
                'eventCount': len(events),
                'trackPoints': len(track_points)
            }
        }
    finally:
        conn.close()


def fetch_run_detail(db_path, run_id, event_limit=2000):
    conn = connect_db(db_path)
    conn.row_factory = sqlite3.Row
    try:
        ensure_schema(conn)
        cur = conn.cursor()
        run = cur.execute("SELECT * FROM runs WHERE id=?", (run_id,)).fetchone()
        if not run:
            return None
        metadata = {}
        try:
            metadata = json.loads(run['metadata_json'] or '{}')
        except Exception:
            metadata = {}
        track = [dict(r) for r in cur.execute("SELECT time,lat,lon,alt,speed FROM track_points WHERE run_id=? ORDER BY time", (run_id,)).fetchall()]
        events_rows = cur.execute("SELECT time,event_name,metric_id,params_json FROM events WHERE run_id=? ORDER BY time LIMIT ?", (run_id, int(event_limit))).fetchall()
        events = []
        for r in events_rows:
            try:
                params = json.loads(r['params_json'] or '[]')
            except Exception:
                params = []
            events.append({'time': r['time'], 'event_name': r['event_name'], 'metric_id': r['metric_id'], 'params': params})
        names = [row['name'] for row in cur.execute("SELECT DISTINCT name FROM kpi_samples WHERE run_id=? ORDER BY name", (run_id,)).fetchall()]
        return {
            'run': {
                'id': run['id'],
                'filename': run['filename'],
                'imported_at': run['imported_at'],
                'start_time': run['start_time'],
                'end_time': run['end_time'],
                'metadata': metadata
            },
            'track_points': track,
            'events': events,
            'kpi_names': names
        }
    finally:
        conn.close()


def fetch_kpi_series(db_path, run_id, name, limit=20000):
    conn = connect_db(db_path)
    conn.row_factory = sqlite3.Row
    try:
        ensure_schema(conn)
        cur = conn.cursor()
        rows = cur.execute("SELECT time,value_num,value_str,metric_id FROM kpi_samples WHERE run_id=? AND name=? ORDER BY time LIMIT ?", (run_id, name, int(limit))).fetchall()
        return [{'time': r['time'], 'value_num': r['value_num'], 'value_str': r['value_str'], 'metric_id': r['metric_id']} for r in rows]
    finally:
        conn.close()


def fetch_events(db_path, run_id, event_name=None, limit=5000):
    conn = connect_db(db_path)
    conn.row_factory = sqlite3.Row
    try:
        ensure_schema(conn)
        cur = conn.cursor()
        if event_name:
            rows = cur.execute(
                "SELECT time,event_name,metric_id,params_json FROM events WHERE run_id=? AND event_name=? ORDER BY time LIMIT ?",
                (run_id, event_name, int(limit))
            ).fetchall()
        else:
            rows = cur.execute(
                "SELECT time,event_name,metric_id,params_json FROM events WHERE run_id=? ORDER BY time LIMIT ?",
                (run_id, int(limit))
            ).fetchall()
        out = []
        for r in rows:
            try:
                params = json.loads(r['params_json'] or '[]')
            except Exception:
                params = []
            out.append({
                'time': r['time'],
                'event_name': r['event_name'],
                'metric_id': r['metric_id'],
                'params': params
            })
        return out
    finally:
        conn.close()


def fetch_run_signals(db_path, run_id):
    conn = connect_db(db_path)
    conn.row_factory = sqlite3.Row
    try:
        ensure_schema(conn)
        cur = conn.cursor()
        # Prefer persisted catalog (run_metrics) and merge sample-backed names as fallback.
        out = {}
        rows_catalog = cur.execute(
            "SELECT metric_id,name FROM run_metrics WHERE run_id=? AND name IS NOT NULL AND name<>'' ORDER BY name",
            (run_id,)
        ).fetchall()
        for r in rows_catalog:
            out[str(r['name'])] = {'signal_id': r['metric_id'], 'signal_name': r['name']}

        rows_samples = cur.execute(
            "SELECT DISTINCT metric_id,name FROM kpi_samples WHERE run_id=? AND name IS NOT NULL AND name<>'' ORDER BY name",
            (run_id,)
        ).fetchall()
        for r in rows_samples:
            if str(r['name']) not in out:
                out[str(r['name'])] = {'signal_id': r['metric_id'], 'signal_name': r['name']}

        return [out[k] for k in sorted(out.keys(), key=lambda x: x.lower())]
    finally:
        conn.close()


def fetch_timeseries_by_signal(db_path, run_id, signal, limit=50000):
    conn = connect_db(db_path)
    conn.row_factory = sqlite3.Row
    try:
        ensure_schema(conn)
        cur = conn.cursor()
        sig = str(signal or '').strip()
        if not sig:
            return []
        if sig.isdigit():
            rows = cur.execute(
                "SELECT time,value_num,value_str,metric_id,name FROM kpi_samples WHERE run_id=? AND metric_id=? ORDER BY time LIMIT ?",
                (run_id, int(sig), int(limit))
            ).fetchall()
        else:
            rows = cur.execute(
                "SELECT time,value_num,value_str,metric_id,name FROM kpi_samples WHERE run_id=? AND name=? ORDER BY time LIMIT ?",
                (run_id, sig, int(limit))
            ).fetchall()
        return [
            {
                't': r['time'],
                'value': r['value_num'] if r['value_num'] is not None else r['value_str'],
                'raw_value': r['value_num'] if r['value_num'] is not None else r['value_str'],
                'metric_id': r['metric_id'],
                'signal_name': r['name']
            }
            for r in rows
        ]
    finally:
        conn.close()


def fetch_run_track(db_path, run_id):
    conn = connect_db(db_path)
    conn.row_factory = sqlite3.Row
    try:
        ensure_schema(conn)
        cur = conn.cursor()
        rows = cur.execute(
            "SELECT time,lat,lon,alt,speed FROM track_points WHERE run_id=? ORDER BY time",
            (run_id,)
        ).fetchall()
        return [{'t': r['time'], 'lat': r['lat'], 'lon': r['lon'], 'alt': r['alt'], 'speed': r['speed']} for r in rows]
    finally:
        conn.close()


def fetch_events_by_type(db_path, run_id, event_type=None, limit=5000):
    rows = fetch_events(db_path, run_id, event_name=None, limit=limit)
    if not event_type:
        return [{'t': r['time'], 'kind': r['event_name'], 'details': r.get('params') or []} for r in rows]
    low = str(event_type).lower()
    filtered = []
    for r in rows:
        name = str(r.get('event_name') or '')
        if low in name.lower():
            filtered.append({'t': r['time'], 'kind': name, 'details': r.get('params') or []})
    return filtered


def fetch_run_catalog(db_path, run_id):
    conn = connect_db(db_path)
    conn.row_factory = sqlite3.Row
    try:
        ensure_schema(conn)
        cur = conn.cursor()
        metric_rows = cur.execute(
            "SELECT metric_id,name,dtype,lookup,value_kind,path_json,tags_json,stats_json FROM run_metrics WHERE run_id=? ORDER BY name",
            (run_id,)
        ).fetchall()
        if metric_rows:
            metrics_flat = []
            for r in metric_rows:
                try:
                    path_segments = json.loads(r['path_json'] or '[]')
                except Exception:
                    path_segments = str(r['name'] or '').split('.')
                try:
                    tags = json.loads(r['tags_json'] or '[]')
                except Exception:
                    tags = []
                try:
                    stats = json.loads(r['stats_json'] or '{}')
                except Exception:
                    stats = {}
                metrics_flat.append({
                    'metric_id': r['metric_id'],
                    'name': r['name'],
                    'dtype': r['dtype'],
                    'lookup': r['lookup'],
                    'value_kind': r['value_kind'],
                    'path_segments': path_segments,
                    'tags': tags,
                    'stats': stats
                })
        else:
            # Backward compatibility for runs imported before catalog persistence
            sample_rows = cur.execute(
                "SELECT time,metric_id,name,value_num,value_str,dtype,lookup FROM kpi_samples WHERE run_id=? ORDER BY id",
                (run_id,)
            ).fetchall()
            kpis = [dict(r) for r in sample_rows]
            metrics_flat = build_metric_catalog(kpis)

        event_rows = cur.execute(
            "SELECT event_name,metric_id,count,first_seen,last_seen,param_ids_json FROM run_events_catalog WHERE run_id=? ORDER BY event_name",
            (run_id,)
        ).fetchall()
        if event_rows:
            events_catalog = []
            for r in event_rows:
                try:
                    param_ids = json.loads(r['param_ids_json'] or '[]')
                except Exception:
                    param_ids = []
                events_catalog.append({
                    'event_name': r['event_name'],
                    'metric_id': r['metric_id'],
                    'count': r['count'],
                    'first_seen_time': r['first_seen'],
                    'last_seen_time': r['last_seen'],
                    'param_ids': param_ids
                })
        else:
            raw_events = fetch_events(db_path, run_id, event_name=None, limit=200000)
            events_catalog = build_event_catalog(raw_events)

        return {
            'metricsTree': build_metrics_tree(metrics_flat),
            'metricsFlat': metrics_flat,
            'events': events_catalog,
            'eventsGrouped': build_events_grouped(events_catalog),
            'defaults': pick_default_metrics(metrics_flat)
        }
    finally:
        conn.close()


def fetch_run_sidebar(db_path, run_id):
    conn = connect_db(db_path)
    conn.row_factory = sqlite3.Row
    try:
        ensure_schema(conn)
        cur = conn.cursor()
        rows = cur.execute(
            "SELECT kpi_type, chosen_name, sample_count, avg, min, max, first_time, last_time FROM kpi_summary WHERE run_id=? ORDER BY id",
            (run_id,)
        ).fetchall()
        kpis = []
        for r in rows:
            sample_count = int(r['sample_count'] or 0)
            if sample_count <= 0 or not r['chosen_name']:
                continue
            kpis.append({
                'kpi_type': r['kpi_type'],
                'name': r['chosen_name'],
                'sample_count': sample_count,
                'avg': r['avg'],
                'min': r['min'],
                'max': r['max'],
                'first_time': r['first_time'],
                'last_time': r['last_time']
            })
                # include info fields from run metadata_json for sidebar display
        run_row = cur.execute("SELECT metadata_json FROM runs WHERE id=?", (run_id,)).fetchone()
        info_values = {}
        if run_row and run_row['metadata_json']:
            try:
                meta = json.loads(run_row['metadata_json'])
                info_values = (meta.get('trp_info') or {}).get('values') or {}
            except Exception:
                info_values = {}
        return {'kpis': kpis, 'info': info_values}
    finally:
        conn.close()


def _tp_percentile(vals, p):
    arr = sorted([float(v) for v in (vals or []) if v is not None])
    if not arr:
        return None
    idx = int(max(0, min(len(arr) - 1, (p / 100.0) * (len(arr) - 1))))
    return arr[idx]


def _normalize_tp_series(series):
    pts = []
    for r in (series or []):
        try:
            v = float(r.get('value_num'))
        except Exception:
            continue
        t = r.get('time')
        if t is None:
            continue
        pts.append({'x': t, 'y': v})
    vals = sorted([p['y'] for p in pts if p['y'] > 0])
    median = vals[len(vals) // 2] if vals else 0.0
    div = 1.0
    unit = 'Mbps (raw)'
    if median >= 1_000_000:
        div = 1_000_000.0
        unit = 'Mbps'
    elif median >= 1_000:
        div = 1_000.0
        unit = 'Mbps'
    out = [{'x': p['x'], 'y': (p['y'] / div)} for p in pts]
    return out, {'divisor': div, 'unit': unit}


def _summarize_tp(points_mbps, low_threshold_mbps=5.0):
    vals = [float(p.get('y')) for p in (points_mbps or []) if p.get('y') is not None]
    if not vals:
        return {
            'avg': None, 'median': None, 'p10': None, 'p90': None, 'peak': None, 'pct_below_5': None
        }
    below = len([v for v in vals if v < float(low_threshold_mbps)])
    return {
        'avg': sum(vals) / len(vals),
        'median': _tp_percentile(vals, 50),
        'p10': _tp_percentile(vals, 10),
        'p90': _tp_percentile(vals, 90),
        'peak': max(vals),
        'pct_below_5': (below / len(vals)) * 100.0
    }


def _discover_tp_signals(metrics_flat):
    rows = []
    for m in (metrics_flat or []):
        rows.append({
            'name': str((m or {}).get('name') or ''),
            'metric_id': (m or {}).get('metric_id')
        })
    rows = [r for r in rows if r['name']]

    defs = {
        'dl_radio': [
            ('exact', 'radio.lte.servingcelltotal.pdsch.throughput'),
            ('contains', 'pdsch.throughput'),
            ('regex', r'radio\..*downlink.*throughput')
        ],
        'ul_radio': [
            ('exact', 'radio.lte.servingcelltotal.pusch.throughput'),
            ('contains', 'pusch.throughput'),
            ('regex', r'radio\..*uplink.*throughput')
        ],
        'dl_app': [
            ('exact', 'data.http.download.throughput'),
            ('contains', 'http.download.throughput'),
            ('regex', r'(data\.)?(http|ftp|iperf).*?(download|downlink|dl).*?(throughput|bitrate|thp)')
        ],
        'ul_app': [
            ('exact', 'data.http.upload.throughput'),
            ('contains', 'http.upload.throughput'),
            ('regex', r'(data\.)?(http|ftp|iperf).*?(upload|uplink|ul).*?(throughput|bitrate|thp)')
        ]
    }

    def score(name, rules):
        low = str(name or '').lower()
        best = (-1, 'regex')
        for typ, val in rules:
            if typ == 'exact' and low == val:
                best = max(best, (100, 'exact'), key=lambda x: x[0])
            elif typ == 'contains' and val in low:
                best = max(best, (70, 'regex'), key=lambda x: x[0])
            elif typ == 'regex' and re.search(val, low, flags=re.IGNORECASE):
                best = max(best, (60, 'regex'), key=lambda x: x[0])
        return best

    out = {}
    for key, rules in defs.items():
        best = None
        for r in rows:
            sc, src = score(r['name'], rules)
            if sc < 0:
                continue
            if best is None or sc > best['score']:
                best = {
                    'key': key,
                    'name': r['name'],
                    'id': r['metric_id'],
                    'score': sc,
                    'source': src,
                    'confidence': round(sc / 100.0, 2)
                }
        out[key] = best
    return out


def fetch_throughput_summary(db_path, run_id, low_threshold_mbps=5.0, dip_min_seconds=3.0):
    catalog = fetch_run_catalog(db_path, run_id)
    discovered = _discover_tp_signals((catalog or {}).get('metricsFlat') or [])

    used = []
    series = {}
    for key in ('dl_radio', 'ul_radio', 'dl_app', 'ul_app'):
        sig = discovered.get(key)
        if not sig or not sig.get('name'):
            continue
        used.append({
            'name': sig.get('name'),
            'id': sig.get('id'),
            'source': sig.get('source'),
            'confidence': sig.get('confidence')
        })
        raw = fetch_kpi_series(db_path, run_id, sig['name'])
        norm, norm_meta = _normalize_tp_series(raw)
        series[key] = {'points': norm, 'norm': norm_meta}

    dl_radio_points = (series.get('dl_radio') or {}).get('points') or []
    ul_radio_points = (series.get('ul_radio') or {}).get('points') or []
    dl_app_points = (series.get('dl_app') or {}).get('points') or []
    ul_app_points = (series.get('ul_app') or {}).get('points') or []

    dl_summary = _summarize_tp(dl_radio_points, low_threshold_mbps)
    ul_summary = _summarize_tp(ul_radio_points, low_threshold_mbps)

    # Dips on DL radio throughput.
    dips = []
    dl_vals = [p.get('y') for p in dl_radio_points if p.get('y') is not None]
    p10 = _tp_percentile(dl_vals, 10)
    dip_thr = p10 if p10 is not None else float(low_threshold_mbps)
    start_idx = -1
    min_v = None
    for i, p in enumerate(dl_radio_points):
        v = p.get('y')
        is_dip = (v is not None and v < dip_thr)
        if is_dip and start_idx < 0:
            start_idx = i
            min_v = v
        elif is_dip:
            min_v = v if min_v is None else min(min_v, v)
        if start_idx >= 0 and ((not is_dip) or i == len(dl_radio_points) - 1):
            end_i = i if (is_dip and i == len(dl_radio_points) - 1) else i - 1
            t0 = parse_iso(dl_radio_points[start_idx].get('x'))
            t1 = parse_iso(dl_radio_points[end_i].get('x'))
            dur = (t1 - t0).total_seconds() if (t0 and t1) else 0.0
            if dur >= float(dip_min_seconds):
                dips.append({
                    'start': dl_radio_points[start_idx].get('x'),
                    'end': dl_radio_points[end_i].get('x'),
                    'min': min_v,
                    'duration_sec': dur
                })
            start_idx = -1
            min_v = None

    # Radio vs App mismatch (DL)
    ratio_rows = []
    app_by_sec = {}
    for p in dl_app_points:
        t = parse_iso(p.get('x'))
        if not t:
            continue
        app_by_sec[int(t.timestamp())] = p.get('y')
    for p in dl_radio_points:
        t = parse_iso(p.get('x'))
        v = p.get('y')
        if not t or v is None or v <= 0:
            continue
        sec = int(t.timestamp())
        if sec not in app_by_sec:
            continue
        appv = app_by_sec.get(sec)
        if appv is None:
            continue
        ratio_rows.append(float(appv) / float(v))
    ratio_med = _tp_percentile(ratio_rows, 50)
    app_lt_70 = (len([r for r in ratio_rows if r < 0.7]) / len(ratio_rows) * 100.0) if ratio_rows else None
    mismatch_flag = 'mixed'
    if ratio_med is not None and app_lt_70 is not None:
        if ratio_med < 0.7 and app_lt_70 > 40:
            mismatch_flag = 'app-limited'
        elif ratio_med >= 0.9:
            mismatch_flag = 'radio-limited'

    events = fetch_events(db_path, run_id, event_name=None, limit=5000)
    interesting_events = []
    ev_re = re.compile(r'(rrc|idle|connected|handover|\bho\b|rlf|re-?establish|cell|pci|earfcn)', re.IGNORECASE)
    for ev in (events or []):
        en = str((ev or {}).get('event_name') or '')
        if ev_re.search(en):
            interesting_events.append({'time': ev.get('time'), 'event_name': en})

    return {
        'window': {
            'start': dl_radio_points[0]['x'] if dl_radio_points else None,
            'end': dl_radio_points[-1]['x'] if dl_radio_points else None
        },
        'dl': dl_summary,
        'ul': ul_summary,
        'mismatch': {
            'ratio_median': ratio_med,
            'app_lt_70_ratio_pct': app_lt_70,
            'flag': mismatch_flag
        },
        'dips': dips,
        'signals_used': used,
        'signals_found': discovered,
        'series': {
            'dl_radio': dl_radio_points,
            'ul_radio': ul_radio_points,
            'dl_app': dl_app_points,
            'ul_app': ul_app_points
        },
        'normalization': {
            'dl_radio': (series.get('dl_radio') or {}).get('norm'),
            'ul_radio': (series.get('ul_radio') or {}).get('norm'),
            'dl_app': (series.get('dl_app') or {}).get('norm'),
            'ul_app': (series.get('ul_app') or {}).get('norm')
        },
        'events': interesting_events
    }


def list_runs(db_path, limit=200):
    conn = connect_db(db_path)
    conn.row_factory = sqlite3.Row
    try:
        ensure_schema(conn)
        cur = conn.cursor()
        rows = cur.execute(
            "SELECT id, filename, imported_at, start_time, end_time, metadata_json FROM runs ORDER BY id DESC LIMIT ?",
            (int(limit),)
        ).fetchall()
        out = []
        for r in rows:
            metadata = {}
            try:
                metadata = json.loads(r['metadata_json'] or '{}')
            except Exception:
                metadata = {}
            out.append({
                'id': r['id'],
                'filename': r['filename'],
                'imported_at': r['imported_at'],
                'start_time': r['start_time'],
                'end_time': r['end_time'],
                'metadata': metadata
            })
        return out
    finally:
        conn.close()

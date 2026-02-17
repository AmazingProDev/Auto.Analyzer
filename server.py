import csv
import json
import os
import shutil
import tempfile
import http.server
import socketserver
from datetime import datetime, timezone
from urllib.parse import urlparse, parse_qs
from db_client import connect_db, db_backend_name

from trp_importer import (
    import_trp_file,
    fetch_run_detail,
    fetch_kpi_series,
    fetch_events,
    fetch_run_signals,
    fetch_timeseries_by_signal,
    fetch_run_track,
    fetch_events_by_type,
    fetch_run_catalog,
    fetch_run_sidebar,
    fetch_throughput_summary,
    list_runs,
    ensure_schema
)

PORT = 8000
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
IS_VERCEL = bool((os.getenv('VERCEL') or '').strip())
DEFAULT_DATA_DIR = '/tmp/optim_analyzer_data' if IS_VERCEL else os.path.join(BASE_DIR, 'data')
DATA_DIR = os.getenv('OPTIM_DATA_DIR') or DEFAULT_DATA_DIR
UPLOAD_DIR = os.path.join(DATA_DIR, 'uploads')
DEFAULT_DB_PATH = '/tmp/trp_runs.db' if IS_VERCEL else os.path.join(DATA_DIR, 'trp_runs.db')
DB_PATH = os.getenv('TRP_DB_PATH') or DEFAULT_DB_PATH
MAX_UPLOAD_BYTES = 300 * 1024 * 1024

os.makedirs(DATA_DIR, exist_ok=True)
os.makedirs(UPLOAD_DIR, exist_ok=True)
conn = connect_db(DB_PATH)
ensure_schema(conn)
conn.close()


def json_response(handler, status, payload):
    body = json.dumps(payload).encode('utf-8')
    handler.send_response(status)
    handler.send_header('Content-Type', 'application/json')
    handler.send_header('Content-Length', str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def parse_multipart_file(content_type, body_bytes):
    if not content_type or 'multipart/form-data' not in content_type:
        raise ValueError('Expected multipart/form-data')
    boundary_key = 'boundary='
    idx = content_type.find(boundary_key)
    if idx < 0:
        raise ValueError('Missing multipart boundary')
    boundary = content_type[idx + len(boundary_key):].strip().strip('\"')
    if not boundary:
        raise ValueError('Empty multipart boundary')
    marker = ('--' + boundary).encode('utf-8')
    parts = body_bytes.split(marker)
    for part in parts:
        part = part.strip()
        if not part or part == b'--':
            continue
        if b'\r\n\r\n' not in part:
            continue
        header_blob, data = part.split(b'\r\n\r\n', 1)
        headers = header_blob.decode('utf-8', errors='ignore').split('\r\n')
        disp = next((h for h in headers if h.lower().startswith('content-disposition:')), '')
        if 'name=\"file\"' not in disp:
            continue
        filename = ''
        fidx = disp.find('filename=\"')
        if fidx >= 0:
            rest = disp[fidx + len('filename=\"'):]
            filename = rest.split('\"', 1)[0]
        if data.endswith(b'\r\n'):
            data = data[:-2]
        return filename, data
    raise ValueError('Missing file part')


class CustomHandler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path == '/runs' or path.startswith('/runs/'):
            self.path = '/index.html'
            return super().do_GET()

        if path == '/api/runs':
            query = parse_qs(parsed.query)
            try:
                limit = int((query.get('limit') or ['200'])[0])
            except Exception:
                limit = 200
            limit = max(1, min(2000, limit))
            rows = list_runs(DB_PATH, limit=limit)
            return json_response(self, 200, {'status': 'success', 'runs': rows})

        if path.startswith('/api/runs/'):
            parts = [p for p in path.split('/') if p]
            if len(parts) >= 3 and parts[0] == 'api' and parts[1] == 'runs':
                try:
                    run_id = int(parts[2])
                except Exception:
                    return json_response(self, 400, {'status': 'error', 'message': 'Invalid run id'})

                if len(parts) == 4 and parts[3] == 'kpi':
                    query = parse_qs(parsed.query)
                    name = (query.get('name') or [''])[0]
                    if not name:
                        return json_response(self, 400, {'status': 'error', 'message': 'Missing KPI name'})
                    series = fetch_kpi_series(DB_PATH, run_id, name)
                    return json_response(self, 200, {'status': 'success', 'runId': run_id, 'name': name, 'series': series})

                if len(parts) == 4 and parts[3] == 'signals':
                    signals = fetch_run_signals(DB_PATH, run_id)
                    return json_response(self, 200, {'status': 'success', 'runId': run_id, 'signals': signals})

                if len(parts) == 4 and parts[3] == 'timeseries':
                    query = parse_qs(parsed.query)
                    signal = (query.get('signal') or [''])[0]
                    if not signal:
                        return json_response(self, 400, {'status': 'error', 'message': 'Missing signal parameter'})
                    rows = fetch_timeseries_by_signal(DB_PATH, run_id, signal)
                    return json_response(self, 200, {'status': 'success', 'runId': run_id, 'signal': signal, 'series': rows})

                if len(parts) == 4 and parts[3] == 'track':
                    track = fetch_run_track(DB_PATH, run_id)
                    return json_response(self, 200, {'status': 'success', 'runId': run_id, 'track': track})

                if len(parts) == 4 and parts[3] == 'events':
                    query = parse_qs(parsed.query)
                    event_type = (query.get('type') or [''])[0] or None
                    if event_type is not None:
                        try:
                            limit = int((query.get('limit') or ['5000'])[0])
                        except Exception:
                            limit = 5000
                        limit = max(1, min(100000, limit))
                        rows = fetch_events_by_type(DB_PATH, run_id, event_type=event_type, limit=limit)
                        return json_response(self, 200, {'status': 'success', 'runId': run_id, 'type': event_type, 'events': rows})
                    name = (query.get('name') or [''])[0] or None
                    try:
                        limit = int((query.get('limit') or ['5000'])[0])
                    except Exception:
                        limit = 5000
                    limit = max(1, min(100000, limit))
                    rows = fetch_events(DB_PATH, run_id, event_name=name, limit=limit)
                    return json_response(self, 200, {'status': 'success', 'runId': run_id, 'eventName': name, 'events': rows})

                if len(parts) == 4 and parts[3] == 'catalog':
                    cat = fetch_run_catalog(DB_PATH, run_id)
                    return json_response(self, 200, {'status': 'success', 'runId': run_id, **cat})
                if len(parts) == 4 and parts[3] == 'sidebar':
                    sidebar = fetch_run_sidebar(DB_PATH, run_id)
                    return json_response(self, 200, {'status': 'success', 'runId': run_id, **sidebar})
                if len(parts) == 4 and parts[3] == 'throughput-summary':
                    query = parse_qs(parsed.query)
                    try:
                        low_thr = float((query.get('low_thr_mbps') or ['5'])[0])
                    except Exception:
                        low_thr = 5.0
                    try:
                        dip_min = float((query.get('dip_min_seconds') or ['3'])[0])
                    except Exception:
                        dip_min = 3.0
                    summary = fetch_throughput_summary(DB_PATH, run_id, low_threshold_mbps=low_thr, dip_min_seconds=dip_min)
                    return json_response(self, 200, {'status': 'success', 'runId': run_id, **summary})

                detail = fetch_run_detail(DB_PATH, run_id)
                if not detail:
                    return json_response(self, 404, {'status': 'error', 'message': 'Run not found'})
                return json_response(self, 200, {'status': 'success', **detail})

        return super().do_GET()

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path == '/save_sites':
            return self._handle_save_sites()

        if path == '/api/trp/import':
            return self._handle_trp_import()

        self.send_error(404)

    def _handle_save_sites(self):
        content_length = int(self.headers.get('Content-Length', 0))
        post_data = self.rfile.read(content_length)

        try:
            data = json.loads(post_data.decode('utf-8'))
            if not isinstance(data, list):
                raise ValueError('Expected a list of site objects')

            output_file = 'sites_updated.csv'
            desired_headers = [
                'eNodeB ID-Cell ID', 'eNodeB ID', 'Site Name', 'Cell Name', 'Cell ID',
                'Physical cell ID', 'Downlink EARFCN', 'Uplink EARFCN',
                'Tracking area code', 'Latitude', 'Longitude', 'Azimut'
            ]

            mapped_data = []
            for item in data:
                raw_id = item.get('rawEnodebCellId') or item.get('eNodeB ID-Cell ID') or item.get('enodeb id-cell id') or ''
                enb_id = item.get('eNodeB ID')
                if not enb_id and raw_id and '-' in str(raw_id):
                    enb_id = str(raw_id).split('-')[0]
                if not enb_id:
                    enb_id = ''

                mapped_data.append({
                    'eNodeB ID-Cell ID': raw_id,
                    'eNodeB ID': enb_id,
                    'Site Name': item.get('siteName', item.get('Site Name', '')),
                    'Cell Name': item.get('cellName', item.get('Cell Name', '')),
                    'Cell ID': item.get('cellId', item.get('Cell ID', '')),
                    'Physical cell ID': item.get('pci', item.get('Physical cell ID', '')),
                    'Downlink EARFCN': item.get('freq', item.get('Downlink EARFCN', '')),
                    'Uplink EARFCN': item.get('Uplink EARFCN', ''),
                    'Tracking area code': item.get('Tracking area code', ''),
                    'Latitude': item.get('lat', item.get('Latitude', '')),
                    'Longitude': item.get('lng', item.get('Longitude', '')),
                    'Azimut': item.get('azimuth', item.get('Azimut', ''))
                })

            with open(output_file, 'w', newline='', encoding='utf-8') as csvfile:
                writer = csv.DictWriter(csvfile, fieldnames=desired_headers, extrasaction='ignore')
                writer.writeheader()
                writer.writerows(mapped_data)

            return json_response(self, 200, {'status': 'success', 'message': f'Saved to {output_file}'})
        except Exception as e:
            return json_response(self, 500, {'status': 'error', 'message': str(e)})

    def _handle_trp_import(self):
        content_length = int(self.headers.get('Content-Length', '0') or 0)
        if content_length > MAX_UPLOAD_BYTES:
            return json_response(self, 413, {
                'status': 'error',
                'message': f'File too large. Max allowed is {MAX_UPLOAD_BYTES // (1024 * 1024)} MB.'
            })

        try:
            content_type = self.headers.get('Content-Type', '')
            body = self.rfile.read(content_length)
            filename, file_data = parse_multipart_file(content_type, body)
            filename = os.path.basename(filename or '')
            if not filename.lower().endswith('.trp'):
                return json_response(self, 400, {'status': 'error', 'message': 'Only .trp files are supported'})

            stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
            saved_name = f"{stamp}_{filename}"
            save_path = os.path.join(UPLOAD_DIR, saved_name)

            with tempfile.NamedTemporaryFile(delete=False, suffix='.trp') as temp_file:
                temp_file.write(file_data)
                tmp_path = temp_file.name

            size = os.path.getsize(tmp_path)
            if size > MAX_UPLOAD_BYTES:
                os.remove(tmp_path)
                return json_response(self, 413, {'status': 'error', 'message': 'File too large'})

            shutil.move(tmp_path, save_path)

            result = import_trp_file(save_path, DB_PATH, UPLOAD_DIR)
            import_report = result.get('importReport') or {}
            decoded_samples = int(import_report.get('decodedSamples') or 0)
            decoded_events = int(import_report.get('decodedEvents') or 0)
            if decoded_samples == 0 and decoded_events == 0:
                return json_response(self, 422, {
                    'status': 'error',
                    'message': 'TRP decoded with zero samples/events. Check importReport for details.',
                    'runId': result.get('runId'),
                    'metricsCount': result.get('metricsCount', 0),
                    'eventTypesCount': result.get('eventTypesCount', 0),
                    'importReport': import_report
                })
            return json_response(self, 200, {
                'status': 'success',
                'runId': result['runId'],
                'metricsCount': result.get('metricsCount', 0),
                'eventTypesCount': result.get('eventTypesCount', 0),
                'chosen': result.get('chosen') or {},
                'stats': result.get('stats') or {},
                'missingData': result.get('missingData') or [],
                'debug': result.get('debug') or {},
                'importReport': import_report,
                'stages': result.get('stages', []),
                'summary': result.get('summary', {})
            })
        except Exception as e:
            return json_response(self, 500, {'status': 'error', 'message': f'TRP import failed: {e}'})


def run_server(port=PORT):
    print(f'Starting server on port {port}...')
    print(f'DB backend: {db_backend_name()} ({DB_PATH})')
    print('Use Ctrl+C to stop.')
    with socketserver.TCPServer(('', port), CustomHandler) as httpd:
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print('\nStopping server.')
            httpd.server_close()


if __name__ == '__main__':
    run_server()

import io
import json
import os
import shutil
import socketserver
import tempfile
import threading
import unittest
import urllib.request
import urllib.error
import zipfile
import zlib

import server
from trp_importer import (
    safe_extract_zip,
    decompress_cdf_payload,
    ensure_schema,
    build_metric_catalog,
    build_event_catalog,
    build_kpi_type_summary
)


def make_cdf_payload(raw: bytes) -> bytes:
    return (b'\x00' * 8) + zlib.compress(raw)


def build_minimal_trp(path):
    with zipfile.ZipFile(path, 'w', compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr('trp/providers/sp1/cdf/declarations.cdf', make_cdf_payload(b''))
        zf.writestr('trp/providers/sp1/cdf/lookuptables.cdf', make_cdf_payload(b''))
        zf.writestr('trp/providers/sp1/cdf/data.cdf', make_cdf_payload(b''))
        zf.writestr(
            'trp/positions/wptrack.xml',
            '<gpx><trk><trkseg><trkpt lat="30.1" lon="-9.1"><time>2025-12-23T23:00:00Z</time></trkpt></trkseg></trk></gpx>'
        )


class TrpImporterTests(unittest.TestCase):
    def test_zip_slip_prevention(self):
        with tempfile.TemporaryDirectory() as td:
            zpath = os.path.join(td, 'evil.zip')
            with zipfile.ZipFile(zpath, 'w') as zf:
                zf.writestr('../evil.txt', 'boom')
            with self.assertRaises(ValueError):
                safe_extract_zip(zpath, os.path.join(td, 'out'))

    def test_decompression_function(self):
        original = b'hello-cdf-payload'
        compressed = make_cdf_payload(original)
        result = decompress_cdf_payload(compressed)
        self.assertEqual(result, original)

    def test_catalog_generation_unique_metrics_and_events(self):
        kpis = [
            {'time': '2025-01-01T00:00:00Z', 'metric_id': 100, 'name': 'Radio.Lte.Serving.RSRP', 'value_num': -95.0, 'value_str': None, 'dtype': 'float', 'lookup': None},
            {'time': '2025-01-01T00:00:01Z', 'metric_id': 100, 'name': 'Radio.Lte.Serving.RSRP', 'value_num': -90.0, 'value_str': None, 'dtype': 'float', 'lookup': None},
            {'time': '2025-01-01T00:00:00Z', 'metric_id': 200, 'name': 'VoLTE.Call.State', 'value_num': None, 'value_str': 'Connected', 'dtype': 'string', 'lookup': None}
        ]
        events = [
            {'time': '2025-01-01T00:00:05Z', 'event_name': 'Call.Setup', 'metric_id': 501, 'params': [{'param_id': 7, 'param_value': 2, 'param_type': 'int'}]},
            {'time': '2025-01-01T00:00:06Z', 'event_name': 'Call.Setup', 'metric_id': 501, 'params': [{'param_id': 8, 'param_value': 9, 'param_type': 'int'}]},
            {'time': '2025-01-01T00:00:09Z', 'event_name': 'IMS.Reg', 'metric_id': 502, 'params': []}
        ]

        mcat = build_metric_catalog(kpis)
        ecat = build_event_catalog(events)
        self.assertEqual(len(mcat), 2)
        self.assertEqual(len(ecat), 2)
        rsrp = next(x for x in mcat if x['name'] == 'Radio.Lte.Serving.RSRP')
        self.assertEqual(rsrp['stats']['sample_count'], 2)
        self.assertAlmostEqual(rsrp['stats']['min'], -95.0)
        self.assertAlmostEqual(rsrp['stats']['max'], -90.0)
        csetup = next(x for x in ecat if x['event_name'] == 'Call.Setup')
        self.assertEqual(csetup['count'], 2)
        self.assertIn('7', csetup['param_ids'])
        self.assertIn('8', csetup['param_ids'])

    def test_kpi_selection_scoring_and_stats(self):
        kpis = [
            {'time': '2025-01-01T00:00:00Z', 'metric_id': 1, 'name': 'Radio.Lte.ServingCell[0].Rsrp', 'value_num': -95.0},
            {'time': '2025-01-01T00:00:01Z', 'metric_id': 1, 'name': 'Radio.Lte.ServingCell[0].Rsrp', 'value_num': -90.0},
            {'time': '2025-01-01T00:00:00Z', 'metric_id': 2, 'name': 'Radio.Lte.ServingCell[0].Rsrq', 'value_num': -12.0},
            {'time': '2025-01-01T00:00:00Z', 'metric_id': 3, 'name': 'Radio.Lte.ServingCell[0].RsSinr', 'value_num': 12.5},
            {'time': '2025-01-01T00:00:00Z', 'metric_id': 4, 'name': 'Pocket.Data.Downlink.Throughput', 'value_num': 20.0},
            {'time': '2025-01-01T00:00:01Z', 'metric_id': 5, 'name': 'Pocket.Data.Uplink.Throughput', 'value_num': 4.0}
        ]
        summary = build_kpi_type_summary(kpis, metric_map={})
        self.assertEqual(summary['chosen']['rsrp'], 'Radio.Lte.ServingCell[0].Rsrp')
        self.assertEqual(summary['stats']['rsrp']['sample_count'], 2)
        self.assertAlmostEqual(summary['stats']['rsrp']['avg'], -92.5)
        self.assertEqual(summary['chosen']['dl_tp'], 'Pocket.Data.Downlink.Throughput')
        self.assertEqual(summary['chosen']['ul_tp'], 'Pocket.Data.Uplink.Throughput')

    def test_upload_integration_returns_run_id(self):
        with tempfile.TemporaryDirectory() as td:
            db_path = os.path.join(td, 'runs.db')
            upload_dir = os.path.join(td, 'uploads')
            os.makedirs(upload_dir, exist_ok=True)

            # patch server globals for isolated test storage
            server.DB_PATH = db_path
            server.UPLOAD_DIR = upload_dir
            conn = __import__('sqlite3').connect(db_path)
            ensure_schema(conn)
            conn.close()

            trp_path = os.path.join(td, 'sample.trp')
            build_minimal_trp(trp_path)

            httpd = socketserver.TCPServer(('127.0.0.1', 0), server.CustomHandler)
            port = httpd.server_address[1]
            t = threading.Thread(target=httpd.serve_forever, daemon=True)
            t.start()
            try:
                with open(trp_path, 'rb') as f:
                    file_bytes = f.read()
                boundary = '----WebKitFormBoundary7MA4YWxkTrZu0gW'
                body = io.BytesIO()
                body.write((f'--{boundary}\r\n').encode())
                body.write(b'Content-Disposition: form-data; name="file"; filename="sample.trp"\r\n')
                body.write(b'Content-Type: application/octet-stream\r\n\r\n')
                body.write(file_bytes)
                body.write(b'\r\n')
                body.write((f'--{boundary}--\r\n').encode())
                payload = body.getvalue()

                req = urllib.request.Request(
                    f'http://127.0.0.1:{port}/api/trp/import',
                    data=payload,
                    headers={'Content-Type': f'multipart/form-data; boundary={boundary}'},
                    method='POST'
                )
                try:
                    with urllib.request.urlopen(req, timeout=30) as resp:
                        data = json.loads(resp.read().decode('utf-8'))
                    status_code = 200
                except urllib.error.HTTPError as he:
                    status_code = he.code
                    data = json.loads(he.read().decode('utf-8'))

                self.assertIn(status_code, (200, 422))
                self.assertIsInstance(data.get('runId'), int)
                self.assertGreater(data.get('runId'), 0)
                self.assertIn('metricsCount', data)
                self.assertIn('eventTypesCount', data)
                if status_code == 422:
                    self.assertIn('importReport', data)

                run_id = data['runId']
                with urllib.request.urlopen(f'http://127.0.0.1:{port}/api/runs/{run_id}/catalog', timeout=30) as resp:
                    cat = json.loads(resp.read().decode('utf-8'))
                self.assertEqual(cat.get('status'), 'success')
                self.assertIn('metricsTree', cat)
                self.assertIn('metricsFlat', cat)
                self.assertIn('events', cat)

                with urllib.request.urlopen(f'http://127.0.0.1:{port}/api/runs/{run_id}/sidebar', timeout=30) as resp:
                    sidebar = json.loads(resp.read().decode('utf-8'))
                self.assertEqual(sidebar.get('status'), 'success')
                self.assertIn('kpis', sidebar)
            finally:
                httpd.shutdown()
                httpd.server_close()


if __name__ == '__main__':
    unittest.main()

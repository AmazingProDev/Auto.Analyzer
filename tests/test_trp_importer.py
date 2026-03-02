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
    build_kpi_type_summary,
    _extract_sidebar_info,
    build_l1l2_scheduler_index,
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
    def test_l1l2_scheduler_index_flags_non_per_tti_when_sampling_is_slow(self):
        kpis = [
            {"time": "2025-12-04T11:00:00.000Z", "name": "Radio.Lte.ServingCell[8].Pdsch.NumberOfResourceBlocks", "value_num": 8},
            {"time": "2025-12-04T11:00:01.000Z", "name": "Radio.Lte.ServingCell[8].Pdsch.NumberOfResourceBlocks", "value_num": 10},
            {"time": "2025-12-04T11:00:02.000Z", "name": "Radio.Lte.ServingCell[8].Pdsch.NumberOfResourceBlocks", "value_num": 7},
            {"time": "2025-12-04T11:00:00.000Z", "name": "Radio.Lte.ServingCell[8].Pdsch.Throughput", "value_num": 10240},
        ]
        idx = build_l1l2_scheduler_index(kpis, [])
        fields = idx.get("fields") or {}
        rb = fields.get("allocated_rb_dl") or {}
        stats = rb.get("stats") or {}
        self.assertEqual(stats.get("sampleCount"), 3)
        self.assertFalse(bool(stats.get("perTtiExact")))
        self.assertEqual((stats.get("intervalMs") or {}).get("p50"), 1000.0)
        limitations = (idx.get("availability") or {}).get("limitations") or []
        self.assertTrue(any("~1 ms cadence" in str(x) for x in limitations))
        self.assertTrue(any("Layer1/Layer2 raw message payload" in str(x) for x in limitations))

    def test_l1l2_scheduler_index_detects_payload_event_presence(self):
        events = [
            {"event_name": "Message.Layer2.LteMac.UlGrant"},
            {"event_name": "Message.Layer3.Errc.DcchUl.MeasurementReport"},
        ]
        idx = build_l1l2_scheduler_index([], events)
        avail = idx.get("availability") or {}
        self.assertTrue(bool(avail.get("rawPayloadEventsDetected")))
        self.assertTrue(bool(avail.get("perDecodeSupported")))
        self.assertIn("Message.Layer2.LteMac.UlGrant", avail.get("matchingPayloadEvents") or [])

    def test_extract_sidebar_info_prefers_decoded_ue_capability_summary(self):
        events = [
            {
                "time": "2025-12-04T11:35:57.100Z",
                "event_name": "Message.Layer3.Errc.DcchUl.UeCapabilityInformation",
                "params_map": {
                    "ue_cap_info_summary": json.dumps({
                        "ueCategory": 6,
                        "ueCategoryLabel": "Cat 6",
                        "mimoCapability": "2x2 capable (decoded UE capability)",
                        "caCapability": "CA capable (MaxNumCarriers=3)"
                    })
                },
            }
        ]
        info = _extract_sidebar_info([], events)
        self.assertEqual(info.get("ue_category"), "Cat 6")
        self.assertEqual(info.get("mimo_capability"), "2x2 capable (decoded UE capability)")
        self.assertEqual(info.get("ca_capability"), "CA capable (MaxNumCarriers=3)")
        self.assertEqual(info.get("ue_capability_source"), "decoded_ue_capability_information")

    def test_extract_sidebar_info_builds_ca_capability_from_band_combos(self):
        events = [
            {
                "time": "2025-12-04T11:35:58.100Z",
                "event_name": "Message.Layer3.Errc.DcchUl.UeCapabilityInformation",
                "params_map": {
                    "ue_cap_info_summary": json.dumps({
                        "ueCategory": 6,
                        "ueCategoryLabel": "Cat 6",
                        "mimoCapability": "2x2 capable (decoded UE capability)",
                        "maxNumCarriers": 10
                    }),
                    "ue_cap_info_full_json": json.dumps({
                        "supportedBandCombination-r10": [
                            {"bandParameterList-r10": [{"bandEUTRA-r10": 3}, {"bandEUTRA-r10": 7}]},
                            {"bandParameterList-r10": [{"bandEUTRA-r10": 3}, {"bandEUTRA-r10": 20}]}
                        ]
                    }),
                },
            }
        ]
        info = _extract_sidebar_info([], events)
        ca = str(info.get("ca_capability") or "")
        self.assertIn("band combos:", ca)
        self.assertIn("B3+B7", ca)
        self.assertIn("B3+B20", ca)
        self.assertIn("MaxNumCarriers=10", ca)
        self.assertEqual(info.get("ca_band_combinations"), ["B3+B7", "B3+B20"])

    def test_extract_sidebar_info_infers_capabilities_from_kpis(self):
        kpis = [
            {"time": "2025-12-04T11:00:00Z", "name": "Pocket.General.Device.MaxNumCarriers", "value_num": 10},
            {"time": "2025-12-04T11:00:01Z", "name": "Radio.Lte.ServingCell[8].Rank4.FeedbackCount", "value_num": 7},
            {"time": "2025-12-04T11:00:01Z", "name": "Radio.Lte.ServingSystem.MimoEnabled", "value_num": 1},
            {"time": "2025-12-04T11:00:02Z", "name": "Radio.Lte.ServingSystem.Tac", "value_num": 8362},
        ]
        info = _extract_sidebar_info(kpis, [])
        self.assertEqual(info.get("ca_capability_inferred"), "CA capable (MaxNumCarriers=10)")
        self.assertEqual(info.get("mimo_capability_inferred"), "4x4 capable (inferred from Rank4 feedback)")
        self.assertTrue(str(info.get("ue_category_inferred") or "").startswith("Cat 6+"))
        self.assertEqual(info.get("tac"), 8362)

    def test_extract_sidebar_info_prefers_decoded_sib1_tac_when_kpi_missing(self):
        events = [
            {
                "time": "2025-12-04T11:00:01Z",
                "event_name": "Message.Layer3.Errc.BcchDlSch.SystemInformationBlockType1",
                "params_map": {
                    "rrc_message_id": "sib1",
                    "sib1_summary": json.dumps({"trackingAreaCode": "0x20AA"}),
                },
            }
        ]
        info = _extract_sidebar_info([], events)
        self.assertEqual(info.get("tac"), 8362)
        self.assertEqual(info.get("tac_source"), "decoded_sib1")

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

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
from nr_rrc_extractor import extract_nr_rrc_summary
from trp_raw_decoder import parse_declarations_cdf
from trp_importer import (
    safe_extract_zip,
    decompress_cdf_payload,
    ensure_schema,
    build_metric_catalog,
    build_event_catalog,
    build_kpi_type_summary,
    _extract_sidebar_info,
    _infer_layer3_message_name,
    _decode_layer3_rrc_payload,
    _extract_lte_rrc_summary,
    _layer3_params_patch,
    _pop_matching_common_layer3_event,
    LAYER3_FULL_DECODE_MESSAGE_NAMES,
    LAYER3_FULL_DECODE_PER_MESSAGE_LIMITS,
    build_l1l2_scheduler_index,
    analyze_pilot_pollution_at_point,
    build_neighbors_at_time,
    build_serving_at_time,
    _RUNS,
)


def make_cdf_payload(raw: bytes) -> bytes:
    return (b'\x00' * 8) + zlib.compress(raw)


def _encode_varint(n: int) -> bytes:
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out.append(b | 0x80)
        else:
            out.append(b)
            break
    return bytes(out)


def _field_varint(field_no: int, val: int) -> bytes:
    return _encode_varint((field_no << 3) | 0) + _encode_varint(val)


def _field_len(field_no: int, data: bytes) -> bytes:
    return _encode_varint((field_no << 3) | 2) + _encode_varint(len(data)) + data


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
    def test_infer_layer3_message_name_maps_known_nr_rrc_identity_codes(self):
        self.assertEqual(
            _infer_layer3_message_name({"protocol": 90, "message_identity": 0x20800, "channel": 20}),
            "RRCSetupRequest",
        )
        self.assertEqual(
            _infer_layer3_message_name({"protocol": 90, "message_identity": 0x21000, "channel": 22}),
            "RRCReject",
        )
        self.assertEqual(
            _infer_layer3_message_name({"protocol": 90, "message_identity": 0x21002, "channel": 22}),
            "RRCSetup",
        )

    def test_common_nr_rrc_messages_are_full_decode_candidates(self):
        for name in ("RRCSetupRequest", "RRCSetup", "RRCReject"):
            self.assertIn(name, LAYER3_FULL_DECODE_MESSAGE_NAMES)
            self.assertGreater(LAYER3_FULL_DECODE_PER_MESSAGE_LIMITS.get(name, 0), 0)

    def test_extract_nr_rrc_reject_summary_promotes_wait_time(self):
        decoded_json = {
            "message": {
                "c1": {
                    "rrcReject": {
                        "criticalExtensions": {
                            "rrcReject": {
                                "waitTime": 16
                            }
                        }
                    }
                }
            }
        }
        summary = extract_nr_rrc_summary(decoded_json, "RRCReject")
        self.assertEqual(summary.get("rejectWaitTime"), 16)

    def test_common_lte_reestablishment_messages_are_full_decode_candidates(self):
        for name in ("RRCConnectionReestablishmentRequest", "RRCConnectionReestablishment"):
            self.assertIn(name, LAYER3_FULL_DECODE_MESSAGE_NAMES)
            self.assertGreater(LAYER3_FULL_DECODE_PER_MESSAGE_LIMITS.get(name, 0), 0)

    def test_extract_lte_rrc_release_summary_promotes_release_cause(self):
        decoded_json = {
            "message": {
                "c1": {
                    "rrcConnectionRelease": {
                        "criticalExtensions": {
                            "c1": {
                                "rrcConnectionRelease-r8": {
                                    "releaseCause": "otherFailure"
                                }
                            }
                        }
                    }
                }
            }
        }
        summary = _extract_lte_rrc_summary(decoded_json, "RRCConnectionRelease")
        self.assertEqual(summary.get("releaseCause"), "otherFailure")

    def test_extract_lte_rrc_reestablishment_summary_promotes_cause(self):
        decoded_json = {
            "message": {
                "c1": {
                    "rrcConnectionReestablishmentRequest": {
                        "criticalExtensions": {
                            "rrcConnectionReestablishmentRequest-r8": {
                                "reestablishmentCause": "reconfigurationFailure"
                            }
                        }
                    }
                }
            }
        }
        summary = _extract_lte_rrc_summary(decoded_json, "RRCConnectionReestablishmentRequest")
        self.assertEqual(summary.get("reestablishmentCause"), "reconfigurationFailure")

    def test_layer3_params_patch_exposes_rrc_release_cause(self):
        params = _layer3_params_patch(
            {
                "message_identity": 0x720A,
                "protocol": 26,
                "channel_type": 22,
                "direction_code": 2,
                "payload_bytes": b"\x01\x02",
            },
            "RRCConnectionRelease",
            {"ok": True, "summary": {"releaseCause": "loadBalancingTAUrequired"}},
        )
        self.assertEqual(params.get("rrc_rel_cause"), "loadBalancingTAUrequired")

    def test_layer3_params_patch_exposes_reestablishment_cause(self):
        params = _layer3_params_patch(
            {
                "message_identity": 0x700E,
                "protocol": 26,
                "channel_type": 20,
                "direction_code": 4,
                "payload_bytes": b"\x01\x02",
            },
            "RRCConnectionReestablishmentRequest",
            {"ok": True, "summary": {"reestablishmentCause": "handoverFailure", "rlfRootCause": "t310Expiry"}},
        )
        self.assertEqual(params.get("parsedEstablishmentCause"), "handoverFailure")
        self.assertEqual(params.get("rlf_root_cause"), "t310Expiry")

    def test_pop_matching_common_layer3_event_uses_small_time_tolerance(self):
        ev = {"time": "2025-12-11T10:56:46.324000Z", "event_name": "Radio.Common.Layer3MessageEvent"}
        by_time = {("2025-12-11T10:56:46.324000Z", 0x700E): [ev]}
        by_identity = {0x700E: [ev]}
        picked = _pop_matching_common_layer3_event(
            by_time,
            by_identity,
            "2025-12-11T10:56:46.325000Z",
            0x700E,
        )
        self.assertIs(picked, ev)
        self.assertEqual(by_identity[0x700E], [])

    def test_decode_layer3_rrc_payload_reports_missing_payload_bytes(self):
        result = _decode_layer3_rrc_payload(
            {"protocol": 26, "channel_type": 20, "message_identity": 0x700E},
            "RRCConnectionReestablishmentRequest",
        )
        self.assertFalse(bool(result.get("ok")))
        self.assertIn("No payload bytes present", str(result.get("message") or ""))

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

    def test_l1l2_scheduler_index_maps_tems_resource_block_export_labels(self):
        kpis = [
            {"time": "2026-05-07T10:00:00.000Z", "name": "Number of PDSCH Resource Blocks Carrier 1", "value_num": 41},
            {"time": "2026-05-07T10:00:00.000Z", "name": "Number of PUSCH Resource Blocks Carrier 1", "value_num": 9},
            {"time": "2026-05-07T10:00:00.000Z", "name": "PDSCH Resource Block Allocation Carrier 1 (%)", "value_num": 32.5},
            {"time": "2026-05-07T10:00:00.000Z", "name": "PUSCH Resource Block Allocation Carrier 1 (%)", "value_num": 11.0},
            {"time": "2026-05-07T10:00:00.000Z", "name": "PDSCH Resource Block Allocation Count Carrier 1", "value_num": 118},
            {"time": "2026-05-07T10:00:00.000Z", "name": "PUSCH Resource Block Allocation Count Carrier 1", "value_num": 17},
            {"time": "2026-05-07T10:00:00.000Z", "name": "PDSCH Resource Block Allocation Usage Carrier 1 (%)", "value_num": 0.47},
            {"time": "2026-05-07T10:00:00.000Z", "name": "PUSCH Resource Block Allocation Usage Carrier 1 (%)", "value_num": 0.09},
        ]

        idx = build_l1l2_scheduler_index(kpis, [])
        fields = idx.get("fields") or {}

        self.assertEqual((fields.get("allocated_rb_dl") or {}).get("label"), "LTE PDSCH Resource Blocks")
        self.assertEqual((fields.get("allocated_rb_ul") or {}).get("label"), "LTE PUSCH Resource Blocks")
        self.assertEqual((fields.get("rb_alloc_pct_dl") or {}).get("label"), "LTE PDSCH Resource Block Allocation (%)")
        self.assertEqual((fields.get("rb_alloc_pct_ul") or {}).get("label"), "LTE PUSCH Resource Block Allocation (%)")
        self.assertEqual((fields.get("rb_alloc_count_dl") or {}).get("label"), "LTE PDSCH Res. Block Allocation Count Per Second")
        self.assertEqual((fields.get("rb_alloc_count_ul") or {}).get("label"), "LTE PUSCH Res. Block Allocation Count Per Second")
        self.assertEqual((fields.get("rb_alloc_usage_pct_dl") or {}).get("label"), "EPS PDSCH RB Allocation Usage (%)")
        self.assertEqual((fields.get("rb_alloc_usage_pct_ul") or {}).get("label"), "LTE PUSCH RB Allocation Usage (%)")

        self.assertEqual((fields.get("allocated_rb_dl") or {}).get("stats", {}).get("sampleCount"), 1)
        self.assertEqual((fields.get("allocated_rb_ul") or {}).get("stats", {}).get("sampleCount"), 1)
        self.assertEqual((fields.get("rb_alloc_pct_dl") or {}).get("stats", {}).get("sampleCount"), 1)
        self.assertEqual((fields.get("rb_alloc_pct_ul") or {}).get("stats", {}).get("sampleCount"), 1)
        self.assertEqual((fields.get("rb_alloc_count_dl") or {}).get("stats", {}).get("sampleCount"), 1)
        self.assertEqual((fields.get("rb_alloc_count_ul") or {}).get("stats", {}).get("sampleCount"), 1)
        self.assertEqual((fields.get("rb_alloc_usage_pct_dl") or {}).get("stats", {}).get("sampleCount"), 1)
        self.assertEqual((fields.get("rb_alloc_usage_pct_ul") or {}).get("stats", {}).get("sampleCount"), 1)

        self.assertIn(
            "Number of PDSCH Resource Blocks Carrier 1",
            (fields.get("allocated_rb_dl") or {}).get("metricNames") or [],
        )
        self.assertIn(
            "PUSCH Resource Block Allocation Count Carrier 1",
            (fields.get("rb_alloc_count_ul") or {}).get("metricNames") or [],
        )

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

    def test_analyze_pilot_pollution_at_point_detects_same_carrier_overlap(self):
        run_id = 987654
        _RUNS[run_id] = {
            "run": {"id": run_id},
            "events": [],
            "track_points": [
                {"time": "2025-12-11T10:00:00.000Z", "lat": 33.0, "lon": -7.0},
                {"time": "2025-12-11T10:00:01.000Z", "lat": 33.0002, "lon": -7.0001},
                {"time": "2025-12-11T10:00:02.000Z", "lat": 33.0004, "lon": -7.0002},
            ],
            "catalog": {"signals": []},
            "kpi_samples": [
                {"time": "2025-12-11T10:00:00.000Z", "name": "Radio.Lte.ServingCell[8].Pci", "value_num": 10},
                {"time": "2025-12-11T10:00:00.000Z", "name": "Radio.Lte.ServingCell[8].Downlink.Earfcn", "value_num": 1320},
                {"time": "2025-12-11T10:00:00.000Z", "name": "Radio.Lte.ServingCell[8].Rsrp", "value_num": -92.0},
                {"time": "2025-12-11T10:00:00.000Z", "name": "Radio.Lte.ServingCell[8].Rsrq", "value_num": -13.0},
                {"time": "2025-12-11T10:00:00.000Z", "name": "Radio.Lte.ServingCell[8].RsSinr", "value_num": 2.0},
                {"time": "2025-12-11T10:00:00.000Z", "name": "Radio.Lte.Neighbor[64].Pci", "value_num": 11, "idx": 0},
                {"time": "2025-12-11T10:00:00.000Z", "name": "Radio.Lte.Neighbor[64].Pci", "value_num": 12, "idx": 1},
                {"time": "2025-12-11T10:00:00.000Z", "name": "Radio.Lte.Neighbor[64].Earfcn", "value_num": 1320, "idx": 0},
                {"time": "2025-12-11T10:00:00.000Z", "name": "Radio.Lte.Neighbor[64].Earfcn", "value_num": 1320, "idx": 1},
                {"time": "2025-12-11T10:00:00.000Z", "name": "Radio.Lte.Neighbor[64].Rsrp", "value_num": -91.0, "idx": 0},
                {"time": "2025-12-11T10:00:00.000Z", "name": "Radio.Lte.Neighbor[64].Rsrp", "value_num": -93.0, "idx": 1},
                {"time": "2025-12-11T10:00:00.000Z", "name": "Radio.Lte.Neighbor[64].Rsrq", "value_num": -12.0, "idx": 0},
                {"time": "2025-12-11T10:00:00.000Z", "name": "Radio.Lte.Neighbor[64].Rsrq", "value_num": -12.5, "idx": 1},
                {"time": "2025-12-11T10:00:01.000Z", "name": "Radio.Lte.ServingCell[8].Pci", "value_num": 10},
                {"time": "2025-12-11T10:00:01.000Z", "name": "Radio.Lte.ServingCell[8].Downlink.Earfcn", "value_num": 1320},
                {"time": "2025-12-11T10:00:01.000Z", "name": "Radio.Lte.ServingCell[8].Rsrp", "value_num": -91.0},
                {"time": "2025-12-11T10:00:01.000Z", "name": "Radio.Lte.ServingCell[8].Rsrq", "value_num": -13.5},
                {"time": "2025-12-11T10:00:01.000Z", "name": "Radio.Lte.ServingCell[8].RsSinr", "value_num": 1.5},
                {"time": "2025-12-11T10:00:01.000Z", "name": "Radio.Lte.Neighbor[64].Pci", "value_num": 11, "idx": 0},
                {"time": "2025-12-11T10:00:01.000Z", "name": "Radio.Lte.Neighbor[64].Pci", "value_num": 12, "idx": 1},
                {"time": "2025-12-11T10:00:01.000Z", "name": "Radio.Lte.Neighbor[64].Earfcn", "value_num": 1320, "idx": 0},
                {"time": "2025-12-11T10:00:01.000Z", "name": "Radio.Lte.Neighbor[64].Earfcn", "value_num": 1320, "idx": 1},
                {"time": "2025-12-11T10:00:01.000Z", "name": "Radio.Lte.Neighbor[64].Rsrp", "value_num": -90.5, "idx": 0},
                {"time": "2025-12-11T10:00:01.000Z", "name": "Radio.Lte.Neighbor[64].Rsrp", "value_num": -92.5, "idx": 1},
                {"time": "2025-12-11T10:00:01.000Z", "name": "Radio.Lte.Neighbor[64].Rsrq", "value_num": -12.0, "idx": 0},
                {"time": "2025-12-11T10:00:01.000Z", "name": "Radio.Lte.Neighbor[64].Rsrq", "value_num": -12.5, "idx": 1},
            ],
        }
        try:
            payload = analyze_pilot_pollution_at_point(
                None,
                run_id,
                "2025-12-11T10:00:01.000Z",
                lat=33.0002,
                lon=-7.0001,
                window_ms=3000,
            )
            self.assertEqual(payload.get("status"), "success")
            analysis = payload.get("analysis") or {}
            self.assertEqual(analysis.get("verdict"), "Medium")
            self.assertEqual((analysis.get("summary") or {}).get("eventCount"), 1)
            top_polluters = (analysis.get("summary") or {}).get("topPolluters") or []
            self.assertTrue(all(int(row.get("pci") or -1) != 10 for row in top_polluters))
            self.assertTrue(any(int(row.get("pci") or -1) == 11 for row in top_polluters))
            top_group = (analysis.get("summary") or {}).get("topPollutionGroupMembers") or []
            self.assertTrue(any(int(row.get("pci") or -1) == 10 and int(row.get("servingMemberSampleCount") or 0) > 0 for row in top_group))
            selected = (analysis.get("summary") or {}).get("selectedSample") or {}
            self.assertTrue(bool(selected.get("polluted")))
            self.assertGreaterEqual(int(selected.get("strongCellCount") or 0), 3)
            self.assertEqual(int(selected.get("polluterCount") or 0), 2)
            self.assertGreater(float(selected.get("detectionConfidence") or 0.0), float(selected.get("attributionConfidence") or 0.0))
        finally:
            _RUNS.pop(run_id, None)

    def test_singleton_pollution_event_caps_high_severity_without_failure_support(self):
        run_id = 987657
        _RUNS[run_id] = {
            "run": {"id": run_id},
            "events": [],
            "track_points": [
                {"time": "2025-12-11T10:00:01.000Z", "lat": 33.0, "lon": -7.0},
            ],
            "catalog": {"signals": []},
            "kpi_samples": [
                {"time": "2025-12-11T10:00:01.000Z", "name": "Radio.Lte.ServingCell[8].Pci", "value_num": 20},
                {"time": "2025-12-11T10:00:01.000Z", "name": "Radio.Lte.ServingCell[8].Downlink.Earfcn", "value_num": 1320},
                {"time": "2025-12-11T10:00:01.000Z", "name": "Radio.Lte.ServingCell[8].Rsrp", "value_num": -100.0},
                {"time": "2025-12-11T10:00:01.000Z", "name": "Radio.Lte.ServingCell[8].Rsrq", "value_num": -15.0},
                {"time": "2025-12-11T10:00:01.000Z", "name": "Radio.Lte.ServingCell[8].RsSinr", "value_num": -1.0},
                {"time": "2025-12-11T10:00:01.000Z", "name": "Radio.Lte.Neighbor[64].Pci", "value_num": 21, "idx": 0},
                {"time": "2025-12-11T10:00:01.000Z", "name": "Radio.Lte.Neighbor[64].Pci", "value_num": 22, "idx": 1},
                {"time": "2025-12-11T10:00:01.000Z", "name": "Radio.Lte.Neighbor[64].Pci", "value_num": 23, "idx": 2},
                {"time": "2025-12-11T10:00:01.000Z", "name": "Radio.Lte.Neighbor[64].Pci", "value_num": 24, "idx": 3},
                {"time": "2025-12-11T10:00:01.000Z", "name": "Radio.Lte.Neighbor[64].Earfcn", "value_num": 1320, "idx": 0},
                {"time": "2025-12-11T10:00:01.000Z", "name": "Radio.Lte.Neighbor[64].Earfcn", "value_num": 1320, "idx": 1},
                {"time": "2025-12-11T10:00:01.000Z", "name": "Radio.Lte.Neighbor[64].Earfcn", "value_num": 1320, "idx": 2},
                {"time": "2025-12-11T10:00:01.000Z", "name": "Radio.Lte.Neighbor[64].Earfcn", "value_num": 1320, "idx": 3},
                {"time": "2025-12-11T10:00:01.000Z", "name": "Radio.Lte.Neighbor[64].Rsrp", "value_num": -100.2, "idx": 0},
                {"time": "2025-12-11T10:00:01.000Z", "name": "Radio.Lte.Neighbor[64].Rsrp", "value_num": -100.4, "idx": 1},
                {"time": "2025-12-11T10:00:01.000Z", "name": "Radio.Lte.Neighbor[64].Rsrp", "value_num": -101.0, "idx": 2},
                {"time": "2025-12-11T10:00:01.000Z", "name": "Radio.Lte.Neighbor[64].Rsrp", "value_num": -101.5, "idx": 3},
                {"time": "2025-12-11T10:00:01.000Z", "name": "Radio.Lte.Neighbor[64].Rsrq", "value_num": -12.5, "idx": 0},
                {"time": "2025-12-11T10:00:01.000Z", "name": "Radio.Lte.Neighbor[64].Rsrq", "value_num": -12.6, "idx": 1},
                {"time": "2025-12-11T10:00:01.000Z", "name": "Radio.Lte.Neighbor[64].Rsrq", "value_num": -12.7, "idx": 2},
                {"time": "2025-12-11T10:00:01.000Z", "name": "Radio.Lte.Neighbor[64].Rsrq", "value_num": -12.8, "idx": 3},
            ],
        }
        try:
            payload = analyze_pilot_pollution_at_point(
                None,
                run_id,
                "2025-12-11T10:00:01.000Z",
                lat=33.0,
                lon=-7.0,
                window_ms=1000,
            )
            analysis = payload.get("analysis") or {}
            events = analysis.get("events") or []
            self.assertEqual(len(events), 1)
            self.assertEqual(events[0].get("severity"), "Medium")
            self.assertFalse(bool(events[0].get("hardFailureSupport")))
        finally:
            _RUNS.pop(run_id, None)

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

    def test_parse_declarations_cdf_expands_array_metric_ids(self):
        decl_record = _field_len(1, b"Radio.Lte.Neighbor[64].Rsrp") + _field_varint(2, 10537)
        metric_map, unknown = parse_declarations_cdf(_field_len(1, decl_record))
        self.assertEqual(unknown, [])
        self.assertEqual(metric_map[10537]["name"], "Radio.Lte.Neighbor[64].Rsrp")
        self.assertEqual(metric_map[10537]["idx"], 0)
        self.assertEqual(metric_map[10537]["expanded_name"], "Radio.Lte.Neighbor[0].Rsrp")
        self.assertEqual(metric_map[10543]["name"], "Radio.Lte.Neighbor[64].Rsrp")
        self.assertEqual(metric_map[10543]["idx"], 6)
        self.assertEqual(metric_map[10543]["base_metric_id"], 10537)
        self.assertEqual(metric_map[10543]["expanded_name"], "Radio.Lte.Neighbor[6].Rsrp")

    def test_build_neighbors_at_time_forward_fills_slot_metrics(self):
        run_id = 987655
        _RUNS[run_id] = {
            "run": {"id": run_id},
            "events": [],
            "track_points": [],
            "catalog": {"signals": []},
            "kpi_samples": [
                {"time": "2025-12-11T10:00:00.000Z", "name": "Radio.Lte.Neighbor[64].Pci", "value_num": 101, "idx": 0},
                {"time": "2025-12-11T10:00:00.000Z", "name": "Radio.Lte.Neighbor[64].Earfcn", "value_num": 1320, "idx": 0},
                {"time": "2025-12-11T10:00:01.000Z", "name": "Radio.Lte.Neighbor[64].Rsrp", "value_num": -87.0, "idx": 0},
                {"time": "2025-12-11T10:00:01.000Z", "name": "Radio.Lte.Neighbor[64].Rsrq", "value_num": -10.5, "idx": 0},
                {"time": "2025-12-11T10:00:00.500Z", "name": "Radio.Lte.Neighbor[64].Pci", "value_num": 102, "idx": 1},
                {"time": "2025-12-11T10:00:00.500Z", "name": "Radio.Lte.Neighbor[64].Earfcn", "value_num": 1320, "idx": 1},
                {"time": "2025-12-11T10:00:01.500Z", "name": "Radio.Lte.Neighbor[64].Rsrp", "value_num": -85.0, "idx": 1},
                {"time": "2025-12-11T10:00:01.500Z", "name": "Radio.Lte.Neighbor[64].Rsrq", "value_num": -11.0, "idx": 1},
            ],
        }
        try:
            payload = build_neighbors_at_time(None, run_id, "2025-12-11T10:00:02.000Z", tol_ms=300, bucket_ms=80)
            neighbors = payload.get("neighbors") or []
            self.assertEqual(len(neighbors), 2)
            self.assertEqual(neighbors[0]["pci"], 102)
            self.assertEqual(neighbors[0]["slotIndex"], 1)
            self.assertEqual(neighbors[0]["slotName"], "Slot_N2")
            self.assertEqual(neighbors[0]["rankedNeighbor"], "N1")
            self.assertAlmostEqual(float(neighbors[0]["rsrp"]), -85.0)
            self.assertEqual(neighbors[1]["pci"], 101)
            self.assertEqual(neighbors[1]["slotIndex"], 0)
            self.assertEqual(neighbors[1]["rankedNeighbor"], "N2")
            self.assertAlmostEqual(float(neighbors[1]["rsrq"]), -10.5)
        finally:
            _RUNS.pop(run_id, None)

    def test_build_neighbors_at_time_falls_back_to_time_of_day_when_dates_shift(self):
        run_id = 987657
        _RUNS[run_id] = {
            "run": {"id": run_id},
            "events": [],
            "track_points": [],
            "catalog": {"signals": []},
            "kpi_samples": [
                {"time": "2025-12-05T11:01:43.500Z", "name": "Radio.Lte.Neighbor[64].Pci", "value_num": 418, "idx": 0},
                {"time": "2025-12-05T11:01:43.500Z", "name": "Radio.Lte.Neighbor[64].Earfcn", "value_num": 1320, "idx": 0},
                {"time": "2025-12-05T11:01:44.000Z", "name": "Radio.Lte.Neighbor[64].Rsrp", "value_num": -100.6, "idx": 0},
                {"time": "2025-12-05T11:01:44.000Z", "name": "Radio.Lte.Neighbor[64].Rsrq", "value_num": -15.0, "idx": 0},
            ],
        }
        try:
            payload = build_neighbors_at_time(None, run_id, "2025-12-11T11:01:44.091Z", tol_ms=300, bucket_ms=80)
            neighbors = payload.get("neighbors") or []
            self.assertEqual(len(neighbors), 1)
            self.assertEqual(neighbors[0]["pci"], 418)
            self.assertEqual(neighbors[0]["earfcn"], 1320)
            self.assertAlmostEqual(float(neighbors[0]["rsrp"]), -100.6)
            self.assertLessEqual(int((neighbors[0].get("agesMs") or {}).get("rsrp") or 10**9), 3000)
        finally:
            _RUNS.pop(run_id, None)

    def test_build_serving_at_time_uses_primary_serving_cell_index(self):
        run_id = 987656
        _RUNS[run_id] = {
            "run": {"id": run_id},
            "events": [],
            "track_points": [],
            "catalog": {"signals": []},
            "kpi_samples": [
                {"time": "2025-12-11T10:00:01.000Z", "name": "Radio.Lte.ServingCell[8].Pci", "value_num": 10, "idx": 0},
                {"time": "2025-12-11T10:00:01.000Z", "name": "Radio.Lte.ServingCell[8].Pci", "value_num": 99, "idx": 1},
                {"time": "2025-12-11T10:00:01.000Z", "name": "Radio.Lte.ServingCell[8].Rsrp", "value_num": -92.0, "idx": 0},
                {"time": "2025-12-11T10:00:01.000Z", "name": "Radio.Lte.ServingCell[8].Rsrp", "value_num": -70.0, "idx": 1},
                {"time": "2025-12-11T10:00:01.000Z", "name": "Radio.Lte.ServingCell[8].Downlink.Earfcn", "value_num": 1320, "idx": 0},
                {"time": "2025-12-11T10:00:01.000Z", "name": "Radio.Lte.ServingCell[8].Downlink.Earfcn", "value_num": 3350, "idx": 1},
            ],
        }
        try:
            serving = build_serving_at_time(None, run_id, "2025-12-11T10:00:01.000Z", tol_ms=200)
            self.assertEqual(serving.get("pci"), 10)
            self.assertEqual(serving.get("earfcn"), 1320)
            self.assertAlmostEqual(float(serving.get("rsrp")), -92.0)
        finally:
            _RUNS.pop(run_id, None)

    def test_build_serving_at_time_extracts_scell_rf_and_ignores_zero_placeholders(self):
        run_id = 987657
        _RUNS[run_id] = {
            "run": {"id": run_id},
            "events": [],
            "track_points": [],
            "catalog": {"signals": []},
            "kpi_samples": [
                {"time": "2025-12-11T10:00:01.000Z", "name": "Radio.Lte.ServingCell[8].Pci", "value_num": 10, "idx": 0},
                {"time": "2025-12-11T10:00:01.000Z", "name": "Radio.Lte.ServingCell[8].Downlink.Earfcn", "value_num": 1320, "idx": 0},
                {"time": "2025-12-11T10:00:01.000Z", "name": "Radio.Lte.ServingCell[8].Rsrp", "value_num": -92.0, "idx": 0},
                {"time": "2025-12-11T10:00:01.000Z", "name": "Radio.Lte.ServingCell[8].Rsrq", "value_num": -13.0, "idx": 0},
                {"time": "2025-12-11T10:00:01.000Z", "name": "Radio.Lte.ServingCell[8].RsSinr", "value_num": 2.0, "idx": 0},
                {"time": "2025-12-11T10:00:00.900Z", "name": "Radio.Lte.ServingCell[8].Pci", "value_num": 99, "idx": 1},
                {"time": "2025-12-11T10:00:00.900Z", "name": "Radio.Lte.ServingCell[8].Downlink.Earfcn", "value_num": 3350, "idx": 1},
                {"time": "2025-12-11T10:00:00.800Z", "name": "Radio.Lte.ServingCell[8].Rsrp", "value_num": -83.5, "idx": 1},
                {"time": "2025-12-11T10:00:00.800Z", "name": "Radio.Lte.ServingCell[8].Rsrq", "value_num": -9.5, "idx": 1},
                {"time": "2025-12-11T10:00:00.800Z", "name": "Radio.Lte.ServingCell[8].RsSinr", "value_num": 11.0, "idx": 1},
                {"time": "2025-12-11T10:00:01.000Z", "name": "Radio.Lte.ServingCell[8].Rsrp", "value_num": 0.0, "idx": 1},
                {"time": "2025-12-11T10:00:01.000Z", "name": "Radio.Lte.ServingCell[8].Rsrq", "value_num": 0.0, "idx": 1},
            ],
        }
        try:
            serving = build_serving_at_time(None, run_id, "2025-12-11T10:00:01.000Z", tol_ms=200)
            self.assertEqual(len(serving.get("scells") or []), 1)
            scell = serving["scells"][0]
            self.assertEqual(scell.get("pci"), 99)
            self.assertEqual(scell.get("earfcn"), 3350)
            self.assertAlmostEqual(float(scell.get("rsrp")), -83.5)
            self.assertAlmostEqual(float(scell.get("rsrq")), -9.5)
            self.assertAlmostEqual(float(scell.get("sinr")), 11.0)
        finally:
            _RUNS.pop(run_id, None)

    def test_build_serving_at_time_falls_back_to_time_of_day_when_dates_shift(self):
        run_id = 987658
        _RUNS[run_id] = {
            "run": {"id": run_id},
            "events": [],
            "track_points": [],
            "catalog": {"signals": []},
            "kpi_samples": [
                {"time": "2025-12-05T11:01:44.050Z", "name": "Radio.Lte.ServingCell[8].Pci", "value_num": 388, "idx": 0},
                {"time": "2025-12-05T11:01:44.050Z", "name": "Radio.Lte.ServingCell[8].Rsrp", "value_num": -99.7, "idx": 0},
                {"time": "2025-12-05T11:01:44.050Z", "name": "Radio.Lte.ServingCell[8].Rsrq", "value_num": -15.6, "idx": 0},
                {"time": "2025-12-05T11:01:44.050Z", "name": "Radio.Lte.ServingCell[8].RsSinr", "value_num": -0.6, "idx": 0},
                {"time": "2025-12-05T11:01:44.050Z", "name": "Radio.Lte.ServingCell[8].Downlink.Earfcn", "value_num": 1320, "idx": 0},
            ],
        }
        try:
            serving = build_serving_at_time(None, run_id, "2025-12-11T11:01:44.091Z", tol_ms=200)
            self.assertEqual(serving.get("pci"), 388)
            self.assertEqual(serving.get("earfcn"), 1320)
            self.assertAlmostEqual(float(serving.get("rsrp")), -99.7)
            self.assertAlmostEqual(float(serving.get("rsrq")), -15.6)
            self.assertAlmostEqual(float(serving.get("sinr")), -0.6)
        finally:
            _RUNS.pop(run_id, None)

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

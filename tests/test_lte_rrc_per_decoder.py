import json
import unittest

import pycrate_asn1dir.RRCLTE as RRCLTE

from lte_rrc_per_decoder import (
    decode_measurement_report_payload,
    per_decoder_status,
    _extract_ue_capability_summary,
    _extract_tracking_area_code,
    _extract_rlf_ue_report_summary,
)
from trp_importer import LTE_MR_METRIC_NAME, _decode_lte_rrc_payloads_in_place


def _build_measurement_report_payload() -> bytes:
    msg = RRCLTE.EUTRA_RRC_Definitions.MeasurementReport_r8_IEs
    value = {
        "measResults": {
            "measId": 12,
            "measResultPCell": {
                "rsrpResult": 50,
                "rsrqResult": 20,
            },
            "measResultNeighCells": {
                "measResultListEUTRA": [
                    {
                        "physCellId": 131,
                        "measResult": {"rsrpResult": 40, "rsrqResult": 15},
                    },
                    {
                        "physCellId": 383,
                        "measResult": {"rsrpResult": 35, "rsrqResult": 14},
                    },
                ]
            },
        }
    }
    msg.from_json(json.dumps(value))
    return msg.to_uper()


class LteRrcPerDecoderTests(unittest.TestCase):
    def test_extract_tracking_area_code_from_common_shapes(self):
        self.assertEqual(
            _extract_tracking_area_code({"cellAccessRelatedInfo": {"trackingAreaCode": "0x20AA"}}),
            8362,
        )
        self.assertEqual(
            _extract_tracking_area_code({"trackingAreaCode-r8": "20AA"}),
            8362,
        )
        self.assertEqual(
            _extract_tracking_area_code({"trackingAreaCode": "'0010000010101010'B"}),
            8362,
        )

    def test_extract_rlf_ue_report_summary(self):
        decoded = {
            "criticalExtensions": {
                "c1": {
                    "ueInformationResponse-r9": {
                        "nonCriticalExtension": {
                            "rlf_Report_r9": {
                                "reestablishmentCause": "reconfigurationFailure",
                                "timeConnFailure-r10": 345,
                                "timeSinceFailure-r10": 117,
                                "t310-r9": 1000,
                            }
                        }
                    }
                }
            }
        }
        s = _extract_rlf_ue_report_summary(decoded)
        self.assertTrue(bool(s.get("hasRlfReport")))
        self.assertEqual(s.get("rlfRootCause"), "reconfigurationFailure")
        self.assertIn("reestablishmentCause=reconfigurationFailure", str(s.get("rlfRootCauseDetails")))
        self.assertIn("timeConnFailureMs=345", str(s.get("reestablishmentTimeline")))
        self.assertIn("timeSinceFailureMs=117", str(s.get("reestablishmentTimeline")))
        self.assertIsInstance(s.get("rlfReasonBreakdown"), dict)

    def test_ue_capability_summary_ca_capability_uses_band_combos(self):
        decoded = {
            "maxNumCarriers-r10": 3,
            "supportedBandCombination-r10": [
                {
                    "bandParameterList-r10": [
                        {"bandEUTRA-r10": 3},
                        {"bandEUTRA-r10": 7},
                    ]
                },
                {
                    "bandParameterList-r10": [
                        {"bandEUTRA-r10": 3},
                        {"bandEUTRA-r10": 20},
                    ]
                },
            ],
        }
        s = _extract_ue_capability_summary(decoded)
        self.assertTrue(bool(s.get("caSupported")))
        self.assertEqual(s.get("supportedBandCombinationCount"), 2)
        self.assertEqual(s.get("supportedBandCombinations"), ["B3+B7", "B3+B20"])
        self.assertIn("band combos: B3+B7, B3+B20", str(s.get("caCapability")))
        self.assertIn("MaxNumCarriers=3", str(s.get("caCapability")))

    def test_measurement_report_decode_and_extract(self):
        if not per_decoder_status().get("available"):
            self.skipTest("pycrate decoder unavailable")

        payload = _build_measurement_report_payload()
        out = decode_measurement_report_payload(payload)

        self.assertTrue(out.get("ok"))
        self.assertEqual(out.get("summary", {}).get("measId"), 12)
        self.assertEqual(out.get("summary", {}).get("neighbors_lte_count"), 2)
        neighbors = out.get("neighbors_lte") or []
        self.assertEqual(neighbors[0].get("pci"), 131)
        self.assertEqual(neighbors[0].get("rsrp_idx"), 40)
        self.assertAlmostEqual(float(neighbors[0].get("rsrp_dbm")), -100.0)

    def test_importer_patching_of_kpi_and_events(self):
        if not per_decoder_status().get("available"):
            self.skipTest("pycrate decoder unavailable")

        payload = _build_measurement_report_payload()
        value_str = payload.decode("latin1")
        time_iso = "2025-12-04T11:22:37.679000Z"

        kpis = [{
            "time": time_iso,
            "name": LTE_MR_METRIC_NAME,
            "value_num": None,
            "value_str": value_str,
        }]
        events = [{
            "time": time_iso,
            "event_name": LTE_MR_METRIC_NAME,
            "metric_id": 5333,
            "params": [],
        }]

        stats = _decode_lte_rrc_payloads_in_place(kpis, events)
        self.assertEqual(stats.get("measurement_reports_seen"), 1)
        self.assertEqual(stats.get("measurement_reports_decoded"), 1)

        self.assertTrue(kpis[0].get("per_decoded"))
        self.assertEqual((kpis[0].get("measurement_report_summary") or {}).get("measId"), 12)
        self.assertEqual(len(kpis[0].get("measurement_report_neighbors_json") or []), 2)

        self.assertTrue(events[0].get("per_decoded"))
        self.assertEqual((events[0].get("measurement_report_summary") or {}).get("measId"), 12)


if __name__ == "__main__":
    unittest.main()

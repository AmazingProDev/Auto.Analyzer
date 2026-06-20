import unittest
from datetime import datetime
import tempfile
from pathlib import Path

import server


class ServingCellPresenceMetadataTests(unittest.TestCase):
    def test_flags_nr_presence_without_matched_nr_cell(self):
        cells = {
            "available": True,
            "techBreakdown": {"4G": 381},
        }
        technology_status = {
            "nrPresencePct": 12.6,
            "lteOnlyPresencePct": 87.4,
            "nrPresenceSeconds": 77,
            "lteOnlySeconds": 534,
            "totalPresenceSeconds": 611,
        }
        nr_info = {
            "band": "n28",
            "pci": 423,
            "arfcn": 154570,
        }

        enriched = server._nemo_attach_serving_cell_presence_metadata(cells, technology_status, nr_info)

        self.assertEqual(enriched["matchedTechBreakdown"], {"4G": 381})
        self.assertEqual(enriched["radioPresenceBreakdown"], {"5G": 12.6, "4G": 87.4})
        self.assertFalse(enriched["hasMatchedNrCells"])
        self.assertTrue(enriched["hasNrPresence"])
        self.assertTrue(enriched["nrDetectedWithoutMatchedNrCell"])
        self.assertIn("n28 PCI 423 / ARFCN 154570", enriched["servingTechMismatchNote"])

    def test_lte_band_label_prefers_nemo_band_tokens(self):
        self.assertEqual(server._nemo_lte_band_label("B7"), "L2600")
        self.assertEqual(server._nemo_lte_band_label("B20"), "L800")
        self.assertEqual(server._nemo_lte_band_label("L1800"), "L1800")

    def test_presence_seconds_split_disjoint_segments(self):
        stamps = [
            datetime(2026, 5, 13, 14, 38, 4, 394000),
            datetime(2026, 5, 13, 14, 38, 4, 690000),
            datetime(2026, 5, 13, 14, 38, 5, 1000),
            datetime(2026, 5, 13, 14, 39, 29, 0),
            datetime(2026, 5, 13, 14, 39, 30, 0),
        ]

        self.assertEqual(server._nemo_presence_seconds(stamps), 4.0)

    def test_json_safe_converts_nested_datetimes(self):
        payload = {
            "dominantNrInfo": {
                "startDt": datetime(2026, 5, 13, 14, 38, 51, 54000),
                "endDt": datetime(2026, 5, 13, 14, 40, 6, 294000),
            }
        }

        safe = server._json_safe(payload)

        self.assertEqual(safe["dominantNrInfo"]["startDt"], "2026-05-13T14:38:51.054000")
        self.assertEqual(safe["dominantNrInfo"]["endDt"], "2026-05-13T14:40:06.294000")

    def test_sum_interval_seconds_by_key_uses_fallback_end_for_open_interval(self):
        intervals = [
            {
                "key": ("5G_CELL", "SITE", "5G", "n28"),
                "start": datetime(2026, 5, 13, 14, 38, 49),
                "end": None,
            }
        ]
        fallback_end = datetime(2026, 5, 13, 14, 40, 5)

        totals = server._nemo_sum_interval_seconds_by_key(intervals, fallback_end)

        self.assertEqual(totals[("5G_CELL", "SITE", "5G", "n28")], 76.0)

    def test_build_episode_ranges_extends_to_next_primary_change(self):
        key_4g = ("4G_CELL", "SITE", "4G", "L1800")
        key_5g = ("5G_CELL", "SITE", "5G", "n28")
        records = [
            {"key": key_4g, "dt": datetime(2026, 5, 13, 14, 38, 11)},
            {"key": key_4g, "dt": datetime(2026, 5, 13, 14, 38, 12)},
            {"key": key_5g, "dt": datetime(2026, 5, 13, 14, 38, 49)},
            {"key": key_5g, "dt": datetime(2026, 5, 13, 14, 38, 50)},
            {"key": key_4g, "dt": datetime(2026, 5, 13, 14, 40, 5)},
        ]
        global_end = datetime(2026, 5, 13, 14, 40, 16)

        episodes = server._nemo_build_episode_ranges(records, global_end)

        self.assertEqual(len(episodes), 3)
        self.assertEqual(episodes[1]["key"], key_5g)
        self.assertEqual(episodes[1]["dwellSec"], 76.0)

    def test_compute_technology_status_uses_slice_rows_only(self):
        rows = [
            {
                "_dt": datetime(2026, 5, 13, 14, 38, 4),
                "nrChannelNumber": None,
                "servingTechnology": "LTE FDD",
                "packetTechnology": "LTE FDD",
                "cellTypes": ["LTE Serving"],
                "macDl5gMbps": 0,
                "pdschDl5gMbps": 0,
                "band": "B3",
            },
            {
                "_dt": datetime(2026, 5, 13, 14, 38, 5),
                "nrChannelNumber": 154570,
                "servingTechnology": "EN-DC",
                "packetTechnology": "EN-DC",
                "cellTypes": ["NR SCG PSCell"],
                "macDl5gMbps": 12.0,
                "pdschDl5gMbps": 11.0,
                "band": "n28",
            },
        ]

        status = server._nemo_compute_technology_status(rows, "IAM")

        self.assertTrue(status["has5g"])
        self.assertEqual(status["nrPresenceSeconds"], 1)
        self.assertEqual(status["lteOnlySeconds"], 1)
        self.assertEqual(status["nrPresencePct"], 50.0)
        self.assertEqual(status["lteOnlyPresencePct"], 50.0)

    def test_forward_filled_timeshare_carries_sparse_events_across_seconds(self):
        from datetime import datetime as _dt
        # Serving technology is a change-event column: only logged on transitions.
        timeline = [
            (_dt(2026, 5, 13, 14, 38, 0), "LTE FDD"),
            (_dt(2026, 5, 13, 14, 38, 1), ""),   # idle second carries last value
            (_dt(2026, 5, 13, 14, 38, 2), ""),
            (_dt(2026, 5, 13, 14, 38, 3), "EN-DC"),
            (_dt(2026, 5, 13, 14, 38, 4), ""),
        ]
        counts = server._nemo_forward_filled_timeshare(timeline)
        # 3 seconds attributed to LTE FDD (0,1,2), 2 to EN-DC (3,4) — time-based, not 1-vs-1 sample counts.
        self.assertEqual(counts, {"LTE FDD": 3, "EN-DC": 2})

    def test_technology_status_serving_distribution_is_time_based(self):
        # Sparse serving events (1 LTE, 1 EN-DC) but EN-DC dwell spans 3 seconds.
        rows = [
            {"_dt": datetime(2026, 5, 13, 14, 38, 0), "servingTechnology": "LTE FDD", "packetTechnology": "LTE FDD"},
            {"_dt": datetime(2026, 5, 13, 14, 38, 1), "servingTechnology": "EN-DC", "packetTechnology": "EN-DC", "nrChannelNumber": 154570, "band": "n28"},
            {"_dt": datetime(2026, 5, 13, 14, 38, 2), "servingTechnology": "", "packetTechnology": "", "nrChannelNumber": 154570, "band": "n28"},
            {"_dt": datetime(2026, 5, 13, 14, 38, 3), "servingTechnology": "", "packetTechnology": "", "nrChannelNumber": 154570, "band": "n28"},
        ]
        status = server._nemo_compute_technology_status(rows, "IAM")
        serving = {item["label"]: item["share"] for item in status["servingTechnologyDistribution"]}
        # EN-DC carried across 3 of 4 seconds → 75%, not 50% (which the old per-event count gave).
        self.assertEqual(serving["EN-DC"], 75.0)
        self.assertEqual(serving["LTE FDD"], 25.0)

    def test_is_valid_band_rejects_placeholders(self):
        for good in ("n78", "n28", "B3", "L2600"):
            self.assertTrue(server._nemo_is_valid_band(good))
        for bad in ("undefined", "UNDEFINED", "none", "null", "n/a", "-", "", "  ", None):
            self.assertFalse(server._nemo_is_valid_band(bad))

    def test_technology_status_excludes_undefined_nr_band(self):
        rows = [
            {"_dt": datetime(2026, 5, 13, 14, 38, 0), "servingTechnology": "EN-DC", "packetTechnology": "EN-DC", "nrChannelNumber": 633984, "band": "n78"},
            {"_dt": datetime(2026, 5, 13, 14, 38, 1), "servingTechnology": "EN-DC", "packetTechnology": "EN-DC", "nrChannelNumber": 633984, "band": "undefined"},
        ]
        status = server._nemo_compute_technology_status(rows, "ORANGE")
        self.assertEqual(status["nrBands"], ["n78"])

    def test_radio_presence_breakdown_from_primary_dwell(self):
        cells = [
            {"tech": "4G", "dwellSec": 48.0},
            {"tech": "4G", "dwellSec": 7.0},
            {"tech": "5G", "dwellSec": 76.0},
        ]

        breakdown = server._nemo_radio_presence_breakdown_from_cells(cells)

        self.assertEqual(breakdown, {"4G": 42.0, "5G": 58.0})

    def test_dominant_arfcn_by_tech_pci_prefers_known_value(self):
        rows = [
            {"pci": 659, "nrChannelNumber": None, "lteChannelNumber": None, "cellTypes": ["NR Serving"]},
            {"pci": 659, "nrChannelNumber": 630720, "lteChannelNumber": None, "cellTypes": ["NR Serving"]},
            {"pci": 659, "nrChannelNumber": 630720, "lteChannelNumber": None, "cellTypes": ["NR Serving"]},
        ]

        mapping = server._nemo_resolve_dominant_arfcn_by_tech_pci(rows)

        self.assertEqual(mapping[("5G", 659)], 630720)

    def test_episode_connection_state_prefers_rrc_state(self):
        records = [
            {"rrcState": "RRC_IDLE"},
            {"rrcState": "CONNECTED"},
            {"rrcState": "CELL_DCH"},
        ]

        state = server._nemo_episode_connection_state(records)

        self.assertEqual(state, "Connected")

    def test_episode_dl_window_uses_first_and_last_app_sample(self):
        records = [
            {"appTs": [datetime(2026, 5, 13, 14, 39, 29)]},
            {"appTs": []},
            {"appTs": [datetime(2026, 5, 13, 14, 39, 52)]},
        ]

        start_time, end_time = server._nemo_episode_dl_window(records)

        self.assertEqual(start_time, "14:39:29")
        self.assertEqual(end_time, "14:39:52")

    def test_episode_ul_window_uses_first_and_last_app_sample(self):
        records = [
            {"appTsUl": [datetime(2026, 5, 13, 14, 38, 36)]},
            {"appTsUl": []},
            {"appTsUl": [datetime(2026, 5, 13, 14, 39, 6)]},
        ]

        start_time, end_time = server._nemo_episode_ul_window(records)

        self.assertEqual(start_time, "14:38:36")
        self.assertEqual(end_time, "14:39:06")

    def test_parse_operator_file_reads_rrc_state_column(self):
        header = [
            "Time",
            "Measurement Title",
            "Lat.",
            "Lon.",
            "Serving technology",
            "Cell type",
            "LTE PCI",
            "LTE channel number",
            "RRC State",
        ]
        row = [
            "14:39:29.000",
            "DT 1",
            "34.0",
            "-6.0",
            "LTE FDD",
            "LTE Serving",
            "236",
            "1650",
            "CONNECTED",
        ]
        with tempfile.NamedTemporaryFile("w", suffix=".csv", delete=False, encoding="utf-8") as handle:
            handle.write(";".join(header) + "\n")
            handle.write(";".join(row) + "\n")
            path = handle.name
        self.addCleanup(lambda: Path(path).unlink(missing_ok=True))

        parsed = server._nemo_parse_operator_file_uncached(path)

        self.assertEqual(parsed["rows"][0]["rrcState"], "CONNECTED")

    def test_transfer_sessions_reuse_success_bytes_as_target_for_same_url(self):
        url = "http://ipv4.appliwave.testdebit.info/50M/50M.zip"
        rows = [
            {
                "_dt": datetime(2026, 5, 13, 14, 39, 29, 313000),
                "dataTransferDirection": "Downlink",
                "transferFilename": url,
                "measurementTitle": "DT 1",
            },
            {
                "_dt": datetime(2026, 5, 13, 14, 39, 29, 555000),
                "transferFilename": url,
                "bytesDl": 200_000_000.0,
                "transferStatus": "Success",
                "measurementTitle": "DT 1",
            },
            {
                "_dt": datetime(2026, 5, 13, 14, 39, 53, 847000),
                "bytesDl": 200_000_000.0,
                "measurementTitle": "DT 1",
            },
            {
                "_dt": datetime(2026, 5, 13, 14, 44, 36, 599000),
                "dataTransferDirection": "Downlink",
                "transferFilename": url,
                "measurementTitle": "DT 2",
            },
            {
                "_dt": datetime(2026, 5, 13, 14, 44, 40, 0),
                "bytesDl": 100_000_000.0,
                "measurementTitle": "DT 2",
            },
        ]

        sessions = server._nemo_build_transfer_sessions(rows, "IAM")

        self.assertEqual(len(sessions), 2)
        self.assertEqual(sessions[0]["targetBytes"], 200_000_000.0)
        self.assertEqual(sessions[1]["targetBytes"], 200_000_000.0)
        self.assertEqual(sessions[1]["completionPct"], 50.0)

    def test_downlink_intervals_use_transfer_session_bounds(self):
        sessions = [
            {
                "direction": "Downlink",
                "startTime": "2026-05-13T14:39:29.313000",
                "endTime": "2026-05-13T14:39:53.847000",
            },
            {
                "direction": "Uplink",
                "startTime": "2026-05-13T14:38:36.624000",
                "endTime": "2026-05-13T14:39:06.000000",
            },
        ]

        intervals = server._nemo_downlink_transfer_intervals(sessions)

        self.assertEqual(len(intervals), 1)
        self.assertEqual(intervals[0]["start"].isoformat(), "2026-05-13T14:39:29.313000")
        self.assertEqual(intervals[0]["end"].isoformat(), "2026-05-13T14:39:53.847000")

    def test_uplink_intervals_use_transfer_session_bounds(self):
        sessions = [
            {
                "direction": "Downlink",
                "startTime": "2026-05-13T14:39:29.313000",
                "endTime": "2026-05-13T14:39:53.847000",
            },
            {
                "direction": "Uplink",
                "startTime": "2026-05-13T14:38:36.624000",
                "endTime": "2026-05-13T14:39:06.000000",
            },
        ]

        intervals = server._nemo_uplink_transfer_intervals(sessions)

        self.assertEqual(len(intervals), 1)
        self.assertEqual(intervals[0]["start"].isoformat(), "2026-05-13T14:38:36.624000")
        self.assertEqual(intervals[0]["end"].isoformat(), "2026-05-13T14:39:06")

    def test_clip_episodes_to_download_intervals(self):
        episodes = [
            {
                "key": ("4G_A", "SITE_A", "4G", "L2600"),
                "records": [{"dt": datetime(2026, 5, 13, 14, 38, 4)}],
                "start": datetime(2026, 5, 13, 14, 38, 4),
                "end": datetime(2026, 5, 13, 14, 38, 11),
                "dwellSec": 7.0,
                "display": {
                    "cellName": "4G_A",
                    "siteName": "SITE_A",
                    "tech": "4G",
                    "band": "L2600",
                    "samples": 10,
                    "avgDlMbps": None,
                    "medianRsrp": None,
                    "medianSinr": None,
                    "servingMode": "LTE FDD",
                    "lteAnchor": None,
                    "connectionState": "Connected (inferred)",
                    "color": "#3b82f6",
                },
            },
            {
                "key": ("5G_A", "SITE_B", "5G", "n28"),
                "records": [
                    {"dt": datetime(2026, 5, 13, 14, 39, 29), "dl": [66.2], "appTs": [datetime(2026, 5, 13, 14, 39, 29)], "ul": [12.1], "appTsUl": [datetime(2026, 5, 13, 14, 39, 35)]},
                    {"dt": datetime(2026, 5, 13, 14, 39, 52), "dl": [124.6], "appTs": [datetime(2026, 5, 13, 14, 39, 52)], "ul": [18.4], "appTsUl": [datetime(2026, 5, 13, 14, 39, 48)]},
                ],
                "start": datetime(2026, 5, 13, 14, 38, 49),
                "end": datetime(2026, 5, 13, 14, 40, 5),
                "dwellSec": 76.0,
                "display": {
                    "cellName": "5G_A",
                    "siteName": "SITE_B",
                    "tech": "5G",
                    "band": "n28",
                    "samples": 3,
                    "avgDlMbps": 66.2,
                    "medianRsrp": -104.2,
                    "medianSinr": -2.2,
                    "servingMode": "EN-DC",
                    "lteAnchor": "4G_A",
                    "connectionState": "Connected (inferred)",
                    "color": "#a855f7",
                },
            },
        ]
        intervals = [
            {
                "start": datetime(2026, 5, 13, 14, 39, 29, 313000),
                "end": datetime(2026, 5, 13, 14, 39, 53, 847000),
            }
        ]

        clipped = server._nemo_clip_primary_episodes_to_intervals(episodes, intervals)

        self.assertEqual(len(clipped), 1)
        self.assertEqual(clipped[0]["display"]["tech"], "5G")
        self.assertEqual(clipped[0]["start"].isoformat(), "2026-05-13T14:39:29.313000")
        self.assertEqual(clipped[0]["end"].isoformat(), "2026-05-13T14:39:53.847000")
        self.assertEqual(clipped[0]["display"]["dlStartTime"], "14:39:29")
        self.assertEqual(clipped[0]["display"]["dlEndTime"], "14:39:52")
        self.assertEqual(clipped[0]["display"]["ulStartTime"], "14:39:35")
        self.assertEqual(clipped[0]["display"]["ulEndTime"], "14:39:48")

    def test_radio_presence_breakdown_from_download_scoped_episodes(self):
        episodes = [
            {
                "display": {"tech": "5G"},
                "dwellSec": 24.534,
            }
        ]

        breakdown = server._nemo_radio_presence_breakdown_from_episodes(episodes)

        self.assertEqual(breakdown, {"5G": 100.0})

    def test_download_dwell_by_key_from_clipped_episodes(self):
        episodes = [
            {
                "key": ("5G_A", "SITE_B", "5G", "n28"),
                "dwellSec": 24.551,
            },
            {
                "key": ("4G_A", "SITE_A", "4G", "L1800"),
                "dwellSec": 7.0,
            },
            {
                "key": ("5G_A", "SITE_B", "5G", "n28"),
                "dwellSec": 5.0,
            },
        ]

        totals = server._nemo_episode_dwell_by_key(episodes)

        self.assertEqual(totals[("5G_A", "SITE_B", "5G", "n28")], 30.0)
        self.assertEqual(totals[("4G_A", "SITE_A", "4G", "L1800")], 7.0)

    def test_presence_share_from_cells_uses_dwell_seconds(self):
        cells = [
            {"cellName": "4G_A", "dwellSec": 48.0, "dwellSecDownload": None},
            {"cellName": "4G_B", "dwellSec": 7.0, "dwellSecDownload": None},
            {"cellName": "5G_A", "dwellSec": 76.0, "dwellSecDownload": 25.0},
        ]

        shares = server._nemo_presence_share_from_cells(cells, "dwellSec")
        download_shares = server._nemo_presence_share_from_cells(cells, "dwellSecDownload")

        self.assertEqual(shares["4G_A"], 36.6)
        self.assertEqual(shares["4G_B"], 5.3)
        self.assertEqual(shares["5G_A"], 58.0)
        self.assertEqual(download_shares["5G_A"], 100.0)

    def test_presence_share_from_cells_upload_independent_of_download(self):
        cells = [
            {"cellName": "4G_A", "dwellSec": 48.0, "dwellSecDownload": None, "dwellSecUpload": 10.0},
            {"cellName": "4G_B", "dwellSec": 7.0, "dwellSecDownload": None, "dwellSecUpload": None},
            {"cellName": "5G_A", "dwellSec": 76.0, "dwellSecDownload": 25.0, "dwellSecUpload": 30.0},
        ]

        upload_shares = server._nemo_presence_share_from_cells(cells, "dwellSecUpload")

        # Upload presence is scoped to the upload window only (10s + 30s = 40s total).
        self.assertEqual(upload_shares["4G_A"], 25.0)
        self.assertEqual(upload_shares["5G_A"], 75.0)
        self.assertNotIn("4G_B", upload_shares)

    def test_technology_status_table_prefers_serving_cell_radio_presence_when_available(self):
        operator_files = [
            {
                "operator": "IAM",
                "fileName": "iam.txt",
                "path": "/tmp/iam.txt",
                "has5g": True,
                "fiveGStatus": "5G/EN-DC detected",
                "measurementTitles": ["DT 1"],
                "coverage": {},
                "duplicateHeaders": [],
                "throughputScales": {},
                "dlMetricKey": "appDlMbps",
                "kpis": {},
                "tests": [],
                "transferSessions": [],
                "technologyStatus": {
                    "operator": "IAM",
                    "fiveGStatus": "5G/EN-DC detected",
                    "nrPresencePct": 89.2,
                    "lteOnlyPresencePct": 10.8,
                    "nrPresenceSeconds": 116,
                    "lteOnlySeconds": 14,
                    "totalPresenceSeconds": 130,
                },
            }
        ]
        serving_cells = {
            "available": True,
            "radioPresenceBreakdownAll": {"5G": 58.0, "4G": 42.0},
            "cells": [
                {"tech": "4G", "dwellSec": 48.0},
                {"tech": "4G", "dwellSec": 7.0},
                {"tech": "5G", "dwellSec": 76.0},
            ],
            "matchedTechBreakdown": {"4G": 86, "5G": 3},
        }

        merged = server._nemo_merge_technology_status_with_serving_cells(
            operator_files[0]["technologyStatus"],
            serving_cells,
        )

        self.assertEqual(merged["nrPresencePct"], 58.0)
        self.assertEqual(merged["lteOnlyPresencePct"], 42.0)
        self.assertEqual(merged["nrPresenceSeconds"], 76.0)
        self.assertEqual(merged["lteOnlySeconds"], 55.0)


if __name__ == "__main__":
    unittest.main()

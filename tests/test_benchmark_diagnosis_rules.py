import unittest
from copy import deepcopy
from datetime import datetime, timedelta
from tempfile import NamedTemporaryFile
from unittest import mock

import server


class BenchmarkDiagnosisRulesTests(unittest.TestCase):
    def _benchmark_operator_fixture(self, operator, app_dl_avg, app_dl_samples):
        base = datetime(2026, 5, 8, 8, 40, 0)
        rows = []
        for offset, sample in enumerate(app_dl_samples):
            rows.append(
                {
                    "_dt": base + timedelta(seconds=offset),
                    "time": (base + timedelta(seconds=offset)).isoformat(),
                    "measurementTitle": "DT1",
                    "applicationProtocol": "",
                    "appDlRaw": sample,
                    "appDlMbps": sample,
                }
            )
        rows.append(
            {
                "_dt": base + timedelta(seconds=len(app_dl_samples)),
                "time": (base + timedelta(seconds=len(app_dl_samples))).isoformat(),
                "measurementTitle": "DT1",
                "applicationProtocol": "HTTP",
                "appDlAvgRaw": app_dl_avg,
                "appDlAvgMbps": app_dl_avg,
            }
        )
        transfer_end = base + timedelta(seconds=len(app_dl_samples))
        return {
            "operator": operator,
            "rows": rows,
            "has5g": False,
            "fiveGStatus": "",
            "technologyStatus": {},
            "measurementTitles": ["DT1"],
            "transferSessions": [
                {
                    "direction": "Downlink",
                    "measurementTitle": "DT1",
                    "startTime": base.isoformat(),
                    "endTime": transfer_end.isoformat(),
                }
            ],
        }

    def _detailed_analysis_dataset_fixture(self):
        return {
            "operators": [
                {
                    "operator": "IAM",
                    "measurementTitles": ["DT1"],
                    "rows": [
                        {
                            "time": "08:40:24",
                            "lat": 33.0089,
                            "lon": -7.6231,
                            "servingCellName": "4G_IAM_Settat_1001",
                            "nrPscellName": "5G_IAM_Settat_n28_5001",
                            "macDlBler": 23.0,
                            "sinr": 1.8,
                            "pdschMcs": 7.0,
                            "pdschModulation": "16QAM",
                            "rankIndicator": 1.0,
                            "appDlMbps": 41.0,
                        },
                        {
                            "time": "08:40:25",
                            "lat": 33.0091,
                            "lon": -7.6234,
                            "servingCellName": "4G_IAM_Settat_1001",
                            "nrPscellName": "5G_IAM_Settat_n28_5001",
                            "macDlBler": 12.0,
                            "sinr": 2.3,
                            "pdschMcs": 8.0,
                            "pdschModulation": "16QAM",
                            "rankIndicator": 1.0,
                            "appDlMbps": 47.0,
                        },
                    ],
                    "kpis": {
                        "dl": {"average": 66.2},
                        "rsrp": {"median": -97.6, "p10": -108.0},
                        "rsrq": {"median": -15.1},
                        "sinr": {"median": 2.6, "p10": -1.2},
                        "cqi": {"median": 7.0},
                        "pdschMcs": {"median": 8.0},
                        "nrPresencePct": 58.0,
                        "lteOnlyPresencePct": 42.0,
                        "n78ShareNrOnly": 0.0,
                        "n28ShareNrOnly": 100.0,
                        "nrBandShares": {"n1": 0.0, "n28": 100.0},
                        "pdschModulation": {"qam256Share": 0.0, "qam64Share": 20.0, "qam16Share": 70.0, "qpskShare": 10.0},
                        "ri": {"median": 1.0},
                        "ri1Share": 65.0,
                        "riGe3Share": 0.0,
                        "scellsAvgAll": 0.4,
                        "scellsMax": 1.0,
                        "scellsActiveShare": 18.0,
                        "lteCaActiveShare": 22.0,
                        "bler": {"average": 5.0, "p90": 23.5},
                        "blerAbove10Share": 13.0,
                        "blerAbove20Share": 6.0,
                        "macUlRetx": {"average": 2.4},
                        "pdsch5g": {"average": 11.3},
                        "prbEfficiency": 0.22,
                        "prbUtilPct": {"average": 88.0},
                        "availableBandwidthPrbs": {"average": 51.0},
                        "prbs": {"average": 24.0},
                        "scheduled5g": {"average": 16.0},
                        "lteAnchorSinr": 2.0,
                        "servingCellDistanceM": 1400.0,
                        "endcSetupSuccessRate": 92.0,
                        "endcDropRate": 3.5,
                        "tcpHandshake": {"median": 84.0},
                    },
                },
                {
                    "operator": "Orange",
                    "measurementTitles": ["DT1"],
                    "kpis": {
                        "dl": {"average": 130.0},
                        "rsrp": {"median": -92.0},
                        "rsrq": {"median": -11.0},
                        "sinr": {"median": 11.0},
                        "cqi": {"median": 12.0},
                        "pdschMcs": {"median": 18.0},
                        "nrPresencePct": 72.0,
                        "lteOnlyPresencePct": 28.0,
                        "n78ShareNrOnly": 90.0,
                        "n28ShareNrOnly": 0.0,
                        "nrBandShares": {"n78": 90.0, "n28": 10.0},
                        "pdschModulation": {"qam256Share": 18.0, "qam64Share": 55.0, "qam16Share": 22.0, "qpskShare": 5.0},
                        "ri": {"median": 2.0},
                        "ri1Share": 8.0,
                        "riGe3Share": 12.0,
                        "scellsAvgAll": 1.2,
                        "scellsMax": 3.0,
                        "scellsActiveShare": 68.0,
                        "lteCaActiveShare": 74.0,
                        "bler": {"average": 1.5, "p90": 6.0},
                        "blerAbove10Share": 1.0,
                        "blerAbove20Share": 0.0,
                        "macUlRetx": {"average": 0.4},
                        "pdsch5g": {"average": 82.0},
                        "prbEfficiency": 0.61,
                        "prbUtilPct": {"average": 63.0},
                        "availableBandwidthPrbs": {"average": 106.0},
                        "prbs": {"average": 59.0},
                        "scheduled5g": {"average": 77.0},
                        "lteAnchorSinr": 9.0,
                        "servingCellDistanceM": 420.0,
                        "endcSetupSuccessRate": 98.0,
                        "endcDropRate": 0.5,
                        "tcpHandshake": {"median": 53.0},
                    },
                },
                {
                    "operator": "INWI",
                    "measurementTitles": ["DT1"],
                    "kpis": {
                        "dl": {"average": 101.0},
                        "rsrp": {"median": -94.0},
                        "rsrq": {"median": -12.0},
                        "sinr": {"median": 8.0},
                        "cqi": {"median": 10.0},
                        "pdschMcs": {"median": 15.0},
                        "nrPresencePct": 0.0,
                        "lteOnlyPresencePct": 100.0,
                        "n78ShareNrOnly": 0.0,
                        "n28ShareNrOnly": 0.0,
                        "pdschModulation": {"qam256Share": 7.0, "qam64Share": 44.0, "qam16Share": 40.0, "qpskShare": 9.0},
                        "ri": {"median": 2.0},
                        "ri1Share": 20.0,
                        "riGe3Share": 5.0,
                        "scellsAvgAll": 1.0,
                        "scellsMax": 2.0,
                        "scellsActiveShare": 57.0,
                        "lteCaActiveShare": 61.0,
                        "bler": {"average": 2.4, "p90": 8.0},
                        "blerAbove10Share": 3.0,
                        "blerAbove20Share": 0.0,
                        "macUlRetx": {"average": 0.9},
                        "pdsch5g": {"average": 0.0},
                        "prbEfficiency": 0.48,
                        "prbUtilPct": {"average": 58.0},
                        "availableBandwidthPrbs": {"average": 79.0},
                        "prbs": {"average": 38.0},
                        "scheduled5g": {"average": 0.0},
                        "lteAnchorSinr": 7.0,
                        "servingCellDistanceM": 650.0,
                        "endcSetupSuccessRate": 100.0,
                        "endcDropRate": 0.0,
                        "tcpHandshake": {"median": 60.0},
                    },
                },
            ],
            "transferSummary": [
                {"operator": "IAM", "direction": "DL", "avgCompletionPct": 100.0, "successRate": 100.0},
                {"operator": "Orange", "direction": "DL", "avgCompletionPct": 100.0, "successRate": 100.0},
                {"operator": "INWI", "direction": "DL", "avgCompletionPct": 100.0, "successRate": 100.0},
            ],
            "iamServingCells": {
                "cells": [
                    {
                        "cellName": "4G_IAM_Settat_1001",
                        "tech": "4G",
                        "dwellSecDownload": 19.0,
                        "dwellSec": 28.0,
                        "appSampleCount": 14,
                    },
                    {
                        "cellName": "5G_IAM_Settat_n28_5001",
                        "tech": "5G",
                        "dwellSecDownload": 6.0,
                        "dwellSec": 16.0,
                        "appSampleCount": 2,
                    },
                ],
                "episodesDownload": [
                    {
                        "cellName": "4G_IAM_Settat_1001",
                        "start": "08:40:11",
                        "end": "08:40:24",
                        "dwellSec": 13.0,
                    },
                    {
                        "cellName": "5G_IAM_Settat_n28_5001",
                        "start": "08:40:24",
                        "end": "08:40:30",
                        "dwellSec": 6.0,
                    },
                    {
                        "cellName": "4G_IAM_Settat_1001",
                        "start": "08:40:30",
                        "end": "08:40:36",
                        "dwellSec": 6.0,
                    },
                ],
            },
        }

    def _benchmark_window_scope_operator_fixture(self, operator):
        base = datetime(2026, 5, 8, 8, 40, 0)
        rows = [
            {
                "_dt": base,
                "time": base.isoformat(),
                "measurementTitle": "DT1",
                "applicationProtocol": "",
                "appDlMbps": 10.0,
            },
            {
                "_dt": base + timedelta(seconds=1),
                "time": (base + timedelta(seconds=1)).isoformat(),
                "measurementTitle": "DT1",
                "applicationProtocol": "",
                "dataTransferDirection": "Downlink",
                "transferFilename": "http://example.com/file50m.bin",
                "fileSizeBytes": 200000000.0,
                "bytesDl": 0.0,
                "appDlMbps": 20.0,
            },
            {
                "_dt": base + timedelta(seconds=2),
                "time": (base + timedelta(seconds=2)).isoformat(),
                "measurementTitle": "DT1",
                "applicationProtocol": "",
                "bytesDl": 100000000.0,
                "appDlMbps": 40.0,
            },
            {
                "_dt": base + timedelta(seconds=3),
                "time": (base + timedelta(seconds=3)).isoformat(),
                "measurementTitle": "DT1",
                "applicationProtocol": "",
                "bytesDl": 200000000.0,
                "transferStatus": "Success",
                "appDlMbps": 60.0,
            },
            {
                "_dt": base + timedelta(seconds=4),
                "time": (base + timedelta(seconds=4)).isoformat(),
                "measurementTitle": "DT1",
                "applicationProtocol": "",
                "dataTransferDirection": "Uplink",
                "transferFilename": "http://example.com/upload.bin",
                "fileSizeBytes": 1000.0,
                "bytesUl": 1000.0,
                "transferStatus": "Success",
            },
        ]
        return {
            "operator": operator,
            "rows": rows,
            "has5g": False,
            "fiveGStatus": "",
            "technologyStatus": {},
            "measurementTitles": ["DT1"],
        }

    def test_infer_throughput_scales_keeps_mbps_values(self):
        rows = [
            {"appDlRaw": 107.158, "totalMacDlRaw": 250.0},
            {"appDlRaw": 483.191, "totalMacDlRaw": 510.0},
        ]

        scales = server._nemo_infer_throughput_scales(rows)

        self.assertEqual(scales["appDlMbps"], 1.0)
        self.assertEqual(scales["totalMacDlMbps"], 1.0)

    def test_infer_throughput_scales_converts_bps_values(self):
        rows = [
            {"appDlRaw": 107_158_000.0, "totalMacDlRaw": 250_000_000.0},
            {"appDlRaw": 483_191_000.0, "totalMacDlRaw": 510_000_000.0},
        ]

        scales = server._nemo_infer_throughput_scales(rows)

        self.assertEqual(scales["appDlMbps"], 1_000_000.0)
        self.assertEqual(scales["totalMacDlMbps"], 1_000_000.0)

    def test_reapply_throughput_normalization_repairs_cached_rows(self):
        operator_file = {
            "rows": [
                {"appDlRaw": 107.158, "appDlMbps": 0.0, "totalMacDlRaw": 250.0, "totalMacDlMbps": 0.0},
                {"appDlRaw": 483.191, "appDlMbps": 0.0, "totalMacDlRaw": 510.0, "totalMacDlMbps": 0.001},
            ]
        }

        repaired = server._nemo_reapply_throughput_normalization(operator_file)

        self.assertEqual(repaired["throughputScales"]["appDlMbps"], 1.0)
        self.assertEqual(repaired["rows"][0]["appDlMbps"], 107.158)
        self.assertEqual(repaired["rows"][1]["totalMacDlMbps"], 510.0)

    def test_benchmark_dl_prefers_download_average_rows(self):
        base = datetime(2026, 5, 8, 8, 40, 0)
        rows = [
            {
                "_dt": base,
                "time": base.isoformat(),
                "measurementTitle": "DT1",
                "applicationProtocol": "",
                "appDlMbps": 100.0,
            },
            {
                "_dt": base,
                "time": base.isoformat(),
                "measurementTitle": "DT1",
                "applicationProtocol": "",
                "appDlMbps": 100.0,
            },
            {
                "_dt": base + timedelta(seconds=1),
                "time": (base + timedelta(seconds=1)).isoformat(),
                "measurementTitle": "DT1",
                "applicationProtocol": "",
                "appDlMbps": 300.0,
            },
            {
                "_dt": base + timedelta(seconds=1),
                "time": (base + timedelta(seconds=1)).isoformat(),
                "measurementTitle": "DT1",
                "applicationProtocol": "",
                "appDlMbps": 300.0,
            },
            {
                "_dt": base + timedelta(seconds=2),
                "time": (base + timedelta(seconds=2)).isoformat(),
                "measurementTitle": "DT1",
                "applicationProtocol": "HTTP",
                "appDlAvgMbps": 200.0,
            },
            {
                "_dt": base + timedelta(minutes=1),
                "time": (base + timedelta(minutes=1)).isoformat(),
                "measurementTitle": "DT2",
                "applicationProtocol": "",
                "appDlMbps": 50.0,
            },
            {
                "_dt": base + timedelta(minutes=1),
                "time": (base + timedelta(minutes=1)).isoformat(),
                "measurementTitle": "DT2",
                "applicationProtocol": "",
                "appDlMbps": 50.0,
            },
            {
                "_dt": base + timedelta(minutes=1, seconds=1),
                "time": (base + timedelta(minutes=1, seconds=1)).isoformat(),
                "measurementTitle": "DT2",
                "applicationProtocol": "HTTP",
                "appDlAvgMbps": 50.0,
            },
        ]

        benchmark_key = server._nemo_select_benchmark_dl_metric_key(rows)
        kpis = server._nemo_operator_kpis(
            {
                "rows": rows,
                "benchmarkDlMetricKey": benchmark_key,
            }
        )

        self.assertEqual(benchmark_key, "appDlAvgMbps")
        self.assertEqual(kpis["dl"]["average"], 125.0)

    def test_operator_kpis_use_explicit_test_averages_for_per_dt_average(self):
        base = datetime(2026, 5, 8, 8, 40, 0)
        rows = [
            {
                "_dt": base,
                "time": base.isoformat(),
                "measurementTitle": "DT1",
                "applicationProtocol": "HTTP",
                "appDlAvgMbps": 100.0,
            },
            {
                "_dt": base + timedelta(seconds=1),
                "time": (base + timedelta(seconds=1)).isoformat(),
                "measurementTitle": "DT1",
                "applicationProtocol": "HTTP",
                "appDlAvgMbps": 100.0,
            },
            {
                "_dt": base + timedelta(minutes=1),
                "time": (base + timedelta(minutes=1)).isoformat(),
                "measurementTitle": "DT1",
                "applicationProtocol": "HTTP",
                "appDlAvgMbps": 50.0,
            },
        ]

        kpis = server._nemo_operator_kpis(
            {
                "rows": rows,
                "benchmarkDlMetricKey": "appDlAvgMbps",
                "tests": [
                    {"avgDlMbps": 100.0},
                    {"avgDlMbps": 50.0},
                ],
            }
        )

        self.assertEqual(kpis["dl"]["pooledAverage"], 83.33)
        self.assertEqual(kpis["dl"]["average"], 75.0)
        self.assertEqual(kpis["dl"]["perDtCount"], 2)

    def test_align_benchmark_tests_with_transfer_sessions_relabels_dt_titles(self):
        operator_file = {
            "orderedDtTitles": ["Wrong DT"],
            "tests": [
                {"measurementTitle": "Wrong DT", "avgDlMbps": 99.8},
                {"measurementTitle": "Wrong DT", "avgDlMbps": 369.3},
            ],
            "transferSessions": [
                {"direction": "Uplink", "measurementTitle": "UL should be ignored"},
                {"direction": "Downlink", "measurementTitle": "DT 1"},
                {"direction": "Downlink", "measurementTitle": "DT 2"},
            ],
        }

        aligned = server._nemo_align_benchmark_tests_with_transfer_sessions(operator_file)

        self.assertEqual(aligned["orderedDtTitles"], ["DT 1", "DT 2"])
        self.assertEqual([test["measurementTitle"] for test in aligned["tests"]], ["DT 1", "DT 2"])

    def test_clone_operator_file_for_dt_index_uses_transfer_window_not_forward_filled_title(self):
        base = datetime(2026, 5, 8, 8, 40, 0)
        operator_file = {
            "operator": "IAM",
            "rows": [
                {
                    "_dt": base,
                    "time": base.isoformat(),
                    "measurementTitle": "Wrong DT1",
                    "appDlMbps": 200.0,
                },
                {
                    "_dt": base + timedelta(seconds=1),
                    "time": (base + timedelta(seconds=1)).isoformat(),
                    "measurementTitle": "Wrong DT1",
                    "appDlMbps": 240.0,
                },
                {
                    "_dt": base + timedelta(seconds=1),
                    "time": (base + timedelta(seconds=1)).isoformat(),
                    "measurementTitle": "Wrong DT1",
                    "appDlAvgMbps": 100.0,
                },
                {
                    "_dt": base + timedelta(minutes=5),
                    "time": (base + timedelta(minutes=5)).isoformat(),
                    "measurementTitle": "Wrong DT1",
                    "appDlMbps": 10.0,
                },
                {
                    "_dt": base + timedelta(minutes=5, seconds=1),
                    "time": (base + timedelta(minutes=5, seconds=1)).isoformat(),
                    "measurementTitle": "Wrong DT1",
                    "appDlAvgMbps": 50.0,
                },
            ],
            "transferSessions": [
                {
                    "direction": "Downlink",
                    "measurementTitle": "Real DT1",
                    "startTime": base.isoformat(),
                    "endTime": (base + timedelta(seconds=2)).isoformat(),
                },
                {
                    "direction": "Downlink",
                    "measurementTitle": "Real DT2",
                    "startTime": (base + timedelta(minutes=5)).isoformat(),
                    "endTime": (base + timedelta(minutes=5, seconds=2)).isoformat(),
                },
            ],
        }

        clone = server._nemo_clone_operator_file_for_dt_index(operator_file, 0)

        self.assertEqual(clone["measurementTitles"], ["Real DT1"])
        self.assertEqual(clone["orderedDtTitles"], ["Real DT1"])
        self.assertEqual(len(clone["rows"]), 3)
        self.assertEqual(clone["_dlMetricKeyOverride"], "appDlMbps")
        self.assertEqual(clone["_benchmarkDlMetricKeyOverride"], "appDlMbps")

        series = server._nemo_metric_series(clone["rows"], "appDlMbps")
        self.assertEqual(series, [200.0, 240.0])
        self.assertEqual(sum(series) / len(series), 220.0)

    def test_nemo_build_tests_accepts_explicit_metric_override(self):
        base = datetime(2026, 5, 8, 8, 40, 0)
        rows = [
            {
                "_dt": base,
                "time": base.isoformat(),
                "measurementTitle": "DT1",
                "applicationProtocol": "",
                "appDlMbps": 200.0,
            },
            {
                "_dt": base + timedelta(seconds=1),
                "time": (base + timedelta(seconds=1)).isoformat(),
                "measurementTitle": "DT1",
                "applicationProtocol": "",
                "appDlMbps": 240.0,
            },
            {
                "_dt": base + timedelta(seconds=1),
                "time": (base + timedelta(seconds=1)).isoformat(),
                "measurementTitle": "DT1",
                "applicationProtocol": "HTTP",
                "appDlAvgMbps": 100.0,
            },
        ]

        tests = server._nemo_build_tests(rows, "IAM", "appDlMbps")

        self.assertEqual(len(tests), 1)
        self.assertEqual(tests[0]["avgDlMbps"], 220.0)

    def test_operator_kpis_expose_app_rate_dl_column_average(self):
        base = datetime(2026, 5, 8, 8, 40, 0)
        rows = [
            {
                "_dt": base,
                "time": base.isoformat(),
                "measurementTitle": "DT1",
                "applicationProtocol": "",
                "appDlMbps": 200.0,
            },
            {
                "_dt": base + timedelta(seconds=1),
                "time": (base + timedelta(seconds=1)).isoformat(),
                "measurementTitle": "DT1",
                "applicationProtocol": "",
                "appDlMbps": 240.0,
            },
            {
                "_dt": base + timedelta(seconds=2),
                "time": (base + timedelta(seconds=2)).isoformat(),
                "measurementTitle": "DT2",
                "applicationProtocol": "",
                "appDlMbps": 0.0,
            },
            {
                "_dt": base + timedelta(minutes=5, seconds=1),
                "time": (base + timedelta(minutes=5, seconds=1)).isoformat(),
                "measurementTitle": "DT2",
                "applicationProtocol": "",
                "appDlMbps": 140.0,
            },
        ]

        kpis = server._nemo_operator_kpis(
            {
                "rows": rows,
                "tests": [],
            }
        )

        self.assertEqual(kpis["appDl"]["average"], 145.0)
        self.assertEqual(kpis["appDl"]["median"], 170.0)
        self.assertEqual(kpis["appDl"]["sampleCount"], 4)

    def test_operator_kpis_compute_prb_util_and_bler_above20_share(self):
        operator_file = {
            "operator": "IAM",
            "rows": [
                {"pdschPrbs": 25.0, "bandwidthPrbs": 50.0, "macDlBler": 5.0},
                {"pdschPrbs": 40.0, "bandwidthPrbs": 50.0, "macDlBler": 25.0},
                {"pdschPrbs": 0.0, "bandwidthPrbs": 0.0, "macDlBler": 30.0},
            ],
        }

        kpis = server._nemo_operator_kpis(operator_file)

        self.assertAlmostEqual(kpis["prbUtilPct"]["average"], 65.0, places=1)
        self.assertAlmostEqual(kpis["blerAbove20Share"], 66.7, places=1)

    def test_operator_kpis_compute_state_and_technology_shares(self):
        operator_file = {
            "operator": "IAM",
            "rows": [
                {
                    "rrcState": "Connected",
                    "applicationProtocol": "HTTP",
                    "servingTechnology": "EN-DC",
                    "packetTechnology": "EN-DC",
                },
                {
                    "rrcState": "Connected",
                    "applicationProtocol": "HTTP",
                    "servingTechnology": "LTE FDD",
                    "packetTechnology": "LTE FDD",
                },
                {
                    "rrcState": "Idle",
                    "applicationProtocol": "FTP",
                    "servingTechnology": "LTE FDD",
                    "packetTechnology": "LTE FDD",
                },
            ],
        }

        kpis = server._nemo_operator_kpis(operator_file)

        self.assertEqual(kpis["rrcStateShares"]["Connected"], 66.7)
        self.assertEqual(kpis["applicationProtocolShares"]["HTTP"], 66.7)
        self.assertEqual(kpis["servingTechnologyShares"]["LTE FDD"], 66.7)
        self.assertEqual(kpis["packetTechnologyShares"]["LTE FDD"], 66.7)

    def test_deep_build_detailed_analysis_returns_expected_domains(self):
        dataset = self._detailed_analysis_dataset_fixture()
        deep = server._ensure_deep_benchmark(dataset)
        detailed = (deep.get("deepBenchmark") or {}).get("detailedAnalysis") or []

        domains = [block["domain"] for block in detailed]

        self.assertIn("Throughput delivery chain", domains)
        self.assertIn("5G / EN-DC capacity layer", domains)
        self.assertIn("RF quality", domains)
        self.assertIn("BLER / retransmissions", domains)

    def test_detailed_analysis_block_contains_metrics_evidence_explanation_and_actions(self):
        dataset = self._detailed_analysis_dataset_fixture()
        deep = server._ensure_deep_benchmark(dataset)
        block = next(
            item for item in (deep.get("deepBenchmark") or {}).get("detailedAnalysis", [])
            if item.get("domain") == "BLER / retransmissions"
        )

        self.assertIn(block["severity"], ("Critical", "High", "Medium", "Low", "OK"))
        self.assertTrue(block["metrics"])
        self.assertTrue(block["evidence"])
        self.assertIn("explanation", block)
        self.assertIn("targetedActions", block)

    def test_detailed_analysis_bler_block_carries_localized_evidence_rows(self):
        dataset = self._detailed_analysis_dataset_fixture()
        deep = server._ensure_deep_benchmark(dataset)
        block = next(
            item for item in (deep.get("deepBenchmark") or {}).get("detailedAnalysis", [])
            if item.get("domain") == "BLER / retransmissions"
        )

        self.assertTrue(
            any(
                isinstance(item, dict) and item.get("type") == "table"
                for item in block["evidence"]
            )
        )

    def test_detailed_analysis_capacity_block_mentions_band_exposure(self):
        dataset = self._detailed_analysis_dataset_fixture()
        deep = server._ensure_deep_benchmark(dataset)
        block = next(
            item for item in (deep.get("deepBenchmark") or {}).get("detailedAnalysis", [])
            if item.get("domain") == "5G / EN-DC capacity layer"
        )

        self.assertTrue(
            any(
                isinstance(item, dict)
                and "n78" in str(item).lower()
                for item in block["evidence"]
            )
        )

    def test_deep_findings_flag_coverage_and_quality_limitation(self):
        iam = {
            "dlThroughput": 40.0,
            "rsrp": -108.0,
            "rsrq": -15.5,
            "sinr": 2.5,
            "cqi": 6.0,
            "mcs": 5.0,
            "fivegPresence": 55.0,
            "fourgOnly": 45.0,
        }
        competitors = [{"_operator": "Orange", "dlThroughput": 120.0, "sinr": 12.0}]

        findings = server._benchmark_deep_findings(iam, competitors)

        coverage = next((item for item in findings if item.get("domain") == "Coverage / dominance"), None)
        self.assertIsNotNone(coverage)
        self.assertEqual(coverage["severity"], "Critical")
        self.assertIn("Coverage and quality limitation", coverage["finding"])

    def test_deep_findings_flag_good_coverage_but_poor_quality(self):
        iam = {
            "dlThroughput": 55.0,
            "rsrp": -92.0,
            "rsrq": -13.5,
            "sinr": 3.0,
            "cqi": 8.0,
            "mcs": 8.0,
            "fivegPresence": 30.0,
            "fourgOnly": 70.0,
        }
        competitors = [{"_operator": "Orange", "dlThroughput": 100.0, "sinr": 11.0}]

        findings = server._benchmark_deep_findings(iam, competitors)

        quality = next(
            (
                item
                for item in findings
                if item.get("domain") == "Radio quality / interference"
                and "Good coverage but poor quality" in str(item.get("finding") or "")
            ),
            None,
        )
        self.assertIsNotNone(quality)
        self.assertEqual(quality["severity"], "High")

    def test_deep_findings_flag_bandwidth_anchor_and_endc_issues(self):
        iam = {
            "dlThroughput": 70.0,
            "sinr": 12.0,
            "rsrp": -96.0,
            "fivegPresence": 60.0,
            "lteAnchorSinr": 2.0,
            "availableBandwidthPrbs": 51.0,
            "endcSetupSuccessRate": 92.0,
            "endcDropRate": 3.5,
        }
        competitors = [
            {
                "_operator": "Orange",
                "dlThroughput": 130.0,
                "availableBandwidthPrbs": 106.0,
            }
        ]

        findings = server._benchmark_deep_findings(iam, competitors)
        domains = {item.get("domain") for item in findings}

        self.assertIn("Bandwidth / spectrum", domains)
        self.assertIn("LTE anchor / NSA dependency", domains)
        self.assertIn("EN-DC stability", domains)

    def test_nemo_value_normalization_fixes_suspicious_scientific_notation(self):
        lon, lon_changed = server._nemo_normalize_value(-7.6329808235168496e16, "longitude")
        lat, lat_changed = server._nemo_normalize_value(3.30088653564452e16, "latitude")
        rsrp, rsrp_changed = server._nemo_normalize_value(-7.7099998474120992e16, "rsrp")

        self.assertTrue(lon_changed)
        self.assertTrue(lat_changed)
        self.assertTrue(rsrp_changed)
        self.assertAlmostEqual(lon, -7.6329808235, places=6)
        self.assertAlmostEqual(lat, 33.0088653564, places=6)
        self.assertAlmostEqual(rsrp, -77.0999984741, places=6)

    def test_deep_findings_for_settat_profile_focus_on_missing_n78_not_mimo(self):
        iam = {
            "dlThroughput": 99.8,
            "sinr": 13.2,
            "rsrp": -75.4,
            "fivegPresence": 77.7,
            "fourgOnly": 22.3,
            "n78": 0.0,
            "n1": 100.0,
            "availableBandwidthPrbs": 79.0,
            "scellsAvg": 1.1,
            "caActive": 56.8,
            "medianRank": 2.0,
            "ri1": 0.0,
            "ri2": 100.0,
            "riGe3": 0.0,
            "pdschDlAvg": 5.4,
            "blerAvg": 5.0,
            "blerP90": 23.5,
            "blerAbove10": 13.0,
            "tcpHandshake": 84.0,
        }
        competitors = [
            {
                "_operator": "INWI",
                "dlThroughput": 216.7,
                "n78": 100.0,
                "availableBandwidthPrbs": 273.0,
                "ri2": 100.0,
            }
        ]

        findings = server._benchmark_deep_findings(iam, competitors)

        mimo_finding = next((item for item in findings if item.get("domain") == "MIMO / RI"), None)
        self.assertIsNone(mimo_finding)

        headline = next(
            item
            for item in findings
            if item.get("domain") == "5G capacity layer" and item.get("kpi") == "DL Throughput"
        )
        self.assertFalse(
            any("MIMO" in action for action in (headline.get("recommendedActions") or []))
        )

        capacity = next(
            item
            for item in findings
            if item.get("domain") == "5G capacity layer" and item.get("kpi") == "NR n78 share"
        )
        self.assertIn("NR n1", capacity.get("finding") or "")

        bandwidth = next((item for item in findings if item.get("domain") == "Bandwidth / spectrum"), None)
        self.assertIsNotNone(bandwidth)
        self.assertIn("LTE CA", bandwidth.get("finding") or "")
        self.assertIn("missing n78", (bandwidth.get("rootCause") or "").lower())

    def test_deep_findings_flag_localized_bler_peaks(self):
        iam = {
            "dlThroughput": 99.8,
            "blerAvg": 5.0,
            "blerP90": 23.5,
            "blerAbove10": 13.0,
        }
        competitors = [{"_operator": "Orange", "dlThroughput": 150.0, "blerAvg": 1.2}]

        findings = server._benchmark_deep_findings(iam, competitors)

        bler = next((item for item in findings if item.get("domain") == "BLER / retransmissions"), None)
        self.assertIsNotNone(bler)
        self.assertIn("localized", (bler.get("finding") or "").lower())
        self.assertTrue(
            any("Map BLER>10% samples" in action for action in (bler.get("recommendedActions") or []))
        )

    def test_deep_findings_flag_overshooting_when_distance_is_far(self):
        iam = {
            "dlThroughput": 52.0,
            "rsrp": -102.0,
            "sinr": 7.0,
            "servingCellDistanceM": 1800.0,
        }
        competitors = [{"_operator": "Orange", "dlThroughput": 90.0, "rsrp": -97.0}]

        findings = server._benchmark_deep_findings(iam, competitors)

        coverage = next((item for item in findings if item.get("domain") == "Coverage / dominance"), None)
        self.assertIsNotNone(coverage)
        self.assertIn("overshooting or a missing dominant sector", coverage["finding"])

    def test_deep_findings_flag_load_congestion_when_prb_util_is_high(self):
        iam = {
            "dlThroughput": 68.0,
            "sinr": 14.0,
            "rsrp": -93.0,
            "prbUtilPct": 91.0,
        }
        competitors = [{"_operator": "Orange", "dlThroughput": 130.0, "prbUtilPct": 62.0}]

        findings = server._benchmark_deep_findings(iam, competitors)

        congestion = next((item for item in findings if item.get("domain") == "Load / congestion"), None)
        self.assertIsNotNone(congestion)
        self.assertEqual(congestion["severity"], "Critical")
        self.assertIn("Severe DL congestion", congestion["finding"])

    def test_deep_findings_consolidate_radio_quality_signals(self):
        iam = {
            "dlThroughput": 40.0,
            "rsrp": -92.0,
            "rsrq": -16.0,
            "sinr": 2.0,
            "cqi": 6.0,
            "mcs": 5.0,
            "qam256": 0.0,
            "qam16": 70.0,
        }
        competitors = [{"_operator": "Orange", "dlThroughput": 100.0, "rsrq": -10.0, "sinr": 12.0, "cqi": 11.0}]

        findings = server._benchmark_deep_findings(iam, competitors)
        radio_quality = [
            item
            for item in findings
            if item.get("domain") in ("Radio quality / interference", "SINR / interference", "Modulation profile")
        ]

        self.assertEqual(len(radio_quality), 1)
        self.assertIn("SINR", radio_quality[0]["finding"])
        self.assertIn("CQI", radio_quality[0]["finding"])
        self.assertTrue(radio_quality[0].get("supportingEvidence"))

    def test_deep_make_finding_contains_benchmark_relevance_and_confidence(self):
        finding = server._deep_make_finding(
            "Capacity / configuration",
            "DL throughput vs radio quality",
            40.0,
            100.0,
            "High",
            "Throughput is low despite good radio quality.",
            "Scheduler/configuration limitation.",
            ["Check scheduler."],
            confidence="Benchmark evidence",
            gap_pct=-0.60,
        )

        self.assertEqual(finding["benchmarkRelevance"], "Primary")
        self.assertEqual(finding["confidence"], "Medium")

    def test_deep_action_validation_marks_confirmed_support_and_txt_context(self):
        deep = {
            "actionPlan": [
                {
                    "domain": "5G capacity layer",
                    "severity": "Critical",
                    "confidence": "High",
                    "benchmarkRelevance": "Primary",
                    "finding": "IAM 5G presence is high but n78 share is missing.",
                    "recommendedActions": [
                        "Audit n78 availability and EN-DC configuration.",
                    ],
                }
            ]
        }
        operators_payload = [
            {
                "operator": "IAM",
                "kpis": {
                    "dl": {"average": 66.2},
                    "nrPresencePct": 58.0,
                    "lteOnlyPresencePct": 42.0,
                    "n78ShareNrOnly": 0.0,
                    "n28ShareNrOnly": 100.0,
                    "pdsch5g": {"average": 11.3},
                },
            }
        ]
        serving_cells = {
            "cells": [
                {"cellName": "5G_KEN_SidiTaibiForetII_510124311", "dwellSecDownload": 25},
                {"cellName": "4G_RAB_CHF_Rabat_Kenitra3_1008903", "dwellSecDownload": 23},
            ],
            "episodesDownload": [
                {"cellName": "5G_KEN_SidiTaibiForetII_510124311", "start": "14:39:29", "end": "14:39:53", "dwellSec": 25},
            ],
        }

        enriched = server._deep_enrich_action_plan_with_current_data(
            deep,
            operators_payload,
            serving_cells,
            [],
        )

        row = enriched["actionPlan"][0]
        self.assertEqual(row["validationStatus"], "Confirmed")
        self.assertTrue(any("NR n78 share" in item for item in row["evidenceMetrics"]))
        self.assertTrue(row["supportingCells"])
        self.assertTrue(row["supportingSegments"])

    def test_deep_action_validation_marks_external_checks_as_hypothesis(self):
        deep = {
            "actionPlan": [
                {
                    "domain": "EN-DC stability",
                    "severity": "High",
                    "confidence": "High",
                    "benchmarkRelevance": "Secondary",
                    "finding": "EN-DC setup success is low and LTE anchor quality is weak.",
                    "recommendedActions": [
                        "Check LTE anchor coverage.",
                        "Check X2/Xn interface.",
                    ],
                }
            ]
        }
        operators_payload = [
            {
                "operator": "IAM",
                "kpis": {
                    "nrPresencePct": 60.0,
                    "lteAnchorSinr": 2.0,
                    "endcSetupSuccessRate": 92.0,
                    "endcDropRate": 3.5,
                },
            }
        ]

        enriched = server._deep_enrich_action_plan_with_current_data(
            deep,
            operators_payload,
            None,
            [],
        )

        row = enriched["actionPlan"][0]
        details = {item["text"]: item["status"] for item in row["recommendedActionsDetailed"]}
        self.assertEqual(details["Check LTE anchor coverage."], "Confirmed")
        self.assertEqual(details["Check X2/Xn interface."], "Hypothesis")

    def test_deep_action_validation_adds_confirmed_summary_with_evidence(self):
        deep = {
            "actionPlan": [
                {
                    "domain": "5G capacity layer",
                    "severity": "High",
                    "confidence": "High",
                    "benchmarkRelevance": "Primary",
                    "finding": "IAM 5G is present but n78 is absent, so the benchmark confirms a missing high-capacity NR layer.",
                    "recommendedActions": [
                        "Audit n78 availability and EN-DC configuration.",
                    ],
                }
            ]
        }
        operators_payload = [
            {
                "operator": "IAM",
                "kpis": {
                    "dl": {"average": 66.2},
                    "nrPresencePct": 58.0,
                    "lteOnlyPresencePct": 42.0,
                    "n78ShareNrOnly": 0.0,
                    "n28ShareNrOnly": 100.0,
                    "pdsch5g": {"average": 11.3},
                },
            }
        ]

        enriched = server._deep_enrich_action_plan_with_current_data(
            deep,
            operators_payload,
            None,
            [],
        )

        row = enriched["actionPlan"][0]
        self.assertIn("Confirmed", row["validationSummary"])
        self.assertIn("5G capacity layer", row["validationSummary"])
        self.assertIn("NR n78 share", row["validationEvidenceSummary"])

    def test_deep_action_validation_adds_partial_summary_with_evidence(self):
        deep = {
            "actionPlan": [
                {
                    "domain": "Bandwidth / spectrum",
                    "severity": "Medium",
                    "confidence": "Medium",
                    "benchmarkRelevance": "Secondary",
                    "finding": "IAM bandwidth looks constrained versus the benchmark leaders.",
                    "recommendedActions": [
                        "Check available LTE/NR bandwidth.",
                    ],
                }
            ]
        }
        operators_payload = [
            {
                "operator": "IAM",
                "kpis": {
                    "availableBandwidthPrbs": {"average": 51.0},
                    "avgScellsConfigured": 0.3,
                    "n78ShareNrOnly": 0.0,
                },
            }
        ]

        enriched = server._deep_enrich_action_plan_with_current_data(
            deep,
            operators_payload,
            None,
            [],
        )

        row = enriched["actionPlan"][0]
        self.assertIn("Partial", row["validationSummary"])
        self.assertIn("needs deeper network-side confirmation", row["validationSummary"])
        self.assertIn("Available bandwidth", row["validationEvidenceSummary"])

    def test_deep_action_validation_adds_download_window_lte_dominated_row(self):
        deep = {"actionPlan": []}
        operators_payload = [
            {
                "operator": "IAM",
                "kpis": {
                    "nrPresencePct": 77.7,
                    "lteOnlyPresencePct": 22.3,
                },
            }
        ]
        serving_cells = {
            "cells": [
                {"cellName": "4G_SettatCPR2", "dwellSecDownload": 15.0},
                {"cellName": "5G_SettatCPR5", "dwellSecDownload": 0.6},
            ],
            "episodesDownload": [
                {"cellName": "4G_SettatCPR2", "start": "08:40:11", "end": "08:40:24", "dwellSec": 13.7},
                {"cellName": "5G_SettatCPR5", "start": "08:40:24", "end": "08:40:25", "dwellSec": 0.6},
                {"cellName": "4G_SettatCPR2", "start": "08:40:25", "end": "08:40:26", "dwellSec": 0.7},
            ],
        }

        enriched = server._deep_enrich_action_plan_with_current_data(
            deep,
            operators_payload,
            serving_cells,
            [],
        )

        row = next(
            (item for item in (enriched.get("actionPlan") or []) if item.get("domain") == "Mobility / serving sequence"),
            None,
        )
        self.assertIsNotNone(row)
        self.assertEqual(row["validationStatus"], "Confirmed")
        self.assertIn("not effectively carried by 5G", row.get("finding") or "")
        self.assertIn("LTE-dominated", row.get("validationSummary") or "")

    def test_deep_action_validation_rebalances_settat_like_priorities(self):
        deep = {
            "actionPlan": [
                {
                    "priority": "P1",
                    "priorityScore": 12,
                    "severity": "Critical",
                    "domain": "5G capacity layer",
                    "confidence": "High",
                    "benchmarkRelevance": "Primary",
                    "finding": "IAM DL throughput is low despite good accessibility.",
                    "recommendedActions": [
                        "Audit n78 availability and EN-DC configuration.",
                    ],
                },
                {
                    "priority": "P1",
                    "priorityScore": 12,
                    "severity": "Critical",
                    "domain": "5G capacity layer",
                    "confidence": "Medium",
                    "benchmarkRelevance": "Primary",
                    "finding": "IAM 5G is present but n78 is missing.",
                    "recommendedActions": [
                        "Audit n78 deployment and eligibility along the tested route.",
                    ],
                },
                {
                    "priority": "P1",
                    "priorityScore": 11,
                    "severity": "High",
                    "domain": "BLER / retransmissions",
                    "confidence": "Medium",
                    "benchmarkRelevance": "Secondary",
                    "finding": "Localized high-BLER peaks.",
                    "recommendedActions": [
                        "Map BLER>10% samples by GPS/time/serving cell.",
                    ],
                },
                {
                    "priority": "P1",
                    "priorityScore": 11,
                    "severity": "High",
                    "domain": "Bandwidth / spectrum",
                    "confidence": "Medium",
                    "benchmarkRelevance": "Secondary",
                    "finding": "n1 + LTE CA but missing n78 capacity.",
                    "recommendedActions": [
                        "Check available LTE/NR bandwidth.",
                    ],
                },
                {
                    "priority": "P1",
                    "priorityScore": 11,
                    "severity": "High",
                    "domain": "Scheduler / PRB efficiency",
                    "confidence": "Low",
                    "benchmarkRelevance": "Secondary",
                    "finding": "Scheduler issue remains a hypothesis.",
                    "recommendedActions": [
                        "Review scheduler weights and proportional-fair / QoS configuration.",
                    ],
                },
                {
                    "priority": "P2",
                    "priorityScore": 8,
                    "severity": "Medium",
                    "domain": "Transport / core",
                    "confidence": "Medium",
                    "benchmarkRelevance": "Context",
                    "finding": "TCP handshake is slower than benchmark.",
                    "recommendedActions": [
                        "Retest with a controlled server to exclude test-tool artifact.",
                    ],
                },
                {
                    "priority": "P3",
                    "priorityScore": 6,
                    "severity": "Low",
                    "domain": "Retest governance",
                    "confidence": "Low",
                    "benchmarkRelevance": "Context",
                    "finding": "Repeat in busy hour and off-peak.",
                    "recommendedActions": [
                        "Repeat the same route in busy hour and off-peak with the same UE, SIM plan and server.",
                    ],
                },
            ]
        }
        operators_payload = [
            {
                "operator": "IAM",
                "kpis": {
                    "nrPresencePct": 77.7,
                    "lteOnlyPresencePct": 22.3,
                    "n78ShareNrOnly": 0.0,
                    "pdsch5g": {"average": 5.4},
                    "availableBandwidthPrbs": {"average": 79.0},
                    "nrBandShares": {"n1": 100.0},
                    "bler": {"average": 5.0, "p90": 23.5},
                    "blerAbove10Share": 13.0,
                    "tcpHandshake": {"median": 84.0},
                },
            }
        ]
        serving_cells = {
            "cells": [
                {"cellName": "4G_SettatCPR2", "tech": "4G", "dwellSecDownload": 15.0, "appSampleCount": 14},
                {"cellName": "5G_SettatCPR5", "tech": "5G", "dwellSecDownload": 83.0, "appSampleCount": 0},
            ],
            "episodesDownload": [
                {"cellName": "4G_SettatCPR2", "start": "08:40:11", "end": "08:40:24", "dwellSec": 13.7},
                {"cellName": "5G_SettatCPR5", "start": "08:40:24", "end": "08:40:25", "dwellSec": 0.6},
                {"cellName": "4G_SettatCPR2", "start": "08:40:25", "end": "08:40:26", "dwellSec": 0.7},
                {"cellName": "5G_SettatCPR5", "start": "08:40:26", "end": "08:41:48", "dwellSec": 82.0},
            ],
        }

        enriched = server._deep_enrich_action_plan_with_current_data(
            deep,
            operators_payload,
            serving_cells,
            [],
        )

        rows = {row["domain"]: row for row in enriched["actionPlan"]}
        self.assertEqual(rows["Mobility / serving sequence"]["priority"], "P1")
        fiveg_rows = [row for row in enriched["actionPlan"] if row.get("domain") == "5G capacity layer"]
        self.assertEqual(len(fiveg_rows), 1)
        self.assertEqual(sum(1 for row in fiveg_rows if row.get("priority") == "P1"), 1)
        self.assertFalse(any(row.get("domain") == "Bandwidth / spectrum" for row in enriched["actionPlan"]))
        self.assertEqual(rows["BLER / retransmissions"]["priority"], "P2")
        self.assertEqual(rows["Scheduler / PRB efficiency"]["priority"], "P3")
        self.assertEqual(rows["Transport / core"]["priority"], "P2")
        self.assertEqual(rows["Retest governance"]["priority"], "P3")

    def test_deep_action_plan_merges_duplicate_5g_capacity_rows(self):
        deep = {
            "actionPlan": [
                {
                    "priority": "P1",
                    "priorityScore": 12,
                    "severity": "Critical",
                    "domain": "5G capacity layer",
                    "confidence": "High",
                    "benchmarkRelevance": "Primary",
                    "finding": "IAM DL throughput is low despite good accessibility.",
                    "recommendedActions": ["Audit n78 availability and EN-DC configuration."],
                    "subCauses": ["Lead row cause"],
                },
                {
                    "priority": "P1",
                    "priorityScore": 12,
                    "severity": "Critical",
                    "domain": "5G capacity layer",
                    "confidence": "Medium",
                    "benchmarkRelevance": "Primary",
                    "finding": "IAM 5G is present but n78 is missing.",
                    "recommendedActions": [
                        "Audit n78 deployment and eligibility along the tested route.",
                        "Check available LTE/NR bandwidth.",
                    ],
                    "subCauses": ["Secondary 5G cause"],
                },
                {
                    "priority": "P2",
                    "priorityScore": 8,
                    "severity": "High",
                    "domain": "Bandwidth / spectrum",
                    "confidence": "Medium",
                    "benchmarkRelevance": "Secondary",
                    "finding": "NR is mainly n1 and lacks n78 capacity.",
                    "recommendedActions": ["Check available LTE/NR bandwidth."],
                    "subCauses": ["Bandwidth-specific cause"],
                },
            ]
        }
        operators_payload = [{"operator": "IAM", "kpis": {"nrPresencePct": 77.7, "lteOnlyPresencePct": 22.3, "n78ShareNrOnly": 0.0, "nrBandShares": {"n1": 100.0}}}]
        serving_cells = {
            "episodesDownload": [
                {"cellName": "4G_A", "start": "08:40:11", "end": "08:40:24", "dwellSec": 13.7},
                {"cellName": "5G_B", "start": "08:40:24", "end": "08:40:25", "dwellSec": 0.6},
                {"cellName": "4G_A", "start": "08:40:25", "end": "08:40:26", "dwellSec": 0.7},
            ]
        }

        enriched = server._deep_enrich_action_plan_with_current_data(deep, operators_payload, serving_cells, [])
        fiveg_rows = [row for row in enriched["actionPlan"] if row.get("domain") == "5G capacity layer"]
        bandwidth_rows = [row for row in enriched["actionPlan"] if row.get("domain") == "Bandwidth / spectrum"]

        self.assertEqual(len(fiveg_rows), 1)
        self.assertEqual(len(bandwidth_rows), 0)
        self.assertEqual(
            fiveg_rows[0]["finding"],
            "IAM DL throughput is low despite good accessibility.",
        )
        self.assertIn("subCauses", fiveg_rows[0])
        self.assertCountEqual(
            fiveg_rows[0]["mergedDomains"],
            ["5G capacity layer", "Bandwidth / spectrum"],
        )
        self.assertEqual(
            fiveg_rows[0]["recommendedActions"].count("Check available LTE/NR bandwidth."),
            1,
        )
        self.assertIn("NR n78 share", " ".join(fiveg_rows[0]["subCauses"]))
        self.assertIn("Lead row cause", fiveg_rows[0]["subCauses"])
        self.assertIn("Secondary 5G cause", fiveg_rows[0]["subCauses"])
        self.assertIn("Bandwidth-specific cause", fiveg_rows[0]["subCauses"])

    def test_deep_action_plan_suppresses_mimo_action_when_rank_is_ok(self):
        iam = {
            "dlThroughput": 99.8,
            "fivegPresence": 77.7,
            "fourgOnly": 22.3,
            "n78": 0.0,
            "n1": 100.0,
            "medianRank": 2.0,
            "ri1": 0.0,
            "ri2": 87.0,
        }
        competitors = [{"_operator": "Orange", "dlThroughput": 216.7, "n78": 92.0, "ri2": 82.0}]

        findings = server._benchmark_deep_findings(iam, competitors)

        self.assertFalse(any(f.get("domain") == "MIMO / RI" for f in findings))
        fiveg_capacity = next(
            item for item in findings if item.get("domain") == "5G capacity layer"
        )
        self.assertNotIn(
            "Check MIMO rank limitation and improve SINR/CQI through RF optimization.",
            fiveg_capacity.get("recommendedActions") or [],
        )

    def test_deep_capacity_row_exposes_subcauses_and_excluded_checks(self):
        deep = {
            "actionPlan": [
                {
                    "priority": "P1",
                    "priorityScore": 12,
                    "severity": "Critical",
                    "domain": "5G capacity layer",
                    "confidence": "High",
                    "benchmarkRelevance": "Primary",
                    "finding": "Active DL session is not effectively carried by 5G.",
                    "recommendedActions": ["Analyze EN-DC addition/release during active DL transfer."],
                }
            ]
        }
        operators_payload = [{
            "operator": "IAM",
            "kpis": {
                "n78ShareNrOnly": 0.0,
                "nrBandShares": {"n1": 100.0},
                "nrPresencePct": 77.7,
                "lteOnlyPresencePct": 22.3,
                "rankIndicator": {"median": 2.0},
                "ri1Share": 0.0,
                "ri2Share": 87.0,
            },
        }]
        serving_cells = {
            "episodesDownload": [
                {"cellName": "4G_A", "start": "08:40:11", "end": "08:40:24", "dwellSec": 13.7},
                {"cellName": "5G_B", "start": "08:40:24", "end": "08:40:25", "dwellSec": 0.6},
                {"cellName": "4G_A", "start": "08:40:25", "end": "08:40:26", "dwellSec": 0.7},
            ]
        }

        enriched = server._deep_enrich_action_plan_with_current_data(deep, operators_payload, serving_cells, [])
        row = next(item for item in enriched["actionPlan"] if item.get("domain") == "5G capacity layer")

        self.assertIn("subCauses", row)
        self.assertIn("excludedChecks", row)
        self.assertTrue(any("MIMO rank is acceptable" in item for item in row["excludedChecks"]))

    def test_deep_action_plan_downgrades_scheduler_when_only_hypothesis(self):
        deep = {
            "actionPlan": [
                {
                    "priority": "P2",
                    "priorityScore": 8,
                    "severity": "High",
                    "domain": "Scheduler / PRB efficiency",
                    "confidence": "Low",
                    "benchmarkRelevance": "Secondary",
                    "finding": "Low PRB efficiency suspected.",
                    "recommendedActions": ["Review scheduler weights and proportional-fair / QoS configuration."],
                }
            ]
        }
        operators_payload = [{"operator": "IAM", "kpis": {"pdsch5g": {"average": 5.4}}}]

        enriched = server._deep_enrich_action_plan_with_current_data(deep, operators_payload, None, [])

        self.assertEqual(enriched["actionPlan"][0]["priority"], "P3")
        self.assertEqual(enriched["actionPlan"][0]["validationStatus"], "Hypothesis")

    def test_nemo_build_diagnosis_uses_rsrq_and_quality_rules(self):
        operators = [
            {
                "operator": "IAM",
                "has5g": True,
                "kpis": {
                    "dl": {"average": 60.0},
                    "rsrp": {"median": -93.0, "p10": -101.0},
                    "rsrq": {"median": -15.2},
                    "sinr": {"median": 3.0, "p10": -1.0},
                    "pdsch5g": {"average": 50.0},
                    "availableBandwidthPrbs": {"average": 51.0},
                },
                "rows": [],
            },
            {
                "operator": "Orange",
                "has5g": True,
                "kpis": {
                    "dl": {"average": 120.0},
                    "rsrp": {"median": -98.0},
                    "rsrq": {"median": -11.0},
                    "sinr": {"median": 12.0},
                    "pdsch5g": {"average": 110.0},
                    "availableBandwidthPrbs": {"average": 106.0},
                },
                "rows": [],
            },
        ]
        ranking = [
            {"operator": "Orange", "avgDlMbps": 120.0, "has5g": True, "rank": 1},
            {"operator": "IAM", "avgDlMbps": 60.0, "has5g": True, "rank": 2},
        ]

        diagnosis = server._nemo_build_diagnosis(operators, ranking)

        self.assertEqual(diagnosis["mainCause"], "Radio quality / interference")
        evidence_blob = " ".join(diagnosis.get("evidence") or [])
        self.assertIn("RSRQ", evidence_blob)
        self.assertIn("acceptable coverage but weak SINR", evidence_blob)

    def test_benchmark_dataset_switches_canonical_dl_metric_by_mode(self):
        operator_files = [
            self._benchmark_operator_fixture("IAM", app_dl_avg=50.0, app_dl_samples=[200.0, 100.0]),
            self._benchmark_operator_fixture("Orange", app_dl_avg=80.0, app_dl_samples=[120.0, 120.0]),
        ]

        avg_mode = server._benchmark_nemo_build_dataset(
            deepcopy(operator_files),
            dl_mode="app_rate_dl_avg",
        )
        app_mode = server._benchmark_nemo_build_dataset(
            deepcopy(operator_files),
            dl_mode="app_rate_dl",
        )

        avg_ranking = {row["operator"]: row["avgDlMbps"] for row in avg_mode["ranking"]}
        app_ranking = {row["operator"]: row["avgDlMbps"] for row in app_mode["ranking"]}
        avg_kpis = {
            row["operator"]: ((row.get("kpis") or {}).get("dl") or {}).get("average")
            for row in avg_mode["operators"]
        }
        app_kpis = {
            row["operator"]: ((row.get("kpis") or {}).get("dl") or {}).get("average")
            for row in app_mode["operators"]
        }

        self.assertEqual(avg_mode["dlMode"], "app_rate_dl_avg")
        self.assertEqual(app_mode["dlMode"], "app_rate_dl")
        self.assertEqual(avg_ranking["IAM"], 50.0)
        self.assertEqual(app_ranking["IAM"], 150.0)
        self.assertEqual(avg_kpis["IAM"], 50.0)
        self.assertEqual(app_kpis["IAM"], 150.0)
        self.assertEqual(avg_mode["bestDlOperator"], "Orange")
        self.assertEqual(app_mode["bestDlOperator"], "IAM")

    def test_benchmark_dataset_switches_window_scope_by_mode(self):
        operator_files = [
            self._benchmark_window_scope_operator_fixture("IAM"),
        ]

        all_window = server._benchmark_nemo_build_dataset(
            deepcopy(operator_files),
            dl_mode="app_rate_dl",
            window_mode="all_dt_session",
        )
        active_window = server._benchmark_nemo_build_dataset(
            deepcopy(operator_files),
            dl_mode="app_rate_dl",
            window_mode="active_dl_session",
        )

        all_dl = ((all_window["operators"][0].get("kpis") or {}).get("dl") or {}).get("average")
        active_dl = ((active_window["operators"][0].get("kpis") or {}).get("dl") or {}).get("average")

        self.assertEqual(all_window["windowMode"], "all_dt_session")
        self.assertEqual(active_window["windowMode"], "active_dl_session")
        self.assertEqual(all_dl, 32.5)
        self.assertEqual(active_dl, 40.0)

    def test_benchmark_dt_dataset_caches_per_mode(self):
        tmp = NamedTemporaryFile(suffix=".txt", delete=False)
        tmp.close()
        operator_files = [self._benchmark_operator_fixture("IAM", app_dl_avg=50.0, app_dl_samples=[200.0, 100.0])]
        dataset_calls = []
        original_cache = deepcopy(server.BENCHMARK_NEMO_DATASET)
        server.BENCHMARK_NEMO_DATASET.clear()
        server.BENCHMARK_NEMO_DATASET.update(
            {
                "paths": [],
                "path_mtimes": {},
                "data": None,
                "loaded_at": None,
                "operator_files": [],
                "dt_datasets": {},
                "dataset_id": None,
                "dataset_key": "",
            }
        )

        def fake_build_dataset(filtered, dl_mode="app_rate_dl_avg", window_mode="all_dt_session"):
            dataset_calls.append((dl_mode, window_mode))
            return {"dlMode": dl_mode, "windowMode": window_mode, "operators": filtered}

        try:
            with mock.patch.object(server, "_benchmark_nemo_resolve_paths", return_value=[tmp.name]), \
                 mock.patch.object(server, "_benchmark_nemo_collect_mtimes", return_value={tmp.name: 1.0}), \
                 mock.patch.object(server, "_benchmark_nemo_parse_operator_files", return_value=deepcopy(operator_files)), \
                 mock.patch.object(server, "_benchmark_nemo_build_dataset", side_effect=fake_build_dataset):
                avg_first = server._benchmark_nemo_dt_dataset(0, dl_mode="app_rate_dl_avg")
                avg_second = server._benchmark_nemo_dt_dataset(0, dl_mode="app_rate_dl_avg")
                app_first = server._benchmark_nemo_dt_dataset(0, dl_mode="app_rate_dl")

            self.assertEqual(avg_first["dlMode"], "app_rate_dl_avg")
            self.assertIs(avg_first, avg_second)
            self.assertEqual(app_first["dlMode"], "app_rate_dl")
            self.assertEqual(
                dataset_calls,
                [
                    ("app_rate_dl_avg", "all_dt_session"),
                    ("app_rate_dl", "all_dt_session"),
                ],
            )
        finally:
            server.BENCHMARK_NEMO_DATASET.clear()
            server.BENCHMARK_NEMO_DATASET.update(original_cache)
            try:
                import os

                os.unlink(tmp.name)
            except OSError:
                pass

    def test_benchmark_dt_dataset_caches_per_dl_and_window_mode(self):
        tmp = NamedTemporaryFile(suffix=".txt", delete=False)
        tmp.close()
        operator_files = [
            self._benchmark_window_scope_operator_fixture("IAM"),
        ]
        dataset_calls = []
        original_cache = deepcopy(server.BENCHMARK_NEMO_DATASET)
        server.BENCHMARK_NEMO_DATASET.clear()
        server.BENCHMARK_NEMO_DATASET.update(
            {
                "paths": [],
                "path_mtimes": {},
                "data": None,
                "loaded_at": None,
                "operator_files": [],
                "dt_datasets": {},
                "dataset_id": None,
                "dataset_key": "",
            }
        )

        def fake_build_dataset(filtered, dl_mode="app_rate_dl_avg", window_mode="all_dt_session"):
            dataset_calls.append((dl_mode, window_mode))
            return {"dlMode": dl_mode, "windowMode": window_mode, "operators": filtered}

        try:
            with mock.patch.object(server, "_benchmark_nemo_resolve_paths", return_value=[tmp.name]), \
                 mock.patch.object(server, "_benchmark_nemo_collect_mtimes", return_value={tmp.name: 1.0}), \
                 mock.patch.object(server, "_benchmark_nemo_parse_operator_files", return_value=deepcopy(operator_files)), \
                 mock.patch.object(server, "_benchmark_nemo_build_dataset", side_effect=fake_build_dataset):
                first = server._benchmark_nemo_dt_dataset(
                    0,
                    dl_mode="app_rate_dl_avg",
                    window_mode="all_dt_session",
                )
                second = server._benchmark_nemo_dt_dataset(
                    0,
                    dl_mode="app_rate_dl_avg",
                    window_mode="all_dt_session",
                )
                third = server._benchmark_nemo_dt_dataset(
                    0,
                    dl_mode="app_rate_dl_avg",
                    window_mode="active_dl_session",
                )

            self.assertIs(first, second)
            self.assertEqual(first["windowMode"], "all_dt_session")
            self.assertEqual(third["windowMode"], "active_dl_session")
            self.assertEqual(
                dataset_calls,
                [
                    ("app_rate_dl_avg", "all_dt_session"),
                    ("app_rate_dl_avg", "active_dl_session"),
                ],
            )
        finally:
            server.BENCHMARK_NEMO_DATASET.clear()
            server.BENCHMARK_NEMO_DATASET.update(original_cache)
            try:
                import os

                os.unlink(tmp.name)
            except OSError:
                pass

    def test_benchmark_load_reuses_full_dataset_cache_per_mode(self):
        tmp = NamedTemporaryFile(suffix=".txt", delete=False)
        tmp.close()
        operator_files = [self._benchmark_operator_fixture("IAM", app_dl_avg=50.0, app_dl_samples=[200.0, 100.0])]
        build_calls = []
        original_cache = deepcopy(server.BENCHMARK_NEMO_DATASET)
        avg_dataset = {
            "analysisVersion": server._BENCHMARK_NEMO_ANALYSIS_VERSION,
            "dlMode": "app_rate_dl_avg",
            "dlModeLabel": "App rate DL avg",
            "operators": [{"operator": "IAM"}],
            "dtList": [],
        }
        server.BENCHMARK_NEMO_DATASET.clear()
        server.BENCHMARK_NEMO_DATASET.update(
            {
                "paths": [tmp.name],
                "path_mtimes": {tmp.name: 1.0},
                "data": avg_dataset,
                "loaded_at": None,
                "operator_files": deepcopy(operator_files),
                "dt_datasets": {},
                "dataset_id": None,
                "dataset_key": "avg-key",
                "dl_mode": "app_rate_dl_avg",
                "mode_datasets": {
                    "app_rate_dl_avg": avg_dataset,
                },
            }
        )

        def fake_build_dataset(filtered, dl_mode="app_rate_dl_avg"):
            build_calls.append(dl_mode)
            return {
                "analysisVersion": server._BENCHMARK_NEMO_ANALYSIS_VERSION,
                "dlMode": dl_mode,
                "dlModeLabel": dl_mode,
                "operators": [{"operator": "IAM"}],
                "dtList": [],
            }

        try:
            with mock.patch.object(server, "_benchmark_nemo_resolve_paths", return_value=[tmp.name]), \
                 mock.patch.object(server, "_benchmark_nemo_collect_mtimes", return_value={tmp.name: 1.0}), \
                 mock.patch.object(server, "_benchmark_nemo_library_load_dataset_by_key", return_value=None), \
                 mock.patch.object(server, "_benchmark_nemo_library_store_dataset", return_value=None), \
                 mock.patch.object(server, "_benchmark_nemo_build_dataset", side_effect=fake_build_dataset):
                avg_first = server._load_benchmark_nemo_files(dl_mode="app_rate_dl_avg")
                app_first = server._load_benchmark_nemo_files(dl_mode="app_rate_dl")
                avg_second = server._load_benchmark_nemo_files(dl_mode="app_rate_dl_avg")

            self.assertEqual(avg_first["dataset"]["dlMode"], "app_rate_dl_avg")
            self.assertEqual(app_first["dataset"]["dlMode"], "app_rate_dl")
            self.assertEqual(avg_second["dataset"]["dlMode"], "app_rate_dl_avg")
            self.assertEqual(build_calls, ["app_rate_dl"])
        finally:
            server.BENCHMARK_NEMO_DATASET.clear()
            server.BENCHMARK_NEMO_DATASET.update(original_cache)
            try:
                import os

                os.unlink(tmp.name)
            except OSError:
                pass

    def test_bler_localization_table_is_generated_for_current_scope(self):
        operator_file = {
            "operator": "IAM",
            "rows": [
                {
                    "time": "2026-05-08T08:40:24",
                    "lat": 33.02,
                    "lon": -7.62,
                    "macDlBler": 18.0,
                    "sinr": 4.0,
                    "pdschMcs": 8.0,
                    "pdschModulation": "16QAM",
                    "rankIndicator": 2.0,
                    "appDlMbps": 42.0,
                    "servingCellName": "4G_SettatCPR2",
                    "nrPscellName": "5G_SettatCPR5",
                }
            ],
        }

        rows = server._deep_bler_localization_rows(operator_file, threshold=10.0)

        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["servingCell"], "4G_SettatCPR2")
        self.assertEqual(rows[0]["nrPscell"], "5G_SettatCPR5")
        self.assertEqual(rows[0]["bler"], 18.0)

    def test_bler_localization_skips_rows_at_or_below_threshold(self):
        operator_file = {
            "operator": "IAM",
            "rows": [
                {"time": "t1", "macDlBler": 4.0},
                {"time": "t2", "macDlBler": 10.0},
                {"time": "t3", "macDlBler": 12.0, "servingCellName": "4G_X"},
            ],
        }
        rows = server._deep_bler_localization_rows(operator_file, threshold=10.0)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["servingCell"], "4G_X")

    def test_deep_scope_label_is_single_dt_when_every_operator_has_one_title(self):
        operators = [
            {"operator": "IAM", "measurementTitles": ["DT1 IAM"]},
            {"operator": "Orange", "measurementTitles": ["DT1 Orange"]},
            {"operator": "INWI", "measurementTitles": ["DT1 INWI"]},
        ]
        self.assertEqual(server._deep_scope_label_from_operators(operators), "DT1 IAM")

    def test_deep_scope_label_is_combined_when_multiple_titles_exist(self):
        operators = [
            {"operator": "IAM", "measurementTitles": ["DT1 IAM", "DT2 IAM"]},
            {"operator": "Orange", "measurementTitles": ["DT1 Orange", "DT2 Orange"]},
        ]
        self.assertEqual(server._deep_scope_label_from_operators(operators), "All DTs (combined)")


if __name__ == "__main__":
    unittest.main()

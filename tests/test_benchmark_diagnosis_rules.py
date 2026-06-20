import unittest
from copy import deepcopy
from datetime import datetime, timedelta
from tempfile import NamedTemporaryFile
from unittest import mock

import server


class BenchmarkDiagnosisRulesTests(unittest.TestCase):
    def _nemo_event_row(self, when, event_id, **extra):
        row = {
            "_dt": when,
            "time": when.isoformat(),
            "measurementTitle": "DT1",
            "eventId": event_id,
            "eventText": event_id,
        }
        row.update(extra)
        return row

    def _nemo_download_session_rows(
        self,
        *,
        dreq_offset_s,
        dcomp_offset_s,
        dad_offset_s,
        download_time_s,
        final_bytes_dl,
        samples,
        prb_pct,
        bw_mhz,
        sinr_db,
        mac_total_factor=1.08,
    ):
        base = datetime(2026, 6, 20, 8, 40, 0)
        rows = [
            self._nemo_event_row(base, "DAA"),
            self._nemo_event_row(base + timedelta(milliseconds=200), "DAC"),
            self._nemo_event_row(
                base + timedelta(seconds=dreq_offset_s),
                "DREQ",
                dataTransferDirection="Downlink",
                applicationProtocol="HTTP",
                bytesDl=0.0,
                fileSizeBytes=final_bytes_dl,
            ),
        ]
        for offset_s, app_dl_mbps in samples:
            bytes_dl = min(
                final_bytes_dl,
                final_bytes_dl * max(offset_s - dreq_offset_s, 0.0) / max(download_time_s, 0.1),
            )
            row = {
                "_dt": base + timedelta(seconds=offset_s),
                "time": (base + timedelta(seconds=offset_s)).isoformat(),
                "measurementTitle": "DT1",
                "dataTransferDirection": "Downlink",
                "applicationProtocol": "HTTP",
                "bytesDl": bytes_dl,
                "appDlMbps": app_dl_mbps,
                "dlPrbPct": prb_pct,
                "caTotalBwMhz": bw_mhz,
                "primaryBwMhz": bw_mhz,
                "rsrpNr": -89.0,
                "sinrNr": sinr_db,
                "totalMacDlMbps": app_dl_mbps * mac_total_factor,
                "macDl5gMbps": app_dl_mbps * mac_total_factor * 0.92,
                "macDlLteMbps": app_dl_mbps * mac_total_factor * 0.08,
                "pdschDl5gMbps": app_dl_mbps * 0.92,
                "pdschDlLteMbps": app_dl_mbps * 0.08,
            }
            if abs(offset_s - dcomp_offset_s) < 0.001:
                row["downloadTimeS"] = download_time_s
                row["bytesDl"] = float(final_bytes_dl)
                row["transferStatus"] = "Success"
            rows.append(row)
        rows.extend(
            [
                self._nemo_event_row(base + timedelta(seconds=dcomp_offset_s), "DCOMP"),
                self._nemo_event_row(base + timedelta(seconds=dad_offset_s), "DAD"),
            ]
        )
        return rows

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

    def _benchmark_window_scope_operator_fixture(self, operator):
        base = datetime(2026, 5, 8, 8, 40, 0)
        rows = [
            {
                "_dt": base,
                "time": base.isoformat(),
                "measurementTitle": "DT1",
                "applicationProtocol": "",
                "appDlRaw": 10.0,
                "appDlMbps": 10.0,
            },
            {
                "_dt": base + timedelta(seconds=1),
                "time": (base + timedelta(seconds=1)).isoformat(),
                "measurementTitle": "DT1",
                "applicationProtocol": "",
                "dataTransferDirection": "Downlink",
                "appDlRaw": 20.0,
                "appDlMbps": 20.0,
                "transferFilename": "http://example.test/file-200000000.bin",
                "bytesDl": 0.0,
            },
            {
                "_dt": base + timedelta(seconds=2),
                "time": (base + timedelta(seconds=2)).isoformat(),
                "measurementTitle": "DT1",
                "applicationProtocol": "",
                "appDlRaw": 40.0,
                "appDlMbps": 40.0,
                "bytesDl": 100_000_000.0,
            },
            {
                "_dt": base + timedelta(seconds=3),
                "time": (base + timedelta(seconds=3)).isoformat(),
                "measurementTitle": "DT1",
                "applicationProtocol": "",
                "appDlRaw": 60.0,
                "appDlMbps": 60.0,
                "bytesDl": 200_000_000.0,
                "transferStatus": "Success",
            },
            {
                "_dt": base + timedelta(seconds=4),
                "time": (base + timedelta(seconds=4)).isoformat(),
                "measurementTitle": "DT1",
                "applicationProtocol": "",
                "dataTransferDirection": "Uplink",
                "appDlRaw": 20.0,
                "appDlMbps": 20.0,
            },
        ]
        return {
            "operator": operator,
            "rows": rows,
            "has5g": False,
            "fiveGStatus": "",
            "technologyStatus": {},
            "measurementTitles": ["DT1"],
            "orderedDtTitles": ["DT1"],
            "rowsByMeasurementTitle": {"DT1": rows},
            "transferSessions": server._nemo_build_transfer_sessions(rows, operator),
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

    def test_nemo_parse_operator_file_uncached_extracts_device_model(self):
        headers = [
            "Time",
            "Measurement Title",
            "Device name",
            "App. rate DL",
        ]
        data_rows = [
            ["2026-06-20 08:40:00.000", "DT1", "Samsung Galaxy S24", "125000000"],
        ]
        with mock.patch.object(server, "_nemo_read_tabular_file", return_value=("\t", headers, data_rows)), \
             mock.patch.object(server, "_nemo_guess_operator", return_value="IAM"), \
             mock.patch.object(server, "_nemo_find_session_stats_path", return_value=""), \
             mock.patch.object(server, "_nemo_parse_session_stats", return_value={}):
            parsed = server._nemo_parse_operator_file_uncached("/tmp/iam_benchmark.txt")

        self.assertEqual(parsed["deviceModel"], "Samsung Galaxy S24")
        self.assertEqual(parsed["technologyStatus"]["deviceModel"], "Samsung Galaxy S24")

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
            (
                item
                for item in findings
                if item.get("domain") == "5G capacity layer" and item.get("kpi") == "NR n78 share"
            ),
            headline,
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

    def test_benchmark_dataset_uses_app_rate_dl_only(self):
        operator_files = [
            self._benchmark_operator_fixture("IAM", app_dl_avg=50.0, app_dl_samples=[200.0, 100.0]),
            self._benchmark_operator_fixture("Orange", app_dl_avg=80.0, app_dl_samples=[120.0, 120.0]),
        ]
        # The "App rate DL avg" mode was removed: the default and any legacy request resolve
        # to "App. rate DL" (DT-weighted mean of the instantaneous samples → IAM 150).
        for requested in (None, "app_rate_dl_avg", "app_rate_dl"):
            ds = server._benchmark_nemo_build_dataset(deepcopy(operator_files), dl_mode=requested)
            ranking = {row["operator"]: row["avgDlMbps"] for row in ds["ranking"]}
            kpis = {
                row["operator"]: ((row.get("kpis") or {}).get("dl") or {}).get("average")
                for row in ds["operators"]
            }
            self.assertEqual(ds["dlMode"], "app_rate_dl")
            self.assertEqual(ranking["IAM"], 150.0)
            self.assertEqual(kpis["IAM"], 150.0)
            self.assertEqual(ds["bestDlOperator"], "IAM")

    def test_benchmark_dt_dataset_normalizes_legacy_avg_mode(self):
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

        def fake_build_dataset(filtered, dl_mode="app_rate_dl", window_mode="all_dt_session"):
            dataset_calls.append(dl_mode)
            return {"dlMode": dl_mode, "operators": filtered}

        try:
            with mock.patch.object(server, "_benchmark_nemo_resolve_paths", return_value=[tmp.name]), \
                 mock.patch.object(server, "_benchmark_nemo_collect_mtimes", return_value={tmp.name: 1.0}), \
                 mock.patch.object(server, "_benchmark_nemo_parse_operator_files", return_value=deepcopy(operator_files)), \
                 mock.patch.object(server, "_benchmark_nemo_build_dataset", side_effect=fake_build_dataset):
                # Legacy "avg" request normalizes to app_rate_dl → same cache as the app request.
                avg_first = server._benchmark_nemo_dt_dataset(0, dl_mode="app_rate_dl_avg")
                app_first = server._benchmark_nemo_dt_dataset(0, dl_mode="app_rate_dl")

            self.assertEqual(avg_first["dlMode"], "app_rate_dl")
            self.assertIs(avg_first, app_first)
            self.assertEqual(dataset_calls, ["app_rate_dl"])
        finally:
            server.BENCHMARK_NEMO_DATASET.clear()
            server.BENCHMARK_NEMO_DATASET.update(original_cache)
            try:
                import os

                os.unlink(tmp.name)
            except OSError:
                pass

    def test_benchmark_load_reuses_app_rate_dl_cache(self):
        tmp = NamedTemporaryFile(suffix=".txt", delete=False)
        tmp.close()
        operator_files = [self._benchmark_operator_fixture("IAM", app_dl_avg=50.0, app_dl_samples=[200.0, 100.0])]
        build_calls = []
        original_cache = deepcopy(server.BENCHMARK_NEMO_DATASET)
        app_dataset = {
            "analysisVersion": server._BENCHMARK_NEMO_ANALYSIS_VERSION,
            "dlMode": "app_rate_dl",
            "dlModeLabel": "App. rate DL",
            "windowMode": "all_dt_session",
            "operators": [{"operator": "IAM"}],
            "dtList": [],
        }
        server.BENCHMARK_NEMO_DATASET.clear()
        server.BENCHMARK_NEMO_DATASET.update(
            {
                "paths": [tmp.name],
                "path_mtimes": {tmp.name: 1.0},
                "data": app_dataset,
                "loaded_at": None,
                "operator_files": deepcopy(operator_files),
                "dt_datasets": {},
                "dataset_id": None,
                "dataset_key": "app-key",
                "dl_mode": "app_rate_dl",
                "mode_datasets": {
                    server._benchmark_nemo_mode_cache_key("app_rate_dl", "all_dt_session"): app_dataset,
                },
            }
        )

        def fake_build_dataset(filtered, dl_mode="app_rate_dl_avg", window_mode="all_dt_session"):
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
                # A legacy "avg" request and an "app" request both resolve to the same
                # app_rate_dl cache entry → no rebuild.
                avg_first = server._load_benchmark_nemo_files(dl_mode="app_rate_dl_avg")
                app_first = server._load_benchmark_nemo_files(dl_mode="app_rate_dl")

            self.assertEqual(avg_first["dataset"]["dlMode"], "app_rate_dl")
            self.assertEqual(app_first["dataset"]["dlMode"], "app_rate_dl")
            self.assertEqual(build_calls, [])
        finally:
            server.BENCHMARK_NEMO_DATASET.clear()
            server.BENCHMARK_NEMO_DATASET.update(original_cache)
            try:
                import os

                os.unlink(tmp.name)
            except OSError:
                pass

    def test_benchmark_dataset_switches_window_scope_by_mode(self):
        operator_files = [self._benchmark_window_scope_operator_fixture("IAM")]

        all_session = server._benchmark_nemo_build_dataset(
            deepcopy(operator_files),
            dl_mode="app_rate_dl",
            window_mode="all_dt_session",
        )
        active_dl = server._benchmark_nemo_build_dataset(
            deepcopy(operator_files),
            dl_mode="app_rate_dl",
            window_mode="active_dl_session",
        )

        self.assertEqual(all_session["windowMode"], "all_dt_session")
        self.assertEqual(active_dl["windowMode"], "active_dl_session")
        self.assertAlmostEqual(all_session["ranking"][0]["avgDlMbps"], 30.0)
        self.assertAlmostEqual(active_dl["ranking"][0]["avgDlMbps"], 40.0)

    def test_benchmark_dt_dataset_caches_per_dl_and_window_mode(self):
        tmp = NamedTemporaryFile(suffix=".txt", delete=False)
        tmp.close()
        operator_files = [self._benchmark_window_scope_operator_fixture("IAM")]
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
                "mode_datasets": {},
                "mode_dataset_ids": {},
                "mode_dataset_keys": {},
                "dt_datasets": {},
                "dataset_id": None,
                "dataset_key": "",
                "dl_mode": "app_rate_dl_avg",
                "window_mode": "all_dt_session",
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
                first = server._benchmark_nemo_dt_dataset(0, dl_mode="app_rate_dl", window_mode="all_dt_session")
                second = server._benchmark_nemo_dt_dataset(0, dl_mode="app_rate_dl", window_mode="all_dt_session")
                third = server._benchmark_nemo_dt_dataset(0, dl_mode="app_rate_dl", window_mode="active_dl_session")

            self.assertIs(first, second)
            self.assertEqual(first["windowMode"], "all_dt_session")
            self.assertEqual(third["windowMode"], "active_dl_session")
            self.assertEqual(
                dataset_calls,
                [
                    ("app_rate_dl", "all_dt_session"),
                    ("app_rate_dl", "active_dl_session"),
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

    def test_downlink_transfer_session_stops_at_last_real_dl_activity(self):
        base = datetime(2026, 5, 8, 8, 40, 11, 188000)
        rows = [
            {
                "_dt": base,
                "time": base.isoformat(),
                "measurementTitle": "DT1",
                "dataTransferDirection": "Downlink",
                "transferFilename": "http://example.test/file-200000000.bin",
                "bytesDl": 0.0,
            },
            {
                "_dt": base + timedelta(seconds=2),
                "time": (base + timedelta(seconds=2)).isoformat(),
                "measurementTitle": "DT1",
                "transferFilename": "http://example.test/file-200000000.bin",
                "bytesDl": 100_000_000.0,
                "appDlMbps": 180.0,
            },
            {
                "_dt": base + timedelta(seconds=6, milliseconds=18),
                "time": (base + timedelta(seconds=6, milliseconds=18)).isoformat(),
                "measurementTitle": "DT1",
                "transferFilename": "http://example.test/file-200000000.bin",
                "bytesDl": 200_000_000.0,
                "appDlMbps": 220.0,
                "transferStatus": "Success",
            },
            {
                "_dt": base + timedelta(seconds=13, milliseconds=696),
                "time": (base + timedelta(seconds=13, milliseconds=696)).isoformat(),
                "measurementTitle": "DT1",
                "transferFilename": "http://example.test/file-200000000.bin",
                "bytesDl": 200_000_000.0,
            },
        ]

        sessions = server._nemo_build_transfer_sessions(rows, "IAM")

        self.assertEqual(len(sessions), 1)
        self.assertEqual(
            sessions[0]["endTime"],
            (base + timedelta(seconds=6, milliseconds=18)).isoformat(),
        )

    def test_downlink_transfer_session_uses_active_dl_window_not_marker_or_late_ping(self):
        marker = datetime(2026, 5, 8, 8, 40, 10, 940000)
        rows = [
            {
                "_dt": marker,
                "time": marker.isoformat(),
                "measurementTitle": "DT1",
                "dataTransferDirection": "Downlink",
                "transferFilename": "http://example.test/file-200000000.bin",
                "bytesDl": 0.0,
            },
            {
                "_dt": marker + timedelta(milliseconds=248),
                "time": (marker + timedelta(milliseconds=248)).isoformat(),
                "measurementTitle": "DT1",
                "transferFilename": "http://example.test/file-200000000.bin",
                "bytesDl": 16.026,
                "appDlMbps": 107.158,
            },
            {
                "_dt": marker + timedelta(seconds=6, milliseconds=266),
                "time": (marker + timedelta(seconds=6, milliseconds=266)).isoformat(),
                "measurementTitle": "DT1",
                "transferFilename": "http://example.test/file-200000000.bin",
                "bytesDl": 192_391_850.0,
                "appDlMbps": 2.379,
            },
            {
                "_dt": marker + timedelta(seconds=15, milliseconds=648),
                "time": (marker + timedelta(seconds=15, milliseconds=648)).isoformat(),
                "measurementTitle": "DT1",
                "transferFilename": "http://example.test/file-200000000.bin",
                "bytesDl": 195_181_730.0,
            },
            {
                "_dt": marker + timedelta(minutes=1, seconds=51, milliseconds=363),
                "time": (marker + timedelta(minutes=1, seconds=51, milliseconds=363)).isoformat(),
                "measurementTitle": "DT1",
                "transferStatus": "Attempting data server connection",
            },
            {
                "_dt": marker + timedelta(minutes=1, seconds=51, milliseconds=363),
                "time": (marker + timedelta(minutes=1, seconds=51, milliseconds=363)).isoformat(),
                "measurementTitle": "DT1",
                "dataTransferDirection": "Downlink",
            },
        ]

        sessions = server._nemo_build_transfer_sessions(rows, "IAM")

        self.assertEqual(len(sessions), 1)
        self.assertEqual(
            sessions[0]["startTime"],
            (marker + timedelta(milliseconds=248)).isoformat(),
        )
        self.assertEqual(
            sessions[0]["endTime"],
            (marker + timedelta(seconds=6, milliseconds=266)).isoformat(),
        )

    def test_nemo_extract_dl_events_adds_slow_start_and_efficiency_kpis(self):
        rows = self._nemo_download_session_rows(
            dreq_offset_s=0.5,
            dcomp_offset_s=4.5,
            dad_offset_s=4.8,
            download_time_s=4.5,
            final_bytes_dl=190_000_000,
            samples=[
                (1.0, 300.0),
                (2.0, 450.0),
                (3.0, 480.0),
                (4.0, 470.0),
                (4.5, 465.0),
            ],
            prb_pct=5.0,
            bw_mhz=100.0,
            sinr_db=15.0,
        )

        result = server._nemo_extract_dl_events(rows)
        download = result["download"]
        kpis = result["kpis"]

        self.assertAlmostEqual(download["peakMbps"], 480.0, places=1)
        self.assertAlmostEqual(download["steadyStateMbps"], 466.2, places=1)
        self.assertAlmostEqual(download["rampUpSeconds"], 1.5, places=1)
        self.assertAlmostEqual(download["slowStartLossPct"], 27.6, places=1)
        self.assertTrue(download["slowStartDominated"])
        self.assertAlmostEqual(download["peakToAvgRatio"], 1.42, places=2)
        self.assertAlmostEqual(download["bwMHz"], 100.0, places=1)
        self.assertAlmostEqual(download["mbpsPerMHz"], 4.66, places=2)
        self.assertAlmostEqual(download["mbpsPerPrbPct"], 93.25, places=2)
        self.assertEqual(download["efficiencyClass"], "headroom")
        self.assertEqual(download["loadState"], "headroom")
        self.assertAlmostEqual(download["deliveryEfficiencyPct"], 92.59, places=2)
        self.assertEqual(download["confidenceClass"], "low")
        self.assertTrue(kpis["dlSlowStartDominated"])
        self.assertEqual(kpis["efficiencyClass"], "headroom")
        self.assertEqual(kpis["loadState"], "headroom")
        self.assertAlmostEqual(kpis["deliveryEfficiencyPct"], 92.59, places=2)
        self.assertEqual(kpis["confidenceClass"], "low")
        self.assertIn("slow-start dominated", kpis["dlSlowStartNote"])

    def test_nemo_extract_dl_events_marks_longer_session_as_not_slow_start_dominated(self):
        rows = self._nemo_download_session_rows(
            dreq_offset_s=0.0,
            dcomp_offset_s=13.0,
            dad_offset_s=13.4,
            download_time_s=13.0,
            final_bytes_dl=198_250_000,
            samples=[
                (1.0, 60.0),
                (2.0, 110.0),
                (3.0, 120.0),
                (6.0, 122.0),
                (9.0, 123.0),
                (12.0, 122.0),
                (13.0, 122.0),
            ],
            prb_pct=75.0,
            bw_mhz=100.0,
            sinr_db=8.0,
        )

        result = server._nemo_extract_dl_events(rows)
        download = result["download"]
        kpis = result["kpis"]

        self.assertFalse(download["slowStartDominated"])
        self.assertIsNone(kpis["dlSlowStartNote"])
        self.assertEqual(download["efficiencyClass"], "loaded")
        self.assertEqual(kpis["efficiencyClass"], "loaded")
        self.assertEqual(download["loadState"], "loaded")
        self.assertEqual(kpis["loadState"], "loaded")
        self.assertEqual(download["confidenceClass"], "high")
        self.assertEqual(kpis["confidenceClass"], "high")

    def test_nemo_extract_dl_events_rf_means_use_transfer_window(self):
        rows = self._nemo_download_session_rows(
            dreq_offset_s=0.3,
            dcomp_offset_s=4.3,
            dad_offset_s=4.8,
            download_time_s=4.0,
            final_bytes_dl=180_000_000,
            samples=[
                (1.0, 100.0),
                (2.0, 200.0),
                (3.0, 300.0),
            ],
            prb_pct=18.0,
            bw_mhz=40.0,
            sinr_db=0.0,
        )
        idle_rows = [
            {
                "_dt": datetime(2026, 6, 20, 8, 40, 0, 100000),
                "time": datetime(2026, 6, 20, 8, 40, 0, 100000).isoformat(),
                "measurementTitle": "DT1",
                "dataTransferDirection": "Downlink",
                "applicationProtocol": "HTTP",
                "sinrNr": -18.0,
                "rsrpNr": -120.0,
                "dlPrbPct": 2.0,
                "pdschDl5gMbps": 0.0,
                "pdschDlLteMbps": 0.0,
            },
            {
                "_dt": datetime(2026, 6, 20, 8, 40, 4, 700000),
                "time": datetime(2026, 6, 20, 8, 40, 4, 700000).isoformat(),
                "measurementTitle": "DT1",
                "dataTransferDirection": "Downlink",
                "applicationProtocol": "HTTP",
                "sinrNr": -15.0,
                "rsrpNr": -118.0,
                "dlPrbPct": 1.0,
                "pdschDl5gMbps": 0.0,
                "pdschDlLteMbps": 0.0,
            },
        ]
        rows.extend(idle_rows)
        active_rows = [row for row in rows if row.get("appDlMbps") is not None]
        active_rows[0]["sinrNr"] = 10.0
        active_rows[0]["rsrpNr"] = -95.0
        active_rows[1]["sinrNr"] = 12.0
        active_rows[1]["rsrpNr"] = -92.0
        active_rows[2]["sinrNr"] = 14.0
        active_rows[2]["rsrpNr"] = -90.0

        result = server._nemo_extract_dl_events(rows)
        download = result["download"]
        kpis = result["kpis"]

        # RF is the simple mean over the DREQ→DCOMP transfer window. The two idle rows
        # (at 0.1 s before DREQ and 4.7 s after DCOMP) are excluded; the three transfer-window
        # samples (10/12/14 dB, -95/-92/-90 dBm) are averaged unweighted.
        self.assertAlmostEqual(download["ssSinrMean"], 12.0, places=1)
        self.assertAlmostEqual(download["ssRsrpMean"], -92.3, places=1)
        self.assertEqual(download["rfSampleCount"], 3)
        self.assertEqual(kpis["rfSampleCount"], 3)
        self.assertEqual(download["activeSlotCount"], 3)
        self.assertEqual(kpis["activeSlotCount"], 3)

    def test_nemo_extract_dl_events_flags_physically_impossible_rf_combo(self):
        rows = self._nemo_download_session_rows(
            dreq_offset_s=0.4,
            dcomp_offset_s=8.4,
            dad_offset_s=8.8,
            download_time_s=8.0,
            final_bytes_dl=250_000_000,
            samples=[
                (1.0, 240.0),
                (2.0, 280.0),
                (3.0, 320.0),
                (4.0, 300.0),
                (5.0, 290.0),
                (6.0, 310.0),
                (7.0, 305.0),
                (8.0, 295.0),
            ],
            prb_pct=32.0,
            bw_mhz=80.0,
            sinr_db=-2.5,
        )
        for row in rows:
            if row.get("appDlMbps") is not None:
                row["rsrpNr"] = -114.0
                row["pdschDl5gMbps"] = row["appDlMbps"] * 0.97

        result = server._nemo_extract_dl_events(rows)
        download = result["download"]
        kpis = result["kpis"]

        self.assertIn("sinr_vs_nr_throughput", download["rfConsistencyIssues"])
        self.assertIn("rsrp_vs_throughput", download["rfConsistencyIssues"])
        self.assertEqual(download["confidenceLevel"], "low")
        self.assertEqual(kpis["confidenceLevel"], "low")
        self.assertIn("RF consistency", download["confidenceReason"])
        self.assertIn("RF consistency", kpis["confidenceReason"])

    def test_nemo_extract_dl_events_adds_throughput_spread_and_confidence_aliases(self):
        rows = self._nemo_download_session_rows(
            dreq_offset_s=0.4,
            dcomp_offset_s=5.4,
            dad_offset_s=5.7,
            download_time_s=5.0,
            final_bytes_dl=180_000_000,
            samples=[
                (1.0, 100.0),
                (2.0, 200.0),
                (3.0, 300.0),
                (4.0, 400.0),
                (5.0, 500.0),
            ],
            prb_pct=20.0,
            bw_mhz=100.0,
            sinr_db=11.0,
        )

        result = server._nemo_extract_dl_events(rows)
        download = result["download"]
        kpis = result["kpis"]

        self.assertEqual(
            download["throughputSpreadMbps"],
            {"min": 100.0, "p10": 140.0, "p50": 300.0, "p90": 460.0, "max": 500.0, "n": 5},
        )
        self.assertEqual(kpis["throughputSpreadMbps"], download["throughputSpreadMbps"])
        self.assertEqual(download["dlSampleSpread"], download["throughputSpreadMbps"])
        self.assertEqual(kpis["dlSampleSpread"], download["throughputSpreadMbps"])
        self.assertEqual(download["confidenceLevel"], download["confidenceClass"])
        self.assertEqual(kpis["confidenceLevel"], kpis["confidenceClass"])
        self.assertEqual(download["confidenceReason"], download["confidenceNote"])
        self.assertEqual(kpis["confidenceReason"], kpis["confidenceNote"])
        self.assertEqual(download["rfConsistencyFlags"], download["rfConsistencyIssues"])
        self.assertEqual(kpis["rfConsistencyFlags"], kpis["rfConsistencyIssues"])

    def test_nemo_extract_dl_events_uses_peak_plateau_for_iam_source_like_samples(self):
        rows = self._nemo_download_session_rows(
            dreq_offset_s=0.272,
            dcomp_offset_s=4.728,
            dad_offset_s=5.006,
            download_time_s=4.728,
            final_bytes_dl=200_000_000,
            samples=[
                (0.554, 122.197),
                (1.612, 423.305),
                (2.654, 482.840),
                (3.612, 352.202),
            ],
            prb_pct=5.1,
            bw_mhz=35.0,
            sinr_db=15.4,
        )

        result = server._nemo_extract_dl_events(rows)
        download = result["download"]
        kpis = result["kpis"]

        self.assertAlmostEqual(download["steadyStateMbps"], 453.1, places=1)
        self.assertAlmostEqual(kpis["dlSteadyStateMbps"], 453.1, places=1)
        self.assertTrue(download["slowStartDominated"])
        self.assertEqual(download["loadState"], "headroom")
        self.assertEqual(kpis["confidenceClass"], "low")

    def test_nemo_extract_dl_events_marks_orange_source_like_session_loaded(self):
        rows = self._nemo_download_session_rows(
            dreq_offset_s=0.240,
            dcomp_offset_s=13.094,
            dad_offset_s=13.360,
            download_time_s=13.094,
            final_bytes_dl=200_000_000,
            samples=[
                (0.549, 37.720),
                (1.552, 92.060),
                (2.555, 74.540),
                (3.601, 79.160),
                (4.562, 86.420),
                (5.569, 84.710),
                (6.578, 119.980),
                (7.578, 139.250),
                (8.578, 195.090),
                (9.578, 206.360),
                (10.581, 137.340),
                (11.582, 170.780),
                (12.595, 167.710),
            ],
            prb_pct=57.8,
            bw_mhz=20.0,
            sinr_db=12.0,
        )

        result = server._nemo_extract_dl_events(rows)
        download = result["download"]
        kpis = result["kpis"]

        self.assertFalse(download["slowStartDominated"])
        self.assertEqual(download["efficiencyClass"], "loaded")
        self.assertEqual(kpis["efficiencyClass"], "loaded")
        self.assertEqual(download["loadState"], "loaded")
        self.assertEqual(kpis["loadState"], "loaded")
        self.assertEqual(kpis["confidenceClass"], "high")

    def test_nemo_extract_dl_events_marks_delivery_limited_sessions_separately_from_rf(self):
        rows = self._nemo_download_session_rows(
            dreq_offset_s=0.4,
            dcomp_offset_s=10.4,
            dad_offset_s=10.8,
            download_time_s=10.0,
            final_bytes_dl=120_000_000,
            samples=[
                (1.0, 72.0),
                (2.0, 84.0),
                (3.0, 95.0),
                (4.0, 98.0),
                (5.0, 100.0),
                (6.0, 101.0),
                (7.0, 100.0),
                (8.0, 99.0),
                (9.0, 99.0),
                (10.4, 98.0),
            ],
            prb_pct=22.0,
            bw_mhz=40.0,
            sinr_db=16.0,
            mac_total_factor=1.8,
        )

        result = server._nemo_extract_dl_events(rows)
        download = result["download"]
        kpis = result["kpis"]

        self.assertEqual(download["loadState"], "delivery_limited")
        self.assertEqual(kpis["loadState"], "delivery_limited")
        self.assertAlmostEqual(download["deliveryEfficiencyPct"], 55.56, places=2)
        self.assertEqual(kpis["confidenceClass"], "high")

    def test_benchmark_build_dataset_warns_when_device_models_differ(self):
        operator_files = [
            self._benchmark_operator_fixture("IAM", 338.4, [120.0, 482.0]),
            self._benchmark_operator_fixture("Orange", 122.2, [80.0, 160.0]),
            self._benchmark_operator_fixture("INWI", 375.3, [140.0, 500.0]),
        ]
        operator_files[0]["deviceModel"] = "Samsung Galaxy S24"
        operator_files[1]["deviceModel"] = "iPhone 15 Pro"
        operator_files[2]["deviceModel"] = "Samsung Galaxy S24"

        dataset = server._benchmark_nemo_build_dataset(
            deepcopy(operator_files),
            dl_mode="app_rate_dl_avg",
            window_mode="all_dt_session",
        )

        warnings = ((dataset.get("validationWarnings") or {}).get("warnings")) or []
        mismatch = next((item for item in warnings if item.get("type") == "device_model_mismatch"), None)

        self.assertIsNotNone(mismatch)
        self.assertIn("different device models", mismatch["message"].lower())
        self.assertIn("Samsung Galaxy S24", mismatch["message"])
        self.assertIn("iPhone 15 Pro", mismatch["message"])
        self.assertEqual(
            dataset["benchmarkValidity"]["deviceByOperator"],
            {
                "IAM": "Samsung Galaxy S24",
                "Orange": "iPhone 15 Pro",
                "INWI": "Samsung Galaxy S24",
            },
        )
        self.assertFalse(dataset["benchmarkValidity"]["devicesComparable"])
        self.assertEqual(dataset["benchmarkValidity"]["dtCount"], 1)
        self.assertEqual(dataset["benchmarkValidity"]["confidenceLevel"], "Low")

    def test_dt_clone_keeps_only_selected_downlink_session(self):
        base = datetime(2026, 5, 8, 8, 40, 0)
        operator_file = {
            "operator": "IAM",
            "rows": [
                {
                    "_dt": base + timedelta(seconds=0),
                    "time": (base + timedelta(seconds=0)).isoformat(),
                    "measurementTitle": "DT1",
                    "appDlMbps": 120.0,
                },
                {
                    "_dt": base + timedelta(seconds=5),
                    "time": (base + timedelta(seconds=5)).isoformat(),
                    "measurementTitle": "DT1",
                    "appDlMbps": 140.0,
                },
                {
                    "_dt": base + timedelta(seconds=60),
                    "time": (base + timedelta(seconds=60)).isoformat(),
                    "measurementTitle": "DT1",
                    "appDlMbps": 80.0,
                },
                {
                    "_dt": base + timedelta(seconds=65),
                    "time": (base + timedelta(seconds=65)).isoformat(),
                    "measurementTitle": "DT1",
                    "appDlMbps": 90.0,
                },
            ],
            "transferSessions": [
                {
                    "id": "IAM_X001",
                    "direction": "Downlink",
                    "measurementTitle": "DT1",
                    "startTime": (base + timedelta(seconds=0)).isoformat(),
                    "endTime": (base + timedelta(seconds=6)).isoformat(),
                },
                {
                    "id": "IAM_X002",
                    "direction": "Downlink",
                    "measurementTitle": "DT1",
                    "startTime": (base + timedelta(seconds=60)).isoformat(),
                    "endTime": (base + timedelta(seconds=66)).isoformat(),
                },
            ],
        }

        clone = server._nemo_clone_operator_file_for_dt_index_with_window(
            operator_file,
            0,
            window_mode="active_dl_session",
        )

        self.assertIsNotNone(clone)
        self.assertEqual(len(clone["transferSessions"]), 1)
        self.assertEqual(clone["transferSessions"][0]["id"], "IAM_X001")

    def test_episode_download_clip_excludes_records_after_exact_dl_end(self):
        base = datetime(2026, 5, 8, 8, 40, 11, 0)
        episode = {
            "key": ("4G_SettatCPR2", "4G_SettatCPR", "4G", "L800"),
            "start": base,
            "end": base + timedelta(seconds=20),
            "records": [
                {
                    "dt": base + timedelta(milliseconds=188),
                    "dl": [219.6],
                    "appTs": [base + timedelta(milliseconds=188)],
                    "rsrp": [],
                    "sinr": [],
                },
                {
                    "dt": base + timedelta(seconds=6, milliseconds=206),
                    "dl": [219.6],
                    "appTs": [base + timedelta(seconds=6, milliseconds=206)],
                    "rsrp": [],
                    "sinr": [],
                },
                {
                    "dt": base + timedelta(seconds=6, milliseconds=900),
                    "dl": [],
                    "appTs": [],
                    "rsrp": [],
                    "sinr": [],
                },
            ],
            "display": {},
        }
        intervals = [
            {
                "start": base + timedelta(milliseconds=188),
                "end": base + timedelta(seconds=6, milliseconds=206),
            }
        ]

        clipped = server._nemo_clip_primary_episodes_to_intervals([episode], intervals)

        self.assertEqual(len(clipped), 1)
        self.assertEqual(len(clipped[0]["records"]), 2)
        self.assertEqual(
            clipped[0]["display"]["endTime"],
            (base + timedelta(seconds=6, milliseconds=206)).strftime("%H:%M:%S.%f")[:-3],
        )

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

    # ── Simplified IAM Action Plan (5 columns, max 5 rows) ─────────────────────
    def _simplified_iam_no5g(self):
        return {
            "dlThroughput": 80.4, "fivegPresence": 0.0, "fourgOnly": 100.0, "n78": 0.0,
            "sinr": 8.0, "medianRank": 2.0, "ri1": 0.0, "dlSuccess": 100.0, "dlCompletion": 100.0,
            "tcpHandshake": 76.0, "blerAvg": 2.0, "blerP90": 8.0, "blerAbove10": 3.0,
            "prbUtilPct": None, "prbsAvg": None, "prbEfficiency": None,
        }

    def test_simplified_plan_columns_are_exactly_five(self):
        rows = server._deep_build_simplified_action_plan(
            self._simplified_iam_no5g(), [{"dlThroughput": 248.4, "tcpHandshake": 55.0}], None, "DT1 Settat"
        )
        self.assertTrue(rows)
        for row in rows:
            self.assertEqual(set(row.keys()), {"priority", "domain", "finding", "action", "confidence"})
        self.assertLessEqual(len(rows), 5)

    def test_simplified_plan_settat_like_no_5g_hierarchy(self):
        rows = server._deep_build_simplified_action_plan(
            self._simplified_iam_no5g(), [{"dlThroughput": 248.4, "tcpHandshake": 55.0}], None, "DT1 Settat"
        )
        domains = [r["domain"] for r in rows]
        self.assertEqual(
            domains,
            ["Active DL / 5G capacity layer", "Transport / core", "Scheduler / PRB efficiency", "Retest governance"],
        )
        p1 = rows[0]
        self.assertEqual(p1["priority"], "P1")
        self.assertIn("No 5G was observed", p1["finding"])
        self.assertIn("No n78 contribution", p1["finding"])
        self.assertIn("MIMO rank is acceptable", p1["finding"])
        self.assertEqual(p1["confidence"], "Confirmed symptom / Partial root cause")
        # MIMO is never a separate row, and no Mobility/Bandwidth/Capacity duplicates.
        for forbidden in ("MIMO / RI", "Mobility / serving sequence", "Bandwidth / spectrum", "Capacity / configuration"):
            self.assertNotIn(forbidden, domains)

    def test_simplified_plan_bler_row_only_when_triggered(self):
        iam = self._simplified_iam_no5g()
        iam["blerP90"] = 23.5  # triggers BLER
        rows = server._deep_build_simplified_action_plan(iam, [{"dlThroughput": 248.4, "tcpHandshake": 55.0}], None, "DT1")
        bler = [r for r in rows if r["domain"] == "BLER / retransmissions"]
        self.assertEqual(len(bler), 1)
        self.assertEqual(bler[0]["priority"], "P2")
        self.assertIn("retransmission peaks", bler[0]["finding"])

    def test_simplified_plan_transport_row_requires_high_handshake(self):
        iam = self._simplified_iam_no5g()
        iam["tcpHandshake"] = 60.0  # <70 and <55*1.2=66 -> no transport row
        rows = server._deep_build_simplified_action_plan(iam, [{"dlThroughput": 248.4, "tcpHandshake": 55.0}], None, "DT1")
        self.assertFalse(any(r["domain"] == "Transport / core" for r in rows))

    def test_simplified_plan_retest_absent_in_combined_scope(self):
        rows = server._deep_build_simplified_action_plan(
            self._simplified_iam_no5g(), [{"dlThroughput": 248.4, "tcpHandshake": 55.0}], None, "All DTs (combined)"
        )
        self.assertFalse(any(r["domain"] == "Retest governance" for r in rows))

    def test_simplified_plan_caps_at_five_rows(self):
        iam = self._simplified_iam_no5g()
        iam["blerP90"] = 23.5  # add BLER so all five candidate rows fire
        rows = server._deep_build_simplified_action_plan(iam, [{"dlThroughput": 248.4, "tcpHandshake": 55.0}], None, "DT1")
        self.assertEqual(len(rows), 5)
        self.assertEqual([r["priority"] for r in rows], ["P1", "P2", "P2", "P3", "P3"])

    # ── Active-DL window scope ─────────────────────────────────────────────────
    def test_window_scope_active_dl_filters_to_downlink_intervals(self):
        rows = [{"_dt": datetime(2026, 5, 8, 8, 40, s), "sinr": float(s)} for s in range(0, 30)]
        of = {
            "operator": "IAM", "rows": rows,
            "transferSessions": [
                {"direction": "Downlink", "startTime": "2026-05-08T08:40:10", "endTime": "2026-05-08T08:40:20"}
            ],
        }
        scoped = server._benchmark_nemo_scope_operator_file_to_window(of, "active_dl_session")
        sr = scoped["rows"]
        self.assertTrue(0 < len(sr) < len(rows))
        self.assertTrue(all(datetime(2026, 5, 8, 8, 40, 10) <= r["_dt"] <= datetime(2026, 5, 8, 8, 40, 20) for r in sr))
        self.assertFalse(scoped.get("_windowFallback"))

    def test_window_scope_active_dl_never_empty_falls_back(self):
        rows = [{"_dt": datetime(2026, 5, 8, 8, 40, s)} for s in range(0, 10)]
        of = {
            "operator": "IAM", "rows": rows,
            "transferSessions": [
                {"direction": "Uplink", "startTime": "2026-05-08T08:40:02", "endTime": "2026-05-08T08:40:05"}
            ],
        }
        scoped = server._benchmark_nemo_scope_operator_file_to_window(of, "active_dl_session")
        self.assertEqual(len(scoped["rows"]), len(rows))  # no downlink window → keep all rows
        self.assertTrue(scoped.get("_windowFallback"))

    def test_window_scope_all_dt_keeps_all_rows(self):
        rows = [{"_dt": datetime(2026, 5, 8, 8, 40, s)} for s in range(0, 10)]
        of = {"operator": "IAM", "rows": rows, "transferSessions": []}
        scoped = server._benchmark_nemo_scope_operator_file_to_window(of, "all_dt_session")
        self.assertEqual(len(scoped["rows"]), len(rows))
        self.assertFalse(scoped.get("_windowFallback"))

    def test_build_dataset_keeps_active_dl_transfer_sessions_when_rows_lack_markers(self):
        start = datetime(2026, 5, 8, 8, 40, 11, 188000)
        end = datetime(2026, 5, 8, 8, 40, 17, 206000)
        operator_file = {
            "operator": "IAM",
            "path": "/tmp/IAM.txt",
            "fileName": "IAM.txt",
            "rows": [
                {
                    "_dt": start,
                    "time": start.isoformat(),
                    "measurementTitle": "DT1",
                    "appDlMbps": 180.0,
                    "servingTechnology": "LTE UL+DL CA",
                    "packetTechnology": "LTE UL+DL CA",
                },
                {
                    "_dt": end,
                    "time": end.isoformat(),
                    "measurementTitle": "DT1",
                    "appDlMbps": 220.0,
                    "servingTechnology": "LTE UL+DL CA",
                    "packetTechnology": "LTE UL+DL CA",
                },
            ],
            "orderedDtTitles": ["DT1"],
            "rowsByMeasurementTitle": {},
            "transferSessions": [
                {
                    "id": "IAM_X001",
                    "direction": "Downlink",
                    "measurementTitle": "DT1",
                    "startTime": start.isoformat(),
                    "endTime": end.isoformat(),
                }
            ],
        }

        dataset = server._benchmark_nemo_build_dataset(
            [operator_file],
            dl_mode="app_rate_dl",
            window_mode="active_dl_session",
        )

        ops = dataset.get("operators") or []
        self.assertEqual(len(ops), 1)
        self.assertEqual(len(ops[0].get("transferSessions") or []), 1)
        self.assertEqual(ops[0]["transferSessions"][0]["startTime"], start.isoformat())
        self.assertEqual(ops[0]["transferSessions"][0]["endTime"], end.isoformat())

    def test_active_dl_window_keeps_session_stats_from_full_dt_rows(self):
        base = datetime(2026, 5, 8, 8, 40, 0)
        download_start = base + timedelta(seconds=20)
        download_end = base + timedelta(seconds=26)
        rows = [
            self._nemo_event_row(base + timedelta(seconds=0), "DAA"),
            self._nemo_event_row(base + timedelta(seconds=0.1), "DAC"),
            self._nemo_event_row(base + timedelta(seconds=0.2), "DREQ"),
            {
                "_dt": base + timedelta(seconds=0.5),
                "time": (base + timedelta(seconds=0.5)).isoformat(),
                "measurementTitle": "DT1",
                "applicationProtocol": "ICMP Ping",
                "transferStatus": "Success",
            },
            self._nemo_event_row(base + timedelta(seconds=1.0), "DCOMP"),
            self._nemo_event_row(base + timedelta(seconds=1.1), "DAD"),
            self._nemo_event_row(base + timedelta(seconds=10.0), "DAA"),
            self._nemo_event_row(base + timedelta(seconds=10.1), "DAC"),
            self._nemo_event_row(base + timedelta(seconds=10.2), "DREQ"),
            {
                "_dt": base + timedelta(seconds=11.0),
                "time": (base + timedelta(seconds=11.0)).isoformat(),
                "measurementTitle": "DT1",
                "dataTransferDirection": "Uplink",
                "applicationProtocol": "HTTP",
                "bytesUl": 50_000_000.0,
                "transferStatus": "Success",
            },
            self._nemo_event_row(base + timedelta(seconds=13.0), "DCOMP"),
            self._nemo_event_row(base + timedelta(seconds=13.1), "DAD"),
            self._nemo_event_row(base + timedelta(seconds=19.7), "DAA"),
            self._nemo_event_row(base + timedelta(seconds=19.9), "DAC"),
            self._nemo_event_row(
                base + timedelta(seconds=20.0),
                "DREQ",
                dataTransferDirection="Downlink",
                applicationProtocol="HTTP",
                bytesDl=0.0,
                fileSizeBytes=200_000_000.0,
            ),
            {
                "_dt": download_start,
                "time": download_start.isoformat(),
                "measurementTitle": "DT1",
                "dataTransferDirection": "Downlink",
                "applicationProtocol": "HTTP",
                "bytesDl": 25_000_000.0,
                "appDlMbps": 120.0,
                "downloadTimeS": 6.0,
                "dlPrbPct": 10.0,
                "caTotalBwMhz": 20.0,
                "primaryBwMhz": 20.0,
                "rsrpNr": -90.0,
                "sinrNr": 12.0,
                "totalMacDlMbps": 130.0,
                "macDl5gMbps": 119.6,
                "macDlLteMbps": 10.4,
                "pdschDl5gMbps": 110.4,
                "pdschDlLteMbps": 9.6,
            },
            {
                "_dt": base + timedelta(seconds=23.0),
                "time": (base + timedelta(seconds=23.0)).isoformat(),
                "measurementTitle": "DT1",
                "dataTransferDirection": "Downlink",
                "applicationProtocol": "HTTP",
                "bytesDl": 140_000_000.0,
                "appDlMbps": 220.0,
                "dlPrbPct": 12.0,
                "caTotalBwMhz": 20.0,
                "primaryBwMhz": 20.0,
                "rsrpNr": -89.0,
                "sinrNr": 13.0,
                "totalMacDlMbps": 235.0,
                "macDl5gMbps": 216.2,
                "macDlLteMbps": 18.8,
                "pdschDl5gMbps": 202.4,
                "pdschDlLteMbps": 17.6,
            },
            {
                "_dt": download_end,
                "time": download_end.isoformat(),
                "measurementTitle": "DT1",
                "dataTransferDirection": "Downlink",
                "applicationProtocol": "HTTP",
                "bytesDl": 200_000_000.0,
                "appDlMbps": 180.0,
                "downloadTimeS": 6.0,
                "transferStatus": "Success",
                "dlPrbPct": 11.0,
                "caTotalBwMhz": 20.0,
                "primaryBwMhz": 20.0,
                "rsrpNr": -88.0,
                "sinrNr": 13.0,
                "totalMacDlMbps": 195.0,
                "macDl5gMbps": 179.4,
                "macDlLteMbps": 15.6,
                "pdschDl5gMbps": 165.6,
                "pdschDlLteMbps": 14.4,
            },
            self._nemo_event_row(base + timedelta(seconds=26.0), "DCOMP"),
            self._nemo_event_row(base + timedelta(seconds=26.2), "DAD"),
        ]
        operator_file = {
            "operator": "IAM",
            "path": "/tmp/IAM.txt",
            "fileName": "IAM.txt",
            "rows": rows,
            "orderedDtTitles": ["DT1"],
            "measurementTitles": ["DT1"],
            "rowsByMeasurementTitle": {"DT1": rows},
            "transferSessions": [
                {
                    "id": "IAM_X001",
                    "direction": "Downlink",
                    "measurementTitle": "DT1",
                    "startTime": download_start.isoformat(),
                    "endTime": download_end.isoformat(),
                }
            ],
        }

        scoped = server._benchmark_nemo_scope_operator_file_to_window(
            operator_file,
            "active_dl_session",
        )
        dataset = server._benchmark_nemo_build_dataset(
            [scoped],
            dl_mode="app_rate_dl",
            window_mode="active_dl_session",
        )

        timeline = (dataset.get("charts") or {}).get("dlTimelineByMetric") or {}
        iam = timeline.get("IAM") or {}
        session_kpis = ((iam.get("sessionStats") or {}).get("kpis")) or {}

        self.assertTrue(session_kpis.get("dlSuccess"))
        self.assertTrue(session_kpis.get("ulSuccess"))
        self.assertEqual(session_kpis.get("pingCount"), 1)
        self.assertEqual(session_kpis.get("pingSuccessCount"), 1)
        self.assertIsNotNone((iam.get("downloadEventKpis") or {}).get("dlAppRateMbps"))

    def test_merge_technology_status_uses_download_breakdown_in_active_dl_window(self):
        merged = server._nemo_merge_technology_status_with_serving_cells(
            {
                "operator": "IAM",
                "nrPresencePct": 40.0,
                "lteOnlyPresencePct": 60.0,
                "nrPresenceSeconds": 40,
                "lteOnlySeconds": 60,
                "totalPresenceSeconds": 100,
            },
            {
                "radioPresenceBreakdownAll": {"5G": 80.0, "4G": 20.0},
                "radioPresenceBreakdownDownload": {"5G": 25.0, "4G": 75.0},
                "cells": [
                    {"tech": "5G", "dwellSec": 80.0, "dwellSecDownload": 5.0},
                    {"tech": "4G", "dwellSec": 20.0, "dwellSecDownload": 15.0},
                ],
            },
            window_mode="active_dl_session",
        )

        self.assertEqual(merged["nrPresencePct"], 25.0)
        self.assertEqual(merged["lteOnlyPresencePct"], 75.0)
        self.assertEqual(merged["nrPresenceSeconds"], 5.0)
        self.assertEqual(merged["lteOnlySeconds"], 15.0)
        self.assertEqual(merged["totalPresenceSeconds"], 20.0)

    def test_build_dataset_technology_status_section_uses_scoped_operator_payload(self):
        start = datetime(2026, 5, 8, 8, 40, 11, 188000)
        end = datetime(2026, 5, 8, 8, 40, 17, 206000)
        operator_file = {
            "operator": "IAM",
            "path": "/tmp/IAM.txt",
            "fileName": "IAM.txt",
            "rows": [
                {
                    "_dt": start,
                    "time": start.isoformat(),
                    "measurementTitle": "DT1",
                    "appDlMbps": 180.0,
                    "servingTechnology": "LTE UL+DL CA",
                    "packetTechnology": "LTE UL+DL CA",
                },
                {
                    "_dt": end,
                    "time": end.isoformat(),
                    "measurementTitle": "DT1",
                    "appDlMbps": 220.0,
                    "servingTechnology": "EN-DC",
                    "packetTechnology": "EN-DC",
                    "nrChannelNumber": 620000,
                    "band": "n1",
                },
            ],
            "orderedDtTitles": ["DT1"],
            "rowsByMeasurementTitle": {},
            "technologyStatus": {
                "operator": "IAM",
                "nrPresencePct": 99.0,
                "lteOnlyPresencePct": 1.0,
                "nrPresenceSeconds": 99,
                "lteOnlySeconds": 1,
                "totalPresenceSeconds": 100,
            },
            "transferSessions": [
                {
                    "id": "IAM_X001",
                    "direction": "Downlink",
                    "measurementTitle": "DT1",
                    "startTime": start.isoformat(),
                    "endTime": end.isoformat(),
                }
            ],
        }

        dataset = server._benchmark_nemo_build_dataset(
            [operator_file],
            dl_mode="app_rate_dl",
            window_mode="active_dl_session",
        )

        section_rows = ((dataset.get("technologyStatus") or {}).get("operators") or [])
        payload_rows = dataset.get("operators") or []
        self.assertEqual(len(section_rows), 1)
        self.assertEqual(len(payload_rows), 1)
        self.assertEqual(
            section_rows[0].get("nrPresencePct"),
            (payload_rows[0].get("technologyStatus") or {}).get("nrPresencePct"),
        )


if __name__ == "__main__":
    unittest.main()

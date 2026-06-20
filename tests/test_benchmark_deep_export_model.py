import io
import unittest

import openpyxl

import server


class BenchmarkDeepExportModelTests(unittest.TestCase):
    def _dataset_fixture(self):
        return {
            "dtList": [{"index": 0, "label": "DT 1 — 26May13_143802"}],
            "sourceFiles": [
                {"fileName": "Kenitra-IAM.txt"},
                {"fileName": "Kenitra-Orange.txt"},
                {"fileName": "Kenitra-INWI.txt"},
            ],
            "transferSummary": [
                {"operator": "IAM", "direction": "DL", "avgCompletionPct": 100.0, "successRate": 100.0},
                {"operator": "Orange", "direction": "DL", "avgCompletionPct": 100.0, "successRate": 100.0},
                {"operator": "INWI", "direction": "DL", "avgCompletionPct": 100.0, "successRate": 100.0},
            ],
            "nrBandExposureAnalysis": {
                "rows": [
                    {"operator": "IAM", "n78Share": 0.0, "n28Share": 100.0},
                    {"operator": "Orange", "n78Share": 100.0, "n28Share": 0.0},
                ]
            },
            "mimoRankAnalysis": {
                "rows": [
                    {"operator": "IAM", "ri1Share": 44.8, "ri2Share": 55.2, "riGe3Share": 0.0},
                    {"operator": "Orange", "ri1Share": 4.3, "ri2Share": 94.9, "riGe3Share": 0.9},
                ]
            },
            "blerRetxAnalysis": {
                "rows": [
                    {"operator": "IAM", "blerAvg": 5.0, "blerP90": 15.2, "blerGt10Share": 22.8, "blerGt20Share": 2.8},
                    {"operator": "Orange", "blerAvg": 1.8, "blerP90": 8.4, "blerGt10Share": 4.3, "blerGt20Share": 0.0},
                ]
            },
            "transportGapAnalysis": {
                "rows": [
                    {"operator": "IAM", "pdschDlAvg": 11.3, "tcpHandshakeMedian": 81.0, "pingSuccessRate": 50.0},
                    {"operator": "Orange", "pdschDlAvg": 43.0, "tcpHandshakeMedian": 67.0, "pingSuccessRate": 50.0},
                    {"operator": "INWI", "pdschDlAvg": None, "tcpHandshakeMedian": 65.0, "pingSuccessRate": None},
                ]
            },
            "caScellsAnalysis": {
                "rows": [
                    {"operator": "IAM", "avgScells": 0.39, "maxScells": 2.0, "scellsActiveShare": 23.7, "lteCaActiveShare": 24.0},
                    {"operator": "Orange", "avgScells": 0.38, "maxScells": 2.0, "scellsActiveShare": 19.1, "lteCaActiveShare": 19.7},
                    {"operator": "INWI", "avgScells": 1.83, "maxScells": 4.0, "scellsActiveShare": 60.0, "lteCaActiveShare": 60.0},
                ]
            },
            "iamServingCells": {
                "episodesAll": [
                    {"cellName": "4G_RAB_CHF_Rabat_Kenitra3_1008906"},
                    {"cellName": "4G_RAB_CHF_Rabat_Kenitra3_1008903"},
                    {"cellName": "5G_KEN_SidiTaibiForetII_510124311"},
                ]
            },
            "operators": [
                {
                    "operator": "IAM",
                    "kpis": {
                        "dl": {"average": 66.2},
                        "rsrp": {"median": -97.6},
                        "sinr": {"median": 2.6},
                        "cqi": {"median": 8.0},
                        "pdschMcs": {"median": 6.0},
                        "pdschModulation": {"qam256Share": 0.0, "qam64Share": 19.3, "qam16Share": 63.0, "qpskShare": 17.6},
                        "nrPresencePct": 58.0,
                        "lteOnlyPresencePct": 42.0,
                        "scheduledRank": {"median": 1.0},
                    },
                },
                {
                    "operator": "Orange",
                    "kpis": {
                        "dl": {"average": 143.5},
                        "rsrp": {"median": -99.5},
                        "sinr": {"median": 1.9},
                        "cqi": {"median": 10.0},
                        "pdschMcs": {"median": 0.0},
                        "pdschModulation": {"qam256Share": 0.0, "qam64Share": 16.9, "qam16Share": 12.3, "qpskShare": 70.8},
                        "nrPresencePct": 49.2,
                        "lteOnlyPresencePct": 50.8,
                        "scheduledRank": {"median": 2.0},
                    },
                },
                {
                    "operator": "INWI",
                    "kpis": {
                        "dl": {"average": 35.3},
                        "nrPresencePct": 0.0,
                        "lteOnlyPresencePct": 100.0,
                        "scheduledRank": {"median": None},
                    },
                },
            ],
        }

    def test_export_model_matches_reference_shape(self):
        dataset = self._dataset_fixture()

        model = server._benchmark_deep_export_model(dataset)

        self.assertEqual(model["execSummary"]["title"], "Kenitra DT1 - IAM Professional Analysis")
        self.assertEqual(len(model["kpiBenchmark"]), 29)
        self.assertNotIn("Median MCS", [row["kpi"] for row in model["kpiBenchmark"]])
        median_rank = next(row for row in model["kpiBenchmark"] if row["kpi"] == "Median Rank")
        self.assertEqual(median_rank["iam"], 1.0)
        self.assertEqual(median_rank["orange"], 2.0)
        self.assertEqual(len(model["actionPlan"]), 10)
        self.assertEqual(
            [row["domain"] for row in model["actionPlan"][:4]],
            ["5G capacity layer", "MIMO / RI", "SINR / interference", "Scheduler / PRB efficiency"],
        )
        self.assertEqual(model["actionPlan"][-1]["domain"], "Retest governance")

    def test_export_model_uses_transport_ul_retx_not_bler_gt20_share(self):
        dataset = self._dataset_fixture()
        dataset["transportGapAnalysis"]["rows"][0]["ulRetxAvg"] = 1.4
        dataset["transportGapAnalysis"]["rows"][1]["ulRetxAvg"] = 0.2

        model = server._benchmark_deep_export_model(dataset)

        ul_retx = next(row for row in model["kpiBenchmark"] if row["kpi"] == "UL Retx Avg %")
        self.assertEqual(ul_retx["iam"], 1.4)
        self.assertEqual(ul_retx["orange"], 0.2)

    def test_deep_extract_keeps_lte_ca_active_separate_from_scells_active(self):
        iam = server._deep_extract(
            {
                "scellsActiveShare": 23.7,
                "lteCaActiveShare": 41.0,
            },
            {},
            "IAM",
        )

        self.assertEqual(iam["scellsActive"], 23.7)
        self.assertEqual(iam["caActive"], 41.0)

    def test_export_model_reuses_deep_benchmark_action_plan_when_available(self):
        dataset = self._dataset_fixture()
        deep = {
            "execSummary": {
                "title": "DT 1 - IAM Professional Analysis",
                "scope": "IAM only",
                "mainConclusion": "Dynamic conclusion",
                "topKpis": [
                    {
                        "kpi": "DL Throughput",
                        "iam": "66.2 Mbps",
                        "bestCompetitor": "Orange 143.5 Mbps",
                        "gap": "IAM is 53.9% lower",
                    }
                ],
                "immediatePriorities": "1) Dynamic priority",
            },
            "kpiBenchmark": [
                {
                    "kpi": "DL Throughput (Mbps)",
                    "iam": 66.2,
                    "orange": 143.5,
                    "inwi": 35.3,
                    "vsOrange": "-53.9%",
                    "vsInwi": "+87.5%",
                    "interpretation": "Dynamic KPI row",
                }
            ],
            "actionPlan": [
                {
                    "priority": "P1",
                    "domain": "Capacity / configuration",
                    "finding": "Dynamic finding",
                    "recommendedActions": ["Action A"],
                    "owner": "Optimization",
                    "expectedImpact": "Impact",
                    "validationTarget": "Target",
                }
            ],
        }

        model = server._benchmark_deep_export_model(dataset, deep)

        self.assertEqual(model["execSummary"]["mainConclusion"], "Dynamic conclusion")
        self.assertEqual(model["kpiBenchmark"][0]["interpretation"], "Dynamic KPI row")
        self.assertEqual(model["actionPlan"][0]["domain"], "Capacity / configuration")

    def test_export_model_preserves_merged_capacity_row_metadata(self):
        dataset = self._dataset_fixture()
        deep = {
            "execSummary": {"title": "DT 1 - IAM Professional Analysis"},
            "kpiBenchmark": [],
            "actionPlan": [
                {
                    "priority": "P1",
                    "domain": "5G capacity layer",
                    "finding": "Active DL session is LTE-dominated and n78 is missing.",
                    "recommendedActions": ["Analyze EN-DC addition/release during active DL transfer."],
                    "subCauses": ["NR n78 share = 0%", "NR n1 share = 100% of NR samples"],
                    "excludedChecks": ["MIMO rank is acceptable for this DT."],
                }
            ],
        }

        model = server._benchmark_deep_export_model(dataset, deep)

        self.assertEqual(model["actionPlan"][0]["domain"], "5G capacity layer")
        self.assertIn("subCauses", model["actionPlan"][0])
        self.assertIn("excludedChecks", model["actionPlan"][0])
        self.assertEqual(model["actionPlan"][0]["subCauses"][0], "NR n78 share = 0%")
        self.assertIn("blerEvents", model["actionPlan"][0])

    def test_export_model_guarantees_metadata_keys_when_absent(self):
        dataset = self._dataset_fixture()
        deep = {
            "execSummary": {"title": "DT 1 - IAM Professional Analysis"},
            "kpiBenchmark": [],
            "actionPlan": [
                {"priority": "P2", "domain": "Transport / core", "finding": "TCP handshake is high."}
            ],
        }

        model = server._benchmark_deep_export_model(dataset, deep)
        row = model["actionPlan"][0]
        self.assertEqual(row["subCauses"], [])
        self.assertEqual(row["excludedChecks"], [])
        self.assertEqual(row["blerEvents"], [])

    def test_export_model_preserves_detailed_analysis(self):
        dataset = self._dataset_fixture()
        deep = {
            "execSummary": {"title": "DT 1 - IAM Professional Analysis"},
            "kpiBenchmark": [],
            "actionPlan": [],
            "detailedAnalysis": [
                {
                    "domain": "RF quality",
                    "severity": "High",
                    "summary": "RF block",
                    "metrics": [
                        {
                            "label": "Median SINR",
                            "iam": 3.0,
                            "orange": 11.0,
                            "inwi": 7.0,
                            "interpretation": "IAM is weakest",
                        }
                    ],
                    "evidence": ["SINR is low while RSRP is acceptable."],
                    "explanation": "Professional explanation.",
                    "targetedActions": [
                        {
                            "action": "Audit interference",
                            "rationale": "Low SINR is the limiting metric.",
                        }
                    ],
                }
            ],
        }

        model = server._benchmark_deep_export_model(dataset, deep)

        self.assertEqual(model["detailedAnalysis"][0]["domain"], "RF quality")

    def test_generate_benchmark_deep_xlsx_adds_detailed_analysis_sheet(self):
        dataset = self._dataset_fixture()
        deep = server._benchmark_deep_export_model(dataset)
        deep["detailedAnalysis"] = [
            {
                "domain": "RF quality",
                "severity": "High",
                "summary": "RF",
                "metrics": [],
                "evidence": [],
                "explanation": "Explanation",
                "targetedActions": [],
            }
        ]

        payload = server.generate_benchmark_deep_xlsx(deep, dataset)
        workbook = openpyxl.load_workbook(io.BytesIO(payload))

        self.assertIn("Detailed Analysis", workbook.sheetnames)


if __name__ == "__main__":
    unittest.main()

import unittest

from lte_serving_neighbors import build_serving_neighbors_index


def _recfg_event(time_iso: str):
    return {
        "time": time_iso,
        "event_name": "Message.Layer3.Errc.DcchDl.RrcConnectionReconfiguration",
        "params": [
            {"param_id": "rrc_recfg_tgt_pci", "param_value": 56},
            {"param_id": "rrc_recfg_tgt_earfcn", "param_value": 1320},
        ],
        "decoded": {
            "message": {
                "c1": {
                    "rrcConnectionReconfiguration": {
                        "criticalExtensions": {
                            "c1": {
                                "rrcConnectionReconfiguration-r8": {
                                    "measConfig": {
                                        "measIdToAddModList": [
                                            {"measId": 12, "measObjectId": 2, "reportConfigId": 12}
                                        ],
                                        "measObjectToAddModList": [
                                            {
                                                "measObjectId": 2,
                                                "measObject": {
                                                    "measObjectEUTRA": {
                                                        "carrierFreq": 1320,
                                                        "cellsToAddModList": [
                                                            {"cellIndex": 1, "physCellId": 147}
                                                        ],
                                                    }
                                                },
                                            }
                                        ],
                                        "reportConfigToAddModList": [
                                            {
                                                "reportConfigId": 12,
                                                "reportConfig": {
                                                    "reportConfigEUTRA": {
                                                        "triggerType": {
                                                            "event": {
                                                                "eventId": {"eventA3": {"a3-Offset": 2}}
                                                            }
                                                        }
                                                    }
                                                },
                                            }
                                        ],
                                    }
                                }
                            }
                        }
                    }
                }
            }
        },
    }


def _mr_no_neighbors(time_iso: str):
    return {
        "time": time_iso,
        "event_name": "Message.Layer3.Errc.DcchUl.MeasurementReport",
        "decoded": {
            "message": {
                "c1": {
                    "measurementReport": {
                        "criticalExtensions": {
                            "c1": {
                                "measurementReport-r8": {
                                    "measResults": {
                                        "measId": 12,
                                        "measResultPCell": {"rsrpResult": 50, "rsrqResult": 19},
                                        "measResultServFreqList-r10": [
                                            {
                                                "servFreqId-r10": 1,
                                                "measResultSCell-r10": {
                                                    "rsrpResultSCell-r10": 49,
                                                    "rsrqResultSCell-r10": 21,
                                                },
                                            }
                                        ],
                                    }
                                }
                            }
                        }
                    }
                }
            }
        },
    }


def _mr_with_neighbors(time_iso: str, pci: int = 147, rsrp_idx: int = 60, rsrq_idx: int = 20):
    return {
        "time": time_iso,
        "event_name": "Message.Layer3.Errc.DcchUl.MeasurementReport",
        "decoded": {
            "message": {
                "c1": {
                    "measurementReport": {
                        "criticalExtensions": {
                            "c1": {
                                "measurementReport-r8": {
                                    "measResults": {
                                        "measId": 12,
                                        "measResultPCell": {"rsrpResult": 55, "rsrqResult": 20},
                                        "measResultNeighCells": {
                                            "measResultListEUTRA": [
                                                {
                                                    "physCellId": pci,
                                                    "measResult": {
                                                        "rsrpResult": rsrp_idx,
                                                        "rsrqResult": rsrq_idx,
                                                    },
                                                }
                                            ]
                                        },
                                    }
                                }
                            }
                        }
                    }
                }
            }
        },
    }


def _recfg_event_utra_config(time_iso: str):
    return {
        "time": time_iso,
        "event_name": "Message.Layer3.Errc.DcchDl.RrcConnectionReconfiguration",
        "decoded": {
            "message": {
                "c1": {
                    "rrcConnectionReconfiguration": {
                        "criticalExtensions": {
                            "c1": {
                                "rrcConnectionReconfiguration-r8": {
                                    "measConfig": {
                                        "measObjectToAddModList": [
                                            {
                                                "measObjectId": 7,
                                                "measObject": {
                                                    "measObjectUTRA": {
                                                        "carrierFreq": 10663,
                                                        "cellsToAddModList": [
                                                            {"cellIndex": 1, "physCellId": {"fdd": 313}}
                                                        ],
                                                    }
                                                },
                                            }
                                        ]
                                    }
                                }
                            }
                        }
                    }
                }
            }
        },
    }


def _mr_with_utra_list_at_root(time_iso: str):
    return {
        "time": time_iso,
        "event_name": "Message.Layer3.Errc.DcchUl.MeasurementReport",
        "decoded": {
            "message": {
                "c1": {
                    "measurementReport": {
                        "criticalExtensions": {
                            "c1": {
                                "measurementReport-r8": {
                                    "measResults": {
                                        "measId": 12,
                                        # Some decodes expose UTRA list directly under measResults.
                                        "measResultListUTRA": [
                                            {
                                                "physCellId": {"fdd": 111},
                                                "carrierFreq": 10613,
                                                "measResult": {"rscp": 60, "ecNo": 20},
                                            }
                                        ],
                                    }
                                }
                            }
                        }
                    }
                }
            }
        },
    }


class ServingNeighborsIndexTests(unittest.TestCase):
    def test_configured_neighbor_exists_when_mr_has_no_neighbor_list(self):
        events = [
            _recfg_event("2025-12-04T11:30:32.810Z"),
            _mr_no_neighbors("2025-12-04T11:30:32.810Z"),
        ]
        idx = build_serving_neighbors_index(events)
        out = idx.getServingNeighborsAt("2025-12-04T11:30:32.810Z", windowMs=2000)

        self.assertEqual(out["time"], "2025-12-04T11:30:32.810000Z")
        self.assertEqual(out["serving"]["earfcn"], 1320)
        self.assertEqual(out["serving"]["pci"], 56)
        self.assertEqual(out["serving"]["rsrp_idx"], 50)
        self.assertEqual(out["serving"]["rsrq_idx"], 19)
        self.assertEqual(out["serving"]["rsrp_dbm"], -90.0)
        self.assertEqual(out["serving"]["rsrq_db"], -10.0)

        # Rule: no neigh list in MR -> measured list must be empty.
        self.assertEqual(out["neighbors_measured"], [])
        self.assertEqual(out["neighbors_measured_nearest"], [])

        # Configured neighbor candidate from cellsToAddModList.
        self.assertEqual(len(out["neighbors_configured"]), 1)
        cfg = out["neighbors_configured"][0]
        self.assertEqual(cfg["source"], "CONFIG")
        self.assertEqual(cfg["rat"], "LTE")
        self.assertEqual(cfg["earfcn"], 1320)
        self.assertEqual(cfg["pci"], 147)
        self.assertEqual(cfg["type"], "intra-frequency")
        self.assertIsNone(cfg["rsrp_dbm"])
        self.assertIsNone(cfg["rsrq_db"])

        self.assertEqual(out["debug"]["measIdUsed"], 12)
        self.assertEqual(out["debug"]["measObjectIdUsed"], 2)
        self.assertEqual(out["debug"]["reportConfigIdUsed"], 12)

    def test_nearest_mr_fallback_with_delta_and_source(self):
        events = [
            _recfg_event("2025-12-04T11:30:32.810Z"),
            _mr_no_neighbors("2025-12-04T11:30:32.810Z"),
            _mr_with_neighbors("2025-12-04T11:30:34.000Z", pci=147, rsrp_idx=61, rsrq_idx=21),
        ]
        idx = build_serving_neighbors_index(events)
        out = idx.getServingNeighborsAt("2025-12-04T11:30:33.200Z", windowMs=2000)

        self.assertEqual(out["neighbors_measured"], [])
        self.assertEqual(len(out["neighbors_measured_nearest"]), 1)
        n = out["neighbors_measured_nearest"][0]
        self.assertEqual(n["source"], "MR_NEAREST")
        self.assertEqual(n["measured_time"], "2025-12-04T11:30:34Z")
        self.assertEqual(n["delta_ms"], 800)
        self.assertEqual(n["earfcn"], 1320)
        self.assertEqual(n["pci"], 147)
        self.assertEqual(n["type"], "intra-frequency")
        self.assertEqual(n["rsrp_idx"], 61)
        self.assertEqual(n["rsrq_idx"], 21)
        self.assertEqual(n["rsrp_dbm"], -79.0)
        self.assertEqual(n["rsrq_db"], -9.0)

    def test_merge_prefers_measured_over_configured_same_key(self):
        events = [
            _recfg_event("2025-12-04T11:30:32.810Z"),
            _mr_with_neighbors("2025-12-04T11:30:32.810Z", pci=147, rsrp_idx=65, rsrq_idx=22),
        ]
        idx = build_serving_neighbors_index(events)
        out = idx.getServingNeighborsAt("2025-12-04T11:30:32.810Z", windowMs=2000)
        merged = out["neighbors_merged"]
        self.assertEqual(len(merged), 1)
        m = merged[0]
        self.assertEqual(m["source"], "MR")
        self.assertEqual(m["pci"], 147)
        self.assertEqual(m["earfcn"], 1320)
        self.assertEqual(m["rsrp_dbm"], -75.0)
        self.assertEqual(m["rsrq_db"], -8.5)

    def test_configured_utra_cells_parse_object_physcellid(self):
        events = [
            _recfg_event_utra_config("2025-12-04T11:30:32.810Z"),
            _mr_no_neighbors("2025-12-04T11:30:32.810Z"),
        ]
        idx = build_serving_neighbors_index(events)
        out = idx.getServingNeighborsAt("2025-12-04T11:30:32.810Z", windowMs=2000)
        utra_cfg = [n for n in (out.get("neighbors_configured") or []) if str(n.get("rat")).upper() == "UTRA"]
        self.assertEqual(len(utra_cfg), 1)
        self.assertEqual(utra_cfg[0].get("psc"), 313)
        self.assertEqual(utra_cfg[0].get("uarfcn"), 10663)
        self.assertEqual(utra_cfg[0].get("source"), "CONFIG")

    def test_utra_measured_list_detected_when_not_under_neighcells(self):
        events = [
            _recfg_event("2025-12-04T11:30:32.810Z"),
            _mr_with_utra_list_at_root("2025-12-04T11:30:34.000Z"),
        ]
        idx = build_serving_neighbors_index(events)
        out = idx.getServingNeighborsAt("2025-12-04T11:30:34.000Z", windowMs=2000)
        utra_meas = [n for n in (out.get("neighbors_measured") or []) if str(n.get("rat")).upper() == "UTRA"]
        self.assertEqual(len(utra_meas), 1)
        self.assertEqual(utra_meas[0].get("psc"), 111)
        self.assertEqual(utra_meas[0].get("uarfcn"), 10613)
        self.assertEqual(utra_meas[0].get("rscp_idx"), 60)
        self.assertEqual(utra_meas[0].get("ecno_idx"), 20)
        self.assertEqual(utra_meas[0].get("source"), "MR")


if __name__ == "__main__":
    unittest.main()

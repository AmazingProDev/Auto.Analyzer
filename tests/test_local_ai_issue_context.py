import unittest

from local_ai.issue_context import engineer_issue_context


class IssueContextEngineeringTests(unittest.TestCase):
    def test_unspecified_release_stays_conservative(self):
        text = "\n".join(
            [
                "# Telecom issue bundle for local AI",
                "Issue type: Drop Call",
                "Technology: LTE",
                "Event time: 00:20:49.260",
                "Failure reason cause: unspecified",
                "",
                "## Signaling context",
                "- time=00:20:48.980 | event=RRC_MEASUREMENT_REPORT | message=serving quality stable",
                "- time=00:20:49.260 | event=RRC_CONNECTION_RELEASE | releaseCause=unspecified",
                "",
                "## Radio context",
                "- time=00:20:48.900 | rsrp=-92 | rsrq=-9",
                "- time=00:20:49.020 | rsrp=-93 | rsrq=-10",
                "- time=00:20:49.180 | rsrp=-92 | rsrq=-10",
            ]
        )

        engineered = engineer_issue_context(text)

        self.assertTrue(engineered["is_issue_bundle"])
        self.assertEqual(engineered["rat_guess"], "4G")
        self.assertEqual(engineered["dominant_failure_domain"], "policy_or_network_release")
        self.assertEqual(engineered["confidence_ceiling"], "low")
        self.assertIn("unspecified", " ".join(engineered["limitations"]).lower())

    def test_radio_degradation_pushes_radio_domain(self):
        text = "\n".join(
            [
                "# Telecom issue bundle for local AI",
                "Issue type: Drop Call",
                "Technology: LTE",
                "Event time: 00:20:49.260",
                "",
                "## Signaling context",
                "- time=00:20:48.700 | event=RRC_MEASUREMENT_REPORT | message=neighbor weak",
                "- time=00:20:49.260 | event=RRC_CONNECTION_RELEASE | releaseCause=otherFailure",
                "",
                "## Radio context",
                "- time=00:20:48.700 | rsrp=-101 | rsrq=-11",
                "- time=00:20:48.900 | rsrp=-108 | rsrq=-14",
                "- time=00:20:49.050 | rsrp=-114 | rsrq=-17",
                "- time=00:20:49.200 | rsrp=-116 | rsrq=-18 | blerDl=12",
            ]
        )

        engineered = engineer_issue_context(text)

        self.assertEqual(engineered["rat_guess"], "4G")
        self.assertIn(engineered["dominant_failure_domain"], {"radio_coverage", "radio_interference"})
        self.assertNotEqual(engineered["confidence_ceiling"], "low")
        self.assertTrue(engineered["evidence"])

    def test_active_set_failure_is_interpreted_as_umts_with_precursor_gap(self):
        text = "\n".join(
            [
                "# Telecom issue bundle for local AI",
                "Issue type: Drop Call",
                "Technology: LTE",
                "Event time: 00:09:21.955",
                "Point snapshot: time=00:09:21.955 | event=DROP_EVENT",
                "Compact procedure timeline: ACTIVE_SET_UPDATE_FAILURE -> DROP_EVENT",
                "",
                "## Signaling context",
                "- time=00:09:10.077 | event=ACTIVE_SET_UPDATE_FAILURE | message=active set update failure",
                "- time=00:09:21.955 | event=DROP_EVENT | message=call released",
                "",
                "## Radio context",
                "- time=00:09:20.879 | servingSc=123 | rscp=-101.1 | ecno=-15.8",
                "- time=00:09:22.500 | servingSc=123 | rscp=-105.8 | ecno=-18.4",
                "- time=00:09:23.276 | servingSc=123 | rscp=-107.9 | ecno=-20.3",
            ]
        )

        engineered = engineer_issue_context(text)

        self.assertEqual(engineered["rat_guess"], "3G")
        self.assertEqual(engineered["procedure_family"], "umts")
        self.assertAlmostEqual(engineered["trigger_to_terminal_seconds"], 11.878, places=3)
        self.assertIn("precursor", " ".join(engineered["anomalies"]).lower())
        self.assertTrue(any("active-set" in item.lower() or "active set" in item.lower() for item in engineered["next_checks"]))
        self.assertTrue(any("umts" in item.lower() for item in engineered["limitations"]))

    def test_neighbor_better_than_serving_adds_umts_mobility_anomaly(self):
        text = "\n".join(
            [
                "# Telecom issue bundle for local AI",
                "Issue type: Drop Call",
                "Technology: LTE",
                "Event time: 00:09:21.955",
                "Point snapshot: time=00:09:21.955 | event=DROP_EVENT",
                "Compact procedure timeline: ACTIVE_SET_UPDATE_FAILURE -> DROP_EVENT",
                "",
                "## Signaling context",
                "- time=00:09:10.077 | event=ACTIVE_SET_UPDATE_FAILURE | message=active set update failure",
                "- time=00:09:21.955 | event=DROP_EVENT | message=call released",
                "",
                "## Radio context",
                "- time=00:09:20.879 | servingSc=123 | rscp=-101.1 | ecno=-15.8",
                "- time=00:09:22.500 | servingSc=123 | rscp=-105.8 | ecno=-18.4",
                "- time=00:09:23.276 | servingSc=123 | rscp=-107.9 | ecno=-20.3",
                "",
                "## Neighbor context",
                "- time=00:09:20.879 | servingSc=123 | bestNeighborSc=321 | bestNeighborType=A2 | bestNeighborRscpDbm=-98.0 | bestNeighborEcnoDb=-12.0 | bestNeighborDeltaRscpDb=3.1 | bestNeighborDeltaEcnoDb=3.8 | bestNeighborBetterThanServing=true | within3DbCount=2 | strongerNeighborCount=1",
                "- time=00:09:22.500 | servingSc=123 | bestNeighborSc=321 | bestNeighborType=A2 | bestNeighborRscpDbm=-101.5 | bestNeighborEcnoDb=-14.0 | bestNeighborDeltaRscpDb=4.3 | bestNeighborDeltaEcnoDb=4.4 | bestNeighborBetterThanServing=true | within3DbCount=2 | strongerNeighborCount=1",
                "- time=00:09:23.276 | servingSc=123 | bestNeighborSc=321 | bestNeighborType=A2 | bestNeighborRscpDbm=-103.2 | bestNeighborEcnoDb=-15.2 | bestNeighborDeltaRscpDb=4.7 | bestNeighborDeltaEcnoDb=5.1 | bestNeighborBetterThanServing=true | within3DbCount=2 | strongerNeighborCount=1",
            ]
        )

        engineered = engineer_issue_context(text)

        self.assertIn(engineered["dominant_failure_domain"], {"mobility", "radio_coverage"})
        self.assertIn("psc 321", " ".join(engineered["evidence"]).lower())
        self.assertIn("preferable", " ".join(engineered["anomalies"]).lower())
        self.assertTrue(any("event 1a" in item.lower() or "active-set" in item.lower() or "psc 321" in item.lower() for item in engineered["next_checks"]))
        self.assertIn("psc 321", str(engineered["summary_hint"] or "").lower())
        self.assertIn("soft-handover", str(engineered["summary_hint"] or "").lower())


if __name__ == "__main__":
    unittest.main()

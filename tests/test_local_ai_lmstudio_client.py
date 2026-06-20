import json
import unittest
from unittest import mock

from local_ai.config import LocalAIConfig
from local_ai.lmstudio_client import LMStudioClient, coerce_analysis_payload


class FakeHTTPResponse:
    def __init__(self, status, payload, headers=None):
        self.status = status
        self._payload = payload
        self.headers = headers or {"Content-Type": "application/json"}

    def read(self):
        return self._payload

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False


class LMStudioClientTests(unittest.TestCase):
    def make_client(self):
        config = LocalAIConfig(
            base_url="http://localhost:1234/v1",
            model="gemma-4-e4b-it",
            timeout_sec=15,
            max_retries=1,
            max_upload_bytes=5 * 1024 * 1024,
            upload_dir="/tmp",
            keep_uploads=False,
            chunk_target_lines=160,
            chunk_overlap_lines=30,
            max_identifiers_per_type=12,
        )
        return LMStudioClient(config)

    def fake_urlopen(self, request, timeout=0):
        url = getattr(request, "full_url", str(request))
        if url.endswith("/models"):
            payload = json.dumps({"data": [{"id": "gemma-4-e4b-it"}, {"id": "other-model"}]}).encode("utf-8")
            return FakeHTTPResponse(200, payload)
        if url.endswith("/chat/completions"):
            body = json.dumps(
                {
                    "id": "chatcmpl-test",
                    "choices": [
                        {
                            "index": 0,
                            "message": {
                                "role": "assistant",
                                "content": json.dumps(
                                    {
                                        "summary": "Attach failed after NAS reject.",
                                        "trigger_event": "Attach Reject @ 2026-04-04 10:00:01",
                                        "failure_domain": "core_signaling",
                                        "key_events": ["Attach Request", "Attach Reject cause=15"],
                                        "evidence": ["NAS reject cause 15 is present in the signaling sequence."],
                                        "anomalies": ["Repeated reject cause 15"],
                                        "likely_root_cause": "Core-side reject during attach.",
                                        "confidence": "high",
                                        "confidence_rationale": "Reject cause is explicit in signaling.",
                                        "next_checks": ["Inspect MME/NAS reject mapping"],
                                        "unknown_fields_or_limitations": ["Vendor-specific IE names are not present."],
                                    }
                                ),
                            },
                        }
                    ],
                    "model": "gemma-4-e4b-it",
                }
            ).encode("utf-8")
            return FakeHTTPResponse(200, body)
        raise AssertionError(f"Unexpected URL requested: {url}")

    @mock.patch("urllib.request.urlopen")
    def test_health_and_model_check(self, mock_urlopen):
        mock_urlopen.side_effect = self.fake_urlopen
        client = self.make_client()

        health = client.health_check()
        model = client.model_check()

        self.assertTrue(health["ok"])
        self.assertEqual(health["modelCount"], 2)
        self.assertTrue(model["ok"])
        self.assertIn("gemma-4-e4b-it", model["available"])

    @mock.patch("urllib.request.urlopen")
    def test_analyze_chunk_returns_structured_payload(self, mock_urlopen):
        mock_urlopen.side_effect = self.fake_urlopen
        client = self.make_client()
        chunk = {
            "id": "chunk-001",
            "lineRange": {"start": 1, "end": 2},
            "content": "2026-04-04 10:00:00 LTE Attach Request\n2026-04-04 10:00:01 Attach Reject cause=15",
            "metadata": {
                "suspectedRat": "4G",
                "startTimestamp": "2026-04-04 10:00:00",
                "endTimestamp": "2026-04-04 10:00:01",
                "identifiers": {"imsi": ["001010123456789"]},
            },
        }

        result = client.analyze_chunk(chunk, request_id="req-test")

        self.assertEqual(result["analysis"]["confidence"], "high")
        self.assertEqual(result["analysis"]["failure_domain"], "core_signaling")
        self.assertIn("NAS reject cause 15", " ".join(result["analysis"]["evidence"]))
        self.assertEqual(result["analysis"]["likely_root_cause"], "Core-side reject during attach.")
        self.assertTrue(result["jsonRecovered"])

    def test_engineering_guardrails_cap_confidence_for_unspecified_release(self):
        payload = json.dumps(
            {
                "summary": "Drop detected after network release.",
                "trigger_event": "RRC Connection Release @ 00:20:49.260",
                "failure_domain": "policy_or_network_release",
                "key_events": ["RRC Connection Release"],
                "evidence": ["releaseCause=unspecified"],
                "anomalies": ["Terminal release observed"],
                "likely_root_cause": "Network release caused the drop.",
                "confidence": "high",
                "confidence_rationale": "The release is visible in signaling.",
                "next_checks": ["Review radio metrics before release"],
                "unknown_fields_or_limitations": [],
            }
        )
        chunk = {
            "id": "chunk-issue-001",
            "lineRange": {"start": 1, "end": 12},
            "content": "\n".join(
                [
                    "# Telecom issue bundle for local AI",
                    "Issue type: Drop Call",
                    "Technology: LTE",
                    "Event time: 00:20:49.260",
                    "Failure reason cause: unspecified",
                    "",
                    "## Signaling context",
                    "- time=00:20:49.260 | event=RRC_CONNECTION_RELEASE | releaseCause=unspecified",
                    "",
                    "## Radio context",
                    "- time=00:20:48.900 | rsrp=-92 | rsrq=-10",
                    "- time=00:20:49.050 | rsrp=-93 | rsrq=-10",
                    "- time=00:20:49.200 | rsrp=-92 | rsrq=-11",
                ]
            ),
            "metadata": {
                "suspectedRat": "4G",
                "startTimestamp": "00:20:48.900",
                "endTimestamp": "00:20:49.260",
                "identifiers": {},
            },
        }

        client = self.make_client()
        with mock.patch.object(client, "_request", return_value=(200, {}, json.dumps({"choices": [{"message": {"content": payload}}]}))):
            result = client.analyze_chunk(chunk, request_id="req-issue")

        self.assertEqual(result["analysis"]["confidence"], "low")
        self.assertEqual(result["analysis"]["failure_domain"], "policy_or_network_release")
        self.assertIn("unspecified", " ".join(result["analysis"]["unknown_fields_or_limitations"]).lower())
        self.assertIn("capped at low", " ".join(result["analysis"]["unknown_fields_or_limitations"]).lower())

    def test_active_set_failure_gets_umts_hint_and_precursor_anomaly(self):
        payload = json.dumps(
            {
                "summary": "A 4G Drop Call event occurred, immediately following an Active Set Update failure.",
                "trigger_event": "ACTIVE_SET_UPDATE_FAILURE @ 00:09:10.077",
                "failure_domain": "radio_coverage",
                "key_events": ["ACTIVE_SET_UPDATE_FAILURE", "DROP_EVENT"],
                "evidence": ["RSCP and EcNo are poor."],
                "anomalies": [],
                "likely_root_cause": "Poor radio coverage led to the drop.",
                "confidence": "medium",
                "confidence_rationale": "Radio quality is poor.",
                "next_checks": ["Check radio quality."],
                "unknown_fields_or_limitations": [],
            }
        )
        chunk = {
            "id": "chunk-issue-002",
            "lineRange": {"start": 1, "end": 14},
            "content": "\n".join(
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
            ),
            "metadata": {
                "suspectedRat": "4G",
                "startTimestamp": "00:09:20.879",
                "endTimestamp": "00:09:23.276",
                "identifiers": {},
            },
        }

        client = self.make_client()
        with mock.patch.object(client, "_request", return_value=(200, {}, json.dumps({"choices": [{"message": {"content": payload}}]}))):
            result = client.analyze_chunk(chunk, request_id="req-issue-2")

        self.assertEqual(result["analysis"]["rat_hint"], "3G")
        self.assertIn("UMTS/3G", result["analysis"]["summary"])
        self.assertIn("precursor", " ".join(result["analysis"]["anomalies"]).lower())
        self.assertTrue(any("active set" in item.lower() for item in result["analysis"]["next_checks"]))

    def test_neighbor_context_adds_better_psc_anomaly(self):
        payload = json.dumps(
            {
                "summary": "3G issue analysis. Drop follows Active Set Update failure.",
                "trigger_event": "ACTIVE_SET_UPDATE_FAILURE @ 00:09:10.077",
                "failure_domain": "radio_coverage",
                "key_events": ["ACTIVE_SET_UPDATE_FAILURE", "DROP_EVENT"],
                "evidence": ["Serving quality is poor."],
                "anomalies": [],
                "likely_root_cause": "Weak radio quality caused the drop.",
                "confidence": "medium",
                "confidence_rationale": "Radio is degraded.",
                "next_checks": ["Check radio quality."],
                "unknown_fields_or_limitations": [],
            }
        )
        chunk = {
            "id": "chunk-issue-003",
            "lineRange": {"start": 1, "end": 18},
            "content": "\n".join(
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
                ]
            ),
            "metadata": {
                "suspectedRat": "4G",
                "startTimestamp": "00:09:20.879",
                "endTimestamp": "00:09:23.276",
                "identifiers": {},
            },
        }

        client = self.make_client()
        with mock.patch.object(client, "_request", return_value=(200, {}, json.dumps({"choices": [{"message": {"content": payload}}]}))):
            result = client.analyze_chunk(chunk, request_id="req-issue-3")

        self.assertEqual(result["analysis"]["rat_hint"], "3G")
        self.assertIn("psc 321", " ".join(result["analysis"]["evidence"]).lower())
        self.assertIn("preferable", " ".join(result["analysis"]["anomalies"]).lower())
        self.assertIn("psc 321", result["analysis"]["summary"].lower())
        self.assertTrue(any("event 1a" in item.lower() or "psc" in item.lower() for item in result["analysis"]["next_checks"]))

    def test_json_fallback_recovers_malformed_output(self):
        payload, recovered = coerce_analysis_payload("Attach failed near cause=15 and the model did not return JSON.")

        self.assertFalse(recovered)
        self.assertEqual(payload["confidence"], "low")
        self.assertIn("malformed JSON", " ".join(payload["unknown_fields_or_limitations"]))
        self.assertIn("Attach failed near cause=15", payload["summary"])


if __name__ == "__main__":
    unittest.main()

import unittest

from local_ai.preprocessing import preprocess_log_text


class LocalAIPreprocessingTests(unittest.TestCase):
    def test_session_strategy_extracts_metadata_and_rat(self):
        text = (
            "2026-04-04 10:00:00.000 session_id=alpha IMSI=001010123456789 UE_ID=UE-7 LTE Attach Request cell_id=101\n"
            "2026-04-04 10:00:00.500 session_id=alpha bearer_id=5 cause_code=EMM-17 MME says reject\n"
            "2026-04-04 10:01:00.000 session_id=beta IMSI=001010123456790 UE_ID=UE-8 NR Registration Request gNB=22\n"
            "2026-04-04 10:01:00.250 session_id=beta cause_code=RLF bearer_id=9 PDU Session failed\n"
        )

        result = preprocess_log_text(text, chunk_target_lines=50, overlap_lines=5, max_identifier_values=4)

        self.assertEqual(result["segmentationStrategy"], "session")
        self.assertEqual(result["lineCount"], 4)
        self.assertEqual(len(result["chunks"]), 2)

        first_chunk = result["chunks"][0]
        self.assertEqual(first_chunk["metadata"]["startTimestamp"], "2026-04-04 10:00:00.000")
        self.assertEqual(first_chunk["metadata"]["endTimestamp"], "2026-04-04 10:00:00.500")
        self.assertEqual(first_chunk["metadata"]["suspectedRat"], "4G")
        self.assertIn("001010123456789", first_chunk["metadata"]["identifiers"]["imsi"])
        self.assertIn("UE-7", first_chunk["metadata"]["identifiers"]["ue"])
        self.assertIn("101", first_chunk["metadata"]["identifiers"]["cell"])
        self.assertIn("5", first_chunk["metadata"]["identifiers"]["bearer"])
        self.assertIn("EMM-17", first_chunk["metadata"]["identifiers"]["cause_codes"])

        second_chunk = result["chunks"][1]
        self.assertEqual(second_chunk["metadata"]["suspectedRat"], "5G")
        self.assertIn("beta", second_chunk["metadata"]["identifiers"]["session"])

    def test_window_strategy_uses_overlap_when_no_identifiers_found(self):
        lines = [f"12:00:{str(i).zfill(2)}.000 LTE event line {i}" for i in range(8)]
        result = preprocess_log_text("\n".join(lines), chunk_target_lines=3, overlap_lines=1, max_identifier_values=3)

        self.assertEqual(result["segmentationStrategy"], "window")
        self.assertEqual(len(result["chunks"]), 4)
        self.assertEqual(result["chunks"][0]["lineRange"], {"start": 1, "end": 3})
        self.assertEqual(result["chunks"][1]["lineRange"], {"start": 3, "end": 5})
        self.assertEqual(result["chunks"][-1]["lineRange"], {"start": 7, "end": 8})
        self.assertEqual(result["detectedRat"], "4G")


if __name__ == "__main__":
    unittest.main()

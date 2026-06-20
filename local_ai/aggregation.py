from __future__ import annotations

from collections import Counter


CONFIDENCE_SCORES = {
    "low": 1,
    "medium": 2,
    "high": 3,
}

SEVERITY_RULES = [
    ("drop", 3),
    ("failure", 3),
    ("reject", 3),
    ("timeout", 3),
    ("radio link failure", 3),
    ("rlf", 3),
    ("handover", 2),
    ("attach", 2),
    ("registration", 2),
    ("bearer", 2),
    ("paging", 1),
]

FAILURE_DOMAIN_LABELS = {
    "radio_coverage": "Radio coverage",
    "radio_interference": "Radio interference / quality",
    "mobility": "Mobility / handover",
    "congestion": "Congestion / admission",
    "core_signaling": "Core / signaling",
    "policy_or_network_release": "Policy / network-initiated release",
    "device_or_ue": "Device / UE",
    "unknown": "Unknown / insufficient evidence",
}


def _dedupe_texts(values) -> list[str]:
    seen = set()
    result = []
    for value in values or []:
        item = str(value or "").strip()
        if not item:
            continue
        key = item.casefold()
        if key in seen:
            continue
        seen.add(key)
        result.append(item)
    return result


def _severity_score(text: str) -> int:
    lowered = str(text or "").casefold()
    best = 1
    for token, score in SEVERITY_RULES:
        if token in lowered:
            best = max(best, score)
    return best


def _domain_display(domain: str) -> str:
    key = str(domain or "unknown").strip().lower()
    return FAILURE_DOMAIN_LABELS.get(key, FAILURE_DOMAIN_LABELS["unknown"])


def aggregate_chunk_analyses(preprocessing: dict, chunk_results: list[dict], total_duration_ms: float | int) -> dict:
    rat_counter = Counter()
    domain_counter: dict[str, dict] = {}
    trigger_counter: dict[str, dict] = {}
    cause_counter: dict[str, dict] = {}
    summaries = []
    anomalies = []
    next_checks = []
    key_events = []
    evidence = []
    confidence_rationales = []
    limitations = []
    failed = []
    chunk_summaries = []

    for item in chunk_results:
        chunk = item.get("chunk") if isinstance(item.get("chunk"), dict) else {}
        metadata = chunk.get("metadata") if isinstance(chunk.get("metadata"), dict) else {}

        analysis = item.get("analysis") if isinstance(item.get("analysis"), dict) else None
        analysis_rat = str((analysis or {}).get("rat_hint") or "").strip()
        suspected_rat = analysis_rat or str(metadata.get("suspectedRat") or "unknown")
        if suspected_rat and suspected_rat != "unknown":
            rat_counter[suspected_rat] += 1

        if not analysis:
            failed.append(
                {
                    "chunkId": chunk.get("id"),
                    "message": item.get("error") or "Chunk analysis failed.",
                }
            )
            chunk_summaries.append(
                {
                    "chunk_id": chunk.get("id"),
                    "status": "error",
                    "summary": "Analysis failed for this chunk.",
                    "error": item.get("error") or "Unknown local AI error.",
                    "suspected_rat": suspected_rat,
                    "start_timestamp": metadata.get("startTimestamp"),
                    "end_timestamp": metadata.get("endTimestamp"),
                    "identifiers": metadata.get("identifiers") or {},
                }
            )
            continue

        summaries.append(str(analysis.get("summary") or "").strip())
        anomalies.extend(analysis.get("anomalies") or [])
        next_checks.extend(analysis.get("next_checks") or [])
        key_events.extend(analysis.get("key_events") or [])
        evidence.extend(analysis.get("evidence") or [])
        confidence_rationales.extend(
            [str(analysis.get("confidence_rationale") or "").strip()] if str(analysis.get("confidence_rationale") or "").strip() else []
        )
        limitations.extend(analysis.get("unknown_fields_or_limitations") or [])

        confidence = str(analysis.get("confidence") or "low")
        trigger_text = str(analysis.get("trigger_event") or "").strip()
        if trigger_text:
            trigger_key = trigger_text.casefold()
            trigger_bucket = trigger_counter.setdefault(
                trigger_key,
                {
                    "trigger": trigger_text,
                    "count": 0,
                    "top_confidence": "low",
                },
            )
            trigger_bucket["count"] += 1
            if CONFIDENCE_SCORES.get(confidence, 1) > CONFIDENCE_SCORES.get(trigger_bucket["top_confidence"], 1):
                trigger_bucket["top_confidence"] = confidence

        domain_key = str(analysis.get("failure_domain") or "unknown").strip().lower()
        if not domain_key:
            domain_key = "unknown"
        domain_bucket = domain_counter.setdefault(
            domain_key,
            {
                "domain": domain_key,
                "label": _domain_display(domain_key),
                "count": 0,
                "top_confidence": "low",
                "score": 0,
            },
        )
        domain_bucket["count"] += 1
        domain_bucket["score"] += CONFIDENCE_SCORES.get(confidence, 1)
        if CONFIDENCE_SCORES.get(confidence, 1) > CONFIDENCE_SCORES.get(domain_bucket["top_confidence"], 1):
            domain_bucket["top_confidence"] = confidence

        cause_text = str(analysis.get("likely_root_cause") or "").strip()
        if cause_text and cause_text.lower() != "unknown from this chunk.":
            key = cause_text.casefold()
            bucket = cause_counter.setdefault(
                key,
                {
                    "cause": cause_text,
                    "count": 0,
                    "severity": _severity_score(cause_text),
                    "top_confidence": "low",
                },
            )
            bucket["count"] += 1
            if CONFIDENCE_SCORES.get(confidence, 1) > CONFIDENCE_SCORES.get(bucket["top_confidence"], 1):
                bucket["top_confidence"] = confidence

        chunk_summaries.append(
            {
                "chunk_id": chunk.get("id"),
                "status": "success",
                "summary": analysis.get("summary"),
                "trigger_event": analysis.get("trigger_event"),
                "failure_domain": domain_key,
                "likely_root_cause": analysis.get("likely_root_cause"),
                "confidence": confidence,
                "confidence_rationale": analysis.get("confidence_rationale"),
                "suspected_rat": suspected_rat,
                "rat_hint": analysis_rat or None,
                "start_timestamp": metadata.get("startTimestamp"),
                "end_timestamp": metadata.get("endTimestamp"),
                "identifiers": metadata.get("identifiers") or {},
                "evidence": _dedupe_texts(analysis.get("evidence") or []),
                "anomalies": _dedupe_texts(analysis.get("anomalies") or []),
                "key_events": _dedupe_texts(analysis.get("key_events") or []),
                "next_checks": _dedupe_texts(analysis.get("next_checks") or []),
                "latency_ms": item.get("latencyMs"),
                "json_recovered": bool(item.get("jsonRecovered")),
                "radio_series": item.get("radio_series"),
                "neighbor_series": item.get("neighbor_series"),
                "signal_series": item.get("signal_series"),
            }
        )

    ranked_causes = []
    for item in cause_counter.values():
        score = (item["count"] * 5) + (item["severity"] * 3) + (CONFIDENCE_SCORES.get(item["top_confidence"], 1) * 2)
        ranked_causes.append(
            {
                "cause": item["cause"],
                "count": item["count"],
                "severity": item["severity"],
                "top_confidence": item["top_confidence"],
                "score": score,
            }
        )
    ranked_causes.sort(key=lambda entry: (-entry["score"], -entry["count"], entry["cause"].casefold()))

    ranked_domains = sorted(
        domain_counter.values(),
        key=lambda entry: (-entry["score"], -entry["count"], entry["label"].casefold()),
    )
    ranked_triggers = sorted(
        trigger_counter.values(),
        key=lambda entry: (-entry["count"], -CONFIDENCE_SCORES.get(entry["top_confidence"], 1), entry["trigger"].casefold()),
    )

    detected_rat = preprocessing.get("detectedRat") or "unknown"
    if rat_counter:
        detected_rat = rat_counter.most_common(1)[0][0]

    top_summary_lines = [text for text in _dedupe_texts(summaries) if text][:3]
    overall_summary_parts = []
    if top_summary_lines:
        overall_summary_parts.append(top_summary_lines[0])
    if failed:
        overall_summary_parts.append(f"{len(failed)} chunk(s) failed and were kept as partial results.")
    overall_summary = " ".join(overall_summary_parts).strip() or "No chunk-level findings were produced."

    return {
        "overall_summary": overall_summary,
        "detected_rat": detected_rat,
        "trigger_events": ranked_triggers[:10],
        "dominant_failure_domain": ranked_domains[0] if ranked_domains else None,
        "failure_domains": ranked_domains[:8],
        "key_events": _dedupe_texts(key_events)[:30],
        "evidence": _dedupe_texts(evidence)[:30],
        "likely_causes": ranked_causes[:10],
        "anomalies": _dedupe_texts(anomalies)[:30],
        "confidence_rationale": _dedupe_texts(confidence_rationales)[:12],
        "recommended_next_checks": _dedupe_texts(next_checks)[:30],
        "chunk_summaries": chunk_summaries,
        "partial_failures": failed,
        "unknown_fields_or_limitations": _dedupe_texts(limitations + ([f"{len(failed)} chunk(s) could not be analyzed."] if failed else []))[:20],
        "stats": {
            "total_chunks": len(chunk_results),
            "analyzed_chunks": len(chunk_results) - len(failed),
            "failed_chunks": len(failed),
            "duration_ms": round(float(total_duration_ms or 0), 1),
        },
    }

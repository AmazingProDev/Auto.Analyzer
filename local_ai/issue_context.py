from __future__ import annotations

import re
from statistics import median


FAILURE_DOMAINS = [
    "radio_coverage",
    "radio_interference",
    "mobility",
    "congestion",
    "core_signaling",
    "policy_or_network_release",
    "device_or_ue",
    "unknown",
]

DOMAIN_LABELS = {
    "radio_coverage": "Radio coverage",
    "radio_interference": "Radio interference / quality",
    "mobility": "Mobility / handover",
    "congestion": "Congestion / admission",
    "core_signaling": "Core / signaling",
    "policy_or_network_release": "Policy / network-initiated release",
    "device_or_ue": "Device / UE",
    "unknown": "Unknown / insufficient evidence",
}

FIELD_LINE_RE = re.compile(r"^([^:\n]+):\s*(.+)$")
PAIR_RE = re.compile(r"([A-Za-z0-9_./-]+)=([^|]+)")
TIME_RE = re.compile(r"\b\d{2}:\d{2}:\d{2}(?:[.,]\d{1,3})?\b")
UMTS_PROCEDURE_RE = re.compile(r"\b(active[_ -]?set|soft handover|sho|rnc|rscp|ec/?no|rab|iu[- ]?(?:cs|ps)?|wcdma|umts)\b", re.I)
LTE_PROCEDURE_RE = re.compile(r"\b(lte|e[- ]?rab|s1ap|mme|rsrp|rsrq|earfcn|enb)\b", re.I)


def _to_number(value):
    try:
        number = float(str(value).strip())
    except Exception:
        return None
    if number != number or number in (float("inf"), float("-inf")):
        return None
    return number


def _to_bool(value) -> bool | None:
    if value is None:
        return None
    text = str(value).strip().lower()
    if text in {"true", "1", "yes"}:
        return True
    if text in {"false", "0", "no"}:
        return False
    return None


def _dedupe(values):
    seen = set()
    out = []
    for value in values or []:
        text = str(value or "").strip()
        if not text:
            continue
        key = text.casefold()
        if key in seen:
            continue
        seen.add(key)
        out.append(text)
    return out


def _dedupe_preserve_order_by_key(values, key_fn):
    seen = set()
    out = []
    for value in values or []:
        key = key_fn(value)
        if key in seen:
            continue
        seen.add(key)
        out.append(value)
    return out


def _parse_sections(text: str) -> tuple[dict, dict]:
    fields = {}
    sections: dict[str, list[str]] = {}
    current_section = "header"
    sections[current_section] = []
    for raw in str(text or "").splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith("## "):
            current_section = line[3:].strip().lower()
            sections.setdefault(current_section, [])
            continue
        sections.setdefault(current_section, []).append(line)
        if current_section == "header":
            match = FIELD_LINE_RE.match(line)
            if match:
                fields[match.group(1).strip()] = match.group(2).strip()
    return fields, sections


def _parse_pair_line(line: str) -> dict:
    pairs = {}
    for match in PAIR_RE.finditer(str(line or "")):
        key = str(match.group(1) or "").strip()
        value = str(match.group(2) or "").strip()
        if key:
            pairs[key] = value
    return pairs


def _normalize_rat(tech: str, metric_family: str) -> str:
    text = str(tech or "").lower()
    if "5g" in text or "nr" in text:
        return "5G"
    if "4g" in text or "lte" in text:
        return "4G"
    if "3g" in text or "umts" in text or "wcdma" in text:
        return "3G"
    if metric_family == "umts":
        return "3G"
    if metric_family == "lte":
        return "4G"
    return "unknown"


def _procedure_family(text: str) -> str:
    raw = str(text or "")
    umts_hits = len(UMTS_PROCEDURE_RE.findall(raw))
    lte_hits = len(LTE_PROCEDURE_RE.findall(raw))
    if umts_hits > lte_hits:
        return "umts"
    if lte_hits > umts_hits:
        return "lte"
    return "unknown"


def _merge_rat_family(tech: str, metric_family: str, procedure_family: str) -> tuple[str, list[str]]:
    limitations = []
    declared = _normalize_rat(tech, "unknown")
    if metric_family == "umts" and procedure_family == "umts":
        return "3G", limitations
    if metric_family == "lte" and procedure_family == "lte":
        return "4G", limitations
    if procedure_family == "umts" and declared == "4G":
        return "3G", limitations
    if procedure_family == "lte" and declared == "3G":
        return "4G", limitations
    if metric_family == "umts" and declared == "4G":
        return "3G", limitations
    if metric_family == "lte" and declared == "3G":
        return "4G", limitations
    return _normalize_rat(tech, metric_family or procedure_family), limitations


def _detect_metric_family(radio_rows: list[dict]) -> str:
    umts_hits = 0
    lte_hits = 0
    for row in radio_rows:
        keys = {str(key).lower() for key in row.keys()}
        if {"servingsc", "servingrscpdbm", "servingecnodb"} & keys:
            umts_hits += 2
        if {"rscp", "ecno"} & keys:
            umts_hits += 1
        if {"rsrp", "rsrq"} & keys:
            lte_hits += 2
        if {"pci", "earfcn", "sinr"} & keys:
            lte_hits += 1
    if umts_hits > lte_hits:
        return "umts"
    if lte_hits > umts_hits:
        return "lte"
    return "unknown"


def _series_values(rows: list[dict], keys: list[str]) -> list[float]:
    out = []
    for row in rows:
        for key in keys:
            number = _to_number(row.get(key))
            if number is not None:
                out.append(number)
                break
    return out


def _series_summary(values: list[float], direction: str | None = None) -> dict:
    if not values:
        return {"count": 0}
    trend = values[-1] - values[0] if len(values) >= 2 else 0.0
    worsening = False
    if direction == "down":
        worsening = trend < -2
    elif direction == "up":
        worsening = trend > 2
    return {
        "count": len(values),
        "first": round(values[0], 2),
        "last": round(values[-1], 2),
        "min": round(min(values), 2),
        "max": round(max(values), 2),
        "median": round(median(values), 2),
        "trend": round(trend, 2),
        "worsening": worsening,
    }


def _median_or_none(values: list[float]) -> float | None:
    filtered = [value for value in (values or []) if value is not None]
    if not filtered:
        return None
    return round(median(filtered), 2)


def _pick_trigger(signal_rows: list[dict], fallback_line: str, event_time: str) -> str:
    precursor_keywords = (
        "release",
        "failure",
        "reject",
        "rlf",
        "re-establishment",
        "reestablishment",
        "handover",
        "ho ",
    )
    terminal_keywords = ("drop",)
    candidates = []
    for row in reversed(signal_rows):
        event_name = " ".join(
            filter(
                None,
                [
                    str(row.get("event") or ""),
                    str(row.get("label") or ""),
                ],
            )
        ).strip()
        event_text = " ".join(
            filter(
                None,
                [
                    event_name,
                    str(row.get("message") or ""),
                    str(row.get("comment") or ""),
                ],
            )
        ).strip()
        if not event_text:
            continue
        lowered = event_text.casefold()
        event_lowered = event_name.casefold()
        row_time = str(row.get("time") or event_time or "").strip()
        rendered = f"{event_text} @ {row_time}".strip()
        is_terminal_drop = any(keyword in event_lowered for keyword in terminal_keywords)
        if not is_terminal_drop and any(keyword in lowered for keyword in precursor_keywords):
            return rendered
        if is_terminal_drop:
            candidates.append(rendered)
    if candidates:
        return candidates[0]
    return fallback_line or (f"Terminal event near {event_time}" if event_time else "Terminal event")


def _extract_terminal_marker(fields: dict, signal_rows: list[dict], event_time: str) -> str:
    point_snapshot = str(fields.get("Point snapshot") or "").strip()
    if point_snapshot:
        return point_snapshot
    for row in reversed(signal_rows):
        event_text = " ".join(
            filter(
                None,
                [
                    str(row.get("event") or ""),
                    str(row.get("message") or ""),
                    str(row.get("label") or ""),
                    str(row.get("comment") or ""),
                ],
            )
        ).strip()
        if event_text:
            row_time = str(row.get("time") or event_time or "").strip()
            return f"{event_text} @ {row_time}".strip()
    return f"Terminal event @ {event_time}".strip() if event_time else "Terminal event"


def _time_to_seconds(value: str) -> float | None:
    match = TIME_RE.search(str(value or ""))
    if not match:
        return None
    raw = match.group(0).replace(",", ".")
    try:
        hh, mm, ss = raw.split(":")
        seconds = float(ss)
        return (int(hh) * 3600) + (int(mm) * 60) + seconds
    except Exception:
        return None


def _domain_scores(fields: dict, signal_rows: list[dict], radio_rows: list[dict], rat: str) -> tuple[dict, list[str], list[str], str]:
    scores = {key: 0 for key in FAILURE_DOMAINS}
    evidence = []
    limitations = []
    metric_family = _detect_metric_family(radio_rows)

    point_snapshot = str(fields.get("Point snapshot") or "").lower()
    failure_reason = str(fields.get("Failure reason cause") or fields.get("Failure reason label") or "").lower()
    verdict_summary = str(fields.get("Verdict summary") or "").lower()
    release_cause_text = " ".join(
        filter(
            None,
            [
                failure_reason,
                verdict_summary,
                point_snapshot,
                " ".join(str(row.get("releaseCause") or "") for row in signal_rows),
            ],
        )
    ).casefold()

    rscp = _series_values(radio_rows, ["servingRscpDbm", "rscp"])
    ecno = _series_values(radio_rows, ["servingEcnoDb", "ecno"])
    rsrp = _series_values(radio_rows, ["rsrp", "servingRsrpDbm"])
    rsrq = _series_values(radio_rows, ["rsrq", "servingRsrqDb"])
    bler = _series_values(radio_rows, ["blerDl", "blerUl"])

    rscp_summary = _series_summary(rscp, "down")
    ecno_summary = _series_summary(ecno, "down")
    rsrp_summary = _series_summary(rsrp, "down")
    rsrq_summary = _series_summary(rsrq, "down")
    bler_summary = _series_summary(bler, "up")

    if rscp_summary.get("count"):
        median_rscp = rscp_summary["median"]
        if median_rscp > -90:
            evidence.append(f"RSCP is Good (> -90 dBm) (median {median_rscp} dBm).")
        elif -105 <= median_rscp <= -90:
            evidence.append(f"RSCP is Marginal (-90 to -105 dBm) (median {median_rscp} dBm).")
            scores["radio_coverage"] += 2
        elif median_rscp < -105:
            scores["radio_coverage"] += 4
            evidence.append(f"RSCP is Bad (< -105 dBm) (median {median_rscp} dBm, min {rscp_summary['min']} dBm).")
        if rscp_summary.get("worsening"):
            scores["radio_coverage"] += 2
            evidence.append(f"RSCP worsens toward the failure (trend {rscp_summary['trend']} dB).")
            
    if ecno_summary.get("count"):
        median_ecno = ecno_summary["median"]
        if median_ecno > -9:
            evidence.append(f"EcNo is Good (> -9 dB) (median {median_ecno} dB).")
        elif -14 <= median_ecno <= -9:
            evidence.append(f"EcNo is Marginal (-9 to -14 dB) (median {median_ecno} dB).")
            scores["radio_interference"] += 2
        elif median_ecno < -14:
            scores["radio_interference"] += 3
            evidence.append(f"EcNo is Bad (< -14 dB) (median {median_ecno} dB, min {ecno_summary['min']} dB).")
        if ecno_summary.get("worsening"):
            scores["radio_interference"] += 2
            evidence.append(f"EcNo worsens toward the failure (trend {ecno_summary['trend']} dB).")
    if rsrp_summary.get("count"):
        if rsrp_summary["median"] <= -105 or rsrp_summary["min"] <= -112:
            scores["radio_coverage"] += 4
            evidence.append(f"RSRP is weak (median {rsrp_summary['median']} dBm, min {rsrp_summary['min']} dBm).")
        if rsrp_summary.get("worsening"):
            scores["radio_coverage"] += 2
            evidence.append(f"RSRP worsens toward the failure (trend {rsrp_summary['trend']} dB).")
    if rsrq_summary.get("count"):
        if rsrq_summary["median"] <= -12 or rsrq_summary["min"] <= -15:
            scores["radio_interference"] += 3
            evidence.append(f"RSRQ is degraded (median {rsrq_summary['median']} dB, min {rsrq_summary['min']} dB).")
        if rsrq_summary.get("worsening"):
            scores["radio_interference"] += 2
            evidence.append(f"RSRQ worsens toward the failure (trend {rsrq_summary['trend']} dB).")
    if bler_summary.get("count") and (bler_summary["max"] >= 10 or bler_summary["worsening"]):
        scores["radio_interference"] += 2
        evidence.append(f"BLER rises near the failure (max {bler_summary['max']}%).")

    text_pool = " ".join(
        filter(
            None,
            [
                str(fields.get("Compact procedure timeline") or ""),
                str(fields.get("Evidence") or ""),
                str(fields.get("Assumptions") or ""),
                " ".join(" ".join(str(value) for value in row.values()) for row in signal_rows),
            ],
        )
    ).casefold()

    if any(token in text_pool for token in ("handover", "ho failure", "re-establishment", "reestablishment", "rlf", "radio link failure")):
        scores["mobility"] += 5
        evidence.append("Mobility-side evidence is present (handover / re-establishment / RLF markers).")
    if any(token in text_pool for token in ("admission", "no resource", "congestion", "rab release", "resource")):
        scores["congestion"] += 4
        evidence.append("Resource or admission indicators are present in the signaling context.")
    if any(token in text_pool for token in ("mme", "nas", "s1ap", "core", "auth", "attach reject", "service reject", "iu release")):
        scores["core_signaling"] += 3
        evidence.append("Higher-layer/core signaling indicators are present near the failure.")
    if "release" in release_cause_text:
        scores["policy_or_network_release"] += 2
        evidence.append("The terminal trigger is a network-side release event.")
    if "unspecified" in release_cause_text:
        scores["policy_or_network_release"] += 1
        limitations.append("Release cause is 'unspecified', so terminal signaling alone cannot prove the root cause.")
    if any(token in text_pool for token in ("ue", "device", "imei", "tmsi", "imsi detach")):
        scores["device_or_ue"] += 1

    # Avoid promoting policy/core when strong radio evidence exists.
    if scores["radio_coverage"] >= 4 or scores["radio_interference"] >= 4:
        scores["policy_or_network_release"] = max(0, scores["policy_or_network_release"] - 2)
        scores["core_signaling"] = max(0, scores["core_signaling"] - 1)

    if max(scores.values()) <= 0:
        scores["unknown"] = 1

    dominant_domain = max(scores.items(), key=lambda item: (item[1], item[0] != "unknown"))[0]
    return scores, _dedupe(evidence), _dedupe(limitations), metric_family


def _analyze_neighbor_context(fields: dict, neighbor_rows: list[dict], procedure_family: str, rat_guess: str) -> dict:
    scores = {key: 0 for key in FAILURE_DOMAINS}
    evidence = []
    anomalies = []
    next_checks = []
    limitations = []

    if not neighbor_rows:
        return {
            "scores": scores,
            "evidence": evidence,
            "anomalies": anomalies,
            "next_checks": next_checks,
            "limitations": limitations,
            "best_candidate": None,
            "overlap_rows": 0,
        }

    candidate_buckets = {}
    overlap_rows = 0
    stronger_rows = 0
    for row in neighbor_rows:
        serving_sc = row.get("servingSc")
        candidate_sc = row.get("bestNeighborSc")
        delta_rscp = _to_number(row.get("bestNeighborDeltaRscpDb"))
        delta_ecno = _to_number(row.get("bestNeighborDeltaEcnoDb"))
        better_flag = _to_bool(row.get("bestNeighborBetterThanServing"))
        within3_count = _to_number(row.get("within3DbCount")) or 0
        stronger_count = _to_number(row.get("strongerNeighborCount")) or 0

        if within3_count >= 2:
            overlap_rows += 1
        if stronger_count >= 1:
            stronger_rows += 1
        if candidate_sc in (None, "", "null"):
            continue
        key = str(candidate_sc).strip()
        bucket = candidate_buckets.setdefault(
            key,
            {
                "serving_sc": str(serving_sc).strip() if serving_sc not in (None, "") else None,
                "candidate_sc": key,
                "type": str(row.get("bestNeighborType") or "").strip() or None,
                "delta_rscp": [],
                "delta_ecno": [],
                "count": 0,
                "better_count": 0,
                "within3_count": 0,
            },
        )
        bucket["count"] += 1
        if delta_rscp is not None:
            bucket["delta_rscp"].append(delta_rscp)
        if delta_ecno is not None:
            bucket["delta_ecno"].append(delta_ecno)
        if better_flag or (delta_rscp is not None and delta_rscp >= 1.5) or (
            delta_rscp is not None and delta_ecno is not None and delta_rscp >= 0 and delta_ecno >= 2
        ):
            bucket["better_count"] += 1
        if within3_count >= 1:
            bucket["within3_count"] += 1

    ranked_candidates = sorted(
        candidate_buckets.values(),
        key=lambda item: (
            -item["better_count"],
            -(_median_or_none(item["delta_rscp"]) or -999),
            -(_median_or_none(item["delta_ecno"]) or -999),
            item["candidate_sc"],
        ),
    )
    best = ranked_candidates[0] if ranked_candidates else None

    if best:
        median_delta_rscp = _median_or_none(best["delta_rscp"])
        median_delta_ecno = _median_or_none(best["delta_ecno"])
        if best["better_count"] >= 2 and (
            (median_delta_rscp is not None and median_delta_rscp >= 1.5) or
            (median_delta_rscp is not None and median_delta_ecno is not None and median_delta_rscp >= 0 and median_delta_ecno >= 2)
        ):
            scores["mobility"] += 5
            evidence.append(
                f"Neighbor PSC {best['candidate_sc']} looks better than serving PSC {best['serving_sc'] or '?'} in {best['better_count']} nearby rows"
                + (
                    f" (median dRSCP {median_delta_rscp:+.1f} dB"
                    + (f", median dEcNo {median_delta_ecno:+.1f} dB" if median_delta_ecno is not None else "")
                    + ")."
                    if median_delta_rscp is not None else "."
                )
            )
            anomalies.append(
                f"PSC {best['candidate_sc']} appears preferable to serving PSC {best['serving_sc'] or '?'} before the failure, so active-set addition / SHO behavior should be verified."
            )
            next_checks.extend(
                [
                    f"Check whether PSC {best['candidate_sc']} was defined and eligible for UMTS neighbor / active-set addition on the relevant UARFCN.",
                    f"Review Event 1A/1B/1C thresholds, add-to-active-set logic, and SHO timers for serving PSC {best['serving_sc'] or '?'} versus PSC {best['candidate_sc']}.",
                ]
            )

    if overlap_rows >= 2:
        scores["mobility"] += 2
        scores["radio_interference"] += 1
        evidence.append("Multiple nearby rows show close-power UMTS neighbors within 3 dB of serving, indicating SHO pressure / pilot overlap risk.")
        next_checks.append("Check active-set size stability, candidate PSC ranking, and pilot overlap around the failure window.")

    if stronger_rows >= 2 and procedure_family == "umts":
        scores["mobility"] += 1
        evidence.append("Stronger neighbor candidates are present in multiple nearby UMTS rows, so the failure may involve mobility execution rather than serving-only coverage.")

    return {
        "scores": scores,
        "evidence": _dedupe(evidence)[:8],
        "anomalies": _dedupe(anomalies)[:8],
        "next_checks": _dedupe(next_checks)[:8],
        "limitations": _dedupe(limitations)[:8],
        "best_candidate": best,
    }


def _build_engineering_hints(
    *,
    rat_guess: str,
    procedure_family: str,
    procedure_text: str,
    top_domain: str,
    trigger: str,
    trigger_to_terminal_seconds: float | None,
    neighbor_analysis: dict,
) -> dict:
    summary_hint = None
    root_cause_hint = None
    style_hints = []
    best_candidate = (neighbor_analysis or {}).get("best_candidate") or {}
    candidate_sc = str(best_candidate.get("candidate_sc") or "").strip()
    serving_sc = str(best_candidate.get("serving_sc") or "").strip()
    median_delta_rscp = _median_or_none(best_candidate.get("delta_rscp") or [])
    median_delta_ecno = _median_or_none(best_candidate.get("delta_ecno") or [])
    trigger_label = str(trigger or "").split("@")[0].strip() or "the failure marker"
    procedure_lower = str(procedure_text or "").casefold()

    if rat_guess == "3G" and procedure_family == "umts":
        style_hints.extend(
            [
                "Use UMTS-specific language: PSC, active set, soft handover, Event 1A/1B/1C.",
                "Prefer RF-optimization wording over generic troubleshooting phrasing.",
            ]
        )
        if "active_set_update_failure" in procedure_lower or "active set update failure" in procedure_lower:
            if candidate_sc and serving_sc:
                delta_bits = []
                if median_delta_rscp is not None:
                    delta_bits.append(f"median dRSCP {median_delta_rscp:+.1f} dB")
                if median_delta_ecno is not None:
                    delta_bits.append(f"median dEcNo {median_delta_ecno:+.1f} dB")
                delta_text = f" ({', '.join(delta_bits)})" if delta_bits else ""
                summary_hint = (
                    f"UMTS/3G drop context. {trigger_label} is the key precursor; PSC {candidate_sc} looked better than serving PSC {serving_sc}{delta_text}, "
                    f"so missed or late active-set addition / soft-handover execution should be considered."
                )
                root_cause_hint = (
                    f"UMTS mobility weakness is likely: PSC {candidate_sc} appeared preferable to serving PSC {serving_sc} before {trigger_label}, "
                    f"but the active set was not updated successfully under degrading radio quality."
                )
            elif top_domain == "mobility":
                summary_hint = (
                    f"UMTS/3G drop context. {trigger_label} is the key precursor and the evidence points to active-set / soft-handover execution stress rather than a pure terminal release."
                )
                root_cause_hint = (
                    "UMTS mobility weakness is likely: active-set maintenance or soft-handover execution did not keep pace with the radio evolution before the drop."
                )
            elif top_domain == "radio_coverage":
                summary_hint = (
                    f"UMTS/3G drop context. {trigger_label} is the key precursor, with weak RSCP / degraded EcNo and active-set control stress before the drop."
                )
                root_cause_hint = (
                    "UMTS radio degradation is likely: weak serving pilot quality destabilized active-set control and contributed to the failed Active Set Update."
                )

    if trigger_to_terminal_seconds is not None and trigger_to_terminal_seconds >= 3:
        style_hints.append("Describe the trigger as a precursor event, not the terminal drop itself.")

    return {
        "summary_hint": summary_hint,
        "root_cause_hint": root_cause_hint,
        "style_hints": _dedupe(style_hints),
    }


def engineer_issue_context(text: str) -> dict:
    fields, sections = _parse_sections(text)
    signal_rows = [_parse_pair_line(line) for line in sections.get("signaling context", []) if line.startswith("- ")]
    radio_rows = [_parse_pair_line(line) for line in sections.get("radio context", []) if line.startswith("- ")]
    neighbor_rows = [_parse_pair_line(line) for line in sections.get("neighbor context", []) if line.startswith("- ")]
    issue_type = str(fields.get("Issue type") or "Issue").strip()
    tech = str(fields.get("Technology") or "").strip()
    procedure_text = " ".join(
        filter(
            None,
            [
                str(fields.get("Compact procedure timeline") or ""),
                str(fields.get("Point snapshot") or ""),
                " ".join(" ".join(str(value or "") for value in row.values()) for row in signal_rows[:20]),
            ],
        )
    )
    metric_family = _detect_metric_family(radio_rows)
    procedure_family = _procedure_family(procedure_text)
    rat_guess, rat_limitations = _merge_rat_family(tech, metric_family, procedure_family)
    event_time = str(fields.get("Event time") or "").strip()
    trigger = _pick_trigger(signal_rows, str(fields.get("Point snapshot") or ""), event_time)
    terminal_marker = _extract_terminal_marker(fields, signal_rows, event_time)
    scores, evidence, limitations, metric_family = _domain_scores(fields, signal_rows, radio_rows, rat_guess)
    neighbor_analysis = _analyze_neighbor_context(fields, neighbor_rows, procedure_family, rat_guess)
    for domain_key, score in (neighbor_analysis.get("scores") or {}).items():
        scores[domain_key] = scores.get(domain_key, 0) + int(score or 0)
    evidence = _dedupe((evidence or []) + (neighbor_analysis.get("evidence") or []))
    limitations = _dedupe((limitations or []) + (neighbor_analysis.get("limitations") or []) + rat_limitations)
    ordered_scores = sorted(scores.items(), key=lambda item: (-item[1], item[0]))
    top_domain, top_score = ordered_scores[0]
    second_domain = ordered_scores[1][0] if len(ordered_scores) > 1 else "unknown"
    second_score = ordered_scores[1][1] if len(ordered_scores) > 1 else 0
    data_rich = len(signal_rows) >= 2 and len(radio_rows) >= 3
    cause_unspecified = "unspecified" in str(fields.get("Failure reason cause") or "").casefold()
    trigger_time_seconds = _time_to_seconds(trigger)
    terminal_time_seconds = _time_to_seconds(event_time or terminal_marker)
    trigger_to_terminal_seconds = None
    if trigger_time_seconds is not None and terminal_time_seconds is not None:
        delta = round(terminal_time_seconds - trigger_time_seconds, 3)
        if delta >= 0:
            trigger_to_terminal_seconds = delta

    # NEMO 3G RULE 8: Check for RLC and Timer Expiry Smoking Guns
    hints = {}
    signal_block_lower = " ".join(" ".join(str(v) for v in row.values()) for row in signal_rows).casefold()
    if "Recovery on timer expiry".casefold() in signal_block_lower or "timer expiry" in signal_block_lower or "abnormal release" in signal_block_lower:
        hints["root_cause_hint"] = "Signaling explicitly shows Timer Expiry / Abnormal Call Clearing (e.g. DISCONNECT then RELEASE on timer expiry). As per Rule 7, classify the root cause as a timer-expiry abnormal clear, NOT a pure coverage drop, even if RF is weak."
        scores["core_signaling"] = scores.get("core_signaling", 0) + 10
        evidence.append("Protocol release marker indicates timer expiry / abnormal clear.")
    if "rlc-unrecoverableError".casefold() in signal_block_lower:
        hints["root_cause_hint"] = "Signaling explicitly indicates rlc-unrecoverableError. This is a RAN/bearer/transport failure, NEVER just coverage. Check Iub transmission quality/NodeB alarms."
        scores["mobility"] = scores.get("mobility", 0) + 10
        evidence.append("Protocol release marker shows rlc-unrecoverableError.")

    # NEMO 3G RULE 9: Pilot Pollution vs Weak Coverage
    rscp_vals = _series_values(radio_rows, ["servingRscpDbm", "rscp"])
    ecno_vals = _series_values(radio_rows, ["servingEcnoDb", "ecno"])
    median_rscp = _series_summary(rscp_vals, "down").get("median")
    median_ecno = _series_summary(ecno_vals, "down").get("median")
    overlap_rows = neighbor_analysis.get("overlap_rows", 0)
    
    if median_rscp is not None and median_ecno is not None:
        if median_rscp > -85 and median_ecno < -10 and overlap_rows >= 1:
            hints["root_cause_hint"] = "Pilot pollution detected: serving RSCP is strong (> -85 dBm) but EcNo is degraded (< -10 dB), with multiple encroaching same-frequency pilots. If instability exists, blame Pilot Pollution, NOT weak coverage!"
            scores["radio_interference"] = scores.get("radio_interference", 0) + 10
            scores["radio_coverage"] = 0
            evidence.append("High pilot overlap detected with strong serving RSCP but poor EcNo (Pilot Pollution pattern).")

    confidence_ceiling = "low"
    if top_score >= 5 and data_rich and top_score > second_score + 1:
        confidence_ceiling = "medium"
    elif (
        data_rich
        and top_score >= 5
        and top_domain in {"radio_coverage", "radio_interference"}
        and second_domain in {"radio_coverage", "radio_interference"}
    ):
        confidence_ceiling = "medium"
    if top_score >= 8 and data_rich and top_score > second_score + 2 and not cause_unspecified:
        confidence_ceiling = "high"

    confidence_rationale = []
    if cause_unspecified:
        confidence_rationale.append("Terminal release cause is unspecified, so the root cause cannot be confirmed from signaling alone.")
    if data_rich:
        confidence_rationale.append("The issue bundle contains both signaling and radio context near the failure.")
    else:
        confidence_rationale.append("The issue bundle is sparse, so confidence should remain conservative.")
    if trigger_to_terminal_seconds is not None and trigger_to_terminal_seconds >= 3:
        confidence_rationale.append(
            f"The highlighted trigger precedes the final terminal event by about {trigger_to_terminal_seconds:.1f} s, so it should be treated as a precursor rather than the final release itself."
        )
    confidence_rationale.append(f"Dominant deterministic failure domain is {DOMAIN_LABELS[top_domain].lower()} (score {top_score}).")

    key_events = []
    for row in signal_rows[:8]:
        text_line = " ".join(filter(None, [row.get("time"), row.get("event"), row.get("message"), row.get("label")])).strip()
        if text_line:
            key_events.append(text_line)

    anomalies = list(neighbor_analysis.get("anomalies") or [])
    next_checks = list(neighbor_analysis.get("next_checks") or [])
    procedure_lower = procedure_text.casefold()
    if trigger_to_terminal_seconds is not None and trigger_to_terminal_seconds >= 3:
        anomalies.append(
            f"Trigger-to-drop gap is about {trigger_to_terminal_seconds:.1f} s, so {trigger.split('@')[0].strip()} looks like a precursor event rather than the terminal drop itself."
        )
    if procedure_family == "umts" and rat_guess == "3G":
        next_checks.extend(
            [
                "Check UMTS active-set / neighbor-set maintenance around the failure, including missing PSC candidates and Event 1A/1B/1C behavior.",
                "Review whether soft-handover control, radio link failure, or re-establishment attempts follow the Active Set Update failure.",
            ]
        )
    if "active_set_update_failure" in procedure_lower or "active set update failure" in procedure_lower:
        evidence.append("Active Set Update is a UMTS radio-control procedure, so this failure should be interpreted in 3G/soft-handover context.")
        next_checks.append("Validate why the Active Set Update failed: missing candidate leg, stale measurement reporting, or inability to maintain the active set.")
    if top_domain == "radio_coverage":
        next_checks.append("Check serving-versus-neighbor pilot balance and whether the drop follows sustained weak coverage rather than a pure signaling reject.")
    if top_domain == "radio_interference":
        next_checks.append("Review EcNo/quality degradation, pilot pollution, and short-term interference around the failure window.")

    hints = _build_engineering_hints(
        rat_guess=rat_guess,
        procedure_family=procedure_family,
        procedure_text=procedure_text,
        top_domain=top_domain,
        trigger=trigger,
        trigger_to_terminal_seconds=trigger_to_terminal_seconds,
        neighbor_analysis=neighbor_analysis,
    )

    def _cf_get(row, *keys):
        cf_row = {k.casefold(): v for k, v in row.items()}
        for k in keys:
            if k.casefold() in cf_row:
                return cf_row[k.casefold()]
        return None

    radio_series = []
    for row in radio_rows:
        time_str = _cf_get(row, "time")
        if not time_str:
            continue
        radio_series.append({
            "time": time_str,
            "rscp": _to_number(_cf_get(row, "rscp", "rscpdbm", "servingRscpDbm")),
            "ecno": _to_number(_cf_get(row, "ecno", "ecnodb", "servingEcnoDb")),
            "rsrp": _to_number(_cf_get(row, "rsrp", "rsrpdbm", "servingRsrpDbm")),
            "rsrq": _to_number(_cf_get(row, "rsrq", "rsrqdb", "servingRsrqDb")),
        })

    neighbor_series = []
    for row in neighbor_rows:
        time_str = _cf_get(row, "time")
        if not time_str:
            continue
        candidate_sc = str(_cf_get(row, "bestNeighborSc", "candidateSc", "psc") or "").strip()
        serving_sc = str(_cf_get(row, "servingSc", "servingPsc") or "").strip()
        if candidate_sc and candidate_sc != "null":
            neighbor_series.append({
                "time": time_str,
                "serving_sc": serving_sc if serving_sc != "null" else None,
                "candidate_sc": candidate_sc,
                "delta_rscp": _to_number(_cf_get(row, "bestNeighborDeltaRscpDb", "deltaRscpDb")),
                "delta_ecno": _to_number(_cf_get(row, "bestNeighborDeltaEcnoDb", "deltaEcnoDb")),
                "type": _cf_get(row, "bestNeighborType"),
            })

    signal_series = []
    for row in signal_rows:
        time_str = _cf_get(row, "time")
        msg = _cf_get(row, "message", "event", "msg")
        if time_str and msg:
            signal_series.append({"time": time_str, "message": msg})

    return {
        "is_issue_bundle": "# telecom issue bundle for local ai" in str(text or "").lower(),
        "issue_type": issue_type,
        "rat_guess": rat_guess,
        "metric_family": metric_family,
        "procedure_family": procedure_family,
        "trigger_event": trigger,
        "terminal_event": terminal_marker,
        "trigger_to_terminal_seconds": trigger_to_terminal_seconds,
        "dominant_failure_domain": top_domain,
        "dominant_failure_domain_label": DOMAIN_LABELS[top_domain],
        "domain_scores": scores,
        "evidence": evidence[:12],
        "anomalies": _dedupe(anomalies)[:8],
        "next_checks": _dedupe(next_checks)[:10],
        "limitations": limitations[:12],
        "confidence_ceiling": confidence_ceiling,
        "confidence_rationale": _dedupe(confidence_rationale),
        "key_events": _dedupe(key_events)[:12],
        "summary_hint": hints.get("summary_hint"),
        "root_cause_hint": hints.get("root_cause_hint"),
        "style_hints": hints.get("style_hints") or [],
        "fields": fields,
        "radio_series": radio_series,
        "neighbor_series": neighbor_series,
        "signal_series": signal_series,
    }

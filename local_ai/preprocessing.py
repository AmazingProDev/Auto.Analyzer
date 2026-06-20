from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass


TIMESTAMP_PATTERNS = [
    re.compile(r"\b\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:[.,]\d{1,6})?(?:Z|[+-]\d{2}:\d{2})?\b"),
    re.compile(r"\b\d{2}[./-]\d{2}[./-]\d{4}[ T]\d{2}:\d{2}:\d{2}(?:[.,]\d{1,6})?\b"),
    re.compile(r"\b\d{2}:\d{2}:\d{2}(?:[.,]\d{1,6})?\b"),
]

IDENTIFIER_PATTERNS = {
    "session": [
        re.compile(r"\b(?:session(?:[_ -]?id)?|sess(?:ion)?|call(?:[_ -]?id)?|trace(?:[_ -]?id)?|proc(?:edure)?(?:[_ -]?id)?)\s*[:=]\s*([A-Za-z0-9._:-]{3,64})", re.I),
    ],
    "imsi": [
        re.compile(r"\bimsi\s*[:=]\s*([0-9]{5,20})\b", re.I),
        re.compile(r"\b(?:supi|subscriber)\s*[:=]\s*([0-9]{5,20})\b", re.I),
    ],
    "ue": [
        re.compile(r"\b(?:ue(?:[_ -]?id)?|guti|tmsi|crnti|c-rnti|rnti|imei|imeisv)\s*[:=]\s*([A-Za-z0-9._:-]{3,64})\b", re.I),
    ],
    "cell": [
        re.compile(r"\b(?:cell(?:[_ -]?id)?|ecgi|cgi|eci|pci|nci|enb(?:[_ -]?id)?|gnb(?:[_ -]?id)?)\s*[:=]\s*([A-Za-z0-9._:-]{1,64})\b", re.I),
    ],
    "bearer": [
        re.compile(r"\b(?:bearer(?:[_ -]?id)?|e[- ]?rab(?:[_ -]?id)?|drb(?:[_ -]?id)?|srb(?:[_ -]?id)?|qci|pdu(?:[_ -]?session)?(?:[_ -]?id)?)\s*[:=]\s*([A-Za-z0-9._:-]{1,64})\b", re.I),
    ],
    "cause_codes": [
        re.compile(r"\b(?:cause(?:[_ -]?code)?|emm(?:[_ -]?cause)?|esm(?:[_ -]?cause)?|nas(?:[_ -]?cause)?|rrc(?:[_ -]?cause)?|reject(?:[_ -]?cause)?)\s*[:=]\s*([A-Za-z0-9._:-]{1,64})\b", re.I),
    ],
}

RAT_RULES = {
    "5G": [
        re.compile(r"\b5g\b", re.I),
        re.compile(r"\bnr\b", re.I),
        re.compile(r"\bgnb\b", re.I),
        re.compile(r"\bngap\b", re.I),
        re.compile(r"\bamf\b", re.I),
        re.compile(r"\bpdu session\b", re.I),
        re.compile(r"\bnsa\b", re.I),
        re.compile(r"\bsa\b", re.I),
    ],
    "4G": [
        re.compile(r"\b4g\b", re.I),
        re.compile(r"\blte\b", re.I),
        re.compile(r"\benb\b", re.I),
        re.compile(r"\bs1ap\b", re.I),
        re.compile(r"\bmme\b", re.I),
        re.compile(r"\beps\b", re.I),
        re.compile(r"\be[- ]?rab\b", re.I),
        re.compile(r"\bearfcn\b", re.I),
    ],
    "3G": [
        re.compile(r"\b3g\b", re.I),
        re.compile(r"\bumts\b", re.I),
        re.compile(r"\bwcdma\b", re.I),
        re.compile(r"\brnc\b", re.I),
        re.compile(r"\biu[- ]?(?:cs|ps)?\b", re.I),
        re.compile(r"\brab\b", re.I),
        re.compile(r"\brscp\b", re.I),
        re.compile(r"\bec/?no\b", re.I),
    ],
}


@dataclass(frozen=True)
class LineRecord:
    line_no: int
    text: str
    timestamp: str | None
    identifiers: dict[str, list[str]]
    rat_hits: dict[str, int]


def normalize_log_text(text: str) -> str:
    return str(text or "").replace("\r\n", "\n").replace("\r", "\n")


def _extract_timestamp(text: str) -> str | None:
    for pattern in TIMESTAMP_PATTERNS:
        match = pattern.search(text)
        if match:
            return match.group(0)
    return None


def _extract_identifiers(text: str, max_values: int) -> dict[str, list[str]]:
    results: dict[str, list[str]] = {}
    for key, patterns in IDENTIFIER_PATTERNS.items():
        values: list[str] = []
        for pattern in patterns:
            for match in pattern.finditer(text):
                value = str(match.group(1) or "").strip()
                if value and value not in values:
                    values.append(value)
                if len(values) >= max_values:
                    break
            if len(values) >= max_values:
                break
        results[key] = values
    return results


def _detect_rat_hits(text: str) -> dict[str, int]:
    hits = {key: 0 for key in RAT_RULES}
    for rat, patterns in RAT_RULES.items():
        hits[rat] = sum(1 for pattern in patterns if pattern.search(text))
    return hits


def _build_line_records(text: str, max_identifier_values: int) -> list[LineRecord]:
    lines = []
    for idx, raw_line in enumerate(normalize_log_text(text).split("\n"), start=1):
        line = raw_line.rstrip()
        if not line.strip():
            continue
        lines.append(
            LineRecord(
                line_no=idx,
                text=line,
                timestamp=_extract_timestamp(line),
                identifiers=_extract_identifiers(line, max_identifier_values),
                rat_hits=_detect_rat_hits(line),
            )
        )
    return lines


def _pick_primary_identifier(record: LineRecord, strategy: str) -> str | None:
    if strategy == "session":
        return next(iter(record.identifiers.get("session") or []), None)
    if strategy == "ue":
        return next(iter(record.identifiers.get("imsi") or []), None) or next(iter(record.identifiers.get("ue") or []), None)
    return None


def _slice_group_records(records: list[LineRecord], target_lines: int, overlap_lines: int) -> list[list[LineRecord]]:
    if not records:
        return []
    if len(records) <= target_lines:
        return [records]
    step = max(1, target_lines - overlap_lines)
    chunks = []
    start = 0
    while start < len(records):
        end = min(len(records), start + target_lines)
        chunk = records[start:end]
        if not chunk:
            break
        chunks.append(chunk)
        if end >= len(records):
            break
        start += step
    return chunks


def _segment_records(records: list[LineRecord], strategy: str) -> tuple[list[tuple[str | None, list[LineRecord]]], int]:
    if strategy not in {"session", "ue"}:
        return [], 0
    keyed_lines = 0
    groups: list[tuple[str | None, list[LineRecord]]] = []
    current_key = None
    current_records: list[LineRecord] = []
    for record in records:
        key = _pick_primary_identifier(record, strategy)
        if key:
            keyed_lines += 1
        if not current_records:
            current_key = key
            current_records = [record]
            continue
        if key and current_key and key != current_key:
            groups.append((current_key, current_records))
            current_key = key
            current_records = [record]
            continue
        if key and current_key is None:
            current_key = key
        current_records.append(record)
    if current_records:
        groups.append((current_key, current_records))
    return groups, keyed_lines


def _merge_identifier_sets(records: list[LineRecord], max_identifier_values: int) -> dict[str, list[str]]:
    merged = {key: [] for key in IDENTIFIER_PATTERNS}
    for record in records:
        for key, values in record.identifiers.items():
            current = merged.setdefault(key, [])
            for value in values:
                if value not in current:
                    current.append(value)
                if len(current) >= max_identifier_values:
                    break
    return merged


def _merge_rat_hits(records: list[LineRecord]) -> dict[str, int]:
    counts = {key: 0 for key in RAT_RULES}
    for record in records:
        for rat, value in record.rat_hits.items():
            counts[rat] += int(value or 0)
    return counts


def _choose_suspected_rat(rat_hits: dict[str, int]) -> str:
    ranked = sorted(rat_hits.items(), key=lambda item: (-item[1], item[0]))
    if not ranked or ranked[0][1] <= 0:
        return "unknown"
    if len(ranked) > 1 and ranked[0][1] == ranked[1][1]:
        return "mixed"
    return ranked[0][0]


def preprocess_log_text(
    text: str,
    *,
    chunk_target_lines: int = 160,
    overlap_lines: int = 30,
    max_identifier_values: int = 12,
) -> dict:
    records = _build_line_records(text, max_identifier_values)
    if not records:
        return {
            "lineCount": 0,
            "segmentationStrategy": "window",
            "detectedRat": "unknown",
            "identifiersFound": {key: [] for key in IDENTIFIER_PATTERNS},
            "chunks": [],
        }

    groups, session_keyed_lines = _segment_records(records, "session")
    strategy = "session"
    if session_keyed_lines <= 0:
        groups, ue_keyed_lines = _segment_records(records, "ue")
        strategy = "ue"
        if ue_keyed_lines <= 0:
            groups = [(None, records)]
            strategy = "window"

    chunk_records = []
    for group_key, group in groups:
        for sliced in _slice_group_records(group, chunk_target_lines, overlap_lines):
            chunk_records.append((group_key, sliced))

    chunks = []
    overall_rat = Counter()
    for idx, (group_key, group) in enumerate(chunk_records, start=1):
        timestamps = [record.timestamp for record in group if record.timestamp]
        identifiers = _merge_identifier_sets(group, max_identifier_values)
        rat_hits = _merge_rat_hits(group)
        overall_rat.update(rat_hits)
        chunks.append(
            {
                "id": f"chunk-{idx:03d}",
                "index": idx,
                "strategy": strategy,
                "lineRange": {
                    "start": group[0].line_no,
                    "end": group[-1].line_no,
                },
                "lineCount": len(group),
                "content": "\n".join(record.text for record in group),
                "metadata": {
                    "groupKey": group_key,
                    "startTimestamp": timestamps[0] if timestamps else None,
                    "endTimestamp": timestamps[-1] if timestamps else None,
                    "suspectedRat": _choose_suspected_rat(rat_hits),
                    "ratSignals": rat_hits,
                    "identifiers": identifiers,
                },
            }
        )

    overall_identifiers = _merge_identifier_sets(records, max_identifier_values)
    detected_rat = _choose_suspected_rat(dict(overall_rat))

    return {
        "lineCount": len(records),
        "segmentationStrategy": strategy,
        "detectedRat": detected_rat,
        "identifiersFound": overall_identifiers,
        "chunks": chunks,
    }

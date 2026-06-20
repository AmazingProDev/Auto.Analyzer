from __future__ import annotations

import json
import time
from typing import Any, Optional

from .config import LocalAIConfig
from .lmstudio_client import LMStudioClient, LMStudioClientError


PILOT_POLLUTION_SYSTEM_PROMPT = """You are a senior LTE RF optimization engineer analyzing drive-test pilot pollution events.

You receive pre-processed data from a deterministic analysis engine: verdict, serving-cell KPIs at the selected sample, all non-serving polluter PCIs with scores, the serving-cell dwell sequence with timestamps, and the raw MR/A3 measurement report table. Your role is to provide expert interpretation BEYOND what the engine already computed.

Apply these skills:
1. MR TABLE ANALYSIS: Scan the MR table for rows where a neighbor RSRP exceeds or equals the serving RSRP — these are dominance inversions. Cite the exact timestamp and RSRP values.
2. EVIDENCE SEPARATION — CRITICAL: The input contains TWO distinct evidence tiers that must never be conflated:
   • POINT evidence = KPIs from the single selected sample (DetConf, AttrConf, serving RSRP/RSRQ/SINR, strong-cell count at that instant).
   • EVENT evidence = aggregated KPIs across the full event duration (Avg RSRQ, Avg SINR, dwell percentages, A3 rate, max strong-cell counts across all samples).
   When citing quality: say "at the selected sample, RSRQ was X dB" — never just "RSRQ is X dB". Say "averaged over the event, RSRQ was Y dB". If point and event evidence conflict (e.g., point SINR looks acceptable but event Avg SINR is degraded), flag the discrepancy explicitly in the summary.
3. CONFIDENCE INTERPRETATION: Point-level DetConf and event-level DetConf can differ significantly because they measure different things — the selected sample may have been captured moments after a handover completed (temporary improvement) while event-level metrics capture sustained interference behavior. The confidence_explanation field must state both values and explain the divergence if they differ by more than 0.2.
4. DUAL-ROLE CELL IDENTIFICATION: If a PCI appears in the serving-cell dwell sequence AND also appears in the polluter table, label it "Dynamic contributor / former serving cell" in summary and technical_details. Explain the serving→non-serving transition (handover to a new dominant cell) and note that this PCI was a legitimate server during its dwell block, not pure interference.
5. CLASSIFICATION PRECISION — CRITICAL: Use the correct root cause label:
   • pilot_pollution: ≥3 cells simultaneously within 5 dB of serving RSRP, with no single dominant aggressor. True pilot pollution means the UE cannot establish a dominant cell.
   • dominance_ambiguity: 2 strong cells competing, one typically 3–5 dB ahead but losing dominance intermittently. The UE CAN establish a dominant cell most of the time but struggles in transitions. Use this when max strong cells ≤ 2 at the selected point but event-level data shows 3–4 competing cells.
   • dominance_inversion: A single neighbor is clearly stronger than the serving cell at specific timestamps.
   When selected strong cells = 2 but event-level max strong cells = 3–4, lead the summary with event-level evidence as the primary characterization. Do not understate the event-level severity.
6. TEMPORAL PATTERN: Identify whether pollution is continuous or burst-like. Check for rapid RSRP swings (>6 dB in <1 s) that indicate a geometric/LOS effect rather than a planning issue.
7. ACTIONABLE RECOMMENDATIONS: Name the PCI and suggest a concrete action — not "reduce power" but "reduce PCI 147 EIRP by 3–6 dB" or "apply 2° additional electrical downtilt to PCI 229 to shrink its footprint on this road segment".

Return valid JSON with exactly these keys:
- summary: 3-5 sentences. Lead with EVENT-level evidence as the primary characterization of severity. Describe the temporal evolution using MR timestamps. Flag any divergence between point-level and event-level KPIs explicitly. Do NOT restate what is already shown in the metric cards.
- root_cause: Exactly one of [over_coverage_distant_site | dominance_ambiguity | dominance_inversion | measurement_storm | handover_ping_pong | multi_cell_overlap | pilot_pollution | insufficient_evidence], then a colon and one sentence citing specific PCIs and MR evidence.
- root_cause_confidence: "low" | "medium" | "high"
- confidence_explanation: 2-3 sentences. State the point-level DetConf value and what it reflects (single-sample conditions at that instant). State the event-level DetConf and what it reflects (sustained behavior over the event duration). Explain why they diverge if they differ by more than 0.2.
- recommendations: array of 3–4 strings. Each must: (a) name a specific PCI, (b) suggest a concrete RF or mobility parameter with a quantified target, (c) be under 40 words. Order: fix RF dominance first, then mobility parameters.
- technical_details: 4–8 sentences of deeper analysis. Reference specific MR timestamps for dominance inversions. Quantify RSRP swings between consecutive MRs. Explain the handover trigger mechanism visible in the data. Label any dual-role cells (former serving + current polluter). Cross-reference dwell percentages with polluter scores.
- limitations: 2–4 strings identifying data gaps or caveats. Note single-event snapshots, stale SINR age, or serving-cell correction.

Hard rules:
- Strictly factual — cite only values present in the input data.
- Round RSRP/RSRQ/SINR to 1 decimal place.
- NEVER conflate point-level and event-level evidence — always label which tier you are citing.
- If point-level detectionConfidence < 0.5 AND event-level detectionConfidence < 0.7, root_cause_confidence must be "low". If point < 0.5 but event ≥ 0.7, "medium" is acceptable with an explanation in confidence_explanation.
- If servingCellCorrectionApplied is true, note it in limitations.
- recommendations must be a JSON array of strings, not an object.
- confidence_explanation must be a plain string, not an array.
- Confidence must be exactly one of: low, medium, high."""

VALID_ROOT_CAUSES = {
    "over_coverage_distant_site",
    "dominance_ambiguity",
    "dominance_inversion",
    "measurement_storm",
    "handover_ping_pong",
    "multi_cell_overlap",
    "pilot_pollution",
    "insufficient_evidence",
}


def _fmt_rsrp(v: Any) -> str:
    try:
        return f"{float(v):.1f}"
    except Exception:
        return "—"


def _short_time(iso: Any) -> str:
    s = str(iso or "")
    # Strip date prefix and ms suffix: "2025-12-04T11:30:21.510Z" → "11:30:21.5Z"
    if "T" in s:
        s = s.split("T", 1)[1]
    s = s.rstrip("Z")
    # Keep up to first decimal of seconds
    parts = s.split(".")
    if len(parts) == 2:
        s = parts[0] + "." + parts[1][:1] + "Z"
    else:
        s = s + "Z"
    return s


def build_prompt(analysis: dict) -> str:
    """Build a structured text prompt with full MR table and dwell data."""
    summary = analysis.get("summary") or {}
    selected = summary.get("selectedSample") or {}
    events = analysis.get("events") or []
    debug = analysis.get("debug") or {}
    serving = selected.get("serving") or {}

    verdict = analysis.get("verdict") or "unknown"
    center_time = _short_time(analysis.get("centerTime"))
    earfcn = serving.get("earfcn") or (events[0].get("carrier") if events else "—")

    lines: list[str] = []

    # ── Header ────────────────────────────────────────────────────────────────
    lines.append(f"=== LTE PILOT POLLUTION ANALYSIS ===")
    lines.append(
        f"VERDICT: {verdict.upper()}  |  EARFCN: {earfcn}  |  TIME: {center_time}"
    )
    lines.append(
        f"Events: {summary.get('eventCount', '?')}  |  "
        f"Polluted samples: {summary.get('pollutedSampleCount', '?')}  |  "
        f"ServingCellCorrectionApplied: {bool(debug.get('servingCellCorrection'))}"
    )
    lines.append("")

    # ── Selected sample ───────────────────────────────────────────────────────
    lines.append("SELECTED SAMPLE")
    lines.append(
        f"  Serving PCI {serving.get('pci')} | RSRP {_fmt_rsrp(serving.get('rsrp'))} dBm | "
        f"RSRQ {_fmt_rsrp(serving.get('rsrq'))} dB | SINR {_fmt_rsrp(serving.get('sinr'))} dB"
    )
    lines.append(
        f"  Best RSRP: {_fmt_rsrp(selected.get('bestRsrp'))} dBm | "
        f"Strong cells (≤5 dB): {selected.get('strongCellCount', '?')} | "
        f"DetConf: {selected.get('detectionConfidence', '?')} | "
        f"AttrConf: {selected.get('attributionConfidence', '?')}"
    )
    qual = selected.get("qualityBadIndicators") or []
    if qual:
        lines.append(f"  Quality indicators: {', '.join(str(q) for q in qual)}")
    lines.append("")

    # ── Polluter table ────────────────────────────────────────────────────────
    polluters = (summary.get("topPolluters") or [])[:8]
    if polluters:
        lines.append("NON-SERVING POLLUTERS (by score, descending)")
        lines.append("  PCI  | Samples | Core≤3dB | AvgRSRP  | AvgΔ   | Score")
        for p in polluters:
            samples = p.get("nonServingPolluterSampleCount") or p.get("sampleCount") or 0
            core = p.get("corePolluterSampleCount")
            core_str = f"{core}/{samples}" if core is not None else "—"
            lines.append(
                f"  {str(p.get('pci', '?')):4s} | {str(samples):7s} | {core_str:8s} | "
                f"{_fmt_rsrp(p.get('averageRsrp')):8s} | "
                f"{_fmt_rsrp(p.get('averageDeltaToBest')):6s} | "
                f"{p.get('polluterScore', '?')}"
            )
        lines.append("")

    # ── Per-event details ─────────────────────────────────────────────────────
    for ev_idx, ev in enumerate(events[:2]):
        counts = ev.get("eventCounts") or {}
        ho_count = max(
            counts.get("IntraFrequencyHandover") or 0,
            counts.get("HandoverStart") or 0,
        )
        a3_count = counts.get("A3") or 0
        dur = ev.get("durationSeconds")
        a3_rate = round(a3_count / dur, 2) if dur and a3_count else None

        lines.append(
            f"EVENT {ev_idx + 1} | EARFCN {ev.get('carrier')} | "
            f"Duration {dur}s | Severity: {ev.get('severity')} | "
            f"DetConf {ev.get('detectionConfidence')} | AttrConf {ev.get('attributionConfidence')}"
        )
        lines.append(
            f"  Max cells ≤5 dB: {ev.get('maxStrongCellsWithin5dB')} | "
            f"Core ≤3 dB: {ev.get('maxStrongCellsWithin3dB')} | "
            f"Avg RSRQ: {_fmt_rsrp(ev.get('averageServingRsrq'))} dB | "
            f"Avg SINR: {_fmt_rsrp(ev.get('averageServingSinr'))} dB"
        )
        lines.append(
            f"  Intra-HO count: {ho_count} | A3 events: {a3_count}"
            + (f" (rate {a3_rate}/s{'  ← ELEVATED' if a3_rate and a3_rate > 2.0 else ''})" if a3_rate else "")
        )

        # Evidence strings
        evidence = (ev.get("evidence") or [])[:6]
        if evidence:
            lines.append("  Engine evidence:")
            for e in evidence:
                lines.append(f"    • {e}")

        # Serving dwell breakdown with timestamps
        dwells = ev.get("servingDwellBlocks") or []
        if dwells:
            total_samples = sum(b.get("sampleCount") or 0 for b in dwells)
            lines.append("  Serving-cell dwell sequence:")
            seen: dict[int, int] = {}
            for blk in dwells:
                pci = blk.get("pci")
                if pci is None:
                    continue
                seen[pci] = seen.get(pci, 0) + (blk.get("sampleCount") or 0)
            for blk in dwells:
                pci = blk.get("pci")
                if pci is None:
                    continue
                sc = blk.get("sampleCount") or 0
                pct = round(sc / total_samples * 100) if total_samples else 0
                t0 = _short_time(blk.get("startTime"))
                t1 = _short_time(blk.get("endTime"))
                avg_rsrp = blk.get("averageRsrp")
                rsrp_str = f" | Avg RSRP {_fmt_rsrp(avg_rsrp)} dBm" if avg_rsrp is not None else ""
                lines.append(f"    PCI {pci}: {t0}→{t1} | {sc} samples ({pct}%){rsrp_str}")

        # MR / A3 table
        a3_evs = ev.get("a3Events") or []
        if a3_evs:
            # Deduplicate by (time, servingPci, neighbor-fingerprint)
            seen_keys: set[str] = set()
            deduped = []
            for mr in a3_evs:
                nb_key = ",".join(str(n.get("pci")) for n in (mr.get("neighbors") or []))
                key = f"{mr.get('time')}|{mr.get('servingPci')}|{nb_key}"
                if key not in seen_keys:
                    seen_keys.add(key)
                    deduped.append(mr)

            lines.append(f"  MR/A3 table ({len(deduped)} unique events):")
            lines.append("    Time       | Type | SrvPCI | SrvRSRP | Neighbors (PCI: RSRP dBm)")
            for mr in deduped[:25]:
                t = _short_time(mr.get("time"))
                src = "A3" if mr.get("source") == "native_a3" else "MR"
                srv_pci = mr.get("servingPci") or "?"
                srv_rsrp = _fmt_rsrp(mr.get("servingRsrpDbm"))
                nbs = mr.get("neighbors") or []
                nb_str = "  ".join(
                    f"PCI{n.get('pci')}:{_fmt_rsrp(n.get('rsrpDbm'))}"
                    for n in nbs[:6]
                ) or "not decoded"
                # Flag dominance inversion inline
                inv = any(
                    (n.get("rsrpDbm") or -999) >= (mr.get("servingRsrpDbm") or -999)
                    for n in nbs
                )
                flag = " ← DOMINANCE INVERSION" if inv else ""
                lines.append(f"    {t:12s} | {src:4s} | {str(srv_pci):6s} | {srv_rsrp:7s} | {nb_str}{flag}")

        lines.append("")

    prompt = "\n".join(lines)
    return (
        "Analyze this LTE pilot pollution drive-test result and provide engineering-grade AI insights.\n"
        "The MR table shows real Layer-3 measurement reports. "
        "Lines marked '← DOMINANCE INVERSION' are rows where a neighbor RSRP equaled or exceeded the serving cell.\n\n"
        + prompt
    )


def _extract_json_object(text: str) -> Optional[dict]:
    raw = str(text or "").strip()
    if not raw:
        return None
    # Strip fenced code block
    for fence in ("```json", "```JSON", "```"):
        if raw.startswith(fence):
            raw = raw[len(fence):]
            break
    if raw.endswith("```"):
        raw = raw[:-3].strip()
    try:
        parsed = json.loads(raw)
        if isinstance(parsed, dict):
            return parsed
    except Exception:
        pass
    # Brace-depth scanner fallback
    start = raw.find("{")
    if start < 0:
        return None
    depth = 0
    in_string = False
    escape = False
    for idx in range(start, len(raw)):
        ch = raw[idx]
        if in_string:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                candidate = raw[start : idx + 1]
                try:
                    parsed = json.loads(candidate)
                    return parsed if isinstance(parsed, dict) else None
                except Exception:
                    return None
    return None


def _coerce_insights(raw_text: str) -> tuple[dict, bool]:
    parsed = _extract_json_object(raw_text)
    recovered = parsed is not None
    payload = parsed if isinstance(parsed, dict) else {}

    def as_str(v: Any, fallback: str = "") -> str:
        if v is None:
            return fallback
        if isinstance(v, list):
            return "; ".join(str(x).strip() for x in v if str(x).strip()) or fallback
        return str(v).strip() or fallback

    def as_list(v: Any) -> list[str]:
        if isinstance(v, list):
            return [str(x).strip() for x in v if str(x).strip()]
        if v is None:
            return []
        s = str(v).strip()
        return [s] if s else []

    raw_confidence = as_str(payload.get("root_cause_confidence"), "low").lower()
    if raw_confidence not in {"low", "medium", "high"}:
        raw_confidence = "low"

    raw_root_cause = as_str(payload.get("root_cause"), "insufficient_evidence")
    root_cause_key = raw_root_cause.split(":")[0].strip().lower().replace(" ", "_")
    if root_cause_key not in VALID_ROOT_CAUSES:
        raw_root_cause = "insufficient_evidence: " + raw_root_cause

    result: dict[str, Any] = {
        "summary": as_str(payload.get("summary"), "AI analysis could not be fully structured."),
        "root_cause": raw_root_cause,
        "root_cause_confidence": raw_confidence,
        "confidence_explanation": as_str(payload.get("confidence_explanation"), ""),
        "recommendations": as_list(payload.get("recommendations")),
        "technical_details": as_str(payload.get("technical_details"), ""),
        "limitations": as_list(payload.get("limitations")),
    }

    if not recovered:
        fallback = str(raw_text or "").strip().replace("\n", " ")
        if fallback:
            result["summary"] = fallback[:500]
        result["limitations"].append("Model returned malformed JSON; fallback text extraction used.")

    return result, recovered


def analyze(analysis: dict, config: LocalAIConfig, logger=None) -> dict:
    """
    Call LM Studio with the compacted pilot pollution analysis JSON.
    Returns {"insights": {...}, "jsonRecovered": bool, "latencyMs": float, "model": str}.
    Raises LMStudioClientError on connectivity failure.
    """
    log = logger or (lambda *_a, **_k: None)
    client = LMStudioClient(config, logger=log)
    user_prompt = build_prompt(analysis)

    # Ollama on local hardware (Apple Silicon CPU+GPU) runs at ~5-10 tok/s for 8B models.
    # 500 output tokens × ~6 tok/s ≈ 85 s; give 3× headroom so slow machines don't timeout.
    inference_timeout = 300 if config.is_ollama else max(config.timeout_sec, 180)

    payload = {
        "model": config.model,
        "temperature": 0.15,
        "messages": [
            {"role": "system", "content": PILOT_POLLUTION_SYSTEM_PROMPT},
            {"role": "user", "content": user_prompt},
        ],
    }
    use_native = config.is_ollama and "qwen3" in config.model.lower()
    if config.is_ollama:
        payload["keep_alive"] = -1
        payload["max_tokens"] = 500   # ~85 s at 6 tok/s; enough for all required JSON keys
        payload["options"] = {"num_ctx": 4096}
        if use_native:
            payload["think"] = False  # passed through _ollama_chat to /api/chat

    started = time.perf_counter()
    last_error: Optional[str] = None

    for attempt in range(config.max_retries + 1):
        try:
            if use_native:
                status, _headers, text = client._ollama_chat(payload, timeout=inference_timeout)
            else:
                status, _headers, text = client._request(
                    "POST", config.chat_completions_url, payload=payload,
                    timeout=inference_timeout,
                )
        except LMStudioClientError as exc:
            last_error = str(exc)
            if attempt >= config.max_retries:
                break
            time.sleep(min(1.5 * (attempt + 1), 3.0))
            continue

        if status in {408, 429, 500, 502, 503, 504}:
            last_error = f"LM Studio returned HTTP {status}"
            if attempt < config.max_retries:
                time.sleep(min(1.5 * (attempt + 1), 3.0))
            continue

        if status >= 400:
            raise LMStudioClientError(
                f"LM Studio returned HTTP {status}: {text[:300]}"
            )

        try:
            envelope = json.loads(text)
        except Exception as exc:
            raise LMStudioClientError(
                f"LM Studio returned invalid JSON envelope: {exc}"
            ) from exc

        choices = envelope.get("choices") if isinstance(envelope, dict) else None
        message = (choices[0].get("message") if isinstance(choices, list) and choices else None) or {}
        raw_output = str(message.get("content") or "").strip()

        # Qwen3 thinking mode: if content is empty, check reasoning_content for the answer.
        # This happens when the model emits the response inside the thinking block.
        if not raw_output:
            raw_output = str(message.get("reasoning_content") or "").strip()

        # Strip any residual <think>...</think> wrapper
        if "<think>" in raw_output:
            end = raw_output.find("</think>")
            raw_output = raw_output[end + len("</think>"):].strip() if end >= 0 else raw_output

        if not raw_output:
            last_error = "LM Studio returned empty completion."
            continue

        insights, recovered = _coerce_insights(raw_output)
        return {
            "insights": insights,
            "jsonRecovered": recovered,
            "latencyMs": round((time.perf_counter() - started) * 1000, 1),
            "model": config.model,
        }

    raise LMStudioClientError(
        last_error or "Pilot pollution AI analysis failed after retries."
    )

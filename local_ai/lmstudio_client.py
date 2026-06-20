from __future__ import annotations

import json
import socket
import time
import urllib.error
import urllib.request

from .config import LocalAIConfig
from .issue_context import engineer_issue_context


TELECOM_SYSTEM_PROMPT = """You are a telecom troubleshooting assistant specialized in 3G/4G/5G signaling and network logs.

You are acting like a senior RF/core troubleshooting engineer.

Analyze only the provided issue bundle or log chunk.

Return valid JSON with exactly these keys:
- summary
- trigger_event
- failure_domain
- key_events
- evidence
- anomalies
- likely_root_cause
- confidence
- confidence_rationale
- next_checks
- unknown_fields_or_limitations

Rules:
- Be strictly factual and concise. Write direct technical incident reports. Do NOT use meta-phrases like "The log explicitly links..." or "Despite being labeled as 4G...". Just report the engineering facts.
- Round any extracted floating-point radio metrics (like RSCP, EcNo, RSRP, RSRQ) to exactly 1 decimal place (e.g. -20.4 dB, not -20.3999).
- For Call Drops: Trace back to the critical precursor events (e.g., Active Set Update failures, Radio Link Failures, Handover Failures) leading to the terminal drop. Explicitly state whether the failure is coverage-induced, interference-induced, a mobility execution failure, or a core release.
- For Call Admission Failures (CAF): Analyze the setup signaling. Determine if the failure was due to lack of resources/congestion, missing responses (timeout/coverage loss), or active core network rejection.
- Explicitly extract and state the Serving Cell Name and PCI/PSC/SC. Do not skip them.
- Always include the exact Radio context values (RSRP/RSRQ or RSCP/EcNo) for the serving cell in your technical summary.
- Always perform and output a distinct analysis of the Neighbor cell measurements (e.g., strongest candidate PCI, delta RSCP/RSRP) observed prior to the failure.
- Do not invent missing events.
- Separate trigger from root cause:
  - trigger_event = terminal event or immediate failure marker.
  - likely_root_cause = Must strictly follow this concatenated template: [Event type] + [exact time] + [RF trend] + [signaling cause] + [mobility state] + [final root cause].
  - Do not repeat trigger_event as the root cause unless evidence is insufficient and you explicitly say that only a network-triggered release is visible.
- failure_domain must be one of:
  - radio_coverage
  - radio_interference
  - mobility
  - congestion
  - core_signaling
  - policy_or_network_release
  - device_or_ue
  - unknown
- Use deterministic backend evidence when present.
- When procedure names and metrics indicate UMTS/3G (for example Active Set Update with RSCP/EcNo), do not describe the issue as LTE/4G just because the parent logfile label says 4G.
- If neighbor evidence is present, explicitly assess whether a stronger/better PSC should likely have been added to the active set or treated as the preferable candidate.
- If vendor-specific fields are unclear, say so.
- Base conclusions only on the provided chunk.
- If signaling shows only a terminal release without enough causal detail, keep confidence conservative.
- If the selected trigger precedes the final drop by several seconds, describe it as a precursor/correlated failure marker rather than an immediate terminal event.
- Avoid repeating the same sentence across summary, evidence, anomalies, and next_checks.
- Confidence must be one of: low, medium, high.

*** EXPERT 3G NEMO RULES ***
Use these step-by-step rules to analyze 3G events safely:
1) True Drop vs CAF: For CAF, the call was released before connection (look for SETUP, but no CONNECT). A true DROP must show a CONNECT state existed before the release.
2) Stale Event Rows: Nemo event rows can carry stale/inherited serving context. If the event row says one cell, but the surrounding radio route samples and signaling clearly show another cell, trust the surrounding samples!
3) Judge RF Severity:
  - Good RF: RSCP > -90 dBm and EcNo > -9 dB
  - Marginal RF: RSCP -90 to -105 dBm or EcNo -9 to -14 dB
  - Bad RF: RSCP < -105 dBm or EcNo < -14 dB
4) RF Interpretation: 
  - Bad serving + bad neighbors = coverage/interference.
  - Bad serving + good neighbors = late/missing mobility.
  - Good serving + drop = look for signaling/RLC/core.
5) Check Mobility Behavior: Always inspect MEASUREMENT_REPORT, ACTIVE_SET_UPDATE, CELL_UPDATE, and CELL_UPDATE_CONFIRM. Watch out for PSC add/remove logic to detect ping-pongs or late SHO.
6) Look for RRC/RLC Smoking Guns: RRC_CONNECTION_RELEASE, directedsignallingconnectionre-establishment, cellUpdateCause = rlc-unrecoverableError, RLC re-establishment, or SIGNALLING_CONNECTION_RELEASE_INDICATION. If RF is Good and signaling shows rlc-unrecoverableError or bearer resets, the root cause is transport/RAN, NEVER coverage.
7) Timer-Expiry / Abnormal Clear: If DISCONNECT occurs first, followed by RELEASE with "Recovery on timer expiry", this is a timer-expiry abnormal clear, NOT a pure coverage drop (though weak RF may contribute).
8) Ensure your conclusion strictly follows this format: [Event type] + [exact time] + [RF trend] + [signaling cause] + [mobility state] + [final root cause].
9) Weak Coverage vs Pilot Pollution: 
  - Weak Coverage: Serving RSCP is bad (< -105 dBm) AND neighbors are also weak.
  - Pilot Pollution: Serving RSCP is strong (> -85 dBm), but serving EcNo is poor (< -10 dB), accompanied by a "crowded air" neighbor list (2+ PSCs within 5dB overlap). If signaling is unstable (e.g. repeated Cell Updates/re-establishments/SHO instability), definitively classify the root cause as "Service-Impacting Pilot Pollution." The biggest mistake is blaming pure weak coverage when serving RSCP > -85 dBm."""

REQUIRED_ANALYSIS_KEYS = [
    "summary",
    "trigger_event",
    "failure_domain",
    "key_events",
    "evidence",
    "anomalies",
    "likely_root_cause",
    "confidence",
    "confidence_rationale",
    "next_checks",
    "unknown_fields_or_limitations",
]


class LMStudioClientError(RuntimeError):
    pass


class LMStudioModelUnavailableError(LMStudioClientError):
    pass


def _dedupe_texts(values) -> list[str]:
    seen = set()
    cleaned = []
    for value in values or []:
        item = str(value or "").strip()
        if not item:
            continue
        key = item.casefold()
        if key in seen:
            continue
        seen.add(key)
        cleaned.append(item)
    return cleaned


def _clamp_confidence(value: str, ceiling: str | None = None) -> str:
    confidence = str(value or "low").strip().lower()
    if confidence not in {"low", "medium", "high"}:
        confidence = "low"
    order = {"low": 1, "medium": 2, "high": 3}
    if ceiling in order and order[confidence] > order[ceiling]:
        return ceiling
    return confidence


def _extract_json_object(text: str) -> dict | None:
    raw = str(text or "").strip()
    if not raw:
        return None
    raw = raw.replace("```json", "```").replace("```JSON", "```")
    if raw.startswith("```") and raw.endswith("```"):
        raw = raw[3:-3].strip()
    try:
        parsed = json.loads(raw)
        if isinstance(parsed, dict):
            return parsed
    except Exception:
        pass
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
                candidate = raw[start:idx + 1]
                try:
                    parsed = json.loads(candidate)
                    if isinstance(parsed, dict):
                        return parsed
                except Exception:
                    return None
    return None


def coerce_analysis_payload(raw_text: str, parse_issue: str | None = None) -> tuple[dict, bool]:
    parsed = _extract_json_object(raw_text)
    recovered = parsed is not None
    payload = parsed if isinstance(parsed, dict) else {}

    def as_text(value, fallback=""):
        if value is None:
            return fallback
        if isinstance(value, (list, tuple)):
            joined = "; ".join(str(item).strip() for item in value if str(item).strip())
            return joined or fallback
        text = str(value).strip()
        return text or fallback

    def as_list(value):
        if isinstance(value, list):
            return _dedupe_texts(value)
        if value is None:
            return []
        text = str(value).strip()
        if not text:
            return []
        return [text]

    result = {
        "summary": as_text(payload.get("summary"), "Model response could not be fully structured."),
        "trigger_event": as_text(payload.get("trigger_event"), ""),
        "failure_domain": as_text(payload.get("failure_domain"), "unknown"),
        "key_events": as_list(payload.get("key_events")),
        "evidence": as_list(payload.get("evidence")),
        "anomalies": as_list(payload.get("anomalies")),
        "likely_root_cause": as_text(payload.get("likely_root_cause"), "Unknown from this chunk."),
        "confidence": _clamp_confidence(as_text(payload.get("confidence"), "low")),
        "confidence_rationale": as_text(payload.get("confidence_rationale"), ""),
        "next_checks": as_list(payload.get("next_checks")),
        "unknown_fields_or_limitations": as_list(payload.get("unknown_fields_or_limitations")),
    }
    if result["failure_domain"] not in {
        "radio_coverage",
        "radio_interference",
        "mobility",
        "congestion",
        "core_signaling",
        "policy_or_network_release",
        "device_or_ue",
        "unknown",
    }:
        result["failure_domain"] = "unknown"
    if not recovered:
        fallback_summary = str(raw_text or "").strip().replace("\n", " ")
        if fallback_summary:
            result["summary"] = fallback_summary[:400]
        result["unknown_fields_or_limitations"].append("Model returned malformed JSON; fallback parser used.")
    if parse_issue:
        result["unknown_fields_or_limitations"].append(parse_issue)
    result["unknown_fields_or_limitations"] = _dedupe_texts(result["unknown_fields_or_limitations"])
    result["key_events"] = _dedupe_texts(result["key_events"])
    result["evidence"] = _dedupe_texts(result["evidence"])
    result["anomalies"] = _dedupe_texts(result["anomalies"])
    result["next_checks"] = _dedupe_texts(result["next_checks"])
    return result, recovered


def _apply_engineering_guardrails(result: dict, engineered: dict) -> dict:
    analysis = dict(result or {})
    domain = str(analysis.get("failure_domain") or "unknown").strip().lower()
    allowed_domains = {
        "radio_coverage",
        "radio_interference",
        "mobility",
        "congestion",
        "core_signaling",
        "policy_or_network_release",
        "device_or_ue",
        "unknown",
    }
    if domain not in allowed_domains:
        domain = "unknown"
    engineered_domain = str(engineered.get("dominant_failure_domain") or "unknown")
    if domain == "unknown" and engineered_domain in allowed_domains:
        analysis["failure_domain"] = engineered_domain
    else:
        analysis["failure_domain"] = domain

    if not str(analysis.get("trigger_event") or "").strip():
        analysis["trigger_event"] = engineered.get("trigger_event") or "Terminal event"

    confidence_ceiling = engineered.get("confidence_ceiling") if engineered.get("is_issue_bundle") else None
    analysis["confidence"] = _clamp_confidence(
        analysis.get("confidence"),
        confidence_ceiling,
    )

    evidence = _dedupe_texts((analysis.get("evidence") or []) + (engineered.get("evidence") or []))
    analysis["evidence"] = evidence[:12]

    key_events = _dedupe_texts((analysis.get("key_events") or []) + (engineered.get("key_events") or []))
    analysis["key_events"] = key_events[:12]

    anomalies = _dedupe_texts((analysis.get("anomalies") or []) + (engineered.get("anomalies") or []))
    analysis["anomalies"] = anomalies[:12]

    next_checks = _dedupe_texts((analysis.get("next_checks") or []) + (engineered.get("next_checks") or []))
    analysis["next_checks"] = next_checks[:12]

    limitations = _dedupe_texts((analysis.get("unknown_fields_or_limitations") or []) + (engineered.get("limitations") or []))
    analysis["unknown_fields_or_limitations"] = _dedupe_texts(limitations)[:20]

    rationale_bits = []
    if str(analysis.get("confidence_rationale") or "").strip():
        rationale_bits.append(str(analysis.get("confidence_rationale") or "").strip())
    rationale_bits.extend(engineered.get("confidence_rationale") or [])
    analysis["confidence_rationale"] = " ".join(_dedupe_texts(rationale_bits)).strip()

    summary_hint = str(engineered.get("summary_hint") or "").strip()
    if summary_hint:
        summary = str(analysis.get("summary") or "").strip()
        should_replace_summary = (
            not summary
            or len(summary) > 220
            or "immediately" in summary.casefold()
            or ("4g" in summary.casefold() and engineered.get("rat_guess") == "3G")
        )
        if not should_replace_summary and "psc " in summary_hint.casefold() and "psc " not in summary.casefold():
            should_replace_summary = True
        if should_replace_summary:
            analysis["summary"] = summary_hint

    if engineered.get("rat_guess") and engineered.get("rat_guess") != "unknown":
        analysis["rat_hint"] = engineered["rat_guess"]
        summary = str(analysis.get("summary") or "")
        if summary and engineered["rat_guess"] not in summary:
            if "4g" in summary.casefold() and engineered["rat_guess"] == "3G":
                analysis["summary"] = f"UMTS/3G issue context. {summary}"
            else:
                analysis["summary"] = f"{engineered['rat_guess']} issue analysis. {summary}"

    if engineered.get("trigger_to_terminal_seconds") is not None and engineered.get("trigger_to_terminal_seconds") >= 3:
        summary = str(analysis.get("summary") or "")
        if "immediately" in summary.casefold():
            analysis["summary"] = summary.replace("immediately following", "after a preceding").replace("immediately", "after a preceding")

    root_cause = str(analysis.get("likely_root_cause") or "").strip()
    root_cause_hint = str(engineered.get("root_cause_hint") or "").strip()
    if root_cause_hint:
        if (
            not root_cause
            or len(root_cause) > 180
            or "poor radio coverage" in root_cause.casefold()
            or "weak radio quality" in root_cause.casefold()
        ):
            analysis["likely_root_cause"] = root_cause_hint
            root_cause = analysis["likely_root_cause"]
    if not root_cause or root_cause.lower() == "unknown from this chunk.":
        if analysis["failure_domain"] == "policy_or_network_release":
            analysis["likely_root_cause"] = "Only a network-triggered release is directly visible; the underlying cause remains unconfirmed from this issue bundle."
        elif analysis["failure_domain"] != "unknown":
            analysis["likely_root_cause"] = (
                f"Evidence points to the {analysis['failure_domain'].replace('_', ' ')} domain, but the exact failure mechanism is not proven from this issue bundle."
            )

    if engineered.get("rat_guess") == "3G":
        umts_checks = []
        for item in analysis.get("next_checks") or []:
            text = str(item or "").strip()
            if not text:
                continue
            low = text.casefold()
            if "network configuration changes" in low:
                continue
            if "neighboring cell load" in low:
                umts_checks.append("Audit PSC neighbor definitions and SHO readiness for the serving PSC versus the strongest candidate PSC in the failure window.")
                continue
            if "ue behavior" in low:
                umts_checks.append("Check measurement-report content and confirm whether Event 1A/1B/1C should have promoted a candidate PSC into the active set earlier.")
                continue
            if "radio quality" in low:
                umts_checks.append("Review serving-versus-neighbor CPICH RSCP/EcNo balance and confirm whether the active set lagged behind the strongest PSC evolution.")
                continue
            umts_checks.append(text)
        analysis["next_checks"] = _dedupe_texts(umts_checks)[:10]

    evidence = analysis.get("evidence") or []
    anomalies = analysis.get("anomalies") or []
    summary_tokens = str(analysis.get("summary") or "").casefold()
    filtered_evidence = []
    for item in evidence:
        text = str(item or "").strip()
        if not text:
            continue
        if "active set update is a umts radio-control procedure" in text.casefold() and "active set" in summary_tokens:
            continue
        filtered_evidence.append(text)
    analysis["evidence"] = _dedupe_texts(filtered_evidence)[:12]

    filtered_anomalies = []
    seen_preferable = False
    for item in anomalies:
        text = str(item or "").strip()
        if not text:
            continue
        low = text.casefold()
        if "appears preferable to serving psc" in low:
            if seen_preferable:
                continue
            seen_preferable = True
        filtered_anomalies.append(text)
    analysis["anomalies"] = _dedupe_texts(filtered_anomalies)[:10]

    return analysis


class LMStudioClient:
    def __init__(self, config: LocalAIConfig, logger=None):
        self.config = config
        self.logger = logger or (lambda *_args, **_kwargs: None)

    def _log(self, message: str, **fields):
        self.logger(message, **fields)

    def _ollama_chat(self, payload: dict, timeout: int | None = None) -> tuple[int, dict, str]:
        """
        Call the native Ollama /api/chat endpoint and return a response body that looks
        exactly like an OpenAI /v1/chat/completions response so the rest of the code
        needs zero changes.  This is the only way to reliably pass think:false to qwen3.
        """
        ollama_payload = {
            "model": payload["model"],
            "stream": False,
            "messages": payload.get("messages", []),
            "think": payload.get("think", False),
        }
        if "options" in payload:
            ollama_payload["options"] = payload["options"]
        if "temperature" in payload:
            ollama_payload.setdefault("options", {})["temperature"] = payload["temperature"]
        if "keep_alive" in payload:
            ollama_payload["keep_alive"] = payload["keep_alive"]
        if "max_tokens" in payload:
            ollama_payload.setdefault("options", {})["num_predict"] = payload["max_tokens"]

        status, headers, text = self._request("POST", self.config.ollama_chat_url, ollama_payload, timeout)
        if status >= 400:
            return status, headers, text

        try:
            native = json.loads(text)
        except Exception:
            return status, headers, text

        msg = native.get("message") or {}
        content = str(msg.get("content") or "").strip()
        thinking = str(msg.get("thinking") or "").strip()
        # If thinking leaked into content (rare), strip it
        if content.startswith("<think>"):
            end = content.find("</think>")
            content = content[end + len("</think>"):].strip() if end >= 0 else content

        openai_shape = {
            "id": native.get("created_at", ""),
            "object": "chat.completion",
            "model": native.get("model", payload["model"]),
            "choices": [{
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": content,
                    "reasoning_content": thinking,
                },
                "finish_reason": "stop" if native.get("done") else "length",
            }],
            "usage": native.get("prompt_eval_count", {}),
        }
        return status, headers, json.dumps(openai_shape)

    def _request(self, method: str, url: str, payload=None, timeout: int | None = None) -> tuple[int, dict, str]:
        body = None
        headers = {"Accept": "application/json"}
        if payload is not None:
            body = json.dumps(payload).encode("utf-8")
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(url, data=body, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=timeout or self.config.timeout_sec) as response:
                data = response.read().decode("utf-8", errors="replace")
                return int(response.status), dict(response.headers.items()), data
        except urllib.error.HTTPError as exc:
            data = exc.read().decode("utf-8", errors="replace")
            return int(exc.code), dict(exc.headers.items() if exc.headers else []), data
        except (urllib.error.URLError, socket.timeout, TimeoutError) as exc:
            raise LMStudioClientError(f"LM Studio request failed: {exc}") from exc

    def list_models(self) -> list[dict]:
        status, _headers, text = self._request("GET", self.config.models_url, timeout=min(self.config.timeout_sec, 20))
        if status >= 400:
            raise LMStudioClientError(f"LM Studio /models returned HTTP {status}: {text[:300]}")
        try:
            parsed = json.loads(text)
        except Exception as exc:
            raise LMStudioClientError(f"LM Studio /models returned invalid JSON: {exc}") from exc
        data = parsed.get("data")
        return data if isinstance(data, list) else []

    def health_check(self) -> dict:
        started = time.perf_counter()
        try:
            models = self.list_models()
            latency_ms = round((time.perf_counter() - started) * 1000, 1)
            return {
                "ok": True,
                "message": f"{'Ollama' if self.config.is_ollama else 'LM Studio'} server is reachable.",
                "backend": self.config.backend,
                "baseUrl": self.config.base_url,
                "modelCount": len(models),
                "latencyMs": latency_ms,
            }
        except Exception as exc:
            latency_ms = round((time.perf_counter() - started) * 1000, 1)
            return {
                "ok": False,
                "message": str(exc),
                "backend": self.config.backend,
                "baseUrl": self.config.base_url,
                "modelCount": 0,
                "latencyMs": latency_ms,
            }

    def model_check(self) -> dict:
        try:
            models = self.list_models()
        except Exception as exc:
            return {
                "ok": False,
                "available": [],
                "configuredModel": self.config.model,
                "message": str(exc),
            }
        available = []
        for item in models:
            if not isinstance(item, dict):
                continue
            model_id = str(item.get("id") or "").strip()
            if model_id:
                available.append(model_id)
        ok = self.config.model in available
        return {
            "ok": ok,
            "available": available,
            "configuredModel": self.config.model,
            "message": "Configured model is available." if ok else f"Configured model is not loaded in {'Ollama' if self.config.is_ollama else 'LM Studio'}.",
        }

    def analyze_chunk(self, chunk: dict, request_id: str) -> dict:
        metadata = chunk.get("metadata") if isinstance(chunk.get("metadata"), dict) else {}
        engineered = engineer_issue_context(str(chunk.get("content") or ""))
        user_prompt = (
            "Chunk metadata:\n"
            + json.dumps(
                {
                    "chunk_id": chunk.get("id"),
                    "line_range": chunk.get("lineRange"),
                    "suspected_rat": metadata.get("suspectedRat"),
                    "start_timestamp": metadata.get("startTimestamp"),
                    "end_timestamp": metadata.get("endTimestamp"),
                    "identifiers": metadata.get("identifiers"),
                },
                ensure_ascii=False,
            )
            + "\n\nDeterministic engineered context:\n"
            + json.dumps(
                {
                    "is_issue_bundle": engineered.get("is_issue_bundle"),
                    "issue_type": engineered.get("issue_type"),
                    "rat_guess": engineered.get("rat_guess"),
                    "metric_family": engineered.get("metric_family"),
                    "trigger_event": engineered.get("trigger_event"),
                    "dominant_failure_domain": engineered.get("dominant_failure_domain"),
                    "domain_scores": engineered.get("domain_scores"),
                    "evidence": engineered.get("evidence"),
                    "limitations": engineered.get("limitations"),
                    "confidence_ceiling": engineered.get("confidence_ceiling"),
                    "confidence_rationale": engineered.get("confidence_rationale"),
                    "key_events": engineered.get("key_events"),
                    "summary_hint": engineered.get("summary_hint"),
                    "root_cause_hint": engineered.get("root_cause_hint"),
                    "style_hints": engineered.get("style_hints"),
                },
                ensure_ascii=False,
            )
            + "\n\nLog chunk:\n"
            + str(chunk.get("content") or "")
        )
        base_payload = {
            "model": self.config.model,
            "temperature": 0.1,
            "messages": [
                {"role": "system", "content": TELECOM_SYSTEM_PROMPT},
                {"role": "user", "content": user_prompt},
            ],
        }
        use_native = self.config.is_ollama and "qwen3" in self.config.model.lower()
        if self.config.is_ollama:
            base_payload["keep_alive"] = -1
            base_payload["options"] = {"num_ctx": 8192}
            if use_native:
                base_payload["think"] = False  # honoured by /api/chat; ignored here for clarity
        # Ollama on Apple Silicon: ~5-10 tok/s → 300 s for up to ~2000 output tokens
        chunk_timeout = 300 if self.config.is_ollama else self.config.timeout_sec
        last_error = None
        # Native Ollama endpoint doesn't use response_format; only one variant needed
        payload_variants = (
            [base_payload]
            if use_native
            else [
                {**base_payload, "response_format": {"type": "json_object"}},
                base_payload,
            ]
        )
        started = time.perf_counter()
        for attempt in range(self.config.max_retries + 1):
            for payload in payload_variants:
                try:
                    if use_native:
                        status, _headers, text = self._ollama_chat(payload, timeout=chunk_timeout)
                    else:
                        status, _headers, text = self._request("POST", self.config.chat_completions_url, payload=payload)
                except LMStudioClientError as exc:
                    last_error = str(exc)
                    if attempt >= self.config.max_retries:
                        break
                    time.sleep(min(1.5 * (attempt + 1), 3.0))
                    continue
                if status in {408, 429, 500, 502, 503, 504}:
                    last_error = f"LM Studio returned HTTP {status}: {text[:240]}"
                    if attempt >= self.config.max_retries:
                        continue
                    time.sleep(min(1.5 * (attempt + 1), 3.0))
                    continue
                if status >= 400:
                    last_error = f"LM Studio returned HTTP {status}: {text[:300]}"
                    if payload.get("response_format"):
                        continue
                    raise LMStudioClientError(last_error)
                try:
                    parsed = json.loads(text)
                except Exception as exc:
                    raise LMStudioClientError(f"LM Studio returned invalid HTTP JSON envelope: {exc}") from exc
                choices = parsed.get("choices") if isinstance(parsed, dict) else None
                message = choices[0].get("message") if isinstance(choices, list) and choices else {}
                raw_output = str((message or {}).get("content") or "").strip()
                if not raw_output:
                    last_error = "LM Studio returned an empty completion."
                    continue
                analysis, recovered = coerce_analysis_payload(raw_output)
                analysis = _apply_engineering_guardrails(analysis, engineered)
                return {
                    "analysis": analysis,
                    "radio_series": engineered.get("radio_series"),
                    "neighbor_series": engineered.get("neighbor_series"),
                    "signal_series": engineered.get("signal_series"),
                    "rawOutputPreview": raw_output[:500],
                    "jsonRecovered": recovered,
                    "latencyMs": round((time.perf_counter() - started) * 1000, 1),
                    "model": self.config.model,
                    "requestId": request_id,
                }
        raise LMStudioClientError(last_error or "LM Studio chunk analysis failed.")

"""
Minimal HTTP server for Optim Analyzer (no external frameworks).

Routes consumed by the frontend:
- POST /api/trp/import            multipart/form-data file=...
- POST /api/nmfs/decode           multipart/form-data file=... (external converter bridge)
- GET  /api/nmfs/config           effective converter configuration
- POST /api/nmfs/config           save converter configuration
- POST /api/nmfs/config/test      validate converter command
- GET  /api/runs                  list runs
- GET  /api/runs/<id>             run + track + events
- GET  /api/runs/<id>/catalog     signal catalog (names)
- GET  /api/runs/<id>/sidebar     sidebar groups
- GET  /api/runs/<id>/signals     signal catalog (same as catalog.signals)
- GET  /api/runs/<id>/timeseries?signal=<name>&max_points=<int>
- GET  /api/runs/<id>/track
- GET  /api/runs/<id>/events
- GET  /api/runs/<id>/neighbors_at_time?time=<ISO>&tolMs=200&bucketMs=80
- GET  /api/runs/<id>/l1l2/capabilities
- GET  /api/runs/<id>/l1l2/at_time?time=<ISO>&windowMs=2000
"""

from __future__ import annotations

import json
import os
import hashlib
import shlex
import shutil
import subprocess
import sys
import tempfile
import traceback
from http.server import HTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

from trp_importer import (
    import_trp_file,
    list_runs,
    fetch_run_detail,
    fetch_kpi_series,
    fetch_neighbors_at_time,
    fetch_l1l2_scheduler_capabilities,
    fetch_l1l2_scheduler_at_time,
    fetch_run_catalog,
    fetch_run_sidebar,
    fetch_run_signals,
    fetch_timeseries_by_signal,
    fetch_run_track,
    fetch_run_events,
)
from lte_rrc_per_decoder import (
    decode_measurement_report_payload,
    decode_rrc_event_payload,
    decode_rrc_reconfiguration_payload,
)

UPLOAD_DIR = os.environ.get("OPTIM_UPLOAD_DIR", "/tmp/optim_uploads")
DB_PATH = None  # kept for backward compatibility; in-memory store ignores it
NMFS_CONFIG_PATH = os.environ.get("OPTIM_NMFS_CONFIG_PATH", os.path.join(UPLOAD_DIR, "nmfs_converter_config.json"))
HO_ANALYSIS_STORE = {}
HO_ANALYSIS_SEQ = 0
LTE_RRC_PRECOMPUTE_STORE = {}
LTE_RRC_PRECOMPUTE_DIR = os.path.join(UPLOAD_DIR, "lte_rrc_precompute_cache")


def _json(handler: SimpleHTTPRequestHandler, obj, status: int = 200):
    body = json.dumps(obj).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Cache-Control", "no-store")
    handler.end_headers()
    handler.wfile.write(body)


def _read_body(handler: SimpleHTTPRequestHandler) -> bytes:
    clen = handler.headers.get("Content-Length")
    if not clen:
        return b""
    try:
        n = int(clen)
    except Exception:
        n = 0
    if n <= 0:
        return b""
    return handler.rfile.read(n)


def _parse_multipart_file(body: bytes, content_type: str) -> tuple[str, bytes]:
    """
    Extremely small multipart/form-data parser.
    Assumes a single file part with a filename.
    """
    # content-type: multipart/form-data; boundary=----WebKitFormBoundary...
    m = None
    for part in content_type.split(";"):
        part = part.strip()
        if part.startswith("boundary="):
            m = part.split("=", 1)[1]
            break
    if not m:
        raise ValueError("Missing multipart boundary")

    boundary = ("--" + m).encode("utf-8")
    sections = body.split(boundary)
    for sec in sections:
        sec = sec.strip()
        if not sec or sec == b"--":
            continue
        # headers/body split
        if b"\r\n\r\n" not in sec:
            continue
        head, data = sec.split(b"\r\n\r\n", 1)
        head_txt = head.decode("utf-8", errors="replace")
        if "filename=" not in head_txt:
            continue
        # filename
        fnm = ""
        for line in head_txt.split("\r\n"):
            if line.lower().startswith("content-disposition:"):
                # Content-Disposition: form-data; name="file"; filename="x.trp"
                mm = line.split("filename=", 1)[1].strip()
                if mm.startswith('"') and '"' in mm[1:]:
                    fnm = mm.split('"', 2)[1]
                else:
                    fnm = mm.split(";", 1)[0].strip()
        # strip last CRLF and possible trailing --
        if data.endswith(b"\r\n"):
            data = data[:-2]
        if data.endswith(b"--"):
            data = data[:-2]
        return fnm or "upload.trp", data

    raise ValueError("No file part found")


def _parse_json_body(handler: SimpleHTTPRequestHandler) -> dict:
    raw = _read_body(handler)
    if not raw:
        return {}
    try:
        data = json.loads(raw.decode("utf-8", errors="replace"))
        if isinstance(data, dict):
            return data
    except Exception:
        pass
    return {}


def _read_nmfs_config_file() -> dict:
    try:
        if not os.path.isfile(NMFS_CONFIG_PATH):
            return {}
        with open(NMFS_CONFIG_PATH, "r", encoding="utf-8", errors="replace") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _to_num_if_finite(value):
    if value in (None, "", "N/A", "n/a", "-"):
        return None
    try:
        number = float(value)
    except Exception:
        return None
    if number != number or number in (float("inf"), float("-inf")):
        return None
    return number


def _to_int(value):
    number = _to_num_if_finite(value)
    return int(round(number)) if number is not None else None


def _sanitize_lte_earfcn(value):
    number = _to_int(value)
    return number if number is not None and number >= 0 else None


def _parse_event_ts_ms(value):
    if value in (None, "", "N/A", "n/a", "-"):
        return None
    number = _to_num_if_finite(value)
    if number is not None:
        return int(round(number))
    text = str(value).strip()
    try:
        from datetime import datetime
        return int(datetime.fromisoformat(text.replace("Z", "+00:00")).timestamp() * 1000)
    except Exception:
        pass
    import re
    match = re.match(r"^(\d{1,2}):(\d{2}):(\d{2})(?:[.,](\d{1,3}))?$", text)
    if not match:
        return None
    hh = int(match.group(1))
    mm = int(match.group(2))
    ss = int(match.group(3))
    ms = int((match.group(4) or "0").ljust(3, "0")[:3])
    return (((hh * 60 + mm) * 60 + ss) * 1000) + ms


def _format_ms_of_day(value):
    ts = _parse_event_ts_ms(value)
    if ts is None:
        return "N/A"
    ms_of_day = ((ts % 86400000) + 86400000) % 86400000
    hh = str(ms_of_day // 3600000).zfill(2)
    mm = str((ms_of_day % 3600000) // 60000).zfill(2)
    ss = str((ms_of_day % 60000) // 1000).zfill(2)
    ms = str(ms_of_day % 1000).zfill(3)
    return f"{hh}:{mm}:{ss}.{ms}"


def _render_a3_resolver_summary(resolver):
    if not isinstance(resolver, dict):
        return ""
    rows = resolver.get("a3Resolvers")
    if not isinstance(rows, list) or not rows:
        return ""
    rendered = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        report_cfg = row.get("reportConfig") if isinstance(row.get("reportConfig"), dict) else {}
        meas_object = row.get("measObject") if isinstance(row.get("measObject"), dict) else {}
        cell = None
        if isinstance(meas_object.get("cells"), list) and meas_object["cells"]:
            first = meas_object["cells"][0]
            if isinstance(first, dict):
                cell = first
        bits = []
        meas_id = _to_int(row.get("measId"))
        report_config_id = _to_int(row.get("reportConfigId"))
        meas_object_id = _to_int(row.get("measObjectId"))
        carrier_freq = _to_int(meas_object.get("carrierFreq"))
        a3_offset = _to_num_if_finite(report_cfg.get("a3OffsetDb"))
        hysteresis = _to_num_if_finite(report_cfg.get("hysteresisDb"))
        ttt_ms = _to_int(report_cfg.get("timeToTriggerMs"))
        offset_freq = _to_num_if_finite(meas_object.get("offsetFreqDb"))
        if meas_id is not None:
            bits.append(f"measId {meas_id}")
        if report_config_id is not None:
            bits.append(f"reportConfig {report_config_id}")
        if meas_object_id is not None:
            bits.append(f"measObject {meas_object_id}")
        if carrier_freq is not None:
            bits.append(f"EARFCN {carrier_freq}")
        if a3_offset is not None:
            bits.append(f"A3 offset {a3_offset} dB")
        if hysteresis is not None:
            bits.append(f"Hys {hysteresis} dB")
        if ttt_ms is not None:
            bits.append(f"TTT {ttt_ms} ms")
        if offset_freq is not None:
            bits.append(f"offsetFreq {offset_freq} dB")
        if isinstance(cell, dict):
            pci = _to_int(cell.get("physCellId"))
            cio = _to_num_if_finite(cell.get("cellIndividualOffsetDb"))
            if pci is not None:
                bits.append(f"PCI {pci} CIO {cio if cio is not None else 0} dB")
        if bits:
            rendered.append(" | ".join(bits))
    return " || ".join(rendered)


def _resolve_exact_a3_for_measurement_report(mr_row, recfg_rows):
    if not isinstance(mr_row, dict):
        return None
    decoded_mr = mr_row.get("decoded")
    if not isinstance(decoded_mr, dict):
        return None
    summary = decoded_mr.get("summary") if isinstance(decoded_mr.get("summary"), dict) else {}
    meas_id = _to_int(summary.get("measId"))
    if meas_id is None:
        return None
    mr_ts = _parse_event_ts_ms(mr_row.get("ts"))
    matching_recfg = None
    best_rank = None
    for row in recfg_rows or []:
        if not isinstance(row, dict):
            continue
        resolver = row.get("resolver") if isinstance(row.get("resolver"), dict) else {}
        a3_rows = resolver.get("a3Resolvers") if isinstance(resolver.get("a3Resolvers"), list) else []
        if not any(_to_int(item.get("measId")) == meas_id for item in a3_rows if isinstance(item, dict)):
            continue
        row_ts = _parse_event_ts_ms(row.get("ts"))
        if mr_ts is not None and row_ts is not None:
            rank = (0 if row_ts <= mr_ts else 1, abs(mr_ts - row_ts))
        elif row_ts is not None:
            rank = (0, row_ts)
        else:
            rank = (2, 10**15)
        if best_rank is None or rank < best_rank:
            best_rank = rank
            matching_recfg = row
    if not matching_recfg:
        return None
    resolver = matching_recfg.get("resolver") if isinstance(matching_recfg.get("resolver"), dict) else {}
    a3_resolver = next(
        (item for item in resolver.get("a3Resolvers", []) if isinstance(item, dict) and _to_int(item.get("measId")) == meas_id),
        None
    )
    if not isinstance(a3_resolver, dict):
        return None
    report_cfg = a3_resolver.get("reportConfig") if isinstance(a3_resolver.get("reportConfig"), dict) else {}
    meas_object = a3_resolver.get("measObject") if isinstance(a3_resolver.get("measObject"), dict) else {}
    trigger_quantity = str(report_cfg.get("triggerQuantity") or "RSRP").upper()
    measurement_key = "rsrq_db" if trigger_quantity == "RSRQ" else "rsrp_dbm"
    serving = decoded_mr.get("serving") if isinstance(decoded_mr.get("serving"), dict) else {}
    neighbor_rows = decoded_mr.get("neighbors_lte") if isinstance(decoded_mr.get("neighbors_lte"), list) else []
    source_pci = _to_int(mr_row.get("servingPci"))
    source_earfcn = _sanitize_lte_earfcn(mr_row.get("servingEarfcn"))
    Ms = _to_num_if_finite(serving.get(measurement_key))
    Ofn = _to_num_if_finite(meas_object.get("offsetFreqDb"))
    inferred_serving_freq = _sanitize_lte_earfcn(meas_object.get("carrierFreq"))
    same_freq_assumption = True if source_earfcn is None or inferred_serving_freq is None else source_earfcn == inferred_serving_freq
    Ofs = Ofn if same_freq_assumption else 0
    cells = meas_object.get("cells") if isinstance(meas_object.get("cells"), list) else []
    serving_cfg = next((cell for cell in cells if isinstance(cell, dict) and _to_int(cell.get("physCellId")) == source_pci), None)
    Ocs = _to_num_if_finite(serving_cfg.get("cellIndividualOffsetDb")) if isinstance(serving_cfg, dict) else None
    Off = _to_num_if_finite(report_cfg.get("a3OffsetDb"))
    Hys = _to_num_if_finite(report_cfg.get("hysteresisDb"))
    assumptions = []
    if Ofn is None:
        assumptions.append("Neighbor offsetFreq not configured; assumed 0 dB.")
    if Ofs is None:
        assumptions.append("Serving offsetFreq unavailable; assumed 0 dB.")
    elif same_freq_assumption and source_earfcn is not None and inferred_serving_freq is not None and source_earfcn == inferred_serving_freq:
        assumptions.append("Serving offsetFreq assumed same as target measObject (same-frequency).")
    if Ocs is None:
        assumptions.append("Serving CIO not configured in measObject; assumed 0 dB.")
    if Off is None:
        assumptions.append("A3 offset unavailable in reportConfig.")
    if Hys is None:
        assumptions.append("A3 hysteresis unavailable in reportConfig.")
    if Ms is None:
        assumptions.append(f"Serving {trigger_quantity} unavailable in MeasurementReport.")
    evaluated_neighbors = []
    for row in neighbor_rows:
        if not isinstance(row, dict):
            continue
        pci = _to_int(row.get("pci"))
        Mn = _to_num_if_finite(row.get(measurement_key))
        cell_cfg = next((cell for cell in cells if isinstance(cell, dict) and _to_int(cell.get("physCellId")) == pci), None)
        Ocn = _to_num_if_finite(cell_cfg.get("cellIndividualOffsetDb")) if isinstance(cell_cfg, dict) else None
        lhs_enter = None if Mn is None else Mn + (Ofn if Ofn is not None else 0) + (Ocn if Ocn is not None else 0) - (Hys if Hys is not None else 0)
        rhs = None if Ms is None else Ms + (Ofs if Ofs is not None else 0) + (Ocs if Ocs is not None else 0) + (Off if Off is not None else 0)
        lhs_leave = None if Mn is None else Mn + (Ofn if Ofn is not None else 0) + (Ocn if Ocn is not None else 0) + (Hys if Hys is not None else 0)
        evaluated_neighbors.append({
            "pci": pci,
            "Mn": Mn,
            "Ocn": Ocn if Ocn is not None else 0,
            "lhsEnter": lhs_enter,
            "rhs": rhs,
            "lhsLeave": lhs_leave,
            "enterSatisfied": (lhs_enter > rhs) if lhs_enter is not None and rhs is not None else None,
            "leaveSatisfied": (lhs_leave < rhs) if lhs_leave is not None and rhs is not None else None,
            "deltaVsThreshold": (lhs_enter - rhs) if lhs_enter is not None and rhs is not None else None,
        })
    evaluated_neighbors.sort(key=lambda item: item.get("deltaVsThreshold") if item.get("deltaVsThreshold") is not None else float("-inf"), reverse=True)
    best = evaluated_neighbors[0] if evaluated_neighbors else None
    summary_bits = [f"measId {meas_id}"]
    report_config_id = _to_int(a3_resolver.get("reportConfigId"))
    meas_object_id = _to_int(a3_resolver.get("measObjectId"))
    if report_config_id is not None:
        summary_bits.append(f"reportConfig {report_config_id}")
    if meas_object_id is not None:
        summary_bits.append(f"measObject {meas_object_id}")
    if inferred_serving_freq is not None:
        summary_bits.append(f"EARFCN {inferred_serving_freq}")
    if Off is not None:
        summary_bits.append(f"Off {Off:.1f} dB")
    if Hys is not None:
        summary_bits.append(f"Hys {Hys:.1f} dB")
    ttt_ms = _to_int(report_cfg.get("timeToTriggerMs"))
    if ttt_ms is not None:
        summary_bits.append(f"TTT {ttt_ms} ms")
    unit = "dB" if trigger_quantity == "RSRQ" else "dBm"
    evaluation_summary = (
        f"PCI {best.get('pci') if best and best.get('pci') is not None else '?'}: "
        f"LHSenter {best.get('lhsEnter'):.1f} {unit} vs RHS {best.get('rhs'):.1f} {unit} => "
        f"enter {'true' if best.get('enterSatisfied') else 'false'}"
    ) if best and best.get("lhsEnter") is not None and best.get("rhs") is not None else "No LTE neighbors available for A3 evaluation."
    source_pci_from_recfg = _to_int((matching_recfg.get("properties") or {}).get("HO target PCI") or (matching_recfg.get("properties") or {}).get("rrc_recfg_tgt_pci"))
    return {
        "measId": meas_id,
        "triggerQuantity": trigger_quantity,
        "sourceTimeMs": _parse_event_ts_ms(matching_recfg.get("ts")),
        "sourceTimeLabel": _format_ms_of_day(matching_recfg.get("ts")),
        "sourcePci": source_pci_from_recfg,
        "reportConfigId": report_config_id,
        "measObjectId": meas_object_id,
        "carrierFreq": inferred_serving_freq,
        "servingPci": source_pci,
        "servingEarfcn": source_earfcn,
        "servingMetric": Ms,
        "neighborOffsetFreqDb": Ofn if Ofn is not None else 0,
        "servingOffsetFreqDb": Ofs if Ofs is not None else 0,
        "servingCioDb": Ocs if Ocs is not None else 0,
        "a3OffsetDb": Off,
        "hysteresisDb": Hys,
        "timeToTriggerMs": ttt_ms,
        "mappingSummary": " | ".join(summary_bits),
        "evaluationSummary": evaluation_summary,
        "assumptions": assumptions,
        "bestNeighbor": best,
        "neighbors": evaluated_neighbors,
    }


def _lte_rrc_precompute_cache_path(cache_key: str) -> str:
    safe_key = "".join(ch for ch in str(cache_key or "").strip() if ch.isalnum() or ch in ("-", "_"))
    return os.path.join(LTE_RRC_PRECOMPUTE_DIR, f"{safe_key}.json")


def _load_lte_rrc_precompute(cache_key: str):
    if not cache_key:
        return None
    if cache_key in LTE_RRC_PRECOMPUTE_STORE:
        return LTE_RRC_PRECOMPUTE_STORE[cache_key]
    path = _lte_rrc_precompute_cache_path(cache_key)
    if not os.path.exists(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
        LTE_RRC_PRECOMPUTE_STORE[cache_key] = payload
        return payload
    except Exception:
        return None


def _store_lte_rrc_precompute(cache_key: str, payload):
    if not cache_key:
        return
    LTE_RRC_PRECOMPUTE_STORE[cache_key] = payload
    try:
        os.makedirs(LTE_RRC_PRECOMPUTE_DIR, exist_ok=True)
        with open(_lte_rrc_precompute_cache_path(cache_key), "w", encoding="utf-8") as handle:
            json.dump(payload, handle)
    except Exception:
        pass


def _write_nmfs_config_file(data: dict):
    cfg = data if isinstance(data, dict) else {}
    os.makedirs(os.path.dirname(NMFS_CONFIG_PATH), exist_ok=True)
    with open(NMFS_CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2, ensure_ascii=False)


def _get_nmfs_effective_config() -> dict:
    file_cfg = _read_nmfs_config_file()
    cmd = os.environ.get("OPTIM_NMFS_CONVERTER_CMD", "").strip() or str(file_cfg.get("converterCmd") or "").strip()
    timeout_env = os.environ.get("OPTIM_NMFS_TIMEOUT_SEC", "").strip()
    keep_env = os.environ.get("OPTIM_NMFS_KEEP_TEMP", "").strip().lower()
    timeout_file = file_cfg.get("timeoutSec")
    keep_file = file_cfg.get("keepTemp")

    try:
        timeout_sec = int(timeout_env) if timeout_env else int(timeout_file if timeout_file is not None else 180)
    except Exception:
        timeout_sec = 180
    timeout_sec = max(10, timeout_sec)

    if keep_env in {"1", "true", "yes"}:
        keep_temp = True
    elif keep_env in {"0", "false", "no"}:
        keep_temp = False
    else:
        keep_temp = bool(keep_file) if keep_file is not None else False

    return {
        "converterCmd": cmd,
        "timeoutSec": timeout_sec,
        "keepTemp": keep_temp,
        "source": {
            "converterCmd": "env" if bool(os.environ.get("OPTIM_NMFS_CONVERTER_CMD", "").strip()) else ("file" if bool(file_cfg.get("converterCmd")) else "default"),
            "timeoutSec": "env" if bool(timeout_env) else ("file" if timeout_file is not None else "default"),
            "keepTemp": "env" if bool(keep_env) else ("file" if keep_file is not None else "default"),
        },
    }


def _validate_nmfs_converter_cfg(cfg: dict) -> dict:
    cmd_tpl = str((cfg or {}).get("converterCmd") or "").strip()
    timeout_sec = int((cfg or {}).get("timeoutSec") or 180)
    keep_temp = bool((cfg or {}).get("keepTemp"))
    issues = []
    warnings = []
    first_bin = None
    executable_found = False

    if not cmd_tpl:
        issues.append("converterCmd is empty.")
    if "{input}" not in cmd_tpl:
        issues.append("converterCmd must include {input} placeholder.")
    if "{output}" not in cmd_tpl:
        warnings.append("converterCmd does not include {output}; converter output discovery will rely on stdout/scan.")

    args = shlex.split(cmd_tpl) if cmd_tpl else []
    if not args:
        issues.append("converterCmd resolves to empty command.")
    else:
        first_bin = args[0]
        if os.path.isabs(first_bin):
            executable_found = os.path.exists(first_bin)
        else:
            executable_found = shutil.which(first_bin) is not None
        if not executable_found:
            warnings.append(f"Command binary not found in PATH: {first_bin}")

    return {
        "ok": len(issues) == 0,
        "issues": issues,
        "warnings": warnings,
        "converterCmd": cmd_tpl,
        "timeoutSec": max(10, timeout_sec),
        "keepTemp": keep_temp,
        "resolvedBinary": first_bin,
        "binaryFound": executable_found,
    }


def _run_nmfs_converter(input_path: str) -> dict:
    """
    Run external NMFS converter command configured by env var:
      OPTIM_NMFS_CONVERTER_CMD
    The command can use placeholders:
      {input}  -> absolute input .nmfs path
      {output} -> suggested output text path (.nmf)
    Example:
      wine /path/AnalyzeParser.exe -i "{input}" -o "{output}"
    """
    eff = _get_nmfs_effective_config()
    cmd_tpl = str(eff.get("converterCmd") or "").strip()
    if not cmd_tpl:
        raise RuntimeError(
            "NMFS converter is not configured. Set OPTIM_NMFS_CONVERTER_CMD "
            "with placeholders {input} and {output}."
        )

    try:
        timeout_sec = max(10, int(eff.get("timeoutSec") or 180))
    except Exception:
        timeout_sec = 180

    keep_temp = bool(eff.get("keepTemp"))
    tmp_dir = tempfile.mkdtemp(prefix="optim_nmfs_")
    out_name = os.path.basename(input_path) + ".nmf"
    output_path = os.path.join(tmp_dir, out_name)

    cmd_text = cmd_tpl.format(input=input_path, output=output_path)
    # Use Windows-compatible argument splitting when server runs on Windows.
    cmd_args = shlex.split(cmd_text, posix=(os.name != "nt"))
    if not cmd_args:
        raise RuntimeError("OPTIM_NMFS_CONVERTER_CMD resolved to an empty command.")

    proc = subprocess.run(
        cmd_args,
        capture_output=True,
        text=True,
        timeout=timeout_sec
    )

    decoded_text = ""
    chosen_output_path = None
    if os.path.isfile(output_path):
        try:
            with open(output_path, "r", encoding="utf-8", errors="replace") as f:
                decoded_text = f.read()
            chosen_output_path = output_path
        except Exception:
            decoded_text = ""

    # If converter ignored {output}, try to discover generated text files.
    if not decoded_text:
        candidates = []
        for root, _dirs, files in os.walk(tmp_dir):
            for fn in files:
                p = os.path.join(root, fn)
                ext = os.path.splitext(fn)[1].lower()
                if ext not in {".nmf", ".txt", ".csv", ".log"}:
                    continue
                try:
                    sz = os.path.getsize(p)
                except Exception:
                    continue
                if sz <= 0:
                    continue
                candidates.append((sz, p))
        if candidates:
            candidates.sort(reverse=True)
            chosen_output_path = candidates[0][1]
            try:
                with open(chosen_output_path, "r", encoding="utf-8", errors="replace") as f:
                    decoded_text = f.read()
            except Exception:
                decoded_text = ""

    # Last resort: some converters print plain text to stdout.
    if not decoded_text and (proc.stdout or "").strip():
        decoded_text = proc.stdout

    result = {
        "command": cmd_text,
        "returncode": int(proc.returncode),
        "stdout": proc.stdout[-4000:] if proc.stdout else "",
        "stderr": proc.stderr[-4000:] if proc.stderr else "",
        "output_path": chosen_output_path,
        "text_len": len(decoded_text),
        "temp_dir": tmp_dir if keep_temp else None,
    }

    if not keep_temp:
        try:
            shutil.rmtree(tmp_dir, ignore_errors=True)
        except Exception:
            pass

    if not decoded_text.strip():
        raise RuntimeError(
            "NMFS converter produced no decodable text output. "
            f"returncode={proc.returncode}. stderr={result['stderr'][:500]}"
        )

    result["text"] = decoded_text
    return result


def _run_ho_analysis(payload: dict) -> dict:
    cli_path = os.path.join(os.path.dirname(__file__), "ho_analysis_cli.js")
    if not os.path.isfile(cli_path):
        raise RuntimeError("ho_analysis_cli.js is missing")
    proc = subprocess.run(
        ["node", cli_path],
        input=json.dumps(payload).encode("utf-8"),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    stdout = (proc.stdout or b"").decode("utf-8", errors="replace")
    stderr = (proc.stderr or b"").decode("utf-8", errors="replace")
    if proc.returncode != 0:
        raise RuntimeError(f"HO analysis failed: {stderr or stdout or proc.returncode}")
    try:
        parsed = json.loads(stdout)
    except Exception as exc:
        raise RuntimeError(f"Invalid HO analysis response: {exc}") from exc
    if not parsed.get("ok"):
        raise RuntimeError(parsed.get("error") or "HO analysis failed")
    return parsed["result"]


def _store_ho_analysis(result: dict, source: dict | None = None) -> str:
    global HO_ANALYSIS_SEQ
    HO_ANALYSIS_SEQ += 1
    analysis_id = f"ho-analysis-{HO_ANALYSIS_SEQ:05d}"
    HO_ANALYSIS_STORE[analysis_id] = {
        "id": analysis_id,
        "createdAt": result.get("generatedAt"),
        "result": result,
        "source": source or {},
    }
    return analysis_id


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, format, *args):
        # quieter logs
        sys.stderr.write("%s - - [%s] %s\n" % (self.address_string(), self.log_date_time_string(), format % args))

    def end_headers(self):
        # Allow frontend and backend on different origins/ports.
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path

        try:
            # API routes
            if path == "/api/nmfs/config":
                cfg = _get_nmfs_effective_config()
                _json(self, {"status": "success", "config": cfg, "configPath": NMFS_CONFIG_PATH})
                return

            if path.startswith("/api/ho-analysis/"):
                parts = path.strip("/").split("/")
                if len(parts) < 3:
                    _json(self, {"status": "error", "message": "Bad request"}, 400)
                    return
                analysis_id = parts[2]
                record = HO_ANALYSIS_STORE.get(analysis_id)
                if not record:
                    _json(self, {"status": "error", "message": "HO analysis not found"}, 404)
                    return
                result = record["result"]
                if len(parts) == 4 and parts[3] == "events":
                    qs = parse_qs(parsed.query or "")
                    page = max(1, int((qs.get("page") or ["1"])[0]))
                    page_size = max(1, min(500, int((qs.get("pageSize") or ["100"])[0])))
                    events = list(result.get("events") or [])
                    start = (page - 1) * page_size
                    end = start + page_size
                    _json(self, {
                        "status": "success",
                        "analysisId": analysis_id,
                        "page": page,
                        "pageSize": page_size,
                        "total": len(events),
                        "events": events[start:end],
                    })
                    return
                if len(parts) == 5 and parts[3] == "events":
                    event_id = parts[4]
                    event = next((ev for ev in result.get("events") or [] if str(ev.get("id")) == event_id), None)
                    if not event:
                        _json(self, {"status": "error", "message": "HO event not found"}, 404)
                        return
                    _json(self, {"status": "success", "analysisId": analysis_id, "event": event})
                    return
                if len(parts) == 4 and parts[3] == "kpis":
                    _json(self, {"status": "success", "analysisId": analysis_id, "kpis": result.get("kpis")})
                    return
                if len(parts) == 4 and parts[3] == "export":
                    _json(self, {"status": "success", "analysisId": analysis_id, "result": result})
                    return
                _json(self, {
                    "status": "success",
                    "analysisId": analysis_id,
                    "summary": result.get("kpis", {}).get("summary"),
                    "normalization": result.get("normalization"),
                    "debug": result.get("debug"),
                })
                return

            if path == "/api/runs":
                _json(self, {"status": "success", "runs": list_runs(DB_PATH)})
                return

            if path.startswith("/api/runs/"):
                parts = path.strip("/").split("/")  # ["api","runs","<id>", ...]
                if len(parts) < 3:
                    _json(self, {"status": "error", "message": "Bad request"}, 400)
                    return

                run_id = parts[2]

                # Sub-routes
                if len(parts) == 4 and parts[3] == "catalog":
                    _json(self, fetch_run_catalog(DB_PATH, run_id))
                    return
                if len(parts) == 4 and parts[3] == "sidebar":
                    _json(self, fetch_run_sidebar(DB_PATH, run_id))
                    return
                if len(parts) == 4 and parts[3] == "signals":
                    _json(self, fetch_run_signals(DB_PATH, run_id))
                    return
                if len(parts) == 4 and parts[3] == "track":
                    _json(self, fetch_run_track(DB_PATH, run_id))
                    return
                if len(parts) == 4 and parts[3] == "events":
                    _json(self, fetch_run_events(DB_PATH, run_id))
                    return
                if len(parts) == 4 and parts[3] == "kpi":
                    qs = parse_qs(parsed.query or "")
                    name = (qs.get("name") or [""])[0]
                    max_points = (qs.get("max_points") or ["50000"])[0]
                    idx_raw = (qs.get("idx") or [None])[0]
                    try:
                        max_points_i = int(max_points)
                    except Exception:
                        max_points_i = 50000
                    try:
                        idx_i = int(idx_raw) if idx_raw not in (None, "") else None
                    except Exception:
                        idx_i = None
                    _json(self, fetch_kpi_series(DB_PATH, run_id, name, max_points=max_points_i, idx=idx_i))
                    return
                if len(parts) == 4 and parts[3] == "neighbors_at_time":
                    qs = parse_qs(parsed.query or "")
                    time_iso = (qs.get("time") or [""])[0]
                    tol_ms = (qs.get("tolMs") or ["200"])[0]
                    bucket_ms = (qs.get("bucketMs") or ["80"])[0]
                    try:
                        tol_ms_i = int(tol_ms)
                    except Exception:
                        tol_ms_i = 200
                    try:
                        bucket_ms_i = int(bucket_ms)
                    except Exception:
                        bucket_ms_i = 80
                    _json(self, fetch_neighbors_at_time(DB_PATH, run_id, time_iso, tol_ms=tol_ms_i, bucket_ms=bucket_ms_i))
                    return
                if len(parts) == 5 and parts[3] == "l1l2" and parts[4] == "capabilities":
                    _json(self, fetch_l1l2_scheduler_capabilities(DB_PATH, run_id))
                    return
                if len(parts) == 5 and parts[3] == "l1l2" and parts[4] == "at_time":
                    qs = parse_qs(parsed.query or "")
                    time_iso = (qs.get("time") or [""])[0]
                    window_ms = (qs.get("windowMs") or ["2000"])[0]
                    try:
                        window_ms_i = int(window_ms)
                    except Exception:
                        window_ms_i = 2000
                    _json(self, fetch_l1l2_scheduler_at_time(DB_PATH, run_id, time_iso, window_ms=window_ms_i))
                    return
                if len(parts) == 4 and parts[3] == "timeseries":
                    qs = parse_qs(parsed.query or "")
                    signal = (qs.get("signal") or [""])[0]
                    max_points = (qs.get("max_points") or ["50000"])[0]
                    idx_raw = (qs.get("idx") or [None])[0]
                    try:
                        max_points_i = int(max_points)
                    except Exception:
                        max_points_i = 50000
                    try:
                        idx_i = int(idx_raw) if idx_raw not in (None, "") else None
                    except Exception:
                        idx_i = None
                    _json(self, fetch_timeseries_by_signal(DB_PATH, run_id, signal, max_points=max_points_i, idx=idx_i))
                    return

                # Default: run detail
                if len(parts) == 3:
                    run, track, events = fetch_run_detail(DB_PATH, run_id)
                    _json(self, {"status": "success", "run": run, "track_points": track, "events": events})
                    return

                _json(self, {"status": "error", "message": "Not found"}, 404)
                return

            # Static files
            return super().do_GET()

        except Exception as e:
            traceback.print_exc()
            _json(self, {"status": "error", "message": str(e)}, 500)

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path

        try:
            if path == "/api/nmfs/config":
                payload = _parse_json_body(self)
                timeout_raw = payload.get("timeoutSec")
                try:
                    timeout_val = int(timeout_raw)
                except Exception:
                    timeout_val = 180
                update = {
                    "converterCmd": str(payload.get("converterCmd") or "").strip(),
                    "timeoutSec": timeout_val,
                    "keepTemp": bool(payload.get("keepTemp")),
                }
                if update["timeoutSec"] < 10:
                    update["timeoutSec"] = 10
                _write_nmfs_config_file(update)
                eff = _get_nmfs_effective_config()
                _json(self, {"status": "success", "config": eff, "configPath": NMFS_CONFIG_PATH})
                return

            if path == "/api/nmfs/config/test":
                cfg = _get_nmfs_effective_config()
                report = _validate_nmfs_converter_cfg(cfg)
                _json(self, {"status": "success", "report": report, "configPath": NMFS_CONFIG_PATH})
                return

            if path == "/api/nmfs/decode":
                os.makedirs(UPLOAD_DIR, exist_ok=True)
                ctype = self.headers.get("Content-Type", "")
                body = _read_body(self)
                filename, data = _parse_multipart_file(body, ctype)
                safe_name = os.path.basename(filename or "upload.nmfs")
                save_path = os.path.join(UPLOAD_DIR, safe_name)
                with open(save_path, "wb") as f:
                    f.write(data)

                conv = _run_nmfs_converter(save_path)
                _json(
                    self,
                    {
                        "status": "success",
                        "filename": safe_name,
                        "converter": {
                            "returncode": conv.get("returncode"),
                            "output_path": conv.get("output_path"),
                            "text_len": conv.get("text_len"),
                            "stdout": conv.get("stdout", ""),
                            "stderr": conv.get("stderr", ""),
                        },
                        "text": conv.get("text", ""),
                    },
                )
                return

            if path == "/api/lte_rrc/decode":
                payload = _parse_json_body(self)
                event_name = str(payload.get("eventName") or payload.get("event_name") or "").strip()
                payload_hex = str(payload.get("payloadHex") or payload.get("payload_hex") or "").strip()
                if not event_name or not payload_hex:
                    _json(self, {"status": "error", "message": "eventName and payloadHex are required"}, 400)
                    return
                try:
                    payload_bytes = bytes.fromhex(payload_hex)
                except Exception:
                    _json(self, {"status": "error", "message": "Invalid payloadHex"}, 400)
                    return
                name_lc = event_name.lower()
                if "measurementreport" in name_lc:
                    decoded = decode_measurement_report_payload(payload_bytes)
                elif "rrcconnectionreconfiguration" in name_lc and "complete" not in name_lc:
                    decoded = decode_rrc_reconfiguration_payload(payload_bytes)
                else:
                    decoded = decode_rrc_event_payload(payload_bytes, event_name)
                _json(self, {"status": "success", "decoded": decoded})
                return

            if path == "/api/lte_rrc/decode_batch":
                payload = _parse_json_body(self)
                items = payload.get("items")
                if not isinstance(items, list) or not items:
                    _json(self, {"status": "error", "message": "items array is required"}, 400)
                    return
                decoded_items = []
                for item in items:
                    if not isinstance(item, dict):
                        continue
                    event_name = str(item.get("eventName") or item.get("event_name") or "").strip()
                    payload_hex = str(item.get("payloadHex") or item.get("payload_hex") or "").strip()
                    if not event_name or not payload_hex:
                        continue
                    try:
                        payload_bytes = bytes.fromhex(payload_hex)
                    except Exception:
                        decoded_items.append({
                            "eventName": event_name,
                            "payloadHex": payload_hex,
                            "decoded": None,
                            "error": "Invalid payloadHex",
                        })
                        continue
                    name_lc = event_name.lower()
                    if "measurementreport" in name_lc:
                        decoded = decode_measurement_report_payload(payload_bytes)
                    elif "rrcconnectionreconfiguration" in name_lc and "complete" not in name_lc:
                        decoded = decode_rrc_reconfiguration_payload(payload_bytes)
                    else:
                        decoded = decode_rrc_event_payload(payload_bytes, event_name)
                    decoded_items.append({
                        "eventName": event_name,
                        "payloadHex": payload_hex,
                        "decoded": decoded,
                    })
                _json(self, {"status": "success", "items": decoded_items})
                return

            if path == "/api/lte_rrc/precompute":
                payload = _parse_json_body(self)
                items = payload.get("items")
                provided_cache_key = str(payload.get("cacheKey") or payload.get("cache_key") or "").strip()
                if provided_cache_key:
                    cached = _load_lte_rrc_precompute(provided_cache_key)
                    if cached is not None:
                        _json(self, {"status": "success", "cacheKey": provided_cache_key, "cached": True, **cached})
                        return
                if not isinstance(items, list) or not items:
                    _json(self, {"status": "error", "message": "items array is required when cache is missing"}, 400)
                    return
                if not provided_cache_key:
                    fingerprint_rows = []
                    for item in items:
                        if not isinstance(item, dict):
                            continue
                        fingerprint_rows.append({
                            "eventName": str(item.get("eventName") or item.get("event_name") or "").strip(),
                            "payloadHex": str(item.get("payloadHex") or item.get("payload_hex") or "").strip(),
                            "time": str(item.get("time") or "").strip(),
                            "servingPci": item.get("servingPci"),
                            "servingEarfcn": item.get("servingEarfcn"),
                        })
                    provided_cache_key = hashlib.sha1(
                        json.dumps(fingerprint_rows, separators=(",", ":"), sort_keys=True).encode("utf-8")
                    ).hexdigest()
                    cached = _load_lte_rrc_precompute(provided_cache_key)
                    if cached is not None:
                        _json(self, {"status": "success", "cacheKey": provided_cache_key, "cached": True, **cached})
                        return
                diagnostics = {
                    "candidateEvents": len(items),
                    "measurementReports": 0,
                    "reconfigurations": 0,
                    "decodedMeasurementReports": 0,
                    "decodedReconfigurations": 0,
                    "reconfigWithA3Resolvers": 0,
                    "exactA3Reports": 0,
                    "errors": [],
                }
                decoded_rows = []
                for index, item in enumerate(items):
                    if not isinstance(item, dict):
                        continue
                    row_id = item.get("rowId", index)
                    event_name = str(item.get("eventName") or item.get("event_name") or "").strip()
                    payload_hex = str(item.get("payloadHex") or item.get("payload_hex") or "").strip()
                    if not event_name or not payload_hex:
                        continue
                    properties = {}
                    try:
                        payload_bytes = bytes.fromhex(payload_hex)
                    except Exception:
                        diagnostics["errors"].append(f"{event_name}: invalid payload hex")
                        continue
                    name_lc = event_name.lower()
                    decoded = None
                    try:
                        if "measurementreport" in name_lc:
                            diagnostics["measurementReports"] += 1
                            decoded = decode_measurement_report_payload(payload_bytes)
                        elif "rrcconnectionreconfiguration" in name_lc and "complete" not in name_lc:
                            diagnostics["reconfigurations"] += 1
                            decoded = decode_rrc_reconfiguration_payload(payload_bytes)
                        else:
                            decoded = decode_rrc_event_payload(payload_bytes, event_name)
                    except Exception as exc:
                        diagnostics["errors"].append(f"{event_name}: {exc}")
                        continue
                    if not isinstance(decoded, dict) or not decoded.get("ok"):
                        continue
                    properties["RRC decoder"] = str(decoded.get("decoder") or "pycrate_rrclte")
                    if decoded.get("message_id"):
                        properties["rrc_message_id"] = str(decoded.get("message_id"))
                    row_meta = {
                        "rowId": row_id,
                        "ts": item.get("time"),
                        "eventName": event_name,
                        "properties": properties,
                        "servingPci": item.get("servingPci"),
                        "servingEarfcn": item.get("servingEarfcn"),
                        "decoded": decoded,
                        "resolver": None,
                    }
                    if str(decoded.get("message_id") or event_name).lower() == "measurement_report":
                        diagnostics["decodedMeasurementReports"] += 1
                        properties["measurement_report_full_decoded"] = "Yes"
                        properties["measurement_report_full_type"] = str(decoded.get("decoder_type") or "")
                        summary = decoded.get("summary") if isinstance(decoded.get("summary"), dict) else {}
                        if summary.get("measId") is not None:
                            properties["measurement_report_measid"] = str(summary.get("measId"))
                        if isinstance(decoded.get("serving"), dict):
                            properties["measurement_report_serving_json"] = json.dumps(decoded.get("serving"))
                        if isinstance(decoded.get("neighbors_lte"), list):
                            properties["measurement_report_neighbors_json"] = json.dumps(decoded.get("neighbors_lte"))
                        if isinstance(decoded.get("servfreq"), list):
                            properties["measurement_report_servfreq_json"] = json.dumps(decoded.get("servfreq"))
                        bits = []
                        if summary.get("measId") is not None:
                            bits.append(f"measId {summary.get('measId')}")
                        serving = decoded.get("serving") if isinstance(decoded.get("serving"), dict) else {}
                        serving_rsrp = _to_num_if_finite(serving.get("rsrp_dbm"))
                        if serving_rsrp is not None:
                            bits.append(f"serving RSRP {serving_rsrp} dBm")
                        if isinstance(decoded.get("neighbors_lte"), list):
                            bits.append(f"neighbors {len(decoded.get('neighbors_lte'))}")
                        if bits:
                            properties["rrc_message_summary"] = " | ".join(bits)
                    elif str(decoded.get("message_id") or "").lower() == "rrc_reconfiguration" or name_lc == "rrcconnectionreconfiguration":
                        diagnostics["decodedReconfigurations"] += 1
                        resolver = decoded.get("meas_resolver") if isinstance(decoded.get("meas_resolver"), dict) else None
                        row_meta["resolver"] = resolver
                        properties["rrc_recfg_full_decoded"] = "Yes"
                        properties["rrc_recfg_full_decoder"] = str(decoded.get("decoder") or "pycrate_rrclte")
                        properties["rrc_recfg_full_type"] = str(decoded.get("decoder_type") or "")
                        properties["rrc_recfg_full_json"] = json.dumps(decoded.get("decoded_json") or {})
                        summary = decoded.get("summary") if isinstance(decoded.get("summary"), dict) else {}
                        properties["rrc_recfg_meas_config_present"] = "Yes" if summary.get("has_measConfig") else "No"
                        if isinstance(decoded.get("meas_config"), dict):
                            properties["rrc_recfg_meas_config_json"] = json.dumps(decoded.get("meas_config"))
                        if resolver:
                            properties["rrc_recfg_meas_resolver_json"] = json.dumps(resolver)
                        a3_resolvers = resolver.get("a3Resolvers") if isinstance(resolver, dict) and isinstance(resolver.get("a3Resolvers"), list) else []
                        if a3_resolvers:
                            diagnostics["reconfigWithA3Resolvers"] += 1
                            first_a3 = a3_resolvers[0] if isinstance(a3_resolvers[0], dict) else None
                            if first_a3:
                                report_cfg = first_a3.get("reportConfig") if isinstance(first_a3.get("reportConfig"), dict) else {}
                                meas_object = first_a3.get("measObject") if isinstance(first_a3.get("measObject"), dict) else {}
                                if report_cfg.get("a3OffsetDb") is not None:
                                    properties["rrc_recfg_a3_offset_db"] = str(report_cfg.get("a3OffsetDb"))
                                if report_cfg.get("hysteresisDb") is not None:
                                    properties["rrc_recfg_hysteresis_db"] = str(report_cfg.get("hysteresisDb"))
                                if report_cfg.get("timeToTriggerMs") is not None:
                                    properties["rrc_recfg_ttt_ms"] = str(report_cfg.get("timeToTriggerMs"))
                                if first_a3.get("measId") is not None:
                                    properties["rrc_recfg_meas_id"] = str(first_a3.get("measId"))
                                if first_a3.get("measObjectId") is not None:
                                    properties["rrc_recfg_meas_object_id"] = str(first_a3.get("measObjectId"))
                                if first_a3.get("reportConfigId") is not None:
                                    properties["rrc_recfg_report_config_id"] = str(first_a3.get("reportConfigId"))
                                if report_cfg.get("eventType"):
                                    properties["rrc_recfg_event_type"] = str(report_cfg.get("eventType"))
                                if meas_object.get("offsetFreqDb") is not None:
                                    properties["rrc_recfg_offset_freq_db"] = str(meas_object.get("offsetFreqDb"))
                                properties["rrc_recfg_a3_resolver_summary"] = _render_a3_resolver_summary(resolver)
                        bits = []
                        if summary.get("has_measConfig"):
                            bits.append("measConfig")
                        if summary.get("has_mobilityControlInfo"):
                            bits.append("mobilityControlInfo")
                        if a3_resolvers:
                            bits.append(f"A3 resolvers {len(a3_resolvers)}")
                        if bits:
                            properties["rrc_message_summary"] = " | ".join(bits)
                    decoded_rows.append(row_meta)
                recfg_rows = [
                    row for row in decoded_rows
                    if row.get("eventName", "").lower() == "rrcconnectionreconfiguration" and isinstance(row.get("resolver"), dict)
                ]
                for row in decoded_rows:
                    if row.get("eventName", "").lower() != "measurementreport":
                        continue
                    resolved = _resolve_exact_a3_for_measurement_report(row, recfg_rows)
                    if not resolved:
                        continue
                    row["properties"]["measurement_report_a3_mapping_summary"] = resolved["mappingSummary"]
                    row["properties"]["measurement_report_a3_source_time"] = resolved["sourceTimeLabel"]
                    row["properties"]["measurement_report_a3_source_pci"] = str(resolved["sourcePci"]) if resolved.get("sourcePci") is not None else ""
                    row["properties"]["measurement_report_a3_eval_summary"] = resolved["evaluationSummary"]
                    row["properties"]["measurement_report_a3_eval_json"] = json.dumps(resolved)
                    diagnostics["exactA3Reports"] += 1
                result_payload = {
                    "diagnostics": diagnostics,
                    "items": [
                        {"rowId": row["rowId"], "properties": row["properties"]}
                        for row in decoded_rows
                        if row.get("properties")
                    ],
                }
                _store_lte_rrc_precompute(provided_cache_key, result_payload)
                _json(self, {"status": "success", "cacheKey": provided_cache_key, "cached": False, **result_payload})
                return

            if path == "/api/ho-analysis/run":
                payload = _parse_json_body(self)
                dataset = payload.get("dataset")
                if dataset is None:
                    _json(self, {"status": "error", "message": "dataset is required"}, 400)
                    return
                result = _run_ho_analysis({
                    "dataset": dataset,
                    "options": payload.get("options") or {},
                })
                analysis_id = _store_ho_analysis(result, {
                    "label": payload.get("label"),
                    "source": payload.get("source"),
                })
                _json(self, {
                    "status": "success",
                    "analysisId": analysis_id,
                    "summary": result.get("kpis", {}).get("summary"),
                    "normalization": result.get("normalization"),
                    "eventCount": len(result.get("events") or []),
                })
                return

            if path == "/api/trp/import":
                os.makedirs(UPLOAD_DIR, exist_ok=True)

                ctype = self.headers.get("Content-Type", "")
                body = _read_body(self)

                filename, data = _parse_multipart_file(body, ctype)

                save_path = os.path.join(UPLOAD_DIR, os.path.basename(filename))
                with open(save_path, "wb") as f:
                    f.write(data)

                result = import_trp_file(save_path, DB_PATH, UPLOAD_DIR)
                # Backward-compatible keys for legacy tests/clients.
                compat = {
                    "runId": result.get("runId"),
                    "metricsCount": int(result.get("kpi_count") or 0),
                    "eventTypesCount": int(result.get("event_count") or 0),
                    "importReport": {
                        "decodedSamples": int(result.get("kpi_count") or 0),
                        "decodedEvents": int(result.get("event_count") or 0),
                        "trackPoints": int(result.get("track_count") or 0),
                    },
                }
                _json(self, {"status": "success", **result, **compat})
                return

            _json(self, {"status": "error", "message": "Not found"}, 404)

        except Exception as e:
            traceback.print_exc()
            _json(self, {"status": "error", "message": str(e)}, 500)


def main():
    port = int(os.environ.get("PORT", "8000"))
    httpd = HTTPServer(("0.0.0.0", port), Handler)
    print(f"Starting server on port {port}...")
    print("Use Ctrl+C to stop.")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping server...")
    finally:
        try:
            httpd.server_close()
        except Exception:
            pass
    print("Server stopped.")


if __name__ == "__main__":
    main()


# Legacy alias used in tests.
CustomHandler = Handler

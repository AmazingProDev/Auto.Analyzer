"""
TRP importer & in-memory run store.

- Decodes TRP "provider channels" variant using CDF declarations/lookups and data.cdf
- Exposes a lightweight API consumed by server.py:
    * import_trp_file(trp_path, db_path=None, upload_dir=None) -> {"runId": int, ...}
    * list_runs(db_path=None) -> [{"id":..,"filename":..,"imported_at":..}]
    * fetch_run_detail(db_path, run_id) -> (run_dict, track_points, events)
    * fetch_run_catalog(db_path, run_id) -> {"status":"success","signals":[...], "kpis":[...], "events":[...]}
    * fetch_run_sidebar(db_path, run_id) -> {"status":"success", "groups":[...]}  (minimal)
    * fetch_run_signals(db_path, run_id) -> {"status":"success","signals":[...]}
    * fetch_timeseries_by_signal(db_path, run_id, signal, max_points=50000) -> {"status":"success","series":[...]}
    * fetch_run_track(db_path, run_id) -> {"status":"success","track":[...]}
    * fetch_run_events(db_path, run_id) -> {"status":"success","events":[...]}
    * fetch_neighbors_at_time(db_path, run_id, center_iso, tol_ms=200, bucket_ms=80)
"""

from __future__ import annotations

import os
import json
import time
import tempfile
import zipfile
import re
import zlib
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

# Decoder pipeline (patched)
from trp_raw_decoder import (
    parse_declarations_cdf,
    parse_lookup_tables_cdf,
    decode_cdf_data_variant,
    parse_track_xml,
)
from lte_rrc_per_decoder import (
    decode_measurement_report_payload,
    decode_rrc_reconfiguration_payload,
    decode_rrc_event_payload,
    per_decoder_status,
)
from lte_serving_neighbors import build_serving_neighbors_index

# ----------------------------
# In-memory store
# ----------------------------

_RUNS: Dict[int, Dict[str, Any]] = {}
_NEXT_ID: int = 1

LTE_NEIGHBOR_PCI_METRIC = "Radio.Lte.Neighbor[64].Pci"
LTE_NEIGHBOR_RSRP_METRIC = "Radio.Lte.Neighbor[64].Rsrp"
LTE_NEIGHBOR_RSRQ_METRIC = "Radio.Lte.Neighbor[64].Rsrq"
LTE_NEIGHBOR_CINR_METRICS = ["Radio.Lte.Neighbor[64].Cinr", "Radio.Lte.Neighbor[64].Sinr"]
LTE_NEIGHBOR_EARFCN_METRICS = ["Radio.Lte.Neighbor[64].Earfcn", "Radio.Lte.Neighbor[64].Frequency"]
LTE_MR_METRIC_NAME = "Message.Layer3.Errc.DcchUl.MeasurementReport"
LTE_RECFG_METRIC_NAME = "Message.Layer3.Errc.DcchDl.RrcConnectionReconfiguration"
LTE_RRC_EXTRA_PER_EVENT_PREFIX: Dict[str, str] = {
    "Message.Layer3.Errc.Sib.SystemInformationBlockType1": "sib1",
    "Message.Layer3.Errc.BcchDlSch.SystemInformationBlockType1": "sib1",
    "Message.Layer3.Errc.DcchUl.RrcConnectionReconfigurationComplete": "rrc_recfg_complete",
    "Message.Layer3.Errc.DcchDl.RrcConnectionRelease": "rrc_release",
    "Message.Layer3.Errc.CcchUl.RrcConnectionRequest": "rrc_conn_req",
    "Message.Layer3.Errc.DcchUl.RrcConnectionSetupComplete": "rrc_setup_complete",
    "Message.Layer3.Errc.DcchDl.SecurityModeCommand": "security_mode_command",
    "Message.Layer3.Errc.DcchUl.SecurityModeComplete": "security_mode_complete",
    "Message.Layer3.Errc.DcchUl.UeCapabilityInformation": "ue_cap_info",
    "Message.Layer3.Errc.DcchDl.UeInformationRequest": "ue_info_req",
    "Message.Layer3.Errc.DcchUl.UeInformationResponse": "ue_info_rsp",
    "Message.Layer3.Errc.CcchUl.RrcConnectionReestablishmentRequest": "rrc_reest_req",
    "Message.Layer3.Errc.DcchUl.RrcConnectionReestablishmentComplete": "rrc_reest_complete",
    "Message.Layer3.Errc.DcchDl.RrcConnectionReestablishmentReject": "rrc_reest_reject",
    "Message.Layer3.Errc.CcchDl.RrcConnectionReestablishmentReject": "rrc_reest_reject",
}
LTE_RRC_EXTRA_PER_METRIC_NAMES = set(LTE_RRC_EXTRA_PER_EVENT_PREFIX.keys())

L1L2_SCHEDULER_FIELD_SPECS: Dict[str, Dict[str, Any]] = {
    "allocated_rb_dl": {
        "label": "Allocated RBs DL",
        "unit": "RB",
        "exact_candidates": [
            "Radio.Lte.ServingCell[8].Pdsch.NumberOfResourceBlocks",
            "Radio.Lte.ServingCellTotal.Pdsch.NumberOfResourceBlocks",
            "Radio.Lte.ServingCell[8].Pdsch.AllocatedPrb",
            "Radio.Lte.ServingCellTotal.Pdsch.AllocatedPrb",
            "Radio.Lte.ServingCell[8].AllocatedRbs",
            "Radio.Lte.ServingCellTotal.AllocatedRbs",
        ],
        "regex": [r"pdsch.*(numberofresourceblocks|allocated(prb|rb))", r"(allocated(prb|rb)).*pdsch"],
        "per_tti_required": True,
    },
    "allocated_rb_ul": {
        "label": "Allocated RBs UL",
        "unit": "RB",
        "exact_candidates": [
            "Radio.Lte.ServingCell[8].Pusch.NumberOfResourceBlocks",
            "Radio.Lte.ServingCellTotal.Pusch.NumberOfResourceBlocks",
            "Radio.Lte.ServingCell[8].Pusch.AllocatedPrb",
            "Radio.Lte.ServingCellTotal.Pusch.AllocatedPrb",
        ],
        "regex": [r"pusch.*(numberofresourceblocks|allocated(prb|rb))", r"(allocated(prb|rb)).*pusch"],
        "per_tti_required": True,
    },
    "tbs_dl": {
        "label": "TBS DL",
        "unit": "bytes",
        "exact_candidates": [
            "Radio.Lte.ServingCell[8].Pdsch.Tbs",
            "Radio.Lte.ServingCellTotal.Pdsch.Tbs",
            "Radio.Lte.ServingCell[8].Pdsch.TransportBlockSize",
            "Radio.Lte.ServingCellTotal.Pdsch.TransportBlockSize",
        ],
        "regex": [r"pdsch.*(tbs|transportblocksize)", r"(tbs|transportblocksize).*pdsch"],
        "per_tti_required": True,
    },
    "tbs_ul": {
        "label": "TBS UL",
        "unit": "bytes",
        "exact_candidates": [
            "Radio.Lte.ServingCell[8].Pusch.Tbs",
            "Radio.Lte.ServingCellTotal.Pusch.Tbs",
            "Radio.Lte.ServingCell[8].Pusch.TransportBlockSize",
            "Radio.Lte.ServingCellTotal.Pusch.TransportBlockSize",
        ],
        "regex": [r"pusch.*(tbs|transportblocksize)", r"(tbs|transportblocksize).*pusch"],
        "per_tti_required": True,
    },
    "harq_process": {
        "label": "HARQ process counters",
        "unit": "count",
        "exact_candidates": [
            "Radio.Lte.ServingCell[8].Harq.ProcessId",
            "Radio.Lte.ServingCellTotal.Harq.ProcessId",
        ],
        "regex": [r"harq.*process", r"process.*harq"],
        "per_tti_required": False,
    },
    "harq_retx": {
        "label": "HARQ retransmissions",
        "unit": "count",
        "exact_candidates": [
            "Radio.Lte.ServingCell[8].Harq.Retransmissions",
            "Radio.Lte.ServingCellTotal.Harq.Retransmissions",
        ],
        "regex": [r"harq.*(retx|retrans|nack|fail)", r"(retx|retrans).*(harq)"],
        "per_tti_required": False,
    },
    "mac_retx": {
        "label": "MAC retransmissions",
        "unit": "count",
        "exact_candidates": [
            "Radio.Lte.ServingCell[8].Mac.Retransmissions",
            "Radio.Lte.ServingCellTotal.Mac.Retransmissions",
        ],
        "regex": [r"\bmac\b.*(retx|retrans|retransmission|nack|harq)"],
        "per_tti_required": False,
    },
    "rlc_retx": {
        "label": "RLC retransmissions",
        "unit": "count",
        "exact_candidates": [
            "Radio.Lte.ServingCell[8].Rlc.Retransmissions",
            "Radio.Lte.ServingCellTotal.Rlc.Retransmissions",
        ],
        "regex": [r"\brlc\b.*(retx|retrans|retransmission|am)"],
        "per_tti_required": False,
    },
}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def safe_extract_zip(zip_path: str, out_dir: str) -> None:
    """
    Compatibility helper used by legacy tests.
    Securely extract zip while preventing path traversal (zip-slip).
    """
    base = os.path.abspath(out_dir)
    os.makedirs(base, exist_ok=True)
    with zipfile.ZipFile(zip_path, "r") as zf:
        for info in zf.infolist():
            target = os.path.abspath(os.path.join(base, info.filename))
            if not target.startswith(base + os.sep) and target != base:
                raise ValueError(f"Unsafe zip entry: {info.filename}")
        zf.extractall(base)


def decompress_cdf_payload(blob: bytes) -> bytes:
    """
    Compatibility helper:
    TEMS CDF blobs are often stored as 8-byte header + zlib payload.
    """
    if not isinstance(blob, (bytes, bytearray)):
        return b""
    raw = bytes(blob)
    if len(raw) <= 8:
        return b""
    payload = raw[8:]
    try:
        return zlib.decompress(payload)
    except Exception:
        try:
            return zlib.decompress(payload, wbits=-zlib.MAX_WBITS)
        except Exception:
            return b""


def ensure_schema(conn) -> None:
    """
    Backward-compat no-op schema setup for sqlite-based tests.
    """
    try:
        cur = conn.cursor()
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS runs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                filename TEXT,
                imported_at TEXT
            )
            """
        )
        conn.commit()
    except Exception:
        pass


def _safe_float(x: Any) -> Optional[float]:
    try:
        if x is None:
            return None
        if isinstance(x, bool):
            return float(int(x))
        return float(x)
    except Exception:
        return None


def _safe_int(x: Any) -> Optional[int]:
    try:
        if x is None or x == "":
            return None
        if isinstance(x, bool):
            return int(x)
        n = int(float(x))
        return n
    except Exception:
        return None


def _parse_tac_value(x: Any) -> Optional[int]:
    direct = _safe_int(x)
    if isinstance(direct, int) and 0 <= direct <= 65535:
        return direct

    if isinstance(x, dict):
        for key in (
            "trackingAreaCode",
            "trackingAreaCodeHex",
            "trackingAreaCode-r8",
            "trackingAreaCode_r8",
            "tac",
            "value",
            "hex",
            "bin",
            "bits",
        ):
            if key in x:
                out = _parse_tac_value(x.get(key))
                if out is not None:
                    return out
        for v in x.values():
            out = _parse_tac_value(v)
            if out is not None:
                return out
        return None

    if isinstance(x, list):
        for item in x:
            out = _parse_tac_value(item)
            if out is not None:
                return out
        return None

    txt = str(x or "").strip()
    if not txt:
        return None

    m = re.fullmatch(r"0[xX]([0-9a-fA-F]{1,8})", txt)
    if m:
        out = _safe_int(int(m.group(1), 16))
        return out if isinstance(out, int) and 0 <= out <= 65535 else None

    m = re.fullmatch(r"([0-9a-fA-F]{4})", txt)
    if m:
        out = _safe_int(int(m.group(1), 16))
        return out if isinstance(out, int) and 0 <= out <= 65535 else None

    m = re.fullmatch(r"'?([01]{8,32})'?[bB]", txt) or re.fullmatch(r"[bB]'([01]{8,32})'", txt)
    if m:
        out = _safe_int(int(m.group(1), 2))
        return out if isinstance(out, int) and 0 <= out <= 65535 else None

    return None


def _normalize_bsic(value: Any) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, dict):
        ncc = _safe_int(value.get("networkColourCode") or value.get("ncc") or value.get("NCC"))
        bcc = _safe_int(value.get("baseStationColourCode") or value.get("bcc") or value.get("BCC"))
        if ncc is not None and bcc is not None:
            return f"{ncc}-{bcc}"
        flat = _safe_int(value.get("bsic") or value.get("BSIC") or value.get("value"))
        return str(flat) if flat is not None else None
    txt = str(value).strip()
    if not txt or txt.lower() == "[object object]":
        return None
    return txt


def _to_epoch_ms(ts: Any) -> Optional[int]:
    if ts is None:
        return None
    if isinstance(ts, (int, float)):
        if not isinstance(ts, bool) and float(ts) > 1_000_000_000:
            return int(round(float(ts)))
        return None
    raw = str(ts).strip()
    if not raw:
        return None
    # Fast path for integer-like epoch millis stored as string
    if re.fullmatch(r"-?\d{11,16}", raw):
        try:
            return int(raw)
        except Exception:
            pass
    try:
        if raw.endswith("Z"):
            raw = raw[:-1] + "+00:00"
        dt = datetime.fromisoformat(raw)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return int(round(dt.timestamp() * 1000.0))
    except Exception:
        return None


def _epoch_ms_to_iso(ms: Any) -> Optional[str]:
    if not isinstance(ms, (int, float)) or isinstance(ms, bool):
        return None
    try:
        dt = datetime.fromtimestamp(float(ms) / 1000.0, tz=timezone.utc)
        return dt.isoformat(timespec="milliseconds").replace("+00:00", "Z")
    except Exception:
        return None


def _sample_time_ms(sample: Dict[str, Any]) -> Optional[int]:
    if not isinstance(sample, dict):
        return None
    return _to_epoch_ms(sample.get("time") or sample.get("t") or sample.get("timestamp"))


def _sample_payload_bytes(sample: Dict[str, Any]) -> Optional[bytes]:
    if not isinstance(sample, dict):
        return None
    raw = sample.get("value_str")
    if isinstance(raw, (bytes, bytearray)):
        return bytes(raw)
    if isinstance(raw, str):
        if raw == "":
            return None
        # value_str carries raw PER bytes decoded as latin1 in current TRP pipeline.
        return raw.encode("latin1", errors="ignore")
    return None


def _json_compact(value: Any) -> str:
    try:
        return json.dumps(value, ensure_ascii=True, separators=(",", ":"))
    except Exception:
        return "{}"


def _json_parse_dict(value: Any) -> Optional[Dict[str, Any]]:
    if isinstance(value, dict):
        return value
    if value is None:
        return None
    txt = str(value).strip()
    if not txt:
        return None
    try:
        parsed = json.loads(txt)
        if isinstance(parsed, dict):
            return parsed
    except Exception:
        return None
    return None


def _has_value(value: Any) -> bool:
    if value is None:
        return False
    if isinstance(value, str):
        s = value.strip().lower()
        if s in ("", "n/a", "na", "nan", "-", "unknown", "none", "null", "undefined"):
            return False
    return True


def _event_param_value_ci(event: Dict[str, Any], param_id: str) -> Any:
    wanted = str(param_id or "").strip().lower()
    if not wanted or not isinstance(event, dict):
        return None

    for k, v in event.items():
        if str(k or "").strip().lower() == wanted:
            return v

    params_map = _normalize_event_params_map(event)
    for k, v in params_map.items():
        if str(k or "").strip().lower() == wanted:
            return v

    params = event.get("params")
    if isinstance(params, list):
        for row in params:
            if not isinstance(row, dict):
                continue
            pid = str(row.get("param_id") or row.get("param_name") or row.get("name") or "").strip().lower()
            if pid == wanted:
                return row.get("param_value")
    return None


def _extract_band_combos_from_decoded_json(decoded_json: Any) -> List[str]:
    if not isinstance(decoded_json, (dict, list)):
        return []

    combos: List[str] = []
    seen = set()

    def walk(node: Any) -> None:
        if isinstance(node, dict):
            for k, v in node.items():
                kl = str(k or "").lower().replace("_", "-")
                if "supportedbandcombination" in kl and isinstance(v, list):
                    for combo in v:
                        bands: List[int] = []

                        def collect_bands(x: Any) -> None:
                            if isinstance(x, dict):
                                for kk, vv in x.items():
                                    kkl = str(kk or "").lower().replace("_", "-")
                                    if "bandeutra" in kkl:
                                        n = _safe_int(vv)
                                        if isinstance(n, int) and 1 <= n <= 256:
                                            bands.append(n)
                                    collect_bands(vv)
                            elif isinstance(x, list):
                                for it in x:
                                    collect_bands(it)

                        collect_bands(combo)
                        uniq = sorted(set(bands))
                        if not uniq:
                            continue
                        txt = "+".join([f"B{b}" for b in uniq])
                        if txt and txt not in seen:
                            seen.add(txt)
                            combos.append(txt)
                walk(v)
        elif isinstance(node, list):
            for it in node:
                walk(it)

    walk(decoded_json)
    return combos


def _build_ca_capability_label(max_num_carriers: Optional[int], band_combos: List[str]) -> Optional[str]:
    combos = [str(x).strip() for x in (band_combos or []) if str(x).strip()]
    combo_part = ""
    if combos:
        preview = combos[:4]
        preview_txt = ", ".join(preview)
        if len(combos) > 4:
            preview_txt += f" (+{len(combos) - 4} more)"
        combo_part = f"band combos: {preview_txt}"

    if combo_part and isinstance(max_num_carriers, int) and max_num_carriers >= 2:
        return f"CA capable ({combo_part}; MaxNumCarriers={max_num_carriers})"
    if combo_part:
        return f"CA capable ({combo_part})"
    if isinstance(max_num_carriers, int) and max_num_carriers >= 2:
        return f"CA capable (MaxNumCarriers={max_num_carriers})"
    return None


def _extract_sidebar_info(kpi_samples: List[Dict[str, Any]], events: List[Dict[str, Any]]) -> Dict[str, Any]:
    info: Dict[str, Any] = {}

    by_name: Dict[str, List[Dict[str, Any]]] = {}
    for s in kpi_samples or []:
        nm = str((s or {}).get("name") or "").strip()
        if not nm:
            continue
        by_name.setdefault(nm, []).append(s)

    def _most_common_int(metric_name: str) -> Optional[int]:
        rows = by_name.get(metric_name) or []
        freq: Dict[int, int] = {}
        for r in rows:
            v = _safe_int((r or {}).get("value_num"))
            if v is None:
                continue
            freq[v] = int(freq.get(v) or 0) + 1
        if not freq:
            return None
        return sorted(freq.items(), key=lambda kv: (-kv[1], kv[0]))[0][0]

    best_score = -1
    best_time = -1
    best_payload: Optional[Dict[str, Any]] = None

    for ev in events or []:
        ev_name = str((ev or {}).get("event_name") or "").lower()
        if "uecapabilityinformation" not in ev_name:
            continue

        raw_summary = (
            _event_param_value_ci(ev, "ue_cap_info_summary")
            or _event_param_value_ci(ev, "rrc_message_summary")
            or (ev or {}).get("ue_cap_info_summary")
            or (ev or {}).get("rrc_message_summary")
        )
        summary = _json_parse_dict(raw_summary)
        if not isinstance(summary, dict):
            continue

        ue_cat_label = summary.get("ueCategoryLabel")
        ue_cat_num = _safe_int(summary.get("ueCategory"))
        if not _has_value(ue_cat_label) and ue_cat_num is not None and 1 <= ue_cat_num <= 64:
            ue_cat_label = f"Cat {ue_cat_num}"
        mimo_cap = summary.get("mimoCapability")
        max_num_carriers = _safe_int(summary.get("maxNumCarriers"))
        band_combos = summary.get("supportedBandCombinations")
        if not isinstance(band_combos, list):
            band_combos = []

        if not band_combos:
            raw_full = (
                _event_param_value_ci(ev, "ue_cap_info_full_json")
                or _event_param_value_ci(ev, "rrc_message_full_json")
                or (ev or {}).get("ue_cap_info_full_json")
                or (ev or {}).get("rrc_message_full_json")
            )
            full_json = _json_parse_dict(raw_full)
            if isinstance(full_json, dict):
                parsed_band_combos = _extract_band_combos_from_decoded_json(full_json)
                if parsed_band_combos:
                    band_combos = parsed_band_combos
                    if max_num_carriers is None:
                        max_num_carriers = _safe_int(summary.get("maxNumCarriers-r10") or summary.get("maxNumCarriers_r10"))

        ca_cap = _build_ca_capability_label(max_num_carriers, band_combos) or summary.get("caCapability")

        score = 0
        if _has_value(ue_cat_label):
            score += 1
        if _has_value(mimo_cap):
            score += 1
        if _has_value(ca_cap):
            score += 1
        if score <= 0:
            continue

        t_ms = _to_epoch_ms((ev or {}).get("time"))
        t_ord = int(t_ms) if isinstance(t_ms, int) else -1
        if score > best_score or (score == best_score and t_ord > best_time):
            best_score = score
            best_time = t_ord
            best_payload = {
                "ue_category": str(ue_cat_label).strip() if _has_value(ue_cat_label) else None,
                "mimo_capability": str(mimo_cap).strip() if _has_value(mimo_cap) else None,
                "ca_capability": str(ca_cap).strip() if _has_value(ca_cap) else None,
                "ca_band_combinations": band_combos[:12] if isinstance(band_combos, list) else [],
                "ue_capability_source_time": (ev or {}).get("time"),
                "ue_capability_source": "decoded_ue_capability_information",
            }

    if isinstance(best_payload, dict):
        for k, v in best_payload.items():
            if _has_value(v):
                info[k] = v

    # Fallback inference from KPI metrics when UE capability message has no decoded EUTRA details.
    def _latest_num(metric_name: str) -> Optional[float]:
        rows = by_name.get(metric_name) or []
        best_t = -1
        best_v: Optional[float] = None
        for r in rows:
            v = _safe_float((r or {}).get("value_num"))
            if v is None:
                continue
            t = _to_epoch_ms((r or {}).get("time"))
            ord_t = int(t) if isinstance(t, int) else -1
            if ord_t >= best_t:
                best_t = ord_t
                best_v = float(v)
        return best_v

    def _max_num(metric_name: str) -> Optional[float]:
        rows = by_name.get(metric_name) or []
        best_v: Optional[float] = None
        for r in rows:
            v = _safe_float((r or {}).get("value_num"))
            if v is None:
                continue
            if best_v is None or float(v) > float(best_v):
                best_v = float(v)
        return best_v

    max_num_carriers = _safe_int(_latest_num("Pocket.General.Device.MaxNumCarriers"))
    mimo_enabled_raw = _latest_num("Radio.Lte.ServingSystem.MimoEnabled")
    mimo_enabled = bool(int(mimo_enabled_raw)) if isinstance(mimo_enabled_raw, float) and abs(mimo_enabled_raw) >= 1 else False
    rank1 = _safe_float(_max_num("Radio.Lte.ServingCell[8].Rank1.FeedbackCount")) or 0.0
    rank2 = _safe_float(_max_num("Radio.Lte.ServingCell[8].Rank2.FeedbackCount")) or 0.0
    rank3 = _safe_float(_max_num("Radio.Lte.ServingCell[8].Rank3.FeedbackCount")) or 0.0
    rank4 = _safe_float(_max_num("Radio.Lte.ServingCell[8].Rank4.FeedbackCount")) or 0.0

    if not _has_value(info.get("mimo_capability")):
        if rank4 > 0:
            info["mimo_capability_inferred"] = "4x4 capable (inferred from Rank4 feedback)"
        elif rank3 > 0 or rank2 > 0:
            info["mimo_capability_inferred"] = "2x2 capable (inferred from rank feedback)"
        elif mimo_enabled:
            info["mimo_capability_inferred"] = "MIMO enabled (inferred)"

    if not _has_value(info.get("ca_capability")):
        if isinstance(max_num_carriers, int) and max_num_carriers >= 2:
            info["ca_capability_inferred"] = f"CA capable (MaxNumCarriers={max_num_carriers})"

    if not _has_value(info.get("ue_category")) and not _has_value(info.get("ue_category_inferred")):
        # Conservative inferred category buckets from available capability proxies.
        if isinstance(max_num_carriers, int) and max_num_carriers >= 2 and rank4 > 0:
            info["ue_category_inferred"] = "Cat 6+ (inferred from CA + Rank4 feedback)"
        elif isinstance(max_num_carriers, int) and max_num_carriers >= 2:
            info["ue_category_inferred"] = "Cat 6+ (inferred from CA capability)"
        elif rank4 > 0:
            info["ue_category_inferred"] = "Cat 5+ (inferred from Rank4 feedback)"
        elif rank2 > 0 or rank3 > 0:
            info["ue_category_inferred"] = "Cat 4+ (inferred from rank feedback)"

    if not _has_value(info.get("tac")):
        best_tac: Optional[int] = None
        best_tac_time: int = -1

        for ev in events or []:
            ev_name = str((ev or {}).get("event_name") or "").strip().lower()
            msg_id = str(_event_param_value_ci(ev, "rrc_message_id") or (ev or {}).get("rrc_message_id") or "").strip().lower()
            if "systeminformationblocktype1" not in ev_name and msg_id != "sib1" and "sib1" not in ev_name:
                continue

            candidates: List[Any] = [
                _event_param_value_ci(ev, "sib1_tac"),
                _event_param_value_ci(ev, "trackingAreaCode"),
                _event_param_value_ci(ev, "sib1_summary"),
                _event_param_value_ci(ev, "rrc_message_summary"),
                _event_param_value_ci(ev, "sib1_full_json"),
                _event_param_value_ci(ev, "rrc_message_full_json"),
                (ev or {}).get("sib1_tac"),
                (ev or {}).get("sib1_summary"),
                (ev or {}).get("rrc_message_summary"),
                (ev or {}).get("sib1_full_json"),
                (ev or {}).get("rrc_message_full_json"),
            ]

            tac_val: Optional[int] = None
            for cand in candidates:
                if cand is None:
                    continue
                tac_val = _parse_tac_value(cand)
                if tac_val is not None:
                    break

                parsed = _json_parse_dict(cand)
                if isinstance(parsed, dict):
                    tac_val = _parse_tac_value(parsed)
                    if tac_val is None:
                        for k, v in parsed.items():
                            if "trackingareacode" in str(k or "").lower() or str(k or "").lower() == "tac":
                                tac_val = _parse_tac_value(v)
                                if tac_val is not None:
                                    break
                    if tac_val is not None:
                        break

            if tac_val is None:
                continue
            t_ms = _to_epoch_ms((ev or {}).get("time"))
            ord_t = int(t_ms) if isinstance(t_ms, int) else -1
            if ord_t >= best_tac_time:
                best_tac_time = ord_t
                best_tac = int(tac_val)

        if best_tac is not None:
            info["tac"] = int(best_tac)
            info["tac_source"] = "decoded_sib1"

    if not _has_value(info.get("tac")):
        tac = (
            _most_common_int("Radio.Lte.ServingSystem.Tac")
            or _most_common_int("Radio.Lte.ServingCell[8].TrackingAreaCode")
            or _most_common_int("Radio.Lte.ServingCell[8].Tac")
            or _most_common_int("Radio.Lte.ServingCellTotal.TrackingAreaCode")
            or _most_common_int("Radio.Lte.ServingCellTotal.Tac")
        )
        if tac is not None:
            info["tac"] = int(tac)

    return info


def _metric_name_matches_scheduler_field(metric_name: str, spec: Dict[str, Any]) -> bool:
    name = str(metric_name or "").strip()
    if not name:
        return False
    if name in (spec.get("exact_candidates") or []):
        return True
    low = name.lower()
    for pat in (spec.get("regex") or []):
        try:
            if re.search(str(pat), low):
                return True
        except Exception:
            continue
    return False


def _compute_interval_stats(samples: List[Dict[str, Any]]) -> Dict[str, Optional[float]]:
    if len(samples) < 2:
        return {"min": None, "p50": None, "p90": None, "max": None}
    sorted_rows = sorted(samples, key=lambda r: _safe_int((r or {}).get("t_ms")) or 0)
    deltas: List[int] = []
    prev: Optional[int] = None
    for row in sorted_rows:
        t_ms = _safe_int((row or {}).get("t_ms"))
        if t_ms is None:
            continue
        if prev is not None and t_ms > prev:
            deltas.append(int(t_ms - prev))
        prev = t_ms
    if not deltas:
        return {"min": None, "p50": None, "p90": None, "max": None}
    deltas.sort()
    n = len(deltas)
    p50 = float(deltas[n // 2])
    p90 = float(deltas[min(n - 1, int(round(0.9 * (n - 1))))])
    return {
        "min": float(deltas[0]),
        "p50": p50,
        "p90": p90,
        "max": float(deltas[-1]),
    }


def _detect_l1l2_payload_presence(events: List[Dict[str, Any]]) -> Dict[str, Any]:
    matched_names: List[str] = []
    for ev in events or []:
        name = str((ev or {}).get("event_name") or "").strip()
        low = name.lower()
        if "message.layer1." in low or "message.layer2." in low:
            matched_names.append(name)
            continue
        if "message." in low and any(tok in low for tok in (".mac.", ".rlc.", ".phy.")):
            matched_names.append(name)
    uniq = sorted(set(matched_names))
    return {
        "rawPayloadEventsDetected": len(uniq) > 0,
        "matchingEventNames": uniq,
    }


def build_l1l2_scheduler_index(kpi_samples: List[Dict[str, Any]], events: List[Dict[str, Any]]) -> Dict[str, Any]:
    fields: Dict[str, Dict[str, Any]] = {}
    for field_id, spec in L1L2_SCHEDULER_FIELD_SPECS.items():
        fields[field_id] = {
            "label": spec.get("label") or field_id,
            "unit": spec.get("unit") or "",
            "perTtiRequired": bool(spec.get("per_tti_required")),
            "metricNames": [],
            "samples": [],
            "stats": {
                "sampleCount": 0,
                "intervalMs": {"min": None, "p50": None, "p90": None, "max": None},
                "perTtiExact": False,
            },
        }

    for s in kpi_samples or []:
        name = str((s or {}).get("name") or "").strip()
        if not name:
            continue
        t_ms = _sample_time_ms(s or {})
        v = _safe_float((s or {}).get("value_num"))
        if t_ms is None or v is None:
            continue
        for field_id, spec in L1L2_SCHEDULER_FIELD_SPECS.items():
            if not _metric_name_matches_scheduler_field(name, spec):
                continue
            row = fields[field_id]
            mnames = row["metricNames"]
            if name not in mnames:
                mnames.append(name)
            row["samples"].append({
                "time": (s or {}).get("time") or _epoch_ms_to_iso(t_ms),
                "t_ms": int(t_ms),
                "value": float(v),
                "metric": name,
            })

    for field_id, row in fields.items():
        samples = row.get("samples") or []
        samples.sort(key=lambda r: _safe_int((r or {}).get("t_ms")) or 0)
        row["metricNames"] = sorted(list(row.get("metricNames") or []))
        stats = row.get("stats") or {}
        stats["sampleCount"] = len(samples)
        int_stats = _compute_interval_stats(samples)
        stats["intervalMs"] = int_stats
        p50 = _safe_float((int_stats or {}).get("p50"))
        # Treat <=2 ms median cadence as per-TTI equivalent (LTE TTI is 1 ms).
        stats["perTtiExact"] = bool(p50 is not None and p50 <= 2.0)
        row["stats"] = stats

    payload_presence = _detect_l1l2_payload_presence(events)
    per_decode_supported = bool(payload_presence.get("rawPayloadEventsDetected"))
    limitations: List[str] = []
    if not per_decode_supported:
        limitations.append(
            "No Layer1/Layer2 raw message payload events were found in this TRP (no Message.Layer1/Message.Layer2 stream)."
        )
    if not any((fields[f]["stats"].get("perTtiExact") for f in fields)):
        limitations.append("No scheduler counter was sampled at ~1 ms cadence, so exact per-TTI values are unavailable.")

    return {
        "fields": fields,
        "availability": {
            "perDecodeSupported": per_decode_supported,
            "rawPayloadEventsDetected": bool(payload_presence.get("rawPayloadEventsDetected")),
            "matchingPayloadEvents": payload_presence.get("matchingEventNames") or [],
            "limitations": limitations,
        },
    }


def _get_l1l2_scheduler_index(entry: Dict[str, Any]) -> Dict[str, Any]:
    idx = entry.get("l1l2_scheduler_index")
    if isinstance(idx, dict) and idx:
        return idx
    idx = build_l1l2_scheduler_index(entry.get("kpi_samples") or [], entry.get("events") or [])
    entry["l1l2_scheduler_index"] = idx
    return idx


def fetch_l1l2_scheduler_capabilities(db_path: Optional[str], run_id: int) -> Dict[str, Any]:
    rid = int(run_id)
    if rid not in _RUNS:
        return {"status": "error", "message": "Run not found"}
    idx = _get_l1l2_scheduler_index(_RUNS[rid])
    fields_out: List[Dict[str, Any]] = []
    for field_id, row in (idx.get("fields") or {}).items():
        stats = row.get("stats") or {}
        fields_out.append({
            "field": field_id,
            "label": row.get("label"),
            "unit": row.get("unit"),
            "sampleCount": int(stats.get("sampleCount") or 0),
            "intervalMs": stats.get("intervalMs") or {},
            "perTtiExact": bool(stats.get("perTtiExact")),
            "metricNames": row.get("metricNames") or [],
        })
    fields_out.sort(key=lambda r: str(r.get("label") or r.get("field") or ""))
    return {
        "status": "success",
        "availability": idx.get("availability") or {},
        "fields": fields_out,
    }


def _nearest_scheduler_sample(
    samples: List[Dict[str, Any]],
    center_ms: int,
    window_ms: int,
) -> Optional[Dict[str, Any]]:
    best: Optional[Dict[str, Any]] = None
    best_dt: Optional[int] = None
    for row in samples or []:
        t_ms = _safe_int((row or {}).get("t_ms"))
        if t_ms is None:
            continue
        dt = abs(t_ms - center_ms)
        if dt > window_ms:
            continue
        if best is None or dt < (best_dt or 10**18):
            best = row
            best_dt = dt
    if best is None:
        return None
    out = dict(best)
    out["delta_ms"] = int(best_dt or 0)
    return out


def fetch_l1l2_scheduler_at_time(
    db_path: Optional[str],
    run_id: int,
    center_iso: str,
    window_ms: int = 2000,
) -> Dict[str, Any]:
    rid = int(run_id)
    if rid not in _RUNS:
        return {"status": "error", "message": "Run not found"}
    center_ms = _to_epoch_ms(center_iso)
    if center_ms is None:
        return {"status": "error", "message": "Invalid time"}
    win = int(max(1, _safe_int(window_ms) or 2000))
    idx = _get_l1l2_scheduler_index(_RUNS[rid])

    fields_out: List[Dict[str, Any]] = []
    for field_id, row in (idx.get("fields") or {}).items():
        nearest = _nearest_scheduler_sample(row.get("samples") or [], center_ms=center_ms, window_ms=win)
        stats = row.get("stats") or {}
        fields_out.append({
            "field": field_id,
            "label": row.get("label"),
            "unit": row.get("unit"),
            "perTtiRequired": bool(row.get("perTtiRequired")),
            "perTtiExact": bool(stats.get("perTtiExact")),
            "value": _safe_float((nearest or {}).get("value")),
            "metric": (nearest or {}).get("metric"),
            "sample_time": (nearest or {}).get("time"),
            "delta_ms": _safe_int((nearest or {}).get("delta_ms")),
            "sampleCount": int(stats.get("sampleCount") or 0),
            "intervalMs": stats.get("intervalMs") or {},
        })
    fields_out.sort(key=lambda r: str(r.get("label") or r.get("field") or ""))

    return {
        "status": "success",
        "time": center_iso,
        "windowMs": win,
        "availability": idx.get("availability") or {},
        "fields": fields_out,
    }


def _normalize_event_params_map(event: Dict[str, Any]) -> Dict[str, Any]:
    params_map = event.get("params_map")
    if isinstance(params_map, dict):
        return params_map

    params_map = {}
    params = event.get("params")
    if isinstance(params, list):
        for row in params:
            if not isinstance(row, dict):
                continue
            pid = str(row.get("param_id") or row.get("param_name") or row.get("name") or "").strip()
            if not pid:
                continue
            if pid not in params_map:
                params_map[pid] = row.get("param_value")
    event["params_map"] = params_map
    return params_map


def _upsert_event_param(event: Dict[str, Any], param_id: str, value: Any) -> None:
    pid = str(param_id or "").strip()
    if not pid:
        return

    params = event.get("params")
    if not isinstance(params, list):
        params = []
        event["params"] = params

    found = False
    wanted = pid.lower()
    for row in params:
        if not isinstance(row, dict):
            continue
        rid = str(row.get("param_id") or row.get("param_name") or row.get("name") or "").strip().lower()
        if rid != wanted:
            continue
        row["param_id"] = pid
        row["param_value"] = value
        if "param_type" not in row:
            row["param_type"] = "str"
        found = True
        break

    if not found:
        p_type = "str"
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            p_type = "float"
        params.append({"param_id": pid, "param_value": value, "param_type": p_type})

    params_map = _normalize_event_params_map(event)
    params_map[pid] = value


def _attach_patch_to_event(event: Dict[str, Any], patch: Dict[str, Any], params_patch: Dict[str, Any]) -> None:
    if not isinstance(event, dict):
        return
    if patch:
        event.update(patch)
    if params_patch:
        for k, v in params_patch.items():
            _upsert_event_param(event, k, v)


def _apply_decode_to_matching_events(
    events_by_key: Dict[Tuple[str, str], List[Dict[str, Any]]],
    time_iso: str,
    event_name: str,
    patch: Dict[str, Any],
    params_patch: Optional[Dict[str, Any]] = None,
) -> None:
    if not time_iso or not event_name:
        return
    for ev in events_by_key.get((time_iso, event_name), []):
        _attach_patch_to_event(ev, patch or {}, params_patch or {})


def _decode_lte_rrc_payloads_in_place(
    kpi_samples: List[Dict[str, Any]],
    events: List[Dict[str, Any]],
) -> Dict[str, Any]:
    stats = {
        "measurement_reports_seen": 0,
        "measurement_reports_decoded": 0,
        "measurement_reports_failed": 0,
        "reconfig_seen": 0,
        "reconfig_decoded": 0,
        "reconfig_failed": 0,
        "rrc_extra_seen": 0,
        "rrc_extra_decoded": 0,
        "rrc_extra_failed": 0,
        "rrc_extra_by_message": {},
        "decoder_status": per_decoder_status(),
    }

    if not stats["decoder_status"].get("available"):
        return stats

    events_by_key: Dict[Tuple[str, str], List[Dict[str, Any]]] = {}
    for ev in events or []:
        key = (str(ev.get("time") or ""), str(ev.get("event_name") or ""))
        events_by_key.setdefault(key, []).append(ev)

    for s in kpi_samples or []:
        name = str((s or {}).get("name") or "")
        lower_name = name.lower()
        is_sib1_metric = "systeminformationblocktype1" in lower_name
        if (
            name not in (LTE_MR_METRIC_NAME, LTE_RECFG_METRIC_NAME)
            and name not in LTE_RRC_EXTRA_PER_METRIC_NAMES
            and not is_sib1_metric
        ):
            continue
        payload = _sample_payload_bytes(s or {})
        if not payload:
            continue
        time_iso = str((s or {}).get("time") or "")

        if name == LTE_MR_METRIC_NAME:
            stats["measurement_reports_seen"] += 1
            dec = decode_measurement_report_payload(payload)
            if not dec.get("ok"):
                stats["measurement_reports_failed"] += 1
                fail_patch = {
                    "per_decoded": False,
                    "per_decoder": "pycrate_rrclte",
                    "per_decoder_type": None,
                    "payload_len": len(payload),
                }
                fail_params = {
                    "measurement_report_full_decoded": "no",
                    "measurement_report_full_decoder": "pycrate_rrclte",
                    "measurement_report_full_type": "",
                }
                s.update(fail_patch)
                _apply_decode_to_matching_events(events_by_key, time_iso, name, fail_patch, fail_params)
                continue
            stats["measurement_reports_decoded"] += 1
            merged_neighbors = list(dec.get("neighbors_lte") or []) + list(dec.get("neighbors_utra") or []) + list(dec.get("neighbors_geran") or [])
            summary = dec.get("summary") or {}
            serving_json = dec.get("serving") or {}
            neighbors_lte = dec.get("neighbors_lte") or []
            neighbors_utra = dec.get("neighbors_utra") or []
            neighbors_geran = dec.get("neighbors_geran") or []
            servfreq_rows = dec.get("servfreq") or []
            full_json_txt = _json_compact(dec.get("decoded_json") or {})
            neighbors_txt = _json_compact(merged_neighbors)
            serving_txt = _json_compact(serving_json)
            servfreq_txt = _json_compact(servfreq_rows)
            patch = {
                "per_decoded": True,
                "per_decoder": dec.get("decoder"),
                "per_decoder_type": dec.get("decoder_type"),
                "per_decode_offset": dec.get("decode_offset"),
                "decoded_json": dec.get("decoded_json"),
                "measurement_report_summary": summary,
                "measurement_report_serving_json": serving_json,
                "measurement_report_neighbors_json": merged_neighbors,
                "measurement_report_neighbors_lte_json": neighbors_lte,
                "measurement_report_neighbors_utra_json": neighbors_utra,
                "measurement_report_neighbors_geran_json": neighbors_geran,
                "measurement_report_servfreq_json": servfreq_rows,
                "payload_len": len(payload),
            }
            params_patch = {
                "measurement_report_full_decoded": "yes",
                "measurement_report_full_decoder": str(dec.get("decoder") or "pycrate_rrclte"),
                "measurement_report_full_type": str(dec.get("decoder_type") or ""),
                "measurement_report_full_json": full_json_txt,
                "measurement_report_measid": summary.get("measId"),
                "measurement_report_summary": _json_compact(summary),
                "measurement_report_serving_json": serving_txt,
                "measurement_report_neighbors_json": neighbors_txt,
                "measurement_report_neighbors_lte_json": _json_compact(neighbors_lte),
                "measurement_report_neighbors_utra_json": _json_compact(neighbors_utra),
                "measurement_report_neighbors_geran_json": _json_compact(neighbors_geran),
                "measurement_report_servfreq_json": servfreq_txt,
            }
            s.update(patch)
            _apply_decode_to_matching_events(events_by_key, time_iso, name, patch, params_patch)
            continue

        if name == LTE_RECFG_METRIC_NAME:
            stats["reconfig_seen"] += 1
            dec = decode_rrc_reconfiguration_payload(payload)
            if not dec.get("ok"):
                stats["reconfig_failed"] += 1
                fail_patch = {
                    "per_decoded": False,
                    "per_decoder": "pycrate_rrclte",
                    "per_decoder_type": None,
                    "payload_len": len(payload),
                }
                fail_params = {
                    "rrc_recfg_full_decoded": "no",
                    "rrc_recfg_full_decoder": "pycrate_rrclte",
                    "rrc_recfg_full_type": "",
                    "rrc_recfg_summary": "",
                    "rrc_recfg_meas_config_present": "no",
                }
                s.update(fail_patch)
                _apply_decode_to_matching_events(events_by_key, time_iso, name, fail_patch, fail_params)
                continue
            stats["reconfig_decoded"] += 1
            summary = dec.get("summary") or {}
            meas_cfg = dec.get("meas_config") or {}
            full_json_txt = _json_compact(dec.get("decoded_json") or {})
            meas_cfg_txt = _json_compact(meas_cfg)
            patch = {
                "per_decoded": True,
                "per_decoder": dec.get("decoder"),
                "per_decoder_type": dec.get("decoder_type"),
                "per_decode_offset": dec.get("decode_offset"),
                "decoded_json": dec.get("decoded_json"),
                "rrc_reconfiguration_meas_config_json": meas_cfg,
                "rrc_reconfiguration_summary": summary,
                "payload_len": len(payload),
            }
            summary_txt_parts = []
            if summary.get("has_measConfig"):
                summary_txt_parts.append("measConfig")
            if summary.get("has_mobilityControlInfo"):
                summary_txt_parts.append("mobilityControlInfo")
            if summary.get("has_radioResourceConfigDedicated"):
                summary_txt_parts.append("radioResourceConfigDedicated")
            summary_txt = ", ".join(summary_txt_parts) if summary_txt_parts else "RRCConnectionReconfiguration decoded"
            params_patch = {
                "rrc_recfg_full_decoded": "yes",
                "rrc_recfg_full_decoder": str(dec.get("decoder") or "pycrate_rrclte"),
                "rrc_recfg_full_type": str(dec.get("decoder_type") or ""),
                "rrc_recfg_full_json": full_json_txt,
                "rrc_recfg_summary": summary_txt,
                "rrc_recfg_meas_config_present": "yes" if bool(summary.get("has_measConfig")) else "no",
                "rrc_recfg_meas_config_json": meas_cfg_txt,
            }
            s.update(patch)
            _apply_decode_to_matching_events(events_by_key, time_iso, name, patch, params_patch)
            continue

        # Additional LTE RRC PER decode profiles
        prefix = LTE_RRC_EXTRA_PER_EVENT_PREFIX.get(name) or ("sib1" if "systeminformationblocktype1" in lower_name else "rrc_msg")
        stats["rrc_extra_seen"] += 1
        dec = decode_rrc_event_payload(payload, name)
        if not dec.get("ok"):
            stats["rrc_extra_failed"] += 1
            fail_patch = {
                "per_decoded": False,
                "per_decoder": "pycrate_rrclte",
                "per_decoder_type": None,
                "payload_len": len(payload),
                "rrc_message_id": prefix,
            }
            fail_params = {
                f"{prefix}_full_decoded": "no",
                f"{prefix}_full_decoder": "pycrate_rrclte",
                f"{prefix}_full_type": "",
                f"{prefix}_summary": "",
            }
            s.update(fail_patch)
            _apply_decode_to_matching_events(events_by_key, time_iso, name, fail_patch, fail_params)
            continue

        stats["rrc_extra_decoded"] += 1
        msg_id = str(dec.get("message_id") or prefix)
        by_msg = stats.get("rrc_extra_by_message")
        if not isinstance(by_msg, dict):
            by_msg = {}
            stats["rrc_extra_by_message"] = by_msg
        by_msg[msg_id] = int(by_msg.get(msg_id) or 0) + 1

        summary = dec.get("summary") or {}
        full_json_txt = _json_compact(dec.get("decoded_json") or {})
        summary_txt = _json_compact(summary)
        patch = {
            "per_decoded": True,
            "per_decoder": dec.get("decoder"),
            "per_decoder_type": dec.get("decoder_type"),
            "per_decode_offset": dec.get("decode_offset"),
            "decoded_json": dec.get("decoded_json"),
            "rrc_message_id": msg_id,
            "rrc_message_summary": summary,
            f"{prefix}_summary": summary,
            "payload_len": len(payload),
        }
        params_patch = {
            f"{prefix}_full_decoded": "yes",
            f"{prefix}_full_decoder": str(dec.get("decoder") or "pycrate_rrclte"),
            f"{prefix}_full_type": str(dec.get("decoder_type") or ""),
            f"{prefix}_full_json": full_json_txt,
            f"{prefix}_summary": summary_txt,
            "rrc_message_id": msg_id,
            "rrc_message_summary": summary_txt,
        }
        if msg_id == "sib1":
            tac = _parse_tac_value(summary)
            if tac is not None:
                patch["sib1_tac"] = int(tac)
                params_patch["sib1_tac"] = str(int(tac))
        elif msg_id == "ue_information_request":
            req_rlf = summary.get("rlfReportReq")
            req_rach = summary.get("rachReportReq")
            if req_rlf is not None:
                patch["ue_info_req_rlf_report_req"] = bool(req_rlf)
                params_patch["ue_info_req_rlf_report_req"] = "yes" if bool(req_rlf) else "no"
            if req_rach is not None:
                patch["ue_info_req_rach_report_req"] = bool(req_rach)
                params_patch["ue_info_req_rach_report_req"] = "yes" if bool(req_rach) else "no"
        elif msg_id == "ue_information_response":
            root_cause = summary.get("rlfRootCause")
            root_details = summary.get("rlfRootCauseDetails")
            timeline_txt = summary.get("reestablishmentTimeline")
            reason_breakdown = summary.get("rlfReasonBreakdown")
            has_rlf = summary.get("hasRlfReport")
            if has_rlf is not None:
                patch["ue_info_rsp_has_rlf_report"] = bool(has_rlf)
                params_patch["ue_info_rsp_has_rlf_report"] = "yes" if bool(has_rlf) else "no"
            if _has_value(root_cause):
                patch["ue_info_rsp_rlf_root_cause"] = str(root_cause)
                params_patch["ue_info_rsp_rlf_root_cause"] = str(root_cause)
            if _has_value(root_details):
                patch["ue_info_rsp_rlf_root_cause_details"] = str(root_details)
                params_patch["ue_info_rsp_rlf_root_cause_details"] = str(root_details)
            if _has_value(timeline_txt):
                patch["ue_info_rsp_reest_timeline"] = str(timeline_txt)
                params_patch["ue_info_rsp_reest_timeline"] = str(timeline_txt)
            if isinstance(reason_breakdown, dict) and reason_breakdown:
                patch["ue_info_rsp_rlf_reason_breakdown"] = reason_breakdown
                params_patch["ue_info_rsp_rlf_reason_breakdown"] = _json_compact(reason_breakdown)
        s.update(patch)
        _apply_decode_to_matching_events(events_by_key, time_iso, name, patch, params_patch)

    return stats


def _extract_neighbor_sample_index(sample: Dict[str, Any]) -> Optional[int]:
    """
    Best-effort extraction of per-sample neighbor array index from decoded sample metadata.
    Supports multiple decoder shapes (idx/index on sample root, tags/meta containers, etc.).
    """
    if not isinstance(sample, dict):
        return None

    candidates: List[Any] = []
    for key in ("idx", "index", "neighbor_index", "array_index", "slot_index"):
        candidates.append(sample.get(key))

    for key in ("tags", "meta", "lookup"):
        obj = sample.get(key)
        if isinstance(obj, dict):
            for sub in ("idx", "index", "neighbor_index", "array_index", "slot_index"):
                candidates.append(obj.get(sub))

    # Some decoders expose params as [{"param_id":"idx","param_value":3}, ...]
    params = sample.get("params")
    if isinstance(params, list):
        for p in params:
            if not isinstance(p, dict):
                continue
            pid = str(p.get("param_id") or "").strip().lower()
            if pid in ("idx", "index", "neighbor_index", "array_index", "slot_index"):
                candidates.append(p.get("param_value"))

    value_str = sample.get("value_str")
    if isinstance(value_str, str):
        m = re.search(r"(?:idx|index|slot)\s*[:=]\s*(-?\d+)", value_str, re.IGNORECASE)
        if m:
            candidates.append(m.group(1))

    for c in candidates:
        i = _safe_int(c)
        if i is None:
            continue
        if 0 <= i <= 1024:
            return i
    return None


def _run_metric_names(entry: Dict[str, Any]) -> set[str]:
    cached = entry.get("_metric_name_set")
    if isinstance(cached, set):
        return cached
    out: set[str] = set()
    for s in ((entry.get("catalog") or {}).get("signals") or []):
        nm = str((s or {}).get("signal_name") or "").strip()
        if nm:
            out.add(nm)
    for s in entry.get("kpi_samples") or []:
        nm = str((s or {}).get("name") or "").strip()
        if nm:
            out.add(nm)
    entry["_metric_name_set"] = out
    return out


def _pick_best_metric_name(entry: Dict[str, Any], candidates: List[str]) -> Optional[str]:
    names = _run_metric_names(entry)
    for c in candidates:
        if c in names:
            return c
    return None


def _normalize_neighbor_earfcn_div(entry: Dict[str, Any]) -> int:
    cached = entry.get("_neighbor_earfcn_div")
    if cached in (1, 2):
        return int(cached)

    samples = entry.get("kpi_samples") or []
    raw_vals: List[int] = []
    serving_vals: set[int] = set()
    for s in samples:
        name = str((s or {}).get("name") or "")
        low = name.lower()
        v = _safe_int((s or {}).get("value_num"))
        if v is None:
            continue
        if low == LTE_NEIGHBOR_EARFCN_METRICS[0].lower() or low == LTE_NEIGHBOR_EARFCN_METRICS[1].lower():
            raw_vals.append(int(v))
        elif "radio.lte.servingcell" in low and "earfcn" in low and "neighbor" not in low:
            serving_vals.add(int(v))

    div = 1
    if raw_vals:
        even = [x for x in raw_vals if x % 2 == 0]
        even_ratio = (len(even) / len(raw_vals)) if raw_vals else 0.0
        raw_hits = sum(1 for x in raw_vals if x in serving_vals)
        half_hits = sum(1 for x in even if (x // 2) in serving_vals)
        raw_max = max(raw_vals)
        if half_hits > raw_hits:
            div = 2
        elif raw_max >= 10000 and even_ratio >= 0.8:
            div = 2

    entry["_neighbor_earfcn_div"] = div
    return div


def _downsample(series: List[Dict[str, Any]], max_points: int) -> List[Dict[str, Any]]:
    """Evenly downsample to max_points, keeping first/last."""
    n = len(series)
    if max_points <= 0 or n <= max_points:
        return series
    if max_points < 3:
        return [series[0], series[-1]]
    step = (n - 1) / (max_points - 1)
    out = []
    for i in range(max_points):
        idx = int(round(i * step))
        if idx < 0:
            idx = 0
        if idx >= n:
            idx = n - 1
        out.append(series[idx])
    # Deduplicate identical indices due to rounding
    dedup = []
    last = None
    for r in out:
        if last is None or (
            r.get("t"),
            r.get("value"),
            r.get("value_str"),
            r.get("idx"),
        ) != (
            last.get("t"),
            last.get("value"),
            last.get("value_str"),
            last.get("idx"),
        ):
            dedup.append(r)
        last = r
    return dedup


def _build_catalog(kpi_samples: List[Dict[str, Any]], decls: Dict[int, Dict[str, Any]]) -> Tuple[List[Dict[str, Any]], List[str]]:
    # count by name
    counts: Dict[str, int] = {}
    dtype_by_name: Dict[str, str] = {}
    unit_by_name: Dict[str, str] = {}
    for s in kpi_samples:
        name = s.get("name") or ""
        if not name:
            continue
        counts[name] = counts.get(name, 0) + 1
        dtype_by_name[name] = s.get("dtype") or dtype_by_name.get(name, "num")
        unit_by_name[name] = s.get("unit") or unit_by_name.get(name, "")

    # Prefer declaration metadata where possible
    signals: List[Dict[str, Any]] = []
    for name, c in sorted(counts.items(), key=lambda kv: kv[0].lower()):
        signals.append({
            "signal_id": name,   # UI uses signal_id in requests
            "signal_name": name,
            "label": name,
            "unit": unit_by_name.get(name, ""),
            "dtype": dtype_by_name.get(name, "num"),
            "sample_count": c,
        })

    # Ensure all declared LTE neighbor signals are present in catalog, even if no samples were decoded.
    # This allows the UI to enumerate all neighbor indexes from declarations.cdf.
    # Pattern examples:
    #   Radio.Lte.Neighbor[1].Pci
    #   Radio.Lte.Neighbor[64].Rsrp
    #   Radio.Lte.Neighbor[64].Rsrq
    #   Radio.Lte.Neighbor[64].Earfcn / Frequency
    seen_names = {s["signal_name"] for s in signals}
    neighbor_decl_re = re.compile(r"^Radio\.Lte\.Neighbor\[\d+\]\.", re.IGNORECASE)
    for _mid, meta in (decls or {}).items():
        name = str((meta or {}).get("name") or "").strip()
        if not name or name in seen_names:
            continue
        if not neighbor_decl_re.match(name):
            continue
        signals.append({
            "signal_id": name,
            "signal_name": name,
            "label": name,
            "unit": unit_by_name.get(name, ""),
            "dtype": dtype_by_name.get(name, (meta or {}).get("dtype") or "num"),
            "sample_count": int(counts.get(name, 0)),
        })
        seen_names.add(name)

    signals.sort(key=lambda s: str(s.get("signal_name") or "").lower())

    # KPI list: UI treats KPIs as "signals" too
    kpis = [s["signal_name"] for s in signals]
    return signals, kpis


def _build_sidebar_groups(kpis: List[str]) -> List[Dict[str, Any]]:
    """
    Minimal grouping so the UI has something stable.
    The visual grouping/buttons are primarily defined in metric_registry.js anyway.
    """
    groups = [
        {"title": "All KPIs", "items": kpis[:2000]},  # cap for UI sanity
    ]
    return groups


def _extract_neighbor_metrics_from_samples(kpi_samples: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Extract LTE neighbor metrics directly from decoded TRP KPI samples (not from catalog),
    grouped by exact metric name with sample_count.
    """
    pat = re.compile(r"^Radio\.Lte\.Neighbor\[(\d+)\]\.(Pci|Rsrp|Rsrq|Cinr|Earfcn|Frequency)$", re.IGNORECASE)
    rows_by_name: Dict[str, Dict[str, Any]] = {}
    for s in (kpi_samples or []):
        name = str((s or {}).get("name") or "").strip()
        if not name:
            continue
        if not pat.match(name):
            continue
        row = rows_by_name.get(name)
        if row is None:
            row = {"sample_count": 0, "sample_indexes": set()}
            rows_by_name[name] = row
        row["sample_count"] = int(row.get("sample_count") or 0) + 1
        idx = _extract_neighbor_sample_index(s or {})
        if idx is not None:
            row["sample_indexes"].add(int(idx))

    out: List[Dict[str, Any]] = []
    for name, row in rows_by_name.items():
        m = pat.match(name)
        if not m:
            continue
        sample_indexes = sorted(int(v) for v in (row.get("sample_indexes") or set()))
        out.append({
            "name": name,
            "neighbor_index": int(m.group(1)),
            "field": str(m.group(2) or ""),
            "sample_count": int(row.get("sample_count") or 0),
            "sample_indexes": sample_indexes,
            "sample_index_count": len(sample_indexes),
        })
    out.sort(key=lambda r: (int(r.get("neighbor_index") or 0), str(r.get("field") or "").lower(), str(r.get("name") or "").lower()))
    return out


def _build_catalog_payload(entry: Dict[str, Any]) -> Dict[str, Any]:
    cat = entry.get("catalog") or {}
    signals = cat.get("signals") or []
    events = cat.get("events") or []
    metrics_flat = []
    for s in signals:
        name = s.get("signal_name") or s.get("name")
        if not name:
            continue
        sample_count = int(s.get("sample_count") or 0)
        metrics_flat.append({
            "metric_id": s.get("signal_id") or name,
            "name": name,
            "dtype": s.get("dtype") or "num",
            "lookup": None,
            "value_kind": "numeric",
            "path_segments": str(name).split("."),
            "tags": [],
            "stats": {"sample_count": sample_count},
        })

    def _find_default(keyword: str) -> Optional[str]:
        low_kw = keyword.lower()
        for m in metrics_flat:
            nm = str(m.get("name") or "").lower()
            if low_kw in nm:
                return m.get("name")
        return metrics_flat[0]["name"] if metrics_flat else None

    defaults = {
        "rsrpMetricName": _find_default("rsrp"),
        "sinrMetricName": _find_default("sinr"),
        "mosMetricName": _find_default("mos"),
    }
    return {
        "status": "success",
        "signals": signals,
        "kpis": cat.get("kpis") or [],
        "events": events,
        "metricsFlat": metrics_flat,
        "metricsTree": [],
        "eventsGrouped": [],
        "defaults": defaults,
    }


def build_metric_catalog(kpi_samples: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Backward-compatible metric catalog builder used by tests.
    """
    by_name: Dict[str, Dict[str, Any]] = {}
    for s in kpi_samples or []:
        name = str((s or {}).get("name") or "").strip()
        if not name:
            continue
        row = by_name.get(name)
        if row is None:
            row = {
                "name": name,
                "metric_id": (s or {}).get("metric_id"),
                "dtype": (s or {}).get("dtype") or "num",
                "stats": {
                    "sample_count": 0,
                    "min": None,
                    "max": None,
                    "avg": None,
                },
            }
            by_name[name] = row
        st = row["stats"]
        st["sample_count"] = int(st.get("sample_count") or 0) + 1
        v = _safe_float((s or {}).get("value_num"))
        if v is None:
            continue
        mn = st.get("min")
        mx = st.get("max")
        st["min"] = v if mn is None else min(float(mn), float(v))
        st["max"] = v if mx is None else max(float(mx), float(v))
        ssum = float(st.get("_sum") or 0.0) + float(v)
        scnt = int(st.get("_num_count") or 0) + 1
        st["_sum"] = ssum
        st["_num_count"] = scnt
        st["avg"] = ssum / max(1, scnt)

    out = list(by_name.values())
    for row in out:
        st = row.get("stats") or {}
        st.pop("_sum", None)
        st.pop("_num_count", None)
    out.sort(key=lambda r: str(r.get("name") or "").lower())
    return out


def build_event_catalog(events: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Backward-compatible event catalog builder used by tests.
    """
    by_name: Dict[str, Dict[str, Any]] = {}
    for ev in events or []:
        name = str((ev or {}).get("event_name") or "").strip()
        if not name:
            continue
        row = by_name.get(name)
        if row is None:
            row = {
                "event_name": name,
                "count": 0,
                "param_ids": [],
            }
            by_name[name] = row
        row["count"] = int(row.get("count") or 0) + 1
        pids = row.setdefault("_param_ids", set())
        for p in ((ev or {}).get("params") or []):
            if not isinstance(p, dict):
                continue
            pid = p.get("param_id")
            if pid is None:
                continue
            pids.add(str(pid))

    out = list(by_name.values())
    for row in out:
        pids = sorted(list(row.pop("_param_ids", set())))
        row["param_ids"] = pids
    out.sort(key=lambda r: str(r.get("event_name") or "").lower())
    return out


def build_kpi_type_summary(kpi_samples: List[Dict[str, Any]], metric_map: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """
    Backward-compatible KPI selector summary used by tests.
    """
    metric_map = metric_map or {}
    metrics = build_metric_catalog(kpi_samples or [])
    by_name = {str(m.get("name") or ""): m for m in metrics}

    def pick(candidates: List[str]) -> Optional[str]:
        for c in candidates:
            if c in by_name:
                return c
        low_to_name = {k.lower(): k for k in by_name.keys()}
        for c in candidates:
            cl = c.lower()
            if cl in low_to_name:
                return low_to_name[cl]
        return None

    chosen = {
        "rsrp": pick(["Radio.Lte.ServingCell[0].Rsrp", "Radio.Lte.ServingCell[8].Rsrp", "Radio.Lte.ServingCellTotal.Rsrp"]),
        "rsrq": pick(["Radio.Lte.ServingCell[0].Rsrq", "Radio.Lte.ServingCell[8].Rsrq", "Radio.Lte.ServingCellTotal.Rsrq"]),
        "sinr": pick(["Radio.Lte.ServingCell[0].RsSinr", "Radio.Lte.ServingCell[8].RsSinr", "Radio.Lte.ServingCellTotal.RsSinr"]),
        "dl_tp": pick(["Pocket.Data.Downlink.Throughput", "Radio.Lte.ServingCellTotal.Pdsch.Throughput"]),
        "ul_tp": pick(["Pocket.Data.Uplink.Throughput", "Radio.Lte.ServingCellTotal.Pusch.Throughput"]),
    }

    stats = {}
    for k, name in chosen.items():
        stats[k] = ((by_name.get(name) or {}).get("stats") if name else None) or {
            "sample_count": 0,
            "min": None,
            "max": None,
            "avg": None,
        }
    return {"chosen": chosen, "stats": stats}


# ----------------------------
# Public API used by server.py
# ----------------------------

def import_trp_file(trp_path: str, db_path: Optional[str] = None, upload_dir: Optional[str] = None) -> Dict[str, Any]:
    """
    Decode TRP and store in memory.

    db_path is ignored (kept for compatibility with previous sqlite/turso variants).
    """
    global _NEXT_ID

    t0 = time.time()
    run_id = _NEXT_ID
    _NEXT_ID += 1

    filename = os.path.basename(trp_path)

    print(f"[TRP_IMPORT] ENTER {trp_path}")
    extract_dir = tempfile.mkdtemp(prefix="trp_extract_")
    try:
        print(f"[TRP_IMPORT] extracting -> {extract_dir}")
        with zipfile.ZipFile(trp_path, "r") as zf:
            zf.extractall(extract_dir)

        extracted_root = extract_dir  # decoder expects extracted root dir

        # CDF declarations/lookups
        decls, unknown_decl_records = parse_declarations_cdf(os.path.join(extracted_root, "trp/providers/sp1/cdf/declarations.cdf"))
        lookups = parse_lookup_tables_cdf(os.path.join(extracted_root, "trp/providers/sp1/cdf/lookuptables.cdf"))
        print(f"[TRP_IMPORT] parsed CDF declarations: {len(decls)}  lookups: {len(lookups)}  unknown_decl_records: {len(unknown_decl_records)}  ({time.time()-t0:.2f}s)")

        # Decode KPI samples from data.cdf (this gives the big KPI set)
        dec0 = time.time()
        decoded = decode_cdf_data_variant(extracted_root, decls, lookups, base_time_iso=None)
        kpi_samples = decoded.get("kpiSamples") or []
        events = decoded.get("events") or []
        frames = decoded.get("frames")
        print(f"[TRP_IMPORT] decoded from data.cdf kpis={len(kpi_samples)} events={len(events)} frames={frames} ({time.time()-dec0:.2f}s)")

        per0 = time.time()
        per_stats = _decode_lte_rrc_payloads_in_place(kpi_samples, events)
        print(
            "[TRP_IMPORT] PER decode "
            f"MR {per_stats.get('measurement_reports_decoded', 0)}/{per_stats.get('measurement_reports_seen', 0)} "
            f"Recfg {per_stats.get('reconfig_decoded', 0)}/{per_stats.get('reconfig_seen', 0)} "
            f"Extra {per_stats.get('rrc_extra_decoded', 0)}/{per_stats.get('rrc_extra_seen', 0)} "
            f"({time.time()-per0:.2f}s)"
        )
        sn0 = time.time()
        serving_neighbors_index = build_serving_neighbors_index(events)
        print(
            "[TRP_IMPORT] serving-neighbor index "
            f"built warnings={len(serving_neighbors_index.warnings)} ({time.time()-sn0:.2f}s)"
        )

        sidebar_info = _extract_sidebar_info(kpi_samples, events)
        l1l2_scheduler_index = build_l1l2_scheduler_index(kpi_samples, events)

        # Track points
        tr0 = time.time()
        track_path = os.path.join(extracted_root, "trp/positions/wptrack.xml")
        track_points = []
        if os.path.exists(track_path):
            track_points = parse_track_xml(track_path) or []
        print(f"[TRP_IMPORT] parsed track_points={len(track_points)} ({time.time()-tr0:.2f}s)")

        # Catalog + sidebar
        signals, kpis = _build_catalog(kpi_samples, decls)
        sidebar_groups = _build_sidebar_groups(kpis)

        run = {
            "id": run_id,
            "filename": filename,
            "imported_at": _now_iso(),
            "start_time": decoded.get("start_time") or "",
            "end_time": decoded.get("end_time") or "",
            "metadata": {
                "decoded_kpis": len(kpi_samples),
                "decoded_events": len(events),
                "decoded_frames": frames,
                "track_points": len(track_points),
                "per_decode": per_stats,
                "serving_neighbors_index_warnings": len(serving_neighbors_index.warnings),
                "sidebar_info_fields": sorted(list(sidebar_info.keys())),
                "l1l2_fields_available": sorted(list((l1l2_scheduler_index.get("fields") or {}).keys())),
            },
        }

        # Store
        _RUNS[run_id] = {
            "run": run,
            "kpi_samples": kpi_samples,
            "events": events,
            "track_points": track_points,
            "catalog": {
                "signals": signals,
                "kpis": kpis,
                "events": [],  # event names can be filled when you decode them
            },
            "sidebar": {
                "groups": sidebar_groups,
                "info": sidebar_info,
            },
            "serving_neighbors_index": serving_neighbors_index,
            "l1l2_scheduler_index": l1l2_scheduler_index,
        }

        return {
            "runId": run_id,
            "kpi_count": len(kpi_samples),
            "event_count": len(events),
            "track_count": len(track_points),
            "message": "Decode completed (in-memory data.cdf)",
        }
    finally:
        # Keep extracted dir? no, remove to avoid /var/folders bloat
        try:
            import shutil
            shutil.rmtree(extract_dir, ignore_errors=True)
        except Exception:
            pass


def list_runs(db_path: Optional[str] = None) -> List[Dict[str, Any]]:
    return [v["run"] for k, v in sorted(_RUNS.items(), key=lambda kv: kv[0])]


def fetch_run_detail(db_path: Optional[str], run_id: int) -> Tuple[Dict[str, Any], List[Dict[str, Any]], List[Dict[str, Any]]]:
    rid = int(run_id)
    if rid not in _RUNS:
        raise KeyError("Run not found")
    entry = _RUNS[rid]
    run = entry["run"]
    track = entry.get("track_points") or []
    events = entry.get("events") or []
    return run, track, events


def fetch_run_catalog(db_path: Optional[str], run_id: int) -> Dict[str, Any]:
    rid = int(run_id)
    if rid not in _RUNS:
        return {"status": "error", "message": "Run not found"}
    return _build_catalog_payload(_RUNS[rid])


def fetch_run_sidebar(db_path: Optional[str], run_id: int) -> Dict[str, Any]:
    rid = int(run_id)
    if rid not in _RUNS:
        return {"status": "error", "message": "Run not found"}
    entry = _RUNS[rid]
    sidebar = entry.get("sidebar") or {}
    info = sidebar.get("info")
    refresh_info = (not isinstance(info, dict) or not info)
    if isinstance(info, dict) and info:
        ca_txt = str(info.get("ca_capability") or "").lower()
        has_combo_txt = "band combos:" in ca_txt
        has_combo_list = isinstance(info.get("ca_band_combinations"), list) and len(info.get("ca_band_combinations") or []) > 0
        if (not has_combo_txt) and (not has_combo_list):
            refresh_info = True
    if refresh_info:
        rebuilt = _extract_sidebar_info(entry.get("kpi_samples") or [], entry.get("events") or [])
        if rebuilt:
            info = rebuilt
            sidebar["info"] = info
            entry["sidebar"] = sidebar

    catalog = _build_catalog_payload(entry)
    metrics_flat = catalog.get("metricsFlat") or []
    neighbor_metrics = _extract_neighbor_metrics_from_samples(entry.get("kpi_samples") or [])
    kpis = []
    for m in metrics_flat:
        stats = m.get("stats") or {}
        sample_count = int(stats.get("sample_count") or 0)
        kpis.append({
            "kpi_type": "metric",
            "name": m.get("name"),
            "sample_count": sample_count,
            "avg": None,
            "min": None,
            "max": None,
            "first_time": None,
            "last_time": None,
        })
    return {
        "status": "success",
        "kpis": kpis,
        "info": info or {},
        "groups": (sidebar.get("groups") or []),
        # Neighbor metrics discovered directly from decoded TRP samples
        "neighbors": neighbor_metrics,
    }


def fetch_run_signals(db_path: Optional[str], run_id: int) -> Dict[str, Any]:
    rid = int(run_id)
    if rid not in _RUNS:
        return {"status": "error", "message": "Run not found"}
    return {"status": "success", "signals": _RUNS[rid]["catalog"].get("signals", [])}


def fetch_run_track(db_path: Optional[str], run_id: int) -> Dict[str, Any]:
    rid = int(run_id)
    if rid not in _RUNS:
        return {"status": "error", "message": "Run not found"}
    return {"status": "success", "track": _RUNS[rid].get("track_points", [])}


def fetch_run_events(db_path: Optional[str], run_id: int) -> Dict[str, Any]:
    rid = int(run_id)
    if rid not in _RUNS:
        return {"status": "error", "message": "Run not found"}
    return {"status": "success", "events": _RUNS[rid].get("events", [])}


def fetch_timeseries_by_signal(
    db_path: Optional[str],
    run_id: int,
    signal: str,
    max_points: int = 50000,
    idx: Optional[int] = None,
) -> Dict[str, Any]:
    rid = int(run_id)
    if rid not in _RUNS:
        return {"status": "error", "message": "Run not found"}
    signal = (signal or "").strip()
    if not signal:
        return {"status": "error", "message": "Missing signal"}

    samples = _RUNS[rid].get("kpi_samples", [])
    out: List[Dict[str, Any]] = []
    for s in samples:
        if s.get("name") != signal:
            continue
        sample_idx = _extract_neighbor_sample_index(s or {})
        if idx is not None and sample_idx != idx:
            continue
        t = s.get("time") or s.get("t") or s.get("timestamp") or ""
        val = s.get("value_num")
        val_str = s.get("value_str")
        dtype = s.get("dtype") or ("str" if val_str is not None else "num")
        unit = s.get("unit") or ""
        if val is None and val_str is None:
            continue
        if dtype != "str":
            v = _safe_float(val)
            if v is None:
                continue
            out.append({"t": t, "value": v, "unit": unit, "idx": sample_idx})
        else:
            out.append({"t": t, "value_str": str(val_str), "unit": unit, "idx": sample_idx})

    out = _downsample(out, max_points)
    return {"status": "success", "series": out}


def fetch_kpi_series(
    db_path: Optional[str],
    run_id: int,
    name: str,
    max_points: int = 50000,
    idx: Optional[int] = None,
) -> Dict[str, Any]:
    # Backward-compatible route payload used by trp_import_ui.js
    series = fetch_timeseries_by_signal(db_path, run_id, name, max_points=max_points, idx=idx)
    if series.get("status") != "success":
        return series
    rows = []
    for r in series.get("series") or []:
        rows.append({
            "time": r.get("t"),
            "value_num": r.get("value"),
            "value_str": r.get("value_str"),
            "idx": r.get("idx"),
            "index": r.get("idx"),
        })
    return {"status": "success", "series": rows}


def fetch_samples_in_window(
    db_path: Optional[str],
    run_id: int,
    metric_name: str,
    center_iso: str,
    tol_ms: int,
) -> List[Dict[str, Any]]:
    rid = int(run_id)
    if rid not in _RUNS:
        return []
    center_ms = _to_epoch_ms(center_iso)
    if center_ms is None:
        return []
    tol = int(max(1, _safe_int(tol_ms) or 0))
    metric = str(metric_name or "").strip()
    if not metric:
        return []

    out: List[Dict[str, Any]] = []
    for s in _RUNS[rid].get("kpi_samples") or []:
        if str((s or {}).get("name") or "") != metric:
            continue
        t_ms = _sample_time_ms(s or {})
        if t_ms is None:
            continue
        if abs(t_ms - center_ms) > tol:
            continue
        out.append({
            "time": (s or {}).get("time") or _epoch_ms_to_iso(t_ms),
            "t_ms": t_ms,
            "name": metric,
            "value_num": _safe_float((s or {}).get("value_num")),
            "value_str": (s or {}).get("value_str"),
            "dtype": (s or {}).get("dtype") or "num",
            "unit": (s or {}).get("unit") or "",
            "idx": _extract_neighbor_sample_index(s or {}),
        })

    out.sort(key=lambda r: (_safe_int(r.get("t_ms")) or 0, _safe_int(r.get("idx")) or 0))
    return out


def bucket_by_time(samples: List[Dict[str, Any]], bucket_ms: int = 80) -> List[Dict[str, Any]]:
    rows = [r for r in (samples or []) if _safe_int((r or {}).get("t_ms")) is not None]
    if not rows:
        return []
    rows.sort(key=lambda r: _safe_int((r or {}).get("t_ms")) or 0)
    span = max(1, _safe_int(bucket_ms) or 80)

    buckets: List[Dict[str, Any]] = []
    anchor = _safe_int(rows[0].get("t_ms")) or 0
    current: List[Dict[str, Any]] = []
    for r in rows:
        t = _safe_int(r.get("t_ms")) or 0
        if current and (t - anchor) > span:
            t_list = [_safe_int(x.get("t_ms")) for x in current if _safe_int(x.get("t_ms")) is not None]
            center = int(round(sum(t_list) / max(1, len(t_list)))) if t_list else anchor
            current.sort(key=lambda x: _safe_int(x.get("t_ms")) or 0)
            buckets.append({
                "t_anchor_ms": anchor,
                "t_center_ms": center,
                "items": current,
            })
            anchor = t
            current = [r]
        else:
            if not current:
                anchor = t
            current.append(r)

    if current:
        t_list = [_safe_int(x.get("t_ms")) for x in current if _safe_int(x.get("t_ms")) is not None]
        center = int(round(sum(t_list) / max(1, len(t_list)))) if t_list else anchor
        current.sort(key=lambda x: _safe_int(x.get("t_ms")) or 0)
        buckets.append({
            "t_anchor_ms": anchor,
            "t_center_ms": center,
            "items": current,
        })

    return buckets


def _nearest_bucket(buckets: List[Dict[str, Any]], target_center_ms: int, tol_ms: int) -> Optional[Dict[str, Any]]:
    best = None
    best_dt = None
    for b in buckets or []:
        c = _safe_int((b or {}).get("t_center_ms"))
        if c is None:
            continue
        dt = abs(c - target_center_ms)
        if dt > tol_ms:
            continue
        if best is None or dt < best_dt:
            best = b
            best_dt = dt
    return best


def _items_to_numeric(items: List[Dict[str, Any]]) -> List[float]:
    out: List[float] = []
    for r in items or []:
        v = _safe_float((r or {}).get("value_num"))
        if v is None:
            continue
        out.append(v)
    return out


def _best_row_by_signal(rows: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    def score(row: Dict[str, Any]) -> Tuple[int, float, float, int]:
        has_rsrp = 1 if _safe_float(row.get("rsrp")) is not None else 0
        rsrp = _safe_float(row.get("rsrp"))
        cinr = _safe_float(row.get("cinr"))
        t_ms = _safe_int(_to_epoch_ms(row.get("sourceBucket"))) or 0
        return (
            has_rsrp,
            rsrp if rsrp is not None else float("-inf"),
            cinr if cinr is not None else float("-inf"),
            -t_ms,
        )

    if not rows:
        return None
    return max(rows, key=score)


def _get_serving_neighbors_index(entry: Dict[str, Any]):
    idx = entry.get("serving_neighbors_index")
    if idx is not None:
        return idx
    try:
        idx = build_serving_neighbors_index(entry.get("events") or [])
    except Exception:
        idx = None
    entry["serving_neighbors_index"] = idx
    return idx


def build_serving_at_time(
    db_path: Optional[str],
    run_id: int,
    center_iso: str,
    tol_ms: int = 200,
) -> Dict[str, Any]:
    rid = int(run_id)
    if rid not in _RUNS:
        return {}
    entry = _RUNS[rid]
    center_ms = _to_epoch_ms(center_iso)
    if center_ms is None:
        return {}
    tol = int(max(1, _safe_int(tol_ms) or 200))

    def pick_value(candidates: List[str], numeric: bool = True) -> Tuple[Optional[Any], Optional[str], Optional[str]]:
        metric_name = _pick_best_metric_name(entry, candidates)
        if not metric_name:
            return None, None, None
        rows = fetch_samples_in_window(db_path, rid, metric_name, center_iso, tol)
        if not rows:
            return None, metric_name, None
        best = None
        best_dt = None
        for r in rows:
            t_ms = _safe_int((r or {}).get("t_ms"))
            if t_ms is None:
                continue
            dt = abs(t_ms - center_ms)
            val = _safe_float(r.get("value_num")) if numeric else (r.get("value_str") or r.get("value_num"))
            if val is None:
                continue
            if best is None or dt < best_dt:
                best = val
                best_dt = dt
        source_iso = rows[0].get("time")
        return best, metric_name, source_iso

    pci, pci_metric, _ = pick_value(["Radio.Lte.ServingCell[8].Pci", "Radio.Lte.ServingCellTotal.Pci"])
    rsrp, rsrp_metric, _ = pick_value(["Radio.Lte.ServingCell[8].Rsrp", "Radio.Lte.ServingCellTotal.Rsrp"])
    rsrq, rsrq_metric, _ = pick_value(["Radio.Lte.ServingCell[8].Rsrq", "Radio.Lte.ServingCellTotal.Rsrq"])
    sinr, sinr_metric, _ = pick_value([
        "Radio.Lte.ServingCell[8].RsSinr",
        "Radio.Lte.ServingCell[8].Sinr",
        "Radio.Lte.ServingCell[8].Cinr",
        "Radio.Lte.ServingCellTotal.RsSinr",
        "Radio.Lte.ServingCellTotal.Sinr",
        "Radio.Lte.ServingCellTotal.Cinr",
    ])
    earfcn, earfcn_metric, _ = pick_value([
        "Radio.Lte.ServingCell[8].Downlink.Earfcn",
        "Radio.Lte.ServingCellTotal.Downlink.Earfcn",
        "Radio.Lte.ServingCell[8].Earfcn",
    ])
    eci, eci_metric, _ = pick_value([
        "Radio.Lte.ServingCell[8].CellIdentity.Complete",
        "Radio.Lte.ServingCellTotal.CellIdentity.Complete",
        "Radio.Lte.ServingCell[8].CellIdentity",
    ])

    eci_int = _safe_int(eci)
    enb_id = None
    cell_id = None
    enb_cell_id = None
    if eci_int is not None and eci_int > 255:
        enb_id = int(eci_int // 256)
        cell_id = int(eci_int % 256)
        enb_cell_id = f"{enb_id}-{cell_id}"

    return {
        "pci": _safe_int(pci),
        "rsrp": _safe_float(rsrp),
        "rsrq": _safe_float(rsrq),
        "sinr": _safe_float(sinr),
        "earfcn": _safe_int(earfcn),
        "cellIdentityComplete": eci_int,
        "eNodeBId": enb_id,
        "cellId": cell_id,
        "eNodeBCellId": enb_cell_id,
        "sourceMetrics": {
            "pci": pci_metric,
            "rsrp": rsrp_metric,
            "rsrq": rsrq_metric,
            "sinr": sinr_metric,
            "earfcn": earfcn_metric,
            "cellIdentityComplete": eci_metric,
        },
    }


def build_neighbors_at_time(
    db_path: Optional[str],
    run_id: int,
    center_iso: str,
    tol_ms: int = 200,
    bucket_ms: int = 80,
) -> Dict[str, Any]:
    rid = int(run_id)
    if rid not in _RUNS:
        return {
            "time": center_iso,
            "tolMs": int(tol_ms),
            "bucketMs": int(bucket_ms),
            "neighbors": [],
            "debug": {"message": "Run not found"},
        }

    entry = _RUNS[rid]
    tol = int(max(20, _safe_int(tol_ms) or 200))
    align = int(max(20, _safe_int(bucket_ms) or 80))

    pci_s = fetch_samples_in_window(db_path, rid, LTE_NEIGHBOR_PCI_METRIC, center_iso, tol)
    rsrp_s = fetch_samples_in_window(db_path, rid, LTE_NEIGHBOR_RSRP_METRIC, center_iso, tol)
    rsrq_s = fetch_samples_in_window(db_path, rid, LTE_NEIGHBOR_RSRQ_METRIC, center_iso, tol)

    cinr_metric = _pick_best_metric_name(entry, LTE_NEIGHBOR_CINR_METRICS) or LTE_NEIGHBOR_CINR_METRICS[0]
    earfcn_metric = _pick_best_metric_name(entry, LTE_NEIGHBOR_EARFCN_METRICS) or LTE_NEIGHBOR_EARFCN_METRICS[0]
    cinr_s = fetch_samples_in_window(db_path, rid, cinr_metric, center_iso, tol)
    earfcn_s = fetch_samples_in_window(db_path, rid, earfcn_metric, center_iso, tol)

    pci_b = bucket_by_time(pci_s, align)
    rsrp_b = bucket_by_time(rsrp_s, align)
    rsrq_b = bucket_by_time(rsrq_s, align)
    cinr_b = bucket_by_time(cinr_s, align)
    earfcn_b = bucket_by_time(earfcn_s, align)

    scale_div = _normalize_neighbor_earfcn_div(entry)
    paired_rows: List[Dict[str, Any]] = []
    for pb in pci_b:
        center_ms = _safe_int((pb or {}).get("t_center_ms"))
        if center_ms is None:
            continue
        p_items = _items_to_numeric((pb or {}).get("items") or [])
        if not p_items:
            continue

        rb = _nearest_bucket(rsrp_b, center_ms, align)
        qb = _nearest_bucket(rsrq_b, center_ms, align)
        cb = _nearest_bucket(cinr_b, center_ms, align)
        eb = _nearest_bucket(earfcn_b, center_ms, align)

        rsrps = _items_to_numeric((rb or {}).get("items") or [])
        rsrqs = _items_to_numeric((qb or {}).get("items") or [])
        cinrs = _items_to_numeric((cb or {}).get("items") or [])
        earfcns_raw = _items_to_numeric((eb or {}).get("items") or [])

        for i, pci_raw in enumerate(p_items):
            pci = _safe_int(round(pci_raw))
            if pci is None:
                continue
            earfcn_raw = _safe_int(round(earfcns_raw[i])) if i < len(earfcns_raw) else None
            if earfcn_raw is not None and scale_div == 2 and earfcn_raw % 2 == 0:
                earfcn_raw = earfcn_raw // 2
            paired_rows.append({
                "pci": pci,
                "rsrp": _safe_float(rsrps[i]) if i < len(rsrps) else None,
                "rsrq": _safe_float(rsrqs[i]) if i < len(rsrqs) else None,
                "cinr": _safe_float(cinrs[i]) if i < len(cinrs) else None,
                "earfcn": earfcn_raw,
                "sourceBucket": _epoch_ms_to_iso(center_ms),
                "pair_index": i,
            })

    by_pci: Dict[int, List[Dict[str, Any]]] = {}
    for row in paired_rows:
        pci = _safe_int(row.get("pci"))
        if pci is None:
            continue
        by_pci.setdefault(pci, []).append(row)

    stable_rows: List[Dict[str, Any]] = []
    for pci, rows in by_pci.items():
        best = _best_row_by_signal(rows)
        if not best:
            continue
        stable_rows.append(best)

    stable_rows.sort(key=lambda r: (
        -(_safe_float(r.get("rsrp")) if _safe_float(r.get("rsrp")) is not None else -9999),
        -(_safe_float(r.get("cinr")) if _safe_float(r.get("cinr")) is not None else -9999),
        _safe_int(r.get("pci")) if _safe_int(r.get("pci")) is not None else 10**9,
    ))

    neighbors: List[Dict[str, Any]] = []
    for i, row in enumerate(stable_rows, start=1):
        neighbors.append({
            "label": f"N{i}",
            "pci": _safe_int(row.get("pci")),
            "rsrp": _safe_float(row.get("rsrp")),
            "rsrq": _safe_float(row.get("rsrq")),
            "cinr": _safe_float(row.get("cinr")),
            "earfcn": _safe_int(row.get("earfcn")),
            "sourceBucket": row.get("sourceBucket"),
            "pair_index": _safe_int(row.get("pair_index")),
        })

    distinct_pci = sorted({int(n["pci"]) for n in neighbors if _safe_int(n.get("pci")) is not None})
    return {
        "time": center_iso,
        "tolMs": tol,
        "bucketMs": align,
        "neighbors": neighbors,
        "debug": {
            "pciSamples": len(pci_s),
            "rsrpSamples": len(rsrp_s),
            "rsrqSamples": len(rsrq_s),
            "cinrSamples": len(cinr_s),
            "earfcnSamples": len(earfcn_s),
            "pciBuckets": len(pci_b),
            "distinctPci": len(distinct_pci),
            "distinctPciList": distinct_pci,
            "pairedRows": len(paired_rows),
            "earfcnScaleDiv": scale_div,
            "cinrMetric": cinr_metric,
            "earfcnMetric": earfcn_metric,
        },
    }


def fetch_neighbors_at_time(
    db_path: Optional[str],
    run_id: int,
    center_iso: str,
    tol_ms: int = 200,
    bucket_ms: int = 80,
) -> Dict[str, Any]:
    rid = int(run_id)
    if rid not in _RUNS:
        return {"status": "error", "message": "Run not found"}
    if _to_epoch_ms(center_iso) is None:
        return {"status": "error", "message": "Invalid time"}

    entry = _RUNS[rid]
    tol_i = int(max(20, _safe_int(tol_ms) or 200))
    bucket_i = int(max(20, _safe_int(bucket_ms) or 80))
    earfcn_scale_div = _normalize_neighbor_earfcn_div(entry)

    estimated_payload = build_neighbors_at_time(db_path, rid, center_iso, tol_ms=tol_i, bucket_ms=bucket_i)
    metric_serving = build_serving_at_time(db_path, rid, center_iso, tol_ms=tol_i)

    decoded_payload: Dict[str, Any] = {}
    sn_index = _get_serving_neighbors_index(entry)
    if sn_index is not None:
        try:
            decoded_payload = sn_index.getServingNeighborsAt(center_iso, windowMs=max(2000, tol_i * 10)) or {}
        except Exception:
            decoded_payload = {}

    decoded_serving = decoded_payload.get("serving") if isinstance(decoded_payload, dict) else None
    serving = dict(metric_serving or {})
    if isinstance(decoded_serving, dict):
        serving["pci"] = serving.get("pci") if serving.get("pci") is not None else _safe_int(decoded_serving.get("pci"))
        serving["earfcn"] = serving.get("earfcn") if serving.get("earfcn") is not None else _safe_int(decoded_serving.get("earfcn"))
        serving["rsrp"] = serving.get("rsrp") if serving.get("rsrp") is not None else _safe_float(decoded_serving.get("rsrp_dbm"))
        serving["rsrq"] = serving.get("rsrq") if serving.get("rsrq") is not None else _safe_float(decoded_serving.get("rsrq_db"))
        if serving.get("sourceMetrics") is None:
            serving["sourceMetrics"] = {}
        serving["sourceKind"] = "metrics+decoded"
        serving["decodedSource"] = decoded_serving.get("source")
        serving["decodedTime"] = decoded_serving.get("time")

    estimated_rows = []
    for row in (estimated_payload.get("neighbors") or []):
        estimated_rows.append({
            "rat": "LTE",
            "pci": _safe_int(row.get("pci")),
            "earfcn": _safe_int(row.get("earfcn")),
            "rsrp": _safe_float(row.get("rsrp")),
            "rsrq": _safe_float(row.get("rsrq")),
            "cinr": _safe_float(row.get("cinr")),
            "neighbor_type": "unknown",
            "source_kind": "estimated",
            "source_note": "Neighbor[64] bucket+order pairing",
            "sourceBucket": row.get("sourceBucket"),
        })

    best_est_by_pci: Dict[int, Dict[str, Any]] = {}
    for r in estimated_rows:
        pci = _safe_int(r.get("pci"))
        if pci is None:
            continue
        prev = best_est_by_pci.get(pci)
        if prev is None:
            best_est_by_pci[pci] = r
            continue
        a = _safe_float(prev.get("rsrp"))
        b = _safe_float(r.get("rsrp"))
        if b is not None and (a is None or b > a):
            best_est_by_pci[pci] = r

    decoded_rows = []
    for row in (decoded_payload.get("neighbors_merged") or []):
        if not isinstance(row, dict):
            continue
        rat = str(row.get("rat") or "LTE").upper()
        source_raw = str(row.get("source") or "").upper()
        source_kind = "decoded"
        if source_raw == "CONFIG":
            source_kind = "configured"
        pci = _safe_int(row.get("pci"))
        earfcn = _safe_int(row.get("earfcn"))
        if rat == "LTE" and earfcn is not None and earfcn_scale_div == 2 and earfcn % 2 == 0:
            earfcn = earfcn // 2
        if rat == "LTE" and earfcn is None and pci is not None:
            est = best_est_by_pci.get(pci)
            if isinstance(est, dict):
                earfcn = _safe_int(est.get("earfcn"))
        decoded_rows.append({
            "rat": rat,
            "pci": pci,
            "psc": _safe_int(row.get("psc")),
            "bsic": _normalize_bsic(row.get("bsic")),
            "earfcn": earfcn,
            "uarfcn": _safe_int(row.get("uarfcn")),
            "arfcn": _safe_int(row.get("arfcn")),
            "rsrp": _safe_float(row.get("rsrp_dbm") if row.get("rsrp_dbm") is not None else row.get("rsrp")),
            "rsrq": _safe_float(row.get("rsrq_db") if row.get("rsrq_db") is not None else row.get("rsrq")),
            "rscp": _safe_float(row.get("rscp_dbm") if row.get("rscp_dbm") is not None else row.get("rscp")),
            "ecno": _safe_float(row.get("ecno_db") if row.get("ecno_db") is not None else row.get("ecno")),
            "rxlev": _safe_float(row.get("rxlev_dbm") if row.get("rxlev_dbm") is not None else row.get("rxlev")),
            "rxqual": _safe_float(row.get("rxqual")),
            "cinr": _safe_float(row.get("sinr") if row.get("sinr") is not None else row.get("cinr")),
            "neighbor_type": row.get("type") or ("inter-RAT" if rat != "LTE" else "unknown"),
            "source_kind": source_kind,
            "source_note": f"PER {source_raw or 'MR'}",
            "measured_time": row.get("measured_time"),
            "delta_ms": _safe_int(row.get("delta_ms")),
        })

    def row_priority(r: Dict[str, Any]) -> Tuple[int, int]:
        src = str(r.get("source_kind") or "").lower()
        src_w = 1
        if src == "decoded":
            src_w = 4
        elif src == "configured":
            src_w = 3
        elif src == "inferred":
            src_w = 2
        quality = 0
        if _safe_float(r.get("rsrp")) is not None:
            quality += 3
        if _safe_float(r.get("rsrq")) is not None:
            quality += 2
        if _safe_float(r.get("rscp")) is not None:
            quality += 2
        if _safe_float(r.get("ecno")) is not None:
            quality += 1
        if _safe_float(r.get("rxlev")) is not None:
            quality += 2
        if _safe_float(r.get("rxqual")) is not None:
            quality += 1
        if _safe_float(r.get("cinr")) is not None:
            quality += 1
        return src_w, quality

    def row_key(r: Dict[str, Any]) -> str:
        rat = str(r.get("rat") or "LTE").upper()
        if rat == "LTE":
            pci = _safe_int(r.get("pci"))
            earfcn = _safe_int(r.get("earfcn"))
            return f"LTE:{earfcn if earfcn is not None else '-'}:{pci if pci is not None else '-'}"
        if rat == "UTRA":
            return f"UTRA:{_safe_int(r.get('uarfcn'))}:{_safe_int(r.get('psc'))}"
        if rat == "GERAN":
            return f"GERAN:{_safe_int(r.get('arfcn'))}:{_normalize_bsic(r.get('bsic'))}"
        return f"{rat}:{_safe_int(r.get('earfcn'))}:{_safe_int(r.get('pci'))}"

    merged_by_key: Dict[str, Dict[str, Any]] = {}
    for row in estimated_rows + decoded_rows:
        k = row_key(row)
        prev = merged_by_key.get(k)
        if prev is None:
            merged_by_key[k] = dict(row)
            continue
        if row_priority(row) > row_priority(prev):
            merged = dict(prev)
            merged.update(row)
            merged_by_key[k] = merged
            continue
        merged = dict(prev)
        for f in ("earfcn", "uarfcn", "arfcn", "psc", "bsic", "rsrp", "rsrq", "rscp", "ecno", "rxlev", "rxqual", "cinr"):
            if merged.get(f) is None and row.get(f) is not None:
                merged[f] = row.get(f)
        merged_by_key[k] = merged

    neighbors_out = []
    serving_pci = _safe_int(serving.get("pci"))
    serving_earfcn = _safe_int(serving.get("earfcn"))
    for row in merged_by_key.values():
        rat = str(row.get("rat") or "LTE").upper()
        pci = _safe_int(row.get("pci"))
        earfcn = _safe_int(row.get("earfcn"))
        if rat == "LTE" and pci is None:
            continue
        if rat == "LTE" and serving_pci is not None and pci == serving_pci:
            if serving_earfcn is None or earfcn is None or earfcn == serving_earfcn:
                continue
        neighbors_out.append(row)

    def row_signal(r: Dict[str, Any]) -> float:
        for key in ("rsrp", "rscp", "rxlev", "cinr", "rsrq", "ecno", "rxqual"):
            val = _safe_float(r.get(key))
            if val is not None:
                return float(val)
        return -9999.0

    neighbors_out.sort(key=lambda r: (
        -row_signal(r),
        -row_priority(r)[0],
        _safe_int(r.get("pci")) if _safe_int(r.get("pci")) is not None else 10**9,
    ))
    for i, row in enumerate(neighbors_out, start=1):
        row["label"] = f"N{i}"

    decoded_debug = decoded_payload.get("debug") if isinstance(decoded_payload, dict) else {}
    if not isinstance(decoded_debug, dict):
        decoded_debug = {}
    debug = dict(estimated_payload.get("debug") or {})
    debug.update({
        "decodedMeasuredCount": len(decoded_payload.get("neighbors_measured") or []) if isinstance(decoded_payload, dict) else 0,
        "decodedNearestCount": len(decoded_payload.get("neighbors_measured_nearest") or []) if isinstance(decoded_payload, dict) else 0,
        "decodedConfiguredCount": len(decoded_payload.get("neighbors_configured") or []) if isinstance(decoded_payload, dict) else 0,
        "decodedMergedCount": len(decoded_rows),
        "decodedWarnings": decoded_debug.get("warnings") if isinstance(decoded_debug, dict) else [],
        "decodedMeasIdUsed": decoded_debug.get("measIdUsed") if isinstance(decoded_debug, dict) else None,
        "decodedMeasObjectIdUsed": decoded_debug.get("measObjectIdUsed") if isinstance(decoded_debug, dict) else None,
        "decodedReportConfigIdUsed": decoded_debug.get("reportConfigIdUsed") if isinstance(decoded_debug, dict) else None,
    })

    return {
        "status": "success",
        "time": center_iso,
        "tolMs": tol_i,
        "bucketMs": bucket_i,
        "serving": serving,
        "neighbors": neighbors_out,
        "debug": debug,
    }

"""
LTE RRC PER decoder helpers (pycrate-backed).

This module decodes raw LTE RRC payload bytes for:
- MeasurementReport (UL DCCH)
- RRCConnectionReconfiguration (DL DCCH)
- RRCConnectionReconfigurationComplete (UL DCCH)
- RRCConnectionRelease (DL DCCH)
- RRCConnectionRequest (UL CCCH)
- RRCConnectionSetupComplete (UL DCCH)
- SecurityModeCommand / SecurityModeComplete
- UECapabilityInformation
- UEInformationRequest / UEInformationResponse
- RRCConnectionReestablishment Request / Complete / Reject

and extracts normalized structures useful for TRP analytics.
"""

from __future__ import annotations

import json
import io
import contextlib
import re
from typing import Any, Dict, List, Optional

try:
    import pycrate_asn1dir.RRCLTE as RRCLTE  # type: ignore
    _PYCRATE_READY = True
    _PYCRATE_IMPORT_ERROR = ""
except Exception as exc:  # pragma: no cover - optional dependency path
    RRCLTE = None  # type: ignore
    _PYCRATE_READY = False
    _PYCRATE_IMPORT_ERROR = str(exc)


def per_decoder_status() -> Dict[str, Any]:
    return {
        "available": bool(_PYCRATE_READY),
        "backend": "pycrate_asn1dir.RRCLTE",
        "error": _PYCRATE_IMPORT_ERROR or None,
    }


def _safe_int(v: Any) -> Optional[int]:
    try:
        if v is None or v == "":
            return None
        if isinstance(v, bool):
            return int(v)
        return int(v)
    except Exception:
        try:
            return int(float(v))
        except Exception:
            return None


def _find_first_key(node: Any, key: str) -> Any:
    if isinstance(node, dict):
        if key in node:
            return node.get(key)
        for _, v in node.items():
            out = _find_first_key(v, key)
            if out is not None:
                return out
    elif isinstance(node, list):
        for v in node:
            out = _find_first_key(v, key)
            if out is not None:
                return out
    return None


def _find_first_map_with_any_key(node: Any, keys: List[str]) -> Optional[Dict[str, Any]]:
    if isinstance(node, dict):
        if any(k in node for k in keys):
            return node
        for _, v in node.items():
            out = _find_first_map_with_any_key(v, keys)
            if out is not None:
                return out
    elif isinstance(node, list):
        for v in node:
            out = _find_first_map_with_any_key(v, keys)
            if out is not None:
                return out
    return None


def _extract_list_by_key_substring(container: Any, token: str) -> List[Any]:
    if not isinstance(container, dict):
        return []
    for k, v in container.items():
        if token in str(k):
            return v if isinstance(v, list) else []
    return []


def _json_contains_any(node: Any, tokens: List[str]) -> bool:
    try:
        txt = json.dumps(node, ensure_ascii=True).lower()
    except Exception:
        return False
    return any(str(t or "").lower() in txt for t in (tokens or []))


def _rsrp_idx_to_dbm(idx: Optional[int]) -> Optional[float]:
    if idx is None:
        return None
    return float(-140 + idx)


def _rsrq_idx_to_db(idx: Optional[int]) -> Optional[float]:
    if idx is None:
        return None
    return float(-19.5 + 0.5 * idx)


def _extract_utra_psc(value: Any) -> Optional[int]:
    """
    UTRA physCellId can be encoded as:
    - integer
    - {"fdd": <psc>}
    - {"tdd": <cellParamId>}
    """
    direct = _safe_int(value)
    if direct is not None:
        return direct
    if isinstance(value, dict):
        for k in ("fdd", "tdd", "psc", "physCellId"):
            v = _safe_int(value.get(k))
            if v is not None:
                return v
    return None


def _safe_float(v: Any) -> Optional[float]:
    try:
        if v is None or v == "":
            return None
        if isinstance(v, bool):
            return float(int(v))
        return float(v)
    except Exception:
        return None


def _enum_db_to_float(value: Any) -> Optional[float]:
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value)
    txt = str(value).strip()
    if not txt:
        return None
    m = re.match(r"^dB\s*([+-]?\d+(?:\.\d+)?)$", txt, re.IGNORECASE)
    if m:
        return float(m.group(1))
    m = re.match(r"^([+-]?\d+(?:\.\d+)?)\s*dB$", txt, re.IGNORECASE)
    if m:
        return float(m.group(1))
    return _safe_float(txt)


def _enum_time_ms(value: Any) -> Optional[int]:
    if value is None or value == "":
        return None
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, (int, float)):
        return int(value)
    txt = str(value).strip()
    if not txt:
        return None
    m = re.match(r"^ms\s*(\d+)$", txt, re.IGNORECASE)
    if m:
        return int(m.group(1))
    return _safe_int(txt)


def _normalize_trigger_quantity(value: Any) -> Optional[str]:
    if value is None or value == "":
        return None
    txt = str(value).strip().upper()
    return txt or None


def _parse_meas_object_row(row: Any) -> Optional[Dict[str, Any]]:
    if not isinstance(row, dict):
        return None
    meas_object_id = _safe_int(row.get("measObjectId"))
    meas_object = row.get("measObject") if isinstance(row.get("measObject"), dict) else {}
    if not isinstance(meas_object, dict) or meas_object_id is None:
        return None

    eutra = meas_object.get("measObjectEUTRA") if isinstance(meas_object.get("measObjectEUTRA"), dict) else None
    utra = meas_object.get("measObjectUTRA") if isinstance(meas_object.get("measObjectUTRA"), dict) else None
    geran = meas_object.get("measObjectGERAN") if isinstance(meas_object.get("measObjectGERAN"), dict) else None

    if eutra is not None:
        cells: List[Dict[str, Any]] = []
        for cell in eutra.get("cellsToAddModList") or []:
            if not isinstance(cell, dict):
                continue
            cells.append({
                "cellIndex": _safe_int(cell.get("cellIndex")),
                "physCellId": _safe_int(cell.get("physCellId")),
                "cellIndividualOffsetDb": _enum_db_to_float(cell.get("cellIndividualOffset")),
            })
        return {
            "measObjectId": meas_object_id,
            "rat": "LTE",
            "carrierFreq": _safe_int(eutra.get("carrierFreq")),
            "offsetFreqDb": _enum_db_to_float(eutra.get("offsetFreq")),
            "allowedMeasBandwidth": eutra.get("allowedMeasBandwidth"),
            "presenceAntennaPort1": eutra.get("presenceAntennaPort1"),
            "neighCellConfig": eutra.get("neighCellConfig"),
            "cells": cells,
        }
    if utra is not None:
        return {
            "measObjectId": meas_object_id,
            "rat": "UTRA",
            "carrierFreq": _safe_int(utra.get("carrierFreq")),
        }
    if geran is not None:
        return {
            "measObjectId": meas_object_id,
            "rat": "GERAN",
            "carrierFreqs": geran.get("carrierFreqs"),
        }
    return {
        "measObjectId": meas_object_id,
        "rat": "UNKNOWN",
    }


def _parse_report_config_row(row: Any) -> Optional[Dict[str, Any]]:
    if not isinstance(row, dict):
        return None
    report_config_id = _safe_int(row.get("reportConfigId"))
    report_config = row.get("reportConfig") if isinstance(row.get("reportConfig"), dict) else {}
    eutra = report_config.get("reportConfigEUTRA") if isinstance(report_config.get("reportConfigEUTRA"), dict) else None
    if report_config_id is None or eutra is None:
        return None

    out: Dict[str, Any] = {
        "reportConfigId": report_config_id,
        "maxReportCells": _safe_int(eutra.get("maxReportCells")),
        "reportAmount": eutra.get("reportAmount"),
        "reportInterval": eutra.get("reportInterval"),
        "reportQuantity": eutra.get("reportQuantity"),
        "triggerQuantity": _normalize_trigger_quantity(eutra.get("triggerQuantity")),
        "purpose": None,
        "eventType": None,
        "hysteresisDb": None,
        "timeToTriggerMs": None,
        "a3OffsetDb": None,
        "a5Threshold1": None,
        "a5Threshold2": None,
        "reportOnLeave": None,
    }
    trigger_type = eutra.get("triggerType") if isinstance(eutra.get("triggerType"), dict) else {}
    if isinstance(trigger_type.get("periodical"), dict):
        out["purpose"] = "periodical"
        out["periodicalPurpose"] = trigger_type["periodical"].get("purpose")
        return out

    event = trigger_type.get("event") if isinstance(trigger_type.get("event"), dict) else None
    if not event:
        return out

    out["purpose"] = "event"
    out["hysteresisDb"] = _safe_float(event.get("hysteresis"))
    out["timeToTriggerMs"] = _enum_time_ms(event.get("timeToTrigger"))
    event_id = event.get("eventId") if isinstance(event.get("eventId"), dict) else {}

    if isinstance(event_id.get("eventA3"), dict):
        cfg = event_id["eventA3"]
        out["eventType"] = "EVENTA3"
        out["a3OffsetDb"] = _safe_float(cfg.get("a3-Offset"))
        out["reportOnLeave"] = cfg.get("reportOnLeave")
    elif isinstance(event_id.get("eventA5"), dict):
        cfg = event_id["eventA5"]
        out["eventType"] = "EVENTA5"
        out["a5Threshold1"] = cfg.get("a5-Threshold1")
        out["a5Threshold2"] = cfg.get("a5-Threshold2")
        out["reportOnLeave"] = cfg.get("reportOnLeave")
    elif isinstance(event_id.get("eventA2"), dict):
        out["eventType"] = "EVENTA2"
    elif isinstance(event_id.get("eventA1"), dict):
        out["eventType"] = "EVENTA1"
    elif isinstance(event_id.get("eventA4"), dict):
        out["eventType"] = "EVENTA4"
    elif isinstance(event_id.get("eventA6"), dict):
        out["eventType"] = "EVENTA6"
    return out


def _build_meas_config_resolver(meas_cfg: Any) -> Dict[str, Any]:
    if not isinstance(meas_cfg, dict):
        return {
            "measObjects": [],
            "reportConfigs": [],
            "measIdLinks": [],
            "a3Resolvers": [],
            "a5Resolvers": [],
        }

    meas_objects: List[Dict[str, Any]] = []
    meas_objects_by_id: Dict[int, Dict[str, Any]] = {}
    for row in meas_cfg.get("measObjectToAddModList") or []:
        parsed = _parse_meas_object_row(row)
        if not parsed:
            continue
        meas_objects.append(parsed)
        meas_objects_by_id[int(parsed["measObjectId"])] = parsed

    report_configs: List[Dict[str, Any]] = []
    report_configs_by_id: Dict[int, Dict[str, Any]] = {}
    for row in meas_cfg.get("reportConfigToAddModList") or []:
        parsed = _parse_report_config_row(row)
        if not parsed:
            continue
        report_configs.append(parsed)
        report_configs_by_id[int(parsed["reportConfigId"])] = parsed

    meas_links: List[Dict[str, Any]] = []
    a3_resolvers: List[Dict[str, Any]] = []
    a5_resolvers: List[Dict[str, Any]] = []
    for row in meas_cfg.get("measIdToAddModList") or []:
        if not isinstance(row, dict):
            continue
        meas_id = _safe_int(row.get("measId"))
        meas_object_id = _safe_int(row.get("measObjectId"))
        report_config_id = _safe_int(row.get("reportConfigId"))
        if meas_id is None or meas_object_id is None or report_config_id is None:
            continue
        link = {
            "measId": meas_id,
            "measObjectId": meas_object_id,
            "reportConfigId": report_config_id,
        }
        meas_links.append(link)
        meas_object = meas_objects_by_id.get(meas_object_id)
        report_config = report_configs_by_id.get(report_config_id)
        if not meas_object or not report_config:
            continue
        joined = {
            "measId": meas_id,
            "measObjectId": meas_object_id,
            "reportConfigId": report_config_id,
            "measObject": meas_object,
            "reportConfig": report_config,
        }
        if report_config.get("eventType") == "EVENTA3":
            a3_resolvers.append(joined)
        elif report_config.get("eventType") == "EVENTA5":
            a5_resolvers.append(joined)

    return {
        "measObjects": meas_objects,
        "reportConfigs": report_configs,
        "measIdLinks": meas_links,
        "a3Resolvers": a3_resolvers,
        "a5Resolvers": a5_resolvers,
    }


def _decode_with_candidates(
    payload: bytes,
    candidates: List[Dict[str, Any]],
    *,
    max_offset: int = 0,
    score_fn=None,
    min_score: Optional[int] = None,
    stop_score: Optional[int] = None,
) -> Dict[str, Any]:
    errors: List[str] = []
    best: Optional[Dict[str, Any]] = None

    max_off = int(max(0, max_offset))
    offsets: List[int] = []
    for off in (20, 19, 18, 17, 16, 0, 1, 2, 3, 4):
        if 0 <= off <= max_off and off not in offsets:
            offsets.append(off)
    for off in range(5, max_off + 1):
        if off not in offsets:
            offsets.append(off)

    for off in offsets:
        segment = payload[off:]
        if not segment:
            continue
        for c in candidates:
            obj = c["obj"]
            name = str(c["name"])
            validator = c.get("validator")
            try:
                with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                    obj.from_uper(segment)
                    decoded = json.loads(obj.to_json())
            except Exception as exc:
                errors.append(f"{name}@{off}:{type(exc).__name__}")
                continue

            if callable(validator) and not validator(decoded):
                errors.append(f"{name}@{off}:decoded_but_validation_failed")
                continue

            score = 1
            if callable(score_fn):
                try:
                    score = int(score_fn(decoded, name, off))
                except Exception:
                    score = 1

            row = {
                "ok": True,
                "decoder_type": name,
                "decoded_json": decoded,
                "decode_offset": int(off),
                "score": int(score),
            }
            if best is None:
                best = row
                continue
            if int(row["score"]) > int(best["score"]):
                best = row
                continue
            if int(row["score"]) == int(best["score"]) and int(row["decode_offset"]) < int(best["decode_offset"]):
                best = row
            if stop_score is not None and int(best.get("score") or 0) >= int(stop_score):
                if min_score is None or int(best.get("score") or 0) >= int(min_score):
                    return best

    if best is not None:
        if min_score is None or int(best.get("score") or 0) >= int(min_score):
            return best
        errors.append(f"best_score_too_low:{best.get('score')}")

    return {"ok": False, "errors": errors}


def decode_measurement_report_payload(payload: bytes) -> Dict[str, Any]:
    if not _PYCRATE_READY:
        return {"ok": False, "message": "pycrate unavailable", "status": per_decoder_status()}
    if not payload:
        return {"ok": False, "message": "empty payload"}

    defs = RRCLTE.EUTRA_RRC_Definitions
    def _score_mr(decoded: Dict[str, Any], _name: str, _off: int) -> int:
        meas = _find_first_key(decoded, "measResults")
        if not isinstance(meas, dict):
            return -100
        score = 40
        if _find_first_key(meas, "measId") is not None:
            score += 5
        if _find_first_key(meas, "measResultNeighCells") is not None:
            score += 60
        if _find_first_key(meas, "measResultListEUTRA") is not None:
            score += 25
        if _find_first_key(meas, "measResultListUTRA") is not None:
            score += 20
        if _find_first_key(meas, "measResultListGERAN") is not None:
            score += 20
        if _find_first_key(meas, "measResultServFreqList-r10") is not None:
            score += 10
        return score

    result = _decode_with_candidates(
        payload,
        [
            {
                "name": "MeasurementReport_r8_IEs",
                "obj": defs.MeasurementReport_r8_IEs,
                "validator": lambda d: isinstance(d, dict) and isinstance(d.get("measResults"), dict),
            },
            {
                "name": "MeasurementReport",
                "obj": defs.MeasurementReport,
                "validator": lambda d: _find_first_key(d, "measResults") is not None,
            },
            {
                "name": "UL_DCCH_Message",
                "obj": defs.UL_DCCH_Message,
                "validator": lambda d: _find_first_map_with_any_key(d, ["measurementReport"]) is not None
                and _find_first_key(d, "measResults") is not None,
            },
        ],
        max_offset=min(24, max(0, len(payload) - 1)),
        score_fn=_score_mr,
        min_score=40,
        stop_score=120,
    )
    if not result.get("ok"):
        return result

    decoded_json = result["decoded_json"]
    meas_results = _find_first_key(decoded_json, "measResults")
    if not isinstance(meas_results, dict):
        return {
            "ok": False,
            "message": "decoded payload has no measResults",
            "decoder_type": result.get("decoder_type"),
        }

    meas_id = _safe_int(meas_results.get("measId"))
    pcell = meas_results.get("measResultPCell") if isinstance(meas_results.get("measResultPCell"), dict) else {}
    p_rsrp_idx = _safe_int(pcell.get("rsrpResult"))
    p_rsrq_idx = _safe_int(pcell.get("rsrqResult"))
    serving = {
        "rsrp_idx": p_rsrp_idx,
        "rsrq_idx": p_rsrq_idx,
        "rsrp_dbm": _rsrp_idx_to_dbm(p_rsrp_idx),
        "rsrq_db": _rsrq_idx_to_db(p_rsrq_idx),
    }

    neigh = meas_results.get("measResultNeighCells")
    if not isinstance(neigh, dict):
        neigh = _find_first_map_with_any_key(meas_results, ["measResultListEUTRA", "measResultListUTRA", "measResultListGERAN"]) or {}

    neighbors_lte: List[Dict[str, Any]] = []
    for item in _extract_list_by_key_substring(neigh, "measResultListEUTRA"):
        if not isinstance(item, dict):
            continue
        pci = _safe_int(item.get("physCellId"))
        meas = item.get("measResult") if isinstance(item.get("measResult"), dict) else item
        rsrp_idx = _safe_int(meas.get("rsrpResult"))
        rsrq_idx = _safe_int(meas.get("rsrqResult"))
        neighbors_lte.append({
            "rat": "LTE",
            "pci": pci,
            "earfcn": None,
            "rsrp_idx": rsrp_idx,
            "rsrq_idx": rsrq_idx,
            "rsrp_dbm": _rsrp_idx_to_dbm(rsrp_idx),
            "rsrq_db": _rsrq_idx_to_db(rsrq_idx),
            "source": "MR_PER",
        })

    neighbors_utra: List[Dict[str, Any]] = []
    for item in _extract_list_by_key_substring(neigh, "measResultListUTRA"):
        if not isinstance(item, dict):
            continue
        meas = item.get("measResult") if isinstance(item.get("measResult"), dict) else item
        neighbors_utra.append({
            "rat": "UTRA",
            "psc": _extract_utra_psc(item.get("physCellId")),
            "uarfcn": _safe_int(item.get("carrierFreq")),
            "rscp_idx": _safe_int(meas.get("rscp")),
            "ecno_idx": _safe_int(meas.get("ecNo")),
            "source": "MR_PER",
        })

    neighbors_geran: List[Dict[str, Any]] = []
    for item in _extract_list_by_key_substring(neigh, "measResultListGERAN"):
        if not isinstance(item, dict):
            continue
        neighbors_geran.append({
            "rat": "GERAN",
            "arfcn": _safe_int(item.get("carrierFreq")),
            "bsic": item.get("physCellId") or item.get("bsic"),
            "source": "MR_PER",
        })

    servfreq_rows: List[Dict[str, Any]] = []
    for row in _extract_list_by_key_substring(meas_results, "measResultServFreqList-r10"):
        if not isinstance(row, dict):
            continue
        best = row.get("measResultBestNeighCell-r10")
        best_neighbor = None
        if isinstance(best, dict):
            pci = _safe_int(best.get("physCellId-r10"))
            rsrp_idx = _safe_int(best.get("rsrpResultNCell-r10"))
            rsrq_idx = _safe_int(best.get("rsrqResultNCell-r10"))
            if pci is not None:
                best_neighbor = {
                    "rat": "LTE",
                    "pci": pci,
                    "rsrp_idx": rsrp_idx,
                    "rsrq_idx": rsrq_idx,
                    "rsrp_dbm": _rsrp_idx_to_dbm(rsrp_idx),
                    "rsrq_db": _rsrq_idx_to_db(rsrq_idx),
                }
        scell = row.get("measResultSCell-r10")
        scell_info = None
        if isinstance(scell, dict):
            s_rsrp_idx = _safe_int(scell.get("rsrpResultSCell-r10"))
            s_rsrq_idx = _safe_int(scell.get("rsrqResultSCell-r10"))
            if s_rsrp_idx is not None or s_rsrq_idx is not None:
                scell_info = {
                    "rsrp_idx": s_rsrp_idx,
                    "rsrq_idx": s_rsrq_idx,
                    "rsrp_dbm": _rsrp_idx_to_dbm(s_rsrp_idx),
                    "rsrq_db": _rsrq_idx_to_db(s_rsrq_idx),
                }
        entry = {
            "servFreqId": _safe_int(row.get("servFreqId-r10")),
            "earfcn": _safe_int(row.get("carrierFreq-r10") or row.get("carrierFreq")),
            "best_neighbor": best_neighbor,
            "scell": scell_info,
        }
        if entry.get("best_neighbor") is not None or entry.get("scell") is not None:
            servfreq_rows.append(entry)

    summary = {
        "measId": meas_id,
        "neighbors_lte_count": len(neighbors_lte),
        "neighbors_utra_count": len(neighbors_utra),
        "neighbors_geran_count": len(neighbors_geran),
        "has_measResultNeighCells": bool(neigh),
        "servFreqListCount": len(servfreq_rows),
    }

    return {
        "ok": True,
        "decoder": "pycrate_rrclte",
        "message_id": "measurement_report",
        "param_prefix": "measurement_report",
        "decoder_type": result.get("decoder_type"),
        "decode_offset": result.get("decode_offset"),
        "decoded_json": decoded_json,
        "summary": summary,
        "serving": serving,
        "neighbors_lte": neighbors_lte,
        "neighbors_utra": neighbors_utra,
        "neighbors_geran": neighbors_geran,
        "servfreq": servfreq_rows,
    }


def decode_rrc_reconfiguration_payload(payload: bytes) -> Dict[str, Any]:
    if not _PYCRATE_READY:
        return {"ok": False, "message": "pycrate unavailable", "status": per_decoder_status()}
    if not payload:
        return {"ok": False, "message": "empty payload"}

    defs = RRCLTE.EUTRA_RRC_Definitions
    def _score_recfg(decoded: Dict[str, Any], _name: str, _off: int) -> int:
        score = 0
        if _find_first_key(decoded, "rrcConnectionReconfiguration") is not None:
            score += 40
        if _find_first_key(decoded, "measConfig") is not None:
            score += 80
        if _find_first_key(decoded, "mobilityControlInfo") is not None:
            score += 70
        if _find_first_key(decoded, "radioResourceConfigDedicated") is not None:
            score += 35
        if _find_first_key(decoded, "securityConfigHO") is not None:
            score += 25
        if _json_contains_any(decoded, ["spare7", "spare6", "spare5"]):
            score -= 40
        if _json_contains_any(decoded, ['"noncriticalextension":{"noncriticalextension":{}}']):
            score -= 30
        return score

    result = _decode_with_candidates(
        payload,
        [
            {
                "name": "DL_DCCH_Message",
                "obj": defs.DL_DCCH_Message,
                "validator": lambda d: isinstance(d, dict),
            },
            {
                "name": "RRCConnectionReconfiguration",
                "obj": defs.RRCConnectionReconfiguration,
                "validator": lambda d: isinstance(d, dict),
            },
            {
                "name": "RRCConnectionReconfiguration_r8_IEs",
                "obj": defs.RRCConnectionReconfiguration_r8_IEs,
                "validator": lambda d: isinstance(d, dict),
            },
        ],
        max_offset=min(24, max(0, len(payload) - 1)),
        score_fn=_score_recfg,
        min_score=20,
        stop_score=120,
    )
    if not result.get("ok"):
        return result

    decoded_json = result["decoded_json"]
    meas_cfg = _find_first_key(decoded_json, "measConfig")
    if not isinstance(meas_cfg, dict):
        meas_cfg = {}
    meas_resolver = _build_meas_config_resolver(meas_cfg)
    summary = {
        "has_measConfig": bool(meas_cfg),
        "has_mobilityControlInfo": bool(_find_first_key(decoded_json, "mobilityControlInfo")),
        "has_radioResourceConfigDedicated": bool(_find_first_key(decoded_json, "radioResourceConfigDedicated")),
        "measIdToAddModCount": len(meas_cfg.get("measIdToAddModList") or []) if isinstance(meas_cfg, dict) else 0,
        "measObjectToAddModCount": len(meas_cfg.get("measObjectToAddModList") or []) if isinstance(meas_cfg, dict) else 0,
        "reportConfigToAddModCount": len(meas_cfg.get("reportConfigToAddModList") or []) if isinstance(meas_cfg, dict) else 0,
        "a3ResolverCount": len(meas_resolver.get("a3Resolvers") or []),
        "a5ResolverCount": len(meas_resolver.get("a5Resolvers") or []),
    }

    return {
        "ok": True,
        "decoder": "pycrate_rrclte",
        "message_id": "rrc_reconfiguration",
        "param_prefix": "rrc_recfg",
        "decoder_type": result.get("decoder_type"),
        "decode_offset": result.get("decode_offset"),
        "decoded_json": decoded_json,
        "meas_config": meas_cfg,
        "meas_resolver": meas_resolver,
        "summary": summary,
    }


_RRC_EVENT_PROFILES: List[Dict[str, Any]] = [
    {
        "id": "sib1",
        "param_prefix": "sib1",
        "event_contains": [
            "systeminformationblocktype1",
            ".sib1",
            ".sib.systeminformationblocktype1",
        ],
        "must_tokens": ["trackingareacode"],
        "candidate_names": [
            "BCCH_DL_SCH_Message",
            "SystemInformationBlockType1",
            "SystemInformationBlockType1_v8h0_IEs",
            "SystemInformation",
            "SystemInformation_r8_IEs",
        ],
    },
    {
        "id": "sib3",
        "param_prefix": "sib3",
        "event_contains": [
            "systeminformation - sib2,sib3",
            "systeminformation - sib3",
            ".sib3",
        ],
        "must_tokens": ["sib3", "cellreselection"],
        "candidate_names": [
            "BCCH_DL_SCH_Message",
            "SystemInformation",
            "SystemInformation_r8_IEs",
        ],
    },
    {
        "id": "sib5",
        "param_prefix": "sib5",
        "event_contains": [
            "systeminformation - sib5",
            ".sib5",
        ],
        "must_tokens": ["sib5", "interfreqcarrierfreqlist"],
        "candidate_names": [
            "BCCH_DL_SCH_Message",
            "SystemInformation",
            "SystemInformation_r8_IEs",
        ],
    },
    {
        "id": "rrc_recfg_complete",
        "param_prefix": "rrc_recfg_complete",
        "event_contains": ["dcchul.rrcconnectionreconfigurationcomplete"],
        "must_tokens": ["rrcconnectionreconfigurationcomplete"],
        "candidate_names": [
            "UL_DCCH_Message",
            "RRCConnectionReconfigurationComplete",
            "RRCConnectionReconfigurationComplete_r8_IEs",
        ],
    },
    {
        "id": "rrc_release",
        "param_prefix": "rrc_release",
        "event_contains": ["dcchdl.rrcconnectionrelease"],
        "must_tokens": ["rrcconnectionrelease"],
        "candidate_names": [
            "DL_DCCH_Message",
            "RRCConnectionRelease",
            "RRCConnectionRelease_r8_IEs",
        ],
    },
    {
        "id": "rrc_connection_request",
        "param_prefix": "rrc_conn_req",
        "event_contains": ["ccchul.rrcconnectionrequest"],
        "must_tokens": ["rrcconnectionrequest"],
        "candidate_names": [
            "UL_CCCH_Message",
            "RRCConnectionRequest",
            "RRCConnectionRequest_r8_IEs",
        ],
    },
    {
        "id": "rrc_setup_complete",
        "param_prefix": "rrc_setup_complete",
        "event_contains": ["dcchul.rrcconnectionsetupcomplete"],
        "must_tokens": ["rrcconnectionsetupcomplete"],
        "candidate_names": [
            "UL_DCCH_Message",
            "RRCConnectionSetupComplete",
            "RRCConnectionSetupComplete_r8_IEs",
        ],
    },
    {
        "id": "security_mode_command",
        "param_prefix": "security_mode_command",
        "event_contains": ["dcchdl.securitymodecommand"],
        "must_tokens": ["securitymodecommand"],
        "candidate_names": [
            "DL_DCCH_Message",
            "SecurityModeCommand",
            "SecurityModeCommand_r8_IEs",
        ],
    },
    {
        "id": "security_mode_complete",
        "param_prefix": "security_mode_complete",
        "event_contains": ["dcchul.securitymodecomplete"],
        "must_tokens": ["securitymodecomplete"],
        "candidate_names": [
            "UL_DCCH_Message",
            "SecurityModeComplete",
            "SecurityModeComplete_r8_IEs",
        ],
    },
    {
        "id": "ue_capability_information",
        "param_prefix": "ue_cap_info",
        "event_contains": ["dcchul.uecapabilityinformation"],
        "must_tokens": ["uecapabilityinformation"],
        "candidate_names": [
            "UL_DCCH_Message",
            "UECapabilityInformation",
            "UECapabilityInformation_r8_IEs",
        ],
    },
    {
        "id": "ue_information_request",
        "param_prefix": "ue_info_req",
        "event_contains": ["dcchdl.ueinformationrequest"],
        "must_tokens": ["ueinformationrequest"],
        "candidate_names": [
            "DL_DCCH_Message",
            "UEInformationRequest_r9",
            "UEInformationRequest_r9_IEs",
        ],
    },
    {
        "id": "ue_information_response",
        "param_prefix": "ue_info_rsp",
        "event_contains": ["dcchul.ueinformationresponse"],
        "must_tokens": ["ueinformationresponse"],
        "candidate_names": [
            "UL_DCCH_Message",
            "UEInformationResponse_r9",
            "UEInformationResponse_r9_IEs",
        ],
    },
    {
        "id": "rrc_reestablishment_request",
        "param_prefix": "rrc_reest_req",
        "event_contains": ["ccchul.rrcconnectionreestablishmentrequest"],
        "must_tokens": ["rrcconnectionreestablishmentrequest"],
        "candidate_names": [
            "UL_CCCH_Message",
            "RRCConnectionReestablishmentRequest",
            "RRCConnectionReestablishmentRequest_r8_IEs",
        ],
    },
    {
        "id": "rrc_reestablishment_complete",
        "param_prefix": "rrc_reest_complete",
        "event_contains": ["dcchul.rrcconnectionreestablishmentcomplete"],
        "must_tokens": ["rrcconnectionreestablishmentcomplete"],
        "candidate_names": [
            "UL_DCCH_Message",
            "RRCConnectionReestablishmentComplete",
            "RRCConnectionReestablishmentComplete_r8_IEs",
        ],
    },
    {
        "id": "rrc_reestablishment_reject",
        "param_prefix": "rrc_reest_reject",
        "event_contains": [
            "dcchdl.rrcconnectionreestablishmentreject",
            "ccchdl.rrcconnectionreestablishmentreject",
        ],
        "must_tokens": ["rrcconnectionreestablishmentreject"],
        "candidate_names": [
            "DL_CCCH_Message",
            "RRCConnectionReestablishmentReject",
            "RRCConnectionReestablishmentReject_r8_IEs",
        ],
    },
    {
        "id": "rrc_conn_setup",
        "param_prefix": "rrc_setup",
        "event_contains": [
            "ccchdl.rrcconnectionsetup",
            "dcchul.rrcconnectionsetup",
            ".rrcconnectionsetup",
        ],
        "must_tokens": ["rrcconnectionsetup"],
        "candidate_names": [
            "DL_CCCH_Message",
            "RRCConnectionSetup",
            "RRCConnectionSetup_r8_IEs",
        ],
    },
    {
        "id": "rrc_conn_reject",
        "param_prefix": "rrc_conn_reject",
        "event_contains": [
            "ccchdl.rrcconnectionreject",
            ".rrcconnectionreject",
        ],
        "must_tokens": ["rrcconnectionreject"],
        "candidate_names": [
            "DL_CCCH_Message",
            "RRCConnectionReject",
            "RRCConnectionReject_r8_IEs",
        ],
    },
    {
        "id": "rrc_reestablishment",
        "param_prefix": "rrc_reest",
        "event_contains": [
            "ccchdl.rrcconnectionreestablishment",
            "dcchdl.rrcconnectionreestablishment",
        ],
        "must_tokens": ["rrcconnectionreestablishment"],
        "candidate_names": [
            "DL_CCCH_Message",
            "RRCConnectionReestablishment",
            "RRCConnectionReestablishment_r8_IEs",
        ],
    },
    {
        "id": "mobility_from_eutra",
        "param_prefix": "mobility_from_eutra",
        "event_contains": [
            "mobilityfromeutracommand",
            ".mobilityfromeUTRAcommand",
        ],
        "must_tokens": ["mobilityfromeutracommand"],
        "candidate_names": [
            "DL_DCCH_Message",
            "MobilityFromEUTRACommand",
            "MobilityFromEUTRACommand_r8_IEs",
        ],
    },
    {
        "id": "ho_from_eutra_prep",
        "param_prefix": "ho_from_eutra_prep",
        "event_contains": [
            "handoverfromeutrapreparationrequest",
        ],
        "must_tokens": ["handoverfromeutrapreparationrequest"],
        "candidate_names": [
            "UL_DCCH_Message",
            "HandoverFromEUTRAPreparationRequest",
            "HandoverFromEUTRAPreparationRequest_r8_IEs",
        ],
    },
    {
        "id": "ue_capability_enquiry",
        "param_prefix": "ue_cap_enquiry",
        "event_contains": [
            "dcchdl.uecapabilityenquiry",
            ".uecapabilityenquiry",
        ],
        "must_tokens": ["uecapabilityenquiry"],
        "candidate_names": [
            "DL_DCCH_Message",
            "UECapabilityEnquiry",
            "UECapabilityEnquiry_r8_IEs",
        ],
    },
    {
        "id": "dl_info_transfer",
        "param_prefix": "dl_info_transfer",
        "event_contains": [
            "dcchdl.dlinformationtransfer",
            ".dlinformationtransfer",
        ],
        "must_tokens": ["dlinformationtransfer"],
        "candidate_names": [
            "DL_DCCH_Message",
            "DLInformationTransfer",
            "DLInformationTransfer_r8_IEs",
        ],
    },
    {
        "id": "ul_info_transfer",
        "param_prefix": "ul_info_transfer",
        "event_contains": [
            "dcchul.ulinformationtransfer",
            ".ulinformationtransfer",
        ],
        "must_tokens": ["ulinformationtransfer"],
        "candidate_names": [
            "UL_DCCH_Message",
            "ULInformationTransfer",
            "ULInformationTransfer_r8_IEs",
        ],
    },
    {
        "id": "ul_ho_prep_transfer",
        "param_prefix": "ul_ho_prep_transfer",
        "event_contains": [
            "dcchul.ulhandoverpreparationtransfer",
            ".ulhandoverpreparationtransfer",
        ],
        "must_tokens": ["ulhandoverpreparationtransfer"],
        "candidate_names": [
            "UL_DCCH_Message",
            "ULHandoverPreparationTransfer",
            "ULHandoverPreparationTransfer_r8_IEs",
        ],
    },
    {
        "id": "sib2",
        "param_prefix": "sib2",
        "event_contains": [
            "systeminformation - sib2",
            "systeminformation - sib1,sib2",
            ".sib2",
        ],
        "must_tokens": ["sib2"],
        "candidate_names": [
            "BCCH_DL_SCH_Message",
            "SystemInformation",
            "SystemInformation_r8_IEs",
        ],
    },
    {
        "id": "sib4",
        "param_prefix": "sib4",
        "event_contains": [
            "systeminformation - sib4",
            ".sib4",
        ],
        "must_tokens": ["sib4"],
        "candidate_names": [
            "BCCH_DL_SCH_Message",
            "SystemInformation",
            "SystemInformation_r8_IEs",
        ],
    },
    {
        "id": "sib6",
        "param_prefix": "sib6",
        "event_contains": [
            "systeminformation - sib6",
            ".sib6",
        ],
        "must_tokens": ["sib6"],
        "candidate_names": [
            "BCCH_DL_SCH_Message",
            "SystemInformation",
            "SystemInformation_r8_IEs",
        ],
    },
    {
        "id": "sib7",
        "param_prefix": "sib7",
        "event_contains": [
            "systeminformation - sib7",
            ".sib7",
        ],
        "must_tokens": ["sib7"],
        "candidate_names": [
            "BCCH_DL_SCH_Message",
            "SystemInformation",
            "SystemInformation_r8_IEs",
        ],
    },
]


def _pick_rrc_event_profile(event_name: str) -> Optional[Dict[str, Any]]:
    low = str(event_name or "").strip().lower()
    if not low:
        return None
    # First pass: full substring match (works for ETSI names with channel segment)
    for profile in _RRC_EVENT_PROFILES:
        for token in profile.get("event_contains") or []:
            if str(token) and str(token) in low:
                return profile
    # Second pass: match on last dot-segment only (handles Nemo names like
    # "Message.Layer3.LteRrc.RrcConnectionSetup" that have no channel segment)
    last_seg = low.rsplit(".", 1)[-1] if "." in low else low
    if last_seg:
        for profile in _RRC_EVENT_PROFILES:
            for token in profile.get("event_contains") or []:
                token_last = str(token).rsplit(".", 1)[-1]
                if token_last and len(token_last) > 4 and token_last in last_seg:
                    return profile
    return None


def _first_present(node: Any, keys: List[str]) -> Any:
    for k in keys or []:
        out = _find_first_key(node, str(k))
        if out is not None:
            return out
    return None


def _find_first_list_by_key_token(node: Any, token: str) -> Optional[List[Any]]:
    tok = str(token or "").lower()
    if not tok:
        return None
    if isinstance(node, dict):
        for k, v in node.items():
            if tok in str(k or "").lower() and isinstance(v, list):
                return v
        for v in node.values():
            out = _find_first_list_by_key_token(v, tok)
            if out is not None:
                return out
    elif isinstance(node, list):
        for v in node:
            out = _find_first_list_by_key_token(v, tok)
            if out is not None:
                return out
    return None


def _safe_bool(value: Any) -> Optional[bool]:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return bool(int(value))
    txt = str(value or "").strip().lower()
    if txt in ("1", "true", "yes", "on", "present"):
        return True
    if txt in ("0", "false", "no", "off", "absent"):
        return False
    return None


def _find_first_value_by_key_token(node: Any, token: str) -> Any:
    tok = str(token or "").strip().lower()
    if not tok:
        return None
    if isinstance(node, dict):
        for k, v in node.items():
            if tok in str(k or "").lower():
                return v
        for v in node.values():
            out = _find_first_value_by_key_token(v, tok)
            if out is not None:
                return out
    elif isinstance(node, list):
        for v in node:
            out = _find_first_value_by_key_token(v, tok)
            if out is not None:
                return out
    return None


def _parse_tac_value(value: Any) -> Optional[int]:
    direct = _safe_int(value)
    if isinstance(direct, int) and 0 <= direct <= 65535:
        return direct

    if isinstance(value, dict):
        for key in (
            "trackingAreaCode",
            "trackingAreaCode-r8",
            "trackingAreaCode_r8",
            "value",
            "hex",
            "bin",
            "bits",
            "val",
        ):
            if key in value:
                out = _parse_tac_value(value.get(key))
                if out is not None:
                    return out
        for v in value.values():
            out = _parse_tac_value(v)
            if out is not None:
                return out
        return None

    if isinstance(value, list):
        for item in value:
            out = _parse_tac_value(item)
            if out is not None:
                return out
        return None

    txt = str(value or "").strip()
    if not txt:
        return None

    # ASN.1-style bit-string forms: '0010000010101010'B or B'0010...'
    try:
        import re

        m = re.fullmatch(r"'?([01]{8,32})'?[bB]", txt) or re.fullmatch(r"[bB]'([01]{8,32})'", txt)
        if m:
            num = int(m.group(1), 2)
            if 0 <= num <= 65535:
                return num

        m = re.fullmatch(r"0[xX]([0-9a-fA-F]{1,8})", txt)
        if m:
            num = int(m.group(1), 16)
            if 0 <= num <= 65535:
                return num

        m = re.fullmatch(r"([0-9a-fA-F]{4})", txt)
        if m:
            num = int(m.group(1), 16)
            if 0 <= num <= 65535:
                return num
    except Exception:
        return None

    return None


def _extract_tracking_area_code(decoded_json: Dict[str, Any]) -> Optional[int]:
    if not isinstance(decoded_json, dict):
        return None

    raw = _first_present(
        decoded_json,
        [
            "trackingAreaCode",
            "trackingAreaCode-r8",
            "trackingAreaCode_r8",
            "trackingAreaCode-v1130",
            "trackingAreaCode_v1130",
        ],
    )
    if raw is None:
        raw = _find_first_value_by_key_token(decoded_json, "trackingareacode")

    tac = _parse_tac_value(raw)
    if tac is not None:
        return tac

    # Some decoders flatten this as "tac".
    return _parse_tac_value(_find_first_value_by_key_token(decoded_json, "tac"))


def _collect_keyed_scalar_values(
    node: Any,
    key_tokens: List[str],
    *,
    limit: int = 32,
) -> List[Dict[str, Any]]:
    wanted = [str(t or "").strip().lower() for t in (key_tokens or []) if str(t or "").strip()]
    if not wanted:
        return []
    out: List[Dict[str, Any]] = []

    def _walk(x: Any) -> None:
        if len(out) >= limit:
            return
        if isinstance(x, dict):
            for k, v in x.items():
                kl = str(k or "").strip().lower()
                if any(tok in kl for tok in wanted):
                    if not isinstance(v, (dict, list)):
                        txt = str(v).strip()
                        if txt and txt.lower() not in ("none", "null", "n/a", "na", "-"):
                            out.append({"key": str(k), "value": txt})
                            if len(out) >= limit:
                                return
                _walk(v)
                if len(out) >= limit:
                    return
        elif isinstance(x, list):
            for it in x:
                _walk(it)
                if len(out) >= limit:
                    return

    _walk(node)
    return out


def _collect_keyed_numeric_values(
    node: Any,
    key_tokens: List[str],
    *,
    limit: int = 32,
) -> List[Dict[str, Any]]:
    wanted = [str(t or "").strip().lower() for t in (key_tokens or []) if str(t or "").strip()]
    if not wanted:
        return []
    out: List[Dict[str, Any]] = []

    def _walk(x: Any) -> None:
        if len(out) >= limit:
            return
        if isinstance(x, dict):
            for k, v in x.items():
                kl = str(k or "").strip().lower()
                if any(tok in kl for tok in wanted):
                    if not isinstance(v, (dict, list)):
                        num = _safe_int(v)
                        if num is not None:
                            out.append({"key": str(k), "value": int(num)})
                            if len(out) >= limit:
                                return
                _walk(v)
                if len(out) >= limit:
                    return
        elif isinstance(x, list):
            for it in x:
                _walk(it)
                if len(out) >= limit:
                    return

    _walk(node)
    return out


def _extract_rlf_ue_report_summary(decoded_json: Dict[str, Any]) -> Dict[str, Any]:
    if not isinstance(decoded_json, dict):
        return {}

    rlf_report = _first_present(decoded_json, ["rlf_Report_r9", "rlf_Report_v9e0", "rlf_Report"])
    if rlf_report is None:
        rlf_report = _find_first_value_by_key_token(decoded_json, "rlf_report")
    scope = rlf_report if rlf_report is not None else decoded_json

    cause_rows = _collect_keyed_scalar_values(
        scope,
        ["reestablishmentcause", "rlfcause", "failurecause", "cause"],
        limit=32,
    )
    causes: List[str] = []
    for row in cause_rows:
        txt = str((row or {}).get("value") or "").strip()
        if not txt:
            continue
        if txt.lower() in ("none", "null", "n/a", "na", "-", "0"):
            continue
        causes.append(txt)

    normalized_causes: List[str] = []
    for c in causes:
        low = c.lower()
        if any(low == x.lower() for x in normalized_causes):
            continue
        normalized_causes.append(c)

    reason_breakdown: Dict[str, int] = {}
    for c in causes:
        reason_breakdown[c] = int(reason_breakdown.get(c) or 0) + 1

    timeline_rows = _collect_keyed_numeric_values(
        scope,
        ["timeconnfailure", "timesincefailure", "reest", "timer", "t310", "t311", "t312", "t301", "t304"],
        limit=40,
    )
    timeline: Dict[str, int] = {}

    def _timeline_key(raw_key: str) -> Optional[str]:
        k = str(raw_key or "").strip().lower().replace("_", "").replace("-", "")
        if not k:
            return None
        if "timeconnfailure" in k:
            return "timeConnFailureMs"
        if "timesincefailure" in k:
            return "timeSinceFailureMs"
        if "timesincerlf" in k:
            return "timeSinceRlfMs"
        if "reest" in k and "time" in k:
            return "reestablishmentTimeMs"
        if "t310" in k:
            return "t310"
        if "t311" in k:
            return "t311"
        if "t312" in k:
            return "t312"
        if "t301" in k:
            return "t301"
        if "t304" in k:
            return "t304"
        if "timer" in k:
            return str(raw_key)
        return None

    for row in timeline_rows:
        norm_k = _timeline_key(str((row or {}).get("key") or ""))
        v = _safe_int((row or {}).get("value"))
        if norm_k is None or v is None:
            continue
        if norm_k not in timeline:
            timeline[norm_k] = int(v)

    timeline_text = None
    if timeline:
        parts = [f"{k}={v}" for k, v in timeline.items()]
        timeline_text = " | ".join(parts[:8])

    root_cause = normalized_causes[0] if normalized_causes else None
    cause_detail_rows: List[str] = []
    for row in cause_rows:
        k = str((row or {}).get("key") or "").strip()
        v = str((row or {}).get("value") or "").strip()
        if not k or not v:
            continue
        pair = f"{k}={v}"
        if pair in cause_detail_rows:
            continue
        cause_detail_rows.append(pair)
        if len(cause_detail_rows) >= 5:
            break

    return {
        "hasRlfReport": bool(rlf_report is not None),
        "rlfRootCause": root_cause,
        "rlfRootCauseDetails": (" | ".join(cause_detail_rows) if cause_detail_rows else None),
        "reestablishmentTimeline": timeline_text,
        "reestablishmentTimelineMs": timeline if timeline else None,
        "rlfReasonBreakdown": (reason_breakdown if reason_breakdown else None),
    }


def _extract_band_combinations_from_ue_cap(decoded_json: Dict[str, Any]) -> List[str]:
    combos_raw = _find_first_list_by_key_token(decoded_json, "supportedBandCombination")
    if not isinstance(combos_raw, list):
        return []

    combo_strings: List[str] = []
    seen = set()

    def _collect_eutra_bands(node: Any, out: List[int]) -> None:
        if isinstance(node, dict):
            for k, v in node.items():
                kl = str(k or "").lower().replace("_", "-")
                if "bandeutra" in kl:
                    n = _safe_int(v)
                    if isinstance(n, int) and 1 <= n <= 256:
                        out.append(n)
                _collect_eutra_bands(v, out)
        elif isinstance(node, list):
            for x in node:
                _collect_eutra_bands(x, out)

    for combo in combos_raw:
        bands: List[int] = []
        _collect_eutra_bands(combo, bands)
        if not bands:
            continue
        uniq_sorted = sorted(set(int(b) for b in bands))
        if not uniq_sorted:
            continue
        combo_txt = "+".join([f"B{b}" for b in uniq_sorted])
        if combo_txt in seen:
            continue
        seen.add(combo_txt)
        combo_strings.append(combo_txt)

    return combo_strings


def _extract_ue_capability_summary(decoded_json: Dict[str, Any]) -> Dict[str, Any]:
    ue_cat = _safe_int(
        _first_present(
            decoded_json,
            [
                "ue-Category",
                "ue_Category",
                "ue-Category-v1020",
                "ue_Category_v1020",
            ],
        )
    )
    if ue_cat is not None and (ue_cat < 1 or ue_cat > 64):
        ue_cat = None

    max_layers = _safe_int(
        _first_present(
            decoded_json,
            [
                "maxNumberMIMO-LayersPDSCH-r10",
                "maxNumberMIMO_LayersPDSCH_r10",
                "maxNumberMIMO-LayersPDSCH",
                "maxNumberMIMO_LayersPDSCH",
                "maxNumLayersMIMO-r10",
                "maxNumLayersMIMO",
            ],
        )
    )
    four_ant = _safe_bool(
        _first_present(
            decoded_json,
            [
                "fourAntennaPortActivated-r10",
                "fourAntennaPortActivated",
                "fourAntennaPortActivated_r10",
            ],
        )
    )
    if max_layers is None and four_ant is True:
        max_layers = 4

    max_num_carriers = _safe_int(
        _first_present(
            decoded_json,
            [
                "maxNumCarriers-r10",
                "maxNumCarriers",
                "maxNumCarriers_r10",
                "maxNumberConfiguredCCs-r13",
                "maxNumberConfiguredCCs-r10",
                "maxNumberConfiguredCCs",
                "maxNumberConfiguredCCs_r13",
                "maxNumberConfiguredCCs_r10",
            ],
        )
    )
    band_combos = _extract_band_combinations_from_ue_cap(decoded_json)
    band_comb_count = len(band_combos)
    ca_supported = bool((max_num_carriers is not None and max_num_carriers >= 2) or band_comb_count > 0)

    mimo_capability = None
    if isinstance(max_layers, int):
        if max_layers >= 4:
            mimo_capability = "4x4 capable (decoded UE capability)"
        elif max_layers >= 2:
            mimo_capability = "2x2 capable (decoded UE capability)"
        elif max_layers == 1:
            mimo_capability = "1x1 (decoded UE capability)"

    ca_capability = None
    if ca_supported:
        combo_preview = ""
        if band_comb_count > 0:
            preview_rows = band_combos[:4]
            preview_txt = ", ".join(preview_rows)
            if band_comb_count > 4:
                preview_txt += f" (+{band_comb_count - 4} more)"
            combo_preview = f"band combos: {preview_txt}"
        if combo_preview and isinstance(max_num_carriers, int) and max_num_carriers >= 2:
            ca_capability = f"CA capable ({combo_preview}; MaxNumCarriers={max_num_carriers})"
        elif combo_preview:
            ca_capability = f"CA capable ({combo_preview})"
        elif isinstance(max_num_carriers, int) and max_num_carriers >= 2:
            ca_capability = f"CA capable (MaxNumCarriers={max_num_carriers})"

    return {
        "ueCategory": ue_cat,
        "ueCategoryLabel": (f"Cat {ue_cat}" if isinstance(ue_cat, int) else None),
        "maxMimoLayersDl": max_layers,
        "mimoCapability": mimo_capability,
        "maxNumCarriers": max_num_carriers,
        "supportedBandCombinationCount": band_comb_count,
        "supportedBandCombinations": band_combos,
        "caSupported": ca_supported,
        "caCapability": ca_capability,
    }


def _summary_for_profile(profile: Dict[str, Any], decoded_json: Dict[str, Any]) -> Dict[str, Any]:
    profile_id = str(profile.get("id") or "")
    summary: Dict[str, Any] = {
        "messageId": profile_id,
        "hasCriticalExtensions": bool(_find_first_key(decoded_json, "criticalExtensions")),
        "rrcTransactionIdentifier": _safe_int(
            _first_present(decoded_json, ["rrc-TransactionIdentifier", "rrc_TransactionIdentifier"])
        ),
    }

    if profile_id == "sib1":
        tac = _extract_tracking_area_code(decoded_json)
        summary["trackingAreaCode"] = tac
        summary["trackingAreaCodeHex"] = (f"{int(tac):04X}" if isinstance(tac, int) else None)
    elif profile_id == "sib3":
        sib3 = _find_first_key(decoded_json, "sib3")
        if isinstance(sib3, dict):
            intra = sib3.get("intraFreqCellReselectionInfo") or {}
            common = sib3.get("cellReselectionInfoCommon") or {}
            serving = sib3.get("cellReselectionServingFreqInfo") or {}
            summary["qHyst"] = _first_present(common, ["q-Hyst"])
            summary["cellReselectionPriority"] = _safe_int(_first_present(serving, ["cellReselectionPriority"]))
            summary["sIntraSearch"] = _safe_int(_first_present(intra, ["s-IntraSearch"]))
            summary["sNonIntraSearch"] = _safe_int(_first_present(serving, ["s-NonIntraSearch"]))
            summary["threshServingLow"] = _safe_int(_first_present(serving, ["threshServingLow"]))
            summary["qRxLevMin"] = _safe_int(_first_present(intra, ["q-RxLevMin"]))
            summary["qQualMin"] = _safe_int(_first_present(sib3, ["q-QualMin-r9", "q-QualMin"]))
            summary["tReselectionEutra"] = _safe_int(_first_present(intra, ["t-ReselectionEUTRA"]))
            summary["tReselectionEutraSfHigh"] = _first_present(intra, ["sf-High"])
            summary["tReselectionEutraSfMedium"] = _first_present(intra, ["sf-Medium"])
            summary["sIntraSearchP"] = _safe_int(_first_present(sib3, ["s-IntraSearchP-r9"]))
            summary["sIntraSearchQ"] = _safe_int(_first_present(sib3, ["s-IntraSearchQ-r9"]))
            summary["sNonIntraSearchP"] = _safe_int(_first_present(sib3, ["s-NonIntraSearchP-r9"]))
            summary["sNonIntraSearchQ"] = _safe_int(_first_present(sib3, ["s-NonIntraSearchQ-r9"]))
    elif profile_id == "sib5":
        sib5 = _find_first_key(decoded_json, "sib5")
        carrier_rows = []
        if isinstance(sib5, dict):
            carriers = sib5.get("interFreqCarrierFreqList") or []
            if isinstance(carriers, list):
                for row in carriers:
                    if not isinstance(row, dict):
                        continue
                    carrier_rows.append({
                        "dlCarrierFreq": _safe_int(_first_present(row, ["dl-CarrierFreq"])),
                        "cellReselectionPriority": _safe_int(_first_present(row, ["cellReselectionPriority"])),
                        "qRxLevMin": _safe_int(_first_present(row, ["q-RxLevMin"])),
                        "qOffsetFreq": _first_present(row, ["q-OffsetFreq"]),
                        "threshXHigh": _safe_int(_first_present(row, ["threshX-High"])),
                        "threshXLow": _safe_int(_first_present(row, ["threshX-Low"])),
                        "tReselectionEutra": _safe_int(_first_present(row, ["t-ReselectionEUTRA"])),
                        "allowedMeasBandwidth": _first_present(row, ["allowedMeasBandwidth"]),
                    })
        summary["carrierCount"] = len(carrier_rows)
        summary["carriers"] = carrier_rows
    elif profile_id == "rrc_release":
        summary["releaseCause"] = _first_present(decoded_json, ["releaseCause"])
        summary["hasIdleModeMobilityControlInfo"] = bool(_find_first_key(decoded_json, "idleModeMobilityControlInfo"))
        summary["hasRedirectedCarrierInfo"] = bool(_find_first_key(decoded_json, "redirectedCarrierInfo"))
    elif profile_id == "rrc_connection_request":
        summary["establishmentCause"] = _first_present(decoded_json, ["establishmentCause", "establishmentCause-r15"])
    elif profile_id == "rrc_setup_complete":
        summary["selectedPLMNIdentity"] = _safe_int(_first_present(decoded_json, ["selectedPLMN-Identity", "selectedPLMN_Identity"]))
        summary["hasDedicatedInfoNAS"] = _first_present(decoded_json, ["dedicatedInfoNAS"]) is not None
    elif profile_id == "security_mode_command":
        summary["hasSecurityConfigSMC"] = bool(_find_first_key(decoded_json, "securityConfigSMC"))
    elif profile_id == "ue_capability_information":
        rat_list = _first_present(decoded_json, ["ue-CapabilityRAT-ContainerList", "ue_CapabilityRAT_ContainerList"])
        summary["ueCapabilityRatContainerCount"] = len(rat_list) if isinstance(rat_list, list) else 0
        summary.update(_extract_ue_capability_summary(decoded_json))
    elif profile_id == "ue_information_request":
        summary["rlfReportReq"] = bool(_find_first_key(decoded_json, "rlf_ReportReq_r9"))
        summary["rachReportReq"] = bool(_find_first_key(decoded_json, "rach_ReportReq_r9"))
    elif profile_id == "ue_information_response":
        summary["hasRlfReport"] = bool(
            _first_present(decoded_json, ["rlf_Report_r9", "rlf_Report_v9e0"])
        )
        summary["hasRachReport"] = bool(_find_first_key(decoded_json, "rach_Report_r9"))
        summary["hasConnEstFailReport"] = bool(_find_first_key(decoded_json, "connEstFailReport_r11"))
        summary.update(_extract_rlf_ue_report_summary(decoded_json))
    elif profile_id == "rrc_reestablishment_request":
        summary["reestablishmentCause"] = _first_present(decoded_json, ["reestablishmentCause"])
    elif profile_id == "rrc_recfg_complete":
        summary["hasRlfInfoAvailable"] = bool(
            _first_present(decoded_json, ["rlf_InfoAvailable_r10", "rlf_InfoAvailable_r9"])
        )
    elif profile_id == "rrc_conn_setup":
        rr_cfg = _find_first_key(decoded_json, "radioResourceConfigDedicated")
        if isinstance(rr_cfg, dict):
            srb_list = rr_cfg.get("srb-ToAddModList") or rr_cfg.get("srb_ToAddModList") or []
            drb_list = rr_cfg.get("drb-ToAddModList") or rr_cfg.get("drb_ToAddModList") or []
            summary["srbCount"] = len(srb_list) if isinstance(srb_list, list) else 0
            summary["drbCount"] = len(drb_list) if isinstance(drb_list, list) else 0
        summary["hasRadioResourceConfig"] = bool(rr_cfg)
    elif profile_id == "rrc_conn_reject":
        summary["waitTime"] = _safe_int(_first_present(decoded_json, ["waitTime", "wait-Time", "wait_Time"]))
    elif profile_id == "rrc_reestablishment":
        summary["nextHopChainingCount"] = _safe_int(
            _first_present(decoded_json, ["nextHopChainingCount", "nextHopChainingCount-r8"])
        )
        summary["hasRadioResourceConfig"] = bool(_find_first_key(decoded_json, "radioResourceConfigDedicated"))
    elif profile_id == "mobility_from_eutra":
        purpose = _first_present(decoded_json, ["purpose", "Purpose"])
        if isinstance(purpose, dict):
            summary["targetRAT"] = next(iter(purpose.keys()), None)
        else:
            summary["targetRAT"] = purpose
        summary["hasCsParameters"] = bool(_find_first_key(decoded_json, "cs-Parameters") or _find_first_key(decoded_json, "cs_Parameters"))
    elif profile_id == "ho_from_eutra_prep":
        summary["cdma2000Type"] = _first_present(decoded_json, ["cdma2000-Type", "cdma2000_Type"])
        summary["hasMobilityParameters"] = bool(_find_first_key(decoded_json, "mobilityParameters"))
    elif profile_id == "ue_capability_enquiry":
        req = _first_present(decoded_json, ["ue-CapabilityRequest", "ue_CapabilityRequest"])
        if isinstance(req, list):
            summary["requestedRatTypes"] = req
            summary["requestedRatTypeCount"] = len(req)
        summary["hasFreqBandIndicators"] = bool(_find_first_key(decoded_json, "freqBandIndicatorEUTRA") or _find_first_key(decoded_json, "freqBandIndicatorNR"))
    elif profile_id in ("dl_info_transfer", "ul_info_transfer", "ul_ho_prep_transfer"):
        dedicated_info = _first_present(decoded_json, ["dedicatedInfo", "dedicatedInfoType"])
        if isinstance(dedicated_info, dict):
            summary["dedicatedInfoType"] = next(iter(dedicated_info.keys()), "nas")
            nas_val = dedicated_info.get("nas") or dedicated_info.get("dedicatedInfoNAS")
            if nas_val is not None:
                summary["hasNasPayload"] = True
                if isinstance(nas_val, (str, bytes, list)):
                    try:
                        if isinstance(nas_val, str):
                            summary["nasPayloadLenBytes"] = len(nas_val.encode("latin-1"))
                        elif isinstance(nas_val, bytes):
                            summary["nasPayloadLenBytes"] = len(nas_val)
                        elif isinstance(nas_val, list):
                            summary["nasPayloadLenBytes"] = len(nas_val)
                    except Exception:
                        pass
        else:
            has_nas = bool(_first_present(decoded_json, ["dedicatedInfoNAS", "dedicated_info_nas", "dedicatedInfoNAS-r15"]))
            summary["hasNasPayload"] = has_nas
    elif profile_id == "sib2":
        sib2 = _find_first_key(decoded_json, "sib2")
        if isinstance(sib2, dict):
            rr_common = sib2.get("radioResourceConfigCommon") or {}
            timers = sib2.get("ue-TimersAndConstants") or sib2.get("ue_TimersAndConstants") or {}
            ac_barring = sib2.get("ac-BarringConfig") or sib2.get("ac_BarringConfig") or {}
            summary["hasAcBarring"] = bool(ac_barring)
            summary["t300"] = _safe_int(_first_present(timers, ["t300"]))
            summary["t301"] = _safe_int(_first_present(timers, ["t301"]))
            summary["t310"] = _safe_int(_first_present(timers, ["t310"]))
            summary["t311"] = _safe_int(_first_present(timers, ["t311"]))
            summary["hasRaConfig"] = bool(rr_common.get("rach-ConfigCommon") or rr_common.get("rach_ConfigCommon"))
    elif profile_id == "sib4":
        sib4 = _find_first_key(decoded_json, "sib4")
        if isinstance(sib4, dict):
            neigh_list = sib4.get("intraFreqNeighCellList") or []
            black_list = sib4.get("intraFreqBlackCellList") or []
            summary["intraFreqNeighCellCount"] = len(neigh_list) if isinstance(neigh_list, list) else 0
            summary["intraFreqBlackCellCount"] = len(black_list) if isinstance(black_list, list) else 0
            pcis = []
            if isinstance(neigh_list, list):
                for cell in neigh_list:
                    if isinstance(cell, dict):
                        pci = _safe_int(cell.get("physCellId") or cell.get("phys-CellId"))
                        if pci is not None:
                            pcis.append(pci)
            summary["intraFreqNeighPCIs"] = pcis
    elif profile_id == "sib6":
        sib6 = _find_first_key(decoded_json, "sib6")
        if isinstance(sib6, dict):
            fdd_list = sib6.get("carrierFreqListUTRA-FDD") or sib6.get("carrierFreqListUTRA_FDD") or []
            tdd_list = sib6.get("carrierFreqListUTRA-TDD") or sib6.get("carrierFreqListUTRA_TDD") or []
            summary["utraFddCarrierCount"] = len(fdd_list) if isinstance(fdd_list, list) else 0
            summary["utraTddCarrierCount"] = len(tdd_list) if isinstance(tdd_list, list) else 0
            carriers = []
            for row in (fdd_list if isinstance(fdd_list, list) else []):
                if isinstance(row, dict):
                    carriers.append({
                        "rat": "UTRA-FDD",
                        "uarfcn": _safe_int(row.get("carrierFreq")),
                        "priority": _safe_int(row.get("cellReselectionPriority")),
                        "qRxLevMin": _safe_int(row.get("q-RxLevMin") or row.get("q_RxLevMin")),
                    })
            summary["utraCarriers"] = carriers
    elif profile_id == "sib7":
        sib7 = _find_first_key(decoded_json, "sib7")
        if isinstance(sib7, dict):
            geran_list = sib7.get("carrierFreqsInfoList") or []
            summary["geranCarrierGroupCount"] = len(geran_list) if isinstance(geran_list, list) else 0
    return summary


def decode_rrc_event_payload(payload: bytes, event_name: str) -> Dict[str, Any]:
    if not _PYCRATE_READY:
        return {"ok": False, "message": "pycrate unavailable", "status": per_decoder_status()}
    if not payload:
        return {"ok": False, "message": "empty payload"}

    profile = _pick_rrc_event_profile(event_name)
    if not profile:
        return {"ok": False, "message": "unsupported event_name", "event_name": event_name}

    defs = RRCLTE.EUTRA_RRC_Definitions
    candidates: List[Dict[str, Any]] = []
    for cname in profile.get("candidate_names") or []:
        obj = getattr(defs, str(cname), None)
        if obj is None:
            continue
        candidates.append({
            "name": str(cname),
            "obj": obj,
            "validator": lambda d: isinstance(d, dict),
        })

    if not candidates:
        return {
            "ok": False,
            "message": "no decoder candidates available",
            "event_name": event_name,
            "profile_id": profile.get("id"),
        }

    must_tokens = [str(t).lower() for t in (profile.get("must_tokens") or []) if str(t)]

    def _score(decoded: Dict[str, Any], _name: str, _off: int) -> int:
        try:
            txt = json.dumps(decoded, ensure_ascii=True).lower()
        except Exception:
            txt = ""
        score = 0
        for tok in must_tokens:
            if tok in txt:
                score += 80
            else:
                score -= 25
        if _find_first_key(decoded, "criticalExtensions") is not None:
            score += 10
        if _first_present(decoded, ["rrc-TransactionIdentifier", "rrc_TransactionIdentifier"]) is not None:
            score += 10
        if _json_contains_any(decoded, ["spare7", "spare6", "spare5"]):
            score -= 20
        return score

    result = _decode_with_candidates(
        payload,
        candidates,
        max_offset=min(24, max(0, len(payload) - 1)),
        score_fn=_score,
        min_score=25,
        stop_score=120,
    )
    if not result.get("ok"):
        return result

    decoded_json = result.get("decoded_json")
    if not isinstance(decoded_json, dict):
        return {
            "ok": False,
            "message": "decoded payload is not a dict",
            "decoder_type": result.get("decoder_type"),
            "profile_id": profile.get("id"),
        }

    summary = _summary_for_profile(profile, decoded_json)
    return {
        "ok": True,
        "decoder": "pycrate_rrclte",
        "decoder_type": result.get("decoder_type"),
        "decode_offset": result.get("decode_offset"),
        "decoded_json": decoded_json,
        "event_name": event_name,
        "message_id": profile.get("id"),
        "param_prefix": profile.get("param_prefix"),
        "summary": summary,
    }

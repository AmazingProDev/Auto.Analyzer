from __future__ import annotations

import json
import os
import re
from datetime import datetime
from typing import Any, Dict, List, Optional

from lte_rrc_per_decoder import (
    decode_measurement_report_payload,
    decode_rrc_event_payload,
    decode_rrc_reconfiguration_payload,
)


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
        return int(datetime.fromisoformat(text.replace("Z", "+00:00")).timestamp() * 1000)
    except Exception:
        pass
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


def decode_rrc_payload(event_name: str, payload_hex: str):
    event_name = str(event_name or "").strip()
    payload_hex = str(payload_hex or "").strip()
    if not event_name or not payload_hex:
        return None
    payload_bytes = bytes.fromhex(payload_hex)
    name_lc = event_name.lower()
    if "measurementreport" in name_lc:
        return decode_measurement_report_payload(payload_bytes)
    if "rrcconnectionreconfiguration" in name_lc and "complete" not in name_lc:
        return decode_rrc_reconfiguration_payload(payload_bytes)
    return decode_rrc_event_payload(payload_bytes, event_name)


def decode_rrc_batch(items: List[Dict[str, Any]]):
    decoded_items = []
    for item in items or []:
        if not isinstance(item, dict):
            continue
        event_name = str(item.get("eventName") or item.get("event_name") or "").strip()
        payload_hex = str(item.get("payloadHex") or item.get("payload_hex") or "").strip()
        if not event_name or not payload_hex:
            continue
        try:
            decoded = decode_rrc_payload(event_name, payload_hex)
        except Exception:
            decoded = None
        decoded_items.append({
            "eventName": event_name,
            "payloadHex": payload_hex,
            "decoded": decoded,
        })
    return decoded_items


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


def precompute_lte_rrc(items: List[Dict[str, Any]]) -> Dict[str, Any]:
    diagnostics = {
        "candidateEvents": len(items or []),
        "measurementReports": 0,
        "reconfigurations": 0,
        "decodedMeasurementReports": 0,
        "decodedReconfigurations": 0,
        "reconfigWithA3Resolvers": 0,
        "exactA3Reports": 0,
        "errors": [],
    }
    decoded_rows = []
    for index, item in enumerate(items or []):
        if not isinstance(item, dict):
            continue
        row_id = item.get("rowId", index)
        event_name = str(item.get("eventName") or item.get("event_name") or "").strip()
        payload_hex = str(item.get("payloadHex") or item.get("payload_hex") or "").strip()
        if not event_name or not payload_hex:
            continue
        properties: Dict[str, Any] = {}
        try:
            decoded = decode_rrc_payload(event_name, payload_hex)
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
            diagnostics["measurementReports"] += 1
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
        elif str(decoded.get("message_id") or "").lower() == "rrc_reconfiguration" or event_name.lower() == "rrcconnectionreconfiguration":
            diagnostics["reconfigurations"] += 1
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
    return {
        "diagnostics": diagnostics,
        "items": [
            {"rowId": row["rowId"], "properties": row["properties"]}
            for row in decoded_rows
            if row.get("properties")
        ],
    }


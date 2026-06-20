"""
EPS NAS (Non-Access Stratum) decoder using pycrate_mobile.NAS.

Decodes LTE NAS messages embedded in DLInformationTransfer / ULInformationTransfer
RRC containers (dedicatedInfoNAS field) or standalone Layer3 EPS NAS events
(protocol == 30).

Returns structured summaries for EMM and ESM message types.
"""

from __future__ import annotations

import json
from typing import Any, Dict, List, Optional

try:
    from pycrate_mobile import NAS as _NAS_MOD
    _NAS_READY = True
    _NAS_IMPORT_ERROR = ""
except Exception as _exc:
    _NAS_MOD = None  # type: ignore
    _NAS_READY = False
    _NAS_IMPORT_ERROR = str(_exc)


def nas_decoder_status() -> Dict[str, Any]:
    return {
        "available": _NAS_READY,
        "backend": "pycrate_mobile.NAS",
        "error": _NAS_IMPORT_ERROR or None,
    }


def _safe_int(v: Any) -> Optional[int]:
    try:
        if v is None or isinstance(v, bool):
            return None
        return int(v)
    except Exception:
        return None


def _find_key(node: Any, key: str) -> Any:
    if isinstance(node, dict):
        if key in node:
            return node[key]
        for v in node.values():
            r = _find_key(v, key)
            if r is not None:
                return r
    elif isinstance(node, list):
        for item in node:
            r = _find_key(item, key)
            if r is not None:
                return r
    return None


def _first_present(node: Any, keys: List[str]) -> Any:
    for k in keys:
        r = _find_key(node, k)
        if r is not None:
            return r
    return None


# EMM message type byte -> human label
_EMM_TYPE_LABELS: Dict[int, str] = {
    0x41: "Attach Request",
    0x42: "Attach Accept",
    0x43: "Attach Complete",
    0x44: "Attach Reject",
    0x45: "Detach Request",
    0x46: "Detach Accept",
    0x48: "Detach Request",
    0x49: "Detach Accept",
    0x4A: "Tracking Area Update Request",
    0x4B: "Tracking Area Update Accept",
    0x4C: "Tracking Area Update Complete",
    0x4D: "Tracking Area Update Reject",
    0x4E: "Extended Service Request",
    0x4F: "Service Request",
    0x50: "Service Reject",
    0x51: "GUTI Reallocation Command",
    0x52: "GUTI Reallocation Complete",
    0x53: "Authentication Request",
    0x54: "Authentication Response",
    0x55: "Authentication Reject",
    0x5C: "Authentication Failure",
    0x56: "Identity Request",
    0x57: "Identity Response",
    0x5D: "Security Mode Command",
    0x5E: "Security Mode Complete",
    0x5F: "Security Mode Reject",
    0x60: "EMM Status",
    0x61: "EMM Information",
    0x62: "DL NAS Transport",
    0x63: "UL NAS Transport",
    0x64: "CS Service Notification",
    0x68: "DL Generic NAS Transport",
    0x69: "UL Generic NAS Transport",
}

# ESM message type byte -> human label
_ESM_TYPE_LABELS: Dict[int, str] = {
    0x41: "Activate Default EPS Bearer Context Request",
    0x42: "Activate Default EPS Bearer Context Accept",
    0x43: "Activate Default EPS Bearer Context Reject",
    0x45: "Activate Dedicated EPS Bearer Context Request",
    0x46: "Activate Dedicated EPS Bearer Context Accept",
    0x47: "Activate Dedicated EPS Bearer Context Reject",
    0x49: "Modify EPS Bearer Context Request",
    0x4A: "Modify EPS Bearer Context Accept",
    0x4B: "Modify EPS Bearer Context Reject",
    0x4D: "Deactivate EPS Bearer Context Request",
    0x4E: "Deactivate EPS Bearer Context Accept",
    0xC1: "PDN Connectivity Request",
    0xC2: "PDN Connectivity Reject",
    0xC3: "PDN Disconnect Request",
    0xC4: "PDN Disconnect Reject",
    0xC5: "Bearer Resource Allocation Request",
    0xC6: "Bearer Resource Allocation Reject",
    0xC7: "Bearer Resource Modification Request",
    0xC8: "Bearer Resource Modification Reject",
    0xD9: "ESM Information Request",
    0xDA: "ESM Information Response",
    0xDB: "ESM Notification",
    0xE8: "ESM Status",
}


def _sniff_nas_message_type(payload: bytes) -> str:
    """Detect NAS message type from first 2 bytes without full decode."""
    if not payload or len(payload) < 2:
        return "Unknown"
    pd = payload[0] & 0x0F
    msg_type = payload[1] if len(payload) > 1 else 0
    if pd == 7:  # EMM
        return _EMM_TYPE_LABELS.get(msg_type, f"EMM 0x{msg_type:02X}")
    if pd == 2:  # ESM
        return _ESM_TYPE_LABELS.get(msg_type, f"ESM 0x{msg_type:02X}")
    return f"NAS PD={pd} 0x{msg_type:02X}"


def _extract_nas_summary(decoded_json: Any, nas_type: str) -> Dict[str, Any]:
    """Extract structured summary from decoded NAS JSON for known message types."""
    summary: Dict[str, Any] = {"nasMessageType": nas_type}
    if not isinstance(decoded_json, dict):
        return summary

    t = nas_type.lower().replace(" ", "")

    if t == "attachrequest":
        summary["attachType"] = _first_present(decoded_json, ["EPSAttachType", "EPSAttachType_EPSAttType", "AttachType"])
        summary["esmContainerPresent"] = _find_key(decoded_json, "ESMContainer") is not None or _find_key(decoded_json, "ESM_Container") is not None
        summary["additionalUpdateType"] = _first_present(decoded_json, ["AdditionalUpdateType", "Additional_Update_Type"])
        summary["drxParameter"] = _first_present(decoded_json, ["DRXParam", "DRX_Parameter"])

    elif t == "attachaccept":
        summary["t3412"] = _first_present(decoded_json, ["T3412", "T3412Value", "GPRS_Timer"])
        summary["taiListPresent"] = _find_key(decoded_json, "TAIList") is not None or _find_key(decoded_json, "TAI_List") is not None
        summary["bearerIdentity"] = _first_present(decoded_json, ["EPSBearerId", "EPS_Bearer_Id", "LinkedEPSBearerIdentity"])
        summary["esmContainerPresent"] = _find_key(decoded_json, "ESMContainer") is not None

    elif t == "attachreject":
        summary["emmCause"] = _first_present(decoded_json, ["EMMCause", "EMM_Cause", "Cause"])

    elif t in ("detachrequest", "detachaccept"):
        summary["detachType"] = _first_present(decoded_json, ["DetachTypeMO", "DetachTypeMT", "DetachType"])

    elif t == "trackingareaupdaterequest":
        summary["epsUpdateType"] = _first_present(decoded_json, ["EPSUpdateType", "EPS_Update_Type"])
        summary["activeFlag"] = _first_present(decoded_json, ["ActiveFlag", "Active_Flag"])

    elif t == "trackingareaupdateaccept":
        summary["t3412"] = _first_present(decoded_json, ["T3412", "T3412Value", "GPRS_Timer"])
        summary["taiListPresent"] = _find_key(decoded_json, "TAIList") is not None

    elif t == "trackingareaupdatereject":
        summary["emmCause"] = _first_present(decoded_json, ["EMMCause", "EMM_Cause", "Cause"])

    elif t in ("servicerequest", "extendedservicerequest"):
        summary["serviceType"] = _first_present(decoded_json, ["ServiceType", "Service_Type"])
        summary["ksi"] = _first_present(decoded_json, ["NAS_KSI", "KSI"])

    elif t == "authenticationrequest":
        summary["rand"] = _first_present(decoded_json, ["RAND", "Rand"])
        summary["autn"] = _first_present(decoded_json, ["AUTN", "Autn"])

    elif t == "authenticationresponse":
        summary["res"] = _first_present(decoded_json, ["RES", "Res", "AuthParamResp"])

    elif t in ("securitymodecommand", "securitymodecommand"):
        algos = _first_present(decoded_json, ["NASSecAlgo", "NAS_Security_Algorithms", "SelectedNASSecurityAlgorithms"])
        if isinstance(algos, dict):
            summary["cipheringAlgorithm"] = algos.get("CiphAlgo") or algos.get("ciphering_algorithm")
            summary["integrityAlgorithm"] = algos.get("IntegAlgo") or algos.get("integrity_protection_algorithm")
        else:
            summary["nasSecAlgo"] = algos

    elif t == "identityrequest":
        summary["identityType"] = _first_present(decoded_json, ["IDType", "Identity_Type", "IDType_IDTyp"])

    elif t == "pdnconnectivityrequest":
        summary["pdnType"] = _first_present(decoded_json, ["PDNType", "PDN_Type"])
        summary["requestType"] = _first_present(decoded_json, ["RequestType", "Request_Type"])
        apn = _first_present(decoded_json, ["APN", "AccessPointName"])
        if isinstance(apn, dict):
            summary["apn"] = apn.get("APN") or apn.get("Val") or str(apn)
        elif apn is not None:
            summary["apn"] = apn

    elif t == "pdnconnectivityreject":
        summary["esmCause"] = _first_present(decoded_json, ["ESMCause", "ESM_Cause", "Cause"])

    elif t == "activatedefaultepsbearercontextrequest":
        qos = _first_present(decoded_json, ["EPSQoS", "EPS_QoS"])
        if isinstance(qos, dict):
            summary["qci"] = qos.get("QCI") or qos.get("qci")
        summary["apn"] = _first_present(decoded_json, ["APN", "AccessPointName"])
        summary["pdnAddr"] = _first_present(decoded_json, ["PDNAddr", "PDN_Address"])

    elif t in ("activatedefaultepsbearercontextaccept", "activatedefaultepsbearercontextreject"):
        summary["esmCause"] = _first_present(decoded_json, ["ESMCause", "ESM_Cause", "Cause"])

    elif t == "esminformationresponse":
        summary["apnPresent"] = _find_key(decoded_json, "APN") is not None
        summary["pcoPresent"] = _find_key(decoded_json, "ProtConfig") is not None or _find_key(decoded_json, "PCO") is not None

    # Remove None values from summary
    return {k: v for k, v in summary.items() if v is not None}


def decode_nas_payload(payload: bytes, direction: str = "UL") -> Dict[str, Any]:
    """
    Decode an EPS NAS payload bytes buffer.

    Args:
        payload: Raw NAS message bytes
        direction: "UL" (mobile-originated) or "DL" (mobile-terminated)

    Returns:
        dict with keys: ok, decoder, nas_message_type, decoded_json, summary
        or: ok=False, error=...
    """
    if not _NAS_READY or _NAS_MOD is None:
        return {"ok": False, "error": "pycrate_mobile.NAS not available", "status": nas_decoder_status()}
    if not payload:
        return {"ok": False, "error": "empty payload"}

    sniffed_type = _sniff_nas_message_type(payload)

    try:
        if direction == "UL":
            msg, err = _NAS_MOD.parse_NASLTE_MO(payload)
        else:
            msg, err = _NAS_MOD.parse_NASLTE_MT(payload)

        if msg is None:
            return {"ok": False, "error": f"pycrate returned None: {err}", "nas_message_type": sniffed_type}

        try:
            decoded_json = json.loads(msg.to_json())
        except Exception as e:
            return {"ok": False, "error": f"JSON serialization failed: {e}", "nas_message_type": sniffed_type}

        # Try to get the actual message name from the decoded structure
        msg_name = sniffed_type
        try:
            class_name = type(msg).__name__
            if class_name and class_name not in ("NoneType", "object"):
                msg_name = class_name
        except Exception:
            pass

        summary = _extract_nas_summary(decoded_json, msg_name)

        return {
            "ok": True,
            "decoder": "pycrate_mobile_nas",
            "nas_message_type": msg_name,
            "decoded_json": decoded_json,
            "summary": summary,
        }
    except Exception as exc:
        return {"ok": False, "error": str(exc), "nas_message_type": sniffed_type}


def extract_dedicated_info_nas_bytes(decoded_rrc_json: Any) -> Optional[bytes]:
    """
    Extract the dedicatedInfoNAS bytes from a decoded RRC JSON tree.
    Used for DLInformationTransfer / ULInformationTransfer.
    """
    val = _first_present(decoded_rrc_json, [
        "dedicatedInfoNAS", "dedicatedInfoNAS-r15", "dedicatedInfo",
        "DedicatedInfoNAS", "dedicated_info_nas",
    ])
    if val is None:
        return None
    if isinstance(val, bytes):
        return val
    if isinstance(val, str):
        try:
            import binascii
            return binascii.unhexlify(val.replace(" ", ""))
        except Exception:
            # May be latin-1 encoded binary
            try:
                return val.encode("latin-1")
            except Exception:
                return None
    if isinstance(val, list):
        try:
            return bytes(int(x) for x in val)
        except Exception:
            return None
    return None

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

import bisect
import os
import json
import time
import tempfile
import zipfile
import re
import zlib
import copy
import math
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

# Decoder pipeline (patched)
from trp_raw_decoder import (
    parse_declarations_cdf,
    parse_lookup_tables_cdf,
    decode_cdf_data_variant,
    parse_track_xml,
    iter_fields,
    read_varint,
    try_decode_text,
    extract_ch7_pcap,
    extract_ch1_nas_events,
    extract_ch1_rrc_events,
)
from lte_rrc_per_decoder import (
    RRCLTE,
    decode_measurement_report_payload,
    decode_rrc_reconfiguration_payload,
    decode_rrc_event_payload,
    per_decoder_status,
)
try:
    import pycrate_asn1dir.RRCNR as RRCNR  # type: ignore
except Exception:
    RRCNR = None  # type: ignore
from lte_serving_neighbors import build_serving_neighbors_index
try:
    from nas_decoder import decode_nas_payload, extract_dedicated_info_nas_bytes, nas_decoder_status as _nas_decoder_status
    _NAS_DECODER_READY = True
except Exception:
    decode_nas_payload = None  # type: ignore
    extract_dedicated_info_nas_bytes = None  # type: ignore
    _NAS_DECODER_READY = False
try:
    from nr_rrc_extractor import extract_nr_rrc_summary as _extract_nr_rrc_summary
    _NR_RRC_EXTRACTOR_READY = True
except Exception:
    _extract_nr_rrc_summary = None  # type: ignore
    _NR_RRC_EXTRACTOR_READY = False

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
NR_NEIGHBOR_METRIC_TO_FIELD = {
    "Radio.Nr.Neighbor[32].Pci": "pci",
    "Radio.Nr.Neighbor[32].SsRsrp": "rsrp",
    "Radio.Nr.Neighbor[32].SsRsrq": "rsrq",
    "Radio.Nr.Neighbor[32].NrArfcn": "earfcn",
}
LTE_MR_METRIC_NAME = "Message.Layer3.Errc.DcchUl.MeasurementReport"
# Nemo Outdoor uses LteRrc namespace instead of Errc.DcchUl
_LTE_MR_METRIC_LAST_SEG = "measurementreport"
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
    # New message types
    "Message.Layer3.Errc.CcchDl.RrcConnectionSetup": "rrc_conn_setup",
    "Message.Layer3.Errc.DcchDl.RrcConnectionSetup": "rrc_conn_setup",
    "Message.Layer3.Errc.CcchDl.RrcConnectionReject": "rrc_conn_reject",
    "Message.Layer3.Errc.CcchDl.RrcConnectionReestablishment": "rrc_reestablishment",
    "Message.Layer3.Errc.DcchDl.MobilityFromEutraCommand": "mobility_from_eutra",
    "Message.Layer3.Errc.DcchDl.MobilityFromEUTRACommand": "mobility_from_eutra",
    "Message.Layer3.Errc.DcchUl.HandoverFromEutraPreparationRequest": "ho_from_eutra_prep",
    "Message.Layer3.Errc.DcchUl.HandoverFromEUTRAPreparationRequest": "ho_from_eutra_prep",
    "Message.Layer3.Errc.DcchDl.UeCapabilityEnquiry": "ue_capability_enquiry",
    "Message.Layer3.Errc.DcchDl.UECapabilityEnquiry": "ue_capability_enquiry",
    "Message.Layer3.Errc.DcchDl.DlInformationTransfer": "dl_info_transfer",
    "Message.Layer3.Errc.DcchDl.DLInformationTransfer": "dl_info_transfer",
    "Message.Layer3.Errc.DcchUl.UlInformationTransfer": "ul_info_transfer",
    "Message.Layer3.Errc.DcchUl.ULInformationTransfer": "ul_info_transfer",
    "Message.Layer3.Errc.DcchUl.UlHandoverPreparationTransfer": "ul_ho_prep_transfer",
    "Message.Layer3.Errc.DcchUl.ULHandoverPreparationTransfer": "ul_ho_prep_transfer",
    "Message.Layer3.Errc.BcchDlSch.SystemInformation": "sib",
}
LTE_RRC_EXTRA_PER_METRIC_NAMES = set(LTE_RRC_EXTRA_PER_EVENT_PREFIX.keys())
# Last-segment → profile-id mapping for Nemo naming (Message.Layer3.LteRrc.<Name>)
_LTE_RRC_EXTRA_LAST_SEG_TO_PROFILE: Dict[str, str] = {
    k.split(".")[-1].lower(): v for k, v in LTE_RRC_EXTRA_PER_EVENT_PREFIX.items()
}
_LTE_RRC_EXTRA_LAST_SEGS: set = set(_LTE_RRC_EXTRA_LAST_SEG_TO_PROFILE.keys())
_LTE_RECFG_LAST_SEG = LTE_RECFG_METRIC_NAME.split(".")[-1].lower()  # "rrcconnectionreconfiguration"

LAYER3_COMMON_EVENT_NAME = "Radio.Common.Layer3MessageEvent"
LAYER3_3GPP_MESSAGE_NAME = "Message.3Gpp.Layer3Message"

LAYER3_COMMON_FIELD_IDS = {
    4729: "message_identity",
    4730: "protocol",
    4731: "channel",
    4732: "eps_rrc_protocol_version",
    4733: "nr_rrc_protocol_version",
    4734: "message_type",
}

LAYER3_3GPP_FIELD_IDS = {
    107850: "message_identity",
    107851: "protocol",
    107852: "channel_type",
    107853: "direction_code",
    107854: "device_time",
    107855: "protocol_version",
    107856: "channel_number",
    107857: "cell_identity",
    107858: "payload_bytes",
}

LAYER3_PROTOCOL_LABELS = {
    26: "LTE RRC",
    30: "EPS NAS",
    90: "NR RRC",
}

LAYER3_DIRECTION_LABELS = {
    2: "DL",
    4: "UL",
}

LAYER3_CHANNEL_LABELS = {
    6: "BCCH-BCH / PCCH",
    14: "BCCH-DL-SCH",
    20: "UL-CCCH",
    22: "DL-DCCH",
    44: "UL-DCCH",
    68: "UL-DCCH",
}

# These are TEMS/Nemo Layer3 message identities observed in provider CDF TRP exports.
# The identity is still preserved for unmapped or vendor-specific extension messages.
LAYER3_LTE_RRC_IDENTITY_LABELS = {
    0x6800: "MeasurementReport",
    0x6802: "MeasurementReport",
    0x6A00: "RRCConnectionSetupComplete",
    0x6A06: "SecurityModeComplete",
    0x6C00: "RRCConnectionReconfigurationComplete",
    0x6C06: "RRCConnectionReestablishmentComplete",
    0x6E00: "SystemInformationBlockType1",
    0x6E02: "SystemInformation",
    0x7008: "RRCConnectionRequest",
    0x700E: "RRCConnectionReestablishmentRequest",
    0x7012: "ULInformationTransfer",
    0x7202: "DLInformationTransfer",
    0x7204: "HandoverFromEUTRAPreparationRequest",
    0x7206: "MobilityFromEUTRACommand",
    0x7208: "RRCConnectionReconfiguration",
    0x720A: "RRCConnectionRelease",
    0x720E: "UECapabilityEnquiry",
    0x721C: "MeasurementReport",
    0x721E: "MeasurementReport",
    0x7222: "ULHandoverPreparationTransfer",
    0x7224: "ULInformationTransfer",
    0x7226: "MeasurementReport",
    0x7240: "UEInformationRequest",
    0x7258: "DLInformationTransfer",
    0x725A: "RRCConnectionRelease",
}

LAYER3_NR_RRC_IDENTITY_LABELS = {
    0x20800: "RRCSetupRequest",
    0x21000: "RRCReject",
    0x21002: "RRCSetup",
}

LAYER3_FULL_DECODE_PER_MESSAGE_LIMITS = {
    "MeasurementReport": 24,
    # LTE RRC connection management
    "RRCConnectionSetup": 24,
    "RRCConnectionReject": 24,
    "RRCConnectionRequest": 24,
    "RRCConnectionSetupComplete": 24,
    "RRCConnectionReconfiguration": 12,
    "RRCConnectionReconfigurationComplete": 12,
    "RRCConnectionRelease": 24,
    # LTE RRC reestablishment
    "RRCConnectionReestablishment": 24,
    "RRCConnectionReestablishmentRequest": 24,
    "RRCConnectionReestablishmentComplete": 24,
    "RRCConnectionReestablishmentReject": 24,
    # Security
    "SecurityModeCommand": 12,
    "SecurityModeComplete": 12,
    "SecurityModeReject": 24,
    # UE capability and information
    "UECapabilityEnquiry": 24,
    "UECapabilityInformation": 24,
    "UEInformationRequest": 24,
    "UEInformationResponse": 24,
    # Information transfer / mobility
    "DLInformationTransfer": 24,
    "ULInformationTransfer": 24,
    "ULHandoverPreparationTransfer": 24,
    "MobilityFromEUTRACommand": 24,
    "HandoverFromEUTRAPreparationRequest": 24,
    # System information
    "SystemInformationBlockType1": 24,
    "SystemInformation": 24,
    "Paging": 24,
    "MIB": 24,
    # NR RRC
    "RRCSetupRequest": 64,
    "RRCSetup": 64,
    "RRCSetupComplete": 64,
    "RRCReject": 64,
    "RRCReconfiguration": 24,
    "RRCReconfigurationComplete": 24,
    "RRCReestablishmentRequest": 24,
    "RRCReestablishment": 24,
    "RRCReestablishmentComplete": 24,
}
LAYER3_FULL_DECODE_MESSAGE_NAMES = set(LAYER3_FULL_DECODE_PER_MESSAGE_LIMITS.keys())

_LAYER3_RRC_DECODE_CACHE: Dict[Tuple[str, Optional[int], bytes], Dict[str, Any]] = {}
_LAYER3_RRC_DECODE_CACHE_MAX = 512

LAYER3_RRC_EVENT_NAME_MAP = {
    "MeasurementReport": "Message.Layer3.Errc.DcchUl.MeasurementReport",
    "RRCConnectionReconfiguration": "Message.Layer3.Errc.DcchDl.RrcConnectionReconfiguration",
    "RRCConnectionReconfigurationComplete": "Message.Layer3.Errc.DcchUl.RrcConnectionReconfigurationComplete",
    "RRCConnectionRelease": "Message.Layer3.Errc.DcchDl.RrcConnectionRelease",
    "RRCConnectionSetup": "Message.Layer3.Errc.CcchDl.RrcConnectionSetup",
    "RRCConnectionReject": "Message.Layer3.Errc.CcchDl.RrcConnectionReject",
    "RRCConnectionReestablishment": "Message.Layer3.Errc.CcchDl.RrcConnectionReestablishment",
    "RRCConnectionReestablishmentReject": "Message.Layer3.Errc.CcchDl.RrcConnectionReestablishmentReject",
    "RRCConnectionRequest": "Message.Layer3.Errc.CcchUl.RrcConnectionRequest",
    "RRCConnectionSetupComplete": "Message.Layer3.Errc.DcchUl.RrcConnectionSetupComplete",
    "RRCConnectionReestablishmentRequest": "Message.Layer3.Errc.CcchUl.RrcConnectionReestablishmentRequest",
    "RRCConnectionReestablishmentComplete": "Message.Layer3.Errc.DcchUl.RrcConnectionReestablishmentComplete",
    "SecurityModeCommand": "Message.Layer3.Errc.DcchDl.SecurityModeCommand",
    "SecurityModeComplete": "Message.Layer3.Errc.DcchUl.SecurityModeComplete",
    "UECapabilityEnquiry": "Message.Layer3.Errc.DcchDl.UECapabilityEnquiry",
    "UECapabilityInformation": "Message.Layer3.Errc.DcchUl.UeCapabilityInformation",
    "UEInformationRequest": "Message.Layer3.Errc.DcchDl.UeInformationRequest",
    "UEInformationResponse": "Message.Layer3.Errc.DcchUl.UeInformationResponse",
    "DLInformationTransfer": "Message.Layer3.Errc.DcchDl.DLInformationTransfer",
    "ULInformationTransfer": "Message.Layer3.Errc.DcchUl.ULInformationTransfer",
    "ULHandoverPreparationTransfer": "Message.Layer3.Errc.DcchUl.ULHandoverPreparationTransfer",
    "MobilityFromEUTRACommand": "Message.Layer3.Errc.DcchDl.MobilityFromEUTRACommand",
    "HandoverFromEUTRAPreparationRequest": "Message.Layer3.Errc.DcchUl.HandoverFromEUTRAPreparationRequest",
    "SystemInformationBlockType1": "Message.Layer3.Errc.BcchDlSch.SystemInformationBlockType1",
    "SystemInformation": "Message.Layer3.Errc.BcchDlSch.SystemInformation",
}

L1L2_SCHEDULER_FIELD_SPECS: Dict[str, Dict[str, Any]] = {
    "allocated_rb_dl": {
        "label": "LTE PDSCH Resource Blocks",
        "unit": "RB",
        "exact_candidates": [
            "Radio.Lte.ServingCell[8].Pdsch.NumberOfResourceBlocks",
            "Radio.Lte.ServingCellTotal.Pdsch.NumberOfResourceBlocks",
            "Radio.Lte.ServingCell[8].Pdsch.AllocatedPrb",
            "Radio.Lte.ServingCellTotal.Pdsch.AllocatedPrb",
            "Radio.Lte.ServingCell[8].AllocatedRbs",
            "Radio.Lte.ServingCellTotal.AllocatedRbs",
            "Number of PDSCH Resource Blocks",
            "Number of PDSCH Resource Blocks Carrier 1",
            "Number of PDSCH Resource Blocks Carrier 2",
        ],
        "regex": [r"pdsch.*(numberofresourceblocks|allocated(prb|rb))", r"(allocated(prb|rb)).*pdsch"],
        "per_tti_required": True,
    },
    "allocated_rb_ul": {
        "label": "LTE PUSCH Resource Blocks",
        "unit": "RB",
        "exact_candidates": [
            "Radio.Lte.ServingCell[8].Pusch.NumberOfResourceBlocks",
            "Radio.Lte.ServingCellTotal.Pusch.NumberOfResourceBlocks",
            "Radio.Lte.ServingCell[8].Pusch.AllocatedPrb",
            "Radio.Lte.ServingCellTotal.Pusch.AllocatedPrb",
            "Number of PUSCH Resource Blocks",
            "Number of PUSCH Resource Blocks Carrier 1",
        ],
        "regex": [r"pusch.*(numberofresourceblocks|allocated(prb|rb))", r"(allocated(prb|rb)).*pusch"],
        "per_tti_required": True,
    },
    "rb_alloc_pct_dl": {
        "label": "LTE PDSCH Resource Block Allocation (%)",
        "unit": "%",
        "exact_candidates": [
            "Radio.Lte.ServingCell[8].Pdsch.ResourceBlocksPercentage",
            "Radio.Lte.ServingCellTotal.Pdsch.ResourceBlocksPercentage",
            "PDSCH Resource Block Allocation (%)",
            "PDSCH Resource Block Allocation Carrier 1 (%)",
            "PDSCH Resource Block Allocation Carrier 2 (%)",
        ],
        "regex": [r"pdsch.*resourceblockspercentage", r"pdsch.*resource block allocation(?! (count|usage))"],
        "per_tti_required": False,
    },
    "rb_alloc_pct_ul": {
        "label": "LTE PUSCH Resource Block Allocation (%)",
        "unit": "%",
        "exact_candidates": [
            "Radio.Lte.ServingCell[8].Pusch.ResourceBlocksPercentage",
            "Radio.Lte.ServingCellTotal.Pusch.ResourceBlocksPercentage",
            "PUSCH Resource Block Allocation Carrier 1 (%)",
        ],
        "regex": [r"pusch.*resourceblockspercentage", r"pusch.*resource block allocation(?! (count|usage))"],
        "per_tti_required": False,
    },
    "rb_alloc_count_dl": {
        "label": "LTE PDSCH Res. Block Allocation Count Per Second",
        "unit": "count/s",
        "exact_candidates": [
            "Radio.Lte.ServingCell[8].Pdsch.ResourceBlockAllocationCount",
            "Radio.Lte.ServingCellTotal.Pdsch.ResourceBlockAllocationCount",
            "PDSCH Resource Block Allocation Count Carrier 1",
            "PDSCH Resource Block Allocation Count Carrier 2",
        ],
        "regex": [r"pdsch.*resourceblockallocationcount", r"pdsch.*resource block allocation count"],
        "per_tti_required": False,
    },
    "rb_alloc_count_ul": {
        "label": "LTE PUSCH Res. Block Allocation Count Per Second",
        "unit": "count/s",
        "exact_candidates": [
            "Radio.Lte.ServingCell[8].Pusch.ResourceBlockAllocationCount",
            "Radio.Lte.ServingCellTotal.Pusch.ResourceBlockAllocationCount",
            "PUSCH Resource Block Allocation Count Carrier 1",
        ],
        "regex": [r"pusch.*resourceblockallocationcount", r"pusch.*resource block allocation count"],
        "per_tti_required": False,
    },
    "rb_alloc_usage_pct_dl": {
        "label": "EPS PDSCH RB Allocation Usage (%)",
        "unit": "%",
        "exact_candidates": [
            "Radio.Lte.ServingCell[8].Pdsch.ResourceBlockAllocationPercentage",
            "Radio.Lte.ServingCellTotal.Pdsch.ResourceBlockAllocationPercentage",
            "PDSCH Resource Block Allocation Usage Carrier 1 (%)",
            "PDSCH Resource Block Allocation Usage Carrier 2 (%)",
        ],
        "regex": [r"pdsch.*resourceblockallocationpercentage", r"pdsch.*resource block allocation usage"],
        "per_tti_required": False,
    },
    "rb_alloc_usage_pct_ul": {
        "label": "LTE PUSCH RB Allocation Usage (%)",
        "unit": "%",
        "exact_candidates": [
            "Radio.Lte.ServingCell[8].Pusch.ResourceBlockAllocationPercentage",
            "Radio.Lte.ServingCellTotal.Pusch.ResourceBlockAllocationPercentage",
            "PUSCH Resource Block Allocation Usage Carrier 1 (%)",
        ],
        "regex": [r"pusch.*resourceblockallocationpercentage", r"pusch.*resource block allocation usage"],
        "per_tti_required": False,
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


_MS_PER_DAY = 24 * 60 * 60 * 1000


def _ms_since_utc_midnight(epoch_ms: Any) -> Optional[int]:
    if not isinstance(epoch_ms, (int, float)) or isinstance(epoch_ms, bool):
        return None
    value = int(round(float(epoch_ms)))
    return ((value % _MS_PER_DAY) + _MS_PER_DAY) % _MS_PER_DAY


def _time_of_day_distance_ms(a_ms: Any, b_ms: Any) -> Optional[int]:
    a_mod = _ms_since_utc_midnight(a_ms)
    b_mod = _ms_since_utc_midnight(b_ms)
    if a_mod is None or b_mod is None:
        return None
    delta = abs(a_mod - b_mod)
    return min(delta, _MS_PER_DAY - delta)


def _time_match_delta_ms(sample_ms: Any, center_ms: Any) -> Optional[int]:
    if not isinstance(sample_ms, (int, float)) or isinstance(sample_ms, bool):
        return None
    if not isinstance(center_ms, (int, float)) or isinstance(center_ms, bool):
        return None
    absolute = abs(int(round(float(sample_ms))) - int(round(float(center_ms))))
    tod = _time_of_day_distance_ms(sample_ms, center_ms)
    if tod is None:
        return absolute
    return min(absolute, tod)


def _backward_time_match_age_ms(sample_ms: Any, center_ms: Any) -> Optional[int]:
    if not isinstance(sample_ms, (int, float)) or isinstance(sample_ms, bool):
        return None
    if not isinstance(center_ms, (int, float)) or isinstance(center_ms, bool):
        return None
    sample_i = int(round(float(sample_ms)))
    center_i = int(round(float(center_ms)))
    candidates: List[int] = []
    if sample_i <= center_i:
        candidates.append(center_i - sample_i)
    sample_mod = _ms_since_utc_midnight(sample_i)
    center_mod = _ms_since_utc_midnight(center_i)
    if sample_mod is not None and center_mod is not None:
        candidates.append((center_mod - sample_mod) % _MS_PER_DAY)
    if not candidates:
        return None
    return min(candidates)


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


def _raw_latin1_bytes(value: Any) -> bytes:
    if isinstance(value, bytes):
        return value
    if isinstance(value, bytearray):
        return bytes(value)
    if isinstance(value, str):
        return value.encode("latin1", errors="ignore")
    return b""


def _iter_layer3_nested_samples(blob_value: Any):
    """
    Decode the nested metric list stored inside TEMS/Nemo Layer3 wrapper values.

    The first nested sample is sometimes stored as a bare length-prefixed protobuf
    record, while following samples are usually repeated field-1 length-delimited
    records (0x0a <len> <record>).
    """
    data = _raw_latin1_bytes(blob_value)
    pos = 0
    while pos < len(data):
        if data[pos] == 0x0A:
            pos += 1
            if pos >= len(data):
                break
        length, p = read_varint(data, pos)
        if length is None or p <= pos or length < 0:
            break
        end = p + int(length)
        # Clamp: allow partial last record (payload bytes sub-field may be
        # the final record and the enclosing blob can be byte-exact or truncated).
        actual_end = min(end, len(data))
        record = data[p:actual_end]
        pos = end  # advance by declared length regardless
        if record:
            yield record


def _decode_layer3_nested_sample(record: bytes) -> Tuple[Optional[int], Any]:
    metric_id: Optional[int] = None
    value: Any = None
    for f, w, v in iter_fields(record, max_fields=50):
        if f == 1 and w == 0 and isinstance(v, int):
            metric_id = int(v)
        elif f == 6 and w == 0 and isinstance(v, int):
            value = int(v)
        elif f == 9 and w == 1 and isinstance(v, (bytes, bytearray)):
            value = int.from_bytes(bytes(v), "little", signed=False)
        elif f == 12 and w == 2 and isinstance(v, (bytes, bytearray)):
            txt = try_decode_text(bytes(v))
            value = txt if txt is not None else bytes(v)
        elif f == 13 and w == 2 and isinstance(v, (bytes, bytearray)):
            value = bytes(v)
    return metric_id, value


def _parse_layer3_blob(blob_value: Any, field_map: Dict[int, str]) -> Dict[str, Any]:
    parsed: Dict[str, Any] = {}
    raw_fields: Dict[str, Any] = {}
    for record in _iter_layer3_nested_samples(blob_value):
        metric_id, value = _decode_layer3_nested_sample(record)
        if metric_id is None:
            continue
        key = field_map.get(int(metric_id)) or f"field_{metric_id}"
        parsed[key] = value
        raw_fields[str(metric_id)] = value.hex() if isinstance(value, bytes) else value
    if raw_fields:
        parsed["raw_fields"] = raw_fields
    return parsed


def _extract_event_value_str(event: Dict[str, Any]) -> Any:
    params_map = _normalize_event_params_map(event)
    if "value_str" in params_map:
        return params_map.get("value_str")
    for row in event.get("params") or []:
        if not isinstance(row, dict):
            continue
        if str(row.get("param_id") or "").strip().lower() == "value_str":
            return row.get("param_value")
    return None


def _format_identity(value: Any) -> str:
    n = _safe_int(value)
    if n is None:
        return "-"
    return f"0x{int(n):X}"


def _infer_layer3_message_name(parsed: Dict[str, Any]) -> str:
    identity = _safe_int(parsed.get("message_identity"))
    protocol = _safe_int(parsed.get("protocol"))
    channel = _safe_int(parsed.get("channel_type") if "channel_type" in parsed else parsed.get("channel"))

    if protocol == 26:
        mapped = LAYER3_LTE_RRC_IDENTITY_LABELS.get(int(identity)) if identity is not None else None
        if mapped:
            return mapped
        if channel == 68:
            return "MeasurementReport"
        return f"LTE RRC {_format_identity(identity)}"
    if protocol == 90:
        mapped = LAYER3_NR_RRC_IDENTITY_LABELS.get(int(identity)) if identity is not None else None
        if mapped:
            return mapped
        return f"NR RRC {_format_identity(identity)}"
    if protocol == 30:
        return f"EPS NAS {_format_identity(identity)}"
    return f"Layer3 {_format_identity(identity)}"


def _layer3_event_name(parsed: Dict[str, Any], message_name: str) -> str:
    protocol = _safe_int(parsed.get("protocol"))
    if protocol == 26:
        prefix = "Message.Layer3.LteRrc"
    elif protocol == 90:
        prefix = "Message.Layer3.NrRrc"
    elif protocol == 30:
        prefix = "Message.Layer3.EpsNas"
    else:
        prefix = "Message.Layer3"
    return f"{prefix}.{message_name}"


def _json_has_message_class_extension(value: Any) -> bool:
    try:
        return "messageClassExtension" in json.dumps(value, ensure_ascii=True)
    except Exception:
        return False


def _first_scalar_from_json(value: Any) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (str, int, float)):
        text = str(value).strip()
        return text or None
    if isinstance(value, dict):
        for nested in value.values():
            found = _first_scalar_from_json(nested)
            if found:
                return found
        return None
    if isinstance(value, list):
        for nested in value:
            found = _first_scalar_from_json(nested)
            if found:
                return found
        return None
    return None


def _find_first_json_field(value: Any, wanted_keys: List[str]) -> Optional[str]:
    wanted = {_normalize_message_name_token(key) for key in wanted_keys if str(key or "").strip()}
    if not wanted:
        return None
    if isinstance(value, dict):
        for key, nested in value.items():
            if _normalize_message_name_token(key) in wanted:
                found = _first_scalar_from_json(nested)
                if found:
                    return found
        for nested in value.values():
            found = _find_first_json_field(nested, wanted_keys)
            if found:
                return found
        return None
    if isinstance(value, list):
        for nested in value:
            found = _find_first_json_field(nested, wanted_keys)
            if found:
                return found
    return None


def _extract_lte_rrc_summary(decoded_json: Any, message_name: str) -> Dict[str, Any]:
    summary: Dict[str, Any] = {}
    canonical = _canonical_message_name(message_name)
    if canonical == "RRCConnectionRelease":
        release_cause = _find_first_json_field(decoded_json, ["releaseCause", "releaseCause-r8", "releaseCause-r9"])
        if release_cause:
            summary["releaseCause"] = release_cause
    elif canonical in ("RRCConnectionReestablishmentRequest", "RRCConnectionReestablishment"):
        reestablishment_cause = _find_first_json_field(
            decoded_json,
            ["reestablishmentCause", "reestablishmentCause-r8", "reestablishmentCause-r9", "reEstablishmentCause"],
        )
        if reestablishment_cause:
            summary["reestablishmentCause"] = reestablishment_cause
        rlf_root_cause = _find_first_json_field(
            decoded_json,
            ["rlfRootCause", "rlfRootCause-r9", "radioLinkFailureRootCause"],
        )
        if rlf_root_cause:
            summary["rlfRootCause"] = rlf_root_cause
    return summary


def _normalize_message_name_token(value: Any) -> str:
    return re.sub(r"[^a-z0-9]+", "", str(value or "").lower())


LAYER3_MESSAGE_NAME_ALIASES = {
    "measurementreport": "MeasurementReport",
    "measurementreportr8": "MeasurementReport",
    "measurementreportries": "MeasurementReport",
    "measurementreporties": "MeasurementReport",
    "measurement_report": "MeasurementReport",
    "rrc_connection_request": "RRCConnectionRequest",
    "rrcconnectionrequest": "RRCConnectionRequest",
    "rrc_connection_reestablishment_request": "RRCConnectionReestablishmentRequest",
    "rrcconnectionreestablishmentrequest": "RRCConnectionReestablishmentRequest",
    "rrc_setup_complete": "RRCConnectionSetupComplete",
    "rrcsetupcomplete": "RRCConnectionSetupComplete",
    "rrc_connection_setup_complete": "RRCConnectionSetupComplete",
    "rrcconnectionsetupcomplete": "RRCConnectionSetupComplete",
    "rrc_recfg_complete": "RRCConnectionReconfigurationComplete",
    "rrcconnectionreconfigurationcomplete": "RRCConnectionReconfigurationComplete",
    "rrc_recfg": "RRCConnectionReconfiguration",
    "rrcconnectionreconfiguration": "RRCConnectionReconfiguration",
    "rrc_release": "RRCConnectionRelease",
    "rrcconnectionrelease": "RRCConnectionRelease",
    "security_mode_command": "SecurityModeCommand",
    "securitymodecommand": "SecurityModeCommand",
    "security_mode_complete": "SecurityModeComplete",
    "securitymodecomplete": "SecurityModeComplete",
    "ue_capability_information": "UECapabilityInformation",
    "uecapabilityinformation": "UECapabilityInformation",
    "uecapabilityenquiry": "UECapabilityEnquiry",
    "ue_information_request": "UEInformationRequest",
    "ueinformationrequest": "UEInformationRequest",
    "ue_information_response": "UEInformationResponse",
    "ueinformationresponse": "UEInformationResponse",
    "ulinformationtransfer": "ULInformationTransfer",
    "dlinformationtransfer": "DLInformationTransfer",
    "ulhandoverpreparationtransfer": "ULHandoverPreparationTransfer",
    "rrcsetuprequest": "RRCSetupRequest",
    "rrcsetup": "RRCSetup",
    "rrcreject": "RRCReject",
    "paging": "Paging",
    "mib": "MIB",
    # LTE CCCH messages
    "rrcconnectionsetup": "RRCConnectionSetup",
    "rrcconnectionreject": "RRCConnectionReject",
    "rrcconnectionreestablishment": "RRCConnectionReestablishment",
    "rrcconnectionreestablishmentreject": "RRCConnectionReestablishmentReject",
    # Mobility / HO
    "mobilityfromeutracommand": "MobilityFromEUTRACommand",
    "handoverfromeutrapreparationrequest": "HandoverFromEUTRAPreparationRequest",
    # UE capability
    "uecapabilityenquiry": "UECapabilityEnquiry",
    # NR aliases
    "rrcreconfiguration": "RRCReconfiguration",
    "rrcreconfigurationcomplete": "RRCReconfigurationComplete",
    "rrcreestablishmentrequest": "RRCReestablishmentRequest",
    "rrcreestablishment": "RRCReestablishment",
    "rrcreestablishmentcomplete": "RRCReestablishmentComplete",
    "rrcsetupcomplete": "RRCSetupComplete",
    "securitymodecommand": "SecurityModeCommand",
    "securitymodecomplete": "SecurityModeComplete",
    "securitymodereject": "SecurityModeReject",
}


def _canonical_message_name(value: Any) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    return LAYER3_MESSAGE_NAME_ALIASES.get(text, LAYER3_MESSAGE_NAME_ALIASES.get(_normalize_message_name_token(text), text))


def _decoded_message_name_from_json(decoded_json: Any) -> str:
    try:
        txt = json.dumps(decoded_json, ensure_ascii=True).lower()
    except Exception:
        txt = ""
    checks = [
        ("measurementreport", "MeasurementReport"),
        ("rrcconnectionreconfigurationcomplete", "RRCConnectionReconfigurationComplete"),
        ("rrcconnectionreconfiguration", "RRCConnectionReconfiguration"),
        ("rrcsetuprequest", "RRCSetupRequest"),
        ("rrcconnectionrequest", "RRCConnectionRequest"),
        ("rrcsetupcomplete", "RRCSetupComplete"),
        ("rrcconnectionsetupcomplete", "RRCConnectionSetupComplete"),
        ("rrcsetup", "RRCSetup"),
        ("rrcreject", "RRCReject"),
        ("rrcconnectionrelease", "RRCConnectionRelease"),
        ("rrcrelease", "RRCRelease"),
        ("securitymodecommand", "SecurityModeCommand"),
        ("securitymodecomplete", "SecurityModeComplete"),
        ("uecapabilityenquiry", "UECapabilityEnquiry"),
        ("uecapabilityinformation", "UECapabilityInformation"),
        ("ueinformationrequest", "UEInformationRequest"),
        ("ueinformationresponse", "UEInformationResponse"),
        ("dlinformationtransfer", "DLInformationTransfer"),
        ("ulinformationtransfer", "ULInformationTransfer"),
        ("ulhandoverpreparationtransfer", "ULHandoverPreparationTransfer"),
        ("handoverfromeutrapreparationrequest", "HandoverFromEUTRAPreparationRequest"),
        ("rrcconnectionreestablishmentrequest", "RRCConnectionReestablishmentRequest"),
        ("rrcconnectionreestablishmentcomplete", "RRCConnectionReestablishmentComplete"),
        ("rrcconnectionreestablishmentreject", "RRCConnectionReestablishmentReject"),
        ("rrcconnectionreestablishment", "RRCConnectionReestablishment"),
        ("systeminformationblocktype1", "SystemInformationBlockType1"),
        ("systeminformation", "SystemInformation"),
        ("paging", "Paging"),
        ("mib", "MIB"),
    ]
    for token, label in checks:
        if token in txt:
            return _canonical_message_name(label)
    return ""


def _decode_layer3_lte_rrc_container(payload: bytes, channel: Optional[int], message_name: str, *, lenient: bool = False) -> Dict[str, Any]:
    if RRCLTE is None or not payload:
        return {}
    defs = RRCLTE.EUTRA_RRC_Definitions
    by_channel = {
        14: ["BCCH_DL_SCH_Message"],
        20: ["UL_CCCH_Message", "UL_DCCH_Message"],
        22: ["DL_DCCH_Message", "DL_CCCH_Message"],
        44: ["UL_DCCH_Message", "UL_CCCH_Message"],
        68: ["UL_DCCH_Message"],
        6: ["BCCH_BCH_Message", "PCCH_Message"],
    }
    candidates = by_channel.get(channel or -1) or [
        "UL_DCCH_Message",
        "DL_DCCH_Message",
        "UL_CCCH_Message",
        "DL_CCCH_Message",
        "BCCH_DL_SCH_Message",
    ]
    expected = str(message_name or "").lower().replace("-", "").replace("_", "")
    best: Optional[Dict[str, Any]] = None
    errors: List[str] = []
    for off in range(0, min(8, max(0, len(payload) - 1)) + 1):
        segment = payload[off:]
        for candidate_name in candidates:
            obj = getattr(defs, candidate_name, None)
            if obj is None:
                continue
            try:
                inst = copy.copy(obj)
                inst.from_uper(segment)
                decoded_json = json.loads(inst.to_json())
            except Exception as exc:
                errors.append(f"{candidate_name}@{off}: {exc}")
                continue

            try:
                txt = json.dumps(decoded_json, ensure_ascii=True).lower()
            except Exception:
                txt = ""
            inferred_name = _decoded_message_name_from_json(decoded_json)
            inferred_norm = _normalize_message_name_token(inferred_name)
            score = 10
            txt_norm = txt.replace("-", "").replace("_", "")
            if expected and expected in txt_norm:
                score += 80
            elif expected and inferred_norm and inferred_norm == expected:
                score += 80
            elif expected and not expected.startswith(("lterrc", "nrrrc", "epsnas")) and not lenient:
                continue
            if inferred_name:
                score += 10
            if "messageclassextension" in txt:
                score -= 40
            if "criticalextensions" in txt:
                score += 10
            if off == 0:
                score += 5
            if best is None or score > int(best.get("score") or -999):
                best = {
                    "ok": True,
                    "decoder": "pycrate_rrclte",
                    "decoder_type": candidate_name,
                    "decoded_json": decoded_json,
                    "message_id": _canonical_message_name(inferred_name or (str(message_name or "").strip() or candidate_name)),
                    "summary": {
                        "container": candidate_name,
                        "message": _canonical_message_name(inferred_name or (str(message_name or "").strip() or candidate_name)),
                        "offset": off,
                    },
                    "score": score,
                }

    if best and not _json_has_message_class_extension(best.get("decoded_json")):
        return best
    if best and int(best.get("score") or 0) > 0:
        return best
    if best and lenient:
        return best
    return {"ok": False, "message": "; ".join(errors[:3])} if errors else {}


def _decode_layer3_nr_rrc_container(payload: bytes, channel: Optional[int], message_name: str) -> Dict[str, Any]:
    if RRCNR is None or not payload:
        return {}
    defs = RRCNR.NR_RRC_Definitions
    by_channel = {
        20: ["UL_CCCH_Message", "UL_CCCH1_Message"],
        22: ["DL_CCCH_Message", "DL_DCCH_Message"],
        44: ["UL_DCCH_Message"],
        68: ["UL_DCCH_Message"],
        14: ["BCCH_DL_SCH_Message"],
        6: ["BCCH_BCH_Message", "PCCH_Message"],
    }
    candidates = by_channel.get(channel or -1) or [
        "UL_CCCH_Message",
        "UL_CCCH1_Message",
        "DL_CCCH_Message",
        "UL_DCCH_Message",
        "DL_DCCH_Message",
        "BCCH_BCH_Message",
        "BCCH_DL_SCH_Message",
        "PCCH_Message",
    ]
    expected = _normalize_message_name_token(message_name)
    best: Optional[Dict[str, Any]] = None
    errors: List[str] = []
    for off in range(0, min(8, max(0, len(payload) - 1)) + 1):
        segment = payload[off:]
        for candidate_name in candidates:
            obj = getattr(defs, candidate_name, None)
            if obj is None:
                continue
            try:
                inst = copy.copy(obj)
                inst.from_uper(segment)
                decoded_json = json.loads(inst.to_json())
            except Exception as exc:
                errors.append(f"{candidate_name}@{off}: {exc}")
                continue
            inferred_name = _decoded_message_name_from_json(decoded_json)
            inferred_norm = _normalize_message_name_token(inferred_name)
            try:
                txt = json.dumps(decoded_json, ensure_ascii=True).lower()
            except Exception:
                txt = ""
            score = 10
            if inferred_name:
                score += 40
            if expected and expected.startswith("nrrrc"):
                score += 20
            elif expected and inferred_norm and inferred_norm == expected:
                score += 80
            elif expected and inferred_name:
                score -= 10
            if channel == 20 and "rrcsetuprequest" in txt:
                score += 50
            if channel == 22 and ("rrcreject" in txt or "rrcsetup" in txt or "dlinformationtransfer" in txt):
                score += 50
            if channel == 6 and ("paging" in txt or '"mib"' in txt):
                score += 50
            if "messageclassextension" in txt:
                score -= 40
            if off == 0:
                score += 5
            if best is None or score > int(best.get("score") or -999):
                best = {
                    "ok": True,
                    "decoder": "pycrate_rrcnr",
                    "decoder_type": candidate_name,
                    "decoded_json": decoded_json,
                    "message_id": _canonical_message_name(inferred_name or (str(message_name or "").strip() or candidate_name)),
                    "summary": {
                        "container": candidate_name,
                        "message": _canonical_message_name(inferred_name or (str(message_name or "").strip() or candidate_name)),
                        "offset": off,
                    },
                    "score": score,
                }
    if best and int(best.get("score") or 0) > 0:
        return best
    return {"ok": False, "message": "; ".join(errors[:3])} if errors else {}


def _decode_layer3_rrc_payload(parsed: Dict[str, Any], message_name: str) -> Dict[str, Any]:
    payload = parsed.get("payload_bytes")
    # Accept latin1-encoded string (round-tripped from binary blob via try_decode_text)
    if isinstance(payload, str) and payload:
        payload = payload.encode("latin1", errors="replace")
    if not isinstance(payload, (bytes, bytearray)) or not payload:
        return {
            "ok": False,
            "message": "No payload bytes present in Message.3Gpp.Layer3Message sample",
        }
    protocol = _safe_int(parsed.get("protocol"))
    if protocol == 30:
        # EPS NAS — decode directly
        if not _NAS_DECODER_READY or decode_nas_payload is None:
            return {"ok": False, "message": "NAS decoder unavailable"}
        direction_code = _safe_int(parsed.get("direction_code"))
        direction = "DL" if direction_code == 2 else "UL"
        payload_bytes = bytes(payload)
        cache_key = ("nas:" + str(message_name or ""), None, payload_bytes)
        cached = _LAYER3_RRC_DECODE_CACHE.get(cache_key)
        if isinstance(cached, dict):
            return copy.deepcopy(cached)
        result = decode_nas_payload(payload_bytes, direction)
        if isinstance(result, dict) and result.get("ok"):
            result["message_id"] = result.get("nas_message_type") or message_name
        if len(_LAYER3_RRC_DECODE_CACHE) >= _LAYER3_RRC_DECODE_CACHE_MAX:
            _LAYER3_RRC_DECODE_CACHE.clear()
        _LAYER3_RRC_DECODE_CACHE[cache_key] = copy.deepcopy(result)
        return result
    if protocol == 90:
        payload_bytes = bytes(payload)
        channel = _safe_int(parsed.get("channel_type") if "channel_type" in parsed else parsed.get("channel"))
        cache_key = (str(message_name or ""), channel, payload_bytes)
        cached = _LAYER3_RRC_DECODE_CACHE.get(cache_key)
        if isinstance(cached, dict):
            return copy.deepcopy(cached)
        result = _decode_layer3_nr_rrc_container(payload_bytes, channel, message_name)
        # Enrich NR RRC decode with structured field extraction
        if isinstance(result, dict) and result.get("ok") and _NR_RRC_EXTRACTOR_READY and _extract_nr_rrc_summary is not None:
            nr_inferred = result.get("message_id") or message_name
            try:
                nr_summary = _extract_nr_rrc_summary(result.get("decoded_json") or {}, nr_inferred)
                if nr_summary:
                    existing_summary = result.get("summary") or {}
                    if isinstance(existing_summary, dict):
                        existing_summary.update(nr_summary)
                    result["summary"] = existing_summary
                    result["nr_rrc_summary"] = nr_summary
            except Exception:
                pass
        if len(_LAYER3_RRC_DECODE_CACHE) >= _LAYER3_RRC_DECODE_CACHE_MAX:
            _LAYER3_RRC_DECODE_CACHE.clear()
        _LAYER3_RRC_DECODE_CACHE[cache_key] = copy.deepcopy(result)
        return result
    if protocol != 26:
        return {}
    payload_bytes = bytes(payload)
    channel = _safe_int(parsed.get("channel_type") if "channel_type" in parsed else parsed.get("channel"))
    cache_key = (str(message_name or ""), channel, payload_bytes)
    cached = _LAYER3_RRC_DECODE_CACHE.get(cache_key)
    if isinstance(cached, dict):
        return copy.deepcopy(cached)
    low_name = str(message_name or "").lower()
    try:
        if low_name == "measurementreport":
            dec = decode_measurement_report_payload(payload_bytes)
        elif low_name == "rrcconnectionreconfiguration":
            dec = decode_rrc_reconfiguration_payload(payload_bytes)
        else:
            event_name = LAYER3_RRC_EVENT_NAME_MAP.get(message_name, "Message.Layer3.Errc.DcchUl." + message_name)
            dec = decode_rrc_event_payload(payload_bytes, event_name)
    except Exception as exc:
        dec = {"ok": False, "message": str(exc)}
    result = dec if isinstance(dec, dict) else {}
    decoded_name = _canonical_message_name(_decoded_message_name_from_json(result.get("decoded_json"))) if isinstance(result, dict) and result.get("ok") else ""
    expected_name = _normalize_message_name_token(_canonical_message_name(message_name))
    if decoded_name and expected_name and _normalize_message_name_token(decoded_name) != expected_name:
        result = {}
    if not (isinstance(result, dict) and result.get("ok")) and str(message_name or "") in LAYER3_FULL_DECODE_MESSAGE_NAMES:
        generic = _decode_layer3_lte_rrc_container(payload_bytes, channel, message_name)
        if isinstance(generic, dict) and generic:
            result = generic
    if isinstance(result, dict) and result.get("ok"):
        lte_inferred = result.get("message_id") or message_name
        try:
            lte_summary = _extract_lte_rrc_summary(result.get("decoded_json") or {}, lte_inferred)
            if lte_summary:
                existing_summary = result.get("summary") or {}
                if isinstance(existing_summary, dict):
                    existing_summary.update(lte_summary)
                result["summary"] = existing_summary
                result["lte_rrc_summary"] = lte_summary
        except Exception:
            pass
    # For DL/UL InformationTransfer, attempt to decode the embedded NAS container
    if (isinstance(result, dict) and result.get("ok")
            and low_name in ("dlinformationtransfer", "ulinformationtransfer", "ulhandoverpreparationtransfer")
            and _NAS_DECODER_READY and decode_nas_payload is not None
            and extract_dedicated_info_nas_bytes is not None):
        try:
            nas_bytes = extract_dedicated_info_nas_bytes(result.get("decoded_json") or {})
            if nas_bytes:
                direction_code = _safe_int(parsed.get("direction_code"))
                direction = "DL" if direction_code == 2 else "UL"
                nas_result = decode_nas_payload(nas_bytes, direction)
                if isinstance(nas_result, dict) and nas_result.get("ok"):
                    result["nas_decoded_json"] = nas_result.get("decoded_json")
                    result["nas_message_type"] = nas_result.get("nas_message_type")
                    result["nas_summary"] = nas_result.get("summary")
        except Exception:
            pass
    if len(_LAYER3_RRC_DECODE_CACHE) >= _LAYER3_RRC_DECODE_CACHE_MAX:
        _LAYER3_RRC_DECODE_CACHE.clear()
    _LAYER3_RRC_DECODE_CACHE[cache_key] = copy.deepcopy(result)
    return result


def _compact_layer3_summary(parsed: Dict[str, Any], message_name: str, decoded: Optional[Dict[str, Any]] = None) -> str:
    protocol = _safe_int(parsed.get("protocol"))
    channel = _safe_int(parsed.get("channel_type") if "channel_type" in parsed else parsed.get("channel"))
    direction_code = _safe_int(parsed.get("direction_code"))
    version = parsed.get("protocol_version") or parsed.get("eps_rrc_protocol_version") or parsed.get("nr_rrc_protocol_version")
    identity = _format_identity(parsed.get("message_identity"))
    payload = parsed.get("payload_bytes")

    lines = [
        f"Message: {message_name}",
        f"Identity: {identity}",
        f"Protocol: {LAYER3_PROTOCOL_LABELS.get(protocol, protocol if protocol is not None else '-')}",
        f"Channel: {LAYER3_CHANNEL_LABELS.get(channel, channel if channel is not None else '-')}",
        f"Direction: {LAYER3_DIRECTION_LABELS.get(direction_code, '-')}",
    ]
    if version:
        lines.append(f"Version: {version}")
    if isinstance(payload, (bytes, bytearray)):
        lines.append(f"Payload length: {len(payload)} bytes")
        lines.append(f"Payload hex: {bytes(payload).hex()}")

    if isinstance(decoded, dict) and decoded.get("ok"):
        if decoded.get("decoder_type"):
            lines.append(f"Decoder: {decoded.get('decoder_type')}")
        summary = decoded.get("summary")
        if isinstance(summary, dict) and summary:
            lines.append("Summary: " + _json_compact(summary))
        decoded_json = decoded.get("decoded_json")
        if decoded_json is not None:
            try:
                lines.append("Decoded ASN.1 JSON:")
                lines.append(json.dumps(decoded_json, ensure_ascii=False, indent=2))
            except Exception:
                lines.append("Decoded ASN.1 JSON: " + _json_compact(decoded_json))
        nas_decoded = decoded.get("nas_decoded_json")
        if nas_decoded is not None:
            nas_type = decoded.get("nas_message_type") or "NAS"
            lines.append(f"\nEmbedded NAS ({nas_type}):")
            try:
                lines.append(json.dumps(nas_decoded, ensure_ascii=False, indent=2))
            except Exception:
                lines.append(_json_compact(nas_decoded))
        nas_type_direct = decoded.get("nas_message_type")
        if nas_type_direct and not nas_decoded:
            lines.append(f"NAS Message: {nas_type_direct}")
    elif isinstance(decoded, dict) and decoded:
        msg = decoded.get("message") or "; ".join(str(x) for x in (decoded.get("errors") or [])[:2])
        if msg:
            lines.append(f"ASN.1 decode: {msg}")

    return "\n".join(str(x) for x in lines if x is not None)


def _layer3_params_patch(parsed: Dict[str, Any], message_name: str, decoded: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    payload = parsed.get("payload_bytes")
    out: Dict[str, Any] = {
        "layer3_message": message_name,
        "layer3_message_identity": _format_identity(parsed.get("message_identity")),
        "layer3_protocol": LAYER3_PROTOCOL_LABELS.get(_safe_int(parsed.get("protocol")), parsed.get("protocol")),
        "layer3_channel": LAYER3_CHANNEL_LABELS.get(_safe_int(parsed.get("channel_type") if "channel_type" in parsed else parsed.get("channel")), parsed.get("channel_type") or parsed.get("channel")),
        "layer3_direction": LAYER3_DIRECTION_LABELS.get(_safe_int(parsed.get("direction_code")), ""),
    }
    version = parsed.get("protocol_version") or parsed.get("eps_rrc_protocol_version") or parsed.get("nr_rrc_protocol_version")
    if version:
        out["layer3_protocol_version"] = version
    if isinstance(payload, (bytes, bytearray)):
        out["payload_hex"] = bytes(payload).hex()
        out["payload_len"] = len(payload)
    if isinstance(decoded, dict) and decoded.get("ok"):
        out["layer3_asn1_decoded"] = "yes"
        if decoded.get("decoder_type"):
            out["layer3_decoder_type"] = decoded.get("decoder_type")
        if decoded.get("decoded_json") is not None:
            out["layer3_decoded_json"] = _json_compact(decoded.get("decoded_json"))
        if decoded.get("summary") is not None:
            out["layer3_summary"] = _json_compact(decoded.get("summary"))
        summary = decoded.get("summary") or {}
        if isinstance(summary, dict):
            release_cause = str(summary.get("releaseCause") or "").strip()
            if release_cause:
                out["rrc_rel_cause"] = release_cause
            reestablishment_cause = str(summary.get("reestablishmentCause") or "").strip()
            if reestablishment_cause:
                out["parsedEstablishmentCause"] = reestablishment_cause
            rlf_root_cause = str(summary.get("rlfRootCause") or "").strip()
            if rlf_root_cause:
                out["rlf_root_cause"] = rlf_root_cause
    elif isinstance(decoded, dict) and decoded:
        out["layer3_asn1_decoded"] = "no"
        if decoded.get("message"):
            out["layer3_decode_error"] = decoded.get("message")
    return out


def _pop_matching_common_layer3_event(
    common_by_time_identity: Dict[Tuple[str, Optional[int]], List[Dict[str, Any]]],
    common_by_identity: Dict[Optional[int], List[Dict[str, Any]]],
    time_iso: str,
    identity: Optional[int],
    *,
    tolerance_ms: int = 250,
) -> Optional[Dict[str, Any]]:
    exact_targets = common_by_time_identity.get((time_iso, identity)) or []
    if exact_targets:
        target = exact_targets.pop(0)
        pool = common_by_identity.get(identity) or []
        if target in pool:
            pool.remove(target)
        return target

    target_ms = _to_epoch_ms(time_iso)
    if identity is None or target_ms is None:
        return None
    pool = common_by_identity.get(identity) or []
    best: Optional[Dict[str, Any]] = None
    best_delta: Optional[int] = None
    for candidate in pool:
        cand_ms = _to_epoch_ms(candidate.get("time"))
        if cand_ms is None:
            continue
        delta = abs(int(cand_ms) - int(target_ms))
        if delta > int(tolerance_ms):
            continue
        if best is None or best_delta is None or delta < best_delta:
            best = candidate
            best_delta = delta
    if best is None:
        return None
    pool.remove(best)
    exact_bucket = common_by_time_identity.get((str(best.get("time") or ""), identity)) or []
    if best in exact_bucket:
        exact_bucket.remove(best)
    return best


def _enrich_layer3_messages_in_place(
    kpi_samples: List[Dict[str, Any]],
    events: List[Dict[str, Any]],
    *,
    decode_limits: Optional[Dict[str, int]] = None,
    decode_unknown_nr: bool = False,
) -> Dict[str, Any]:
    stats = {
        "common_seen": 0,
        "threegpp_seen": 0,
        "matched": 0,
        "appended": 0,
        "decoded": 0,
    }
    decode_counts: Dict[str, int] = {}
    limits = decode_limits if isinstance(decode_limits, dict) else LAYER3_FULL_DECODE_PER_MESSAGE_LIMITS

    common_by_time_identity: Dict[Tuple[str, Optional[int]], List[Dict[str, Any]]] = {}
    common_by_identity: Dict[Optional[int], List[Dict[str, Any]]] = {}
    for ev in events or []:
        event_name = str((ev or {}).get("event_name") or "")
        source_event_name = str((ev or {}).get("source_event_name") or "")
        if event_name != LAYER3_COMMON_EVENT_NAME and source_event_name != LAYER3_COMMON_EVENT_NAME:
            continue
        stats["common_seen"] += 1
        parsed = _parse_layer3_blob(_extract_event_value_str(ev), LAYER3_COMMON_FIELD_IDS)
        if parsed:
            ev["_layer3_common"] = parsed
        identity = _safe_int(parsed.get("message_identity"))
        key = (str(ev.get("time") or ""), identity)
        common_by_time_identity.setdefault(key, []).append(ev)
        common_by_identity.setdefault(identity, []).append(ev)

    for sample in kpi_samples or []:
        if str((sample or {}).get("name") or "") != LAYER3_3GPP_MESSAGE_NAME:
            continue
        parsed = _parse_layer3_blob((sample or {}).get("value_str"), LAYER3_3GPP_FIELD_IDS)
        identity = _safe_int(parsed.get("message_identity"))
        if identity is None:
            continue
        stats["threegpp_seen"] += 1
        time_iso = str((sample or {}).get("time") or "")
        message_name = _canonical_message_name(_infer_layer3_message_name(parsed))
        decoded: Dict[str, Any] = {}
        decode_limit = limits.get(message_name)
        if decode_limit is None and decode_unknown_nr and _safe_int(parsed.get("protocol")) == 90:
            decode_limit = 64
        if decode_limit is None and _safe_int(parsed.get("protocol")) == 30:
            decode_limit = 512  # Decode all EPS NAS messages
        should_attempt_decode = decode_limit is not None and decode_counts.get(message_name, 0) < int(decode_limit)
        if should_attempt_decode:
            decode_counts[message_name] = int(decode_counts.get(message_name, 0) or 0) + 1
            decoded = _decode_layer3_rrc_payload(parsed, message_name)
        if isinstance(decoded, dict) and decoded.get("ok") and str(decoded.get("message_id") or "").strip():
            message_name = _canonical_message_name(decoded.get("message_id"))
        if decoded.get("ok"):
            stats["decoded"] += 1
        event_name = _layer3_event_name(parsed, message_name)
        direction = LAYER3_DIRECTION_LABELS.get(_safe_int(parsed.get("direction_code")), "")
        category = "RRC" if _safe_int(parsed.get("protocol")) in (26, 90) else "L3"
        payload = parsed.get("payload_bytes")
        patch = {
            "event_name": event_name,
            "source_event_name": LAYER3_3GPP_MESSAGE_NAME,
            "message": message_name,
            "details": _compact_layer3_summary(parsed, message_name, decoded),
            "fullDecodedMessage": _compact_layer3_summary(parsed, message_name, decoded),
            "category": category,
            "direction": direction,
            "layer3": parsed,
            "payload": bytes(payload).hex() if isinstance(payload, (bytes, bytearray)) else "",
        }
        if decoded.get("ok"):
            patch["decoded_json"] = decoded.get("decoded_json")
            patch["rrc_message_id"] = decoded.get("message_id") or message_name
            patch["rrc_message_summary"] = decoded.get("summary") or {}
            summary = decoded.get("summary") or {}
            if isinstance(summary, dict):
                release_cause = str(summary.get("releaseCause") or "").strip()
                if release_cause:
                    patch["rrc_rel_cause"] = release_cause
                reestablishment_cause = str(summary.get("reestablishmentCause") or "").strip()
                if reestablishment_cause:
                    patch["parsedEstablishmentCause"] = reestablishment_cause
                rlf_root_cause = str(summary.get("rlfRootCause") or "").strip()
                if rlf_root_cause:
                    patch["rlf_root_cause"] = rlf_root_cause
            # NAS container decoded within DL/UL InformationTransfer
            if decoded.get("nas_decoded_json") is not None:
                patch["nas_decoded_json"] = decoded["nas_decoded_json"]
                patch["nas_message_type"] = decoded.get("nas_message_type")
                patch["nas_summary"] = decoded.get("nas_summary") or {}
            # NR RRC structured summary
            if decoded.get("nr_rrc_summary") is not None:
                patch["nr_rrc_summary"] = decoded["nr_rrc_summary"]
            if decoded.get("lte_rrc_summary") is not None:
                patch["lte_rrc_summary"] = decoded["lte_rrc_summary"]
        # EPS NAS protocol — use NAS-specific fields
        if _safe_int(parsed.get("protocol")) == 30:
            patch["category"] = "NAS"
            if decoded.get("ok"):
                patch["nas_message_type"] = decoded.get("nas_message_type") or patch.get("message")
                patch["nas_summary"] = decoded.get("summary") or {}

        params_patch = _layer3_params_patch(parsed, message_name, decoded)
        target = _pop_matching_common_layer3_event(common_by_time_identity, common_by_identity, time_iso, identity)
        if target is not None:
            _attach_patch_to_event(target, patch, params_patch)
            stats["matched"] += 1
            continue

        new_event = {
            "time": time_iso,
            "event_name": event_name,
            "metric_id": sample.get("metric_id"),
            "params": [],
        }
        _attach_patch_to_event(new_event, patch, params_patch)
        events.append(new_event)
        stats["appended"] += 1

    # Name any common Layer3 wrappers that did not have a matching 3GPP payload row.
    for ev in events or []:
        event_name = str((ev or {}).get("event_name") or "")
        source_event_name = str((ev or {}).get("source_event_name") or "")
        if event_name != LAYER3_COMMON_EVENT_NAME and source_event_name != LAYER3_COMMON_EVENT_NAME:
            continue
        parsed = ev.get("_layer3_common") if isinstance(ev.get("_layer3_common"), dict) else _parse_layer3_blob(_extract_event_value_str(ev), LAYER3_COMMON_FIELD_IDS)
        if not parsed:
            continue
        message_name = _infer_layer3_message_name(parsed)
        patch = {
            "event_name": _layer3_event_name(parsed, message_name),
            "source_event_name": LAYER3_COMMON_EVENT_NAME,
            "message": message_name,
            "details": _compact_layer3_summary(parsed, message_name, None),
            "fullDecodedMessage": _compact_layer3_summary(parsed, message_name, None),
            "category": "RRC" if _safe_int(parsed.get("protocol")) in (26, 90) else "L3",
            "layer3": parsed,
        }
        _attach_patch_to_event(ev, patch, _layer3_params_patch(parsed, message_name, None))
    for ev in events or []:
        if isinstance(ev, dict):
            ev.pop("_layer3_common", None)
    return stats


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
    norm_index: Optional[Dict[Tuple[str, str], List[Dict[str, Any]]]] = None,
) -> None:
    if not time_iso or not event_name:
        return
    targets = events_by_key.get((time_iso, event_name), [])
    if not targets and norm_index is not None:
        # Try last-segment match: "Errc.DcchUl.MeasurementReport" → "measurementreport"
        # matches "LteRrc.MeasurementReport" → "measurementreport"
        _norm = event_name.split(".")[-1].lower().replace("_", "")
        targets = norm_index.get((time_iso, _norm), [])
    if not targets:
        # Create a synthetic event if none exists for this signaling KPI
        new_ev = {
            "time": time_iso,
            "event_name": event_name,
            "category": "SIGNALING",
            "params": [],
            "_synthetic": True
        }
        targets = [new_ev]
        events_by_key.setdefault((time_iso, event_name), []).append(new_ev)

    for ev in targets:
        _attach_patch_to_event(ev, patch or {}, params_patch or {})
    return targets


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
    # Secondary index keyed by (time_iso, last_segment_lc) for name-variant tolerance.
    # Uses the last dot-separated segment so "Errc.DcchUl.MeasurementReport" and
    # "LteRrc.MeasurementReport" both normalize to "measurementreport".
    _norm_msg_type_index: Dict[Tuple[str, str], List[Dict[str, Any]]] = {}
    for ev in events or []:
        ev_time = str(ev.get("time") or "")
        ev_name = str(ev.get("event_name") or "")
        key = (ev_time, ev_name)
        events_by_key.setdefault(key, []).append(ev)
        _norm = ev_name.split(".")[-1].lower().replace("_", "")
        _norm_key = (ev_time, _norm)
        _norm_msg_type_index.setdefault(_norm_key, []).append(ev)

    for s in kpi_samples or []:
        name = str((s or {}).get("name") or "")
        lower_name = name.lower()
        is_sib1_metric = "systeminformationblocktype1" in lower_name
        
        _last_seg_lc = name.split(".")[-1].lower()
        _is_mr_metric = name == LTE_MR_METRIC_NAME or _last_seg_lc == _LTE_MR_METRIC_LAST_SEG
        _is_recfg_metric = name == LTE_RECFG_METRIC_NAME or _last_seg_lc == _LTE_RECFG_LAST_SEG
        _is_extra_metric = name in LTE_RRC_EXTRA_PER_METRIC_NAMES or _last_seg_lc in _LTE_RRC_EXTRA_LAST_SEGS
        if (
            not _is_mr_metric
            and not _is_recfg_metric
            and not _is_extra_metric
            and not is_sib1_metric
        ):
            continue
        payload = _sample_payload_bytes(s or {})
        if not payload:
            continue
        time_iso = str((s or {}).get("time") or "")

        if _is_mr_metric:
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
                _apply_decode_to_matching_events(events_by_key, time_iso, name, fail_patch, fail_params, norm_index=_norm_msg_type_index)
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
            patch["message"] = "MeasurementReport"
            patch["details"] = f"measId: {summary.get('measId')}"
            patch["category"] = "SIGNALING"
            patch["direction"] = "UL"
            s.update(patch)
            _apply_decode_to_matching_events(events_by_key, time_iso, name, patch, params_patch, norm_index=_norm_msg_type_index)
            continue

        if _is_recfg_metric:
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
                _apply_decode_to_matching_events(events_by_key, time_iso, name, fail_patch, fail_params, norm_index=_norm_msg_type_index)
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
            patch["message"] = "RRCConnectionReconfiguration"
            patch["details"] = summary_txt
            patch["category"] = "SIGNALING"
            patch["direction"] = "DL"
            s.update(patch)
            _apply_decode_to_matching_events(events_by_key, time_iso, name, patch, params_patch, norm_index=_norm_msg_type_index)
            continue

        # Additional LTE RRC PER decode profiles — fall back to last-segment lookup for Nemo names
        prefix = (
            LTE_RRC_EXTRA_PER_EVENT_PREFIX.get(name)
            or _LTE_RRC_EXTRA_LAST_SEG_TO_PROFILE.get(_last_seg_lc)
            or ("sib1" if "systeminformationblocktype1" in lower_name else "rrc_msg")
        )
        stats["rrc_extra_seen"] += 1
        dec = decode_rrc_event_payload(payload, name)
        if not dec.get("ok"):
            # Fallback: try generic container decoder with inferred channel.
            # ETSI names carry channel in path (dcchdl/dcchul/bcch).
            # Nemo names have no channel — infer from known UL/DL message types.
            _fb_channel: Optional[int] = None
            if "dcchdl" in lower_name or "ccch_dl" in lower_name or "ccchdl" in lower_name:
                _fb_channel = 22
            elif "dcchul" in lower_name or "ccch_ul" in lower_name or "ccchul" in lower_name:
                _fb_channel = 20
            elif "bcch" in lower_name:
                _fb_channel = 6
            elif _fb_channel is None:
                # Nemo name: infer channel from message name (last segment)
                _dl_suffixes = ("setup", "release", "reestablishment", "reject", "command",
                                "reconfiguration", "enquiry", "dlinfotransfer",
                                "dlinformationtransfer", "mobilityfromeutracommand",
                                "systeminformation")
                _ul_suffixes = ("request", "complete", "response", "report",
                                "ulinformationtransfer", "ulinfotransfer",
                                "uecapabilityinformation", "handoverfromeutrapreparationrequest")
                if any(_last_seg_lc.endswith(s) for s in _dl_suffixes):
                    _fb_channel = 22  # DL-DCCH
                elif any(_last_seg_lc.endswith(s) for s in _ul_suffixes):
                    _fb_channel = 20  # UL-DCCH
                elif "systeminformationblock" in _last_seg_lc:
                    _fb_channel = 6   # BCCH-DL-SCH
            _fb_name = _canonical_message_name(name.rsplit(".", 1)[-1]) if "." in name else prefix
            _fb_dec = _decode_layer3_lte_rrc_container(payload, _fb_channel, _fb_name)
            if not (isinstance(_fb_dec, dict) and _fb_dec.get("ok")):
                # Last resort: lenient mode ignores score/name matching — shows best-effort decode
                _fb_dec = _decode_layer3_lte_rrc_container(payload, _fb_channel, _fb_name, lenient=True)
            if isinstance(_fb_dec, dict) and _fb_dec.get("ok"):
                dec = _fb_dec
            else:
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
                _apply_decode_to_matching_events(events_by_key, time_iso, name, fail_patch, fail_params, norm_index=_norm_msg_type_index)
                continue

        stats["rrc_extra_decoded"] += 1
        # Derive canonical message name: prefer decoded JSON inference, then metric name last segment
        _inferred_from_json = _decoded_message_name_from_json(dec.get("decoded_json") or {})
        _canonical_from_name = _canonical_message_name(name.rsplit(".", 1)[-1]) if "." in name else None
        msg_id = _canonical_message_name(_inferred_from_json) or _canonical_from_name or str(dec.get("message_id") or prefix)
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
        patch["message"] = msg_id
        patch["details"] = summary_txt
        patch["category"] = "SIGNALING"
        
        # Simple Direction Inference
        low_id = msg_id.lower()
        if "request" in low_id or "report" in low_id or "complete" in low_id:
            patch["direction"] = "UL"
        elif "setup" in low_id or "reconfiguration" in low_id or "sib" in low_id or "systeminformation" in low_id:
            patch["direction"] = "DL"
        elif "release" in low_id or "reject" in low_id or "paging" in low_id or "command" in low_id or "enquiry" in low_id:
            patch["direction"] = "DL"
        elif "transfer" in low_id and low_id.startswith("dl"):
            patch["direction"] = "DL"
        elif "transfer" in low_id and low_id.startswith("ul"):
            patch["direction"] = "UL"
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
        new_events = _apply_decode_to_matching_events(events_by_key, time_iso, name, patch, params_patch, norm_index=_norm_msg_type_index)
        if new_events:
            for ne in new_events:
                if ne.get("_synthetic") and ne not in events:
                    events.append(ne)

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

    metric_id = _safe_int(sample.get("metric_id"))
    base_metric_id = _safe_int(sample.get("base_metric_id"))
    if metric_id is not None and base_metric_id is not None and metric_id >= base_metric_id:
        candidates.append(metric_id - base_metric_id)

    expanded_name = str(sample.get("expanded_name") or "")
    if expanded_name:
        m = re.search(r"\[(\d+)\](?!.*\[\d+\])", expanded_name)
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
    # Fast path: kpi_index keys already represent all distinct metric names
    kpi_index = entry.get("kpi_index")
    if kpi_index:
        out.update(kpi_index.keys())
    else:
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

    raw_vals: List[int] = []
    serving_vals: set[int] = set()
    kpi_index = entry.get("kpi_index")
    if kpi_index:
        # Fast path: use kpi_index instead of scanning all 479K samples
        for m in LTE_NEIGHBOR_EARFCN_METRICS:
            for s in (kpi_index.get(m) or []):
                v = _safe_int((s or {}).get("value_num"))
                if v is not None:
                    raw_vals.append(v)
        for m_name in kpi_index:
            ml = m_name.lower()
            if "radio.lte.servingcell" in ml and "earfcn" in ml and "neighbor" not in ml:
                for s in (kpi_index.get(m_name) or []):
                    v = _safe_int((s or {}).get("value_num"))
                    if v is not None:
                        serving_vals.add(v)
    else:
        samples = entry.get("kpi_samples") or []
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


def _is_serving_array_metric(metric_name: str) -> bool:
    name = str(metric_name or "")
    return "Radio.Lte.ServingCell[" in name or "Radio.Nr.ServingCell[" in name


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
    Extract LTE and NR neighbor metrics directly from decoded TRP KPI samples (not from catalog),
    grouped by exact metric name with sample_count.
    """
    pat = re.compile(r"^(?:Radio\.Lte\.Neighbor|Radio\.Nr\.Neighbor|Radio\.Nr\.StrongestSsbBeam)\[(\d+)\]\.(Pci|Rsrp|Rsrq|Cinr|Sinr|Earfcn|NrArfcn|Frequency)$", re.IGNORECASE)
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
        
        raw_field = str(m.group(2) or "")
        field_lower = raw_field.lower()
        if field_lower == "nrarfcn":
            mapped_field = "Earfcn"
        elif field_lower == "sinr":
            mapped_field = "Cinr"
        else:
            mapped_field = raw_field

        sample_indexes = sorted(int(v) for v in (row.get("sample_indexes") or set()))
        out.append({
            "name": name,
            "neighbor_index": int(m.group(1)),
            "field": mapped_field,
            "sample_count": int(row.get("sample_count") or 0),
            "sample_indexes": sample_indexes,
            "sample_index_count": len(sample_indexes),
        })
    out.sort(key=lambda r: (int(r.get("neighbor_index") or 0), str(r.get("field") or "").lower(), str(r.get("name") or "").lower()))
    return out


def _build_catalog_payload(entry: Dict[str, Any]) -> Dict[str, Any]:
    cat = entry.get("catalog") or {}
    signals = cat.get("signals") or []
    events = entry.get("events") or []
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
    event_grouped = {}
    for ev in events:
        name = str(ev.get("event_name") or "")
        if not name:
            continue
        # Derive a root/category from the event name (e.g. Message.Layer3 -> Message)
        parts = name.split(".")
        root = parts[0] if len(parts) > 1 else "Generic"
        if root not in event_grouped:
            event_grouped[root] = []
        
        # Check if already in this root's list
        found = False
        for row in event_grouped[root]:
            if row["event_name"] == name:
                row["count"] += 1
                found = True
                break
        if not found:
            event_grouped[root].append({
                "event_name": name,
                "count": 1
            })

    return {
        "status": "success",
        "signals": signals,
        "kpis": cat.get("kpis") or [],
        "events": events,
        "metricsFlat": metrics_flat,
        "metricsTree": cat.get("metricsTree") or [],
        "eventsGrouped": event_grouped,
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
        decl_path = os.path.join(extracted_root, "trp/providers/sp1/cdf/declarations.cdf")
        lookup_path = os.path.join(extracted_root, "trp/providers/sp1/cdf/lookuptables.cdf")
        data_cdf_path = os.path.join(extracted_root, "trp/providers/sp1/cdf/data.cdf")
        decl_size = os.path.getsize(decl_path) if os.path.exists(decl_path) else None
        lookup_size = os.path.getsize(lookup_path) if os.path.exists(lookup_path) else None
        data_cdf_size = os.path.getsize(data_cdf_path) if os.path.exists(data_cdf_path) else None

        # CDF declarations/lookups
        decls, unknown_decl_records = parse_declarations_cdf(decl_path)
        lookups = parse_lookup_tables_cdf(lookup_path)
        print(f"[TRP_IMPORT] parsed CDF declarations: {len(decls)}  lookups: {len(lookups)}  unknown_decl_records: {len(unknown_decl_records)}  ({time.time()-t0:.2f}s)")

        # Decode KPI samples from data.cdf (this gives the big KPI set)
        dec0 = time.time()
        decoded = decode_cdf_data_variant(extracted_root, decls, lookups, base_time_iso=None)
        kpi_samples = decoded.get("kpiSamples") or []
        events = decoded.get("events") or []
        frames = decoded.get("frames")
        print(f"[TRP_IMPORT] decoded from data.cdf kpis={len(kpi_samples)} events={len(events)} frames={frames} ({time.time()-dec0:.2f}s)")

        l3_0 = time.time()
        layer3_stats = _enrich_layer3_messages_in_place(kpi_samples, events)
        print(
            "[TRP_IMPORT] Layer3 enrich "
            f"common={layer3_stats.get('common_seen', 0)} "
            f"3gpp={layer3_stats.get('threegpp_seen', 0)} "
            f"matched={layer3_stats.get('matched', 0)} "
            f"appended={layer3_stats.get('appended', 0)} "
            f"asn1={layer3_stats.get('decoded', 0)} "
            f"({time.time()-l3_0:.2f}s)"
        )

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
                "declarations_cdf_size": decl_size,
                "lookuptables_cdf_size": lookup_size,
                "data_cdf_size": data_cdf_size,
                "declarations_count": len(decls),
                "lookups_count": len(lookups),
                "per_decode": per_stats,
                "layer3_decode": layer3_stats,
                "serving_neighbors_index_warnings": len(serving_neighbors_index.warnings),
                "sidebar_info_fields": sorted(list(sidebar_info.keys())),
                "l1l2_fields_available": sorted(list((l1l2_scheduler_index.get("fields") or {}).keys())),
            },
        }

        # ---- Derive Packet Technology series ----
        # Classify each timestamp as 5G NR / LTE / 3G based on which serving-cell metrics
        # have a sample at that moment.  The result is stored as a string-valued KPI so the
        # frontend can display sample counts per technology and color-code the map points.
        _TECH_NR_METRICS  = {"Radio.Nr.ServingCell[16].SsRsrp", "Radio.Nr.ServingCell[16].SsRsrq",
                              "Radio.Nr.ServingCell[16].SsSinr", "Radio.Nr.ServingCell[16].Pci"}
        _TECH_LTE_METRICS = {"Radio.Lte.ServingCell[8].Rsrp", "Radio.Lte.ServingCell[8].Rsrq",
                             "Radio.Lte.ServingCell[8].Pci", "Radio.Lte.ServingCell[8].RsSinr"}
        _TECH_3G_METRICS  = {"Radio.Wcdma.ServingCell.Rscp", "Radio.Wcdma.ServingCell.EcNo",
                             "Radio.Wcdma.ServingCell.Sc",   "Radio.Umts.ServingCell.Rscp"}

        # Build per-timestamp presence sets
        _ts_nr:  set = set()
        _ts_lte: set = set()
        _ts_3g:  set = set()
        for _s in kpi_samples:
            _nm = _s.get("name") or ""
            _t  = _s.get("time") or _s.get("t") or ""
            if not _t:
                continue
            if _nm in _TECH_NR_METRICS:
                _ts_nr.add(_t)
            elif _nm in _TECH_LTE_METRICS:
                _ts_lte.add(_t)
            elif _nm in _TECH_3G_METRICS:
                _ts_3g.add(_t)

        _tech_samples: List[Dict[str, Any]] = []
        for _t in sorted(_ts_nr | _ts_lte | _ts_3g):
            if _t in _ts_nr:
                _tech = "5G NR"
            elif _t in _ts_lte:
                _tech = "LTE"
            else:
                _tech = "3G"
            _tech_samples.append({
                "name":      "__derived_packet_technology",
                "time":      _t,
                "value_num": None,
                "value_str": _tech,
                "dtype":     "str",
                "unit":      "",
            })

        if _tech_samples:
            kpi_samples = kpi_samples + _tech_samples
            print(f"[TRP_IMPORT] derived packet_technology: NR={len(_ts_nr)} LTE={len(_ts_lte)} 3G={len(_ts_3g)} total={len(_tech_samples)}")

        # GPS expansion ──────────────────────────────────────────────────────
        # When GPS is sparse (calibration tests, static sessions, low-update-rate devices),
        # generate one track point per serving-cell measurement by forward-filling
        # the last known GPS fix.  Only triggers when serving-cell timestamps
        # outnumber GPS track points, so normal dense-GPS drives are unaffected.
        _serving_times_for_expansion = sorted(_ts_lte | _ts_nr | _ts_3g)
        _gps_valid = [
            p for p in track_points
            if _safe_float(p.get("lat")) is not None and _safe_float(p.get("lon")) is not None
        ]
        if _serving_times_for_expansion and _gps_valid and len(_serving_times_for_expansion) > len(_gps_valid):
            _gps_sorted = sorted(_gps_valid, key=lambda p: _to_epoch_ms(p.get("time")) or 0)
            _gps_ms = [_to_epoch_ms(p.get("time")) or 0 for p in _gps_sorted]
            _expanded: List[Dict[str, Any]] = []
            for _t_iso in _serving_times_for_expansion:
                _t_ms = _to_epoch_ms(_t_iso)
                if _t_ms is None:
                    continue
                # Last GPS fix at or before this sample; fall back to earliest fix
                _gi = max(0, bisect.bisect_right(_gps_ms, _t_ms) - 1)
                _gp = _gps_sorted[_gi]
                _expanded.append({
                    "time":  _t_iso,
                    "lat":   _gp.get("lat"),
                    "lon":   _gp.get("lon"),
                    "alt":   _gp.get("alt"),
                    "speed": _gp.get("speed"),
                })
            if _expanded:
                track_points = _expanded
                run["metadata"]["track_points"] = len(track_points)
                print(f"[TRP_IMPORT] GPS-expanded track: {len(track_points)} pts from {len(_gps_valid)} GPS fixes")

        # Store

        # Extract IP packets from ch7 (IPSniffer) into PCAP bytes while the archive is still unpacked
        pcap_bytes, pcap_err = extract_ch7_pcap(extracted_root)
        if pcap_err:
            print(f"[TRP_IMPORT] ch7 PCAP skipped: {pcap_err}")

        # Extract NAS EMM/ESM events from ch1 Qualcomm DIAG stream
        nas_events, nas_err = extract_ch1_nas_events(extracted_root)
        if nas_err:
            print(f"[TRP_IMPORT] ch1 NAS extraction skipped: {nas_err}")
        elif nas_events:
            events = sorted(
                events + nas_events,
                key=lambda e: str(e.get('time') or ''),
            )
            print(f"[TRP_IMPORT] ch1 NAS events merged: {len(nas_events)}")

        # Extract RRC events from ch1 B0C0 (LTE_RRC_OTA_PACKET) stream
        rrc_events, rrc_err = extract_ch1_rrc_events(extracted_root)
        if rrc_err:
            print(f"[TRP_IMPORT] ch1 RRC extraction skipped: {rrc_err}")
        elif rrc_events:
            events = sorted(
                events + rrc_events,
                key=lambda e: str(e.get('time') or ''),
            )
            print(f"[TRP_IMPORT] ch1 RRC events merged: {len(rrc_events)}")

        import_report = {
            "decodedSamples": int(len(kpi_samples)),
            "decodedEvents": int(len(events)),
            "trackPoints": int(len(track_points)),
            "decodedFrames": int(frames or 0),
            "declarationsCount": int(len(decls)),
            "lookupsCount": int(len(lookups)),
            "declarationsCdfSize": int(decl_size or 0),
            "lookuptablesCdfSize": int(lookup_size or 0),
            "dataCdfSize": int(data_cdf_size or 0),
            "sidebarInfoFields": sorted(list(sidebar_info.keys())),
        }
        if nas_err:
            import_report["nasWarning"] = nas_err
        if rrc_err:
            import_report["rrcWarning"] = rrc_err

        if len(kpi_samples) <= 0:
            reasons = []
            if decl_size == 0:
                reasons.append("declarations.cdf is empty")
            if lookup_size == 0:
                reasons.append("lookuptables.cdf is empty")
            if data_cdf_size and frames == 0:
                reasons.append("data.cdf produced 0 decodable KPI frames")
            if not reasons:
                reasons.append("the archive did not expose any KPI samples with the current decoder")
            message = (
                "TRP import could read the route track, but no KPI samples could be decoded. "
                + "Likely cause: " + "; ".join(reasons) + ". "
                + "This TRP encoding is not supported yet by the current importer."
            )
            print(f"[TRP_IMPORT] FAIL {message}")
            return {
                "ok": False,
                "runId": None,
                "kpi_count": 0,
                "event_count": len(events),
                "track_count": len(track_points),
                "message": message,
                "importReport": import_report,
            }

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
            "pcap_bytes": pcap_bytes,
        }

        return {
            "ok": True,
            "runId": run_id,
            "kpi_count": len(kpi_samples),
            "event_count": len(events),
            "track_count": len(track_points),
            "message": "Decode completed (in-memory data.cdf)",
            "importReport": import_report,
        }
    finally:
        # Keep extracted dir? no, remove to avoid /var/folders bloat
        try:
            import shutil
            shutil.rmtree(extract_dir, ignore_errors=True)
        except Exception:
            pass


def _build_kpi_index(kpi_samples: List[Dict]) -> Dict[str, List[Dict]]:
    """Build name→samples index sorted by t_ms (used by Nemo virtual runs)."""
    idx: Dict[str, List[Dict]] = {}
    for s in (kpi_samples or []):
        name = str((s or {}).get("name") or "")
        if name:
            idx.setdefault(name, []).append(s)
    for lst in idx.values():
        lst.sort(key=lambda s: s.get("t_ms") or 0)
    return idx


def _build_kpi_time_arrays(kpi_index: Dict[str, List[Dict]]) -> Dict[str, List[int]]:
    """Build name→[t_ms, ...] parallel arrays for O(log N) bisect time-window queries."""
    return {name: [s.get("t_ms") or 0 for s in samples]
            for name, samples in kpi_index.items()}


def _kpi_samples_in_window(
    kpi_index: Dict[str, List[Dict]],
    kpi_time_arrays: Dict[str, List[int]],
    metric: str,
    t_lo: int,
    t_hi: int,
) -> List[Dict]:
    """Return samples for metric with t_ms in [t_lo, t_hi] using binary search."""
    t_arr = kpi_time_arrays.get(metric)
    if not t_arr:
        return []
    lo_i = bisect.bisect_left(t_arr, t_lo)
    hi_i = bisect.bisect_right(t_arr, t_hi)
    return (kpi_index.get(metric) or [])[lo_i:hi_i]


def register_external_run(entry: Dict[str, Any]) -> int:
    """Register a pre-built run entry (e.g. from Nemo LTE import) into _RUNS. Returns run_id."""
    global _NEXT_ID
    run_id = _NEXT_ID
    _NEXT_ID += 1
    entry.setdefault("run", {})["id"] = run_id
    entry.setdefault("events", [])
    entry.setdefault("track_points", [])
    entry.setdefault("kpi_samples", [])
    entry.setdefault("catalog", {"signals": [], "kpis": [], "events": []})
    entry.setdefault("sidebar", {"groups": [], "info": {}})
    entry.setdefault("serving_neighbors_index", {})
    # Build per-metric index + sorted time arrays for O(log N) time-window queries
    if "kpi_index" not in entry:
        entry["kpi_index"] = _build_kpi_index(entry["kpi_samples"])
    if "kpi_time_arrays" not in entry:
        entry["kpi_time_arrays"] = _build_kpi_time_arrays(entry["kpi_index"])
    # Pre-set valid l1l2 sentinel so _get_l1l2_scheduler_index won't scan 479K samples
    if not entry.get("l1l2_scheduler_index"):
        entry["l1l2_scheduler_index"] = {
            "fields": {},
            "availability": {
                "perDecodeSupported": False,
                "rawPayloadEventsDetected": False,
                "matchingPayloadEvents": [],
                "limitations": ["No L1/L2 scheduler data available for this run type."],
            },
        }
    _RUNS[run_id] = entry
    return run_id


def list_runs(db_path: Optional[str] = None) -> List[Dict[str, Any]]:
    return [v["run"] for k, v in sorted(_RUNS.items(), key=lambda kv: kv[0])]


def fetch_run_pcap(db_path: Optional[str], run_id: int) -> Optional[bytes]:
    """Return cached PCAP bytes for a run, or None if no ch7 data was captured."""
    rid = int(run_id)
    if rid not in _RUNS:
        raise KeyError("Run not found")
    return _RUNS[rid].get("pcap_bytes")


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


def fetch_signaling_window_decode(
    db_path: Optional[str],
    run_id: int,
    center_iso: str,
    window_ms: int = 30000,
) -> Dict[str, Any]:
    rid = int(run_id)
    if rid not in _RUNS:
        return {"status": "error", "message": "Run not found"}
    center_ms = _to_epoch_ms(center_iso)
    if center_ms is None:
        return {"status": "error", "message": "Invalid time"}
    half_window = max(1000, int(window_ms))
    entry = _RUNS[rid]
    kpi_samples = entry.get("kpi_samples") or []
    events = entry.get("events") or []

    def _within(value: Any) -> bool:
        ts = _to_epoch_ms(value)
        return ts is not None and abs(int(ts) - int(center_ms)) <= half_window

    window_kpis = [
        s for s in kpi_samples
        if str((s or {}).get("name") or "") == LAYER3_3GPP_MESSAGE_NAME and _within((s or {}).get("time") or (s or {}).get("t"))
    ]

    # Layer3 common events: need enrichment via _enrich_layer3_messages_in_place
    _common_names = (LAYER3_COMMON_EVENT_NAME, LAYER3_3GPP_MESSAGE_NAME)
    window_events = [
        ev for ev in events
        if _within((ev or {}).get("time"))
        and (
            str((ev or {}).get("event_name") or "") in _common_names
            or str((ev or {}).get("source_event_name") or "") in _common_names
        )
    ]

    if not window_kpis and not window_events:
        return {
            "status": "success",
            "windowMs": half_window,
            "centerTime": center_iso,
            "stats": {"common_seen": 0, "threegpp_seen": 0, "matched": 0, "appended": 0, "decoded": 0},
            "events": [],
        }

    eager_limits = {name: 10_000 for name in LAYER3_FULL_DECODE_MESSAGE_NAMES}
    stats = _enrich_layer3_messages_in_place(window_kpis, window_events, decode_limits=eager_limits, decode_unknown_nr=True)

    # Merge in events decoded by _decode_lte_rrc_payloads_in_place (KPI-sample path).
    # These have category="SIGNALING"/"RRC"/"NAS" and event_name="Message.Layer3.*"
    # but never matched the _common_names filter above, so they'd be invisible otherwise.
    _seen_ids = {id(ev) for ev in window_events}
    _signaling_categories = {"SIGNALING", "RRC", "NAS", "L3"}
    for ev in events:
        if id(ev) in _seen_ids:
            continue
        if not _within((ev or {}).get("time")):
            continue
        cat = str((ev or {}).get("category") or "")
        ename = str((ev or {}).get("event_name") or "")
        if cat in _signaling_categories or ename.lower().startswith("message.layer3."):
            window_events.append(ev)
            _seen_ids.add(id(ev))

    # Deduplicate: same (time_ms, canonical_message, direction) → keep decoded version
    def _to_epoch_ms_local(t: Any) -> int:
        try:
            from datetime import datetime, timezone
            if t is None:
                return 0
            if isinstance(t, (int, float)):
                return int(t)
            dt = datetime.fromisoformat(str(t).replace("Z", "+00:00"))
            return int(dt.timestamp() * 1000)
        except Exception:
            return 0

    _dedup: Dict[Tuple, Any] = {}
    for ev in window_events:
        t_ms = _to_epoch_ms_local((ev or {}).get("time"))
        msg = str((ev or {}).get("message") or "")
        if not msg:
            rrc_id = str((ev or {}).get("rrc_message_id") or "")
            msg = rrc_id if rrc_id else str((ev or {}).get("event_name") or "").split(".")[-1]
        msg_key = msg.lower().replace("_", "").replace("-", "")
        direction = str((ev or {}).get("direction") or "")
        key = (t_ms, msg_key, direction)
        existing = _dedup.get(key)
        if existing is None:
            _dedup[key] = ev
        elif (ev or {}).get("decoded_json") is not None and (existing or {}).get("decoded_json") is None:
            _dedup[key] = ev  # prefer the decoded version
    window_events = list(_dedup.values())

    # Sort merged list chronologically
    window_events.sort(key=lambda e: str((e or {}).get("time") or ""))

    return {
        "status": "success",
        "windowMs": half_window,
        "centerTime": center_iso,
        "stats": stats,
        "events": window_events,
    }


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

    entry = _RUNS[rid]
    kpi_index = entry.get("kpi_index")
    samples = kpi_index[signal] if (kpi_index and signal in kpi_index) else entry.get("kpi_samples") or []
    out: List[Dict[str, Any]] = []
    for s in samples:
        if kpi_index is None and s.get("name") != signal:
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
    idx: Optional[int] = None,
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

    run_entry = _RUNS[rid]
    kpi_index = run_entry.get("kpi_index")
    kpi_time_arrays = run_entry.get("kpi_time_arrays")
    out: List[Dict[str, Any]] = []
    if kpi_index and kpi_time_arrays and metric in kpi_index:
        candidates = _kpi_samples_in_window(kpi_index, kpi_time_arrays, metric, center_ms - tol, center_ms + tol)
    elif kpi_index and metric in kpi_index:
        candidates = kpi_index[metric]
    else:
        candidates = run_entry.get("kpi_samples") or []
    for s in candidates:
        if kpi_index is None and str((s or {}).get("name") or "") != metric:
            continue
        t_ms = _sample_time_ms(s or {})
        if t_ms is None:
            continue
        match_dt_ms = _time_match_delta_ms(t_ms, center_ms)
        if match_dt_ms is None or match_dt_ms > tol:
            continue
        sample_idx = _extract_neighbor_sample_index(s or {})
        if idx is not None and sample_idx != idx:
            continue
        out.append({
            "time": (s or {}).get("time") or _epoch_ms_to_iso(t_ms),
            "t_ms": t_ms,
            "name": metric,
            "value_num": _safe_float((s or {}).get("value_num")),
            "value_str": (s or {}).get("value_str"),
            "dtype": (s or {}).get("dtype") or "num",
            "unit": (s or {}).get("unit") or "",
            "idx": sample_idx,
            "match_dt_ms": match_dt_ms,
        })

    out.sort(key=lambda r: (
        _safe_int(r.get("match_dt_ms")) if _safe_int(r.get("match_dt_ms")) is not None else 10**12,
        _safe_int(r.get("t_ms")) or 0,
        _safe_int(r.get("idx")) or 0,
    ))
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


def _fetch_last_identity_value(
    entry: Dict[str, Any],
    metric_name: str,
    center_ms: int,
    numeric: bool = True,
    idx_filter: Optional[int] = None,
) -> Tuple[Optional[Any], Optional[str]]:
    """Return the most-recent sample of a sparse identity metric (PCI, EARFCN, CellIdentity)
    recorded at or before center_ms, with no age limit.  Falls back to the nearest sample
    overall if nothing precedes center_ms (handles clocks slightly off between GPS and modem).

    When idx_filter is set (e.g. 0), only samples whose array index matches are considered.
    This is critical for ServingCell[8] metrics which carry both PCell (idx=0) and SCell (idx=1+)
    entries — without filtering, the function can mix PCI from SCell with EARFCN from PCell."""
    kpi_index = entry.get("kpi_index")
    if kpi_index is not None and metric_name in kpi_index:
        candidates = kpi_index[metric_name]
    else:
        all_kpis = entry.get("kpi_samples") or []
        candidates = [s for s in all_kpis if s.get("name") == metric_name]

    if not candidates:
        return None, None

    best_val: Optional[Any] = None
    best_t: Optional[int] = None
    fallback_val: Optional[Any] = None
    fallback_dt: Optional[int] = None

    for s in candidates:
        # Filter by array index when required (PCell = idx 0)
        if idx_filter is not None:
            sample_idx = _extract_neighbor_sample_index(s or {})
            if sample_idx != idx_filter:
                continue
        t_ms = _sample_time_ms(s)
        if t_ms is None:
            continue
        raw = s.get("value_num") if numeric else (s.get("value_str") or s.get("value_num"))
        val = _safe_float(raw) if numeric else raw
        if val is None:
            continue
        if t_ms <= center_ms:
            if best_t is None or t_ms > best_t:
                best_val = val
                best_t = t_ms
        else:
            dt = t_ms - center_ms
            if fallback_dt is None or dt < fallback_dt:
                fallback_val = val
                fallback_dt = dt

    if best_val is not None:
        return best_val, None
    return fallback_val, None


def _fetch_recent_metric_value(
    entry: Dict[str, Any],
    metric_name: str,
    center_ms: int,
    idx_filter: Optional[int] = None,
    max_age_ms: int = 3000,
    reject_zero: bool = False,
) -> Optional[float]:
    """Return the freshest backward-matched KPI value within max_age_ms.

    For some serving-array RF metrics, inactive SCell slots can emit placeholder 0
    samples at the exact click time. For LTE RSRP/RSRQ, zero is not a valid RF value,
    so optionally reject it and keep the latest real measurement instead.
    """
    kpi_index = entry.get("kpi_index")
    if kpi_index is not None and metric_name in kpi_index:
        candidates = kpi_index[metric_name]
    else:
        all_kpis = entry.get("kpi_samples") or []
        candidates = [s for s in all_kpis if s.get("name") == metric_name]

    best_val: Optional[float] = None
    best_age: Optional[int] = None
    best_t: Optional[int] = None

    for s in candidates:
        if idx_filter is not None:
            sample_idx = _extract_neighbor_sample_index(s or {})
            if sample_idx != idx_filter:
                continue
        t_ms = _sample_time_ms(s)
        if t_ms is None:
            continue
        age_ms = _backward_time_match_age_ms(t_ms, center_ms)
        if age_ms is None or age_ms > max_age_ms:
            continue
        val = _safe_float((s or {}).get("value_num"))
        if val is None:
            continue
        if reject_zero and abs(val) < 1e-9:
            continue
        if (
            best_val is None
            or best_age is None
            or age_ms < best_age
            or (age_ms == best_age and (best_t is None or t_ms > best_t))
        ):
            best_val = val
            best_age = age_ms
            best_t = t_ms

    return best_val


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
        metric_idx = 0 if _is_serving_array_metric(metric_name) else None
        rows = fetch_samples_in_window(db_path, rid, metric_name, center_iso, tol, idx=metric_idx)
        if not rows:
            return None, metric_name, None
        best = None
        best_dt = None
        best_row = None
        for r in rows:
            dt = _safe_int((r or {}).get("match_dt_ms"))
            if dt is None:
                t_ms = _safe_int((r or {}).get("t_ms"))
                if t_ms is None:
                    continue
                dt = _time_match_delta_ms(t_ms, center_ms)
            if dt is None:
                continue
            val = _safe_float(r.get("value_num")) if numeric else (r.get("value_str") or r.get("value_num"))
            if val is None:
                continue
            if best is None or dt < best_dt:
                best = val
                best_dt = dt
                best_row = r
        source_iso = (best_row or rows[0]).get("time")
        return best, metric_name, source_iso

    # Identity metrics (PCI, EARFCN, cell ID) are emitted only on change — sometimes just once
    # at session start.  Use a backwards-looking "last known value" lookup with no age limit.
    # For ServingCell array metrics we filter to idx=0 (PCell) to avoid picking SCell values
    # when carrier aggregation is active.
    def pick_identity(candidates: List[str], numeric: bool = True) -> Tuple[Optional[Any], Optional[str], Optional[str]]:
        metric_name = _pick_best_metric_name(entry, candidates)
        if not metric_name:
            return None, None, None
        idx_f = 0 if _is_serving_array_metric(metric_name) else None
        val, _ = _fetch_last_identity_value(entry, metric_name, center_ms, numeric=numeric, idx_filter=idx_f)
        return val, metric_name, None

    pci, pci_metric, _ = pick_identity(["Radio.Lte.ServingCell[8].Pci", "Radio.Lte.ServingCell[0].Pci", "Radio.Lte.ServingCellTotal.Pci"])
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
    earfcn, earfcn_metric, _ = pick_identity([
        "Radio.Lte.ServingCell[8].Downlink.Earfcn",
        "Radio.Lte.ServingCell[0].Downlink.Earfcn",
        "Radio.Lte.ServingCellTotal.Downlink.Earfcn",
        "Radio.Lte.ServingCell[8].Earfcn",
    ])
    eci, eci_metric, _ = pick_identity([
        "Radio.Lte.ServingCell[8].CellIdentity.Complete",
        "Radio.Lte.ServingCell[0].CellIdentity.Complete",
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

    # --- SCell detection (carrier aggregation) ---
    # Check for additional serving cells at idx=1, 2, ... (SCells in CA)
    scells: List[Dict[str, Any]] = []
    pci_metric_name = _pick_best_metric_name(entry, ["Radio.Lte.ServingCell[8].Pci", "Radio.Lte.ServingCell[0].Pci"])
    if pci_metric_name and _is_serving_array_metric(pci_metric_name):
        for scell_idx in range(1, 5):  # Up to 4 SCells (CA up to 5CC)
            scell_pci_val, _ = _fetch_last_identity_value(entry, pci_metric_name, center_ms, numeric=True, idx_filter=scell_idx)
            scell_pci = _safe_int(scell_pci_val)
            if scell_pci is None:
                break  # No more SCells

            # Get SCell EARFCN
            earfcn_metric_name = _pick_best_metric_name(entry, [
                "Radio.Lte.ServingCell[8].Downlink.Earfcn",
                "Radio.Lte.ServingCell[0].Downlink.Earfcn",
                "Radio.Lte.ServingCell[8].Earfcn",
            ])
            scell_earfcn_val = None
            if earfcn_metric_name and _is_serving_array_metric(earfcn_metric_name):
                scell_earfcn_val, _ = _fetch_last_identity_value(entry, earfcn_metric_name, center_ms, numeric=True, idx_filter=scell_idx)
            scell_earfcn = _safe_int(scell_earfcn_val)

            # Get SCell RSRP (from time window, idx-filtered)
            rsrp_metric_name = _pick_best_metric_name(entry, ["Radio.Lte.ServingCell[8].Rsrp"])
            scell_rsrp = None
            if rsrp_metric_name:
                scell_rsrp = _fetch_recent_metric_value(
                    entry,
                    rsrp_metric_name,
                    center_ms,
                    idx_filter=scell_idx,
                    max_age_ms=max(3000, tol * 3),
                    reject_zero=True,
                )

            # Get SCell RSRQ
            rsrq_metric_name = _pick_best_metric_name(entry, ["Radio.Lte.ServingCell[8].Rsrq"])
            scell_rsrq = None
            if rsrq_metric_name:
                scell_rsrq = _fetch_recent_metric_value(
                    entry,
                    rsrq_metric_name,
                    center_ms,
                    idx_filter=scell_idx,
                    max_age_ms=max(3000, tol * 3),
                    reject_zero=True,
                )

            # Get SCell SINR
            sinr_metric_name = _pick_best_metric_name(entry, [
                "Radio.Lte.ServingCell[8].RsSinr",
                "Radio.Lte.ServingCell[8].Sinr",
                "Radio.Lte.ServingCell[8].Cinr",
            ])
            scell_sinr = None
            if sinr_metric_name:
                scell_sinr = _fetch_recent_metric_value(
                    entry,
                    sinr_metric_name,
                    center_ms,
                    idx_filter=scell_idx,
                    max_age_ms=max(3000, tol * 3),
                )

            scells.append({
                "pci": scell_pci,
                "earfcn": scell_earfcn,
                "rsrp": scell_rsrp,
                "rsrq": scell_rsrq,
                "sinr": scell_sinr,
                "idx": scell_idx,
            })

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
        "scells": scells,
        "ca_active": len(scells) > 0,
        "sourceMetrics": {
            "pci": pci_metric,
            "rsrp": rsrp_metric,
            "rsrq": rsrq_metric,
            "sinr": sinr_metric,
            "earfcn": earfcn_metric,
            "cellIdentityComplete": eci_metric,
        },
    }


MRDC_CELL_FIELD_METRICS = {
    "Radio.Common.Mrdc.Cell[64].Pci": "pci",
    "Radio.Common.Mrdc.Cell[64].Rsrp": "rsrp",
    "Radio.Common.Mrdc.Cell[64].Rsrq": "rsrq",
    "Radio.Common.Mrdc.Cell[64].Sinr": "sinr",
    "Radio.Common.Mrdc.Cell[64].Type": "type",
    "Radio.Common.Mrdc.Cell[64].Technology": "technology",
    "Radio.Common.Mrdc.Cell[64].Band": "band",
    "Radio.Common.Mrdc.Cell[64].Channel": "channel",
}
# Decoded from this TRP family's lookup tables (MrdcCellTypeValue / RadioTechnology).
MRDC_CELL_TYPE_LABELS = {0: "Serving", 1: "PCell", 2: "SCell", 3: "Neighbor", 4: "IntersystemNeighbor"}
MRDC_RADIO_TECH_LABELS = {0: "Invalid", 1: "WCDMA", 2: "GSM", 3: "CDMA", 4: "EVDO", 5: "AMPS", 6: "WiMAX", 7: "LTE", 8: "WiFi", 9: "NR"}
# Roles that represent a cell the UE is actually served by (vs scanned neighbours).
_MRDC_SERVING_TYPES = {"Serving", "PCell", "SCell"}


def build_mrdc_cells_at_time(
    db_path: Optional[str],
    run_id: int,
    center_iso: str,
    tol_ms: int = 200,
) -> Dict[str, Any]:
    """Reconstruct the MRDC serving-cell array (Radio.Common.Mrdc.Cell[64].*) at a timestamp.

    MRDC/EN-DC TRPs pack the LTE PCell, NR PSCell and CA SCells into one indexed array
    whose fields (Pci/Rsrp/Rsrq/Sinr/Type/Technology/Band/Channel) are emitted on change at
    slightly different times, so each field is backward-matched per array index — the same
    technique as build_neighbors_at_time. Returns the cells flagged as actually serving
    (Serving/PCell/SCell), labelled by decoded Type and Technology."""
    rid = int(run_id)
    if rid not in _RUNS:
        return {"status": "error", "message": "Run not found"}
    center_ms = _to_epoch_ms(center_iso)
    if center_ms is None:
        return {"status": "error", "message": "Invalid time"}

    entry = _RUNS[rid]
    tol = int(max(20, _safe_int(tol_ms) or 1500))
    # The MRDC Cell[64] array re-packs cells across indices on every report (it is a fresh,
    # RSRP-sorted snapshot, not fixed slots — a single PCI is seen at 20+ indices over time),
    # so a coherent cell list only exists WITHIN one report timestamp. We therefore snap to the
    # nearest report rather than backward-matching per index (which mixes physical cells).
    snap_window = max(8000, tol * 5)

    kpi_index = entry.get("kpi_index")
    kpi_time_arrays = entry.get("kpi_time_arrays")
    candidates: List[Dict] = []
    if kpi_index and kpi_time_arrays:
        t_lo = center_ms - snap_window
        t_hi = center_ms + snap_window
        for metric_name in MRDC_CELL_FIELD_METRICS:
            candidates.extend(_kpi_samples_in_window(kpi_index, kpi_time_arrays, metric_name, t_lo, t_hi))
    elif kpi_index:
        for metric_name in MRDC_CELL_FIELD_METRICS:
            candidates.extend(kpi_index.get(metric_name) or [])
    else:
        candidates = entry.get("kpi_samples") or []

    # Group every sample by its exact report timestamp -> {idx: {field: (value_num, value_str)}}.
    by_time: Dict[int, Dict[int, Dict[str, Any]]] = {}
    for sample in candidates:
        field = MRDC_CELL_FIELD_METRICS.get(str((sample or {}).get("name") or ""))
        if field is None:
            continue
        t_ms = _sample_time_ms(sample or {})
        if t_ms is None:
            continue
        idx = _extract_neighbor_sample_index(sample or {})
        if idx is None:
            continue
        num = _safe_float((sample or {}).get("value_num"))
        raw_str = (sample or {}).get("value_str")
        if num is None and (raw_str is None or str(raw_str).strip() == ""):
            continue
        by_time.setdefault(int(t_ms), {}).setdefault(int(idx), {})[field] = (num, raw_str)

    # A usable snapshot must carry the cell structure (PCI/Type), not just an RF refresh.
    structure_times = [t for t, snap in by_time.items() if any(("pci" in c or "type" in c) for c in snap.values())]
    if not structure_times:
        return {
            "status": "success", "time": center_iso, "tolMs": tol, "cells": [],
            "debug": {"reason": "no MRDC cell snapshot near time", "reportsScanned": len(by_time)},
        }
    before = [t for t in structure_times if t <= center_ms]
    target_t = max(before) if before else min(structure_times, key=lambda t: abs(t - center_ms))
    # Radio logging can stop long before the GPS track ends (this run: radio ends ~14:58 but
    # the track runs to ~16:28). Without this guard the nearest structure would be minutes
    # stale and shown as if current, so reject snapshots that aren't genuinely near the click.
    SNAPSHOT_MAX_AGE_MS = 15000
    if abs(center_ms - target_t) > SNAPSHOT_MAX_AGE_MS:
        return {
            "status": "success", "time": center_iso, "tolMs": tol, "cells": [],
            "snapshotTime": _epoch_ms_to_iso(target_t),
            "snapshotAgeMs": int(center_ms - target_t),
            "debug": {"reason": "nearest MRDC snapshot too stale (no radio data near this point)"},
        }
    snapshot = by_time[target_t]

    def _enum_code(num):
        # This TRP family stores lookup-enum indices doubled (PCell 1->2, LTE 7->14, NR->22).
        if num is None:
            return None
        code = _safe_int(round(num))
        if code is None:
            return None
        return code // 2 if code % 2 == 0 else code

    def _num(pair):
        return _safe_float(pair[0]) if pair and pair[0] is not None else None

    def _label_from(pair, table):
        # The decoder's value_str applies the lookup table to the *doubled* raw code, so it
        # is systematically wrong for these enums (raw 2 -> "SCell" instead of PCell). Always
        # decode from the numeric code via _enum_code (which halves the doubled index).
        num = pair[0] if pair else None
        code = _enum_code(num)
        if code is None:
            return None
        if code in table:
            return table[code]
        if table is MRDC_RADIO_TECH_LABELS and code >= 9:
            return "NR"
        return str(code)

    cells: List[Dict[str, Any]] = []
    for idx, cell in sorted(snapshot.items()):
        pci = _num(cell.get("pci"))
        rsrp = _num(cell.get("rsrp"))
        rsrq = _num(cell.get("rsrq"))
        sinr = _num(cell.get("sinr"))
        if pci is None and rsrp is None and sinr is None:
            continue
        band_pair = cell.get("band")
        band_label = None
        if band_pair is not None:
            bnum, btxt = band_pair
            band_label = (str(btxt).strip() if btxt is not None and str(btxt).strip()
                          else (_safe_int(round(bnum)) if bnum is not None else None))
        chan = _num(cell.get("channel"))
        cells.append({
            "slotIndex": int(idx),
            "pci": _safe_int(round(pci)) if pci is not None else None,
            "rsrp": rsrp,
            "rsrq": rsrq,
            "sinr": sinr,
            "type": _label_from(cell.get("type"), MRDC_CELL_TYPE_LABELS),
            "technology": _label_from(cell.get("technology"), MRDC_RADIO_TECH_LABELS),
            "band": band_label,
            "channel": _safe_int(round(chan)) if chan is not None else None,
        })

    # Best-effort RF fill: a structure report sometimes omits RF for a cell (common for the
    # NR PSCell), but a nearby report carries it. Within any single report an index pairs a
    # PCI with its RF, so collect the closest-in-time RF per PCI across the window.
    rf_by_pci: Dict[int, Dict[str, float]] = {}
    for t in sorted(by_time, key=lambda tt: abs(tt - target_t)):
        for c in by_time[t].values():
            p = _num(c.get("pci"))
            if p is None:
                continue
            pk = int(round(p))
            bucket = rf_by_pci.setdefault(pk, {})
            for fld in ("rsrp", "rsrq", "sinr"):
                v = _num(c.get(fld))
                if v is not None and fld not in bucket:
                    bucket[fld] = v
    for c in cells:
        pk = c.get("pci")
        if pk is None:
            continue
        bucket = rf_by_pci.get(pk) or {}
        for fld in ("rsrp", "rsrq", "sinr"):
            if c.get(fld) is None and fld in bucket:
                c[fld] = bucket[fld]

    serving_cells = [c for c in cells if str(c.get("type") or "") in _MRDC_SERVING_TYPES]
    # Order: PCell first, then Serving/SCells; strongest RSRP within a tier.
    _type_rank = {"PCell": 0, "Serving": 1, "SCell": 2}
    serving_cells.sort(key=lambda c: (
        _type_rank.get(str(c.get("type") or ""), 9),
        -(c.get("rsrp") if isinstance(c.get("rsrp"), (int, float)) else -9999.0),
        int(c.get("slotIndex") or 0),
    ))
    snapshot_iso = _epoch_ms_to_iso(target_t)
    return {
        "status": "success",
        "time": center_iso,
        "snapshotTime": snapshot_iso,
        "snapshotAgeMs": int(center_ms - target_t),
        "tolMs": tol,
        "cells": serving_cells,
        "debug": {
            "totalCellsReconstructed": len(cells),
            "servingCells": len(serving_cells),
        },
    }


def fetch_mrdc_cells_at_time(
    db_path: Optional[str],
    run_id: int,
    center_iso: str,
    tol_ms: int = 200,
) -> Dict[str, Any]:
    rid = int(run_id)
    if rid not in _RUNS:
        return {"status": "error", "message": "Run not found"}
    if _to_epoch_ms(center_iso) is None:
        return {"status": "error", "message": "Invalid time"}
    return build_mrdc_cells_at_time(db_path, rid, center_iso, tol_ms=int(max(20, _safe_int(tol_ms) or 200)))


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
    cinr_metric = _pick_best_metric_name(entry, LTE_NEIGHBOR_CINR_METRICS) or LTE_NEIGHBOR_CINR_METRICS[0]
    earfcn_metric = _pick_best_metric_name(entry, LTE_NEIGHBOR_EARFCN_METRICS) or LTE_NEIGHBOR_EARFCN_METRICS[0]
    scale_div = _normalize_neighbor_earfcn_div(entry)

    center_ms = _to_epoch_ms(center_iso)
    if center_ms is None:
        return {
            "time": center_iso,
            "tolMs": int(tol_ms),
            "bucketMs": int(bucket_ms),
            "neighbors": [],
            "debug": {"message": "Invalid time"},
        }

    rf_expiry = max(3000, tol * 3)
    identity_expiry = max(30000, rf_expiry)
    metric_to_field = {
        LTE_NEIGHBOR_PCI_METRIC: "pci",
        LTE_NEIGHBOR_RSRP_METRIC: "rsrp",
        LTE_NEIGHBOR_RSRQ_METRIC: "rsrq",
        cinr_metric: "cinr",
        earfcn_metric: "earfcn",
    }

    kpi_index = entry.get("kpi_index")
    kpi_time_arrays = entry.get("kpi_time_arrays")
    sample_rows: List[Dict[str, Any]] = []
    lte_candidates: List[Dict] = []
    if kpi_index and kpi_time_arrays:
        t_lo = center_ms - identity_expiry
        for metric_name in metric_to_field:
            lte_candidates.extend(
                _kpi_samples_in_window(kpi_index, kpi_time_arrays, metric_name, t_lo, center_ms)
            )
    elif kpi_index:
        for metric_name in metric_to_field:
            lte_candidates.extend(kpi_index.get(metric_name) or [])
    else:
        lte_candidates = entry.get("kpi_samples") or []
    for sample in lte_candidates:
        name = str((sample or {}).get("name") or "")
        field = metric_to_field.get(name)
        if field is None:
            continue
        t_ms = _sample_time_ms(sample or {})
        if t_ms is None:
            continue
        idx = _extract_neighbor_sample_index(sample or {})
        if idx is None:
            continue
        value = _safe_float((sample or {}).get("value_num"))
        if value is None:
            continue
        age_ms = _backward_time_match_age_ms(t_ms, center_ms)
        if age_ms is None or age_ms > identity_expiry:
            continue
        if field == "earfcn":
            ival = _safe_int(round(value))
            if ival is not None and scale_div == 2 and ival % 2 == 0:
                value = float(ival // 2)
        sample_rows.append({
            "t_ms": t_ms,
            "idx": idx,
            "field": field,
            "value": value,
            "time": (sample or {}).get("time") or _epoch_ms_to_iso(t_ms),
            "age_ms": age_ms,
        })
    sample_rows.sort(key=lambda row: (
        int(row["age_ms"]),
        -int(row["t_ms"]),
        int(row["idx"]),
        str(row["field"]),
    ))

    state: Dict[int, Dict[str, Dict[str, Any]]] = {}
    for row in sample_rows:
        slot = state.setdefault(int(row["idx"]), {})
        prev = slot.get(str(row["field"]))
        if prev is not None:
            prev_age = _safe_int(prev.get("age_ms"))
            row_age = _safe_int(row.get("age_ms"))
            prev_t = _safe_int(prev.get("t_ms"))
            row_t = _safe_int(row.get("t_ms"))
            if prev_age is not None and row_age is not None:
                if row_age > prev_age:
                    continue
                if row_age == prev_age and prev_t is not None and row_t is not None and row_t <= prev_t:
                    continue
        slot[str(row["field"])] = {
            "value": row["value"],
            "t_ms": int(row["t_ms"]),
            "time": row["time"],
            "age_ms": int(row["age_ms"]),
        }

    def read_value(slot_state: Dict[str, Dict[str, Any]], field: str, expiry_ms: int, as_int: bool = False):
        item = slot_state.get(field) or {}
        value = item.get("value")
        age_ms = _safe_int(item.get("age_ms"))
        if value is None or age_ms is None:
            return None, None, None
        if age_ms < 0 or age_ms > expiry_ms:
            return None, None, None
        if as_int:
            return _safe_int(round(value)), age_ms, item.get("time")
        return _safe_float(value), age_ms, item.get("time")

    stable_rows: List[Dict[str, Any]] = []
    for idx, slot_state in sorted(state.items()):
        pci, pci_age, pci_time = read_value(slot_state, "pci", identity_expiry, as_int=True)
        earfcn, earfcn_age, earfcn_time = read_value(slot_state, "earfcn", identity_expiry, as_int=True)
        rsrp, rsrp_age, rsrp_time = read_value(slot_state, "rsrp", rf_expiry)
        rsrq, rsrq_age, rsrq_time = read_value(slot_state, "rsrq", rf_expiry)
        cinr, cinr_age, cinr_time = read_value(slot_state, "cinr", rf_expiry)
        if pci is None and earfcn is None and rsrp is None and rsrq is None and cinr is None:
            continue
        stable_rows.append({
            "slot_index": idx,
            "slot_name": f"Slot_N{idx + 1}",
            "pci": pci,
            "rsrp": rsrp,
            "rsrq": rsrq,
            "cinr": cinr,
            "earfcn": earfcn,
            "sourceBucket": max(filter(None, [rsrp_time, rsrq_time, cinr_time, pci_time, earfcn_time]), default=None),
            "agesMs": {
                "pci": pci_age,
                "earfcn": earfcn_age,
                "rsrp": rsrp_age,
                "rsrq": rsrq_age,
                "cinr": cinr_age,
            },
        })

    stable_rows.sort(key=lambda r: (
        -(_safe_float(r.get("rsrp")) if _safe_float(r.get("rsrp")) is not None else -9999.0),
        -(_safe_float(r.get("cinr")) if _safe_float(r.get("cinr")) is not None else -9999.0),
        _safe_int(r.get("earfcn")) if _safe_int(r.get("earfcn")) is not None else 10**9,
        _safe_int(r.get("pci")) if _safe_int(r.get("pci")) is not None else 10**9,
        int(r.get("slot_index") or 0),
    ))

    per_earfcn_rank: Dict[int, int] = {}
    neighbors: List[Dict[str, Any]] = []
    for i, row in enumerate(stable_rows, start=1):
        earfcn = _safe_int(row.get("earfcn"))
        if earfcn is not None:
            per_earfcn_rank[earfcn] = int(per_earfcn_rank.get(earfcn) or 0) + 1
            ranked_neighbor = f"N{per_earfcn_rank[earfcn]}"
        else:
            ranked_neighbor = None
        neighbors.append({
            "label": f"N{i}",
            "rankedNeighbor": ranked_neighbor,
            "pci": _safe_int(row.get("pci")),
            "rsrp": _safe_float(row.get("rsrp")),
            "rsrq": _safe_float(row.get("rsrq")),
            "cinr": _safe_float(row.get("cinr")),
            "earfcn": earfcn,
            "sourceBucket": row.get("sourceBucket"),
            "pair_index": _safe_int(row.get("slot_index")),
            "slotIndex": _safe_int(row.get("slot_index")),
            "slotName": row.get("slot_name"),
            "agesMs": row.get("agesMs") or {},
        })

    # --- NR neighbor processing (EN-DC / NSA) ---
    nr_sample_rows: List[Dict[str, Any]] = []
    nr_candidates: List[Dict] = []
    if kpi_index and kpi_time_arrays:
        t_lo = center_ms - identity_expiry
        for metric_name in NR_NEIGHBOR_METRIC_TO_FIELD:
            nr_candidates.extend(
                _kpi_samples_in_window(kpi_index, kpi_time_arrays, metric_name, t_lo, center_ms)
            )
    elif kpi_index:
        for metric_name in NR_NEIGHBOR_METRIC_TO_FIELD:
            nr_candidates.extend(kpi_index.get(metric_name) or [])
    else:
        nr_candidates = entry.get("kpi_samples") or []
    for sample in nr_candidates:
        name = str((sample or {}).get("name") or "")
        field = NR_NEIGHBOR_METRIC_TO_FIELD.get(name)
        if field is None:
            continue
        t_ms = _sample_time_ms(sample or {})
        if t_ms is None:
            continue
        idx = _extract_neighbor_sample_index(sample or {})
        if idx is None:
            continue
        value = _safe_float((sample or {}).get("value_num"))
        if value is None:
            continue
        age_ms = _backward_time_match_age_ms(t_ms, center_ms)
        if age_ms is None or age_ms > identity_expiry:
            continue
        nr_sample_rows.append({
            "t_ms": t_ms,
            "idx": idx,
            "field": field,
            "value": value,
            "time": (sample or {}).get("time") or _epoch_ms_to_iso(t_ms),
            "age_ms": age_ms,
        })
    nr_sample_rows.sort(key=lambda row: (int(row["age_ms"]), -int(row["t_ms"]), int(row["idx"]), str(row["field"])))

    nr_state: Dict[int, Dict[str, Dict[str, Any]]] = {}
    for row in nr_sample_rows:
        slot = nr_state.setdefault(int(row["idx"]), {})
        prev = slot.get(str(row["field"]))
        if prev is not None:
            prev_age = _safe_int(prev.get("age_ms"))
            row_age = _safe_int(row.get("age_ms"))
            prev_t = _safe_int(prev.get("t_ms"))
            row_t = _safe_int(row.get("t_ms"))
            if prev_age is not None and row_age is not None:
                if row_age > prev_age:
                    continue
                if row_age == prev_age and prev_t is not None and row_t is not None and row_t <= prev_t:
                    continue
        slot[str(row["field"])] = {"value": row["value"], "t_ms": int(row["t_ms"]), "time": row["time"], "age_ms": int(row["age_ms"])}

    nr_stable_rows: List[Dict[str, Any]] = []
    for idx, slot_state in sorted(nr_state.items()):
        pci, pci_age, pci_time = read_value(slot_state, "pci", identity_expiry, as_int=True)
        earfcn, earfcn_age, earfcn_time = read_value(slot_state, "earfcn", identity_expiry, as_int=True)
        rsrp, rsrp_age, rsrp_time = read_value(slot_state, "rsrp", rf_expiry)
        rsrq, rsrq_age, rsrq_time = read_value(slot_state, "rsrq", rf_expiry)
        if pci is None and earfcn is None and rsrp is None and rsrq is None:
            continue
        nr_stable_rows.append({
            "slot_index": idx,
            "pci": pci,
            "rsrp": rsrp,
            "rsrq": rsrq,
            "earfcn": earfcn,
            "agesMs": {"pci": pci_age, "earfcn": earfcn_age, "rsrp": rsrp_age, "rsrq": rsrq_age},
        })
    nr_stable_rows.sort(key=lambda r: (
        -(_safe_float(r.get("rsrp")) if _safe_float(r.get("rsrp")) is not None else -9999.0),
        _safe_int(r.get("earfcn")) if _safe_int(r.get("earfcn")) is not None else 10**9,
        _safe_int(r.get("pci")) if _safe_int(r.get("pci")) is not None else 10**9,
    ))
    for i, row in enumerate(nr_stable_rows, start=1):
        neighbors.append({
            "label": f"NR-N{i}",
            "pci": _safe_int(row.get("pci")),
            "rsrp": _safe_float(row.get("rsrp")),
            "rsrq": _safe_float(row.get("rsrq")),
            "earfcn": _safe_int(row.get("earfcn")),
            "rat": "NR",
            "slotIndex": _safe_int(row.get("slot_index")),
            "agesMs": row.get("agesMs") or {},
        })

    distinct_pci = sorted({int(n["pci"]) for n in neighbors if _safe_int(n.get("pci")) is not None})
    return {
        "time": center_iso,
        "tolMs": tol,
        "bucketMs": align,
        "neighbors": neighbors,
        "debug": {
            "neighborSamplesScanned": len(sample_rows),
            "nrNeighborSamplesScanned": len(nr_sample_rows),
            "distinctPci": len(distinct_pci),
            "distinctPciList": distinct_pci,
            "pairedRows": len(stable_rows),
            "nrPairedRows": len(nr_stable_rows),
            "earfcnScaleDiv": scale_div,
            "cinrMetric": cinr_metric,
            "earfcnMetric": earfcn_metric,
            "rfExpiryMs": rf_expiry,
            "identityExpiryMs": identity_expiry,
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
        row_rat = str(row.get("rat") or "LTE").upper()
        estimated_rows.append({
            "rat": row_rat,
            "pci": _safe_int(row.get("pci")),
            "earfcn": _safe_int(row.get("earfcn")),
            "rsrp": _safe_float(row.get("rsrp")),
            "rsrq": _safe_float(row.get("rsrq")),
            "cinr": _safe_float(row.get("cinr")),
            "neighbor_type": "unknown" if row_rat == "LTE" else "inter-RAT",
            "source_kind": "estimated",
            "source_note": "Neighbor slot fill",
            "sourceBucket": row.get("sourceBucket"),
            "slotIndex": _safe_int(row.get("slotIndex")),
            "slotName": row.get("slotName"),
            "rankedNeighbor": row.get("rankedNeighbor"),
            "agesMs": row.get("agesMs") or {},
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
        for f in ("slotIndex", "slotName", "rankedNeighbor", "agesMs"):
            if merged.get(f) in (None, {}, "") and row.get(f) not in (None, {}, ""):
                merged[f] = row.get(f)
        merged_by_key[k] = merged

    neighbors_out = []
    serving_pci = _safe_int(serving.get("pci"))
    serving_earfcn = _safe_int(serving.get("earfcn"))
    # Build set of serving+SCell PCI/EARFCN pairs to exclude from neighbors
    serving_set: set = set()
    if serving_pci is not None:
        serving_set.add((serving_pci, serving_earfcn))
    scells_data = serving.get("scells") or []
    for sc in scells_data:
        sc_pci = _safe_int(sc.get("pci"))
        sc_earfcn = _safe_int(sc.get("earfcn"))
        if sc_pci is not None:
            serving_set.add((sc_pci, sc_earfcn))
    for row in merged_by_key.values():
        rat = str(row.get("rat") or "LTE").upper()
        pci = _safe_int(row.get("pci"))
        earfcn = _safe_int(row.get("earfcn"))
        if rat == "LTE" and pci is None:
            continue
        # Exclude PCell and SCells from neighbor list
        if rat == "LTE" and (pci, earfcn) in serving_set:
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


def _haversine_distance_m(lat1: Any, lon1: Any, lat2: Any, lon2: Any) -> Optional[float]:
    a_lat = _safe_float(lat1)
    a_lon = _safe_float(lon1)
    b_lat = _safe_float(lat2)
    b_lon = _safe_float(lon2)
    if None in (a_lat, a_lon, b_lat, b_lon):
        return None
    r = 6371000.0
    phi1 = math.radians(a_lat)
    phi2 = math.radians(b_lat)
    dphi = math.radians(b_lat - a_lat)
    dlambda = math.radians(b_lon - a_lon)
    a = math.sin(dphi / 2.0) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2.0) ** 2
    c = 2.0 * math.atan2(math.sqrt(a), math.sqrt(max(0.0, 1.0 - a)))
    return float(r * c)


def _compute_serving_dwell_blocks(samples: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Group consecutive polluted samples by serving PCI into dwell blocks."""
    if not samples:
        return []
    blocks: List[Dict[str, Any]] = []
    cur_pci: Optional[int] = None
    cur_bucket: List[Dict[str, Any]] = []

    def _flush(pci: Optional[int], bucket: List[Dict[str, Any]]) -> None:
        if not bucket:
            return
        t_vals = [int(s["t_ms"]) for s in bucket if s.get("t_ms") is not None]
        dur_ms = (max(t_vals) - min(t_vals)) if len(t_vals) >= 2 else 0
        rsrp_vals = [float(s["serving"]["rsrp"]) for s in bucket
                     if s.get("serving", {}).get("rsrp") is not None]
        blocks.append({
            "pci": pci,
            "startTime": bucket[0].get("time"),
            "endTime": bucket[-1].get("time"),
            "durationMs": dur_ms,
            "sampleCount": len(bucket),
            "avgServingRsrp": round(sum(rsrp_vals) / len(rsrp_vals), 1) if rsrp_vals else None,
        })

    for s in samples:
        pci = _safe_int((s.get("serving") or {}).get("pci"))
        if pci != cur_pci:
            _flush(cur_pci, cur_bucket)
            cur_pci, cur_bucket = pci, [s]
        else:
            cur_bucket.append(s)
    _flush(cur_pci, cur_bucket)
    return blocks


def analyze_pilot_pollution_at_point(
    db_path: Optional[str],
    run_id: int,
    center_iso: str,
    lat: Optional[float] = None,
    lon: Optional[float] = None,
    window_ms: int = 12000,
    rf_expiry_ms: int = 3000,
    identity_expiry_ms: int = 10000,
    cluster_gap_ms: int = 3000,
    cluster_gap_m: float = 100.0,
) -> Dict[str, Any]:
    rid = int(run_id)
    if rid not in _RUNS:
        return {"status": "error", "message": "Run not found"}
    center_ms = _to_epoch_ms(center_iso)
    if center_ms is None:
        return {"status": "error", "message": "Invalid time"}

    entry = _RUNS[rid]
    half_window_ms = int(max(2000, _safe_int(window_ms) or 12000))
    rf_expiry = int(max(500, _safe_int(rf_expiry_ms) or 3000))
    identity_expiry = int(max(rf_expiry, _safe_int(identity_expiry_ms) or 10000))
    cluster_gap = int(max(500, _safe_int(cluster_gap_ms) or 3000))
    cluster_gap_distance = float(cluster_gap_m if cluster_gap_m is not None else 100.0)

    window_start = center_ms - half_window_ms
    window_end = center_ms + half_window_ms
    scan_start = window_start - identity_expiry
    scan_end = window_end

    def metric_or_none(candidates: List[str]) -> Optional[str]:
        return _pick_best_metric_name(entry, candidates)

    serving_metric_names = {
        "pci": metric_or_none(["Radio.Lte.ServingCell[0].Pci", "Radio.Lte.ServingCell[8].Pci", "Radio.Lte.ServingCellTotal.Pci"]),
        "earfcn": metric_or_none([
            "Radio.Lte.ServingCell[0].Downlink.Earfcn",
            "Radio.Lte.ServingCell[8].Downlink.Earfcn",
            "Radio.Lte.ServingCellTotal.Downlink.Earfcn",
            "Radio.Lte.ServingCell[0].Earfcn",
            "Radio.Lte.ServingCell[8].Earfcn",
        ]),
        "rsrp": metric_or_none(["Radio.Lte.ServingCell[0].Rsrp", "Radio.Lte.ServingCell[8].Rsrp", "Radio.Lte.ServingCellTotal.Rsrp"]),
        "rsrq": metric_or_none(["Radio.Lte.ServingCell[0].Rsrq", "Radio.Lte.ServingCell[8].Rsrq", "Radio.Lte.ServingCellTotal.Rsrq"]),
        "sinr": metric_or_none([
            "Radio.Lte.ServingCell[0].RsSinr",
            "Radio.Lte.ServingCell[8].RsSinr",
            "Radio.Lte.ServingCellTotal.RsSinr",
            "Radio.Lte.ServingCell[0].Sinr",
            "Radio.Lte.ServingCell[8].Sinr",
            "Radio.Lte.ServingCellTotal.Sinr",
            "Radio.Lte.ServingCell[0].Cinr",
            "Radio.Lte.ServingCell[8].Cinr",
            "Radio.Lte.ServingCellTotal.Cinr",
        ]),
        "pdsch_sinr": metric_or_none([
            "Radio.Lte.ServingCell[0].Pdsch.Sinr",
            "Radio.Lte.ServingCell[8].Pdsch.Sinr",
            "Radio.Lte.ServingCellTotal.Pdsch.Sinr",
            "Radio.Lte.ServingCell[0].Pdsch.Cinr",
            "Radio.Lte.ServingCell[8].Pdsch.Cinr",
            "Radio.Lte.ServingCellTotal.Pdsch.Cinr",
        ]),
    }
    neighbor_metric_names = {
        "pci": LTE_NEIGHBOR_PCI_METRIC,
        "earfcn": metric_or_none(LTE_NEIGHBOR_EARFCN_METRICS) or LTE_NEIGHBOR_EARFCN_METRICS[0],
        "rsrp": LTE_NEIGHBOR_RSRP_METRIC,
        "rsrq": LTE_NEIGHBOR_RSRQ_METRIC,
        "sinr": metric_or_none(LTE_NEIGHBOR_CINR_METRICS) or LTE_NEIGHBOR_CINR_METRICS[0],
    }
    needed_names = {v for v in list(serving_metric_names.values()) + list(neighbor_metric_names.values()) if v}
    if not needed_names:
        return {"status": "error", "message": "Required LTE metrics are not available for this run"}

    serving_name_to_field = {name: field for field, name in serving_metric_names.items() if name}
    neighbor_name_to_field = {name: field for field, name in neighbor_metric_names.items() if name}

    sample_rows: List[Dict[str, Any]] = []
    for sample in entry.get("kpi_samples") or []:
        name = str((sample or {}).get("name") or "")
        if name not in needed_names:
            continue
        if name in serving_name_to_field and _is_serving_array_metric(name):
            sample_idx = _extract_neighbor_sample_index(sample or {})
            if sample_idx not in (None, 0):
                continue
        t_ms = _sample_time_ms(sample or {})
        if t_ms is None or t_ms < scan_start or t_ms > scan_end:
            continue
        sample_rows.append({
            "t_ms": t_ms,
            "name": name,
            "value": _safe_float((sample or {}).get("value_num")),
            "idx": _extract_neighbor_sample_index(sample or {}),
        })
    sample_rows.sort(key=lambda row: (row["t_ms"], str(row["name"])))

    track_rows: List[Dict[str, Any]] = []
    for row in entry.get("track_points") or []:
        t_ms = _to_epoch_ms((row or {}).get("time"))
        if t_ms is None or t_ms < (window_start - cluster_gap) or t_ms > (window_end + cluster_gap):
            continue
        track_rows.append({
            "t_ms": t_ms,
            "time": (row or {}).get("time") or _epoch_ms_to_iso(t_ms),
            "lat": _safe_float((row or {}).get("lat")),
            "lon": _safe_float((row or {}).get("lon")),
        })
    track_rows.sort(key=lambda row: row["t_ms"])

    # ETSI naming: Message.Layer3.Errc.DcchUl.MeasurementReport
    # Nemo naming:  Message.Layer3.LteRrc.MeasurementReport
    _MR_EVENT_NAME_PATTERNS = {
        "message.layer3.errc.dcchul.measurementreport",
        "message.layer3.lterrc.measurementreport",
        "message.layer3.lte.rrc.measurementreport",
    }
    _NATIVE_A3_KEY = "radio.lte.measurementreporting.a3event"
    _NATIVE_A5_KEY = "radio.lte.measurementreporting.a5event"
    _A3_TARGET_PARAM_CANDIDATES = [
        "physicalcellidneighbourcell", "physcellidneighbour", "neighborpci", "targetpci",
        "neighbourcellid", "physicalcellid", "physcellidneighbor", "physicalcellidneighbor",
        "reportedpci", "cellidentity", "physicalcellidentity",
    ]
    _A3_SERVING_RSRP_CANDIDATES = ["servingrsrp", "serving_rsrp", "rsrpservingcell", "rsrp_serving"]
    _A3_NEIGHBOR_RSRP_CANDIDATES = ["neighbourrsrp", "neighborrsrp", "rsrpneighbourcell", "rsrp_neighbour", "rsrp_neighbor", "reportedrsrp"]

    event_rows: List[Dict[str, Any]] = []
    for ev in entry.get("events") or []:
        t_ms = _to_epoch_ms((ev or {}).get("time") or (ev or {}).get("timestamp") or (ev or {}).get("ts"))
        if t_ms is None or t_ms < (window_start - cluster_gap) or t_ms > (window_end + cluster_gap):
            continue
        name = str((ev or {}).get("event_name") or (ev or {}).get("event") or (ev or {}).get("message") or "")
        if not name:
            continue
        name_lc = name.lower()
        row: Dict[str, Any] = {"t_ms": t_ms, "name": name, "name_lc": name_lc}
        if name_lc in _MR_EVENT_NAME_PATTERNS:
            row["_ev_ref"] = ev
        elif _NATIVE_A3_KEY in name_lc or _NATIVE_A5_KEY in name_lc:
            row["_is_native_a3"] = True
            row["_ev_ref"] = ev
        elif "reestablishmentrequest" in name_lc:
            row["_ev_ref"] = ev
        event_rows.append(row)

    eval_timestamps = sorted({
        int(row["t_ms"])
        for row in track_rows
        if window_start <= row["t_ms"] <= window_end
    })
    if not eval_timestamps:
        eval_timestamps = sorted({
            int(row["t_ms"])
            for row in sample_rows
            if window_start <= row["t_ms"] <= window_end
        })
    if not eval_timestamps:
        eval_timestamps = [center_ms]
    earfcn_scale_div = _normalize_neighbor_earfcn_div(entry)

    event_name_labels = {
        "radio.lte.measurementreporting.a3event": "A3",
        "radio.lte.measurementreporting.a5event": "A5",
        "radio.common.servingcellchangedevent": "ServingCellChanged",
        "radio.lte.handoverstartevent": "HandoverStart",
        "radio.lte.intrafrequencyhandoverevent": "IntraFrequencyHandover",
        "radio.lte.handoverdetailsevent": "HandoverDetails",
        "radio.nr.scgfailureevent": "ScgFailure",
        "radio.5g.servicelostevent": "ServiceLost",
        "pocket.radio.nr.datasessiondropevent": "NrDataSessionDrop",
        "data.ipinterruptiontimeevent": "IpInterruption",
    }
    hard_failure_event_names = {
        "radio.nr.scgfailureevent",
        "radio.5g.servicelostevent",
        "pocket.radio.nr.datasessiondropevent",
        "data.ipinterruptiontimeevent",
        "message.layer3.errc.ccchul.rrcconnectionreestablishmentrequest",
        "message.layer3.errc.ccchdl.rrcconnectionreestablishmentreject",
        "message.layer3.errc.dcchdl.rrcconnectionrelease",
    }

    def classify_event_label(name_lc: str) -> Optional[str]:
        if not name_lc:
            return None
        for key, label in event_name_labels.items():
            if key in name_lc:
                return label
        return None

    def quality_weight(serv_rsrq: Optional[float], serv_sinr: Optional[float], serv_pdsch_sinr: Optional[float], indicators: List[str]) -> float:
        weight = 1.0
        weight += 0.12 * len(indicators or [])
        if serv_sinr is not None and serv_sinr < 0.0:
            weight += 0.18
        elif serv_sinr is not None and serv_sinr < 3.0:
            weight += 0.08
        if serv_pdsch_sinr is not None and serv_pdsch_sinr < 0.0:
            weight += 0.12
        elif serv_pdsch_sinr is not None and serv_pdsch_sinr < 3.0:
            weight += 0.05
        if serv_rsrq is not None and serv_rsrq <= -14.0:
            weight += 0.12
        elif serv_rsrq is not None and serv_rsrq <= -13.0:
            weight += 0.06
        return max(1.0, round(weight, 3))

    def empty_state() -> Dict[str, Dict[str, Any]]:
        return {}

    serving_state: Dict[str, Dict[str, Any]] = empty_state()
    neighbor_state: Dict[int, Dict[str, Dict[str, Any]]] = {}

    def update_state(bucket: Dict[str, Dict[str, Any]], field: str, value: Any, t_ms: int) -> None:
        bucket[field] = {"value": value, "t_ms": t_ms}

    def get_state_value(bucket: Dict[str, Dict[str, Any]], field: str, now_ms: int, expiry_ms: int) -> Tuple[Optional[float], Optional[int]]:
        state = bucket.get(field) or {}
        value = state.get("value")
        t_ms = _safe_int(state.get("t_ms"))
        if t_ms is None or value is None:
            return None, None
        age_ms = now_ms - t_ms
        if age_ms < 0 or age_ms > expiry_ms:
            return None, None
        return _safe_float(value), age_ms

    def get_identity_value(bucket: Dict[str, Dict[str, Any]], field: str, now_ms: int) -> Tuple[Optional[int], Optional[int]]:
        val, age = get_state_value(bucket, field, now_ms, identity_expiry)
        if val is None:
            return None, None
        return _safe_int(round(val)), age

    def get_rf_value(bucket: Dict[str, Dict[str, Any]], field: str, now_ms: int) -> Tuple[Optional[float], Optional[int]]:
        return get_state_value(bucket, field, now_ms, rf_expiry)

    def nearest_position(now_ms: int) -> Dict[str, Any]:
        best = None
        best_dt = None
        for row in track_rows:
            dt = abs(int(row["t_ms"]) - now_ms)
            if best is None or dt < best_dt:
                best = row
                best_dt = dt
        if best and best_dt is not None and best_dt <= max(cluster_gap, 3000):
            return {
                "lat": best.get("lat"),
                "lon": best.get("lon"),
                "time": best.get("time"),
                "deltaMs": int(best_dt),
            }
        return {
            "lat": _safe_float(lat),
            "lon": _safe_float(lon),
            "time": center_iso,
            "deltaMs": abs(now_ms - center_ms),
        }

    samples_by_time: Dict[int, List[Dict[str, Any]]] = {}
    for row in sample_rows:
        samples_by_time.setdefault(int(row["t_ms"]), []).append(row)

    polluted_samples: List[Dict[str, Any]] = []
    all_sample_summaries: List[Dict[str, Any]] = []
    pointer = 0
    sample_times_sorted = sorted(samples_by_time.keys())

    for ts in eval_timestamps:
        while pointer < len(sample_times_sorted) and sample_times_sorted[pointer] <= ts:
            row_ts = sample_times_sorted[pointer]
            for row in samples_by_time.get(row_ts) or []:
                name = str(row.get("name") or "")
                value = row.get("value")
                if name in serving_name_to_field:
                    update_state(serving_state, serving_name_to_field[name], value, row_ts)
                    continue
                if name in neighbor_name_to_field:
                    idx = _safe_int(row.get("idx"))
                    if idx is None:
                        continue
                    slot = neighbor_state.setdefault(idx, {})
                    field = neighbor_name_to_field[name]
                    if field == "earfcn" and value is not None and earfcn_scale_div == 2 and int(round(value)) % 2 == 0:
                        value = int(round(value)) // 2
                    update_state(slot, field, value, row_ts)
            pointer += 1

        serving_pci, serving_pci_age = get_identity_value(serving_state, "pci", ts)
        serving_earfcn, serving_earfcn_age = get_identity_value(serving_state, "earfcn", ts)
        # If EARFCN has expired but PCI is still fresh, carry the last known EARFCN forward.
        # EARFCN changes are always paired with PCI changes, so a stale EARFCN with a fresh PCI
        # means the UE is still on the same carrier — the EARFCN just wasn't re-emitted.
        if serving_earfcn is None and serving_pci is not None:
            _earfcn_state = serving_state.get("earfcn") or {}
            _earfcn_raw = _safe_int(_safe_float(_earfcn_state.get("value")))
            if _earfcn_raw is not None:
                serving_earfcn = _earfcn_raw
                serving_earfcn_age = ts - int(_earfcn_state.get("t_ms") or ts)
        serving_rsrp, serving_rsrp_age = get_rf_value(serving_state, "rsrp", ts)
        serving_rsrq, serving_rsrq_age = get_rf_value(serving_state, "rsrq", ts)
        serving_sinr, serving_sinr_age = get_rf_value(serving_state, "sinr", ts)
        serving_pdsch_sinr, serving_pdsch_sinr_age = get_rf_value(serving_state, "pdsch_sinr", ts)

        neighbors_same_carrier: List[Dict[str, Any]] = []
        neighbors_by_key: Dict[Tuple[int, int], Dict[str, Any]] = {}
        for idx, state in neighbor_state.items():
            pci, pci_age = get_identity_value(state, "pci", ts)
            earfcn, earfcn_age = get_identity_value(state, "earfcn", ts)
            rsrp, rsrp_age = get_rf_value(state, "rsrp", ts)
            rsrq, rsrq_age = get_rf_value(state, "rsrq", ts)
            sinr, sinr_age = get_rf_value(state, "sinr", ts)
            if pci is None and earfcn is None and rsrp is None and rsrq is None and sinr is None:
                continue
            if serving_earfcn is None or earfcn is None or earfcn != serving_earfcn:
                continue
            if pci is None or rsrp is None:
                continue
            key = (earfcn, pci)
            candidate = {
                "index": idx,
                "pci": pci,
                "earfcn": earfcn,
                "rsrp": rsrp,
                "rsrq": rsrq,
                "sinr": sinr,
                "agesMs": {
                    "pci": pci_age,
                    "earfcn": earfcn_age,
                    "rsrp": rsrp_age,
                    "rsrq": rsrq_age,
                    "sinr": sinr_age,
                },
            }
            prev = neighbors_by_key.get(key)
            if prev is None or (candidate["rsrp"] > prev["rsrp"]):
                neighbors_by_key[key] = candidate
        neighbors_same_carrier = list(neighbors_by_key.values())

        valid_for_scoring = (
            serving_earfcn is not None
            and serving_pci is not None
            and serving_rsrp is not None
            and len(neighbors_same_carrier) >= 2
        )

        serving_cell = {
            "role": "serving",
            "pci": serving_pci,
            "earfcn": serving_earfcn,
            "rsrp": serving_rsrp,
            "rsrq": serving_rsrq,
            "sinr": serving_sinr,
            "agesMs": {
                "pci": serving_pci_age,
                "earfcn": serving_earfcn_age,
                "rsrp": serving_rsrp_age,
                "rsrq": serving_rsrq_age,
                "sinr": serving_sinr_age,
                "pdschSinr": serving_pdsch_sinr_age,
            },
        }
        carrier_cells = [serving_cell] + [
            {
                "role": "neighbor",
                "pci": row["pci"],
                "earfcn": row["earfcn"],
                "rsrp": row["rsrp"],
                "rsrq": row["rsrq"],
                "sinr": row["sinr"],
                "agesMs": row["agesMs"],
            }
            for row in neighbors_same_carrier
        ]
        carrier_cells = [row for row in carrier_cells if row.get("earfcn") is not None and row.get("rsrp") is not None]

        best_rsrp = max([float(row["rsrp"]) for row in carrier_cells], default=None)
        strong_cells: List[Dict[str, Any]] = []
        if best_rsrp is not None:
            for row in carrier_cells:
                delta = best_rsrp - float(row["rsrp"])
                if float(row["rsrp"]) >= -105.0 and delta <= 5.0:
                    item = dict(row)
                    item["deltaToBest"] = round(delta, 1)
                    item["isCore"] = delta <= 3.0
                    strong_cells.append(item)
        strong_cells.sort(key=lambda row: (
            -(float(row.get("rsrp")) if row.get("rsrp") is not None else -9999.0),
            0 if str(row.get("role") or "") == "serving" else 1,
            _safe_int(row.get("pci")) if _safe_int(row.get("pci")) is not None else 10**9,
        ))
        for rank_idx, item in enumerate(strong_cells, start=1):
            item["rank"] = rank_idx

        bad_indicators: List[str] = []
        if serving_sinr is not None and serving_sinr < 5.0:
            bad_indicators.append(f"RS-SINR {serving_sinr:.1f} dB")
        if serving_pdsch_sinr is not None and serving_pdsch_sinr < 5.0:
            bad_indicators.append(f"PDSCH SINR {serving_pdsch_sinr:.1f} dB")
        if serving_rsrq is not None and serving_rsrq <= -12.0:
            bad_indicators.append(f"RSRQ {serving_rsrq:.1f} dB")
        quality_bad = bool(bad_indicators)

        polluters = [row for row in strong_cells if row.get("role") == "neighbor"]
        serving_was_best = bool(serving_rsrp is not None and best_rsrp is not None and abs(best_rsrp - serving_rsrp) < 0.1)
        polluted = bool(valid_for_scoring and quality_bad and best_rsrp is not None and best_rsrp >= -105.0 and len(strong_cells) >= 3)

        position = nearest_position(ts)
        max_identity_age = max([
            age for age in (
                serving_pci_age,
                serving_earfcn_age,
                *[row["agesMs"].get("pci") for row in neighbors_same_carrier],
                *[row["agesMs"].get("earfcn") for row in neighbors_same_carrier],
            )
            if age is not None
        ], default=0)
        max_rf_age = max([
            age for age in (
                serving_rsrp_age,
                serving_rsrq_age,
                serving_sinr_age,
                serving_pdsch_sinr_age,
                *[row["agesMs"].get("rsrp") for row in neighbors_same_carrier],
                *[row["agesMs"].get("rsrq") for row in neighbors_same_carrier],
                *[row["agesMs"].get("sinr") for row in neighbors_same_carrier],
            )
            if age is not None
        ], default=0)
        mobility_hit = any(abs(int(ev["t_ms"]) - ts) <= cluster_gap for ev in event_rows)
        q_weight = quality_weight(serving_rsrq, serving_sinr, serving_pdsch_sinr, bad_indicators)

        detection_confidence = 0.40
        if polluted:
            detection_confidence += 0.18
        if len(strong_cells) >= 3:
            detection_confidence += 0.10
        if len(strong_cells) >= 5:
            detection_confidence += 0.08
        if len(strong_cells) >= 8:
            detection_confidence += 0.06
        if quality_bad:
            detection_confidence += 0.10
        if len(bad_indicators) >= 2:
            detection_confidence += 0.05
        if serving_sinr is not None and serving_sinr < 0.0:
            detection_confidence += 0.05
        if serving_rsrq is not None and serving_rsrq <= -14.0:
            detection_confidence += 0.05
        if mobility_hit:
            detection_confidence += 0.06
        if max_identity_age > 6000:
            detection_confidence -= 0.08
        elif max_identity_age > 3000:
            detection_confidence -= 0.04
        if max_rf_age > 2000:
            detection_confidence -= 0.08
        elif max_rf_age > 1000:
            detection_confidence -= 0.04
        detection_confidence = max(0.05, min(0.99, detection_confidence))

        attribution_confidence = 0.78
        if len(strong_cells) >= 8:
            attribution_confidence -= 0.08
        elif len(strong_cells) >= 5:
            attribution_confidence -= 0.04
        if max_identity_age > 6000:
            attribution_confidence -= 0.20
        elif max_identity_age > 3000:
            attribution_confidence -= 0.10
        if max_rf_age > 2000:
            attribution_confidence -= 0.12
        elif max_rf_age > 1000:
            attribution_confidence -= 0.06
        if mobility_hit:
            attribution_confidence -= 0.04
        attribution_confidence = max(0.05, min(0.95, attribution_confidence))

        severity = "Low"
        if polluted:
            if len(strong_cells) >= 5 and (
                (serving_sinr is not None and serving_sinr < 0.0)
                or (serving_rsrq is not None and serving_rsrq <= -14.0)
                or len(bad_indicators) >= 2
            ):
                severity = "High"
            elif len(strong_cells) >= 4 or (serving_sinr is not None and serving_sinr < 3.0) or (serving_rsrq is not None and serving_rsrq <= -13.0):
                severity = "Medium"

        summary_row = {
            "time": _epoch_ms_to_iso(ts),
            "t_ms": ts,
            "lat": position.get("lat"),
            "lon": position.get("lon"),
            "serving": {
                "pci": serving_pci,
                "earfcn": serving_earfcn,
                "rsrp": serving_rsrp,
                "rsrq": serving_rsrq,
                "sinr": serving_sinr,
                "pdschSinr": serving_pdsch_sinr,
                "sinrAgeMs": serving_sinr_age,
                "pdschSinrAgeMs": serving_pdsch_sinr_age,
            },
            "sameCarrierNeighborCount": len(neighbors_same_carrier),
            "strongCellCount": len(strong_cells),
            "polluterCount": len(polluters),
            "bestRsrp": round(best_rsrp, 1) if best_rsrp is not None else None,
            "qualityBad": quality_bad,
            "qualityBadIndicators": bad_indicators,
            "polluted": polluted,
            "confidence": round(detection_confidence, 2),
            "detectionConfidence": round(detection_confidence, 2),
            "attributionConfidence": round(attribution_confidence, 2),
            "severity": severity,
            "servingWasBest": serving_was_best,
            "mobilityPenalty": mobility_hit,
            "maxIdentityAgeMs": max_identity_age,
            "maxRfAgeMs": max_rf_age,
            "qualityWeight": q_weight,
            "pollutionGroupMembers": strong_cells,
            "nonServingPolluters": polluters,
        }
        all_sample_summaries.append(summary_row)
        if polluted:
            polluted_samples.append({
                **summary_row,
                "strongCells": strong_cells,
                "polluters": polluters,
            })

    def same_event_zone(left: Dict[str, Any], right: Dict[str, Any], gap_ms_limit: int, gap_m_limit: float) -> bool:
        if not left or not right:
            return False
        same_earfcn = left.get("serving", {}).get("earfcn") == right.get("serving", {}).get("earfcn")
        if not same_earfcn:
            return False
        gap_ok = (int(right.get("t_ms") or 0) - int(left.get("t_ms") or 0)) <= gap_ms_limit
        if not gap_ok:
            return False
        dist = _haversine_distance_m(left.get("lat"), left.get("lon"), right.get("lat"), right.get("lon"))
        return (dist is None) or (dist <= gap_m_limit)

    raw_events: List[Dict[str, Any]] = []
    for sample in polluted_samples:
        if not raw_events:
            raw_events.append({"samples": [sample]})
            continue
        prev_event = raw_events[-1]
        prev_sample = prev_event["samples"][-1]
        if same_event_zone(prev_sample, sample, cluster_gap, cluster_gap_distance):
            prev_event["samples"].append(sample)
        else:
            raw_events.append({"samples": [sample]})

    events: List[Dict[str, Any]] = []
    singleton_gap_limit = max(cluster_gap * 2, 6000)
    singleton_dist_limit = max(cluster_gap_distance * 1.5, 150.0)
    for raw_event in raw_events:
        samples = list(raw_event.get("samples") or [])
        if not samples:
            continue
        if len(samples) == 1 and events and same_event_zone(events[-1]["samples"][-1], samples[0], singleton_gap_limit, singleton_dist_limit):
            events[-1]["samples"].extend(samples)
            continue
        events.append({"samples": samples})
    merged_events: List[Dict[str, Any]] = []
    idx_event = 0
    while idx_event < len(events):
        current = events[idx_event]
        current_samples = list(current.get("samples") or [])
        if (
            len(current_samples) == 1
            and idx_event + 1 < len(events)
            and same_event_zone(current_samples[-1], events[idx_event + 1]["samples"][0], singleton_gap_limit, singleton_dist_limit)
        ):
            events[idx_event + 1]["samples"] = current_samples + list(events[idx_event + 1].get("samples") or [])
            idx_event += 1
            continue
        merged_events.append(current)
        idx_event += 1
    events = merged_events

    # Final inter-event merge: slightly wider gap catches near-miss splits between non-singleton events
    _merge_gap_ms = max(cluster_gap + 1000, 4000)
    _merge_gap_m = max(cluster_gap_distance + 50.0, 150.0)
    _final_events: List[Dict[str, Any]] = []
    for _ev in events:
        if not _final_events:
            _final_events.append(_ev)
            continue
        _prev_last = _final_events[-1]["samples"][-1]
        _curr_first = _ev["samples"][0]
        if same_event_zone(_prev_last, _curr_first, _merge_gap_ms, _merge_gap_m):
            _final_events[-1]["samples"].extend(_ev["samples"])
        else:
            _final_events.append(_ev)
    events = _final_events

    def make_member_bucket(cell: Dict[str, Any], sample: Dict[str, Any]) -> Dict[str, Any]:
        return {
            "earfcn": _safe_int(cell.get("earfcn")),
            "pci": _safe_int(cell.get("pci")),
            "groupSampleCount": 0,
            "nonServingPolluterSampleCount": 0,
            "corePolluterSampleCount": 0,
            "servingMemberSampleCount": 0,
            "rsrpSum": 0.0,
            "maxRsrp": None,
            "deltaSum": 0.0,
            "minDeltaToBest": None,
            "scoreSum": 0.0,
            "qualityWeightSum": 0.0,
            "firstSeen": sample.get("time"),
            "lastSeen": sample.get("time"),
        }

    def update_member_bucket(bucket: Dict[str, Any], cell: Dict[str, Any], sample: Dict[str, Any]) -> None:
        bucket["groupSampleCount"] += 1
        if str(cell.get("role") or "") == "serving":
            bucket["servingMemberSampleCount"] += 1
        else:
            bucket["nonServingPolluterSampleCount"] += 1
            if cell.get("isCore"):
                bucket["corePolluterSampleCount"] += 1
        rsrp_val = float(cell.get("rsrp") or 0.0)
        bucket["rsrpSum"] += rsrp_val
        if bucket["maxRsrp"] is None or rsrp_val > bucket["maxRsrp"]:
            bucket["maxRsrp"] = rsrp_val
        delta = float(cell.get("deltaToBest") or 0.0)
        bucket["deltaSum"] += delta
        if bucket["minDeltaToBest"] is None or delta < bucket["minDeltaToBest"]:
            bucket["minDeltaToBest"] = delta
        q_mult = float(sample.get("qualityWeight") or 1.0)
        bucket["qualityWeightSum"] += q_mult
        if str(cell.get("role") or "") != "serving":
            bucket["scoreSum"] += max(0.1, 5.0 - delta) * q_mult
        bucket["lastSeen"] = sample.get("time")

    def finalize_member_rows(summary: Dict[Tuple[int, int], Dict[str, Any]]) -> List[Dict[str, Any]]:
        rows: List[Dict[str, Any]] = []
        for bucket in summary.values():
            count = int(bucket.get("groupSampleCount") or 0)
            poll_count = int(bucket.get("nonServingPolluterSampleCount") or 0)
            avg_delta = round(bucket["deltaSum"] / max(1, count), 1)
            avg_rsrp = round(bucket["rsrpSum"] / max(1, count), 1)
            quality_w = round(bucket["qualityWeightSum"] / max(1, count), 2)
            rows.append({
                "earfcn": bucket["earfcn"],
                "pci": bucket["pci"],
                "sampleCount": count,
                "groupSampleCount": count,
                "nonServingPolluterSampleCount": poll_count,
                "corePolluterSampleCount": int(bucket.get("corePolluterSampleCount") or 0),
                "servingMemberSampleCount": int(bucket.get("servingMemberSampleCount") or 0),
                "averageRsrp": avg_rsrp,
                "maximumRsrp": round(bucket["maxRsrp"], 1) if bucket["maxRsrp"] is not None else None,
                "averageDeltaToBest": avg_delta,
                "minimumDeltaToBest": round(bucket["minDeltaToBest"], 1) if bucket["minDeltaToBest"] is not None else None,
                "averageQualityWeight": quality_w,
                "polluterScore": round(float(bucket.get("scoreSum") or 0.0), 2),
                "firstSeen": bucket["firstSeen"],
                "lastSeen": bucket["lastSeen"],
            })
        return rows

    def merge_total_bucket(dst: Dict[Tuple[int, int], Dict[str, Any]], row: Dict[str, Any]) -> None:
        key = (_safe_int(row.get("earfcn")) or -1, _safe_int(row.get("pci")) or -1)
        current = dst.get(key)
        if current is None:
            copied = dict(row)
            copied["_avg_count"] = int(row.get("groupSampleCount") or row.get("sampleCount") or 0)
            dst[key] = copied
            return
        for field in ("sampleCount", "groupSampleCount", "nonServingPolluterSampleCount", "servingMemberSampleCount"):
            current[field] = int(current.get(field) or 0) + int(row.get(field) or 0)
        prev_count = int(current.get("_avg_count") or 0)
        next_count = prev_count + int(row.get("groupSampleCount") or row.get("sampleCount") or 0)
        row_count = int(row.get("groupSampleCount") or row.get("sampleCount") or 0)
        for field in ("averageRsrp", "averageDeltaToBest", "averageQualityWeight"):
            current[field] = round(((float(current.get(field) or 0.0) * prev_count) + (float(row.get(field) or 0.0) * row_count)) / max(1, next_count), 2 if field == "averageQualityWeight" else 1)
        current["polluterScore"] = round(float(current.get("polluterScore") or 0.0) + float(row.get("polluterScore") or 0.0), 2)
        current["maximumRsrp"] = max(current.get("maximumRsrp") or -999.0, row.get("maximumRsrp") or -999.0)
        current["minimumDeltaToBest"] = min(current.get("minimumDeltaToBest") or 99.0, row.get("minimumDeltaToBest") or 99.0)
        if str(row.get("firstSeen") or "") < str(current.get("firstSeen") or ""):
            current["firstSeen"] = row.get("firstSeen")
        if str(row.get("lastSeen") or "") > str(current.get("lastSeen") or ""):
            current["lastSeen"] = row.get("lastSeen")
        current["_avg_count"] = next_count

    event_payloads: List[Dict[str, Any]] = []
    top_polluter_totals: Dict[Tuple[int, int], Dict[str, Any]] = {}
    top_group_member_totals: Dict[Tuple[int, int], Dict[str, Any]] = {}

    for idx, event in enumerate(events, start=1):
        samples = sorted(list(event.get("samples") or []), key=lambda row: int(row.get("t_ms") or 0))
        if not samples:
            continue
        start = samples[0]
        end = samples[-1]
        event_positions = [(row.get("lat"), row.get("lon")) for row in samples if _safe_float(row.get("lat")) is not None and _safe_float(row.get("lon")) is not None]
        route_length_m = 0.0
        last_lat = None
        last_lon = None
        for lat_i, lon_i in event_positions:
            if last_lat is not None and last_lon is not None:
                step = _haversine_distance_m(last_lat, last_lon, lat_i, lon_i)
                if step is not None:
                    route_length_m += step
            last_lat = lat_i
            last_lon = lon_i
        center_lat = round(sum(_safe_float(lat_i) for lat_i, _ in event_positions) / len(event_positions), 6) if event_positions else _safe_float(lat)
        center_lon = round(sum(_safe_float(lon_i) for _, lon_i in event_positions) / len(event_positions), 6) if event_positions else _safe_float(lon)
        start_lat = _safe_float(start.get("lat"))
        start_lon = _safe_float(start.get("lon"))
        end_lat = _safe_float(end.get("lat"))
        end_lon = _safe_float(end.get("lon"))
        avg_serv_rsrp_vals = [row["serving"]["rsrp"] for row in samples if row.get("serving", {}).get("rsrp") is not None]
        avg_serv_rsrp = round(sum(avg_serv_rsrp_vals) / len(avg_serv_rsrp_vals), 1) if avg_serv_rsrp_vals else None
        avg_serv_rsrq_vals = [row["serving"]["rsrq"] for row in samples if row.get("serving", {}).get("rsrq") is not None]
        avg_serv_sinr_vals = [row["serving"]["sinr"] for row in samples if row.get("serving", {}).get("sinr") is not None]
        avg_serv_rsrq = round(sum(avg_serv_rsrq_vals) / len(avg_serv_rsrq_vals), 1) if avg_serv_rsrq_vals else None
        avg_serv_sinr = round(sum(avg_serv_sinr_vals) / len(avg_serv_sinr_vals), 1) if avg_serv_sinr_vals else None
        event_detection_conf = round(sum(float(row.get("detectionConfidence") or 0.0) for row in samples) / len(samples), 2)
        event_attr_conf = round(sum(float(row.get("attributionConfidence") or 0.0) for row in samples) / len(samples), 2)
        serving_was_best_count = sum(1 for row in samples if row.get("servingWasBest"))
        max_strong_cells = max((int(row.get("strongCellCount") or 0) for row in samples), default=0)
        max_strong_cells_core = max(
            (sum(1 for cell in (row.get("strongCells") or []) if cell.get("isCore") and str(cell.get("role") or "") != "serving")
             for row in samples),
            default=0,
        )
        severity_rank = {"Low": 1, "Medium": 2, "High": 3}
        event_severity = "Low"
        serving_sequence: List[int] = []
        best_sequence: List[int] = []
        group_summary: Dict[Tuple[int, int], Dict[str, Any]] = {}
        event_counts: Dict[str, int] = {}
        hard_failure_support = False
        ho_failure_events: List[Dict[str, Any]] = []

        for row in samples:
            serving_pci = _safe_int(row.get("serving", {}).get("pci"))
            if serving_pci is not None and (not serving_sequence or serving_sequence[-1] != serving_pci):
                serving_sequence.append(serving_pci)
            top_member = next((cell for cell in (row.get("strongCells") or []) if _safe_int(cell.get("pci")) is not None), None)
            top_pci = _safe_int((top_member or {}).get("pci"))
            if top_pci is not None and (not best_sequence or best_sequence[-1] != top_pci):
                best_sequence.append(top_pci)
            if severity_rank.get(row.get("severity") or "Low", 1) > severity_rank.get(event_severity, 1):
                event_severity = str(row.get("severity") or "Low")
            for member in row.get("strongCells") or []:
                key = (_safe_int(member.get("earfcn")) or -1, _safe_int(member.get("pci")) or -1)
                bucket = group_summary.setdefault(key, make_member_bucket(member, row))
                update_member_bucket(bucket, member, row)

        event_scan_start = int(start.get("t_ms") or 0) - cluster_gap
        event_scan_end = int(end.get("t_ms") or 0) + cluster_gap

        # Build serving-PCI timeline for A3 target inference fallback:
        # list of (t_ms, pci) sorted by time, only recording transitions
        _serving_timeline: List[Tuple[int, int]] = []
        for s in sorted(samples, key=lambda _s: int(_s.get("t_ms") or 0)):
            _pci = _safe_int((s.get("serving") or {}).get("pci"))
            if _pci is None:
                continue
            if not _serving_timeline or _serving_timeline[-1][1] != _pci:
                _serving_timeline.append((int(s.get("t_ms") or 0), _pci))

        def _infer_a3_target_from_timeline(ev_t_ms: int, current_pci: Optional[int]) -> Optional[int]:
            """Return the next different PCI in the serving timeline after ev_t_ms."""
            for _t, _p in _serving_timeline:
                if _t > ev_t_ms and _p != current_pci:
                    return _p
            return None

        a3_detail_events: List[Dict[str, Any]] = []
        for ev_row in event_rows:
            ev_t = int(ev_row.get("t_ms") or 0)
            if ev_t < event_scan_start or ev_t > event_scan_end:
                continue
            name_lc = str(ev_row.get("name_lc") or "")
            label = classify_event_label(name_lc)
            if label:
                event_counts[label] = int(event_counts.get(label) or 0) + 1
            if name_lc in hard_failure_event_names:
                hard_failure_support = True
                ev_ref_hof = ev_row.get("_ev_ref")
                source_pci_hof = _safe_int(
                    (ev_ref_hof or {}).get("sourcePci") or (ev_ref_hof or {}).get("source_pci")
                )
                target_pci_hof = _safe_int(
                    (ev_ref_hof or {}).get("targetPci") or (ev_ref_hof or {}).get("target_pci")
                )
                cause_hof = str(
                    (ev_ref_hof or {}).get("reestablishmentCause")
                    or (ev_ref_hof or {}).get("reestablishment_cause")
                    or ""
                ).strip()
                if source_pci_hof is not None or target_pci_hof is not None or cause_hof:
                    ho_failure_events.append({
                        "time": (ev_ref_hof or {}).get("time") or _epoch_ms_to_iso(ev_t),
                        "tMs": ev_t,
                        "cause": cause_hof,
                        "sourcePci": source_pci_hof,
                        "targetPci": target_pci_hof,
                    })
            if "_ev_ref" in ev_row:
                ev_ref = ev_row["_ev_ref"]
                is_native_a3 = bool(ev_row.get("_is_native_a3"))

                # Find serving PCI at this timestamp from samples (common to both paths)
                best_sample = min(
                    (s for s in samples if s.get("serving", {}).get("pci") is not None),
                    key=lambda s: abs(int(s.get("t_ms") or 0) - ev_t),
                    default=None,
                )
                srv_pci_at_ev = _safe_int((best_sample or {}).get("serving", {}).get("pci")) if best_sample else None

                if is_native_a3:
                    # Native A3 event: extract target PCI + RSRP from event params
                    target_pci: Optional[int] = None
                    for cand in _A3_TARGET_PARAM_CANDIDATES:
                        val = _event_param_value_ci(ev_ref, cand)
                        if val is not None:
                            target_pci = _safe_int(val)
                            if target_pci is not None:
                                break
                    # Fallback: scan ALL params for a numeric value in valid PCI range (0–503)
                    # that doesn't look like a quality metric (RSRP/RSRQ are negative, EARFCN > 503)
                    if target_pci is None:
                        _skip_keys = {k.lower() for k in _A3_SERVING_RSRP_CANDIDATES + _A3_NEIGHBOR_RSRP_CANDIDATES}
                        _skip_keys.update({"earfcn", "frequency", "freq", "rsrp", "rsrq", "sinr", "cinr", "rscp", "ecno", "rxlev"})
                        _params_map = _normalize_event_params_map(ev_ref)
                        for pk, pv in _params_map.items():
                            if any(sk in pk.lower() for sk in _skip_keys):
                                continue
                            candidate_pci = _safe_int(pv)
                            if candidate_pci is not None and 0 <= candidate_pci <= 503:
                                target_pci = candidate_pci
                                break
                        if target_pci is None:
                            # Also check top-level event keys set by patch
                            for pk, pv in (ev_ref or {}).items():
                                if isinstance(pv, (list, dict)) or pk.startswith("_"):
                                    continue
                                if any(sk in pk.lower() for sk in _skip_keys):
                                    continue
                                candidate_pci = _safe_int(pv)
                                if candidate_pci is not None and 0 <= candidate_pci <= 503:
                                    target_pci = candidate_pci
                                    break
                    srv_rsrp_native: Optional[float] = None
                    for cand in _A3_SERVING_RSRP_CANDIDATES:
                        val = _event_param_value_ci(ev_ref, cand)
                        if val is not None:
                            srv_rsrp_native = _safe_float(val)
                            if srv_rsrp_native is not None:
                                break
                    nb_rsrp_native: Optional[float] = None
                    for cand in _A3_NEIGHBOR_RSRP_CANDIDATES:
                        val = _event_param_value_ci(ev_ref, cand)
                        if val is not None:
                            nb_rsrp_native = _safe_float(val)
                            if nb_rsrp_native is not None:
                                break
                    # Fallback: use KPI-derived serving RSRP from nearest sample
                    if srv_rsrp_native is None and best_sample is not None:
                        srv_rsrp_native = _safe_float((best_sample.get("serving") or {}).get("rsrp"))
                    # Last fallback: infer target PCI from next serving-cell transition
                    target_inferred = False
                    is_last_serving = False
                    if target_pci is None:
                        inferred = _infer_a3_target_from_timeline(ev_t, srv_pci_at_ev)
                        if inferred is not None:
                            target_pci = inferred
                            target_inferred = True
                        else:
                            # No subsequent HO — this is the final serving cell in the session
                            is_last_serving = True
                    nb_detail_native = (
                        [{"pci": target_pci, "earfcn": None, "rsrpDbm": nb_rsrp_native,
                          "rsrqDb": None, "inferred": target_inferred}]
                        if target_pci is not None else []
                    )
                    a3_detail_events.append({
                        "time": (ev_ref or {}).get("time") or _epoch_ms_to_iso(ev_t),
                        "tMs": ev_t,
                        "measId": None,
                        "source": "native_a3",
                        "servingPci": srv_pci_at_ev,
                        "servingRsrpDbm": srv_rsrp_native,
                        "neighbors": nb_detail_native,
                        "isLastServing": is_last_serving,
                    })
                else:
                    # Layer 3 MeasurementReport: use decoded neighbor JSON
                    nb_raw = _event_param_value_ci(ev_ref, "measurement_report_neighbors_json")
                    srv_raw = _event_param_value_ci(ev_ref, "measurement_report_serving_json")
                    meas_id = _safe_int(_event_param_value_ci(ev_ref, "measurement_report_measid"))
                    # The patch stores the native Python list on event top-level keys;
                    # the params entry stores a JSON string. Handle both.
                    neighbors_parsed: List[Dict[str, Any]] = []
                    if isinstance(nb_raw, list):
                        neighbors_parsed = nb_raw
                    elif nb_raw:
                        try:
                            neighbors_parsed = json.loads(str(nb_raw)) or []
                        except Exception:
                            pass
                    srv_parsed: Dict[str, Any] = {}
                    if isinstance(srv_raw, dict):
                        srv_parsed = srv_raw
                    elif srv_raw:
                        try:
                            srv_parsed = json.loads(str(srv_raw)) or {}
                        except Exception:
                            pass
                    srv_rsrp_dbm = _safe_float(srv_parsed.get("rsrp_dbm"))
                    # Fallback: KPI-derived serving RSRP when decoded MR serving is absent
                    if srv_rsrp_dbm is None and best_sample is not None:
                        srv_rsrp_dbm = _safe_float((best_sample.get("serving") or {}).get("rsrp"))
                    nb_detail = [
                        {
                            "pci": _safe_int(nb.get("pci")),
                            "earfcn": _safe_int(nb.get("earfcn")),
                            "rsrpDbm": _safe_float(nb.get("rsrp_dbm")),
                            "rsrqDb": _safe_float(nb.get("rsrq_db")),
                        }
                        for nb in (neighbors_parsed if isinstance(neighbors_parsed, list) else [])
                        if _safe_int(nb.get("pci")) is not None
                    ]
                    a3_detail_events.append({
                        "time": (ev_ref or {}).get("time") or _epoch_ms_to_iso(ev_t),
                        "tMs": ev_t,
                        "measId": meas_id,
                        "source": "layer3_mr",
                        "servingPci": srv_pci_at_ev,
                        "servingRsrpDbm": srv_rsrp_dbm,
                        "neighbors": nb_detail,
                    })

        duration_seconds = round(max(0.0, (int(end["t_ms"]) - int(start["t_ms"])) / 1000.0), 1)
        implied_speed_kmh: Optional[float] = None
        speed_sanity_flag = False
        if duration_seconds > 0.5 and route_length_m > 10.0:
            implied_speed_kmh = round(route_length_m / duration_seconds * 3.6, 1)
            speed_sanity_flag = implied_speed_kmh > 140.0
        if len(samples) == 1 and duration_seconds == 0.0 and round(route_length_m, 1) == 0.0 and not hard_failure_support:
            if event_severity == "High":
                event_severity = "Medium"
            event_detection_conf = round(min(event_detection_conf, 0.85), 2)
            event_attr_conf = round(min(event_attr_conf, 0.72), 2)

        member_rows = finalize_member_rows(group_summary)
        group_members_out = sorted(
            member_rows,
            key=lambda row: (
                -int(row.get("groupSampleCount") or 0),
                -int(row.get("nonServingPolluterSampleCount") or 0),
                float(row.get("averageDeltaToBest") or 99.0),
                -(float(row.get("maximumRsrp") or -999.0)),
            ),
        )
        polluters_out = [row for row in member_rows if int(row.get("nonServingPolluterSampleCount") or 0) > 0]
        polluters_out.sort(key=lambda row: (
            -(float(row.get("polluterScore") or 0.0)),
            -int(row.get("nonServingPolluterSampleCount") or 0),
            float(row.get("averageDeltaToBest") or 99.0),
            -(float(row.get("maximumRsrp") or -999.0)),
        ))
        core_polluters_out = [row for row in polluters_out if int(row.get("corePolluterSampleCount") or 0) > 0]
        extended_polluters_out = [row for row in polluters_out if int(row.get("corePolluterSampleCount") or 0) == 0]

        for row in group_members_out:
            row["_avg_count"] = int(row.get("groupSampleCount") or row.get("sampleCount") or 0)
            merge_total_bucket(top_group_member_totals, row)
        for row in polluters_out:
            row["_avg_count"] = int(row.get("groupSampleCount") or row.get("sampleCount") or 0)
            merge_total_bucket(top_polluter_totals, row)
        for row in group_members_out:
            row.pop("_avg_count", None)
        for row in polluters_out:
            row.pop("_avg_count", None)

        evidence = [
            f"{len(samples)} polluted samples on EARFCN {start.get('serving', {}).get('earfcn')}",
            f"Serving sequence: {' -> '.join(str(v) for v in serving_sequence[:12])}" if serving_sequence else "Serving sequence unavailable",
            f"Max strong same-carrier cells within 5 dB: {max_strong_cells}",
        ]
        if avg_serv_rsrq is not None or avg_serv_sinr is not None:
            evidence.append(
                "Average serving quality: "
                + (f"RSRQ {avg_serv_rsrq:.1f} dB" if avg_serv_rsrq is not None else "RSRQ n/a")
                + " / "
                + (f"SINR {avg_serv_sinr:.1f} dB" if avg_serv_sinr is not None else "SINR n/a")
            )
        if event_counts:
            event_parts = [f"{label} {count}" for label, count in sorted(event_counts.items(), key=lambda kv: (-kv[1], kv[0])) if count > 0]
            if event_parts:
                evidence.append("Mobility/signaling support: " + ", ".join(event_parts[:6]))
        if core_polluters_out:
            evidence.append(
                "Core non-serving polluters (≤3 dB): "
                + ", ".join(f"PCI {row['pci']}" for row in core_polluters_out[:4])
            )
        if polluters_out:
            top = polluters_out[0]
            evidence.append(
                f"Top non-serving polluter PCI {top['pci']} score {top['polluterScore']:.2f} "
                f"(samples {top['nonServingPolluterSampleCount']}, avg Δ {top['averageDeltaToBest']:.1f} dB)"
            )
        if serving_was_best_count < len(samples):
            evidence.append("Serving cell was not always the strongest same-carrier cell inside the polluted zone")
        if hard_failure_support:
            hof_count = len(ho_failure_events)
            hof_causes = sorted({e["cause"] for e in ho_failure_events if e.get("cause")})
            hof_desc = ""
            if hof_count:
                cause_str = " / ".join(hof_causes) if hof_causes else ""
                hof_desc = f" ({hof_count} HO failure event{'s' if hof_count > 1 else ''}" + (f": {cause_str}" if cause_str else "") + ")"
            evidence.append(f"A hard-failure event overlaps this zone{hof_desc}")
        if speed_sanity_flag:
            evidence.append(f"Speed sanity flag: implied speed {implied_speed_kmh:.0f} km/h — possible GPS jump or wide event grouping")

        event_payloads.append({
            "id": idx,
            "startTime": start.get("time"),
            "endTime": end.get("time"),
            "startLat": start_lat,
            "startLon": start_lon,
            "endLat": end_lat,
            "endLon": end_lon,
            "durationSeconds": duration_seconds,
            "impliedSpeedKmh": implied_speed_kmh,
            "speedSanityFlag": speed_sanity_flag,
            "routeLengthMeters": round(route_length_m, 1),
            "centerLat": center_lat,
            "centerLon": center_lon,
            "rat": "LTE",
            "carrier": start.get("serving", {}).get("earfcn"),
            "servingPci": start.get("serving", {}).get("pci"),
            "servingPciSequence": serving_sequence,
            "bestPciSequence": best_sequence,
            "servingWasBestRatio": round(serving_was_best_count / len(samples), 2),
            "maxStrongCellsWithin5dB": max_strong_cells,
            "maxStrongCellsWithin3dB": max_strong_cells_core,
            "averageServingRsrp": avg_serv_rsrp,
            "averageServingRsrq": avg_serv_rsrq,
            "averageServingSinr": avg_serv_sinr,
            "severity": event_severity,
            "confidence": event_detection_conf,
            "detectionConfidence": event_detection_conf,
            "attributionConfidence": event_attr_conf,
            "sampleCount": len(samples),
            "topPolluters": polluters_out[:5],
            "topCorePolluters": core_polluters_out[:5],
            "topExtendedPolluters": extended_polluters_out[:5],
            "topPollutionGroupMembers": group_members_out[:8],
            "eventCounts": event_counts,
            "hardFailureSupport": hard_failure_support,
            "servingDwellBlocks": _compute_serving_dwell_blocks(samples),
            "a3Events": a3_detail_events,
            "hoFailureEvents": ho_failure_events,
            "evidence": evidence,
        })

    # Annotate each event with gap distance/time to the next event
    for _i, _ev in enumerate(event_payloads):
        if _i + 1 < len(event_payloads):
            _next = event_payloads[_i + 1]
            _ev_end_ms = _to_epoch_ms(_ev.get("endTime"))
            _next_start_ms = _to_epoch_ms(_next.get("startTime"))
            _gap_ms = int(_next_start_ms - _ev_end_ms) if (_ev_end_ms and _next_start_ms) else None
            _gap_m = _haversine_distance_m(
                _ev.get("endLat") or _ev.get("centerLat"),
                _ev.get("endLon") or _ev.get("centerLon"),
                _next.get("startLat") or _next.get("centerLat"),
                _next.get("startLon") or _next.get("centerLon"),
            )
            _ev["gapToNextEventMs"] = _gap_ms
            _ev["gapToNextEventMeters"] = round(_gap_m, 1) if _gap_m is not None else None
        else:
            _ev["gapToNextEventMs"] = None
            _ev["gapToNextEventMeters"] = None

    verdict = "Not detected"
    if event_payloads:
        if any(str(ev.get("severity")) == "High" for ev in event_payloads):
            verdict = "High"
        elif any(str(ev.get("severity")) == "Medium" for ev in event_payloads):
            verdict = "Medium"
        else:
            verdict = "Low"

    top_polluters_out = sorted(
        [row for row in top_polluter_totals.values() if int(row.get("nonServingPolluterSampleCount") or 0) > 0],
        key=lambda row: (
            -(float(row.get("polluterScore") or 0.0)),
            -int(row.get("nonServingPolluterSampleCount") or 0),
            float(row.get("averageDeltaToBest") or 99.0),
            -(float(row.get("maximumRsrp") or -999.0)),
        ),
    )[:8]
    for row in top_polluters_out:
        row.pop("_avg_count", None)
    top_group_members_out = sorted(
        top_group_member_totals.values(),
        key=lambda row: (
            -int(row.get("groupSampleCount") or 0),
            -int(row.get("nonServingPolluterSampleCount") or 0),
            float(row.get("averageDeltaToBest") or 99.0),
            -(float(row.get("maximumRsrp") or -999.0)),
        ),
    )[:10]
    for row in top_group_members_out:
        row.pop("_avg_count", None)

    center_summary = next((row for row in all_sample_summaries if row["t_ms"] == center_ms), None)
    if center_summary is None and all_sample_summaries:
        center_summary = min(all_sample_summaries, key=lambda row: abs(row["t_ms"] - center_ms))

    # Cross-check the KPI-derived serving cell against the RRC-decoded serving cell.
    # The KPI stream updates on a fixed reporting cycle (typically 1-3 s) and may lag
    # behind the decoded RRC event, which fires exactly when the measurement report
    # is sent. When a handover occurred between two KPI samples, the selected-sample
    # verdict would show the pre-handover serving cell from the KPI stream while the
    # Point Details panel (which reads the RRC event) shows the correct new serving.
    # Prefer the RRC-decoded value when it is available within a ±1 s window.
    _sn_idx = _get_serving_neighbors_index(entry)
    _rrc_serving_correction: Optional[Dict[str, Any]] = None
    if _sn_idx is not None and center_summary is not None:
        try:
            _decoded = _sn_idx.getServingNeighborsAt(center_iso, windowMs=1000) or {}
            _rrc_srv = _decoded.get("serving") or {}
            _rrc_pci = _safe_int(_rrc_srv.get("pci"))
            _rrc_earfcn = _safe_int(_rrc_srv.get("earfcn"))
            if _rrc_pci is not None:
                _cs = center_summary.get("serving") or {}
                _kpi_pci = _cs.get("pci")
                _kpi_earfcn = _cs.get("earfcn")
                _pci_differs = _kpi_pci != _rrc_pci
                _earfcn_differs = _rrc_earfcn is not None and _kpi_earfcn != _rrc_earfcn
                if _pci_differs or _earfcn_differs:
                    # RSRP / RSRQ: use MR-decoded PCell values (more accurate than KPI).
                    _rrc_rsrp = _safe_float(_rrc_srv.get("rsrp_dbm"))
                    _rrc_rsrq = _safe_float(_rrc_srv.get("rsrq_db"))
                    # SINR is not carried in the LTE MeasurementReport — clear the
                    # KPI-derived SINR that belonged to the wrong serving cell.
                    _kpi_rsrp = _cs.get("rsrp")
                    _kpi_rsrq = _cs.get("rsrq")
                    _kpi_sinr = _cs.get("sinr")
                    _kpi_pdsch_sinr = _cs.get("pdschSinr")

                    # Re-derive bestRsrp on the corrected carrier using RRC neighbor data.
                    _rrc_neighbors = _decoded.get("neighbors_merged") or []
                    _rrc_carrier_rsrps = [
                        float(n["rsrp_dbm"])
                        for n in _rrc_neighbors
                        if n.get("rat") == "LTE"
                        and _safe_int(n.get("earfcn")) == _rrc_earfcn
                        and n.get("rsrp_dbm") is not None
                    ]
                    if _rrc_rsrp is not None:
                        _rrc_carrier_rsrps.append(_rrc_rsrp)
                    _rrc_best_rsrp = round(max(_rrc_carrier_rsrps), 1) if _rrc_carrier_rsrps else None

                    _rrc_serving_correction = {
                        "kpiPci": _kpi_pci,
                        "kpiEarfcn": _kpi_earfcn,
                        "kpiRsrp": _kpi_rsrp,
                        "kpiRsrq": _kpi_rsrq,
                        "kpiSinr": _kpi_sinr,
                        "kpiPdschSinr": _kpi_pdsch_sinr,
                        "rrcPci": _rrc_pci,
                        "rrcEarfcn": _rrc_earfcn,
                        "rrcRsrp": _rrc_rsrp,
                        "rrcRsrq": _rrc_rsrq,
                        "rrcBestRsrp": _rrc_best_rsrp,
                        "rrcSource": _rrc_srv.get("source"),
                        "rrcTime": _rrc_srv.get("time"),
                        "windowMs": 1000,
                    }

                    _cs_serving = center_summary.setdefault("serving", {})
                    _cs_serving["pci"] = _rrc_pci
                    if _rrc_earfcn is not None:
                        _cs_serving["earfcn"] = _rrc_earfcn
                    if _rrc_rsrp is not None:
                        _cs_serving["rsrp"] = _rrc_rsrp
                    if _rrc_rsrq is not None:
                        _cs_serving["rsrq"] = _rrc_rsrq
                    # SINR belonged to the wrong carrier — clear it so the UI shows N/A.
                    _cs_serving["sinr"] = None
                    _cs_serving["pdschSinr"] = None
                    _cs_serving["sinrAgeMs"] = None
                    _cs_serving["pdschSinrAgeMs"] = None
                    # Preserve originals for debug / UI note.
                    _cs_serving["_kpiPci"] = _kpi_pci
                    _cs_serving["_kpiEarfcn"] = _kpi_earfcn
                    _cs_serving["_kpiRsrp"] = _kpi_rsrp
                    _cs_serving["_kpiRsrq"] = _kpi_rsrq
                    _cs_serving["_kpiSinr"] = _kpi_sinr
                    _cs_serving["_kpiPdschSinr"] = _kpi_pdsch_sinr
                    _cs_serving["_rrcCorrected"] = True

                    if _rrc_best_rsrp is not None:
                        center_summary["_kpiBestRsrp"] = center_summary.get("bestRsrp")
                        center_summary["bestRsrp"] = _rrc_best_rsrp
        except Exception:
            pass

    return {
        "status": "success",
        "analysis": {
            "rat": "LTE",
            "verdict": verdict,
            "centerTime": center_iso,
            "centerLat": _safe_float(lat),
            "centerLon": _safe_float(lon),
            "windowMs": half_window_ms,
            "config": {
                "rfExpiryMs": rf_expiry,
                "identityExpiryMs": identity_expiry,
                "clusterGapMs": cluster_gap,
                "clusterGapMeters": cluster_gap_distance,
                "strongThresholdRsrpDbm": -105.0,
                "deltaToBestDb": 5.0,
                "coreDeltaDb": 3.0,
                "qualityThresholdSinrDb": 5.0,
                "qualityThresholdRsrqDb": -12.0,
                "mergePaddingMs": max(cluster_gap + 1000, 4000),
                "mergePaddingMeters": max(cluster_gap_distance + 50.0, 150.0),
            },
            "summary": {
                "eventCount": len(event_payloads),
                "pollutedSampleCount": len(polluted_samples),
                "evaluatedSampleCount": len(all_sample_summaries),
                "topPolluters": top_polluters_out,
                "topPollutionGroupMembers": top_group_members_out,
                "selectedSample": center_summary,
            },
            "events": event_payloads,
            "samples": polluted_samples,
            "debug": {
                "centerSample": center_summary,
                "servingMetricNames": serving_metric_names,
                "neighborMetricNames": neighbor_metric_names,
                "trackPointsUsed": len(track_rows),
                "windowStart": _epoch_ms_to_iso(window_start),
                "windowEnd": _epoch_ms_to_iso(window_end),
                "servingCellCorrection": _rrc_serving_correction,
            },
        },
    }


# ---------------------------------------------------------------------------
# Route-wide pilot pollution scan
# ---------------------------------------------------------------------------

def scan_route_pilot_pollution(
    run_id: int,
    rf_expiry_ms: int = 3000,
    identity_expiry_ms: int = 10000,
    cluster_gap_ms: int = 3000,
    cluster_gap_m: float = 100.0,
    min_polluted_samples: int = 2,
) -> Dict[str, Any]:
    """
    Single-pass scan of an entire run for LTE pilot-pollution zones.

    Builds the per-timestamp sample state once (O(N) in kpi_samples),
    clusters polluted timestamps into zones, scores each zone, and returns
    a ranked list without the per-click overhead of analyze_pilot_pollution_at_point.
    """
    rid = int(run_id)
    if rid not in _RUNS:
        return {"status": "error", "message": "Run not found"}

    entry = _RUNS[rid]
    rf_expiry       = int(max(500,  _safe_int(rf_expiry_ms)       or 3000))
    identity_expiry = int(max(rf_expiry, _safe_int(identity_expiry_ms) or 10000))
    cluster_gap     = int(max(500,  _safe_int(cluster_gap_ms)     or 3000))
    cluster_gap_distance = float(cluster_gap_m if cluster_gap_m is not None else 100.0)

    def metric_or_none(candidates: List[str]) -> Optional[str]:
        return _pick_best_metric_name(entry, candidates)

    serving_metric_names = {
        "pci":   metric_or_none(["Radio.Lte.ServingCell[0].Pci",  "Radio.Lte.ServingCell[8].Pci",  "Radio.Lte.ServingCellTotal.Pci"]),
        "earfcn":metric_or_none(["Radio.Lte.ServingCell[0].Downlink.Earfcn", "Radio.Lte.ServingCell[8].Downlink.Earfcn",
                                  "Radio.Lte.ServingCellTotal.Downlink.Earfcn",
                                  "Radio.Lte.ServingCell[0].Earfcn", "Radio.Lte.ServingCell[8].Earfcn"]),
        "rsrp":  metric_or_none(["Radio.Lte.ServingCell[0].Rsrp", "Radio.Lte.ServingCell[8].Rsrp", "Radio.Lte.ServingCellTotal.Rsrp"]),
        "rsrq":  metric_or_none(["Radio.Lte.ServingCell[0].Rsrq", "Radio.Lte.ServingCell[8].Rsrq", "Radio.Lte.ServingCellTotal.Rsrq"]),
        "sinr":  metric_or_none(["Radio.Lte.ServingCell[0].RsSinr", "Radio.Lte.ServingCell[8].RsSinr",
                                  "Radio.Lte.ServingCellTotal.RsSinr",
                                  "Radio.Lte.ServingCell[0].Sinr",  "Radio.Lte.ServingCell[8].Sinr"]),
    }
    neighbor_metric_names = {
        "pci":   LTE_NEIGHBOR_PCI_METRIC,
        "earfcn":metric_or_none(LTE_NEIGHBOR_EARFCN_METRICS) or LTE_NEIGHBOR_EARFCN_METRICS[0],
        "rsrp":  LTE_NEIGHBOR_RSRP_METRIC,
        "rsrq":  LTE_NEIGHBOR_RSRQ_METRIC,
        "sinr":  metric_or_none(LTE_NEIGHBOR_CINR_METRICS) or LTE_NEIGHBOR_CINR_METRICS[0],
    }
    needed_names = {v for v in list(serving_metric_names.values()) + list(neighbor_metric_names.values()) if v}
    if not needed_names:
        return {"status": "error", "message": "Required LTE metrics are not available for this run"}

    serving_name_to_field  = {name: field for field, name in serving_metric_names.items() if name}
    neighbor_name_to_field = {name: field for field, name in neighbor_metric_names.items() if name}
    earfcn_scale_div = _normalize_neighbor_earfcn_div(entry)

    # ── 1. Collect and sort ALL relevant kpi_samples ─────────────────────────
    sample_rows: List[Dict[str, Any]] = []
    for sample in entry.get("kpi_samples") or []:
        name = str((sample or {}).get("name") or "")
        if name not in needed_names:
            continue
        if name in serving_name_to_field and _is_serving_array_metric(name):
            if _extract_neighbor_sample_index(sample or {}) not in (None, 0):
                continue
        t_ms = _sample_time_ms(sample or {})
        if t_ms is None:
            continue
        sample_rows.append({
            "t_ms": t_ms,
            "name": name,
            "value": _safe_float((sample or {}).get("value_num")),
            "idx": _extract_neighbor_sample_index(sample or {}),
        })
    sample_rows.sort(key=lambda r: (r["t_ms"], str(r["name"])))

    # ── 2. Collect and sort ALL track points ─────────────────────────────────
    track_rows: List[Dict[str, Any]] = []
    for row in entry.get("track_points") or []:
        t_ms = _to_epoch_ms((row or {}).get("time"))
        if t_ms is None:
            continue
        track_rows.append({
            "t_ms": t_ms,
            "time": (row or {}).get("time") or _epoch_ms_to_iso(t_ms),
            "lat": _safe_float((row or {}).get("lat")),
            "lon": _safe_float((row or {}).get("lon")),
        })
    track_rows.sort(key=lambda r: r["t_ms"])

    # ── 3. Collect ALL events ─────────────────────────────────────────────────
    _A3_KEY  = "radio.lte.measurementreporting.a3event"
    _HOF_KEY = "reestablishmentrequest"
    _hard_failure_names = {
        "radio.nr.scgfailureevent",
        "radio.5g.servicelostevent",
        "pocket.radio.nr.datasessiondropevent",
        "data.ipinterruptiontimeevent",
        "message.layer3.errc.ccchul.rrcconnectionreestablishmentrequest",
        "message.layer3.errc.ccchdl.rrcconnectionreestablishmentreject",
        "message.layer3.errc.dcchdl.rrcconnectionrelease",
    }
    event_rows_all: List[Dict[str, Any]] = []
    for ev in entry.get("events") or []:
        t_ms = _to_epoch_ms((ev or {}).get("time") or (ev or {}).get("timestamp") or (ev or {}).get("ts"))
        if t_ms is None:
            continue
        name_lc = str((ev or {}).get("event_name") or (ev or {}).get("event") or "").lower()
        row: Dict[str, Any] = {
            "t_ms": t_ms,
            "name_lc": name_lc,
            "is_a3": _A3_KEY in name_lc,
            "is_hof": _HOF_KEY in name_lc or name_lc in _hard_failure_names,
        }
        if row["is_hof"]:
            row["_ev_ref"] = ev
        event_rows_all.append(row)
    event_rows_all.sort(key=lambda r: r["t_ms"])

    # ── 4. State machine helpers (same as in analyze_pilot_pollution_at_point) ─
    serving_state: Dict[str, Dict[str, Any]] = {}
    neighbor_state: Dict[int, Dict[str, Dict[str, Any]]] = {}

    def update_state(bucket: Dict, field: str, value: Any, t_ms: int) -> None:
        bucket[field] = {"value": value, "t_ms": t_ms}

    def get_state_value(bucket: Dict, field: str, now_ms: int, expiry_ms: int) -> Tuple[Optional[float], Optional[int]]:
        state = bucket.get(field) or {}
        value = state.get("value")
        ts    = _safe_int(state.get("t_ms"))
        if ts is None or value is None:
            return None, None
        age = now_ms - ts
        if age < 0 or age > expiry_ms:
            return None, None
        return _safe_float(value), age

    def get_identity_value(bucket: Dict, field: str, now_ms: int) -> Tuple[Optional[int], Optional[int]]:
        val, age = get_state_value(bucket, field, now_ms, identity_expiry)
        return (_safe_int(round(val)), age) if val is not None else (None, None)

    def get_rf_value(bucket: Dict, field: str, now_ms: int) -> Tuple[Optional[float], Optional[int]]:
        return get_state_value(bucket, field, now_ms, rf_expiry)

    _track_ts_list = [r["t_ms"] for r in track_rows]

    def nearest_position(now_ms: int) -> Dict[str, Any]:
        if not track_rows:
            return {}
        idx = bisect.bisect_right(_track_ts_list, now_ms)
        # idx is the insertion point; pick the closest of idx-1 and idx
        candidates = [i for i in (idx - 1, idx) if 0 <= i < len(track_rows)]
        best_idx = min(candidates, key=lambda i: abs(track_rows[i]["t_ms"] - now_ms))
        best = track_rows[best_idx]
        return {"lat": best.get("lat"), "lon": best.get("lon"), "time": best.get("time")}

    # ── 5. Single-pass state update + pollution check ─────────────────────────
    eval_timestamps = sorted({int(r["t_ms"]) for r in track_rows})
    if not eval_timestamps and sample_rows:
        eval_timestamps = sorted({int(r["t_ms"]) for r in sample_rows})
    if not eval_timestamps:
        return {"status": "error", "message": "No track points found in run"}

    samples_by_time: Dict[int, List[Dict]] = {}
    for row in sample_rows:
        samples_by_time.setdefault(int(row["t_ms"]), []).append(row)
    sample_times_sorted = sorted(samples_by_time.keys())

    polluted_samples: List[Dict[str, Any]] = []
    pointer = 0

    for ts in eval_timestamps:
        while pointer < len(sample_times_sorted) and sample_times_sorted[pointer] <= ts:
            row_ts = sample_times_sorted[pointer]
            for row in samples_by_time.get(row_ts) or []:
                name  = str(row.get("name") or "")
                value = row.get("value")
                if name in serving_name_to_field:
                    update_state(serving_state, serving_name_to_field[name], value, row_ts)
                    continue
                if name in neighbor_name_to_field:
                    idx = _safe_int(row.get("idx"))
                    if idx is None:
                        continue
                    slot  = neighbor_state.setdefault(idx, {})
                    field = neighbor_name_to_field[name]
                    if field == "earfcn" and value is not None and earfcn_scale_div == 2 and int(round(value)) % 2 == 0:
                        value = int(round(value)) // 2
                    update_state(slot, field, value, row_ts)
            pointer += 1

        serving_pci,   _ = get_identity_value(serving_state, "pci",   ts)
        serving_earfcn, _ = get_identity_value(serving_state, "earfcn", ts)
        if serving_earfcn is None and serving_pci is not None:
            _es = serving_state.get("earfcn") or {}
            _ev = _safe_int(_safe_float(_es.get("value")))
            if _ev is not None:
                serving_earfcn = _ev
        serving_rsrp, _ = get_rf_value(serving_state, "rsrp", ts)
        serving_rsrq, _ = get_rf_value(serving_state, "rsrq", ts)
        serving_sinr, _ = get_rf_value(serving_state, "sinr", ts)

        if serving_earfcn is None or serving_pci is None or serving_rsrp is None:
            continue

        neighbors_by_key: Dict[Tuple[int, int], Dict] = {}
        for idx, state in neighbor_state.items():
            pci,   _ = get_identity_value(state, "pci",   ts)
            earfcn,_ = get_identity_value(state, "earfcn", ts)
            rsrp,  _ = get_rf_value(state, "rsrp", ts)
            if pci is None or rsrp is None or earfcn != serving_earfcn:
                continue
            key = (earfcn, pci)
            if key not in neighbors_by_key or rsrp > neighbors_by_key[key]["rsrp"]:
                neighbors_by_key[key] = {"pci": pci, "earfcn": earfcn, "rsrp": rsrp, "rsrq": None}

        neighbors = list(neighbors_by_key.values())
        if len(neighbors) < 2:
            continue

        all_cells = [{"pci": serving_pci, "earfcn": serving_earfcn, "rsrp": serving_rsrp, "role": "serving"}] + \
                    [{"pci": nb["pci"], "earfcn": nb["earfcn"], "rsrp": nb["rsrp"], "role": "neighbor"} for nb in neighbors]
        best_rsrp = max(c["rsrp"] for c in all_cells)
        strong_cells = [c for c in all_cells if c["rsrp"] >= -105.0 and (best_rsrp - c["rsrp"]) <= 5.0]

        quality_bad = (
            (serving_sinr is not None and serving_sinr < 5.0) or
            (serving_rsrq is not None and serving_rsrq <= -12.0)
        )
        polluted = quality_bad and best_rsrp >= -105.0 and len(strong_cells) >= 3

        if not polluted:
            continue

        position = nearest_position(ts)
        severity = "Low"
        if len(strong_cells) >= 5 and (
            (serving_sinr is not None and serving_sinr < 0.0) or
            (serving_rsrq is not None and serving_rsrq <= -14.0)
        ):
            severity = "High"
        elif len(strong_cells) >= 4 or (serving_sinr is not None and serving_sinr < 3.0) or \
                (serving_rsrq is not None and serving_rsrq <= -13.0):
            severity = "Medium"

        polluted_samples.append({
            "t_ms": ts, "time": _epoch_ms_to_iso(ts),
            "lat": position.get("lat"), "lon": position.get("lon"),
            "serving": {"pci": serving_pci, "earfcn": serving_earfcn,
                        "rsrp": serving_rsrp, "rsrq": serving_rsrq, "sinr": serving_sinr},
            "strongCells": strong_cells, "strongCellCount": len(strong_cells),
            "severity": severity,
        })

    if not polluted_samples:
        return {"status": "success", "zones": [], "totalZones": 0, "totalPollutedSamples": 0}

    # ── 6. Cluster polluted samples into zones ────────────────────────────────
    def same_zone(a: Dict, b: Dict) -> bool:
        if a.get("serving", {}).get("earfcn") != b.get("serving", {}).get("earfcn"):
            return False
        if (int(b["t_ms"]) - int(a["t_ms"])) > cluster_gap:
            return False
        dist = _haversine_distance_m(a.get("lat"), a.get("lon"), b.get("lat"), b.get("lon"))
        return dist is None or dist <= cluster_gap_distance

    raw_zones: List[List[Dict]] = []
    for s in polluted_samples:
        if not raw_zones or not same_zone(raw_zones[-1][-1], s):
            raw_zones.append([s])
        else:
            raw_zones[-1].append(s)

    # Drop singleton zones with no mobility neighbours
    singleton_gap = max(cluster_gap * 2, 6000)
    zones_filtered: List[List[Dict]] = []
    for i, zone in enumerate(raw_zones):
        if len(zone) >= min_polluted_samples:
            zones_filtered.append(zone)
            continue
        prev_end = raw_zones[i - 1][-1]["t_ms"] if i > 0 else None
        next_start = raw_zones[i + 1][0]["t_ms"] if i + 1 < len(raw_zones) else None
        adjacent = (
            (prev_end is not None and (zone[0]["t_ms"] - prev_end) <= singleton_gap) or
            (next_start is not None and (next_start - zone[-1]["t_ms"]) <= singleton_gap)
        )
        if adjacent:
            zones_filtered.append(zone)

    # ── 7. Score each zone ────────────────────────────────────────────────────
    severity_rank = {"Low": 1, "Medium": 2, "High": 3}
    zone_results: List[Dict[str, Any]] = []

    for zone_samples in zones_filtered:
        start_t = zone_samples[0]["t_ms"]
        end_t   = zone_samples[-1]["t_ms"]
        duration_s = (end_t - start_t) / 1000.0

        # Aggregate polluter scores (same logic as in analyze_pilot_pollution_at_point)
        group_summary: Dict[Tuple[int, int], Dict] = {}
        serving_seq: List[int] = []
        rsrp_sum = rsrq_sum = sinr_sum = 0.0
        rsrq_n = sinr_n = 0
        max_strong = 0
        srv_was_best_cnt = 0

        for s in zone_samples:
            srv = s.get("serving", {})
            sp = _safe_int(srv.get("pci"))
            if sp is not None and (not serving_seq or serving_seq[-1] != sp):
                serving_seq.append(sp)
            if srv.get("rsrp") is not None:
                rsrp_sum += float(srv["rsrp"])
            if srv.get("rsrq") is not None:
                rsrq_sum += float(srv["rsrq"]); rsrq_n += 1
            if srv.get("sinr") is not None:
                sinr_sum += float(srv["sinr"]); sinr_n += 1
            sc = s.get("strongCells") or []
            if len(sc) > max_strong:
                max_strong = len(sc)
            best_r = max((c["rsrp"] for c in sc if c.get("rsrp") is not None), default=None)
            if best_r is not None and srv.get("rsrp") is not None and abs(best_r - float(srv["rsrp"])) < 0.15:
                srv_was_best_cnt += 1
            earfcn = _safe_int(srv.get("earfcn"))
            for cell in sc:
                pci = _safe_int(cell.get("pci"))
                if pci is None or earfcn is None:
                    continue
                if cell.get("role") == "serving":
                    continue
                key = (earfcn, pci)
                delta = best_r - float(cell["rsrp"]) if best_r is not None and cell.get("rsrp") is not None else None
                if key not in group_summary:
                    group_summary[key] = {
                        "pci": pci, "earfcn": earfcn,
                        "samples": 0, "core_hits": 0,
                        "rsrp_sum": 0.0, "delta_sum": 0.0,
                    }
                g = group_summary[key]
                g["samples"] += 1
                if delta is not None and delta <= 3.0:
                    g["core_hits"] += 1
                if cell.get("rsrp") is not None:
                    g["rsrp_sum"] += float(cell["rsrp"])
                if delta is not None:
                    g["delta_sum"] += delta

        n = len(zone_samples)
        avg_rsrp = rsrp_sum / n
        avg_rsrq = rsrq_sum / rsrq_n if rsrq_n else None
        avg_sinr = sinr_sum / sinr_n if sinr_n else None

        polluters_scored = []
        for (earfcn, pci), g in group_summary.items():
            sc_count = g["samples"]
            if sc_count == 0:
                continue
            avg_delta = g["delta_sum"] / sc_count
            avg_nb_rsrp = g["rsrp_sum"] / sc_count
            core_ratio = g["core_hits"] / sc_count
            score = round(
                sc_count * (1.0 + core_ratio) * max(0.1, 5.0 - avg_delta) * 1.5, 2
            )
            polluters_scored.append({
                "pci": pci, "earfcn": earfcn,
                "samples": sc_count, "coreHits": g["core_hits"],
                "avgRsrp": round(avg_nb_rsrp, 1), "avgDelta": round(avg_delta, 2),
                "score": score,
            })
        polluters_scored.sort(key=lambda r: -r["score"])

        # Overall zone severity = worst single-sample severity
        zone_sev = max((s["severity"] for s in zone_samples), key=lambda sv: severity_rank.get(sv, 0))

        # Count A3 / HO-failure events in zone window (binary search)
        t_lo = start_t - cluster_gap
        t_hi = end_t + cluster_gap
        a3_count = hof_count = 0
        hof_details: List[Dict] = []
        for ev in event_rows_all:
            ev_t = ev["t_ms"]
            if ev_t < t_lo:
                continue
            if ev_t > t_hi:
                break
            if ev["is_a3"]:
                a3_count += 1
            if ev["is_hof"]:
                hof_count += 1
                ref = ev.get("_ev_ref") or {}
                hof_details.append({
                    "time": ref.get("time") or _epoch_ms_to_iso(ev_t),
                    "cause": ref.get("reestablishmentCause") or "",
                    "sourcePci": _safe_int(ref.get("sourcePci")),
                    "targetPci": _safe_int(ref.get("targetPci")),
                })

        # Center point = sample with worst RSRQ
        worst = min(
            zone_samples,
            key=lambda s: float(s.get("serving", {}).get("rsrq") or 0.0),
        )
        center_lat = worst.get("lat")
        center_lon = worst.get("lon")
        center_time = worst.get("time")

        zone_results.append({
            "earfcn":         _safe_int(zone_samples[0].get("serving", {}).get("earfcn")),
            "severity":       zone_sev,
            "startTime":      zone_samples[0]["time"],
            "endTime":        zone_samples[-1]["time"],
            "centerTime":     center_time,
            "centerLat":      center_lat,
            "centerLon":      center_lon,
            "durationSeconds":round(duration_s, 1),
            "sampleCount":    n,
            "maxStrongCells": max_strong,
            "avgServingRsrp": round(avg_rsrp, 1),
            "avgServingRsrq": round(avg_rsrq, 1) if avg_rsrq is not None else None,
            "avgServingSinr": round(avg_sinr, 1) if avg_sinr is not None else None,
            "servingPciSequence": serving_seq,
            "topPolluters":   polluters_scored[:5],
            "a3EventCount":   a3_count,
            "hoFailureCount": hof_count,
            "hoFailureEvents":hof_details,
            "hardFailureSupport": hof_count > 0,
        })

    # Sort: High first, then by score (sample count × severity)
    zone_results.sort(key=lambda z: (
        -severity_rank.get(z["severity"], 0),
        -z["sampleCount"],
    ))

    return {
        "status": "success",
        "zones": zone_results,
        "totalZones": len(zone_results),
        "totalPollutedSamples": len(polluted_samples),
        "runId": rid,
    }

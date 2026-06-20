"""
NR RRC (5G New Radio Radio Resource Control) structured field extractor.

Works on decoded JSON output from pycrate_asn1dir.RRCNR and produces
structured summaries mirroring the LTE RRC decoder approach.
"""

from __future__ import annotations

import json
from typing import Any, Dict, List, Optional


def _safe_int(v: Any) -> Optional[int]:
    try:
        if v is None or isinstance(v, bool):
            return None
        return int(v)
    except Exception:
        return None


def _safe_float(v: Any) -> Optional[float]:
    try:
        if v is None or isinstance(v, bool):
            return None
        return float(v)
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


def _json_contains(node: Any, token: str) -> bool:
    try:
        return token in json.dumps(node, ensure_ascii=True).lower()
    except Exception:
        return False


# NR RSRP index to dBm: RSRP_NR = index - 156
def _nr_rsrp_to_dbm(idx: Optional[int]) -> Optional[float]:
    if idx is None:
        return None
    return float(idx - 156)


# NR RSRQ index to dB: RSRQ_NR = (index / 2) - 43
def _nr_rsrq_to_db(idx: Optional[int]) -> Optional[float]:
    if idx is None:
        return None
    return float(idx / 2.0 - 43.0)


# NR SINR index to dB: SINR_NR = (index / 2) - 23
def _nr_sinr_to_db(idx: Optional[int]) -> Optional[float]:
    if idx is None:
        return None
    return float(idx / 2.0 - 23.0)


def _extract_nr_measurement_report(decoded_json: Any) -> Dict[str, Any]:
    summary: Dict[str, Any] = {}

    meas_id = _safe_int(_first_present(decoded_json, ["measId", "measID"]))
    summary["measId"] = meas_id

    # Serving cell measurements
    serving = _first_present(decoded_json, ["measResultServingMOList", "measResultNR"])
    if isinstance(serving, list) and serving:
        first_serv = serving[0] if isinstance(serving[0], dict) else {}
        meas_nr = first_serv.get("measResultNR") or first_serv
        if isinstance(meas_nr, dict):
            cell_results = meas_nr.get("measResult") or meas_nr.get("cellResults") or meas_nr
            if isinstance(cell_results, dict):
                results_ssb = cell_results.get("resultsSSB-Cell") or cell_results.get("resultsSSB") or cell_results
                if isinstance(results_ssb, dict):
                    rsrp_idx = _safe_int(results_ssb.get("rsrp") or results_ssb.get("ssb-RSRP"))
                    rsrq_idx = _safe_int(results_ssb.get("rsrq") or results_ssb.get("ssb-RSRQ"))
                    sinr_idx = _safe_int(results_ssb.get("sinr") or results_ssb.get("ssb-SINR"))
                    summary["serving_ssb_rsrp_idx"] = rsrp_idx
                    summary["serving_ssb_rsrp_dbm"] = _nr_rsrp_to_dbm(rsrp_idx)
                    summary["serving_ssb_rsrq_idx"] = rsrq_idx
                    summary["serving_ssb_rsrq_db"] = _nr_rsrq_to_db(rsrq_idx)
                    summary["serving_ssb_sinr_idx"] = sinr_idx
                    summary["serving_ssb_sinr_db"] = _nr_sinr_to_db(sinr_idx)

    # Neighbor cells
    neigh_list = _first_present(decoded_json, [
        "measResultNeighCells",
        "measResultListNR",
        "measResultsPerCarrierListNR",
    ])
    neighbors: List[Dict[str, Any]] = []
    if isinstance(neigh_list, dict):
        nr_cells = neigh_list.get("measResultListNR") or []
    elif isinstance(neigh_list, list):
        nr_cells = neigh_list
    else:
        nr_cells = []

    for cell in nr_cells:
        if not isinstance(cell, dict):
            continue
        pci = _safe_int(cell.get("physCellId"))
        meas = cell.get("measResult") or cell.get("measResultNR") or {}
        if isinstance(meas, dict):
            cell_res = meas.get("cellResults") or meas.get("measResult") or meas
            if isinstance(cell_res, dict):
                ssb = cell_res.get("resultsSSB-Cell") or cell_res.get("resultsSSB") or cell_res
                csi = cell_res.get("resultsCSI-RS-Cell") or cell_res.get("resultsCSI") or {}
                rsrp_idx = _safe_int((ssb or {}).get("rsrp") if isinstance(ssb, dict) else None)
                rsrq_idx = _safe_int((ssb or {}).get("rsrq") if isinstance(ssb, dict) else None)
                sinr_idx = _safe_int((ssb or {}).get("sinr") if isinstance(ssb, dict) else None)
                csi_rsrp_idx = _safe_int((csi or {}).get("rsrp") if isinstance(csi, dict) else None)
                csi_sinr_idx = _safe_int((csi or {}).get("sinr") if isinstance(csi, dict) else None)
                neighbors.append({
                    "rat": "NR",
                    "pci": pci,
                    "ssb_rsrp_idx": rsrp_idx,
                    "ssb_rsrp_dbm": _nr_rsrp_to_dbm(rsrp_idx),
                    "ssb_rsrq_idx": rsrq_idx,
                    "ssb_rsrq_db": _nr_rsrq_to_db(rsrq_idx),
                    "ssb_sinr_idx": sinr_idx,
                    "ssb_sinr_db": _nr_sinr_to_db(sinr_idx),
                    "csi_rsrp_idx": csi_rsrp_idx,
                    "csi_rsrp_dbm": _nr_rsrp_to_dbm(csi_rsrp_idx),
                    "csi_sinr_idx": csi_sinr_idx,
                    "csi_sinr_db": _nr_sinr_to_db(csi_sinr_idx),
                })

    summary["neighbors_nr"] = neighbors
    summary["neighbors_nr_count"] = len(neighbors)
    return summary


def _extract_nr_reconfiguration(decoded_json: Any) -> Dict[str, Any]:
    summary: Dict[str, Any] = {}

    # Measurement configuration
    meas_cfg = _first_present(decoded_json, ["measConfig", "meas-Config", "measConfigNR"])
    if isinstance(meas_cfg, dict):
        meas_objects = meas_cfg.get("measObjectToAddModList") or []
        report_configs = meas_cfg.get("reportConfigToAddModList") or []
        meas_ids = meas_cfg.get("measIdToAddModList") or []
        summary["measObjectCount"] = len(meas_objects) if isinstance(meas_objects, list) else 0
        summary["reportConfigCount"] = len(report_configs) if isinstance(report_configs, list) else 0
        summary["measIdCount"] = len(meas_ids) if isinstance(meas_ids, list) else 0

        # Extract NR frequency list from measObjects
        nr_freqs = []
        for obj in (meas_objects if isinstance(meas_objects, list) else []):
            if not isinstance(obj, dict):
                continue
            meas_obj = obj.get("measObject") or obj
            if isinstance(meas_obj, dict):
                nr_freq = meas_obj.get("measObjectNR")
                if isinstance(nr_freq, dict):
                    nr_freqs.append(_safe_int(nr_freq.get("ssbFrequency") or nr_freq.get("nrFrequency")))
        summary["nrFrequencies"] = [f for f in nr_freqs if f is not None]

    sp_cell = _find_key(decoded_json, "spCellConfig")
    summary["hasSpCellConfig"] = bool(sp_cell)
    summary["hasSecCellGroup"] = bool(_find_key(decoded_json, "secondaryCellGroup"))
    summary["hasMasterCellGroup"] = bool(_find_key(decoded_json, "masterCellGroup"))
    summary["hasDedicatedNas"] = bool(_find_key(decoded_json, "dedicatedNAS-Message") or _find_key(decoded_json, "dedicatedNasMessage"))

    return summary


def _extract_nr_ue_capability(decoded_json: Any) -> Dict[str, Any]:
    summary: Dict[str, Any] = {}

    rat_containers = _first_present(decoded_json, [
        "ue-CapabilityRAT-ContainerList",
        "ue_CapabilityRAT_ContainerList",
    ])
    summary["ratContainerCount"] = len(rat_containers) if isinstance(rat_containers, list) else 0

    nr_bands: List[int] = []
    mimo_layers_dl: Optional[int] = None

    def _collect_nr_bands(node: Any) -> None:
        nonlocal mimo_layers_dl
        if isinstance(node, dict):
            for k, v in node.items():
                kl = k.lower().replace("-", "").replace("_", "")
                if "bandnr" in kl or "supportedband" in kl:
                    n = _safe_int(v)
                    if isinstance(n, int) and 1 <= n <= 1024:
                        nr_bands.append(n)
                if "maxnumbermimolayerspdsch" in kl or "mimolayers" in kl:
                    layers_map = {"twoLayers": 2, "fourLayers": 4, "eightLayers": 8, "oneLayers": 1, "oneLayer": 1}
                    if isinstance(v, str) and v in layers_map:
                        if mimo_layers_dl is None or layers_map[v] > mimo_layers_dl:
                            mimo_layers_dl = layers_map[v]
                _collect_nr_bands(v)
        elif isinstance(node, list):
            for item in node:
                _collect_nr_bands(item)

    _collect_nr_bands(decoded_json)
    summary["nrBands"] = sorted(set(nr_bands))
    summary["nrBandCount"] = len(summary["nrBands"])
    summary["maxMimoLayersDl"] = mimo_layers_dl
    return summary


def _extract_nr_sib1(decoded_json: Any) -> Dict[str, Any]:
    summary: Dict[str, Any] = {}
    sib1 = _find_key(decoded_json, "sib1") or decoded_json

    cell_access = _find_key(sib1, "cellAccessRelatedInfo") if isinstance(sib1, dict) else None
    if isinstance(cell_access, dict):
        plmn_list = cell_access.get("plmn-IdentityList") or cell_access.get("plmn_IdentityList") or []
        summary["plmnCount"] = len(plmn_list) if isinstance(plmn_list, list) else 0
        tac = cell_access.get("trackingAreaCode") or cell_access.get("tac")
        if isinstance(tac, dict):
            summary["trackingAreaCode"] = tac.get("Val") or next(iter(tac.values()), None)
        elif tac is not None:
            summary["trackingAreaCode"] = tac
        cell_id = cell_access.get("cellIdentity")
        if isinstance(cell_id, dict):
            summary["cellIdentity"] = cell_id.get("Val") or next(iter(cell_id.values()), None)
        elif cell_id is not None:
            summary["cellIdentity"] = cell_id

    serv_cell_cfg = _find_key(sib1, "servingCellConfigCommon") if isinstance(sib1, dict) else None
    if isinstance(serv_cell_cfg, dict):
        dl_freq = serv_cell_cfg.get("downlinkConfigCommon") or {}
        if isinstance(dl_freq, dict):
            freq_info = dl_freq.get("frequencyInfoDL") or {}
            if isinstance(freq_info, dict):
                summary["dlAbsoluteFrequencySSB"] = _safe_int(freq_info.get("absoluteFrequencySSB"))
                summary["dlArfcnPointA"] = _safe_int(freq_info.get("absoluteFrequencyPointA"))
    return summary


def _extract_nr_sib_reselection(decoded_json: Any, sib_key: str) -> Dict[str, Any]:
    summary: Dict[str, Any] = {}
    sib = _find_key(decoded_json, sib_key)
    if not isinstance(sib, dict):
        return summary

    intra_common = sib.get("cellReselectionInfoCommon") or sib.get("intraFreqCellReselectionInfo") or {}
    if isinstance(intra_common, dict):
        summary["qHyst"] = _first_present(intra_common, ["q-Hyst", "qHyst"])
        summary["qRxLevMin"] = _safe_int(_first_present(intra_common, ["q-RxLevMin", "qRxLevMin"]))

    neigh_list = sib.get("intraFreqNeighCellList") or []
    if isinstance(neigh_list, list):
        pcis = [_safe_int(c.get("physCellId")) for c in neigh_list if isinstance(c, dict)]
        summary["intraFreqNeighPCIs"] = [p for p in pcis if p is not None]
        summary["intraFreqNeighCount"] = len(summary["intraFreqNeighPCIs"])

    inter_list = sib.get("interFreqCarrierFreqList") or []
    if isinstance(inter_list, list):
        summary["interFreqCarrierCount"] = len(inter_list)
        freqs = []
        for row in inter_list:
            if isinstance(row, dict):
                freqs.append({
                    "absoluteFrequencySSB": _safe_int(row.get("absoluteFrequencySSB")),
                    "cellReselectionPriority": _safe_int(row.get("cellReselectionPriority")),
                    "threshXHigh": _safe_int(row.get("threshX-High") or row.get("threshXHigh")),
                    "threshXLow": _safe_int(row.get("threshX-Low") or row.get("threshXLow")),
                    "qRxLevMin": _safe_int(row.get("q-RxLevMin") or row.get("qRxLevMin")),
                })
        summary["interFreqCarriers"] = freqs

    return summary


_NR_MESSAGE_NAME_TO_EXTRACT: Dict[str, str] = {
    "measurementreport": "measurement_report",
    "rrcreconfiguration": "rrc_reconfiguration",
    "rrcsecuritymodecomplete": "security_mode",
    "rrcsecuritymodecommand": "security_mode",
    "uecapabilityinformation": "ue_capability",
    "rrcsetupcompl": "rrc_setup_complete",
    "rrcsetup": "rrc_setup",
    "rrcsetuprequest": "rrc_setup_request",
    "rrcreestablishmentrequest": "rrc_reest_request",
}


def extract_nr_rrc_summary(decoded_json: Any, message_name: str) -> Dict[str, Any]:
    """
    Extract a structured summary from NR RRC decoded JSON.
    Returns a dict with message-specific fields.
    """
    if not isinstance(decoded_json, dict):
        return {}

    norm = str(message_name or "").lower().replace("-", "").replace("_", "").replace(" ", "")

    try:
        txt = json.dumps(decoded_json, ensure_ascii=True).lower()
    except Exception:
        txt = ""

    summary: Dict[str, Any] = {"nr_message": message_name}

    if "measurementreport" in txt or "measurementreport" in norm:
        summary.update(_extract_nr_measurement_report(decoded_json))

    elif "rrcreconfiguration" in txt or "rrcreconfiguration" in norm:
        summary.update(_extract_nr_reconfiguration(decoded_json))

    elif "uecapabilityinformation" in txt or "uecapability" in norm:
        summary.update(_extract_nr_ue_capability(decoded_json))

    elif "sib1" in txt and ("cellidentity" in txt or "plmn" in txt or "trackingareacode" in txt):
        summary.update(_extract_nr_sib1(decoded_json))

    elif "sib2" in txt:
        summary.update(_extract_nr_sib_reselection(decoded_json, "sib2"))

    elif "sib3" in txt:
        summary.update(_extract_nr_sib_reselection(decoded_json, "sib3"))

    elif "sib4" in txt:
        summary.update(_extract_nr_sib_reselection(decoded_json, "sib4"))

    elif "rrcsetupcompl" in txt or "rrcsetupcomplete" in txt or "rrcsetupcomplete" in norm:
        summary["selectedPLMNIdentity"] = _safe_int(_first_present(decoded_json, ["selectedPLMN-Identity", "selectedPLMN_Identity"]))
        summary["hasDedicatedNas"] = bool(_find_key(decoded_json, "dedicatedNAS-Message") or _find_key(decoded_json, "dedicatedNASMessage"))

    elif "rrcsetuprequest" in txt or "rrcsetuprequest" in norm:
        summary["establishmentCause"] = _first_present(decoded_json, ["establishmentCause"])

    elif "rrcreestablishmentrequest" in txt or "reestablishmentrequest" in norm:
        summary["reestablishmentCause"] = _first_present(decoded_json, ["reestablishmentCause"])

    elif "rrcreject" in txt or "rrcreject" in norm:
        reject_wait_time = _first_present(decoded_json, ["rejectWaitTime", "waitTime", "rejectWaitTime-r16"])
        if reject_wait_time is not None:
            summary["rejectWaitTime"] = reject_wait_time

    elif "securitymodecommand" in txt or "securitymodecomplete" in txt:
        algo = _find_key(decoded_json, "securityAlgorithmConfig") or _find_key(decoded_json, "selectedNAS-SecurityAlgorithms")
        if isinstance(algo, dict):
            summary["cipheringAlgorithm"] = algo.get("cipheringAlgorithm") or algo.get("ciphAlgo")
            summary["integrityProtAlgorithm"] = algo.get("integrityProtAlgorithm") or algo.get("integAlgo")

    # Remove None values
    return {k: v for k, v in summary.items() if v is not None}

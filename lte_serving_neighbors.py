from __future__ import annotations

import bisect
import copy
import datetime as dt
import json
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple


def _parse_iso_ms(value: Any) -> Optional[int]:
    if value is None:
        return None
    s = str(value).strip()
    if not s:
        return None
    try:
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        return int(dt.datetime.fromisoformat(s).timestamp() * 1000)
    except Exception:
        return None


def _to_iso(ms: Optional[int]) -> Optional[str]:
    if ms is None:
        return None
    try:
        return dt.datetime.fromtimestamp(ms / 1000, tz=dt.timezone.utc).isoformat().replace("+00:00", "Z")
    except Exception:
        return None


def _safe_int(value: Any) -> Optional[int]:
    try:
        n = int(value)
        return n
    except Exception:
        return None


def _rsrp_idx_to_dbm(idx: Optional[int]) -> Optional[float]:
    if idx is None:
        return None
    if 0 <= idx <= 97:
        return float(-140 + idx)
    return None


def _rsrq_idx_to_db(idx: Optional[int]) -> Optional[float]:
    if idx is None:
        return None
    if 0 <= idx <= 34:
        return float(-19.5 + 0.5 * idx)
    return None


def _utra_rscp_idx_to_dbm(idx: Optional[int]) -> Optional[float]:
    if idx is None:
        return None
    # 3GPP TS 25.133 mapping (index 0..96 approximately spans -120..-24 dBm).
    if 0 <= idx <= 96:
        return float(-120 + idx)
    return None


def _utra_ecno_idx_to_db(idx: Optional[int]) -> Optional[float]:
    if idx is None:
        return None
    # 3GPP TS 25.133 mapping (index 0..49 spans -24..0.5 dB with 0.5 dB step).
    if 0 <= idx <= 49:
        return float(-24 + 0.5 * idx)
    return None


def _geran_rxlev_to_dbm(idx: Optional[int]) -> Optional[float]:
    if idx is None:
        return None
    # 3GPP TS 45.008 RxLev mapping.
    if 0 <= idx <= 63:
        return float(-110 + idx)
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


def _extract_utra_psc(value: Any) -> Optional[int]:
    """
    UTRA physCellId may be an int, {"fdd": int}, or {"tdd": int}.
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


def _ci_get(mapping: Dict[str, Any], key: str) -> Any:
    if not isinstance(mapping, dict):
        return None
    if key in mapping:
        return mapping[key]
    wanted = key.lower()
    for k, v in mapping.items():
        if str(k).lower() == wanted:
            return v
    return None


def _event_param_value(event: Dict[str, Any], param_id: str) -> Any:
    wanted = str(param_id or "").strip().lower()
    if not wanted:
        return None

    params = event.get("params")
    if isinstance(params, list):
        for row in params:
            if not isinstance(row, dict):
                continue
            pid = str(row.get("param_id") or row.get("param_name") or row.get("name") or row.get("key") or "").strip().lower()
            if pid == wanted:
                return row.get("param_value", row.get("value", row.get("value_str")))

    for container_key in ("params_map", "properties"):
        container = event.get(container_key)
        if isinstance(container, dict):
            for k, v in container.items():
                if str(k).strip().lower() == wanted:
                    return v
    return None


def _extract_json_obj(event: Dict[str, Any], param_id: str) -> Optional[Dict[str, Any]]:
    direct = event.get(param_id)
    if isinstance(direct, dict):
        return direct

    raw = _event_param_value(event, param_id)
    if isinstance(raw, dict):
        return raw
    if raw is None:
        return None
    txt = str(raw).strip()
    if not txt:
        return None
    try:
        obj = json.loads(txt)
        return obj if isinstance(obj, dict) else None
    except Exception:
        return None


def _extract_decoded_root(event: Dict[str, Any], for_measurement_report: bool) -> Optional[Dict[str, Any]]:
    # Most direct forms first.
    for key in ("decoded", "decoded_json", "decoded_inferred"):
        root = event.get(key)
        if isinstance(root, dict):
            return root

    # Importer annotations fallback.
    param_key = "measurement_report_full_json" if for_measurement_report else "rrc_recfg_full_json"
    return _extract_json_obj(event, param_key)


def _is_measurement_report_event(event_name: str) -> bool:
    return "dcchul.measurementreport" in event_name.lower()


def _is_recfg_event(event_name: str) -> bool:
    return "dcchdl.rrcconnectionreconfiguration" in event_name.lower()


def _extract_serving_hint(event: Dict[str, Any]) -> Dict[str, Optional[int]]:
    # Prefer explicit serving records if available.
    candidates = {
        "pci": [
            "serving_pci",
            "servingcell_pci",
            "radio.lte.servingcell[8].pci",
            "radio.lte.servingcelltotal.pci",
            "rrc_recfg_tgt_pci",
            "rrc_recfg_src_pci",
        ],
        "earfcn": [
            "serving_earfcn",
            "servingcell_earfcn",
            "radio.lte.servingcell[8].downlink.earfcn",
            "radio.lte.servingcelltotal.downlink.earfcn",
            "rrc_recfg_tgt_earfcn",
            "rrc_recfg_src_earfcn",
        ],
    }
    out: Dict[str, Optional[int]] = {"pci": None, "earfcn": None}
    for field, keys in candidates.items():
        for key in keys:
            v = _event_param_value(event, key)
            n = _safe_int(v)
            if n is not None:
                out[field] = n
                break

    # Event object direct properties fallback.
    if out["pci"] is None:
        out["pci"] = _safe_int(event.get("pci"))
    if out["earfcn"] is None:
        out["earfcn"] = _safe_int(event.get("earfcn"))
    return out


def _dict_path(root: Dict[str, Any], path: List[str]) -> Any:
    cur: Any = root
    for key in path:
        if not isinstance(cur, dict):
            return None
        cur = _ci_get(cur, key)
    return cur


def _find_first_key(node: Any, key: str) -> Any:
    if isinstance(node, dict):
        if key in node:
            return node.get(key)
        for v in node.values():
            out = _find_first_key(v, key)
            if out is not None:
                return out
    elif isinstance(node, list):
        for v in node:
            out = _find_first_key(v, key)
            if out is not None:
                return out
    return None


@dataclass
class MeasObject:
    meas_object_id: int
    rat: str
    earfcn: Optional[int] = None
    uarfcn: Optional[int] = None
    arfcn: Optional[int] = None
    cells_lte: List[int] = field(default_factory=list)
    cells_utra_psc: List[int] = field(default_factory=list)
    cells_geran_bsic: List[str] = field(default_factory=list)
    raw: Optional[Dict[str, Any]] = None


@dataclass
class ConfigSnapshot:
    time_ms: int
    meas_id_map: Dict[int, Dict[str, Optional[int]]]
    meas_objects: Dict[int, MeasObject]
    report_configs: Dict[int, Dict[str, Any]]


@dataclass
class MeasurementReport:
    time_ms: int
    time_iso: str
    meas_id: Optional[int]
    pcell_rsrp_idx: Optional[int]
    pcell_rsrq_idx: Optional[int]
    neighbors: List[Dict[str, Any]]


class ServingNeighborsIndex:
    """
    Build incremental LTE serving+neighbors caches from decoded LTE RRC events.
    """

    def __init__(self, events: List[Dict[str, Any]]):
        self._warnings: List[str] = []
        self._config_snapshots: List[ConfigSnapshot] = []
        self._config_times: List[int] = []
        self._measurement_reports: List[MeasurementReport] = []
        self._mr_times: List[int] = []
        self._serving_samples: List[Dict[str, Any]] = []
        self._serving_times: List[int] = []
        self._build(events or [])

    @property
    def warnings(self) -> List[str]:
        return list(self._warnings)

    def _warn(self, message: str) -> None:
        self._warnings.append(str(message))

    def _build(self, events: List[Dict[str, Any]]) -> None:
        rows: List[Tuple[int, Dict[str, Any]]] = []
        for ev in events:
            if not isinstance(ev, dict):
                continue
            t_ms = _parse_iso_ms(ev.get("time") or ev.get("timestamp") or ev.get("ts"))
            if t_ms is None:
                self._warn("Event skipped: invalid timestamp")
                continue
            rows.append((t_ms, ev))
        rows.sort(key=lambda x: x[0])

        meas_id_map: Dict[int, Dict[str, Optional[int]]] = {}
        meas_objects: Dict[int, MeasObject] = {}
        report_configs: Dict[int, Dict[str, Any]] = {}

        for t_ms, ev in rows:
            ev_name = str(ev.get("event_name") or ev.get("event") or ev.get("message") or "")

            # Serving hints from explicit records or reconfiguration annotations.
            hint = _extract_serving_hint(ev)
            if hint.get("pci") is not None or hint.get("earfcn") is not None:
                row = {
                    "time_ms": t_ms,
                    "time": _to_iso(t_ms),
                    "rat": "LTE",
                    "pci": hint.get("pci"),
                    "earfcn": hint.get("earfcn"),
                    "source": "SERVING_HINT",
                }
                self._serving_samples.append(row)
                self._serving_times.append(t_ms)

            if _is_recfg_event(ev_name):
                decoded = _extract_decoded_root(ev, for_measurement_report=False)
                meas_cfg = self._extract_meas_config(decoded)
                if meas_cfg is None:
                    meas_cfg = _extract_json_obj(ev, "rrc_recfg_meas_config_json")
                if isinstance(meas_cfg, dict):
                    try:
                        self._apply_meas_config(meas_cfg, meas_id_map, meas_objects, report_configs)
                    except Exception as exc:
                        self._warn(f"measConfig parse failure at {_to_iso(t_ms)}: {exc}")
                snap = ConfigSnapshot(
                    time_ms=t_ms,
                    meas_id_map=copy.deepcopy(meas_id_map),
                    meas_objects=copy.deepcopy(meas_objects),
                    report_configs=copy.deepcopy(report_configs),
                )
                self._config_snapshots.append(snap)
                self._config_times.append(t_ms)

            if _is_measurement_report_event(ev_name):
                decoded = _extract_decoded_root(ev, for_measurement_report=True)
                mr = self._parse_measurement_report(decoded, t_ms)
                if mr is not None:
                    self._measurement_reports.append(mr)
                    self._mr_times.append(mr.time_ms)

        # Ensure at least one empty config snapshot for query stability.
        if not self._config_snapshots:
            snap = ConfigSnapshot(
                time_ms=-1,
                meas_id_map={},
                meas_objects={},
                report_configs={},
            )
            self._config_snapshots.append(snap)
            self._config_times.append(-1)

    def _extract_meas_config(self, decoded_root: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
        if not isinstance(decoded_root, dict):
            return None
        return _dict_path(
            decoded_root,
            [
                "message",
                "c1",
                "rrcConnectionReconfiguration",
                "criticalExtensions",
                "c1",
                "rrcConnectionReconfiguration-r8",
                "measConfig",
            ],
        )

    def _extract_event_type(self, report_cfg: Dict[str, Any]) -> Optional[str]:
        txt = json.dumps(report_cfg, ensure_ascii=True)
        for token in ("eventA1", "eventA2", "eventA3", "eventA4", "eventA5"):
            if token in txt:
                return token
        return None

    def _extract_lte_cells(self, eutra_obj: Dict[str, Any]) -> List[int]:
        rows = _ci_get(eutra_obj, "cellsToAddModList")
        out: List[int] = []
        if isinstance(rows, list):
            for row in rows:
                if not isinstance(row, dict):
                    continue
                pci = _safe_int(_ci_get(row, "physCellId"))
                if pci is None:
                    continue
                if 0 <= pci <= 503:
                    out.append(pci)
        return sorted(set(out))

    def _extract_utra_cells(self, utra_obj: Dict[str, Any]) -> List[int]:
        rows = _ci_get(utra_obj, "cellsToAddModList")
        out: List[int] = []
        if isinstance(rows, list):
            for row in rows:
                if not isinstance(row, dict):
                    continue
                psc = _extract_utra_psc(_ci_get(row, "physCellId"))
                if psc is None:
                    continue
                if 0 <= psc <= 511:
                    out.append(psc)
        return sorted(set(out))

    def _extract_geran_cells(self, geran_obj: Dict[str, Any]) -> List[str]:
        rows = _ci_get(geran_obj, "cellsToAddModList")
        out: List[str] = []
        if isinstance(rows, list):
            for row in rows:
                if not isinstance(row, dict):
                    continue
                bsic = _ci_get(row, "bsic") or _ci_get(row, "physCellId")
                bsic_txt = _normalize_bsic(bsic)
                if bsic_txt is None:
                    continue
                out.append(bsic_txt)
        return sorted(set(out))

    def _apply_meas_config(
        self,
        meas_cfg: Dict[str, Any],
        meas_id_map: Dict[int, Dict[str, Optional[int]]],
        meas_objects: Dict[int, MeasObject],
        report_configs: Dict[int, Dict[str, Any]],
    ) -> None:
        # remove lists
        for v in _ci_get(meas_cfg, "measIdToRemoveList") or []:
            meas_id = _safe_int(v)
            if meas_id is not None:
                meas_id_map.pop(meas_id, None)
        for v in _ci_get(meas_cfg, "measObjectToRemoveList") or []:
            obj_id = _safe_int(v)
            if obj_id is not None:
                meas_objects.pop(obj_id, None)
        for v in _ci_get(meas_cfg, "reportConfigToRemoveList") or []:
            cfg_id = _safe_int(v)
            if cfg_id is not None:
                report_configs.pop(cfg_id, None)

        # add lists
        for row in _ci_get(meas_cfg, "measIdToAddModList") or []:
            if not isinstance(row, dict):
                continue
            meas_id = _safe_int(_ci_get(row, "measId"))
            meas_object_id = _safe_int(_ci_get(row, "measObjectId"))
            report_config_id = _safe_int(_ci_get(row, "reportConfigId"))
            if meas_id is None:
                continue
            meas_id_map[meas_id] = {
                "measObjectId": meas_object_id,
                "reportConfigId": report_config_id,
            }

        for row in _ci_get(meas_cfg, "measObjectToAddModList") or []:
            if not isinstance(row, dict):
                continue
            obj_id = _safe_int(_ci_get(row, "measObjectId"))
            meas_object = _ci_get(row, "measObject")
            if obj_id is None or not isinstance(meas_object, dict):
                continue

            eutra = _ci_get(meas_object, "measObjectEUTRA")
            utra = _ci_get(meas_object, "measObjectUTRA")
            geran = _ci_get(meas_object, "measObjectGERAN")

            if isinstance(eutra, dict):
                obj = MeasObject(
                    meas_object_id=obj_id,
                    rat="LTE",
                    earfcn=_safe_int(_ci_get(eutra, "carrierFreq")),
                    cells_lte=self._extract_lte_cells(eutra),
                    raw=row,
                )
                meas_objects[obj_id] = obj
                continue
            if isinstance(utra, dict):
                obj = MeasObject(
                    meas_object_id=obj_id,
                    rat="UTRA",
                    uarfcn=_safe_int(_ci_get(utra, "carrierFreq")),
                    cells_utra_psc=self._extract_utra_cells(utra),
                    raw=row,
                )
                meas_objects[obj_id] = obj
                continue
            if isinstance(geran, dict):
                obj = MeasObject(
                    meas_object_id=obj_id,
                    rat="GERAN",
                    arfcn=_safe_int(_ci_get(geran, "carrierFreq")),
                    cells_geran_bsic=self._extract_geran_cells(geran),
                    raw=row,
                )
                meas_objects[obj_id] = obj
                continue

            meas_objects[obj_id] = MeasObject(meas_object_id=obj_id, rat="UNKNOWN", raw=row)

        for row in _ci_get(meas_cfg, "reportConfigToAddModList") or []:
            if not isinstance(row, dict):
                continue
            cfg_id = _safe_int(_ci_get(row, "reportConfigId"))
            cfg = _ci_get(row, "reportConfig")
            if cfg_id is None or not isinstance(cfg, dict):
                continue
            report_configs[cfg_id] = {
                "eventType": self._extract_event_type(cfg),
                "raw": row,
            }

    def _parse_measurement_report(self, decoded_root: Optional[Dict[str, Any]], time_ms: int) -> Optional[MeasurementReport]:
        if not isinstance(decoded_root, dict):
            return None
        meas_results = _dict_path(
            decoded_root,
            [
                "message",
                "c1",
                "measurementReport",
                "criticalExtensions",
                "c1",
                "measurementReport-r8",
                "measResults",
            ],
        )
        if not isinstance(meas_results, dict):
            meas_results = _ci_get(decoded_root, "measResults")
        if not isinstance(meas_results, dict):
            meas_results = _find_first_key(decoded_root, "measResults")
        if not isinstance(meas_results, dict):
            return None

        meas_id = _safe_int(_ci_get(meas_results, "measId"))
        pcell = _ci_get(meas_results, "measResultPCell")
        p_rsrp = _safe_int(_ci_get(pcell, "rsrpResult")) if isinstance(pcell, dict) else None
        p_rsrq = _safe_int(_ci_get(pcell, "rsrqResult")) if isinstance(pcell, dict) else None

        neighbors: List[Dict[str, Any]] = []
        neigh_cells = _ci_get(meas_results, "measResultNeighCells")
        neigh_source = neigh_cells if isinstance(neigh_cells, dict) else meas_results

        eutra_list = _ci_get(neigh_source, "measResultListEUTRA") if isinstance(neigh_source, dict) else None
        if not isinstance(eutra_list, list):
            eutra_list = _find_first_key(meas_results, "measResultListEUTRA")
        if isinstance(eutra_list, list):
            for row in eutra_list:
                if not isinstance(row, dict):
                    continue
                pci = _safe_int(_ci_get(row, "physCellId"))
                if pci is None:
                    continue
                meas = _ci_get(row, "measResult")
                rsrp_idx = _safe_int(_ci_get(meas, "rsrpResult")) if isinstance(meas, dict) else None
                rsrq_idx = _safe_int(_ci_get(meas, "rsrqResult")) if isinstance(meas, dict) else None
                neighbors.append(
                    {
                        "rat": "LTE",
                        "pci": pci,
                        "rsrp_idx": rsrp_idx,
                        "rsrq_idx": rsrq_idx,
                        "rsrp_dbm": _rsrp_idx_to_dbm(rsrp_idx),
                        "rsrq_db": _rsrq_idx_to_db(rsrq_idx),
                        "source_block": "measResultNeighCells",
                    }
                )

        # Optional LTE R10 best-neighbor entries.
        serv_freq_rows = _ci_get(meas_results, "measResultServFreqList-r10")
        if isinstance(serv_freq_rows, list):
            for row in serv_freq_rows:
                if not isinstance(row, dict):
                    continue
                best = _ci_get(row, "measResultBestNeighCell-r10")
                if not isinstance(best, dict):
                    continue
                pci = _safe_int(_ci_get(best, "physCellId-r10"))
                rsrp_idx = _safe_int(_ci_get(best, "rsrpResultNCell-r10"))
                rsrq_idx = _safe_int(_ci_get(best, "rsrqResultNCell-r10"))
                if pci is None:
                    continue
                neighbors.append(
                    {
                        "rat": "LTE",
                        "pci": pci,
                        "rsrp_idx": rsrp_idx,
                        "rsrq_idx": rsrq_idx,
                        "rsrp_dbm": _rsrp_idx_to_dbm(rsrp_idx),
                        "rsrq_db": _rsrq_idx_to_db(rsrq_idx),
                        "source_block": "measResultServFreqList-r10",
                    }
                )

        utra_list = _ci_get(neigh_source, "measResultListUTRA") if isinstance(neigh_source, dict) else None
        if not isinstance(utra_list, list):
            utra_list = _find_first_key(meas_results, "measResultListUTRA")
        if isinstance(utra_list, list):
            for row in utra_list:
                if not isinstance(row, dict):
                    continue
                psc = _extract_utra_psc(_ci_get(row, "physCellId"))
                uarfcn = _safe_int(_ci_get(row, "carrierFreq"))
                if psc is None and uarfcn is None:
                    continue
                meas = _ci_get(row, "measResult")
                rscp_idx = _safe_int(_ci_get(meas, "rscp")) if isinstance(meas, dict) else None
                ecno_idx = _safe_int(_ci_get(meas, "ecNo")) if isinstance(meas, dict) else None
                neighbors.append(
                    {
                        "rat": "UTRA",
                        "psc": psc,
                        "uarfcn": uarfcn,
                        "rscp_idx": rscp_idx,
                        "ecno_idx": ecno_idx,
                        "rscp_dbm": _utra_rscp_idx_to_dbm(rscp_idx),
                        "ecno_db": _utra_ecno_idx_to_db(ecno_idx),
                        "source_block": "measResultNeighCells",
                    }
                )

        geran_list = _ci_get(neigh_source, "measResultListGERAN") if isinstance(neigh_source, dict) else None
        if not isinstance(geran_list, list):
            geran_list = _find_first_key(meas_results, "measResultListGERAN")
        if isinstance(geran_list, list):
            for row in geran_list:
                if not isinstance(row, dict):
                    continue
                arfcn = _safe_int(_ci_get(row, "carrierFreq"))
                bsic = _normalize_bsic(_ci_get(row, "physCellId") or _ci_get(row, "bsic"))
                meas = _ci_get(row, "measResult")
                rxlev = None
                rxqual = None
                if isinstance(meas, dict):
                    rxlev = _safe_int(_ci_get(meas, "rxLev"))
                    if rxlev is None:
                        rxlev = _safe_int(_ci_get(meas, "rxlev"))
                    rxqual = _safe_int(_ci_get(meas, "rxQual"))
                    if rxqual is None:
                        rxqual = _safe_int(_ci_get(meas, "rxqual"))
                if arfcn is None and bsic in (None, ""):
                    continue
                neighbors.append(
                    {
                        "rat": "GERAN",
                        "arfcn": arfcn,
                        "bsic": bsic,
                        "rxlev": rxlev,
                        "rxqual": rxqual,
                        "rxlev_dbm": _geran_rxlev_to_dbm(rxlev),
                        "source_block": "measResultNeighCells",
                    }
                )

        return MeasurementReport(
            time_ms=time_ms,
            time_iso=_to_iso(time_ms) or "",
            meas_id=meas_id,
            pcell_rsrp_idx=p_rsrp,
            pcell_rsrq_idx=p_rsrq,
            neighbors=neighbors,
        )

    def _config_at(self, time_ms: int) -> ConfigSnapshot:
        idx = bisect.bisect_right(self._config_times, time_ms) - 1
        if idx < 0:
            return self._config_snapshots[0]
        return self._config_snapshots[idx]

    def _latest_serving_sample_at(self, time_ms: int) -> Optional[Dict[str, Any]]:
        if not self._serving_times:
            return None
        idx = bisect.bisect_right(self._serving_times, time_ms) - 1
        if idx < 0:
            return None
        return self._serving_samples[idx]

    def _exact_reports_at(self, time_ms: int) -> List[MeasurementReport]:
        if not self._mr_times:
            return []
        i = bisect.bisect_left(self._mr_times, time_ms)
        out: List[MeasurementReport] = []
        while i < len(self._mr_times) and self._mr_times[i] == time_ms:
            out.append(self._measurement_reports[i])
            i += 1
        return out

    def _nearest_report_with_neighbors(self, time_ms: int, window_ms: int) -> Optional[Tuple[MeasurementReport, int]]:
        if not self._mr_times:
            return None
        i = bisect.bisect_left(self._mr_times, time_ms)
        candidates: List[Tuple[int, MeasurementReport]] = []
        for j in (i - 1, i):
            if 0 <= j < len(self._measurement_reports):
                report = self._measurement_reports[j]
                if not report.neighbors:
                    continue
                delta = abs(report.time_ms - time_ms)
                if delta <= window_ms:
                    candidates.append((delta, report))

        # Expand if immediate neighbors do not contain useful MR.
        if not candidates:
            lo = i - 2
            hi = i + 1
            while lo >= 0 or hi < len(self._measurement_reports):
                advanced = False
                if lo >= 0:
                    r = self._measurement_reports[lo]
                    d = abs(r.time_ms - time_ms)
                    if d <= window_ms and r.neighbors:
                        candidates.append((d, r))
                    lo -= 1
                    advanced = True
                if hi < len(self._measurement_reports):
                    r = self._measurement_reports[hi]
                    d = abs(r.time_ms - time_ms)
                    if d <= window_ms and r.neighbors:
                        candidates.append((d, r))
                    hi += 1
                    advanced = True
                if not advanced:
                    break
                if candidates:
                    break

        if not candidates:
            return None
        candidates.sort(key=lambda x: x[0])
        delta, report = candidates[0]
        return report, delta

    def _neighbor_type(self, meas_obj: Optional[MeasObject], serving_earfcn_at_t: Optional[int]) -> str:
        if meas_obj is None:
            return "unknown"
        if meas_obj.rat != "LTE":
            return "inter-RAT"
        if meas_obj.earfcn is None or serving_earfcn_at_t is None:
            return "unknown"
        return "intra-frequency" if meas_obj.earfcn == serving_earfcn_at_t else "inter-frequency"

    def _key_for_neighbor(self, item: Dict[str, Any]) -> str:
        rat = str(item.get("rat") or "").upper()
        if rat == "LTE":
            return f"LTE:{item.get('earfcn')}:{item.get('pci')}"
        if rat == "UTRA":
            return f"UTRA:{item.get('uarfcn')}:{item.get('psc')}"
        if rat == "GERAN":
            return f"GERAN:{item.get('arfcn')}:{_normalize_bsic(item.get('bsic'))}"
        return f"{rat}:{item.get('earfcn')}:{item.get('pci')}"

    def _build_measured_neighbors(
        self,
        report: MeasurementReport,
        source: str,
        delta_ms: int,
        serving_earfcn_at_t: Optional[int],
    ) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
        config = self._config_at(report.time_ms)
        meas_id = report.meas_id
        meas_obj_id = None
        report_cfg_id = None
        meas_obj: Optional[MeasObject] = None
        report_cfg: Optional[Dict[str, Any]] = None
        if meas_id is not None:
            mapping = config.meas_id_map.get(meas_id)
            if isinstance(mapping, dict):
                meas_obj_id = mapping.get("measObjectId")
                report_cfg_id = mapping.get("reportConfigId")
                if meas_obj_id is not None:
                    meas_obj = config.meas_objects.get(int(meas_obj_id))
                if report_cfg_id is not None:
                    report_cfg = config.report_configs.get(int(report_cfg_id))

        out: List[Dict[str, Any]] = []
        for raw in report.neighbors:
            rat = str(raw.get("rat") or (meas_obj.rat if meas_obj else "LTE")).upper()
            earfcn = _safe_int(raw.get("earfcn"))
            if earfcn is None and meas_obj and rat == "LTE":
                earfcn = meas_obj.earfcn
            pci = _safe_int(raw.get("pci"))
            psc = _safe_int(raw.get("psc"))
            bsic = _normalize_bsic(raw.get("bsic"))
            uarfcn = _safe_int(raw.get("uarfcn"))
            arfcn = _safe_int(raw.get("arfcn"))
            if rat == "UTRA" and uarfcn is None and meas_obj and meas_obj.rat == "UTRA":
                uarfcn = meas_obj.uarfcn
            if rat == "GERAN" and arfcn is None and meas_obj and meas_obj.rat == "GERAN":
                arfcn = meas_obj.arfcn
            if rat == "LTE" and pci is None:
                continue
            if rat == "UTRA" and psc is None and uarfcn is None:
                continue
            if rat == "GERAN" and bsic in (None, "") and arfcn is None:
                continue
            item = {
                "rat": rat,
                "earfcn": earfcn,
                "pci": pci,
                "psc": psc,
                "bsic": bsic,
                "uarfcn": uarfcn,
                "arfcn": arfcn,
                "type": self._neighbor_type(meas_obj, serving_earfcn_at_t) if rat == "LTE" else "inter-RAT",
                "rsrp_dbm": raw.get("rsrp_dbm"),
                "rsrq_db": raw.get("rsrq_db"),
                "rsrp_idx": raw.get("rsrp_idx"),
                "rsrq_idx": raw.get("rsrq_idx"),
                "rscp_dbm": raw.get("rscp_dbm"),
                "ecno_db": raw.get("ecno_db"),
                "rscp_idx": raw.get("rscp_idx"),
                "ecno_idx": raw.get("ecno_idx"),
                "rxlev": raw.get("rxlev"),
                "rxqual": raw.get("rxqual"),
                "rxlev_dbm": raw.get("rxlev_dbm"),
                "source": source,
                "measured_time": report.time_iso,
                "delta_ms": int(delta_ms),
                "lastSeenTime": report.time_iso,
            }
            out.append(item)

        dbg = {
            "measIdUsed": meas_id,
            "measObjectIdUsed": meas_obj_id,
            "reportConfigIdUsed": report_cfg_id,
            "reportEventType": report_cfg.get("eventType") if isinstance(report_cfg, dict) else None,
        }
        return out, dbg

    def _build_configured_neighbors(self, time_ms: int, serving_earfcn_at_t: Optional[int]) -> List[Dict[str, Any]]:
        cfg = self._config_at(time_ms)
        out: List[Dict[str, Any]] = []
        for _, obj in cfg.meas_objects.items():
            rat = (obj.rat or "UNKNOWN").upper()
            if rat == "LTE":
                for pci in obj.cells_lte:
                    out.append(
                        {
                            "rat": "LTE",
                            "earfcn": obj.earfcn,
                            "pci": pci,
                            "type": self._neighbor_type(obj, serving_earfcn_at_t),
                            "source": "CONFIG",
                            "rsrp_dbm": None,
                            "rsrq_db": None,
                            "rsrp_idx": None,
                            "rsrq_idx": None,
                            "rscp_dbm": None,
                            "ecno_db": None,
                            "rscp_idx": None,
                            "ecno_idx": None,
                            "rxlev": None,
                            "rxqual": None,
                            "rxlev_dbm": None,
                            "lastSeenTime": _to_iso(time_ms),
                        }
                    )
            elif rat == "UTRA":
                for psc in obj.cells_utra_psc:
                    out.append(
                        {
                            "rat": "UTRA",
                            "uarfcn": obj.uarfcn,
                            "psc": psc,
                            "type": "inter-RAT",
                            "source": "CONFIG",
                            "rsrp_dbm": None,
                            "rsrq_db": None,
                            "rsrp_idx": None,
                            "rsrq_idx": None,
                            "rscp_dbm": None,
                            "ecno_db": None,
                            "rscp_idx": None,
                            "ecno_idx": None,
                            "rxlev": None,
                            "rxqual": None,
                            "rxlev_dbm": None,
                            "lastSeenTime": _to_iso(time_ms),
                        }
                    )
            elif rat == "GERAN":
                for bsic in obj.cells_geran_bsic:
                    out.append(
                        {
                            "rat": "GERAN",
                            "arfcn": obj.arfcn,
                            "bsic": bsic,
                            "type": "inter-RAT",
                            "source": "CONFIG",
                            "rsrp_dbm": None,
                            "rsrq_db": None,
                            "rsrp_idx": None,
                            "rsrq_idx": None,
                            "rscp_dbm": None,
                            "ecno_db": None,
                            "rscp_idx": None,
                            "ecno_idx": None,
                            "rxlev": None,
                            "rxqual": None,
                            "rxlev_dbm": None,
                            "lastSeenTime": _to_iso(time_ms),
                        }
                    )
        return out

    def _build_serving(
        self,
        time_ms: int,
        window_ms: int,
        exact_reports: List[MeasurementReport],
    ) -> Dict[str, Any]:
        serving: Dict[str, Any] = {
            "rat": "LTE",
            "earfcn": None,
            "pci": None,
            "rsrp_dbm": None,
            "rsrq_db": None,
            "rsrp_idx": None,
            "rsrq_idx": None,
            "source": None,
            "time": _to_iso(time_ms),
        }

        sample = self._latest_serving_sample_at(time_ms)
        if sample:
            serving["earfcn"] = sample.get("earfcn")
            serving["pci"] = sample.get("pci")
            serving["source"] = sample.get("source")
            serving["time"] = sample.get("time")

        # If no exact MR, still allow nearest MR for serving quality only.
        mr_for_serving: Optional[MeasurementReport] = exact_reports[0] if exact_reports else None
        if mr_for_serving is None:
            nearest = self._nearest_report_with_neighbors(time_ms, window_ms)
            if nearest:
                mr_for_serving = nearest[0]

        if mr_for_serving is not None:
            serving["rsrp_idx"] = mr_for_serving.pcell_rsrp_idx
            serving["rsrq_idx"] = mr_for_serving.pcell_rsrq_idx
            serving["rsrp_dbm"] = _rsrp_idx_to_dbm(mr_for_serving.pcell_rsrp_idx)
            serving["rsrq_db"] = _rsrq_idx_to_db(mr_for_serving.pcell_rsrq_idx)
            cfg_at_mr = self._config_at(mr_for_serving.time_ms)
            if mr_for_serving.meas_id is not None:
                m = cfg_at_mr.meas_id_map.get(mr_for_serving.meas_id) or {}
                obj_id = m.get("measObjectId")
                if obj_id is not None:
                    obj = cfg_at_mr.meas_objects.get(int(obj_id))
                    if obj and obj.rat == "LTE" and serving.get("earfcn") is None:
                        serving["earfcn"] = obj.earfcn
            if serving.get("source") is None:
                serving["source"] = "MR_PCell"
                serving["time"] = mr_for_serving.time_iso

        return serving

    def getServingNeighborsAt(self, timeISO: str, windowMs: int = 2000) -> Dict[str, Any]:
        t_ms = _parse_iso_ms(timeISO)
        if t_ms is None:
            return {
                "time": timeISO,
                "serving": {
                    "rat": "LTE",
                    "earfcn": None,
                    "pci": None,
                    "rsrp_dbm": None,
                    "rsrq_db": None,
                    "rsrp_idx": None,
                    "rsrq_idx": None,
                    "source": None,
                    "time": None,
                },
                "neighbors_measured": [],
                "neighbors_measured_nearest": [],
                "neighbors_configured": [],
                "neighbors_merged": [],
                "debug": {
                    "warning": "Invalid timeISO",
                    "warnings": self.warnings,
                },
            }

        exact_reports = self._exact_reports_at(t_ms)
        serving = self._build_serving(t_ms, windowMs, exact_reports)
        serving_earfcn = _safe_int(serving.get("earfcn"))

        measured_exact: List[Dict[str, Any]] = []
        debug_exact = {"measIdUsed": None, "measObjectIdUsed": None, "reportConfigIdUsed": None}
        if exact_reports:
            # Use first exact report with neighbors.
            picked = None
            for report in exact_reports:
                if report.neighbors:
                    picked = report
                    break
            if picked is None:
                picked = exact_reports[0]
            measured_exact, debug_exact = self._build_measured_neighbors(
                picked,
                source="MR",
                delta_ms=0,
                serving_earfcn_at_t=serving_earfcn,
            )

        measured_nearest: List[Dict[str, Any]] = []
        debug_nearest = {"measIdUsed": None, "measObjectIdUsed": None, "reportConfigIdUsed": None}
        nearest = self._nearest_report_with_neighbors(t_ms, int(windowMs))
        if nearest is not None:
            report, delta = nearest
            # If exact measured exists from the same report/time, keep nearest list empty to avoid duplicates.
            if not (measured_exact and report.time_ms == t_ms):
                measured_nearest, debug_nearest = self._build_measured_neighbors(
                    report,
                    source="MR_NEAREST",
                    delta_ms=delta,
                    serving_earfcn_at_t=serving_earfcn,
                )

        configured = self._build_configured_neighbors(t_ms, serving_earfcn)

        # Merge by key, preferring measured (exact first, then nearest) over configured.
        merged: Dict[str, Dict[str, Any]] = {}
        for row in configured:
            merged[self._key_for_neighbor(row)] = dict(row)
        for row in measured_nearest:
            merged[self._key_for_neighbor(row)] = dict(row)
        for row in measured_exact:
            merged[self._key_for_neighbor(row)] = dict(row)

        return {
            "time": _to_iso(t_ms) or timeISO,
            "serving": serving,
            "neighbors_measured": measured_exact,
            "neighbors_measured_nearest": measured_nearest,
            "neighbors_configured": configured,
            "neighbors_merged": list(merged.values()),
            "debug": {
                "measIdUsed": debug_exact.get("measIdUsed") if debug_exact.get("measIdUsed") is not None else debug_nearest.get("measIdUsed"),
                "measObjectIdUsed": debug_exact.get("measObjectIdUsed") if debug_exact.get("measObjectIdUsed") is not None else debug_nearest.get("measObjectIdUsed"),
                "reportConfigIdUsed": debug_exact.get("reportConfigIdUsed") if debug_exact.get("reportConfigIdUsed") is not None else debug_nearest.get("reportConfigIdUsed"),
                "exactReportCount": len(exact_reports),
                "warnings": self.warnings,
            },
        }


def build_serving_neighbors_index(events: List[Dict[str, Any]]) -> ServingNeighborsIndex:
    return ServingNeighborsIndex(events)

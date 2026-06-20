"""
Nemo LTE / NR (5G EN-DC) export importer.

Parses Nemo Outdoor tab-separated export files and registers the result as a
virtual TRP run so all existing TRP APIs work unchanged:
  - fetch_run_sidebar       → LTE + NR KPIs on sidebar
  - fetch_neighbors_at_time → LTE + NR neighbor cells in point details
  - analyze_pilot_pollution_at_point → pilot pollution analysis
  - injectRunIntoLoadedLogs (JS) → frontend log creation

Supported file sets
───────────────────
LTE-only:
  RSRP selected set.txt          RS-RSRP per cell (serving + neighbors)
  RSRQ selected set.txt          RS-RSRQ per cell
  RS-SINR selected set.txt       RS-SINR per cell
  Serving cell info LTE.txt      LTE anchor config + GPS
  RRC+L3 LTE.txt                 Decoded Layer-3 (MR, Reconfig, ReestReq)

LTE+NR (EN-DC / NSA 5G):
  LTE_RS RSRP selected set.txt   Same as RSRP selected set
  LTE_RS RSRQ selected set.txt   Same as RSRQ selected set
  LTE_RS SINR selected set.txt   Same as RS-SINR selected set
  SS RSRP.txt                    NR SS-RSRP per beam
  SS RSRQ.txt                    NR SS-RSRQ per beam + GPS
  SS SINR.txt                    NR SS-SINR per beam + GPS
  Serving cell Information NR-LTE.txt  LTE anchor + NR SCG config + GPS
  RRC L3 NR LTE.txt              Decoded LTE + NR Layer-3

Public API:
  parse_nemo_lte_files(file_paths: list[str]) -> dict
  register_nemo_lte_run(parsed: dict) -> int  (returns run_id)
"""

from __future__ import annotations

import os
import re
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

# ---------------------------------------------------------------------------
# Constants — metric names must match SIDEBAR_GROUPS / pilot-pollution
# ---------------------------------------------------------------------------

# LTE serving cell
_SRV_RSRP   = "Radio.Lte.ServingCell[8].Rsrp"
_SRV_RSRQ   = "Radio.Lte.ServingCell[8].Rsrq"
_SRV_SINR   = "Radio.Lte.ServingCell[8].RsSinr"
_SRV_PCI    = "Radio.Lte.ServingCell[8].Pci"
_SRV_EARFCN = "Radio.Lte.ServingCell[8].Downlink.Earfcn"
_SRV_BAND   = "Radio.Lte.ServingCell[8].Band"

# LTE neighbor cells
_NBR_PCI    = "Radio.Lte.Neighbor[64].Pci"
_NBR_RSRP   = "Radio.Lte.Neighbor[64].Rsrp"
_NBR_RSRQ   = "Radio.Lte.Neighbor[64].Rsrq"
_NBR_EARFCN = "Radio.Lte.Neighbor[64].Earfcn"

# NR serving cell (matches SIDEBAR_GROUPS Radio.Nr.ServingCell[16].*)
_NR_SRV_SSRSRP = "Radio.Nr.ServingCell[16].SsRsrp"
_NR_SRV_SSRSRQ = "Radio.Nr.ServingCell[16].SsRsrq"
_NR_SRV_SSSINR = "Radio.Nr.ServingCell[16].SsSinr"
_NR_SRV_PCI    = "Radio.Nr.ServingCell[16].Pci"
_NR_SRV_ARFCN  = "Radio.Nr.ServingCell[16].Downlink.NrArfcn"
_NR_SRV_BAND   = "Radio.Nr.ServingCell[16].Band"

# NR neighbor cells
_NR_NBR_PCI   = "Radio.Nr.Neighbor[32].Pci"
_NR_NBR_RSRP  = "Radio.Nr.Neighbor[32].SsRsrp"
_NR_NBR_RSRQ  = "Radio.Nr.Neighbor[32].SsRsrq"
_NR_NBR_ARFCN = "Radio.Nr.Neighbor[32].NrArfcn"

# LTE serving cell-type identifiers (case-insensitive)
_SERVING_TYPES = {"serving", "lte serving"}
# NR serving cell-type identifiers (Cell type column in SS files)
_NR_SERVING_CELL_TYPES = {"scg pscell", "mcg pcell", "nr serving", "pscell"}

# ---------------------------------------------------------------------------
# Timestamp parsing
# ---------------------------------------------------------------------------

_TS_RE = re.compile(
    r"^(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d+))?$"
)


def _parse_ts_ms(s: str) -> Optional[int]:
    """Parse 'YYYY-M-D H:MM:SS.mmm' → epoch milliseconds (UTC assumed)."""
    m = _TS_RE.match(str(s or "").strip())
    if not m:
        return None
    yr, mo, dy, hr, mn, sc = (int(m.group(i)) for i in range(1, 7))
    frac = m.group(7) or "0"
    ms = int((frac + "000")[:3])
    try:
        dt = datetime(yr, mo, dy, hr, mn, sc, ms * 1000, tzinfo=timezone.utc)
        return int(dt.timestamp() * 1000)
    except ValueError:
        return None


def _ts_to_iso(t_ms: int) -> str:
    dt = datetime.fromtimestamp(t_ms / 1000.0, tz=timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


# ---------------------------------------------------------------------------
# TSV parsing helpers
# ---------------------------------------------------------------------------

def _norm_col(name: str) -> str:
    return re.sub(r"[^a-z0-9]", "", str(name or "").lower())


def _safe_float(v: Any) -> Optional[float]:
    try:
        f = float(v)
        return f if f == f else None  # reject NaN
    except (TypeError, ValueError):
        return None


def _is_serving(cell_type: str) -> bool:
    ct = str(cell_type or "").strip().lower()
    return any(ct == s or ct.startswith(s) for s in _SERVING_TYPES)


def _is_nr_serving(cell_type: str) -> bool:
    ct = str(cell_type or "").strip().lower()
    return any(ct == s or ct.startswith(s) for s in _NR_SERVING_CELL_TYPES)


def _parse_tsv_file(path: str) -> Tuple[List[str], List[Dict[str, str]]]:
    """Read a TSV file; return (normalized_headers, rows_as_dicts)."""
    rows: List[Dict[str, str]] = []
    headers: List[str] = []
    try:
        with open(path, "r", encoding="utf-8-sig", errors="replace") as fh:
            for i, line in enumerate(fh):
                line = line.rstrip("\r\n")
                if not line.strip():
                    continue
                parts = line.split("\t")
                if i == 0:
                    headers = [_norm_col(p) for p in parts]
                    continue
                row: Dict[str, str] = {}
                for j, col in enumerate(headers):
                    # First occurrence wins — prevents "Cell type #" (→ "celltype") from
                    # overwriting "Cell type" (also → "celltype") with a numeric code.
                    if col not in row:
                        row[col] = parts[j].strip() if j < len(parts) else ""
                rows.append(row)
    except OSError:
        pass
    return headers, rows


# ---------------------------------------------------------------------------
# LTE per-file metric extractors
# ---------------------------------------------------------------------------

def _extract_rsrp(rows: List[Dict[str, str]], groups: Dict[str, Dict]) -> None:
    for row in rows:
        parent = row.get("theparent") or row.get("parent") or ""
        if not parent:
            continue
        g = groups.setdefault(parent, {})
        if not g.get("t_str"):
            g["t_str"] = row.get("time", "")
        cells: List[Dict] = g.setdefault("cells", [])
        pci = _safe_float(row.get("pci"))
        earfcn = _safe_float(row.get("ch") or row.get("earfcn") or row.get("channel"))
        rsrp = _safe_float(row.get("rsrp"))
        cell_type = row.get("celltype") or row.get("type") or ""
        cell = _find_cell(cells, pci, earfcn, cell_type)
        if rsrp is not None:
            cell["rsrp"] = rsrp
        if earfcn is not None and cell.get("earfcn") is None:
            cell["earfcn"] = earfcn


def _extract_rsrq(rows: List[Dict[str, str]], groups: Dict[str, Dict]) -> None:
    for row in rows:
        parent = row.get("theparent") or row.get("parent") or ""
        if not parent:
            continue
        g = groups.setdefault(parent, {})
        if not g.get("t_str"):
            g["t_str"] = row.get("time", "")
        lon_s = row.get("lon") or row.get("longitude") or ""
        lat_s = row.get("lat") or row.get("latitude") or ""
        if lon_s and lat_s and not g.get("lon"):
            lon = _safe_float(lon_s)
            lat = _safe_float(lat_s)
            if lon is not None and lat is not None:
                g["lon"] = lon
                g["lat"] = lat
        cells: List[Dict] = g.setdefault("cells", [])
        pci = _safe_float(row.get("pci"))
        earfcn = _safe_float(row.get("ch") or row.get("earfcn") or row.get("channel"))
        rsrq = _safe_float(row.get("rsrq"))
        cell_type = row.get("celltype") or row.get("type") or ""
        cell = _find_cell(cells, pci, earfcn, cell_type)
        if rsrq is not None:
            cell["rsrq"] = rsrq
        if earfcn is not None and cell.get("earfcn") is None:
            cell["earfcn"] = earfcn


def _extract_sinr(rows: List[Dict[str, str]], groups: Dict[str, Dict]) -> None:
    for row in rows:
        parent = row.get("theparent") or row.get("parent") or ""
        if not parent:
            continue
        g = groups.setdefault(parent, {})
        if not g.get("t_str"):
            g["t_str"] = row.get("time", "")
        cells: List[Dict] = g.setdefault("cells", [])
        pci = _safe_float(row.get("pci"))
        earfcn = _safe_float(row.get("ch") or row.get("earfcn") or row.get("channel"))
        sinr = _safe_float(row.get("sinr") or row.get("rssinr"))
        cell_type = row.get("celltype") or row.get("type") or ""
        cell = _find_cell(cells, pci, earfcn, cell_type)
        if sinr is not None:
            cell["sinr"] = sinr


def _build_t_str_index(groups: Dict[str, Dict]) -> Dict[str, List[str]]:
    """Build timestamp → [group_key, ...] index for O(1) serving-file lookups."""
    idx: Dict[str, List[str]] = {}
    for key, g in groups.items():
        ts = g.get("t_str", "")
        if ts:
            idx.setdefault(ts, []).append(key)
    return idx


def _extract_serving_info(
    rows: List[Dict[str, str]],
    groups: Dict[str, Dict],
    t_str_index: Optional[Dict[str, List[str]]] = None,
) -> None:
    """
    Serving cell info LTE: Time, Event ID, LTE cell type, LTE channel number, LTE PCI,
                           System, Band, Band (MHz), Measurement Title, Lon., Lat.
    """
    for row in rows:
        t_str = row.get("time", "").strip()
        if not t_str:
            continue
        if t_str_index is not None:
            matching = [groups[k] for k in t_str_index.get(t_str, []) if k in groups]
        else:
            matching = [g for g in groups.values() if g.get("t_str") == t_str]
        if not matching:
            new_key = f"__ts__{t_str}"
            g = groups.setdefault(new_key, {"t_str": t_str})
            if not g.get("t_str"):
                g["t_str"] = t_str
            matching = [g]
            if t_str_index is not None:
                t_str_index.setdefault(t_str, []).append(new_key)

        pci = _safe_float(row.get("ltepci") or row.get("pci"))
        earfcn = _safe_float(row.get("ltechannelnumber") or row.get("ch") or row.get("earfcn"))
        band = (row.get("band") or row.get("ltband") or "").strip()
        lon_s = row.get("lon") or row.get("longitude") or ""
        lat_s = row.get("lat") or row.get("latitude") or ""
        cell_type_raw = row.get("ltecelltype") or row.get("celltype") or row.get("type") or ""

        for g in matching:
            if lon_s and lat_s and not g.get("lon"):
                lon = _safe_float(lon_s)
                lat = _safe_float(lat_s)
                if lon is not None and lat is not None:
                    g["lon"] = lon
                    g["lat"] = lat
            cells: List[Dict] = g.setdefault("cells", [])
            cell = _find_cell(cells, pci, earfcn, cell_type_raw)
            if band and not cell.get("band"):
                cell["band"] = band
            if earfcn is not None and cell.get("earfcn") is None:
                cell["earfcn"] = earfcn


def _extract_serving_nr_lte(
    rows: List[Dict[str, str]],
    groups: Dict[str, Dict],
    t_str_index: Optional[Dict[str, List[str]]] = None,
) -> None:
    """
    Serving cell Information NR-LTE: handles both LTE and NR rows.
    Columns: Time, Cell type, LTE channel number, LTE PCI, LTE BW,
             NR channel number, NR PCI, ..., System, Band, Band(MHz),
             Measurement Title, Lon., Lat.
    """
    for row in rows:
        t_str = row.get("time", "").strip()
        if not t_str:
            continue
        if t_str_index is not None:
            matching = [groups[k] for k in t_str_index.get(t_str, []) if k in groups]
        else:
            matching = [g for g in groups.values() if g.get("t_str") == t_str]
        if not matching:
            new_key = f"__ts__{t_str}"
            g = groups.setdefault(new_key, {"t_str": t_str})
            if not g.get("t_str"):
                g["t_str"] = t_str
            matching = [g]
            if t_str_index is not None:
                t_str_index.setdefault(t_str, []).append(new_key)

        cell_type_raw = (row.get("celltype") or "").strip()
        system = (row.get("system") or "").strip().upper()
        band = (row.get("band") or "").strip()
        lon_s = row.get("lon") or row.get("longitude") or ""
        lat_s = row.get("lat") or row.get("latitude") or ""

        for g in matching:
            # GPS from this file too
            if lon_s and lat_s and not g.get("lon"):
                lon = _safe_float(lon_s)
                lat = _safe_float(lat_s)
                if lon is not None and lat is not None:
                    g["lon"] = lon
                    g["lat"] = lat

            if system == "NR" or "NR" in cell_type_raw.upper():
                # NR row — inject into nr_cells as config supplement
                nr_pci   = _safe_float(row.get("nrpci"))
                nr_arfcn = _safe_float(row.get("nrchannelnumber") or row.get("nrarfcn"))
                if nr_pci is None and nr_arfcn is None:
                    continue
                nr_cells: List[Dict] = g.setdefault("nr_cells", [])
                # Find or create NR cell entry
                existing = next(
                    (c for c in nr_cells
                     if c.get("pci") == nr_pci and (nr_arfcn is None or c.get("arfcn") is None or c.get("arfcn") == nr_arfcn)),
                    None
                )
                if existing is None:
                    existing = {"pci": nr_pci, "arfcn": nr_arfcn, "cell_type": cell_type_raw}
                    nr_cells.append(existing)
                if band and not existing.get("band"):
                    existing["band"] = band
                if nr_arfcn is not None and existing.get("arfcn") is None:
                    existing["arfcn"] = nr_arfcn
            else:
                # LTE row
                pci   = _safe_float(row.get("ltepci") or row.get("pci"))
                earfcn = _safe_float(row.get("ltechannelnumber") or row.get("ch") or row.get("earfcn"))
                if pci is None and earfcn is None:
                    continue
                cells: List[Dict] = g.setdefault("cells", [])
                cell = _find_cell(cells, pci, earfcn, cell_type_raw)
                if band and not cell.get("band"):
                    cell["band"] = band
                if earfcn is not None and cell.get("earfcn") is None:
                    cell["earfcn"] = earfcn


def _find_cell(cells: List[Dict], pci: Optional[float], earfcn: Optional[float], cell_type: str) -> Dict:
    """Find or create a LTE cell dict in the group cell list."""
    for c in cells:
        if c.get("pci") == pci and (earfcn is None or c.get("earfcn") is None or c.get("earfcn") == earfcn):
            # Promote cell_type if the existing entry has none (e.g. SINR file has no Cell type column)
            if cell_type and not c.get("cell_type"):
                c["cell_type"] = cell_type
            return c
    cell: Dict[str, Any] = {"pci": pci, "earfcn": earfcn, "cell_type": cell_type}
    cells.append(cell)
    return cell


# ---------------------------------------------------------------------------
# NR SS beam file parser
# ---------------------------------------------------------------------------

def _parse_ss_files(paths: List[str], groups: Dict[str, Dict]) -> None:
    """
    Parse SS RSRP / SS RSRQ / SS SINR files (NR beam-level measurements).
    Aggregates beams to cell level and stores into groups[parent]["nr_cells"].

    SS RSRP: Time, NR-ARFCN, PCI, BI, BT, Band, Band(MHz), ..., Cell type, RSRP, the_parent
    SS RSRQ: Time, RSRQ, NR-ARFCN, PCI, BI, BT, Band, ..., Cell type, ..., Lon., Lat., the_parent
    SS SINR: Time, SINR, NR-ARFCN, PCI, BI, BT, Band, ..., Cell type, ..., Lon., Lat., the_parent
    """
    # beam_data[(parent, arfcn_str, pci_str, bi_str)] = {rsrp, rsrq, sinr, bt, band, cell_type, lat, lon, t_str}
    beam_data: Dict[Tuple, Dict[str, Any]] = {}

    for path in paths:
        if not path or not os.path.isfile(path):
            continue
        headers, rows = _parse_tsv_file(path)
        for row in rows:
            parent = row.get("theparent") or row.get("parent") or ""
            if not parent:
                continue
            arfcn_s = row.get("nrarfcn") or ""
            pci_s   = row.get("pci") or ""
            bi_s    = row.get("bi") or ""
            key     = (parent, arfcn_s, pci_s, bi_s)

            beam = beam_data.setdefault(key, {
                "parent":    parent,
                "t_str":     row.get("time", ""),
                "arfcn":     _safe_float(arfcn_s),
                "pci":       _safe_float(pci_s),
                "bi":        _safe_float(bi_s),
                "bt":        "",
                "band":      "",
                "cell_type": "",
                "rsrp": None, "rsrq": None, "sinr": None,
                "lat": None, "lon": None,
            })

            bt  = (row.get("bt") or "").strip().lower()
            if bt:
                beam["bt"] = bt
            band = (row.get("band") or "").strip()
            if band:
                beam["band"] = band
            ct = (row.get("celltype") or "").strip()
            if ct:
                beam["cell_type"] = ct

            rsrp = _safe_float(row.get("rsrp"))
            rsrq = _safe_float(row.get("rsrq"))
            sinr = _safe_float(row.get("sinr"))
            if rsrp is not None:
                beam["rsrp"] = rsrp
            if rsrq is not None:
                beam["rsrq"] = rsrq
            if sinr is not None:
                beam["sinr"] = sinr

            lon = _safe_float(row.get("lon") or row.get("longitude") or "")
            lat = _safe_float(row.get("lat") or row.get("latitude") or "")
            if lon is not None and beam["lon"] is None:
                beam["lon"] = lon
            if lat is not None and beam["lat"] is None:
                beam["lat"] = lat

    # Aggregate beams → cell level: key = (parent, arfcn_str, pci_str)
    cell_beams: Dict[Tuple, List[Dict]] = {}
    for (parent, arfcn_s, pci_s, _bi_s), beam in beam_data.items():
        cell_beams.setdefault((parent, arfcn_s, pci_s), []).append(beam)

    for (parent, arfcn_s, pci_s), blist in cell_beams.items():
        # Serving beam carries the cell-level signal quality
        serving_b = next((b for b in blist if b["bt"] == "serving beam"), None)
        if serving_b is None:
            # Fall back to best-RSRP beam
            candidates = [b for b in blist if b["rsrp"] is not None]
            serving_b = max(candidates, key=lambda b: b["rsrp"]) if candidates else blist[0]

        # Pull RSRQ / SINR from serving beam; fall back to any beam if not present
        rsrq = serving_b.get("rsrq")
        if rsrq is None:
            rsrq = next((b["rsrq"] for b in blist if b.get("rsrq") is not None), None)
        sinr = serving_b.get("sinr")
        if sinr is None:
            sinr = next((b["sinr"] for b in blist if b.get("sinr") is not None), None)

        # GPS from any beam in group
        lat = next((b["lat"] for b in blist if b["lat"] is not None), None)
        lon = next((b["lon"] for b in blist if b["lon"] is not None), None)

        cell_entry: Dict[str, Any] = {
            "t_str":     blist[0]["t_str"],
            "pci":       _safe_float(pci_s),
            "arfcn":     _safe_float(arfcn_s),
            "band":      blist[0]["band"],
            "cell_type": blist[0]["cell_type"],
            "rsrp":      serving_b.get("rsrp"),
            "rsrq":      rsrq,
            "sinr":      sinr,
            "lat":       lat,
            "lon":       lon,
        }

        g = groups.setdefault(f"ss_{parent}", {"t_str": "", "cells": [], "nr_cells": []})
        if not g.get("t_str") and cell_entry["t_str"]:
            g["t_str"] = cell_entry["t_str"]
        # GPS
        if lat is not None and lon is not None and not g.get("lat"):
            g["lat"] = lat
            g["lon"] = lon
        g.setdefault("nr_cells", []).append(cell_entry)


# ---------------------------------------------------------------------------
# File-type router
# ---------------------------------------------------------------------------

_FILE_DISPATCH = {
    "rsrp":        _extract_rsrp,
    "rsrq":        _extract_rsrq,
    "sinr":        _extract_sinr,
    "rs-sinr":     _extract_sinr,
    "rssinr":      _extract_sinr,
    "serving":     _extract_serving_info,       # "Serving cell info LTE"
    "servingcell": _extract_serving_info,
}


def _dispatch_file(path: str, groups: Dict[str, Dict]) -> None:
    fname = _norm_col(os.path.basename(path))
    if _is_rrc_l3_file(path):
        return
    _, rows = _parse_tsv_file(path)
    extractor = None
    for key, fn in _FILE_DISPATCH.items():
        if key in fname:
            extractor = fn
            break
    if extractor is None:
        return
    extractor(rows, groups)


# ---------------------------------------------------------------------------
# Build kpi_samples + track_points from merged groups
# ---------------------------------------------------------------------------

def _groups_to_samples(
    groups: Dict[str, Dict]
) -> Tuple[List[Dict], List[Dict], Optional[int], Optional[int]]:
    """
    Convert merged groups → (kpi_samples, track_points, min_t_ms, max_t_ms).
    Emits both LTE (g["cells"]) and NR (g["nr_cells"]) samples.
    """
    kpi_samples: List[Dict[str, Any]] = []
    track_points: List[Dict[str, Any]] = []
    min_t: Optional[int] = None
    max_t: Optional[int] = None

    for _parent, g in sorted(groups.items(), key=lambda kv: kv[1].get("t_str", "")):
        t_ms = _parse_ts_ms(g.get("t_str", ""))
        if t_ms is None:
            continue

        if min_t is None or t_ms < min_t:
            min_t = t_ms
        if max_t is None or t_ms > max_t:
            max_t = t_ms

        is_ss_group = str(_parent).startswith("ss_")
        lat = g.get("lat")
        lon = g.get("lon")
        if not is_ss_group and lat is not None and lon is not None:
            track_points.append({
                "time": _ts_to_iso(t_ms),
                "lat": lat,
                "lon": lon,
            })

        t_iso = _ts_to_iso(t_ms)

        # ── LTE cells ─────────────────────────────────────────────────────
        cells: List[Dict] = g.get("cells", [])
        serving_cells  = [c for c in cells if _is_serving(c.get("cell_type", ""))]
        neighbor_cells = [c for c in cells if not _is_serving(c.get("cell_type", ""))]
        neighbor_cells.sort(key=lambda c: -(c.get("rsrp") or -200))

        for srv in serving_cells[:1]:
            def _emit_srv(name: str, val: Optional[float], val_str: Optional[str] = None) -> None:
                if val is not None or val_str is not None:
                    kpi_samples.append({"name": name, "value_num": val, "value_str": val_str,
                                        "t_ms": t_ms, "time": t_iso, "idx": 0})
            _emit_srv(_SRV_RSRP,   srv.get("rsrp"))
            _emit_srv(_SRV_RSRQ,   srv.get("rsrq"))
            _emit_srv(_SRV_SINR,   srv.get("sinr"))
            _emit_srv(_SRV_PCI,    srv.get("pci"))
            _emit_srv(_SRV_EARFCN, srv.get("earfcn"))
            band = srv.get("band")
            if band:
                _emit_srv(_SRV_BAND, None, band)

        for nbr_idx, nbr in enumerate(neighbor_cells, start=1):
            def _emit_nbr(name: str, val: Optional[float], idx: int = nbr_idx) -> None:
                if val is not None:
                    kpi_samples.append({"name": name, "value_num": val, "value_str": None,
                                        "t_ms": t_ms, "time": t_iso, "idx": idx})
            _emit_nbr(_NBR_PCI,    nbr.get("pci"))
            _emit_nbr(_NBR_RSRP,   nbr.get("rsrp"))
            _emit_nbr(_NBR_RSRQ,   nbr.get("rsrq"))
            _emit_nbr(_NBR_EARFCN, nbr.get("earfcn"))

        # ── NR cells ──────────────────────────────────────────────────────
        nr_cells: List[Dict] = g.get("nr_cells", [])
        nr_serving  = [c for c in nr_cells if _is_nr_serving(c.get("cell_type", ""))]
        nr_neighbor = [c for c in nr_cells if not _is_nr_serving(c.get("cell_type", ""))]
        nr_neighbor.sort(key=lambda c: -(c.get("rsrp") or -200))

        for srv_nr in nr_serving[:1]:
            def _emit_nr_srv(name: str, val: Optional[float], val_str: Optional[str] = None) -> None:
                if val is not None or val_str is not None:
                    kpi_samples.append({"name": name, "value_num": val, "value_str": val_str,
                                        "t_ms": t_ms, "time": t_iso, "idx": 0})
            _emit_nr_srv(_NR_SRV_SSRSRP, srv_nr.get("rsrp"))
            _emit_nr_srv(_NR_SRV_SSRSRQ, srv_nr.get("rsrq"))
            _emit_nr_srv(_NR_SRV_SSSINR, srv_nr.get("sinr"))
            _emit_nr_srv(_NR_SRV_PCI,    srv_nr.get("pci"))
            _emit_nr_srv(_NR_SRV_ARFCN,  srv_nr.get("arfcn"))
            nr_band = srv_nr.get("band")
            if nr_band:
                _emit_nr_srv(_NR_SRV_BAND, None, nr_band)

        for nbr_idx_nr, nbr_nr in enumerate(nr_neighbor, start=1):
            def _emit_nr_nbr(name: str, val: Optional[float], idx: int = nbr_idx_nr) -> None:
                if val is not None:
                    kpi_samples.append({"name": name, "value_num": val, "value_str": None,
                                        "t_ms": t_ms, "time": t_iso, "idx": idx})
            _emit_nr_nbr(_NR_NBR_PCI,   nbr_nr.get("pci"))
            _emit_nr_nbr(_NR_NBR_RSRP,  nbr_nr.get("rsrp"))
            _emit_nr_nbr(_NR_NBR_RSRQ,  nbr_nr.get("rsrq"))
            _emit_nr_nbr(_NR_NBR_ARFCN, nbr_nr.get("arfcn"))

    return kpi_samples, track_points, min_t, max_t


# ---------------------------------------------------------------------------
# RRC+L3 message parser  (Nemo decoded Layer-3 export, LTE and NR)
# ---------------------------------------------------------------------------

_RRC_MSG_PREFIXES = frozenset({"rrcsm", "l3sm", "nrrcsm", "pdcp"})

# Handle both "(= -68 dBm)" (LTE style) and "(-68 dBm)" (NR style)
_DBM_RE = re.compile(r'\(=?\s*(-?\d+(?:\.\d+)?)\s*dBm\)', re.IGNORECASE)
_DB_RE  = re.compile(r'\(=?\s*(-?\d+(?:\.\d+)?)\s*dB\)',  re.IGNORECASE)
_INT_RE = re.compile(r':\s*(-?\d+)')


def _field_value(line: str) -> Optional[float]:
    """Extract a numeric value from a decoded-content line."""
    m = _DBM_RE.search(line) or _DB_RE.search(line)
    if m:
        return float(m.group(1))
    m = _INT_RE.search(line)
    if m:
        return float(m.group(1))
    return None


def _indent(line: str) -> int:
    return len(line) - len(line.lstrip(' \t'))


def _parse_measurement_report(content_lines: List[str]) -> Dict[str, Any]:
    """
    Parse a MeasurementReport (LTE or NR).
    Returns {measId, serving: {rsrp_dbm, rsrq_db, sinr_db}, neighbors: [{pci, rsrp_dbm, rsrq_db}]}.
    """
    result: Dict[str, Any] = {"measId": None, "serving": {}, "neighbors": []}

    IDLE         = 0
    IN_PCELL     = 1   # LTE: inside measResultPCell
    IN_NR_PCELL  = 2   # NR:  inside measResultServingCell
    IN_NEIGH     = 3   # inside measResultNeighCells
    IN_CELL      = 4   # inside a measResultListEUTRA/NR value block

    state = IDLE
    pcell_indent: Optional[int] = None
    neigh_indent: Optional[int] = None
    cur_cell: Dict[str, Any] = {}

    for raw in content_lines:
        stripped = raw.strip()
        if not stripped:
            continue
        depth = _indent(raw)
        low = stripped.lower().replace('-', '').replace('_', '').replace(' ', '')

        # ── measId ──────────────────────────────────────────────────────────
        if low.startswith('measid') and ':' in stripped:
            v = _field_value(stripped)
            if v is not None and result["measId"] is None:
                result["measId"] = int(v)
            continue

        # ── LTE serving cell (measResultPCell) ──────────────────────────────
        if 'measresultpcell' in low and ':' not in stripped:
            state = IN_PCELL
            pcell_indent = depth
            continue

        if state == IN_PCELL:
            if pcell_indent is not None and depth <= pcell_indent and stripped:
                state = IDLE
            else:
                if 'rsrpresult' in low:
                    v = _field_value(stripped)
                    if v is not None:
                        result["serving"]["rsrp_dbm"] = v
                elif 'rsrqresult' in low:
                    v = _field_value(stripped)
                    if v is not None:
                        result["serving"]["rsrq_db"] = v
                continue

        # ── NR serving cell (measResultServingCell under measResultServingMOList) ──
        if 'measresultservingcell' in low and ':' not in stripped:
            state = IN_NR_PCELL
            pcell_indent = depth
            continue

        if state == IN_NR_PCELL:
            if pcell_indent is not None and depth <= pcell_indent and stripped:
                state = IDLE
            else:
                # NR fields: rsrp / rsrq / sinr (with parenthetical dBm/dB)
                if low.startswith('rsrp') and 'result' not in low and ':' in stripped:
                    v = _field_value(stripped)
                    if v is not None:
                        result["serving"]["rsrp_dbm"] = v
                elif low.startswith('rsrq') and 'result' not in low and ':' in stripped:
                    v = _field_value(stripped)
                    if v is not None:
                        result["serving"]["rsrq_db"] = v
                elif low.startswith('sinr') and ':' in stripped:
                    v = _field_value(stripped)
                    if v is not None:
                        result["serving"]["sinr_db"] = v
                continue

        # ── Neighbor section ─────────────────────────────────────────────────
        if 'measresultneighcells' in low and ':' not in stripped:
            state = IN_NEIGH
            neigh_indent = depth
            continue

        if state in (IN_NEIGH, IN_CELL):
            if neigh_indent is not None and depth <= neigh_indent and stripped:
                if cur_cell:
                    result["neighbors"].append(cur_cell)
                    cur_cell = {}
                state = IDLE
                continue

            if 'measresultlisteutravalue' in low or 'measresultlistnrvalue' in low or 'measresultlistnr' in low:
                if cur_cell:
                    result["neighbors"].append(cur_cell)
                cur_cell = {}
                state = IN_CELL
                continue

            if state == IN_CELL:
                if 'physcellid' in low and ':' in stripped:
                    v = _field_value(stripped)
                    if v is not None:
                        cur_cell['pci'] = int(v)
                # LTE neighbor: rsrpResult / rsrqResult
                elif 'rsrpresult' in low and ':' in stripped and 'rsrp_dbm' not in cur_cell:
                    v = _field_value(stripped)
                    if v is not None:
                        cur_cell['rsrp_dbm'] = v
                elif 'rsrqresult' in low and ':' in stripped and 'rsrq_db' not in cur_cell:
                    v = _field_value(stripped)
                    if v is not None:
                        cur_cell['rsrq_db'] = v
                # NR neighbor: rsrp / rsrq / sinr (direct fields, no "result" suffix)
                elif low.startswith('rsrp') and 'result' not in low and ':' in stripped and 'rsrp_dbm' not in cur_cell:
                    v = _field_value(stripped)
                    if v is not None:
                        cur_cell['rsrp_dbm'] = v
                elif low.startswith('rsrq') and 'result' not in low and ':' in stripped and 'rsrq_db' not in cur_cell:
                    v = _field_value(stripped)
                    if v is not None:
                        cur_cell['rsrq_db'] = v
                elif low.startswith('sinr') and ':' in stripped and 'sinr_db' not in cur_cell:
                    v = _field_value(stripped)
                    if v is not None:
                        cur_cell['sinr_db'] = v
                elif 'earfcn' in low and ':' in stripped and 'earfcn' not in cur_cell:
                    v = _field_value(stripped)
                    if v is not None:
                        cur_cell['earfcn'] = int(v)

    if cur_cell:
        result["neighbors"].append(cur_cell)

    return result


def _parse_reest_request(content_lines: List[str]) -> Dict[str, Any]:
    result: Dict[str, Any] = {}
    for line in content_lines:
        stripped = line.strip()
        low = stripped.lower().replace('-', '').replace('_', '').replace(' ', '')
        if 'physcellid' in low and ':' in stripped and 'sourcepci' not in result:
            v = _field_value(stripped)
            if v is not None:
                result['sourcePci'] = int(v)
        elif 'reestablishmentcause' in low and ':' in stripped:
            parts = stripped.split(':', 1)
            if len(parts) == 2:
                result['reestablishmentCause'] = parts[1].strip()
    return result


def _parse_ho_target(content_lines: List[str]) -> Optional[int]:
    in_mobility = False
    for line in content_lines:
        stripped = line.strip()
        low = stripped.lower().replace('-', '').replace('_', '').replace(' ', '')
        if 'mobilitycontrolinfo' in low:
            in_mobility = True
        if in_mobility and 'targetphyscellid' in low and ':' in stripped:
            v = _field_value(stripped)
            if v is not None:
                return int(v)
    return None


def _parse_meas_config(content_lines: List[str]) -> Dict[int, str]:
    """
    Extract measId → eventType mapping from RRCConnectionReconfiguration or
    NR RRCReconfiguration content (both use same reportConfig structure).
    """
    cfg_to_event: Dict[int, str] = {}
    cur_cfg_id: Optional[int] = None
    for line in content_lines:
        stripped = line.strip()
        low = stripped.lower().replace('-', '').replace('_', '').replace(' ', '')
        if 'reportconfigid' in low and ':' in stripped:
            v = _field_value(stripped)
            cur_cfg_id = int(v) if v is not None else None
        elif cur_cfg_id is not None:
            if 'eventa3' in low:
                cfg_to_event[cur_cfg_id] = 'A3'
                cur_cfg_id = None
            elif 'eventa5' in low:
                cfg_to_event[cur_cfg_id] = 'A5'
                cur_cfg_id = None
            elif 'eventa2' in low or 'eventa1' in low or 'eventa4' in low:
                cfg_to_event[cur_cfg_id] = 'A2'
                cur_cfg_id = None

    meas_to_event: Dict[int, str] = {}
    cur_meas_id: Optional[int] = None
    for line in content_lines:
        stripped = line.strip()
        low = stripped.lower().replace('-', '').replace('_', '').replace(' ', '')
        if 'measidtoaddmod' in low and 'list' not in low:
            cur_meas_id = None
        if low.startswith('measid') and ':' in stripped and 'toaddmod' not in low:
            v = _field_value(stripped)
            cur_meas_id = int(v) if v is not None else None
        elif 'reportconfigid' in low and ':' in stripped and cur_meas_id is not None:
            v = _field_value(stripped)
            if v is not None:
                cfg_id = int(v)
                ev_type = cfg_to_event.get(cfg_id)
                if ev_type:
                    meas_to_event[cur_meas_id] = ev_type
                cur_meas_id = None

    return meas_to_event


def parse_rrc_l3_file(path: str) -> List[Dict[str, Any]]:
    """
    Parse a Nemo decoded Layer-3 export (LTE 'RRC+L3 LTE.txt' or 5G 'RRC L3 NR LTE.txt').
    Handles both LTE FDD and NR message types.
    """
    events: List[Dict[str, Any]] = []
    try:
        with open(path, "r", encoding="utf-8-sig", errors="replace") as fh:
            full_text = fh.read()
    except OSError:
        return events

    lines = full_text.splitlines()
    n = len(lines)
    i = 0
    measid_event_map: Dict[int, str] = {}
    last_ho_target: Optional[Dict[str, Any]] = None

    while i < n:
        line = lines[i]
        parts = line.split('\t')
        prefix = _norm_col(parts[0]) if parts else ""

        if prefix in _RRC_MSG_PREFIXES and len(parts) >= 5:
            ts_str    = parts[3].strip()
            msg_name  = parts[4].strip()
            rat       = parts[1].strip().upper() if len(parts) > 1 else ""
            direction = parts[2].strip() if len(parts) > 2 else ""

            t_ms = _parse_ts_ms(ts_str)
            if t_ms is None:
                i += 1
                continue

            # Collect content until next header
            i += 1
            content: List[str] = []
            while i < n:
                nxt = lines[i]
                nxt_parts = nxt.split('\t')
                nxt_prefix = _norm_col(nxt_parts[0]) if nxt_parts else ""
                if nxt_prefix in _RRC_MSG_PREFIXES and len(nxt_parts) >= 5:
                    break
                content.append(nxt)
                i += 1

            msg_norm = _norm_col(msg_name)
            t_iso    = _ts_to_iso(t_ms)

            # ── MeasurementReport (LTE or NR) ────────────────────────────────
            if msg_norm in ("measurementreport", "measurementreportr8"):
                mr = _parse_measurement_report(content)
                is_nr = (rat == "NR")

                ev_name = ("Message.Layer3.NrRrc.MeasurementReport" if is_nr
                           else "Message.Layer3.LteRrc.MeasurementReport")
                ev: Dict[str, Any] = {"event_name": ev_name, "time": t_iso, "direction": direction}
                if mr.get("measId") is not None:
                    ev["measurement_report_measid"] = mr["measId"]
                if mr.get("serving"):
                    ev["measurement_report_serving_json"] = mr["serving"]
                if mr.get("neighbors"):
                    ev["measurement_report_neighbors_json"] = mr["neighbors"]
                events.append(ev)

                # Synthetic A3 event
                meas_id = mr.get("measId")
                if meas_id is not None and measid_event_map.get(meas_id) == 'A3':
                    neighbors = mr.get("neighbors") or []
                    best_nb = max(
                        (nb for nb in neighbors if nb.get("rsrp_dbm") is not None),
                        key=lambda nb: nb["rsrp_dbm"],
                        default=None,
                    ) or (neighbors[0] if neighbors else None)
                    srv = mr.get("serving") or {}
                    a3_name = ("Radio.Nr.MeasurementReporting.A3Event" if is_nr
                               else "Radio.Lte.MeasurementReporting.A3Event")
                    a3_ev: Dict[str, Any] = {
                        "event_name": a3_name,
                        "time": t_iso,
                        "direction": direction,
                        "measurement_report_measid": meas_id,
                    }
                    if srv.get("rsrp_dbm") is not None:
                        a3_ev["servingrsrp"] = srv["rsrp_dbm"]
                    if best_nb is not None:
                        a3_ev["neighborpci"]   = best_nb.get("pci")
                        a3_ev["neighbourrsrp"] = best_nb.get("rsrp_dbm")
                    events.append(a3_ev)

            # ── LTE RRCConnectionReconfiguration ─────────────────────────────
            elif msg_norm == "rrcconnectionreconfiguration":
                new_map = _parse_meas_config(content)
                if new_map:
                    measid_event_map.update(new_map)
                ho_target = _parse_ho_target(content)
                if ho_target is not None:
                    last_ho_target = {"pci": ho_target, "t_ms": t_ms}
                events.append({
                    "event_name": "Message.Layer3.LteRrc.RRCConnectionReconfiguration",
                    "time": t_iso, "direction": direction,
                })

            # ── NR RRCReconfiguration ─────────────────────────────────────────
            elif msg_norm in ("rrcreconfigurationmessage", "rrcreconfiguration"):
                new_map = _parse_meas_config(content)
                if new_map:
                    measid_event_map.update(new_map)
                events.append({
                    "event_name": "Message.Layer3.NrRrc.RRCReconfiguration",
                    "time": t_iso, "direction": direction,
                })

            # ── RRCConnectionReestablishmentRequest ───────────────────────────
            elif msg_norm == "rrcconnectionreestablishmentrequest":
                reest = _parse_reest_request(content)
                ev_hof: Dict[str, Any] = {
                    "event_name": "Message.Layer3.Errc.CcchUl.RrcConnectionReestablishmentRequest",
                    "time": t_iso, "direction": direction,
                }
                if reest.get("sourcePci") is not None:
                    ev_hof["sourcePci"] = reest["sourcePci"]
                if reest.get("reestablishmentCause"):
                    ev_hof["reestablishmentCause"] = reest["reestablishmentCause"]
                if last_ho_target is not None and (t_ms - last_ho_target["t_ms"]) <= 30_000:
                    ev_hof["targetPci"] = last_ho_target["pci"]
                events.append(ev_hof)

            # ── Other RRC messages ────────────────────────────────────────────
            elif msg_norm in (
                "rrcconnectionreestablishment",
                "rrcconnectionreestablishmentreject",
                "rrcconnectionrelease",
                "rrcconnectionrequest",
                "rrcconnectionreconfigurationcomplete",
            ):
                canonical = {
                    "rrcconnectionreestablishment": "RRCConnectionReestablishment",
                    "rrcconnectionreestablishmentreject": "RRCConnectionReestablishmentReject",
                    "rrcconnectionrelease": "RRCConnectionRelease",
                    "rrcconnectionrequest": "RRCConnectionRequest",
                    "rrcconnectionreconfigurationcomplete": "RRCConnectionReconfigurationComplete",
                }.get(msg_norm, msg_name)
                events.append({
                    "event_name": f"Message.Layer3.LteRrc.{canonical}",
                    "time": t_iso, "direction": direction,
                })
        else:
            i += 1

    return events


def _is_rrc_l3_file(path: str) -> bool:
    fname = _norm_col(os.path.basename(path))
    if "rrc" in fname or "l3" in fname:
        return True
    try:
        with open(path, "r", encoding="utf-8-sig", errors="replace") as fh:
            for line in fh:
                stripped = line.strip()
                if not stripped:
                    continue
                prefix = _norm_col(line.split('\t')[0])
                return prefix in _RRC_MSG_PREFIXES
    except OSError:
        pass
    return False


# ---------------------------------------------------------------------------
# File-set auto-detection helpers
# ---------------------------------------------------------------------------

def _classify_files(file_paths: List[str]) -> Dict[str, Any]:
    """
    Classify input files into functional categories.
    Returns a dict with keys:
      lte_metric_files, ss_files, serving_lte_files, serving_nr_lte_files, rrc_files
    """
    result: Dict[str, Any] = {
        "lte_metric_files": [],   # RSRP/RSRQ/SINR (LTE)
        "ss_files":         [],   # SS RSRP/RSRQ/SINR (NR beams)
        "serving_lte_files": [],  # Serving cell info LTE.txt
        "serving_nr_lte_files": [],  # Serving cell Information NR-LTE.txt
        "rrc_files":        [],   # RRC+L3 / RRC L3 NR LTE
    }
    for path in file_paths:
        if not os.path.isfile(path):
            continue
        fname = _norm_col(os.path.basename(path))
        if _is_rrc_l3_file(path):
            result["rrc_files"].append(path)
        elif fname.startswith("ss") and any(k in fname for k in ("rsrp", "rsrq", "sinr")):
            result["ss_files"].append(path)
        elif "nrlte" in fname or ("serving" in fname and "nr" in fname):
            result["serving_nr_lte_files"].append(path)
        elif "serving" in fname:
            result["serving_lte_files"].append(path)
        else:
            result["lte_metric_files"].append(path)
    return result


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def parse_nemo_lte_files(file_paths: List[str], skip_rrc: bool = False) -> Dict[str, Any]:
    """
    Parse one or more Nemo LTE / LTE+NR export files.
    Auto-detects 5G (EN-DC) mode when SS RSRP/RSRQ/SINR files are present.
    Returns a dict suitable for register_nemo_lte_run().

    skip_rrc=True: skip RRC Layer-3 parsing (caller handles it separately,
                   e.g. in a background thread via parse_rrc_files_deferred).
    """
    classified = _classify_files(file_paths)
    has_nr = bool(classified["ss_files"])

    groups: Dict[str, Dict] = {}
    names: List[str] = []

    # ── LTE metric files ────────────────────────────────────────────────────
    for path in classified["lte_metric_files"]:
        _dispatch_file(path, groups)

    # ── Build t_str index for O(1) serving-file lookups ─────────────────────
    t_str_index = _build_t_str_index(groups)

    # ── LTE serving cell info ───────────────────────────────────────────────
    for path in classified["serving_lte_files"]:
        _, rows = _parse_tsv_file(path)
        _extract_serving_info(rows, groups, t_str_index)
        for row in rows:
            title = row.get("measurementtitle") or row.get("title") or ""
            if title and title not in names:
                names.append(title)

    # ── Combined LTE+NR serving cell info ───────────────────────────────────
    for path in classified["serving_nr_lte_files"]:
        _, rows = _parse_tsv_file(path)
        _extract_serving_nr_lte(rows, groups, t_str_index)
        for row in rows:
            title = row.get("measurementtitle") or row.get("title") or ""
            if title and title not in names:
                names.append(title)

    # ── NR SS beam files ────────────────────────────────────────────────────
    if has_nr:
        _parse_ss_files(classified["ss_files"], groups)

    # ── RRC Layer-3 files (skipped when caller handles deferred parsing) ─────
    rrc_events: List[Dict[str, Any]] = []
    if not skip_rrc:
        for path in classified["rrc_files"]:
            rrc_events.extend(parse_rrc_l3_file(path))

    kpi_samples, track_points, min_t, max_t = _groups_to_samples(groups)

    run_name = names[0] if names else ("Nemo LTE+NR Export" if has_nr else "Nemo LTE Export")
    if len(run_name) > 60:
        run_name = run_name[:57] + "..."

    return {
        "name":         run_name,
        "kpi_samples":  kpi_samples,
        "track_points": track_points,
        "events":       rrc_events,
        "rrc_files":    classified["rrc_files"],
        "start_time":   _ts_to_iso(min_t) if min_t is not None else None,
        "end_time":     _ts_to_iso(max_t) if max_t is not None else None,
        "point_count":  len(track_points),
        "has_nr":       has_nr,
    }


def parse_rrc_files_deferred(rrc_files: List[str]) -> List[Dict[str, Any]]:
    """Parse RRC Layer-3 files; intended for background thread use."""
    events: List[Dict[str, Any]] = []
    for path in rrc_files:
        events.extend(parse_rrc_l3_file(path))
    return events


def register_nemo_lte_run(parsed: Dict[str, Any]) -> int:
    """
    Store parsed Nemo LTE / LTE+NR data as a virtual TRP run.
    Returns run_id for all /api/runs/<id>/* endpoints.
    """
    from trp_importer import (
        register_external_run,
        build_metric_catalog,
        _extract_sidebar_info,
        _build_sidebar_groups,
    )

    kpi_samples  = parsed.get("kpi_samples") or []
    track_points = parsed.get("track_points") or []
    events       = parsed.get("events") or []
    name         = parsed.get("name") or "Nemo LTE/NR Export"
    has_nr       = parsed.get("has_nr", False)

    catalog_rows = build_metric_catalog(kpi_samples)
    signals = [
        {
            "signal_name":  r["name"],
            "signal_id":    i + 1,
            "dtype":        r.get("dtype") or "num",
            "sample_count": (r.get("stats") or {}).get("sample_count", 0),
        }
        for i, r in enumerate(catalog_rows)
    ]
    kpi_names = [s["signal_name"] for s in signals]

    sidebar_info   = _extract_sidebar_info(kpi_samples, [])
    sidebar_groups = _build_sidebar_groups(kpi_names)

    entry: Dict[str, Any] = {
        "run": {
            "filename":   name,
            "source":     "nemo_nr_lte" if has_nr else "nemo_lte",
            "start_time": parsed.get("start_time"),
            "end_time":   parsed.get("end_time"),
        },
        "kpi_samples":  kpi_samples,
        "events":       events,
        "track_points": track_points,
        "catalog": {
            "signals": signals,
            "kpis":    [],
            "events":  [],
        },
        "sidebar": {
            "groups": sidebar_groups,
            "info":   sidebar_info,
        },
    }

    return register_external_run(entry)

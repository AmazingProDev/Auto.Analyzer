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
"""

from __future__ import annotations

import os
import json
import time
import tempfile
import zipfile
import re
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

# ----------------------------
# In-memory store
# ----------------------------

_RUNS: Dict[int, Dict[str, Any]] = {}
_NEXT_ID: int = 1


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _safe_float(x: Any) -> Optional[float]:
    try:
        if x is None:
            return None
        if isinstance(x, bool):
            return float(int(x))
        return float(x)
    except Exception:
        return None


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
        if last is None or (r.get("t"), r.get("value"), r.get("value_str")) != (last.get("t"), last.get("value"), last.get("value_str")):
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
    pat = re.compile(r"^Radio\.Lte\.Neighbor\[(\d+)\]\.(Pci|Rsrp|Rsrq|Earfcn|Frequency)$", re.IGNORECASE)
    counts: Dict[str, int] = {}
    for s in (kpi_samples or []):
        name = str((s or {}).get("name") or "").strip()
        if not name:
            continue
        if not pat.match(name):
            continue
        counts[name] = counts.get(name, 0) + 1

    out: List[Dict[str, Any]] = []
    for name, c in counts.items():
        m = pat.match(name)
        if not m:
            continue
        out.append({
            "name": name,
            "neighbor_index": int(m.group(1)),
            "field": str(m.group(2) or ""),
            "sample_count": int(c),
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
                "groups": sidebar_groups
            }
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
        "info": {},
        "groups": (entry.get("sidebar") or {}).get("groups") or [],
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


def fetch_timeseries_by_signal(db_path: Optional[str], run_id: int, signal: str, max_points: int = 50000) -> Dict[str, Any]:
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
            out.append({"t": t, "value": v, "unit": unit})
        else:
            out.append({"t": t, "value_str": str(val_str), "unit": unit})

    out = _downsample(out, max_points)
    return {"status": "success", "series": out}


def fetch_kpi_series(db_path: Optional[str], run_id: int, name: str, max_points: int = 50000) -> Dict[str, Any]:
    # Backward-compatible route payload used by trp_import_ui.js
    series = fetch_timeseries_by_signal(db_path, run_id, name, max_points=max_points)
    if series.get("status") != "success":
        return series
    rows = []
    for r in series.get("series") or []:
        rows.append({
            "time": r.get("t"),
            "value_num": r.get("value"),
            "value_str": r.get("value_str"),
        })
    return {"status": "success", "series": rows}

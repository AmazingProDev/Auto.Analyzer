"""Paths to active LOS geodata. Dataset can be switched at runtime."""
from __future__ import annotations

import json
import os
from pathlib import Path


APP_ROOT = Path(__file__).resolve().parents[1]
GEODATA_ROOT = Path(os.environ.get(
    "LOS_GEODATA_ROOT",
    "/Users/abdelilah/Desktop/AutoAnalyzer IAM/GeoData",
))
ACTIVE_DATASET_CONFIG = Path(os.environ.get(
    "LOS_ACTIVE_DATASET_CONFIG",
    str(APP_ROOT / "active_geodata.json"),
))

DEFAULT_DATA_ROOT = Path(os.environ.get(
    "LOS_DATA_ROOT",
    "/Users/abdelilah/Downloads/GeoData_Kenitra/processed",
))
DEFAULT_ATOLL_ROOT = Path(os.environ.get(
    "LOS_ATOLL_ROOT",
    "/Users/abdelilah/Downloads/GeoData_Kenitra/Kenitra_AFZ_Mehdia_cp1m_ATOLL",
))


def processed_root_for(dataset_root: Path | str) -> Path:
    return Path(dataset_root) / "_optim_processed"


def _load_saved_dataset() -> dict:
    try:
        if ACTIVE_DATASET_CONFIG.is_file():
            return json.loads(ACTIVE_DATASET_CONFIG.read_text(encoding="utf-8"))
    except Exception:
        pass
    return {}


def set_dataset_paths(atoll_root: Path | str, data_root: Path | str | None = None) -> None:
    global ATOLL_ROOT, DATA_ROOT, DTM_DIR, DHM_DIR, CLUTTER_DIR
    global BUILDINGS_FGB, VEGETATION_FGB, ORTHO_COG, DTM_COG, DHM_COG

    ATOLL_ROOT = Path(atoll_root)
    DATA_ROOT = Path(data_root) if data_root else processed_root_for(ATOLL_ROOT)

    DTM_DIR = ATOLL_ROOT / "DTM"
    DHM_DIR = ATOLL_ROOT / "Clutter Height"
    CLUTTER_DIR = ATOLL_ROOT / "Clutter"

    BUILDINGS_FGB = DATA_ROOT / "buildings.fgb"
    VEGETATION_FGB = DATA_ROOT / "vegetation.fgb"

    ORTHO_COG = DATA_ROOT / "ortho_cog.tif"
    DTM_COG = DATA_ROOT / "dtm_cog.tif"
    DHM_COG = DATA_ROOT / "dhm_cog.tif"


def save_active_dataset(atoll_root: Path | str, data_root: Path | str | None = None) -> None:
    payload = {
        "atoll_root": str(Path(atoll_root)),
        "data_root": str(Path(data_root) if data_root else processed_root_for(atoll_root)),
    }
    ACTIVE_DATASET_CONFIG.parent.mkdir(parents=True, exist_ok=True)
    ACTIVE_DATASET_CONFIG.write_text(json.dumps(payload, indent=2), encoding="utf-8")


_saved = _load_saved_dataset()
set_dataset_paths(
    _saved.get("atoll_root") or DEFAULT_ATOLL_ROOT,
    _saved.get("data_root") or DEFAULT_DATA_ROOT,
)

PORT = int(os.environ.get("LOS_PORT", "8001"))

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import config, state
from ..services import geodata_service


router = APIRouter(prefix="/api/los/geodata", tags=["LOS GeoData"])


class ActivateDatasetRequest(BaseModel):
    path: str


@router.get("/datasets")
def list_datasets() -> dict:
    datasets = geodata_service.discover_datasets()
    return {
        "status": "success",
        "geo_data_root": str(config.GEODATA_ROOT),
        "active": state.active_dataset_summary,
        "datasets": datasets,
    }


@router.post("/activate")
def activate_dataset(req: ActivateDatasetRequest) -> dict:
    dataset_root = Path(req.path).expanduser().resolve()
    if not geodata_service.is_dataset_dir(dataset_root):
        raise HTTPException(400, f"Invalid GeoData folder: {dataset_root}")

    try:
        dataset = geodata_service.ensure_processed_dataset(dataset_root)
        from .. import main as app_main

        runtime = app_main.reload_active_dataset(dataset_root, Path(dataset["processed_root"]))
        config.save_active_dataset(dataset_root, Path(dataset["processed_root"]))
    except Exception as exc:
        raise HTTPException(500, f"GeoData activation failed: {exc}") from exc

    return {
        "status": "success",
        "dataset": dataset,
        "runtime": runtime,
    }

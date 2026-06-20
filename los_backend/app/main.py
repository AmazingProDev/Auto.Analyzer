"""FastAPI entry point for the LOS backend (port 8001)."""
from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import config, state
from .services.atoll_reader import ConstantRasterSource, is_tiled_atoll_dir, load_atoll_dataset, load_atoll_raster, load_geotiff_raster
from .services.vector_service import clear_vectors, load_vectors
from .routers import geodata, layers, los as los_router, tiles


def reload_active_dataset(atoll_root: Path | str | None = None, data_root: Path | str | None = None) -> dict:
    if atoll_root is not None:
        config.set_dataset_paths(Path(atoll_root), Path(data_root) if data_root else None)

    state.active_atoll_root = config.ATOLL_ROOT
    state.active_data_root = config.DATA_ROOT

    dtm_tif = config.DATA_ROOT / "dtm.tif"
    dhm_tif = config.DATA_ROOT / "dhm.tif"
    dtm_tiled = config.DTM_DIR.exists() and is_tiled_atoll_dir(config.DTM_DIR)
    dhm_tiled = config.DHM_DIR.exists() and is_tiled_atoll_dir(config.DHM_DIR)

    print(f"[LOS] Activating dataset: {config.ATOLL_ROOT}")

    if dtm_tiled:
        print("[LOS] Loading tiled DTM catalog …")
        state.dtm, state.dtm_gt = load_atoll_dataset(config.DTM_DIR)
    elif dtm_tif.exists():
        print("[LOS] Loading DTM from processed GeoTIFF …")
        state.dtm, state.dtm_gt = load_geotiff_raster(dtm_tif)
    elif config.DTM_DIR.exists():
        print("[LOS] Loading DTM from raw ATOLL …")
        state.dtm, state.dtm_gt = load_atoll_raster(config.DTM_DIR)
    else:
        state.dtm, state.dtm_gt = None, None

    if dhm_tiled:
        print("[LOS] Loading tiled DHM catalog …")
        state.dhm, state.dhm_gt = load_atoll_dataset(config.DHM_DIR)
    elif config.DHM_DIR.exists():
        if dhm_tif.exists():
            print("[LOS] Loading DHM from processed GeoTIFF …")
            state.dhm, state.dhm_gt = load_geotiff_raster(dhm_tif)
        else:
            print("[LOS] Loading DHM from raw ATOLL …")
            state.dhm, state.dhm_gt = load_atoll_raster(config.DHM_DIR)
    elif state.dtm_gt is not None:
        print("[LOS] No DHM available; using zero-height obstacle surface across DTM extent …")
        state.dhm, state.dhm_gt = ConstantRasterSource(0.0, state.dtm_gt), state.dtm_gt
    elif dhm_tif.exists():
        print("[LOS] Loading DHM from processed GeoTIFF …")
        state.dhm, state.dhm_gt = load_geotiff_raster(dhm_tif)
    else:
        state.dhm, state.dhm_gt = None, None

    clear_vectors()
    load_vectors(
        config.BUILDINGS_FGB if config.BUILDINGS_FGB.exists() else None,
        config.VEGETATION_FGB if config.VEGETATION_FGB.exists() else None,
    )

    state.active_dataset_summary = {
        "atoll_root": str(config.ATOLL_ROOT),
        "data_root": str(config.DATA_ROOT),
        "dtm_loaded": state.dtm is not None,
        "dhm_loaded": state.dhm is not None,
        "dtm_tiled": dtm_tiled,
        "dhm_tiled": dhm_tiled,
        "buildings_loaded": config.BUILDINGS_FGB.exists(),
        "vegetation_loaded": config.VEGETATION_FGB.exists(),
    }
    return state.active_dataset_summary


@asynccontextmanager
async def lifespan(_app: FastAPI):
    reload_active_dataset()
    print("[LOS] Startup complete — ready to serve requests")
    yield
    print("[LOS] Shutdown")


app = FastAPI(
    title="LOS Backend",
    description="Line-of-sight simulation API for Kenitra geodata",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)

app.include_router(layers.router)
app.include_router(geodata.router)
app.include_router(los_router.router)
app.include_router(tiles.router)


@app.get("/")
def health():
    return {
        "status": "ok",
        "dtm_loaded": state.dtm is not None,
        "dhm_loaded": state.dhm is not None,
        "active_dataset": state.active_dataset_summary,
    }

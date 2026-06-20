from __future__ import annotations

import shutil
from pathlib import Path

import geopandas as gpd
import numpy as np
import pandas as pd

from .. import config
from .atoll_reader import atoll_to_geotiff, is_tiled_atoll_dir, load_atoll_raster


def is_dataset_dir(path: Path) -> bool:
    return path.is_dir() and (path / "DTM").is_dir()


def discover_datasets(root: Path | None = None) -> list[dict]:
    base = Path(root or config.GEODATA_ROOT)
    datasets: list[dict] = []
    if not base.is_dir():
        return datasets
    for child in sorted(base.iterdir(), key=lambda p: p.name.lower()):
        if not is_dataset_dir(child):
            continue
        datasets.append(describe_dataset(child))
    return datasets


def describe_dataset(dataset_root: Path) -> dict:
    processed_root = config.processed_root_for(dataset_root)
    dtm_dir = dataset_root / "DTM"
    return {
        "name": dataset_root.name,
        "path": str(dataset_root),
        "processed_root": str(processed_root),
        "has_dtm": dtm_dir.is_dir(),
        "dtm_tiled": dtm_dir.is_dir() and is_tiled_atoll_dir(dtm_dir),
        "has_clutter_height": (dataset_root / "Clutter Height").is_dir(),
        "has_clutter": (dataset_root / "Clutter").is_dir(),
        "has_2d_vectors": (dataset_root / "2D vectors").is_dir(),
        "has_3d_vectors": (dataset_root / "3D vectors").is_dir(),
        "processed_ready": processed_root.is_dir() and (
            (processed_root / "dtm.tif").exists() or (dtm_dir.is_dir() and is_tiled_atoll_dir(dtm_dir))
        ),
    }


def _copy_if_missing(src: Path, dst: Path) -> None:
    if src.exists() and not dst.exists():
        shutil.copy2(src, dst)


def _write_zero_geotiff_like(reference_dataset_root: Path, out_path: Path) -> None:
    import rasterio
    from rasterio.transform import from_bounds

    arr, gt = load_atoll_raster(reference_dataset_root / "DTM")
    zeros = np.zeros_like(arr, dtype=np.int16)
    transform = from_bounds(
        gt["min_east"],
        gt["max_north"] - gt["height"] * gt["res"],
        gt["min_east"] + gt["width"] * gt["res"],
        gt["max_north"],
        gt["width"],
        gt["height"],
    )
    with rasterio.open(
        out_path,
        "w",
        driver="GTiff",
        height=gt["height"],
        width=gt["width"],
        count=1,
        dtype="int16",
        crs="EPSG:32629",
        transform=transform,
        nodata=-9999,
    ) as dst:
        dst.write(zeros.astype("<i2"), 1)


def _find_tabs(dataset_root: Path, keyword: str) -> list[Path]:
    keyword_l = keyword.lower()
    matches: list[Path] = []
    for tab_path in sorted(dataset_root.rglob("*.tab")):
        if keyword_l in tab_path.name.lower():
            matches.append(tab_path)
    return matches


def _load_clean_vector_layer(src_path: Path) -> gpd.GeoDataFrame:
    gdf = gpd.read_file(str(src_path))
    if "geometry" not in gdf:
        return gpd.GeoDataFrame(geometry=[], crs="EPSG:32629")
    gdf = gdf.loc[gdf.geometry.notna()].copy()
    if not gdf.empty:
        gdf = gdf.loc[~gdf.geometry.is_empty].copy()
    if gdf.empty:
        return gpd.GeoDataFrame(columns=list(gdf.columns), geometry=[], crs=gdf.crs or "EPSG:32629")
    if gdf.crs is None:
        gdf = gdf.set_crs(epsg=32629)
    elif gdf.crs.to_epsg() != 32629:
        gdf = gdf.to_crs(epsg=32629)
    return gdf


def _export_flatgeobuf(src_paths: list[Path], out_path: Path) -> None:
    frames: list[gpd.GeoDataFrame] = []
    for src_path in src_paths:
        gdf = _load_clean_vector_layer(src_path)
        if not gdf.empty:
            frames.append(gdf)
    if not frames:
        return
    gdf = gpd.GeoDataFrame(pd.concat(frames, ignore_index=True), crs=frames[0].crs)
    if out_path.exists():
        out_path.unlink()
    gdf.to_file(str(out_path), driver="FlatGeobuf")


def ensure_processed_dataset(dataset_root: Path | str) -> dict:
    dataset_root = Path(dataset_root)
    if not is_dataset_dir(dataset_root):
        raise FileNotFoundError(f"Dataset root is invalid or missing DTM: {dataset_root}")

    processed_root = config.processed_root_for(dataset_root)
    processed_root.mkdir(parents=True, exist_ok=True)
    dtm_dir = dataset_root / "DTM"
    dtm_tiled = is_tiled_atoll_dir(dtm_dir)

    dtm_tif = processed_root / "dtm.tif"
    dhm_tif = processed_root / "dhm.tif"
    clutter_tif = processed_root / "clutter.tif"

    if not dtm_tiled:
        if not dtm_tif.exists():
            atoll_to_geotiff(dtm_dir, dtm_tif)
        _copy_if_missing(dtm_tif, processed_root / "dtm_cog.tif")

    if (dataset_root / "Clutter Height").is_dir():
        if not dhm_tif.exists():
            atoll_to_geotiff(dataset_root / "Clutter Height", dhm_tif)
    elif not dtm_tiled and not dhm_tif.exists():
        _write_zero_geotiff_like(dataset_root, dhm_tif)
    if dhm_tif.exists():
        _copy_if_missing(dhm_tif, processed_root / "dhm_cog.tif")

    if (dataset_root / "Clutter").is_dir() and not clutter_tif.exists() and not is_tiled_atoll_dir(dataset_root / "Clutter"):
        atoll_to_geotiff(dataset_root / "Clutter", clutter_tif)

    building_tabs = _find_tabs(dataset_root, "building")
    vegetation_tabs = _find_tabs(dataset_root, "vegetation")
    buildings_fgb = processed_root / "buildings.fgb"
    vegetation_fgb = processed_root / "vegetation.fgb"
    if building_tabs:
        _export_flatgeobuf(building_tabs, buildings_fgb)
    if vegetation_tabs:
        _export_flatgeobuf(vegetation_tabs, vegetation_fgb)

    return {
        **describe_dataset(dataset_root),
        "processed_root": str(processed_root),
        "outputs": {
            "dtm_tif": str(dtm_tif) if dtm_tif.exists() else None,
            "dhm_tif": str(dhm_tif) if dhm_tif.exists() else None,
            "clutter_tif": str(clutter_tif) if clutter_tif.exists() else None,
            "buildings_fgb": str(buildings_fgb) if buildings_fgb.exists() else None,
            "vegetation_fgb": str(vegetation_fgb) if vegetation_fgb.exists() else None,
        },
    }

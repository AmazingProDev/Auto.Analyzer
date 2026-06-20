"""
ATOLL proprietary binary raster reader.

ATOLL stores DTM / DHM / Clutter rasters as raw little-endian int16, no header.
Layout is derived from the sidecar `index` text file:
  <filename> <min_east> <max_east> <min_north> <max_north> <resolution>

Row 0 corresponds to the northernmost row (north-up).
NoData = -9999.
"""
from __future__ import annotations

import numpy as np
from pathlib import Path
from collections import OrderedDict

NODATA: int = -9999


def read_atoll_index(index_path: Path) -> dict:
    parts = index_path.read_text(encoding="utf-8", errors="ignore").strip().split()
    return {
        "filename":  parts[0],
        "min_east":  float(parts[1]),
        "max_east":  float(parts[2]),
        "min_north": float(parts[3]),
        "max_north": float(parts[4]),
        "resolution": float(parts[5]),
    }


def read_atoll_index_entries(index_path: Path) -> list[dict]:
    entries: list[dict] = []
    for raw_line in index_path.read_text(encoding="utf-8", errors="ignore").splitlines():
        parts = raw_line.strip().split()
        if len(parts) < 6:
            continue
        entry = {
            "filename": parts[0],
            "min_east": float(parts[1]),
            "max_east": float(parts[2]),
            "min_north": float(parts[3]),
            "max_north": float(parts[4]),
            "resolution": float(parts[5]),
        }
        res = entry["resolution"]
        entry["width"] = round((entry["max_east"] - entry["min_east"]) / res)
        entry["height"] = round((entry["max_north"] - entry["min_north"]) / res)
        entries.append(entry)
    return entries


def is_tiled_atoll_dir(data_dir: Path) -> bool:
    return len(read_atoll_index_entries(data_dir / "index")) > 1


class ConstantRasterSource:
    def __init__(self, value: float, gt: dict):
        self.value = float(value)
        self.gt = dict(gt)

    def sample_point(self, easting: float, northing: float) -> float | None:
        col = int((easting - self.gt["min_east"]) / self.gt["res"])
        row = int((self.gt["max_north"] - northing) / self.gt["res"])
        if 0 <= row < self.gt["height"] and 0 <= col < self.gt["width"]:
            return self.value
        return None


class AtollTileCatalog:
    def __init__(self, data_dir: Path, entries: list[dict], cache_size: int = 4):
        self.data_dir = Path(data_dir)
        self.entries = list(entries)
        self.cache_size = cache_size
        self._cache: OrderedDict[str, np.ndarray] = OrderedDict()
        min_east = min(e["min_east"] for e in self.entries)
        max_east = max(e["max_east"] for e in self.entries)
        min_north = min(e["min_north"] for e in self.entries)
        max_north = max(e["max_north"] for e in self.entries)
        res = self.entries[0]["resolution"]
        self.gt = {
            "min_east": min_east,
            "max_north": max_north,
            "res": res,
            "width": round((max_east - min_east) / res),
            "height": round((max_north - min_north) / res),
        }

    def _load_tile(self, entry: dict) -> np.ndarray:
        key = entry["filename"]
        arr = self._cache.get(key)
        if arr is not None:
            self._cache.move_to_end(key)
            return arr
        raw = (self.data_dir / key).read_bytes()
        arr = np.frombuffer(raw, dtype=">i2").reshape(entry["height"], entry["width"])
        self._cache[key] = arr
        self._cache.move_to_end(key)
        while len(self._cache) > self.cache_size:
            self._cache.popitem(last=False)
        return arr

    def sample_point(self, easting: float, northing: float) -> float | None:
        for entry in self.entries:
            if not (entry["min_east"] <= easting < entry["max_east"]):
                continue
            if not (entry["min_north"] <= northing < entry["max_north"]):
                continue
            arr = self._load_tile(entry)
            col = int((easting - entry["min_east"]) / entry["resolution"])
            row = int((entry["max_north"] - northing) / entry["resolution"])
            if 0 <= row < entry["height"] and 0 <= col < entry["width"]:
                val = int(arr[row, col])
                return None if val == NODATA else float(val)
        return None


def load_atoll_raster(data_dir: Path) -> tuple[np.ndarray, dict]:
    """
    Return (array, geotransform_dict).

    array: shape (height, width), dtype int16.
           arr[0, :] = northernmost row; arr[-1, :] = southernmost row.
    geotransform: min_east, max_north, res, width, height.
    """
    entries = read_atoll_index_entries(data_dir / "index")
    if len(entries) != 1:
        raise ValueError(f"Expected a single-raster ATOLL directory, found {len(entries)} tiles in {data_dir}")
    meta = entries[0]
    res    = meta["resolution"]
    width  = round((meta["max_east"]  - meta["min_east"])  / res)
    height = round((meta["max_north"] - meta["min_north"]) / res)

    raw = (data_dir / meta["filename"]).read_bytes()
    # ATOLL stores rasters as big-endian int16 (confirmed: 0xD8F1 big-endian = -9999 NoData)
    arr = np.frombuffer(raw, dtype=">i2").reshape(height, width)

    gt = {
        "min_east":  meta["min_east"],
        "max_north": meta["max_north"],
        "res":    res,
        "width":  width,
        "height": height,
    }
    return arr, gt


def load_atoll_dataset(data_dir: Path) -> tuple[object, dict]:
    entries = read_atoll_index_entries(data_dir / "index")
    if len(entries) > 1:
        catalog = AtollTileCatalog(data_dir, entries)
        return catalog, catalog.gt
    arr, gt = load_atoll_raster(data_dir)
    return arr, gt


def sample_point(arr: object, gt: dict | None, easting: float, northing: float) -> float | None:
    """Sample the raster at a single UTM point. Returns None for NoData or out-of-bounds."""
    sampler = getattr(arr, "sample_point", None)
    if callable(sampler):
        return sampler(easting, northing)
    if gt is None:
        return None
    col = int((easting  - gt["min_east"])  / gt["res"])
    row = int((gt["max_north"] - northing) / gt["res"])
    if 0 <= row < gt["height"] and 0 <= col < gt["width"]:
        val = int(arr[row, col])
        return None if val == NODATA else float(val)
    return None


def atoll_to_geotiff(data_dir: Path, out_path: Path, nodata: int = NODATA) -> None:
    """
    One-time conversion: ATOLL binary → GeoTIFF (EPSG:32629, int16).
    Requires rasterio.
    """
    import rasterio
    from rasterio.transform import from_bounds

    arr, gt = load_atoll_raster(data_dir)
    transform = from_bounds(
        gt["min_east"],
        gt["max_north"] - gt["height"] * gt["res"],
        gt["min_east"]  + gt["width"]  * gt["res"],
        gt["max_north"],
        gt["width"],
        gt["height"],
    )
    with rasterio.open(
        out_path, "w",
        driver="GTiff",
        height=gt["height"], width=gt["width"],
        count=1, dtype="int16",
        crs="EPSG:32629",
        transform=transform,
        nodata=nodata,
    ) as dst:
        # byteswap to native endian so rasterio writes standard little-endian int16
        dst.write(arr.astype("<i2"), 1)


def load_geotiff_raster(path: Path) -> tuple[np.ndarray, dict]:
    """Load a GeoTIFF into the same in-memory format used by load_atoll_raster."""
    import rasterio

    with rasterio.open(path) as src:
        arr = src.read(1).astype(np.int16, copy=False)
        transform = src.transform
        gt = {
            "min_east": float(transform.c),
            "max_north": float(transform.f),
            "res": float(transform.a),
            "width": int(src.width),
            "height": int(src.height),
        }
    return arr, gt

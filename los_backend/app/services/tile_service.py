"""
Serve ortho COG tiles for the frontend map.
Uses rasterio + rasterio.warp to reproject 256×256 slippy-map tiles from the COG.
Requires Pillow for PNG encoding (pip install Pillow).
"""
from __future__ import annotations

import io
import math
from pathlib import Path

import numpy as np
import rasterio
from rasterio.crs import CRS
from rasterio.transform import from_bounds
from rasterio.warp import reproject, Resampling

_WEB = CRS.from_epsg(3857)
TILE_SIZE = 256


def _tile_bounds_3857(z: int, x: int, y: int) -> tuple[float, float, float, float]:
    n = 2 ** z
    tile_m = 2 * math.pi * 6378137
    min_x = (x / n) * tile_m - tile_m / 2
    max_x = ((x + 1) / n) * tile_m - tile_m / 2
    max_y = tile_m / 2 - (y / n) * tile_m
    min_y = tile_m / 2 - ((y + 1) / n) * tile_m
    return min_x, min_y, max_x, max_y


def render_ortho_tile(cog_path: Path, z: int, x: int, y: int) -> bytes | None:
    from PIL import Image

    min_x, min_y, max_x, max_y = _tile_bounds_3857(z, x, y)
    dst_transform = from_bounds(min_x, min_y, max_x, max_y, TILE_SIZE, TILE_SIZE)

    with rasterio.open(str(cog_path)) as src:
        out = np.zeros((3, TILE_SIZE, TILE_SIZE), dtype=np.uint8)
        reproject(
            source=rasterio.band(src, [1, 2, 3]),
            destination=out,
            dst_transform=dst_transform,
            dst_crs=_WEB,
            resampling=Resampling.bilinear,
        )

    if out.max() == 0:
        return None

    img = Image.fromarray(out.transpose(1, 2, 0), mode="RGB")
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue()

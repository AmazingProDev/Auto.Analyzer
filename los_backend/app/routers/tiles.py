"""
Serve raster tiles from the ortho COG.
GET /tiles/ortho/{z}/{x}/{y}.png
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Response
from ..services.tile_service import render_ortho_tile
from .. import config

router = APIRouter(prefix="/tiles", tags=["Tiles"])


@router.get("/ortho/{z}/{x}/{y}.png")
def ortho_tile(z: int, x: int, y: int) -> Response:
    if not config.ORTHO_COG.exists():
        raise HTTPException(404, "ortho_cog.tif not found — run preprocessing first")
    data = render_ortho_tile(config.ORTHO_COG, z, x, y)
    if data is None:
        raise HTTPException(204, "Tile outside ortho extent")
    return Response(content=data, media_type="image/png",
                    headers={"Cache-Control": "public, max-age=86400"})

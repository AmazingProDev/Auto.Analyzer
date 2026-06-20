from __future__ import annotations
from fastapi import APIRouter
from .. import config
from .. import state
from ..models.layer import LayerInfo, LayerExtent
from ..services.crs_service import utm_extent_to_wgs84
from ..services import vector_service

router = APIRouter(prefix="/api/los", tags=["LOS"])

def _dtm_extent() -> LayerExtent:
    gt = state.dtm_gt
    if not gt:
        raise RuntimeError("DTM extent is unavailable")
    extent = {
        "min_east": float(gt["min_east"]),
        "max_east": float(gt["min_east"] + gt["width"] * gt["res"]),
        "min_north": float(gt["max_north"] - gt["height"] * gt["res"]),
        "max_north": float(gt["max_north"]),
    }
    wgs = utm_extent_to_wgs84(**extent)
    return LayerExtent(**extent, **wgs)


@router.get("/layers")
def get_layers() -> dict:
    bld = vector_service.get_buildings()
    veg = vector_service.get_vegetation()
    dtm_ok = state.dtm is not None
    dhm_ok = state.dhm is not None

    layers = [
        LayerInfo(
            id="dtm", type="raster", role="ground_elevation",
            available=dtm_ok,
            crs="EPSG:32629", resolution_m=1, nodata=-9999,
            extent=_dtm_extent() if dtm_ok else None,
        ),
        LayerInfo(
            id="dhm", type="raster", role="obstacle_height_agl",
            available=dhm_ok,
            crs="EPSG:32629", resolution_m=1, nodata=-9999,
        ),
        LayerInfo(
            id="clutter", type="raster", role="land_cover",
            available=config.CLUTTER_DIR.exists(),
            crs="EPSG:32629", resolution_m=1,
            clutter_classes=22,
        ),
        LayerInfo(
            id="buildings", type="vector", role="building_obstacles",
            available=bld is not None,
            height_field="AGL",
            feature_count=len(bld.gdf) if bld else None,
            rf_attenuation_bands=["800-890", "910-990", "1800-1890", "2100-2190", "2500-2700", "3300-3700"],
        ),
        LayerInfo(
            id="vegetation", type="vector", role="vegetation_obstacles",
            available=veg is not None,
            height_field="AGL",
            feature_count=len(veg.gdf) if veg else None,
        ),
        LayerInfo(
            id="ortho", type="raster", role="aerial_imagery",
            available=config.ORTHO_COG.exists(),
            crs="EPSG:32629", resolution_m=1,
        ),
    ]
    return {"layers": [l.model_dump(exclude_none=True) for l in layers]}

from __future__ import annotations
from fastapi import APIRouter, HTTPException
from ..models.los import LosRequest, LosResponse, ViewshedRequest
from ..services import los_service, vector_service, viewshed_service
from ..services.atoll_reader import sample_point
from ..services.crs_service import wgs84_to_utm
from shapely.geometry import box as shapely_box
from .. import state

router = APIRouter(prefix="/api/los", tags=["LOS"])


@router.post("", response_model=LosResponse)
def compute_los(req: LosRequest) -> dict:
    if state.dtm is None or state.dhm is None:
        raise HTTPException(503, "Raster data not loaded — run convert_atoll_rasters.py first")

    result = los_service.compute_los(
        dtm=state.dtm, dtm_gt=state.dtm_gt,
        dhm=state.dhm, dhm_gt=state.dhm_gt,
        buildings=vector_service.get_buildings(),
        vegetation=vector_service.get_vegetation(),
        request=req.model_dump(),
    )
    return result


@router.get("/profile")
def get_profile(
    obs_lon: float, obs_lat: float,
    tgt_lon: float, tgt_lat: float,
    spacing_m: float = 2.0,
    include_clutter_height: bool = True,
) -> dict:
    """Terrain + obstacle profile along a path (no visibility verdict)."""
    if state.dtm is None or state.dhm is None:
        raise HTTPException(503, "Raster data not loaded")

    req = LosRequest(
        observer={"lon": obs_lon, "lat": obs_lat, "height_agl_m": 0},
        target={"lon": tgt_lon, "lat": tgt_lat, "height_agl_m": 0},
        options={
            "include_clutter_height": include_clutter_height,
            "include_buildings": False,
            "include_vegetation": False,
            "sample_spacing_m": spacing_m,
        },
    )
    result = los_service.compute_los(
        state.dtm, state.dtm_gt, state.dhm, state.dhm_gt,
        buildings=None, vegetation=None,
        request=req.model_dump(),
    )
    return {"distance_m": result["distance_m"], "profile": result["profile"]}


@router.get("/sample")
def sample_surface(lon: float, lat: float) -> dict:
    """Sample the active LOS rasters at a single WGS84 point."""
    if state.dtm is None:
        raise HTTPException(503, "DTM data not loaded")

    east, north = wgs84_to_utm(lon, lat)
    ground = sample_point(state.dtm, state.dtm_gt, east, north)
    clutter_agl = sample_point(state.dhm, state.dhm_gt, east, north) if state.dhm is not None else None
    obstacle_surface = None if ground is None else ground + max(0.0, clutter_agl or 0.0)

    return {
        "lon": round(lon, 7),
        "lat": round(lat, 7),
        "utm_east": round(east, 2),
        "utm_north": round(north, 2),
        "ground_m": None if ground is None else round(float(ground), 2),
        "clutter_height_agl_m": None if clutter_agl is None else round(float(clutter_agl), 2),
        "obstacle_surface_m": None if obstacle_surface is None else round(float(obstacle_surface), 2),
        "active_dataset": state.active_dataset_summary,
    }


@router.get("/features")
def get_features(
    min_lon: float, min_lat: float,
    max_lon: float, max_lat: float,
    max_per_type: int = 5000,
) -> dict:
    """Return buildings and vegetation polygons inside a WGS-84 bounding box as GeoJSON."""
    min_e, min_n = wgs84_to_utm(min_lon, min_lat)
    max_e, max_n = wgs84_to_utm(max_lon, max_lat)
    query_box = shapely_box(min_e, min_n, max_e, max_n)

    features: list[dict] = []

    for layer, ftype in (
        (vector_service.get_buildings(),  "building"),
        (vector_service.get_vegetation(), "vegetation"),
    ):
        if layer is None:
            continue
        idxs = layer.tree.query(query_box, predicate="intersects")
        if len(idxs) == 0:
            continue
        subset = layer.gdf.iloc[idxs[:max_per_type]].to_crs(epsg=4326)
        for _, row in subset.iterrows():
            geom = row.geometry
            if geom is None or geom.is_empty:
                continue
            agl = float(row.get("AGL") or 0)
            features.append({
                "type": "Feature",
                "geometry": geom.__geo_interface__,
                "properties": {"feature_type": ftype, "agl": agl},
            })

    return {"type": "FeatureCollection", "features": features}


@router.post("/viewshed")
def compute_viewshed(req: ViewshedRequest) -> dict:
    """Radial visibility sweep from observer. Returns GeoJSON Polygon of visible area."""
    if state.dtm is None or state.dhm is None:
        raise HTTPException(503, "Raster data not loaded")
    obs = req.observer
    return viewshed_service.compute_viewshed(
        dtm=state.dtm, dtm_gt=state.dtm_gt,
        dhm=state.dhm, dhm_gt=state.dhm_gt,
        observer_lon=obs.lon,
        observer_lat=obs.lat,
        observer_agl_m=obs.height_agl_m,
        max_radius_m=req.max_radius_m,
        az_step_deg=req.az_step_deg,
        r_step_m=req.r_step_m,
        include_clutter=req.include_clutter,
    )

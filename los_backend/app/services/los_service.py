"""
Line-of-sight algorithm.

Coordinate system: all calculations in EPSG:32629 (UTM Zone 29N, metres).
Inputs and outputs use WGS84 lon/lat for the API boundary.

DHM (Clutter Height) = height AGL. Combined obstacle surface:
    surface_amsl = dtm_value + max(0, dhm_value)

Building vector check runs after the raster sweep and can upgrade
a raster-based block to a named building block (or find a closer one).
"""
from __future__ import annotations

import numpy as np
from shapely.geometry import LineString, Point as ShapelyPoint
from shapely.strtree import STRtree

from .atoll_reader import sample_point
from .crs_service import wgs84_to_utm, utm_to_wgs84
from .vector_service import VectorLayer

# Building RF attenuation field mapping: (low_mhz, high_mhz) → (outdoor, indoor) field names
_FREQ_FIELD_MAP: dict[tuple[int, int], tuple[str, str]] = {
    (800,  890):  ("Out_In_800_890_Mhz",   "In_In_800_890_Mhz"),
    (910,  990):  ("Out_In_910_990_Mhz",   "In_In_910_990_Mhz"),
    (1800, 1890): ("Out_In_1800_1890_Mhz", "In_In_1800_1890_Mhz"),
    (2100, 2190): ("Out_In_2100_2190_Mhz", "In_In_2100_2190_Mhz"),
    (2500, 2700): ("Out_In_2500_2700_Mhz", "In_In_2500_2700_Mhz"),
    (3300, 3700): ("Out_In_3300_3700_Mhz", "In_In_3300_3700_Mhz"),
}


def _rf_attenuation(row, freq_mhz: float | None) -> float | None:
    if freq_mhz is None:
        return None
    for (lo, hi), (out_field, _in_field) in _FREQ_FIELD_MAP.items():
        if lo <= freq_mhz <= hi:
            val = row.get(out_field)
            try:
                return float(val) if val is not None else None
            except (TypeError, ValueError):
                return None
    return None


def _wgs84_ring_to_utm(ring: list) -> list[tuple[float, float]]:
    """Convert a GeoJSON coordinate ring [[lon,lat],...] to UTM (easting, northing) pairs."""
    return [wgs84_to_utm(lon, lat) for lon, lat in ring]


def _custom_obs_to_utm_shape(geom_dict: dict):
    """Convert a WGS84 GeoJSON Polygon dict to a UTM Shapely Polygon. Returns None on error."""
    from shapely.geometry import Polygon
    try:
        coords = geom_dict.get('coordinates', [])
        if not coords:
            return None
        outer = _wgs84_ring_to_utm(coords[0])
        holes = [_wgs84_ring_to_utm(r) for r in coords[1:]]
        return Polygon(outer, holes)
    except Exception:
        return None


def _build_custom_index(custom_obstacles: list[dict]):
    """Return (strtree, shapes, agls) for a list of custom obstacle dicts, or (None,[],[])."""
    shapes, agls = [], []
    for feat in custom_obstacles:
        props = feat.get('properties', {})
        agl   = float(props.get('height_agl_m', 0) or 0)
        if agl <= 0:
            continue
        geom = _custom_obs_to_utm_shape(feat.get('geometry', {}))
        if geom is None or geom.is_empty:
            continue
        shapes.append(geom)
        agls.append(agl)
    if not shapes:
        return None, [], []
    return STRtree(shapes), shapes, agls


def _check_custom_obstacles(
    custom_obstacles: list[dict],
    los_line: LineString,
    ox: float, oy: float,
    obs_abs: float, tgt_abs: float,
    total_dist: float,
    dtm: np.ndarray, dtm_gt: dict,
) -> dict | None:
    """Check user-drawn obstacles for LOS obstruction."""
    best = None
    for feat in custom_obstacles:
        props = feat.get('properties', {})
        agl   = float(props.get('height_agl_m', 0) or 0)
        if agl <= 0:
            continue
        geom = _custom_obs_to_utm_shape(feat.get('geometry', {}))
        if geom is None or geom.is_empty:
            continue
        inter = los_line.intersection(geom)
        if inter.is_empty:
            continue
        mid = inter.centroid
        d_b = float(np.hypot(mid.x - ox, mid.y - oy))
        if total_dist <= 0:
            continue
        b_ground = sample_point(dtm, dtm_gt, mid.x, mid.y) or 0.0
        b_roof   = b_ground + agl
        ray_b    = obs_abs + (tgt_abs - obs_abs) * (d_b / total_dist)
        if b_roof > ray_b:
            blon, blat = utm_to_wgs84(mid.x, mid.y)
            obs_type   = props.get('obstacle_type', 'building')
            cand = {
                "reason":                obs_type,
                "blocker_id":            props.get('name', 'Custom obstacle'),
                "location":              {"lon": round(blon, 7), "lat": round(blat, 7)},
                "distance_to_blocker_m": round(d_b, 2),
                "ray_height_m":          round(ray_b, 2),
                "obstacle_height_m":     round(b_roof, 2),
                "clearance_m":           round(ray_b - b_roof, 2),
            }
            if best is None or d_b < best["distance_to_blocker_m"]:
                best = cand
    return best


def _tag_surface_types(
    profile: list[dict],
    xs: np.ndarray,
    ys: np.ndarray,
    los_line: LineString,
    buildings: VectorLayer | None,
    vegetation: VectorLayer | None,
    opts: dict,
    custom_obstacles: list[dict] | None = None,
) -> None:
    """Add surface_type ('building' | 'vegetation' | 'clutter') to each profile point."""
    types = ['clutter'] * len(profile)

    for layer, label, skip in (
        (buildings,  'building',   set()),
        (vegetation, 'vegetation', {'building'}),
    ):
        if layer is None:
            continue
        if label == 'building' and not opts.get('include_buildings', True):
            continue
        if label == 'vegetation' and not opts.get('include_vegetation', True):
            continue
        idxs = layer.tree.query(los_line, predicate='intersects')
        if len(idxs) == 0:
            continue
        sub_geoms = list(layer.gdf.iloc[idxs].geometry.values)
        if not sub_geoms:
            continue
        sub_tree = STRtree(sub_geoms)
        for i, (x, y) in enumerate(zip(xs, ys)):
            if types[i] in skip:
                continue
            if sub_tree.query(ShapelyPoint(x, y), predicate='within').size > 0:
                types[i] = label

    # Custom user-drawn obstacles (take priority over clutter, yield to named building)
    if custom_obstacles:
        c_tree, c_shapes, _ = _build_custom_index(custom_obstacles)
        if c_tree is not None:
            c_types = [
                (feat.get('properties', {}).get('obstacle_type', 'building'))
                for feat in custom_obstacles
                if float((feat.get('properties') or {}).get('height_agl_m', 0) or 0) > 0
                and _custom_obs_to_utm_shape(feat.get('geometry', {})) is not None
                and not _custom_obs_to_utm_shape(feat.get('geometry', {})).is_empty
            ]
            for i, (x, y) in enumerate(zip(xs, ys)):
                if types[i] == 'building':
                    continue
                hits = c_tree.query(ShapelyPoint(x, y), predicate='within')
                if hits.size > 0:
                    types[i] = c_types[hits[0]] if hits[0] < len(c_types) else 'building'

    for i, p in enumerate(profile):
        p['surface_type'] = types[i]


def _check_vector_layer(
    layer: VectorLayer,
    los_line: LineString,
    ox: float, oy: float,
    obs_abs: float, tgt_abs: float,
    total_dist: float,
    dtm: np.ndarray, dtm_gt: dict,
    freq_mhz: float | None,
    reason_label: str,
) -> dict | None:
    """Check a vector layer (buildings or vegetation) for LOS obstruction."""
    best = None
    candidates = layer.query_line(los_line)
    for _, feat in candidates.iterrows():
        agl = float(feat.get("AGL") or 0)
        if agl <= 0:
            continue
        inter = los_line.intersection(feat.geometry)
        if inter.is_empty:
            continue
        mid = inter.centroid
        d_b = float(np.hypot(mid.x - ox, mid.y - oy))
        if total_dist <= 0:
            continue
        b_ground = sample_point(dtm, dtm_gt, mid.x, mid.y) or 0.0
        b_roof   = b_ground + agl
        ray_b    = obs_abs + (tgt_abs - obs_abs) * (d_b / total_dist)
        if b_roof > ray_b:
            blon, blat = utm_to_wgs84(mid.x, mid.y)
            loss = _rf_attenuation(feat, freq_mhz) if reason_label == "building" else None
            cand = {
                "reason":                reason_label,
                "blocker_id":            str(feat.get("Polygon_ID") or ""),
                "location":              {"lon": round(blon, 7), "lat": round(blat, 7)},
                "distance_to_blocker_m": round(d_b, 2),
                "ray_height_m":          round(ray_b, 2),
                "obstacle_height_m":     round(b_roof, 2),
                "clearance_m":           round(ray_b - b_roof, 2),
            }
            if loss is not None:
                cand["loss_db"] = round(loss, 1)
            if best is None or d_b < best["distance_to_blocker_m"]:
                best = cand
    return best


def compute_los(
    dtm: np.ndarray, dtm_gt: dict,
    dhm: np.ndarray, dhm_gt: dict,
    buildings: VectorLayer | None,
    vegetation: VectorLayer | None,
    request: dict,
) -> dict:
    obs  = request["observer"]
    tgt  = request["target"]
    opts = request.get("options", {})

    spacing  = float(opts.get("sample_spacing_m", 2.0))
    freq_mhz = float(opts["frequency_mhz"]) if opts.get("frequency_mhz") else None
    include_clutter_height = bool(opts.get("include_clutter_height", True))

    # Project to UTM
    ox, oy = wgs84_to_utm(obs["lon"], obs["lat"])
    tx, ty = wgs84_to_utm(tgt["lon"], tgt["lat"])
    total_dist = float(np.hypot(tx - ox, ty - oy))

    if total_dist < 0.1:
        return {"visible": True, "profile": [], "distance_m": 0.0}

    # Absolute elevations for observer and target
    obs_ground = sample_point(dtm, dtm_gt, ox, oy) or 0.0
    tgt_ground = sample_point(dtm, dtm_gt, tx, ty) or 0.0
    obs_abs    = obs_ground + float(obs["height_agl_m"])
    tgt_abs    = tgt_ground + float(tgt["height_agl_m"])

    # Sample points along the line
    n      = max(2, int(total_dist / spacing))
    fracs  = np.linspace(0, 1, n)
    xs     = ox + fracs * (tx - ox)
    ys     = oy + fracs * (ty - oy)
    dists  = fracs * total_dist

    # Pre-build custom obstacle spatial index for fast per-point lookup
    custom_obs_list = opts.get('custom_obstacles', [])
    c_tree, _c_shapes, c_agls = _build_custom_index(custom_obs_list)

    profile:     list[dict] = []
    first_block: dict | None = None

    for x, y, d in zip(xs, ys, dists):
        ground  = sample_point(dtm, dtm_gt, x, y)
        dh      = sample_point(dhm, dhm_gt, x, y) if include_clutter_height else 0.0
        if ground is None:
            ground = 0.0
        surface = ground + max(0.0, dh or 0.0)

        # Raise surface for any custom obstacle covering this point
        if c_tree is not None:
            hits = c_tree.query(ShapelyPoint(x, y), predicate='within')
            if hits.size > 0:
                custom_agl = max(c_agls[h] for h in hits)
                surface = max(surface, ground + custom_agl)

        ray   = obs_abs + (tgt_abs - obs_abs) * (d / total_dist)
        clear = ray - surface
        lon, lat = utm_to_wgs84(x, y)
        profile.append({
            "distance_m":          round(float(d), 2),
            "lon":                 round(lon, 7),
            "lat":                 round(lat, 7),
            "ground_m":            round(ground, 2),
            "obstacle_surface_m":  round(surface, 2),
            "ray_m":               round(ray, 2),
            "clearance_m":         round(float(clear), 2),
        })
        if include_clutter_height and clear < 0 and first_block is None:
            first_block = {
                "reason":                "clutter_height",
                "location":              {"lon": round(lon, 7), "lat": round(lat, 7)},
                "distance_to_blocker_m": round(float(d), 2),
                "ray_height_m":          round(ray, 2),
                "obstacle_height_m":     round(surface, 2),
                "clearance_m":           round(float(clear), 2),
            }

    # Tag each profile point with its obstacle source
    los_line = LineString([(ox, oy), (tx, ty)])
    _tag_surface_types(profile, xs, ys, los_line, buildings, vegetation, opts, custom_obs_list)

    # Vector checks (more precise — can identify named blockers)
    if opts.get("include_buildings", True) and buildings is not None:
        bld_block = _check_vector_layer(
            buildings, los_line, ox, oy, obs_abs, tgt_abs,
            total_dist, dtm, dtm_gt, freq_mhz, "building",
        )
        if bld_block and (first_block is None or
                          bld_block["distance_to_blocker_m"] < first_block["distance_to_blocker_m"]):
            first_block = bld_block

    if opts.get("include_vegetation", True) and vegetation is not None:
        veg_block = _check_vector_layer(
            vegetation, los_line, ox, oy, obs_abs, tgt_abs,
            total_dist, dtm, dtm_gt, None, "vegetation",
        )
        if veg_block and (first_block is None or
                          veg_block["distance_to_blocker_m"] < first_block["distance_to_blocker_m"]):
            first_block = veg_block

    # Custom obstacle named-blocker check
    if custom_obs_list:
        cust_block = _check_custom_obstacles(
            custom_obs_list, los_line, ox, oy, obs_abs, tgt_abs, total_dist, dtm, dtm_gt,
        )
        if cust_block and (first_block is None or
                           cust_block["distance_to_blocker_m"] < first_block["distance_to_blocker_m"]):
            first_block = cust_block

    result: dict = {
        "visible":    first_block is None,
        "distance_m": round(total_dist, 2),
        "profile":    profile,
    }
    if first_block:
        result.update(first_block)
    return result

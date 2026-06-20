"""
Viewshed (radial visibility sweep) from a single observer point.

Algorithm: for each azimuth, cast a ray outward tracking the running maximum
elevation angle seen. A cell is visible if its elevation angle > the horizon
so far. The last visible distance on each ray forms the boundary polygon.

All raster work in EPSG:32629 (UTM Zone 29N). Input/output in WGS84.
"""
from __future__ import annotations

import math
import numpy as np

from .atoll_reader import sample_point
from .crs_service import wgs84_to_utm, utm_to_wgs84


def compute_viewshed(
    dtm: np.ndarray,
    dtm_gt: dict,
    dhm: np.ndarray,
    dhm_gt: dict,
    observer_lon: float,
    observer_lat: float,
    observer_agl_m: float,
    max_radius_m: float = 2000.0,
    az_step_deg: float = 2.0,
    r_step_m: float = 5.0,
    include_clutter: bool = True,
) -> dict:
    """
    Returns a GeoJSON Feature with a Polygon geometry covering the visible area.
    """
    ox, oy = wgs84_to_utm(observer_lon, observer_lat)

    obs_ground = sample_point(dtm, dtm_gt, ox, oy) or 0.0
    obs_abs = obs_ground + observer_agl_m

    azimuths = np.arange(0.0, 360.0, az_step_deg)
    n_az = len(azimuths)

    # Collect the boundary point for each azimuth ray
    boundary_lon: list[float] = []
    boundary_lat: list[float] = []

    radii = np.arange(r_step_m, max_radius_m + r_step_m, r_step_m)

    for az_deg in azimuths:
        az_rad = math.radians(az_deg)
        sin_az = math.sin(az_rad)
        cos_az = math.cos(az_rad)

        max_slope = -1e9          # running maximum (surface - obs_abs) / dist
        last_visible_d = r_step_m

        for d in radii:
            px = ox + d * sin_az
            py = oy + d * cos_az

            ground = sample_point(dtm, dtm_gt, px, py)
            if ground is None:
                break           # left the raster extent

            if include_clutter:
                dh = sample_point(dhm, dhm_gt, px, py) or 0.0
                surface = ground + max(0.0, dh)
            else:
                surface = ground

            slope = (surface - obs_abs) / d

            if slope > max_slope:
                max_slope = slope
                last_visible_d = d

        # Boundary point at last_visible_d on this ray
        bx = ox + last_visible_d * sin_az
        by = oy + last_visible_d * cos_az
        lon, lat = utm_to_wgs84(bx, by)
        boundary_lon.append(lon)
        boundary_lat.append(lat)

    # Close the polygon ring
    if boundary_lon:
        boundary_lon.append(boundary_lon[0])
        boundary_lat.append(boundary_lat[0])

    coordinates = [[lon, lat] for lon, lat in zip(boundary_lon, boundary_lat)]

    return {
        "type": "Feature",
        "geometry": {
            "type": "Polygon",
            "coordinates": [coordinates],
        },
        "properties": {
            "obs_lon":      observer_lon,
            "obs_lat":      observer_lat,
            "obs_agl_m":    observer_agl_m,
            "max_radius_m": max_radius_m,
            "az_step_deg":  az_step_deg,
            "r_step_m":     r_step_m,
            "n_rays":       n_az,
        },
    }

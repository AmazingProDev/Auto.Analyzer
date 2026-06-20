"""WGS84 ↔ UTM Zone 29N (EPSG:32629) coordinate transforms."""
from __future__ import annotations
from pyproj import Transformer

_to_utm   = Transformer.from_crs("EPSG:4326", "EPSG:32629", always_xy=True)
_to_wgs84 = Transformer.from_crs("EPSG:32629", "EPSG:4326", always_xy=True)


def wgs84_to_utm(lon: float, lat: float) -> tuple[float, float]:
    return _to_utm.transform(lon, lat)


def utm_to_wgs84(easting: float, northing: float) -> tuple[float, float]:
    return _to_wgs84.transform(easting, northing)


def utm_extent_to_wgs84(min_east: float, max_east: float, min_north: float, max_north: float) -> dict:
    min_lon, min_lat = utm_to_wgs84(min_east, min_north)
    max_lon, max_lat = utm_to_wgs84(max_east, max_north)
    return {"min_lon": round(min_lon, 6), "min_lat": round(min_lat, 6),
            "max_lon": round(max_lon, 6), "max_lat": round(max_lat, 6)}

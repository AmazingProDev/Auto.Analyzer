from __future__ import annotations
from typing import Optional
from pydantic import BaseModel


class LayerExtent(BaseModel):
    min_east:  float
    max_east:  float
    min_north: float
    max_north: float
    min_lon:   float
    max_lon:   float
    min_lat:   float
    max_lat:   float


class LayerInfo(BaseModel):
    id:           str
    type:         str           # "raster" | "vector"
    role:         str
    available:    bool
    crs:          Optional[str] = None
    resolution_m: Optional[int] = None
    nodata:       Optional[int] = None
    feature_count: Optional[int] = None
    height_field: Optional[str] = None
    rf_attenuation_bands: Optional[list[str]] = None
    clutter_classes: Optional[int] = None
    extent:       Optional[LayerExtent] = None

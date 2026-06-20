from __future__ import annotations
from typing import Optional
from pydantic import BaseModel, Field


class PointAGL(BaseModel):
    lon: float = Field(..., description="Longitude WGS84")
    lat: float = Field(..., description="Latitude WGS84")
    height_agl_m: float = Field(default=1.5, description="Height above ground level in metres")


class CustomObstacle(BaseModel):
    geometry:   dict = {}   # GeoJSON Polygon geometry (WGS84)
    properties: dict = {}   # {name, obstacle_type, height_agl_m}


class LosOptions(BaseModel):
    include_terrain:       bool  = True
    include_clutter_height: bool = True
    include_buildings:     bool  = True
    include_vegetation:    bool  = True
    sample_spacing_m:      float = Field(default=2.0, ge=0.5, le=50.0)
    frequency_mhz:         Optional[float] = None
    custom_obstacles:      list[CustomObstacle] = []


class LosRequest(BaseModel):
    observer: PointAGL
    target:   PointAGL
    options:  LosOptions = LosOptions()


class Location(BaseModel):
    lon: float
    lat: float


class ProfilePoint(BaseModel):
    distance_m:         float
    lon:                float
    lat:                float
    ground_m:           float
    obstacle_surface_m: float
    ray_m:              float
    clearance_m:        float
    surface_type:       str = 'clutter'   # 'building' | 'vegetation' | 'clutter'


class ViewshedRequest(BaseModel):
    observer:       PointAGL
    max_radius_m:   float = Field(default=1000.0, ge=100.0, le=10000.0)
    az_step_deg:    float = Field(default=2.0,    ge=0.5,   le=10.0)
    r_step_m:       float = Field(default=5.0,    ge=1.0,   le=20.0)
    include_clutter: bool = True


class LosResponse(BaseModel):
    visible:                bool
    distance_m:             float
    reason:                 Optional[str] = None
    blocker_id:             Optional[str] = None
    location:               Optional[Location] = None
    distance_to_blocker_m:  Optional[float] = None
    ray_height_m:           Optional[float] = None
    obstacle_height_m:      Optional[float] = None
    clearance_m:            Optional[float] = None
    loss_db:                Optional[float] = None
    profile:                list[ProfilePoint] = []

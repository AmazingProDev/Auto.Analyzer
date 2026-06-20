"""
Vector layer loader: reads FlatGeobuf or TAB files into GeoDataFrames
and builds a Shapely STRtree for fast spatial queries.

Both buildings and vegetation are loaded once at app startup and cached.
All geometries are in EPSG:32629 (UTM Zone 29N, metres).
"""
from __future__ import annotations

import geopandas as gpd
from pathlib import Path
from shapely.strtree import STRtree


class VectorLayer:
    def __init__(self, path: Path, name: str):
        self.name = name
        self.gdf: gpd.GeoDataFrame = gpd.read_file(str(path))
        if self.gdf.crs is None or self.gdf.crs.to_epsg() != 32629:
            self.gdf = self.gdf.to_crs(epsg=32629)
        self.tree: STRtree = STRtree(self.gdf.geometry.values)
        print(f"[LOS] {name}: {len(self.gdf)} features loaded, STRtree built")

    def query_line(self, line_geom) -> gpd.GeoDataFrame:
        idxs = self.tree.query(line_geom, predicate="intersects")
        return self.gdf.iloc[idxs]


_buildings:  VectorLayer | None = None
_vegetation: VectorLayer | None = None


def load_vectors(buildings_path: Path | None, vegetation_path: Path | None) -> None:
    global _buildings, _vegetation
    _buildings = VectorLayer(buildings_path, "buildings") if buildings_path and Path(buildings_path).exists() else None
    _vegetation = VectorLayer(vegetation_path, "vegetation") if vegetation_path and Path(vegetation_path).exists() else None


def clear_vectors() -> None:
    global _buildings, _vegetation
    _buildings = None
    _vegetation = None


def get_buildings()  -> VectorLayer | None: return _buildings
def get_vegetation() -> VectorLayer | None: return _vegetation

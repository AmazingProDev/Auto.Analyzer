"""
Global in-memory raster state loaded once at startup.
Kept separate from config so routers can import without circular deps.
"""
from __future__ import annotations
import numpy as np
from pathlib import Path

dtm:    np.ndarray | None = None
dtm_gt: dict | None       = None
dhm:    np.ndarray | None = None
dhm_gt: dict | None       = None
active_atoll_root: Path | None = None
active_data_root: Path | None = None
active_dataset_summary: dict = {}

#!/usr/bin/env python3
"""
One-time conversion: ATOLL binary grids → GeoTIFF.

Usage:
  python3 scripts/convert_atoll_rasters.py
  python3 scripts/convert_atoll_rasters.py --data-root /path/to/ATOLL --out-dir /path/to/processed

After this, run gdal_translate -of COG ... to produce COG versions for tile serving.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

# Allow running from the scripts/ dir
sys.path.insert(0, str(Path(__file__).parents[1]))

from app.services.atoll_reader import load_atoll_raster, atoll_to_geotiff


LAYERS = [
    ("DTM",            "dtm.tif"),
    ("Clutter Height", "dhm.tif"),
    ("Clutter",        "clutter.tif"),
]

DEFAULT_ATOLL_ROOT = "/Users/abdelilah/Downloads/GeoData_Kenitra/Kenitra_AFZ_Mehdia_cp1m_ATOLL"
DEFAULT_OUT_DIR    = "/Users/abdelilah/Downloads/GeoData_Kenitra/processed"


def main():
    ap = argparse.ArgumentParser(description="Convert ATOLL binary rasters to GeoTIFF")
    ap.add_argument("--data-root", default=DEFAULT_ATOLL_ROOT)
    ap.add_argument("--out-dir",   default=DEFAULT_OUT_DIR)
    ap.add_argument("--validate",  action="store_true", help="Sample a few points after conversion")
    args = ap.parse_args()

    root = Path(args.data_root)
    out  = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)

    for folder, fname in LAYERS:
        src_dir = root / folder
        if not src_dir.exists():
            print(f"  SKIP  {folder}/ — directory not found at {src_dir}")
            continue
        out_path = out / fname
        print(f"Converting {folder} → {out_path} …", flush=True)
        atoll_to_geotiff(src_dir, out_path)
        size_mb = out_path.stat().st_size / 1024 / 1024
        print(f"  ✓  {out_path.name}  ({size_mb:.1f} MB)")

    if args.validate:
        print("\nValidating DTM values at Kenitra city centre (E≈722000, N≈3793000) …")
        from app.services.atoll_reader import load_atoll_raster, sample_point
        dtm, gt = load_atoll_raster(root / "DTM")
        # Kenitra city centre approximate UTM 29N
        test_points = [
            ("Kenitra centre",        722000.0, 3793000.0, (0,  80)),
            ("Atlantic coast edge",   713500.0, 3793000.0, (-1, 10)),  # may be NoData
            ("Inland area (N)",       722000.0, 3798000.0, (10, 200)),
        ]
        for name, e, n, (lo, hi) in test_points:
            val = sample_point(dtm, gt, e, n)
            status = "✓" if val is not None and lo <= val <= hi else "?"
            print(f"  {status}  {name}: DTM={val}")

    print("\nDone. Next steps:")
    print("  1. Run: gdal_translate -of COG -co COMPRESS=DEFLATE processed/dtm.tif processed/dtm_cog.tif")
    print("  2. Run: gdal_translate -of COG -co COMPRESS=DEFLATE processed/dhm.tif processed/dhm_cog.tif")
    print("  3. Run: scripts/preprocess_vectors.sh (or the ogr2ogr commands in the plan)")


if __name__ == "__main__":
    main()

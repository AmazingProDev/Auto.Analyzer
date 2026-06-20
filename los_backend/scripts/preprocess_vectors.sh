#!/usr/bin/env bash
# Convert MapInfo TAB vector layers to FlatGeobuf (for backend) and GeoJSON (for browser).
# Run from the los_backend/ directory.

set -e

ATOLL_ROOT="/Users/abdelilah/Downloads/GeoData_Kenitra/Kenitra_AFZ_Mehdia_cp1m_ATOLL"
OUT="/Users/abdelilah/Downloads/GeoData_Kenitra/processed"
OGR="/opt/homebrew/bin/ogr2ogr"

mkdir -p "$OUT"

echo "==> Buildings (FlatGeobuf, EPSG:32629)"
"$OGR" -f FlatGeobuf -t_srs EPSG:32629 -overwrite \
  "$OUT/buildings.fgb" \
  "$ATOLL_ROOT/3D vectors/Kenitra_AFZ_Mehdia_BUILDING_0.tab"

echo "==> Buildings (GeoJSON, WGS84)"
"$OGR" -f GeoJSON -t_srs EPSG:4326 \
  "$OUT/buildings.geojson" \
  "$ATOLL_ROOT/3D vectors/Kenitra_AFZ_Mehdia_BUILDING_0.tab"

echo "==> Vegetation (FlatGeobuf, EPSG:32629)"
"$OGR" -f FlatGeobuf -t_srs EPSG:32629 -overwrite -skipfailures \
  "$OUT/vegetation.fgb" \
  "$ATOLL_ROOT/3D vectors/Kenitra_AFZ_Mehdia_VEGETATION_1.tab"

echo "==> Vegetation (GeoJSON, WGS84)"
"$OGR" -f GeoJSON -t_srs EPSG:4326 -skipfailures \
  "$OUT/vegetation.geojson" \
  "$ATOLL_ROOT/3D vectors/Kenitra_AFZ_Mehdia_VEGETATION_1.tab"

echo "==> Bridges (FlatGeobuf)"
"$OGR" -f FlatGeobuf -t_srs EPSG:32629 -overwrite \
  "$OUT/bridges.fgb" \
  "$ATOLL_ROOT/3D vectors/Kenitra_AFZ_Mehdia_BRIDGE_2.tab"

echo "==> 2D vectors (GeoJSON)"
for LAYER_FILE in \
  "Kenitra_AFZ_Mehdia_MAIN_ROAD_0.tab:main_road" \
  "Kenitra_AFZ_Mehdia_SECONDARY_ROAD_1.tab:secondary_road" \
  "Kenitra_AFZ_Mehdia_STREET_2.tab:street" \
  "Kenitra_AFZ_Mehdia_INLAND_WATER_3.tab:inland_water" \
  "Kenitra_AFZ_Mehdia_SINGLE_RIVER_4.tab:single_river" \
  "Kenitra_AFZ_Mehdia_RAILWAY_5.tab:railway"; do
  TAB="${LAYER_FILE%%:*}"
  NAME="${LAYER_FILE##*:}"
  SRC="$ATOLL_ROOT/2D vectors/$TAB"
  if [ -f "$SRC" ]; then
    echo "  $NAME"
    "$OGR" -f GeoJSON -t_srs EPSG:4326 "$OUT/${NAME}.geojson" "$SRC"
  else
    echo "  SKIP $TAB (not found)"
  fi
done

echo ""
echo "Done. Files in: $OUT"
ls -lh "$OUT"/*.fgb "$OUT"/*.geojson 2>/dev/null || true

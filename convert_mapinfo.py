import os
import sys
import geopandas as gpd
from pathlib import Path

def convert_tab_to_shp(input_folder):
    """
    Converts all MapInfo .tab files in the input_folder to Shapefiles.
    Output shapefiles are saved in a 'converted_shp' subfolder.
    """
    input_path = Path(input_folder)
    
    if not input_path.exists():
        print(f"Error: Folder '{input_folder}' not found.")
        return

    # Create output directory
    output_path = input_path / "converted_shp"
    output_path.mkdir(exist_ok=True)

    print(f"Scanning '{input_folder}' for .tab files...")
    
    tab_files = list(input_path.glob("*.tab"))
    
    if not tab_files:
        print("No .tab files found.")
        return

    count = 0
    for tab_file in tab_files:
        try:
            print(f"Converting: {tab_file.name}...")
            
            # Read MapInfo file
            # Geopandas uses OGR (GDAL) which supports MapInfo TAB
            gdf = gpd.read_file(tab_file)
            
            # Determine Output Filename
            output_file = output_path / f"{tab_file.stem}_grid.shp"
            
            # Reproject to UTM Zone 29N (Morocco) for accurate meter buffering
            # If the user is elsewhere, they might need to change this EPSG
            target_crs = "EPSG:32629" # UTM 29N
            
            if gdf.crs is None:
                print("    - Warning: source has no CRS, assuming WGS84")
                gdf.set_crs(epsg=4326, inplace=True)
                
            gdf_pk = gdf.to_crs(target_crs)
            
            # Create 50m Grid (Square Polygons)
            # 50m side -> 25m radius/buffer from center
            print("    - Creating 50m coverage squares...")
            gdf_pk['geometry'] = gdf_pk.geometry.buffer(25, cap_style=3).envelope
            
            # Reproject back to WGS84 for broad compatibility
            # (or keep in UTM if you prefer, but WGS84 is safest for web)
            gdf_final = gdf_pk.to_crs(epsg=4326)
            
            # Save as Shapefile
            gdf_final.to_file(output_file, driver='ESRI Shapefile')
            
            print(f"  -> Saved 50m Grid to: {output_file.name}")
            count += 1
            
        except Exception as e:
            print(f"  X Failed to convert {tab_file.name}: {e}")

    print(f"\nconversion complete! {count}/{len(tab_files)} files converted.")
    print(f"Output folder: {output_path.absolute()}")
    print("\nYou can now drag and drop these .shp (plus .shx, .dbf, .prj) files into Optim Analyzer Pro.")

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python convert_mapinfo.py <folder_path>")
        print("Example: python convert_mapinfo.py ./my_map_data")
    else:
        convert_tab_to_shp(sys.argv[1])

import sys
import os
import json
import pandas as pd
from trp_importer import import_trp_file, _RUNS

def main():
    if len(sys.argv) < 2:
        print("Usage: python parse_trp_dump.py <path_to_trp>")
        return
        
    trp_path = sys.argv[1]
    print(f"Parsing {trp_path}...")
    
    # Import
    res = import_trp_file(trp_path)
    run_id = res['runId']
    
    run_data = _RUNS[run_id]
    
    out_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "outputs", "parsed_" + os.path.basename(trp_path).replace(".trp", ""))
    os.makedirs(out_dir, exist_ok=True)
    
    print(f"Saving to {out_dir}...")
    
    events = run_data.get("events", [])
    if events:
        pd.DataFrame(events).to_csv(os.path.join(out_dir, "events.csv"), index=False)
        print(f"Saved {len(events)} events.")
        
    track_points = run_data.get("track_points", [])
    if track_points:
        pd.DataFrame(track_points).to_csv(os.path.join(out_dir, "track.csv"), index=False)
        print(f"Saved {len(track_points)} track points.")
        
    # kpi_samples is huge, maybe just save as JSON or CSV?
    kpi_samples = run_data.get("kpi_samples", [])
    if kpi_samples:
        pd.DataFrame(kpi_samples).to_csv(os.path.join(out_dir, "kpi_samples.csv"), index=False)
        print(f"Saved {len(kpi_samples)} KPI samples.")
        
    # Also save run_dict
    run_info = run_data.get("run_dict", {})
    with open(os.path.join(out_dir, "run_info.json"), "w") as f:
        json.dump(run_info, f, indent=2)
        
    print(f"Finished. Data saved in {out_dir}")

if __name__ == '__main__':
    main()

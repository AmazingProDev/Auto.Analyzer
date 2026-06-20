import pandas as pd
import os

def flatten_ss_metric(file_in, file_out, metric_col):
    if not os.path.exists(file_in):
        print(f"Error: Could not find input file at {file_in}")
        return

    print(f"\n--- Loading dataset for metric {metric_col}... ---")
    df = pd.read_excel(file_in)

    print(f"Original Data Rows: {len(df)}")
    
    # Sort rigorously by Time and Metric (descending) so highest signal is always N1
    df = df.sort_values(by=['Time', metric_col], ascending=[True, False])

    # Identify Serving cell Base rows
    df['is_serving'] = df['Cell type'] == 'SCG PSCell'
    
    # Grab uniquely highest serving row per Time
    serving_df = df[df['is_serving']].drop_duplicates(subset=['Time'], keep='first')

    serving_rename = {
        'NR-ARFCN': 'Serving NR-ARFCN',
        'PCI': 'Serving NR PCI',
        'BI': 'Serving BI',
        'Band': 'Serving Band',
        'Band (MHz)': 'Serving Band (MHz)',
        'NR PCI Beam index': 'Serving NR PCI Beam index',
        'NR ARFCN PCI Beam index': 'Serving NR ARFCN PCI Beam index',
        'NR ARFCN PCI': 'Serving NR ARFCN PCI',
        'Cell type': 'Serving NR Cell type',
        metric_col: f'Serving NR {metric_col}'
    }
    
    # some columns might be missing in certain datasets safely ignore missing:
    serving_rename_safe = {k: v for k, v in serving_rename.items() if k in serving_df.columns}
    
    serving_df = serving_df.rename(columns=serving_rename_safe).drop(columns=['is_serving'])

    # All remaining records after extracting exactly one serving row are Neighbors
    nbr_df = df.drop(serving_df.index)

    # dynamically rank neighbors strictly by their sequence
    nbr_df['nbr_rank'] = nbr_df.groupby('Time').cumcount() + 1
    
    max_nbrs = nbr_df['nbr_rank'].max() if not nbr_df.empty else 0
    print(f"Maximum Neighbors dynamically identified per timestamp: {max_nbrs}")

    neighbor_cols_map = {
        'Cell type': 'NR Cell type',
        metric_col: f'NR {metric_col}',
        'BT': 'BT',
        'PCI': 'NR PCI',
        'BI': 'NR BI',
        'NR-ARFCN': 'NR ARFCN',
        'Band': 'NR Band'
    }

    # Only keep columns that actually exist inside df
    valid_neighbor_cols_map = {k: v for k, v in neighbor_cols_map.items() if k in nbr_df.columns}
    cols_to_keep = ['Time', 'nbr_rank'] + list(valid_neighbor_cols_map.keys())
    
    nbr_subset = nbr_df[cols_to_keep].rename(columns=valid_neighbor_cols_map)

    # Pivot Data
    print("Pivoting Neighbor rows to Wide format...")
    if max_nbrs > 0:
        pivot_df = nbr_subset.pivot(index='Time', columns='nbr_rank')
        pivot_df.columns = [f"{col_name} N{rank}" for col_name, rank in pivot_df.columns]
        pivot_df = pivot_df.reset_index()

        ordered_neighbor_cols = []
        for i in range(1, max_nbrs + 1):
            for col_name in valid_neighbor_cols_map.values():
                col_formatted = f"{col_name} N{i}"
                if col_formatted in pivot_df.columns:
                    ordered_neighbor_cols.append(col_formatted)

        pivot_df = pivot_df[['Time'] + ordered_neighbor_cols]
    else:
        pivot_df = pd.DataFrame(columns=['Time'])
        ordered_neighbor_cols = []

    # Re-merge Base Serving and Neighbors 
    print("Merging columns into Unified Wide Matrix...")
    final_wide = pd.merge(serving_df, pivot_df, on='Time', how='outer')

    print("Enriching with LTE Serving parameters...")
    file_lte = r'D:\Projects\Advanced 5G analysis\LTE serving RSRP + CellID_updated.xlsx'
    if os.path.exists(file_lte):
        df_lte = pd.read_excel(file_lte)
        
        lte_rename = {
            'Lon.': 'Lon',
            'Lat.': 'Lat',
            'Cell ID': 'LTE Cell ID',
            'PCI': 'LTE PCI',
            'Ch': 'LTE Ch',
            'Band (MHz)': 'LTE Band (MHz)'
        }
        
        valid_lte_cols = ['Time'] + [c for c in lte_rename.keys() if c in df_lte.columns]
        df_lte_sub = df_lte[valid_lte_cols].rename(columns=lte_rename)
        
        # Exact merge across matched timestamps safely
        final_wide = pd.merge(final_wide, df_lte_sub, on='Time', how='left')

    # Define exact ordering for consistency
    serving_ordered_cols = [
        'Time', 
        'Lon', 'Lat', 'LTE Cell ID', 'LTE PCI', 'LTE Ch', 'LTE Band (MHz)',
        'Serving NR-ARFCN', 'Serving NR PCI', 'Serving BI', 'BT', 'Serving Band', 'Serving Band (MHz)', 
        'Serving NR PCI Beam index', 'Serving NR ARFCN PCI Beam index', 'Serving NR ARFCN PCI', '_oid', 
        'Serving NR Cell type', f'Serving NR {metric_col}'
    ]
    
    final_ordered_cols = serving_ordered_cols + ordered_neighbor_cols
    valid_ordered_cols = [col for col in final_ordered_cols if col in final_wide.columns]
    
    # add any columns that weren't inside the `ordered_cols` array (just in case)
    missing_cols = [c for c in final_wide.columns if c not in valid_ordered_cols]
    final_wide = final_wide[valid_ordered_cols + missing_cols]

    print(f"Flattening generated {len(final_wide)} unique Time rows.")
    print(f"Saving explicitly to: {file_out}")
    final_wide.to_excel(file_out, index=False)
    print("Optimization Complete.")

def main():
    root_path = r'D:\Projects\Advanced 5G analysis'
    
    files = [
        (rf"{root_path}\SS RSRQ - SCG PSCell - Listed or Detected cells.xlsx", rf"{root_path}\SS RSRQ - SCG PSCell - Listed or Detected cells_flattened.xlsx", 'RSRQ'),
        (rf"{root_path}\SS SINR - SCG PSCell - Listed or Detected cells.xlsx", rf"{root_path}\SS SINR - SCG PSCell - Listed or Detected cells_flattened.xlsx", 'SINR')
    ]
    
    for f_in, f_out, metric in files:
        flatten_ss_metric(f_in, f_out, metric)

if __name__ == '__main__':
    main()

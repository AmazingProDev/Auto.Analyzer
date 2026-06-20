import pandas as pd
import numpy as np
import os

def generate_base_lte_serving(input_file, output_file):
    if not os.path.exists(input_file):
        print(f"Error: Could not find input file at {input_file}")
        return False

    print("\n[STEP 1] Generating base LTE Serving Cell ID mappings...")
    df = pd.read_excel(input_file)
    
    serving_mask = df['Cell type'] == 'Serving'
    
    time_cell_map = df.dropna(subset=['Cell ID']).groupby('Time')['Cell ID'].first()
    mask_to_fill_pass1 = serving_mask & df['Cell ID'].isna()
    df.loc[mask_to_fill_pass1, 'Cell ID'] = df.loc[mask_to_fill_pass1, 'Time'].map(time_cell_map)
    
    s_df = df[serving_mask].copy()
    s_df['pci_block'] = (s_df['PCI'] != s_df['PCI'].shift(1)).cumsum()
    s_df['Cell ID'] = s_df.groupby('pci_block')['Cell ID'].bfill().ffill()
    df.loc[serving_mask, 'Cell ID'] = s_df['Cell ID']
    
    df[serving_mask].to_excel(output_file, index=False)
    print(f"Saved strictly 'Serving' fields to: {output_file}")
    return True

def generate_ss_metrics_flattened(file_in, file_out, file_lte, metric_col):
    if not os.path.exists(file_in):
        print(f"Error: Could not find input file at {file_in}")
        return

    print(f"\n[STEP 3] Flattening SS Metric Dataset for: {metric_col}...")
    df = pd.read_excel(file_in)
    df = df.sort_values(by=['Time', metric_col], ascending=[True, False])

    df['is_serving'] = df['Cell type'] == 'SCG PSCell'
    serving_df = df[df['is_serving']].drop_duplicates(subset=['Time'], keep='first')

    serving_rename = {
        'NR-ARFCN': 'Serving NR-ARFCN', 'PCI': 'Serving NR PCI', 'BI': 'Serving BI', 'Band': 'Serving Band',
        'Band (MHz)': 'Serving Band (MHz)', 'NR PCI Beam index': 'Serving NR PCI Beam index',
        'NR ARFCN PCI Beam index': 'Serving NR ARFCN PCI Beam index', 'NR ARFCN PCI': 'Serving NR ARFCN PCI',
        'Cell type': 'Serving NR Cell type', metric_col: f'Serving NR {metric_col}'
    }
    serving_rename_safe = {k: v for k, v in serving_rename.items() if k in serving_df.columns}
    serving_df = serving_df.rename(columns=serving_rename_safe).drop(columns=['is_serving'])

    nbr_df = df.drop(serving_df.index)
    nbr_df['nbr_rank'] = nbr_df.groupby('Time').cumcount() + 1
    max_nbrs = nbr_df['nbr_rank'].max() if not nbr_df.empty else 0

    neighbor_cols_map = {
        'Cell type': 'NR Cell type', metric_col: f'NR {metric_col}', 'BT': 'BT',
        'PCI': 'NR PCI', 'BI': 'NR BI', 'NR-ARFCN': 'NR ARFCN', 'Band': 'NR Band'
    }
    valid_neighbor_cols_map = {k: v for k, v in neighbor_cols_map.items() if k in nbr_df.columns}
    cols_to_keep = ['Time', 'nbr_rank'] + list(valid_neighbor_cols_map.keys())
    nbr_subset = nbr_df[cols_to_keep].rename(columns=valid_neighbor_cols_map)

    if max_nbrs > 0:
        pivot_df = nbr_subset.pivot(index='Time', columns='nbr_rank')
        pivot_df.columns = [f"{col_name} N{rank}" for col_name, rank in pivot_df.columns]
        pivot_df = pivot_df.reset_index()
        ordered_neighbor_cols = [f"{col} N{i}" for i in range(1, max_nbrs + 1) for col in valid_neighbor_cols_map.values() if f"{col} N{i}" in pivot_df.columns]
        pivot_df = pivot_df[['Time'] + ordered_neighbor_cols]
    else:
        pivot_df = pd.DataFrame(columns=['Time'])
        ordered_neighbor_cols = []

    final_wide = pd.merge(serving_df, pivot_df, on='Time', how='outer')

    if os.path.exists(file_lte):
        df_lte = pd.read_excel(file_lte)
        lte_rename = {'Lon.': 'Lon', 'Lat.': 'Lat', 'Cell ID': 'LTE Cell ID', 'PCI': 'LTE PCI', 'Ch': 'LTE Ch', 'Band (MHz)': 'LTE Band (MHz)'}
        valid_lte_cols = ['Time'] + [c for c in lte_rename.keys() if c in df_lte.columns]
        df_lte_sub = df_lte[valid_lte_cols].rename(columns=lte_rename)
        final_wide = pd.merge(final_wide, df_lte_sub, on='Time', how='left')

    serving_ordered_cols = [
        'Time', 'Lon', 'Lat', 'LTE Cell ID', 'LTE PCI', 'LTE Ch', 'LTE Band (MHz)',
        'Serving NR-ARFCN', 'Serving NR PCI', 'Serving BI', 'BT', 'Serving Band', 'Serving Band (MHz)', 
        'Serving NR PCI Beam index', 'Serving NR ARFCN PCI Beam index', 'Serving NR ARFCN PCI', '_oid', 
        'Serving NR Cell type', f'Serving NR {metric_col}'
    ]
    
    valid_ordered_cols = [col for col in serving_ordered_cols + ordered_neighbor_cols if col in final_wide.columns]
    missing_cols = [c for c in final_wide.columns if c not in valid_ordered_cols]
    final_wide[valid_ordered_cols + missing_cols].to_excel(file_out, index=False)
    print(f"Flattening SS Metric completed -> {file_out}")

def main():
    base_dir = r'D:\Projects\Advanced 5G analysis'
    
    # 1. Base files
    lte_base_in = rf"{base_dir}\LTE serving RSRP + CellID.xlsx"
    lte_base_out = rf"{base_dir}\LTE serving RSRP + CellID_updated.xlsx"
    
    # 2. SS Metric files natively bundled directly alongside
    ss_metrics = [
        (rf"{base_dir}\SS SINR - SCG PSCell - Listed or Detected cells.xlsx", rf"{base_dir}\SS SINR - SCG PSCell - Listed or Detected cells_flattened.xlsx", 'SINR'),
        (rf"{base_dir}\SS RSRP - SCG PSCell - Listed or Detected cells.xlsx", rf"{base_dir}\SS RSRP - SCG PSCell - Listed or Detected cells_flattened.xlsx", 'RSRP'),
        (rf"{base_dir}\SS RSRQ - SCG PSCell - Listed or Detected cells.xlsx", rf"{base_dir}\SS RSRQ - SCG PSCell - Listed or Detected cells_flattened.xlsx", 'RSRQ')
    ]
    
    print("====================================")
    print("STARTING FULL END-TO-END AUTOMATION")
    print("====================================")
    
    if generate_base_lte_serving(lte_base_in, lte_base_out):
        for f_in, f_out, metric in ss_metrics:
            generate_ss_metrics_flattened(f_in, f_out, lte_base_out, metric)
            
    print("\nALL PROCESSES COMPLETED SECURELY.")

if __name__ == '__main__':
    main()

import pandas as pd
import numpy as np
import os

def rename_col(ctype, rank, col):
    if col in ['Time', 'Measurement Title']:
        return None
        
    if ctype == 'LTE Serving' and rank == 1:
        if col == 'Cell ID': return 'Serving Cell ID'
        if col == 'Cell type': return 'Cell type'
        if col == 'Lon.': return 'Lon.'
        if col == 'Lat.': return 'Lat.'
        if 'LTE' in col: return col.replace('LTE', 'Serving LTE')
        return f"Serving {col}"
        
    elif 'SCell' in ctype and 'NR' not in ctype and rank == 1:
        if 'LTE' in col: return col.replace('LTE', ctype)
        if col == 'Cell type': return None 
        if col == 'Band (MHz)':
            try:
                scell_num = ctype.split()[-1]
                return f"Band Scell {scell_num} (MHz)"
            except:
                return f"{ctype} Band (MHz)"
        if col in ['Cell ID', 'Lon.', 'Lat.', 'System']: return None 
        return f"{ctype} {col}"
        
    elif ctype == 'NR SCG PSCell' and rank == 1:
        if col == 'Cell type': return 'NR Cell type'
        if col == 'Band': return 'NR Band'
        if 'NR ' in col: return col
        if col in ['Beam index', 'Beam type', 'Numerology', 'Bandwidth in PRBs', 'BWP type', 'BWP ID']:
            return col
        if col in ['Cell ID', 'Lon.', 'Lat.', 'System', 'LTE channel number', 'LTE PCI', 'LTE BW']: return None
        return f"NR {col}"
        
    else:
        if col in ['Cell ID', 'Lon.', 'Lat.', 'System', 'Cell type']: return None 
        base = f"{ctype} {rank}"
        if 'LTE' in ctype and 'LTE ' in col:
            col = col.replace('LTE ', '')
        elif 'NR' in ctype and 'NR ' in col:
            col = col.replace('NR ', '')
        return f"{base} {col}"

def flatten_cells(file_in, file_map_in, file_out):
    print(f"Loading {file_in}...")
    df = pd.read_excel(file_in)
    
    pre_shape = df.shape
    df.drop_duplicates(inplace=True)
    print(f"Duplicates cleaned. Rows dropped: {pre_shape[0] - df.shape[0]}")
    
    print(f"Loading Cell ID mapping from {file_map_in}...")
    df_map = pd.read_excel(file_map_in)
    df_map_lte = df_map.dropna(subset=['Time', 'PCI', 'Cell ID']).sort_values('Time')
    
    if 'Cell ID' not in df.columns:
        col_idx = df.columns.get_loc('Cell type') + 1
        df.insert(col_idx, 'Cell ID', [np.nan]*len(df))
        
    mask_df2 = df['Cell type'] == 'LTE Serving'
    df_lte = df[mask_df2].sort_values('Time')
    
    # Standardize data types for merge keys to prevent pandas MergeError
    df_lte['LTE PCI'] = df_lte['LTE PCI'].astype(float)
    df_map_lte['PCI'] = df_map_lte['PCI'].astype(float)
    
    print("Executing Nearest Time Merge for Cell IDs...")
    merged_asof = pd.merge_asof(
        df_lte.drop(columns=['Cell ID'], errors='ignore'), 
        df_map_lte[['Time', 'PCI', 'Cell ID']], 
        on='Time', 
        left_by='LTE PCI', 
        right_by='PCI', 
        direction='nearest', 
        tolerance=pd.Timedelta('2s')
    )
    
    pci_map = df_map_lte.groupby('PCI')['Cell ID'].first()
    merged_asof['Cell ID'] = merged_asof['Cell ID'].fillna(merged_asof['LTE PCI'].map(pci_map))
    
    df_lte['Cell ID'] = merged_asof['Cell ID'].values
    df.loc[df_lte.index, 'Cell ID'] = df_lte['Cell ID']
    
    df = df.sort_values(by=['Time', 'Cell type', 'LTE PCI', 'NR PCI'], na_position='last')
    df['rank'] = df.groupby(['Time', 'Cell type']).cumcount() + 1
    
    print("Melt and pivot the dataset logically...")
    cols_to_pivot = [c for c in df.columns if c not in ['Time', 'Cell type', 'rank']]
    
    melted = df.melt(id_vars=['Time', 'Cell type', 'rank'], value_vars=cols_to_pivot, var_name='original_col', value_name='val')
    melted = melted.dropna(subset=['val'])
    
    melted['new_col'] = melted.apply(lambda r: rename_col(r['Cell type'], r['rank'], r['original_col']), axis=1)
    melted = melted.dropna(subset=['new_col'])
    
    wide = melted.pivot_table(index='Time', columns='new_col', values='val', aggfunc='first')
    wide.reset_index(inplace=True)
    
    user_ordered_cols = [
        'Time', 'Cell type', 'Serving Cell ID', 'Serving LTE channel number', 'Serving LTE PCI', 'Serving LTE BW',
        'LTE SCell 1 channel number', 'LTE SCell 1 PCI', 'LTE SCell 1 BW', 'Band Scell 1 (MHz)',
        'NR Cell type', 'NR PCI', 'Beam index', 'Beam type', 'NR channel number', 'NR Band', 
        'NR BWP channel number', 'BWP type', 'BWP ID', 'Numerology', 'Bandwidth in PRBs',
        'Lon.', 'Lat.'
    ]
    
    valid_primary_cols = [c for c in user_ordered_cols if c in wide.columns]
    other_cols = [c for c in wide.columns if c not in valid_primary_cols]
    other_cols.sort()
    
    final_cols = valid_primary_cols + other_cols
    wide = wide[final_cols]
    
    print(f"Dataset flattened into {wide.shape[0]} rows and {wide.shape[1]} columns.")
    print(f"Exporting exactly to: {file_out}...")
    wide.to_excel(file_out, index=False)
    print("Flattening successfully completed!")

if __name__ == '__main__':
    file_i = r'D:\Projects\Advanced 5G analysis\LTE-5G NR serving-Detecting and listing cells.xlsx'
    file_map_i = r'D:\Projects\Advanced 5G analysis\LTE serving RSRP + CellID_updated.xlsx'
    file_o = r'D:\Projects\Advanced 5G analysis\LTE-5G NR serving-Detecting and listing cells_flattened.xlsx'
    flatten_cells(file_i, file_map_i, file_o)

import pandas as pd
import os

def main():
    input_file_1 = r'D:\Projects\Advanced 5G analysis\LTE serving RSRP + CellID.xlsx'
    output_file_1 = r'D:\Projects\Advanced 5G analysis\LTE serving RSRP + CellID_updated.xlsx'

    input_file_2 = r'D:\Projects\Advanced 5G analysis\LTE-5G NR serving-Detecting and listing cells.xlsx'
    output_file_2 = r'D:\Projects\Advanced 5G analysis\LTE-5G NR serving-Detecting and listing cells_updated.xlsx'

    if not os.path.exists(input_file_1):
        print(f"Error: Could not find input file at {input_file_1}")
        return

    print("Loading First Data File...")
    df = pd.read_excel(input_file_1)
    
    serving_mask = df['Cell type'] == 'Serving'
    missing_before = df.loc[serving_mask, 'Cell ID'].isna().sum()
    print(f"Missing Cell IDs in 'Serving' initially: {missing_before}")

    # Pass 1: Match exactly by Time across the entire file
    print("Executing Pass 1: Filling by exact Time match...")
    time_cell_map = df.dropna(subset=['Cell ID']).groupby('Time')['Cell ID'].first()
    mask_to_fill_pass1 = serving_mask & df['Cell ID'].isna()
    df.loc[mask_to_fill_pass1, 'Cell ID'] = df.loc[mask_to_fill_pass1, 'Time'].map(time_cell_map)
    
    missing_after_pass1 = df.loc[serving_mask, 'Cell ID'].isna().sum()
    print(f"Missing Cell IDs after Pass 1: {missing_after_pass1}")

    # Pass 2: The Better Method - Continuous PCI Blocks
    print("Executing Pass 2: Filling using continuous PCI blocks...")
    s_df = df[serving_mask].copy()
    s_df['pci_block'] = (s_df['PCI'] != s_df['PCI'].shift(1)).cumsum()
    s_df['Cell ID'] = s_df.groupby('pci_block')['Cell ID'].bfill().ffill()
    df.loc[serving_mask, 'Cell ID'] = s_df['Cell ID']
    
    missing_after_pass2 = df.loc[serving_mask, 'Cell ID'].isna().sum()
    print(f"Missing Cell IDs after Pass 2: {missing_after_pass2}")

    print(f"Saving updated data 1 to: {output_file_1}")
    df[serving_mask].to_excel(output_file_1, index=False)

    print("Base extraction complete.")

if __name__ == '__main__':
    main()

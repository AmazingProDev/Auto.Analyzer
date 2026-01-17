
import pandas as pd
import json
import re

def normalize(text):
    if not isinstance(text, str): return ""
    # Uppercase and remove all non-alphabetic characters
    return re.sub(r'[^A-Z]', '', text.upper())

try:
    # Read Excel file
    df = pd.read_excel("Province to DR.xlsx")
    
    # Identify columns (assuming headers exist, looking for likely candidates)
    # We expect something like "Province" and "DR"
    # Let's inspect columns first if we weren't sure, but I'll try to find them dynamically
    
    cols = df.columns.tolist()
    prov_col = next((c for c in cols if "prov" in c.lower()), None)
    dr_col = next((c for c in cols if "dr" in c.lower() or "region" in c.lower() or "direction" in c.lower()), None)
    
    if not prov_col or not dr_col:
        print(f"Error: Could not identify Province/DR columns. Found: {cols}")
        exit(1)
        
    mapping = {}
    for index, row in df.iterrows():
        prov = row[prov_col]
        dr = row[dr_col]
        
        if pd.isna(prov) or pd.isna(dr): continue
        
        norm_prov = normalize(str(prov))
        if norm_prov:
            mapping[norm_prov] = str(dr).strip()
            
    # Print as formatted JSON object
    print(json.dumps(mapping, indent=4))

except Exception as e:
    print(f"Error processing file: {e}")


import openpyxl
import json
import re

def normalize(text):
    if not text: return ""
    text = str(text)
    # Uppercase and remove all non-alphabetic characters
    return re.sub(r'[^A-Z]', '', text.upper())

try:
    # Load workbook
    wb = openpyxl.load_workbook("Province to DR.xlsx")
    sheet = wb.active
    
    # Iterate rows
    rows = list(sheet.iter_rows(values_only=True))
    if not rows:
        print("Empty file")
        exit(1)
        
    headers = [str(h).lower() for h in rows[0]]
    
    # Find indices
    try:
        prov_idx = next(i for i, h in enumerate(headers) if "prov" in h)
        dr_idx = next(i for i, h in enumerate(headers) if "dr" in h or "region" in h or "direction" in h)
    except StopIteration:
        # Fallback: assume col 0 is Province, col 1 is DR if headers not found or specific match fails
        prov_idx = 0
        dr_idx = 1
        
    mapping = {}
    for row in rows[1:]: # Skip header
        if len(row) <= max(prov_idx, dr_idx): continue
        
        prov = row[prov_idx]
        dr = row[dr_idx]
        
        if not prov or not dr: continue
        
        norm_prov = normalize(prov)
        if norm_prov:
            mapping[norm_prov] = str(dr).strip()
            
    print(json.dumps(mapping, indent=4))

except Exception as e:
    print(f"Error: {e}")

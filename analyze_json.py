import json
import sys

def find_tags(node, tags, keys):
    if isinstance(node, dict):
        if "tag" in node:
            tags.add(node["tag"])
        for k, v in node.items():
            keys.add(k)
            find_tags(v, tags, keys)
    elif isinstance(node, list):
        for item in node:
            find_tags(item, tags, keys)

try:
    with open("logs/VoLTE_Auto_Pont_Volte_libre.json", "r") as f:
        data = json.load(f)
    
    tags = set()
    keys = set()
    find_tags(data, tags, keys)
    
    print("--- Found Keys ---")
    for k in list(keys)[:20]: print(k)
    
    print("\n--- Found Tags (First 50) ---")
    for t in sorted(list(tags))[:50]: print(t)

except Exception as e:
    print(f"Error: {e}")

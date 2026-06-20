import server, json, time

try:
    with open(server.BENCHMARK_NEMO_CONFIG_PATH, 'r') as f:
        paths = json.load(f).get('paths', [])
    
    t0 = time.time()
    res = server._parse_benchmark_nemo_files(paths)
    
    layer = res.get('layerThroughputAnalysis', {})
    print(json.dumps(layer, indent=2))
            
except Exception as e:
    import traceback
    traceback.print_exc()

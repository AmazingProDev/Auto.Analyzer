import server, json, time
import bdd_matcher as _bdd

try:
    with open(server.BENCHMARK_NEMO_CONFIG_PATH, 'r') as f:
        paths = json.load(f).get('paths', [])
    
    # Parse all paths first
    t0 = time.time()
    res = server._parse_benchmark_nemo_files(paths)
    
    # Look at the actual serving cells payload generated
    serving = res.get('iamServingCells', {})
    print("Serving cell result:")
    print(" Available:", serving.get('available'))
    print(" Matched:", serving.get('matchedCount'), "/", serving.get('gpsRows'))
    print(" Methods:", serving.get('matchMethods'))
    print(" Tech Breakdown:", serving.get('techBreakdown'))
    for c in serving.get("cells", [])[:10]:
        print(f" - {c['cellName']} ({c['tech']}/{c['band']}) : {c['hitCount']} hits")
            
except Exception as e:
    import traceback
    traceback.print_exc()

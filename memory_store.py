# memory_store.py

_RUNS = {}
_counter = 1

def new_run_id():
    global _counter
    rid = _counter
    _counter += 1
    return rid

def put_run(run_id, run_record):
    _RUNS[int(run_id)] = run_record

def get_run(run_id):
    try:
        return _RUNS[int(run_id)]
    except Exception:
        return None

def list_runs(limit=200):
    runs = list(_RUNS.values())
    runs.sort(key=lambda r: int(r.get("id") or 0), reverse=True)
    return [{
        "id": r.get("id"),
        "filename": r.get("filename"),
        "imported_at": r.get("imported_at"),
        "metricsCount": len(r.get("signals", []) or []),
        "eventTypesCount": len((r.get("catalogs", {}).get("events") or [])),
    } for r in runs[:int(limit)]]
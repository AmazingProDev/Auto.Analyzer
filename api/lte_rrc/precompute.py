import json
import os
import hashlib
from http.server import BaseHTTPRequestHandler

from lte_rrc_api_backend import precompute_lte_rrc


PRECOMPUTE_STORE = {}
PRECOMPUTE_DIR = os.path.join("/tmp", "optim_lte_rrc_precompute_cache")


def _read_json(handler: BaseHTTPRequestHandler):
    length = int(handler.headers.get("content-length") or 0)
    if length <= 0:
        return {}
    raw = handler.rfile.read(length)
    try:
        return json.loads(raw.decode("utf-8", errors="replace"))
    except Exception:
        return {}


def _send_json(handler: BaseHTTPRequestHandler, payload, status=200):
    body = json.dumps(payload).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Cache-Control", "no-store")
    handler.end_headers()
    handler.wfile.write(body)


def _cache_path(cache_key: str) -> str:
    safe = "".join(ch for ch in str(cache_key or "").strip() if ch.isalnum() or ch in ("-", "_"))
    return os.path.join(PRECOMPUTE_DIR, f"{safe}.json")


def _load_cache(cache_key: str):
    if not cache_key:
        return None
    if cache_key in PRECOMPUTE_STORE:
        return PRECOMPUTE_STORE[cache_key]
    path = _cache_path(cache_key)
    if not os.path.exists(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
        PRECOMPUTE_STORE[cache_key] = payload
        return payload
    except Exception:
        return None


def _store_cache(cache_key: str, payload):
    if not cache_key:
        return
    PRECOMPUTE_STORE[cache_key] = payload
    try:
        os.makedirs(PRECOMPUTE_DIR, exist_ok=True)
        with open(_cache_path(cache_key), "w", encoding="utf-8") as handle:
            json.dump(payload, handle)
    except Exception:
        pass


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        payload = _read_json(self)
        items = payload.get("items")
        cache_key = str(payload.get("cacheKey") or payload.get("cache_key") or "").strip()
        if cache_key:
            cached = _load_cache(cache_key)
            if cached is not None:
                _send_json(self, {"status": "success", "cacheKey": cache_key, "cached": True, **cached})
                return
        if not isinstance(items, list) or not items:
            _send_json(self, {"status": "error", "message": "items array is required when cache is missing"}, 400)
            return
        if not cache_key:
            fingerprint_rows = []
            for item in items:
                if not isinstance(item, dict):
                    continue
                fingerprint_rows.append({
                    "eventName": str(item.get("eventName") or item.get("event_name") or "").strip(),
                    "payloadHex": str(item.get("payloadHex") or item.get("payload_hex") or "").strip(),
                    "time": str(item.get("time") or "").strip(),
                    "servingPci": item.get("servingPci"),
                    "servingEarfcn": item.get("servingEarfcn"),
                })
            cache_key = hashlib.sha1(
                json.dumps(fingerprint_rows, separators=(",", ":"), sort_keys=True).encode("utf-8")
            ).hexdigest()
            cached = _load_cache(cache_key)
            if cached is not None:
                _send_json(self, {"status": "success", "cacheKey": cache_key, "cached": True, **cached})
                return
        result = precompute_lte_rrc(items)
        _store_cache(cache_key, result)
        _send_json(self, {"status": "success", "cacheKey": cache_key, "cached": False, **result})


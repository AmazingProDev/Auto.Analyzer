import json
from http.server import BaseHTTPRequestHandler

from lte_rrc_api_backend import decode_rrc_batch


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


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        payload = _read_json(self)
        items = payload.get("items")
        if not isinstance(items, list) or not items:
            _send_json(self, {"status": "error", "message": "items array is required"}, 400)
            return
        _send_json(self, {"status": "success", "items": decode_rrc_batch(items)})


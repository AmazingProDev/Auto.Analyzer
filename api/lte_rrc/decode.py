import json
from http.server import BaseHTTPRequestHandler

from lte_rrc_api_backend import decode_rrc_payload


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
        event_name = str(payload.get("eventName") or payload.get("event_name") or "").strip()
        payload_hex = str(payload.get("payloadHex") or payload.get("payload_hex") or "").strip()
        if not event_name or not payload_hex:
            _send_json(self, {"status": "error", "message": "eventName and payloadHex are required"}, 400)
            return
        try:
            decoded = decode_rrc_payload(event_name, payload_hex)
        except Exception as exc:
            _send_json(self, {"status": "error", "message": str(exc)}, 500)
            return
        _send_json(self, {"status": "success", "decoded": decoded})


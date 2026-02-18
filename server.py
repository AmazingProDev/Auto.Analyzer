"""
Minimal HTTP server for Optim Analyzer (no external frameworks).

Routes consumed by the frontend:
- POST /api/trp/import            multipart/form-data file=...
- GET  /api/runs                  list runs
- GET  /api/runs/<id>             run + track + events
- GET  /api/runs/<id>/catalog     signal catalog (names)
- GET  /api/runs/<id>/sidebar     sidebar groups
- GET  /api/runs/<id>/signals     signal catalog (same as catalog.signals)
- GET  /api/runs/<id>/timeseries?signal=<name>&max_points=<int>
- GET  /api/runs/<id>/track
- GET  /api/runs/<id>/events
"""

from __future__ import annotations

import json
import os
import sys
import traceback
from http.server import HTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

from trp_importer import (
    import_trp_file,
    list_runs,
    fetch_run_detail,
    fetch_kpi_series,
    fetch_run_catalog,
    fetch_run_sidebar,
    fetch_run_signals,
    fetch_timeseries_by_signal,
    fetch_run_track,
    fetch_run_events,
)

UPLOAD_DIR = os.environ.get("OPTIM_UPLOAD_DIR", "/tmp/optim_uploads")
DB_PATH = None  # kept for backward compatibility; in-memory store ignores it


def _json(handler: SimpleHTTPRequestHandler, obj, status: int = 200):
    body = json.dumps(obj).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Cache-Control", "no-store")
    handler.end_headers()
    handler.wfile.write(body)


def _read_body(handler: SimpleHTTPRequestHandler) -> bytes:
    clen = handler.headers.get("Content-Length")
    if not clen:
        return b""
    try:
        n = int(clen)
    except Exception:
        n = 0
    if n <= 0:
        return b""
    return handler.rfile.read(n)


def _parse_multipart_file(body: bytes, content_type: str) -> tuple[str, bytes]:
    """
    Extremely small multipart/form-data parser.
    Assumes a single file part with a filename.
    """
    # content-type: multipart/form-data; boundary=----WebKitFormBoundary...
    m = None
    for part in content_type.split(";"):
        part = part.strip()
        if part.startswith("boundary="):
            m = part.split("=", 1)[1]
            break
    if not m:
        raise ValueError("Missing multipart boundary")

    boundary = ("--" + m).encode("utf-8")
    sections = body.split(boundary)
    for sec in sections:
        sec = sec.strip()
        if not sec or sec == b"--":
            continue
        # headers/body split
        if b"\r\n\r\n" not in sec:
            continue
        head, data = sec.split(b"\r\n\r\n", 1)
        head_txt = head.decode("utf-8", errors="replace")
        if "filename=" not in head_txt:
            continue
        # filename
        fnm = ""
        for line in head_txt.split("\r\n"):
            if line.lower().startswith("content-disposition:"):
                # Content-Disposition: form-data; name="file"; filename="x.trp"
                mm = line.split("filename=", 1)[1].strip()
                if mm.startswith('"') and '"' in mm[1:]:
                    fnm = mm.split('"', 2)[1]
                else:
                    fnm = mm.split(";", 1)[0].strip()
        # strip last CRLF and possible trailing --
        if data.endswith(b"\r\n"):
            data = data[:-2]
        if data.endswith(b"--"):
            data = data[:-2]
        return fnm or "upload.trp", data

    raise ValueError("No file part found")


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, format, *args):
        # quieter logs
        sys.stderr.write("%s - - [%s] %s\n" % (self.address_string(), self.log_date_time_string(), format % args))

    def end_headers(self):
        # Allow frontend and backend on different origins/ports.
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path

        try:
            # API routes
            if path == "/api/runs":
                _json(self, {"status": "success", "runs": list_runs(DB_PATH)})
                return

            if path.startswith("/api/runs/"):
                parts = path.strip("/").split("/")  # ["api","runs","<id>", ...]
                if len(parts) < 3:
                    _json(self, {"status": "error", "message": "Bad request"}, 400)
                    return

                run_id = parts[2]

                # Sub-routes
                if len(parts) == 4 and parts[3] == "catalog":
                    _json(self, fetch_run_catalog(DB_PATH, run_id))
                    return
                if len(parts) == 4 and parts[3] == "sidebar":
                    _json(self, fetch_run_sidebar(DB_PATH, run_id))
                    return
                if len(parts) == 4 and parts[3] == "signals":
                    _json(self, fetch_run_signals(DB_PATH, run_id))
                    return
                if len(parts) == 4 and parts[3] == "track":
                    _json(self, fetch_run_track(DB_PATH, run_id))
                    return
                if len(parts) == 4 and parts[3] == "events":
                    _json(self, fetch_run_events(DB_PATH, run_id))
                    return
                if len(parts) == 4 and parts[3] == "kpi":
                    qs = parse_qs(parsed.query or "")
                    name = (qs.get("name") or [""])[0]
                    max_points = (qs.get("max_points") or ["50000"])[0]
                    try:
                        max_points_i = int(max_points)
                    except Exception:
                        max_points_i = 50000
                    _json(self, fetch_kpi_series(DB_PATH, run_id, name, max_points=max_points_i))
                    return
                if len(parts) == 4 and parts[3] == "timeseries":
                    qs = parse_qs(parsed.query or "")
                    signal = (qs.get("signal") or [""])[0]
                    max_points = (qs.get("max_points") or ["50000"])[0]
                    try:
                        max_points_i = int(max_points)
                    except Exception:
                        max_points_i = 50000
                    _json(self, fetch_timeseries_by_signal(DB_PATH, run_id, signal, max_points=max_points_i))
                    return

                # Default: run detail
                if len(parts) == 3:
                    run, track, events = fetch_run_detail(DB_PATH, run_id)
                    _json(self, {"status": "success", "run": run, "track_points": track, "events": events})
                    return

                _json(self, {"status": "error", "message": "Not found"}, 404)
                return

            # Static files
            return super().do_GET()

        except Exception as e:
            traceback.print_exc()
            _json(self, {"status": "error", "message": str(e)}, 500)

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path

        try:
            if path == "/api/trp/import":
                os.makedirs(UPLOAD_DIR, exist_ok=True)

                ctype = self.headers.get("Content-Type", "")
                body = _read_body(self)

                filename, data = _parse_multipart_file(body, ctype)

                save_path = os.path.join(UPLOAD_DIR, os.path.basename(filename))
                with open(save_path, "wb") as f:
                    f.write(data)

                result = import_trp_file(save_path, DB_PATH, UPLOAD_DIR)
                _json(self, {"status": "success", **result})
                return

            _json(self, {"status": "error", "message": "Not found"}, 404)

        except Exception as e:
            traceback.print_exc()
            _json(self, {"status": "error", "message": str(e)}, 500)


def main():
    port = int(os.environ.get("PORT", "8000"))
    httpd = HTTPServer(("0.0.0.0", port), Handler)
    print(f"Starting server on port {port}...")
    print("Use Ctrl+C to stop.")
    httpd.serve_forever()


if __name__ == "__main__":
    main()

"""
Minimal HTTP server for Optim Analyzer (no external frameworks).

Routes consumed by the frontend:
- POST /api/trp/import            multipart/form-data file=...
- POST /api/nmfs/decode           multipart/form-data file=... (external converter bridge)
- GET  /api/nmfs/config           effective converter configuration
- POST /api/nmfs/config           save converter configuration
- POST /api/nmfs/config/test      validate converter command
- GET  /api/runs                  list runs
- GET  /api/runs/<id>             run + track + events
- GET  /api/runs/<id>/catalog     signal catalog (names)
- GET  /api/runs/<id>/sidebar     sidebar groups
- GET  /api/runs/<id>/signals     signal catalog (same as catalog.signals)
- GET  /api/runs/<id>/timeseries?signal=<name>&max_points=<int>
- GET  /api/runs/<id>/track
- GET  /api/runs/<id>/events
- GET  /api/runs/<id>/neighbors_at_time?time=<ISO>&tolMs=200&bucketMs=80
- GET  /api/runs/<id>/l1l2/capabilities
- GET  /api/runs/<id>/l1l2/at_time?time=<ISO>&windowMs=2000
"""

from __future__ import annotations

import json
import os
import shlex
import shutil
import subprocess
import sys
import tempfile
import traceback
from http.server import HTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

from trp_importer import (
    import_trp_file,
    list_runs,
    fetch_run_detail,
    fetch_kpi_series,
    fetch_neighbors_at_time,
    fetch_l1l2_scheduler_capabilities,
    fetch_l1l2_scheduler_at_time,
    fetch_run_catalog,
    fetch_run_sidebar,
    fetch_run_signals,
    fetch_timeseries_by_signal,
    fetch_run_track,
    fetch_run_events,
)

UPLOAD_DIR = os.environ.get("OPTIM_UPLOAD_DIR", "/tmp/optim_uploads")
DB_PATH = None  # kept for backward compatibility; in-memory store ignores it
NMFS_CONFIG_PATH = os.environ.get("OPTIM_NMFS_CONFIG_PATH", os.path.join(UPLOAD_DIR, "nmfs_converter_config.json"))


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


def _parse_json_body(handler: SimpleHTTPRequestHandler) -> dict:
    raw = _read_body(handler)
    if not raw:
        return {}
    try:
        data = json.loads(raw.decode("utf-8", errors="replace"))
        if isinstance(data, dict):
            return data
    except Exception:
        pass
    return {}


def _read_nmfs_config_file() -> dict:
    try:
        if not os.path.isfile(NMFS_CONFIG_PATH):
            return {}
        with open(NMFS_CONFIG_PATH, "r", encoding="utf-8", errors="replace") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _write_nmfs_config_file(data: dict):
    cfg = data if isinstance(data, dict) else {}
    os.makedirs(os.path.dirname(NMFS_CONFIG_PATH), exist_ok=True)
    with open(NMFS_CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2, ensure_ascii=False)


def _get_nmfs_effective_config() -> dict:
    file_cfg = _read_nmfs_config_file()
    cmd = os.environ.get("OPTIM_NMFS_CONVERTER_CMD", "").strip() or str(file_cfg.get("converterCmd") or "").strip()
    timeout_env = os.environ.get("OPTIM_NMFS_TIMEOUT_SEC", "").strip()
    keep_env = os.environ.get("OPTIM_NMFS_KEEP_TEMP", "").strip().lower()
    timeout_file = file_cfg.get("timeoutSec")
    keep_file = file_cfg.get("keepTemp")

    try:
        timeout_sec = int(timeout_env) if timeout_env else int(timeout_file if timeout_file is not None else 180)
    except Exception:
        timeout_sec = 180
    timeout_sec = max(10, timeout_sec)

    if keep_env in {"1", "true", "yes"}:
        keep_temp = True
    elif keep_env in {"0", "false", "no"}:
        keep_temp = False
    else:
        keep_temp = bool(keep_file) if keep_file is not None else False

    return {
        "converterCmd": cmd,
        "timeoutSec": timeout_sec,
        "keepTemp": keep_temp,
        "source": {
            "converterCmd": "env" if bool(os.environ.get("OPTIM_NMFS_CONVERTER_CMD", "").strip()) else ("file" if bool(file_cfg.get("converterCmd")) else "default"),
            "timeoutSec": "env" if bool(timeout_env) else ("file" if timeout_file is not None else "default"),
            "keepTemp": "env" if bool(keep_env) else ("file" if keep_file is not None else "default"),
        },
    }


def _validate_nmfs_converter_cfg(cfg: dict) -> dict:
    cmd_tpl = str((cfg or {}).get("converterCmd") or "").strip()
    timeout_sec = int((cfg or {}).get("timeoutSec") or 180)
    keep_temp = bool((cfg or {}).get("keepTemp"))
    issues = []
    warnings = []
    first_bin = None
    executable_found = False

    if not cmd_tpl:
        issues.append("converterCmd is empty.")
    if "{input}" not in cmd_tpl:
        issues.append("converterCmd must include {input} placeholder.")
    if "{output}" not in cmd_tpl:
        warnings.append("converterCmd does not include {output}; converter output discovery will rely on stdout/scan.")

    args = shlex.split(cmd_tpl) if cmd_tpl else []
    if not args:
        issues.append("converterCmd resolves to empty command.")
    else:
        first_bin = args[0]
        if os.path.isabs(first_bin):
            executable_found = os.path.exists(first_bin)
        else:
            executable_found = shutil.which(first_bin) is not None
        if not executable_found:
            warnings.append(f"Command binary not found in PATH: {first_bin}")

    return {
        "ok": len(issues) == 0,
        "issues": issues,
        "warnings": warnings,
        "converterCmd": cmd_tpl,
        "timeoutSec": max(10, timeout_sec),
        "keepTemp": keep_temp,
        "resolvedBinary": first_bin,
        "binaryFound": executable_found,
    }


def _run_nmfs_converter(input_path: str) -> dict:
    """
    Run external NMFS converter command configured by env var:
      OPTIM_NMFS_CONVERTER_CMD
    The command can use placeholders:
      {input}  -> absolute input .nmfs path
      {output} -> suggested output text path (.nmf)
    Example:
      wine /path/AnalyzeParser.exe -i "{input}" -o "{output}"
    """
    eff = _get_nmfs_effective_config()
    cmd_tpl = str(eff.get("converterCmd") or "").strip()
    if not cmd_tpl:
        raise RuntimeError(
            "NMFS converter is not configured. Set OPTIM_NMFS_CONVERTER_CMD "
            "with placeholders {input} and {output}."
        )

    try:
        timeout_sec = max(10, int(eff.get("timeoutSec") or 180))
    except Exception:
        timeout_sec = 180

    keep_temp = bool(eff.get("keepTemp"))
    tmp_dir = tempfile.mkdtemp(prefix="optim_nmfs_")
    out_name = os.path.basename(input_path) + ".nmf"
    output_path = os.path.join(tmp_dir, out_name)

    cmd_text = cmd_tpl.format(input=input_path, output=output_path)
    # Use Windows-compatible argument splitting when server runs on Windows.
    cmd_args = shlex.split(cmd_text, posix=(os.name != "nt"))
    if not cmd_args:
        raise RuntimeError("OPTIM_NMFS_CONVERTER_CMD resolved to an empty command.")

    proc = subprocess.run(
        cmd_args,
        capture_output=True,
        text=True,
        timeout=timeout_sec
    )

    decoded_text = ""
    chosen_output_path = None
    if os.path.isfile(output_path):
        try:
            with open(output_path, "r", encoding="utf-8", errors="replace") as f:
                decoded_text = f.read()
            chosen_output_path = output_path
        except Exception:
            decoded_text = ""

    # If converter ignored {output}, try to discover generated text files.
    if not decoded_text:
        candidates = []
        for root, _dirs, files in os.walk(tmp_dir):
            for fn in files:
                p = os.path.join(root, fn)
                ext = os.path.splitext(fn)[1].lower()
                if ext not in {".nmf", ".txt", ".csv", ".log"}:
                    continue
                try:
                    sz = os.path.getsize(p)
                except Exception:
                    continue
                if sz <= 0:
                    continue
                candidates.append((sz, p))
        if candidates:
            candidates.sort(reverse=True)
            chosen_output_path = candidates[0][1]
            try:
                with open(chosen_output_path, "r", encoding="utf-8", errors="replace") as f:
                    decoded_text = f.read()
            except Exception:
                decoded_text = ""

    # Last resort: some converters print plain text to stdout.
    if not decoded_text and (proc.stdout or "").strip():
        decoded_text = proc.stdout

    result = {
        "command": cmd_text,
        "returncode": int(proc.returncode),
        "stdout": proc.stdout[-4000:] if proc.stdout else "",
        "stderr": proc.stderr[-4000:] if proc.stderr else "",
        "output_path": chosen_output_path,
        "text_len": len(decoded_text),
        "temp_dir": tmp_dir if keep_temp else None,
    }

    if not keep_temp:
        try:
            shutil.rmtree(tmp_dir, ignore_errors=True)
        except Exception:
            pass

    if not decoded_text.strip():
        raise RuntimeError(
            "NMFS converter produced no decodable text output. "
            f"returncode={proc.returncode}. stderr={result['stderr'][:500]}"
        )

    result["text"] = decoded_text
    return result


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
            if path == "/api/nmfs/config":
                cfg = _get_nmfs_effective_config()
                _json(self, {"status": "success", "config": cfg, "configPath": NMFS_CONFIG_PATH})
                return

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
                    idx_raw = (qs.get("idx") or [None])[0]
                    try:
                        max_points_i = int(max_points)
                    except Exception:
                        max_points_i = 50000
                    try:
                        idx_i = int(idx_raw) if idx_raw not in (None, "") else None
                    except Exception:
                        idx_i = None
                    _json(self, fetch_kpi_series(DB_PATH, run_id, name, max_points=max_points_i, idx=idx_i))
                    return
                if len(parts) == 4 and parts[3] == "neighbors_at_time":
                    qs = parse_qs(parsed.query or "")
                    time_iso = (qs.get("time") or [""])[0]
                    tol_ms = (qs.get("tolMs") or ["200"])[0]
                    bucket_ms = (qs.get("bucketMs") or ["80"])[0]
                    try:
                        tol_ms_i = int(tol_ms)
                    except Exception:
                        tol_ms_i = 200
                    try:
                        bucket_ms_i = int(bucket_ms)
                    except Exception:
                        bucket_ms_i = 80
                    _json(self, fetch_neighbors_at_time(DB_PATH, run_id, time_iso, tol_ms=tol_ms_i, bucket_ms=bucket_ms_i))
                    return
                if len(parts) == 5 and parts[3] == "l1l2" and parts[4] == "capabilities":
                    _json(self, fetch_l1l2_scheduler_capabilities(DB_PATH, run_id))
                    return
                if len(parts) == 5 and parts[3] == "l1l2" and parts[4] == "at_time":
                    qs = parse_qs(parsed.query or "")
                    time_iso = (qs.get("time") or [""])[0]
                    window_ms = (qs.get("windowMs") or ["2000"])[0]
                    try:
                        window_ms_i = int(window_ms)
                    except Exception:
                        window_ms_i = 2000
                    _json(self, fetch_l1l2_scheduler_at_time(DB_PATH, run_id, time_iso, window_ms=window_ms_i))
                    return
                if len(parts) == 4 and parts[3] == "timeseries":
                    qs = parse_qs(parsed.query or "")
                    signal = (qs.get("signal") or [""])[0]
                    max_points = (qs.get("max_points") or ["50000"])[0]
                    idx_raw = (qs.get("idx") or [None])[0]
                    try:
                        max_points_i = int(max_points)
                    except Exception:
                        max_points_i = 50000
                    try:
                        idx_i = int(idx_raw) if idx_raw not in (None, "") else None
                    except Exception:
                        idx_i = None
                    _json(self, fetch_timeseries_by_signal(DB_PATH, run_id, signal, max_points=max_points_i, idx=idx_i))
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
            if path == "/api/nmfs/config":
                payload = _parse_json_body(self)
                timeout_raw = payload.get("timeoutSec")
                try:
                    timeout_val = int(timeout_raw)
                except Exception:
                    timeout_val = 180
                update = {
                    "converterCmd": str(payload.get("converterCmd") or "").strip(),
                    "timeoutSec": timeout_val,
                    "keepTemp": bool(payload.get("keepTemp")),
                }
                if update["timeoutSec"] < 10:
                    update["timeoutSec"] = 10
                _write_nmfs_config_file(update)
                eff = _get_nmfs_effective_config()
                _json(self, {"status": "success", "config": eff, "configPath": NMFS_CONFIG_PATH})
                return

            if path == "/api/nmfs/config/test":
                cfg = _get_nmfs_effective_config()
                report = _validate_nmfs_converter_cfg(cfg)
                _json(self, {"status": "success", "report": report, "configPath": NMFS_CONFIG_PATH})
                return

            if path == "/api/nmfs/decode":
                os.makedirs(UPLOAD_DIR, exist_ok=True)
                ctype = self.headers.get("Content-Type", "")
                body = _read_body(self)
                filename, data = _parse_multipart_file(body, ctype)
                safe_name = os.path.basename(filename or "upload.nmfs")
                save_path = os.path.join(UPLOAD_DIR, safe_name)
                with open(save_path, "wb") as f:
                    f.write(data)

                conv = _run_nmfs_converter(save_path)
                _json(
                    self,
                    {
                        "status": "success",
                        "filename": safe_name,
                        "converter": {
                            "returncode": conv.get("returncode"),
                            "output_path": conv.get("output_path"),
                            "text_len": conv.get("text_len"),
                            "stdout": conv.get("stdout", ""),
                            "stderr": conv.get("stderr", ""),
                        },
                        "text": conv.get("text", ""),
                    },
                )
                return

            if path == "/api/trp/import":
                os.makedirs(UPLOAD_DIR, exist_ok=True)

                ctype = self.headers.get("Content-Type", "")
                body = _read_body(self)

                filename, data = _parse_multipart_file(body, ctype)

                save_path = os.path.join(UPLOAD_DIR, os.path.basename(filename))
                with open(save_path, "wb") as f:
                    f.write(data)

                result = import_trp_file(save_path, DB_PATH, UPLOAD_DIR)
                # Backward-compatible keys for legacy tests/clients.
                compat = {
                    "runId": result.get("runId"),
                    "metricsCount": int(result.get("kpi_count") or 0),
                    "eventTypesCount": int(result.get("event_count") or 0),
                    "importReport": {
                        "decodedSamples": int(result.get("kpi_count") or 0),
                        "decodedEvents": int(result.get("event_count") or 0),
                        "trackPoints": int(result.get("track_count") or 0),
                    },
                }
                _json(self, {"status": "success", **result, **compat})
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
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping server...")
    finally:
        try:
            httpd.server_close()
        except Exception:
            pass
    print("Server stopped.")


if __name__ == "__main__":
    main()


# Legacy alias used in tests.
CustomHandler = Handler

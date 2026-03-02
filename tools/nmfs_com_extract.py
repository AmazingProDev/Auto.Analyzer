#!/usr/bin/env python3
"""
NMFS -> NMF text extractor using AnalyzeParser COM automation.

This script is intended to run on Windows where Nemo AnalyzeParser COM server
is installed/registered. It writes extracted measurement lines to a text file.

Typical usage:
  python tools/nmfs_com_extract.py --input "C:\\in.nmfs" --output "C:\\out.nmf"

Optional COM registration:
  python tools/nmfs_com_extract.py --register-exe "C:\\Nemo\\AnalyzeParser.exe" ...
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from typing import Any, Optional


def _eprint(msg: str):
    sys.stderr.write(str(msg) + "\n")


def _import_win32():
    try:
        import win32com.client  # type: ignore
        import pywintypes  # type: ignore
    except Exception as exc:
        raise RuntimeError(
            "pywin32 is required for COM automation. Install on Windows with: pip install pywin32"
        ) from exc
    return win32com.client, pywintypes


def _run_regserver(analyzeparser_exe: str) -> tuple[int, str]:
    if not analyzeparser_exe:
        return 0, "skip"
    exe = os.path.abspath(analyzeparser_exe)
    if not os.path.isfile(exe):
        return 1, f"AnalyzeParser.exe not found: {exe}"
    # AnalyzeParser is an ATL local server; /RegServer is standard registration switch.
    proc = subprocess.run([exe, "/RegServer"], capture_output=True, text=True)
    tail = ((proc.stdout or "") + "\n" + (proc.stderr or "")).strip()[-2000:]
    return int(proc.returncode), tail


def _dispatch_parser(
    win32_client: Any,
    progid_engine: str,
    progid_file: str,
):
    engine = None
    parser = None
    # Preferred path: ParserEngine -> CreateParser().
    try:
        engine = win32_client.Dispatch(progid_engine)
        try:
            parser = engine.CreateParser()
        except Exception:
            parser = None
    except Exception:
        engine = None
    # Fallback path: direct FileParser instance.
    if parser is None:
        parser = win32_client.Dispatch(progid_file)
    return engine, parser


def _safe_str(v: Any) -> str:
    if v is None:
        return ""
    if isinstance(v, bytes):
        try:
            return v.decode("utf-8", errors="replace")
        except Exception:
            return v.decode("latin1", errors="replace")
    return str(v)


def extract_nmfs_via_com(
    input_path: str,
    output_path: str,
    progid_engine: str,
    progid_file: str,
    max_measurements: int,
    max_empty_streak: int,
    register_exe: Optional[str] = None,
):
    t0 = time.time()
    in_abs = os.path.abspath(input_path)
    out_abs = os.path.abspath(output_path)

    if not os.path.isfile(in_abs):
        raise RuntimeError(f"Input file not found: {in_abs}")

    reg_code = 0
    reg_log = ""
    if register_exe:
        reg_code, reg_log = _run_regserver(register_exe)
        if reg_code != 0:
            raise RuntimeError(f"COM registration failed: {reg_log}")

    win32_client, pywintypes = _import_win32()
    engine = None
    parser = None
    extracted = 0
    parse_error = None

    try:
        engine, parser = _dispatch_parser(win32_client, progid_engine, progid_file)
    except Exception as exc:
        raise RuntimeError(
            f"Unable to create COM parser objects ({progid_engine}/{progid_file}): {exc}"
        ) from exc

    if parser is None:
        raise RuntimeError("COM parser object is null.")

    # Configure file and parse.
    try:
        parser.FileName = in_abs
    except Exception:
        # Some COM wrappers may expose lowercase/property bag variant.
        try:
            parser.Filename = in_abs
        except Exception as exc:
            raise RuntimeError(f"Unable to assign parser file name: {exc}") from exc

    try:
        parser.Parse()
    except Exception as exc:
        parse_error = _safe_str(exc)
        # Continue to attempt GetMeasurement in case parser exposes partial output.

    os.makedirs(os.path.dirname(out_abs) or ".", exist_ok=True)
    with open(out_abs, "w", encoding="utf-8", errors="replace") as f:
        empty_streak = 0
        for idx in range(max_measurements):
            try:
                m = parser.GetMeasurement(idx)
            except pywintypes.com_error:
                break
            except Exception:
                break

            line = _safe_str(m).strip()
            if not line:
                empty_streak += 1
                if empty_streak >= max_empty_streak:
                    break
                continue
            empty_streak = 0
            f.write(line + "\n")
            extracted += 1

    elapsed_ms = int((time.time() - t0) * 1000)
    summary = {
        "input": in_abs,
        "output": out_abs,
        "progidEngine": progid_engine,
        "progidFile": progid_file,
        "registration": {
            "attempted": bool(register_exe),
            "returncode": reg_code,
            "log": reg_log,
        },
        "parseError": parse_error,
        "measurements": extracted,
        "elapsedMs": elapsed_ms,
        "engineType": _safe_str(type(engine)) if engine is not None else None,
        "parserType": _safe_str(type(parser)),
    }
    return summary


def main() -> int:
    ap = argparse.ArgumentParser(description="Extract NMF text from secure NMFS using AnalyzeParser COM.")
    ap.add_argument("--input", required=True, help="Input .nmfs file path")
    ap.add_argument("--output", required=True, help="Output .nmf/.txt file path")
    ap.add_argument("--progid-engine", default="AnalyzeParser.ParserEngine", help="COM ProgID for parser engine")
    ap.add_argument("--progid-file", default="AnalyzeParser.FileParser", help="COM ProgID for direct file parser")
    ap.add_argument("--max-measurements", type=int, default=5_000_000, help="Maximum GetMeasurement index attempts")
    ap.add_argument("--max-empty-streak", type=int, default=200, help="Stop after this many consecutive empty measurements")
    ap.add_argument("--register-exe", default="", help="Optional AnalyzeParser.exe path; runs /RegServer before decode")
    ap.add_argument("--summary-json", default="", help="Optional path to write JSON summary")
    args = ap.parse_args()

    try:
        summary = extract_nmfs_via_com(
            input_path=args.input,
            output_path=args.output,
            progid_engine=args.progid_engine,
            progid_file=args.progid_file,
            max_measurements=max(1, int(args.max_measurements)),
            max_empty_streak=max(1, int(args.max_empty_streak)),
            register_exe=(args.register_exe or None),
        )
    except Exception as exc:
        _eprint(f"[nmfs_com_extract] ERROR: {exc}")
        return 2

    if args.summary_json:
        try:
            os.makedirs(os.path.dirname(os.path.abspath(args.summary_json)) or ".", exist_ok=True)
            with open(args.summary_json, "w", encoding="utf-8") as f:
                json.dump(summary, f, indent=2, ensure_ascii=False)
        except Exception as exc:
            _eprint(f"[nmfs_com_extract] WARN summary write failed: {exc}")

    # Print compact summary for server-side diagnostics.
    sys.stdout.write(json.dumps(summary, ensure_ascii=False) + "\n")

    if int(summary.get("measurements") or 0) <= 0:
        _eprint("[nmfs_com_extract] ERROR: no measurements extracted from NMFS.")
        return 3
    return 0


if __name__ == "__main__":
    raise SystemExit(main())


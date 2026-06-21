#!/usr/bin/env python3
"""Extract only the DOWNLOAD sessions from a Nemo TXT export into a smaller TXT.

A Nemo drive logs several transfer operations per DT (ICMP ping, HTTP upload, HTTP
download), each delimited by Event IDs DAA (connection attempt) ... DAD (disconnect).
Benchmark analysis only needs the HTTP download sessions, but the raw export can be
200 MB+ (hundreds of thousands of rows), which is slow/heavy to import.

This script streams the file, keeps the header + only the rows that belong to a
DOWNLOAD session window (DAA -> DAD), and writes them out verbatim (lines are copied
byte-for-byte, so the result stays a valid Nemo export). All other rows — pings,
uploads, and idle/between-session rows — are dropped.

Memory use is bounded by ONE session's rows (a few thousand at most), so it handles
arbitrarily large files.

Usage:
    python3 extract_dl_sessions.py "Kenitra IAM.txt"
    python3 extract_dl_sessions.py "Kenitra IAM.txt" "Kenitra IAM_DL.txt"
    python3 extract_dl_sessions.py in.txt out.txt --include-upload   # also keep uploads
    python3 extract_dl_sessions.py in.txt out.txt --include-ping     # also keep pings
"""
import argparse
import os
import sys

EVENT_IDS = {"DAA", "DAC", "DREQ", "DCOMP", "DAD"}

# Header aliases (case-insensitive) used to locate the columns we inspect.
COL_ALIASES = {
    "time": ("Time",),
    "event": ("Event ID",),
    "protocol": ("Application protocol",),
    "direction": ("Data transfer direction", "Transfer direction"),
    "bytes_dl": ("Bytes DL",),
}


def _detect_delimiter(header_line: str) -> str:
    best, best_count = "\t", -1
    for delim in ("\t", ",", ";"):
        c = header_line.count(delim)
        if c > best_count:
            best, best_count = delim, c
    return best


def _resolve_indices(header_fields, aliases):
    lowered = [h.strip().lower() for h in header_fields]
    out = {}
    for key, names in aliases.items():
        idx = None
        for name in names:
            try:
                idx = lowered.index(name.lower())
                break
            except ValueError:
                continue
        out[key] = idx
    return out


def _field(fields, idx):
    if idx is None or idx >= len(fields):
        return ""
    return fields[idx].strip()


def _classify(dirs, protos, max_bytes_dl):
    """Classify a session from the directions/protocols/bytes seen inside it."""
    proto_blob = " ".join(protos).lower()
    if "ping" in proto_blob or "icmp" in proto_blob:
        return "ping"
    dirs_low = [d.lower() for d in dirs]
    if any(d.startswith("up") for d in dirs_low):
        return "upload"
    is_down = any(d.startswith("down") for d in dirs_low)
    looks_http = "http" in proto_blob or "ftp" in proto_blob
    if is_down and (looks_http or max_bytes_dl > 0):
        return "download"
    return "other"


def main(argv=None):
    ap = argparse.ArgumentParser(description="Extract only download sessions from a Nemo TXT export.")
    ap.add_argument("input", help="Source Nemo .txt export")
    ap.add_argument("output", nargs="?", help="Output .txt (default: <input>_DL.txt)")
    ap.add_argument("--include-upload", action="store_true", help="Also keep HTTP upload sessions")
    ap.add_argument("--include-ping", action="store_true", help="Also keep ICMP ping sessions")
    args = ap.parse_args(argv)

    in_path = args.input
    if not os.path.isfile(in_path):
        ap.error(f"input not found: {in_path}")
    out_path = args.output or (os.path.splitext(in_path)[0] + "_DL.txt")

    keep_kinds = {"download"}
    if args.include_upload:
        keep_kinds.add("upload")
    if args.include_ping:
        keep_kinds.add("ping")

    counts = {"download": 0, "upload": 0, "ping": 0, "other": 0}
    kept_sessions = 0
    kept_lines = 0
    total_lines = 0

    with open(in_path, "r", encoding="utf-8-sig", errors="replace", newline="") as fin, \
         open(out_path, "w", encoding="utf-8", newline="") as fout:
        header = fin.readline()
        if not header:
            ap.error("empty file")
        fout.write(header)
        delim = _detect_delimiter(header)
        idx = _resolve_indices(header.rstrip("\r\n").split(delim), COL_ALIASES)
        if idx["time"] is None or idx["event"] is None:
            ap.error("could not find 'Time' and 'Event ID' columns in the header")

        # State machine over time "ticks" (consecutive rows sharing the same Time value),
        # because DCOMP and DAD are logged at the same millisecond and the direction marker
        # sits on the same timestamp as DAA — grouping by Time keeps a session intact.
        cur_time = None
        tick_lines = []          # raw lines of the current tick
        tick_has_daa = False
        tick_has_dad = False
        tick_dirs = set()
        tick_protos = set()
        tick_max_dl = 0.0

        in_session = False
        sess_start_time = None
        sess_lines = []
        sess_dirs = set()
        sess_protos = set()
        sess_max_dl = 0.0

        def close_session():
            nonlocal in_session, sess_lines, sess_dirs, sess_protos, sess_max_dl
            nonlocal kept_sessions, kept_lines, sess_start_time
            if not in_session:
                return
            kind = _classify(sess_dirs, sess_protos, sess_max_dl)
            counts[kind] = counts.get(kind, 0) + 1
            if kind in keep_kinds:
                fout.writelines(sess_lines)
                kept_sessions += 1
                kept_lines += len(sess_lines)
            in_session = False
            sess_start_time = None
            sess_lines = []
            sess_dirs = set()
            sess_protos = set()
            sess_max_dl = 0.0

        def flush_tick():
            nonlocal in_session, sess_start_time, sess_lines, sess_dirs, sess_protos, sess_max_dl
            if not tick_lines:
                return
            # A new session starting (DAA) while one is open with no DAD -> close the orphan.
            if in_session and tick_has_daa and cur_time != sess_start_time:
                close_session()
            if not in_session:
                if tick_has_daa:
                    in_session = True
                    sess_start_time = cur_time
            if in_session:
                sess_lines.extend(tick_lines)
                sess_dirs.update(tick_dirs)
                sess_protos.update(tick_protos)
                if tick_max_dl > sess_max_dl:
                    sess_max_dl = tick_max_dl
                if tick_has_dad:
                    close_session()

        for line in fin:
            total_lines += 1
            if total_lines % 200000 == 0:
                sys.stderr.write(f"  ...scanned {total_lines:,} rows\n")
            fields = line.rstrip("\r\n").split(delim)
            t = _field(fields, idx["time"])
            # Rows with no/blank Time attach to the current tick (preserve them in-session).
            if t and t != cur_time:
                flush_tick()
                cur_time = t
                tick_lines = []
                tick_has_daa = tick_has_dad = False
                tick_dirs = set()
                tick_protos = set()
                tick_max_dl = 0.0
            tick_lines.append(line)
            eid = _field(fields, idx["event"]).upper()
            if eid == "DAA":
                tick_has_daa = True
            elif eid == "DAD":
                tick_has_dad = True
            d = _field(fields, idx["direction"])
            if d:
                tick_dirs.add(d)
            p = _field(fields, idx["protocol"])
            if p:
                tick_protos.add(p)
            bd = _field(fields, idx["bytes_dl"])
            if bd:
                try:
                    v = float(bd)
                    if v > tick_max_dl:
                        tick_max_dl = v
                except ValueError:
                    pass

        flush_tick()       # finalize last tick
        close_session()    # flush a session left open at EOF (best effort)

    in_size = os.path.getsize(in_path)
    out_size = os.path.getsize(out_path)
    print(f"Input : {in_path}  ({total_lines:,} data rows, {in_size/1e6:.1f} MB)")
    print(f"Output: {out_path}  ({kept_lines:,} rows, {out_size/1e6:.1f} MB)")
    print(f"Sessions found: download={counts['download']} upload={counts['upload']} "
          f"ping={counts['ping']} other={counts['other']}")
    print(f"Kept {kept_sessions} session(s) of kind(s): {', '.join(sorted(keep_kinds))}")
    if counts["download"] == 0:
        print("WARNING: no download sessions detected — check the export's Event ID / direction columns.",
              file=sys.stderr)


if __name__ == "__main__":
    main()

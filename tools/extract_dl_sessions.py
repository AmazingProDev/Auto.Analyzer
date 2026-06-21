#!/usr/bin/env python3
"""Extract only the DOWNLOAD operation of each DT from a Nemo TXT export.

A Nemo drive is organized into DTs (one per "Measurement Title"); each DT runs
ping, ping, upload, download. Benchmark analysis only needs the HTTP download, but
the raw export can be 200 MB+ which is slow/heavy to import.

This streams the file and, **per DT (Measurement Title, forward-filled — it is a
sparse column, blank on most rows)**, keeps the download operation: the block from
the download session's DAA event through the end of the DT. The download is anchored
on the rows that carry Bytes DL (the reliable "this is the download" signal), so it
works even when direction/bytes markers sit on sparse rows that don't line up with
the DAA->DAD event windows. Lines are copied verbatim, so the output stays a valid
Nemo export. Pings, uploads and idle rows are dropped.

Memory is bounded by ONE DT's rows, so it handles arbitrarily large files.

Usage:
    python3 extract_dl_sessions.py "Kenitra IAM.txt"            # -> Kenitra IAM_DL.txt
    python3 extract_dl_sessions.py in.txt out.txt
"""
import argparse
import os
import sys

COL_ALIASES = {
    "time": ("Time",),
    "event": ("Event ID",),
    "title": ("Measurement Title", "Measurement title"),
    "bytes_dl": ("Bytes DL",),
}


def _detect_delimiter(header_line: str) -> str:
    best, best_count = "\t", -1
    for delim in ("\t", ",", ";"):
        c = header_line.count(delim)
        if c > best_count:
            best, best_count = delim, c
    return best


def _resolve(header_fields, names):
    lowered = [h.strip().lower() for h in header_fields]
    for name in names:
        try:
            return lowered.index(name.lower())
        except ValueError:
            continue
    return None


def _field(fields, idx):
    if idx is None or idx >= len(fields):
        return ""
    return fields[idx].strip()


def _fnum(s):
    try:
        return float(s)
    except (TypeError, ValueError):
        return 0.0


def main(argv=None):
    ap = argparse.ArgumentParser(description="Extract per-DT download operations from a Nemo TXT export.")
    ap.add_argument("input")
    ap.add_argument("output", nargs="?")
    args = ap.parse_args(argv)

    in_path = args.input
    if not os.path.isfile(in_path):
        ap.error(f"input not found: {in_path}")
    out_path = args.output or (os.path.splitext(in_path)[0] + "_DL.txt")

    total_lines = 0
    dts_seen = 0
    dts_kept = 0
    dts_with_bytes = 0
    kept_lines = 0

    with open(in_path, "r", encoding="utf-8-sig", errors="replace", newline="") as fin, \
         open(out_path, "w", encoding="utf-8", newline="") as fout:
        header = fin.readline()
        if not header:
            ap.error("empty file")
        fout.write(header)
        delim = _detect_delimiter(header)
        hf = header.rstrip("\r\n").split(delim)
        i_time = _resolve(hf, COL_ALIASES["time"])
        i_event = _resolve(hf, COL_ALIASES["event"])
        i_title = _resolve(hf, COL_ALIASES["title"])
        i_bdl = _resolve(hf, COL_ALIASES["bytes_dl"])
        if i_time is None or i_event is None:
            ap.error("could not find 'Time' and 'Event ID' columns")
        if i_title is None:
            sys.stderr.write("WARNING: no 'Measurement Title' column; treating the whole file as one DT.\n")

        # Buffer one DT at a time. Each entry: (raw_line, time_str, is_daa, has_bytes_dl)
        buf = []
        cur_title = None

        def process_dt():
            nonlocal dts_seen, dts_kept, dts_with_bytes, kept_lines
            if not buf:
                return
            dts_seen += 1
            # The download is the rows carrying Bytes DL > 0. A DT with none is not a
            # download (or a failed/empty one) -> skip it.
            dl_idxs = [k for k, e in enumerate(buf) if e[4]]
            if not dl_idxs:
                return
            dts_with_bytes += 1
            first_dl, last_dl = dl_idxs[0], dl_idxs[-1]
            # Start = the DAA event at/before the first Bytes-DL row (download session start);
            # fall back to the first DAA in the DT, else the first row.
            anchor = next((k for k in range(first_dl, -1, -1) if buf[k][2]), None)
            if anchor is None:
                anchor = next((k for k, e in enumerate(buf) if e[2]), 0)
            # End = the DAD event at/after the last Bytes-DL row (download session end);
            # fall back to the DT end.
            end = next((k for k in range(last_dl, len(buf)) if buf[k][3]), len(buf) - 1)
            # Include same-timestamp rows around the boundaries (the direction marker sits on
            # the row just before DAA; DCOMP can share the DAD millisecond).
            a_ts = buf[anchor][1]
            start = anchor
            while start > 0 and buf[start - 1][1] == a_ts:
                start -= 1
            e_ts = buf[end][1]
            while end + 1 < len(buf) and buf[end + 1][1] == e_ts:
                end += 1
            for entry in buf[start:end + 1]:
                fout.write(entry[0])
            kept_lines += (end + 1) - start
            dts_kept += 1

        for line in fin:
            total_lines += 1
            if total_lines % 200000 == 0:
                sys.stderr.write(f"  ...scanned {total_lines:,} rows\n")
            fields = line.rstrip("\r\n").split(delim)
            title = _field(fields, i_title) if i_title is not None else ""
            if title and title != cur_title:
                process_dt()         # finalize previous DT
                buf = []
                cur_title = title
            eid = _field(fields, i_event).upper()
            t = _field(fields, i_time)
            has_bdl = _fnum(_field(fields, i_bdl)) > 0 if i_bdl is not None else False
            buf.append((line, t, eid == "DAA", eid == "DAD", has_bdl))

        process_dt()  # finalize last DT

    in_size = os.path.getsize(in_path)
    out_size = os.path.getsize(out_path)
    print(f"Input : {in_path}  ({total_lines:,} rows, {in_size/1e6:.1f} MB)")
    print(f"Output: {out_path}  ({kept_lines:,} rows, {out_size/1e6:.1f} MB)")
    print(f"DTs: {dts_seen} seen, {dts_with_bytes} with a Bytes-DL download, {dts_kept} kept")
    if dts_with_bytes < dts_seen:
        print(f"NOTE: {dts_seen - dts_with_bytes} DT(s) had no Bytes-DL row (possible failed download "
              f"or sparse field) — kept via last-DAA fallback.", file=sys.stderr)


if __name__ == "__main__":
    main()

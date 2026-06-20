#!/usr/bin/env python3
"""
Deep-ish TEMS TRP Qualcomm/RRC/NAS extractor.

What this does:
  * Opens a ZIP/OPC .trp package.
  * Reads trp/providers/sp1/channels/ch1/channel.log.
  * Decompresses the channel stream if needed.
  * Parses TEMS channel records.
  * Parses Qualcomm DIAG log packets embedded in payload type 0x0002.
  * Classifies common LTE/UMTS/GSM/RRC/NAS log-code families.
  * Extracts likely OTA/NAS/RRC bodies to CSV + JSONL + binary PDU files.

This does NOT replace proprietary Qualcomm/TEMS dictionaries. It gives your webapp
an implementable deep extraction layer and clean handoff points for ASN.1/NAS decoders
(pycrate, asn1c-generated decoders, Wireshark/tshark, or vendor DLL workers).
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import io
import json
import os
import struct
import zipfile
import zlib
from collections import Counter, defaultdict
from pathlib import Path
from typing import Dict, Iterable, Iterator, Optional, Tuple

WINDOWS_TICKS_PER_SECOND = 10_000_000
WINDOWS_EPOCH = dt.datetime(1, 1, 1, tzinfo=dt.timezone.utc)

# Known/observed Qualcomm DIAG log codes. Labels are intentionally conservative.
# Some names vary by chipset/tools release.
LOG_CODE_NAMES = {
    0xB0C0: "LTE_RRC_OTA_PACKET",
    0xB0C1: "LTE_RRC_MIB_OR_SERVING_CELL_INFO_CANDIDATE",
    0xB0C2: "LTE_RRC_CELL_RESELECTION_OR_SIB_CANDIDATE",
    0xB0E2: "LTE_NAS_ESM_OTA_OR_NAS_CONTAINER_CANDIDATE",
    0xB0E3: "LTE_NAS_EMM_OTA_OR_NAS_CONTAINER_CANDIDATE",
    0xB0E5: "LTE_NAS_SECURITY_OR_NAS_CONTAINER_CANDIDATE",
    0xB0EC: "LTE_NAS_OR_PROTOCOL_CONTAINER_CANDIDATE",
    0xB0ED: "LTE_NAS_OR_PROTOCOL_CONTAINER_CANDIDATE",
    0xB0EE: "LTE_NAS_OR_PROTOCOL_CONTAINER_CANDIDATE",
    0x4125: "WCDMA/RRC_OR_GSM_SIGNALING_CANDIDATE",
    0x4127: "WCDMA/RRC_OR_GSM_SIGNALING_CANDIDATE",
    0x4111: "WCDMA/RRC_MEAS_OR_SIGNALING_CANDIDATE",
    0x7130: "GSM/GPRS_SIGNALING_CANDIDATE",
    0x7131: "GSM/GPRS_SIGNALING_CANDIDATE",
    0x7135: "GSM/GPRS_SIGNALING_CANDIDATE",
    0x713A: "GSM/GPRS_SIGNALING_CANDIDATE",
}

CANDIDATE_CODES = set(LOG_CODE_NAMES)

NAS_PD = {
    0x2: "EPS session management messages",
    0x7: "EPS mobility management messages",
    0x8: "GPRS mobility management messages",
    0xA: "GPRS session management messages",
}

EMM_TYPES = {
    0x41: "Attach request", 0x42: "Attach accept", 0x43: "Attach complete", 0x44: "Attach reject",
    0x45: "Detach request", 0x46: "Detach accept", 0x48: "Tracking area update request",
    0x49: "Tracking area update accept", 0x4A: "Tracking area update complete", 0x4B: "Tracking area update reject",
    0x4C: "Extended service request", 0x4D: "Service reject", 0x4E: "GUTI reallocation command",
    0x4F: "GUTI reallocation complete", 0x50: "Authentication request", 0x51: "Authentication response",
    0x52: "Authentication reject", 0x53: "Identity request", 0x54: "Identity response",
    0x55: "Security mode command", 0x56: "Security mode complete", 0x57: "Security mode reject",
    0x5C: "EMM information", 0x5D: "Downlink NAS transport", 0x5E: "Uplink NAS transport",
    0x61: "CS service notification", 0x62: "Downlink generic NAS transport", 0x63: "Uplink generic NAS transport",
}
ESM_TYPES = {
    0xC1: "Activate default EPS bearer context request", 0xC2: "Activate default EPS bearer context accept",
    0xC3: "Activate default EPS bearer context reject", 0xC5: "Activate dedicated EPS bearer context request",
    0xC6: "Activate dedicated EPS bearer context accept", 0xC7: "Activate dedicated EPS bearer context reject",
    0xC9: "Modify EPS bearer context request", 0xCA: "Modify EPS bearer context accept",
    0xCB: "Modify EPS bearer context reject", 0xCD: "Deactivate EPS bearer context request",
    0xCE: "Deactivate EPS bearer context accept", 0xD0: "PDN connectivity request",
    0xD1: "PDN connectivity reject", 0xD2: "PDN disconnect request", 0xD3: "PDN disconnect reject",
    0xD4: "Bearer resource allocation request", 0xD5: "Bearer resource allocation reject",
    0xD6: "Bearer resource modification request", 0xD7: "Bearer resource modification reject",
    0xE8: "ESM information request", 0xE9: "ESM information response",
}


def windows_ticks_to_iso(ticks: int) -> str:
    return (WINDOWS_EPOCH + dt.timedelta(microseconds=ticks / 10)).isoformat()


def maybe_decompress_channel(raw: bytes) -> bytes:
    """Channel logs are usually zlib streams, sometimes with an 8-byte zero prefix."""
    if not raw:
        return b""
    starts = [0]
    # TEMS TRP channel.log files in the sample use 8 leading zero bytes, then zlib header 78 da.
    for marker in (b"\x78\x9c", b"\x78\xda", b"\x78\x01"):
        pos = raw.find(marker, 0, 32)
        if pos >= 0:
            starts.append(pos)
            starts.append(pos + 2)  # raw deflate after the zlib header
    for start in starts:
        chunk = raw[start:]
        for wbits in (zlib.MAX_WBITS, -zlib.MAX_WBITS):
            try:
                return zlib.decompress(chunk, wbits)
            except zlib.error:
                pass
    return raw


def read_ch1_from_trp(path: Path) -> bytes:
    with zipfile.ZipFile(path, "r") as zf:
        candidates = [n for n in zf.namelist() if n.endswith("/channels/ch1/channel.log")]
        if not candidates:
            raise FileNotFoundError("Cannot find channels/ch1/channel.log in TRP package")
        return maybe_decompress_channel(zf.read(candidates[0]))


def iter_tems_channel_records(data: bytes) -> Iterator[dict]:
    off = 0
    idx = 0
    n = len(data)
    bad_count = 0
    while off + 20 <= n:
        ticks, meta_u16, meta_u32_a, meta_u32_b, payload_len = struct.unpack_from("<QHIIH", data, off)
        start = off + 20
        end = start + payload_len
        if end > n:
            bad_count += 1
            if bad_count <= 3:
                yield {
                    "record_index": idx, "offset": off, "bad": True,
                    "error": "truncated payload", "payload_len": payload_len,
                }
            off += 1  # skip one byte and try to resync rather than hard-stop
            continue
        payload = data[start:end]
        yield {
            "record_index": idx,
            "offset": off,
            "timestamp_utc": windows_ticks_to_iso(ticks),
            "ticks": ticks,
            "meta_u16": meta_u16,
            "meta_u32_a": meta_u32_a,
            "meta_u32_b": meta_u32_b,
            "payload_len": payload_len,
            "payload_type": payload[:2].hex() if len(payload) >= 2 else payload.hex(),
            "payload": payload,
        }
        off = end
        idx += 1


def parse_qualcomm_diag(payload: bytes) -> Optional[dict]:
    """Parse the Qualcomm DIAG LOG_F envelope observed in TEMS payload type 0x0002.

    Observed structure in this TRP:
      00 02                            TEMS payload type
      xx xx xx xx xx xx xx xx          TEMS/QCOM subheader, release/tool specific
      10                               DIAG command LOG_F
      00                               reserved/flags
      uint16le                         DIAG record length
      uint16le                         DIAG record length repeated
      uint16le                         Qualcomm log code
      uint64le                         Qualcomm timestamp or phone-side timestamp
      bytes                            log body
    """
    if len(payload) < 26:
        return None
    if payload[:2] != b"\x00\x02":
        return None
    if payload[10] != 0x10:
        return None
    diag_len_1 = struct.unpack_from("<H", payload, 12)[0]
    diag_len_2 = struct.unpack_from("<H", payload, 14)[0]
    log_code = struct.unpack_from("<H", payload, 16)[0]
    qcom_ts = struct.unpack_from("<Q", payload, 18)[0]
    body = payload[26:]
    return {
        "diag_command": payload[10],
        "diag_len_1": diag_len_1,
        "diag_len_2": diag_len_2,
        "log_code": log_code,
        "log_code_hex": f"0x{log_code:04X}",
        "log_name": LOG_CODE_NAMES.get(log_code, "UNKNOWN_OR_VENDOR_SPECIFIC"),
        "qcom_timestamp_raw": qcom_ts,
        "body_len": len(body),
        "body": body,
    }


def guess_nas_from_bytes(buf: bytes) -> Optional[dict]:
    """Heuristic NAS parser.

    Real LTE NAS often begins with security/protocol discriminator octets and may be
    wrapped by a Qualcomm OTA header. This function scans for plausible EMM/ESM
    message-type bytes and reports candidates, rather than pretending certainty.
    """
    best = None
    for i in range(0, min(len(buf), 32)):
        b0 = buf[i]
        pd = b0 & 0x0F
        if pd not in NAS_PD:
            continue
        # Plain NAS: first octet PD/security header, message type usually next byte.
        if i + 1 < len(buf):
            mt = buf[i + 1]
            name = EMM_TYPES.get(mt) if pd == 0x7 else ESM_TYPES.get(mt) if pd == 0x2 else None
            if name:
                best = {"offset": i, "protocol_discriminator": pd, "pd_name": NAS_PD[pd], "message_type": mt, "message_name": name}
                break
        # Some ESM payloads are bearer-id/procedure-transaction first, then msg type.
        if i + 2 < len(buf):
            mt = buf[i + 2]
            name = ESM_TYPES.get(mt) if pd == 0x2 else None
            if name:
                best = {"offset": i, "protocol_discriminator": pd, "pd_name": NAS_PD[pd], "message_type": mt, "message_name": name}
                break
    return best


def extract(path: Path, outdir: Path) -> None:
    outdir.mkdir(parents=True, exist_ok=True)
    pdu_dir = outdir / "pdus"
    pdu_dir.mkdir(exist_ok=True)

    print(f"Reading ch1 from {path} ...")
    data = read_ch1_from_trp(path)
    (outdir / "ch1.decompressed.bin").write_bytes(data)
    print(f"ch1 decompressed: {len(data):,} bytes")

    diag_rows = []
    candidate_rows = []
    log_counts = Counter()
    all_payload_types = Counter()
    pdu_counts = defaultdict(int)
    total_records = 0

    jsonl = (outdir / "qualcomm_diag_packets.jsonl").open("w", encoding="utf-8")

    for rec in iter_tems_channel_records(data):
        if rec.get("bad"):
            continue
        total_records += 1
        all_payload_types[rec["payload_type"]] += 1

        payload = rec.get("payload", b"")
        diag = parse_qualcomm_diag(payload)
        if not diag:
            continue
        code = diag["log_code"]
        log_counts[code] += 1
        body = diag.pop("body")
        row = {
            "record_index": rec["record_index"],
            "offset": rec["offset"],
            "timestamp_utc": rec["timestamp_utc"],
            "payload_len": rec["payload_len"],
            **diag,
            "body_hex_prefix": body[:64].hex(),
        }
        diag_rows.append(row)
        jsonl.write(json.dumps({**row, "body_hex": body.hex()}, ensure_ascii=False) + "\n")

        if code in CANDIDATE_CODES:
            pdu_counts[code] += 1
            fname = f"{code:04X}_{pdu_counts[code]:06d}_rec{rec['record_index']}.bin"
            (pdu_dir / fname).write_bytes(body)
            nas_guess = guess_nas_from_bytes(body)
            candidate_rows.append({
                **row,
                "candidate_file": f"pdus/{fname}",
                "nas_guess": json.dumps(nas_guess, ensure_ascii=False) if nas_guess else "",
                "body_hex": body.hex(),
            })

    jsonl.close()

    def write_csv(fname: str, rows: list[dict]):
        if not rows:
            (outdir / fname).write_text("", encoding="utf-8")
            return
        keys = list(rows[0].keys())
        with (outdir / fname).open("w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=keys)
            w.writeheader()
            w.writerows(rows)

    write_csv("qualcomm_diag_packets.csv", diag_rows)
    write_csv("rrc_nas_candidates.csv", candidate_rows)

    with (outdir / "logcode_summary.csv").open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=["log_code_hex", "log_name", "count"])
        w.writeheader()
        for code, count in log_counts.most_common():
            w.writerow({"log_code_hex": f"0x{code:04X}", "log_name": LOG_CODE_NAMES.get(code, "UNKNOWN_OR_VENDOR_SPECIFIC"), "count": count})

    summary = {
        "input": str(path),
        "ch1_decompressed_bytes": len(data),
        "total_channel_records": total_records,
        "qualcomm_diag_packets": len(diag_rows),
        "rrc_nas_candidate_packets": len(candidate_rows),
        "payload_type_distribution": {k: v for k, v in all_payload_types.most_common(20)},
        "log_codes": {f"0x{k:04X}": {"name": LOG_CODE_NAMES.get(k, "UNKNOWN_OR_VENDOR_SPECIFIC"), "count": v} for k, v in log_counts.most_common()},
        "notes": [
            "This extracts Qualcomm DIAG log bodies. Full RRC ASN.1/NAS semantic decoding requires an external protocol decoder/dictionary.",
            "Use rrc_nas_candidates.csv and pdus/*.bin as input to pycrate/asn1c/tshark/vendor DLL worker.",
        ],
    }
    (outdir / "summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")

    print(f"\nTotal channel records parsed : {total_records:,}")
    print(f"Qualcomm DIAG packets found  : {len(diag_rows):,}")
    print(f"RRC/NAS candidate packets    : {len(candidate_rows):,}")
    print(f"\nTop payload types seen:")
    for pt, cnt in all_payload_types.most_common(10):
        print(f"  0x{pt} : {cnt:,}")
    print(f"\nLog code frequencies:")
    for code, count in log_counts.most_common(20):
        name = LOG_CODE_NAMES.get(code, "UNKNOWN_OR_VENDOR_SPECIFIC")
        print(f"  0x{code:04X}  {count:6,}  {name}")
    print(f"\nWrote output to {outdir}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("input_trp", type=Path)
    ap.add_argument("-o", "--outdir", type=Path, default=Path("deep_decode_out"))
    args = ap.parse_args()
    extract(args.input_trp, args.outdir)
    print(f"Done.")

if __name__ == "__main__":
    main()

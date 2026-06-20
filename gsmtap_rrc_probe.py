#!/usr/bin/env python3
"""
Probe Qualcomm B0C0 (LTE_RRC_OTA_PACKET) bodies via GSMTAP + tshark.

For each (pdu_offset, dl_subtype, ul_subtype) combination, builds a libpcap
file of sample packets encapsulated as GSMTAP LTE RRC and pipes it through
tshark.  The combination that produces the most valid decoded fields without
malformed markers wins.

Output:
  - Console ranking table
  - /tmp/gsmtap_probe/best_combo.json  (winner config)
  - /tmp/gsmtap_probe/<combo>/sample.pcap  (for manual inspection)
"""
from __future__ import annotations

import glob
import json
import os
import struct
import subprocess
import tempfile
from pathlib import Path
from itertools import product

TSHARK = "/opt/homebrew/bin/tshark"
PDU_DIR = Path("/tmp/deep_decode_out/pdus")
OUTDIR  = Path("/tmp/gsmtap_probe")
OUTDIR.mkdir(parents=True, exist_ok=True)

EARFCN = 1320
SAMPLE_PER_COMBO = 60   # packets per combo (balance speed vs reliability)

# GSMTAP LTE RRC sub-types (from gsmtap.h / Wireshark)
GSMTAP_LTE_RRC_SUBTYPES = {
    0: "BCCH-BCH",
    1: "BCCH-DL-SCH",
    2: "DL-CCCH",
    3: "DL-DCCH",
    4: "UL-CCCH",
    5: "UL-DCCH",
    6: "PCCH",
}
DL_SUBTYPES = [0, 1, 2, 3, 6]
UL_SUBTYPES = [4, 5]

# Candidate PDU offsets within the B0C0 body
PDU_OFFSETS = [10, 11, 12, 13, 14]


# ── pcap helpers ──────────────────────────────────────────────────────────────

PCAP_GLOBAL_HEADER = struct.pack(
    "<IHHiIII",
    0xa1b2c3d4,  # magic
    2, 4,        # version_major, version_minor
    0, 0,        # thiszone, sigfigs
    65535,       # snaplen
    1,           # linktype Ethernet
)

ETH_HDR  = b"\xff\xff\xff\xff\xff\xff" + b"\x00\x00\x00\x00\x00\x00" + b"\x08\x00"
SRC_IP   = b"\x7f\x00\x00\x01"
DST_IP   = b"\x7f\x00\x00\x01"
UDP_PORT = 4729  # GSMTAP standard port


def gsmtap_hdr(subtype: int, earfcn: int = EARFCN) -> bytes:
    """Build a 24-byte GSMTAP LTE RRC header."""
    return struct.pack(
        ">BBBBHbbIBBBB",
        2,          # version
        6,          # hdr_len in 32-bit words (6*4 = 24)
        0x0d,       # type: GSMTAP_TYPE_LTE_RRC
        0,          # timeslot
        earfcn,     # arfcn (big-endian)
        0,          # signal_dbm
        0,          # snr_db
        0,          # frame_number
        subtype,    # sub_type
        0, 0, 0,    # antenna, sub_slot, reserved
    )


def build_eth_ip_udp(payload: bytes) -> bytes:
    udp_len  = 8 + len(payload)
    ip_len   = 20 + udp_len
    udp      = struct.pack(">HHHH", 12345, UDP_PORT, udp_len, 0) + payload
    ip_flags = struct.pack(
        ">BBHHHBBH4s4s",
        0x45, 0, ip_len,
        0, 0, 64, 17, 0,
        SRC_IP, DST_IP,
    )
    return ETH_HDR + ip_flags + udp


def make_pcap(packets: list[bytes]) -> bytes:
    """Wrap a list of raw layer-2 frames into a libpcap byte string."""
    records = []
    for i, pkt in enumerate(packets):
        hdr = struct.pack("<IIII", i, 0, len(pkt), len(pkt))
        records.append(hdr + pkt)
    return PCAP_GLOBAL_HEADER + b"".join(records)


# ── corpus helpers ────────────────────────────────────────────────────────────

def load_corpus() -> tuple[list[tuple[int, bytes]], list[tuple[int, bytes]]]:
    """Return (dl_bodies, ul_bodies) as lists of (earfcn, raw_body)."""
    dl, ul = [], []
    for f in sorted(PDU_DIR.glob("B0C0_*.bin")):
        b = f.read_bytes()
        if len(b) < 12:
            continue
        direction = b[5]
        earfcn    = struct.unpack_from("<H", b, 8)[0]
        (dl if direction == 0 else ul).append((earfcn, b))
    return dl, ul


def sample(lst: list, n: int) -> list:
    """Evenly-spaced sample of n items from lst."""
    if not lst:
        return []
    step = max(1, len(lst) // n)
    return lst[::step][:n]


# ── tshark scoring ────────────────────────────────────────────────────────────

def score_tshark(pcap_path: Path) -> dict:
    """Run tshark, return dict with counts of valid/malformed/empty packets."""
    result = subprocess.run(
        [TSHARK, "-r", str(pcap_path), "-T", "json", "-n"],
        capture_output=True, text=True, timeout=60,
    )
    packets = []
    try:
        packets = json.loads(result.stdout) if result.stdout.strip() else []
    except json.JSONDecodeError:
        pass

    total    = len(packets)
    malformed = 0
    has_rrc  = 0
    rrc_fields = 0
    for pkt in packets:
        layers = pkt.get("_source", {}).get("layers", {})
        if "_ws.malformed" in layers or any("_ws.malformed" in str(v) for v in layers.values()):
            malformed += 1
        if "lte-rrc.dl_dcch_message_element" in layers or "lte-rrc" in str(list(layers.keys())):
            has_rrc += 1
            # count rrc-specific fields as a richness score
            rrc_fields += sum(1 for k in layers if k.startswith("lte-rrc"))

    valid = total - malformed
    return {
        "total": total,
        "malformed": malformed,
        "valid": valid,
        "has_rrc": has_rrc,
        "rrc_fields": rrc_fields,
        "score": valid * 10 + rrc_fields,
    }


# ── main probe loop ───────────────────────────────────────────────────────────

def probe() -> None:
    print("Loading B0C0 corpus ...")
    dl_bodies, ul_bodies = load_corpus()
    print(f"  DL: {len(dl_bodies)}, UL: {len(ul_bodies)}")

    dl_sample = sample(dl_bodies, SAMPLE_PER_COMBO)
    ul_sample = sample(ul_bodies, SAMPLE_PER_COMBO // 2)
    print(f"  Sampling {len(dl_sample)} DL + {len(ul_sample)} UL per combo")

    results = []

    combos = list(product(PDU_OFFSETS, DL_SUBTYPES, UL_SUBTYPES))
    total_combos = len(combos)
    print(f"\nTesting {total_combos} combinations …\n")

    for idx, (pdu_off, dl_sub, ul_sub) in enumerate(combos):
        tag = f"off{pdu_off}_dl{dl_sub}_ul{ul_sub}"
        combo_dir = OUTDIR / tag
        combo_dir.mkdir(exist_ok=True)
        pcap_path = combo_dir / "sample.pcap"

        # Build packet list
        frames = []
        for earfcn, body in dl_sample:
            pdu = body[pdu_off:]
            if not pdu:
                continue
            gsmtap = gsmtap_hdr(dl_sub, earfcn) + pdu
            frames.append(build_eth_ip_udp(gsmtap))

        for earfcn, body in ul_sample:
            pdu = body[pdu_off:]
            if not pdu:
                continue
            gsmtap = gsmtap_hdr(ul_sub, earfcn) + pdu
            frames.append(build_eth_ip_udp(gsmtap))

        if not frames:
            continue

        pcap_path.write_bytes(make_pcap(frames))

        sc = score_tshark(pcap_path)
        sc.update({
            "pdu_offset": pdu_off,
            "dl_subtype": dl_sub,
            "dl_channel": GSMTAP_LTE_RRC_SUBTYPES[dl_sub],
            "ul_subtype": ul_sub,
            "ul_channel": GSMTAP_LTE_RRC_SUBTYPES[ul_sub],
            "tag": tag,
        })
        results.append(sc)

        bar = "█" * int(20 * (idx + 1) / total_combos)
        pct = 100 * (idx + 1) // total_combos
        print(
            f"  [{bar:<20}] {pct:3d}%  {tag:<30}  "
            f"valid={sc['valid']:3d}/{sc['total']:3d}  "
            f"rrc_fields={sc['rrc_fields']:4d}  score={sc['score']:5d}",
            flush=True,
        )

    results.sort(key=lambda x: x["score"], reverse=True)

    print("\n\n── TOP 10 COMBINATIONS ─────────────────────────────────────────────────")
    print(f"{'rank':4}  {'pdu_off':7}  {'dl_chan':<15}  {'ul_chan':<12}  "
          f"{'valid':6}  {'malform':7}  {'rrc_fld':7}  {'score':6}")
    for i, r in enumerate(results[:10], 1):
        print(
            f"  {i:2d}   off={r['pdu_offset']}   {r['dl_channel']:<15}  "
            f"{r['ul_channel']:<12}  "
            f"{r['valid']:6d}  {r['malformed']:7d}  {r['rrc_fields']:7d}  {r['score']:6d}"
        )

    if results:
        best = results[0]
        best_path = OUTDIR / "best_combo.json"
        best_path.write_text(json.dumps(best, indent=2))
        print(f"\n✓ Best combo saved to {best_path}")
        print(f"  pdu_offset={best['pdu_offset']}, "
              f"dl_subtype={best['dl_subtype']} ({best['dl_channel']}), "
              f"ul_subtype={best['ul_subtype']} ({best['ul_channel']})")
        print(f"  score={best['score']}, valid={best['valid']}, "
              f"rrc_fields={best['rrc_fields']}, malformed={best['malformed']}")


if __name__ == "__main__":
    probe()

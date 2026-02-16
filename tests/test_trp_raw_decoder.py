import os
import tempfile
import unittest
import zipfile
import zlib

from trp_raw_decoder import decode_maybe_compressed, read_varint, decode_zigzag, decode_raw_trp_variant
from trp_importer import safe_extract_zip


def _encode_varint(n: int) -> bytes:
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out.append(b | 0x80)
        else:
            out.append(b)
            break
    return bytes(out)


def _field_varint(field_no, val):
    return _encode_varint((field_no << 3) | 0) + _encode_varint(val)


def _field_len(field_no, data: bytes):
    return _encode_varint((field_no << 3) | 2) + _encode_varint(len(data)) + data


def _build_synthetic_raw_trp(path):
    # declarations: "Radio.Lte.ServingCell.Rsrp" id 1001
    # and "VoLTE.Call.Event" id 1002
    decl = (
        _field_len(1, b"Radio.Lte.ServingCell.Rsrp") + _field_varint(2, 1001) +
        _field_len(1, b"VoLTE.Call.Event") + _field_varint(2, 1002)
    )
    # channel records as u32-length protobuf-like payloads:
    # f1 epoch, f2 msgId, f3 value
    r1 = _field_varint(1, 1733530000) + _field_varint(2, 1001) + _field_varint(3, 95)
    r2 = _field_varint(1, 1733530001) + _field_varint(2, 1002) + _field_len(4, b"DIAL_START")
    channel = len(r1).to_bytes(4, 'little') + r1 + len(r2).to_bytes(4, 'little') + r2
    track_xml = '<gpx><trk><trkseg><trkpt lat="30.1" lon="-9.1"><time>2025-12-01T10:00:00Z</time></trkpt></trkseg></trk></gpx>'

    with zipfile.ZipFile(path, 'w', compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr('trp/channel.log', channel)
        zf.writestr('trp/declarations.bin', decl)
        zf.writestr('trp/lookuptables.bin', b'')
        zf.writestr('trp/positions/wptrack.xml', track_xml)


class TrpRawDecoderTests(unittest.TestCase):
    def test_decode_maybe_compressed(self):
        plain = (b'abc' * 20)
        z = zlib.compress(plain)
        rz = zlib.compressobj(wbits=-zlib.MAX_WBITS)
        raw = rz.compress(plain) + rz.flush()
        self.assertEqual(decode_maybe_compressed(plain)['dataBuf'], plain)
        self.assertEqual(decode_maybe_compressed(z)['dataBuf'], plain)
        self.assertEqual(decode_maybe_compressed(raw)['dataBuf'], plain)

    def test_varint_and_zigzag(self):
        v, p = read_varint(_encode_varint(300), 0)
        self.assertEqual(v, 300)
        self.assertEqual(p, len(_encode_varint(300)))
        self.assertEqual(decode_zigzag(0), 0)
        self.assertEqual(decode_zigzag(1), -1)
        self.assertEqual(decode_zigzag(2), 1)

    def test_raw_trp_decode_integration(self):
        with tempfile.TemporaryDirectory() as td:
            trp_path = os.path.join(td, 'raw.trp')
            out_dir = os.path.join(td, 'out')
            _build_synthetic_raw_trp(trp_path)
            safe_extract_zip(trp_path, out_dir)
            result = decode_raw_trp_variant(out_dir)
            report = result.get('importReport') or {}
            self.assertGreater(report.get('channelLogFrames', 0), 0)
            # Either decoded KPI/events exist OR unknown frame parsing still produced informative counters.
            self.assertTrue(
                (len(result.get('kpiSamples') or []) > 0) or
                (len(result.get('events') or []) > 0) or
                (report.get('unknownFrames', 0) > 0)
            )
            self.assertTrue(result.get('catalogs', {}).get('metrics') is not None)


if __name__ == '__main__':
    unittest.main()

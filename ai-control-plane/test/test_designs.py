#!/usr/bin/env python3
"""Offline tests for the track design decoder (td6.py) and design library (designs.py).

    python3 test_designs.py

The designs are synthetic files written by make_td6(), which encodes the same layout the game uses.
"""

import os
import struct
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "mcp"))

import designs  # noqa: E402
import td6  # noqa: E402


def encode_rle(data):
    """Literal-only SawyerCoding RLE (valid input for DecodeChunkRLE)."""
    out = bytearray()
    for i in range(0, len(data), 128):
        chunk = data[i:i + 128]
        out.append(len(chunk) - 1)
        out.extend(chunk)
    return bytes(out)


def add_checksum(encoded):
    checksum = 0
    for b in encoded:
        checksum = (checksum & 0xFFFFFF00) | (((checksum & 0xFF) + b) & 0xFF)
        checksum = ((checksum << 3) | (checksum >> 29)) & 0xFFFFFFFF
    return encoded + struct.pack("<I", (checksum - 0x1D4C1) & 0xFFFFFFFF)


def make_td6(ride_type=15, vehicle="ARRX", elements=(), entrances=(), excitement=65, trains=2):
    header = bytearray(td6.HEADER_SIZE)
    header[0] = ride_type
    header[6] = 5  # ride mode
    header[7] = td6.VERSION_TD6 << 2
    header[0x4C] = trains
    header[0x4D] = 5
    header[0x5B] = excitement
    header[0x5C] = 48
    header[0x5D] = 30
    struct.pack_into("<I8sI", header, 0x70, 0, vehicle.ljust(8).encode("latin-1"), 0)
    header[0x80] = 12
    header[0x81] = 7
    body = bytearray(header)
    for track_type, flags in elements:
        body += bytes([track_type, flags])
    body.append(0xFF)
    for z, direction, x, y, is_exit in entrances:
        body += struct.pack("<bBhh", z, direction | (0x80 if is_exit else 0), x, y)
    body.append(0xFF)
    body.append(0xFF)  # no scenery
    return add_checksum(encode_rle(bytes(body)))


STATION = [(2, 0), (3, 0), (3, 0), (1, 0)]
COASTER = STATION + [(6, 0x80), (4, 0x80), (9, 0x80), (12, 0), (15, 0), (16, 0)]


class Td6Test(unittest.TestCase):
    def test_decode(self):
        raw = make_td6(elements=COASTER, entrances=[(0, 1, 32, -32, False), (-128, 1, 64, -32, True)])
        self.assertTrue(td6.checksum_ok(raw))
        d = td6.decode(raw, "Test")
        self.assertEqual(d["rct2RideType"], 15)
        self.assertEqual(d["vehicleObject"].strip(), "ARRX")
        self.assertEqual(d["version"], "td6")
        self.assertEqual(d["excitement"], 6.5)
        self.assertEqual(d["numberOfTrains"], 2)
        self.assertEqual([e["type"] for e in d["trackElements"]], [t for t, _ in COASTER])
        self.assertEqual([e["chain"] for e in d["trackElements"]][4:7], [True, True, True])
        self.assertEqual(d["entrances"][0], {"x": 32, "y": -32, "z": 0, "direction": 1, "isExit": False})
        self.assertEqual(d["entrances"][1]["z"], -1)  # -128 is stored as -1, as the game's importer does
        self.assertTrue(d["entrances"][1]["isExit"])
        self.assertEqual(d["spaceRequired"], {"x": 12, "y": 7})

    def test_checksum_detects_corruption(self):
        raw = bytearray(make_td6(elements=COASTER))
        raw[5] ^= 0x01
        self.assertFalse(td6.checksum_ok(bytes(raw)))

    def test_flat_ride_alias(self):
        d = td6.decode(make_td6(ride_type=46, vehicle="TWIST1", elements=[(123, 0)]), "Twist")
        self.assertTrue(d["isFlatRide"])
        self.assertEqual(d["trackElements"][0]["type"], 266)

    def test_rejects_garbage(self):
        with self.assertRaises(td6.TrackDesignError):
            td6.decode(b"\x01\x02", "x")

    def test_truncated_lists_are_a_design_error(self):
        # A track list with no 0xFF terminator (e.g. a half-downloaded file).
        header = bytearray(td6.HEADER_SIZE)
        header[0] = 15
        header[7] = td6.VERSION_TD6 << 2
        raw = add_checksum(encode_rle(bytes(header) + bytes([2, 0, 3, 0])))
        with self.assertRaises(td6.TrackDesignError):
            td6.decode(raw, "Truncated")

    def test_mini_golf_holes_are_not_inversions(self):
        raw = bytearray(make_td6(ride_type=td6.RIDE_TYPE_MINI_GOLF, vehicle="MGOLF", elements=STATION))
        body = bytearray(td6.decode_rle(bytes(raw[:-4])))
        body[0x58] = 9  # nine holes
        d = td6.decode(add_checksum(encode_rle(bytes(body))), "Golf")
        self.assertEqual(d["inversions"], 0)
        self.assertEqual(d["holes"], 9)

    def test_to_layout(self):
        layout = td6.to_layout(td6.decode(make_td6(elements=COASTER), "Test"))
        self.assertEqual(layout["name"], "Test")
        self.assertEqual(layout["rct2RideType"], 15)
        self.assertEqual(len(layout["trackElements"]), len(COASTER))
        self.assertEqual(layout["settings"]["numberOfTrains"], 2)
        self.assertEqual(len(layout["colours"]["vehicles"]), 32)


class DesignLibraryTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.saved = {k: os.environ.get(k) for k in ("OPENRCT2_TRACK_DIRS", "OPENRCT2_USER_DIR")}
        os.environ["OPENRCT2_TRACK_DIRS"] = self.tmp.name
        os.environ["OPENRCT2_USER_DIR"] = os.path.join(self.tmp.name, "no-user-dir")
        for name, kwargs in [("Loopy Lou", {}), ("Loopy Lou II", {}), ("Wild Wood", {"ride_type": 52, "vehicle": "PTCT1"}),
                             ("Mr. Bones", {}), ("Mr. Freeze", {})]:
            with open(os.path.join(self.tmp.name, name + ".td6"), "wb") as f:
                f.write(make_td6(elements=COASTER, **kwargs))
        with open(os.path.join(self.tmp.name, "broken.td6"), "wb") as f:
            f.write(b"not a design")
        header = bytearray(td6.HEADER_SIZE)
        header[0] = 15
        header[7] = td6.VERSION_TD6 << 2
        with open(os.path.join(self.tmp.name, "truncated.td6"), "wb") as f:
            f.write(add_checksum(encode_rle(bytes(header) + bytes([2, 0, 3, 0]))))
        self.library = designs.DesignLibrary()

    def tearDown(self):
        for k, v in self.saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        self.tmp.cleanup()

    def test_lists_valid_designs(self):
        names = sorted(d["name"] for d in self.library.all())
        self.assertEqual(names, ["Loopy Lou", "Loopy Lou II", "Mr. Bones", "Mr. Freeze", "Wild Wood"])

    def test_find(self):
        self.assertEqual(self.library.find("loopy lou")["name"], "Loopy Lou")
        self.assertEqual(self.library.find("wild")["name"], "Wild Wood")
        self.assertEqual(self.library.find(os.path.join(self.tmp.name, "Wild Wood.td6"))["name"], "Wild Wood")
        with self.assertRaisesRegex(ValueError, "several designs"):
            self.library.find("Loopy")
        with self.assertRaisesRegex(ValueError, "No track design"):
            self.library.find("Nope")
        # Names with dots are matched whole, with or without the file extension.
        self.assertEqual(self.library.find("Mr. Bones")["name"], "Mr. Bones")
        self.assertEqual(self.library.find("mr. freeze.TD6")["name"], "Mr. Freeze")

    def test_availability(self):
        design = self.library.find("Wild Wood")
        own = {"object": 4, "legacyIdentifier": "PTCT1   ", "rideType": 52, "name": "Wooden Trains"}
        other = {"object": 5, "legacyIdentifier": "PTCT2", "rideType": 52, "name": "Reversed Trains"}
        looping = {"object": 6, "legacyIdentifier": "ARRX", "rideType": 15, "name": "Looping Trains"}
        self.assertEqual(designs.availability(design, [looping, other, own]), ("yes", own))
        self.assertEqual(designs.availability(design, [looping, other]), ("substitute vehicle", other))
        self.assertEqual(designs.availability(design, [looping]), ("no", None))

    def test_ride_type_label(self):
        self.assertEqual(designs.ride_type_label(15), "looping roller coaster")
        self.assertEqual(designs.ride_type_label(29), "ride type 29")


if __name__ == "__main__":
    unittest.main()

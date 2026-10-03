#!/usr/bin/env python3
"""Regenerate the ride data block embedded in plugin/ai-control-plane.js.

The plugin API does not expose ride type descriptors (flat ride or not, start piece, which track
groups a ride type can build) or track sequence flags (which sides of a ride accept entrances), so
they are dumped from the game with dump_ride_data.cpp and embedded in the plugin:

    # build the dumper against an OpenRCT2 build tree (see ../README.md, "Regenerating ride data")
    ./dump_ride_data > ride_data.json
    python3 gen_ride_data.py ride_data.json

Enum names are read from the game's headers so the indices always match the dump.
"""

import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.normpath(os.path.join(HERE, "..", ".."))
PLUGIN = os.path.join(HERE, "..", "plugin", "ai-control-plane.js")
BEGIN = "    // <generated-ride-data>"
END = "    // </generated-ride-data>"
CATEGORIES = ["transport", "gentle", "rollercoaster", "thrill", "water", "shop"]


def enum_names(header, enum):
    text = open(os.path.join(REPO, header), encoding="utf-8").read()
    body = re.search(r"enum class " + enum + r"\s*:\s*\w+\s*\{(.*?)\};", text, re.S).group(1)
    body = re.sub(r"//.*", "", body)
    names = []
    for item in body.split(","):
        item = item.strip()
        if not item:
            continue
        name = item.split("=")[0].strip()
        if name != "count":
            names.append(name)
    return names


def track_type_names(count):
    text = open(os.path.join(REPO, "src/openrct2/ride/ted/TrackElemType.h"), encoding="utf-8").read()
    body = re.search(r"enum class TrackElemType\s*:\s*\w+\s*\{(.*?)\};", text, re.S).group(1)
    body = re.sub(r"//.*", "", body)
    names = [None] * count
    for item in body.split(","):
        if "=" not in item:
            continue
        name, value = (part.strip() for part in item.split("=", 1))
        value = int(value, 0)
        if value < count and names[value] is None:
            names[value] = name
    missing = [i for i, n in enumerate(names) if n is None]
    if missing:
        sys.exit(f"TrackElemType names missing for {missing[:10]}")
    return names


def main():
    data = json.load(open(sys.argv[1]) if len(sys.argv) > 1 else sys.stdin)
    flags = enum_names("src/openrct2/ride/RideData.h", "RtdFlag")
    groups = enum_names("src/openrct2/ride/ted/TrackGroup.h", "TrackGroup")
    if len(groups) != data["trackGroupCount"]:
        sys.exit(f"TrackGroup mismatch: header has {len(groups)}, dump has {data['trackGroupCount']}")
    if max(max(r["flags"] or [0]) for r in data["rideTypes"]) >= len(flags):
        sys.exit("RtdFlag mismatch between header and dump")

    rows = []
    for r in data["rideTypes"]:
        lo = sum(1 << f for f in r["flags"] if f < 32)
        hi = sum(1 << (f - 32) for f in r["flags"] if f >= 32)
        rows.append(json.dumps([r["name"], r["category"], r["start"], lo, hi, r["groups"], r["extra"],
                                r["maxHeight"], r["liftMin"], r["liftMax"], r["special"]], separators=(",", ":")))

    lines = [BEGIN + " (tools/gen_ride_data.py; do not edit by hand)"]
    lines.append("    const RIDE_CATEGORIES = " + json.dumps(CATEGORIES) + ";")
    lines.append("    const RTD_FLAGS = {")
    for i, name in enumerate(flags):
        lines.append(f"        {name}: {i},")
    lines.append("    };")
    lines.append("    const TRACK_GROUPS = [")
    for i in range(0, len(groups), 6):
        lines.append("        " + ", ".join(json.dumps(g) for g in groups[i:i + 6]) + ",")
    lines.append("    ];")
    lines.append("    // Index = ride type id: [name, category, startPiece, flagsLow, flagsHigh, trackGroups, extraTrackGroups,")
    lines.append("    //                       maxHeight, liftSpeedMin, liftSpeedMax, specialType]")
    lines.append("    const RIDE_TYPE_DATA = [")
    for row in rows:
        lines.append("        " + row + ",")
    lines.append("    ];")
    names = track_type_names(data["trackTypeCount"])
    lines.append("    // Index = track type (TrackElemType) id")
    lines.append("    const TRACK_TYPE_NAMES = [")
    for i in range(0, len(names), 6):
        lines.append("        " + ", ".join(json.dumps(n) for n in names[i:i + 6]) + ",")
    lines.append("    ];")
    lines.append("    // Track type -> per-sequence flags (bits 0-3: entrance connection sides, bit 4: origin, bit 5: connects to path)")
    lines.append("    const TRACK_SEQUENCE_FLAGS = " + json.dumps({int(k): v for k, v in data["sequenceFlags"].items()},
                                                            separators=(",", ":")).replace('"', "") + ";")
    lines.append(END)

    src = open(PLUGIN, encoding="utf-8").read()
    if BEGIN in src:
        start = src.index(BEGIN)
        end = src.index(END) + len(END)
        src = src[:start] + "\n".join(lines) + src[end:]
    else:
        anchor = "    // ------------------------------------------------------------------\n    // Settings, logging"
        src = src.replace(anchor, "\n".join(lines) + "\n\n" + anchor, 1)
    open(PLUGIN, "w", encoding="utf-8").write(src)
    print(f"Wrote {len(rows)} ride types, {len(groups)} track groups, {len(data['sequenceFlags'])} sequence flag entries")


if __name__ == "__main__":
    main()

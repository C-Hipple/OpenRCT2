"""Decoder for RollerCoaster Tycoon 2 / OpenRCT2 track design files (.td6 and .td7).

Mirrors src/openrct2/rct2/T6Importer.cpp and src/openrct2/sawyer_coding/SawyerCoding.cpp so that the
MCP bridge can read the player's installed track designs (the game's plugin API cannot read files) and
hand the plugin a list of track pieces to build.

Track types are returned in OpenRCT2's TrackElemType numbering. Ride types are returned in RCT2
numbering; a few RCT2 types map to different OpenRCT2 types depending on the vehicle, so the plugin
resolves the final ride type from the vehicle object (see RCT2RideTypeToOpenRCT2RideType).
"""

import os
import struct

HEADER_SIZE = 0xA3
VERSION_TD6 = 2  # TD46Version::td6
VERSION_TD7 = 3  # TD46Version::td7

RIDE_TYPE_MAZE = 20
RIDE_TYPE_MINI_GOLF = 67
RIDE_TYPE_STEEL_WILD_MOUSE = 54

# RCT12 flat ride track aliases -> OpenRCT2 TrackElemType (RCT12FlatTrackTypeToOpenRCT2).
FLAT_TRACK_ALIASES = {95: 257, 110: 258, 111: 259, 115: 260, 116: 261, 118: 262, 119: 263, 121: 264, 122: 265, 123: 266}
WILD_MOUSE_ALIAS = (100, 256)  # Booster ID is shared with the spinning control toggle.
INVERTED_QUARTER_LOOP_ALIAS = (101, 255)
STATION_TYPES = {1, 2, 3}
BLOCK_BRAKES = 216
SPEED_SETTING_TYPES = {99, 100, 216, 337, 338, 339, 340, 349}
DEFAULT_BRAKE_SPEED = 2  # kRCT2DefaultBlockBrakeSpeed
DEFAULT_SEAT_ROTATION = 4


class TrackDesignError(ValueError):
    pass


def decode_rle(data):
    """SawyerCoding DecodeChunkRLE."""
    out = bytearray()
    i = 0
    n = len(data)
    while i < n:
        code = data[i]
        if code & 0x80:
            i += 1
            if i >= n:
                raise TrackDesignError("truncated RLE run")
            out.extend(bytes([data[i]]) * (257 - code))
            i += 1
        else:
            out.extend(data[i + 1:i + 2 + code])
            i += code + 2
    return bytes(out)


def checksum_ok(raw):
    """ValidateTrackChecksum: true for valid .td6/.td4 files."""
    if len(raw) < 4:
        return False
    expected = struct.unpack_from("<I", raw, len(raw) - 4)[0]
    checksum = 0
    for b in raw[:-4]:
        checksum = (checksum & 0xFFFFFF00) | (((checksum & 0xFF) + b) & 0xFF)
        checksum = ((checksum << 3) | (checksum >> 29)) & 0xFFFFFFFF
    return any(((checksum - k) & 0xFFFFFFFF) == expected for k in (0x1D4C1, 0x1A67C, 0x1A650))


def _convert_track_type(raw_type, rct2_ride_type, flat_ride):
    if raw_type == INVERTED_QUARTER_LOOP_ALIAS[0]:
        return INVERTED_QUARTER_LOOP_ALIAS[1]
    if flat_ride:
        return FLAT_TRACK_ALIASES.get(raw_type, raw_type)
    if rct2_ride_type == RIDE_TYPE_STEEL_WILD_MOUSE and raw_type == WILD_MOUSE_ALIAS[0]:
        return WILD_MOUSE_ALIAS[1]
    return raw_type


def _element(track_type, flags, version):
    """convertFromTD46Flags."""
    e = {
        "type": track_type,
        "chain": bool(flags & 0x80),
        "inverted": bool(flags & 0x40),
        "colourScheme": (flags & 0x30) >> 4,
        "station": 0,
        "brakeSpeed": DEFAULT_BRAKE_SPEED,
        "seatRotation": DEFAULT_SEAT_ROTATION,
    }
    if track_type in STATION_TYPES:
        e["station"] = flags & 0x03
    elif track_type in SPEED_SETTING_TYPES and (track_type != BLOCK_BRAKES or version == VERSION_TD7):
        e["brakeSpeed"] = (flags & 0x0F) << 1
    else:
        e["seatRotation"] = flags & 0x0F
    return e


def decode(raw, name=None):
    """Decode the bytes of a .td6/.td7 file into a JSON-friendly dict."""
    if len(raw) < 8:
        raise TrackDesignError("file too small")
    data = decode_rle(raw[:-4])
    if len(data) < HEADER_SIZE:
        raise TrackDesignError("track design header is truncated")

    version = data[7] >> 2
    if version not in (VERSION_TD6, VERSION_TD7):
        raise TrackDesignError(f"unsupported track design version {version} (TD4 designs are not supported)")
    rct2_ride_type = data[0]
    vehicle_flags, vehicle_name, vehicle_checksum = struct.unpack_from("<I8sI", data, 0x70)
    design = {
        "name": name,
        "version": "td7" if version == VERSION_TD7 else "td6",
        "rct2RideType": rct2_ride_type,
        "vehicleObject": vehicle_name.decode("latin-1"),
        "vehicleObjectFlags": vehicle_flags,
        "vehicleObjectChecksum": vehicle_checksum,
        "rideMode": data[6],
        "vehicleColourSettings": data[7] & 0x03,
        "vehicleColours": [
            {"body": data[8 + i * 2], "trim": data[9 + i * 2], "tertiary": data[0x82 + i]} for i in range(32)
        ],
        "entranceStyle": data[0x49],
        "departFlags": data[0x4B],
        "numberOfTrains": data[0x4C],
        "carsPerTrain": data[0x4D],
        "minWaitingTime": data[0x4E],
        "maxWaitingTime": data[0x4F],
        "operationSetting": data[0x50],
        "maxSpeed": struct.unpack_from("<b", data, 0x51)[0],
        "averageSpeed": struct.unpack_from("<b", data, 0x52)[0],
        "rideLength": struct.unpack_from("<H", data, 0x53)[0],
        # Mini golf stores its hole count where coasters store inversions.
        "inversions": 0 if rct2_ride_type == RIDE_TYPE_MINI_GOLF else data[0x58] & 0x1F,
        "holes": data[0x58] & 0x1F if rct2_ride_type == RIDE_TYPE_MINI_GOLF else None,
        "drops": data[0x59] & 0x3F,
        "highestDropHeight": data[0x5A],
        # Ratings are stored divided by 10; OpenRCT2 keeps them * 100 (e.g. 652 = 6.52).
        "excitement": data[0x5B] / 10,
        "intensity": data[0x5C] / 10,
        "nausea": data[0x5D] / 10,
        "trackColours": [
            {"main": data[0x60 + i], "additional": data[0x64 + i], "supports": data[0x68 + i]} for i in range(4)
        ],
        "spaceRequired": {"x": data[0x80], "y": data[0x81]},
        "liftHillSpeed": data[0xA2] & 0x1F,
        "numCircuits": data[0xA2] >> 5,
        "isMaze": rct2_ride_type == RIDE_TYPE_MAZE,
        "trackElements": [],
        "entrances": [],
        "mazeElements": [],
        "sceneryCount": 0,
    }

    try:
        _decode_lists(data, design, version, rct2_ride_type)
    except (IndexError, struct.error):
        raise TrackDesignError("track design data is truncated") from None
    return design


def _decode_lists(data, design, version, rct2_ride_type):
    """Track, maze, entrance and scenery lists after the header (raises IndexError/struct.error if truncated)."""
    pos = HEADER_SIZE
    if design["isMaze"]:
        while True:
            if pos + 4 > len(data):
                raise TrackDesignError("maze element list is truncated")
            if struct.unpack_from("<I", data, pos)[0] == 0:
                pos += 4
                break
            x, y, direction, kind = struct.unpack_from("<bbBB", data, pos)
            if kind in (0x08, 0x80):
                # Maze entrances/exits share the list: tile coordinates, direction, 0x08 entrance / 0x80 exit.
                design["entrances"].append({"x": x * 32, "y": y * 32, "z": 0, "direction": direction, "isExit": kind == 0x80})
            else:
                design["mazeElements"].append({"x": x, "y": y, "entry": struct.unpack_from("<H", data, pos + 2)[0]})
            pos += 4
    else:
        raw_elements = []
        if version == VERSION_TD7:
            while struct.unpack_from("<H", data, pos)[0] != 0xFFFF:
                raw_elements.append(struct.unpack_from("<HB", data, pos))
                pos += 3
            pos += 2
        else:
            while data[pos] != 0xFF:
                raw_elements.append((data[pos], data[pos + 1]))
                pos += 2
            pos += 1
        # A flat ride design is its single flat track piece; the aliases only apply to those.
        flat_ride = version == VERSION_TD6 and len(raw_elements) == 1 and raw_elements[0][0] in FLAT_TRACK_ALIASES
        for raw_type, flags in raw_elements:
            track_type = raw_type if version == VERSION_TD7 else _convert_track_type(raw_type, rct2_ride_type, flat_ride)
            design["trackElements"].append(_element(track_type, flags, version))
        design["isFlatRide"] = flat_ride

        while data[pos] != 0xFF:
            z, direction, x, y = struct.unpack_from("<bBhh", data, pos)
            design["entrances"].append({
                # x/y are world units relative to the first track piece; z is in height units (8 world z) relative
                # to the first piece. The importer stores -128 as -1 (T6Importer.cpp), so do the same.
                "x": x, "y": y,
                "z": -1 if z == -128 else z,
                "direction": direction & 0x0F,
                "isExit": bool(direction >> 7),
            })
            pos += 6
        pos += 1

    while pos < len(data) and data[pos] != 0xFF:
        design["sceneryCount"] += 1
        pos += 22


def load(path):
    with open(path, "rb") as f:
        raw = f.read()
    name = os.path.splitext(os.path.basename(path))[0]
    design = decode(raw, name)
    design["path"] = path
    design["checksumOk"] = checksum_ok(raw)
    return design


def summarise(design):
    """Short description used when listing designs."""
    s = {k: design.get(k) for k in (
        "name", "path", "version", "rct2RideType", "vehicleObject", "excitement", "intensity", "nausea",
        "maxSpeed", "rideLength", "inversions", "holes", "drops", "spaceRequired", "isMaze", "isFlatRide")}
    s["pieces"] = len(design["trackElements"]) or len(design["mazeElements"])
    return s


def to_layout(design):
    """The layout object the plugin's place_track_layout expects."""
    return {
        "name": design.get("name"),
        "vehicleObject": design["vehicleObject"],
        "rct2RideType": design["rct2RideType"],
        "trackElements": design["trackElements"],
        "entrances": design["entrances"],
        "mazeElements": design["mazeElements"],
        "entranceStyle": design["entranceStyle"],
        "settings": {
            "rideMode": design["rideMode"],
            "numberOfTrains": design["numberOfTrains"],
            "carsPerTrain": design["carsPerTrain"],
            "departFlags": design["departFlags"],
            "minWaitingTime": design["minWaitingTime"],
            "maxWaitingTime": design["maxWaitingTime"],
            "operationSetting": design["operationSetting"],
            "liftHillSpeed": design["liftHillSpeed"],
            "numCircuits": design["numCircuits"],
        },
        "colours": {
            "track": design["trackColours"],
            "vehicles": design["vehicleColours"],
            "vehicleColourSettings": design["vehicleColourSettings"],
        },
    }

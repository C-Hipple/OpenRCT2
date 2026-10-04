"""Finds and indexes the player's installed track designs for the MCP bridge.

OpenRCT2 reads track designs from the RCT2 install's Tracks folder (``game_path`` in config.ini) and from
the ``track`` folder in the OpenRCT2 user folder (see TrackDesignRepository.cpp). The plugin cannot read
files, so the bridge decodes designs (td6.py) and sends the plugin a layout to build.
"""

import os
import platform

import td6

# RCT2 ride types that OpenRCT2 splits by vehicle (RCT2RideTypeToOpenRCT2RideType).
RIDE_TYPE_VARIANTS = {19: (19, 91), 4: (4, 95), 11: (11, 93), 51: (51, 92), 54: (54, 94)}

# RCT2 ride type ids (as stored in TD6 files) -> OpenRCT2 ride type names.
RCT2_RIDE_TYPE_NAMES = [
    "spiral_rc", "stand_up_rc", "suspended_swinging_rc", "inverted_rc", "junior_rc", "miniature_railway", "monorail",
    "mini_suspended_rc", "boat_hire", "wooden_wild_mouse", "steeplechase", "car_ride", "launched_freefall",
    "bobsleigh_rc", "observation_tower", "looping_rc", "dinghy_slide", "mine_train_rc", "chairlift", "corkscrew_rc",
    "maze", "spiral_slide", "go_karts", "log_flume", "river_rapids", "dodgems", "swinging_ship",
    "swinging_inverter_ship", "food_stall", "invalid", "drink_stall", "invalid", "shop", "merry_go_round", "invalid",
    "information_kiosk", "toilets", "ferris_wheel", "motion_simulator", "3d_cinema", "top_spin", "space_rings",
    "reverse_freefall_rc", "lift", "vertical_drop_rc", "cash_machine", "twist", "haunted_house", "first_aid",
    "circus", "ghost_train", "twister_rc", "wooden_rc", "side_friction_rc", "steel_wild_mouse", "multi_dimension_rc",
    "multi_dimension_rc_alt", "flying_rc", "flying_rc_alt", "virginia_reel", "splash_boats", "mini_helicopters",
    "lay_down_rc", "suspended_monorail", "lay_down_rc_alt", "reverser_rc", "heartline_twister_rc", "mini_golf",
    "giga_rc", "roto_drop", "flying_saucers", "crooked_house", "monorail_cycles", "compact_inverted_rc",
    "water_coaster", "air_powered_vertical_rc", "inverted_hairpin_rc", "magic_carpet", "submarine_ride",
    "river_rafts", "invalid", "enterprise", "invalid", "invalid", "invalid", "invalid", "inverted_impulse_rc",
    "mini_rc", "mine_ride", "invalid", "lim_launched_rc",
]


def ride_type_label(rct2_ride_type):
    """Readable ride type, e.g. 'looping roller coaster'."""
    if 0 <= rct2_ride_type < len(RCT2_RIDE_TYPE_NAMES) and RCT2_RIDE_TYPE_NAMES[rct2_ride_type] != "invalid":
        name = RCT2_RIDE_TYPE_NAMES[rct2_ride_type]
        if name.endswith("_rc"):
            name = name[:-3] + "_roller_coaster"
        return name.replace("_", " ")
    return f"ride type {rct2_ride_type}"


def default_user_dir():
    if os.environ.get("OPENRCT2_USER_DIR"):
        return os.environ["OPENRCT2_USER_DIR"]
    home = os.path.expanduser("~")
    system = platform.system()
    if system == "Windows":
        candidates = [os.path.join(home, "Documents", "OpenRCT2"), os.path.join(home, "OneDrive", "Documents", "OpenRCT2")]
    elif system == "Darwin":
        candidates = [os.path.join(home, "Library", "Application Support", "OpenRCT2")]
    else:
        xdg = os.environ.get("XDG_CONFIG_HOME") or os.path.join(home, ".config")
        candidates = [os.path.join(xdg, "OpenRCT2"),
                      os.path.join(home, ".var", "app", "io.openrct2.OpenRCT2", "config", "OpenRCT2")]
    for c in candidates:
        if os.path.isdir(c):
            return c
    return candidates[0]


def _ini_value(raw):
    raw = raw.strip()
    if len(raw) >= 2 and raw[0] == raw[-1] == '"':
        raw = raw[1:-1].replace('\\"', '"').replace("\\\\", "\\")
    return raw


def read_config(user_dir):
    """The [general] section of OpenRCT2's config.ini as a dict."""
    values = {}
    path = os.path.join(user_dir, "config.ini")
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            section = None
            for line in f:
                line = line.strip()
                if line.startswith("[") and line.endswith("]"):
                    section = line[1:-1].strip().lower()
                elif section == "general" and "=" in line:
                    key, value = line.split("=", 1)
                    values[key.strip()] = _ini_value(value)
    except OSError:
        pass
    return values


def design_dirs():
    """Folders that may hold track designs, most specific first."""
    dirs = []
    for extra in os.environ.get("OPENRCT2_TRACK_DIRS", "").split(os.pathsep):
        if extra:
            dirs.append(extra)
    user_dir = default_user_dir()
    dirs.append(os.path.join(user_dir, "track"))
    game_path = read_config(user_dir).get("game_path")
    if game_path:
        dirs.append(os.path.join(game_path, "Tracks"))
        dirs.append(os.path.join(game_path, "Assets"))  # RollerCoaster Tycoon Classic
        # RollerCoaster Tycoon Classic on macOS keeps its data inside the app bundle.
        for app in ("RCT Classic.app", "RCT Classic+.app"):
            dirs.append(os.path.join(game_path, app, "Contents", "Resources"))
    seen = []
    for d in dirs:
        if os.path.isdir(d) and os.path.normcase(os.path.abspath(d)) not in [os.path.normcase(os.path.abspath(s)) for s in seen]:
            seen.append(d)
    return seen


class DesignLibrary:
    """Decodes design files once and remembers them (re-reading files that changed)."""

    def __init__(self):
        self._cache = {}

    def _load(self, path):
        try:
            stat = os.stat(path)
        except OSError:
            return None
        key = (stat.st_mtime, stat.st_size)
        hit = self._cache.get(path)
        if hit and hit[0] == key:
            return hit[1]
        try:
            design = td6.load(path)
        except Exception as e:  # one unreadable file must not hide every other design
            design = {"path": path, "name": os.path.splitext(os.path.basename(path))[0], "error": str(e) or repr(e)}
        self._cache[path] = (key, design)
        return design

    def all(self):
        designs = []
        for d in design_dirs():
            for root, _dirs, files in os.walk(d):
                for name in sorted(files):
                    if name.lower().endswith((".td6", ".td7")):
                        design = self._load(os.path.join(root, name))
                        if design and not design.get("error"):
                            designs.append(design)
        return designs

    def find(self, ref):
        """A design by file path, exact name, or unique name fragment."""
        if os.path.isfile(ref):
            design = self._load(ref)
            if design is None or design.get("error"):
                raise ValueError(f"Could not read track design {ref}: {design and design.get('error')}")
            return design
        # Names can contain dots ("Mr. Bones"), so only strip a design file extension.
        needle = os.path.basename(ref).strip()
        if needle.lower().endswith((".td6", ".td7", ".td4")):
            needle = needle[:-4]
        needle = needle.lower()
        designs = self.all()
        exact = [d for d in designs if d["name"].lower() == needle]
        if exact:
            return exact[0]
        partial = [d for d in designs if needle in d["name"].lower()]
        if len(partial) == 1:
            return partial[0]
        if not partial:
            raise ValueError(f'No track design called "{ref}". Use list_track_designs to see what is installed.')
        names = ", ".join(d["name"] for d in partial[:10])
        raise ValueError(f'"{ref}" matches several designs: {names}. Be more specific.')


def availability(design, buildable):
    """How the park can build a design: with its own vehicle, a substitute of the same ride type, or not at all.

    buildable: list_buildable_rides output (with legacyIdentifier and rideType).
    """
    legacy = design["vehicleObject"].strip().lower()
    for option in buildable:
        if (option.get("legacyIdentifier") or "").strip().lower() == legacy:
            return "yes", option
    types = RIDE_TYPE_VARIANTS.get(design["rct2RideType"], (design["rct2RideType"],))
    for option in buildable:
        if option["rideType"] in types:
            return "substitute vehicle", option
    return "no", None

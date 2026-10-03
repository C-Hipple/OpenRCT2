#!/usr/bin/env python3
"""MCP server that lets an AI agent (Claude Code, Claude Desktop, ...) control a running OpenRCT2 game.

It speaks the Model Context Protocol over stdio and forwards tool calls to the
"AI Control Plane" plugin running inside OpenRCT2, which listens on a localhost
TCP socket. Python 3.8+ standard library only; nothing to install.

Usage:
    openrct2_mcp.py                      run as an MCP stdio server (what agents launch)
    openrct2_mcp.py call <method> [json] call a plugin method directly and print the result
    openrct2_mcp.py map <x1> <y1> <x2> <y2>  print an ASCII map of a region

Environment:
    OPENRCT2_AI_HOST   plugin host (default 127.0.0.1)
    OPENRCT2_AI_PORT   plugin port (default 8765)
    OPENRCT2_AI_TOKEN  shared token, if one is configured in the plugin
"""

import json
import os
import socket
import sys
import threading

SERVER_NAME = "openrct2"
SERVER_VERSION = "1.0.0"
SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]

DEFAULT_HOST = os.environ.get("OPENRCT2_AI_HOST", "127.0.0.1")
DEFAULT_PORT = int(os.environ.get("OPENRCT2_AI_PORT", "8765"))
DEFAULT_TOKEN = os.environ.get("OPENRCT2_AI_TOKEN", "")


class GameError(Exception):
    """An error reported by the game plugin (or a failure to reach it)."""

    def __init__(self, message, data=None):
        super().__init__(message)
        self.data = data


class GameClient:
    """Newline-delimited JSON-RPC client for the in-game plugin. Reconnects automatically."""

    def __init__(self, host=DEFAULT_HOST, port=DEFAULT_PORT, token=DEFAULT_TOKEN, timeout=120.0):
        self.host = host
        self.port = port
        self.token = token
        self.timeout = timeout
        self._sock = None
        self._buffer = b""
        self._next_id = 1
        self._lock = threading.Lock()

    def _connect(self):
        try:
            self._sock = socket.create_connection((self.host, self.port), timeout=5)
        except OSError as e:
            self._sock = None
            raise GameError(
                f"Could not connect to OpenRCT2 at {self.host}:{self.port} ({e}). Make sure the game is running "
                "with the AI Control Plane plugin installed (it starts listening as soon as the game starts)."
            ) from None
        self._sock.settimeout(self.timeout)
        self._buffer = b""

    def close(self):
        if self._sock is not None:
            try:
                self._sock.close()
            except OSError:
                pass
        self._sock = None

    def _read_line(self):
        while b"\n" not in self._buffer:
            chunk = self._sock.recv(1 << 16)
            if not chunk:
                raise ConnectionError("connection closed by the game")
            self._buffer += chunk
        line, self._buffer = self._buffer.split(b"\n", 1)
        return line

    def call(self, method, params=None):
        with self._lock:
            for attempt in range(2):
                if self._sock is None:
                    self._connect()
                request_id = self._next_id
                self._next_id += 1
                request = {"id": request_id, "method": method, "params": params or {}}
                if self.token:
                    request["token"] = self.token
                try:
                    self._sock.sendall((json.dumps(request) + "\n").encode("utf-8"))
                    while True:
                        response = json.loads(self._read_line())
                        if response.get("id") == request_id:
                            break
                except socket.timeout:
                    self.close()
                    raise GameError(f"Timed out after {self.timeout:.0f}s waiting for the game to answer {method}.")
                except (OSError, ConnectionError, ValueError):
                    # Stale connection (e.g. the game restarted): reconnect once and retry.
                    self.close()
                    if attempt == 0:
                        continue
                    raise GameError("Lost the connection to OpenRCT2.") from None
                if "error" in response and response["error"]:
                    err = response["error"]
                    raise GameError(err.get("message", "Unknown error"), err.get("data"))
                return response.get("result")
        raise GameError("Lost the connection to OpenRCT2.")


# ----------------------------------------------------------------------------
# Tool definitions
# ----------------------------------------------------------------------------

COORDS_NOTE = (
    "Coordinates: x/y are tile coordinates; z is world height (16 z = one land step = one path slope rise)."
)

TILE = {
    "type": "object",
    "properties": {
        "x": {"type": "integer"},
        "y": {"type": "integer"},
        "z": {"type": "integer", "description": "Optional world height; defaults to following the terrain."},
    },
    "required": ["x", "y"],
}

WAYPOINTS = {
    "type": "array",
    "items": {"type": "object", "properties": {"x": {"type": "integer"}, "y": {"type": "integer"}}, "required": ["x", "y"]},
    "description": "Optional tiles the route must pass through in order (e.g. to make a queue longer or steer around things).",
}

BUILD_OPTIONS = {
    "dryRun": {
        "type": "boolean",
        "description": "Plan and price without building anything (works even while paused). Recommended before large builds.",
    },
    "surface": {
        "type": ["string", "integer"],
        "description": "Footpath surface object (identifier, name or index). Default: copy nearby paths.",
    },
    "railings": {"type": ["string", "integer"], "description": "Footpath railings object (identifier, name or index)."},
    "allowWhilePaused": {
        "type": "boolean",
        "description": "Build even if the game is paused (like the 'build while paused' cheat). Ask the player first.",
    },
    "maxElevation": {
        "type": "integer",
        "description": "How far above (or below, in tunnels) the ground the route may go, in z units. Default 96.",
    },
    "maxNodes": {
        "type": "integer",
        "description": "Search budget for the route finder (default 40000). Raise it for very long routes.",
    },
}


def _schema(properties=None, required=None):
    schema = {"type": "object", "properties": properties or {}}
    if required:
        schema["required"] = required
    return schema


TOOLS = [
    {
        "name": "get_park_info",
        "description": "Park overview: name, cash, rating, guests, date, map size, paused state, cheats and scenario objective.",
        "inputSchema": _schema(),
    },
    {
        "name": "list_rides",
        "description": (
            "List rides, stalls and facilities. For each ride station it reports the entrance and exit tiles, "
            "whether a path is attached (connected) and whether guests can get between it and the park entrance "
            "(reachesParkEntrance). "
            "Use this to find rides that need paths or queues; get_ride has full details. " + COORDS_NOTE
        ),
        "inputSchema": _schema({
            "classification": {"type": "string", "enum": ["ride", "stall", "facility"], "description": "Optional filter."},
            "name": {"type": "string", "description": "Only rides whose name or ride type contains this text, e.g. 'coaster'."},
            "needsPaths": {
                "type": "boolean",
                "description": "Only rides whose entrance or exit is unconnected or cannot reach the park entrance.",
            },
        }),
    },
    {
        "name": "get_ride",
        "description": "Details for one ride: stations/entrances/exits with connectivity, stats, ratings, price.",
        "inputSchema": _schema({"rideId": {"type": "integer"}}, ["rideId"]),
    },
    {
        "name": "get_map_region",
        "description": (
            "ASCII map of a rectangular area (max 128x128 tiles), one character per tile, with a legend. "
            "Shows paths, queues, ride structures, entrances/exits, scenery, water, slopes and land ownership. "
            "Give either x1,y1,x2,y2 or centerX,centerY,radius. Rows are y, columns are x."
        ),
        "inputSchema": _schema({
            "x1": {"type": "integer"},
            "y1": {"type": "integer"},
            "x2": {"type": "integer"},
            "y2": {"type": "integer"},
            "centerX": {"type": "integer"},
            "centerY": {"type": "integer"},
            "radius": {"type": "integer", "description": "Half-size of the square around the centre (default 12)."},
            "includeHeights": {"type": "boolean", "description": "Also return terrain heights (z) per tile."},
        }),
    },
    {
        "name": "get_tile",
        "description": "Every element on one tile (surface, footpaths, track, entrances, scenery) with heights and details.",
        "inputSchema": _schema({"x": {"type": "integer"}, "y": {"type": "integer"}}, ["x", "y"]),
    },
    {
        "name": "find_park_entrances",
        "description": "Locations of the park entrances and the tiles on either side where paths join them.",
        "inputSchema": _schema(),
    },
    {
        "name": "list_footpath_objects",
        "description": "Footpath surfaces (normal and queue) and railings loaded in this park, for the surface/railings options.",
        "inputSchema": _schema(),
    },
    {
        "name": "connect_ride_exit",
        "description": (
            "Build a footpath from a ride's exit to the park's existing path network (paths that lead to the park "
            "entrance), automatically finding a buildable route over terrain, slopes and around obstacles. "
            "Also repairs an existing path in front of the exit that is not joined to it."
        ),
        "inputSchema": _schema(dict({
            "rideId": {"type": "integer"},
            "station": {"type": "integer", "description": "Station index for multi-station rides (default: first with an exit)."},
            "waypoints": WAYPOINTS,
        }, **BUILD_OPTIONS), ["rideId"]),
    },
    {
        "name": "build_ride_queue",
        "description": (
            "Build a queue line from a ride's entrance to the park's path network, routing automatically. "
            "Use waypoints to make the queue longer or send it a particular way. The entrance must not already "
            "have a path in front of it."
        ),
        "inputSchema": _schema(dict({
            "rideId": {"type": "integer"},
            "station": {"type": "integer"},
            "waypoints": WAYPOINTS,
        }, **BUILD_OPTIONS), ["rideId"]),
    },
    {
        "name": "build_path_route",
        "description": (
            "Build a footpath (or queue) from one tile to another tile, or to the nearest part of the park's path "
            "network when 'to' is omitted, with automatic route finding. Starts from an existing path on the "
            "'from' tile if there is one. " + COORDS_NOTE
        ),
        "inputSchema": _schema(dict({
            "from": TILE,
            "to": {
                "description": "Target tile {x, y}, or omit / \"network\" to join the park's path network.",
                "anyOf": [TILE, {"type": "string", "enum": ["network"]}],
            },
            "queue": {"type": "boolean", "description": "Build a queue line instead of a normal path."},
            "waypoints": WAYPOINTS,
        }, **BUILD_OPTIONS), ["from"]),
    },
    {
        "name": "place_footpath",
        "description": (
            "Place footpath pieces on exactly the given tiles (no route finding). Each tile follows the terrain "
            "unless z (and slope direction 0-3 for a sloped piece) is given. Nothing is built if any tile is invalid "
            "unless skipInvalid is true. " + COORDS_NOTE
        ),
        "inputSchema": _schema(dict({
            "tiles": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "x": {"type": "integer"},
                        "y": {"type": "integer"},
                        "z": {"type": "integer"},
                        "slope": {"type": "integer", "description": "Direction the piece rises toward (0-3); omit for flat."},
                    },
                    "required": ["x", "y"],
                },
            },
            "queue": {"type": "boolean"},
            "skipInvalid": {"type": "boolean"},
        }, **{k: v for k, v in BUILD_OPTIONS.items() if k not in ("maxElevation", "maxNodes")}), ["tiles"]),
    },
    {
        "name": "remove_footpath",
        "description": "Remove footpath or queue pieces on the given tiles (all heights unless z is given).",
        "inputSchema": _schema({
            "tiles": {"type": "array", "items": TILE},
            "dryRun": {"type": "boolean"},
            "allowWhilePaused": {"type": "boolean"},
        }, ["tiles"]),
    },
    {
        "name": "execute_game_action",
        "description": (
            "Run any built-in OpenRCT2 game action (the same commands the UI uses), e.g. 'ridesetstatus', "
            "'ridesetprice', 'smallsceneryplace', 'landbuyrights', 'staffhire'. Arguments follow the game's "
            "action API (see openrct2.d.ts): x/y here are WORLD coordinates (tile * 32), z is world height, and "
            "every argument of the action is required. Set queryOnly to check validity and cost without executing."
        ),
        "inputSchema": _schema({
            "action": {"type": "string"},
            "args": {"type": "object"},
            "queryOnly": {"type": "boolean"},
        }, ["action"]),
    },
    {
        "name": "set_paused",
        "description": "Pause or unpause the game. Construction is not possible while paused (unless allowWhilePaused).",
        "inputSchema": _schema({"paused": {"type": "boolean"}}, ["paused"]),
    },
    {
        "name": "scroll_view_to",
        "description": "Move the player's main view to a tile, e.g. to show them what was just built.",
        "inputSchema": _schema({"x": {"type": "integer"}, "y": {"type": "integer"}}, ["x", "y"]),
    },
    {
        "name": "run_plugin_script",
        "description": (
            "Run JavaScript inside the game's plugin engine with full access to the OpenRCT2 plugin API "
            "(map, park, context, ...); the value of a final 'return' is sent back. Disabled unless the player "
            "enabled it in the AI Control Plane window. Prefer the dedicated tools."
        ),
        "inputSchema": _schema({"code": {"type": "string"}}, ["code"]),
    },
]

SERVER_INSTRUCTIONS = """\
Controls a running OpenRCT2 (RollerCoaster Tycoon 2) game that the user is playing.
- x/y are tile coordinates; z is world height (16 per land step). Directions: 0 = x-1, 1 = y+1, 2 = x+1, 3 = y-1.
- Typical workflow: get_park_info -> list_rides (find the ride, check entrance/exit connectivity) ->
  get_map_region around it -> connect_ride_exit / build_ride_queue (use dryRun first for big or costly builds).
- Building spends the park's money and changes the user's live game; summarise what you built and what it cost.
- Construction fails while the game is paused (dry runs still work); ask the user before unpausing or using
  allowWhilePaused.
- Rides need their exit joined to the path network and a queue line from their entrance to it; list_rides with
  needsPaths=true finds rides that are missing either.
"""


# ----------------------------------------------------------------------------
# Tool execution and result formatting
# ----------------------------------------------------------------------------

def render_map(region):
    """Turn a get_map_region result into readable text with coordinate rulers."""
    x1, x2, y1 = region["x1"], region["x2"], region["y1"]
    xs = list(range(x1, x2 + 1))
    lines = [f"Map x {x1}..{x2}, y {y1}..{region['y2']} (rows = y, columns = x)"]
    pad = " " * 5
    if any(x >= 100 for x in xs):
        lines.append(pad + "".join(str(x // 100) if x >= 100 else " " for x in xs))
    lines.append(pad + "".join(str((x // 10) % 10) if x >= 10 else " " for x in xs))
    lines.append(pad + "".join(str(x % 10) for x in xs))
    for i, row in enumerate(region["rows"]):
        lines.append(f"{y1 + i:>4} {row}")
    lines.append("")
    lines.append("Legend: " + "  ".join(f"{k} {v}" for k, v in region["legend"].items()))
    if region.get("rides"):
        lines.append("Rides: " + ", ".join(f"{sym} = #{r['id']} {r['name']}" for sym, r in region["rides"].items()))
    heights = region.get("surfaceHeights")
    if heights:
        lines.append("")
        lines.append("Surface heights (z) per tile, rows = y:")
        for i, row in enumerate(heights):
            lines.append(f"{y1 + i:>4} " + " ".join("-" if h is None else str(h) for h in row))
    return "\n".join(lines)


def to_text(value):
    # Compact JSON keeps large results (e.g. 100+ rides) from flooding the agent's context.
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def run_tool(client, name, args):
    """Execute one MCP tool and return text for the agent."""
    args = dict(args or {})
    if name == "get_map_region":
        if "centerX" in args and "centerY" in args:
            r = int(args.pop("radius", 12))
            cx, cy = int(args.pop("centerX")), int(args.pop("centerY"))
            args.update({"x1": cx - r, "y1": cy - r, "x2": cx + r, "y2": cy + r})
        missing = [k for k in ("x1", "y1", "x2", "y2") if k not in args]
        if missing:
            raise GameError("Give x1, y1, x2, y2 or centerX, centerY (and optionally radius).")
        return render_map(client.call("get_map_region", args))
    if name == "execute_game_action":
        params = {"action": args.get("action"), "args": args.get("args") or {}, "query": bool(args.get("queryOnly"))}
        return to_text(client.call("execute_action", params))
    if name == "scroll_view_to":
        return to_text(client.call("scroll_view", args))
    if name == "run_plugin_script":
        return to_text(client.call("eval", args))
    if name in TOOL_NAMES:
        return to_text(client.call(name, args))
    raise GameError(f"Unknown tool {name}")


TOOL_NAMES = {t["name"] for t in TOOLS}


# ----------------------------------------------------------------------------
# MCP stdio server
# ----------------------------------------------------------------------------

class McpServer:
    def __init__(self, client, stdin=None, stdout=None):
        self.client = client
        self.stdin = stdin or sys.stdin.buffer
        self.stdout = stdout or sys.stdout.buffer

    def send(self, message):
        data = json.dumps(message, ensure_ascii=False).encode("utf-8") + b"\n"
        self.stdout.write(data)
        self.stdout.flush()

    def reply(self, request_id, result=None, error=None):
        msg = {"jsonrpc": "2.0", "id": request_id}
        if error is not None:
            msg["error"] = error
        else:
            msg["result"] = result
        self.send(msg)

    def handle(self, msg):
        method = msg.get("method")
        request_id = msg.get("id")
        is_request = "id" in msg and method is not None
        params = msg.get("params") or {}

        if method == "initialize":
            requested = params.get("protocolVersion")
            version = requested if requested in SUPPORTED_PROTOCOL_VERSIONS else SUPPORTED_PROTOCOL_VERSIONS[0]
            self.reply(request_id, {
                "protocolVersion": version,
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
                "instructions": SERVER_INSTRUCTIONS,
            })
        elif method == "ping":
            self.reply(request_id, {})
        elif method == "tools/list":
            self.reply(request_id, {"tools": TOOLS})
        elif method == "tools/call":
            name = params.get("name")
            try:
                text = run_tool(self.client, name, params.get("arguments"))
                self.reply(request_id, {"content": [{"type": "text", "text": text}], "isError": False})
            except GameError as e:
                text = str(e)
                if e.data:
                    text += "\n" + to_text(e.data)
                self.reply(request_id, {"content": [{"type": "text", "text": text}], "isError": True})
            except Exception as e:  # never let one bad call kill the server
                self.reply(request_id, {"content": [{"type": "text", "text": f"Internal error: {e!r}"}], "isError": True})
        elif is_request:
            self.reply(request_id, error={"code": -32601, "message": f"Method not found: {method}"})
        # Notifications (initialized, cancelled, ...) need no response.

    def serve(self):
        for raw in self.stdin:
            raw = raw.strip()
            if not raw:
                continue
            try:
                msg = json.loads(raw)
            except ValueError:
                self.send({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "Parse error"}})
                continue
            messages = msg if isinstance(msg, list) else [msg]
            for m in messages:
                if isinstance(m, dict):
                    self.handle(m)


# ----------------------------------------------------------------------------
# Command line
# ----------------------------------------------------------------------------

def main(argv):
    client = GameClient()
    if len(argv) >= 2 and argv[1] == "call":
        if len(argv) < 3:
            print("usage: openrct2_mcp.py call <method> [json-params]", file=sys.stderr)
            return 2
        params = json.loads(argv[3]) if len(argv) > 3 else {}
        try:
            print(to_text(client.call(argv[2], params)))
        except GameError as e:
            print(f"error: {e}", file=sys.stderr)
            if e.data:
                print(to_text(e.data), file=sys.stderr)
            return 1
        return 0
    if len(argv) >= 2 and argv[1] == "map":
        if len(argv) != 6:
            print("usage: openrct2_mcp.py map <x1> <y1> <x2> <y2>", file=sys.stderr)
            return 2
        x1, y1, x2, y2 = (int(v) for v in argv[2:6])
        try:
            print(run_tool(client, "get_map_region", {"x1": x1, "y1": y1, "x2": x2, "y2": y2}))
        except GameError as e:
            print(f"error: {e}", file=sys.stderr)
            return 1
        return 0
    if len(argv) >= 2 and argv[1] in ("-h", "--help"):
        print(__doc__)
        return 0
    McpServer(client).serve()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

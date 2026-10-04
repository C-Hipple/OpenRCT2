#!/usr/bin/env python3
"""Offline tests for the MCP bridge: runs openrct2_mcp.py over stdio against a fake game plugin.

    python3 test_mcp_server.py
"""

import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.join(HERE, "..", "mcp", "openrct2_mcp.py")
sys.path.insert(0, HERE)


class FakePlugin:
    """Speaks the plugin's newline-delimited JSON protocol on a random localhost port."""

    def __init__(self):
        self.listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.listener.bind(("127.0.0.1", 0))
        self.listener.listen()
        self.port = self.listener.getsockname()[1]
        self.requests = []
        threading.Thread(target=self._serve, daemon=True).start()

    def _serve(self):
        while True:
            try:
                conn, _ = self.listener.accept()
            except OSError:
                return
            threading.Thread(target=self._client, args=(conn,), daemon=True).start()

    def _client(self, conn):
        buf = b""
        while True:
            data = conn.recv(65536)
            if not data:
                return
            buf += data
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                req = json.loads(line)
                self.requests.append(req)
                conn.sendall((json.dumps(self.respond(req)) + "\n").encode())

    def respond(self, req):
        method, params = req["method"], req.get("params", {})
        if method == "get_park_info":
            return {"id": req["id"], "result": {"name": "Test Park", "cash": 100000}}
        if method == "get_map_region":
            return {"id": req["id"], "result": {
                "x1": params["x1"], "y1": params["y1"], "x2": params["x1"] + 2, "y2": params["y1"] + 1,
                "rows": ["#.E", "=.X"], "rides": {"a": {"id": 3, "name": "Coaster"}},
                "legend": {"#": "footpath"},
            }}
        if method == "connect_ride_exit":
            return {"id": req["id"], "error": {"message": "No buildable footpath route found", "data": {"hint": "buy land"}}}
        if method == "execute_action":
            return {"id": req["id"], "result": {"query": params["query"], "action": params["action"]}}
        if method == "list_buildable_rides":
            return {"id": req["id"], "result": [
                {"object": 6, "identifier": "rct2.ride.arrx", "legacyIdentifier": "ARRX", "name": "Looping Trains",
                 "rideType": 15, "kind": "tracked", "category": "rollercoaster"},
            ]}
        return {"id": req["id"], "result": {"method": method, "params": params}}

    def close(self):
        self.listener.close()


class ServerHarness(unittest.TestCase):
    """Starts the bridge against a fake plugin; the test classes below add the tests."""

    extra_env = {}

    def setUp(self):
        self.plugin = FakePlugin()
        env = dict(os.environ, OPENRCT2_AI_PORT=str(self.plugin.port), **self.extra_env)
        self.proc = subprocess.Popen(
            [sys.executable, SERVER], stdin=subprocess.PIPE, stdout=subprocess.PIPE, env=env)
        self.next_id = 1

    def tearDown(self):
        self.proc.stdin.close()
        self.proc.wait(timeout=5)
        self.proc.stdout.close()
        self.plugin.close()

    def send(self, method, params=None, notify=False):
        msg = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            msg["params"] = params
        if not notify:
            msg["id"] = self.next_id
            self.next_id += 1
        self.proc.stdin.write((json.dumps(msg) + "\n").encode())
        self.proc.stdin.flush()
        if notify:
            return None
        response = json.loads(self.proc.stdout.readline())
        self.assertEqual(response["id"], msg["id"])
        self.assertEqual(response["jsonrpc"], "2.0")
        return response

    def initialize(self):
        r = self.send("initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                                     "clientInfo": {"name": "test", "version": "0"}})
        self.send("notifications/initialized", notify=True)
        return r

    def call_tool(self, name, arguments=None):
        return self.send("tools/call", {"name": name, "arguments": arguments or {}})["result"]


class McpServerTest(ServerHarness):

    def test_initialize(self):
        result = self.initialize()["result"]
        self.assertEqual(result["protocolVersion"], "2025-06-18")
        self.assertIn("tools", result["capabilities"])
        self.assertEqual(result["serverInfo"]["name"], "openrct2")
        self.assertIn("tile coordinates", result["instructions"])

    def test_unknown_protocol_version_falls_back(self):
        r = self.send("initialize", {"protocolVersion": "1999-01-01", "capabilities": {}})
        self.assertEqual(r["result"]["protocolVersion"], "2025-11-25")

    def test_tools_list(self):
        self.initialize()
        tools = self.send("tools/list")["result"]["tools"]
        names = {t["name"] for t in tools}
        for expected in ("get_park_info", "list_rides", "get_map_region", "connect_ride_exit",
                         "build_ride_queue", "build_path_route", "place_footpath", "execute_game_action",
                         "list_buildable_rides", "build_flat_ride", "list_track_designs", "build_track_design",
                         "design_roller_coaster", "build_custom_track", "list_track_pieces"):
            self.assertIn(expected, names)
        for t in tools:
            self.assertEqual(t["inputSchema"]["type"], "object")
            self.assertTrue(t["description"])

    def test_simple_tool_forwards_to_plugin(self):
        self.initialize()
        result = self.call_tool("get_park_info")
        self.assertFalse(result["isError"])
        self.assertEqual(json.loads(result["content"][0]["text"])["name"], "Test Park")

    def test_map_is_rendered_as_text(self):
        self.initialize()
        result = self.call_tool("get_map_region", {"centerX": 10, "centerY": 20, "radius": 3})
        text = result["content"][0]["text"]
        self.assertIn("  17 #.E\n", text)
        self.assertIn("  18 =.X\n", text)
        self.assertIn("a = #3 Coaster", text)
        req = [r for r in self.plugin.requests if r["method"] == "get_map_region"][-1]
        self.assertEqual((req["params"]["x1"], req["params"]["y1"], req["params"]["x2"], req["params"]["y2"]), (7, 17, 13, 23))

    def test_plugin_errors_become_tool_errors(self):
        self.initialize()
        result = self.call_tool("connect_ride_exit", {"rideId": 1})
        self.assertTrue(result["isError"])
        self.assertIn("No buildable footpath route", result["content"][0]["text"])
        self.assertIn("buy land", result["content"][0]["text"])

    def test_execute_game_action_mapping(self):
        self.initialize()
        result = self.call_tool("execute_game_action", {"action": "ridesetstatus", "args": {"ride": 1, "status": 1},
                                                         "queryOnly": True})
        self.assertEqual(json.loads(result["content"][0]["text"]), {"query": True, "action": "ridesetstatus"})

    def test_unknown_method(self):
        self.initialize()
        r = self.send("resources/list")
        self.assertEqual(r["error"]["code"], -32601)

    def test_ping(self):
        self.assertEqual(self.send("ping")["result"], {})


class TrackDesignToolsTest(ServerHarness):
    """list_track_designs / build_track_design read design files in the bridge, then call the plugin."""

    @classmethod
    def setUpClass(cls):
        from test_designs import COASTER, make_td6
        cls.tmp = tempfile.TemporaryDirectory()
        for name, kwargs in [("Loopy Lou", {}), ("Timber Wolf", {"ride_type": 52, "vehicle": "PTCT1"})]:
            with open(os.path.join(cls.tmp.name, name + ".td6"), "wb") as f:
                f.write(make_td6(elements=COASTER, **kwargs))
        # A half-downloaded design must not break the tools for every other design.
        with open(os.path.join(cls.tmp.name, "Half.td6"), "wb") as f:
            f.write(make_td6(elements=COASTER)[:120])
        cls.extra_env = {"OPENRCT2_TRACK_DIRS": cls.tmp.name,
                         "OPENRCT2_USER_DIR": os.path.join(cls.tmp.name, "no-user-dir")}

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_list_track_designs(self):
        self.initialize()
        result = json.loads(self.call_tool("list_track_designs")["content"][0]["text"])
        self.assertEqual([d["design"] for d in result["designs"]], ["Loopy Lou"])
        self.assertEqual(result["designs"][0]["buildable"], "yes")
        self.assertEqual(result["designs"][0]["rideType"], "looping roller coaster")
        everything = json.loads(self.call_tool("list_track_designs", {"buildableOnly": False})["content"][0]["text"])
        self.assertEqual(everything["count"], 2)
        wooden = json.loads(self.call_tool("list_track_designs", {"buildableOnly": False, "ride": "wooden"})["content"][0]["text"])
        self.assertEqual([d["design"] for d in wooden["designs"]], ["Timber Wolf"])
        self.assertEqual(wooden["designs"][0]["buildable"], "no")

    def test_build_track_design_sends_layout(self):
        self.initialize()
        result = self.call_tool("build_track_design", {"design": "loopy", "near": {"x": 5, "y": 6}, "dryRun": True})
        self.assertFalse(result["isError"])
        req = [r for r in self.plugin.requests if r["method"] == "place_track_layout"][-1]["params"]
        self.assertEqual(req["near"], {"x": 5, "y": 6})
        self.assertTrue(req["dryRun"])
        self.assertNotIn("design", req)
        self.assertEqual(req["layout"]["name"], "Loopy Lou")
        self.assertEqual(len(req["layout"]["trackElements"]), len(__import__("test_designs").COASTER))

    def test_unknown_design_is_a_tool_error(self):
        self.initialize()
        result = self.call_tool("build_track_design", {"design": "Nonexistent"})
        self.assertTrue(result["isError"])
        self.assertIn("No track design", result["content"][0]["text"])


class NoGameTest(unittest.TestCase):
    def test_game_not_running_is_reported(self):
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            port = s.getsockname()[1]
        env = dict(os.environ, OPENRCT2_AI_PORT=str(port))
        proc = subprocess.Popen([sys.executable, SERVER], stdin=subprocess.PIPE, stdout=subprocess.PIPE, env=env)
        msg = {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "get_park_info", "arguments": {}}}
        out, _ = proc.communicate((json.dumps(msg) + "\n").encode(), timeout=10)
        result = json.loads(out.decode().splitlines()[0])["result"]
        self.assertTrue(result["isError"])
        self.assertIn("Could not connect to OpenRCT2", result["content"][0]["text"])


if __name__ == "__main__":
    unittest.main()

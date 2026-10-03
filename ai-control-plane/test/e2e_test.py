#!/usr/bin/env python3
"""End-to-end test for the AI Control Plane plugin against a running game.

Start OpenRCT2 (GUI or headless) with the plugin installed and a park loaded, then run:

    python3 e2e_test.py [--port 8765] [--rides 20]

The test is destructive: for a sample of rides it deletes the footpath tiles that
connect each ride's exit (and each queue line) to the rest of the park, rebuilds
them with connect_ride_exit / build_ride_queue, and checks that guests can reach
the park entrance again. Run it on a copy of a park, never on a save you care about.
"""

import argparse
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "mcp"))

from openrct2_mcp import GameClient, GameError  # noqa: E402

DX = [-1, 0, 1, 0]
DY = [0, 1, 0, -1]


def edge_z(z, slope, d):
    if slope == "flat":
        return z
    if slope == d:
        return z + 16
    if slope == (d ^ 2):
        return z
    return None


class Map:
    def __init__(self, client):
        self.client = client

    def paths(self, x, y):
        tile = self.client.call("get_tile", {"x": x, "y": y})
        return [e for e in tile["elements"] if e["type"] == "footpath" and not e.get("ghost")]

    def neighbour(self, x, y, p, d):
        """Footpath joined to p (on x, y) in direction d."""
        h = edge_z(p["baseZ"], p["slope"], d)
        if h is None:
            return None
        nx, ny = x + DX[d], y + DY[d]
        for q in self.paths(nx, ny):
            if edge_z(q["baseZ"], q["slope"], d ^ 2) == h and (
                d in p["connectedDirections"] or (d ^ 2) in q["connectedDirections"]
            ):
                return nx, ny, q
        return None

    def corridor(self, x, y, z, max_tiles, queue_only=False):
        """Follow a single-file path from (x, y, z) until a junction, collecting tiles."""
        start = [p for p in self.paths(x, y) if p["baseZ"] == z]
        if not start:
            return []
        out = [(x, y, start[0])]
        seen = {(x, y, z)}
        while len(out) < max_tiles:
            cx, cy, cp = out[-1]
            nexts = []
            for d in range(4):
                n = self.neighbour(cx, cy, cp, d)
                if n and (n[0], n[1], n[2]["baseZ"]) not in seen:
                    nexts.append(n)
            if queue_only:
                nexts = [n for n in nexts if n[2]["isQueue"]]
                if len(nexts) != 1:
                    break
            elif len(nexts) != 1 or len(cp["connectedDirections"]) > 2:
                break
            out.append(nexts[0])
            seen.add((nexts[0][0], nexts[0][1], nexts[0][2]["baseZ"]))
        return out


def front_tile(portal):
    """The tile a path must occupy to join an entrance/exit (opposite its direction)."""
    away = portal["direction"] ^ 2
    return portal["x"] + DX[away], portal["y"] + DY[away]


def station_portals(ride):
    for s in ride["stations"]:
        yield s["index"], s.get("entrance"), s.get("exit")


def run(client, max_rides, verbose):
    m = Map(client)
    info = client.call("get_park_info")
    print(f"Park: {info['name']}  cash {info['cashFormatted']}  rides {info['rideCount']}")
    if info["paused"]:
        client.call("set_paused", {"paused": False})

    rides = [r for r in client.call("list_rides") if r["classification"] == "ride"]
    exits_ok = exits_total = queues_ok = queues_total = 0
    failures = []
    timings = []

    for ride in rides:
        if exits_total >= max_rides:
            break
        portals = list(station_portals(ride))
        if len(portals) != 1:
            continue
        idx, entrance, exit_ = portals[0]
        if not entrance or not exit_ or not entrance.get("reachesParkEntrance") or not exit_.get("reachesParkEntrance"):
            continue

        # --- exit path ---
        fx, fy = front_tile(exit_)
        front = [p for p in m.paths(fx, fy) if edge_z(p["baseZ"], p["slope"], exit_["direction"]) == exit_["z"]]
        if not front or front[0]["isQueue"]:
            continue
        corridor = m.corridor(fx, fy, front[0]["baseZ"], 6)
        removed = client.call("remove_footpath", {"tiles": [{"x": x, "y": y, "z": p["baseZ"]} for x, y, p in corridor]})
        if removed["rejected"]:
            continue  # e.g. path on land the park does not own
        exits_total += 1
        t = time.time()
        try:
            res = client.call("connect_ride_exit", {"rideId": ride["id"]})
            timings.append(time.time() - t)
            after = client.call("get_ride", {"rideId": ride["id"]})["stations"][0]["exit"]
            ok = after["connected"] and after.get("reachesParkEntrance")
            if ok:
                exits_ok += 1
            else:
                failures.append((ride["name"], "exit", "not connected after build", res))
            if verbose:
                print(f"  exit  {ride['name'][:28]:28} removed {len(corridor)} built {res.get('built')} "
                      f"cost {res.get('costFormatted')} ok={ok} {timings[-1]:.2f}s")
        except GameError as e:
            failures.append((ride["name"], "exit", str(e), e.data))
            if verbose:
                print(f"  exit  {ride['name'][:28]:28} FAILED: {e}")

        # --- queue line ---
        qx, qy = front_tile(entrance)
        qfront = [p for p in m.paths(qx, qy) if edge_z(p["baseZ"], p["slope"], entrance["direction"]) == entrance["z"]]
        if not qfront or not qfront[0]["isQueue"]:
            continue
        queue = m.corridor(qx, qy, qfront[0]["baseZ"], 40, queue_only=True)
        removed = client.call("remove_footpath", {"tiles": [{"x": x, "y": y, "z": p["baseZ"]} for x, y, p in queue]})
        if removed["rejected"]:
            continue
        queues_total += 1
        t = time.time()
        try:
            res = client.call("build_ride_queue", {"rideId": ride["id"]})
            timings.append(time.time() - t)
            ok = res.get("entranceConnected") and res.get("queueReachesParkNetwork")
            if ok:
                queues_ok += 1
            else:
                failures.append((ride["name"], "queue", "not connected after build", res))
            if verbose:
                print(f"  queue {ride['name'][:28]:28} removed {len(queue)} built {res.get('built')} "
                      f"cost {res.get('costFormatted')} ok={ok} {timings[-1]:.2f}s")
        except GameError as e:
            failures.append((ride["name"], "queue", str(e), e.data))
            if verbose:
                print(f"  queue {ride['name'][:28]:28} FAILED: {e}")

    print(f"Exits rebuilt:  {exits_ok}/{exits_total}")
    print(f"Queues rebuilt: {queues_ok}/{queues_total}")
    if timings:
        print(f"Build time: avg {sum(timings) / len(timings):.2f}s, max {max(timings):.2f}s")
    for name, kind, why, data in failures:
        print(f"FAIL {kind} {name}: {why} {data if data else ''}")
    return not failures


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--rides", type=int, default=20, help="maximum number of rides to rebuild")
    ap.add_argument("-q", "--quiet", action="store_true")
    args = ap.parse_args()
    client = GameClient(args.host, args.port)
    ok = run(client, args.rides, not args.quiet)
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()

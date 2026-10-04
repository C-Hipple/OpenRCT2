#!/usr/bin/env python3
"""End-to-end ride building test against a running game with the AI Control Plane plugin.

    python3 e2e_rides.py [--port 8765] [--wait 300] [--keep]
    python3 e2e_rides.py --all-coasters     # just preview a generated design for every coaster type

Builds, through the same MCP tools an agent uses: a few flat rides by the water, the best buildable
pre-built track design (when design files are installed; see OPENRCT2_TRACK_DIRS), and generated roller
coasters in each style. Then it waits for the game to test the tracked rides and reports their ratings,
and demolishes everything it built unless --keep is given. It spends park money: use a copy of a park.
"""

import argparse
import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "mcp"))

from openrct2_mcp import GameClient, GameError, run_tool  # noqa: E402


def tool(client, name, args=None):
    return json.loads(run_tool(client, name, args or {}))


def preview_all_coasters(client):
    """design_roller_coaster previews for each roller coaster type and style; reports which cannot be generated."""
    seen, failures = set(), 0
    for option in tool(client, "list_buildable_rides", {"category": "rollercoaster"}):
        if option["rideType"] in seen:
            continue
        seen.add(option["rideType"])
        for style in ("gentle", "moderate", "intense"):
            try:
                d = tool(client, "design_roller_coaster", {"object": option["object"], "style": style, "seed": 7,
                                                           "previewOnly": True})["design"]
                misses = d.get("mayMissRequirements")
                print(f"OK    {option['rideTypeName']:<26} {style:<8} {d['pieces']:>3} pieces, {d['features']} features, "
                      f"{d['inversions']} inversions{', may miss ' + ', '.join(misses) if misses else ''}")
            except GameError as e:
                failures += 1
                print(f"NO    {option['rideTypeName']:<26} {style:<8} {str(e)[:90]}")
    print(f"\n{len(seen)} coaster types, {failures} type/style combinations could not be generated")
    return 0


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--wait", type=float, default=300, help="seconds to wait for test results (0 to skip)")
    ap.add_argument("--keep", action="store_true", help="keep the rides instead of demolishing them")
    ap.add_argument("--all-coasters", action="store_true",
                    help="only preview a generated design for every buildable roller coaster type (builds nothing)")
    args = ap.parse_args()
    client = GameClient(args.host, args.port)
    if args.all_coasters:
        return preview_all_coasters(client)

    park = tool(client, "get_park_info")
    print(f"Park: {park.get('name')}  cash {park.get('cashFormatted')}  paused {park.get('paused')}")
    if park.get("paused"):
        print("The game is paused; unpause it first (construction is not possible while paused).")
        return 2

    built = []  # (label, rideId, tracked)
    failures = []

    def attempt(label, name, params, tracked):
        t = time.time()
        try:
            r = tool(client, name, params)
        except GameError as e:
            failures.append(label)
            print(f"FAIL  {label}: {e}")
            return None
        paths = r.get("paths") or {}
        print(f"BUILT {label}: ride #{r['rideId']} {r.get('name')} for {r.get('totalCostFormatted')} in {time.time() - t:.1f}s; "
              f"paths {json.dumps(paths)}")
        if r.get("warnings"):
            print(f"      warnings: {r['warnings']}")
        built.append((label, r["rideId"], tracked))
        return r

    pending = {}
    ratings = {}
    try:
        thrill = [o for o in tool(client, "list_buildable_rides", {"kind": "flat"}) if o["category"] == "thrill"]
        print(f"Buildable thrill rides: {', '.join(o['name'] for o in thrill) or 'none'}")
        for option in thrill[:3]:
            attempt("flat ride " + option["name"], "build_flat_ride",
                    {"object": option["object"], "near": "water", "radius": 30}, False)

        # A stall joins the path on the tile beside its open side; check that tile really got a path.
        stalls = tool(client, "list_buildable_rides", {"kind": "stall"})
        if stalls:
            r = attempt("stall " + stalls[0]["name"], "build_flat_ride", {"object": stalls[0]["object"], "radius": 30}, False)
            if r and r.get("pathConnection"):
                spot = r["pathConnection"]
                tile = tool(client, "get_tile", spot)
                if not any(e["type"] == "footpath" for e in tile["elements"]):
                    failures.append("stall path")
                    print(f"FAIL  stall {stalls[0]['name']}: no path on {spot}, the stall is unreachable")

        try:
            designs = tool(client, "list_track_designs", {"ride": "coaster", "limit": 5})
        except GameError as e:
            designs = {"designs": []}
            print(f"FAIL  list_track_designs: {e}")
            failures.append("list_track_designs")
        if designs["designs"]:
            best = designs["designs"][0]
            attempt("design " + best["design"], "build_track_design", {"design": best["design"], "radius": 40}, True)
        else:
            print("No coaster track designs installed; skipping build_track_design.")

        for style in ("gentle", "moderate", "intense"):
            try:
                preview = tool(client, "design_roller_coaster", {"style": style, "seed": 1, "previewOnly": True})
                print(f"PLAN  {style} coaster: {json.dumps(preview['design'])}")
            except GameError as e:
                failures.append(style + " coaster preview")
                print(f"FAIL  {style} coaster preview: {e}")
                continue
            attempt(style + " coaster", "design_roller_coaster", {"style": style, "seed": 1, "radius": 40}, True)

        pending = {rid: label for label, rid, tracked in built if tracked}
        deadline = time.time() + args.wait
        while pending and time.time() < deadline:
            time.sleep(5)
            for rid in list(pending):
                ride = tool(client, "get_ride", {"rideId": rid})
                if ride.get("excitement", -1) > 0:
                    ratings[pending.pop(rid)] = (ride["excitement"], ride["intensity"], ride["nausea"])
        for label, (e, i, n) in ratings.items():
            print(f"RATED {label}: excitement {e}, intensity {i}, nausea {n}")
        for label in pending.values():
            print(f"UNRATED {label}: no test result within {args.wait:.0f}s")
    finally:
        # Never leave what the test built (and paid for) behind, even if it stopped half way.
        if not args.keep:
            for label, rid, _ in built:
                try:
                    tool(client, "demolish_ride", {"rideId": rid})
                except GameError as e:
                    print(f"could not demolish {label}: {e}")

    print(f"\n{len(built)} built, {len(failures)} failed, {len(ratings)} rated, {len(pending)} unrated")
    return 1 if failures or (args.wait and pending) else 0


if __name__ == "__main__":
    sys.exit(main())

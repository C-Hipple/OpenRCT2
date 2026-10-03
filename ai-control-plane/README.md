# OpenRCT2 AI Control Plane

Let a local AI agent (Claude Code, Claude Desktop, or any other [MCP](https://modelcontextprotocol.io) client)
look at and build in the park **you are playing right now**. Ask things like:

> Build a path from the exit of the Wooden Roller Coaster to the main path, and give it an entrance queue.

and the agent reads the game state, plans a route over the terrain, and builds it in your running game,
paid for from the park's cash, exactly as if you had placed the pieces yourself.

## How it works

```
 Claude Code / Claude Desktop
        │  MCP over stdio
        ▼
 mcp/openrct2_mcp.py          (Python 3.8+, standard library only)
        │  newline-delimited JSON over TCP 127.0.0.1:8765
        ▼
 plugin/ai-control-plane.js   (OpenRCT2 plugin, runs inside the game)
        │  game actions (footpathplace, footpathremove, ...)
        ▼
 your running game
```

* **The plugin** is an *intransient* OpenRCT2 plugin: it loads when the game starts, keeps running while you load
  different parks, and listens on localhost only. It reads the map, rides and park, and changes the world
  **only through built-in game actions**, so money, land ownership, clearance checks, error messages and
  multiplayer synchronisation behave exactly like normal play.
* **The MCP bridge** is what your agent launches. It translates MCP tool calls into requests to the plugin.
* No changes to the game itself are needed: any OpenRCT2 build with plugin API 111+ (the QuickJS-based
  0.5.x releases and this repository) works.

## Setup

1. **Install the plugin** into your OpenRCT2 user folder:

   ```sh
   python3 ai-control-plane/install.py
   ```

   (Or copy `plugin/ai-control-plane.js` to the `plugin` folder inside your OpenRCT2 user folder yourself:
   `Documents/OpenRCT2` on Windows, `~/Library/Application Support/OpenRCT2` on macOS,
   `~/.config/OpenRCT2` on Linux. Pass `--user-dir` if yours is elsewhere.)

2. **Start OpenRCT2.** The console prints `[AI Control Plane] Listening on 127.0.0.1:8765`. In game, the
   map/tools toolbar menu gets an **AI Control Plane** entry that shows the connection status and a log of
   everything the agent has built.

3. **Connect your agent** (the installer prints these with the right paths):

   * Claude Code:

     ```sh
     claude mcp add --scope user openrct2 -- python3 /path/to/OpenRCT2/ai-control-plane/mcp/openrct2_mcp.py
     ```

   * Claude Desktop: *Settings → Developer → Edit Config*, then add:

     ```json
     {
       "mcpServers": {
         "openrct2": {
           "command": "python3",
           "args": ["/path/to/OpenRCT2/ai-control-plane/mcp/openrct2_mcp.py"]
         }
       }
     }
     ```

   On Windows use `py` (or the full path to `python.exe`) as the command.

4. **Load a park and ask away.** The game must be unpaused for the agent to build (planning works while
   paused). Example requests:

   * "Which rides aren't connected to the paths yet? Fix them."
   * "Build a path from the Log Flume exit back to the main path and an entrance queue for it."
   * "Make the Ferris Wheel's queue longer by routing it past tile 40,52."
   * "How much would a path from 20,30 to the park entrance cost? Don't build it yet."
   * "Open the Corkscrew and set its price to £3."

## Tools

| Tool | What it does |
| --- | --- |
| `get_park_info` | Name, cash, rating, guests, date, map size, paused state, cheats, scenario objective. |
| `list_rides` | Rides/stalls/facilities with entrance and exit locations and whether each is joined to the paths and reachable from the park entrance. Filters: `name`, `classification`, `needsPaths`. |
| `get_ride` | Full details for one ride. |
| `get_map_region` | ASCII map of an area (paths, queues, rides, entrances, scenery, water, slopes, land ownership), optionally with terrain heights. |
| `get_tile` | Every element on one tile. |
| `find_park_entrances` | Park entrance locations. |
| `list_footpath_objects` | Footpath surfaces, queue surfaces and railings loaded in the park. |
| `connect_ride_exit` | Route and build a footpath from a ride's exit to the park's path network. Also repairs a path in front of the exit that isn't joined to it. |
| `build_ride_queue` | Route and build a queue line from a ride's entrance to the path network (optionally via waypoints). |
| `build_path_route` | Route and build a path or queue from a tile to another tile or to the network. |
| `place_footpath` | Place path pieces on exactly the tiles given. |
| `remove_footpath` | Remove path pieces. |
| `execute_game_action` | Run (or just price/validate) any built-in game action: ride status and prices, scenery, land, staff, ... |
| `set_paused` | Pause or unpause. |
| `scroll_view_to` | Move your view to a tile to show you what was built. |
| `run_plugin_script` | Run arbitrary plugin JavaScript. **Off by default**; enable it with the checkbox in the in-game window. |

All building tools accept `dryRun` to plan and price without building.

### Coordinates

* `x`, `y` are **tile** coordinates. In `get_map_region`, rows are y (increasing downward) and columns are x;
  this is a top-down view, so it will look rotated compared to the isometric game view.
* `z` is world height, the same unit game actions use. One land step, and one footpath slope, is 16.
* Directions: `0` = x−1, `1` = y+1, `2` = x+1, `3` = y−1.
* `execute_game_action` takes raw game action arguments as documented in
  [`openrct2.d.ts`](../distribution/scripting/openrct2.d.ts): there, x and y are world coordinates (tile × 32)
  and every argument must be given.

## How routes are built

The route finder is an A* search over footpath pieces, using the game's own rules:

* Paths follow the terrain (flat or sloped pieces), use ramps and elevated sections where needed, and can tunnel
  underground where the game allows it (e.g. from a ride inside a hill). Flat, straight, ground-level routes are
  preferred.
* Every candidate piece is checked with the game's real placement query, so ownership, scenery, rides, water,
  clearance and cost are all respected. Walls and fences are treated as obstacles rather than demolished.
* "The path network" means the paths guests can reach from a park entrance, so routes never dead-end in a
  disconnected fragment. Without a park entrance (e.g. in the scenario editor) any existing path counts.
* Normal paths avoid running alongside other paths, which would merge into wide blobs, and avoid joining other
  rides' entrances and exits.
* Queue lines follow the game's queue rules: a queue tile joins at most two neighbours, so queues never touch
  other paths except at the far end, where the route makes sure they join the network path you'd expect.
* New paths copy the surface and railings of nearby paths of the same kind unless you choose others.
* Before building, every piece is re-validated and the total cost is checked against the park's cash. After
  building, the entrance/exit connection and reachability from the park entrance are verified and reported.
* Long searches are spread over several game ticks so they never freeze the game.

## Settings and safety

* The plugin only listens on `127.0.0.1`. Any program on your computer can connect to it, though; set a
  token if that matters to you (see below).
* Building spends the park's money and changes your game; agents are told to summarise what they built and what it
  cost. Use dry runs to preview.
* Plugin settings live in `plugin.store.json` in your OpenRCT2 user folder, under the `AIControlPlane` key.
  Edit it while the game is closed:

  ```json
  { "AIControlPlane": { "port": 8765, "token": "", "allowEval": false } }
  ```

* MCP bridge environment variables: `OPENRCT2_AI_HOST`, `OPENRCT2_AI_PORT`, `OPENRCT2_AI_TOKEN`.
* In multiplayer the plugin acts as you: actions are sent to the server and checked against your permissions.

## Command line

The bridge doubles as a CLI, handy for scripting and debugging:

```sh
python3 mcp/openrct2_mcp.py call list_rides '{"needsPaths": true}'
python3 mcp/openrct2_mcp.py call connect_ride_exit '{"rideId": 3, "dryRun": true}'
python3 mcp/openrct2_mcp.py map 40 40 80 70
```

## Testing

* `python3 test/test_mcp_server.py` runs the MCP protocol tests against a fake game (no game needed).
* `python3 test/e2e_test.py` is a destructive end-to-end test for a running game: for many rides it deletes the
  paths joining the exit and the queue line, rebuilds them with the tools, and checks guests can reach the
  park entrance again. **Run it on a copy of a park.** A headless game works well for this:

  ```sh
  openrct2-cli path/to/park-copy.park --headless --user-data-path=/tmp/rct-user
  ```

  (with the plugin in `/tmp/rct-user/plugin/`). On the large "Blackpool Pleasure Beach" test park
  (`test/tests/testdata/parks/bpb.sv6`) it rebuilds 75/75 exits and 67/70 queues, at about 0.1 s per build;
  the remaining three queues are spots where any queue tile would also join a second path, which the tool
  reports instead of building something broken.

## Limitations

* Paths and queues are automated; building rides' track, scenery layouts or terraforming is available only via
  `execute_game_action`, which needs exact game action arguments.
* Connectivity checks cover ride entrances and exits; stalls and facilities are not analysed.
* Queue routes are the shortest valid line; use waypoints to make them longer.

# OpenRCT2 AI Control Plane

Let a local AI agent (Claude Code, Claude Desktop, or any other [MCP](https://modelcontextprotocol.io) client)
look at and build in the park **you are playing right now**. Ask things like:

> Build a path from the exit of the Wooden Roller Coaster to the main path, and give it an entrance queue.

> Build some thrill rides by the lake.

> Design me an intense roller coaster with a couple of loops over by the north entrance.

and the agent reads the game state, plans the build, and makes it in your running game, paid for from the
park's cash, exactly as if you had placed the pieces yourself.

## How it works

```
 Claude Code / Claude Desktop
        │  MCP over stdio
        ▼
 mcp/openrct2_mcp.py          (Python 3.8+, standard library only)
        │  newline-delimited JSON over TCP 127.0.0.1:8765
        ▼
 plugin/ai-control-plane.js   (OpenRCT2 plugin, runs inside the game)
        │  game actions (footpathplace, ridecreate, trackplace, ...)
        ▼
 your running game
```

* **The plugin** is an *intransient* OpenRCT2 plugin: it loads when the game starts, keeps running while you load
  different parks, and listens on localhost only. It reads the map, rides and park, and changes the world
  **only through built-in game actions**, so money, land ownership, clearance checks, error messages and
  multiplayer synchronisation behave exactly like normal play.
* **The MCP bridge** is what your agent launches. It translates MCP tool calls into requests to the plugin, and
  reads your installed track design files (plugins cannot read files) so the plugin can build them.
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
   * "Build three thrill rides by the water and connect them up."
   * "What coaster designs can I build? Put the most exciting one near the entrance — tell me the cost first."
   * "Design a family coaster that fits in about 18 by 12 tiles."

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
| `list_buildable_rides` | Rides, stalls and facilities the park has researched, with kind (flat, tracked, tower, maze, stall), category and footprint. |
| `find_build_sites` | Free, level, owned land for a footprint, near water or near a tile. |
| `build_flat_ride` | Build a flat ride or stall with its entrance, exit, queue and exit path in one step. |
| `list_track_designs` | Installed pre-built track designs (coasters, water rides, mazes, ...) with ratings and whether the park can build them. |
| `build_track_design` | Build a track design where it fits, with entrance, exit, paths, its trains and colours, then start testing. |
| `design_roller_coaster` | Generate and build a brand-new roller coaster (see below). |
| `list_track_pieces` | Track pieces a ride type can build, with each piece's geometry (where the next piece starts, slope, banking). |
| `check_track_layout` | Check a custom piece list without building it: closure, joins, size, height. |
| `build_custom_track` | Build a tracked ride from your own piece list. |
| `set_ride_status` / `set_ride_price` / `demolish_ride` | Open, close or test a ride; set its price; demolish it. |
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

## Building rides

* **Flat rides and stalls** (`build_flat_ride`): picks the ride from what the park has researched (or everything,
  with the research cheat), finds free owned land near water or the tile you name, places the ride, puts the
  entrance and exit where their paths can reach the park's paths, and builds the queue and exit path.
* **Track designs** (`list_track_designs`, `build_track_design`): the bridge reads `.td6`/`.td7` files from the
  `track` folder in your OpenRCT2 user folder, the `Tracks` folder of the RCT2 install set as `game_path` in
  `config.ini`, and any folders in `OPENRCT2_TRACK_DIRS`. Designs replay piece by piece exactly like the game's
  own design placement (same rotation, height search and settings). If the design's vehicle isn't researched,
  another vehicle of the same ride type is used. Entrances go where the design has them if those spots are
  usable, else beside the station on the side with room for paths. Like the game requires before a ride can
  open, every station gets an entrance or an exit (a second station left without one gets an exit), and each
  one gets its queue or exit path; the result reports the first station's as `paths.queue`/`paths.exit` and
  the rest under `paths.otherStations`.
* **Generated roller coasters** (`design_roller_coaster`): builds a complete circuit — station, chain lift,
  first drop, then a mix of hills, turns, banked turns, helixes, drops and (unless gentle) loops and
  corkscrews — and finds a way back into the station with a search over flat, turning and descending pieces.
  Every piece is checked against the game's clearances and the area you allow, the train's momentum is
  tracked so it can make every climb, turns are only taken at speeds that keep lateral G sensible, and the
  ride type's rating requirements (drop height, number of drops, negative and lateral G, top speed, length)
  are aimed for, from the train's estimated speed; water coasters get a water channel before the station for
  their splashdown requirement. Requirements a design may still miss are listed in `mayMissRequirements`
  (the game divides the ratings of a ride that misses one). Styles: `gentle` (family coaster), `moderate`,
  `intense`. The same `seed` gives the same design; `previewOnly` returns the piece list without building.
  It works for 27 of the 31 roller coaster types (not the ones without a chain lift or without turns); the
  reverser coaster is only built when asked for by name, as it needs reverser pieces the generator doesn't
  place and rates poorly without them. In testing, every generated coaster completed its test run, with
  excitement around 4–6.
* **Your own layouts** (`list_track_pieces`, `check_track_layout`, `build_custom_track`): give pieces in order
  from the station; the layout must have a station, its pieces must join, and it must return to its start.
* New tracked rides start **testing**, so the game measures their ratings; look at `get_ride` and open them
  with `set_ride_status` once you're happy. Ride ticket prices only apply in parks with free entry (or unlocked
  prices), like in the game.

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

* MCP bridge environment variables: `OPENRCT2_AI_HOST`, `OPENRCT2_AI_PORT`, `OPENRCT2_AI_TOKEN`, and for track
  designs `OPENRCT2_USER_DIR` (your OpenRCT2 user folder, if not the default) and `OPENRCT2_TRACK_DIRS` (extra
  design folders, separated like `PATH`).
* In multiplayer the plugin acts as you: actions are sent to the server and checked against your permissions.

## Command line

The bridge doubles as a CLI, handy for scripting and debugging:

```sh
python3 mcp/openrct2_mcp.py call list_rides '{"needsPaths": true}'
python3 mcp/openrct2_mcp.py call connect_ride_exit '{"rideId": 3, "dryRun": true}'
python3 mcp/openrct2_mcp.py map 40 40 80 70
```

## Testing

* `python3 test/test_mcp_server.py` runs the MCP protocol tests against a fake game, and
  `python3 test/test_designs.py` tests the track design decoder and library (no game needed).
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
* `python3 test/e2e_rides.py` builds flat rides by the water, the best installed coaster design and a generated
  coaster in each style through the MCP tools, waits for the game to test them, reports ratings and demolishes
  them again. It spends park money: use a copy of a park.

## Regenerating ride data

Ride type data the plugin API doesn't expose (flat ride footprints, which track pieces each ride type offers,
entrance sides, clearances, rating requirements) is embedded in the plugin between `<generated-ride-data>`
markers. After the game's ride data changes, rebuild it from an OpenRCT2 build tree:

```sh
g++ -std=gnu++20 -fno-char8_t -DENABLE_SCRIPTING -Isrc -isystem src/thirdparty -isystem src/thirdparty/quickjs-ng \
    ai-control-plane/tools/dump_ride_data.cpp build/libopenrct2.a -o dump_ride_data \
    -lssl -lcrypto -lcurl -lpng16 -lz -lzip -lzstd -ldl -licuuc -lfreetype -lfontconfig
./dump_ride_data > ride_data.json
python3 ai-control-plane/tools/gen_ride_data.py ride_data.json
```

## Limitations

* Scenery and terraforming are available only via `execute_game_action`, which needs exact game action
  arguments. Rides are not landscaped around: sites need free, owned land.
* Generated coasters run one train (more trains need block brakes) and use chain lifts on 25° slopes, so
  launched coasters are built from designs or your own piece lists instead. They don't use diagonal track.
* Track is normally placed within a single game tick, which lets designs cross over their own track. While the game
  is paused (with `allowWhilePaused`) or in multiplayer, the game queues the pieces instead, and designs that cross
  over themselves may then be refused.
* Connectivity checks cover ride entrances and exits; stalls and facilities are not analysed.
* Queue routes are the shortest valid line; use waypoints to make them longer.

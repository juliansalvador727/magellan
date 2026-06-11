# Trailscape — Design

A local tool that turns a GPX trail into a to-scale, freely explorable 3D world:
real elevation, real satellite imagery, a procedurally grown forest, and the
trail itself draped over the terrain. Inspired by _ode-to-yosemite_, but
generalized from one hardcoded valley to **any** uploaded trail, and built to
run entirely on your own machine.

This document is the architecture. `README.md` is the run-it guide.

---

## 1. Goals and non-goals

**Goals**

- Upload (or point at) a GPX file → get an explorable 3D world centered on that trail.
- Everything to scale: 1 world unit = 1 meter, heights and distances true.
- Procedural, no art assets: terrain, trees, sky, water all generated from data.
- Runs locally with no API keys and no cloud services.
- The pipeline is deterministic: same GPX → same world (enables caching).

**Non-goals (at least for v1)**

- Multi-user hosting, accounts, storage backends. (See "Why local" below.)
- Automated AllTrails scraping. The user supplies a GPX they already have.
- Hand-authored landmarks (e.g. named waterfalls placed by hand). Anything
  special must be derived from data (OSM POIs), or it doesn't generalize.

**Why local.** Serving baked Esri imagery to third parties falls outside the
free imagery terms, and a hosted version means a job queue, object storage, an
abuse surface, and a real cost model. For personal use, fetching tiles for your
own machine is the tolerated case — so local keeps the project a weekend-sized
build instead of a service.

---

## 2. System shape

Three parts, glued by a thin local server:

```
                 ┌─────────────────────────────────────────────┐
   trail.gpx ──▶ │  BAKE PIPELINE (Node, offline)               │
                 │  parse → plan → fetch tiles → decode →        │
                 │  resample → stitch imagery → forest mask →    │
                 │  OSM → trail geometry → manifest              │
                 └───────────────┬─────────────────────────────┘
                                 │ writes
                                 ▼
                 worlds/<worldId>/  (heights.bin, imagery/, forest.png,
                                     osm.json, trail.json, manifest.json)
                                 │ served by
                                 ▼
                 ┌─────────────────────────────────────────────┐
   browser  ◀──▶ │  RENDERER (Three.js, Vite)                   │
                 │  load manifest → terrain meshes + imagery →   │
                 │  trail ribbon → forest → sky/atmosphere →     │
                 │  water/roads/buildings → controls → HUD       │
                 └─────────────────────────────────────────────┘

                 LOCAL SERVER (Express/polka):
                   GET  /                upload page
                   POST /bake            run pipeline, stream progress (SSE)
                   GET  /worlds/:id/*    serve a baked dataset
                   GET  /explore/:id     renderer pointed at that world
```

The bake is the slow, offline half (tens of seconds to a couple of minutes per
trail). The renderer is the fast, interactive half. They share only the baked
dataset on disk and the manifest schema in §6.

---

## 3. Coordinate frame

One local right-handed metric frame, shared by the bake and the renderer.

- **Origin** = the south-west corner of the _padded_ bounding box. Picking a box
  corner (not the trailhead) keeps the heightmap grid cleanly indexed from
  `[0,0]`.
- **Axes** = `+X` east, `+Z` south, `+Y` up (elevation ASL). This is Three.js's
  default (y-up) with the ground in the X/Z plane.
- **Scale** = meters. Longitude is scaled by `cos(lat0)` (lat0 = box center) so
  east-west distance is true; without this, everything is stretched.
- **Conversion** (lat/lon → local meters), used everywhere:

```js
const M_PER_DEG_LAT = 111320;
x = (lon - originLon) * M_PER_DEG_LAT * Math.cos((lat0 * Math.PI) / 180);
z = (originLat - lat) * M_PER_DEG_LAT; // note sign: +Z is south
y = elevationMeters;
```

- **Spawn** = the trailhead (first GPX point) converted to local coords, with the
  camera placed a little above and facing along the first trail segment.

Heights and horizontal distances are therefore directly comparable, and a
published trail length should match the summed segment lengths in `trail.json`.

---

## 4. Data sources

All global, all keyless, all fine for personal/local use. Attribution required
(see README).

| Layer     | Source                               | Zoom / res          | Format        |
| --------- | ------------------------------------ | ------------------- | ------------- |
| Elevation | AWS Terrain Tiles (Mapzen/Terrarium) | z14 ≈ 7.6 m/sample  | PNG (encoded) |
| Imagery   | Esri World Imagery                   | z16 core / z15 edge | JPEG          |
| Vector    | OpenStreetMap via Overpass           | n/a (bbox query)    | JSON          |

**Terrarium decode** (PNG RGB → meters):

```
elevation_m = (R * 256 + G + B / 256) - 32768
```

**Esri caveat.** The keyless World Imagery endpoint is licensed for personal
use, not for redistribution. Local-only is fine; if you ever host this, you must
swap to a properly licensed source (NAIP, Sentinel-2, or a paid tile plan).
Encode that boundary in your head now so you don't accidentally cross it later.

---

## 5. Bake pipeline (stage by stage)

Each stage is a module under `lib/`. Stages are pure where possible (input
files/args → output files), so you can re-run any one in isolation.

1. **Parse + plan** — `lib/gpx-bounds.mjs` (already written).
   GPX → points → `planBake()` → `{ rawBbox, bbox, origin, lat0, worldId,
trailhead, trailLengthKm, tilesForZoom(), corridorTilesForZoom() }`.
   Enforces the area cap so a giant GPX can't trigger a 40,000-tile download.

2. **Fetch elevation tiles** — `lib/fetch-elevation.mjs`.
   For each corridor tile at z14: download the Terrarium PNG, cache it under
   `cache/terrarium/z/x/y.png`. Decode with `sharp` to raw RGB, apply the decode
   formula, accumulate into the grid (next stage).

3. **Resample to heightmap** — `lib/build-heightmap.mjs`.
   Define a regular grid covering `bbox` at a chosen sample spacing (start ~7.6 m
   to match source; coarser = smaller files). For each grid node, sample the
   decoded tile elevations (bilinear). Write `heights.bin` as `Uint16`
   (`round((h - hMin) * 10)`, i.e. 0.1 m precision) plus grid dims and `hMin/hMax`
   into the manifest.

4. **Fetch + stitch imagery** — `lib/build-imagery.mjs`.
   For corridor tiles at z16 (core) / z15 (outer), download + cache JPEGs, then
   stitch into **chunked** textures: split the terrain into chunks whose textures
   stay ≤ 2048 px (GPU-safe), one JPEG per chunk under `imagery/`. Record the
   chunk grid (rows, cols, world extent per chunk) in the manifest. One giant
   stitched image will blow the GPU max-texture limit — chunk from the start.

5. **Forest mask** — `lib/build-mask.mjs`.
   Per imagery pixel (downsampled to a mask grid), classify canopy vs.
   not-canopy. Heuristic to tune: green-dominance (`G > R && G > B` by a margin)
   AND moderately dark AND high local texture variance (forests are textured;
   meadows are flat green) AND DEM slope below a cliff threshold. Output
   `forest.png` (single channel = tree density 0–255). This drives all tree
   placement; expect to retune the thresholds by eye.

6. **Vector layer** — `lib/fetch-osm.mjs`.
   One Overpass query for `bbox`: highways (centerlines), building footprints,
   `natural=water` polygons, and POIs (`natural=peak`, `natural=waterfall`,
   `tourism=viewpoint`). Write `osm.json` (geometry already projected to local
   meters, or projected lazily in the renderer — pick one and be consistent).

7. **Trail geometry** — `lib/build-trail.mjs`.
   Resample the GPX to a sensible spacing, convert to local coords, and snap each
   point's `y` to the baked DEM height (so the ribbon sits _on_ the ground, not
   floating). Write `trail.json` (polyline + cumulative distance + named
   waypoints if present).

8. **Manifest** — `lib/write-manifest.mjs`. Schema in §6.

9. **Cache.** Every raw tile is cached by `z/x/y`. A second trail overlapping a
   popular area reuses most tiles. Bake worlds are keyed by `worldId` (hash of
   rounded bbox) so an identical GPX is a no-op.

**Orchestrator** — `lib/bake.mjs` runs 1→9, emitting progress events
(`{stage, done, total, message}`) that the server forwards to the browser.

---

## 6. Data formats

```jsonc
// worlds/<worldId>/manifest.json
{
  "worldId": "w1kxx4px",
  "name": "Half Dome via Mist Trail",
  "createdAt": "2026-06-10T12:00:00Z",

  "frame": {
    "originLat": 37.71153,
    "originLon": -119.57524, // SW corner
    "lat0": 37.7355, // cos-correction latitude
    "metersPerDegLat": 111320,
  },

  "extentMeters": { "width": 6380, "height": 5330 }, // +X east, +Z south

  "heightmap": {
    "file": "heights.bin", // Uint16, row-major, +Z (south) rows
    "cols": 840,
    "rows": 702,
    "sampleSpacingM": 7.6,
    "hMin": 1180.0,
    "hMax": 2740.0,
    "encoding": "uint16_decimeters", // h = hMin + value/10
  },

  "imagery": {
    "dir": "imagery",
    "chunkCols": 4,
    "chunkRows": 4,
    "chunkPx": 2048,
    "files": "imagery/chunk_{row}_{col}.jpg",
  },

  "forestMask": { "file": "forest.png", "cols": 420, "rows": 351 },

  "trail": { "file": "trail.json" },
  "vector": { "file": "osm.json" },

  "spawn": { "x": 1500, "y": 1235, "z": 4100, "headingDeg": 78 },

  "attribution": [
    "Elevation: AWS Terrain Tiles (Mapzen/Terrarium)",
    "Imagery: Esri World Imagery",
    "Roads & buildings: © OpenStreetMap contributors",
  ],
}
```

```jsonc
// trail.json
{
  "lengthM": 22360,
  "points": [{ "x": 1500, "y": 1235, "z": 4100, "distM": 0 } /* ... */],
  "waypoints": [{ "name": "Half Dome", "x": 2980, "y": 2694, "z": 1820 }],
}
```

`heights.bin` is raw little-endian `Uint16`, `cols * rows` values, row 0 = the
northern edge, increasing south (+Z). Decode in the renderer with
`h = hMin + u16 / 10`.

---

## 7. Renderer modules

Three.js + Vite. Each is a small module under `src/`.

- **`loader.js`** — fetch manifest, then heights.bin + imagery chunks + forest +
  osm + trail. Show a progress UI; reveal terrain as chunks arrive rather than
  blocking on everything.
- **`terrain.js`** — one mesh per imagery chunk, vertices from the heightmap,
  imagery as the diffuse texture. Slope-based relighting per time of day, and a
  green-selective desaturation/warmth pass to tame the satellite imagery's olive
  cast (do this in the terrain shader).
- **`trail.js`** — the GPX polyline as a ribbon/tube offset a fraction of a meter
  above the surface so it reads clearly without z-fighting. Markers at trailhead,
  end, and named waypoints.
- **`forest.js`** — instanced trees placed by sampling `forest.png`; jittered
  positions, a few painted archetypes, wind sway in the vertex shader, LOD cells
  that stream in/out around the camera. Open mask = no trees; steep slope = no
  trees.
- **`sky.js`** — time-of-day (dawn→midday→golden→dusk→night), cross-fading sky
  color, sun direction, exposure, and distance fog. Optional grounded valley-fog
  slab as a stretch goal.
- **`water.js`** — OSM `natural=water` polygons as flat planes at local DEM
  height with a simple animated normal map. Optional: auto-place `natural=waterfall`
  POIs as short procedural falls (no hand placement).
- **`human.js`** (optional) — OSM roads draped as ribbons, building footprints
  extruded. Skip for v1 unless the trail is near a town.
- **`controls.js`** — pointer-lock look; WASD move; Space/C up/down in fly mode;
  Shift boost; F toggles fly↔walk (walk clamps to ground at eye height).
- **`hud.js`** — trail name, distance, current elevation, time-of-day key hint.

Keep the whole add-on layer (forest/water/human/weather) on a draw-call budget so
it holds 60 fps — the reference project kept its human+wildlife+weather layer to
roughly ten extra draw calls.

---

## 8. Local server

`server.mjs` (Express or polka + a static handler):

- `GET /` — drag-drop upload page.
- `POST /bake` — accepts the GPX (multipart). Validates (size cap, parses,
  enforces the area cap), runs `lib/bake.mjs` in a child process, streams
  progress over **SSE**, responds with `{ worldId }` when done.
- `GET /worlds/:id/*` — static-serve the baked dataset.
- `GET /explore/:id` — the renderer, told which world to load via the URL.

No database. The filesystem (`worlds/`, `cache/`) is the entire store. A CLI
(`node lib/bake.mjs trail.gpx`) does the same bake without the browser, for
scripting.

---

## 9. Key tradeoffs

- **Corridor vs. full box.** Corridor masking pays off on long linear hikes
  (a point-to-point can be 70–80% empty rectangle); compact loops nearly fill
  their box, so just bake the padded box. Decide per trail from the tile counts
  `gpx-bounds.mjs` prints.
- **Sample spacing.** 7.6 m matches the source and looks crisp but grows
  `heights.bin`; coarsen for very large areas.
- **Imagery zoom.** z16 over the core is sharp but multiplies tile count 4× vs
  z15. Use z16 only within the corridor, z15 for the surrounding context.
- **Chunk size.** Smaller chunks = more draw calls but safer textures and finer
  culling. Target ≤ 2048 px textures, tune chunk count to keep draw calls sane.
- **Look quality varies by place.** Dramatic terrain with crisp imagery (alpine,
  canyon) looks spectacular; a flat forested trail will be correct but plainer.
  This is inherent to the data, not a bug to fix.

---

## 10. Build plan

- **P0 — Scaffold.** Vite + Three.js project, `lib/gpx-bounds.mjs` in place,
  the CLI prints a bake plan for a real GPX.
- **P1 — It works (the milestone that proves the idea).** Bake elevation +
  imagery for one trail; render the textured terrain; spawn at the trailhead;
  draw the trail ribbon. If this looks good, the rest is additive.
- **P2 — Life.** Forest from the mask; sky + time-of-day; fog.
- **P3 — Detail.** OSM water; optional roads/buildings; POI markers.
- **P4 — Polish.** HUD, walk mode, optional weather/wildlife/audio.
- **Throughout — Verify.** A Playwright harness that drives the app headlessly,
  screenshots fixed viewpoints, and lets you _look at your own output_ to catch
  buried trail geometry, wrong tree color, or misplaced terrain — the single
  most valuable habit from the reference project.

---

## 11. Suggested project layout

```
trailscape/
  README.md
  DESIGN.md
  package.json
  index.html
  vite.config.js
  server.mjs                # local upload + serve
  lib/                      # bake pipeline (Node)
    gpx-bounds.mjs          # parse + plan (done)
    fetch-elevation.mjs
    build-heightmap.mjs
    build-imagery.mjs
    build-mask.mjs
    fetch-osm.mjs
    build-trail.mjs
    write-manifest.mjs
    bake.mjs                # orchestrator + CLI
  src/                      # renderer (browser)
    main.js
    loader.js
    terrain.js
    trail.js
    forest.js
    sky.js
    water.js
    human.js
    controls.js
    hud.js
  tools/
    verify.mjs              # headless checks + screenshots
  cache/                    # raw tiles, by z/x/y (gitignored)
  worlds/                   # baked datasets, by worldId (gitignored)
```

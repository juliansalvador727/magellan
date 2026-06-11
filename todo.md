# magellan — todo

Features to scope next, roughly ordered by effort. Each entry says what it is,
where it would land, and the main question to answer before building it.

---

## Quick wins

- **POI markers.** `fetch-osm.mjs` already bakes peaks, waterfalls, and
  viewpoints into `osm.json`, but the renderer never shows them. Floating
  labels that fade with distance (new `src/poi.js`). Question: label style that
  stays readable against bright sky *and* dark terrain.

- **Elevation profile in the HUD.** `trail.json` already carries `distM` per
  point — draw a small canvas profile in `hud.js` with a live position marker
  (the nearest-point search is already computed every 15 frames). Question:
  always-on or toggled?

- **World management on the upload page.** Delete (and maybe rename) baked
  worlds from the list. Needs a `DELETE /api/worlds/:id` endpoint and a confirm
  step in `upload.js`. Question: also expose cache size / a "clear cache" button?

- **Waypoint markers from the GPX.** `parseGpx()` already separates named
  `<wpt>` entries and `build-trail.mjs` writes them to `trail.json`; render
  them like POIs. Mostly free once POI markers exist.

---

## Medium

- **Trail flythrough.** Auto-follow camera that rides the trail at a chosen
  speed with gentle look-ahead — a guided tour of the route, and the natural
  base for video capture. New mode in `controls.js` (or a `src/tour.js`).
  Question: how to handle switchbacks without nauseating camera swings
  (smooth the heading over N meters of lookahead?).

- **Ghost hiker.** GPX files from real recordings carry timestamps; keep them
  in `build-trail.mjs` and replay the actual pace as a moving marker you can
  race or follow. Question: what to do for route files with no timestamps.

- **Minimap.** Top-down composite of the imagery chunks with the trail and a
  player arrow, corner of the HUD. The imagery already exists as chunk JPEGs;
  a small canvas drawing a downscaled mosaic may be enough. Question: static
  whole-world map vs. scrolling local view.

- **Seasons / weather.** Rain and snow particles, an elevation-based snowline
  tint in the terrain shader, drifting clouds. Lands across `sky.js` +
  `terrain.js`. Question: purely cosmetic toggle, or inferred from the trail's
  latitude/elevation and a chosen month?

- **Multiple trails in one world.** Bake N GPX files that share a region into
  one bbox (the tile cache already de-dupes downloads), render all ribbons,
  pick a spawn. Touches `planBake()`, the bake orchestrator, and the manifest
  schema. Question: world identity — today `worldId` is a hash of one trail's
  bbox.

- **Forest quality pass.** Species archetypes chosen by elevation/slope
  (conifer high, broadleaf low), better wind, density slider in the HUD.
  All in `forest.js` + maybe a second channel in `forest.png`. Question: how
  much can the mask infer (NDVI-ish green strength → density) vs. needs new data.

---

## Big swings

- **Streaming LOD terrain.** Remove the ~2500 km² area cap by streaming
  heightmap and imagery tiles around the camera instead of loading everything
  up front. Rework of `loader.js` + `terrain.js`, and the bake would write
  tiled pyramids. This is the thru-hike feature; scope carefully.

- **Hostable imagery.** Swap Esri for a redistributable source (NAIP for the
  US, Sentinel-2 globally) behind a per-source adapter in `tiles.mjs`, making
  a public deployment legal. Prerequisite for any sharing feature beyond
  screenshots.

- **WebXR.** Walk mode in a headset. Three.js makes the rendering side cheap;
  the work is comfort (teleport vs. smooth locomotion) and HUD re-design.

- **Touch / mobile controls.** Virtual joystick + drag-look. The renderer
  already runs on mobile GPUs in principle; the question is texture memory at
  current chunk sizes.

---

## Tooling / debt

- Unit tests for `gpx-bounds.mjs` parsing/planning against `fixtures/` (the
  regex parser is the most likely thing to break on weird GPX exports).
- Run `tools/verify.mjs` in CI on a small fixture world.
- The pointer-lock spike guard in `controls.js` logs to `console.debug` —
  remove the log once the flick bug is confirmed dead.

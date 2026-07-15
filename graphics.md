# magellan — Graphics Upgrade Plan

> **Status (June 2026):** the core of this plan has landed, modeled on
> [ode-to-yosemite](https://github.com/shlokkhemani/ode-to-yosemite)'s
> rendering approach:
>
> - `src/atmosphere.js` (new) — global aerial-perspective fog (exponential
>   haze, grounded valley-fog slab, sun inscatter) patched into every material.
> - `src/sky.js` — physical scattering sky (three's Sky addon), five presets
>   driving haze/tint/relight/exposure/stars; unlit materials are tinted.
> - `src/terrain.js` — imagery rendered **unlit** (its real baked sun shading
>   does the lighting), with a color grade, two-scale detail noise plus
>   sub-meter grain, and DEM-normal slope relighting per time-of-day.
> - `src/forest.js` — canvas-painted tree atlases (conifer / cedar /
>   broadleaf) on card geometry, streamed in deterministic cells: full 3D
>   card trees near, crossed cards far, imagery canopy beyond. Species still
>   chosen from elevation/slope/water/density; trail clearing kept.
> - `src/clutter.js` — painted grass/fern cards, seated rocks and logs.
> - `src/water.js` — fresnel toward the sky color, layered ripples, sun glint.
> - `lib/build-imagery.mjs` — z17 Esri tiles in the trail corridor
>   (4096 px chunks ≈ 1 m/px), true-resolution z15 context at 1024 px
>   elsewhere; old z16 worlds still load. Re-bake with
>   `node lib/bake.mjs <gpx> --force` to get the sharper tiles.
>
> Not yet done: shadows/SSAO (Phase 5.3–5.4), the RGBA vegetation mask
> (Phase 6), weather, and bake-time quality presets.

Goal: make every baked trail look richer without hand-authoring per-location
art. The upgrades should generalize from data already in each world: elevation,
satellite imagery, forest mask, OSM vectors, trail geometry, and local frame
metadata.

The current renderer is intentionally lean:

- `src/forest.js`: two low-poly instanced tree archetypes, one conifer and one
  broadleaf, driven by `forest.png`.
- `src/terrain.js`: heightmap mesh per imagery chunk, satellite imagery as
  diffuse color, Lambert lighting, small color-correction shader.
- `src/sky.js`: procedural sky, sun, hemisphere light, fog, stars.
- `src/water.js`: flat OSM water polygons with a cheap animated ripple shader.
- `lib/build-mask.mjs`: single-channel canopy-density mask inferred from imagery.

The plan below keeps that data-driven shape, but adds quality where it matters
most: near the trail and near the camera.

---

## Principles

- **Spend detail near the user.** The trail corridor and camera neighborhood
  should look good; distant hills can stay cheap.
- **Preserve deterministic bakes.** Same GPX and same settings should produce
  the same visual world.
- **Prefer instancing over unique meshes.** Trees, shrubs, rocks, grass, and
  fallen logs should remain GPU-friendly.
- **Keep quality tunable.** Add Low / Medium / High / Ultra presets before
  raising defaults.
- **Never rely on one place looking good.** Test against Juan de Fuca, Panorama
  Ridge, The Chief, Mist Trail, and one flatter forest trail.

---

## Phase 0 — Baseline And Budgets

Before changing visuals, create a repeatable comparison loop.

1. Add a graphics verification mode to `tools/verify.mjs`.
   Capture the same viewpoints for each sample world:
   `spawn`, `midtrail`, `overhead`, `forest-close`, `ridge-distance`, `water`.

2. Add lightweight runtime counters exposed on `window.__magellan.graphics`:
   tree count, draw calls, triangle count estimate, texture memory estimate,
   frame time rolling average.

3. Define budgets:
   - Medium: 60 fps on a normal laptop, <= 250k tree instances.
   - High: 45-60 fps, <= 500k vegetation instances total.
   - Ultra: visual screenshots first, performance second.

4. Store screenshots under `shots/graphics/<worldId>/<preset>/`.

Acceptance: each future graphics change can be compared before/after on the
same worlds and viewpoints.

---

## Phase 1 — Better Trees Without Changing Bake Format

Target files: `src/forest.js`, optionally `src/sky.js`.

This is the fastest path to a visible quality lift.

### Tree Archetypes

Replace the two current primitives with 5-7 richer procedural archetypes:

- tall conifer
- young conifer
- dense cedar/hemlock style conifer
- broadleaf round canopy
- broadleaf irregular canopy
- dead snag / bare trunk
- small understory sapling

Keep each archetype merged into one geometry and rendered as instanced meshes.
Use simple geometry, but more natural silhouettes:

- layered cone/frustum clusters instead of two giant cones
- slight trunk lean
- irregular canopy scaling
- nonuniform branch/canopy rotation
- per-vertex color gradients: darker underside, brighter sun side, brown trunk

### Per-Instance Variation

Extend each generated tree object with:

- `species`
- `height`
- `radius`
- `lean`
- `windPhase`
- `colorA` / `colorB`
- `snowOrDryness` later

Use instance color for base tint, and encode extra values in an instanced
attribute if needed. Avoid creating one material per tree.

### Placement Improvements

Still use `forest.png`, but improve placement rules:

- bias conifers at higher elevation and steeper slopes
- bias broadleafs at lower elevation and near water
- put saplings and shrubs along forest edges
- make trail-adjacent thinning softer, not random holes
- avoid obvious grid patterns by using blue-noise-ish jitter per mask cell

Acceptance: close-up trees no longer read as cones; forest edges look organic;
tree species vary naturally across elevation and slope.

---

## Phase 2 — LOD Forest Cells

Target files: `src/forest.js`, `src/main.js`.

The current forest is one or two world-sized `InstancedMesh` objects with
`frustumCulled = false`. That is simple, but it prevents real LOD and culling.

Create vegetation cells, probably 128-256 meters wide:

- near cells: detailed tree archetypes, shrubs, rocks, logs
- mid cells: simpler tree archetypes
- far cells: very low-poly trees or billboard impostors
- hidden cells: not in scene

Implementation shape:

1. During placement, bucket instances by cell.
2. Each cell owns a small set of `InstancedMesh` objects by archetype and LOD.
3. On each frame, update only a few cells around the camera.
4. Keep a pool of reusable meshes so moving through a world does not allocate
   constantly.

Acceptance: increasing near-tree quality does not require drawing the entire
world at that quality.

---

## Phase 3 — Ground Clutter Along The Trail

Target files: `src/forest.js`, new `src/clutter.js`.

Add small instanced details within 50-150 meters of the trail:

- grass tufts
- fern/salal-like broadleaf plants
- low shrubs
- rocks
- fallen logs
- small stumps

Derive placement from existing data:

- forest mask density for shrubs and ferns
- slope for rocks
- distance-to-trail for visible detail priority
- water proximity for greener plants
- elevation for alpine vs coastal look

Use simple crossed planes for grass/ferns and low-poly meshes for rocks/logs.
If texture assets are introduced, keep them small and generated/checked in
under `public/vegetation/`.

Acceptance: walking mode near the trail has foreground detail instead of bare
satellite imagery.

---

## Phase 4 — Better Terrain Materials

Target files: `src/terrain.js`, `lib/build-imagery.mjs`, possibly
`lib/write-manifest.mjs`.

Satellite imagery gives accurate color but weak close-up surface detail. Add a
terrain shader that keeps imagery as the base but overlays procedural material
cues.

### Shader Layers

Add slope/elevation-aware overlays:

- grass/moss on gentle green terrain
- rock on steep terrain
- scree/gravel near ridgelines
- snow above a configurable snowline
- darker wet ground near water

Use heightmap-derived normals and procedural noise. Keep the imagery visible so
the route still resembles the real place.

### Normal And Detail Textures

Generate or include small tiling textures:

- grass color/noise
- rock normal/noise
- dirt/gravel noise
- snow noise

Blend them in `terrain.js` using triplanar or world-space UVs to avoid obvious
texture stretching on slopes.

### Imagery Quality Option

Add a bake quality setting:

- Medium: current z16 core / z15 edge
- High: z17 core near trail / z16 edge
- Ultra: z17 core plus smaller chunks or higher JPEG quality

Acceptance: close terrain does not look like a blurry aerial photo, while
distant terrain still uses satellite context.

---

## Phase 5 — Lighting, Shadows, And Postprocessing

Target files: `src/main.js`, `src/sky.js`, `src/terrain.js`, `src/forest.js`.

Lighting is currently sun + hemisphere + fog with Lambert materials. Upgrade in
steps.

1. Enable renderer output settings consistently:
   - keep ACES tone mapping
   - set clear color through sky/fog
   - expose exposure per preset

2. Move tree and terrain materials toward `MeshStandardMaterial` or custom
   shaders with roughness-style response.

3. Add optional sun shadows for High/Ultra:
   - shadow camera centered around player
   - 150-300 meter shadow box
   - tree trunks/canopies cast shadows only in near cells
   - terrain receives shadows near camera

4. Add cheap ambient occlusion:
   - start with screen-space ambient occlusion only in High/Ultra
   - if postprocessing is too expensive, fake tree contact shadows with dark
     transparent disks under near trees

5. Improve atmosphere:
   - layered distance haze
   - soft cloud bands
   - fog density tied to time-of-day and world scale

Acceptance: trees sit into the ground, forest interiors have depth, and golden
hour/night screenshots look less flat.

---

## Phase 6 — Richer Forest Mask And Bake Metadata

Target files: `lib/build-mask.mjs`, `lib/write-manifest.mjs`, `src/loader.js`,
`src/forest.js`.

The current `forest.png` stores only density. Upgrade it to either multiple
files or a packed RGBA PNG:

- R: canopy density
- G: conifer likelihood
- B: broadleaf / shrub likelihood
- A: clutter density or confidence

Derive channels from:

- imagery color and texture
- elevation
- slope/aspect
- latitude
- water proximity from OSM
- trail distance

Add this to the manifest as a versioned vegetation layer:

```jsonc
"vegetation": {
  "version": 2,
  "file": "vegetation.png",
  "cols": 420,
  "rows": 351,
  "channels": ["density", "conifer", "broadleaf", "clutter"]
}
```

Keep backward compatibility: if only `forestMask` exists, render with the old
single-channel behavior.

Acceptance: coastal forests, alpine forests, and mixed lowland forests produce
different species mixes without hand tuning per trail.

---

## Phase 7 — Water, Roads, Buildings, And POI Polish

Target files: `src/water.js`, `src/trail.js`, new `src/osm-layer.js`.

These are secondary to trees, but they make worlds feel less empty.

- Water:
  - better shoreline blending
  - fresnel-like highlight
  - slower large ripples plus small sparkle
  - color from depth proxy or waterbody size

- Roads/buildings:
  - render OSM roads as subtle ribbons
  - render building footprints as low extrusions
  - keep this muted so trail/nature remain dominant

- POIs:
  - distance-faded labels
  - peak/waterfall/viewpoint icons
  - occlusion-aware or horizon-aware placement if labels get noisy

Acceptance: OSM context helps orientation without making the scene look like a
map overlay.

---

## Quality Presets

Add a graphics preset object and use it across modules:

```js
export const GRAPHICS_PRESETS = {
  low: {
    pixelRatio: 1,
    treeBudget: 120_000,
    clutter: false,
    shadows: false,
    terrainDetail: false,
  },
  medium: {
    pixelRatio: 1.5,
    treeBudget: 240_000,
    clutter: "near",
    shadows: false,
    terrainDetail: true,
  },
  high: {
    pixelRatio: 2,
    treeBudget: 500_000,
    clutter: true,
    shadows: "near",
    terrainDetail: true,
  },
  ultra: {
    pixelRatio: 2,
    treeBudget: 900_000,
    clutter: true,
    shadows: "near",
    terrainDetail: true,
  },
};
```

Read the preset from `localStorage`, URL query (`?gfx=high`), or a HUD menu.

---

## Suggested Build Order

1. Add graphics verification screenshots and counters.
2. Improve procedural tree archetypes in `src/forest.js`.
3. Add species/elevation/slope placement variation.
4. Split the forest into camera-near LOD cells.
5. Add shrubs/rocks/logs along the trail corridor.
6. Add terrain detail shader overlays.
7. Add High/Ultra shadows and contact grounding.
8. Upgrade `forest.png` to a versioned vegetation mask.
9. Tune water, roads, POIs, clouds, and weather.

This order gives visible wins early while postponing data format changes until
the renderer proves what extra metadata it actually needs.

---

## Open Questions

- Should graphics quality be chosen at bake time, runtime, or both?
- Are external texture assets acceptable, or should everything remain procedural?
- Should worlds store optional high-quality vegetation metadata, or should the
  renderer infer species at load time from the old mask and heightmap?
- What is the minimum target machine: integrated laptop GPU, Apple Silicon, or
  desktop GPU?
- Is mobile support important for High quality, or should mobile default to Low?


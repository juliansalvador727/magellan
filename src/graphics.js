// graphics.js — shared runtime graphics presets and lightweight counters.

// forestNear/forestFar are streaming radii in meters (full card trees vs
// crossed-card impostors); forestDensity scales placement attempts per cell.
export const GRAPHICS_PRESETS = {
  low: {
    id: "low",
    pixelRatio: 1,
    forestNear: 380,
    forestFar: 1500,
    forestDensity: 0.65,
    clutter: false,
    terrainDetail: false,
  },
  medium: {
    id: "medium",
    pixelRatio: 1.5,
    forestNear: 680,
    forestFar: 2500,
    forestDensity: 1,
    clutter: "near",
    terrainDetail: true,
  },
  high: {
    id: "high",
    pixelRatio: 2,
    forestNear: 900,
    forestFar: 3300,
    forestDensity: 1.15,
    clutter: true,
    terrainDetail: true,
  },
  ultra: {
    id: "ultra",
    pixelRatio: 2,
    forestNear: 1100,
    forestFar: 4200,
    forestDensity: 1.3,
    clutter: true,
    terrainDetail: true,
  },
};

export function getGraphicsPreset() {
  const query = new URLSearchParams(location.search).get("gfx");
  const stored = localStorage.getItem("magellan.graphicsPreset");
  const id = normalizePresetId(query || stored || "medium");
  if (query && id === query.toLowerCase()) {
    localStorage.setItem("magellan.graphicsPreset", id);
  }
  return GRAPHICS_PRESETS[id] ?? GRAPHICS_PRESETS.medium;
}

export function createGraphicsCounters({ renderer, world, forest, terrain, clutter, preset }) {
  const clutterCount = clutter?.count ?? 0;
  const values = {
    preset: preset.id,
    treeCount: forest.count,
    clutterCount,
    vegetationCount: forest.count + clutterCount,
    forestMeshes: forest.meshes.length,
    clutterMeshes: clutter?.meshes?.length ?? 0,
    terrainMeshes: terrain.meshes.length,
    drawCalls: 0,
    triangleCountEstimate: forest.triangleEstimate + terrain.triangleEstimate + (clutter?.triangleEstimate ?? 0),
    textureMemoryEstimateBytes: estimateTextureMemory(world),
    textureMemoryEstimateMB: 0,
    frameTimeAverageMs: 0,
    bySpecies: forest.bySpecies,
  };
  values.textureMemoryEstimateMB = round(values.textureMemoryEstimateBytes / (1024 * 1024), 1);

  let avgMs = 0;
  let frames = 0;

  return {
    values,
    update(dt) {
      const frameMs = dt * 1000;
      avgMs = frames === 0 ? frameMs : avgMs * 0.92 + frameMs * 0.08;
      frames++;

      values.frameTimeAverageMs = round(avgMs, 1);
      values.drawCalls = renderer.info.render.calls;
      // the forest streams around the camera, so its counts are live
      values.treeCount = forest.count;
      values.vegetationCount = forest.count + clutterCount;
      values.forestMeshes = forest.meshes.length;
      values.bySpecies = forest.bySpecies;
      values.triangleCountEstimate =
        renderer.info.render.triangles ||
        forest.triangleEstimate + terrain.triangleEstimate + (clutter?.triangleEstimate ?? 0);
      values.rendererTextureCount = renderer.info.memory.textures;
      values.rendererGeometryCount = renderer.info.memory.geometries;
    },
  };
}

function normalizePresetId(id) {
  const key = String(id || "").trim().toLowerCase();
  return GRAPHICS_PRESETS[key] ? key : "medium";
}

function estimateTextureMemory(world) {
  const imagery = world.manifest.imagery?.chunks ?? [];
  let bytes = 0;
  for (const chunk of imagery) {
    const px = chunk.px || world.manifest.imagery.chunkPx || 2048;
    const py = chunk.py || world.manifest.imagery.chunkPx || px;
    bytes += px * py * 4 * (4 / 3); // RGBA plus mip levels.
  }
  if (world.forest) bytes += world.forest.cols * world.forest.rows * 4;
  return Math.round(bytes);
}

function round(v, places) {
  const s = 10 ** places;
  return Math.round(v * s) / s;
}

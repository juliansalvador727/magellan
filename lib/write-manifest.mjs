// write-manifest.mjs — stage 8: assemble manifest.json (schema: DESIGN.md §6).
// The manifest is written LAST: its presence marks a world as complete, so a
// crashed bake never leaves a half-world that the server would happily serve.

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { M_PER_DEG_LAT } from "./frame.mjs";

export async function writeManifest({ worldDir, worldId, name, frame, hm, imagery, mask, osm, trail }) {
  const manifest = {
    worldId,
    name: name ?? "Unnamed trail",
    createdAt: new Date().toISOString(),

    frame: {
      // NW corner: +Z (south) and heightmap rows increase together. See frame.mjs.
      originLat: frame.originLat,
      originLon: frame.originLon,
      originCorner: "NW",
      lat0: frame.lat0,
      metersPerDegLat: M_PER_DEG_LAT,
    },

    extentMeters: {
      width: Math.round(frame.widthM),
      height: Math.round(frame.heightM),
    },

    heightmap: {
      file: hm.file,
      cols: hm.cols,
      rows: hm.rows,
      sampleSpacingM: hm.sampleSpacingM,
      hMin: hm.hMin,
      hMax: hm.hMax,
      encoding: hm.encoding,
    },

    imagery: {
      dir: imagery.dir,
      chunkCols: imagery.chunkCols,
      chunkRows: imagery.chunkRows,
      chunkPx: imagery.chunkPx,
      coreZoom: imagery.coreZoom,
      edgeZoom: imagery.edgeZoom,
      files: imagery.files,
      chunks: imagery.chunks,
    },

    forestMask: { file: mask.file, cols: mask.cols, rows: mask.rows },

    trail: { file: trail.file, lengthM: trail.lengthM },
    vector: { file: osm.file },

    spawn: trail.spawn,

    attribution: [
      "Elevation: AWS Terrain Tiles (Mapzen/Terrarium)",
      "Imagery: Esri World Imagery",
      "Roads & buildings: © OpenStreetMap contributors",
    ],
  };

  await writeFile(path.join(worldDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return manifest;
}

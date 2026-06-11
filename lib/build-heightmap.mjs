// build-heightmap.mjs — stage 3: resample the decoded elevation mosaic onto a
// regular grid in the local metric frame and write heights.bin.
//
// Grid layout: row-major Uint16 little-endian, row 0 = north edge, rows
// increase southward (+Z), value = round((h - hMin) * 10) i.e. 0.1 m steps.
// The grid spans the frame extent exactly: spacingX = widthM/(cols-1),
// spacingZ = heightM/(rows-1) — both within rounding of sampleSpacingM.

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { lonToPxX, latToPxY } from "./tiles.mjs";

const TARGET_SPACING_M = 7.6; // matches z14 source resolution
const MAX_SAMPLES = 4_200_000; // ~8.4 MB heights.bin; coarsen past this

export async function buildHeightmap({ frame, mosaic, worldDir, onProgress }) {
  let spacing = TARGET_SPACING_M;
  let cols = Math.round(frame.widthM / spacing) + 1;
  let rows = Math.round(frame.heightM / spacing) + 1;
  while (cols * rows > MAX_SAMPLES) {
    spacing *= 1.25;
    cols = Math.round(frame.widthM / spacing) + 1;
    rows = Math.round(frame.heightM / spacing) + 1;
  }
  const spacingX = frame.widthM / (cols - 1);
  const spacingZ = frame.heightM / (rows - 1);

  const heights = new Float32Array(cols * rows);
  const { data, width: MW, height: MH, px0, py0, zoom } = mosaic;

  for (let r = 0; r < rows; r++) {
    const { lat } = frame.toLatLon(0, r * spacingZ);
    const pyF = latToPxY(lat, zoom) - py0 - 0.5; // -0.5: sample at pixel centers
    for (let c = 0; c < cols; c++) {
      const { lon } = frame.toLatLon(c * spacingX, 0);
      const pxF = lonToPxX(lon, zoom) - px0 - 0.5;
      heights[r * cols + c] = bilinear(data, MW, MH, pxF, pyF);
    }
    if (r % 64 === 0) onProgress?.(r, rows, `heightmap row ${r}/${rows}`);
  }

  let hMin = Infinity;
  let hMax = -Infinity;
  for (const h of heights) {
    if (h < hMin) hMin = h;
    if (h > hMax) hMax = h;
  }

  const u16 = new Uint16Array(cols * rows);
  for (let i = 0; i < heights.length; i++) {
    u16[i] = Math.max(0, Math.min(65535, Math.round((heights[i] - hMin) * 10)));
  }
  await writeFile(path.join(worldDir, "heights.bin"), Buffer.from(u16.buffer));
  onProgress?.(rows, rows, "heights.bin written");

  return {
    cols,
    rows,
    sampleSpacingM: Number(((spacingX + spacingZ) / 2).toFixed(3)),
    hMin: Math.floor(hMin * 10) / 10,
    hMax: Math.ceil(hMax * 10) / 10,
    encoding: "uint16_decimeters",
    file: "heights.bin",
    heights, // in-memory floats for later stages (not serialized)
  };
}

function bilinear(data, W, H, x, y) {
  const x0 = Math.max(0, Math.min(W - 1, Math.floor(x)));
  const y0 = Math.max(0, Math.min(H - 1, Math.floor(y)));
  const x1 = Math.min(W - 1, x0 + 1);
  const y1 = Math.min(H - 1, y0 + 1);
  const tx = Math.max(0, Math.min(1, x - x0));
  const ty = Math.max(0, Math.min(1, y - y0));
  const a = data[y0 * W + x0] * (1 - tx) + data[y0 * W + x1] * tx;
  const b = data[y1 * W + x0] * (1 - tx) + data[y1 * W + x1] * tx;
  return a * (1 - ty) + b * ty;
}

/** Bilinear height sampler over the local frame, for later bake stages. */
export function makeHeightSampler(hm, frame) {
  const { heights, cols, rows } = hm;
  const sx = frame.widthM / (cols - 1);
  const sz = frame.heightM / (rows - 1);
  return (x, z) => {
    const fc = Math.max(0, Math.min(cols - 1, x / sx));
    const fr = Math.max(0, Math.min(rows - 1, z / sz));
    const c0 = Math.floor(fc);
    const r0 = Math.floor(fr);
    const c1 = Math.min(cols - 1, c0 + 1);
    const r1 = Math.min(rows - 1, r0 + 1);
    const tc = fc - c0;
    const tr = fr - r0;
    const a = heights[r0 * cols + c0] * (1 - tc) + heights[r0 * cols + c1] * tc;
    const b = heights[r1 * cols + c0] * (1 - tc) + heights[r1 * cols + c1] * tc;
    return a * (1 - tr) + b * tr;
  };
}

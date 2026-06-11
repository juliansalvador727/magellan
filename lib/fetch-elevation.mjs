// fetch-elevation.mjs — stage 2: download Terrarium tiles for the padded box
// and decode them into one Float32 mercator-pixel mosaic.
//
// Elevation always fetches the FULL padded box (not the corridor): z14 tile
// counts are small even for big worlds, and corridor holes in the heightmap
// would render as craters. The corridor optimization is for imagery (4x the
// tiles per zoom step).

import sharp from "sharp";
import { getTiles, tileKey } from "./tiles.mjs";

export const ELEVATION_ZOOM = 14; // ~7.6 m/sample at mid latitudes

/**
 * @param {import('./gpx-bounds.mjs').BakePlan} plan
 * @returns mosaic: decoded meters, indexed by global mercator px minus (px0,py0)
 */
export async function fetchElevation(plan, { cacheRoot, onProgress } = {}) {
  const z = ELEVATION_ZOOM;
  const tiles = plan.tilesForZoom(z);
  const bufs = await getTiles("terrarium", tiles, cacheRoot, {
    onProgress: (done, total) => onProgress?.(done, total, `elevation tile ${done}/${total}`),
  });

  const xs = tiles.map((t) => t.x);
  const ys = tiles.map((t) => t.y);
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  const cols = Math.max(...xs) - x0 + 1;
  const rows = Math.max(...ys) - y0 + 1;
  const W = cols * 256;
  const H = rows * 256;
  const data = new Float32Array(W * H); // missing tiles stay 0 m (ocean / void)

  let misses = 0;
  for (const t of tiles) {
    const buf = bufs.get(tileKey(t));
    if (!buf) {
      misses++;
      continue;
    }
    const { data: raw, info } = await sharp(buf)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const ox = (t.x - x0) * 256;
    const oy = (t.y - y0) * 256;
    const ch = info.channels;
    for (let py = 0; py < 256; py++) {
      let di = (oy + py) * W + ox;
      let si = py * 256 * ch;
      for (let px = 0; px < 256; px++, di++, si += ch) {
        // Terrarium decode: meters = (R*256 + G + B/256) - 32768
        data[di] = raw[si] * 256 + raw[si + 1] + raw[si + 2] / 256 - 32768;
      }
    }
  }
  if (misses) console.warn(`  (${misses} elevation tiles missing — filled with 0 m)`);

  return { data, width: W, height: H, px0: x0 * 256, py0: y0 * 256, zoom: z };
}

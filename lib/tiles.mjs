// tiles.mjs — download + cache slippy-map tiles, plus web-mercator pixel math.
//
// Every raw tile is cached under cache/<kind>/<z>/<x>/<y>.<ext> so a second
// trail overlapping the same area is mostly cache hits. A 404 (no tile) is
// remembered as a zero-byte file so we don't re-request it every bake.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const SOURCES = {
  terrarium: {
    url: (z, x, y) =>
      `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`,
    ext: "png",
  },
  esri: {
    // note the y-before-x path order on the ArcGIS endpoint
    url: (z, x, y) =>
      `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`,
    ext: "jpg",
  },
};

const USER_AGENT = "magellan/0.1 (local personal use)";

/** Fractional mercator pixel coords at zoom z (256px tiles). */
export const lonToPxX = (lon, z) => ((lon + 180) / 360) * 2 ** z * 256;
export const latToPxY = (lat, z) => {
  const s = Math.sin((lat * Math.PI) / 180);
  const m = 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
  return m * 2 ** z * 256;
};

/** Ground meters per mercator pixel at a latitude (256px tiles). */
export const metersPerPixel = (lat, z) =>
  ((40_075_016.686 * Math.cos((lat * Math.PI) / 180)) / 2 ** z) / 256;

export const tileKey = (t) => `${t.z}/${t.x}/${t.y}`;

/**
 * Fetch one tile through the disk cache. Returns the encoded image Buffer,
 * or null if the source has no tile there (404).
 */
export async function getTile(kind, z, x, y, cacheRoot) {
  const src = SOURCES[kind];
  const file = path.join(cacheRoot, kind, String(z), String(x), `${y}.${src.ext}`);
  try {
    const buf = await readFile(file);
    return buf.length === 0 ? null : buf; // zero-byte = cached miss
  } catch {
    /* not cached */
  }

  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(src.url(z, x, y), {
        headers: { "user-agent": USER_AGENT },
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status === 404 || res.status === 400) {
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, Buffer.alloc(0));
        return null;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${src.url(z, x, y)}`);
      const buf = Buffer.from(await res.arrayBuffer());
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, buf);
      return buf;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
  throw new Error(`tile ${kind} ${z}/${x}/${y} failed after 3 tries: ${lastErr?.message}`);
}

/**
 * Fetch a list of {x,y,z} tiles with limited concurrency.
 * @returns {Promise<Map<string, Buffer|null>>} keyed by `z/x/y`
 */
export async function getTiles(kind, tiles, cacheRoot, { concurrency = 8, onProgress } = {}) {
  const out = new Map();
  let next = 0;
  let done = 0;
  async function worker() {
    while (next < tiles.length) {
      const t = tiles[next++];
      const buf = await getTile(kind, t.z, t.x, t.y, cacheRoot);
      out.set(tileKey(t), buf);
      done++;
      onProgress?.(done, tiles.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tiles.length) }, worker));
  return out;
}

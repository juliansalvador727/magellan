// loader.js — fetch the baked dataset and expose it as a `world` object.
// Heightmap/trail/osm/forest block the reveal; imagery textures stream in
// afterwards (terrain.js swaps them onto the meshes as they arrive).

import * as THREE from "three";

export async function loadWorld(worldId, onProgress = () => {}) {
  const base = `/worlds/${worldId}`;
  onProgress("manifest", 0.02);
  const manifest = await fetchJson(`${base}/manifest.json`);

  onProgress("heightmap + trail + map data", 0.1);
  const [heightsBuf, trail, osm, forest] = await Promise.all([
    fetch(`${base}/${manifest.heightmap.file}`).then((r) => {
      if (!r.ok) throw new Error(`heights.bin HTTP ${r.status}`);
      return r.arrayBuffer();
    }),
    fetchJson(`${base}/${manifest.trail.file}`),
    fetchJson(`${base}/${manifest.vector.file}`),
    loadMask(`${base}/${manifest.forestMask.file}`),
  ]);
  onProgress("decoding terrain", 0.55);

  const { cols, rows, hMin } = manifest.heightmap;
  const u16 = new Uint16Array(heightsBuf);
  const heights = new Float32Array(cols * rows);
  for (let i = 0; i < u16.length; i++) heights[i] = hMin + u16[i] / 10;

  const W = manifest.extentMeters.width;
  const H = manifest.extentMeters.height;
  const sx = W / (cols - 1);
  const sz = H / (rows - 1);

  /** Bilinear ground height (meters ASL) at local (x, z). */
  function heightAt(x, z) {
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
  }

  // Imagery textures: kick off all loads now, resolve independently.
  const texLoader = new THREE.TextureLoader();
  const textures = manifest.imagery.chunks.map((chunk) => ({
    chunk,
    promise: new Promise((resolve) => {
      texLoader.load(
        `${base}/${chunk.file}`,
        (tex) => {
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.anisotropy = 8;
          tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
          resolve(tex);
        },
        undefined,
        () => resolve(null), // a missing chunk leaves the fallback color
      );
    }),
  }));

  onProgress("ready", 1);
  return {
    id: worldId,
    manifest,
    heights: { data: heights, cols, rows, sx, sz },
    heightAt,
    trail,
    osm,
    forest, // {data: Uint8Array density, cols, rows}
    textures,
  };
}

async function fetchJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} → HTTP ${r.status}`);
  return r.json();
}

async function loadMask(url) {
  const blob = await (await fetch(url)).blob();
  const bmp = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  const rgba = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
  const data = new Uint8Array(bmp.width * bmp.height);
  for (let i = 0; i < data.length; i++) data[i] = rgba[i * 4];
  return { data, cols: bmp.width, rows: bmp.height };
}

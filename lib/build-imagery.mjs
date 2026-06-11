// build-imagery.mjs — stage 4: fetch Esri World Imagery and stitch it into
// chunked, GPU-safe textures (≤ 2048 px per side, one JPEG per chunk).
//
// Two zoom levels: coreZoom only within the trail corridor (sharp where you
// actually walk), edgeZoom across the whole padded box (context). Each chunk
// is assembled at coreZoom scale; slots with no core tile are filled from the
// parent edge tile's upscaled quadrant, so the texture is seamless.
//
// The local frame is linear in latitude but web-mercator is not, so each
// chunk is resampled (bilinear) from mercator pixels onto the frame's linear
// lat/lon grid. Skipping that warp would slide imagery a few meters mid-chunk
// relative to the heightmap and trail.

import { mkdir } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { getTiles, lonToPxX, latToPxY, metersPerPixel } from "./tiles.mjs";

const CHUNK_PX = 2048;
const CORE_TILE_BUDGET = 1600; // past this, drop both zooms one level

export async function buildImagery({ plan, frame, worldDir, cacheRoot, onProgress }) {
  let coreZoom = 16;
  let edgeZoom = 15;
  if (plan.corridorTilesForZoom(coreZoom).length > CORE_TILE_BUDGET) {
    coreZoom = 15;
    edgeZoom = 14;
  }

  const coreTiles = plan.corridorTilesForZoom(coreZoom);
  const edgeTiles = plan.tilesForZoom(edgeZoom);
  const total = coreTiles.length + edgeTiles.length;
  let fetched = 0;
  const tick = () => onProgress?.(++fetched, total, `imagery tile ${fetched}/${total}`);
  const coreBufs = await getTiles("esri", coreTiles, cacheRoot, { onProgress: tick });
  const edgeBufs = await getTiles("esri", edgeTiles, cacheRoot, { onProgress: tick });

  const imageryDir = path.join(worldDir, "imagery");
  await mkdir(imageryDir, { recursive: true });

  // Chunk grid sized so a chunk is ~CHUNK_PX wide at coreZoom resolution.
  const mpp = metersPerPixel(frame.lat0, coreZoom);
  const chunkM = CHUNK_PX * mpp;
  const chunkCols = Math.max(1, Math.ceil(frame.widthM / chunkM));
  const chunkRows = Math.max(1, Math.ceil(frame.heightM / chunkM));

  const decodeCache = new Map(); // tile key -> raw 256x256x3, simple LRU
  const getRaw = async (key, make) => {
    if (decodeCache.has(key)) {
      const v = decodeCache.get(key);
      decodeCache.delete(key);
      decodeCache.set(key, v); // refresh recency
      return v;
    }
    const v = await make();
    decodeCache.set(key, v);
    if (decodeCache.size > 400) decodeCache.delete(decodeCache.keys().next().value);
    return v;
  };

  /** Raw RGB for a coreZoom tile slot: real core tile, or upscaled edge quadrant. */
  async function rawForSlot(tx, ty) {
    const coreBuf = coreBufs.get(`${coreZoom}/${tx}/${ty}`);
    if (coreBuf) {
      return getRaw(`c/${tx}/${ty}`, () =>
        sharp(coreBuf).removeAlpha().raw().toBuffer(),
      );
    }
    const edgeBuf = edgeBufs.get(`${edgeZoom}/${tx >> 1}/${ty >> 1}`);
    if (!edgeBuf) return null;
    return getRaw(`d/${tx}/${ty}`, () =>
      sharp(edgeBuf)
        .extract({ left: (tx & 1) * 128, top: (ty & 1) * 128, width: 128, height: 128 })
        .resize(256, 256, { kernel: "cubic" })
        .removeAlpha()
        .raw()
        .toBuffer(),
    );
  }

  const chunks = [];
  for (let cr = 0; cr < chunkRows; cr++) {
    for (let cc = 0; cc < chunkCols; cc++) {
      const x0 = cc * chunkM;
      const z0 = cr * chunkM;
      const x1 = Math.min(x0 + chunkM, frame.widthM);
      const z1 = Math.min(z0 + chunkM, frame.heightM);

      // Mercator pixel box covering this chunk at coreZoom.
      const nw = frame.toLatLon(x0, z0);
      const se = frame.toLatLon(x1, z1);
      const pxX0 = lonToPxX(nw.lon, coreZoom);
      const pxX1 = lonToPxX(se.lon, coreZoom);
      const pyN = latToPxY(nw.lat, coreZoom);
      const pyS = latToPxY(se.lat, coreZoom);
      const ix0 = Math.floor(pxX0);
      const iy0 = Math.floor(pyN);
      const srcW = Math.ceil(pxX1) - ix0 + 1;
      const srcH = Math.ceil(pyS) - iy0 + 1;

      // Assemble the mercator mosaic for the chunk.
      const src = Buffer.alloc(srcW * srcH * 3);
      for (let i = 0; i < src.length; i += 3) {
        src[i] = 96; src[i + 1] = 108; src[i + 2] = 92; // neutral fill for voids
      }
      const tx0 = Math.floor(ix0 / 256);
      const tx1 = Math.floor((ix0 + srcW - 1) / 256);
      const ty0 = Math.floor(iy0 / 256);
      const ty1 = Math.floor((iy0 + srcH - 1) / 256);
      for (let ty = ty0; ty <= ty1; ty++) {
        for (let tx = tx0; tx <= tx1; tx++) {
          const raw = await rawForSlot(tx, ty);
          if (!raw) continue;
          blit(src, srcW, srcH, raw, tx * 256 - ix0, ty * 256 - iy0);
        }
      }

      // Resample mercator → linear-lat frame. Width maps affinely (lon is
      // linear in x); each output row maps to one nonlinear mercator row.
      const outW = Math.min(CHUNK_PX, Math.round((x1 - x0) / mpp));
      const outH = Math.min(CHUNK_PX, Math.round((z1 - z0) / mpp));
      const out = Buffer.alloc(outW * outH * 3);
      const xSrc = new Float64Array(outW);
      for (let xo = 0; xo < outW; xo++) {
        const lon = frame.toLatLon(x0 + ((xo + 0.5) / outW) * (x1 - x0), 0).lon;
        xSrc[xo] = lonToPxX(lon, coreZoom) - ix0 - 0.5;
      }
      for (let yo = 0; yo < outH; yo++) {
        const lat = frame.toLatLon(0, z0 + ((yo + 0.5) / outH) * (z1 - z0)).lat;
        const ySrc = latToPxY(lat, coreZoom) - iy0 - 0.5;
        const yA = Math.max(0, Math.min(srcH - 1, Math.floor(ySrc)));
        const yB = Math.min(srcH - 1, yA + 1);
        const tY = Math.max(0, Math.min(1, ySrc - yA));
        let di = yo * outW * 3;
        for (let xo = 0; xo < outW; xo++, di += 3) {
          const xs = xSrc[xo];
          const xA = Math.max(0, Math.min(srcW - 1, Math.floor(xs)));
          const xB = Math.min(srcW - 1, xA + 1);
          const tX = Math.max(0, Math.min(1, xs - xA));
          for (let ch = 0; ch < 3; ch++) {
            const a = src[(yA * srcW + xA) * 3 + ch] * (1 - tX) + src[(yA * srcW + xB) * 3 + ch] * tX;
            const b = src[(yB * srcW + xA) * 3 + ch] * (1 - tX) + src[(yB * srcW + xB) * 3 + ch] * tX;
            out[di + ch] = a * (1 - tY) + b * tY;
          }
        }
      }

      const file = `imagery/chunk_${cr}_${cc}.jpg`;
      await sharp(out, { raw: { width: outW, height: outH, channels: 3 } })
        .jpeg({ quality: 82, mozjpeg: true })
        .toFile(path.join(worldDir, file));

      chunks.push({
        row: cr,
        col: cc,
        x: round1(x0),
        z: round1(z0),
        width: round1(x1 - x0),
        height: round1(z1 - z0),
        px: outW,
        py: outH,
        file,
      });
      onProgress?.(chunks.length, chunkRows * chunkCols, `stitched chunk ${chunks.length}/${chunkRows * chunkCols}`);
    }
  }

  return {
    dir: "imagery",
    chunkCols,
    chunkRows,
    chunkPx: CHUNK_PX,
    coreZoom,
    edgeZoom,
    files: "imagery/chunk_{row}_{col}.jpg",
    chunks,
  };
}

function blit(dst, dW, dH, tile, ox, oy) {
  const x0 = Math.max(0, ox);
  const y0 = Math.max(0, oy);
  const x1 = Math.min(dW, ox + 256);
  const y1 = Math.min(dH, oy + 256);
  for (let y = y0; y < y1; y++) {
    const srcStart = ((y - oy) * 256 + (x0 - ox)) * 3;
    tile.copy(dst, (y * dW + x0) * 3, srcStart, srcStart + (x1 - x0) * 3);
  }
}

const round1 = (v) => Math.round(v * 10) / 10;

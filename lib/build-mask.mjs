// build-mask.mjs — stage 5: classify tree canopy from the stitched imagery
// and write forest.png (single channel, 0–255 = tree density).
//
// Heuristic per DESIGN.md §5.5, applied at 2× the mask resolution then pooled:
//   canopy ≈ green-dominant AND moderately dark AND locally textured
//            AND on ground that isn't a cliff face.
// All four thresholds below are tune-by-eye numbers; bias toward fewer false
// positives (a missing tree is invisible, a tree in a meadow is not).

import path from "node:path";
import sharp from "sharp";

const GREEN_OVER_RED = 1.02;  // g must exceed r by 2%
const GREEN_OVER_BLUE = 1.10; // and b by 10% (kills gray rock & water)
const MAX_LUMA = 150;         // canopy is dark; meadows/sand are bright
const MIN_TEXTURE_STD = 5.0;  // 3x3 luminance stddev; flat green = meadow
const MAX_SLOPE_DEG = 40;     // no trees on cliffs

export async function buildForestMask({ frame, hm, imagery, worldDir, onProgress }) {
  const cols = Math.ceil(hm.cols / 2);
  const rows = Math.ceil(hm.rows / 2);
  const SS = 2; // classify at 2x2 subsamples per mask cell
  const W = cols * SS;
  const H = rows * SS;

  // Paste every chunk (downsampled) into one global RGB raster.
  const rgb = Buffer.alloc(W * H * 3);
  for (const chunk of imagery.chunks) {
    const px = Math.max(1, Math.round((chunk.width / frame.widthM) * W));
    const py = Math.max(1, Math.round((chunk.height / frame.heightM) * H));
    const raw = await sharp(path.join(worldDir, chunk.file))
      .resize(px, py, { fit: "fill" })
      .removeAlpha()
      .raw()
      .toBuffer();
    const ox = Math.round((chunk.x / frame.widthM) * W);
    const oy = Math.round((chunk.z / frame.heightM) * H);
    for (let y = 0; y < py && oy + y < H; y++) {
      const len = Math.min(px, W - ox) * 3;
      raw.copy(rgb, ((oy + y) * W + ox) * 3, y * px * 3, y * px * 3 + len);
    }
  }

  const luma = new Float32Array(W * H);
  for (let i = 0, p = 0; i < luma.length; i++, p += 3) {
    luma[i] = 0.299 * rgb[p] + 0.587 * rgb[p + 1] + 0.114 * rgb[p + 2];
  }

  const spacing = (frame.widthM / (hm.cols - 1) + frame.heightM / (hm.rows - 1)) / 2;
  const mask = Buffer.alloc(cols * rows);

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      // Slope gate from the heightmap (mask cell ≈ 2x2 heightmap cells).
      const hc = Math.min(hm.cols - 2, c * 2);
      const hr = Math.min(hm.rows - 2, r * 2);
      const dzdx = (hm.heights[hr * hm.cols + hc + 1] - hm.heights[hr * hm.cols + hc]) / spacing;
      const dzdy = (hm.heights[(hr + 1) * hm.cols + hc] - hm.heights[hr * hm.cols + hc]) / spacing;
      const slopeDeg = (Math.atan(Math.hypot(dzdx, dzdy)) * 180) / Math.PI;
      if (slopeDeg > MAX_SLOPE_DEG) continue;

      let hits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = Math.min(W - 1, c * SS + sx);
          const y = Math.min(H - 1, r * SS + sy);
          const p = (y * W + x) * 3;
          const R = rgb[p], G = rgb[p + 1], B = rgb[p + 2];
          if (!(G > R * GREEN_OVER_RED && G > B * GREEN_OVER_BLUE)) continue;
          if (luma[y * W + x] > MAX_LUMA) continue;
          if (localStd(luma, W, H, x, y) < MIN_TEXTURE_STD) continue;
          hits++;
        }
      }
      mask[r * cols + c] = Math.round((hits / (SS * SS)) * 255);
    }
    if (r % 64 === 0) onProgress?.(r, rows, `forest mask row ${r}/${rows}`);
  }

  // One 3x3 box blur so density falls off softly at forest edges.
  const blurred = Buffer.alloc(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let sum = 0, n = 0;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const rr = r + dr, cc = c + dc;
          if (rr < 0 || rr >= rows || cc < 0 || cc >= cols) continue;
          sum += mask[rr * cols + cc];
          n++;
        }
      }
      blurred[r * cols + c] = Math.round(sum / n);
    }
  }

  await sharp(blurred, { raw: { width: cols, height: rows, channels: 1 } })
    .png()
    .toFile(path.join(worldDir, "forest.png"));
  onProgress?.(rows, rows, "forest.png written");

  return { file: "forest.png", cols, rows };
}

function localStd(luma, W, H, x, y) {
  let sum = 0, sum2 = 0, n = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || xx >= W || yy < 0 || yy >= H) continue;
      const v = luma[yy * W + xx];
      sum += v;
      sum2 += v * v;
      n++;
    }
  }
  const mean = sum / n;
  return Math.sqrt(Math.max(0, sum2 / n - mean * mean));
}

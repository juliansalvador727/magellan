// bake.mjs — the orchestrator: GPX text in, baked world on disk out.
// Runs DESIGN.md §5 stages 1→9, emitting {stage, done, total, message}
// progress events. Also the CLI:  node lib/bake.mjs trail.gpx [--force]

import { mkdir, readFile, access } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { parseGpx, planBake } from "./gpx-bounds.mjs";
import { makeFrame } from "./frame.mjs";
import { fetchElevation } from "./fetch-elevation.mjs";
import { buildHeightmap, makeHeightSampler } from "./build-heightmap.mjs";
import { buildImagery } from "./build-imagery.mjs";
import { buildForestMask } from "./build-mask.mjs";
import { fetchOsm } from "./fetch-osm.mjs";
import { buildTrail } from "./build-trail.mjs";
import { writeManifest } from "./write-manifest.mjs";

/**
 * @param {string} gpxText
 * @param {object} [opts]
 * @param {string} [opts.rootDir]  project root (holds cache/ and worlds/)
 * @param {number} [opts.marginMeters]
 * @param {boolean} [opts.force]   rebake even if the world exists
 * @param {(e:{stage:string,done:number,total:number,message:string})=>void} [opts.onProgress]
 * @returns {Promise<{worldId:string, cached:boolean, manifest:object}>}
 */
export async function bake(gpxText, opts = {}) {
  const rootDir = opts.rootDir ?? process.cwd();
  const emit = (stage, done, total, message) =>
    opts.onProgress?.({ stage, done, total, message });

  // 1. parse + plan
  emit("parse", 0, 1, "parsing GPX");
  const gpx = parseGpx(gpxText);
  const plan = planBake(gpx.points, { marginMeters: opts.marginMeters });
  const frame = makeFrame(plan.bbox);
  const worldDir = path.join(rootDir, "worlds", plan.worldId);
  const cacheRoot = path.join(rootDir, "cache");
  emit("parse", 1, 1,
    `${gpx.name ?? "trail"}: ${plan.trailLengthKm.toFixed(1)} km, ` +
    `${plan.areaKm2.toFixed(0)} km² padded box → world ${plan.worldId}`);

  if (!opts.force) {
    try {
      await access(path.join(worldDir, "manifest.json"));
      const manifest = JSON.parse(
        await readFile(path.join(worldDir, "manifest.json"), "utf8"),
      );
      emit("done", 1, 1, `world ${plan.worldId} already baked — reusing`);
      return { worldId: plan.worldId, cached: true, manifest };
    } catch {
      /* not baked yet */
    }
  }
  await mkdir(worldDir, { recursive: true });

  // 2. elevation tiles → mosaic
  const mosaic = await fetchElevation(plan, {
    cacheRoot,
    onProgress: (d, t, m) => emit("elevation", d, t, m),
  });

  // 3. heightmap
  const hm = await buildHeightmap({
    frame,
    mosaic,
    worldDir,
    onProgress: (d, t, m) => emit("heightmap", d, t, m),
  });
  const heightAt = makeHeightSampler(hm, frame);

  // 4. imagery
  const imagery = await buildImagery({
    plan,
    frame,
    worldDir,
    cacheRoot,
    onProgress: (d, t, m) => emit("imagery", d, t, m),
  });

  // 5. forest mask
  const mask = await buildForestMask({
    frame,
    hm,
    imagery,
    worldDir,
    onProgress: (d, t, m) => emit("forest", d, t, m),
  });

  // 6. OSM vectors
  const osm = await fetchOsm({
    frame,
    worldDir,
    onProgress: (d, t, m) => emit("osm", d, t, m),
  });

  // 7. trail geometry
  const trail = await buildTrail({
    gpx,
    frame,
    heightAt,
    worldDir,
    onProgress: (d, t, m) => emit("trail", d, t, m),
  });

  // 8. manifest (last — its presence marks the world complete)
  const manifest = await writeManifest({
    worldDir,
    worldId: plan.worldId,
    name: gpx.name,
    frame,
    hm,
    imagery,
    mask,
    osm,
    trail,
  });
  emit("done", 1, 1, `baked ${plan.worldId}`);

  return { worldId: plan.worldId, cached: false, manifest };
}

// ----------------------------------------------------------------------------
// CLI
// ----------------------------------------------------------------------------

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const mi = args.indexOf("--margin");
  const marginMeters = mi !== -1 ? Number(args[mi + 1]) : undefined;
  const file = args.find((a) => !a.startsWith("--") && a !== String(marginMeters));
  if (!file) {
    console.error("usage: node lib/bake.mjs <trail.gpx> [--margin meters] [--force]");
    process.exit(1);
  }

  const gpxText = await readFile(file, "utf8");
  let lastStage = "";
  const t0 = Date.now();
  try {
    const { worldId, cached } = await bake(gpxText, {
      force,
      marginMeters,
      onProgress: ({ stage, done, total, message }) => {
        if (stage !== lastStage) {
          process.stdout.write(`\n[${stage}] `);
          lastStage = stage;
        }
        process.stdout.write(`\r[${stage}] ${message ?? `${done}/${total}`}        `);
      },
    });
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`\n\n${cached ? "reused" : "baked"} world ${worldId} in ${secs}s`);
    console.log(`explore it:  npm run dev  →  http://localhost:5173/explore/${worldId}\n`);
  } catch (err) {
    console.error(`\nbake failed: ${err.message}`);
    process.exit(1);
  }
}

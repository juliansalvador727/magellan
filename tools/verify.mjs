// verify.mjs — drive the renderer headlessly, screenshot fixed viewpoints,
// and report console errors, so you can LOOK at your own output (the single
// most valuable habit from the reference project).
//
//   node tools/verify.mjs [worldId]
//   node tools/verify.mjs --graphics --gfx=high [worldId]
//
// Needs Playwright once:  npm i -D playwright && npx playwright install chromium

import { mkdir, readdir, access } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const PORT = 5198;

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  console.error(
    "playwright is not installed. Run:\n  npm i -D playwright && npx playwright install chromium",
  );
  process.exit(1);
}

const opts = parseArgs(process.argv.slice(2));

// pick a world
let worldId = opts.worldId;
if (!worldId) {
  const ids = await readdir(path.join(root, "worlds")).catch(() => []);
  for (const id of ids) {
    try {
      await access(path.join(root, "worlds", id, "manifest.json"));
      worldId = id;
      break;
    } catch { /* unfinished */ }
  }
}
if (!worldId) {
  console.error("no baked world found — run: node lib/bake.mjs <trail.gpx>");
  process.exit(1);
}

const shotRoot = opts.graphics
  ? path.join(root, "shots", "graphics", worldId, opts.gfx)
  : path.join(root, "shots");
console.log(`verifying world ${worldId}${opts.graphics ? ` (${opts.gfx} graphics)` : ""}`);
await mkdir(shotRoot, { recursive: true });

// start the server
const server = spawn(process.execPath, ["server.mjs"], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ["ignore", "pipe", "inherit"],
});
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("server didn't start")), 20_000);
  server.stdout.on("data", (d) => {
    if (String(d).includes("magellan")) {
      clearTimeout(t);
      resolve();
    }
  });
  server.on("exit", () => reject(new Error("server exited early")));
});

const errors = [];
let browser;
try {
  // software WebGL — works headless on machines with no GPU at all
  browser = await chromium.launch({
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto(`http://localhost:${PORT}/explore/${worldId}?gfx=${encodeURIComponent(opts.gfx)}`);
  await page.waitForFunction(() => window.__magellan?.ready, null, { timeout: 120_000 });
  await page.waitForTimeout(2500); // let imagery chunks stream in
  // a vite dep re-optimization can reload the page once — re-confirm
  await page.waitForFunction(() => window.__magellan?.ready, null, { timeout: 120_000 });
  await page.waitForFunction(() => window.__magellan?.graphics?.frameTimeAverageMs > 0, null, { timeout: 120_000 });

  const info = await page.evaluate(() => {
    const t = window.__magellan;
    return {
      name: t.world.manifest.name,
      trees: t.treeCount,
      spawn: t.world.manifest.spawn,
      extent: t.world.manifest.extentMeters,
      graphics: t.graphics,
    };
  });
  console.log(`  world: ${info.name} · ${info.trees} trees`);
  if (opts.graphics) {
    console.log(
      `  graphics: ${info.graphics.drawCalls} calls · ${info.graphics.triangleCountEstimate.toLocaleString()} tris · ` +
        `${info.graphics.textureMemoryEstimateMB} MB textures · ${info.graphics.frameTimeAverageMs} ms avg`,
    );
  }

  const shot = async (name) => {
    await page.waitForTimeout(700);
    // generous timeout: software WebGL (no GPU) renders frames very slowly
    const file = path.join(shotRoot, `${name}.png`);
    await page.screenshot({ path: file, timeout: 180_000 });
    console.log(`  ${path.relative(root, file)}`);
  };

  if (opts.graphics) {
    await captureGraphicsViews(page, shot, info);
  } else {
    await captureBasicViews(page, shot, info);
  }
} finally {
  await browser?.close();
  server.kill();
}

if (errors.length) {
  console.error(`\n${errors.length} console error(s):`);
  for (const e of errors.slice(0, 10)) console.error("  " + e);
  process.exit(1);
}
console.log("\nno console errors — open shots/ and look at them.");

async function captureBasicViews(page, shot, info) {
  // 1. spawn view (what the user lands in)
  await shot("spawn");

  // 2. overhead — the whole world at a glance, catches misplaced layers
  await page.evaluate(({ extent }) => {
    const t = window.__magellan;
    t.controls.jumpTo(
      extent.width / 2,
      t.world.manifest.heightmap.hMax + Math.max(extent.width, extent.height) * 0.55,
      extent.height / 2,
      0,
      -89,
    );
  }, info);
  await shot("overhead");

  // 3. mid-trail, golden hour — trail readability + terrain detail
  await page.evaluate(() => {
    const t = window.__magellan;
    const pts = t.world.trail.points;
    const p = pts[Math.floor(pts.length / 2)];
    t.controls.jumpTo(p.x, p.y + 60, p.z + 160, 0, -18);
    t.sky.setIndex(2);
  });
  await page.waitForTimeout(2500); // let the crossfade settle
  await shot("midtrail-golden");

  // 4. night
  await page.evaluate(() => window.__magellan.sky.setIndex(4));
  await page.waitForTimeout(2500);
  await shot("night");
}

async function captureGraphicsViews(page, shot, info) {
  await shot("spawn");

  await page.evaluate(({ extent }) => {
    const t = window.__magellan;
    t.controls.jumpTo(
      extent.width / 2,
      t.world.manifest.heightmap.hMax + Math.max(extent.width, extent.height) * 0.55,
      extent.height / 2,
      0,
      -89,
    );
  }, info);
  await shot("overhead");

  await page.evaluate(() => {
    const t = window.__magellan;
    const headingTo = (a, b) => (Math.atan2(b.x - a.x, -(b.z - a.z)) * 180) / Math.PI;
    const pts = t.world.trail.points;
    const p = pts[Math.floor(pts.length / 2)];
    const q = pts[Math.min(pts.length - 1, Math.floor(pts.length / 2) + 8)];
    t.sky.setIndex(2);
    t.controls.jumpTo(p.x, p.y + 55, p.z + 130, headingTo({ x: p.x, z: p.z + 130 }, q), -16);
  });
  await page.waitForTimeout(2500);
  await shot("midtrail");

  await page.evaluate(() => {
    const t = window.__magellan;
    const headingTo = (a, b) => (Math.atan2(b.x - a.x, -(b.z - a.z)) * 180) / Math.PI;
    const w = t.world;
    const pts = w.trail.points;
    const step = Math.max(1, Math.floor(pts.length / 360));
    let best = pts[0];
    let bestIdx = 0;
    let bestScore = -1;
    for (let i = 0; i < pts.length; i += step) {
      const p = pts[i];
      const c = Math.max(0, Math.min(w.forest.cols - 1, Math.floor((p.x / w.manifest.extentMeters.width) * w.forest.cols)));
      const r = Math.max(0, Math.min(w.forest.rows - 1, Math.floor((p.z / w.manifest.extentMeters.height) * w.forest.rows)));
      const score = w.forest.data[r * w.forest.cols + c] / 255;
      if (score > bestScore) {
        best = p;
        bestIdx = i;
        bestScore = score;
      }
    }
    const q = pts[Math.min(pts.length - 1, bestIdx + 10)];
    t.sky.setIndex(1);
    t.controls.jumpTo(best.x, best.y + 4.5, best.z, headingTo(best, q), -5);
  });
  await page.waitForTimeout(1200);
  await shot("forest-close");

  await page.evaluate(({ extent }) => {
    const t = window.__magellan;
    const headingTo = (a, b) => (Math.atan2(b.x - a.x, -(b.z - a.z)) * 180) / Math.PI;
    const pts = t.world.trail.points;
    let high = pts[0];
    for (const p of pts) if (p.y > high.y) high = p;
    const z = Math.min(extent.height, high.z + Math.max(260, extent.height * 0.08));
    const y = high.y + Math.max(160, Math.max(extent.width, extent.height) * 0.035);
    const from = { x: high.x, z };
    const to = { x: extent.width / 2, z: extent.height / 2 };
    t.sky.setIndex(1);
    t.controls.jumpTo(from.x, y, from.z, headingTo(from, to), -14);
  }, info);
  await page.waitForTimeout(1200);
  await shot("ridge-distance");

  await page.evaluate(({ extent }) => {
    const t = window.__magellan;
    const headingTo = (a, b) => (Math.atan2(b.x - a.x, -(b.z - a.z)) * 180) / Math.PI;
    const polys = (t.world.osm?.water ?? []).filter((p) => p.points?.length);
    let target = null;
    if (polys.length) {
      let bestScore = -1;
      for (const poly of polys) {
        let x = 0;
        let z = 0;
        let n = 0;
        for (const p of poly.points) {
          if (p[0] < 0 || p[0] > extent.width || p[1] < 0 || p[1] > extent.height) continue;
          x += p[0];
          z += p[1];
          n++;
        }
        if (n > bestScore) {
          bestScore = n;
          target = { x: x / Math.max(1, n), z: z / Math.max(1, n) };
        }
      }
    } else {
      target = t.world.trail.points.reduce((a, b) => (b.y < a.y ? b : a), t.world.trail.points[0]);
    }
    if (!target || Number.isNaN(target.x) || Number.isNaN(target.z)) {
      target = t.world.trail.points.reduce((a, b) => (b.y < a.y ? b : a), t.world.trail.points[0]);
    }
    const center = { x: extent.width / 2, z: extent.height / 2 };
    const dx = target.x - center.x;
    const dz = target.z - center.z;
    const len = Math.hypot(dx, dz) || 1;
    const x = Math.max(0, Math.min(extent.width, target.x + (dx / len) * 110));
    const z = Math.max(0, Math.min(extent.height, target.z + (dz / len) * 110));
    const y = Math.max(t.world.heightAt(x, z) + 18, t.world.heightAt(target.x, target.z) + 34);
    t.sky.setIndex(2);
    t.controls.jumpTo(x, y, z, headingTo({ x, z }, target), -16);
  }, info);
  await page.waitForTimeout(1200);
  await shot("water");
}

function parseArgs(argv) {
  const opts = { graphics: false, gfx: "medium", worldId: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--graphics") {
      opts.graphics = true;
    } else if (arg === "--gfx" || arg === "--preset") {
      opts.gfx = argv[++i] || opts.gfx;
    } else if (arg.startsWith("--gfx=")) {
      opts.gfx = arg.slice("--gfx=".length);
    } else if (arg.startsWith("--preset=")) {
      opts.gfx = arg.slice("--preset=".length);
    } else if (!arg.startsWith("-") && !opts.worldId) {
      opts.worldId = arg;
    }
  }
  opts.gfx = String(opts.gfx).toLowerCase();
  opts.gfx = ["low", "medium", "high", "ultra"].includes(opts.gfx) ? opts.gfx : "medium";
  return opts;
}

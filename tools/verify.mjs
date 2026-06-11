// verify.mjs — drive the renderer headlessly, screenshot fixed viewpoints,
// and report console errors, so you can LOOK at your own output (the single
// most valuable habit from the reference project).
//
//   node tools/verify.mjs [worldId]
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

// pick a world
let worldId = process.argv[2];
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

console.log(`verifying world ${worldId}`);
await mkdir(path.join(root, "shots"), { recursive: true });

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

  await page.goto(`http://localhost:${PORT}/explore/${worldId}`);
  await page.waitForFunction(() => window.__magellan?.ready, null, { timeout: 120_000 });
  await page.waitForTimeout(2500); // let imagery chunks stream in
  // a vite dep re-optimization can reload the page once — re-confirm
  await page.waitForFunction(() => window.__magellan?.ready, null, { timeout: 120_000 });

  const info = await page.evaluate(() => {
    const t = window.__magellan;
    return {
      name: t.world.manifest.name,
      trees: t.treeCount,
      spawn: t.world.manifest.spawn,
      extent: t.world.manifest.extentMeters,
    };
  });
  console.log(`  world: ${info.name} · ${info.trees} trees`);

  const shot = async (name) => {
    await page.waitForTimeout(700);
    // generous timeout: software WebGL (no GPU) renders frames very slowly
    await page.screenshot({ path: path.join(root, "shots", `${name}.png`), timeout: 180_000 });
    console.log(`  shots/${name}.png`);
  };

  // 1. spawn view (what the user lands in)
  await shot("spawn");

  // 2. overhead — the whole world at a glance, catches misplaced layers
  await page.evaluate(({ extent }) => {
    const t = window.__magellan;
    t.controls.jumpTo(extent.width / 2, t.world.manifest.heightmap.hMax + Math.max(extent.width, extent.height) * 0.55, extent.height / 2, 0, -89);
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

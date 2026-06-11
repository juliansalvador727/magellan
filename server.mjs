// server.mjs — the thin local glue (DESIGN.md §8):
//   GET  /              upload page
//   POST /bake          GPX text in, SSE progress out, ends with {worldId}
//   GET  /worlds/:id/*  static-serve a baked dataset
//   GET  /explore/:id   the renderer pointed at that world
//   GET  /api/worlds    list of baked worlds for the upload page
// No database — worlds/ and cache/ on disk are the entire store.

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import express from "express";
import { createServer as createViteServer } from "vite";
import { bake } from "./lib/bake.mjs";

const root = process.cwd();
const port = Number(process.env.PORT ?? 5173);

const app = express();
const vite = await createViteServer({
  root,
  // HMR port derived from the http port so two instances (dev + verify)
  // don't fight over vite's default 24678
  server: { middlewareMode: true, hmr: { port: port + 1 } },
  appType: "custom",
});

app.use("/worlds", express.static(path.join(root, "worlds"), { maxAge: "1h" }));

app.get("/api/worlds", async (_req, res) => {
  const out = [];
  let ids = [];
  try {
    ids = await readdir(path.join(root, "worlds"));
  } catch {
    /* no worlds yet */
  }
  for (const id of ids) {
    try {
      const m = JSON.parse(
        await readFile(path.join(root, "worlds", id, "manifest.json"), "utf8"),
      );
      out.push({
        worldId: m.worldId,
        name: m.name,
        createdAt: m.createdAt,
        lengthM: m.trail?.lengthM ?? null,
      });
    } catch {
      /* unfinished bake — skip */
    }
  }
  out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  res.json(out);
});

// The bake runs in-process: it's IO-bound (downloads + libvips threadpool),
// so the event loop stays responsive for a single local user.
app.post("/bake", express.text({ type: () => true, limit: "40mb" }), async (req, res) => {
  res.setHeader("content-type", "text/event-stream");
  res.setHeader("cache-control", "no-cache");
  res.flushHeaders?.();
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  try {
    if (typeof req.body !== "string" || !/<(trkpt|rtept|wpt)\b/i.test(req.body)) {
      throw new Error("That doesn't look like a GPX file (no track points found).");
    }
    const { worldId, cached } = await bake(req.body, {
      rootDir: root,
      onProgress: send,
    });
    send({ done: true, worldId, cached });
  } catch (err) {
    send({ error: err.message });
  }
  res.end();
});

const sendHtml = (file) => async (req, res, next) => {
  try {
    const html = await readFile(path.join(root, file), "utf8");
    res
      .status(200)
      .set({ "content-type": "text/html" })
      .end(await vite.transformIndexHtml(req.originalUrl, html));
  } catch (err) {
    next(err);
  }
};
app.get("/", sendHtml("index.html"));
app.get("/explore/:id", sendHtml("explore.html"));

app.use(vite.middlewares);

app.listen(port, () => {
  console.log(`\n  magellan →  http://localhost:${port}\n`);
});

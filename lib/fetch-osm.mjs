// fetch-osm.mjs — stage 6: one Overpass query for the padded bbox; writes
// osm.json with geometry already projected to local meters (x east, z south).
// Heights are NOT stored — the renderer drapes onto its own DEM, which keeps
// vectors glued to the terrain even if the heightmap resolution changes.
//
// Overpass is a free shared service: this stage degrades gracefully. On
// timeout/refusal we write an empty osm.json and the world simply has no
// water/roads/buildings layer.

import { writeFile } from "node:fs/promises";
import path from "node:path";

// Tried in order; the main instance's frontend sometimes 406es POSTs, so we
// also try GET (our queries are far below URL-length limits) and a mirror.
const OVERPASS_ENDPOINTS = [
  { url: "https://overpass-api.de/api/interpreter", method: "GET" },
  { url: "https://overpass.kumi.systems/api/interpreter", method: "POST" },
  { url: "https://overpass.kumi.systems/api/interpreter", method: "GET" },
];

const ROAD_KINDS = new Set([
  "motorway", "trunk", "primary", "secondary", "tertiary",
  "unclassified", "residential", "service", "track",
]);
const POI_KINDS = [
  ["natural", "peak"],
  ["natural", "waterfall"],
  ["tourism", "viewpoint"],
];
const CAPS = { water: 800, roads: 2000, buildings: 4000, pois: 60 };

export async function fetchOsm({ frame, worldDir, onProgress }) {
  const b = frame.bbox;
  const bbox = `${b.minLat},${b.minLon},${b.maxLat},${b.maxLon}`;
  const query = `
[out:json][timeout:90];
(
  way["natural"="water"](${bbox});
  way["waterway"="riverbank"](${bbox});
  way["highway"](${bbox});
  way["building"](${bbox});
  node["natural"="peak"](${bbox});
  node["natural"="waterfall"](${bbox});
  node["tourism"="viewpoint"](${bbox});
);
out geom 40000;`;

  const empty = { water: [], roads: [], buildings: [], pois: [] };
  onProgress?.(0, 1, "querying Overpass…");
  let json = null;
  let lastErr;
  for (const { url, method } of OVERPASS_ENDPOINTS) {
    try {
      const data = "data=" + encodeURIComponent(query);
      // overpass-api.de's frontend 406es requests with Node's default UA
      const headers = {
        "user-agent": "magellan/0.1 (local personal use)",
        accept: "application/json",
        ...(method === "POST" && { "content-type": "application/x-www-form-urlencoded" }),
      };
      const res = await fetch(method === "GET" ? `${url}?${data}` : url, {
        method,
        headers,
        ...(method === "POST" && { body: data }),
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      json = await res.json();
      break;
    } catch (err) {
      lastErr = err;
    }
  }
  if (!json) {
    console.warn(`  OSM fetch failed (${lastErr?.message}) — continuing without vectors`);
    await writeOut(worldDir, empty);
    return { file: "osm.json", ...counts(empty) };
  }

  const out = { water: [], roads: [], buildings: [], pois: [] };
  const proj = (g) => {
    const { x, z } = frame.toLocal(g.lat, g.lon);
    return [Math.round(x * 10) / 10, Math.round(z * 10) / 10];
  };

  for (const el of json.elements ?? []) {
    const tags = el.tags ?? {};
    if (el.type === "way" && Array.isArray(el.geometry)) {
      const points = el.geometry.map(proj);
      if (points.length < 2) continue;
      if (tags.natural === "water" || tags.waterway === "riverbank") {
        if (out.water.length < CAPS.water && points.length >= 3) {
          out.water.push({ name: tags.name, points });
        }
      } else if (tags.building) {
        if (out.buildings.length < CAPS.buildings && points.length >= 3) {
          const levels = parseInt(tags["building:levels"], 10);
          out.buildings.push({ points, levels: Number.isFinite(levels) ? levels : null });
        }
      } else if (ROAD_KINDS.has(tags.highway)) {
        if (out.roads.length < CAPS.roads) {
          out.roads.push({ kind: tags.highway, name: tags.name, points });
        }
      }
    } else if (el.type === "node") {
      const kind = POI_KINDS.find(([k, v]) => tags[k] === v)?.[1];
      if (!kind || !tags.name) continue;
      const [x, z] = proj(el);
      out.pois.push({ kind, name: tags.name, x, z, ele: tags.ele ? parseFloat(tags.ele) : null });
    }
  }
  // Named summits/falls are the landmarks people recognize — keep those first.
  out.pois = out.pois.slice(0, CAPS.pois);

  await writeOut(worldDir, out);
  onProgress?.(1, 1, "osm.json written");
  return { file: "osm.json", ...counts(out) };
}

const counts = (o) => ({
  waterCount: o.water.length,
  roadCount: o.roads.length,
  buildingCount: o.buildings.length,
  poiCount: o.pois.length,
});

const writeOut = (worldDir, o) =>
  writeFile(path.join(worldDir, "osm.json"), JSON.stringify(o));

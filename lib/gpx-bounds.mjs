// gpx-bounds.mjs
//
// The linchpin for turning the fixed-bbox Yosemite pipeline into a
// "bake any trail" pipeline. Given a GPX file, this computes:
//   - the trail's raw lat/lon bounding box
//   - a padded box (so you can roam *around* the trail, not just on it)
//   - the slippy-map tiles that box covers at a given zoom
//   - an optional corridor filter, so a long point-to-point hike only
//     fetches tiles near the trail instead of the full rectangle
//   - a local metric frame origin (matching the repo's meters convention)
//   - a stable worldId (so identical trails reuse a baked dataset)
//   - an area sanity cap (so a country-spanning GPX doesn't try to
//     download 40,000 tiles onto your laptop)
//
// Zero dependencies, no network. Wire the exported helpers into a
// parameterized fetch-terrain.mjs, or just run it as a CLI to inspect
// a trail before baking:  node gpx-bounds.mjs path/to/trail.gpx
//
// Coordinate conventions match the original repo: a local metric frame,
// meters, +X east / +Z south / +Y elevation ASL, web-mercator longitude
// distortion corrected by cos(latitude).

import { readFileSync } from "node:fs";

const EARTH_RADIUS_M = 6_371_000;
const M_PER_DEG_LAT = 111_320; // good enough at trail scales

// ----------------------------------------------------------------------------
// GPX parsing
// ----------------------------------------------------------------------------
// Tolerant, dependency-free extraction of every lat/lon point from a GPX
// file. GPX stores coords as attributes on <trkpt>, <rtept>, and <wpt>
// elements (lat/lon are attributes; <ele> is a child). For a personal tool
// this regex pass is plenty; if you hit a weird file, swap in fast-xml-parser.

/**
 * @param {string} gpxText
 * @returns {{lat:number, lon:number, ele:number|null}[]}
 */
export function parseGpxPoints(gpxText) {
  const points = [];
  // Match trkpt | rtept | wpt opening tags, capturing the element body so we
  // can dig out an optional <ele>. Handles attribute order (lat-then-lon or
  // lon-then-lat) and self-closing tags.
  const tagRe = /<(trkpt|rtept|wpt)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/gi;
  let m;
  while ((m = tagRe.exec(gpxText)) !== null) {
    const attrs = m[2];
    const body = m[3] || "";
    const lat = attrNum(attrs, "lat");
    const lon = attrNum(attrs, "lon");
    if (lat === null || lon === null) continue;
    const eleMatch = body.match(/<ele>\s*(-?\d+(?:\.\d+)?)\s*<\/ele>/i);
    points.push({
      lat,
      lon,
      ele: eleMatch ? parseFloat(eleMatch[1]) : null,
    });
  }
  return points;
}

function attrNum(attrs, name) {
  const m = attrs.match(
    new RegExp(`\\b${name}\\s*=\\s*["']\\s*(-?\\d+(?:\\.\\d+)?)`, "i"),
  );
  return m ? parseFloat(m[1]) : null;
}

// ----------------------------------------------------------------------------
// Geometry helpers
// ----------------------------------------------------------------------------

/** Haversine distance in meters between two lat/lon points. */
export function haversineMeters(aLat, aLon, bLat, bLon) {
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

/**
 * Shortest distance (meters) from a point to a polyline, using a local
 * equirectangular projection centered on the point. Accurate to well under
 * a percent at trail/tile scales, and fast.
 * @param {number} pLat @param {number} pLon
 * @param {{lat:number,lon:number}[]} line
 */
export function distanceToPolylineMeters(pLat, pLon, line) {
  if (line.length === 0) return Infinity;
  if (line.length === 1)
    return haversineMeters(pLat, pLon, line[0].lat, line[0].lon);
  const cosLat = Math.cos(toRad(pLat));
  // project to local meters (x east, y north), origin at the test point
  const px = 0,
    py = 0;
  let best = Infinity;
  for (let i = 0; i < line.length - 1; i++) {
    const a = project(line[i], pLat, pLon, cosLat);
    const b = project(line[i + 1], pLat, pLon, cosLat);
    best = Math.min(best, pointToSegment(px, py, a.x, a.y, b.x, b.y));
  }
  return best;
}

function project(pt, refLat, refLon, cosLat) {
  return {
    x: (pt.lon - refLon) * (Math.PI / 180) * EARTH_RADIUS_M * cosLat,
    y: (pt.lat - refLat) * (Math.PI / 180) * EARTH_RADIUS_M,
  };
}

function pointToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax,
    dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx,
    cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

// ----------------------------------------------------------------------------
// Slippy-map tile math (Web Mercator, OSM/Esri/Terrarium tiling scheme)
// ----------------------------------------------------------------------------

export const lon2tileX = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z);

export const lat2tileY = (lat, z) =>
  Math.floor(
    ((1 - Math.log(Math.tan(toRad(lat)) + 1 / Math.cos(toRad(lat))) / Math.PI) /
      2) *
      2 ** z,
  );

export const tileX2lon = (x, z) => (x / 2 ** z) * 360 - 180;

export const tileY2lat = (y, z) => {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
  return toDeg(Math.atan(Math.sinh(n)));
};

/** Center lat/lon of a tile. */
function tileCenter(x, y, z) {
  return {
    lat: (tileY2lat(y, z) + tileY2lat(y + 1, z)) / 2,
    lon: (tileX2lon(x, z) + tileX2lon(x + 1, z)) / 2,
  };
}

/** Approx tile edge length in meters (for the corridor margin). */
function tileSpanMeters(lat, z) {
  const worldM = 2 * Math.PI * EARTH_RADIUS_M * Math.cos(toRad(lat));
  return worldM / 2 ** z;
}

// ----------------------------------------------------------------------------
// The main entry point
// ----------------------------------------------------------------------------

/**
 * @typedef {Object} BakePlan
 * @property {{minLat,minLon,maxLat,maxLon}} rawBbox       trail extent
 * @property {{minLat,minLon,maxLat,maxLon}} bbox          padded extent to bake
 * @property {number} areaKm2
 * @property {{lat:number, lon:number}} origin             local-frame origin (trailhead)
 * @property {{lat:number, lon:number}} centroid
 * @property {{lat:number, lon:number}} trailhead
 * @property {{lat:number, lon:number}} trailend
 * @property {string} worldId                              stable id for caching/foldering
 * @property {number} pointCount
 * @property {number} trailLengthKm
 * @property {(z:number)=>{x:number,y:number}[]} tilesForZoom  full padded box
 * @property {(z:number,corridorM:number)=>{x:number,y:number}[]} corridorTilesForZoom
 */

/**
 * @param {{lat:number,lon:number,ele?:number|null}[]} points
 * @param {Object} [opts]
 * @param {number} [opts.marginMeters=1500]   how far to bake around the trail
 * @param {number} [opts.maxAreaKm2=2500]     refuse boxes bigger than ~50x50 km
 */
export function planBake(points, opts = {}) {
  const marginMeters = opts.marginMeters ?? 1500;
  const maxAreaKm2 = opts.maxAreaKm2 ?? 2500;

  if (points.length < 2) {
    throw new Error(
      `GPX has ${points.length} point(s); need at least 2. Is this a valid track?`,
    );
  }

  let minLat = Infinity,
    minLon = Infinity,
    maxLat = -Infinity,
    maxLon = -Infinity;
  for (const p of points) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
  }
  const rawBbox = { minLat, minLon, maxLat, maxLon };

  const midLat = (minLat + maxLat) / 2;
  const cosLat = Math.cos(toRad(midLat));
  const dLat = marginMeters / M_PER_DEG_LAT;
  const dLon = marginMeters / (M_PER_DEG_LAT * cosLat);
  const bbox = {
    minLat: minLat - dLat,
    minLon: minLon - dLon,
    maxLat: maxLat + dLat,
    maxLon: maxLon + dLon,
  };

  const widthM = (bbox.maxLon - bbox.minLon) * M_PER_DEG_LAT * cosLat;
  const heightM = (bbox.maxLat - bbox.minLat) * M_PER_DEG_LAT;
  const areaKm2 = (widthM * heightM) / 1e6;

  if (areaKm2 > maxAreaKm2) {
    throw new Error(
      `Padded area is ${areaKm2.toFixed(0)} km² (cap ${maxAreaKm2} km²). ` +
        `This trail is too large to bake locally as one world. Split it, ` +
        `lower marginMeters, or raise maxAreaKm2 if you really mean it.`,
    );
  }

  // trail length
  let trailLengthM = 0;
  for (let i = 0; i < points.length - 1; i++) {
    trailLengthM += haversineMeters(
      points[i].lat,
      points[i].lon,
      points[i + 1].lat,
      points[i + 1].lon,
    );
  }

  const trailhead = { lat: points[0].lat, lon: points[0].lon };
  const trailend = {
    lat: points[points.length - 1].lat,
    lon: points[points.length - 1].lon,
  };
  const centroid = { lat: midLat, lon: (minLon + maxLon) / 2 };

  const worldId = makeWorldId(rawBbox);

  const tilesForZoom = (z) => enumerateTiles(bbox, z);
  const corridorTilesForZoom = (z, corridorM = marginMeters) =>
    enumerateTiles(bbox, z).filter((t) => {
      const c = tileCenter(t.x, t.y, z);
      // pad the corridor test by the tile's own size so edge tiles aren't dropped
      const slack = tileSpanMeters(c.lat, z) * 0.75;
      return (
        distanceToPolylineMeters(c.lat, c.lon, points) <= corridorM + slack
      );
    });

  return {
    rawBbox,
    bbox,
    areaKm2,
    origin: trailhead, // local metric frame origin = where you spawn
    centroid,
    trailhead,
    trailend,
    worldId,
    pointCount: points.length,
    trailLengthKm: trailLengthM / 1000,
    tilesForZoom,
    corridorTilesForZoom,
  };
}

function enumerateTiles(bbox, z) {
  const x0 = lon2tileX(bbox.minLon, z);
  const x1 = lon2tileX(bbox.maxLon, z);
  const y0 = lat2tileY(bbox.maxLat, z); // note: y grows southward
  const y1 = lat2tileY(bbox.minLat, z);
  const tiles = [];
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      tiles.push({ x, y, z });
    }
  }
  return tiles;
}

/** Stable short id from the rounded raw bbox — same trail → same dataset folder. */
function makeWorldId(b) {
  const key = [b.minLat, b.minLon, b.maxLat, b.maxLon]
    .map((v) => v.toFixed(4))
    .join(",");
  // tiny non-crypto hash (FNV-1a) → base36
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return "w" + (h >>> 0).toString(36);
}

/** Convenience: parse a file path straight into a bake plan. */
export function planBakeFromFile(path, opts) {
  const text = readFileSync(path, "utf8");
  const points = parseGpxPoints(text);
  return planBake(points, opts);
}

// ----------------------------------------------------------------------------
// CLI:  node gpx-bounds.mjs trail.gpx [marginMeters]
// ----------------------------------------------------------------------------

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: node gpx-bounds.mjs <trail.gpx> [marginMeters]");
    process.exit(1);
  }
  const marginMeters = process.argv[3] ? Number(process.argv[3]) : undefined;
  try {
    const plan = planBakeFromFile(file, { marginMeters });
    const elevZoom = 14; // repo uses z14 for elevation (~7.6 m/sample)
    const imgZoom = 16; // repo uses z16 imagery over the core
    const fullElev = plan.tilesForZoom(elevZoom).length;
    const corrElev = plan.corridorTilesForZoom(elevZoom).length;
    const fullImg = plan.tilesForZoom(imgZoom).length;
    const corrImg = plan.corridorTilesForZoom(imgZoom).length;

    console.log(`\n  trail points     ${plan.pointCount}`);
    console.log(`  trail length     ${plan.trailLengthKm.toFixed(1)} km`);
    console.log(`  worldId          ${plan.worldId}`);
    console.log(
      `  trailhead        ${plan.trailhead.lat.toFixed(5)}, ${plan.trailhead.lon.toFixed(5)}`,
    );
    console.log(`  padded area      ${plan.areaKm2.toFixed(1)} km²`);
    console.log(`\n  tiles to fetch (full box vs corridor):`);
    console.log(
      `    elevation z${elevZoom}   ${fullElev}  →  ${corrElev}  (${pct(corrElev, fullElev)} saved)`,
    );
    console.log(
      `    imagery   z${imgZoom}   ${fullImg}  →  ${corrImg}  (${pct(corrImg, fullImg)} saved)`,
    );
    console.log(
      `\n  bbox  S${plan.bbox.minLat.toFixed(5)} W${plan.bbox.minLon.toFixed(5)} ` +
        `N${plan.bbox.maxLat.toFixed(5)} E${plan.bbox.maxLon.toFixed(5)}\n`,
    );
  } catch (err) {
    console.error("error:", err.message);
    process.exit(1);
  }
}

function pct(part, whole) {
  if (!whole) return "0%";
  return `${Math.round((1 - part / whole) * 100)}%`;
}

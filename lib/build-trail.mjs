// build-trail.mjs — stage 7: resample the GPX polyline, convert to local
// meters, snap y onto the baked DEM (so the ribbon sits on the ground the
// renderer actually draws, not on the GPX's own — often noisy — elevations),
// and write trail.json with cumulative distances and named waypoints.

import { writeFile } from "node:fs/promises";
import path from "node:path";

const STEP_M = 10; // resample spacing along the trail

export async function buildTrail({ gpx, frame, heightAt, worldDir, onProgress }) {
  const local = gpx.points.map((p) => frame.toLocal(p.lat, p.lon));

  const pts = [];
  let dist = 0;
  let carry = 0;
  push(pts, local[0], 0, heightAt);
  for (let i = 1; i < local.length; i++) {
    const a = local[i - 1];
    const b = local[i];
    const segLen = Math.hypot(b.x - a.x, b.z - a.z);
    if (segLen === 0) continue;
    let along = STEP_M - carry;
    while (along < segLen) {
      const t = along / segLen;
      push(pts, { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t }, dist + along, heightAt);
      along += STEP_M;
    }
    carry = segLen - (along - STEP_M);
    dist += segLen;
  }
  push(pts, local[local.length - 1], dist, heightAt);

  const waypoints = gpx.waypoints.map((w) => {
    const { x, z } = frame.toLocal(w.lat, w.lon);
    return { name: w.name, x: r1(x), y: r1(heightAt(x, z)), z: r1(z) };
  });

  const trail = { lengthM: Math.round(dist), points: pts, waypoints };
  await writeFile(path.join(worldDir, "trail.json"), JSON.stringify(trail));
  onProgress?.(1, 1, `trail.json written (${pts.length} points)`);

  // Spawn: at the trailhead, eyes ~2 m up, facing along the first ~30 m.
  const head = pts[0];
  const ahead = pts[Math.min(3, pts.length - 1)];
  const headingDeg =
    (Math.atan2(ahead.x - head.x, -(ahead.z - head.z)) * 180) / Math.PI; // 0 = north, 90 = east
  const spawn = {
    x: r1(head.x),
    y: r1(head.y + 2),
    z: r1(head.z),
    headingDeg: Math.round(headingDeg),
  };

  return { file: "trail.json", lengthM: trail.lengthM, pointCount: pts.length, spawn };
}

function push(pts, p, dist, heightAt) {
  pts.push({ x: r1(p.x), y: r1(heightAt(p.x, p.z)), z: r1(p.z), distM: Math.round(dist) });
}

const r1 = (v) => Math.round(v * 10) / 10;

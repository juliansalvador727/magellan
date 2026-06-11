// human.js — the OSM human layer: roads draped over the DEM as ribbons,
// building footprints extruded to simple blocks. Everything merges into
// three draw calls (asphalt, dirt, buildings).

import * as THREE from "three";

const ROAD_WIDTHS = {
  motorway: 9, trunk: 8, primary: 7.5, secondary: 6.5, tertiary: 6,
  unclassified: 5, residential: 5, service: 3.5, track: 2.5,
};
const ROAD_LIFT = 0.25;
const SEG_MAX_M = 15; // subdivide long OSM segments so roads follow the DEM

export function createHuman(world, scene) {
  const group = new THREE.Group();
  buildRoads(world, group);
  buildBuildings(world, group);
  scene.add(group);
  return { group };
}

function buildRoads(world, group) {
  const bySurface = { asphalt: { positions: [], indices: [] }, dirt: { positions: [], indices: [] } };
  for (const road of world.osm?.roads ?? []) {
    const width = ROAD_WIDTHS[road.kind] ?? 4;
    const sink = road.kind === "track" || road.kind === "service" ? "dirt" : "asphalt";
    const pts = densify(road.points);
    appendRibbon(bySurface[sink], pts, width, world);
  }
  const mats = {
    asphalt: new THREE.MeshLambertMaterial({ color: 0x46464c, polygonOffset: true, polygonOffsetFactor: -1 }),
    dirt: new THREE.MeshLambertMaterial({ color: 0x77624a, polygonOffset: true, polygonOffsetFactor: -1 }),
  };
  for (const key of Object.keys(bySurface)) {
    const { positions, indices } = bySurface[key];
    if (!indices.length) continue;
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geom.setIndex(indices);
    geom.computeVertexNormals();
    group.add(new THREE.Mesh(geom, mats[key]));
  }
}

function appendRibbon(sink, pts, width, world) {
  if (pts.length < 2) return;
  const base = sink.positions.length / 3;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const [x, z] = pts[i];
    const [ax, az] = pts[Math.max(0, i - 1)];
    const [bx, bz] = pts[Math.min(n - 1, i + 1)];
    let dx = bx - ax;
    let dz = bz - az;
    const len = Math.hypot(dx, dz) || 1;
    dx /= len;
    dz /= len;
    const px = -dz * (width / 2);
    const pz = dx * (width / 2);
    sink.positions.push(
      x + px, world.heightAt(x + px, z + pz) + ROAD_LIFT, z + pz,
      x - px, world.heightAt(x - px, z - pz) + ROAD_LIFT, z - pz,
    );
  }
  for (let i = 0; i < n - 1; i++) {
    const a = base + i * 2;
    sink.indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
}

function densify(points) {
  const out = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const [ax, az] = points[i - 1];
    const [bx, bz] = points[i];
    const len = Math.hypot(bx - ax, bz - az);
    const steps = Math.ceil(len / SEG_MAX_M);
    for (let s = 1; s <= steps; s++) {
      out.push([ax + ((bx - ax) * s) / steps, az + ((bz - az) * s) / steps]);
    }
  }
  return out;
}

function buildBuildings(world, group) {
  const positions = [];
  const indices = [];
  let base = 0;
  for (const b of world.osm?.buildings ?? []) {
    const pts = dedupeClosing(b.points);
    if (pts.length < 3) continue;
    const contour = pts.map(([x, z]) => new THREE.Vector2(x, z));
    let tris;
    try {
      tris = THREE.ShapeUtils.triangulateShape(contour, []);
    } catch {
      continue;
    }
    const floor = Math.min(...pts.map(([x, z]) => world.heightAt(x, z))) - 0.5;
    const top = floor + 1.5 + (b.levels ?? 1) * 3.2;
    // roof
    for (const [x, z] of pts) positions.push(x, top, z);
    for (const [a, bb, c] of tris) indices.push(base + a, base + c, base + bb);
    base += pts.length;
    // walls
    for (let i = 0; i < pts.length; i++) {
      const [x0, z0] = pts[i];
      const [x1, z1] = pts[(i + 1) % pts.length];
      positions.push(x0, floor, z0, x1, floor, z1, x1, top, z1, x0, top, z0);
      indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
      base += 4;
    }
  }
  if (!indices.length) return;
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geom.setIndex(indices);
  geom.computeVertexNormals();
  group.add(
    new THREE.Mesh(geom, new THREE.MeshLambertMaterial({ color: 0xa89a86, side: THREE.DoubleSide })),
  );
}

function dedupeClosing(points) {
  if (points.length > 1) {
    const [x0, z0] = points[0];
    const [x1, z1] = points[points.length - 1];
    if (Math.abs(x0 - x1) < 0.01 && Math.abs(z0 - z1) < 0.01) return points.slice(0, -1);
  }
  return points;
}

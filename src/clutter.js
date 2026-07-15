// clutter.js — small foreground details near the trail. Everything is
// deterministic and derived from the baked trail/terrain data.

import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

const PRESET_LIMITS = {
  low: { grass: 0, ferns: 0, rocks: 0, logs: 0 },
  medium: { grass: 16000, ferns: 5000, rocks: 1500, logs: 400 },
  high: { grass: 30000, ferns: 10000, rocks: 2800, logs: 750 },
  ultra: { grass: 52000, ferns: 17000, rocks: 4800, logs: 1200 },
};

export function createClutter(world, scene, graphicsPreset = {}) {
  const limits = PRESET_LIMITS[graphicsPreset.id] ?? PRESET_LIMITS.medium;
  const totalLimit = limits.grass + limits.ferns + limits.rocks + limits.logs;
  if (!totalLimit || graphicsPreset.clutter === false) {
    return { count: 0, meshes: [], triangleEstimate: 0, setTint() {} };
  }

  const rand = mulberry32(hashString(world.id || world.manifest.worldId || "magellan"));
  const groups = { grass: [], ferns: [], rocks: [], logs: [] };
  const pts = world.trail.points;
  const step = Math.max(1, Math.floor(pts.length / Math.max(1600, totalLimit / 3)));
  const slopeStep = 4;

  // several sweeps along the trail: one pass of a few tries per point can't
  // reach the budget, and restarting with the same PRNG stream keeps it
  // deterministic while filling in new spots each sweep
  for (let sweep = 0; sweep < 10 && !allFull(); sweep++)
  for (let i = 0; i < pts.length; i += step) {
    const p = pts[i];
    const q = pts[Math.min(pts.length - 1, i + 1)];
    const dx = q.x - p.x;
    const dz = q.z - p.z;
    const len = Math.hypot(dx, dz) || 1;
    const nx = -dz / len;
    const nz = dx / len;

    const tries = 3 + Math.floor(rand() * 4);
    for (let k = 0; k < tries; k++) {
      const side = rand() < 0.5 ? -1 : 1;
      const along = (rand() - 0.5) * 3.5;
      const dist = 1.6 + Math.pow(rand(), 1.65) * 64;
      const x = p.x + (dx / len) * along + nx * dist * side;
      const z = p.z + (dz / len) * along + nz * dist * side;
      if (!inside(world, x, z)) continue;

      const y = world.heightAt(x, z);
      const slope = slopeAt(world, x, z, slopeStep);
      if (slope > 0.95) continue;

      const forestDensity = forestDensityAt(world, x, z);
      const edge = 1 - smoothstep(0.35, 0.86, forestDensity);
      const trailNear = 1 - smoothstep(12, 58, dist);
      const wet = waterNear(world, x, z);
      const pick = rand();

      if (groups.grass.length < limits.grass && pick < 0.50 + edge * 0.22) {
        groups.grass.push({
          x,
          y,
          z,
          s: 0.5 + rand() * 0.75 + trailNear * 0.12,
          rot: rand() * Math.PI * 2,
          tint: 0.82 + rand() * 0.24 + wet * 0.08,
        });
      } else if (groups.ferns.length < limits.ferns && pick < 0.80 && forestDensity > 0.18) {
        groups.ferns.push({
          x,
          y,
          z,
          s: 0.45 + rand() * 0.75 + wet * 0.18,
          rot: rand() * Math.PI * 2,
          tint: 0.82 + rand() * 0.24,
        });
      } else if (groups.rocks.length < limits.rocks && slope > 0.18) {
        groups.rocks.push({
          x,
          y,
          z,
          sx: 0.55 + rand() * 1.25,
          sy: 0.25 + rand() * 0.55,
          sz: 0.45 + rand() * 1.05,
          rot: rand() * Math.PI * 2,
          tint: 0.82 + rand() * 0.22,
        });
      } else if (groups.logs.length < limits.logs && forestDensity > 0.32 && dist > 7 && slope < 0.3) {
        groups.logs.push({
          x,
          y,
          z,
          len: 2.4 + rand() * 5.2,
          r: 0.12 + rand() * 0.18,
          rot: rand() * Math.PI * 2,
          tint: 0.78 + rand() * 0.25,
        });
      }
    }
    if (allFull()) break;
  }

  function allFull() {
    return (
      groups.grass.length >= limits.grass &&
      groups.ferns.length >= limits.ferns &&
      groups.rocks.length >= limits.rocks &&
      groups.logs.length >= limits.logs
    );
  }

  const group = new THREE.Group();
  group.name = "trail-clutter";
  const meshes = [];
  let triangleEstimate = 0;
  addMesh(meshForPlants(grassGeometry(), groups.grass, "grass"));
  addMesh(meshForPlants(fernGeometry(), groups.ferns, "fern"));
  addMesh(meshForRocks(groups.rocks));
  addMesh(meshForLogs(groups.logs));
  scene.add(group);

  return {
    count: groups.grass.length + groups.ferns.length + groups.rocks.length + groups.logs.length,
    meshes,
    triangleEstimate,
    // the unlit plant materials follow the time-of-day tint like the forest;
    // rocks/logs are Lambert-lit and follow the sun instead
    setTint(color) {
      for (const mesh of meshes) {
        if (mesh.material.isMeshBasicMaterial) mesh.material.color.copy(color);
      }
    },
  };

  function addMesh(mesh) {
    if (!mesh) return;
    group.add(mesh);
    meshes.push(mesh);
    triangleEstimate += geometryTriangles(mesh.geometry) * mesh.count;
  }
}

function meshForPlants(geometry, items, name) {
  if (!items.length) return null;
  // painted alpha-cutout cards, unlit like the trees — solid little meshes
  // read as plastic cones at walking height
  const mat = new THREE.MeshBasicMaterial({
    map: name === "grass" ? paintGrassTexture() : paintFernTexture(),
    alphaTest: 0.35,
    side: THREE.DoubleSide,
    alphaToCoverage: true,
  });
  mat.toneMapped = false;
  const mesh = new THREE.InstancedMesh(geometry, mat, items.length);
  mesh.name = `clutter:${name}`;
  fillPlantInstances(mesh, items);
  return mesh;
}

function meshForRocks(items) {
  if (!items.length) return null;
  const geometry = new THREE.IcosahedronGeometry(1, 0);
  geometry.computeVertexNormals();
  paint(geometry, 0xa9a79c, 0.25);
  const mesh = new THREE.InstancedMesh(
    geometry,
    new THREE.MeshLambertMaterial({ color: 0xffffff, vertexColors: true }),
    items.length,
  );
  mesh.name = "clutter:rocks";
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const pos = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const col = new THREE.Color();
  for (let i = 0; i < items.length; i++) {
    const t = items[i];
    q.setFromAxisAngle(up, t.rot);
    pos.set(t.x, t.y + t.sy * 0.25, t.z);
    scale.set(t.sx, t.sy, t.sz);
    m.compose(pos, q, scale);
    mesh.setMatrixAt(i, m);
    // vertex colors already carry the rock grey; instance color is shade only
    col.setScalar(t.tint);
    mesh.setColorAt(i, col);
  }
  mesh.instanceMatrix.needsUpdate = true;
  mesh.instanceColor.needsUpdate = true;
  return mesh;
}

function meshForLogs(items) {
  if (!items.length) return null;
  const geometry = new THREE.CylinderGeometry(1, 1, 1, 7, 1, true);
  geometry.rotateZ(Math.PI / 2);
  geometry.computeVertexNormals();
  paint(geometry, 0x765033, 0.18);
  const mesh = new THREE.InstancedMesh(
    geometry,
    new THREE.MeshLambertMaterial({ color: 0xffffff, vertexColors: true }),
    items.length,
  );
  mesh.name = "clutter:logs";
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const pos = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const col = new THREE.Color();
  for (let i = 0; i < items.length; i++) {
    const t = items[i];
    q.setFromAxisAngle(up, t.rot);
    // sink slightly so the ends don't hover on uneven ground
    pos.set(t.x, t.y + t.r * 0.35, t.z);
    scale.set(t.len, t.r, t.r);
    m.compose(pos, q, scale);
    mesh.setMatrixAt(i, m);
    col.setScalar(t.tint);
    mesh.setColorAt(i, col);
  }
  mesh.instanceMatrix.needsUpdate = true;
  mesh.instanceColor.needsUpdate = true;
  return mesh;
}

function fillPlantInstances(mesh, items) {
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const pos = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const col = new THREE.Color();
  for (let i = 0; i < items.length; i++) {
    const t = items[i];
    q.setFromAxisAngle(up, t.rot);
    pos.set(t.x, t.y + 0.04, t.z);
    scale.set(t.s, t.s, t.s);
    m.compose(pos, q, scale);
    mesh.setMatrixAt(i, m);
    col.setScalar(t.tint);
    mesh.setColorAt(i, col);
  }
  mesh.instanceMatrix.needsUpdate = true;
  mesh.instanceColor.needsUpdate = true;
}

// Crossed unit cards, bottom anchored at y=0 (instance scale sets size).
function crossedCards(height) {
  const parts = [];
  for (const rot of [0, Math.PI / 2]) {
    const g = new THREE.PlaneGeometry(1, height);
    g.translate(0, height / 2, 0);
    g.rotateY(rot);
    parts.push(g);
  }
  return mergeGeometries(parts.map((g) => (g.index ? g.toNonIndexed() : g)));
}

function grassGeometry() {
  return crossedCards(0.62);
}

function fernGeometry() {
  return crossedCards(0.7);
}

// A clump of thin arching blades, dark at the roots and sunlit at the tips.
function paintGrassTexture() {
  const S = 256;
  const canvas = document.createElement("canvas");
  canvas.width = S;
  canvas.height = Math.round(S * 0.62);
  const c = canvas.getContext("2d");
  const rand = mulberry32(0x67726173);
  const H = canvas.height;
  for (let i = 0; i < 90; i++) {
    const x0 = S * (0.5 + (rand() - 0.5) * 0.45);
    const lean = (rand() - 0.5) * S * 0.7;
    const h = H * (0.45 + rand() * 0.55);
    const light = 16 + rand() * 18;
    c.strokeStyle = `hsla(${70 + rand() * 30}, ${30 + rand() * 18}%, ${light}%, ${0.7 + rand() * 0.3})`;
    c.lineWidth = 1.5 + rand() * 2.5;
    c.beginPath();
    c.moveTo(x0, H);
    c.quadraticCurveTo(x0 + lean * 0.25, H - h * 0.6, x0 + lean, H - h);
    c.stroke();
  }
  return cardTexture(canvas);
}

// A few arching fronds with leaflets along each rib.
function paintFernTexture() {
  const S = 256;
  const canvas = document.createElement("canvas");
  canvas.width = S;
  canvas.height = Math.round(S * 0.7);
  const c = canvas.getContext("2d");
  const rand = mulberry32(0x6665726e);
  const H = canvas.height;
  for (let f = 0; f < 9; f++) {
    const dir = rand() < 0.5 ? -1 : 1;
    const len = S * (0.22 + rand() * 0.26);
    const a0 = -Math.PI / 2 + dir * (0.25 + rand() * 0.9);
    const droop = 0.5 + rand() * 0.7;
    const hue = 88 + rand() * 22;
    const light = 13 + rand() * 12;
    let x = S / 2;
    let y = H;
    let a = a0;
    const steps = 14;
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      const nx = x + Math.cos(a) * (len / steps);
      const ny = y + Math.sin(a) * (len / steps);
      c.strokeStyle = `hsla(${hue}, 30%, ${light * 0.8}%, 0.9)`;
      c.lineWidth = 2 * (1 - t * 0.7);
      c.beginPath();
      c.moveTo(x, y);
      c.lineTo(nx, ny);
      c.stroke();
      // leaflets either side of the rib, shrinking toward the tip
      const ll = (1 - t) * S * 0.055;
      for (const side of [-1, 1]) {
        c.strokeStyle = `hsla(${hue + rand() * 10 - 5}, ${28 + rand() * 14}%, ${light + t * 10}%, 0.85)`;
        c.lineWidth = 1.6;
        c.beginPath();
        c.moveTo(nx, ny);
        c.lineTo(nx + Math.cos(a + side * 1.25) * ll, ny + Math.sin(a + side * 1.25) * ll);
        c.stroke();
      }
      x = nx;
      y = ny;
      a += dir * (droop / steps);
    }
  }
  return cardTexture(canvas);
}

function cardTexture(canvas) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  return tex;
}

function paint(geometry, hex, variation) {
  geometry.computeBoundingBox();
  const base = new THREE.Color(hex);
  const pos = geometry.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const height = geometry.boundingBox
    ? Math.max(0.001, geometry.boundingBox.max.y - geometry.boundingBox.min.y)
    : 1;
  const minY = geometry.boundingBox?.min.y ?? 0;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    const shade = 0.82 + (((y - minY) / height) || 0) * variation;
    colors[i * 3] = base.r * shade;
    colors[i * 3 + 1] = base.g * shade;
    colors[i * 3 + 2] = base.b * shade;
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
}

function forestDensityAt(world, x, z) {
  const { forest } = world;
  const W = world.manifest.extentMeters.width;
  const H = world.manifest.extentMeters.height;
  const c = Math.max(0, Math.min(forest.cols - 1, Math.floor((x / W) * forest.cols)));
  const r = Math.max(0, Math.min(forest.rows - 1, Math.floor((z / H) * forest.rows)));
  return forest.data[r * forest.cols + c] / 255;
}

function waterNear(world, x, z) {
  let best = Infinity;
  for (const poly of (world.osm?.water ?? []).slice(0, 120)) {
    const pts = poly.points ?? [];
    const stride = Math.max(1, Math.floor(pts.length / 80));
    for (let i = 0; i < pts.length; i += stride) {
      const p = pts[i];
      best = Math.min(best, Math.hypot(x - p[0], z - p[1]));
    }
  }
  return 1 - smoothstep(35, 190, best);
}

function slopeAt(world, x, z, step) {
  const hx = world.heightAt(x + step, z) - world.heightAt(x - step, z);
  const hz = world.heightAt(x, z + step) - world.heightAt(x, z - step);
  return Math.hypot(hx / (2 * step), hz / (2 * step));
}

function inside(world, x, z) {
  return x >= 0 && z >= 0 && x <= world.manifest.extentMeters.width && z <= world.manifest.extentMeters.height;
}

function geometryTriangles(geom) {
  return geom.index ? geom.index.count / 3 : geom.attributes.position.count / 3;
}

function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function smoothstep(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

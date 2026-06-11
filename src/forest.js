// forest.js — instanced trees placed by sampling forest.png. Two procedural
// archetypes (a conifer and a broadleaf), jittered positions, per-instance
// color variation, wind sway in the vertex shader. To bound the count on
// huge worlds, trees only populate within FOREST_RADIUS_M of the trail
// (a chamfer distance transform over the mask grid — where you can ever be).
// Two InstancedMeshes total: the whole forest is two draw calls.

import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

const BUDGET = 240_000;       // max instances across both archetypes
const BASE_SPACING_M = 5.5;   // tree spacing at density 1.0
const FOREST_RADIUS_M = 3500; // populate this far from the trail
const MIN_DENSITY = 0.06;
const MAX_SLOPE_DEG = 38;

export function createForest(world, scene) {
  const { forest, heightAt } = world;
  const { cols, rows } = forest;
  const W = world.manifest.extentMeters.width;
  const H = world.manifest.extentMeters.height;
  const cellW = W / cols;
  const cellH = H / rows;

  const dist = trailDistanceField(world, cols, rows, cellW, cellH);
  const maxCells = FOREST_RADIUS_M / ((cellW + cellH) / 2);

  // Pass 1: expected counts, to scale into the budget.
  let expected = 0;
  const perCell = cellW * cellH / (BASE_SPACING_M * BASE_SPACING_M);
  for (let i = 0; i < cols * rows; i++) {
    const d = forest.data[i] / 255;
    if (d < MIN_DENSITY || dist[i] > maxCells) continue;
    expected += d * perCell;
  }
  const scale = Math.min(1, BUDGET / Math.max(1, expected));

  // Pass 2: place
  const rand = mulberry32(1234567);
  const slopeStep = 4;
  const conifers = [];
  const broadleafs = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      const d = forest.data[i] / 255;
      if (d < MIN_DENSITY || dist[i] > maxCells) continue;
      let n = d * perCell * scale;
      if (rand() < n % 1) n++;
      for (let k = 0; k < Math.floor(n); k++) {
        const x = (c + rand()) * cellW;
        const z = (r + rand()) * cellH;
        const y = heightAt(x, z);
        const dy = Math.max(
          Math.abs(heightAt(x + slopeStep, z) - heightAt(x - slopeStep, z)),
          Math.abs(heightAt(x, z + slopeStep) - heightAt(x, z - slopeStep)),
        );
        if (dy / (2 * slopeStep) > Math.tan((MAX_SLOPE_DEG * Math.PI) / 180)) continue;
        if (dist[i] < 0.5 && rand() < 0.7) continue; // thin out right on the trail
        const t = { x, y, z, s: 0.65 + rand() * 0.75, rot: rand() * Math.PI * 2, tint: 0.8 + rand() * 0.4 };
        (rand() < 0.78 ? conifers : broadleafs).push(t);
      }
    }
  }

  const windTime = { value: 0 };
  const group = new THREE.Group();
  if (conifers.length) group.add(makeInstances(coniferGeometry(), conifers, windTime, 0x44663d));
  if (broadleafs.length) group.add(makeInstances(broadleafGeometry(), broadleafs, windTime, 0x5d7a42));
  scene.add(group);

  return {
    count: conifers.length + broadleafs.length,
    update(t) {
      windTime.value = t;
    },
  };
}

function makeInstances(geom, trees, windTime, tintHex) {
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uWindTime = windTime;
    shader.vertexShader =
      "uniform float uWindTime;\n" +
      shader.vertexShader.replace(
        "#include <begin_vertex>",
        /* glsl */ `
        #include <begin_vertex>
        #ifdef USE_INSTANCING
        {
          float ph = instanceMatrix[3].x * 0.071 + instanceMatrix[3].z * 0.113;
          float amp = smoothstep(0.5, 7.0, transformed.y) * 0.35;
          transformed.x += (sin(uWindTime * 1.3 + ph) * 0.55 + sin(uWindTime * 2.7 + ph * 1.7) * 0.25) * amp;
          transformed.z += cos(uWindTime * 1.1 + ph) * 0.4 * amp;
        }
        #endif`,
      );
  };
  const mesh = new THREE.InstancedMesh(geom, mat, trees.length);
  mesh.frustumCulled = false; // one world-sized mesh; always in view anyway
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const tint = new THREE.Color(tintHex);
  const col = new THREE.Color();
  for (let i = 0; i < trees.length; i++) {
    const t = trees[i];
    q.setFromAxisAngle(up, t.rot);
    m.compose(new THREE.Vector3(t.x, t.y, t.z), q, new THREE.Vector3(t.s, t.s * (0.9 + (t.tint - 1) * 0.5), t.s));
    mesh.setMatrixAt(i, m);
    col.copy(tint).multiplyScalar(t.tint);
    mesh.setColorAt(i, col);
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  return mesh;
}

// Low-poly archetypes with baked vertex colors (trunk vs canopy). Instance
// color multiplies on top, so the canopy hue varies tree to tree.
function coniferGeometry() {
  const trunk = new THREE.CylinderGeometry(0.14, 0.22, 1.8, 5, 1, true).translate(0, 0.9, 0);
  paint(trunk, 0x8a6844);
  const cone1 = new THREE.ConeGeometry(2.0, 5.4, 6, 1, true).translate(0, 1.6 + 2.7, 0);
  paint(cone1, 0xffffff);
  const cone2 = new THREE.ConeGeometry(1.35, 3.6, 6, 1, true).translate(0, 4.2 + 1.8, 0);
  paint(cone2, 0xf2f7ee);
  return mergeParts([trunk, cone1, cone2]);
}

// IcosahedronGeometry is non-indexed while Cylinder/Cone are indexed;
// mergeGeometries refuses mixed inputs, so normalize (these are tiny).
function mergeParts(parts) {
  return mergeGeometries(parts.map((g) => (g.index ? g.toNonIndexed() : g)));
}

function broadleafGeometry() {
  const trunk = new THREE.CylinderGeometry(0.18, 0.3, 2.4, 5, 1, true).translate(0, 1.2, 0);
  paint(trunk, 0x9a7a50);
  const canopy = new THREE.IcosahedronGeometry(2.3, 0).scale(1, 0.85, 1).translate(0, 3.8, 0);
  paint(canopy, 0xffffff);
  return mergeParts([trunk, canopy]);
}

function paint(geom, hex) {
  const c = new THREE.Color(hex);
  const n = geom.attributes.position.count;
  const colors = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geom.setAttribute("color", new THREE.BufferAttribute(colors, 3));
}

/** Chamfer distance (in cells) from each mask cell to the trail polyline. */
function trailDistanceField(world, cols, rows, cellW, cellH) {
  const dist = new Float32Array(cols * rows).fill(1e9);
  for (const p of world.trail.points) {
    const c = Math.max(0, Math.min(cols - 1, Math.floor(p.x / cellW)));
    const r = Math.max(0, Math.min(rows - 1, Math.floor(p.z / cellH)));
    dist[r * cols + c] = 0;
  }
  const D1 = 1;
  const D2 = Math.SQRT2;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (c > 0) dist[i] = Math.min(dist[i], dist[i - 1] + D1);
      if (r > 0) {
        dist[i] = Math.min(dist[i], dist[i - cols] + D1);
        if (c > 0) dist[i] = Math.min(dist[i], dist[i - cols - 1] + D2);
        if (c < cols - 1) dist[i] = Math.min(dist[i], dist[i - cols + 1] + D2);
      }
    }
  }
  for (let r = rows - 1; r >= 0; r--) {
    for (let c = cols - 1; c >= 0; c--) {
      const i = r * cols + c;
      if (c < cols - 1) dist[i] = Math.min(dist[i], dist[i + 1] + D1);
      if (r < rows - 1) {
        dist[i] = Math.min(dist[i], dist[i + cols] + D1);
        if (c < cols - 1) dist[i] = Math.min(dist[i], dist[i + cols + 1] + D2);
        if (c > 0) dist[i] = Math.min(dist[i], dist[i + cols - 1] + D2);
      }
    }
  }
  return dist;
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

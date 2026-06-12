// forest.js — instanced procedural trees placed from forest.png. The bake still
// supplies a single canopy-density mask; the renderer infers species variety
// from elevation, slope, forest edges, water proximity, and trail distance.

import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

const DEFAULT_TREE_BUDGET = 240_000;
const BASE_SPACING_M = 5.5;
const FOREST_RADIUS_M = 3500;
const MIN_DENSITY = 0.06;
const MAX_SLOPE_DEG = 38;
const TAU = Math.PI * 2;

export function createForest(world, scene, graphicsPreset = {}) {
  const { forest, heightAt } = world;
  const { cols, rows } = forest;
  const W = world.manifest.extentMeters.width;
  const H = world.manifest.extentMeters.height;
  const cellW = W / cols;
  const cellH = H / rows;
  const cellM = (cellW + cellH) / 2;
  const maxCells = FOREST_RADIUS_M / cellM;
  const treeBudget = graphicsPreset.treeBudget ?? DEFAULT_TREE_BUDGET;

  const trailDist = trailDistanceField(world, cols, rows, cellW, cellH);
  const waterDist = waterDistanceField(world, cols, rows, cellW, cellH);
  const perCell = (cellW * cellH) / (BASE_SPACING_M * BASE_SPACING_M);

  // Pass 1: expected counts, scaled into the selected graphics budget.
  let expected = 0;
  for (let i = 0; i < cols * rows; i++) {
    const density = forest.data[i] / 255;
    if (density < MIN_DENSITY || trailDist[i] > maxCells) continue;
    const trailM = trailDist[i] * cellM;
    const softTrailClear = smoothstep(18, 78, trailM);
    expected += density * softTrailClear * perCell;
  }
  const scale = Math.min(1, treeBudget / Math.max(1, expected));

  const archetypes = buildArchetypes();
  const buckets = new Map(archetypes.map((a) => [a.key, []]));
  const bySpecies = Object.fromEntries(archetypes.map((a) => [a.key, 0]));
  const shadowTrees = [];
  const shadowBudget = Math.floor(Math.min(treeBudget * 0.28, 70_000));
  const { hMin, hMax } = world.manifest.heightmap;

  // Pass 2: deterministic, per-cell placement.
  const slopeStep = Math.max(4, cellM * 0.65);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      const density = forest.data[i] / 255;
      if (density < MIN_DENSITY || trailDist[i] > maxCells) continue;

      const rand = mulberry32(hashCell(c, r, 0x4d47524e));
      const trailM = trailDist[i] * cellM;
      const waterM = waterDist ? waterDist[i] * cellM : 9999;
      const softTrailClear = smoothstep(18, 78, trailM);
      let n = density * softTrailClear * perCell * scale;
      if (rand() < n % 1) n++;

      for (let k = 0; k < Math.floor(n); k++) {
        const x = (c + blueNoiseJitter(rand, k, 0)) * cellW;
        const z = (r + blueNoiseJitter(rand, k, 1)) * cellH;
        const y = heightAt(x, z);
        const slope = slopeAt(world, x, z, slopeStep);
        if (slope.deg > MAX_SLOPE_DEG) continue;
        if (trailM < 18) continue;
        if (trailM < 34 && rand() < 0.65) continue;

        const features = {
          density,
          edge: forestEdgeAt(forest.data, cols, rows, c, r, density),
          elev01: clamp01((y - hMin) / Math.max(1, hMax - hMin)),
          slope01: clamp01(slope.deg / MAX_SLOPE_DEG),
          water01: 1 - smoothstep(40, 340, waterM),
          trail01: 1 - smoothstep(28, 180, trailM),
        };
        const archetype = chooseArchetype(archetypes, rand, features);
        const tree = makeTreeInstance(archetype, features, rand, x, y, z);
        buckets.get(archetype.key).push(tree);
        bySpecies[archetype.key]++;
        if (shadowTrees.length < shadowBudget && (trailM < 900 || rand() < 0.18)) {
          shadowTrees.push(tree);
        }
      }
    }
  }

  const windTime = { value: 0 };
  const material = makeTreeMaterial(windTime);
  const group = new THREE.Group();
  group.name = "forest";
  const meshes = [];
  let count = 0;
  let triangleEstimate = 0;

  for (const archetype of archetypes) {
    const trees = buckets.get(archetype.key);
    if (!trees.length) continue;
    const mesh = makeInstances(archetype, trees, material);
    group.add(mesh);
    meshes.push(mesh);
    count += trees.length;
    triangleEstimate += geometryTriangles(archetype.geometry) * trees.length;
  }
  const shadows = makeContactShadows(shadowTrees);
  if (shadows) {
    group.add(shadows);
    meshes.push(shadows);
    triangleEstimate += geometryTriangles(shadows.geometry) * shadows.count;
  }
  scene.add(group);

  return {
    count,
    meshes,
    bySpecies,
    triangleEstimate,
    update(t) {
      windTime.value = t;
    },
  };
}

function makeTreeMaterial(windTime) {
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uWindTime = windTime;
    shader.vertexShader =
      "attribute vec2 instanceWind;\n" +
      "uniform float uWindTime;\n" +
      shader.vertexShader.replace(
        "#include <begin_vertex>",
        /* glsl */ `
        #include <begin_vertex>
        #ifdef USE_INSTANCING
        {
          float ph = instanceWind.x;
          float amp = smoothstep(0.4, 9.0, transformed.y) * instanceWind.y;
          transformed.x += (sin(uWindTime * 1.3 + ph) * 0.55 + sin(uWindTime * 2.7 + ph * 1.7) * 0.25) * amp;
          transformed.z += cos(uWindTime * 1.1 + ph) * 0.38 * amp;
        }
        #endif`,
      );
  };
  mat.customProgramCacheKey = () => "magellan-tree-wind-v2";
  return mat;
}

function makeInstances(archetype, trees, material) {
  const mesh = new THREE.InstancedMesh(archetype.geometry, material, trees.length);
  mesh.name = `forest:${archetype.key}`;
  mesh.frustumCulled = false;
  mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);

  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const qYaw = new THREE.Quaternion();
  const qLean = new THREE.Quaternion();
  const pos = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const leanAxis = new THREE.Vector3();
  const baseTint = new THREE.Color(archetype.tintHex);
  const col = new THREE.Color();
  const wind = new Float32Array(trees.length * 2);

  for (let i = 0; i < trees.length; i++) {
    const t = trees[i];
    qYaw.setFromAxisAngle(up, t.rot);
    leanAxis.set(Math.cos(t.leanDir), 0, Math.sin(t.leanDir)).normalize();
    qLean.setFromAxisAngle(leanAxis, t.lean);
    q.multiplyQuaternions(qLean, qYaw);
    pos.set(t.x, t.y, t.z);
    scale.set(t.radius / archetype.nominalRadius, t.height / archetype.nominalHeight, t.radius / archetype.nominalRadius);
    m.compose(pos, q, scale);
    mesh.setMatrixAt(i, m);

    col.copy(baseTint).multiplyScalar(t.tint);
    mesh.setColorAt(i, col);
    wind[i * 2] = t.windPhase;
    wind[i * 2 + 1] = t.windAmp;
  }

  archetype.geometry.setAttribute("instanceWind", new THREE.InstancedBufferAttribute(wind, 2));
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  return mesh;
}

function makeContactShadows(trees) {
  if (!trees.length) return null;
  const geom = new THREE.CircleGeometry(1, 18);
  geom.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshBasicMaterial({
    color: 0x071007,
    transparent: true,
    opacity: 0.18,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
  });
  const mesh = new THREE.InstancedMesh(geom, mat, trees.length);
  mesh.name = "forest:contact-shadows";
  mesh.frustumCulled = false;
  mesh.renderOrder = 1;

  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const pos = new THREE.Vector3();
  const scale = new THREE.Vector3();
  for (let i = 0; i < trees.length; i++) {
    const t = trees[i];
    q.setFromAxisAngle(up, t.rot);
    pos.set(t.x, t.y + 0.025, t.z);
    const r = Math.max(0.45, Math.min(5.2, t.radius * 0.85));
    scale.set(r * 1.15, 1, r * (0.58 + Math.min(0.22, t.height * 0.012)));
    m.compose(pos, q, scale);
    mesh.setMatrixAt(i, m);
  }
  mesh.instanceMatrix.needsUpdate = true;
  return mesh;
}

function chooseArchetype(archetypes, rand, f) {
  const wTall = Math.max(0.02, 0.30 + f.elev01 * 0.42 + f.slope01 * 0.14 - f.water01 * 0.14);
  const wYoung = Math.max(0.02, 0.14 + f.edge * 0.18 + f.trail01 * 0.06);
  const wCedar = Math.max(0.02, 0.20 + f.density * 0.28 + f.water01 * 0.10 - f.slope01 * 0.05);
  const wRound = Math.max(0.02, 0.11 + (1 - f.elev01) * 0.32 + f.water01 * 0.24 - f.slope01 * 0.12);
  const wIrregular = Math.max(0.02, 0.08 + f.edge * 0.18 + f.water01 * 0.14);
  const wSnag = Math.max(0.01, 0.025 + f.slope01 * 0.05 + f.elev01 * 0.035);
  const wSapling = Math.max(0.01, 0.035 + f.edge * 0.24 + f.trail01 * 0.09);
  let pick = rand() * (wTall + wYoung + wCedar + wRound + wIrregular + wSnag + wSapling);
  if ((pick -= wTall) <= 0) return archetypes[0];
  if ((pick -= wYoung) <= 0) return archetypes[1];
  if ((pick -= wCedar) <= 0) return archetypes[2];
  if ((pick -= wRound) <= 0) return archetypes[3];
  if ((pick -= wIrregular) <= 0) return archetypes[4];
  if ((pick -= wSnag) <= 0) return archetypes[5];
  return archetypes[6];
}

function makeTreeInstance(archetype, f, rand, x, y, z) {
  const size = sizeFor(archetype.key, f, rand);
  return {
    species: archetype.key,
    x,
    y: y - 0.08,
    z,
    height: size.height,
    radius: size.radius,
    rot: rand() * TAU,
    lean: (0.008 + rand() * 0.045) * (1 + f.slope01 * 1.5) * (archetype.key === "deadSnag" ? 1.8 : 1),
    leanDir: rand() * TAU,
    windPhase: rand() * TAU,
    windAmp: archetype.wind * (0.75 + rand() * 0.65),
    tint: 0.86 + rand() * 0.24 + f.density * 0.05 - f.elev01 * 0.03,
  };
}

function sizeFor(key, f, rand) {
  const vigor = 0.82 + f.density * 0.22 + rand() * 0.18;
  switch (key) {
    case "tallConifer": {
      const height = (12 + rand() * 9 + f.elev01 * 4.5) * vigor;
      return { height, radius: 1.65 + height * (0.055 + rand() * 0.012) };
    }
    case "youngConifer": {
      const height = (5.4 + rand() * 4.6) * vigor;
      return { height, radius: 0.95 + height * 0.055 };
    }
    case "denseCedar": {
      const height = (9 + rand() * 6.5 + f.water01 * 2) * vigor;
      return { height, radius: 1.95 + height * 0.07 };
    }
    case "broadleafRound": {
      const height = (7.2 + rand() * 5.4 + f.water01 * 1.7) * vigor;
      return { height, radius: 2.35 + height * 0.095 };
    }
    case "broadleafIrregular": {
      const height = (6.6 + rand() * 6.6 + f.edge * 1.4) * vigor;
      return { height, radius: 2.1 + height * 0.11 };
    }
    case "deadSnag": {
      const height = 5.2 + rand() * 8.8 + f.elev01 * 2.2;
      return { height, radius: 0.38 + height * 0.025 };
    }
    default: {
      const height = 2.6 + rand() * 3.6 + f.edge * 1.2;
      return { height, radius: 0.75 + height * 0.085 };
    }
  }
}

function buildArchetypes() {
  return [
    archetype("tallConifer", 0xf2fff1, 0.30, tallConiferGeometry),
    archetype("youngConifer", 0xf5fff0, 0.42, youngConiferGeometry),
    archetype("denseCedar", 0xeaffea, 0.26, denseCedarGeometry),
    archetype("broadleafRound", 0xf7ffe7, 0.44, broadleafRoundGeometry),
    archetype("broadleafIrregular", 0xf8ffe9, 0.48, broadleafIrregularGeometry),
    archetype("deadSnag", 0xfff3df, 0.04, deadSnagGeometry),
    archetype("sapling", 0xf6ffec, 0.58, saplingGeometry),
  ];
}

function archetype(key, tintHex, wind, geometryFactory) {
  const geometry = geometryFactory();
  geometry.computeBoundingBox();
  const b = geometry.boundingBox;
  const nominalHeight = Math.max(1, b.max.y - b.min.y);
  const nominalRadius = Math.max(0.1, Math.abs(b.min.x), Math.abs(b.max.x), Math.abs(b.min.z), Math.abs(b.max.z));
  return { key, tintHex, wind, geometry, nominalHeight, nominalRadius };
}

function tallConiferGeometry() {
  return mergeParts([
    trunk(6.8, 0.34, 0.18, 0x7a5739),
    frustum(0.25, 2.35, 3.4, 1.4, 0x1f4a32, 7, 0.03, -0.05),
    frustum(0.18, 1.92, 3.1, 3.3, 0x245a38, 7, -0.08, 0.02),
    frustum(0.12, 1.48, 2.8, 5.1, 0x2d673f, 7, 0.05, 0.04),
    frustum(0.04, 0.92, 2.25, 6.8, 0x3a7648, 7, -0.03, -0.04),
  ]);
}

function youngConiferGeometry() {
  return mergeParts([
    trunk(3.6, 0.19, 0.1, 0x87623f),
    frustum(0.2, 1.3, 2.2, 0.7, 0x2a603a, 6),
    frustum(0.09, 1.0, 2.0, 2.0, 0x347044, 6, 0.04, -0.03),
    frustum(0.02, 0.58, 1.45, 3.2, 0x45824f, 6, -0.03, 0.02),
  ]);
}

function denseCedarGeometry() {
  return mergeParts([
    trunk(6.1, 0.32, 0.16, 0x755336),
    frustum(0.38, 2.7, 2.2, 1.0, 0x173b2c, 8, -0.12, 0.02),
    frustum(0.32, 2.35, 2.0, 2.35, 0x1d4731, 8, 0.1, -0.06),
    frustum(0.22, 1.95, 1.85, 3.65, 0x245339, 8, -0.06, 0.08),
    frustum(0.12, 1.5, 1.65, 4.85, 0x2e6241, 8, 0.05, 0.03),
    frustum(0.03, 0.9, 1.3, 6.0, 0x3d744b, 8),
  ]);
}

function broadleafRoundGeometry() {
  return mergeParts([
    trunk(4.1, 0.46, 0.24, 0x8a6843),
    branch([0, 2.35, 0], [1.4, 3.25, 0.35], 0.12, 0.06, 0x7f5d3e),
    branch([0, 2.75, 0], [-1.2, 3.55, -0.45], 0.11, 0.05, 0x7f5d3e),
    blob(1.85, 1.25, 1.65, 0.9, 4.0, 0.15, 0x5f823a),
    blob(1.65, 1.18, 1.55, -1.0, 4.25, -0.35, 0x6d913f),
    blob(1.9, 1.3, 1.55, 0.0, 4.85, -0.1, 0x789c45),
    blob(1.25, 1.0, 1.2, 0.1, 5.45, 0.35, 0x86a64e),
  ]);
}

function broadleafIrregularGeometry() {
  return mergeParts([
    trunk(4.4, 0.42, 0.22, 0x85623f),
    branch([0, 2.1, 0], [1.7, 3.45, -0.2], 0.12, 0.055, 0x735236),
    branch([0, 2.8, 0], [-1.55, 3.75, 0.7], 0.1, 0.05, 0x735236),
    branch([0, 3.1, 0], [0.45, 4.35, 1.4], 0.09, 0.045, 0x735236),
    blob(1.6, 1.0, 1.35, 1.35, 4.15, -0.25, 0x657f36),
    blob(1.55, 1.18, 1.35, -1.18, 4.25, 0.55, 0x78943f),
    blob(1.45, 0.95, 1.6, 0.2, 4.8, 1.0, 0x86a74a),
    blob(1.75, 1.12, 1.2, -0.25, 5.2, -0.6, 0x6e8f3b),
  ]);
}

function deadSnagGeometry() {
  return mergeParts([
    trunk(7.4, 0.32, 0.12, 0x8d765f),
    branch([0, 3.1, 0], [1.15, 3.55, 0.25], 0.085, 0.035, 0x92775d),
    branch([0, 4.2, 0], [-0.95, 4.85, -0.15], 0.075, 0.025, 0x92775d),
    branch([0, 5.6, 0], [0.55, 6.2, -0.75], 0.06, 0.02, 0x9b8269),
    frustum(0.0, 0.18, 0.95, 7.0, 0xa58b6f, 5),
  ]);
}

function saplingGeometry() {
  return mergeParts([
    trunk(2.4, 0.095, 0.04, 0x81603e),
    frustum(0.16, 0.78, 1.45, 0.65, 0x397243, 6, 0.02, 0.01),
    frustum(0.02, 0.5, 1.2, 1.65, 0x4d8b51, 6, -0.02, -0.01),
  ]);
}

function trunk(height, bottom, top, color) {
  const g = new THREE.CylinderGeometry(top, bottom, height, 6, 2, true).translate(0, height / 2, 0);
  paintGradient(g, color, { baseShade: 0.78, topBoost: 0.22, sideBoost: 0.06 });
  return g;
}

function frustum(top, bottom, height, bottomY, color, segments = 7, x = 0, z = 0) {
  const g = new THREE.CylinderGeometry(top, bottom, height, segments, 1, true).translate(x, bottomY + height / 2, z);
  paintGradient(g, color, { baseShade: 0.68, topBoost: 0.30, sideBoost: 0.10 });
  return g;
}

function blob(sx, sy, sz, x, y, z, color) {
  const g = new THREE.IcosahedronGeometry(1, 0).scale(sx, sy, sz).translate(x, y, z);
  paintGradient(g, color, { baseShade: 0.74, topBoost: 0.24, sideBoost: 0.08 });
  return g;
}

function branch(from, to, bottom, top, color) {
  const a = new THREE.Vector3(from[0], from[1], from[2]);
  const b = new THREE.Vector3(to[0], to[1], to[2]);
  const dir = b.clone().sub(a);
  const len = dir.length();
  const g = new THREE.CylinderGeometry(top, bottom, len, 5, 1, true);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize()));
  g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  paintGradient(g, color, { baseShade: 0.76, topBoost: 0.18, sideBoost: 0.05 });
  return g;
}

function mergeParts(parts) {
  const merged = mergeGeometries(parts.map((g) => (g.index ? g.toNonIndexed() : g)));
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  return merged;
}

function paintGradient(geom, hex, opts = {}) {
  geom.computeBoundingBox();
  const box = geom.boundingBox;
  const height = Math.max(0.001, box.max.y - box.min.y);
  const pos = geom.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const base = new THREE.Color(hex);
  const col = new THREE.Color();
  const baseShade = opts.baseShade ?? 0.78;
  const topBoost = opts.topBoost ?? 0.22;
  const sideBoost = opts.sideBoost ?? 0.08;

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const y01 = (y - box.min.y) / height;
    const r = Math.hypot(x, z);
    const sunSide = r > 0.001 ? clamp01(0.5 + x / r * 0.5) : 0.5;
    const shade = baseShade + y01 * topBoost + sunSide * sideBoost;
    col.copy(base).multiplyScalar(shade);
    colors[i * 3] = col.r;
    colors[i * 3 + 1] = col.g;
    colors[i * 3 + 2] = col.b;
  }
  geom.setAttribute("color", new THREE.BufferAttribute(colors, 3));
}

function slopeAt(world, x, z, step) {
  const hx = world.heightAt(x + step, z) - world.heightAt(x - step, z);
  const hz = world.heightAt(x, z + step) - world.heightAt(x, z - step);
  const gx = hx / (2 * step);
  const gz = hz / (2 * step);
  return { grade: Math.hypot(gx, gz), deg: (Math.atan(Math.hypot(gx, gz)) * 180) / Math.PI };
}

function forestEdgeAt(data, cols, rows, c, r, density) {
  let contrast = 0;
  let low = 1;
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const rr = clamp(r + dr, 0, rows - 1);
      const cc = clamp(c + dc, 0, cols - 1);
      const n = data[rr * cols + cc] / 255;
      contrast = Math.max(contrast, Math.abs(density - n));
      low = Math.min(low, n);
    }
  }
  return clamp01(contrast * 2.2 + (density > 0.24 && low < MIN_DENSITY ? 0.25 : 0));
}

/** Chamfer distance (in cells) from each mask cell to the trail polyline. */
function trailDistanceField(world, cols, rows, cellW, cellH) {
  const dist = new Float32Array(cols * rows).fill(1e9);
  for (const p of world.trail.points) {
    markCell(dist, cols, rows, p.x, p.z, cellW, cellH);
  }
  return runChamfer(dist, cols, rows);
}

function waterDistanceField(world, cols, rows, cellW, cellH) {
  const dist = new Float32Array(cols * rows).fill(1e9);
  let seeds = 0;
  for (const poly of (world.osm?.water ?? []).slice(0, 500)) {
    const pts = poly.points ?? [];
    const stride = Math.max(1, Math.floor(pts.length / 160));
    for (let i = 0; i < pts.length; i += stride) {
      const [x, z] = pts[i];
      markCell(dist, cols, rows, x, z, cellW, cellH);
      seeds++;
    }
  }
  return seeds ? runChamfer(dist, cols, rows) : null;
}

function markCell(dist, cols, rows, x, z, cellW, cellH) {
  const c = clamp(Math.floor(x / cellW), 0, cols - 1);
  const r = clamp(Math.floor(z / cellH), 0, rows - 1);
  dist[r * cols + c] = 0;
}

function runChamfer(dist, cols, rows) {
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

function geometryTriangles(geom) {
  return geom.index ? geom.index.count / 3 : geom.attributes.position.count / 3;
}

function blueNoiseJitter(rand, k, axis) {
  const g = axis === 0 ? 0.61803398875 : 0.75487766625;
  return fract(rand() * 0.65 + (k + 0.5) * g);
}

function hashCell(c, r, seed) {
  let h = seed ^ Math.imul(c + 0x9e3779b9, 0x85ebca6b) ^ Math.imul(r + 0xc2b2ae35, 0x27d4eb2f);
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
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
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const fract = (v) => v - Math.floor(v);

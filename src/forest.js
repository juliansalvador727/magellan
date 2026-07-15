// forest.js — generative card-tree forest placed from forest.png, streamed in
// cells around the camera. The bake still supplies a single canopy-density
// mask; the renderer infers species from elevation, slope, water proximity,
// and density, and keeps a clearing along the trail.
//
// Each species is a canvas-painted texture atlas (foliage card, full-tree
// card, bark strip) on card geometry: nearby trees are six radial foliage
// planes plus a real trunk cylinder, distant trees are two crossed full-tree
// cards, and beyond the far radius the satellite imagery's own canopy texture
// takes over. Everything is deterministic per cell (seeded PRNG), so the same
// forest grows on every visit.

import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { attachAtmo } from "./atmosphere.js";

const CELL = 224; // meters; placement cell
const HYSTERESIS = 90; // keep cells slightly past their radius to stop churn
const BUILD_BUDGET = 3; // cell builds per frame
const ATTEMPT_SPACING = 7.0; // meters between placement attempts
const MAX_SLOPE_DEG = 42;
const TAU = Math.PI * 2;

// planeW / trunkR are fractions of tree height; minH/varH meters
const SPECIES = {
  conifer: { foliageBase: 0.26, planeW: 0.36, trunkR: 0.015, minH: 13, varH: 23 },
  cedar: { foliageBase: 0.06, planeW: 0.28, trunkR: 0.017, minH: 11, varH: 17 },
  broadleaf: { foliageBase: 0.32, planeW: 0.52, trunkR: 0.024, minH: 7, varH: 9 },
};
const SPECIES_NAMES = Object.keys(SPECIES);

export function createForest(world, scene, graphicsPreset = {}) {
  const W = world.manifest.extentMeters.width;
  const H = world.manifest.extentMeters.height;
  const { cols, rows } = world.forest;
  const maskData = world.forest.data;
  const cellW = W / cols;
  const cellH = H / rows;
  const maskCellM = (cellW + cellH) / 2;
  const { hMin, hMax } = world.manifest.heightmap;
  const hRange = Math.max(1, hMax - hMin);

  const nearRadius = graphicsPreset.forestNear ?? 680;
  const farRadius = graphicsPreset.forestFar ?? 2500;
  const densityMul = graphicsPreset.forestDensity ?? 1;

  const trailDist = trailDistanceField(world, cols, rows, cellW, cellH);
  const waterDist = waterDistanceField(world, cols, rows, cellW, cellH);

  const maskAt = (x, z) => {
    if (x < 0 || z < 0 || x > W || z > H) return -1;
    const c = Math.min(cols - 1, Math.floor(x / cellW));
    const r = Math.min(rows - 1, Math.floor(z / cellH));
    return r * cols + c;
  };

  const group = new THREE.Group();
  group.name = "forest";
  scene.add(group);

  const windTime = { value: 0 };
  const tint = new THREE.Color(1, 1, 1);
  const atlases = {};
  const nearGeo = {};
  const nearMat = {};
  for (const name of SPECIES_NAMES) {
    atlases[name] = paintTreeAtlas(name);
    nearGeo[name] = buildNearGeometry(name);
    nearMat[name] = makeTreeMaterial(atlases[name], windTime, true);
  }
  // far cells draw every species with the conifer atlas (indistinguishable
  // out there); broadleafs just get a wider card
  const farGeo = buildFarGeometry("conifer");
  const farMat = makeTreeMaterial(atlases.conifer, windTime, false);

  const cellTrees = new Map(); // "cx,cz" -> packed Float32Array (LRU-ish)
  const nearCells = new Map(); // "cx,cz" -> {meshes}
  const farCells = new Map(); // "fx,fz" -> {meshes, nearMask}
  const stats = { trees: 0, triangles: 0, bySpecies: { conifer: 0, cedar: 0, broadleaf: 0 } };
  let statsDirty = true;

  const slopeStep = 6;
  function slopeDegAt(x, z) {
    const gx = (world.heightAt(x + slopeStep, z) - world.heightAt(x - slopeStep, z)) / (2 * slopeStep);
    const gz = (world.heightAt(x, z + slopeStep) - world.heightAt(x, z - slopeStep)) / (2 * slopeStep);
    return (Math.atan(Math.hypot(gx, gz)) * 180) / Math.PI;
  }

  // Deterministic tree list for a placement cell. Packed per tree:
  // [x, y, z, height, rotY, species, r, g, b]
  function treesForCell(cx, cz) {
    const key = `${cx},${cz}`;
    let list = cellTrees.get(key);
    if (list) return list;
    const rand = mulberry32(hashCell(cx, cz, 0x4d47524e));
    const out = [];
    const attempts = Math.floor((CELL / ATTEMPT_SPACING) ** 2 * densityMul);
    for (let i = 0; i < attempts; i++) {
      const x = (cx + rand()) * CELL;
      const z = (cz + rand()) * CELL;
      const mi = maskAt(x, z);
      if (mi < 0) continue;
      const d = maskData[mi] / 255;
      if (d < 0.05 || rand() > d * 0.85) continue;

      // keep a believable clearing along the trail: bare tread, thin verge
      const trailM = trailDist[mi] * maskCellM;
      if (trailM < 6) continue;
      if (trailM < 24 && rand() < 0.6 * (1 - trailM / 24)) continue;

      if (slopeDegAt(x, z) > MAX_SLOPE_DEG) continue;
      const y = world.heightAt(x, z);
      const elev01 = clamp01((y - hMin) / hRange);
      const waterM = waterDist ? waterDist[mi] * maskCellM : 9999;
      const water01 = 1 - smoothstep(40, 340, waterM);

      // species: broadleaf low and near water, cedar in dense stands,
      // conifer everywhere and increasingly with elevation
      const wConifer = Math.max(0.04, 0.34 + elev01 * 0.5 - water01 * 0.1);
      const wCedar = Math.max(0.02, 0.2 + d * 0.3 + water01 * 0.1 - elev01 * 0.18);
      const wBroad = Math.max(0.02, 0.1 + (1 - elev01) * 0.36 + water01 * 0.26);
      let pick = rand() * (wConifer + wCedar + wBroad);
      let si = 0;
      if ((pick -= wConifer) > 0) si = pick - wCedar <= 0 ? 1 : 2;

      const def = SPECIES[SPECIES_NAMES[si]];
      let h = def.minH + def.varH * rand() ** 1.6;
      h *= 0.75 + 0.5 * d; // closed canopy grows tall
      h *= 1 - 0.3 * smoothstep(0.6, 0.95, elev01); // subalpine stunting
      // per-tree brightness/warmth jitter (the atlas carries the base color)
      const v = 0.68 + 0.55 * rand();
      const warm = 0.93 + 0.13 * rand();
      out.push(x, y, z, h, rand() * TAU, si, v * warm, v, v / warm);
    }
    list = new Float32Array(out);
    cellTrees.set(key, list);
    if (cellTrees.size > 900) {
      for (const k of cellTrees.keys()) {
        cellTrees.delete(k);
        if (cellTrees.size <= 700) break;
      }
    }
    return list;
  }

  function buildNearCell(cx, cz) {
    const trees = treesForCell(cx, cz);
    const counts = [0, 0, 0];
    for (let i = 0; i < trees.length; i += 9) counts[trees[i + 5]]++;
    const ms = SPECIES_NAMES.map((name, si) =>
      counts[si] ? new THREE.InstancedMesh(nearGeo[name], nearMat[name], counts[si]) : null,
    );
    const cursor = [0, 0, 0];
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const p = new THREE.Vector3();
    const s = new THREE.Vector3();
    const col = new THREE.Color();
    for (let i = 0; i < trees.length; i += 9) {
      const si = trees[i + 5];
      const mesh = ms[si];
      const h = trees[i + 3];
      q.setFromAxisAngle(up, trees[i + 4]);
      p.set(trees[i], trees[i + 1], trees[i + 2]);
      s.set(h * (0.85 + 0.002 * ((i * 7) % 100)), h, h * (0.85 + 0.002 * ((i * 13) % 100)));
      m4.compose(p, q, s);
      mesh.setMatrixAt(cursor[si], m4);
      col.setRGB(trees[i + 6], trees[i + 7], trees[i + 8]);
      mesh.setColorAt(cursor[si], col);
      cursor[si]++;
    }
    const meshes = [];
    for (const mesh of ms) {
      if (!mesh) continue;
      mesh.frustumCulled = false;
      group.add(mesh);
      meshes.push(mesh);
    }
    nearCells.set(`${cx},${cz}`, { meshes });
  }

  // Far cells are 2x2 placement cells drawn as crossed cards; placement cells
  // currently shown at near detail are excluded (nearMask tracks which).
  function buildFarCell(fx, fz, nearMask) {
    const key = `${fx},${fz}`;
    dropCell(farCells, key);
    const lists = [];
    let total = 0;
    for (let q = 0; q < 4; q++) {
      if (nearMask & (1 << q)) {
        lists.push(null);
        continue;
      }
      const list = treesForCell(fx * 2 + (q & 1), fz * 2 + (q >> 1));
      lists.push(list);
      total += list.length / 9;
    }
    if (!total) {
      farCells.set(key, { meshes: [], nearMask });
      return;
    }
    const mesh = new THREE.InstancedMesh(farGeo, farMat, total);
    const m4 = new THREE.Matrix4();
    const rot = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const p = new THREE.Vector3();
    const s = new THREE.Vector3();
    const col = new THREE.Color();
    let n = 0;
    for (const trees of lists) {
      if (!trees) continue;
      for (let i = 0; i < trees.length; i += 9) {
        const h = trees[i + 3];
        const wide = trees[i + 5] === 2 ? 1.3 : 0.9; // broadleafs read wider
        rot.setFromAxisAngle(up, trees[i + 4]);
        p.set(trees[i], trees[i + 1], trees[i + 2]);
        s.set(h * wide, h, h * wide);
        m4.compose(p, rot, s);
        mesh.setMatrixAt(n, m4);
        col.setRGB(trees[i + 6], trees[i + 7], trees[i + 8]);
        mesh.setColorAt(n, col);
        n++;
      }
    }
    mesh.frustumCulled = false;
    group.add(mesh);
    farCells.set(key, { meshes: [mesh], nearMask });
  }

  function dropCell(map, key) {
    const cell = map.get(key);
    if (!cell) return;
    for (const mesh of cell.meshes) {
      group.remove(mesh);
      mesh.dispose();
    }
    map.delete(key);
  }

  function refreshStats() {
    let trees = 0;
    let triangles = 0;
    const bySpecies = { conifer: 0, cedar: 0, broadleaf: 0 };
    for (const { meshes } of nearCells.values()) {
      for (const m of meshes) {
        trees += m.count;
        triangles += geometryTriangles(m.geometry) * m.count;
        const name = SPECIES_NAMES.find((n) => nearGeo[n] === m.geometry);
        if (name) bySpecies[name] += m.count;
      }
    }
    for (const { meshes } of farCells.values()) {
      for (const m of meshes) {
        trees += m.count;
        triangles += geometryTriangles(m.geometry) * m.count;
      }
    }
    stats.trees = trees;
    stats.triangles = triangles;
    stats.bySpecies = bySpecies;
  }

  // Stream cells around the camera; builds are budgeted per frame.
  function update(camera, dt, budget = BUILD_BUDGET) {
    windTime.value += dt;
    const px = camera.position.x;
    const pz = camera.position.z;

    const wantNear = new Set();
    const nr = Math.ceil(nearRadius / CELL);
    const ccx = Math.floor(px / CELL);
    const ccz = Math.floor(pz / CELL);
    for (let dz = -nr; dz <= nr; dz++) {
      for (let dx = -nr; dx <= nr; dx++) {
        const cx = ccx + dx;
        const cz = ccz + dz;
        const key = `${cx},${cz}`;
        const limit = nearCells.has(key) ? nearRadius + HYSTERESIS : nearRadius;
        if (cellDist(px, pz, cx, cz, CELL) < limit) wantNear.add(key);
      }
    }
    for (const key of [...nearCells.keys()]) {
      if (!wantNear.has(key)) {
        dropCell(nearCells, key);
        statsDirty = true;
      }
    }

    const FAR_CELL = CELL * 2;
    const wantFar = new Map(); // key -> nearMask
    const fr = Math.ceil(farRadius / FAR_CELL);
    const fcx = Math.floor(px / FAR_CELL);
    const fcz = Math.floor(pz / FAR_CELL);
    for (let dz = -fr; dz <= fr; dz++) {
      for (let dx = -fr; dx <= fr; dx++) {
        const fx = fcx + dx;
        const fz = fcz + dz;
        const key = `${fx},${fz}`;
        const limit = farCells.has(key) ? farRadius + HYSTERESIS : farRadius;
        if (cellDist(px, pz, fx, fz, FAR_CELL) >= limit) continue;
        let mask = 0;
        for (let q = 0; q < 4; q++) {
          if (wantNear.has(`${fx * 2 + (q & 1)},${fz * 2 + (q >> 1)}`)) mask |= 1 << q;
        }
        wantFar.set(key, mask);
      }
    }
    for (const key of [...farCells.keys()]) {
      if (!wantFar.has(key)) {
        dropCell(farCells, key);
        statsDirty = true;
      }
    }

    // build the closest missing cells first
    const jobs = [];
    for (const key of wantNear) {
      if (!nearCells.has(key)) {
        const [cx, cz] = key.split(",").map(Number);
        jobs.push({ d: cellDist(px, pz, cx, cz, CELL), f: () => buildNearCell(cx, cz) });
      }
    }
    for (const [key, mask] of wantFar) {
      const cell = farCells.get(key);
      if (cell && cell.nearMask === mask) continue;
      const [fx, fz] = key.split(",").map(Number);
      jobs.push({
        d: cellDist(px, pz, fx, fz, FAR_CELL) + (cell ? 400 : 0), // refreshes wait
        f: () => buildFarCell(fx, fz, mask),
      });
    }
    jobs.sort((a, b) => a.d - b.d);
    for (let i = 0; i < Math.min(budget, jobs.length); i++) jobs[i].f();
    if (jobs.length) statsDirty = true;
    else if (statsDirty) {
      refreshStats();
      statsDirty = false;
    }
  }

  return {
    get count() {
      if (statsDirty) {
        refreshStats();
        statsDirty = false;
      }
      return stats.trees;
    },
    get triangleEstimate() {
      return stats.triangles;
    },
    get bySpecies() {
      return stats.bySpecies;
    },
    get meshes() {
      const all = [];
      for (const { meshes } of nearCells.values()) all.push(...meshes);
      for (const { meshes } of farCells.values()) all.push(...meshes);
      return all;
    },
    update,
    // build everything around a point right now (used during the loading
    // screen so the first frame already has its forest)
    prewarm(camera) {
      for (let i = 0; i < 400; i++) update(camera, 0, 24);
    },
    setTint(color) {
      tint.copy(color);
      for (const name of SPECIES_NAMES) nearMat[name].color.copy(color);
      farMat.color.copy(color);
    },
  };
}

function makeTreeMaterial(map, windTime, wind) {
  const mat = new THREE.MeshBasicMaterial({
    map,
    alphaTest: 0.35,
    side: THREE.DoubleSide,
    alphaToCoverage: true,
  });
  mat.toneMapped = false;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uWindTime = windTime;
    if (wind) {
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nuniform float uWindTime;")
        .replace(
          "#include <begin_vertex>",
          /* glsl */ `
          #include <begin_vertex>
          #ifdef USE_INSTANCING
            float windPh = instanceMatrix[3].x * 0.171 + instanceMatrix[3].z * 0.131;
            float windSway = sin(uWindTime * 1.7 + windPh) + 0.6 * sin(uWindTime * 3.1 + windPh * 1.37);
            transformed.x += windSway * 0.014 * transformed.y * transformed.y;
          #endif`,
        );
    }
  };
  mat.customProgramCacheKey = () => `magellan-tree-v3-${wind ? "wind" : "still"}`;
  attachAtmo(mat);
  return mat;
}

// ------------------------------------------------------------ geometry
// Trees are unit height (scaled per instance). The atlas per species:
//   x 0.00-0.44  full-tree card (painted trunk) — far LOD
//   x 0.46-0.90  foliage-only card               — near LOD planes
//   x 0.92-1.00  bark strip                      — near LOD trunk

function cardPlane(u0, u1, v0, v1, w, y0, y1, angle, tilt = 0) {
  const geo = new THREE.PlaneGeometry(w, y1 - y0);
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, u0 + uv.getX(i) * (u1 - u0), v0 + uv.getY(i) * (v1 - v0));
  }
  geo.translate(0, (y0 + y1) / 2, 0);
  if (tilt) geo.rotateX(tilt);
  geo.rotateY(angle);
  return geo;
}

function buildNearGeometry(name) {
  const def = SPECIES[name];
  const parts = [];
  // six radial foliage planes with slight tilt/size variation
  for (let i = 0; i < 6; i++) {
    const angle = (i * Math.PI) / 3 + (i % 2) * 0.26;
    const tilt = (i % 3 === 1 ? 1 : -1) * 0.07 * (i % 2);
    const s = i < 3 ? 1 : 0.82;
    parts.push(
      cardPlane(0.46, 0.90, def.foliageBase, 1, def.planeW * s,
        def.foliageBase + (1 - def.foliageBase) * (1 - s), 1, angle, tilt),
    );
  }
  // real trunk up to mid-foliage, UV-mapped to the bark strip
  const trunkTop = def.foliageBase + (1 - def.foliageBase) * 0.5;
  const trunk = new THREE.CylinderGeometry(def.trunkR * 0.45, def.trunkR, trunkTop, 5, 1, true);
  const tuv = trunk.attributes.uv;
  for (let i = 0; i < tuv.count; i++) tuv.setXY(i, 0.92 + tuv.getX(i) * 0.08, tuv.getY(i));
  trunk.translate(0, trunkTop / 2, 0);
  parts.push(trunk);
  return mergeGeometries(parts);
}

function buildFarGeometry(name) {
  const def = SPECIES[name];
  return mergeGeometries([
    cardPlane(0, 0.44, 0, 1, def.planeW, 0, 1, 0),
    cardPlane(0, 0.44, 0, 1, def.planeW, 0, 1, Math.PI / 2),
  ]);
}

// ------------------------------------------------------------ atlas painting
// All foliage is painted, not modeled: hundreds of small alpha-blended needle
// tufts / leaf blobs build an organic silhouette no low-poly cone can match.

function paintTreeAtlas(name) {
  const S = 1024;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = S;
  const ctx = canvas.getContext("2d");
  const rand = mulberry32(name === "conifer" ? 101 : name === "cedar" ? 202 : 303);

  // foliage painted once on its own layer, blitted into both card slots
  const card = document.createElement("canvas");
  const CW = Math.round(0.44 * S);
  card.width = CW;
  card.height = S;
  const c = card.getContext("2d");
  if (name === "broadleaf") paintBroadleafFoliage(c, CW, S, rand);
  else paintConiferFoliage(c, CW, S, rand, name === "cedar");

  ctx.drawImage(card, Math.round(0.46 * S), 0); // foliage-only slot
  paintCardTrunk(c, CW, S, rand, name); // trunk under the foliage
  ctx.drawImage(card, 0, 0); // full-tree slot

  paintBarkStrip(ctx, Math.round(0.92 * S), 0, S - Math.round(0.92 * S), S, rand, name);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  return tex;
}

// y in card space: 0 = top of tree, H = ground
function paintConiferFoliage(c, W, H, rand, cedar) {
  const def = cedar ? SPECIES.cedar : SPECIES.conifer;
  const axis = W / 2;
  const top = H * 0.015;
  const bottom = H * (1 - def.foliageBase) - H * 0.01; // foliage zone maps to the plane
  const maxHalf = W * (cedar ? 0.38 : 0.46);
  const hue = cedar ? 112 : 96;

  // crown silhouette: irregular cone, whorls broken up by jitter
  const halfAt = (t) => maxHalf * Math.pow(t, cedar ? 0.7 : 0.85) * (0.7 + 0.3 * rand());

  const whorls = cedar ? 46 : 34;
  for (let wi = 0; wi <= whorls; wi++) {
    const t = wi / whorls;
    const y = top + (bottom - top) * Math.pow(t, 0.92);
    const half = halfAt(t);
    const branches = 2 + Math.floor(rand() * 3);
    for (let side = -1; side <= 1; side += 2) {
      for (let b = 0; b < branches; b++) {
        const len = half * (0.55 + 0.45 * rand());
        const droop = len * (cedar ? 0.34 : 0.22) * (0.6 + rand());
        const y0 = y + (rand() - 0.5) * H * 0.012;
        // needle tufts along the branch, lighter toward the tip
        const steps = Math.max(3, Math.floor(len / 9));
        for (let s = 0; s <= steps; s++) {
          const f = s / steps;
          const px = axis + side * len * f;
          const py = y0 + droop * f * f;
          const light = 10 + 16 * (f * 0.75) + rand() * 8 - (cedar ? 3 : 0);
          const sat = 18 + rand() * 12;
          const r = (cedar ? 5.5 : 7) * (0.5 + rand() * 0.8) * (0.5 + f * 0.8);
          c.fillStyle = `hsla(${hue + rand() * 18 - 9}, ${sat}%, ${light}%, ${0.5 + rand() * 0.5})`;
          c.beginPath();
          c.arc(px + (rand() - 0.5) * 6, py + (rand() - 0.5) * 6, r, 0, 7);
          c.fill();
        }
      }
    }
  }
  // leader spike at the top
  c.fillStyle = `hsl(${hue}, 26%, 20%)`;
  c.beginPath();
  c.moveTo(axis - 3, top + H * 0.05);
  c.lineTo(axis, top - 2);
  c.lineTo(axis + 3, top + H * 0.05);
  c.fill();
  // interior self-shadow toward the base
  const grad = c.createLinearGradient(0, top, 0, bottom);
  grad.addColorStop(0, "rgba(0,0,0,0)");
  grad.addColorStop(1, "rgba(8,14,6,0.34)");
  c.globalCompositeOperation = "source-atop";
  c.fillStyle = grad;
  c.fillRect(0, 0, W, H);
  c.globalCompositeOperation = "source-over";
}

function paintBroadleafFoliage(c, W, H, rand) {
  const axis = W / 2;
  const cyT = H * 0.04;
  const cyB = H * (1 - SPECIES.broadleaf.foliageBase);
  const cy = (cyT + cyB) / 2;
  const ry = (cyB - cyT) / 2;
  const rx = W * 0.46;
  // clustered round canopy: many overlapping leaf blobs, sunlit at the rim
  for (let i = 0; i < 240; i++) {
    const a = rand() * TAU;
    const rr = Math.sqrt(rand());
    const px = axis + Math.cos(a) * rx * rr * 0.92;
    const py = cy + Math.sin(a) * ry * rr * 0.92;
    const light = 10 + rr * 12 + rand() * 5;
    c.fillStyle = `hsla(${86 + rand() * 16}, ${26 + rand() * 12}%, ${light}%, ${0.55 + rand() * 0.45})`;
    c.beginPath();
    c.arc(px, py, (8 + rand() * 26) * (1 - rr * 0.35), 0, 7);
    c.fill();
  }
}

function paintCardTrunk(c, W, H, rand, name) {
  const axis = W / 2;
  const baseW = W * (name === "broadleaf" ? 0.06 : 0.045);
  const topY = H * (name === "cedar" ? 0.3 : 0.45);
  c.fillStyle = name === "conifer" ? "#4d3e2d" : name === "cedar" ? "#4a3528" : "#3e3730";
  c.beginPath();
  c.moveTo(axis - baseW, H);
  c.lineTo(axis - baseW * 0.4, topY);
  c.lineTo(axis + baseW * 0.4, topY);
  c.lineTo(axis + baseW, H);
  c.fill();
  if (name === "broadleaf") {
    // a couple of limbs forking into the canopy
    c.strokeStyle = "#4a4138";
    c.lineWidth = baseW * 0.5;
    for (let i = 0; i < 3; i++) {
      const dir = i - 1;
      c.beginPath();
      c.moveTo(axis, H * 0.62);
      c.quadraticCurveTo(axis + dir * W * 0.1, H * 0.5, axis + dir * W * 0.2, H * 0.36);
      c.stroke();
    }
  }
  // bark shading streaks
  for (let i = 0; i < 18; i++) {
    const f = rand();
    c.strokeStyle = `rgba(${20 + rand() * 30}, ${15 + rand() * 22}, ${10 + rand() * 16}, 0.35)`;
    c.lineWidth = 1 + rand() * 2;
    const x = axis + (f - 0.5) * baseW * 1.6;
    c.beginPath();
    c.moveTo(x, H);
    c.lineTo(axis + (f - 0.5) * baseW * 0.8, topY + (H - topY) * rand() * 0.4);
    c.stroke();
  }
}

function paintBarkStrip(ctx, x, y, w, h, rand, name) {
  // fir bark grey-brown and fissured; cedar reddish fibrous; broadleaf grey
  const base = name === "conifer" ? [82, 66, 50] : name === "cedar" ? [76, 56, 44] : [70, 65, 57];
  ctx.fillStyle = `rgb(${base[0]}, ${base[1]}, ${base[2]})`;
  ctx.fillRect(x, y, w, h);
  // vertical fissures
  for (let i = 0; i < 26; i++) {
    const fx = x + rand() * w;
    ctx.strokeStyle = `rgba(${base[0] * 0.3}, ${base[1] * 0.3}, ${base[2] * 0.3}, ${0.4 + rand() * 0.4})`;
    ctx.lineWidth = 1 + rand() * 3;
    ctx.beginPath();
    ctx.moveTo(fx, y);
    let py = y;
    let px = fx;
    while (py < y + h) {
      py += 20 + rand() * 60;
      px += (rand() - 0.5) * 8;
      ctx.lineTo(px, py);
    }
    ctx.stroke();
  }
  // lighter plates
  for (let i = 0; i < 40; i++) {
    ctx.fillStyle = `rgba(${base[0] * 1.25}, ${base[1] * 1.2}, ${base[2] * 1.1}, ${0.12 + rand() * 0.15})`;
    ctx.fillRect(x + rand() * w, y + rand() * h, 3 + rand() * w * 0.4, 8 + rand() * 50);
  }
}

// ------------------------------------------------------------ placement fields

/** Chamfer distance (in mask cells) from each cell to the trail polyline. */
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

// ------------------------------------------------------------ small helpers

function cellDist(px, pz, cx, cz, size) {
  const dx = Math.max(Math.abs(px - (cx + 0.5) * size) - size / 2, 0);
  const dz = Math.max(Math.abs(pz - (cz + 0.5) * size) - size / 2, 0);
  return Math.hypot(dx, dz);
}

function geometryTriangles(geom) {
  return geom.index ? geom.index.count / 3 : geom.attributes.position.count / 3;
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

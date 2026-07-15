// terrain.js — one mesh per imagery chunk, vertices straight from the
// heightmap, satellite imagery as the diffuse map. Normals are computed from
// the global heightfield (not per-chunk computeVertexNormals) so chunk seams
// don't show as lighting discontinuities.
//
// The imagery is rendered *unlit*: real sun shading (and real shadows) are
// already baked into the photo, so a dynamic light would double-shade it.
// On top of the raw photo the fragment shader layers:
//   · a color grade that tames the olive-green satellite cast and adds
//     gentle warmth and contrast
//   · a tiling noise detail texture, multiplied in up close and faded out by
//     ~2 km, so ground at walking height isn't a blurry aerial photo
//   · slope relighting from the DEM normals, driven by the time-of-day sun
//     (subtle — the imagery's own shading stays dominant)
// Lighting presets tint the whole thing through material.color.

import * as THREE from "three";
import { ATMO, attachAtmo } from "./atmosphere.js";

const VERTEX_BUDGET = 1_500_000; // across all chunks; stride up when above
const FALLBACK = new THREE.Color(0x5d635a); // until the chunk texture arrives

export function createTerrain(world, scene, graphicsPreset = {}) {
  const { heights, textures } = world;
  const { data, cols, rows, sx, sz } = heights;

  const step = Math.max(1, Math.ceil(Math.sqrt((cols * rows) / VERTEX_BUDGET)));
  const meshes = [];
  const materials = [];
  const detailTexture = makeDetailTexture();
  const tint = new THREE.Color(1, 1, 1);
  let triangleEstimate = 0;

  for (const { chunk, promise } of textures) {
    // Snap chunk borders to shared grid lines so adjacent chunks reuse the
    // exact same vertex positions (no cracks).
    const c0 = clamp(Math.round(chunk.x / sx), 0, cols - 1);
    const c1 = clamp(Math.round((chunk.x + chunk.width) / sx), 0, cols - 1);
    const r0 = clamp(Math.round(chunk.z / sz), 0, rows - 1);
    const r1 = clamp(Math.round((chunk.z + chunk.height) / sz), 0, rows - 1);
    const cList = strided(c0, c1, step);
    const rList = strided(r0, r1, step);
    const nc = cList.length;
    const nr = rList.length;

    const pos = new Float32Array(nc * nr * 3);
    const nrm = new Float32Array(nc * nr * 3);
    const uv = new Float32Array(nc * nr * 2);
    let vi = 0;
    for (const r of rList) {
      for (const c of cList) {
        const x = c * sx;
        const z = r * sz;
        pos[vi * 3] = x;
        pos[vi * 3 + 1] = data[r * cols + c];
        pos[vi * 3 + 2] = z;
        // central differences on the global grid → seam-free normals
        const hl = data[r * cols + Math.max(0, c - 1)];
        const hr = data[r * cols + Math.min(cols - 1, c + 1)];
        const hu = data[Math.max(0, r - 1) * cols + c];
        const hd = data[Math.min(rows - 1, r + 1) * cols + c];
        const nx = -(hr - hl) / (2 * sx);
        const nz = -(hd - hu) / (2 * sz);
        const inv = 1 / Math.hypot(nx, 1, nz);
        nrm[vi * 3] = nx * inv;
        nrm[vi * 3 + 1] = inv;
        nrm[vi * 3 + 2] = nz * inv;
        uv[vi * 2] = clamp01((x - chunk.x) / chunk.width);
        uv[vi * 2 + 1] = 1 - clamp01((z - chunk.z) / chunk.height);
        vi++;
      }
    }

    const idx = new Uint32Array((nc - 1) * (nr - 1) * 6);
    let ii = 0;
    for (let r = 0; r < nr - 1; r++) {
      for (let c = 0; c < nc - 1; c++) {
        const a = r * nc + c;
        const b = a + 1;
        const d = a + nc;
        const e = d + 1;
        idx[ii++] = a; idx[ii++] = d; idx[ii++] = b;
        idx[ii++] = b; idx[ii++] = d; idx[ii++] = e;
      }
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geom.setAttribute("normal", new THREE.BufferAttribute(nrm, 3));
    geom.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    geom.setIndex(new THREE.BufferAttribute(idx, 1));
    geom.computeBoundingSphere();

    const mat = new THREE.MeshBasicMaterial({ color: FALLBACK });
    mat.toneMapped = false;
    mat.userData.base = FALLBACK.clone();
    tuneImageryMaterial(mat, detailTexture, graphicsPreset);
    attachAtmo(mat);
    materials.push(mat);

    const mesh = new THREE.Mesh(geom, mat);
    scene.add(mesh);
    meshes.push(mesh);
    triangleEstimate += idx.length / 3;

    promise.then((tex) => {
      if (!tex) return;
      mat.map = tex;
      mat.userData.base.setRGB(1, 1, 1);
      mat.color.copy(tint).multiply(mat.userData.base);
      mat.needsUpdate = true;
    });
  }

  return {
    meshes,
    triangleEstimate,
    setTint(color) {
      tint.copy(color);
      for (const m of materials) m.color.copy(tint).multiply(m.userData.base);
    },
  };
}

function tuneImageryMaterial(mat, detailTexture, graphicsPreset) {
  const detail = graphicsPreset.terrainDetail !== false;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uDetailMap = { value: detailTexture };
    shader.uniforms.uAtmoRelightT = ATMO.uniforms.uAtmoRelight;
    shader.uniforms.uAtmoSunDirT = ATMO.uniforms.uAtmoSunDir;
    shader.uniforms.uAtmoGlowColorT = ATMO.uniforms.uAtmoGlowColor;
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        "#include <common>\nvarying vec3 vTerrPos;\nvarying float vTerrDist;\nvarying vec3 vTerrN;",
      )
      .replace(
        "#include <fog_vertex>",
        /* glsl */ `
        #include <fog_vertex>
        vTerrPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vTerrDist = -mvPosition.z;
        vTerrN = normal;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        /* glsl */ `
        #include <common>
        uniform sampler2D uDetailMap;
        uniform float uAtmoRelightT;
        uniform vec3 uAtmoSunDirT;
        uniform vec3 uAtmoGlowColorT;
        varying vec3 vTerrPos;
        varying float vTerrDist;
        varying vec3 vTerrN;`,
      )
      .replace(
        "#include <map_fragment>",
        /* glsl */ `
        #include <map_fragment>
        {
          vec3 c = diffuseColor.rgb;
          ${detail ? /* glsl */ `
          // micro detail up close, gone by ~2 km so distant imagery is untouched
          float dNear = texture2D(uDetailMap, vTerrPos.xz / 4.5).r;
          float dMid = texture2D(uDetailMap, vTerrPos.xz / 31.0).r;
          float dFade = smoothstep(2200.0, 200.0, vTerrDist);
          c *= mix(1.0, dNear * dMid * 4.0, dFade * 0.6);
          // sub-meter grain for walking height, gone past ~90 m
          float dFine = texture2D(uDetailMap, vTerrPos.xz / 1.15).r;
          c *= mix(1.0, 0.62 + dFine * 0.76, smoothstep(90.0, 8.0, vTerrDist) * 0.55);
          ` : ""}
          // grade: tame the olive-green satellite cast, gentle warmth + contrast
          float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
          float green = clamp((c.g - max(c.r, c.b)) * 2.8, 0.0, 1.0);
          c = mix(c, vec3(luma), 0.14 + 0.30 * green);
          c *= vec3(1.05, 1.0, 0.96);
          c = (c - 0.46) * 1.05 + 0.475;
          // slope relighting from DEM normals: the photo's shading is baked at
          // one sun position, so this stays subtle — strongest at golden hour
          vec3 tN = normalize(vTerrN);
          float tNdL = clamp(dot(tN, uAtmoSunDirT), 0.0, 1.0);
          c *= mix(1.0, 0.66 + 0.6 * tNdL, uAtmoRelightT);
          c += uAtmoGlowColorT * (tNdL * tNdL * uAtmoRelightT * 0.07);
          diffuseColor.rgb = max(c, 0.0);
        }`,
      );
  };
  mat.customProgramCacheKey = () => `magellan-terrain-v3-${detail}`;
}

// Tileable multi-octave value-noise texture multiplied onto the imagery up
// close. Values average 0.5 (×4.0 across two samples keeps brightness).
function makeDetailTexture() {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(size, size);
  const lattice = (n) => {
    const g = new Float32Array(n * n);
    for (let i = 0; i < g.length; i++) g[i] = Math.random();
    return (x, y) => {
      const xi = Math.floor(x), yi = Math.floor(y);
      const xf = x - xi, yf = y - yi;
      const s = (a) => a * a * (3 - 2 * a);
      const v = (ix, iy) => g[(((iy % n) + n) % n) * n + (((ix % n) + n) % n)];
      return (
        v(xi, yi) * (1 - s(xf)) * (1 - s(yf)) +
        v(xi + 1, yi) * s(xf) * (1 - s(yf)) +
        v(xi, yi + 1) * (1 - s(xf)) * s(yf) +
        v(xi + 1, yi + 1) * s(xf) * s(yf)
      );
    };
  };
  const n1 = lattice(8), n2 = lattice(32), n3 = lattice(64);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const fx = (x / size) * 8, fy = (y / size) * 8;
      let v = 0.55 * n1(fx, fy) + 0.3 * n2(fx * 4, fy * 4) + 0.15 * n3(fx * 8, fy * 8);
      v = 0.5 + (v - 0.5) * 0.55; // soften contrast around the 0.5 mean
      const b = Math.round(v * 255);
      const i = (y * size + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = b;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.anisotropy = 4;
  return tex;
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const clamp01 = (v) => Math.max(0, Math.min(1, v));

function strided(i0, i1, step) {
  const list = [];
  for (let i = i0; i < i1; i += step) list.push(i);
  list.push(i1);
  return list;
}

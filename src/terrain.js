// terrain.js — one mesh per imagery chunk, vertices straight from the
// heightmap, satellite imagery as the diffuse map. Normals are computed from
// the global heightfield (not per-chunk computeVertexNormals) so chunk seams
// don't show as lighting discontinuities. A green-selective desaturate/warm
// pass in the fragment shader tames the satellite imagery's olive cast.

import * as THREE from "three";

const VERTEX_BUDGET = 1_500_000; // across all chunks; stride up when above

export function createTerrain(world, scene) {
  const { heights, textures } = world;
  const { data, cols, rows, sx, sz } = heights;

  const step = Math.max(1, Math.ceil(Math.sqrt((cols * rows) / VERTEX_BUDGET)));
  const meshes = [];

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

    const mat = new THREE.MeshLambertMaterial({ color: 0x70756a });
    fixOliveCast(mat);
    const mesh = new THREE.Mesh(geom, mat);
    scene.add(mesh);
    meshes.push(mesh);

    promise.then((tex) => {
      if (!tex) return;
      mat.map = tex;
      mat.color.setRGB(1, 1, 1);
      mat.needsUpdate = true;
    });
  }

  return { meshes };
}

function fixOliveCast(mat) {
  mat.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <map_fragment>",
      /* glsl */ `
      #include <map_fragment>
      {
        vec3 c = diffuseColor.rgb;
        float g = c.g - max(c.r, c.b);
        float k = clamp(g * 4.0, 0.0, 0.5);
        float l = dot(c, vec3(0.299, 0.587, 0.114));
        c = mix(c, vec3(l), k * 0.55);
        c *= vec3(1.0 + 0.10 * k, 1.0 + 0.02 * k, 1.0 - 0.08 * k);
        diffuseColor.rgb = c;
      }`,
    );
  };
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const clamp01 = (v) => Math.max(0, Math.min(1, v));

function strided(i0, i1, step) {
  const list = [];
  for (let i = i0; i < i1; i += step) list.push(i);
  list.push(i1);
  return list;
}

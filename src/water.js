// water.js — OSM natural=water polygons as flat planes at local DEM height
// with a cheap animated ripple. One merged mesh, one draw call.

import * as THREE from "three";

export function createWater(world, scene) {
  const polys = world.osm?.water ?? [];
  if (!polys.length) return { update() {} };

  const positions = [];
  const indices = [];
  let base = 0;
  for (const poly of polys.slice(0, 400)) {
    const pts = dedupeClosing(poly.points);
    if (pts.length < 3) continue;
    const contour = pts.map(([x, z]) => new THREE.Vector2(x, z));
    let tris;
    try {
      tris = THREE.ShapeUtils.triangulateShape(contour, []);
    } catch {
      continue;
    }
    // water surface = median shoreline height, slightly above the DEM so the
    // plane doesn't z-fight the terrain it sits in
    const hs = pts.map(([x, z]) => world.heightAt(x, z)).sort((a, b) => a - b);
    const y = hs[Math.floor(hs.length / 2)] + 0.35;
    for (const [x, z] of pts) positions.push(x, y, z);
    for (const [a, b, c] of tris) indices.push(base + a, base + c, base + b);
    base += pts.length;
  }
  if (!indices.length) return { update() {} };

  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geom.setIndex(indices);

  const uniforms = THREE.UniformsUtils.merge([
    THREE.UniformsLib.fog,
    {
      uTime: { value: 0 },
      uDeep: { value: new THREE.Color(0x1c4459) },
      uShallow: { value: new THREE.Color(0x3a7a8c) },
    },
  ]);
  const mat = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    fog: true,
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      #include <common>
      #include <fog_pars_vertex>
      varying vec3 vWorld;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        vec4 mvPosition = viewMatrix * wp;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <fog_pars_fragment>
      varying vec3 vWorld;
      uniform float uTime;
      uniform vec3 uDeep, uShallow;
      void main() {
        float r = sin(vWorld.x * 0.35 + uTime * 0.9) * sin(vWorld.z * 0.31 + uTime * 1.2)
                + 0.5 * sin((vWorld.x + vWorld.z) * 0.13 - uTime * 0.6);
        float sparkle = pow(max(0.0, sin(vWorld.x * 2.1 + uTime * 2.0) * sin(vWorld.z * 1.9 - uTime * 1.7)), 8.0);
        vec3 col = mix(uDeep, uShallow, 0.5 + 0.27 * r) + vec3(0.10) * sparkle;
        gl_FragColor = vec4(col, 0.88);
        #include <fog_fragment>
      }`,
  });

  const mesh = new THREE.Mesh(geom, mat);
  scene.add(mesh);
  return {
    update(t) {
      mat.uniforms.uTime.value = t;
    },
  };
}

function dedupeClosing(points) {
  if (points.length > 1) {
    const [x0, z0] = points[0];
    const [x1, z1] = points[points.length - 1];
    if (Math.abs(x0 - x1) < 0.01 && Math.abs(z0 - z1) < 0.01) {
      return points.slice(0, -1);
    }
  }
  return points;
}

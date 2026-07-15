// water.js — OSM natural=water polygons as flat planes at local DEM height.
// One merged mesh, one draw call. The shader fakes a calm lake surface:
// layered ripple normals, a fresnel blend from deep water up to the sky/haze
// color at grazing angles, and a sun glint aligned with the time-of-day sun.
// Atmosphere fog is applied manually (custom main(), so no patched chunks).

import * as THREE from "three";
import { ATMO, ATMO_FOG_PARS } from "./atmosphere.js";

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

  const uniforms = {
    ...ATMO.uniforms, // shared {value} objects — sky.js updates them
    uTime: { value: 0 },
    uDeep: { value: new THREE.Color(0x12333f) },
    uShallow: { value: new THREE.Color(0x2b5e66) },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    fog: false,
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vWorld;
      uniform float uTime;
      uniform vec3 uDeep, uShallow;
      uniform vec3 uAtmoFogColor;
      uniform vec3 uAtmoTint;
      ${ATMO_FOG_PARS}
      void main() {
        // layered ripple normal: two analytic wave scales, gently animated
        vec2 p = vWorld.xz;
        float w1 = sin(p.x * 0.131 + uTime * 0.7) * cos(p.y * 0.117 - uTime * 0.52);
        float w2 = sin(p.x * 0.53 - uTime * 1.1) * cos(p.y * 0.47 + uTime * 0.9);
        float w3 = sin((p.x + p.y) * 1.7 + uTime * 1.6);
        vec3 n = normalize(vec3(
          w1 * 0.045 + w2 * 0.03 + w3 * 0.012,
          1.0,
          w1 * 0.038 + w2 * 0.026 - w3 * 0.012
        ));

        vec3 toCam = cameraPosition - vWorld;
        float dist = length(toCam);
        vec3 view = toCam / max(dist, 1.0);

        // base color: deep in the middle of the ripple swell, shallow on crests
        vec3 col = mix(uDeep, uShallow, 0.5 + 0.3 * w1 + 0.12 * w2);

        // fresnel: grazing angles mirror the sky/haze color
        float facing = clamp(dot(view, n), 0.0, 1.0);
        float fresnel = 0.06 + 0.94 * pow(1.0 - facing, 4.0);
        col = mix(col, uAtmoFogColor * 1.06, fresnel * 0.85);

        // sun glint along the reflected ray
        vec3 refl = reflect(-view, n);
        float glint = pow(clamp(dot(refl, uAtmoSunDir), 0.0, 1.0), 240.0);
        float sparkle = pow(clamp(dot(refl, uAtmoSunDir), 0.0, 1.0), 24.0);
        col += uAtmoGlowColor * (glint * 1.6 + sparkle * 0.12);

        col *= uAtmoTint;
        col = atmoApply(col, uAtmoFogColor, vWorld, cameraPosition);
        gl_FragColor = vec4(col, 0.92);
      }`,
  });
  mat.toneMapped = false;

  const mesh = new THREE.Mesh(geom, mat);
  scene.add(mesh);
  return {
    update(t) {
      uniforms.uTime.value = t;
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

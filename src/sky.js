// sky.js — time-of-day: five presets (dawn → midday → golden → dusk → night)
// cross-faded over ~2s. Owns the sun (directional light), hemisphere light,
// gradient sky dome with a sun glow, a starfield that fades in at night,
// exponential distance fog, and the tone-mapping exposure.

import * as THREE from "three";

const PRESETS = [
  { name: "Dawn",        az: 95,  el: 7,  sun: 0xffc08a, sunInt: 1.7, top: 0x32487c, hor: 0xffc9a3, hemiSky: 0x96a8d0, hemiGnd: 0x6a5d4c, hemiInt: 0.55, fog: 0xe3c4ac, fogD: 8.5e-5, exp: 0.95, stars: 0.0 },
  { name: "Midday",      az: 180, el: 62, sun: 0xfff4e0, sunInt: 2.6, top: 0x3f7ad1, hor: 0xcfe3f5, hemiSky: 0xbdd5ee, hemiGnd: 0x8a8474, hemiInt: 0.65, fog: 0xdde8f2, fogD: 4.0e-5, exp: 1.05, stars: 0.0 },
  { name: "Golden hour", az: 262, el: 13, sun: 0xffb45e, sunInt: 2.1, top: 0x4a5d96, hor: 0xf7c27b, hemiSky: 0xc7b3d9, hemiGnd: 0x7a6a52, hemiInt: 0.5,  fog: 0xeccfa8, fogD: 6.0e-5, exp: 1.0,  stars: 0.0 },
  { name: "Dusk",        az: 274, el: -2, sun: 0x8d96c8, sunInt: 0.5, top: 0x222b52, hor: 0xd98a66, hemiSky: 0x57628e, hemiGnd: 0x3c3a38, hemiInt: 0.4,  fog: 0x9aa0c0, fogD: 6.5e-5, exp: 0.9,  stars: 0.45 },
  { name: "Night",       az: 305, el: 38, sun: 0xbdc8ff, sunInt: 0.25, top: 0x05070f, hor: 0x101a30, hemiSky: 0x1a2440, hemiGnd: 0x0c0e12, hemiInt: 0.22, fog: 0x0a0e1a, fogD: 4.5e-5, exp: 0.85, stars: 1.0 },
];

const DOME_R = 30_000;

export function createSky(world, scene, renderer) {
  const center = new THREE.Vector3(
    world.manifest.extentMeters.width / 2,
    0,
    world.manifest.extentMeters.height / 2,
  );

  const sun = new THREE.DirectionalLight(0xffffff, 2);
  sun.target.position.copy(center);
  scene.add(sun, sun.target);
  const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 0.6);
  scene.add(hemi);
  scene.fog = new THREE.FogExp2(0xdde8f2, 4e-5);

  const domeUniforms = {
    uTop: { value: new THREE.Color() },
    uHorizon: { value: new THREE.Color() },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunColor: { value: new THREE.Color() },
    uSunGlow: { value: 1 },
  };
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(DOME_R, 24, 14),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: domeUniforms,
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        varying vec3 vDir;
        uniform vec3 uTop, uHorizon, uSunColor;
        uniform vec3 uSunDir;
        uniform float uSunGlow;
        void main() {
          float t = clamp(vDir.y * 1.7 + 0.08, 0.0, 1.0);
          vec3 col = mix(uHorizon, uTop, pow(t, 0.75));
          float d = max(dot(vDir, uSunDir), 0.0);
          col += uSunColor * (pow(d, 900.0) * 4.0 + pow(d, 12.0) * 0.30) * uSunGlow;
          gl_FragColor = vec4(col, 1.0);
        }`,
    }),
  );
  dome.renderOrder = -2;
  dome.frustumCulled = false;
  scene.add(dome);

  const stars = makeStars();
  stars.renderOrder = -1;
  dome.add(stars);

  // current interpolated state
  const cur = {
    sunDir: new THREE.Vector3(0, 1, 0),
    sun: new THREE.Color(),
    sunInt: 2,
    top: new THREE.Color(),
    hor: new THREE.Color(),
    hemiSky: new THREE.Color(),
    hemiGnd: new THREE.Color(),
    hemiInt: 0.6,
    fog: new THREE.Color(),
    fogD: 4e-5,
    exp: 1,
    stars: 0,
  };
  let index = 1; // start at midday
  applyPreset(cur, PRESETS[index], 1);

  function applyPreset(state, p, t) {
    state.sunDir.lerp(sunDirOf(p), t).normalize();
    state.sun.lerp(new THREE.Color(p.sun), t);
    state.sunInt += (p.sunInt - state.sunInt) * t;
    state.top.lerp(new THREE.Color(p.top), t);
    state.hor.lerp(new THREE.Color(p.hor), t);
    state.hemiSky.lerp(new THREE.Color(p.hemiSky), t);
    state.hemiGnd.lerp(new THREE.Color(p.hemiGnd), t);
    state.hemiInt += (p.hemiInt - state.hemiInt) * t;
    state.fog.lerp(new THREE.Color(p.fog), t);
    state.fogD += (p.fogD - state.fogD) * t;
    state.exp += (p.exp - state.exp) * t;
    state.stars += (p.stars - state.stars) * t;
  }

  return {
    get label() {
      return PRESETS[index].name;
    },
    setIndex(i) {
      index = ((i % PRESETS.length) + PRESETS.length) % PRESETS.length;
    },
    cycle() {
      index = (index + 1) % PRESETS.length;
    },
    update(dt, camera) {
      const t = 1 - Math.exp(-dt * 2.2); // ~2s crossfade
      applyPreset(cur, PRESETS[index], t);

      sun.color.copy(cur.sun);
      sun.intensity = Math.max(0.01, cur.sunInt);
      sun.position.copy(center).addScaledVector(cur.sunDir, 20_000);
      hemi.color.copy(cur.hemiSky);
      hemi.groundColor.copy(cur.hemiGnd);
      hemi.intensity = cur.hemiInt;
      scene.fog.color.copy(cur.fog);
      scene.fog.density = cur.fogD;
      renderer.toneMappingExposure = cur.exp;

      domeUniforms.uTop.value.copy(cur.top);
      domeUniforms.uHorizon.value.copy(cur.hor);
      domeUniforms.uSunDir.value.copy(cur.sunDir);
      domeUniforms.uSunColor.value.copy(cur.sun);
      stars.material.opacity = cur.stars;
      stars.visible = cur.stars > 0.02;

      dome.position.set(camera.position.x, camera.position.y, camera.position.z);
    },
  };
}

function sunDirOf(p) {
  const az = (p.az * Math.PI) / 180;
  const el = (p.el * Math.PI) / 180;
  // azimuth 0 = north(-Z), 90 = east(+X); elevation up
  return new THREE.Vector3(
    Math.sin(az) * Math.cos(el),
    Math.max(-0.05, Math.sin(el)) + 0.05,
    -Math.cos(az) * Math.cos(el),
  ).normalize();
}

function makeStars() {
  const N = 1800;
  const pos = new Float32Array(N * 3);
  const rand = () => Math.random();
  for (let i = 0; i < N; i++) {
    // upper hemisphere, biased away from the horizon
    const theta = rand() * Math.PI * 2;
    const y = 0.08 + Math.pow(rand(), 0.7) * 0.92;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const R = DOME_R * 0.95;
    pos[i * 3] = Math.cos(theta) * r * R;
    pos[i * 3 + 1] = y * R;
    pos[i * 3 + 2] = Math.sin(theta) * r * R;
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.PointsMaterial({
    color: 0xcdd8ff,
    size: 55,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    fog: false,
  });
  const pts = new THREE.Points(geom, mat);
  pts.frustumCulled = false;
  return pts;
}

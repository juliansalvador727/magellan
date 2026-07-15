// sky.js — time-of-day lighting built around three's physical Sky shader
// (turbidity / rayleigh / mie scattering) instead of a painted gradient.
//
// The terrain and forest render *unlit*: real sun shading is already baked
// into the satellite imagery, so dynamic lights would double-shade it. A
// preset is therefore: sky scattering state, atmosphere (haze density,
// grounded valley fog, sun-inscatter glow), a subtle slope-relighting
// strength, tone-mapping exposure, a multiplicative tint copied onto every
// unlit material, and stars. Sun + hemisphere lights stay only for the small
// lit set (trail ribbon, roads, buildings, clutter). Switching presets
// cross-fades over ~2 s.

import * as THREE from "three";
import { Sky } from "three/addons/objects/Sky.js";
import { ATMO } from "./atmosphere.js";

//   haze      extinction per meter (aerial perspective strength)
//   valleyFog grounded fog slab strength 0..1 (dawn mist pooled low)
//   glow      sun-direction inscatter strength; glowColor its tint
//   relight   slope-based terrain relighting (0 would be flat imagery)
//   lightEl/lightAz  relight + lit-extras direction override (night → moon)
const PRESETS = [
  {
    name: "Dawn",
    el: 6, az: 95, turbidity: 7, rayleigh: 2.6, mieC: 0.006, mieG: 0.86,
    exp: 0.46, fog: 0xe3c4a8, tint: 0xffdfc4, stars: 0.25,
    haze: 5.0e-5, valleyFog: 0.85, glow: 0.5, glowColor: 0xffb678, relight: 0.42,
    sunInt: 2.3, sunColor: 0xffc08a, hemiInt: 1.0, hemiSky: 0xa6b4d4, hemiGnd: 0x776b58,
  },
  {
    name: "Midday",
    el: 45, az: 165, turbidity: 6, rayleigh: 1.8, mieC: 0.004, mieG: 0.85,
    exp: 0.62, fog: 0xcfdcec, tint: 0xffffff, stars: 0,
    haze: 3.3e-5, valleyFog: 0, glow: 0.1, glowColor: 0xfff0d8, relight: 0.12,
    sunInt: 3.4, sunColor: 0xfff4e0, hemiInt: 1.4, hemiSky: 0xc7dcf0, hemiGnd: 0x969181,
  },
  {
    name: "Golden hour",
    el: 11, az: 262, turbidity: 4.5, rayleigh: 3.2, mieC: 0.006, mieG: 0.88,
    exp: 0.55, fog: 0xeccfa6, tint: 0xffd9ae, stars: 0,
    haze: 4.4e-5, valleyFog: 0.08, glow: 0.7, glowColor: 0xffa057, relight: 0.5,
    sunInt: 2.8, sunColor: 0xffb45e, hemiInt: 1.1, hemiSky: 0xd0bfda, hemiGnd: 0x85765b,
  },
  {
    name: "Dusk",
    el: 1.5, az: 285, turbidity: 5, rayleigh: 3.8, mieC: 0.009, mieG: 0.9,
    exp: 0.38, fog: 0x9088a8, tint: 0xa2a8c6, stars: 0.55,
    haze: 4.2e-5, valleyFog: 0.2, glow: 0.3, glowColor: 0xde8660, relight: 0.24,
    sunInt: 0.8, sunColor: 0x8d96c8, hemiInt: 0.85, hemiSky: 0x677097, hemiGnd: 0x4b453e,
  },
  {
    name: "Night",
    el: -10, az: 0, turbidity: 2, rayleigh: 0.6, mieC: 0.002, mieG: 0.8,
    exp: 0.29, fog: 0x10141f, tint: 0x55628a, stars: 1,
    haze: 2.4e-5, valleyFog: 0.12, glow: 0.05, glowColor: 0x9db4dd, relight: 0.3,
    lightEl: 38, lightAz: 215, // moonlight
    sunInt: 0.5, sunColor: 0xbdc8ff, hemiInt: 0.45, hemiSky: 0x202b48, hemiGnd: 0x11151c,
  },
];

const VALLEY_FOG_DENSITY = 3.2e-4; // per meter at full strength

export function createSky(world, scene, renderer, tintables = []) {
  const { hMin, hMax } = world.manifest.heightmap;
  // valley fog pools in the lowest ~sixth of the world's relief
  const fogTop = hMin + Math.max(40, (hMax - hMin) * 0.16);
  ATMO.uniforms.uAtmoFogTop.value = fogTop;

  const sky = new Sky();
  sky.scale.setScalar(400_000);
  scene.add(sky);
  const skyU = sky.material.uniforms;

  const stars = makeStars();
  scene.add(stars);

  // lit extras only (trail, roads, buildings, clutter rocks/logs)
  const sun = new THREE.DirectionalLight(0xffffff, 2);
  scene.add(sun, sun.target);
  const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1);
  scene.add(hemi);

  // patched fog chunks only read fogColor; near/far are unused
  scene.fog = new THREE.Fog(0xcfdcec, 1000, 100_000);

  const paramsFor = (p) => ({
    sunDir: dirOf(p.el, p.az),
    lightDir: dirOf(p.lightEl ?? Math.max(p.el, 4), p.lightAz ?? p.az),
    turbidity: p.turbidity, rayleigh: p.rayleigh, mieC: p.mieC, mieG: p.mieG,
    exp: p.exp,
    fog: new THREE.Color(p.fog),
    tint: new THREE.Color(p.tint),
    stars: p.stars,
    haze: p.haze, valleyFog: p.valleyFog,
    glow: p.glow, glowColor: new THREE.Color(p.glowColor),
    relight: p.relight,
    sunInt: p.sunInt, sunColor: new THREE.Color(p.sunColor),
    hemiInt: p.hemiInt, hemiSky: new THREE.Color(p.hemiSky), hemiGnd: new THREE.Color(p.hemiGnd),
  });

  let index = 1; // start at midday
  const state = paramsFor(PRESETS[index]);
  let from = null;
  let to = null;
  let fade = 1;
  let lastNow = performance.now();

  function apply() {
    const s = state;
    skyU.sunPosition.value.copy(s.sunDir);
    skyU.turbidity.value = s.turbidity;
    skyU.rayleigh.value = s.rayleigh;
    skyU.mieCoefficient.value = s.mieC;
    skyU.mieDirectionalG.value = s.mieG;
    renderer.toneMappingExposure = s.exp;

    scene.fog.color.copy(s.fog);
    const A = ATMO.uniforms;
    A.uAtmoSunDir.value.copy(s.lightDir);
    A.uAtmoGlowColor.value.copy(s.glowColor);
    A.uAtmoGlow.value = s.glow;
    A.uAtmoHaze.value = s.haze;
    A.uAtmoValleyFog.value = s.valleyFog * VALLEY_FOG_DENSITY;
    A.uAtmoRelight.value = s.relight;
    A.uAtmoTint.value.copy(s.tint);
    A.uAtmoFogColor.value.copy(s.fog);

    for (const t of tintables) t.setTint?.(s.tint);

    sun.color.copy(s.sunColor);
    sun.intensity = Math.max(0.01, s.sunInt);
    hemi.color.copy(s.hemiSky);
    hemi.groundColor.copy(s.hemiGnd);
    hemi.intensity = s.hemiInt;

    stars.material.opacity = s.stars;
    stars.visible = s.stars > 0.01;
  }
  apply();

  return {
    get label() {
      return PRESETS[index].name;
    },
    setIndex(i) {
      index = ((i % PRESETS.length) + PRESETS.length) % PRESETS.length;
      from = { ...state, sunDir: state.sunDir.clone(), lightDir: state.lightDir.clone(),
               fog: state.fog.clone(), tint: state.tint.clone(), glowColor: state.glowColor.clone(),
               sunColor: state.sunColor.clone(), hemiSky: state.hemiSky.clone(), hemiGnd: state.hemiGnd.clone() };
      to = paramsFor(PRESETS[index]);
      fade = 0;
    },
    cycle() {
      this.setIndex(index + 1);
    },
    update(dt, camera) {
      // crossfade on wall time, not the (capped) frame dt — on a slow or
      // software renderer the capped dt would stretch a 2 s fade to ages
      const now = performance.now();
      const wallDt = Math.min(1, (now - lastNow) / 1000);
      lastNow = now;
      if (fade < 1 && from && to) {
        fade = Math.min(1, fade + wallDt / 2.2);
        const f = fade * fade * (3 - 2 * fade);
        state.sunDir.lerpVectors(from.sunDir, to.sunDir, f).normalize();
        state.lightDir.lerpVectors(from.lightDir, to.lightDir, f).normalize();
        for (const k of ["turbidity", "rayleigh", "mieC", "mieG", "exp", "stars",
                         "haze", "valleyFog", "glow", "relight", "sunInt", "hemiInt"]) {
          state[k] = from[k] + (to[k] - from[k]) * f;
        }
        for (const k of ["fog", "tint", "glowColor", "sunColor", "hemiSky", "hemiGnd"]) {
          state[k].lerpColors(from[k], to[k], f);
        }
      }
      apply();

      // sky box + stars + sun follow the camera so directions stay true
      sky.position.copy(camera.position);
      stars.position.copy(camera.position);
      sun.position.copy(camera.position).addScaledVector(state.lightDir, 8_000);
      sun.target.position.copy(camera.position);
    },
  };
}

function dirOf(elevDeg, azimDeg) {
  const el = (elevDeg * Math.PI) / 180;
  const az = (azimDeg * Math.PI) / 180;
  // azimuth 0 = north(-Z), 90 = east(+X)
  return new THREE.Vector3(
    Math.sin(az) * Math.cos(el),
    Math.sin(el),
    -Math.cos(az) * Math.cos(el),
  ).normalize();
}

// Star dome with a faint Milky Way band, additive beyond the haze.
function makeStars() {
  const R = 70_000;
  const N = 3200;
  const positions = new Float32Array(N * 3);
  const colors = new Float32Array(N * 3);
  const dir = new THREE.Vector3();
  const tiltAxis = new THREE.Vector3(1, 0, 0);
  for (let i = 0; i < N; i++) {
    if (i < N * 0.45) {
      // band: scattered around a tilted great circle
      const a = Math.random() * Math.PI * 2;
      const spread = (Math.random() - 0.5) * 0.5 * (Math.random() < 0.7 ? 1 : 2.5);
      dir.set(Math.cos(a), spread, Math.sin(a)).normalize();
      dir.applyAxisAngle(tiltAxis, 1.0);
    } else {
      dir.set(Math.random() * 2 - 1, Math.random(), Math.random() * 2 - 1).normalize();
    }
    if (dir.y < 0.02) dir.y = 0.02 + Math.random() * 0.1;
    dir.normalize();
    positions[i * 3] = dir.x * R;
    positions[i * 3 + 1] = dir.y * R;
    positions[i * 3 + 2] = dir.z * R;
    const m = 0.4 + Math.random() ** 3 * 0.6;
    const warm = Math.random();
    colors[i * 3] = m * (warm > 0.8 ? 1 : 0.85 + warm * 0.15);
    colors[i * 3 + 1] = m * 0.92;
    colors[i * 3 + 2] = m * (warm < 0.2 ? 1 : 0.9);
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geom.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  const mat = new THREE.PointsMaterial({
    size: 2.2,
    sizeAttenuation: false,
    vertexColors: true,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    fog: false,
    blending: THREE.AdditiveBlending,
  });
  mat.toneMapped = false;
  const stars = new THREE.Points(geom, mat);
  stars.visible = false;
  stars.frustumCulled = false;
  stars.renderOrder = 2;
  return stars;
}

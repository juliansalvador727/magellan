// atmosphere.js — replaces three's stock fog with aerial perspective, shared
// by every material in the scene.
//
// The fog ShaderChunks are patched globally before any material compiles, so
// terrain, trees, water, trail, roads and buildings all share one model:
//   · exponential distance haze — ridgelines recede in layers instead of
//     hitting a flat fog wall
//   · a grounded valley-fog slab integrated analytically along the view ray,
//     so dawn mist pools in the lowlands and thins with altitude
//   · sun-direction inscatter, so the haze glows warm around the sun at
//     golden hour instead of being a grey veil
//
// All parameters live in one shared uniforms object (ATMO.uniforms): sky.js
// writes them once per frame and every patched material picks them up.
// fogColor itself stays renderer-managed through scene.fog.

import * as THREE from "three";

export const ATMO = {
  uniforms: {
    uAtmoSunDir: { value: new THREE.Vector3(0, 1, 0) }, // inscatter + relight direction
    uAtmoGlowColor: { value: new THREE.Color(0xffd9b0) },
    uAtmoGlow: { value: 0.15 }, // inscatter strength 0..1
    uAtmoHaze: { value: 0.000038 }, // extinction per meter
    uAtmoValleyFog: { value: 0.0 }, // slab density per meter at the slab top
    uAtmoFogTop: { value: 500.0 }, // ASL height where valley fog thins out
    uAtmoRelight: { value: 0.1 }, // slope-based terrain relighting strength
    uAtmoTint: { value: new THREE.Color(0xffffff) }, // preset tint, for custom shaders
    uAtmoFogColor: { value: new THREE.Color(0xcfdcec) }, // alias of scene.fog.color
  },
};

// Shared fog math. Used by the patched chunks, and manually by custom
// shaders (water.js) that build their own main(). Expects the uniforms above.
export const ATMO_FOG_PARS = /* glsl */ `
  uniform vec3 uAtmoSunDir;
  uniform vec3 uAtmoGlowColor;
  uniform float uAtmoGlow;
  uniform float uAtmoHaze;
  uniform float uAtmoValleyFog;
  uniform float uAtmoFogTop;
  vec3 atmoApply(vec3 color, vec3 fogCol, vec3 worldPos, vec3 camPos) {
    vec3 v = worldPos - camPos;
    float dist = length(v);
    vec3 dir = v / max(dist, 1.0);
    // aerial perspective
    float f = 1.0 - exp(-dist * uAtmoHaze);
    // grounded valley fog: exponential-falloff slab below uAtmoFogTop,
    // optical depth integrated in closed form along the ray
    if (uAtmoValleyFog > 1e-7) {
      float k = 0.016;
      float dy = abs(dir.y) < 0.01 ? (dir.y < 0.0 ? -0.01 : 0.01) : dir.y;
      float od = uAtmoValleyFog * exp(-(camPos.y - uAtmoFogTop) * k)
               * (1.0 - exp(-dist * dy * k)) / (dy * k);
      f = 1.0 - (1.0 - f) * exp(-clamp(od, 0.0, 6.0));
    }
    // warm inscatter toward the sun
    float sunAmt = pow(clamp(dot(dir, uAtmoSunDir), 0.0, 1.0), 10.0);
    vec3 haze = fogCol + uAtmoGlowColor * (sunAmt * uAtmoGlow);
    return mix(color, haze, clamp(f, 0.0, 1.0));
  }
`;

let installed = false;

/** Patch the fog chunks. Must run before any material compiles. */
export function installAtmosphere() {
  if (installed) return;
  installed = true;

  THREE.ShaderChunk.fog_pars_vertex = /* glsl */ `
    #ifdef USE_FOG
      varying vec3 vAtmoPos;
    #endif
  `;
  // 'transformed' exists in every Mesh vertex shader (begin_vertex). Sprite
  // and Points materials don't have it — they must opt out with fog:false.
  THREE.ShaderChunk.fog_vertex = /* glsl */ `
    #ifdef USE_FOG
      #ifdef USE_INSTANCING
        vAtmoPos = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
      #else
        vAtmoPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
      #endif
    #endif
  `;
  THREE.ShaderChunk.fog_pars_fragment = /* glsl */ `
    #ifdef USE_FOG
      uniform vec3 fogColor;
      varying vec3 vAtmoPos;
      ${ATMO_FOG_PARS}
    #endif
  `;
  THREE.ShaderChunk.fog_fragment = /* glsl */ `
    #ifdef USE_FOG
      gl_FragColor.rgb = atmoApply(gl_FragColor.rgb, fogColor, vAtmoPos, cameraPosition);
    #endif
  `;
}

/**
 * Attach the shared atmosphere uniforms to a material, preserving any
 * existing onBeforeCompile hook. Required for every fogged material — the
 * renderer only auto-updates the stock fog uniforms (fogColor).
 */
export function attachAtmo(material) {
  const prev = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    prev?.(shader, renderer);
    Object.assign(shader.uniforms, ATMO.uniforms);
  };
  return material;
}

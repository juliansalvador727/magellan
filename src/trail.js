// trail.js — the GPX route as a ribbon hugging the terrain, lifted a fraction
// of a meter so it reads clearly without z-fighting. Markers at trailhead and
// end, labels for GPX waypoints and named OSM POIs (peaks, falls, viewpoints).

import * as THREE from "three";

const RIBBON_W = 0.85;
const LIFT = 0.1;

export function createTrail(world, scene) {
  const pts = world.trail.points;
  const group = new THREE.Group();

  if (pts.length >= 2) {
    const n = pts.length;
    const lanes = [-0.5, -0.18, 0.18, 0.5];
    const pos = new Float32Array(n * lanes.length * 3);
    const colors = new Float32Array(n * lanes.length * 3);
    const edge = new THREE.Color(0x423526);
    const center = new THREE.Color(0x7a5f43);
    const col = new THREE.Color();
    for (let i = 0; i < n; i++) {
      const p = pts[i];
      const a = pts[Math.max(0, i - 1)];
      const b = pts[Math.min(n - 1, i + 1)];
      let dx = b.x - a.x;
      let dz = b.z - a.z;
      const len = Math.hypot(dx, dz) || 1;
      dx /= len;
      dz /= len;
      // lift more on steep ground: the ribbon linearly interpolates between
      // samples, so on cliffs the terrain mesh can poke through a flat lift
      const slope =
        Math.abs(world.heightAt(p.x + 4, p.z) - world.heightAt(p.x - 4, p.z)) / 8 +
        Math.abs(world.heightAt(p.x, p.z + 4) - world.heightAt(p.x, p.z - 4)) / 8;
      const lift = LIFT + Math.min(0.6, slope * 0.55);
      for (let j = 0; j < lanes.length; j++) {
        const off = lanes[j] * RIBBON_W;
        const x = p.x + -dz * off;
        const z = p.z + dx * off;
        const vi = (i * lanes.length + j) * 3;
        pos[vi + 0] = x;
        pos[vi + 1] = world.heightAt(x, z) + lift;
        pos[vi + 2] = z;
        const centerWeight = 1 - Math.min(1, Math.abs(lanes[j]) * 2);
        col.copy(edge).lerp(center, centerWeight);
        colors[vi + 0] = col.r;
        colors[vi + 1] = col.g;
        colors[vi + 2] = col.b;
      }
    }
    const idx = new Uint32Array((n - 1) * (lanes.length - 1) * 6);
    for (let i = 0, ii = 0; i < n - 1; i++) {
      const row = i * lanes.length;
      const next = row + lanes.length;
      for (let j = 0; j < lanes.length - 1; j++) {
        const a = row + j;
        const b = row + j + 1;
        const c = next + j;
        const d = next + j + 1;
        idx[ii++] = a; idx[ii++] = b; idx[ii++] = c;
        idx[ii++] = b; idx[ii++] = d; idx[ii++] = c;
      }
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geom.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geom.setIndex(new THREE.BufferAttribute(idx, 1));
    geom.computeVertexNormals();
    // unlit like the terrain it lies on, and translucent so the imagery's own
    // ground shows through — an opaque lit ribbon reads as a painted stripe
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      vertexColors: true,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.62,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -2,
    });
    group.add(new THREE.Mesh(geom, mat));
  }

  // Trailhead / end markers
  const head = pts[0];
  const end = pts[pts.length - 1];
  group.add(makeMarker(head, 0x7fd4a8, "Trailhead"));
  const loop = Math.hypot(end.x - head.x, end.z - head.z) < 50;
  if (!loop) group.add(makeMarker(end, 0xff8a5c, "Trail end"));

  // GPX waypoints
  for (const w of world.trail.waypoints ?? []) {
    group.add(makeMarker(w, 0xffd27f, w.name));
  }

  // Named OSM POIs — labels only, floated above the summit/fall
  for (const poi of world.osm?.pois ?? []) {
    const y = world.heightAt(poi.x, poi.z);
    const label = makeLabel(poi.name, poi.kind === "peak" ? "#ffffff" : "#bfe3ff");
    const s = poi.kind === "peak" ? 72 : 46; // peaks are read from far away
    label.scale.set(s, s / 4, 1);
    label.position.set(poi.x, y + (poi.kind === "peak" ? 32 : 16), poi.z);
    group.add(label);
  }

  scene.add(group);
  return { group };

  function makeMarker(p, color, text) {
    const g = new THREE.Group();
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.12, 0.12, 3, 6),
      new THREE.MeshLambertMaterial({ color: 0xd8d4c8 }),
    );
    pole.position.set(p.x, world.heightAt(p.x, p.z) + 1.5, p.z);
    const cap = new THREE.Mesh(
      new THREE.SphereGeometry(0.45, 10, 8),
      new THREE.MeshBasicMaterial({ color }),
    );
    cap.position.set(p.x, pole.position.y + 1.7, p.z);
    g.add(pole, cap);
    if (text) {
      const label = makeLabel(text, "#" + new THREE.Color(color).getHexString());
      label.scale.set(24, 6, 1);
      label.position.set(p.x, pole.position.y + 5.5, p.z);
      g.add(label);
    }
    return g;
  }
}

export function makeLabel(text, color = "#ffffff") {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 128;
  const ctx = canvas.getContext("2d");
  ctx.font = "600 56px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineWidth = 10;
  ctx.strokeStyle = "rgba(0,0,0,0.75)";
  ctx.strokeText(text, 256, 64);
  ctx.fillStyle = color;
  ctx.fillText(text, 256, 64);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const sprite = new THREE.Sprite(
    // fog:false is required: the patched atmosphere fog chunks need mesh
    // vertex state that sprite shaders don't have
    new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, fog: false }),
  );
  return sprite;
}

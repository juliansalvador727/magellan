// trail.js — the GPX route as a ribbon hugging the terrain, lifted a fraction
// of a meter so it reads clearly without z-fighting. Markers at trailhead and
// end, labels for GPX waypoints and named OSM POIs (peaks, falls, viewpoints).

import * as THREE from "three";

const RIBBON_W = 1.6;
const LIFT = 0.4;

export function createTrail(world, scene) {
  const pts = world.trail.points;
  const group = new THREE.Group();

  if (pts.length >= 2) {
    const n = pts.length;
    const pos = new Float32Array(n * 2 * 3);
    for (let i = 0; i < n; i++) {
      const p = pts[i];
      const a = pts[Math.max(0, i - 1)];
      const b = pts[Math.min(n - 1, i + 1)];
      let dx = b.x - a.x;
      let dz = b.z - a.z;
      const len = Math.hypot(dx, dz) || 1;
      dx /= len;
      dz /= len;
      // perpendicular in the ground plane
      const px = -dz * (RIBBON_W / 2);
      const pz = dx * (RIBBON_W / 2);
      // lift more on steep ground: the ribbon linearly interpolates between
      // samples, so on cliffs the terrain mesh can poke through a flat lift
      const slope =
        Math.abs(world.heightAt(p.x + 4, p.z) - world.heightAt(p.x - 4, p.z)) / 8 +
        Math.abs(world.heightAt(p.x, p.z + 4) - world.heightAt(p.x, p.z - 4)) / 8;
      const lift = LIFT + Math.min(1.6, slope * 1.2);
      // re-sample ground at each edge so the ribbon banks with the slope
      pos[i * 6 + 0] = p.x + px;
      pos[i * 6 + 1] = world.heightAt(p.x + px, p.z + pz) + lift;
      pos[i * 6 + 2] = p.z + pz;
      pos[i * 6 + 3] = p.x - px;
      pos[i * 6 + 4] = world.heightAt(p.x - px, p.z - pz) + lift;
      pos[i * 6 + 5] = p.z - pz;
    }
    const idx = new Uint32Array((n - 1) * 6);
    for (let i = 0, ii = 0; i < n - 1; i++) {
      const a = i * 2;
      idx[ii++] = a; idx[ii++] = a + 1; idx[ii++] = a + 2;
      idx[ii++] = a + 1; idx[ii++] = a + 3; idx[ii++] = a + 2;
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geom.setIndex(new THREE.BufferAttribute(idx, 1));
    const mat = new THREE.MeshBasicMaterial({
      color: 0xff5230,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -2,
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
    const s = poi.kind === "peak" ? 130 : 60; // peaks are read from far away
    label.scale.set(s, s / 4, 1);
    label.position.set(poi.x, y + (poi.kind === "peak" ? 40 : 18), poi.z);
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
    new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }),
  );
  return sprite;
}

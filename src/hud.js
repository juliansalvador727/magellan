// hud.js — trail name + stats, live elevation / distance-along-trail,
// time-of-day label, key hints, and the required data attribution.

export function createHud(world) {
  const tl = document.getElementById("hud-tl");
  const bl = document.getElementById("hud-bl");
  const br = document.getElementById("hud-br");
  const bc = document.getElementById("hud-bc");

  const name = world.manifest.name;
  const km = (world.trail.lengthM / 1000).toFixed(1);
  tl.innerHTML = `<div class="name">${esc(name)}</div><div class="sub">${km} km trail</div>`;
  bc.textContent = world.manifest.attribution.join("  ·  ");

  const pts = world.trail.points;
  let frame = 0;
  let nearestDist = 0;

  function update(camera, sky, controls) {
    // nearest-trail-point search is cheap (a few thousand points) but no need
    // to do it every frame
    if (frame++ % 15 === 0) {
      let best = Infinity;
      for (const p of pts) {
        const d = (p.x - camera.position.x) ** 2 + (p.z - camera.position.z) ** 2;
        if (d < best) {
          best = d;
          nearestDist = p.distM;
        }
      }
    }
    bl.innerHTML =
      `elev ${Math.round(camera.position.y)} m<br>` +
      `trail ${(nearestDist / 1000).toFixed(2)} / ${km} km<br>` +
      `${controls.mode}${controls.mode === "fly" ? ` ${Math.round(controls.speed)} m/s` : ""}`;
    br.innerHTML =
      `<span class="tod">${sky.label}</span><br>` +
      `click look · WASD move · F fly/walk<br>` +
      `Space/C up/down · scroll speed · L time · M sound`;
  }

  return { update };
}

const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

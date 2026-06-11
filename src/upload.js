// upload.js — the drag-drop bake page. POSTs the GPX text to /bake and reads
// the SSE-formatted progress stream, then redirects into the world.

const drop = document.getElementById("drop");
const fileInput = document.getElementById("file");
const log = document.getElementById("log");
const bar = document.getElementById("bar");
const barFill = bar.querySelector("div");

const STAGES = [
  ["parse", "reading trail"],
  ["elevation", "downloading elevation"],
  ["heightmap", "building heightmap"],
  ["imagery", "downloading + stitching imagery"],
  ["forest", "classifying forest"],
  ["osm", "fetching map data"],
  ["trail", "draping trail"],
  ["done", "finishing"],
];

drop.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  if (fileInput.files[0]) bakeFile(fileInput.files[0]);
});
for (const ev of ["dragover", "dragenter"]) {
  drop.addEventListener(ev, (e) => {
    e.preventDefault();
    drop.classList.add("hover");
  });
}
for (const ev of ["dragleave", "drop"]) {
  drop.addEventListener(ev, (e) => {
    e.preventDefault();
    drop.classList.remove("hover");
  });
}
drop.addEventListener("drop", (e) => {
  const f = e.dataTransfer?.files?.[0];
  if (f) bakeFile(f);
});

let baking = false;
async function bakeFile(file) {
  if (baking) return;
  baking = true;
  bar.style.display = "block";
  log.innerHTML = STAGES.map(
    ([id, label]) => `<div class="stage" id="st-${id}">· ${label}</div>`,
  ).join("");

  try {
    const text = await file.text();
    const res = await fetch("/bake", { method: "POST", body: text });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 2);
        if (!line.startsWith("data:")) continue;
        handleEvent(JSON.parse(line.slice(5)));
      }
    }
  } catch (err) {
    showError(err.message);
  }
  baking = false;
}

function handleEvent(ev) {
  if (ev.error) return showError(ev.error);
  // Final event is {done: true, worldId}; progress events carry a numeric
  // done/total counter, so a strict check keeps them from triggering the redirect.
  if (ev.done === true) {
    barFill.style.width = "100%";
    location.href = `/explore/${ev.worldId}`;
    return;
  }
  const i = STAGES.findIndex(([id]) => id === ev.stage);
  if (i === -1) return;
  STAGES.forEach(([id], j) => {
    const el = document.getElementById(`st-${id}`);
    el.classList.toggle("active", j === i);
    el.textContent = (j < i ? "✓ " : j === i ? "→ " : "· ") + STAGES[j][1];
  });
  const active = document.getElementById(`st-${ev.stage}`);
  if (ev.message) active.textContent = `→ ${STAGES[i][1]} — ${ev.message}`;
  const frac = (i + (ev.total ? ev.done / ev.total : 0)) / STAGES.length;
  barFill.style.width = `${Math.round(frac * 100)}%`;
}

function showError(msg) {
  log.innerHTML = `<div class="error">bake failed: ${msg}</div>`;
  bar.style.display = "none";
}

// Previously baked worlds
(async () => {
  const worlds = await fetch("/api/worlds").then((r) => r.json()).catch(() => []);
  if (!worlds.length) return;
  const el = document.getElementById("worlds");
  el.innerHTML =
    "<h2>Baked worlds</h2>" +
    worlds
      .map(
        (w) => `<a href="/explore/${w.worldId}">
          <span>${escapeHtml(w.name)}</span>
          <span class="meta">${w.lengthM ? (w.lengthM / 1000).toFixed(1) + " km · " : ""}${w.worldId}</span>
        </a>`,
      )
      .join("");
})();

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

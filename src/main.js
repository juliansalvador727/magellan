// main.js — renderer entry. Loads the world named in the URL
// (/explore/<worldId>), wires every module together, runs the frame loop.

import * as THREE from "three";
import { loadWorld } from "./loader.js";
import { createTerrain } from "./terrain.js";
import { createTrail } from "./trail.js";
import { createForest } from "./forest.js";
import { createClutter } from "./clutter.js";
import { createSky } from "./sky.js";
import { createWater } from "./water.js";
import { createHuman } from "./human.js";
import { createControls } from "./controls.js";
import { createHud } from "./hud.js";
import { createSound } from "./sound.js";
import { createGraphicsCounters, getGraphicsPreset } from "./graphics.js";

const overlay = document.getElementById("overlay");
const loadMsg = document.getElementById("loadmsg");
const loadBar = document.querySelector("#loadbar div");

const worldId = location.pathname.split("/").filter(Boolean).pop();

main().catch((err) => {
  loadMsg.textContent = `failed to load world "${worldId}": ${err.message}`;
  loadMsg.style.color = "#ff7b8a";
  console.error(err);
});

async function main() {
  const graphicsPreset = getGraphicsPreset();
  const world = await loadWorld(worldId, (label, frac) => {
    loadMsg.textContent = label;
    loadBar.style.width = `${Math.round(frac * 100)}%`;
  });
  document.title = `${world.manifest.name} — magellan`;

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(innerWidth, innerHeight);
  renderer.setPixelRatio(Math.min(devicePixelRatio, graphicsPreset.pixelRatio));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  document.body.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.5, 80_000);

  loadMsg.textContent = "building terrain…";
  const terrain = createTerrain(world, scene, graphicsPreset);
  createTrail(world, scene);
  const water = createWater(world, scene);
  createHuman(world, scene);
  const clutter = createClutter(world, scene, graphicsPreset);
  loadMsg.textContent = "growing forest…";
  await nextFrame(); // let the message paint before the placement loop
  const forest = createForest(world, scene, graphicsPreset);
  const sky = createSky(world, scene, renderer);
  const controls = createControls(camera, world, renderer.domElement);
  const hud = createHud(world);
  const sound = createSound();
  const graphics = createGraphicsCounters({ renderer, world, forest, terrain, clutter, preset: graphicsPreset });

  document.addEventListener("keydown", (e) => {
    if (e.code === "KeyL") sky.cycle();
    if (/^Digit[1-5]$/.test(e.code)) sky.setIndex(Number(e.code.slice(5)) - 1);
    if (e.code === "KeyM") sound.toggle();
  });
  window.addEventListener("resize", () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });

  const clock = new THREE.Clock();
  let firstFrame = true;
  renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), 0.1);
    const t = clock.elapsedTime;
    controls.update(dt);
    sky.update(dt, camera);
    water.update(t);
    forest.update(t);
    hud.update(camera, sky, controls);
    renderer.render(scene, camera);
    graphics.update(dt);
    if (firstFrame) {
      firstFrame = false;
      overlay.classList.add("hidden");
      // hooks for tools/verify.mjs and the curious
      window.__magellan = {
        ready: true,
        world,
        camera,
        controls,
        sky,
        graphics: graphics.values,
        treeCount: forest.count,
      };
    }
  });
}

const nextFrame = () => new Promise((r) => requestAnimationFrame(r));

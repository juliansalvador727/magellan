// controls.js — pointer-lock look + WASD move. F toggles fly ↔ walk:
// fly moves along the view direction (Space/C for world up/down, scroll to
// change speed, Shift to boost); walk clamps to the ground at eye height.

import * as THREE from "three";

const EYE_M = 1.7;
const WALK_SPEED = 3.4;
const RUN_SPEED = 8.5;

export function createControls(camera, world, dom) {
  let yaw = 0;
  let pitch = 0;
  let fly = true;
  let flySpeed = 55;
  const keys = new Set();
  const vel = new THREE.Vector3();

  const spawn = world.manifest.spawn;
  jumpTo(spawn.x, spawn.y, spawn.z, spawn.headingDeg, -4);

  dom.addEventListener("click", () => {
    if (document.pointerLockElement !== dom) dom.requestPointerLock();
  });
  document.addEventListener("mousemove", (e) => {
    if (document.pointerLockElement !== dom) return;
    // Chromium under pointer lock occasionally reports one huge bogus delta
    // (right after locking, or on a dropped frame). No real swipe reaches
    // this in a single event, so drop it instead of flicking the camera.
    if (Math.abs(e.movementX) > 500 || Math.abs(e.movementY) > 500) {
      console.debug("ignored pointer-lock spike:", e.movementX, e.movementY);
      return;
    }
    yaw -= e.movementX * 0.0023;
    pitch = Math.max(-1.55, Math.min(1.55, pitch - e.movementY * 0.0023));
  });
  document.addEventListener("keydown", (e) => {
    if (e.code === "KeyF") toggleFly();
    keys.add(e.code);
  });
  document.addEventListener("keyup", (e) => keys.delete(e.code));
  window.addEventListener("blur", () => keys.clear());
  dom.addEventListener(
    "wheel",
    (e) => {
      flySpeed = Math.max(2, Math.min(500, flySpeed * Math.pow(1.15, -e.deltaY / 100)));
    },
    { passive: true },
  );

  function toggleFly() {
    fly = !fly;
    if (!fly) {
      camera.position.y = world.heightAt(camera.position.x, camera.position.z) + EYE_M;
      vel.set(0, 0, 0);
    }
  }

  function jumpTo(x, y, z, headingDeg = 0, pitchDeg = 0) {
    camera.position.set(x, y, z);
    yaw = (-headingDeg * Math.PI) / 180;
    pitch = (pitchDeg * Math.PI) / 180;
  }

  function update(dt) {
    camera.quaternion.setFromEuler(new THREE.Euler(pitch, yaw, 0, "YXZ"));

    const boost = keys.has("ShiftLeft") || keys.has("ShiftRight");
    const fwdIn = (keys.has("KeyW") ? 1 : 0) - (keys.has("KeyS") ? 1 : 0);
    const rightIn = (keys.has("KeyD") ? 1 : 0) - (keys.has("KeyA") ? 1 : 0);
    const upIn = (keys.has("Space") ? 1 : 0) - (keys.has("KeyC") ? 1 : 0);

    const wish = new THREE.Vector3();
    if (fly) {
      // move where you look
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
      wish.addScaledVector(fwd, fwdIn).addScaledVector(right, rightIn);
      wish.y += upIn;
      if (wish.lengthSq() > 0) wish.normalize();
      wish.multiplyScalar(flySpeed * (boost ? 4 : 1));
    } else {
      const fwd = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
      const right = new THREE.Vector3(-Math.sin(yaw - Math.PI / 2), 0, -Math.cos(yaw - Math.PI / 2));
      wish.addScaledVector(fwd, fwdIn).addScaledVector(right, rightIn);
      if (wish.lengthSq() > 0) wish.normalize();
      wish.multiplyScalar(boost ? RUN_SPEED : WALK_SPEED);
    }

    vel.lerp(wish, 1 - Math.exp(-dt * 9));
    camera.position.addScaledVector(vel, dt);

    const ground = world.heightAt(camera.position.x, camera.position.z);
    if (fly) {
      // don't fly through the ground
      camera.position.y = Math.max(camera.position.y, ground + 0.6);
    } else {
      camera.position.y = ground + EYE_M;
    }

    // keep inside the world (soft clamp to the baked extent)
    const W = world.manifest.extentMeters.width;
    const H = world.manifest.extentMeters.height;
    camera.position.x = Math.max(0, Math.min(W, camera.position.x));
    camera.position.z = Math.max(0, Math.min(H, camera.position.z));
  }

  return {
    update,
    jumpTo,
    get mode() {
      return fly ? "fly" : "walk";
    },
    get speed() {
      return fly ? flySpeed : WALK_SPEED;
    },
  };
}

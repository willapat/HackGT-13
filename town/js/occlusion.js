// See-through buildings: anything between the camera and a person fades out, then fades back.
import * as THREE from 'three';
import { activeCam, following } from './camera.js';
import { occluders } from './city.js';
import { friends } from './people.js';
import { windowMats } from './sky.js';

// Anything between the camera and a person fades to see-through, then fades back once it's clear.
// In follow mode only the followed person counts; in the overview, every friend does.

const FADED_OPACITY = 0.1;
const fadeState = new Map(); // occluder root -> current opacity
const occRay = new THREE.Raycaster();

// A faded building first writes only its depth, so just its nearest surface blends in. Without it,
// every wall, floor and pane behind the front one stacks up and glass columns read as solid bars.
const depthOnly = new THREE.MeshBasicMaterial({ colorWrite: false, transparent: true });
const noRaycast = () => {};
function setOpacity(root, a) {
  const faded = a < 0.999;
  const meshes = [];
  root.traverse((m) => { if (m.isMesh && !m.userData.depthPass) meshes.push(m); });
  for (const m of meshes) {
    if (!m.userData.ownMaterial) { // kit models share materials; buildings may carry [wall, lit window] pairs
      m.material = Array.isArray(m.material)
        ? m.material.map((x) => { const c = x.clone(); if (windowMats.has(x)) windowMats.add(c); return c; })
        : m.material.clone();
      m.userData.ownMaterial = true;
    }
    for (const mat of [m.material].flat()) {
      mat.opacity = a;
      mat.transparent = faded;
      mat.depthWrite = !faded;
    }
    if (faded && !m.userData.depth) {
      const d = new THREE.Mesh(m.geometry, depthOnly);
      Object.assign(d.userData, { depthPass: true });
      d.raycast = noRaycast; // occlusion rays must only hit the building itself
      d.renderOrder = 1; // after other see-through things (water, glows), before any faded building's color
      m.add(d);
      m.userData.depth = d;
    }
    if (m.userData.depth) m.userData.depth.visible = faded;
    m.renderOrder = faded ? 2 : 0;
  }
}

// Points on a person that must stay visible: feet, middle and head. Following one person, each is also sampled a
// little to either side (as seen from the camera) so a building covering any part of them fades; in the overview,
// with everyone checked, the center line is enough. Characters are about 0.55 tall and 0.25 wide.
const HEIGHTS = [0.05, 0.25, 0.48], SIDE = 0.13;
const ndc = new THREE.Vector2(), point = new THREE.Vector3(), right = new THREE.Vector3(), onScreen = new THREE.Vector3();
const backRay = new THREE.Raycaster(), back = new THREE.Vector3(), boxHit = new THREE.Vector3();
const CHECK_EVERY = 0.1; // seconds between checks; fading itself still animates every frame
let sinceCheck = CHECK_EVERY;
const hidden = new Set(); // occluder roots covering someone, as of the last check

// The town is static, so each occluder's world box is computed once. Rays test these cheap boxes first and
// only do the exact triangle test on the few they pass through: nothing fades unless its mesh really covers
// someone, which a box-only test would get wrong around corners.
const boxOf = (root) => (root.userData.box ??= new THREE.Box3().setFromObject(root));
function covering(raycaster, maxDist) {
  const ray = raycaster.ray, found = [];
  for (const root of occluders) {
    if (!ray.intersectBox(boxOf(root), boxHit) || ray.origin.distanceTo(boxHit) >= maxDist) continue;
    const h = raycaster.intersectObject(root, true)[0];
    if (h && h.distance < maxDist) found.push(h.object.userData.occluderRoot || root);
  }
  return found;
}

function checkOcclusion() {
  hidden.clear();
  right.setFromMatrixColumn(activeCam.matrixWorld, 0).setY(0).normalize();
  const sides = following ? [-SIDE, 0, SIDE] : [0];
  for (const f of following ? [following] : Object.values(friends)) {
    if (!f.obj.visible) continue;
    onScreen.copy(f.obj.position).project(activeCam); // skip people who aren't on screen
    if (!following && (onScreen.z > 1 || Math.abs(onScreen.x) > 1.1 || Math.abs(onScreen.y) > 1.1)) continue;
    for (const y of HEIGHTS) for (const s of sides) {
      point.copy(f.obj.position).setY(y).addScaledVector(right, s);
      const p = point.clone().project(activeCam);
      occRay.setFromCamera(ndc.set(p.x, p.y), activeCam);
      for (const root of covering(occRay, occRay.ray.origin.distanceTo(point) - 0.1)) hidden.add(root);
      // The follow camera can sit inside a building (or right against it). A ray starting inside only
      // meets the back of its walls, which rays can't hit, so also look from the person to the camera:
      // that ray meets the wall's outside.
      if (following) {
        backRay.set(point, back.subVectors(occRay.ray.origin, point).normalize());
        for (const root of covering(backRay, occRay.ray.origin.distanceTo(point))) hidden.add(root);
      }
    }
  }
}

export function updateOcclusion(dt) {
  sinceCheck += dt;
  if (sinceCheck >= CHECK_EVERY) { sinceCheck = 0; checkOcclusion(); }
  const k = 1 - Math.exp(-dt * 8);
  for (const root of new Set([...hidden, ...fadeState.keys()])) {
    const cur = fadeState.get(root) ?? 1;
    const next = cur + ((hidden.has(root) ? FADED_OPACITY : 1) - cur) * k;
    if (!hidden.has(root) && next > 0.99) { setOpacity(root, 1); fadeState.delete(root); continue; }
    setOpacity(root, next);
    fadeState.set(root, next);
  }
}

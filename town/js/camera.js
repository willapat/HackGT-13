// Camera focus and follow mode: auto-pan to a spot, click a person to follow them in third person.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { clickable } from './city.js';
import { $, logFeed } from './hud.js';
import { friends } from './people.js';
import { camera, controls, renderer } from './stage.js';

// Third-person camera used while following a friend
const followCam = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.05, 100);
addEventListener('resize', () => { followCam.aspect = innerWidth / innerHeight; followCam.updateProjectionMatrix(); });
export let following = null;
export let activeCam = camera;
const FOLLOW_BACK = 1.3, FOLLOW_UP = 0.75;
const FOLLOW_REST_MS = 2500; // after this long without input, the camera eases back behind the person
let lastFollowInput = 0;

let focusGoal = null;
// The opening view (stage.js has set it by now); Recenter eases back to it
const START = { target: controls.target.clone(), position: camera.position.clone(), zoom: camera.zoom };
let recentering = false;
controls.addEventListener('start', () => { focusGoal = null; recentering = false; }); // a drag always wins over an auto-pan
export function focusOn(p) { if (!following) focusGoal = p.clone().setY(0); }
export function focusFriend(id) {
  const f = friends[id];
  logFeed(`${f.name}: ${f.status}`);
  startFollow(f);
}

export function startFollow(f) {
  if (!following) {
    // Start from behind the friend so the camera doesn't swoop in from the city view
    followCam.position.copy(followOffset(f));
    followControls.target.copy(f.obj.position).setY(0.35);
  }
  following = f;
  activeCam = followCam;
  controls.enabled = false;
  followControls.enabled = true;
  lastFollowInput = 0;
  $('#follow-name').textContent = f.name;
  $('#follow').hidden = false;
}

function stopFollow() {
  if (!following) return;
  focusOn(following.obj.position);
  following = null;
  activeCam = camera;
  controls.enabled = true;
  followControls.enabled = false;
  $('#follow').hidden = true;
}
$('#follow-exit').onclick = stopFollow;

export function recenter() {
  stopFollow();
  focusGoal = null;
  recentering = true;
}
$('#recenter').onclick = recenter;

// While following: drag / one finger to orbit around the person, scroll / pinch to zoom
const followControls = new OrbitControls(followCam, renderer.domElement);
Object.assign(followControls, {
  enabled: false, enablePan: false, enableDamping: true,
  minDistance: 0.5, maxDistance: 6, minPolarAngle: 0.2, maxPolarAngle: 1.45,
});
followControls.addEventListener('start', () => { lastFollowInput = Infinity; });
followControls.addEventListener('end', () => { lastFollowInput = performance.now(); });
followControls.domElement.addEventListener('wheel', () => { if (following) lastFollowInput = performance.now(); });

// Click/tap a character to follow them (ignore drags, which pan the camera)
const raycaster = new THREE.Raycaster();
let downAt = null;
renderer.domElement.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; });
renderer.domElement.addEventListener('pointerup', (e) => {
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 6) return;
  const ndc = new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  raycaster.setFromCamera(ndc, activeCam);
  const targets = Object.values(friends).filter((f) => f.obj.visible).map((f) => f.obj);
  const hit = raycaster.intersectObjects(targets, true).find((h) => h.object.userData.friendId);
  if (hit) return focusFriend(hit.object.userData.friendId);
  // Otherwise a named building (a place or a friend's house) opens its card (buildings.js)
  for (let o = raycaster.intersectObjects(clickable, true)[0]?.object; o; o = o.parent) {
    if (o.userData.buildingId) return dispatchEvent(new CustomEvent('town:building', { detail: o.userData.buildingId }));
    if (o.userData.mailboxOf) return dispatchEvent(new CustomEvent('town:mailbox', { detail: o.userData.mailboxOf }));
  }
});
addEventListener('keydown', (e) => { if (e.key === 'Escape') stopFollow(); });

function followOffset(f) {
  const ry = f.obj.rotation.y;
  return f.obj.position.clone().add(new THREE.Vector3(-Math.sin(ry) * FOLLOW_BACK, FOLLOW_UP, -Math.cos(ry) * FOLLOW_BACK));
}

// Each frame: ease toward an auto-pan goal, or carry the follow camera along with the person
export function updateCamera(dt, now) {
  if (recentering) {
    const k = 1 - Math.exp(-dt * 6);
    controls.target.lerp(START.target, k);
    camera.position.lerp(START.position, k);
    camera.zoom += (START.zoom - camera.zoom) * k;
    if (camera.position.distanceTo(START.position) < 0.01 && Math.abs(camera.zoom - START.zoom) < 0.001) {
      controls.target.copy(START.target);
      camera.position.copy(START.position);
      camera.zoom = START.zoom;
      recentering = false;
    }
    camera.updateProjectionMatrix();
  }
  if (focusGoal) {
    const delta = focusGoal.clone().sub(controls.target).multiplyScalar(Math.min(1, dt * 4));
    controls.target.add(delta);
    camera.position.add(delta);
    if (focusGoal.distanceTo(controls.target) < 0.01) focusGoal = null;
  }
  if (following) {
    // Carry the camera along with the person, keeping whatever angle/zoom the viewer chose
    const head = following.obj.position.clone().setY(0.35);
    const delta = head.clone().sub(followControls.target);
    followControls.target.add(delta);
    followCam.position.add(delta);
    if (now - lastFollowInput > FOLLOW_REST_MS) {
      // Ease around to behind them (zoom and tilt stay as the viewer left them)
      const sph = new THREE.Spherical().setFromVector3(followCam.position.clone().sub(head));
      const ry = following.obj.rotation.y;
      const diff = Math.atan2(-Math.sin(ry), -Math.cos(ry)) - sph.theta;
      sph.theta += Math.atan2(Math.sin(diff), Math.cos(diff)) * (1 - Math.exp(-dt * 2));
      followCam.position.copy(head).add(new THREE.Vector3().setFromSpherical(sph));
    }
    followControls.update();
  } else {
    controls.update();
  }
}

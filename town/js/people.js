// Friends as characters: spawning them, their status and speech, and walking the streets (pathfinding).
import * as THREE from 'three';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { CH } from './assets.js';
import { focusFriend } from './camera.js';
import { findPath, walkable } from './city.js';
import { addLabel, logFeed } from './hud.js';
import { FRIENDS, inkOn, N, PLACES, pos } from './layout.js';
import { models } from './models.js';
import { sky } from './sky.js';
import { scene } from './stage.js';

export const friends = {};
export const eventOwned = new Set();
const WALK_SPEED = 0.9; // tiles per second when no travel_minutes is set
// One second of walking per backend travel minute (8 min → 8s). Town-clock walks use the real minutes.

export function spawnFriends() {
  FRIENDS.forEach((def, i) => {
    const gltf = models[`${CH}${def.model}.glb`];
    const obj = SkeletonUtils.clone(gltf.scene);
    obj.scale.setScalar(0.55);
    obj.traverse((m) => { if (m.isMesh) m.castShadow = true; });
    obj.position.copy(toWorld(sidewalkPoint(def.home)));
    scene.add(obj);

    // Colored ring at the feet so friends are easy to tell apart
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.13, 0.17, 32), new THREE.MeshBasicMaterial({ color: def.color }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.03;
    obj.add(ring);
    ring.scale.setScalar(1 / 0.55);

    // Invisible, slightly oversized hit area so small characters are easy to click/tap
    const hit = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 1.2, 12), new THREE.MeshBasicMaterial({ visible: false }));
    hit.position.y = 0.6;
    hit.userData.friendId = def.id;
    obj.add(hit);

    const mixer = new THREE.AnimationMixer(obj);
    const clip = (n) => mixer.clipAction(THREE.AnimationClip.findByName(gltf.animations, n));
    const f = {
      ...def, obj, mixer, off: { x: ((i % 3) - 1) * 0.15, z: (((i + 1) % 3) - 1) * 0.15 }, status: 'Just vibing', busy: false, path: [], resolveWalk: null,
      actions: { idle: clip('idle'), walk: clip('walk') }, current: null,
      nextThink: performance.now() + 1500 + i * 2500,
    };
    setAction(f, 'idle');
    const lbl = addLabel('lbl friend', def.name, () => obj.position.clone().setY(0.52));
    lbl.el.style.background = def.color;
    lbl.el.style.color = inkOn(def.color);
    lbl.el.onclick = () => focusFriend(f.id);
    f.label = lbl;
    friends[f.id] = f;
  });
}

function setAction(f, name) {
  const next = f.actions[name];
  if (f.current === next) return;
  next.reset().play();
  if (f.current) f.current.crossFadeTo(next, 0.25, false);
  f.current = next;
}

// Facing is snapped to the four compass directions (keeps the follow camera steady)
export function faceTowards(f, target) {
  const d = target.clone().sub(f.obj.position);
  f.obj.rotation.y = Math.round(Math.atan2(d.x, d.z) / (Math.PI / 2)) * (Math.PI / 2);
}

// ---- Walking ------------------------------------------------------------------------------------
// People walk along the roads (and through the park) tile by tile, then step onto the sidewalk
// outside the building they're visiting. Positions here are in fractional tile coordinates.

const CURB = 0.53; // standing spot outside a building: on the sidewalk strip next to the lot
const toTile = (p) => ({ x: p.x + N / 2 - 0.5, z: p.z + N / 2 - 0.5 });
const toWorld = (t) => pos(t.x, t.z);

// Where someone stands outside a building (shift slides them along the sidewalk)
function sidewalkPoint(a, shift = 0) {
  const dc = a.door[0] - a.c, dr = a.door[1] - a.r;
  return { x: a.c + dc * CURB - dr * shift, z: a.r + dr * CURB + dc * shift };
}

// Only move north/south/east/west: split any diagonal leg into a short sidestep, then the longer straight.
function axisAligned(from, route) {
  const out = [];
  let prev = from;
  for (const p of route) {
    const dx = Math.abs(p.x - prev.x), dz = Math.abs(p.z - prev.z);
    if (dx > 1e-3 && dz > 1e-3) out.push(dx < dz ? { x: p.x, z: prev.z } : { x: prev.x, z: p.z });
    out.push(p);
    prev = p;
  }
  return out;
}

export function walkTo(f, target, shift = 0, timing = null) {
  f.obj.visible = true;
  f.resolveWalk?.(false);
  const here = toTile(f.obj.position);
  const start = [Math.round(here.x), Math.round(here.z)];
  const tiles = (walkable(...start) && findPath(start, target.door)) || [];
  const route = [...tiles.map(([c, r]) => ({ x: c + f.off.x, z: r + f.off.z })), sidewalkPoint(target, shift)];
  f.walkFrom = f.obj.position.clone();
  f.route = axisAligned(here, route).map(toWorld);
  f.path = f.route.slice();
  f.travelMinutes = timing?.travelMinutes || null;
  f.departAt = timing?.departAt || null;
  f.walkStarted = performance.now();
  return new Promise((resolve) => { f.resolveWalk = resolve; });
}

function townMinutesNow() {
  if (!sky.y) return null;
  return Date.UTC(sky.y, sky.mo - 1, sky.d) / 60000 + sky.hour * 60;
}

function isoTownMinutes(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  // Postgres returns UTC. The town clock is Eastern (EDT in September), same offset as townWall.
  const et = new Date(t - 4 * 60 * 60 * 1000);
  return Date.UTC(et.getUTCFullYear(), et.getUTCMonth(), et.getUTCDate()) / 60000
    + et.getUTCHours() * 60 + et.getUTCMinutes() + et.getUTCSeconds() / 60;
}

// 0–1 along the path. depart_at is town time, so the slider hour places them on the route:
// 8:54 with a 8:50 departure and a 10 minute walk is 40% of the way, not already at the building.
function walkProgress(f) {
  if (!f.travelMinutes) return null;
  if (f.departAt) {
    const nowM = townMinutesNow();
    const startM = isoTownMinutes(f.departAt);
    if (nowM != null && startM != null) return Math.max(0, Math.min(1, (nowM - startM) / f.travelMinutes));
  }
  const ms = f.travelMinutes * 1000 * (sky.fast ? 120 / 1440 : 1);
  return Math.max(0, Math.min(1, (performance.now() - (f.walkStarted || 0)) / ms));
}

function routeLength(from, route) {
  let n = 0, p = from;
  for (const q of route) { n += p.distanceTo(q); p = q; }
  return n;
}

function pointAlong(from, route, t) {
  const total = routeLength(from, route);
  const last = route[route.length - 1] || from;
  if (total < 1e-6) return { pos: last.clone(), face: null, done: true };
  let d = total * Math.max(0, Math.min(1, t));
  let a = from;
  for (const b of route) {
    const len = a.distanceTo(b);
    if (d <= len) return { pos: a.clone().lerp(b, len ? d / len : 1), face: b, done: t >= 1 };
    d -= len;
    a = b;
  }
  return { pos: last.clone(), face: null, done: true };
}

function finishWalk(f, ok) {
  f.route = [];
  f.path = [];
  f.travelMinutes = null;
  f.departAt = null;
  setAction(f, 'idle');
  const res = f.resolveWalk;
  f.resolveWalk = null;
  res?.(ok);
}

export function stepFriend(f, dt) {
  const frac = walkProgress(f);
  if (frac != null && f.route?.length && f.walkFrom) {
    setAction(f, 'walk');
    const { pos, face, done } = pointAlong(f.walkFrom, f.route, frac);
    if (face) faceTowards(f, face);
    f.obj.position.copy(pos);
    if (done) finishWalk(f, true);
    return;
  }
  if (!f.path.length) return;
  setAction(f, 'walk');
  const target = f.path[0];
  const d = target.clone().sub(f.obj.position);
  const move = WALK_SPEED * dt;
  if (d.lengthSq() > 1e-6) faceTowards(f, target);
  if (d.length() <= move) {
    f.obj.position.copy(target);
    f.path.shift();
    if (!f.path.length) finishWalk(f, true);
  } else {
    f.obj.position.add(d.setLength(move));
  }
}

// Real towns: put a resident where their agents row says. A walk started at updated_at from (x, y), so
// fast-forward along the (deterministic) path by the time since then; every screen lands on the same spot.
const WALKING = new Set(['walk_to', 'visit', 'knock', 'go_home']);
function destinationOf(row) {
  const b = row.target?.building_id;
  if (!b) return null;
  if (!b.startsWith('house:')) return PLACES[b] ?? null;
  const id = b.slice(6);
  return friends[id]?.home ?? Object.values(friends).find((p) => p.userId === id)?.home ?? null;
}
function placeAlongWalk(f) {
  const frac = walkProgress(f);
  if (frac == null || !f.route?.length || !f.walkFrom) return;
  const { pos, face, done } = pointAlong(f.walkFrom, f.route, frac);
  if (face) faceTowards(f, face);
  f.obj.position.copy(pos);
  if (done) finishWalk(f, true);
}

export function placeAgent(f, row) {
  f.destId = row.target?.building_id || `house:${f.id}`; // for the building card: who's here / on the way
  const dest = destinationOf(row) || f.home;
  const walking = WALKING.has(row.action) && dest && row.target?.depart_at;
  interrupt(f);
  if (walking) {
    // x/y is the curb this trip leaves from (home, or the event they just finished) — not a leftover visit.
    if (row.x != null && row.y != null) f.obj.position.copy(toWorld({ x: row.x, z: row.y }));
    walkTo(f, dest, 0, { travelMinutes: row.target.travel_minutes || 8, departAt: row.target.depart_at });
    placeAlongWalk(f);
    return;
  }
  // Idle means the clock says they are already at this door. Stand there.
  if (dest) {
    f.obj.position.copy(toWorld(sidewalkPoint(dest)));
    setAction(f, 'idle');
  }
}

export function interrupt(f) {
  f.path = [];
  f.route = [];
  f.travelMinutes = null;
  f.departAt = null;
  f.resolveWalk?.(false);
  f.resolveWalk = null;
  f.busy = true;
  f.obj.visible = true;
  setAction(f, 'idle');
}

export function release(f, delay = 0) {
  setTimeout(() => {
    if (eventOwned.has(f.id)) return;
    f.busy = false;
    f.nextThink = performance.now() + 8000 + Math.random() * 12000;
  }, delay);
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export function say(f, text, ms = 2600) {
  f.bubble?.remove();
  const b = addLabel('bubble', text, () => f.obj.position.clone().setY(0.75));
  f.bubble = b;
  return wait(ms).then(() => { b.remove(); if (f.bubble === b) f.bubble = null; });
}

export async function meet(a, b, place) {
  const [okA, okB] = await Promise.all([walkTo(a, place, -0.16), walkTo(b, place, 0.16)]);
  if (okA && okB) { faceTowards(a, b.obj.position); faceTowards(b, a.obj.position); }
  return okA && okB;
}

// Scripted wander loop (stand-in for the character agents' fixed action menu)
export async function think(f) {
  f.busy = true;
  const roll = Math.random();
  const places = Object.values(PLACES);
  const idle = Object.values(friends).filter((o) => o !== f && !o.busy && !o.path.length);
  const any = (arr) => arr[Math.floor(Math.random() * arr.length)];

  if (roll < 0.2 && idle.length) {
    const o = any(idle);
    const p = any(places);
    o.busy = true;
    logFeed(`${f.name} and ${o.name} meet at ${p.name}.`);
    if (await meet(f, o, p)) {
      await say(f, '👋', 1600);
      await say(o, '👋 😄', 1600);
    }
    release(o, 500);
  } else if (roll < 0.35) {
    logFeed(`${f.name} heads home.`);
    if (await walkTo(f, f.home)) {
      f.obj.visible = false;
      await wait(15000);
    }
  } else if (roll < 0.85) {
    const p = any(places);
    logFeed(`${f.name} walks to ${p.name}.`);
    await walkTo(f, p);
  }
  release(f);
}

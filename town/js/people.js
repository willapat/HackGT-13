// Friends as characters: spawning them, their status and speech, and walking the streets (pathfinding).
import * as THREE from 'three';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { CH } from './assets.js';
import { focusFriend } from './camera.js';
import { findPath, walkable } from './city.js';
import { addLabel, logFeed } from './hud.js';
import { FRIENDS, inkOn, N, PLACES, pos } from './layout.js';
import { models } from './models.js';
import { townClockRunning, townMinutesNow } from './sky.js';
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

export function tileOf(f) {
  const t = toTile(f.obj.position);
  return { x: t.x, y: t.z };
}

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
  f.trailPlace = target;
  f.trailing = true;
  f.travelMinutes = timing?.travelMinutes || null;
  f.departAt = timing?.departAt || null;
  f.walkStarted = performance.now();
  return new Promise((resolve) => { f.resolveWalk = resolve; });
}

// Event and walk times in UTC minutes, the same scale as sky.js townMinutesNow, so positions are the same for
// every viewer whatever their time zone (and daylight saving can't shift them).
function isoTownMinutes(iso) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t / 60000 : null;
}

// Minutes still to walk, from the trip the character is already on. Null when that time isn't known.
export function minutesAway(f) {
  if (!f.path?.length) return null;
  if (f.travelMinutes) {
    const p = walkProgress(f);
    if (p != null && p < 1) return Math.max(1, Math.round(f.travelMinutes * (1 - p)));
  }
  const left = Number(f.minutesLeft);
  return left > 0 ? Math.round(left) : null;
}

// 0–1 along the path. depart_at is town time, so the server town clock (never the lighting slider) places them
// on the route: 8:54 with a 8:50 departure and a 10 minute walk is 40% of the way, not already at the building.
function walkProgress(f) {
  if (!f.travelMinutes) return null;
  // A paused town clock does not move calendar walks. A walk you started yourself still plays:
  // one real second per minute you typed, so "go now" is visible while the town clock is stopped.
  if (f.departAt && (townClockRunning() || !f.holdCalendar)) {
    const nowM = townMinutesNow();
    const startM = isoTownMinutes(f.departAt);
    if (nowM != null && startM != null) return Math.max(0, Math.min(1, (nowM - startM) / f.travelMinutes));
  }
  const ms = f.travelMinutes * 1000;
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
  f.trailing = false;
  f.trailPlace = null;
  f.route = [];
  f.path = [];
  f.travelMinutes = null;
  f.departAt = null;
  f.atDest = true;
  setAction(f, 'idle');
  const res = f.resolveWalk;
  f.resolveWalk = null;
  res?.(ok);
}

// Calendar walks follow the town clock, not the next agents-row write. Leave travel_minutes
// (from the event) before it starts, from wherever they are standing, and arrive as it begins.
const TRAVEL_DEFAULT = { cafe: 8, gym: 12, market: 10, library: 12, park: 10, downtown: 15 };

function travelMinutesOf(ev) {
  const n = Number(ev.travel_minutes);
  if (n > 0) return n;
  const b = ev.building_id || '';
  if (b.startsWith('house:') || (ev.place || '').toLowerCase() === 'home') return 6;
  if ((ev.place || '').toLowerCase() === 'campus') return 18;
  return TRAVEL_DEFAULT[b] || 12;
}

function placeFor(f, buildingId) {
  if (!buildingId) return null;
  if (!buildingId.startsWith('house:')) return PLACES[buildingId] || null;
  const id = buildingId.slice(6);
  if (id === f.userId || id === f.id) return f.home;
  return Object.values(friends).find((p) => p.userId === id || p.id === id)?.home || null;
}

export function setCalendars(rows) {
  const byUser = {}, byName = {};
  for (const ev of rows || []) {
    if (ev.user_id) (byUser[ev.user_id] ||= []).push(ev);
    if (ev.display_name) (byName[ev.display_name] ||= []).push(ev);
  }
  for (const f of Object.values(friends)) {
    const mine = (f.userId && byUser[f.userId]) || byUser[f.id] || byName[f.name] || null;
    if (!mine) continue;
    const blocks = mine.map((ev) => {
      const startM = isoTownMinutes(ev.start), endM = isoTownMinutes(ev.end);
      const place = placeFor(f, ev.building_id);
      if (startM == null || endM == null || !place?.door) return null;
      const travel = travelMinutesOf(ev);
      return { startM, endM, leaveM: startM - travel, travel, place, destId: ev.building_id };
    }).filter(Boolean).sort((a, b) => a.startM - b.startM);
    const sig = blocks.map((b) => `${b.destId}|${b.startM}|${b.endM}|${b.travel}`).join(';');
    if (f.calendarSig === sig) continue;
    f.calendarSig = sig;
    f.calendar = blocks;
    f.calKey = '';
  }
}

function segment(blocks, nowM, home) {
  const active = blocks.filter((b) => b.leaveM <= nowM && nowM < b.endM);
  if (active.length) {
    const b = active[active.length - 1];
    if (nowM < b.startM) return { phase: 'walk', place: b.place, destId: b.destId, depart: b.leaveM, travel: b.travel };
    return { phase: 'there', place: b.place, destId: b.destId };
  }
  const finished = blocks.filter((b) => b.endM <= nowM);
  if (!finished.length) return { phase: 'home', place: home, destId: 'home' };
  const last = finished[finished.length - 1];
  const next = blocks.find((b) => b.leaveM > nowM);
  const homeTravel = last.place === home ? 0 : last.travel;
  const arrive = last.endM + homeTravel;
  if (homeTravel && nowM < arrive && (!next || nowM < next.leaveM)) {
    return { phase: 'walk', place: home, destId: 'home', depart: last.endM, travel: homeTravel };
  }
  return { phase: 'home', place: home, destId: 'home' };
}

function doorWorld(place) {
  return toWorld(sidewalkPoint(place));
}

// Where the calendar has them at `at`, including partway along a walk. One level of
// recursion so a walk's start is the previous door, not an endless chain.
function standWorld(blocks, home, at, depth = 0) {
  const seg = segment(blocks, at, home);
  if (seg.phase !== 'walk' || depth > 0 || !seg.travel) return doorWorld(seg.place);
  const origin = standWorld(blocks, home, seg.depart - 0.02, depth + 1);
  const frac = Math.max(0, Math.min(1, (at - seg.depart) / seg.travel));
  const here = toTile(origin);
  const start = [Math.round(here.x), Math.round(here.z)];
  const tiles = (walkable(...start) && findPath(start, seg.place.door)) || [];
  const route = axisAligned(here, [...tiles.map(([c, r]) => ({ x: c, z: r })), sidewalkPoint(seg.place)]).map(toWorld);
  return route.length ? pointAlong(origin, route, frac).pos : doorWorld(seg.place);
}

function stepCalendar(f) {
  if (f.holdCalendar || !f.calendar?.length) return false;
  const nowM = townMinutesNow();
  if (nowM == null) return false;
  const seg = segment(f.calendar, nowM, f.home);
  f.busy = true;
  f.nextThink = Infinity;
  f.destId = seg.destId === 'home' ? `house:${f.id}` : seg.destId;
  if (seg.phase !== 'walk') {
    f.trailing = false;
    f.trailPlace = null;
    const key = `at:${seg.destId}`;
    if (f.calKey !== key) {
      f.calKey = key;
      f.route = [];
      f.path = [];
      f.departAt = null;
      f.travelMinutes = null;
      f.minutesLeft = null;
      f.obj.position.copy(doorWorld(seg.place));
      setAction(f, 'idle');
    }
    f.calMinute = nowM;
    return true;
  }
  const key = `walk:${seg.destId}:${Math.round(seg.depart)}`;
  const frac = Math.max(0, Math.min(1, (nowM - seg.depart) / seg.travel));
  if (f.calKey !== key) {
    const jumped = f.calMinute == null || Math.abs(nowM - f.calMinute) > 1.5;
    f.calKey = key;
    if (jumped) f.obj.position.copy(standWorld(f.calendar, f.home, seg.depart - 0.02));
    else {
      const where = seg.place === f.home ? 'home' : (seg.place.name || 'their next stop');
      logFeed(`${f.name} heads to ${where}.`);
    }
    walkTo(f, seg.place, 0, null);
    f.departAt = null;
  }
  f.trailPlace = seg.place;
  if (f.route?.length && f.walkFrom) {
    const { pos, face } = pointAlong(f.walkFrom, f.route, frac);
    if (face && frac < 1) faceTowards(f, face);
    f.obj.position.copy(pos);
    setAction(f, frac >= 1 ? 'idle' : 'walk');
  }
  f.trailing = frac < 1 && !!f.route?.length;
  f.minutesLeft = frac >= 1 ? null : Math.max(1, Math.round(seg.travel * (1 - frac)));
  f.calMinute = nowM;
  return true;
}

export function stepFriend(f, dt) {
  if (stepCalendar(f)) return;
  const frac = walkProgress(f);
  if (frac != null && f.route?.length && f.walkFrom) {
    const { pos, face } = pointAlong(f.walkFrom, f.route, frac);
    if (face && frac < 1) faceTowards(f, face);
    f.obj.position.copy(pos);
    if (frac >= 1) {
      f.trailing = false;
      f.trailPlace = null;
      f.path = [];
      setAction(f, 'idle');
      return;
    }
    setAction(f, 'walk');
    f.trailing = true;
    return;
  }
  if (!f.path.length) { f.trailing = false; return; }
  f.trailing = true;
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
  const { pos, face } = pointAlong(f.walkFrom, f.route, frac);
  if (face && frac < 1) faceTowards(f, face);
  f.obj.position.copy(pos);
}

function departMinute(iso) {
  return String(iso || '').slice(0, 16);
}

function nearTile(f, tile) {
  return f.obj.position.distanceTo(toWorld(tile)) < 1.5;
}

function onDoor(row, dest) {
  if (row.x == null || row.y == null || !dest?.door) return true;
  return Math.abs(row.x - dest.door[0]) < 0.3 && Math.abs(row.y - dest.door[1]) < 0.3;
}

export function placeAgent(f, row) {
  f.destId = row.target?.building_id || `house:${f.id}`; // for the building card: who's here / on the way
  f.holdCalendar = row.target?.by === 'user';
  // The clock paints calendar trips. A late agents row used to drop them on the door.
  if (f.calendar?.length && !f.holdCalendar) return;
  const dest = destinationOf(row) || f.home;
  const building = row.target?.building_id || '';
  const minute = departMinute(row.target?.depart_at);
  const walking = WALKING.has(row.action) && dest && row.target?.depart_at;
  // Idle at one building with x/y on another door is a row the calendar did not write.
  // Drawing its target is the teleport; stay put, or stand on x/y the first time.
  if (!walking && !onDoor(row, dest)) {
    if (!f.placedOnce && row.x != null && row.y != null) {
      interrupt(f);
      f.obj.position.copy(toWorld({ x: row.x, z: row.y }));
      f.placedOnce = true;
    }
    return;
  }
  f.placedOnce = true;
  // Same trip already on screen. Resetting it copies them back to the curb they left, which is the teleport.
  if (walking && f.tripBuilding === building && f.departMinute === minute && f.route?.length) return;
  // Already standing at this door. An idle row must not pick them up and drop them on the sidewalk again.
  if (!walking && f.tripBuilding === building && dest?.door && nearTile(f, sidewalkPoint(dest))) {
    setAction(f, 'idle');
    return;
  }
  interrupt(f);
  f.tripBuilding = building;
  f.departMinute = walking ? minute : '';
  f.atDest = !walking;
  if (walking) {
    // x/y is the curb this trip leaves from (home, or the event they just finished) — not a leftover visit.
    if (row.x != null && row.y != null) f.obj.position.copy(toWorld({ x: row.x, z: row.y }));
    walkTo(f, dest, 0, { travelMinutes: row.target.travel_minutes || 8, departAt: row.target.depart_at });
    if (row.target?.by === 'user') {
      const started = Date.parse(row.updated_at);
      if (Number.isFinite(started)) f.walkStarted = performance.now() - (Date.now() - started);
    }
    placeAlongWalk(f);
    return;
  }
  // Idle means the clock says they are already at this door. Stand there.
  if (dest?.door) {
    f.obj.position.copy(toWorld(sidewalkPoint(dest)));
    setAction(f, 'idle');
  }
}

export function interrupt(f) {
  f.trailing = false;
  f.trailPlace = null;
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

// How far `here` is along the polyline, in world units. Used to drop the part already walked.
function distanceAlong(from, route, here) {
  let traveled = 0, best = 0, bestD = Infinity, a = from;
  const p = here.clone().setY(0);
  for (const b of route) {
    const ab = b.clone().sub(a); ab.y = 0;
    const len2 = ab.lengthSq();
    const t = len2 < 1e-8 ? 0 : Math.max(0, Math.min(1, p.clone().sub(a).dot(ab) / len2));
    const d = a.clone().lerp(b, t).setY(0).distanceTo(p);
    const len = Math.sqrt(len2);
    if (d < bestD) { bestD = d; best = traveled + len * t; }
    traveled += len;
    a = b;
  }
  return best;
}

const TRAIL_WIDTH = 0.15; // a little thinner than the last ribbon
const TRAIL_Y = 0.09;
const CORNER = 0.62; // how far a turn eases back from the corner, in tiles
const ARROW_LEN = 0.4;
const ARROW_WIDTH = 0.3;

function routeLengthOf(from, route) {
  let n = 0, a = from;
  for (const b of route) { n += a.clone().setY(0).distanceTo(b.clone().setY(0)); a = b; }
  return n;
}

function pointOnRoute(from, route, dist) {
  let traveled = 0;
  let a = from.clone().setY(TRAIL_Y);
  for (const raw of route) {
    const b = raw.clone().setY(TRAIL_Y);
    const len = a.distanceTo(b);
    if (traveled + len >= dist - 1e-4) {
      return a.clone().lerp(b, len < 1e-6 ? 0 : (dist - traveled) / len);
    }
    traveled += len;
    a = b;
  }
  return a;
}

function spanRoute(from, route, s0, s1) {
  const y = (p) => p.clone().setY(TRAIL_Y);
  const pts = [pointOnRoute(from, route, s0)];
  let traveled = 0;
  let a = from;
  for (const raw of route) {
    const len = a.clone().setY(0).distanceTo(raw.clone().setY(0));
    const next = traveled + len;
    if (traveled > s0 + 1e-3 && traveled < s1 - 1e-3) pts.push(y(raw));
    traveled = next;
    a = raw;
    if (traveled >= s1) break;
  }
  pts.push(pointOnRoute(from, route, s1));
  return pts;
}

// Replace each right-angle corner with a quadratic bend so the stroke stays one piece.
function roundCorners(pts) {
  const y = (p) => p.clone().setY(TRAIL_Y);
  if (pts.length < 3) return pts.map(y);
  const out = [y(pts[0])];
  let prev = pts[0];
  for (let i = 1; i < pts.length - 1; i++) {
    const b = pts[i];
    const c = pts[i + 1];
    const into = b.clone().sub(prev);
    const outOf = c.clone().sub(b);
    into.y = outOf.y = 0;
    const lin = into.length();
    const lout = outOf.length();
    if (lin < 1e-3 || lout < 1e-3) continue;
    into.multiplyScalar(1 / lin);
    outOf.multiplyScalar(1 / lout);
    if (into.dot(outOf) > 0.98) {
      out.push(y(b));
      prev = b;
      continue;
    }
    const cut = Math.min(CORNER, lin * 0.46, lout * 0.46);
    const p0 = b.clone().addScaledVector(into, -cut).setY(TRAIL_Y);
    const p2 = b.clone().addScaledVector(outOf, cut).setY(TRAIL_Y);
    const ctrl = y(b);
    if (out[out.length - 1].distanceTo(p0) > 1e-3) out.push(p0);
    for (let s = 1; s <= 8; s++) {
      const t = s / 8, u = 1 - t;
      out.push(new THREE.Vector3(
        u * u * p0.x + 2 * u * t * ctrl.x + t * t * p2.x,
        TRAIL_Y,
        u * u * p0.z + 2 * u * t * ctrl.z + t * t * p2.z,
      ));
    }
    prev = p2;
  }
  const end = y(pts[pts.length - 1]);
  if (out[out.length - 1].distanceTo(end) > 1e-3) out.push(end);
  return out;
}

function ribbonGeometry(pts, endDir) {
  const positions = [];
  const indices = [];
  const half = TRAIL_WIDTH / 2;
  const side = [];
  for (let i = 0; i < pts.length; i++) {
    const prev = pts[Math.max(0, i - 1)];
    const next = pts[Math.min(pts.length - 1, i + 1)];
    const dir = next.clone().sub(prev);
    dir.y = 0;
    if (i === pts.length - 1 && endDir) dir.copy(endDir);
    if (dir.lengthSq() < 1e-8) dir.set(1, 0, 0);
    else dir.normalize();
    side.push(new THREE.Vector3(-dir.z, 0, dir.x).multiplyScalar(half));
  }
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], s = side[i];
    positions.push(p.x + s.x, p.y, p.z + s.z, p.x - s.x, p.y, p.z - s.z);
    if (i) {
      const a = (i - 1) * 2;
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  return geo;
}

// One still stroke in this person's color, from where they are to the door they're walking to.
// Hidden the rest of the time, including once the walk is over.
function hideTrail(f) {
  if (f.trail) f.trail.visible = false;
  if (f.trailArrow) f.trailArrow.visible = false;
}

// Shaft up to the arrow's base, then a triangle whose back edge is centered on that same point.
function strokeGeometry(pts) {
  const tip = pts[pts.length - 1].clone().setY(TRAIL_Y);
  let remain = ARROW_LEN;
  let base = pts[0].clone().setY(TRAIL_Y);
  const shaft = [];
  for (let i = pts.length - 1; i > 0; i--) {
    const a = pts[i - 1], b = pts[i];
    const len = a.distanceTo(b);
    if (len + 1e-6 >= remain) {
      const t = (len - remain) / Math.max(len, 1e-6);
      base = a.clone().lerp(b, Math.max(0, Math.min(1, t))).setY(TRAIL_Y);
      for (let j = 0; j < i; j++) shaft.push(pts[j].clone().setY(TRAIL_Y));
      if (!shaft.length || shaft[shaft.length - 1].distanceTo(base) > 1e-4) shaft.push(base);
      break;
    }
    remain -= len;
  }
  if (!shaft.length) shaft.push(base);
  const dir = tip.clone().sub(base);
  dir.y = 0;
  if (dir.lengthSq() < 1e-8) return new THREE.BufferGeometry();
  dir.normalize();
  const geo = shaft.length >= 2 ? ribbonGeometry(shaft, dir) : new THREE.BufferGeometry();
  const pos = geo.getAttribute('position');
  const positions = pos ? Array.from(pos.array) : [];
  const index = geo.getIndex();
  const indices = index ? Array.from(index.array) : [];
  const side = new THREE.Vector3(-dir.z, 0, dir.x).multiplyScalar(ARROW_WIDTH / 2);
  const left = base.clone().add(side);
  const right = base.clone().sub(side);
  const at = positions.length / 3;
  positions.push(tip.x, TRAIL_Y, tip.z, left.x, left.y, left.z, right.x, right.y, right.z);
  indices.push(at, at + 1, at + 2);
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  out.setIndex(indices);
  geo.dispose();
  return out;
}

// The line ahead of a walker, from where they are standing to the door they're going to.
// Rebuilt from the character (not from whoever clicked), so every screen draws the same path.
function trailAhead(f) {
  const place = f.trailPlace;
  if (!place?.door || !f.obj.visible) return null;
  const here = toTile(f.obj.position);
  const end = sidewalkPoint(place);
  if (Math.hypot(here.x - end.x, here.z - end.z) < 0.35) return null;
  const start = [Math.round(here.x), Math.round(here.z)];
  const tiles = (walkable(...start) && findPath(start, place.door)) || [];
  const pts = axisAligned(here, [...tiles.map(([c, r]) => ({ x: c, z: r })), end]);
  const from = f.obj.position.clone();
  const route = pts.map(toWorld);
  if (routeLength(from, route) < 0.2) return null;
  return { from, route };
}

export function syncTrail(f) {
  const ahead = trailAhead(f);
  if (!ahead) {
    hideTrail(f);
    return;
  }
  const { from, route } = ahead;
  const total = routeLengthOf(from, route);
  if (f.trailArrow) f.trailArrow.visible = false;
  if (!f.trail) {
    f.trail = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshBasicMaterial({
        color: f.color, transparent: true, opacity: 0.95, depthWrite: false, side: THREE.DoubleSide,
      }),
    );
    f.trail.frustumCulled = false;
    f.trail.renderOrder = 4;
    scene.add(f.trail);
  }
  const geo = strokeGeometry(roundCorners(spanRoute(from, route, 0, total)));
  if (!geo.getAttribute('position')?.count) {
    geo.dispose();
    if (f.trail) f.trail.visible = false;
    return;
  }
  const prev = f.trail.geometry;
  f.trail.geometry = geo;
  prev.dispose();
  f.trail.visible = true;
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

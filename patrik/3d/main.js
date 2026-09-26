// Tiny Town 3D sandbox: Three.js + SimplePoly City (town) and Kenney Mini Characters, orthographic "isometric" camera.
// Character behavior is scripted/random here; it stands in for the real character agents.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MapControls } from 'three/addons/controls/MapControls.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';

const N = 12;
const ROADS = [2, 6, 10];
const inPark = (c, r) => c >= 7 && c <= 9 && r >= 7 && r <= 9;
const isRoad = (c, r) => ROADS.includes(c) || ROADS.includes(r);
const IS_MOBILE = matchMedia('(pointer: coarse)').matches;

const SP = 'assets/simplepoly-city/';
const CH = 'assets/mini-characters/';
const sp = (name) => `${SP}${name}.glb`;
const colors = (name) => ['01', '02', '03'].map((n) => sp(`${name}-color${n}`));
const SKYSCRAPERS = [...colors('building-sky-big'), ...colors('building-sky-small'), ...colors('building-residential')];
const COMMERCIAL = ['bakery', 'bar', 'chicken-shop', 'clothing', 'drug-store', 'fast-food', 'fruits-shop', 'gift-shop',
  'music-store', 'pizza', 'restaurant', 'shoes-shop', 'gas-station'].map((n) => sp(`building-${n}`));
const HOUSES = ['01', '02', '03', '04'].flatMap((n) => colors(`building-house-${n}`));
const ROAD = { straight: sp('road-lane-01'), cross: sp('road-intersection-01') };
const GROUND = { grass: sp('natures-grass-tile'), paved: sp('road-concrete-tile') };
const PARK_TREES = [sp('natures-big-tree'), sp('natures-fir-tree'), sp('natures-cube-tree')];
const PROPS = { light: sp('props-street-light'), bench: sp('props-bench-1'), bush: sp('natures-bush-01'), pot: sp('natures-pot-bush-big') };

const PLACES = {
  library: { name: 'Library', model: sp('building-books-shop'), c: 3, r: 1, door: [3, 2] },
  gym: { name: 'Boulder Gym', model: sp('building-auto-service'), c: 5, r: 1, door: [5, 2] },
  cafe: { name: 'Bean There Café', model: sp('building-coffee-shop'), c: 7, r: 3, door: [6, 3] },
  market: { name: 'Market', model: sp('building-super-market'), c: 9, r: 5, door: [9, 6] },
  park: { name: 'Central Park', c: 8, r: 7, door: [8, 6] },
  downtown: { name: 'downtown', c: 7, r: 5, door: [7, 6] },
};

const FRIENDS = [
  { id: 'maya', name: 'Maya', color: '#f0616d', model: 'character-female-a', home: { model: sp('building-house-01-color01'), c: 1, r: 3, door: [2, 3] } },
  { id: 'jordan', name: 'Jordan', color: '#4f8ef7', model: 'character-male-b', home: { model: sp('building-house-02-color02'), c: 3, r: 5, door: [3, 6] } },
  { id: 'sam', name: 'Sam', color: '#2fb36d', model: 'character-male-d', home: { model: sp('building-house-03-color03'), c: 5, r: 7, door: [6, 7] } },
  { id: 'priya', name: 'Priya', color: '#f2a33a', model: 'character-female-c', home: { model: sp('building-house-04-color01'), c: 11, r: 7, door: [10, 7] } },
  { id: 'leo', name: 'Leo', color: '#9b6cf0', model: 'character-male-f', home: { model: sp('building-house-01-color03'), c: 1, r: 9, door: [2, 9] } },
];
const TREES = [[9, 7], [7, 9], [9, 9], [8, 7.3]];

const pos = (c, r) => new THREE.Vector3(c - N / 2 + 0.5, 0, r - N / 2 + 0.5);
const key = (c, r) => `${c},${r}`;

// ---- DOM helpers -------------------------------------------------------------

const $ = (s) => document.querySelector(s);

function logFeed(text) {
  const li = document.createElement('li');
  const t = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  li.innerHTML = `<time>${t}</time>`;
  li.append(text);
  $('#feed').prepend(li);
  while ($('#feed').children.length > 60) $('#feed').lastChild.remove();
}

function showCard({ kind, text, color, actions }) {
  const card = document.createElement('div');
  card.className = 'card panel';
  card.style.borderLeftColor = color;
  card.innerHTML = `<div class="kind"></div><div class="text"></div><div class="row"></div>`;
  card.querySelector('.kind').textContent = kind;
  card.querySelector('.text').textContent = text;
  actions.forEach(([label, fn, primary]) => {
    const b = document.createElement('button');
    b.textContent = label;
    if (primary) b.className = 'primary';
    b.onclick = () => { card.remove(); fn && fn(); };
    card.querySelector('.row').append(b);
  });
  $('#cards').append(card);
}

// Screen-space labels that follow 3D points
const labels = new Set();
function addLabel(className, text, getPos) {
  const el = document.createElement('div');
  el.className = className;
  el.textContent = text;
  $('#labels').append(el);
  const l = { el, getPos };
  labels.add(l);
  return { el, remove: () => { el.remove(); labels.delete(l); } };
}

// ---- Three.js setup ----------------------------------------------------------------

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
$('#game').append(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color('#9fd3ec');

const VIEW = 11; // world units visible vertically at zoom 1
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 200);
camera.position.set(14, 13, 14);
function fitCamera() {
  const aspect = innerWidth / innerHeight;
  const h = aspect < 1 ? VIEW / aspect * 0.75 : VIEW;
  camera.left = (-h * aspect) / 2; camera.right = (h * aspect) / 2;
  camera.top = h / 2; camera.bottom = -h / 2;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
}
fitCamera();
addEventListener('resize', fitCamera);

// Third-person camera used while following a friend
const followCam = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.05, 100);
addEventListener('resize', () => { followCam.aspect = innerWidth / innerHeight; followCam.updateProjectionMatrix(); });
let following = null;
let activeCam = camera;
const FOLLOW_BACK = 1.3, FOLLOW_UP = 0.75;

const controls = new MapControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.minZoom = 0.6;
controls.maxZoom = 5;
controls.minPolarAngle = 0.35;
controls.maxPolarAngle = 1.15;
controls.target.set(0, 0, 0);

scene.add(new THREE.HemisphereLight('#ffffff', '#8a9a7a', 1.6));
const sun = new THREE.DirectionalLight('#fff4e0', 2.2);
sun.position.set(-8, 14, 6);
sun.castShadow = true;
sun.shadow.mapSize.setScalar(IS_MOBILE ? 1024 : 2048);
Object.assign(sun.shadow.camera, { left: -10, right: 10, top: 10, bottom: -10, near: 1, far: 40 });
sun.shadow.bias = -0.0005;
scene.add(sun);

// Base plate under the city
const plate = new THREE.Mesh(new THREE.BoxGeometry(N + 0.4, 0.3, N + 0.4), new THREE.MeshLambertMaterial({ color: '#b98a5a' }));
plate.position.y = -0.151;
plate.receiveShadow = true;
scene.add(plate);

// ---- Model loading -----------------------------------------------------------------

const loader = new GLTFLoader();
const models = {};
async function loadAll(paths) {
  await Promise.all([...new Set(paths)].map(async (p) => { models[p] = await loader.loadAsync(p); }));
}

// SimplePoly models share one scale (a road tile is 20 units), so place them at that scale
// to keep houses, shops and towers in proportion. `fit` instead stretches a model to a footprint.
const SP_SCALE = 1 / 20;
function place(path, c, r, { fit, scale = 1, rotY = 0 } = {}) {
  const obj = models[path].scene.clone();
  const size = new THREE.Box3().setFromObject(obj).getSize(new THREE.Vector3());
  obj.scale.setScalar(fit ? fit / Math.max(size.x, size.z) : SP_SCALE * scale);
  obj.rotation.y = rotY;
  obj.position.copy(pos(c, r));
  obj.traverse((m) => { if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; } });
  scene.add(obj);
  return obj;
}

// Rotate a building so its front faces an adjacent road (models face +z).
function faceRoad(c, r) {
  for (const [dc, dr] of [[0, 1], [1, 0], [0, -1], [-1, 0]]) {
    if (isRoad(c + dc, r + dr) && c + dc >= 0 && r + dr >= 0 && c + dc < N && r + dr < N) return Math.atan2(dc, dr);
  }
  return 0;
}

// ---- Town -------------------------------------------------------------------------------

const blocked = new Set();
const topOf = {}; // building roof height by tile, for labels/effects

function buildCity() {
  const reserved = new Map();
  for (const p of Object.values(PLACES)) if (p.model) reserved.set(key(p.c, p.r), p.model);
  for (const f of FRIENDS) reserved.set(key(f.home.c, f.home.r), f.home.model);

  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      const onR = ROADS.includes(r), onC = ROADS.includes(c);
      if (onR && onC) { place(ROAD.cross, c, r); continue; }
      if (onR) { place(ROAD.straight, c, r, { rotY: Math.PI / 2 }); continue; } // model runs along z
      if (onC) { place(ROAD.straight, c, r); continue; }
      if (inPark(c, r)) { place(GROUND.grass, c, r); continue; }

      const dist = Math.hypot(c - 5.5, r - 5.5);
      const pick = (arr) => arr[(c * 7 + r * 13 + c * r) % arr.length];
      const model = reserved.get(key(c, r)) ||
        (dist < 3.2 ? pick(SKYSCRAPERS) : dist < 5.3 ? pick(COMMERCIAL) : pick(HOUSES));
      place(HOUSES.includes(model) ? GROUND.grass : GROUND.paved, c, r);
      const b = place(model, c, r, { scale: 0.92, rotY: faceRoad(c, r) });
      topOf[key(c, r)] = new THREE.Box3().setFromObject(b).max.y;
      blocked.add(key(c, r));
    }
  }

  TREES.forEach(([c, r], i) => {
    place(PARK_TREES[i % PARK_TREES.length], c, r, { scale: 2.6 });
    blocked.add(key(Math.round(c), Math.round(r)));
  });
  // Park furniture (decoration only; people can walk past it)
  place(PROPS.pot, 8, 8, { scale: 3 });
  place(PROPS.bench, 8, 7.6, { scale: 2, rotY: Math.PI });
  place(PROPS.bench, 8, 8.4, { scale: 2 });
  for (const [c, r] of [[7, 7], [8.9, 8.1], [8, 9]]) place(PROPS.bush, c, r, { scale: 2.6 });

  // Street lights on the corner of each crossing, arm reaching over the intersection
  for (const c of ROADS) for (const r of ROADS) place(PROPS.light, c + 0.42, r + 0.42, { scale: 1.8, rotY: -Math.PI / 4 });

  for (const p of Object.values(PLACES)) {
    if (!p.model) continue;
    const at = pos(p.c, p.r).setY(topOf[key(p.c, p.r)] + 0.15);
    addLabel('lbl place', p.name, () => at);
  }
}

const walkable = (c, r) => c >= 0 && r >= 0 && c < N && r < N && !blocked.has(key(c, r));

function findPath(from, to, roadsOnly = false) {
  const prev = new Map([[key(...from), null]]);
  const q = [from];
  while (q.length) {
    const [c, r] = q.shift();
    if (c === to[0] && r === to[1]) {
      const path = [];
      for (let k = key(c, r); k; k = prev.get(k)) path.unshift(k.split(',').map(Number));
      return path.slice(1);
    }
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const n = [c + dc, r + dr];
      if (!prev.has(key(...n)) && walkable(...n) && (!roadsOnly || isRoad(...n))) { prev.set(key(...n), key(c, r)); q.push(n); }
    }
  }
  return null;
}

// ---- Friends ------------------------------------------------------------------------------

const friends = {};
const eventOwned = new Set();
const WALK_SPEED = 0.65; // tiles per second: an unhurried stroll

function spawnFriends() {
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
    lbl.el.onclick = () => focusFriend(f.id);
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
function faceTowards(f, target) {
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

function walkTo(f, target, shift = 0) {
  f.obj.visible = true;
  f.resolveWalk?.(false);
  const here = toTile(f.obj.position);
  const start = [Math.round(here.x), Math.round(here.z)];
  const tiles = (walkable(...start) && findPath(start, target.door)) || [];
  const route = [...tiles.map(([c, r]) => ({ x: c + f.off.x, z: r + f.off.z })), sidewalkPoint(target, shift)];
  f.path = axisAligned(here, route).map(toWorld);
  return new Promise((resolve) => { f.resolveWalk = resolve; });
}

function stepFriend(f, dt) {
  if (!f.path.length) return;
  setAction(f, 'walk');
  const target = f.path[0];
  const d = target.clone().sub(f.obj.position);
  const move = WALK_SPEED * dt;
  if (d.lengthSq() > 1e-6) faceTowards(f, target);
  if (d.length() <= move) {
    f.obj.position.copy(target);
    f.path.shift();
    if (!f.path.length) {
      setAction(f, 'idle');
      const res = f.resolveWalk;
      f.resolveWalk = null;
      res?.(true);
    }
  } else {
    f.obj.position.add(d.setLength(move));
  }
}

function interrupt(f) {
  f.path = [];
  f.resolveWalk?.(false);
  f.resolveWalk = null;
  f.busy = true;
  f.obj.visible = true;
  setAction(f, 'idle');
}

function release(f, delay = 0) {
  setTimeout(() => {
    if (eventOwned.has(f.id)) return;
    f.busy = false;
    f.nextThink = performance.now() + 8000 + Math.random() * 12000;
  }, delay);
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function say(f, text, ms = 2600) {
  f.bubble?.remove();
  const b = addLabel('bubble', text, () => f.obj.position.clone().setY(0.75));
  f.bubble = b;
  return wait(ms).then(() => { b.remove(); if (f.bubble === b) f.bubble = null; });
}

async function meet(a, b, place) {
  const [okA, okB] = await Promise.all([walkTo(a, place, -0.16), walkTo(b, place, 0.16)]);
  if (okA && okB) { faceTowards(a, b.obj.position); faceTowards(b, a.obj.position); }
  return okA && okB;
}

// Scripted wander loop (stand-in for the character agents' fixed action menu)
async function think(f) {
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

// ---- Effects -----------------------------------------------------------------------------

const effects = {};
const animated = new Set();

function houseTop(home) { return pos(home.c, home.r).setY(topOf[key(home.c, home.r)]); }

function partyLights(home) {
  const top = houseTop(home);
  const group = new THREE.Group();
  const colors = ['#ff5d73', '#ffd23f', '#3ddc97', '#4fb3ff', '#c77dff'];
  const bulbs = [];
  for (let i = 0; i <= 10; i++) {
    const t = i / 10;
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.035, 8, 8), new THREE.MeshBasicMaterial({ color: colors[i % 5] }));
    m.position.set(top.x - 0.4 + 0.8 * t, top.y + 0.25 - Math.sin(t * Math.PI) * 0.1, top.z + 0.4 - 0.8 * t);
    group.add(m);
    bulbs.push(m);
  }
  const confetti = Array.from({ length: 70 }, (_, i) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(0.05, 0.03),
      new THREE.MeshBasicMaterial({ color: colors[i % 5], side: THREE.DoubleSide }));
    m.userData.v = new THREE.Vector3();
    m.userData.life = Math.random() * 1.6;
    group.add(m);
    return m;
  });
  scene.add(group);
  let t = 0;
  const fx = {
    update(dt) {
      t += dt;
      bulbs.forEach((b, i) => { b.visible = Math.sin(t * 6 + i * 1.7) > -0.3; });
      for (const m of confetti) {
        m.userData.life -= dt;
        if (m.userData.life <= 0) {
          m.position.copy(top).setY(top.y + 0.3);
          m.userData.v.set((Math.random() - 0.5) * 1.2, 1.2 + Math.random(), (Math.random() - 0.5) * 1.2);
          m.userData.life = 1.6;
        }
        m.userData.v.y -= 2.8 * dt;
        m.position.addScaledVector(m.userData.v, dt);
        m.rotation.x += dt * 5; m.rotation.y += dt * 4;
      }
    },
    destroy() { scene.remove(group); animated.delete(fx); },
  };
  animated.add(fx);
  focusOn(top);
  return fx;
}

function rainCloud(home) {
  const top = houseTop(home);
  const group = new THREE.Group();
  const grey = new THREE.MeshLambertMaterial({ color: '#8a94a6' });
  const cloud = new THREE.Group();
  [[-0.2, 0, 0, 0.16], [0, 0.07, 0, 0.2], [0.2, 0.02, 0.05, 0.15], [0.05, 0, 0.14, 0.15], [0, 0, -0.12, 0.14]]
    .forEach(([x, y, z, r]) => { const s = new THREE.Mesh(new THREE.SphereGeometry(r, 14, 10), grey); s.position.set(x, y, z); cloud.add(s); });
  cloud.position.copy(top).setY(top.y + 0.9);
  group.add(cloud);
  const dropMat = new THREE.MeshBasicMaterial({ color: '#8fc3ff' });
  const drops = Array.from({ length: 45 }, () => {
    const d = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.09, 0.01), dropMat);
    d.position.set(top.x + (Math.random() - 0.5) * 0.5, top.y + Math.random() * 0.8, top.z + (Math.random() - 0.5) * 0.4);
    group.add(d);
    return d;
  });
  scene.add(group);
  let t = 0;
  const fx = {
    update(dt) {
      t += dt;
      cloud.position.y = top.y + 0.9 + Math.sin(t * 1.5) * 0.04;
      for (const d of drops) {
        d.position.y -= 3 * dt;
        if (d.position.y < top.y) d.position.y = top.y + 0.8;
      }
    },
    destroy() { scene.remove(group); animated.delete(fx); },
  };
  animated.add(fx);
  focusOn(top);
  return fx;
}

// ---- Demo signal triggers ---------------------------------------------------------------------

function claim(...ids) { return ids.map((id) => { eventOwned.add(id); interrupt(friends[id]); return friends[id]; }); }
function unclaim(...ids) { ids.forEach((id) => { eventOwned.delete(id); release(friends[id]); }); }
function setStatus(id, status) { friends[id].status = status; renderResidents(); }

async function trigger(name) {
  if (name === 'reset') return resetTown();
  if (effects[name]) return;

  if (name === 'goodNews') {
    setStatus('maya', 'Landed the internship 🎉');
    logFeed('📰 Town brain: Maya shared good news (landed the internship).');
    effects.goodNews = partyLights(FRIENDS[0].home);
    const [maya, leo, sam] = claim('maya', 'leo', 'sam');
    await walkTo(maya, maya.home);
    say(maya, '🎉🎉🎉', 3000);
    await Promise.all([walkTo(leo, maya.home, 0.3), walkTo(sam, maya.home, -0.3)]);
    faceTowards(leo, maya.obj.position); faceTowards(sam, maya.obj.position); faceTowards(maya, leo.obj.position);
    await say(leo, 'Congrats Maya!!', 2000);
    await say(sam, 'Huge news 🥳', 2000);
    showCard({
      kind: 'Good news', color: '#f0616d',
      text: 'Maya landed the internship. Want to celebrate with her in real life?',
      actions: [
        ['Plan a celebration dinner', () => logFeed('✅ You approved a celebration plan. An action agent would check calendars and draft invites next (not built yet).'), true],
        ['Draft a congrats text', () => logFeed('✍️ Drafted a congrats message for you to review. Nothing is sent without you.')],
        ['Dismiss'],
      ],
    });
    unclaim('maya', 'leo', 'sam');
  }

  if (name === 'climbing') {
    setStatus('sam', 'Wants to try climbing 🧗');
    setStatus('priya', 'Wants to try climbing 🧗');
    logFeed('🔗 Town brain: Sam and Priya both mentioned wanting to try climbing.');
    effects.climbing = { destroy() {} };
    const [sam, priya] = claim('sam', 'priya');
    focusOn(pos(...PLACES.gym.door));
    if (await meet(sam, priya, PLACES.gym)) {
      await say(sam, 'Wait, you want to try climbing too?', 2400);
      await say(priya, 'Yes! Been meaning to for ages 🧗', 2400);
    }
    showCard({
      kind: 'Quest', color: '#2fb36d',
      text: 'Sam and Priya both want to try climbing. Suggest a beginner session at Boulder Gym this Saturday?',
      actions: [
        ['Suggest to both', () => logFeed('✅ Suggestion queued. Sam and Priya each approve before anything is sent.'), true],
        ['Not now'],
      ],
    });
    unclaim('sam', 'priya');
  }

  if (name === 'roughWeek') {
    setStatus('jordan', 'Having a rough week');
    logFeed('🌧️ Town brain: Jordan shared that this week has been rough.');
    effects.roughWeek = rainCloud(FRIENDS[1].home);
    const [jordan] = claim('jordan');
    if (await walkTo(jordan, jordan.home)) jordan.obj.visible = false;
    showCard({
      kind: 'Check in', color: '#4f8ef7',
      text: "Jordan's having a rough week. A quick message or a coffee could mean a lot.",
      actions: [
        ['Draft a check-in', () => logFeed('✍️ Drafted a check-in for Jordan for you to review. Nothing is sent without you.'), true],
        ['Invite for coffee', () => logFeed('☕ Coffee invite drafted for your approval.')],
        ['Later'],
      ],
    });
    // Jordan stays home (claimed) until reset.
  }
}

function resetTown() {
  for (const k of Object.keys(effects)) { effects[k].destroy(); delete effects[k]; }
  $('#cards').innerHTML = '';
  for (const f of Object.values(friends)) {
    f.status = 'Just vibing';
    eventOwned.delete(f.id);
    f.obj.visible = true;
    if (f.busy && !f.path.length) release(f);
  }
  renderResidents();
  logFeed('↺ Town reset.');
}

// ---- Camera focus & UI -------------------------------------------------------------------------

let focusGoal = null;
function focusOn(p) { if (!following) focusGoal = p.clone().setY(0); }
function focusFriend(id) {
  const f = friends[id];
  logFeed(`${f.name}: ${f.status}`);
  startFollow(f);
}

function startFollow(f) {
  if (!following) {
    // Start from behind the friend so the camera doesn't swoop in from the city view
    followCam.position.copy(followOffset(f));
  }
  following = f;
  activeCam = followCam;
  controls.enabled = false;
  $('#follow-name').textContent = f.name;
  $('#follow').hidden = false;
}

function stopFollow() {
  if (!following) return;
  focusOn(following.obj.position);
  following = null;
  activeCam = camera;
  controls.enabled = true;
  $('#follow').hidden = true;
}
$('#follow-exit').onclick = stopFollow;

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
  if (hit) focusFriend(hit.object.userData.friendId);
});
addEventListener('keydown', (e) => { if (e.key === 'Escape') stopFollow(); });

function followOffset(f) {
  const ry = f.obj.rotation.y;
  return f.obj.position.clone().add(new THREE.Vector3(-Math.sin(ry) * FOLLOW_BACK, FOLLOW_UP, -Math.cos(ry) * FOLLOW_BACK));
}

function renderResidents() {
  const ul = $('#residents');
  ul.innerHTML = '';
  for (const f of Object.values(friends)) {
    const li = document.createElement('li');
    li.style.cursor = 'pointer';
    li.innerHTML = `<span class="dot" style="background:${f.color}"></span><div><b></b><div class="status"></div></div>`;
    li.querySelector('b').textContent = f.name;
    li.querySelector('.status').textContent = f.status;
    li.onclick = () => focusFriend(f.id);
    ul.append(li);
  }
}

// ---- Main loop -------------------------------------------------------------------------------

const clock = new THREE.Clock();
const v = new THREE.Vector3();
function frame() {
  const dt = Math.min(clock.getDelta(), 0.1);
  const now = performance.now();
  for (const f of Object.values(friends)) {
    stepFriend(f, dt);
    f.mixer.update(dt);
    if (!f.busy && !f.path.length && now > f.nextThink) think(f);
  }
  for (const fx of animated) fx.update(dt);

  if (focusGoal) {
    const delta = focusGoal.clone().sub(controls.target).multiplyScalar(Math.min(1, dt * 4));
    controls.target.add(delta);
    camera.position.add(delta);
    if (focusGoal.distanceTo(controls.target) < 0.01) focusGoal = null;
  }
  if (following) {
    followCam.position.lerp(followOffset(following), 1 - Math.exp(-dt * 3));
    followCam.lookAt(following.obj.position.clone().setY(0.35));
  } else {
    controls.update();
  }
  renderer.render(scene, activeCam);

  for (const l of labels) {
    v.copy(l.getPos()).project(activeCam);
    const hidden = v.z > 1 || (l.el.classList.contains('friend') && !friendVisible(l));
    l.el.style.display = hidden ? 'none' : '';
    l.el.style.left = `${(v.x * 0.5 + 0.5) * innerWidth}px`;
    l.el.style.top = `${(-v.y * 0.5 + 0.5) * innerHeight}px`;
  }
  requestAnimationFrame(frame);
}
const friendVisible = (l) => Object.values(friends).find((f) => l.el.textContent === f.name)?.obj.visible ?? true;

// ---- Boot ----------------------------------------------------------------------------------------

const allModels = [
  ...SKYSCRAPERS, ...COMMERCIAL, ...HOUSES,
  ...Object.values(PLACES).filter((p) => p.model).map((p) => p.model),
  ...FRIENDS.map((f) => `${CH}${f.model}.glb`), ...FRIENDS.map((f) => f.home.model),
  ...Object.values(ROAD), ...Object.values(GROUND), ...PARK_TREES, ...Object.values(PROPS),
];
logFeed('Loading city…');
await loadAll(allModels);
buildCity();
spawnFriends();
renderResidents();
logFeed('Town loaded. Residents are wandering (scripted, not agent-driven).');
document.querySelectorAll('[data-trigger]').forEach((b) => { b.onclick = () => trigger(b.dataset.trigger); });
const params = new URLSearchParams(location.search);
if (friends[params.get('follow')]) startFollow(friends[params.get('follow')]);
const auto = params.get('auto');
auto?.split(',').forEach((t, i) => setTimeout(() => trigger(t), 1500 + i * 2500));
frame();

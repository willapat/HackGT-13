// Tiny Town 3D sandbox: Three.js + SimplePoly City (roads, greenery, buildings), Kenney City Kit buildings and Mini Characters, orthographic "isometric" camera.
// Character behavior is scripted/random here; it stands in for the real character agents.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MapControls } from 'three/addons/controls/MapControls.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';

const N = 17;
const ROADS = [2, 6, 10, 14];
const CENTER = 8; // the park sits at the middle of the grid; the skyline rings it
const inPark = (c, r) => c >= 7 && c <= 9 && r >= 7 && r <= 9;
const isRoad = (c, r) => ROADS.includes(c) || ROADS.includes(r);
const IS_MOBILE = matchMedia('(pointer: coarse)').matches;

const SP = 'assets/simplepoly-city/';
const COM = 'assets/city-kit-commercial/';
const SUB = 'assets/city-kit-suburban/';
const CH = 'assets/mini-characters/';
const CP = 'assets/city-props/'; // Coding Creature City Props 1 (CC0), modeled in meters
const cp = (name) => `${CP}${name}.glb`;
const kenney = (dir, prefix, ids) => ids.split('').map((l) => `${dir}${prefix}${l}.glb`);
const sp = (name) => `${SP}${name}.glb`;
const colors = (name) => ['01', '02', '03'].map((n) => sp(`${name}-color${n}`));
const shops = (...names) => names.map((n) => sp(`building-${n}`));
const HOUSES = [...['01', '02', '03', '04'].flatMap((n) => colors(`building-house-${n}`)), ...kenney(SUB, 'building-type-', 'abcdefghijklmnopqrstu')];
// City zones by distance from the central park, tallest in the middle, mixing both packs.
// Only Kenney skyscrapers form the core. Kenney buildings (sorted into zones by their real
// height) keep their proportions; `height` stretches SimplePoly models (min-max, varied per lot,
// capped at 2x) since that pack tops out at ~1.2 tiles.
const ZONES = [
  { upTo: 3.4, height: [1.8, 2], models: kenney(COM, 'building-skyscraper-', 'abcde').concat(kenney(COM, 'building-', 'm')) },
  { upTo: 4.6, height: [1.5, 2], models: [...colors('building-sky-big'), ...colors('building-sky-small'), ...kenney(COM, 'building-', 'gfl')] },
  { upTo: 5.9, height: [1.1, 1.4], models: [...colors('building-residential'), ...shops('restaurant', 'clothing', 'fast-food', 'drug-store', 'pizza', 'music-store'), ...kenney(COM, 'building-', 'abdhi')] },
  { upTo: 7.3, height: [1, 1.15], models: [...shops('bakery', 'bar', 'chicken-shop', 'fruits-shop', 'gift-shop', 'shoes-shop', 'gas-station', 'factory'), ...kenney(COM, 'building-', 'cejkn')] },
  { upTo: Infinity, height: [1, 1], models: HOUSES },
];
// Interleave the packs within each zone so neighbors alternate styles
for (const z of ZONES) {
  const [a, b] = [z.models.filter((m) => m.startsWith(SP)), z.models.filter((m) => !m.startsWith(SP))];
  if (!a.length || !b.length) continue;
  z.models = Array.from({ length: Math.max(a.length, b.length) * 2 }, (_, i) => (i % 2 ? b : a)[Math.floor(i / 2) % (i % 2 ? b : a).length]);
}
const ROAD = { straight: sp('road-lane-01'), cross: sp('road-intersection-01') };
const GROUND = { grass: sp('natures-grass-tile'), paved: sp('road-concrete-tile') };
const PARK_TREES = [sp('natures-big-tree'), sp('natures-fir-tree'), sp('natures-cube-tree')];
const PROPS = Object.fromEntries(['street-light', 'bench-1', 'bench-2', 'traffic-signal-big', 'traffic-signal-small', 'traffic-sign-stop',
  'traffic-sign-speed-limit', 'traffic-cone', 'traffic-control-barrier-fence', 'hydrant', 'dustbin', 'bus-stop', 'coffee-shop-chair',
  'windmill', 'fence', 'billboard-small', 'billboard-medium', 'billboard-large'].map((n) => [n, sp(`props-${n}`)]));
const NATURE = Object.fromEntries(['bush-01', 'bush-02', 'bush-03', 'pot-bush-big', 'pot-bush-small', 'rock-big', 'rock-small', 'grass-fence', 'grass-bar']
  .map((n) => [n, sp(`natures-${n}`)]));
const ROOF_PROPS = ['antenna', 'solar-panel', 'prop-air', 'prop'].map((n) => sp(`props-roof-${n}`));
const HELIPAD = sp('props-roof-helipad');
const VEHICLES = [...colors('vehicle-car'), sp('vehicle-taxi'), ...colors('vehicle-suv'), sp('vehicle-police-car'), ...colors('vehicle-pick-up-truck'),
  ...colors('vehicle-bus'), sp('vehicle-ambulance'), ...colors('vehicle-truck'), ...colors('vehicle-container')];
const STREET = Object.fromEntries(['trash_bin_c', 'trash_bin_c_green', 'trash_bin_c_blue', 'metal_garbage_can_01_medium', 'garbage_collector_green_medium',
  'garbage_collector_blue_medium', 'payphone_stand', 'drop_box_01', 'traffic_bollard_01_metal_medium', 'fire_hydrant_01', 'barrel_02_medium_blue',
  'barrel_02_medium_red', 'pallet_medium_01', 'concrete_jersey_barrier_01_medium', 'type_ii_barricade_01_medium', 'cone_i_medium', 'mailbox_01_white',
  'public_bench_01', 'drinking_fountain_01', 'pedestrian_traffic_light_02_base_medium_black', 'cctv_camera_01_base'].map((n) => [n, cp(n)]));
const METER = 2.8; // `scale` that puts a meters-sized City Props model next to SimplePoly props
const CURBSIDE = ['trash_bin_c', 'payphone_stand', 'garbage_collector_green_medium', 'trash_bin_c_green', 'drop_box_01',
  'traffic_bollard_01_metal_medium', 'metal_garbage_can_01_medium', 'garbage_collector_blue_medium', 'trash_bin_c_blue', 'fire_hydrant_01'];

// Grid blocks between the roads: cols/rows 0-1, 3-5, 7-9, 11-13, 15-16
const block = (c0, c1, r0, r1) => { const t = []; for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) t.push([c, r]); return t; };
const STADIUM = { model: sp('building-stadium'), tiles: block(11, 13, 11, 13) }; // a full 3x3 city block
const FARM = { tiles: block(0, 1, 15, 16) };
const RIVER = { band: 4, width: 1, amp: 0.75 }; // a winding river through a green belt in front (+z) of the city

const PLACES = {
  library: { name: 'Library', model: sp('building-books-shop'), c: 3, r: 1, door: [3, 2] },
  gym: { name: 'Boulder Gym', model: sp('building-auto-service'), c: 5, r: 1, door: [5, 2] },
  cafe: { name: 'Bean There Café', model: sp('building-coffee-shop'), c: 7, r: 3, door: [6, 3] },
  market: { name: 'Market', model: sp('building-super-market'), c: 9, r: 5, door: [9, 6] },
  park: { name: 'Central Park', c: 8, r: 7, door: [8, 6] },
  downtown: { name: 'downtown', c: 7, r: 5, door: [7, 6] },
};

// Each friend owns a whole outer block. Their house sits back from the street on `house`, with a
// driveway on `c,r` leading to the road at `door` (where people stand when visiting). Colors are
// picked to stand out from the scenery (no greens, blues, greys or browns).
const FRIENDS = [
  { id: 'maya', name: 'Maya', color: '#ff3b30', model: 'character-female-a', block: block(0, 1, 3, 5), home: { model: sp('building-house-01-color01'), house: [0, 4], c: 1, r: 4, door: [2, 4] } },
  { id: 'jordan', name: 'Jordan', color: '#ff2d95', model: 'character-male-b', block: block(11, 13, 0, 1), home: { model: `${SUB}building-type-k.glb`, house: [12, 0], c: 12, r: 1, door: [12, 2] } },
  { id: 'sam', name: 'Sam', color: '#ffd60a', model: 'character-male-d', block: block(3, 5, 15, 16), home: { model: sp('building-house-03-color01'), house: [4, 16], c: 4, r: 15, door: [4, 14] } },
  { id: 'priya', name: 'Priya', color: '#ff9500', model: 'character-female-c', block: block(15, 16, 7, 9), home: { model: `${SUB}building-type-r.glb`, house: [16, 8], c: 15, r: 8, door: [14, 8] } },
  { id: 'leo', name: 'Leo', color: '#a24bff', model: 'character-male-f', block: block(0, 1, 11, 13), home: { model: sp('building-house-02-color01'), house: [0, 12], c: 1, r: 12, door: [2, 12] } },
];
// Dark text on light friend colors (yellow, orange), white on the rest
const inkOn = (hex) => { const c = new THREE.Color(hex); return c.r * 0.3 + c.g * 0.59 + c.b * 0.11 > 0.6 ? '#1f2430' : '#fff'; };
const TREES = [[7, 7], [9, 7], [7, 9], [9, 9]];

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

const VIEW = 17; // world units visible vertically at zoom 1
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
controls.target.set(0, 0, RIVER.band / 2); // center on the city plus the river belt in front
camera.position.z += RIVER.band / 2;

scene.add(new THREE.HemisphereLight('#ffffff', '#8a9a7a', 1.6));
const sun = new THREE.DirectionalLight('#fff4e0', 2.2);
sun.position.set(-8, 14, 6);
sun.castShadow = true;
sun.shadow.mapSize.setScalar(IS_MOBILE ? 1024 : 2048);
Object.assign(sun.shadow.camera, { left: -15, right: 15, top: 15, bottom: -15, near: 1, far: 60 });
sun.shadow.bias = -0.0005;
scene.add(sun);

// Base plate under the city, plus the green belt (sitting a hair lower, so tiles on it never z-fight)
const slab = (w, d, top, z) => {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.3, d), new THREE.MeshLambertMaterial({ color: '#b98a5a' }));
  m.position.set(0, top - 0.151, z);
  m.receiveShadow = true;
  scene.add(m);
};
slab(N + 0.4, N + 0.2, 0, -0.1);
slab(N + 0.4, RIVER.band + 0.2, -0.01, N / 2 + (RIVER.band + 0.2) / 2);

// River centerline (world z) at world x, and the matching tile row
const riverZ = (x) => N / 2 + RIVER.band / 2 + Math.sin(x * 0.42 + 0.6) * RIVER.amp + Math.sin(x * 0.9) * RIVER.amp * 0.3;

// A strip following the river's curve, `width` wide, as flat XZ geometry at height y
function riverStrip(width, y) {
  const xs = 90, across = 4, pos = [], idx = [];
  for (let i = 0; i <= xs; i++) {
    const x = -N / 2 - 0.2 + ((N + 0.4) * i) / xs;
    const dz = (riverZ(x + 0.01) - riverZ(x - 0.01)) / 0.02; // tangent slope -> normal for even width
    const len = Math.hypot(1, dz);
    for (let j = 0; j <= across; j++) {
      const o = (j / across - 0.5) * width;
      pos.push(x - (dz / len) * o, y, riverZ(x) + o / len);
    }
  }
  for (let i = 0; i < xs; i++) for (let j = 0; j < across; j++) {
    const a = i * (across + 1) + j, b = a + across + 1;
    idx.push(a, a + 1, b, b, a + 1, b + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// Animated low-poly water (river + park pond): vertices bob gently, staying under bridge decks
function water(geometry) {
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
    color: '#3fa7d6', roughness: 0.25, metalness: 0.1, flatShading: true, transparent: true, opacity: 0.92,
  }));
  scene.add(mesh); // no shadows on the moving surface: they shimmer
  const attr = geometry.attributes.position;
  const base = Float32Array.from(attr.array);
  let t = 0;
  animated.add({ update(dt) {
    t += dt;
    for (let i = 0; i < attr.count; i++) {
      const x = base[i * 3], z = base[i * 3 + 2];
      attr.array[i * 3 + 1] = base[i * 3 + 1] + Math.sin(x * 5 + t * 1.6) * 0.004 + Math.cos(z * 7 - t * 1.2) * 0.003;
    }
    attr.needsUpdate = true;
  } });
  return mesh;
}

// ---- Model loading -----------------------------------------------------------------

const loader = new GLTFLoader();
const models = {};
async function loadAll(paths) {
  await Promise.all([...new Set(paths)].map(async (p) => { models[p] = await loader.loadAsync(p); }));
}

// SimplePoly models share one scale (a road tile is 20 units), so place them at that scale
// to keep houses, shops and towers in proportion. `fit` instead stretches a model to a footprint.
const SP_SCALE = 1 / 20;
function place(path, c, r, { fit, scale = 1, height = 1, rotY = 0 } = {}) {
  const obj = models[path].scene.clone();
  const size = new THREE.Box3().setFromObject(obj).getSize(new THREE.Vector3());
  obj.scale.setScalar(fit ? fit / Math.max(size.x, size.z) : SP_SCALE * scale);
  obj.scale.y *= height;
  obj.rotation.y = rotY;
  obj.position.copy(pos(c, r));
  const flat = Object.values(ROAD).includes(path) || Object.values(GROUND).includes(path);
  obj.traverse((m) => { if (m.isMesh) { m.castShadow = !flat; m.receiveShadow = true; } });
  scene.add(obj);
  return obj;
}

// Buildings only go on lots that touch a road, and face it (models face +z). Corner lots pick
// one of their two roads by position so a block's corners don't all turn the same way.
const roadSides = (c, r) => [[0, 1], [1, 0], [0, -1], [-1, 0]].filter(([dc, dr]) => {
  const [x, y] = [c + dc, r + dr];
  return x >= 0 && y >= 0 && x < N && y < N && isRoad(x, y);
});
function faceRoad(c, r) {
  const sides = roadSides(c, r);
  if (!sides.length) return null;
  const [dc, dr] = sides[(c + r) % sides.length];
  return Math.atan2(dc, dr);
}

// ---- Town -------------------------------------------------------------------------------

const blocked = new Set();
const topOf = {}; // building roof height by tile, for labels/effects

// Give a placed model its own materials, tinted toward `color` (textures multiply by it)
function tint(obj, color, amount) {
  const c = new THREE.Color(color);
  obj.traverse((m) => { if (m.isMesh) { m.material = m.material.clone(); m.material.color.lerp(c, amount); } });
  return obj;
}

// Repaint a model fully in `color`, keeping its detail: the texture goes grayscale (lightened),
// then the material color paints it. Used for friends' houses and cars so they read as theirs.
const grayCache = new Map();
function grayTexture(tex) {
  if (!grayCache.has(tex)) {
    const img = tex.image;
    const cv = Object.assign(document.createElement('canvas'), { width: img.width, height: img.height });
    const ctx = cv.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const px = ctx.getImageData(0, 0, cv.width, cv.height);
    for (let i = 0; i < px.data.length; i += 4) {
      const l = px.data[i] * 0.3 + px.data[i + 1] * 0.59 + px.data[i + 2] * 0.11;
      px.data[i] = px.data[i + 1] = px.data[i + 2] = Math.min(255, 70 + l * 0.8);
    }
    ctx.putImageData(px, 0, 0);
    const t = new THREE.CanvasTexture(cv);
    for (const k of ['flipY', 'colorSpace', 'wrapS', 'wrapT', 'magFilter', 'minFilter']) t[k] = tex[k];
    grayCache.set(tex, t);
  }
  return grayCache.get(tex);
}
function paint(obj, color) {
  obj.traverse((m) => {
    if (!m.isMesh) return;
    m.material = m.material.clone();
    if (m.material.map) m.material.map = grayTexture(m.material.map);
    m.material.color.set(color);
  });
  return obj;
}

// A low fence in the friend's color around their whole block, open where their path meets the road
function blockFence(f) {
  const cs = f.block.map(([c]) => c), rs = f.block.map(([, r]) => r);
  const [c0, c1, r0, r1] = [Math.min(...cs) - 0.44, Math.max(...cs) + 0.44, Math.min(...rs) - 0.44, Math.max(...rs) + 0.44];
  const mat = new THREE.MeshLambertMaterial({ color: f.color });
  const [dc, dr] = [f.home.door[0] - f.home.c, f.home.door[1] - f.home.r];
  const gate = { c: f.home.c + dc * 0.44, r: f.home.r + dr * 0.44 };
  const rail = (x0, z0, x1, z1) => {
    const len = Math.hypot(x1 - x0, z1 - z0);
    if (len < 0.01) return;
    const m = new THREE.Mesh(new THREE.BoxGeometry(Math.abs(x1 - x0) + 0.03, 0.07, Math.abs(z1 - z0) + 0.03), mat);
    m.position.copy(pos((x0 + x1) / 2, (z0 + z1) / 2)).setY(0.035);
    m.castShadow = true;
    scene.add(m);
  };
  const side = (x0, z0, x1, z1) => { // split around the gate if it sits on this side
    const onSide = x0 === x1 ? Math.abs(gate.c - x0) < 0.05 : Math.abs(gate.r - z0) < 0.05;
    if (!onSide) return rail(x0, z0, x1, z1);
    if (x0 === x1) { rail(x0, z0, x0, gate.r - 0.22); rail(x0, gate.r + 0.22, x0, z1); }
    else { rail(x0, z0, gate.c - 0.22, z0); rail(gate.c + 0.22, z0, x1, z0); }
  };
  side(c0, r0, c1, r0); side(c0, r1, c1, r1); side(c0, r0, c0, r1); side(c1, r0, c1, r1);
}

function buildCity() {
  const reserved = new Map();
  const doorOf = new Map(); // named places face the road their door is on
  for (const p of Object.values(PLACES)) if (p.model) { reserved.set(key(p.c, p.r), p.model); doorOf.set(key(p.c, p.r), p.door); }
  const yards = new Map(); // tiles of a friend's block -> friend
  for (const f of FRIENDS) for (const t of f.block) yards.set(key(...t), f);
  const special = new Set([...STADIUM.tiles, ...FARM.tiles].map((t) => key(...t)));
  const doors = new Set([...Object.values(PLACES), ...FRIENDS.map((f) => f.home)].map((a) => key(...a.door)));
  const hash = (c, r) => ((c * 37 + r * 91 + c * r * 7) % 100) / 100;
  // Suburban blocks get 2-3 houses, only on lots that touch a road; the rest are gardens
  const group = (v) => ROADS.filter((x) => x < v).length;
  const outerBlock = (c, r) => [0, ROADS.length].includes(group(c)) || [0, ROADS.length].includes(group(r));
  const picked = new Map();
  const suburbHouses = (c, r) => {
    const id = `${group(c)},${group(r)}`;
    if (!picked.has(id)) {
      const lots = [];
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        if (isRoad(x, y) || group(x) !== group(c) || group(y) !== group(r)) continue;
        if ([[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => isRoad(x + dx, y + dy))) lots.push([x, y]);
      }
      // Named places on the block count toward its 2-3 buildings
      lots.sort((a, b) => reserved.has(key(...b)) - reserved.has(key(...a)) || hash(...a) - hash(...b));
      const count = lots.length <= 3 ? 2 : 2 + Math.floor(hash(c + r, 7) * 2);
      picked.set(id, new Set(lots.slice(0, count).map((t) => key(...t))));
    }
    return picked.get(id);
  };
  const greenery = (c, r, i) => {
    const m = [PARK_TREES[0], NATURE['bush-02'], PARK_TREES[2], NATURE['bush-01'], PARK_TREES[1]][i % 5];
    place(m, c, r, { scale: m.includes('tree') ? 2.3 : 2.4, rotY: i });
  };

  // ---- Roads, lots and buildings
  let roofN = 0, curbN = 0;
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      const onR = ROADS.includes(r), onC = ROADS.includes(c);
      if (onR && onC) { place(ROAD.cross, c, r); continue; }
      if (onR) { place(ROAD.straight, c, r, { rotY: Math.PI / 2 }); continue; } // model runs along z
      if (onC) { place(ROAD.straight, c, r); continue; }
      if (inPark(c, r)) { place(GROUND.grass, c, r); continue; }
      blocked.add(key(c, r));
      if (special.has(key(c, r))) { place(STADIUM.tiles.some(([x, y]) => x === c && y === r) ? GROUND.paved : GROUND.grass, c, r); continue; }

      const friend = yards.get(key(c, r));
      if (friend) {
        const h = friend.home;
        const facing = Math.atan2(h.c - h.house[0], h.r - h.house[1]); // house faces down its driveway
        place(GROUND.grass, c, r);
        if (h.house[0] === c && h.house[1] === r) {
          const home = paint(place(h.model, c, r, { ...(h.model.startsWith(SP) ? { scale: 0.92 } : { fit: 0.8 }), rotY: facing }), friend.color);
          topOf[key(c, r)] = topOf[key(h.c, h.r)] = new THREE.Box3().setFromObject(home).max.y;
        } else if (h.c === c && h.r === r) {
          const [dc, dr] = [h.c - h.house[0], h.r - h.house[1]];
          const drive = new THREE.Mesh(new THREE.BoxGeometry(dc ? 1 : 0.36, 0.012, dr ? 1 : 0.36), new THREE.MeshLambertMaterial({ color: '#c9c3b8' }));
          drive.position.copy(pos(c, r)).setY(0.006);
          drive.receiveShadow = true;
          scene.add(drive);
          paint(place(VEHICLES[friend.name.length % 7], c - dc * 0.05, r - dr * 0.05, { scale: 1.3, rotY: facing }), friend.color);
          place(NATURE['bush-03'], c + dr * 0.32, r + dc * 0.32, { scale: 2.4 });
        } else greenery(c, r, c + r * 2);
        continue;
      }

      const suburb = outerBlock(c, r); // the ring outside roads 2 and 14 is all suburbs
      const zone = suburb ? ZONES.at(-1) : ZONES.find((z) => Math.hypot(c - CENTER, r - CENTER) < z.upTo && z.models !== HOUSES) ?? ZONES.at(-2);
      const door = doorOf.get(key(c, r));
      const rotY = door ? Math.atan2(door[0] - c, door[1] - r) : faceRoad(c, r);
      if (rotY === null && !reserved.has(key(c, r))) { // no street frontage: a courtyard, never a building
        place(suburb ? GROUND.grass : GROUND.paved, c, r);
        greenery(c, r, c * 3 + r);
        if (!suburb) {
          place(STREET.public_bench_01, c - 0.3, r + 0.25, { scale: METER, rotY: Math.PI / 2 });
          place(NATURE['pot-bush-big'], c + 0.3, r - 0.3, { scale: 2.2 });
        }
        continue;
      }
      if (suburb && !reserved.has(key(c, r)) && !suburbHouses(c, r).has(key(c, r))) { // gardens keep the suburbs airy
        place(GROUND.grass, c, r);
        greenery(c, r, c * 3 + r);
        if (hash(c, r) < 0.5) place(NATURE['bush-03'], c + 0.25, r - 0.25, { scale: 2.4 });
        continue;
      }
      const n = zone.used = (zone.used ?? (c * 5 + r * 3)) + 1; // walk each zone's list so neighbors differ
      const model = reserved.get(key(c, r)) || zone.models[n % zone.models.length];
      const [lo, hi] = zone.height;
      const height = lo + (hi - lo) * hash(c, r);
      place(suburb ? GROUND.grass : GROUND.paved, c, r);
      const isSP = model.startsWith(SP);
      const b = place(model, c, r, { ...(isSP ? { scale: 0.92, height } : { fit: 0.86 }), rotY });
      const top = new THREE.Box3().setFromObject(b).max.y;
      topOf[key(c, r)] = top;

      // Something on the sidewalk out front of shops and towers
      if (!suburb && hash(c * 2, r) < 0.55) {
        const along = hash(r * 3, c) < 0.5 ? -0.3 : 0.3;
        const [fx, fz] = [Math.sin(rotY), Math.cos(rotY)]; // facing direction
        place(STREET[CURBSIDE[curbN++ % CURBSIDE.length]], c + fx * 0.47 + fz * along, r + fz * 0.47 - fx * along, { scale: METER, rotY });
      }
      // Rooftops: helipads on the big towers, gear on other tall SimplePoly blocks, billboards on shops
      if (!isSP || suburb) continue;
      const roof = model.includes('sky-big') ? HELIPAD
        : height >= 1.3 || model.includes('sky-small') || model.includes('residential') ? ROOF_PROPS[roofN++ % ROOF_PROPS.length]
        : hash(r, c) < 0.45 ? [PROPS['billboard-small'], PROPS['billboard-medium'], PROPS['billboard-large']][roofN++ % 3] : null;
      if (roof) place(roof, c, r, { scale: roof === HELIPAD ? 0.9 : 1.3, rotY }).position.y = top - 0.01;
    }
  }

  // ---- Friends' blocks: colored fence, mailbox and flag so each home is easy to spot
  for (const f of FRIENDS) {
    blockFence(f);
    const h = f.home;
    const [dc, dr] = [h.door[0] - h.c, h.door[1] - h.r];
    const side = { c: -dr * 0.34, r: dc * 0.34 };
    tint(place(STREET.mailbox_01_white, h.c + dc * 0.4 + side.c, h.r + dr * 0.4 + side.r, { scale: METER, rotY: Math.atan2(dc, dr) }), f.color, 0.8);
    // Flag on a pole in the front yard; the cloth hangs from a pivot at the pole top so it stays attached
    const flagAt = pos(h.c - dc * 0.3 - side.c, h.r - dr * 0.3 - side.r);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.9), new THREE.MeshLambertMaterial({ color: '#eeeeee' }));
    pole.position.copy(flagAt).setY(0.45);
    const pivot = new THREE.Group();
    pivot.position.copy(flagAt).setY(0.8);
    const cloth = new THREE.Mesh(new THREE.PlaneGeometry(0.26, 0.16), new THREE.MeshLambertMaterial({ color: f.color, side: THREE.DoubleSide }));
    cloth.position.x = 0.13; // hinge on the cloth's left edge
    pivot.add(cloth);
    pole.castShadow = cloth.castShadow = true;
    scene.add(pole, pivot);
    const phase = f.name.length;
    animated.add({ update() { pivot.rotation.y = Math.sin(performance.now() / 450 + phase) * 0.4; } });
    const at = pos(...h.house).setY(topOf[key(...h.house)] + 0.2);
    const lbl = addLabel('lbl place home', `${f.name}'s house`, () => at);
    lbl.el.style.background = f.color;
    lbl.el.style.color = inkOn(f.color);
  }

  // ---- Landmarks: the stadium at the pack's true scale fills its block; a windmill farm in the other corner
  const sc = STADIUM.tiles.reduce((a, [c, r]) => [a[0] + c / STADIUM.tiles.length, a[1] + r / STADIUM.tiles.length], [0, 0]);
  place(STADIUM.model, sc[0], sc[1], { scale: 1.3, rotY: Math.PI / 2 });
  place(PROPS.windmill, 0.5, 15.6, { scale: 2.2, rotY: Math.PI / 4 });
  for (const [x, z, rot] of [[0.5, 14.62, Math.PI / 2], [0.5, 16.38, Math.PI / 2], [-0.38, 15.5, 0], [1.38, 15.5, 0]]) {
    place(NATURE['grass-fence'], x, z, { scale: 2.4, rotY: rot });
  }
  for (const [x, z, m] of [[0, 15, 'bush-02'], [1.1, 16.1, 'bush-03'], [1.2, 15, 'rock-big'], [-0.1, 16.2, 'bush-01']]) place(NATURE[m], x, z, { scale: 2.2 });

  // ---- Green belt with a winding river; roads run on through it and cross on bridges
  const rows = RIVER.band;
  for (let r = N; r < N + rows; r++) for (let c = 0; c < N; c++) {
    if (ROADS.includes(c)) { place(ROAD.straight, c, r).position.y = 0.03; continue; }
    place(GROUND.grass, c, r);
  }
  const sand = new THREE.Mesh(riverStrip(RIVER.width + 0.3, 0.006), new THREE.MeshLambertMaterial({ color: '#d9c58f' }));
  sand.receiveShadow = true;
  scene.add(sand);
  water(riverStrip(RIVER.width, 0.014));
  const stone = new THREE.MeshLambertMaterial({ color: '#cfc8bb' });
  for (const c of ROADS) {
    const x = pos(c, 0).x, z = riverZ(x), span = RIVER.width + 0.45;
    const deck = new THREE.Mesh(new THREE.BoxGeometry(0.98, 0.06, span), stone); // top sits just under the road tiles
    deck.position.set(x, -0.02, z);
    scene.add(deck);
    for (const s of [-0.47, 0.47]) {
      const railing = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.1, span), stone);
      railing.position.set(x + s, 0.08, z);
      railing.castShadow = true;
      scene.add(railing);
    }
  }
  let g = 0;
  for (let c = 0; c < N; c++) {
    if (ROADS.includes(c)) continue;
    const x = pos(c, 0).x;
    for (let r = N; r < N + rows; r++) {
      const z = pos(0, r).z;
      if (Math.abs(z - riverZ(x)) < RIVER.width / 2 + 0.35 || hash(c, r) > 0.6) continue;
      greenery(c + (hash(r, c) - 0.5) * 0.4, r, g++);
    }
    if (c % 3 === 1) place(NATURE['rock-small'], c + 0.3, riverZ(x) + RIVER.width / 2 + 0.2 + N / 2 - 0.5, { scale: 2 }); // world z -> tile row
  }

  // ---- Central park: pond ringed by rocks, trees in the corners, benches facing the water
  const pond = new THREE.CircleGeometry(0.72, 20);
  pond.rotateX(-Math.PI / 2);
  pond.translate(pos(CENTER, CENTER).x, 0.02, pos(CENTER, CENTER).z);
  water(pond);
  const rim = new THREE.Mesh(new THREE.RingGeometry(0.72, 0.8, 20), new THREE.MeshLambertMaterial({ color: '#b9ad97' }));
  rim.rotation.x = -Math.PI / 2;
  rim.position.copy(pos(CENTER, CENTER)).setY(0.025);
  scene.add(rim);
  blocked.add(key(CENTER, CENTER));
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + 0.3;
    place(i % 2 ? NATURE['rock-small'] : NATURE['rock-big'], CENTER + Math.cos(a) * 0.8, CENTER + Math.sin(a) * 0.8, { scale: 1.6, rotY: a });
  }
  TREES.forEach(([c, r], i) => {
    place(PARK_TREES[i % PARK_TREES.length], c, r, { scale: 2.6 });
    blocked.add(key(c, r));
  });
  place(PROPS['bench-1'], CENTER, CENTER - 1.1, { scale: 2, rotY: Math.PI });
  place(PROPS['bench-2'], CENTER, CENTER + 1.1, { scale: 2 });
  place(STREET.public_bench_01, CENTER - 1.1, CENTER, { scale: METER, rotY: Math.PI / 2 });
  place(STREET.drinking_fountain_01, CENTER + 1.15, CENTER + 0.35, { scale: METER, rotY: -Math.PI / 2 });
  for (const [c, r, m] of [[CENTER + 1.1, CENTER - 0.3, 'bush-01'], [CENTER - 0.4, CENTER - 1.2, 'pot-bush-big'],
    [CENTER + 0.4, CENTER - 1.2, 'pot-bush-small'], [CENTER - 0.4, CENTER + 1.2, 'bush-02']]) place(NATURE[m], c, r, { scale: 2.2 });

  // ---- Street furniture
  for (const c of ROADS) for (const r of ROADS) {
    place(PROPS['street-light'], c + 0.42, r + 0.42, { scale: 1.8, rotY: -Math.PI / 4 });
    const inner = Math.abs(c - CENTER) < 5 && Math.abs(r - CENTER) < 5;
    if (inner) {
      place(PROPS['traffic-signal-big'], c - 0.42, r - 0.42, { scale: 1.8, rotY: (3 * Math.PI) / 4 });
      place(STREET.pedestrian_traffic_light_02_base_medium_black, c + 0.44, r - 0.44, { scale: METER, rotY: -Math.PI / 2 });
      place(STREET.cctv_camera_01_base, c - 0.44, r + 0.44, { scale: METER });
    } else {
      place(PROPS['traffic-sign-stop'], c - 0.44, r + 0.44, { scale: 2 });
      place(PROPS['traffic-signal-small'], c + 0.44, r - 0.44, { scale: 1.6 });
    }
    if (r + 1 < N) place((c + r) % 8 ? PROPS.hydrant : PROPS.dustbin, c + 0.44, r + 0.75, { scale: 2 });
  }
  // Parked vehicles along the curbs (skipping crossings and doorways), every pack vehicle in rotation
  let v = 0;
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
    const onR = ROADS.includes(r), onC = ROADS.includes(c);
    if (onR === onC || doors.has(key(c, r)) || hash(c, r) > 0.3) continue;
    const side = hash(r, c) < 0.5 ? -1 : 1;
    const model = VEHICLES[v++ % VEHICLES.length];
    if (onC) place(model, c + side * 0.33, r, { scale: 1.4, rotY: side > 0 ? 0 : Math.PI });
    else place(model, c, r + side * 0.33, { scale: 1.4, rotY: side > 0 ? -Math.PI / 2 : Math.PI / 2 });
  }
  // A bus stop by the park, café chairs out front, and roadwork on the east side
  place(PROPS['bus-stop'], CENTER + 1, ROADS[2] + 0.41, { scale: 1.6, rotY: Math.PI });
  for (const dz of [-0.35, 0.3]) place(PROPS['coffee-shop-chair'], PLACES.cafe.door[0] + 0.4, PLACES.cafe.door[1] + dz, { scale: 1.6 });
  const rw = ROADS[3];
  place(PROPS['traffic-control-barrier-fence'], rw + 0.3, 4, { scale: 2, rotY: Math.PI / 2 });
  place(STREET.concrete_jersey_barrier_01_medium, rw + 0.3, 4.45, { scale: METER, rotY: Math.PI / 2 });
  place(STREET.type_ii_barricade_01_medium, rw + 0.3, 3.55, { scale: METER, rotY: Math.PI / 2 });
  for (const dz of [-0.3, 0, 0.3]) place(dz ? PROPS['traffic-cone'] : STREET.cone_i_medium, rw + 0.12, 4 + dz, { scale: dz ? 2 : METER });
  place(STREET.pallet_medium_01, rw + 0.36, 4.85, { scale: METER });
  place(STREET.barrel_02_medium_blue, rw + 0.3, 3.2, { scale: METER });
  place(STREET.barrel_02_medium_red, rw + 0.38, 3.05, { scale: METER });

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
const WALK_SPEED = 0.9; // tiles per second: an unhurried stroll (the town is 17 tiles across)

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
    lbl.el.style.color = inkOn(def.color);
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

function houseTop(home) { return pos(...home.house).setY(topOf[key(...home.house)]); }

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
  ...ZONES.flatMap((z) => z.models),
  ...Object.values(PLACES).filter((p) => p.model).map((p) => p.model),
  ...FRIENDS.map((f) => `${CH}${f.model}.glb`), ...FRIENDS.map((f) => f.home.model),
  ...Object.values(ROAD), ...Object.values(GROUND), ...PARK_TREES, ...Object.values(PROPS), ...Object.values(NATURE),
  ...ROOF_PROPS, HELIPAD, ...VEHICLES, STADIUM.model,
  ...Object.values(STREET),
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

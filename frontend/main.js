// Tiny Town 3D sandbox: Three.js + SimplePoly City (roads, greenery, buildings), Kenney City Kit buildings and Mini Characters, orthographic "isometric" camera.
// Character behavior is scripted/random here; it stands in for the real character agents.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MapControls } from 'three/addons/controls/MapControls.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { startTownBackend } from './realtime.js';
import { api } from './session.js';
import { startTownSync } from './townsync.js';

// town.html?town=<id> draws that town from the database (GET /towns/{id}): tiles, map places, members'
// homes and looks, agents. Without it, the hard-coded demo town below is drawn.
const TOWN_ID = new URLSearchParams(location.search).get('town');
const TOWN = TOWN_ID ? await api(`/towns/${TOWN_ID}`).catch((e) => {
  document.body.innerHTML = `<p style="font:16px sans-serif;padding:24px">Couldn't load this town: ${e.message}. <a href="index.html">Back</a></p>`;
  throw e;
}) : null;
const TILES = TOWN?.town.tiles;
const tileAt = (c, r) => TILES?.[r]?.[c];
const tilesOf = (kind) => TILES ? TILES.flatMap((row, r) => row.flatMap((k, c) => (k === kind ? [[c, r]] : []))) : [];

// Rectangular maps are drawn in an N x N square; tiles outside the map are left empty.
const N = TILES ? Math.max(TILES.length, ...TILES.map((row) => row.length)) : 17;
// Roads that run the full width/height of the map (buildCity's lamps and suburbs follow these)
const ROADS = TILES
  ? [...Array(N).keys()].filter((i) => TILES[i]?.every((k) => k === 'road') || TILES.every((row) => row[i] === 'road'))
  : [2, 6, 10, 14];
// ponytail: one CENTER is used for both axes, so the pond should sit on the diagonal (x === y); split into CX/CY if not
const CENTER = TILES ? (tilesOf('pond')[0]?.[0] ?? Math.floor(N / 2)) : 8; // the park sits at the middle; the skyline rings it
const PARKISH = new Set(['park', 'pond', 'tree']);
const inPark = TILES ? (c, r) => PARKISH.has(tileAt(c, r)) : (c, r) => c >= 7 && c <= 9 && r >= 7 && r <= 9;
const isRoad = TILES ? (c, r) => tileAt(c, r) === 'road' : (c, r) => ROADS.includes(c) || ROADS.includes(r);
// Tile words from backend/town_map.py; any other word is an explicit model (asset path without assets/ and .glb)
const TILE_KINDS = new Set(['road', 'park', 'pond', 'tree', 'stadium', 'farm', 'home', 'driveway', 'yard', 'lot']);
const asset = (k) => `assets/${k}.glb`;
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
const STADIUM = TILES
  ? { model: TOWN.town.map?.landmarks?.stadium?.model ? asset(TOWN.town.map.landmarks.stadium.model) : sp('building-stadium'), tiles: tilesOf('stadium') }
  : { model: sp('building-stadium'), tiles: block(11, 13, 11, 13) }; // a full 3x3 city block
const FARM = { tiles: TILES ? tilesOf('farm') : block(0, 1, 15, 16) };
const PLACES = TILES ? Object.fromEntries(Object.entries(TOWN.town.map?.places || {}).map(([id, p]) => [id, {
  name: p.name, ...(p.model ? { model: asset(p.model) } : {}), c: p.tile[0], r: p.tile[1], door: p.door,
}])) : {
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
const DEMO_FRIENDS = [
  { id: 'maya', name: 'Maya', color: '#ff3b30', model: 'character-female-a', block: block(0, 1, 3, 5), home: { model: sp('building-house-01-color01'), house: [0, 4], c: 1, r: 4, door: [2, 4] } },
  { id: 'jordan', name: 'Jordan', color: '#ff2d95', model: 'character-male-b', block: block(11, 13, 0, 1), home: { model: `${SUB}building-type-k.glb`, house: [12, 0], c: 12, r: 1, door: [12, 2] } },
  { id: 'sam', name: 'Sam', color: '#ffd60a', model: 'character-male-d', block: block(3, 5, 15, 16), home: { model: sp('building-house-03-color01'), house: [4, 16], c: 4, r: 15, door: [4, 14] } },
  { id: 'priya', name: 'Priya', color: '#ff9500', model: 'character-female-c', block: block(15, 16, 7, 9), home: { model: `${SUB}building-type-r.glb`, house: [16, 8], c: 15, r: 8, door: [14, 8] } },
  { id: 'leo', name: 'Leo', color: '#a24bff', model: 'character-male-f', block: block(0, 1, 11, 13), home: { model: sp('building-house-02-color01'), house: [0, 12], c: 1, r: 12, door: [2, 12] } },
];
// In a real town, residents come from its members: id = user_id, look from profiles.avatar, home from
// house_x/house_y + town_members.home. Members who haven't placed a house yet get no character.
const FRIENDS = TILES ? TOWN.members.filter((m) => m.house_x != null && m.home?.door && m.home?.driveway && m.home?.block)
  .map((m, i) => {
    const look = m.profiles?.avatar || {}, h = m.home, fallback = DEMO_FRIENDS[i % DEMO_FRIENDS.length];
    return {
      id: m.user_id, name: m.profiles?.display_name || 'Friend', color: look.color || fallback.color,
      model: look.character || fallback.model, block: block(h.block[0], h.block[2], h.block[1], h.block[3]),
      home: { model: h.model ? asset(h.model) : fallback.home.model, house: [m.house_x, m.house_y], c: h.driveway[0], r: h.driveway[1], door: h.door },
    };
  }) : DEMO_FRIENDS;
// Dark text on light friend colors (yellow, orange), white on the rest
const inkOn = (hex) => { const c = new THREE.Color(hex); return c.r * 0.3 + c.g * 0.59 + c.b * 0.11 > 0.6 ? '#1f2430' : '#fff'; };
const TREES = TILES ? tilesOf('tree') : [[7, 7], [9, 7], [7, 9], [9, 9]];
// Explicit building models on the map that aren't named places (a town editor could put these anywhere)
const EXTRA_MODELS = TILES ? TILES.flatMap((row, r) => row.flatMap((k, c) =>
  (TILE_KINDS.has(k) || Object.values(PLACES).some((p) => p.c === c && p.r === r) ? [] : [[c, r, asset(k)]]))) : [];

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
scene.fog = new THREE.Fog('#9fd3ec', 1000, 2000); // weather haze; `updateSky` sets its range and color

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
camera.zoom = 1.35; // open close to the old town's scale; scroll out to see the whole town
camera.updateProjectionMatrix();

// Third-person camera used while following a friend
const followCam = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.05, 100);
addEventListener('resize', () => { followCam.aspect = innerWidth / innerHeight; followCam.updateProjectionMatrix(); });
let following = null;
let activeCam = camera;
const FOLLOW_BACK = 1.3, FOLLOW_UP = 0.75;
const FOLLOW_REST_MS = 2500; // after this long without input, the camera eases back behind the person
let lastFollowInput = 0;

// A trackpad pinch arrives as ctrl+wheel. Over a panel or label the browser would pinch-zoom the
// whole page instead (blurry, panels pushed off screen), so only the town's camera may zoom.
addEventListener('wheel', (e) => { if (e.ctrlKey) e.preventDefault(); }, { passive: false });
for (const t of ['gesturestart', 'gesturechange']) addEventListener(t, (e) => e.preventDefault(), { passive: false }); // Safari

const controls = new MapControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.minZoom = 0.6;
controls.maxZoom = 5;
controls.minPolarAngle = 0.35;
controls.maxPolarAngle = 1.15;
controls.target.set(0, 0, 0);

const hemi = new THREE.HemisphereLight('#ffffff', '#8a9a7a', 1.6);
scene.add(hemi);
const sun = new THREE.DirectionalLight('#fff4e0', 2.2);
sun.position.set(-8, 14, 6);
sun.castShadow = true;
sun.shadow.mapSize.setScalar(IS_MOBILE ? 1024 : 2048);
Object.assign(sun.shadow.camera, { left: -15, right: 15, top: 15, bottom: -15, near: 1, far: 60 });
sun.shadow.bias = -0.0005;
scene.add(sun);

// Base plate under the city (a hair below the tiles, so they never z-fight)
const slab = (w, d, top, z) => {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.3, d), new THREE.MeshLambertMaterial({ color: '#b98a5a' }));
  m.position.set(0, top - 0.151, z);
  m.receiveShadow = true;
  scene.add(m);
};
slab(N + 0.4, N + 0.4, -0.01, 0);

// Animated low-poly water (the park pond): vertices bob gently
function water(geometry) {
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
    color: '#3fa7d6', roughness: 0.25, metalness: 0.1, flatShading: true, transparent: true, opacity: 0.92,
  }));
  SNOW_SKIP.add(mesh.material);
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

// The windmill model's rotor is its own mesh (the part above the tower's base). Re-hang it on a
// pivot at its hub (the blades' vertex centroid) and turn it, faster when the weather is rough.
function spinBlades(windmill) {
  let rotor = null;
  windmill.traverse((m) => {
    if (!m.isMesh) return;
    m.geometry.computeBoundingBox();
    if (m.geometry.boundingBox.min.y > 5) rotor = m;
  });
  if (!rotor) return;
  const p = rotor.geometry.attributes.position, hub = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) hub.add(new THREE.Vector3().fromBufferAttribute(p, i));
  hub.divideScalar(p.count);
  const pivot = new THREE.Object3D();
  pivot.position.copy(hub);
  rotor.parent.add(pivot);
  pivot.add(rotor);
  rotor.position.sub(hub);
  animated.add({ update(dt) {
    const wind = { storm: 3.2, rain: 1.8, snow: 1.4 }[sky.weather] ?? 1;
    pivot.rotation.z -= dt * 1.1 * wind;
  } });
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
const isCorner = (c, r) => roadSides(c, r).length >= 2;

// ---- Town -------------------------------------------------------------------------------

const blocked = new Set();
const occluders = []; // buildings and trees that fade out when they hide a person
function addOccluder(root) {
  occluders.push(root);
  root.traverse((m) => { m.userData.occluderRoot = root; });
}
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
// Paint only the roof: faces pointing up in the top part of the model get a grayscale copy of the
// material in `color`; walls, windows and doors keep their own look.
function paintRoof(obj, color) {
  obj.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(obj);
  const cut = box.min.y + (box.max.y - box.min.y) * 0.55;
  const [a, b, cc, n] = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  obj.traverse((m) => {
    if (!m.isMesh) return;
    const g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
    const p = g.attributes.position, tris = p.count / 3;
    const roof = [];
    for (let t = 0; t < tris; t++) {
      a.fromBufferAttribute(p, t * 3).applyMatrix4(m.matrixWorld);
      b.fromBufferAttribute(p, t * 3 + 1).applyMatrix4(m.matrixWorld);
      cc.fromBufferAttribute(p, t * 3 + 2).applyMatrix4(m.matrixWorld);
      n.subVectors(cc, b).cross(a.clone().sub(b)).normalize();
      roof.push(n.y > 0.3 && (a.y + b.y + cc.y) / 3 > cut);
    }
    if (!roof.some(Boolean)) return;
    // Reorder triangles (walls first, roof last) and split them into two material groups
    const order = [...Array(tris).keys()].sort((x, y) => roof[x] - roof[y]);
    for (const name of Object.keys(g.attributes)) { // read per component: attributes may be interleaved
      const src = g.attributes[name], k = src.itemSize, out = new Float32Array(src.count * k);
      order.forEach((t, i) => {
        for (let v = 0; v < 3; v++) for (let j = 0; j < k; j++) out[(i * 3 + v) * k + j] = src.getComponent(t * 3 + v, j);
      });
      g.setAttribute(name, new THREE.BufferAttribute(out, k, src.normalized));
    }
    const walls = roof.filter((x) => !x).length;
    g.addGroup(0, walls * 3, 0);
    g.addGroup(walls * 3, (tris - walls) * 3, 1);
    const roofMat = m.material.clone();
    if (roofMat.map) roofMat.map = grayTexture(roofMat.map);
    roofMat.color.set(color);
    m.geometry = g;
    m.material = [m.material, roofMat];
  });
  return obj;
}

// Seat a building on its lot: center it, then push its front edge up to the road it faces, and on
// a corner lot its side up to the second road too, so corner houses sit right on the corner.
function seat(obj, c, r, sides, setback = 0.05) {
  obj.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(obj), mid = box.getCenter(new THREE.Vector3()), at = pos(c, r);
  obj.position.x += at.x - mid.x;
  obj.position.z += at.z - mid.z;
  const half = box.getSize(new THREE.Vector3()).multiplyScalar(0.5);
  for (const [dc, dr] of sides) {
    if (dc) obj.position.x += dc * (0.5 - setback - half.x);
    if (dr) obj.position.z += dr * (0.5 - setback - half.z);
  }
  return obj;
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
  for (const [c, r, model] of EXTRA_MODELS) reserved.set(key(c, r), model);
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
      // Named places first (they count toward the block's 2-3 buildings), then every corner lot, then the rest
      const rank = (t) => (reserved.has(key(...t)) ? 0 : isCorner(...t) ? 1 : 2);
      lots.sort((a, b) => rank(a) - rank(b) || hash(...a) - hash(...b));
      const corners = lots.filter((t) => isCorner(...t)).length;
      const count = Math.max(corners, lots.length <= 3 ? 2 : 2 + Math.floor(hash(c + r, 7) * 2));
      picked.set(id, new Set(lots.slice(0, count).map((t) => key(...t))));
    }
    return picked.get(id);
  };
  const greenery = (c, r, i) => {
    const m = [PARK_TREES[0], NATURE['bush-02'], PARK_TREES[2], NATURE['bush-01'], PARK_TREES[1]][i % 5];
    const g = place(m, c, r, { scale: m.includes('tree') ? 2.3 : 2.4, rotY: i });
    if (m.includes('tree')) addOccluder(g);
  };

  // ---- Roads, lots and buildings
  let roofN = 0, curbN = 0;
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      const onR = ROADS.includes(r), onC = ROADS.includes(c);
      if (onR && onC) { place(ROAD.cross, c, r); continue; }
      if (onR) { place(ROAD.straight, c, r, { rotY: Math.PI / 2 }); continue; } // model runs along z
      if (onC) { place(ROAD.straight, c, r); continue; }
      if (TILES && tileAt(c, r) === undefined) { blocked.add(key(c, r)); continue; } // outside a non-square map
      if (TILES && isRoad(c, r)) { place(ROAD.straight, c, r, { rotY: isRoad(c - 1, r) || isRoad(c + 1, r) ? Math.PI / 2 : 0 }); continue; } // a road that doesn't span the map
      if (inPark(c, r)) { place(GROUND.grass, c, r); continue; }
      blocked.add(key(c, r));
      if (special.has(key(c, r))) { place(STADIUM.tiles.some(([x, y]) => x === c && y === r) ? GROUND.paved : GROUND.grass, c, r); continue; }

      const friend = yards.get(key(c, r));
      if (friend) {
        const h = friend.home;
        const facing = Math.atan2(h.c - h.house[0], h.r - h.house[1]); // house faces down its driveway
        place(GROUND.grass, c, r);
        if (h.house[0] === c && h.house[1] === r) {
          const home = paintRoof(place(h.model, c, r, { ...(h.model.startsWith(SP) ? { scale: 0.92 } : { fit: 0.8 }), rotY: facing }), friend.color);
          topOf[key(c, r)] = topOf[key(h.c, h.r)] = new THREE.Box3().setFromObject(home).max.y;
          addOccluder(home);

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
        place(GROUND.grass, c, r); // anything green stands on grass
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
      b.userData.building = isSP ? 'simplepoly' : 'kenney';
      addOccluder(b);
      if (suburb) { // flush to the street it faces, and to the cross street on a corner
        const front = [Math.round(Math.sin(rotY)), Math.round(Math.cos(rotY))];
        seat(b, c, r, [front, ...roadSides(c, r).filter(([x, y]) => x !== front[0] || y !== front[1])]);
      } else seat(b, c, r, []);
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
    h.name = `${f.name}'s house`;
    const lbl = addLabel('lbl place home', h.name, () => at);
    lbl.el.style.background = f.color;
    lbl.el.style.color = inkOn(f.color);
    f.homeLabel = lbl;
  }

  // ---- Landmarks: the stadium at the pack's true scale fills its block; a windmill farm in the other corner
  if (STADIUM.tiles.length) {
    const sc = STADIUM.tiles.reduce((a, [c, r]) => [a[0] + c / STADIUM.tiles.length, a[1] + r / STADIUM.tiles.length], [0, 0]);
    addOccluder(place(STADIUM.model, sc[0], sc[1], { scale: 1.3, rotY: Math.PI / 2 }));
  }
  if (FARM.tiles.length) { // laid out for a 2x2 farm; (fx, fz) shifts it from the demo's corner at (0, 15)
    const fx = Math.min(...FARM.tiles.map(([c]) => c)), fz = Math.min(...FARM.tiles.map(([, r]) => r)) - 15;
    spinBlades(place(PROPS.windmill, fx + 0.5, fz + 15.6, { scale: 2.2, rotY: Math.PI / 4 }));
    for (const [x, z, rot] of [[0.5, 14.62, Math.PI / 2], [0.5, 16.38, Math.PI / 2], [-0.38, 15.5, 0], [1.38, 15.5, 0]]) {
      place(NATURE['grass-fence'], fx + x, fz + z, { scale: 2.4, rotY: rot });
    }
    for (const [x, z, m] of [[0, 15, 'bush-02'], [1.1, 16.1, 'bush-03'], [1.2, 15, 'rock-big'], [-0.1, 16.2, 'bush-01']]) place(NATURE[m], fx + x, fz + z, { scale: 2.2 });
  }

  // ---- Central park: pond ringed by rocks, trees in the corners, benches facing the water
  if (!TILES || tilesOf('pond').length) {
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
      addOccluder(place(PARK_TREES[i % PARK_TREES.length], c, r, { scale: 2.6 }));
      blocked.add(key(c, r));
    });
    place(PROPS['bench-1'], CENTER, CENTER - 1.1, { scale: 2, rotY: Math.PI });
    place(PROPS['bench-2'], CENTER, CENTER + 1.1, { scale: 2 });
    place(STREET.public_bench_01, CENTER - 1.1, CENTER, { scale: METER, rotY: Math.PI / 2 });
    place(STREET.drinking_fountain_01, CENTER + 1.15, CENTER + 0.35, { scale: METER, rotY: -Math.PI / 2 });
    for (const [c, r, m] of [[CENTER + 1.1, CENTER - 0.3, 'bush-01'], [CENTER - 0.4, CENTER - 1.2, 'pot-bush-big'],
      [CENTER + 0.4, CENTER - 1.2, 'pot-bush-small'], [CENTER - 0.4, CENTER + 1.2, 'bush-02']]) place(NATURE[m], c, r, { scale: 2.2 });
  }

  // ---- Street furniture
  // Street lights: one on each crossing, plus one mid-block on every other block face (skipping doorways)
  const lamp = (x, z, rotY) => { place(PROPS['street-light'], x, z, { scale: 1.8, rotY }); LAMPS.push({ x, z, rotY }); };
  for (const c of ROADS) for (const r of ROADS) lamp(c + 0.42, r + 0.42, -Math.PI / 4);
  for (const i of [4, 8, 12]) for (const [k, road] of ROADS.entries()) { // middles of the blocks between roads
    if ((i / 4 + k) % 2) continue;
    const side = k % 2 ? 1 : -1;
    if (!doors.has(key(road, i))) lamp(road + side * 0.44, i, side > 0 ? 0 : Math.PI); // along a north-south road
    if (!doors.has(key(i, road))) lamp(i, road + side * 0.44, side > 0 ? -Math.PI / 2 : Math.PI / 2); // along an east-west road
  }
  for (const c of ROADS) for (const r of ROADS) {
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
  if (ROADS.length > 2) place(PROPS['bus-stop'], CENTER + 1, ROADS[2] + 0.41, { scale: 1.6, rotY: Math.PI });
  if (PLACES.cafe) for (const dz of [-0.35, 0.3]) place(PROPS['coffee-shop-chair'], PLACES.cafe.door[0] + 0.4, PLACES.cafe.door[1] + dz, { scale: 1.6 });
  const rw = ROADS[3];
  if (rw !== undefined) {
  place(PROPS['traffic-control-barrier-fence'], rw + 0.3, 4, { scale: 2, rotY: Math.PI / 2 });
  place(STREET.concrete_jersey_barrier_01_medium, rw + 0.3, 4.45, { scale: METER, rotY: Math.PI / 2 });
  place(STREET.type_ii_barricade_01_medium, rw + 0.3, 3.55, { scale: METER, rotY: Math.PI / 2 });
  for (const dz of [-0.3, 0, 0.3]) place(dz ? PROPS['traffic-cone'] : STREET.cone_i_medium, rw + 0.12, 4 + dz, { scale: dz ? 2 : METER });
  place(STREET.pallet_medium_01, rw + 0.36, 4.85, { scale: METER });
  place(STREET.barrel_02_medium_blue, rw + 0.3, 3.2, { scale: METER });
  place(STREET.barrel_02_medium_red, rw + 0.38, 3.05, { scale: METER });
  }

  for (const p of Object.values(PLACES)) {
    if (!p.model) continue;
    const at = pos(p.c, p.r).setY(topOf[key(p.c, p.r)] + 0.15);
    p.label = addLabel('lbl place', p.name, () => at);
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

// Real towns: put a resident where their agents row says. A walk started at updated_at from (x, y), so
// fast-forward along the (deterministic) path by the time since then; every screen lands on the same spot.
const WALKING = new Set(['walk_to', 'visit', 'knock', 'go_home']);
function destinationOf(row) {
  const b = row.target?.building_id;
  if (!b) return null;
  return b.startsWith('house:') ? friends[b.slice(6)]?.home ?? null : PLACES[b] ?? null;
}
function placeAgent(f, row) {
  interrupt(f);
  f.obj.position.copy(toWorld({ x: row.x, z: row.y }));
  const dest = WALKING.has(row.action) ? destinationOf(row) : null;
  if (!dest) return;
  walkTo(f, dest).then((ok) => { if (ok && row.action === 'go_home') f.obj.visible = false; });
  let ahead = WALK_SPEED * Math.max(0, (Date.now() - Date.parse(row.updated_at)) / 1000);
  while (ahead > 0 && f.path.length) {
    const d = f.obj.position.distanceTo(f.path[0]);
    if (d > ahead) { f.obj.position.add(f.path[0].clone().sub(f.obj.position).setLength(ahead)); break; }
    ahead -= d;
    f.obj.position.copy(f.path.shift());
  }
  if (!f.path.length) { // already arrived
    setAction(f, 'idle');
    const res = f.resolveWalk;
    f.resolveWalk = null;
    res?.(true);
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

function partyLights(home, { focus = true } = {}) {
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
  if (focus) focusOn(top);
  return fx;
}

function rainCloud(home, { focus = true } = {}) {
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
  if (focus) focusOn(top);
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

function renameFriend(f, name) {
  f.name = name;
  if (f.label) f.label.el.textContent = name;
  if (f.home) f.home.name = `${name}'s house`;
  if (f.homeLabel) {
    f.homeLabel.el.textContent = f.home.name;
    f.homeLabel.el.style.display = '';
  }
}

function applyTownNames(map) {
  const places = (map && map.places) || {};
  for (const [id, src] of Object.entries(places)) {
    const dest = PLACES[id];
    if (!dest || !src || !src.name) continue;
    dest.name = src.name;
    if (dest.label) dest.label.el.textContent = src.name;
  }
}

function resetTown() {
  for (const k of Object.keys(effects)) { effects[k].destroy(); delete effects[k]; }
  $('#cards').innerHTML = '';
  for (const f of Object.values(friends)) {
    renameFriend(f, FRIENDS.find((d) => d.id === f.id).name);
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
controls.addEventListener('start', () => { focusGoal = null; }); // a drag always wins over an auto-pan
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
    if (!f.obj.visible) continue;
    const li = document.createElement('li');
    li.style.cursor = 'pointer';
    li.innerHTML = `<span class="dot" style="background:${f.color}"></span><div><b></b><div class="status"></div></div>`;
    li.querySelector('b').textContent = f.name;
    li.querySelector('.status').textContent = f.status;
    li.onclick = () => focusFriend(f.id);
    ul.append(li);
  }
}

function placeName(ev) {
  if (ev.building_id && PLACES[ev.building_id]) return PLACES[ev.building_id].name;
  const place = (ev.place || '').toLowerCase();
  if (place === 'home') return 'Home';
  if (place === 'campus') return 'Campus';
  return ev.place || '';
}

function townWall(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const et = new Date(d.getTime() - 4 * 60 * 60 * 1000); // town is America/New_York, EDT in September
  return { y: et.getUTCFullYear(), mo: et.getUTCMonth() + 1, d: et.getUTCDate(), h: et.getUTCHours(), min: et.getUTCMinutes() };
}

function clockDateLabel(iso) {
  const p = townWall(iso);
  if (!p) return '';
  return `${WEEKDAYS[new Date(p.y, p.mo - 1, p.d).getDay()]} ${String(p.d).padStart(2, '0')}/${String(p.mo).padStart(2, '0')}/${p.y}`;
}

function clockTimeRange(startIso, endIso) {
  const fmt = (iso) => {
    const p = townWall(iso);
    if (!p) return '';
    return `${((p.h + 11) % 12) + 1}:${String(p.min).padStart(2, '0')} ${p.h < 12 ? 'AM' : 'PM'}`;
  };
  return `${fmt(startIso)}–${fmt(endIso)}`;
}

let lastSchedSig = '';
function renderSchedules(rows) {
  const root = $('#schedules');
  if (!root) return;
  const list = rows || [];
  const sig = JSON.stringify(list.map((e) => [e.user_id, e.start, e.title]));
  if (sig === lastSchedSig && root.childElementCount) {
    markCurrentScheduleItems(list);
    return;
  }
  lastSchedSig = sig;
  root.innerHTML = '';
  if (!list.length) {
    root.innerHTML = '<div class="sched-where">No calendars shared yet.</div>';
    return;
  }
  const colorOf = {};
  for (const f of Object.values(friends)) colorOf[f.name] = f.color;
  const names = [];
  for (const f of Object.values(friends)) if (f.obj.visible && !names.includes(f.name)) names.push(f.name);
  for (const ev of list) if (ev.display_name && !names.includes(ev.display_name)) names.push(ev.display_name);
  for (const name of names) {
    const mine = list.filter((e) => e.display_name === name).sort((a, b) => (a.start || '').localeCompare(b.start || ''));
    if (!mine.length) continue;
    const block = document.createElement('div');
    block.className = 'sched-person';
    const h = document.createElement('h3');
    h.innerHTML = '<span class="dot"></span><span></span>';
    h.querySelector('.dot').style.background = colorOf[name] || '#667085';
    h.querySelector('span:last-child').textContent = name;
    block.append(h);
    let day = '';
    for (const ev of mine) {
      const d = clockDateLabel(ev.start);
      if (d && d !== day) {
        day = d;
        const hd = document.createElement('div');
        hd.className = 'sched-day';
        hd.textContent = d;
        block.append(hd);
      }
      const item = document.createElement('div');
      item.className = 'sched-item';
      item.dataset.start = ev.start || '';
      item.dataset.end = ev.end || '';
      const where = placeName(ev);
      const withWho = (ev.with_names || []).filter(Boolean).join(', ');
      item.innerHTML = '<div class="sched-when"></div><div class="sched-title"></div><div class="sched-where"></div>';
      item.querySelector('.sched-when').textContent = clockTimeRange(ev.start, ev.end);
      item.querySelector('.sched-title').textContent = ev.title || 'Busy';
      item.querySelector('.sched-where').textContent = [where, withWho && `with ${withWho}`].filter(Boolean).join(' · ');
      block.append(item);
    }
    root.append(block);
  }
  markCurrentScheduleItems(list);
}

function markCurrentScheduleItems() {
  const now = sky.y
    ? new Date(sky.y, sky.mo - 1, sky.d, Math.floor(sky.hour), Math.floor((sky.hour % 1) * 60)).getTime()
    : Date.now();
  document.querySelectorAll('#schedules .sched-item').forEach((el) => {
    const s = Date.parse(el.dataset.start || ''), e = Date.parse(el.dataset.end || '');
    el.classList.toggle('now', Number.isFinite(s) && Number.isFinite(e) && s <= now && now < e);
  });
}

// ---- See-through buildings ------------------------------------------------------------------------
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

function updateOcclusion(dt) {
  const hidden = new Set();
  for (const f of following ? [following] : Object.values(friends)) {
    if (!f.obj.visible) continue;
    const p = f.obj.position.clone().setY(0.25);
    const ndc = p.clone().project(activeCam);
    occRay.setFromCamera(new THREE.Vector2(ndc.x, ndc.y), activeCam);
    const toPerson = occRay.ray.origin.distanceTo(p) - 0.1;
    for (const h of occRay.intersectObjects(occluders, true)) {
      if (h.distance >= toPerson) break;
      hidden.add(h.object.userData.occluderRoot);
    }
  }
  const k = 1 - Math.exp(-dt * 8);
  for (const root of new Set([...hidden, ...fadeState.keys()])) {
    const cur = fadeState.get(root) ?? 1;
    const next = cur + ((hidden.has(root) ? FADED_OPACITY : 1) - cur) * k;
    if (!hidden.has(root) && next > 0.99) { setOpacity(root, 1); fadeState.delete(root); continue; }
    setOpacity(root, next);
    fadeState.set(root, next);
  }
}

// ---- Main loop -------------------------------------------------------------------------------

const clock = new THREE.Clock();
const v = new THREE.Vector3();
const townApi = { liveMode: false };
function frame() {
  const dt = Math.min(clock.getDelta(), 0.1);
  const now = performance.now();
  for (const f of Object.values(friends)) {
    stepFriend(f, dt);
    f.mixer.update(dt);
    if (!townApi.liveMode && !f.busy && !f.path.length && now > f.nextThink) think(f);
  }
  for (const fx of animated) fx.update(dt);
  updateSky(dt);

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
  updateOcclusion(dt);
  renderer.render(scene, activeCam);

  // Labels hide while behind a panel: the panels' frosted blur would smear their colors
  const panels = [...document.querySelectorAll('.panel:not([hidden]), #cards .card')].map((e) => e.getBoundingClientRect());
  for (const l of labels) {
    v.copy(l.getPos()).project(activeCam);
    const [x, y] = [(v.x * 0.5 + 0.5) * innerWidth, (-v.y * 0.5 + 0.5) * innerHeight];
    const covered = panels.some((b) => x > b.left - 40 && x < b.right + 40 && y > b.top && y < b.bottom + 24);
    const hidden = v.z > 1 || covered || (l.el.classList.contains('friend') && !friendVisible(l));
    l.el.style.display = hidden ? 'none' : '';
    l.el.style.left = `${x}px`;
    l.el.style.top = `${y}px`;
  }
  requestAnimationFrame(frame);
}
const friendVisible = (l) => Object.values(friends).find((f) => l.el.textContent === f.name)?.obj.visible ?? true;

// ---- Sky: time of day and weather ------------------------------------------------------------
// Time follows the real local clock unless the slider takes over (or fast-forward is on). Weather
// drifts on its own every couple of minutes until a weather button pins it.

const sky = {
  hour: 12, live: true, fast: false, backend: false,
  y: 0, mo: 0, d: 0,
  weather: 'clear', autoWeather: true, nextWeatherAt: 0,
  cloud: 0, precip: 0, haze: 0, flash: 0, nextFlashAt: 0, night: 0, patchAt: 0,
};
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
function townDateLabel() {
  const y = sky.y, mo = sky.mo, d = sky.d;
  const src = y ? { y, mo, d } : (() => { const n = new Date(); return { y: n.getFullYear(), mo: n.getMonth() + 1, d: n.getDate() }; })();
  const wd = WEEKDAYS[new Date(src.y, src.mo - 1, src.d).getDay()];
  return `${wd} ${String(src.d).padStart(2, '0')}/${String(src.mo).padStart(2, '0')}/${src.y}`;
}
const WEATHER = { // cloud cover, precipitation kind, haze (how far you can see)
  clear: { cloud: 0, kind: null, haze: 0 }, rain: { cloud: 0.6, kind: 'rain', haze: 0.35 },
  storm: { cloud: 0.85, kind: 'rain', haze: 0.6 }, snow: { cloud: 0.5, kind: 'snow', haze: 0.45 },
};
const C = (h) => new THREE.Color(h);
const SKY = { day: C('#9fd3ec'), dusk: C('#f3a36b'), night: C('#1b2b57'), overcastDay: C('#9aa5b3'), overcastNight: C('#232b3d') };
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// Rain streaks and snow flakes share one volume over the town
const VOLUME = { x: N / 2 + 1, z0: -N / 2 - 1, z1: N / 2 + 1, h: 9 };
const DROPS = 2600;
const dropPos = new Float32Array(DROPS * 6);
const dropSeed = Float32Array.from({ length: DROPS * 3 }, Math.random);
const rainGeo = new THREE.BufferGeometry();
rainGeo.setAttribute('position', new THREE.BufferAttribute(dropPos, 3));
const rain = new THREE.LineSegments(rainGeo, new THREE.LineBasicMaterial({ color: '#b9d6ff', transparent: true, opacity: 0.55 }));
// Snow flakes are soft round discs sized in world units, so they grow as the camera zooms in (a
// plain PointsMaterial stays a fixed few pixels under the orthographic camera and reads as noise).
const FLAKES = 4000;
const flakePos = new Float32Array(FLAKES * 3);
const flakeSeed = Float32Array.from({ length: FLAKES * 4 }, Math.random);
const snowGeo = new THREE.BufferGeometry();
snowGeo.setAttribute('position', new THREE.BufferAttribute(flakePos, 3));
snowGeo.setAttribute('size', new THREE.BufferAttribute(Float32Array.from({ length: FLAKES }, () => 0.5 + Math.random() ** 2 * 1.3), 1));
const snow = new THREE.Points(snowGeo, new THREE.ShaderMaterial({
  uniforms: { world: { value: 0.05 }, halfH: { value: 450 }, color: { value: new THREE.Color('#ffffff') }, opacity: { value: 0.95 } },
  vertexShader: `
    attribute float size;
    uniform float world, halfH;
    void main() {
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      gl_Position = projectionMatrix * mv;
      float persp = projectionMatrix[3][3] == 0.0 ? 1.0 / -mv.z : 1.0;
      gl_PointSize = max(1.5, size * world * projectionMatrix[1][1] * halfH * persp);
    }`,
  fragmentShader: `
    uniform vec3 color;
    uniform float opacity;
    void main() {
      float d = length(gl_PointCoord - 0.5);
      gl_FragColor = vec4(color, opacity * smoothstep(0.5, 0.2, d));
    }`,
  transparent: true, depthWrite: false,
}));
rain.frustumCulled = snow.frustumCulled = false;
scene.add(rain, snow);
let fallT = 0;
const wrap = (v, lo, hi) => lo + ((((v - lo) % (hi - lo)) + (hi - lo)) % (hi - lo));

// Weather on surfaces, patched into every lit material's shader (one shared program variant):
// - snow cover: upward faces (grass, roofs, treetops, roads a little) whiten while it snows, melt after
// - wetness: in rain everything darkens a touch, up-facing ground more, and roads turn glossy
// - grey: overcast light washes some color out of the town
// - cloud shadows: soft patches drift across the town while the sun is up
const WX = {
  snowCover: { value: 0 }, wet: { value: 0 }, grey: { value: 0 }, cloudShade: { value: 0 },
  cloudOffset: { value: new THREE.Vector2() },
};
const SNOW_SKIP = new Set(); // water stays as it is
const patched = new WeakSet(); // not userData: clones (see-through buildings) copy that but not the shader hook
const WX_VERTEX = `
  vec4 wxWorld = modelMatrix * vec4(transformed, 1.0);
  vWxXZ = wxWorld.xz;`;
const WX_FRAGMENT = `
  float wxUp = smoothstep(0.5, 0.85, vWxUp);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(dot(diffuseColor.rgb, vec3(0.3, 0.59, 0.11))), grey);
  float wxWet = wet * wetAmount;
  diffuseColor.rgb *= 1.0 - wxWet * mix(0.12, 0.38, wxUp);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.93, 0.95, 0.98), snowCover * snowAmount * wxUp);
  vec2 wxP = vWxXZ * 0.11 + cloudOffset;
  float wxN = wxNoise(wxP) * 0.65 + wxNoise(wxP * 2.3 + 7.1) * 0.35;
  diffuseColor.rgb *= 1.0 - cloudShade * smoothstep(0.48, 0.68, wxN);`;
const WX_NOISE = `
  varying float vWxUp;
  varying vec2 vWxXZ;
  uniform float snowCover, snowAmount, wet, wetAmount, grey, cloudShade;
  uniform vec2 cloudOffset;
  float wxHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float wxNoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(wxHash(i), wxHash(i + vec2(1.0, 0.0)), f.x), mix(wxHash(i + vec2(0.0, 1.0)), wxHash(i + 1.0), f.x), f.y);
  }`;
function addWeather(mat, { snow = 1, wet = 0.5 } = {}) {
  if (patched.has(mat) || SNOW_SKIP.has(mat) || !(mat.isMeshStandardMaterial || mat.isMeshLambertMaterial || mat.isMeshPhongMaterial)) return;
  patched.add(mat);
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, WX, { snowAmount: { value: snow }, wetAmount: { value: wet } });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vWxUp;\nvarying vec2 vWxXZ;')
      .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\nvWxUp = normalize(mat3(modelMatrix) * objectNormal).y;')
      .replace('#include <project_vertex>', `#include <project_vertex>${WX_VERTEX}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>${WX_NOISE}`)
      .replace('#include <map_fragment>', `#include <map_fragment>${WX_FRAGMENT}`)
      // wet roads gloss up (standard materials only; the others have no roughness)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.28, wxWet * wxUp * step(0.9, wetAmount));');
  };
  mat.customProgramCacheKey = () => 'weather';
  mat.needsUpdate = true;
}
function patchWeather() {
  const roads = new Set();
  for (const p of [...Object.values(ROAD), GROUND.paved]) models[p].scene.traverse((m) => { if (m.isMesh) [m.material].flat().forEach((x) => roads.add(x)); });
  scene.traverse((m) => {
    if (!m.isMesh || m.isSkinnedMesh || m.userData.depthPass) return;
    for (const mat of [m.material].flat()) addWeather(mat, roads.has(mat) ? { snow: 0.45, wet: 1 } : undefined);
  });
}

// Night lighting: a glowing bulb and a pool of light under every street light, and lit windows
const glowTex = (() => {
  const cv = Object.assign(document.createElement('canvas'), { width: 64, height: 64 });
  const g = cv.getContext('2d').createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,170,80,1)'); g.addColorStop(0.45, 'rgba(255,150,60,0.45)'); g.addColorStop(1, 'rgba(255,140,50,0)');
  const ctx = cv.getContext('2d'); ctx.fillStyle = g; ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(cv);
})();
const lampGlow = [];
const LAMPS = []; // every street light placed in buildCity: tile position and rotation
function addStreetLamps() {
  const bulbMat = new THREE.MeshBasicMaterial({ color: '#ffc27a', transparent: true }); // warm sodium-ish glow
  const poolMat = new THREE.MeshBasicMaterial({ map: glowTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
  lampGlow.pools = [];
  for (const { x, z, rotY } of LAMPS) {
    // The lamp's arm reaches 0.207 tiles along its local -x; rotate that to find the bulb
    const head = pos(x - 0.207 * Math.cos(rotY), z + 0.207 * Math.sin(rotY));
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.035, 10, 8), bulbMat);
    bulb.position.copy(head).setY(0.55);
    const pool = new THREE.Mesh(new THREE.CircleGeometry(0.55, 24), poolMat);
    pool.rotation.x = -Math.PI / 2;
    pool.position.copy(head).setY(0.025);
    scene.add(bulb, pool);
    lampGlow.push(bulb, pool);
    lampGlow.pools.push(pool);
  }
  lampGlow.materials = [bulbMat, poolMat];
}
// Lit windows. Each wall triangle of a building is sampled at its texture color: Kenney glass is a
// light sky blue, SimplePoly windows a flat dark grey (its walls are often blue, so one color rule
// can't serve both). Window faces go into a second material group that glows at night; only ~60% of
// panes are lit so it reads as occupied rooms, not a glowing facade.
const windowMats = new Set();
const texPixels = new Map();
function pixelsOf(tex) {
  if (!texPixels.has(tex)) {
    const img = tex.image;
    const cv = Object.assign(document.createElement('canvas'), { width: img.width, height: img.height });
    const ctx = cv.getContext('2d');
    ctx.drawImage(img, 0, 0);
    texPixels.set(tex, { w: cv.width, h: cv.height, data: ctx.getImageData(0, 0, cv.width, cv.height).data });
  }
  return texPixels.get(tex);
}
const isGlass = {
  kenney: (r, g, b) => b > 165 && b - r > 40,
  simplepoly: (r, g, b) => Math.max(r, g, b) - Math.min(r, g, b) < 18 && (r + g + b) / 3 > 40 && (r + g + b) / 3 < 110,
};
const litCopies = new Map();
function lightWindows(obj, pack) {
  obj.traverse((m) => {
    if (!m.isMesh || Array.isArray(m.material) || !m.material.map) return;
    const g = m.geometry;
    if (!g.userData.windowTris) { // split once per shared geometry: [wall..., lit window...]
      const src = g.index ? g.toNonIndexed() : g;
      const P = src.attributes.position, UV = src.attributes.uv, tris = P.count / 3;
      const px = pixelsOf(m.material.map);
      const [a, b, c, n] = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
      const lit = [];
      for (let t = 0; t < tris; t++) {
        a.fromBufferAttribute(P, t * 3); b.fromBufferAttribute(P, t * 3 + 1); c.fromBufferAttribute(P, t * 3 + 2);
        n.subVectors(c, b).cross(a.clone().sub(b)).normalize();
        let on = false;
        if (UV && Math.abs(n.y) < 0.3 && ((Math.floor(t / 2) * 2654435761) >>> 0) % 10 < 6) {
          const u = (UV.getX(t * 3) + UV.getX(t * 3 + 1) + UV.getX(t * 3 + 2)) / 3;
          const v = (UV.getY(t * 3) + UV.getY(t * 3 + 1) + UV.getY(t * 3 + 2)) / 3;
          const x = Math.min(px.w - 1, Math.max(0, Math.floor((((u % 1) + 1) % 1) * px.w)));
          const y = Math.min(px.h - 1, Math.max(0, Math.floor((((v % 1) + 1) % 1) * px.h)));
          const o = (y * px.w + x) * 4;
          on = isGlass[pack](px.data[o], px.data[o + 1], px.data[o + 2]);
        }
        lit.push(on);
      }
      const order = [...Array(tris).keys()].sort((x, y) => lit[x] - lit[y]);
      const out = new THREE.BufferGeometry();
      for (const name of Object.keys(src.attributes)) {
        const at = src.attributes[name], k = at.itemSize, arr = new Float32Array(at.count * k);
        order.forEach((t, i) => { for (let v = 0; v < 3; v++) for (let j = 0; j < k; j++) arr[(i * 3 + v) * k + j] = at.getComponent(t * 3 + v, j); });
        out.setAttribute(name, new THREE.BufferAttribute(arr, k, at.normalized));
      }
      const walls = lit.filter((x) => !x).length;
      out.addGroup(0, walls * 3, 0);
      out.addGroup(walls * 3, (tris - walls) * 3, 1);
      out.userData.windowTris = tris - walls;
      g.userData.windowTris = out; // later clones of this model reuse the split
    }
    const split = g.userData.windowTris instanceof THREE.BufferGeometry ? g.userData.windowTris : g;
    if (!split.userData.windowTris) return;
    if (!litCopies.has(m.material)) {
      const glow = m.material.clone();
      glow.emissive = new THREE.Color('#ffc978');
      glow.emissiveIntensity = 0;
      windowMats.add(glow);
      litCopies.set(m.material, glow);
    }
    m.geometry = split;
    m.material = [m.material, litCopies.get(m.material)];
  });
}

function setWeather(w, pinned = true) {
  sky.weather = w;
  if (pinned) sky.autoWeather = false;
  document.querySelectorAll('[data-weather]').forEach((b) => b.classList.toggle('on', b.dataset.weather === (sky.autoWeather ? 'auto' : w)));
  logFeed(`Weather: ${w}${sky.autoWeather ? ' (changing on its own)' : ''}.`);
}

function updateSky(dt) {
  const now = new Date();
  if (sky.live && !sky.backend) sky.hour = now.getHours() + now.getMinutes() / 60;
  else if (sky.fast) sky.hour = (sky.hour + dt * (24 / 120)) % 24; // a whole day in two minutes
  if (sky.autoWeather && performance.now() > sky.nextWeatherAt) {
    const kinds = ['clear', 'clear', 'rain', 'storm', 'snow'];
    if (TILES) { // real towns: weather follows a shared wall-clock schedule, so everyone sees the same sky
      const w = kinds[(Math.imul(Math.floor(Date.now() / 110000), 2654435761) >>> 0) % kinds.length];
      if (w !== sky.weather) setWeather(w, false);
      sky.nextWeatherAt = performance.now() + 5000;
    } else {
      if (sky.nextWeatherAt) setWeather(kinds[Math.floor(Math.random() * 5)], false);
      sky.nextWeatherAt = performance.now() + 70000 + Math.random() * 80000;
    }
  }
  const w = WEATHER[sky.weather];
  sky.cloud += (w.cloud - sky.cloud) * Math.min(1, dt * 0.6);
  sky.precip += ((w.kind ? 1 : 0) - sky.precip) * Math.min(1, dt * 0.5);
  sky.haze += (w.haze - sky.haze) * Math.min(1, dt * 0.4);

  // Sun: rises at 6, sets at 18. `el` is its height (-1..1); twilight glows near the horizon.
  const a = ((sky.hour - 6) / 12) * Math.PI, el = Math.sin(a);
  const day = smooth(-0.12, 0.2, el), twilight = Math.max(0, 1 - Math.abs(el) / 0.28) * smooth(-0.3, 0, el);
  sky.night = 1 - day;
  const col = SKY.night.clone().lerp(SKY.day, day).lerp(SKY.dusk, twilight * 0.7);
  col.lerp(SKY.overcastNight.clone().lerp(SKY.overcastDay, day), sky.cloud * 0.8);
  if (sky.flash > 0) col.lerp(C('#e8eeff'), sky.flash);
  scene.background.copy(col);

  const up = Math.max(el, 0.18);
  if (day > 0.02) sun.position.set(-Math.cos(a) * 14, up * 16, 6);
  else sun.position.set(Math.cos(a) * 10, 12, -4); // moonlight from the other side
  // Under cloud the sun goes cool and weak and shadows soften, so the light is flat and grey; the
  // sky light carries more of the scene. Snow on the ground bounces light back up.
  sun.color.copy(C('#fff4e0')).lerp(C('#ffb070'), twilight).lerp(C('#9fb3ff'), 1 - day).lerp(C('#c9d3e2'), sky.cloud * 0.8 * day);
  sun.intensity = (0.6 + 1.6 * day) * (1 - 0.8 * sky.cloud) + sky.flash * 2.5;
  sun.shadow.intensity = 1 - 0.75 * sky.cloud;
  hemi.intensity = (0.85 + 0.75 * day) * (1 - 0.2 * sky.cloud) + sky.flash * 1.5;
  hemi.color.copy(C('#8494cc')).lerp(C('#ffffff'), day).lerp(C('#c4cfdf'), sky.cloud * 0.7 * day);
  hemi.groundColor.copy(C('#34405a')).lerp(C('#8a9a7a'), day).lerp(C('#dfe6ee'), WX.snowCover.value * day);

  // Haze: the far side of town fades into the sky color. The range is measured from the camera's
  // distance to what it looks at, so it reads the same zoomed in, zoomed out or following someone.
  const look = following ? following.obj.position : controls.target;
  const d = activeCam.position.distanceTo(look);
  scene.fog.color.copy(col);
  scene.fog.near = sky.haze > 0.01 ? d - 4 : 1000;
  scene.fog.far = sky.haze > 0.01 ? d - 4 + 14 / sky.haze : 2000;

  // Surfaces: wet in rain (dries slowly), a little greyer under cloud, and cloud shadows drifting by
  // while the sun is up (a few fair-weather clouds even on clear days)
  WX.wet.value = Math.min(1, Math.max(0, WX.wet.value + (w.kind === 'rain' ? dt / 15 : -dt / 60)));
  WX.grey.value = sky.cloud * 0.45;
  WX.cloudShade.value = (sky.weather === 'clear' ? 0.2 : 0.1 + 0.22 * 4 * sky.cloud * (1 - sky.cloud)) * day;
  WX.cloudOffset.value.x -= dt * 0.035 * (sky.weather === 'storm' ? 3 : 1);
  WX.cloudOffset.value.y -= dt * 0.02 * (sky.weather === 'storm' ? 3 : 1);

  // Lightning in storms: a quick double flash every few seconds
  if (sky.weather === 'storm' && performance.now() > sky.nextFlashAt) {
    sky.flash = 1;
    sky.nextFlashAt = performance.now() + 3500 + Math.random() * 6000;
  }
  sky.flash = Math.max(0, sky.flash - dt * 5);

  // Night lights
  const lit = smooth(0.35, 0.8, sky.night + sky.cloud * 0.25);
  for (const m of lampGlow.materials ?? []) m.opacity = lit;
  for (const g of lampGlow) g.visible = lit > 0.01;
  if (lampGlow.materials) lampGlow.materials[1].opacity = lit * (1 + 0.6 * WX.wet.value); // wet streets throw the light back
  for (const g of lampGlow.pools ?? []) g.scale.setScalar(1 + 0.35 * WX.wet.value);
  for (const m of windowMats) m.emissiveIntensity = lit * 1.4;

  // Precipitation: only a share of the drops fall, ramping with the weather
  fallT += dt;
  const kind = w.kind ?? (sky.precip > 0.02 ? (snow.visible ? 'snow' : 'rain') : null);
  const count = Math.floor(DROPS * sky.precip * (sky.weather === 'storm' ? 1 : 0.6));
  const flakes = Math.floor(FLAKES * sky.precip);
  rain.visible = kind === 'rain' && count > 0;
  snow.visible = kind === 'snow' && flakes > 0;
  const span = VOLUME.z1 - VOLUME.z0;
  if (rain.visible) for (let i = 0; i < count; i++) {
    const [sx, sy, sz] = [dropSeed[i * 3], dropSeed[i * 3 + 1], dropSeed[i * 3 + 2]];
    const x = (sx * 2 - 1) * VOLUME.x, z = VOLUME.z0 + sz * span;
    const y = VOLUME.h - ((sy * VOLUME.h + fallT * 9) % VOLUME.h);
    dropPos.set([x, y, z, x - 0.04, y + 0.28, z - 0.02], i * 6);
  }
  if (snow.visible) for (let i = 0; i < flakes; i++) {
    // Each flake falls at its own pace, flutters, and drifts with a light breeze (wrapping around the volume)
    const [sx, sy, sz, sp] = [flakeSeed[i * 4], flakeSeed[i * 4 + 1], flakeSeed[i * 4 + 2], flakeSeed[i * 4 + 3]];
    const fall = fallT * (0.35 + sp * 0.35);
    const y = VOLUME.h - ((sy * VOLUME.h + fall) % VOLUME.h);
    const x = wrap((sx * 2 - 1) * VOLUME.x + fall * 0.35 + Math.sin(fallT * (0.6 + sp) + sx * 40) * 0.25, -VOLUME.x, VOLUME.x);
    const z = wrap(VOLUME.z0 + sz * span + Math.cos(fallT * (0.5 + sp) + sz * 40) * 0.25, VOLUME.z0, VOLUME.z1);
    flakePos.set([x, y, z], i * 3);
  }
  rainGeo.setDrawRange(0, count * 2);
  snowGeo.setDrawRange(0, flakes);
  snow.material.uniforms.halfH.value = renderer.domElement.height / 2;
  snow.material.uniforms.color.value.setScalar(0.55 + 0.45 * (1 - sky.night)); // flakes dim at night

  // Snow settles while it snows and melts (faster in rain) once it stops
  const settle = sky.weather === 'snow' ? dt / 30 : -dt / (w.kind === 'rain' ? 12 : 45);
  WX.snowCover.value = Math.min(1, Math.max(0, WX.snowCover.value + settle));
  if (performance.now() > sky.patchAt) { // pick up materials cloned since (see-through buildings)
    patchWeather();
    sky.patchAt = performance.now() + 2000;
  }
  rainGeo.attributes.position.needsUpdate = snowGeo.attributes.position.needsUpdate = true;
  rain.material.opacity = sky.weather === 'storm' ? 0.7 : 0.5;

  const label = document.querySelector('#clock');
  if (label) {
    const h = Math.floor(sky.hour), m = Math.floor((sky.hour % 1) * 60);
    label.textContent = `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}${sky.live ? ' · live' : sky.fast ? ' · ⏩' : ''}`;
    const slider = document.querySelector('#time');
    if (document.activeElement !== slider) slider.value = sky.hour;
  }
  const dateEl = document.querySelector('#town-date');
  if (dateEl) dateEl.textContent = townDateLabel();
  if (document.querySelector('#schedules .sched-item')) markCurrentScheduleItems();
}

function hourFromIso(iso) {
  const m = String(iso || '').match(/T(\d{2}):(\d{2}):(\d{2})/);
  return m ? +m[1] + +m[2] / 60 + +m[3] / 3600 : null;
}

function dateFromIso(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? { y: +m[1], mo: +m[2], d: +m[3] } : null;
}

function applyTownTime(iso, mode) {
  const ymd = dateFromIso(iso);
  if (ymd) { sky.y = ymd.y; sky.mo = ymd.mo; sky.d = ymd.d; }
  const hour = hourFromIso(iso);
  if (hour == null) return;
  sky.backend = true;
  if (document.activeElement === document.querySelector('#time')) return;
  // The slider owns the clock until Live / Fast is clicked. Don't snap back to "live".
  if (!sky.live && !sky.fast && mode === 'live') return;
  sky.hour = hour;
  if (mode === 'live') { sky.live = true; sky.fast = false; }
  if (mode === 'fast') { sky.live = false; sky.fast = true; }
  if (mode === 'scrub') { sky.live = false; sky.fast = false; }
}

function wireSkyControls() {
  const slider = document.querySelector('#time');
  let clockTimer = null;
  const sendClock = (body) => {
    if (!townApi.pushClock) return;
    townApi.pushClock(body).catch(() => {});
  };
  slider.oninput = () => {
    sky.live = false;
    sky.fast = false;
    sky.hour = +slider.value;
    clearTimeout(clockTimer);
    clockTimer = setTimeout(() => sendClock({ hour: sky.hour, live: false, fast: false }), 80);
  };
  slider.onchange = () => sendClock({ hour: sky.hour, live: false, fast: false });
  document.querySelector('#time-live').onclick = () => { sky.live = true; sky.fast = false; sendClock({ live: true }); };
  document.querySelector('#time-fast').onclick = () => { sky.live = false; sky.fast = true; sendClock({ fast: true }); };
  document.querySelectorAll('[data-weather]').forEach((b) => {
    b.onclick = () => {
      if (b.dataset.weather === 'auto') { sky.autoWeather = true; sky.nextWeatherAt = 1; setWeather(sky.weather, false); return; }
      setWeather(b.dataset.weather);
    };
  });
  const p = new URLSearchParams(location.search);
  if (p.has('hour')) { sky.live = false; sky.hour = +p.get('hour'); }
  if (p.has('weather')) { // start already in that weather instead of easing in
    setWeather(p.get('weather'));
    sky.cloud = WEATHER[sky.weather].cloud;
    sky.precip = WEATHER[sky.weather].kind ? 1 : 0;
    if (sky.weather === 'snow') WX.snowCover.value = 1;
    if (WEATHER[sky.weather].kind === 'rain') WX.wet.value = 1;
  }
}

// ---- Boot ----------------------------------------------------------------------------------------

const allModels = [
  ...ZONES.flatMap((z) => z.models),
  ...Object.values(PLACES).filter((p) => p.model).map((p) => p.model),
  ...FRIENDS.map((f) => `${CH}${f.model}.glb`), ...FRIENDS.map((f) => f.home.model),
  ...Object.values(ROAD), ...Object.values(GROUND), ...PARK_TREES, ...Object.values(PROPS), ...Object.values(NATURE),
  ...ROOF_PROPS, HELIPAD, ...VEHICLES, STADIUM.model,
  ...Object.values(STREET), ...EXTRA_MODELS.map(([, , m]) => m),
];
logFeed('Loading city…');
await loadAll(allModels);
buildCity();
addStreetLamps();
scene.traverse((o) => { if (o.userData.building) lightWindows(o, o.userData.building); });
patchWeather();
wireSkyControls();
spawnFriends();
renderResidents();
Object.assign(townApi, {
  friends, walkTo, say, setStatus, partyLights, rainCloud, showCard, logFeed, renameFriend, renderResidents,
  renderSchedules, PLACES, FRIENDS, effects, trigger, applyTownTime, applyTownNames, liveMode: Boolean(TOWN),
});
if (TOWN) {
  // A real town: no scripted wandering or demo snapshot; residents move only as the database says
  $('#side .title').textContent = TOWN.town.name;
  $('#side .sub').textContent = `Invite code: ${TOWN.town.invite_code}`;
  document.querySelectorAll('#triggers [data-trigger], #triggers h2:first-child, #triggers .note').forEach((e) => { e.hidden = true; });
  const homeless = TOWN.members.length - FRIENDS.length;
  logFeed(`${TOWN.town.name} loaded.${homeless ? ` ${homeless} member(s) haven't placed a house yet.` : ''}`);
  startTownSync(TOWN_ID, TOWN, { friends, placeAgent, setStatus, say, partyLights, rainCloud, logFeed, PLACES });
} else {
  logFeed('Town loaded. Demo buttons try the live backend, then fall back to scripted playback.');
  const { triggerViaBackend, pushClock } = startTownBackend(townApi);
  townApi.pushClock = pushClock;
  document.querySelectorAll('[data-trigger]').forEach((b) => { b.onclick = () => triggerViaBackend(b.dataset.trigger); });
  const params = new URLSearchParams(location.search);
  if (friends[params.get('follow')]) startFollow(friends[params.get('follow')]);
  const auto = params.get('auto');
  auto?.split(',').forEach((t, i) => setTimeout(() => triggerViaBackend(t), 1500 + i * 2500));
}
frame();

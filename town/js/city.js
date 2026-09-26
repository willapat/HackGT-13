// Building the city from the grid: roads, lots and buildings, parks, landmarks, homes, street furniture.
import * as THREE from 'three';
import { CURBSIDE, GROUND, HELIPAD, HOUSES, METER, NATURE, PARASOLS, PARK_TREES, PROPS, ROAD, ROOF_PROPS, SP, STREET, VEHICLES, ZONES } from './assets.js';
import { addLabel } from './hud.js';
import { BG_COLOR, BG_ROOFS, CENTER, DRAWN, EXTRA_MODELS, FARM, FRIENDS, inkOn, inPark, isRoad, key, N, PLACES, pos, ROADS, STADIUM, tileAt, TILES, tilesOf, TREES } from './layout.js';
import { place } from './models.js';
import { LAMPS, sky } from './sky.js';
import { animated, scene, water } from './stage.js';

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
  pivot.userData.animated = true; // spins every frame: finishCity() must not freeze it
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
// In drawn towns a building may stand by a trail, a beach or a lawn instead of a road: it faces that
const walkSides = (c, r) => [[0, 1], [1, 0], [0, -1], [-1, 0]].filter(([dc, dr]) => tileAt(c + dc, r + dr) !== undefined && inPark(c + dc, r + dr));
function faceRoad(c, r) {
  const sides = roadSides(c, r).length || !DRAWN ? roadSides(c, r) : walkSides(c, r);
  if (!sides.length) return null;
  const [dc, dr] = sides[(c + r) % sides.length];
  return Math.atan2(dc, dr);
}
const isCorner = (c, r) => roadSides(c, r).length >= 2;

const blocked = new Set();
export const occluders = []; // buildings and trees that fade out when they hide a person
function addOccluder(root) {
  occluders.push(root);
  root.traverse((m) => { m.userData.occluderRoot = root; });
}
export const topOf = {}; // building roof height by tile, for labels/effects
// Named buildings you can click (places and friends' houses): their roots carry userData.buildingId
export const clickable = [];
const openBuilding = (id) => dispatchEvent(new CustomEvent('town:building', { detail: id })); // handled in buildings.js

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

// Road tiles pick their piece from which neighbours are road too: straight, corner, T or crossing
// (N, E, S, W = r-1, c+1, r+1, c-1). A turn of +90deg about y takes the model's south side to the east.
const ROAD_TURN = { corner: 0, tee: 0 }; // rotY offsets (in quarter turns) that line each model up; both 0, checked by eye
function roadPiece(c, r) {
  // Part of a road area two or more tiles wide (a square, a wide avenue): plain asphalt, no lane markings
  if ([[0, 0], [-1, 0], [0, -1], [-1, -1]].some(([x, y]) => [[0, 0], [1, 0], [0, 1], [1, 1]].every(([dx, dy]) => isRoad(c + x + dx, r + y + dy)))) {
    return place(ROAD.plain, c, r);
  }
  const arms = [isRoad(c, r - 1), isRoad(c + 1, r), isRoad(c, r + 1), isRoad(c - 1, r)];
  const n = arms.filter(Boolean).length;
  const turn = (from, to) => ((from - to) * Math.PI) / 2;
  if (n === 4) return place(ROAD.cross, c, r);
  if (n === 3) return place(ROAD.tee, c, r, { rotY: turn(ROAD_TURN.tee, arms.indexOf(false)) });
  const bend = [0, 1, 2, 3].find((d) => arms[d] && arms[(d + 1) % 4]);
  if (n === 2 && bend !== undefined) return place(ROAD.corner, c, r, { rotY: turn(ROAD_TURN.corner, bend) });
  return place(ROAD.straight, c, r, { rotY: arms[1] || arms[3] ? Math.PI / 2 : 0 }); // model runs along z
}
// A flat colored ground tile (sand, lake shore)
function flat(c, r, color, size = 1, y = 0.004) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(size, 0.008, size), new THREE.MeshLambertMaterial({ color }));
  m.position.copy(pos(c, r)).setY(y);
  m.receiveShadow = true;
  scene.add(m);
  return m;
}
// A dirt trail: a light brown track from the tile's middle toward every neighbouring trail, road or doorway.
// A trail that ends here runs on through the tile, so it fades into the grass instead of stopping short.
const trailDoors = new Set(); // "building c,r>door c,r": a place or driveway that opens onto a trail tile
function trail(c, r) {
  const dirs = [[0, -1], [1, 0], [0, 1], [-1, 0]];
  const joins = dirs.map(([dc, dr]) => ['path', 'road', 'bridge'].includes(tileAt(c + dc, r + dr)) || trailDoors.has(`${key(c + dc, r + dr)}>${key(c, r)}`));
  if (joins.filter(Boolean).length === 1) { const d = joins.indexOf(true); joins[(d + 2) % 4] = true; }
  if (!joins.some(Boolean)) joins[0] = joins[2] = true;
  const mat = new THREE.MeshLambertMaterial({ color: '#c9a878' });
  const isTrail = (x, y) => tileAt(x, y) === 'path';
  if ([[0, 0], [-1, 0], [0, -1], [-1, -1]].some(([x, y]) => [[0, 0], [1, 0], [0, 1], [1, 1]].every(([dx, dy]) => isTrail(c + x + dx, r + y + dy)))) {
    flat(c, r, '#c9a878', 1, 0.008); // part of a wide trail area (a clearing, a village square): all dirt
    return;
  }
  const add = (w, d, x, z) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.012, d), mat);
    m.position.copy(pos(c + x, r + z)).setY(0.008);
    m.receiveShadow = true;
    scene.add(m);
  };
  add(0.34, 0.34, 0, 0);
  dirs.forEach(([dc, dr], i) => { if (joins[i]) add(0.34, 0.34, dc * 0.33, dr * 0.33); });
}

// A road bridge: the road piece lifted a little over the water, with a railing along each side
function bridge(c, r) {
  const ew = isRoad(c - 1, r) || isRoad(c + 1, r);
  const deck = place(ROAD.straight, c, r, { rotY: ew ? Math.PI / 2 : 0 });
  deck.position.y = 0.05;
  const mat = new THREE.MeshLambertMaterial({ color: '#d9d4ca' });
  for (const side of [-0.47, 0.47]) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(ew ? 1 : 0.05, 0.09, ew ? 0.05 : 1), mat);
    rail.position.copy(pos(c + (ew ? 0 : side), r + (ew ? side : 0))).setY(0.1);
    rail.castShadow = true;
    scene.add(rail);
  }
}

// Wooden planks on posts, running the way the trail does
function dock(c, r) {
  const along = ['path', 'road', 'sand', 'park'];
  const ew = along.includes(tileAt(c - 1, r)) || along.includes(tileAt(c + 1, r));
  const ns = along.includes(tileAt(c, r - 1)) || along.includes(tileAt(c, r + 1));
  const wood = new THREE.MeshLambertMaterial({ color: '#a8743f' });
  const deck = new THREE.Mesh(new THREE.BoxGeometry(ew || !ns ? 1.02 : 0.5, 0.035, ns ? 1.02 : 0.5), wood);
  deck.position.copy(pos(c, r)).setY(0.05);
  deck.castShadow = deck.receiveShadow = true;
  scene.add(deck);
  for (const [x, z] of [[-0.2, -0.2], [0.2, -0.2], [-0.2, 0.2], [0.2, 0.2]]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.1, 6), new THREE.MeshLambertMaterial({ color: '#7a5230' }));
    post.position.copy(pos(c + x, r + z)).setY(0.03);
    scene.add(post);
  }
}

export function buildCity() {
  const reserved = new Map();
  const placeIdAt = new Map(Object.entries(PLACES).filter(([, p]) => p.model).map(([id, p]) => [key(p.c, p.r), id]));
  const doorOf = new Map(); // named places face the road their door is on
  for (const p of Object.values(PLACES)) if (p.model) { reserved.set(key(p.c, p.r), p.model); doorOf.set(key(p.c, p.r), p.door); }
  for (const [c, r, model] of EXTRA_MODELS) reserved.set(key(c, r), model);
  const yards = new Map(); // tiles of a friend's block -> friend
  for (const f of FRIENDS) for (const t of f.block) yards.set(key(...t), f);
  const special = new Set([...STADIUM.tiles, ...FARM.tiles].map((t) => key(...t)));
  const doors = new Set([...Object.values(PLACES), ...FRIENDS.map((f) => f.home)].map((a) => key(...a.door)));
  for (const p of Object.values(PLACES)) if (p.model) trailDoors.add(`${key(p.c, p.r)}>${key(...p.door)}`);
  for (const f of FRIENDS) trailDoors.add(`${key(f.home.c, f.home.r)}>${key(...f.home.door)}`);
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

  // Decorative tiles: small scenes (props at their normal scale) that fill space between buildings
  const turn = (c, r) => faceRoad(c, r) ?? ((c + r) % 4) * (Math.PI / 2);
  const DECOR = {
    // Scenery for drawn towns (backend/towngen/freeform.py): pine forest, lakes, boulders, campfires
    forest: (c, r) => {
      place(GROUND.grass, c, r);
      [[-0.24, -0.2], [0.22, -0.16], [-0.02, 0.24]].forEach(([x, z], i) => {
        const h = hash(c * 7 + i * 13, r * 5 + i * 3);
        addOccluder(place(PARK_TREES[1], c + x + (h - 0.5) * 0.12, r + z + (hash(r + i, c) - 0.5) * 0.12, { scale: 1.7 + h * 0.9, rotY: h * 6 }));
      });
      if (hash(c, r * 3) < 0.4) place(NATURE['bush-02'], c + 0.3, r + 0.3, { scale: 2 });
    },
    lake: (c, r) => {
      flat(c, r, '#d8c796'); // shore: shows where the water pulls back from the land
      const land = (dc, dr) => tileAt(c + dc, r + dr) !== undefined && !['lake', 'bridge'].includes(tileAt(c + dc, r + dr));
      const [w, e, n, so] = [land(-1, 0), land(1, 0), land(0, -1), land(0, 1)].map((l) => (l ? 0.1 : 0));
      const g = new THREE.PlaneGeometry(1 - w - e, 1 - n - so, 4, 4);
      g.rotateX(-Math.PI / 2);
      g.translate(pos(c, r).x + (w - e) / 2, 0.02, pos(c, r).z + (n - so) / 2);
      water(g);
    },
    rocks: (c, r) => {
      flat(c, r, hash(c, r) < 0.5 ? '#aaa79c' : '#9e9b91'); // bare stone: a mountainside or a rocky point
      place(NATURE['rock-big'], c - 0.12, r - 0.08, { scale: 2.6, rotY: hash(c, r) * 6 });
      place(NATURE['rock-small'], c + 0.28, r + 0.2, { scale: 2.2, rotY: hash(r, c) * 6 });
      place(NATURE['rock-small'], c - 0.3, r + 0.3, { scale: 1.6 });
      place(NATURE['bush-01'], c + 0.25, r - 0.3, { scale: 1.8 });
    },
    campfire: (c, r) => {
      place(GROUND.grass, c, r);
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        place(NATURE['rock-small'], c + Math.cos(a) * 0.17, r + Math.sin(a) * 0.17, { scale: 1.1, rotY: a });
      }
      const wood = new THREE.MeshLambertMaterial({ color: '#7a4a2a' });
      for (let i = 0; i < 3; i++) {
        const log = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.24, 6), wood);
        log.rotation.set(Math.PI / 2 - 0.35, (i / 3) * Math.PI * 2, 0, 'YXZ');
        log.position.copy(pos(c, r)).setY(0.05);
        log.castShadow = true;
        scene.add(log);
      }
      const fire = new THREE.Group();
      fire.position.copy(pos(c, r)).setY(0.02);
      for (const [color, rad, h] of [['#ff7a1a', 0.08, 0.2], ['#ffd34d', 0.045, 0.13]]) {
        const flame = new THREE.Mesh(new THREE.ConeGeometry(rad, h, 7), new THREE.MeshBasicMaterial({ color }));
        flame.position.y = h / 2;
        fire.add(flame);
      }
      scene.add(fire);
      const phase = c * 1.7 + r;
      animated.add({ update() { const t = performance.now() / 120 + phase; fire.scale.set(1 + Math.sin(t * 1.3) * 0.08, 1 + Math.sin(t) * 0.18, 1 + Math.cos(t * 1.1) * 0.08); } });
      place(PROPS['bench-1'], c, r - 0.38, { scale: 1.6, rotY: Math.PI }); // benches face -z: both look at the fire
      place(PROPS['bench-1'], c, r + 0.38, { scale: 1.6 });
    },
    garden: (c, r) => {
      place(GROUND.grass, c, r);
      greenery(c, r, c * 3 + r);
      place(NATURE['bush-03'], c + 0.28, r - 0.26, { scale: 2.4 });
      place(NATURE['rock-small'], c - 0.3, r + 0.28, { scale: 2 });
    },
    picnic: (c, r) => {
      place(GROUND.grass, c, r);
      place(PROPS['bench-1'], c, r - 0.15, { scale: 2, rotY: turn(c, r) });
      place(NATURE['pot-bush-small'], c + 0.32, r + 0.3, { scale: 2.2 });
      place(NATURE['bush-01'], c - 0.32, r + 0.3, { scale: 2.2 });
    },
    plaza: (c, r) => {
      place(GROUND.paved, c, r);
      // Part of a big plaza (a square, a quad): mostly open paving, one fountain in the middle, the odd bench
      const around = [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([dc, dr]) => tileAt(c + dc, r + dr) === 'plaza').length;
      if (around >= 2) {
        if (around === 4 && hash(c * 3, r * 7) < 0.3) {
          place(STREET.drinking_fountain_01, c, r, { scale: METER });
          for (const [dx, dz] of [[-0.32, -0.32], [0.32, 0.32]]) place(NATURE['pot-bush-small'], c + dx, r + dz, { scale: 2.2 });
        } else if (hash(c, r * 5) < 0.3) place(STREET.public_bench_01, c + 0.3, r, { scale: METER, rotY: Math.PI / 2 });
        else if (hash(r, c * 5) < 0.2) place(NATURE['pot-bush-big'], c, r, { scale: 2.2 });
        return;
      }
      place(STREET.drinking_fountain_01, c + 0.1, r - 0.1, { scale: METER, rotY: turn(c, r) });
      place(STREET.public_bench_01, c - 0.3, r + 0.25, { scale: METER, rotY: Math.PI / 2 });
      place(NATURE['pot-bush-big'], c + 0.3, r + 0.3, { scale: 2.2 });
    },
    patio: (c, r) => {
      place(GROUND.paved, c, r);
      place(PARASOLS[0], c - 0.2, r - 0.2, { fit: 0.38 });
      place(PARASOLS[1], c + 0.22, r + 0.2, { fit: 0.38 });
      place(PROPS['coffee-shop-chair'], c + 0.3, r - 0.3, { scale: 1.6 });
      place(PROPS['coffee-shop-chair'], c - 0.32, r + 0.3, { scale: 1.6 });
    },
    // Building blocks for symmetric parks: a big tree, a fountain, and benches facing n/s/e/w
    oak: (c, r) => {
      place(GROUND.grass, c, r);
      addOccluder(place(PARK_TREES[0], c, r, { scale: 2.6 }));
    },
    fountain: (c, r) => {
      place(GROUND.paved, c, r);
      place(STREET.drinking_fountain_01, c, r, { scale: METER });
      for (const [dx, dz] of [[-0.32, -0.32], [0.32, -0.32], [-0.32, 0.32], [0.32, 0.32]]) place(NATURE['pot-bush-small'], c + dx, r + dz, { scale: 2.2 });
    },
    water: (c, r) => { // a small round pond with a stone rim, like the central park's
      place(GROUND.grass, c, r);
      const pool = new THREE.CircleGeometry(0.36, 20);
      pool.rotateX(-Math.PI / 2);
      pool.translate(pos(c, r).x, 0.02, pos(c, r).z);
      water(pool);
      const rim = new THREE.Mesh(new THREE.RingGeometry(0.36, 0.42, 20), new THREE.MeshLambertMaterial({ color: '#b9ad97' }));
      rim.rotation.x = -Math.PI / 2;
      rim.position.copy(pos(c, r)).setY(0.025);
      scene.add(rim);
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
        place(NATURE['rock-small'], c + Math.cos(a) * 0.42, r + Math.sin(a) * 0.42, { scale: 1.4, rotY: a });
      }
    },
    ...Object.fromEntries(Object.entries({ n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0] }).map(([dir, [fx, fz]]) => [`bench-${dir}`, (c, r) => {
      // A bench whose long side faces `dir` (bench models face -z at rotY 0), pulled toward that side,
      // with two small trees behind it
      place(GROUND.grass, c, r);
      place(PROPS['bench-1'], c + fx * 0.22, r + fz * 0.22, { scale: 2, rotY: Math.atan2(-fx, -fz) });
      for (const s of [-1, 1]) addOccluder(place(PARK_TREES[1], c - fx * 0.3 + fz * s * 0.3, r - fz * 0.3 + fx * s * 0.3, { scale: 1.6 }));
    }])),
  };

  // ---- Roads, lots and buildings
  let roofN = 0, curbN = 0;
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      if (!TILES) {
        const onR = ROADS.includes(r), onC = ROADS.includes(c);
        if (onR && onC) { place(ROAD.cross, c, r); continue; }
        if (onR) { place(ROAD.straight, c, r, { rotY: Math.PI / 2 }); continue; } // model runs along z
        if (onC) { place(ROAD.straight, c, r); continue; }
      }
      if (TILES && tileAt(c, r) === undefined) { blocked.add(key(c, r)); continue; } // outside a non-square map
      if (tileAt(c, r) === 'bridge') { DECOR.lake(c, r); bridge(c, r); continue; } // a road over water
      if (TILES && isRoad(c, r)) { roadPiece(c, r); continue; }
      if (inPark(c, r)) {
        const wet = [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([dc, dr]) => tileAt(c + dc, r + dr) === 'lake').length;
        if (tileAt(c, r) === 'path' && wet >= 2) { DECOR.lake(c, r); dock(c, r); continue; } // a trail over water is a dock
        if (tileAt(c, r) === 'sand') flat(c, r, '#ecd9a6');
        else place(GROUND.grass, c, r);
        if (tileAt(c, r) === 'path') trail(c, r);
        continue;
      }
      blocked.add(key(c, r));
      if (special.has(key(c, r))) { place(STADIUM.tiles.some(([x, y]) => x === c && y === r) ? GROUND.paved : GROUND.grass, c, r); continue; }
      if (DECOR[tileAt(c, r)]) { DECOR[tileAt(c, r)](c, r); continue; }

      const friend = yards.get(key(c, r));
      if (friend) {
        const h = friend.home;
        const facing = Math.atan2(h.c - h.house[0], h.r - h.house[1]); // house faces down its driveway
        place(GROUND.grass, c, r);
        if (h.house[0] === c && h.house[1] === r) {
          const home = paintRoof(place(h.model, c, r, { ...(h.model.startsWith(SP) ? { scale: 0.92 } : { fit: 0.8 }), rotY: facing }), friend.color);
          topOf[key(c, r)] = topOf[key(h.c, h.r)] = new THREE.Box3().setFromObject(home).max.y;
          addOccluder(home);
          home.userData.buildingId = `house:${friend.id}`;
          clickable.push(home);

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
      if (BG_ROOFS.has(key(c, r))) paintRoof(b, BG_COLOR);
      if (placeIdAt.has(key(c, r))) { b.userData.buildingId = placeIdAt.get(key(c, r)); clickable.push(b); }
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
      if (roof) { // part of the building, so it fades with it when someone is behind
        const prop = place(roof, c, r, { scale: roof === HELIPAD ? 0.9 : 1.3, rotY });
        prop.position.y = top - 0.01;
        b.attach(prop);
        prop.traverse((m) => { Object.assign(m.userData, { occluderRoot: b, roofProp: true }); }); // no lit windows on props
      }
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
    h.name ||= `${f.name}'s house`; // a member can name their own house (town_members.home.name)
    const lbl = addLabel('lbl place home', h.name, () => at);
    lbl.el.onclick = () => openBuilding(`house:${f.id}`);
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
    const windmill = place(PROPS.windmill, fx + 0.5, fz + 15.6, { scale: 2.2, rotY: Math.PI / 4 });
    spinBlades(windmill);
    addOccluder(windmill);
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
  // Middles of the blocks along each road: between neighbouring roads and the map's edges, always on the grid
  const bounds = [-1, ...ROADS, N];
  const blockMids = bounds.slice(1).map((b, j) => Math.floor((bounds[j] + b) / 2)).filter((i) => i >= 0 && i < N && !ROADS.includes(i));
  for (const [j, i] of blockMids.entries()) for (const [k, road] of ROADS.entries()) {
    if ((j + k) % 2) continue; // every other block face, alternating sides
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
  // Drawn towns: lamps along their own roads and trails (the classic city's come from its full-width roads above),
  // set at the edge facing in, never on a doorway
  if (DRAWN) for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
    const k = tileAt(c, r);
    if (doors.has(key(c, r)) || !((k === 'road' && hash(c * 3, r * 5) < 0.22) || (k === 'path' && hash(c * 5, r * 3) < 0.16))) continue;
    const edge = [[1, 0], [-1, 0], [0, 1], [0, -1]].find(([dc, dr]) => !['road', 'path'].includes(tileAt(c + dc, r + dr)));
    if (edge) lamp(c + edge[0] * 0.42, r + edge[1] * 0.42, Math.atan2(-edge[1], edge[0]));
  }
  // A bus stop by the park, café chairs out front, and roadwork on the east side (classic city only)
  if (ROADS.length > 2 && !DRAWN) place(PROPS['bus-stop'], CENTER + 1, ROADS[2] + 0.41, { scale: 1.6, rotY: Math.PI });
  if (PLACES.cafe) for (const dz of [-0.35, 0.3]) place(PROPS['coffee-shop-chair'], PLACES.cafe.door[0] + 0.4, PLACES.cafe.door[1] + dz, { scale: 1.6 });
  const rw = DRAWN ? undefined : ROADS[3];
  if (rw !== undefined) {
  place(PROPS['traffic-control-barrier-fence'], rw + 0.3, 4, { scale: 2, rotY: Math.PI / 2 });
  place(STREET.concrete_jersey_barrier_01_medium, rw + 0.3, 4.45, { scale: METER, rotY: Math.PI / 2 });
  place(STREET.type_ii_barricade_01_medium, rw + 0.3, 3.55, { scale: METER, rotY: Math.PI / 2 });
  for (const dz of [-0.3, 0, 0.3]) place(dz ? PROPS['traffic-cone'] : STREET.cone_i_medium, rw + 0.12, 4 + dz, { scale: dz ? 2 : METER });
  place(STREET.pallet_medium_01, rw + 0.36, 4.85, { scale: METER });
  place(STREET.barrel_02_medium_blue, rw + 0.3, 3.2, { scale: METER });
  place(STREET.barrel_02_medium_red, rw + 0.38, 3.05, { scale: METER });
  }

  for (const [id, p] of Object.entries(PLACES)) {
    if (!p.model && !DRAWN) continue; // drawn towns name their outdoor spots too (a campfire circle, a dock)
    const at = pos(p.c, p.r).setY(p.model ? topOf[key(p.c, p.r)] + 0.15 : 0.5);
    p.label = addLabel('lbl place', p.name, () => at);
    p.label.el.onclick = () => openBuilding(id);
  }
}

export const walkable = (c, r) => c >= 0 && r >= 0 && c < N && r < N && !blocked.has(key(c, r));

export function findPath(from, to, roadsOnly = false) {
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

// After the city, lamps and lit windows are in: every placed model tall enough to hide a person (buildings, trees,
// lamp posts, signals, the bus stop, parked vehicles, roof props via their building) can fade when it covers
// someone, and all static scenery stops recomputing its transform every frame.
export function finishCity() {
  const covered = new Set(occluders);
  for (const obj of scene.children) {
    if (!obj.userData.placed) continue;
    if (!covered.has(obj) && !obj.userData.flat && obj.userData.height > 0.2) addOccluder(obj);
    freeze(obj);
  }
}

function freeze(obj) {
  if (obj.userData.animated) return; // e.g. the windmill's rotor: keeps updating
  obj.updateMatrix();
  obj.matrixAutoUpdate = false;
  obj.updateMatrixWorld(true);
  for (const child of obj.children) freeze(child);
}

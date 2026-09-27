// Loading models and placing them on the grid.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { GROUND, NATURE, PARK_TREES, ROAD } from './assets.js';
import { LANDSCAPE, pos } from './layout.js';
import { scene } from './stage.js';

const loader = new GLTFLoader();
export const models = {};
export async function loadAll(paths) {
  await Promise.all([...new Set(paths)].map(async (p) => { models[p] = await loader.loadAsync(p); }));
}

// SimplePoly models share one scale (a road tile is 20 units), so place them at that scale
// to keep houses, shops and towers in proportion. `fit` instead stretches a model to a footprint.
const SP_SCALE = 1 / 20;

// The town's landscape (towns.map.landscape): ground colour and what grows. Applied here, where every model is
// placed, so the city builder stays the same for all of them. Snowfall itself comes from sky.js.
const spot = (c, r) => (((Math.round(c * 7) * 37 + Math.round(r * 7) * 91) % 100) + 100) % 100 / 100;
const LOOK = {
  desert: { ground: '#e6cd96', trees: (c, r) => (spot(c, r) < 0.55 ? [NATURE['rock-big'], 0.8] : [NATURE['bush-02'], 1, '#9a9a5c']),
    bushes: '#a3a064' },
  snowy: { ground: '#eef2f6', trees: () => [PARK_TREES[1], 1] }, // pines; the snow settles on them in sky.js
  autumn: { grass: '#b3ad5e', leaves: ['#ec7a2c', '#e3a92a', '#c9462e', '#d4862c', '#b8b04a'] },
}[LANDSCAPE];
// Recolour a model's greens (leaves, grass, bushes) to `hex`, keeping each pixel's brightness; trunks, rocks and
// everything else keep their colours. One recoloured texture and material per original, shared by every placement.
const recoloured = new Map();
function recolourTexture(tex, hex) {
  const k = `${tex.uuid}:${hex}`;
  if (!recoloured.has(k)) {
    const img = tex.image;
    const cv = Object.assign(document.createElement('canvas'), { width: img.width, height: img.height });
    const ctx = cv.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const px = ctx.getImageData(0, 0, cv.width, cv.height), to = new THREE.Color(hex);
    for (let i = 0; i < px.data.length; i += 4) {
      const [r, g, b] = [px.data[i], px.data[i + 1], px.data[i + 2]];
      if (g <= r * 1.05 || g <= b * 1.05) continue; // not green
      const l = Math.min(1.3, (r * 0.3 + g * 0.59 + b * 0.11) / 120);
      px.data[i] = Math.min(255, to.r * 255 * l); px.data[i + 1] = Math.min(255, to.g * 255 * l); px.data[i + 2] = Math.min(255, to.b * 255 * l);
    }
    ctx.putImageData(px, 0, 0);
    const t = new THREE.CanvasTexture(cv);
    for (const f of ['flipY', 'colorSpace', 'wrapS', 'wrapT', 'magFilter', 'minFilter']) t[f] = tex[f];
    recoloured.set(k, t);
  }
  return recoloured.get(k);
}
const materials = new Map();
function tintAll(obj, hex) {
  obj.traverse((m) => {
    if (!m.isMesh || Array.isArray(m.material)) return;
    const k = `${m.material.uuid}:${hex}`;
    if (!materials.has(k)) {
      const t = m.material.clone();
      if (t.map) t.map = recolourTexture(t.map, hex);
      else t.color.lerp(new THREE.Color(hex), 0.6);
      materials.set(k, t);
    }
    m.material = materials.get(k);
  });
}
const groundTile = new THREE.BoxGeometry(1, 0.01, 1);
const groundMat = LOOK?.ground && new THREE.MeshLambertMaterial({ color: LOOK.ground });

export function place(path, c, r, opts = {}) {
  if (LOOK?.ground && path === GROUND.grass) { // desert sand / snowfield instead of the grass tile
    const g = new THREE.Mesh(groundTile, groundMat);
    g.position.copy(pos(c, r)).setY(-0.004);
    g.receiveShadow = true;
    scene.add(g);
    return g;
  }
  let tint = null;
  if (LOOK?.trees && PARK_TREES.includes(path)) {
    const [swap, k, color] = LOOK.trees(c, r);
    path = swap;
    opts = { ...opts, scale: (opts.scale ?? 1) * k };
    tint = color;
  } else if (LOOK?.bushes && /natures-(bush|grass-fence|grass-bar)/.test(path)) tint = LOOK.bushes; // hedges too
  const obj = placeModel(path, c, r, opts);
  if (tint) tintAll(obj, tint);
  if (LOOK?.leaves && PARK_TREES.includes(path) && path !== PARK_TREES[1]) tintAll(obj, LOOK.leaves[Math.floor(spot(c, r) * LOOK.leaves.length)]);
  if (LOOK?.grass && path === GROUND.grass) tintAll(obj, LOOK.grass);
  return obj;
}

function placeModel(path, c, r, { fit, scale = 1, height = 1, rotY = 0 } = {}) {
  const obj = models[path].scene.clone();
  const size = new THREE.Box3().setFromObject(obj).getSize(new THREE.Vector3());
  obj.scale.setScalar(fit ? fit / Math.max(size.x, size.z) : SP_SCALE * scale);
  obj.scale.y *= height;
  obj.rotation.y = rotY;
  obj.position.copy(pos(c, r));
  const flat = Object.values(ROAD).includes(path) || Object.values(GROUND).includes(path);
  // Only models big enough to throw a noticeable shadow cast one (buildings, trees). Lamps, signs, cars, benches
  // and other small props skip the shadow pass, which roughly halves it on a big town.
  const [h, w] = [size.y * obj.scale.y, Math.max(size.x, size.z) * obj.scale.x];
  const shadow = !flat && h > 0.4 && w > 0.3;
  obj.traverse((m) => { if (m.isMesh) { m.castShadow = shadow; m.receiveShadow = true; } });
  obj.userData.placed = true; // static scenery: finishCity() freezes its transforms
  obj.userData.flat = flat;
  obj.userData.height = h;
  scene.add(obj);
  return obj;
}

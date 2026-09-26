// Loading models and placing them on the grid.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { GROUND, ROAD } from './assets.js';
import { pos } from './layout.js';
import { scene } from './stage.js';

const loader = new GLTFLoader();
export const models = {};
export async function loadAll(paths) {
  await Promise.all([...new Set(paths)].map(async (p) => { models[p] = await loader.loadAsync(p); }));
}

// SimplePoly models share one scale (a road tile is 20 units), so place them at that scale
// to keep houses, shops and towers in proportion. `fit` instead stretches a model to a footprint.
const SP_SCALE = 1 / 20;
export function place(path, c, r, { fit, scale = 1, height = 1, rotY = 0 } = {}) {
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

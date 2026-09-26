// The three.js stage: renderer, scene, the overview camera and its controls, lights, the base plate,
// animated water, and the list of things animated every frame.
import * as THREE from 'three';
import { MapControls } from 'three/addons/controls/MapControls.js';
import { $ } from './hud.js';
import { N } from './layout.js';

const IS_MOBILE = matchMedia('(pointer: coarse)').matches;

export const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
$('#game').append(renderer.domElement);

export const scene = new THREE.Scene();
scene.background = new THREE.Color('#9fd3ec');
scene.fog = new THREE.Fog('#9fd3ec', 1000, 2000); // weather haze; `updateSky` sets its range and color

const VIEW = 17; // world units visible vertically at zoom 1
export const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 200);
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
export const OPEN_ZOOM = 0.95; // the view the town opens at (the whole town and its name); the place card treats this as its full size
camera.zoom = OPEN_ZOOM; // scroll out to see the whole town
camera.updateProjectionMatrix();



// A trackpad pinch arrives as ctrl+wheel. Over a panel or label the browser would pinch-zoom the
// whole page instead (blurry, panels pushed off screen), so only the town's camera may zoom.
addEventListener('wheel', (e) => { if (e.ctrlKey) e.preventDefault(); }, { passive: false });
for (const t of ['gesturestart', 'gesturechange']) addEventListener(t, (e) => e.preventDefault(), { passive: false }); // Safari

export const controls = new MapControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.minZoom = 0.6;
controls.maxZoom = 5;
controls.minPolarAngle = 0.35;
controls.maxPolarAngle = 1.15;
// Aim a little past the centre of the town
const LIFT = N * 0.07;
controls.target.set(-LIFT, 0, -LIFT);
camera.position.set(14 - LIFT, 13, 14 - LIFT);

export const hemi = new THREE.HemisphereLight('#ffffff', '#8a9a7a', 1.6);
scene.add(hemi);
export const sun = new THREE.DirectionalLight('#fff4e0', 2.2);
sun.position.set(-8, 14, 6);
sun.castShadow = true;
sun.shadow.mapSize.setScalar(IS_MOBILE ? 1024 : 2048);
Object.assign(sun.shadow.camera, { left: -15, right: 15, top: 15, bottom: -15, near: 1, far: 60 });
sun.shadow.bias = -0.0005;
scene.add(sun);

// Things updated every frame ({ update(dt) }), e.g. water and the windmill
export const animated = new Set();
// Materials the weather must leave alone (water stays water in the snow)
export const SNOW_SKIP = new Set();

// Base plate under the city (a hair below the tiles, so they never z-fight)
const slab = (w, d, top, z) => {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.3, d), new THREE.MeshLambertMaterial({ color: '#b98a5a' }));
  m.position.set(0, top - 0.151, z);
  m.receiveShadow = true;
  scene.add(m);
};
slab(N + 0.4, N + 0.4, -0.01, 0);

// Animated low-poly water (the park pond): vertices bob gently
export function water(geometry) {
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

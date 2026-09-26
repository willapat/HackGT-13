// A small 3D stage for the settings page: shows a Kenney Mini Character idling on a ring in the
// person's color (the same ring they stand on in town), plus a thumbnail of every look to pick from.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export const LOOKS = ['female-a', 'female-b', 'female-c', 'female-d', 'female-e', 'female-f',
  'male-a', 'male-b', 'male-c', 'male-d', 'male-e', 'male-f'].map((s) => `character-${s}`);

const loader = new GLTFLoader();
let gltfs = null;
const loadAll = () => (gltfs ??= Promise.all(LOOKS.map((l) => loader.loadAsync(`../town/assets/mini-characters/${l}.glb`)))
  .then((list) => Object.fromEntries(LOOKS.map((l, i) => [l, list[i]]))));

export async function createPreview(stage) {
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  stage.prepend(renderer.domElement);

  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight('#ffffff', '#8a9a7a', 1.8));
  const sun = new THREE.DirectionalLight('#fff4e0', 2);
  sun.position.set(-2, 4, 3);
  scene.add(sun);
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 50);
  const HOME = new THREE.Vector3(0, 1.05, 3.1), TARGET = new THREE.Vector3(0, 0.55, 0);
  camera.position.copy(HOME);

  // Drag to turn the character around, scroll or pinch to zoom; it turns slowly by itself again after
  // a few seconds untouched
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(TARGET);
  Object.assign(controls, {
    enablePan: false, enableDamping: true, minDistance: 1.6, maxDistance: 4.5,
    minPolarAngle: 0.35, maxPolarAngle: 1.62, autoRotate: !still, autoRotateSpeed: 1.6,
  });
  controls.update();
  let resumeAt = 0;
  controls.addEventListener('start', () => { controls.autoRotate = false; resumeAt = Infinity; });
  controls.addEventListener('end', () => { resumeAt = performance.now() + 3000; });

  const ring = new THREE.Mesh(new THREE.RingGeometry(0.42, 0.52, 48), new THREE.MeshBasicMaterial({ color: '#ffffff' }));
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.005;
  scene.add(ring);
  const pad = new THREE.Mesh(new THREE.CircleGeometry(0.42, 48), new THREE.MeshLambertMaterial({ color: '#8cc79a' }));
  pad.rotation.x = -Math.PI / 2;
  scene.add(pad);

  const models = await loadAll();
  let current = null, mixer = null, frame = 0;

  function size() {
    const w = stage.clientWidth, h = stage.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  size();
  const ro = new ResizeObserver(size);
  ro.observe(stage);

  function show(look) {
    if (current) scene.remove(current);
    const gltf = models[look] || models[LOOKS[0]];
    current = SkeletonUtils.clone(gltf.scene); // a plain clone would leave the skin on the original's bones
    current.rotation.y = 0.35;
    scene.add(current);
    mixer = new THREE.AnimationMixer(current);
    const idle = THREE.AnimationClip.findByName(gltf.animations, 'idle');
    if (idle) mixer.clipAction(idle).play();
  }

  // One picture per look, taken with this same stage (captured right after each render)
  function thumbnails() {
    const keep = current, keepMixer = mixer, keepCam = camera.position.clone();
    ring.visible = pad.visible = false;
    camera.position.set(0, 0.8, 2.1); // closer than the stage view: thumbnails are small
    camera.lookAt(0, 0.5, 0);
    const out = {};
    for (const look of LOOKS) {
      show(look);
      current.rotation.y = 0.35;
      mixer.update(0);
      renderer.render(scene, camera);
      out[look] = renderer.domElement.toDataURL('image/png');
      scene.remove(current);
    }
    current = keep;
    mixer = keepMixer;
    if (keep) scene.add(keep);
    ring.visible = pad.visible = true;
    camera.position.copy(keepCam);
    controls.update();
    return out;
  }

  const clock = new THREE.Clock();
  function tick() {
    frame = requestAnimationFrame(tick);
    const dt = clock.getDelta();
    if (!still && performance.now() > resumeAt) controls.autoRotate = true;
    controls.update();
    mixer?.update(still ? 0 : dt);
    renderer.render(scene, camera);
  }
  tick();

  return {
    thumbnails,
    setLook: show,
    setColor(hex) { ring.material.color.set(hex); },
    dispose() {
      cancelAnimationFrame(frame);
      ro.disconnect();
      controls.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}

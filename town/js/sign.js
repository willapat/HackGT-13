// The town's name in big 3D letters behind the town, on a little floating lawn of its own. It swings round with the
// camera so it always stands on the far side of the town, and glows after dark like a lit sign.
import * as THREE from 'three';
import { FontLoader } from 'three/addons/loaders/FontLoader.js';
import { TextGeometry } from 'three/addons/geometries/TextGeometry.js';
import { LANDSCAPE, N } from './layout.js';
import { sky } from './sky.js';
import { animated, camera, controls, scene } from './stage.js';

const GRADIENT = ['#1a6dff', '#7a5cff', '#ff6b7a'].map((c) => new THREE.Color(c)); // the brand gradient (--brand)
const LAWN = { green: '#79b85a', autumn: '#b9a24f', snowy: '#eef3f7', desert: '#e2c48f' };

function gradientAt(t) {
  const i = Math.min(GRADIENT.length - 2, Math.floor(t * (GRADIENT.length - 1)));
  return GRADIENT[i].clone().lerp(GRADIENT[i + 1], t * (GRADIENT.length - 1) - i);
}

export async function addTownSign(name) {
  // The font covers Latin letters, digits and punctuation; anything else (emoji) is left out
  const text = (name || 'Luma').replace(/[^\x20-\x7EÀ-ÿ]/g, '').replace(/\s+/g, ' ').trim() || 'Luma';
  const font = new FontLoader().parse(await (await fetch('lib/fonts/helvetiker_bold.typeface.json')).json());
  const size = Math.min(2.4, Math.max(1.1, N * 0.085));
  const geo = new TextGeometry(text, {
    font, size, depth: size * 0.3, curveSegments: 6, bevelEnabled: true, bevelThickness: size * 0.04, bevelSize: size * 0.03, bevelSegments: 2,
  });
  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  geo.translate(-(bb.min.x + bb.max.x) / 2, -bb.min.y, -(bb.min.z + bb.max.z) / 2);
  const scale = Math.min(1, (N * 1.1) / (bb.max.x - bb.min.x)); // long names shrink to about the town's width
  // Left-to-right brand gradient painted into the vertices
  const p = geo.attributes.position, colors = new Float32Array(p.count * 3), half = (bb.max.x - bb.min.x) / 2;
  for (let i = 0; i < p.count; i++) gradientAt((p.getX(i) + half) / (2 * half || 1)).toArray(colors, i * 3);
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.05, emissive: '#8a7dff', emissiveIntensity: 0 });
  const letters = new THREE.Mesh(geo, mat);
  letters.castShadow = letters.receiveShadow = true;
  letters.scale.setScalar(scale);

  // The lawn the letters stand on: dirt block with a grass (or sand/snow) top, like the town's own base
  const w = (bb.max.x - bb.min.x) * scale + 1, d = size * scale * 0.3 + 1;
  const dirt = new THREE.Mesh(new THREE.BoxGeometry(w, 0.3, d), new THREE.MeshLambertMaterial({ color: '#b98a5a' }));
  dirt.position.y = -0.16;
  const lawn = new THREE.Mesh(new THREE.BoxGeometry(w, 0.04, d), new THREE.MeshLambertMaterial({ color: LAWN[LANDSCAPE] || LAWN.green }));
  lawn.position.y = -0.02;
  dirt.receiveShadow = lawn.receiveShadow = true;

  const sign = new THREE.Group();
  sign.add(letters, dirt, lawn);
  const pivot = new THREE.Group(); // turns about the town's centre to keep the sign opposite the camera
  pivot.add(sign);
  scene.add(pivot);

  const off = new THREE.Vector3();
  const fx = {
    update() {
      // Stay on the far side of the overview camera (following someone leaves it where it was)
      off.copy(camera.position).sub(controls.target);
      const theta = Math.atan2(off.x, off.z);
      pivot.rotation.y = theta;
      // Hug the far edge of the square town whichever way you look at it
      const edge = (N / 2 + 0.2) / Math.max(Math.abs(Math.sin(theta)), Math.abs(Math.cos(theta)));
      sign.position.z = -(edge + d / 2 + 0.4);
      mat.emissiveIntensity = Math.max(0, sky.night - 0.3) * 1.2; // lit after dark
    },
  };
  animated.add(fx);
}

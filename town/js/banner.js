// The town's name on a banner towed by a little prop plane, hanging low in the air just past the town's far corner
// (the one behind the opening view). It stays put like the rest of the map (it only bobs, its propeller spins and the
// banner ripples). The name reads the right way round from both sides. It's painted on a canvas, so emoji work too;
// the banner glows after dark.
import * as THREE from 'three';
import { N } from './layout.js';
import { sky } from './sky.js';
import { animated, scene } from './stage.js';

const ALTITUDE = 2.2; // height of the plane above the ground (low enough to stay in the opening view)
const BANNER_H = 1.3;
const BRAND = ['#1a6dff', '#7a5cff', '#ff6b7a']; // the brand gradient (--brand)

function bannerTexture(text) {
  const h = 128, font = `800 ${h * 0.56}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  const measure = document.createElement('canvas').getContext('2d');
  measure.font = font;
  const w = Math.ceil(measure.measureText(text).width + h * 0.9);
  const cv = Object.assign(document.createElement('canvas'), { width: w, height: h });
  const g = cv.getContext('2d');
  g.fillStyle = '#fff8ec';
  g.fillRect(0, 0, w, h);
  const grad = g.createLinearGradient(0, 0, w, 0);
  BRAND.forEach((c, i) => grad.addColorStop(i / (BRAND.length - 1), c));
  g.fillStyle = grad; // top and bottom hems
  g.fillRect(0, 0, w, h * 0.07);
  g.fillRect(0, h * 0.93, w, h * 0.07);
  g.font = font;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, w / 2, h * 0.53);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return { tex, aspect: w / h };
}

// A low-poly prop plane, nose toward -x, wings along z
function buildPlane() {
  const body = new THREE.MeshLambertMaterial({ color: '#e8453c' });
  const white = new THREE.MeshLambertMaterial({ color: '#f7f7f2' });
  const dark = new THREE.MeshLambertMaterial({ color: '#33363d' });
  const glass = new THREE.MeshLambertMaterial({ color: '#8fd3ff', emissive: '#2a6f99', emissiveIntensity: 0.3 });
  const mesh = (geo, mat, x = 0, y = 0, z = 0) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); return m; };

  const plane = new THREE.Group();
  const fuselage = mesh(new THREE.CylinderGeometry(0.3, 0.16, 2.2, 10), body);
  fuselage.rotation.z = Math.PI / 2; // cylinder's top (radius 0.3) toward -x, the nose
  const nose = mesh(new THREE.CylinderGeometry(0.2, 0.3, 0.25, 10), white, -1.22);
  nose.rotation.z = Math.PI / 2;
  const cockpit = mesh(new THREE.BoxGeometry(0.5, 0.2, 0.36), glass, -0.3, 0.3);
  const wing = mesh(new THREE.BoxGeometry(0.6, 0.07, 3.2), white, -0.35, -0.05);
  const stripe = mesh(new THREE.BoxGeometry(0.61, 0.075, 0.3), body, -0.35, -0.05, 1.3);
  const stripe2 = stripe.clone(); stripe2.position.z = -1.3;
  const tailWing = mesh(new THREE.BoxGeometry(0.35, 0.05, 1.2), white, 0.95, 0.05);
  const fin = mesh(new THREE.BoxGeometry(0.4, 0.55, 0.06), body, 0.98, 0.35);
  const wheels = [-0.5, 0.5].map((z) => mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.06, 10), dark, -0.45, -0.42, z));
  wheels.forEach((w) => { w.rotation.x = Math.PI / 2; });
  const struts = [-0.5, 0.5].map((z) => mesh(new THREE.BoxGeometry(0.05, 0.3, 0.05), dark, -0.45, -0.27, z));
  const prop = new THREE.Group();
  prop.position.x = -1.37;
  prop.add(mesh(new THREE.BoxGeometry(0.04, 0.9, 0.1), dark), mesh(new THREE.BoxGeometry(0.04, 0.1, 0.9), dark),
    mesh(new THREE.SphereGeometry(0.08, 8, 6), white));
  plane.add(fuselage, nose, cockpit, wing, stripe, stripe2, tailWing, fin, ...wheels, ...struts, prop);
  plane.traverse((m) => { if (m.isMesh) m.castShadow = true; });
  return { plane, prop };
}

export function addTownBanner(name) {
  const text = (name || 'Luma').replace(/\s+/g, ' ').trim() || 'Luma';
  const { tex, aspect } = bannerTexture(text);
  const bannerW = Math.min(N * 0.7, BANNER_H * aspect);
  const bannerH = Math.min(BANNER_H, bannerW / aspect); // very long names shrink instead of stretching

  // The banner: a cloth that ripples more toward its free end
  const SEGS = 32;
  const geo = new THREE.PlaneGeometry(bannerW, bannerH, SEGS, 1);
  const base = Float32Array.from(geo.attributes.position.array);
  // Two one-sided cloths on the same rippling shape: the back one's picture is flipped so it reads left to right too
  const flipped = tex.clone();
  Object.assign(flipped, { wrapS: THREE.RepeatWrapping, needsUpdate: true });
  flipped.repeat.x = -1;
  const cloth = (map, side) => new THREE.MeshLambertMaterial({ map, side, emissive: '#ffffff', emissiveMap: map, emissiveIntensity: 0 });
  const mats = [cloth(tex, THREE.FrontSide), cloth(flipped, THREE.BackSide)];
  const banner = new THREE.Group();
  banner.add(...mats.map((m) => new THREE.Mesh(geo, m)));
  banner.children[0].castShadow = true;
  const { plane, prop } = buildPlane();
  const ROPE = 1.1;
  banner.position.x = 1.1 + ROPE + bannerW / 2; // trails behind the tail
  const rope = new THREE.LineSegments(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(1.1, 0, 0), new THREE.Vector3(1.1 + ROPE, bannerH * 0.4, 0),
      new THREE.Vector3(1.1, 0, 0), new THREE.Vector3(1.1 + ROPE, -bannerH * 0.4, 0)]),
    new THREE.LineBasicMaterial({ color: '#555' }));

  const craft = new THREE.Group();
  craft.add(plane, rope, banner);
  craft.position.x = -(1.1 + ROPE + bannerW) / 2 + 0.6; // the middle of the whole thing sits on the spot
  const group = new THREE.Group();
  group.add(craft);
  group.rotation.y = Math.PI / 4; // side-on to the opening view: flying toward screen left, banner facing the camera

  // Just past the far corner, where the town's name sign used to stand
  const out = N / Math.SQRT2 + 0.9;
  group.position.set(-out / Math.SQRT2, ALTITUDE, -out / Math.SQRT2);
  scene.add(group);

  const p = geo.attributes.position;
  animated.add({
    update(dt) {
      const now = performance.now() / 1000;
      prop.rotation.x += dt * 40;
      craft.position.y = Math.sin(now * 1.1) * 0.12;
      craft.rotation.x = Math.sin(now * 0.8) * 0.03;
      for (let i = 0; i < p.count; i++) {
        const x = base[i * 3], along = (x + bannerW / 2) / bannerW; // 0 at the rope, 1 at the free end
        p.setZ(i, Math.sin(along * 9 - now * 5) * 0.12 * along);
        p.setY(i, base[i * 3 + 1] + Math.sin(along * 6 - now * 4) * 0.05 * along);
      }
      p.needsUpdate = true;
      geo.computeVertexNormals();
      for (const m of mats) m.emissiveIntensity = Math.max(0, sky.night - 0.3) * 0.9; // lit after dark
    },
  });
}

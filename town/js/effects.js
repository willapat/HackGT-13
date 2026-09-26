// Visual effects over people and houses: party lights, rain clouds and the like.
import * as THREE from 'three';
import { focusOn } from './camera.js';
import { topOf } from './city.js';
import { key, pos } from './layout.js';
import { animated, scene } from './stage.js';

export const effects = {};

function houseTop(home) { return pos(...home.house).setY(topOf[key(...home.house)]); }

export function partyLights(home, { focus = true } = {}) {
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

export function rainCloud(home, { focus = true } = {}) {
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

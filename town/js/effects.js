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

export function rainCloud(home, { focus = true, storm = false, snow = false } = {}) {
  const top = houseTop(home);
  const group = new THREE.Group();
  const grey = new THREE.MeshLambertMaterial({ color: storm ? '#5d6475' : snow ? '#eef2f7' : '#8a94a6', emissive: '#e8eeff', emissiveIntensity: 0 });
  const cloud = new THREE.Group();
  [[-0.2, 0, 0, 0.16], [0, 0.07, 0, 0.2], [0.2, 0.02, 0.05, 0.15], [0.05, 0, 0.14, 0.15], [0, 0, -0.12, 0.14]]
    .forEach(([x, y, z, r]) => { const s = new THREE.Mesh(new THREE.SphereGeometry(r, 14, 10), grey); s.position.set(x, y, z); cloud.add(s); });
  cloud.position.copy(top).setY(top.y + 0.9);
  group.add(cloud);
  const dropMat = new THREE.MeshBasicMaterial({ color: snow ? '#ffffff' : '#8fc3ff' });
  const dropGeo = snow ? new THREE.SphereGeometry(0.018, 6, 4) : new THREE.BoxGeometry(0.01, 0.09, 0.01);
  const drops = Array.from({ length: storm ? 70 : snow ? 30 : 45 }, () => {
    const d = new THREE.Mesh(dropGeo, dropMat);
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
        d.position.y -= (snow ? 0.5 : storm ? 4 : 3) * dt;
        if (snow) d.position.x += Math.sin(t * 2 + d.id) * 0.002;
        if (d.position.y < top.y) d.position.y = top.y + 0.8;
      }
      if (storm) { // a lightning flicker inside the cloud every few seconds
        const beat = (t % 3.2);
        grey.emissiveIntensity = beat < 0.08 || (beat > 0.16 && beat < 0.22) ? 0.9 : 0;
      }
    },
    destroy() { scene.remove(group); animated.delete(fx); },
  };
  animated.add(fx);
  if (focus) focusOn(top);
  return fx;
}

// ---- House moods: what a person puts on their own house (town_members.home.mood, backend/house.py MOODS) ----

const emojiTex = {};
function emojiTexture(e) {
  if (!emojiTex[e]) {
    const cv = Object.assign(document.createElement('canvas'), { width: 64, height: 64 });
    const g = cv.getContext('2d');
    g.font = '48px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(e, 32, 36);
    emojiTex[e] = new THREE.CanvasTexture(cv);
    emojiTex[e].colorSpace = THREE.SRGBColorSpace;
  }
  return emojiTex[e];
}

// Emoji drifting up off the roof and fading out (hearts, notes, Zs, sparkles...)
function floaters(home, emojis, { count = 6, rise = 0.35, size = 0.22, sway = 0.12, life = 2.6 } = {}) {
  const top = houseTop(home);
  const group = new THREE.Group();
  const items = Array.from({ length: count }, (_, i) => {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: emojiTexture(emojis[i % emojis.length]), transparent: true, depthWrite: false }));
    s.userData = { age: (i / count) * life, x: (Math.random() - 0.5) * 0.4, z: (Math.random() - 0.5) * 0.4, ph: Math.random() * 6 };
    group.add(s);
    return s;
  });
  scene.add(group);
  const fx = {
    update(dt) {
      for (const s of items) {
        const u = s.userData;
        u.age += dt;
        if (u.age > life) Object.assign(u, { age: 0, x: (Math.random() - 0.5) * 0.4, z: (Math.random() - 0.5) * 0.4 });
        const k = u.age / life;
        s.position.set(top.x + u.x + Math.sin(u.age * 2 + u.ph) * sway * k, top.y + 0.15 + k * rise * life, top.z + u.z);
        s.scale.setScalar(size * (0.6 + 0.4 * Math.min(1, k * 4)));
        s.material.opacity = Math.min(1, k * 5) * (1 - k);
      }
    },
    destroy() { scene.remove(group); animated.delete(fx); },
  };
  animated.add(fx);
  return fx;
}

// A smiling sun turning slowly over the roof
function sunnySky(home) {
  const top = houseTop(home);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: emojiTexture('☀️'), transparent: true, depthWrite: false }));
  s.scale.setScalar(0.45);
  scene.add(s);
  let t = 0;
  const fx = {
    update(dt) {
      t += dt;
      s.position.set(top.x, top.y + 0.75 + Math.sin(t * 1.4) * 0.05, top.z);
      s.material.rotation = t * 0.4;
      s.scale.setScalar(0.45 + Math.sin(t * 2.2) * 0.03);
    },
    destroy() { scene.remove(s); s.material.dispose(); animated.delete(fx); },
  };
  animated.add(fx);
  return fx;
}

// Chimney smoke: soft grey puffs that grow and fade as they rise
function chimneySmoke(home) {
  const top = houseTop(home);
  const group = new THREE.Group();
  const puffs = Array.from({ length: 8 }, (_, i) => {
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.06, 10, 8), new THREE.MeshLambertMaterial({ color: '#d9dde3', transparent: true }));
    m.userData.age = i * 0.4;
    group.add(m);
    return m;
  });
  scene.add(group);
  const fx = {
    update(dt) {
      for (const m of puffs) {
        m.userData.age = (m.userData.age + dt) % 3.2;
        const k = m.userData.age / 3.2;
        m.position.set(top.x + 0.15 + k * 0.25, top.y + 0.05 + k * 0.9, top.z - 0.1);
        m.scale.setScalar(0.6 + k * 1.8);
        m.material.opacity = 0.85 * (1 - k);
      }
    },
    destroy() { scene.remove(group); animated.delete(fx); },
  };
  animated.add(fx);
  return fx;
}

export const HOUSE_MOODS = {
  party: { emoji: '🎉', label: 'Celebrating', fx: (h) => partyLights(h, { focus: false }) },
  sunny: { emoji: '☀️', label: 'Great day', fx: sunnySky },
  love: { emoji: '❤️', label: 'Feeling the love', fx: (h) => floaters(h, ['❤️', '💕', '💖']) },
  proud: { emoji: '✨', label: 'Proud', fx: (h) => floaters(h, ['✨', '⭐', '🌟'], { count: 8, sway: 0.2 }) },
  music: { emoji: '🎶', label: 'Jamming', fx: (h) => floaters(h, ['🎵', '🎶'], { sway: 0.25 }) },
  cozy: { emoji: '☕', label: 'Cozy at home', fx: chimneySmoke },
  studying: { emoji: '📚', label: 'Studying', fx: (h) => floaters(h, ['📚', '✏️', '💡'], { count: 4, life: 3.2 }) },
  busy: { emoji: '🔥', label: 'Grinding', fx: (h) => floaters(h, ['🔥'], { count: 7, rise: 0.25, life: 1.6, size: 0.2 }) },
  sleepy: { emoji: '😴', label: 'Sleepy', fx: (h) => floaters(h, ['💤'], { count: 3, life: 3.4, sway: 0.2 }) },
  chill: { emoji: '❄️', label: 'Chilling', fx: (h) => rainCloud(h, { focus: false, snow: true }) },
  rainy: { emoji: '🌧️', label: 'Rough day', fx: (h) => rainCloud(h, { focus: false }) },
  stormy: { emoji: '⛈️', label: 'Stormy', fx: (h) => rainCloud(h, { focus: false, storm: true }) },
};

export function houseMood(home, kind) { return HOUSE_MOODS[kind]?.fx(home) ?? null; }

// Draw a house's mood (or none) and show its emoji on the house's name tag
export function setHouseMood(f, kind) {
  if (!f.home) return;
  if ((f.houseMood?.kind ?? null) !== (kind ?? null)) {
    f.houseMood?.fx?.destroy();
    f.houseMood = { kind: kind ?? null, fx: kind ? houseMood(f.home, kind) : null };
  }
  refreshHouseLabel(f);
}

export function refreshHouseLabel(f) {
  if (!f.homeLabel) return;
  const emoji = HOUSE_MOODS[f.houseMood?.kind]?.emoji;
  f.homeLabel.el.textContent = emoji ? `${f.home.name} ${emoji}` : f.home.name;
}

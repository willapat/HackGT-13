// Busy places glow: the more trips to a place today (GET /towns/{id}/heat), the brighter the warm pool on the
// ground around it and the warmer the building itself. The label gets a 🔥 count. Refreshed when a trip is logged.
import * as THREE from 'three';
import { api } from '../../frontend/shared/session.js';
import { clickable } from './city.js';
import { PLACES, pos, TOWN_ID } from './layout.js';
import { windowMats } from './sky.js';
import { animated, scene } from './stage.js';

const halos = {}; // place id -> ground glow mesh
let haloMap = null;
let timer = null;

// 1 visit is a faint glow, 3 is clear, 8+ is nearly full
const levelOf = (visits) => 1 - Math.exp(-visits / 4);

function haloTexture() {
  if (haloMap) return haloMap;
  const cv = Object.assign(document.createElement('canvas'), { width: 128, height: 128 });
  const x = cv.getContext('2d');
  const g = x.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.45, 'rgba(255,255,255,0.45)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, 128, 128);
  haloMap = new THREE.CanvasTexture(cv);
  return haloMap;
}

// Its own copy of every material (kit models share them), the same way occlusion.js does, so the glow and a
// later fade only touch this building. Lit-window copies stay registered so they still light up at night.
function ownMaterials(root) {
  root.traverse((m) => {
    if (!m.isMesh || m.userData.depthPass || m.userData.ownMaterial) return;
    m.material = Array.isArray(m.material)
      ? m.material.map((x) => { const c = x.clone(); if (windowMats.has(x)) windowMats.add(c); return c; })
      : m.material.clone();
    m.userData.ownMaterial = true;
  });
}

function glow(id, visits) {
  const p = PLACES[id];
  if (!p) return;
  const level = visits ? levelOf(visits) : 0;
  let h = halos[id];
  if (!h && level) {
    h = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({
      map: haloTexture(), color: '#ffab40', transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    h.rotation.x = -Math.PI / 2;
    h.position.copy(pos(p.c, p.r)).setY(0.035);
    h.raycast = () => {}; // never blocks a click or an occlusion ray
    scene.add(h);
    halos[id] = h;
  }
  if (h) {
    h.visible = level > 0;
    h.userData.level = level;
    h.scale.setScalar(1.4 + level * 1.6);
  }
  const b = clickable.find((o) => o.userData.buildingId === id);
  if (b && (level || b.userData.glowing)) {
    ownMaterials(b);
    b.traverse((m) => {
      if (!m.isMesh || m.userData.depthPass) return;
      for (const mat of [m.material].flat()) {
        if (windowMats.has(mat) || !mat.emissive) continue;
        mat.emissive.set('#ff8a2a');
        mat.emissiveIntensity = 0.32 * level;
      }
    });
    b.userData.glowing = level > 0;
  }
  if (p.label) {
    let badge = p.label.el.querySelector('.heat');
    if (!badge && visits) badge = p.label.el.appendChild(Object.assign(document.createElement('span'), { className: 'heat' }));
    if (badge) {
      badge.hidden = !visits;
      badge.textContent = `🔥 ${visits}`;
      badge.title = `${visits} visit${visits === 1 ? '' : 's'} today`;
    }
  }
}

async function load() {
  try {
    const heat = await api(`/towns/${TOWN_ID}/heat`);
    for (const id of Object.keys(PLACES)) glow(id, heat[id] || 0);
  } catch (e) {
    console.warn('heat', e);
  }
}

// A trip was just logged (townsync.js): recount shortly after, once per burst
export const heatSoon = () => { clearTimeout(timer); timer = setTimeout(load, 1500); };

export function startHeat() {
  if (!TOWN_ID) return;
  load();
  // Pools breathe slowly, each a little out of step with the others
  let t = 0;
  animated.add({
    update(dt) {
      t += dt;
      Object.values(halos).forEach((h, i) => {
        if (h.visible) h.material.opacity = (0.3 + 0.55 * h.userData.level) * (0.85 + 0.15 * Math.sin(t * 1.6 + i));
      });
    },
  });
}

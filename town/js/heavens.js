// Sun, moon and stars in the sky behind the town. They follow the town clock (sky.hour): the sun rises on the side
// its light comes from (sun.position in sky.js), crosses the top of the view and sets on the other side; the moon
// takes the night shift with tonight's phase. Cloud hides them. Drawn on the far plane, so the town is always in front.
// Off for now: main.js loads this only with ?sky=1, and calls updateHeavens() after the camera moves each frame.
import * as THREE from 'three';
import { activeCam } from './camera.js';
import { sky } from './sky.js';
import { scene } from './stage.js';

function canvasTexture(size, draw) {
  const cv = Object.assign(document.createElement('canvas'), { width: size, height: size });
  draw(cv.getContext('2d'), size);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const sunTex = canvasTexture(128, (g, s) => {
  const r = s / 2;
  const glow = g.createRadialGradient(r, r, 0, r, r, r);
  glow.addColorStop(0, 'rgba(255,250,220,1)');
  glow.addColorStop(0.28, 'rgba(255,236,150,1)');
  glow.addColorStop(0.36, 'rgba(255,214,110,0.55)');
  glow.addColorStop(1, 'rgba(255,190,90,0)');
  g.fillStyle = glow;
  g.fillRect(0, 0, s, s);
});

// Moon phase from the town date: 0 = new, 0.5 = full (a known new moon plus the synodic month)
function moonPhase() {
  const day = sky.y ? Date.UTC(sky.y, sky.mo - 1, sky.d) : Date.now();
  return ((((day - Date.UTC(2000, 0, 6, 18, 14)) / 86400000) / 29.530588) % 1 + 1) % 1;
}

function moonTexture(phase) {
  return canvasTexture(128, (g, s) => {
    const r = s / 2, R = s * 0.27;
    const glow = g.createRadialGradient(r, r, R * 0.8, r, r, r);
    glow.addColorStop(0, 'rgba(220,230,255,0.35)');
    glow.addColorStop(1, 'rgba(220,230,255,0)');
    g.fillStyle = glow;
    g.fillRect(0, 0, s, s);
    // The dark disc, then the lit part: a half disc plus (or minus) an ellipse for the terminator
    g.fillStyle = 'rgba(60,70,100,0.55)';
    g.beginPath(); g.arc(r, r, R, 0, Math.PI * 2); g.fill();
    const waxing = phase < 0.5, lit = 1 - Math.abs(1 - phase * 2); // 0 new .. 1 full
    g.fillStyle = '#f4f1e6';
    g.beginPath();
    g.arc(r, r, R, -Math.PI / 2, Math.PI / 2, !waxing); // the bright limb
    g.ellipse(r, r, Math.abs(1 - lit * 2) * R, R, 0, Math.PI / 2, -Math.PI / 2, lit > 0.5 ? !waxing : waxing);
    g.fill();
    g.globalCompositeOperation = 'source-atop'; // craters only on the lit part
    g.fillStyle = 'rgba(170,165,150,0.45)';
    for (const [x, y, c] of [[-0.3, -0.25, 0.18], [0.25, 0.1, 0.22], [-0.1, 0.35, 0.12], [0.35, -0.35, 0.1]]) {
      g.beginPath(); g.arc(r + x * R, r + y * R, c * R, 0, Math.PI * 2); g.fill();
    }
  });
}

const sprite = (map) => new THREE.Sprite(new THREE.SpriteMaterial({ map, transparent: true, depthWrite: false, fog: false }));
const sunSprite = sprite(sunTex);
let moonDay = null;
const moonSprite = sprite(null);
sunSprite.renderOrder = moonSprite.renderOrder = -1;
scene.add(sunSprite, moonSprite);

// Stars: fixed spots on the screen's upper part, twinkling a little
const STARS = 90;
const starNdc = Array.from({ length: STARS }, () => [Math.random() * 2 - 1, Math.random() * 1.3 - 0.3]);
const starGeo = new THREE.BufferGeometry();
starGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(STARS * 3), 3));
const starMat = new THREE.PointsMaterial({ color: '#ffffff', size: 2, sizeAttenuation: false, transparent: true, depthWrite: false, fog: false });
const stars = new THREE.Points(starGeo, starMat);
stars.frustumCulled = false;
stars.renderOrder = -2;
scene.add(stars);

const FAR = 0.995; // NDC depth: just in front of the far plane, behind everything in town
const a = new THREE.Vector3(), b = new THREE.Vector3(), dir = new THREE.Vector3(), right = new THREE.Vector3();
const smooth = (lo, hi, x) => { const t = Math.min(1, Math.max(0, (x - lo) / (hi - lo))); return t * t * (3 - 2 * t); };

// Put a sprite at a screen spot (NDC) on the far plane, `px` pixels across whatever the camera or zoom
function pin(s, x, y, px) {
  a.set(x, y, FAR).unproject(activeCam);
  b.set(x + 2 / innerWidth, y, FAR).unproject(activeCam);
  s.position.copy(a);
  s.scale.setScalar(a.distanceTo(b) * px);
}

// Which side of the screen a body rises on: its compass direction at rise, seen from the camera. It slides smoothly
// through the middle as the camera turns (a hard -1/1 made the sun jump across the sky mid-rotation).
function riseSide(worldX, worldZ) {
  right.setFromMatrixColumn(activeCam.matrixWorld, 0).setY(0).normalize();
  return Math.max(-1, Math.min(1, dir.set(worldX, 0, worldZ).normalize().dot(right) * 2));
}
// Arc across the open sky above the town: rise at one top corner, highest mid-screen, set at the other
const arcX = (side, t) => side * 0.55 * Math.cos(t); // t: 0 at rise .. PI at set
const arcY = (el) => 0.45 + 0.45 * Math.max(0, el);

export function updateHeavens() {
  activeCam.updateMatrixWorld(); // this frame's camera, not last frame's, or they swim while you drag
  const ang = ((sky.hour - 6) / 12) * Math.PI, el = Math.sin(ang); // same arc as the light in sky.js
  const clear = 1 - Math.min(1, sky.cloud * 1.1);
  // Sun: along the light's own direction (-cos, 6) so its shadows point away from it
  sunSprite.visible = el > -0.1;
  if (sunSprite.visible) {
    pin(sunSprite, arcX(riseSide(-14, 6), ang), arcY(el), 150); // rises where sky.js's morning light comes from
    sunSprite.material.opacity = smooth(-0.1, 0.08, el) * (0.25 + 0.75 * clear);
    sunSprite.material.color.set('#ffffff').lerp(new THREE.Color('#ffae70'), 1 - smooth(0, 0.35, el));
  }
  // Moon: opposite the sun, where sky.js puts the night light
  const mel = -el;
  moonSprite.visible = mel > -0.1;
  if (moonSprite.visible) {
    const today = `${sky.y}-${sky.mo}-${sky.d}`;
    if (today !== moonDay) {
      moonDay = today;
      moonSprite.material.map?.dispose();
      moonSprite.material.map = moonTexture(moonPhase());
      moonSprite.material.needsUpdate = true;
    }
    pin(moonSprite, arcX(riseSide(-10, -4), ang - Math.PI), arcY(mel), 130); // sky.js's moonlight at moonrise
    moonSprite.material.opacity = smooth(-0.1, 0.08, mel) * (0.15 + 0.85 * clear);
  }
  // Stars come out as it gets dark and hide behind cloud
  const starOpacity = smooth(0.55, 0.95, sky.night) * clear;
  stars.visible = starOpacity > 0.01;
  if (stars.visible) {
    const pos = starGeo.attributes.position;
    starNdc.forEach(([x, y], i) => { a.set(x, y, FAR).unproject(activeCam); pos.setXYZ(i, a.x, a.y, a.z); });
    pos.needsUpdate = true;
    starMat.opacity = starOpacity * (0.85 + 0.15 * Math.sin(performance.now() / 700));
  }
}

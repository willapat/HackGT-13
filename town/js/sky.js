// Sky: time of day and weather, night lighting (street lamps, lit windows), and weather on surfaces.
import * as THREE from 'three';
import { GROUND, ROAD } from './assets.js';
import { activeCam, following } from './camera.js';
import { logFeed } from './hud.js';
import { LANDSCAPE, N, pos, townApi } from './layout.js';
import { models } from './models.js';
import { controls, hemi, renderer, scene, SNOW_SKIP, sun } from './stage.js';

// Time follows GET /demo/clock (live, fast, or the slider). Weather drifts on its own
// every couple of minutes until a weather button pins it.

export const sky = {
  hour: 12, live: true, fast: false, play: false, backend: false,
  y: 0, mo: 0, d: 0,
  weather: 'clear', autoWeather: true, nextWeatherAt: 0,
  cloud: 0, precip: 0, haze: 0, flash: 0, nextFlashAt: 0, night: 0, patchAt: 0,
};
export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
function townDateLabel() {
  const y = sky.y, mo = sky.mo, d = sky.d;
  const src = y ? { y, mo, d } : (() => { const n = new Date(); return { y: n.getFullYear(), mo: n.getMonth() + 1, d: n.getDate() }; })();
  const wd = WEEKDAYS[new Date(src.y, src.mo - 1, src.d).getDay()];
  return `${wd} ${String(src.mo).padStart(2, '0')}/${String(src.d).padStart(2, '0')}/${src.y}`;
}
const WEATHER = { // cloud cover, precipitation kind, haze (how far you can see)
  clear: { cloud: 0, kind: null, haze: 0 }, rain: { cloud: 0.6, kind: 'rain', haze: 0.35 },
  storm: { cloud: 0.85, kind: 'rain', haze: 0.6 }, snow: { cloud: 0.5, kind: 'snow', haze: 0.45 },
};
const C = (h) => new THREE.Color(h);
const SKY = { day: C('#9fd3ec'), dusk: C('#f3a36b'), night: C('#1b2b57'), overcastDay: C('#9aa5b3'), overcastNight: C('#232b3d') };
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// Rain streaks and snow flakes share one volume over the town
const VOLUME = { x: N / 2 + 1, z0: -N / 2 - 1, z1: N / 2 + 1, h: 9 };
const DROPS = 2600;
const dropPos = new Float32Array(DROPS * 6);
const dropSeed = Float32Array.from({ length: DROPS * 3 }, Math.random);
const rainGeo = new THREE.BufferGeometry();
rainGeo.setAttribute('position', new THREE.BufferAttribute(dropPos, 3));
const rain = new THREE.LineSegments(rainGeo, new THREE.LineBasicMaterial({ color: '#b9d6ff', transparent: true, opacity: 0.55 }));
// Snow flakes are soft round discs sized in world units, so they grow as the camera zooms in (a
// plain PointsMaterial stays a fixed few pixels under the orthographic camera and reads as noise).
const FLAKES = 4000;
const flakePos = new Float32Array(FLAKES * 3);
const flakeSeed = Float32Array.from({ length: FLAKES * 4 }, Math.random);
const snowGeo = new THREE.BufferGeometry();
snowGeo.setAttribute('position', new THREE.BufferAttribute(flakePos, 3));
snowGeo.setAttribute('size', new THREE.BufferAttribute(Float32Array.from({ length: FLAKES }, () => 0.5 + Math.random() ** 2 * 1.3), 1));
const snow = new THREE.Points(snowGeo, new THREE.ShaderMaterial({
  uniforms: { world: { value: 0.05 }, halfH: { value: 450 }, color: { value: new THREE.Color('#ffffff') }, opacity: { value: 0.95 } },
  vertexShader: `
    attribute float size;
    uniform float world, halfH;
    void main() {
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      gl_Position = projectionMatrix * mv;
      float persp = projectionMatrix[3][3] == 0.0 ? 1.0 / -mv.z : 1.0;
      gl_PointSize = max(1.5, size * world * projectionMatrix[1][1] * halfH * persp);
    }`,
  fragmentShader: `
    uniform vec3 color;
    uniform float opacity;
    void main() {
      float d = length(gl_PointCoord - 0.5);
      gl_FragColor = vec4(color, opacity * smoothstep(0.5, 0.2, d));
    }`,
  transparent: true, depthWrite: false,
}));
rain.frustumCulled = snow.frustumCulled = false;
scene.add(rain, snow);
let fallT = 0;
const wrap = (v, lo, hi) => lo + ((((v - lo) % (hi - lo)) + (hi - lo)) % (hi - lo));

// Weather on surfaces, patched into every lit material's shader (one shared program variant):
// - snow cover: upward faces (grass, roofs, treetops, roads a little) whiten while it snows, melt after
// - wetness: in rain everything darkens a touch, up-facing ground more, and roads turn glossy
// - grey: overcast light washes some color out of the town
// - cloud shadows: soft patches drift across the town while the sun is up
const WX = {
  snowCover: { value: 0 }, wet: { value: 0 }, grey: { value: 0 }, cloudShade: { value: 0 },
  cloudOffset: { value: new THREE.Vector2() },
};
const patched = new WeakSet(); // not userData: clones (see-through buildings) copy that but not the shader hook
const WX_VERTEX = `
  vec4 wxWorld = modelMatrix * vec4(transformed, 1.0);
  vWxXZ = wxWorld.xz;`;
const WX_FRAGMENT = `
  float wxUp = smoothstep(0.5, 0.85, vWxUp);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(dot(diffuseColor.rgb, vec3(0.3, 0.59, 0.11))), grey);
  float wxWet = wet * wetAmount;
  diffuseColor.rgb *= 1.0 - wxWet * mix(0.12, 0.38, wxUp);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.93, 0.95, 0.98), snowCover * snowAmount * wxUp);
  vec2 wxP = vWxXZ * 0.11 + cloudOffset;
  float wxN = wxNoise(wxP) * 0.65 + wxNoise(wxP * 2.3 + 7.1) * 0.35;
  diffuseColor.rgb *= 1.0 - cloudShade * smoothstep(0.48, 0.68, wxN);`;
const WX_NOISE = `
  varying float vWxUp;
  varying vec2 vWxXZ;
  uniform float snowCover, snowAmount, wet, wetAmount, grey, cloudShade;
  uniform vec2 cloudOffset;
  float wxHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float wxNoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(wxHash(i), wxHash(i + vec2(1.0, 0.0)), f.x), mix(wxHash(i + vec2(0.0, 1.0)), wxHash(i + 1.0), f.x), f.y);
  }`;
function addWeather(mat, { snow = 1, wet = 0.5 } = {}) {
  if (patched.has(mat) || SNOW_SKIP.has(mat) || !(mat.isMeshStandardMaterial || mat.isMeshLambertMaterial || mat.isMeshPhongMaterial)) return;
  patched.add(mat);
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, WX, { snowAmount: { value: snow }, wetAmount: { value: wet } });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vWxUp;\nvarying vec2 vWxXZ;')
      .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\nvWxUp = normalize(mat3(modelMatrix) * objectNormal).y;')
      .replace('#include <project_vertex>', `#include <project_vertex>${WX_VERTEX}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>${WX_NOISE}`)
      .replace('#include <map_fragment>', `#include <map_fragment>${WX_FRAGMENT}`)
      // wet roads gloss up (standard materials only; the others have no roughness)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.28, wxWet * wxUp * step(0.9, wetAmount));');
  };
  mat.customProgramCacheKey = () => 'weather';
  mat.needsUpdate = true;
}
export function patchWeather() {
  const roads = new Set();
  for (const p of [...Object.values(ROAD), GROUND.paved]) models[p].scene.traverse((m) => { if (m.isMesh) [m.material].flat().forEach((x) => roads.add(x)); });
  scene.traverse((m) => {
    if (!m.isMesh || m.isSkinnedMesh || m.userData.depthPass) return;
    for (const mat of [m.material].flat()) addWeather(mat, roads.has(mat) ? { snow: 0.45, wet: 1 } : undefined);
  });
}

// Night lighting: a glowing bulb and a pool of light under every street light, and lit windows
const glowTex = (() => {
  const cv = Object.assign(document.createElement('canvas'), { width: 64, height: 64 });
  const g = cv.getContext('2d').createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,170,80,1)'); g.addColorStop(0.45, 'rgba(255,150,60,0.45)'); g.addColorStop(1, 'rgba(255,140,50,0)');
  const ctx = cv.getContext('2d'); ctx.fillStyle = g; ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(cv);
})();
const lampGlow = [];
export const LAMPS = []; // every street light placed in buildCity: tile position and rotation
export function addStreetLamps() {
  const bulbMat = new THREE.MeshBasicMaterial({ color: '#ffc27a', transparent: true }); // warm sodium-ish glow
  const poolMat = new THREE.MeshBasicMaterial({ map: glowTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
  lampGlow.pools = [];
  for (const { x, z, rotY } of LAMPS) {
    // The lamp's arm reaches 0.207 tiles along its local -x; rotate that to find the bulb
    const head = pos(x - 0.207 * Math.cos(rotY), z + 0.207 * Math.sin(rotY));
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.035, 10, 8), bulbMat);
    bulb.position.copy(head).setY(0.55);
    const pool = new THREE.Mesh(new THREE.CircleGeometry(0.55, 24), poolMat);
    pool.rotation.x = -Math.PI / 2;
    pool.position.copy(head).setY(0.025);
    scene.add(bulb, pool);
    lampGlow.push(bulb, pool);
    lampGlow.pools.push(pool);
  }
  lampGlow.materials = [bulbMat, poolMat];
}
// Lit windows. Each wall triangle of a building is sampled at its texture color: Kenney glass is a
// light sky blue, SimplePoly windows a flat dark grey (its walls are often blue, so one color rule
// can't serve both). Window faces go into a second material group that glows at night; only ~60% of
// panes are lit so it reads as occupied rooms, not a glowing facade.
export const windowMats = new Set();
const texPixels = new Map();
function pixelsOf(tex) {
  if (!texPixels.has(tex)) {
    const img = tex.image;
    const cv = Object.assign(document.createElement('canvas'), { width: img.width, height: img.height });
    const ctx = cv.getContext('2d');
    ctx.drawImage(img, 0, 0);
    texPixels.set(tex, { w: cv.width, h: cv.height, data: ctx.getImageData(0, 0, cv.width, cv.height).data });
  }
  return texPixels.get(tex);
}
const isGlass = {
  kenney: (r, g, b) => b > 165 && b - r > 40,
  simplepoly: (r, g, b) => Math.max(r, g, b) - Math.min(r, g, b) < 18 && (r + g + b) / 3 > 40 && (r + g + b) / 3 < 110,
};
const litCopies = new Map();
export function lightWindows(obj, pack) {
  obj.traverse((m) => {
    if (!m.isMesh || Array.isArray(m.material) || !m.material.map || m.userData.roofProp) return;
    const g = m.geometry;
    if (!g.userData.windowTris) { // split once per shared geometry: [wall..., lit window...]
      const src = g.index ? g.toNonIndexed() : g;
      const P = src.attributes.position, UV = src.attributes.uv, tris = P.count / 3;
      const px = pixelsOf(m.material.map);
      const [a, b, c, n] = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
      const lit = [];
      for (let t = 0; t < tris; t++) {
        a.fromBufferAttribute(P, t * 3); b.fromBufferAttribute(P, t * 3 + 1); c.fromBufferAttribute(P, t * 3 + 2);
        n.subVectors(c, b).cross(a.clone().sub(b)).normalize();
        let on = false;
        if (UV && Math.abs(n.y) < 0.3 && ((Math.floor(t / 2) * 2654435761) >>> 0) % 10 < 6) {
          const u = (UV.getX(t * 3) + UV.getX(t * 3 + 1) + UV.getX(t * 3 + 2)) / 3;
          const v = (UV.getY(t * 3) + UV.getY(t * 3 + 1) + UV.getY(t * 3 + 2)) / 3;
          const x = Math.min(px.w - 1, Math.max(0, Math.floor((((u % 1) + 1) % 1) * px.w)));
          const y = Math.min(px.h - 1, Math.max(0, Math.floor((((v % 1) + 1) % 1) * px.h)));
          const o = (y * px.w + x) * 4;
          on = isGlass[pack](px.data[o], px.data[o + 1], px.data[o + 2]);
        }
        lit.push(on);
      }
      const order = [...Array(tris).keys()].sort((x, y) => lit[x] - lit[y]);
      const out = new THREE.BufferGeometry();
      for (const name of Object.keys(src.attributes)) {
        const at = src.attributes[name], k = at.itemSize, arr = new Float32Array(at.count * k);
        order.forEach((t, i) => { for (let v = 0; v < 3; v++) for (let j = 0; j < k; j++) arr[(i * 3 + v) * k + j] = at.getComponent(t * 3 + v, j); });
        out.setAttribute(name, new THREE.BufferAttribute(arr, k, at.normalized));
      }
      const walls = lit.filter((x) => !x).length;
      out.addGroup(0, walls * 3, 0);
      out.addGroup(walls * 3, (tris - walls) * 3, 1);
      out.userData.windowTris = tris - walls;
      g.userData.windowTris = out; // later clones of this model reuse the split
    }
    const split = g.userData.windowTris instanceof THREE.BufferGeometry ? g.userData.windowTris : g;
    if (!split.userData.windowTris) return;
    if (!litCopies.has(m.material)) {
      const glow = m.material.clone();
      glow.emissive = new THREE.Color('#ffc978');
      glow.emissiveIntensity = 0;
      windowMats.add(glow);
      litCopies.set(m.material, glow);
    }
    m.geometry = split;
    m.material = [m.material, litCopies.get(m.material)];
  });
}

function setWeather(w, pinned = true) {
  sky.weather = w;
  if (pinned) sky.autoWeather = false;
  document.querySelectorAll('[data-weather]').forEach((b) => b.classList.toggle('on', b.dataset.weather === (sky.autoWeather ? 'auto' : w)));
  logFeed(`Weather: ${w}${sky.autoWeather ? ' (changing on its own)' : ''}.`);
}

export function updateSky(dt) {
  // The label follows the server clock. Live ticks forward from the last GET /demo/clock;
  // Fast day uses the same rate as the backend (a full day in two minutes). The laptop clock
  // is not the town clock — that was showing 11:46 while the server was still on 9:03.
  if (sky.backend && sky.syncedAt && sky.live) {
    sky.hour = sky.syncedHour + (performance.now() - sky.syncedAt) / 3600000;
  } else if (sky.backend && sky.syncedAt && sky.fast) {
    sky.hour = sky.syncedHour + (performance.now() - sky.syncedAt) * (24 / 120000);
  } else if (sky.backend && sky.syncedAt && sky.play) {
    sky.hour = sky.syncedHour + (performance.now() - sky.syncedAt) / 60000;
  } else if (sky.fast) {
    sky.hour = (sky.hour + dt * (24 / 120)) % 24;
  } else if (sky.play) {
    sky.hour = (sky.hour + dt / 60) % 24;
  } // Fast: a whole day in two minutes. Play: one game minute per real second.
  if (sky.autoWeather && performance.now() > sky.nextWeatherAt) {
    const kinds = { snowy: ['clear', 'snow', 'snow'], desert: ['clear'] }[LANDSCAPE]
      || ['clear', 'clear', 'rain', 'storm', 'snow'];
    setWeather(kinds[Math.floor(Math.random() * kinds.length)], false);
    if (!sky.nextWeatherAt) { // first pick on load: start already in it instead of easing in
      sky.cloud = WEATHER[sky.weather].cloud;
      sky.precip = WEATHER[sky.weather].kind ? 1 : 0;
    }
    sky.nextWeatherAt = performance.now() + 70000 + Math.random() * 80000;
  }
  const w = WEATHER[sky.weather];
  sky.cloud += (w.cloud - sky.cloud) * Math.min(1, dt * 0.6);
  sky.precip += ((w.kind ? 1 : 0) - sky.precip) * Math.min(1, dt * 0.5);
  sky.haze += (w.haze - sky.haze) * Math.min(1, dt * 0.4);

  // Sun: rises at 6, sets at 18. `el` is its height (-1..1); twilight glows near the horizon.
  const a = ((sky.hour - 6) / 12) * Math.PI, el = Math.sin(a);
  const day = smooth(-0.12, 0.2, el), twilight = Math.max(0, 1 - Math.abs(el) / 0.28) * smooth(-0.3, 0, el);
  sky.night = 1 - day;
  const col = SKY.night.clone().lerp(SKY.day, day).lerp(SKY.dusk, twilight * 0.7);
  col.lerp(SKY.overcastNight.clone().lerp(SKY.overcastDay, day), sky.cloud * 0.8);
  if (sky.flash > 0) col.lerp(C('#e8eeff'), sky.flash);
  scene.background.copy(col);

  const up = Math.max(el, 0.18);
  if (day > 0.02) sun.position.set(-Math.cos(a) * 14, up * 16, 6);
  else sun.position.set(Math.cos(a) * 10, 12, -4); // moonlight from the other side
  // Under cloud the sun goes cool and weak and shadows soften, so the light is flat and grey; the
  // sky light carries more of the scene. Snow on the ground bounces light back up.
  sun.color.copy(C('#fff4e0')).lerp(C('#ffb070'), twilight).lerp(C('#9fb3ff'), 1 - day).lerp(C('#c9d3e2'), sky.cloud * 0.8 * day);
  sun.intensity = (0.6 + 1.6 * day) * (1 - 0.8 * sky.cloud) + sky.flash * 2.5;
  sun.shadow.intensity = 1 - 0.75 * sky.cloud;
  hemi.intensity = (0.85 + 0.75 * day) * (1 - 0.2 * sky.cloud) + sky.flash * 1.5;
  hemi.color.copy(C('#8494cc')).lerp(C('#ffffff'), day).lerp(C('#c4cfdf'), sky.cloud * 0.7 * day);
  hemi.groundColor.copy(C('#34405a')).lerp(C('#8a9a7a'), day).lerp(C('#dfe6ee'), WX.snowCover.value * day);

  // Haze: the far side of town fades into the sky color. The range is measured from the camera's
  // distance to what it looks at, so it reads the same zoomed in, zoomed out or following someone.
  const look = following ? following.obj.position : controls.target;
  const d = activeCam.position.distanceTo(look);
  scene.fog.color.copy(col);
  scene.fog.near = sky.haze > 0.01 ? d - 4 : 1000;
  scene.fog.far = sky.haze > 0.01 ? d - 4 + 14 / sky.haze : 2000;

  // Surfaces: wet in rain (dries slowly), a little greyer under cloud, and cloud shadows drifting by
  // while the sun is up (a few fair-weather clouds even on clear days)
  WX.wet.value = Math.min(1, Math.max(0, WX.wet.value + (w.kind === 'rain' ? dt / 15 : -dt / 60)));
  WX.grey.value = sky.cloud * 0.45;
  WX.cloudShade.value = (sky.weather === 'clear' ? 0.2 : 0.1 + 0.22 * 4 * sky.cloud * (1 - sky.cloud)) * day;
  WX.cloudOffset.value.x -= dt * 0.035 * (sky.weather === 'storm' ? 3 : 1);
  WX.cloudOffset.value.y -= dt * 0.02 * (sky.weather === 'storm' ? 3 : 1);

  // Lightning in storms: a quick double flash every few seconds
  if (sky.weather === 'storm' && performance.now() > sky.nextFlashAt) {
    sky.flash = 1;
    sky.nextFlashAt = performance.now() + 3500 + Math.random() * 6000;
  }
  sky.flash = Math.max(0, sky.flash - dt * 5);

  // Night lights
  const lit = smooth(0.35, 0.8, sky.night + sky.cloud * 0.25);
  for (const m of lampGlow.materials ?? []) m.opacity = lit;
  for (const g of lampGlow) g.visible = lit > 0.01;
  if (lampGlow.materials) lampGlow.materials[1].opacity = lit * (1 + 0.6 * WX.wet.value); // wet streets throw the light back
  for (const g of lampGlow.pools ?? []) g.scale.setScalar(1 + 0.35 * WX.wet.value);
  for (const m of windowMats) m.emissiveIntensity = lit * 1.4;

  // Precipitation: only a share of the drops fall, ramping with the weather
  fallT += dt;
  const kind = w.kind ?? (sky.precip > 0.02 ? (snow.visible ? 'snow' : 'rain') : null);
  const count = Math.floor(DROPS * sky.precip * (sky.weather === 'storm' ? 1 : 0.6));
  const flakes = Math.floor(FLAKES * sky.precip);
  rain.visible = kind === 'rain' && count > 0;
  snow.visible = kind === 'snow' && flakes > 0;
  const span = VOLUME.z1 - VOLUME.z0;
  if (rain.visible) for (let i = 0; i < count; i++) {
    const [sx, sy, sz] = [dropSeed[i * 3], dropSeed[i * 3 + 1], dropSeed[i * 3 + 2]];
    const x = (sx * 2 - 1) * VOLUME.x, z = VOLUME.z0 + sz * span;
    const y = VOLUME.h - ((sy * VOLUME.h + fallT * 9) % VOLUME.h);
    dropPos.set([x, y, z, x - 0.04, y + 0.28, z - 0.02], i * 6);
  }
  if (snow.visible) for (let i = 0; i < flakes; i++) {
    // Each flake falls at its own pace, flutters, and drifts with a light breeze (wrapping around the volume)
    const [sx, sy, sz, sp] = [flakeSeed[i * 4], flakeSeed[i * 4 + 1], flakeSeed[i * 4 + 2], flakeSeed[i * 4 + 3]];
    const fall = fallT * (0.35 + sp * 0.35);
    const y = VOLUME.h - ((sy * VOLUME.h + fall) % VOLUME.h);
    const x = wrap((sx * 2 - 1) * VOLUME.x + fall * 0.35 + Math.sin(fallT * (0.6 + sp) + sx * 40) * 0.25, -VOLUME.x, VOLUME.x);
    const z = wrap(VOLUME.z0 + sz * span + Math.cos(fallT * (0.5 + sp) + sz * 40) * 0.25, VOLUME.z0, VOLUME.z1);
    flakePos.set([x, y, z], i * 3);
  }
  rainGeo.setDrawRange(0, count * 2);
  snowGeo.setDrawRange(0, flakes);
  snow.material.uniforms.halfH.value = renderer.domElement.height / 2;
  snow.material.uniforms.color.value.setScalar(0.55 + 0.45 * (1 - sky.night)); // flakes dim at night

  // Snow settles while it snows and melts (faster in rain) once it stops
  const settle = sky.weather === 'snow' ? dt / 30 : -dt / (w.kind === 'rain' ? 12 : 45);
  WX.snowCover.value = Math.min(1, Math.max(LANDSCAPE === 'snowy' ? 0.85 : 0, WX.snowCover.value + settle)); // a snowy town stays white
  if (performance.now() > sky.patchAt) { // pick up materials cloned since (see-through buildings)
    patchWeather();
    sky.patchAt = performance.now() + 2000;
  }
  rainGeo.attributes.position.needsUpdate = snowGeo.attributes.position.needsUpdate = true;
  rain.material.opacity = sky.weather === 'storm' ? 0.7 : 0.5;

  const label = document.querySelector('#clock');
  if (label) {
    const h = Math.floor(sky.hour), m = Math.floor((sky.hour % 1) * 60);
    label.textContent = `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}${sky.live ? ' · live' : sky.fast ? ' · ⏩' : sky.play ? ' · ▶' : ''}`;
    const slider = document.querySelector('#time');
    if (document.activeElement !== slider) slider.value = sky.hour % 24;
    const play = document.querySelector('#time-play');
    const playText = sky.play ? '⏸' : '▶';
    if (play && play.textContent !== playText) {
      play.textContent = playText;
      play.title = sky.play ? 'Pause the clock' : 'Play: one minute per second';
      play.classList.toggle('on', sky.play);
    }
  }
  const dateEl = document.querySelector('#town-date');
  if (dateEl) dateEl.textContent = townDateLabel();
}

function hourFromIso(iso) {
  const m = String(iso || '').match(/T(\d{2}):(\d{2}):(\d{2})/);
  return m ? +m[1] + +m[2] / 60 + +m[3] / 3600 : null;
}

// False while a drag is in flight, or this page is showing a different hour than `townTime`.
// Placements from that response belong to the other hour, so drawing them teleports people.
export function placementsMatchScreen(townTime, mode) {
  if (sky.pendingScrub) return false;
  if (!sky.backend) return true;
  if (sky.live && mode && mode !== 'live') return false;
  if (sky.fast && mode && mode !== 'fast') return false;
  if (sky.play && mode && mode !== 'play') return false;
  if (!sky.live && !sky.fast && !sky.play) {
    const serverHour = hourFromIso(townTime);
    if (serverHour != null && Math.abs(serverHour - sky.hour) > 1 / 60) return false;
  }
  return true;
}

function dateFromIso(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? { y: +m[1], mo: +m[2], d: +m[3] } : null;
}

export function applyTownTime(iso, mode, source = 'boot') {
  const ymd = dateFromIso(iso);
  if (ymd) { sky.y = ymd.y; sky.mo = ymd.mo; sky.d = ymd.d; }
  const hour = hourFromIso(iso);
  if (hour == null) return;
  sky.backend = true;
  // A background poll must not undo Live / Fast, and must not steal the slider mid-drag.
  if (source === 'poll' && sky.pendingScrub) return;
  if (source === 'poll' && sky.live && mode !== 'live') return;
  if (source === 'poll' && sky.fast && mode !== 'fast') return;
  if (source === 'poll' && sky.play && mode !== 'play') return;
  if (document.activeElement === document.querySelector('#time')) return;
  // The slider owns the clock until Live / Fast / Play is clicked. Don't snap back to "live".
  if (!sky.live && !sky.fast && !sky.play && mode === 'live') return;
  // A late poll from before the drag must not move the label back to the old hour.
  if (source === 'poll' && !sky.live && !sky.fast && !sky.play && Math.abs(hour - sky.hour) > 1 / 60) return;
  sky.hour = hour;
  if (mode === 'live' || mode === 'fast' || mode === 'play') {
    sky.syncedHour = hour;
    sky.syncedAt = performance.now();
  } else {
    sky.syncedAt = 0;
  }
  if (mode === 'live') { sky.live = true; sky.fast = false; sky.play = false; }
  if (mode === 'fast') { sky.live = false; sky.fast = true; sky.play = false; }
  if (mode === 'play') { sky.live = false; sky.fast = false; sky.play = true; }
  if (mode === 'scrub') { sky.live = false; sky.fast = false; sky.play = false; }
}

export function wireSkyControls() {
  const slider = document.querySelector('#time');
  let clockTimer = null;
  let clockSeq = 0;
  let clockChain = Promise.resolve();
  // Posts run one at a time. Live bumps clockSeq and drops any slider post that has not
  // started yet, then sends {live:true} after the one already on the wire, so a drag
  // cannot land last and put the clock back inside the café and library hours.
  const sendClock = (body) => {
    if (!townApi.pushClock) return;
    const seq = ++clockSeq;
    clockChain = clockChain.then(async () => {
      if (seq !== clockSeq) return;
      await townApi.pushClock(body);
    }).catch(() => {});
  };
  slider.oninput = () => {
    sky.live = false;
    sky.fast = false;
    sky.play = false;
    sky.syncedAt = 0;
    sky.pendingScrub = true;
    sky.hour = +slider.value;
    const seq = ++clockSeq;
    clearTimeout(clockTimer);
    clockTimer = setTimeout(() => {
      if (seq !== clockSeq || sky.live || sky.fast || sky.play) return;
      sky.pendingScrub = false;
      sendClock({ hour: sky.hour, live: false, fast: false });
    }, 80);
  };
  slider.onchange = () => {
    if (sky.live || sky.fast || sky.play) return;
    clearTimeout(clockTimer);
    sky.pendingScrub = false;
    sendClock({ hour: sky.hour, live: false, fast: false });
  };
  document.querySelector('#time-live').onclick = () => {
    clearTimeout(clockTimer);
    sky.pendingScrub = false;
    clockSeq++;
    sky.live = true;
    sky.fast = false;
    sky.play = false;
    sendClock({ live: true });
  };
  document.querySelector('#time-fast').onclick = () => {
    clearTimeout(clockTimer);
    sky.pendingScrub = false;
    clockSeq++;
    sky.live = false;
    sky.fast = true;
    sky.play = false;
    sendClock({ fast: true });
  };
  // Play runs from the minute on screen; pressing it again pauses there (same as a slider stop).
  const playBtn = document.querySelector('#time-play');
  if (playBtn) playBtn.onclick = () => {
    clearTimeout(clockTimer);
    sky.pendingScrub = false;
    clockSeq++;
    sky.live = false;
    sky.fast = false;
    if (sky.play) {
      sky.play = false;
      sky.syncedAt = 0;
      sky.hour %= 24;
      sendClock({ hour: sky.hour, live: false, fast: false });
      return;
    }
    sky.play = true;
    sky.syncedHour = sky.hour;
    sky.syncedAt = sky.backend ? performance.now() : 0;
    sendClock({ play: true });
  };
  document.querySelectorAll('[data-weather]').forEach((b) => {
    b.onclick = () => {
      if (b.dataset.weather === 'auto') { sky.autoWeather = true; sky.nextWeatherAt = 1; setWeather(sky.weather, false); return; }
      setWeather(b.dataset.weather);
    };
  });
  const p = new URLSearchParams(location.search);
  if (p.has('hour')) { sky.live = false; sky.hour = +p.get('hour'); }
  if (p.has('weather')) { // start already in that weather instead of easing in
    setWeather(p.get('weather'));
    sky.cloud = WEATHER[sky.weather].cloud;
    sky.precip = WEATHER[sky.weather].kind ? 1 : 0;
    if (sky.weather === 'snow') WX.snowCover.value = 1;
    if (WEATHER[sky.weather].kind === 'rain') WX.wet.value = 1;
  }
}

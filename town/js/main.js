// Luma 3D town: loads the models, builds the town, spawns everyone, and runs the frame loop.
// A real town (?town=<id>) follows the database; otherwise the demo town runs scripted or via the demo backend.
import * as THREE from 'three';
import { startTownBackend } from './realtime.js';
import { startTownSync } from './townsync.js';
import { CH, GROUND, HELIPAD, NATURE, PARASOLS, PARK_TREES, PROPS, ROAD, ROOF_PROPS, STREET, VEHICLES, ZONES } from './assets.js';
import { activeCam, startFollow, updateCamera } from './camera.js';
import { buildCity } from './city.js';
import { applyTownNames, renameFriend, setStatus, trigger } from './demo.js';
import { effects, partyLights, rainCloud } from './effects.js';
import { $, labels, logFeed, showCard } from './hud.js';
import { EXTRA_MODELS, FRIENDS, PLACES, STADIUM, TOWN, TOWN_ID, townApi } from './layout.js';
import { loadAll } from './models.js';
import { updateOcclusion } from './occlusion.js';
import { renderResidents, renderSchedules } from './panels.js';
import { friends, placeAgent, say, spawnFriends, stepFriend, think, walkTo } from './people.js';
import { addStreetLamps, applyTownTime, lightWindows, patchWeather, updateSky, wireSkyControls } from './sky.js';
import { animated, renderer, scene } from './stage.js';

const clock = new THREE.Clock();
const v = new THREE.Vector3();
function frame() {
  const dt = Math.min(clock.getDelta(), 0.1);
  const now = performance.now();
  for (const f of Object.values(friends)) {
    stepFriend(f, dt);
    f.mixer.update(dt);
    if (!townApi.liveMode && !f.busy && !f.path.length && now > f.nextThink) think(f);
  }
  for (const fx of animated) fx.update(dt);
  updateSky(dt);

  updateCamera(dt, now);
  updateOcclusion(dt);
  renderer.render(scene, activeCam);

  // Labels hide while behind a panel: the panels' frosted blur would smear their colors
  const panels = [...document.querySelectorAll('.panel:not([hidden]), #cards .card')].map((e) => e.getBoundingClientRect());
  for (const l of labels) {
    v.copy(l.getPos()).project(activeCam);
    const [x, y] = [(v.x * 0.5 + 0.5) * innerWidth, (-v.y * 0.5 + 0.5) * innerHeight];
    const covered = panels.some((b) => x > b.left - 40 && x < b.right + 40 && y > b.top && y < b.bottom + 24);
    const hidden = v.z > 1 || covered || (l.el.classList.contains('friend') && !friendVisible(l));
    l.el.style.display = hidden ? 'none' : '';
    l.el.style.left = `${x}px`;
    l.el.style.top = `${y}px`;
  }
  requestAnimationFrame(frame);
}
const friendVisible = (l) => Object.values(friends).find((f) => l.el.textContent === f.name)?.obj.visible ?? true;

const allModels = [
  ...ZONES.flatMap((z) => z.models),
  ...Object.values(PLACES).filter((p) => p.model).map((p) => p.model),
  ...FRIENDS.map((f) => `${CH}${f.model}.glb`), ...FRIENDS.map((f) => f.home.model),
  ...Object.values(ROAD), ...Object.values(GROUND), ...PARK_TREES, ...Object.values(PROPS), ...Object.values(NATURE),
  ...ROOF_PROPS, HELIPAD, ...VEHICLES, STADIUM.model,
  ...Object.values(STREET), ...PARASOLS, ...EXTRA_MODELS.map(([, , m]) => m),
];
logFeed('Loading city…');
await loadAll(allModels);
buildCity();
addStreetLamps();
scene.traverse((o) => { if (o.userData.building) lightWindows(o, o.userData.building); });
patchWeather();
wireSkyControls();
spawnFriends();
renderResidents();
Object.assign(townApi, {
  friends, walkTo, say, setStatus, partyLights, rainCloud, showCard, logFeed, renameFriend, renderResidents,
  renderSchedules, PLACES, FRIENDS, effects, trigger, applyTownTime, applyTownNames, placeAgent, liveMode: Boolean(TOWN),
});
if (TOWN) {
  // A real town: no scripted wandering or demo snapshot; residents move only as the database says
  $('#side .title').textContent = TOWN.town.name;
  $('#side .sub').textContent = `Invite code: ${TOWN.town.invite_code}`;
  document.querySelectorAll('#triggers [data-trigger], #triggers h2:first-child, #triggers .note').forEach((e) => { e.hidden = true; });
  const homeless = TOWN.members.length - FRIENDS.length;
  logFeed(`${TOWN.town.name} loaded.${homeless ? ` ${homeless} member(s) haven't placed a house yet.` : ''}`);
  const sync = startTownSync(TOWN_ID, TOWN, {
    friends, placeAgent, setStatus, say, partyLights, rainCloud, logFeed, PLACES, applyTownTime,
  });
  townApi.pushClock = sync.pushClock;
} else {
  logFeed('Town loaded. Demo buttons try the live backend, then fall back to scripted playback.');
  const { triggerViaBackend, pushClock } = startTownBackend(townApi);
  townApi.pushClock = pushClock;
  document.querySelectorAll('[data-trigger]').forEach((b) => { b.onclick = () => triggerViaBackend(b.dataset.trigger); });
  const params = new URLSearchParams(location.search);
  if (friends[params.get('follow')]) startFollow(friends[params.get('follow')]);
  const auto = params.get('auto');
  auto?.split(',').forEach((t, i) => setTimeout(() => triggerViaBackend(t), 1500 + i * 2500));
}
frame();

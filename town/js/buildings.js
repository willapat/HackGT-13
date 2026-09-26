// The place card: click a named building (its tag or the building itself). It floats above the building and
// shows the walk you'll take, then who's there or on the way. Earlier visits appear only when someone has
// already left. Only your own house's card offers a rename (townsync.js updates other labels). Real towns only.
import * as THREE from 'three';
import { api, getSupabase } from '../../frontend/shared/session.js';
import { activeCam } from './camera.js';
import { OPEN_ZOOM } from './stage.js';
import { topOf } from './city.js';
import { $, logFeed } from './hud.js';
import { inkOn, key, PLACES, pos, TOWN, TOWN_ID } from './layout.js';
import { friends, minutesAway, tileOf } from './people.js';

const card = $('#building');
let openId = null, earlier = [], meId = null, liveTimer = null, historyTimer = null, anchor = null;

getSupabase().then((sb) => sb.auth.getSession()).then(({ data }) => { meId = data.session?.user.id ?? null; }).catch(() => {});

const isHouse = (id) => id.startsWith('house:');
const houseOwner = (id) => friends[id.slice(6)];
const nameOf = (id) => (isHouse(id) ? houseOwner(id)?.home?.name || 'A house' : PLACES[id]?.name || id);
const townTime = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); // viewer's own time

// Known place ids (towngen catalog, plus the parks and landmarks a town can name). Anything else stays "Place".
const KIND = {
  cafe: 'Café', library: 'Library', gym: 'Gym', market: 'Market', bakery: 'Bakery',
  pizza: 'Pizzeria', restaurant: 'Restaurant', fastfood: 'Fast food', chicken: 'Chicken shop',
  bar: 'Bar', music: 'Music store', clothing: 'Clothing store', shoes: 'Shoe store',
  gifts: 'Gift shop', pharmacy: 'Pharmacy', grocer: 'Fruit stand', gas: 'Gas station',
  garage: 'Auto shop', factory: 'Factory', park: 'Park', downtown: 'Downtown',
  outerpark: 'Park', stadium: 'Stadium', farm: 'Farm',
};

const kindOf = (id) => (isHouse(id) ? (id === `house:${meId}` ? 'Your house' : 'House') : KIND[id] || 'Place');

function peopleSummary(here, coming) {
  if (!here && !coming) return 'Nobody here or on the way';
  const bits = [];
  if (here) bits.push(`${here} here`);
  if (coming) bits.push(`${coming} on the way`);
  return bits.join(' · ');
}

function awayLabel(f) {
  const mins = minutesAway(f);
  return mins ? `${mins} min away` : 'On the way';
}

// One row: colored initial, name, and a status that is also written out ("Here", "6 min away").
function fill(sel, rows) {
  const ul = $(sel);
  ul.replaceChildren();
  for (const row of rows) {
    const li = document.createElement('li');
    const av = document.createElement('span');
    av.className = 'who-av';
    av.style.background = row.f.color;
    av.style.color = inkOn(row.f.color);
    av.textContent = (row.f.name || '?').trim().slice(0, 1).toUpperCase();
    av.setAttribute('aria-hidden', 'true');
    const name = document.createElement('span');
    name.className = 'who-name';
    name.textContent = row.f.name || 'Friend';
    name.title = name.textContent;
    const status = document.createElement('span');
    status.className = `who-status ${row.kind}`;
    if (row.kind !== 'past') {
      const pip = document.createElement('span');
      pip.className = 'pip';
      pip.setAttribute('aria-hidden', 'true');
      status.append(pip);
    }
    const text = document.createElement('span');
    text.textContent = row.status;
    status.append(text);
    li.append(av, name, status);
    ul.append(li);
  }
}

function render() {
  if (!openId) return;
  const id = openId;
  const own = isHouse(id) && id === `house:${meId}`;
  const name = nameOf(id);
  const kind = kindOf(id);
  const title = $('#bld-name');
  title.textContent = name;
  title.title = name;
  const meta = $('#bld-meta');
  meta.textContent = kind;
  meta.hidden = kind.toLowerCase() === name.trim().toLowerCase();
  $('#bld-rename').hidden = !own;
  $('#bld-go').hidden = !friends[meId];
  // Now and on the way come from the characters as drawn: headed here (agents.target) and arrived or still walking
  const people = Object.values(friends);
  const here = people.filter((f) => f.destId === id && !f.path.length);
  const coming = people.filter((f) => f.destId === id && f.path.length)
    .sort((a, b) => (minutesAway(a) ?? 999) - (minutesAway(b) ?? 999) || (a.name || '').localeCompare(b.name || ''));
  const now = new Set([...here, ...coming].map((f) => f.id));
  const before = earlier.filter((v) => friends[v.user_id] && !now.has(v.user_id));
  $('#bld-summary').textContent = peopleSummary(here.length, coming.length);
  fill('#bld-people', [
    ...here.map((f) => ({ f, status: 'Here', kind: 'here' })),
    ...coming.map((f) => ({ f, status: awayLabel(f), kind: 'away' })),
  ]);
  const past = $('#bld-earlier-wrap');
  past.hidden = !before.length;
  if (before.length) fill('#bld-earlier', before.map((v) => ({ f: friends[v.user_id], status: townTime(v.at), kind: 'past' })));
}

async function loadHistory() {
  const id = openId;
  try {
    const rows = await api(`/towns/${TOWN_ID}/buildings/${encodeURIComponent(id)}/visits`);
    if (openId === id) { earlier = rows; render(); }
  } catch (e) {
    console.warn('building visits', e);
  }
}

// The card floats above its building. Its on-screen size follows the map zoom, capped at the
// size it has when the town first opens, so scrolling out does not leave a huge card over a small town.
function anchorOf(id) {
  const [c, r] = isHouse(id) ? houseOwner(id)?.home?.house ?? [] : [PLACES[id]?.c, PLACES[id]?.r];
  return c == null ? null : pos(c, r).setY((topOf[key(c, r)] ?? 1) + 0.35);
}
const screen = new THREE.Vector3();
function follow() {
  if (!openId) return;
  if (anchor) {
    screen.copy(anchor).project(activeCam);
    const behind = screen.z > 1;
    card.style.visibility = behind ? 'hidden' : '';
    card.style.left = `${(screen.x * 0.5 + 0.5) * innerWidth}px`;
    card.style.top = `${(-screen.y * 0.5 + 0.5) * innerHeight}px`;
    const zoom = activeCam.isOrthographicCamera ? activeCam.zoom : OPEN_ZOOM;
    const scale = Math.min(1, zoom / OPEN_ZOOM);
    card.style.transform = `translate(-50%, calc(-100% - 14px)) scale(${scale})`;
  }
  requestAnimationFrame(follow);
}

function open(id) {
  if (!TOWN) return;
  const wasOpen = openId !== null;
  openId = id;
  anchor = anchorOf(id);
  earlier = [];
  $('#bld-rename-input').value = isHouse(id) ? houseOwner(id)?.home?.name || '' : '';
  card.hidden = false;
  if (!wasOpen) requestAnimationFrame(follow);
  render();
  loadHistory();
  clearInterval(liveTimer);
  clearInterval(historyTimer);
  liveTimer = setInterval(render, 1000); // people arrive and leave while it's open
  historyTimer = setInterval(loadHistory, 30000);
}

function close() {
  openId = null;
  card.hidden = true;
  clearInterval(liveTimer);
  clearInterval(historyTimer);
}

addEventListener('town:building', (e) => open(e.detail));
$('#bld-close').onclick = close;
addEventListener('keydown', (e) => { if (e.key === 'Escape' && openId) close(); });

// Rename your own house: saved for everyone (town_members.home.name); an empty name goes back to the default
$('#bld-rename').onsubmit = async (e) => {
  e.preventDefault();
  const me = friends[meId];
  if (!me) return;
  const name = $('#bld-rename-input').value.trim();
  const button = $('#bld-rename button');
  button.disabled = true;
  try {
    const row = await api(`/towns/${TOWN_ID}/members/me/home`, { method: 'PATCH', body: { name: name || null } });
    me.home.name = row.home?.name || `${me.name}'s house`;
    me.homeLabel.el.textContent = me.home.name;
    logFeed(`You renamed your house to “${me.home.name}”.`);
    render();
  } catch (err) {
    logFeed(`Couldn't rename your house: ${err.message}`);
  } finally {
    button.disabled = false;
  }
};

$('#bld-go').onsubmit = async (e) => {
  e.preventDefault();
  const me = friends[meId];
  if (!me || !openId) return;
  // ponytail: the box is seconds for now (quick demo walks); back to minutes by dropping the / 60
  const seconds = Math.round(Number($('#bld-minutes').value));
  if (!(seconds >= 1 && seconds <= 180)) {
    logFeed('Pick a travel time between 1 and 180 seconds.');
    return;
  }
  const here = tileOf(me);
  const button = $('#bld-go button');
  button.disabled = true;
  try {
    await api(`/towns/${TOWN_ID}/members/me/move`, {
      method: 'POST',
      body: { building_id: openId, from_x: here.x, from_y: here.y, travel_minutes: seconds / 60 },
    });
    logFeed(`You head to ${nameOf(openId)} (${seconds} sec).`);
    close();
  } catch (err) {
    logFeed(`Couldn't head there: ${err.message}`);
  } finally {
    button.disabled = false;
  }
};

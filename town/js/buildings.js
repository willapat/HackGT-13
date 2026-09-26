// The place card: click a named building (its tag or the building itself). It floats above the building and
// shows the walk you'll take, then who's there or on the way. Earlier visits appear only when someone has
// already left. Only your own house's card offers a rename (townsync.js updates other labels). Real towns only.
import * as THREE from 'three';
import { api, getSupabase } from '../../frontend/shared/session.js';
import { activeCam, focusOn, stopFollow } from './camera.js';
import { renderer } from './stage.js';
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
const townTime = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' });

// Known place ids (towngen catalog, plus the parks and landmarks a town can name). Anything else stays "Place".
const KIND = {
  cafe: 'Café', library: 'Library', university: 'University', gym: 'Gym', market: 'Market',
  restaurant: 'Restaurant', bar: 'Bar', pharmacy: 'Pharmacy', grocer: 'Fruit stand', gas: 'Gas station',
  factory: 'Factory', mall: 'Mall', hospital: 'Hospital', airport: 'Airport', townpark: 'Park',
  church: 'Church', barber: 'Barber', sportsfield: 'Sports Field', office: 'Office',
  park: 'Park', downtown: 'Downtown', outerpark: 'Park', stadium: 'Stadium', farm: 'Farm',
  bakery: 'Bakery', pizza: 'Pizzeria', fastfood: 'Fast food', chicken: 'Chicken shop',
  music: 'Music store', clothing: 'Clothing store', shoes: 'Shoe store', gifts: 'Gift shop', garage: 'Auto shop',
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

// The card floats above its building at a fixed size, so the close button stays clickable
// however far the map is zoomed.
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
    card.style.transform = 'translate(-50%, calc(-100% - 14px))';
    // Keep the whole card, including the close button, inside the window.
    const box = card.getBoundingClientRect();
    let dx = 0, dy = 0;
    if (box.top < 12) dy = 12 - box.top;
    if (box.left < 12) dx = 12 - box.left;
    if (box.right > innerWidth - 12) dx = innerWidth - 12 - box.right;
    if (dx || dy) card.style.transform = `translate(calc(-50% + ${dx}px), calc(-100% - 14px + ${dy}px))`;
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
  if (anchor) { stopFollow(); focusOn(anchor); } // center once; panning still works with the card open
  if (!wasOpen) requestAnimationFrame(follow);
  render();
  loadHistory();
  clearInterval(liveTimer);
  clearInterval(historyTimer);
  liveTimer = setInterval(render, 1000); // people arrive and leave while it's open
  historyTimer = setInterval(loadHistory, 30000);
}

function close() {
  if (!openId) return;
  openId = null;
  card.hidden = true;
  clearInterval(liveTimer);
  clearInterval(historyTimer);
}

addEventListener('town:building', (e) => open(e.detail));
addEventListener('town:close-building', () => close());
$('#bld-close').onclick = close;
addEventListener('keydown', (e) => { if (e.key === 'Escape' && openId) close(); });

// A click that isn't the card, and isn't a place name (that click opens one), closes it.
// The map itself is handled in camera.js so a drag there doesn't count as a click.
let press = null;
addEventListener('pointerdown', (e) => { press = [e.clientX, e.clientY, e.target]; });
addEventListener('pointerup', (e) => {
  if (!openId || !press) return;
  const [x, y, target] = press;
  press = null;
  if (Math.hypot(e.clientX - x, e.clientY - y) > 6) return;
  if (card.contains(target) || card.contains(e.target)) return;
  if (target === renderer.domElement || e.target === renderer.domElement) return;
  if (target.closest?.('.lbl.place') || e.target.closest?.('.lbl.place')) return;
  close();
});

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
  const minutes = Math.round(Number($('#bld-minutes').value));
  if (!(minutes >= 1 && minutes <= 180)) {
    logFeed('Pick a travel time between 1 and 180 minutes.');
    return;
  }
  const here = tileOf(me);
  const button = $('#bld-go button');
  button.disabled = true;
  try {
    await api(`/towns/${TOWN_ID}/members/me/move`, {
      method: 'POST',
      body: { building_id: openId, from_x: here.x, from_y: here.y, travel_minutes: minutes },
    });
    logFeed(`You head to ${nameOf(openId)} (${minutes} min).`);
  } catch (err) {
    logFeed(`Couldn't head there: ${err.message}`);
  } finally {
    button.disabled = false;
  }
};

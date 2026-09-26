// The building card: click a named building (its tag or the building itself) to see who's there now, who's on
// the way, and who went there earlier today. It floats above the building. Only your own house's card offers a
// rename; everyone sees the new name (townsync.js updates their labels). Real towns only.
import * as THREE from 'three';
import { api, getSupabase } from '../../frontend/shared/session.js';
import { activeCam } from './camera.js';
import { topOf } from './city.js';
import { $, logFeed } from './hud.js';
import { key, PLACES, pos, TOWN, TOWN_ID } from './layout.js';
import { friends } from './people.js';

const card = $('#building');
let openId = null, earlier = [], meId = null, liveTimer = null, historyTimer = null, anchor = null;

getSupabase().then((sb) => sb.auth.getSession()).then(({ data }) => { meId = data.session?.user.id ?? null; }).catch(() => {});

const isHouse = (id) => id.startsWith('house:');
const houseOwner = (id) => friends[id.slice(6)];
const nameOf = (id) => (isHouse(id) ? houseOwner(id)?.home?.name || 'A house' : PLACES[id]?.name || id);
const townTime = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' });

// People list: a colored dot, their name, and an optional note ("2:15 PM")
function fill(sel, rows, empty) {
  const ul = $(sel);
  ul.innerHTML = '';
  if (!rows.length) {
    ul.innerHTML = '<li class="none"></li>';
    ul.firstChild.textContent = empty;
    return;
  }
  for (const [f, note] of rows) {
    const li = document.createElement('li');
    li.innerHTML = '<span class="dot"></span><span class="who-name"></span><span class="note"></span>';
    li.querySelector('.dot').style.background = f.color;
    li.querySelector('.who-name').textContent = f.name;
    li.querySelector('.note').textContent = note;
    ul.append(li);
  }
}

function render() {
  if (!openId) return;
  const id = openId;
  const own = isHouse(id) && id === `house:${meId}`;
  $('#bld-kind').textContent = isHouse(id) ? (own ? 'Your house' : 'House') : 'Place';
  $('#bld-name').textContent = nameOf(id);
  $('#bld-rename').hidden = !own;
  // Now and on the way come from the characters as drawn: headed here (agents.target) and arrived or still walking
  const people = Object.values(friends);
  const here = people.filter((f) => f.destId === id && !f.path.length);
  const coming = people.filter((f) => f.destId === id && f.path.length);
  const now = new Set([...here, ...coming].map((f) => f.id));
  const before = earlier.filter((v) => friends[v.user_id] && !now.has(v.user_id));
  fill('#bld-here', here.map((f) => [f, '']), 'Nobody right now');
  fill('#bld-coming', coming.map((f) => [f, '']), 'Nobody heading here');
  fill('#bld-earlier', before.map((v) => [friends[v.user_id], townTime(v.at)]), 'Nobody else today');
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

// The card floats above its building: re-projected every frame so it follows panning and rotating, but it's a
// screen-space element, so zooming doesn't change its size.
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

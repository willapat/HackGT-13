// The weekly town paper, pinned to the notice board in the park (city.js) and the "This week's paper" button.
// GET /towns/{id}/paper: the week's dates, its busiest places, a summary, and townmates with something real in
// common, each with a way to meet. ‹ › step through earlier weeks. Real towns only.
import { api, getSupabase } from '../../frontend/shared/session.js';
import { BOARD } from './city.js';
import { focusFriend } from './camera.js';
import { $, addLabel, logFeed } from './hud.js';
import { inkOn, PLACES, TOWN, TOWN_ID } from './layout.js';
import { friends, tileOf } from './people.js';

const dialog = $('#paper');
let offset = 0, meId = null, seq = 0, tag = null;

const day = (iso) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d); };
function weekLabel(start, end) {
  const a = day(start), b = day(end);
  const md = { month: 'short', day: 'numeric' };
  return `${a.toLocaleDateString([], { weekday: 'short', ...md })} – ${b.toLocaleDateString([], { weekday: 'short', ...md })}, ${b.getFullYear()}`;
}

const el = (tag, className, text) => Object.assign(document.createElement(tag), className ? { className } : {}, text != null ? { textContent: text } : {});

function avatar(p) {
  const a = el('span', 'who-av', (p.name || '?').trim().slice(0, 1).toUpperCase());
  a.style.background = p.color || '#8a8f98';
  a.style.color = inkOn(p.color || '#8a8f98');
  a.setAttribute('aria-hidden', 'true');
  return a;
}

function openPlace(id) {
  dialog.close();
  dispatchEvent(new CustomEvent('town:building', { detail: id })); // buildings.js
}

async function headTo(id) {
  const me = friends[meId];
  if (!me) return;
  const here = tileOf(me);
  try {
    await api(`/towns/${TOWN_ID}/members/me/move`, { method: 'POST', body: { building_id: id, from_x: here.x, from_y: here.y } });
    logFeed(`You head to ${PLACES[id]?.name || id}.`);
    dialog.close();
  } catch (err) {
    logFeed(`Couldn't head there: ${err.message}`);
  }
}

function render(p) {
  $('#paper-dates').textContent = weekLabel(p.week_start, p.week_end);
  $('#paper-summary').textContent = p.summary;

  const hot = $('#paper-hot');
  hot.replaceChildren();
  const top = p.hot_places[0]?.visits || 1;
  for (const h of p.hot_places) {
    const li = el('li');
    const b = el('button', 'hot-row');
    b.type = 'button';
    b.onclick = () => openPlace(h.building_id);
    const bar = el('span', 'hot-bar');
    bar.style.setProperty('--w', `${Math.max(8, (h.visits / top) * 100)}%`);
    b.append(el('span', 'hot-name', h.name), el('span', 'hot-count', `${h.visits} visit${h.visits === 1 ? '' : 's'} · ${h.people} ${h.people === 1 ? 'person' : 'people'}`), bar);
    li.append(b);
    hot.append(li);
  }
  $('#paper-hot-empty').hidden = p.hot_places.length > 0;

  const heads = $('#paper-headlines');
  heads.replaceChildren(...p.headlines.slice(0, 4).map((t) => el('li', '', t)));
  heads.hidden = !p.headlines.length;

  const ins = $('#paper-insights');
  ins.replaceChildren();
  for (const i of p.insights) {
    const li = el('li', 'insight');
    const faces = el('div', 'faces');
    faces.append(...i.people.map(avatar));
    const body = el('div', 'insight-body');
    body.append(el('p', 'insight-text', i.text), el('p', 'insight-idea', i.suggestion));
    const actions = el('div', 'insight-actions');
    const mine = i.people.some((x) => x.user_id === meId);
    if (i.building_id && mine && friends[meId]) {
      const go = el('button', 'primary', `Head to ${PLACES[i.building_id]?.name || 'there'}`);
      go.type = 'button';
      go.onclick = () => headTo(i.building_id);
      actions.append(go);
    }
    const other = i.people.find((x) => x.user_id !== meId && friends[x.user_id]);
    if (i.building_id) {
      const see = el('button', '', 'See the place');
      see.type = 'button';
      see.onclick = () => openPlace(i.building_id);
      actions.append(see);
    } else if (other) {
      const see = el('button', '', `Find ${other.name}`);
      see.type = 'button';
      see.onclick = () => { dialog.close(); focusFriend(other.user_id); };
      actions.append(see);
    }
    body.append(actions);
    li.append(faces, body);
    ins.append(li);
  }
  $('#paper-insights-empty').hidden = p.insights.length > 0;
}

async function load() {
  const mine = ++seq;
  $('#paper-prev').disabled = offset <= -8;
  $('#paper-next').disabled = offset >= 0;
  $('#paper-status').hidden = false;
  $('#paper-status').textContent = 'Printing the paper…';
  $('#paper-content').hidden = true;
  try {
    const p = await api(`/towns/${TOWN_ID}/paper?offset=${offset}`);
    if (mine !== seq) return;
    render(p);
    $('#paper-status').hidden = true;
    $('#paper-content').hidden = false;
  } catch (e) {
    if (mine === seq) $('#paper-status').textContent = `Couldn't print the paper: ${e.message}`;
  }
}

// "Read this week" is kept per town on this device: Monday's date of the week you last opened it
const weekKey = () => {
  const d = new Date();
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.toDateString();
};
const readThisWeek = () => { try { return localStorage.getItem(`paper-read:${TOWN_ID}`) === weekKey(); } catch { return false; } };
function markRead() {
  try { localStorage.setItem(`paper-read:${TOWN_ID}`, weekKey()); } catch { /* storage blocked: glows again next visit */ }
  tag?.classList.remove('unread');
}

function open() {
  if (!TOWN_ID) return;
  markRead();
  offset = 0;
  if (!dialog.open) dialog.showModal();
  load();
}

export function startPaper() {
  if (!TOWN_ID) return;
  getSupabase().then((sb) => sb.auth.getSession()).then(({ data }) => { meId = data.session?.user.id ?? null; }).catch(() => {});
  $('#paper-title').textContent = `The ${TOWN?.town.name || 'Town'} Weekly`;
  $('#paper-open').hidden = false;
  $('#paper-open').onclick = open;
  $('#paper-close').onclick = () => dialog.close();
  $('#paper-prev').onclick = () => { offset -= 1; load(); };
  $('#paper-next').onclick = () => { offset += 1; load(); };
  dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); }); // click outside the page
  addEventListener('town:paper', open);
  if (!BOARD.at) return;
  tag = addLabel('lbl place board', '📰 Paper', () => BOARD.at).el;
  tag.title = "This week's town paper";
  tag.onclick = open;
  tag.classList.toggle('unread', !readThisWeek());
}

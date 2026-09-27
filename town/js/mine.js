// Your own spot in a real town: a bubble over your character, a mood on your house, and mailboxes.
// Bubble and mood are saved for everyone (PUT /towns/{id}/members/me/bubble|mood; townsync.js draws other people's).
// Clicking a townmate's mailbox leaves them a note; yours lists what people left you (backend/routes/mailbox.py).
import * as THREE from 'three';
import { api, getSupabase } from '../../frontend/shared/session.js';
import { activeCam, focusOn } from './camera.js';
import { HOUSE_MOODS, setHouseMood } from './effects.js';
import { $, addLabel, logFeed } from './hud.js';
import { inkOn, pos, TOWN, TOWN_ID } from './layout.js';
import { friends, setPinned } from './people.js';
import { OPEN_ZOOM } from './stage.js';

const QUICK = ['👋', '😂', '🎉', '☕', '❤️', '😴'];
const MAIL_POLL_MS = 20000;
let meId = null, mailOwner = null, anchor = null, unread = 0, flag = null;

const me = () => friends[meId];
const ago = (iso) => {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`;
};
const el = (tag, cls, text) => Object.assign(document.createElement(tag), cls ? { className: cls } : {}, text != null ? { textContent: text } : {});

// ---- Bubble ----

async function setBubble(text) {
  const f = me();
  try {
    if (text) await api(`/towns/${TOWN_ID}/members/me/bubble`, { method: 'PUT', body: { text } });
    else await api(`/towns/${TOWN_ID}/members/me/bubble`, { method: 'DELETE' });
    setPinned(f, text || null);
    $('#say-text').value = '';
    $('#say-clear').hidden = !text;
  } catch (e) {
    logFeed(`Couldn't ${text ? 'post' : 'clear'} your bubble: ${e.message}`);
  }
}

// ---- House mood ----

function renderMoodButton(kind) {
  const m = HOUSE_MOODS[kind];
  $('#mood-now').textContent = m ? `${m.emoji} ${m.label}` : 'Mood';
}

async function setMood(kind) {
  $('#moods').hidden = true;
  try {
    if (kind) await api(`/towns/${TOWN_ID}/members/me/mood`, { method: 'PUT', body: { mood: kind } });
    else await api(`/towns/${TOWN_ID}/members/me/mood`, { method: 'DELETE' });
    setHouseMood(me(), kind);
    renderMoodButton(kind);
    if (kind) focusOn(pos(...me().home.house)); // show them what it looks like
  } catch (e) {
    logFeed(`Couldn't set your mood: ${e.message}`);
  }
}

function buildMoodMenu() {
  const menu = $('#moods');
  for (const [kind, m] of Object.entries(HOUSE_MOODS)) {
    const b = el('button', 'mood', null);
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    b.append(el('span', 'emoji', m.emoji), el('span', null, m.label));
    b.onclick = () => setMood(kind);
    menu.append(b);
  }
  const clear = el('button', 'mood clear', 'No mood');
  clear.type = 'button';
  clear.onclick = () => setMood(null);
  menu.append(clear);
}

// ---- Mailboxes ----

function renderUnread() {
  const n = $('#mail-count');
  n.hidden = !unread;
  n.textContent = unread;
  const f = me();
  if (!f?.mailboxAt) return;
  if (unread && !flag) flag = addLabel('lbl mailflag', '', () => f.mailboxAt);
  if (!unread && flag) { flag.remove(); flag = null; }
  if (flag) {
    flag.el.textContent = `📬 ${unread}`;
    flag.el.onclick = () => openMailbox(meId);
  }
}

async function pollUnread() {
  try {
    const box = await api(`/towns/${TOWN_ID}/mailbox`);
    unread = box.unread;
    renderUnread();
    if (mailOwner === meId) renderInbox(box.messages);
  } catch { /* before migration 000019 there is no mailbox; stay quiet */ }
}

function renderInbox(messages) {
  $('#mail-meta').textContent = messages.length ? `${messages.length} note${messages.length === 1 ? '' : 's'} from your townmates` : 'Empty for now. Townmates can leave you notes here.';
  $('#mail-list').replaceChildren(...messages.map((m) => {
    const li = el('li', m.read ? '' : 'new');
    const av = el('span', 'who-av', (m.from.name || '?').trim().slice(0, 1).toUpperCase());
    const color = m.from.color || '#667085';
    av.style.background = color;
    av.style.color = inkOn(color);
    const body = el('div', 'mail-body');
    const head = el('div', 'mail-from');
    head.append(el('b', null, m.from.name), el('span', 'when', ` · ${ago(m.created_at)}`));
    body.append(head, el('div', 'mail-text', m.text));
    const acts = el('div', 'mail-acts');
    if (m.from.in_town && friends[m.from.id]) {
      const reply = el('button', null, 'Reply');
      reply.type = 'button';
      reply.onclick = () => openMailbox(m.from.id);
      acts.append(reply);
    }
    const del = el('button', null, 'Delete');
    del.type = 'button';
    del.onclick = async () => {
      del.disabled = true;
      try {
        await api(`/towns/${TOWN_ID}/mailbox/${m.id}`, { method: 'DELETE' });
        li.remove();
      } catch (e) { logFeed(`Couldn't delete that note: ${e.message}`); del.disabled = false; }
    };
    acts.append(del);
    body.append(acts);
    li.append(av, body);
    return li;
  }));
}

async function openMailbox(ownerId) {
  const f = friends[ownerId];
  if (!f) return;
  if (!TOWN) { logFeed('Mailboxes work in your real towns.'); return; }
  dispatchEvent(new CustomEvent('town:mail-open')); // the place card closes (buildings.js)
  mailOwner = ownerId;
  anchor = f.mailboxAt;
  const card = $('#mail');
  const own = ownerId === meId;
  $('#mail-title').textContent = own ? 'Your mailbox' : `${f.name}'s mailbox`;
  $('#mail-send').hidden = own;
  $('#mail-list').replaceChildren();
  if (!own) {
    $('#mail-meta').textContent = `Leave ${f.name} a note. They'll find it here and in their Inbox.`;
    $('#mail-text').value = '';
    $('#mail-left').textContent = '500';
  }
  const wasHidden = card.hidden;
  card.hidden = false;
  if (wasHidden) requestAnimationFrame(follow);
  if (!own) { $('#mail-text').focus(); return; }
  $('#mail-meta').textContent = 'Opening…';
  try {
    const box = await api(`/towns/${TOWN_ID}/mailbox`);
    if (mailOwner !== ownerId) return;
    renderInbox(box.messages);
    if (box.unread) {
      await api(`/towns/${TOWN_ID}/mailbox/read`, { method: 'POST' });
      unread = 0;
      renderUnread();
    }
  } catch (e) {
    $('#mail-meta').textContent = `Couldn't open your mailbox: ${e.message}`;
  }
}

function closeMailbox() {
  mailOwner = null;
  $('#mail').hidden = true;
}

// The card floats over the mailbox, like the place card over its building
const screen = new THREE.Vector3();
function follow() {
  const card = $('#mail');
  if (card.hidden || !anchor) return;
  screen.copy(anchor).project(activeCam);
  card.style.visibility = screen.z > 1 ? 'hidden' : '';
  card.style.left = `${(screen.x * 0.5 + 0.5) * innerWidth}px`;
  card.style.top = `${(-screen.y * 0.5 + 0.5) * innerHeight}px`;
  const scale = Math.min(1, (activeCam.isOrthographicCamera ? activeCam.zoom : OPEN_ZOOM) / OPEN_ZOOM);
  card.style.transform = `translate(-50%, calc(-100% - 14px)) scale(${Math.max(0.75, scale)})`;
  requestAnimationFrame(follow);
}

$('#mail-close').onclick = closeMailbox;
addEventListener('pointerdown', (e) => { if (!e.target.closest('#moods, #mood-open')) $('#moods').hidden = true; });
addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeMailbox(); $('#moods').hidden = true; } });
addEventListener('town:mailbox', (e) => openMailbox(e.detail));
addEventListener('town:building', closeMailbox);
$('#mail-text').oninput = () => { $('#mail-left').textContent = 500 - $('#mail-text').value.length; };
$('#mail-send').onsubmit = async (e) => {
  e.preventDefault();
  const text = $('#mail-text').value.trim();
  const to = mailOwner;
  if (!text || !to) return;
  const button = $('#mail-send button');
  button.disabled = true;
  try {
    await api(`/towns/${TOWN_ID}/mailbox`, { method: 'POST', body: { to_user_id: to, text } });
    logFeed(`📬 Note left for ${friends[to]?.name ?? 'them'}.`);
    closeMailbox();
  } catch (err) {
    logFeed(`Couldn't leave your note: ${err.message}`);
  } finally {
    button.disabled = false;
  }
};

// ---- Boot (real towns, once the residents exist) ----

export async function startMine() {
  try {
    const sb = await getSupabase();
    meId = (await sb.auth.getSession()).data.session?.user.id ?? null;
  } catch { return; }
  const f = me();
  if (!f) return; // no house here yet: nothing of yours to decorate
  const mine = TOWN.members.find((m) => m.user_id === meId);
  const live = (x) => (x && Date.parse(x.until) > Date.now() ? x : null);
  renderMoodButton(live(mine?.home?.mood)?.kind);
  $('#say-clear').hidden = !live(mine?.bubble);
  for (const q of QUICK) {
    const b = el('button', 'quick-emoji', q);
    b.type = 'button';
    b.title = `Show ${q}`;
    b.onclick = () => setBubble(q);
    $('#say-quick').append(b);
  }
  $('#say').onsubmit = (e) => { e.preventDefault(); const t = $('#say-text').value.trim(); if (t) setBubble(t); };
  $('#say-clear').onclick = () => setBubble(null);
  buildMoodMenu();
  $('#mood-open').onclick = () => { $('#moods').hidden = !$('#moods').hidden; };
  $('#mail-open').onclick = () => { focusOn(f.mailboxAt); openMailbox(meId); };
  $('#me').hidden = false;
  pollUnread();
  setInterval(() => { if (!document.hidden) pollUnread(); }, MAIL_POLL_MS);
}

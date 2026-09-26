// Entry app: sign in / create account → pick a username (first time) → home (friends + towns),
// plus the account menu, settings (#/settings/<pane>) and help (#/help). Routes live in the URL hash
// so the back button and links work.
import { api, getSupabase } from '../shared/session.js';
import { confirmDialog, getTheme, setTheme, toast } from './ui.js';
import * as Colors from '../shared/colors.js';
import { createWheel } from './wheel.js';
import { skyline, tierFor } from './skyline.js';
import { drawTown } from './townart.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const USERNAME_RE = /^[a-z0-9_]{3,20}$/;
const VIEWS = ['loading', 'error', 'auth', 'username', 'home', 'friends', 'inbox', 'profile', 'person', 'settings', 'help'];
const SIGNED_IN_VIEWS = new Set(['home', 'friends', 'inbox', 'profile', 'person', 'settings', 'help']);
const PANES = ['profile', 'character', 'towns', 'account', 'appearance', 'privacy'];

let sb = null;
let me = null; // current profile row
let myTowns = []; // GET /me towns: [{house_x, house_y, joined_at, name, color, towns: {id, name, invite_code, created_by}}]
let pollTimer = null;

function show(view) {
  for (const v of VIEWS) $(`#view-${v}`).hidden = v !== view;
  const signedIn = SIGNED_IN_VIEWS.has(view);
  $('#appbar').hidden = !signedIn;
  $('#brand').hidden = signedIn;
  $('#shell').classList.toggle('wide', view === 'settings');
  $('#shell').classList.toggle('home', view === 'home');
  $('#shell').classList.toggle('feed', ['friends', 'inbox', 'profile', 'person', 'help'].includes(view));
  for (const a of $$('.navtabs a')) {
    if (a.dataset.view === view) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
  clearInterval(pollTimer);
  if (signedIn) pollTimer = setInterval(() => { if (!document.hidden) refreshAll(); }, 20000);
  if (view !== 'settings' || currentPane !== 'character') character.stop();
}

function message(el, text, kind = 'error') {
  el.hidden = !text;
  el.textContent = text || '';
  el.className = `msg ${kind}`;
}

function busy(button, on, label) {
  button.disabled = on;
  if (label) button.textContent = label;
}

const initials = (name) => (name || '?').trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
const hashColor = (id = '') => `hsl(${[...id].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 360, 0)} 55% 42%)`;
const colorOf = (p) => hashColor(p?.id);
const inkOn = (css) => {
  const m = /^#([0-9a-f]{6})$/i.exec(css);
  if (!m) return '#fff';
  const n = parseInt(m[1], 16), lum = ((n >> 16) * 0.3 + ((n >> 8) & 255) * 0.59 + (n & 255) * 0.11) / 255;
  return lum > 0.6 ? '#1f2430' : '#fff';
};
function paintAvatar(el, p, name = p?.display_name) {
  el.textContent = initials(name);
  el.style.background = colorOf(p);
  el.style.color = inkOn(colorOf(p));
  showPhoto(el, p?.avatar?.photo);
}

// A profile photo covers the initials (they stay in the DOM for screen readers)
function showPhoto(el, url) {
  el.classList.toggle('has-photo', Boolean(url));
  el.style.backgroundImage = url ? `url("${encodeURI(url)}")` : '';
}

// Anything marked data-person="<user id>" opens that person's profile. Runs in the capture phase so a tap on
// someone's face inside a bigger control (a town card) opens them instead; other buttons inside a person row
// (Visit, Accept) keep doing their own thing.
document.addEventListener('click', (e) => {
  const target = e.target.closest('[data-person]');
  if (!target || !me) return;
  const control = e.target.closest('button, a, input');
  if (control && control !== target && target.contains(control)) return;
  e.preventDefault();
  e.stopPropagation();
  openPerson(target.dataset.person);
}, true);

// "Say hi": walk your character to their house in the town you share, then open the town to watch.
// It's an in-town gesture only; nothing is sent to them outside the town.
async function sayHi(p) {
  try {
    const snap = await api(`/towns/${p.town.id}`);
    const mine = snap.agents.find((a) => a.user_id === me.id) || {};
    await api(`/towns/${p.town.id}/members/me/move`, { method: 'POST', body: { building_id: `house:${p.user_id}`, from_x: mine.x ?? 0, from_y: mine.y ?? 0 } });
    toast(`Heading to ${p.name}'s house 👋`);
  } catch (err) {
    toast(err.status === 409 ? `${p.name} hasn't placed a house yet. Opening the town.` : err.message, err.status === 409 ? '' : 'error');
  }
  setTimeout(() => enterTown(p.town.id), 700);
}

function openPerson(id) {
  location.hash = id === me.id ? '#/profile' : `#/u/${id}`;
}

// Buttons and menu items with data-go="#/somewhere" navigate there
document.addEventListener('click', (e) => {
  const go = e.target.closest('[data-go]');
  if (go) location.hash = go.dataset.go;
});

// ---- Boot ----------------------------------------------------------------------------------

async function boot() {
  show('loading');
  try {
    sb = await getSupabase();
  } catch (e) {
    $('#error-text').textContent = e.message;
    return show('error');
  }
  sb.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') {
      me = null;
      clearDirty();
      history.replaceState(null, '', location.pathname);
      showAuth();
    }
  });
  const { data: { session } } = await sb.auth.getSession();
  if (session) await afterSignIn();
  else showAuth();
}

$('#retry').onclick = boot;

// After any successful sign in: new users pick a username, everyone else goes where the URL says
async function afterSignIn() {
  show('loading');
  try {
    ({ profile: me, towns: myTowns } = await api('/me'));
  } catch (e) {
    if (e.status === 401) { await sb.auth.signOut(); return; }
    $('#error-text').textContent = e.message;
    return show('error');
  }
  if (!me.username) return showUsername();
  renderIdentity();
  route();
}

const signOut = async (scope = 'local') => {
  const { error } = await sb.auth.signOut({ scope });
  if (error) toast(error.message, 'error');
};

// ---- Routing ---------------------------------------------------------------------------------

let currentPane = null;
let lastHash = location.hash;
let skipNextRoute = false;

function parseHash() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (parts[0] === 'settings') return { view: 'settings', pane: PANES.includes(parts[1]) ? parts[1] : 'profile' };
  if (parts[0] === 'u' && parts[1]) return { view: 'person', id: parts[1] };
  if (['help', 'friends', 'inbox', 'profile'].includes(parts[0])) return { view: parts[0] };
  return { view: 'home' };
}

addEventListener('hashchange', async () => {
  if (skipNextRoute) { skipNextRoute = false; return; }
  if (!me?.username) return;
  const leaving = currentPane && (parseHash().view !== 'settings' || parseHash().pane !== currentPane);
  if (leaving && dirty.has(currentPane)) {
    const target = location.hash;
    skipNextRoute = true;
    location.hash = lastHash; // stay put while asking
    const discard = await confirmDialog({ title: 'Discard changes?', body: "You have changes that aren't saved yet.", confirmLabel: 'Discard', danger: true });
    if (!discard) return;
    resetPane(currentPane);
    location.hash = target;
    return;
  }
  route();
});

addEventListener('beforeunload', (e) => { if (dirty.size) { e.preventDefault(); e.returnValue = ''; } });

function route() {
  lastHash = location.hash;
  const { view, pane, id } = parseHash();
  closeMenu();
  if (view === 'settings') return showSettings(pane);
  currentPane = null;
  if (view === 'help') { show('help'); return scrollTo(0, 0); }
  if (view === 'friends') return showFriends();
  if (view === 'inbox') return showInbox();
  if (view === 'profile') return showProfile();
  if (view === 'person') return showPerson(id);
  showFeed();
}

// ---- Account menu ------------------------------------------------------------------------------

function renderIdentity() {
  paintAvatar($('#bar-avatar'), me);
  paintAvatar($('#menu-avatar'), me);
  $('#menu-name').textContent = me.display_name;
  $('#menu-handle').textContent = `@${me.username}`;
  renderMyStatus();
}

function openMenu() {
  $('#account-menu').hidden = false;
  $('#account-btn').setAttribute('aria-expanded', 'true');
  $('#account-menu [role="menuitem"]').focus();
}
function closeMenu() {
  $('#account-menu').hidden = true;
  $('#account-btn').setAttribute('aria-expanded', 'false');
}
$('#account-btn').onclick = (e) => {
  e.stopPropagation();
  if ($('#account-menu').hidden) openMenu(); else closeMenu();
};
$('#account-menu').onclick = (e) => { if (e.target.closest('[role="menuitem"]')) closeMenu(); };
document.addEventListener('click', (e) => { if (!e.target.closest('.menu-wrap')) closeMenu(); });
$('#account-menu').onkeydown = (e) => {
  const items = $$('#account-menu [role="menuitem"]');
  const i = items.indexOf(document.activeElement);
  if (e.key === 'Escape') { closeMenu(); $('#account-btn').focus(); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
};
$('#menu-sign-out').onclick = () => signOut();

// ---- Sign in / create account -------------------------------------------------------------

let mode = 'signin';

function setMode(next) {
  mode = next;
  $('#tab-signin').setAttribute('aria-selected', String(mode === 'signin'));
  $('#tab-signup').setAttribute('aria-selected', String(mode === 'signup'));
  $('#name-field').hidden = mode !== 'signup';
  $('#auth-submit').textContent = mode === 'signin' ? 'Sign in' : 'Create account';
  $('#auth-password').autocomplete = mode === 'signin' ? 'current-password' : 'new-password';
  message($('#auth-msg'), '');
}

function showAuth() {
  setMode(mode);
  show('auth');
}

$('#tab-signin').onclick = () => setMode('signin');
$('#tab-signup').onclick = () => setMode('signup');

$('#auth-form').onsubmit = async (e) => {
  e.preventDefault();
  const email = $('#auth-email').value.trim();
  const password = $('#auth-password').value;
  const name = $('#auth-name').value.trim();
  const msg = $('#auth-msg');
  if (!email || !password) return message(msg, 'Enter your email and password.');
  if (mode === 'signup' && !name) return message(msg, 'Enter your name.');
  if (mode === 'signup' && password.length < 6) return message(msg, 'Password must be at least 6 characters.');

  const btn = $('#auth-submit');
  busy(btn, true, mode === 'signin' ? 'Signing in…' : 'Creating account…');
  try {
    if (mode === 'signin') {
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw error;
      await afterSignIn();
    } else {
      // The database copies `name` into the new profile's display_name
      const { data, error } = await sb.auth.signUp({ email, password, options: { data: { name } } });
      if (error) throw error;
      if (data.session) await afterSignIn();
      else {
        setMode('signin');
        message(msg, 'Check your email to confirm your account, then sign in here.', 'info');
      }
    }
  } catch (err) {
    message(msg, err.message || 'Something went wrong. Try again.');
  } finally {
    busy(btn, false, mode === 'signin' ? 'Sign in' : 'Create account');
  }
};

// ---- Pick a username ------------------------------------------------------------------------

function showUsername() {
  $('#profile-name').value = me.display_name || '';
  $('#username-input').value = '';
  checkUsername();
  message($('#username-msg'), '');
  show('username');
  $('#username-input').focus();
}

// Lowercases the field as you type and describes what's wrong with it, if anything
function usernameHint(input, hint, current = '') {
  const value = input.value.trim().toLowerCase();
  if (input.value !== value) input.value = value; // usernames are lowercase
  const ok = USERNAME_RE.test(value);
  hint.className = `hint ${value && value !== current ? (ok ? 'ok' : 'bad') : ''}`;
  hint.textContent = !value ? '3–20 characters: lowercase letters, numbers, underscores'
    : value === current ? 'Your current username'
    : ok ? `Friends will find you as @${value}`
    : value.length < 3 ? 'At least 3 characters'
    : 'Only lowercase letters, numbers, and underscores';
  return ok;
}

function checkUsername() {
  const ok = usernameHint($('#username-input'), $('#username-hint'));
  $('#username-submit').disabled = !ok || !$('#profile-name').value.trim();
}

$('#username-input').oninput = checkUsername;
$('#profile-name').oninput = checkUsername;

$('#username-form').onsubmit = async (e) => {
  e.preventDefault();
  const username = $('#username-input').value.trim().toLowerCase();
  const display_name = $('#profile-name').value.trim();
  if (!USERNAME_RE.test(username) || !display_name) return;
  const btn = $('#username-submit');
  busy(btn, true, 'Saving…');
  try {
    me = await api('/me', { method: 'PATCH', body: { username, display_name } });
    renderIdentity();
    route();
  } catch (err) {
    message($('#username-msg'), err.status === 409 ? `@${username} is taken. Try another.` : err.message);
  } finally {
    busy(btn, false, 'Continue');
  }
};

// ---- Signed-in tabs: feed, friends, inbox, profile ----------------------------------------------
// One refresh loads everything the tabs show (feed, friends, requests, invites) so the Inbox badge
// is right wherever you are. It reruns every 20s while a tab is visible and after anything you do.

let feed = { towns: [], items: [], today: [], inbox: [] };
let requests = { incoming: [], outgoing: [] };
let invites = [];
let allFriends = [];
let stats = null; // GET /me/stats: highlights, closest people, who to catch up with

function renderChips(el, items) {
  el.innerHTML = '';
  for (const text of items) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = text;
    el.append(chip);
  }
}

async function refreshAll() {
  const [f, fr, rq, inv, st] = await Promise.allSettled([api('/me/feed'), api('/friends'), api('/friends/requests'), api('/me/invites'), api('/me/stats')]);
  if (f.status === 'fulfilled') feed = f.value;
  if (st.status === 'fulfilled') stats = st.value;
  if (fr.status === 'fulfilled') allFriends = fr.value;
  if (rq.status === 'fulfilled') requests = rq.value;
  if (inv.status === 'fulfilled') invites = inv.value;
  renderFeed();
  renderFriends();
  renderInbox();
  renderProfile();
}

const townsIn = () => myTowns.filter((t) => t.towns);
const enterTown = (id) => { location.href = `../town/?town=${encodeURIComponent(id)}`; };
// How many people live in a town, from the feed summary (1 until it has loaded)
const townSize = (id) => feed.towns.find((t) => t.id === id)?.residents.length || 1;

// The round town avatar: its skyline (suburb → town → city) over the town's color
function townIcon(t, cls = 'avatar sm') {
  const a = el('div', `${cls} town-icon ${hueOf(t.id)}`);
  a.innerHTML = skyline(t.id, townSize(t.id), 'icon');
  a.title = `${t.name} · ${tierFor(townSize(t.id)).label}`;
  return a;
}

const hueOf = (id = '') => `hue-${([...id].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 997, 0) % 4) + 1}`;
const el = (tag, cls, text) => Object.assign(document.createElement(tag), cls ? { className: cls } : {}, text != null ? { textContent: text } : {});

// A town member's avatar: initials on the color they picked in that town
function personAvatar(p, cls = 'avatar sm') {
  const a = el('div', cls, initials(p?.name));
  ring(a, p?.status);
  if (p?.user_id) a.dataset.person = p.user_id;
  const bg = p?.color || hashColor(p?.user_id);
  a.style.background = bg;
  a.style.color = inkOn(bg);
  showPhoto(a, p?.photo);
  return a;
}

function timeAgo(iso) {
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d`;
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
}
const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const names = (people) => people.map((p) => p.name).join(', ');
const crossedPaths = (days) => days == null ? "You haven't crossed paths yet"
  : days === 0 ? 'Crossed paths today' : days === 1 ? 'Crossed paths yesterday' : `Last crossed paths ${days} days ago`;

// ---- Free / busy status ----
// One tap: you're free (or busy) for the next few hours. A ring around your avatar drains as the time runs
// out, then it's gone, like a story. Friends and townmates see the ring everywhere.

const STATUS_HOURS = 3;
const STATUS_LABEL = { free: 'Free', busy: 'Busy' };
const myStatus = () => (me?.status && me.status_until && new Date(me.status_until) > new Date() ? { status: me.status, until: me.status_until } : null);
const statusLeft = (until) => Math.max(0, Math.min(1, (new Date(until) - Date.now()) / (STATUS_HOURS * 3600e3)));

function timeLeft(until) {
  const mins = Math.max(1, Math.ceil((new Date(until) - Date.now()) / 60e3));
  return mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m left` : `${mins}m left`;
}

// Ring an avatar for a status (or clear it); --left drives how much of the ring is still drawn
function ring(elm, st) {
  elm.classList.remove('st-free', 'st-busy');
  if (!st) return;
  elm.classList.add(`st-${st.status}`);
  elm.style.setProperty('--left', statusLeft(st.until).toFixed(3));
}

function renderMyStatus() {
  const st = myStatus();
  for (const id of ['#bar-avatar', '#menu-avatar', '#composer-avatar', '#me-avatar']) ring($(id), st);
  for (const box of $$('.status-control')) {
    box.replaceChildren();
    if (st) {
      const on = el('span', `status-on ${st.status}`, `${STATUS_LABEL[st.status]} · ${timeLeft(st.until)}`);
      const end = el('button', 'link small', 'End');
      end.type = 'button';
      end.onclick = () => setStatus(null);
      box.append(on, end);
    } else {
      box.append(el('span', 'status-ask', 'Up for plans?'));
      for (const [status, label] of [['free', 'Free'], ['busy', 'Busy']]) {
        const b = el('button', `status-tap ${status}`, label);
        b.type = 'button';
        b.title = `${label} for the next ${STATUS_HOURS} hours`;
        b.onclick = () => setStatus(status);
        box.append(b);
      }
      box.append(el('span', 'status-ask', `${STATUS_HOURS}h`));
    }
  }
}

async function setStatus(status) {
  const body = status ? { status, until: new Date(Date.now() + STATUS_HOURS * 3600e3).toISOString() } : { status: null };
  try {
    const row = await api('/me/status', { method: 'PUT', body });
    me = { ...me, status: row.status, status_until: row.status_until };
    renderMyStatus();
    toast(status === 'free' ? `You're free for ${STATUS_HOURS} hours. Friends see a green ring.`
      : status === 'busy' ? `Busy for ${STATUS_HOURS} hours. No pressure on plans.` : 'Status ended.');
    refreshAll();
  } catch (err) { toast(err.message, 'error'); }
}

// Keep the countdown and the draining ring current
setInterval(() => { if (me && !document.hidden) renderMyStatus(); }, 30e3);

// A townmate row (closest people, catch up): avatar, name, a line under it, and a Visit button into their town
function mateRow(p, line) {
  const li = el('li');
  const who = el('div', 'who');
  who.append(el('div', 'name', p.name), el('div', 'handle', line));
  const visit = el('button', 'small tonal', 'Visit');
  visit.type = 'button';
  visit.onclick = () => enterTown(p.town.id);
  li.append(personAvatar(p), who, visit);
  li.dataset.person = p.user_id;
  return li;
}

function inboxCount() {
  return feed.inbox.length + invites.length + requests.incoming.length;
}

function renderBadges() {
  const n = inboxCount();
  const badge = $('#nav-inbox-badge');
  badge.hidden = !n;
  badge.textContent = n > 9 ? '9+' : n;
  $('#rail-inbox').hidden = !n;
  $('#rail-inbox-title').textContent = n === 1 ? '1 thing waiting on you' : `${n} things waiting on you`;
}

// ---- Feed ----

function showFeed() {
  paintAvatar($('#composer-avatar'), me);
  renderMyStatus();
  $('#composer-open').textContent = `What's new, ${(me.display_name || '').split(' ')[0] || 'friend'}?`;
  renderFeed();
  show('home');
  refreshAll();
}

function renderFeed() {
  if (!me) return;
  // Town cards: from the feed summary when it has loaded, else just names from /me
  const summaries = feed.towns.length ? feed.towns : townsIn().map((m) => ({ id: m.towns.id, name: m.towns.name, residents: [], headline: null, new: 0 }));
  const strip = $('#town-cards'), scrolled = strip.scrollLeft;
  strip.replaceChildren(...summaries.map(townCard));
  strip.scrollLeft = scrolled;
  $('#no-towns').hidden = summaries.length > 0;
  $('#town-cards').hidden = !summaries.length;

  $('#feed').replaceChildren(...feed.items.map(post));
  $('#feed-empty').hidden = feed.items.length > 0;

  $('#today').replaceChildren(...feed.today.map((t) => {
    const li = el('li');
    li.append(el('time', '', clock(t.start_at)));
    const body = el('div');
    body.append(el('div', 'what', t.title || 'Busy'));
    const sub = el('div', 'who-where');
    for (const p of t.people.slice(0, 1)) {
      const dot = el('span', 'dot');
      dot.style.background = p.color || hashColor(p.user_id);
      sub.append(dot);
    }
    sub.append(`${names(t.people) || 'Someone'} · ${t.town.name}`);
    body.append(sub);
    li.append(body);
    li.onclick = () => enterTown(t.town.id);
    li.style.cursor = 'pointer';
    return li;
  }));
  $('#no-today').hidden = feed.today.length > 0;
  const free = feed.free_now || [];
  $('#free-now').replaceChildren(...free.map((p) => mateRow(p, `Free · ${timeLeft(p.status.until)} · ${p.town.name}`)));
  $('#free-section').hidden = !free.length;
  const catchUp = stats?.reconnect || [];
  $('#reconnect').replaceChildren(...catchUp.map((p) => {
    const li = el('li');
    const who = el('div', 'who');
    who.append(el('div', 'name', p.name), el('div', 'handle', p.town.name));
    let side;
    if (p.days_since == null) { // never crossed paths: a nudge instead of a number
      side = el('button', 'small tonal', 'Say hi 👋');
      side.type = 'button';
      side.title = `Walk your character to ${p.name}'s house in ${p.town.name}`;
      side.onclick = () => sayHi(p);
    } else {
      side = el('div', 'days');
      side.title = crossedPaths(p.days_since);
      side.append(el('b', '', String(p.days_since)), el('span', '', p.days_since === 1 ? 'day' : 'days'));
    }
    li.append(personAvatar(p), who, side);
    li.dataset.person = p.user_id;
    return li;
  }));
  $('#reconnect-section').hidden = !catchUp.length;
  renderBadges();
}

function townCard(t) {
  const b = el('button', 'town-card');
  b.type = 'button';
  const banner = el('div', `banner ${hueOf(t.id)}`);
  // The real town from its tiles when we have them; a generic skyline otherwise
  if (t.layout?.tiles?.length) {
    banner.classList.add('real');
    banner.style.backgroundImage = `url(${drawTown(t.layout)}), var(--sky)`;
  } else banner.innerHTML = skyline(t.id, t.residents.length || 1, 'banner');
  banner.append(el('b', '', t.name));
  if (t.new) banner.append(el('span', 'new', `${t.new} new`));
  const body = el('div', 'body');
  const stack = el('div', 'stack');
  for (const p of t.residents.slice(0, 5)) stack.append(personAvatar(p, 'avatar'));
  if (t.residents.length > 5) stack.append(el('div', 'avatar more', `+${t.residents.length - 5}`));
  const size = t.residents.length;
  const row = el('div', 'size-row');
  row.append(stack, el('span', 'tier', size ? `${tierFor(size).label} · ${size}` : tierFor(1).label));
  body.append(row, el('div', 'headline', t.headline || (size ? `${size} ${size === 1 ? 'resident' : 'residents'}` : 'Tap to look around')));
  const enter = el('div', 'enter');
  enter.append('Enter town', el('span', '', '→'));
  body.append(enter);
  b.append(banner, body);
  b.onclick = () => enterTown(t.id);
  return b;
}

const ACTION_TAGS = { chat: '💬', visit: '👋', knock: '🚪', leave_gift: '🎁', propose_event: '📅' };

function post(item) {
  const card = el('article', 'card post');
  const head = el('div', 'post-head');
  const icon = el('div', 'kind-icon');
  if (item.kind === 'news' || item.kind === 'plan') {
    const art = el('div', `news-art ${hueOf(item.town.id)}`, item.kind === 'news' ? '📣' : '📅');
    icon.append(art);
  } else {
    icon.append(personAvatar(item.actor), el('span', 'tag', ACTION_TAGS[item.action] || '✨'));
  }
  const who = el('div', 'who');
  who.append(el('div', 'title', item.title || ''));
  const meta = el('div', 'meta');
  const town = el('a', '', item.town.name);
  town.href = `../town/?town=${encodeURIComponent(item.town.id)}`;
  meta.append(town, ' · ', el('span', '', item.at ? timeAgo(item.at) : ''));
  who.append(meta);
  head.append(icon, who);
  card.append(head);
  if (item.text) card.append(el('p', 'text', item.text));
  if (item.kind === 'plan' && item.people?.length) card.append(el('p', 'text', `${names(item.people)}${item.start_at ? ` · ${new Date(item.start_at).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : ''}`));
  if (item.lines?.length) {
    const convo = el('div', 'convo');
    for (const ln of item.lines.slice(0, 6)) {
      const row = el('div', `line ${ln.name && ln.name !== item.actor?.name ? 'right' : ''}`);
      const bubble = el('div', 'bubble', ln.text);
      row.append(personAvatar({ name: ln.name, color: ln.color }), bubble);
      convo.append(row);
    }
    card.append(convo);
  }
  const actions = el('div', 'post-actions');
  const visit = el('button', '', `Visit ${item.town.name}`);
  visit.type = 'button';
  visit.onclick = () => enterTown(item.town.id);
  actions.append(visit);
  card.append(actions);
  return card;
}

// Composer: posting is the opt-in. The town brain reads it on its next pass.
let composerMood = null;

function closeComposer() {
  $('#composer-form').hidden = true;
  $('#composer-open').hidden = false;
  $('#composer-text').value = '';
  setComposerMood(null);
}

function setComposerMood(btn) {
  composerMood = btn;
  for (const b of $$('#composer-moods button')) b.setAttribute('aria-checked', String(b === btn));
}

$('#composer-open').onclick = () => {
  $('#composer-form').hidden = false;
  $('#composer-open').hidden = true;
  $('#composer-text').focus();
};
$('#composer-cancel').onclick = closeComposer;
$('#composer-moods').onclick = (e) => {
  const b = e.target.closest('button');
  if (b) setComposerMood(composerMood === b ? null : b);
};
$('#composer-form').onsubmit = async (e) => {
  e.preventDefault();
  const text = $('#composer-text').value.trim();
  if (!text && !composerMood) return toast('Write something or pick how it\'s going.', 'error');
  if (!townsIn().length) return toast('Join a town first so there are friends to share with.', 'error');
  const value = { visibility: $('#composer-visibility').value };
  if (text) value.text = text;
  if (composerMood) value.mood = composerMood.dataset.mood;
  const btn = $('#composer-share');
  busy(btn, true, 'Sharing…');
  try {
    await api('/signals', { method: 'POST', body: { source: 'manual', type: composerMood?.dataset.type || 'update', value } });
    closeComposer();
    toast('Shared with your towns. They\'ll notice soon.');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    busy(btn, false, 'Share');
  }
};

$('#join-toggle').onclick = () => {
  $('#join-form').hidden = !$('#join-form').hidden;
  if (!$('#join-form').hidden) $('#join-code').focus();
};

$('#join-form').onsubmit = async (e) => {
  e.preventDefault();
  const code = $('#join-code').value.trim();
  const msg = $('#join-msg');
  message(msg, '');
  if (!code) return message(msg, 'Enter the invite code a friend gave you.');
  let options;
  try {
    options = await api(`/towns/lookup?invite_code=${encodeURIComponent(code)}`);
  } catch (err) {
    return message(msg, err.status === 404 ? 'No town has that invite code.' : err.message);
  }
  if (options.mine) return message(msg, `You're already in ${options.town.name}.`, 'info');
  const picked = await identityDialog.open({
    title: `Join ${options.town.name}`, confirmLabel: 'Join town', options,
    save: (me) => api('/towns/join', { method: 'POST', body: { invite_code: code, me } }),
  });
  if (!picked) return;
  $('#join-code').value = '';
  $('#join-form').hidden = true;
  await reloadMe();
  refreshAll();
  toast(`Welcome to ${options.town.name}, ${picked.name}!`);
};

// ---- Inbox: plans waiting on you, town invites, friend requests ----

function showInbox() {
  renderInbox();
  show('inbox');
  refreshAll();
}

function renderInbox() {
  if (!me) return;
  $('#plans').replaceChildren(...feed.inbox.map(planCard));
  $('#plans-section').hidden = !feed.inbox.length;
  $('#plan-count').textContent = feed.inbox.length;

  fillList($('#invites'), invites.map((inv) => {
    const li = personRow(inv.from_profile, [], `invited you to ${inv.towns?.name || 'a town'}`);
    const actions = li.querySelector('.actions');
    const accept = el('button', 'small primary', 'Join…');
    const decline = el('button', 'small', 'Decline');
    accept.onclick = async () => {
      let options;
      try { options = await api(`/towns/${inv.town_id}/identities`); } catch (err) { return toast(err.message, 'error'); }
      const picked = await identityDialog.open({
        title: `Join ${options.town.name}`, confirmLabel: 'Join town', options,
        save: (me) => api(`/invites/${inv.id}/respond`, { method: 'POST', body: { status: 'accepted', me } }),
      });
      if (!picked) return;
      await reloadMe();
      refreshAll();
      toast(`Welcome to ${options.town.name}, ${picked.name}!`);
    };
    decline.onclick = async () => {
      decline.disabled = accept.disabled = true;
      try { await api(`/invites/${inv.id}/respond`, { method: 'POST', body: { status: 'declined' } }); } catch (err) { toast(err.message, 'error'); }
      refreshAll();
    };
    actions.append(accept, decline);
    return li;
  }));
  $('#invites-section').hidden = !invites.length;
  $('#invite-count').textContent = invites.length;

  fillList($('#incoming'), requests.incoming.map((r) => personRow(r.from_profile, [
    ['Accept', () => api(`/friends/requests/${r.id}/respond`, { method: 'POST', body: { status: 'accepted' } }), 'primary'],
    ['Decline', () => api(`/friends/requests/${r.id}/respond`, { method: 'POST', body: { status: 'declined' } })],
  ], 'wants to be friends')));
  $('#requests-section').hidden = !requests.incoming.length;
  $('#request-count').textContent = requests.incoming.length;

  $('#inbox-empty').hidden = inboxCount() > 0;
  renderBadges();
}

// Suggested: accept or decline for yourself. Everyone accepted: any of you approves the drafted plan.
function planCard(p) {
  const card = el('div', 'plan');
  card.append(el('div', 'title', p.title || 'A plan'));
  const when = p.start_at ? ` · ${new Date(p.start_at).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : '';
  card.append(el('div', 'meta', `${p.town.name}${when}${p.people.length ? ` · with ${names(p.people)}` : ''}`));
  if (p.text) card.append(el('div', '', p.text));
  if (p.people.length) {
    const faces = el('div', 'faces');
    for (const person of p.people) {
      const face = el('span', 'face');
      const going = p.going.some((g) => g.user_id === person.user_id);
      face.append(personAvatar(person), `${person.name}${going ? ' · in' : person.status ? ` · ${STATUS_LABEL[person.status.status].toLowerCase()}` : ''}`);
      faces.append(face);
    }
    card.append(faces);
  }
  if (p.status === 'suggested' && myStatus()?.status === 'busy') {
    card.append(el('div', 'nudge', "You're marked busy, so no pressure. \"Not this time\" is always fine, and nobody sees why."));
  }
  const actions = el('div', 'actions');
  const act = (label, cls, fn, done) => {
    const b = el('button', `small ${cls}`, label);
    b.type = 'button';
    b.onclick = async () => {
      actions.querySelectorAll('button').forEach((x) => { x.disabled = true; });
      try { await fn(); toast(done); } catch (err) { toast(err.message, 'error'); }
      refreshAll();
    };
    return b;
  };
  if (p.status === 'scheduled') {
    card.append(el('div', 'meta', 'Everyone said yes. Approve the plan to lock it in.'));
    actions.append(act('Approve plan', 'primary', () => api(`/events/${p.id}/approve`, { method: 'POST' }), 'Plan approved. Have fun!'));
  } else {
    actions.append(
      act("I'm in", 'primary', () => api(`/events/${p.id}/respond`, { method: 'POST', body: { status: 'accepted' } }), "You're in."),
      act('Not this time', '', () => api(`/events/${p.id}/respond`, { method: 'POST', body: { status: 'declined' } }), 'Declined.'),
    );
  }
  card.append(actions);
  return card;
}

// ---- Friends ----

function showFriends() {
  message($('#search-msg'), '');
  $('#search-results').innerHTML = '';
  renderFriends();
  show('friends');
  refreshAll();
}

// A person row: avatar, name, @username, and optional action buttons [label, onClick, className]
function personRow(p, actions = [], note = '') {
  const li = document.createElement('li');
  li.innerHTML = `<div class="avatar sm"></div><div class="who"><div class="name"></div><div class="handle"></div></div><div class="actions"></div>`;
  paintAvatar(li.querySelector('.avatar'), p);
  ring(li.querySelector('.avatar'), p?.active_status);
  if (p?.id) li.dataset.person = p.id;
  li.querySelector('.name').textContent = p?.display_name || 'Unknown';
  li.querySelector('.handle').textContent = [p?.username ? `@${p.username}` : '', note].filter(Boolean).join(' · ');
  for (const [label, onClick, cls = ''] of actions) {
    const b = document.createElement('button');
    b.className = `small ${cls}`;
    b.textContent = label;
    b.onclick = async () => {
      li.querySelectorAll('button').forEach((x) => { x.disabled = true; });
      try { await onClick(); } catch (err) { toast(err.message, 'error'); }
      await refreshAll();
    };
    li.querySelector('.actions').append(b);
  }
  return li;
}

function fillList(ul, rows) {
  const scroll = ul.scrollTop; // background refreshes shouldn't jump a scrolled list back to the top
  ul.innerHTML = '';
  rows.forEach((r) => ul.append(r));
  ul.scrollTop = scroll;
}

// Friends list: scrolls inside its card, with a filter once there are more than a handful
const FILTER_AFTER = 5;

function renderFriends() {
  if (!me) return;
  const filter = $('#friend-filter');
  const q = filter.value.trim().toLowerCase().replace(/^@/, '');
  const shown = q ? allFriends.filter((f) => `${f.display_name ?? ''} ${f.username ?? ''}`.toLowerCase().includes(q)) : allFriends;
  fillList($('#friends'), shown.map((f) => personRow(f, [
    ['Remove', async () => {
      const yes = await confirmDialog({ title: `Remove ${f.display_name}?`, body: "You'll stop being friends. You can send a new request later.", confirmLabel: 'Remove', danger: true });
      if (yes) await api(`/friends/${f.id}`, { method: 'DELETE' });
    }, 'danger'],
  ])));
  filter.hidden = allFriends.length <= FILTER_AFTER && !q;
  $('#friend-count').textContent = allFriends.length ? `(${allFriends.length})` : '';
  $('#no-friends').hidden = allFriends.length > 0;
  $('#no-matches').hidden = !(allFriends.length && !shown.length);
  fillList($('#outgoing'), requests.outgoing.map((r) => personRow(r.to_profile, [], 'request sent')));
  $('#outgoing-section').hidden = !requests.outgoing.length;
}

$('#friend-filter').oninput = renderFriends;

$('#search-form').onsubmit = async (e) => {
  e.preventDefault();
  const username = $('#search-input').value.trim().toLowerCase().replace(/^@/, '');
  const results = $('#search-results');
  const msg = $('#search-msg');
  results.innerHTML = '';
  message(msg, '');
  if (!USERNAME_RE.test(username)) return message(msg, 'Usernames are 3–20 lowercase letters, numbers, or underscores.');
  if (username === me.username) return message(msg, "That's you!", 'info');
  try {
    const found = await api(`/users/search?username=${encodeURIComponent(username)}`);
    if (!found.length) return message(msg, `No one has the username @${username}.`, 'info');
    fillList(results, found.map((p) => personRow(p, [['Add friend', async () => {
      const res = await api('/friends/requests', { method: 'POST', body: { username: p.username } });
      results.innerHTML = '';
      $('#search-input').value = '';
      message(msg, res.status === 'accepted'
        ? `You and ${p.display_name} are now friends!`
        : `Friend request sent to @${p.username}.`, 'success');
    }, 'primary']])));
  } catch (err) {
    message(msg, err.message);
  }
};

// ---- Someone else's profile ----

let personId = null;

async function showPerson(id) {
  personId = id;
  $('#p-name').textContent = '';
  $('#p-handle').textContent = '';
  for (const c of ['#p-you-card', '#p-interests-card', '#p-towns-card', '#p-mutual-card', '#p-stranger']) $(c).hidden = true;
  $('#p-actions').replaceChildren();
  $('#p-bio').textContent = '';
  $('#p-stats').textContent = '';
  $('#p-status').replaceChildren();
  show('person');
  scrollTo(0, 0);
  let p;
  try { p = await api(`/users/${encodeURIComponent(id)}/profile`); } catch (err) {
    $('#p-name').textContent = err.status === 404 ? 'No one here' : "Couldn't load this profile";
    return toast(err.message, 'error');
  }
  if (personId !== id) return; // navigated away while loading
  renderPerson(p);
}

function renderPerson(p) {
  const avatar = $('#p-avatar');
  paintAvatar(avatar, { id: p.id, display_name: p.display_name, avatar: { photo: p.photo } });
  ring(avatar, p.status);
  $('#p-name').textContent = p.display_name || 'Someone';
  $('#p-handle').textContent = p.username ? `@${p.username}` : '';

  // Friend button (and Visit when you share a town)
  const actions = $('#p-actions');
  const button = (label, cls, fn) => {
    const b = el('button', `small ${cls}`, label);
    b.type = 'button';
    if (fn) b.onclick = async () => {
      b.disabled = true;
      try { await fn(); await refreshAll(); showPerson(p.id); } catch (err) { toast(err.message, 'error'); b.disabled = false; }
    };
    return b;
  };
  const f = p.friendship;
  const btns = [];
  if (f.state === 'none') btns.push(button('Add friend', 'primary', async () => { await api('/friends/requests', { method: 'POST', body: { username: p.username } }); toast(`Friend request sent to @${p.username}`); }));
  if (f.state === 'requested') { const b = button('Requested', ''); b.disabled = true; btns.push(b); }
  if (f.state === 'incoming') {
    btns.push(button('Accept', 'primary', () => api(`/friends/requests/${f.request_id}/respond`, { method: 'POST', body: { status: 'accepted' } })));
    btns.push(button('Decline', '', () => api(`/friends/requests/${f.request_id}/respond`, { method: 'POST', body: { status: 'declined' } })));
  }
  if (f.state === 'friends') btns.push(button('✓ Friends', 'tonal', async () => {
    const yes = await confirmDialog({ title: `Remove ${p.display_name}?`, body: "You'll stop being friends. You can send a new request later.", confirmLabel: 'Remove', danger: true });
    if (yes) await api(`/friends/${p.id}`, { method: 'DELETE' });
  }));
  if (p.shared_towns?.length) {
    const visit = button('Visit', 'primary');
    visit.onclick = () => enterTown(p.shared_towns[0].id);
    btns.unshift(visit);
  }
  actions.replaceChildren(...btns);

  if (p.relation === 'stranger') {
    $('#p-stranger-title').textContent = f.state === 'friends' ? '' : `Add ${p.display_name} to see their profile`;
    $('#p-stranger').hidden = false;
    return;
  }

  if (p.status) $('#p-status').replaceChildren(el('span', `status-on ${p.status.status}`, `${STATUS_LABEL[p.status.status]} · ${timeLeft(p.status.until)}`));
  $('#p-bio').textContent = p.bio;
  $('#p-bio').hidden = !p.bio;
  const stats = [];
  if (f.state === 'friends') stats.push('Friends');
  if (p.shared_towns.length) stats.push(`${p.shared_towns.length} ${p.shared_towns.length === 1 ? 'town' : 'towns'} together`);
  if (p.mutual_count) stats.push(`${p.mutual_count} mutual ${p.mutual_count === 1 ? 'friend' : 'friends'}`);
  $('#p-stats').textContent = stats.join(' · ');

  if (p.you_two) {
    $('#p-you-text').textContent = crossedPaths(p.you_two.days_since);
    $('#p-you-bar').style.width = `${Math.round(p.you_two.score * 100)}%`;
    $('#p-you-card').hidden = false;
  }
  $('#p-interests').replaceChildren(...p.interests.map((i) => {
    const chip = el('span', `chip ${i.shared ? 'shared' : 'muted'}`, i.name);
    if (i.shared) chip.title = 'You both like this';
    return chip;
  }));
  $('#p-interests-card').hidden = !p.interests.length;
  $('#p-towns').replaceChildren(...p.shared_towns.map((t) => {
    const li = el('li', 'town');
    const ringWrap = el('div', 'ring');
    ringWrap.append(townIcon(t));
    const who = el('div', 'who');
    const handle = el('div', 'handle');
    if (t.their_color) { const dot = el('span', 'dot'); dot.style.background = t.their_color; handle.append(dot); }
    handle.append(`${t.their_name || p.display_name} there · ${t.residents} ${t.residents === 1 ? 'resident' : 'residents'}`);
    who.append(el('div', 'name', t.name), handle);
    const enter = el('button', 'small tonal', 'Enter');
    li.append(ringWrap, who, enter);
    li.onclick = () => enterTown(t.id);
    return li;
  }));
  $('#p-towns-card').hidden = !p.shared_towns.length;
  $('#p-mutual').replaceChildren(...p.mutual_friends.map((m) => personRow(m)));
  $('#p-mutual-count').textContent = p.mutual_count ? `(${p.mutual_count})` : '';
  $('#p-mutual-card').hidden = !p.mutual_count;
}

// ---- Profile ----

function renderHighlights() {
  const s = stats || {};
  const tile = (emoji, hue, label, value, detail, townId) => {
    const t = el(townId ? 'button' : 'div', 'highlight');
    if (townId) { t.type = 'button'; t.onclick = () => enterTown(townId); }
    const body = el('div');
    body.append(el('div', 'label', label), el('div', 'value', value), el('div', 'detail', detail));
    t.append(el('div', `emoji ${hue}`, emoji), body);
    return t;
  };
  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  $('#highlights').replaceChildren(
    s.most_active
      ? tile('🔥', 'hue-4', 'Most active town', s.most_active.name, `${plural(s.most_active.activity_week, 'thing')} happened this week`, s.most_active.id)
      : tile('🔥', 'hue-4', 'Most active town', 'Quiet week', 'Nothing new in your towns yet'),
    s.biggest
      ? tile('🏘️', 'hue-3', 'Biggest town', s.biggest.name, plural(s.biggest.residents, 'resident'), s.biggest.id)
      : tile('🏘️', 'hue-3', 'Biggest town', 'No towns yet', 'Join one from an invite'),
    tile('🤝', 'hue-2', 'Real-life hangouts', String(s.hangouts ?? 0), 'Plans that actually happened'),
    tile('👋', 'hue-1', 'Townmates', String(s.townmates ?? 0), `${plural(s.shared ?? 0, 'update')} shared with them`),
  );
}

function showProfile() {
  renderProfile();
  show('profile');
  refreshAll();
}

// "● Sam here" in your color for that town
function townIdentityNote(m) {
  const frag = document.createDocumentFragment();
  if (m.color) {
    const dot = el('span', 'dot');
    dot.style.background = m.color;
    frag.append(dot);
  }
  frag.append(m.name ? `${m.name} here` : 'no name picked yet');
  return frag;
}

function renderProfile() {
  if (!me) return;
  paintAvatar($('#me-avatar'), me);
  renderMyStatus();
  $('#me-name').textContent = me.display_name;
  $('#me-handle').textContent = `@${me.username}`;
  $('#me-bio').textContent = me.bio || '';
  $('#me-bio').hidden = !me.bio;
  $('#me-bio-add').hidden = Boolean(me.bio);
  $('#stat-towns').textContent = townsIn().length;
  $('#stat-friends').textContent = allFriends.length;
  $('#stat-hangouts').textContent = stats?.hangouts ?? 0;
  renderHighlights();
  const closest = stats?.closest || [];
  $('#closest').replaceChildren(...closest.map((p) => {
    const li = mateRow(p, `${crossedPaths(p.days_since)} · ${p.town.name}`);
    const bond = el('div', 'bond');
    const fill = el('span');
    fill.style.width = `${Math.round(p.score * 100)}%`;
    bond.append(fill);
    li.querySelector('.who').append(bond);
    return li;
  }));
  $('#closest-section').hidden = !closest.length;
  renderChips($('#me-interests'), me.interests || []);
  $('#no-interests').hidden = Boolean(me.interests?.length);
  // Each town you're in; clicking one opens it in 3D, built from its tiles and map in the database
  fillList($('#towns'), townsIn().map((m) => {
    const t = m.towns;
    const li = el('li', 'town');
    li.innerHTML = `<div class="ring"></div><div class="who"><div class="name"></div><div class="handle"></div></div><div class="actions"><button class="small tonal">Enter</button><button class="small danger">Leave</button></div>`;
    li.querySelector('.ring').append(townIcon(t));
    li.querySelector('.name').textContent = t.name;
    const handle = li.querySelector('.handle');
    handle.append(townIdentityNote(m));
    handle.append([t.created_by === me.id ? ' · your town' : '', ` · invite code ${t.invite_code}`,
      m.house_x == null ? ' · no house yet' : ''].join(''));
    li.onclick = () => enterTown(t.id);
    const leave = li.querySelector('.danger');
    leave.onclick = (e) => { e.stopPropagation(); leaveTown(t); };
    return li;
  }));
  $('#profile-no-towns').hidden = townsIn().length > 0;
}

// ---- Settings ----------------------------------------------------------------------------------

const dirty = new Set(); // panes with unsaved edits
const clearDirty = () => dirty.clear();
function setDirty(pane, on) { if (on) dirty.add(pane); else dirty.delete(pane); }
function resetPane(pane) {
  if (pane === 'profile') profile.load();
  if (pane === 'character') character.load();
  setDirty(pane, false);
}

function showSettings(pane) {
  if (pane !== currentPane) {
    if (pane === 'profile') profile.load();
    if (pane === 'account') account.load();
    if (pane === 'appearance') appearance.load();
    if (pane === 'privacy') privacy.load();
    if (pane === 'towns') townsPane.load();
  }
  currentPane = pane;
  for (const el of $$('.pane')) el.hidden = el.dataset.pane !== pane;
  for (const a of $$('.settings nav a')) {
    if (a.dataset.pane === pane) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
  show('settings');
  if (pane === 'character') character.start();
  scrollTo(0, 0);
}

// Profile: name, username, interests
const profile = (() => {
  let interests = [];
  const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

  function load() {
    $('#set-name').value = me.display_name || '';
    $('#set-username').value = me.username || '';
    $('#set-bio').value = me.bio || '';
    paintMyAvatars();
    interests = [...(me.interests || [])];
    message($('#profile-msg'), '');
    update();
  }

  function renderInterests() {
    const box = $('#interests-box'), input = $('#interest-input');
    box.querySelectorAll('.chip').forEach((c) => c.remove());
    interests.forEach((text, i) => {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.textContent = text;
      const x = document.createElement('button');
      x.type = 'button';
      x.textContent = '×';
      x.setAttribute('aria-label', `Remove ${text}`);
      x.onclick = () => { interests.splice(i, 1); update(); input.focus(); };
      chip.append(x);
      box.insertBefore(chip, input);
    });
    input.placeholder = interests.length ? '' : 'climbing, jazz, board games…';
  }

  function changes() {
    const out = {};
    const name = $('#set-name').value.trim(), username = $('#set-username').value.trim().toLowerCase();
    if (name !== me.display_name) out.display_name = name;
    if (username !== me.username) out.username = username;
    const bio = $('#set-bio').value.split(/\s+/).join(' ').trim();
    if (bio !== (me.bio || '')) out.bio = bio;
    if (!same(interests, me.interests || [])) out.interests = interests;
    return out;
  }

  function update() {
    renderInterests();
    const typed = $('#set-name').value.trim();
    const nameHint = $('#set-name-hint');
    nameHint.className = `hint ${typed ? '' : 'bad'}`;
    nameHint.textContent = typed ? 'How friends see you. In each town you pick the name you go by there.' : 'Enter your name';
    const okName = Boolean(typed);
    const okUser = usernameHint($('#set-username'), $('#set-username-hint'), me.username);
    const name = $('#set-name').value.trim() || me.display_name;
    paintAvatar($('#preview-avatar'), me, name);
    $('#preview-name').textContent = name;
    $('#preview-handle').textContent = `@${$('#set-username').value || me.username}`;
    $('#preview-bio').textContent = $('#set-bio').value.trim();
    $('#set-bio-count').textContent = `${$('#set-bio').value.length}/160`;
    const isDirty = Object.keys(changes()).length > 0;
    setDirty('profile', isDirty);
    $('#profile-reset').disabled = !isDirty;
    $('#profile-save').disabled = !isDirty || !okName || !okUser;
  }

  function addInterest(raw) {
    for (const part of raw.split(',')) {
      const v = part.trim().toLowerCase();
      if (v && !interests.includes(v) && interests.length < 30) interests.push(v);
    }
    $('#interest-input').value = '';
    update();
  }

  $('#set-name').oninput = update;
  $('#set-username').oninput = update;
  $('#set-bio').oninput = update;
  $('#interest-input').onkeydown = (e) => {
    const input = e.target;
    if ((e.key === 'Enter' || e.key === ',') && input.value.trim()) { e.preventDefault(); addInterest(input.value); }
    else if (e.key === 'Enter') e.preventDefault();
    else if (e.key === 'Backspace' && !input.value && interests.length) { interests.pop(); update(); }
  };
  $('#interest-input').onblur = (e) => { if (e.target.value.trim()) addInterest(e.target.value); };
  $('#interests-box').onclick = (e) => { if (e.target.id === 'interests-box') $('#interest-input').focus(); };
  $('#profile-reset').onclick = load;

  $('#profile-form').onsubmit = async (e) => {
    e.preventDefault();
    if ($('#interest-input').value.trim()) addInterest($('#interest-input').value);
    const body = changes();
    if (!Object.keys(body).length) return;
    const btn = $('#profile-save');
    busy(btn, true, 'Saving…');
    try {
      me = await api('/me', { method: 'PATCH', body });
      renderIdentity();
      load();
      toast('Profile saved');
    } catch (err) {
      message($('#profile-msg'), err.message === 'username is taken' ? `@${body.username} is taken. Try another.` : err.message);
    } finally {
      busy(btn, false, 'Save changes');
      update();
    }
  };

  return { load };
})();

// Character: your look (the same in every town), with a live 3D preview you can turn around.
// three.js loads only when this pane opens. Your color is picked per town (see Towns).
const character = (() => {
  let mod = null, preview = null, thumbs = null, starting = null, shown = null;
  let look = null;

  const saved = () => me.avatar?.character || null;

  function load() {
    look = saved();
    message($('#character-msg'), '');
    update();
  }

  function update() {
    for (const b of $$('#looks .look')) b.setAttribute('aria-checked', String(b.dataset.look === look));
    const shownLook = look || mod?.LOOKS[0];
    if (preview && shown !== shownLook) { preview.setLook(shownLook); shown = shownLook; }
    const isDirty = look !== saved();
    setDirty('character', isDirty);
    $('#character-reset').disabled = !isDirty;
    $('#character-save').disabled = !isDirty || !look;
  }

  function buildLooks() {
    $('#looks').innerHTML = '';
    mod.LOOKS.forEach((l, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'look';
      b.dataset.look = l;
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-label', `Character ${i + 1}`);
      if (thumbs?.[l]) b.innerHTML = `<img alt="" src="${thumbs[l]}">`;
      else b.textContent = i + 1;
      b.onclick = () => { look = l; update(); };
      $('#looks').append(b);
    });
  }

  async function start() {
    if (preview || starting) return;
    starting = (async () => {
      $('#stage-loading').hidden = false;
      try {
        mod ??= await import('./character-preview.js');
        preview = await mod.createPreview($('#stage'));
        preview.setColor(getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#3b6fe0');
        thumbs ??= preview.thumbnails();
        buildLooks();
        if (!dirty.has('character')) load(); else update();
      } catch (err) {
        message($('#character-msg'), `Couldn't load the characters: ${err.message}`);
      } finally {
        $('#stage-loading').hidden = true;
        starting = null;
      }
      if (currentPane !== 'character') stop();
    })();
  }

  function stop() {
    preview?.dispose();
    preview = shown = null;
  }

  $('#character-reset').onclick = load;
  $('#character-save').onclick = async () => {
    const btn = $('#character-save');
    busy(btn, true, 'Saving…');
    try {
      me = await api('/me', { method: 'PATCH', body: { avatar: { ...(me.avatar || {}), character: look } } });
      toast('Look saved. It shows up next time a town loads.');
    } catch (err) {
      message($('#character-msg'), err.message);
    } finally {
      busy(btn, false, 'Save character');
      update();
    }
  };

  return { load, start, stop };
})();

// Your name and color in one town, picked in a dialog. `options` is GET /towns/lookup or
// /towns/{id}/identities: {town, taken: [{name, color}], mine, suggested_color}. Resolves
// {name, color}, or null if cancelled. `save` does the request; its error stays in the dialog.
const identityDialog = (() => {
  const dialog = $('#identity-dialog');
  let taken = [], color = null, keep = { name: null, color: null };
  const wheel = createWheel($('#identity-wheel'), { onChange: (c) => { color = c; update(); } });
  const norm = (n) => (n || '').split(/\s+/).filter(Boolean).join(' ').toLowerCase();

  function update() {
    const name = $('#identity-name').value.trim();
    const nameClash = name && taken.find((p) => norm(p.name) === norm(name));
    const colorClash = color && Colors.clashWith(taken, color);
    const nh = $('#identity-name-hint'), ch = $('#identity-color-hint');
    nh.className = `hint ${!name || nameClash ? 'bad' : 'ok'}`;
    nh.textContent = !name ? 'Up to 30 characters' : nameClash ? `Someone here already goes by ${nameClash.name}` : 'Nobody here goes by this name';
    ch.className = `hint ${!color || colorClash ? 'bad' : 'ok'}`;
    ch.textContent = !color ? 'Pick a color on the wheel.'
      : colorClash ? `Too close to ${colorClash.name}'s color. Pick something further away.`
      : taken.some((p) => p.color) ? 'Nobody here has a color like this.' : 'Your color in this town.';
    const tag = $('#identity-tag');
    tag.textContent = name || 'Your name';
    tag.style.background = color || 'var(--soft)';
    tag.style.color = color ? Colors.inkOn(color) : 'var(--muted)';
    const unchanged = name === keep.name && color === keep.color;
    $('#identity-ok').disabled = !name || !color || Boolean(nameClash) || Boolean(colorClash) || unchanged;
  }

  $('#identity-name').oninput = update;
  $('#identity-free').onclick = () => { color = Colors.freeColor(taken.map((p) => p.color).filter(Boolean)); wheel.set(color); update(); };

  function open({ title, confirmLabel, options, save }) {
    taken = options.taken || [];
    const mine = options.mine;
    keep = mine ? { name: mine.name, color: mine.color } : { name: null, color: null };
    $('#identity-title').textContent = title;
    $('#identity-ok').textContent = confirmLabel;
    $('#identity-name').value = mine?.name || me.display_name || '';
    color = mine?.color || options.suggested_color || null;
    wheel.setTaken(taken);
    wheel.set(color);
    message($('#identity-msg'), '');
    update();
    dialog.showModal();
    $('#identity-name').focus();
    return new Promise((resolve) => {
      $('#identity-form').onsubmit = async (e) => {
        if (e.submitter?.value !== 'ok') return; // Cancel closes the dialog as usual
        e.preventDefault();
        const picked = { name: $('#identity-name').value.trim(), color };
        const btn = $('#identity-ok');
        busy(btn, true, 'Saving…');
        try {
          await save(picked);
          dialog.close('ok');
          resolve(picked);
        } catch (err) {
          message($('#identity-msg'), err.message);
        } finally {
          busy(btn, false, confirmLabel);
        }
      };
      dialog.addEventListener('close', () => { if (dialog.returnValue !== 'ok') resolve(null); }, { once: true });
      dialog.returnValue = '';
    });
  }

  return { open };
})();

// Leave a town (from Profile or Settings → Towns). If you made it, it passes to its longest-standing member.
async function leaveTown(t) {
  const mine = t.created_by === me.id;
  const yes = await confirmDialog({
    title: `Leave ${t.name}?`,
    body: `Your house and character will be removed from ${t.name}, and you'd need a new invite to come back.`
      + (mine ? " You created this town, so it passes to whoever has been there longest. If you're the last one there, the town is deleted." : ''),
    confirmLabel: 'Leave town', danger: true,
  });
  if (!yes) return;
  try {
    await api(`/towns/${t.id}/members/me`, { method: 'DELETE' });
    myTowns = myTowns.filter((m) => m.towns?.id !== t.id);
    feed = { ...feed, towns: feed.towns.filter((x) => x.id !== t.id) };
    townsPane.load();
    renderProfile();
    renderFeed();
    toast(`You left ${t.name}`);
    refreshAll();
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ---- Profile photo: crop to a square and shrink in the browser, then upload the JPEG ----

function paintMyAvatars() {
  for (const id of ['#bar-avatar', '#menu-avatar', '#composer-avatar', '#me-avatar', '#photo-preview', '#preview-avatar']) paintAvatar($(id), me);
  $('#photo-remove').hidden = !me.avatar?.photo;
  renderMyStatus();
}

async function squareJpeg(file, size = 400) {
  const img = await createImageBitmap(file);
  const side = Math.min(img.width, img.height);
  const canvas = Object.assign(document.createElement('canvas'), { width: size, height: size });
  canvas.getContext('2d').drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, size, size);
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.86));
}

document.addEventListener('click', (e) => { if (e.target.closest('[data-photo-pick]')) $('#photo-input').click(); });
$('#photo-input').onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const shown = [$('#me-avatar'), $('#photo-preview')];
  shown.forEach((a) => a.classList.add('uploading'));
  try {
    let blob;
    try { blob = await squareJpeg(file); } catch { throw new Error("That image couldn't be opened. Try a JPEG or PNG."); }
    me = await api('/me/photo', { method: 'PUT', file: blob });
    paintMyAvatars();
    toast('Profile photo updated');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    shown.forEach((a) => a.classList.remove('uploading'));
  }
};
$('#photo-remove').onclick = async () => {
  try {
    me = await api('/me/photo', { method: 'DELETE' });
    paintMyAvatars();
    toast('Photo removed');
  } catch (err) { toast(err.message, 'error'); }
};

async function reloadMe() {
  ({ profile: me, towns: myTowns } = await api('/me'));
}

// Towns: your name and color in each town (edit), and leaving
const townsPane = (() => {
  function load() {
    fillList($('#settings-towns'), townsIn().map((m) => {
      const t = m.towns;
      const li = document.createElement('li');
      li.innerHTML = `<div class="ring"></div><div class="who"><div class="name"></div><div class="handle"></div></div><div class="actions"><button class="small">Name &amp; color</button><button class="small danger">Leave</button></div>`;
      li.querySelector('.ring').append(townIcon(t));
      li.querySelector('.name').textContent = t.name;
      li.querySelector('.handle').append(townIdentityNote(m));
      const [edit, leave] = li.querySelectorAll('button');
      edit.onclick = () => editIdentity(t);
      leave.onclick = () => leaveTown(t);
      return li;
    }));
    $('#settings-no-towns').hidden = townsIn().length > 0;
  }

  async function editIdentity(t) {
    let options;
    try { options = await api(`/towns/${t.id}/identities`); } catch (err) { return toast(err.message, 'error'); }
    const picked = await identityDialog.open({
      title: `You in ${t.name}`, confirmLabel: 'Save', options,
      save: (body) => api(`/towns/${t.id}/members/me/identity`, { method: 'PATCH', body }),
    });
    if (!picked) return;
    await reloadMe();
    load();
    toast(`Saved. You're ${picked.name} in ${t.name}.`);
  }

  return { load };
})();

// Account: email, password, sessions
const account = (() => {
  async function load() {
    $('#email-form').hidden = $('#password-form').hidden = true;
    message($('#email-msg'), '');
    message($('#password-msg'), '');
    $('#acct-since').textContent = me.created_at
      ? new Date(me.created_at).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }) : '';
    const { data } = await sb.auth.getUser();
    $('#acct-email').textContent = data?.user?.email || '';
  }

  $('#email-edit').onclick = () => {
    $('#email-form').hidden = false;
    $('#new-email').value = '';
    $('#new-email').focus();
  };
  $('#email-cancel').onclick = () => { $('#email-form').hidden = true; message($('#email-msg'), ''); };
  $('#email-form').onsubmit = async (e) => {
    e.preventDefault();
    const email = $('#new-email').value.trim();
    if (!/^\S+@\S+\.\S+$/.test(email)) return message($('#email-msg'), 'Enter a valid email address.');
    const btn = $('#email-save');
    busy(btn, true, 'Sending…');
    try {
      const { error } = await sb.auth.updateUser({ email });
      if (error) throw error;
      $('#email-form').hidden = true;
      message($('#email-msg'), `Check ${email} for a confirmation link. Your email changes once you open it.`, 'info');
    } catch (err) {
      message($('#email-msg'), err.message);
    } finally {
      busy(btn, false, 'Send confirmation');
    }
  };

  $('#password-edit').onclick = () => {
    $('#password-form').hidden = false;
    $('#new-password').value = $('#confirm-password').value = '';
    $('#new-password').focus();
  };
  $('#password-cancel').onclick = () => { $('#password-form').hidden = true; message($('#password-msg'), ''); };
  $('#password-form').onsubmit = async (e) => {
    e.preventDefault();
    const password = $('#new-password').value;
    if (password.length < 6) return message($('#password-msg'), 'Password must be at least 6 characters.');
    if (password !== $('#confirm-password').value) return message($('#password-msg'), "The passwords don't match.");
    const btn = $('#password-save');
    busy(btn, true, 'Updating…');
    try {
      const { error } = await sb.auth.updateUser({ password });
      if (error) throw error;
      $('#password-form').hidden = true;
      message($('#password-msg'), '');
      toast('Password updated');
    } catch (err) {
      message($('#password-msg'), err.message);
    } finally {
      busy(btn, false, 'Update password');
    }
  };

  $('#acct-sign-out').onclick = () => signOut();
  $('#acct-sign-out-all').onclick = async () => {
    const yes = await confirmDialog({ title: 'Sign out everywhere?', body: "You'll be signed out on every device, including this one.", confirmLabel: 'Sign out everywhere', danger: true });
    if (yes) await signOut('global');
  };

  return { load };
})();

// Appearance: theme, stored on this device
const appearance = (() => {
  function load() {
    const t = getTheme();
    for (const b of $$('[data-theme-choice]')) b.setAttribute('aria-checked', String(b.dataset.themeChoice === t));
  }
  for (const b of $$('[data-theme-choice]')) b.onclick = () => { setTheme(b.dataset.themeChoice); load(); };
  return { load };
})();

// Privacy & data: download, delete account
const privacy = (() => {
  function load() {}


  $('#download-data').onclick = async () => {
    const btn = $('#download-data');
    busy(btn, true, 'Preparing…');
    try {
      const [mine, friends, requests, signals, invites, { data: auth }] = await Promise.all([
        api('/me'), api('/friends'), api('/friends/requests'), api('/signals'), api('/me/invites'), sb.auth.getUser(),
      ]);
      const data = {
        exported_at: new Date().toISOString(),
        account: { email: auth?.user?.email, created_at: auth?.user?.created_at },
        profile: mine.profile, towns: mine.towns, friends, friend_requests: requests, town_invites: invites, shared_signals: signals,
      };
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      Object.assign(document.createElement('a'), { href: url, download: `luma-${me.username}.json` }).click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      busy(btn, false, 'Download my data');
    }
  };

  $('#delete-account').onclick = async () => {
    const yes = await confirmDialog({
      title: 'Delete your account?',
      body: 'This permanently deletes your profile, friends, shared updates and characters. It cannot be undone.',
      confirmLabel: 'Delete account', danger: true, typeToConfirm: me.username,
    });
    if (!yes) return;
    const btn = $('#delete-account');
    busy(btn, true, 'Deleting…');
    try {
      await api('/me', { method: 'DELETE' });
      clearDirty();
      toast('Your account was deleted');
      await signOut();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      busy(btn, false, 'Delete my account…');
    }
  };

  return { load };
})();

boot();

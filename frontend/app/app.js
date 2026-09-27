// Entry app: sign in / create account → pick a username (first time) → home (friends + towns),
// plus the account menu, settings (#/settings/<pane>) and help (#/help). Routes live in the URL hash
// so the back button and links work.
import { api, getSupabase } from '../shared/session.js';
import { confirmDialog, getTheme, promptDialog, setTheme, toast } from './ui.js';
import * as Colors from '../shared/colors.js';
import { createWheel } from './wheel.js';
import { skyline, tierFor } from './skyline.js';
import { drawTown } from './townart.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const USERNAME_RE = /^[a-z0-9_]{3,20}$/;
const VIEWS = ['loading', 'error', 'auth', 'username', 'home', 'feed', 'friends', 'inbox', 'profile', 'person', 'settings', 'help'];
const SIGNED_IN_VIEWS = new Set(['home', 'feed', 'friends', 'inbox', 'profile', 'person', 'settings', 'help']);
const PANES = ['profile', 'character', 'towns', 'calendar', 'account', 'appearance', 'privacy'];

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
  $('#shell').classList.toggle('feed', ['feed', 'friends', 'inbox', 'profile', 'person', 'help'].includes(view));
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
  const avatar = target.classList.contains('avatar') ? target : target.querySelector('.avatar');
  const name = target.querySelector('.name, .title, b')?.textContent || (target.classList.contains('title') ? target.textContent : '');
  personHint = { id: target.dataset.person, name: name.replace(/ \(you\)$/, ''), avatar };
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
  if (session && calendarPane.returning) await calendarPane.finishConnect(session);
  if (session) await afterSignIn();
  else showAuth();
}

$('#retry').onclick = boot;

// After any successful sign in: new users pick a username, everyone else goes where the URL says
async function afterSignIn() {
  show('loading');
  try {
    ({ profile: me, towns: myTowns } = await api('/me'));
    loadPins();
  } catch (e) {
    if (e.status === 401) { await sb.auth.signOut(); return; }
    $('#error-text').textContent = e.message;
    return show('error');
  }
  if (!me.username) return showUsername();
  saveTimeZone();
  renderIdentity();
  route();
}

// Times are stored in UTC; your profile remembers your time zone so plan hours and "today" use yours.
// Kept up to date quietly, e.g. after you travel.
function saveTimeZone() {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (!zone || me.timezone === zone) return;
  api('/me', { method: 'PATCH', body: { timezone: zone } })
    .then((row) => { if (row) me.timezone = row.timezone; })
    .catch(() => {}); // e.g. the column isn't in the database yet: nothing to show the person
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
  if (['help', 'feed', 'friends', 'inbox', 'profile'].includes(parts[0])) return { view: parts[0] };
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

let lastRouted = null;
function route() {
  lastHash = location.hash;
  const { view, pane, id } = parseHash();
  closeMenu();
  // A different tab (or another person's profile) opens at its top, not at the scroll spot of the last one
  const where = `${view}/${id || ''}`;
  if (lastRouted && where !== lastRouted) scrollTo(0, 0);
  lastRouted = where;
  if (view === 'settings') return showSettings(pane);
  currentPane = null;
  if (view === 'help') { show('help'); return scrollTo(0, 0); }
  if (view === 'friends') return showFriends();
  if (view === 'inbox') return showInbox();
  if (view === 'profile') return showProfile();
  if (view === 'person') return showPerson(id);
  if (view === 'feed') return showFeed();
  showHome();
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
    const body = { username, display_name };
    for (const k of ['instagram', 'facebook']) if (socialInput(`#signup-${k}`)) body[k] = socialInput(`#signup-${k}`);
    me = await api('/me', { method: 'PATCH', body });
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
let suggestions = []; // GET /friends/suggestions: friends of friends and townmates you haven't added
let stats = null; // GET /me/stats: highlights, closest people, who to catch up with
let notices = []; // GET /me/notifications: things that happened to you (a town you were in was deleted)

// Instagram / Facebook links on a profile (the backend builds the URLs from the stored usernames)
const SOCIAL_ICON = {
  instagram: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="3.5" width="17" height="17" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.3" cy="6.7" r="0.6"/></svg>',
  facebook: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 8.5h2.5V5H14a3.5 3.5 0 0 0-3.5 3.5V11H8v3.5h2.5V21H14v-6.5h2.5L17 11h-3V8.5z"/></svg>',
};
const socialUrl = { instagram: (u) => `https://www.instagram.com/${u}/`, facebook: (u) => (/^\d+$/.test(u) ? `https://www.facebook.com/profile.php?id=${u}` : `https://www.facebook.com/${u}`) };
function renderSocials(box, links) {
  const items = ['instagram', 'facebook'].filter((k) => links?.[k]).map((k) => {
    const a = el('a', k === 'facebook' ? 'fb' : 'ig');
    a.href = links[k];
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.innerHTML = SOCIAL_ICON[k];
    a.append(k === 'instagram' ? 'Instagram' : 'Facebook');
    return a;
  });
  box.replaceChildren(...items);
  box.hidden = !items.length;
}
// What people typed ("@maya", a pasted link) as the API expects; the backend does the real cleanup
const socialInput = (id) => $(id).value.trim();

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
  const [f, fr, rq, inv, st, nt, sg] = await Promise.allSettled([api('/me/feed'), api('/friends'), api('/friends/requests'), api('/me/invites'), api('/me/stats'), api('/me/notifications'), api('/friends/suggestions')]);
  if (sg.status === 'fulfilled') suggestions = sg.value;
  if (f.status === 'fulfilled') feed = f.value;
  if (nt.status === 'fulfilled') notices = nt.value;
  if (st.status === 'fulfilled') stats = st.value;
  if (fr.status === 'fulfilled') allFriends = fr.value;
  if (rq.status === 'fulfilled') requests = rq.value;
  if (inv.status === 'fulfilled') invites = inv.value;
  renderFeed();
  renderFriends();
  renderInbox();
  renderProfile();
  loadSchedule({ keepForm: true });
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
// A status you set wins; otherwise your calendar makes you busy while a block runs (from /me/feed)
function myStatus() {
  if (me?.status && me.status_until && new Date(me.status_until) > new Date()) return { status: me.status, until: me.status_until };
  const cal = feed.my_calendar_busy;
  return cal && new Date(cal.until) > new Date() ? { status: 'busy', until: cal.until, since: cal.since, source: 'calendar' } : null;
}
// How much ring is left: over the calendar block when it came from one, else over the tap's 3 hours
function statusLeft(st) {
  const span = st.since ? new Date(st.until) - new Date(st.since) : STATUS_HOURS * 3600e3;
  return Math.max(0, Math.min(1, (new Date(st.until) - Date.now()) / span));
}

function timeLeft(until) {
  const mins = Math.max(1, Math.ceil((new Date(until) - Date.now()) / 60e3));
  return mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m left` : `${mins}m left`;
}

// Ring an avatar for a status (or clear it); --left drives how much of the ring is still drawn
function ring(elm, st) {
  elm.classList.remove('st-free', 'st-busy');
  if (!st) return;
  elm.classList.add(`st-${st.status}`);
  elm.style.setProperty('--left', statusLeft(st).toFixed(3));
}

function renderMyStatus() {
  const st = myStatus();
  for (const id of ['#bar-avatar', '#menu-avatar', '#composer-avatar', '#me-avatar']) ring($(id), st);
  for (const box of $$('.status-control')) {
    box.replaceChildren();
    if (st?.source === 'calendar') { // busy because of your calendar: a status you set replaces it
      const on = el('span', 'status-on busy', `📅 Busy · ${timeLeft(st.until)}`);
      on.title = 'From your calendar. Set your own status to replace it.';
      box.append(on);
      for (const [status, label] of [['free', 'Free anyway'], ['busy', 'Busy']]) {
        const b = el('button', `status-tap ${status}`, label);
        b.type = 'button';
        b.title = `${status === 'free' ? 'Free' : 'Busy'} for the next ${STATUS_HOURS} hours, instead of what your calendar says`;
        b.onclick = () => setStatus(status);
        box.append(b);
      }
    } else if (st) {
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
  return feed.inbox.length + invites.length + requests.incoming.length + notices.length;
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

// The greeting over the feed: time of day, then what's worth doing (plans waiting, friends free, today's calendar)
function renderHello() {
  const now = new Date(), h = now.getHours();
  const part = h < 5 ? 'Up late' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : h < 22 ? 'Good evening' : 'Up late';
  $('#hello-date').textContent = now.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
  $('#hello-title').textContent = `${part}, ${(me.display_name || '').split(' ')[0] || 'friend'}`;
  const free = (feed.free_now || []).length, today = feed.today.length, waiting = inboxCount();
  const bits = [];
  if (waiting) bits.push(waiting === 1 ? '1 thing is waiting on you' : `${waiting} things are waiting on you`);
  if (free) bits.push(free === 1 ? '1 friend is free right now' : `${free} friends are free right now`);
  if (today) bits.push(today === 1 ? '1 thing on the calendar today' : `${today} things on the calendar today`);
  $('#hello-sub').textContent = bits.length ? `${bits.join(' · ')}.` : "It's a quiet day in town. Share something and see who bites.";
}

// Home: the greeting, your towns, the latest few things, and today's rail
function showHome() {
  renderMyStatus();
  renderFeed();
  show('home');
  refreshAll();
}

// Feed: the composer, then everything from your towns and friends, filterable by kind
function showFeed({ write = false } = {}) {
  paintAvatar($('#composer-avatar'), me);
  renderMyStatus();
  $('#composer-open').textContent = `What's new, ${(me.display_name || '').split(' ')[0] || 'friend'}?`;
  renderFeed();
  show('feed');
  refreshAll();
  if (write) $('#composer-open').click();
  else if (!$('#composer-ideas').children.length) loadIdeas(); // fetch ideas early so the composer opens with them
}

$('#hello-post').onclick = () => {
  if (location.hash === '#/feed') return showFeed({ write: true });
  skipNextRoute = true; // show it here instead of letting the hash route, so the composer opens
  location.hash = '#/feed';
  lastHash = location.hash;
  lastRouted = 'feed/';
  scrollTo(0, 0);
  showFeed({ write: true });
};

// Which kinds of feed items the Feed tab shows (chips over the list)
const FEED_FILTERS = { all: null, post: ['post'], news: ['news'], around: ['chat', 'social'], plan: ['plan'] };
let feedFilter = 'all';
for (const b of $$('#feed-filters [data-filter]')) {
  b.onclick = () => {
    feedFilter = b.dataset.filter;
    for (const x of $$('#feed-filters [data-filter]')) x.setAttribute('aria-checked', String(x === b));
    renderFeed();
  };
}

// Pinned towns come first everywhere. Saved on your account (Supabase user metadata), so pins follow you to
// other devices; no table needed for a per-person preference like this.
let pinned = new Set();
async function loadPins() {
  try {
    const { data } = await sb.auth.getUser();
    pinned = new Set(data.user?.user_metadata?.pinned_towns || []);
  } catch { pinned = new Set(); }
}
async function togglePin(t) {
  const was = pinned.has(t.id);
  was ? pinned.delete(t.id) : pinned.add(t.id);
  renderFeed();
  renderProfile();
  try {
    const { error } = await sb.auth.updateUser({ data: { pinned_towns: [...pinned] } });
    if (error) throw error;
    toast(was ? `Unpinned ${t.name}` : `Pinned ${t.name}`);
  } catch (err) {
    was ? pinned.add(t.id) : pinned.delete(t.id); // put it back if it didn't save
    renderFeed();
    renderProfile();
    toast(err.message || "Couldn't save that pin", 'error');
  }
}
const byPinned = (list, id = (x) => x.id) => [...list].sort((a, b) => pinned.has(id(b)) - pinned.has(id(a)));

// Filter your towns by name or by who lives there
let townQuery = '';
const townMatches = (t) => {
  const q = townQuery.trim().toLowerCase();
  return !q || t.name.toLowerCase().includes(q) || (t.residents || []).some((p) => (p.name || '').toLowerCase().includes(q));
};
$('#town-search').oninput = (e) => {
  townQuery = e.target.value;
  $('#town-cards').scrollLeft = 0;
  renderFeed();
};

function renderFeed() {
  if (!me) return;
  // Town cards: from the feed summary when it has loaded, else just names from /me
  const summaries = feed.towns.length ? feed.towns : townsIn().map((m) => ({ id: m.towns.id, name: m.towns.name, residents: [], headline: null, new: 0 }));
  const strip = $('#town-cards'), scrolled = strip.scrollLeft;
  const create = el('button', 'town-card create-tile');
  create.type = 'button';
  create.append(el('span', 'plus', '+'), el('span', '', 'Create a town'), el('span', 'hint', 'Describe it and invite friends'));
  create.onclick = () => $('#create-town').click();
  const shown = byPinned(summaries.filter(townMatches));
  strip.replaceChildren(...shown.map(townCard), ...(townQuery.trim() ? [] : [create]));
  strip.scrollLeft = scrolled;
  $('#no-towns').hidden = summaries.length > 0;
  $('#town-cards').hidden = !shown.length;
  $('#town-search-wrap').hidden = summaries.length < 2;
  const none = $('#no-town-matches');
  none.hidden = !(summaries.length && !shown.length);
  none.textContent = `No towns match "${townQuery.trim()}".`;

  // Keep your place in a comment you're typing when the feed refreshes under you
  const typing = document.activeElement?.dataset?.commentFor;
  const kinds = FEED_FILTERS[feedFilter];
  const shownItems = kinds ? feed.items.filter((it) => kinds.includes(it.kind)) : feed.items;
  $('#feed').replaceChildren(...shownItems.map(post));
  if (typing) document.querySelector(`[data-comment-for="${typing}"]`)?.focus();
  $('#feed-empty').hidden = feed.items.length > 0;
  $('#feed-none').hidden = !(feed.items.length && !shownItems.length);
  renderLatest();

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
  renderMyStatus(); // your calendar may have made you busy since the last refresh
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
  renderHello();
}

// Home's peek at the feed: the newest few items as one-line rows; tapping one opens the Feed tab
const KIND_ICON = { post: '✏️', news: '📣', chat: '💬', social: '👋', plan: '📅' };
function renderLatest() {
  const items = feed.items.slice(0, 4);
  $('#latest').replaceChildren(...items.map((it) => {
    const li = el('li');
    li.append(it.kind === 'post' && it.actor ? personAvatar(it.actor) : el('span', `latest-icon ${hueOf(it.town?.id)}`, KIND_ICON[it.kind] || '✨'));
    const body = el('div', 'latest-body');
    const line = it.kind === 'post' ? `${it.mine ? 'You' : it.actor?.name || 'Someone'}: ${it.text}` : it.title || it.text || '';
    body.append(el('div', 'latest-text', line), el('div', 'handle', [it.town?.name, it.at && timeAgo(it.at)].filter(Boolean).join(' · ')));
    li.append(body);
    li.onclick = () => { location.hash = '#/feed'; };
    return li;
  }));
  $('#latest-card').hidden = !items.length;
}

const PIN_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 17v5"/><path d="M5 17h14v-1.8a2 2 0 0 0-1.1-1.8l-1.8-.9A2 2 0 0 1 15 10.8V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.8a2 2 0 0 1-1.1 1.8l-1.8.9A2 2 0 0 0 5 15.2Z"/></svg>';

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
  // Pin and invite sit in the banner's corner. Not <button>s: the whole card is one
  const town = townsIn().find((m) => m.towns.id === t.id)?.towns;
  const tools = el('div', 'card-tools');
  const tool = (cls, label, act) => {
    const x = el('span', `card-tool ${cls}`);
    x.setAttribute('role', 'button');
    x.setAttribute('aria-label', label);
    x.title = label;
    x.tabIndex = 0;
    const go = (e) => { e.stopPropagation(); e.preventDefault(); act(); };
    x.onclick = go;
    x.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') go(e); };
    tools.append(x);
    return x;
  };
  const isPinned = pinned.has(t.id);
  const pin = tool(`pin${isPinned ? ' on' : ''}`, isPinned ? `Unpin ${t.name}` : `Pin ${t.name}`, () => togglePin(t));
  pin.setAttribute('aria-pressed', String(isPinned));
  pin.innerHTML = PIN_SVG;
  if (town?.created_by === me.id) tool('invite-plus', `Invite friends to ${t.name}`, () => inviteFriends.open(town)); // creator only
  banner.append(tools);
  body.append(enter);
  b.append(banner, body);
  b.onclick = () => enterTown(t.id);
  return b;
}

const ACTION_TAGS = { chat: '💬', visit: '👋', knock: '🚪', leave_gift: '🎁', propose_event: '📅' };

// A post someone wrote: their words as written, who it went to, and a way toward them
function writtenPost(item) {
  const card = el('article', `card post ${item.audience === 'private' ? 'private' : ''}`);
  const head = el('div', 'post-head');
  const icon = el('div', 'kind-icon');
  icon.append(personAvatar(item.actor));
  const who = el('div', 'who');
  who.append(el('div', 'title', item.mine ? `${item.actor.name} (you)` : item.actor.name));
  const meta = el('div', 'meta');
  if (item.audience === 'town') {
    const town = el('a', 'audience', `🏘️ ${item.town.name}`);
    town.href = `../town/?town=${encodeURIComponent(item.town.id)}`;
    meta.append(town);
  } else meta.append(el('span', 'audience', item.audience === 'private' ? '🔒 Only you' : '👥 Friends'));
  meta.append(' · ', el('span', '', timeAgo(item.at)));
  who.append(meta);
  head.append(icon, who);
  card.append(head, el('p', 'text written', item.text));
  if (item.audience === 'private') {
    card.append(el('p', 'hint', "Only your towns' AI read this. Your character's mood may change; nobody sees these words."));
    return card;
  }
  if (!item.mine) who.firstChild.dataset.person = item.actor.user_id; // the name opens their profile too
  const redraw = () => card.replaceWith(writtenPost(item));
  const reactions = item.reactions || [];
  const total = reactions.reduce((n, r) => n + r.count, 0);
  const comments = item.comments || [];
  if (total || comments.length) {
    const summary = el('div', 'post-summary');
    const emojis = el('span', 'reaction-summary');
    if (total) emojis.append(el('span', 'emojis', reactions.slice(0, 3).map((r) => r.emoji).join('')), ` ${total}`);
    summary.append(emojis);
    if (comments.length) {
      const count = el('button', 'link', `${comments.length} ${comments.length === 1 ? 'comment' : 'comments'}`);
      count.type = 'button';
      count.onclick = () => { openComments.add(item.id); redraw(); };
      summary.append(count);
    }
    card.append(summary);
  }
  const actions = el('div', 'post-actions');
  const like = el('button', `react${item.my_reaction ? ' on' : ''}`, item.my_reaction ? `${item.my_reaction} ${REACTION_NAMES[item.my_reaction] || 'Liked'}` : '🤍 Like');
  like.type = 'button';
  like.title = 'Like, or hold for more reactions';
  like.setAttribute('aria-pressed', String(!!item.my_reaction));
  const picker = el('div', 'reaction-picker');
  picker.hidden = true;
  picker.setAttribute('role', 'toolbar');
  picker.setAttribute('aria-label', 'Reactions');
  for (const emoji of REACTIONS) {
    const b = el('button', emoji === item.my_reaction ? 'on' : '', emoji);
    b.type = 'button';
    b.title = REACTION_NAMES[emoji];
    b.onclick = (e) => { e.stopPropagation(); react(item, emoji === item.my_reaction ? null : emoji, redraw); };
    picker.append(b);
  }
  // Tap = like (or take back your reaction); hold, right-click or hover a moment = pick a reaction
  let held = false, holdTimer, hoverTimer;
  const openPicker = () => { held = true; picker.hidden = false; };
  like.onpointerdown = () => { held = false; holdTimer = setTimeout(openPicker, 450); };
  like.onpointerup = like.onpointerleave = () => clearTimeout(holdTimer);
  like.oncontextmenu = (e) => { e.preventDefault(); openPicker(); };
  like.onclick = () => { if (held) return; react(item, item.my_reaction ? null : '❤️', redraw); };
  const wrap = el('div', 'react-wrap');
  wrap.onpointerenter = (e) => { if (e.pointerType !== 'touch') hoverTimer = setTimeout(openPicker, 600); };
  wrap.onpointerleave = () => { clearTimeout(hoverTimer); picker.hidden = true; };
  wrap.append(picker, like);
  const comment = el('button', '', '💬 Comment');
  comment.type = 'button';
  comment.onclick = () => { openComments.add(item.id); redraw(); document.querySelector(`[data-comment-for="${item.id}"]`)?.focus(); };
  actions.append(wrap, comment);
  if (item.audience === 'town') {
    const visit = el('button', '', `🏘️ Visit ${item.town.name}`);
    visit.type = 'button';
    visit.onclick = () => enterTown(item.town.id);
    actions.append(visit);
  }
  card.append(actions);
  if (comments.length || openComments.has(item.id)) card.append(commentThread(item, redraw));
  return card;
}

const REACTIONS = ['❤️', '😂', '🎉', '😮', '😢', '👏']; // matches backend/posts.py REACTIONS
const REACTION_NAMES = { '❤️': 'Liked', '😂': 'Haha', '🎉': 'Yay', '😮': 'Wow', '😢': 'Sad', '👏': 'Proud' };
const openComments = new Set(); // posts whose whole comment thread is shown
const commentDrafts = new Map(); // post id -> what you've typed so far (survives the feed refreshing)
const signalId = (item) => item.id.replace(/^post:/, '');

// emoji = null takes your reaction back. Shows the change right away and puts it back if the request fails.
async function react(item, emoji, redraw) {
  const before = { reactions: item.reactions, my_reaction: item.my_reaction };
  const counts = new Map((item.reactions || []).map((r) => [r.emoji, r.count]));
  if (item.my_reaction) counts.set(item.my_reaction, counts.get(item.my_reaction) - 1);
  if (emoji) counts.set(emoji, (counts.get(emoji) || 0) + 1);
  item.reactions = [...counts].filter(([, n]) => n > 0).map(([e, n]) => ({ emoji: e, count: n })).sort((a, b) => b.count - a.count);
  item.my_reaction = emoji;
  redraw();
  try {
    const path = `/posts/${signalId(item)}/reaction`;
    Object.assign(item, emoji ? await api(path, { method: 'PUT', body: { emoji } }) : await api(path, { method: 'DELETE' }));
  } catch (err) {
    Object.assign(item, before);
    toast(err.message, 'error');
  }
  redraw();
}

// Comments under a post: the latest two until you open the thread, then all of them and a box to add yours
function commentThread(item, redraw) {
  const wrap = el('div', 'comments');
  const all = item.comments || [];
  const open = openComments.has(item.id);
  const shown = open ? all : all.slice(-2);
  if (shown.length < all.length) {
    const more = el('button', 'link more-comments', `View all ${all.length} comments`);
    more.type = 'button';
    more.onclick = () => { openComments.add(item.id); redraw(); };
    wrap.append(more);
  }
  for (const c of shown) {
    const row = el('div', 'comment');
    const body = el('div', 'comment-body');
    const bubble = el('div', 'bubble');
    const name = el('b', '', c.mine ? 'You' : c.author.name);
    if (!c.mine) name.dataset.person = c.author.user_id;
    bubble.append(name, el('span', 'comment-text', c.text));
    const meta = el('div', 'comment-meta');
    meta.append(el('span', '', timeAgo(c.at)));
    if (c.can_delete) {
      const del = el('button', 'link', 'Delete');
      del.type = 'button';
      del.onclick = async () => {
        if (!await confirmDialog({ title: 'Delete this comment?', body: c.text, confirmLabel: 'Delete', danger: true })) return;
        const keep = item.comments;
        item.comments = keep.filter((x) => x.id !== c.id);
        redraw();
        try { await api(`/posts/${signalId(item)}/comments/${c.id}`, { method: 'DELETE' }); }
        catch (err) { item.comments = keep; redraw(); toast(err.message, 'error'); }
      };
      meta.append(' · ', del);
    }
    body.append(bubble, meta);
    row.append(personAvatar(c.author), body);
    wrap.append(row);
  }
  if (open || !all.length) {
    const form = el('form', 'comment-form');
    const input = el('input');
    input.placeholder = item.mine ? 'Reply to your friends…' : `Write something to ${item.actor.name}…`;
    input.maxLength = 500;
    input.value = commentDrafts.get(item.id) || '';
    input.dataset.commentFor = item.id;
    input.setAttribute('aria-label', 'Write a comment');
    input.oninput = () => { commentDrafts.set(item.id, input.value); send.disabled = !input.value.trim(); };
    const send = el('button', 'small', 'Send');
    send.type = 'submit';
    send.disabled = !input.value.trim();
    form.onsubmit = async (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      send.disabled = input.disabled = true;
      try {
        const c = await api(`/posts/${signalId(item)}/comments`, { method: 'POST', body: { text } });
        item.comments = [...(item.comments || []), c];
        commentDrafts.delete(item.id);
        redraw();
        document.querySelector(`[data-comment-for="${item.id}"]`)?.focus();
      } catch (err) {
        send.disabled = input.disabled = false;
        toast(err.message, 'error');
      }
    };
    const self = el('div', 'avatar sm');
    paintAvatar(self, me);
    form.append(self, input, send);
    wrap.append(form);
  }
  return wrap;
}

function post(item) {
  if (item.kind === 'post') return writtenPost(item);
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

// Composer: posting is the opt-in. Pick who it's for: one town, all your friends, or private (only your
// towns' AI reads it, and all it may do is change your character's mood). Idea chips come from the AI.
const AUDIENCE_HINT = {
  friends: 'All your friends see this on their feed, in any town.',
  private: "🔒 Nobody sees this. Your towns' AI reads it and may change your character's mood (like rain over your house), never what you wrote.",
};

// "Post to" menu: each town you're in, all your friends, or private
let audience = 'friends';

function audienceOptions() {
  return [
    ...townsIn().map((m) => ({ value: `town:${m.towns.id}`, icon: '🏘️', title: m.towns.name, desc: `Only people in ${m.towns.name}` })),
    { value: 'friends', icon: '👥', title: 'All my friends', desc: 'Your friends in any town', divider: true },
    { value: 'private', icon: '🔒', title: 'Private', desc: "Only changes your character's mood" },
  ];
}

function fillAudiences() {
  const opts = audienceOptions();
  if (!opts.some((o) => o.value === audience)) audience = 'friends';
  const menu = $('#audience-menu');
  menu.replaceChildren(el('div', 'menu-title', 'Who sees this?'));
  for (const o of opts) {
    if (o.divider) menu.append(el('hr'));
    const b = el('button');
    b.type = 'button';
    b.setAttribute('role', 'option');
    b.setAttribute('aria-selected', String(o.value === audience));
    const text = el('span');
    text.append(el('b', '', o.title), el('span', 'hint', o.desc));
    b.append(el('span', 'well', o.icon), text, el('span', 'check'));
    b.onclick = () => { audience = o.value; fillAudiences(); closeAudienceMenu(); $('#composer-text').focus(); };
    menu.append(b);
  }
  const cur = opts.find((o) => o.value === audience);
  $('#audience-icon').textContent = cur.icon;
  $('#audience-current').textContent = cur.title;
  showAudienceHint();
}

function showAudienceHint() {
  const town = audience.startsWith('town:') && townsIn().find((m) => `town:${m.towns.id}` === audience);
  $('#composer-audience-hint').textContent = town ? `Only people in ${town.towns.name} see this.` : AUDIENCE_HINT[audience] || '';
}

function closeAudienceMenu() {
  $('#audience-menu').hidden = true;
  $('#audience-btn').setAttribute('aria-expanded', 'false');
}
$('#audience-btn').onclick = (e) => {
  e.stopPropagation();
  const open = $('#audience-menu').hidden;
  $('#audience-menu').hidden = !open;
  $('#audience-btn').setAttribute('aria-expanded', String(open));
  if (open) $('#audience-menu [aria-selected="true"]')?.focus();
};
document.addEventListener('click', (e) => { if (!e.target.closest('.audience-picker')) closeAudienceMenu(); });
$('#audience-menu').onkeydown = (e) => {
  const items = $$('#audience-menu [role="option"]');
  const i = items.indexOf(document.activeElement);
  if (e.key === 'Escape') { closeAudienceMenu(); $('#audience-btn').focus(); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
};

const calmMotion = matchMedia('(prefers-reduced-motion: reduce)');

// Swap the idea chips with motion: the old ones drift up and fade (one after another), the row eases to its
// new height, and the new ones rise in. While waiting, chips (or placeholders on first load) shimmer.
async function swapIdeas(box, chips) {
  const old = [...box.children];
  if (!calmMotion.matches && old.length) {
    await Promise.all(old.map((c, i) => c.animate(
      [{ opacity: 1, transform: 'none', filter: 'blur(0)' }, { opacity: 0, transform: 'translateY(-6px) scale(.96)', filter: 'blur(2px)' }],
      { duration: 160, delay: i * 35, easing: 'ease-in', fill: 'forwards' }).finished));
  }
  const from = box.offsetHeight;
  box.replaceChildren(...chips);
  if (calmMotion.matches) return;
  const to = box.offsetHeight;
  if (from && from !== to) {
    box.style.overflow = 'hidden'; // only while the height eases, so focus rings aren't clipped otherwise
    box.animate([{ height: `${from}px` }, { height: `${to}px` }], { duration: 220, easing: 'cubic-bezier(.2,.8,.2,1)' })
      .finished.then(() => { box.style.overflow = ''; });
  }
  chips.forEach((c, i) => c.animate(
    [{ opacity: 0, transform: 'translateY(8px) scale(.94)', filter: 'blur(2px)' }, { opacity: 1, transform: 'none', filter: 'blur(0)' }],
    { duration: 320, delay: 60 + i * 55, easing: 'cubic-bezier(.2,.9,.3,1.2)', fill: 'backwards' }));
}

async function loadIdeas(refresh = false) {
  const box = $('#composer-ideas');
  const more = $('#composer-more-ideas');
  if (box.classList.contains('loading')) return;
  box.classList.add('loading');
  more.classList.add('spinning');
  more.disabled = true;
  if (!box.children.length) box.replaceChildren(...[64, 92, 76].map((w) => { const s = el('span', 'idea-ghost'); s.style.width = `${w}px`; return s; }));
  const local = new Date().toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  // On ↻, tell the backend what's on screen so it comes back with different ideas
  const avoid = refresh ? $$('#composer-ideas button').map((b) => `&avoid=${encodeURIComponent(b.textContent)}`).join('') : '';
  try {
    const { ideas } = await api(`/me/post-ideas?local_time=${encodeURIComponent(local)}${refresh ? '&refresh=true' : ''}${avoid}`);
    box.classList.remove('loading');
    await swapIdeas(box, ideas.map((idea) => {
      const b = el('button', '', idea.label);
      b.type = 'button';
      if (idea.why) b.title = idea.why;
      b.onclick = () => {
        const t = $('#composer-text');
        t.value = idea.starter;
        t.focus();
        t.setSelectionRange(t.value.length, t.value.length);
      };
      return b;
    }));
  } catch {
    box.classList.remove('loading');
    if (!refresh || box.querySelector('.idea-ghost')) box.replaceChildren();
  }
  more.classList.remove('spinning');
  more.disabled = false;
}
$('#composer-more-ideas').onclick = () => loadIdeas(true);

function closeComposer() {
  closeAudienceMenu();
  $('#composer').classList.remove('writing');
  $('#composer-form').hidden = true;
  $('#composer-open').hidden = false;
  $('#composer-text').value = '';
}

$('#composer-open').onclick = () => {
  fillAudiences();
  $('#composer').classList.add('writing');
  $('#composer-form').hidden = false;
  $('#composer-open').hidden = true;
  $('#composer-text').focus();
  if (!$('#composer-ideas').children.length) loadIdeas(); // usually already fetched when the feed opened
};
$('#composer-cancel').onclick = closeComposer;
$('#composer-form').onsubmit = async (e) => {
  e.preventDefault();
  const text = $('#composer-text').value.trim();
  if (!text) return toast('Write something first, or tap an idea.', 'error');
  const choice = audience;
  const value = { text, audience: choice.startsWith('town:') ? 'town' : choice };
  if (choice.startsWith('town:')) value.town_id = choice.slice(5);
  const btn = $('#composer-share');
  busy(btn, true, 'Posting…');
  try {
    await api('/signals', { method: 'POST', body: { source: 'manual', type: 'post', value } });
    closeComposer();
    toast(value.audience === 'private' ? 'Saved privately. Your character may change; nobody sees what you wrote.'
      : value.audience === 'town' ? 'Posted to your town.' : 'Posted to your friends.');
    refreshAll();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    busy(btn, false, 'Post');
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
  $('#notices').replaceChildren(...notices.map((n) => {
    const li = el('li');
    const who = el('div', 'who');
    const p = n.payload || {};
    const comment = n.kind === 'post_comment', mail = n.kind === 'mail';
    const text = n.kind === 'town_deleted' ? `${p.by_name || 'Its creator'} deleted ${p.town_name || 'a town'} you were in`
      : comment ? `${p.by_name || 'Someone'} commented: “${p.text || ''}”`
      : mail ? `${p.by_name || 'Someone'} left you a note: “${p.text || ''}”` : 'Something changed';
    const sub = comment ? (p.post_text ? `on “${p.post_text}”` : 'on your post')
      : mail ? `in your mailbox in ${p.town_name || 'town'}` : 'its houses, characters and plans are gone';
    who.append(el('div', 'name', text), el('div', 'handle', `${timeAgo(n.created_at)} · ${sub}`));
    if ((comment || mail) && p.by_user_id) li.dataset.person = p.by_user_id;
    const dismiss = el('button', 'small', 'Dismiss');
    dismiss.type = 'button';
    dismiss.onclick = async () => {
      dismiss.disabled = true;
      try { await api(`/me/notifications/${n.id}`, { method: 'DELETE' }); } catch (err) { toast(err.message, 'error'); }
      notices = notices.filter((x) => x.id !== n.id);
      renderInbox();
    };
    const icon = n.kind === 'town_deleted' ? '🏚️' : comment ? '💬' : mail ? '📬' : '🔔';
    const actions = [dismiss];
    if (mail && p.town_id) { // open the town to read it in the mailbox
      const open = el('button', 'small', 'Open mailbox');
      open.type = 'button';
      open.onclick = () => enterTown(p.town_id);
      actions.unshift(open);
    }
    li.append(el('div', 'notice-icon', icon), who, ...actions);
    return li;
  }));
  $('#notices-section').hidden = !notices.length;
  $('#notice-count').textContent = notices.length;
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
  renderSuggestions();
}

// People you may know. "Hide" is remembered in this browser only.
const HIDDEN_SUGGESTIONS = 'luma-hidden-suggestions';
const hiddenSuggestions = () => { try { return new Set(JSON.parse(localStorage.getItem(HIDDEN_SUGGESTIONS)) || []); } catch { return new Set(); } };

function whyYouMayKnow(s) {
  const names = s.mutual_friends.map((f) => f.display_name).filter(Boolean);
  const more = s.mutual_count - names.length;
  const friendsNote = !s.mutual_count ? ''
    : names.length === 1 && !more ? `Friends with ${names[0]}`
    : names.length ? `Friends with ${names.slice(0, 2).join(', ')}${s.mutual_count > 2 ? ` +${s.mutual_count - 2}` : ''}`
    : `${s.mutual_count} mutual friend${s.mutual_count === 1 ? '' : 's'}`;
  const townNote = s.shared_towns.length ? `in ${s.shared_towns.slice(0, 2).join(', ')}${s.shared_towns.length > 2 ? ' +' + (s.shared_towns.length - 2) : ''}` : '';
  return [friendsNote, townNote].filter(Boolean).join(' · ');
}

function renderSuggestions() {
  const hidden = hiddenSuggestions();
  const shown = suggestions.filter((s) => !hidden.has(s.id));
  fillList($('#suggestions'), shown.map((s) => personRow(s, [
    ['Add', async () => {
      await api('/friends/requests', { method: 'POST', body: { username: s.username } });
      toast(`Friend request sent to ${s.display_name || '@' + s.username}.`);
    }, 'primary'],
    ['Hide', () => {
      hidden.add(s.id);
      try { localStorage.setItem(HIDDEN_SUGGESTIONS, JSON.stringify([...hidden])); } catch { /* storage blocked: hidden until reload */ }
      suggestions = suggestions.filter((x) => x.id !== s.id);
    }],
  ], whyYouMayKnow(s))));
  $('#suggest-section').hidden = !shown.length;
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

// Profiles open instantly when they can: ones you opened recently are remembered (and refreshed behind the
// scenes), and pointing at someone starts loading theirs before the click lands.
const PROFILE_FRESH_MS = 60_000;
const profileCache = new Map(); // id -> { data, at }
const profileLoads = new Map(); // id -> in-flight request
function loadProfile(id) {
  if (profileLoads.has(id)) return profileLoads.get(id);
  const req = api(`/users/${encodeURIComponent(id)}/profile`)
    .then((data) => { profileCache.set(id, { data, at: Date.now() }); return data; })
    .finally(() => profileLoads.delete(id));
  profileLoads.set(id, req);
  return req;
}
function prefetchProfile(id) {
  const hit = profileCache.get(id);
  if (!id || id === me?.id || (hit && Date.now() - hit.at < PROFILE_FRESH_MS)) return;
  loadProfile(id).catch(() => {}); // a failed warm-up is fine; opening the profile tries again
}
document.addEventListener('pointerover', (e) => prefetchProfile(e.target.closest?.('[data-person]')?.dataset.person), { passive: true });

// What the tapped row already shows (name and avatar), so the header appears before the profile arrives
let personHint = null;

async function showPerson(id, { refresh = false } = {}) {
  personId = id;
  const hit = refresh ? null : profileCache.get(id);
  if (!refresh) {
    show('person');
    scrollTo(0, 0);
    if (hit) renderPerson(hit.data);
    else {
      $('#p-name').textContent = personHint?.id === id ? personHint.name : '';
      $('#p-handle').textContent = '';
      const avatar = $('#p-avatar');
      if (personHint?.id === id && personHint.avatar) {
        avatar.style.cssText = personHint.avatar.style.cssText;
        avatar.textContent = personHint.avatar.textContent;
        avatar.className = 'avatar lg';
        if (personHint.avatar.classList.contains('has-photo')) avatar.classList.add('has-photo');
      } else { avatar.textContent = ''; avatar.style.cssText = ''; avatar.className = 'avatar lg'; }
      for (const c of ['#p-you-card', '#p-interests-card', '#p-towns-card', '#p-mutual-card', '#p-stranger']) $(c).hidden = true;
      $('#p-actions').replaceChildren();
      $('#p-bio').textContent = '';
      $('#p-stats').textContent = '';
      $('#p-status').replaceChildren();
      $('#view-person').classList.add('loading');
    }
    if (hit && Date.now() - hit.at < PROFILE_FRESH_MS) return; // fresh enough; no need to ask again
  }
  let p;
  try { p = await (refresh ? (profileLoads.get(id) || loadProfile(id)) : loadProfile(id)); } catch (err) {
    if (personId !== id) return;
    $('#view-person').classList.remove('loading');
    if (!hit) $('#p-name').textContent = err.status === 404 ? 'No one here' : "Couldn't load this profile";
    return toast(err.message, 'error');
  }
  if (personId !== id) return; // navigated away while loading
  $('#view-person').classList.remove('loading');
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
      try { await fn(); profileCache.delete(p.id); await refreshAll(); showPerson(p.id, { refresh: true }); } catch (err) { toast(err.message, 'error'); b.disabled = false; }
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

  if (p.status) $('#p-status').replaceChildren(el('span', `status-on ${p.status.status}`, `${p.status.source === 'calendar' ? '📅 ' : ''}${STATUS_LABEL[p.status.status]} · ${timeLeft(p.status.until)}`));
  $('#p-bio').textContent = p.bio;
  $('#p-bio').hidden = !p.bio;
  renderSocials($('#p-socials'), p.socials);
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

// ---- Profile schedule: the signed-in person's week, with add and remove ---------------------------
let schedule = null;
let scheduleOffset = 0;
let scheduleAdding = null; // YYYY-MM-DD whose add form is open
let scheduleTicket = 0;
const PLACE_FOR_KIND = { class: 'university', work: 'downtown', social: 'cafe', activity: 'gym', appointment: 'library' };

function localDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function parseDay(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function defaultTimes(date) {
  if (date !== localDate()) return ['09:00', '10:00'];
  const hour = new Date().getHours() + 1;
  if (hour > 22) return ['21:00', '22:00'];
  const p = (n) => String(n).padStart(2, '0');
  return [`${p(hour)}:00`, `${p(hour + 1)}:00`];
}

function scheduleWhen(startIso, endIso) {
  const s = new Date(startIso), e = new Date(endIso);
  const hm = (d) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const period = (d) => (d.getHours() < 12 ? 'AM' : 'PM');
  if (period(s) === period(e)) return `${hm(s).replace(/\s*(AM|PM)$/i, '')}–${hm(e)}`;
  return `${hm(s)}–${hm(e)}`;
}

function scheduleMeta(item) {
  if (item.source === 'google') return 'Google Calendar';
  const kind = (schedule?.kinds || []).find((k) => k.id === item.kind)?.label;
  return [kind, item.place].filter(Boolean).join(' · ');
}

function renderSchedule() {
  const range = $('#sched-range');
  $('#sched-today').hidden = scheduleOffset === 0;
  if (!schedule) {
    range.textContent = 'This week';
    return;
  }
  const fmt = (iso) => parseDay(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
  range.textContent = schedule.offset === 0 ? 'This week' : `${fmt(schedule.week_start)} – ${fmt(schedule.week_end)}`;
  range.title = schedule.offset === 0 ? `${fmt(schedule.week_start)} – ${fmt(schedule.week_end)}` : '';
  const canAdd = townsIn().length > 0;
  if (!canAdd && !schedule.days.some((d) => d.items.length)) {
    $('#sched-days').replaceChildren(el('p', 'empty', 'Join a town and your week shows up here. What you add is where your character goes.'));
    return;
  }
  const now = new Date();
  const today = localDate();
  $('#sched-days').replaceChildren(...schedule.days.map((day) => {
    const block = el('section', `sched-day${day.date === today ? ' today' : ''}`);
    const head = el('div', 'sched-head');
    const when = el('div', 'sched-when');
    when.append(day.date === today ? 'Today' : day.weekday, el('span', '', fmt(day.date)));
    head.append(when);
    if (canAdd) {
      const add = el('button', 'small tonal', scheduleAdding === day.date ? 'Close' : 'Add');
      add.type = 'button';
      add.onclick = () => {
        scheduleAdding = scheduleAdding === day.date ? null : day.date;
        renderSchedule();
        if (scheduleAdding) $('#sched-title')?.focus();
      };
      head.append(add);
    }
    block.append(head);
    if (!day.items.length) block.append(el('p', 'sched-empty', 'Nothing yet'));
    else {
      const list = el('ul', 'sched');
      for (const item of [...day.items].sort((a, b) => (a.start < b.start ? -1 : 1))) {
        const li = el('li');
        const start = new Date(item.start), end = new Date(item.end);
        if (end < now) li.classList.add('past');
        else if (start <= now) li.classList.add('now');
        if (item.source === 'google') li.title = 'From Google Calendar. Remove it there and it leaves on the next sync.';
        li.append(el('time', '', scheduleWhen(item.start, item.end)));
        const body = el('div');
        body.append(el('div', 'sched-title', item.title || 'Busy'));
        const meta = scheduleMeta(item);
        if (meta) body.append(el('div', 'sched-meta', meta));
        li.append(body);
        if (item.removable) {
          const remove = el('button', 'small danger', 'Remove');
          remove.type = 'button';
          remove.onclick = () => removeScheduleItem(item, remove);
          li.append(remove);
        }
        list.append(li);
      }
      block.append(list);
    }
    if (scheduleAdding === day.date) block.append(scheduleForm(day.date));
    return block;
  }));
}

function scheduleForm(date) {
  const [start, end] = defaultTimes(date);
  const form = el('form', 'sched-form');
  form.id = 'sched-form';
  const title = el('input');
  title.id = 'sched-title';
  Object.assign(title, { required: true, maxLength: 120, placeholder: 'Class, gym, dinner…', autocomplete: 'off' });
  const times = el('div', 'sched-row');
  const startIn = Object.assign(el('input'), { type: 'time', required: true, value: start });
  startIn.setAttribute('aria-label', 'Start');
  const endIn = Object.assign(el('input'), { type: 'time', required: true, value: end });
  endIn.setAttribute('aria-label', 'End');
  times.append(startIn, endIn);
  const picks = el('div', 'sched-row');
  const kind = el('select');
  kind.setAttribute('aria-label', 'Kind');
  for (const k of schedule.kinds || []) kind.append(Object.assign(el('option', '', k.label), { value: k.id }));
  kind.value = 'activity';
  const place = el('select');
  place.setAttribute('aria-label', 'Place');
  for (const p of schedule.places || []) place.append(Object.assign(el('option', '', p.label), { value: p.id }));
  place.value = PLACE_FOR_KIND.activity;
  kind.onchange = () => { if (!place.dataset.touched) place.value = PLACE_FOR_KIND[kind.value] || 'home'; };
  place.onchange = () => { place.dataset.touched = '1'; };
  picks.append(kind, place);
  const actions = el('div', 'sched-row');
  const save = el('button', 'primary small', 'Add to this day');
  save.type = 'submit';
  const cancel = el('button', 'small', 'Cancel');
  cancel.type = 'button';
  cancel.onclick = () => { scheduleAdding = null; renderSchedule(); };
  actions.append(save, cancel);
  form.append(title, times, picks, actions);
  form.onsubmit = async (e) => {
    e.preventDefault();
    const name = title.value.trim();
    message($('#sched-msg'), '');
    if (!name) return message($('#sched-msg'), 'Add a name for it.');
    if (endIn.value <= startIn.value) return message($('#sched-msg'), 'The end has to be after the start.');
    busy(save, true, 'Adding…');
    try {
      const hhmm = (v) => v.slice(0, 5);
      schedule = await api('/me/schedule', {
        method: 'POST', body: { title: name, kind: kind.value, date, start: hhmm(startIn.value), end: hhmm(endIn.value), place: place.value },
      });
      scheduleOffset = schedule.offset ?? scheduleOffset;
      scheduleAdding = null;
      renderSchedule();
      toast('Added to your week');
    } catch (err) {
      message($('#sched-msg'), err.message);
      busy(save, false, 'Add to this day');
    }
  };
  return form;
}

async function removeScheduleItem(item, button) {
  const ok = await confirmDialog({
    title: 'Remove this?',
    body: `${item.title} comes off your week, and your character stops heading there.`,
    confirmLabel: 'Remove', danger: true,
  });
  if (!ok) return;
  busy(button, true, '…');
  try {
    await api(`/me/schedule/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
    scheduleAdding = null;
    await loadSchedule();
    toast('Removed');
  } catch (err) {
    toast(err.message, 'error');
    busy(button, false, 'Remove');
  }
}

async function loadSchedule({ keepForm = false } = {}) {
  if ($('#view-profile').hidden) return;
  const ticket = ++scheduleTicket;
  try {
    const next = await api(`/me/schedule?offset=${scheduleOffset}`);
    if (ticket !== scheduleTicket) return;
    schedule = next;
    message($('#sched-msg'), '');
    if (keepForm && document.getElementById('sched-form')) return;
    renderSchedule();
  } catch (err) {
    if (ticket !== scheduleTicket) return;
    message($('#sched-msg'), err.message);
    if (!schedule) $('#sched-days').replaceChildren(el('p', 'empty', "Couldn't load your week."));
  }
}

$('#sched-prev').onclick = () => { scheduleOffset = Math.max(-8, scheduleOffset - 1); scheduleAdding = null; loadSchedule(); };
$('#sched-next').onclick = () => { scheduleOffset = Math.min(12, scheduleOffset + 1); scheduleAdding = null; loadSchedule(); };
$('#sched-today').onclick = () => { scheduleOffset = 0; scheduleAdding = null; loadSchedule(); };

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
  renderSocials($('#me-socials'), Object.fromEntries(['instagram', 'facebook'].filter((k) => me[k]).map((k) => [k, socialUrl[k](me[k])])));
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
  fillList($('#towns'), byPinned(townsIn(), (m) => m.towns.id).map((m) => {
    const t = m.towns;
    const li = el('li', 'town');
    li.innerHTML = `<div class="ring"></div><div class="who"><div class="name"></div><div class="handle"></div></div><div class="actions"><button class="small danger">Leave</button></div>`;
    li.querySelector('.ring').append(townIcon(t));
    li.querySelector('.name').textContent = t.name;
    const handle = li.querySelector('.handle');
    handle.append(townIdentityNote(m));
    handle.append([t.created_by === me.id ? ' · your town' : '', ` · invite code ${t.invite_code}`,
      m.house_x == null ? ' · no house yet' : ''].join(''));
    li.onclick = () => enterTown(t.id);
    const leave = li.querySelector('.danger');
    leave.onclick = (e) => { e.stopPropagation(); leaveTown(t); };
    const pin = el('button', `small pin-toggle${pinned.has(t.id) ? ' on' : ''}`);
    pin.type = 'button';
    pin.innerHTML = PIN_SVG;
    pin.append(pinned.has(t.id) ? 'Pinned' : 'Pin');
    pin.setAttribute('aria-pressed', String(pinned.has(t.id)));
    pin.onclick = (e) => { e.stopPropagation(); togglePin(t); };
    li.querySelector('.actions').prepend(pin);
    if (t.created_by === me.id) { // only a town's creator can delete it
      const del = el('button', 'small danger-solid', 'Delete');
      del.type = 'button';
      del.title = `Delete ${t.name} for everyone`;
      del.onclick = (e) => { e.stopPropagation(); deleteTown(t); };
      leave.after(del);
    }
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
    if (pane === 'calendar') calendarPane.load();
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
    $('#set-instagram').value = me.instagram || '';
    $('#set-facebook').value = me.facebook || '';
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
    for (const k of ['instagram', 'facebook']) {
      const typed = socialInput(`#set-${k}`).replace(/^@/, '');
      if (typed !== (me[k] || '')) out[k] = typed; // "" removes it
    }
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
  $('#set-instagram').oninput = update;
  $('#set-facebook').oninput = update;
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

  function open({ title, confirmLabel, options, save, busyLabel = 'Saving…' }) {
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
        busy(btn, true, busyLabel);
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

// The creator deletes a whole town. Everyone else there gets a notice in their Inbox.
async function deleteTown(t) {
  const yes = await confirmDialog({
    title: `Delete ${t.name}?`,
    body: `This deletes the whole town for everyone: every house, character, plan and calendar in it. Everyone else in ${t.name} gets a notice in their Inbox. This can't be undone.`,
    confirmLabel: 'Delete town', danger: true, typeToConfirm: t.name,
  });
  if (!yes) return;
  try {
    await api(`/towns/${t.id}`, { method: 'DELETE' });
    myTowns = myTowns.filter((m) => m.towns?.id !== t.id);
    feed = { ...feed, towns: feed.towns.filter((x) => x.id !== t.id) };
    townsPane.load();
    renderProfile();
    renderFeed();
    toast(`${t.name} was deleted`);
    refreshAll();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function reloadMe() {
  ({ profile: me, towns: myTowns } = await api('/me'));
}

// ---- Create a town, invite friends ------------------------------------------------------------

// A checklist of friends for a dialog. `lockedNote(friend)` returns a note ("invite sent") for people who
// can't be picked, else null. `onChange(count)` runs whenever the selection changes.
function friendPicker({ list, filter, empty, onChange = () => {} }) {
  let friends = [], picked = new Set(), lockedNote = () => null;
  function render() {
    const q = filter.value.trim().toLowerCase().replace(/^@/, '');
    const shown = q ? friends.filter((f) => `${f.display_name ?? ''} ${f.username ?? ''}`.toLowerCase().includes(q)) : friends;
    fillList(list, shown.map((f) => {
      const note = lockedNote(f);
      const li = document.createElement('li');
      li.className = note ? 'pick locked' : 'pick';
      li.innerHTML = '<input type="checkbox" tabindex="-1" /><div class="avatar sm"></div><div class="who"><div class="name"></div><div class="handle"></div></div>';
      paintAvatar(li.querySelector('.avatar'), f);
      li.querySelector('.name').textContent = f.display_name;
      li.querySelector('.handle').textContent = [f.username ? `@${f.username}` : '', note].filter(Boolean).join(' · ');
      const box = li.querySelector('input');
      box.checked = Boolean(note) || picked.has(f.id);
      box.disabled = Boolean(note);
      if (!note) {
        li.tabIndex = 0;
        li.setAttribute('role', 'checkbox');
        li.setAttribute('aria-checked', String(box.checked));
        const toggle = () => {
          if (picked.has(f.id)) picked.delete(f.id); else picked.add(f.id);
          box.checked = picked.has(f.id);
          li.setAttribute('aria-checked', String(box.checked));
          onChange(picked.size);
        };
        li.onclick = toggle;
        li.onkeydown = (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggle(); } };
      }
      return li;
    }));
    filter.hidden = friends.length <= FILTER_AFTER && !q;
    empty.hidden = friends.length > 0;
  }
  filter.oninput = render;
  return {
    load(people, note = () => null) {
      friends = people;
      lockedNote = note;
      picked = new Set();
      filter.value = '';
      render();
      onChange(0);
    },
    picked: () => [...picked],
  };
}

// Create a town: describe it, pick friends to invite, then your name and color there. The backend has the
// town planner design it (POST /towns/generate) and sends the invites as soon as it exists.
const createTown = (() => {
  const dialog = $('#create-dialog');
  const prompt = $('#create-prompt');
  const picker = friendPicker({
    list: $('#create-friends'), filter: $('#create-filter'), empty: $('#create-no-friends'),
    onChange: (n) => { $('#create-picked').textContent = n ? `(${n} picked)` : ''; },
  });

  // Places: a toggle chip per supported place type and landmark (GET /towns/place-options), plus "other
  // buildings" typed by name (the backend puts each on a random building, under the name as typed)
  let options = null, chosen = new Set(), custom = [];
  // Look: one pick (or none) per row; the planner fills in whatever is left unpicked
  const LOOK_ROWS = { landscape: ['#create-landscape', 'landscapes'], style: ['#create-style', 'styles'], greenery: ['#create-greenery', 'greenery'] };
  let look = {};
  function renderLook() {
    for (const [key, [box, list]] of Object.entries(LOOK_ROWS)) {
      $(box).replaceChildren(...(options[list] || []).map((o) => {
        const b = Object.assign(document.createElement('button'), { type: 'button', className: 'chip toggle', textContent: o.label });
        b.setAttribute('role', 'radio');
        b.setAttribute('aria-checked', String(look[key] === o.id));
        b.setAttribute('aria-pressed', String(look[key] === o.id));
        b.onclick = () => { look[key] = look[key] === o.id ? null : o.id; renderLook(); };
        return b;
      }));
    }
  }
  const customInput = $('#create-custom');
  const isLandmark = (id) => options.landmarks.some((l) => l.id === id);
  const placeCount = () => [...chosen].filter((id) => !isLandmark(id)).length + custom.length;

  function renderPlaces() {
    const full = placeCount() >= options.max_places;
    const box = $('#create-places');
    box.innerHTML = '';
    for (const o of [...options.places, ...options.landmarks]) {
      const b = Object.assign(document.createElement('button'), { type: 'button', className: 'chip toggle', textContent: o.label });
      const on = chosen.has(o.id);
      b.setAttribute('aria-pressed', String(on));
      b.disabled = !on && full && !isLandmark(o.id);
      b.onclick = () => { if (on) chosen.delete(o.id); else chosen.add(o.id); renderPlaces(); };
      box.append(b);
    }
    const cbox = $('#create-custom-box');
    cbox.querySelectorAll('.chip').forEach((c) => c.remove());
    custom.forEach((text, i) => {
      const chip = Object.assign(document.createElement('span'), { className: 'chip', textContent: text });
      const x = Object.assign(document.createElement('button'), { type: 'button', textContent: '×' });
      x.setAttribute('aria-label', `Remove ${text}`);
      x.onclick = () => { custom.splice(i, 1); renderPlaces(); customInput.focus(); };
      chip.append(x);
      cbox.insertBefore(chip, customInput);
    });
    customInput.disabled = full;
    customInput.placeholder = custom.length ? '' : 'Hospital, arcade, fire station…';
    const n = placeCount();
    $('#create-places-count').textContent = n ? `(${n} picked)` : '';
    $('#create-places-hint').textContent = full ? `That's the most one town can hold (${options.max_places}).` : '';
  }

  // Adds what's typed as an "other building". Returns false (and says why, keeping the text) if it can't.
  function addCustom() {
    const text = customInput.value.trim().slice(0, 40);
    if (!text) return true;
    const hint = $('#create-places-hint');
    if (custom.some((c) => c.toLowerCase() === text.toLowerCase())) { customInput.value = ''; return true; } // already added
    if (placeCount() >= options.max_places) {
      hint.textContent = `"${text}" didn't fit: a town holds ${options.max_places} places. Unpick one to add it.`;
      return false;
    }
    customInput.value = '';
    custom.push(text);
    renderPlaces();
    return true;
  }
  customInput.onkeydown = (e) => {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addCustom(); }
    else if (e.key === 'Backspace' && !customInput.value && custom.length) { custom.pop(); renderPlaces(); }
  };
  customInput.onblur = addCustom;
  $('#create-custom-box').onclick = (e) => { if (e.target.id === 'create-custom-box') customInput.focus(); };

  function update() {
    const text = prompt.value.trim();
    $('#create-prompt-hint').textContent = text
      ? `${1000 - prompt.value.length} characters left`
      : "A sentence or two is plenty: the vibe, places you'd love to hang out, what kind of buildings.";
    $('#create-next').disabled = !text;
  }
  prompt.oninput = update;

  async function open() {
    let friends = allFriends;
    try {
      [friends, options] = await Promise.all([api('/friends'), options || api('/towns/place-options')]);
    } catch (err) {
      if (!options) return toast(err.message, 'error');
    }
    chosen = new Set();
    custom = [];
    look = {};
    customInput.value = '';
    renderPlaces();
    renderLook();
    prompt.value = '';
    $('#create-name').value = '';
    message($('#create-msg'), '');
    picker.load(friends);
    update();
    dialog.showModal();
    prompt.focus();
  }

  $('#create-form').onsubmit = async (e) => {
    if (e.submitter?.value !== 'ok') return; // Cancel closes the dialog as usual
    e.preventDefault();
    if (!addCustom()) return customInput.focus(); // a name still being typed counts; never drop it silently
    const body = {
      prompt: prompt.value.trim(), name: $('#create-name').value.trim() || null, invite_user_ids: picker.picked(),
      places: [...chosen].filter((id) => !isLandmark(id)), landmarks: [...chosen].filter(isLandmark), custom_places: custom,
      landscape: look.landscape || null, style: look.style || null, greenery: look.greenery || null,
    };
    dialog.close();
    review.open(body);
  };

  // Review the design before anything is created: the whole map (drawn from its tiles), its places, and a box for
  // changes. "Redo with changes" sends the design back with the notes; "Create" builds exactly this design
  // (`design`: the preview's plan, no model call), after you pick your name and color there.
  const review = (() => {
    const dlg = $('#review-dialog'), feedback = $('#review-feedback'), msg = $('#review-msg');
    let body = null, shown = null, run = 0;
    const sync = (working) => {
      $('#review-revise').disabled = working || !shown || !feedback.value.trim();
      $('#review-fresh').disabled = $('#review-ok').disabled = working || !shown;
    };
    feedback.oninput = () => sync(false);

    function show(made) {
      shown = made;
      $('#review-title').textContent = made.name;
      $('#review-theme').textContent = made.map.theme || body.prompt;
      // Home plots as houses: yours (the first plot) in purple, the ones friends will get in gray
      const tiles = made.tiles.map((row) => [...row]);
      const homes = (made.map.home_slots || []).map((sl, i) => {
        tiles[sl.house[1]][sl.house[0]] = 'home';
        tiles[sl.driveway[1]][sl.driveway[0]] = 'driveway';
        return { x: sl.house[0], y: sl.house[1], color: i ? '#cfd4dc' : '#7a5cff' };
      });
      const img = Object.assign(new Image(), { alt: `Map of ${made.name}` });
      img.src = drawTown({ tiles, homes, background_color: made.map.background_homes?.color, landscape: made.map.landscape }, { whole: true });
      $('#review-art').replaceChildren(img);
      $('#review-key').hidden = !homes.length;
      const label = (list, id) => (options?.[list] || []).find((o) => o.id === id)?.label || id;
      const lookChips = [['landscapes', made.plan?.landscape], ['styles', made.plan?.style], ['greenery', made.plan?.greenery]]
        .filter(([, id]) => id).map(([list, id]) => el('span', 'chip look', label(list, id)));
      $('#review-places').replaceChildren(...lookChips, ...Object.values(made.map.places || {}).map((p) => el('span', 'chip', p.name)));
    }

    async function design(extra = {}, note = '') {
      const mine = ++run;
      sync(true);
      message(msg, '');
      $('#review-art').innerHTML = `<div class="busy-note"><div class="spinner"></div>${shown ? 'Redrawing your town…' : 'Designing your town…'}<br>This takes about half a minute.</div>`;
      try {
        const made = await api('/towns/generate', { method: 'POST', body: { ...body, preview: true, ...extra } });
        if (mine !== run) return; // they went back or asked again meanwhile
        show(made);
        $('#review-changed').hidden = !note;
        $('#review-changed').textContent = note ? `Changed: ${note}` : '';
        if (note) feedback.value = '';
      } catch (err) {
        if (mine !== run) return;
        message(msg, `Couldn't design it: ${err.message}`);
        if (shown) show(shown); // keep the design they had
        else $('#review-art').replaceChildren();
      }
      sync(false);
    }

    $('#review-form').onsubmit = async (e) => {
      e.preventDefault();
      const action = e.submitter?.value;
      if (action === 'back') { run++; dlg.close(); return dialog.showModal(); } // the description, as they left it
      if (action === 'fresh') return design();
      if (action === 'revise') {
        const text = feedback.value.trim();
        return design({ revise: { tiles: shown.tiles, map: shown.map, feedback: text } }, text);
      }
      if (action !== 'ok' || !shown) return;
      dlg.close();
      const approved = shown;
      let created = null;
      const picked = await identityDialog.open({
        title: `You in ${approved.name}`,
        confirmLabel: 'Create town',
        busyLabel: 'Building your town…',
        options: { taken: [], mine: null, suggested_color: Colors.freeColor([]) },
        save: async (you) => {
          created = await api('/towns/generate', { method: 'POST', body: { ...body, design: approved.plan, me: you } });
        },
      });
      if (!picked) return dlg.showModal(); // cancelled: back to the design, nothing lost
      await reloadMe();
      refreshAll();
      const invited = created.invited ? ` Invited ${created.invited} friend${created.invited === 1 ? '' : 's'}.` : '';
      toast(`${created.name} is ready!${invited}`);
    };

    return {
      open(b) {
        body = b;
        shown = null;
        feedback.value = '';
        $('#review-changed').hidden = true;
        $('#review-places').replaceChildren();
        $('#review-title').textContent = b.name || 'Your new town';
        $('#review-theme').textContent = b.prompt;
        dlg.showModal();
        design();
      },
    };
  })();

  $('#create-town').onclick = open;
})();

// Invite friends to a town you created. People already in it, or already invited, can't be picked again.
const inviteFriends = (() => {
  const dialog = $('#invite-dialog');
  const ok = $('#invite-ok');
  let town = null;
  const label = (n) => (n ? `Send ${n} invite${n === 1 ? '' : 's'}` : 'Send invites');
  const picker = friendPicker({
    list: $('#invite-friends'), filter: $('#invite-filter'), empty: $('#invite-no-friends'),
    onChange: (n) => { ok.disabled = !n; ok.textContent = label(n); },
  });

  async function open(t) {
    town = t;
    let friends, detail, invites;
    try {
      [friends, detail, invites] = await Promise.all([api('/friends'), api(`/towns/${t.id}`), api(`/towns/${t.id}/invites`)]);
    } catch (err) {
      return toast(err.message, 'error');
    }
    const members = new Set(detail.members.map((m) => m.user_id));
    const pending = new Set(invites.filter((i) => i.status === 'pending').map((i) => i.to_user));
    $('#invite-title').textContent = `Invite friends to ${t.name}`;
    $('#invite-code').value = t.invite_code || detail.town?.invite_code || '';
    $('#invite-copy').textContent = 'Copy';
    message($('#invite-msg'), '');
    picker.load(friends, (f) => (members.has(f.id) ? 'already in this town' : pending.has(f.id) ? 'invite sent' : null));
    dialog.showModal();
  }

  $('#invite-copy').onclick = async () => {
    const code = $('#invite-code');
    try {
      await navigator.clipboard.writeText(code.value);
    } catch { // no clipboard access (http on another host, old browser): select it so they can copy by hand
      code.select();
      return toast('Press Ctrl/⌘+C to copy the code.');
    }
    $('#invite-copy').textContent = 'Copied!';
    toast(`Copied ${town.name}'s invite code.`);
  };
  $('#invite-code').onfocus = (e) => e.target.select();

  $('#invite-form').onsubmit = async (e) => {
    if (e.submitter?.value !== 'ok') return;
    e.preventDefault();
    const ids = picker.picked();
    busy(ok, true, 'Sending…');
    const results = await Promise.allSettled(ids.map((id) => api(`/towns/${town.id}/invites`, { method: 'POST', body: { user_id: id } })));
    busy(ok, false, label(ids.length));
    const failed = results.filter((r) => r.status === 'rejected');
    if (failed.length) return message($('#invite-msg'), `${failed.length} invite${failed.length === 1 ? '' : 's'} didn't send: ${failed[0].reason.message}`);
    dialog.close();
    toast(`Invited ${ids.length} friend${ids.length === 1 ? '' : 's'} to ${town.name}.`);
  };

  return { open };
})();

// Towns: your name and color in each town (edit), and leaving
const townsPane = (() => {
  function load() {
    fillList($('#settings-towns'), townsIn().map((m) => {
      const t = m.towns;
      const li = document.createElement('li');
      li.innerHTML = `<div class="ring"></div><div class="who"><div class="name"></div><div class="handle"></div></div><div class="actions"><button class="small">Name &amp; color</button><button class="small">House name</button><button class="small danger">Leave</button></div>`;
      li.querySelector('.ring').append(townIcon(t));
      li.querySelector('.name').textContent = t.name;
      const handle = li.querySelector('.handle');
      handle.append(townIdentityNote(m));
      if (m.house_x != null) handle.append(` · 🏠 ${houseName(m)}`);
      const [edit, house, leave] = li.querySelectorAll('button');
      edit.onclick = () => editIdentity(t);
      house.hidden = m.house_x == null; // no house in this town yet
      house.onclick = () => renameHouse(t, m);
      leave.onclick = () => leaveTown(t);
      if (t.created_by === me.id) { // only a town's creator can invite friends, or delete it
        const invite = el('button', 'small', 'Invite friends');
        invite.type = 'button';
        invite.onclick = () => inviteFriends.open(t);
        edit.before(invite);
        const del = el('button', 'small danger-solid', 'Delete town');
        del.type = 'button';
        del.onclick = () => deleteTown(t);
        leave.after(del);
      }
      return li;
    }));
    $('#settings-no-towns').hidden = townsIn().length > 0;
  }

  const houseName = (m) => m.home?.name || `${m.name || me.display_name}'s house`;

  async function renameHouse(t, m) {
    const name = await promptDialog({
      title: `Your house in ${t.name}`,
      body: 'This is the label on your house in town. Leave it empty to go back to the default.',
      label: 'House name', value: m.home?.name || '', placeholder: `${m.name || me.display_name}'s house`, maxLength: 40,
    });
    if (name === null) return;
    try {
      await api(`/towns/${t.id}/members/me/home`, { method: 'PATCH', body: { name: name || null } });
    } catch (err) {
      return toast(err.message, 'error');
    }
    await reloadMe();
    load();
    toast(name ? `Your house is now “${name}”.` : 'Your house is back to its default name.');
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

// Calendar: connect Google Calendar (events, read-only). Google sends people back to ?calendar=google with a
// refresh token in the session exactly once; it goes straight to the backend, which does all the syncing.
const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  'https://www.googleapis.com/auth/calendar.events.readonly',
].join(' ');
const calendarPane = (() => {
  // Read before supabase-js tidies the URL: are we coming back from Google, and did it fail?
  const query = new URLSearchParams(location.search), fragment = new URLSearchParams(location.hash.slice(1));
  const returning = query.get('calendar') === 'google';
  const googleError = returning && (query.get('error_description') || fragment.get('error_description'));

  const ago = (iso) => {
    const min = Math.round((Date.now() - Date.parse(iso)) / 60000);
    return min < 1 ? 'just now' : min < 60 ? `${min} min ago` : `${Math.round(min / 60)} h ago`;
  };

  function render(s) {
    const on = Boolean(s?.connected);
    // Connected but broken (e.g. access removed, or connected back when Luma only asked for free/busy): offer a reconnect
    $('#cal-connect').hidden = !s || (on && !s.last_error);
    $('#cal-connect').textContent = on ? 'Reconnect Google Calendar' : 'Connect Google Calendar';
    $('#cal-sync').hidden = !on;
    $('#cal-disconnect').hidden = !on;
    $('#cal-status').textContent = !s ? 'Checking…' : !on ? 'Not connected'
      : `Connected${s.last_synced_at ? ` · synced ${ago(s.last_synced_at)}` : ''} · ${s.upcoming_events ?? 0} ${s.upcoming_events === 1 ? 'event' : 'events'} coming up, ${s.upcoming_at_places ?? 0} at a place in town`;
    $('#cal-error').hidden = !s?.last_error;
    $('#cal-error').textContent = s?.last_error || '';
  }

  async function load() {
    render(null);
    try { render(await api('/me/calendar')); } catch (err) { $('#cal-status').textContent = 'Not available'; toast(err.message, 'error'); }
  }

  async function finishConnect(session) {
    history.replaceState(null, '', `${location.pathname}#/settings/calendar`);
    if (googleError) return toast(`Google Calendar wasn't connected: ${googleError}`, 'error');
    if (!session.provider_refresh_token) return toast("Google didn't grant ongoing calendar access. Try connecting again.", 'error');
    try {
      await api('/me/calendar/google', { method: 'POST', body: { refresh_token: session.provider_refresh_token, scopes: GOOGLE_SCOPES } });
      toast('Google Calendar connected');
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  $('#cal-connect').onclick = async () => {
    busy($('#cal-connect'), true, 'Opening Google…');
    const { data: { user } } = await sb.auth.getUser();
    const options = {
      redirectTo: `${location.origin}${location.pathname}?calendar=google`,
      scopes: GOOGLE_SCOPES,
      queryParams: { access_type: 'offline', prompt: 'consent' }, // ask for a refresh token every time
    };
    // First time: link Google to this account. Already linked (e.g. reconnecting): sign in with it again.
    const linked = user?.identities?.some((i) => i.provider === 'google');
    const { error } = linked
      ? await sb.auth.signInWithOAuth({ provider: 'google', options })
      : await sb.auth.linkIdentity({ provider: 'google', options });
    if (error) {
      toast(error.message, 'error');
      busy($('#cal-connect'), false, $('#cal-sync').hidden ? 'Connect Google Calendar' : 'Reconnect Google Calendar');
    }
  };

  $('#cal-sync').onclick = async () => {
    busy($('#cal-sync'), true, 'Syncing…');
    try { render(await api('/me/calendar/sync', { method: 'POST' })); toast('Calendar synced'); } catch (err) { toast(err.message, 'error'); load(); }
    busy($('#cal-sync'), false, 'Sync now');
  };

  $('#cal-disconnect').onclick = async () => {
    const yes = await confirmDialog({
      title: 'Disconnect Google Calendar?',
      body: 'Luma stops reading your calendar and removes the events it copied. Google access is revoked too.',
      confirmLabel: 'Disconnect', danger: true,
    });
    if (!yes) return;
    try { await api('/me/calendar', { method: 'DELETE' }); toast('Google Calendar disconnected'); } catch (err) { toast(err.message, 'error'); }
    load();
  };

  return { load, finishConnect, returning };
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

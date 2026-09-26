// Entry app: sign in / create account → pick a username (first time) → home (friends + enter town).
import { api, getSupabase } from './session.js';

const $ = (s) => document.querySelector(s);
const USERNAME_RE = /^[a-z0-9_]{3,20}$/;
const VIEWS = ['loading', 'error', 'auth', 'username', 'home'];

let sb = null;
let me = null; // current profile row
let myTowns = []; // GET /me towns: [{house_x, house_y, joined_at, towns: {id, name, invite_code, created_by}}]
let pollTimer = null;

function show(view) {
  for (const v of VIEWS) $(`#view-${v}`).hidden = v !== view;
  clearInterval(pollTimer);
  if (view === 'home') pollTimer = setInterval(() => { if (!document.hidden) refreshFriends(); }, 20000);
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
const colorFor = (id = '') => `hsl(${[...id].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 360, 0)} 60% 52%)`;

// ---- Boot ----------------------------------------------------------------------------------

async function boot() {
  show('loading');
  try {
    sb = await getSupabase();
  } catch (e) {
    $('#error-text').textContent = e.message;
    return show('error');
  }
  sb.auth.onAuthStateChange((event) => { if (event === 'SIGNED_OUT') { me = null; showAuth(); } });
  const { data: { session } } = await sb.auth.getSession();
  if (session) await afterSignIn();
  else showAuth();
}

$('#retry').onclick = boot;

// After any successful sign in: new users pick a username, everyone else goes home
async function afterSignIn() {
  show('loading');
  try {
    ({ profile: me, towns: myTowns } = await api('/me'));
  } catch (e) {
    if (e.status === 401) { await sb.auth.signOut(); return; }
    $('#error-text').textContent = e.message;
    return show('error');
  }
  if (me.username) showHome();
  else showUsername();
}

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

function checkUsername() {
  const input = $('#username-input');
  const value = input.value.trim().toLowerCase();
  if (input.value !== value) input.value = value; // usernames are lowercase
  const hint = $('#username-hint');
  const ok = USERNAME_RE.test(value);
  hint.className = `hint ${value ? (ok ? 'ok' : 'bad') : ''}`;
  hint.textContent = !value ? '3–20 characters: lowercase letters, numbers, underscores'
    : ok ? `Friends will find you as @${value}`
    : value.length < 3 ? 'At least 3 characters'
    : 'Only lowercase letters, numbers, and underscores';
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
    showHome();
  } catch (err) {
    message($('#username-msg'), err.status === 409 ? `@${username} is taken. Try another.` : err.message);
  } finally {
    busy(btn, false, 'Continue');
  }
};

// ---- Home: profile + friends -------------------------------------------------------------------

function showHome() {
  $('#me-avatar').textContent = initials(me.display_name);
  $('#me-avatar').style.background = colorFor(me.id);
  $('#me-name').textContent = me.display_name;
  $('#me-handle').textContent = `@${me.username}`;
  message($('#search-msg'), '');
  $('#search-results').innerHTML = '';
  renderTowns();
  show('home');
  refreshFriends();
}

// Each town you're in; clicking one opens it in 3D, built from its tiles and map in the database
function renderTowns() {
  fillList($('#towns'), myTowns.filter((t) => t.towns).map(({ towns: t, house_x: hx }) => {
    const li = document.createElement('li');
    li.className = 'town';
    li.innerHTML = '<div class="avatar sm"></div><div class="who"><div class="name"></div><div class="handle"></div></div><button class="small primary">Open →</button>';
    li.querySelector('.avatar').textContent = initials(t.name);
    li.querySelector('.avatar').style.background = colorFor(t.id);
    li.querySelector('.name').textContent = t.name;
    li.querySelector('.handle').textContent = [t.created_by === me.id ? 'Your town' : '', `invite code ${t.invite_code}`,
      hx == null ? 'no house yet' : ''].filter(Boolean).join(' · ');
    li.onclick = () => { location.href = `town.html?town=${encodeURIComponent(t.id)}`; };
    return li;
  }));
  $('#no-towns').hidden = myTowns.length > 0;
}

$('#sign-out').onclick = () => sb.auth.signOut();

// A person row: avatar, name, @username, and optional action buttons [label, onClick, className]
function personRow(p, actions = [], note = '') {
  const li = document.createElement('li');
  li.innerHTML = `<div class="avatar sm"></div><div class="who"><div class="name"></div><div class="handle"></div></div><div class="actions"></div>`;
  li.querySelector('.avatar').textContent = initials(p?.display_name);
  li.querySelector('.avatar').style.background = colorFor(p?.id);
  li.querySelector('.name').textContent = p?.display_name || 'Unknown';
  li.querySelector('.handle').textContent = [p?.username ? `@${p.username}` : '', note].filter(Boolean).join(' · ');
  for (const [label, onClick, cls = ''] of actions) {
    const b = document.createElement('button');
    b.className = `small ${cls}`;
    b.textContent = label;
    b.onclick = async () => {
      li.querySelectorAll('button').forEach((x) => { x.disabled = true; });
      try { await onClick(); } catch (err) { message($('#search-msg'), err.message); }
      await refreshFriends();
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
let allFriends = [];
const FILTER_AFTER = 5;

function renderFriends() {
  const filter = $('#friend-filter');
  const q = filter.value.trim().toLowerCase().replace(/^@/, '');
  const shown = q ? allFriends.filter((f) => `${f.display_name ?? ''} ${f.username ?? ''}`.toLowerCase().includes(q)) : allFriends;
  fillList($('#friends'), shown.map((f) => personRow(f, [
    ['Remove', () => confirm(`Remove ${f.display_name} as a friend?`) && api(`/friends/${f.id}`, { method: 'DELETE' }), 'danger'],
  ])));
  filter.hidden = allFriends.length <= FILTER_AFTER && !q;
  $('#friend-count').textContent = allFriends.length ? `(${allFriends.length})` : '';
  $('#no-friends').hidden = allFriends.length > 0;
  $('#no-matches').hidden = !(allFriends.length && !shown.length);
}

$('#friend-filter').oninput = renderFriends;

async function refreshFriends() {
  let friends, requests;
  try {
    [friends, requests] = await Promise.all([api('/friends'), api('/friends/requests')]);
  } catch (err) {
    return message($('#search-msg'), err.message);
  }

  allFriends = friends;
  renderFriends();

  fillList($('#incoming'), requests.incoming.map((r) => personRow(r.from_profile, [
    ['Accept', () => api(`/friends/requests/${r.id}/respond`, { method: 'POST', body: { status: 'accepted' } }), 'primary'],
    ['Decline', () => api(`/friends/requests/${r.id}/respond`, { method: 'POST', body: { status: 'declined' } })],
  ], 'wants to be friends')));
  fillList($('#outgoing'), requests.outgoing.map((r) => personRow(r.to_profile, [], 'request sent')));
  const total = requests.incoming.length + requests.outgoing.length;
  $('#no-requests').hidden = total > 0;
  $('#request-count').hidden = requests.incoming.length === 0;
  $('#request-count').textContent = requests.incoming.length;
}

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

boot();

// Entry app: sign in / create account → pick a username (first time) → home (friends + towns),
// plus the account menu, settings (#/settings/<pane>) and help (#/help). Routes live in the URL hash
// so the back button and links work.
import { api, getSupabase } from './session.js';
import { confirmDialog, getTheme, setTheme, toast } from './ui.js';
import * as Colors from './colors.js';
import { createWheel } from './wheel.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const USERNAME_RE = /^[a-z0-9_]{3,20}$/;
const VIEWS = ['loading', 'error', 'auth', 'username', 'home', 'settings', 'help'];
const SIGNED_IN_VIEWS = new Set(['home', 'settings', 'help']);
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
  clearInterval(pollTimer);
  if (view === 'home') pollTimer = setInterval(() => { if (!document.hidden) refreshFriends(); }, 20000);
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
  if (parts[0] === 'help') return { view: 'help' };
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
  const { view, pane } = parseHash();
  closeMenu();
  if (view === 'settings') return showSettings(pane);
  currentPane = null;
  if (view === 'help') { show('help'); return scrollTo(0, 0); }
  showHome();
}

// ---- Account menu ------------------------------------------------------------------------------

function renderIdentity() {
  paintAvatar($('#bar-avatar'), me);
  $('#menu-name').textContent = me.display_name;
  $('#menu-handle').textContent = `@${me.username}`;
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

// ---- Home: profile + towns + friends ------------------------------------------------------------

function renderChips(el, items) {
  el.innerHTML = '';
  for (const text of items) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = text;
    el.append(chip);
  }
}

function showHome() {
  paintAvatar($('#me-avatar'), me);
  $('#me-name').textContent = me.display_name;
  $('#me-handle').textContent = `@${me.username}`;
  renderChips($('#me-interests'), me.interests || []);
  $('#me-interests').hidden = !me.interests?.length;
  message($('#search-msg'), '');
  $('#search-results').innerHTML = '';
  renderTowns();
  show('home');
  refreshFriends();
}

const townsIn = () => myTowns.filter((t) => t.towns);

// "● Sam here" in your color for that town
function townIdentityNote(m) {
  const frag = document.createDocumentFragment();
  if (m.color) {
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = m.color;
    frag.append(dot);
  }
  frag.append(m.name ? `${m.name} here` : 'no name picked yet');
  return frag;
}

// Each town you're in; clicking one opens it in 3D, built from its tiles and map in the database
function renderTowns() {
  fillList($('#towns'), townsIn().map((m) => {
    const t = m.towns;
    const li = document.createElement('li');
    li.className = 'town';
    li.innerHTML = '<div class="avatar sm"></div><div class="who"><div class="name"></div><div class="handle"></div></div><button class="small primary">Open →</button>';
    paintAvatar(li.querySelector('.avatar'), { id: t.id }, t.name);
    li.querySelector('.name').textContent = t.name;
    const handle = li.querySelector('.handle');
    handle.append(townIdentityNote(m));
    handle.append([t.created_by === me.id ? ' · your town' : '', ` · invite code ${t.invite_code}`,
      m.house_x == null ? ' · no house yet' : ''].join(''));
    li.onclick = () => { location.href = `town.html?town=${encodeURIComponent(t.id)}`; };
    return li;
  }));
  $('#no-towns').hidden = townsIn().length > 0;
  refreshInvites();
}

// Pending town invites: accepting asks for your name and color in that town first
async function refreshInvites() {
  let invites;
  try { invites = await api('/me/invites'); } catch { return; }
  fillList($('#invites'), invites.map((inv) => {
    const li = personRow(inv.from_profile, [], `invited you to ${inv.towns?.name || 'a town'}`);
    const actions = li.querySelector('.actions');
    const accept = Object.assign(document.createElement('button'), { className: 'small primary', textContent: 'Join…' });
    const decline = Object.assign(document.createElement('button'), { className: 'small', textContent: 'Decline' });
    accept.onclick = async () => {
      let options;
      try { options = await api(`/towns/${inv.town_id}/identities`); } catch (err) { return toast(err.message, 'error'); }
      const picked = await identityDialog.open({
        title: `Join ${options.town.name}`, confirmLabel: 'Join town', options,
        save: (me) => api(`/invites/${inv.id}/respond`, { method: 'POST', body: { status: 'accepted', me } }),
      });
      if (!picked) return;
      await reloadMe();
      renderTowns();
      toast(`Welcome to ${options.town.name}, ${picked.name}!`);
    };
    decline.onclick = async () => {
      decline.disabled = accept.disabled = true;
      try { await api(`/invites/${inv.id}/respond`, { method: 'POST', body: { status: 'declined' } }); } catch (err) { toast(err.message, 'error'); }
      refreshInvites();
    };
    actions.append(accept, decline);
    return li;
  }));
  $('#invites-section').hidden = invites.length === 0;
  $('#invite-count').textContent = invites.length;
}

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
  await reloadMe();
  renderTowns();
  toast(`Welcome to ${options.town.name}, ${picked.name}!`);
};

// A person row: avatar, name, @username, and optional action buttons [label, onClick, className]
function personRow(p, actions = [], note = '') {
  const li = document.createElement('li');
  li.innerHTML = `<div class="avatar sm"></div><div class="who"><div class="name"></div><div class="handle"></div></div><div class="actions"></div>`;
  paintAvatar(li.querySelector('.avatar'), p);
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
  ul.innerHTML = '';
  rows.forEach((r) => ul.append(r));
}

async function refreshFriends() {
  let friends, requests;
  try {
    [friends, requests] = await Promise.all([api('/friends'), api('/friends/requests')]);
  } catch (err) {
    return message($('#search-msg'), err.message);
  }

  fillList($('#friends'), friends.map((f) => personRow(f, [
    ['Remove', async () => {
      const yes = await confirmDialog({ title: `Remove ${f.display_name}?`, body: "You'll stop being friends. You can send a new request later.", confirmLabel: 'Remove', danger: true });
      if (yes) await api(`/friends/${f.id}`, { method: 'DELETE' });
    }, 'danger'],
  ])));
  $('#no-friends').hidden = friends.length > 0;

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

async function reloadMe() {
  ({ profile: me, towns: myTowns } = await api('/me'));
}

// Towns: your name and color in each town (edit), and leaving
const townsPane = (() => {
  function load() {
    fillList($('#settings-towns'), townsIn().map((m) => {
      const t = m.towns;
      const li = document.createElement('li');
      li.innerHTML = '<div class="avatar sm"></div><div class="who"><div class="name"></div><div class="handle"></div></div><div class="actions"><button class="small">Name &amp; color</button><button class="small danger">Leave</button></div>';
      paintAvatar(li.querySelector('.avatar'), { id: t.id }, t.name);
      li.querySelector('.name').textContent = t.name;
      li.querySelector('.handle').append(townIdentityNote(m));
      const [edit, leave] = li.querySelectorAll('button');
      edit.onclick = () => editIdentity(t);
      leave.onclick = () => privacy.leave(t);
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

// Privacy & data: download, delete account (and leaving a town, used by the Towns pane)
const privacy = (() => {
  function load() {}

  async function leave(t) {
    const yes = await confirmDialog({
      title: `Leave ${t.name}?`,
      body: `Your house and character will be removed from ${t.name}. You'd need a new invite to come back.`,
      confirmLabel: 'Leave town', danger: true,
    });
    if (!yes) return;
    try {
      await api(`/towns/${t.id}/members/me`, { method: 'DELETE' });
      myTowns = myTowns.filter((m) => m.towns?.id !== t.id);
      townsPane.load();
      toast(`You left ${t.name}`);
    } catch (err) {
      toast(err.message, 'error');
    }
  }

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
      Object.assign(document.createElement('a'), { href: url, download: `tiny-town-${me.username}.json` }).click();
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

  return { load, leave };
})();

boot();

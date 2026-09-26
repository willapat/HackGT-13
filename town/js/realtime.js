// Talks to the FastAPI demo endpoints and maps town state onto the 3D scene.
// Polls GET /demo/snapshot (backend secret key) so the judge UI works without a logged-in Supabase user.
// Demo buttons POST /demo/trigger/{scenario} with a 3s timeout, then fall back to the scripted trigger().

import { placementsMatchScreen } from './sky.js';

const backendUrl = () => window.LUMA_BACKEND || 'http://127.0.0.1:8000';

export function startTownBackend(api) {
  const {
    friends, walkTo, say, setStatus, partyLights, rainCloud, showCard, logFeed, renameFriend,
    setCalendars, PLACES, effects, applyTownNames,
  } = api;

  let liveMode = false;
  let pollTimer = null;
  let pullGen = 0;
  const friendByUserId = {};
  const lastMood = {};
  const lastBuilding = {};
  const seenActions = new Set();
  const seenEvents = new Set();

  function friendForUser(userId, displayName) {
    if (userId && friends[userId]) return friends[userId];
    if (userId && friendByUserId[userId]) return friendByUserId[userId];
    const slug = (displayName || '').trim().toLowerCase();
    return slug && friends[slug] ? friends[slug] : null;
  }

  function remember(userId, displayName) {
    const f = friendForUser(userId, displayName);
    if (f && userId) friendByUserId[userId] = f;
    return f;
  }

  // characters: user_id -> character id, cast by the backend from whoever is in the demo town.
  function applyCharacters(characters, members) {
    if (!characters || !Object.keys(characters).length) return;
    const nameOf = Object.fromEntries(
      (members || []).map((m) => [m.user_id, (m.name || (m.profiles || {}).display_name || '').trim()]),
    );
    const cast = new Set();
    for (const [userId, role] of Object.entries(characters)) {
      const f = friends[role];
      if (!f) continue;
      friendByUserId[userId] = f;
      f.userId = userId;
      cast.add(f.id);
      if (nameOf[userId] && f.name !== nameOf[userId]) {
        renameFriend(f, nameOf[userId]);
      }
      f.obj.visible = true;
      if (f.homeLabel) f.homeLabel.el.style.display = '';
    }
    for (const f of Object.values(friends)) {
      if (cast.has(f.id)) continue;
      f.obj.visible = false;
      if (f.homeLabel) f.homeLabel.el.style.display = 'none';
    }
  }

  function destForBuilding(buildingId, ownerUserId) {
    if (!buildingId) return null;
    if (PLACES[buildingId]) return PLACES[buildingId];
    if (buildingId.startsWith('house:')) {
      const uid = buildingId.slice(6);
      const f = friendForUser(uid) || friendByUserId[uid];
      return f ? f.home : null;
    }
    if (ownerUserId && buildingId === `house:${ownerUserId}`) {
      const f = friendByUserId[ownerUserId];
      return f ? f.home : null;
    }
    return null;
  }

  function applyMember(row) {
    const profile = row.profiles || {};
    const f = remember(row.user_id, row.name || profile.display_name);
    if (!f) return;
    const activity = row.activity;
    const mood = row.mood;
    if (activity) setStatus(f.id, activity);
    else if (mood) setStatus(f.id, mood);
    if (lastMood[f.id] === mood) return;
    lastMood[f.id] = mood;
    const celebrating = mood === 'sunny' || mood === 'rainbow' || (activity || '').toLowerCase().includes('celebrat');
    const rough = mood === 'rainy' || mood === 'stormy';
    const partyKey = `goodNews:${f.id}`;
    const rainKey = `roughWeek:${f.id}`;
    if (celebrating && !effects[partyKey]) effects[partyKey] = partyLights(f.home, { focus: false });
    if (rough && !effects[rainKey]) effects[rainKey] = rainCloud(f.home, { focus: false });
  }

  function applyAgent(row) {
    const f = remember(row.user_id);
    if (!f) return;
    if (f.userId !== row.user_id) f.userId = row.user_id;
    const buildingId = (row.target && row.target.building_id) || null;
    const depart = String((row.target && row.target.depart_at) || '').slice(0, 16);
    const sig = `${row.action || ''}|${buildingId || ''}|${depart}|${row.x},${row.y}`;
    if (lastBuilding[f.id] === sig) return;
    lastBuilding[f.id] = sig;
    f.busy = true;
    f.nextThink = Infinity;
    if (api.placeAgent) {
      api.placeAgent(f, row);
      const dest = destForBuilding(buildingId, row.user_id);
      if (row.action === 'walk_to' || row.action === 'go_home') {
        logFeed(`${f.name} heads to ${dest?.name || 'home'}.`);
      }
      return;
    }
    const dest = destForBuilding(buildingId, row.user_id);
    const timing = { travelMinutes: row.target?.travel_minutes };
    if (dest && (row.action === 'walk_to' || row.action === 'visit' || row.action === 'knock' || row.action === 'go_home')) {
      f.obj.visible = true;
      logFeed(`${f.name} heads to ${dest.name || 'home'}.`);
      walkTo(f, dest, 0, timing);
    }
  }

  function applyAction(row) {
    if (!row || !row.id || seenActions.has(row.id)) return;
    seenActions.add(row.id);
    const f = remember(row.user_id);
    const lines = (row.details && row.details.lines) || [];
    lines.forEach((line, i) => {
      const speaker = remember(line.speaker_id) || f;
      if (speaker) setTimeout(() => say(speaker, line.text, 1700), i * 1800);
    });
  }

  function applyEvent(row) {
    if (!row || !row.id || seenEvents.has(row.id)) return;
    seenEvents.add(row.id);
    if (row.type === 'news') {
      logFeed(`📰 ${row.text || row.title}`);
      return;
    }
    if (row.type === 'quest') {
      showCard({
        kind: 'Quest',
        color: '#2fb36d',
        text: row.text || row.title,
        actions: [['Got it', null, true], ['Dismiss']],
      });
      logFeed(`📋 ${row.title || 'New quest'}`);
    }
  }

  async function pullSnapshot() {
    const gen = ++pullGen;
    const res = await fetch(`${backendUrl()}/demo/snapshot`);
    if (!res.ok) throw new Error(`snapshot ${res.status}`);
    const data = await res.json();
    if (gen !== pullGen) return;
    if (data.town_time && !placementsMatchScreen(data.town_time, data.mode)) return;
    if (api.applyTownTime) api.applyTownTime(data.town_time, data.mode, 'poll');
    if (gen !== pullGen) return;
    if (applyTownNames) applyTownNames(data.map);
    applyCharacters(data.characters, data.members);
    if (setCalendars) setCalendars(data.schedules);
    for (const m of data.members || []) applyMember(m);
    for (const a of data.agents || []) applyAgent(a);
    const actions = [...(data.agent_actions || [])].reverse();
    for (const row of actions) applyAction(row);
    const events = [...(data.events || [])].reverse();
    for (const row of events) applyEvent(row);
  }

  function enterLiveMode() {
    if (liveMode) return;
    liveMode = true;
    api.liveMode = true;
    for (const f of Object.values(friends)) {
      f.busy = true;
      f.nextThink = Infinity;
    }
    logFeed('Live town: waiting on the brain and character agents…');
    pullSnapshot().catch(() => {});
    pollTimer = setInterval(() => {
      pullSnapshot().catch((err) => console.warn('snapshot', err));
    }, 1500);
  }

  async function triggerViaBackend(name) {
    if (name === 'reset') {
      liveMode = false;
      api.liveMode = false;
      clearInterval(pollTimer);
      pollTimer = null;
      return api.trigger(name);
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    try {
      const res = await fetch(`${backendUrl()}/demo/trigger/${name}`, { method: 'POST', signal: ctrl.signal });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail || `HTTP ${res.status}`);
      }
      logFeed(`Demo signal '${name}' sent to the town brain.`);
      enterLiveMode();
    } catch (err) {
      const why = err.name === 'AbortError' || err instanceof TypeError ? 'backend unreachable' : err.message;
      logFeed(`Live demo unavailable (${why}) — playing scripted '${name}'.`);
      await api.trigger(name);
    } finally {
      clearTimeout(timer);
    }
  }

  async function pushClock(body) {
    pullGen++;
    const res = await fetch(`${backendUrl()}/demo/clock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`clock ${res.status}`);
    const data = await res.json();
    if (api.applyTownTime) api.applyTownTime(data.town_time, data.mode, 'push');
    pullSnapshot().catch(() => {});
    return data;
  }

  fetch(`${backendUrl()}/demo/config`)
    .then((r) => r.json())
    .then((cfg) => {
      if (cfg.backend_ok) logFeed('Backend connected. Demo buttons will try the live pipeline first.');
      if (api.applyTownTime) api.applyTownTime(cfg.town_time, cfg.mode);
      enterLiveMode();
    })
    .catch(() => logFeed('Backend offline. Demo buttons use the scripted fallback.'));

  return { triggerViaBackend, enterLiveMode, pushClock };
}

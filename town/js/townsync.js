// Keeps a real town (town/?town=<id>) in step with the database, as the signed-in user, over Supabase Realtime:
// the database pushes each change (a character's new placement, a mood, a bubble, a chat, a schedule or clock change) to
// everyone in the town, instead of every viewer asking the API every 2 seconds. Characters walk client-side
// between decisions, so rows only change when someone decides, a calendar event starts, or the clock moves.
// Everything is derived from database rows, so every viewer sees the same town. The time slider is lighting only
// (sky.js): placements and walks always follow these rows and the server town clock, whatever it shows.
//
// API calls: GET /towns/{id} once on entry (the map; layout.js), then GET /towns/{id}?live=1 only to catch up:
// when the subscription (re)connects, when the tab becomes visible again, when the clock or schedules change,
// and a slow safety sync. The map itself is never re-checked; new houses or a regrown town show on next entry.
import { api, getSupabase } from '../../frontend/shared/session.js';

const SAFETY_SYNC_MS = 60000; // in case a push was missed (e.g. the laptop slept)
const livePath = (townId) => `/towns/${townId}?live=1`;
// A bubble or house mood someone set ({..., until}) shows until it runs out (backend/house.py)
const active = (x) => (x && Date.parse(x.until) > Date.now() ? x : null);
// Without a mood of their own, the town brain's mood for them still shows over the house
const BRAIN_MOOD = { sunny: 'party', rainbow: 'party', rainy: 'rainy', stormy: 'stormy' };

export function startTownSync(townId, initial, t) {
  const placed = {}; // user_id -> action|building|depart already drawn
  let syncGen = 0;
  let syncTimer = null;

  function placementSig(row) {
    const target = row.target || {};
    // x/y is included so a corrected row (same building, now on its door) is applied.
    return `${row.action || ''}|${target.building_id || ''}|${String(target.depart_at || '').slice(0, 16)}|${row.x},${row.y}`;
  }

  function applyAgent(row) {
    const f = t.friends[row.user_id];
    const sig = placementSig(row);
    // A new updated_at with the same walk used to restart them at the house door.
    if (!f || placed[row.user_id] === sig) return;
    const first = !(row.user_id in placed);
    placed[row.user_id] = sig;
    t.placeAgent(f, row);
    const dest = row.target?.building_id;
    if (!first && dest) {
      const where = dest.startsWith('house:') ? `${t.friends[dest.slice(6)]?.name ?? 'a friend'}'s house` : t.PLACES[dest]?.name ?? dest;
      t.logFeed(`${f.name} ${row.action === 'go_home' ? 'heads home' : `heads to ${where}`}.`);
    }
  }

  function applyMember(m) {
    const f = t.friends[m.user_id];
    if (!f) return;
    const houseName = m.home?.name || `${f.name}'s house`; // someone renamed their house: relabel it for everyone
    if (f.home && f.home.name !== houseName) {
      f.home.name = houseName;
      t.refreshHouseLabel(f);
    }
    const status = m.activity || m.mood;
    if (status && f.status !== status) t.setStatus(f.id, status);
    t.setHouseMood(f, active(m.home?.mood)?.kind || BRAIN_MOOD[m.mood] || null);
    t.setPinned(f, active(m.bubble)?.text || null);
  }

  function applyTown(data) {
    for (const row of data.agents || []) applyAgent(row);
    for (const m of data.members || []) applyMember(m);
  }

  // Chat bubbles for a new agent action (only new ones arrive over Realtime, so old chats never replay)
  function applyAction(a) {
    if (a.details?.target_building_id && t.onTrip) t.onTrip(); // a trip: busy places re-glow (heat.js)
    (a.details?.lines || []).forEach((line, i) => {
      const speaker = t.friends[line.speaker_id] || t.friends[a.user_id];
      if (speaker) setTimeout(() => t.say(speaker, line.text, 1700), i * 1800);
    });
  }

  // One catch-up fetch of the live parts (people, moods, schedules, clock): never the map.
  async function sync() {
    const gen = ++syncGen;
    try {
      const data = await api(livePath(townId));
      if (gen !== syncGen) return; // a newer sync started: this one is stale
      if (t.applyTownTime && data.town_time) t.applyTownTime(data.town_time, data.mode);
      if (t.setCalendars) t.setCalendars(data.schedules);
      applyTown(data);
    } catch (e) {
      console.warn('town sync', e);
    }
  }
  // Several pushes in a burst (a calendar event starting for everyone) share one catch-up
  const syncSoon = () => { clearTimeout(syncTimer); syncTimer = setTimeout(sync, 400); };

  async function subscribe() {
    const sb = await getSupabase();
    const { data: { session } } = await sb.auth.getSession();
    if (session) sb.realtime.setAuth(session.access_token); // Realtime checks RLS (members only) as this user
    const town = `town_id=eq.${townId}`;
    const on = (table, event, handler) => ({ table, event, handler });
    const feeds = [
      on('agents', '*', (p) => p.new?.user_id && applyAgent(p.new)),
      on('town_members', '*', (p) => p.new?.user_id && applyMember(p.new)),
      on('agent_actions', 'INSERT', (p) => p.new && applyAction(p.new)),
      on('events', '*', syncSoon), // schedules are built server-side (names, travel); fetch them fresh
      on('town_clock', '*', syncSoon), // someone moved the clock (slider, Fast day, Play)
    ];
    let channel = sb.channel(`town:${townId}`);
    for (const f of feeds) channel = channel.on('postgres_changes', { event: f.event, schema: 'public', table: f.table, filter: town }, f.handler);
    channel.subscribe((status) => {
      // (Re)connected: catch up on anything that changed while we weren't listening
      if (status === 'SUBSCRIBED') sync();
      else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') console.warn('town realtime', status); // supabase-js retries
    });
  }

  if (t.setCalendars) t.setCalendars(initial.schedules);
  applyTown(initial);
  subscribe().catch((e) => console.warn('town realtime', e));
  setInterval(() => { if (!document.hidden) sync(); }, SAFETY_SYNC_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) syncSoon(); });
}

// Keeps a real town (town/?town=<id>) in step with the database, as the signed-in user:
// agents' moves (GET /towns/{id}), moods/activities, and chat bubbles (GET /towns/{id}/activity).
// Everything is derived from database rows, so every viewer sees the same town.
import { api } from '../../frontend/shared/session.js';
import { placementsMatchScreen } from './sky.js';

const POLL_MS = 2000; // ponytail: polling; switch to Supabase Realtime on `agents` if 2s lag or load matters
const backendUrl = () => window.TINY_TOWN_BACKEND || 'http://127.0.0.1:8000';

export function startTownSync(townId, initial, t) {
  const placed = {}; // user_id -> action|building|depart already drawn
  const moodFx = {}; // user_id -> { kind, fx }
  let lastActionId = null;
  let pollGen = 0;

  function placementSig(row) {
    const target = row.target || {};
    // x/y is included so a corrected row (same building, now on its door) is applied.
    return `${row.action || ''}|${target.building_id || ''}|${String(target.depart_at || '').slice(0, 16)}|${row.x},${row.y}`;
  }

  function applyTown(data) {
    for (const row of data.agents || []) {
      const f = t.friends[row.user_id];
      const sig = placementSig(row);
      // A new updated_at with the same walk used to restart them at the house door.
      if (!f || placed[row.user_id] === sig) continue;
      const first = !(row.user_id in placed);
      placed[row.user_id] = sig;
      t.placeAgent(f, row);
      const dest = row.target?.building_id;
      if (!first && dest) {
        const where = dest.startsWith('house:') ? `${t.friends[dest.slice(6)]?.name ?? 'a friend'}'s house` : t.PLACES[dest]?.name ?? dest;
        t.logFeed(`${f.name} ${row.action === 'go_home' ? 'heads home' : `heads to ${where}`}.`);
      }
    }
    for (const m of data.members || []) {
      const f = t.friends[m.user_id];
      if (!f) continue;
      const status = m.activity || m.mood;
      if (status && f.status !== status) t.setStatus(f.id, status);
      const kind = m.mood === 'sunny' || m.mood === 'rainbow' ? 'party' : m.mood === 'rainy' || m.mood === 'stormy' ? 'rain' : null;
      if (moodFx[m.user_id]?.kind === kind) continue;
      moodFx[m.user_id]?.fx?.destroy();
      moodFx[m.user_id] = {
        kind,
        fx: kind === 'party' ? t.partyLights(f.home, { focus: false })
          : kind === 'rain' ? t.rainCloud(f.home, { focus: false }) : null,
      };
    }
  }

  async function pollActivity() {
    const rows = await api(`/towns/${townId}/activity?limit=20${lastActionId === null ? '' : `&after_id=${lastActionId}`}`);
    if (lastActionId === null) { lastActionId = rows[0]?.id ?? 0; return; } // first call: don't replay old chats
    for (const a of [...rows].reverse()) {
      lastActionId = Math.max(lastActionId, a.id);
      (a.details?.lines || []).forEach((line, i) => {
        const speaker = t.friends[line.speaker_id] || t.friends[a.user_id];
        if (speaker) setTimeout(() => t.say(speaker, line.text, 1700), i * 1800);
      });
    }
  }

  async function poll() {
    const gen = ++pollGen;
    try {
      const data = await api(`/towns/${townId}`);
      // A slower poll from the previous hour must not land on top of this one.
      if (gen !== pollGen) return;
      if (data.town_time && !placementsMatchScreen(data.town_time, data.mode)) {
        await pollActivity();
        return;
      }
      if (t.applyTownTime && data.town_time) t.applyTownTime(data.town_time, data.mode, 'poll');
      if (gen !== pollGen) return;
      if (t.setCalendars) t.setCalendars(data.schedules);
      applyTown(data);
      await pollActivity();
    } catch (e) {
      console.warn('town sync', e);
    }
  }

  async function pushClock(body) {
    pollGen++;
    const res = await fetch(`${backendUrl()}/demo/clock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`clock ${res.status}`);
    const data = await res.json();
    const gen = ++pollGen;
    if (t.applyTownTime) t.applyTownTime(data.town_time, data.mode, 'push');
    const town = await api(`/towns/${townId}`);
    if (gen !== pollGen) return data;
    applyTown(town);
    await pollActivity();
    return data;
  }

  if (t.setCalendars) t.setCalendars(initial.schedules);
  applyTown(initial);
  pollActivity().catch((e) => console.warn('town sync', e));
  setInterval(() => { if (!document.hidden) poll(); }, POLL_MS);
  return { pushClock };
}

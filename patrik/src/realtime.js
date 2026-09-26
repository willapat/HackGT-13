// Subscribe to live town tables and map payloads onto the existing Phaser scene.
// Table names match the live schema: town_members (member_state), agents (agent_state).

function backendUrl() {
  return window.TINY_TOWN_BACKEND || 'http://localhost:8000';
}

function buildingDoor(scene, buildingId) {
  if (!buildingId) return null;
  if (buildingId.startsWith('house:')) {
    const uid = buildingId.slice(6);
    const byId = scene.friends[uid];
    if (byId) return byId.home.door;
    const byName = Object.values(scene.friends).find((f) => f.id === uid || f.name.toLowerCase() === uid.toLowerCase());
    return byName ? byName.home.door : null;
  }
  const place = PLACES[buildingId];
  return place ? place.door : null;
}

function friendForUserId(scene, userId) {
  if (scene.friends[userId]) return scene.friends[userId];
  const map = scene.friendByUserId || {};
  if (map[userId]) return map[userId];
  return Object.values(scene.friends).find((f) => f.profileId === userId) || null;
}

async function connectTownRealtime(scene) {
  try {
    const cfg = await fetch(`${backendUrl()}/demo/config`, { signal: AbortSignal.timeout(2500) }).then((r) => r.json());
    if (!cfg.supabase_url || !cfg.supabase_publishable_key || !window.supabase) {
      logFeed('Backend config missing; realtime off. Scripted demo still works.');
      return null;
    }
    scene.ttConfig = cfg;
    const sb = window.supabase.createClient(cfg.supabase_url, cfg.supabase_publishable_key);
    scene.supabase = sb;
    const townId = cfg.demo_town_id;
    if (!townId) {
      logFeed('DEMO_TOWN_ID not set on backend; realtime has no town filter.');
      return sb;
    }
    const tables = ['town_members', 'agents', 'agent_conversations', 'events', 'event_participants', 'news', 'notifications'];
    const noTown = new Set(['event_participants']);
    let ch = sb.channel('tiny-town');
    for (const table of tables) {
      const spec = { event: '*', schema: 'public', table };
      if (!noTown.has(table)) spec.filter = `town_id=eq.${townId}`;
      ch = ch.on('postgres_changes', spec, (payload) => {
        applyRealtime(scene, table, payload);
      });
    }
    await ch.subscribe();
    logFeed('Live town channel connected.');
    return sb;
  } catch (err) {
    logFeed('Realtime offline; using scripted town.');
    return null;
  }
}

function applyRealtime(scene, table, payload) {
  const row = payload.new || payload.old || {};
  if (table === 'town_members') {
    const f = friendForUserId(scene, row.user_id);
    if (!f) return;
    if (row.activity) scene.setStatus(f.id, row.activity);
    else if (row.mood) scene.setStatus(f.id, row.mood);
    const celebrating = (row.activity || '').toLowerCase().includes('celebrat') || row.mood === 'sunny' || row.mood === 'rainbow';
    const rough = row.mood === 'rainy' || row.mood === 'stormy';
    if (celebrating && !scene.effects.goodNews) scene.effects.goodNews = scene.partyLights(f.home);
    if (rough && !scene.effects.roughWeek) scene.effects.roughWeek = scene.rainCloud(f.home);
  }
  if (table === 'agents') {
    const f = friendForUserId(scene, row.user_id);
    if (!f || f.moving) return;
    const bid = (row.target && row.target.building_id) || null;
    const door = buildingDoor(scene, bid);
    if (door && (row.action === 'walk_to' || row.action === 'visit' || row.action === 'go_home' || row.action === 'knock')) {
      scene.walkTo(f, door);
    }
  }
  if (table === 'agent_conversations') {
    const lines = row.lines || [];
    lines.forEach((line, i) => {
      const f = friendForUserId(scene, line.speaker_id);
      if (f) scene.time.delayedCall(i * 1800, () => scene.say(f, line.text, 1700));
    });
  }
  if (table === 'events' && payload.event === 'INSERT') {
    showCard({
      kind: row.type || 'Quest',
      text: row.text || row.title,
      actions: [['Got it', null, true], ['Dismiss']],
    });
    logFeed(`📋 ${row.title || 'New event'}`);
  }
  if (table === 'news' && payload.event === 'INSERT') {
    logFeed(`📰 ${row.text}`);
  }
  if (table === 'notifications' && payload.event === 'INSERT') {
    logFeed(`🔔 ${row.text}`);
  }
}

async function triggerViaBackend(scene, name) {
  if (name === 'reset') return scene.trigger(name);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3000);
  try {
    const res = await fetch(`${backendUrl()}/demo/trigger/${name}`, { method: 'POST', signal: ctrl.signal });
    if (!res.ok) throw new Error(String(res.status));
    logFeed(`Demo signal '${name}' sent to town brain.`);
  } catch (err) {
    logFeed(`Backend unreachable — playing scripted '${name}'.`);
    await scene.trigger(name);
  } finally {
    clearTimeout(timer);
  }
}

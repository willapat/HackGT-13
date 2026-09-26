// Tiny Town (city) rendering sandbox: Phaser 3 + Kenney isometric tiles.
// Character behavior is scripted/random here; it stands in for the real character agents.

const TILE_W = 132; // Kenney tile top face is 132x66
const HALF_W = TILE_W / 2;
const HALF_H = 33;
const N = 12;
// Render at the screen's real pixel density so Retina displays aren't upscaled (blurry) by the browser.
const DPR = Math.min(window.devicePixelRatio || 1, 3);

const A = 'assets/';
const TEX = {
  grass: A + 'isometric-tiles-landscape/PNG/landscapeTiles_067.png',
  roadC: A + 'isometric-tiles-city/PNG/cityTiles_073.png', // runs along columns (screen down-right)
  roadR: A + 'isometric-tiles-city/PNG/cityTiles_081.png', // runs along rows (screen down-left)
  cross: A + 'isometric-tiles-city/PNG/cityTiles_089.png',
  fountain: A + 'isometric-tiles-city/PNG/cityTiles_043.png',
  tree: A + 'isometric-tiles-city/Details/cityDetails_010.png',
};
// Full-tile Kenney buildings (the others in the pack are upper floors/roofs)
const BUILDINGS = [1, 2, 3, 4, 9, 10, 11, 12, 14, 17, 18, 19, 20, 21, 22, 25, 26, 27, 28, 29, 30, 33, 34, 35, 36, 37,
  40, 41, 42, 46, 85, 92, 93, 99, 100, 101, 106, 107, 108, 109, 113, 114, 115, 116, 117, 122, 123, 124, 125];
// Upper-floor piece that matches each ground floor (found by pixel-matching the pack)
const FLOOR_FOR = { 1: 16, 2: 16, 3: 24, 4: 50, 9: 16, 10: 16, 11: 56, 12: 53, 14: 32, 17: 16, 18: 45, 19: 56, 20: 50, 21: 38, 22: 39, 25: 52, 26: 49, 27: 56, 28: 53, 29: 44, 30: 45, 33: 52, 34: 45, 35: 56, 36: 49, 37: 50, 40: 52, 41: 49, 42: 53, 46: 52, 85: 56, 92: 52, 93: 56, 99: 49, 100: 56, 101: 55, 106: 52, 107: 56, 108: 50, 109: 24, 113: 52, 114: 56, 115: 48, 116: 24, 117: 31, 122: 56, 123: 16, 124: 24, 125: 24 };
const FLOOR_H = 30; // vertical step between stacked floors
for (const n of new Set([...BUILDINGS, ...Object.values(FLOOR_FOR)])) {
  TEX['b' + n] = `${A}isometric-tiles-buildings/PNG/buildingTiles_${String(n).padStart(3, '0')}.png`;
}

// ---- City layout -------------------------------------------------------------
// Road grid on rows/cols 2, 6, 10. Every other tile is a building, except the park block.

const ROADS = [2, 6, 10];
const inPark = (c, r) => c >= 7 && c <= 9 && r >= 7 && r <= 9;

const PLACES = {
  library: { name: 'Library', tex: 'b124', c: 3, r: 1, door: [3, 2] },
  gym: { name: 'Boulder Gym', tex: 'b113', c: 5, r: 1, door: [5, 2] },
  cafe: { name: 'Bean There Café', tex: 'b4', c: 7, r: 3, door: [6, 3] },
  market: { name: 'Market', tex: 'b108', c: 9, r: 5, door: [9, 6] },
  park: { name: 'Central Park', door: [7, 8] },
  downtown: { name: 'downtown', door: [6, 6] },
};

const FRIENDS = [
  { id: 'maya', name: 'Maya', color: 0xf0616d, tint: 0xffc9cc, home: { tex: 'b29', c: 1, r: 3, door: [2, 3] } },
  { id: 'jordan', name: 'Jordan', color: 0x4f8ef7, tint: 0xc9dcff, home: { tex: 'b14', c: 3, r: 5, door: [3, 6] } },
  { id: 'sam', name: 'Sam', color: 0x2fb36d, tint: 0xc8f5d8, home: { tex: 'b37', c: 5, r: 7, door: [6, 7] } },
  { id: 'priya', name: 'Priya', color: 0xf2a33a, tint: 0xffe4b8, home: { tex: 'b36', c: 11, r: 7, door: [10, 7] } },
  { id: 'leo', name: 'Leo', color: 0x9b6cf0, tint: 0xe0d0ff, home: { tex: 'b21', c: 1, r: 9, door: [2, 9] } },
];

const TREES = [[9, 7], [7, 9], [9, 9]];

function buildGround() {
  const g = [];
  for (let r = 0; r < N; r++) {
    g.push([]);
    for (let c = 0; c < N; c++) {
      const onR = ROADS.includes(r), onC = ROADS.includes(c);
      g[r].push(onR && onC ? 'cross' : onR ? 'roadC' : onC ? 'roadR' : inPark(c, r) ? 'grass' : 'lot');
    }
  }
  return g;
}

const iso = (c, r) => ({ x: (c - r) * HALF_W, y: (c + r) * HALF_H });

// Kenney character frames: 0=NE 1=E 2=SE 3=S 4=SW 5=W 6=NW 7=N
function dirFromDelta(dx, dy) {
  return (Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) + 1 + 8) % 8;
}

// ---- DOM helpers -------------------------------------------------------------

const $ = (s) => document.querySelector(s);
const hex = (n) => '#' + n.toString(16).padStart(6, '0');

function logFeed(text) {
  const li = document.createElement('li');
  const t = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  li.innerHTML = `<time>${t}</time>`;
  li.append(text);
  $('#feed').prepend(li);
  while ($('#feed').children.length > 60) $('#feed').lastChild.remove();
}

function showCard({ kind, text, color = '#3b6fe0', actions }) {
  const card = document.createElement('div');
  card.className = 'card panel';
  card.style.borderLeftColor = color;
  card.innerHTML = `<div class="kind"></div><div class="text"></div><div class="row"></div>`;
  card.querySelector('.kind').textContent = kind;
  card.querySelector('.text').textContent = text;
  actions.forEach(([label, fn, primary]) => {
    const b = document.createElement('button');
    b.textContent = label;
    if (primary) b.className = 'primary';
    b.onclick = () => { card.remove(); fn && fn(); };
    card.querySelector('.row').append(b);
  });
  $('#cards').append(card);
}

// ---- Scene ---------------------------------------------------------------------

class TownScene extends Phaser.Scene {
  constructor() { super('town'); }

  preload() {
    for (const [k, url] of Object.entries(TEX)) this.load.image(k, url);
    const CH = A + 'isometric-miniature-dungeon/Characters/Male/';
    for (let d = 0; d < 8; d++) {
      this.load.image(`idle${d}`, `${CH}Male_${d}_Idle0.png`);
    }
  }

  create() {
    this.ground = buildGround();
    this.blocked = new Set();
    this.effects = {};
    this.eventOwned = new Set();

    this.makeParticleTextures();
    this.drawGround();
    this.drawObjects();
    this.spawnFriends();
    this.setupCamera();
    this.renderResidents();

    logFeed('Town loaded. Residents are wandering (scripted, not agent-driven).');
    // ?auto=goodNews,climbing fires demo signals a few seconds apart (handy for rehearsals and screenshots)
    const auto = new URLSearchParams(location.search).get('auto');
    auto?.split(',').forEach((t, i) => this.time.delayedCall(1500 + i * 2500, () => this.trigger(t)));
    document.querySelectorAll('[data-trigger]').forEach((b) => {
      b.onclick = () => this.trigger(b.dataset.trigger);
    });
  }

  makeParticleTextures() {
    const g = this.make.graphics({ add: false });
    g.fillStyle(0xffffff).fillRect(0, 0, 6, 4).generateTexture('confetti', 6, 4).clear();
    g.fillStyle(0xa9d4ff).fillRect(0, 0, 2, 9).generateTexture('drop', 2, 9).clear();
    g.fillStyle(0xffffff).fillCircle(4, 4, 4).generateTexture('dot', 8, 8).destroy();
  }

  // Ground tiles all sit below objects; drawn back-to-front.
  drawGround() {
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        if (this.ground[r][c] === 'lot') continue; // buildings bring their own base
        const { x, y } = iso(c, r);
        this.add.image(x, y - HALF_H, this.ground[r][c]).setOrigin(0.5, 0).setDepth(y / 1000);
      }
    }
  }

  // Full-tile objects (buildings, fountain) replace the ground: their slab bottom lines up with the ground's.
  placeBlock(tex, c, r) {
    const { x, y } = iso(c, r);
    const img = this.add.image(x, y + HALF_H * 2, tex).setOrigin(0.5, 1).setDepth(1000 + y);
    this.blocked.add(`${c},${r}`);
    return img;
  }

  drawObjects() {
    for (const p of Object.values(PLACES)) if (p.tex) this.placeBlock(p.tex, p.c, p.r);
    for (const f of FRIENDS) this.placeBlock(f.home.tex, f.home.c, f.home.r);
    // Fill every remaining lot with a building (deterministic pick so the city looks the same each load)
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        if (this.ground[r][c] !== 'lot' || this.blocked.has(`${c},${r}`)) continue;
        const n = BUILDINGS[(c * 7 + r * 13 + c * r) % BUILDINGS.length];
        const base = this.placeBlock('b' + n, c, r);
        // Taller toward downtown (the center), with a little deterministic variation
        const dist = Math.hypot(c - 5.5, r - 5.5);
        const floors = Math.max(0, Math.round(5 - dist * 0.8 + ((c * 3 + r * 5) % 3) - 1));
        for (let k = 1; k <= floors; k++) {
          this.add.image(base.x - base.width / 2 + 16, base.y - base.height - k * FLOOR_H, 'b' + FLOOR_FOR[n])
            .setOrigin(0, 0).setDepth(base.depth + k * 0.01);
        }
      }
    }
    this.placeBlock('fountain', 8, 8).setOrigin(0.5, 0).setY(iso(8, 8).y - HALF_H);
    for (const [c, r] of TREES) {
      const { x, y } = iso(c, r);
      this.add.image(x, y + 6, 'tree').setOrigin(0.5, 1).setScale(1.5).setDepth(1000 + y);
      this.blocked.add(`${c},${r}`);
    }
    // Labels over the public places
    for (const p of Object.values(PLACES)) {
      if (!p.tex) continue;
      const { x, y } = iso(p.c, p.r);
      this.add.text(x, y - 78, p.name, {
        fontFamily: 'system-ui, sans-serif', fontSize: '13px', fontStyle: 'bold', color: '#1f2430',
        backgroundColor: 'rgba(255,255,255,0.8)', padding: { x: 6, y: 2 },
      }).setOrigin(0.5).setResolution(DPR + 1).setDepth(7000);
    }
  }

  walkable(c, r) {
    return c >= 0 && r >= 0 && c < N && r < N && !this.blocked.has(`${c},${r}`);
  }

  findPath(from, to) {
    const key = (c, r) => `${c},${r}`;
    const prev = new Map([[key(...from), null]]);
    const q = [from];
    while (q.length) {
      const [c, r] = q.shift();
      if (c === to[0] && r === to[1]) {
        const path = [];
        for (let k = key(c, r); k; k = prev.get(k)) path.unshift(k.split(',').map(Number));
        return path.slice(1);
      }
      for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const n = [c + dc, r + dr];
        if (!prev.has(key(...n)) && this.walkable(...n)) {
          prev.set(key(...n), key(c, r));
          q.push(n);
        }
      }
    }
    return null;
  }

  // ---- Friends ---------------------------------------------------------------

  spawnFriends() {
    this.friends = {};
    FRIENDS.forEach((def, i) => {
      const [c, r] = def.home.door;
      const { x, y } = iso(c, r);
      const f = { ...def, tile: [c, r], status: 'Just vibing', busy: false, moving: false, token: 0,
        nextThink: 1500 + i * 2500, off: { x: (i % 3 - 1) * 10, y: ((i + 1) % 3 - 1) * 5 } };

      const shadow = this.add.ellipse(0, 0, 30, 12, 0x000000, 0.22);
      const ring = this.add.ellipse(0, 0, 34, 15).setStrokeStyle(2.5, def.color);
      f.sprite = this.add.sprite(0, 0, 'idle3').setOrigin(0.5, 0.893).setScale(0.36).setTint(def.tint);
      const label = this.add.text(0, -60, def.name, {
        fontFamily: 'system-ui, sans-serif', fontSize: '12px', fontStyle: 'bold', color: '#fff',
        backgroundColor: hex(def.color), padding: { x: 5, y: 1 },
      }).setOrigin(0.5).setResolution(DPR + 1);
      f.container = this.add.container(x + f.off.x, y + f.off.y, [shadow, ring, f.sprite, label]);
      f.container.setSize(40, 60).setInteractive({ useHandCursor: true, hitArea: new Phaser.Geom.Rectangle(-20, -60, 40, 64), hitAreaCallback: Phaser.Geom.Rectangle.Contains });
      f.container.on('pointerdown', () => this.focusFriend(f.id));
      f.container.setDepth(1001 + y);
      this.friends[f.id] = f;
    });
  }

  setFacing(f, dir) {
    f.sprite.setTexture(`idle${dir}`);
  }

  // The Kenney pack only has a sprint cycle, so walking is the standing pose with a gentle step bob.
  startStroll(f) {
    if (f.stroll) return;
    f.stroll = this.tweens.add({
      targets: f.sprite, y: -3, angle: { from: -2.5, to: 2.5 }, duration: 320, yoyo: true, repeat: -1, ease: 'Sine.InOut',
    });
  }

  stopStroll(f) {
    f.stroll?.remove();
    f.stroll = null;
    f.sprite.setY(0).setAngle(0);
  }

  face(f, other) {
    this.setFacing(f, dirFromDelta(other.container.x - f.container.x, other.container.y - f.container.y));
  }

  // Walk tile-by-tile along a BFS path. Resolves false if interrupted.
  walkTo(f, target) {
    const path = this.findPath(f.tile, target);
    const token = ++f.token;
    f.container.setAlpha(1);
    if (!path || !path.length) return Promise.resolve(!!path);
    f.moving = true;
    return new Promise((resolve) => {
      f.cancel = () => resolve(false);
      const step = (i) => {
        if (token !== f.token) return resolve(false);
        if (i >= path.length) {
          f.moving = false;
          this.stopStroll(f);
          return resolve(true);
        }
        const [c, r] = path[i];
        const { x, y } = iso(c, r);
        const tx = x + f.off.x, ty = y + f.off.y;
        const dir = dirFromDelta(tx - f.container.x, ty - f.container.y);
        this.setFacing(f, dir);
        this.startStroll(f);
        f.tile = [c, r];
        this.tweens.add({
          targets: f.container, x: tx, y: ty, duration: 1100,
          onUpdate: () => f.container.setDepth(1001 + f.container.y),
          onComplete: () => step(i + 1),
        });
      };
      step(0);
    });
  }

  interrupt(f) {
    f.token++;
    this.tweens.killTweensOf(f.container);
    f.cancel?.();
    f.moving = false;
    f.busy = true;
    f.container.setAlpha(1);
    this.stopStroll(f);
  }

  release(f, delay = 0) {
    this.time.delayedCall(delay, () => {
      if (this.eventOwned.has(f.id)) return;
      f.busy = false;
      f.nextThink = this.time.now + 8000 + Math.random() * 12000;
    });
  }

  say(f, text, ms = 2600) {
    f.bubble?.destroy();
    const t = this.add.text(0, 0, text, {
      fontFamily: 'system-ui, sans-serif', fontSize: '13px', color: '#1f2430', align: 'center', wordWrap: { width: 150 },
    }).setOrigin(0.5).setResolution(DPR + 1);
    const w = t.width + 16, h = t.height + 10;
    const g = this.add.graphics();
    g.fillStyle(0xffffff, 0.96).fillRoundedRect(-w / 2, -h / 2, w, h, 8);
    g.fillTriangle(-6, h / 2 - 1, 6, h / 2 - 1, 0, h / 2 + 7);
    g.lineStyle(1, 0x000000, 0.12).strokeRoundedRect(-w / 2, -h / 2, w, h, 8);
    const bubble = this.add.container(0, 0, [g, t]).setDepth(8000).setScale(0.6);
    bubble.h = h;
    f.bubble = bubble;
    this.tweens.add({ targets: bubble, scale: 1, duration: 180, ease: 'Back.Out' });
    return new Promise((resolve) => this.time.delayedCall(ms, () => {
      if (f.bubble === bubble) f.bubble = null;
      this.tweens.add({ targets: bubble, alpha: 0, duration: 200, onComplete: () => bubble.destroy() });
      resolve();
    }));
  }

  wait(ms) { return new Promise((r) => this.time.delayedCall(ms, r)); }

  // Walk two friends to a spot and stand them facing each other.
  async meet(a, b, spot) {
    const [c, r] = spot;
    const next = [[c + 1, r], [c - 1, r], [c, r + 1], [c, r - 1]].find((n) => this.walkable(...n)) || spot;
    const [okA, okB] = await Promise.all([this.walkTo(a, spot), this.walkTo(b, next)]);
    if (okA && okB) { this.face(a, b); this.face(b, a); }
    return okA && okB;
  }

  // ---- Scripted wander loop (stand-in for character agents) -----------------------

  update(time) {
    for (const f of Object.values(this.friends)) {
      if (f.bubble) f.bubble.setPosition(f.container.x, f.container.y - 78 - f.bubble.h / 2);
      if (!f.busy && !f.moving && time > f.nextThink) this.think(f);
    }
  }

  async think(f) {
    f.busy = true;
    const roll = Math.random();
    const places = Object.values(PLACES);
    const idle = Object.values(this.friends).filter((o) => o !== f && !o.busy && !o.moving);

    if (roll < 0.2 && idle.length) {
      const o = Phaser.Utils.Array.GetRandom(idle);
      const p = Phaser.Utils.Array.GetRandom(places);
      o.busy = true;
      logFeed(`${f.name} and ${o.name} meet at ${p.name}.`);
      if (await this.meet(f, o, p.door)) {
        await this.say(f, '👋', 1600);
        await this.say(o, '👋 😄', 1600);
      }
      this.release(o, 500);
    } else if (roll < 0.35) {
      logFeed(`${f.name} heads home.`);
      if (await this.walkTo(f, f.home.door)) {
        this.tweens.add({ targets: f.container, alpha: 0, duration: 400 });
        await this.wait(15000);
      }
    } else if (roll < 0.85) {
      const p = Phaser.Utils.Array.GetRandom(places);
      logFeed(`${f.name} walks to ${p.name}.`);
      await this.walkTo(f, p.door);
    }
    this.release(f);
  }

  // ---- Demo signal triggers ----------------------------------------------------------

  claim(...ids) {
    return ids.map((id) => { this.eventOwned.add(id); const f = this.friends[id]; this.interrupt(f); return f; });
  }

  unclaim(...ids) {
    ids.forEach((id) => { this.eventOwned.delete(id); this.release(this.friends[id]); });
  }

  setStatus(id, status) {
    this.friends[id].status = status;
    this.renderResidents();
  }

  async trigger(name) {
    if (name === 'reset') return this.resetTown();
    if (this.effects[name]) return;

    if (name === 'goodNews') {
      this.setStatus('maya', 'Landed the internship 🎉');
      logFeed('📰 Town brain: Maya shared good news (landed the internship).');
      this.effects.goodNews = this.partyLights(FRIENDS[0].home);
      const [maya, leo, sam] = this.claim('maya', 'leo', 'sam');
      const door = maya.home.door;
      const [spotA, spotB = door] = [[1, 0], [-1, 0], [0, 1], [0, -1]]
        .map(([dc, dr]) => [door[0] + dc, door[1] + dr]).filter((n) => this.walkable(...n));
      await this.walkTo(maya, door);
      this.say(maya, '🎉🎉🎉', 3000);
      await Promise.all([this.walkTo(leo, spotA), this.walkTo(sam, spotB)]);
      this.face(leo, maya); this.face(sam, maya); this.face(maya, leo);
      await this.say(leo, 'Congrats Maya!!', 2000);
      await this.say(sam, 'Huge news 🥳', 2000);
      showCard({
        kind: 'Good news', color: '#f0616d',
        text: 'Maya landed the internship. Want to celebrate with her in real life?',
        actions: [
          ['Plan a celebration dinner', () => logFeed('✅ You approved a celebration plan. An action agent would check calendars and draft invites next (not built yet).'), true],
          ['Draft a congrats text', () => logFeed('✍️ Drafted a congrats message for you to review. Nothing is sent without you.')],
          ['Dismiss'],
        ],
      });
      this.unclaim('maya', 'leo', 'sam');
    }

    if (name === 'climbing') {
      this.setStatus('sam', 'Wants to try climbing 🧗');
      this.setStatus('priya', 'Wants to try climbing 🧗');
      logFeed('🔗 Town brain: Sam and Priya both mentioned wanting to try climbing.');
      this.effects.climbing = true;
      const [sam, priya] = this.claim('sam', 'priya');
      this.focusTile(PLACES.gym.door);
      if (await this.meet(sam, priya, PLACES.gym.door)) {
        await this.say(sam, 'Wait, you want to try climbing too?', 2400);
        await this.say(priya, 'Yes! Been meaning to for ages 🧗', 2400);
      }
      showCard({
        kind: 'Quest', color: '#2fb36d',
        text: 'Sam and Priya both want to try climbing. Suggest a beginner session at Boulder Gym this Saturday?',
        actions: [
          ['Suggest to both', () => logFeed('✅ Suggestion queued. Sam and Priya each approve before anything is sent.'), true],
          ['Not now'],
        ],
      });
      this.unclaim('sam', 'priya');
    }

    if (name === 'roughWeek') {
      this.setStatus('jordan', 'Having a rough week');
      logFeed('🌧️ Town brain: Jordan shared that this week has been rough.');
      this.effects.roughWeek = this.rainCloud(FRIENDS[1].home);
      const [jordan] = this.claim('jordan');
      if (await this.walkTo(jordan, jordan.home.door)) {
        this.tweens.add({ targets: jordan.container, alpha: 0, duration: 500 });
      }
      showCard({
        kind: 'Check in', color: '#4f8ef7',
        text: "Jordan's having a rough week. A quick message or a coffee could mean a lot.",
        actions: [
          ['Draft a check-in', () => logFeed('✍️ Drafted a check-in for Jordan for you to review. Nothing is sent without you.'), true],
          ['Invite for coffee', () => logFeed('☕ Coffee invite drafted for your approval.')],
          ['Later'],
        ],
      });
      // Jordan stays home (claimed) until reset.
    }
  }

  resetTown() {
    for (const e of Object.values(this.effects)) if (e && e.destroy) e.destroy();
    this.effects = {};
    $('#cards').innerHTML = '';
    for (const f of Object.values(this.friends)) {
      f.status = 'Just vibing';
      this.eventOwned.delete(f.id);
      f.container.setAlpha(1);
      if (f.busy && !f.moving) this.release(f);
    }
    this.renderResidents();
    logFeed('↺ Town reset.');
  }

  // ---- Effects ------------------------------------------------------------------------

  partyLights(home) {
    const { x, y } = iso(home.c, home.r);
    const group = this.add.container(0, 0).setDepth(6000);
    const colors = [0xff5d73, 0xffd23f, 0x3ddc97, 0x4fb3ff, 0xc77dff];
    const g = this.add.graphics().lineStyle(1.5, 0x333333, 0.6);
    const pts = [];
    for (let i = 0; i <= 10; i++) {
      const t = i / 10;
      pts.push(new Phaser.Math.Vector2(x - 48 + 96 * t, y - 66 + Math.sin(t * Math.PI) * 14 - t * 20));
    }
    g.strokePoints(pts);
    group.add(g);
    pts.forEach((p, i) => {
      const bulb = this.add.image(p.x, p.y + 3, 'dot').setTint(colors[i % colors.length]).setScale(0.9);
      this.tweens.add({ targets: bulb, alpha: 0.25, duration: 300 + (i % 3) * 120, yoyo: true, repeat: -1 });
      group.add(bulb);
    });
    const confetti = this.add.particles(x, y - 80, 'confetti', {
      speed: { min: 60, max: 170 }, angle: { min: 235, max: 305 }, gravityY: 240, lifespan: 1500,
      frequency: 70, rotate: { min: 0, max: 360 }, tint: colors, alpha: { start: 1, end: 0.2 },
    }).setDepth(6001);
    this.focusTile([home.c, home.r]);
    return { destroy: () => { group.destroy(); confetti.destroy(); } };
  }

  rainCloud(home) {
    const { x, y } = iso(home.c, home.r);
    const cloud = this.add.container(x, y - 130).setDepth(6002);
    const g = this.add.graphics();
    g.fillStyle(0x8a94a6);
    [[-26, 6, 16], [-8, -4, 20], [14, 0, 18], [30, 8, 13], [0, 10, 18]].forEach(([cx, cy, r]) => g.fillCircle(cx, cy, r));
    g.fillStyle(0xa3adbd).fillCircle(-10, -8, 12);
    cloud.add(g);
    this.tweens.add({ targets: cloud, y: y - 124, duration: 1400, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' });
    const rain = this.add.particles(x, y - 110, 'drop', {
      emitZone: { type: 'random', source: new Phaser.Geom.Rectangle(-34, 0, 68, 4) },
      speedY: { min: 240, max: 300 }, lifespan: 260, frequency: 25, alpha: { start: 0.9, end: 0.4 },
    }).setDepth(6001);
    this.focusTile([home.c, home.r]);
    return { destroy: () => { cloud.destroy(); rain.destroy(); } };
  }

  // ---- Camera & UI --------------------------------------------------------------------

  setupCamera() {
    const cam = this.cameras.main;
    const fit = () => {
      const { width, height } = this.scale;
      cam.setZoom(Phaser.Math.Clamp(Math.min(width / 1750, height / 950), 0.35 * DPR, 1.4 * DPR));
      cam.centerOn(0, (N - 1) * HALF_H);
    };
    fit();
    this.scale.on('resize', fit);
    this.input.on('pointermove', (p) => {
      if (!p.isDown) return;
      cam.scrollX -= (p.x - p.prevPosition.x) / cam.zoom;
      cam.scrollY -= (p.y - p.prevPosition.y) / cam.zoom;
    });
    this.input.on('wheel', (p, objs, dx, dy) => {
      cam.setZoom(Phaser.Math.Clamp(cam.zoom * (dy > 0 ? 0.9 : 1.1), 0.3 * DPR, 2.5 * DPR));
    });
  }

  focusTile([c, r]) {
    const { x, y } = iso(c, r);
    this.cameras.main.pan(x, y, 700, 'Sine.easeInOut');
  }

  focusFriend(id) {
    const f = this.friends[id];
    this.cameras.main.pan(f.container.x, f.container.y, 600, 'Sine.easeInOut');
    this.tweens.add({ targets: f.container, scale: 1.25, duration: 160, yoyo: true });
    logFeed(`${f.name}: ${f.status}`);
  }

  renderResidents() {
    const ul = $('#residents');
    ul.innerHTML = '';
    for (const f of Object.values(this.friends)) {
      const li = document.createElement('li');
      li.style.cursor = 'pointer';
      li.innerHTML = `<span class="dot" style="background:${hex(f.color)}"></span><div><b></b><div class="status"></div></div>`;
      li.querySelector('b').textContent = f.name;
      li.querySelector('.status').textContent = f.status;
      li.onclick = () => this.focusFriend(f.id);
      ul.append(li);
    }
  }
}

const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'game',
  backgroundColor: '#9fd3ec',
  scale: { mode: Phaser.Scale.NONE, width: window.innerWidth * DPR, height: window.innerHeight * DPR, zoom: 1 / DPR },
  scene: TownScene,
});
window.addEventListener('resize', () => game.scale.resize(window.innerWidth * DPR, window.innerHeight * DPR));

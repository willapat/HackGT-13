// Town card art: the real town, drawn as a small isometric picture from its stored tiles (the same grid the
// 3D town builds from). Roads, parks, ponds, farms and plazas are where they really are; friends' houses get
// their roof in that friend's color; empty lots become buildings sized like the 3D town zones them (tall in
// the middle, houses at the edge). Drawn once per layout and cached as an image.

const cache = new Map();
const BANNER_W = 780, BANNER_H = 240; // about 2x the card banner (same shape), so it stays crisp

const GROUND = {
  road: '#8b909c', driveway: '#cfc8bc', plaza: '#e4ddcf', patio: '#e4ddcf', farm: '#d6b25f',
  pond: '#4fb0e6', water: '#4fb0e6', fountain: '#e4ddcf', stadium: '#c9ced6',
};
const GRASS = '#8fd07a';
const FACADES = ['#f1ece4', '#dfe5ee', '#f4e7cf', '#d5dde8', '#ecd9cc', '#e2e8dc'];

const hash = (x, y) => { const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return s - Math.floor(s); };
const shade = (hex, f) => {
  const n = parseInt(hex.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.max(0, Math.min(255, Math.round(v * f))));
  return `rgb(${c.join(',')})`;
};

// What stands on a tile: ground color plus an optional object
function classify(kind, x, y, n, m, homesAt, bgColor, roadNear) {
  if (kind in GROUND) return { ground: GROUND[kind], kind };
  if (kind === 'home') return { ground: GRASS, obj: 'house', roof: homesAt.get(`${x},${y}`) || '#d9534f', owned: true };
  if (['tree', 'oak'].includes(kind)) return { ground: GRASS, obj: kind };
  if (kind === 'garden') return { ground: GRASS, obj: 'flowers' };
  if (kind === 'picnic') return { ground: GRASS, obj: 'picnic' };
  if (kind === 'path') return { ground: GRASS, obj: 'path' };
  if (kind.includes('/')) { // an explicit model key
    if (/house|suburban/.test(kind)) return { ground: GRASS, obj: 'house', roof: bgColor || '#9aa4b1' };
    if (/skyscraper|sky-big/.test(kind)) return { ground: GROUND.plaza, obj: 'tower', h: 2.2 };
    if (/sky-small|building-[glm]\b|building-l/.test(kind)) return { ground: GROUND.plaza, obj: 'tower', h: 1.6 };
    return { ground: GROUND.plaza, obj: 'shop', h: 0.75 };
  }
  if (kind === 'lot') {
    if (!roadNear) return { ground: GRASS, obj: hash(x, y) < 0.6 ? 'tree' : null }; // courtyard
    // Same idea as the 3D town's ZONES: tallest near the middle, houses toward the edge
    const d = Math.hypot(x - (n - 1) / 2, y - (m - 1) / 2) * (13 / Math.max(n, m));
    if (d < 2.4) return { ground: GROUND.plaza, obj: 'tower', h: 2 + hash(x, y) * 0.9 };
    if (d < 3.6) return { ground: GROUND.plaza, obj: 'tower', h: 1.3 + hash(x, y) * 0.6 };
    if (d < 4.8) return { ground: GROUND.plaza, obj: 'shop', h: 0.7 + hash(x, y) * 0.4 };
    return hash(x, y) < 0.55 ? { ground: GRASS, obj: 'house', roof: bgColor || '#b8a393' } : { ground: GRASS, obj: 'tree' };
  }
  return { ground: GRASS }; // park, yard, bench-*, and anything unknown
}

// `whole: true` draws the entire map (the create-town preview) instead of the card banner's close-up
export function drawTown(layout, { whole = false } = {}) {
  const key = JSON.stringify(layout) + whole;
  if (cache.has(key)) return cache.get(key);
  const tiles = layout.tiles;
  const m = tiles.length, n = tiles[0].length;
  const [W, H] = whole ? [760, 470] : [BANNER_W, BANNER_H];
  const canvas = Object.assign(document.createElement('canvas'), { width: W, height: H });
  const g = canvas.getContext('2d');

  // Banner: zoomed in on the middle of town: the grid spans most of the width and the far and near corners crop
  // off, like looking down a street at the center with the edge of town trailing away. Whole: all of it, sitting
  // at the bottom so buildings have room to rise.
  const tw = (W * (whole ? 0.94 : 0.8)) / ((n + m) / 2);
  const th = tw / 2;
  const ox = W / 2 - ((n - m) * tw) / 4;
  const oy = whole ? H - 18 - (n + m) * th / 2 : H * 0.62 - (n + m) * th / 4;
  const P = (x, y, z = 0) => [ox + (x - y) * tw / 2, oy + (x + y) * th / 2 - z * tw];

  const homesAt = new Map();
  for (const h of layout.homes || []) homesAt.set(`${h.x},${h.y}`, h.color);
  const at = (x, y) => (tiles[y] && tiles[y][x]) || null;
  const roadNear = (x, y) => [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => at(x + dx, y + dy) === 'road');

  const poly = (pts, fill) => { g.beginPath(); pts.forEach(([a, b], i) => (i ? g.lineTo(a, b) : g.moveTo(a, b))); g.closePath(); g.fillStyle = fill; g.fill(); };
  // A box on tile (x, y), inset by `pad`, `h` tiles tall
  function box(x, y, pad, h, top, left, right) {
    const [x0, y0, x1, y1] = [x + pad, y + pad, x + 1 - pad, y + 1 - pad];
    poly([P(x0, y1, 0), P(x1, y1, 0), P(x1, y1, h), P(x0, y1, h)], left);
    poly([P(x1, y0, 0), P(x1, y1, 0), P(x1, y1, h), P(x1, y0, h)], right);
    poly([P(x0, y0, h), P(x1, y0, h), P(x1, y1, h), P(x0, y1, h)], top);
    return [x0, y0, x1, y1];
  }
  // Windows on the two visible faces
  function windows(x0, y0, x1, y1, h, lit) {
    const rows = Math.max(1, Math.floor(h * 5)), cols = 3;
    for (let r = 0; r < rows; r++) {
      const z0 = (r + 0.3) / rows * h, z1 = z0 + h / rows * 0.45;
      for (let c = 0; c < cols; c++) {
        const a = x0 + (x1 - x0) * (c + 0.25) / cols, b = x0 + (x1 - x0) * (c + 0.7) / cols;
        poly([P(a, y1, z0), P(b, y1, z0), P(b, y1, z1), P(a, y1, z1)], hash(a * 7, z0 * 3) < lit ? 'rgba(255,236,170,0.9)' : 'rgba(70,95,130,0.45)');
        const e = y0 + (y1 - y0) * (c + 0.25) / cols, f = y0 + (y1 - y0) * (c + 0.7) / cols;
        poly([P(x1, e, z0), P(x1, f, z0), P(x1, f, z1), P(x1, e, z1)], hash(e * 5, z1 * 9) < lit ? 'rgba(255,236,170,0.8)' : 'rgba(55,75,105,0.45)');
      }
    }
  }

  // Ground slab under the whole town
  const edge = 0.18;
  poly([P(0, m, 0), P(n, m, 0), P(n, m, -edge), P(0, m, -edge)], '#6f9a55');
  poly([P(n, 0, 0), P(n, m, 0), P(n, m, -edge), P(n, 0, -edge)], '#5c8446');

  // Painter's order: back to front
  for (let s = 0; s <= n + m - 2; s++) {
    for (let y = 0; y < m; y++) {
      const x = s - y;
      if (x < 0 || x >= n) continue;
      const kind = String(at(x, y) || 'park');
      const t = classify(kind, x, y, n, m, homesAt, layout.background_color, roadNear(x, y));
      poly([P(x, y), P(x + 1, y), P(x + 1, y + 1), P(x, y + 1)], t.ground);
      if (kind === 'road') { // lane marking along the road's direction
        const horiz = at(x - 1, y) === 'road' || at(x + 1, y) === 'road';
        const vert = at(x, y - 1) === 'road' || at(x, y + 1) === 'road';
        if (horiz !== vert) {
          const [a, b] = horiz ? [P(x + 0.35, y + 0.5), P(x + 0.65, y + 0.5)] : [P(x + 0.5, y + 0.35), P(x + 0.5, y + 0.65)];
          g.strokeStyle = 'rgba(255,255,255,0.55)'; g.lineWidth = Math.max(1, tw / 18);
          g.beginPath(); g.moveTo(...a); g.lineTo(...b); g.stroke();
        }
      }
      if (kind === 'pond' || kind === 'water' || kind === 'fountain') poly([P(x + 0.3, y + 0.3), P(x + 0.7, y + 0.3), P(x + 0.7, y + 0.7), P(x + 0.3, y + 0.7)], kind === 'fountain' ? '#6cc3f0' : 'rgba(255,255,255,0.25)');
      if (kind === 'farm') for (let i = 1; i < 4; i++) poly([P(x + i / 4 - 0.04, y + 0.08), P(x + i / 4 + 0.04, y + 0.08), P(x + i / 4 + 0.04, y + 0.92), P(x + i / 4 - 0.04, y + 0.92)], '#b8923f');
      if (kind === 'stadium') box(x, y, 0.02, 0.12, '#79c065', '#aab1bc', '#959dab');
      if (t.obj === 'path') poly([P(x + 0.4, y), P(x + 0.6, y), P(x + 0.6, y + 1), P(x + 0.4, y + 1)], '#d7c29a');
      if (t.obj === 'flowers') for (let i = 0; i < 5; i++) { const [a, b] = P(x + 0.2 + hash(x + i, y) * 0.6, y + 0.2 + hash(y + i, x) * 0.6); g.fillStyle = ['#ff7eb3', '#ffd166', '#ffffff'][i % 3]; g.fillRect(a - tw / 22, b - tw / 22, tw / 11, tw / 11); }
      if (t.obj === 'picnic') { const [a, b] = P(x + 0.5, y + 0.5); g.fillStyle = '#e4574c'; g.fillRect(a - tw / 8, b - tw / 16, tw / 4, tw / 8); }
      if (t.obj === 'tree' || t.obj === 'oak') {
        const [a, b] = P(x + 0.5, y + 0.5);
        const r = tw * (t.obj === 'oak' ? 0.3 : 0.22);
        g.fillStyle = 'rgba(0,0,0,0.15)'; g.beginPath(); g.ellipse(a, b, r, r / 2, 0, 0, 7); g.fill();
        g.fillStyle = '#6b4a2b'; g.fillRect(a - tw / 40, b - r * 1.2, tw / 20, r * 1.2);
        g.fillStyle = t.obj === 'oak' ? '#2f8a3e' : '#3f9a4a'; g.beginPath(); g.arc(a, b - r * 1.5, r, 0, 7); g.fill();
        g.fillStyle = 'rgba(255,255,255,0.18)'; g.beginPath(); g.arc(a - r * 0.3, b - r * 1.8, r * 0.45, 0, 7); g.fill();
      }
      if (t.obj === 'house') {
        const wall = '#f4efe6', h = 0.32;
        const [x0, y0, x1, y1] = box(x, y, 0.2, h, wall, shade('#f4efe6', 0.86), shade('#f4efe6', 0.72));
        const apex = P((x0 + x1) / 2, (y0 + y1) / 2, h + 0.3);
        poly([P(x0, y1, h), P(x1, y1, h), apex], shade(t.roof, 0.9));
        poly([P(x1, y0, h), P(x1, y1, h), apex], shade(t.roof, 0.7));
        poly([P(x0, y0, h), P(x0, y1, h), apex], t.roof);
        if (t.owned) { const [a, b] = P(x1 - 0.12, y1, 0.02); g.fillStyle = shade(t.roof, 0.6); g.fillRect(a - tw / 16, b - tw / 7, tw / 8, tw / 7); } // door
      }
      if (t.obj === 'tower' || t.obj === 'shop') {
        const facade = FACADES[Math.floor(hash(x, y) * FACADES.length)];
        const pad = t.obj === 'tower' ? 0.14 : 0.1;
        const [x0, y0, x1, y1] = box(x, y, pad, t.h, shade(facade, 1.04), shade(facade, 0.84), shade(facade, 0.68));
        windows(x0, y0, x1, y1, t.h, 0.25);
        if (t.obj === 'shop') poly([P(x0, y1, 0.32), P(x1, y1, 0.32), P(x1, y1 + 0.08, 0.24), P(x0, y1 + 0.08, 0.24)], ['#e4574c', '#3a8be8', '#2fb36d', '#f2a33a'][Math.floor(hash(y, x) * 4)]); // awning
        if (t.obj === 'tower' && t.h > 1.8) box((x0 + x1) / 2 - 0.5, (y0 + y1) / 2 - 0.5, 0.38, t.h + 0.12, '#c6ccd6', '#aab1bc', '#959dab'); // rooftop unit
      }
    }
  }
  const url = canvas.toDataURL('image/png');
  cache.set(key, url);
  return url;
}

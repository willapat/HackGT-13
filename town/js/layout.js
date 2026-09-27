// What town is drawn: town/?town=<id> loads it from the database (GET /towns/{id}): tiles, map places,
// members' homes and looks. Without it, the hard-coded demo town is drawn. Grid helpers live here too.
import * as THREE from 'three';
import { api } from '../../frontend/shared/session.js';
import { sp, SUB } from './assets.js';

export const TOWN_ID = new URLSearchParams(location.search).get('town');
export const TOWN = TOWN_ID ? await api(`/towns/${TOWN_ID}`).catch((e) => {
  document.body.innerHTML = `<p style="font:16px sans-serif;padding:24px">Couldn't load this town: ${e.message}. <a href="../frontend/">Back</a></p>`;
  throw e;
}) : null;
export const TILES = TOWN?.town.tiles;
export const LANDSCAPE = TOWN?.town.map?.landscape || 'green'; // green | autumn | snowy | desert (models.js, sky.js)
export const DRAWN = Boolean(TOWN?.town.map?.drawn); // the model drew this town freely (backend/towngen/freeform.py), not the classic city
export const tileAt = (c, r) => TILES?.[r]?.[c];
export const tilesOf = (kind) => TILES ? TILES.flatMap((row, r) => row.flatMap((k, c) => (k === kind ? [[c, r]] : []))) : [];

// Rectangular maps are drawn in an N x N square; tiles outside the map are left empty.
export const N = TILES ? Math.max(TILES.length, ...TILES.map((row) => row.length)) : 17;
// Roads that run the full width/height of the map (buildCity's lamps and suburbs follow these)
export const ROADS = TILES
  ? [...Array(N).keys()].filter((i) => TILES[i]?.every((k) => k === 'road') || TILES.every((row) => row[i] === 'road'))
  : [2, 6, 10, 14];
// ponytail: one CENTER is used for both axes, so the pond should sit on the diagonal (x === y); split into CX/CY if not
export const CENTER = TILES ? (tilesOf('pond')[0]?.[0] ?? Math.floor(N / 2)) : 8; // the park sits at the middle; the skyline rings it
const PARKISH = new Set(['park', 'pond', 'tree', 'path', 'sand']); // walkable ground (path = grass with a dirt track)
export const inPark = TILES ? (c, r) => PARKISH.has(tileAt(c, r)) : (c, r) => c >= 7 && c <= 9 && r >= 7 && r <= 9;
export const isRoad = TILES ? (c, r) => tileAt(c, r) === 'road' || tileAt(c, r) === 'bridge' : (c, r) => ROADS.includes(c) || ROADS.includes(r);
// Tile words from backend/town_map.py; any other word is an explicit model (asset path without assets/ and .glb)
const TILE_KINDS = new Set(['road', 'park', 'pond', 'tree', 'path', 'stadium', 'farm', 'home', 'driveway', 'yard', 'lot',
  'garden', 'picnic', 'plaza', 'patio', 'oak', 'fountain', 'water', 'bench-n', 'bench-s', 'bench-e', 'bench-w',
  'forest', 'lake', 'rocks', 'campfire', 'sand', 'bridge']); // all after 'lot' are scenery (DECOR in buildCity); sand is walkable
const asset = (k) => `assets/${k}.glb`;

// Grid blocks between the roads: cols/rows 0-1, 3-5, 7-9, 11-13, 15-16
const block = (c0, c1, r0, r1) => { const t = []; for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) t.push([c, r]); return t; };
export const STADIUM = TILES
  ? { model: TOWN.town.map?.landmarks?.stadium?.model ? asset(TOWN.town.map.landmarks.stadium.model) : sp('building-stadium'), tiles: tilesOf('stadium') }
  : { model: sp('building-stadium'), tiles: block(11, 13, 11, 13) }; // a full 3x3 city block
export const FARM = { tiles: TILES ? tilesOf('farm') : block(0, 1, 15, 16) };
export const PLACES = TILES ? Object.fromEntries(Object.entries(TOWN.town.map?.places || {}).map(([id, p]) => [id, {
  name: p.name, ...(p.model ? { model: asset(p.model) } : {}), c: p.tile[0], r: p.tile[1], door: p.door,
}])) : {
  library: { name: 'Library', model: sp('building-books-shop'), c: 3, r: 1, door: [3, 2] },
  gym: { name: 'Boulder Gym', model: sp('building-auto-service'), c: 5, r: 1, door: [5, 2] },
  cafe: { name: 'Bean There Café', model: sp('building-coffee-shop'), c: 7, r: 3, door: [6, 3] },
  market: { name: 'Market', model: sp('building-super-market'), c: 9, r: 5, door: [9, 6] },
  park: { name: 'Central Park', c: 8, r: 7, door: [8, 6] },
  downtown: { name: 'downtown', c: 7, r: 5, door: [7, 6] },
};

// Each friend owns a whole outer block. Their house sits back from the street on `house`, with a
// driveway on `c,r` leading to the road at `door` (where people stand when visiting). Colors are
// picked to stand out from the scenery (no greens, blues, greys or browns).
const DEMO_FRIENDS = [
  { id: 'maya', name: 'Maya', color: '#ff3b30', model: 'character-female-a', block: block(0, 1, 3, 5), home: { model: sp('building-house-01-color01'), house: [0, 4], c: 1, r: 4, door: [2, 4] } },
  { id: 'jordan', name: 'Jordan', color: '#ff2d95', model: 'character-male-b', block: block(11, 13, 0, 1), home: { model: `${SUB}building-type-k.glb`, house: [12, 0], c: 12, r: 1, door: [12, 2] } },
  { id: 'sam', name: 'Sam', color: '#ffd60a', model: 'character-male-d', block: block(3, 5, 15, 16), home: { model: sp('building-house-03-color01'), house: [4, 16], c: 4, r: 15, door: [4, 14] } },
  { id: 'priya', name: 'Priya', color: '#ff9500', model: 'character-female-c', block: block(15, 16, 7, 9), home: { model: `${SUB}building-type-r.glb`, house: [16, 8], c: 15, r: 8, door: [14, 8] } },
  { id: 'leo', name: 'Leo', color: '#a24bff', model: 'character-male-f', block: block(0, 1, 11, 13), home: { model: sp('building-house-02-color01'), house: [0, 12], c: 1, r: 12, door: [2, 12] } },
];
// In a real town, residents come from its members: id = user_id, name and color picked for this town
// (town_members.name / .color, else the profile's), look from profiles.avatar, home from
// house_x/house_y + town_members.home. Members who haven't placed a house yet get no character.
export const FRIENDS = TILES ? TOWN.members.filter((m) => m.house_x != null && m.home?.door && m.home?.driveway && m.home?.block)
  .map((m, i) => {
    const look = m.profiles?.avatar || {}, h = m.home, fallback = DEMO_FRIENDS[i % DEMO_FRIENDS.length];
    return {
      id: m.user_id, name: m.name || m.profiles?.display_name || 'Friend', color: m.color || look.color || fallback.color,
      model: look.character || fallback.model, block: block(h.block[0], h.block[2], h.block[1], h.block[3]),
      home: { model: h.model ? asset(h.model) : fallback.home.model, name: h.name, house: [m.house_x, m.house_y], c: h.driveway[0], r: h.driveway[1], door: h.door },
    };
  }) : DEMO_FRIENDS;
// Background houses (towns.map.background_homes = {color, homes: [{model, house: [x, y]}]}): plain one-tile
// houses whose tile holds their model key, all with the same muted roof color. No plot, driveway, fence, car or name tag.
const BG = TILES ? TOWN.town.map?.background_homes : null;
export const BG_ROOFS = new Set((BG?.homes || []).map((h) => `${h.house[0]},${h.house[1]}`));
export const BG_COLOR = BG?.color || '#b8b2a7';
// Dark text on light friend colors (yellow, orange), white on the rest
export const inkOn = (hex) => { const c = new THREE.Color(hex); return c.r * 0.3 + c.g * 0.59 + c.b * 0.11 > 0.6 ? '#1f2430' : '#fff'; };
export const TREES = TILES ? tilesOf('tree') : [[7, 7], [9, 7], [7, 9], [9, 9]];
// Explicit building models on the map that aren't named places (a town editor could put these anywhere)
export const EXTRA_MODELS = TILES ? TILES.flatMap((row, r) => row.flatMap((k, c) =>
  (TILE_KINDS.has(k) || Object.values(PLACES).some((p) => p.c === c && p.r === r) ? [] : [[c, r, asset(k)]]))) : [];

export const pos = (c, r) => new THREE.Vector3(c - N / 2 + 0.5, 0, r - N / 2 + 0.5);
export const key = (c, r) => `${c},${r}`;

// The object the backend bridges (realtime.js / townsync.js) drive; filled in by main.js at boot
export const townApi = { liveMode: false };

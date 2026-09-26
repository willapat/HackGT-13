// Town art: a skyline that grows with the town. Suburb (a few houses and trees), town (mid-rises), city
// (skyscrapers). Banners (town cards) are white silhouettes over the town's color, seeded by the town id so
// each town keeps the same skyline; icons (the round town avatar) are one fixed symbol per size.

export const TIERS = [
  { max: 3, key: 'suburb', label: 'Suburb' },
  { max: 7, key: 'town', label: 'Town' },
  { max: Infinity, key: 'city', label: 'City' },
];
export const tierFor = (residents) => TIERS.find((t) => residents <= t.max);

function rng(seed) {
  let h = [...String(seed)].reduce((a, c) => Math.imul(a ^ c.charCodeAt(0), 2654435761), 1779033703);
  return () => {
    h = Math.imul(h ^ (h >>> 15), h | 1);
    h ^= h + Math.imul(h ^ (h >>> 7), h | 61);
    return ((h ^ (h >>> 14)) >>> 0) / 4294967296;
  };
}

const house = (x, w, h, g) => `<rect x="${x}" y="${g - h}" width="${w}" height="${h}"/><path d="M${x - 1.5} ${g - h}L${x + w / 2} ${g - h - w * 0.55}L${x + w + 1.5} ${g - h}Z"/>`;
const tree = (x, r, g) => `<rect x="${x - 0.8}" y="${g - r}" width="1.6" height="${r}"/><circle cx="${x}" cy="${g - r - r * 0.7}" r="${r}"/>`;

// Windows are holes (mask), so the town's color shows through them
function tower(x, w, h, g, r, windows, spire) {
  let body = `<rect x="${x}" y="${g - h}" width="${w}" height="${h}"/>`;
  if (spire) body += `<rect x="${x + w / 2 - 0.7}" y="${g - h - spire}" width="1.4" height="${spire}"/>`;
  if (r() < 0.35 && w > 9) body += `<rect x="${x + 2}" y="${g - h - 3}" width="${w - 4}" height="3"/>`; // stepped top
  let holes = '';
  if (windows) {
    for (let y = g - h + 3; y < g - 3; y += 4) {
      for (let wx = x + 2; wx < x + w - 2.5; wx += 3.2) if (r() < 0.7) holes += `<rect x="${wx}" y="${y}" width="1.6" height="1.8"/>`;
    }
  }
  return { body, holes };
}

function layer(tier, r, width, ground, scale, windows, maxH) {
  let body = '', holes = '';
  let x = -4;
  while (x < width) {
    const pick = r();
    if (tier === 'suburb' || (tier === 'town' && pick < 0.3)) {
      if (pick < 0.35 || tier === 'town') {
        const w = (10 + r() * 6) * scale;
        body += house(x, w, (7 + r() * 4) * scale, ground);
        x += w + (3 + r() * 6) * scale;
      } else {
        const rad = (3 + r() * 3) * scale;
        body += tree(x + rad, rad, ground);
        x += rad * 2 + (2 + r() * 5) * scale;
      }
    } else {
      const tall = tier === 'city' ? 26 + r() * 30 : 13 + r() * 14;
      const w = (tier === 'city' ? 9 + r() * 9 : 10 + r() * 8) * scale;
      const t = tower(x, w, Math.min(tall * scale, maxH), ground, r, windows, tier === 'city' && r() < 0.3 ? 6 * scale : 0);
      body += t.body; holes += t.holes;
      x += w + (tier === 'city' ? 0.5 + r() * 2 : 2 + r() * 5) * scale;
    }
  }
  return { body, holes };
}

// Small round icons get one clean symbol per tier; random skylines turn to noise at 40px
const ICONS = {
  suburb: `<path d="M7 30v-7l6-5 6 5v7z"/><path d="M20 30v-8l6.5-5.5 6.5 5.5v8z"/><rect x="33.2" y="24" width="1.6" height="6"/><circle cx="34" cy="22" r="3.4"/>`,
  town: `<rect x="7" y="17" width="8" height="13"/><rect x="16.5" y="11" width="8.5" height="19"/><rect x="26.5" y="20" width="7.5" height="10"/>`,
  city: `<rect x="6" y="14" width="6.5" height="16"/><rect x="13.5" y="6" width="6" height="24"/><rect x="16" y="2.5" width="1" height="4"/><rect x="20.5" y="10" width="6.5" height="20"/><rect x="28" y="16" width="6" height="14"/>`,
};

// mode 'banner' (wide, for town cards) or 'icon' (square, for the round town avatar)
export function skyline(id, residents, mode = 'banner') {
  const tier = tierFor(residents).key;
  if (mode === 'icon') {
    return `<svg viewBox="0 0 40 40" aria-hidden="true"><rect x="0" y="30" width="40" height="10" fill="#fff" fill-opacity="0.25"/><g fill="#fff" fill-opacity="0.9" transform="translate(0 2)">${ICONS[tier]}</g></svg>`;
  }
  const r = rng(`${id}:${mode}`);
  const [w, h] = [240, 72];
  const ground = h;
  const scale = 1.5;
  const maxH = h * 0.86; // leave a strip of sky
  const back = layer(tier, r, w, ground - 5, scale * 0.8, false, maxH);
  const front = layer(tier, r, w, ground, scale, true, maxH);
  const m = `m${Math.floor(r() * 1e9)}`;
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMax slice" aria-hidden="true">
    <mask id="${m}"><rect width="${w}" height="${h}" fill="#fff"/><g fill="#000">${front.holes}</g></mask>
    <g fill="#fff" fill-opacity="0.28">${back.body}</g>
    <g fill="#fff" fill-opacity="0.62" mask="url(#${m})">${front.body}</g>
  </svg>`;
}

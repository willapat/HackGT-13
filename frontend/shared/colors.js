// Color math for the character color wheel. Mirrors backend/identity.py so the page can warn before
// the server refuses: two people in a town can't have colors closer than TOO_CLOSE (CIE76 in Lab).

export const TOO_CLOSE = 22;

export function hsvToHex(h, s, v) {
  const f = (n) => { const k = (n + h / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
  return `#${[f(5), f(3), f(1)].map((c) => Math.round(c * 255).toString(16).padStart(2, '0')).join('')}`;
}

export function hexToHsv(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b), d = max - Math.min(r, g, b);
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: (h * 60 + 360) % 360, s: max ? d / max : 0, v: max };
}

function lab(hex) {
  const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = [1, 3, 5].map((i) => lin(parseInt(hex.slice(i, i + 2), 16) / 255));
  const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

export function distance(a, b) {
  const la = lab(a), lb = lab(b);
  return Math.hypot(la[0] - lb[0], la[1] - lb[1], la[2] - lb[2]);
}

// The first person whose color is too close to `hex`, if any
export const clashWith = (people, hex) => people.find((p) => p.color && distance(p.color, hex) < TOO_CLOSE);

// Same candidate set as the server hands out on join
const CANDIDATES = [];
for (let h = 0; h < 360; h += 4) for (const s of [0.85, 0.6]) for (const v of [0.95, 0.75]) CANDIDATES.push(hsvToHex(h, s, v));

// A random color that's free for everyone listed (or the least-crowded one if none is)
export function freeColor(taken) {
  const gap = CANDIDATES.map((c) => [c, taken.length ? Math.min(...taken.map((t) => distance(c, t))) : Infinity]);
  const free = gap.filter(([, d]) => d >= TOO_CLOSE);
  if (!free.length) return gap.sort((a, b) => b[1] - a[1])[0][0];
  return free[Math.floor(Math.random() * free.length)][0];
}

export const inkOn = (hex) => {
  const n = parseInt(hex.slice(1), 16), lum = ((n >> 16) * 0.3 + ((n >> 8) & 255) * 0.59 + (n & 255) * 0.11) / 255;
  return lum > 0.6 ? '#1f2430' : '#fff';
};

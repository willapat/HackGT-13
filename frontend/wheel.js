// A color wheel: hue around the circle, saturation outward, brightness from a slider. Colors other
// people already use show as dots. Used by the "your name and color in this town" dialog.
import { hexToHsv, hsvToHex } from './colors.js';

const MIN_S = 0.3; // the wheel's center is still a pale color, never grey

export function createWheel(root, { onChange }) {
  root.innerHTML = `
    <div class="wheel">
      <canvas width="400" height="400" role="slider" tabindex="0" aria-label="Color wheel: drag to pick a color; arrow keys change hue and saturation"></canvas>
      <div class="wheel-dots"></div>
      <div class="wheel-pick" hidden></div>
    </div>
    <div class="wheel-side">
      <label>Brightness <input type="range" min="55" max="100" value="95" /></label>
      <div class="k wheel-hex"></div>
    </div>`;
  const canvas = root.querySelector('canvas'), dots = root.querySelector('.wheel-dots');
  const pick = root.querySelector('.wheel-pick'), slider = root.querySelector('input[type="range"]');
  let hsv = { h: 0, s: 0.85, v: 0.95 }, value = null;

  function draw() {
    const ctx = canvas.getContext('2d'), n = canvas.width, R = n / 2, v = hsv.v;
    const img = ctx.createImageData(n, n);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const dx = x - R + 0.5, dy = y - R + 0.5, r = Math.hypot(dx, dy) / R;
      if (r > 1) continue;
      const h = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360, sat = MIN_S + (1 - MIN_S) * r;
      const f = (k0) => { const k = (k0 + h / 60) % 6; return v - v * sat * Math.max(0, Math.min(k, 4 - k, 1)); };
      const o = (y * n + x) * 4;
      img.data[o] = f(5) * 255; img.data[o + 1] = f(3) * 255; img.data[o + 2] = f(1) * 255;
      img.data[o + 3] = r > 0.985 ? (1 - r) / 0.015 * 255 : 255; // soft edge
    }
    ctx.putImageData(img, 0, 0);
  }

  // Where a color sits on the wheel, as % of its box
  function spot({ h, s }) {
    const r = Math.min(1, Math.max(0, (s - MIN_S) / (1 - MIN_S))), a = h * Math.PI / 180;
    return { left: `${50 + 50 * r * Math.cos(a)}%`, top: `${50 + 50 * r * Math.sin(a)}%` };
  }

  function render() {
    pick.hidden = !value;
    if (value) Object.assign(pick.style, spot(hsv), { background: value });
    root.querySelector('.wheel-hex').textContent = value ? value.toUpperCase() : 'No color yet';
  }

  function commit() {
    value = hsvToHex(hsv.h, hsv.s, hsv.v);
    render();
    onChange(value);
  }

  function pickAt(e) {
    const r = canvas.getBoundingClientRect();
    const dx = e.clientX - r.left - r.width / 2, dy = e.clientY - r.top - r.height / 2;
    hsv.h = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360;
    hsv.s = MIN_S + (1 - MIN_S) * Math.min(1, Math.hypot(dx, dy) / (r.width / 2));
    commit();
  }

  canvas.onpointerdown = (e) => { canvas.setPointerCapture(e.pointerId); pickAt(e); };
  canvas.onpointermove = (e) => { if (canvas.hasPointerCapture(e.pointerId)) pickAt(e); };
  canvas.onkeydown = (e) => {
    const step = { ArrowLeft: [-5, 0], ArrowRight: [5, 0], ArrowUp: [0, 0.05], ArrowDown: [0, -0.05] }[e.key];
    if (!step) return;
    e.preventDefault();
    hsv.h = (hsv.h + step[0] + 360) % 360;
    hsv.s = Math.min(1, Math.max(MIN_S, hsv.s + step[1]));
    commit();
  };
  slider.oninput = () => { hsv.v = slider.value / 100; draw(); commit(); };

  return {
    // Show a color without reporting it as a change
    set(hex) {
      value = hex || null;
      if (hex) hsv = { ...hexToHsv(hex) };
      hsv.s = Math.max(MIN_S, hsv.s);
      slider.value = Math.round(hsv.v * 100);
      draw();
      render();
    },
    // Other people's colors, as dots: [{name, color}]
    setTaken(people) {
      dots.innerHTML = '';
      for (const p of people) {
        if (!p.color) continue;
        const d = document.createElement('div');
        d.className = 'wheel-dot';
        d.style.background = p.color;
        Object.assign(d.style, spot(hexToHsv(p.color)));
        d.title = p.name;
        dots.append(d);
      }
    },
  };
}

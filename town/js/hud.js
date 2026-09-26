// DOM helpers for the town page: activity toasts, cards, and screen-space labels that follow 3D points.

export const $ = (s) => document.querySelector(s);

// Town happenings show as short toasts in the corner (the newest few, each fading after a few seconds)
export function logFeed(text) {
  const li = document.createElement('li');
  li.append(text);
  $('#feed').append(li);
  while ($('#feed').children.length > 3) $('#feed').firstChild.remove();
  setTimeout(() => li.classList.add('gone'), 5000);
  setTimeout(() => li.remove(), 5600);
}

export function showCard({ kind, text, color, actions }) {
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

// Screen-space labels that follow 3D points
export const labels = new Set();
export function addLabel(className, text, getPos, visible = null) {
  const el = document.createElement('div');
  el.className = className;
  el.textContent = text;
  $('#labels').append(el);
  const l = { el, getPos, visible };
  labels.add(l);
  return { el, remove: () => { el.remove(); labels.delete(l); } };
}

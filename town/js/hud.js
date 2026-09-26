// DOM helpers for the town page: the activity feed, cards, and screen-space labels that follow 3D points.

export const $ = (s) => document.querySelector(s);

export function logFeed(text) {
  const li = document.createElement('li');
  const t = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  li.innerHTML = `<time>${t}</time>`;
  li.append(text);
  $('#feed').prepend(li);
  while ($('#feed').children.length > 60) $('#feed').lastChild.remove();
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
export function addLabel(className, text, getPos) {
  const el = document.createElement('div');
  el.className = className;
  el.textContent = text;
  $('#labels').append(el);
  const l = { el, getPos };
  labels.add(l);
  return { el, remove: () => { el.remove(); labels.delete(l); } };
}

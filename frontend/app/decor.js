// Desk decor in the empty space beside the page on wide screens: a daily nudge toward a real-world hangout,
// a weekly checklist, and a tip about something Luma can do. Every note can be dragged around its side of the
// screen. Nothing here is about real people and nothing is sent anywhere: note positions and the checklist live
// in this browser only (localStorage).

const NUDGES = [
  "Text someone you haven't talked to in a month. \"Thought of you\" is enough.",
  'Bring a friend on your next errand. Groceries count as hanging out.',
  'Ask someone about the thing they mentioned last week.',
  'Eat lunch with someone instead of your phone.',
  'Say yes to the next plan, even a small one.',
  'Send a friend a song that reminds you of them.',
  'Walk to class with someone new.',
  'Make a weekend plan before Friday.',
  'Congratulate someone on a small win.',
  "Leave a note in a friend's mailbox in town.",
  'Invite two friends who have never met.',
  'Call instead of texting. Five minutes is plenty.',
];

const TIPS = [
  'Tap Free and friends see a green ring around you for 3 hours.',
  "Click a mailbox in your town to leave a friend a note.",
  'Connect Google Calendar (Settings → Calendar) and your character walks to class for you.',
  "Pin a town so it's always first on your feed.",
  'Put a mood on your house: party lights, a rain cloud, sparkles…',
  'Every week your town prints a paper. Look for 📰 in town.',
  'Add interests to your profile so your town can spot what you have in common.',
  "Click a building's name in town to see who's there, then Go there.",
];

const WEEK_LIST = ['Hang out in person', 'Text a friend first', 'Try a new spot', 'Say yes to a plan'];

const $ = (s) => document.querySelector(s);
const dayIndex = Math.floor((Date.now() - new Date().getTimezoneOffset() * 60000) / 86400000);

// Monday of this week as YYYY-MM-DD, so the checklist starts fresh every week
function weekKey() {
  const d = new Date();
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

function load(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage blocked: still works for this visit */ }
}

// A note that shows one line from a list and moves to the next when you tap it
function cycler(note, textEl, lines, start) {
  if (!note || !textEl) return;
  let i = start % lines.length;
  textEl.textContent = lines[i];
  note.onclick = () => {
    if (note.dataset.dragged) return; // the end of a drag isn't a tap
    note.classList.remove('flip');
    void note.offsetWidth; // restart the flip animation
    note.classList.add('flip');
    setTimeout(() => { i = (i + 1) % lines.length; textEl.textContent = lines[i]; }, 160);
  };
}

cycler($('#nudge-note'), $('#nudge-text'), NUDGES, dayIndex);
cycler($('#tip-note'), $('#tip-text'), TIPS, dayIndex * 3);

const list = $('#week-list');
if (list) {
  const key = 'luma-week-list';
  let state = load(key, {});
  if (state.week !== weekKey()) state = { week: weekKey(), done: [] };
  list.replaceChildren(...WEEK_LIST.map((label, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'check-item';
    b.setAttribute('aria-pressed', String(state.done.includes(i)));
    b.append(Object.assign(document.createElement('span'), { className: 'box' }), label);
    b.onclick = () => {
      const on = b.getAttribute('aria-pressed') !== 'true';
      b.setAttribute('aria-pressed', String(on));
      state.done = on ? [...state.done, i] : state.done.filter((x) => x !== i);
      save(key, state);
    };
    return b;
  }));
}

// ---- Dragging notes ----

const DESK_KEY = 'luma-desk';
const desk = load(DESK_KEY, {});
desk.pos ||= {}; // note id -> [dx, dy] from where the note sits by default
delete desk.mine; // notes you wrote yourself: a removed feature
const saveDesk = () => save(DESK_KEY, desk);

// Keep a note inside its side of the screen: sides change width with the page (Home is wider than Feed)
function clampNote(note, [dx, dy]) {
  const side = note.closest('.decor-side')?.getBoundingClientRect();
  if (!side || !side.width) return [dx, dy];
  const box = note.getBoundingClientRect();
  const [cx, cy] = desk.pos[note.dataset.note] || [0, 0];
  const left = box.left - cx, top = box.top - cy; // where it sits with no offset
  const pad = 8;
  dx = Math.min(Math.max(dx, side.left + pad - left), side.right - pad - box.width - left);
  dy = Math.min(Math.max(dy, side.top + pad - top), side.bottom - pad - box.height - top);
  return [Math.round(dx), Math.round(dy)];
}
function place(note) {
  const p = desk.pos[note.dataset.note];
  if (!p) { note.style.translate = ''; return; }
  const fixed = clampNote(note, p);
  desk.pos[note.dataset.note] = fixed;
  note.style.translate = `${fixed[0]}px ${fixed[1]}px`;
}
const placeAll = () => document.querySelectorAll('.decor [data-note]').forEach(place);

let front = 10;
function draggable(note) {
  let start = null;
  note.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('.check-item')) return;
    start = { x: e.clientX, y: e.clientY, p: desk.pos[note.dataset.note] || [0, 0], moved: false, id: e.pointerId };
  });
  note.addEventListener('pointermove', (e) => {
    if (!start) return;
    const dx = e.clientX - start.x, dy = e.clientY - start.y;
    if (!start.moved) {
      if (Math.hypot(dx, dy) < 5) return; // a tap, so far
      start.moved = true;
      try { note.setPointerCapture(start.id); } catch { /* pointer already gone: the drag still follows moves over the note */ }
      note.classList.add('dragging');
      note.style.zIndex = String(++front);
    }
    const p = clampNote(note, [start.p[0] + dx, start.p[1] + dy]);
    desk.pos[note.dataset.note] = p;
    note.style.translate = `${p[0]}px ${p[1]}px`;
  });
  const end = () => {
    if (!start) return;
    if (start.moved) {
      note.classList.remove('dragging');
      note.dataset.dragged = '1';
      setTimeout(() => delete note.dataset.dragged, 0); // swallow the click that ends a drag
      saveDesk();
    }
    start = null;
  };
  note.addEventListener('pointerup', end);
  note.addEventListener('pointercancel', end);
}

for (const [el, id] of [[$('#nudge-note'), 'nudge'], [$('#week-list')?.closest('.sticky'), 'week'], [$('#tip-note'), 'tip']]) {
  if (!el) continue;
  el.dataset.note = id;
  draggable(el);
}
placeAll();
// Sides resize with the window and with the page (Home's column is wider than Feed's), so re-fit the notes
addEventListener('resize', placeAll);
addEventListener('hashchange', () => setTimeout(placeAll, 50));

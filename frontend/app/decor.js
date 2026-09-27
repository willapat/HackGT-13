// Desk decor in the empty space beside the page on wide screens: a daily nudge toward a real-world hangout,
// a weekly checklist, and a tip about something Luma can do. Nothing here is about real people, nothing is
// sent anywhere; the checklist lives in this browser only (localStorage) and resets each week.

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

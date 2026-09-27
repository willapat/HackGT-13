// The corner schedule: yours by default. Clicking a person opens theirs in the same dropdown;
// clicking the town, or leaving follow, puts yours back (camera.js dispatches town:person / town:person-clear).
import { getSupabase } from '../../frontend/shared/session.js';
import { PLACES } from './layout.js';
import { friends } from './people.js';
import { townNowMs } from './sky.js';

let rows = [];
let meId = null;
let viewedId = null; // null = you
let epoch = 0;
let drawn = '';

const el = (tag, cls, text) => Object.assign(document.createElement(tag), cls ? { className: cls } : {}, text != null ? { textContent: text } : {});

function personById(id) {
  if (!id) return null;
  return friends[id] || Object.values(friends).find((f) => f.userId === id) || null;
}

function subject() {
  return personById(viewedId || meId);
}

function mineShowing() {
  if (!viewedId) return true;
  if (!meId) return false;
  const person = personById(viewedId);
  return viewedId === meId || person?.userId === meId || person?.id === meId;
}

function eventsFor(person) {
  const ids = new Set([person.id, person.userId].filter(Boolean));
  return rows.filter((ev) => ids.has(ev.user_id) || (ev.display_name && ev.display_name === person.name));
}

function placeName(ev, person) {
  const id = ev.building_id || '';
  if (id.startsWith('house:')) {
    const uid = id.slice('house:'.length);
    if (uid === person.id || uid === person.userId) return 'Home';
    const who = personById(uid);
    return who ? `${who.name}'s house` : 'A house';
  }
  if (PLACES[id]?.name) return PLACES[id].name;
  if ((ev.place || '').toLowerCase() === 'home') return 'Home';
  return '';
}

function withText(ev) {
  const names = ev.with_names?.length
    ? ev.with_names.filter(Boolean)
    : (ev.with || []).map((id) => personById(id)?.name).filter(Boolean);
  return names.length ? `with ${names.join(', ')}` : '';
}

function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function dayHeading(ms, now) {
  const d = new Date(ms), n = new Date(now);
  if (sameDay(d, n)) return 'Today';
  const tomorrow = new Date(n);
  tomorrow.setDate(n.getDate() + 1);
  if (sameDay(d, tomorrow)) return 'Tomorrow';
  return d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
}

function clockPart(d) {
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

function timeRange(start, end) {
  const a = new Date(start), b = new Date(end);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return '';
  const period = (d) => (d.getHours() < 12 ? 'AM' : 'PM');
  const bare = (d) => clockPart(d).replace(/\s*[AP]M$/i, '');
  if (period(a) === period(b)) return `${bare(a)}–${bare(b)} ${period(b)}`;
  return `${clockPart(a)}–${clockPart(b)}`;
}

function setOpen(open) {
  const menu = document.querySelector('#day-menu');
  const toggle = document.querySelector('#day-toggle');
  if (!menu || !toggle) return;
  menu.hidden = !open;
  toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (open) {
    const sky = document.querySelector('#sky-menu');
    if (sky) sky.hidden = true;
    document.querySelector('#sky-toggle')?.setAttribute('aria-expanded', 'false');
  }
  drawn = '';
  render();
}

function render() {
  const label = document.querySelector('#day-label');
  const dot = document.querySelector('#day-dot');
  const sub = document.querySelector('#day-sub');
  const list = document.querySelector('#day-list');
  if (!label || !list) return;
  const person = subject();
  const mine = mineShowing();
  // You still get a day if your house isn't placed (no character to click).
  const who = person || (mine && meId ? { id: meId, name: 'You', color: '#1a6dff' } : null);
  if (!who) {
    label.textContent = 'Your day';
    if (dot) dot.hidden = true;
    if (sub) sub.textContent = 'Click someone in town to see their day.';
    list.replaceChildren(el('p', 'day-empty', 'Click someone to see their day.'));
    return;
  }
  label.textContent = mine ? 'Your day' : `${who.name}'s day`;
  if (dot) {
    dot.hidden = !person;
    dot.style.background = who.color || '#1a6dff';
  }
  const now = townNowMs();
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const upcoming = eventsFor(who)
    .map((ev) => ({ ev, start: Date.parse(ev.start), end: Date.parse(ev.end) }))
    .filter((x) => Number.isFinite(x.start) && Number.isFinite(x.end) && x.end > startOfToday.getTime())
    .sort((a, b) => a.start - b.start);
  const current = upcoming.find((x) => x.start <= now && now < x.end);
  const next = upcoming.find((x) => x.start > now);
  if (sub) {
    if (!mine) sub.textContent = 'Click the town to see your day.';
    else if (current) sub.textContent = 'Happening now';
    else if (!upcoming.length) sub.textContent = 'Nothing coming up';
    else sub.textContent = 'The next few days';
  }
  if (!upcoming.length) {
    list.replaceChildren(el('p', 'day-empty', mine ? 'Nothing on your calendar.' : `Nothing on ${who.name}'s calendar.`));
    return;
  }
  list.replaceChildren();
  let group = null, heading = '';
  for (const item of upcoming) {
    const head = dayHeading(item.start, now);
    if (head !== heading) {
      heading = head;
      group = el('section', 'day-group');
      group.append(el('h3', '', head));
      list.append(group);
    }
    const past = item.end <= now;
    const nowItem = item === current;
    const row = el('div', `day-item${nowItem ? ' now' : ''}${past ? ' past' : ''}`);
    const when = el('div', 'day-time');
    when.append(el('span', '', timeRange(item.ev.start, item.ev.end)));
    if (nowItem) when.append(el('span', 'day-badge', 'Now'));
    else if (item === next && !current) when.append(el('span', 'day-badge', 'Next'));
    row.append(when);
    const title = item.ev.title || 'Busy';
    const where = placeName(item.ev, who);
    row.append(el('div', 'day-what', title));
    const meta = [where && !title.toLowerCase().includes(where.toLowerCase()) ? where : '', withText(item.ev)].filter(Boolean).join(' · ');
    if (meta) row.append(el('div', 'day-meta', meta));
    group.append(row);
  }
}

export function ingestSchedules(next) {
  rows = next || [];
  epoch += 1;
  drawn = '';
  render();
}

// Re-render when the town minute changes, so "Now" follows the clock without rewriting the list every frame.
export function tickSchedule() {
  const stamp = `${viewedId || ''}|${meId || ''}|${epoch}|${document.querySelector('#day-menu')?.hidden}|${Math.floor(townNowMs() / 60000)}`;
  if (stamp === drawn) return;
  drawn = stamp;
  render();
}

export function startSchedule() {
  const toggle = document.querySelector('#day-toggle');
  const menu = document.querySelector('#day-menu');
  if (toggle && menu) {
    toggle.onclick = () => setOpen(menu.hidden);
    addEventListener('pointerdown', (e) => {
      if (menu.hidden || toggle.contains(e.target) || menu.contains(e.target)) return;
      // A click on the map or a name tag picks whose day is shown; don't close first.
      if (e.target.closest('#game') || e.target.closest('.lbl.friend')) return;
      setOpen(false);
    });
    // Capture so this runs before follow-mode's Escape (that also clears the person): viewing
    // someone returns to your day and leaves the list open; Escape on your own day closes it.
    addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || menu.hidden) return;
      if (viewedId && !mineShowing()) {
        viewedId = null;
        drawn = '';
        render();
        return;
      }
      setOpen(false);
    }, true);
  }
  addEventListener('town:person', (e) => {
    viewedId = e.detail || null;
    setOpen(true);
  });
  addEventListener('town:person-clear', () => {
    if (!viewedId) return;
    viewedId = null;
    drawn = '';
    render();
  });
  getSupabase().then((sb) => sb.auth.getSession()).then(({ data }) => {
    meId = data.session?.user.id ?? null;
    drawn = '';
    render();
  }).catch(() => {});
  render();
}

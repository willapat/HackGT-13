// Side panels: the residents list and everyone's shared schedule.
import { focusFriend } from './camera.js';
import { $ } from './hud.js';
import { PLACES } from './layout.js';
import { friends } from './people.js';
import { sky, WEEKDAYS } from './sky.js';

export function renderResidents() {
  const ul = $('#residents');
  ul.innerHTML = '';
  for (const f of Object.values(friends)) {
    if (!f.obj.visible) continue;
    const li = document.createElement('li');
    li.style.cursor = 'pointer';
    li.innerHTML = `<span class="dot" style="background:${f.color}"></span><div><b></b><div class="status"></div></div>`;
    li.querySelector('b').textContent = f.name;
    li.querySelector('.status').textContent = f.status;
    li.onclick = () => focusFriend(f.id);
    ul.append(li);
  }
}

function placeName(ev) {
  if (ev.building_id && PLACES[ev.building_id]) return PLACES[ev.building_id].name;
  const place = (ev.place || '').toLowerCase();
  if (place === 'home') return 'Home';
  if (place === 'campus') return 'Campus';
  return ev.place || '';
}

function townWall(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const et = new Date(d.getTime() - 4 * 60 * 60 * 1000); // town is America/New_York, EDT in September
  return { y: et.getUTCFullYear(), mo: et.getUTCMonth() + 1, d: et.getUTCDate(), h: et.getUTCHours(), min: et.getUTCMinutes() };
}

function clockDateLabel(iso) {
  const p = townWall(iso);
  if (!p) return '';
  return `${WEEKDAYS[new Date(p.y, p.mo - 1, p.d).getDay()]} ${String(p.d).padStart(2, '0')}/${String(p.mo).padStart(2, '0')}/${p.y}`;
}

function clockTimeRange(startIso, endIso) {
  const fmt = (iso) => {
    const p = townWall(iso);
    if (!p) return '';
    return `${((p.h + 11) % 12) + 1}:${String(p.min).padStart(2, '0')} ${p.h < 12 ? 'AM' : 'PM'}`;
  };
  return `${fmt(startIso)}–${fmt(endIso)}`;
}

let lastSchedSig = '';
export function renderSchedules(rows) {
  const root = $('#schedules');
  if (!root) return;
  const list = rows || [];
  const sig = JSON.stringify(list.map((e) => [e.user_id, e.start, e.title]));
  if (sig === lastSchedSig && root.childElementCount) {
    markCurrentScheduleItems(list);
    return;
  }
  lastSchedSig = sig;
  root.innerHTML = '';
  if (!list.length) {
    root.innerHTML = '<div class="sched-where">No calendars shared yet.</div>';
    return;
  }
  const colorOf = {};
  for (const f of Object.values(friends)) colorOf[f.name] = f.color;
  const names = [];
  for (const f of Object.values(friends)) if (f.obj.visible && !names.includes(f.name)) names.push(f.name);
  for (const ev of list) if (ev.display_name && !names.includes(ev.display_name)) names.push(ev.display_name);
  for (const name of names) {
    const mine = list.filter((e) => e.display_name === name).sort((a, b) => (a.start || '').localeCompare(b.start || ''));
    if (!mine.length) continue;
    const block = document.createElement('div');
    block.className = 'sched-person';
    const h = document.createElement('h3');
    h.innerHTML = '<span class="dot"></span><span></span>';
    h.querySelector('.dot').style.background = colorOf[name] || '#667085';
    h.querySelector('span:last-child').textContent = name;
    block.append(h);
    let day = '';
    for (const ev of mine) {
      const d = clockDateLabel(ev.start);
      if (d && d !== day) {
        day = d;
        const hd = document.createElement('div');
        hd.className = 'sched-day';
        hd.textContent = d;
        block.append(hd);
      }
      const item = document.createElement('div');
      item.className = 'sched-item';
      item.dataset.start = ev.start || '';
      item.dataset.end = ev.end || '';
      const where = placeName(ev);
      const withWho = (ev.with_names || []).filter(Boolean).join(', ');
      item.innerHTML = '<div class="sched-when"></div><div class="sched-title"></div><div class="sched-where"></div>';
      item.querySelector('.sched-when').textContent = clockTimeRange(ev.start, ev.end);
      item.querySelector('.sched-title').textContent = ev.title || 'Busy';
      item.querySelector('.sched-where').textContent = [where, withWho && `with ${withWho}`].filter(Boolean).join(' · ');
      block.append(item);
    }
    root.append(block);
  }
  markCurrentScheduleItems(list);
}

export function markCurrentScheduleItems() {
  const now = sky.y
    ? new Date(sky.y, sky.mo - 1, sky.d, Math.floor(sky.hour), Math.floor((sky.hour % 1) * 60)).getTime()
    : Date.now();
  document.querySelectorAll('#schedules .sched-item').forEach((el) => {
    const s = Date.parse(el.dataset.start || ''), e = Date.parse(el.dataset.end || '');
    el.classList.toggle('now', Number.isFinite(s) && Number.isFinite(e) && s <= now && now < e);
  });
}

// Scripted demo signals (good news, climbing, rough week) for the hard-coded demo town.
import { focusOn } from './camera.js';
import { effects, partyLights, rainCloud } from './effects.js';
import { $, logFeed, showCard } from './hud.js';
import { FRIENDS, PLACES, pos } from './layout.js';
import { eventOwned, faceTowards, friends, interrupt, meet, release, say, walkTo } from './people.js';

function claim(...ids) { return ids.map((id) => { eventOwned.add(id); interrupt(friends[id]); return friends[id]; }); }
function unclaim(...ids) { ids.forEach((id) => { eventOwned.delete(id); release(friends[id]); }); }
export function setStatus(id, status) { friends[id].status = status; }

export async function trigger(name) {
  if (name === 'reset') return resetTown();
  if (effects[name]) return;

  if (name === 'goodNews') {
    setStatus('maya', 'Landed the internship 🎉');
    logFeed('📰 Town brain: Maya shared good news (landed the internship).');
    effects.goodNews = partyLights(FRIENDS[0].home);
    const [maya, leo, sam] = claim('maya', 'leo', 'sam');
    await walkTo(maya, maya.home);
    say(maya, '🎉🎉🎉', 3000);
    await Promise.all([walkTo(leo, maya.home, 0.3), walkTo(sam, maya.home, -0.3)]);
    faceTowards(leo, maya.obj.position); faceTowards(sam, maya.obj.position); faceTowards(maya, leo.obj.position);
    await say(leo, 'Congrats Maya!!', 2000);
    await say(sam, 'Huge news 🥳', 2000);
    showCard({
      kind: 'Good news', color: '#f0616d',
      text: 'Maya landed the internship. Want to celebrate with her in real life?',
      actions: [
        ['Plan a celebration dinner', () => logFeed('✅ You approved a celebration plan. An action agent would check calendars and draft invites next (not built yet).'), true],
        ['Draft a congrats text', () => logFeed('✍️ Drafted a congrats message for you to review. Nothing is sent without you.')],
        ['Dismiss'],
      ],
    });
    unclaim('maya', 'leo', 'sam');
  }

  if (name === 'climbing') {
    setStatus('sam', 'Wants to try climbing 🧗');
    setStatus('priya', 'Wants to try climbing 🧗');
    logFeed('🔗 Town brain: Sam and Priya both mentioned wanting to try climbing.');
    effects.climbing = { destroy() {} };
    const [sam, priya] = claim('sam', 'priya');
    focusOn(pos(...PLACES.gym.door));
    if (await meet(sam, priya, PLACES.gym)) {
      await say(sam, 'Wait, you want to try climbing too?', 2400);
      await say(priya, 'Yes! Been meaning to for ages 🧗', 2400);
    }
    showCard({
      kind: 'Quest', color: '#2fb36d',
      text: 'Sam and Priya both want to try climbing. Suggest a beginner session at Boulder Gym this Saturday?',
      actions: [
        ['Suggest to both', () => logFeed('✅ Suggestion queued. Sam and Priya each approve before anything is sent.'), true],
        ['Not now'],
      ],
    });
    unclaim('sam', 'priya');
  }

  if (name === 'roughWeek') {
    setStatus('jordan', 'Having a rough week');
    logFeed('🌧️ Town brain: Jordan shared that this week has been rough.');
    effects.roughWeek = rainCloud(FRIENDS[1].home);
    const [jordan] = claim('jordan');
    if (await walkTo(jordan, jordan.home)) jordan.obj.visible = false;
    showCard({
      kind: 'Check in', color: '#4f8ef7',
      text: "Jordan's having a rough week. A quick message or a coffee could mean a lot.",
      actions: [
        ['Draft a check-in', () => logFeed('✍️ Drafted a check-in for Jordan for you to review. Nothing is sent without you.'), true],
        ['Invite for coffee', () => logFeed('☕ Coffee invite drafted for your approval.')],
        ['Later'],
      ],
    });
    // Jordan stays home (claimed) until reset.
  }
}

export function renameFriend(f, name) {
  f.name = name;
  if (f.label) f.label.el.textContent = name;
  if (f.home) f.home.name = `${name}'s house`;
  if (f.homeLabel) {
    f.homeLabel.el.textContent = f.home.name;
    f.homeLabel.el.style.display = '';
  }
}

export function applyTownNames(map) {
  const places = (map && map.places) || {};
  for (const [id, src] of Object.entries(places)) {
    const dest = PLACES[id];
    if (!dest || !src || !src.name) continue;
    dest.name = src.name;
    if (dest.label) dest.label.el.textContent = src.name;
  }
}

function resetTown() {
  for (const k of Object.keys(effects)) { effects[k].destroy(); delete effects[k]; }
  $('#cards').innerHTML = '';
  for (const f of Object.values(friends)) {
    renameFriend(f, FRIENDS.find((d) => d.id === f.id).name);
    f.status = 'Just vibing';
    eventOwned.delete(f.id);
    f.obj.visible = true;
    if (f.busy && !f.path.length) release(f);
  }
  logFeed('↺ Town reset.');
}

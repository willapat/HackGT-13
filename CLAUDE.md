# Tiny Town — Project Context for Agents

HackGT 13 hackathon project. Keep this file current: when you make a decision, add a dependency, change the architecture, or finish/start a major piece, update the relevant section below (especially **Status** and **Decisions Log**) in the same change. Keep it short. Delete what's stale.

## The Idea

An isometric town where each character is one of the user's real friends. The town reflects what's actually happening in friends' lives (from signals they opt in to share), and characters act on their own inside the town to surface connections, which become real-world suggestions the humans can accept.

## Goals

- **Strengthen real friendships.** The point is to get people talking and hanging out more in real life, not to keep them in the app. Every feature should push toward a real-world connection: a message, a check-in, a plan.
- **Help people notice each other.** Show who's having a hard week, who has good news, and who shares an interest, so friends can show up for each other at the right moment.
- **Bridge people who should know each other.** Point out overlaps between friends, and between friend groups, that people wouldn't have spotted themselves.
- **Make keeping in touch easy and fun.** Turn "we should hang out" into something concrete through quests and suggested plans, with less of the work of organizing.
- **Earn trust.** Friends share only what they opt in to, the town never makes things up about real people, and humans stay in control of anything that reaches someone.

When choosing between features, pick whichever does more for real-world connection.

## Architecture

1. **Town brain**: `backend/loops/brain_loop.py` finds towns with signals newer than their last `brain_runs` row (`db.towns_with_unprocessed_signals`), then `run_brain_for_town` calls Gemini Flash via OpenRouter. Output is Pydantic-validated and visibility-filtered, then written to `town_members` (mood/activity/state) and `brain_runs.output` (facts + news). `events` are user calendars, not brain output.
2. **Character agents**: `agent_loop` claims due `agents` rows, and only the process holding `loop_leases` name `agent` does. Town time is the `town_clock` row (slider scrubs it, Live, Play (1 game minute per second) and Fast resume from that hour; a restart does not add process uptime). Where someone stands is written only by `snap_town_to_clock` / `snap_member_to_clock` (`plan_clock_placement`): idle means x/y is that door. Every `agents` update sets a new `written_by` or Postgres rejects it. Trigger `agents_follow_calendar` (`20260926000012`) re-plans every position change in SQL (`calendar_placement`, a mirror of `current_trip`) at `target.clock_at` and rejects it if the calendar, the door, or the town clock disagree. Change the SQL and `calendar_drive.py` together. The agent does not commit a calendar position. A failed model call does not change `action` while a calendar trip owns the character. Chat bubbles go in `agent_actions.details.lines`.
3. **Plan drafting (stub, no model yet)**: when every participant accepts, `events.status` goes `suggested` → `scheduled` and `GET /events/{id}` includes a drafted `plan`. A participant approves it via `POST /events/{id}/approve` → `confirmed`. The draft is recomputed on read; persisting it needs a migration.

## Hard Rules

- **Agents only use real facts.** Never invent feelings, events, or relationships about real people.
- **Humans approve anything that leaves the town.** Agents never send messages as the user in real channels.
- **Fixed action menu.** New actions get added to the menu deliberately.
- **Pitch honestly.** Only call something an "agent" if a model is actually making decisions.
- **LLM output never hits Postgres raw.** Brain and agents go through `backend/agent/validate.py` (Brain also `backend/brain/visibility.py`). Those loops are the only writers to `brain_runs`, town-member AI fields (`mood`/`activity`/`state`), `agents.action`/`target`, and `agent_actions`. Exceptions: a person moving their own character via `POST /towns/{id}/members/me/move` (`target.by = "user"`), and calendar travel (`backend/calendar_drive.py`) which follows `events` times. The brain does not write `events`.
- **`brain_runs` is readable by every town member.** Store only signal/member ids in `input` and only fully visible facts in `output`.

## Tech Stack

- Rendering: Three.js with an orthographic camera, which reads as isometric. Roads, greenery and props use SimplePoly City (Unity Asset Store) converted to GLB in `town/assets/simplepoly-city/` by `town/tools/import-unitypackage.mjs`, placed at its native scale (road tile = 20 units). Buildings mix SimplePoly with Kenney City Kit Commercial/Suburban (fit to the lot). Street props also from Coding Creature City Props 1 (CC0, `assets/city-props/`). Characters are Kenney Mini Characters. 3D code in `town/`. (2D Phaser prototype was tried and dropped.)
- Two web folders, served together from the repo root by `python3 serve.py` (only `frontend/` and `town/`, never `.env`; no caching):
  - `frontend/` = the account app (no 3D): `index.html` + `app/app.css`, `app/app.js` (sign in → pick username → home, settings, help), `app/ui.js`, `app/wheel.js`, `app/character-preview.js` (the one 3D bit, loads three and models from `town/`). `shared/` is used by both folders: `session.js` (Supabase client, URL/key from `GET /demo/config`, authed `api()`), `config.js` (backend URL), `colors.js`. supabase-js is vendored in `frontend/lib/supabase.js`.
  - `town/` = the 3D map: `index.html` (`/town/?town=<id>`, redirects to `/frontend/` when signed out; if the backend is down the scripted town still runs) + `town.css`, `js/` modules: `main.js` (boot + frame loop), `layout.js` (which town, grid, places, friends), `assets.js` (model catalog), `stage.js` (renderer, scene, camera, lights), `models.js`, `city.js`, `people.js` (characters + walking), `camera.js` (focus + follow), `effects.js`, `demo.js`, `panels.js`, `occlusion.js`, `sky.js` (time, weather, night lights), `realtime.js` + `townsync.js` (backend bridges). Three.js vendored in `town/lib/`, models in `town/assets/`, asset import tool in `town/tools/`.
- Backend: Python 3.11+ / FastAPI, `supabase-py` (secret key), OpenRouter (`httpx` to `/api/v1/chat/completions`). Key: `OPENROUTER_API_KEY` (old name `GEMINI_MODEL_KEY` still accepted). Town Brain: `google/gemini-2.5-flash`. Character agents: `google/gemini-2.5-flash-lite`. Two asyncio loops; no Redis/Celery.
- Database: Supabase (Postgres + Auth + Realtime).

## Database

Hackathon-simple on purpose: 12 tables (10 core + friends/invites), plus `town_clock` and `loop_leases` so every process shares one clock and one agent writer. Add more only when a feature needs them. Schema lives in [supabase/migrations/](supabase/migrations/). Schema changes go in a **new** migration file. The Supabase GitHub integration applies new migrations on `main` automatically, so **never change the schema by hand in the dashboard**. Preview locally with `supabase db push --db-url "$SUPABASE_DB_URL" --dry-run`.

**Tables**
- `profiles`: one per user, auto-created on signup. Unique `username` (how people find each other; set via `PATCH /me`), avatar (`{character, color}`) and `interests` (text array).
- `towns`: name, `invite_code`, `tiles` and `map`. `tiles[y][x]` (any rectangular size up to 64x64) says what's on each tile: `road`, `park`, `pond`, `tree`, `path` (walkable grass with a light brown track), `stadium`, `farm`, `home`, `driveway`, `yard`, `lot` (frontend fills it procedurally), decorative scenes `garden`/`picnic`/`plaza`/`patio`, and symmetric-park pieces `oak`/`fountain`/`water` (small pond)/`bench-n|s|e|w` (bench's long side faces that direction), or an explicit model key (asset path without `assets/`/`.glb`). `map` holds named places `{places: {cafe: {name, model, tile, door}}}` plus scenery: `landmarks`, and `background_homes` `{color, homes: [{model, house: [x, y]}]}` (unowned one-tile houses; the tile holds the model key and the frontend paints their roofs `color`; no plot, driveway, fence, car or name tag). The city is exactly the grid; nothing is drawn past its edges. See `backend/town_map.py`; `python3 -m backend.seed_demo_map` writes the frontend's hard-coded city into `DEMO_TOWN_ID`.
- `town_members`: who's in which town, their house tile (`house_x/house_y`) and `home` details (`{model, driveway, door, block}`), and what the town hall AI currently shows for them (`mood`, `activity`, `state` JSON).
- `friendships`: in-town agent relationship, one row per pair (`user_a < user_b`) with `path_score`. Not the same as account friends.
- `signals`: raw inputs from users (`source` = manual, calendar, music, ...).
- `brain_runs`: each town hall AI run's `input` and `output`.
- `events`: things people share from their real life (class, work, gym, dinner) with `start_at`/`end_at`/`kind`/`building_id`/`travel_minutes`. Type `personal`. `building_id` is always set (home → `house:{user_id}`, campus → `library`, else `downtown`). News/quests are no longer stored here.
- `event_participants`: who is going to that calendar item.
- `agents`: one character per town member (position, current `action`, `target`, `next_decision_at`). Auto-created when a member joins.
- `agent_actions`: log of every agent decision; chat bubbles go in `details.lines`.
- `friend_requests`: account-level friends, one row per pair either direction. `accepted` = friends; unfriending deletes the row.
- `town_invites`: town creator invites a friend; accepting adds a `town_members` row. Invite codes still work too.

Migrations `20260926000000`-`000003` added 10 more tables; `20260926000004` reverts them (and the `claim_due_agents` / `towns_with_unprocessed_signals` functions, now done in Python in `backend/db.py`). Where the old concepts live now: facts → `brain_runs.output.facts` (id `<run_id>:<i>`), news → `brain_runs.output.news` (not the `events` table), conversations → `agent_actions.details.lines`, consent → posting a signal, per-person visibility → `signals.value.visibility` (`full`/`vague`/`hidden`). No gift inventory.

**Conventions**
- **Assets are not in the database.** Files live in the frontend with a code manifest; the DB stores manifest keys only. Building ids (`gym`, `cafe`, `house:{user_id}`) come from the town's `tiles` + members' `house_x/house_y` (`town_map.buildings`) and match the `PLACES` keys in `town/js/layout.js`.
- **Agents act on the town hall AI's output**, not on raw signals.
- **Live movement is client-side.** `agents` rows update only when someone decides to move, not per frame. A move stores the start (`agents.x/y`), start time (`updated_at`) and `target {building_id, x, y}`; every client animates the same path from that, so late viewers can place a walker mid-route. Requires identical map, pathfinding and walk speed on all clients.
- **Access:** the backend uses the secret key (bypasses RLS) for all AI/agent writes. The frontend (publishable key) can read everything in towns it belongs to, edit its own profile, add its own signals, and accept/decline its own events. Join a town with `supabase.rpc('join_town', { code })`; creating a town auto-adds the creator. Keys live in `.env` (gitignored); see `.env.example`.
- Realtime is on for `town_members`, `agents`, `agent_actions`, `events`, `event_participants`.
- The agent action menu is the `agent_action` enum; adding an action means a migration.
- Run backend from repo root: `py -3 -m uvicorn backend.main:app --reload` (`DISABLE_LOOPS=1` to skip the AI loops). API docs at `/docs`. Tests: `py -3 -m pytest`. Serve the web folders with `py -3 serve.py` (http://localhost:8080/frontend/).

**REST API** (`backend/routes/`). Every route except `/health` and `/demo/*` needs `Authorization: Bearer <supabase access token>`. The user is taken from the token, never from the request body.
- `GET/PATCH/DELETE /me` (profile incl. `username`, towns; DELETE removes the account, handing towns you created to their oldest member or deleting empty ones), `GET /me/friendships` (in-town path scores), `GET /me/invites`
- `GET /users/search?username=` (exact match), `GET /friends`, `DELETE /friends/{user_id}`, `GET/POST /friends/requests`, `POST /friends/requests/{id}/respond` (requesting someone who already asked you accepts)
- `GET/POST /towns/{id}/invites` (POST: creator only, friends only), `POST /invites/{id}/respond`
- `POST/GET /signals` (own only; `value.visibility` optional)
- `POST /towns {name, tiles, map, me: {name, color}}`, `GET /towns/lookup?invite_code=`, `POST /towns/join {invite_code, me}`, `GET /towns/{id}/identities`, `PATCH /towns/{id}/members/me/identity {name?, color?}`, `GET/PATCH /towns/{id}` (snapshot: town, members+profiles, agents; PATCH creator only), `PATCH/DELETE /towns/{id}/members/me` (place house / leave), `POST /towns/{id}/members/me/move {building_id, from_x, from_y}` (walk your character; pauses its AI for 10 min), `GET/POST /towns/{id}/events` (list / share a calendar item: class, gym, dinner), `GET /towns/{id}/activity` (agent_actions)
- `GET /events/{id}`, `POST /events/{id}/respond {status}`, `POST /events/{id}/approve`

## Demo Plan

`POST /demo/trigger/{goodNews|climbing|roughWeek}` inserts real `signals` only. Brain + agents produce the visible town. The 3D town (`town/js/realtime.js`) POSTs that endpoint with a 3s timeout, then falls back to scripted `trigger()` in `town/js/demo.js`. Live state is polled from `GET /demo/snapshot` (no Supabase login required). Set `DEMO_TOWN_ID`; any members work. The backend casts them into the five 3D character slots (`maya`/`jordan`/`sam`/`priya`/`leo`). A matching display name wins; otherwise slots fill in join order, reusing members if there are fewer than five. Snapshot and trigger return `characters` (user_id → slot), and the frontend relabels those characters with real names and hides unused ones. The scripted fallback still uses the original five. User calendars live in `events` (`type=personal`, with `start_at`/`end_at`). Seed the current town members (Drew, Romeer Dhillon, bob, patrik) and three days of class/work/dinner with `py -3 -m backend.scripts.seed_demo_schedules`. Snapshot includes `schedules`. Plan drafts treat those as busy time.

## Status

- [x] Repo scaffolding / stack chosen (FastAPI + Three.js)
- [x] Town rendering + camera (`frontend/`)
- [x] Database schema (10 core tables + `friend_requests`, `town_invites`)
- [x] Backend on the 10-table core schema, JWT-authed REST API (e2e-tested against live Supabase; brain/agent model calls need `OPENROUTER_API_KEY`)
- [x] Supabase project created (`uakgkgmdrayowbnpdroc`, us-west-2)
- [x] Town brain pipeline
- [x] Character agent loop + action menu
- [x] Quest respond + approval flow
- [x] Plan drafting (stub calendar/places, no model)
- [x] Demo signal triggers + 3D frontend live poll (`/demo/snapshot`) + scripted fallback
- [x] Demo calendars: five people, three days of class/work/dinner as `events` (`type=personal`)

## Decisions Log

- 2026-09-26: Characters walk the calendar instead of popping onto the door. The page moves them from where they are standing, starting `events.travel_minutes` before the event and arriving as it starts (and the same on the way home). A later event's leave time pulls them off an earlier one. Play/Fast were skipping that window: the agent only rechecked every 20 real seconds, which is 20 game minutes at the play rate, so the next write was already "idle at the door".

- 2026-09-26: Play button (▶/⏸ next to the time slider) runs the shared town clock at one game minute per real second: `POST /demo/clock {play:true}`, `town_clock.rate` 60, mode `play` (migration `20260926000013_clock_play`). Pause stops it at the minute on screen (a scrub). Walks and the calendar trigger follow the rate, so nothing else changed.

- 2026-09-26: Postgres decides whether a position is allowed (`20260926000012`). A process outside this repo was still writing `agents` with its own afternoon clock (tags `agent:`/`claim:`), and it set `written_by`, so the writer guard passed it. The trigger now rejects any position change that is not what the calendar says at `target.clock_at`, whose `clock_at` is off the `town_clock` row, or where an idle x/y is not the target door. Only a user's own move (`target.by = "user"`) skips the calendar check. The page ignores an idle row whose x/y is on a different door. The clock migration moved to `20260926000011` because `origin/main` added its own `000009`/`000010`.

- 2026-09-26: A placement is drawn only when it belongs to the hour on screen. A slower poll from the previous hour is dropped, and a walk that is already on screen is not restarted from the curb. That restart was the remaining teleport while the slider stayed put.

- 2026-09-26: Town time is a `town_clock` row (`20260926000011`), not `TOWN_CLOCK` plus process uptime. Live and Fast anchor at the hour already on screen. One agent loop holds `loop_leases` (`claim_loop_lease`); a second new process skips. `agents.written_by` must change on every update, so an older process that omits it cannot place people. The label still comes from `GET /demo/clock`.

- 2026-09-26: One town clock. The 3D label is set from `GET /demo/clock` on load and polled after that; it does not follow the laptop clock. Live cancels a pending slider post. Calendar position has one writer (`plan_clock_placement`); the client does not restart a walk when action, building, and depart time are unchanged.

- 2026-09-26: Split the web code: 3D town moved out of `frontend/` into top-level `town/` (page at `/town/?town=<id>`, was `frontend/town.html`), with the old 1,900-line `main.js` split into feature modules in `town/js/`. `frontend/` is the account app only (`app/`, `shared/`). Both are served from the repo root by `serve.py`, which serves only those two folders. Older entries below mention `frontend/main.js`; that code now lives in `town/js/`.

- 2026-09-26: General account UI in `frontend/index.html` + `app.js` (hash routes `#/`, `#/settings/<profile|character|account|appearance|privacy>`, `#/help`): app bar with account menu, profile (name, username, interests), character (look, rotatable 3D preview in `character-preview.js`), towns (per-town name + color via a color-wheel dialog in `wheel.js`, leave), join by invite code and accept invites on Home, account (email/password via Supabase auth, sign out everywhere), theme (light/dark/system, localStorage), privacy (what's shared, JSON data export, delete account). Shared bits in `ui.js` (toasts, confirm dialog, theme) and `colors.js`. No app-interactivity UI (signals, quests) yet.
- 2026-09-26: Name and color are per town, not global (migration `20260926000008`: `town_members.name`/`.color`, backfilled from profiles, unique name per town index). You pick both when you create (`POST /towns` `me`), join (`POST /towns/join` `me`) or accept an invite (`me` required when accepting), and change them with `PATCH /towns/{id}/members/me/identity`. No two members share a name (case/space-insensitive) or colors closer than CIE76 22 in Lab (API-checked, 409; `backend/identity.py`). `GET /towns/lookup?invite_code=` and `GET /towns/{id}/identities` list what's taken. Brain, agents, connections, demo and the 3D town use `member_name()` (town name, else profile). Profile keeps the account name and the character look. Gap: the `join_town` SQL RPC skips the checks; the app doesn't call it.
- 2026-09-26: Where someone stands follows the clock. Before a block they are idle at home; during the commute they are the fraction `(town time − depart) / travel_minutes` along the path; during the block they are idle at that door. A leftover target was leaving people at the library hours early, and the model is not asked to move them when nothing is happening.
- 2026-09-26: When a calendar block ends, the character walks home (`end_at` + travel) and stays there until they need to leave for the next one. No LLM.
- 2026-09-26: Every `events.building_id` is set (migration `20260926000007`). Seed and `POST /towns/{id}/events` fill it via `destination_for` (home → that person's house, campus/class → library, appointment/unknown → downtown). A null used to skip the trip, so the character stayed home.
- 2026-09-26: 3D polish (`frontend/main.js`). See-through buildings draw a depth-only pass first so only their front surface blends (no stacked glass "bars"). Windmill rotor spins (faster in rough weather). Weather is also in the lighting: one shader patch on every lit material (`addWeather`/`WX` in `main.js`) does snow cover, wet darkening + glossy roads in rain, overcast desaturation and drifting cloud shadows; overcast light is cool and flat with soft shadows, `scene.fog` hazes the far side in rain/snow/storm, and lamp pools grow on wet streets. Snow flakes are round and world-sized.
- 2026-09-26: Lakeside: friend homes are 2x2 plots (house, driveway, 2 yard tiles). About half the road-facing outer-ring tiles are one-tile background houses (23, `map.background_homes`, muted roofs), spread along every street; the rest are scene tiles (patio, plaza, garden, picnic) and small shops. Top-left corner block is Pocket Park (a `places` entry agents can visit): symmetric 3x3, oaks in the corners, a bench on each side facing a small central pond. Lakeside Green's two short access tiles are `path` (grass with a light brown track leading from the road toward the pond).
- 2026-09-26: Removed the river/green belt from the frontend entirely; a town is drawn as exactly its tile grid.
- 2026-09-26: The 3D left panel lists each resident's calendar from snapshot `schedules` (weekday + DD/MM/YYYY, time, place). The current town-clock block is highlighted.
- 2026-09-26: Demo snapshot follows the live Tiny Town (`DEMO_TOWN_ID`). An empty `characters` map no longer hides every 3D person.
- 2026-09-26: The time slider shows the town date under it (`Saturday 26/09/2026`) from `town_time`, not the browser clock.
- 2026-09-26: Live snapshot moods (rain over Ben, party lights on Ana) no longer steal the camera on town load. Scripted demo buttons still pan to the house. A drag cancels any leftover auto-pan.
- 2026-09-26: Frontend draws real towns from the DB. Home page lists your towns (`GET /me`); `town.html?town=<id>` loads `GET /towns/{id}` before building, so `main.js` constants (N, ROADS, PLACES, FRIENDS, ...) come from `tiles`/`map`/members and every viewer builds the identical city. In real towns there's no scripted wandering: `frontend/townsync.js` polls every 2s and `placeAgent` fast-forwards walks from `agents.x/y` + `updated_at`; auto-weather is random per viewer (sky can differ between screens). No `?town=` = the old hard-coded demo. AI moves now reset `agents.x/y` to the door of the last destination.
- 2026-09-26: The 3D slider owns town time while you drag. `POST /demo/clock` sets the shared clock (`mode=scrub`) and `snap_town_to_clock` moves agents to that hour's calendar place immediately (no LLM). Snapshot `mode=live` does not steal the slider back. Live / Fast day return control to the running clock.
- 2026-09-26: 3D labels follow the database: house signs use `profiles.display_name` (`Ana's house`), place signs use `towns.map.places[].name`. Snapshot still draws the hard-coded layout; names are applied from `/demo/snapshot`.
- 2026-09-26: Full town layout in the DB (migration `20260926000006`): tile kinds in `towns.tiles`, places + scenery in `towns.map`, homes in `town_members.home`, looks in `profiles.avatar`. Doors are stored (not derivable: the café touches two roads). Frontend still draws its hard-coded copy; it should build from `/demo/snapshot` (`tiles`, `map`, member `home`, `profiles.avatar`).
- 2026-09-26: Login/onboarding before the map: `index.html` is the auth + friends app, the 3D map moved to `town.html`. Username is required on first login.
- 2026-09-26: `backend/db.get_client()` is per-thread (was one cached client). Sharing one Supabase client across FastAPI's thread pool made parallel requests fail with `httpx.ReadError` (surfacing as 500s and bogus "invalid or expired token" 401s).
- 2026-09-26: Town map lives in `towns.tiles` (no migration). Users can walk their own character to a building; clients animate from start point + time. Frontend still draws the hard-coded map; it should build from `tiles` (snapshot now returns `tiles`, agent `x`/`y`, member houses).
- 2026-09-26: Known gap: `backend/seed_demo_map.py` still mirrors the old 12x12 city (roads 2/6/10, old friend house tiles). The frontend now draws a 17x17 town (roads 2/6/10/14, friend houses on their own outer blocks, `FRIENDS[].home.house`). Places kept their tiles, so building-id routing works; grid coordinates (house_x/y, agent x/y) need the seed updated before the frontend builds from `tiles`.
- 2026-09-26: Day/night + weather in `frontend/main.js` (`sky`, `updateSky`): time follows the real local clock (slider, "Fast day", `?hour=`), weather clear/rain/storm/snow drifts on its own (buttons, `?weather=`). At night street lamps glow warm and ~60% of windows light up; windows are found per wall triangle by texture color (Kenney glass = light blue, SimplePoly = flat dark grey). Browser pinch-zoom is blocked so only the camera zooms.
- 2026-09-26: Town is 17x17 (roads 2/6/10/14) around a central park with a pond. Outer ring of blocks is suburbs (2-3 houses a block); inner blocks zone by distance (Kenney skyscrapers only in the core, SimplePoly stretched at most 2x). Buildings only on road-facing lots, facing the road; suburb houses take every block corner first and sit flush to the street(s) (`seat()`); tiles with greenery are grass. Each friend owns an outer block: house with its roof in their color (`paintRoof()`) set back on a driveway, colored car/fence/mailbox/flag, "Name's house" label. Friend colors were a fixed palette avoiding scenery colors; now any color from the wheel (see 2026-09-26 identity entry). Stadium fills a 3x3 block.
- 2026-09-26: Town rebuilt on SimplePoly roads/greenery; buildings mix SimplePoly and Kenney City Kit Commercial/Suburban, interleaved per zone (Kenney roads kit removed). Same 12x12 grid, roads and `PLACES`. Place models: library = books shop, gym = auto service, cafe = coffee shop, market = super market. Buildings are zoned by distance from the (6,6) crossroad (`ZONES` in `main.js`): Kenney skyscrapers + SimplePoly towers stretched up to 3x in the core, then mid-rises, shops, houses at the edge. Jordan and Sam live in apartment towers.
- 2026-09-26: Added SimplePoly City (Unity Asset Store, Standard EULA) as 117 textured GLBs, converted without Unity via `frontend/tools/` (three FBXLoader + gltf-transform). Team chose to commit them to the public repo despite the EULA's redistribution limits.
- 2026-09-26: `events` are user-shared calendar items (class/work/gym/dinner), not town-generated news/quests. Migration `20260926000005` adds `start_at`/`end_at`/`kind`/`building_id`. Seed writes those rows for Drew, Romeer Dhillon, bob, and patrik. Brain no longer inserts news/quests into `events`.
- 2026-09-26: The demo no longer requires specific member names. Scenario targets are cast from whoever is in the demo town (`backend/routes/demo.py` `cast_roles`). Agents may cite active event ids as grounding, not just brain facts.
- 2026-09-26: Account friends + town invites (migration `20260926000005`, idempotent). Find people by exact `username`. Only the town creator invites, only friends. Writes go through the API; frontend reads via RLS.
- 2026-09-26: LLM calls go through OpenRouter with `OPENROUTER_API_KEY` (renamed from `GEMINI_MODEL_KEY`, which is still accepted as a fallback; not a Google AI Studio key; no `google-genai`). Default models `google/gemini-2.5-flash` and `google/gemini-2.5-flash-lite`. 3D demo buttons hit `POST /demo/trigger` and poll `GET /demo/snapshot`.
- 2026-09-26: Dropped the 2D Phaser prototype (and its backend/realtime wiring); going with 3D. The realtime integration needs porting to `frontend/`.
- 2026-09-25: `frontend/` 3D prototype (Three.js vendored in `lib/` via import map, orthographic camera, Kenney City Kit Commercial/Suburban/Roads + Mini Characters with walk/idle animations, MapControls for mouse + touch). Friends walk the streets (N/S/E/W only), stand on sidewalks at buildings, and can be followed with a third-person camera (click a person or `?follow=<id>`). `?auto=goodNews,climbing,roughWeek` plays the demo signals. Behavior is scripted, not agent-driven.
- 2026-09-25: Real character agents, grounded by the town brain, fixed action menu.
- 2026-09-25: Supabase. Condensed schema to 10 core tables. Assets are files; DB stores keys.
- 2026-09-26: Backend in `backend/`. Plan names map to live tables (`agents`, `town_members`). Extra loop tables are new migrations; `20260925000000_initial_schema.sql` is untouched. Postgres `agent_action` uses `walk_to` (`walk_to_building` is a validation alias). Invite-join max-uses and `purge_expired_signals` remain P1.
- 2026-09-26: Reverted the backend's extra tables (migration `20260926000004`); schema stays at the 10 core tables. Backend must adapt to it.
- 2026-09-26: Backend refactored onto the 10 core tables with no new migrations. API authenticates the Supabase JWT. The old `action_tasks` flow is replaced by event statuses `scheduled` → `confirmed`. `patrik/src/realtime.js` subscribes to `agent_actions` and news events instead of the dropped tables.

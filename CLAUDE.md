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

1. **Town brain**: `backend/loops/brain_loop.py` finds towns with signals newer than their last `brain_runs` row (`db.towns_with_unprocessed_signals`), then `run_brain_for_town` calls Sonnet. Output is Pydantic-validated and visibility-filtered, then written to `town_members` (mood/activity/state), `events` (news + quests) and `brain_runs.output` (facts).
2. **Character agents**: `agent_loop` claims due `agents` rows (`db.claim_due_agents`, conditional update) and Haiku picks from the fixed `agent_action` menu. A character's location is `agents.target.building_id`. Chat bubbles go in `agent_actions.details.lines`. Failures become `idle`.
3. **Plan drafting (stub, no model yet)**: when every participant accepts, `events.status` goes `suggested` → `scheduled` and `GET /events/{id}` includes a drafted `plan`. A participant approves it via `POST /events/{id}/approve` → `confirmed`. The draft is recomputed on read; persisting it needs a migration.

## Hard Rules

- **Agents only use real facts.** Never invent feelings, events, or relationships about real people.
- **Humans approve anything that leaves the town.** Agents never send messages as the user in real channels.
- **Fixed action menu.** New actions get added to the menu deliberately.
- **Pitch honestly.** Only call something an "agent" if a model is actually making decisions.
- **LLM output never hits Postgres raw.** Brain and agents go through `backend/agent/validate.py` (Brain also `backend/brain/visibility.py`). Those loops are the only writers to `brain_runs`, town-member AI fields (`mood`/`activity`/`state`), `agents.action`/`target`, and `agent_actions`.
- **`brain_runs` is readable by every town member.** Store only signal/member ids in `input` and only fully visible facts in `output`.

## Tech Stack

- Rendering: Three.js with an orthographic camera, which reads as isometric. Town (buildings, roads, trees, props) uses SimplePoly City (Unity Asset Store) converted to GLB in `patrik/3d/assets/simplepoly-city/` by `patrik/3d/tools/import-unitypackage.mjs`, placed at its native scale (road tile = 20 units). Characters are Kenney Mini Characters. Code in `patrik/3d/`. (2D Phaser prototype was tried and dropped.)
- Backend: Python 3.11+ / FastAPI, `supabase-py` (secret key), Anthropic SDK. Town Brain + action agent: `claude-sonnet-4-6`. Character agents: `claude-haiku-4-5-20251001`. Two asyncio loops; no Redis/Celery.
- Database: Supabase (Postgres + Auth + Realtime).

## Database

Hackathon-simple on purpose: 10 core tables, add more only when a feature needs them. Schema lives in [supabase/migrations/](supabase/migrations/). Schema changes go in a **new** migration file. The Supabase GitHub integration applies new migrations on `main` automatically, so **never change the schema by hand in the dashboard**. Preview locally with `supabase db push --db-url "$SUPABASE_DB_URL" --dry-run`.

**Tables**
- `profiles`: one per user, auto-created on signup. Avatar (JSON of asset keys) and `interests` (text array).
- `towns`: name, `invite_code`, and `tiles`, a 2D JSON array of asset manifest keys indexed `tiles[y][x]` (e.g. `[["grass","road"],["cafe","grass"]]`). Buildings are just tiles.
- `town_members`: who's in which town, their house position, and what the town hall AI currently shows for them (`mood`, `activity`, `state` JSON).
- `friendships`: one row per pair (`user_a < user_b`) with `path_score`.
- `signals`: raw inputs from users (`source` = manual, calendar, music, ...).
- `brain_runs`: each town hall AI run's `input` and `output`.
- `events`: quests, storylines, town events, news.
- `event_participants`: per-person `suggested`/`accepted`/`declined`. The approval gate.
- `agents`: one character per town member (position, current `action`, `target`, `next_decision_at`). Auto-created when a member joins.
- `agent_actions`: log of every agent decision; chat bubbles go in `details.lines`.

Migrations `20260926000000`-`000003` added 10 more tables; `20260926000004` reverts them (and the `claim_due_agents` / `towns_with_unprocessed_signals` functions, now done in Python in `backend/db.py`). Where the old concepts live now: facts → `brain_runs.output.facts` (id `<run_id>:<i>`), news → `events` with `type = 'news'`, conversations → `agent_actions.details.lines`, consent → posting a signal, per-person visibility → `signals.value.visibility` (`full`/`vague`/`hidden`). No gift inventory.

**Conventions**
- **Assets are not in the database.** Files live in the frontend with a code manifest; the DB stores manifest keys only. Building ids used by agents (`gym`, `cafe`, `house:{user_id}`) match the `PLACES` keys in `patrik/3d/main.js`.
- **Agents act on the town hall AI's output**, not on raw signals.
- **Live movement is client-side.** `agents` rows update only when an agent decides, not per frame.
- **Access:** the backend uses the secret key (bypasses RLS) for all AI/agent writes. The frontend (publishable key) can read everything in towns it belongs to, edit its own profile, add its own signals, and accept/decline its own events. Join a town with `supabase.rpc('join_town', { code })`; creating a town auto-adds the creator. Keys live in `.env` (gitignored); see `.env.example`.
- Realtime is on for `town_members`, `agents`, `agent_actions`, `events`, `event_participants`.
- The agent action menu is the `agent_action` enum; adding an action means a migration.
- Run backend from repo root: `py -3 -m uvicorn backend.main:app --reload` (`DISABLE_LOOPS=1` to skip the AI loops). API docs at `/docs`. Tests: `py -3 -m pytest`. Serve `patrik/` with `py -3 -m http.server` and open `/3d/`.

**REST API** (`backend/routes/`). Every route except `/health` and `/demo/*` needs `Authorization: Bearer <supabase access token>`. The user is taken from the token, never from the request body.
- `GET/PATCH /me` (profile, towns), `GET /me/friendships`
- `POST/GET /signals` (own only; `value.visibility` optional)
- `POST /towns`, `POST /towns/join {invite_code}`, `GET/PATCH /towns/{id}` (snapshot: town, members+profiles, agents; PATCH creator only), `PATCH/DELETE /towns/{id}/members/me` (place house / leave), `GET/POST /towns/{id}/events` (list with participants / propose a quest), `GET /towns/{id}/activity` (agent_actions)
- `GET /events/{id}`, `POST /events/{id}/respond {status}`, `POST /events/{id}/approve`

## Demo Plan

`POST /demo/trigger/{goodNews|climbing|roughWeek}` inserts real `signals` only. Brain + agents produce the visible town. The 3D frontend is not wired to it yet (the 2D Phaser version was); its buttons run the scripted `trigger()` in `patrik/3d/main.js`. Demo town members must be named Maya, Jordan, Sam, Priya, Leo; set `DEMO_TOWN_ID`.

## Status

- [x] Repo scaffolding / stack chosen (FastAPI + Three.js)
- [x] Town rendering + camera (`patrik/3d/`)
- [x] Database schema (10 core tables)
- [x] Backend on the 10-table core schema, JWT-authed REST API (e2e-tested against live Supabase; brain/agent model calls untested without `ANTHROPIC_API_KEY`)
- [x] Supabase project created (`uakgkgmdrayowbnpdroc`, us-west-2)
- [x] Town brain pipeline
- [x] Character agent loop + action menu
- [x] Quest respond + approval flow
- [x] Plan drafting (stub calendar/places, no model)
- [x] Demo signal triggers + frontend Realtime + scripted fallback

## Decisions Log

- 2026-09-26: Town rebuilt on SimplePoly City; Kenney city kits removed (Kenney Mini Characters kept). Same 12x12 grid, roads and `PLACES`. Place models: library = books shop, gym = auto service, cafe = coffee shop, market = super market. Buildings are zoned by distance from the (6,6) crossroad (`ZONES` in `main.js`): towers stretched up to 3x in the core, then mid-rises, shops, houses at the edge. Jordan and Sam live in apartment towers.
- 2026-09-26: Added SimplePoly City (Unity Asset Store, Standard EULA) as 117 textured GLBs, converted without Unity via `patrik/3d/tools/` (three FBXLoader + gltf-transform). Team chose to commit them to the public repo despite the EULA's redistribution limits.
- 2026-09-26: Dropped the 2D Phaser prototype (and its backend/realtime wiring); going with 3D. The realtime integration needs porting to `patrik/3d/`.
- 2026-09-25: `patrik/3d/` 3D prototype (Three.js vendored in `lib/` via import map, orthographic camera, Kenney City Kit Commercial/Suburban/Roads + Mini Characters with walk/idle animations, MapControls for mouse + touch). Friends walk the streets (N/S/E/W only), stand on sidewalks at buildings, and can be followed with a third-person camera (click a person or `?follow=<id>`). `?auto=goodNews,climbing,roughWeek` plays the demo signals. Behavior is scripted, not agent-driven.
- 2026-09-25: Real character agents, grounded by the town brain, fixed action menu.
- 2026-09-25: Supabase. Condensed schema to 10 core tables. Assets are files; DB stores keys.
- 2026-09-26: Backend in `backend/`. Plan names map to live tables (`agents`, `town_members`). Extra loop tables are new migrations; `20260925000000_initial_schema.sql` is untouched. Postgres `agent_action` uses `walk_to` (`walk_to_building` is a validation alias). Invite-join max-uses and `purge_expired_signals` remain P1.
- 2026-09-26: Reverted the backend's extra tables (migration `20260926000004`); schema stays at the 10 core tables. Backend must adapt to it.
- 2026-09-26: Backend refactored onto the 10 core tables with no new migrations. API authenticates the Supabase JWT. The old `action_tasks` flow is replaced by event statuses `scheduled` → `confirmed`. `patrik/src/realtime.js` subscribes to `agent_actions` and news events instead of the dropped tables.

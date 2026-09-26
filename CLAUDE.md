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

1. **Town brain**: `backend/loops/brain_loop.py` finds towns with signals newer than their last `brain_runs` row (`db.towns_with_unprocessed_signals`), then `run_brain_for_town` calls Gemini Flash via OpenRouter. Output is Pydantic-validated and visibility-filtered, then written to `town_members` (mood/activity/state), `events` (news + quests) and `brain_runs.output` (facts).
2. **Character agents**: `agent_loop` claims due `agents` rows (`db.claim_due_agents`, conditional update) and Gemini Flash-Lite (OpenRouter) picks from the fixed `agent_action` menu. A character's location is `agents.target.building_id`. Chat bubbles go in `agent_actions.details.lines`. Failures become `idle`.
3. **Plan drafting (stub, no model yet)**: when every participant accepts, `events.status` goes `suggested` → `scheduled` and `GET /events/{id}` includes a drafted `plan`. A participant approves it via `POST /events/{id}/approve` → `confirmed`. The draft is recomputed on read; persisting it needs a migration.

## Hard Rules

- **Agents only use real facts.** Never invent feelings, events, or relationships about real people.
- **Humans approve anything that leaves the town.** Agents never send messages as the user in real channels.
- **Fixed action menu.** New actions get added to the menu deliberately.
- **Pitch honestly.** Only call something an "agent" if a model is actually making decisions.
- **LLM output never hits Postgres raw.** Brain and agents go through `backend/agent/validate.py` (Brain also `backend/brain/visibility.py`). Those loops are the only writers to `brain_runs`, town-member AI fields (`mood`/`activity`/`state`), `agents.action`/`target`, and `agent_actions`. The one exception is a person moving their own character via `POST /towns/{id}/members/me/move` (validated, marked `target.by = "user"`).
- **`brain_runs` is readable by every town member.** Store only signal/member ids in `input` and only fully visible facts in `output`.

## Tech Stack

- Rendering: Three.js with an orthographic camera + Kenney 3D kits (city buildings, roads, trees, characters), which read as isometric. Code in `frontend/`. (2D Phaser prototype was tried and dropped.)
- Backend: Python 3.11+ / FastAPI, `supabase-py` (secret key), OpenRouter (`httpx` to `/api/v1/chat/completions`). Key: `OPENROUTER_API_KEY` (old name `GEMINI_MODEL_KEY` still accepted). Town Brain: `google/gemini-2.5-flash`. Character agents: `google/gemini-2.5-flash-lite`. Two asyncio loops; no Redis/Celery.
- Database: Supabase (Postgres + Auth + Realtime).

## Database

Hackathon-simple on purpose: 12 tables (10 core + friends/invites), add more only when a feature needs them. Schema lives in [supabase/migrations/](supabase/migrations/). Schema changes go in a **new** migration file. The Supabase GitHub integration applies new migrations on `main` automatically, so **never change the schema by hand in the dashboard**. Preview locally with `supabase db push --db-url "$SUPABASE_DB_URL" --dry-run`.

**Tables**
- `profiles`: one per user, auto-created on signup. Unique `username` (how people find each other; set via `PATCH /me`), avatar (JSON of asset keys) and `interests` (text array).
- `towns`: name, `invite_code`, and `tiles`, the town map: a 2D JSON array of asset manifest keys indexed `tiles[y][x]`. Keys: terrain (`road`, `park`, `tree`), filler buildings (`skyscraper-a`, `commercial-f`, `house-k`), and named places (`library`, `gym`, `cafe`, `market`, `park`, `downtown`; a place's tile is its location, see `backend/town_map.py`). Road pieces, facing and doors are derived from the grid, not stored. `python3 -m backend.seed_demo_map` writes the frontend's hard-coded city into `DEMO_TOWN_ID`.
- `town_members`: who's in which town, their house position, and what the town hall AI currently shows for them (`mood`, `activity`, `state` JSON).
- `friendships`: in-town agent relationship, one row per pair (`user_a < user_b`) with `path_score`. Not the same as account friends.
- `signals`: raw inputs from users (`source` = manual, calendar, music, ...).
- `brain_runs`: each town hall AI run's `input` and `output`.
- `events`: quests, storylines, town events, news.
- `event_participants`: per-person `suggested`/`accepted`/`declined`. The approval gate.
- `agents`: one character per town member (position, current `action`, `target`, `next_decision_at`). Auto-created when a member joins.
- `agent_actions`: log of every agent decision; chat bubbles go in `details.lines`.
- `friend_requests`: account-level friends, one row per pair either direction. `accepted` = friends; unfriending deletes the row.
- `town_invites`: town creator invites a friend; accepting adds a `town_members` row. Invite codes still work too.

Migrations `20260926000000`-`000003` added 10 more tables; `20260926000004` reverts them (and the `claim_due_agents` / `towns_with_unprocessed_signals` functions, now done in Python in `backend/db.py`). Where the old concepts live now: facts → `brain_runs.output.facts` (id `<run_id>:<i>`), news → `events` with `type = 'news'`, conversations → `agent_actions.details.lines`, consent → posting a signal, per-person visibility → `signals.value.visibility` (`full`/`vague`/`hidden`). No gift inventory.

**Conventions**
- **Assets are not in the database.** Files live in the frontend with a code manifest; the DB stores manifest keys only. Building ids (`gym`, `cafe`, `house:{user_id}`) come from the town's `tiles` + members' `house_x/house_y` (`town_map.buildings`) and match the `PLACES` keys in `frontend/main.js`.
- **Agents act on the town hall AI's output**, not on raw signals.
- **Live movement is client-side.** `agents` rows update only when someone decides to move, not per frame. A move stores the start (`agents.x/y`), start time (`updated_at`) and `target {building_id, x, y}`; every client animates the same path from that, so late viewers can place a walker mid-route. Requires identical map, pathfinding and walk speed on all clients.
- **Access:** the backend uses the secret key (bypasses RLS) for all AI/agent writes. The frontend (publishable key) can read everything in towns it belongs to, edit its own profile, add its own signals, and accept/decline its own events. Join a town with `supabase.rpc('join_town', { code })`; creating a town auto-adds the creator. Keys live in `.env` (gitignored); see `.env.example`.
- Realtime is on for `town_members`, `agents`, `agent_actions`, `events`, `event_participants`.
- The agent action menu is the `agent_action` enum; adding an action means a migration.
- Run backend from repo root: `py -3 -m uvicorn backend.main:app --reload` (`DISABLE_LOOPS=1` to skip the AI loops). API docs at `/docs`. Tests: `py -3 -m pytest`. Serve `frontend/` with `py -3 -m http.server`.

**REST API** (`backend/routes/`). Every route except `/health` and `/demo/*` needs `Authorization: Bearer <supabase access token>`. The user is taken from the token, never from the request body.
- `GET/PATCH /me` (profile incl. `username`, towns), `GET /me/friendships` (in-town path scores), `GET /me/invites`
- `GET /users/search?username=` (exact match), `GET /friends`, `DELETE /friends/{user_id}`, `GET/POST /friends/requests`, `POST /friends/requests/{id}/respond` (requesting someone who already asked you accepts)
- `GET/POST /towns/{id}/invites` (POST: creator only, friends only), `POST /invites/{id}/respond`
- `POST/GET /signals` (own only; `value.visibility` optional)
- `POST /towns`, `POST /towns/join {invite_code}`, `GET/PATCH /towns/{id}` (snapshot: town, members+profiles, agents; PATCH creator only), `PATCH/DELETE /towns/{id}/members/me` (place house / leave), `POST /towns/{id}/members/me/move {building_id, from_x, from_y}` (walk your character; pauses its AI for 10 min), `GET/POST /towns/{id}/events` (list with participants / propose a quest), `GET /towns/{id}/activity` (agent_actions)
- `GET /events/{id}`, `POST /events/{id}/respond {status}`, `POST /events/{id}/approve`

## Demo Plan

`POST /demo/trigger/{goodNews|climbing|roughWeek}` inserts real `signals` only. Brain + agents produce the visible town. The 3D frontend (`frontend/realtime.js`) POSTs that endpoint with a 3s timeout, then falls back to scripted `trigger()` in `frontend/main.js`. Live state is polled from `GET /demo/snapshot` (no Supabase login required). Set `DEMO_TOWN_ID`; any members work. The backend casts them into the five 3D character slots (`maya`/`jordan`/`sam`/`priya`/`leo`). A matching display name wins; otherwise slots fill in join order, reusing members if there are fewer than five. Snapshot and trigger return `characters` (user_id → slot), and the frontend relabels those characters with real names and hides unused ones. The scripted fallback still uses the original five.

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

## Decisions Log

- 2026-09-26: Town map lives in `towns.tiles` (no migration). Users can walk their own character to a building; clients animate from start point + time. Frontend still draws the hard-coded map; it should build from `tiles` (snapshot now returns `tiles`, agent `x`/`y`, member houses).
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

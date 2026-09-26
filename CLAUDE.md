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

## Architecture (planned)

1. **Town brain**: one central AI pipeline. Runs periodically (~15 min) or when a friend's signals change. Reads opted-in signals and outputs structured town state: each friend's mood/location/status, shared interests, upcoming events, plus quests, storylines, and town news.
2. **Character agents**: each friend's character has a lightweight agent (small, fast model) that wakes at decision points (every few minutes or on state change), looks at town state, and picks the next action from a **fixed menu**: walk to a building, visit/knock, chat with another character, leave a gift, propose an event, go home. Pathfinding and animation handle movement between decisions.
3. **Action agents**: when a user accepts a quest/event, a real tool-using agent does the multi-step work (check calendars, find a time, create the plan, draft invites).

## Hard Rules

- **Agents only use real facts.** A character agent may only use what its person shared, as interpreted by the town brain. Never invent feelings, events, or relationships about real people.
- **Humans approve anything that leaves the town.** Agents act freely inside the town, but anything reaching a real person needs that person's approval. Agents never send messages as the user in real channels.
- **Fixed action menu.** Don't let character agents free-form actions; new actions get added to the menu deliberately.
- **Pitch honestly.** Only call something an "agent" if a model is actually making decisions.

## Tech Stack (tentative, update when decided)

- Rendering: leaning Three.js / React Three Fiber with an orthographic camera + Kenney 3D kits (town/city buildings, roads, trees, characters), which read as isometric. Fallback: fully 2D with Phaser + Kenney 2D isometric packs.
- Assets: Kenney (kenney.nl). Search "isometric" for 2D packs; 3D kits live under the 3D section.
- Database: Supabase (Postgres + Auth + Realtime). See **Database** below.
- Models: TBD (small fast model for character agents; stronger model for town brain and action agents).

## Database

Hackathon-simple on purpose: add tables only when a feature needs them. Schema lives in [supabase/migrations/](supabase/migrations/). Schema changes go in a **new** migration file. Apply with `supabase db push --db-url "$SUPABASE_DB_URL"` (after `source .env`); add `--dry-run` first to preview. Update this section when tables change.

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

**Conventions**
- **Assets are not in the database.** Files live in the frontend (`public/assets/`) with a code manifest; the DB stores manifest keys only.
- **Agents act on the town hall AI's output**, not on raw signals.
- **Live movement is client-side.** `agents` rows update only when an agent decides, not per frame.
- **Access:** the backend uses the secret key (bypasses RLS) for all AI/agent writes. The frontend (publishable key) can read everything in towns it belongs to, edit its own profile, add its own signals, and accept/decline its own events. Join a town with `supabase.rpc('join_town', { code })`; creating a town auto-adds the creator. Keys live in `.env` (gitignored); see `.env.example`.
- Realtime is on for `town_members`, `agents`, `agent_actions`, `events`, `event_participants`.
- The agent action menu is the `agent_action` enum; adding an action means a migration.

## Demo Plan

Have triggerable signals ready (a friend "gets" good news; two friends both mention climbing) so judges see the town react live: party lights appear, characters walk to the café/square, a chat bubble plays out, and a quest pops up for the two real friends.

## Status

- [ ] Repo scaffolding / stack chosen
- [ ] Town rendering + camera
- [x] Database schema (Supabase migration + RLS)
- [x] Supabase project created (`uakgkgmdrayowbnpdroc`, us-west-2), condensed schema applied and verified
- [ ] Town brain pipeline
- [ ] Character agent loop + action menu
- [ ] Quest UI + approval flow
- [ ] Action agent (calendar/plan)
- [ ] Demo signal triggers

## Decisions Log

- 2026-09-25: Characters get real agents with initiative, grounded by the town brain's state and a fixed action menu (not pure rule-driven, not free-running per-character LLMs).
- 2026-09-25: Supabase for the database. Asset files ship with the frontend; the DB stores only manifest keys and layouts, so towns (including generated ones) are data, not files.
- 2026-09-25: Condensed schema to 10 tables for the hackathon; towns store tiles as one 2D array. Dropped visibility/consent/integration tables until needed.

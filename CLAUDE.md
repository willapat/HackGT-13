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

1. **Town brain**: FastAPI loop in `backend/loops/brain_loop.py` polls `towns_with_unprocessed_signals()`, then `run_brain_for_town` calls Claude Sonnet. Output is Pydantic-validated and visibility-filtered before any write.
2. **Character agents**: `agent_loop` atomically claims due `agents` rows (`claim_due_agents` RPC) and Haiku picks from the fixed `agent_action` menu. Failures become `idle`.
3. **Action agent**: after every required participant accepts, `events.status` → `scheduled`, an `action_tasks` row is created, stub calendar/places tools draft a plan, human approves via `POST /action_tasks/{id}/approve`.

## Hard Rules

- **Agents only use real facts.** Never invent feelings, events, or relationships about real people.
- **Humans approve anything that leaves the town.** Agents never send messages as the user in real channels.
- **Fixed action menu.** New actions get added to the menu deliberately.
- **Pitch honestly.** Only call something an "agent" if a model is actually making decisions.
- **LLM output never hits Postgres raw.** Brain and agents go through `backend/agent/validate.py` (Brain also `backend/brain/visibility.py`). Those loops are the only writers to `facts`, town-member AI fields, `agents`, `agent_conversations`, and `news`.

## Tech Stack

- Rendering: Phaser 3 + Kenney 2D isometric (`patrik/`).
- Backend: Python 3.11+ / FastAPI, `supabase-py` (secret key), Anthropic SDK. Town Brain + action agent: `claude-sonnet-4-6`. Character agents: `claude-haiku-4-5-20251001`. Two asyncio loops; no Redis/Celery.
- Database: Supabase (Postgres + Auth + Realtime).

## Database

Schema lives in [supabase/migrations/](supabase/migrations/). Schema changes go in a **new** migration file. Apply with `supabase db push --db-url "$SUPABASE_DB_URL"` (after loading `.env`); add `--dry-run` first.

**Live tables (initial schema)**
- `profiles`, `towns`, `town_members` (mood/activity/state = member_state), `friendships`, `signals`, `brain_runs`, `events`, `event_participants`, `agents` (agent_state), `agent_actions`.

**Added for the backend (migrations `20260926*`)**
- RPCs: `claim_due_agents`, `towns_with_unprocessed_signals`
- `facts`, `visibility_rules`, `consents`, `inventory`, `news`, `agent_conversations`, `action_tasks`, `notifications`, `interactions`, `path_score_history`
- `events.details`, `signals.expires_at`
- Starting `gift` inventory on new profiles

**Conventions**
- Building ids used by agents (`gym`, `cafe`, `house:{user_id}`) match `patrik/` place keys.
- Agents act on Brain output, not raw signals.
- Live movement is client-side; `agents` rows update on decisions.
- Backend uses the secret key. Frontend uses the publishable key + Realtime.
- Run backend from repo root: `py -3 -m uvicorn backend.main:app --reload`. Serve `patrik/` with `py -3 -m http.server`.

## Demo Plan

`POST /demo/trigger/{goodNews|climbing|roughWeek}` inserts real `signals` only. Brain + agents produce the visible town. Phaser buttons call that endpoint with a 3s timeout, then fall back to scripted `trigger()` in `main.js`. Demo town members must be named Maya, Jordan, Sam, Priya, Leo; set `DEMO_TOWN_ID`.

## Status

- [x] Repo scaffolding / stack chosen (FastAPI + Phaser)
- [x] Town rendering + camera (`patrik/`)
- [x] Database schema (initial + backend support migrations)
- [x] Supabase project created (`uakgkgmdrayowbnpdroc`, us-west-2)
- [x] Town brain pipeline
- [x] Character agent loop + action menu
- [x] Quest respond + approval flow
- [x] Action agent (stub calendar/places)
- [x] Demo signal triggers + frontend Realtime + scripted fallback

## Decisions Log

- 2026-09-25: `patrik/` Phaser 3 + Kenney 2D isometric prototype. `?auto=goodNews,climbing,roughWeek` plays demo signals.
- 2026-09-25: Real character agents, grounded by the town brain, fixed action menu.
- 2026-09-25: Supabase. Condensed schema to 10 core tables. Assets are files; DB stores keys.
- 2026-09-26: Backend in `backend/`. Plan names map to live tables (`agents`, `town_members`). Extra loop tables are new migrations; `20260925000000_initial_schema.sql` is untouched. Postgres `agent_action` uses `walk_to` (`walk_to_building` is a validation alias). Invite-join max-uses and `purge_expired_signals` remain P1.

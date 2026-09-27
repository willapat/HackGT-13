# Luma

**Your friend group as a little 3D town.** Each character is one of your real friends, going about their real week: heading to class, the gym, the café. The town notices what friends choose to share (a rough week, good news, a new obsession) and nudges you toward showing up for each other in real life: a message, a check-in, a plan.

Live at **https://luma-hackgt.vercel.app** · Built at HackGT 13.

## What you can do

- **Walk around your town.** An isometric 3D town where every house belongs to a friend, roofs in their color. Characters walk to wherever their calendar says they are. Tap a person to follow them, tap a place to see who's there, tap a mailbox to leave a note.
- **See who's around.** Set yourself Free or Busy for a few hours, and your ring shows it on every avatar. Home shows who's free now, what's on everyone's calendar today, and who you haven't crossed paths with lately.
- **Share what's going on.** Post to one town, to all your friends, or privately. A private post only nudges your character's mood, for example a rain cloud over your house; nobody sees your words.
- **Let the town connect people.** An AI "town brain" reads what friends share and updates moods and town news. AI characters bump into each other and chat, and suggest plans. Each town has a weekly paper with the busiest places and who should get together.
- **Make real plans.** Suggested plans land in your Inbox. Nothing happens unless everyone says yes and a person approves it.
- **Connect Google Calendar.** Your character goes where your events are. Townmates see only the place ("At the Library"), never your event titles.
- **Create a town from a description.** "A cozy snowy village with a hot cocoa café." You see the design, ask for changes, then invite friends.

## Principles

- **Real friendships first.** Every feature should push toward a real-world connection, not more time in the app.
- **Only real facts.** The AI never invents feelings, events or relationships about real people. It works only from what people opt in to share.
- **Humans approve anything that leaves the town.** Characters can suggest things; they never message anyone as you.
- **Friends are found by username only,** never by email.

## How it works

```
Browser ─── luma-hackgt.vercel.app ───┬── frontend/  account app (feed, friends, inbox, profile, settings)
  (Vercel, static)                    ├── town/      the 3D town (Three.js)
                                      └── /api/* ──► FastAPI backend on Fly.io ──► Supabase (Postgres, Auth, Realtime)
                                                     ├─ town brain loop: signals → moods, news, facts (LLM)
                                                     ├─ character agent loop: who goes where, who chats (LLM)
                                                     └─ calendar loop: Google Calendar → events → where characters walk
```

- **Frontend:** plain HTML, CSS and JS modules, no build step. `frontend/` is the account app, and `town/` is the 3D town built with Three.js using SimplePoly City and Kenney models.
- **Backend:** Python 3.11 + FastAPI in `backend/`. It serves the REST API and runs the AI loops in the same process. Every AI call goes through `backend/llm.py`, which uses xAI Grok, or OpenRouter as a fallback, and all model output is validated before it reaches the database.
- **Database:** Supabase. The schema lives in `supabase/migrations/`. The 3D town follows live changes over Supabase Realtime.

`CLAUDE.md` has the full architecture, the database tables, the API routes and a log of design decisions. Read it before changing how something works.

## Repo layout

| Path | What's there |
|---|---|
| `frontend/` | Account app: `index.html`, `app/` (app logic, styles, town card art, desk notes), `shared/` (Supabase session, API helper) |
| `town/` | 3D town: `index.html`, `town.css`, `js/` modules, vendored Three.js in `lib/`, models in `assets/` |
| `backend/` | FastAPI app (`main.py`), routes, the brain and agent loops, town generation (`towngen/`), tests (`tests/`) |
| `supabase/migrations/` | Database schema, one SQL file per change |
| `serve.py` | Local static server for `frontend/` and `town/` (never serves `.env`) |
| `vercel.json`, `Dockerfile`, `fly.toml` | Deploy config for the web app and the backend |

## Running locally

All commands run from the repo root. Needs Python 3.11+.

**1. One-time setup**

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
cp .env.example .env   # then fill it in (see below)
```

On Windows use `py -3 -m venv .venv` and `.venv\Scripts\python` instead of `.venv/bin/python`.

`.env` needs at least:

- `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`: from the Supabase dashboard.
- `XAI_API_KEY` or `OPENROUTER_API_KEY`: for the AI features. Without one the app still runs, but the town brain and characters don't act, and things like post ideas and the paper use simple non-AI versions.
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`: only if you want Google Calendar sync.

The comments in `.env.example` explain each setting.

**2. Start the backend** (port 8000; API docs at http://localhost:8000/docs)

```sh
.venv/bin/python -m uvicorn backend.main:app --reload
```

Set `DISABLE_LOOPS=1` to run the API without the AI loops. Use this when the deployed backend is already running them, so two copies don't compete.

**3. Start the web app** (second terminal, port 8080)

```sh
.venv/bin/python serve.py
```

Open http://localhost:8080/frontend/. The 3D town is at http://localhost:8080/town/?town=<id>. On localhost the web app talks to your local backend automatically.

**Tests:** `.venv/bin/python -m pytest`

## Deploying

Pushing to `main` deploys everything automatically:

| Part | Where | Deploys when a push to `main` changes |
|---|---|---|
| Web app | Vercel (Git integration) | anything in the repo, but only `frontend/` and `town/` are published |
| Backend | Fly.io, app `luma-hackgt` (GitHub Action in `.github/workflows/fly-deploy.yml`) | `backend/`, `requirements.txt`, `Dockerfile`, `fly.toml` |
| Database | Supabase (GitHub integration) | new files in `supabase/migrations/` |

Pushes to other branches get a Vercel preview link and don't touch the backend or the database. The site reaches the backend through `/api`, which `vercel.json` forwards to `luma-hackgt.fly.dev`.

## Contributing

- **`main` is production.** Anything pushed there is live within a minute or two, so run the tests first.
- **Schema changes go in a new migration file** with a unique timestamp prefix, for example `20260927000001_what_it_does.sql`. Never change the schema by hand in the Supabase dashboard. Two files with the same prefix stop Supabase from applying the second one.
- **This repo is public.** Never commit `.env`, API keys or tokens.
- **Update `CLAUDE.md`** when you make a decision, add a dependency or change how something works.

## Credits

Characters and buildings by [Kenney](https://kenney.nl) (CC0), SimplePoly City (Unity Asset Store), and Coding Creature City Props (CC0). Fonts: Fredoka, Nunito and Caveat (Google Fonts).

# Luma

A little isometric town where each resident is one of your real friends. An AI reads what friends choose to share and turns it into a living world: someone having a stormy week gets a rain cloud over their house, good news gets party lights, and when two friends share an interest their characters run into each other at the café. The town then suggests real plans ("you both want to try climbing, go this weekend?"), and nothing reaches a real person unless they approve it.

The goal is to strengthen real friendships: help people notice when friends need them, find what they have in common, and actually spend time together offline.

Built for HackGT 13.

## Running locally

All commands run from the repo root (`HackGT-13/`). Needs Python 3.11+.

**1. One-time setup**

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
cp .env.example .env   # then fill in the Supabase keys and an AI key (see comments in the file)
```

On Windows use `py -3 -m venv .venv` and `.venv\Scripts\python` instead of `.venv/bin/python`.

**2. Start the backend** (port 8000; API docs at http://localhost:8000/docs)

```sh
.venv/bin/python -m uvicorn backend.main:app --reload
```

Set `DISABLE_LOOPS=1` to run the API without the AI town brain and character loops.

**3. Start the web app** (in a second terminal, port 8080)

```sh
.venv/bin/python serve.py
```

Open http://localhost:8080/frontend/ for the account app. The 3D town is at http://localhost:8080/town/?town=<id>. `serve.py` serves only `frontend/` and `town/`, so `.env` stays private.

**Tests:** `.venv/bin/python -m pytest`

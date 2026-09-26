# Tiny Town

A little isometric town where each resident is one of your real friends. An AI reads what friends choose to share and turns it into a living world: someone having a stormy week gets a rain cloud over their house, good news gets party lights, and when two friends share an interest their characters run into each other at the café. The town then suggests real plans ("you both want to try climbing, go this weekend?"), and nothing reaches a real person unless they approve it.

The goal is to strengthen real friendships: help people notice when friends need them, find what they have in common, and actually spend time together offline.

Built for HackGT 13.

# Run backend locally
- make sure you are in the root HackGT-13 dir then run:
python3 -m uvicorn backend.main:app --reload

# Run frontend locally (run backend first)
cd frontend
python3 -m http.server 8080

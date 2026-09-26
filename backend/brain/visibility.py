"""Filter Brain output before anything is written. Fails closed.

Each signal can carry `value.visibility` ('full' default, 'mood', 'vague', 'hidden'). 'mood' is a private
post: your character's mood may change (the weather over your house) but no facts, news, plans or activity
text come from it. A person's level for a run is the strictest level among their new signals. `brain_runs` is readable by every town member,
so only fully shareable facts are kept at all.
"""

from backend.models.brain import BrainOutput, MemberState
from backend.models.enums import Mood, Visibility

LEVELS = [Visibility.full.value, Visibility.mood.value, Visibility.vague.value, Visibility.hidden.value]  # least → most private
NEUTRAL_MOOD = Mood.cloudy.value
VAGUE_ACTIVITY = "is out and about"


def _strictest(*levels: str) -> str:
    return max(levels, key=LEVELS.index)


def signal_level(signal: dict) -> str:
    level = (signal.get("value") or {}).get("visibility")
    return level if level in LEVELS else Visibility.full.value


def user_levels(signals: list[dict]) -> dict[str, str]:
    out: dict[str, str] = {}
    for s in signals:
        out[s["user_id"]] = _strictest(out.get(s["user_id"], Visibility.full.value), signal_level(s))
    return out


def apply_visibility(output: BrainOutput, signals: list[dict], members: list[dict]) -> BrainOutput:
    """`members` are the town's current town_members rows; anything about a non-member is dropped."""
    prev = {m["user_id"]: m for m in members}
    levels = user_levels(signals)

    def level(uid: str) -> str:
        return levels.get(uid, Visibility.full.value)

    facts = [
        f for f in output.facts
        if f.user_id in prev and _strictest(f.visibility.value, level(f.user_id)) == Visibility.full.value
    ]

    member_states = []
    for s in output.member_states:
        if s.user_id not in prev:
            continue
        if level(s.user_id) == Visibility.hidden.value:
            # Keep whatever the town already showed, so nothing changes visibly.
            before = prev[s.user_id]
            mood = before.get("mood") if before.get("mood") in {m.value for m in Mood} else NEUTRAL_MOOD
            s = MemberState(user_id=s.user_id, mood=mood, activity=before.get("activity"))
        elif level(s.user_id) == Visibility.mood.value:
            # Private post: the feeling shows on your character, the words and what you're doing don't
            s = MemberState(user_id=s.user_id, mood=s.mood, activity=prev[s.user_id].get("activity"), props=s.props)
        elif level(s.user_id) == Visibility.vague.value:
            s = MemberState(user_id=s.user_id, mood=NEUTRAL_MOOD, activity=VAGUE_ACTIVITY)
        member_states.append(s)

    # News is free text the whole town sees: drop it if anyone in this run shared less than fully.
    private_run = any(lv != Visibility.full.value for lv in levels.values())
    news = [] if private_run else list(output.news)

    quests = [
        q for q in output.quest_candidates
        if len(set(q.participant_user_ids)) >= 2
        and all(uid in prev and level(uid) == Visibility.full.value for uid in q.participant_user_ids)
    ]

    return BrainOutput(facts=facts, member_states=member_states, news=news, quest_candidates=quests)

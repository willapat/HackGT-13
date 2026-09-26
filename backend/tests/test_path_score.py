from datetime import datetime, timedelta, timezone

from backend.interactions.path_score import IN_TOWN_DELTA, REAL_LIFE_DELTA, clamp, next_path_score
from backend.models.enums import InteractionVia


def test_clamp():
    assert clamp(-1) == 0
    assert clamp(2) == 1
    assert clamp(0.4) == 0.4


def test_in_town_bump():
    score, delta = next_path_score(0.5, InteractionVia.in_town.value, None)
    assert delta == IN_TOWN_DELTA
    assert score == 0.55


def test_real_life_bump():
    score, delta = next_path_score(0.5, InteractionVia.real_life.value, None)
    assert delta == REAL_LIFE_DELTA
    assert score == 0.65


def test_decay_and_clamp_high():
    last = (datetime.now(timezone.utc) - timedelta(days=10)).isoformat()
    score, delta = next_path_score(0.99, InteractionVia.in_town.value, last)
    assert abs(delta - (IN_TOWN_DELTA - 0.10)) < 1e-6
    assert 0 <= score <= 1

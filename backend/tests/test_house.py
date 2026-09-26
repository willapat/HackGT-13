from datetime import datetime, timedelta, timezone

import pytest
from pydantic import ValidationError

from backend.house import BUBBLE_MAX, active, clean_text, entry
from backend.models.api import BubbleIn, MailIn, MoodIn

NOW = datetime(2026, 9, 26, 12, tzinfo=timezone.utc)


def test_bubbles_and_moods_run_out():
    b = entry("text", "👋", 6, NOW)
    assert b["text"] == "👋" and active(b, NOW + timedelta(hours=5)) == b
    assert active(b, NOW + timedelta(hours=6, seconds=1)) is None
    assert active(None, NOW) is None and active({"text": "x"}, NOW) is None and active({"until": "junk"}, NOW) is None


def test_bubble_text_is_one_trimmed_line():
    assert clean_text("  hi\n\nthere   you ") == "hi there you"
    assert BubbleIn(text=" 🎉 ").text == "🎉"
    with pytest.raises(ValidationError):
        BubbleIn(text=" \n ")
    with pytest.raises(ValidationError):
        BubbleIn(text="x" * (BUBBLE_MAX + 1))


def test_moods_come_from_the_fixed_list():
    assert MoodIn(mood="cozy").mood == "cozy"
    with pytest.raises(ValidationError):
        MoodIn(mood="furious")


def test_mail_needs_words():
    assert MailIn(to_user_id="00000000-0000-0000-0000-000000000001", text=" hey! ").text == "hey!"
    with pytest.raises(ValidationError):
        MailIn(to_user_id="00000000-0000-0000-0000-000000000001", text="   ")

import pytest
from fastapi import HTTPException

from backend.identity import TOO_CLOSE, check_identity, color_distance, member_name, norm_name, suggest_color

SAM = {"user_id": "s", "name": "Sam", "color": "#ff3b30"}


def test_names_match_ignoring_case_and_spacing():
    assert norm_name("  sam   Lee ") == norm_name("Sam Lee")


def test_same_name_in_the_town_is_refused():
    with pytest.raises(HTTPException) as e:
        check_identity([SAM], name=" SAM ")
    assert e.value.status_code == 409 and "Sam" in e.value.detail


def test_near_identical_color_is_refused_but_distinct_one_is_fine():
    with pytest.raises(HTTPException):
        check_identity([SAM], color="#fe3c32")
    check_identity([SAM], name="Priya", color="#a24bff")


def test_people_without_a_color_never_clash():
    check_identity([{**SAM, "color": None}], color="#ff3b30")


def test_distance_is_symmetric_and_zero_for_equal():
    assert color_distance("#123456", "#123456") == 0
    assert color_distance("#ff0000", "#00ff00") == color_distance("#00ff00", "#ff0000")


def test_suggestion_is_free():
    taken = ["#ff3b30", "#a24bff", "#ffd60a"]
    got = suggest_color(taken)
    assert all(color_distance(got, t) >= TOO_CLOSE for t in taken)


def test_member_name_falls_back_to_profile():
    assert member_name({"name": None, "profiles": {"display_name": " Ana "}}) == "Ana"
    assert member_name({"name": "Ana B", "profiles": {"display_name": "Ana"}}) == "Ana B"

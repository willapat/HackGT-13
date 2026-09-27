import pytest

from backend.models.api import ProfileUpdate
from backend.socials import clean_facebook, clean_instagram, social_links


@pytest.mark.parametrize("typed", ["maya.chen", "@maya.chen", "  @Maya.Chen ", "instagram.com/maya.chen",
                                   "https://www.instagram.com/maya.chen/", "https://instagram.com/maya.chen?igsh=abc"])
def test_instagram_is_reduced_to_the_username(typed):
    assert clean_instagram(typed) == "maya.chen"


@pytest.mark.parametrize("typed, stored", [("maya.chen", "maya.chen"), ("@maya.chen", "maya.chen"),
                                           ("https://www.facebook.com/maya.chen", "maya.chen"),
                                           ("facebook.com/profile.php?id=1000123", "1000123")])
def test_facebook_is_reduced_to_the_username_or_id(typed, stored):
    assert clean_facebook(typed) == stored


def test_blank_removes_and_bad_input_is_rejected():
    assert clean_instagram("") is None and clean_facebook("  ") is None
    assert ProfileUpdate(instagram="").instagram == ""  # the route turns "" into NULL
    with pytest.raises(ValueError):
        ProfileUpdate(instagram="not a username!")
    with pytest.raises(ValueError):
        ProfileUpdate(facebook="has spaces in it")


def test_links():
    assert social_links({"instagram": "maya.chen", "facebook": "maya.chen"}) == {
        "instagram": "https://www.instagram.com/maya.chen/", "facebook": "https://www.facebook.com/maya.chen"}
    assert social_links({"facebook": "1000123"}) == {"facebook": "https://www.facebook.com/profile.php?id=1000123"}
    assert social_links({"bio": "hi"}) == {}

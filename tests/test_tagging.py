"""Tests for the type and kid-friendly tagging (run: python -m unittest)."""
import unittest

from eventfinder import places, tagging


class EventTypeTests(unittest.TestCase):
    def check(self, expected, title, description="", ld_types=(), source=""):
        self.assertEqual(tagging.event_type(title, description, ld_types, source), expected)

    def test_keyword_in_title(self):
        self.check("music", "Jazz Brunch")
        self.check("comedy", "Stand-up Comedy Night")
        self.check("film", "Open-Air Cinema: Classics")

    def test_earliest_keyword_wins(self):
        self.check("festival", "Christmas market with live music")
        self.check("music", "Live music at the Christmas market")

    def test_schema_org_type_wins(self):
        self.check("theatre", "An evening with friends", ld_types=["TheaterEvent"])
        self.check("sport", "Saturday", ld_types=["https://schema.org/SportsEvent"])

    def test_feed_then_description(self):
        self.check("comedy", "Mike Smith live", source="AllEvents (Köln/comedy)")
        self.check("art", "Opening night", "A new exhibition of local painters")

    def test_meetup_defaults_to_community(self):
        self.check("community", "Thursday get-together", source="Meetup")

    def test_unknown(self):
        self.check("unknown", "Something happening")

    def test_word_boundaries(self):
        self.check("unknown", "Start of the season")  # "art" inside "start"


class KidFriendlyTests(unittest.TestCase):
    def test_aimed_at_kids(self):
        self.assertEqual(tagging.auto_tags("Puppet Show for Little Ones"), ["kids"])
        self.assertEqual(tagging.auto_tags("Storytime", "for toddlers"), ["kids"])
        self.assertEqual(tagging.auto_tags("Saturday fun", ld_types=["ChildrensEvent"]), ["kids"])

    def test_not_aimed_at_kids(self):
        self.assertEqual(tagging.auto_tags("Wine Tasting"), [])
        self.assertEqual(tagging.auto_tags("Sunday walk in the park"), [])


class PlaceTypeTests(unittest.TestCase):
    def test_parks_are_not_kid_friendly_but_playgrounds_are(self):
        self.assertEqual(places._category_of({"leisure": "park"}), ("Park", "park", False))
        self.assertEqual(places._category_of({"leisure": "playground"}), ("Playground", "play", True))

    def test_pools(self):
        self.assertEqual(places._category_of({"leisure": "sports_centre", "sport": "swimming"})[1], "water")
        self.assertEqual(places._category_of({"leisure": "water_park"}), ("Water park", "water", True))

    def test_every_category_has_a_known_type(self):
        for label, type_, _kids in places.CATEGORIES.values():
            self.assertIn(type_, tagging.TYPE_KEYS, label)


if __name__ == "__main__":
    unittest.main()

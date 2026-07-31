"""Recognizer coverage, including the OCR shapes that used to defeat it.

Needs presidio + the spaCy model, so it runs in the container rather than on a
bare checkout:

    docker compose exec image-pii-worker python -m unittest discover -s tests
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

try:
    from main import analyze_line, get_analyzer
except ImportError as exc:  # pragma: no cover - bare checkout without presidio
    raise unittest.SkipTest(f"analyzer dependencies unavailable: {exc}") from exc


class RecognizerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.analyzer = get_analyzer()

    def types(self, text):
        return {entity_type for entity_type, _ in analyze_line(self.analyzer, text)}

    def assertDetects(self, text, entity):
        found = self.types(text)
        self.assertIn(entity, found, f"{text!r} -> {sorted(found)}")

    # The label-glued forms are what RapidOCR actually emits for a printed card:
    # the gap between label and value is narrower than the space the recognizer
    # emits, so the two arrive as one token. Every one of these was missed while
    # the patterns were anchored on \b.
    def test_label_glued_identifiers(self):
        self.assertDetects("PANABCDE1234F", "IN_PAN")
        self.assertDetects("IFSCHDFC0001234", "IFSC_CODE")
        self.assertDetects("VehicleTN09AB1234", "IN_VEHICLE_REGISTRATION")
        self.assertDetects("DLTN1420110001234", "IN_DRIVING_LICENCE")
        self.assertDetects("Aadhaar234567890123", "IN_AADHAAR")
        self.assertDetects("Mobile+919876543210", "PHONE_NUMBER")
        self.assertDetects("EPICABC1234567", "IN_VOTER")

    def test_spaced_identifiers(self):
        self.assertDetects("Aadhaar 2345 6789 0123", "IN_AADHAAR")
        self.assertDetects("PAN ABCDE1234F", "IN_PAN")
        self.assertDetects("Vehicle TN 09 AB 1234", "IN_VEHICLE_REGISTRATION")
        self.assertDetects("IFSC HDFC0001234", "IFSC_CODE")

    def test_contact_and_financial_builtins(self):
        self.assertDetects("Email ramesh.kumar@example.com", "EMAIL_ADDRESS")
        self.assertDetects("UPI ramesh@okaxis", "UPI_ID")
        self.assertDetects("Card 4111 1111 1111 1111", "CREDIT_CARD")

    def test_name_behind_a_printed_label(self):
        # spaCy's small model returns nothing for a bare name on a card — the
        # label is the context it is missing.
        self.assertDetects("Name: Ramesh Kumar", "PERSON")
        self.assertDetects("S/O Suresh Kumar", "PERSON")

    def test_name_in_a_sentence_still_comes_from_ner(self):
        self.assertDetects("Priya Sharma lives in Chennai", "PERSON")

    def test_dates_are_caught(self):
        self.assertDetects("DOB 12/05/1998", "DATE_TIME")

    def test_pin_code_needs_address_context(self):
        # A bare six-digit run is a price, a serial or a time far more often
        # than it is an address, so it scores below threshold on its own.
        self.assertNotIn("IN_PIN_CODE", self.types("Total 600042"))
        self.assertDetects("Address: Chennai PIN 600042", "IN_PIN_CODE")

    def test_ordinary_text_is_not_flagged_as_an_identifier(self):
        identifiers = {
            "IN_PAN",
            "IN_AADHAAR",
            "IFSC_CODE",
            "IN_VEHICLE_REGISTRATION",
            "IN_DRIVING_LICENCE",
            "IN_VOTER",
        }
        self.assertFalse(identifiers & self.types("GOVERNMENT OF INDIA"))
        self.assertFalse(identifiers & self.types("Annual Sports Day 2026"))

    def test_digit_prefixed_slice_is_not_an_identifier(self):
        # A run of digits before the candidate means it is a slice out of a
        # longer number, not an ID — that anchor has to stay strict.
        self.assertNotIn("IN_PASSPORT", self.types("99999999A1234567"))


if __name__ == "__main__":
    unittest.main()

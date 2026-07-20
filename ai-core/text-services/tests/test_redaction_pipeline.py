import os
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from presidio_analyzer import RecognizerResult

import app


class EnvironmentConfigTests(unittest.TestCase):
    def test_load_local_environment_reads_unset_values(self):
        with TemporaryDirectory() as temp_dir:
            env_path = Path(temp_dir) / ".env"
            env_path.write_text(
                "\n".join(
                    [
                        "# Local PRISM settings",
                        'OPENAI_API_KEY="sk-test-key"',
                        "PRISM_LLM_MODEL=gpt-test-model",
                        "export EXTRA_FLAG=enabled",
                    ]
                ),
                encoding="utf-8",
            )

            with patch.dict(os.environ, {}, clear=True):
                app.load_local_environment(env_path)

                self.assertEqual(os.getenv("OPENAI_API_KEY"), "sk-test-key")
                self.assertEqual(os.getenv("PRISM_LLM_MODEL"), "gpt-test-model")
                self.assertEqual(os.getenv("EXTRA_FLAG"), "enabled")

    def test_load_local_environment_preserves_existing_environment(self):
        with TemporaryDirectory() as temp_dir:
            env_path = Path(temp_dir) / ".env"
            env_path.write_text("OPENAI_API_KEY=sk-file-key", encoding="utf-8")

            with patch.dict(os.environ, {"OPENAI_API_KEY": "sk-shell-key"}, clear=True):
                app.load_local_environment(env_path)

                self.assertEqual(os.getenv("OPENAI_API_KEY"), "sk-shell-key")

    def test_openai_api_key_configured_rejects_missing_or_blank_values(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertFalse(app.openai_api_key_configured())

        with patch.dict(os.environ, {"OPENAI_API_KEY": "   "}, clear=True):
            self.assertFalse(app.openai_api_key_configured())

        with patch.dict(os.environ, {"OPENAI_API_KEY": "sk-test-key"}, clear=True):
            self.assertTrue(app.openai_api_key_configured())

    def test_openai_client_uses_trimmed_environment_key(self):
        class FakeOpenAI:
            def __init__(self, api_key):
                self.api_key = api_key

        with (
            patch.object(app, "OpenAI", FakeOpenAI),
            patch.dict(os.environ, {"OPENAI_API_KEY": " sk-test-key "}, clear=True),
        ):
            client = app.openai_client_from_environment()

        self.assertEqual(client.api_key, "sk-test-key")


class SentenceAndVehicleTests(unittest.TestCase):
    def test_sentence_spans_preserve_offsets(self):
        text = "First sentence. Second sentence with mohana."
        spans = app.sentence_spans(text)

        self.assertEqual(len(spans), 2)
        self.assertEqual(text[spans[1].start : spans[1].end], "Second sentence with mohana.")

    def test_date_like_vehicle_candidate_is_rejected(self):
        text = "DOB OD 12 MAY 2024 was captured from the form."
        start = text.index("OD")
        end = start + len("OD 12 MAY 2024")
        sentence = app.SentenceSpan(0, len(text), text)
        result = RecognizerResult(
            entity_type="IN_VEHICLE_REGISTRATION",
            start=start,
            end=end,
            score=0.72,
        )

        self.assertFalse(app.should_keep_result(text, sentence, result))

    def test_valid_vehicle_registration_is_kept(self):
        text = "The vehicle TN 09 AB 1234 entered the campus."
        start = text.index("TN")
        end = start + len("TN 09 AB 1234")
        sentence = app.SentenceSpan(0, len(text), text)
        result = RecognizerResult(
            entity_type="IN_VEHICLE_REGISTRATION",
            start=start,
            end=end,
            score=0.72,
        )

        self.assertTrue(app.should_keep_result(text, sentence, result))

    def test_score_like_phone_candidate_is_rejected(self):
        text = "Manan scored 9876543210 points in practice."
        start = text.index("9876543210")
        sentence = app.SentenceSpan(0, len(text), text)
        result = RecognizerResult(
            entity_type="PHONE_NUMBER",
            start=start,
            end=start + len("9876543210"),
            score=0.8,
        )

        self.assertFalse(app.should_keep_result(text, sentence, result))

    def test_full_text_date_candidates_are_validated(self):
        self.assertTrue(app.is_valid_date_candidate("12 MAY 2024"))
        self.assertTrue(app.is_valid_date_candidate("May 12, 2024"))
        self.assertTrue(app.is_valid_date_candidate("2024-05-12"))
        self.assertTrue(app.is_valid_date_candidate("12/05/2024"))
        self.assertFalse(app.is_valid_date_candidate("32 MAY 2024"))
        self.assertFalse(app.is_valid_date_candidate("2024-99-12"))


class NameRecognitionTests(unittest.TestCase):
    def test_labelled_lowercase_name_is_detected(self):
        recognizer = app.MultiWordNameRecognizer()
        text = "Name: mohana submitted the consent form."

        results = recognizer.analyze(text, ["PERSON"])
        detected_values = {text[result.start : result.end].lower() for result in results}

        self.assertIn("mohana", detected_values)

    def test_contextual_lowercase_name_is_detected(self):
        recognizer = app.MultiWordNameRecognizer()
        text = "The student mohana submitted the consent form."

        results = recognizer.analyze(text, ["PERSON"])
        detected_values = {text[result.start : result.end].lower() for result in results}

        self.assertIn("mohana", detected_values)

    def test_llm_person_candidate_rejects_dates(self):
        sentence = "The report was submitted in May."
        start = sentence.index("May")
        end = start + len("May")

        self.assertFalse(app.is_valid_llm_person_candidate("May", sentence, start, end, 0.95))

    def test_llm_person_candidate_accepts_human_context(self):
        sentence = "mohana arrived late for verification."
        start = sentence.index("mohana")
        end = start + len("mohana")

        self.assertTrue(app.is_valid_llm_person_candidate("mohana", sentence, start, end, 0.9))

    def test_person_result_is_removed_from_general_sentence(self):
        text = "I am Manan, I have an exam tomorrow."
        sentence = app.SentenceSpan(0, len(text), text)
        person = RecognizerResult(
            entity_type="PERSON",
            start=text.index("Manan"),
            end=text.index("Manan") + len("Manan"),
            score=0.78,
        )

        results = app.filter_person_results_by_sensitive_context(text, [sentence], [person])

        self.assertEqual(results, [])

    def test_person_result_is_kept_with_same_sentence_personal_info(self):
        text = "My name is Manan, and my phone number is 9876543210."
        sentence = app.SentenceSpan(0, len(text), text)
        person = RecognizerResult(
            entity_type="PERSON",
            start=text.index("Manan"),
            end=text.index("Manan") + len("Manan"),
            score=0.78,
        )
        phone = RecognizerResult(
            entity_type="PHONE_NUMBER",
            start=text.index("9876543210"),
            end=text.index("9876543210") + len("9876543210"),
            score=0.8,
        )

        results = app.filter_person_results_by_sensitive_context(text, [sentence], [person, phone])
        detected_values = {text[result.start : result.end] for result in results}

        self.assertEqual(detected_values, {"Manan", "9876543210"})

    def test_person_result_does_not_cross_sentence_boundary(self):
        text = "I am Manan, I have an exam tomorrow. My phone number is 9876543210."
        sentences = app.sentence_spans(text)
        person = RecognizerResult(
            entity_type="PERSON",
            start=text.index("Manan"),
            end=text.index("Manan") + len("Manan"),
            score=0.78,
        )
        phone = RecognizerResult(
            entity_type="PHONE_NUMBER",
            start=text.index("9876543210"),
            end=text.index("9876543210") + len("9876543210"),
            score=0.8,
        )

        results = app.filter_person_results_by_sensitive_context(text, sentences, [person, phone])
        detected_values = {text[result.start : result.end] for result in results}

        self.assertEqual(detected_values, {"9876543210"})

    def test_score_like_phone_result_does_not_trigger_name_redaction(self):
        text = "Manan scored 9876543210 points in practice."
        sentence = app.SentenceSpan(0, len(text), text)
        person = RecognizerResult(
            entity_type="PERSON",
            start=text.index("Manan"),
            end=text.index("Manan") + len("Manan"),
            score=0.78,
        )
        phone = RecognizerResult(
            entity_type="PHONE_NUMBER",
            start=text.index("9876543210"),
            end=text.index("9876543210") + len("9876543210"),
            score=0.8,
        )

        results = app.filter_person_results_by_sensitive_context(text, [sentence], [person, phone])
        detected_values = {text[result.start : result.end] for result in results}

        self.assertEqual(detected_values, {"9876543210"})


class FakeResponse:
    output_text = (
        '{"person_names": ['
        '{"text": "mohana", "confidence": 0.91, "evidence": "same sentence personal info"},'
        '{"text": "May", "confidence": 0.99, "evidence": "month, not person"},'
        '{"text": "missing", "confidence": 0.99, "evidence": "not present"}'
        "]}"
    )


class FakeResponsesClient:
    def create(self, **kwargs):
        self.last_kwargs = kwargs
        self.call_count = getattr(self, "call_count", 0) + 1
        return FakeResponse()


class FakeOpenAIClient:
    def __init__(self):
        self.responses = FakeResponsesClient()


class LlmFallbackTests(unittest.TestCase):
    def test_llm_fallback_adds_only_valid_exact_person_spans(self):
        text = "mohana's phone number is 9876543210 in May."
        sentence = app.SentenceSpan(0, len(text), text)
        fake_client = FakeOpenAIClient()
        phone = RecognizerResult(
            entity_type="PHONE_NUMBER",
            start=text.index("9876543210"),
            end=text.index("9876543210") + len("9876543210"),
            score=0.8,
        )

        with patch.object(app, "openai_client_from_environment", return_value=fake_client):
            results = app.llm_person_results(
                text=text,
                sentences=[sentence],
                existing_results=[phone],
                llm_config=app.LlmRedactionConfig(enabled=True, model="gpt-5.4-nano"),
            )

        self.assertEqual(len(results), 1)
        self.assertEqual(results[0].entity_type, "PERSON")
        self.assertEqual(text[results[0].start : results[0].end], "mohana")
        self.assertEqual(fake_client.responses.last_kwargs["model"], "gpt-5.4-nano")
        self.assertEqual(fake_client.responses.last_kwargs["temperature"], 0)
        self.assertFalse(fake_client.responses.last_kwargs["store"])

    def test_llm_fallback_skips_general_sentences_without_personal_info(self):
        text = "mohana arrived late in May."
        sentence = app.SentenceSpan(0, len(text), text)
        fake_client = FakeOpenAIClient()

        with patch.object(app, "openai_client_from_environment", return_value=fake_client):
            results = app.llm_person_results(
                text=text,
                sentences=[sentence],
                existing_results=[],
                llm_config=app.LlmRedactionConfig(enabled=True, model="gpt-5.4-nano"),
            )

        self.assertEqual(results, [])
        self.assertFalse(hasattr(fake_client.responses, "last_kwargs"))


if __name__ == "__main__":
    unittest.main()



import hashlib
import json
import os
import re
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

import pandas as pd
import streamlit as st
from presidio_analyzer import AnalyzerEngine, EntityRecognizer, Pattern, PatternRecognizer, RecognizerResult
from presidio_analyzer.nlp_engine import NlpEngineProvider
from presidio_anonymizer import AnonymizerEngine
from presidio_anonymizer.entities import OperatorConfig

try:
    from openai import OpenAI
except ImportError:  # Optional dependency for the guarded fallback path.
    OpenAI = None


APP_DIR = Path(__file__).resolve().parent


def unquote_env_value(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {'"', "'"}:
        return value[1:-1]
    return value


def load_local_environment(env_path: str | os.PathLike[str] = APP_DIR / ".env") -> None:
    path = Path(env_path)
    if not path.exists():
        return

    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        if line.startswith("export "):
            line = line[len("export ") :].strip()

        key, value = line.split("=", 1)
        key = key.strip()
        if key and key not in os.environ:
            os.environ[key] = unquote_env_value(value)


load_local_environment()

HASH_SALT = "prism-demo-salt-change-in-production"
DEFAULT_LLM_MODEL = os.getenv("PRISM_LLM_MODEL", "gpt-5.4-nano")
MAX_LLM_SENTENCES = 24
MAX_LLM_SENTENCE_CHARS = 1400


INDIAN_VEHICLE_STATE_CODES = {
    "AN",
    "AP",
    "AR",
    "AS",
    "BR",
    "CG",
    "CH",
    "DD",
    "DL",
    "DN",
    "GA",
    "GJ",
    "HP",
    "HR",
    "JH",
    "JK",
    "KA",
    "KL",
    "LA",
    "LD",
    "MH",
    "ML",
    "MN",
    "MP",
    "MZ",
    "NL",
    "OD",
    "OR",
    "PB",
    "PY",
    "RJ",
    "SK",
    "TN",
    "TR",
    "TS",
    "UK",
    "UP",
    "WB",
}

MONTH_WORDS = {
    "jan",
    "january",
    "feb",
    "february",
    "mar",
    "march",
    "apr",
    "april",
    "may",
    "jun",
    "june",
    "jul",
    "july",
    "aug",
    "august",
    "sep",
    "sept",
    "september",
    "oct",
    "october",
    "nov",
    "november",
    "dec",
    "december",
}
MONTH_REGEX = "|".join(sorted((re.escape(month) for month in MONTH_WORDS), key=len, reverse=True))
MONTH_NUMBER_BY_NAME = {
    "jan": 1,
    "january": 1,
    "feb": 2,
    "february": 2,
    "mar": 3,
    "march": 3,
    "apr": 4,
    "april": 4,
    "may": 5,
    "jun": 6,
    "june": 6,
    "jul": 7,
    "july": 7,
    "aug": 8,
    "august": 8,
    "sep": 9,
    "sept": 9,
    "september": 9,
    "oct": 10,
    "october": 10,
    "nov": 11,
    "november": 11,
    "dec": 12,
    "december": 12,
}

DATE_CONTEXT_TERMS = {
    "date",
    "dob",
    "birth",
    "born",
    "expiry",
    "expired",
    "expires",
    "issued",
    "valid",
    "visited on",
    "created on",
    "updated on",
    "submitted on",
}

VEHICLE_CONTEXT_TERMS = {
    "vehicle",
    "registration",
    "reg no",
    "reg number",
    "license plate",
    "licence plate",
    "number plate",
    "plate",
    "car",
    "bike",
    "scooter",
    "truck",
    "van",
    "rto",
}

NAME_CONTEXT_TERMS = {
    "name",
    "subject",
    "student",
    "participant",
    "employee",
    "visitor",
    "patient",
    "customer",
    "applicant",
    "candidate",
    "guardian",
    "father",
    "mother",
    "teacher",
    "doctor",
    "person",
    "called",
    "named",
}

COMMON_PERSON_NAMES = {
    "aarav",
    "aarya",
    "aditi",
    "aditya",
    "akash",
    "akshay",
    "aman",
    "ananya",
    "anjali",
    "ankit",
    "anmol",
    "arjun",
    "aryan",
    "ayesha",
    "deepak",
    "diya",
    "gaurav",
    "gracy",
    "isha",
    "kavya",
    "kiran",
    "krishna",
    "manan",
    "meera",
    "mohana",
    "mohan",
    "neha",
    "nikhil",
    "pooja",
    "priya",
    "rahul",
    "ravi",
    "reena",
    "riya",
    "rohan",
    "sanjay",
    "sara",
    "shreya",
    "sneha",
    "suresh",
    "tanvi",
    "varun",
    "vijay",
    "vikram",
}

NON_PERSON_TOKENS = {
    "aadhaar",
    "account",
    "api",
    "bank",
    "campus",
    "consent",
    "date",
    "email",
    "employee",
    "gst",
    "ifsc",
    "license",
    "licence",
    "location",
    "number",
    "pan",
    "passport",
    "phone",
    "plate",
    "project",
    "qr",
    "registration",
    "roll",
    "secret",
    "student",
    "token",
    "upi",
    "vehicle",
    "voter",
}

NAME_TRAILING_STOP_WORDS = {
    "and",
    "arrived",
    "called",
    "came",
    "emailed",
    "entered",
    "from",
    "has",
    "is",
    "left",
    "met",
    "paid",
    "reported",
    "said",
    "submitted",
    "visited",
    "walked",
    "was",
    "with",
}

HUMAN_ACTION_TERMS = {
    "arrived",
    "asked",
    "called",
    "came",
    "contacted",
    "emailed",
    "entered",
    "joined",
    "left",
    "met",
    "paid",
    "reported",
    "said",
    "signed",
    "spoke",
    "submitted",
    "visited",
    "walked",
}

NAME_LINKING_PERSONAL_INFO_ENTITIES = {
    "PHONE_NUMBER",
    "EMAIL_ADDRESS",
    "IN_AADHAAR",
    "IN_PAN",
    "IN_VOTER",
    "IN_PASSPORT",
    "IN_GSTIN",
    "IN_VEHICLE_REGISTRATION",
    "UPI_ID",
    "IFSC_CODE",
    "BANK_ACCOUNT",
    "CAMPUS_ID",
    "QR_TOKEN",
    "SECRET",
    "CREDIT_CARD",
    "CRYPTO",
    "IP_ADDRESS",
    "MAC_ADDRESS",
    "IBAN_CODE",
    "NRP",
    "MEDICAL_LICENSE",
}

PERSONAL_DATE_CONTEXT_TERMS = {
    "birth date",
    "date of birth",
    "dob",
    "born",
    "birthday",
}

PERSONAL_LOCATION_CONTEXT_TERMS = {
    "address",
    "flat",
    "home",
    "house",
    "lives at",
    "lives in",
    "lives near",
    "pin code",
    "pincode",
    "residence",
    "residential",
    "stays at",
    "stays in",
    "street",
}

PHONE_DISCLOSURE_CONTEXT_TERMS = {
    "call",
    "cell",
    "contact",
    "mobile",
    "number",
    "phone",
    "sms",
    "telephone",
    "whatsapp",
}

PHONE_FALSE_POSITIVE_CONTEXT_TERMS = {
    "exam",
    "grade",
    "marks",
    "match",
    "points",
    "rank",
    "rating",
    "result",
    "runs",
    "score",
    "scored",
    "test",
    "total",
}

NAME_TOKEN_REGEX = r"[A-Za-z][A-Za-z.'-]{1,}"
NAME_TOKEN_RE = re.compile(rf"^{NAME_TOKEN_REGEX}$")
VEHICLE_CANONICAL_RE = re.compile(
    r"^(?P<state>[A-Z]{2})(?P<district>[0-9]{1,2})(?P<series>[A-Z]{1,3})(?P<number>[0-9]{1,4})$"
)
NUMERIC_DATE_RE = re.compile(
    r"\b(?:\d{1,2}[-/]\d{1,2}[-/](?:\d{2}|\d{4})|(?:19|20)\d{2}[-/]\d{1,2}[-/]\d{1,2})\b"
)


@dataclass(frozen=True)
class TextPolicy:
    name: str
    description: str
    operators: dict[str, OperatorConfig]
    post_scan_entities: list[str]


@dataclass(frozen=True)
class SentenceSpan:
    start: int
    end: int
    text: str


@dataclass(frozen=True)
class LlmRedactionConfig:
    enabled: bool = False
    model: str = DEFAULT_LLM_MODEL
    max_sentences: int = MAX_LLM_SENTENCES


@dataclass(frozen=True)
class AnalysisOutcome:
    results: list[RecognizerResult]
    sentence_count: int
    llm_enabled: bool
    llm_added_count: int = 0
    llm_error: str | None = None


def normalize_digits(value: str) -> str:
    return re.sub(r"\D", "", value)


def mask_keep_last(value: str, keep: int = 4, masking_char: str = "*") -> str:
    visible_seen = 0
    output = []

    for character in reversed(value):
        if character.isalnum() and visible_seen < keep:
            output.append(character)
            visible_seen += 1
        elif character.isalnum():
            output.append(masking_char)
        else:
            output.append(character)

    return "".join(reversed(output))


def hash_token(entity_type: str, value: str) -> str:
    digest = hashlib.sha256(f"{HASH_SALT}:{entity_type}:{value}".encode("utf-8")).hexdigest()
    return f"<{entity_type}_HASH:{digest[:12]}>"


def typed_token(entity_type: str) -> str:
    return f"<REDACTED_{entity_type}>"


def redact_to_token(value: str, entity_type: str) -> str:
    return typed_token(entity_type)


def pseudonymize_to_hash(value: str, entity_type: str) -> str:
    return hash_token(entity_type, value)


def mask_phone(value: str, entity_type: str) -> str:
    return mask_keep_last(value, keep=4)


def mask_government_id(value: str, entity_type: str) -> str:
    return mask_keep_last(value, keep=4)


def mask_email(value: str, entity_type: str) -> str:
    if "@" not in value:
        return typed_token(entity_type)

    local_part, domain = value.split("@", 1)
    if not local_part:
        return f"<REDACTED_EMAIL>@{domain}"

    return f"{local_part[0]}***@{domain}"


def bucket_date(value: str, entity_type: str) -> str:
    year_match = re.search(r"\b(?:19|20)\d{2}\b", value)
    if year_match:
        return f"<DATE_YEAR:{year_match.group(0)}>"
    return "<REDACTED_DATE_TIME>"


def compact_location(value: str, entity_type: str) -> str:
    return "<REDACTED_LOCATION>"


def sentence_spans(text: str) -> list[SentenceSpan]:
    spans = []
    start = 0

    for boundary in re.finditer(r"(?<=[.!?])\s+|\n+", text):
        end = boundary.start()
        trimmed = trim_span(text, start, end)
        if trimmed:
            spans.append(SentenceSpan(trimmed[0], trimmed[1], text[trimmed[0] : trimmed[1]]))
        start = boundary.end()

    trimmed = trim_span(text, start, len(text))
    if trimmed:
        spans.append(SentenceSpan(trimmed[0], trimmed[1], text[trimmed[0] : trimmed[1]]))

    return spans


def trim_span(text: str, start: int, end: int) -> tuple[int, int] | None:
    while start < end and text[start].isspace():
        start += 1
    while end > start and text[end - 1].isspace():
        end -= 1
    if start >= end:
        return None
    return start, end


def context_window(text: str, start: int, end: int, radius: int = 48) -> str:
    return text[max(0, start - radius) : min(len(text), end + radius)].lower()


def has_context_term(text: str, terms: set[str]) -> bool:
    normalized = text.lower()
    return any(term in normalized for term in terms)


def clone_result_with_offset(result: RecognizerResult, offset: int) -> RecognizerResult:
    return RecognizerResult(
        entity_type=result.entity_type,
        start=result.start + offset,
        end=result.end + offset,
        score=result.score,
        analysis_explanation=getattr(result, "analysis_explanation", None),
        recognition_metadata=getattr(result, "recognition_metadata", None),
    )


def parse_vehicle_registration(value: str) -> re.Match[str] | None:
    compact_value = re.sub(r"[-\s]", "", value).upper()
    return VEHICLE_CANONICAL_RE.match(compact_value)


def is_valid_vehicle_registration(value: str) -> bool:
    match = parse_vehicle_registration(value)
    if not match:
        return False

    state = match.group("state")
    district = int(match.group("district"))
    series = match.group("series").lower()
    number = int(match.group("number"))

    if state not in INDIAN_VEHICLE_STATE_CODES:
        return False
    if district < 1 or district > 99 or number < 1:
        return False
    if series in MONTH_WORDS:
        return False
    return True


def looks_like_date_text(value: str) -> bool:
    normalized = value.lower()
    if NUMERIC_DATE_RE.search(value):
        return True
    return any(re.search(rf"\b{re.escape(month)}\b", normalized) for month in MONTH_WORDS)


def is_valid_calendar_date(year: int, month: int, day: int) -> bool:
    if year < 1900 or year > 2099:
        return False
    try:
        datetime(year, month, day)
    except ValueError:
        return False
    return True


def normalize_two_digit_year(year: str) -> int:
    parsed = int(year)
    if len(year) == 2:
        return 2000 + parsed if parsed < 50 else 1900 + parsed
    return parsed


def is_valid_date_candidate(value: str) -> bool:
    normalized = re.sub(r"\b(\d{1,2})(?:st|nd|rd|th)\b", r"\1", value.lower())

    iso_match = re.fullmatch(r"\s*((?:19|20)\d{2})[-/](\d{1,2})[-/](\d{1,2})\s*", normalized)
    if iso_match:
        return is_valid_calendar_date(int(iso_match.group(1)), int(iso_match.group(2)), int(iso_match.group(3)))

    numeric_match = re.fullmatch(r"\s*(\d{1,2})[-/](\d{1,2})[-/](\d{2}|\d{4})\s*", normalized)
    if numeric_match:
        first = int(numeric_match.group(1))
        second = int(numeric_match.group(2))
        year = normalize_two_digit_year(numeric_match.group(3))
        return is_valid_calendar_date(year, second, first) or is_valid_calendar_date(year, first, second)

    month_match = re.search(rf"\b({MONTH_REGEX})\b", normalized)
    year_match = re.search(r"\b((?:19|20)\d{2})\b", normalized)
    day_match = re.search(r"\b(\d{1,2})\b", normalized)
    if month_match and year_match and day_match:
        month = MONTH_NUMBER_BY_NAME[month_match.group(1)]
        return is_valid_calendar_date(int(year_match.group(1)), month, int(day_match.group(1)))

    return False


def should_keep_vehicle_result(text: str, sentence: SentenceSpan, result: RecognizerResult) -> bool:
    value = text[result.start : result.end]
    if not is_valid_vehicle_registration(value):
        return False

    local_context = context_window(text, result.start, result.end)
    if looks_like_date_text(value):
        return False
    if has_context_term(local_context, DATE_CONTEXT_TERMS) and not has_context_term(local_context, VEHICLE_CONTEXT_TERMS):
        return False
    if has_context_term(sentence.text, DATE_CONTEXT_TERMS) and looks_like_date_text(sentence.text):
        return has_context_term(local_context, VEHICLE_CONTEXT_TERMS)

    return True


def should_keep_result(text: str, sentence: SentenceSpan, result: RecognizerResult) -> bool:
    if result.entity_type == "IN_VEHICLE_REGISTRATION":
        return should_keep_vehicle_result(text, sentence, result)
    if result.entity_type == "PHONE_NUMBER":
        return phone_result_looks_like_personal_info(text, result)
    return True


def sentence_contains_result(sentence: SentenceSpan, result: RecognizerResult) -> bool:
    return sentence.start <= result.start < result.end <= sentence.end


def phone_result_looks_like_personal_info(text: str, result: RecognizerResult) -> bool:
    local_context = context_window(text, result.start, result.end, radius=56)
    if has_context_term(local_context, PHONE_FALSE_POSITIVE_CONTEXT_TERMS) and not has_context_term(
        local_context, PHONE_DISCLOSURE_CONTEXT_TERMS
    ):
        return False
    return True


def result_links_name_to_personal_info(text: str, result: RecognizerResult) -> bool:
    if result.entity_type == "PERSON":
        return False
    if result.entity_type == "PHONE_NUMBER":
        return phone_result_looks_like_personal_info(text, result)
    if result.entity_type == "DATE_TIME":
        return has_context_term(context_window(text, result.start, result.end), PERSONAL_DATE_CONTEXT_TERMS)
    if result.entity_type == "LOCATION":
        return has_context_term(context_window(text, result.start, result.end), PERSONAL_LOCATION_CONTEXT_TERMS)
    return result.entity_type in NAME_LINKING_PERSONAL_INFO_ENTITIES


def sentence_has_name_linking_personal_info(
    text: str,
    sentence: SentenceSpan,
    results: list[RecognizerResult],
) -> bool:
    return any(
        sentence_contains_result(sentence, result) and result_links_name_to_personal_info(text, result)
        for result in results
    )


def filter_person_results_by_sensitive_context(
    text: str,
    sentences: list[SentenceSpan],
    results: list[RecognizerResult],
) -> list[RecognizerResult]:
    sensitive_sentence_ranges = {
        (sentence.start, sentence.end)
        for sentence in sentences
        if sentence_has_name_linking_personal_info(text, sentence, results)
    }

    filtered_results = []
    for result in results:
        if result.entity_type != "PERSON":
            filtered_results.append(result)
            continue

        if any(
            sentence_contains_result(sentence, result) and (sentence.start, sentence.end) in sensitive_sentence_ranges
            for sentence in sentences
        ):
            filtered_results.append(result)

    return filtered_results


def clean_name_candidate(candidate: str) -> str | None:
    raw_tokens = re.findall(NAME_TOKEN_REGEX, candidate)
    cleaned_tokens = []

    for raw_token in raw_tokens[:4]:
        token = raw_token.strip(" .'\"-")
        lower = token.lower()
        if not token:
            continue
        if lower in NAME_TRAILING_STOP_WORDS or lower in NON_PERSON_TOKENS or lower in MONTH_WORDS:
            break
        if not NAME_TOKEN_RE.match(token):
            break
        cleaned_tokens.append(token)

    if not cleaned_tokens:
        return None
    return " ".join(cleaned_tokens)


def is_valid_llm_person_candidate(
    candidate: str,
    sentence_text: str,
    local_start: int,
    local_end: int,
    confidence: float,
) -> bool:
    cleaned = clean_name_candidate(candidate)
    if not cleaned or cleaned.lower() != candidate.strip(" .'\"-").lower():
        return False
    if len(cleaned) < 2 or len(cleaned) > 80:
        return False
    if any(character.isdigit() for character in cleaned) or "@" in cleaned:
        return False

    tokens = cleaned.split()
    lowered_tokens = {token.lower() for token in tokens}
    if lowered_tokens & (NON_PERSON_TOKENS | MONTH_WORDS):
        return False

    local_context = context_window(sentence_text, local_start, local_end)
    has_name_signal = has_context_term(local_context, NAME_CONTEXT_TERMS)
    has_human_action = has_context_term(local_context, HUMAN_ACTION_TERMS)
    has_known_name = any(token.lower() in COMMON_PERSON_NAMES for token in tokens)
    has_case_signal = any(token[:1].isupper() for token in tokens)

    return confidence >= 0.72 and (has_name_signal or has_human_action or has_known_name or has_case_signal)


class ValidatingPatternRecognizer(PatternRecognizer):
    """Pattern recognizer with optional entity-specific validation."""

    def analyze(self, text, entities, nlp_artifacts=None):
        results = super().analyze(text, entities, nlp_artifacts)
        return [result for result in results if self.is_valid(text[result.start : result.end])]

    def is_valid(self, candidate: str) -> bool:
        return True


class AadhaarRecognizer(ValidatingPatternRecognizer):
    def __init__(self) -> None:
        super().__init__(
            supported_entity="IN_AADHAAR",
            patterns=[
                Pattern(
                    name="aadhaar_number",
                    regex=r"\b\d{4}[- ]?\d{4}[- ]?\d{4}\b",
                    score=0.78,
                )
            ],
            context=["aadhaar", "uidai", "uid", "identity"],
        )

    def is_valid(self, candidate: str) -> bool:
        digits_only = normalize_digits(candidate)
        return len(digits_only) == 12 and digits_only[0] not in {"0", "1"}


class PANRecognizer(ValidatingPatternRecognizer):
    def __init__(self) -> None:
        super().__init__(
            supported_entity="IN_PAN",
            patterns=[
                Pattern(
                    name="pan_number",
                    regex=r"\b[A-Z]{5}[0-9]{4}[A-Z]\b",
                    score=0.82,
                )
            ],
            context=["pan", "income tax", "tax id"],
        )


class GSTINRecognizer(ValidatingPatternRecognizer):
    def __init__(self) -> None:
        super().__init__(
            supported_entity="IN_GSTIN",
            patterns=[
                Pattern(
                    name="gstin",
                    regex=r"\b[0-3][0-9][A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b",
                    score=0.82,
                )
            ],
            context=["gst", "gstin", "tax"],
        )


class VoterRecognizer(ValidatingPatternRecognizer):
    def __init__(self) -> None:
        super().__init__(
            supported_entity="IN_VOTER",
            patterns=[
                Pattern(
                    name="voter_id",
                    regex=r"\b[A-Z]{3}[0-9]{7}\b",
                    score=0.76,
                )
            ],
            context=["voter", "epic", "election"],
        )


class PassportRecognizer(ValidatingPatternRecognizer):
    def __init__(self) -> None:
        super().__init__(
            supported_entity="IN_PASSPORT",
            patterns=[
                Pattern(
                    name="indian_passport",
                    regex=r"\b[A-Z][0-9]{7}\b",
                    score=0.72,
                )
            ],
            context=["passport", "travel document"],
        )


class DeterministicDateRecognizer(ValidatingPatternRecognizer):
    def __init__(self) -> None:
        super().__init__(
            supported_entity="DATE_TIME",
            patterns=[
                Pattern(
                    name="day_month_year",
                    regex=rf"(?i)\b\d{{1,2}}(?:st|nd|rd|th)?[-\s]+(?:{MONTH_REGEX})[,]?[-\s]+(?:19|20)\d{{2}}\b",
                    score=0.86,
                ),
                Pattern(
                    name="month_day_year",
                    regex=rf"(?i)\b(?:{MONTH_REGEX})[-\s]+\d{{1,2}}(?:st|nd|rd|th)?[,]?[-\s]+(?:19|20)\d{{2}}\b",
                    score=0.86,
                ),
                Pattern(
                    name="iso_date",
                    regex=r"\b(?:19|20)\d{2}[-/]\d{1,2}[-/]\d{1,2}\b",
                    score=0.84,
                ),
                Pattern(
                    name="slash_or_dash_date",
                    regex=r"\b\d{1,2}[-/]\d{1,2}[-/](?:\d{2}|\d{4})\b",
                    score=0.82,
                ),
            ],
            context=["date", "dob", "birth", "expiry", "issued", "visited", "submitted"],
        )

    def is_valid(self, candidate: str) -> bool:
        return is_valid_date_candidate(candidate)


class VehicleRegistrationRecognizer(ValidatingPatternRecognizer):
    def __init__(self) -> None:
        super().__init__(
            supported_entity="IN_VEHICLE_REGISTRATION",
            patterns=[
                Pattern(
                    name="indian_vehicle_registration",
                    regex=(
                        r"\b[A-Z]{2}[- ]?[0-9]{1,2}[- ]?"
                        r"[A-Z]{1,3}[- ]?[0-9]{1,4}\b"
                    ),
                    score=0.72,
                )
            ],
            context=["vehicle", "license plate", "registration", "number plate"],
        )


class MultiWordNameRecognizer(EntityRecognizer):
    FULL_NAME_PATTERN = re.compile(r"\b[A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,}){1,3}\b")
    LABELLED_NAME_PATTERN = re.compile(
        rf"\b(?:name|subject|student|participant|employee|visitor|patient|customer|applicant|candidate|"
        rf"guardian|father|mother|teacher|doctor|person)(?:\s+name)?"
        rf"\s*[:=-]\s*(?P<name>{NAME_TOKEN_REGEX}(?:\s+{NAME_TOKEN_REGEX}){{0,3}})",
        flags=re.IGNORECASE,
    )
    CONTEXTUAL_SINGLE_NAME_PATTERN = re.compile(
        rf"\b(?:student|participant|employee|visitor|patient|customer|applicant|candidate|subject|person)"
        rf"\s+(?:named\s+|called\s+)?(?P<name>{NAME_TOKEN_REGEX})\b",
        flags=re.IGNORECASE,
    )
    RELATIONAL_NAME_PATTERN = re.compile(
        rf"\b(?:called|named|met|spoke to|assigned to|contacted by)\s+(?P<name>{NAME_TOKEN_REGEX})\b",
        flags=re.IGNORECASE,
    )
    COMMON_CONTEXTUAL_NAME_PATTERN = re.compile(
        rf"\b(?:{'|'.join(sorted(COMMON_PERSON_NAMES))})\b",
        flags=re.IGNORECASE,
    )

    def __init__(self) -> None:
        super().__init__(
            supported_entities=["PERSON"],
            name="case_sensitive_name_recognizer",
            context=["name", "subject", "student", "participant", "employee", "visitor"],
        )

    def load(self) -> None:
        return None

    def analyze(self, text, entities, nlp_artifacts=None):
        if "PERSON" not in entities:
            return []

        results = []
        for match in self.FULL_NAME_PATTERN.finditer(text):
            results.append(
                RecognizerResult(
                    entity_type="PERSON",
                    start=match.start(),
                    end=match.end(),
                    score=0.58,
                )
            )

        for match in self.LABELLED_NAME_PATTERN.finditer(text):
            cleaned = clean_name_candidate(match.group("name"))
            if not cleaned:
                continue
            start = match.start("name")
            results.append(
                RecognizerResult(
                    entity_type="PERSON",
                    start=start,
                    end=start + len(cleaned),
                    score=0.72,
                )
            )

        for pattern in (self.CONTEXTUAL_SINGLE_NAME_PATTERN, self.RELATIONAL_NAME_PATTERN):
            for match in pattern.finditer(text):
                cleaned = clean_name_candidate(match.group("name"))
                if not cleaned:
                    continue
                start = match.start("name")
                results.append(
                    RecognizerResult(
                        entity_type="PERSON",
                        start=start,
                        end=start + len(cleaned),
                        score=0.68,
                    )
                )

        for match in self.COMMON_CONTEXTUAL_NAME_PATTERN.finditer(text):
            if has_context_term(context_window(text, match.start(), match.end()), NAME_CONTEXT_TERMS | HUMAN_ACTION_TERMS):
                results.append(
                    RecognizerResult(
                        entity_type="PERSON",
                        start=match.start(),
                        end=match.end(),
                        score=0.62,
                    )
                )

        return results


class UPIRecognizer(ValidatingPatternRecognizer):
    UPI_HANDLES = (
        "upi",
        "ybl",
        "ibl",
        "axl",
        "okaxis",
        "okhdfcbank",
        "okicici",
        "oksbi",
        "paytm",
        "apl",
        "upiid",
        "kotak",
        "icici",
        "sbi",
        "hdfcbank",
    )

    def __init__(self) -> None:
        handles = "|".join(re.escape(handle) for handle in self.UPI_HANDLES)
        super().__init__(
            supported_entity="UPI_ID",
            patterns=[
                Pattern(
                    name="upi_id",
                    regex=rf"\b[a-zA-Z0-9._-]{{2,64}}@(?:{handles})\b",
                    score=0.83,
                )
            ],
            context=["upi", "vpa", "payment", "pay"],
        )


class IFSCRecognizer(ValidatingPatternRecognizer):
    def __init__(self) -> None:
        super().__init__(
            supported_entity="IFSC_CODE",
            patterns=[
                Pattern(
                    name="ifsc_code",
                    regex=r"\b[A-Z]{4}0[A-Z0-9]{6}\b",
                    score=0.78,
                )
            ],
            context=["ifsc", "bank", "branch"],
        )


class BankAccountRecognizer(ValidatingPatternRecognizer):
    def __init__(self) -> None:
        super().__init__(
            supported_entity="BANK_ACCOUNT",
            patterns=[
                Pattern(
                    name="bank_account_number",
                    regex=r"\b(?:account|acct|a/c|bank)[^\d]{0,12}\d{9,18}\b",
                    score=0.72,
                )
            ],
            context=["account", "acct", "bank", "a/c"],
        )


class CampusIdRecognizer(ValidatingPatternRecognizer):
    def __init__(self) -> None:
        super().__init__(
            supported_entity="CAMPUS_ID",
            patterns=[
                Pattern(
                    name="vit_roll_or_employee_id",
                    regex=r"\b(?:[0-9]{2}[A-Z]{3}[0-9]{4}|EMP[- ]?[0-9]{4,8}|STU[- ]?[0-9]{4,8})\b",
                    score=0.7,
                )
            ],
            context=["roll", "student", "employee", "campus", "vit", "id"],
        )


class QRTokenRecognizer(ValidatingPatternRecognizer):
    def __init__(self) -> None:
        super().__init__(
            supported_entity="QR_TOKEN",
            patterns=[
                Pattern(
                    name="qr_or_consent_token",
                    regex=r"\b(?:QR|CONSENT|CID|PID)[-_][A-Z0-9]{6,32}\b",
                    score=0.74,
                )
            ],
            context=["qr", "consent", "token", "project"],
        )


class SecretRecognizer(ValidatingPatternRecognizer):
    def __init__(self) -> None:
        super().__init__(
            supported_entity="SECRET",
            patterns=[
                Pattern(
                    name="api_key_assignment",
                    regex=(
                        r"(?i)\b(?:api[_-]?key|secret|token|password|passwd|pwd)"
                        r"\s*[:=]\s*['\"]?[A-Za-z0-9_\-./+=]{8,}['\"]?"
                    ),
                    score=0.86,
                ),
                Pattern(
                    name="aws_access_key",
                    regex=r"\bAKIA[0-9A-Z]{16}\b",
                    score=0.9,
                ),
            ],
            context=["secret", "password", "token", "api key"],
        )


CUSTOM_RECOGNIZERS = [
    MultiWordNameRecognizer,
    AadhaarRecognizer,
    PANRecognizer,
    GSTINRecognizer,
    VoterRecognizer,
    PassportRecognizer,
    DeterministicDateRecognizer,
    VehicleRegistrationRecognizer,
    UPIRecognizer,
    IFSCRecognizer,
    BankAccountRecognizer,
    CampusIdRecognizer,
    QRTokenRecognizer,
    SecretRecognizer,
]

TEXT_ENTITIES = [
    "PERSON",
    "PHONE_NUMBER",
    "EMAIL_ADDRESS",
    "IN_AADHAAR",
    "IN_PAN",
    "IN_VOTER",
    "IN_PASSPORT",
    "IN_GSTIN",
    "IN_VEHICLE_REGISTRATION",
    "UPI_ID",
    "IFSC_CODE",
    "BANK_ACCOUNT",
    "CAMPUS_ID",
    "QR_TOKEN",
    "SECRET",
    "CREDIT_CARD",
    "CRYPTO",
    "DATE_TIME",
    "LOCATION",
    "IP_ADDRESS",
    "MAC_ADDRESS",
    "URL",
    "IBAN_CODE",
    "NRP",
    "MEDICAL_LICENSE",
]

HIGH_RISK_ENTITIES = [
    "PERSON",
    "PHONE_NUMBER",
    "EMAIL_ADDRESS",
    "IN_AADHAAR",
    "IN_PAN",
    "IN_VOTER",
    "IN_PASSPORT",
    "IN_GSTIN",
    "IN_VEHICLE_REGISTRATION",
    "UPI_ID",
    "IFSC_CODE",
    "BANK_ACCOUNT",
    "CAMPUS_ID",
    "QR_TOKEN",
    "SECRET",
    "CREDIT_CARD",
    "CRYPTO",
    "IP_ADDRESS",
    "MAC_ADDRESS",
    "IBAN_CODE",
]

ENTITY_PRIORITY = {
    "SECRET": 120,
    "EMAIL_ADDRESS": 110,
    "UPI_ID": 108,
    "PHONE_NUMBER": 106,
    "IN_AADHAAR": 104,
    "IN_PAN": 103,
    "IN_GSTIN": 102,
    "IN_VOTER": 101,
    "IN_PASSPORT": 100,
    "IN_VEHICLE_REGISTRATION": 99,
    "CREDIT_CARD": 98,
    "IBAN_CODE": 97,
    "BANK_ACCOUNT": 96,
    "IFSC_CODE": 95,
    "CAMPUS_ID": 94,
    "QR_TOKEN": 93,
    "CRYPTO": 92,
    "IP_ADDRESS": 91,
    "MAC_ADDRESS": 90,
    "PERSON": 70,
    "LOCATION": 45,
    "DATE_TIME": 40,
    "URL": 35,
}


def custom_operator(entity_type: str, callback):
    return OperatorConfig("custom", {"lambda": lambda value: callback(value, entity_type)})


def strict_operators() -> dict[str, OperatorConfig]:
    operators = {
        "PHONE_NUMBER": OperatorConfig("replace", {"new_value": "<REDACTED_PHONE>"}),
        "EMAIL_ADDRESS": OperatorConfig("replace", {"new_value": "<REDACTED_EMAIL>"}),
        "PERSON": OperatorConfig("replace", {"new_value": "<REDACTED_NAME>"}),
        "DATE_TIME": OperatorConfig("replace", {"new_value": "<REDACTED_DATE_TIME>"}),
        "LOCATION": OperatorConfig("replace", {"new_value": "<REDACTED_LOCATION>"}),
        "DEFAULT": custom_operator("IDENTIFIER", redact_to_token),
    }

    for entity_type in TEXT_ENTITIES:
        operators.setdefault(entity_type, OperatorConfig("replace", {"new_value": typed_token(entity_type)}))

    return operators


def tolerant_operators() -> dict[str, OperatorConfig]:
    operators = strict_operators()
    operators.update(
        {
            "PHONE_NUMBER": custom_operator("PHONE_NUMBER", mask_phone),
            "EMAIL_ADDRESS": custom_operator("EMAIL_ADDRESS", mask_email),
            "DATE_TIME": custom_operator("DATE_TIME", bucket_date),
            "LOCATION": custom_operator("LOCATION", compact_location),
            "PERSON": custom_operator("PERSON", pseudonymize_to_hash),
        }
    )

    for entity_type in (
        "IN_AADHAAR",
        "IN_PAN",
        "IN_VOTER",
        "IN_PASSPORT",
        "IN_GSTIN",
        "IN_VEHICLE_REGISTRATION",
        "UPI_ID",
        "IFSC_CODE",
        "BANK_ACCOUNT",
        "CAMPUS_ID",
        "QR_TOKEN",
        "CREDIT_CARD",
        "IBAN_CODE",
    ):
        operators[entity_type] = custom_operator(entity_type, mask_government_id)

    for entity_type in ("SECRET", "CRYPTO", "IP_ADDRESS", "MAC_ADDRESS"):
        operators[entity_type] = custom_operator(entity_type, pseudonymize_to_hash)

    operators["DEFAULT"] = custom_operator("IDENTIFIER", pseudonymize_to_hash)
    return operators


TEXT_POLICIES = {
    "PII_STRICT": TextPolicy(
        name="PII_STRICT",
        description="Irreversible typed tokens for storage when consent is missing or revoked.",
        operators=strict_operators(),
        post_scan_entities=HIGH_RISK_ENTITIES,
    ),
    "PII_TOLERANT": TextPolicy(
        name="PII_TOLERANT",
        description="Utility-preserving masking and deterministic pseudonyms for review/training drafts.",
        operators=tolerant_operators(),
        post_scan_entities=["SECRET", "CREDIT_CARD", "IN_AADHAAR", "IN_PAN", "EMAIL_ADDRESS"],
    ),
}


DEFAULT_PROJECT_POLICY = {
    "PERSON": {"operator": "replace", "new_value": "<SUBJECT_NAME_REMOVED>"},
    "EMAIL_ADDRESS": {"operator": "replace", "new_value": "<EMAIL_REMOVED>"},
    "PHONE_NUMBER": {"operator": "mask", "chars_to_mask": 6, "from_end": True, "masking_char": "*"},
    "IN_AADHAAR": {"operator": "replace", "new_value": "<AADHAAR_REMOVED>"},
    "IN_PAN": {"operator": "replace", "new_value": "<PAN_REMOVED>"},
    "SECRET": {"operator": "replace", "new_value": "<SECRET_REMOVED>"},
    "DEFAULT": {"operator": "replace", "new_value": "<IDENTIFIER_REMOVED>"},
}


def operators_from_project_policy(policy_text: str) -> dict[str, OperatorConfig]:
    policy_json: dict[str, Any] = json.loads(policy_text)
    operators = {}

    for entity_type, config in policy_json.items():
        operator_name = config.get("operator")
        if not operator_name:
            raise ValueError(f"{entity_type} is missing an operator")

        params = {key: value for key, value in config.items() if key != "operator"}
        operators[entity_type] = OperatorConfig(operator_name, params)

    return operators


def load_policy(policy_name: str, project_policy_text: str) -> TextPolicy:
    if policy_name != "PROJECT_DEFINED":
        return TEXT_POLICIES[policy_name]

    return TextPolicy(
        name="PROJECT_DEFINED",
        description="Custom JSON policy supplied for this project.",
        operators=operators_from_project_policy(project_policy_text),
        post_scan_entities=HIGH_RISK_ENTITIES,
    )


@st.cache_resource
def load_engines():
    configuration = {
        "nlp_engine_name": "spacy",
        "models": [{"lang_code": "en", "model_name": "en_core_web_sm"}],
    }
    provider = NlpEngineProvider(nlp_configuration=configuration)
    nlp_engine = provider.create_engine()

    analyzer = AnalyzerEngine(nlp_engine=nlp_engine, supported_languages=["en"])
    for recognizer_factory in CUSTOM_RECOGNIZERS:
        analyzer.registry.add_recognizer(recognizer_factory())

    anonymizer = AnonymizerEngine()
    return analyzer, anonymizer


def dedupe_results(results: list[RecognizerResult]) -> list[RecognizerResult]:
    best_by_span = {}

    for result in results:
        span = (result.start, result.end, result.entity_type)
        previous = best_by_span.get(span)
        if previous is None or result.score > previous.score:
            best_by_span[span] = result

    return sorted(best_by_span.values(), key=lambda item: (item.start, -(item.end - item.start), item.entity_type))


def analyze_sentence(
    analyzer: AnalyzerEngine,
    full_text: str,
    sentence: SentenceSpan,
    score_threshold: float,
) -> list[RecognizerResult]:
    sentence_results = analyzer.analyze(
        text=sentence.text,
        language="en",
        entities=TEXT_ENTITIES,
        score_threshold=score_threshold,
    )

    global_results = []
    for result in sentence_results:
        global_result = clone_result_with_offset(result, sentence.start)
        if should_keep_result(full_text, sentence, global_result):
            global_results.append(global_result)

    return global_results


def resolve_overlaps(results: list[RecognizerResult]) -> list[RecognizerResult]:
    selected = []
    ranked_results = sorted(
        results,
        key=lambda item: (
            ENTITY_PRIORITY.get(item.entity_type, 50),
            item.score,
            item.end - item.start,
        ),
        reverse=True,
    )

    for candidate in ranked_results:
        overlaps_selected = any(
            candidate.start < existing.end and existing.start < candidate.end
            for existing in selected
        )
        if not overlaps_selected:
            selected.append(candidate)

    return sorted(selected, key=lambda item: (item.start, item.end))


def openai_client_from_environment():
    if OpenAI is None:
        raise RuntimeError("The openai package is not installed. Run pip install -r requirements.txt.")

    api_key = os.getenv("OPENAI_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY is not set.")

    return OpenAI(api_key=api_key)


def openai_api_key_configured() -> bool:
    return bool(os.getenv("OPENAI_API_KEY", "").strip())


def llm_person_schema() -> dict[str, Any]:
    return {
        "type": "object",
        "properties": {
            "person_names": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "text": {"type": "string"},
                        "confidence": {"type": "number", "minimum": 0, "maximum": 1},
                        "evidence": {"type": "string"},
                    },
                    "required": ["text", "confidence", "evidence"],
                    "additionalProperties": False,
                },
            }
        },
        "required": ["person_names"],
        "additionalProperties": False,
    }


def extract_openai_text(response: Any) -> str:
    output_text = getattr(response, "output_text", None)
    if output_text:
        return output_text

    choices = getattr(response, "choices", None)
    if choices:
        message = getattr(choices[0], "message", None)
        content = getattr(message, "content", None)
        if content:
            return content

    output = getattr(response, "output", None)
    if output:
        content_items = getattr(output[0], "content", [])
        if content_items:
            text = getattr(content_items[0], "text", None)
            if text:
                return text

    return ""


def call_llm_for_person_names(client: Any, sentence: SentenceSpan, existing_results: list[RecognizerResult], model: str) -> dict[str, Any]:
    existing_in_sentence = [
        {
            "entity_type": result.entity_type,
            "text": sentence.text[result.start - sentence.start : result.end - sentence.start],
            "start": result.start - sentence.start,
            "end": result.end - sentence.start,
        }
        for result in existing_results
        if sentence.start <= result.start < result.end <= sentence.end
    ]
    payload = {
        "sentence": sentence.text,
        "already_detected": existing_in_sentence,
        "examples": [
            {
                "sentence": "I am Manan, I have an exam tomorrow.",
                "redact": [],
                "reason": "A name in a general sentence is not enough for name redaction.",
            },
            {
                "sentence": "My name is Manan, and my phone number is 9876543210.",
                "redact": ["Manan"],
                "reason": "The same sentence links the name to a phone number.",
            },
            {
                "sentence": "Manan will go to the park after lunch.",
                "redact": [],
                "reason": "Ordinary plans or movement are not personal-information disclosure.",
            },
            {
                "sentence": "Aadhaar 2345 6789 1234 belongs to Gurpreet Singh Chawla.",
                "redact": ["Gurpreet Singh Chawla"],
                "reason": "The same sentence links the full name to an Aadhaar number.",
            },
            {
                "sentence": "mohana's email is mohana@example.com.",
                "redact": ["mohana"],
                "reason": "Lowercase single names can be returned when tied to personal contact information.",
            },
            {
                "sentence": "Manan scored 9876543210 points in practice.",
                "redact": [],
                "reason": "The number is presented as a score, not as disclosed contact information.",
            },
            {
                "sentence": "Ananya Iyer lives at 14 MG Road.",
                "redact": ["Ananya Iyer"],
                "reason": "The same sentence links the name to an address.",
            },
            {
                "sentence": "Please send the report to Arjun Mehta before 5 PM.",
                "redact": [],
                "reason": "A work request with a name is not enough without personal information.",
            },
            {
                "sentence": "Subramanian's UPI ID is subbu@upi.",
                "redact": ["Subramanian"],
                "reason": "The same sentence links a single name to a financial identifier.",
            },
            {
                "sentence": "The company named Tata Motors is unrelated to Neha Kapoor's claim.",
                "redact": [],
                "reason": "Do not return organizations or names from general claim context without disclosed personal info.",
            },
        ],
        "task": (
            "Return exact person names that should be redacted but are missing from already_detected. "
            "Return a name only when this same sentence discloses or links that person to personal information, "
            "such as a phone number, Aadhaar/PAN/passport/voter ID, email, bank or UPI details, campus ID, "
            "DOB, address, credential, token, or secret. Do not return names from general sentences, even when "
            "they clearly refer to a human. Treat score, marks, points, runs, ratings, ranks, or totals as "
            "ordinary numbers rather than phone evidence unless contact wording is present. Do not include "
            "organizations, locations, dates, usernames, IDs, emails, roles, or ordinary words."
        ),
    }
    messages = [
        {
            "role": "system",
            "content": (
                "You are a conservative PII redaction adjudicator. "
                "Return JSON only. Prefer an empty list when uncertain."
            ),
        },
        {"role": "user", "content": json.dumps(payload, ensure_ascii=True)},
    ]

    if hasattr(client, "responses"):
        try:
            response = client.responses.create(
                model=model,
                input=messages,
                temperature=0,
                max_output_tokens=500,
                store=False,
                text={
                    "format": {
                        "type": "json_schema",
                        "name": "prism_person_names",
                        "schema": llm_person_schema(),
                        "strict": True,
                    }
                },
            )
            return json.loads(extract_openai_text(response))
        except Exception as responses_exc:
            if not hasattr(client, "chat"):
                raise RuntimeError(f"Responses API fallback failed: {responses_exc}") from responses_exc

            try:
                response = client.chat.completions.create(
                    model=model,
                    messages=messages,
                    temperature=0,
                    max_tokens=500,
                    store=False,
                    response_format={"type": "json_object"},
                )
                return json.loads(extract_openai_text(response))
            except Exception as chat_exc:
                raise RuntimeError(
                    f"Responses API fallback failed: {responses_exc}; chat JSON fallback failed: {chat_exc}"
                ) from chat_exc

    response = client.chat.completions.create(
        model=model,
        messages=messages,
        temperature=0,
        max_tokens=500,
        store=False,
        response_format={"type": "json_object"},
    )
    return json.loads(extract_openai_text(response))


def find_person_occurrences(sentence_text: str, candidate: str) -> list[tuple[int, int]]:
    pattern = re.compile(rf"(?<![A-Za-z0-9_]){re.escape(candidate)}(?![A-Za-z0-9_])", flags=re.IGNORECASE)
    return [(match.start(), match.end()) for match in pattern.finditer(sentence_text)]


def overlaps_any(start: int, end: int, results: list[RecognizerResult]) -> bool:
    return any(start < result.end and result.start < end for result in results)


def llm_person_results(
    text: str,
    sentences: list[SentenceSpan],
    existing_results: list[RecognizerResult],
    llm_config: LlmRedactionConfig,
) -> list[RecognizerResult]:
    client = openai_client_from_environment()
    added_results = []

    for sentence in sentences[: llm_config.max_sentences]:
        if len(sentence.text) > MAX_LLM_SENTENCE_CHARS:
            continue
        if not sentence_has_name_linking_personal_info(text, sentence, existing_results + added_results):
            continue

        payload = call_llm_for_person_names(client, sentence, existing_results + added_results, llm_config.model)
        for item in payload.get("person_names", []):
            candidate = str(item.get("text", "")).strip()
            try:
                confidence = float(item.get("confidence", 0))
            except (TypeError, ValueError):
                confidence = 0

            for local_start, local_end in find_person_occurrences(sentence.text, candidate):
                global_start = sentence.start + local_start
                global_end = sentence.start + local_end
                if overlaps_any(global_start, global_end, existing_results + added_results):
                    continue
                if not is_valid_llm_person_candidate(candidate, sentence.text, local_start, local_end, confidence):
                    continue

                added_results.append(
                    RecognizerResult(
                        entity_type="PERSON",
                        start=global_start,
                        end=global_end,
                        score=max(0.72, min(confidence, 0.92)),
                    )
                )

    return added_results


def analyze_text_with_metadata(
    analyzer: AnalyzerEngine,
    text: str,
    score_threshold: float,
    llm_config: LlmRedactionConfig | None = None,
) -> AnalysisOutcome:
    sentences = sentence_spans(text)
    results = []

    for sentence in sentences:
        results.extend(analyze_sentence(analyzer, text, sentence, score_threshold))

    resolved_results = resolve_overlaps(dedupe_results(results))
    resolved_results = filter_person_results_by_sensitive_context(text, sentences, resolved_results)
    llm_enabled = bool(llm_config and llm_config.enabled)
    llm_added_count = 0
    llm_error = None

    if llm_enabled and llm_config:
        try:
            llm_results = llm_person_results(text, sentences, resolved_results, llm_config)
            llm_added_count = len(llm_results)
            resolved_results = resolve_overlaps(dedupe_results(resolved_results + llm_results))
            resolved_results = filter_person_results_by_sensitive_context(text, sentences, resolved_results)
        except Exception as exc:
            llm_error = str(exc)

    return AnalysisOutcome(
        results=resolved_results,
        sentence_count=len(sentences),
        llm_enabled=llm_enabled,
        llm_added_count=llm_added_count,
        llm_error=llm_error,
    )


def analyze_text(
    analyzer: AnalyzerEngine,
    text: str,
    score_threshold: float,
    llm_config: LlmRedactionConfig | None = None,
) -> list[RecognizerResult]:
    return analyze_text_with_metadata(analyzer, text, score_threshold, llm_config).results


def redact_text(anonymizer: AnonymizerEngine, text: str, results: list[RecognizerResult], policy: TextPolicy):
    return anonymizer.anonymize(
        text=text,
        analyzer_results=results,
        operators=policy.operators,
    )


def detection_rows(text: str, results: list[RecognizerResult], policy: TextPolicy) -> list[dict[str, Any]]:
    rows = []
    for result in results:
        original_value = text[result.start : result.end]
        operator_config = policy.operators.get(result.entity_type) or policy.operators.get("DEFAULT")
        rows.append(
            {
                "entity_type": result.entity_type,
                "confidence": round(result.score, 3),
                "start": result.start,
                "end": result.end,
                "preview": mask_keep_last(original_value, keep=2),
                "operator": operator_config.operator_name if operator_config else "pending",
            }
        )

    return rows


def build_manifest(
    input_text: str,
    output_text: str,
    policy: TextPolicy,
    results: list[RecognizerResult],
    verification_results: list[RecognizerResult],
    analysis_outcome: AnalysisOutcome | None = None,
) -> dict[str, Any]:
    manifest = {
        "engine": "PRISM_TEXT_REDACTION",
        "policy": policy.name,
        "input_sha256": hashlib.sha256(input_text.encode("utf-8")).hexdigest(),
        "output_sha256": hashlib.sha256(output_text.encode("utf-8")).hexdigest(),
        "detected_entity_count": len(results),
        "post_scan_passed": len(verification_results) == 0,
        "residual_high_risk_findings": len(verification_results),
        "actions": detection_rows(input_text, results, policy),
    }

    if analysis_outcome:
        manifest.update(
            {
                "sentence_count": analysis_outcome.sentence_count,
                "llm_fallback_enabled": analysis_outcome.llm_enabled,
                "llm_person_findings_added": analysis_outcome.llm_added_count,
                "llm_fallback_error": analysis_outcome.llm_error,
            }
        )

    return manifest


def main() -> None:
    st.set_page_config(page_title="PRISM - Live DPDP Redaction Engine", layout="wide")
    st.title("PRISM: Real-Time Text PII Anonymizer")
    st.subheader("Policy-driven text redaction for DPDP-style consent enforcement")

    analyzer, anonymizer = load_engines()

    default_text = (
        "Gracy Mehndiratta walked into VIT testing center on 12 Jan 2026. "
        "Her phone number is +91-9876543210 and email is gracy@vit.edu. "
        "Aadhaar: 2345 6789 1234, PAN: ABCDE1234F, Voter ID: ABC1234567, "
        "UPI: gracy@ybl, vehicle TN 09 AB 1234, roll 22BCE1234. "
        "Consent token CONSENT-9F8A7B6C and api_key='sk_test_1234567890abcdef' were present in the log."
    )

    left, right = st.columns([1, 1])

    with left:
        st.markdown("### 1. Text Ingestion")
        user_input = st.text_area(
            "Enter raw subject log, transcript, form text, OCR text, or support note:",
            value=default_text,
            height=260,
        )

        policy_name = st.selectbox(
            "Redaction policy",
            options=["PII_STRICT", "PII_TOLERANT", "PROJECT_DEFINED"],
            index=0,
            help="Strict is safest for storage. Tolerant keeps limited utility. Project-defined uses the JSON below.",
        )

        score_threshold = st.slider(
            "Detection confidence threshold",
            min_value=0.0,
            max_value=1.0,
            value=0.35,
            step=0.05,
        )

        llm_available = openai_api_key_configured()
        use_llm_fallback = st.checkbox(
            "Use guarded LLM fallback for difficult names",
            value=False,
            disabled=not llm_available,
            help=(
                "Uses OPENAI_API_KEY from the environment or local .env file and only adds validated PERSON spans."
                if llm_available
                else "OPENAI_API_KEY is not configured. Set it in the environment or local .env file to enable."
            ),
        )
        llm_model = st.text_input(
            "LLM fallback model",
            value=DEFAULT_LLM_MODEL,
            disabled=not (llm_available and use_llm_fallback),
        )
        if not llm_available:
            st.caption("LLM fallback unavailable: OPENAI_API_KEY is not configured.")

        project_policy_text = st.text_area(
            "Project-defined policy JSON",
            value=json.dumps(DEFAULT_PROJECT_POLICY, indent=2),
            height=250,
            disabled=policy_name != "PROJECT_DEFINED",
        )

    with right:
        st.markdown("### 2. Enforced Secure Storage Format")

        if user_input:
            try:
                selected_policy = load_policy(policy_name, project_policy_text)
                llm_config = LlmRedactionConfig(
                    enabled=llm_available and use_llm_fallback,
                    model=llm_model.strip() or DEFAULT_LLM_MODEL,
                )
                analysis_outcome = analyze_text_with_metadata(
                    analyzer,
                    user_input,
                    score_threshold,
                    llm_config=llm_config,
                )
                results = analysis_outcome.results
                anonymized = redact_text(anonymizer, user_input, results, selected_policy)
                verification_results = analyze_text(analyzer, anonymized.text, score_threshold)
                verification_results = [
                    result
                    for result in verification_results
                    if result.entity_type in selected_policy.post_scan_entities
                ]
                manifest = build_manifest(
                    input_text=user_input,
                    output_text=anonymized.text,
                    policy=selected_policy,
                    results=results,
                    verification_results=verification_results,
                    analysis_outcome=analysis_outcome,
                )

                st.caption(selected_policy.description)
                st.text_area(
                    "What gets saved in the database:",
                    value=anonymized.text,
                    height=260,
                    disabled=True,
                )

                if manifest["post_scan_passed"]:
                    st.success("Post-redaction verification passed: no high-risk residual text PII detected.")
                else:
                    st.error(
                        "Post-redaction verification failed: high-risk residual text PII was detected. "
                        "Block storage and route to manual review."
                    )

                if analysis_outcome.llm_error:
                    st.warning(f"Guarded LLM fallback skipped: {analysis_outcome.llm_error}")

                st.markdown("### 3. Detection Manifest")
                detection_table = pd.DataFrame(manifest["actions"])
                st.dataframe(detection_table, width="stretch", hide_index=True)

                st.markdown("### 4. Audit Payload")
                st.json({key: value for key, value in manifest.items() if key != "actions"})

            except Exception as exc:
                st.error(f"Redaction policy error: {exc}")

    st.info(
        "DPDP Compliance Notice: raw text is analyzed at ingestion, transformed by policy, "
        "then scanned again before storage. Treat any failed post-scan as a storage block."
    )


if __name__ == "__main__":
    main()
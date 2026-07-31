"""Indian PII pattern recognizers for Presidio, ported from
`ai-core/text-services/app.py` (the Streamlit text-redaction demo).

Only the pattern-based recognizers relevant to what shows up on photographed
documents/ID cards are kept here (Aadhaar, PAN, GSTIN, voter ID, passport,
driving licence, vehicle registration/license plate, PIN code, UPI, IFSC, bank
account, campus/roll ID, QR/consent tokens, secrets, and names sitting behind a
printed label). Presidio's built-ins cover phone, email, cards, IBAN, crypto,
IP, URL and NER names/places/dates, so those aren't reimplemented.

This module is standalone — it does not import the Streamlit app, it just
copies the regex/validation logic so this service has no dependency on it.
"""

import re

from presidio_analyzer import Pattern, PatternRecognizer

# OCR routinely glues a printed label to its value — "PANABCDE1234F",
# "IFSCHDFC0001234", "VehicleTN09AB1234" — because the gap between them is
# narrower than the space the recognizer was trained to emit. A leading `\b`
# then refuses to match, and a PAN card sails through unblurred. The structured
# identifiers below therefore anchor on "not preceded by a digit" instead: a
# letter immediately before is assumed to be label text, while a digit before
# means the candidate is a slice out of a longer number and is not an ID at all.
# The trailing anchor stays strict for the same reason in reverse.
NOT_AFTER_DIGIT = r"(?<!\d)"
NOT_BEFORE_ALNUM = r"(?![A-Z0-9])"

# Indian state/UT codes used on vehicle registration plates.
INDIAN_VEHICLE_STATE_CODES = {
    "AN", "AP", "AR", "AS", "BR", "CG", "CH", "DD", "DL", "DN", "GA", "GJ",
    "HP", "HR", "JH", "JK", "KA", "KL", "LA", "LD", "MH", "ML", "MN", "MP",
    "MZ", "NL", "OD", "OR", "PB", "PY", "RJ", "SK", "TN", "TR", "TS", "UK",
    "UP", "WB",
}

MONTH_WORDS = {
    "jan", "january", "feb", "february", "mar", "march", "apr", "april",
    "may", "jun", "june", "jul", "july", "aug", "august", "sep", "sept",
    "september", "oct", "october", "nov", "november", "dec", "december",
}

VEHICLE_CANONICAL_RE = re.compile(
    r"^(?P<state>[A-Z]{2})(?P<district>[0-9]{1,2})(?P<series>[A-Z]{1,3})(?P<number>[0-9]{1,4})$"
)


def normalize_digits(value: str) -> str:
    return re.sub(r"\D", "", value)


def parse_vehicle_registration(value: str):
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
                # Digit-boundary (not \b word-boundary) so a label OCR'd flush
                # against the number — "Aadhaar234567890123", no space — still
                # matches; the 12-digit run is what identifies it.
                Pattern(
                    name="aadhaar_number",
                    regex=r"(?<!\d)\d{4}[-\s]?\d{4}[-\s]?\d{4}(?!\d)",
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
            patterns=[Pattern(name="pan_number", regex=NOT_AFTER_DIGIT + r"[A-Z]{5}[0-9]{4}[A-Z]" + NOT_BEFORE_ALNUM, score=0.82)],
            context=["pan", "income tax", "tax id"],
        )


class GSTINRecognizer(ValidatingPatternRecognizer):
    def __init__(self) -> None:
        super().__init__(
            supported_entity="IN_GSTIN",
            patterns=[
                Pattern(
                    name="gstin",
                    regex=NOT_AFTER_DIGIT + r"[0-3][0-9][A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]" + NOT_BEFORE_ALNUM,
                    score=0.82,
                )
            ],
            context=["gst", "gstin", "tax"],
        )


class VoterRecognizer(ValidatingPatternRecognizer):
    def __init__(self) -> None:
        super().__init__(
            supported_entity="IN_VOTER",
            patterns=[Pattern(name="voter_id", regex=NOT_AFTER_DIGIT + r"[A-Z]{3}[0-9]{7}" + NOT_BEFORE_ALNUM, score=0.76)],
            context=["voter", "epic", "election"],
        )


class PassportRecognizer(ValidatingPatternRecognizer):
    def __init__(self) -> None:
        super().__init__(
            supported_entity="IN_PASSPORT",
            patterns=[Pattern(name="indian_passport", regex=NOT_AFTER_DIGIT + r"[A-Z][0-9]{7}" + NOT_BEFORE_ALNUM, score=0.72)],
            context=["passport", "travel document"],
        )


class VehicleRegistrationRecognizer(ValidatingPatternRecognizer):
    """Indian license plate recognizer, e.g. TN 09 AB 1234 / KA05MN1234."""

    def __init__(self) -> None:
        super().__init__(
            supported_entity="IN_VEHICLE_REGISTRATION",
            patterns=[
                Pattern(
                    name="indian_vehicle_registration",
                    regex=NOT_AFTER_DIGIT + r"[A-Z]{2}[- ]?[0-9]{1,2}[- ]?[A-Z]{1,3}[- ]?[0-9]{1,4}" + NOT_BEFORE_ALNUM,
                    score=0.72,
                )
            ],
            context=["vehicle", "license plate", "registration", "number plate"],
        )

    def is_valid(self, candidate: str) -> bool:
        return is_valid_vehicle_registration(candidate)


class DrivingLicenceRecognizer(ValidatingPatternRecognizer):
    """Indian driving licence, e.g. TN14 20110001234 / KA0520159876543."""

    def __init__(self) -> None:
        super().__init__(
            supported_entity="IN_DRIVING_LICENCE",
            patterns=[
                Pattern(
                    name="indian_driving_licence",
                    regex=NOT_AFTER_DIGIT + r"[A-Z]{2}[- ]?[0-9]{2}[- ]?(?:19|20)[0-9]{2}[- ]?[0-9]{7}" + NOT_BEFORE_ALNUM,
                    score=0.8,
                )
            ],
            context=["driving", "licence", "license", "dl no", "transport"],
        )

    def is_valid(self, candidate: str) -> bool:
        compact = re.sub(r"[-\s]", "", candidate).upper()
        return compact[:2] in INDIAN_VEHICLE_STATE_CODES


class PinCodeRecognizer(ValidatingPatternRecognizer):
    """Indian postal PIN code — part of a residential address, so personal data
    once it sits next to a name on a photographed document.

    The base score is deliberately below SCORE_THRESHOLD: a bare six-digit run
    is far too common on a photo (prices, serials, times) to blur on sight.
    Presidio's context enhancer lifts it over the line only when an address word
    sits nearby, which is the only case where it is actually an address.
    """

    def __init__(self) -> None:
        super().__init__(
            supported_entity="IN_PIN_CODE",
            patterns=[Pattern(name="in_pin_code", regex=r"(?<!\d)[1-9][0-9]{5}(?!\d)", score=0.2)],
            context=["pin", "pincode", "postal", "address", "district", "state"],
        )


class LabelledNameRecognizer(ValidatingPatternRecognizer):
    """A name sitting behind a printed label on a document.

    spaCy's en_core_web_sm reliably tags a name inside a sentence and just as
    reliably misses a bare one on an ID card — "Name: Ramesh Kumar" comes back
    with no PERSON at all, because there is no sentence around it to condition
    on. The label is the context the NER model is missing, so it is matched
    deterministically instead. Reports PERSON so it merges with the NER hits
    rather than inventing a parallel entity type.
    """

    LABELS = r"name|holder|applicant|student|employee|s/o|d/o|w/o|c/o|father|mother|guardian"

    def __init__(self) -> None:
        super().__init__(
            supported_entity="PERSON",
            patterns=[
                Pattern(
                    name="labelled_name",
                    regex=(
                        rf"(?i)\b(?:{LabelledNameRecognizer.LABELS})\b\s*[:.\-]?\s*"
                        r"[A-Z][A-Za-z.]+(?:\s+[A-Z][A-Za-z.]+){0,3}"
                    ),
                    score=0.6,
                )
            ],
            context=["name", "card", "identity", "holder"],
        )


class UPIRecognizer(ValidatingPatternRecognizer):
    UPI_HANDLES = (
        "upi", "ybl", "ibl", "axl", "okaxis", "okhdfcbank", "okicici", "oksbi",
        "paytm", "apl", "upiid", "kotak", "icici", "sbi", "hdfcbank",
    )

    def __init__(self) -> None:
        handles = "|".join(re.escape(handle) for handle in self.UPI_HANDLES)
        super().__init__(
            supported_entity="UPI_ID",
            patterns=[
                Pattern(name="upi_id", regex=rf"[a-zA-Z0-9._-]{{2,64}}@(?:{handles})(?![a-zA-Z0-9])", score=0.83)
            ],
            context=["upi", "vpa", "payment", "pay"],
        )


class IFSCRecognizer(ValidatingPatternRecognizer):
    def __init__(self) -> None:
        super().__init__(
            supported_entity="IFSC_CODE",
            patterns=[Pattern(name="ifsc_code", regex=NOT_AFTER_DIGIT + r"[A-Z]{4}0[A-Z0-9]{6}" + NOT_BEFORE_ALNUM, score=0.78)],
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
    """Generic ID-card style identifiers (roll numbers, employee/student IDs)."""

    def __init__(self) -> None:
        super().__init__(
            supported_entity="CAMPUS_ID",
            patterns=[
                Pattern(
                    name="vit_roll_or_employee_id",
                    regex=NOT_AFTER_DIGIT + r"(?:[0-9]{2}[A-Z]{3}[0-9]{4}|EMP[- ]?[0-9]{4,8}|STU[- ]?[0-9]{4,8})" + NOT_BEFORE_ALNUM,
                    score=0.7,
                )
            ],
            context=["roll", "student", "employee", "campus", "id"],
        )


class QRTokenRecognizer(ValidatingPatternRecognizer):
    def __init__(self) -> None:
        super().__init__(
            supported_entity="QR_TOKEN",
            patterns=[
                Pattern(
                    name="qr_or_consent_token",
                    regex=r"(?<![A-Z0-9])(?:QR|CONSENT|CID|PID)[-_][A-Z0-9]{6,32}" + NOT_BEFORE_ALNUM,
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
                Pattern(name="aws_access_key", regex=r"\bAKIA[0-9A-Z]{16}\b", score=0.9),
            ],
            context=["secret", "password", "token", "api key"],
        )


# Custom recognizer factories to register on the Presidio AnalyzerEngine.
CUSTOM_RECOGNIZERS = [
    AadhaarRecognizer,
    PANRecognizer,
    GSTINRecognizer,
    VoterRecognizer,
    PassportRecognizer,
    VehicleRegistrationRecognizer,
    DrivingLicenceRecognizer,
    PinCodeRecognizer,
    LabelledNameRecognizer,
    UPIRecognizer,
    IFSCRecognizer,
    BankAccountRecognizer,
    CampusIdRecognizer,
    QRTokenRecognizer,
    SecretRecognizer,
]

# Entities this service asks the analyzer to look for. This is an allow-list,
# not a filter: AnalyzerEngine loads its built-in recognizers regardless, but
# only entities named here are ever requested, so a built-in absent from this
# list is loaded and never consulted. PHONE_NUMBER and EMAIL_ADDRESS are those
# built-ins; everything else is one of the custom recognizers above.
IDENTIFIER_ENTITIES = [
    "PHONE_NUMBER",
    # An email address printed on a photographed document is personal data
    # under the DPDP Act as much as an Aadhaar is. It was missing here while
    # Presidio's EmailRecognizer sat loaded and idle, so an email on a form or
    # an ID card was OCR'd, ignored, and published unblurred.
    "EMAIL_ADDRESS",
    # Financial and network built-ins. A debit card or a bank QR taped to a
    # counter is squarely in frame at the kind of event this pipeline covers.
    "CREDIT_CARD",
    "IBAN_CODE",
    "CRYPTO",
    "IP_ADDRESS",
    "URL",
    "IN_AADHAAR",
    "IN_PAN",
    "IN_GSTIN",
    "IN_VOTER",
    "IN_PASSPORT",
    "IN_VEHICLE_REGISTRATION",
    "IN_DRIVING_LICENCE",
    "IN_PIN_CODE",
    "UPI_ID",
    "IFSC_CODE",
    "BANK_ACCOUNT",
    "CAMPUS_ID",
    "QR_TOKEN",
    "SECRET",
]

# NER-based built-ins: the name, address and date of birth printed on an ID
# card or a registration form. These are the noisiest entities in the set —
# spaCy will call a sponsor banner a PERSON — but the service's whole premise
# is that an extra blurred line costs a photo and a missed one costs a breach.
# Set PII_DISABLE_NER=1 to drop them if a deployment decides otherwise.
NER_ENTITIES = [
    "PERSON",
    "LOCATION",
    "DATE_TIME",
    "NRP",
]

# Entities this service asks the analyzer to look for. This is an allow-list,
# not a filter: AnalyzerEngine loads its built-in recognizers regardless, but
# only entities named here are ever requested, so a built-in absent from this
# list is loaded and never consulted.
PII_ENTITIES = IDENTIFIER_ENTITIES + NER_ENTITIES

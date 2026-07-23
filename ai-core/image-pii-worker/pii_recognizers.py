"""Indian PII pattern recognizers for Presidio, ported from
`ai-core/text-services/app.py` (the Streamlit text-redaction demo).

Only the pattern-based recognizers relevant to what shows up on photographed
documents/ID cards are kept here (Aadhaar, PAN, GSTIN, voter ID, passport,
vehicle registration/license plate, UPI, IFSC, bank account, campus/roll ID,
QR/consent tokens, secrets). Presidio's built-in PhoneRecognizer covers phone
numbers, so it isn't reimplemented.

This module is standalone — it does not import the Streamlit app, it just
copies the regex/validation logic so this service has no dependency on it.
"""

import re

from presidio_analyzer import Pattern, PatternRecognizer

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
            patterns=[Pattern(name="pan_number", regex=r"\b[A-Z]{5}[0-9]{4}[A-Z]\b", score=0.82)],
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
            patterns=[Pattern(name="voter_id", regex=r"\b[A-Z]{3}[0-9]{7}\b", score=0.76)],
            context=["voter", "epic", "election"],
        )


class PassportRecognizer(ValidatingPatternRecognizer):
    def __init__(self) -> None:
        super().__init__(
            supported_entity="IN_PASSPORT",
            patterns=[Pattern(name="indian_passport", regex=r"\b[A-Z][0-9]{7}\b", score=0.72)],
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
                    regex=r"\b[A-Z]{2}[- ]?[0-9]{1,2}[- ]?[A-Z]{1,3}[- ]?[0-9]{1,4}\b",
                    score=0.72,
                )
            ],
            context=["vehicle", "license plate", "registration", "number plate"],
        )

    def is_valid(self, candidate: str) -> bool:
        return is_valid_vehicle_registration(candidate)


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
                Pattern(name="upi_id", regex=rf"\b[a-zA-Z0-9._-]{{2,64}}@(?:{handles})\b", score=0.83)
            ],
            context=["upi", "vpa", "payment", "pay"],
        )


class IFSCRecognizer(ValidatingPatternRecognizer):
    def __init__(self) -> None:
        super().__init__(
            supported_entity="IFSC_CODE",
            patterns=[Pattern(name="ifsc_code", regex=r"\b[A-Z]{4}0[A-Z0-9]{6}\b", score=0.78)],
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
                    regex=r"\b(?:[0-9]{2}[A-Z]{3}[0-9]{4}|EMP[- ]?[0-9]{4,8}|STU[- ]?[0-9]{4,8})\b",
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
    UPIRecognizer,
    IFSCRecognizer,
    BankAccountRecognizer,
    CampusIdRecognizer,
    QRTokenRecognizer,
    SecretRecognizer,
]

# Entities this service asks the analyzer to look for. PHONE_NUMBER is
# Presidio's built-in recognizer (backed by the `phonenumbers` library),
# everything else is one of the custom recognizers above.
PII_ENTITIES = [
    "PHONE_NUMBER",
    "IN_AADHAAR",
    "IN_PAN",
    "IN_GSTIN",
    "IN_VOTER",
    "IN_PASSPORT",
    "IN_VEHICLE_REGISTRATION",
    "UPI_ID",
    "IFSC_CODE",
    "BANK_ACCOUNT",
    "CAMPUS_ID",
    "QR_TOKEN",
    "SECRET",
]

from presidio_analyzer import Pattern, PatternRecognizer, AnalyzerEngine

street_address_pattern = Pattern(
    name="street_address_pattern",
    regex=r"\b\d{1,6}[A-Za-z]?\s+(?:[A-Z][a-zA-Z]*\s?){1,4}\s(?:Street|St|Avenue|Ave|Boulevard|Blvd|Road|Rd|Lane|Ln|Drive|Dr|Court|Ct|Terrace|Place|Pl|Way|Circle|Cir)\b\.?",
    score=0.85,
)

street_address_recognizer = PatternRecognizer(
    supported_entity="STREET_ADDRESS",
    patterns=[street_address_pattern],
    context=["living", "address", "located", "reside", "mailing"],
)
def get_pii_analyzer():
    
    _pii_analyzer = AnalyzerEngine()
    _pii_analyzer.registry.add_recognizer(street_address_recognizer)
    return _pii_analyzer